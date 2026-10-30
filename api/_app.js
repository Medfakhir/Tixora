'use strict';
/**
 * Shared bootstrap for the Vercel functions in this folder.
 *
 * Requiring server.js must not start the normal HTTP listener, so autostart is
 * switched off first. Each lambda builds the app once and reuses it for the
 * lifetime of the (warm) instance; `ready` is awaited so the database schema and
 * documents are loaded before the first request is served.
 */
process.env.BOOKING_NO_AUTOSTART = '1';

let createdPromise = null;

function getApp() {
  if (!createdPromise) {
    createdPromise = Promise.resolve().then(async () => {
      const { createApp } = require('../server.js');
      const created = createApp();
      await created.ready;
      return created;
    });
  }
  return createdPromise;
}

module.exports = { getApp };
