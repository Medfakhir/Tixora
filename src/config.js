'use strict';
/**
 * Environment configuration. Everything secret or deployment-specific lives in
 * .env (see .env.example). Business settings (prices, closed days, texts) live
 * in data/settings.json and are edited from the admin dashboard.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
require('./env').load(process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.join(ROOT, '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined || String(v).trim() === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const list = (v) =>
  String(v || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
const dir = (v, d) => path.resolve(ROOT, (v || '').trim() || d);

let pkg = { version: '0.0.0' };
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch {}
const isProduction = String(env.NODE_ENV || '').trim() === 'production';
const port = int(env.PORT, 3000);
// On Render the service's own address (https://NAME.onrender.com) is used until BASE_URL is set.
const baseUrl = String(env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).trim().replace(/\/+$/, '');

const dataDir = dir(env.DATA_DIR, 'data');
const liveTicketsDir = dir(env.TICKETS_DIR, 'tickets');
// Some hosts (Vercel) only allow writing to /tmp; a missing directory is not fatal,
// because the database mode needs neither data/ nor tickets/ on disk.
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch {}
const localHost = (() => {
  try {
    return /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
})();

function loadSecret() {
  if (env.SESSION_SECRET && env.SESSION_SECRET.trim().length >= 16) return env.SESSION_SECRET.trim();
  const file = path.join(dataDir, 'secret.key');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, s, { flag: 'wx', mode: 0o600 });
    return s;
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        return fs.readFileSync(file, 'utf8').trim();
      } catch {}
    }
    // A read-only filesystem (Vercel): keep a random per-instance secret rather
    // than refusing to start. Set SESSION_SECRET so sessions survive restarts.
    return s;
  }
}

// Where the owner changes these settings (used in messages).
const settingsPlace = String(env.RENDER || '').trim() ? "your Render service's Environment tab" : 'the .env file';

// ---- PayPal ------------------------------------------------------------------
let mode = String(env.PAYPAL_MODE || 'sandbox').trim().toLowerCase();
if (!['mock', 'sandbox', 'live'].includes(mode)) mode = 'sandbox';
const paypal = {
  mode,
  clientId: String(env.PAYPAL_CLIENT_ID || '').trim(),
  clientSecret: String(env.PAYPAL_CLIENT_SECRET || '').trim(),
  webhookId: String(env.PAYPAL_WEBHOOK_ID || '').trim(),
  apiBase: String(env.PAYPAL_API_BASE || (mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'))
    .trim()
    .replace(/\/+$/, ''),
  disabledReason: '',
  // PAYPAL_API_BASE is for testing against a stand-in PayPal; when set it is used for every mode.
  apiBaseOverride: String(env.PAYPAL_API_BASE || '').trim().replace(/\/+$/, ''),
};
// Simulated payments (demo) are only allowed on your own computer.
const mockAllowed = !isProduction && localHost;
if (mode === 'mock' && !mockAllowed) {
  paypal.disabledReason =
    'PAYPAL_MODE=mock (fake payments) only works on your own computer (BASE_URL on localhost, NODE_ENV not production). Use sandbox or live on a server.';
} else if (mode !== 'mock' && (!paypal.clientId || !paypal.clientSecret)) {
  paypal.disabledReason = `PayPal is not configured yet: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in ${settingsPlace}.`;
}

// In sandbox mode anyone with a free PayPal test account can "pay", so sandbox orders
// are filled from a separate test folder and never from your real tickets.
const sandboxTicketsDir = path.resolve(ROOT, String(env.SANDBOX_TICKETS_DIR || '').trim() || liveTicketsDir + '-sandbox');
const ticketsDir = mode === 'sandbox' ? sandboxTicketsDir : liveTicketsDir;

// ---- Email (SMTP) ------------------------------------------------------------
const smtpPortEnv = int(env.SMTP_PORT, 0);
const smtpSecure = bool(env.SMTP_SECURE, smtpPortEnv ? smtpPortEnv === 465 : true);
const smtp = {
  host: String(env.SMTP_HOST || '').trim(),
  port: smtpPortEnv || (smtpSecure ? 465 : 587),
  secure: smtpSecure,
  user: String(env.SMTP_USER || '').trim(),
  pass: String(env.SMTP_PASS || ''),
  rejectUnauthorized: bool(env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
  timeoutMs: int(env.SMTP_TIMEOUT_MS, 30000),
};

// ---- Reverse proxy -----------------------------------------------------------
// TRUST_PROXY: unset/auto = trust X-Forwarded-For only from a local proxy; cloudflare = the visitor
// address Cloudflare adds (CF-Connecting-IP), used automatically on Render, which puts Cloudflare in
// front of every service; 0/false = never; N = N proxy hops.
let trustProxy = String(env.RENDER || '').trim() ? 'cloudflare' : 'auto';
if (env.TRUST_PROXY !== undefined && String(env.TRUST_PROXY).trim() !== '') {
  const v = String(env.TRUST_PROXY).trim().toLowerCase();
  if (v === 'auto' || v === 'cloudflare') trustProxy = v;
  else if (/^(true|yes|on)$/.test(v)) trustProxy = 1;
  else if (/^(false|no|off)$/.test(v)) trustProxy = 0;
  else if (/^\d+$/.test(v)) trustProxy = parseInt(v, 10);
  else console.warn(`TRUST_PROXY=${env.TRUST_PROXY} is not a known value (auto, cloudflare, false or a number); using ${trustProxy}.`);
}

const config = {
  version: pkg.version,
  root: ROOT,
  isProduction,
  port,
  host: String(env.HOST || '').trim() || undefined,
  baseUrl,
  settingsPlace,
  secureCookies: baseUrl.startsWith('https://'),
  trustProxy,
  timezone: String(env.TIMEZONE || 'Africa/Casablanca').trim(),
  dataDir,
  ticketsDir,
  liveTicketsDir,
  sandboxTicketsDir,
  mockAllowed,
  admin: {
    // The placeholder from .env.example is public, so it never unlocks the dashboard.
    password: String(env.ADMIN_PASSWORD || '') === 'change-me-to-a-long-password' ? '' : String(env.ADMIN_PASSWORD || ''),
    sessionHours: Math.max(1, int(env.ADMIN_SESSION_HOURS, 12)),
  },
  sessionSecret: loadSecret(),
  paypal,
  smtp,
  mail: {
    from: String(env.MAIL_FROM || env.SMTP_USER || 'tickets@localhost').trim(),
    replyTo: String(env.MAIL_REPLY_TO || '').trim(),
  },
  adminEmail: String(env.ADMIN_EMAIL || '').trim(),
  embedOrigins: list(env.EMBED_ALLOWED_ORIGINS),
  reconcileIntervalMs: Math.max(5000, int(env.RECONCILE_INTERVAL_MS, 60000)),
  // Optional Neon/Postgres database. Empty = the original flat-file storage.
  databaseUrl: String(env.DATABASE_URL || '').trim(),
  // Advanced: override the /sql endpoint (Neon-compatible proxy, or tests).
  databaseEndpoint: String(env.DATABASE_ENDPOINT || '').trim(),
  // Secret Vercel sends as "Authorization: Bearer ..." when calling the cron route.
  cronSecret: String(env.CRON_SECRET || '').trim(),
};

module.exports = config;
