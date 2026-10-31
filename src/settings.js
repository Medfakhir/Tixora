'use strict';
/**
 * Business settings edited from the admin dashboard (stored in data/settings.json).
 */
const { toCents, fromCents, cleanText, isEmail } = require('./util');
const dates = require('./dates');
const { HttpError } = require('./http');

// Two-decimal currencies supported by PayPal. (PayPal does not support MAD.)
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CAD', 'AUD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'NZD'];
const TYPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const DEFAULT_SETTINGS = {
  siteName: 'Bahia Palace Tickets',
  tagline: 'Book your entrance tickets online and receive them instantly by email.',
  currency: 'EUR',
  ticketTypes: [
    { id: 'adult', name: 'Adult', description: 'Ages 12 and over', price: '12.00', active: true },
    { id: 'child', name: 'Child', description: 'Under 12', price: '6.00', active: true },
  ],
  maxTicketsPerOrder: 10,
  bookingWindowDays: 120,
  sameDayCutoff: '16:00',
  closedWeekdays: [],
  closedDates: [],
  holdMinutes: 15,
  lowStockThreshold: 20,
  fewLeftThreshold: 10,
  fewLeftDays: 3,
  openingHours: 'Open daily, 9:00 – 17:00',
  address: 'Rue Riad Zitoun el Jdid, Medina, Marrakech',
  notice: '',
  ticketInstructions:
    'Show your ticket at the palace entrance, on your phone or printed. Each attached file is one ticket for one visitor.',
  termsUrl: '',
  supportEmail: '',
  notifyAdminOnSale: true,
};

function cleanMultiline(v, max) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function slugId(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
}

/** Merge stored settings over defaults (tolerates older/partial files). */
function withDefaults(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if (!Array.isArray(s.ticketTypes) || !s.ticketTypes.length) s.ticketTypes = DEFAULT_SETTINGS.ticketTypes;
  if (!Array.isArray(s.closedDates)) s.closedDates = [];
  if (!Array.isArray(s.closedWeekdays)) s.closedWeekdays = [];
  return s;
}

function validateSettings(input, current) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid settings.');
  const s = { ...current };
  const errors = [];

  const text = (k, max) => {
    if (input[k] !== undefined) s[k] = cleanText(input[k], max);
  };
  text('siteName', 80);
  text('tagline', 200);
  text('openingHours', 120);
  text('address', 200);
  text('notice', 300);
  if (input.ticketInstructions !== undefined) s.ticketInstructions = cleanMultiline(input.ticketInstructions, 1000);
  if (!s.siteName) errors.push('Site name is required.');

  if (input.termsUrl !== undefined) {
    const u = cleanText(input.termsUrl, 300);
    if (u && !/^https?:\/\/\S+$/i.test(u)) errors.push('Terms link must start with http:// or https://');
    s.termsUrl = u;
  }
  if (input.supportEmail !== undefined) {
    const e = cleanText(input.supportEmail, 254);
    if (e && !isEmail(e)) errors.push('Support email is not a valid email address.');
    s.supportEmail = e;
  }
  if (input.currency !== undefined) {
    const c = String(input.currency).toUpperCase();
    if (!CURRENCIES.includes(c)) errors.push('Unsupported currency.');
    else s.currency = c;
  }

  const intField = (k, min, max, label) => {
    if (input[k] === undefined) return;
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${label} must be a whole number between ${min} and ${max}.`);
    else s[k] = n;
  };
  intField('maxTicketsPerOrder', 1, 50, 'Max tickets per order');
  intField('bookingWindowDays', 1, 730, 'Booking window');
  intField('holdMinutes', 5, 60, 'Checkout hold time');
  intField('lowStockThreshold', 0, 100000, 'Low-stock alert level');
  intField('fewLeftThreshold', 0, 100000, 'Few-left level');
  intField('fewLeftDays', 0, 730, 'Few-left day window');

  if (input.sameDayCutoff !== undefined) {
    const t = String(input.sameDayCutoff || '').trim();
    if (t && !dates.isValidTime(t)) errors.push('Same-day cut-off must look like 16:00 (or be empty).');
    else s.sameDayCutoff = t;
  }

  if (input.closedWeekdays !== undefined) {
    const arr = Array.isArray(input.closedWeekdays) ? input.closedWeekdays.map(Number) : [];
    if (arr.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('Invalid closed weekday.');
    else s.closedWeekdays = [...new Set(arr)].sort();
  }

  if (input.closedDates !== undefined) {
    const arr = Array.isArray(input.closedDates) ? input.closedDates.map(String) : [];
    const bad = arr.filter((d) => !dates.isValidYmd(d));
    if (bad.length) errors.push('Invalid closed date: ' + bad.slice(0, 3).join(', '));
    else s.closedDates = [...new Set(arr)].sort().slice(-3000);
  }

  if (input.notifyAdminOnSale !== undefined) s.notifyAdminOnSale = !!input.notifyAdminOnSale;

  if (input.ticketTypes !== undefined) {
    if (!Array.isArray(input.ticketTypes) || !input.ticketTypes.length) {
      errors.push('Add at least one ticket type.');
    } else if (input.ticketTypes.length > 20) {
      errors.push('Too many ticket types (max 20).');
    } else {
      const seen = new Set();
      const types = [];
      input.ticketTypes.forEach((t, i) => {
        const name = cleanText(t && t.name, 60);
        let id = String((t && t.id) || '').trim() || slugId(name);
        const label = name || `Ticket type ${i + 1}`;
        if (!name) errors.push(`${label}: name is required.`);
        if (!TYPE_ID_RE.test(id)) errors.push(`${label}: folder name "${id}" may only use a-z, 0-9 and dashes.`);
        if (seen.has(id)) errors.push(`${label}: folder name "${id}" is used twice.`);
        seen.add(id);
        const cents = toCents(t && t.price);
        if (!Number.isFinite(cents) || cents < 1) errors.push(`${label}: price must be a positive amount like 12.00`);
        types.push({
          id,
          name,
          description: cleanText(t && t.description, 140),
          price: Number.isFinite(cents) ? fromCents(cents) : '0.00',
          active: t && t.active !== undefined ? !!t.active : true,
        });
      });
      if (!types.some((t) => t.active)) errors.push('At least one ticket type must be on sale.');
      s.ticketTypes = types;
    }
  }

  if (errors.length) throw new HttpError(400, errors.join(' '), { errors });
  return s;
}

module.exports = { DEFAULT_SETTINGS, CURRENCIES, TYPE_ID_RE, withDefaults, validateSettings };
