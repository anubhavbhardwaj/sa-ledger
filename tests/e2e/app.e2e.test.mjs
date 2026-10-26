// End-to-end checks of the app in a real browser (Chromium via Playwright), desktop and phone size.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, openApp, d, month } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { bookmarkletSource } from '../../public/fill.js';

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
  await app.go('trips'); await page.click('#tripMore'); await page.click('#tripMoreMenu [data-plan=""]');
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
  await app.go('trips'); await page.click('#tripMore'); await page.click('#tripMoreMenu [data-plan=""]');
  await page.click('[data-planwho="meet"]');
  await page.fill('#planStart', d(60)); await page.dispatchEvent('#planStart', 'change');
  await page.fill('#planEnd', d(65)); await page.dispatchEvent('#planEnd', 'change');
  await page.fill('#planNights', '3');
  await page.click('#planGo'); await page.waitForSelector('.plplace');
  const places = await app.text('#planOut');
  assert.match(places, /Athens/); assert.match(places, /Vienna/);
  assert.doesNotMatch(places, /Rome/, 'home cities are left out');
  assert.match(await app.text('.plsec >> nth=0'), /Places you can both reach(?=.*Athens)(?=.*Vienna)/, 'matched by city even when Google ids differ');
  assert.match(await app.text('.plsec >> nth=1'), /More places to check.*(Porto|Lisbon)/, 'one-sided places stay checkable');
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

test('leave planner: two 3-week India trips around holidays and the shutdown, fewest vacation days', async () => {
  const app = await openApp(), { page } = app;
  // Fixed calendar (2027) on purpose: the holidays and the shutdown are what's being tested.
  await app.seed({ trips: { e: { name: 'Easter visit', type: 'visit', traveller: 'Anubhav', start: '2027-03-25', end: '2027-03-30', vacDays: 2 } } });
  await app.go('trips'); await page.waitForSelector('.lvgrid');
  await page.evaluate(() => { const b = document.createElement('button'); b.dataset.lvplan = '2027'; document.body.append(b); b.click(); b.remove(); });
  await page.fill('#lvp-sfrom', '2027-12-24'); await page.fill('#lvp-sto', '2028-01-02'); await page.fill('#lvp-wfa', '15');
  await page.click('#lvpGo'); await page.waitForSelector('.lvpsum');
  const out = await app.text('#lvpOut');
  assert.match(out, /Vacation days in 2027 ?10 of 30/, '2 Easter + 6 shutdown + 2: ' + out.slice(0, 300));
  assert.match(out, /India, year end.*Sat 18 Dec 2027 → Sat 8 Jan 2028/);
  assert.match(out, /India, mid-year.*13 workdays to cover/);
  await page.click('#lvpCreate'); await page.waitForTimeout(200);
  await clean(app);
});

test('visualizations: spend by store, and tapping a store filters everything to it', async () => {
  const app = await openApp(), { page } = app, m = month(0);
  const e = (id, store, amount, category) => [id, { amount, date: m + '-0' + (1 + (id.charCodeAt(1) % 8)), store, category, account: 'DKB', spender: 'Anubhav', createdAt: 'x' }];
  await app.seed({ expenses: Object.fromEntries([e('e1', 'Rewe', 40, 'Groceries'), e('e2', 'Rewe', 35, 'Groceries'), e('e3', 'Lidl', 20, 'Groceries'), e('e4', 'Amazon', 90, 'Shopping')]) });
  await app.go('visualizations'); await page.click(`.chip[data-p="${m}"]`); await page.waitForSelector('#byStore .hbar');
  assert.deepEqual(await page.$$eval('#byStore .hbar .name', x => x.map(n => n.textContent)), ['Amazon', 'Rewe', 'Lidl']);
  await page.click('#byStore .hbar[data-v="Rewe"]'); await page.waitForTimeout(150);
  assert.match(await app.text('#vzBanner'), /2 transactions · €75\.00.*Store: Rewe/);
  await clean(app);
});

test('goals: monthly investing and an emergency fund, set up from the Overview', async () => {
  const app = await openApp(), { page } = app, m = month(0);
  const exp = {}; for (let k = 1; k <= 6; k++){ const mm = month(-k); exp['r' + k] = { amount: 1500, date: mm + '-05', store: 'Rent', category: 'Rent', account: 'DKB', spender: 'Anubhav', createdAt: 'x' }; exp['g' + k] = { amount: 500, date: mm + '-10', store: 'Rewe', category: 'Groceries', account: 'DKB', spender: 'Anubhav', createdAt: 'x' }; }
  exp.trip = { amount: 900, date: month(-1) + '-12', store: 'Flight', category: 'Travel', account: 'DKB', spender: 'Anubhav', tripId: 't1', createdAt: 'x' };
  await app.seed({
    accounts: { dkb: { name: 'DKB', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: d(-400) }, tr: { name: 'Trade Republic', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    checkins: { c1: { accountId: 'dkb', date: d(0), balance: 9000, createdAt: new Date().toISOString() } },
    invSnapshots: { ['tr_' + m]: { accountId: 'tr', month: m, investment: 800, value: 20000 }, ['tr_' + month(-1)]: { accountId: 'tr', month: month(-1), investment: 2100, value: 19000 } },
    expenses: exp,
  });
  await page.waitForSelector('#setupLine [data-goalnew]');
  assert.equal(await page.isHidden('#goalsP'), true, 'no empty Goals card, just a button on the set-up line');
  await page.click('[data-goalnew]'); await page.fill('#g-amount', '2000'); await page.click('#goalForm [type=submit]'); await page.waitForTimeout(150);
  await page.click('[data-goalnew]'); assert.match(await app.text('#goalHint'), /averages €2,000 a month/, 'trips left out of the average');
  await page.check('#g-accounts input[value="dkb"]'); await page.click('#goalForm [type=submit]'); await page.waitForTimeout(150);
  const g = await app.text('#goalsP');
  assert.match(g, /Invest €2,000 a month.*€800 of €2,000/); assert.match(g, /€1,200 to go/);
  assert.match(g, /Emergency fund.*€9,000 of €12,000/); assert.match(g, /1 of the last 1 months/); assert.match(g, /€3,000 to go · 6 months × €2,000/);
  await clean(app);
});

test('FIRE: the German state pension from the payslip lowers the FIRE number', async () => {
  const app = await openApp(), { page } = app, y = new Date().getFullYear();
  await app.seed({
    accounts: { tr: { name: 'Trade Republic', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    invSnapshots: { ['tr_' + month(0)]: { accountId: 'tr', month: month(0), investment: 1000, value: 50000 } },
    settings: { fire: { expenses: 36000, fireYear: y + 15, withdrawal: 4, inflation: 3, returnPct: 7 } },
  });
  await app.go('wealth'); await page.click('[data-wv="fire"]'); await page.waitForSelector('[data-pen="penGross"]');
  const before = await app.text('#wv-fire');
  assert.match(before, /Fill these in/);
  const fill = async (k, v) => { await page.fill(`[data-pen="${k}"]`, v); await page.dispatchEvent(`[data-pen="${k}"]`, 'change'); await page.waitForTimeout(120); };
  await fill('penStart', '2024-09'); await fill('penGross', '7668.75'); await fill('birthYear', '1994'); await fill('penUntil', String(y + 15));
  const t = await app.text('#wv-fire');
  // 7,668.75 × 12 / 51,944 = 1.77 points a year → €75.33 a month of pension per year paid in
  assert.match(t, /\+€75 a month of pension/); assert.match(t, /1\.77 points a year/);
  assert.match(t, /Pension from 2061/); assert.match(t, /less thanks to the pension from 2061/);
  assert.match(t, /Minimum 5 years\s*Met/);
  await clean(app);
});

test('taxes: commuting, home office, job ticket and tagged expenses add up; tapping a day and tagging save', async () => {
  const app = await openApp(), { page } = app;
  await app.seed({
    settings: { tax: { jobs: [{ name: 'Office', from: '2025-07-01', to: '2025-07-31', km: 80, mode: 'log', days: [1, 2, 3, 4] }], tickets: [{ from: '2025-07', to: '2025-07', monthly: 63 }], rate: 42 } },
    workdays: { 'anubhav_2025-07-07': { date: '2025-07-07', user: 'anubhav', where: 'home' } },
    expenses: {
      e1: { amount: 1000, date: '2025-05-10', store: 'Saturn', category: 'Electronics', account: 'DKB', spender: 'Anubhav', tax: 'work', createdAt: 'x' },
      e2: { amount: 30, date: '2025-06-01', store: 'Udemy', category: 'Education', account: 'DKB', spender: 'Anubhav', createdAt: 'x' },
    },
  });
  await app.go('wealth'); await page.click('[data-wv="tax"]'); await page.click('[data-taxyear="2025"]'); await page.waitForTimeout(150);
  let t = await app.text('#wv-tax');
  // July 2025: 19 Mon-Thu, one answered "home" → 18 office days × (20 × 0.30 + 60 × 0.38 = 28.80 €) = 518 €, minus the 63 € ticket
  assert.match(t, /Commuting allowance\s*€455/); assert.match(t, /18 office days/);
  assert.match(t, /Home office\s*€30/); assert.match(t, /5 days at 6/);
  // 455.40 + 30 + 1,000 + 16 = 1,501 €; 271 € above the flat amount × 42% = 114 €
  assert.match(t, /Work costs in total\s*€1,501/); assert.match(t, /About back\s*€114/);
  assert.match(t, /Could these count\?[\s\S]*Udemy/);
  await page.click('[data-wdcell="2025-07-08"]'); await page.waitForTimeout(150);
  t = await app.text('#wv-tax');
  assert.match(t, /17 office days/, 'tapping an assumed office day makes it a home day'); assert.match(t, /Home office\s*€36/);
  await page.click('[data-wdcell="2025-07-08"]'); await page.waitForTimeout(150);
  t = await app.text('#wv-tax');
  assert.match(t, /17 office days/); assert.match(t, /Home office\s*€30/, 'then away: no commute, no home office');
  await page.selectOption('[data-taxtag="e2"]', 'training'); await page.waitForTimeout(200);
  assert.match(await app.text('#wv-tax'), /Training & books/);
  await clean(app);
});

test('taxes: a payslip typed in gives the return estimate (tax due vs wage tax withheld)', async () => {
  const app = await openApp(), { page } = app;
  await app.go('wealth'); await page.click('[data-wv="tax"]'); await page.click('[data-taxyear="2025"]'); await page.waitForTimeout(100);
  assert.match(await app.text('#wv-tax'), /Upload this year’s payslips/);
  await page.click('#psAddHand'); await page.waitForSelector('#psDlg[open]');
  const set = async (k, v) => page.fill(`#psDlg [data-ps="0"][data-psk="${k}"]`, v);
  await set('month', '2025-12'); await set('employer', 'Test GmbH');
  for (const [k, v] of Object.entries({ taxGross: '92025', lst: '21000', soli: '0', kist: '0', rv: '8558', av: '1196', kv: '6103', pv: '1674' })) await set(k, v);
  await page.click('#psSave'); await page.waitForTimeout(250);
  const t = await app.text('#wv-tax');
  // 92,025 − 1,230 − (8,558 + 0.96 × 6,103 + 1,674 + 36) = 74,668 taxable → 20,448 income tax (2025) + 59.26 Soli; 21,000 withheld
  assert.match(t, /Taxable income\s*€74,668/); assert.match(t, /About\s*€493\s*back/);
  assert.match(t, /Back, from payslips|Upload payslips/);
  await clean(app);
});

test('taxes: figure check flags missing insurance and doubled months; ways to save feed the estimate', async () => {
  const app = await openApp(), { page } = app;
  const base = { user: 'anubhav', taxGross: 7669, lst: 1650, soli: 0, kist: 0, rv: 713, av: 100, kv: 509, pv: 140 };
  await app.seed({ payslips: {
    'anubhav_2025-11_acme': { ...base, month: '2025-11', employer: 'ACME GmbH' },
    'anubhav_2025-12_acme': { ...base, month: '2025-12', employer: 'Acme', kv: null, pv: null, ytd: { taxGross: 92025, lst: 19800, soli: 0, kist: 0, rv: 8556, av: 1200 } },
  } });
  await app.go('wealth'); await page.click('[data-wv="tax"]'); await page.click('[data-taxyear="2025"]'); await page.waitForTimeout(150);
  let t = await app.text('#wv-tax');
  assert.match(t, /Acme: health and care insurance weren’t found on Dec 2025, so they’re estimated/);
  assert.match(t, /Acme\s*2 slips · year-to-date on Dec 2025\s*€92,025/, 'one employer despite the name variants, year-to-date used');
  const before = +t.match(/(?:About|You’d pay about)\s*€([\d,]+)/)[1].replace(/,/g, '') * (/You’d pay about/.test(t) ? -1 : 1);
  await page.click('summary:has-text("Support for your parents in India")');
  await page.fill('[data-sv="parents"][data-svk="amount"]', '9000'); await page.dispatchEvent('[data-sv="parents"][data-svk="amount"]', 'change'); await page.waitForTimeout(200);
  t = await app.text('#wv-tax');
  const after = +t.match(/(?:About|You’d pay about)\s*€([\d,]+)/)[1].replace(/,/g, '') * (/You’d pay about/.test(t) ? -1 : 1);
  // capped at 6,174 € for both parents: at 42% plus Soli, about 2,600 to 2,900 € more back
  assert.ok(after - before > 2500 && after - before < 3000, `parents support adds 42% of 6,174 € plus Soli (got ${after - before})`);
  assert.match(t, /Support for your parents in India.*Claiming/);
  await clean(app);
});

test('taxes: one January slip with a bonus is not projected for the whole year', async () => {
  const app = await openApp(), { page } = app;
  await app.seed({ payslips: { 'anubhav_2025-01_mms': { month: '2025-01', employer: 'MediaMarktSaturn', user: 'anubhav', taxGross: 15220, lst: 4600, soli: 121, kist: 0, rv: 1178, av: 200 } } });
  await app.go('wealth'); await page.click('[data-wv="tax"]'); await page.click('[data-taxyear="2025"]'); await page.waitForTimeout(150);
  let t = await app.text('#wv-tax');
  assert.match(t, /probably includes a one-off payment/); assert.match(t, /projected from one payslip/); assert.match(t, /estimated from the 2026 rates/); assert.match(t, /payslips for Jan 2025, but no workplace covers that month/);
  await page.click('summary:has-text("Payslips (1)")'); await page.click('[data-psedit="anubhav_2025-01_mms"]'); await page.fill('#psDlg [data-ps="0"][data-psk="oneOff"]', '7550'); await page.click('#psSave'); await page.waitForTimeout(250);
  t = await app.text('#wv-tax');
  assert.doesNotMatch(t, /probably includes a one-off/);
  // 15,220 + 11 × 7,670 = 99,590 taxable pay, instead of 12 × 15,220
  assert.match(t, /Taxable pay\s*€99,590/);
  await clean(app);
});

test('sync: an entry saved only on this device is marked, and reconnecting uploads it', async () => {
  const app = await openApp(), { page } = app;
  await page.evaluate(() => { window.__pending = { 'expenses/p1': true }; });
  await app.seed({ expenses: { p1: { amount: 9.5, date: d(0), store: 'Bakery', category: 'Groceries', account: 'DKB', spender: 'Anubhav', createdAt: 'x' } } });
  await app.go('transactions'); await page.waitForTimeout(200);
  assert.match(await app.text('#page-transactions'), /Bakery not synced/);
  assert.match(await app.text('#syncBtn'), /1 not uploaded/);
  await page.click('#syncBtn'); await page.waitForTimeout(250);
  assert.doesNotMatch(await app.text('#page-transactions'), /not synced/);
  assert.equal(await page.isHidden('#syncBtn'), true);
  assert.equal(await page.evaluate(() => window.__netKicks), 1);
  await clean(app);
});

test('sync check: compares this device with the server', async () => {
  const app = await openApp(), { page } = app;
  await app.seed({ expenses: { s1: { amount: 28.98, date: d(-1), store: 'Pewex', category: 'Groceries', account: 'Wise', spender: 'Sulekha', createdAt: 'x', createdBy: 'sulekha' } } });
  await page.click('#profBtn'); await page.click('[data-pm="health"]'); await page.click('[data-hl="sync"]'); await page.waitForSelector('#syDlg[open]');
  assert.match(await app.text('#syBody'), /Nothing waiting to upload/);
  await page.click('#syCheck'); await page.waitForTimeout(200);
  assert.match(await app.text('#syBody'), /expenses \(last 30 days\): 1 on the server, 1 on this device · match/);
  await clean(app);
});

test('bookings: a large camera photo is scaled down and read', async () => {
  const app = await openApp({ mobile: true }), { page } = app;
  const sent = [];
  await page.route('http://app.test/api/extract', async r => { sent.push(r.request().postDataJSON()); await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bookings: [{ type: 'hotel', title: 'Hotel Test, Rome', start: '2027-03-25', end: '2027-03-28', price: 300, currency: 'EUR' }] }) }); });
  await app.go('trips'); await page.click('#page-trips [data-addbk]'); await page.waitForSelector('#bkDlg[open]');
  assert.match(await app.text('#bkDrop'), /Take photo/);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const g = c.getContext('2d'), img = g.createImageData(4000, 3000);
    for (let i = 0; i < img.data.length; i++) img.data[i] = Math.random() * 255; g.putImageData(img, 0, 0);
    const b = await new Promise(r => c.toBlob(r, 'image/png')), dt = new DataTransfer();
    dt.items.add(new File([b], 'IMG_1.png', { type: 'image/png' }));
    const inp = document.getElementById('bkCam'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => /Hotel Test/.test(document.getElementById('bkReview')?.textContent || ''), null, { timeout: 20000 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].image || '', /^data:image\/jpeg;base64,/, 'the photo goes to the reader as a JPEG');
  await clean(app);
});

test('sync watchdog: data that stays "not live" gets two reconnects, then safe mode', async () => {
  const app = await openApp({ init: 'window.__staleMs = 300; window.__offline = true;' }), { page } = app;
  await app.seed({ expenses: { e1: { amount: 1, date: d(0), store: 'X', category: 'Groceries', account: 'DKB', spender: 'Anubhav', createdAt: 'x' } } });
  await page.waitForFunction(() => { try { return localStorage.getItem('fsSafe') === '1'; } catch { return false; } }, null, { timeout: 10000 });
  await page.waitForLoadState('load'); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => localStorage.getItem('fsSafe')), '1');
  assert.deepEqual(app.errors, []);
  await app.close();
});

test('smart suggestions: the replay on your data shows rule vs model', async () => {
  const app = await openApp(), { page } = app, exp = {};
  for (let k = 0; k < 120; k++){
    const g = k % 3 === 0, mm = month(-Math.floor((120 - k) / 12));
    exp['x' + k] = { amount: g ? 30 : 4, date: mm + '-' + String(1 + k % 27).padStart(2, '0'), store: g ? ['Rewe City', 'REWE Markt', 'Rewe To Go'][k % 3 === 0 ? (k / 3) % 3 : 0] : ['Bar Roma', 'Bar Centrale', 'Bar Sport'][k % 3], category: g ? 'Groceries' : 'Eating Out', account: g ? 'DKB' : 'Wise', spender: 'Anubhav', createdAt: 'x' };
  }
  await app.seed({ expenses: exp });
  await page.click('#profBtn'); await page.click('[data-pm="health"]'); await page.click('[data-hl="smart"]'); await page.waitForSelector('#smDlg[open]');
  await page.waitForFunction(() => /Today’s rule/.test(document.getElementById('smBody').textContent));
  const t = await app.text('#smBody');
  assert.match(t, /Today’s rule\s*\d+%/); assert.match(t, /Combined: rule, then model/); assert.match(t, /would take no typing at all/); assert.match(t, /Stores never entered before/);
  await clean(app);
});

test('add form: category filled from the store or offered as 3 choices', async () => {
  const app = await openApp(), { page } = app, exp = {};
  for (let k = 0; k < 60; k++){
    const g = k % 2 === 0, mm = month(-Math.floor((60 - k) / 10));
    exp['y' + k] = { amount: g ? 30 : 4, date: mm + '-' + String(1 + k % 27).padStart(2, '0'), store: g ? 'Rewe City' : 'Bar Centrale', category: g ? 'Groceries' : 'Eating Out', account: g ? 'DKB' : 'Wise', spender: 'Anubhav', createdAt: 'x' };
  }
  await app.seed({ expenses: exp });
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.fill('#f-amount', '12'); await page.fill('#f-store', 'Rewe To Go'); await page.dispatchEvent('#f-store', 'change'); await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#f-category'), 'Groceries');
  assert.match(await app.text('#catChips'), /Filled in/);
  await page.fill('#f-store', 'Trattoria da Enzo'); await page.dispatchEvent('#f-store', 'change'); await page.waitForTimeout(400);
  assert.equal(await page.inputValue('#f-category'), 'Eating Out', 'starter list for a new restaurant');
  await page.fill('#f-store', 'Xyzzy Qwerty'); await page.dispatchEvent('#f-store', 'change'); await page.waitForTimeout(400);
  assert.match(await app.text('#catChips'), /Pick one/);
  assert.equal(await page.inputValue('#f-category'), '', 'an unsure guess is not left filled in');
  await page.click('#catChips [data-catchip="Groceries"]');
  assert.equal(await page.inputValue('#f-category'), 'Groceries');
  await clean(app);
});

test('overview: recurring charges with next date, price change and a missed one', async () => {
  const app = await openApp(), { page } = app, exp = {};
  for (let k = 6; k >= 1; k--){
    exp['n' + k] = { amount: k <= 2 ? 15.99 : 13.99, date: month(-k + 1) + '-01', store: 'Netflix', category: 'Subscriptions', account: 'Wise', spender: 'Anubhav', createdAt: 'x' };
    exp['v' + k] = { amount: 39.99, date: month(-k) + '-02', store: 'Vodafone', category: 'Phone/Internet', account: 'DKB', spender: 'Anubhav', createdAt: 'x' };
  }
  await app.seed({ expenses: exp });
  await app.go('overview'); await page.waitForSelector('#recurP:not([hidden])');
  const t = await app.text('#recurP');
  assert.match(t, /Recurring charges/); assert.match(t, /Netflix every month/); assert.match(t, new RegExp('price up from €13\\.99 \\(1 ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+month(-1).slice(5, 7) - 1] + '\\)'));
  assert.match(t, /Vodafone/);
  await clean(app);
});

test('people & details: save a person, check a photo, typos flagged', async () => {
  const app = await openApp({ init: `window.__ocrStub = async () => ({ text: 'Passenger 1\\nMr ANUBAV BHARDWAJ\\nEmail anubhav.iiitb@gmail.com', confidence: 91 });` }), { page } = app;
  await app.go('trips'); await page.click('#tripMore'); await page.click('#tripMoreMenu [data-openpeople]'); await page.waitForSelector('#ppDlg[open]');
  await page.click('#ppAdd');
  await page.fill('#pp-first', 'Anubhav'); await page.fill('#pp-last', 'Bhardwaj'); await page.selectOption('#pp-gender', 'male'); await page.fill('#pp-email', 'anubhav.iiitb@gmail.com');
  await page.click('#ppSave'); await page.waitForTimeout(200);
  assert.match(await app.text('#ppBody'), /Anubhav Bhardwaj\s*Me/);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200; c.getContext('2d').fillRect(0, 0, 10, 10);
    const b = await new Promise(r => c.toBlob(r, 'image/png')), dt = new DataTransfer(); dt.items.add(new File([b], 'form.png', { type: 'image/png' }));
    const i = document.getElementById('ppFile'); i.files = dt.files; i.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => /to fix|match/.test(document.getElementById('ppBody').textContent));
  const t = await app.text('#ppBody');
  assert.match(t, /1 to fix/); assert.match(t, /The form shows “anubav”, should be Anubhav/); assert.match(t, /Bhardwaj matches/); assert.match(t, /anubhav\.iiitb@gmail\.com matches/);
  await clean(app);
});

test('people & details: passport number and expiry, shortened in the list, checked on a photo, warning on the Overview', async () => {
  const exp = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10), [y, m, d] = exp.split('-');
  const app = await openApp({ init: `window.__ocrStub = async () => ({ text: 'Mr ANUBHAV BHARDWAJ\\nPassport number Z1234576\\nExpiry ${d}.${m}.${y}', confidence: 90 });` }), { page } = app;
  await app.go('trips'); await page.click('#tripMore'); await page.click('#tripMoreMenu [data-openpeople]'); await page.waitForSelector('#ppDlg[open]');
  await page.click('#ppAdd');
  await page.fill('#pp-first', 'Anubhav'); await page.fill('#pp-last', 'Bhardwaj'); await page.fill('#pp-passport', 'z123 4567'); await page.fill('#pp-passportExp', exp);
  await page.click('#ppSave'); await page.waitForTimeout(200);
  const list = await app.text('#ppBody');
  assert.match(list, /Z••••567/); assert.doesNotMatch(list, /Z1234567/); assert.match(list, /under 6 months/);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200; c.getContext('2d').fillRect(0, 0, 10, 10);
    const b = await new Promise(r => c.toBlob(r, 'image/png')), dt = new DataTransfer(); dt.items.add(new File([b], 'form.png', { type: 'image/png' }));
    const i = document.getElementById('ppFile'); i.files = dt.files; i.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => /to fix|match/.test(document.getElementById('ppBody').textContent));
  const t = await app.text('#ppBody');
  assert.match(t, /1 to fix/); assert.match(t, /The form shows “Z1234576”, should be Z1234567/); assert.match(t, /Passport expiry: .* matches/);
  await page.click('#ppClose');
  assert.match(await app.text('#page-trips [data-ppbar]'), /Passport to look at/, 'also on the Travel tab');
  await app.go('overview'); await page.waitForTimeout(100);
  assert.equal(await page.isHidden('#ppBar'), false); assert.match(await app.text('#ppBar'), /Passport to look at[\s\S]*Anubhav Bhardwaj: Passport expires/);
  await clean(app);
});

// A booking site in its own tab: serves a fixture form, runs the bookmark there (clipboard blocked, so it asks to paste).
async function bookingPage(app, file, payload){
  const page = await app.ctx.newPage();
  await page.route('http://booking.test/**', r => r.fulfill({ contentType: 'text/html', body: readFileSync(new URL('./fixtures/' + file, import.meta.url)) }));
  await page.goto('http://booking.test/');
  page.on('dialog', dlg => dlg.type() === 'prompt' ? dlg.accept(payload) : dlg.dismiss());
  await page.evaluate(src => (0, eval)(src), bookmarkletSource());
  await page.waitForSelector('#sa-fill-result');
  return page;
}
const val = (page, sel) => page.$eval(sel, el => el.type === 'radio' ? String(el.checked) : el.value);

test('fill a form: copy two people in the app, the bookmark fills an airline form by passenger, contact and leaves payment alone', async () => {
  // The test server is plain http, where browsers have no clipboard: a stand-in keeps what the app copies.
  const app = await openApp({ init: `Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__clip = t; }, readText: async () => window.__clip || '' } });` }), { page } = app;
  await app.seed({ settings: { people: { items: [
    { id: 'a', relation: 'Me', first: 'Anubhav', last: 'Bhardwaj', gender: 'male', passport: 'Z1234567', passportExp: '2031-03-11', email: 'anubhav@example.com', phone: '+49 151 23425746' },
    { id: 's', relation: 'Fiancée', first: 'Sulekha', last: 'Sharma', gender: 'female', passport: 'X7654321', passportExp: '2030-08-05', email: 'sulekha@example.com', phone: '+39 333 1234567' }] } } });
  await app.go('trips'); await page.click('#tripMore'); await page.click('#tripMoreMenu [data-openpeople]'); await page.waitForSelector('#ppDlg[open]');
  await page.click('#ppFill');
  assert.match(await app.text('#ppBody'), /1\s*Anubhav Bhardwaj Me/);
  await page.click('[data-ppsel="s"]');
  assert.match(await app.text('#ppBody'), /2\s*Sulekha Sharma/);
  await page.click('#ppCopyForm');
  const copied = await page.evaluate(() => window.__clip);
  assert.deepEqual(JSON.parse(copied).people.map(p => p.first), ['Anubhav', 'Sulekha']);
  assert.match(await page.$eval('#ppBm', a => a.getAttribute('href')), /^javascript:/);

  const site = await bookingPage(app, 'booking-form.html', copied);
  assert.equal(await val(site, '#t1'), 'MR'); assert.equal(await val(site, '#f1'), 'Anubhav'); assert.equal(await val(site, '#l1'), 'Bhardwaj');
  assert.equal(await val(site, '#pn1'), 'Z1234567'); assert.equal(await val(site, '#pe1'), '2031-03-11');
  assert.equal(await val(site, '[name="pax[0].dob"]'), '', 'date of birth is not saved, so left empty');
  assert.equal(await val(site, 'input[value=frau]'), 'true'); assert.equal(await val(site, 'input[value=herr]'), 'false');
  assert.equal(await val(site, '[name=p2vn]'), 'Sulekha'); assert.equal(await val(site, '[name=p2nn]'), 'Already', 'a filled field is left alone');
  assert.equal(await val(site, '[name=p2pass]'), 'X7654321');
  assert.equal(await val(site, '[name=p2expDay]'), '5'); assert.equal(await val(site, '[name=p2expMonth]'), 'm8'); assert.equal(await val(site, '[name=p2expYear]'), '2030');
  assert.equal(await val(site, '[name=p3f]'), '', 'no third person chosen');
  assert.equal(await val(site, '[name=email]'), 'anubhav@example.com'); assert.equal(await val(site, '[name=email2]'), 'anubhav@example.com');
  assert.equal(await val(site, '[name=cc]'), 'DE'); assert.equal(await val(site, '[name=mobile]'), '15123425746');
  for (const n of ['ccname', 'ccnum', 'ccexp', 'emf']) assert.equal(await val(site, `[name=${n}]`), '', n + ' stays empty');
  assert.ok((await site.evaluate(() => window.events)).includes('pax[0].firstName'), 'input events fire for sites built with React or similar');
  const box = (await site.textContent('#sa-fill-result')).replace(/\s+/g, ' ');
  assert.match(box, /filled 15 fields/); assert.match(box, /Anubhav \(9\), Sulekha \(6\)/); assert.match(box, /1 field that already had something was left alone/);
  await clean(app);
});

test('fill a form: an Italian hotel form without headings, date format from the placeholder, a note when the format is unknown', async () => {
  const app = await openApp();
  const payload = JSON.stringify({ saLedger: 1, people: [
    { first: 'Anubhav', last: 'Bhardwaj', gender: 'male', passport: 'Z1234567', passportExp: '2031-03-11', email: 'anubhav@example.com', phone: '+49 151 23425746' },
    { first: 'Sulekha', last: 'Sharma', gender: 'female', passport: 'X7654321', passportExp: '2030-08-05', email: 'sulekha@example.com', phone: '+39 333 1234567' }] });
  const site = await bookingPage(app, 'hotel-form.html', payload);
  assert.equal(await val(site, '[name=sal1]'), 'Sig.'); assert.equal(await val(site, '[name=sal2]'), 'Sig.ra');
  assert.equal(await val(site, '[name=nome1]'), 'Anubhav'); assert.equal(await val(site, '[name=cognome1]'), 'Bhardwaj');
  assert.equal(await val(site, '[name=nome2]'), 'Sulekha'); assert.equal(await val(site, '[name=cognome2]'), 'Sharma');
  assert.equal(await val(site, '[name=doc1]'), 'Z1234567'); assert.equal(await val(site, '[name=doc2]'), 'X7654321');
  assert.equal(await val(site, '[name=scad1]'), '11/03/2031'); assert.equal(await val(site, '[name=scad2]'), '05/08/2030');
  assert.equal(await val(site, '[name=contactEmail]'), 'anubhav@example.com'); assert.equal(await val(site, '[name=tel]'), '+4915123425746');
  assert.match(await site.textContent('#sa-fill-result'), /Passport expiry for Sulekha typed as 05\/08\/2030 \(day first\): check the site’s date format/);
  await clean(app);
});

test('fill a form: a ticket form with "Name" and "Surname", "contact" in the field ids, a Contacts link in the site menu', async () => {
  const app = await openApp();
  const payload = JSON.stringify({ saLedger: 1, people: [
    { first: 'Anubhav', last: 'Bhardwaj', gender: 'male', passport: 'Z1234567', passportExp: '2031-03-11' },
    { first: 'Sulekha', last: 'Sharma', gender: 'female', passport: 'X7654321', passportExp: '2030-08-05' }] });
  const site = await bookingPage(app, 'ticket-form.html', payload);
  assert.equal(await val(site, '#mat-input-0'), 'Anubhav'); assert.equal(await val(site, '#mat-input-1'), 'Bhardwaj'); assert.equal(await val(site, '#mat-input-3'), 'Z1234567');
  assert.equal(await val(site, '#mat-input-4'), 'Sulekha'); assert.equal(await val(site, '#mat-input-5'), 'Sharma'); assert.equal(await val(site, '#mat-input-7'), 'X7654321');
  const box = (await site.textContent('#sa-fill-result')).replace(/\s+/g, ' ');
  assert.match(box, /Anubhav \(3\), Sulekha \(3\).*Form filler v3/);
  assert.match(box, /What went where\s*name → Anubhav\s*surname → Anubhav.*name → Sulekha\s*surname → Sulekha/);
  await site.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } } }); });
  await site.click('#sa-fill-result details summary'); await site.click('text=Copy report');
  const report = await site.evaluate(() => window.__copied);
  assert.ok(report && !/Anubhav|Sulekha|Bhardwaj|Sharma|Z1234567|X7654321/.test(report), 'the report has no personal details');
  assert.deepEqual(JSON.parse(report).fields.filter(f => f.kind === 'first').map(f => f.to), ['person 1', 'person 2']);
  await clean(app);
});

test('menu: four items; Data & backup and App status open their own screens; Travel is a tab with forwarded bookings on it', async () => {
  for (const mobile of [false, true]){
    const app = await openApp({ mobile }), { page } = app;
    await page.click('#profBtn');
    const items = await page.$$eval('#profMenu .pm-item:not([hidden])', els => els.map(e => e.querySelector('span').textContent));
    assert.deepEqual(items, ['Notifications', 'Data & backup', 'App status', 'Sign out']);
    await page.click('[data-pm="data"]'); await page.waitForSelector('#dataDlg[open]');
    assert.match(await app.text('#dataDlg'), /Import CSV.*Export CSV.*Download backup.*Restore from backup/);
    await page.click('#dataDlg button[type=submit]');
    await page.click('#profBtn'); await page.click('[data-pm="health"]'); await page.waitForSelector('#hlDlg[open]');
    assert.match(await app.text('#hlDlg'), /App status.*Sync check.*Smart suggestions/);
    await page.click('#hlDlg button[type=submit]');
    await page.click(mobile ? '.bottomnav a[href="#trips"]' : '.tabs a[href="#trips"]');
    await page.waitForSelector('#page-trips:not([hidden])');
    assert.match(await app.text('#page-trips .pagehead'), /Travel.*More.*\+ Booking.*\+ New trip/);
    assert.equal(await page.isHidden('#tripMoreMenu'), true);
    await page.click('#tripMore'); assert.match(await app.text('#tripMoreMenu'), /Plan a trip.*Repeat last visit.*People & details/);
    await page.click('#page-trips h1'); assert.equal(await page.isHidden('#tripMoreMenu'), true, 'closes on a click elsewhere');
    assert.equal(await page.$$eval('#page-trips [data-back]', els => els.filter(e => e.closest('#tripListView')).length), 0, 'no Back button on a tab');
    await app.seed({ bookingInbox: { m1: { subject: 'Your flight', receivedAt: new Date().toISOString(), from: 'x@y.z' } } });
    await page.waitForTimeout(200);
    assert.equal(await page.isHidden(mobile ? '#tbadge2' : '#tbadge'), false); assert.equal(await page.textContent(mobile ? '#tbadge2' : '#tbadge'), '1');
    assert.equal(await page.isHidden('#profBadge'), true, 'the avatar badge is only for app problems');
    await clean(app);
  }
});

test('phone: no page or dialog is wider than the screen', async () => {
  const app = await openApp({ mobile: true }), { page } = app;
  const ids = await page.$$eval('dialog', ds => ds.map(d => d.id));
  const wide = [];
  for (const id of ids) wide.push(await page.evaluate(id => { const d = document.getElementById(id); try { d.showModal(); } catch { return null; } const r = d.scrollWidth > d.clientWidth + 1 ? id : null; d.close(); return r; }, id));
  for (const h of ['overview', 'transactions', 'visualizations', 'wealth', 'trips']){
    await app.go(h); await page.waitForTimeout(200);
    wide.push(await page.evaluate(h => document.documentElement.scrollWidth > innerWidth ? 'page ' + h : null, h));
  }
  assert.deepEqual(wide.filter(Boolean), []);
  await clean(app);
});

test('phone layout: Ask AI in the top bar, the + button steps aside while scrolling down, set-up items on one line', async () => {
  const app = await openApp({ mobile: true }), { page } = app;
  const ex = {}; for (let i = 0; i < 40; i++) ex['e' + i] = { amount: 10 + i, date: d(-i % 20), store: 'Store ' + (i % 7), category: 'Groceries', account: 'DKB', spender: 'Anubhav', createdAt: 'x' };
  await app.seed({ expenses: ex }); await page.waitForTimeout(300);
  assert.ok(await page.$('.appbar #aiBtn'), 'Ask AI sits in the top bar');
  assert.match(await app.text('#setupLine'), /Not set up yet:\s*Goals/);
  assert.match(await app.text('#budgetPanel'), /Envelopes.*Set up envelopes/, 'envelopes in place of budgets'); assert.equal(await page.isHidden('#goalsP'), true);
  assert.equal(await page.$$eval('#recent .r', r => r.length), 5);
  await page.evaluate(() => scrollTo(0, 600)); await page.waitForTimeout(150);
  assert.match(await page.getAttribute('#fab', 'class'), /away/);
  await page.evaluate(() => scrollTo(0, 300)); await page.waitForTimeout(150);
  assert.doesNotMatch(await page.getAttribute('#fab', 'class'), /away/);
  await clean(app);
});

test('send to India: a new device starts from the last send saved in the database, not empty', async () => {
  const app = await openApp(), { page } = app, at = '2026-10-01T10:00:00.000Z', c = 'Send to India';
  await page.evaluate(() => localStorage.removeItem('sendChain'));
  await app.seed({
    accounts: { a: { name: 'Giro', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, b: { name: 'Wise', type: 'bank', currency: 'EUR', owner: 'Anubhav' },
      c: { name: 'HDFC NRE', type: 'bank', currency: 'INR', owner: 'Anubhav' }, d: { name: 'ULIP Maxlife', type: 'investment', invType: 'ulip', currency: 'INR', owner: 'Anubhav' } },
    transfers: {
      t0: { amount: 100, date: '2026-09-01', from: 'Giro', to: 'Wise', comment: c, createdAt: '2026-09-01T09:00:00.000Z', createdBy: 'anubhav' },
      t1: { amount: 500, date: '2026-10-01', from: 'Giro', to: 'Wise', comment: c, createdAt: at, createdBy: 'anubhav' },
      t2: { amount: 497, date: '2026-10-01', from: 'Wise', to: 'HDFC NRE', currency: 'INR', origAmount: 52000, fxRate: 0.00956, comment: c, createdAt: at, createdBy: 'anubhav' },
      t3: { amount: 96, date: '2026-10-01', from: 'HDFC NRE', to: 'ULIP Maxlife', currency: 'INR', origAmount: 10000, fxRate: 0.00956, comment: c, createdAt: at, createdBy: 'anubhav' } } });
  await page.waitForTimeout(200);
  await app.go('wealth'); await page.evaluate(() => document.querySelector('[data-sendindia]').click()); await page.waitForSelector('#sendDlg[open]');
  assert.equal(await page.inputValue('#si-from'), 'Giro'); assert.equal(await page.inputValue('#si-via'), 'Wise'); assert.equal(await page.inputValue('#si-to'), 'HDFC NRE');
  assert.equal(await page.inputValue('#siSplits [data-si="to"]'), 'ULIP Maxlife'); assert.equal(await page.inputValue('#siSplits [data-si="amt"]'), '10000');
  await page.fill('#si-from', ''); await page.click('#si-from');
  assert.match(await app.text('#sendDlg .combo:has(#si-from) .cbox'), /Giro.*HDFC NRE.*ULIP Maxlife.*Wise|Giro.*Wise/, 'the list offers your accounts');
  await clean(app);
});

test('envelopes (YNAB way): budget accounts only, groups and subcategories, assign, cover, move, savings', async () => {
  const app = await openApp(), { page } = app, td = d(0), now = new Date().toISOString();
  await app.seed({
    settings: { budgets: { items: [{ c: 'Groceries', a: 300 }, { c: 'Eating out', a: 100 }], total: 400 } },
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: d(-90) }, wc: { name: 'Wise Common', type: 'bank', currency: 'EUR', owner: 'Shared', createdAt: d(-90) },
      ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha', createdAt: d(-90) }, cc: { name: 'DB Card', type: 'card', currency: 'EUR', owner: 'Anubhav', createdAt: d(-90) },
      sc: { name: 'Scalable', type: 'investment', currency: 'EUR', owner: 'Anubhav', createdAt: d(-90) }, nre: { name: 'HDFC NRE', type: 'bank', currency: 'INR', owner: 'Anubhav', createdAt: d(-90) } },
    checkins: { k1: { accountId: 'db', date: d(-10), balance: 1500, createdAt: now }, k2: { accountId: 'wc', date: d(-10), balance: 500, createdAt: now },
      k3: { accountId: 'ws', date: d(-10), balance: 300, createdAt: now }, k4: { accountId: 'cc', date: d(-10), balance: -200, createdAt: now } },
    income: { i1: { amount: 2000, date: td, source: 'Salary', category: 'Salary', account: 'Deutsche Bank', earner: 'Anubhav', createdAt: now } },
    expenses: { e1: { amount: 120, date: td, store: 'Trattoria', category: 'Eating out', account: 'Wise Common', spender: 'Sulekha', createdAt: now },
      e2: { amount: 80, date: td, store: 'Rewe', category: 'Groceries', subcategory: 'Supermarket', account: 'DB Card', spender: 'Anubhav', createdAt: now },
      e3: { amount: 999, date: td, store: 'Shop', category: 'Shopping', account: 'HDFC NRE', spender: 'Anubhav', createdAt: now } },
    transfers: { t1: { amount: 200, date: td, from: 'Deutsche Bank', to: 'Scalable', createdAt: now } } });
  await page.waitForTimeout(300);
  await page.click('#budgetPanel [data-envsetup]'); await page.waitForSelector('#envSetupDlg[open]');
  const ticked = await page.$$eval('#esAccs [data-esacc]:checked', els => els.map(e => e.value));
  assert.deepEqual(ticked.sort(), ['DB Card', 'Deutsche Bank', 'Wise Common', 'Wise Sulekha']);
  assert.match(await app.text('#esTotal'), /Starting Ready to Assign: €2,100\.00/, '1500 + 500 + 300 − 200 card debt');
  await page.click('#esSave'); await page.waitForTimeout(250);
  let t = await app.text('#budgetPanel');
  assert.match(t, /Ready to Assign\s*€4,100\.00/, 'starting money + salary into Deutsche Bank');
  assert.doesNotMatch(t, /Shopping/, 'spending on other accounts is left out');
  await page.click('[data-envtargets]'); await page.waitForTimeout(200);
  t = await app.text('#budgetPanel');
  assert.match(t, /Ready to Assign\s*€4,000\.00/);
  assert.match(t, /Eating out.*General\s*€100\s*−€120\.00\s*−€20\.00/, 'group, envelope, assigned, activity, available');
  assert.match(t, /Supermarket\s*€0\s*−€80\.00\s*−€80\.00/); assert.match(t, /Savings.*Investing & India\s*€0\s*−€200\.00/);
  assert.match(await app.text('#kpis'), /Ready to assign\s*€4,000\.00.*3 overspent/);
  await page.click('[data-envkey="c_Eating%20out_"]'); await page.waitForSelector('#envAsgDlg[open]');
  await page.click('#eaQuick >> text=Cover overspending'); assert.equal(await page.inputValue('#ea-amt'), '120.00');
  await page.click('#envAsgForm [type=submit]'); await page.waitForTimeout(200);
  assert.match(await app.text('#budgetPanel'), /Ready to Assign\s*€3,980\.00/);
  await page.click('[data-envmove]'); await page.waitForSelector('#envMoveDlg[open]');
  await page.selectOption('#em-to', 'c_Groceries_Supermarket'); await page.fill('#em-amt', '80'); await page.click('#envMoveForm [type=submit]'); await page.waitForTimeout(200);
  t = await app.text('#budgetPanel');
  assert.match(t, /Ready to Assign\s*€3,900\.00/); assert.match(t, /Supermarket\s*€80\s*−€80\.00\s*€0\.00/);
  await clean(app);
});
