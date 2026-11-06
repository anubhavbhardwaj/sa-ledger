import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amounts, voluntary, payout, fixSlip, checkSlip } from '../../public/payslip-check.js';
import { handle as payslip } from '../../netlify/functions/payslip.mjs';
import { verify, req, fakeGroq } from '../support/fakes.mjs';

// A made-up slip in the DATEV layout PAYBACK uses, as the app sends it (pdf.js rows, items joined by " | "):
// a voluntary health insurance member, so the KV and PV columns of the insurance rows are empty, and no church tax.
const DATEV = [
  'Gesamtbrutto  |  8000,00',
  'Steuerbrutto  |  Lohnsteuer  |  Kirchensteuer  |  Solidaritätsz.',
  'Laufender Bezug  |  8000,00  |  1900,00  |  37,10  |  1937,10-',
  'Soz-Vers-Brutto  |  KV  |  RV  |  AV  |  PV',
  'SV-Beitrag lfd.  |  744,00  |  104,00  |  848,00-',
  'Netto  |  5214,90',
  '968 KV-AG-Zus.  |  450,00', '968 KV-Gesamtb  |  900,00-', '968 PV-AG-Zus.  |  90,00', '968 PV-Gesamtb  |  210,00-',
  'Auszahlung / Überweisung  |  4644,90',
  'Jahreswerte', 'Bezug (lfd + sonst)  |  12000,00  |  2850,00  |  55,65', 'SV-Beitrag  |  1116,00  |  156,00',
].join('\n');

test('payslip check: amounts in German and English format', () => {
  assert.deepEqual(amounts('SV-Beitrag lfd.  |  744,00  |  104,00  |  848,00-'), [744, 104, 848]);
  assert.deepEqual(amounts('Bank transfer | 2,100.00 | EUR'), [2100]);
  assert.deepEqual(amounts('Gesamtbrutto 12.345,67'), [12345.67]);
});

test('payslip check: a voluntary member’s share is the whole contribution less the allowance; net is what was paid out', () => {
  assert.deepEqual(voluntary(DATEV), { kv: 450, pv: 120 });
  assert.equal(payout(DATEV), 4644.9);
  const en = 'Pay-Off Contrib. Volun. H  |  -480.00\nER Allowance HI  |  240.00\nDed. Contrib. Vol. CI  |  -110.00\nER nursing subsidy  |  45.00\nBank transfer  |  2,100.00  |  EUR';
  assert.deepEqual(voluntary(en), { kv: 240, pv: 65 });
  assert.equal(payout(en), 2100);
  assert.deepEqual(voluntary('KV-AN  |  600,00\nRV-AN  |  700,00'), {}, 'a compulsory member’s slip has none of these lines');
  assert.equal(payout('Auszahlung Resturlaub  |  800,00\nAuszahlung / Überweisung  |  3100,00'), 3100, 'the last payout line, not a kind of pay');
});

test('payslip check: shifted columns and Soli read as church tax are repaired from the reading', () => {
  // What the reader got wrong on a slip like DATEV: the insurance numbers moved left into the empty KV column, the Soli
  // into the empty church tax column, the statutory net as net pay; in the year to date, the same shift.
  const read = { month: '2026-10', employer: 'PAYBACK', taxGross: 8000, oneOff: 0, lst: 1900, soli: null, kist: 37.1, kv: 744, rv: 104, av: null, pv: null, net: 5214.9,
    ytd: { taxGross: 12000, lst: 2850, kist: 55.65, kv: 1116, rv: 156 } };
  const { slip, fixes } = fixSlip(read, DATEV);
  assert.deepEqual([slip.rv, slip.av, slip.kv, slip.pv, slip.soli, slip.kist, slip.net], [744, 104, 450, 120, 37.1, 0, 4644.9]);
  assert.deepEqual(slip.ytd, { taxGross: 12000, lst: 2850, soli: 55.65, kist: 0, rv: 1116, av: 156 }, 'year to date: health and care aren’t on the slip');
  assert.ok(fixes.some(f => /^Pension 744\.00 and unemployment 104\.00 were in the wrong fields/.test(f)));
  assert.ok(fixes.some(f => /Year to date: pension 1116\.00/.test(f)));
  assert.ok(fixes.some(f => /^37\.10 is the Soli/.test(f)));
  assert.deepEqual(checkSlip(slip), [], 'nothing left to check');
  assert.equal(read.kv, 744, 'the reading itself is left as it was');
  // A right reading of a compulsory member's slip stays as it is.
  const ok = { month: '2026-03', employer: 'X', taxGross: 6000, lst: 1300, soli: 0, kist: 104, rv: 558, av: 78, kv: 519, pv: 144, net: 3297 };
  assert.deepEqual(fixSlip(ok, 'Auszahlung  |  3297,00'), { slip: ok, fixes: [] });
});

test('payslip check: figures that don’t fit the rules are named', () => {
  const base = { taxGross: 8000, lst: 1900, soli: 37.1, kist: 0, rv: 744, av: 104, kv: 450, pv: 120 };
  assert.deepEqual(checkSlip(base), []);
  assert.match(checkSlip({ ...base, kv: 744, rv: 104, av: null }).join(' '), /health \(744\.00\) looks like the pension figure/i);
  assert.match(checkSlip({ ...base, av: 60 }).join(' '), /pension \(744\.00\) and unemployment \(60\.00\) don’t fit/i);
  assert.match(checkSlip({ ...base, rv: 104, av: null }).join(' '), /under 3% of the pay/i);
  assert.match(checkSlip({ ...base, soli: 152 }).join(' '), /Soli \(152\.00\) is more than 5\.5%/i);
  assert.match(checkSlip({ ...base, kist: 37.1 }).join(' '), /church tax \(37\.10\) is 2\.0% of the wage tax/i);
  assert.deepEqual(checkSlip({ ...base, kist: 37.1 }, { church: false }), [], 'the estimate checks church tax across all slips instead');
  assert.match(checkSlip({ ...base, kv: 900 }).join(' '), /health \(900\.00\) is more than your share can be/i);
  assert.match(checkSlip({ ...base, ytd: { taxGross: 12000, rv: 156, kv: 1116 } }).join(' '), /^Year to date: health \(1116\.00\) looks like the pension figure/i);
});

test('payslip reader: the answer comes back repaired, with what was corrected', async () => {
  const r = await payslip(req({ text: DATEV }), { env: { GROQ_API_KEY: 'g' }, verify,
    fetch: fakeGroq({ month: '2026-10', employer: 'PAYBACK', taxGross: 8000, lst: 1900, kist: 37.1, kv: 744, rv: 104, net: 5214.9 }) });
  const j = await r.json();
  assert.deepEqual([j.slip.rv, j.slip.av, j.slip.kv, j.slip.pv, j.slip.soli, j.slip.kist, j.slip.net], [744, 104, 450, 120, 37.1, 0, 4644.9]);
  assert.ok(j.fixes.length >= 4);
});
