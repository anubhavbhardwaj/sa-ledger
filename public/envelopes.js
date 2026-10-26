// Envelope budgeting the YNAB way, with your own structure: you make categories (groups such as "Fixed" or
// "Flexible"), put envelopes in them (Rent, Internet, Groceries, …) and choose which of your logged spending goes into
// each envelope: a whole category ("Eating out") or a category › subcategory ("Utilities › Electricity").
// The most specific match wins; spending that matches no envelope shows under "Not assigned".
//
// Each month every envelope has Assigned (money given to it), Activity (spent from it) and Available (what's left,
// rolled over). Only the budget accounts count (e.g. Deutsche Bank, Wise Sulekha, Wise Common and the cards):
// - Ready to Assign starts with the money in them the day before the start (cash minus card debt) and grows with
//   income paid into them and money coming in from other accounts;
// - money moved from a budget account to any other account (investing, sending to India) is Activity in
//   Savings › Investing & India; moves between budget accounts (incl. paying a card) change nothing;
// - with trips on, spending on a trip goes to that trip's envelope under Travel;
// - like YNAB, an envelope that ends a month overspent starts the next one at zero and the overspending comes out of
//   that month's Ready to Assign.
//
// Spending in envelope categories paid from an account outside the budget isn't counted, but it's reported (outside),
// so it doesn't vanish silently; accounts in cfg.excluded are left out of that report on purpose.
//
// cfg = { start, accounts: [names], excluded: [names], opening, trips, groups: [{ id, name, envs: [{ id, name, src: ['Cat', 'Cat›Sub'] }] }],
//         assigned: { 'YYYY-MM': { envId: € } }, targets: { envId: € } }

const r2 = v => Math.round(v * 100) / 100;
export const SEP = '›';
export const SAVE_KEY = 's_save', NONE_KEY = 'u_none';
export const tripKey = id => 't_' + String(id).replace(/[^A-Za-z0-9_-]/g, '');
export const srcOf = (cat, sub) => { const c = String(cat || '').trim(), u = String(sub || '').trim(); return u ? `${c}${SEP}${u}` : c; };
// Sources match without regard to case or extra spaces ("Eating Out" and "eating out " are the same spending).
export const norm = s => String(s || '').trim().toLowerCase();
export const srcLabel = s => s.includes(SEP) ? s.split(SEP).join(' › ') : `${s} (all)`;
export const newId = () => 'e_' + Math.random().toString(36).slice(2, 10);
export const monthsBetween = (a, b) => { const out = []; let [y, m] = a.split('-').map(Number); const [Y, M] = b.split('-').map(Number);
  while (y < Y || (y === Y && m <= M)){ out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12){ m = 1; y++; } } return out; };

export function makeBudget(cfg){
  const idx = new Map(), info = new Map();
  (cfg.groups || []).forEach(g => (g.envs || []).forEach(e => { info.set(e.id, { group: g.name, name: e.name, gid: g.id });
    (e.src || []).forEach(s => { if (!idx.has(norm(s))) idx.set(norm(s), e.id); }); }));
  const inB = new Set((cfg.accounts || []).map(a => String(a).toLowerCase()));
  const isB = name => inB.has(String(name || '').toLowerCase());
  const keyFor = e => cfg.trips !== false && e.tripId ? tripKey(e.tripId)
    : idx.get(norm(srcOf(e.category, e.subcategory))) || idx.get(norm(srcOf(e.category))) || NONE_KEY;
  const describe = k => k === SAVE_KEY ? { group: 'Savings', name: 'Investing & India', save: true }
    : k === NONE_KEY ? { group: 'Not assigned', name: 'Spending in no envelope', none: true }
    : k.startsWith('t_') ? { group: 'Travel', tripId: k.slice(2) }
    : info.get(k) || null;
  return { isB, keyFor, describe, info };
}

// The month's numbers. data = { items, income, transfers }.
export function budgetMonth(cfg, month, { items = [], income = [], transfers = [] } = {}){
  const start = cfg.start, sm = start.slice(0, 7);
  if (month < sm) return { before: true, ready: 0, rows: [] };
  const { isB, keyFor, describe } = makeBudget(cfg), after = d => d >= start;
  const act = {}, inflow = {}, outside = {}, ex = new Set((cfg.excluded || []).map(a => String(a).toLowerCase()));
  const add = (m, k, v) => { (act[m] ||= {}); act[m][k] = (act[m][k] || 0) + v; };
  items.forEach(e => {
    if (!after(e.date)) return;
    const m = e.date.slice(0, 7), k = keyFor(e), v = +e.amount || 0;
    if (isB(e.account)) return add(m, k, -v);
    if (k === NONE_KEY || ex.has(String(e.account || '').toLowerCase())) return;
    const o = (outside[m] ||= { total: 0, byAcc: {}, byKey: {} }), acc = e.account || '(no account)';
    o.total += v; o.byAcc[acc] = (o.byAcc[acc] || 0) + v; o.byKey[k] = (o.byKey[k] || 0) + v;
  });
  income.forEach(i => { if (after(i.date) && isB(i.account)) inflow[i.date.slice(0, 7)] = (inflow[i.date.slice(0, 7)] || 0) + (+i.amount || 0); });
  transfers.forEach(t => {
    if (!after(t.date)) return;
    const f = isB(t.from), to = isB(t.to), m = t.date.slice(0, 7), v = +t.amount || 0;
    if (f && !to) add(m, SAVE_KEY, -v); else if (!f && to) inflow[m] = (inflow[m] || 0) + v;
  });
  // Money assigned to an envelope that has since been deleted goes back to Ready to Assign.
  const known = k => !!describe(k);
  let ready = +cfg.opening || 0, avail = {}, out = null;
  for (const m of monthsBetween(sm, month)){
    const asg = Object.fromEntries(Object.entries((cfg.assigned || {})[m] || {}).filter(([k]) => known(k))), a = act[m] || {};
    const keys = new Set([...Object.keys(avail), ...Object.keys(asg), ...Object.keys(a)]);
    let overspent = 0;
    for (const k of Object.keys(avail)) if (avail[k] < 0){ overspent += avail[k]; avail[k] = 0; }
    const carry = { ...avail }, assignedSum = Object.values(asg).reduce((s, v) => s + (+v || 0), 0);
    for (const k of keys) avail[k] = r2((avail[k] || 0) + (+asg[k] || 0) + (a[k] || 0));
    ready = r2(ready + (inflow[m] || 0) - assignedSum + overspent);
    if (m === month) out = { inflow: r2(inflow[m] || 0), assigned: r2(assignedSum), overspentLast: r2(-overspent),
      outside: { total: r2((outside[m] || {}).total || 0), byAcc: Object.entries((outside[m] || {}).byAcc || {}).map(([acc, amount]) => ({ acc, amount: r2(amount) })).sort((a, b) => b.amount - a.amount), byKey: (outside[m] || {}).byKey || {} },
      rows: [...keys].map(k => ({ key: k, ...describe(k), carry: r2(carry[k] || 0), assigned: r2(+asg[k] || 0), activity: r2(a[k] || 0), available: avail[k] })) };
  }
  return { ready, ...out };
}

// Rows in your order: your categories as you arranged them, then Travel and Savings; Not assigned first when it has
// spending, so it gets noticed.
export function groupRows(cfg, rows){
  const by = new Map(rows.map(r => [r.key, r]));
  const sum = (rs, f) => r2(rs.reduce((s, r) => s + r[f], 0));
  const pack = (group, rs, extra = {}) => ({ group, rows: rs, assigned: sum(rs, 'assigned'), activity: sum(rs, 'activity'), available: sum(rs, 'available'), ...extra });
  const out = [];
  const none = by.get(NONE_KEY); if (none && (none.activity || none.available)) out.push(pack('Not assigned', [none], { none: true }));
  (cfg.groups || []).forEach(g => out.push(pack(g.name, (g.envs || []).map(e => by.get(e.id)).filter(Boolean), { gid: g.id })));
  const trips = rows.filter(r => r.key.startsWith('t_')); if (trips.length) out.push(pack('Travel', trips));
  const save = by.get(SAVE_KEY); if (save) out.push(pack('Savings', [save]));
  return out;
}

// Spending on the budget accounts by source (category, or category › subcategory) that no envelope covers yet, largest first.
export function unassignedSources(cfg, items, since){
  const { keyFor, isB } = makeBudget(cfg), tot = {};
  items.filter(i => i.date >= since && isB(i.account) && !(cfg.trips !== false && i.tripId) && keyFor(i) === NONE_KEY)
    .forEach(i => { const s = srcOf(i.category, i.subcategory), k = norm(s); (tot[k] ||= { src: s, amount: 0 }).amount += +i.amount || 0; });
  return Object.values(tot).map(x => ({ src: x.src, amount: r2(x.amount) })).sort((a, b) => b.amount - a.amount);
}
// Every source in the data, for picking: each category (all of it) followed by its subcategories.
export function allSources(items){
  // One entry per category and subcategory whatever its case, shown as most often written.
  const cats = {}, pick = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0][0];
  items.forEach(i => { const c = String(i.category || '').trim(); if (!c) return;
    const C = (cats[norm(c)] ||= { names: {}, subs: {} }); C.names[c] = (C.names[c] || 0) + 1;
    const u = String(i.subcategory || '').trim(); if (u){ const U = (C.subs[norm(u)] ||= {}); U[u] = (U[u] || 0) + 1; } });
  return Object.values(cats).map(C => ({ c: pick(C.names), subs: Object.values(C.subs).map(pick) })).sort((a, b) => a.c.localeCompare(b.c))
    .flatMap(({ c, subs }) => [srcOf(c), ...subs.sort().map(u => srcOf(c, u))]);
}

// What spending looks like, to help pick a target: per source and per envelope, this month so far, last month and
// the average of the last three full months. Same rules as the budget (budget accounts only; trips apart when on).
// Source figures are keyed by norm(source) and count everything in that category or subcategory; the envelope figures count what would
// actually land in it (the most specific source wins).
export function spendingStats(cfg, items, month){
  const { keyFor, isB } = makeBudget(cfg), prev = [1, 2, 3].map(k => monthsBetween(shift(month, -k), shift(month, -k))[0]);
  const want = new Set([month, ...prev]), src = {}, env = {};
  const bump = (o, k, m, v) => { const x = (o[k] ||= { cur: 0, last: 0, sum3: 0 }); if (m === month) x.cur += v; else { x.sum3 += v; if (m === prev[0]) x.last += v; } };
  items.forEach(i => {
    const m = String(i.date).slice(0, 7);
    if (!want.has(m) || !isB(i.account) || (cfg.trips !== false && i.tripId)) return;
    const v = +i.amount || 0;
    bump(src, norm(srcOf(i.category)), m, v); if (String(i.subcategory || '').trim()) bump(src, norm(srcOf(i.category, i.subcategory)), m, v);
    const k = keyFor(i); if (k !== NONE_KEY) bump(env, k, m, v);
  });
  const fin = o => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, { cur: r2(x.cur), last: r2(x.last), avg: r2(x.sum3 / 3) }]));
  return { src: fin(src), env: fin(env) };
}
const shift = (m, k) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };

export function assignTargets(cfg, month){
  const ids = new Set((cfg.groups || []).flatMap(g => (g.envs || []).map(e => e.id)));
  const cur = { ...(cfg.assigned || {})[month] }; let n = 0, total = 0;
  Object.entries(cfg.targets || {}).forEach(([k, v]) => { if (ids.has(k) && +v > 0 && !(k in cur)){ cur[k] = +v; n++; total += +v; } });
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
