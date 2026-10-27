// End-to-end checks of the app in a real browser (Chromium via Playwright), desktop and phone size.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, openApp, d, month } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { bookmarkletSource } from '../../public/fill.js';

before(start);
after(stop);

// Every test ends with: no JavaScript errors on the page, and no write the database rules would refuse.
const addDaysT = (s, k) => { const x = new Date(s + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
// The Budget page's text without the owner letters in front of envelope names (A, S, C), for the money checks.
const envText = app => app.page.$eval('#budgetPanel', el => { const c = el.cloneNode(true); c.querySelectorAll('.ob, .oblegend').forEach(x => x.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); });
async function clean(app){
  assert.deepEqual(app.errors, [], 'page errors');
  assert.deepEqual(await app.ruleErrors(), [], 'writes the Firestore rules would refuse');
  await app.close();
}

for (const mobile of [false, true]) test(`every page opens without errors (${mobile ? 'phone' : 'desktop'})`, async () => {
  const app = await openApp({ mobile });
  await app.seed({ expenses: { e1: { amount: 12.5, date: d(0), store: 'Rewe', category: 'Groceries', account: 'DKB', spender: 'Anubhav', createdAt: 'x' } } });
  for (const h of ['overview', 'transactions', 'budget', 'charts', 'wealth', 'trips']){ await app.go(h); await app.page.waitForTimeout(150); }
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

test('what if: hidden while envelopes are on (envelopes plan categories ahead)', async () => {
  const app = await openApp(), { page } = app, m = month(-1);
  await app.seed({ expenses: { e1: { amount: 900, date: m + '-10', store: 'Venue', category: 'Wedding', account: 'DKB', spender: 'Anubhav', createdAt: 'x' } } });
  await app.go('charts'); await page.click(`.chip[data-p="${m}"]`); await page.waitForTimeout(150);
  assert.equal(await page.isHidden('#wiPanel'), true); assert.equal(await page.isVisible('#byCategory'), true);
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
  for (const h of ['overview', 'transactions', 'budget', 'charts', 'wealth', 'trips']){
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
  assert.match(await app.text('#kpis'), /Ready to assign.*Set up envelopes/, 'envelopes in place of budgets'); assert.equal(await page.isHidden('#goalsP'), true);
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

test('envelopes: your own categories (Fixed, Flexible) and envelopes fed by chosen subcategories; not assigned; assign, cover, move', async () => {
  const app = await openApp(), { page } = app, td = d(0), now = new Date().toISOString();
  await app.seed({
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: d(-90) }, wc: { name: 'Wise Common', type: 'bank', currency: 'EUR', owner: 'Shared', createdAt: d(-90) },
      ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha', createdAt: d(-90) }, cc: { name: 'DB Card', type: 'card', currency: 'EUR', owner: 'Anubhav', createdAt: d(-90) },
      sc: { name: 'Scalable', type: 'investment', currency: 'EUR', owner: 'Anubhav', createdAt: d(-90) }, nre: { name: 'HDFC NRE', type: 'bank', currency: 'INR', owner: 'Anubhav', createdAt: d(-90) } },
    checkins: { k1: { accountId: 'db', date: addDaysT(month(0) + '-01', -5), balance: 1500, createdAt: now }, k2: { accountId: 'wc', date: addDaysT(month(0) + '-01', -5), balance: 500, createdAt: now },
      k3: { accountId: 'ws', date: addDaysT(month(0) + '-01', -5), balance: 300, createdAt: now }, k4: { accountId: 'cc', date: addDaysT(month(0) + '-01', -5), balance: -200, createdAt: now } },
    income: { i1: { amount: 2000, date: td, source: 'Salary', category: 'Salary', account: 'Deutsche Bank', earner: 'Anubhav', createdAt: now } },
    expenses: { e1: { amount: 120, date: td, store: 'Trattoria', category: 'Eating out', account: 'Wise Common', spender: 'Sulekha', createdAt: now },
      e2: { amount: 80, date: td, store: 'Rewe', category: 'Groceries', subcategory: 'Supermarket', account: 'DB Card', spender: 'Anubhav', createdAt: now },
      e3: { amount: 999, date: td, store: 'Shop', category: 'Shopping', account: 'HDFC NRE', spender: 'Anubhav', createdAt: now },
      e4: { amount: 800, date: td, store: 'Landlord', category: 'Housing', subcategory: 'Rent', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now },
      e5: { amount: 30, date: td, store: 'Kiosk', category: 'Shopping', subcategory: 'Magazines', account: 'Wise Common', spender: 'Anubhav', createdAt: now } },
    transfers: { t1: { amount: 200, date: td, from: 'Deutsche Bank', to: 'Scalable', createdAt: now } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(150);
  await page.click('#budgetPanel [data-envsetup]'); await page.waitForSelector('#envSetupDlg[open]');
  assert.deepEqual((await page.$$eval('#esAccs [data-esacc]:checked', els => els.map(e => e.value))).sort(), ['DB Card', 'Deutsche Bank', 'Wise Common', 'Wise Sulekha']);
  await page.click('#esSave'); await page.waitForSelector('#envCatDlg[open]');
  // Nothing created automatically: two empty categories to name and fill.
  assert.deepEqual(await page.$$eval('#ecList [data-ecg]', els => els.map(e => e.value)), ['Fixed', 'Flexible']);
  assert.equal(await page.$$eval('#ecList .ece', els => els.length), 0);
  assert.match(await app.text('#ecUn'), /Housing › Rent €800.*Eating out \(all\) €120.*Groceries › Supermarket €80.*Shopping › Magazines €30/);
  await page.click('[data-ecenew="0"]'); await page.selectOption('[data-ecsrc="0.0"]', 'Housing›Rent');
  assert.equal(await page.inputValue('[data-ece="0.0"]'), 'Rent', 'named after the first spending added');
  await page.fill('[data-ect]', '800');
  await page.click('[data-ecenew="1"]'); await page.fill('[data-ece="1.0"]', 'Food');
  assert.match(await page.$eval('[data-ecsrc="1.0"] option[value="Groceries"]', o => o.textContent), /Groceries \(all\) · €80 in /, 'the list shows a running total');
  await page.selectOption('[data-ecsrc="1.0"]', 'Groceries'); await page.selectOption('[data-ecsrc="1.0"]', 'Eating out');
  const stat = (await app.text('#ecList .ece:has([data-ece="1.0"]) .ecstat'));
  assert.match(stat, /Nothing in the last 3 months · €200 so far in/, 'this month: 120 eating out + 80 groceries');
  assert.match(await app.text('#ecList .ece:has([data-ece="1.0"]) .ecsrc'), /Groceries \(all\) €80 in .*Eating out \(all\) €120 in/);
  await page.click('#envCatForm [type=submit]'); await page.waitForTimeout(250);
  let t = await envText(app);
  assert.match(t, /Ready to Assign\s*€4,300\.00/, 'starting cash + salary into Deutsche Bank (card debt is on the card envelope)');
  assert.match(t, /Credit Card Payments.*DB Card\s*owes €280\s*–\s*€80\s*€80/, 'groceries bought on the card moved to its envelope');
  assert.match(t, /Not assigned.*Spending in no envelope\s*–\s*−€30/, 'Magazines has no envelope; HDFC spending left out');
  assert.match(t, /Fixed.*Rent\s*–\s*−€800\s*−€800.*Flexible.*Food\s*–\s*−€200\s*−€200/);
  assert.match(t, /Savings/); assert.match(await app.text('[data-envkey="s_save_anubhav"]'), /^AInvesting & India\s*–\s*−€200/, 'from Deutsche Bank, his (A)');
  await page.click('[data-envtargets]'); await page.waitForTimeout(200);
  assert.match(await envText(app), /Ready to Assign\s*€3,500\.00.*Rent\s*€800\s*−€800\s*€0/);
  const food = await page.$eval('.ybr.env:has-text("Food")', el => el.dataset.envkey);
  await page.click(`[data-envkey="${food}"]`); await page.waitForSelector('#envAsgDlg[open]');
  assert.match(await app.text('#eaNums'), /Gets: Groceries \(all\), Eating out \(all\)/);
  assert.match(await app.text('#eaCover'), /Cover €200\.00 from\s*Ready to Assign\s*€3,500\.00/);
  await page.click('#eaCover [data-cover="ready"]'); await page.waitForTimeout(200);
  t = await envText(app);
  assert.match(t, /Ready to Assign\s*€3,300\.00/); assert.match(t, /Food\s*€200\s*−€200\s*€0/);
  await app.go('overview'); await page.waitForTimeout(150);
  assert.match(await app.text('#kpis'), /Ready to assign\s*€3,300\.00.*Budget →/, 'the Overview keeps one line: Ready to Assign, links to Budget');
  assert.equal(await page.$('#page-overview #budgetPanel'), null, 'the envelopes are on their own page');
  await page.click('#kpis a[href="#budget"]'); await page.waitForTimeout(200);
  await page.click('[data-envmove]'); await page.waitForSelector('#envMoveDlg[open]');
  await page.selectOption('#em-to', food); await page.fill('#em-amt', '50'); await page.click('#envMoveForm [type=submit]'); await page.waitForTimeout(200);
  assert.match(await envText(app), /Ready to Assign\s*€3,250\.00.*Food\s*€250\s*−€200\s*€50/);
  await clean(app);
});

test('envelopes: a start day mid-month leaves earlier spending out, says so, and "Count all of the month" re-estimates the starting money', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: m + '-01' } },
    checkins: { k1: { accountId: 'db', date: addDaysT(m + '-01', -1), balance: 1000, createdAt: now } },
    expenses: { e1: { amount: 100, date: m + '-01', store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } },
    settings: { envelopes: { start: m + '-02', accounts: ['Deutsche Bank'], opening: 900, openingBy: { 'Deutsche Bank': 900 }, trips: true,
      groups: [{ id: 'g', name: 'Daily', envs: [{ id: 'food', name: 'Groceries', src: ['Groceries'] }] }], assigned: {}, targets: {} } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(150);
  let t = await envText(app);
  assert.match(t, /Groceries\s*–\s*–\s*€0/, 'the 1st is before the start day'); assert.match(t, /Counting from 2 \w+, your start day/);
  await page.click('[data-envwhole]'); await page.waitForSelector('#envSetupDlg[open]');
  assert.equal(await page.inputValue('#es-start'), m + '-01');
  assert.equal(await page.inputValue('[data-esamt="Deutsche Bank"]'), '1000.00', 'money on the day before the new start');
  await page.click('#esSave'); await page.waitForTimeout(250);
  t = await envText(app);
  assert.match(t, /Ready to Assign\s*€1,000\.00/); assert.match(t, /Groceries\s*–\s*−€100\s*−€100/); assert.doesNotMatch(t, /Counting from/);
  await clean(app);
});

test('envelopes: trip spending can go to your own Trips category instead of one envelope per trip', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: m + '-01' } },
    trips: { w: { name: 'Wedding in India', type: 'other', traveller: 'Both', start: m + '-02', end: m + '-20' } },
    expenses: { e1: { amount: 600, date: m + '-02', store: 'Air India', category: 'Travel', subcategory: 'Flights', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now, tripId: 'w' },
      e2: { amount: 300, date: m + '-03', store: 'Taj', category: 'Travel', subcategory: 'Hotels', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now, tripId: 'w' } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 2000, trips: true, assigned: {}, targets: {},
      groups: [{ id: 'g', name: 'Trips & Travel', envs: [{ id: 'tr', name: 'Transportation', src: ['Travel›Flights'] }, { id: 'ac', name: 'Accommodation', src: ['Travel›Hotels'] }] }] } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(150);
  let t = await envText(app);
  assert.match(t, /Transportation\s*–\s*–/); assert.match(t, /Travel · one per trip.*Wedding in India · \w+ '\d\d\s*–\s*−€900/);
  await page.click('details:has([data-envnotrips]) [data-envinfo]'); await page.click('[data-envnotrips]'); await page.waitForTimeout(250);
  t = await envText(app);
  assert.match(t, /Transportation\s*–\s*−€600/); assert.match(t, /Accommodation\s*–\s*−€300/); assert.doesNotMatch(t, /one per trip/);
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envsetup]'); await page.waitForSelector('#envSetupDlg[open]');
  assert.equal(await page.isChecked('#es-trips'), false);
  await clean(app);
});

test('envelopes: cover overspending from another envelope, YNAB-style; Savings lists its transfers', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: m + '-01' }, sc: { name: 'Scalable', type: 'investment', currency: 'EUR', owner: 'Anubhav', createdAt: m + '-01' } },
    expenses: { e1: { amount: 240, date: m + '-02', store: 'Lufthansa', category: 'Transportation', subcategory: 'Flight', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } },
    transfers: { t1: { amount: 500, date: m + '-03', from: 'Deutsche Bank', to: 'Scalable', comment: 'ETF', createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 0, trips: false, targets: {},
      groups: [{ id: 'g', name: 'Travel', envs: [{ id: 'tr', name: 'Transportation', src: ['Transportation'] }] }, { id: 'h', name: 'Daily', envs: [{ id: 'food', name: 'Groceries', src: ['Groceries'] }, { id: 'fun', name: 'Fun', src: ['Fun'] }] }],
      assigned: { [m]: { tr: 150, food: 300, fun: 50 } } } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(150);
  await page.click('[data-envkey="tr"]'); await page.waitForSelector('#envAsgDlg[open]');
  const c = await app.text('#eaCover');
  assert.match(c, /Cover €90\.00 from\s*Daily › Groceries\s*€300\.00\s*Daily › Fun\s*€50\.00/, 'envelopes with money, fullest first; no Ready to Assign when it is negative');
  await page.click('#eaCover [data-cover="fun"]'); await page.waitForTimeout(250);
  let t = await envText(app);
  assert.match(t, /Transportation\s*€200\s*−€240\s*−€40/); assert.match(t, /Fun\s*–\s*–\s*€0/);
  await page.click('[data-envkey="tr"]'); await page.click('#eaCover [data-cover="food"]'); await page.waitForTimeout(250);
  t = await envText(app);
  assert.match(t, /Transportation\s*€240\s*−€240\s*€0/); assert.match(t, /Groceries\s*€260\s*–\s*€260/);
  await page.click('[data-envkey="s_save_anubhav"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.match(await app.text('#eaActs'), /To Scalable\s*from Deutsche Bank · ETF\s*€500\.00/);
  await clean(app);
});

test('envelopes QA: spending from accounts outside the budget is shown per account (add one, keep the other out); card bills logged as spending can become card payments', async () => {
  const app = await openApp(), { page } = app, m = month(0), pm = month(-1), now = new Date().toISOString();
  const ex = (id, day, amount, store, category, account) => [id, { amount, date: m + '-' + day, store, category, account, spender: 'Anubhav', createdAt: now }];
  await app.seed({
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: pm + '-01' }, rf: { name: 'Raiffeisen Bank', type: 'bank', currency: 'EUR', owner: 'Sulekha', createdAt: pm + '-01' },
      nre: { name: 'HDFC NRE', type: 'bank', currency: 'INR', owner: 'Anubhav', createdAt: pm + '-01' }, cc: { name: 'DB Credit Card', type: 'card', currency: 'EUR', owner: 'Anubhav', createdAt: pm + '-01' } },
    checkins: { a: { accountId: 'db', date: pm + '-28', balance: 3000, createdAt: now }, d: { accountId: 'rf', date: pm + '-28', balance: 1500, createdAt: now } },
    expenses: Object.fromEntries([ex('r1', '01', 900, 'Vigna di Casali', 'Rent', 'Raiffeisen Bank'), ex('r2', '01', 880, 'Landlord', 'Rent', 'Deutsche Bank'),
      ex('i2', '12', 60, 'Amazon.in', 'Indian Expenses', 'HDFC NRE'), ex('k1', '10', 400, 'DB Kreditkarte', 'Credit Card', 'Deutsche Bank')]),
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank', 'DB Credit Card'], opening: 3000, openingBy: { 'Deutsche Bank': 3000, 'DB Credit Card': 0 }, trips: false, targets: {}, assigned: {},
      groups: [{ id: 'f', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent - Both', src: ['Rent'] }] }, { id: 'd', name: 'Daily', envs: [{ id: 'ind', name: 'Indian Expenses', src: ['Indian Expenses'] }] }] } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(150);
  let t = await envText(app);
  assert.match(t, /€900 spent from Raiffeisen Bank, outside the budget.*€60 spent from HDFC NRE/); assert.match(t, /Rent - Both\s*\+€900 outside\s*–\s*−€880/);
  assert.equal(await page.isHidden('#kpis .kpi:has-text("Budget left")'), true, 'the budgets summary tile is really hidden');
  await page.click('[data-envexclude=\'["HDFC NRE"]\']'); await page.waitForTimeout(250);
  t = await envText(app); assert.match(t, /€900 spent from Raiffeisen Bank/); assert.doesNotMatch(t, /HDFC NRE/);
  await page.click('[data-envaddacc=\'["Raiffeisen Bank"]\']'); await page.waitForSelector('#envSetupDlg[open]');
  assert.deepEqual((await page.$$eval('#esAccs [data-esacc]:checked', e => e.map(x => x.value))).sort(), ['DB Credit Card', 'Deutsche Bank', 'Raiffeisen Bank'], 'only the one account added');
  assert.equal(await page.inputValue('[data-esamt="Raiffeisen Bank"]'), '1500.00');
  await page.click('#esSave'); await page.waitForTimeout(250);
  t = await envText(app); assert.match(t, /Rent - Both\s*–\s*−€1,780/); assert.doesNotMatch(t, /outside the budget/);
  // The card bill
  assert.match(t, /€400 of card bills logged as spending in \w+/); assert.match(t, /Credit Card Payments.*DB Credit Card\s*–\s*−€400/);
  await page.click('#budgetPanel [data-ccfix]'); await page.waitForSelector('#ccDlg[open]');
  assert.equal(await page.inputValue('[data-cccard="k1"]'), 'DB Credit Card', 'the card named in the entry');
  await page.click('#ccForm [type=submit]'); await page.waitForTimeout(300);
  t = await envText(app); assert.doesNotMatch(t, /card bills logged as spending/); assert.match(t, /DB Credit Card\s*–\s*−€400/, 'still a payment, now as a transfer'); assert.doesNotMatch(t, /Not assigned/, 'no longer spending');
  await app.go('transactions'); await page.click('[data-txkind="transfer"]'); await page.waitForTimeout(150);
  assert.match(await app.text('#page-transactions'), /Deutsche Bank → DB Credit Card/);
  await clean(app);
});

test('envelopes: starting money worked out from your balances and entries (back from a later balance, or all entries); card debt goes to the card envelope', async () => {
  const app = await openApp(), { page } = app, m = month(0), pm = month(-1), now = new Date().toISOString(), td = d(0);
  await app.seed({
    accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: td }, cc: { name: 'Deutsche Bank CC', type: 'card', currency: 'EUR', owner: 'Anubhav', createdAt: td },
      wc: { name: 'Wise - Common', type: 'bank', currency: 'EUR', owner: 'Shared', createdAt: td } },
    checkins: { a: { accountId: 'db', date: td, balance: 2500, createdAt: now }, b: { accountId: 'cc', date: td, balance: -300, createdAt: now } },
    expenses: { e1: { amount: 120, date: m + '-02', store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now },
      e2: { amount: 80, date: m + '-03', store: 'Zara', category: 'Shopping', account: 'Deutsche Bank CC', spender: 'Anubhav', createdAt: now },
      e3: { amount: 100, date: pm + '-20', store: 'Lidl', category: 'Groceries', account: 'Wise - Common', spender: 'Anubhav', createdAt: now },
      e4: { amount: 50, date: m + '-04', store: 'Lidl', category: 'Groceries', account: 'Wise - Common', spender: 'Anubhav', createdAt: now } },
    income: { i1: { amount: 1000, date: m + '-01', source: 'Salary', category: 'Salary', account: 'Deutsche Bank', earner: 'Anubhav', createdAt: now },
      i2: { amount: 800, date: pm + '-10', source: 'Gift', category: 'Gift', account: 'Wise - Common', earner: 'Anubhav', createdAt: now } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(150);
  await page.click('#budgetPanel [data-envsetup]'); await page.waitForSelector('#envSetupDlg[open]');
  // Deutsche Bank: 2500 today − 1000 salary + 120 groceries = 1620 at the end of the day before the start.
  assert.equal(await page.inputValue('[data-esamt="Deutsche Bank"]'), '1620.00'); assert.match(await app.text('#esAccs'), /Deutsche Bank EUR · worked back from the balance of/);
  // Wise - Common has no balance typed in: 800 − 100 from all its entries before the start.
  assert.equal(await page.inputValue('[data-esamt="Wise - Common"]'), '700.00'); assert.match(await app.text('#esAccs'), /Wise - Common EUR · all entries since 10 /);
  // The card owed 300 today, 80 of it spent since: 220 before the start.
  assert.equal(await page.inputValue('[data-esamt="Deutsche Bank CC"]'), '-220.00');
  assert.match(await app.text('#esTotal'), /Starting Ready to Assign: €2,320\.00.*Cards owed €220\.00 then/);
  assert.equal(await page.isHidden('#esNoBal'), true, 'nothing to type');
  await page.click('#esSave'); await page.waitForSelector('#envCatDlg[open]'); await page.click('#ecCancel'); await page.waitForTimeout(200);
  const t = await envText(app);
  assert.match(t, /Ready to Assign\s*€3,320\.00/, '2320 + 1000 salary');
  assert.match(t, /Credit Card Payments.*Deutsche Bank CC\s*owes €300\s*–\s*€80\s*€80/);
  await clean(app);
});

// ---------- review fixes: card bills, trip bookings, layout, transactions, country ----------
const dbDocs = (app, col) => app.page.evaluate(async col => { const m = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'); return (await m.getDocsFromServer({ col })).docs.map(d => ({ id: d.id, ...d.data() })); }, col);
const ACC4 = { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha' },
  amex: { name: 'AMEX', type: 'card', currency: 'EUR', owner: 'Anubhav' }, dcc: { name: 'Deutsche Bank CC', type: 'card', currency: 'EUR', owner: 'Anubhav' } };

test('card bills: the Overview says they inflate Spent and turns them into card payments; the add form asks before saving one as spending', async () => {
  const app = await openApp(), { page } = app, td = d(0);
  await app.seed({ accounts: ACC4, expenses: {
    e1: { amount: 1200, date: td, store: 'AMEX', category: 'Credit Card', account: 'Deutsche Bank', spender: 'Anubhav', comment: 'AMEX bill', createdAt: 'x' },
    e2: { amount: 50, date: td, store: 'Rewe', category: 'Groceries', account: 'AMEX', spender: 'Anubhav', createdAt: 'x' } } });
  await page.waitForTimeout(300);
  assert.match(await app.text('#kpis'), /Spent\s*€1,250\.00/);
  assert.match(await app.text('#page-overview [data-ccbar]'), /€1,200 of card bills are logged as spending \(1 entry in Credit Card\), so Spent and Saved count them/);
  await page.click('#page-overview [data-ccfix]'); await page.waitForSelector('#ccDlg[open]');
  assert.equal(await page.inputValue('[data-cccard="e1"]'), 'AMEX');
  await page.click('#ccForm [type=submit]'); await page.waitForTimeout(300);
  assert.match(await app.text('#kpis'), /Spent\s*€50\.00/, 'the bill is no longer spending');
  assert.equal(await page.isHidden('#page-overview [data-ccbar]'), true);
  assert.deepEqual((await dbDocs(app, 'transfers')).map(t => [t.from, t.to, t.amount]), [['Deutsche Bank', 'AMEX', 1200]]);
  // Typing a new one in: asked first; the card is guessed from the store.
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.fill('#f-amount', '300'); await page.fill('#f-store', 'Deutsche Bank CC bill'); await page.fill('#f-category', 'Credit Card'); await page.fill('#f-account', 'Deutsche Bank');
  await page.click('#saveBtn'); await page.waitForTimeout(150);
  assert.match(await app.text('#billAsk'), /This looks like a card bill/); assert.equal(await page.inputValue('#billCard'), 'Deutsche Bank CC');
  assert.equal((await dbDocs(app, 'expenses')).length, 1, 'nothing saved yet');
  await page.click('#billTr'); await page.waitForTimeout(300);
  assert.equal(await page.isVisible('#dlg[open]'), false);
  const trs = (await dbDocs(app, 'transfers')).map(t => [t.from, t.to, t.amount, t.comment]);
  assert.deepEqual(trs.find(t => t[2] === 300), ['Deutsche Bank', 'Deutsche Bank CC', 300, 'Deutsche Bank CC bill'], 'a transfer to the card, the store kept as the comment');
  // "Save as spending" keeps it an expense.
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.fill('#f-amount', '20'); await page.fill('#f-store', 'Card fee'); await page.fill('#f-category', 'Credit Card'); await page.fill('#f-account', 'Deutsche Bank');
  await page.click('#saveBtn'); await page.waitForTimeout(150); await page.click('#billKeep'); await page.waitForTimeout(300);
  assert.equal((await dbDocs(app, 'expenses')).filter(e => e.store === 'Card fee').length, 1);
  await clean(app);
});

test('trip: a booking with the same amount as a payment on the trip counts as paid, not twice; Link makes it stick', async () => {
  const app = await openApp(), { page } = app, s = d(20), e = d(30);
  await app.seed({ trips: { tr: { name: 'India Diwali', type: 'holiday', traveller: 'Both', start: s, end: e, budget: 3000, createdAt: 'x' } },
    expenses: { x1: { amount: 1380, date: d(-30), store: 'Lufthansa', category: 'Travel', account: 'DKB', spender: 'Anubhav', tripId: 'tr', createdAt: 'x' } },
    bookings: { b1: { tripId: 'tr', type: 'flight', title: 'MUC to DEL', provider: 'Lufthansa', start: s + 'T13:05', price: 690, currency: 'EUR', createdAt: 'x' },
      b2: { tripId: 'tr', type: 'flight', title: 'DEL to MUC', provider: 'Lufthansa', start: e + 'T02:10', price: 690, currency: 'EUR', createdAt: 'x' } } });
  await page.waitForTimeout(300); await app.go('trips'); await page.waitForTimeout(150);
  await page.click('[data-trip="tr"]'); await page.waitForTimeout(200);
  const t = await app.text('#tripDetail');
  assert.match(t, /Expected total\s*€1,380/, 'spent 1,380 and the two legs paid together in it');
  assert.match(t, /Lufthansa €1,380 has the same amount, so it counts as paid/);
  await page.click('[data-bkautolink="tr"]'); await page.waitForTimeout(300);
  assert.deepEqual((await dbDocs(app, 'bookings')).map(b => b.expenseId), ['x1', 'x1']);
  assert.match(await app.text('#tripDetail'), /all in expenses/);
  await clean(app);
});

test('layout: numbers first and To do on one line; Budget tab; charts on Transactions; old chart links still work', async () => {
  const app = await openApp({ mobile: true }), { page } = app, now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, etf: { name: 'ETF', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    invSnapshots: { s1: { accountId: 'etf', month: month(-1), investment: 500, value: 10000, createdAt: now } },
    expenses: { e1: { amount: 30, date: d(0), store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } } });
  await page.waitForTimeout(300);
  const order = await page.$$eval('#page-overview > div > *:not([hidden])', els => els.map(e => e.id || e.className));
  assert.ok(order.indexOf('kpis') < order.indexOf('todoCard'), 'numbers above To do: ' + order.join(','));
  assert.equal(await page.$eval('#todoDet', el => el.open), false, 'To do starts folded');
  assert.match(await app.text('#todoCard summary'), /To do.*close: 1 of 2 done · next: Check in balances/);
  assert.deepEqual(await page.$$eval('.bottomnav .btab span:first-of-type', s => s.map(x => x.textContent)), ['Overview', 'Transactions', 'Budget', 'Wealth', 'Travel']);
  await page.click('.btab[data-page="budget"]'); await page.waitForTimeout(200);
  assert.match(await envText(app), /Envelopes|Set up/);
  await app.go('visualizations'); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => location.hash), '#transactions');
  assert.equal(await page.isVisible('#txCharts'), true); assert.equal(await page.isVisible('#txListP'), false);
  assert.match(await app.text('#byCategory'), /Groceries/);
  await page.click('#vzBanner [data-txview="list"]'); await page.waitForTimeout(150);
  assert.equal(await page.isVisible('#txListP'), true); assert.match(await app.text('#status'), /^Tap a row/, 'phones say tap');
  assert.equal(await page.$eval('#txFilters', el => getComputedStyle(el).display), 'none', 'no empty gap above the list');
  await clean(app);
});

test('wealth: net worth chart on Investments only; Cash & cards one row per account', async () => {
  const app = await openApp(), { page } = app, now = new Date().toISOString();
  await app.seed({ accounts: { ...ACC4, etf: { name: 'ETF', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    checkins: { c1: { accountId: 'db', date: d(-3), balance: 2000, createdAt: now }, c2: { accountId: 'amex', date: d(-50), balance: -300, createdAt: now } },
    invSnapshots: { s1: { accountId: 'etf', month: month(-2), investment: 500, value: 10000, createdAt: now }, s2: { accountId: 'etf', month: month(-1), investment: 500, value: 10600, createdAt: now } } });
  await page.waitForTimeout(300); await app.go('wealth'); await page.waitForTimeout(200);
  await page.click('[data-wv="cash"]'); await page.waitForTimeout(150);
  assert.equal(await page.isHidden('#nwAllP'), true);
  assert.equal(await page.$$eval('#accList .ilist .r', r => r.length), 4);
  const t = await app.text('#accList');
  assert.match(t, /Deutsche Bank\s*Anubhav · checked in 3 days ago\s*€2,000\.00/); assert.match(t, /AMEX\s*Anubhav · checked in 50 days ago\s*€300\.00/); assert.match(t, /Wise Sulekha\s*Sulekha · no check-in yet/);
  await page.click('#accList [data-acc="db"]'); await page.waitForTimeout(150);
  assert.equal(await page.isVisible('#accDetail'), true, 'a row opens the account');
  await clean(app);
});

test('transactions: Undo after delete; select several and change their category or trip at once, with Undo', async () => {
  const app = await openApp(), { page } = app, td = d(0), now = new Date().toISOString();
  await app.seed({ trips: { tr: { name: 'Rome visit', type: 'visit', traveller: 'Anubhav', start: d(-3), end: d(2), createdAt: now } }, expenses: {
    e1: { amount: 10, date: td, store: 'Bar A', category: 'Food', account: 'DKB', spender: 'Anubhav', createdAt: now }, e2: { amount: 20, date: td, store: 'Bar B', category: 'Food', account: 'DKB', spender: 'Anubhav', createdAt: now },
    e3: { amount: 30, date: td, store: 'Shop C', category: 'Shopping', account: 'DKB', spender: 'Anubhav', tripId: 'tr', createdAt: now } } });
  await page.waitForTimeout(300); await app.go('transactions'); await page.waitForTimeout(150);
  await page.click('#rows tr[data-edit="e3"]'); await page.waitForSelector('#dlg[open]');
  await page.click('#delBtn'); await page.click('#delBtn'); await page.waitForTimeout(250);
  assert.equal((await dbDocs(app, 'expenses')).length, 2);
  assert.match(await app.text('#toast'), /Deleted\s*Undo/); await page.click('#toast .toastact'); await page.waitForTimeout(250);
  const back = (await dbDocs(app, 'expenses')).find(x => x.id === 'e3');
  assert.deepEqual([back.store, back.tripId, back.amount], ['Shop C', 'tr', 30], 'restored as it was');
  await page.click('#selBtn'); await page.click('#rows tr[data-edit="e1"]'); await page.click('#rows tr[data-edit="e2"]');
  assert.match(await app.text('#selBar'), /2 selected · €30\.00/);
  await page.click('[data-selchange]'); await page.waitForSelector('#bulkDlg[open]');
  assert.match(await app.text('#bulkTitle'), /Change 2 entries/);
  await page.fill('#bk-category', 'Eating out'); await page.selectOption('#bk-trip', 'tr'); await page.click('#bulkSave'); await page.waitForTimeout(300);
  let ex = await dbDocs(app, 'expenses');
  assert.deepEqual(ex.filter(x => x.id !== 'e3').map(x => [x.id, x.category, x.tripId, x.spender]).sort(), [['e1', 'Eating out', 'tr', 'Anubhav'], ['e2', 'Eating out', 'tr', 'Anubhav']]);
  assert.equal(await page.isHidden('#selBar'), true, 'select mode ends after a change');
  await page.click('#toast .toastact'); await page.waitForTimeout(250);
  ex = await dbDocs(app, 'expenses');
  assert.deepEqual(ex.filter(x => x.id !== 'e3').map(x => [x.category, x.tripId || '']).sort(), [['Food', ''], ['Food', '']], 'Undo puts them back');
  await clean(app);
});

test('country: entries without one count where their account is usually used (not on trips); the filter follows; the add form fills it', async () => {
  const app = await openApp(), { page } = app, td = d(0), now = new Date().toISOString();
  const E = (id, store, account, country, extra = {}) => [id, { amount: 10, date: td, store, category: 'Food', account, spender: 'Sulekha', ...(country ? { country } : {}), createdAt: now, ...extra }];
  await app.seed({ trips: { tr: { name: 'Paris', type: 'holiday', traveller: 'Both', start: d(-5), end: d(-1), createdAt: now } },
    expenses: Object.fromEntries([E('a', 'Conad', 'Wise Sulekha', 'Italy'), E('b', 'Coop', 'Wise Sulekha', 'Italy'), E('c', 'Esselunga', 'Wise Sulekha', ''),
      E('d', 'Cafe', 'Wise Sulekha', '', { tripId: 'tr' }), E('e', 'Rewe', 'DKB', '')]) });
  await page.waitForTimeout(300); await app.go('charts'); await page.waitForTimeout(200);
  const t = await app.text('#byCountry');
  assert.match(t, /Italy\s*€30\.00/); assert.match(t, /Not set\s*€20\.00/);
  await page.click('#byCountry [data-k="Italy"], #byCountry [data-key="Italy"], #byCountry :text("Italy")'); await page.waitForTimeout(200);
  await page.click('#vzBanner [data-txview="list"]'); await page.waitForTimeout(150);
  assert.equal(await page.$$eval('#rows tr.row', r => r.length), 3, 'Italy includes the entry it was inferred for');
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.click('#moreBtn'); await page.evaluate(() => { document.getElementById('f-country').value = 'Germany'; });
  await page.fill('#f-account', 'Wise Sulekha'); await page.dispatchEvent('#f-account', 'change');
  assert.equal(await page.inputValue('#f-country'), 'Italy');
  await clean(app);
});

test('envelopes: plan ahead like YNAB: assign in next month, Ready to Assign now goes down; that month starts with what this one leaves', async () => {
  const app = await openApp(), { page } = app, m = month(0), nx = month(1), now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    income: { i1: { amount: 3000, date: m + '-01', source: 'Salary', category: 'Salary', account: 'Deutsche Bank', earner: 'Anubhav', createdAt: now } },
    expenses: { e1: { amount: 100, date: m + '-01', store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 0, groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'food', name: 'Food', src: ['Groceries'] }] }], assigned: { [m]: { food: 400 } }, updatedAt: now } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(200);
  assert.match(await envText(app), /Ready to Assign\s*€2,600\.00/);
  await page.click('[data-envnav="1"]'); await page.waitForTimeout(200);
  assert.equal(await page.isHidden('#months'), true, 'one month picker on the Budget page: its own ‹ ›');
  let t = await envText(app);
  assert.match(t, /Planning ahead/); assert.match(t, /Food\s*–\s*–\s*€300/, 'starts with this month’s leftover');
  await page.click('[data-envkey="food"]'); await page.waitForSelector('#envAsgDlg[open]');
  await page.fill('#ea-amt', '450'); await page.click('#envAsgForm [type=submit]'); await page.waitForTimeout(250);
  t = await envText(app); assert.match(t, /Ready to Assign\s*€2,150\.00/); assert.match(t, /Food\s*€450\s*–\s*€750/);
  await page.click('[data-envnow]'); await page.waitForTimeout(200);
  t = await envText(app); assert.match(t, /Ready to Assign\s*€2,150\.00.*€450 assigned in later months/);
  assert.match(t, /Food\s*€400\s*−€100\s*€300/, 'this month is unchanged');
  await app.go('overview'); await page.waitForTimeout(150);
  assert.match(await app.text('#kpis'), /Ready to assign\s*€2,150\.00.*€450 set for later months/);
  assert.equal(await page.$(`#months [data-p="${nx}"]`), null, 'months ahead only on the Budget page');
  await app.go('budget'); await page.waitForTimeout(150);
  assert.match(await envText(app), /Ready to Assign\s*€2,150\.00/, 'the Budget page opens on this month');
  await clean(app);
});

test('envelopes: Ready to Assign shows where each of you stands and what is left after the envelopes each one owns (rent split 860 / 900)', async () => {
  const app = await openApp(), { page } = app, m = month(0), nx = month(1), now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha' },
      wc: { name: 'Wise Common', type: 'bank', currency: 'EUR', owner: 'Shared' }, amex: { name: 'AMEX', type: 'card', currency: 'EUR', owner: 'Anubhav' },
      nre: { name: 'HDFC NRE', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    checkins: { a: { accountId: 'db', date: td, balance: 4120, createdAt: now }, b: { accountId: 'ws', date: td, balance: 2850, createdAt: now },
      c: { accountId: 'wc', date: td, balance: 1340, createdAt: now }, e: { accountId: 'amex', date: td, balance: -302, createdAt: now }, f: { accountId: 'nre', date: td, balance: 9000, createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank', 'Wise Sulekha', 'Wise Common', 'AMEX'], opening: 0, updatedAt: now,
      groups: [{ id: 'g1', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent', src: ['Rent'], split: { Anubhav: 860, Sulekha: 900 } }] },
        { id: 'g2', name: 'Flexible', envs: [{ id: 'food', name: 'Groceries', src: ['Groceries'] }, { id: 'wed', name: 'Wedding', src: ['Wedding'], owner: 'Anubhav' }] }],
      assigned: { [m]: { rent: 1760, food: 300, wed: 1000 }, [nx]: { wed: 200 } } } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(200);
  // One line: what's left for each; tap for the table (balance, bank − cards, in envelopes, left).
  assert.equal(await app.text('[data-envwho="Anubhav"]'), 'Anubhav€1,758', '3,818 (HDFC NRE is outside the budget) − rent 860 − wedding 1,000 and 200 planned');
  assert.equal(await app.text('[data-envwho="Sulekha"]'), 'Sulekha€1,950', 'her part of the rent');
  assert.equal(await app.text('[data-envwho="Shared"]'), 'Common€1,040', 'groceries are common money');
  await page.click('.rwho > summary'); await page.waitForTimeout(100);
  assert.deepEqual(await page.$$eval('.rwt > span', els => els.map(e => e.textContent.trim())), ['', 'Anubhav', 'Sulekha', 'Common', 'Balance', '€3,818', '€2,850', '€1,340',
    'bank − cards', '€4,120 − €302', '€2,850', '€1,340', 'In envelopes', '−€2,060', '−€900', '−€300', 'Left', '€1,758', '€1,950', '€1,040']);
  assert.equal(await page.getAttribute('[data-envkey="rent"] .ob', 'title'), 'Split: Anubhav €860, Sulekha €900');
  assert.deepEqual(await Promise.all(['rent', 'wed', 'food', 'cc_amex'].map(k => page.textContent(`[data-envkey="${k}"] .ob`))), ['A·S', 'A', 'C', 'A'], 'every envelope shows whose money it is: cards by account owner');
  // Groceries becomes Sulekha's in Categories (in the ⋯ menu).
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envcats]'); await page.waitForSelector('#envCatDlg[open]');
  await page.selectOption('[data-ecown="1.0"]', 'Sulekha'); await page.click('#envCatForm [type=submit]'); await page.waitForTimeout(300);
  assert.equal(await app.text('[data-envwho="Sulekha"]'), 'Sulekha€1,650', '900 rent + 300 groceries');
  assert.equal(await app.text('[data-envwho="Shared"]'), 'Common€1,340');
  // A split needs its amounts.
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envcats]'); await page.waitForSelector('#envCatDlg[open]');
  await page.selectOption('[data-ecown="1.1"]', 'split'); await page.click('#envCatForm [type=submit]'); await page.waitForTimeout(150);
  assert.match(await app.text('#ecErr'), /Give Wedding the amounts to split/);
  await page.fill('[data-ecsplit="1.1.Anubhav"]', '600'); await page.fill('[data-ecsplit="1.1.Sulekha"]', '400'); await page.click('#envCatForm [type=submit]'); await page.waitForTimeout(300);
  assert.equal(await app.text('[data-envwho="Anubhav"]'), 'Anubhav€2,238', '3,818 − (860 + 60% of 1,200)');
  // Or straight from the envelope: tap it, change whose money it is.
  await page.click('[data-envkey="food"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.equal(await page.inputValue('#ea-own'), 'Sulekha');
  await page.selectOption('#ea-own', 'Both'); await page.click('#envAsgForm [type=submit]'); await page.waitForTimeout(300);
  assert.equal(await app.text('[data-envwho="Shared"]'), 'Common€1,040'); assert.equal(await page.textContent('[data-envkey="food"] .ob'), 'C');
  await page.click('[data-envkey="rent"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.equal(await page.inputValue('#ea-own'), 'split'); assert.equal(await page.inputValue('[data-easplit="Sulekha"]'), '900');
  await page.click('#eaCancel');
  await clean(app);
});

// ---------- card payments counted once ----------
const PAY = () => { const at = '2026-10-01T08:00:00.000Z', A = (name, type) => ({ name, type, currency: 'EUR', owner: 'Anubhav', createdAt: '2026-09-01' });
  return { accounts: { db: A('Deutsche Bank', 'bank'), amex: A('AMEX', 'card') },
    checkins: { k1: { accountId: 'db', date: '2026-10-01', balance: 5000, createdAt: at }, k2: { accountId: 'amex', date: '2026-10-01', balance: -1000, createdAt: at } },
    expenses: { p1: { amount: 300, date: '2026-10-05', store: 'Rewe', category: 'Groceries', account: 'AMEX', spender: 'Anubhav', createdAt: at } }, transfers: {} }; };
const BILL = { amount: 1000, date: '2026-10-20', store: 'AMEX', category: 'Credit Card', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: '2026-10-20T09:00:00.000Z' };
const cashRows = async app => { await app.go('wealth'); await app.page.evaluate(() => document.querySelector('[data-wv="cash"]').click()); await app.page.waitForTimeout(200);
  return app.page.$$eval('#accList .ilist .r', els => Object.fromEntries(els.map(e => [e.querySelector('.nm').textContent, e.querySelector('.v').textContent.trim()]))); };

test('card bills → payments: a bill already logged as a transfer is only removed; the others keep their own time (a balance checked that day stays right)', async () => {
  const app = await openApp(), { page } = app, d = PAY();
  d.expenses.b1 = { ...BILL };                                                                                   // also a transfer
  d.transfers.t1 = { amount: 1000, date: '2026-10-21', from: 'Deutsche Bank', to: 'AMEX', createdAt: '2026-10-21T10:00:00.000Z' };
  d.expenses.b2 = { ...BILL, amount: 400, date: '2026-10-25', store: 'AMEX extra', createdAt: '2026-10-25T09:00:00.000Z' };   // only spending, on a check-in day
  d.checkins.k3 = { accountId: 'amex', date: '2026-10-25', balance: -300, createdAt: '2026-10-25T20:00:00.000Z' };         // the AMEX app, after both payments
  d.checkins.k4 = { accountId: 'db', date: '2026-10-25', balance: 3600, createdAt: '2026-10-25T20:00:00.000Z' };
  await app.seed(d); await page.waitForTimeout(300);
  assert.match(await app.text('#page-overview [data-paybar]'), /Logged twice\? €1,000\.00 AMEX as spending on 20 Oct and as a transfer to AMEX on 21 Oct/);
  await page.click('#page-overview [data-ccfix]'); await page.waitForSelector('#ccDlg[open]');
  assert.match(await app.text('#ccList'), /Already a transfer to AMEX on 21 Oct: only this entry is removed/);
  await page.click('#ccForm [type=submit]'); await page.waitForTimeout(300);
  assert.match(await app.text('#toast'), /1 turned into card payment · 1 already logged as transfer, removed/);
  const tr = await dbDocs(app, 'transfers');
  assert.equal(tr.length, 2, 'the existing transfer + one new one, not two new ones');
  const nw = tr.find(t => t.amount === 400); assert.equal(nw.createdAt, '2026-10-25T09:00:00.000Z', 'keeps the time the bill was logged');
  assert.deepEqual(await cashRows(app), { 'Deutsche Bank': '€3,600.00', AMEX: '€300.00' }, 'both balances are what was typed on the 25th (AMEX owes 300)');
  assert.equal(await page.isHidden('#wv-cash [data-paybar]'), true, 'nothing left to check');
  await clean(app);
});

test('card payments: checks find what the old conversion counted twice, and one tap puts it right (with Undo)', async () => {
  const app = await openApp(), { page } = app, d = PAY();
  // A: the same payment twice (the bill had been logged as a transfer too).
  d.transfers.t1 = { amount: 1000, date: '2026-10-20', from: 'Deutsche Bank', to: 'AMEX', createdAt: '2026-10-20T09:00:00.000Z' };
  d.transfers.t2 = { amount: 1000, date: '2026-10-20', from: 'Deutsche Bank', to: 'AMEX', comment: 'Card payment · AMEX', createdAt: '2026-10-27T08:00:00.000Z' };
  // B: a converted payment on a day the balance was checked in, logged (by the conversion) after that check.
  d.transfers.t3 = { amount: 200, date: '2026-10-24', from: 'Deutsche Bank', to: 'AMEX', comment: 'Card payment · AMEX 2', createdAt: '2026-10-27T08:00:00.000Z' };
  d.checkins.k3 = { accountId: 'amex', date: '2026-10-24', balance: -100, createdAt: '2026-10-24T20:00:00.000Z' };
  d.checkins.k4 = { accountId: 'db', date: '2026-10-24', balance: 3800, createdAt: '2026-10-24T20:00:00.000Z' };
  await app.seed(d); await page.waitForTimeout(300);
  let rows = await cashRows(app);
  assert.deepEqual(rows, { 'Deutsche Bank': '€3,600.00', AMEX: '-€100.00' }, 'before: the 200 counted on top of the balances typed on the 24th (the bank too low, the card in credit)');
  assert.match(await app.text('#accList'), /AMEX.*in credit: a payment counted twice\?/);
  const t = await app.text('#wv-cash [data-paybar]');
  assert.match(t, /Paid twice\? €1,000\.00 Deutsche Bank → AMEX on 20 Oct and €1,000\.00 on 20 Oct/);
  assert.match(t, /Counted on top of a balance\? €200\.00 Deutsche Bank → AMEX on 24 Oct, the day you checked in Deutsche Bank/);
  await page.click('#wv-cash [data-paydel="t2"]'); await page.waitForTimeout(300);
  assert.deepEqual((await dbDocs(app, 'transfers')).map(x => x.id).sort(), ['t1', 't3'], 'the converted copy goes, the original stays');
  await page.click('#wv-cash [data-paylate="t3"]'); await page.waitForTimeout(300);
  assert.equal((await dbDocs(app, 'transfers')).find(x => x.id === 't3').createdAt, '2026-10-24T00:00:00.000Z');
  rows = await cashRows(app);
  assert.deepEqual(rows, { 'Deutsche Bank': '€3,800.00', AMEX: '€100.00' }, 'after: exactly the balances typed on the 24th');
  assert.equal(await page.isHidden('#wv-cash [data-paybar]'), true);
  // Undo brings the copy back (and the check with it); "Two payments" makes it go away for good.
  await page.click('#toast .toastact'); await page.waitForTimeout(300);
  assert.match(await app.text('#wv-cash [data-paybar]'), /Counted on top of a balance\?/, 'the change to t3 undone');
  await page.click('#wv-cash [data-payok^="l:"]'); await page.waitForTimeout(200);
  assert.equal(await page.isHidden('#wv-cash [data-paybar]'), true, '"It wasn’t" puts it away for good');
  await clean(app);
});

test('envelope bars: grey spent, then what is left in the amount’s colour (green, amber short of target, red overspent); none when it had nothing', async () => {
  const app = await openApp({ mobile: true }), { page } = app, m = month(0), now = new Date().toISOString(), td = d(0);
  const E = (id, amount, category) => [id, { amount, date: td, store: 'S' + id, category, account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now }];
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    expenses: Object.fromEntries([E('a', 75, 'Eating out'), E('b', 464, 'Groceries'), E('c', 20, 'Gifts')]),
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 3000, updatedAt: now, targets: { gift: 100 },
      groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'eat', name: 'Eating out', src: ['Eating out'] }, { id: 'gro', name: 'Groceries', src: ['Groceries'] }, { id: 'gift', name: 'Gifts', src: ['Gifts'] }, { id: 'pc', name: 'Personal care', src: ['Personal care'] }] }],
      assigned: { [m]: { eat: 200, gro: 450, gift: 50 } } } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(250);
  const bar = k => page.$$eval(`[data-envkey="${k}"] .bar i`, els => els.filter(e => getComputedStyle(e).display !== 'none').map(e => e.className + ' ' + e.style.width));
  assert.deepEqual(await bar('eat'), ['spent 37.5%', 'left ok 62.5%']);
  assert.deepEqual(await bar('gro'), ['over 100%']);
  assert.deepEqual(await bar('gift'), ['spent 40%', 'left short 60%'], 'below its €100 target: amber, like its amount');
  assert.deepEqual(await bar('pc'), [], 'nothing assigned, nothing spent: no bar');
  assert.equal(await page.getAttribute('[data-envkey="eat"] .bar', 'title'), 'Spent €75 of €200 · €125 left');
  assert.match(await app.text('.oblegend'), /spent\s*left\s*short of its target, or of what a card owes\s*overspent/);
  await clean(app);
});

test('envelopes: money sent to T212 lands in your own envelope once it takes "Transfers to T212" (else in Savings)', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    transfers: { t1: { amount: 500, date: td, from: 'Deutsche Bank', to: 'T212', createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 3000, updatedAt: now, groups: [{ id: 'g', name: 'Goals', envs: [{ id: 'inv', name: 'Investments', src: ['Investment'], owner: 'Anubhav' }] }], assigned: { [m]: { inv: 500 } } } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(250);
  let t = await envText(app);
  assert.match(t, /Investments\s*€500\s*–\s*€500/); assert.match(t, /Investing & India\s*–\s*−€500\s*−€500/, 'before: in Savings, overspent');
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envcats]'); await page.waitForSelector('#envCatDlg[open]');
  assert.match(await page.$eval('[data-ecsrc="0.0"] option[value="→T212"]', o => o.textContent), /Transfers to T212 · €500 in /);
  await page.selectOption('[data-ecsrc="0.0"]', '→T212');
  assert.match(await app.text('#ecList .ece:has([data-ece="0.0"]) .ecsrc'), /Transfers to T212/);
  await page.click('#envCatForm [type=submit]'); await page.waitForTimeout(300);
  t = await envText(app);
  assert.match(t, /Investments\s*€500\s*−€500\s*€0/, 'now it comes out of Investments'); assert.doesNotMatch(t, /Investing & India\s*–\s*−€500/);
  await page.click('[data-envkey="inv"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.match(await app.text('#eaNums'), /Gets: Investment \(all\), Transfers to T212/);
  assert.match(await app.text('#eaActs'), /To T212\s*from Deutsche Bank\s*€500\.00/);
  await clean(app);
});

test('envelopes: from the made-for-you Savings envelope, "+ Envelope for T212" gives T212 its own envelope (with what was assigned for it)', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    transfers: { t1: { amount: 500, date: td, from: 'Deutsche Bank', to: 'T212', createdAt: now }, t2: { amount: 200, date: td, from: 'Deutsche Bank', to: 'HDFC NRE', createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 3000, updatedAt: now, groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'food', name: 'Groceries', src: ['Groceries'] }] }], assigned: { [m]: { s_save_anubhav: 700 } } } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(250);
  await page.click('[data-envkey="s_save_anubhav"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.match(await app.text('#eaOwnEnv'), /made for you.*\+ Envelope for T212\s*\+ Envelope for HDFC NRE/);
  await page.click('[data-envfor="T212"]'); await page.waitForTimeout(300);
  const t = await envText(app);
  assert.match(t, /Savings & investing\s*€500\s*−€500\s*€0\s*T212\s*€500\s*−€500\s*€0/, 'a category of yours with T212 in it, the €500 assigned for it moved along');
  assert.match(t, /Savings · made for you.*Investing & India\s*€200\s*−€200\s*€0/, 'HDFC NRE stays in the made-for-you envelope with the rest');
  assert.equal(await page.textContent('#budgetPanel .ybr.env:has-text("T212") .ob'), 'A', 'yours, like the envelope it came from');
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envcats]'); await page.waitForSelector('#envCatDlg[open]');
  assert.match(await app.text('#ecSave'), /Money sent out of the budget.*Transfers to HDFC NRE/);
  await clean(app);
});

test('envelopes: the made-for-you Savings hides when empty and comes back when money goes to an account no envelope takes', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    transfers: { t1: { amount: 500, date: td, from: 'Deutsche Bank', to: 'T212', createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 3000, updatedAt: now, groups: [], assigned: { [m]: { s_save_anubhav: 500 } } } } });
  await page.waitForTimeout(300); await app.go('budget'); await page.waitForTimeout(250);
  await page.click('[data-envkey="s_save_anubhav"]'); await page.waitForSelector('#envAsgDlg[open]');
  await page.click('[data-envfor="T212"]'); await page.waitForTimeout(300);
  let t = await envText(app);
  assert.match(t, /T212\s*€500\s*−€500\s*€0/); assert.doesNotMatch(t, /made for you|Investing & India/, 'nothing left in it: hidden');
  await app.seed({ transfers: { t2: { amount: 150, date: td, from: 'Deutsche Bank', to: 'HDFC NRE', createdAt: now } } }); await page.waitForTimeout(300);
  t = await envText(app);
  assert.match(t, /Savings · made for you.*Investing & India\s*–\s*−€150\s*−€150/, 'back as soon as something lands in it');
  await clean(app);
});

test('investing goal linked to Savings & investing: the category shows the goal, one tap fills it (up to each target first), the Overview shows what the budget plans', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    transfers: { t1: { amount: 300, date: td, from: 'Deutsche Bank', to: 'T212', createdAt: now } },
    settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 5000, updatedAt: now, targets: { t212: 600, scal: 400 },
      groups: [{ id: 'gs', name: 'Savings & investing', envs: [{ id: 't212', name: 'T212', src: ['→T212'], owner: 'Anubhav' }, { id: 'scal', name: 'Scalable', src: ['→Scalable'], owner: 'Anubhav' }] }],
      assigned: { [m]: { t212: 300 } } } } });
  await page.waitForTimeout(300);
  // Set the goal from the Overview; the Savings & investing category is picked for it.
  await page.evaluate(() => document.querySelector('[data-goalnew], #setupLine [data-setup="goals"], #setupLine button')?.click()); await page.waitForSelector('#goalDlg[open]');
  assert.equal(await page.inputValue('#g-cat'), 'gs', 'linked to the category named like savings / investing');
  await page.fill('#g-amount', '1000'); await page.click('#goalForm [type=submit]'); await page.waitForTimeout(300);
  assert.match(await app.text('#goalsP'), /In the budget: €300 of €1,000 assigned in Savings & investing · assign €700 →/);
  await app.go('budget'); await page.waitForTimeout(250);
  assert.match(await envText(app), /Savings & investing\s*goal €1,000.*Investing goal: €300 of €1,000 assigned in \w+ · €700 short · €300 sent\s*Assign €700/);
  await page.click('[data-goalfill]'); await page.waitForTimeout(300);
  const t = await envText(app);
  assert.match(t, /T212\s*€600\s*−€300\s*€300/); assert.match(t, /Scalable\s*€400\s*–\s*€400/, 'each up to its target');
  assert.match(t, /Investing goal: €1,000 of €1,000 assigned in \w+ · ✓ covered/);
  await app.go('overview'); await page.waitForTimeout(200);
  assert.match(await app.text('#goalsP'), /In the budget: €1,000 of €1,000 assigned in Savings & investing · covered/);
  await clean(app);
});

test('investing goal set before the budget: linked to the savings category on its own; "Not linked" keeps it apart', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    settings: { goals: { items: [{ type: 'invest', owner: 'Both', amount: 800 }], updatedAt: now },
      envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 5000, updatedAt: now, groups: [{ id: 'gi', name: 'Investments', envs: [{ id: 'e1', name: 'T212', src: ['→T212'] }] }], assigned: { [m]: { e1: 500 } } } } });
  await page.waitForTimeout(300);
  assert.match(await app.text('#goalsP'), /In the budget: €500 of €800 assigned in Investments · assign €300 →/);
  await page.click('#goalsP [data-goaledit="0"]'); await page.waitForSelector('#goalDlg[open]');
  assert.equal(await page.inputValue('#g-cat'), 'gi');
  await page.selectOption('#g-cat', ''); await page.click('#goalForm [type=submit]'); await page.waitForTimeout(300);
  assert.doesNotMatch(await app.text('#goalsP'), /In the budget/);
  await app.go('budget'); await page.waitForTimeout(200); assert.doesNotMatch(await envText(app), /Investing goal/);
  await clean(app);
});

test('investing goal linked to the budget counts what was sent to the accounts in that category, even ones Wealth doesn’t call investments', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha' },
      t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' }, tr: { name: 'TR Emergency', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    transfers: { t1: { amount: 812, date: td, from: 'Deutsche Bank', to: 'T212', createdAt: now }, t2: { amount: 500, date: td, from: 'Deutsche Bank', to: 'TR Emergency', createdAt: now },
      t3: { amount: 500, date: td, from: 'Wise Sulekha', to: 'Fineco', createdAt: now } },
    settings: { goals: { items: [{ type: 'invest', owner: 'Both', amount: 2500 }], updatedAt: now },
      envelopes: { start: m + '-01', accounts: ['Deutsche Bank', 'Wise Sulekha'], opening: 9000, updatedAt: now,
        groups: [{ id: 'gs', name: 'Savings & investing', envs: [{ id: 'a', name: 'T212', src: ['→T212'], owner: 'Anubhav' }, { id: 'b', name: 'TR Emergency', src: ['→TR Emergency'], owner: 'Anubhav' }, { id: 'c', name: 'Fineco', src: ['→Fineco'], owner: 'Sulekha' }] }],
        assigned: { [m]: { a: 1000, b: 500, c: 1000 } } } } });
  await page.waitForTimeout(300);
  const t = await app.text('#goalsP');
  assert.match(t, /€1,812 of €2,500 sent in \w+/, '812 + 500 + 500 sent, though TR Emergency is a bank account and Fineco isn’t set up');
  assert.match(t, /€688 to go/); assert.match(t, /In the budget: €2,500 of €2,500 assigned in Savings & investing · covered/);
  await clean(app);
});

test('add: switching to Transfer fills From with your last real account, never the text "undefined"; "undefined" typed in counts as empty', async () => {
  const app = await openApp(), { page } = app, now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, w: { name: 'Wise', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    expenses: { e1: { amount: 12, date: td, store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now, createdBy: 'anubhav' } },
    transfers: { bad: { amount: 463, date: td, from: 'undefined', to: 'T212', createdAt: now, createdBy: 'anubhav' }, ok: { amount: 50, date: d(-1), from: 'Wise', to: 'T212', createdAt: now, createdBy: 'anubhav' } } });
  await page.waitForTimeout(300);
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  assert.equal(await page.inputValue('#f-account'), 'Deutsche Bank');
  await page.click('#kindSeg [data-kind="transfer"]');
  assert.equal(await page.inputValue('#f-account'), 'Wise', 'the last transfer with a real From, skipping the broken one');
  await page.click('#kindSeg [data-kind="expense"]');
  assert.equal(await page.inputValue('#f-account'), 'Deutsche Bank');
  await page.click('#kindSeg [data-kind="transfer"]');
  await page.fill('#f-account', 'undefined'); await page.fill('#f-to', 'T212'); await page.fill('#f-amount', '100');
  await page.click('#saveBtn'); await page.waitForTimeout(150);
  assert.match(await app.text('#formErr'), /Fill in from account/);
  await page.fill('#f-account', 'Deutsche Bank'); await page.click('#saveBtn'); await page.waitForTimeout(300);
  assert.ok((await dbDocs(app, 'transfers')).some(t => t.from === 'Deutsche Bank' && t.to === 'T212' && t.amount === 100));
  await clean(app);
});

test('backup keeps the envelope budget and the other settings; restoring it puts them back, within the rules', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  const env = { start: m + '-01', accounts: ['Deutsche Bank'], opening: 3000, openingBy: { 'Deutsche Bank': 3000 }, trips: true, updatedAt: now, updatedBy: 'anubhav',
    groups: [{ id: 'g', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent', src: ['Rent'], owner: 'Both' }] }], assigned: { [m]: { rent: 1760 } }, targets: { rent: 1760 } };
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    settings: { envelopes: env, goals: { items: [{ type: 'invest', owner: 'Both', amount: 1000 }], updatedAt: now, updatedBy: 'anubhav' } } });
  await page.waitForTimeout(300);
  await page.click('#profBtn'); await page.click('[data-pm="data"]'); await page.waitForSelector('#dataDlg[open]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-dx="backup"]')]);
  const file = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  const set = Object.fromEntries(file.collections.settings.map(s => [s.id, s]));
  assert.deepEqual(set.envelopes.openingBy, { 'Deutsche Bank': 3000 }); assert.deepEqual(set.envelopes.assigned, { [m]: { rent: 1760 } });
  assert.equal(set.envelopes.groups[0].envs[0].name, 'Rent'); assert.equal(set.goals.items[0].amount, 1000);
  // Restore after the budget was changed: the backup's version comes back.
  await app.seed({ settings: { envelopes: { ...env, assigned: {}, openingBy: { 'Deutsche Bank': 1 }, opening: 1 } } }); await page.waitForTimeout(200);
  await page.setInputFiles('#rsFile', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await page.waitForSelector('#rsDlg[open]');
  assert.match(await app.text('#rsBody'), /Settings: goals, the envelope budget\s*replaces current/);
  await page.click('#rsSave'); await page.waitForTimeout(300);
  const back = (await dbDocs(app, 'settings')).find(s => s.id === 'envelopes');
  assert.deepEqual(back.openingBy, { 'Deutsche Bank': 3000 }); assert.deepEqual(back.assigned, { [m]: { rent: 1760 } });
  await clean(app);
});

test('restoring an old backup without the envelope budget says the budget stays as it is', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({ settings: { envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 3000, openingBy: { 'Deutsche Bank': 3000 }, trips: true, updatedAt: now, groups: [], assigned: {}, targets: {} } } });
  await page.waitForTimeout(300);
  const old = { app: 'S&A Ledger', version: 1, exportedAt: now, collections: { expenses: [], settings: [{ id: 'fx', months: {} }] } };
  await page.setInputFiles('#rsFile', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  await page.waitForSelector('#rsDlg[open]');
  assert.match(await app.text('#rsBody'), /from before backups kept the envelope budget, so your budget stays as it is now/);
  await page.click('#rsCancel');
  await clean(app);
});

test('phones as narrow as 360px: no page is wider than the screen, the Transactions bar included', async () => {
  const app = await openApp({ mobile: true }), { page } = app, td = d(0), now = new Date().toISOString();
  await page.setViewportSize({ width: 360, height: 780 });
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    expenses: { e1: { amount: 1234.56, date: td, store: 'A store with a rather long name for a phone', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } },
    trips: { t1: { name: 'Rome visit with a long name - Anubhav', type: 'visit', traveller: 'Anubhav', start: d(1), end: d(5), createdAt: now } } });
  await page.waitForTimeout(300);
  for (const p of ['overview', 'transactions', 'budget', 'wealth', 'trips']){
    await app.go(p); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360, p + ' fits the screen');
  }
  await clean(app);
});

test('Coming up: a flight with its pass shows once, with the route, arrival and "seat 22C" (not "seat Seat 22C"); the title stays on top', async () => {
  const app = await openApp({ mobile: true }), { page } = app, now = new Date().toISOString();
  await app.seed({ trips: { tr: { name: 'Rome visit', type: 'visit', traveller: 'Anubhav', start: d(1), end: d(5), createdAt: now } },
    bookings: { b1: { tripId: 'tr', type: 'flight', number: 'EJU2976', title: 'EJU2976 Munich (MUC) → Rome Fiumicino (FCO)', from: 'Munich (MUC)', to: 'Rome Fiumicino (FCO)', start: d(1), end: d(1) + 'T19:05', seat: 'Seat 22C', travellers: ['Anubhav Bhardwaj'], codes: [{ text: 'M1BHARDWAJ/ANUBHAV', format: 'aztec' }], createdAt: now },
      b2: { tripId: 'tr', type: 'hotel', title: 'AMINA Guest House', start: d(1) + 'T15:00', end: d(5), createdAt: now } } });
  await page.waitForTimeout(400);
  const t = await app.text('#nextUp');
  assert.match(t, /EJU2976 tomorrow · MUC → FCO · arr 19:05 · seat 22C/); assert.doesNotMatch(t, /seat Seat/i);
  assert.equal((t.match(/Boarding pass/gi) || []).length, 1, 'one boarding pass button, no second row for the same flight');
  assert.match(t, /Check in · AMINA Guest House/, 'the rest is still listed');
  const [h, n] = await Promise.all(['#page-overview .pagehead', '#nextUp'].map(s => page.$eval(s, e => e.getBoundingClientRect().top)));
  assert.ok(h < n, 'Overview title above Coming up');
  assert.match(await app.text('#kpis'), /INCOME|Income/);
  await clean(app);
});

test('invested: the money sent counts (Overview agrees with Goals and Transfers); the account says when its monthly value misses a transfer', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' } },
    income: { i1: { amount: 5000, date: m + '-01', source: 'Salary', category: 'Salary', account: 'Deutsche Bank', earner: 'Anubhav', createdAt: now } },
    transfers: { t1: { amount: 500, date: m + '-01', from: 'Deutsche Bank', to: 'T212', createdAt: now }, t2: { amount: 463, date: m + '-01', from: 'Deutsche Bank', to: 'T212', createdAt: now } },
    invSnapshots: { ['t_' + addDaysT(m + '-01', -1).slice(0, 7)]: { accountId: 't', month: addDaysT(m + '-01', -1).slice(0, 7), value: 10000, investment: 0, opening: true, createdAt: now }, ['t_' + m]: { accountId: 't', month: m, value: 10600, investment: 500, createdAt: now } } });
  await page.waitForTimeout(400);
  assert.match(await app.text('#kpis'), /€963 invested/, 'transfers, not the €500 the month’s value says');
  await app.go('wealth'); await page.waitForTimeout(300); await page.click('[data-acc="t"]'); await page.waitForTimeout(300);
  assert.match(await app.text('[data-putgap]'), /€963 went in by transfer in .*monthly value says €500 put in/);
  await clean(app);
});

test('net worth: an account first tracked this month is shown apart, not as growth', async () => {
  const app = await openApp(), { page } = app, m = month(0), pm = month(-1), now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav', createdAt: pm + '-01T08:00:00Z' }, fd: { name: 'FD', type: 'investment', invType: 'deposit', currency: 'EUR', owner: 'Sulekha' } },
    checkins: { c1: { accountId: 'db', date: pm + '-01', balance: 1000, createdAt: pm + '-01T08:00:00Z' } },
    invSnapshots: { fd_m: { accountId: 'fd', month: m, value: 7000, investment: 7000, opening: true, createdAt: now } } });
  await page.waitForTimeout(400);
  assert.match(await app.text('#kpis'), /Net worth today\s*€8,000\s*\+€0 since end of \w+ · plus €7,000 in accounts added in \w+/);
  await clean(app);
});

test('Ask AI is given the envelope budget (Ready to Assign, envelopes, overspent, per person), not the old hidden budgets', async () => {
  const app = await openApp(), { page } = app, m = month(0), now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    expenses: { e1: { amount: 80, date: m + '-02', store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } },
    settings: { budgets: { items: [{ c: 'Groceries', a: 500, f: false }], updatedAt: now },
      envelopes: { start: m + '-01', accounts: ['Deutsche Bank'], opening: 1000, openingBy: { 'Deutsche Bank': 1000 }, updatedAt: now, trips: false,
        groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'groc', name: 'Groceries', src: ['Groceries'], owner: 'Both' }] }], assigned: { [m]: { groc: 50 } }, targets: { groc: 300 } } } });
  await page.waitForTimeout(400);
  let body = null;
  await page.route('**/api/ask', async r => { body = JSON.parse(r.request().postData()); await r.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }); });
  await page.click('#aiBtn'); await page.fill('#aiInput', 'How are the envelopes?'); await page.click('#aiSend'); await page.waitForTimeout(400);
  assert.ok(body, 'asked');
  assert.match(body.context, /## Envelope budget for /); assert.match(body.context, /Ready to Assign 950: came in this month 0, assigned this month 50/);
  assert.match(body.context, /Groceries \| Flexible \| Both \| 50 \| -80 \| -30 \| 300 \| -/);
  assert.match(body.context, /Overspent: Groceries/); assert.doesNotMatch(body.context, /## Budgets for/);
  await clean(app);
});

// The October case: Sulekha's rent logged on Wise a minute before its balance (so counted in it), and the €900 from
// Raiffeisen logged weeks later on the same date (so counted on top): the budget and the balance disagree by €900.
const balDay = () => {
  const s = month(-1) + '-01', later = addDaysT(s, 25) + 'T22:10:00Z';
  return { s, later, seed: { accounts: { ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha', createdAt: s + 'T07:00:00Z' }, rf: { name: 'Raiffeisen', type: 'bank', currency: 'EUR', owner: 'Sulekha', createdAt: s + 'T07:00:00Z' } },
    checkins: { c1: { accountId: 'ws', date: s, balance: 4397, createdAt: s + 'T20:33:00Z' }, c2: { accountId: 'rf', date: s, balance: 14491, createdAt: s + 'T20:31:00Z' } },
    expenses: { rent: { amount: 900, date: s, store: 'Landlord', category: 'Rent', account: 'Wise Sulekha', spender: 'Sulekha', createdAt: s + 'T20:32:00Z' } },
    transfers: { tr: { amount: 900, date: s, from: 'Raiffeisen', to: 'Wise Sulekha', comment: 'Just for envelope purpose', createdAt: later } },
    settings: { envelopes: { start: s, accounts: ['Wise Sulekha'], opening: 4397, openingBy: { 'Wise Sulekha': 4397 }, trips: false, updatedAt: s + 'T21:00:00Z',
      groups: [{ id: 'g', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent', src: ['Rent'], owner: 'Sulekha' }] }], assigned: { [month(-1)]: { rent: 900 } } } } } };
};

test('budget vs accounts: a €900 gap is shown with its cause, and saying the transfer was already in that day’s balance closes it', async () => {
  const app = await openApp(), { page } = app, { seed } = balDay();
  await app.seed(seed); await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  let t = await app.text('[data-gapline]');
  assert.match(t, /Your accounts hold €900 more than the budget counts/);
  await page.click('[data-gapwhy]');
  t = await app.text('[data-gapline] .gapwhy');
  assert.match(t, /From Raiffeisen \+€900\.00 on Wise Sulekha, .* typed in on .*: counted on top of the €4,397\.00 you logged that day/);
  await page.click('[data-gapline] [data-inbal$="|1"]'); await page.waitForTimeout(300);
  assert.equal(await page.$('[data-gapline]'), null, 'agree now');
  const tr = (await dbDocs(app, 'transfers'))[0]; assert.deepEqual(tr.inBal, { 'wise sulekha': true }); assert.equal(tr.comment, 'Just for envelope purpose');
  // The account page says it, and can change it back.
  await app.go('wealth'); await page.waitForTimeout(200); await page.click('[data-wv="cash"]').catch(() => {}); await page.waitForTimeout(200); await page.click('[data-acc="ws"]'); await page.waitForTimeout(300);
  assert.match(await app.text('#accDetail'), /Balance now \(estimate\)\s*€4,397\.00/, 'rent and the €900 from Raiffeisen both in that day’s balance: they cancel');
  assert.match(await app.text('#accDetail .recent'), /From Raiffeisen.*in that day’s balance/);
  await clean(app);
});

test('budget vs accounts: "Add to Ready to Assign" records an adjustment (listed in Settings, removable); a kept starting amount shows what the entries say now', async () => {
  const app = await openApp(), { page } = app, { seed } = balDay();
  await app.seed(seed); await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  await page.click('[data-gapadj]'); await page.waitForTimeout(300);
  assert.equal(await page.$('[data-gapline]'), null);
  assert.match(await app.text('#budgetPanel .rta'), /Ready to Assign\s*€5,297\.00\s*€900 came in \(€900 adjusted\)/);
  const cfg = (await dbDocs(app, 'settings')).find(x => x.id === 'envelopes'); assert.equal(cfg.adjust.length, 1); assert.equal(cfg.adjust[0].amount, 900);
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envsetup]'); await page.waitForSelector('#envSetupDlg[open]');
  assert.match(await app.text('#esAdj'), /Adjustments to Ready to Assign.*\+€900\.00/);
  assert.match(await app.text('#esAccs'), /Wise Sulekha.*your entries now say €5,297\.00 Use/, 'the rent typed in before the balance makes the entries say 5,297 for the day before');
  await page.click('#esAdj [data-adjdel]'); await page.waitForTimeout(300);
  assert.equal((await dbDocs(app, 'settings')).find(x => x.id === 'envelopes').adjust.length, 0);
  await clean(app);
});

test('adding an entry dated on a day you logged that account’s balance asks which side of it the entry is on', async () => {
  const app = await openApp(), { page } = app, { s, seed } = balDay();
  await app.seed(seed); await page.waitForTimeout(400);
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.fill('#f-amount', '25'); await page.fill('#f-store', 'Pharmacy'); await page.fill('#f-category', 'Health'); await page.fill('#f-account', 'Wise Sulekha'); await page.fill('#f-date', s);
  await page.click('#saveBtn'); await page.waitForTimeout(200);
  assert.match(await app.text('#balAsk'), /You logged Wise Sulekha’s balance on .*: €4,397\.00\. Was this already in that balance, or did it come after\?/);
  assert.equal((await dbDocs(app, 'expenses')).length, 1, 'not saved yet');
  await page.click('[data-balans$="|0"]'); await page.waitForTimeout(300);
  assert.deepEqual((await dbDocs(app, 'expenses')).find(e => e.store === 'Pharmacy').inBal, { 'wise sulekha': false });
  // Today's date, no balance logged today: nothing to ask.
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.fill('#f-amount', '5'); await page.fill('#f-store', 'Bakery'); await page.fill('#f-category', 'Groceries'); await page.fill('#f-account', 'Wise Sulekha');
  await page.click('#saveBtn'); await page.waitForTimeout(300);
  assert.ok((await dbDocs(app, 'expenses')).some(e => e.store === 'Bakery' && !e.inBal));
  await clean(app);
});

test('checking in a balance lists that day’s entries on the account; untick what came after and it is saved on the entry', async () => {
  const app = await openApp(), { page } = app, now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    expenses: { e1: { amount: 40, date: td, store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now }, e2: { amount: 12, date: td, store: 'Cafe', category: 'Eating Out', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } } });
  await page.waitForTimeout(300); await app.go('wealth'); await page.waitForTimeout(200); await page.click('[data-wv="cash"]'); await page.waitForTimeout(200); await page.click('#checkinAll'); await page.waitForSelector('#ckDlg[open]');
  await page.fill('[data-ckacc="db"]', '1000'); await page.waitForTimeout(100);
  const t = await app.text('[data-ckday="db"]');
  assert.match(t, /tick what is already in this balance\..*Rewe\s*−€40\.00.*Cafe\s*−€12\.00/);
  await page.uncheck('[data-ckin="expense|e2|deutsche bank"]'); await page.click('#ckSave'); await page.waitForTimeout(300);
  const ex = await dbDocs(app, 'expenses');
  assert.deepEqual(ex.find(e => e.id === 'e2').inBal, { 'deutsche bank': false }); assert.equal(ex.find(e => e.id === 'e1').inBal, undefined, 'unchanged ones are left alone');
  await page.click('[data-acc="db"]'); await page.waitForTimeout(300);
  assert.match(await app.text('#accDetail'), /Balance now \(estimate\)\s*€988\.00/, '1000 minus the coffee that came after');
  await clean(app);
});

test('budget: when Common is short and Sulekha has money to spare, one tap prepares the transfer that puts it right', async () => {
  const app = await openApp({ mobile: true }), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  await app.seed({ accounts: { ws: { name: 'Wise Sulekha', type: 'bank', currency: 'EUR', owner: 'Sulekha' }, wc: { name: 'Wise Common', type: 'bank', currency: 'EUR', owner: 'Shared' } },
    checkins: { c1: { accountId: 'ws', date: s, balance: 3000, createdAt: s + 'T06:00:00Z' }, c2: { accountId: 'wc', date: s, balance: 200, createdAt: s + 'T06:00:00Z' } },
    settings: { envelopes: { start: s, accounts: ['Wise Sulekha', 'Wise Common'], opening: 3200, openingBy: { 'Wise Sulekha': 3000, 'Wise Common': 200 }, trips: false, updatedAt: now,
      groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'groc', name: 'Groceries', src: ['Groceries'], owner: 'Both' }, { id: 'su', name: 'Sulekha stuff', src: ['Shopping'], owner: 'Sulekha' }] }], assigned: { [m]: { groc: 800, su: 1000 } } } } });
  await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  assert.match(await app.text('.rwmove'), /Common is €600 short for the common envelopes; Sulekha has it to spare\.\s*Move €600 from Wise Sulekha to Wise Common/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'the suggestion wraps on a phone');
  await page.click('[data-whomove]'); await page.waitForSelector('#dlg[open]');
  assert.deepEqual(await Promise.all(['#f-account', '#f-to', '#f-amount'].map(sl => page.inputValue(sl))), ['Wise Sulekha', 'Wise Common', '600']);
  assert.match(await app.text('#dlg h2, #dlg h3, #dlgTitle'), /transfer/i);
  await clean(app);
});

test('budget: trips carry their month and empty ones fold away; a trip can count in an envelope of yours (with what was assigned for it)', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString(), td = d(0);
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    trips: { w: { name: 'Wedding in India', type: 'other', traveller: 'Both', start: d(10), end: d(30), budget: 3000, createdAt: now },
      a: { name: 'Munich visit', type: 'visit', traveller: 'Sulekha', start: d(40), end: d(42), createdAt: now }, b: { name: 'Munich visit', type: 'visit', traveller: 'Sulekha', start: d(100), end: d(102), createdAt: now },
      c: { name: 'Athens', type: 'holiday', traveller: 'Both', start: d(150), end: d(155), createdAt: now } },
    expenses: { e1: { amount: 400, date: td, store: 'Jeweller', category: 'Wedding', account: 'Deutsche Bank', spender: 'Anubhav', tripId: 'w', createdAt: now } },
    settings: { envelopes: { start: s, accounts: ['Deutsche Bank'], opening: 5000, trips: true, updatedAt: now,
      groups: [{ id: 'g', name: 'Wedding', envs: [{ id: 'wed', name: 'Wedding', src: ['Wedding'], owner: 'Anubhav' }] }], assigned: { [m]: { wed: 2000, t_w: 100 } } } } });
  await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  let t = await envText(app);
  const mo = k => new Date(d(k) + 'T12:00:00Z').toLocaleString('en-GB', { month: 'short' });
  assert.match(t, new RegExp(`Wedding in India · ${mo(10)} '\\d\\d\\s*€100\\s*−€400\\s*−€300`));
  assert.match(t, /3 more trips with nothing in them/);
  const html = await page.$eval('#budgetPanel', e => e.innerHTML);
  assert.ok(html.includes(`Munich visit · ${mo(40)}`) && html.includes(`Munich visit · ${mo(100)}`), 'the two Munich visits tell apart');
  await page.click('[data-envkey="t_w"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.match(await app.text('#eaQuick'), /Cover the overspending: €400/); assert.match(await app.text('#eaQuick'), /Up to the trip budget \(€3,000\): €2,700/);
  await page.selectOption('#eaTripEnv', 'wed'); await page.waitForTimeout(300);
  t = await envText(app);
  assert.match(t, /Wedding\s*€2,100\s*−€400\s*€1,700/, 'the trip’s spending and its €100 are in Wedding now'); assert.doesNotMatch(t, /Wedding in India/);
  await page.click('[data-envkey="wed"]'); await page.waitForSelector('#envAsgDlg[open]');
  assert.match(await app.text('#eaTrip'), /Also gets the spending of Wedding in India/);
  await page.keyboard.press('Escape');
  await app.go('trips'); await page.waitForTimeout(200); await page.click('[data-trip="w"]'); await page.waitForTimeout(300);
  assert.match(await app.text('#tripDetail'), /In the budget: €1,700\.00 in Wedding · Assign/);
  await clean(app);
});

test('envelope dialog: last month and the 3-month average from before the budget began; no button for the amount already there', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  const ex = {}; [1, 2, 3].forEach(k => { ex['p' + k] = { amount: 100 * k, date: month(-k) + '-05', store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now }; });
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } }, expenses: ex,
    settings: { envelopes: { start: s, accounts: ['Deutsche Bank'], opening: 1000, trips: false, updatedAt: now, targets: { groc: 250 },
      groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'groc', name: 'Groceries', src: ['Groceries'] }] }], assigned: { [m]: { groc: 250 } } } } });
  await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  await page.click('[data-envkey="groc"]'); await page.waitForSelector('#envAsgDlg[open]');
  const q = await app.text('#eaQuick');
  assert.match(q, /Spent last month: €100/); assert.match(q, /3-month average: €200/); assert.doesNotMatch(q, /Target/, 'already assigned the target');
  await clean(app);
});

test('investing: the goal says when its envelopes’ targets add up to something else (one tap to match); an account shows its envelope’s target', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav', target: 2000, returnPct: 7 } },
    invSnapshots: { t_m: { accountId: 't', month: m, value: 5000, investment: 0, opening: true, createdAt: now } },
    settings: { goals: { items: [{ type: 'invest', owner: 'Both', amount: 1500 }], updatedAt: now },
      envelopes: { start: s, accounts: ['Deutsche Bank'], opening: 3000, trips: false, updatedAt: now, targets: { t212: 1000, ulip: 300 },
        groups: [{ id: 'gs', name: 'Savings & investing', envs: [{ id: 't212', name: 'T212', src: ['→T212'], owner: 'Anubhav' }, { id: 'ulip', name: 'ULIPs', src: ['→ULIP'], owner: 'Anubhav' }] }], assigned: {} } } });
  await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  assert.match(await app.text('.goalline'), /its envelopes’ targets add up to €1,300 Make the goal €1,300/);
  await page.click('[data-goalset]'); await page.waitForTimeout(300);
  assert.equal((await dbDocs(app, 'settings')).find(x => x.id === 'goals').items[0].amount, 1300);
  await app.go('wealth'); await page.waitForTimeout(300); await page.click('[data-acc="t"]'); await page.waitForTimeout(300);
  assert.match(await app.text('#accDetail .tdhead'), /target €1,000 a month \(its envelope’s; the account said €2,000\)/);
  await clean(app);
});

test('adding: the form shows which envelope the entry lands in and what it leaves (card, no envelope, transfer out, income)', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, amex: { name: 'AMEX', type: 'card', currency: 'EUR', owner: 'Anubhav' },
      t: { name: 'T212', type: 'investment', invType: 'equity', currency: 'EUR', owner: 'Anubhav' }, rf: { name: 'Raiffeisen', type: 'bank', currency: 'EUR', owner: 'Sulekha' } },
    expenses: { e1: { amount: 58, date: s, store: 'Rewe', category: 'Groceries', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now } },
    settings: { envelopes: { start: s, accounts: ['Deutsche Bank', 'AMEX'], opening: 1000, openingBy: { 'Deutsche Bank': 1000, AMEX: 0 }, trips: false, updatedAt: now,
      groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'groc', name: 'Groceries', src: ['Groceries'] }, { id: 'inv', name: 'T212', src: ['→T212'] }] }], assigned: { [m]: { groc: 100, inv: 500 } } } } });
  await page.waitForTimeout(400);
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]');
  await page.fill('#f-date', s); await page.fill('#f-amount', '12'); await page.fill('#f-category', 'Groceries'); await page.fill('#f-store', 'Lidl'); await page.fill('#f-account', 'Deutsche Bank'); await page.waitForTimeout(100);
  assert.match(await app.text('#envPrev'), /Groceries: €42\.00 left → €30\.00 after this/);
  await page.fill('#f-account', 'AMEX'); await page.waitForTimeout(100);
  assert.match(await app.text('#envPrev'), /Groceries: €42\.00 left → €30\.00 after this · the money moves to AMEX’s payment envelope/);
  await page.fill('#f-category', 'Shoes'); await page.waitForTimeout(100);
  assert.match(await app.text('#envPrev'), /No envelope gets Shoes yet: it will show under Not assigned/);
  await page.fill('#f-account', 'Raiffeisen'); await page.waitForTimeout(100);
  assert.match(await app.text('#envPrev'), /Raiffeisen isn’t in the budget, so no envelope counts this/);
  await page.click('#kindSeg [data-kind="transfer"]'); await page.fill('#f-account', 'Deutsche Bank'); await page.fill('#f-to', 'T212'); await page.fill('#f-amount', '500'); await page.waitForTimeout(100);
  assert.match(await app.text('#envPrev'), /T212: €500\.00 left → €0\.00 after this/);
  await page.click('#kindSeg [data-kind="income"]'); await page.fill('#f-account', 'Deutsche Bank'); await page.fill('#f-amount', '3000'); await page.waitForTimeout(100);
  assert.match(await app.text('#envPrev'), /Into Ready to Assign: €400\.00 → €3,400\.00/);
  await clean(app);
});

test('left after envelopes: common groceries bought on Anubhav’s card are the common money’s to pay, not his', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' }, wc: { name: 'Wise Common', type: 'bank', currency: 'EUR', owner: 'Shared' }, amex: { name: 'AMEX', type: 'card', currency: 'EUR', owner: 'Anubhav' } },
    checkins: { c1: { accountId: 'db', date: s, balance: 1000, createdAt: s + 'T06:00:00Z' }, c2: { accountId: 'wc', date: s, balance: 500, createdAt: s + 'T06:00:00Z' }, c3: { accountId: 'amex', date: s, balance: 0, createdAt: s + 'T06:00:00Z' } },
    expenses: { e1: { amount: 100, date: s, store: 'Rewe', category: 'Groceries', account: 'AMEX', spender: 'Anubhav', createdAt: s + 'T09:00:00Z' } },
    settings: { envelopes: { start: s, accounts: ['Deutsche Bank', 'Wise Common', 'AMEX'], opening: 1500, openingBy: { 'Deutsche Bank': 1000, 'Wise Common': 500, AMEX: 0 }, trips: false, updatedAt: now,
      groups: [{ id: 'g', name: 'Flexible', envs: [{ id: 'groc', name: 'Groceries', src: ['Groceries'], owner: 'Both' }] }], assigned: { [m]: { groc: 300 } } } } });
  await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  const t = await app.text('.rwho summary');
  assert.match(t, /Anubhav\s*€1,000/); assert.match(t, /Common\s*€200/);
  await page.click('.rwho summary'); await page.waitForTimeout(100);
  assert.match(await app.text('.rwt'), /bank − cards\s*€1,000\s*€500 − €100/);
  await clean(app);
});

test('categories: "Rent - Anubhav" and "Rent - Sulekha" merge into Rent with subcategories; the envelope keeps getting both (with Undo)', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    expenses: { r1: { amount: 860, date: s, store: 'Landlord', category: 'Rent - Anubhav', account: 'Deutsche Bank', spender: 'Anubhav', createdAt: now },
      r2: { amount: 900, date: s, store: 'Landlord', category: 'Rent - Sulekha', account: 'Deutsche Bank', spender: 'Sulekha', createdAt: now } },
    settings: { envelopes: { start: s, accounts: ['Deutsche Bank'], opening: 3000, openingBy: { 'Deutsche Bank': 3000 }, trips: false, updatedAt: now,
      groups: [{ id: 'g', name: 'Fixed', envs: [{ id: 'rent', name: 'Rent', src: ['Rent - Anubhav', 'Rent - Sulekha'], owner: 'Both', split: { Anubhav: 860, Sulekha: 900 } }] }], assigned: { [m]: { rent: 1760 } } } } });
  await page.waitForTimeout(400); await app.go('budget'); await page.waitForTimeout(300);
  assert.match(await envText(app), /Rent\s*€1,760\s*−€1,760\s*€0/);
  await page.click('[data-envmore]'); await page.click('#budgetPanel [data-envcats]'); await page.waitForSelector('#envCatDlg[open]');
  assert.match(await app.text('#ecMerge'), /Rent - Anubhav and Rent - Sulekha look like one category\. Make them Rent, with Anubhav and Sulekha as subcategories\?.*2 entries change/);
  await page.click('[data-catmerge="0"]'); await page.waitForTimeout(500);
  const ex = await dbDocs(app, 'expenses');
  assert.deepEqual(ex.map(e => [e.category, e.subcategory]).sort(), [['Rent', 'Anubhav'], ['Rent', 'Sulekha']]);
  assert.deepEqual((await dbDocs(app, 'settings')).find(x => x.id === 'envelopes').groups[0].envs[0].src, ['Rent›Anubhav', 'Rent›Sulekha']);
  assert.equal(await page.isHidden('#ecMerge'), true);
  await page.click('#ecCancel'); await page.waitForTimeout(200);
  assert.match(await envText(app), /Rent\s*€1,760\s*−€1,760\s*€0/, 'the envelope still gets both');
  await clean(app);
});

test('adding income into the budget says what there is to assign, one tap from the Budget page', async () => {
  const app = await openApp(), { page } = app, m = month(0), s = m + '-01', now = new Date().toISOString();
  await app.seed({ accounts: { db: { name: 'Deutsche Bank', type: 'bank', currency: 'EUR', owner: 'Anubhav' } },
    settings: { envelopes: { start: s, accounts: ['Deutsche Bank'], opening: 100, openingBy: { 'Deutsche Bank': 100 }, trips: false, updatedAt: now, groups: [], assigned: {} } } });
  await page.waitForTimeout(400);
  await page.click('#addBtn'); await page.waitForSelector('#dlg[open]'); await page.click('#kindSeg [data-kind="income"]');
  await page.fill('#f-amount', '4950.38'); await page.fill('#f-store', 'PAYBACK'); await page.fill('#f-account', 'Deutsche Bank');
  await page.click('#saveBtn'); await page.waitForTimeout(300);
  assert.match(await app.text('#toast'), /Added €4,950\.38 from PAYBACK: \+?€5,050\.38 to assign\s*Assign/);
  await page.click('#toast button'); await page.waitForTimeout(300);
  assert.match(await page.evaluate(() => location.hash), /budget/);
  await clean(app);
});
