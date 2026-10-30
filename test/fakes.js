'use strict';
/**
 * In-process fakes for the tests: a PayPal REST API and an SMTP server.
 */
const http = require('http');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ---------------------------------------------------------------- PayPal
// Accepts several apps (key pairs): { clientId, clientSecret } plus `apps: [{ clientId, clientSecret }]`.
// Each app has its own webhooks (Notifications API) like a real PayPal REST app.
function fakePayPal({ clientId, clientSecret, webhookId, apps = [] }) {
  const orders = new Map();
  const requestIds = new Map(); // PayPal-Request-Id -> cached response
  const allApps = [{ clientId, clientSecret }, ...apps];
  const tokens = new Map(); // access token -> clientId
  const webhooks = new Map(); // clientId -> [{ id, url, event_types }]
  const KNOWN_EVENTS = new Set([
    'CHECKOUT.ORDER.APPROVED',
    'CHECKOUT.ORDER.COMPLETED',
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.DECLINED',
    'PAYMENT.CAPTURE.REFUNDED',
    'PAYMENT.CAPTURE.REVERSED',
  ]);
  const state = {
    orders,
    calls: [],
    captureCalls: 0,
    nextCapture: null, // 'declined' | 'pending' | 'error500' | 'refuse' | 'accepted202' | 'accepted202-none' | 'error500-captured' | 'conflict409'
    failGets: false, // GET order answers 500 (PayPal unreachable)
    rejectEvents: [], // event names this fake refuses when creating webhooks (to test the fallback)
    ordersPerApp: false, // true: an order is only visible to the app (key pair) that created it
    webhookCalls: [],
    webhooks,
    verifyCalls: [],
    lastCreateBody: null,
  };

  function repr(o) {
    return {
      id: o.id,
      status: o.status,
      payer: o.status === 'APPROVED' || o.status === 'COMPLETED' ? { email_address: 'buyer@paypal.test', payer_id: 'PAYER1', name: { given_name: 'Pay', surname: 'Buyer' } } : undefined,
      purchase_units: [
        {
          reference_id: o.body.purchase_units[0].reference_id,
          custom_id: o.body.purchase_units[0].custom_id,
          amount: o.body.purchase_units[0].amount,
          payments: o.capture ? { captures: [o.capture] } : undefined,
        },
      ],
    };
  }

  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg123' });
      res.end(JSON.stringify(obj));
    };
    state.calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const url = req.url;

    if (url === '/v1/oauth2/token' && req.method === 'POST') {
      const app = allApps.find((a) => req.headers.authorization === 'Basic ' + Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64'));
      if (!app || body !== 'grant_type=client_credentials') {
        return send(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      }
      const tok = 'tok_' + crypto.randomBytes(6).toString('hex');
      tokens.set(tok, app.clientId);
      return send(200, { access_token: tok, token_type: 'Bearer', expires_in: 32400 });
    }
    const caller = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!caller) return send(401, { name: 'AUTHENTICATION_FAILURE' });
    state.calls[state.calls.length - 1].app = caller;
    const visible = (o) => o && (!state.ordersPerApp || o.owner === caller);

    // ---- webhooks of the calling app
    if (url.startsWith('/v1/notifications/webhooks')) {
      const list = webhooks.get(caller) || [];
      webhooks.set(caller, list);
      state.webhookCalls.push({ method: req.method, url, app: caller, body });
      const badEvent = (types) => (types || []).some((t) => !KNOWN_EVENTS.has(t.name) || state.rejectEvents.includes(t.name));
      if (url === '/v1/notifications/webhooks' && req.method === 'GET') return send(200, { webhooks: list });
      if (url === '/v1/notifications/webhooks' && req.method === 'POST') {
        const b = JSON.parse(body || '{}');
        if (!/^https:\/\//.test(b.url || '')) return send(400, { name: 'VALIDATION_ERROR', details: [{ field: 'url', issue: 'INVALID_URL' }] });
        if (list.some((w) => w.url === b.url)) return send(400, { name: 'WEBHOOK_URL_ALREADY_EXISTS' });
        if (list.length >= 10) return send(400, { name: 'WEBHOOK_NUMBER_LIMIT_EXCEEDED' });
        if (badEvent(b.event_types)) return send(400, { name: 'VALIDATION_ERROR', details: [{ field: 'event_types', issue: 'INVALID_EVENT_NAME' }] });
        const w = { id: 'WH-' + crypto.randomBytes(5).toString('hex').toUpperCase(), url: b.url, event_types: b.event_types };
        list.push(w);
        return send(201, w);
      }
      const wm = /^\/v1\/notifications\/webhooks\/([^/]+)$/.exec(url);
      const w = wm && list.find((x) => x.id === decodeURIComponent(wm[1]));
      if (!w) return send(404, { name: 'INVALID_RESOURCE_ID' });
      if (req.method === 'PATCH') {
        for (const op of JSON.parse(body || '[]')) {
          if (op.path === '/url') w.url = op.value;
          if (op.path === '/event_types') {
            if (badEvent(op.value)) return send(400, { name: 'VALIDATION_ERROR', details: [{ issue: 'INVALID_EVENT_NAME' }] });
            w.event_types = op.value;
          }
        }
        return send(200, w);
      }
      if (req.method === 'DELETE') {
        list.splice(list.indexOf(w), 1);
        res.writeHead(204);
        return res.end();
      }
    }

    if (url === '/v2/checkout/orders' && req.method === 'POST') {
      const b = JSON.parse(body);
      state.lastCreateBody = b;
      const id = 'PP' + crypto.randomBytes(8).toString('hex').toUpperCase();
      const o = { id, status: 'PAYER_ACTION_REQUIRED', body: b, capture: null, owner: caller };
      orders.set(id, o);
      return send(200, { id, status: o.status, links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=' + id }] });
    }

    let m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url);
    if (m && req.method === 'POST') {
      const rid = req.headers['paypal-request-id'];
      if (rid && requestIds.has(rid)) {
        const c = requestIds.get(rid);
        return send(c.status, c.body);
      }
      const o = orders.get(m[1]);
      if (!visible(o)) return send(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
      const behavior = state.nextCapture;
      state.nextCapture = null;
      let result;
      if (o.status === 'COMPLETED') result = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] } };
      else if (o.status !== 'APPROVED') result = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] } };
      else if (behavior === 'declined') result = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] } };
      else if (behavior === 'refuse') result = { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYEE_ACCOUNT_RESTRICTED' }] } };
      else if (behavior === 'error500') result = { status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } };
      else if (behavior === 'accepted202-none') result = { status: 202, body: { id: o.id, status: 'APPROVED' } };
      else if (behavior === 'conflict409') result = { status: 409, body: { name: 'RESOURCE_CONFLICT', details: [{ issue: 'PREVIOUS_REQUEST_IN_PROGRESS' }] } };
      else {
        state.captureCalls++;
        const amount = o.body.purchase_units[0].amount;
        o.status = 'COMPLETED';
        o.capture = {
          id: 'CAP' + crypto.randomBytes(6).toString('hex').toUpperCase(),
          status: behavior === 'pending' ? 'PENDING' : 'COMPLETED',
          status_details: behavior === 'pending' ? { reason: 'PENDING_REVIEW' } : undefined,
          amount: { currency_code: amount.currency_code, value: amount.value },
          custom_id: o.body.purchase_units[0].custom_id,
          invoice_id: o.body.purchase_units[0].invoice_id,
          supplementary_data: { related_ids: { order_id: o.id } },
        };
        result = { status: 201, body: repr(o) };
        if (behavior === 'accepted202') result = { status: 202, body: { id: o.id, status: 'APPROVED' } }; // captured, but not in the reply
        if (behavior === 'error500-captured') result = { status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } }; // captured, reply lost
      }
      // Like PayPal: a repeated PayPal-Request-Id gets the stored reply for a finished request
      // (success or a definite 4xx refusal). Timeouts, 409 and 5xx are not final: retry with the same id.
      if (rid && (result.status < 300 || (result.status >= 400 && result.status < 500 && result.status !== 409))) requestIds.set(rid, result);
      return send(result.status, result.body);
    }

    m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url);
    if (m && req.method === 'GET') {
      if (state.failGets) return send(500, { name: 'INTERNAL_SERVER_ERROR' });
      const o = orders.get(m[1]);
      if (!visible(o)) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      return send(200, repr(o));
    }

    if (url === '/v1/notifications/verify-webhook-signature' && req.method === 'POST') {
      let b;
      try {
        b = JSON.parse(body);
      } catch {
        return send(400, { name: 'MALFORMED_REQUEST' });
      }
      state.verifyCalls.push({ raw: body, parsed: b });
      const ids = new Set([webhookId, ...[...webhooks.values()].flat().map((w) => w.id)]);
      const ok = !!b.webhook_id && ids.has(b.webhook_id) && b.transmission_sig === 'good' && b.webhook_event && typeof b.webhook_event === 'object';
      return send(200, { verification_status: ok ? 'SUCCESS' : 'FAILURE' });
    }
    send(404, { name: 'NOT_FOUND' });
  });

  return {
    state,
    server,
    approve(id) {
      const o = orders.get(id);
      if (o) o.status = 'APPROVED';
    },
    // Like deleting the app or changing its secret on developer.paypal.com: its keys stop working.
    revoke(id) {
      const i = allApps.findIndex((a) => a.clientId === id);
      if (i >= 0) allApps.splice(i, 1);
      for (const [tok, app] of tokens) if (app === id) tokens.delete(tok);
    },
    restore(app) {
      if (!allApps.some((a) => a.clientId === app.clientId)) allApps.push(app);
    },
    listen() {
      return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------- SMTP
function fakeSmtp({ user, pass, key, cert, implicitTls = false, caps = ['AUTH PLAIN LOGIN', 'STARTTLS', 'SIZE 52428800', '8BITMIME'] }) {
  const messages = [];
  const sessions = [];

  function session(rawSocket) {
    const st = { secure: implicitTls, authed: false, from: null, rcpt: [], inData: false, data: [], authStage: null, authUser: null, commands: [] };
    sessions.push(st);
    let socket = rawSocket;
    let buf = '';
    const write = (s) => socket.write(s + '\r\n');
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (onLine(line) === 'upgrade') return;
      }
    };
    const onLine = (line) => {
      if (st.inData) {
        if (line === '.') {
          st.inData = false;
          messages.push({ from: st.from, to: st.rcpt.slice(), raw: st.data.join('\r\n').replace(/^\.\./gm, '.'), secure: st.secure, authed: st.authed });
          st.data = [];
          st.rcpt = [];
          write('250 2.0.0 OK queued as FAKE' + messages.length);
        } else st.data.push(line);
        return;
      }
      st.commands.push(line.startsWith('AUTH') ? 'AUTH ...' : line);
      if (st.authStage === 'user') {
        st.authUser = Buffer.from(line, 'base64').toString();
        st.authStage = 'pass';
        return write('334 UGFzc3dvcmQ6');
      }
      if (st.authStage === 'pass') {
        st.authStage = null;
        const p = Buffer.from(line, 'base64').toString();
        if (st.authUser === user && p === pass) {
          st.authed = true;
          return write('235 2.7.0 Accepted');
        }
        return write('535 5.7.8 Username and Password not accepted');
      }
      const cmd = line.split(' ')[0].toUpperCase();
      if (cmd === 'EHLO') {
        const list = caps.filter((c) => !(st.secure && c === 'STARTTLS'));
        write('250-fake.smtp at your service' + (list.length ? '' : ''));
        list.forEach((c, idx) => write((idx === list.length - 1 ? '250 ' : '250-') + c));
        if (!list.length) write('250 OK');
      } else if (cmd === 'STARTTLS') {
        write('220 2.0.0 Ready to start TLS');
        socket.removeListener('data', onData);
        const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
        secure.on('data', onData);
        secure.on('error', () => {});
        socket = secure;
        st.secure = true;
        buf = '';
        return 'upgrade';
      } else if (cmd === 'AUTH') {
        const [, mech, arg] = line.split(' ');
        if (mech === 'PLAIN') {
          const parts = Buffer.from(arg || '', 'base64').toString().split('\u0000');
          if (parts[1] === user && parts[2] === pass) {
            st.authed = true;
            write('235 2.7.0 Accepted');
          } else write('535 5.7.8 Username and Password not accepted');
        } else if (mech === 'LOGIN') {
          st.authStage = 'user';
          write('334 VXNlcm5hbWU6');
        } else write('504 Unrecognized authentication type');
      } else if (cmd === 'MAIL') {
        if (user && !st.authed) return write('530 5.7.0 Authentication Required');
        st.from = (/<([^>]*)>/.exec(line) || [])[1];
        write('250 2.1.0 OK');
      } else if (cmd === 'RCPT') {
        st.rcpt.push((/<([^>]*)>/.exec(line) || [])[1]);
        write('250 2.1.5 OK');
      } else if (cmd === 'DATA') {
        st.inData = true;
        write('354 Go ahead');
      } else if (cmd === 'QUIT') {
        write('221 2.0.0 closing connection');
        socket.end();
      } else write('502 5.5.1 Unrecognized command');
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    write('220 fake.smtp ESMTP ready');
  }

  const server = implicitTls ? tls.createServer({ key, cert }, session) : net.createServer(session);
  return {
    messages,
    sessions,
    listen() {
      return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

// ---------------------------------------------------------------- MIME parsing (tests only)
function parseHeaders(head) {
  const out = {};
  head.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach((l) => {
    const i = l.indexOf(':');
    if (i > 0) out[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
  });
  return out;
}

function parseMime(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  const headers = parseHeaders(idx >= 0 ? raw.slice(0, idx) : raw);
  const body = idx >= 0 ? raw.slice(idx + 4) : '';
  const m = /boundary="([^"]+)"/i.exec(headers['content-type'] || '');
  if (!m) return { headers, body };
  const parts = body.split('--' + m[1]).slice(1);
  const out = [];
  for (const p of parts) {
    if (p.startsWith('--')) break;
    out.push(parseMime(p.replace(/^\r\n/, '').replace(/\r\n$/, '')));
  }
  return { headers, parts: out };
}

function flatten(node, list = []) {
  if (node.parts) node.parts.forEach((p) => flatten(p, list));
  else list.push(node);
  return list;
}

function decodeWords(s) {
  return String(s || '').replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
}

module.exports = { fakePayPal, fakeSmtp, parseMime, flatten, decodeWords };
