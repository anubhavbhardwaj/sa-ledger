// Category suggestions: a small Naive Bayes model trained in the browser on your own entries. No service, no AI.
// Features: the store (exact name, its words and 3-letter pieces, so "REWE City" learns from "Rewe Markt"), amount
// range, account, spender, country and weekend. Recent entries count more (half-life about 8 months), so changed
// habits win over old ones.

export const normStore = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['gmbh', 'ag', 'kg', 'co', 'und', 'and', 'the', 'de', 'la', 'il', 'srl', 'spa', 'ltd', 'inc', 'markt', 'store', 'shop', 'filiale']);
const bucket = a => { const v = +a || 0; return v < 5 ? 0 : v < 10 ? 1 : v < 20 ? 2 : v < 50 ? 3 : v < 100 ? 4 : v < 250 ? 5 : v < 1000 ? 6 : 7; };
const keyOf = c => String(c || '').trim().toLowerCase();

// [feature, weight] pairs for one entry.
export function features(i){
  const s = normStore(i.store), f = [];
  if (s) f.push(['s:' + s, 3]);
  const words = s.split(' ').filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  words.forEach(w => f.push(['w:' + w, 1.5]));
  const g = s.replace(/ /g, '_');
  for (let k = 0; k + 3 <= g.length && k < 24; k++) f.push(['g:' + g.slice(k, k + 3), 0.25]);
  f.push(['a:' + bucket(i.amount), 1]);
  if (i.account) f.push(['acc:' + keyOf(i.account), 0.7]);
  if (i.spender) f.push(['sp:' + keyOf(i.spender), 0.4]);
  if (i.country) f.push(['c:' + keyOf(i.country), 0.5]);
  if (i.date){ const wd = new Date(i.date + 'T12:00:00Z').getUTCDay(); f.push(['we:' + (wd === 0 || wd === 6 ? 1 : 0), 0.3]); }
  return f;
}

const TAU = 240;   // days: an entry 240 days old counts e^-1 ≈ 37% of a new one
const dayNo = d => Math.floor(Date.parse(d + 'T12:00:00Z') / 864e5);

// Learns incrementally (add) and predicts with recency weighting: weights grow as e^(t/TAU), which is the same as
// old entries decaying, as long as the smoothing grows along.
export class CategoryModel {
  constructor(alpha = 0.3){ this.alpha = alpha; this.t0 = null; this.cls = new Map(); this.vocab = new Set(); this.names = new Map(); }
  w(date){ if (this.t0 === null) this.t0 = dayNo(date); return Math.exp((dayNo(date) - this.t0) / TAU); }
  add(i){
    const k = keyOf(i.category); if (!k || !i.date) return;
    const w = this.w(i.date);
    let c = this.cls.get(k); if (!c){ c = { n: 0, tot: 0, f: new Map() }; this.cls.set(k, c); }
    c.n += w;
    for (const [f, fw] of features(i)){ c.f.set(f, (c.f.get(f) || 0) + w * fw); c.tot += w * fw; this.vocab.add(f); }
    const nm = this.names.get(k) || {}; nm[i.category] = (nm[i.category] || 0) + 1; this.names.set(k, nm);
  }
  label(k){ const nm = this.names.get(k) || {}; return Object.entries(nm).sort((a, b) => b[1] - a[1])[0]?.[0] || k; }
  // Top suggestions with probabilities: [{ category, p }]
  predict(i, top = 3){
    if (!this.cls.size) return [];
    const scale = this.w(i.date || new Date().toISOString().slice(0, 10)), a = this.alpha * scale, V = this.vocab.size + 1, fs = features(i);
    const N = [...this.cls.values()].reduce((s, c) => s + c.n, 0);
    const scores = [...this.cls.entries()].map(([k, c]) => {
      let lp = Math.log((c.n + a) / (N + a * this.cls.size));
      for (const [f, fw] of fs) lp += fw * Math.log(((c.f.get(f) || 0) + a) / (c.tot + a * V));
      return [k, lp];
    });
    const m = Math.max(...scores.map(s => s[1])), ex = scores.map(([k, s]) => [k, Math.exp(s - m)]), Z = ex.reduce((s, e) => s + e[1], 0);
    return ex.map(([k, e]) => ({ category: this.label(k), key: k, p: e / Z })).sort((x, y) => y.p - x.p).slice(0, top);
  }
}

// The current rule, for comparison: a store used at least twice before gets the category most of its last 10
// entries agree on (at least 60%).
export function ruleSuggest(history, i){
  const s = normStore(i.store); if (s.length < 2) return null;
  const prev = history.get(s); if (!prev || prev.length < 2) return null;
  const recent = prev.slice(-10), c = {};
  recent.forEach(k => c[k] = (c[k] || 0) + 1);
  const [k, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return n / recent.length >= 0.6 ? k : null;
}

// Replays your history in date order: each entry from `from` on is predicted from everything before it, exactly as
// it would have happened when you typed it. Compares the model with the current rule.
export function evaluate(items, { from, threshold = 0.6 } = {}){
  const list = items.filter(i => i.category && i.date && i.store).slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const m = new CategoryModel(), hist = new Map();
  const r = { n: 0, rule: { cover: 0, ok: 0 }, model: { top1: 0, top3: 0, cover: 0, ok: 0 }, unseen: { n: 0, ok: 0, rule: 0 }, mistakes: {} };
  for (const i of list){
    const k = keyOf(i.category), s = normStore(i.store);
    if (i.date >= from){
      r.n++;
      const rs = ruleSuggest(hist, i);
      if (rs){ r.rule.cover++; if (rs === k) r.rule.ok++; }
      const p = m.predict(i);
      if (p[0]?.key === k) r.model.top1++;
      if (p.some(x => x.key === k)) r.model.top3++;
      if (p[0] && p[0].p >= threshold){ r.model.cover++; if (p[0].key === k) r.model.ok++; else { const e = `${p[0].category} → ${i.category}`; r.mistakes[e] = (r.mistakes[e] || 0) + 1; } }
      if (!hist.has(s)){ r.unseen.n++; if (p[0]?.key === k && p[0].p >= threshold) r.unseen.ok++; }
    }
    m.add(i);
    if (!hist.has(s)) hist.set(s, []);
    hist.get(s).push(k);
  }
  r.mistakes = Object.entries(r.mistakes).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return r;
}
