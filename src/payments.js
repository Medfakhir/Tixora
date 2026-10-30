'use strict';
/**
 * PayPal settings and the resources of each payment mode.
 *
 * The dashboard's PayPal page saves API keys in data/paypal.json (readable by the app's
 * user only), or in the configured database (bp_documents, name "paypal") when
 * DATABASE_URL is set. For a mode with nothing saved there, keys from .env / the host's
 * environment (PAYPAL_CLIENT_ID etc. for PAYPAL_MODE) are used.
 *
 * Each mode has its own PayPal client and its own ticket folder:
 *   live     TICKETS_DIR          (tickets/)          real tickets
 *   sandbox  SANDBOX_TICKETS_DIR  (tickets-sandbox/)  test tickets
 *   mock     SANDBOX_TICKETS_DIR  (simulated payments on your own computer, test tickets too)
 * An order always uses the folder of the mode it was created in and the PayPal app (client id)
 * it was created with, so switching modes or replacing keys never sends real tickets to a test
 * order, never asks the wrong PayPal app about a payment, and a test payment never touches live
 * stock. Replaced keys are kept (privately) until no open order needs them.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Stock } = require('./stock');
const { DbStock } = require('./dbstock');
const { PayPalClient, MockPayPal } = require('./paypal');
const { HttpError } = require('./http');
const { nowIso, log, logError } = require('./util');

const MODES = ['sandbox', 'live', 'mock'];
const KEY_MODES = ['sandbox', 'live'];
const API_BASE = { live: 'https://api-m.paypal.com', sandbox: 'https://api-m.sandbox.paypal.com' };
// Events the app reacts to (see Booking.handleWebhook). DENIED is the v1 name, DECLINED the v2 one.
const WEBHOOK_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
];
const WEBHOOK_EVENTS_V2 = WEBHOOK_EVENTS.filter((n) => n !== 'PAYMENT.CAPTURE.DENIED');
const KEY_RE = /^[A-Za-z0-9_-]{10,200}$/;
const LABEL = { sandbox: 'Sandbox', live: 'Live' };

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {
    clientId: str(e.clientId, 200),
    clientSecret: str(e.clientSecret, 200),
    webhookId: str(e.webhookId, 100),
    webhookUrl: str(e.webhookUrl, 2048),
    webhookError: str(e.webhookError, 500),
    connectedAt: str(e.connectedAt, 40),
  };
  return out.clientId && out.clientSecret ? out : null;
}

function cleanRetired(list) {
  return (Array.isArray(list) ? list : [])
    .map((e) => {
      const c = cleanEntry(e);
      return c && KEY_MODES.includes(e.mode) ? { ...c, mode: e.mode, retiredAt: str(e.retiredAt, 40) } : null;
    })
    .filter(Boolean)
    .slice(-20);
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    mode: MODES.includes(d.mode) ? d.mode : '',
    sandbox: cleanEntry(d.sandbox),
    live: cleanEntry(d.live),
    // Keys replaced or removed on the dashboard, kept while orders made with them are open.
    retired: cleanRetired(d.retired),
    updatedAt: str(d.updatedAt, 40),
  };
}

function retire(d, mode, entry) {
  if (!entry) return;
  d.retired = (d.retired || []).filter((r) => !(r.mode === mode && r.clientId === entry.clientId));
  d.retired.push({ ...entry, mode, retiredAt: nowIso() });
}

function mask(id) {
  if (!id) return '';
  return id.length <= 12 ? id.slice(0, 3) + '…' : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

const digest = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);

function sameUrl(a, b) {
  return String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();
}

function webhookProblem(e) {
  const name = `${e.ppName || ''} ${e.issue || ''} ${e.message || ''}`;
  if (/WEBHOOK_NUMBER_LIMIT_EXCEEDED/.test(name)) {
    return 'Your PayPal app already has the most webhooks PayPal allows. Delete unused ones on developer.paypal.com (your app → Webhooks), then click Check connection.';
  }
  if (e.status === 0) return 'Could not reach PayPal to set up payment updates. Click Check connection to try again.';
  if (e.status === 401 || e.status === 403) return 'These keys are not allowed to manage webhooks. Check the app on developer.paypal.com, then click Check connection.';
  return `PayPal could not set up payment updates (${e.message}${e.debugId ? `, debug id ${e.debugId}` : ''}). Click Check connection to try again.`;
}

class Payments {
  constructor({ config, store, dbTickets = false }) {
    this.config = config;
    this.store = store;
    // With a database configured, the ticket stock itself lives in bp_tickets
    // (no disk needed, shared by every instance). Otherwise it is files on disk.
    this.dbTickets = !!dbTickets;
    this._clients = new Map(); // mode -> { sig, client }
    this._appClients = new Map(); // "mode|clientId" -> { sig, client } for orders made with other keys
    this._stocks = new Map(); // folder -> Stock | DbStock
    // Called before keys are replaced or removed (Booking links older orders to their keys).
    this.beforeKeysChange = null;
  }

  // ---- saved settings (the file may also be changed by another process of the app) -----
  // Storage (data/paypal.json or the database) is handled by the Store, so a
  // dashboard save and an .env install use exactly the same code path.
  saved() {
    return normalize(this.store.getPaypal());
  }

  // Every change to paypal.json happens under one cross-process lock. connect(), check() and
  // purgeRetired() keep it while they talk to PayPal, so they can't undo each other's work.
  _locked(fn) {
    return this.store.withLock('paypal-settings', fn, { waitMs: 90000 });
  }

  _fresh() {
    return JSON.parse(JSON.stringify(this.saved()));
  }

  async _write(d) {
    d.updatedAt = nowIso();
    await this.store.savePaypal(normalize(d));
    return this.saved();
  }

  async _update(fn) {
    return this._locked(async () => {
      const d = this._fresh();
      await fn(d);
      return this._write(d);
    });
  }

  // ---- modes ---------------------------------------------------------------------------
  get mockAllowed() {
    return !!this.config.mockAllowed;
  }

  get activeMode() {
    const m = this.saved().mode || this.config.paypal.mode;
    return MODES.includes(m) ? m : 'sandbox';
  }

  /** API keys for a mode: saved on the dashboard, otherwise from the environment. */
  keys(mode) {
    const none = { clientId: '', clientSecret: '', webhookId: '', webhookUrl: '', webhookError: '', connectedAt: '', source: '' };
    if (!KEY_MODES.includes(mode)) return none;
    const s = this.saved()[mode];
    if (s) return { ...s, source: 'dashboard' };
    const env = this.config.paypal;
    if (env.mode === mode && env.clientId && env.clientSecret) {
      return { ...none, clientId: env.clientId, clientSecret: env.clientSecret, webhookId: env.webhookId || '', source: 'env' };
    }
    return none;
  }

  apiBase(mode) {
    return this.config.paypal.apiBaseOverride || API_BASE[mode] || API_BASE.sandbox;
  }

  disabledReason(mode) {
    if (mode === 'mock') {
      return this.mockAllowed ? '' : 'Simulated payments only work on your own computer. Choose test (Sandbox) or live payments on the PayPal page.';
    }
    const k = this.keys(mode);
    if (!k.clientId || !k.clientSecret) {
      return `PayPal is not connected yet: add your ${mode === 'live' ? 'live' : 'Sandbox'} API keys on the dashboard's PayPal page.`;
    }
    return '';
  }

  /** The PayPal client for a mode (rebuilt when its keys change). */
  client(mode = this.activeMode) {
    const k = this.keys(mode);
    const reason = this.disabledReason(mode);
    const sig = [mode, k.clientId, digest(k.clientSecret), k.webhookId, this.apiBase(mode), reason].join('|');
    const cached = this._clients.get(mode);
    if (cached && cached.sig === sig) return cached.client;
    let client;
    if (mode === 'mock' && !reason) {
      // Simulated payments live in memory: keep the same instance.
      client = cached && cached.client instanceof MockPayPal ? cached.client : new MockPayPal();
    } else {
      client = new PayPalClient({
        mode,
        clientId: k.clientId,
        clientSecret: k.clientSecret,
        webhookId: k.webhookId,
        apiBase: this.apiBase(mode),
        disabledReason: reason,
      });
    }
    this._clients.set(mode, { sig, client });
    return client;
  }

  /**
   * The PayPal client for an existing order: the app (client id) it was created with, even if
   * the mode's keys were replaced since. If those keys are gone, a disabled client with
   * keysMissing = true (callers must then never treat "not found" as "not paid").
   */
  clientForOrder(mode, clientId) {
    const current = this.client(mode);
    if (!KEY_MODES.includes(mode) || !clientId || current.clientId === clientId) return current;
    const env = this.config.paypal;
    const r =
      this.saved().retired.find((x) => x.mode === mode && x.clientId === clientId) ||
      (env.mode === mode && env.clientId === clientId && env.clientSecret ? { clientId, clientSecret: env.clientSecret, webhookId: env.webhookId || '' } : null);
    const key = `${mode}|${clientId}`;
    const sig = r ? [r.clientId, digest(r.clientSecret), r.webhookId, this.apiBase(mode)].join('|') : 'missing';
    const cached = this._appClients.get(key);
    if (cached && cached.sig === sig) return cached.client;
    const client = new PayPalClient({
      mode,
      clientId,
      clientSecret: r ? r.clientSecret : '',
      webhookId: r ? r.webhookId : '',
      apiBase: this.apiBase(mode),
      disabledReason: r ? '' : `the PayPal ${mode === 'live' ? 'live' : 'Sandbox'} keys this order was made with (${mask(clientId)}) are no longer connected`,
    });
    client.keysMissing = !r;
    this._appClients.set(key, { sig, client });
    return client;
  }

  /** Clients whose webhook may deliver events for a mode: the current keys, then replaced ones. */
  webhookClients(mode) {
    const out = [this.client(mode)];
    for (const r of this.saved().retired) {
      if (r.mode === mode && r.webhookId) out.push(this.clientForOrder(mode, r.clientId));
    }
    return out;
  }

  /**
   * Forget replaced keys no open order needs any more, and delete the webhook made for them.
   * neededApps() returns a Set of "mode|clientId" read fresh from the orders; it is called
   * inside the settings lock. Keys replaced less than an hour ago are always kept, so a
   * checkout started just before the replacement is safe.
   */
  async purgeRetired(neededApps) {
    if (!this.saved().retired.length) return;
    await this._locked(async () => {
      const d = this._fresh();
      const graceMs = this.config.retiredGraceMs === undefined ? 3600000 : this.config.retiredGraceMs;
      const needed = await neededApps();
      const drop = d.retired.filter(
        (r) =>
          !needed.has(`${r.mode}|${r.clientId}`) &&
          Date.now() - (Date.parse(r.retiredAt) || 0) >= graceMs &&
          !(d[r.mode] && d[r.mode].clientId === r.clientId)
      );
      if (!drop.length) return;
      d.retired = d.retired.filter((r) => !drop.includes(r));
      await this._write(d);
      for (const r of drop) {
        log(`Replaced PayPal ${r.mode} keys (${mask(r.clientId)}) forgotten: no open order uses them any more`);
        const cur = d[r.mode];
        if (r.webhookId && r.webhookUrl && !(cur && cur.webhookId === r.webhookId)) {
          await new PayPalClient({ mode: r.mode, clientId: r.clientId, clientSecret: r.clientSecret, apiBase: this.apiBase(r.mode) })
            .deleteWebhook(r.webhookId)
            .catch(() => {});
        }
      }
    });
  }

  ticketsDir(mode) {
    // Simulated payments (demo) share the test folder: they must never use real tickets.
    // With a database, the "folder" is a column value instead of a path.
    if (this.dbTickets) return `bp_tickets/${mode === 'live' ? 'live' : 'sandbox'}`;
    return mode === 'live' ? this.config.liveTicketsDir : this.config.sandboxTicketsDir;
  }

  /** The ticket stock of a mode (one instance per folder; live and demo share one). */
  stock(mode = this.activeMode) {
    const dir = this.ticketsDir(mode);
    let s = this._stocks.get(dir);
    if (!s) {
      const index = typeof this.store.ticketIndex === 'function' ? this.store.ticketIndex() : undefined;
      const lock = (name, fn) => this.store.withLock(name, fn, { waitMs: 90000 });
      if (this.dbTickets) {
        s = new DbStock({ db: this.store.db, folder: mode === 'live' ? 'live' : 'sandbox', lock, index });
      } else {
        const cacheName = dir === this.config.liveTicketsDir ? 'ticket-fingerprints.json' : 'ticket-fingerprints-sandbox.json';
        s = new Stock(dir, this.config.dataDir, { lock, cacheName, index });
        s.ensureTypeDirs(this.store.getSettings().ticketTypes.map((t) => t.id));
      }
      this._stocks.set(dir, s);
    }
    return s;
  }

  /** Ticket folders in use: the active one plus any other that has stock. */
  knownStocks() {
    const out = new Map();
    const active = this.stock();
    out.set(active.root, active);
    for (const m of KEY_MODES) {
      const dir = this.ticketsDir(m);
      if (out.has(dir)) continue;
      if (this.dbTickets || fs.existsSync(path.join(dir, 'stock'))) out.set(dir, this.stock(m));
    }
    return [...out.values()];
  }

  // ---- webhook -------------------------------------------------------------------------
  get publicHttps() {
    try {
      const u = new URL(this.config.baseUrl);
      return u.protocol === 'https:' && !/^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname);
    } catch {
      return false;
    }
  }

  webhookUrl(mode) {
    return `${this.config.baseUrl}/api/paypal/webhook/${mode}`;
  }

  /**
   * Make sure the app has a webhook pointing at this server, subscribed to the events
   * it handles. Updates `entry` (webhookId / webhookUrl / webhookError) and never throws.
   */
  async _ensureWebhook(client, mode, entry) {
    if (!this.publicHttps) {
      entry.webhookError = 'needs-https';
      return;
    }
    const url = this.webhookUrl(mode);
    const withFallback = async (call) => {
      try {
        return await call(WEBHOOK_EVENTS);
      } catch (e) {
        if (e.status !== 400 && e.status !== 422) throw e;
        return call(WEBHOOK_EVENTS_V2); // an event name PayPal doesn't accept for this app
      }
    };
    try {
      const hooks = await client.listWebhooks();
      let hook = hooks.find((w) => sameUrl(w.url, url));
      const ours = !hook && entry.webhookId ? hooks.find((w) => w.id === entry.webhookId) : null;
      if (!hook && ours) {
        // The app's address changed (e.g. a custom domain was added): move our webhook.
        hook = await withFallback((names) => client.updateWebhook(ours.id, { url, eventNames: names }));
      } else if (hook) {
        const names = new Set((hook.event_types || []).map((t) => t.name));
        if (!names.has('*') && WEBHOOK_EVENTS_V2.some((n) => !names.has(n))) {
          await withFallback((list) => client.updateWebhook(hook.id, { eventNames: list }));
        }
      } else {
        hook = await withFallback((names) => client.createWebhook(url, names));
      }
      entry.webhookId = String(hook.id || '');
      entry.webhookUrl = url;
      entry.webhookError = entry.webhookId ? '' : 'PayPal did not return a webhook id. Click Check connection to try again.';
    } catch (e) {
      entry.webhookError = webhookProblem(e);
      logError(`PayPal ${mode} webhook setup failed:`, e.message, e.debugId || '');
    }
  }

  // ---- dashboard actions ---------------------------------------------------------------
  _checkMode(mode) {
    if (!KEY_MODES.includes(mode)) throw new HttpError(400, 'Choose Sandbox or Live.');
  }

  async _verifyKeys(mode, clientId, clientSecret) {
    const probe = new PayPalClient({ mode, clientId, clientSecret, apiBase: this.apiBase(mode) });
    try {
      await probe.token(true);
    } catch (e) {
      if (e.status >= 400 && e.status < 500) {
        throw new HttpError(
          400,
          `PayPal didn't accept these keys. Copy the Client ID and Secret from the ${LABEL[mode]} tab of your app on developer.paypal.com${
            mode === 'live' ? '' : ' (Sandbox keys are different from your live keys)'
          }.`
        );
      }
      throw new HttpError(502, `Could not reach PayPal to check the keys (${e.message}). Try again in a minute.`);
    }
    return probe;
  }

  /** Save new keys for a mode after PayPal accepts them, and set up the webhook. */
  async connect(mode, { clientId, clientSecret } = {}) {
    this._checkMode(mode);
    clientId = String(clientId || '').trim();
    clientSecret = String(clientSecret || '').trim();
    if (!KEY_RE.test(clientId) || !KEY_RE.test(clientSecret) || clientId === clientSecret) {
      throw new HttpError(400, 'Paste the Client ID and the Secret exactly as PayPal shows them.');
    }
    if (this.beforeKeysChange) await this.beforeKeysChange();
    await this._locked(async () => {
      const client = await this._verifyKeys(mode, clientId, clientSecret);
      const d = this._fresh();
      const prev = d[mode];
      const known = prev && prev.clientId === clientId ? prev : d.retired.find((r) => r.mode === mode && r.clientId === clientId);
      const entry = {
        clientId,
        clientSecret,
        connectedAt: nowIso(),
        webhookId: known ? known.webhookId : '',
        webhookUrl: known ? known.webhookUrl : '',
        webhookError: '',
      };
      await this._ensureWebhook(client, mode, entry);
      // Keys of another PayPal app are kept for the orders made with them (see purgeRetired).
      if (prev && prev.clientId !== clientId) retire(d, mode, prev);
      d.retired = d.retired.filter((r) => !(r.mode === mode && r.clientId === clientId));
      d[mode] = entry;
      await this._write(d);
      log(`PayPal ${mode} keys connected on the dashboard${entry.webhookId ? ' (webhook ' + entry.webhookId + ')' : ''}`);
    });
  }

  /** Check the keys still work and repair the webhook if needed. */
  async check(mode) {
    this._checkMode(mode);
    const k = this.keys(mode);
    if (!k.clientId) throw new HttpError(409, `No ${LABEL[mode]} keys are connected.`);
    const client = await this._verifyKeys(mode, k.clientId, k.clientSecret);
    if (k.source !== 'dashboard') return { ok: true };
    await this._locked(async () => {
      const d = this._fresh();
      if (!d[mode] || d[mode].clientId !== k.clientId) return; // replaced meanwhile
      const entry = { ...d[mode] };
      await this._ensureWebhook(client, mode, entry);
      d[mode] = entry;
      await this._write(d);
    });
    return { ok: true };
  }

  /** Remove the keys saved on the dashboard for a mode (not allowed for the mode in use). */
  async disconnect(mode) {
    this._checkMode(mode);
    const prev = this.saved()[mode];
    if (!prev) throw new HttpError(409, 'No keys are saved on the dashboard for this mode.');
    if (mode === this.activeMode) {
      const env = this.config.paypal;
      const fallback = env.mode === mode && env.clientId && env.clientSecret;
      if (!fallback) throw new HttpError(409, 'These keys are in use. Switch to another payment mode first, or connect new keys to replace them.');
    }
    if (this.beforeKeysChange) await this.beforeKeysChange();
    await this._update((d) => {
      retire(d, mode, d[mode]); // kept until no open order made with them needs PayPal
      d[mode] = null;
    });
    log(`PayPal ${mode} keys removed from the dashboard`);
  }

  async saveMode(mode) {
    await this._update((d) => {
      d.mode = mode;
    });
  }

  // ---- status for the dashboard (never includes a secret) ------------------------------
  status() {
    const modes = {};
    for (const m of KEY_MODES) {
      const k = this.keys(m);
      let webhook;
      if (!k.clientId) webhook = { state: 'off' };
      else if (k.source === 'env') {
        webhook = k.webhookId
          ? { state: 'on', url: `${this.config.baseUrl}/api/paypal/webhook` }
          : { state: 'off', message: 'Connect the keys on this page and the webhook is set up automatically.' };
      } else if (k.webhookId) {
        webhook = sameUrl(k.webhookUrl, this.webhookUrl(m))
          ? { state: 'on', url: k.webhookUrl }
          : { state: 'moved', url: k.webhookUrl, message: 'The app has a new address. Click Check connection to move the webhook to it.' };
      } else if (k.webhookError === 'needs-https') {
        webhook = {
          state: 'needs-https',
          message: 'PayPal only sends updates to a public https address. Click Check connection once the app runs at its https address (BASE_URL).',
        };
      } else webhook = { state: 'error', message: k.webhookError || 'Not set up. Click Check connection.' };
      modes[m] = {
        connected: !!k.clientId,
        source: k.source,
        clientId: mask(k.clientId),
        connectedAt: k.connectedAt,
        webhook,
        ticketsDir: this.ticketsDir(m),
        keptForOpenOrders: this.saved().retired.filter((r) => r.mode === m).length,
      };
    }
    const active = this.activeMode;
    return {
      mode: active,
      enabled: !this.disabledReason(active),
      disabledReason: this.disabledReason(active),
      mockAllowed: this.mockAllowed,
      publicHttps: this.publicHttps,
      baseUrl: this.config.baseUrl,
      modes,
    };
  }
}

module.exports = { Payments, WEBHOOK_EVENTS, mask };
