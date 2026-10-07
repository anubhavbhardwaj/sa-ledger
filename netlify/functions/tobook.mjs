// "To book" from plain words: POST /api/tobook { text, trip: { name, start, end, type }, today }
// → { items: [{ what, type, forDate, byDate, price, note }] } for the app to show before adding.
// Uses the same Groq key as Ask AI.
import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { beat } from '../lib/health.mjs';

const MODEL = 'openai/gpt-oss-120b';
export const TYPES = ['flight', 'train', 'bus', 'ferry', 'hotel', 'car', 'event', 'restaurant', 'other'];

export const PROMPT = `You turn a short note about a trip into a checklist of things still to book.
Return JSON only: {"items":[...]}, one item per thing to book (an outbound and a return flight are two items; one hotel stay is one item).
Fields:
  what: short label in the user's language, e.g. "Flight Munich → Rome", "Hotel near Termini (3 nights)", "Colosseum tickets"
  type: one of ${TYPES.join(', ')}
  forDate: the date the booking is for, "YYYY-MM-DD" (the travel day, check-in day or event day), or null
  byDate: the deadline to book it, "YYYY-MM-DD", ONLY if the user says when to book it ("by end of October", "this week"), else null
  price: expected price in euros as a number if the user mentions one, else null
  note: any other detail worth keeping (preferences, times, seats, flexibility), short, or null
Resolve relative dates ("on the 15th", "next Friday", "the last day", "end of the month") using today's date and the trip dates given.
"Back on the 15th" means the return on the 15th of the trip's month (or the next month if that is before the trip starts).
Never invent things the user didn't ask for.`;

const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
export function clean(list) {
  return (Array.isArray(list) ? list : []).slice(0, 15).map(x => {
    if (!x || typeof x !== 'object' || !String(x.what || '').trim()) return null;
    const o = { what: String(x.what).trim().slice(0, 120), type: TYPES.includes(x.type) ? x.type : 'other', forDate: isDate(x.forDate), byDate: isDate(x.byDate),
      price: +x.price > 0 && +x.price < 1e6 ? Math.round(+x.price) : null, note: x.note ? String(x.note).trim().slice(0, 300) : null };
    if (o.byDate && o.forDate && o.byDate > o.forDate) o.byDate = null;
    return o;
  }).filter(Boolean);
}

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch } = {}) {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.GROQ_API_KEY) return json(503, { error: 'This needs GROQ_API_KEY in Netlify (same key as Ask AI).' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const text = String(body.text || '').trim().slice(0, 3000);
  if (text.length < 3) return json(400, { error: 'Write what you still need to book.' });
  const t = body.trip || {};
  const ctx = `Today: ${isDate(body.today) || new Date().toISOString().slice(0, 10)}. Trip: "${String(t.name || 'Trip').slice(0, 80)}"${t.type ? ' (' + String(t.type).slice(0, 20) + ')' : ''}${isDate(t.start) ? ', from ' + t.start : ''}${isDate(t.end) ? ' to ' + t.end : ''}.`;
  const r = await f('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify({ model: env.GROQ_EXTRACT_MODEL || env.GROQ_MODEL || MODEL, temperature: 0, max_completion_tokens: 2000, reasoning_effort: 'low',
      response_format: { type: 'json_object' }, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: ctx + '\n\nNote:\n' + text }] }),
  });
  if (!r.ok) return json(502, { error: r.status === 429 ? 'Groq’s rate limit was reached. Try again in a minute.' : 'Groq error ' + r.status });
  let parsed; try { parsed = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}'); } catch { return json(502, { error: 'The AI answer wasn’t readable. Try again.' }); }
  return json(200, { items: clean(parsed.items) });
}

export default async (req) => {
  try {
    const res = await handle(req);
    if (res.status === 200) await beat(firestore(), 'extract', { info: 'to-book list from text' });
    return res;
  } catch (e) { console.error('tobook failed', e); return json(500, { error: 'Something went wrong. Try again.' }); }
};

export const config = { path: '/api/tobook' };
