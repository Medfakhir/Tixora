'use strict';
/**
 * Booking logic: availability, order creation (reserve tickets + PayPal order),
 * payment capture, ticket delivery, webhooks, and the background "reconcile"
 * job that expires abandoned checkouts and recovers from crashes.
 *
 * Order statuses
 *   pending          checkout started, tickets reserved, waiting for PayPal
 *   payment_pending  PayPal accepted the payment but holds it (review, eCheck, currency)
 *   paid             captured, tickets being issued (normally lasts milliseconds)
 *   fulfilled        tickets issued and (being) emailed
 *   needs_attention  paid, but tickets could not be issued (no stock / error / amount mismatch)
 *   expired          checkout not completed in time, tickets back in stock
 *   cancelled        buyer closed PayPal or admin cancelled, tickets back in stock
 *   failed           PayPal declined, tickets back in stock
 *   refunded         fully refunded (via PayPal webhook or marked by admin)
 *   reversed         chargeback / reversal reported by PayPal
 */
const fs = require('fs');
const path = require('path');
const { HttpError, rateKey } = require('./http');
const {
  ORDER_ID_RE,
  token,
  safeEqual,
  toCents,
  fromCents,
  formatMoney,
  cleanText,
  isEmail,
  nowIso,
  log,
  logError,
} = require('./util');
const dates = require('./dates');
const { Stock, SoldOutError } = require('./stock');
const { PayPalError, extractCapture } = require('./paypal');
const emails = require('./emails');
const templates = require('./templates');
const mailsettings = require('./mailsettings');
const { Mailer, smtpVerify } = require('./mailer');

const HOLDING = ['pending', 'payment_pending', 'paid', 'needs_attention'];
const MAX_HELD_TICKETS_PER_ADDRESS = 40;
const UNCONFIRMED =
  "We couldn't confirm your payment with PayPal yet. Please don't pay again: if the payment went through, your tickets will be emailed to you automatically within a few minutes.";
const PAID_GROUP = ['paid', 'fulfilled', 'needs_attention', 'refunded', 'reversed'];
const ABANDONED = ['expired', 'cancelled', 'failed'];

function addLog(order, msg) {
  order.log = order.log || [];
  order.log.push({ at: nowIso(), msg });
  if (order.log.length > 200) order.log.splice(0, order.log.length - 200);
}

function displayName(name) {
  return String(name || '').replace(/["<>\\]/g, '').trim();
}

class Booking {
  constructor({ config, store, payments, mailer }) {
    this.config = config;
    this.store = store;
    this.payments = payments;
    // Before PayPal keys are replaced or removed, link older open orders to the keys they used.
    payments.beforeKeysChange = () => this.backfillClientIds();
    this.mailer = mailer;
    this.mailConfig = null;
    this.refreshMailer();
    this.tz = config.timezone;
    this.adminUrl = config.baseUrl + '/admin';
    this._reconciling = false;
    this.lastReconcileAt = 0;
  }

  /**
   * Rebuild the mailer from data/mail.json (dashboard settings) falling back to
   * the .env SMTP_* values. Called at start-up and after the Email page is saved.
   */
  refreshMailer() {
    const resolved = mailsettings.resolveMail(this.config, this.store.getMail());
    this.mailConfig = resolved;
    this.mailer = new Mailer({
      smtp: resolved.smtp,
      from: resolved.from,
      replyTo: resolved.replyTo,
      outboxDir: this.store.outboxDir,
    });
    return resolved;
  }

  // ---- activity log ------------------------------------------------------------------
  async logActivity({ type = 'info', msg, orderId = null, actor = '', ip = null } = {}) {
    if (!msg) return;
    try {
      await this.store.appendActivity({
        at: nowIso(),
        type: cleanText(type, 40) || 'info',
        msg: cleanText(msg, 500),
        orderId: orderId || null,
        actor: cleanText(actor, 60),
        ip: ip || null,
      });
    } catch (e) {
      logError('Could not write the activity log:', e.message);
    }
  }

  async listActivity(query = {}) {
    const all = await this.store.readActivity();
    const q = cleanText(query.q || '', 120).toLowerCase();
    const type = cleanText(query.type || '', 40);
    let items = all.slice().reverse();
    const types = [...new Set(all.map((e) => e.type).filter(Boolean))].sort();
    if (type && type !== 'all') items = items.filter((e) => e.type === type);
    if (q) {
      items = items.filter((e) => `${e.msg} ${e.orderId || ''} ${e.type} ${e.actor || ''}`.toLowerCase().includes(q));
    }
    const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || 50));
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const total = items.length;
    return {
      events: items.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      types,
    };
  }

  // ---- email settings (dashboard) ----------------------------------------------------
  mailStatus() {
    const c = this.config;
    const resolved = this.mailConfig || this.refreshMailer();
    const cur = resolved.stored;
    return {
      configured: this.mailer.configured,
      source: resolved.source,
      smtp: {
        host: cur.smtp.host,
        port: cur.smtp.port,
        secure: cur.smtp.secure,
        user: cur.smtp.user,
        hasPassword: !!cur.smtp.passEnc,
      },
      from: resolved.from,
      replyTo: resolved.replyTo,
      env: {
        host: c.smtp.host,
        port: c.smtp.port,
        secure: c.smtp.secure,
        user: c.smtp.user,
        from: c.mail.from,
        replyTo: c.mail.replyTo,
        hasPassword: !!c.smtp.pass,
      },
      outboxDir: this.store.outboxDir,
      adminEmail: c.adminEmail,
      templates: cur.templates,
      defaults: templates.DEFAULT_TEMPLATES,
      placeholders: templates.PLACEHOLDERS,
      labels: templates.LABELS,
    };
  }

  async saveMail(input) {
    const next = mailsettings.validateMail(input, this.store.getMail(), this.config.sessionSecret);
    await this.store.saveMail(next);
    this.refreshMailer();
    await this.logActivity({ type: 'settings', actor: 'admin', msg: next.smtp.host ? `Email settings saved (${next.smtp.host}:${next.smtp.port})` : 'Email settings cleared, falling back to the server configuration' });
    return this.mailStatus();
  }

  async saveTemplates(input) {
    const current = this.store.getMail();
    const next = templates.validateTemplates(input, current.templates);
    await this.store.saveMail({ ...current, templates: next });
    this.refreshMailer();
    await this.logActivity({ type: 'settings', actor: 'admin', msg: 'Email templates saved' });
    return this.mailStatus();
  }

  async testSmtpConnection(override = null) {
    const opts = mailsettings.smtpOptions(this.store.getMail(), this.config, override);
    if (!opts.host) throw new HttpError(400, 'Enter the mail server address first.');
    try {
      const info = await smtpVerify(opts);
      await this.logActivity({ type: 'settings', actor: 'admin', msg: `Mail server checked: ${opts.host}:${opts.port}${opts.secure ? ' (SSL)' : ' (STARTTLS)'}` });
      return { ok: true, ...info };
    } catch (e) {
      await this.logActivity({ type: 'error', actor: 'admin', msg: `Mail server check failed for ${opts.host}:${opts.port}: ${e.message}` });
      throw new HttpError(502, 'Could not connect: ' + e.message);
    }
  }

  settings() {
    return this.store.getSettings();
  }

  // ---- payment modes -------------------------------------------------------------------
  // The active mode (chosen on the dashboard's PayPal page) is used for NEW checkouts and the
  // booking page. An existing order always uses the PayPal account and ticket folder of the
  // mode it was created in (order.paypal.mode), so a test order never gets real tickets.
  get mode() {
    return this.payments.activeMode;
  }

  get paypal() {
    return this.payments.client(this.mode);
  }

  get stock() {
    return this.payments.stock(this.mode);
  }

  modeOf(order) {
    return (order && order.paypal && order.paypal.mode) || 'live';
  }

  paypalFor(order) {
    return this.payments.clientForOrder(this.modeOf(order), order && order.paypal && order.paypal.clientId);
  }

  stockFor(order) {
    return this.payments.stock(this.modeOf(order));
  }

  now() {
    return dates.inTz(this.tz);
  }

  activeTypes(s = this.settings()) {
    return s.ticketTypes.filter((t) => t.active);
  }

  downloadUrl(order) {
    return `${this.config.baseUrl}/tickets/${order.id}/${order.downloadToken}`;
  }

  ticketFileName(order, index) {
    const t = order.tickets[index];
    const ext = (/\.[A-Za-z0-9]+$/.exec(t.path) || ['.pdf'])[0].toLowerCase();
    const item = order.items.find((i) => i.typeId === t.typeId);
    const typeName = String((item && item.name) || t.typeId).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Ticket';
    return `Ticket-${index + 1}-${typeName}-${order.id}${ext}`;
  }

  // ---- dates & availability ----------------------------------------------------------
  dayInfo(date, s = this.settings(), now = this.now()) {
    if (date < now.date) return { open: false, reason: 'past' };
    if (date > dates.addDays(now.date, s.bookingWindowDays)) return { open: false, reason: 'beyond' };
    if (s.closedDates.includes(date) || s.closedWeekdays.includes(dates.weekday(date))) return { open: false, reason: 'closed' };
    if (date === now.date && s.sameDayCutoff && now.time >= s.sameDayCutoff) return { open: false, reason: 'cutoff' };
    return { open: true };
  }

  publicConfig() {
    const s = this.settings();
    const now = this.now();
    return {
      siteName: s.siteName,
      tagline: s.tagline,
      currency: s.currency,
      ticketTypes: this.activeTypes(s).map((t) => ({ id: t.id, name: t.name, description: t.description, price: t.price })),
      maxTicketsPerOrder: s.maxTicketsPerOrder,
      openingHours: s.openingHours,
      address: s.address,
      notice: s.notice,
      termsUrl: s.termsUrl,
      supportEmail: s.supportEmail,
      holdMinutes: s.holdMinutes,
      today: now.date,
      lastDate: dates.addDays(now.date, s.bookingWindowDays),
      payments: (() => {
        const pp = this.paypal;
        return {
          mode: pp.mode,
          enabled: pp.enabled,
          clientId: pp.mode === 'mock' ? '' : pp.clientId,
          message: pp.enabled ? '' : 'Online payment is temporarily unavailable. Please try again a little later.',
        };
      })(),
    };
  }

  async availability(month) {
    if (!dates.isValidMonth(month)) throw new HttpError(400, 'Invalid month.');
    const s = this.settings();
    const now = this.now();
    const types = this.activeTypes(s);
    const counts = await this.stock.counts(types.map((t) => t.id));
    const days = {};
    for (const d of dates.monthDates(month)) {
      const info = this.dayInfo(d, s, now);
      if (!info.open) {
        days[d] = { status: info.reason };
        continue;
      }
      const remaining = {};
      let total = 0;
      for (const t of types) {
        const n = Stock.available(counts, t.id, d);
        remaining[t.id] = Math.min(n, s.maxTicketsPerOrder);
        total += n;
      }
      days[d] = total > 0 ? { status: 'open', remaining, few: s.fewLeftThreshold > 0 && total <= s.fewLeftThreshold } : { status: 'soldout' };
    }
    return { month, today: now.date, days };
  }

  // ---- checkout ------------------------------------------------------------------------
  async createOrder(input, meta = {}) {
    if (!this.paypal.enabled) throw new HttpError(503, 'Online payment is temporarily unavailable. Please try again a little later.');
    // A booking page opened before the payment mode was switched would load the wrong PayPal.
    if (input && input.mode && String(input.mode) !== this.mode) {
      throw new HttpError(409, 'The payment settings were just updated. Please reload the page and try again.', { code: 'MODE_CHANGED' });
    }
    const s = this.settings();
    const date = String((input && input.date) || '');
    if (!dates.isValidYmd(date)) throw new HttpError(400, 'Please choose your visit date.');
    const info = this.dayInfo(date, s);
    if (!info.open) {
      throw new HttpError(
        409,
        info.reason === 'cutoff'
          ? 'Online sales for today have closed. Please choose another date.'
          : 'Sorry, this date is not available. Please choose another date.',
        { code: 'DATE_UNAVAILABLE' }
      );
    }

    const types = new Map(this.activeTypes(s).map((t) => [t.id, t]));
    const qty = new Map();
    for (const it of Array.isArray(input.items) ? input.items : []) {
      const t = types.get(String(it && it.typeId));
      const q = Number(it && it.qty);
      if (!t) throw new HttpError(400, 'One of the ticket types is no longer available. Please reload the page.');
      if (!Number.isInteger(q) || q < 0 || q > 100) throw new HttpError(400, 'Invalid ticket quantity.');
      if (q) qty.set(t.id, (qty.get(t.id) || 0) + q);
    }
    const totalQty = [...qty.values()].reduce((a, b) => a + b, 0);
    if (totalQty < 1) throw new HttpError(400, 'Please select at least one ticket.');
    if (totalQty > s.maxTicketsPerOrder) throw new HttpError(400, `You can book up to ${s.maxTicketsPerOrder} tickets per order.`);

    const items = [...qty].map(([id, q]) => {
      const t = types.get(id);
      const unitCents = toCents(t.price);
      return { typeId: id, name: t.name, qty: q, unitCents, unitPrice: fromCents(unitCents), lineTotal: fromCents(unitCents * q) };
    });
    const totalCents = items.reduce((a, i) => a + i.unitCents * i.qty, 0);

    const c = (input && input.customer) || {};
    const name = cleanText(c.name, 100);
    const email = cleanText(c.email, 254).toLowerCase();
    const phone = cleanText(c.phone, 40);
    if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
    if (!isEmail(email)) throw new HttpError(400, 'Please enter a valid email address — your tickets will be sent there.');
    if (s.termsUrl && !input.acceptTerms) throw new HttpError(400, 'Please accept the terms and conditions.');

    // Stop one visitor from holding lots of tickets with checkouts they never finish. Counting,
    // reserving and saving happen under one lock, so parallel requests can't slip past the limit.
    // The per-address limit counts tickets (not checkouts) so a few buyers sharing hotel Wi-Fi
    // or a mobile network are not turned away.
    const ipKey = rateKey(meta.ip || '');
    let mode;
    let client;
    const order = await this.store.withLock('checkout-holds', async () => {
      // The mode and PayPal app are fixed here, under the same lock the dashboard takes to switch modes.
      mode = this.mode;
      if (input && input.mode && String(input.mode) !== mode) {
        throw new HttpError(409, 'The payment settings were just updated. Please reload the page and try again.', { code: 'MODE_CHANGED' });
      }
      client = this.payments.client(mode);
      if (!client.enabled) {
        throw new HttpError(503, 'Online payment is temporarily unavailable. Please try again a little later.');
      }
      const stock = this.payments.stock(mode);
      const now = Date.now();
      const open = (await this.store.listOrders()).filter(
        (o) => o.status === 'pending' && (Date.parse((o.reservation && o.reservation.expiresAt) || 0) || 0) > now
      );
      const sameEmail = open.filter((o) => o.customer && o.customer.email === email).length;
      const ipTickets = ipKey === 'unknown' ? 0 : open.filter((o) => o.meta && o.meta.ipKey === ipKey).reduce((a, o) => a + (o.totalQty || 0), 0);
      if (sameEmail >= 3 || ipTickets + totalQty > MAX_HELD_TICKETS_PER_ADDRESS) {
        throw new HttpError(429, 'You already have a checkout in progress. Finish or close it first, or try again in a few minutes.', { code: 'TOO_MANY_HOLDS' });
      }

      const id = await this.store.newOrderId();
      let reserved;
      try {
        reserved = await stock.reserve(
          id,
          date,
          items.map((i) => ({ typeId: i.typeId, qty: i.qty }))
        );
      } catch (e) {
        if (e instanceof SoldOutError) {
          const t = types.get(e.details.typeId);
          throw new HttpError(
            409,
            e.details.available
              ? `Only ${e.details.available} ${t ? t.name : ''} ticket${e.details.available === 1 ? '' : 's'} left for this date.`
              : `${t ? t.name : 'These'} tickets are sold out for this date.`,
            { code: 'SOLD_OUT' }
          );
        }
        throw e;
      }

      const o = {
        id,
        status: 'pending',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        visitDate: date,
        items: items.map(({ unitCents, ...rest }) => rest),
        totalQty,
        total: fromCents(totalCents),
        currency: s.currency,
        customer: { name, email, phone },
        reservation: { files: reserved, expiresAt: new Date(Date.now() + s.holdMinutes * 60000).toISOString() },
        paypal: { mode, clientId: client.clientId || '', orderId: null },
        tickets: [],
        downloadToken: null,
        email: { status: 'none', attempts: 0 },
        meta: { ip: meta.ip || '', ipKey, userAgent: String(meta.userAgent || '').slice(0, 200) },
        log: [],
      };
      addLog(o, `Checkout started: ${totalQty} ticket(s) reserved for ${s.holdMinutes} min`);
      try {
        await this.store.insertOrder(o);
      } catch (e) {
        await stock.release(id, reserved).catch(() => {});
        throw e;
      }
      return o;
    });
    const id = order.id;

    try {
      const pp = await client.createOrder({
        localId: id,
        currency: s.currency,
        totalCents,
        items,
        description: `${s.siteName} – ${dates.formatLong(date)}`,
        brandName: s.siteName,
      });
      await this.store.updateOrder(id, (o) => {
        o.paypal.orderId = pp.id;
        o.paypal.status = pp.status;
        addLog(o, `PayPal order ${pp.id} created`);
      });
      return { orderId: id, paypalOrderId: pp.id, total: order.total, currency: order.currency, expiresAt: order.reservation.expiresAt };
    } catch (e) {
      logError('PayPal create order failed', id, e.message, e.debugId || '');
      await this.store.updateOrder(id, async (o) => {
        o.status = 'failed';
        addLog(o, `Could not create the PayPal order: ${e.message}${e.debugId ? ` (debug id ${e.debugId})` : ''}`);
        await this._releaseLocked(o);
      });
      throw new HttpError(502, 'We could not start the PayPal payment. Please try again in a moment.');
    }
  }

  async capture(orderId, paypalOrderId) {
    if (!ORDER_ID_RE.test(String(orderId))) throw new HttpError(404, 'Order not found.');
    let fulfilledNow = false;
    const result = await this.store.withLock('order-' + orderId, async () => {
      const order = await this.store.getOrder(orderId);
      if (!order) throw new HttpError(404, 'Order not found.');
      if (!order.paypal || !order.paypal.orderId || order.paypal.orderId !== String(paypalOrderId)) {
        throw new HttpError(400, 'This payment does not belong to this order.');
      }
      const before = order.status;
      const r = await this._captureLocked(order, 'checkout');
      await this.store.saveOrder(order);
      fulfilledNow = before !== 'fulfilled' && order.status === 'fulfilled';
      return this._customerResult(order, r);
    });
    if (fulfilledNow) this._afterFulfilled(orderId);
    return result;
  }

  _customerResult(order, r = {}) {
    const base = { orderId: order.id, email: order.customer.email };
    if (order.status === 'fulfilled') {
      return {
        ...base,
        status: 'completed',
        visitDate: order.visitDate,
        items: order.items.map((i) => ({ name: i.name, qty: i.qty })),
        total: order.total,
        currency: order.currency,
        tickets: order.tickets.length,
        downloadUrl: this.downloadUrl(order),
      };
    }
    if (order.status === 'payment_pending') {
      return {
        ...base,
        status: 'pending',
        message: 'PayPal is still processing your payment. Your tickets will be emailed to you as soon as PayPal confirms it.',
      };
    }
    if (order.status === 'needs_attention' && order.paidAt) {
      return {
        ...base,
        status: 'attention',
        message: 'Your payment was received, but we could not issue your tickets automatically. Our team has been alerted and will email your tickets shortly.',
      };
    }
    if (r.unknown) return { ...base, status: 'unconfirmed', message: r.error || UNCONFIRMED };
    if (r.restart) return { ...base, status: 'restart', message: 'PayPal declined that payment method. Please try another card or account.' };
    return { ...base, status: 'error', message: r.error || 'The payment could not be completed. You have not been charged.' };
  }

  _extendHold(order, minutes) {
    const until = Date.now() + minutes * 60000;
    const cur = Date.parse((order.reservation && order.reservation.expiresAt) || 0) || 0;
    order.reservation = order.reservation || { files: [] };
    if (until > cur) order.reservation.expiresAt = new Date(until).toISOString();
  }

  /** Capture the PayPal payment for an order (caller holds the order lock). */
  async _captureLocked(order, source) {
    const paypal = this.paypalFor(order);
    const stock = this.stockFor(order);
    if (['fulfilled', 'payment_pending', 'needs_attention', 'refunded', 'reversed'].includes(order.status)) return {};
    if (order.status === 'paid') {
      await this._fulfillLocked(order);
      return {};
    }
    if (order.status === 'failed') return { error: 'This payment was declined. Please start a new booking.' };
    if (!paypal.enabled) {
      // The PayPal keys this order needs are not connected. If a capture was already sent,
      // money may have moved: never say "not charged" then.
      addLog(order, `Payment could not be confirmed: ${paypal.disabledReason}`);
      if (order.paypal.captureAttemptedAt) {
        this._extendHold(order, 30);
        return { unknown: true, error: UNCONFIRMED };
      }
      return { error: 'Online payment is not available right now. You have not been charged. Please try again later.' };
    }
    if (order.status === 'expired' || order.status === 'cancelled') {
      if (!this.dayInfo(order.visitDate).open) {
        addLog(order, 'Payment approved after the hold expired, but the visit date is no longer on sale. Not charged.');
        return { error: 'Sorry, your visit date is no longer available for online booking. You have not been charged. Please choose another date.' };
      }
      try {
        order.reservation = order.reservation || {};
        order.reservation.files = await stock.reserve(
          order.id,
          order.visitDate,
          order.items.map((i) => ({ typeId: i.typeId, qty: i.qty }))
        );
        order.reservation.expiresAt = new Date(Date.now() + this.settings().holdMinutes * 60000).toISOString();
        order.status = 'pending';
        addLog(order, `Tickets reserved again before charging (${source})`);
      } catch (e) {
        if (e instanceof SoldOutError) {
          addLog(order, 'Payment approved after the hold expired, but the tickets are gone. Not charged.');
          return { error: 'Sorry — these tickets sold out while you were paying. You have not been charged.' };
        }
        throw e;
      }
    }
    if (order.status !== 'pending') return { error: 'This order can no longer be paid.' };

    // A previous capture attempt may still be in flight or may have succeeded without us
    // hearing back. Ask PayPal first instead of sending another capture.
    if (order.paypal.captureAttemptedAt) {
      let current = null;
      try {
        current = await paypal.getOrder(order.paypal.orderId);
      } catch (e) {
        if (e.status === 404) {
          // A payment was sent, yet PayPal has no record of the order: don't guess.
          order.paypal.notFoundAt = order.paypal.notFoundAt || nowIso();
          addLog(order, 'PayPal has no record of this order although a payment was sent. Kept for the owner to check.');
        }
        this._extendHold(order, 30);
        return { unknown: true, error: UNCONFIRMED };
      }
      if (current && extractCapture(current)) return this._applyPayPalOrder(order, current, source);
      if (current && current.status === 'COMPLETED') {
        // Completed but the capture isn't in the reply: never tell the buyer "not charged".
        this._extendHold(order, 30);
        return { unknown: true, error: UNCONFIRMED };
      }
      if (current && current.status !== 'APPROVED') {
        return { notApproved: true, error: 'The payment was not approved in PayPal. You have not been charged.' };
      }
    }

    // Remember (on disk, before calling PayPal) that money may move from here on, so this
    // order is never expired or deleted without PayPal confirming that nothing was captured.
    const seq = order.paypal.captureSeq || 1;
    order.paypal.captureAttemptedAt = order.paypal.captureAttemptedAt || nowIso();
    await this.store.saveOrder(order);
    let data;
    try {
      data = await paypal.captureOrder(order.paypal.orderId, `capture-${order.id}-${seq}`);
    } catch (e) {
      if (!(e instanceof PayPalError)) throw e;
      const dbg = e.debugId ? ` (debug id ${e.debugId})` : '';
      // Only a 400/401/403/404/422 answer means PayPal definitely did not capture. After such an
      // answer a retry (e.g. another card after a decline) needs a new PayPal-Request-Id,
      // because PayPal replays the stored answer for a repeated id. After a timeout, 409 or 5xx
      // the outcome is unknown and the SAME id must be reused, as PayPal asks.
      const definite = [400, 401, 403, 404, 422].includes(e.status);
      if (definite && e.issue !== 'ORDER_ALREADY_CAPTURED') order.paypal.captureSeq = seq + 1;
      if (e.issue === 'ORDER_ALREADY_CAPTURED') {
        try {
          data = await paypal.getOrder(order.paypal.orderId);
        } catch {
          addLog(order, `PayPal says the payment was already captured; details will be fetched automatically${dbg}`);
          this._extendHold(order, 30);
          return { unknown: true, error: UNCONFIRMED };
        }
      } else if (e.issue === 'INSTRUMENT_DECLINED') {
        addLog(order, `PayPal declined the buyer's payment method; buyer may try another${dbg}`);
        return { restart: true };
      } else if (e.issue === 'ORDER_NOT_APPROVED' || e.issue === 'PAYER_ACTION_REQUIRED') {
        return { notApproved: true, error: 'The payment was not approved in PayPal. You have not been charged.' };
      } else if (definite) {
        order.paypal.captureAttempts = (order.paypal.captureAttempts || 0) + 1;
        addLog(order, `PayPal refused the capture: ${e.message}${dbg}`);
        return { error: 'PayPal could not complete this payment. You have not been charged. Please try again.' };
      } else {
        addLog(order, `PayPal capture result unknown (${e.message})${dbg}. Will check again automatically.`);
        this._extendHold(order, 30);
        return { unknown: true, error: UNCONFIRMED };
      }
    }
    let r = await this._applyPayPalOrder(order, data, source);
    if (r.notCaptured) {
      // PayPal accepted the request but the capture isn't in the reply (it can answer 202
      // and finish in the background). Look again; if still nothing, the outcome is unknown.
      try {
        r = await this._applyPayPalOrder(order, await paypal.getOrder(order.paypal.orderId), source);
      } catch {}
      if (r.notCaptured) {
        addLog(order, 'PayPal accepted the payment request but has not confirmed it yet. Will check again automatically.');
        this._extendHold(order, 30);
        return { unknown: true, error: UNCONFIRMED };
      }
    }
    return r;
  }

  /** Apply a PayPal order/capture representation to our order (caller holds the lock). */
  async _applyPayPalOrder(order, data, source) {
    order.paypal = order.paypal || {};
    order.paypal.lastOkAt = nowIso(); // PayPal answered about this order
    if (data.status) order.paypal.status = data.status;
    if (data.payer) {
      order.paypal.payerEmail = data.payer.email_address || order.paypal.payerEmail;
      order.paypal.payerId = data.payer.payer_id || order.paypal.payerId;
      const n = data.payer.name;
      if (n) order.paypal.payerName = [n.given_name, n.surname].filter(Boolean).join(' ');
    }
    const cap = extractCapture(data);
    if (!cap) return { notCaptured: true };
    order.paypal.captureId = cap.id;
    order.paypal.captureStatus = cap.status;
    const amountOk =
      cap.amount && cap.amount.currency_code === order.currency && toCents(cap.amount.value) === toCents(order.total);

    if (cap.status === 'COMPLETED') {
      order.paidAt = order.paidAt || nowIso();
      if (!amountOk) {
        order.status = 'needs_attention';
        order.attentionKind = 'amount';
        order.attention = `PayPal captured ${cap.amount ? `${cap.amount.value} ${cap.amount.currency_code}` : 'an unknown amount'}, but the order total is ${order.total} ${order.currency}. Tickets were not sent. Check the payment in PayPal, then use "Retry delivery" or refund.`;
        addLog(order, order.attention);
        this._alertOnce(order, 'Payment amount mismatch', [`Order ${order.id}`, order.attention]);
        return {};
      }
      order.status = 'paid';
      addLog(order, `Payment captured ${cap.id} – ${formatMoney(order.total, order.currency)} (${source})`);
      await this._fulfillLocked(order);
      return {};
    }

    if (cap.status === 'PENDING') {
      if (order.status !== 'payment_pending') {
        order.status = 'payment_pending';
        order.paypal.pendingReason = (cap.status_details && cap.status_details.reason) || '';
        this._extendHold(order, 60 * 24 * 7);
        addLog(order, `PayPal is holding the payment${order.paypal.pendingReason ? ` (${order.paypal.pendingReason})` : ''}. Tickets stay reserved.`);
        this._alertOnce(order, 'Payment pending in PayPal', [
          `Order ${order.id} – ${formatMoney(order.total, order.currency)} – ${order.customer.name} <${order.customer.email}>`,
          `PayPal reason: ${order.paypal.pendingReason || 'not given'}.`,
          'Tickets are sent automatically once PayPal completes the payment. If the reason is RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION, accept the payment in your PayPal account (or allow payments in this currency).',
        ]);
      }
      return {};
    }

    if (cap.status === 'REFUNDED' || cap.status === 'PARTIALLY_REFUNDED') {
      order.paidAt = order.paidAt || nowIso();
      if (!order.tickets.length) await this._releaseLocked(order);
      if (cap.status === 'REFUNDED') order.status = 'refunded';
      addLog(order, `PayPal reports the payment as ${cap.status.toLowerCase().replace('_', ' ')}`);
      return {};
    }

    // DECLINED / FAILED
    order.status = 'failed';
    addLog(order, `PayPal capture ${cap.status}. Not charged; tickets returned to stock.`);
    await this._releaseLocked(order);
    return { error: 'PayPal declined the payment. You have not been charged.' };
  }

  /** Move the reserved files into sold/ and mark the order fulfilled (caller holds the lock). */
  async _fulfillLocked(order) {
    const stock = this.stockFor(order);
    try {
      if (!order.tickets || !order.tickets.length) {
        order.reservation = order.reservation || { files: [] };
        let files = order.reservation.files || [];
        const missing = await stock.missing(files);
        let present = files.filter((f) => !missing.includes(f));

        const need = {};
        for (const i of order.items) need[i.typeId] = (need[i.typeId] || 0) + i.qty;
        const keep = [];
        const surplus = [];
        for (const f of present) {
          if ((need[f.typeId] || 0) > 0) {
            keep.push(f);
            need[f.typeId]--;
          } else surplus.push(f);
        }
        if (surplus.length) await stock.release(order.id, surplus);
        present = keep;
        const toReserve = Object.entries(need)
          .filter(([, q]) => q > 0)
          .map(([typeId, q]) => ({ typeId, qty: q }));
        if (toReserve.length) {
          const extra = await stock.reserve(order.id, order.visitDate, toReserve);
          present = present.concat(extra);
          addLog(order, `Reserved ${extra.length} replacement ticket(s) from stock`);
        }
        order.reservation.files = present;
        order.tickets = await stock.finalize(order.id, present);
        order.reservation.files = [];
        order.reservation.finalizedAt = nowIso();
      }
      if (!order.downloadToken) order.downloadToken = token(24);
      order.status = 'fulfilled';
      order.fulfilledAt = order.fulfilledAt || nowIso();
      delete order.attention;
      delete order.attentionKind;
      order.email = { ...(order.email || {}), status: 'queued', queuedAt: nowIso(), attempts: (order.email && order.email.attempts) || 0 };
      addLog(order, `${order.tickets.length} ticket file(s) issued`);
    } catch (e) {
      const kind = e instanceof SoldOutError ? 'stock' : 'error';
      const msg =
        kind === 'stock'
          ? 'Paid, but there are not enough tickets in stock. Add tickets to stock — delivery is retried automatically every few minutes — or refund the customer in PayPal.'
          : `Paid, but issuing the tickets failed: ${e.message}`;
      if (kind === 'error') logError('Ticket issuing failed', order.id, e);
      const changed = order.attention !== msg;
      order.status = 'needs_attention';
      order.attentionKind = kind;
      order.attention = msg;
      if (changed) addLog(order, msg);
      this._alertOnce(order, 'A paid order needs attention', [`Order ${order.id} – ${order.customer.name} <${order.customer.email}>`, msg]);
    }
  }

  async _releaseLocked(order) {
    const files = (order.reservation && order.reservation.files) || [];
    if (files.length) await this.stockFor(order).release(order.id, files);
    order.reservation = { ...(order.reservation || {}), files: [], releasedAt: nowIso() };
  }

  _afterFulfilled(orderId) {
    setImmediate(async () => {
      try {
        await this.sendTicketEmail(orderId);
      } catch (e) {
        logError('Ticket email error', orderId, e.message);
      }
      try {
        await this._notifySale(orderId);
      } catch (e) {
        logError('Sale notification error', orderId, e.message);
      }
      try {
        await this.checkLowStock();
      } catch (e) {
        logError('Low stock check error', e.message);
      }
      try {
        await this._checkDuplicatePurchase(orderId);
      } catch (e) {
        logError('Duplicate check error', e.message);
      }
    });
  }

  /** Tell the owner when the same email paid for several orders within an hour (e.g. a retried payment). */
  async _checkDuplicatePurchase(orderId) {
    const orders = await this.store.listOrders();
    const o = orders.find((x) => x.id === orderId);
    if (!o || !o.paidAt) return;
    const t = Date.parse(o.paidAt);
    const twins = orders.filter(
      (x) =>
        x.id !== o.id &&
        x.paidAt &&
        ['fulfilled', 'paid', 'needs_attention'].includes(x.status) &&
        x.customer.email === o.customer.email &&
        Math.abs(Date.parse(x.paidAt) - t) < 3600000
    );
    if (!twins.length) return;
    this._alert(
      'Possible double purchase',
      [
        `${o.customer.email} paid for ${twins.length + 1} orders within an hour: ${[o.id].concat(twins.map((x) => x.id)).join(', ')}.`,
        'If one of them was a mistake (for example a payment retried after a connection problem), refund it in PayPal.',
      ],
      o.id
    );
  }

  // ---- email -------------------------------------------------------------------------
  async sendTicketEmail(orderId, { to = null, force = false, by = '' } = {}) {
    // 1) Claim the send under the order lock (so two processes never send the same email)…
    const claim = await this.store.withLock('order-' + orderId, async () => {
      const order = await this.store.getOrder(orderId);
      if (!order) throw new HttpError(404, 'Order not found.');
      if (order.status !== 'fulfilled') {
        if (force) throw new HttpError(409, 'Tickets can only be emailed for completed orders.');
        return null;
      }
      order.email = order.email || {};
      if (!force && order.email.status === 'sent') return null;
      const claimedAt = Date.parse(order.email.claimedAt || 0) || 0;
      if (!force && order.email.status === 'sending' && Date.now() - claimedAt < 10 * 60000) return null;
      order.email.status = 'sending';
      order.email.claimedAt = nowIso();
      order.email.attempts = (order.email.attempts || 0) + 1;
      order.email.lastAttemptAt = nowIso();
      await this.store.saveOrder(order);
      return { order, recipient: to || order.customer.email };
    });
    if (!claim) return this.store.getOrder(orderId);

    // 2) …send it without holding the lock (big attachments can take a while)…
    const { order, recipient } = claim;
    let info = null;
    let error = null;
    try {
      const s = this.settings();
      const attachments = [];
      let size = 0;
      for (let i = 0; i < order.tickets.length; i++) {
        // Ticket bytes come from the stock (disk or database) as a buffer, so the
        // same code works whether tickets are files or rows in Postgres.
        const file = await this.stockFor(order).read(order.tickets[i].path);
        size += file.size || file.buffer.length;
        attachments.push({ filename: this.ticketFileName(order, i), content: file.buffer, contentType: file.mime || 'application/pdf' });
      }
      const attach = size <= 15 * 1024 * 1024;
      const msg = emails.ticketEmail({ order, settings: s, downloadUrl: this.downloadUrl(order), attached: attach, templates: this.mailConfig.templates });
      info = await this.mailer.send({
        to: `"${displayName(order.customer.name)}" <${recipient}>`,
        replyTo: s.supportEmail || undefined,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: attach ? attachments : [],
      });
    } catch (e) {
      error = e;
    }

    // 3) …and record the result under the lock again.
    const saved = await this.store.withLock('order-' + orderId, async () => {
      const o = await this.store.getOrder(orderId);
      if (!o) return null;
      o.email = o.email || {};
      if (!error) {
        o.email.status = 'sent';
        o.email.sentAt = nowIso();
        o.email.to = recipient;
        o.email.lastError = null;
        o.email.nextAttemptAt = null;
        addLog(o, `Tickets emailed to ${recipient}${info && info.outbox ? ' (saved in data/outbox – SMTP not set up)' : ''}${by ? ` by ${by}` : ''}`);
        this.logActivity({ type: 'email', orderId: o.id, actor: by || 'system', msg: `Tickets emailed to ${recipient}${info && info.outbox ? ' (saved to the outbox, SMTP not set up)' : ''}` });
      } else {
        const delays = [2, 10, 30, 120, 360];
        const attempts = o.email.attempts || 1;
        o.email.status = o.email.sentAt && force ? 'sent' : 'failed';
        o.email.lastError = error.message;
        o.email.nextAttemptAt = o.email.status === 'failed' && attempts < 6 ? new Date(Date.now() + delays[Math.min(attempts - 1, delays.length - 1)] * 60000).toISOString() : null;
        addLog(o, `Email to ${recipient} failed: ${error.message}`);
        logError('Ticket email failed', o.id, error.message);
        this.logActivity({ type: 'error', orderId: o.id, actor: by || 'system', msg: `Email to ${recipient} failed: ${error.message}` });
        if (attempts === 1) {
          this._alert('Ticket email could not be sent', [`Order ${o.id} to ${recipient}`, `Error: ${error.message}`, 'The app retries automatically. The customer can also use the download link shown after payment.'], o.id);
        }
      }
      await this.store.saveOrder(o);
      return o;
    });
    if (error && force) throw new HttpError(502, 'The email could not be sent: ' + error.message);
    return saved;
  }

  async _notifySale(orderId) {
    const s = this.settings();
    if (!s.notifyAdminOnSale || !this.config.adminEmail) return;
    const order = await this.store.getOrder(orderId);
    if (!order) return;
    const msg = emails.adminSaleEmail({ order, settings: s, adminUrl: this.adminUrl, templates: this.mailConfig.templates });
    await this.mailer.send({ to: this.config.adminEmail, subject: msg.subject, html: msg.html, text: msg.text });
  }

  _alert(title, lines, orderId) {
    log('ALERT:', title, '|', lines.join(' | '));
    this.logActivity({ type: 'alert', orderId: orderId || null, actor: 'system', msg: title });
    if (!this.config.adminEmail) return;
    const msg = emails.adminAlertEmail({ settings: this.settings(), title, lines, adminUrl: this.adminUrl, orderId, templates: this.mailConfig.templates });
    this.mailer
      .send({ to: this.config.adminEmail, subject: msg.subject, html: msg.html, text: msg.text })
      .catch((e) => logError('Admin alert email failed:', e.message));
  }

  /** Alert at most once a day per order. */
  /** Alert the owner about an order at most once a day per kind of problem. */
  _alertOnce(order, title, lines) {
    order.alerts = order.alerts && typeof order.alerts === 'object' ? order.alerts : {};
    const last = Date.parse(order.alerts[title] || 0) || 0;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    order.alerts[title] = nowIso();
    order.alertedAt = order.alerts[title];
    this._alert(title, lines, order.id);
  }

  async checkLowStock() {
    const s = this.settings();
    if (!s.lowStockThreshold) return;
    const types = this.activeTypes(s);
    const counts = await this.stock.counts(types.map((t) => t.id));
    const today = this.now().date;
    const low = [];
    for (const t of types) {
      const c = counts[t.id] || { open: 0, dated: {} };
      const total = c.open + Object.entries(c.dated).reduce((a, [d, n]) => a + (d >= today ? n : 0), 0);
      if (total <= s.lowStockThreshold) low.push({ t, total });
    }
    if (!low.length) return;
    const state = await this.store.getState();
    const last = state.lowStockAlerts || {};
    const folder = this.activeFolder; // real and test tickets are tracked separately
    const key = (t) => `${folder}:${t.id}`;
    const due = low.filter(({ t }) => !last[key(t)] || Date.now() - Date.parse(last[key(t)]) > 24 * 3600 * 1000);
    if (!due.length) return;
    await this.store.updateState((st) => {
      st.lowStockAlerts = { ...(st.lowStockAlerts || {}) };
      for (const { t } of due) st.lowStockAlerts[key(t)] = nowIso();
    });
    this._alert(
      'Ticket stock is running low',
      due.map(({ t, total }) => `${t.name}: ${total} ticket${total === 1 ? '' : 's'} left (folder ${path.basename(this.payments.ticketsDir(this.mode))}/stock/${t.id}/)`)
    );
  }

  async sendTestEmail(to) {
    if (!isEmail(String(to || ''))) throw new HttpError(400, 'Enter a valid email address.');
    const s = this.settings();
    const msg = emails.testEmail({ settings: s, templates: this.mailConfig.templates });
    try {
      const info = await this.mailer.send({ to, subject: msg.subject, html: msg.html, text: msg.text });
      await this.logActivity({ type: 'email', actor: 'admin', msg: `Test email sent to ${to}${info.outbox ? ' (saved to the outbox, SMTP not set up)' : ''}` });
      return { ok: true, outbox: !!info.outbox, response: info.response || null };
    } catch (e) {
      await this.logActivity({ type: 'error', actor: 'admin', msg: `Test email to ${to} failed: ${e.message}` });
      throw new HttpError(502, 'Sending failed: ' + e.message);
    }
  }

  // ---- customer cancel / downloads -------------------------------------------------------
  async cancelByCustomer(orderId, paypalOrderId) {
    if (!ORDER_ID_RE.test(String(orderId))) throw new HttpError(404, 'Order not found.');
    await this.store.withLock('order-' + orderId, async () => {
      const order = await this.store.getOrder(orderId);
      if (!order || order.status !== 'pending' || !order.paypal.orderId || order.paypal.orderId !== String(paypalOrderId)) return;
      const paypal = this.paypalFor(order);
      if (paypal.mode !== 'mock') {
        try {
          const data = await paypal.getOrder(order.paypal.orderId);
          if (data.status === 'APPROVED' || data.status === 'COMPLETED') return;
        } catch {
          return; // unsure: let the hold expire normally
        }
      }
      order.status = 'cancelled';
      addLog(order, 'Buyer closed the PayPal window. Tickets returned to stock.');
      await this._releaseLocked(order);
      await this.store.saveOrder(order);
    });
    return { ok: true };
  }

  async orderForDownload(id, tok) {
    const order = ORDER_ID_RE.test(String(id)) ? await this.store.getOrder(id) : null;
    if (!order || !order.downloadToken || !safeEqual(order.downloadToken, String(tok || ''))) {
      throw new HttpError(404, 'This download link is not valid. Please check the link in your email.');
    }
    if (order.status !== 'fulfilled') {
      throw new HttpError(410, order.status === 'refunded' ? 'This order was refunded, so its tickets are no longer available.' : 'These tickets are not available.');
    }
    return order;
  }

  // ---- webhooks --------------------------------------------------------------------------
  /** A verified PayPal webhook event, received for payment mode `mode` (sandbox or live). */
  async handleWebhook(event, mode) {
    const type = String((event && event.event_type) || '');
    const r = (event && event.resource) || {};
    let localId =
      r.custom_id || (Array.isArray(r.purchase_units) && r.purchase_units[0] && r.purchase_units[0].custom_id) || r.invoice_id || '';
    if (!ORDER_ID_RE.test(localId) && type.startsWith('PAYMENT.CAPTURE.')) {
      const up = (r.links || []).find((l) => l.rel === 'up');
      const m = up && /captures\/([^/?#]+)/.exec(up.href || '');
      if (m) {
        const o = (await this.store.listOrders()).find((x) => x.paypal && x.paypal.captureId === m[1]);
        if (o) localId = o.id;
      }
    }
    if (!ORDER_ID_RE.test(localId)) {
      log(`Webhook ${type}: no matching order, ignored`);
      return { ignored: true };
    }

    let fulfilledNow = false;
    await this.store.withLock('order-' + localId, async () => {
      const order = await this.store.getOrder(localId);
      if (!order) return;
      if (mode && this.modeOf(order) !== mode) {
        log(`Webhook ${type} from PayPal ${mode} for ${localId}, which is a ${this.modeOf(order)} order: ignored`);
        return;
      }
      const before = order.status;
      const ppOrderId = type.startsWith('CHECKOUT.ORDER.')
        ? r.id
        : r.supplementary_data && r.supplementary_data.related_ids && r.supplementary_data.related_ids.order_id;
      if (ppOrderId && order.paypal.orderId && ppOrderId !== order.paypal.orderId) {
        log(`Webhook ${type} for ${localId}: different PayPal order (${ppOrderId}), ignored`);
        return;
      }
      const asOrder = { status: 'COMPLETED', purchase_units: [{ payments: { captures: [r] } }] };
      switch (type) {
        case 'CHECKOUT.ORDER.APPROVED':
          if (['pending', 'expired', 'cancelled'].includes(order.status)) {
            addLog(order, 'PayPal webhook: buyer approved the payment');
            await this._captureLocked(order, 'webhook');
          }
          break;
        case 'CHECKOUT.ORDER.COMPLETED':
        case 'PAYMENT.CAPTURE.COMPLETED':
        case 'PAYMENT.CAPTURE.PENDING':
          if (['pending', 'payment_pending', 'paid', 'expired', 'cancelled', 'failed'].includes(order.status)) {
            await this._applyPayPalOrder(order, type === 'CHECKOUT.ORDER.COMPLETED' ? r : asOrder, 'webhook');
          }
          break;
        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED':
          if (['pending', 'payment_pending'].includes(order.status)) {
            order.status = 'failed';
            addLog(order, 'PayPal webhook: payment denied. Tickets returned to stock.');
            await this._releaseLocked(order);
          }
          break;
        case 'PAYMENT.CAPTURE.REFUNDED':
          this._recordRefund(order, r, 'PayPal');
          break;
        case 'PAYMENT.CAPTURE.REVERSED':
          if (order.status !== 'reversed') {
            order.status = 'reversed';
            addLog(order, 'PayPal webhook: payment reversed (chargeback or dispute).');
            this._alert('Payment reversed', [`Order ${order.id} – ${formatMoney(order.total, order.currency)}`, 'PayPal reversed this payment (chargeback/dispute).'], order.id);
          }
          break;
        default:
          log(`Webhook ${type} for ${localId}: nothing to do`);
      }
      await this.store.saveOrder(order);
      fulfilledNow = before !== 'fulfilled' && order.status === 'fulfilled';
    });
    if (fulfilledNow) this._afterFulfilled(localId);
    return { ok: true };
  }

  _recordRefund(order, r, source) {
    order.refunds = order.refunds || [];
    if (r.id && order.refunds.some((x) => x.id === r.id)) return;
    const already = order.refunds.reduce((a, x) => a + toCents(x.amount), 0);
    const amountCents = r.amount && r.amount.value ? toCents(r.amount.value) : toCents(order.total) - already;
    if (!(amountCents > 0)) return;
    order.refunds.push({ id: r.id || null, amount: fromCents(amountCents), at: nowIso(), source });
    const refunded = already + amountCents;
    order.refundedTotal = fromCents(refunded);
    if (refunded >= toCents(order.total)) order.status = 'refunded';
    addLog(order, `Refund of ${formatMoney(amountCents, order.currency)} recorded (${source})`);
  }

  // ---- background job --------------------------------------------------------------------
  async reconcile() {
    if (this._reconciling) return;
    this._reconciling = true;
    this.lastReconcileAt = Date.now();
    try {
      if (!this._backfilled) {
        await this.backfillClientIds();
        this._backfilled = true;
      }
      const orders = await this.store.listOrders();
      const now = Date.now();
      const ts = (v) => Date.parse(v || 0) || 0;
      for (const o of orders) {
        try {
          if (o.status === 'pending' && ts(o.reservation && o.reservation.expiresAt) <= now) {
            await this._reconcileOpen(o.id);
          } else if (o.status === 'payment_pending' && now - ts((o.paypal && o.paypal.lastCheckAt) || o.updatedAt) > 15 * 60000) {
            await this._reconcileOpen(o.id);
          } else if (o.status === 'paid' && now - ts(o.updatedAt) > 60000) {
            await this.retryDelivery(o.id, 'system');
          } else if (o.status === 'needs_attention' && o.attentionKind !== 'amount' && now - ts(o.updatedAt) > 5 * 60000) {
            await this.retryDelivery(o.id, 'system');
          } else if (
            o.status === 'fulfilled' &&
            o.email &&
            ((o.email.status === 'queued' && now - ts(o.email.queuedAt || o.updatedAt) > 2 * 60000) ||
              (o.email.status === 'sending' && now - ts(o.email.claimedAt) > 10 * 60000) ||
              (o.email.status === 'failed' && o.email.nextAttemptAt && ts(o.email.nextAttemptAt) <= now))
          ) {
            await this.sendTicketEmail(o.id);
          } else if (
            ABANDONED.includes(o.status) &&
            !o.paidAt &&
            o.paypal &&
            o.paypal.captureAttemptedAt &&
            this.modeOf(o) !== 'mock' &&
            now - ts(o.paypal.captureAttemptedAt) < 3 * 86400000 &&
            now - ts(o.paypal.lastCheckAt || o.updatedAt) > 30 * 60000
          ) {
            // A capture was sent for this order: keep asking PayPal for 3 days whether money arrived after all.
            await this._recheckAbandoned(o.id);
          } else if (ABANDONED.includes(o.status) && !o.paidAt && !(o.paypal && o.paypal.captureAttemptedAt) && now - ts(o.createdAt) > 60 * 86400000) {
            await this._purgeAbandoned(o.id);
          }
        } catch (e) {
          logError('Reconcile error', o.id, e.message);
        }
      }
      const holding = new Set(orders.filter((o) => HOLDING.includes(o.status)).map((o) => o.id));
      for (const stock of this.payments.knownStocks()) {
        await stock.recoverOrphans(async (id) => {
          if (holding.has(id)) return true;
          const o = await this.store.getOrder(id);
          return !!o && HOLDING.includes(o.status);
        });
      }
      // Replaced PayPal keys are kept while an order made with them may still need PayPal.
      await this.payments.purgeRetired(() => this._appsStillNeeded());
    } catch (e) {
      logError('Reconcile failed', e);
    } finally {
      this._reconciling = false;
    }
  }

  async _reconcileOpen(id) {
    let fulfilledNow = false;
    await this.store.withLock('order-' + id, async () => {
      const order = await this.store.getOrder(id);
      if (!order || !['pending', 'payment_pending'].includes(order.status)) return;
      const expired = (Date.parse((order.reservation && order.reservation.expiresAt) || 0) || 0) <= Date.now();
      if (order.status === 'pending' && !expired) return;
      const before = order.status;
      const expire = async (why) => {
        order.status = 'expired';
        addLog(order, `${why} Tickets returned to stock.`);
        await this._releaseLocked(order);
      };

      const paypal = this.paypalFor(order);
      const moneyMayHaveMoved = !!order.paypal.captureAttemptedAt || order.status === 'payment_pending';
      if (paypal.mode !== 'mock' && paypal.enabled && order.paypal.orderId) {
        let data = null;
        try {
          data = await paypal.getOrder(order.paypal.orderId);
          order.paypal.lastCheckAt = nowIso();
          order.paypal.lastOkAt = order.paypal.lastCheckAt;
        } catch (e) {
          if (e.status !== 404) {
            order.paypal.lastCheckAt = nowIso();
            if (e.status === 401 || e.status === 403) {
              // PayPal rejects the keys this order was made with (app deleted, secret changed).
              if (moneyMayHaveMoved) this._alertCantCheck(order, paypal, 'PayPal no longer accepts the keys this order was made with');
              else if (order.status === 'pending') await expire('Checkout expired (PayPal no longer accepts the keys it was made with).');
            } else {
              // Pending checkouts: 3 hours after the hold ran out. Payments PayPal is holding:
              // 3 hours since PayPal last answered (never updatedAt, which every save moves).
              const since =
                Date.parse(order.status === 'pending' ? order.reservation.expiresAt : order.paypal.lastOkAt || order.paidAt || order.createdAt) || 0;
              if (Date.now() - since > 3 * 3600000) {
                if (moneyMayHaveMoved) {
                  // Money may have moved: keep the tickets and keep asking PayPal.
                  this._alertOnce(order, 'A payment could not be confirmed with PayPal', [
                    `Order ${order.id} – ${formatMoney(order.total, order.currency)} – ${order.customer.name} <${order.customer.email}>`,
                    'PayPal has not answered about this payment for 3 hours. The tickets stay reserved and the app keeps checking. Look the order up in your PayPal account.',
                  ]);
                } else if (order.status === 'pending') {
                  await expire('Checkout expired (PayPal could not be reached to confirm).');
                }
              }
            }
            await this.store.saveOrder(order);
            return;
          }
        }
        if (!data && moneyMayHaveMoved) {
          // PayPal (with the right keys) has no record of an order a payment was sent for: keep it.
          if (!order.paypal.notFoundAt) {
            order.paypal.notFoundAt = nowIso();
            addLog(order, 'PayPal has no record of this order although a payment was sent. Kept for the owner to check.');
          }
          this._alertOnce(order, 'PayPal has no record of a payment', [
            `Order ${order.id} – ${formatMoney(order.total, order.currency)} – ${order.customer.name} <${order.customer.email}>`,
            'A payment was sent to PayPal for this order, but PayPal now says it has no record of it. The order is kept as it is.',
            'Look the order up in your PayPal account, then open it in the dashboard and choose what happened.',
          ]);
        } else if (data && extractCapture(data)) {
          await this._applyPayPalOrder(order, data, 'automatic check');
        } else if (data && data.status === 'APPROVED' && order.status === 'pending') {
          order.paypal.captureAttempts = (order.paypal.captureAttempts || 0) + 1;
          if (order.paypal.captureAttempts <= 3) {
            addLog(order, 'Buyer approved the payment but it was not captured yet – capturing now');
            await this._captureLocked(order, 'automatic check');
          } else {
            await expire('Payment could not be captured after several attempts.');
          }
        } else if (order.status === 'pending') {
          await expire(`Checkout not completed${data ? ` (PayPal status ${data.status})` : ''}.`);
        }
      } else if (paypal.mode !== 'mock' && moneyMayHaveMoved) {
        // Money may have moved, but PayPal can't be asked (its keys are not connected):
        // keep the tickets and tell the owner instead of guessing.
        order.paypal.lastCheckAt = nowIso();
        this._alertCantCheck(order, paypal);
      } else if (order.status === 'pending') {
        await expire('Checkout not completed in time.');
      }
      await this.store.saveOrder(order);
      fulfilledNow = before !== 'fulfilled' && order.status === 'fulfilled';
    });
    if (fulfilledNow) this._afterFulfilled(id);
  }

  /**
   * true: PayPal answers with these keys. false: it can't be asked (keys missing, or PayPal
   * rejects them, e.g. the app was deleted or its secret changed). null: unreachable right now.
   */
  async _payPalUsable(client) {
    if (client.mode === 'mock') return client.enabled;
    if (!client.enabled) return false;
    try {
      await client.token(true); // a fresh token: a cached one can outlive deleted keys by hours
      return true;
    } catch (e) {
      return e.status >= 400 && e.status < 500 ? false : null;
    }
  }

  _alertCantCheck(order, paypal, reason) {
    const why = String(reason || paypal.disabledReason || 'PayPal is not connected');
    this._alertOnce(order, 'A payment could not be checked with PayPal', [
      `Order ${order.id} – ${formatMoney(order.total, order.currency)} – ${order.customer.name} <${order.customer.email}>`,
      `${why.charAt(0).toUpperCase() + why.slice(1)}. A payment was started, so the app does not guess: the order is kept as it is.`,
      'Look the order up in your PayPal account. If it was paid, connect those keys again on the PayPal page and the tickets are sent automatically. If it was not paid, open the order in the dashboard and release its tickets.',
    ]);
  }

  async _purgeAbandoned(id) {
    await this.store.withLock('order-' + id, async () => {
      const o = await this.store.getOrder(id);
      if (!o || !ABANDONED.includes(o.status) || o.paidAt) return;
      if (o.paypal && (o.paypal.captureAttemptedAt || o.paypal.captureId)) return; // keep anything that reached PayPal capture
      if (o.reservation && o.reservation.files && o.reservation.files.length) return;
      await this.store.deleteOrder(id);
    });
  }

  /** An expired/cancelled/declined order where a capture was attempted: did PayPal take the money after all? */
  async _recheckAbandoned(id) {
    let fulfilledNow = false;
    await this.store.withLock('order-' + id, async () => {
      const o = await this.store.getOrder(id);
      if (!o || !ABANDONED.includes(o.status) || o.paidAt || !o.paypal || !o.paypal.orderId) return;
      const paypal = this.paypalFor(o);
      if (!paypal.enabled) {
        o.paypal.lastCheckAt = nowIso();
        this._alertCantCheck(o, paypal);
        await this.store.saveOrder(o);
        return;
      }
      let data = null;
      try {
        data = await paypal.getOrder(o.paypal.orderId);
      } catch (e) {
        if (e.status === 401 || e.status === 403) this._alertCantCheck(o, paypal, 'PayPal no longer accepts the keys this order was made with');
      }
      o.paypal.lastCheckAt = nowIso();
      const cap = data && extractCapture(data);
      if (cap && (cap.status === 'COMPLETED' || cap.status === 'PENDING')) {
        const was = o.status;
        addLog(o, `PayPal shows a ${cap.status.toLowerCase()} payment for this ${was} order. Delivering the tickets.`);
        this._alert('Late PayPal payment found', [
          `Order ${o.id} (${was}) – ${o.customer.name} <${o.customer.email}>`,
          `PayPal shows the payment as ${cap.status}. The app is issuing the tickets now; check the order in the dashboard.`,
        ], o.id);
        await this._applyPayPalOrder(o, data, 'automatic check');
        fulfilledNow = o.status === 'fulfilled';
      }
      await this.store.saveOrder(o);
    });
    if (fulfilledNow) this._afterFulfilled(id);
  }

  /**
   * Orders made before orders recorded their PayPal app: link the open ones to their mode's
   * current keys, so replacing those keys keeps them (see Payments.purgeRetired).
   */
  async backfillClientIds() {
    const now = Date.now();
    for (const o of await this.store.listOrders()) {
      const mode = this.modeOf(o);
      if (!o.paypal || o.paypal.clientId || (mode !== 'sandbox' && mode !== 'live')) continue;
      const open =
        o.status === 'pending' ||
        o.status === 'payment_pending' ||
        (ABANDONED.includes(o.status) && !o.paidAt && o.paypal.captureAttemptedAt && now - (Date.parse(o.paypal.captureAttemptedAt) || 0) < 3 * 86400000);
      const cid = open && this.payments.client(mode).clientId;
      if (!cid) continue;
      await this.store.updateOrder(o.id, (x) => {
        if (x.paypal && !x.paypal.clientId) x.paypal.clientId = cid;
      });
    }
  }

  /** "mode|clientId" of every PayPal app an order may still need (read fresh). */
  async _appsStillNeeded() {
    const now = Date.now();
    const out = new Set();
    for (const o of await this.store.listOrders()) {
      if (!o.paypal || !o.paypal.clientId) continue;
      const need =
        o.status === 'pending' ||
        o.status === 'payment_pending' ||
        (ABANDONED.includes(o.status) && !o.paidAt && o.paypal.captureAttemptedAt && now - (Date.parse(o.paypal.captureAttemptedAt) || 0) < 3 * 86400000);
      if (need) out.add(`${this.modeOf(o)}|${o.paypal.clientId}`);
    }
    return out;
  }

  // ---- payment mode (dashboard PayPal page) ---------------------------------------------
  _liveOrdersInProgress(orders) {
    return orders.filter(
      (o) =>
        this.modeOf(o) === 'live' &&
        (o.status === 'pending' || o.status === 'payment_pending' || (['paid', 'needs_attention'].includes(o.status) && o.paidAt))
    );
  }

  /** Switch the mode used for new checkouts. Leaving live is refused while live orders are in progress. */
  async switchPaymentMode(mode) {
    mode = String(mode || '');
    if (!['sandbox', 'live', 'mock'].includes(mode)) throw new HttpError(400, 'Unknown payment mode.');
    if (mode === this.mode) return;
    const reason = this.payments.disabledReason(mode);
    if (reason) throw new HttpError(409, reason);
    if (mode === 'live' && !this.payments.publicHttps) {
      throw new HttpError(409, `Live payments need the app's public https address. BASE_URL is ${this.config.baseUrl}.`);
    }
    if (mode !== 'mock') {
      try {
        await this.payments.client(mode).token(true);
      } catch (e) {
        if (e.status >= 400 && e.status < 500) {
          throw new HttpError(409, `PayPal no longer accepts the saved ${mode === 'live' ? 'live' : 'Sandbox'} keys. Connect them again.`);
        }
        throw new HttpError(502, 'Could not reach PayPal to check the keys. Try again in a minute.');
      }
    }
    // Same lock as checkout: no order can be half-created while the mode changes.
    await this.store.withLock('checkout-holds', async () => {
      const current = this.mode;
      if (current === mode) return;
      if (current === 'live') {
        const busy = this._liveOrdersInProgress(await this.store.listOrders());
        if (busy.length) {
          const n = busy.length;
          throw new HttpError(
            409,
            `${n} live order${n > 1 ? 's are' : ' is'} still in progress (a customer paying or waiting for tickets). ` +
              `Unpaid checkouts close by themselves within ${this.settings().holdMinutes} minutes; orders that need attention can be delivered or refunded on the Orders page. Then try again.`,
            { code: 'LIVE_ORDERS_OPEN' }
          );
        }
      }
      await this.payments.saveMode(mode);
      log(`Payment mode changed on the dashboard: ${current} -> ${mode}`);
    });
  }

  async _ticketTotal(stock) {
    const types = this.activeTypes();
    const counts = await stock.counts(types.map((t) => t.id));
    const today = this.now().date;
    let total = 0;
    for (const t of types) {
      const c = counts[t.id] || { open: 0, dated: {} };
      total += c.open + Object.entries(c.dated).reduce((a, [d, n]) => a + (d >= today ? n : 0), 0);
    }
    return total;
  }

  // Ticket folders as the dashboard shows them: "real" (live payments) and "test" (PayPal
  // Sandbox and simulated payments).
  folderOfMode(mode) {
    return mode === 'live' ? 'real' : 'test';
  }

  get activeFolder() {
    return this.folderOfMode(this.mode);
  }

  folderParam(v) {
    v = String(v || '');
    return v === 'test' || v === 'real' ? v : this.activeFolder;
  }

  stockForFolder(folder) {
    return this.payments.stock(folder === 'test' ? 'sandbox' : 'live');
  }

  /** Everything the dashboard's PayPal page shows (no secrets). */
  async paymentsStatus() {
    const st = this.payments.status();
    for (const m of ['sandbox', 'live']) {
      const dir = this.payments.ticketsDir(m);
      const has = m === st.mode || this.payments.dbTickets || fs.existsSync(path.join(dir, 'stock'));
      st.modes[m].tickets = has ? await this._ticketTotal(this.payments.stock(m)) : 0;
    }
    st.liveOrdersInProgress = this._liveOrdersInProgress(await this.store.listOrders()).length;
    return st;
  }

  // ---- admin actions ---------------------------------------------------------------------
  async retryDelivery(id, by = 'admin') {
    let fulfilledNow = false;
    const order = await this.store.withLock('order-' + id, async () => {
      const o = await this.store.getOrder(id);
      if (!o) throw new HttpError(404, 'Order not found.');
      if (!['paid', 'needs_attention'].includes(o.status) || !o.paidAt) {
        if (by === 'system') return o;
        throw new HttpError(409, 'Only paid orders that are waiting for tickets can be retried.');
      }
      if (by !== 'system') addLog(o, `Retry delivery requested by ${by}`);
      await this._fulfillLocked(o);
      await this.store.saveOrder(o);
      fulfilledNow = o.status === 'fulfilled';
      return o;
    });
    if (fulfilledNow) this._afterFulfilled(id);
    return order;
  }

  /** Orders where money may have moved but PayPal can't be asked: the owner decides after checking PayPal. */
  _ownerMustDecide(o) {
    if (this.modeOf(o) === 'mock' || o.paidAt || !o.paypal || !o.paypal.captureAttemptedAt) return false;
    return ['pending', 'payment_pending'].includes(o.status) || ABANDONED.includes(o.status);
  }

  /** May the owner decide this order? Only if PayPal can't be asked, or has no record of it. */
  async _ownerCanDecide(o) {
    if (!this._ownerMustDecide(o)) return false;
    const usable = await this._payPalUsable(this.paypalFor(o));
    return usable === false || (usable === true && !!o.paypal.notFoundAt);
  }

  async cancelByAdmin(id, { confirmNotPaid = false } = {}) {
    return this.store.withLock('order-' + id, async () => {
      const o = await this.store.getOrder(id);
      if (!o) throw new HttpError(404, 'Order not found.');
      if (!['pending', 'payment_pending'].includes(o.status)) {
        throw new HttpError(409, 'Only unpaid checkouts can be cancelled here. For a paid order, refund it in PayPal.');
      }
      const paypal = this.paypalFor(o);
      if (o.status === 'payment_pending' || o.paypal.captureAttemptedAt) {
        // Money may have moved. Only when PayPal can't be asked (keys gone or rejected) may the
        // owner, after checking the PayPal account, say that nothing was paid.
        if (!(await this._ownerCanDecide(o))) {
          throw new HttpError(
            409,
            o.status === 'payment_pending'
              ? "PayPal is still processing this payment, so it can't be cancelled here. If you don't want the sale, refund it in PayPal once it completes."
              : 'This payment was already sent to PayPal. Wait a few minutes until PayPal confirms or declines it.'
          );
        }
        if (!confirmNotPaid) {
          throw new HttpError(409, "PayPal can't be asked about this payment (the keys it was made with are gone or no longer accepted). Check the order in your PayPal account first.", {
            code: 'CONFIRM_NOT_PAID',
          });
        }
        addLog(o, 'Admin checked the PayPal account and confirmed there was no payment.');
      } else if (paypal.mode !== 'mock' && paypal.enabled && o.paypal.orderId) {
        let data = null;
        try {
          data = await paypal.getOrder(o.paypal.orderId);
        } catch (e) {
          // 404, or keys PayPal no longer accepts: no capture was ever sent, so nothing was charged.
          if (![401, 403, 404].includes(e.status)) throw new HttpError(503, 'PayPal could not be reached to check this order. Try again in a minute.');
        }
        if (data && (data.status === 'APPROVED' || data.status === 'COMPLETED')) {
          throw new HttpError(409, 'The customer has already approved this payment in PayPal, so it will complete automatically. Refund it in PayPal if needed.');
        }
      }
      o.status = 'cancelled';
      addLog(o, 'Cancelled by admin. Tickets returned to stock.');
      await this._releaseLocked(o);
      await this.store.saveOrder(o);
      return o;
    });
  }

  /**
   * The owner found the payment in their PayPal account, but PayPal can't be asked about it
   * (the keys it was made with are gone or rejected): deliver the tickets.
   */
  async confirmPaidByAdmin(id, { confirmPaid = false } = {}) {
    let fulfilledNow = false;
    const order = await this.store.withLock('order-' + id, async () => {
      const o = await this.store.getOrder(id);
      if (!o) throw new HttpError(404, 'Order not found.');
      if (!this._ownerMustDecide(o)) throw new HttpError(409, 'This order does not need a decision from you.');
      if (!(await this._ownerCanDecide(o))) {
        const usable = await this._payPalUsable(this.paypalFor(o));
        if (usable === null) throw new HttpError(503, 'PayPal could not be reached to check this order. Try again in a minute.');
        throw new HttpError(409, 'PayPal can be asked about this order, so the app updates it by itself.');
      }
      if (!confirmPaid) throw new HttpError(409, 'Check the payment in your PayPal account first.', { code: 'CONFIRM_PAID' });
      o.paidAt = nowIso();
      o.status = 'paid';
      addLog(o, 'Admin checked the PayPal account and confirmed the payment was received. Issuing the tickets.');
      await this._fulfillLocked(o);
      await this.store.saveOrder(o);
      fulfilledNow = o.status === 'fulfilled';
      return o;
    });
    if (fulfilledNow) this._afterFulfilled(id);
    return order;
  }

  async markRefunded(id) {
    return this.store.withLock('order-' + id, async () => {
      const o = await this.store.getOrder(id);
      if (!o) throw new HttpError(404, 'Order not found.');
      if (!o.paidAt || !PAID_GROUP.includes(o.status)) throw new HttpError(409, 'Only paid orders can be marked as refunded.');
      if (o.status === 'refunded') return o;
      this._recordRefund(o, { id: 'manual-' + Date.now() }, 'marked by admin');
      if (o.status !== 'refunded') o.status = 'refunded';
      await this.store.saveOrder(o);
      return o;
    });
  }

  async addNote(id, text) {
    const note = cleanText(text, 500);
    if (!note) throw new HttpError(400, 'Write a note first.');
    const o = await this.store.updateOrder(id, (order) => addLog(order, `Note: ${note}`));
    if (!o) throw new HttpError(404, 'Order not found.');
    return o;
  }

  // ---- admin reporting -------------------------------------------------------------------
  _localDate(iso) {
    return dates.inTz(this.tz, new Date(iso)).date;
  }

  /** Sales figures only count orders made in the current payment mode (live sales aren't mixed with tests). */
  _sameMode(o) {
    return this.modeOf(o) === this.mode;
  }

  _net(o) {
    if (o.status === 'reversed') return 0;
    return toCents(o.total) - toCents(o.refundedTotal || '0');
  }

  async overview() {
    const orders = await this.store.listOrders();
    const s = this.settings();
    const today = this.now().date;
    const month = today.slice(0, 7);
    const paid = orders.filter((o) => o.paidAt && PAID_GROUP.includes(o.status) && this._sameMode(o));

    const daily = {};
    for (let d = dates.addDays(today, -29); d <= today; d = dates.addDays(d, 1)) daily[d] = { revenue: 0, tickets: 0, orders: 0 };
    const k = { revenueToday: 0, revenueMonth: 0, revenueAll: 0, ticketsToday: 0, ticketsMonth: 0, ordersToday: 0, ordersMonth: 0, ticketsAll: 0 };
    for (const o of paid) {
      const d = this._localDate(o.paidAt);
      const n = this._net(o);
      const q = o.status === 'refunded' || o.status === 'reversed' ? 0 : o.totalQty;
      k.revenueAll += n;
      k.ticketsAll += q;
      if (d === today) {
        k.revenueToday += n;
        k.ticketsToday += q;
        k.ordersToday++;
      }
      if (d.startsWith(month)) {
        k.revenueMonth += n;
        k.ticketsMonth += q;
        k.ordersMonth++;
      }
      if (daily[d]) {
        daily[d].revenue += n;
        daily[d].tickets += q;
        daily[d].orders++;
      }
    }

    const upcoming = {};
    for (let i = 0; i < 7; i++) upcoming[dates.addDays(today, i)] = 0;
    for (const o of paid) if (o.status === 'fulfilled' && upcoming[o.visitDate] !== undefined) upcoming[o.visitDate] += o.totalQty;

    const stockInfo = await this.stockAdmin(orders);
    // Live orders always count; test orders only while test payments are in use.
    const relevant = orders.filter((o) => this.modeOf(o) === 'live' || this._sameMode(o));
    const attention = relevant.filter((o) => o.status === 'needs_attention').length;
    const emailFailed = relevant.filter((o) => o.status === 'fulfilled' && o.email && o.email.status === 'failed').length;
    const pendingPay = relevant.filter((o) => o.status === 'payment_pending').length;

    const alerts = [];
    const sys = this.systemInfo();
    if (!sys.paymentsEnabled) alerts.push({ level: 'error', text: sys.paymentsDisabledReason, link: 'paypal' });
    if (sys.mode === 'mock') {
      alerts.push({ level: 'warn', text: 'Simulated payments (demo): no money is taken and tickets come from the test folder. Choose test or live payments on the PayPal page.', link: 'paypal' });
    } else if (sys.mode === 'sandbox' && sys.paymentsEnabled) {
      alerts.push({
        level: 'warn',
        text: `Test payments (PayPal Sandbox): tickets come from the test folder ${sys.ticketsDir}, never from your real tickets. Switch to live payments on the PayPal page when you're ready.`,
        link: 'paypal',
      });
    }
    if (!sys.smtpConfigured) alerts.push({ level: 'warn', text: 'Email is not set up (SMTP_HOST). Ticket emails are saved to data/outbox instead of being sent.' });
    if (sys.mode === 'live' && sys.paymentsEnabled && !sys.webhookConfigured) {
      alerts.push({
        level: 'warn',
        text: 'Payment updates from PayPal (webhook) are off. Without them, a buyer who closes the page right after paying waits for the next automatic check, and refunds are not recorded automatically.',
        link: 'paypal',
      });
    } else if (sys.mode === 'sandbox' && sys.paymentsEnabled && !sys.webhookConfigured) {
      alerts.push({ level: 'info', text: 'Recommended: turn on payment updates from PayPal (webhook) so refunds and delayed payments update automatically.', link: 'paypal' });
    }
    if (this.config.isProduction && /localhost|127\.0\.0\.1/.test(this.config.baseUrl)) alerts.push({ level: 'error', text: 'BASE_URL still points to localhost — links in ticket emails will not work.' });
    if (this.config.admin.password.length < 10) alerts.push({ level: 'warn', text: 'Your ADMIN_PASSWORD is short. Use at least 10 characters.' });
    if (attention) alerts.push({ level: 'error', text: `${attention} paid order${attention > 1 ? 's need' : ' needs'} attention.`, link: 'orders?status=attention' });
    if (emailFailed) alerts.push({ level: 'error', text: `${emailFailed} ticket email${emailFailed > 1 ? 's' : ''} failed to send.`, link: 'orders?status=emailfailed' });
    if (pendingPay) alerts.push({ level: 'info', text: `${pendingPay} payment${pendingPay > 1 ? 's are' : ' is'} pending in PayPal.`, link: 'orders?status=pending' });
    for (const t of stockInfo.types) {
      if (t.active && t.availableNow <= s.lowStockThreshold) {
        alerts.push({ level: t.availableNow === 0 ? 'error' : 'warn', text: `${t.name}: ${t.availableNow === 0 ? 'out of stock' : `only ${t.availableNow} left`} in stock.`, link: 'stock' });
      }
      if (t.expired > 0) alerts.push({ level: 'info', text: `${t.name}: ${t.expired} unsold ticket(s) in past date folders.`, link: 'stock' });
    }

    const recent = orders
      .filter((o) => o.paidAt || o.status === 'pending' || o.status === 'payment_pending')
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
      .slice(0, 8)
      .map((o) => this._summary(o));

    const money = (c) => fromCents(c);
    return {
      currency: s.currency,
      today,
      kpis: {
        revenueToday: money(k.revenueToday),
        revenueMonth: money(k.revenueMonth),
        revenueAll: money(k.revenueAll),
        ticketsToday: k.ticketsToday,
        ticketsMonth: k.ticketsMonth,
        ticketsAll: k.ticketsAll,
        ordersToday: k.ordersToday,
        ordersMonth: k.ordersMonth,
        avgOrder: k.ordersMonth ? money(Math.round(k.revenueMonth / k.ordersMonth)) : '0.00',
      },
      daily: Object.entries(daily).map(([date, v]) => ({ date, revenue: money(v.revenue), tickets: v.tickets, orders: v.orders })),
      upcoming: Object.entries(upcoming).map(([date, tickets]) => ({ date, tickets })),
      stock: stockInfo.types.filter((t) => t.active),
      alerts,
      recent,
    };
  }

  _summary(o) {
    return {
      id: o.id,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt || null,
      visitDate: o.visitDate,
      name: o.customer.name,
      email: o.customer.email,
      totalQty: o.totalQty,
      total: o.total,
      currency: o.currency,
      refundedTotal: o.refundedTotal || null,
      emailStatus: (o.email && o.email.status) || 'none',
      items: o.items.map((i) => `${i.qty}× ${i.name}`).join(', '),
      mode: (o.paypal && o.paypal.mode) || 'live',
    };
  }

  _filterOrders(orders, { q = '', status = 'paid', from = '', to = '', dateField = 'created' } = {}) {
    const needle = String(q).trim().toLowerCase();
    return orders
      .filter((o) => {
        switch (status) {
          case 'all':
            break;
          case 'paid':
            if (!(o.paidAt && PAID_GROUP.includes(o.status))) return false;
            break;
          case 'attention':
            if (o.status !== 'needs_attention') return false;
            break;
          case 'emailfailed':
            if (!(o.status === 'fulfilled' && o.email && o.email.status === 'failed')) return false;
            break;
          case 'pending':
            if (!['pending', 'payment_pending'].includes(o.status)) return false;
            break;
          case 'abandoned':
            if (!ABANDONED.includes(o.status)) return false;
            break;
          case 'refunded':
            if (!['refunded', 'reversed'].includes(o.status) && !o.refundedTotal) return false;
            break;
          default:
            if (o.status !== status) return false;
        }
        const d = dateField === 'visit' ? o.visitDate : this._localDate(o.createdAt);
        if (from && d < from) return false;
        if (to && d > to) return false;
        if (needle) {
          const hay = [o.id, o.customer.name, o.customer.email, o.customer.phone, o.paypal && o.paypal.orderId, o.paypal && o.paypal.captureId, o.paypal && o.paypal.payerEmail]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  async listOrdersAdmin(query) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(query.pageSize, 10) || 50));
    const filtered = this._filterOrders(await this.store.listOrders(), query);
    const counted = filtered.filter((o) => this._sameMode(o));
    const totalCents = counted.reduce((a, o) => a + (o.paidAt && PAID_GROUP.includes(o.status) ? this._net(o) : 0), 0);
    const tickets = counted.reduce((a, o) => a + (o.paidAt && ['fulfilled', 'paid', 'needs_attention'].includes(o.status) ? o.totalQty : 0), 0);
    return {
      total: filtered.length,
      page,
      pageSize,
      revenue: fromCents(totalCents),
      tickets,
      currency: this.settings().currency,
      mode: this.paypal.mode,
      orders: filtered.slice((page - 1) * pageSize, page * pageSize).map((o) => this._summary(o)),
    };
  }

  async exportCsv(query) {
    const rows = this._filterOrders(await this.store.listOrders(), query);
    const esc = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Order', 'Status', 'Created', 'Paid', 'Visit date', 'Name', 'Email', 'Phone', 'Tickets', 'Items', 'Total', 'Refunded', 'Currency', 'PayPal order', 'PayPal capture', 'Payer email', 'Email status', 'Payment mode'];
    const lines = [header.join(',')];
    for (const o of rows) {
      lines.push(
        [
          o.id,
          o.status,
          o.createdAt,
          o.paidAt || '',
          o.visitDate,
          o.customer.name,
          o.customer.email,
          o.customer.phone,
          o.totalQty,
          o.items.map((i) => `${i.qty}x ${i.name}`).join(' + '),
          o.total,
          o.refundedTotal || '',
          o.currency,
          (o.paypal && o.paypal.orderId) || '',
          (o.paypal && o.paypal.captureId) || '',
          (o.paypal && o.paypal.payerEmail) || '',
          (o.email && o.email.status) || '',
          (o.paypal && o.paypal.mode) || 'live',
        ]
          .map(esc)
          .join(',')
      );
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  async orderAdmin(id) {
    const o = await this.store.getOrder(id);
    if (!o) throw new HttpError(404, 'Order not found.');
    return {
      ...o,
      downloadUrl: o.downloadToken && o.status === 'fulfilled' ? this.downloadUrl(o) : null,
      tickets: (o.tickets || []).map((t, i) => ({ typeId: t.typeId, original: t.original, name: this.ticketFileName(o, i) })),
      reservation: o.reservation ? { expiresAt: o.reservation.expiresAt, count: (o.reservation.files || []).length } : null,
      // PayPal can't be asked about this order (its keys are gone or rejected): the owner decides.
      paypalUnavailable: await this._ownerCanDecide(o),
    };
  }

  async stockAdmin(ordersArg, folderArg) {
    const folder = this.folderParam(folderArg);
    const stock = this.stockForFolder(folder);
    const s = this.settings();
    const types = s.ticketTypes;
    const counts = await stock.counts(types.map((t) => t.id));
    const today = this.now().date;
    const orders = ordersArg || (await this.store.listOrders());
    const sold = {};
    for (const o of orders) {
      if (this.folderOfMode(this.modeOf(o)) !== folder) continue;
      for (const t of o.tickets || []) sold[t.typeId] = (sold[t.typeId] || 0) + 1;
    }
    return {
      folder,
      activeFolder: this.activeFolder,
      mode: this.mode,
      dir: stock.root,
      lowStockThreshold: s.lowStockThreshold,
      reserved: await stock.countReserved(),
      types: types.map((t) => {
        const c = counts[t.id] || { open: 0, dated: {} };
        const dated = Object.entries(c.dated)
          .map(([date, count]) => ({ date, count, past: date < today }))
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        const future = dated.filter((d) => !d.past).reduce((a, d) => a + d.count, 0);
        return {
          id: t.id,
          name: t.name,
          active: t.active,
          price: t.price,
          open: c.open,
          dated,
          availableNow: c.open + future,
          expired: dated.filter((d) => d.past).reduce((a, d) => a + d.count, 0),
          sold: sold[t.id] || 0,
          folder: `${path.basename(stock.root)}/stock/${t.id}/`,
        };
      }),
    };
  }

  async calendarAdmin(month) {
    if (!dates.isValidMonth(month)) throw new HttpError(400, 'Invalid month.');
    const s = this.settings();
    const now = this.now();
    const orders = await this.store.listOrders();
    const booked = {};
    for (const o of orders) {
      if (o.paidAt && ['fulfilled', 'paid', 'needs_attention'].includes(o.status) && String(o.visitDate).startsWith(month)) {
        booked[o.visitDate] = (booked[o.visitDate] || 0) + o.totalQty;
      }
    }
    const types = this.activeTypes(s);
    const counts = await this.stock.counts(types.map((t) => t.id));
    const days = dates.monthDates(month).map((d) => ({
      date: d,
      past: d < now.date,
      closedDate: s.closedDates.includes(d),
      closedWeekday: s.closedWeekdays.includes(dates.weekday(d)),
      booked: booked[d] || 0,
      available: types.reduce((a, t) => a + Stock.available(counts, t.id, d), 0),
    }));
    return { month, today: now.date, days, closedWeekdays: s.closedWeekdays };
  }

  systemInfo() {
    const c = this.config;
    const now = this.now();
    const pp = this.paypal;
    const keys = this.payments.keys(pp.mode);
    return {
      venueTime: `${now.date} ${now.time}`,
      version: c.version,
      mode: pp.mode,
      paymentsEnabled: pp.enabled,
      paymentsDisabledReason: pp.disabledReason || '',
      webhookConfigured: pp.mode !== 'mock' && !!pp.webhookId,
      webhookUrl: keys.source === 'dashboard' && keys.webhookUrl ? keys.webhookUrl : `${c.baseUrl}/api/paypal/webhook`,
      smtpConfigured: this.mailer.configured,
      smtpHost: this.mailConfig.smtp.host
        ? `${this.mailConfig.smtp.host}:${this.mailConfig.smtp.port}${this.mailConfig.smtp.secure ? ' (SSL)' : ' (STARTTLS)'}`
        : '',
      smtpSource: this.mailConfig.source,
      mailFrom: this.mailConfig.from,
      adminEmail: c.adminEmail,
      baseUrl: c.baseUrl,
      timezone: c.timezone,
      ticketsDir: this.payments.ticketsDir(pp.mode),
      dataDir: c.dataDir,
      production: c.isProduction,
      node: process.version,
      embedOrigins: c.embedOrigins,
      settingsPlace: c.settingsPlace,
    };
  }
}

module.exports = { Booking, HOLDING, PAID_GROUP, ABANDONED };
