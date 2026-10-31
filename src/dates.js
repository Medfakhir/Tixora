'use strict';
/**
 * Date helpers. Visit dates are plain 'YYYY-MM-DD' strings (no time zone);
 * "today" and the same-day cut-off are computed in the venue's time zone.
 */
const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** { date: 'YYYY-MM-DD', time: 'HH:MM' } for a moment in the given time zone. */
function inTz(tz, when = new Date()) {
  const parts = {};
  for (const { type, value } of formatterFor(tz).formatToParts(when)) parts[type] = value;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `fromYmd` to `toYmd` (positive when `toYmd` is later). */
function diffDays(fromYmd, toYmd) {
  const a = new Date(fromYmd + 'T12:00:00Z').getTime();
  const b = new Date(toYmd + 'T12:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/** 0 = Sunday ... 6 = Saturday */
function weekday(ymd) {
  return new Date(ymd + 'T12:00:00Z').getUTCDay();
}

function monthDates(ym) {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= days; d++) out.push(`${ym}-${String(d).padStart(2, '0')}`);
  return out;
}

function formatLong(ymd, locale = 'en-GB') {
  if (!isValidYmd(ymd)) return String(ymd || '');
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(ymd + 'T12:00:00Z'));
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

module.exports = { inTz, isValidYmd, isValidMonth, addDays, diffDays, weekday, monthDates, formatLong, isValidTime };
