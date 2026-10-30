'use strict';
/**
 * A tiny HTTP toolkit on top of node:http (routing, bodies, cookies, static
 * files, errors). Kept dependency-free so the app runs on any Node host
 * without `npm install`.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { escapeHtml, logError } = require('./util');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pkpass': 'application/vnd.apple.pkpass',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function compile(pattern) {
  const keys = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp('^' + src + '/?$'), keys };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  s += `; Path=${opts.path || '/'}`;
  if (opts.httpOnly !== false) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  s += `; SameSite=${opts.sameSite || 'Lax'}`;
  return s;
}

function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (prev === undefined) res.setHeader(name, value);
  else res.setHeader(name, [].concat(prev, value));
}

function isPrivateIp(ip) {
  if (!ip) return false;
  ip = String(ip).replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // carrier-grade NAT (some PaaS)
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

/** First address in a header value, or '' if it doesn't look like an IP address. */
function headerIp(v) {
  const s = String(v || '').split(',')[0].trim().replace(/^::ffff:/, '');
  return /^[0-9a-f:.]{2,45}$/i.test(s) ? s : '';
}

function clientIp(req, trustProxy) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  // No peer address = Unix socket, i.e. we sit behind a local web server such as
  // Phusion Passenger (cPanel). Passenger passes the visitor's address in a header
  // that clients cannot set ("!~" headers are rejected when sent by a client).
  const local = !peer || isPrivateIp(peer);
  if (trustProxy === 'cloudflare') {
    // Cloudflare in front of the host's own proxy (Render): X-Forwarded-For ends with
    // Cloudflare's address, but Cloudflare puts the visitor's address in CF-Connecting-IP
    // (and True-Client-IP), overwriting any copy the visitor sends.
    const cf = local ? headerIp(req.headers['cf-connecting-ip']) || headerIp(req.headers['true-client-ip']) : '';
    if (cf) return cf;
    trustProxy = 'auto';
  }
  // Only over a Unix socket (Passenger): a TCP proxy such as Caddy, Nginx or Apache would pass
  // a client-supplied copy of this header straight through.
  const passenger = req.headers['!~passenger-client-address'];
  if (passenger && !peer && trustProxy === 'auto') return String(passenger).trim().replace(/^::ffff:/, '');
  const xff = req.headers['x-forwarded-for'];
  if (!xff || trustProxy === 0) return peer || 'unknown';
  const chain = String(xff)
    .split(',')
    .map((s) => s.trim().replace(/^::ffff:/, ''))
    .filter(Boolean);
  if (!chain.length) return peer || 'unknown';
  if (trustProxy === 'auto') {
    if (!local) return peer; // reached us directly from the internet: ignore the header
    for (let i = chain.length - 1; i >= 0; i--) if (!isPrivateIp(chain[i])) return chain[i];
    return chain[0];
  }
  const idx = Math.max(0, chain.length - Number(trustProxy));
  return chain[idx] || peer || 'unknown';
}

/** Key for rate limits: the IPv4 address, or the /64 network of an IPv6 address. */
function rateKey(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/%.*$/, '');
  if (!s.includes(':')) return s || 'unknown';
  const last = s.slice(s.lastIndexOf(':') + 1);
  if (last.includes('.')) return last; // IPv4-mapped
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  let groups = h;
  if (tail !== undefined) {
    const t = tail ? tail.split(':') : [];
    groups = h.concat(Array(Math.max(0, 8 - h.length - t.length)).fill('0'), t);
  }
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'The request is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, 'The request is too large.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function readJson(req, limit = 64 * 1024) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'Expected a JSON request.');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function redirect(res, location, status = 302) {
  send(res, status, '', { Location: location, 'Cache-Control': 'no-store' });
}

function contentDisposition(filename, type = 'attachment') {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function sendFile(req, res, filePath, opts = {}) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    throw new HttpError(404, 'File not found.');
  }
  if (!st.isFile()) throw new HttpError(404, 'File not found.');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const cacheControl = opts.cacheControl || 'no-cache';
  if (!opts.downloadName && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }
  const headers = {
    'Content-Type': opts.contentType || mimeFor(filePath),
    'Content-Length': st.size,
    'Last-Modified': st.mtime.toUTCString(),
    'Cache-Control': cacheControl,
    ...(opts.headers || {}),
  };
  if (!opts.downloadName) headers.ETag = etag;
  if (opts.downloadName) headers['Content-Disposition'] = contentDisposition(opts.downloadName, opts.inline ? 'inline' : 'attachment');
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', (e) => {
      logError('sendFile stream error', filePath, e.message);
      res.destroy();
      resolve();
    });
    res.on('close', resolve);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

/**
 * Send an in-memory file (used for tickets, which live in the database on hosts
 * without a disk). Mirrors sendFile's download/inline behaviour.
 */
function sendBuffer(req, res, buffer, opts = {}) {
  if (res.headersSent) {
    try {
      res.end();
    } catch {}
    return;
  }
  const headers = {
    'Content-Type': opts.contentType || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': opts.cacheControl || 'no-store',
    ...(opts.headers || {}),
  };
  if (opts.downloadName) headers['Content-Disposition'] = contentDisposition(opts.downloadName, opts.inline ? 'inline' : 'attachment');
  res.writeHead(opts.status || 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(buffer);
}

function errorPage(status, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status}</title><style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f2ea;color:#2a2018;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:460px;text-align:center}h1{font-size:44px;margin:0 0 8px;color:#9a3f22}a{color:#1d5b52}</style></head>
<body><main><h1>${status}</h1><p>${escapeHtml(message)}</p><p><a href="/">Back to booking</a></p></main></body></html>`;
}

/** In-memory fixed-window rate limiter. Returns check(key) -> boolean. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  timer.unref();
  return function check(key) {
    const now = Date.now();
    if (hits.size > 100000) hits.clear(); // bounded memory, whatever the traffic
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.count++;
    return e.count <= max;
  };
}

class App {
  constructor({ trustProxy = 'auto' } = {}) {
    this.trustProxy = trustProxy;
    this.routes = [];
    this.before = [];
    this.statics = [];
  }

  use(fn) {
    this.before.push(fn);
    return this;
  }

  add(method, pattern, handler) {
    const { re, keys } = compile(pattern);
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  static(prefix, dir, opts = {}) {
    this.statics.push({ prefix: prefix.replace(/\/+$/, ''), dir: path.resolve(dir), opts });
    return this;
  }

  handler() {
    return (req, res) => {
      this.handle(req, res).catch((err) => this.fail(err, req, res));
    };
  }

  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      throw new HttpError(400, 'Bad request.');
    }
    req.pathname = url.pathname;
    req.query = Object.fromEntries(url.searchParams);
    req.ip = clientIp(req, this.trustProxy);
    req.cookies = parseCookies(req.headers.cookie);
    req.params = {};

    for (const fn of this.before) {
      await fn(req, res);
      if (res.headersSent || res.writableEnded) return;
    }

    const method = req.method === 'HEAD' ? 'GET' : req.method;
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.re.exec(req.pathname);
      if (!m) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      r.keys.forEach((k, i) => {
        try {
          req.params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, 'Bad request.');
        }
      });
      await r.handler(req, res);
      return;
    }

    if (method === 'GET') {
      for (const s of this.statics) {
        if (s.prefix === '' || req.pathname === s.prefix || req.pathname.startsWith(s.prefix + '/')) {
          if (await this.serveStatic(req, res, s)) return;
        }
      }
    }
    if (methodMismatch) throw new HttpError(405, 'Method not allowed.');
    throw new HttpError(404, 'Page not found.');
  }

  async serveStatic(req, res, s) {
    let rel = req.pathname.slice(s.prefix.length);
    try {
      rel = decodeURIComponent(rel);
    } catch {
      return false;
    }
    if (rel.includes('\0')) return false;
    if (!rel || rel === '/') rel = '/index.html';
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return false; // dotfiles and ../
    const full = path.resolve(s.dir, '.' + rel);
    if (full !== s.dir && !full.startsWith(s.dir + path.sep)) return false;
    let file = full;
    let st;
    try {
      st = await fsp.stat(file);
      if (st.isDirectory()) {
        file = path.join(full, 'index.html');
        st = await fsp.stat(file);
      }
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    const isHtml = file.endsWith('.html');
    await sendFile(req, res, file, {
      cacheControl: isHtml || !s.opts.maxAge ? 'no-cache' : `public, max-age=${s.opts.maxAge}`,
      headers: isHtml && s.opts.htmlHeaders ? s.opts.htmlHeaders(req) : undefined,
    });
    return true;
  }

  fail(err, req, res) {
    const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
    const isHttpError = err instanceof HttpError;
    if (!isHttpError) logError('HTTP', status, req.method, req.url, (err && err.stack) || err);
    else if (status >= 500) logError('HTTP', status, req.method, req.pathname, err.message);
    if (res.headersSent) {
      try {
        res.destroy();
      } catch {}
      return;
    }
    const message = isHttpError ? err.message : 'Something went wrong on our side. Please try again.';
    const headers = status === 413 ? { Connection: 'close' } : {};
    const wantsJson = String(req.pathname || req.url || '').startsWith('/api/');
    if (wantsJson) sendJson(res, status, { error: message, ...((isHttpError && err.extra) || {}) }, headers);
    else sendHtml(res, status, errorPage(status, message), headers);
  }
}

module.exports = {
  App,
  HttpError,
  readBody,
  readJson,
  send,
  sendJson,
  sendHtml,
  sendFile,
  sendBuffer,
  redirect,
  serializeCookie,
  appendHeader,
  contentDisposition,
  rateLimiter,
  rateKey,
  clientIp,
  mimeFor,
  isPrivateIp,
  errorPage,
};
