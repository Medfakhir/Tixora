'use strict';
/**
 * Vercel cron target (see vercel.json "crons"). Replaces the long-running
 * reconcile timer: expire abandoned checkouts, retry deliveries, recover
 * orphaned reserved tickets. Vercel sends the CRON_SECRET as a bearer token.
 */
const { getApp } = require('../_app');

module.exports = async function handler(req, res) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const auth = String((req.headers && req.headers.authorization) || '');
  if (!secret || auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  try {
    const { booking } = await getApp();
    await booking.reconcile();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Reconcile failed.', detail: String((e && e.message) || e) }));
  }
};