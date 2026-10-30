#!/usr/bin/env node
'use strict';
/**
 * Try the whole booking flow on your own computer — no PayPal account, no email
 * server, no real tickets needed:
 *
 *   npm run demo                 (opens on http://localhost:8080)
 *   PORT=9000 npm run demo       (choose another port)
 *
 * If the port is already used by another program, the next free port is used
 * and the address is printed. Uses separate folders (demo/data, demo/tickets)
 * so it never touches your real stock. Payments are simulated and ticket
 * emails are saved as files.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8080;

function isFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

async function freePort(start) {
  for (let p = start; p < start + 50 && p <= 65535; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`No free port found between ${start} and ${start + 49}. Start with PORT=<number> npm run demo`);
}

(async () => {
  const wanted = parseInt(process.env.PORT, 10) || DEFAULT_PORT;
  const port = await freePort(wanted);
  if (port !== wanted) console.log(`\n  Port ${wanted} is already used by another program, so the demo uses port ${port}.`);

  Object.assign(process.env, {
    NODE_ENV: 'development',
    PAYPAL_MODE: 'mock',
    DATA_DIR: path.join(root, 'demo', 'data'),
    TICKETS_DIR: path.join(root, 'demo', 'tickets'),
    SMTP_HOST: '',
    ADMIN_PASSWORD: process.env.DEMO_ADMIN_PASSWORD || 'demo1234',
    ADMIN_EMAIL: '',
    BASE_URL: `http://localhost:${port}`,
    PORT: String(port),
    EMBED_ALLOWED_ORIGINS: '',
  });

  // Sample tickets in the test folder (demo/tickets-sandbox), used by simulated payments and by
  // PayPal Sandbox if you connect test keys on the dashboard's PayPal page.
  const { makeSampleTickets } = require('./sample-tickets');
  const testFolder = process.env.TICKETS_DIR + '-sandbox';
  for (const t of ['adult', 'child']) {
    const dir = path.join(testFolder, 'stock', t);
    const has = fs.existsSync(dir) && fs.readdirSync(dir).some((n) => /\.pdf$/i.test(n));
    if (!has) makeSampleTickets(testFolder, { count: 30, types: [t] });
  }

  console.log('\n  DEMO MODE — payments are simulated, nothing is charged.');
  console.log(`  Booking page: http://localhost:${port}/`);
  console.log(`  Dashboard:    http://localhost:${port}/admin   (password: ${process.env.ADMIN_PASSWORD})`);
  console.log(`  Emails:       saved in ${path.join('demo', 'data', 'outbox')}`);
  console.log('  Stop with Ctrl+C.\n');

  require('../server.js');
})().catch((e) => {
  console.error('\n  Could not start the demo: ' + e.message + '\n');
  process.exit(1);
});
