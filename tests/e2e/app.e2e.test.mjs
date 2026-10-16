// End-to-end checks of the app in a real browser (Chromium via Playwright), desktop and phone size.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, openApp, d, month } from './helpers.mjs';

before(start);
after(stop);

// Every test ends with: no JavaScript errors on the page, and no write the database rules would refuse.
async function clean(app){
  assert.deepEqual(app.errors, [], 'page errors');
  assert.deepEqual(await app.ruleErrors(), [], 'writes the Firestore rules would refuse');
  await app.close();
}

for (const mobile of [false, true]) test(`every page opens without errors (${mobile ? 'phone' : 'desktop'})`, async () => {
  const app = await openApp({ mobile });
  await app.seed({ expenses: { e1: { amount: 12.5, date: d(0), store: 'Rewe', category: 'Groceries', account: 'DKB', spender: 'Anubhav', createdAt: 'x' } } });
  for (const h of ['overview', 'transactions', 'visualizations', 'wealth', 'trips']){ await app.go(h); await app.page.waitForTimeout(150); }
  await clean(app);
});

test('planner, compare both with the evening before: all 10 days are searched and a pick becomes a trip', async () => {
  const app = await openApp(), { page } = app, s = d(60), e = d(65);
  await app.go('trips'); await page.click('[data-plan=""]');
  await page.click('[data-planwho="both"]');
  await page.fill('#planStart', s); await page.dispatchEvent('#planStart', 'change');
  assert.equal(await page.inputValue('#planEnd'), s, 'the end date follows the start date');
  await page.fill('#planEnd', e); await page.dispatchEvent('#planEnd', 'change');
  await page.fill('#planNights', '3');
  assert.match(await app.text('#planCost'), /^10 price searches/);
  await page.click('#planGo'); await page.waitForSelector('.plcard');
  const log = await page.$$eval('.pllog .plrow small', els => els.map(x => x.textContent));
  assert.equal(log.length, 10);
  assert.ok(log.every(t => /kept of/.test(t)), 'every day answered: ' + log.join(' | '));
  assert.match(await app.text('#planOut'), /evening before/);
  await page.click('.plcard [data-planuse]');
  await page.waitForSelector('#tripDetail .tblist');
  assert.equal(await page.$$eval('#tripDetail .tblist .tbrow', r => r.length), 2);
  await clean(app);
});

test('planner, meet somewhere new: places for both, a Rome group with no answer is asked per airport, trip with 5 things to book', async () => {
  const app = await openApp({ serp: { emptyGroups: /^FCO,CIA$/ } }), { page } = app;
  await app.go('trips'); await page.click('[data-plan=""]');
  await page.click('[data-planwho="meet"]');
  await page.fill('#planStart', d(60)); await page.dispatchEvent('#planStart', 'change');
  await page.fill('#planEnd', d(65)); await page.dispatchEvent('#planEnd', 'change');
  await page.fill('#planNights', '3');
  await page.click('#planGo'); await page.waitForSelector('.plplace');
  const places = await app.text('#planOut');
  assert.match(places, /Athens/); assert.match(places, /Vienna/);
  assert.doesNotMatch(places, /Rome|Porto|Lisbon/, 'home and one-sided places are left out');
  await page.click('[data-planplace="0"]'); await page.waitForSelector('.plcard');
  assert.match(await app.text('.pllog'), /asked each airport separately/);
  assert.doesNotMatch(await app.text('#planOut'), /No return flights/);
  // Ask AI to choose: the real handler, with the test model picking the first two
  await page.fill('#planCond', 'no Ryanair'); await page.click('[data-planai]');
  await page.waitForSelector('.plwhy');
  assert.equal(await page.$$eval('.plwhy', x => x.length), 2);
  await page.click('.plcard [data-planmeet]');
  await page.waitForSelector('#tripDetail .tblist');
  assert.equal(await page.$$eval('#tripDetail .tblist .tbrow', r => r.length), 5, 'four flights and the hotel');
  await clean(app);
});

test('to book: typing keeps focus, the estimate saves, the trip adds up spent, booked and still to book', async () => {
  const app = await openApp(), { page } = app;
  await app.seed({
    trips: { w: { name: 'Wedding', type: 'other', traveller: 'Both', start: d(30), end: d(40), budget: 6000 } },
    expenses: { e1: { amount: 695, date: d(-5), store: 'Air India', category: 'Travel', account: 'DKB', spender: 'Anubhav', tripId: 'w', createdAt: 'x' } },
    bookings: { b1: { tripId: 'w', type: 'flight', title: 'AI 122', start: d(30) + 'T12:00', price: 695, currency: 'EUR', expenseId: 'e1' }, b2: { tripId: 'w', type: 'hotel', title: 'Taj', start: d(32), price: 450, currency: 'EUR' } },
    toBook: { t1: { tripId: 'w', what: 'Train', type: 'train', price: 60, priceEst: true, done: false }, t2: { tripId: 'w', what: 'Return flight', type: 'flight', done: false } },
  });
  await app.go('trips'); await page.click('.tcard[data-trip="w"]'); await page.waitForSelector('#tbText');
  await page.click('#tbText'); await page.keyboard.type('hotel in Delhi');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tbText');
  await page.fill('[data-tbprice="t2"]', '520'); await page.press('[data-tbprice="t2"]', 'Enter'); await page.waitForTimeout(200);
  const k = await app.text('#tripDetail .kpis');
  assert.match(k, /Booked€1,145/); assert.match(k, /Still to book≈ €580/); assert.match(k, /Expected total€1,725/); assert.match(k, /€4,275 left after everything/);
  await clean(app);
});

test('a trip marked finished moves to Past even on its last day', async () => {
  const app = await openApp(), { page } = app;
  await app.seed({ trips: { t: { name: 'Rome visit', type: 'visit', traveller: 'Anubhav', start: d(-3), end: d(0) } } });
  await app.go('trips'); await page.click('.tcard[data-trip="t"]');
  await page.click('[data-tripclose="t"]'); await page.waitForTimeout(200);
  await page.click('[data-backtrips]'); await page.waitForTimeout(100);
  const list = await app.text('#tripList');
  assert.ok(list.indexOf('Past') < list.indexOf('Rome visit'), 'listed under Past: ' + list.slice(0, 200));
  await clean(app);
});

test('overview: invested counts both of you, split by owner', async () => {
  const app = await openApp(), { page } = app, m = month(0);
  await app.seed({
    accounts: { a1: { name: 'Trade Republic', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' }, a2: { name: 'T212 - Sulekha', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Sulekha' }, a3: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha' } },
    invSnapshots: { ['a1_' + m]: { accountId: 'a1', month: m, investment: 812, value: 21000 }, ['a2_' + m]: { accountId: 'a2', month: m, investment: 3000, value: 3000, opening: true } },
    transfers: { t1: { amount: 500, date: m + '-01', from: 'Wise Sulekha', to: 'T212 - Sulekha' } },
  });
  await page.waitForTimeout(200);
  const saved = (await page.$$eval('#kpis .kpi', els => els.map(e => e.textContent.replace(/\s+/g, ' ')))).find(t => t.startsWith('Saved')) || '';
  assert.match(saved, /€1,312 invested/); assert.match(saved, /Sulekha €500/); assert.match(saved, /Anubhav €812/);
  await clean(app);
});

test('what if: lower a category for the month and the invested amount goes up', async () => {
  const app = await openApp(), { page } = app, m = month(-1);
  await app.seed({ expenses: { e1: { amount: 900, date: m + '-10', store: 'Venue', category: 'Wedding', account: 'DKB', spender: 'Anubhav', createdAt: 'x' }, e2: { amount: 300, date: m + '-11', store: 'Pizza', category: 'Restaurants', account: 'DKB', spender: 'Anubhav', createdAt: 'x' } } });
  await app.go('visualizations'); await page.click(`.chip[data-p="${m}"]`);
  await page.fill('[aria-label="What if for Wedding"]', '0'); await page.waitForTimeout(100);
  assert.match(await app.text('.wisum'), /€900 more invested that month/);
  await clean(app);
});

test('trips: finished trips fold away; leave days and the travel budget add up per year', async () => {
  const app = await openApp(), { page } = app, now = new Date();
  const y = now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();   // the panel opens on next year from October
  await app.seed({ trips: {
    old: { name: 'Old visit', type: 'visit', traveller: 'Anubhav', start: d(-40), end: d(-35) },
    a: { name: 'Easter visit', type: 'visit', traveller: 'Anubhav', start: `${y}-04-01`, end: `${y}-04-06`, vacDays: 3, wfaDays: 1 },
    b: { name: 'Summer', type: 'holiday', traveller: 'Both', start: `${y}-08-03`, end: `${y}-08-14`, budget: 2000 },
  }, toBook: { t1: { tripId: 'b', what: 'Flights', type: 'flight', price: 400, done: false } } });
  await app.go('trips'); await page.waitForSelector('.lvgrid');
  assert.equal(await page.$eval('#tripPast', el => el.open), false, 'past trips start folded');
  assert.match(await app.text('#tripPast summary'), /Past and finished \(1\)/);
  const panel = await app.text('.lvgrid');
  assert.match(panel, /Vacation days3 of 30/); assert.match(panel, /Work from abroad1 of 15/); assert.match(panel, /€2,000 planned/);
  assert.match(await app.text('.lvlist'), /Summer.*days not set/);
  // Set a travel budget for that year
  await page.click(`[data-leaveedit="${y}"] >> nth=0`); await page.fill('#lv-budget', '5000'); await page.click('#leaveForm [type=submit]'); await page.waitForTimeout(200);
  assert.match(await app.text('.lvgrid'), /€2,000 of €5,000/);
  // The trip dialog counts workdays without Bavarian holidays: Easter week 2027, Thu 25 to Tue 30 March = Thu 25 and Tue 30
  await page.click('#newTrip'); await page.fill('#t-start', '2027-03-25'); await page.dispatchEvent('#t-start', 'change');
  await page.fill('#t-end', '2027-03-30'); await page.dispatchEvent('#t-end', 'change');
  assert.match(await app.text('#tripWorkdays'), /^2 workdays in these dates \(not counting Good Friday, Easter Monday\)/);
  await page.click('#tripUseDays'); await page.fill('#t-name', 'Easter 2027'); await page.click('#tripSave'); await page.waitForTimeout(200);
  await clean(app);
});
