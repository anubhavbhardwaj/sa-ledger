import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetMonth, groupRows, assignTargets, setAssigned, moveAssigned, keyOf, tripKey, parseKey, SAVE_KEY, monthsBetween } from '../../public/envelopes.js';

const cfg = () => ({ start: '2026-10-10', accounts: ['Deutsche Bank', 'Wise Common', 'Wise Sulekha', 'DB Card', 'IDFC Card'], opening: 2000, trips: true,
  targets: { [keyOf('Groceries', 'Supermarket')]: 300, [keyOf('Groceries', '')]: 50 }, assigned: {} });
const data = {
  items: [
    { date: '2026-10-05', amount: 99, category: 'Groceries', subcategory: 'Supermarket', account: 'Deutsche Bank' }, // before the start: ignored
    { date: '2026-10-11', amount: 120, category: 'Groceries', subcategory: 'Supermarket', account: 'Wise Common' },
    { date: '2026-10-12', amount: 30, category: 'Groceries', account: 'DB Card' },
    { date: '2026-10-12', amount: 70, category: 'Eating out', subcategory: 'Dinner', account: 'Wise Sulekha' },
    { date: '2026-10-13', amount: 999, category: 'Shopping', account: 'HDFC NRE' }, // not a budget account
    { date: '2026-10-14', amount: 200, category: 'Flights', tripId: 'rome', account: 'Deutsche Bank' },
    { date: '2026-11-02', amount: 280, category: 'Groceries', subcategory: 'Supermarket', account: 'Wise Common' },
  ],
  income: [{ date: '2026-10-28', amount: 3000, account: 'Deutsche Bank' }, { date: '2026-10-28', amount: 500, account: 'Sparkasse' }],
  transfers: [
    { date: '2026-10-15', amount: 1000, from: 'Deutsche Bank', to: 'Wise Common' },   // between budget accounts
    { date: '2026-10-16', amount: 400, from: 'Deutsche Bank', to: 'DB Card' },        // card payment
    { date: '2026-10-17', amount: 500, from: 'Deutsche Bank', to: 'Scalable' },       // invested
    { date: '2026-10-18', amount: 50, from: 'Scalable', to: 'Wise Common' },          // back in
  ],
};

test('ynab: keys, groups and months', () => {
  assert.deepEqual(parseKey(keyOf('Groceries', 'Super.market')), { group: 'Groceries', name: 'Super.market', cat: 'Groceries', sub: 'Super.market' });
  assert.equal(parseKey(keyOf('Groceries', '')).name, 'General');
  assert.equal(parseKey(tripKey('rome')).tripId, 'rome');
  assert.ok(!keyOf('A.b', 'c').includes('.'), 'no dots in database keys');
  assert.deepEqual(monthsBetween('2026-11', '2027-01'), ['2026-11', '2026-12', '2027-01']);
});

test('ynab: ready to assign, assigned, activity and available on the budget accounts only', () => {
  const c = cfg(); c.assigned = assignTargets(c, '2026-10').assigned;
  const oct = budgetMonth(c, '2026-10', data), by = Object.fromEntries(oct.rows.map(r => [r.key, r]));
  assert.equal(oct.ready, 2000 + 3000 + 50 - 350, 'opening + income into DB + money back from investments − assigned');
  assert.deepEqual([by[keyOf('Groceries', 'Supermarket')].activity, by[keyOf('Groceries', 'Supermarket')].available], [-120, 180]);
  assert.equal(by[keyOf('Groceries', '')].available, 20);
  assert.equal(by[keyOf('Eating out', 'Dinner')].available, -70, 'overspent');
  assert.equal(by[tripKey('rome')].activity, -200, 'trip spending in Travel');
  assert.equal(by[SAVE_KEY].activity, -500, 'invested; own transfers and the card payment change nothing');
  assert.equal(by[keyOf('Shopping', '')], undefined, 'spending on other accounts is left out');
  const groups = groupRows(oct.rows).map(g => g.group);
  assert.deepEqual(groups.slice(-2), ['Travel', 'Savings']);
});

test('ynab: rollover; last month overspending comes out of ready to assign and the envelope starts at zero', () => {
  const c = cfg(); c.assigned = assignTargets(c, '2026-10').assigned;
  const octReady = budgetMonth(c, '2026-10', data).ready;
  c.assigned = assignTargets(c, '2026-11').assigned;
  const nov = budgetMonth(c, '2026-11', data), by = Object.fromEntries(nov.rows.map(r => [r.key, r]));
  const sm = by[keyOf('Groceries', 'Supermarket')];
  assert.deepEqual([sm.carry, sm.assigned, sm.activity, sm.available], [180, 300, -280, 200]);
  assert.equal(by[keyOf('Eating out', 'Dinner')].available, 0, 'reset to zero');
  assert.equal(nov.overspentLast, 770, 'dinner 70 + Rome trip 200 + savings 500 overspent in October');
  assert.equal(nov.ready, octReady - 350 - 770);
});

test('ynab: set and move assigned money', () => {
  const c = cfg(); const k1 = keyOf('Groceries', 'Supermarket'), k2 = keyOf('Eating out', 'Dinner');
  c.assigned = setAssigned(c, '2026-10', k1, 300);
  c.assigned = moveAssigned(c, '2026-10', k1, k2, 70);
  assert.deepEqual(c.assigned['2026-10'], { [k1]: 230, [k2]: 70 });
  c.assigned = setAssigned(c, '2026-10', k2, 0);
  assert.deepEqual(c.assigned['2026-10'], { [k1]: 230 });
  assert.ok(budgetMonth(c, '2026-09', data).before);
});
