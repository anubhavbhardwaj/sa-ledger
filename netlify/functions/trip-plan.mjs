// Trip planner: real flight prices from Google Flights (through SerpApi) for one or both directions between home
// and the other city, as one-way searches per day. The app combines outbound and return days and ranks them.
//
// POST /api/trip-plan { legs: [{ from: 'MUC,NUE,FMM', to: 'FCO,CIA', date: 'YYYY-MM-DD' }, ...], adults }
//   → { legs: [{ from, to, date, options: [...], insight, error? }], left }
// Each search costs one SerpApi search (free plan: 250 a month). Results are kept in Firestore for 6 hours, so
// opening the planner again for the same days costs nothing.
//
// Environment: SERPAPI_KEY (serpapi.com → Dashboard → Your Private API Key), FIREBASE_SERVICE_ACCOUNT.
import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { beat } from '../lib/health.mjs';

const TTL = 6 * 3600e3, MAX_LEGS = 8, MAX_OPTIONS = 12;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isAirports = v => typeof v === 'string' && /^[A-Z]{3}(,[A-Z]{3}){0,5}$/.test(v);

// "2027-03-25 07:10" → "2027-03-25T07:10" (local time at that airport)
const t = s => { const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})/); return m ? `${m[1]}T${m[2].padStart(2, '0')}:${m[3]}` : null; };

export function normalize(j){
  const all = [...(j.best_flights || []).map(x => ({ ...x, best: true })), ...(j.other_flights || [])];
  const out = [];
  for (const it of all){
    const seg = Array.isArray(it.flights) ? it.flights : [];
    if (!seg.length || !(+it.price > 0)) continue;
    const a = seg[0], z = seg[seg.length - 1];
    out.push({
      price: Math.round(+it.price), best: !!it.best,
      from: a.departure_airport?.id || null, to: z.arrival_airport?.id || null,
      dep: t(a.departure_airport?.time), arr: t(z.arrival_airport?.time),
      minutes: +it.total_duration || null, stops: seg.length - 1,
      airline: [...new Set(seg.map(s => s.airline).filter(Boolean))].join(' + ') || null,
      numbers: seg.map(s => String(s.flight_number || '').replace(/\s+/g, ' ')).filter(Boolean),
      via: (it.layovers || []).map(l => l.id).filter(Boolean),
      overnight: seg.some(s => s.overnight) || (it.layovers || []).some(l => l.overnight),
    });
  }
  // cheapest first, drop exact duplicates (same flights listed twice)
  const seen = new Set();
  return out.sort((x, y) => x.price - y.price).filter(o => { const k = o.numbers.join('|') + o.dep; if (seen.has(k)) return false; seen.add(k); return o.dep && o.arr; }).slice(0, MAX_OPTIONS);
}

export async function search(leg, { key, adults, fetch: f }){
  const q = new URLSearchParams({ engine: 'google_flights', type: '2', departure_id: leg.from, arrival_id: leg.to, outbound_date: leg.date,
    currency: 'EUR', hl: 'en', gl: 'de', adults: String(adults), api_key: key });
  const r = await f('https://serpapi.com/search.json?' + q);
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || j.error){
    const e = String(j.error || 'SerpApi ' + r.status);
    // "no results" is an answer, not a failure
    if (/hasn't returned any results|no results/i.test(e)) return { options: [], insight: null };
    return { error: r.status === 401 || /invalid api key/i.test(e) ? 'SERPAPI_KEY is not valid' : r.status === 429 || /run out of searches/i.test(e) ? 'Monthly SerpApi searches used up' : e.slice(0, 160) };
  }
  const pi = j.price_insights || null;
  return { options: normalize(j), insight: pi ? { level: pi.price_level || null, low: pi.lowest_price || null, typical: pi.typical_price_range || null } : null };
}

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch, cache, now = Date.now() } = {}){
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.SERPAPI_KEY) return json(503, { error: 'Flight prices need SERPAPI_KEY in Netlify (free key from serpapi.com).' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const adults = Math.min(4, Math.max(1, Math.round(+body.adults || 1)));
  const legs = (Array.isArray(body.legs) ? body.legs : []).filter(l => l && isAirports(l.from) && isAirports(l.to) && isDate(l.date)).slice(0, MAX_LEGS);
  if (!legs.length) return json(400, { error: 'Nothing to search.' });
  const res = await Promise.all(legs.map(async l => {
    const id = [l.from, l.to, l.date, adults].join('_').replace(/,/g, '-');
    const hit = cache && await cache.get(id).catch(() => null);
    if (hit && now - hit.at < TTL) return { ...l, ...hit.data, cachedAt: new Date(hit.at).toISOString() };
    const r = await search(l, { key: env.SERPAPI_KEY, adults, fetch: f });
    if (!r.error && cache) await cache.set(id, { at: now, data: r }).catch(() => {});
    return { ...l, ...r };
  }));
  let left = null;
  try { const a = await (await f('https://serpapi.com/account.json?api_key=' + encodeURIComponent(env.SERPAPI_KEY))).json(); left = a.total_searches_left ?? a.plan_searches_left ?? null; } catch {}
  return json(200, { legs: res, left });
}

export default async (req) => {
  const db = firestore();
  const cache = { get: async id => { const d = await db.collection('flightSearch').doc(id).get(); return d.exists ? d.data() : null; }, set: (id, v) => db.collection('flightSearch').doc(id).set(v) };
  try {
    const res = await handle(req, { cache });
    const body = await res.clone().json().catch(() => ({}));
    if (res.status === 200){
      const errs = body.legs.filter(l => l.error).map(l => l.error);
      await beat(db, 'plan', errs.length ? { ok: false, error: errs[0] } : { info: `${body.legs.length} searches${body.left != null ? ', ' + body.left + ' left this month' : ''}` });
    } else if (res.status === 503) await beat(db, 'plan', { ok: false, error: body.error });
    return res;
  } catch (e) { console.error('trip-plan failed', e); return json(500, { error: 'Something went wrong searching flights. Try again.' }); }
};

export const config = { path: '/api/trip-plan' };
