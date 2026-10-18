// 9:00 on weekdays (Berlin time): asks Anubhav's phone "Office or home today?" with two buttons. The answer goes to
// /api/workday and counts towards the commuting allowance and home office days in the app's Taxes view.
// Netlify schedules are in UTC, so this runs at 07:00 and 08:00 UTC and only acts when it's 9:00 locally.
import { firestore } from '../lib/members.mjs';
import { sendTo } from '../lib/push.mjs';
import { beat } from '../lib/health.mjs';
import { shouldAsk, sign, keyFrom, ASK_EMAIL, ASK_USER } from '../lib/workday.mjs';

const TZ = 'Europe/Berlin';
const local = (d, o) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...o }).format(d);

export function message(date, key){
  return { title: 'Office or home today?', body: 'For your tax return: tap Office or Home. Tap here for away or a day off.',
    url: '/#workday', tag: 'workday', ttl: 8 * 3600,
    data: { date, sig: sign(date, key), actions: JSON.stringify([{ action: 'office', title: 'Office' }, { action: 'home', title: 'Home' }]) } };
}

export async function run({ now = new Date(), force = false, key, load, dropTokens, send }){
  if (!force && local(now, { hour: '2-digit', hourCycle: 'h23' }) !== '09') return { skipped: 'not 9:00 in ' + TZ };
  const date = local(now, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  const ctx = await load(date);
  const why = shouldAsk(date, ctx);
  if (why) return { skipped: why, date };
  const tokens = ctx.tokens.filter(t => t.email === ASK_EMAIL);
  if (!tokens.length) return { skipped: 'no phone with notifications on', date };
  const dead = await sendTo(tokens, message(date, key), send);
  if (dead.length) await dropTokens(dead);
  return { sent: tokens.length - dead.length, date };
}

export default async () => {
  const db = firestore();
  try {
    const res = await run({
      key: keyFrom(process.env),
      load: async date => {
        const [tax, leave, answered, trips, tokens] = await Promise.all([
          db.collection('settings').doc('tax').get(), db.collection('settings').doc('leave').get(),
          db.collection('workdays').doc(`${ASK_USER}_${date}`).get(), db.collection('trips').get(), db.collection('pushTokens').get()]);
        return { tax: tax.exists ? tax.data() : {}, leave: leave.exists ? leave.data() : {}, answered: answered.exists,
          trips: trips.docs.map(d => d.data()), tokens: tokens.docs.map(d => ({ id: d.id, ...d.data() })) };
      },
      dropTokens: ids => Promise.all(ids.map(id => db.collection('pushTokens').doc(id).delete())),
    });
    console.log('workday-ask', JSON.stringify(res));
    if (!/not 9:00/.test(res.skipped || '')) await beat(db, 'workday', { info: res.sent ? `asked for ${res.date}` : `${res.date}: ${res.skipped}` });
    return new Response(JSON.stringify(res), { status: 200 });
  } catch (e) {
    console.error('workday-ask failed', e);
    await beat(db, 'workday', { ok: false, error: e.message });
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
};

export const config = { schedule: '0 7,8 * * 1-5' };
