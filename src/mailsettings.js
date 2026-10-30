'use strict';
/**
 * Mail settings kept in data/mail.json (edited from the dashboard's Email
 * page): SMTP server, sender address, and the editable email templates.
 *
 * The SMTP password is stored encrypted (see secretbox.js). When the dashboard
 * has no SMTP host set, the app falls back to the .env SMTP_* values, so an
 * existing install keeps working untouched.
 */
const secretbox = require('./secretbox');
const templates = require('./templates');
const { HttpError } = require('./http');
const { cleanText, isEmail } = require('./util');

const HOST_MAX = 200;
const USER_MAX = 200;
const ADDRESS_MAX = 200;

function cleanAddress(value, label) {
  const s = cleanText(value, ADDRESS_MAX);
  if (!s) return '';
  const m = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(s);
  const address = m ? m[2] : s;
  if (!isEmail(address)) throw new HttpError(400, `${label} "${s}" is not a valid email address.`);
  return s;
}

/** Normalise the stored mail.json (or {}), filling defaults. */
function withMailDefaults(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  const s = src.smtp && typeof src.smtp === 'object' ? src.smtp : {};
  const host = cleanText(s.host || '', HOST_MAX);
  const secure = s.secure === undefined ? true : !!s.secure;
  let port = parseInt(s.port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = secure ? 465 : 587;
  return {
    smtp: {
      host,
      port,
      secure,
      user: cleanText(s.user || '', USER_MAX),
      passEnc: typeof s.passEnc === 'string' ? s.passEnc : '',
    },
    from: typeof src.from === 'string' ? src.from : '',
    replyTo: typeof src.replyTo === 'string' ? src.replyTo : '',
    templates: templates.withTemplateDefaults(src.templates),
    updatedAt: src.updatedAt || null,
  };
}

/** The SMTP values that come from the environment (.env / host panel). */
function envMail(config) {
  const s = config.smtp || {};
  return {
    smtp: {
      host: s.host || '',
      port: s.port || (s.secure === false ? 587 : 465),
      secure: s.secure === undefined ? true : !!s.secure,
      user: s.user || '',
      pass: s.pass || '',
      rejectUnauthorized: s.rejectUnauthorized !== false,
      timeoutMs: s.timeoutMs || 30000,
    },
    from: config.mail.from || '',
    replyTo: config.mail.replyTo || '',
  };
}

/** Merge stored settings with the environment into the values the app uses. */
function resolveMail(config, stored) {
  const cur = withMailDefaults(stored);
  const env = envMail(config);
  const fromDashboard = !!cur.smtp.host;
  const smtp = fromDashboard
    ? {
        host: cur.smtp.host,
        port: cur.smtp.port,
        secure: cur.smtp.secure,
        user: cur.smtp.user,
        pass: secretbox.open(cur.smtp.passEnc, config.sessionSecret),
        rejectUnauthorized: env.smtp.rejectUnauthorized,
        timeoutMs: env.smtp.timeoutMs,
      }
    : { ...env.smtp };
  return {
    smtp,
    from: cur.from || env.from || (fromDashboard ? cur.smtp.user : env.smtp.user) || 'tickets@localhost',
    replyTo: cur.replyTo || env.replyTo || '',
    templates: cur.templates,
    source: fromDashboard ? 'dashboard' : 'env',
    stored: cur,
  };
}

/** Validate a payload from the dashboard and return the object to store. */
function validateMail(input, current, secret) {
  const inp = input && typeof input === 'object' ? input : {};
  const cur = withMailDefaults(current);
  const raw = inp.smtp && typeof inp.smtp === 'object' ? inp.smtp : {};

  const host = cleanText(raw.host !== undefined ? raw.host : cur.smtp.host, HOST_MAX);
  const secure = raw.secure !== undefined ? !!raw.secure : cur.smtp.secure;
  let port = parseInt(raw.port, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = secure ? 465 : 587;

  const user = cleanText(raw.user !== undefined ? raw.user : cur.smtp.user, USER_MAX);

  let passEnc = cur.smtp.passEnc;
  if (raw.removePassword === true) passEnc = '';
  else if (typeof raw.password === 'string' && raw.password !== '') passEnc = secretbox.seal(raw.password, secret);

  const from = cleanAddress(raw.from !== undefined ? raw.from : cur.from, 'The sender address');
  const replyTo = cleanAddress(raw.replyTo !== undefined ? raw.replyTo : cur.replyTo, 'The reply-to address');

  return { smtp: { host, port, secure, user, passEnc }, from, replyTo, templates: cur.templates };
}

/**
 * Build the options the SMTP client needs. `override` (from a "test before
 * saving" request) takes precedence; a blank password falls back to the stored one.
 */
function smtpOptions(stored, config, override) {
  const cur = withMailDefaults(stored);
  const o = override && typeof override === 'object' ? override : null;
  const host = cleanText(o && o.host !== undefined ? o.host : cur.smtp.host, HOST_MAX);
  const secure = o && o.secure !== undefined ? !!o.secure : o && o.port !== undefined ? parseInt(o.port, 10) === 465 : cur.smtp.secure;
  let port = o && o.port !== undefined ? parseInt(o.port, 10) : cur.smtp.port;
  if (!Number.isFinite(port) || port < 1 || port > 65535) port = secure ? 465 : 587;
  const user = cleanText(o && o.user !== undefined ? o.user : cur.smtp.user, USER_MAX);
  let passEnc = cur.smtp.passEnc;
  if (o && typeof o.password === 'string' && o.password !== '') passEnc = secretbox.seal(o.password, config.sessionSecret);
  const pass = secretbox.open(passEnc, config.sessionSecret);
  const env = envMail(config);
  return {
    host,
    port,
    secure,
    user,
    pass,
    rejectUnauthorized: env.smtp.rejectUnauthorized,
    timeoutMs: env.smtp.timeoutMs,
  };
}

module.exports = {
  withMailDefaults,
  envMail,
  resolveMail,
  validateMail,
  smtpOptions,
};
