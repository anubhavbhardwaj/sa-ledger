import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelopeMonth, envelopeOf, fillMonth, moveMoney, startFromBudgets, monthsBetween } from '../../public/envelopes.js';

const ACC = { 'deutsche bank': { type: 'bank', currency: 'EUR' }, 'wise common': { type: 'bank', currency: 'EUR' }, 'scalable': { type: 'investment', currency: 'EUR' },
  'hdfc nre': { type: 'bank', currency: 'INR' }, 'db card': { type: 'card', currency: 'EUR' } };
const acc = n => ACC[String(n).toLowerCase()];
const cfg = () => ({ ...startFromBudgets([{ c: 'Groceries', a: 300 }, { c: 'Eating out', a: 150 }, { c: 'Zero', a: 0 }], '2026-10') });

test('envelopes: start from budgets, plus travel, savings and everything else', () => {
  const c = cfg();
  assert.deepEqual(c.envs.map(e => e.name), ['Groceries', 'Eating out', 'Travel', 'Savings & investing', 'Everything else']);
  assert.equal(envelopeOf(c, { category: 'Groceries' }), 'c-groceries');
  assert.equal(envelopeOf(c, { category: 'Groceries', tripId: 't1' }), 'travel', 'trip spending is travel');
  assert.equal(envelopeOf(c, { category: 'Pharmacy' }), 'other');
  assert.deepEqual(monthsBetween('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('envelopes: fill, spend, roll over, cover an overspend; ready to assign follows income and savings', () => {
  let c = cfg();
  c.months = fillMonth(c, '2026-10').months;
  const data = {
    income: [{ date: '2026-10-01', amount: 3000 }, { date: '2026-11-01', amount: 3000 }],
    items: [{ date: '2026-10-05', amount: 200, category: 'Groceries', account: 'Wise Common' }, { date: '2026-10-07', amount: 180, category: 'Eating out', account: 'DB card' },
      { date: '2026-10-09', amount: 50, category: 'Pharmacy', account: 'Deutsche Bank' }, { date: '2026-10-10', amount: 400, category: 'Flights', tripId: 't', account: 'Deutsche Bank' },
      { date: '2026-11-03', amount: 350, category: 'Groceries', account: 'Wise Common' }],
    transfers: [{ date: '2026-10-02', amount: 1000, from: 'Deutsche Bank', to: 'Wise Common' }, { date: '2026-10-03', amount: 500, from: 'Deutsche Bank', to: 'Scalable' },
      { date: '2026-10-04', amount: 300, from: 'Wise Common', to: 'HDFC NRE', currency: 'INR' }, { date: '2026-10-20', amount: 180, from: 'Deutsche Bank', to: 'DB card' }],
    acc };
  const oct = envelopeMonth(c, '2026-10', data), by = Object.fromEntries(oct.rows.map(r => [r.env.name, r]));
  assert.equal(oct.ready, 2550, '3000 income − 450 put in');
  assert.equal(by.Groceries.avail, 100); assert.equal(by['Eating out'].avail, -30, 'overspent');
  assert.equal(by['Everything else'].avail, -50); assert.equal(by.Travel.avail, -400);
  assert.equal(by['Savings & investing'].spent, 800, 'invested 500 + sent to India 300; own transfers and card payments ignored');
  c.months = moveMoney(c, '2026-10', 'ready', 'c-eating-out', 30);
  assert.equal(envelopeMonth(c, '2026-10', data).rows.find(r => r.env.id === 'c-eating-out').avail, 0);
  c.months = fillMonth(c, '2026-11').months;
  const nov = envelopeMonth(c, '2026-11', data), g = nov.rows.find(r => r.env.id === 'c-groceries');
  assert.deepEqual([g.carry, g.put, g.spent, g.avail], [100, 300, 350, 50], 'October leftover rolls into November');
  assert.equal(nov.ready, 2550 - 30 + 3000 - 450);
  assert.equal(fillMonth(c, '2026-11').n, 0, 'filling twice adds nothing');
  assert.ok(envelopeMonth(c, '2026-09', data).before, 'months before the start');
});

test('envelopes: moving between envelopes keeps the total', () => {
  const c = cfg(); c.months = fillMonth(c, '2026-10').months;
  c.months = moveMoney(c, '2026-10', 'c-groceries', 'c-eating-out', 40);
  assert.deepEqual(c.months['2026-10'], { 'c-groceries': 260, 'c-eating-out': 190 });
});
