// Payslip figures checked against the rules they follow, used by the payslip reader (server) and the check dialog
// and estimate (app). The AI reading a payslip can put a figure in the wrong field, most often where the slip leaves
// a column empty: a voluntary health insurance member's slip has no health and care contributions in the insurance
// rows (PAYBACK: "KV RV AV PV" with only RV and AV filled), and a slip without church tax has an empty church column
// next to the Soli. The rules: the employee pays 9.3% pension and 1.3% unemployment insurance on the same pay (so
// pension is 7.15 times unemployment), Soli is at most 5.5% of the wage tax, church tax is 8% (Bavaria,
// Baden-Württemberg) or 9% of it.

export const RV_AV = 9.3 / 1.3;
const near = (v, t, tol) => v > 0 && Math.abs(v / t - 1) <= tol;
const pos = v => typeof v === 'number' && isFinite(v) && v > 0;
const r2 = v => Math.round(v * 100) / 100;
const INS = ['kv', 'rv', 'av', 'pv'];

// Amounts on a line of text, in order: "502,50-" (German), "1,004.99" or "251.25" (English) → numbers.
export function amounts(line){
  return [...String(line).matchAll(/\d{1,3}(?:\.\d{3})+,\d{2}(?!\d)|\d{1,3}(?:,\d{3})+\.\d{2}(?!\d)|\d+,\d{2}(?!\d)|\d+\.\d{2}(?!\d)/g)].map(m => {
    const t = m[0]; return parseFloat(/,\d{2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''));
  });
}
// The last amount on the first (or, with last, the last) line matching re, or null.
function lineAmount(text, re, last = false){
  let v = null;
  for (const line of String(text).split('\n')) if (re.test(line)){ const a = amounts(line.replace(re, ' ')); if (a.length){ v = a[a.length - 1]; if (!last) return v; } }
  return v;
}

// Voluntary members: the slip shows the whole contribution the employer pays to the health insurer and the employer's
// allowance; your share is the difference. German (PAYBACK, DATEV) and English (MediaMarktSaturn) labels.
const VOL = {
  kv: { total: [/KV-Gesamtb\w*/i, /Pay-?Off Contrib\.?\s*Volun\.?\s*H\b/i, /Gesamtbeitrag\s*(?:KV|Kranken\w*)/i],
        sub: [/KV-AG-Zus\w*\.?/i, /ER Allowance HI/i, /(?:AG-)?Zuschuss\s*(?:KV|Kranken\w*)/i], share: [0.35, 0.65] },
  pv: { total: [/PV-Gesamtb\w*/i, /Ded\.?\s*Contrib\.?\s*Vol\.?\s*CI\b/i, /Gesamtbeitrag\s*(?:PV|Pflege\w*)/i],
        sub: [/PV-AG-Zus\w*\.?/i, /ER nursing subsidy/i, /(?:AG-)?Zuschuss\s*(?:PV|Pflege\w*)/i], share: [0.2, 0.65] } };
export function voluntary(text){
  const out = {};
  for (const [k, d] of Object.entries(VOL)){
    const total = d.total.map(re => lineAmount(text, re)).find(v => v > 0), sub = d.sub.map(re => lineAmount(text, re)).find(v => v > 0);
    if (total > 0 && sub > 0 && sub / total >= d.share[0] && sub / total <= d.share[1]) out[k] = r2(total - sub);
  }
  return out;
}
// What reached the bank: "Auszahlung / Überweisung", "Auszahlungsbetrag", "Bank transfer". The last such line, since
// it closes the slip ("Auszahlung Resturlaub" higher up is a kind of pay).
export function payout(text){ return [/\bAuszahlung(?:sbetrag)?\b/i, /\bÜberweisung(?:sbetrag)?\b/i, /\bBank transfer\b/i].map(re => lineAmount(text, re, true)).find(v => v > 0) ?? null; }

// Repairs one set of figures (the month, or the year to date) in place; returns what was changed.
function repair(o, label){
  const fixes = [];
  // Pension and unemployment in the wrong fields (a column shifted): the pair whose ratio is 9.3 : 1.3 is them.
  if (!(pos(o.rv) && pos(o.av) && near(o.rv / o.av, RV_AV, 0.03))){
    let done = false;
    for (const a of INS){ for (const b of INS){
      if (done || a === b || !pos(o[a]) || !pos(o[b]) || !near(o[a] / o[b], RV_AV, 0.02)) continue;
      const x = o[a], y = o[b]; for (const k of [a, b]) if (k !== 'rv' && k !== 'av') o[k] = null;
      o.rv = x; o.av = y; done = true;
      fixes.push(`${label}pension ${x.toFixed(2)} and unemployment ${y.toFixed(2)} were in the wrong fields`);
    } }
  }
  // An amount in church tax that's too small to be church tax (at most 5.5% of the wage tax) is the Soli.
  if (pos(o.kist) && pos(o.lst) && o.kist / o.lst <= 0.056 && !pos(o.soli)){ fixes.push(`${label}${o.kist.toFixed(2)} is the Soli, not church tax`); o.soli = o.kist; o.kist = 0; }
  // And one in Soli that's too big for Soli but fits church tax (8 or 9%) is church tax.
  else if (pos(o.soli) && pos(o.lst) && o.soli / o.lst >= 0.075 && o.soli / o.lst <= 0.092 && !pos(o.kist)){ fixes.push(`${label}${o.soli.toFixed(2)} is church tax, not Soli`); o.kist = o.soli; o.soli = 0; }
  return fixes;
}

// The reader's answer, repaired with the slip's text: shifted insurance columns, Soli read as church tax, your share of
// voluntary health and care insurance worked out from the slip, and net pay as what reached the bank.
export function fixSlip(slip, text = ''){
  const s = { ...slip, ...(slip.ytd ? { ytd: { ...slip.ytd } } : {}) }, fixes = [...repair(s, '')];
  if (s.ytd) fixes.push(...repair(s.ytd, 'year to date: '));
  const vol = voluntary(text);
  for (const k of ['kv', 'pv']) if (vol[k] > 0 && s[k] !== vol[k]){
    fixes.push(`${k === 'kv' ? 'health' : 'care'} ${vol[k].toFixed(2)}: your share (the whole contribution less the employer’s allowance)`); s[k] = vol[k]; }
  // A voluntary member's year to date health and care aren't on the slip: anything read there came from another row.
  if (s.ytd) for (const k of ['kv', 'pv']) if (vol[k] > 0 && pos(s.ytd[k])){ fixes.push(`year to date: ${k === 'kv' ? 'health' : 'care'} ${s.ytd[k].toFixed(2)} isn’t on the slip, so it’s left out (the months are added up)`); s.ytd[k] = null; }
  if (s.ytd){ for (const k of Object.keys(s.ytd)) if (s.ytd[k] === null || s.ytd[k] === undefined) delete s.ytd[k]; if (!Object.keys(s.ytd).length) delete s.ytd; }
  const paid = payout(text); if (paid > 0 && s.net !== paid){ s.net = paid; fixes.push(`net pay ${paid.toFixed(2)}: what reached your account`); }
  return { slip: s, fixes: fixes.map(x => x[0].toUpperCase() + x.slice(1)) };
}

// Figures that don't fit the rules, as sentences for the check dialog and the estimate. church: false leaves the
// church tax check out (the estimate has its own, across all payslips).
export function checkSlip(s, { church = true } = {}){
  const out = [];
  const one = (o, label, ytd) => {
    if (!o) return;
    const g = +o.taxGross || 0;
    const shifted = pos(o.kv) && pos(o.rv) && near(o.kv / o.rv, RV_AV, 0.03);
    if (shifted) out.push(`${label}health (${o.kv.toFixed(2)}) looks like the pension figure and pension (${o.rv.toFixed(2)}) like unemployment: the columns are probably shifted.`);
    else if (pos(o.rv) && pos(o.av) && !near(o.rv / o.av, RV_AV, 0.05)) out.push(`${label}pension (${o.rv.toFixed(2)}) and unemployment (${o.av.toFixed(2)}) don’t fit: pension is 9.3% and unemployment 1.3% of the same pay, so pension is about 7 times unemployment.`);
    else if (pos(o.rv) && g > 1000 && o.rv / g < 0.03) out.push(`${label}pension (${o.rv.toFixed(2)}) is under 3% of the pay, so it’s probably another figure (unemployment is 1.3%).`);
    if (pos(o.rv) && g > 0 && o.rv > 0.0935 * g + 1) out.push(`${label}pension (${o.rv.toFixed(2)}) is more than 9.3% of the pay.`);
    if (pos(o.soli) && pos(o.lst) && o.soli / o.lst > 0.0555) out.push(`${label}Soli (${o.soli.toFixed(2)}) is more than 5.5% of the wage tax, so it’s probably another figure.`);
    if (church && pos(o.kist) && pos(o.lst) && (o.kist / o.lst < 0.07 || o.kist / o.lst > 0.095)) out.push(`${label}church tax (${o.kist.toFixed(2)}) is ${(o.kist / o.lst * 100).toFixed(1)}% of the wage tax; church tax is 8% (9% outside Bavaria and Baden-Württemberg), so it’s probably ${o.kist / o.lst <= 0.056 ? 'the Soli (up to 5.5%)' : 'another figure'}.`);
    if (!ytd && !shifted && pos(o.kv) && g > 0 && o.kv > 0.105 * Math.min(g, 5812.5) + 1) out.push(`${label}health (${o.kv.toFixed(2)}) is more than your share can be: with an employer allowance, enter the contribution less the allowance.`);
  };
  one(s, '', false); one(s.ytd, 'Year to date: ', true);
  return out.map(x => x[0].toUpperCase() + x.slice(1));
}
