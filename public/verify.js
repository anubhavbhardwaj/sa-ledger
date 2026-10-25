// Checks a photo of a form (a booking page on a laptop, a printed form) against people's saved details: name as in
// the passport, gender, email, phone. Exact matches are confirmed; near misses (one or two letters off, a digit
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

export function checkPerson(p, text){
  // Names are matched without email addresses, so "sulekha@…" doesn't count as the name being right on the form.
  const toks = words(fold(text).replace(EMAIL, ' ')), rows = [];
  const nameWords = (s, label) => String(s || '').trim().split(/\s+/).filter(Boolean).forEach(w => {
    const r = findWord(w, toks); rows.push({ field: label, expected: w, ...r });
  });
  nameWords(p.first, 'First name'); nameWords(p.last, 'Last name');
  const found = rows.some(r => r.status !== 'missing');
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
  return { person: p, found, rows, problems: rows.filter(r => r.status === 'near' || r.status === 'conflict').length };
}

// Everyone whose name shows up on the photo, best match first; if nobody does, an empty list.
export function checkPhoto(people, text){
  return people.map(p => checkPerson(p, text)).filter(r => r.found)
    .sort((a, b) => b.rows.filter(r => r.status === 'ok').length - a.rows.filter(r => r.status === 'ok').length);
}
