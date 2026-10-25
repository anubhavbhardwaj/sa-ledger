// Checks a photo of a form (a booking page on a laptop, a printed form) against people's saved details: name as in
// the passport, gender, email, phone, passport number and expiry. Exact matches are confirmed; near misses (one or two letters off, a digit
// wrong) are the likely typos and are flagged with what the form shows and what it should be.

export const fold = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase();
export function lev(a, b){
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++){
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Like lev, but a swap of two neighbouring characters ("2031" / "2013") counts as one mistake.
export function osa(a, b){
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++){
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const words = t => fold(t).split(/[^a-z0-9]+/).filter(w => w.length > 1);
// How many letters may differ for a word of this length to still count as "almost the same".
const slack = n => n <= 3 ? 0 : n <= 6 ? 1 : 2;

// One name word against the photo: exact, near (a likely typo on the form) or missing.
function findWord(w, toks){
  const f = fold(w); if (!f) return { status: 'missing' };
  if (toks.includes(f)) return { status: 'ok', seen: w };
  let best = null;
  for (const t of toks){
    if (Math.abs(t.length - f.length) > 2 || t[0] !== f[0] && t.slice(-1) !== f.slice(-1)) continue;
    const d = lev(f, t); if (d && d <= slack(f.length) && (!best || d < best.d)) best = { d, t };
  }
  // Two words run together or split ("vanderberg" / "van der berg").
  const joined = toks.join(' ');
  if (!best && f.includes(' ') && joined.includes(f)) return { status: 'ok', seen: w };
  return best ? { status: 'near', seen: best.t } : { status: 'missing' };
}

const EMAIL = /[a-z0-9._%+-]+\s?@\s?[a-z0-9.-]+\s?\.\s?[a-z]{2,}/gi;
const digits = s => String(s || '').replace(/\D/g, '');

// Lines of text near a name, for gender words that belong to that person.
function linesAround(text, name){
  const ls = text.split(/\r?\n/), f = fold(name), out = [];
  ls.forEach((l, i) => { if (fold(l).includes(f)) out.push(...ls.slice(Math.max(0, i - 2), i + 2)); });
  return fold(out.join(' '));
}
const MALE = /\b(male|mr|herr|signor|sig|maennlich|mannlich|m)\b/, FEMALE = /\b(female|mrs|ms|miss|frau|signora|sig ra|weiblich|f|w)\b/;

// ---- Passport number ----
// Letters and digits only. A photo reader often mixes up O/0, I/1, S/5, B/8, Z/2, G/6: a number that differs only
// in those is shown as "check by eye" rather than as a typo.
const alnum = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const LOOK = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const look = s => s.replace(/[OQDILSBZG]/g, c => LOOK[c]);
export function checkPassport(want, text){
  const w = alnum(want); if (w.length < 5) return { status: 'missing' };
  const parts = String(text || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean), cands = new Set();
  // Also two or three pieces joined, for a number shown with spaces ("Z123 4567").
  parts.forEach((x, i) => { cands.add(x); if (parts[i + 1]) cands.add(x + parts[i + 1]); if (parts[i + 2]) cands.add(x + parts[i + 1] + parts[i + 2]); });
  const cs = [...cands].filter(c => Math.abs(c.length - w.length) <= 1 && /\d/.test(c));
  if (cs.includes(w)) return { status: 'ok', seen: w };
  const lw = look(w), sameLook = cs.find(c => c.length === w.length && look(c) === lw);
  if (sameLook) return { status: 'check', seen: sameLook, note: 'the same except characters a photo is often misread in (O/0, I/1, S/5, B/8), check it by eye' };
  const near = w.length >= 6 && cs.map(c => ({ c, d: osa(look(c), lw) })).filter(x => x.d === 1).sort((a, b) => (a.c.length !== w.length) - (b.c.length !== w.length))[0];
  return near ? { status: 'near', seen: near.c } : { status: 'missing' };
}

// ---- Dates (passport expiry) ----
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12 };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (y, m, d) => (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31 && +y >= 1900 && +y <= 2100) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
export const human = s => { const [y, m, d] = String(s || '').split('-'); return y && m && d ? `${+d} ${MON[+m - 1]} ${y}` : String(s || ''); };
// Every date written on the photo: 2031-03-11, 11.03.2031, 11/03/2031, 11 Mar 2031, 11. März 2031, March 11, 2031.
// With / or - and both numbers up to 12 the order is unclear (day or month first), so both readings are kept.
export function datesIn(text){
  const t = fold(text), out = [];
  for (const m of t.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)){ const v = iso(m[1], m[2], m[3]); if (v) out.push({ raw: m[0], dates: [v] }); }
  for (const m of t.matchAll(/\b(\d{1,2})([./-])(\d{1,2})\2(\d{4})\b/g)){
    const a = +m[1], b = +m[3], dm = iso(m[4], b, a), md = m[2] === '.' ? null : iso(m[4], a, b);
    const ds = [...new Set([dm, md].filter(Boolean))];
    if (ds.length) out.push({ raw: m[0], dates: ds, dayFirst: dm, monthFirst: md });
  }
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\.?\s*(?:of\s+)?([a-z]{3,9})\.?,?\s*(\d{4})\b/g)){ const mo = MONTHS[m[2].slice(0, 3)], v = mo && iso(m[3], mo, m[1]); if (v) out.push({ raw: m[0], dates: [v] }); }
  for (const m of t.matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)){ const mo = MONTHS[m[1].slice(0, 3)], v = mo && iso(m[3], mo, m[2]); if (v) out.push({ raw: m[0], dates: [v] }); }
  return out;
}
// Is a date on the photo almost the expected one? Day and month swapped, one digit of the day or year off.
function nearDate(a, b){
  const [ya, ma, da] = a.split('-'), [yb, mb, db] = b.split('-');
  if (ya === yb && ma === db && da === mb) return true;
  if (ma === mb && da === db && osa(ya, yb) === 1) return true;
  if (ya === yb && ma === mb && osa(da, db) === 1) return true;
  return false;
}
export function checkDate(want, text){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(want || '')) return { status: 'missing' };
  const found = datesIn(text);
  const exact = found.find(f => f.dates.length === 1 && f.dates[0] === want);
  if (exact) return { status: 'ok', seen: exact.raw };
  const either = found.find(f => f.dates.includes(want));
  if (either) return { status: 'check', seen: either.raw, note: either.dayFirst === want ? 'right if the site writes the day first, wrong if it writes the month first' : 'right if the site writes the month first, wrong if it writes the day first' };
  // The issue date is often the same day 5 or 10 years earlier: that's not a typo of the expiry.
  const issueLike = d => d.slice(4) === want.slice(4) && [5, 10].includes(Math.abs(+d.slice(0, 4) - +want.slice(0, 4)));
  const near = found.find(f => f.dates.length === 1 && !issueLike(f.dates[0]) && nearDate(f.dates[0], want));
  return near ? { status: 'near', seen: near.raw } : { status: 'missing' };
}

// ---- Passport validity ----
const addMonths = (s, n) => { const [y, m, d] = s.split('-').map(Number), x = new Date(Date.UTC(y, m - 1 + n, d)); return x.toISOString().slice(0, 10); };
// Warnings for a saved expiry date: expired, under 6 or 12 months left, or too little left for a trip in the app
// (many countries want 6 months after you leave). Trips count when the traveller is this person's first name or Both.
export function passportAlerts(p, trips = [], today = new Date().toISOString().slice(0, 10)){
  const e = p?.passportExp; if (!/^\d{4}-\d{2}-\d{2}$/.test(e || '')) return [];
  if (e < today) return [{ level: 'bad', text: `Passport expired on ${human(e)}.` }];
  const out = [];
  if (e < addMonths(today, 6)) out.push({ level: 'bad', text: `Passport expires on ${human(e)}, in under 6 months. Many countries refuse entry with less than 6 months left: renew now.` });
  else if (e < addMonths(today, 12)) out.push({ level: 'warn', text: `Passport expires on ${human(e)}. Plan the renewal, it can take several weeks.` });
  const me = fold(p.first).split(/\s+/)[0];
  for (const t of trips){
    const end = t.end || t.start, who = fold(t.traveller);
    if (!end || end < today || t.type === 'office' || !(who === 'both' || (me && who === me))) continue;
    if (e < end) out.push({ level: 'bad', text: `It expires before the trip “${t.name}” ends (${human(end)}).` });
    else if (e < addMonths(end, 6)) out.push({ level: 'bad', text: `Trip “${t.name}” ends on ${human(end)}: the passport has under 6 months left then. Check the destination’s rule, many want 6 months.` });
  }
  return out;
}

export function checkPerson(p, text){
  // Names are matched without email addresses, so "sulekha@…" doesn't count as the name being right on the form.
  const toks = words(fold(text).replace(EMAIL, ' ')), rows = [];
  const nameWords = (s, label) => String(s || '').trim().split(/\s+/).filter(Boolean).forEach(w => {
    const r = findWord(w, toks); rows.push({ field: label, expected: w, ...r });
  });
  nameWords(p.first, 'First name'); nameWords(p.last, 'Last name');
  if (p.passport) rows.push({ field: 'Passport number', expected: alnum(p.passport), ...checkPassport(p.passport, text) });
  if (p.passportExp) rows.push({ field: 'Passport expiry', expected: human(p.passportExp), ...checkDate(p.passportExp, text) });
  // Found on the photo: a name word, or the passport number itself.
  const found = rows.some(r => r.field.endsWith('name') ? r.status !== 'missing' : r.field === 'Passport number' && (r.status === 'ok' || r.status === 'check'));
  if (p.email){
    const seen = (fold(text).match(EMAIL) || []).map(e => e.replace(/\s/g, ''));
    const want = fold(p.email).trim();
    const near = seen.map(e => ({ e, d: lev(e, want) })).sort((a, b) => a.d - b.d)[0];
    rows.push({ field: 'Email', expected: p.email, ...(near && near.d === 0 ? { status: 'ok', seen: near.e } : near && near.d <= 2 ? { status: 'near', seen: near.e } : { status: 'missing' }) });
  }
  if (p.phone){
    const want = digits(p.phone).replace(/^00/, ''), tail = want.slice(-8);
    const runs = (text.match(/\+?\d[\d\s\-/().]{6,}\d/g) || []).map(digits);
    const hit = runs.find(r => r.endsWith(tail));
    const near = !hit && runs.map(r => ({ r, d: lev(r.slice(-8), tail) })).filter(x => x.r.length >= 7).sort((a, b) => a.d - b.d)[0];
    rows.push({ field: 'Phone', expected: p.phone, ...(hit ? { status: 'ok', seen: hit } : near && near.d <= 1 ? { status: 'near', seen: near.r } : { status: 'missing' }) });
  }
  if (p.gender && p.last){
    const around = linesAround(text, p.last), m = MALE.test(around), f = FEMALE.test(around);
    const want = p.gender === 'female' ? 'female' : p.gender === 'male' ? 'male' : null;
    if (want && (m || f) && m !== f) rows.push({ field: 'Gender / title', expected: want, status: (want === 'male') === m ? 'ok' : 'conflict', seen: m ? 'male (Mr / Herr / Male)' : 'female (Ms / Mrs / Frau / Female)' });
  }
  return { person: p, found, rows, problems: rows.filter(r => r.status === 'near' || r.status === 'conflict').length, checks: rows.filter(r => r.status === 'check').length };
}

// Everyone whose name shows up on the photo, best match first; if nobody does, an empty list.
export function checkPhoto(people, text){
  return people.map(p => checkPerson(p, text)).filter(r => r.found)
    .sort((a, b) => b.rows.filter(r => r.status === 'ok').length - a.rows.filter(r => r.status === 'ok').length);
}
