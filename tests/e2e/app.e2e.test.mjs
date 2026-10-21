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
  await page.waitForSelector('#goalsP [data-goalnew]');
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
  await page.click('#profBtn'); await page.click('[data-pm="sync"]'); await page.waitForSelector('#syDlg[open]');
  assert.match(await app.text('#syBody'), /Nothing waiting to upload/);
  await page.click('#syCheck'); await page.waitForTimeout(200);
  assert.match(await app.text('#syBody'), /expenses \(last 30 days\): 1 on the server, 1 on this device · match/);
  await clean(app);
});

test('bookings: a large camera photo is scaled down and read', async () => {
  const app = await openApp({ mobile: true }), { page } = app;
  const sent = [];
  await page.route('http://app.test/api/extract', async r => { sent.push(r.request().postDataJSON()); await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bookings: [{ type: 'hotel', title: 'Hotel Test, Rome', start: '2027-03-25', end: '2027-03-28', price: 300, currency: 'EUR' }] }) }); });
  await page.click('#profBtn'); await page.click('[data-addbk]:not([hidden])'); await page.waitForSelector('#bkDlg[open]');
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
