'use strict';
/**
 * HTTP routes: public booking API, ticket downloads, PayPal webhook, admin API.
 */
const path = require('path');
const crypto = require('crypto');
const {
  HttpError,
  readBody,
  readJson,
  send,
  sendJson,
  sendHtml,
  sendFile,
  serializeCookie,
  appendHeader,
  rateLimiter,
  rateKey,
} = require('./http');
const { safeEqual, escapeHtml: e, formatMoney, isEmail, sleep, log, logError } = require('./util');
const { validateSettings, CURRENCIES } = require('./settings');
const { UploadError } = require('./stock');
const dates = require('./dates');

const ADMIN_COOKIE = 'bp_admin';

function install(app, { config, booking, store }) {
  const frameAncestors = config.embedOrigins.length ? `'self' ${config.embedOrigins.join(' ')}` : '*';
  const baseHost = (() => {
    try {
      return new URL(config.baseUrl).host;
    } catch {
      return '';
    }
  })();

  // ---- security headers -----------------------------------------------------------
  app.use((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    const p = req.pathname;
    if (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin')) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    } else {
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      if (p.startsWith('/tickets/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    }
  });

  // Hosts like cPanel/Passenger put idle apps to sleep, which pauses timers. Any request
  // (a visitor, a PayPal webhook or a cron ping to /healthz) also runs the background job when it is due.
  app.use(() => {
    if (Date.now() - booking.lastReconcileAt > config.reconcileIntervalMs) setImmediate(() => booking.reconcile());
  });

  // ---- public booking API ------------------------------------------------------------
  const createLimit = rateLimiter({ windowMs: 10 * 60000, max: 30 });
  const captureLimit = rateLimiter({ windowMs: 10 * 60000, max: 120 });
  const downloadLimit = rateLimiter({ windowMs: 10 * 60000, max: 200 });
  const webhookLimit = rateLimiter({ windowMs: 60000, max: 120 });
  const key = (req) => rateKey(req.ip);

  app.get('/healthz', (req, res) => sendJson(res, 200, { ok: true }));
  app.get('/robots.txt', (req, res) =>
    send(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /tickets/\n', { 'Content-Type': 'text/plain; charset=utf-8' })
  );

  app.get('/api/config', (req, res) => sendJson(res, 200, booking.publicConfig()));

  app.get('/api/availability', async (req, res) => {
    sendJson(res, 200, await booking.availability(String(req.query.month || '')));
  });

  app.post('/api/orders', async (req, res) => {
    if (!createLimit(key(req))) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    const body = await readJson(req);
    sendJson(res, 201, await booking.createOrder(body, { ip: req.ip, userAgent: req.headers['user-agent'] }));
  });

  app.post('/api/orders/:id/capture', async (req, res) => {
    if (!captureLimit(key(req))) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    const body = await readJson(req);
    sendJson(res, 200, await booking.capture(req.params.id, String(body.paypalOrderId || '')));
  });

  app.post('/api/orders/:id/cancel', async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, await booking.cancelByCustomer(req.params.id, String(body.paypalOrderId || '')));
  });

  // ---- ticket download page (link in the email / confirmation screen) -------------------
  app.get('/tickets/:id/:token', async (req, res) => {
    if (!downloadLimit(key(req))) throw new HttpError(429, 'Too many requests. Please wait a moment.');
    const order = await booking.orderForDownload(req.params.id, req.params.token);
    sendHtml(res, 200, downloadPage(order, booking));
  });

  app.get('/tickets/:id/:token/:n', async (req, res) => {
    if (!downloadLimit(key(req))) throw new HttpError(429, 'Too many requests. Please wait a moment.');
    const order = await booking.orderForDownload(req.params.id, req.params.token);
    const n = parseInt(req.params.n, 10);
    if (!(n >= 1 && n <= order.tickets.length)) throw new HttpError(404, 'File not found.');
    await sendFile(req, res, booking.stockFor(order).absolute(order.tickets[n - 1].path), {
      downloadName: booking.ticketFileName(order, n - 1),
      inline: req.query.view === '1',
      cacheControl: 'private, no-store',
    });
  });

  // ---- PayPal webhook -----------------------------------------------------------------
  const WEBHOOK_HEADERS = ['paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time', 'paypal-cert-url', 'paypal-auth-algo'];
  async function handleWebhook(req, res, mode, generic = false) {
    if (!webhookLimit(key(req))) throw new HttpError(429, 'Too many requests.');
    // Reject anything that is clearly not from PayPal before asking PayPal to verify it.
    if (WEBHOOK_HEADERS.some((h) => !req.headers[h])) throw new HttpError(400, 'Missing PayPal signature headers.');
    let certHost = '';
    try {
      const u = new URL(String(req.headers['paypal-cert-url']));
      certHost = u.protocol === 'https:' ? u.hostname : '';
    } catch {}
    if (!(certHost === 'paypal.com' || certHost.endsWith('.paypal.com'))) throw new HttpError(400, 'Invalid PayPal certificate URL.');
    const raw = (await readBody(req, 512 * 1024)).toString('utf8');
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
    // Webhooks that may deliver here: the one of the current keys, those of replaced keys still
    // kept for open orders, and (plain address only) one made by hand (PAYPAL_WEBHOOK_ID).
    const client = booking.payments.client(mode);
    const candidates = mode === 'mock' ? [] : booking.payments.webhookClients(mode).filter((c) => c.enabled && c.webhookId).map((c) => [c, c.webhookId]);
    const envId = config.paypal.mode === mode ? config.paypal.webhookId : '';
    if (generic && client.enabled && envId && !candidates.some(([, id]) => id === envId)) candidates.push([client, envId]);
    if (!candidates.length) {
      // 503 makes PayPal retry later, so nothing is lost while the webhook is being set up.
      throw new HttpError(503, `Webhook not set up for PayPal ${mode}.`);
    }
    // Try each; keys PayPal rejects (e.g. a deleted app) don't stop the others from being tried.
    let verified = false;
    let transient = false;
    for (const [c, id] of candidates) {
      try {
        verified = await c.verifyWebhook(req.headers, raw, id);
        if (verified) break;
      } catch (err) {
        if (!(err.status >= 400 && err.status < 500)) transient = true;
        logError('Webhook verification error:', err.message);
      }
    }
    if (!verified && transient) throw new HttpError(503, 'Could not verify the webhook right now.');
    if (!verified) {
      log(`Rejected PayPal ${mode} webhook with invalid signature`, event && event.event_type);
      throw new HttpError(400, 'Invalid webhook signature.');
    }
    await booking.handleWebhook(event, mode);
    sendJson(res, 200, { ok: true });
  }
  // Webhooks set up from the dashboard have one address per mode. The plain address is for a
  // webhook created by hand (PAYPAL_WEBHOOK_ID) and belongs to the mode in use.
  app.post('/api/paypal/webhook', (req, res) => handleWebhook(req, res, booking.mode, true));
  app.post('/api/paypal/webhook/:mode', (req, res) => {
    const mode = String(req.params.mode);
    if (mode !== 'sandbox' && mode !== 'live') throw new HttpError(404, 'Not found.');
    return handleWebhook(req, res, mode);
  });

  // ---- admin auth ---------------------------------------------------------------------
  const loginLimit = rateLimiter({ windowMs: 15 * 60000, max: 10 });
  const pwFingerprint = crypto.createHash('sha256').update('pw:' + config.admin.password).digest('hex').slice(0, 16);
  const sign = (exp) => crypto.createHmac('sha256', config.sessionSecret).update(`admin|${exp}|${pwFingerprint}`).digest('base64url');
  const validSession = (v) => {
    const [exp, sig] = String(v || '').split('.');
    if (!exp || !sig || !/^\d{10,16}$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(sig, sign(exp));
  };
  const cookieOpts = { httpOnly: true, secure: config.secureCookies, sameSite: 'Strict', path: '/' };

  function requireAdmin(req) {
    if (!config.admin.password) throw new HttpError(503, `The dashboard is disabled until ADMIN_PASSWORD is set in ${config.settingsPlace}.`);
    if (!validSession(req.cookies[ADMIN_COOKIE])) throw new HttpError(401, 'Please log in again.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let originHost = '';
      try {
        originHost = new URL(req.headers.origin).host;
      } catch {}
      const ok = [req.headers.host, req.headers['x-forwarded-host'], baseHost].filter(Boolean).some((h) => String(h).split(',')[0].trim() === originHost);
      if (!ok) throw new HttpError(403, 'Blocked a cross-site request.');
    }
  }
  const admin = (fn) => async (req, res) => {
    requireAdmin(req);
    await fn(req, res);
  };
  // Record an admin action in the activity log (never blocks the response).
  const act = (req, type, msg, orderId) => booking.logActivity({ type, msg, orderId, actor: 'admin', ip: req.ip });

  app.get('/api/admin/me', (req, res) => {
    sendJson(res, 200, {
      enabled: !!config.admin.password,
      loggedIn: !!config.admin.password && validSession(req.cookies[ADMIN_COOKIE]),
      settingsPlace: config.settingsPlace,
    });
  });

  app.post('/api/admin/login', async (req, res) => {
    if (!config.admin.password) throw new HttpError(503, `The dashboard is disabled until ADMIN_PASSWORD is set in ${config.settingsPlace}.`);
    if (!loginLimit(key(req))) throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
    const body = await readJson(req);
    if (!safeEqual(String(body.password || ''), config.admin.password)) {
      await sleep(500);
      log('Admin login failed from', req.ip);
      booking.logActivity({ type: 'auth', actor: 'admin', ip: req.ip, msg: 'Failed dashboard login attempt' });
      throw new HttpError(401, 'Wrong password.');
    }
    const exp = Date.now() + config.admin.sessionHours * 3600000;
    appendHeader(res, 'Set-Cookie', serializeCookie(ADMIN_COOKIE, `${exp}.${sign(exp)}`, { ...cookieOpts, maxAge: config.admin.sessionHours * 3600 }));
    booking.logActivity({ type: 'auth', actor: 'admin', ip: req.ip, msg: 'Dashboard login' });
    sendJson(res, 200, { ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    appendHeader(res, 'Set-Cookie', serializeCookie(ADMIN_COOKIE, '', { ...cookieOpts, maxAge: 0 }));
    booking.logActivity({ type: 'auth', actor: 'admin', ip: req.ip, msg: 'Dashboard logout' });
    sendJson(res, 200, { ok: true });
  });

  // ---- admin API ------------------------------------------------------------------------
  app.get('/api/admin/overview', admin(async (req, res) => sendJson(res, 200, await booking.overview())));
  app.get('/api/admin/system', admin(async (req, res) => sendJson(res, 200, booking.systemInfo())));

  app.get('/api/admin/orders', admin(async (req, res) => sendJson(res, 200, await booking.listOrdersAdmin(req.query))));

  app.get(
    '/api/admin/orders.csv',
    admin(async (req, res) => {
      const csv = await booking.exportCsv(req.query);
      send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-${booking.now().date}.csv"`,
        'Cache-Control': 'no-store',
      });
    })
  );

  app.get('/api/admin/orders/:id', admin(async (req, res) => sendJson(res, 200, await booking.orderAdmin(req.params.id))));

  app.post(
    '/api/admin/orders/:id/resend',
    admin(async (req, res) => {
      const body = await readJson(req);
      const to = String(body.email || '').trim().toLowerCase();
      if (to && !isEmail(to)) throw new HttpError(400, 'That email address is not valid.');
      await booking.sendTicketEmail(req.params.id, { to: to || null, force: true, by: 'admin' });
      act(req, 'order', `Tickets resent for ${req.params.id}${to ? ` to ${to}` : ''}`, req.params.id);
      sendJson(res, 200, await booking.orderAdmin(req.params.id));
    })
  );

  app.post(
    '/api/admin/orders/:id/retry',
    admin(async (req, res) => {
      await booking.retryDelivery(req.params.id, 'admin');
      act(req, 'order', `Delivery retried for ${req.params.id}`, req.params.id);
      sendJson(res, 200, await booking.orderAdmin(req.params.id));
    })
  );

  app.post(
    '/api/admin/orders/:id/cancel',
    admin(async (req, res) => {
      const body = await readJson(req);
      await booking.cancelByAdmin(req.params.id, { confirmNotPaid: body.confirmNotPaid === true });
      act(req, 'order', `Order ${req.params.id} cancelled${body.confirmNotPaid ? ' (tickets released)' : ''}`, req.params.id);
      sendJson(res, 200, await booking.orderAdmin(req.params.id));
    })
  );

  app.post(
    '/api/admin/orders/:id/confirm-paid',
    admin(async (req, res) => {
      const body = await readJson(req);
      await booking.confirmPaidByAdmin(req.params.id, { confirmPaid: body.confirmPaid === true });
      act(req, 'order', `Payment confirmed by hand for ${req.params.id}`, req.params.id);
      sendJson(res, 200, await booking.orderAdmin(req.params.id));
    })
  );

  app.post(
    '/api/admin/orders/:id/refunded',
    admin(async (req, res) => {
      await booking.markRefunded(req.params.id);
      act(req, 'order', `Order ${req.params.id} marked as refunded`, req.params.id);
      sendJson(res, 200, await booking.orderAdmin(req.params.id));
    })
  );

  app.post(
    '/api/admin/orders/:id/note',
    admin(async (req, res) => {
      const body = await readJson(req);
      await booking.addNote(req.params.id, body.text);
      act(req, 'order', `Note added to ${req.params.id}`, req.params.id);
      sendJson(res, 200, await booking.orderAdmin(req.params.id));
    })
  );

  app.get(
    '/api/admin/orders/:id/tickets/:n',
    admin(async (req, res) => {
      const order = await store.getOrder(req.params.id);
      if (!order) throw new HttpError(404, 'Order not found.');
      const n = parseInt(req.params.n, 10);
      if (!(n >= 1 && n <= (order.tickets || []).length)) throw new HttpError(404, 'File not found.');
      await sendFile(req, res, booking.stockFor(order).absolute(order.tickets[n - 1].path), {
        downloadName: booking.ticketFileName(order, n - 1),
        inline: req.query.view === '1',
        cacheControl: 'private, no-store',
      });
    })
  );

  // Ticket stock: ?folder=real|test (default: the folder of the payment mode in use).
  const stockOf = (folder) => booking.stockForFolder(booking.folderParam(folder));
  app.get('/api/admin/stock', admin(async (req, res) => sendJson(res, 200, await booking.stockAdmin(null, req.query.folder))));

  app.get(
    '/api/admin/stock/files',
    admin(async (req, res) => {
      const date = String(req.query.date || '');
      sendJson(res, 200, await stockOf(req.query.folder).listFiles(String(req.query.type || ''), date || null));
    })
  );

  app.post(
    '/api/admin/stock/upload',
    admin(async (req, res) => {
      const typeId = String(req.query.type || '');
      const date = String(req.query.date || '');
      if (!booking.settings().ticketTypes.some((t) => t.id === typeId)) throw new HttpError(400, 'Unknown ticket type.');
      if (date && !dates.isValidYmd(date)) throw new HttpError(400, 'Invalid date.');
      let filename = 'ticket.pdf';
      try {
        filename = decodeURIComponent(String(req.headers['x-filename'] || 'ticket.pdf'));
      } catch {}
      const buf = await readBody(req, 20 * 1024 * 1024);
      try {
        const saved = await stockOf(req.query.folder).addUpload(typeId, date || null, filename, buf);
        act(req, 'stock', `Ticket added to ${booking.folderParam(req.query.folder)} stock: ${saved.name || filename} (${typeId}${date ? ', ' + date : ''})`);
        sendJson(res, 201, { ok: true, ...saved });
      } catch (err) {
        if (err instanceof UploadError) {
          sendJson(res, err.code === 'duplicate' ? 409 : 400, { ok: false, duplicate: err.code === 'duplicate', error: err.message });
          return;
        }
        throw err;
      }
    })
  );

  app.post(
    '/api/admin/stock/remove',
    admin(async (req, res) => {
      const body = await readJson(req);
      try {
        await stockOf(body.folder).removeFile(String(body.type || ''), body.date ? String(body.date) : null, String(body.name || ''));
      } catch (err) {
        if (err instanceof UploadError) throw new HttpError(400, err.message);
        throw err;
      }
      act(req, 'stock', `Ticket removed from ${body.folder === 'test' ? 'test' : 'real'} stock: ${body.name}`);
      sendJson(res, 200, { ok: true });
    })
  );

  app.post(
    '/api/admin/stock/duplicates',
    admin(async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, await stockOf(body.folder).findDuplicates({ fix: !!body.fix }));
    })
  );

  app.get('/api/admin/settings', admin(async (req, res) => sendJson(res, 200, { settings: booking.settings(), currencies: CURRENCIES })));

  app.put(
    '/api/admin/settings',
    admin(async (req, res) => {
      const body = await readJson(req, 256 * 1024);
      const next = validateSettings(body, booking.settings());
      const saved = await store.saveSettings(next);
      for (const st of booking.payments.knownStocks()) {
        st.ensureTypeDirs(saved.ticketTypes.map((t) => t.id));
        st.invalidate();
      }
      act(req, 'settings', 'Business settings saved');
      sendJson(res, 200, { settings: saved, currencies: CURRENCIES });
    })
  );

  app.get('/api/admin/calendar', admin(async (req, res) => sendJson(res, 200, await booking.calendarAdmin(String(req.query.month || '')))));

  app.post(
    '/api/admin/calendar/toggle',
    admin(async (req, res) => {
      const body = await readJson(req);
      const date = String(body.date || '');
      if (!dates.isValidYmd(date)) throw new HttpError(400, 'Invalid date.');
      await store.withLock('settings', async () => {
        const s = booking.settings();
        const set = new Set(s.closedDates);
        const close = body.closed !== undefined ? !!body.closed : !set.has(date);
        if (close) set.add(date);
        else set.delete(date);
        await store.saveSettings({ ...s, closedDates: [...set].sort() });
      });
      act(req, 'calendar', `Date ${date} ${body.closed === undefined ? 'toggled' : body.closed ? 'closed' : 'reopened'} for online sales`);
      sendJson(res, 200, await booking.calendarAdmin(date.slice(0, 7)));
    })
  );

  // ---- PayPal page ---------------------------------------------------------------------------
  const paypalLimit = rateLimiter({ windowMs: 10 * 60000, max: 30 });
  const paypalAction = (fn, label) =>
    admin(async (req, res) => {
      if (!paypalLimit(key(req))) throw new HttpError(429, 'Too many PayPal actions. Wait a few minutes and try again.');
      const body = await readJson(req);
      await fn(body);
      if (label) act(req, 'paypal', typeof label === 'function' ? label(body) : label);
      sendJson(res, 200, await booking.paymentsStatus());
    });
  app.get('/api/admin/paypal', admin(async (req, res) => sendJson(res, 200, await booking.paymentsStatus())));
  app.post(
    '/api/admin/paypal/connect',
    paypalAction(
      (b) => booking.payments.connect(String(b.mode || ''), { clientId: b.clientId, clientSecret: b.clientSecret }),
      (b) => `PayPal ${b.mode} keys connected`
    )
  );
  app.post('/api/admin/paypal/check', paypalAction((b) => booking.payments.check(String(b.mode || '')), (b) => `PayPal ${b.mode} keys checked`));
  app.post('/api/admin/paypal/disconnect', paypalAction((b) => booking.payments.disconnect(String(b.mode || '')), (b) => `PayPal ${b.mode} keys removed`));
  app.post('/api/admin/paypal/mode', paypalAction((b) => booking.switchPaymentMode(String(b.mode || '')), (b) => `Payment mode switched to ${b.mode}`));

  app.post(
    '/api/admin/test-email',
    admin(async (req, res) => {
      const body = await readJson(req);
      sendJson(res, 200, await booking.sendTestEmail(String(body.to || '').trim()));
    })
  );

  // ---- email settings (SMTP + templates) ----------------------------------------------------
  app.get('/api/admin/smtp', admin(async (req, res) => sendJson(res, 200, booking.mailStatus())));

  app.put(
    '/api/admin/smtp',
    admin(async (req, res) => {
      const body = await readJson(req, 64 * 1024);
      sendJson(res, 200, await booking.saveMail(body));
    })
  );

  app.post(
    '/api/admin/smtp/test',
    admin(async (req, res) => {
      let body = {};
      try {
        body = await readJson(req, 64 * 1024);
      } catch {}
      const smtp = body && body.smtp && typeof body.smtp === 'object' && String(body.smtp.host || '').trim() ? body.smtp : null;
      sendJson(res, 200, await booking.testSmtpConnection(smtp));
    })
  );

  app.get('/api/admin/templates', admin(async (req, res) => sendJson(res, 200, booking.mailStatus())));

  app.put(
    '/api/admin/templates',
    admin(async (req, res) => {
      const body = await readJson(req, 256 * 1024);
      sendJson(res, 200, await booking.saveTemplates(body));
    })
  );

  // ---- activity log -------------------------------------------------------------------------
  app.get('/api/admin/activity', admin(async (req, res) => sendJson(res, 200, await booking.listActivity(req.query))));

  // ---- static pages -----------------------------------------------------------------------
  app.static('/admin', path.join(config.root, 'admin'));
  app.static('', path.join(config.root, 'public'), { maxAge: 300 });
}

// ---- server-rendered ticket download page ----------------------------------------------------
function downloadPage(order, booking) {
  const s = booking.settings();
  const base = `/tickets/${order.id}/${order.downloadToken}`;
  const rows = order.tickets
    .map((t, i) => {
      const name = booking.ticketFileName(order, i);
      const item = order.items.find((x) => x.typeId === t.typeId);
      return `<li class="tk"><div><strong>Ticket ${i + 1}</strong><span>${e(item ? item.name : t.typeId)}</span></div>
<div class="act"><a class="btn-view" href="${base}/${i + 1}?view=1" target="_blank" rel="noopener">View</a><a class="btn-dl" href="${base}/${i + 1}" download="${e(name)}">Download</a></div></li>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Your tickets – ${e(order.id)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css"></head>
<body class="dl-page"><main class="dl">
<p class="site">${e(s.siteName)}</p>
<h1>Your tickets</h1>
<p class="lead">${e(dates.formatLong(order.visitDate))}${s.openingHours ? `. ${e(s.openingHours)}` : ''}</p>
<div class="card"><p class="meta">Order ${e(order.id)}: ${order.items.map((i) => `${i.qty} × ${e(i.name)}`).join(', ')}, ${e(formatMoney(order.total, order.currency))}</p>
<ul class="tklist">${rows}</ul></div>
<p class="note">${e(s.ticketInstructions || '')}</p>
${s.supportEmail ? `<p class="note">Need help? Write to <a href="mailto:${e(s.supportEmail)}">${e(s.supportEmail)}</a> and quote order ${e(order.id)}.</p>` : ''}
</main></body></html>`;
}

module.exports = { install };
