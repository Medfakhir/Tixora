'use strict';
/**
 * A tiny, zero-dependency Neon Postgres client that speaks Neon's SQL-over-HTTP
 * protocol (the same endpoint the official @neondatabase/serverless driver uses).
 *
 * Why not the official driver? This app deliberately ships with no npm
 * dependencies, and Node's built-in fetch() is enough:
 *
 *   POST https://<host, first label replaced by "api.">/sql
 *   headers: Neon-Connection-String: <the full connection string>
 *            Neon-Raw-Text-Output: true
 *   body:    { query, params }
 *   reply:   { fields, rows, rowCount, command }
 *
 * Only the active database (DATABASE_URL) is used; callers decide whether to
 * use this at all. Values come back as raw text, which is exactly what we want:
 * the caller controls the casts ($1::jsonb, count(*)::text, ...) and parses the
 * simple shapes it asked for.
 */
const { logError } = require('./util');

/** The /sql endpoint for a connection string (mirrors the official driver). */
function neonEndpoint(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid Postgres connection string.');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error('DATABASE_URL must start with postgresql:// (or postgres://).');
  }
  // Neon serves the HTTP endpoint from "api.<region>.…" instead of "<project>.…".
  const host = url.hostname.replace(/^[^.]+\./, 'api.');
  return `https://${host}/sql`;
}

/**
 * A copy of the connection string with driver-only parameters removed.
 * libpq's channel_binding is meaningless over HTTP and some servers reject it.
 */
function cleanConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('channel_binding');
    return url.toString();
  } catch {
    return String(connectionString || '').trim();
  }
}

/** Turn JS values into something the endpoint accepts in the params array. */
function prepareParam(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex'); // bytea literal
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Normalise the response so every caller sees rows as plain objects keyed by
 * column name, whether or not the server used array mode.
 */
function normalizeRows(json) {
  const raw = Array.isArray(json.rows) ? json.rows : [];
  const fields = Array.isArray(json.fields) ? json.fields : [];
  const names = fields.map((f) => (f && (f.name || f.columnName)) || '');
  return raw.map((row) => {
    if (Array.isArray(row)) {
      const obj = {};
      for (let i = 0; i < names.length; i++) obj[names[i] || String(i)] = row[i];
      return obj;
    }
    return row || {};
  });
}

class NeonError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'NeonError';
    this.status = status;
    this.detail = detail;
  }
}

class NeonClient {
  /**
   * @param {string} connectionString  DATABASE_URL
   * @param {{fetchImpl?: Function, endpoint?: string}} [opts]
   */
  constructor(connectionString, opts = {}) {
    const cs = String(connectionString || '').trim();
    if (!cs) throw new Error('DATABASE_URL is empty.');
    this.connectionString = cleanConnectionString(cs);
    this.endpoint = opts.endpoint || neonEndpoint(cs);
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  /** Run one statement. Returns { rows, fields, rowCount, command }. */
  async query(text, params = []) {
    const body = JSON.stringify({ query: String(text), params: (params || []).map(prepareParam) });
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Neon-Connection-String': this.connectionString,
          'Neon-Raw-Text-Output': 'true',
        },
        body,
      });
    } catch (e) {
      throw new NeonError(`Could not reach the database (${e.message}). Check DATABASE_URL and the network.`, 0, null);
    }
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* a plain-text body (proxy error page, etc.) */
    }
    if (!res.ok || !json || json.message) {
      const message = (json && json.message) || raw.slice(0, 300) || `HTTP ${res.status}`;
      throw new NeonError(message, res.status, json);
    }
    const rows = normalizeRows(json);
    return {
      rows,
      fields: Array.isArray(json.fields) ? json.fields : [],
      rowCount: Number.isFinite(json.rowCount) ? json.rowCount : rows.length,
      command: json.command || '',
    };
  }

  /** Quick connectivity check with a friendly error. */
  async ping() {
    try {
      await this.query('SELECT 1 AS ok');
    } catch (e) {
      logError('Database connection failed:', e.message);
      throw new Error(`Could not connect to the database: ${e.message}`);
    }
  }
}

module.exports = { NeonClient, NeonError, neonEndpoint, cleanConnectionString, prepareParam };
