'use strict';
/**
 * Small shared helpers: ids, tokens, money, escaping, validation, logging.
 */
const crypto = require('crypto');
const path = require('path');

// Order ids avoid look-alike characters (0/O, 1/I/L) so customers can read them over the phone.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ORDER_ID_RE = /^BP-[2-9A-HJKMNP-Z]{8}$/;

function randomString(len, alphabet = ID_ALPHABET) {
  let out = '';
  const limit = 256 - (256 % alphabet.length); // avoid modulo bias
  while (out.length < len) {
    const bytes = crypto.randomBytes(len * 2);
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      if (bytes[i] < limit) out += alphabet[bytes[i] % alphabet.length];
    }
  }
  return out;
}

function newOrderId() {
  return 'BP-' + randomString(8);
}

function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison (lengths may differ). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

// ---- money: always integer cents internally -------------------------------
function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    value = value.toFixed(2);
  }
  const s = String(value == null ? '' : value).trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
}

function fromCents(cents) {
  const neg = cents < 0;
  const c = Math.abs(Math.round(cents));
  return (neg ? '-' : '') + Math.floor(c / 100) + '.' + String(c % 100).padStart(2, '0');
}

const CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CAD: 'CA$', AUD: 'A$', CHF: 'CHF ' };
function formatMoney(value, currency) {
  const cents = typeof value === 'number' ? value : toCents(value);
  const amount = fromCents(cents);
  const sym = CURRENCY_SYMBOLS[currency];
  return sym ? sym + amount : amount + ' ' + currency;
}

// ---- text ------------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trim, collapse whitespace, strip control characters, cap length. */
function cleanText(v, max = 200) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v);
}

function safeFilename(name, fallback = 'ticket') {
  let n = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!n || n === '.' || n === '..') n = fallback;
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 10);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

function slug(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function logError(...args) {
  console.error(new Date().toISOString(), ...args);
}

module.exports = {
  ORDER_ID_RE,
  randomString,
  newOrderId,
  token,
  safeEqual,
  toCents,
  fromCents,
  formatMoney,
  escapeHtml,
  cleanText,
  isEmail,
  safeFilename,
  slug,
  nowIso,
  sleep,
  log,
  logError,
};
