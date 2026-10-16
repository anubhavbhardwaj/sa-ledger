// Browser test harness: the real app from public/, a fake Firebase (tests/e2e/mock), and the real Netlify function
// handlers for /api/* talking to fake SerpApi and Groq. Nothing leaves the machine.
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { allowedFields } from '../support/rules.mjs';
import { verify, fakeSerpApi, fakeGroq, memoryCache } from '../support/fakes.mjs';
import { handle as tripPlan } from '../../netlify/functions/trip-plan.mjs';
import { handle as tripAi } from '../../netlify/functions/trip-ai.mjs';

const ROOT = new URL('../../', import.meta.url).pathname, MOCK = new URL('./mock/', import.meta.url).pathname;
const FS_MOCK = readFileSync(MOCK + 'fs.js', 'utf8').replace('/*ALLOWED*/{}', JSON.stringify(allowedFields()));
const MOCKS = { 'firebase-app.js': readFileSync(MOCK + 'app.js', 'utf8'), 'firebase-auth.js': readFileSync(MOCK + 'auth.js', 'utf8'), 'firebase-firestore.js': FS_MOCK };
const TYPES = { html: 'text/html', js: 'text/javascript', json: 'application/json', webmanifest: 'application/manifest+json', png: 'image/png', svg: 'image/svg+xml', css: 'text/css' };

let browser;
export async function start(){ browser = await chromium.launch(); }
export async function stop(){ await browser?.close(); }

// The AI stand-in picks the first two options it was given.
const aiAnswer = body => { const ids = [...body.messages[1].content.matchAll(/^\[(\w+)\]/gm)].map(m => m[1]);
  return { summary: 'Test pick: the first options.', picks: ids.slice(0, 2).map((id, i) => ({ id, label: i ? 'Second' : 'First', why: 'Chosen by the test model.' })) }; };

export async function openApp({ mobile = false, serp = {}, user = 'anubhav' } = {}){
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 1000 } }) });
  const page = await ctx.newPage();
  const errors = [], api = { calls: [], serp: [] };
  page.on('pageerror', e => errors.push(e.message));
  const cache = memoryCache(), serpFetch = fakeSerpApi({ calls: api.serp, ...serp });
  await page.route(/^https:\/\/(fonts\.|cdn\.jsdelivr)/, r => r.abort());
  await page.route('https://www.gstatic.com/**', r => {
    const f = Object.keys(MOCKS).find(k => r.request().url().endsWith(k));
    return f ? r.fulfill({ contentType: 'text/javascript', body: MOCKS[f] }) : r.fulfill({ contentType: 'text/javascript', body: 'export {}' });
  });
  await page.route('http://app.test/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/api/')){
      api.calls.push(u.pathname);
      const req = new Request(u.href, { method: r.request().method(), headers: r.request().headers(), body: r.request().method() === 'POST' ? r.request().postData() : undefined });
      const env = { SERPAPI_KEY: 'test', GROQ_API_KEY: 'test' };
      const handler = { '/api/trip-plan': () => tripPlan(req, { env, verify, fetch: serpFetch, cache }), '/api/trip-ai': () => tripAi(req, { env, verify, fetch: fakeGroq(aiAnswer) }) }[u.pathname];
      if (!handler) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not in tests"}' });
      const res = await handler();
      return r.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    }
    const file = ROOT + 'public' + (u.pathname === '/' ? '/index.html' : u.pathname);
    if (!existsSync(file)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ body: readFileSync(file), contentType: TYPES[file.split('.').pop()] || 'application/octet-stream' });
  });
  await page.goto('http://app.test/');
  await page.fill('#l-user', user); await page.fill('#l-pass', 'pw'); await page.click('#loginBtn');
  await page.waitForSelector('#login', { state: 'hidden' }); await page.waitForTimeout(150);
  return { page, ctx, errors, api,
    seed: data => page.evaluate(async data => { const m = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'); for (const [c, docs] of Object.entries(data)) for (const [id, d] of Object.entries(docs)) m.__seed(c, id, d); }, data),
    ruleErrors: () => page.evaluate(() => window.__ruleErrors || []),
    text: sel => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim()),
    go: hash => page.evaluate(h => { location.hash = h; }, hash),
    close: () => ctx.close() };
}

// Dates relative to today, so the tests keep working: d(60) is 60 days from now as YYYY-MM-DD.
export const d = (days, from = new Date()) => { const x = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days)); return x.toISOString().slice(0, 10); };
export const month = (offset = 0) => { const n = new Date(); const x = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1)); return x.toISOString().slice(0, 7); };
