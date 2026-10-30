'use strict';
/**
 * The Neon schema. Idempotent: every statement is CREATE TABLE IF NOT EXISTS,
 * so it runs safely on every start.
 *
 * Tables are prefixed bp_ (Bahia Palace) so they never clash with anything else
 * that might share the database.
 *
 *   bp_documents          one JSON row per settings/mail/state/paypal document
 *   bp_orders             one JSON row per order (id = BP-XXXXXXXX)
 *   bp_activity           the activity log, newest last
 *   bp_ticket_sold        SHA-256 of every sold ticket file (never sell twice)
 *   bp_locks              cross-process / cross-instance locks
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bp_documents (
     name       text PRIMARY KEY,
     data       jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS bp_orders (
     id         text PRIMARY KEY,
     data       jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS bp_activity (
     seq        bigserial PRIMARY KEY,
     entry      jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS bp_ticket_sold (
     hash       text PRIMARY KEY,
     order_id   text NOT NULL,
     sold_at    timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS bp_locks (
     name       text PRIMARY KEY,
     owner      text NOT NULL,
     expires_at timestamptz NOT NULL
   )`,
];

async function ensure(db) {
  for (const sql of STATEMENTS) await db.query(sql);
}

module.exports = { ensure, STATEMENTS };
