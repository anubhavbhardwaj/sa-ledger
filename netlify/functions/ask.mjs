// "Ask AI": answers questions about the ledger with a Groq-hosted model. The app sends a compact summary of the
// finances (built in the browser) plus the conversation; this function checks the caller is one of the two
// members, adds the instructions, and streams the model's answer back as plain text.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   GROQ_API_KEY              from console.groq.com → API Keys
//   GROQ_MODEL                optional, defaults to openai/gpt-oss-120b
//   FIREBASE_SERVICE_ACCOUNT  already set; used to verify the signed-in user

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const MEMBERS = ['anubhav.iiitb@gmail.com', 'sulekha@sa-ledger.app'];
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_CONTEXT = 60000;     // characters of finance summary
const MAX_TURNS = 12;          // earlier messages kept from the conversation

export const SYSTEM = `You are the money assistant inside "S&A Ledger", a private finance app used by Anubhav and his fiancée Sulekha.
Anubhav lives in Germany (Ingolstadt/Munich), Sulekha in Rome; they travel to see each other often and plan to move to India in a few years.
You get a summary of their ledger, budgets, accounts, investments and FIRE plans below. Use it.

How to answer:
- Ground every point in their numbers. Quote amounts with currency and month. If the data doesn't cover something, say so plainly instead of guessing.
- Be specific and practical: name the category, merchant, account or investment, and what to change by how much.
- Keep it short: a direct answer first, then at most 5 bullets. Use simple Markdown (bold, bullets, short headings). No tables wider than 4 columns.
- Never use em dashes. Use commas, colons or full stops instead.
- Investments: returns are "since tracking began" (Dec 2024). Distinguish return in euros, in rupees and without currency moves when it matters. Rupee depreciation hurts euro returns but helps if they spend in India later.
- ULIP/LIC policies are modelled from assumed return rates, not market prices; treat their values as estimates.
- You are not a licensed financial adviser. For tax, legal or product-specific decisions (moving money to India, NRE/NRO, pension withdrawal, tax treaties), give the factual considerations and suggest checking with a qualified adviser. Don't push specific funds or stocks.`;

export async function handle(req, { env = process.env, verify, fetch: f = fetch } = {}) {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!env.GROQ_API_KEY) return json(503, { error: 'Ask AI is not set up yet: add GROQ_API_KEY in Netlify.' });
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Not signed in. Reload the app and sign in again.' });
  let email;
  try { email = String((await verify(token)).email || '').toLowerCase(); }
  catch (e) {
    console.error('ask: sign-in check failed', e?.code, e?.message);
    // A rejected token means the login itself; anything else is the server's own setup.
    if (String(e?.code || '').startsWith('auth/')) return json(401, { error: `Your sign-in couldn’t be confirmed (${e.code}). Sign out and in again.` });
    return json(500, { error: 'Server setup problem checking sign-in: ' + String(e?.message || e).slice(0, 160) });
  }
  if (!MEMBERS.includes(email)) return json(403, { error: 'Not allowed.' });

  let body; try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const context = String(body.context || '').slice(0, MAX_CONTEXT);
  const turns = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_TURNS).map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') return json(400, { error: 'Ask a question.' });

  const r = await f('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.GROQ_API_KEY },
    body: JSON.stringify({
      model: env.GROQ_MODEL || DEFAULT_MODEL, stream: true, temperature: 0.3, max_completion_tokens: 3000,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'system', content: 'Their finances right now (asked by ' + (email.startsWith('sulekha') ? 'Sulekha' : 'Anubhav') + '):\n' + context }, ...turns],
    }),
  });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    const msg = r.status === 429 ? 'Groq’s rate limit was reached. Wait a minute and ask again.' : r.status === 401 ? 'The Groq API key was rejected. Check GROQ_API_KEY in Netlify.' : 'Groq error ' + r.status + (t ? ': ' + t.slice(0, 200) : '');
    return json(502, { error: msg });
  }
  // Turn Groq's server-sent events into a plain stream of answer text (reasoning tokens are dropped).
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  const out = r.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim(); if (!s.startsWith('data:')) continue;
        const d = s.slice(5).trim(); if (d === '[DONE]') continue;
        try { const c = JSON.parse(d).choices?.[0]?.delta?.content; if (c) ctl.enqueue(enc.encode(c)); } catch {}
      }
    },
  }));
  return new Response(out, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let auth;
function verifier() {
  if (!auth) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
    auth = getAuth(getApps()[0] || initializeApp({ credential: cert(sa) }));
  }
  return auth;
}

export default async (req) => {
  try { return await handle(req, { verify: t => verifier().verifyIdToken(t) }); }
  catch (e) { console.error('ask failed', e); return json(500, { error: 'Something went wrong. Try again.' }); }
};

export const config = { path: '/api/ask' };
