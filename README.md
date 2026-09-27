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
