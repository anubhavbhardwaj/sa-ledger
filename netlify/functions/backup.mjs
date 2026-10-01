// Nightly backup of the whole ledger to Google Drive, as one JSON file per day in a folder called
// "S&A Ledger backups". Keeps the newest 30 files. The same file can be restored from the app's menu.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   FIREBASE_SERVICE_ACCOUNT  already set for the capture function
//   GDRIVE_CLIENT_ID          OAuth client ID from Google Cloud (Web application)
//   GDRIVE_CLIENT_SECRET      its secret
//   GDRIVE_REFRESH_TOKEN      refresh token for your Google account, scope drive.file
//
// drive.file only lets this function see files it created itself, never the rest of your Drive.
// To run it right away: Netlify → Logs & metrics → Functions → backup → Run now.

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const COLLECTIONS = ['expenses', 'income', 'transfers', 'accounts', 'checkins', 'invSnapshots', 'trips', 'settings'];
const FOLDER = 'S&A Ledger backups';
const KEEP = 30;
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

// Core logic, separated from Firebase and the network so it can be tested.
export async function run({ env = process.env, readAll, saveStatus, fetch: f = fetch, now = () => new Date() } = {}) {
  for (const k of ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN'])
    if (!env[k]) throw new Error(k + ' is not set');
  const at = now();
  const collections = await readAll();
  const counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
  const body = JSON.stringify({ app: 'S&A Ledger', version: 1, exportedAt: at.toISOString(), collections });

  const tr = await f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, refresh_token: env.GDRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const tj = await tr.json();
  if (!tr.ok || !tj.access_token) throw new Error('Google sign-in failed: ' + (tj.error_description || tj.error || tr.status));
  const auth = { authorization: 'Bearer ' + tj.access_token };
  const api = async (url, opt = {}) => {
    const r = await f(url, { ...opt, headers: { ...auth, ...(opt.headers || {}) } });
    if (!r.ok) throw new Error('Drive ' + (opt.method || 'GET') + ' failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.status === 204 ? null : r.json();
  };

  const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  let folder = (await api(`${DRIVE}?q=${q}&fields=files(id)`)).files?.[0]?.id;
  if (!folder) folder = (await api(`${DRIVE}?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).id;

  const name = `sa-ledger-backup-${at.toISOString().slice(0, 10)}.json`;
  const boundary = 'sa' + at.getTime();
  const multipart = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder], mimeType: 'application/json' })}\r\n`
    + `--${boundary}\r\ncontent-type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const file = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart });

  // Keep the newest 30.
  const lq = encodeURIComponent(`'${folder}' in parents and trashed=false`);
  const all = (await api(`${DRIVE}?q=${lq}&orderBy=createdTime desc&pageSize=200&fields=files(id,name)`)).files || [];
  const old = all.filter(x => x.name.startsWith('sa-ledger-backup-')).slice(KEEP);
  for (const x of old) await api(`${DRIVE}/${x.id}`, { method: 'DELETE' });

  const status = { lastAt: at.toISOString(), file: file.name, bytes: body.length, counts, kept: Math.min(all.length, KEEP) };
  if (saveStatus) await saveStatus(status);
  return status;
}

let db;
function firestore() {
  if (!db) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    db = getFirestore(getApps()[0] || initializeApp({ credential: cert(sa) }));
  }
  return db;
}

export default async () => {
  const store = firestore();
  try {
    const status = await run({
      readAll: async () => {
        const out = {};
        for (const c of COLLECTIONS) {
          const snap = await store.collection(c).get();
          out[c] = snap.docs.filter(d => !(c === 'settings' && d.id === 'backup')).map(d => ({ id: d.id, ...d.data() }));
        }
        return out;
      },
      saveStatus: s => store.collection('settings').doc('backup').set(s),
    });
    console.log('backup ok', status);
    return new Response(JSON.stringify(status), { status: 200 });
  } catch (e) {
    console.error('backup failed', e);
    try { await store.collection('settings').doc('backup').set({ lastError: String(e.message || e).slice(0, 300), errorAt: new Date().toISOString() }, { merge: true }); } catch {}
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

// Every night at 02:15 UTC (04:15 in Munich in summer, 03:15 in winter).
export const config = { schedule: '15 2 * * *' };
