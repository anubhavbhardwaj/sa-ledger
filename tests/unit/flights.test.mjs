import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAdb, events, identOf, travellersOf, due } from '../../netlify/lib/flights.mjs';

const T = (utc) => ({ utc });
const base = () => ({ number: 'LH 1869', status: 'Expected',
  departure: { airport: { iata: 'FCO', timeZone: 'Europe/Rome' }, scheduledTime: T('2026-10-08 13:55Z') },
  arrival: { airport: { iata: 'MUC', timeZone: 'Europe/Berlin' }, scheduledTime: T('2026-10-08 15:30Z') } });

test('delay from the revised departure', () => {
  const f = base(); f.departure.revisedTime = T('2026-10-08 14:10Z');
  const s = summarizeAdb(f); assert.equal(s.delay, 15); assert.equal(s.delaySource, 'departure');
});
test('delay from the predicted departure when there is no revised one', () => {
  const f = base(); f.departure.predictedTime = T('2026-10-08 14:10Z');
  assert.equal(summarizeAdb(f).delaySource, 'predicted');
});
test('delay from the revised arrival when the departure has no new time', () => {
  const f = base(); f.arrival.revisedTime = T('2026-10-08 15:45Z');
  const s = summarizeAdb(f); assert.equal(s.delay, 15); assert.equal(s.delaySource, 'arrival');
});
test('"Delayed" without a time is flagged, "CanceledUncertain" is not cancelled', () => {
  const f = base(); f.status = 'Delayed'; assert.equal(summarizeAdb(f).delayedNoTime, true);
  const g = base(); g.status = 'CanceledUncertain'; assert.equal(summarizeAdb(g).cancelled, false);
  const h = base(); h.status = 'Canceled'; assert.equal(summarizeAdb(h).cancelled, true);
});
test('a 15 minute delay is announced to both, once', () => {
  const f = base(); f.departure.revisedTime = T('2026-10-08 14:10Z');
  const s = summarizeAdb(f), now = Date.parse('2026-10-08T12:00Z');
  assert.deepEqual(events({}, s, now), [{ k: 'delay', to: 'all' }]);
  assert.deepEqual(events({ notified: { delay: 15 } }, s, now), []);
});
test('flight number and travellers from a booking', () => {
  assert.equal(identOf({ number: 'LH 1869' }), 'LH1869');
  assert.equal(identOf({ title: 'AZ 431 Rome → Munich' }), 'AZ431');
  assert.deepEqual([...travellersOf({ travellers: ['MS SULEKHA X'] })], ['Sulekha']);
  assert.deepEqual([...travellersOf({}, { traveller: 'Both' })].sort(), ['Anubhav', 'Sulekha']);
});
test('sparing plan: nothing a day ahead, checks in the last hours', () => {
  const b = { start: '2026-10-08T15:55' };
  assert.equal(due(b, null, Date.parse('2026-10-07T12:00Z'), true), false);
  assert.equal(due(b, null, Date.parse('2026-10-08T13:00Z'), true), true);
  assert.equal(due(b, { checkedAt: '2026-10-08T12:55:00Z', sched: '2026-10-08T13:55:00.000Z' }, Date.parse('2026-10-08T13:00Z'), true), false);
});
