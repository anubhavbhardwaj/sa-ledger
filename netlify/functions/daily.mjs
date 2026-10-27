// Evening reminder at 21:00 (Berlin/Rome time): to each of you whose phone has the daily reminder on, a nudge to
// add the day's spending, unless you already added something today and nothing is waiting for review. It also says
// what changed in the budget today: an envelope gone overspent, money that came in waiting for a job.
// Netlify schedules are in UTC, so this runs at 19:00 and 20:00 UTC and only acts when it's 21:00 locally.
import { firestore } from '../lib/members.mjs';
import { sendTo, PEOPLE } from '../lib/push.mjs';
import { beat } from '../lib/health.mjs';
import { budgetMonth, makeBudget } from '../../public/envelopes.js';

const TZ = 'Europe/Berlin';
const USERNAME = { Anubhav: 'anubhav', Sulekha: 'sulekha' };

const local = (d, o) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o }).format(d);
// UTC instant of local midnight today.
function midnight(now) {
  const day = local(now, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  for (const off of [-1, -2, 0, -3, 1]) {                    // find the UTC offset that maps back to local 00:00
    const t = new Date(`${day}T00:00:00${off <= 0 ? '+' : '-'}${String(Math.abs(off)).padStart(2, '0')}:00`);
    if (local(t, { hour: '2-digit', hourCycle: 'h23' }) === '00' && local(t, { day: '2-digit' }) === day.slice(8)) return t;
  }
  return new Date(day + 'T00:00:00Z');
}

// "Return flight (Munich visit) by tomorrow" for things to book that are due within 3 days or overdue.
export function dueLines(toBook, trips, today) {
  const add = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
  return toBook.filter(x => !x.done && x.byDate && x.byDate <= add(today, 3) && trips[x.tripId])
    .sort((a, b) => a.byDate.localeCompare(b.byDate))
    .map(x => `${x.what} (${trips[x.tripId].name}) ${x.byDate < today ? 'is overdue' : x.byDate === today ? 'by today' : x.byDate === add(today, 1) ? 'by tomorrow' : 'by ' + x.byDate.slice(8) + '.' + x.byDate.slice(5, 7) + '.'}`);
}

// The budget's news of the day, for the evening message: an envelope that went overspent today, and money that came
// in today waiting for a job. Only things that changed today, so the same overspending doesn't come every night.
// data = { cfg, items, income, transfers, accounts, trips }; today = 'YYYY-MM-DD'; since = ISO time of local midnight.
export function moneyLines({ cfg, items = [], income = [], transfers = [], accounts = [], trips = {} } = {}, today, since) {
  if (!cfg || !(cfg.accounts || []).length || !cfg.start || today < cfg.start) return [];
  const accBy = new Map(accounts.map(a => [String(a.name || '').toLowerCase(), a])), acc = n => accBy.get(String(n || '').toLowerCase()) || null;
  const m = today.slice(0, 7), data = (old) => ({ items: old ? items.filter(x => !(String(x.createdAt || '') >= since)) : items, income: old ? income.filter(x => !(String(x.createdAt || '') >= since)) : income,
    transfers: old ? transfers.filter(x => !(String(x.createdAt || '') >= since)) : transfers, acc, now: m });
  const now = budgetMonth(cfg, m, data(false)), before = budgetMonth(cfg, m, data(true)); if (now.before) return [];
  const { describe, isB } = makeBudget(cfg, acc), name = k => { const d = describe(k); return d?.tripId ? (trips[d.tripId]?.name || 'a trip') : d?.name || k; };
  const was = new Map((before.rows || []).map(r => [r.key, r.available])), eur = v => '€' + Math.round(Math.abs(v)).toLocaleString('en-IE');
  const out = (now.rows || []).filter(r => r.available < -0.5 && !r.card && !(was.get(r.key) < -0.5)).map(r => `${name(r.key)} is ${eur(r.available)} overspent`);
  const cameIn = income.filter(i => String(i.createdAt || '') >= since && i.date >= cfg.start && isB(i.account)).reduce((t, i) => t + (+i.amount || 0), 0);
  if (cameIn >= 100 && now.ready > 0.5) out.push(`${eur(cameIn)} came in: ${eur(now.ready)} to assign`);
  return out;
}

export function message(person, { added, inbox, bookings, due = [], money = [] }) {
  const waiting = [inbox ? `${inbox} captured payment${inbox === 1 ? '' : 's'}` : '', bookings ? `${bookings} forwarded booking${bookings === 1 ? '' : 's'}` : ''].filter(Boolean);
  if (added && !waiting.length && !due.length && !money.length) return null;  // logged the day, nothing pending: stay quiet
  const w = waiting.length ? waiting.join(' and ') + (inbox + bookings > 1 ? ' are' : ' is') + ' waiting.' : '';
  const d = due.length ? ' To book: ' + due.slice(0, 3).join('; ') + (due.length > 3 ? ` and ${due.length - 3} more` : '') + '.' : '';
  const b = money.length ? ' Budget: ' + money.slice(0, 3).join('; ') + '.' : '';
  return {
    title: added ? (waiting.length ? 'Things to review' : due.length ? 'Bookings due soon' : 'Your budget') : 'Anything to add today?',
    body: (added ? `You added ${added} today. ${w}` : `Nothing added today, ${person}. ${w || (d || b ? '' : 'Tap to add today’s spending.')}`).trim() + d + b,
    url: waiting.length || due.length ? '/#overview' : money.length && added ? '/#budget' : '/#add', tag: 'daily',
  };
}

export async function run({ now = new Date(), force = false, loadTokens, countAdded, countInbox, countBookings, loadToBook = async () => ({ toBook: [], trips: {} }), loadBudget = async () => null, dropTokens, send }) {
  if (!force && local(now, { hour: '2-digit', hourCycle: 'h23' }) !== '21') return { skipped: 'not 21:00 in ' + TZ };
  const tokens = (await loadTokens()).filter(t => t.daily !== false);
  if (!tokens.length) return { sent: 0 };
  const since = midnight(now).toISOString();
  const [inbox, bookings, tb] = await Promise.all([countInbox(), countBookings(), loadToBook()]);
  const day = local(now, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  const due = dueLines(tb.toBook, tb.trips, day);
  let money = [];
  try { const bd = await loadBudget(); if (bd) money = moneyLines({ ...bd, trips: tb.trips }, day, since); } catch (e) { console.error('daily budget', e); }
  const out = { sent: 0, quiet: [] };
  for (const person of Object.values(PEOPLE)) {
    const mine = tokens.filter(t => PEOPLE[t.email] === person);
    if (!mine.length) continue;
    const msg = message(person, { added: await countAdded(USERNAME[person], since), inbox, bookings, due, money });
    if (!msg) { out.quiet.push(person); continue; }
    const dead = await sendTo(mine, msg, send);
    out.sent += mine.length - dead.length;
    if (dead.length) await dropTokens(dead);
  }
  return out;
}

export default async () => {
  const db = firestore();
  try {
    const res = await run({
      loadTokens: async () => (await db.collection('pushTokens').get()).docs.map(d => ({ id: d.id, ...d.data() })),
      countAdded: async (user, since) => {
        let n = 0;
        for (const c of ['expenses', 'income', 'transfers'])
          n += (await db.collection(c).where('createdAt', '>=', since).get()).docs.filter(d => d.data().createdBy === user).length;
        return n;
      },
      countInbox: async () => (await db.collection('inbox').get()).size,
      countBookings: async () => (await db.collection('bookingInbox').get()).size,
      loadToBook: async () => ({
        toBook: (await db.collection('toBook').where('done', '==', false).get()).docs.map(d => d.data()),
        trips: Object.fromEntries((await db.collection('trips').get()).docs.map(d => [d.id, d.data()])),
      }),
      // The envelope budget and what it needs (entries since it began), for the budget's news of the day.
      loadBudget: async () => {
        const ev = await db.collection('settings').doc('envelopes').get(); if (!ev.exists) return null;
        const cfg = ev.data(); if (!cfg?.start) return null;
        const since = async c => (await db.collection(c).where('date', '>=', cfg.start).get()).docs.map(d => d.data());
        const [items, income, transfers, accounts] = await Promise.all([since('expenses'), since('income'), since('transfers'), db.collection('accounts').get().then(q => q.docs.map(d => d.data()))]);
        return { cfg, items, income, transfers, accounts };
      },
      dropTokens: ids => Promise.all(ids.map(id => db.collection('pushTokens').doc(id).delete())),
    });
    console.log('daily', JSON.stringify(res));
    if (!res.skipped) await beat(db, 'daily', { info: `sent ${res.sent}${res.quiet?.length ? ', quiet for ' + res.quiet.join(' & ') : ''}` });
    return new Response(JSON.stringify(res), { status: 200 });
  } catch (e) {
    console.error('daily failed', e);
    await beat(db, 'daily', { ok: false, error: e.message });
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

export const config = { schedule: '0 19,20 * * *' };
