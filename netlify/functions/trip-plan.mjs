// Trip planner: real flight prices from Google Flights (through SerpApi) for one or both directions between home
// and the other city, as one-way searches per day. The app combines outbound and return days and ranks them.
//
// POST /api/trip-plan { legs: [{ from: 'MUC,NUE,FMM', to: 'FCO,CIA', date: 'YYYY-MM-DD' }, ...], adults }
//   → { legs: [{ from, to, date, options: [...], insight, error? }], left }
// POST /api/trip-plan { explore: [{ from: 'MUC,NUE,FMM', start, end, interest }] }  (somewhere new to meet)
//   → { explore: [{ from, places: [{ id, name, country, airport, price, hotel, minutes, stops, airline }], error? }], left }
//   Google Travel Explore: return-trip prices from those airports to places across Europe for those dates.
// Each search costs one SerpApi search (free plan: 250 a month). Results are kept in Firestore for 6 hours, so
// opening the planner again for the same days costs nothing.
//
// Environment: SERPAPI_KEY (serpapi.com → Dashboard → Your Private API Key), FIREBASE_SERVICE_ACCOUNT.
import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { beat } from '../lib/health.mjs';

export const VERSION = 'p6';   // shown in the app's search details, to tell which server version answered
const TTL = 6 * 3600e3, MAX_LEGS = 12, MAX_OPTIONS = 12;   // 12: both of you, 3 days out and 2 back
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

async function searchOnce(leg, { key, adults, fetch: f }){
  const q = new URLSearchParams({ engine: 'google_flights', type: '2', departure_id: leg.from, arrival_id: leg.to, outbound_date: leg.date,
    currency: 'EUR', hl: 'en', gl: 'de', adults: String(adults), api_key: key });
  const r = await f('https://serpapi.com/search.json?' + q);
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || j.error){
    const e = String(j.error || 'SerpApi ' + r.status);
    // "no results" is an answer, not a failure
    if (/hasn't returned any results|no results/i.test(e)) return { json: {}, found: 0 };
    return { error: r.status === 401 || /invalid api key/i.test(e) ? 'SERPAPI_KEY is not valid' : r.status === 429 || /run out of searches/i.test(e) ? 'Monthly SerpApi searches used up' : e.slice(0, 160) };
  }
  return { json: j, found: (j.best_flights || []).length + (j.other_flights || []).length };
}
// One day, one direction. Google sometimes returns nothing for a group of airports (seen for ATH → FCO,CIA) while
// each airport on its own has flights, so an empty answer for a group is asked again airport by airport.
export async function search(leg, ctx){
  const first = await searchOnce(leg, ctx);
  if (first.error) return { error: first.error };
  let parts = [first.json], found = first.found, split = 0;
  if (!normalize(first.json).length){
    const each = (k) => leg[k].split(',').slice(0, 3).map(c => ({ ...leg, [k]: c }));
    const alts = leg.to.includes(',') ? each('to') : leg.from.includes(',') ? each('from') : [];
    if (alts.length){
      const rs = await Promise.all(alts.map(l => searchOnce(l, ctx)));
      const ok = rs.filter(x => !x.error);
      if (!ok.length && rs.length) return { error: rs[0].error };
      parts = ok.map(x => x.json); found = ok.reduce((n, x) => n + x.found, 0); split = alts.length;
    }
  }
  const pi = parts.find(j => j.price_insights)?.price_insights || null;
  const merged = { best_flights: parts.flatMap(j => j.best_flights || []), other_flights: parts.flatMap(j => j.other_flights || []) };
  const options = normalize(merged);
  return { options, found, split, note: options.length ? null : (found ? `Google listed ${found} but none had a price and times` : 'Google Flights returned no flights') + (split ? ` (also asked each airport: ${split} more searches)` : ''),
    insight: pi ? { level: pi.price_level || null, low: pi.lowest_price || null, typical: pi.typical_price_range || null } : null };
}

// Google Travel Explore interests (SerpApi values); '' = popular.
export const INTERESTS = { '': null, outdoors: '/g/11bc58l13w', beaches: '/m/0b3yr', museums: '/m/09cmq', history: '/m/03g3w' };
const EUROPE = '/m/02j9z';
export function normalizePlaces(j){
  return (j.destinations || []).map(d => ({
    id: d.destination_id || (d.name + '|' + d.country), name: d.name || null, country: d.country || null,
    airport: d.destination_airport?.code || null, price: +d.flight_price > 0 ? Math.round(+d.flight_price) : null,
    hotel: +d.hotel_price > 0 ? Math.round(+d.hotel_price) : null, minutes: +d.flight_duration || null,
    stops: Number.isFinite(+d.number_of_stops) ? +d.number_of_stops : null, airline: d.airline || null,
    start: d.start_date || null, end: d.end_date || null,
  })).filter(d => d.name && d.airport && d.price);
}
async function exploreOnce(x, { key, adults, fetch: f }){
  const q = new URLSearchParams({ engine: 'google_travel_explore', departure_id: x.from, arrival_area_id: EUROPE, type: '1',
    outbound_date: x.start, return_date: x.end, travel_mode: '1', currency: 'EUR', hl: 'en', gl: 'de', adults: String(adults), api_key: key });
  if (INTERESTS[x.interest]){ q.delete('travel_mode'); q.set('interest', INTERESTS[x.interest]); }
  const r = await f('https://serpapi.com/search.json?' + q);
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || j.error){
    const e = String(j.error || 'SerpApi ' + r.status);
    if (/hasn't returned any results|no results/i.test(e)) return { places: [] };
    return { error: r.status === 401 || /invalid api key/i.test(e) ? 'SERPAPI_KEY is not valid' : r.status === 429 || /run out of searches/i.test(e) ? 'Monthly SerpApi searches used up' : e.slice(0, 160) };
  }
  return { places: normalizePlaces(j) };
}
// Places from a group of airports. Google sometimes answers a group with almost nothing (seen for MUC,NUE,FMM: one
// place, while Rome's two airports gave dozens), so a thin answer is asked again airport by airport and merged,
// keeping the cheapest price per place.
const THIN = 5;
export async function explore(x, ctx){
  const first = await exploreOnce(x, ctx);
  if (first.error || first.places.length >= THIN || !x.from.includes(',')) return first;
  const rs = await Promise.all(x.from.split(',').slice(0, 3).map(c => exploreOnce({ ...x, from: c }, ctx)));
  const best = new Map();
  for (const p of [first, ...rs].flatMap(r => r.places || [])){
    const k = (p.name + '|' + (p.country || '')).toLowerCase();
    if (!best.has(k) || best.get(k).price > p.price) best.set(k, p);
  }
  return { places: [...best.values()].sort((a, b) => a.price - b.price), split: rs.length };
}

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch, cache, now = Date.now() } = {}){
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.SERPAPI_KEY) return json(503, { error: 'Flight prices need SERPAPI_KEY in Netlify (free key from serpapi.com).' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const adults = Math.min(4, Math.max(1, Math.round(+body.adults || 1)));
  const left = async () => { try { const a = await (await f('https://serpapi.com/account.json?api_key=' + encodeURIComponent(env.SERPAPI_KEY))).json(); return a.total_searches_left ?? a.plan_searches_left ?? null; } catch { return null; } };
  const cached = async (id, run) => {
    // An empty answer is never reused: Google sometimes returns nothing and asking again (or airport by airport) finds flights.
    const empty = d => !(d?.options?.length || d?.places?.length);
    const hit = cache && await cache.get(id).catch(() => null);
    if (hit && now - hit.at < TTL && !empty(hit.data)) return { ...hit.data, cachedAt: new Date(hit.at).toISOString() };
    const r = await run();
    if (!r.error && !empty(r) && cache) await cache.set(id, { at: now, data: r }).catch(() => {});
    return r;
  };
  if (Array.isArray(body.explore)){
    const xs = body.explore.filter(x => x && isAirports(x.from) && isDate(x.start) && isDate(x.end) && x.end > x.start && (!x.interest || x.interest in INTERESTS)).slice(0, 2);
    if (!xs.length) return json(400, { error: 'Nothing to search.' });
    const res = await Promise.all(xs.map(async x => ({ ...x, ...await cached(['x2', x.from, x.start, x.end, x.interest || 'any', adults].join('_').replace(/,/g, '-'),
      () => explore(x, { key: env.SERPAPI_KEY, adults, fetch: f })) })));
    return json(200, { explore: res, left: await left() });
  }
  // Answers stay in the order asked (the app matches them by position), so a bad leg gets an error, not dropped.
  if (Array.isArray(body.legs) && body.legs.length > MAX_LEGS) return json(400, { error: `Too many days to search at once (${body.legs.length}, at most ${MAX_LEGS}).` });
  const legs = Array.isArray(body.legs) ? body.legs : [];
  if (!legs.some(l => l && isAirports(l.from) && isAirports(l.to) && isDate(l.date))) return json(400, { error: 'Nothing to search.' });
  const res = await Promise.all(legs.map(async l => !(l && isAirports(l.from) && isAirports(l.to) && isDate(l.date)) ? { ...l, error: 'Not a valid airport or date: ' + JSON.stringify(l).slice(0, 80) } : ({ ...l, ...await cached([l.from, l.to, l.date, adults].join('_').replace(/,/g, '-'), () => search(l, { key: env.SERPAPI_KEY, adults, fetch: f })) })));
  return json(200, { legs: res, left: await left(), v: VERSION });
}

export default async (req) => {
  const db = firestore();
  const cache = { get: async id => { const d = await db.collection('flightSearch').doc(id).get(); return d.exists ? d.data() : null; }, set: (id, v) => db.collection('flightSearch').doc(id).set(v) };
  try {
    const res = await handle(req, { cache });
    const body = await res.clone().json().catch(() => ({}));
    if (res.status === 200){
      const list = body.legs || body.explore || [], errs = list.filter(l => l.error).map(l => l.error);
      await beat(db, 'plan', errs.length ? { ok: false, error: errs[0] } : { info: `${list.length} ${body.explore ? 'place' : 'flight'} searches${body.left != null ? ', ' + body.left + ' left this month' : ''}` });
    } else if (res.status === 503) await beat(db, 'plan', { ok: false, error: body.error });
    return res;
  } catch (e) { console.error('trip-plan failed', e); return json(500, { error: 'Something went wrong searching flights. Try again.' }); }
};

export const config = { path: '/api/trip-plan' };
