import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle as tripAi } from '../../netlify/functions/trip-ai.mjs';
import { clean as cleanToBook, handle as toBook } from '../../netlify/functions/tobook.mjs';
import { clean as cleanBooking } from '../../netlify/functions/extract.mjs';
import { message as dailyMessage, dueLines } from '../../netlify/functions/daily.mjs';
import { verify, req, fakeGroq } from '../support/fakes.mjs';

test('trip AI: only ids it was given, no duplicates, no em dashes', async () => {
  const sent = [];
  const r = await tripAi(req({ context: 'Easter', conditions: 'no Ryanair', options: [{ id: 'a1', text: 'one' }, { id: 'a2', text: 'two' }] }),
    { env: { GROQ_API_KEY: 'g' }, verify, fetch: fakeGroq({ summary: 'Go Wednesday — it is cheapest', picks: [{ id: 'a2', label: 'Late', why: 'x — y' }, { id: 'zz' }, { id: 'a2' }] }, sent) });
  const j = await r.json();
  assert.deepEqual(j.picks.map(p => p.id), ['a2']);
  assert.ok(!/—/.test(j.summary + j.picks[0].why));
  assert.match(sent[0].messages[1].content, /no Ryanair/);
  assert.match(sent[0].messages[1].content, /\[a1\] one/);
});
test('trip AI: needs options and the Groq key', async () => {
  assert.equal((await tripAi(req({ options: [] }), { env: { GROQ_API_KEY: 'g' }, verify })).status, 400);
  assert.equal((await tripAi(req({ options: [{ id: 'a', text: 'x' }] }), { env: {}, verify })).status, 503);
});
test('to book: cleans what the model returns, keeps the AI-estimate flag', async () => {
  const out = cleanToBook([{ what: 'Flight', type: 'flight', forDate: '2027-03-25', byDate: '2027-04-01', price: 120.4, estimated: true }, { what: '' }, { what: 'Hotel', type: 'spa', price: -1 }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].byDate, null, 'deadline after the date is dropped');
  assert.equal(out[0].price, 120);
  assert.equal(out[0].estimated, true);
  assert.equal(out[1].type, 'other');
  const r = await toBook(req({ text: 'flights', trip: { name: 'Rome' } }), { env: { GROQ_API_KEY: 'g' }, verify, fetch: fakeGroq({ items: [{ what: 'Flight MUC → FCO', type: 'flight' }] }) });
  assert.equal((await r.json()).items.length, 1);
});
test('booking extraction: only well-formed fields survive', () => {
  const [b] = cleanBooking([{ type: 'flight', number: 'LH1840', start: '2027-03-25T07:10:00', end: '2027-03-24', price: '129.5', currency: 'eur', codes: [0, 5, 'x'] }], 1);
  assert.equal(b.start, '2027-03-25T07:10');
  assert.equal(b.end, undefined, 'end before start is dropped');
  assert.equal(b.price, 129.5);
  assert.equal(b.currency, 'EUR');
  assert.deepEqual(b.codes, [0]);
  assert.ok(b.title);
});
test('evening reminder: quiet when the day is logged and nothing waits', () => {
  assert.equal(dailyMessage('Anubhav', { added: 3, inbox: 0, bookings: 0 }), null);
  assert.match(dailyMessage('Anubhav', { added: 0, inbox: 2, bookings: 0 }).body, /2 captured payments/);
  const due = dueLines([{ what: 'Hotel', tripId: 't', byDate: '2026-10-17', done: false }], { t: { name: 'Rome' } }, '2026-10-16');
  assert.deepEqual(due, ['Hotel (Rome) by tomorrow']);
});

import { handle as extract } from '../../netlify/functions/extract.mjs';
test('booking extraction: a retired vision model is skipped for the next one', async () => {
  const resp = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const seen = [];
  const r = await extract(req({ text: '', image: 'data:image/jpeg;base64,AAAA', name: 'Photo.jpg' }), { env: { GROQ_API_KEY: 'g', GROQ_VISION_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct' }, verify,
    fetch: async (u, o) => { const b = JSON.parse(o.body); seen.push(b.model);
      return b.model.startsWith('meta-llama') ? resp(404, { error: { message: 'The model `meta-llama/llama-4-scout-17b-16e-instruct` does not exist or you do not have access to it.', code: 'model_not_found' } })
        : resp(200, { choices: [{ message: { content: '{"bookings":[{"type":"hotel","title":"Hotel Test, Rome","start":"2027-03-25","end":"2027-03-28"}]}' } }] }); } });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3.8-27b']);
  assert.equal((await r.json()).bookings[0].title, 'Hotel Test, Rome');
});
