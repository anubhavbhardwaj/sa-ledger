// "Ask AI to choose" in the trip planner: the app sends the flight combinations it found (one compact line each,
// with an id) and the conditions typed in plain words; the model (Groq, same key as Ask AI) picks the best ones and
// says why. POST /api/trip-ai { context, conditions, options: [{ id, text }] } → { summary, picks: [{ id, label, why }] }
import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { beat } from '../lib/health.mjs';

const MODEL = 'openai/gpt-oss-120b';
export const PROMPT = `You help a couple choose flights for a trip. Anubhav lives in Ingolstadt (Germany), his fiancée Sulekha in Rome.
You get the trip's setup, their conditions in their own words, and a numbered list of flight combinations that were actually found
(prices in euros per person, times local at each airport). Choose the best options for THEM.

Rules:
- Only choose from the list, by its id. Never invent flights, prices or times.
- Treat clear conditions ("can't leave before 17:00", "no Ryanair", "must be back by Monday night") as hard rules: drop options that break them.
  Treat preferences ("prefer", "ideally", "rather") as trade-offs.
- Weigh total price, time together, how tiring the travel is (stops, very early or very late flights, airport far from home), and the conditions.
- Return 1 to 3 picks, best first, that differ in a meaningful way (e.g. cheapest acceptable, most time together, a balanced one). Fewer if only one makes sense.
- "why" is one or two short sentences with concrete numbers (price, hours together, times) and the trade-off versus the others.
- "summary" is one or two sentences: the recommendation, and anything important (e.g. no option meets a condition, so the closest one is shown).
- Plain words. Never use em dashes.
Return JSON only: {"summary": "...", "picks": [{"id": "...", "label": "2 to 5 words", "why": "..."}]}`;

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch } = {}){
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.GROQ_API_KEY) return json(503, { error: 'This needs GROQ_API_KEY in Netlify (same key as Ask AI).' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const options = (Array.isArray(body.options) ? body.options : []).slice(0, 80)
    .filter(o => o && /^[a-z0-9]{1,8}$/i.test(String(o.id)) && typeof o.text === 'string').map(o => ({ id: String(o.id), text: o.text.slice(0, 600) }));
  if (!options.length) return json(400, { error: 'Search for flights first.' });
  const user = `Trip setup:\n${String(body.context || '').slice(0, 2000)}\n\nTheir conditions:\n${String(body.conditions || '').trim().slice(0, 1500) || '(none given: pick the best balance of price and time together)'}\n\nOptions found:\n${options.map(o => `[${o.id}] ${o.text}`).join('\n')}`;
  const r = await f('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify({ model: env.GROQ_MODEL || MODEL, temperature: 0.2, max_completion_tokens: 2500, reasoning_effort: 'medium',
      response_format: { type: 'json_object' }, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: user }] }),
  });
  if (!r.ok) return json(502, { error: r.status === 429 ? 'Groq’s rate limit was reached. Try again in a minute.' : 'Groq error ' + r.status });
  let out; try { out = JSON.parse((await r.json()).choices?.[0]?.message?.content || '{}'); } catch { return json(502, { error: 'The AI answer wasn’t readable. Try again.' }); }
  const ids = new Set(options.map(o => o.id)), seen = new Set();
  const picks = (Array.isArray(out.picks) ? out.picks : []).filter(p => p && ids.has(String(p.id)) && !seen.has(String(p.id)) && seen.add(String(p.id))).slice(0, 3)
    .map(p => ({ id: String(p.id), label: String(p.label || 'AI pick').slice(0, 40), why: String(p.why || '').replace(/\s*\u2014\s*/g, ', ').slice(0, 400) }));
  return json(200, { summary: String(out.summary || '').replace(/\s*\u2014\s*/g, ', ').slice(0, 500), picks });
}

export default async (req) => {
  try {
    const res = await handle(req);
    if (res.status === 200) await beat(firestore(), 'ask', { info: 'trip planner pick' });
    return res;
  } catch (e) { console.error('trip-ai failed', e); return json(500, { error: 'Something went wrong. Try again.' }); }
};

export const config = { path: '/api/trip-ai' };
