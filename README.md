# S&A Ledger

Expense tracker for Sulekha and Anubhav.

- `public/index.html`: the whole app (login, Overview, Transactions, Visualizations). Served by Netlify.
- `firestore.rules`: Firestore security rules. Only the two allowed logins can read or write.
- `netlify.toml`: Netlify config (publish `public/`, no build).
- `firebase.json`, `.firebaserc`: Firebase project config (`sa-ledger-no-ana`).

Data lives in Firestore (`expenses` collection), not in this repo. Deploying a new
version of the app never touches the data.

Changing `firestore.rules` here does not publish it: paste it into
Firebase console → Firestore Database → Rules → Publish.

## Phone capture (Android)

`netlify/functions/capture.mjs` is served at `/api/capture`. MacroDroid on the phone POSTs each
banking-app notification there; the function reads amount, currency and merchant
(`public/parse.js`) and stores it in the Firestore `inbox` collection. The app shows it under
"To review"; nothing enters the ledger until someone saves it.

Netlify environment variables (scope: Functions):
- `FIREBASE_SERVICE_ACCOUNT`: contents of the Firebase service account JSON key
- `CAPTURE_TOKENS`: `anubhav:<secret>,sulekha:<secret>` (secrets at least 16 characters)

## Daily backup to Google Drive

`netlify/functions/backup.mjs` runs every night (02:15 UTC) and saves the whole ledger as one JSON file
in a Drive folder called "S&A Ledger backups", keeping the newest 30. It needs these environment
variables in Netlify, besides `FIREBASE_SERVICE_ACCOUNT`: `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`,
`GDRIVE_REFRESH_TOKEN` (OAuth refresh token with the `drive.file` scope). Any backup file can be restored
from the app's menu with "Restore from backup".

## Ask AI (Groq)

The "Ask AI" button sends a compact summary of the ledger, budgets, accounts, investments and FIRE plans, built
in the browser, to `netlify/functions/ask.mjs`. The function checks the Firebase sign-in (only the two members),
adds the instructions and streams the answer from Groq. Set `GROQ_API_KEY` in Netlify (and optionally
`GROQ_MODEL`, default `openai/gpt-oss-120b`). The key never reaches the browser.

## Bookings (tickets, boarding passes, hotels)

Trips have an itinerary. Add a booking from a trip ("+ Booking"), the Trips page, the menu, by sharing a PDF or
screenshot to the installed app (Android share sheet), or by forwarding the confirmation email.

- The browser reads the PDF (pdf.js from jsdelivr) and scans QR/Aztec/PDF417 codes with the built-in
  BarcodeDetector (Chrome on Android and macOS; not Firefox, Safari or Chrome on Windows). Each code is kept as a
  small image on the booking, ready to show full screen.
- `netlify/functions/extract.mjs` (`/api/extract`) asks Groq to sort the text into bookings (one per flight leg,
  train, stay…). Screenshots and scanned PDFs go to a vision model (`GROQ_VISION_MODEL`, default
  `meta-llama/llama-4-scout-17b-16e-instruct`). Uses the same `GROQ_API_KEY`.
- `netlify/functions/booking-file.mjs` (`/api/booking-file`) keeps the original file in Google Drive, folder
  "S&A Ledger bookings", using the same `GDRIVE_*` variables as the backup. Files up to 4 MB.
- Forwarded emails: `netlify/functions/inbound.mjs` (`/api/inbound`) receives Postmark's inbound webhook.
  1. Create a free Postmark account and a server; open the server's **Default Inbound Stream → Settings**.
  2. Set the webhook URL to `https://<your-site>/api/inbound?token=<INBOUND_TOKEN>`.
  3. In Netlify add `INBOUND_TOKEN` (a long random string) and `BOOKING_SENDERS` (comma-separated addresses
     allowed to forward, for example both of yours).
  4. Copy the inbound address (`…@inbound.postmarkapp.com`) into the app: Add booking → "Add your forwarding
     address". Gmail auto-forward filters work too (the original sender is accepted when Gmail marks the forward).
