// Subscriptions and other recurring charges, found from the rhythm of your own entries: same store, a regular gap
// (weekly, every 2 weeks, monthly, quarterly, yearly) and a steady amount. For each: the next date and amount, a
// price change, and whether an expected charge hasn't shown up. Runs in the browser, no service.
import { normStore } from './smart.js';

export const PERIODS = [
  { id: 'weekly', days: 7, tol: 2, min: 4, label: 'every week', perMonth: 52 / 12 },
  { id: 'biweekly', days: 14, tol: 3, min: 3, label: 'every 2 weeks', perMonth: 26 / 12 },
  { id: 'monthly', days: 30.44, tol: 6, min: 3, label: 'every month', perMonth: 1 },
  { id: 'quarterly', days: 91.31, tol: 12, min: 3, label: 'every 3 months', perMonth: 1 / 3 },
  { id: 'yearly', days: 365.25, tol: 20, min: 2, label: 'every year', perMonth: 1 / 12 },
];
const DAY = 864e5;
const dnum = d => Math.round(Date.parse(d + 'T12:00:00Z') / DAY);
const dstr = n => new Date(n * DAY).toISOString().slice(0, 10);
const median = a => { const b = [...a].sort((x, y) => x - y), n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
// Same day of month, one or more months later (31 Jan + 1 month = 28/29 Feb).
function addMonthsKeepDay(d, k, dom){
  const [y, m] = d.split('-').map(Number), last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + k, Math.min(dom, last))).toISOString().slice(0, 10);
}

// One series of rows (sorted by date) → its rhythm, or null.
export function fitSeries(rows){
  if (rows.length < 2) return null;
  const days = rows.map(r => dnum(r.date)), gaps = days.slice(1).map((d, i) => d - days[i]);
  if (gaps.some(g => g <= 0)) return null;                                   // two on one day: not one subscription
  let best = null;
  for (const P of PERIODS){
    if (rows.length < P.min) continue;
    const ok = gaps.filter(g => Math.abs(g - P.days) <= P.tol).length, share = ok / gaps.length;
    if (share >= 0.75 && (!best || share > best.share)) best = { P, share };
  }
  if (!best) return null;
  const amts = rows.map(r => +r.amount || 0), base = median(amts.slice(0, -1)), last = amts[amts.length - 1];
  const spread = median(amts.map(a => Math.abs(a - median(amts)))) / (median(amts) || 1);
  if (spread > 0.15) return null;                                            // amounts all over the place: shopping, not a bill
  return { P: best.P, share: best.share, last, base };
}

// Next expected date after the last row.
export function nextDate(rows, P){
  const last = rows[rows.length - 1].date;
  if (P.id === 'monthly' || P.id === 'quarterly' || P.id === 'yearly'){
    const dom = Math.round(median(rows.slice(-3).map(r => +r.date.slice(8, 10))));
    return addMonthsKeepDay(last, P.id === 'monthly' ? 1 : P.id === 'quarterly' ? 3 : 12, dom);
  }
  return dstr(dnum(last) + P.days);
}

// All recurring expenses. items: the ledger; today: 'YYYY-MM-DD'.
export function detectRecurring(items, today){
  const groups = new Map();
  for (const i of items){
    if (i.tripId || !i.store || !i.date || !(+i.amount > 0)) continue;
    const k = normStore(i.store); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const out = [];
  for (const [key, all] of groups){
    all.sort((a, b) => a.date.localeCompare(b.date));
    // The whole store first; if that isn't regular, try amount groups (two subscriptions at one store, e.g. Apple).
    let series = [all];
    if (!fitSeries(all)){
      const sorted = [...all].sort((a, b) => a.amount - b.amount), clusters = [];
      for (const r of sorted){ const c = clusters.find(c => Math.abs(r.amount - c.ref) <= c.ref * 0.15); c ? c.rows.push(r) : clusters.push({ ref: +r.amount, rows: [r] }); }
      series = clusters.map(c => c.rows.sort((a, b) => a.date.localeCompare(b.date)));
    }
    for (const rows of series){
      const fit = fitSeries(rows); if (!fit) continue;
      const { P } = fit, next = nextDate(rows, P), late = dnum(today) - dnum(next);
      if (late > P.days * 2 + P.tol) continue;                                // stopped a while ago
      const cats = {}; rows.forEach(r => cats[r.category] = (cats[r.category] || 0) + 1);
      // A price change: the latest amount differs from the usual one; dated at the first charge at the new price.
      let on = rows.length - 1; while (on > 0 && Math.abs(+rows[on - 1].amount - fit.last) <= Math.max(0.01, fit.last * 0.01)) on--;
      const change = Math.abs(fit.last - fit.base) >= Math.max(0.5, fit.base * 0.03) ? { from: fit.base, to: fit.last, on: rows[on].date } : null;
      out.push({
        key: key + '|' + Math.round(fit.last), store: rows[rows.length - 1].store, period: P.id, label: P.label, count: rows.length,
        amount: fit.last, monthly: fit.last * P.perMonth, next, account: rows[rows.length - 1].account,
        category: Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0], last: rows[rows.length - 1].date,
        status: late > P.tol ? 'missed' : late >= -7 ? 'soon' : 'ok', change, ids: rows.map(r => r.id),
      });
    }
  }
  return out.sort((a, b) => a.next.localeCompare(b.next));
}

// Backtest: for every series with one more charge than needed, hide the last charge and predict it from the rest.
export function backtest(items, today){
  let n = 0, dateOk = 0, amtOk = 0;
  for (const s of detectRecurring(items, today)){
    const rows = items.filter(i => s.ids.includes(i.id)).sort((a, b) => a.date.localeCompare(b.date));
    const head = rows.slice(0, -1), fit = fitSeries(head); if (!fit || fit.P.id !== s.period) continue;
    n++;
    const pred = nextDate(head, fit.P), act = rows[rows.length - 1];
    if (Math.abs(dnum(pred) - dnum(act.date)) <= Math.min(3, fit.P.tol)) dateOk++;
    if (Math.abs(fit.last - act.amount) <= Math.max(0.01, act.amount * 0.02)) amtOk++;
  }
  return { n, dateOk, amtOk };
}
