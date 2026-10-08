# Jathan ShopMate — Standalone Edition

By Jathan Global Technologies Ltd. “Your shop, organised.”

This is an independent web app with ShopMate accounts. It does not require ChatGPT or Replit. Includes the complete built application, editable source and an integration test.

## Try on a computer

1. Extract this folder.
2. Install Node.js 22.16 or newer (Node.js 24 is suitable).
3. Open a terminal in this folder and run `node dist/server.mjs`.
4. Visit `http://localhost:3000` and create an account.
5. Choose “Try demo business” and load sample products, or enter real opening stock.

The delivered build runs without installing npm packages. Business records and photos are saved in the `data` folder. Keep that folder when updating the app. Do not share its contents publicly.

## Give a friend a live website

The app must be hosted on an internet server with Node.js 22.16+ or Docker and a persistent disk. Configure HTTPS with the host/reverse proxy, set `PUBLIC_ORIGIN` to the exact final HTTPS website address, `SECURE_COOKIE=true` and `DATA_DIR` to the persistent disk. Then run `node dist/server.mjs` or the supplied Dockerfile. A host-provided address is enough; buying a custom domain is optional. Domain registration and hosting are not included in this ZIP.

This edition uses one SQLite database on one server. Keep one application instance with local persistent storage; do not put the database on a shared network filesystem or deploy multiple independent copies. It is not compatible with static-only website hosting.

## Accounts and staff

The owner creates the first account for their business. Staff & Settings allows adding staff email, role and sections. New staff receive an invitation code that the owner shares privately. They create their own account using the same email and that code, or accept the invitation in Settings if already registered. Codes expire after 7 days. Merely knowing a staff email does not grant business access.

Generate an account recovery code in Settings and store it securely. Use it on the Forgot password screen if needed. Recovery invalidates old sessions. There is no email verification or email delivery service configured; email addresses identify accounts, staff invitation codes grant membership, and recovery uses a private code instead of an emailed link. Invitation codes are not emailed automatically.

## Install on a phone

Once hosted over HTTPS, open the website in Chrome on Android and choose “Add to home screen” / “Install app”. The included manifest and icon open it in its own window. It remains a web app, not an Android APK or an App Store app. Saving sales requires internet; unfinished carts are preserved on that device. Authenticated records are not cached by the service worker.

## Features

- One business, distinct Provisions and Frozen & Other Items sections, combined dashboard.
- Products, opening stock, kg/g/piece/pack/carton units, explicit conversions and barcode/SKU search.
- Sales, split payments, manager discounts/price overrides, print/PDF receipts.
- Receipts of stock, weighted-average costs, batch expiry and expired-stock blocking.
- Returns, refunds, spoilage/photos, optional section transfers.
- Owner-approved stock counts with movement conflict checks.
- Expenses, estimated profit, sales reports, CSV import/export and JSON snapshots.
- Owner/manager/cashier permissions, audit history and unique sales IDs.

Returns are applied to the original sale period. Section profit excludes shared business expenses; use All sections for the complete result. Payments show original receipts; refunds appear on sale receipts. Negative count adjustments are stock-loss expenses. Positive adjustments increase inventory and are not treated as sales.

## Backup and recovery

Download owner snapshots regularly. For full disaster recovery, back up the SQLite database and photos folder using the host's volume snapshots or SQLite backup tools. Copying a live SQLite database file without its WAL file is not a reliable backup: stop the server first or use SQLite's online backup facility. Keep dated backups outside the server. A reviewed restore should retain original history. Scheduled backups and self-service JSON restore are not configured.

## Rebuild from source

Run `npm install`, then `npm run build`. Dependencies are pinned in package.json. Start with `npm start`. Run `npm test` for auth, persistence, quantities, roles, invitations and password recovery checks. Node's built-in SQLite may display an experimental-feature notice on some supported versions.

## Hosting status

This ZIP is runnable and tested locally. It has not been deployed to an external host and does not include a public standalone URL. The earlier ChatGPT-hosted test remains separate.
