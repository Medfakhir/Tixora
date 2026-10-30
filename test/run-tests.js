#!/usr/bin/env node
'use strict';
/**
 * End-to-end tests. No dependencies, no network: PayPal and SMTP are faked
 * in-process. Run with:  npm test
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const { fakePayPal, fakeSmtp, parseMime, flatten, decodeWords } = require('./fakes');
const { samplePdf } = require('../scripts/sample-pdf');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-test-'));
const DATA = path.join(TMP, 'data');
const TICKETS = path.join(TMP, 'tickets');
const CLIENT_ID = 'test-client-id';
const SECRET = 'test-secret';
const WEBHOOK_ID = 'WH-TEST-1';
const SMTP_USER = 'mailer@bahia.test';
const SMTP_PASS = 'smtp-pass';
const ADMIN_PW = 'correct horse battery';

let key = null;
let cert = null;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(TMP, 'key.pem'), '-out', path.join(TMP, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  key = fs.readFileSync(path.join(TMP, 'key.pem'));
  cert = fs.readFileSync(path.join(TMP, 'cert.pem'));
} catch {
  console.log('(openssl not found: TLS email tests will be skipped)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipCounter = 1;
const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, e });
    console.log(`  ✗ ${name}\n      ${(e && e.stack) || e}`);
  }
}

/**
 * A tiny in-memory stand-in for Postgres that understands exactly the statements
 * src/dbstore.js runs. Values are kept as the raw strings the real Neon HTTP endpoint
 * would return with raw-text output, so JSON.parse is exercised the same way.
 */
function fakeDb() {
  const docs = new Map();
  const orders = new Map();
  const activity = [];
  const locks = new Map();
  const sold = new Map();
  const tickets = [];
  const one = (o) => ({ rows: o && Object.keys(o).length ? [o] : [], rowCount: 1, fields: [], command: '' });
  const rows = (r) => ({ rows: r, rowCount: r.length, fields: [], command: '' });

  // The statements src/dbstock.js runs against bp_tickets.
  const byName = (a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  function ticketsQuery(q, params) {
    if (q.startsWith('INSERT INTO bp_tickets')) {
      tickets.push({
        id: params[0], folder: params[1], type_id: params[2], valid_date: params[3], status: params[4],
        order_id: null, filename: params[5], mime: params[6], size: params[7], sha256: params[8],
        data: params[9], reserved_at: null, sold_at: null,
      });
      return one({});
    }
    if (/^UPDATE bp_tickets SET status = 'reserved'/.test(q)) {
      const ids = params.slice(2);
      for (const t of tickets) if (t.folder === params[1] && t.status === 'stock' && ids.includes(t.id)) { t.status = 'reserved'; t.order_id = params[0]; t.reserved_at = new Date().toISOString(); }
      return one({});
    }
    if (/^UPDATE bp_tickets SET status = 'stock'/.test(q)) {
      const ids = params.slice(1);
      for (const t of tickets) if (t.folder === params[0] && t.status === 'reserved' && ids.includes(t.id)) { t.status = 'stock'; t.order_id = null; t.reserved_at = null; }
      return one({});
    }
    if (/^UPDATE bp_tickets SET status = 'sold'/.test(q)) {
      const ids = params.slice(2);
      for (const t of tickets) if (t.folder === params[1] && t.status === 'reserved' && ids.includes(t.id)) { t.status = 'sold'; t.order_id = params[0]; t.sold_at = new Date().toISOString(); }
      return one({});
    }
    if (/^DELETE FROM bp_tickets WHERE id = \$1$/.test(q)) {
      for (let i = tickets.length - 1; i >= 0; i--) if (tickets[i].id === params[0]) tickets.splice(i, 1);
      return one({});
    }
    if (/^DELETE FROM bp_tickets WHERE folder = \$1 AND id IN/.test(q)) {
      const ids = params.slice(1);
      for (let i = tickets.length - 1; i >= 0; i--) if (tickets[i].folder === params[0] && ids.includes(tickets[i].id)) tickets.splice(i, 1);
      return one({});
    }
    if (/^SELECT count\(\*\) AS n FROM bp_tickets WHERE folder = \$1 AND status = 'reserved'$/.test(q)) {
      return rows([{ n: tickets.filter((t) => t.folder === params[0] && t.status === 'reserved').length }]);
    }
    if (/^SELECT type_id, valid_date, count\(\*\) AS n FROM bp_tickets/.test(q)) {
      const ids = params.slice(1);
      const map = new Map();
      for (const t of tickets) if (t.folder === params[0] && t.status === 'stock' && ids.includes(t.type_id)) {
        const k = t.type_id + '|' + (t.valid_date || '');
        map.set(k, (map.get(k) || 0) + 1);
      }
      return rows([...map].map(([k, n]) => { const [type_id, vd] = k.split('|'); return { type_id, valid_date: vd || null, n }; }));
    }
    const listFiles = q.match(/^SELECT filename FROM bp_tickets WHERE folder = \$1 AND type_id = \$2 AND status = 'stock' AND valid_date (IS NULL|= \$3) ORDER BY filename$/);
    if (listFiles) {
      const dated = listFiles[1] !== 'IS NULL';
      return rows(tickets.filter((t) => t.folder === params[0] && t.type_id === params[1] && t.status === 'stock' && (dated ? t.valid_date === params[2] : t.valid_date == null)).sort(byName).map((t) => ({ filename: t.filename })));
    }
    const pick = q.match(/^SELECT id, filename, sha256, valid_date FROM bp_tickets WHERE folder = \$1 AND type_id = \$2 AND status = 'stock' AND valid_date (IS NULL|= \$3) ORDER BY filename$/);
    if (pick) {
      const dated = pick[1] !== 'IS NULL';
      return rows(tickets.filter((t) => t.folder === params[0] && t.type_id === params[1] && t.status === 'stock' && (dated ? t.valid_date === params[2] : t.valid_date == null)).sort(byName).map((t) => ({ id: t.id, filename: t.filename, sha256: t.sha256, valid_date: t.valid_date || null })));
    }
    if (/^SELECT id FROM bp_tickets WHERE folder = \$1 AND status = 'reserved' AND id IN/.test(q)) {
      const ids = params.slice(1);
      return rows(tickets.filter((t) => t.folder === params[0] && t.status === 'reserved' && ids.includes(t.id)).map((t) => ({ id: t.id })));
    }
    if (/^SELECT filename, sha256 FROM bp_tickets WHERE id = \$1$/.test(q)) {
      const t = tickets.find((x) => x.id === params[0]);
      return t ? rows([{ filename: t.filename, sha256: t.sha256 }]) : rows([]);
    }
    if (/^SELECT order_id FROM bp_tickets WHERE sha256 = \$1 AND status = 'reserved' LIMIT 1$/.test(q)) {
      const t = tickets.find((x) => x.sha256 === params[0] && x.status === 'reserved');
      return t ? rows([{ order_id: t.order_id }]) : rows([]);
    }
    if (/^SELECT filename FROM bp_tickets WHERE folder = \$1 AND sha256 = \$2 AND status = 'stock' LIMIT 1$/.test(q)) {
      const t = tickets.find((x) => x.folder === params[0] && x.sha256 === params[1] && x.status === 'stock');
      return t ? rows([{ filename: t.filename }]) : rows([]);
    }
    const names = q.match(/^SELECT filename FROM bp_tickets WHERE folder = \$1 AND type_id = \$2 AND status = \$3 AND valid_date (IS NULL|= \$4)$/);
    if (names) {
      const dated = names[1] !== 'IS NULL';
      return rows(tickets.filter((t) => t.folder === params[0] && t.type_id === params[1] && t.status === params[2] && (dated ? t.valid_date === params[3] : t.valid_date == null)).map((t) => ({ filename: t.filename })));
    }
    const removeSel = q.match(/^SELECT id FROM bp_tickets WHERE folder = \$1 AND type_id = \$2 AND filename = \$3 AND status = 'stock' AND valid_date (IS NULL|= \$4) LIMIT 1$/);
    if (removeSel) {
      const dated = removeSel[1] !== 'IS NULL';
      const t = tickets.find((x) => x.folder === params[0] && x.type_id === params[1] && x.filename === params[2] && x.status === 'stock' && (dated ? x.valid_date === params[3] : x.valid_date == null));
      return t ? rows([{ id: t.id }]) : rows([]);
    }
    if (/^SELECT id, filename, sha256 FROM bp_tickets WHERE folder = \$1 AND status = 'stock' ORDER BY filename$/.test(q)) {
      return rows(tickets.filter((t) => t.folder === params[0] && t.status === 'stock').sort(byName).map((t) => ({ id: t.id, filename: t.filename, sha256: t.sha256 })));
    }
    if (/^SELECT id, order_id, reserved_at FROM bp_tickets WHERE folder = \$1 AND status = 'reserved'$/.test(q)) {
      return rows(tickets.filter((t) => t.folder === params[0] && t.status === 'reserved').map((t) => ({ id: t.id, order_id: t.order_id, reserved_at: t.reserved_at })));
    }
    if (/^SELECT filename, mime, size, data FROM bp_tickets WHERE id = \$1$/.test(q)) {
      const t = tickets.find((x) => x.id === params[0]);
      return t ? rows([{ filename: t.filename, mime: t.mime, size: t.size, data: t.data }]) : rows([]);
    }
    if (/^SELECT filename, mime, size FROM bp_tickets WHERE id = \$1$/.test(q)) {
      const t = tickets.find((x) => x.id === params[0]);
      return t ? rows([{ filename: t.filename, mime: t.mime, size: t.size }]) : rows([]);
    }
    throw new Error('fakeDb: unsupported bp_tickets query: ' + q);
  }

  return {
    state: { docs, orders, activity, locks, sold, tickets },
    async query(text, params = []) {
      const q = String(text).replace(/\s+/g, ' ').trim();
      if (/^CREATE TABLE IF NOT EXISTS/i.test(q)) return rows([]);
      if (/^CREATE INDEX IF NOT EXISTS/i.test(q)) return rows([]);
      if (/^SELECT 1 AS ok$/i.test(q)) return rows([{ ok: '1' }]);

      if (/^SELECT name, data FROM bp_documents$/i.test(q)) return rows([...docs.entries()].map(([name, data]) => ({ name, data })));
      if (/^SELECT name FROM bp_documents$/i.test(q)) return rows([...docs.keys()].map((name) => ({ name })));
      if (/^INSERT INTO bp_documents/i.test(q)) { docs.set(params[0], params[1]); return one({}); }

      if (/^SELECT 1 AS x FROM bp_orders WHERE id = \$1 LIMIT 1$/i.test(q)) return orders.has(params[0]) ? rows([{ x: '1' }]) : rows([]);
      if (/^SELECT 1 AS x FROM bp_orders LIMIT 1$/i.test(q)) return orders.size ? rows([{ x: '1' }]) : rows([]);
      if (/^SELECT data FROM bp_orders WHERE id = \$1$/i.test(q)) return orders.has(params[0]) ? rows([{ data: orders.get(params[0]) }]) : rows([]);
      if (/^SELECT data FROM bp_orders$/i.test(q)) return rows([...orders.values()].map((data) => ({ data })));
      if (/^INSERT INTO bp_orders .* DO NOTHING RETURNING id$/i.test(q)) {
        if (orders.has(params[0])) return rows([]);
        orders.set(params[0], params[1]);
        return rows([{ id: params[0] }]);
      }
      if (/^INSERT INTO bp_orders .* DO NOTHING$/i.test(q)) { if (!orders.has(params[0])) orders.set(params[0], params[1]); return one({}); }
      if (/^INSERT INTO bp_orders .* DO UPDATE SET/i.test(q)) { orders.set(params[0], params[1]); return one({}); }
      if (/^DELETE FROM bp_orders WHERE id = \$1$/i.test(q)) { orders.delete(params[0]); return one({}); }

      if (/^SELECT 1 AS x FROM bp_activity LIMIT 1$/i.test(q)) return activity.length ? rows([{ x: '1' }]) : rows([]);
      if (/^SELECT entry FROM bp_activity ORDER BY seq$/i.test(q)) return rows(activity.map((entry) => ({ entry })));
      if (/^INSERT INTO bp_activity/i.test(q)) { activity.push(params[0]); return one({}); }
      if (/^DELETE FROM bp_activity WHERE seq <=/i.test(q)) {
        const max = parseInt(params[0], 10);
        if (activity.length > max) activity.splice(0, activity.length - max);
        return one({});
      }

      if (/^SELECT 1 AS x FROM bp_ticket_sold LIMIT 1$/i.test(q)) return sold.size ? rows([{ x: '1' }]) : rows([]);
      if (/^SELECT order_id FROM bp_ticket_sold WHERE hash = \$1$/i.test(q)) return sold.has(params[0]) ? rows([{ order_id: sold.get(params[0]) }]) : rows([]);
      if (/^INSERT INTO bp_ticket_sold/i.test(q)) { if (!sold.has(params[0])) sold.set(params[0], params[1]); return one({}); }

      if (/^INSERT INTO bp_locks .* RETURNING owner$/i.test(q)) {
        const cur = locks.get(params[0]);
        if (!cur || Date.parse(cur.expires_at) < Date.now()) { locks.set(params[0], { owner: params[1], expires_at: params[2] }); return rows([{ owner: params[1] }]); }
        return rows([]);
      }
      if (/^UPDATE bp_locks SET expires_at = \$3::timestamptz WHERE name = \$1 AND owner = \$2$/i.test(q)) {
        const cur = locks.get(params[0]);
        if (cur && cur.owner === params[1]) cur.expires_at = params[2];
        return one({});
      }
      if (/^DELETE FROM bp_locks WHERE name = \$1 AND owner = \$2$/i.test(q)) {
        const cur = locks.get(params[0]);
        if (cur && cur.owner === params[1]) locks.delete(params[0]);
        return one({});
      }

      if (/bp_tickets/i.test(q)) return ticketsQuery(q, params);
      throw new Error('fakeDb: unsupported query: ' + q);
    },
  };
}

/** Wrap a fakeDb in an HTTP server that speaks Neon's /sql protocol. */
function fakeNeonServer(db) {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => (body += c));
      rq.on('end', async () => {
        try {
          const { query, params } = JSON.parse(body || '{}');
          const out = await db.query(query, params || []);
          const fields = (out.rows[0] ? Object.keys(out.rows[0]) : []).map((name) => ({ name, dataTypeID: 25 }));
          // Real Postgres text output returns bytea as "\x<hex>"; mirror that so
          // DbStock's toBuffer() hex path is what the tests exercise.
          const enc = (v) => (Buffer.isBuffer(v) ? '\\x' + v.toString('hex') : v);
          rs.setHeader('Content-Type', 'application/json');
          rs.end(JSON.stringify({ fields, rows: out.rows.map((row) => Object.values(row).map(enc)), rowCount: out.rows.length, command: 'SELECT' }));
        } catch (e) {
          rs.statusCode = 400;
          rs.setHeader('Content-Type', 'application/json');
          rs.end(JSON.stringify({ message: e.message }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}

async function main() {
  const pp = fakePayPal({ clientId: CLIENT_ID, clientSecret: SECRET, webhookId: WEBHOOK_ID });
  const ppPort = await pp.listen();
  const smtp = key ? fakeSmtp({ user: SMTP_USER, pass: SMTP_PASS, key, cert, implicitTls: true }) : fakeSmtp({ caps: ['SIZE 1000000'] });
  const smtpPort = await smtp.listen();

  Object.assign(process.env, {
    ENV_FILE: path.join(TMP, 'no.env'),
    BOOKING_NO_AUTOSTART: '1',
    NODE_ENV: 'test',
    PAYPAL_MODE: 'sandbox',
    PAYPAL_CLIENT_ID: CLIENT_ID,
    PAYPAL_CLIENT_SECRET: SECRET,
    PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
    PAYPAL_API_BASE: `http://127.0.0.1:${ppPort}`,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: key ? 'true' : 'false',
    SMTP_USER: key ? SMTP_USER : '',
    SMTP_PASS: key ? SMTP_PASS : '',
    SMTP_TLS_REJECT_UNAUTHORIZED: 'false',
    MAIL_FROM: 'Bahia Palace Tickets <tickets@bahia.test>',
    ADMIN_EMAIL: 'owner@bahia.test',
    ADMIN_PASSWORD: ADMIN_PW,
    DATA_DIR: DATA,
    TICKETS_DIR: TICKETS,
    SANDBOX_TICKETS_DIR: TICKETS,
    BASE_URL: 'http://book.test',
    TIMEZONE: 'Africa/Casablanca',
    TRUST_PROXY: '',
  });

  const { createApp } = require('../server.js');
  const dates = require('../src/dates');
  const { parse: parseEnv } = require('../src/env');
  const { smtpSend, buildMessage } = require('../src/mailer');
  const app = createApp();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${app.server.address().port}`;
  const { booking, store } = app;

  // ---------- helpers ----------
  async function req(method, p, { json, headers = {}, raw, cookie, ip, base } = {}) {
    const h = { 'X-Forwarded-For': ip || freshIp(), ...headers };
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    if (raw !== undefined) body = raw;
    if (cookie) h.Cookie = cookie;
    const res = await fetch((base || BASE) + p, { method, headers: h, body, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    let data = null;
    try {
      data = JSON.parse(buf.toString('utf8'));
    } catch {}
    return { status: res.status, data, text: buf.toString('utf8'), buf, headers: res.headers };
  }
  function rawGet(p) {
    return new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: app.server.address().port, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, text: d }));
      });
    });
  }
  const ticketFiles = (dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && /\.(pdf|png|jpe?g)$/i.test(n));
    } catch {
      return [];
    }
  };
  const stockCount = (type, date) => ticketFiles(path.join(TICKETS, 'stock', type, date || '')).length;
  let serial = 0;
  function addStock(type, n, date) {
    const dir = path.join(TICKETS, 'stock', type, date || '');
    fs.mkdirSync(dir, { recursive: true });
    const made = [];
    for (let i = 0; i < n; i++) {
      serial++;
      const name = `T-${type}-${String(serial).padStart(5, '0')}.pdf`;
      fs.writeFileSync(path.join(dir, name), samplePdf({ type, number: `${type}-${serial}`, valid: date || 'any day' }));
      made.push(name);
    }
    app.stock.invalidate();
    return made;
  }
  function emptyStock(type) {
    const dir = path.join(TICKETS, 'stock', type);
    for (const n of ticketFiles(dir)) fs.renameSync(path.join(dir, n), path.join(TMP, 'parked-' + type + '-' + n));
    app.stock.invalidate();
  }
  async function waitFor(fn, ms = 5000, what = 'condition') {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('Timed out waiting for ' + what);
      await sleep(25);
    }
  }
  const today = () => dates.inTz('Africa/Casablanca').date;
  const day = (n) => dates.addDays(today(), n);
  let emailSeq = 0;
  async function createOrder({ date = day(3), adult = 1, child = 0, name = 'Ada Lovelace', email = `buyer${++emailSeq}@example.com`, ip } = {}) {
    const items = [];
    if (adult) items.push({ typeId: 'adult', qty: adult });
    if (child) items.push({ typeId: 'child', qty: child });
    return req('POST', '/api/orders', { json: { date, items, customer: { name, email, phone: '+212 600 000000' } }, ip });
  }
  const capture = (orderId, paypalOrderId) => req('POST', `/api/orders/${orderId}/capture`, { json: { paypalOrderId } });
  async function buy(opts = {}) {
    const c = await createOrder(opts);
    assert.equal(c.status, 201, c.text);
    pp.approve(c.data.paypalOrderId);
    const cap = await capture(c.data.orderId, c.data.paypalOrderId);
    return { c, cap };
  }
  const mailsTo = (addr) => smtp.messages.filter((m) => m.to.includes(addr));
  async function webhook(event, sig = 'good') {
    return req('POST', '/api/paypal/webhook', {
      raw: JSON.stringify(event),
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
        'paypal-transmission-id': 'tx-' + Math.random(),
        'paypal-transmission-sig': sig,
        'paypal-transmission-time': new Date().toISOString(),
      },
    });
  }
  let adminCookie = '';

  addStock('adult', 40);
  addStock('child', 20);

  console.log('\nBooking app tests\n');

  // ---------------------------------------------------------------- config & availability
  await test('public config lists ticket types and PayPal client id (sandbox)', async () => {
    const r = await req('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.data.currency, 'EUR');
    assert.deepEqual(r.data.ticketTypes.map((t) => t.id), ['adult', 'child']);
    assert.equal(r.data.payments.mode, 'sandbox');
    assert.equal(r.data.payments.enabled, true);
    assert.equal(r.data.payments.clientId, CLIENT_ID);
    assert.equal(r.data.today, today());
  });

  await test('availability marks past days, open days and remaining stock', async () => {
    const month = day(5).slice(0, 7);
    const r = await req('GET', '/api/availability?month=' + month);
    assert.equal(r.status, 200);
    assert.equal(r.data.days[day(5)].status, 'open');
    assert.equal(r.data.days[day(5)].remaining.adult, 10); // capped at max per order
    const past = Object.entries(r.data.days).find(([d]) => d < today());
    if (past) assert.equal(past[1].status, 'past');
    const bad = await req('GET', '/api/availability?month=2026-13');
    assert.equal(bad.status, 400);
  });

  // ---------------------------------------------------------------- validation
  await test('order validation rejects bad dates, quantities, emails and types', async () => {
    assert.equal((await createOrder({ date: 'tomorrow' })).status, 400);
    assert.equal((await createOrder({ date: day(-1) })).status, 409);
    assert.equal((await createOrder({ date: day(400) })).status, 409);
    assert.equal((await createOrder({ adult: 0 })).status, 400);
    assert.equal((await createOrder({ adult: 11 })).status, 400);
    assert.equal((await createOrder({ email: 'not-an-email' })).status, 400);
    assert.equal((await createOrder({ name: 'A' })).status, 400);
    const r = await req('POST', '/api/orders', { json: { date: day(3), items: [{ typeId: 'vip', qty: 1 }], customer: { name: 'Ada', email: 'a@b.co' } } });
    assert.equal(r.status, 400);
    const ct = await req('POST', '/api/orders', { raw: 'date=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(ct.status, 415);
  });

  await test('prices come from the server, never from the browser', async () => {
    const r = await req('POST', '/api/orders', {
      json: { date: day(3), items: [{ typeId: 'adult', qty: 2, price: '0.01' }], total: '0.02', customer: { name: 'Eve Tamper', email: 'eve@example.com' } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.total, '24.00');
    const b = pp.state.lastCreateBody;
    assert.equal(b.purchase_units[0].amount.value, '24.00');
    await req('POST', `/api/orders/${r.data.orderId}/cancel`, { json: { paypalOrderId: r.data.paypalOrderId } });
  });

  // ---------------------------------------------------------------- happy path
  let first;
  await test('full purchase: reserve → PayPal → capture → sold folder → email with tickets', async () => {
    const adultBefore = stockCount('adult');
    const childBefore = stockCount('child');
    const c = await createOrder({ adult: 2, child: 1, email: 'ada@example.com' });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.data.total, '30.00');
    assert.equal(stockCount('adult'), adultBefore - 2, 'adult tickets reserved');
    assert.equal(stockCount('child'), childBefore - 1, 'child ticket reserved');
    assert.equal(ticketFiles(path.join(TICKETS, 'reserved', c.data.orderId)).length, 3);

    const body = pp.state.lastCreateBody;
    assert.equal(body.intent, 'CAPTURE');
    const pu = body.purchase_units[0];
    assert.equal(pu.custom_id, c.data.orderId);
    assert.equal(pu.invoice_id, c.data.orderId);
    assert.equal(pu.amount.currency_code, 'EUR');
    assert.equal(pu.amount.value, '30.00');
    assert.equal(pu.amount.breakdown.item_total.value, '30.00');
    assert.deepEqual(pu.items.map((i) => [i.sku, i.quantity, i.unit_amount.value, i.category]), [
      ['adult', '2', '12.00', 'DIGITAL_GOODS'],
      ['child', '1', '6.00', 'DIGITAL_GOODS'],
    ]);
    assert.equal(body.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
    const createCall = pp.state.calls.filter((x) => x.url === '/v2/checkout/orders').pop();
    assert.ok(createCall.headers['paypal-request-id'], 'create uses an idempotency key');

    pp.approve(c.data.paypalOrderId);
    const cap = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(cap.status, 200, cap.text);
    assert.equal(cap.data.status, 'completed');
    assert.equal(cap.data.tickets, 3);
    assert.ok(cap.data.downloadUrl.startsWith('http://book.test/tickets/' + c.data.orderId + '/'));
    const sold = ticketFiles(path.join(TICKETS, 'sold', c.data.orderId));
    assert.equal(sold.length, 3);
    assert.equal(fs.existsSync(path.join(TICKETS, 'reserved', c.data.orderId)), false, 'reserved folder cleaned up');

    const mail = await waitFor(() => mailsTo('ada@example.com')[0], 5000, 'ticket email');
    if (key) assert.ok(mail.secure && mail.authed, 'mail sent over TLS with login');
    const tree = parseMime(mail.raw);
    assert.match(decodeWords(tree.headers.subject), new RegExp('order ' + c.data.orderId));
    const atts = flatten(tree).filter((p) => /attachment/.test(p.headers['content-disposition'] || ''));
    assert.equal(atts.length, 3, 'three ticket attachments');
    const soldBytes = sold.map((n) => fs.readFileSync(path.join(TICKETS, 'sold', c.data.orderId, n)).toString('base64')).sort();
    const attBytes = atts.map((a) => Buffer.from(a.body.replace(/\s+/g, ''), 'base64').toString('base64')).sort();
    assert.deepEqual(attBytes, soldBytes, 'attachments are exactly the sold ticket files');
    const html = flatten(tree).find((p) => /text\/html/.test(p.headers['content-type']));
    const htmlText = Buffer.from(html.body.replace(/\s+/g, ''), 'base64').toString('utf8');
    assert.ok(htmlText.includes(cap.data.downloadUrl), 'email contains the download link');

    await waitFor(() => mailsTo('owner@bahia.test').some((m) => /New sale/.test(decodeWords(parseMime(m.raw).headers.subject))), 5000, 'owner sale email');
    const order = await store.getOrder(c.data.orderId);
    assert.equal(order.status, 'fulfilled');
    assert.equal(order.email.status, 'sent');
    first = { ...c.data, downloadUrl: cap.data.downloadUrl, sold };
  });

  await test('download page and files work with the token, and only with it', async () => {
    const p = new URL(first.downloadUrl).pathname;
    const page = await req('GET', p);
    assert.equal(page.status, 200);
    assert.match(page.text, /Ticket 3/);
    const f = await req('GET', p + '/1');
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'application/pdf');
    assert.match(f.headers.get('content-disposition'), /attachment; filename="Ticket-1-Adult-/);
    assert.equal(f.buf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((await req('GET', p + '/4')).status, 404);
    assert.equal((await req('GET', `/tickets/${first.orderId}/wrongtoken`)).status, 404);
    assert.equal((await req('GET', `/tickets/BP-22222222/${p.split('/').pop()}`)).status, 404);
  });

  await test('capturing again is harmless (idempotent, no second charge)', async () => {
    const before = pp.state.captureCalls;
    const again = await capture(first.orderId, first.paypalOrderId);
    assert.equal(again.data.status, 'completed');
    assert.equal(pp.state.captureCalls, before);
    const wrong = await capture(first.orderId, 'PPWRONG');
    assert.equal(wrong.status, 400);
  });

  await test('five simultaneous captures of one order charge once and email once', async () => {
    const c = await createOrder({ adult: 1, email: 'race@example.com' });
    pp.approve(c.data.paypalOrderId);
    const before = pp.state.captureCalls;
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => capture(c.data.orderId, c.data.paypalOrderId)));
    assert.ok(all.every((r) => r.data.status === 'completed'));
    assert.equal(pp.state.captureCalls, before + 1);
    await waitFor(() => mailsTo('race@example.com').length === 1, 5000, 'one email');
    await sleep(300);
    assert.equal(mailsTo('race@example.com').length, 1);
    assert.equal(ticketFiles(path.join(TICKETS, 'sold', c.data.orderId)).length, 1);
  });

  // ---------------------------------------------------------------- payment problems
  await test('capture before PayPal approval is refused and keeps the reservation', async () => {
    const c = await createOrder({ adult: 1 });
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'error');
    assert.match(r.data.message, /not been charged/);
    const o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'pending');
    assert.equal(o.reservation.files.length, 1);
    await req('POST', `/api/orders/${c.data.orderId}/cancel`, { json: { paypalOrderId: c.data.paypalOrderId } });
  });

  await test('declined card asks the buyer to try again (PayPal restart), then succeeds', async () => {
    const c = await createOrder({ adult: 1, email: 'declined@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'declined';
    const r1 = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r1.data.status, 'restart');
    const r2 = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r2.data.status, 'completed');
  });

  await test('PayPal refusal (e.g. restricted account) reports not charged', async () => {
    const c = await createOrder({ adult: 1 });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'refuse';
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'error');
    assert.match(r.data.message, /not been charged/);
    assert.equal((await store.getOrder(c.data.orderId)).status, 'pending');
  });

  await test('PayPal outage during capture: buyer told "unconfirmed, don\'t pay again", reservation kept', async () => {
    const c = await createOrder({ adult: 1 });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'error500';
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'unconfirmed');
    assert.match(r.data.message, /don't pay again/);
    assert.doesNotMatch(r.data.message, /not been charged/);
    assert.equal((await store.getOrder(c.data.orderId)).status, 'pending');
    // the buyer retries a moment later and it works
    const r2 = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r2.data.status, 'completed');
  });

  await test('pending PayPal payment holds tickets; webhook completion delivers them', async () => {
    const c = await createOrder({ adult: 2, email: 'pending@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'pending';
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'pending');
    let o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'payment_pending');
    assert.equal(o.reservation.files.length, 2);
    const cap = pp.state.orders.get(c.data.paypalOrderId).capture;
    const wh = await webhook({
      id: 'WH-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { ...cap, status: 'COMPLETED' },
    });
    assert.equal(wh.status, 200, wh.text);
    o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'fulfilled');
    await waitFor(() => mailsTo('pending@example.com').length === 1, 5000, 'email after webhook');
    const verify = pp.state.verifyCalls.pop();
    assert.equal(verify.parsed.webhook_event.id, 'WH-1', 'event embedded for verification');
  });

  // ---------------------------------------------------------------- webhooks
  await test('webhooks with a bad signature or bad JSON are rejected', async () => {
    const bad = await webhook({ id: 'X', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: first.orderId } }, 'forged');
    assert.equal(bad.status, 400);
    const junk = await req('POST', '/api/paypal/webhook', { raw: '{not json', headers: { 'Content-Type': 'application/json' } });
    assert.equal(junk.status, 400);
    const unknown = await webhook({ id: 'U', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'BP-ZZZZZZZZ', id: 'CAPX' } });
    assert.equal(unknown.status, 200);
  });

  await test('buyer approves but closes the browser: CHECKOUT.ORDER.APPROVED webhook captures and delivers', async () => {
    const c = await createOrder({ adult: 1, email: 'closed-tab@example.com' });
    pp.approve(c.data.paypalOrderId);
    const wh = await webhook({ id: 'WH-2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: c.data.paypalOrderId, status: 'APPROVED', purchase_units: [{ custom_id: c.data.orderId }] } });
    assert.equal(wh.status, 200);
    assert.equal((await store.getOrder(c.data.orderId)).status, 'fulfilled');
    await waitFor(() => mailsTo('closed-tab@example.com').length === 1, 5000, 'email');
  });

  await test('refund webhook marks the order refunded and disables downloads', async () => {
    const { c, cap } = await buy({ adult: 1, email: 'refund@example.com' });
    assert.equal(cap.data.status, 'completed');
    const o = await store.getOrder(c.data.orderId);
    const wh = await webhook({
      id: 'WH-3',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REF1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '12.00' }, custom_id: c.data.orderId, links: [{ rel: 'up', href: 'https://api/v2/payments/captures/' + o.paypal.captureId }] },
    });
    assert.equal(wh.status, 200);
    const after = await store.getOrder(c.data.orderId);
    assert.equal(after.status, 'refunded');
    assert.equal(after.refundedTotal, '12.00');
    const dl = await req('GET', new URL(cap.data.downloadUrl).pathname);
    assert.equal(dl.status, 410);
    // a repeated delivery of the same event changes nothing
    await webhook({ id: 'WH-3', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REF1', amount: { currency_code: 'EUR', value: '12.00' }, custom_id: c.data.orderId } });
    assert.equal((await store.getOrder(c.data.orderId)).refunds.length, 1);
  });

  // ---------------------------------------------------------------- stock races & expiry
  await test('last tickets: 10 buyers race for 3 tickets, exactly 3 get them', async () => {
    const date = day(20);
    emptyStock('adult');
    addStock('adult', 3, date);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => createOrder({ date, adult: 1, email: `racer${i}@example.com` })));
    const ok = res.filter((r) => r.status === 201);
    const sold = res.filter((r) => r.status === 409);
    assert.equal(ok.length, 3);
    assert.equal(sold.length, 7);
    assert.ok(sold.every((r) => r.data.code === 'SOLD_OUT'));
    const reservedFiles = ok.flatMap((r) => ticketFiles(path.join(TICKETS, 'reserved', r.data.orderId)));
    assert.equal(new Set(reservedFiles).size, 3, 'three different files reserved');
    for (const r of ok) await req('POST', `/api/orders/${r.data.orderId}/cancel`, { json: { paypalOrderId: r.data.paypalOrderId } });
    // while all 3 are reserved, adult shows 0 left for that date (child tickets keep the day open)
    const hold = await createOrder({ date, adult: 3 });
    assert.equal(hold.status, 201);
    const av = await req('GET', '/api/availability?month=' + date.slice(0, 7));
    assert.equal(av.data.days[date].status, 'open');
    assert.equal(av.data.days[date].remaining.adult, 0);
    await req('POST', `/api/orders/${hold.data.orderId}/cancel`, { json: { paypalOrderId: hold.data.paypalOrderId } });
    assert.equal(stockCount('adult', date), 3, 'cancelled checkouts return tickets');
  });

  await test('date-specific tickets are used first, then the any-day pool', async () => {
    const date = day(20); // 3 dated adult tickets exist from the previous test, pool is empty
    addStock('adult', 5); // any-day pool
    const c = await createOrder({ date, adult: 4 });
    assert.equal(c.status, 201, c.text);
    const o = await store.getOrder(c.data.orderId);
    const fromDated = o.reservation.files.filter((f) => f.stockPath.includes(date)).length;
    assert.equal(fromDated, 3);
    assert.equal(o.reservation.files.length, 4);
    await req('POST', `/api/orders/${c.data.orderId}/cancel`, { json: { paypalOrderId: c.data.paypalOrderId } });
    assert.equal(stockCount('adult', date), 3);
    assert.equal(stockCount('adult'), 5);
  });

  await test('abandoned checkout expires and tickets return to stock', async () => {
    addStock('adult', 10);
    const before = stockCount('adult');
    const c = await createOrder({ adult: 2 });
    assert.equal(stockCount('adult'), before - 2);
    await store.updateOrder(c.data.orderId, (o) => {
      o.reservation.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await booking.reconcile();
    const o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'expired');
    assert.equal(stockCount('adult'), before);
    // the buyer comes back late and pays anyway: tickets are reserved again before charging
    pp.approve(c.data.paypalOrderId);
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'completed');
    assert.equal(stockCount('adult'), before - 2);
  });

  await test('expired hold where the buyer approved in PayPal is captured by the background job', async () => {
    const c = await createOrder({ adult: 1, email: 'late@example.com' });
    pp.approve(c.data.paypalOrderId);
    await store.updateOrder(c.data.orderId, (o) => {
      o.reservation.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await booking.reconcile();
    assert.equal((await store.getOrder(c.data.orderId)).status, 'fulfilled');
    await waitFor(() => mailsTo('late@example.com').length === 1, 5000, 'email');
  });

  await test('crash recovery: orphaned reserved tickets go back to stock', async () => {
    const before = stockCount('child');
    const name = ticketFiles(path.join(TICKETS, 'stock', 'child'))[0];
    const dir = path.join(TICKETS, 'reserved', 'BP-22222222');
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(path.join(TICKETS, 'stock', 'child', name), path.join(dir, '001__child__' + name));
    fs.writeFileSync(path.join(dir, '.manifest.json'), JSON.stringify({ orderId: 'BP-22222222', files: [{ typeId: 'child', stockPath: 'child/' + name, reservedPath: 'reserved/BP-22222222/001__child__' + name }] }));
    const old = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(dir, old, old);
    app.stock.invalidate();
    assert.equal(stockCount('child'), before - 1);
    await booking.reconcile();
    assert.equal(stockCount('child'), before);
    assert.equal(fs.existsSync(dir), false);
  });

  // ---------------------------------------------------------------- duplicates
  await test('a ticket that was already sold is never sold again', async () => {
    const soldFile = path.join(TICKETS, 'sold', first.orderId, first.sold[0]);
    emptyStock('adult');
    fs.copyFileSync(soldFile, path.join(TICKETS, 'stock', 'adult', 'AAA-copy-of-sold.pdf'));
    addStock('adult', 1);
    const c = await createOrder({ adult: 1 });
    assert.equal(c.status, 201, c.text);
    const o = await store.getOrder(c.data.orderId);
    assert.ok(!o.reservation.files[0].stockPath.includes('AAA-copy-of-sold'), 'duplicate skipped');
    assert.ok(fs.existsSync(path.join(TICKETS, 'removed', 'duplicates', 'AAA-copy-of-sold.pdf')), 'duplicate parked in removed/duplicates');
    await req('POST', `/api/orders/${c.data.orderId}/cancel`, { json: { paypalOrderId: c.data.paypalOrderId } });
  });

  // ---------------------------------------------------------------- admin
  await test('admin requires login; wrong password is refused; cross-site POST is blocked', async () => {
    assert.equal((await req('GET', '/api/admin/overview')).status, 401);
    const wrong = await req('POST', '/api/admin/login', { json: { password: 'nope' } });
    assert.equal(wrong.status, 401);
    const ok = await req('POST', '/api/admin/login', { json: { password: ADMIN_PW } });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    adminCookie = setCookie.split(';')[0];
    assert.equal((await req('GET', '/api/admin/overview', { cookie: adminCookie })).status, 200);
    const tampered = adminCookie.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
    assert.equal((await req('GET', '/api/admin/overview', { cookie: tampered })).status, 401);
    const csrf = await req('POST', `/api/admin/orders/${first.orderId}/note`, { cookie: adminCookie, json: { text: 'x' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(csrf.status, 403);
  });

  await test('admin overview, order list, search and CSV export', async () => {
    const ov = await req('GET', '/api/admin/overview', { cookie: adminCookie });
    assert.ok(Number(ov.data.kpis.revenueToday) > 0);
    assert.equal(ov.data.daily.length, 30);
    const list = await req('GET', '/api/admin/orders?q=ada@example.com', { cookie: adminCookie });
    assert.ok(list.data.orders.some((o) => o.id === first.orderId));
    const csvBuy = await buy({ adult: 1, name: '=HYPERLINK("http://evil")', email: 'csv@example.com' });
    assert.equal(csvBuy.cap.data.status, 'completed');
    const csv = await req('GET', '/api/admin/orders.csv?status=all', { cookie: adminCookie });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.text, /Order,Status,Created/);
    assert.ok(csv.text.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula is neutralised');
  });

  await test('admin resend to another address, note, and order detail', async () => {
    const r = await req('POST', `/api/admin/orders/${first.orderId}/resend`, { cookie: adminCookie, json: { email: 'other@example.com' } });
    assert.equal(r.status, 200, r.text);
    await waitFor(() => mailsTo('other@example.com').length === 1, 5000, 'resent email');
    const n = await req('POST', `/api/admin/orders/${first.orderId}/note`, { cookie: adminCookie, json: { text: 'Called the customer' } });
    assert.ok(n.data.log.some((l) => l.msg === 'Note: Called the customer'));
    const d = await req('GET', `/api/admin/orders/${first.orderId}`, { cookie: adminCookie });
    assert.equal(d.data.tickets.length, 3);
    const f = await req('GET', `/api/admin/orders/${first.orderId}/tickets/1`, { cookie: adminCookie });
    assert.equal(f.status, 200);
  });

  await test('paid order without stock needs attention, then delivers after upload + retry', async () => {
    addStock('child', 2);
    const c = await createOrder({ adult: 0, child: 1, email: 'attention@example.com' });
    assert.equal(c.status, 201, c.text);
    // simulate the reserved file disappearing and the stock running dry
    const resDir = path.join(TICKETS, 'reserved', c.data.orderId);
    for (const n of ticketFiles(resDir)) fs.renameSync(path.join(resDir, n), path.join(TMP, 'lost-' + n));
    emptyStock('child');
    pp.approve(c.data.paypalOrderId);
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'attention');
    let o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'needs_attention');
    assert.equal(o.attentionKind, 'stock');
    await waitFor(() => mailsTo('owner@bahia.test').some((m) => /needs attention/.test(decodeWords(parseMime(m.raw).headers.subject))), 5000, 'owner alert');
    const up = await req('POST', '/api/admin/stock/upload?type=child', {
      cookie: adminCookie,
      raw: samplePdf({ type: 'child', number: 'UPLOAD-1' }),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('new child ticket.pdf') },
    });
    assert.equal(up.status, 201, up.text);
    const retry = await req('POST', `/api/admin/orders/${c.data.orderId}/retry`, { cookie: adminCookie, json: {} });
    assert.equal(retry.status, 200, retry.text);
    o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'fulfilled');
    await waitFor(() => mailsTo('attention@example.com').length === 1, 5000, 'email after retry');
  });

  await test('admin upload rejects duplicates, fake PDFs and unknown types', async () => {
    const pdf = samplePdf({ type: 'adult', number: 'DUP-1' });
    const h = { 'Content-Type': 'application/octet-stream', 'X-Filename': 'dup.pdf' };
    const a = await req('POST', '/api/admin/stock/upload?type=adult', { cookie: adminCookie, raw: pdf, headers: h });
    assert.equal(a.status, 201, a.text);
    const b = await req('POST', '/api/admin/stock/upload?type=adult', { cookie: adminCookie, raw: pdf, headers: { ...h, 'X-Filename': 'dup-again.pdf' } });
    assert.equal(b.status, 409);
    assert.equal(b.data.duplicate, true);
    const fake = await req('POST', '/api/admin/stock/upload?type=adult', { cookie: adminCookie, raw: Buffer.from('hello'), headers: { ...h, 'X-Filename': 'fake.pdf' } });
    assert.equal(fake.status, 400);
    const exe = await req('POST', '/api/admin/stock/upload?type=adult', { cookie: adminCookie, raw: Buffer.from('MZ'), headers: { ...h, 'X-Filename': 'virus.exe' } });
    assert.equal(exe.status, 400);
    const unknown = await req('POST', '/api/admin/stock/upload?type=vip', { cookie: adminCookie, raw: pdf, headers: h });
    assert.equal(unknown.status, 400);
    const dated = await req('POST', '/api/admin/stock/upload?type=adult&date=' + day(30), { cookie: adminCookie, raw: samplePdf({ number: 'D-1' }), headers: h });
    assert.equal(dated.status, 201);
    assert.equal(stockCount('adult', day(30)), 1);
  });

  await test('admin settings: validation, new ticket type, closing a date', async () => {
    const cur = (await req('GET', '/api/admin/settings', { cookie: adminCookie })).data.settings;
    const bad = await req('PUT', '/api/admin/settings', { cookie: adminCookie, json: { ticketTypes: [{ id: 'adult', name: 'Adult', price: 'free', active: true }] } });
    assert.equal(bad.status, 400);
    const types = cur.ticketTypes.concat([{ name: 'Student', description: 'With student card', price: '8.50', active: true }]);
    const ok = await req('PUT', '/api/admin/settings', { cookie: adminCookie, json: { ticketTypes: types } });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.data.settings.ticketTypes.some((t) => t.id === 'student' && t.price === '8.50'));
    assert.ok(fs.existsSync(path.join(TICKETS, 'stock', 'student')), 'stock folder created');
    const date = day(6);
    const t = await req('POST', '/api/admin/calendar/toggle', { cookie: adminCookie, json: { date } });
    assert.equal(t.status, 200);
    const av = await req('GET', '/api/availability?month=' + date.slice(0, 7));
    assert.equal(av.data.days[date].status, 'closed');
    assert.equal((await createOrder({ date, adult: 1 })).status, 409);
    await req('POST', '/api/admin/calendar/toggle', { cookie: adminCookie, json: { date } });
    const wk = await req('PUT', '/api/admin/settings', { cookie: adminCookie, json: { closedWeekdays: [dates.weekday(day(8))] } });
    assert.equal(wk.status, 200);
    const av2 = await req('GET', '/api/availability?month=' + day(8).slice(0, 7));
    assert.equal(av2.data.days[day(8)].status, 'closed');
    await req('PUT', '/api/admin/settings', { cookie: adminCookie, json: { closedWeekdays: [] } });
  });

  await test('same-day cut-off closes today for online sales', async () => {
    await req('PUT', '/api/admin/settings', { cookie: adminCookie, json: { sameDayCutoff: '00:00' } });
    const av = await req('GET', '/api/availability?month=' + today().slice(0, 7));
    assert.equal(av.data.days[today()].status, 'cutoff');
    const r = await createOrder({ date: today(), adult: 1 });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /today have closed/);
    await req('PUT', '/api/admin/settings', { cookie: adminCookie, json: { sameDayCutoff: '' } });
    const av2 = await req('GET', '/api/availability?month=' + today().slice(0, 7));
    assert.notEqual(av2.data.days[today()].status, 'cutoff');
  });

  await test('admin cancel releases an unpaid order; paid orders cannot be cancelled', async () => {
    const c = await createOrder({ adult: 1 });
    const before = stockCount('adult');
    const r = await req('POST', `/api/admin/orders/${c.data.orderId}/cancel`, { cookie: adminCookie, json: {} });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'cancelled');
    assert.equal(stockCount('adult'), before + 1);
    const paid = await req('POST', `/api/admin/orders/${first.orderId}/cancel`, { cookie: adminCookie, json: {} });
    assert.equal(paid.status, 409);
  });

  await test('duplicate scan finds identical files in stock and can move them out', async () => {
    const pdf = samplePdf({ type: 'child', number: 'TWIN' });
    fs.writeFileSync(path.join(TICKETS, 'stock', 'child', 'twin-a.pdf'), pdf);
    fs.writeFileSync(path.join(TICKETS, 'stock', 'child', 'twin-b.pdf'), pdf);
    const scan = await req('POST', '/api/admin/stock/duplicates', { cookie: adminCookie, json: {} });
    assert.equal(scan.data.duplicates.length, 1);
    const fix = await req('POST', '/api/admin/stock/duplicates', { cookie: adminCookie, json: { fix: true } });
    assert.equal(fix.data.fixed, true);
    assert.equal(fs.existsSync(path.join(TICKETS, 'stock', 'child', 'twin-b.pdf')), false);
  });

  // ---------------------------------------------------------------- fixes from the independent review
  addStock('adult', 60);
  addStock('child', 10);
  await test('a declined card can be retried with another card (fresh PayPal request id each time)', async () => {
    const c = await createOrder({ adult: 1 });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'declined';
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'restart');
    const r2 = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r2.data.status, 'completed');
    const ids = pp.state.calls.filter((x) => x.url.endsWith(`${c.data.paypalOrderId}/capture`)).map((x) => x.headers['paypal-request-id']);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  await test('PayPal accepts the capture without the result in its reply (202): the app looks again', async () => {
    const c = await createOrder({ adult: 1, email: 'accepted@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'accepted202';
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'completed');
  });

  await test('nothing visible after a 202: "unconfirmed", tickets kept, delivered once PayPal finishes', async () => {
    const c = await createOrder({ adult: 1, email: 'slowpaypal@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'accepted202-none';
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'unconfirmed');
    let o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'pending');
    assert.equal(o.reservation.files.length, 1);
    const ppo = pp.state.orders.get(c.data.paypalOrderId);
    ppo.status = 'COMPLETED';
    ppo.capture = { id: 'CAPLATE1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: o.total }, custom_id: o.id };
    await store.updateOrder(o.id, (x) => {
      x.reservation.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await booking.reconcile();
    o = await store.getOrder(c.data.orderId);
    assert.equal(o.status, 'fulfilled');
    await waitFor(() => mailsTo('slowpaypal@example.com').length === 1, 5000, 'email');
  });

  await test('capture reply lost (money taken, PayPal answered 500): checking again delivers without a second charge', async () => {
    const c = await createOrder({ adult: 1, email: 'lostreply@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'error500-captured';
    const before = pp.state.captureCalls;
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'unconfirmed');
    const r2 = await capture(c.data.orderId, c.data.paypalOrderId); // "Check payment status"
    assert.equal(r2.data.status, 'completed');
    assert.equal(pp.state.captureCalls, before + 1, 'captured exactly once');
  });

  await test('a late approval for a date that closed in the meantime is not charged', async () => {
    const date = day(9);
    const c = await createOrder({ date, adult: 1 });
    await store.updateOrder(c.data.orderId, (o) => {
      o.reservation.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await booking.reconcile();
    assert.equal((await store.getOrder(c.data.orderId)).status, 'expired');
    await req('POST', '/api/admin/calendar/toggle', { cookie: adminCookie, json: { date, closed: true } });
    pp.approve(c.data.paypalOrderId);
    const before = pp.state.captureCalls;
    const r = await capture(c.data.orderId, c.data.paypalOrderId);
    assert.equal(r.data.status, 'error');
    assert.match(r.data.message, /no longer available/);
    assert.equal(pp.state.captureCalls, before, 'no capture');
    await req('POST', '/api/admin/calendar/toggle', { cookie: adminCookie, json: { date, closed: false } });
  });

  await test('admin cannot cancel a payment PayPal is still processing; it is delivered when PayPal completes', async () => {
    const c = await createOrder({ adult: 1, email: 'held@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'pending';
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'pending');
    const cancel = await req('POST', `/api/admin/orders/${c.data.orderId}/cancel`, { cookie: adminCookie, json: {} });
    assert.equal(cancel.status, 409);
    pp.state.orders.get(c.data.paypalOrderId).capture.status = 'COMPLETED';
    await store.updateOrder(c.data.orderId, (o) => {
      o.paypal.lastCheckAt = new Date(Date.now() - 16 * 60000).toISOString();
    });
    await booking.reconcile();
    assert.equal((await store.getOrder(c.data.orderId)).status, 'fulfilled');
    await waitFor(() => mailsTo('held@example.com').length === 1, 5000, 'email');
  });

  await test('admin cannot cancel a checkout the buyer has already approved in PayPal', async () => {
    const c = await createOrder({ adult: 1 });
    pp.approve(c.data.paypalOrderId);
    const r = await req('POST', `/api/admin/orders/${c.data.orderId}/cancel`, { cookie: adminCookie, json: {} });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /already approved/);
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'completed');
  });

  await test('PayPal unreachable for hours: an order with a capture in flight is kept, an unpaid one expires', async () => {
    const a = await createOrder({ adult: 1 });
    pp.approve(a.data.paypalOrderId);
    pp.state.nextCapture = 'error500';
    await capture(a.data.orderId, a.data.paypalOrderId);
    const b = await createOrder({ adult: 1 });
    const old = new Date(Date.now() - 4 * 3600000).toISOString();
    for (const id of [a.data.orderId, b.data.orderId]) {
      await store.updateOrder(id, (o) => {
        o.reservation.expiresAt = old;
      });
    }
    pp.state.failGets = true;
    try {
      await booking.reconcile();
    } finally {
      pp.state.failGets = false;
    }
    assert.equal((await store.getOrder(a.data.orderId)).status, 'pending', 'capture in flight: kept');
    assert.equal((await store.getOrder(b.data.orderId)).status, 'expired', 'never paid: expired');
    await waitFor(() => mailsTo('owner@bahia.test').some((m) => /could not be confirmed/.test(decodeWords(parseMime(m.raw).headers.subject))), 5000, 'owner alert');
    await booking.reconcile(); // PayPal is back: the approved order is captured and delivered
    assert.equal((await store.getOrder(a.data.orderId)).status, 'fulfilled');
  });

  await test('a late PayPal payment on an expired order is found and delivered, and the order is never purged', async () => {
    const c = await createOrder({ adult: 1, email: 'latepay@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'error500';
    await capture(c.data.orderId, c.data.paypalOrderId);
    await store.updateOrder(c.data.orderId, async (o) => {
      o.status = 'expired';
      await app.stock.release(o.id, o.reservation.files);
      o.reservation.files = [];
      o.paypal.lastCheckAt = new Date(Date.now() - 31 * 60000).toISOString();
      o.createdAt = new Date(Date.now() - 61 * 86400000).toISOString();
    });
    const ppo = pp.state.orders.get(c.data.paypalOrderId);
    ppo.status = 'COMPLETED';
    ppo.capture = { id: 'CAPLATE2', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '12.00' }, custom_id: c.data.orderId };
    await booking.reconcile();
    const o = await store.getOrder(c.data.orderId);
    assert.ok(o, 'order kept');
    assert.equal(o.status, 'fulfilled');
    await waitFor(() => mailsTo('latepay@example.com').length === 1, 5000, 'email');
  });

  await test('one visitor cannot hold lots of tickets with unfinished checkouts', async () => {
    addStock('adult', 50);
    const ip = '192.0.2.77';
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await createOrder({ adult: 10, ip, email: `hold${i}@example.com` }));
    assert.ok(held.every((r) => r.status === 201), JSON.stringify(held.map((r) => r.status)));
    const fifth = await createOrder({ adult: 1, ip, email: 'hold5@example.com' });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.data.code, 'TOO_MANY_HOLDS');
    const sameEmail = [];
    for (let i = 0; i < 3; i++) sameEmail.push(await createOrder({ adult: 1, email: 'one@example.com' }));
    assert.ok(sameEmail.every((r) => r.status === 201));
    assert.equal((await createOrder({ adult: 1, email: 'one@example.com' })).status, 429);
    for (const r of held.concat(sameEmail)) await req('POST', `/api/orders/${r.data.orderId}/cancel`, { json: { paypalOrderId: r.data.paypalOrderId } });
    assert.equal((await createOrder({ adult: 1, ip, email: 'hold6@example.com' })).status, 201, 'allowed again after cancelling');
  });

  await test('parallel checkouts from one address cannot get past the ticket hold limit', async () => {
    addStock('adult', 160);
    const ip = '192.0.2.88';
    const res = await Promise.all(Array.from({ length: 15 }, (_, i) => createOrder({ adult: 10, ip, email: `par${i}@example.com` })));
    const ok = res.filter((r) => r.status === 201);
    assert.equal(ok.length, 4, `held ${ok.length} orders of 10 tickets`);
    assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 429 && r.data.code === 'TOO_MANY_HOLDS'));
    for (const r of ok) await req('POST', `/api/orders/${r.data.orderId}/cancel`, { json: { paypalOrderId: r.data.paypalOrderId } });
  });

  await test('a client-supplied Passenger header is ignored behind a TCP proxy (no limit bypass)', async () => {
    let limited = false;
    for (let i = 0; i < 13; i++) {
      const r = await req('POST', '/api/admin/login', { json: { password: 'wrong' }, ip: '198.51.100.99', headers: { '!~Passenger-Client-Address': `10.9.${i}.1` } });
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited);
  });

  await test('after a PayPal error the retry reuses the same request id; a 409 conflict means "unconfirmed"', async () => {
    addStock('adult', 5);
    const c = await createOrder({ adult: 1, email: 'sameid@example.com' });
    pp.approve(c.data.paypalOrderId);
    pp.state.nextCapture = 'error500';
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'unconfirmed');
    assert.equal((await capture(c.data.orderId, c.data.paypalOrderId)).data.status, 'completed');
    const ids = pp.state.calls.filter((x) => x.url.endsWith(`${c.data.paypalOrderId}/capture`)).map((x) => x.headers['paypal-request-id']);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    const d = await createOrder({ adult: 1, email: 'conflict@example.com' });
    pp.approve(d.data.paypalOrderId);
    pp.state.nextCapture = 'conflict409';
    const r = await capture(d.data.orderId, d.data.paypalOrderId);
    assert.equal(r.data.status, 'unconfirmed');
    assert.doesNotMatch(r.data.message, /not been charged/);
    assert.equal((await capture(d.data.orderId, d.data.paypalOrderId)).data.status, 'completed');
  });

  await test('PayPal "completed" without capture details, or "already captured" with PayPal unreachable, is never "not charged"', async () => {
    addStock('adult', 5);
    // a) GET says COMPLETED but the capture is missing from the reply
    const a = await createOrder({ adult: 1, email: 'nocap@example.com' });
    pp.approve(a.data.paypalOrderId);
    pp.state.nextCapture = 'error500';
    assert.equal((await capture(a.data.orderId, a.data.paypalOrderId)).data.status, 'unconfirmed');
    const fo = pp.state.orders.get(a.data.paypalOrderId);
    fo.status = 'COMPLETED';
    const ra = await capture(a.data.orderId, a.data.paypalOrderId);
    assert.equal(ra.status, 200);
    assert.equal(ra.data.status, 'unconfirmed');
    assert.doesNotMatch(ra.data.message, /not been charged/);
    fo.status = 'APPROVED';
    assert.equal((await capture(a.data.orderId, a.data.paypalOrderId)).data.status, 'completed');
    // b) captured elsewhere; our capture gets ORDER_ALREADY_CAPTURED and the follow-up lookup fails
    const b = await createOrder({ adult: 1, email: 'already@example.com' });
    pp.approve(b.data.paypalOrderId);
    pp.state.nextCapture = 'error500-captured';
    await app.paypal.captureOrder(b.data.paypalOrderId, 'outside-1').catch(() => {});
    pp.state.failGets = true;
    let rb;
    try {
      rb = await capture(b.data.orderId, b.data.paypalOrderId);
    } finally {
      pp.state.failGets = false;
    }
    assert.equal(rb.status, 200);
    assert.equal(rb.data.status, 'unconfirmed');
    assert.equal((await capture(b.data.orderId, b.data.paypalOrderId)).data.status, 'completed');
  });

  await test('webhook calls without PayPal headers or with a foreign certificate URL are rejected locally', async () => {
    const before = pp.state.verifyCalls.length;
    const bare = await req('POST', '/api/paypal/webhook', { raw: JSON.stringify({ event_type: 'X' }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(bare.status, 400);
    const foreign = await req('POST', '/api/paypal/webhook', {
      raw: JSON.stringify({ event_type: 'X' }),
      headers: {
        'Content-Type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://evil.example/cert',
        'paypal-transmission-id': '1',
        'paypal-transmission-sig': 'good',
        'paypal-transmission-time': new Date().toISOString(),
      },
    });
    assert.equal(foreign.status, 400);
    assert.equal(pp.state.verifyCalls.length, before, 'PayPal was not asked to verify');
  });

  await test('visitors behind cPanel/Passenger (Unix socket) are told apart; IPv6 grouped per /64', async () => {
    const { App, rateKey } = require('../src/http');
    const a = new App({ trustProxy: 'auto' });
    a.get('/ip', (rq, rs) => rs.end(rq.ip));
    const sockPath = path.join(TMP, 'app.sock');
    const srv = http.createServer(a.handler());
    await new Promise((r) => srv.listen(sockPath, r));
    const ask = (headers) =>
      new Promise((resolve) => {
        const rq = http.request({ socketPath: sockPath, path: '/ip', headers }, (rs) => {
          let d = '';
          rs.on('data', (ch) => (d += ch));
          rs.on('end', () => resolve(d));
        });
        rq.end();
      });
    assert.equal(await ask({ 'X-Forwarded-For': '198.51.100.1' }), '198.51.100.1');
    assert.equal(await ask({ 'X-Forwarded-For': '203.0.113.9' }), '203.0.113.9');
    assert.equal(await ask({ '!~Passenger-Client-Address': '198.51.100.44', 'X-Forwarded-For': '6.6.6.6' }), '198.51.100.44');
    srv.close();
    assert.equal(rateKey('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
    assert.equal(rateKey('2001:db8:abcd:12::9'), '2001:db8:abcd:12::/64');
    assert.equal(rateKey('::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(rateKey('203.0.113.5'), '203.0.113.5');
  });

  // ---------- PayPal page: keys, webhook, test/live switch (a second app with its own folders) ----------
  const SB = { clientId: 'SB-client-0123456789', clientSecret: 'SB-secret-0123456789' };
  const LV = { clientId: 'LV-client-0123456789', clientSecret: 'LV-secret-0123456789' };
  const SB2 = { clientId: 'SB2-client-0123456789', clientSecret: 'SB2-secret-0123456789' };
  const pp2 = fakePayPal({ ...SB, webhookId: '', apps: [LV, SB2] });
  const pp2Port = await pp2.listen();
  const T2 = path.join(TMP, 'pp2');
  const baseConfig = require('../src/config');
  const cfg2 = {
    ...baseConfig,
    dataDir: path.join(T2, 'data'),
    liveTicketsDir: path.join(T2, 'tickets'),
    sandboxTicketsDir: path.join(T2, 'tickets-sandbox'),
    ticketsDir: path.join(T2, 'tickets-sandbox'),
    baseUrl: 'https://book.example.com',
    mockAllowed: false,
    retiredGraceMs: 0, // forget replaced keys as soon as no order needs them (normally after an hour)
    paypal: { ...baseConfig.paypal, mode: 'sandbox', clientId: '', clientSecret: '', webhookId: '', disabledReason: '', apiBaseOverride: `http://127.0.0.1:${pp2Port}` },
  };
  fs.mkdirSync(cfg2.dataDir, { recursive: true });
  const app2 = createApp(cfg2);
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const BASE2 = `http://127.0.0.1:${app2.server.address().port}`;
  const r2 = (method, p, opts = {}) => req(method, p, { ...opts, base: BASE2 });
  let cookie2 = '';
  const put2 = (dir, prefix, n) => {
    const d = path.join(dir, 'stock', 'adult');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `${prefix}-${i}.pdf`), samplePdf({ type: 'adult', number: `${prefix}-${i}` }));
    app2.payments.stock('sandbox').invalidate();
    app2.payments.stock('live').invalidate();
  };
  const order2 = (email, mode) =>
    r2('POST', '/api/orders', { json: { date: day(4), items: [{ typeId: 'adult', qty: 1 }], customer: { name: 'Mode Tester', email }, mode } });
  const paypal2 = (action, body) => r2('POST', `/api/admin/paypal/${action}`, { cookie: cookie2, json: body });

  await test('the PayPal page saves keys only after PayPal accepts them, sets up the webhook, and never shows the secret', async () => {
    assert.equal((await r2('GET', '/api/admin/paypal')).status, 401);
    const login = await r2('POST', '/api/admin/login', { json: { password: ADMIN_PW } });
    cookie2 = login.headers.get('set-cookie').split(';')[0];
    let st = await r2('GET', '/api/admin/paypal', { cookie: cookie2 });
    assert.equal(st.data.mode, 'sandbox');
    assert.equal(st.data.enabled, false);
    assert.equal((await r2('GET', '/api/config')).data.payments.enabled, false);

    const wrong = await paypal2('connect', { mode: 'sandbox', clientId: SB.clientId, clientSecret: 'not-the-secret-123' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.data.error, /didn't accept/);
    assert.equal((await paypal2('connect', { mode: 'sandbox', clientId: 'x', clientSecret: 'y' })).status, 400);
    assert.equal((await paypal2('connect', { mode: 'other', ...SB })).status, 400);

    const ok = await paypal2('connect', { mode: 'sandbox', ...SB });
    assert.equal(ok.status, 200, ok.text);
    const sb = ok.data.modes.sandbox;
    assert.equal(sb.connected, true);
    assert.equal(sb.source, 'dashboard');
    assert.notEqual(sb.clientId, SB.clientId);
    assert.doesNotMatch(ok.text, new RegExp(SB.clientSecret));
    assert.equal(sb.webhook.state, 'on');
    const hooks = pp2.state.webhooks.get(SB.clientId);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].url, 'https://book.example.com/api/paypal/webhook/sandbox');
    assert.ok(hooks[0].event_types.some((t) => t.name === 'CHECKOUT.ORDER.APPROVED'));
    assert.equal(fs.statSync(path.join(cfg2.dataDir, 'paypal.json')).mode & 0o777, 0o600);
    const cfgPage = (await r2('GET', '/api/config')).data.payments;
    assert.deepEqual([cfgPage.enabled, cfgPage.mode, cfgPage.clientId], [true, 'sandbox', SB.clientId]);
    // connecting the same keys again reuses the webhook
    assert.equal((await paypal2('connect', { mode: 'sandbox', ...SB })).status, 200);
    assert.equal(pp2.state.webhooks.get(SB.clientId).length, 1);
  });

  await test('if PayPal refuses one event name, the webhook is still set up with the others', async () => {
    pp2.state.rejectEvents = ['PAYMENT.CAPTURE.DENIED'];
    try {
      const r = await paypal2('connect', { mode: 'live', ...LV });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.modes.live.webhook.state, 'on');
      const names = pp2.state.webhooks.get(LV.clientId)[0].event_types.map((t) => t.name);
      assert.ok(names.includes('PAYMENT.CAPTURE.COMPLETED') && !names.includes('PAYMENT.CAPTURE.DENIED'));
    } finally {
      pp2.state.rejectEvents = [];
    }
  });

  await test('after switching to live, a test order still gets test tickets and live orders get real ones', async () => {
    put2(cfg2.sandboxTicketsDir, 'TEST', 4);
    put2(cfg2.liveTicketsDir, 'REAL', 4);
    const a = await order2('test-buyer@example.com', 'sandbox');
    assert.equal(a.status, 201, a.text);
    const sw = await paypal2('mode', { mode: 'live' });
    assert.equal(sw.status, 200, sw.text);
    assert.equal(sw.data.mode, 'live');
    const cfgPage = (await r2('GET', '/api/config')).data.payments;
    assert.deepEqual([cfgPage.mode, cfgPage.clientId], ['live', LV.clientId]);
    // a booking page still showing test payments is asked to reload
    const stale = await order2('stale@example.com', 'sandbox');
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'MODE_CHANGED');

    // the test buyer finishes paying: tickets come from the test folder only
    pp2.approve(a.data.paypalOrderId);
    const capA = await r2('POST', `/api/orders/${a.data.orderId}/capture`, { json: { paypalOrderId: a.data.paypalOrderId } });
    assert.equal(capA.data.status, 'completed', capA.text);
    const oa = await app2.store.getOrder(a.data.orderId);
    assert.equal(oa.paypal.mode, 'sandbox');
    assert.match(oa.tickets[0].path, /TEST-/);
    assert.equal(ticketFiles(path.join(cfg2.liveTicketsDir, 'stock', 'adult')).length, 4, 'no real ticket used');
    const dl = await r2('GET', `/tickets/${oa.id}/${oa.downloadToken}/1`);
    assert.equal(dl.status, 200);

    const b = await order2('real-buyer@example.com', 'live');
    assert.equal(b.status, 201, b.text);
    pp2.approve(b.data.paypalOrderId);
    const capB = await r2('POST', `/api/orders/${b.data.orderId}/capture`, { json: { paypalOrderId: b.data.paypalOrderId } });
    assert.equal(capB.data.status, 'completed', capB.text);
    const ob = await app2.store.getOrder(b.data.orderId);
    assert.equal(ob.paypal.mode, 'live');
    assert.match(ob.tickets[0].path, /REAL-/);
    assert.equal(ticketFiles(path.join(cfg2.sandboxTicketsDir, 'stock', 'adult')).length, 3, 'test folder untouched by the live sale');
    const list = await r2('GET', '/api/admin/orders?status=all', { cookie: cookie2 });
    assert.equal(list.data.total, 2);
    assert.equal(list.data.tickets, 1, 'sales figures count live orders only');
  });

  await test('webhooks only act on orders of the mode they were set up for', async () => {
    const ob = (await app2.store.listOrders()).find((o) => o.paypal.mode === 'live' && o.status === 'fulfilled');
    const refund = {
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'RF-1', status: 'COMPLETED', amount: { value: ob.total, currency_code: ob.currency }, custom_id: ob.id, invoice_id: ob.id },
    };
    const send = (p) =>
      r2('POST', p, {
        raw: JSON.stringify(refund),
        headers: {
          'Content-Type': 'application/json',
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://api.paypal.com/cert.pem',
          'paypal-transmission-id': 'tid-' + Math.random(),
          'paypal-transmission-sig': 'good',
          'paypal-transmission-time': new Date().toISOString(),
        },
      });
    assert.equal((await send('/api/paypal/webhook/sandbox')).status, 200);
    assert.notEqual((await app2.store.getOrder(ob.id)).status, 'refunded', 'a sandbox event cannot touch a live order');
    assert.equal((await send('/api/paypal/webhook/live')).status, 200);
    assert.equal((await app2.store.getOrder(ob.id)).status, 'refunded');
    assert.equal((await send('/api/paypal/webhook/other')).status, 404);
  });

  await test('leaving live waits for live orders in progress; keys in use cannot be removed', async () => {
    const c = await order2('busy@example.com', 'live');
    assert.equal(c.status, 201, c.text);
    const blocked = await paypal2('mode', { mode: 'sandbox' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'LIVE_ORDERS_OPEN');
    assert.equal((await paypal2('disconnect', { mode: 'live' })).status, 409, 'live keys are in use');
    await r2('POST', `/api/orders/${c.data.orderId}/cancel`, { json: { paypalOrderId: c.data.paypalOrderId } });
    const back = await paypal2('mode', { mode: 'sandbox' });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.data.mode, 'sandbox');
    const removed = await paypal2('disconnect', { mode: 'live' });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.data.modes.live.connected, false);
    assert.equal(removed.data.modes.live.keptForOpenOrders, 1, 'kept until no open order needs them');
    await app2.booking.reconcile();
    await waitFor(() => (pp2.state.webhooks.get(LV.clientId) || []).length === 0, 3000, 'live webhook deleted at PayPal');
    assert.equal((await r2('GET', '/api/admin/paypal', { cookie: cookie2 })).data.modes.live.keptForOpenOrders, 0);
    assert.equal((await paypal2('mode', { mode: 'live' })).status, 409, 'cannot switch to live without keys');
    assert.equal((await paypal2('mode', { mode: 'mock' })).status, 409, 'simulated payments only on your own computer');
  });

  await test('the Ticket stock page manages real and test tickets separately', async () => {
    const real = await r2('GET', '/api/admin/stock?folder=real', { cookie: cookie2 });
    const tst = await r2('GET', '/api/admin/stock?folder=test', { cookie: cookie2 });
    assert.deepEqual([real.data.folder, tst.data.folder, real.data.activeFolder], ['real', 'test', 'test']);
    const ar = real.data.types.find((t) => t.id === 'adult');
    const at = tst.data.types.find((t) => t.id === 'adult');
    assert.deepEqual([ar.availableNow, ar.sold], [3, 1]);
    assert.deepEqual([at.availableNow, at.sold], [3, 1]);
    const up = await r2('POST', '/api/admin/stock/upload?type=adult&folder=real', {
      cookie: cookie2,
      raw: samplePdf({ number: 'UP-REAL-1' }),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'up-real.pdf' },
    });
    assert.equal(up.status, 201, up.text);
    assert.ok(fs.existsSync(path.join(cfg2.liveTicketsDir, 'stock', 'adult', up.data.name)));
    assert.ok(!fs.existsSync(path.join(cfg2.sandboxTicketsDir, 'stock', 'adult', up.data.name)));
    assert.equal((await r2('GET', '/api/admin/stock?folder=real', { cookie: cookie2 })).data.types.find((t) => t.id === 'adult').availableNow, 4);
    assert.equal((await r2('GET', '/api/admin/stock', { cookie: cookie2 })).data.folder, 'test', 'default: the folder in use');
    const files = await r2('GET', '/api/admin/stock/files?type=adult&folder=test', { cookie: cookie2 });
    assert.ok(files.data.files.every((n) => /^TEST-/.test(n)));
  });

  await test('replacing keys while a customer is paying: the order still uses the PayPal app it was made with', async () => {
    pp2.state.ordersPerApp = true; // like real PayPal: another app can't see the order
    try {
      put2(cfg2.sandboxTicketsDir, 'TEST2', 3);
      const o = await order2('switching-keys@example.com', 'sandbox');
      assert.equal(o.status, 201, o.text);
      assert.equal((await app2.store.getOrder(o.data.orderId)).paypal.clientId, SB.clientId);
      const rep = await paypal2('connect', { mode: 'sandbox', ...SB2 });
      assert.equal(rep.status, 200, rep.text);
      assert.equal(rep.data.modes.sandbox.keptForOpenOrders, 1);
      // a webhook from the old app is still accepted (verified with the old app's keys)
      const oldHook = pp2.state.webhooks.get(SB.clientId)[0];
      assert.ok(oldHook, 'old webhook not deleted while the order is open');
      pp2.approve(o.data.paypalOrderId);
      const cap = await r2('POST', `/api/orders/${o.data.orderId}/capture`, { json: { paypalOrderId: o.data.paypalOrderId } });
      assert.equal(cap.data.status, 'completed', cap.text);
      const captureCall = pp2.state.calls.filter((c) => c.url.endsWith(`${o.data.paypalOrderId}/capture`)).pop();
      assert.equal(captureCall.app, SB.clientId, 'captured with the app that created the order');
      // new checkouts use the new app
      const n = await order2('new-keys@example.com', 'sandbox');
      assert.equal((await app2.store.getOrder(n.data.orderId)).paypal.clientId, SB2.clientId);
      await r2('POST', `/api/orders/${n.data.orderId}/cancel`, { json: { paypalOrderId: n.data.paypalOrderId } });
      // once nothing needs the old keys, they are forgotten and their webhook deleted
      await app2.booking.reconcile();
      await waitFor(() => (pp2.state.webhooks.get(SB.clientId) || []).length === 0, 3000, 'old sandbox webhook deleted');
      const st = await r2('GET', '/api/admin/paypal', { cookie: cookie2 });
      assert.equal(st.data.modes.sandbox.keptForOpenOrders, 0);
      assert.doesNotMatch(fs.readFileSync(path.join(cfg2.dataDir, 'paypal.json'), 'utf8'), new RegExp(SB.clientSecret));
    } finally {
      pp2.state.ordersPerApp = false;
    }
  });

  await test('if the keys an order was paid with are gone, the order is kept and the owner alerted, never expired', async () => {
    const A = { clientId: 'ENV-A-client-01234567', clientSecret: 'ENV-A-secret-01234567' };
    const B = { clientId: 'ENV-B-client-01234567', clientSecret: 'ENV-B-secret-01234567' };
    const pp3 = fakePayPal({ ...A, webhookId: '', apps: [B] });
    const port3 = await pp3.listen();
    const T3 = path.join(TMP, 'pp3');
    const cfgFor = (keys) => ({
      ...cfg2,
      dataDir: path.join(T3, 'data'),
      liveTicketsDir: path.join(T3, 'tickets'),
      sandboxTicketsDir: path.join(T3, 'tickets-sandbox'),
      ticketsDir: path.join(T3, 'tickets-sandbox'),
      paypal: { ...cfg2.paypal, mode: 'sandbox', ...keys, webhookId: '', apiBaseOverride: `http://127.0.0.1:${port3}` },
    });
    fs.mkdirSync(path.join(T3, 'data'), { recursive: true });
    const before = createApp(cfgFor(A)); // keys from the environment (.env)
    const d = path.join(T3, 'tickets-sandbox', 'stock', 'adult');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(d, `E-${i}.pdf`), samplePdf({ number: 'E' + i }));
    before.booking.stock.invalidate();
    const o = await before.booking.createOrder({ date: day(4), items: [{ typeId: 'adult', qty: 1 }], customer: { name: 'Env Buyer', email: 'env@example.com' } }, { ip: '198.51.100.70' });
    pp3.approve(o.paypalOrderId);
    pp3.state.nextCapture = 'error500-captured'; // money taken, reply lost
    assert.equal((await before.booking.capture(o.orderId, o.paypalOrderId)).status, 'unconfirmed');
    // restart with other keys in .env
    const after = createApp(cfgFor(B));
    await after.store.updateOrder(o.orderId, (x) => {
      x.reservation.expiresAt = new Date(Date.now() - 4 * 3600000).toISOString();
    });
    await after.booking.reconcile();
    const kept = await after.store.getOrder(o.orderId);
    assert.equal(kept.status, 'pending', 'not expired');
    assert.ok(kept.alertedAt, 'owner alerted');
    assert.equal(kept.reservation.files.length, 1, 'tickets still reserved');
    const r1 = await after.booking.capture(o.orderId, o.paypalOrderId);
    assert.equal(r1.status, 'unconfirmed');
    assert.doesNotMatch(r1.message, /not been charged/);
    await assert.rejects(after.booking.cancelByAdmin(o.orderId), (e) => e.status === 409 && e.extra && e.extra.code === 'CONFIRM_NOT_PAID');
    assert.equal((await after.booking.orderAdmin(o.orderId)).paypalUnavailable, true);
    const c = await after.booking.cancelByAdmin(o.orderId, { confirmNotPaid: true });
    assert.equal(c.status, 'cancelled');
    await pp3.close();
  });

  await test('keys PayPal stops accepting count as "cannot check": the order is kept, the owner alerted and able to decide', async () => {
    // current sandbox keys: SB2 (from the key replacement test)
    put2(cfg2.sandboxTicketsDir, 'TEST3', 2);
    const o = await order2('rejected-keys@example.com', 'sandbox');
    assert.equal(o.status, 201, o.text);
    pp2.approve(o.data.paypalOrderId);
    pp2.state.nextCapture = 'error500-captured'; // money taken, reply lost
    assert.equal((await r2('POST', `/api/orders/${o.data.orderId}/capture`, { json: { paypalOrderId: o.data.paypalOrderId } })).data.status, 'unconfirmed');
    assert.equal((await paypal2('connect', { mode: 'sandbox', ...SB })).status, 200); // SB2 kept for this order
    pp2.revoke(SB2.clientId); // the owner deleted the old app on developer.paypal.com
    try {
      await app2.store.updateOrder(o.data.orderId, (x) => {
        x.reservation.expiresAt = new Date(Date.now() - 4 * 3600000).toISOString();
      });
      await app2.booking.reconcile();
      let x = await app2.store.getOrder(o.data.orderId);
      assert.equal(x.status, 'pending', 'never expired');
      assert.ok(x.alerts && x.alerts['A payment could not be checked with PayPal'], 'owner alerted');
      const adminView = await r2('GET', `/api/admin/orders/${o.data.orderId}`, { cookie: cookie2 });
      assert.equal(adminView.data.paypalUnavailable, true);
      const noConfirm = await r2('POST', `/api/admin/orders/${o.data.orderId}/confirm-paid`, { cookie: cookie2, json: {} });
      assert.equal(noConfirm.status, 409);
      const paid = await r2('POST', `/api/admin/orders/${o.data.orderId}/confirm-paid`, { cookie: cookie2, json: { confirmPaid: true } });
      assert.equal(paid.status, 200, paid.text);
      assert.equal(paid.data.status, 'fulfilled');
      assert.match(paid.data.tickets[0].original || '', /^TEST/, 'a test ticket, never a real one');
      // a webhook verifies even when one set of keys is rejected
      pp2.revoke(SB.clientId);
      pp2.restore(SB2);
      const evt = { id: 'WH-EVT-2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'X', status: 'COMPLETED', custom_id: 'BP-NOPE0000' } };
      const hook = await r2('POST', '/api/paypal/webhook/sandbox', {
        raw: JSON.stringify(evt),
        headers: {
          'Content-Type': 'application/json',
          'paypal-auth-algo': 'SHA256withRSA',
          'paypal-cert-url': 'https://api.paypal.com/cert.pem',
          'paypal-transmission-id': 'tid-2',
          'paypal-transmission-sig': 'good',
          'paypal-transmission-time': new Date().toISOString(),
        },
      });
      assert.equal(hook.status, 200, hook.text);
    } finally {
      pp2.restore(SB);
      pp2.restore(SB2);
    }
  });

  await test('older orders without a recorded PayPal app are linked to it before keys change', async () => {
    const o = await order2('older-order@example.com', 'sandbox');
    assert.equal(o.status, 201, o.text);
    await app2.store.updateOrder(o.data.orderId, (x) => {
      delete x.paypal.clientId;
    });
    await app2.booking.backfillClientIds();
    assert.equal((await app2.store.getOrder(o.data.orderId)).paypal.clientId, SB.clientId);
    await r2('POST', `/api/orders/${o.data.orderId}/cancel`, { json: { paypalOrderId: o.data.paypalOrderId } });
  });

  await test('older orders are linked to their PayPal app even when keys are replaced without the dashboard', async () => {
    const o = await order2('older-order-2@example.com', 'sandbox');
    assert.equal(o.status, 201, o.text);
    const before = app2.payments.client('sandbox').clientId;
    await app2.store.updateOrder(o.data.orderId, (x) => {
      delete x.paypal.clientId;
    });
    const other = before === SB.clientId ? SB2 : SB;
    await app2.payments.connect('sandbox', other); // straight to the settings, not through the dashboard route
    assert.equal((await app2.store.getOrder(o.data.orderId)).paypal.clientId, before, 'linked before the keys changed');
    assert.ok(app2.payments.saved().retired.some((r) => r.clientId === before), 'its keys are kept');
    await r2('POST', `/api/orders/${o.data.orderId}/cancel`, { json: { paypalOrderId: o.data.paypalOrderId } });
  });

  await test('if PayPal has no record of an order a payment was sent for, it is kept for the owner to decide', async () => {
    put2(cfg2.sandboxTicketsDir, 'TEST4', 2);
    const o = await order2('no-record@example.com', 'sandbox');
    assert.equal(o.status, 201, o.text);
    pp2.approve(o.data.paypalOrderId);
    pp2.state.nextCapture = 'error500';
    assert.equal((await r2('POST', `/api/orders/${o.data.orderId}/capture`, { json: { paypalOrderId: o.data.paypalOrderId } })).data.status, 'unconfirmed');
    pp2.state.orders.delete(o.data.paypalOrderId); // PayPal "forgets" the order
    const again = await r2('POST', `/api/orders/${o.data.orderId}/capture`, { json: { paypalOrderId: o.data.paypalOrderId } });
    assert.equal(again.data.status, 'unconfirmed');
    assert.doesNotMatch(again.data.message, /not been charged/);
    await app2.store.updateOrder(o.data.orderId, (x) => {
      x.reservation.expiresAt = new Date(Date.now() - 4 * 3600000).toISOString();
    });
    await app2.booking.reconcile();
    const x = await app2.store.getOrder(o.data.orderId);
    assert.equal(x.status, 'pending', 'kept');
    assert.ok(x.alerts['PayPal has no record of a payment']);
    const view = await r2('GET', `/api/admin/orders/${o.data.orderId}`, { cookie: cookie2 });
    assert.equal(view.data.paypalUnavailable, true, 'the owner can decide');
    const rel = await r2('POST', `/api/admin/orders/${o.data.orderId}/cancel`, { cookie: cookie2, json: { confirmNotPaid: true } });
    assert.equal(rel.status, 200, rel.text);
    assert.equal(rel.data.status, 'cancelled');
  });

  await test('a payment PayPal holds is reported when PayPal stops answering, and deleted keys are noticed at once', async () => {
    put2(cfg2.sandboxTicketsDir, 'TEST5', 2);
    const o = await order2('held-payment@example.com', 'sandbox');
    assert.equal(o.status, 201, o.text);
    pp2.approve(o.data.paypalOrderId);
    pp2.state.nextCapture = 'pending';
    assert.equal((await r2('POST', `/api/orders/${o.data.orderId}/capture`, { json: { paypalOrderId: o.data.paypalOrderId } })).data.status, 'pending');
    let x = await app2.store.getOrder(o.data.orderId);
    assert.ok(x.paypal.lastOkAt, 'remembers when PayPal last answered');
    await app2.store.updateOrder(o.data.orderId, (y) => {
      y.paypal.lastOkAt = new Date(Date.now() - 4 * 3600000).toISOString();
      y.paypal.lastCheckAt = new Date(Date.now() - 16 * 60000).toISOString();
    });
    pp2.state.failGets = true;
    try {
      await app2.booking.reconcile();
    } finally {
      pp2.state.failGets = false;
    }
    x = await app2.store.getOrder(o.data.orderId);
    assert.equal(x.status, 'payment_pending');
    assert.ok(x.alerts && x.alerts['A payment could not be confirmed with PayPal'], 'owner told about the outage');

    // keys deleted at PayPal after a token was cached: noticed straight away
    const client = app2.payments.clientForOrder('sandbox', x.paypal.clientId);
    await client.token();
    pp2.revoke(x.paypal.clientId);
    try {
      assert.equal(await app2.booking._payPalUsable(client), false);
    } finally {
      pp2.restore(x.paypal.clientId === SB.clientId ? SB : SB2);
    }
  });

  await test('replaced keys are kept for an hour, and reconnecting during a clean-up keeps the webhook', async () => {
    const { Payments } = require('../src/payments');
    const dir = path.join(TMP, 'grace');
    fs.mkdirSync(dir, { recursive: true });
    const { Store } = require('../src/store');
    const st = new Store(dir);
    const pm = new Payments({ config: { ...cfg2, dataDir: dir, retiredGraceMs: undefined }, store: st });
    const entry = (ago) => ({ mode: 'sandbox', clientId: 'OLD-client-0123456789', clientSecret: 'OLD-secret-0123456789', retiredAt: new Date(Date.now() - ago).toISOString() });
    fs.writeFileSync(path.join(dir, 'paypal.json'), JSON.stringify({ retired: [entry(60000)] }));
    await pm.purgeRetired(async () => new Set());
    assert.equal(pm.saved().retired.length, 1, 'replaced a minute ago: kept');
    fs.writeFileSync(path.join(dir, 'paypal.json'), JSON.stringify({ retired: [entry(2 * 3600000)] }));
    await pm.purgeRetired(async () => new Set());
    assert.equal(pm.saved().retired.length, 0, 'replaced two hours ago and unused: forgotten');

    // reconnect a replaced app while a clean-up runs: they take turns, the webhook survives
    assert.equal((await paypal2('connect', { mode: 'sandbox', ...SB2 })).status, 200); // SB is now the replaced one
    await Promise.all([paypal2('connect', { mode: 'sandbox', ...SB }), app2.booking.reconcile()]);
    const status = (await r2('GET', '/api/admin/paypal', { cookie: cookie2 })).data.modes.sandbox;
    assert.equal(status.webhook.state, 'on');
    const savedId = JSON.parse(fs.readFileSync(path.join(cfg2.dataDir, 'paypal.json'), 'utf8')).sandbox.webhookId;
    assert.ok((pp2.state.webhooks.get(SB.clientId) || []).some((w) => w.id === savedId), 'saved webhook exists at PayPal');
  });

  await test('simulated payments and sample tickets only ever use the test folder', async () => {
    const { Payments } = require('../src/payments');
    const pm = new Payments({ config: { ...cfg2, mockAllowed: true }, store: app2.store });
    assert.equal(pm.ticketsDir('mock'), cfg2.sandboxTicketsDir);
    assert.equal(app2.booking.folderOfMode('mock'), 'test');
    const live = path.join(TMP, 'st-live');
    execFileSync(process.execPath, ['scripts/sample-tickets.js', '2', '--type', 'adult'], {
      cwd: path.join(__dirname, '..'),
      env: { PATH: process.env.PATH, ENV_FILE: path.join(TMP, 'none.env'), DATA_DIR: path.join(TMP, 'st-data'), TICKETS_DIR: live, PAYPAL_MODE: 'live' },
      stdio: 'ignore',
    });
    assert.equal(ticketFiles(path.join(live + '-sandbox', 'stock', 'adult')).length, 2);
    assert.equal(ticketFiles(path.join(live, 'stock', 'adult')).length, 0, 'nothing in the real folder');
  });

  await test('low-stock alerts are tracked separately for real and test tickets', async () => {
    const s0 = app2.booking.settings();
    await app2.store.saveSettings({ ...s0, lowStockThreshold: 100 });
    try {
      await app2.booking.checkLowStock();
      let st = await app2.store.getState();
      assert.ok(st.lowStockAlerts['test:adult']);
      assert.equal((await paypal2('connect', { mode: 'live', ...LV })).status, 200);
      assert.equal((await paypal2('mode', { mode: 'live' })).status, 200);
      await app2.booking.checkLowStock();
      st = await app2.store.getState();
      assert.ok(st.lowStockAlerts['real:adult'], 'the real folder is not silenced by a test-folder alert');
      assert.equal((await paypal2('mode', { mode: 'sandbox' })).status, 200);
    } finally {
      await app2.store.saveSettings(s0);
    }
  });

  await test('live payments need a public https address', async () => {
    const r = await req('POST', '/api/admin/paypal/connect', { cookie: adminCookie, json: { mode: 'live', clientId: CLIENT_ID, clientSecret: SECRET } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.modes.live.webhook.state, 'needs-https');
    const sw = await req('POST', '/api/admin/paypal/mode', { cookie: adminCookie, json: { mode: 'live' } });
    assert.equal(sw.status, 409);
    assert.match(sw.data.error, /https/);
    assert.equal((await req('POST', '/api/admin/paypal/disconnect', { cookie: adminCookie, json: { mode: 'live' } })).status, 200);
    assert.equal((await req('GET', '/api/admin/paypal', { cookie: adminCookie })).data.mode, 'sandbox');
  });

  await test('on Render (Cloudflare in front) visitors are told apart by the Cloudflare header, which can\'t be faked', async () => {
    const { clientIp } = require('../src/http');
    const reqOf = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
    // Render's proxy (private address) -> app. X-Forwarded-For: "<anything the visitor sent>, visitor, Cloudflare edge".
    const viaRender = reqOf('10.21.157.68', { 'x-forwarded-for': '6.6.6.6, 99.61.165.29, 104.22.17.40', 'cf-connecting-ip': '99.61.165.29' });
    assert.equal(clientIp(viaRender, 'cloudflare'), '99.61.165.29');
    assert.equal(clientIp(viaRender, 'auto'), '104.22.17.40', 'auto mode alone would see Cloudflare');
    assert.equal(clientIp(reqOf('10.0.0.9', { 'true-client-ip': '2001:db8:1:2::7' }), 'cloudflare'), '2001:db8:1:2::7');
    // a request straight from the internet can't pick its own address
    assert.equal(clientIp(reqOf('198.51.100.20', { 'cf-connecting-ip': '1.2.3.4' }), 'cloudflare'), '198.51.100.20');
    // junk in the header is ignored
    assert.equal(clientIp(reqOf('10.0.0.9', { 'cf-connecting-ip': '<script>', 'x-forwarded-for': '203.0.113.77' }), 'cloudflare'), '203.0.113.77');
    // Render's own health checks have no Cloudflare header
    assert.equal(clientIp(reqOf('10.0.0.9', {}), 'cloudflare'), '10.0.0.9');

    const cfg = (env) =>
      JSON.parse(
        execFileSync(process.execPath, ['-e', "const c = require('./src/config'); console.log(JSON.stringify({ t: c.trustProxy, b: c.baseUrl }))"], {
          cwd: path.join(__dirname, '..'),
          env: { PATH: process.env.PATH, ENV_FILE: path.join(TMP, 'none.env'), DATA_DIR: path.join(TMP, 'cfg-data'), ...env },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      );
    assert.deepEqual(cfg({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://bahia-booking.onrender.com' }), { t: 'cloudflare', b: 'https://bahia-booking.onrender.com' });
    assert.deepEqual(cfg({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://x.onrender.com', BASE_URL: 'https://book.bahiapalace.com/' }), { t: 'cloudflare', b: 'https://book.bahiapalace.com' });
    assert.equal(cfg({}).t, 'auto');
    assert.equal(cfg({ TRUST_PROXY: 'auto' }).t, 'auto');
    assert.equal(cfg({ TRUST_PROXY: '2' }).t, 2);
    assert.equal(cfg({ TRUST_PROXY: 'cloudfare' }).t, 'auto', 'a typo falls back to auto instead of trusting nothing');
  });

  await test('two processes never sell the same ticket, even when the file is in stock twice', async () => {
    const { Store } = require('../src/store');
    const { Stock } = require('../src/stock');
    let doubles = 0;
    for (let run = 0; run < 25; run++) {
      const base = path.join(TMP, 'race-' + run);
      const T = path.join(base, 'tickets');
      const D = path.join(base, 'data');
      fs.mkdirSync(path.join(T, 'stock', 'adult'), { recursive: true });
      const same = samplePdf({ type: 'adult', number: 'SAME-' + run });
      fs.writeFileSync(path.join(T, 'stock', 'adult', 'ticket-0001.pdf'), same);
      fs.writeFileSync(path.join(T, 'stock', 'adult', 'ticket-0001 copy.pdf'), same);
      for (let i = 2; i < 5; i++) fs.writeFileSync(path.join(T, 'stock', 'adult', `ticket-000${i}.pdf`), samplePdf({ number: run + '-' + i }));
      const s1 = new Store(D);
      const s2 = new Store(D);
      const p1 = new Stock(T, D, { lock: (n, fn) => s1.withLock(n, fn) });
      const p2 = new Stock(T, D, { lock: (n, fn) => s2.withLock(n, fn) });
      const [r1, r2] = await Promise.all([
        p1.reserve('BP-AAAAAAAA', null, [{ typeId: 'adult', qty: 1 }]),
        p2.reserve('BP-BBBBBBBB', null, [{ typeId: 'adult', qty: 1 }]),
      ]);
      const [f1, f2] = await Promise.all([p1.finalize('BP-AAAAAAAA', r1), p2.finalize('BP-BBBBBBBB', r2)]);
      if (f1[0].hash === f2[0].hash) doubles++;
    }
    assert.equal(doubles, 0);
  });

  await test('a ticket email is sent once even when several senders race', async () => {
    const { c } = await buy({ adult: 1, email: 'once@example.com' });
    await waitFor(() => mailsTo('once@example.com').length === 1, 5000, 'first email');
    // the message reaches the mail server a moment before the app records it as sent
    await waitFor(async () => ((await store.getOrder(c.data.orderId)).email || {}).status === 'sent', 5000, 'first email recorded');
    await store.updateOrder(c.data.orderId, (o) => {
      o.email.status = 'failed';
      o.email.nextAttemptAt = new Date(0).toISOString();
    });
    await Promise.all([booking.sendTicketEmail(c.data.orderId), booking.sendTicketEmail(c.data.orderId), booking.sendTicketEmail(c.data.orderId)]);
    await sleep(200);
    assert.equal(mailsTo('once@example.com').length, 2, 'exactly one more email');
  });

  await test('the owner is warned about a possible double purchase', async () => {
    await buy({ adult: 1, email: 'twice@example.com' });
    await buy({ adult: 1, email: 'twice@example.com' });
    await waitFor(() => mailsTo('owner@bahia.test').some((m) => /double purchase/.test(decodeWords(parseMime(m.raw).headers.subject))), 5000, 'double purchase alert');
  });

  await test('a lock stays alive while its holder works, so another process cannot take it over', async () => {
    const { Store } = require('../src/store');
    const D = path.join(TMP, 'locktest');
    const a = new Store(D);
    const b = new Store(D);
    const events = [];
    const first = a.withLock('x', async () => {
      events.push('a-start');
      await sleep(1500);
      events.push('a-end');
    }, { staleMs: 400 });
    await sleep(50);
    const second = b.withLock('x', async () => {
      events.push('b-start');
    }, { staleMs: 400, waitMs: 5000 });
    await Promise.all([first, second]);
    assert.deepEqual(events, ['a-start', 'a-end', 'b-start']);
  });

  await test('fake payments only work on localhost, and sandbox orders use a separate test ticket folder', async () => {
    const run = (env, code) =>
      execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: path.join(TMP, 'cfg'), ...env } })
        .toString()
        .trim();
    const show = "const c=require('./src/config'); console.log(c.paypal.disabledReason ? 'blocked' : 'allowed')";
    assert.equal(run({ PAYPAL_MODE: 'mock', NODE_ENV: 'development', BASE_URL: 'https://book.example.com' }, show), 'blocked');
    assert.equal(run({ PAYPAL_MODE: 'mock', NODE_ENV: 'development', BASE_URL: 'http://localhost:8080' }, show), 'allowed');
    const dir = run({ PAYPAL_MODE: 'sandbox', SANDBOX_TICKETS_DIR: '', TICKETS_DIR: path.join(TMP, 'tk') }, "console.log(require('./src/config').ticketsDir)");
    assert.equal(dir, path.join(TMP, 'tk') + '-sandbox');
  });

  // ---------------------------------------------------------------- security
  await test('static files: no path traversal, no dotfiles, no source files', async () => {
    for (const p of ['/%2e%2e/server.js', '/..%2Fsrc%2Fconfig.js', '/.env', '/admin/..%2F..%2Fpackage.json', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/fonts/../../server.js']) {
      const r = await rawGet(p);
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /createApp|PAYPAL_CLIENT|root:x/);
    }
    assert.equal((await rawGet('/')).status, 200);
    assert.equal((await rawGet('/admin')).status, 200);
    assert.equal((await rawGet('/embed.js')).status, 200);
  });

  await test('rate limit stops checkout spam from one address', async () => {
    let limited = false;
    for (let i = 0; i < 35; i++) {
      const r = await req('POST', '/api/orders', { json: {}, ip: '198.51.100.7' });
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited);
  });

  await test('security headers: admin cannot be framed, booking page can be embedded', async () => {
    const a = await req('GET', '/admin');
    assert.equal(a.headers.get('x-frame-options'), 'DENY');
    const b = await req('GET', '/');
    assert.match(b.headers.get('content-security-policy'), /frame-ancestors/);
    assert.equal(b.headers.get('x-content-type-options'), 'nosniff');
  });

  // ---------------------------------------------------------------- email client
  await test('SMTP: STARTTLS + AUTH LOGIN (port 587 style)', async () => {
    if (!key) return;
    const s2 = fakeSmtp({ user: 'u@x.test', pass: 'p', key, cert, caps: ['AUTH LOGIN', 'STARTTLS'] });
    const port = await s2.listen();
    const built = buildMessage({ from: 'Shop <shop@x.test>', to: 'Zoë Ünicode <zoe@x.test>', subject: 'Ticket – café ✓', text: 'hi', html: '<p>hi</p>' });
    await smtpSend({ host: '127.0.0.1', port, secure: false, user: 'u@x.test', pass: 'p', rejectUnauthorized: false, timeoutMs: 5000 }, built.envelope, built.message);
    assert.equal(s2.messages.length, 1);
    assert.ok(s2.messages[0].secure && s2.messages[0].authed);
    const tree = parseMime(s2.messages[0].raw);
    assert.equal(decodeWords(tree.headers.subject), 'Ticket – café ✓');
    assert.match(decodeWords(tree.headers.to), /Zoë Ünicode/);
    await s2.close();
  });

  await test('SMTP: wrong password and missing encryption give clear errors', async () => {
    if (key) {
      const s3 = fakeSmtp({ user: 'u@x.test', pass: 'p', key, cert, implicitTls: true });
      const port = await s3.listen();
      const built = buildMessage({ from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't', html: 'h' });
      await assert.rejects(
        smtpSend({ host: '127.0.0.1', port, secure: true, user: 'u@x.test', pass: 'WRONG', rejectUnauthorized: false, timeoutMs: 5000 }, built.envelope, built.message),
        /login failed/
      );
      await s3.close();
    }
    const s4 = fakeSmtp({ user: 'u@x.test', pass: 'p', caps: ['AUTH PLAIN'] });
    const port4 = await s4.listen();
    const built = buildMessage({ from: 'a@x.test', to: 'b@x.test', subject: 's', text: 't', html: 'h' });
    await assert.rejects(
      smtpSend({ host: '127.0.0.1', port: port4, secure: false, user: 'u@x.test', pass: 'p', timeoutMs: 5000 }, built.envelope, built.message),
      /does not offer encryption/
    );
    await s4.close();
  });

  await test('message lines starting with a dot survive SMTP (dot-stuffing)', async () => {
    const s5 = fakeSmtp({ caps: ['SIZE 1000'] });
    const port = await s5.listen();
    const msg = 'Subject: t\r\n\r\n.hidden line\r\n..two dots\r\nend';
    await smtpSend({ host: '127.0.0.1', port, secure: false, timeoutMs: 5000 }, { from: 'a@x.test', to: ['b@x.test'] }, msg);
    assert.ok(s5.messages[0].raw.includes('\r\n.hidden line\r\n..two dots\r\nend'));
    await s5.close();
  });

  // ---------------------------------------------------------------- units
  await test('.env parser handles quotes, comments and export', async () => {
    const env = parseEnv('# c\nA=1\nexport B="two words" \nC=\'lit#eral\'\nD=val # comment\nE="multi\\nline"\nBAD LINE\n=x\n');
    assert.deepEqual(env, { A: '1', B: 'two words', C: 'lit#eral', D: 'val', E: 'multi\nline' });
  });

  await test('money and ids', async () => {
    const u = require('../src/util');
    assert.equal(u.toCents('12.5'), 1250);
    assert.equal(u.toCents('12,05'), 1205);
    assert.ok(Number.isNaN(u.toCents('1e5')));
    assert.equal(u.fromCents(1205), '12.05');
    assert.match(u.newOrderId(), u.ORDER_ID_RE);
    assert.ok(!u.safeFilename('../../etc/passwd').includes('/'));
    assert.ok(!u.safeFilename('.htaccess').startsWith('.'));
  });

  // ---------------------------------------------------------------- database (Neon)
  await test('Neon client: endpoint, request shape and response parsing', async () => {
    const { NeonClient, neonEndpoint, cleanConnectionString, prepareParam } = require('../src/neon');
    assert.equal(neonEndpoint('postgresql://u:p@ep-cool-pooler.us-east-2.aws.neon.tech/db?sslmode=require'), 'https://api.us-east-2.aws.neon.tech/sql');
    assert.equal(cleanConnectionString('postgresql://u:p@h/db?channel_binding=require&sslmode=require'), 'postgresql://u:p@h/db?sslmode=require');
    assert.equal(prepareParam({ a: 1 }), '{"a":1}');
    assert.equal(prepareParam(null), null);

    const seen = [];
    const srv = http.createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => (body += c));
      rq.on('end', () => {
        seen.push({ url: rq.url, headers: rq.headers, body: JSON.parse(body) });
        rs.setHeader('Content-Type', 'application/json');
        rs.end(JSON.stringify({ fields: [{ name: 'x', dataTypeID: 23 }], rows: [['42']], rowCount: 1, command: 'SELECT' }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const client = new NeonClient('postgresql://u:p@127.0.0.1/db', { endpoint: `http://127.0.0.1:${srv.address().port}/sql` });
    const res = await client.query('SELECT $1::int AS x', [7]);
    assert.deepEqual(res.rows, [{ x: '42' }]);
    assert.equal(seen[0].body.query, 'SELECT $1::int AS x');
    assert.deepEqual(seen[0].body.params, [7]);
    assert.equal(seen[0].headers['neon-connection-string'], 'postgresql://u:p@127.0.0.1/db');
    assert.equal(seen[0].headers['neon-raw-text-output'], 'true');
    assert.equal(seen[0].url, '/sql');
    await new Promise((r) => srv.close(r));
  });

  await test('Neon client: server errors surface with a clear message', async () => {
    const { NeonClient } = require('../src/neon');
    const srv = http.createServer((rq, rs) => {
      rs.statusCode = 400;
      rs.setHeader('Content-Type', 'application/json');
      rs.end(JSON.stringify({ message: 'syntax error at or near "SELET"' }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const client = new NeonClient('postgresql://u:p@127.0.0.1/db', { endpoint: `http://127.0.0.1:${srv.address().port}/sql` });
    await assert.rejects(client.query('SELET 1'), /syntax error/);
    await new Promise((r) => srv.close(r));
  });

  await test('database store: orders, settings, mail, paypal, activity and locks', async () => {
    const { DbStore } = require('../src/dbstore');
    const { NeonClient } = require('../src/neon');
    const db = fakeDb();
    const neon = await fakeNeonServer(db);
    const dir = path.join(TMP, 'db-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(dir, { recursive: true });
    const connect = () => new DbStore(dir, new NeonClient('postgresql://u:p@fake/db', { endpoint: neon.url }));

    const store = connect();
    await store.init();
    assert.equal(store.getSettings().currency, 'EUR', 'defaults before anything is saved');

    await store.saveSettings({ siteName: 'DB Shop', currency: 'USD' });
    assert.equal(store.getSettings().siteName, 'DB Shop');
    const store2 = connect();
    await store2.init();
    assert.equal(store2.getSettings().siteName, 'DB Shop', 'settings persisted and reloaded');

    await store.saveMail({ smtp: { host: 'smtp.db' }, from: 'a@b.c' });
    assert.equal(store.getMail().smtp.host, 'smtp.db');
    await store.savePaypal({ mode: 'live', live: { clientId: 'x', clientSecret: 'y' } });
    assert.equal(store.getPaypal().mode, 'live');

    const id = 'BP-ABCDEFGH';
    await store.insertOrder({ id, status: 'pending', total: 1200 });
    await assert.rejects(store.insertOrder({ id, status: 'pending' }), /already exists/);
    assert.equal((await store.getOrder(id)).status, 'pending');
    await store.updateOrder(id, (o) => {
      o.status = 'paid';
    });
    assert.equal((await store.getOrder(id)).status, 'paid');
    assert.equal((await store.listOrders()).length, 1);
    assert.equal(await store.getOrder('BP-23456789'), null, 'invalid ids return null');
    await store.deleteOrder(id);
    assert.equal(await store.getOrder(id), null);

    await store.appendActivity({ at: 'x', type: 'info', msg: 'one' });
    await store.appendActivity({ at: 'x', type: 'info', msg: 'two' });
    assert.deepEqual((await store.readActivity()).map((e) => e.msg), ['one', 'two']);

    await store.updateState((s) => {
      s.seen = true;
    });
    assert.equal((await store.getState()).seen, true);

    const order = [];
    await Promise.all([
      store.withLock('x', async () => {
        order.push('a-start');
        await sleep(120);
        order.push('a-end');
      }),
      store2.withLock('x', async () => {
        order.push('b-start');
      }),
    ]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start'], 'two instances take turns');
    await neon.close();
  });

  await test('database store: sold fingerprints and first-run import of existing files', async () => {
    const { DbStore } = require('../src/dbstore');
    const { NeonClient } = require('../src/neon');
    const db = fakeDb();
    const neon = await fakeNeonServer(db);
    const dir = path.join(TMP, 'dbimp-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(path.join(dir, 'orders'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ siteName: 'Imported' }));
    fs.writeFileSync(path.join(dir, 'mail.json'), JSON.stringify({ from: 'x@y.z' }));
    fs.writeFileSync(path.join(dir, 'paypal.json'), JSON.stringify({ mode: 'sandbox' }));
    fs.writeFileSync(path.join(dir, 'activity.json'), JSON.stringify([{ msg: 'old' }]));
    fs.writeFileSync(path.join(dir, 'orders', 'BP-23456789.json'), JSON.stringify({ id: 'BP-23456789', status: 'fulfilled' }));
    const hash = 'a'.repeat(64);
    fs.writeFileSync(path.join(dir, 'sold-hashes.log'), `${hash} BP-23456789\n`);

    const store = new DbStore(dir, new NeonClient('postgresql://u:p@fake/db', { endpoint: neon.url }));
    await store.init();
    assert.equal(store.getSettings().siteName, 'Imported');
    assert.equal(store.getMail().from, 'x@y.z');
    assert.equal(store.getPaypal().mode, 'sandbox');
    assert.equal((await store.readActivity()).length, 1);
    assert.equal((await store.getOrder('BP-23456789')).status, 'fulfilled');
    assert.equal(await store.ticketIndex().lookup(hash), 'BP-23456789', 'sold fingerprint imported');

    await store.ticketIndex().record([{ hash: 'b'.repeat(64), orderId: 'BP-23456789' }]);
    assert.equal(await store.ticketIndex().lookup('b'.repeat(64)), 'BP-23456789');

    // A second start must not import the files again.
    const again = new DbStore(dir, new NeonClient('postgresql://u:p@fake/db', { endpoint: neon.url }));
    await again.init();
    assert.equal((await again.listOrders()).length, 1);
    assert.equal((await again.readActivity()).length, 1);
    await neon.close();
  });

  await test('database ticket stock: upload, reserve, finalize, release, read, dates and duplicates', async () => {
    const { DbStore } = require('../src/dbstore');
    const { DbStock } = require('../src/dbstock');
    const { NeonClient } = require('../src/neon');
    const db = fakeDb();
    const neon = await fakeNeonServer(db);
    const dir = path.join(TMP, 'dbstock-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(dir, { recursive: true });
    const store = new DbStore(dir, new NeonClient('postgresql://u:p@fake/db', { endpoint: neon.url }));
    await store.init();
    const mk = (folder) => new DbStock({ db: store.db, folder, lock: (n, fn) => store.withLock(n, fn), index: store.ticketIndex() });
    const stock = mk('sandbox');

    // ---- upload and count ----
    const pdf = samplePdf({ type: 'adult', number: 'DB-1' });
    const up = await stock.addUpload('adult', null, 'ticket-1.pdf', pdf);
    assert.ok(/~ticket-1\.pdf$/.test(up.path), 'path keeps the file name for the extension');
    assert.equal((await stock.counts(['adult'])).adult.open, 1);

    // the same bytes cannot be uploaded twice into one folder
    await assert.rejects(stock.addUpload('adult', null, 'copy.pdf', pdf), (e) => e.code === 'duplicate');
    // non-ticket extensions and fake PDFs are refused
    await assert.rejects(stock.addUpload('adult', null, 'virus.exe', Buffer.from('MZ')), (e) => e.code === 'invalid');
    await assert.rejects(stock.addUpload('adult', null, 'fake.pdf', Buffer.from('hello')), (e) => e.code === 'invalid');

    // ---- reserve -> reserved, read bytes, release -> back in stock ----
    const held = await stock.reserve('BP-ABCDEFGH', null, [{ typeId: 'adult', qty: 1 }]);
    assert.equal(held.length, 1);
    assert.equal((await stock.counts(['adult'])).adult.open, 0);
    assert.equal(await stock.countReserved(), 1);

    const file = await stock.read(held[0].reservedPath);
    assert.ok(file.buffer.equals(pdf), 'the exact bytes are read back');
    assert.equal(file.filename, 'ticket-1.pdf');
    assert.equal(file.mime, 'application/pdf');
    assert.equal((await stock.stat(held[0].reservedPath)).size, pdf.length);

    await stock.release('BP-ABCDEFGH', held);
    assert.equal((await stock.counts(['adult'])).adult.open, 1);
    assert.equal(await stock.countReserved(), 0);

    // ---- reserve -> finalize -> sold, fingerprint recorded, never re-sold ----
    const held2 = await stock.reserve('BP-ABCDEFGH', null, [{ typeId: 'adult', qty: 1 }]);
    const sold = await stock.finalize('BP-ABCDEFGH', held2);
    assert.equal(sold.length, 1);
    assert.equal(sold[0].original, 'ticket-1.pdf');
    assert.equal(await store.ticketIndex().lookup(held2[0].hash), 'BP-ABCDEFGH');
    assert.equal((await stock.counts(['adult'])).adult.open, 0);
    await assert.rejects(stock.addUpload('adult', null, 'again.pdf', pdf), (e) => e.code === 'duplicate');

    // a sold ticket can still be read (it lives in the same row)
    const soldFile = await stock.read(sold[0].path);
    assert.ok(soldFile.buffer.equals(pdf));

    // ---- all-or-nothing reserve ----
    const two = [samplePdf({ number: 'DB-2' }), samplePdf({ number: 'DB-3' })];
    await stock.addUpload('adult', null, 'a.pdf', two[0]);
    await stock.addUpload('adult', null, 'b.pdf', two[1]);
    await assert.rejects(stock.reserve('BP-23456789', null, [{ typeId: 'adult', qty: 5 }]), (e) => e.code === 'SOLD_OUT');
    assert.equal((await stock.counts(['adult'])).adult.open, 2, 'a failed reserve takes nothing');
    assert.equal(await stock.countReserved(), 0);

    // ---- date-specific stock is used before the any-day pool ----
    const datedPdf = samplePdf({ number: 'DATED-1' });
    await stock.addUpload('child', day(5), 'dated.pdf', datedPdf);
    const pick = await stock.reserve('BP-ABCDEFGH', day(5), [{ typeId: 'child', qty: 1 }]);
    assert.equal(pick.length, 1);
    const counts = await stock.counts(['child']);
    assert.equal(counts.child.dated[day(5)] || 0, 0, 'the dated ticket was chosen for that day');
    await stock.release('BP-ABCDEFGH', pick);

    // ---- orphans come back, active orders keep their hold ----
    const orphan = await stock.reserve('BP-ABCDEFGH', null, [{ typeId: 'adult', qty: 1 }]);
    await stock.recoverOrphans(async () => true, 0);
    assert.equal(await stock.countReserved(), 1, 'an active order keeps its reserved ticket');
    await stock.recoverOrphans(async () => false, 0);
    assert.equal(await stock.countReserved(), 0, 'an orphaned reservation is returned');
    assert.equal((await stock.counts(['adult'])).adult.open, 2);

    // ---- removeFile ----
    const list = await stock.listFiles('adult');
    assert.equal(list.total, 2);
    assert.equal(await stock.removeFile('adult', null, list.files[0]), true);
    assert.equal((await stock.listFiles('adult')).total, 1);

    // ---- findDuplicates (rows injected directly, as a legacy file import could) ----
    const twin = samplePdf({ number: 'TWIN-DB' });
    await stock.addUpload('adult', null, 'twin-a.pdf', twin);
    db.state.tickets.push({ id: 'dup-row', folder: 'sandbox', type_id: 'adult', valid_date: null, status: 'stock', order_id: null, filename: 'twin-b.pdf', mime: 'application/pdf', size: twin.length, sha256: require('crypto').createHash('sha256').update(twin).digest('hex'), data: twin, reserved_at: null, sold_at: null });
    const scan = await stock.findDuplicates({ fix: true });
    assert.equal(scan.duplicates.length, 1);
    assert.equal(scan.duplicates[0].keep, 'twin-a.pdf');
    assert.equal((await stock.listFiles('adult')).total, 2, 'the duplicate row was removed');

    // ---- live and sandbox stocks are isolated ----
    const live = mk('live');
    assert.equal((await live.counts(['adult'])).adult.open, 0);
    await live.addUpload('adult', null, 'live-1.pdf', samplePdf({ number: 'LIVE-1' }));
    assert.equal((await live.counts(['adult'])).adult.open, 1);
    assert.equal((await stock.counts(['adult'])).adult.open, 2, 'the sandbox stock is untouched');

    await neon.close();
  });

  await test('full app with DATABASE_URL: createApp loads the database before serving', async () => {
    const config = require('../src/config');
    const db = fakeDb();
    const neon = await fakeNeonServer(db);
    const dbDir = path.join(TMP, 'dbapp-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(dbDir, { recursive: true });
    const cfg = { ...config, dataDir: dbDir, databaseUrl: 'postgresql://u:p@fake/db', databaseEndpoint: neon.url };
    const app2 = createApp(cfg);
    assert.equal(typeof app2.ready.then, 'function', 'createApp exposes a ready promise');
    await app2.ready;
    const { DbStore } = require('../src/dbstore');
    const { DbStock } = require('../src/dbstock');
    assert.ok(app2.store instanceof DbStore, 'the database store is in use');
    assert.ok(app2.payments.dbTickets, 'tickets are stored in the database');
    assert.ok(app2.payments.stock() instanceof DbStock, 'the app serves the database-backed stock');
    await app2.store.saveSettings({ ...app2.booking.settings(), siteName: 'Neon Shop' });
    assert.equal(app2.booking.settings().siteName, 'Neon Shop');
    // PayPal settings now round-trip through the database too.
    await app2.store.savePaypal({ mode: 'sandbox', sandbox: { clientId: 'cid', clientSecret: 'sec' } });
    assert.equal(app2.payments.saved().mode, 'sandbox');
    assert.equal(app2.payments.keys('sandbox').clientId, 'cid');
    app2.server.close();
    await neon.close();
  });

  // ---------------------------------------------------------------- done
  app.server.close();

  await pp.close();
  await smtp.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
