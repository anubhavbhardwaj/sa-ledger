// Every 10 minutes: check upcoming flights and send phone alerts (logic in ../lib/flights.mjs).
// Environment: AERODATABOX_KEY (RapidAPI, free plan) or AEROAPI_KEY (FlightAware), FIREBASE_SERVICE_ACCOUNT.
import { firestore } from '../lib/members.mjs';
import { run, store } from '../lib/flights.mjs';

export default async () => {
  try {
    const res = await run(store(firestore()));
    console.log('flights', JSON.stringify(res));
    return new Response(JSON.stringify(res), { status: 200 });
  } catch (e) {
    console.error('flights failed', e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

export const config = { schedule: '*/10 * * * *' };
