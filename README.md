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

## Safety update

CSV imports now require a preview and confirmation. Missing headers, invalid values and duplicate headers are rejected. Duplicates with matching section/name/unit or SKU are skipped. Up to 1,000 products are imported atomically; changes after preview require a fresh preview.

Settings → Automatic backups & restore is available to owners. The server saves changed business records hourly and verifies a daily SQLite backup. Backups are retained for 30 days, with the newest business snapshot retained. Restoring shows the record counts, requires the business name, saves a safety copy and rejects concurrent changes. Business restoration preserves accounts and staff permissions.

Offsite backup uses the private Railway shopmate-backups bucket when BACKUP_ENDPOINT, BACKUP_BUCKET, BACKUP_REGION, BACKUP_ACCESS_KEY_ID, BACKUP_SECRET_ACCESS_KEY and BACKUP_URL_STYLE are configured. These values must remain server secrets. The database upload is downloaded again and its SHA-256 checked before recording cloud success. Photos are copied separately. Check Settings for the last successful cloud backup and any failures after deployment.

For total disk loss, an operator must stop the service, download the latest private databases/database-YYYY-MM-DD.sqlite backup to the configured DATA_DIR database path (see server/storage.ts), restore photos/ from the bucket, preserve file ownership and restart one instance. Do not overwrite a running database. In-app restoration covers business records on the current disk; it does not recover deleted accounts or a lost disk. Never upload backups into the public GitHub repository.

Validation: 25 original integration checks and 52 hardening checks cover imports, historical costs, returns, business isolation, role permissions, restored records, SQLite integrity, persistence and protected photos. Cloud round-trip verification is implemented but requires the updated release to be deployed before checking the actual Railway bucket.

## Photo entry and faster sales

Products → Add from invoice photo: photograph or choose a JPG/PNG/WebP under 10 MB. English printed text is read on the device using Tesseract.js 5.1.1. Reader software and language assets download from public CDNs, requiring internet. The image is not sent to those CDNs. Reading accuracy depends on lighting and invoice layout. PDFs and handwriting are not supported.

The table contains suggestions, not confirmed inventory. Verify names, actual stock quantities, units and unit costs; enter selling prices. Unclear values are blank. Check duplicates & preview, then confirm import. No product or stock is saved during reading. This creates new products; use Add Stock for existing goods. Product photographs can be supplied separately when adding a product. Invoice photos do not automatically become product pictures.

Sell: tap a product card. Repeated taps increase the same cart line. Use +/− for quantities. Frozen kg/g products open common weight buttons or an exact weight field. The operator must weigh variable portions; the app does not connect to a scale. Popular products appear first, based on the displayed sales period. Section tabs filter products.

Owner: Staff & Settings → Add staff → Cashier → assigned sections. Share the private invitation code with the worker. They create their own account using that email and code, or sign in and accept an invitation. Cashiers start on Sell and see a sales-only navigation. Server rules block imports, stock administration, price overrides, discounts, refunds and reports. Sales record the worker email. Owners retain reports and administration.

Validation: production build, 77 integration checks and 8 invoice parsing checks passed. The reader CDN assets returned HTTP 200. A real phone camera/photo workflow still needs device testing after deployment.

## Owner and worker login update

The login page now offers Shop owner and Shop worker. Owners use existing email/password. Owner → Staff & Settings → Create worker login: supply a worker name, a unique username (3–40 characters), a password (10–128 characters) and at least one assigned section. The owner shares those credentials privately. Each worker logs in immediately through Shop worker, without signup or invitation codes. Existing invited cashiers can use their email/password through Shop worker. Existing manager accounts retain their previous permissions.

Worker accounts are always Cashier. They see the sales screen and assigned products with prices. Tap Coke (or another product), adjust quantity, select payment and Complete sale. Accounts do not permit price changes, discounts, imports, stock management, refunds, reports or backups. Owner sees completed sales on Today’s sales by worker and sales history with worker names. Refresh occurs every five seconds while the owner’s page is visible, online and not saving. Unfinished carts do not count as sales.

Owner can reset worker passwords and remove access in Staff & Settings. Resets sign out existing sessions; removal prevents further worker login. Passwords are hashed in storage and are never returned on staff lists. The credentials confirmation window displays the password the owner just supplied; share it privately and close the window. Removed usernames remain reserved, so use a new username if creating a replacement account.

Cart drafts are isolated per signed-in account on a shared device. Private business data stays separated. A new worker_accounts table is created automatically; existing data is preserved. The daily full SQLite backup includes the new table.

Validation: the previous 85 checks plus 26 worker account checks passed (111 checks total). Worker tests cover owner provisioning, wrong passwords, login separation, worker sales attribution, section limits, forbidden administration, cross-shop reset rejection, session invalidation, access removal and password secrecy.

The browser security policy now permits the version-pinned OCR reader’s CDN assets and local worker execution, correcting the previous deployment’s restriction on photo reading. Real phone photo accuracy still needs review and device testing.

## Visible sign out and fingerprint / phone lock

Sign out is visible in the top bar, and Account also includes a Sign out button. It invalidates the current server session and returns to the login page. A connection is needed to revoke the server session; failures are shown rather than falsely reporting sign out.

Sign in with your existing password, open Account, and choose Enable fingerprint / phone lock. Follow your device prompt to save a passkey. On future visits select Shop owner or Shop worker and Fingerprint / phone lock. Use a supported HTTPS browser, preferably the normal Chrome browser on Android. The device may use a fingerprint, face recognition or its screen-lock PIN. ShopMate cannot require fingerprint over PIN and never receives or stores biometric templates. Device setup must be completed by its user; deployment cannot enroll a fingerprint automatically. Password login and owner-provided worker passwords remain available.

Use your own phone for setup: anyone who can unlock a shared device may be able to use a saved passkey. Account shows registered devices/passkeys and allows removal. Password recovery and owner-triggered worker password resets revoke existing passkeys; enroll again afterwards. Removed workers cannot use a saved passkey to bypass revoked shop access.

Implementation uses pinned SimpleWebAuthn 13.3.0 server and browser libraries. Registration requires an active signed-in account, a platform authenticator, discoverable credentials and user verification. Five-minute, single-use challenges are bound to an HttpOnly cookie; registration also binds to the authenticated session. Server verifies origin, relying-party domain, challenge, signatures and verification flags. Private device keys never leave the authenticator. SQLite stores credential public keys, counters and labels. New passkey tables are created automatically and included in full database backups.

128 checks passed: previous 111 integration/parser checks plus 17 cryptographic passkey checks. Tests use signed synthetic WebAuthn credentials to check registration, user verification, login, replay/origin rejection, portal separation, revoked credentials, account privacy and logout. Physical fingerprint prompts still require verification on the actual phone after deployment.
