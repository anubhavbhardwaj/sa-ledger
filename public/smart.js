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
  // Real evidence about this store: the exact name, or one of its words, seen before. 3-letter pieces alone don't count.
  evidence(i){
    const fs = features(i);
    return { exact: fs.some(([f]) => f.startsWith('s:') && this.vocab.has(f)), words: fs.some(([f]) => f.startsWith('w:') && this.vocab.has(f)) };
  }
  // Best guesses, blended with the starter vocabulary: strongly for an unknown store, lightly for a known one.
  suggest(i, top = 3){
    const p = this.predict(i, this.cls.size), ev = this.evidence(i), lex = lexiconGuess(i.store, [...this.cls.keys()]);
    const lam = !lex ? 0 : ev.exact ? 0.1 : ev.words ? 0.4 : 0.75;
    const out = p.map(x => ({ ...x, p: (1 - lam) * x.p + (x.key === lex ? lam : 0) })).sort((a, b) => b.p - a.p).slice(0, top);
    return { list: out, evidence: ev.exact || ev.words || !!lex, lexicon: lex };
  }
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

// ---------- starter vocabulary for stores you've never entered ----------
// Each concept lists words that name it in your categories, and store keywords (German, Italian, international).
// A concept is only used if one of your categories matches it, so it never invents categories.
export const CONCEPTS = [
  { names: ['groceries', 'grocery', 'supermarket', 'food shopping', 'lebensmittel', 'spesa'],
    stores: /\b(rewe|lidl|aldi|edeka|kaufland|penny|netto|norma|tegut|globus|alnatura|denns|basic|esselunga|conad|coop|carrefour|pam|eurospin|todis|despar|interspar|spar|crai|tigre|pewex|asia ?markt|orientmarkt|indian ?store|grocery|supermarket|supermercato|alimentari|bakery|backerei|baeckerei|backstube|metzgerei|forno|panificio)\b/ },
  { names: ['eating out', 'restaurant', 'restaurants', 'dining', 'food & drink', 'food and drink', 'eat out', 'cafe', 'coffee', 'takeaway', 'food delivery'],
    stores: /\b(bar|cafe|caffe|caffetteria|coffee|starbucks|ristorante|restaurant|trattoria|osteria|pizzeria|pizza|pizzaria|gelateria|gelato|pasticceria|bistro|kebab|doner|burger|mcdonalds|mc donalds|burger king|kfc|subway|vapiano|lieferando|wolt|uber eats|deliveroo|just eat|glovo|swiggy|zomato|sushi|imbiss|biergarten|brauhaus|wirtshaus|gasthaus|kantine|canteen|mensa|hot dog)\b/ },
  { names: ['transportation', 'transport', 'travel', 'commute', 'mobility', 'car', 'fuel'],
    stores: /\b(db|deutsche bahn|bahn|db fernverkehr|db regio|mvv|mvg|vgi|flixbus|flixtrain|trenitalia|italo|atac|cotral|ryanair|easyjet|lufthansa|ita airways|wizz|eurowings|condor|air india|indigo|qatar|emirates|uber|bolt|free ?now|taxi|tier|lime|voi|sixt|europcar|hertz|avis|shell|aral|esso|totalenergies|omv|eni|agip|q8|tankstelle|parking|parkhaus|apcoa|telepass|autostrade|maut|irctc|rapido)\b/ },
  { names: ['phone/internet', 'phone', 'internet', 'mobile', 'telecom', 'phone & internet'],
    stores: /\b(vodafone|telekom|o2|1 ?1|1und1|congstar|aldi talk|freenet|tim italia|wind ?tre|windtre|iliad|fastweb|ho mobile|kena|very mobile|jio|airtel)\b/ },
  { names: ['insurance', 'insurances', 'versicherung', 'assicurazione'],
    stores: /\b(allianz|huk|huk coburg|axa|ergo|generali|debeka|signal iduna|devk|wgv|check24|getsafe|hansemerkur|zurich|unipol|versicherung|assicurazion\w*|techniker krankenkasse|aok|barmer|dak)\b/ },
  { names: ['drugstore', 'personal care', 'health & beauty', 'toiletries', 'beauty', 'drogerie'],
    stores: /\b(dm|rossmann|muller|mueller|budni|douglas|tigota|acqua e sapone|sephora|nykaa)\b/ },
  { names: ['health', 'medical', 'pharmacy', 'doctor', 'apotheke', 'farmacia'],
    stores: /\b(apotheke|farmacia|pharmacy|arzt|zahnarzt|clinic|klinik|ospedale|doctor|docmorris|shop apotheke|apollo|medplus)\b/ },
  { names: ['rent', 'housing', 'home', 'miete'],
    stores: /\b(miete|rent|affitto|hausverwaltung|vermieter|wohnungsbau|gewofag|gwg)\b/ },
  { names: ['utilities', 'electricity', 'energy', 'bills', 'strom'],
    stores: /\b(stadtwerke|sw ingolstadt|swm|eon|e on|vattenfall|enbw|octopus|tibber|lichtblick|enel|acea|hera|a2a|edison|rundfunk|beitragsservice|gez)\b/ },
  { names: ['subscriptions', 'subscription', 'entertainment', 'streaming', 'abos'],
    stores: /\b(netflix|spotify|disney|prime video|amazon prime|youtube|apple com bill|apple one|icloud|google one|google storage|dazn|sky|audible|kindle unlimited|chatgpt|openai|claude|anthropic|notion|github|hotstar|jiocinema)\b/ },
  { names: ['shopping', 'clothes', 'clothing', 'fashion', 'misc purchase', 'misc', 'household', 'electronics'],
    stores: /\b(amazon|zalando|h m|zara|uniqlo|primark|tk maxx|decathlon|ikea|mediamarkt|media markt|saturn|otto de|ebay|aliexpress|temu|shein|kik|deichmann|snipes|apple store|cyberport|notebooksbilliger|flipkart|myntra)\b/ },
  { names: ['accommodation', 'hotel', 'hotels', 'lodging', 'stay'],
    stores: /\b(hotel|hostel|airbnb|booking com|booking|expedia|b b|bnb|albergo|gasthof|motel|agoda|oyo)\b/ },
  { names: ['fitness', 'sport', 'sports', 'gym'],
    stores: /\b(mcfit|fitx|clever fit|fitness first|john reed|urban sports|gym|palestra|virgin active|cult fit)\b/ },
];
// Which of your categories a store name points to, or null.
export function lexiconGuess(store, categoryKeys){
  const s = normStore(store); if (!s) return null;
  for (const c of CONCEPTS){
    if (!c.stores.test(s)) continue;
    const k = categoryKeys.find(k => c.names.includes(k)) || categoryKeys.find(k => c.names.some(n => k.includes(n) || n.includes(k)));
    if (k) return k;
  }
  return null;
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

// What the form does: today's rule when it applies (it's rarely wrong); otherwise the model's best guess when it's
// sure and has evidence; otherwise nothing is filled in and the top 3 are offered as one-tap choices.
export function suggestCategory(model, hist, i, threshold = 0.6){
  const s = model.suggest(i), chips = s.list;
  const rule = ruleSuggest(hist, i);
  if (rule) return { fill: rule, source: 'rule', chips };
  if (chips[0] && chips[0].p >= threshold && s.evidence) return { fill: chips[0].key, source: s.lexicon && !model.evidence(i).exact ? 'starter' : 'model', chips, p: chips[0].p };
  return { fill: null, source: null, chips };
}

// Replays your history in date order: each entry from `from` on is predicted from everything before it, exactly as
// it would have happened when you typed it. Compares the model with the current rule.
export function evaluate(items, { from, threshold = 0.6 } = {}){
  const list = items.filter(i => i.category && i.date && i.store).slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const m = new CategoryModel(), hist = new Map();
  const r = { n: 0, rule: { cover: 0, ok: 0 }, model: { top1: 0, top3: 0, cover: 0, ok: 0 }, unseen: { n: 0, ok: 0, rule: 0, hybrid: 0 },
    hybrid: { cover: 0, ok: 0, chipsHit: 0, open: 0 }, mistakes: {} };
  for (const i of list){
    const k = keyOf(i.category), s = normStore(i.store);
    if (i.date >= from){
      r.n++;
      const rs = ruleSuggest(hist, i);
      if (rs){ r.rule.cover++; if (rs === k) r.rule.ok++; }
      const p = m.predict(i);
      if (p[0]?.key === k) r.model.top1++;
      if (p.some(x => x.key === k)) r.model.top3++;
      if (p[0] && p[0].p >= threshold){ r.model.cover++; if (p[0].key === k) r.model.ok++; }
      if (!hist.has(s)){ r.unseen.n++; if (p[0]?.key === k && p[0].p >= threshold) r.unseen.ok++; }
      const h = suggestCategory(m, hist, i, threshold);
      if (h.fill){ r.hybrid.cover++; if (h.fill === k){ r.hybrid.ok++; if (!hist.has(s)) r.unseen.hybrid++; } else { const e = `${m.label(h.fill)} → ${i.category}`; r.mistakes[e] = (r.mistakes[e] || 0) + 1; } }
      else { r.hybrid.open++; if (h.chips.some(x => x.key === k)) r.hybrid.chipsHit++; }
    }
    m.add(i);
    if (!hist.has(s)) hist.set(s, []);
    hist.get(s).push(k);
  }
  r.mistakes = Object.entries(r.mistakes).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return r;
}
