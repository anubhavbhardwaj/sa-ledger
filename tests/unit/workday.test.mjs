import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAsk, sign, checkSig, holidaysBY } from '../../netlify/lib/workday.mjs';
import { run, message } from '../../netlify/functions/workday-ask.mjs';
import { handle } from '../../netlify/functions/workday.mjs';

const tax = { jobs: [{ name: 'MMS', from: '2026-01-01', to: '2026-09-15', km: 6, mode: 'share', share: 50 }, { name: 'PAYBACK', from: '2026-09-16', km: 80, mode: 'log', days: [1, 2, 3, 4] }] };
const KEY = 'test-private-key';

test('workday question: only on logged workdays that are not holidays, trips or answered', () => {
  assert.equal(shouldAsk('2026-10-19', { tax }), null, 'a Monday at PAYBACK');
  assert.equal(shouldAsk('2026-10-18', { tax }), 'weekend');
  assert.equal(shouldAsk('2026-11-01', { tax }), 'weekend');
  assert.ok(holidaysBY(2026).has('2026-12-25'));
  assert.equal(shouldAsk('2026-12-25', { tax }), 'holiday');
  assert.equal(shouldAsk('2026-09-14', { tax }), 'no workplace logged day by day', 'MMS is a 50:50 split');
  assert.equal(shouldAsk('2026-10-19', { tax, answered: true }), 'already answered');
  assert.equal(shouldAsk('2026-10-21', { tax, trips: [{ traveller: 'Both', start: '2026-10-20', end: '2026-10-23' }] }), 'on a trip');
  assert.equal(shouldAsk('2026-10-20', { tax, trips: [{ traveller: 'Both', start: '2026-10-20', end: '2026-10-23' }] }), null, 'first day of a trip is asked');
  assert.equal(shouldAsk('2026-10-21', { tax, trips: [{ traveller: 'Sulekha', start: '2026-10-20', end: '2026-10-23' }] }), null);
  assert.equal(shouldAsk('2026-12-29', { tax, leave: { years: { 2026: { shutdown: { start: '2026-12-24', end: '2027-01-02' } } } } }), 'shutdown');
  assert.equal(shouldAsk('2026-10-19', { tax: { ...tax, ask: false } }), 'turned off');
});

test('workday question: sent at 9:00 Berlin to Anubhav only, with Office/Home buttons and a signature', async () => {
  const sent = [];
  const load = async () => ({ tax, tokens: [{ id: 't1', email: 'anubhav.iiitb@gmail.com' }, { id: 't2', email: 'sulekha@sa-ledger.app' }] });
  const send = async m => { sent.push(m); };
  assert.match((await run({ now: new Date('2026-10-19T08:00:00Z'), key: KEY, load, send, dropTokens: async () => {} })).skipped, /not 9:00/);
  const r = await run({ now: new Date('2026-10-19T07:00:00Z'), key: KEY, load, send, dropTokens: async () => {} });
  assert.equal(r.sent, 1); assert.equal(sent.length, 1); assert.equal(sent[0].token, 't1');
  assert.equal(sent[0].data.date, '2026-10-19');
  assert.ok(checkSig('2026-10-19', sent[0].data.sig, KEY));
  assert.deepEqual(JSON.parse(sent[0].data.actions).map(a => a.action), ['office', 'home']);
  assert.equal(message('2026-10-19', KEY).url, '/#workday');
});

test('workday answer: saves with a valid signature, refuses anything else', async () => {
  const saved = [], db = () => ({ collection: c => ({ doc: id => ({ set: async v => saved.push([c, id, v]) }) }) });
  const env = { FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ private_key: KEY }) }, now = new Date('2026-10-19T07:05:00Z');
  const post = b => new Request('https://x/api/workday', { method: 'POST', body: JSON.stringify(b) });
  const ok = await handle(post({ date: '2026-10-19', where: 'office', sig: sign('2026-10-19', KEY) }), { env, db, now });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved[0].slice(0, 2), ['workdays', 'anubhav_2026-10-19']);
  assert.equal(saved[0][2].where, 'office');
  assert.equal((await handle(post({ date: '2026-10-20', where: 'office', sig: sign('2026-10-19', KEY) }), { env, db, now })).status, 403, 'signature of another day');
  assert.equal((await handle(post({ date: '2026-10-19', where: 'beach', sig: sign('2026-10-19', KEY) }), { env, db, now })).status, 400);
  assert.equal((await handle(post({ date: '2026-09-01', where: 'home', sig: sign('2026-09-01', KEY) }), { env, db, now })).status, 400, 'expired');
  assert.equal(saved.length, 1);
});

import { clean as cleanSlip, handle as payslip } from '../../netlify/functions/payslip.mjs';
import { verify, req, fakeGroq } from '../support/fakes.mjs';
test('payslip: numbers in German or English format, employee shares, year to date kept', async () => {
  const s = cleanSlip({ month: '2026-08', employer: 'MMS', taxGross: '7.668,75', lst: 1712.5, rv: '713.19', kv: null, ytd: { taxGross: '61,421.30', lst: 'x' } });
  assert.equal(s.taxGross, 7668.75); assert.equal(s.rv, 713.19); assert.equal(s.kv, null);
  assert.deepEqual(s.ytd, { taxGross: 61421.3 });
  assert.equal(cleanSlip({ month: 'August' }).month, null);
  const r = await payslip(req({ text: 'Entgeltabrechnung August 2026 '.repeat(5) }), { env: { GROQ_API_KEY: 'g' }, verify, fetch: fakeGroq({ month: '2026-08', employer: 'MMS', taxGross: 7668.75, lst: 1700 }) });
  assert.equal((await r.json()).slip.lst, 1700);
  assert.equal((await payslip(req({ text: 'x' }), { env: { GROQ_API_KEY: 'g' }, verify })).status, 400);
});
