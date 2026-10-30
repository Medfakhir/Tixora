'use strict';
/**
 * File-based storage: one JSON file per order (data/orders/BP-XXXXXXXX.json)
 * plus data/settings.json. Writes are atomic (temp file + rename) and every
 * change to an order happens under a lock that also works across processes,
 * so it is safe on hosts that start more than one Node process.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ORDER_ID_RE, newOrderId, sleep, logError } = require('./util');
const { withDefaults } = require('./settings');

async function writeAtomic(file, data, { mode } = {}) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, data, mode ? { mode } : undefined);
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

function pidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.ordersDir = path.join(dataDir, 'orders');
    this.locksDir = path.join(dataDir, 'locks');
    this.outboxDir = path.join(dataDir, 'outbox');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.stateFile = path.join(dataDir, 'state.json');
    this.mailFile = path.join(dataDir, 'mail.json');
    this.activityFile = path.join(dataDir, 'activity.json');
    this.paypalFile = path.join(dataDir, 'paypal.json');
    for (const d of [this.dir, this.ordersDir, this.locksDir, this.outboxDir]) fs.mkdirSync(d, { recursive: true });
    this._settings = null;
    this._settingsMtime = -1;
    this._mail = null;
    this._mailMtime = -1;
    this._paypal = null;
    this._paypalKey = '';
    this._orderCache = new Map();
    this._chains = new Map();
    this._clearDeadLocks();
  }

  // ---- mail settings (SMTP + email templates) -------------------------------
  getMail() {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.mailFile).mtimeMs;
    } catch {}
    if (!this._mail || mtime !== this._mailMtime) {
      let stored = null;
      try {
        stored = JSON.parse(fs.readFileSync(this.mailFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') logError('Could not read mail.json, using defaults:', e.message);
      }
      this._mail = stored && typeof stored === 'object' ? stored : {};
      this._mailMtime = mtime;
    }
    return this._mail;
  }

  async saveMail(mail) {
    const data = { ...mail, updatedAt: new Date().toISOString() };
    await writeAtomic(this.mailFile, JSON.stringify(data, null, 2));
    this._mail = null;
    return this.getMail();
  }

  // ---- PayPal settings (data/paypal.json, readable by the app only) ----------
  getPaypal() {
    let key = 'none';
    try {
      const st = fs.statSync(this.paypalFile);
      key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {}
    if (this._paypal && key === this._paypalKey) return this._paypal;
    let stored = null;
    if (key !== 'none') {
      try {
        stored = JSON.parse(fs.readFileSync(this.paypalFile, 'utf8'));
      } catch (e) {
        logError('Could not read data/paypal.json:', e.message);
        if (this._paypal) return this._paypal;
      }
    }
    this._paypal = stored && typeof stored === 'object' ? stored : {};
    this._paypalKey = key;
    return this._paypal;
  }

  async savePaypal(data) {
    const clean = data && typeof data === 'object' ? data : {};
    await writeAtomic(this.paypalFile, JSON.stringify(clean, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.paypalFile, 0o600);
    } catch {}
    this._paypal = clean;
    this._paypalKey = '';
    return this.getPaypal();
  }

  // ---- activity log (a capped, newest-last JSON array) ----------------------
  async readActivity() {
    try {
      const data = JSON.parse(await fsp.readFile(this.activityFile, 'utf8'));
      if (Array.isArray(data)) return data;
      return Array.isArray(data && data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  async appendActivity(entry, { max = 2000 } = {}) {
    return this.withLock('activity', async () => {
      const list = await this.readActivity();
      list.push(entry);
      if (list.length > max) list.splice(0, list.length - max);
      await writeAtomic(this.activityFile, JSON.stringify(list, null, 2));
      return entry;
    });
  }

  // ---- settings -------------------------------------------------------------
  getSettings() {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.settingsFile).mtimeMs;
    } catch {}
    if (!this._settings || mtime !== this._settingsMtime) {
      let stored = null;
      try {
        stored = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') logError('Could not read settings.json, using defaults:', e.message);
      }
      this._settings = withDefaults(stored);
      this._settingsMtime = mtime;
    }
    return this._settings;
  }

  async saveSettings(settings) {
    const data = { ...settings, updatedAt: new Date().toISOString() };
    await writeAtomic(this.settingsFile, JSON.stringify(data, null, 2));
    this._settings = null;
    return this.getSettings();
  }

  // ---- small key/value state (alert timestamps etc.) -------------------------
  async getState() {
    try {
      return JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async updateState(fn) {
    return this.withLock('state', async () => {
      const s = await this.getState();
      await fn(s);
      await writeAtomic(this.stateFile, JSON.stringify(s, null, 2));
      return s;
    });
  }

  // ---- orders ---------------------------------------------------------------
  orderFile(id) {
    if (!ORDER_ID_RE.test(String(id))) return null;
    return path.join(this.ordersDir, id + '.json');
  }

  async newOrderId() {
    for (let i = 0; i < 20; i++) {
      const id = newOrderId();
      if (!fs.existsSync(this.orderFile(id))) return id;
    }
    throw new Error('Could not allocate an order id');
  }

  async getOrder(id) {
    const f = this.orderFile(id);
    if (!f) return null;
    try {
      return JSON.parse(await fsp.readFile(f, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Create a new order file; fails if the id already exists. */
  async insertOrder(order) {
    const f = this.orderFile(order.id);
    if (!f) throw new Error('Invalid order id');
    const data = JSON.stringify(order, null, 2);
    const tmp = `${f}.${process.pid}.new.tmp`;
    await fsp.writeFile(tmp, data);
    try {
      await fsp.link(tmp, f); // atomic "create if not exists"
    } catch (e) {
      // Some file systems (certain shared hosts / mounted volumes) don't support hard links.
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP'].includes(e.code)) throw e;
      await fsp.writeFile(f, data, { flag: 'wx' });
    } finally {
      await fsp.unlink(tmp).catch(() => {});
    }
  }

  async saveOrder(order) {
    order.updatedAt = new Date().toISOString();
    await writeAtomic(this.orderFile(order.id), JSON.stringify(order, null, 2));
  }

  async deleteOrder(id) {
    const f = this.orderFile(id);
    if (f) await fsp.unlink(f).catch(() => {});
    this._orderCache.delete(id);
  }

  /**
   * Load → modify → save under the order's lock. `fn(order)` may be async.
   * Saves only if something changed. Returns fn's return value (or the order).
   */
  async updateOrder(id, fn) {
    return this.withLock('order-' + id, async () => {
      const order = await this.getOrder(id);
      if (!order) return null;
      const before = JSON.stringify(order);
      const result = await fn(order);
      if (JSON.stringify(order) !== before) await this.saveOrder(order);
      return result === undefined ? order : result;
    });
  }

  /** All orders (read-only objects; cached by file mtime). */
  async listOrders() {
    let names;
    try {
      names = await fsp.readdir(this.ordersDir);
    } catch {
      return [];
    }
    const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => ORDER_ID_RE.test(id));
    const out = [];
    const seen = new Set();
    const BATCH = 64;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(
        ids.slice(i, i + BATCH).map(async (id) => {
          const f = path.join(this.ordersDir, id + '.json');
          let st;
          try {
            st = await fsp.stat(f);
          } catch {
            return;
          }
          seen.add(id);
          const c = this._orderCache.get(id);
          if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
            out.push(c.order);
            return;
          }
          try {
            const order = JSON.parse(await fsp.readFile(f, 'utf8'));
            this._orderCache.set(id, { mtimeMs: st.mtimeMs, size: st.size, order });
            out.push(order);
          } catch (e) {
            logError('Skipping unreadable order file', id, e.message);
          }
        })
      );
    }
    for (const id of this._orderCache.keys()) if (!seen.has(id)) this._orderCache.delete(id);
    return out;
  }

  // ---- locks ----------------------------------------------------------------
  /**
   * Mutual exclusion by name: an in-process queue plus a lock file
   * (data/locks/<name>.lock, created with O_EXCL) for other processes.
   */
  async withLock(name, fn, { waitMs = 30000, staleMs = 120000 } = {}) {
    const prev = this._chains.get(name) || Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const chain = prev.then(() => mine);
    this._chains.set(name, chain);
    await prev;
    try {
      const lockFile = path.join(this.locksDir, name.replace(/[^A-Za-z0-9_-]/g, '_') + '.lock');
      await this._acquire(lockFile, waitMs, staleMs);
      // Keep the lock fresh while we work (slow email or PayPal calls), so another
      // process never mistakes it for an abandoned lock.
      const heartbeat = setInterval(() => {
        const t = new Date();
        fs.utimes(lockFile, t, t, () => {});
      }, Math.max(100, Math.floor(staleMs / 4)));
      heartbeat.unref();
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
        await fsp.unlink(lockFile).catch(() => {});
      }
    } finally {
      release();
      if (this._chains.get(name) === chain) this._chains.delete(name);
    }
  }

  async _acquire(file, waitMs, staleMs) {
    const start = Date.now();
    for (;;) {
      try {
        await fsp.writeFile(file, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      try {
        const [content, st] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
        const pid = parseInt(content, 10);
        const stale = Date.now() - st.mtimeMs > staleMs || (pid && pid !== process.pid && !pidAlive(pid));
        if (stale) {
          await fsp.unlink(file).catch(() => {});
          continue;
        }
      } catch (e) {
        if (e.code === 'ENOENT') continue;
      }
      if (Date.now() - start > waitMs) throw new Error('Timed out waiting for lock ' + path.basename(file));
      await sleep(30 + Math.random() * 70);
    }
  }

  _clearDeadLocks() {
    let names = [];
    try {
      names = fs.readdirSync(this.locksDir);
    } catch {
      return;
    }
    for (const n of names) {
      const f = path.join(this.locksDir, n);
      try {
        const pid = parseInt(fs.readFileSync(f, 'utf8'), 10);
        if (!pid || pid === process.pid || !pidAlive(pid)) fs.unlinkSync(f);
      } catch {}
    }
  }
}

module.exports = { Store, writeAtomic };
