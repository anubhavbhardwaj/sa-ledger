import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CategoryModel, evaluate, normStore } from '../../public/smart.js';

const day = k => new Date(Date.UTC(2025, 0, 1 + k)).toISOString().slice(0, 10);
function history(){
  const out = []; let k = 0;
  for (let w = 0; w < 60; w++){
    out.push({ store: w % 2 ? 'REWE Markt' : 'Rewe City', amount: 30 + (w % 7), category: 'Groceries', account: 'DKB', date: day(k++) });
    out.push({ store: 'Aldi Süd', amount: 18, category: 'Groceries', account: 'DKB', date: day(k++) });
    out.push({ store: w % 3 ? 'Bar Centrale' : 'Bar Di Scienze', amount: 3.3, category: 'Eating Out', account: 'Wise', country: 'Italy', date: day(k++) });
    out.push({ store: 'Lieferando', amount: 25, category: 'Eating Out', account: 'Wise', date: day(k++) });
    if (w % 4 === 0) out.push({ store: 'DB Fernverkehr', amount: 60, category: 'Transportation', account: 'DKB', date: day(k++) });
    if (w % 10 === 0) out.push({ store: 'Shell', amount: 70, category: 'Transportation', account: 'DKB', date: day(k++) });
  }
  return out;
}

test('smart: store names are normalised', () => {
  assert.equal(normStore('  REWE  Markt GmbH'), 'rewe markt gmbh');
  assert.equal(normStore('Café Müller'), 'cafe muller');
});
test('smart: learns from words of the store, also for a store it has never seen', () => {
  const m = new CategoryModel(); history().forEach(i => m.add(i));
  assert.equal(m.predict({ store: 'Rewe To Go', amount: 12, account: 'DKB', date: day(300) })[0].category, 'Groceries');
  assert.equal(m.predict({ store: 'Bar Roma', amount: 4, account: 'Wise', country: 'Italy', date: day(300) })[0].category, 'Eating Out');
  const p = m.predict({ store: 'DB Fernverkehr', amount: 59, account: 'DKB', date: day(300) });
  assert.equal(p[0].category, 'Transportation'); assert.ok(p[0].p > 0.9);
  assert.ok(Math.abs(p.reduce((s, x) => s + x.p, 0) - 1) < 0.02 || p.length === 3);
});
test('smart: recent habits win over old ones', () => {
  const m = new CategoryModel();
  for (let k = 0; k < 20; k++) m.add({ store: 'Amazon', amount: 30, category: 'Household', date: day(k) });
  for (let k = 0; k < 8; k++) m.add({ store: 'Amazon', amount: 30, category: 'Electronics', date: day(600 + k) });
  assert.equal(m.predict({ store: 'Amazon', amount: 30, date: day(610) })[0].category, 'Electronics');
});
test('smart: the replay compares the model with the current rule', () => {
  const r = evaluate(history(), { from: day(150) });
  assert.ok(r.n > 50);
  assert.ok(r.model.top1 / r.n >= r.rule.ok / r.n, 'model at least as good as the rule overall');
  assert.ok(r.unseen.n >= 0);
});

import { lexiconGuess, suggestCategory } from '../../public/smart.js';
test('smart: the starter vocabulary maps unknown stores to your own categories only', () => {
  const mine = ['groceries', 'eating out', 'transportation', 'phone/internet'];
  assert.equal(lexiconGuess('Esselunga Milano', mine), 'groceries');
  assert.equal(lexiconGuess('Trattoria da Enzo', mine), 'eating out');
  assert.equal(lexiconGuess('Trenitalia', mine), 'transportation');
  assert.equal(lexiconGuess('Iliad Italia', mine), 'phone/internet');
  assert.equal(lexiconGuess('Allianz', mine), null, 'no insurance category: nothing invented');
  assert.equal(lexiconGuess('Something Unknown', mine), null);
});
test('smart: combined suggestion fills from the rule, the model or the starter vocabulary, otherwise offers choices', () => {
  const m = new CategoryModel(), hist = new Map(), add = i => { m.add(i); const s = i.store.toLowerCase(); (hist.get(s) || hist.set(s, []).get(s)).push(i.category.toLowerCase()); };
  history().forEach(add);
  assert.equal(suggestCategory(m, hist, { store: 'Lieferando', amount: 25, date: day(300) }).source, 'rule');
  const lex = suggestCategory(m, hist, { store: 'Trattoria da Enzo', amount: 40, account: 'Wise', date: day(300) });
  assert.equal(lex.fill, 'eating out'); assert.equal(lex.source, 'starter');
  const none = suggestCategory(m, hist, { store: 'Xyzzy Qwerty', amount: 40, account: 'Wise', date: day(300) });
  assert.equal(none.fill, null); assert.equal(none.chips.length, 3);
});

import { tuneThreshold } from '../../public/smart.js';
test('smart: the fill-in threshold is tuned to the target precision on the replay', () => {
  const r = tuneThreshold(history(), { from: day(150), target: 0.95 });
  assert.ok(r.threshold >= 0.5 && r.threshold <= 0.9);
  const at = r.sweep.find(x => x.t === r.threshold);
  assert.ok(at.precision >= 0.95 || r.threshold === 0.9);
});
