// "Check now" on a flight in the app: POST /api/flight-check { bookingId } → the fresh status.
// Uses one lookup (2 AeroDataBox units); a check within the last 5 minutes is returned as it is.
import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { checkFlight, store } from '../lib/flights.mjs';

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch, db, now = Date.now() } = {}) {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const m = await member(req, verify); if (m.res) return m.res;
  if (!env.AERODATABOX_KEY && !env.AEROAPI_KEY) return json(503, { error: 'Flight status isn’t set up yet: add AERODATABOX_KEY in Netlify.' });
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const id = String(body.bookingId || '');
  const b = await db.booking(id);
  if (!b || b.type !== 'flight') return json(404, { error: 'No such flight' });
  const st = (await db.loadStatus([id]))[id] || {};
  if (st.checkedAt && now - Date.parse(st.checkedAt) < 5 * 60e3 && !st.error) return json(200, { ...st, cached: true });
  let tokens = null;
  const r = await checkFlight({ ...b, id }, { ...st, done: false }, { now, env, fetch: f, trips: await db.loadTrips(), saveStatus: db.saveStatus, send: db.send,
    tokens: async () => (tokens ||= await db.loadTokens()), dropTokens: db.dropTokens });
  return json(r.error ? 502 : 200, r.error ? { error: r.error } : r);
}

export default async (req) => {
  try {
    const fsdb = firestore(), s = store(fsdb);
    return await handle(req, { db: { ...s, booking: async id => { const d = await fsdb.collection('bookings').doc(id).get(); return d.exists ? d.data() : null; } } });
  } catch (e) { console.error('flight-check failed', e); return json(500, { error: 'Couldn’t check: ' + String(e.message || e).slice(0, 160) }); }
};

export const config = { path: '/api/flight-check' };
