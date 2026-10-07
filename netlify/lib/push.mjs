// Phone notifications through Firebase Cloud Messaging. Each phone that turned on alerts has a document in
// pushTokens (written by the app): { email, user, createdAt }. Messages are data-only; the app's service
// worker (public/sw.js) turns them into a notification.
import { getMessaging } from 'firebase-admin/messaging';
import { initializeApp, cert, getApps } from 'firebase-admin/app';

export const PEOPLE = { 'anubhav.iiitb@gmail.com': 'Anubhav', 'sulekha@sa-ledger.app': 'Sulekha' };

function app() {
  if (getApps()[0]) return getApps()[0];
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  return initializeApp({ credential: cert(sa) });
}

// tokens: [{ id (the FCM token), email }]. msg: { title, body, tag, url }. Returns tokens that no longer work.
export async function sendTo(tokens, msg, send = m => getMessaging(app()).send(m)) {
  const dead = [];
  await Promise.all(tokens.map(async t => {
    try {
      await send({ token: t.id, data: { title: msg.title, body: msg.body, tag: msg.tag || '', url: msg.url || '/#overview' },
        webpush: { headers: { Urgency: 'high', TTL: String(msg.ttl || 3600) } } });
    } catch (e) {
      const code = e?.errorInfo?.code || e?.code || '';
      if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(code)) dead.push(t.id);
      else console.error('push failed', code, e?.message);
    }
  }));
  return dead;
}
