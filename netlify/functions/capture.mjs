// Receives payment notifications forwarded from a phone (e.g. MacroDroid) and puts them in the
// ledger's "To review" inbox in Firestore. Nothing is added to the ledger itself until someone
// confirms it in the app.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   FIREBASE_SERVICE_ACCOUNT  the Firebase service account key (the whole JSON file contents)
//   CAPTURE_TOKENS            who may post, as name:secret pairs, e.g. "anubhav:abc123,sulekha:def456"
//
// Accepts POST with JSON, form fields or plain text. Fields: app, title, text (all optional, but
// there must be an amount somewhere). The secret goes in an "Authorization: Bearer <secret>" or
// "X-Capture-Token" header, or a "token" field.

import { createHash, timingSafeEqual } from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { parseNotification, guessAccount } from '../../public/parse.js';
import { beat } from '../lib/health.mjs';

const MAX = 1000;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tokensFromEnv(env) {
  return String(env.CAPTURE_TOKENS || '').split(',').map(p => p.trim()).filter(Boolean)
    .map(p => { const i = p.indexOf(':'); return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : null; })
    .filter(x => x && x[1].length >= 16);
}
function whoIs(secret, env) {
  if (!secret) return null;
  const a = Buffer.from(secret);
  for (const [name, s] of tokensFromEnv(env)) {
    const b = Buffer.from(s);
    if (a.length === b.length && timingSafeEqual(a, b)) return name;
  }
  return null;
}

async function readBody(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  const raw = await req.text();
  if (!raw) return {};
  if (type.includes('json') || /^\s*\{/.test(raw)) {
    try { return JSON.parse(raw); } catch {
      // Notification text with quotes in it breaks naively-built JSON. Recover the known fields.
      const out = {}, keys = 'app|app_name|title|text|message|body|token';
      for (const k of keys.split('|')) {
        const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"(?:${keys})"\\s*:|\\s*\\}\\s*$)`));
        if (m) out[k] = m[1].replace(/\\"/g, '"');
      }
      if (Object.keys(out).length) return out;
    }
  }
  if (type.includes('x-www-form-urlencoded') || /^[\w-]+=/.test(raw)) return Object.fromEntries(new URLSearchParams(raw));
  return { text: raw };
}

const str = v => (v == null ? '' : String(v)).replace(/\u0000/g, '').trim().slice(0, MAX);

// Core logic, separated from Firebase so it can be tested.
export async function handle(req, { env = process.env, save, now = () => new Date() } = {}) {
  if (req.method === 'GET') return json(200, { ok: true, service: 'sa-ledger capture' });
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });

  const url = new URL(req.url);
  const body = await readBody(req);
  const auth = req.headers.get('authorization') || '';
  const secret = (auth.match(/^Bearer\s+(.+)$/i) || [])[1] || req.headers.get('x-capture-token') || body.token || url.searchParams.get('token');
  const user = whoIs(str(secret), env);
  if (!user) return json(401, { error: 'Unknown or missing capture token' });

  const app = str(body.app || body.app_name || url.searchParams.get('app'));
  const title = str(body.title || url.searchParams.get('title'));
  const text = str(body.text || body.message || body.body || url.searchParams.get('text'));
  const parsed = parseNotification({ app, title, text });
  if (!parsed) return json(200, { ok: true, skipped: 'Not a payment notification (no amount found)' });

  const at = now();
  // Same notification delivered twice within a minute gets the same id, so it's stored once.
  const id = createHash('sha256').update([user, app, title, text, at.toISOString().slice(0, 16)].join('|')).digest('hex').slice(0, 24);
  const docBody = {
    app, title, text,
    amount: parsed.amount, currency: parsed.currency, merchant: parsed.merchant, direction: parsed.direction,
    account: guessAccount(app),
    capturedBy: user, receivedAt: at.toISOString(),
  };
  await save(id, docBody);
  return json(201, { ok: true, id, amount: parsed.amount, currency: parsed.currency, merchant: parsed.merchant, direction: parsed.direction });
}

let db;
function firestore() {
  if (!db) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    const app = getApps()[0] || initializeApp({ credential: cert(sa) });
    db = getFirestore(app);
  }
  return db;
}

export default async (req) => {
  try {
    return await handle(req, { save: async (id, data) => { await firestore().collection('inbox').doc(id).set(data); await beat(firestore(), 'capture', { info: [data.merchant, data.capturedBy].filter(Boolean).join(' · ').slice(0, 80) }); } });
  } catch (e) {
    console.error('capture failed', e);
    try { await beat(firestore(), 'capture', { ok: false, error: e.message }); } catch {}
    return json(500, { error: 'Could not save the notification' });
  }
};

export const config = { path: '/api/capture' };
