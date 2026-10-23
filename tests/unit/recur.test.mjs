import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRecurring, backtest } from '../../public/recur.js';

let id = 0;
const e = (store, date, amount, category = 'Subscriptions', extra = {}) => ({ id: 'r' + (id++), store, date, amount, category, account: 'Wise', ...extra });
const monthly = (store, amount, from, n, day = 5, cat) => Array.from({ length: n }, (_, k) => { const d = new Date(Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1 + k, day)); return e(store, d.toISOString().slice(0, 10), amount, cat); });

test('recurring: monthly subscription with next date, amount and a price change', () => {
  const items = [...monthly('Netflix', 13.99, '2026-04', 4), ...monthly('Netflix', 15.99, '2026-08', 3)];
  const [s] = detectRecurring(items, '2026-10-24');
  assert.equal(s.period, 'monthly'); assert.equal(s.next, '2026-11-05'); assert.equal(s.amount, 15.99);
  assert.ok(s.change && s.change.to === 15.99 && Math.abs(s.change.from - 13.99) < 1.1);
});
test('recurring: yearly from two charges, weekly needs four, groceries are not subscriptions', () => {
  const items = [e('Amazon Prime', '2025-11-02', 89.9), e('Amazon Prime', '2026-11-01', 89.9),
    ...[0, 7, 14, 21, 28].map(k => e('Gym Box', new Date(Date.UTC(2026, 8, 1 + k)).toISOString().slice(0, 10), 12, 'Fitness')),
    ...[1, 4, 8, 9, 15, 19, 22, 29].map((d, k) => e('Rewe City', `2026-09-${String(d).padStart(2, '0')}`, [12, 54, 33, 8, 71, 25, 40, 19][k], 'Groceries'))];
  const r = detectRecurring(items, '2026-10-12');
  assert.equal(r.find(s => s.store === 'Amazon Prime')?.period, 'yearly');
  assert.equal(r.find(s => s.store === 'Gym Box')?.period, 'weekly');
  assert.ok(!r.some(s => s.store === 'Rewe City'));
  assert.equal(r.find(s => s.store === 'Gym Box').status, 'missed', 'last charge 29 Sep, expected 6 Oct, nothing by 12 Oct');
  assert.ok(!detectRecurring(items, '2026-10-30').some(s => s.store === 'Gym Box'), 'a month without it: stopped');
});
test('recurring: two subscriptions at one store are kept apart; a stopped one is dropped', () => {
  const items = [...monthly('Apple', 2.99, '2026-05', 6, 3), ...monthly('Apple', 9.99, '2026-05', 6, 17), ...monthly('Old Gym', 30, '2025-01', 5)];
  const r = detectRecurring(items, '2026-10-24');
  assert.deepEqual(r.filter(s => s.store === 'Apple').map(s => s.amount).sort(), [2.99, 9.99]);
  assert.ok(!r.some(s => s.store === 'Old Gym'));
});
test('recurring: backtest predicts the last charge from the earlier ones', () => {
  const items = [...monthly('Spotify', 10.99, '2026-03', 8, 12), ...monthly('Vodafone', 39.99, '2026-02', 9, 28)];
  const b = backtest(items, '2026-10-24');
  assert.equal(b.n, 2); assert.equal(b.dateOk, 2); assert.equal(b.amtOk, 2);
});
