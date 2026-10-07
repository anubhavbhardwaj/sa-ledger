// Every 10 minutes: check upcoming flights and send phone alerts (logic in ../lib/flights.mjs).
// Environment: AERODATABOX_KEY (RapidAPI, free plan) or AEROAPI_KEY (FlightAware), FIREBASE_SERVICE_ACCOUNT.
import { firestore } from '../lib/members.mjs';
import { run, store } from '../lib/flights.mjs';
import { beat } from '../lib/health.mjs';

export default async () => {
  try {
    const db = firestore(), res = await run(store(db));
    console.log('flights', JSON.stringify(res));
    const quota = res.quota ? ` · ${res.quota}` : '';
    await beat(db, 'flights', res.errors?.length ? { ok: false, error: res.errors.join('; '), info: `checked ${res.checked}${quota}` }
      : { info: res.skipped || `checked ${res.checked || 0} flight${res.checked === 1 ? '' : 's'}, sent ${res.sent || 0}${quota}` });
    return new Response(JSON.stringify(res), { status: 200 });
  } catch (e) {
    console.error('flights failed', e);
    await beat(firestore(), 'flights', { ok: false, error: e.message });
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

export const config = { schedule: '*/10 * * * *' };
