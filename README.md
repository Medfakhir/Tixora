# Bahia Palace booking app

Sell entrance tickets online. Customers pick a date and tickets and pay with PayPal (or a card through PayPal). The app then **emails the ticket files from your stock folder automatically**, within seconds.

- Booking page with a date calendar (closed days, sold-out days, same-day cut-off)
- PayPal checkout: PayPal account, debit or credit card
- Automatic delivery: each sale takes the next ticket files from `tickets/stock/`, attaches them to the email and moves them to `tickets/sold/`
- Dashboard at `/admin`: sales, orders, resend tickets, ticket stock and uploads, closing days, prices and texts
- Email settings, editable email templates and an activity log, all in the dashboard
- Runs on any host with **Node.js 18 or newer**. It has no npm packages, so there is nothing to install
- **Files by default, database optional.** Everything is kept in simple files: orders in `data/orders/`, settings in `data/settings.json`, mail settings and templates in `data/mail.json`, the activity log in `data/activity.json`, and your tickets as individual files under `tickets/`. Back up the `data/` and `tickets/` folders and you have everything. If you set `DATABASE_URL` (for example a Neon Postgres database), orders, settings, email/SMTP settings, PayPal keys, the activity log and the sold-ticket fingerprints are stored there instead — see [section 8](#8-optional-neon-postgres-database)

---

## 1. Try it on your computer (5 minutes, no PayPal needed)

1. Install **Node.js** (the "LTS" version) from <https://nodejs.org>.
2. Open Terminal, go to this folder and start the demo:
   ```
   cd ~/"Booking Flow"
   npm run demo
   ```
3. Open <http://localhost:8080>. Book a few tickets with the **Complete test payment** button.
4. Open <http://localhost:8080/admin> (password `demo1234`) to see the orders and stock.

**Another port:** to use a different port, start the demo with `PORT=9000 npm run demo` (any number from 1025 to 65535) and open `http://localhost:9000`. If the port is already used by another program, the demo moves to the next free port and prints the address to open in Terminal.

The demo uses sample tickets marked "not valid" and its own `demo/` folder, so it never touches your real tickets. Ticket emails are saved as files in `demo/data/outbox/`; open the `.html` file to see what customers receive. Stop the demo with `Ctrl + C`.

---

## 2. How the ticket stock works

```
tickets/
  stock/
    adult/                 ← adult tickets valid on any day
      ticket-0001.pdf
      ticket-0002.pdf
    adult/2026-12-24/      ← adult tickets valid only on 24 Dec 2026 (optional)
    child/                 ← child tickets
  reserved/                ← held while a customer is paying (automatic)
  sold/BP-7K3QX9MZ/        ← tickets sent with order BP-7K3QX9MZ (automatic)
  removed/                 ← duplicates and files you removed (automatic)
```

- **One file = one ticket.** PDF, PNG, JPG, GIF, WEBP or Apple Wallet `.pkpass`.
- The folder name is the ticket type's "Stock folder" in **Settings**. Add a type in Settings and its folder is created for you.
- Files go out in name order. Date-specific tickets are used first for that date, then the any-day ones.
- Add tickets in the dashboard (**Ticket stock** → drop the files), or copy them into the folder by FTP or File Manager.
- **The same ticket is never sold twice.** The app remembers a fingerprint of every file it sold. A file uploaded twice is refused, and a copy of a sold ticket found in stock is moved to `removed/duplicates/`.
- While a customer is in the PayPal window, their tickets are held for 15 minutes (you can change this in Settings). If they don't pay, the tickets go back to stock.
- You get an email when stock runs low (Settings → "Warn me when stock falls to").
- The **"Few left"** yellow label on the booking calendar is controlled by two Settings: **"Show 'Few left' when stock falls to"** (default 10; set 0 to hide the label) and **"Show 'Few left' only within this many days"** (default 3, i.e. today and the next 2 days; set 0 for every day). This is a display hint only — it does not stop sales.
- **Test payments use a separate folder.** While test payments (PayPal Sandbox) are on, tickets come from `tickets-sandbox/` instead of `tickets/`. Anyone can open a free PayPal test account, so test payments must never receive your real tickets. On the dashboard's **Ticket stock** page, switch between **Real tickets** and **Test tickets**: uploads go to the folder you have chosen, and the folder in use is marked. Put a few sample tickets in the test folder (or run `npm run sample-tickets` while test payments are on).

**With `DATABASE_URL` set (section 8)** there are no ticket files: each ticket is a row in the `bp_tickets` table and its bytes are stored in the database. Reserve, sold, dates and the "never sold twice" rule work exactly the same — the moves (`stock → reserved → sold`) are database updates instead of file renames. This is what lets the app run on **Vercel**, where the disk is thrown away between requests.

---

## 3. Go live: checklist

### a) Hosting

The app needs a host that runs Node.js and can send email. Put it on a subdomain such as `book.bahiapalace.com`, with HTTPS switched on. It runs on a normal server (files on disk) or on **Vercel with a Neon database** (see below and section 8).

**Vercel (with a Neon database):** Vercel wipes its filesystem between requests, so the app can only run there when nothing needs to stay on disk. Set **`DATABASE_URL`** (a [Neon](https://neon.com) database, section 8) and the app keeps **everything in the database — orders, settings, email, PayPal keys and the ticket files themselves** (`bp_tickets`, stored as `bytea`). The included `vercel.json` serves the booking page and dashboard as static files and sends every other request to one serverless function, and a daily cron runs the background job. You do **not** need a disk.
1. Import the repository in Vercel (Project → Add New → Project) and set the **Framework Preset** to **Other**. The `vercel.json` in the repo overrides the build step, so nothing is built.
2. Open **Settings → Environment Variables** and add (Production):
   - `DATABASE_URL` — your Neon connection string (required).
   - `SESSION_SECRET` — a long random string. Required here: without a writable disk each instance would otherwise generate its own key and SMTP passwords could not be decrypted after a redeploy.
   - `CRON_SECRET` — a long random string. Vercel sends it to the cron route so only Vercel can trigger it.
   - `BASE_URL` — your public address (`https://book.bahiapalace.com`).
   - `ADMIN_PASSWORD` — the dashboard password (leave it out to keep the dashboard off).
   - `DATA_DIR` — `/tmp/bp-data` (only used for the mail outbox and caches; the database holds the real data).
   - PayPal and email settings — add them in the dashboard after the first deploy (sections c and d).
3. Deploy, then open `/admin`. On the first request the app creates its tables in Neon and imports any files it finds.
4. Tickets are uploaded through the dashboard as usual; the bytes are stored in the database and survive redeploys.
5. The included cron (`0 3 * * *`) expires abandoned checkouts and returns unpaid tickets to stock once a day. For a busier site, change the schedule in `vercel.json` (subject to your Vercel plan's limits).

**Render (recommended, about $7.25 a month):** Render runs the app, keeps the server secure and up to date, provides HTTPS and backs up your orders and tickets every day (7 days of copies). The included `render.yaml` sets everything up.
1. Put this folder in a **private GitHub repository**. Leave out `.env`, `data/`, `demo/` and the files in `tickets/`. The included `.gitignore` does this if you use git.
2. Collect what Render will ask for: a dashboard password, your email, and your Gmail address and app password (step d). PayPal is connected later, in the dashboard (step c).
3. Sign up at <https://render.com> with your GitHub account. Choose **New → Blueprint**, pick the repository, fill in the values and click **Deploy Blueprint**. Render creates the app in Frankfurt with a 1 GB disk, on the Starter instance ($7 a month plus $0.25 for the disk). The free instance can't keep files or send email.
4. When the deploy shows **Live**, open the address Render shows (like `https://bahia-booking.onrender.com`) and add `/admin` to check the dashboard.
5. **Your own address:** in the service, open **Settings → Custom Domains** and add `book.bahiapalace.com`. At Namecheap (Domain List → bahiapalace.com → Manage → Advanced DNS) add a **CNAME Record** with host `book` and the value Render shows (like `bahia-booking.onrender.com`). Render switches on HTTPS by itself, usually within minutes.
6. In the service's **Environment** tab add `BASE_URL` = `https://book.bahiapalace.com` and save. The app restarts with the new address.

On Render the settings from step b live in the **Environment** tab instead of a `.env` file. Every change you push to GitHub is deployed automatically. A deploy takes the app offline for a few seconds; a payment approved in those seconds is finished automatically when the app is back. Server messages are in the **Logs** tab.

**cPanel hosting with "Setup Node.js App"** (most shared hosts):
1. cPanel → **Domains**: create `book.bahiapalace.com`.
2. Upload this folder (zipped) to your home folder, e.g. `/home/USER/booking`. Don't put it inside `public_html`.
3. cPanel → **Setup Node.js App** → Create application: newest Node.js version, mode *Production*, application root `booking`, URL `book.bahiapalace.com`, startup file `server.js`.
4. Create the `.env` file (step b) in the `booking` folder. You don't need to run "NPM install".
5. Press **Restart**. Turn on SSL for the subdomain (AutoSSL / Let's Encrypt).
6. cPanel → **Cron Jobs**: add a job that runs every 5 minutes:
   `curl -fsS https://book.bahiapalace.com/healthz > /dev/null`
   cPanel puts apps to sleep when nobody visits. This ping wakes the app regularly so it keeps finishing slow payments, retrying emails and returning unpaid tickets to stock.

**Hostinger (Business or Cloud plan) "Node.js Web App"**: add a new website → Node.js Web App → upload the zip, entry file `server.js` → import your `.env` under Environment variables. Hostinger replaces the app's files on every deploy, so set `DATA_DIR` and `TICKETS_DIR` to a folder **outside** the app. Hostinger support can confirm the right path for your plan.

**A small VPS** (Hetzner, DigitalOcean, Contabo…): install Node.js 22, copy the folder to `/opt/booking`, run it as a service and put Caddy in front for automatic HTTPS:
```
# /etc/systemd/system/booking.service
[Service]
WorkingDirectory=/opt/booking
ExecStart=/usr/bin/node server.js
Restart=always
User=booking
[Install]
WantedBy=multi-user.target

# /etc/caddy/Caddyfile
book.bahiapalace.com {
  reverse_proxy 127.0.0.1:3000
}
```

### b) Settings file (`.env`)

Copy `.env.example` to `.env` and fill it in. At least:
- `BASE_URL`: the public address, e.g. `https://book.bahiapalace.com`
- `ADMIN_PASSWORD`: a long password for the dashboard
- `ADMIN_EMAIL`: where sale notifications and alerts go
- Email settings (below). PayPal is connected in the dashboard (step c)

Never share `.env` and never upload it anywhere public.

### c) PayPal

You need a **PayPal Business** account (a personal account can be upgraded for free). Everything else happens on the dashboard's **PayPal** page.
1. Go to <https://developer.paypal.com>, log in with your PayPal account and open **Apps & Credentials**. On the **Sandbox** tab, create an app (type Merchant).
2. In the dashboard, open **PayPal**. Under *Test account (Sandbox)*, paste the app's **Client ID** and **Secret** and click **Connect Sandbox keys**. The app checks the keys with PayPal and sets up the webhook (payment updates for buyers who close the page right after paying, delayed payments and refunds) by itself.
3. Add a few sample tickets to the test folder (dashboard → Ticket stock, while test payments are on). Buy a ticket using a Sandbox **personal** account (developer site → Testing Tools → Sandbox Accounts) and check that the email arrives.
4. When everything works, open the **Live** tab of the same app on developer.paypal.com, paste its Client ID and Secret under *Live account*, and click **Switch to live payments**. From then on the real `tickets/` folder is used. Test orders stay in the order list marked "Test", keep their test tickets, and are not counted in your sales.

The webhook can only be set up while the app runs at its public https address (`BASE_URL`). If you add the address later, click **Check connection** on the PayPal page. You can't leave live payments while a live customer is paying or waiting for tickets.

The keys you connect are saved in `data/paypal.json`, which only the app can read; the secret is never shown again. Back it up with the rest of `data/` and never share it. Keys can also be set in `.env` instead (`PAYPAL_MODE`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, plus `PAYPAL_WEBHOOK_ID` for a webhook you create by hand pointing to `https://book.bahiapalace.com/api/paypal/webhook`). Keys connected on the PayPal page take priority.

Currency: PayPal does not support the Moroccan dirham, so prices are in **EUR** by default (change it in Settings). In your PayPal account, allow payments in a currency you don't hold ("accept and convert"). Otherwise PayPal may hold each payment until you accept it by hand. The app keeps those tickets reserved and sends them when PayPal releases the money.

### d) Email

Customers receive their tickets as email attachments, so this must work.

Set the mail server either in the dashboard (**Email (SMTP)**) or in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). What you save in the dashboard wins; leave the SMTP host empty there to keep using `.env`.

- **Gmail**: turn on 2-Step Verification, create an **App Password** at <https://myaccount.google.com/apppasswords>, then set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` = your Gmail address, `SMTP_PASS` = the app password, and put the same Gmail address in `MAIL_FROM`. Gmail allows about 500 emails a day.
- **A mailbox on your own domain** (e.g. `tickets@bahiapalace.com` at your host) looks more professional and lands in spam less often. Use your host's SMTP details (usually port 465 with SSL).
- **Brevo, SendGrid, Mailgun, Resend**: create an SMTP key in their dashboard and use it as the password (port 587 with STARTTLS, or 465 with SSL). On free plans you usually have to verify the sender address first.

Then open **Email (SMTP)** in the dashboard, click **Test connection**, and use **Send test email**. The password is stored encrypted in `data/mail.json` (it never appears on screen again). If no SMTP host is set at all, emails are saved in `data/outbox/` so you can still preview them.

### e) Tickets, prices and texts

In the dashboard:
- **Settings**: ticket types and prices, how far ahead to sell, same-day cut-off, opening hours, the instructions printed in the email, support email, and a link to your terms and refund policy (PayPal expects buyers to be able to find these).
- **Calendar**: tick weekly closing days, or click any date to close it.
- **Ticket stock**: upload your ticket files.

### f) Add it to your website

**Option 1, a button (simplest):** point your "Buy tickets" buttons to `https://book.bahiapalace.com`. On bahiapalace.com that means the **Get Your Tickets** buttons on the Tickets page; in Elementor (WordPress) add a Button with that link.

**Option 2, the booking form inside your page:** add this where the form should appear:
```html
<div id="bahia-booking"></div>
<script src="https://book.bahiapalace.com/embed.js" data-target="bahia-booking" data-offset="90" async></script>
```
In Elementor, put it in an **HTML** widget. In a Next.js site (like bahiapalace.com), put the `<div>` in the page and load the script with `<Script src="https://book.bahiapalace.com/embed.js" data-target="bahia-booking" data-offset="90" />` from `next/script`.

`data-offset` is the height of your sticky menu in pixels. Put your site's address in `EMBED_ALLOWED_ORIGINS` (already set to bahiapalace.com in `render.yaml` and `.env.example`). The form resizes itself and works with PayPal inside the page.

To open the form with a date already picked, link to `https://book.bahiapalace.com/?date=2026-12-24`.

---

## 4. Day to day

- **Overview**: today's and this month's sales, a 30-day chart, visits coming up, stock levels, and alerts (anything that needs you shows here in red).
- **Orders**: search by name, email, order number or PayPal ID. Open an order to resend the tickets (to the same or another address), copy the customer's download link, add a note or retry delivery. Export to CSV for your accountant.
- **Refunds**: refund in your PayPal account. With the webhook set up, the order is marked refunded automatically. Without it, click **Mark as refunded**. Tickets already emailed can't be taken back, so refund only tickets the customer hasn't used.
- **Needs attention**: a customer paid but there was no ticket left, for example because the stock folder was empty. Add tickets to stock and delivery is retried automatically within minutes, or click **Retry delivery**.
- **Email (SMTP)**: the mail server, sender address, and buttons to test the connection and send a test email.
- **Email templates**: change the subject, heading, introduction and footer of the four emails (ticket email, new-sale alert, problem alert and test email). Placeholders like `{date}`, `{order}`, `{site}` and `{items}` are filled in automatically.
- **Activity log**: everything the app and the dashboard do, newest first — logins, payments, emails, stock changes and settings. Search it or filter by type, and open an order straight from its number.

Customers always see a **Download tickets** button after paying, so they get their tickets even if the email is late. If an email fails, the app retries automatically.

---

## 5. Safety built in

- Prices are always calculated on the server. The browser can't change what is charged, and the captured amount is checked against the order before tickets are sent.
- Tickets are only sent after PayPal confirms the payment as completed.
- If a payment can't be confirmed (bad mobile signal, PayPal slow to answer), the buyer is told not to pay again and the PayPal button is switched off. The app keeps checking with PayPal and sends the tickets as soon as the payment is confirmed. If the same email still pays twice within an hour, you get an alert.
- Orders where money may have moved are never deleted or cancelled by the app without PayPal confirming that nothing was taken. You can't cancel a payment PayPal is still processing.
- A ticket file can't go to two customers, even with many buyers at the same moment and even if the host runs several copies of the app.
- One visitor can't hold more than a few unfinished checkouts, so nobody can block your stock.
- If the server restarts in the middle of a sale, a background job finishes it: it checks with PayPal, sends the tickets, or returns unsold ones to stock.
- Download links contain a long secret code. The dashboard is password-protected, rate-limited and can't be shown inside other sites.
- PayPal webhooks are verified with PayPal before they're trusted.
- Test and live payments are kept apart: each has its own PayPal keys, webhook and ticket folder, and an order always uses the ones of the mode it was made in. Switching to live never sends real tickets to a test order.
- PayPal keys are checked with PayPal before they're saved, and the secret is never shown again.
- Simulated payments (`PAYPAL_MODE=mock`) only work on your own computer, never on a public address, and take tickets from the test folder. Live payments need the public https address.
- Replacing or removing PayPal keys never strands a customer who is paying: the old keys are kept (privately) until the orders made with them are finished. If PayPal can't be asked about a payment that was started, the order is kept and you get an alert instead of a guess.

---

## 6. Troubleshooting

| Problem | What to check |
|---|---|
| "Online payment is temporarily unavailable" | The dashboard's PayPal page says why: usually PayPal isn't connected yet for the mode in use. |
| Uploaded tickets don't appear / the stock count looks wrong | In sandbox mode the app uses the test folder `tickets-sandbox/`, and in live mode the real `tickets/` folder. Check which mode you are in on the dashboard. |
| PayPal buttons don't appear | On the PayPal page, click **Check connection**. Sandbox keys come from the Sandbox tab and live keys from the Live tab on developer.paypal.com. Ad blockers can block PayPal. |
| "Payment updates: Waiting" on the PayPal page | The webhook needs the public https address. Set `BASE_URL`, then click **Check connection**. |
| Emails don't arrive | Settings → Send test email shows the exact error. Check the spam folder. With Gmail you need an App Password. |
| Payment "pending" | PayPal is reviewing it, or your account must accept the currency. The tickets stay reserved and go out automatically once PayPal completes it. |
| Times are off by one hour | Morocco moved to GMT on 20 September 2026. Use a current Node.js version, or set `TIMEZONE=UTC`. The dashboard shows the venue time under Settings → Connection status. |
| Dashboard says it is turned off | Set `ADMIN_PASSWORD` in `.env` (not the example value) and restart. |

Server messages are printed to the app's log (Render: the service's **Logs** tab; cPanel: the log file of the Node.js app; VPS: `journalctl -u booking`).

---

## 7. Backups and updates

- **Back up `data/` and `tickets/` regularly.** They hold all orders, settings and tickets. Code can always be copied again; these folders can't. On Render this happens automatically: the disk is copied every 24 hours and 7 days of copies are kept (service → **Disks** to restore one, which replaces everything on the disk with that day's copy). **If you use `DATABASE_URL`** (section 8), your orders and settings live in Postgres instead — back up the database there, and keep `tickets/` on the disk.
- To update the app, replace the code files but keep `.env`, `data/` and `tickets/`. On Render, push the new code to GitHub and it deploys by itself.

---

## 8. Optional: Neon Postgres database

The app runs with **no database** by default. If you prefer to keep your data in Postgres — or you want to run on **Vercel**, which has no disk — set **`DATABASE_URL`** (for example a free [Neon](https://neon.com) database) and the app stores **everything** there instead of in files:

- orders, the activity log and the small documents: **settings**, **email/SMTP settings + templates**, **PayPal keys** and the low-stock/alert **state**
- a fingerprint (SHA-256) of every **sold ticket**, so a ticket can never be sold twice, even after a redeploy
- the **ticket files themselves**: one row per ticket in `bp_tickets`, with the bytes stored in a `bytea` column. Uploading, reserving and selling become database rows changing status, so nothing needs a disk.

Only the mail **outbox** (used when e-mail is not configured) and a small per-file hash cache stay on disk; both are throwaway.

**How to switch on:**
1. Create a database at <https://neon.com> (or any Postgres) and copy its connection string.
2. Set it in the environment: `DATABASE_URL=postgresql://user:password@host/db?sslmode=require`.
   On Render or Vercel, add it in the service's **Environment Variables**. The included
   `render.yaml` asks for it when you create the Blueprint.
3. Also set a fixed **`SESSION_SECRET`** when using a database, so every instance encrypts and
   decrypts the saved SMTP password with the same key (otherwise each instance generates its own
   `data/secret.key`). This is **required on Vercel**, where each instance has its own throwaway disk.
4. Start (or redeploy) the app. On the first start the app creates its tables and **imports any
   existing files** (`data/*.json`, `data/orders/*.json`, `data/activity.json`, `data/sold-hashes.log`)
   into the database, so nothing is lost. The log prints how many rows were imported.
   Files already in `tickets/stock/` are **not** uploaded automatically; add them from the dashboard,
   or leave them where they are if you keep using disk mode.

Notes:
- Only Neon's SQL-over-HTTP endpoint is used, through Node's built-in `fetch` — still **no npm packages**.
- Leave `DATABASE_URL` empty to go back to plain files (the database is simply ignored).
- Advanced: `DATABASE_ENDPOINT` overrides the `/sql` URL (for a Neon-compatible proxy).
- Because the HTTP endpoint runs one statement at a time, each stock change happens under the app's
  cross-instance lock (`bp_locks`), so several Vercel instances can share one database safely.

## 9. For developers

- `npm test` runs the end-to-end tests: PayPal and SMTP are simulated, including declines, pending payments, webhooks, refunds, races for the last tickets, expiry and crash recovery. The database layer is tested too, against a fake `/sql` server.
- `npm run sample-tickets` creates sample PDFs (marked "not valid") in the test folder `tickets-sandbox/stock/`, used by PayPal Sandbox and simulated payments. It never writes to your real `tickets/` folder.
- Code: `server.js` (start), `src/booking.js` (order flow), `src/payments.js` (PayPal keys, payment modes, webhook setup), `src/stock.js` (ticket files), `src/dbstock.js` (the same ticket stock kept in the database, for Vercel), `src/neon.js` + `src/dbstore.js` + `src/dbschema.js` (optional Postgres storage), `src/paypal.js`, `src/mailer.js` (SMTP), `src/routes.js` (HTTP), `public/` (booking page), `public/admin/` (dashboard), `api/` + `vercel.json` (Vercel entry points and cron).
- Database tables (all prefixed `bp_`): `bp_documents`, `bp_orders`, `bp_activity`, `bp_ticket_sold`, `bp_tickets`, `bp_locks`. They are created automatically; nothing to run by hand.
- Order statuses: `pending` → `paid` → `fulfilled`. Other statuses: `payment_pending`, `needs_attention`, `expired`, `cancelled`, `failed`, `refunded`, `reversed`.
- Font: Familjen Grotesk, a grotesque with ink traps close to PolySans (SIL Open Font License, included in `public/fonts/`).
