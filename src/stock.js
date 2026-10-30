'use strict';
/**
 * Ticket stock = files in tickets/stock/<type>/ (valid any day) and
 * tickets/stock/<type>/<YYYY-MM-DD>/ (valid only on that date).
 *
 * Life of a ticket file:
 *   stock/…  --reserve-->  reserved/<orderId>/…  --finalize-->  sold/<orderId>/…
 *                 ^------------- release (checkout abandoned) ------'
 *
 * Moves use rename(), which is atomic, so one file can never be given to two
 * orders. A manifest in each reserved folder lets a crashed checkout be put
 * back. A SHA-256 of every sold file is kept so the same ticket (e.g. uploaded
 * twice) is never sold twice.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { safeFilename, logError, log } = require('./util');
const { mimeFor } = require('./http');

const TICKET_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pkpass'];
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MANIFEST = '.manifest.json';
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const MAGIC = {
  '.pdf': (b) => b.subarray(0, 1024).includes('%PDF-'),
  '.png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  '.webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  '.pkpass': (b) => b[0] === 0x50 && b[1] === 0x4b,
};

function isTicketName(name) {
  return !name.startsWith('.') && TICKET_EXT.includes(path.extname(name).toLowerCase());
}

class SoldOutError extends Error {
  constructor(details) {
    super('Not enough tickets in stock');
    this.code = 'SOLD_OUT';
    this.details = details;
  }
}

class UploadError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 10000; i++) {
    const c = `${base}-${i}${ext}`;
    if (!(await exists(c))) return c;
  }
  throw new Error('Could not find a free file name for ' + p);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

class Stock {
  /**
   * opts.lock(name, fn): cross-process mutual exclusion (Store.withLock). Without it,
   * stock changes are only serialised inside this process.
   * opts.cacheName: file name (in dataDir) for this folder's fingerprint cache.
   * opts.index: optional sold-fingerprint store (see dbstore.DbTicketIndex). When
   *   set, sold tickets are tracked there (e.g. in Postgres) instead of the
   *   data/sold-hashes.log file.
   */
  constructor(ticketsDir, dataDir, opts = {}) {
    this.root = ticketsDir;
    this.stockDir = path.join(ticketsDir, 'stock');
    this.reservedDir = path.join(ticketsDir, 'reserved');
    this.soldDir = path.join(ticketsDir, 'sold');
    this.removedDir = path.join(ticketsDir, 'removed');
    for (const d of [this.stockDir, this.reservedDir, this.soldDir, this.removedDir]) fs.mkdirSync(d, { recursive: true });
    this.hashLog = path.join(dataDir, 'sold-hashes.log');
    this.hashCacheFile = path.join(dataDir, opts.cacheName || 'ticket-fingerprints.json');
    this._lock = opts.lock || ((name, fn) => fn());
    this._index = opts.index || null;
    this._hashCache = new Map(); // "dev:ino:size:mtime" -> sha256 (saved to disk so restarts don't re-read every file)
    this._hashSaveTimer = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.hashCacheFile, 'utf8'));
      if (saved && typeof saved === 'object') for (const [k, v] of Object.entries(saved)) if (/^[a-f0-9]{64}$/.test(v)) this._hashCache.set(k, v);
    } catch {}
    this._sold = new Map(); // sha256 -> orderId
    this._soldSize = -1;
    this._queue = Promise.resolve();
    this._counts = null;
    this._countsKey = '';
    this._countsAt = 0;
  }

  static available(counts, typeId, date) {
    const c = counts[typeId];
    if (!c) return 0;
    return c.open + ((date && c.dated[date]) || 0);
  }

  ensureTypeDirs(typeIds) {
    for (const t of typeIds) if (TYPE_ID_RE.test(t)) fs.mkdirSync(path.join(this.stockDir, t), { recursive: true });
  }

  invalidate() {
    this._counts = null;
  }

  /** Run stock-changing operations one at a time — in this process and across processes. */
  _serial(fn) {
    const task = () => this._lock('stock', fn);
    const run = this._queue.then(task, task);
    this._queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // ---- listing --------------------------------------------------------------
  async _ticketFiles(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
      throw e;
    }
    const names = [];
    for (const e of entries) {
      if (!isTicketName(e.name)) continue;
      if (e.isFile()) names.push(e.name);
      else if (!e.isDirectory()) {
        try {
          if ((await fsp.stat(path.join(dir, e.name))).isFile()) names.push(e.name);
        } catch {}
      }
    }
    return names.sort(collator.compare);
  }

  async _dateDirs(typeDir) {
    let entries;
    try {
      entries = await fsp.readdir(typeDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && DATE_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** { [typeId]: { open: n, dated: { 'YYYY-MM-DD': n } } } — cached for a few seconds. */
  async counts(typeIds) {
    const key = typeIds.join(',');
    if (this._counts && this._countsKey === key && Date.now() - this._countsAt < 4000) return this._counts;
    const out = {};
    for (const t of typeIds) {
      const typeDir = path.join(this.stockDir, t);
      const open = (await this._ticketFiles(typeDir)).length;
      const dated = {};
      for (const d of await this._dateDirs(typeDir)) {
        const n = (await this._ticketFiles(path.join(typeDir, d))).length;
        if (n) dated[d] = n;
      }
      out[t] = { open, dated };
    }
    this._counts = out;
    this._countsKey = key;
    this._countsAt = Date.now();
    return out;
  }

  async listFiles(typeId, date, limit = 500) {
    if (!TYPE_ID_RE.test(typeId) || (date && !DATE_DIR_RE.test(date))) return { total: 0, files: [] };
    const dir = date ? path.join(this.stockDir, typeId, date) : path.join(this.stockDir, typeId);
    const names = await this._ticketFiles(dir);
    return { total: names.length, files: names.slice(0, limit) };
  }

  async countReserved() {
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.reservedDir);
    } catch {}
    let n = 0;
    for (const d of dirs) n += (await this._ticketFiles(path.join(this.reservedDir, d))).length;
    return n;
  }

  // ---- duplicate protection ---------------------------------------------------
  async hashFile(abs) {
    const st = await fsp.stat(abs);
    const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    let h = this._hashCache.get(key);
    if (!h) {
      h = sha256(await fsp.readFile(abs));
      if (this._hashCache.size > 200000) this._hashCache.clear();
      this._hashCache.set(key, h);
      this._saveHashesSoon();
    }
    return h;
  }

  _saveHashesSoon() {
    if (this._hashSaveTimer) return;
    this._hashSaveTimer = setTimeout(() => {
      this._hashSaveTimer = null;
      const tmp = `${this.hashCacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this._hashCache)))
        .then(() => fsp.rename(tmp, this.hashCacheFile))
        .catch(() => fsp.unlink(tmp).catch(() => {}));
    }, 3000);
    this._hashSaveTimer.unref();
  }

  _loadSold() {
    let size = 0;
    try {
      size = fs.statSync(this.hashLog).size;
    } catch {}
    if (size === this._soldSize) return;
    const map = new Map();
    try {
      for (const line of fs.readFileSync(this.hashLog, 'utf8').split('\n')) {
        const [h, id] = line.trim().split(/\s+/);
        if (h && /^[a-f0-9]{64}$/.test(h)) map.set(h, id || '?');
      }
    } catch {}
    this._sold = map;
    this._soldSize = size;
  }

  async soldOrderForHash(hash) {
    if (this._index) return this._index.lookup(hash);
    this._loadSold();
    return this._sold.get(hash) || null;
  }

  async _recordSold(entries) {
    if (!entries.length) return;
    if (this._index) return this._index.record(entries);
    await fsp.appendFile(this.hashLog, entries.map((e) => `${e.hash} ${e.orderId}\n`).join(''));
    this._loadSold();
  }

  async _reservedHashes() {
    const set = new Set();
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.reservedDir);
    } catch {}
    for (const d of dirs) {
      const m = await readJson(path.join(this.reservedDir, d, MANIFEST), null);
      if (m && Array.isArray(m.files)) for (const f of m.files) if (f.hash) set.add(f.hash);
    }
    return set;
  }

  /** Every ticket file currently in stock: [{ typeId, date|null, rel, abs }] */
  async _allStockFiles() {
    const out = [];
    let types = [];
    try {
      types = (await fsp.readdir(this.stockDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {}
    for (const t of types) {
      const typeDir = path.join(this.stockDir, t);
      for (const n of await this._ticketFiles(typeDir)) out.push({ typeId: t, date: null, rel: path.join(t, n), abs: path.join(typeDir, n) });
      for (const d of await this._dateDirs(typeDir)) {
        for (const n of await this._ticketFiles(path.join(typeDir, d))) {
          out.push({ typeId: t, date: d, rel: path.join(t, d, n), abs: path.join(typeDir, d, n) });
        }
      }
    }
    return out;
  }

  /**
   * Fingerprint every stock file that isn't cached yet. Runs WITHOUT the stock lock (it only
   * reads files), so checkouts are never kept waiting while a big batch of new tickets is hashed.
   */
  async warmHashes() {
    try {
      for (const f of await this._allStockFiles()) await this.hashFile(f.abs).catch(() => {});
    } catch (e) {
      logError('Hash warm-up failed:', e.message);
    }
  }

  async _quarantine(abs, reason) {
    const dest = await uniquePath(path.join(this.removedDir, reason, path.basename(abs)));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(abs, dest);
    log(`Ticket moved out of stock (${reason}):`, path.relative(this.root, abs), '->', path.relative(this.root, dest));
    return dest;
  }

  // ---- reserve / release / finalize --------------------------------------------
  /**
   * Move `qty` files per type from stock into reserved/<orderId>/.
   * Date-specific files (stock/<type>/<date>/) are used first, then the open pool.
   * All-or-nothing: throws SoldOutError and puts everything back if short.
   */
  reserve(orderId, date, items) {
    return this._serial(async () => {
      const dir = path.join(this.reservedDir, orderId);
      await fsp.mkdir(dir, { recursive: true });
      const manifestPath = path.join(dir, MANIFEST);
      const manifest = await readJson(manifestPath, { orderId, files: [] });
      const moved = [];
      const usedHashes = await this._reservedHashes();
      try {
        for (const { typeId, qty } of items) {
          if (!qty) continue;
          if (!TYPE_ID_RE.test(typeId)) throw new Error('Invalid ticket type ' + typeId);
          const typeDir = path.join(this.stockDir, typeId);
          const candidates = [];
          if (date && DATE_DIR_RE.test(date)) {
            for (const n of await this._ticketFiles(path.join(typeDir, date))) candidates.push(path.join(typeId, date, n));
          }
          for (const n of await this._ticketFiles(typeDir)) candidates.push(path.join(typeId, n));

          let got = 0;
          for (const rel of candidates) {
            if (got >= qty) break;
            const src = path.join(this.stockDir, rel);
            let hash;
            try {
              hash = await this.hashFile(src);
            } catch (e) {
              if (e.code === 'ENOENT') continue;
              throw e;
            }
            if (await this.soldOrderForHash(hash)) {
              await this._quarantine(src, 'duplicates').catch(() => {});
              continue;
            }
            if (usedHashes.has(hash)) continue; // identical file is reserved by someone else right now
            const reservedName = `${String(manifest.files.length + 1).padStart(3, '0')}__${typeId}__${path.basename(rel)}`;
            const dest = path.join(dir, reservedName);
            const entry = { typeId, stockPath: rel, reservedPath: path.relative(this.root, dest), hash };
            manifest.files.push(entry);
            await writeJsonAtomic(manifestPath, manifest);
            try {
              await fsp.rename(src, dest);
            } catch (e) {
              manifest.files.pop();
              await writeJsonAtomic(manifestPath, manifest);
              if (e.code === 'ENOENT') continue; // taken by another process a moment ago
              throw e;
            }
            moved.push(entry);
            usedHashes.add(hash);
            got++;
          }
          if (got < qty) throw new SoldOutError({ typeId, requested: qty, available: got });
        }
        this.invalidate();
        return moved;
      } catch (err) {
        await this._restore(moved);
        const movedSet = new Set(moved.map((m) => m.reservedPath));
        manifest.files = manifest.files.filter((f) => !movedSet.has(f.reservedPath));
        if (manifest.files.length) await writeJsonAtomic(manifestPath, manifest).catch(() => {});
        else await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        this.invalidate();
        throw err;
      }
    });
  }

  async _restore(entries) {
    for (const f of entries) {
      const src = path.join(this.root, f.reservedPath);
      try {
        const dest = await uniquePath(path.join(this.stockDir, f.stockPath));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(src, dest);
      } catch (e) {
        if (e.code !== 'ENOENT') logError('Could not return ticket to stock:', f.reservedPath, e.message);
      }
    }
  }

  async _cleanupReserved(orderId, doneEntries) {
    const dir = path.join(this.reservedDir, orderId);
    const manifestPath = path.join(dir, MANIFEST);
    const manifest = await readJson(manifestPath, null);
    if (manifest && Array.isArray(manifest.files)) {
      const done = new Set(doneEntries.map((e) => e.reservedPath));
      manifest.files = manifest.files.filter((f) => !done.has(f.reservedPath));
      if (manifest.files.length) {
        await writeJsonAtomic(manifestPath, manifest);
        return;
      }
    }
    const left = await this._ticketFiles(dir);
    if (!left.length) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  /** Put reserved files back into stock (checkout abandoned / cancelled). */
  release(orderId, entries) {
    return this._serial(async () => {
      await this._restore(entries || []);
      await this._cleanupReserved(orderId, entries || []);
      this.invalidate();
    });
  }

  /** Which reserved entries no longer exist on disk. */
  async missing(entries) {
    const out = [];
    for (const f of entries || []) if (!(await exists(path.join(this.root, f.reservedPath)))) out.push(f);
    return out;
  }

  /** Move reserved files into sold/<orderId>/ and remember their fingerprints. */
  finalize(orderId, entries) {
    return this._serial(async () => {
      const destDir = path.join(this.soldDir, orderId);
      await fsp.mkdir(destDir, { recursive: true });
      const sold = [];
      for (const f of entries) {
        const src = path.join(this.root, f.reservedPath);
        const dest = path.join(destDir, path.basename(f.reservedPath));
        try {
          await fsp.rename(src, dest);
        } catch (e) {
          if (!(e.code === 'ENOENT' && (await exists(dest)))) throw e;
        }
        sold.push({ typeId: f.typeId, path: path.relative(this.root, dest), original: path.basename(f.stockPath), hash: f.hash || null });
      }
      await this._recordSold(sold.filter((s) => s.hash).map((s) => ({ hash: s.hash, orderId })));
      await this._cleanupReserved(orderId, entries);
      this.invalidate();
      return sold;
    });
  }

  /**
   * Return reserved folders that belong to no active order to stock.
   * isActive(orderId) -> Promise<boolean>
   */
  async recoverOrphans(isActive, minAgeMs = 5 * 60 * 1000) {
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.reservedDir);
    } catch {
      return 0;
    }
    let recovered = 0;
    for (const orderId of dirs) {
      const dir = path.join(this.reservedDir, orderId);
      let st;
      try {
        st = await fsp.stat(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory() || Date.now() - st.mtimeMs < minAgeMs) continue;
      if (await isActive(orderId)) continue;
      const manifest = await readJson(path.join(dir, MANIFEST), null);
      if (manifest && Array.isArray(manifest.files)) {
        const present = [];
        for (const f of manifest.files) if (await exists(path.join(this.root, f.reservedPath))) present.push(f);
        await this.release(orderId, present);
        recovered += present.length;
        if (present.length) log(`Returned ${present.length} orphaned reserved ticket(s) of ${orderId} to stock`);
      }
      // Anything left without a manifest cannot be traced back: park it in removed/orphaned.
      await this._serial(async () => {
        for (const n of await this._ticketFiles(dir)) await this._quarantine(path.join(dir, n), 'orphaned').catch(() => {});
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      });
    }
    if (recovered) this.invalidate();
    return recovered;
  }

  // ---- admin: upload / remove / duplicates ----------------------------------------
  async addUpload(typeId, date, originalName, buffer) {
    if (!TYPE_ID_RE.test(typeId)) throw new UploadError('Unknown ticket type.');
    if (date && !DATE_DIR_RE.test(date)) throw new UploadError('Invalid date.');
    const name = safeFilename(originalName);
    const ext = path.extname(name).toLowerCase();
    if (!TICKET_EXT.includes(ext)) throw new UploadError(`${name}: only ${TICKET_EXT.join(' ')} files can be tickets.`);
    if (!buffer || !buffer.length) throw new UploadError(`${name}: the file is empty.`);
    if (MAGIC[ext] && !MAGIC[ext](buffer)) throw new UploadError(`${name}: this is not a valid ${ext.slice(1).toUpperCase()} file.`);
    const hash = sha256(buffer);
    await this.warmHashes(); // slow part first, outside the lock; inside, the comparison uses the cache
    return this._serial(async () => {
      const soldIn = await this.soldOrderForHash(hash);
      if (soldIn) throw new UploadError(`${name}: this exact ticket was already sold (order ${soldIn}). Skipped.`, 'duplicate');
      if ((await this._reservedHashes()).has(hash)) throw new UploadError(`${name}: this ticket is already in stock (reserved). Skipped.`, 'duplicate');
      for (const f of await this._allStockFiles()) {
        let h;
        try {
          h = await this.hashFile(f.abs);
        } catch {
          continue;
        }
        if (h === hash) throw new UploadError(`${name}: identical to ${f.rel}, already in stock. Skipped.`, 'duplicate');
      }
      const dir = date ? path.join(this.stockDir, typeId, date) : path.join(this.stockDir, typeId);
      await fsp.mkdir(dir, { recursive: true });
      const final = await uniquePath(path.join(dir, name));
      const tmp = path.join(dir, `.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, final);
      await this.hashFile(final).catch(() => {});
      this.invalidate();
      return { name: path.basename(final), path: path.relative(this.root, final) };
    });
  }

  async removeFile(typeId, date, name) {
    if (!TYPE_ID_RE.test(typeId) || (date && !DATE_DIR_RE.test(date)) || !isTicketName(String(name)) || /[\\/]/.test(name)) {
      throw new UploadError('Invalid file.');
    }
    const abs = path.join(this.stockDir, typeId, date || '', name);
    return this._serial(async () => {
      if (!(await exists(abs))) throw new UploadError('That file is no longer in stock.');
      await this._quarantine(abs, 'manual');
      this.invalidate();
      return true;
    });
  }

  /** Find identical files in stock (and files identical to already-sold tickets). */
  async findDuplicates({ fix = false } = {}) {
    await this.warmHashes(); // hash outside the lock
    return this._serial(async () => {
      const groups = new Map();
      const soldDupes = [];
      for (const f of await this._allStockFiles()) {
        let h;
        try {
          h = await this.hashFile(f.abs);
        } catch {
          continue;
        }
        const soldIn = await this.soldOrderForHash(h);
        if (soldIn) {
          soldDupes.push({ file: f.rel, soldIn });
          if (fix) await this._quarantine(f.abs, 'duplicates').catch(() => {});
          continue;
        }
        if (!groups.has(h)) groups.set(h, []);
        groups.get(h).push(f);
      }
      const dupes = [];
      for (const files of groups.values()) {
        if (files.length < 2) continue;
        dupes.push({ keep: files[0].rel, duplicates: files.slice(1).map((f) => f.rel) });
        if (fix) for (const f of files.slice(1)) await this._quarantine(f.abs, 'duplicates').catch(() => {});
      }
      if (fix) this.invalidate();
      return { duplicates: dupes, alreadySold: soldDupes, fixed: !!fix };
    });
  }

  absolute(rel) {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new Error('Path outside tickets folder');
    return abs;
  }

  /** Read a ticket's bytes (same shape as DbStock.read). */
  async read(rel) {
    const abs = this.absolute(rel);
    const buffer = await fsp.readFile(abs);
    return { buffer, mime: mimeFor(abs), filename: path.basename(abs), size: buffer.length };
  }

  /** Size and type of a ticket without its bytes (same shape as DbStock.stat). */
  async stat(rel) {
    const abs = this.absolute(rel);
    const st = await fsp.stat(abs);
    return { mime: mimeFor(abs), filename: path.basename(abs), size: st.size };
  }
}

module.exports = { Stock, SoldOutError, UploadError, TICKET_EXT, DATE_DIR_RE, TYPE_ID_RE, isTicketName };
