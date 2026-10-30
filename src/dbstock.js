'use strict';
/**
 * Neon-backed ticket stock: the same API as src/stock.js, but every ticket
 * (the file bytes included) lives in the bp_tickets table of the database, so
 * the app needs no disk and several instances can share one stock.
 *
 * Life of a ticket, expressed as a row status:
 *
 *   stock --reserve--> reserved --finalize--> sold
 *          ^-- release / orphan recovery --'
 *
 * Rows are only ever moved while holding the app's cross-instance stock lock
 * (bp_locks, via Store.withLock), which gives the all-or-nothing behaviour that
 * rename() gave the file version. A SHA-256 per ticket, kept in bp_ticket_sold
 * once sold, means the same ticket can never be sold twice.
 *
 * A ticket "path" handed to the rest of the app looks like "<rowId>~<filename>":
 * enough to read the bytes back (read/stat) and to show the file extension.
 */
const crypto = require('crypto');
const path = require('path');
const { safeFilename, log } = require('./util');
const { mimeFor } = require('./http');
const { SoldOutError, UploadError, TICKET_EXT, DATE_DIR_RE, TYPE_ID_RE, isTicketName } = require('./stock');

const MAGIC = {
  '.pdf': (b) => b.subarray(0, 1024).includes('%PDF-'),
  '.png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.pkpass': (b) => b[0] === 0x50 && b[1] === 0x4b,
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ticketKey(id, filename) {
  return `${id}~${filename}`;
}

function parseKey(rel) {
  const s = String(rel == null ? '' : rel);
  const i = s.indexOf('~');
  return i < 0 ? { id: s, filename: '' } : { id: s.slice(0, i), filename: s.slice(i + 1) };
}

/** bytea comes back from the HTTP endpoint as '\x<hex>'; accept a real Buffer too. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  const s = String(value == null ? '' : value);
  if (s.startsWith('\\x')) return Buffer.from(s.slice(2), 'hex');
  return Buffer.from(s, 'utf8');
}

function notFound(message = 'File not found.') {
  const e = new Error(message);
  e.status = 404;
  return e;
}

function placeholders(from, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push('$' + (from + i));
  return out.join(',');
}

class DbStock {
  /**
   * @param {{db:{query:Function}, folder:string, lock?:Function, index?:{lookup:Function, record:Function}}} opts
   *   db      a NeonClient (or anything with query(text, params))
   *   folder  'live' or 'sandbox' — the stock the events/orders of that mode use
   *   lock    cross-instance mutual exclusion (Store.withLock); without it, stock
   *           changes are only serialised inside this process
   *   index   sold-fingerprint store (DbTicketIndex); without it bp_ticket_sold is used
   */
  constructor({ db, folder, lock, index } = {}) {
    if (!db || typeof db.query !== 'function') throw new Error('DbStock needs a database client.');
    this.db = db;
    this.folder = folder === 'live' ? 'live' : 'sandbox';
    this.root = `bp_tickets/${this.folder}`; // shown on the dashboard and in logs
    this._lock = lock || ((name, fn) => fn());
    this._index = index || null;
  }

  static available(counts, typeId, date) {
    const c = counts[typeId];
    if (!c) return 0;
    return c.open + ((date && c.dated[date]) || 0);
  }

  _q(text, params) {
    return this.db.query(text, params || []);
  }

  /** Run stock-changing operations one at a time — in this process and across instances. */
  _serial(fn) {
    return Promise.resolve().then(() => this._lock('stock-' + this.folder, fn));
  }

  // Kept so callers that used the file version keep working.
  ensureTypeDirs() {}
  invalidate() {}
  async warmHashes() {}

  // ---- listing --------------------------------------------------------------
  async counts(typeIds) {
    const out = {};
    const ids = (typeIds || []).filter((t) => TYPE_ID_RE.test(t));
    for (const t of typeIds || []) out[t] = { open: 0, dated: {} };
    if (!ids.length) return out;
    const r = await this._q(
      `SELECT type_id, valid_date, count(*) AS n FROM bp_tickets WHERE folder = $1 AND status = 'stock' AND type_id IN (${placeholders(2, ids.length)}) GROUP BY type_id, valid_date`,
      [this.folder, ...ids]
    );
    for (const row of r.rows) {
      if (!out[row.type_id]) out[row.type_id] = { open: 0, dated: {} };
      const n = Number(row.n) || 0;
      const day = row.valid_date == null ? '' : String(row.valid_date);
      if (day) out[row.type_id].dated[day] = (out[row.type_id].dated[day] || 0) + n;
      else out[row.type_id].open += n;
    }
    return out;
  }

  async listFiles(typeId, date, limit = 500) {
    if (!TYPE_ID_RE.test(typeId) || (date && !DATE_DIR_RE.test(date))) return { total: 0, files: [] };
    const cond = date ? 'valid_date = $3' : 'valid_date IS NULL';
    const params = date ? [this.folder, typeId, date] : [this.folder, typeId];
    const r = await this._q(
      `SELECT filename FROM bp_tickets WHERE folder = $1 AND type_id = $2 AND status = 'stock' AND ${cond} ORDER BY filename`,
      params
    );
    const names = r.rows.map((x) => x.filename);
    return { total: names.length, files: names.slice(0, limit) };
  }

  async countReserved() {
    const r = await this._q(`SELECT count(*) AS n FROM bp_tickets WHERE folder = $1 AND status = 'reserved'`, [this.folder]);
    return Number(r.rows[0] && r.rows[0].n) || 0;
  }

  async _soldOrderForHash(hash) {
    if (this._index) return this._index.lookup(hash);
    const r = await this._q(`SELECT order_id FROM bp_ticket_sold WHERE hash = $1`, [hash]);
    return r.rows.length ? r.rows[0].order_id : null;
  }

  // ---- reserve / release / finalize -----------------------------------------
  /**
   * Move `qty` stock rows per type into `reserved` for orderId.
   * Date-specific rows are used first, then the open pool. All-or-nothing: if a
   * type is short, everything taken so far goes back and SoldOutError is thrown.
   */
  reserve(orderId, date, items) {
    return this._serial(async () => {
      const used = new Set();
      const taken = [];
      try {
        for (const { typeId, qty } of items || []) {
          if (!qty) continue;
          if (!TYPE_ID_RE.test(typeId)) throw new Error('Invalid ticket type ' + typeId);
          const picked = await this._pick(typeId, date, qty, used);
          if (picked.length < qty) throw new SoldOutError({ typeId, requested: qty, available: picked.length });
          const ids = picked.map((p) => p.id);
          await this._q(
            `UPDATE bp_tickets SET status = 'reserved', order_id = $1, reserved_at = now() WHERE folder = $2 AND status = 'stock' AND id IN (${placeholders(3, ids.length)})`,
            [orderId, this.folder, ...ids]
          );
          for (const p of picked) {
            used.add(p.sha256);
            taken.push({
              typeId,
              stockPath: `${typeId}/${p.valid_date || ''}/${p.filename}`.replace(/\/{2,}/g, '/'),
              reservedPath: ticketKey(p.id, p.filename),
              hash: p.sha256,
              id: p.id,
              folder: this.folder,
            });
          }
        }
        return taken;
      } catch (e) {
        await this._releaseIds(taken.map((t) => t.id)).catch(() => {});
        throw e;
      }
    });
  }

  async _pick(typeId, date, qty, used) {
    const picked = [];
    const passes = [];
    if (date && DATE_DIR_RE.test(date)) passes.push(true);
    passes.push(false);
    for (const dated of passes) {
      if (picked.length >= qty) break;
      const cond = dated ? 'valid_date = $3' : 'valid_date IS NULL';
      const params = dated ? [this.folder, typeId, date] : [this.folder, typeId];
      const r = await this._q(
        `SELECT id, filename, sha256, valid_date FROM bp_tickets WHERE folder = $1 AND type_id = $2 AND status = 'stock' AND ${cond} ORDER BY filename`,
        params
      );
      for (const row of r.rows) {
        if (picked.length >= qty) break;
        if (used.has(row.sha256) || picked.some((p) => p.sha256 === row.sha256)) continue;
        if (await this._soldOrderForHash(row.sha256)) continue;
        picked.push({ id: row.id, filename: row.filename, sha256: row.sha256, valid_date: row.valid_date || null });
      }
    }
    return picked;
  }

  async _releaseIds(ids) {
    if (!ids.length) return;
    await this._q(
      `UPDATE bp_tickets SET status = 'stock', order_id = NULL, reserved_at = NULL WHERE folder = $1 AND status = 'reserved' AND id IN (${placeholders(2, ids.length)})`,
      [this.folder, ...ids]
    );
  }

  /** Put reserved tickets back into stock (checkout abandoned / cancelled). */
  release(orderId, entries) {
    return this._serial(async () => {
      const ids = (entries || []).map((e) => e && e.id).filter(Boolean);
      await this._releaseIds(ids);
    });
  }

  /** Which reserved entries are no longer reserved for this order. */
  async missing(entries) {
    const list = (entries || []).filter((e) => e && e.id);
    if (!list.length) return [];
    const ids = list.map((e) => e.id);
    const r = await this._q(
      `SELECT id FROM bp_tickets WHERE folder = $1 AND status = 'reserved' AND id IN (${placeholders(2, ids.length)})`,
      [this.folder, ...ids]
    );
    const present = new Set(r.rows.map((x) => x.id));
    return list.filter((e) => !present.has(e.id));
  }

  /** Mark reserved rows as sold and remember their fingerprints. */
  finalize(orderId, entries) {
    return this._serial(async () => {
      const list = (entries || []).filter((e) => e && e.id);
      if (list.length) {
        const ids = list.map((e) => e.id);
        await this._q(
          `UPDATE bp_tickets SET status = 'sold', sold_at = now(), order_id = $1 WHERE folder = $2 AND status = 'reserved' AND id IN (${placeholders(3, ids.length)})`,
          [orderId, this.folder, ...ids]
        );
      }
      const sold = [];
      for (const e of list) {
        const r = await this._q(`SELECT filename, sha256 FROM bp_tickets WHERE id = $1`, [e.id]);
        const filename = r.rows.length ? r.rows[0].filename : parseKey(e.reservedPath).filename || 'ticket';
        const hash = (r.rows.length ? r.rows[0].sha256 : e.hash) || null;
        sold.push({ typeId: e.typeId, path: ticketKey(e.id, filename), original: filename, hash });
      }
      const fingerprints = sold.filter((s) => s.hash).map((s) => ({ hash: s.hash, orderId }));
      if (fingerprints.length) {
        if (this._index) await this._index.record(fingerprints);
        else for (const f of fingerprints) await this._q(`INSERT INTO bp_ticket_sold (hash, order_id) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`, [f.hash, f.orderId]);
      }
      return sold;
    });
  }

  /**
   * Return reserved tickets that belong to no active order to stock.
   * isActive(orderId) -> Promise<boolean>
   */
  recoverOrphans(isActive, minAgeMs = 5 * 60 * 1000) {
    return this._serial(async () => {
      const r = await this._q(`SELECT id, order_id, reserved_at FROM bp_tickets WHERE folder = $1 AND status = 'reserved'`, [this.folder]);
      const stale = [];
      for (const row of r.rows) {
        const age = Date.now() - (Date.parse(row.reserved_at || 0) || 0);
        if (row.reserved_at && age < minAgeMs) continue;
        if (row.order_id && (await isActive(row.order_id))) continue;
        stale.push(row.id);
      }
      if (stale.length) {
        await this._releaseIds(stale);
        log(`Returned ${stale.length} orphaned reserved ticket(s) to the ${this.folder} stock`);
      }
      return stale.length;
    });
  }

  // ---- admin: upload / remove / duplicates ----------------------------------
  addUpload(typeId, date, originalName, buffer) {
    if (!TYPE_ID_RE.test(typeId)) return Promise.reject(new UploadError('Unknown ticket type.'));
    if (date && !DATE_DIR_RE.test(date)) return Promise.reject(new UploadError('Invalid date.'));
    const name = safeFilename(originalName);
    const ext = path.extname(name).toLowerCase();
    if (!TICKET_EXT.includes(ext)) return Promise.reject(new UploadError(`${name}: only ${TICKET_EXT.join(' ')} files can be tickets.`));
    if (!buffer || !buffer.length) return Promise.reject(new UploadError(`${name}: the file is empty.`));
    if (MAGIC[ext] && !MAGIC[ext](buffer)) return Promise.reject(new UploadError(`${name}: this is not a valid ${ext.slice(1).toUpperCase()} file.`));
    const hash = sha256(buffer);
    return this._serial(async () => {
      const soldIn = await this._soldOrderForHash(hash);
      if (soldIn) throw new UploadError(`${name}: this exact ticket was already sold (order ${soldIn}). Skipped.`, 'duplicate');
      const resv = await this._q(`SELECT order_id FROM bp_tickets WHERE sha256 = $1 AND status = 'reserved' LIMIT 1`, [hash]);
      if (resv.rows.length) throw new UploadError(`${name}: this ticket is already in stock (reserved). Skipped.`, 'duplicate');
      const same = await this._q(`SELECT filename FROM bp_tickets WHERE folder = $1 AND sha256 = $2 AND status = 'stock' LIMIT 1`, [this.folder, hash]);
      if (same.rows.length) throw new UploadError(`${name}: identical to ${same.rows[0].filename}, already in stock. Skipped.`, 'duplicate');

      const cond = date ? 'valid_date = $4' : 'valid_date IS NULL';
      const params = date ? [this.folder, typeId, 'stock', date] : [this.folder, typeId, 'stock'];
      const existing = await this._q(`SELECT filename FROM bp_tickets WHERE folder = $1 AND type_id = $2 AND status = $3 AND ${cond}`, params);
      const taken = new Set(existing.rows.map((x) => x.filename));
      let finalName = name;
      if (taken.has(finalName)) {
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const suffix = dot > 0 ? name.slice(dot) : '';
        for (let i = 2; i < 10000; i++) {
          const candidate = `${base}-${i}${suffix}`;
          if (!taken.has(candidate)) {
            finalName = candidate;
            break;
          }
        }
      }
      const id = crypto.randomUUID();
      const mime = mimeFor(finalName);
      await this._q(
        `INSERT INTO bp_tickets (id, folder, type_id, valid_date, status, filename, mime, size, sha256, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bytea)`,
        [id, this.folder, typeId, date || null, 'stock', finalName, mime, buffer.length, hash, buffer]
      );
      return { name: finalName, path: ticketKey(id, finalName) };
    });
  }

  removeFile(typeId, date, name) {
    return this._serial(async () => {
      if (!TYPE_ID_RE.test(typeId) || (date && !DATE_DIR_RE.test(date)) || !isTicketName(String(name)) || /[\\/]/.test(String(name))) {
        throw new UploadError('Invalid file.');
      }
      const cond = date ? 'valid_date = $4' : 'valid_date IS NULL';
      const params = date ? [this.folder, typeId, String(name), date] : [this.folder, typeId, String(name)];
      const r = await this._q(`SELECT id FROM bp_tickets WHERE folder = $1 AND type_id = $2 AND filename = $3 AND status = 'stock' AND ${cond} LIMIT 1`, params);
      if (!r.rows.length) throw new UploadError('That file is no longer in stock.');
      await this._q(`DELETE FROM bp_tickets WHERE id = $1`, [r.rows[0].id]);
      return true;
    });
  }

  /** Find identical files in stock (and files identical to already-sold tickets). */
  findDuplicates({ fix = false } = {}) {
    return this._serial(async () => {
      const r = await this._q(`SELECT id, filename, sha256 FROM bp_tickets WHERE folder = $1 AND status = 'stock' ORDER BY filename`, [this.folder]);
      const byHash = new Map();
      for (const row of r.rows) {
        if (!byHash.has(row.sha256)) byHash.set(row.sha256, []);
        byHash.get(row.sha256).push(row);
      }
      const duplicates = [];
      const alreadySold = [];
      const removeIds = [];
      for (const [hash, list] of byHash) {
        const soldIn = await this._soldOrderForHash(hash);
        if (soldIn) {
          for (const row of list) {
            alreadySold.push({ file: row.filename, soldIn });
            removeIds.push(row.id);
          }
          continue;
        }
        if (list.length < 2) continue;
        duplicates.push({ keep: list[0].filename, duplicates: list.slice(1).map((row) => row.filename) });
        for (const row of list.slice(1)) removeIds.push(row.id);
      }
      if (fix && removeIds.length) {
        await this._q(`DELETE FROM bp_tickets WHERE folder = $1 AND id IN (${placeholders(2, removeIds.length)})`, [this.folder, ...removeIds]);
      }
      return { duplicates, alreadySold, fixed: !!fix };
    });
  }

  // ---- reading the bytes (replaces Stock.absolute) ---------------------------
  async read(rel) {
    const { id } = parseKey(rel);
    const r = await this._q(`SELECT filename, mime, size, data FROM bp_tickets WHERE id = $1`, [id]);
    if (!r.rows.length) throw notFound();
    const row = r.rows[0];
    const buffer = toBuffer(row.data);
    return { buffer, mime: row.mime || mimeFor(row.filename), filename: row.filename, size: Number(row.size) || buffer.length };
  }

  async stat(rel) {
    const { id } = parseKey(rel);
    const r = await this._q(`SELECT filename, mime, size FROM bp_tickets WHERE id = $1`, [id]);
    if (!r.rows.length) throw notFound();
    const row = r.rows[0];
    return { mime: row.mime || mimeFor(row.filename), filename: row.filename, size: Number(row.size) || 0 };
  }
}

module.exports = { DbStock, ticketKey, parseKey };
