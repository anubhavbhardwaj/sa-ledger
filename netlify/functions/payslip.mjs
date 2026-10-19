// Reads a German payslip (Entgeltabrechnung / Remuneration statement): the app sends the PDF's text, row by row,
// and gets back the month's tax and social insurance figures, plus the year-to-date ones when the slip shows them.
// POST /api/payslip { text } → { slip }. The app shows the result for checking before anything is saved.
import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { beat } from '../lib/health.mjs';

const MODEL = 'openai/gpt-oss-120b';
export const FIELDS = ['taxGross', 'oneOff', 'lst', 'soli', 'kist', 'rv', 'av', 'kv', 'pv', 'net'];
export const PROMPT = `You read one German payslip (Entgeltabrechnung, Verdienstabrechnung, Remuneration statement; German or English labels).
Return JSON only:
{"month":"YYYY-MM","employer":"short company name, the same way every month (e.g. \"PAYBACK\", \"MediaMarktSaturn\")",
 "taxGross":0,"oneOff":0,"lst":0,"soli":0,"kist":0,"rv":0,"av":0,"kv":0,"pv":0,"net":0,
 "ytd":{"taxGross":0,"lst":0,"soli":0,"kist":0,"rv":0,"av":0,"kv":0,"pv":0}}
Meaning (all for THIS month, in euros, positive numbers, employee share only):
- month: the pay period (Abrechnungsmonat), not the print date.
- taxGross: this month's gross pay subject to wage tax (Steuer-Brutto, St-Brutto, steuerpflichtiges Brutto, LSt-Brutto, Tax gross), including one-off payments. Not the total gross if they differ, never a year-to-date value, never an insurance base (KV-/RV-/PI-Brutto).
- oneOff: the part of taxGross that is a one-off payment this month (sonstiger Bezug, Einmalzahlung, bonus, holiday or Christmas pay, vacation payout); 0 if none.
- lst: Lohnsteuer / wage tax withheld. soli: Solidaritätszuschlag. kist: Kirchensteuer / church tax (0 if none).
- rv: Rentenversicherung / pension insurance contribution, employee share (AN-Anteil, RV-AN). The contribution in euros, not the insurance gross it is based on.
- av: Arbeitslosenversicherung / unemployment insurance, employee share.
- kv: Krankenversicherung / health insurance contribution, employee share including the additional contribution (Zusatzbeitrag). If you pay private insurance and get an employer subsidy, the premium minus the subsidy.
- pv: Pflegeversicherung / long-term care insurance, employee share.
- net: Nettoverdienst / net pay (before other deductions like job bike or advances).
- ytd: the same figures accumulated for the year so far (Jahreswerte, kumuliert, YTD) when the slip shows them; omit ytd or fields it doesn't show.
Labels you may see, German and English: Lohnsteuer/LSt/Wage tax/Income tax; Solidaritätszuschlag/SolZ/Soli; Kirchensteuer/KiSt/Church tax;
RV/Rentenversicherung/PI/Pension insurance; AV/ALV/Arbeitslosenversicherung/UI/Unemployment insurance; KV/Krankenversicherung/HI/Health insurance
(the contribution line, often "KV-Beitrag AN", "HI EE", "Health insurance employee"); PV/Pflegeversicherung/LTCI/Nursing care/Long-term care insurance.
Lines like "KV-Brutto", "HI gross", "PI gross", "SV-Brutto" are bases, not contributions: never use them as kv, pv, rv or taxGross.
In a year-to-date block, take ytd.taxGross from the tax gross line (Steuer-Brutto / Tax gross / LSt-Brutto), not from a pension or health insurance gross.
Never use employer shares (AG-Anteil, ER). Use null for a monthly figure the slip doesn't show. Never invent numbers.`;

// "7.668,75" (German), "7,668.75" or "7668.75" → 7668.75
const num = v => { if (v === null || v === undefined || v === '') return null; const t = String(v).replace(/[^0-9.,]/g, ''); const n = typeof v === 'number' ? v : /,\d{1,2}$/.test(t) ? parseFloat(t.replace(/\./g, '').replace(',', '.')) : parseFloat(t.replace(/,/g, '')); return isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n * 100) / 100 : null; };
export function clean(o = {}){
  const s = { month: /^\d{4}-\d{2}$/.test(o.month) ? o.month : null, employer: String(o.employer || '').trim().slice(0, 60) || null };
  for (const k of FIELDS) s[k] = num(o[k]);
  const y = {}; for (const k of FIELDS.filter(k => k !== 'net' && k !== 'oneOff')){ const v = num(o.ytd?.[k]); if (v !== null) y[k] = v; }
  if (Object.keys(y).length) s.ytd = y;
  return s;
}

// The first {...} in a model answer, parsed; null if there is none.
export function parseObj(t){
  if (!t || typeof t !== 'string') return null;
  try { const o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch {}
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (a < 0 || z <= a) return null;
  try { const o = JSON.parse(t.slice(a, z + 1)); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch } = {}){
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.GROQ_API_KEY) return json(503, { error: 'This needs GROQ_API_KEY in Netlify (same key as Ask AI).' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const text = String(body.text || '').slice(0, 30000);
  if (text.trim().length < 50) return json(400, { error: 'No text found in this PDF. Type the figures in instead.' });
  // JSON mode first. Groq answers 400 "json_validate_failed" when the model's JSON didn't validate (often a
  // reasoning run that hit the token limit); its failed_generation is often still usable. Otherwise ask again
  // without JSON mode and take the JSON object out of the text.
  const ask = jsonMode => f('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify({ model: env.GROQ_MODEL || MODEL, temperature: 0, max_completion_tokens: 6000, reasoning_effort: 'low',
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: PROMPT + (jsonMode ? '' : '\nAnswer with the JSON object only, no other text.') }, { role: 'user', content: text }] }),
  });
  let out = null, last = '';
  for (const jsonMode of [true, false]){
    const r = await ask(jsonMode);
    if (r.status === 429) return json(502, { error: 'Groq’s rate limit was reached. Try again in a minute.' });
    let b = null; try { b = await r.json(); } catch {}
    out = parseObj(r.ok ? b?.choices?.[0]?.message?.content : b?.error?.failed_generation);
    if (out) break;
    last = r.ok ? 'unreadable answer' : `${r.status} ${b?.error?.code || ''} ${String(b?.error?.message || '').slice(0, 160)}`.trim();
    console.error('payslip: Groq', jsonMode ? 'JSON mode' : 'plain', last);
  }
  if (!out) return json(502, { error: 'The AI couldn’t read this payslip (' + last + '). Try again, or type the figures in.' });
  return json(200, { slip: clean(out) });
}

export default async (req) => {
  try {
    const res = await handle(req);
    if (res.status === 200) await beat(firestore(), 'extract', { info: 'payslip' });
    return res;
  } catch (e) { console.error('payslip failed', e); return json(500, { error: 'Something went wrong. Try again.' }); }
};

export const config = { path: '/api/payslip' };
