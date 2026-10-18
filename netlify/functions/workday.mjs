// The answer from the 9:00 notification's Office/Home buttons (sent by the phone's service worker, no sign-in):
// POST /api/workday { date, where, sig } → saves workdays/anubhav_<date>. The signature is the one the question carried.
import { json, firestore } from '../lib/members.mjs';
import { WHERE, ASK_USER, checkSig, keyFrom } from '../lib/workday.mjs';

export async function handle(req, { env = process.env, db = firestore, now = new Date() } = {}){
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  let b; try { b = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const date = String(b.date || ''), where = String(b.where || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !WHERE.includes(where)) return json(400, { error: 'Bad request' });
  const key = keyFrom(env);
  if (!key || !checkSig(date, b.sig, key)) return json(403, { error: 'Not allowed' });
  const age = (now - new Date(date + 'T00:00:00Z')) / 864e5;
  if (age < -1 || age > 8) return json(400, { error: 'That question has expired. Answer in the app.' });
  await db().collection('workdays').doc(`${ASK_USER}_${date}`).set({ date, user: ASK_USER, where, by: 'notification', at: now.toISOString() });
  return json(200, { ok: true, date, where });
}

export default async req => {
  try { return await handle(req); }
  catch (e) { console.error('workday failed', e); return json(500, { error: 'Something went wrong' }); }
};

export const config = { path: '/api/workday' };
