import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPhoto, lev } from '../../public/verify.js';

const people = [
  { first: 'Anubhav', last: 'Bhardwaj', gender: 'male', email: 'anubhav.iiitb@gmail.com', phone: '+49 151 23425746', relation: 'Me' },
  { first: 'Sulekha', last: 'Sharma', gender: 'female', email: 'sulekha@example.com', phone: '+39 333 1234567', relation: 'Fiancée' },
];
test('verify: an exact form is confirmed', () => {
  const [r] = checkPhoto(people, 'Passenger 1\nMr  ANUBHAV  BHARDWAJ\nEmail: anubhav.iiitb@gmail.com\nMobile +49 151 2342 5746');
  assert.equal(r.person.first, 'Anubhav'); assert.equal(r.problems, 0);
  assert.deepEqual(r.rows.map(x => x.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
});
test('verify: typos on the form are flagged with what it shows', () => {
  const [r] = checkPhoto(people, 'Passenger: Ms SULEKA SHARMA\nE-mail sulekha@exampel.com\nPhone 0039 333 1234 557');
  const by = Object.fromEntries(r.rows.map(x => [x.field, x]));
  assert.equal(by['First name'].status, 'near'); assert.equal(by['First name'].seen, 'suleka');
  assert.equal(by['Last name'].status, 'ok');
  assert.equal(by.Email.status, 'near');
  assert.equal(by.Phone.status, 'near');
  assert.equal(by['Gender / title'].status, 'ok');
});
test('verify: wrong title is a conflict; people not on the photo are left out', () => {
  const res = checkPhoto(people, 'Traveller: Mrs Anubhav Bhardwaj');
  assert.equal(res.length, 1);
  assert.equal(res[0].rows.find(x => x.field === 'Gender / title').status, 'conflict');
  assert.deepEqual(checkPhoto(people, 'Hotel Roma, check-in 15:00'), []);
});
test('verify: edit distance', () => { assert.equal(lev('anubhav', 'anubav'), 1); assert.equal(lev('kitten', 'sitting'), 3); });

import { handle as ocr } from '../../netlify/functions/ocr.mjs';
import { verify, req } from '../support/fakes.mjs';
test('ocr fallback: returns the transcribed text, refuses a missing image', async () => {
  const r = await ocr(req({ image: 'data:image/jpeg;base64,AAAA' }), { env: { GROQ_API_KEY: 'g' }, verify,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"text":"Mr ANUBHAV BHARDWAJ"}' } }] }) }) });
  assert.equal((await r.json()).text, 'Mr ANUBHAV BHARDWAJ');
  assert.equal((await ocr(req({}), { env: { GROQ_API_KEY: 'g' }, verify })).status, 400);
});
