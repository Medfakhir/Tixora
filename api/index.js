'use strict';
/**
 * Vercel catches every path here (see vercel.json: filesystem first, then this
 * function) and hands the request to the app's own router unchanged.
 */
const { getApp } = require('./_app');

module.exports = async function handler(req, res) {
  const { app } = await getApp();
  return app.handler()(req, res);
};
