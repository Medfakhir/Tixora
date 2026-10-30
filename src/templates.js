'use strict';
/**
 * Editable email templates. The owner changes the subject and wording from the
 * dashboard's "Email templates" page; the layout itself stays fixed so emails
 * keep rendering properly everywhere.
 *
 * Templates contain {placeholders} that are filled in when an email is built.
 * The defaults are exactly the wording the app shipped with.
 */
const { cleanText } = require('./util');

const SUBJECT_MAX = 160;
const HEADING_MAX = 160;
const INTRO_MAX = 1200;
const FOOTER_MAX = 400;

const DEFAULT_TEMPLATES = {
  ticket: {
    subject: 'Your tickets for {date} – order {order}',
    heading: 'Your tickets are ready',
    intro: 'Thank you for your booking. {attach}',
    footer: '{site}. You receive this email because you booked tickets on our website.',
  },
  adminSale: {
    subject: '[{site}] New sale {total} – {order}',
    heading: 'New sale {total} – {order}',
    intro: '{items} for {date}.',
    footer: 'Automatic message from your booking app.',
  },
  adminAlert: {
    subject: '[{site}] {title}',
    heading: '{title}',
    intro: '',
    footer: 'Automatic message from your booking app.',
  },
  testEmail: {
    subject: '[{site}] Test email',
    heading: 'Test email',
    intro: 'If you can read this, email delivery works. Customers will receive their tickets from this address.',
    footer: 'Automatic message from your booking app.',
  },
};

const FIELDS = {
  ticket: { subject: SUBJECT_MAX, heading: HEADING_MAX, intro: INTRO_MAX, footer: FOOTER_MAX },
  adminSale: { subject: SUBJECT_MAX, heading: HEADING_MAX, intro: INTRO_MAX, footer: FOOTER_MAX },
  adminAlert: { subject: SUBJECT_MAX, heading: HEADING_MAX, intro: INTRO_MAX, footer: FOOTER_MAX },
  testEmail: { subject: SUBJECT_MAX, heading: HEADING_MAX, intro: INTRO_MAX, footer: FOOTER_MAX },
};

/** Named placeholders the owner can use in each template. */
const PLACEHOLDERS = {
  ticket: ['{site}', '{date}', '{order}', '{count}', '{total}', '{customer}', '{firstName}', '{attach}'],
  adminSale: ['{site}', '{total}', '{order}', '{items}', '{date}', '{customer}'],
  adminAlert: ['{site}', '{title}'],
  testEmail: ['{site}'],
};

const LABELS = {
  ticket: 'Ticket email (customer)',
  adminSale: 'New sale alert (owner)',
  adminAlert: 'Problem alert (owner)',
  testEmail: 'Test email',
};

/** Fill in a stored (possibly partial or missing) templates object with defaults. */
function withTemplateDefaults(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const id of Object.keys(DEFAULT_TEMPLATES)) {
    const base = DEFAULT_TEMPLATES[id];
    const got = src[id] && typeof src[id] === 'object' ? src[id] : {};
    out[id] = {};
    for (const field of Object.keys(base)) out[id][field] = typeof got[field] === 'string' ? got[field] : base[field];
  }
  return out;
}

/** Validate a templates payload coming from the dashboard. */
function validateTemplates(input, current) {
  const src = input && typeof input === 'object' && input.templates && typeof input.templates === 'object' ? input.templates : input;
  const given = src && typeof src === 'object' ? src : {};
  const cur = withTemplateDefaults(current);
  const out = {};
  for (const id of Object.keys(FIELDS)) {
    out[id] = {};
    const row = given[id] && typeof given[id] === 'object' ? given[id] : {};
    for (const [field, max] of Object.entries(FIELDS[id])) {
      out[id][field] = typeof row[field] === 'string' ? cleanText(row[field], max) : cur[id][field];
    }
  }
  return out;
}

/** Replace {name} with vars[name]. Unknown placeholders are left untouched. */
function renderTemplate(str, vars) {
  const map = vars && typeof vars === 'object' ? vars : {};
  return String(str == null ? '' : str).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? String(map[name] == null ? '' : map[name]) : m
  );
}

module.exports = {
  DEFAULT_TEMPLATES,
  FIELDS,
  PLACEHOLDERS,
  LABELS,
  withTemplateDefaults,
  validateTemplates,
  renderTemplate,
};
