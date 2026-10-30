'use strict';
/**
 * Vercel catches every path here (see vercel.json: filesystem first, then this
 * function) and hands the request to the app's own router unchanged.
 */
const { getApp } = require('./_app');

module.exports = async function handler(req, res) {
  try {
    const { app } = await getApp();
    return app.handler()(req, res);
  } catch (e) {
    // Surface the boot error instead of Vercel's opaque FUNCTION_INVOCATION_FAILED.
    // Handy while setting the project up; the detail is a config message, not a secret.
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: 'The app failed to start.', detail: String((e && e.message) || e) }));
  }
};
