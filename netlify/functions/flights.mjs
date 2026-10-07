// Flight alerts. Every 10 minutes: for each flight booking in the next hours, ask FlightAware for its live
// status, keep it in flightStatus/<bookingId> (the app shows it), and send phone notifications:
//   delays (15+ min) and cancellations  → both of you
//   gate                                → whoever is flying
//   take-off and landing                → whoever is NOT on that flight
// Checks start 8 hours before departure: hourly at first, every 10 minutes from 3 hours before until landing.
//
// Environment: AEROAPI_KEY (FlightAware AeroAPI, Personal tier), FIREBASE_SERVICE_ACCOUNT (already set).

import { firestore } from '../lib/members.mjs';
import { sendTo, PEOPLE } from '../lib/push.mjs';

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

export function due(b, st, now) {
  if (st?.done || !b.start) return false;
  const dep = st?.sched ? Date.parse(st.sched) : approx(b.start);
  const arr = st?.arrEst ? Date.parse(st.arrEst) : dep + 4 * HOUR;
  if (now < dep - 8 * HOUR || now > arr + 4 * HOUR) return false;
  const last = st?.checkedAt ? Date.parse(st.checkedAt) : 0;
  return now - last >= (now < dep - 3 * HOUR ? 55 * MIN : 9 * MIN);
}

export function summarize(f) {
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

export async function run({ now = Date.now(), env = process.env, fetch: f = fetch, loadFlights, loadTrips, loadStatus, saveStatus, loadTokens, dropTokens, send }) {
  if (!env.AEROAPI_KEY) return { skipped: 'AEROAPI_KEY is not set' };
  const day = d => new Date(d).toISOString().slice(0, 10);
  const flights = (await loadFlights(day(now - 2 * 24 * HOUR), day(now + 2 * 24 * HOUR))).filter(b => b.type === 'flight' && b.start);
  if (!flights.length) return { checked: 0 };
  const status = await loadStatus(flights.map(b => b.id));
  const todo = flights.filter(b => due(b, status[b.id], now));
  if (!todo.length) return { checked: 0 };
  const trips = await loadTrips();
  let tokens = null;
  const out = { checked: 0, sent: 0, errors: [] };
  for (const b of todo) {
    const st = status[b.id] || {}, checkedAt = new Date(now).toISOString();
    const ident = identOf(b);
    if (!ident) { await saveStatus(b.id, { ...st, done: true, error: 'No flight number on the booking', checkedAt }); continue; }
    const dep = st.sched ? Date.parse(st.sched) : approx(b.start);
    const q = new URLSearchParams({ ident_type: 'designator', start: new Date(dep - 14 * HOUR).toISOString().slice(0, 19) + 'Z', end: new Date(dep + 14 * HOUR).toISOString().slice(0, 19) + 'Z' });
    const r = await f(`${API}/flights/${encodeURIComponent(ident)}?${q}`, { headers: { 'x-apikey': env.AEROAPI_KEY, accept: 'application/json' } });
    out.checked++;
    if (!r.ok) {
      const misses = (st.misses || 0) + 1, msg = 'FlightAware ' + r.status;
      out.errors.push(ident + ': ' + msg);
      await saveStatus(b.id, { ...st, error: msg, misses, done: r.status === 404 && misses >= 3, checkedAt });
      if (r.status === 401 || r.status === 403) break;   // bad key: stop for this run
      continue;
    }
    const j = await r.json();
    const want = approx(b.start), o = iataOf(b.from);
    const pick = (j.flights || []).filter(x => !o || !x.origin?.code_iata || x.origin.code_iata === o)
      .sort((x, y) => Math.abs(Date.parse(x.scheduled_out || x.scheduled_off) - want) - Math.abs(Date.parse(y.scheduled_out || y.scheduled_off) - want))[0];
    if (!pick) { const misses = (st.misses || 0) + 1; await saveStatus(b.id, { ...st, error: 'Flight not found', misses, done: misses >= 4, checkedAt }); continue; }
    const s = summarize(pick), ev = events(st, s, now);
    const who = travellersOf(b, trips[b.tripId]);
    const notified = { ...(st.notified || {}) };
    for (const e of ev) {
      tokens ||= await loadTokens();
      for (const person of audience(e.to, who)) {
        const mine = tokens.filter(t => PEOPLE[t.email] === person);
        if (!mine.length) continue;
        const dead = await sendTo(mine, { ...message(e, s, b, who, person), url: '/#overview' }, send);
        out.sent += mine.length - dead.length;
        if (dead.length) { await dropTokens(dead); tokens = tokens.filter(t => !dead.includes(t.id)); }
      }
      if (e.k === 'delay') notified.delay = s.delay;
      if (e.k === 'gate') notified.gate = s.gate;
      if (['departed', 'landed', 'cancelled', 'diverted'].includes(e.k)) notified[e.k] = true;
    }
    // Quietly record facts that weren't announced (an old take-off) so they aren't announced later either.
    if (s.departed) notified.departed = true;
    if (s.landed) notified.landed = true;
    const done = s.cancelled || (s.landed && now - Date.parse(s.landedAt) > 30 * MIN) || now > Date.parse(s.arrEst || dep) + 4 * HOUR;
    await saveStatus(b.id, { ...s, bookingId: b.id, notified, done, checkedAt, misses: 0, error: null });
  }
  return out;
}

export default async () => {
  const db = firestore();
  try {
    const res = await run({
      loadFlights: async (from, to) => (await db.collection('bookings').where('start', '>=', from).where('start', '<=', to + 'T99').get()).docs.map(d => ({ id: d.id, ...d.data() })),
      loadTrips: async () => Object.fromEntries((await db.collection('trips').get()).docs.map(d => [d.id, d.data()])),
      loadStatus: async ids => Object.fromEntries((await Promise.all(ids.map(id => db.collection('flightStatus').doc(id).get()))).filter(d => d.exists).map(d => [d.id, d.data()])),
      saveStatus: (id, s) => db.collection('flightStatus').doc(id).set(s),
      loadTokens: async () => (await db.collection('pushTokens').get()).docs.map(d => ({ id: d.id, ...d.data() })),
      dropTokens: ids => Promise.all(ids.map(id => db.collection('pushTokens').doc(id).delete())),
    });
    console.log('flights', JSON.stringify(res));
    return new Response(JSON.stringify(res), { status: 200 });
  } catch (e) {
    console.error('flights failed', e);
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

export const config = { schedule: '*/10 * * * *' };
