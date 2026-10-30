'use strict';
/**
 * Neon-backed storage. It extends the file Store so every property the rest of
 * the app expects (dir, outboxDir, withLock, ...) is still there, but the data
 * itself lives in Postgres:
 *
 *   settings / mail / state / paypal   one row each in bp_documents
 *   orders                             bp_orders
 *   activity log                       bp_activity
 *   sold ticket fingerprints           bp_ticket_sold
 *
 * The small documents are cached in memory so the app's synchronous getters
 * (getSettings, getMail, getPaypal) keep working unchanged. Everything is loaded
 * by init() before the server starts listening. Ticket files, the outbox and
 * per-file fingerprint caches stay on disk, because they are tied to the files
 * themselves (a persistent volume), which is the agreed design.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Store } = require('./store');
const { NeonClient } = require('./neon');
const { withDefaults } = require('./settings');
const { ORDER_ID_RE, newOrderId, sleep, nowIso, log, logError } = require('./util');
const dbschema = require('./dbschema');

const DOCS = ['settings', 'mail', 'state', 'paypal'];

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** The sold-fingerprint index promised to Stock, backed by bp_ticket_sold. */
class DbTicketIndex {
  constructor(db) {
    this.db = db;
  }

  async lookup(hash) {
    const r = await this.db.query('SELECT order_id FROM bp_ticket_sold WHERE hash = $1', [hash]);
    return r.rows.length ? r.rows[0].order_id : null;
  }

  async record(entries) {
    for (const e of entries || []) {
      if (!e || !e.hash) continue;
      try {
        await this.db.query('INSERT INTO bp_ticket_sold (hash, order_id) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING', [
          e.hash,
          String(e.orderId || '?'),
        ]);
      } catch (err) {
        logError('Could not record a sold ticket fingerprint:', err.message);
      }
    }
  }
}

class DbStore extends Store {
  /**
   * @param {string} dataDir
   * @param {string|{query:Function}} database  connection string, or an object with query() for tests
   * @param {object} [opts] passed to NeonClient (fetchImpl, endpoint)
   */
  constructor(dataDir, database, opts = {}) {
    super(dataDir);
    this.db = typeof database === 'string' ? new NeonClient(database, opts) : database;
    if (!this.db || typeof this.db.query !== 'function') throw new Error('A database client (or connection string) is required.');
    this._settings = null;
    this._mail = {};
    this._state = {};
    this._paypal = {};
    this._ticketIndex = null;
    this._initialized = false;
  }

  /** One shared index: sold hashes are global across real and test ticket folders. */
  ticketIndex() {
    if (!this._ticketIndex) this._ticketIndex = new DbTicketIndex(this.db);
    return this._ticketIndex;
  }

  /** Create the schema, import any existing files, and load the documents. */
  async init() {
    if (this._initialized) return this;
    await dbschema.ensure(this.db);
    await this._migrate();
    await this._loadDocs();
    this._initialized = true;
    log('Database ready (settings, orders, activity, tickets and PayPal are stored in Neon)');
    return this;
  }

  async _loadDocs() {
    const r = await this.db.query('SELECT name, data FROM bp_documents');
    const docs = {};
    for (const row of r.rows) docs[row.name] = parseJson(row.data, null);
    this._settings = withDefaults(docs.settings || null);
    this._mail = docs.mail && typeof docs.mail === 'object' ? docs.mail : {};
    this._state = docs.state && typeof docs.state === 'object' ? docs.state : {};
    this._paypal = docs.paypal && typeof docs.paypal === 'object' ? docs.paypal : {};
  }

  async _putDoc(name, data) {
    await this.db.query(
      'INSERT INTO bp_documents (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET data = excluded.data, updated_at = now()',
      [name, JSON.stringify(data)]
    );
  }

  // ---- settings -------------------------------------------------------------
  getSettings() {
    return this._settings || withDefaults(null);
  }

  async saveSettings(settings) {
    const data = { ...settings, updatedAt: nowIso() };
    await this._putDoc('settings', data);
    this._settings = withDefaults(data);
    return this._settings;
  }

  // ---- mail settings --------------------------------------------------------
  getMail() {
    return this._mail;
  }

  async saveMail(mail) {
    const data = { ...mail, updatedAt: nowIso() };
    await this._putDoc('mail', data);
    this._mail = data;
    return this._mail;
  }

  // ---- PayPal settings ------------------------------------------------------
  getPaypal() {
    return this._paypal;
  }

  async savePaypal(data) {
    const clean = data && typeof data === 'object' ? data : {};
    await this._putDoc('paypal', clean);
    this._paypal = clean;
    return this._paypal;
  }

  // ---- small key/value state -------------------------------------------------
  async getState() {
    return this._state;
  }

  async updateState(fn) {
    return this.withLock('state', async () => {
      const s = { ...this._state };
      await fn(s);
      await this._putDoc('state', s);
      this._state = s;
      return s;
    });
  }

  // ---- orders ---------------------------------------------------------------
  async newOrderId() {
    for (let i = 0; i < 20; i++) {
      const id = newOrderId();
      const r = await this.db.query('SELECT 1 AS x FROM bp_orders WHERE id = $1 LIMIT 1', [id]);
      if (!r.rows.length) return id;
    }
    throw new Error('Could not allocate an order id');
  }

  async getOrder(id) {
    if (!ORDER_ID_RE.test(String(id))) return null;
    const r = await this.db.query('SELECT data FROM bp_orders WHERE id = $1', [id]);
    return r.rows.length ? parseJson(r.rows[0].data, null) : null;
  }

  async insertOrder(order) {
    const r = await this.db.query('INSERT INTO bp_orders (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id', [
      order.id,
      JSON.stringify(order),
    ]);
    if (!r.rows.length) throw new Error('Order ' + order.id + ' already exists');
  }

  async saveOrder(order) {
    order.updatedAt = nowIso();
    await this.db.query(
      'INSERT INTO bp_orders (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = now()',
      [order.id, JSON.stringify(order)]
    );
  }

  async deleteOrder(id) {
    await this.db.query('DELETE FROM bp_orders WHERE id = $1', [id]);
  }

  async listOrders() {
    const r = await this.db.query('SELECT data FROM bp_orders');
    const out = [];
    for (const row of r.rows) {
      const o = parseJson(row.data, null);
      if (o) out.push(o);
    }
    return out;
  }

  // ---- activity log ---------------------------------------------------------
  async readActivity() {
    const r = await this.db.query('SELECT entry FROM bp_activity ORDER BY seq');
    const out = [];
    for (const row of r.rows) {
      const e = parseJson(row.entry, null);
      if (e) out.push(e);
    }
    return out;
  }

  async appendActivity(entry, { max = 2000 } = {}) {
    await this.db.query('INSERT INTO bp_activity (entry) VALUES ($1::jsonb)', [JSON.stringify(entry)]);
    await this.db
      .query('DELETE FROM bp_activity WHERE seq <= (SELECT COALESCE(max(seq), 0) FROM bp_activity) - $1', [max])
      .catch((e) => logError('Could not trim the activity log:', e.message));
    return entry;
  }

  // ---- locks (in-process queue + a row in bp_locks for other instances) ------
  async withLock(name, fn, { waitMs = 30000, staleMs = 120000 } = {}) {
    const prev = this._chains.get(name) || Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const chain = prev.then(() => mine);
    this._chains.set(name, chain);
    await prev;
    const owner = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const lockName = String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
    try {
      await this._acquireLock(lockName, owner, staleMs, waitMs);
      const heartbeat = setInterval(() => {
        const t = new Date(Date.now() + staleMs).toISOString();
        this.db
          .query('UPDATE bp_locks SET expires_at = $3::timestamptz WHERE name = $1 AND owner = $2', [lockName, owner, t])
          .catch(() => {});
      }, Math.max(1000, Math.floor(staleMs / 3)));
      heartbeat.unref();
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
        await this.db.query('DELETE FROM bp_locks WHERE name = $1 AND owner = $2', [lockName, owner]).catch(() => {});
      }
    } finally {
      release();
      if (this._chains.get(name) === chain) this._chains.delete(name);
    }
  }

  async _acquireLock(lockName, owner, staleMs, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const expires = new Date(Date.now() + staleMs).toISOString();
      const r = await this.db.query(
        'INSERT INTO bp_locks (name, owner, expires_at) VALUES ($1, $2, $3::timestamptz) ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE bp_locks.expires_at < now() RETURNING owner',
        [lockName, owner, expires]
      );
      if (r.rows.length) return;
      if (Date.now() > deadline) throw new Error('Timed out waiting for lock ' + lockName);
      await sleep(80 + Math.random() * 120);
    }
  }

  // ---- first-run import of existing files -----------------------------------
  async _migrate() {
    const existing = await this.db.query('SELECT name FROM bp_documents');
    const have = new Set(existing.rows.map((r) => r.name));
    for (const name of DOCS) {
      if (have.has(name)) continue;
      const data = this._readJsonFile(path.join(this.dir, name + '.json'));
      if (data !== null) {
        await this._putDoc(name, data);
        log(`Imported data/${name}.json into the database`);
      }
    }

    if (!(await this._isEmpty('SELECT 1 AS x FROM bp_orders LIMIT 1'))) {
      // orders already in the database: nothing to import
    } else {
      let names = [];
      try {
        names = await fsp.readdir(this.ordersDir);
      } catch {}
      let n = 0;
      for (const file of names) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -5);
        if (!ORDER_ID_RE.test(id)) continue;
        const order = this._readJsonFile(path.join(this.ordersDir, file));
        if (order) {
          await this.db.query('INSERT INTO bp_orders (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING', [
            id,
            JSON.stringify(order),
          ]);
          n++;
        }
      }
      if (n) log(`Imported ${n} order(s) into the database`);
    }

    if (await this._isEmpty('SELECT 1 AS x FROM bp_activity LIMIT 1')) {
      const stored = this._readJsonFile(path.join(this.dir, 'activity.json'));
      const list = Array.isArray(stored) ? stored : stored && Array.isArray(stored.entries) ? stored.entries : [];
      for (const e of list) await this.db.query('INSERT INTO bp_activity (entry) VALUES ($1::jsonb)', [JSON.stringify(e)]);
      if (list.length) log(`Imported ${list.length} activity entries into the database`);
    }

    if (await this._isEmpty('SELECT 1 AS x FROM bp_ticket_sold LIMIT 1')) {
      let lines = '';
      try {
        lines = await fsp.readFile(path.join(this.dir, 'sold-hashes.log'), 'utf8');
      } catch {}
      let n = 0;
      for (const line of lines.split('\n')) {
        const [hash, id] = line.trim().split(/\s+/);
        if (hash && /^[a-f0-9]{64}$/.test(hash)) {
          await this.db.query('INSERT INTO bp_ticket_sold (hash, order_id) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING', [hash, id || '?']);
          n++;
        }
      }
      if (n) log(`Imported ${n} sold ticket fingerprint(s) into the database`);
    }
  }

  async _isEmpty(sql) {
    const r = await this.db.query(sql);
    return !r.rows.length;
  }

  _readJsonFile(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
}

module.exports = { DbStore, DbTicketIndex };
