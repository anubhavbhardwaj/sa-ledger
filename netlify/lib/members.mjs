// Firebase admin access and the "is this one of the two members?" check, shared by the app's API functions.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export const MEMBERS = ['anubhav.iiitb@gmail.com', 'sulekha@sa-ledger.app'];

function app() {
  if (getApps()[0]) return getApps()[0];
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  return initializeApp({ credential: cert(sa) });
}
export const verifyToken = t => getAuth(app()).verifyIdToken(t);
export const firestore = () => getFirestore(app());

export const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Returns { email } for a signed-in member, or a Response to send back.
export async function member(req, verify = verifyToken) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { res: json(401, { error: 'Not signed in. Reload the app and sign in again.' }) };
  let email;
  try { email = String((await verify(token)).email || '').toLowerCase(); }
  catch (e) {
    console.error('sign-in check failed', e?.code, e?.message);
    if (String(e?.code || '').startsWith('auth/')) return { res: json(401, { error: `Your sign-in couldn’t be confirmed (${e.code}). Sign out and in again.` }) };
    return { res: json(500, { error: 'Server setup problem checking sign-in: ' + String(e?.message || e).slice(0, 160) }) };
  }
  if (!MEMBERS.includes(email)) return { res: json(403, { error: 'Not allowed.' }) };
  return { email };
}
