'use strict';
/**
 * The Neon schema. Idempotent: every statement is CREATE ... IF NOT EXISTS,
 * so it runs safely on every start.
 *
 * Tables are prefixed bp_ (Bahia Palace) so they never clash with anything else
 * that might share the database.
 *
 *   bp_documents          one JSON row per settings/mail/state/paypal document
 *   bp_orders             one JSON row per order (id = BP-XXXXXXXX)
 *   bp_activity           the activity log, newest last
 *   bp_ticket_sold        SHA-256 of every sold ticket file (never sell twice)
 *   bp_tickets            the ticket stock itself, file bytes included
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
  // Ticket stock: one row per ticket file. status moves stock -> reserved -> sold.
  // The file bytes live in `data` (bytea) so no disk is needed, which is what lets
  // the app run on Vercel and share one stock between several instances.
  `CREATE TABLE IF NOT EXISTS bp_tickets (
     id          text PRIMARY KEY,
     folder      text NOT NULL,
     type_id     text NOT NULL,
     valid_date  date,
     status      text NOT NULL DEFAULT 'stock',
     order_id    text,
     filename    text NOT NULL,
     mime        text NOT NULL DEFAULT 'application/pdf',
     size        integer NOT NULL DEFAULT 0,
     sha256      text NOT NULL,
     data        bytea NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now(),
     reserved_at timestamptz,
     sold_at     timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS bp_tickets_stock_idx ON bp_tickets (folder, type_id, status)`,
  `CREATE INDEX IF NOT EXISTS bp_tickets_hash_idx ON bp_tickets (folder, sha256)`,
  `CREATE INDEX IF NOT EXISTS bp_tickets_order_idx ON bp_tickets (order_id)`,
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
