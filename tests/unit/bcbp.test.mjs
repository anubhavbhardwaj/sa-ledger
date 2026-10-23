import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBCBP } from '../../public/bcbp.js';

// Build a boarding pass code the way airlines do (IATA 792 layout).
const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
function leg({ pnr = 'ABC123', from = 'MUC', to = 'FCO', carrier = 'LH', flight = '1840', doy = 84, cabin = 'Y', seat = '012A', seq = '0045', cond = '' }){
  return pad(pnr, 7) + from + to + pad(carrier, 3) + String(flight).padStart(4, '0') + ' ' + String(doy).padStart(3, '0') + cabin + seat.padStart(4, '0') + seq.padStart(4, '0') + ' ' + '1' + cond.length.toString(16).toUpperCase().padStart(2, '0') + cond;
}
const bp = (legs, name = 'BHARDWAJ/ANUBHAV MR') => 'M' + legs.length + pad(name, 20) + 'E' + legs.join('');

test('boarding pass: one leg, name, flight, route, seat, date from the issue date', () => {
  // unique block: ">", version "6", size, passenger desc, check-in source, issuance source, issue date "6295" (2026, day 295)
  const unique = '1WW6295';
  const cond = '>6' + unique.length.toString(16).toUpperCase().padStart(2, '0') + unique;
  const r = decodeBCBP(bp([leg({ doy: 84, cond })]), '2026-10-23');
  assert.equal(r.legs.length, 1);
  const b = r.legs[0];
  assert.equal(b.number, 'LH1840');
  assert.equal(b.from, 'Munich (MUC)'); assert.equal(b.to, 'Rome Fiumicino (FCO)');
  assert.equal(b.title, 'LH1840 Munich → Rome Fiumicino');
  assert.deepEqual(b.travellers, ['Anubhav Bhardwaj']);
  assert.equal(b.ref, 'ABC123'); assert.equal(b.seat, 'Seat 12A');
  // issued on day 295 of 2026, flight on day 84: that's March 2027
  assert.equal(b.start, '2027-03-25');
});
test('boarding pass: without an issue date, the year closest to the document date', () => {
  assert.equal(decodeBCBP(bp([leg({ doy: 300 })]), '2026-10-20').legs[0].start, '2026-10-27');
  assert.equal(decodeBCBP(bp([leg({ doy: 5 })]), '2026-12-28').legs[0].start, '2027-01-05');
});
test('boarding pass: two legs, carrier with 3 letters, other airports kept as codes', () => {
  const r = decodeBCBP(bp([leg({ from: 'FCO', to: 'DOH', carrier: 'QR', flight: '116', doy: 350 }), leg({ from: 'DOH', to: 'JAI', carrier: 'QR', flight: '578', doy: 351, seat: '034K' })], 'SHARMA/SULEKHA MS'), '2026-12-01');
  assert.deepEqual(r.legs.map(l => [l.number, l.start, l.seat]), [['QR116', '2026-12-16', 'Seat 12A'], ['QR578', '2026-12-17', 'Seat 34K']]);
  assert.deepEqual(r.legs[0].travellers, ['Sulekha Sharma']);
  assert.equal(r.legs[1].to, 'Jaipur (JAI)');
});
test('boarding pass: anything else is not decoded', () => {
  assert.equal(decodeBCBP('https://example.com/ticket/123'), null);
  assert.equal(decodeBCBP('M1SHORT'), null);
  assert.equal(decodeBCBP(bp([leg({ from: 'M1C' })])), null);
});
