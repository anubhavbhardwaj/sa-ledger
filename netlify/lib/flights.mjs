// Flight alerts core, used by the scheduled check (functions/flights.mjs) and "Check now" (functions/flight-check.mjs).
// For each flight booking it asks a flight-status service for the live status, keeps it in
// flightStatus/<bookingId> (the app shows it), and sends phone notifications:
//   delays (15+ min) and cancellations  → both of you
//   gate                                → whoever is flying
//   take-off and landing                → whoever is NOT on that flight
// Services: AeroDataBox through RapidAPI (free plan: 400 units a month, 2 per lookup) when AERODATABOX_KEY is
// set, else FlightAware AeroAPI (AEROAPI_KEY). With AeroDataBox it checks sparingly, about 10 lookups a flight.

import { sendTo, PEOPLE } from './push.mjs';

const API = 'https://aeroapi.flightaware.com/aeroapi';
const MIN = 60e3, HOUR = 60 * MIN;
const ALL = ['Anubhav', 'Sulekha'];

export function travellersOf(b, trip) {
  const n = (b.travellers || []).join(' ').toLowerCase(), s = new Set();
  if (/anubhav|bhardwaj/.test(n)) s.add('Anubhav');
  if (/sulekha/.test(n)) s.add('Sulekha');
  if (!s.size && trip?.traveller) (trip.traveller === 'Both' ? ALL : [trip.traveller]).forEach(p => s.add(p));
  return s;
}
export function identOf(b) {
  const n = String(b.number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^([A-Z]{2,3}|[A-Z]\d|\d[A-Z])\d{1,4}[A-Z]?$/.test(n)) return n;
  const m = String(b.title || '').toUpperCase().match(/\b([A-Z]{2,3}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/);
  return m ? m[1] + m[2] : null;
}
const iataOf = s => (String(s || '').match(/\(([A-Z]{3})\)/) || [])[1];
// Booking times are local; read as UTC they're off by a few hours at most, enough to pick a window.
const approx = s => Date.parse(s.length > 10 ? s + ':00Z' : s + 'T12:00:00Z');

export function due(b, st, now, light = false) {
  if (st?.done || !b.start) return false;
  const dep = st?.sched ? Date.parse(st.sched) : approx(b.start);
  const arr = st?.arrEst ? Date.parse(st.arrEst) : dep + 4 * HOUR;
  const since = now - (st?.checkedAt ? Date.parse(st.checkedAt) : 0);
  if (!light) {
    if (now < dep - 8 * HOUR || now > arr + 4 * HOUR) return false;
    return since >= (now < dep - 3 * HOUR ? 55 * MIN : 9 * MIN);
  }
  // Sparing plan: from 3 h before, every ~90 min, every 25 min from 75 min before until take-off,
  // then nothing until just before the expected landing, then every 15 min until it has landed.
  // Before the first lookup the time is local read as UTC (up to ~5 h late for India), so start earlier.
  if (now < dep - (st?.sched ? 3 : 5) * HOUR || now > arr + 3 * HOUR) return false;
  if (!st?.departed) return since >= (now < dep - 75 * MIN ? 85 * MIN : 24 * MIN);
  return now >= arr - 10 * MIN && since >= 14 * MIN;
}

export function summarizeAeroApi(f) {
  const t = k => f[k] || null;
  const sched = t('scheduled_out') || t('scheduled_off');
  const depEst = t('actual_out') || t('estimated_out') || t('actual_off') || t('estimated_off') || sched;   // leaving the gate
  const arrEst = t('actual_on') || t('estimated_on') || t('actual_in') || t('estimated_in') || t('scheduled_on') || t('scheduled_in');
  const delay = Math.round((f.departure_delay != null ? f.departure_delay : (Date.parse(t('estimated_out') || sched) - Date.parse(sched)) / 1000 || 0) / 60);
  return {
    ident: f.ident_iata || f.ident || '', status: f.status || '', sched, depEst, arrEst, delay,
    departed: !!f.actual_off, offAt: t('actual_off'), landed: !!f.actual_on, landedAt: t('actual_on'),
    cancelled: !!f.cancelled, diverted: !!f.diverted,
    gate: f.gate_origin || null, terminal: f.terminal_origin || null, arrGate: f.gate_destination || null, arrTerminal: f.terminal_destination || null,
    from: f.origin?.code_iata || null, to: f.destination?.code_iata || null, fromCity: f.origin?.city || null, toCity: f.destination?.city || null,
    fromTz: f.origin?.timezone || 'UTC', toTz: f.destination?.timezone || 'UTC',
  };
}

// AeroDataBox times look like { utc: '2026-10-08 13:55Z', local: '2026-10-08 15:55+02:00' } (older: scheduledTimeUtc).
const adbTime = (o, k) => { const v = o?.[k]?.utc ?? o?.[k + 'Utc']; if (!v) return null; const d = new Date(String(v).trim().replace(' ', 'T')); return isNaN(d) ? null : d.toISOString(); };
export function summarizeAdb(f) {
  const d = f.departure || {}, a = f.arrival || {}, st = String(f.status || '');
  const sched = adbTime(d, 'scheduledTime'), depRev = adbTime(d, 'revisedTime') || adbTime(d, 'actualTime'), depRun = adbTime(d, 'runwayTime');
  const aSched = adbTime(a, 'scheduledTime'), aRev = adbTime(a, 'revisedTime') || adbTime(a, 'actualTime'), aPred = adbTime(a, 'predictedTime'), aRun = adbTime(a, 'runwayTime');
  const landed = !!aRun || /arrived|landed/i.test(st);
  const departed = landed || !!depRun || /departed|en ?route|approaching/i.test(st);
  const depEst = depRev || sched;
  return {
    ident: String(f.number || '').replace(/\s+/g, ''), status: st, sched, depEst, arrEst: aRun || aRev || aPred || aSched,
    delay: sched && depEst ? Math.round((Date.parse(depEst) - Date.parse(sched)) / MIN) : 0,
    departed, offAt: depRun || (departed ? depEst : null), landed, landedAt: aRun || (landed ? aRev || aSched : null),
    cancelled: /cancel/i.test(st), diverted: /divert/i.test(st),
    gate: d.gate || null, terminal: d.terminal || null, arrGate: a.gate || null, arrTerminal: a.terminal || null,
    from: d.airport?.iata || null, to: a.airport?.iata || null, fromCity: d.airport?.municipalityName || d.airport?.shortName || d.airport?.name || null,
    toCity: a.airport?.municipalityName || a.airport?.shortName || a.airport?.name || null, fromTz: d.airport?.timeZone || 'UTC', toTz: a.airport?.timeZone || 'UTC',
  };
}

// The last quota RapidAPI reported (shown in System health).
export const ctx_quota = { value: null };
// Ask the configured service. Returns { s } or { error, status }.
export async function lookup(b, st, env, f) {
  const ident = identOf(b);
  if (!ident) return { error: 'No flight number on the booking', fatal: true };
  const want = st?.sched ? Date.parse(st.sched) : approx(b.start), o = iataOf(b.from);
  const closest = (list, depOf) => list.sort((x, y) => Math.abs(depOf(x) - want) - Math.abs(depOf(y) - want))[0];
  if (env.AERODATABOX_KEY) {
    const r = await f(`https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(ident)}/${b.start.slice(0, 10)}?withAircraftImage=false&withLocation=false`, {
      headers: { 'x-rapidapi-key': env.AERODATABOX_KEY, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com', accept: 'application/json' } });
    const left = r.headers?.get?.('x-ratelimit-requests-remaining') ?? r.headers?.get?.('x-ratelimit-units-remaining');
    if (left != null) ctx_quota.value = `${left} lookups left this month`;
    if (r.status === 204) return { error: 'Flight not found', status: 404 };
    if (!r.ok) return { error: 'AeroDataBox ' + r.status + (r.status === 429 ? ' (monthly allowance used up?)' : ''), status: r.status };
    const j = await r.json(), list = (Array.isArray(j) ? j : j.items || j.flights || []).filter(x => !o || !x.departure?.airport?.iata || x.departure.airport.iata === o);
    const pick = closest(list, x => Date.parse(adbTime(x.departure, 'scheduledTime') || 0));
    return pick ? { s: summarizeAdb(pick) } : { error: 'Flight not found', status: 404 };
  }
  if (env.AEROAPI_KEY) {
    const q = new URLSearchParams({ ident_type: 'designator', start: new Date(want - 14 * HOUR).toISOString().slice(0, 19) + 'Z', end: new Date(want + 14 * HOUR).toISOString().slice(0, 19) + 'Z' });
    const r = await f(`${API}/flights/${encodeURIComponent(ident)}?${q}`, { headers: { 'x-apikey': env.AEROAPI_KEY, accept: 'application/json' } });
    if (!r.ok) return { error: 'FlightAware ' + r.status, status: r.status };
    const list = ((await r.json()).flights || []).filter(x => !o || !x.origin?.code_iata || x.origin.code_iata === o);
    const pick = closest(list, x => Date.parse(x.scheduled_out || x.scheduled_off));
    return pick ? { s: summarizeAeroApi(pick) } : { error: 'Flight not found', status: 404 };
  }
  return { error: 'No flight-status key set (AERODATABOX_KEY)', fatal: true, status: 0 };
}

export function events(prev, s, now) {
  const n = prev?.notified || {}, ev = [];
  const recent = iso => iso && now - Date.parse(iso) < 90 * MIN;   // don't announce a take-off from hours ago
  if (s.cancelled) { if (!n.cancelled) ev.push({ k: 'cancelled', to: 'all' }); return ev; }
  const last = n.delay || 0;
  if (!s.departed && Math.abs(s.delay - last) >= 15 && (s.delay >= 15 || last >= 15)) ev.push({ k: 'delay', to: 'all' });
  if (s.gate && s.gate !== n.gate && !s.departed) ev.push({ k: 'gate', to: 'travellers' });
  if (s.departed && !n.departed && recent(s.offAt)) ev.push({ k: 'departed', to: 'partner' });
  if (s.landed && !n.landed && recent(s.landedAt)) ev.push({ k: 'landed', to: 'partner' });
  if (s.diverted && !n.diverted) ev.push({ k: 'diverted', to: 'all' });
  return ev;
}

const hm = (iso, tz) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '?';
const names = who => [...who].join(' & ');
export function message(ev, s, b, who, person) {
  const fl = s.ident || identOf(b) || 'Flight', a = s.fromCity || s.from || b.from, z = s.toCity || s.to || b.to;
  const whose = who.has(person) ? 'Your flight' : who.size ? names(who) + '’s flight' : 'The flight';
  const tag = 'flight-' + b.id + '-' + ev.k;
  switch (ev.k) {
    case 'delay': return s.delay >= 15
      ? { tag, title: `${fl} delayed ${s.delay} min`, body: `${whose} ${a} → ${z} now leaves ${hm(s.depEst, s.fromTz)} (planned ${hm(s.sched, s.fromTz)}) and lands about ${hm(s.arrEst, s.toTz)}.` }
      : { tag, title: `${fl} back on time`, body: `${whose} ${a} → ${z} leaves ${hm(s.depEst, s.fromTz)}, lands about ${hm(s.arrEst, s.toTz)}.` };
    case 'gate': return { tag, title: `${fl}: gate ${s.gate}`, body: `${s.terminal ? 'Terminal ' + s.terminal + ', g' : 'G'}ate ${s.gate}. Leaves ${hm(s.depEst, s.fromTz)}.` };
    case 'departed': return { tag, title: `${who.size ? names(who) + (who.size > 1 ? ' are' : ' is') : fl + ' is'} in the air`, body: `${fl} took off from ${a} at ${hm(s.offAt, s.fromTz)}. Lands in ${z} about ${hm(s.arrEst, s.toTz)}.` };
    case 'landed': return { tag, title: `${who.size ? names(who) + (who.size > 1 ? ' have' : ' has') : fl + ' has'} landed`, body: `${fl} landed in ${z} at ${hm(s.landedAt, s.toTz)}${s.arrGate ? ', gate ' + s.arrGate : ''}.` };
    case 'cancelled': return { tag, title: `${fl} is cancelled`, body: `${whose} ${a} → ${z} on ${b.start.slice(0, 10)} was cancelled. Check the airline app for a rebooking.` };
    case 'diverted': return { tag, title: `${fl} diverted`, body: `${whose} ${a} → ${z} was diverted. Check the airline for the new arrival.` };
  }
}
const audience = (to, who) => to === 'all' ? ALL : to === 'travellers' ? (who.size ? [...who] : ALL) : ALL.filter(p => !who.has(p));

// Look one flight up, notify, save. ctx: { now, env, fetch, trips, saveStatus, tokens(), dropTokens, send }
export async function checkFlight(b, st = {}, ctx) {
  const { now, env } = ctx, checkedAt = new Date(now).toISOString();
  const res = await lookup(b, st, env, ctx.fetch);
  if (!res.s) {
    const misses = (st.misses || 0) + 1;
    const saved = { ...st, error: res.error, misses, done: !!res.fatal || (res.status === 404 && misses >= 3), checkedAt };
    await ctx.saveStatus(b.id, saved);
    return { ...saved, sent: 0, stop: res.status === 401 || res.status === 403 };
  }
  const s = res.s, ev = events(st, s, now), who = travellersOf(b, ctx.trips[b.tripId]);
  const notified = { ...(st.notified || {}) };
  let sent = 0;
  for (const e of ev) {
    const tokens = await ctx.tokens();
    for (const person of audience(e.to, who)) {
      const mine = tokens.filter(t => PEOPLE[t.email] === person);
      if (!mine.length) continue;
      const dead = await sendTo(mine, { ...message(e, s, b, who, person), url: '/#overview' }, ctx.send);
      sent += mine.length - dead.length;
      if (dead.length) await ctx.dropTokens(dead);
    }
    if (e.k === 'delay') notified.delay = s.delay;
    if (e.k === 'gate') notified.gate = s.gate;
    if (['departed', 'landed', 'cancelled', 'diverted'].includes(e.k)) notified[e.k] = true;
  }
  // Quietly record facts that weren't announced (an old take-off) so they aren't announced later either.
  if (s.departed) notified.departed = true;
  if (s.landed) notified.landed = true;
  const dep = Date.parse(s.sched || '') || approx(b.start);
  const done = s.cancelled || (s.landed && now - Date.parse(s.landedAt || checkedAt) > 30 * MIN) || now > Date.parse(s.arrEst || '') + 4 * HOUR || now > dep + 30 * HOUR;
  const saved = { ...s, bookingId: b.id, notified, done, checkedAt, misses: 0, error: null };
  await ctx.saveStatus(b.id, saved);
  return { ...saved, sent };
}

export async function run({ now = Date.now(), env = process.env, fetch: f = fetch, loadFlights, loadTrips, loadStatus, saveStatus, loadTokens, dropTokens, send }) {
  if (!env.AERODATABOX_KEY && !env.AEROAPI_KEY) return { skipped: 'No flight-status key set' };
  const light = !!env.AERODATABOX_KEY;
  const day = d => new Date(d).toISOString().slice(0, 10);
  const flights = (await loadFlights(day(now - 2 * 24 * HOUR), day(now + 2 * 24 * HOUR))).filter(b => b.type === 'flight' && b.start);
  if (!flights.length) return { checked: 0 };
  const status = await loadStatus(flights.map(b => b.id));
  const todo = flights.filter(b => due(b, status[b.id], now, light));
  if (!todo.length) return { checked: 0 };
  const trips = await loadTrips();
  let tokens = null;
  const ctx = { now, env, fetch: f, trips, saveStatus, send, tokens: async () => (tokens ||= await loadTokens()),
    dropTokens: async ids => { await dropTokens(ids); tokens = (tokens || []).filter(t => !ids.includes(t.id)); } };
  const out = { checked: 0, sent: 0, errors: [] };
  for (const b of todo) {
    const r = await checkFlight(b, status[b.id], ctx);
    out.checked++; out.sent += r.sent || 0;
    if (r.error) out.errors.push((identOf(b) || b.id) + ': ' + r.error);
    if (r.stop) break;
  }
  if (ctx_quota.value) out.quota = ctx_quota.value;
  return out;
}

// Firestore access for both functions.
export function store(db) {
  return {
    loadFlights: async (from, to) => (await db.collection('bookings').where('start', '>=', from).where('start', '<=', to + 'T99').get()).docs.map(d => ({ id: d.id, ...d.data() })),
    loadTrips: async () => Object.fromEntries((await db.collection('trips').get()).docs.map(d => [d.id, d.data()])),
    loadStatus: async ids => Object.fromEntries((await Promise.all(ids.map(id => db.collection('flightStatus').doc(id).get()))).filter(d => d.exists).map(d => [d.id, d.data()])),
    saveStatus: (id, s) => db.collection('flightStatus').doc(id).set(s),
    loadTokens: async () => (await db.collection('pushTokens').get()).docs.map(d => ({ id: d.id, ...d.data() })),
    dropTokens: ids => Promise.all(ids.map(id => db.collection('pushTokens').doc(id).delete())),
  };
}
