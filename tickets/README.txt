TICKET FOLDERS
==============

stock/      Tickets waiting to be sold. Put your ticket files here.
reserved/   Tickets held for a customer who is paying right now (automatic).
sold/       Tickets that were sent to customers, one folder per order (automatic).
removed/    Files taken out of stock: duplicates, or removed in the dashboard.

Each file is ONE ticket (PDF, PNG, JPG, GIF, WEBP or Apple Wallet .pkpass).
Each ticket type has its own folder, named like the "Stock folder" in Settings:

  stock/adult/                   adult tickets valid on ANY day
  stock/child/                   child tickets valid on ANY day
  stock/adult/2026-12-24/        adult tickets valid ONLY on 24 December 2026

For a date, date-specific tickets are used first, then the any-day ones.
Files are sent in name order (ticket-001.pdf before ticket-002.pdf).

You can copy files in here (FTP / File Manager) or upload them in the
dashboard under "Ticket stock". The same ticket file is never sold twice:
the app remembers a fingerprint of every ticket it has sold.

Don't move files out of reserved/ or sold/ by hand.

TEST PAYMENTS: while test payments (PayPal Sandbox) are on, the app uses the folder
"tickets-sandbox" (same layout) instead of this one, so PayPal test accounts never get
real tickets. Switch between test and live payments on the dashboard's PayPal page,
and between the two folders on its Ticket stock page.
