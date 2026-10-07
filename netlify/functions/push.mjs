// Phone alerts setup for the app.
//   GET  /api/push            → { vapidKey } the public Web Push key the app needs to sign up a phone
//   POST /api/push {test:true} → sends a test notification to the caller's phones
// Environment: FCM_VAPID_KEY (Firebase console → Project settings → Cloud Messaging → Web Push certificates).

import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { sendTo } from '../lib/push.mjs';

export async function handle(req, { env = process.env, verify = verifyToken, loadTokens, dropTokens, send } = {}) {
  if (req.method === 'GET') return json(200, { vapidKey: env.FCM_VAPID_KEY || null });
  if (req.method !== 'POST') return json(405, { error: 'Use GET or POST' });
  const m = await member(req, verify); if (m.res) return m.res;
  const tokens = await loadTokens(m.email);
  if (!tokens.length) return json(400, { error: 'This account has no phone signed up for alerts yet. Turn alerts on first.' });
  const dead = await sendTo(tokens, { title: 'Flight alerts are on', body: 'You’ll hear about delays, gates, take-offs and landings here.', tag: 'test' }, send);
  if (dead.length) await dropTokens(dead);
  return json(200, { sent: tokens.length - dead.length, phones: tokens.length });
}

export default async (req) => {
  try {
    return await handle(req, {
      loadTokens: async email => (await firestore().collection('pushTokens').where('email', '==', email).get()).docs.map(d => ({ id: d.id, ...d.data() })),
      dropTokens: ids => Promise.all(ids.map(id => firestore().collection('pushTokens').doc(id).delete())),
    });
  } catch (e) { console.error('push failed', e); return json(500, { error: 'Couldn’t send: ' + String(e.message || e).slice(0, 160) }); }
};

export const config = { path: '/api/push' };
