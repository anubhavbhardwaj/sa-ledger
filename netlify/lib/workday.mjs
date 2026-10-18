// Office or home: Anubhav's workday log for the tax return (commuting allowance and home office days).
// Shared by the 9:00 question (functions/workday-ask.mjs) and the answer from the notification (functions/workday.mjs).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const WHERE = ['office', 'home', 'away', 'off'];
export const ASK_USER = 'anubhav', ASK_EMAIL = 'anubhav.iiitb@gmail.com';

const addDays = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
function easter(y){ const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
  h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
  mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1; return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`; }
// Public holidays in Bavaria (same list as the app).
export function holidaysBY(y){
  const e = easter(y), add = k => addDays(e, k);
  return new Set([`${y}-01-01`, `${y}-01-06`, add(-2), add(1), `${y}-05-01`, add(39), add(50), add(60), `${y}-08-15`, `${y}-10-03`, `${y}-11-01`, `${y}-12-25`, `${y}-12-26`]);
}

// The notification's Office/Home buttons answer without signing in, so each question carries a signature for that
// day that only the server can make (keyed on the Firebase service account's private key).
export const sign = (date, key) => createHmac('sha256', key).update(`workday|${ASK_USER}|${date}`).digest('hex').slice(0, 32);
export function checkSig(date, sig, key){
  if (typeof sig !== 'string' || sig.length !== 32) return false;
  const a = Buffer.from(sign(date, key)), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const keyFrom = env => { try { return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || '{}').private_key || ''; } catch { return ''; } };

// Whether to ask today: a weekday that isn't a holiday or the company shutdown, a workplace that's logged day by day,
// not already answered, and not in the middle of a trip (the first and last day of a trip are still asked).
export function shouldAsk(date, { tax = {}, answered = false, trips = [], leave = {} }){
  if (tax.ask === false) return 'turned off';
  const wd = new Date(date + 'T12:00:00Z').getUTCDay();
  if (wd === 0 || wd === 6) return 'weekend';
  if (holidaysBY(+date.slice(0, 4)).has(date)) return 'holiday';
  const sd = leave.years?.[date.slice(0, 4)]?.shutdown;
  if (sd?.start && sd?.end && date >= sd.start && date <= sd.end) return 'shutdown';
  const job = (tax.jobs || []).find(j => j.from <= date && (!j.to || date <= j.to));
  if (!job || job.mode !== 'log') return 'no workplace logged day by day';
  if (answered) return 'already answered';
  if (trips.some(t => ['Anubhav', 'Both'].includes(t.traveller) && t.start && t.end && t.start < date && date < t.end)) return 'on a trip';
  return null;
}
