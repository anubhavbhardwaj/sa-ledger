import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spendingStats, budgetMonth, groupRows, assignTargets, setAssigned, moveAssigned, makeBudget, unassignedSources, allSources, tripKey, SAVE_KEY, NONE_KEY, monthsBetween, srcLabel } from '../../public/envelopes.js';

const cfg = () => ({ start: '2026-10-10', accounts: ['Deutsche Bank', 'Wise Common', 'Wise Sulekha', 'DB Card', 'IDFC Card'], opening: 2000, trips: true,
  groups: [
    { id: 'g1', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent', src: ['Housing›Rent'] }, { id: 'net', name: 'Internet & phone', src: ['Utilities›Internet', 'Utilities›Phone'] }] },
    { id: 'g2', name: 'Flexible', envs: [{ id: 'food', name: 'Food', src: ['Groceries', 'Eating out›Dinner'] }, { id: 'bakery', name: 'Bakery', src: ['Groceries›Bakery'] }] },
  ],
  targets: { rent: 800, food: 400, gone: 99 }, assigned: {} });
const data = {
  items: [
    { date: '2026-10-05', amount: 99, category: 'Groceries', account: 'Deutsche Bank' },                               // before the start
    { date: '2026-10-11', amount: 120, category: 'Groceries', subcategory: 'Supermarket', account: 'Wise Common' },   // whole category → Food
    { date: '2026-10-12', amount: 15, category: 'Groceries', subcategory: 'Bakery', account: 'DB Card' },             // specific wins → Bakery
    { date: '2026-10-12', amount: 70, category: 'Eating out', subcategory: 'Dinner', account: 'Wise Sulekha' },
    { date: '2026-10-12', amount: 40, category: 'Eating out', subcategory: 'Coffee', account: 'Wise Sulekha' },       // no envelope
    { date: '2026-10-13', amount: 999, category: 'Shopping', account: 'HDFC NRE' },                                   // not a budget account
    { date: '2026-10-14', amount: 200, category: 'Flights', tripId: 'rome', account: 'Deutsche Bank' },
    { date: '2026-11-01', amount: 800, category: 'Housing', subcategory: 'Rent', account: 'Deutsche Bank' },
  ],
  income: [{ date: '2026-10-28', amount: 3000, account: 'Deutsche Bank' }],
  transfers: [{ date: '2026-10-16', amount: 400, from: 'Deutsche Bank', to: 'DB Card' }, { date: '2026-10-17', amount: 500, from: 'Deutsche Bank', to: 'Scalable' }],
};

test('envelopes: your structure decides where spending goes; the most specific source wins', () => {
  const { keyFor } = makeBudget(cfg());
  assert.equal(keyFor({ category: 'Groceries', subcategory: 'Supermarket' }), 'food');
  assert.equal(keyFor({ category: 'Groceries', subcategory: 'Bakery' }), 'bakery');
  assert.equal(keyFor({ category: 'Utilities', subcategory: 'Phone' }), 'net');
  assert.equal(keyFor({ category: 'Eating out', subcategory: 'Coffee' }), NONE_KEY);
  assert.equal(keyFor({ category: 'Flights', tripId: 'rome' }), tripKey('rome'));
  assert.equal(srcLabel('Groceries'), 'Groceries (all)'); assert.equal(srcLabel('Utilities›Phone'), 'Utilities › Phone');
  assert.deepEqual(monthsBetween('2026-11', '2027-01'), ['2026-11', '2026-12', '2027-01']);
});

test('envelopes: ready to assign, assigned, activity, available; not assigned and savings', () => {
  const c = cfg(); c.assigned = assignTargets(c, '2026-10').assigned;
  assert.deepEqual(c.assigned['2026-10'], { rent: 800, food: 400 }, 'targets of deleted envelopes are skipped');
  const oct = budgetMonth(c, '2026-10', data), by = Object.fromEntries(oct.rows.map(r => [r.key, r]));
  assert.equal(oct.ready, 2000 + 3000 - 1200);
  assert.deepEqual([by.food.activity, by.food.available], [-190, 210], 'supermarket 120 + dinner 70');
  assert.equal(by.bakery.available, -15); assert.equal(by[NONE_KEY].activity, -40); assert.equal(by[SAVE_KEY].activity, -500);
  const G = groupRows(c, oct.rows).map(g => g.group);
  assert.deepEqual(G, ['Not assigned', 'Fixed', 'Flexible', 'Travel', 'Savings']);
  assert.deepEqual(unassignedSources(c, data.items, '2026-10-10'), [{ src: 'Eating out›Coffee', amount: 40 }], 'only spending on budget accounts');
  assert.deepEqual(allSources(data.items).slice(0, 4), ['Eating out', 'Eating out›Coffee', 'Eating out›Dinner', 'Flights']);
});

test('envelopes: rollover; overspending comes out of next month; deleted envelopes return their money', () => {
  const c = cfg(); c.assigned = assignTargets(c, '2026-10').assigned;
  const oct = budgetMonth(c, '2026-10', data);
  const nov = budgetMonth(c, '2026-11', data), by = Object.fromEntries(nov.rows.map(r => [r.key, r]));
  assert.deepEqual([by.rent.carry, by.rent.activity, by.rent.available], [800, -800, 0]);
  assert.equal(by.bakery.available, 0); assert.equal(nov.overspentLast, 15 + 40 + 200 + 500);
  assert.equal(nov.ready, oct.ready - 755);
  c.groups[1].envs = c.groups[1].envs.filter(e => e.id !== 'food');
  assert.equal(budgetMonth(c, '2026-10', data).ready, oct.ready + 400, 'Food deleted: its 400 is back');
});

test('envelopes: set and move assigned money', () => {
  const c = cfg();
  c.assigned = setAssigned(c, '2026-10', 'food', 300);
  c.assigned = moveAssigned(c, '2026-10', 'food', 'bakery', 20);
  assert.deepEqual(c.assigned['2026-10'], { food: 280, bakery: 20 });
  c.assigned = setAssigned(c, '2026-10', 'bakery', 0);
  assert.deepEqual(c.assigned['2026-10'], { food: 280 });
  assert.ok(budgetMonth(c, '2026-09', data).before);
});

test('envelopes: running totals per source and per envelope to help pick a target', () => {
  const c = cfg(), items = [
    { date: '2026-07-03', amount: 300, category: 'Groceries', subcategory: 'Supermarket', account: 'Wise Common' },
    { date: '2026-08-03', amount: 240, category: 'Groceries', subcategory: 'Supermarket', account: 'Wise Common' },
    { date: '2026-09-03', amount: 210, category: 'Groceries', subcategory: 'Supermarket', account: 'DB Card' },
    { date: '2026-09-05', amount: 30, category: 'Groceries', subcategory: 'Bakery', account: 'DB Card' },
    { date: '2026-09-06', amount: 500, category: 'Groceries', account: 'HDFC NRE' },                        // not a budget account
    { date: '2026-09-07', amount: 90, category: 'Groceries', tripId: 'rome', account: 'Deutsche Bank' },    // trip
    { date: '2026-10-02', amount: 75, category: 'Groceries', subcategory: 'Supermarket', account: 'Wise Common' },
    { date: '2026-06-02', amount: 999, category: 'Groceries', account: 'Wise Common' },                     // too old
  ];
  const S = spendingStats(c, items, '2026-10');
  assert.deepEqual(S.src['Groceries'], { cur: 75, last: 240, avg: 260 }, 'whole category: (300 + 240 + 240) / 3');
  assert.deepEqual(S.src['Groceries›Bakery'], { cur: 0, last: 30, avg: 10 });
  assert.deepEqual(S.env.food, { cur: 75, last: 210, avg: 250 }, 'Food gets Groceries except Bakery, which has its own envelope');
  assert.deepEqual(S.env.bakery, { cur: 0, last: 30, avg: 10 });
});
