# Badi Palace Museum — online entrance tickets

Booking site for **book.visitbadipalace.com**: visitors choose a visit date, buy adult and
child entrance tickets, pay with PayPal, and receive a confirmation email with a QR code.
Staff scan that QR code at the gate. Administrators manage prices, daily capacity, closures,
orders and check-ins from a private dashboard.

> **Not the official ticket office unless authorised.** The site is an independent booking
> platform. The public pages show a disclaimer until an administrator enables
> **Museum settings → Authorised official ticket office**. Only enable it if the museum has
> authorised this site in writing.

## What is included

- **Booking** — date calendar with past dates, same-day cutoff, admin closures, weekly
  closures, booking window, sold-out days and optional daily capacity. Adult/child
  quantities with a live total, then full name, email and international phone number.
- **Server-side truth** — the server re-reads prices, capacity and closures, recalculates the
  total from the database, and re-checks availability before creating the order. The browser
  never supplies the amount that is charged.
- **PayPal** — Smart Buttons for the browser, Orders v2 create/capture on the server, and a
  verified webhook for payment and refund events. An order becomes `PAID` only after the
  server captures the payment (or verifies a PayPal webhook).
- **Email + QR** — confirmation email with visit date, ticket counts, total, order number and
  a QR code containing the order's random public ID. Resend is the preferred provider; SMTP
  is the fallback. A failed email never cancels a paid booking — it can be retried.
- **Gate check-in** — camera QR scanner or manual booking-reference entry, with an
  idempotent check-in (a second scan reports the original check-in instead of duplicating it).
- **Admin dashboard** — revenue for today / this week / this month / all time, paid order and
  ticket counts, 30-day revenue chart, recent bookings, monthly sales calendar, searchable
  orders table with museum filters, CSV export, closures and museum settings.
- **Languages** — English, French and Spanish, switchable from the header. The dictionaries
  live in `src/lib/i18n/messages.ts`; adding another language is one dictionary entry plus a
  locale in `LOCALES`.
- **Timezone** — business days, cutoffs and reports use `Africa/Casablanca` by default. All
  timestamps are stored in UTC and converted for display.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/base-ui primitives
- Prisma 6 with **PostgreSQL**
- PayPal Orders v2 REST API + Smart Buttons (`@paypal/react-paypal-js`)
- Resend or SMTP/Nodemailer
- Recharts, Zod, React Hook Form, QRCode, html5-qrcode
- Vitest

The original ticket-PDF catalogue, inventory, refunds and legacy admin screens remain in the
codebase. They are not part of the museum booking flow, but were kept so existing data and
payment plumbing keep working.

## Requirements

- Node.js 20.9+ (developed on Node 24)
- PostgreSQL 14+ (local, Supabase, Neon, Railway, RDS…)
- npm 10+
- `psql` only if you want `npm run setup:db` to create databases automatically

## 1. Create the databases

### Local PostgreSQL

```bash
createdb kibir
createdb kibir_test
```

Or, as a PostgreSQL administrator:

```sql
CREATE DATABASE kibir;
CREATE DATABASE kibir_test;
CREATE USER kibir WITH PASSWORD 'a-long-random-password';
GRANT ALL PRIVILEGES ON DATABASE kibir TO kibir;
GRANT ALL PRIVILEGES ON DATABASE kibir_test TO kibir;
```

`kibir_test` is used only by the test suite, which truncates it between tests. Never point
`DATABASE_URL_TEST` at real data.

### Supabase / hosted PostgreSQL

Create a project and copy the connection string. Use the **direct** connection (or session
pooler) for `DATABASE_URL` so `prisma migrate deploy` works. If you must use a transaction
pooler, run migrations with the direct URL and add
`?pgbouncer=true&connection_limit=1` to the runtime URL for serverless hosting.

## 2. Configure the environment

```bash
cp .env.example .env
openssl rand -base64 48   # AUTH_SECRET (or NEXTAUTH_SECRET)
openssl rand -hex 32      # SMTP_ENCRYPTION_KEY
openssl rand -hex 24      # CRON_SECRET
```

Required values:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL runtime connection (pooled URL on serverless hosts) |
| `DATABASE_URL_TEST` | Disposable test database; name must contain `test` |
| `DIRECT_URL` | Migrations only; direct/unpooled URL (same as `DATABASE_URL` locally) |
| `APP_URL` | Public origin, e.g. `https://book.visitbadipalace.com` |
| `AUTH_SECRET` (or `NEXTAUTH_SECRET`) | Admin session/token signing |
| `SMTP_ENCRYPTION_KEY` | 64 hex chars; encrypts PayPal/SMTP secrets stored in the DB |
| `CRON_SECRET` | Bearer token for the maintenance endpoint |
| `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` | First admin, read once by the seed |

Museum defaults (prices, currency, timezone, capacity, cutoff, booking window) are stored in
the database and seeded by `npm run db:seed`. Change them later in
**Admin → Museum settings**; they apply to the next booking immediately. Existing orders keep
the amount that was charged.

## 3. Install, migrate, seed, run

```bash
npm install
npx prisma generate
npm run db:deploy        # apply migrations (`prisma migrate deploy`)
npm run db:seed          # settings + museum defaults + first administrator
npm run dev
```

`npm run setup:db` creates both databases (when `POSTGRES_ADMIN_URL` is set) and applies
migrations to development and test. `npm run db:migrate` creates a new migration while
developing locally; `npm run db:push` is only for throwaway databases.

Sign in at <http://localhost:3000/admin/login>. There are no default production credentials:
the seed refuses to create an administrator unless a valid email and a password of at least
12 characters are supplied, and it never overwrites an existing account.

Optional demo data:

```bash
SEED_DEMO=1 npm run db:seed
```

This creates three clearly marked sample bookings on an empty museum database so the
dashboard, sales calendar and check-in screen can be tested before PayPal is connected.
They are never created in production by default.

## 4. PayPal sandbox

1. Open <https://developer.paypal.com/dashboard/applications/sandbox> and create an app.
2. Copy the **Client ID** and **Secret**.
3. Either put them in `.env`:
   ```bash
   PAYPAL_MODE=sandbox
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```
   or save them in **Admin → Settings → PayPal** (stored encrypted). Database values take
   precedence; environment values work even if the database toggle is off.
4. Register a webhook pointing at `https://YOUR_DOMAIN/api/paypal/webhook` and subscribe to:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REVERSED`
5. Copy the webhook ID into **Settings → PayPal** or `PAYPAL_WEBHOOK_ID` (or the explicit
   `PAYPAL_WEBHOOK_ID_SANDBOX` / `PAYPAL_WEBHOOK_ID_LIVE`).
6. Use a PayPal sandbox **personal** buyer account at checkout. No real money moves.

The return page is not proof of payment. The browser only tells the server *which* PayPal
order to capture; the server re-reads the capture from PayPal, checks amount, currency and
ownership, and only then flips the order to `PAID`.

## 5. Email and QR codes

Resend is used when `RESEND_API_KEY` is set:

```bash
RESEND_API_KEY=re_...
RESEND_FROM="Badi Palace Museum <tickets@visitbadipalace.com>"
```

Verify the sending domain in Resend first. Without Resend, configure SMTP in
**Admin → Settings → SMTP** and use **Verify** / **Send test email**. The confirmation email
attaches the QR code as a PNG and includes a link to `/order/<publicId>` where the same QR
code is displayed.

A paid order stays paid even when delivery fails. The email is queued and retried; failures
are visible in **Admin → Email logs** and can be retried from the order page.

### Free test inbox (Ethereal / Mailtrap)

To see real confirmation emails without a domain or a paid plan, use a capture inbox:

1. Open <https://ethereal.email/> and click **Create Ethereal Account**. It shows a host,
   port, username and password (no signup required). Mailtrap (<https://mailtrap.io>) works
   the same way if you already have it.
2. Sign in to **/admin** and open **Settings → SMTP**. Fill in:
   - **Host** `smtp.ethereal.email` (Mailtrap shows its own host)
   - **Port** `587`, **Encryption** `STARTTLS`
   - **Username** and **Password** as Ethereal provided
   - **Sender email** — any address, e.g. `tickets@visitbadipalace.com`
   - enable **SMTP delivery**
3. Click **Verify** (expect “Connected to …”), then **Send test email**.
4. Open <https://ethereal.email/messages> (or the Mailtrap inbox) to read it, including the
   QR attachment.

Resend is only used when `RESEND_API_KEY` is set; SMTP is the fallback, so leave
`RESEND_API_KEY` unset when testing with Ethereal.

The confirmation is sent **immediately** after a capture. If that send fails it stays queued and
is retried by the admin **Retry delivery** action on the order page and by
`POST/GET /api/cron/expire-reservations`. To test the email without PayPal, seed the demo
bookings (`SEED_DEMO=1 npm run db:seed` — they are already `PAID`) and press **Retry delivery**
on one of them in **/admin/orders**.

## 6. Admin tour

| Page | What it does |
| --- | --- |
| `/admin` | Revenue today/week/month/all time, order and ticket counts, check-in progress, 30-day chart, upcoming visits, recent bookings |
| `/admin/sales-calendar` | Month by visit date: revenue, ticket counts, checked-in counts, closures, remaining capacity; click a day for its orders |
| `/admin/check-in` | Camera QR scanner or manual reference entry, with “accept any visit date” escape hatch |
| `/admin/closed-dates` | Close a single date or an inclusive range; enable recurring weekly closures |
| `/admin/orders` | Search and filter by status, environment, order type and visit date; open an order for details |
| `/admin/orders/[id]` | Museum ticket breakdown, payment IDs, check-in state and email delivery attempts |
| `/admin/settings/museum` | Museum name, contact, timezone, currency, adult/child prices, daily capacity, cutoff, booking window, per-order limits, official-partner disclaimer |
| `/admin/settings/paypal` | Sandbox/live credentials and webhook ID |
| `/admin/settings/smtp` | SMTP credentials and test tools |
| `/admin/activity-logs` | Audited admin actions, including settings changes, closures, exports and check-ins |

The orders CSV is exported from **Orders → Export** or from the sales calendar. It includes
museum visit date, adult/child counts, check-in data and PayPal identifiers, and neutralises
spreadsheet formula injection.

## 7. End-to-end test checklist

Run these against a staging deployment with sandbox PayPal and a test email inbox.

1. **Seed and sign in** — `npm run db:seed`; sign in at `/admin/login`; confirm the dashboard
   loads with zero or demo data.
2. **Calendar rules**
   - Past dates are disabled.
   - Today is disabled after the configured cutoff in `Africa/Casablanca`.
   - Close tomorrow in **Closures**; it disappears from the public calendar.
   - Enable a weekly closure; every matching weekday disappears.
   - Set a small capacity (e.g. 3), buy 2 tickets, then confirm only 1 remains; try to buy 2
     more and confirm the client and server both refuse.
3. **Quantities and validation** — try 0 tickets, >20 adults, >20 children, invalid email,
   short phone, missing name. Confirm inline errors and that the total updates live.
4. **Server recalculation** — with the booking form open, change a price in museum settings,
   then submit. The order total must use the new database price.
5. **Payment**
   - Create an order, approve it with a PayPal sandbox buyer.
   - Confirm the order is `AWAITING_PAYMENT` before approval and `PAID` only after capture.
   - Confirm the success page shows order number, visit date, adult/child counts, total and
     QR code.
   - Reload the success page / replay the callback; it must remain paid without a second
     capture.
6. **Email** — confirm the confirmation email arrives with the QR attachment; open the
   `/order/<publicId>` link and compare the QR payload.
7. **Check-in** — scan the QR in `/admin/check-in`; confirm the party details. Scan again:
   the result must say “Already checked in”, not create a duplicate. Try a booking for
   another date: it must be refused unless “accept any visit date” is enabled. Try an unpaid
   order: it must be refused.
8. **Refunds** — refund a sandbox capture from the admin order page (or the PayPal dashboard).
   Confirm the webhook records `PAYMENT.CAPTURE.REVERSED` and the order reflects the refund.
9. **Reports** — confirm today/week/month/all-time revenue and ticket counts match the paid
   orders. Check the 30-day chart, monthly calendar and CSV totals.
10. **Languages** — switch EN / FR / ES from the header; the booking flow, summary and
    disclaimer should translate. Customer emails follow the booking locale.
11. **Rate limiting** — submit the checkout or availability endpoint repeatedly; excess
    requests should receive a throttled response rather than creating orders.

## 8. Maintenance endpoint

`POST /api/cron/expire-reservations` releases expired legacy ticket holds, drains the email
queue with backoff and prunes stale rate-limit buckets. It requires the `CRON_SECRET` as a
bearer header — never in the query string:

```bash
curl -X POST https://YOUR_DOMAIN/api/cron/expire-reservations \
  -H "Authorization: Bearer $CRON_SECRET"
```

Run it every minute from Vercel Cron (Pro), Railway, crontab or a systemd timer. It is required
for email retries; the museum flow has no time-limited inventory holds. On Vercel Hobby the
bundled `vercel.json` schedules it once a day, and confirmation emails are sent immediately on
capture, so the daily run only catches failed retries. `GET` and `POST` are both accepted
(Vercel Cron uses `GET`).

## 9. Tests and quality checks

```bash
npm run test:unit   # no database: money, crypto, templates, upload sniffing, ids
npm test            # integration: requires DATABASE_URL_TEST (truncates it)
npm run typecheck
npm run lint
npm run build       # production build
```

The integration suite runs against real PostgreSQL. The setup refuses to run unless the test
database name contains `test`.

## 10. Deployment

- Run `npx prisma migrate deploy` before starting a new build. Never `db push` in production.
- Set `NODE_ENV=production`, a real HTTPS `APP_URL`, and a strong `AUTH_SECRET`.
- PayPal redirect URLs and email links are built from `APP_URL`; a wrong value sends buyers
  to the wrong host.
- Keep `SMTP_ENCRYPTION_KEY` stable and back it up with the database. Without it, PayPal and
  SMTP secrets saved in the database cannot be decrypted (the app falls back to environment
  values, if any).
- Back up the PostgreSQL database. If the legacy PDF catalogue is used, also back up
  `STORAGE_LOCAL_DIR` or the S3 bucket.
- The museum has no background worker requirement beyond the maintenance endpoint; email
  retries run when it is called.
- Set `APP_URL=https://book.visitbadipalace.com` and register the production PayPal webhook
  before enabling live credentials.

### Free deployment: Vercel Hobby + Neon Postgres

Enough to run and test the whole flow, including sandbox payments:

1. **Database** — create a free [Neon](https://neon.tech) project and copy both connection
   strings. Neon labels one **pooled** (hostname contains `-pooler`) and one **direct**.
   - `DATABASE_URL` = pooled string, plus `?sslmode=require`
   - `DIRECT_URL` = direct string, plus `?sslmode=require`
   Supabase works the same way: pooled URL (port 6543, add `?pgbouncer=true&connection_limit=1`)
   for runtime, `db.<ref>.supabase.co:5432` for `DIRECT_URL`.
2. **Repository** — push this project to its own GitHub repository. The repository root must
   contain `package.json`, `prisma/` and `vercel.json`; if it lives in a subfolder, set the
   Vercel **Root Directory** to that folder. (Do not deploy the whole `Desktop` repo.)
3. **Import** the repository at <https://vercel.com/new>. Vercel detects Next.js and runs the
   `vercel-build` script (`prisma migrate deploy && next build`); `npm install` runs
   `prisma generate` automatically via the `postinstall` script.
4. **Environment variables** (Project → Settings → Environment Variables, Production + Preview):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon **pooled** URL (`...-pooler...?sslmode=require`) |
   | `DIRECT_URL` | Neon **direct** URL (`...?sslmode=require`) |
   | `APP_URL` | `https://<your-project>.vercel.app` (or the custom domain) |
   | `AUTH_SECRET` | `openssl rand -base64 48` |
   | `SMTP_ENCRYPTION_KEY` | `openssl rand -hex 32` |
   | `CRON_SECRET` | `openssl rand -hex 24` (also authorises the daily Vercel Cron) |
   | `INITIAL_ADMIN_EMAIL` | your admin email |
   | `INITIAL_ADMIN_NAME` | your name |
   | `INITIAL_ADMIN_PASSWORD` | at least 12 characters |
   | `PAYPAL_MODE` | `sandbox` |
   | `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | from the PayPal sandbox app (optional — can also be saved in the admin UI) |

   Do **not** set `DATABASE_URL_TEST` in production, and do not set `RESEND_API_KEY` when
   testing with Ethereal SMTP.
5. **First admin** — after the first successful deploy, run the seed once locally against the
   Neon database (`DATABASE_URL=... DIRECT_URL=... npm run db:seed`) or from a Vercel CLI shell
   (`vercel env pull .env.production && npm run db:seed`). Then sign in at `/admin/login`.
6. **PayPal webhook** — in the PayPal sandbox app, add
   `https://<your-project>.vercel.app/api/paypal/webhook` and subscribe to the events listed in
   section 4, then save the webhook ID in **Settings → PayPal**.
7. **Cron** — `vercel.json` schedules `/api/cron/expire-reservations` once a day (the Hobby
   limit; the route accepts both `GET` and `POST`). Confirmation emails are sent immediately on
   capture, so the daily run only picks up failed retries. On Pro, change the schedule to
   `*/5 * * * *`.

Free-tier notes: Vercel Hobby is for non-commercial use — upgrade to Pro before taking real
payments. Neon's free branch scales to zero and wakes on the first request, so the very first
page load may be slow. Vercel's serverless filesystem is read-only: with `STORAGE_PROVIDER=LOCAL`
the legacy PDF files will not persist, but museum bookings do not use them.

## Project layout

```
prisma/schema.prisma          data model (PostgreSQL, museum + legacy catalogue)
prisma/migrations/            migration history
scripts/seed.mjs              settings, museum defaults, first admin, optional demo
scripts/setup-dev-db.mjs      create/migrate development + test databases
src/app/(store)/              public museum site, booking, success, order status, legal
src/app/admin/                admin dashboard, orders, calendar, check-in, settings
src/app/api/museum/           public availability + checkout endpoints
src/app/api/admin/            closures, check-in, museum settings, exports
src/lib/museum/               settings, dates, availability, pricing, orders, reports
src/lib/orders/               checkout, PayPal capture, webhook application
src/lib/email/                templates, Resend/SMTP transport, queued delivery
src/lib/i18n/                 EN/FR/ES dictionaries and locale switching
src/components/museum/        calendar, booking widget, PayPal buttons
vercel.json                   Vercel build/cron config (Hobby-compatible)
```

## Known limitations

- Refunds are issued through PayPal per capture; PayPal fees are not modelled in reports.
- The legacy ticket-PDF catalogue and its reservation flow remain, but museum bookings do not
  allocate PDF inventory.
- Email delivery requires Resend or SMTP. Booking works without it, but visitors will not
  receive their QR code until a provider is configured.
- The site is not the museum's official ticket office unless the official-partner setting is
  enabled and the operator is authorised.
