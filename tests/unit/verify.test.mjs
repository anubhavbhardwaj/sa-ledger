import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPhoto, lev, osa, checkPassport, checkDate, datesIn, passportAlerts } from '../../public/verify.js';

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

test('verify: passport number exact, typo, swapped digits, photo misreads', () => {
  assert.equal(checkPassport('Z1234567', 'Passport no.: Z1234567').status, 'ok');
  assert.equal(checkPassport('Z1234567', 'Passport Z 123 4567').status, 'ok');
  assert.deepEqual(checkPassport('Z1234567', 'Passport Z1234576'), { status: 'near', seen: 'Z1234576' });
  assert.deepEqual(checkPassport('Z1234567', 'Passport Z123456'), { status: 'near', seen: 'Z123456' });
  assert.equal(checkPassport('C01X00T47', 'Pass C0lX0OT47').status, 'check');
  assert.equal(checkPassport('Z1234567', 'Phone +49 151 23425746, booking ABC123').status, 'missing');
  assert.equal(osa('2031', '2013'), 1); assert.equal(lev('2031', '2013'), 2);
});
test('verify: expiry dates in many formats; day/month order; issue date is not a typo', () => {
  for (const t of ['Expiry 11.03.2031', 'valid until 2031-03-11', '11 Mar 2031', '11. März 2031', 'March 11th, 2031', '11 MAR 2031'])
    assert.equal(checkDate('2031-03-11', t).status, 'ok', t);
  assert.equal(checkDate('2031-03-25', 'Expiry 25/03/2031').status, 'ok');
  const amb = checkDate('2031-03-11', 'Expiry 11/03/2031'); assert.equal(amb.status, 'check'); assert.match(amb.note, /day first/);
  assert.equal(checkDate('2031-03-11', 'Expiry 03.11.2031').status, 'near');
  assert.equal(checkDate('2031-03-11', 'Expiry 12.03.2031').status, 'near');
  assert.equal(checkDate('2031-03-11', 'Expiry 11.03.2013').status, 'near');
  assert.equal(checkDate('2031-03-11', 'Date of issue 11.03.2021').status, 'missing');
  assert.equal(checkDate('2031-03-11', 'Born 11.03.1994').status, 'missing');
  assert.equal(datesIn('31/12/2030').length, 1);
});
test('verify: passport rows on a form; found by the number even without the name', () => {
  const p = { first: 'Anubhav', last: 'Bhardwaj', passport: 'Z1234567', passportExp: '2031-03-11' };
  const [r] = checkPhoto([p], 'Mr ANUBHAV BHARDWAJ\nPassport Z1234576\nExpiry 11.03.2031');
  const by = Object.fromEntries(r.rows.map(x => [x.field, x]));
  assert.equal(by['Passport number'].status, 'near'); assert.equal(by['Passport expiry'].status, 'ok'); assert.equal(by['Passport expiry'].expected, '11 Mar 2031');
  assert.equal(r.problems, 1);
  assert.equal(checkPhoto([p], 'Document Z1234567').length, 1);
});
test('verify: passport alerts for expiry and trips', () => {
  const td = '2026-10-25', trips = [{ name: 'Italy', type: 'holiday', traveller: 'Both', start: '2027-04-01', end: '2027-04-10' },
    { name: 'Munich', type: 'office', traveller: 'Anubhav', start: '2027-04-01', end: '2027-04-02' }, { name: 'Past', type: 'visit', traveller: 'Both', start: '2026-01-01', end: '2026-01-05' }];
  assert.match(passportAlerts({ first: 'Anubhav', passportExp: '2026-10-01' }, [], td)[0].text, /expired/);
  assert.match(passportAlerts({ first: 'Anubhav', passportExp: '2027-03-01' }, [], td)[0].text, /under 6 months/);
  assert.equal(passportAlerts({ first: 'Anubhav', passportExp: '2027-08-01' }, [], td)[0].level, 'warn');
  const a = passportAlerts({ first: 'Anubhav', passportExp: '2027-09-01' }, trips, td);
  assert.equal(a.length, 2); assert.match(a[1].text, /Trip “Italy” ends on 10 Apr 2027/);
  assert.match(passportAlerts({ first: 'Sulekha', passportExp: '2027-04-05' }, trips, td).at(-1).text, /expires before the trip “Italy”/);
  assert.deepEqual(passportAlerts({ first: 'Mother', passportExp: '2032-01-01' }, trips, td), []);
});

import { handle as ocr } from '../../netlify/functions/ocr.mjs';
import { verify, req } from '../support/fakes.mjs';
test('ocr fallback: returns the transcribed text, refuses a missing image', async () => {
  const r = await ocr(req({ image: 'data:image/jpeg;base64,AAAA' }), { env: { GROQ_API_KEY: 'g' }, verify,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"text":"Mr ANUBHAV BHARDWAJ"}' } }] }) }) });
  assert.equal((await r.json()).text, 'Mr ANUBHAV BHARDWAJ');
  assert.equal((await ocr(req({}), { env: { GROQ_API_KEY: 'g' }, verify })).status, 400);
});
