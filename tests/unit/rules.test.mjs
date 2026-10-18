import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedFields } from '../support/rules.mjs';

const app = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const keys = name => { const m = app.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`)); assert.ok(m, name + ' not found in index.html'); return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]); };

test('the rules file parses into every collection the app writes', () => {
  const a = allowedFields();
  for (const c of ['expenses', 'income', 'transfers', 'trips', 'accounts', 'checkins', 'invSnapshots', 'bookings', 'toBook', 'settings', 'pushTokens', 'workdays', 'payslips']) assert.ok(a[c]?.length, c);
});

// Every field list the app saves with must be allowed by the rules, or the save fails with "permission denied".
for (const [list, col] of [['EXP_KEYS', 'expenses'], ['INC_KEYS', 'income'], ['TR_KEYS', 'transfers'], ['TRIP_KEYS', 'trips'], ['BK_KEYS', 'bookings'], ['TB_KEYS', 'toBook'], ['FIRE_KEYS', 'settings'], ['PEN_KEYS', 'settings']]){
  test(`${list} fits the ${col} rules`, () => {
    const allowed = allowedFields()[col], extra = keys(list).filter(k => !allowed.includes(k));
    assert.deepEqual(extra, [], `${list} has fields the rules refuse: ${extra.join(', ')}`);
  });
}
