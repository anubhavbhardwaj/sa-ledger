// Reads all text from a photo (a form on a laptop screen, a printed page) when the phone's own text recognition
// couldn't. Only used as a fallback; the app says when a photo was sent here. POST /api/ocr { image } → { text }
import { member, json, verifyToken } from '../lib/members.mjs';
import { VISION_MODELS, parseObj } from './extract.mjs';

const MAX_IMAGE = 4_000_000;
export const PROMPT = `Transcribe all text visible in the image exactly as written, keeping each line on its own line, including form labels and the values typed into fields.
Do not correct spelling, do not translate, do not add anything. Return JSON only: {"text": "..."}`;

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch } = {}){
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.GROQ_API_KEY) return json(503, { error: 'This needs GROQ_API_KEY in Netlify.' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const image = typeof body.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(body.image) && body.image.length <= MAX_IMAGE ? body.image : null;
  if (!image) return json(400, { error: 'No usable image.' });
  let last = '';
  for (const model of [...new Set([env.GROQ_VISION_MODEL, ...VISION_MODELS].filter(Boolean))]){
    const r = await f('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
      body: JSON.stringify({ model, temperature: 0, max_completion_tokens: 3000, reasoning_effort: 'none', response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }] }),
    });
    if (r.status === 429) return json(502, { error: 'Groq’s rate limit was reached. Try again in a minute.' });
    let b = null; try { b = await r.json(); } catch {}
    const o = parseObj(r.ok ? b?.choices?.[0]?.message?.content : b?.error?.failed_generation);
    if (o && typeof o.text === 'string') return json(200, { text: o.text.slice(0, 20000) });
    last = r.ok ? 'unreadable answer' : `${r.status} ${b?.error?.message || ''}`.slice(0, 160);
  }
  return json(502, { error: 'The AI couldn’t read the photo (' + last + ').' });
}

export default async (req) => {
  try { return await handle(req); } catch (e) { console.error('ocr failed', e); return json(500, { error: 'Something went wrong.' }); }
};
export const config = { path: '/api/ocr' };
