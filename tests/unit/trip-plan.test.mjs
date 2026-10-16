import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, normalize, search, VERSION } from '../../netlify/functions/trip-plan.mjs';
import { verify, req, fakeSerpApi, memoryCache, seg } from '../support/fakes.mjs';

const env = { SERPAPI_KEY: 'test' };
// The planner's biggest request: both of you, the evening before + 2 days out, 2 days back = 10 day searches.
const tenLegs = () => {
  const legs = [];
  for (const [home, away] of [['MUC,NUE,FMM', 'ATH'], ['FCO,CIA', 'ATH']]){
    for (const d of ['2027-03-24', '2027-03-25', '2027-03-26']) legs.push({ from: home, to: away, date: d });
    for (const d of ['2027-03-29', '2027-03-30']) legs.push({ from: away, to: home, date: d });
  }
  return legs;
};

test('normalize: cheapest first, times as local ISO, stops and flight numbers', () => {
  const out = normalize({ best_flights: [{ flights: [seg('MUC', 'FCO', '2027-03-25', 7, 10, 95)], total_duration: 95, price: 129 }],
    other_flights: [{ flights: [seg('NUE', 'FRA', '2027-03-25', 6, 0, 60), seg('FRA', 'FCO', '2027-03-25', 9, 0, 120)], layovers: [{ id: 'FRA' }], total_duration: 300, price: 99 }, { flights: [], price: 10 }, { flights: [seg('A', 'B', '2027-03-25', 8, 0, 60)] }] });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(o => o.price), [99, 129]);
  assert.equal(out[0].dep, '2027-03-25T06:00');
  assert.equal(out[0].stops, 1);
  assert.deepEqual(out[0].via, ['FRA']);
  assert.equal(out[1].arr, '2027-03-25T08:45');
});

test('contract: every day asked is answered, in the same order (10 legs)', async () => {
  const calls = [];
  const r = await handle(req({ legs: tenLegs() }), { env, verify, fetch: fakeSerpApi({ calls, emptyGroups: null }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.v, VERSION);
  assert.equal(j.legs.length, 10);
  tenLegs().forEach((l, i) => { assert.equal(j.legs[i].date, l.date); assert.equal(j.legs[i].to, l.to); assert.ok(j.legs[i].options.length > 0, 'leg ' + i + ' has flights'); });
});

test('too many days is refused instead of silently cut', async () => {
  const r = await handle(req({ legs: [...tenLegs(), ...tenLegs()] }), { env, verify, fetch: fakeSerpApi() });
  assert.equal(r.status, 400);
});

test('a bad leg gets an error in its place; the others stay aligned', async () => {
  const legs = tenLegs(); legs.splice(2, 0, { from: 'bad', to: 'ATH', date: 'x' });
  const j = await (await handle(req({ legs: legs.slice(0, 11) }), { env, verify, fetch: fakeSerpApi({ emptyGroups: null }) })).json();
  assert.ok(j.legs[2].error);
  assert.equal(j.legs[3].date, legs[3].date);
});

test('an empty answer for a group of airports is asked again airport by airport', async () => {
  const calls = [];
  const r = await search({ from: 'ATH', to: 'FCO,CIA', date: '2027-03-29' }, { key: 'k', adults: 1, fetch: fakeSerpApi({ calls, emptyGroups: /^FCO,CIA$/ }) });
  assert.deepEqual(calls.map(c => c.arrival_id), ['FCO,CIA', 'FCO', 'CIA']);
  assert.equal(r.split, 2);
  assert.ok(r.options.length > 0);
  assert.equal(r.note, null);
});

test('no flights at all says so, and the empty answer is not cached', async () => {
  const cache = memoryCache(), calls = [];
  const f = fakeSerpApi({ calls, emptyGroups: /./ });
  const body = { legs: [{ from: 'ATH', to: 'FCO,CIA', date: '2027-03-29' }] };
  const j = await (await handle(req(body), { env, verify, fetch: f, cache })).json();
  assert.match(j.legs[0].note, /no flights/);
  assert.equal(cache.m.size, 0);
  await handle(req(body), { env, verify, fetch: f, cache });
  assert.equal(calls.length, 6, 'asked again the second time');
});

test('results are cached for 6 hours', async () => {
  const cache = memoryCache(), calls = [], now = Date.parse('2026-10-16T10:00:00Z');
  const f = fakeSerpApi({ calls, emptyGroups: null }), body = { legs: [{ from: 'MUC', to: 'FCO', date: '2027-03-25' }] };
  await handle(req(body), { env, verify, fetch: f, cache, now });
  const again = await (await handle(req(body), { env, verify, fetch: f, cache, now: now + 3600e3 })).json();
  assert.equal(calls.length, 1);
  assert.ok(again.legs[0].cachedAt);
  await handle(req(body), { env, verify, fetch: f, cache, now: now + 7 * 3600e3 });
  assert.equal(calls.length, 2);
});

test('explore: places for both sides, interest passed through', async () => {
  const calls = [];
  const j = await (await handle(req({ explore: [{ from: 'MUC,NUE,FMM', start: '2027-03-25', end: '2027-03-30', interest: 'history' }, { from: 'FCO,CIA', start: '2027-03-25', end: '2027-03-30' }] }), { env, verify, fetch: fakeSerpApi({ calls }) })).json();
  assert.equal(j.explore.length, 2);
  assert.ok(j.explore[0].places.some(p => p.airport === 'ATH' && p.price === 200 && p.hotel === 70));
  assert.equal(calls[0].interest, '/m/03g3w');
  assert.equal(calls[1].travel_mode, '1');
});

test('setup errors: no key, wrong method, not signed in', async () => {
  assert.equal((await handle(req({ legs: tenLegs() }), { env: {}, verify })).status, 503);
  assert.equal((await handle(new Request('http://t', { method: 'GET' }), { env, verify })).status, 405);
  const r = await handle(new Request('http://t', { method: 'POST', body: '{}' }), { env, verify: async () => { throw new Error('no'); } });
  assert.ok(r.status === 401 || r.status === 403);
});

test('explore: a thin answer for a group of airports is asked again airport by airport and merged', async () => {
  const calls = [], base = fakeSerpApi({ calls });
  const f = async url => { const u = new URL(url); if (u.searchParams.get('departure_id') === 'MUC,NUE,FMM'){ calls.push(Object.fromEntries(u.searchParams)); return { ok: true, status: 200, json: async () => ({ destinations: [{ destination_id: '/m/lis', name: 'Lisbon', country: 'Portugal', destination_airport: { code: 'LIS' }, flight_price: 288 }] }) }; } return base(url); };
  const j = await (await handle(req({ explore: [{ from: 'MUC,NUE,FMM', start: '2027-05-06', end: '2027-05-09' }] }), { env, verify, fetch: f })).json();
  assert.deepEqual(calls.map(c => c.departure_id), ['MUC,NUE,FMM', 'MUC', 'NUE', 'FMM']);
  assert.equal(j.explore[0].split, 3);
  assert.ok(j.explore[0].places.length >= 4);
  assert.ok(j.explore[0].places.some(p => p.name === 'Lisbon'));
});
