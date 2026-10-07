// Evening reminder at 21:00 (Berlin/Rome time): to each of you whose phone has the daily reminder on, a nudge to
// add the day's spending, unless you already added something today and nothing is waiting for review.
// Netlify schedules are in UTC, so this runs at 19:00 and 20:00 UTC and only acts when it's 21:00 locally.
import { firestore } from '../lib/members.mjs';
import { sendTo, PEOPLE } from '../lib/push.mjs';
import { beat } from '../lib/health.mjs';

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

export function message(person, { added, inbox, bookings }) {
  const waiting = [inbox ? `${inbox} captured payment${inbox === 1 ? '' : 's'}` : '', bookings ? `${bookings} forwarded booking${bookings === 1 ? '' : 's'}` : ''].filter(Boolean);
  if (added && !waiting.length) return null;                // logged the day, nothing pending: stay quiet
  const w = waiting.length ? waiting.join(' and ') + (inbox + bookings > 1 ? ' are' : ' is') + ' waiting.' : '';
  return {
    title: added ? 'Things to review' : 'Anything to add today?',
    body: added ? `You added ${added} today. ${w}` : `Nothing added today, ${person}. ${w || 'Tap to add today’s spending.'}`.trim(),
    url: waiting.length ? '/#overview' : '/#add', tag: 'daily',
  };
}

export async function run({ now = new Date(), force = false, loadTokens, countAdded, countInbox, countBookings, dropTokens, send }) {
  if (!force && local(now, { hour: '2-digit', hourCycle: 'h23' }) !== '21') return { skipped: 'not 21:00 in ' + TZ };
  const tokens = (await loadTokens()).filter(t => t.daily !== false);
  if (!tokens.length) return { sent: 0 };
  const since = midnight(now).toISOString();
  const [inbox, bookings] = await Promise.all([countInbox(), countBookings()]);
  const out = { sent: 0, quiet: [] };
  for (const person of Object.values(PEOPLE)) {
    const mine = tokens.filter(t => PEOPLE[t.email] === person);
    if (!mine.length) continue;
    const msg = message(person, { added: await countAdded(USERNAME[person], since), inbox, bookings });
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
