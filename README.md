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
