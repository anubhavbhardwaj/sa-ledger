import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formPayload, peopleText, bookmarkletSource, bookmarklet, fillForm } from '../../public/fill.js';

const people = [{ id: 'a', relation: 'Me', first: 'Anubhav', last: 'Bhardwaj', gender: 'male', passport: 'Z1234567', passportExp: '2031-03-11', email: 'a@example.com', phone: '+49 151 23425746' }];
test('fill: the copied data has only form details, with a marker', () => {
  const d = formPayload(people);
  assert.equal(d.saLedger, 1); assert.deepEqual(Object.keys(d.people[0]).sort(), ['email', 'first', 'gender', 'last', 'passport', 'passportExp', 'phone']);
});
test('fill: copy as text', () => {
  const t = peopleText(people);
  assert.match(t, /^Anubhav Bhardwaj\nFirst name\(s\): Anubhav\nLast name: Bhardwaj\nGender: Male\nPassport number: Z1234567\nPassport expiry: 11 Mar 2031 \(11\.03\.2031\)/);
});
test('fill: the bookmark is valid JavaScript and carries no personal data', () => {
  assert.doesNotThrow(() => new Function(bookmarkletSource()));
  const b = decodeURIComponent(bookmarklet().slice('javascript:'.length));
  assert.ok(!/Anubhav|Bhardwaj|Z1234567|example\.com/.test(b));
  assert.doesNotMatch(fillForm.toString(), /(^|[^:])\/\/ /, 'no // comments inside the bookmark code');
});
