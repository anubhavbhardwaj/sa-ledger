# S&A Ledger

Expense tracker for Sulekha and Anubhav.

- `public/index.html`: the whole app (login, Overview, Transactions with List and Charts, Budget, Wealth, Travel). Served by Netlify.
- `firestore.rules`: Firestore security rules. Only the two allowed logins can read or write.
- `netlify.toml`: Netlify config (publish `public/`, no build).
- `firebase.json`, `.firebaserc`: Firebase project config (`sa-ledger-no-ana`).

Data lives in Firestore (`expenses` collection), not in this repo. Deploying a new
version of the app never touches the data.

Changing `firestore.rules` here does not publish it: paste it into
Firebase console → Firestore Database → Rules → Publish.

## Budget (envelopes, like YNAB)

`public/envelopes.js` holds the envelope maths (`budgetMonth`, `committedBy`, `cardShares`), used by the app and by the
evening notification. The Budget page checks that the budget accounts' balances and the budget agree; when they
don't, it lists the likely causes (a starting amount the entries no longer back, an entry on the wrong side of a
balance logged the same day) and can record an adjustment to Ready to Assign. Entries dated on a day an account's
balance was logged carry `inBal` (already in that balance, or after it) once someone says which.

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
- Boarding passes: `public/bcbp.js` decodes the barcode (IATA Bar Coded Boarding Pass) in the browser: name, booking
  reference, route, flight, date and seat, without any AI. Only documents without a boarding pass code go to Groq.
- `netlify/functions/extract.mjs` (`/api/extract`) asks Groq to sort the text into bookings (one per flight leg,
  train, stay…). Screenshots, photos and scanned PDFs go to a vision model (`GROQ_VISION_MODEL`, default
  `qwen/qwen3.8-27b`; if a model has been retired, the next one is tried). Uses the same `GROQ_API_KEY`.
- `netlify/functions/booking-file.mjs` (`/api/booking-file`) keeps the original file in Google Drive, folder
  "S&A Ledger bookings", using the same `GDRIVE_*` variables as the backup. Files up to 4 MB.
- Forwarded emails: `netlify/functions/inbound.mjs` (`/api/inbound`) receives them. The free way, with no extra
  account, is the Gmail script in `tools/gmail-bookings.gs`:
  1. In Netlify add `INBOUND_TOKEN` (a long random string). Redeploy.
  2. (Optional) a Gmail filter To `anubhav.iiitb+trips@gmail.com` → Skip the inbox. The script finds those emails itself.
  3. On script.google.com create a project, paste the script, and in Project Settings → Script properties add
     `LEDGER_URL` (the site address) and `INBOUND_TOKEN`. Run `setup()` once and allow the permissions.
  4. In the app: Add booking → "Add your forwarding address" → `anubhav.iiitb+trips@gmail.com`.
  Every 10 minutes the script sends labelled emails (text, PDFs, ticket images) to the app. You can also put the
  label on any email by hand. An inbound email service (Postmark, CloudMailin) also works: point its webhook at
  `/api/inbound?token=…` and list the allowed senders in `BOOKING_SENDERS`.

## Flight alerts

`netlify/functions/flights.mjs` runs every 10 minutes (logic in `netlify/lib/flights.mjs`). For each flight booking
it looks up the live status, keeps it in `flightStatus/<bookingId>` for the app, and sends phone notifications
through Firebase Cloud Messaging: delays of 15+ minutes and cancellations to both of you, the gate to whoever flies,
take-off and landing to whoever doesn't. Who flies comes from the passenger names on the booking (else the trip's
traveller). Each of you turns alerts on per phone (menu → Flight alerts); the phone's token is kept in `pushTokens`.
A flight's page has "Check status now" (`/api/flight-check`).

Flight status comes from AeroDataBox (free RapidAPI plan, no card: 400 units a month, 2 per lookup). It checks
sparingly, about 8 lookups a flight: from 3 hours before, every 25 minutes in the last hour, once after take-off,
then around the expected landing. FlightAware AeroAPI also works (`AEROAPI_KEY`, checks every 10 minutes).

Setup:
1. rapidapi.com → sign up → search "AeroDataBox" → Pricing → subscribe to the free Basic plan. Copy the
   X-RapidAPI-Key from the endpoint page into Netlify as `AERODATABOX_KEY`.
2. Firebase console → Project settings → Cloud Messaging → Web Push certificates → Generate key pair. Copy the
   public key into Netlify as `FCM_VAPID_KEY`. Check that "Firebase Cloud Messaging API (V1)" is enabled.
3. Redeploy, then on each phone: menu → Flight alerts → Turn on → Send a test.

### Evening reminder

`netlify/functions/daily.mjs` runs at 21:00 Berlin/Rome time (scheduled at 19:00 and 20:00 UTC; it acts on the one
that is 21:00 locally). Each of you gets a nudge if you haven't added anything that day, or if captured payments or
forwarded bookings are waiting. Quiet when the day is logged and nothing is pending. Switch it off per phone in
menu → Notifications.

## To book

Each trip has a "To book" list (`toBook` collection): what to book, the date it's for and the date to book it by
(suggested from the type: flights about 6 weeks ahead, trains and stays 3, the rest 2). Items due within a week or
overdue show on the Overview, the 21:00 reminder lists those due within 3 days, and saving a matching booking in the
trip ticks the item off and links it. Typing it in plain words ("flights to Rome on 12 Nov and back on the 15th")
and "Fill in" turns it into items via `/api/tobook` (Groq), shown for checking before they are added.

## Trip planner (flight prices)

Trips → **✈ Plan a trip** (or **✈ Find flights** on a visit) searches Google Flights for each day in the window:
leaving on the first or second day, coming back on the last or the one before, for Anubhav → Rome, Sulekha →
Ingolstadt, or both to compare. It ranks the pairs as best value (each hour together counts as €5), cheapest and
most time together, and **Plan this trip** creates the trip (or uses the visit already on those dates) with both
flights on its To book list.

**Meet somewhere new** looks for a third place instead: two Google Travel Explore searches (from Ingolstadt's and
Rome's airports, optionally by kind of place: beaches, history, museums, outdoors) give the places across Europe
both of you can fly to on those dates, cheapest together first, with Google's hotel price. **Check flights** on one
runs the day searches for both of you (8) and pairs your flights so you overlap the longest for the least money,
counting the hotel for the nights you're both there. **Plan this trip** makes a holiday for both with four flights
and the hotel on its To book list.

Setup: sign up at serpapi.com (free plan: 250 searches a month), copy **Your Private API Key** from the dashboard
and add it in Netlify as `SERPAPI_KEY`, then redeploy. One planner run uses up to 8 searches; the same day and
airports again within 6 hours come from the cache (`flightSearch` in Firestore, server only).

## Tests

- `npm test`: server functions and the Firestore rules (node's built-in test runner, no extra packages). Netlify
  runs this before every deploy, so a failing test stops the deploy and the live site stays as it was.
- `npm run test:e2e`: the app in a real browser (Chromium via Playwright), desktop and phone size, with a fake
  Firebase (`tests/e2e/mock`) and the real `/api` handlers talking to fake SerpApi and Groq. Needs
  `npm install --no-save playwright@1.56.0 && npx playwright install chromium` once.
- GitHub Actions runs both on every push (`.github/workflows/test.yml`).
- The fake Firestore refuses any field `firestore.rules` doesn't allow, read from the rules file itself, and
  `tests/unit/rules.test.mjs` checks every field list the app saves with against the rules.
