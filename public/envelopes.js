// Envelope budgeting the YNAB way. Category groups are your categories, the envelopes inside are their
// subcategories ("General" when an entry has none). Each month every envelope has Assigned (money given to it),
// Activity (what was spent from it) and Available (what's left, rolled over from month to month).
//
// Only the budget accounts count (e.g. Deutsche Bank, Wise Sulekha, Wise Common and the credit cards):
// - Ready to Assign starts with the money in them on the start day (cash minus card debt) and grows with income
//   paid into them and money coming in from other accounts (investments, Indian accounts);
// - spending on a budget account is Activity in its envelope; trip spending goes to the trip's envelope in Travel;
// - money moved from a budget account to any other account (investing, sending to India) is Activity in
//   Savings › Investing & India; moves between budget accounts (incl. paying a card) change nothing;
// - like YNAB, an envelope that ends a month overspent starts the next month at zero and the overspending is
//   taken from that month's Ready to Assign.
//
// cfg = { start: 'YYYY-MM-DD', accounts: [names], opening: €, assigned: { 'YYYY-MM': { key: € } }, targets: { key: € }, trips: bool }

const r2 = v => Math.round(v * 100) / 100;
const enc = s => encodeURIComponent(String(s || '')).replace(/\./g, '%2E');
const dec = s => decodeURIComponent(s);
export const SAVE_KEY = 's_save';
export const keyOf = (cat, sub) => 'c_' + enc(cat) + '_' + enc(sub || '');
export const tripKey = id => 't_' + enc(id);
export function parseKey(k){
  if (k === SAVE_KEY) return { group: 'Savings', name: 'Investing & India', save: true };
  if (k.startsWith('t_')) return { group: 'Travel', tripId: dec(k.slice(2)) };
  const [cat, sub] = k.slice(2).split('_').map(dec);
  return { group: cat || 'Uncategorised', name: sub || 'General', cat, sub };
}
export const monthsBetween = (a, b) => { const out = []; let [y, m] = a.split('-').map(Number); const [Y, M] = b.split('-').map(Number);
  while (y < Y || (y === Y && m <= M)){ out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12){ m = 1; y++; } } return out; };

export function makeBudget(cfg){
  const inB = new Set((cfg.accounts || []).map(a => String(a).toLowerCase()));
  const isB = name => inB.has(String(name || '').toLowerCase());
  const keyFor = e => cfg.trips !== false && e.tripId ? tripKey(e.tripId) : keyOf(e.category, e.subcategory);
  return { isB, keyFor };
}

// The month's numbers. data = { items, income, transfers }.
export function budgetMonth(cfg, month, { items = [], income = [], transfers = [] } = {}){
  const start = cfg.start, sm = start.slice(0, 7);
  if (month < sm) return { before: true, ready: 0, rows: [] };
  const { isB, keyFor } = makeBudget(cfg), after = d => d >= start;
  const act = {}, inflow = {};
  const add = (o, m, k, v) => { (o[m] ||= {}); o[m][k] = (o[m][k] || 0) + v; };
  items.forEach(e => { if (after(e.date) && isB(e.account)) add(act, e.date.slice(0, 7), keyFor(e), -(+e.amount || 0)); });
  income.forEach(i => { if (after(i.date) && isB(i.account)) inflow[i.date.slice(0, 7)] = (inflow[i.date.slice(0, 7)] || 0) + (+i.amount || 0); });
  transfers.forEach(t => {
    if (!after(t.date)) return;
    const f = isB(t.from), to = isB(t.to), m = t.date.slice(0, 7), v = +t.amount || 0;
    if (f && !to) add(act, m, SAVE_KEY, -v);
    else if (!f && to) inflow[m] = (inflow[m] || 0) + v;
  });
  let ready = +cfg.opening || 0, avail = {}, out = null;
  for (const m of monthsBetween(sm, month)){
    const asg = (cfg.assigned || {})[m] || {}, a = act[m] || {};
    const keys = new Set([...Object.keys(avail), ...Object.keys(asg), ...Object.keys(a)]);
    // Overspending from last month comes out of this month's Ready to Assign; the envelope starts at zero.
    let overspent = 0;
    for (const k of Object.keys(avail)) if (avail[k] < 0){ overspent += avail[k]; avail[k] = 0; }
    const carry = { ...avail }, assignedSum = Object.values(asg).reduce((s, v) => s + (+v || 0), 0);
    for (const k of keys) avail[k] = r2((avail[k] || 0) + (+asg[k] || 0) + (a[k] || 0));
    ready = r2(ready + (inflow[m] || 0) - assignedSum + overspent);
    if (m === month) out = { inflow: r2(inflow[m] || 0), assigned: r2(assignedSum), overspentLast: r2(-overspent),
      rows: [...keys].map(k => ({ key: k, ...parseKey(k), carry: r2(carry[k] || 0), assigned: r2(+asg[k] || 0), activity: r2(a[k] || 0), available: avail[k] })) };
  }
  return { ready, ...out };
}

// Group the envelopes YNAB-style: Travel and Savings last, the rest by how much they're used.
export function groupRows(rows){
  const g = {};
  rows.forEach(r => { (g[r.group] ||= []).push(r); });
  const weight = rs => rs.reduce((s, r) => s + Math.abs(r.activity) + Math.abs(r.assigned), 0);
  return Object.entries(g).map(([group, rs]) => ({ group, rows: rs.sort((a, b) => (a.name === 'General') - (b.name === 'General') || String(a.name).localeCompare(String(b.name))),
    assigned: r2(rs.reduce((s, r) => s + r.assigned, 0)), activity: r2(rs.reduce((s, r) => s + r.activity, 0)), available: r2(rs.reduce((s, r) => s + r.available, 0)) }))
    .sort((a, b) => (a.group === 'Savings') - (b.group === 'Savings') || (a.group === 'Travel') - (b.group === 'Travel') || weight(b.rows) - weight(a.rows));
}

// Put each envelope's target in for the month where nothing is assigned yet.
export function assignTargets(cfg, month){
  const cur = { ...(cfg.assigned || {})[month] }; let n = 0, total = 0;
  Object.entries(cfg.targets || {}).forEach(([k, v]) => { if (+v > 0 && !(k in cur)){ cur[k] = +v; n++; total += +v; } });
  return { assigned: { ...(cfg.assigned || {}), [month]: cur }, n, total: r2(total) };
}
export function setAssigned(cfg, month, key, value){
  const cur = { ...(cfg.assigned || {})[month] }; const v = r2(+value || 0);
  if (v) cur[key] = v; else delete cur[key];
  return { ...(cfg.assigned || {}), [month]: cur };
}
export function moveAssigned(cfg, month, from, to, amount){
  const cur = { ...(cfg.assigned || {})[month] }, v = r2(+amount);
  if (from !== 'ready') cur[from] = r2((+cur[from] || 0) - v);
  if (to !== 'ready') cur[to] = r2((+cur[to] || 0) + v);
  return { ...(cfg.assigned || {}), [month]: cur };
}
