#!/usr/bin/env node
'use strict';
/**
 * Create SAMPLE ticket PDFs (clearly marked "not valid") to try the app. They always go to
 * the TEST folder (tickets-sandbox), used by PayPal Sandbox and simulated payments, never to
 * your real tickets.
 *
 *   node scripts/sample-tickets.js                 25 adult + 25 child tickets, valid any day
 *   node scripts/sample-tickets.js 10 --type adult
 *   node scripts/sample-tickets.js 5 --type adult --date 2026-12-24   (date-specific folder)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../src/config');
const { samplePdf } = require('./sample-pdf');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function makeSampleTickets(ticketsDir, { count = 25, types = ['adult', 'child'], date = null } = {}) {
  const made = {};
  for (const t of types) {
    const dir = path.join(ticketsDir, 'stock', t, date || '');
    fs.mkdirSync(dir, { recursive: true });
    const prefix = t.slice(0, 2).toUpperCase();
    for (let i = 0; i < count; i++) {
      const serial = crypto.randomBytes(3).toString('hex').toUpperCase();
      const number = `${prefix}-${serial}`;
      fs.writeFileSync(path.join(dir, `SAMPLE-${number}.pdf`), samplePdf({ type: t, number, valid: date ? `Valid on ${date}` : 'Valid any day' }));
    }
    made[t] = dir;
  }
  return made;
}

if (require.main === module) {
  // Always the test folder: sample tickets must never be sold to a paying customer.
  const count = parseInt(process.argv[2], 10) || 25;
  const types = String(arg('type') || 'adult,child').split(',').map((s) => s.trim()).filter(Boolean);
  const date = arg('date') || null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('Date must look like 2026-12-24');
    process.exit(1);
  }
  const made = makeSampleTickets(config.sandboxTicketsDir, { count, types, date });
  for (const [t, dir] of Object.entries(made)) console.log(`Created ${count} sample "${t}" tickets in ${dir}`);
}

module.exports = { makeSampleTickets };
