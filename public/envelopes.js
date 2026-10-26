// Envelope budgeting: money that comes in is put into envelopes, spending takes it out, and what's left rolls over.
// Everything is worked out from the entries already logged; nothing is typed in from the bank.
//
// cfg = { start: 'YYYY-MM', envs: [{ id, name, cats: [category], fill, trips?, save?, other? }], months: { 'YYYY-MM': { envId: amount } } }
// - an expense on a trip goes to the envelope marked trips, otherwise to the envelope listing its category,
//   otherwise to the one marked other ("Everything else"), so no spending is left out;
// - income and money coming back from investments or from non-euro accounts is "ready to assign";
// - money leaving the euro accounts for investments or a non-euro account (e.g. sent to India) comes out of the
//   envelope marked save; transfers between your own euro accounts and card payments change nothing.

export const monthsBetween = (a, b) => { const out = []; let [y, m] = a.split('-').map(Number); const [Y, M] = b.split('-').map(Number);
  while (y < Y || (y === Y && m <= M)){ out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12){ m = 1; y++; } } return out; };
const r2 = v => Math.round(v * 100) / 100;

export function envelopeOf(cfg, e){
  const envs = cfg.envs || [];
  if (e.tripId){ const t = envs.find(x => x.trips); if (t) return t.id; }
  const c = envs.find(x => (x.cats || []).includes(e.category)); if (c) return c.id;
  return (envs.find(x => x.other) || {}).id || null;
}

// The euro spending pool: euro accounts that aren't investments. Accounts not set up count as part of it.
const inPool = a => !a || (a.type !== 'investment' && (a.currency || 'EUR') === 'EUR');

export function envelopeMonth(cfg, month, { items = [], income = [], transfers = [], acc = () => null } = {}){
  const envs = cfg.envs || [], start = cfg.start || month;
  const avail = Object.fromEntries(envs.map(e => [e.id, 0]));
  const save = (envs.find(e => e.save) || {}).id;
  let ready = 0, out = null;
  for (const m of monthsBetween(start, month)){
    const put = { ...(cfg.months || {})[m] }, spent = Object.fromEntries(envs.map(e => [e.id, 0]));
    let inc = 0, back = 0;
    items.filter(i => i.date.startsWith(m)).forEach(i => { const id = envelopeOf(cfg, i); if (id in spent) spent[id] += +i.amount || 0; });
    income.filter(i => i.date.startsWith(m)).forEach(i => { inc += +i.amount || 0; });
    transfers.filter(t => t.date.startsWith(m)).forEach(t => {
      const f = inPool(acc(t.from)), to = inPool(acc(t.to)), v = +t.amount || 0;
      if (f && !to){ if (save && save in spent) spent[save] += v; }
      else if (!f && to) back += v;
    });
    const carry = { ...avail }, putSum = Object.values(put).reduce((s, v) => s + (+v || 0), 0);
    envs.forEach(e => { avail[e.id] = r2(avail[e.id] + (+put[e.id] || 0) - spent[e.id]); });
    ready = r2(ready + inc + back - putSum);
    if (m === month) out = { income: r2(inc), back: r2(back), put: r2(putSum),
      rows: envs.map(e => ({ env: e, carry: r2(carry[e.id]), put: r2(+put[e.id] || 0), spent: r2(spent[e.id]), avail: avail[e.id] })) };
  }
  if (!out) return { ready: 0, income: 0, back: 0, put: 0, rows: envs.map(e => ({ env: e, carry: 0, put: 0, spent: 0, avail: 0 })), before: true };
  return { ready, ...out };
}

// The month's planned amounts for envelopes that haven't had anything put in yet this month.
export function fillMonth(cfg, month){
  const cur = { ...(cfg.months || {})[month] };
  let n = 0, total = 0;
  (cfg.envs || []).forEach(e => { if (+e.fill > 0 && !(e.id in cur)){ cur[e.id] = +e.fill; n++; total += +e.fill; } });
  return { months: { ...(cfg.months || {}), [month]: cur }, n, total: r2(total) };
}

// Move money between envelopes this month ('ready' = from or to ready to assign).
export function moveMoney(cfg, month, from, to, amount){
  const cur = { ...(cfg.months || {})[month] }, v = r2(+amount);
  if (from !== 'ready') cur[from] = r2((+cur[from] || 0) - v);
  if (to !== 'ready') cur[to] = r2((+cur[to] || 0) + v);
  return { ...(cfg.months || {}), [month]: cur };
}

// A first set of envelopes from the monthly budgets, plus Travel (all trip spending), Savings & investing and
// Everything else (any category without an envelope of its own).
export function startFromBudgets(items, month){
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'env';
  const envs = (items || []).filter(b => +b.a > 0).map(b => ({ id: 'c-' + slug(b.c), name: b.c, cats: [b.c], fill: +b.a }));
  envs.push({ id: 'travel', name: 'Travel', cats: [], fill: 0, trips: true }, { id: 'save', name: 'Savings & investing', cats: [], fill: 0, save: true },
    { id: 'other', name: 'Everything else', cats: [], fill: 0, other: true });
  return { start: month, envs, months: {} };
}
