// Reads a travel booking (text taken from a PDF, an email or a pasted message) and returns its details as
// structured JSON: one entry per flight leg, train, hotel stay, rental, event and so on. The app reads the PDF
// and finds QR/barcodes itself; it sends what it found here so the model can tell which code belongs to which leg.
//
// Screenshots and scanned PDFs (no text layer) come as one image and go to a vision model instead.
//
// Environment: GROQ_API_KEY (same as Ask AI), FIREBASE_SERVICE_ACCOUNT, optional GROQ_EXTRACT_MODEL and
// GROQ_VISION_MODEL.

import { member, json, verifyToken, firestore } from '../lib/members.mjs';
import { beat } from '../lib/health.mjs';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
// Groq retired Llama 4 Scout in July 2026; Qwen 3.8 27B reads images (up to 3 per request). If a configured model is
// gone, the next one in the list is tried.
export const VISION_MODELS = ['qwen/qwen3.8-27b'];
const MAX_IMAGE = 4_000_000;   // characters of the base64 data URL (Groq's limit for inline images)
const MAX_TEXT = 60000;   // about 15k tokens; the model reads far more, but keeps cost and time low
export const TYPES = ['flight', 'train', 'bus', 'ferry', 'hotel', 'car', 'event', 'restaurant', 'other'];

export const PROMPT = `You extract travel bookings from confirmation emails, e-tickets and boarding passes for a personal travel log.
Return JSON only: {"bookings":[...]} with one object per separately usable item:
- each flight LEG is its own booking (a return trip is two; a connection is two), each train or bus ride its own, each hotel/apartment stay one, each car rental one, each event/tour/restaurant one.
- if the same leg appears for several passengers, make ONE booking and list all names in "travellers".
Fields (omit a field or use null when the document does not say; never invent):
  type: one of ${TYPES.join(', ')}
  title: short label, e.g. "LH 1840 Munich → Rome", "Frecciarossa 9541 Rome → Florence", "Hotel Artemide, Rome"
  provider: airline, rail company, hotel, rental company or venue
  ref: booking reference / PNR / confirmation number (the main one)
  number: flight or train number, e.g. "LH1840"
  travellers: array of passenger/guest names as printed
  start: local date-time at departure/check-in, "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DD" if no time)
  end: local date-time at arrival/check-out, same format
  from: departure city or station (with airport code if given, e.g. "Munich (MUC)")
  to: arrival city or station
  address: street address for hotels, rentals, venues
  seat: seat, coach/carriage, room or similar
  details: one short line of what matters on the day (terminal, gate, platform, boarding time, baggage allowance, check-in window, room type, pickup point)
  price: total amount paid for this item as a number (if one price covers several items, put it on the first only)
  currency: ISO code of that price, e.g. "EUR"
  codes: array of indexes of the scanned codes (listed below the document) that belong to this booking
Dates: the year may be missing in boarding passes; infer it from the document date. Times stay in local time; no time zones.
Barcode values of boarding passes (BCBP, starting with "M1") encode name, PNR, from/to airports, flight number and seat; use them.
If the document is not a booking at all, return {"bookings":[]}.`;

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch } = {}) {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.GROQ_API_KEY) return json(503, { error: 'Reading bookings needs GROQ_API_KEY in Netlify (same key as Ask AI).' });
  const m = await member(req, verify); if (m.res) return m.res;
  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const text = String(body.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, MAX_TEXT);
  const codes = (Array.isArray(body.codes) ? body.codes : []).slice(0, 12)
    .map((c, i) => `[${i}] page ${c.page || '?'} ${String(c.format || '').slice(0, 20)}: ${String(c.text || '').slice(0, 300)}`);
  const image = typeof body.image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(body.image) && body.image.length <= MAX_IMAGE ? body.image : null;
  if (text.trim().length < 20 && !codes.length && !image) return json(400, { error: 'There’s no readable text in that file. If it’s a scan or photo, add the details by hand.' });
  const user = `Document${body.name ? ' "' + String(body.name).slice(0, 120) + '"' : ''}${body.subject ? ', email subject: ' + String(body.subject).slice(0, 200) : ''}${body.date ? ', received ' + String(body.date).slice(0, 30) : ''}:\n\n${text}\n\nScanned codes:\n${codes.join('\n') || '(none)'}${image ? '\n\nThe booking itself is in the attached image.' : ''}`;

  const call = (model, withImage, jsonMode = true) => f('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify(withImage ? {
      model, temperature: 0, max_completion_tokens: 4000, reasoning_effort: 'none',
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image } }] }],
    } : {
      model, temperature: 0, max_completion_tokens: 4000, reasoning_effort: 'low',
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: user }],
    }),
  });
  // Models to try in order. A model that's gone (404, or 400 "does not exist / decommissioned") moves on to the next;
  // with text to go on, the text model is the last resort for an image.
  const textModel = env.GROQ_EXTRACT_MODEL || env.GROQ_MODEL || DEFAULT_MODEL;
  const plan = image
    ? [...new Set([env.GROQ_VISION_MODEL, ...VISION_MODELS].filter(Boolean))].map(m => [m, true]).concat(text.trim().length >= 20 || codes.length ? [[textModel, false]] : [])
    : [[textModel, false]];
  let parsed = null, last = '';
  for (const [model, withImage] of plan){
    for (const jsonMode of [true, false]){
      const r = await call(model, withImage, jsonMode);
      if (r.status === 429) return json(502, { error: 'Groq’s rate limit was reached. Try again in a minute.' });
      let b = null; try { b = await r.json(); } catch {}
      const msg = String(b?.error?.message || ''), code = String(b?.error?.code || '');
      if (!r.ok && (r.status === 404 || /model_not_found|decommission|does not exist|not have access/i.test(code + ' ' + msg))){ last = `${model}: ${msg || r.status}`; console.error('extract: model unavailable', last); break; }
      parsed = parseObj(r.ok ? b?.choices?.[0]?.message?.content : b?.error?.failed_generation);
      if (parsed) break;
      last = r.ok ? 'unreadable answer' : `${r.status} ${code} ${msg.slice(0, 160)}`.trim();
      if (r.ok || jsonMode === false) break;
    }
    if (parsed) break;
  }
  if (!parsed) return json(502, { error: 'The AI couldn’t read this (' + last + '). Try again, or add the details by hand.' });
  return json(200, { bookings: clean(parsed.bookings, codes.length) });
}

// The first {...} in a model answer, parsed (models sometimes wrap JSON in text or code fences); null if none.
export function parseObj(t){
  if (!t || typeof t !== 'string') return null;
  try { const o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch {}
  const a = t.indexOf('{'), z = t.lastIndexOf('}');
  if (a < 0 || z <= a) return null;
  try { const o = JSON.parse(t.slice(a, z + 1)); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

const s = (v, n) => (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim().slice(0, n) : undefined;
const dt = v => { const x = s(v, 25); if (!x) return undefined; const m = x.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/); return m ? m[1] + (m[2] ? 'T' + m[2] : '') : undefined; };

// Keep only well-formed fields, so the app can save them as they are.
export function clean(list, nCodes = 0) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map(b => {
    if (!b || typeof b !== 'object') return null;
    const o = {
      type: TYPES.includes(b.type) ? b.type : 'other',
      title: s(b.title, 120), provider: s(b.provider, 80), ref: s(b.ref, 40), number: s(b.number, 20),
      travellers: Array.isArray(b.travellers) ? b.travellers.map(t => s(t, 60)).filter(Boolean).slice(0, 9) : undefined,
      start: dt(b.start), end: dt(b.end), from: s(b.from, 80), to: s(b.to, 80), address: s(b.address, 200),
      seat: s(b.seat, 60), details: s(b.details, 300),
      price: +b.price > 0 && +b.price < 1e6 ? Math.round(+b.price * 100) / 100 : undefined,
      currency: typeof b.currency === 'string' && /^[A-Za-z]{3}$/.test(b.currency) ? b.currency.toUpperCase() : undefined,
      codes: Array.isArray(b.codes) ? [...new Set(b.codes.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < nCodes))] : [],
    };
    if (o.travellers && !o.travellers.length) delete o.travellers;
    if (o.end && o.start && o.end < o.start) delete o.end;
    if (!o.title) o.title = [o.number || o.provider, o.from && o.to ? o.from + ' → ' + o.to : o.to || o.address].filter(Boolean).join(' ') || 'Booking';
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  }).filter(Boolean);
}

export default async (req) => {
  try {
    const res = await handle(req);
    if (res.status >= 500 || res.status === 503) { const e = await res.clone().json().catch(() => ({})); await beat(firestore(), 'extract', { ok: false, error: e.error }); }
    else if (res.status === 200) await beat(firestore(), 'extract', {});
    return res;
  }
  catch (e) { console.error('extract failed', e); return json(500, { error: 'Something went wrong reading the booking. Try again.' }); }
};

export const config = { path: '/api/extract' };
