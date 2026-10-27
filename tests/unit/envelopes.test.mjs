import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccKey, CC_UNKNOWN, norm, spendingStats, budgetMonth, committedBy, SAVE_A, SAVE_S, groupRows, assignTargets, setAssigned, moveAssigned, makeBudget, unassignedSources, allSources, tripKey, SAVE_KEY, NONE_KEY, monthsBetween, srcLabel } from '../../public/envelopes.js';

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
  assert.deepEqual(S.src[norm('Groceries')], { cur: 75, last: 240, avg: 260 }, 'whole category: (300 + 240 + 240) / 3');
  assert.deepEqual(S.src[norm('Groceries›Bakery')], { cur: 0, last: 30, avg: 10 });
  assert.deepEqual(S.env.food, { cur: 75, last: 210, avg: 250 }, 'Food gets Groceries except Bakery, which has its own envelope');
  assert.deepEqual(S.env.bakery, { cur: 0, last: 30, avg: 10 });
});

test('envelopes: spending in envelope categories from accounts outside the budget is reported, not counted; excluded accounts stay quiet', () => {
  const c = { start: '2026-10-01', accounts: ['Deutsche Bank'], opening: 0, groups: [{ id: 'g', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent', src: ['Rent'] }] }], assigned: {} };
  const items = [{ date: '2026-10-01', amount: 900, category: 'Rent', account: 'Raiffeisen Bank' }, { date: '2026-10-01', amount: 880, category: 'Rent', account: 'Deutsche Bank' },
    { date: '2026-10-02', amount: 50, category: 'Hobby', account: 'Raiffeisen Bank' }, { date: '2026-10-03', amount: 20, category: 'Rent', account: 'HDFC NRE' }];
  const B = budgetMonth(c, '2026-10', { items }), rent = B.rows.find(r => r.key === 'rent');
  assert.equal(rent.activity, -880);
  assert.deepEqual(B.outside, { total: 920, byAcc: [{ acc: 'Raiffeisen Bank', amount: 900 }, { acc: 'HDFC NRE', amount: 20 }], byKey: { rent: 920 } }, 'Hobby has no envelope, so it is not reported');
  assert.equal(budgetMonth({ ...c, excluded: ['hdfc nre'] }, '2026-10', { items }).outside.total, 900);
});

test('envelopes: categories match whatever their case or spacing; the list shows each once', () => {
  const c = { start: '2026-10-01', accounts: ['Wise - Common'], opening: 0, groups: [{ id: 'g', name: 'Daily', envs: [{ id: 'eat', name: 'Eating out', src: ['Eating Out'] }] }], assigned: {} };
  const items = [{ date: '2026-10-02', amount: 20, category: 'Eating out', account: 'wise - common' }, { date: '2026-10-03', amount: 30, category: 'eating out ', account: 'Wise - Common' },
    { date: '2026-10-04', amount: 10, category: 'Eating Out', subcategory: 'Coffee', account: 'Wise - Common' }];
  assert.equal(budgetMonth(c, '2026-10', { items }).rows.find(r => r.key === 'eat').activity, -60);
  assert.deepEqual(allSources(items), ['Eating out', 'Eating out›Coffee']);
});

test('envelopes: credit cards the YNAB way (card spending moves to the card envelope, payments and bills logged as spending come out of it, old debt is not taken off Ready to Assign)', () => {
  const A = { 'deutsche bank': { type: 'bank' }, 'wise - common': { type: 'bank' }, 'amex': { type: 'card' }, 'idfc': { type: 'card', currency: 'INR' } };
  const acc = n => A[norm(n)];
  const c = { start: '2026-10-01', accounts: ['Deutsche Bank', 'Wise - Common', 'AMEX', 'IDFC'], opening: 2100, openingBy: { 'Deutsche Bank': 2000, 'Wise - Common': 500, 'AMEX': -300, 'IDFC': -100 },
    groups: [{ id: 'g', name: 'Daily', envs: [{ id: 'food', name: 'Groceries', src: ['Groceries'] }, { id: 'eat', name: 'Eating out', src: ['Eating out'] }] }], assigned: {} };
  const data = { acc,
    items: [{ date: '2026-10-02', amount: 50, category: 'Groceries', account: 'AMEX' }, { date: '2026-10-03', amount: 30, category: 'Eating out', account: 'Wise - Common' },
      { date: '2026-10-05', amount: 300, category: 'Credit Card', store: 'Amex payment', account: 'Deutsche Bank' }, { date: '2026-10-06', amount: 100, category: 'Credit Card', store: 'IDFC bill', account: 'Deutsche Bank' },
      { date: '2026-10-07', amount: 20, category: 'Credit Card', store: 'Card', account: 'Deutsche Bank' }],
    transfers: [{ date: '2026-10-08', amount: 50, from: 'Deutsche Bank', to: 'AMEX' }] };
  const B = budgetMonth(c, '2026-10', data), by = Object.fromEntries(B.rows.map(r => [r.key, r]));
  assert.equal(B.opening, 2500, 'cash only; card debt is not taken off Ready to Assign');
  assert.equal(by.food.activity, -50, 'card spending comes out of its category');
  assert.deepEqual([by[ccKey('AMEX')].activity, by[ccKey('AMEX')].debtAtStart], [50 - 300 - 50, 300], 'spending moved in, bill and transfer paid out');
  assert.equal(by[ccKey('IDFC')].activity, -100, 'the IDFC bill found by name');
  assert.equal(by[CC_UNKNOWN].activity, -20, 'a bill naming no card');
  assert.equal(by[NONE_KEY], undefined, 'card bills are not spending');
  const cash = 2000 - 300 - 100 - 20 - 50 + 500 - 30, avail = B.rows.reduce((s, r) => s + r.available, 0);
  assert.equal(Math.round((B.ready + avail) * 100) / 100, cash, 'Ready to Assign + all envelopes = cash in the budget accounts');
  assert.deepEqual(groupRows(c, B.rows).map(g => g.group), ['Credit Card Payments', 'Daily']);
});

test('envelopes: assigning in a later month (YNAB) takes it from Ready to Assign now; that month starts with what this one leaves', () => {
  const c = cfg(); c.assigned = assignTargets(c, '2026-10').assigned;
  const now = '2026-10', d = { ...data, now };
  const before = budgetMonth(c, '2026-10', d).ready;
  c.assigned = setAssigned(c, '2026-11', 'food', 250);
  c.assigned = setAssigned(c, '2026-12', 'rent', 800);
  const oct = budgetMonth(c, '2026-10', d);
  assert.equal(oct.future, 1050); assert.equal(oct.ready, before - 1050, 'November and December assignments are spoken for');
  const nov = budgetMonth(c, '2026-11', d), food = nov.rows.find(r => r.key === 'food');
  assert.deepEqual([food.carry, food.assigned, food.available], [210, 250, 460], 'October leftover + November assignment');
  assert.equal(nov.future, 800, 'December still counts against November');
  assert.equal(nov.ready, before - 755 - 250 - 800, 'November: October overspending, its own and December’s assignments');
  const dec = budgetMonth(c, '2026-12', d);
  assert.equal(dec.future, 0); assert.equal(dec.rows.find(r => r.key === 'rent').available, 800 - 800 + 800, 'rent carried 0 after November’s bill, then 800');
  // A month already over isn't rewritten by later plans.
  assert.equal(budgetMonth(c, '2026-10', { ...data, now: '2026-12' }).future, 0);
  // Money in a deleted envelope's future plan doesn't count.
  c.assigned = setAssigned(c, '2026-11', 'gone', 99);
  assert.equal(budgetMonth(c, '2026-10', d).future, 1050);
});

test('envelopes: whose money each envelope is; savings per account owner; what is still set aside for each of you', () => {
  const c = cfg();
  c.groups[0].envs[0].split = { Anubhav: 860, Sulekha: 900 };   // Rent
  c.groups[1].envs[1].owner = 'Sulekha';                        // Bakery
  c.groups.push({ id: 'g3', name: 'Life', envs: [{ id: 'wed', name: 'Wedding', src: ['Wedding'], owner: 'Anubhav' }] });
  const owners = { 'Deutsche Bank': 'Anubhav', 'Wise Sulekha': 'Sulekha', 'Wise Common': 'Shared', 'DB Card': 'Anubhav' };
  const acc = n => owners[n] ? { name: n, owner: owners[n], type: /Card/.test(n) ? 'card' : 'bank' } : null;
  const transfers = [...data.transfers, { date: '2026-10-18', amount: 100, from: 'Wise Sulekha', to: 'Fineco' }, { date: '2026-10-19', amount: 50, from: 'Wise Common', to: 'Fineco' }];
  c.assigned = { '2026-10': { rent: 1760, food: 400, bakery: 30, wed: 1000, [SAVE_A]: 600, [SAVE_S]: 100 }, '2026-11': { wed: 200 } };
  const d = { ...data, transfers, acc, now: '2026-10' }, oct = budgetMonth(c, '2026-10', d), by = Object.fromEntries(oct.rows.map(r => [r.key, r]));
  assert.deepEqual([by[SAVE_A].activity, by[SAVE_S].activity, by[SAVE_KEY].activity], [-500, -100, -50], 'each from the account it left');
  assert.equal(by[SAVE_A].name, 'Investing & India · Anubhav');
  assert.deepEqual(groupRows(c, oct.rows).find(g => g.group === 'Savings').rows.map(r => r.key), [SAVE_A, SAVE_S, SAVE_KEY]);
  assert.deepEqual(oct.futureBy, { wed: 200 });
  const W = committedBy(c, oct.rows, { futureBy: oct.futureBy, tripOwner: id => id === 'rome' ? 'Anubhav' : 'Both' });
  // Rent 1760 not paid yet in October: 860 / 900. Wedding 1000 + 200 planned for November. Savings left 100 (A), 0 (S).
  // Food 210 left → Both. Bakery 30 − 15 = 15 → Sulekha. Rome trip overspent → nothing. Card envelope and Not assigned left out.
  assert.deepEqual(W, { Anubhav: 860 + 1200 + 100, Sulekha: 900 + 15, Both: 210 });
});

test('envelopes: inside each group the biggest come first (assigned, then spent, then available)', () => {
  const c = cfg(); c.assigned = { '2026-10': { food: 400, rent: 800, net: 50 } };
  const G = groupRows(c, budgetMonth(c, '2026-10', { ...data, now: '2026-10' }).rows);
  assert.deepEqual(G.find(g => g.group === 'Fixed').rows.map(r => r.key), ['rent', 'net']);
  assert.deepEqual(G.find(g => g.group === 'Flexible').rows.map(r => r.key), ['food', 'bakery'], 'Bakery: nothing assigned, spent 15');
  const none = { '2026-10': {} }; c.assigned = none;
  assert.deepEqual(groupRows(c, budgetMonth(c, '2026-10', { ...data, now: '2026-10' }).rows).find(g => g.group === 'Flexible').rows.map(r => r.key), ['food', 'bakery'], 'nothing assigned: by spending (190 vs 15)');
});
