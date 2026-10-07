// Booking emails land here, sent either by the Gmail script in tools/gmail-bookings.gs (emails you label or
// forward to your +trips address) or by an inbound email service such as Postmark. The email's text and its PDF or
// image attachments are kept (attachments in Drive, "S&A Ledger bookings"), and an item appears in the app's
// "Bookings to review"; the app then reads the PDFs, finds the ticket codes and asks the AI for the details.
//
// Postmark → Servers → your server → Settings → Inbound webhook URL:
//   https://<your-site>/api/inbound?token=<INBOUND_TOKEN>
// Environment: INBOUND_TOKEN (any long random string), BOOKING_SENDERS (comma-separated addresses allowed to
// forward; defaults to Anubhav's), FIREBASE_SERVICE_ACCOUNT and the GDRIVE_* variables (already set).

import { firestore, json, MEMBERS } from '../lib/members.mjs';
import { driveClient, BOOKINGS_FOLDER as FOLDER } from '../lib/drive.mjs';


const MAX_TEXT = 30000;
const KEEP = /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/i;

export function htmlToText(h) {
  return String(h || '')
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n').replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const allowed = env => (env.BOOKING_SENDERS || MEMBERS[0]).split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);

export async function handle(req, { env = process.env, save, fetch: f = fetch, now = () => new Date() } = {}) {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const url = new URL(req.url);
  const want = String(env.INBOUND_TOKEN || '').trim(), got = String(url.searchParams.get('token') || '').trim();
  if (!want) return json(503, { error: 'INBOUND_TOKEN is not set for functions in Netlify (or the site was not redeployed after adding it).' });
  if (got !== want) return json(403, { error: `Wrong token: the script sent ${got.length} characters starting "${got.slice(0, 3)}", Netlify has ${want.length} starting "${want.slice(0, 3)}".` });
  let m; try { m = await req.json(); } catch { return json(400, { error: 'Bad request' }); }

  // A forward from one of you, or a Gmail auto-forward filter (which keeps the airline as sender but adds X-Forwarded-For).
  const from = String(m.FromFull?.Email || m.From || '').toLowerCase().replace(/^.*<|>.*$/g, '').trim();
  const fwd = (m.Headers || []).filter(h => /^x-forwarded-(for|to)$/i.test(h?.Name || '')).map(h => String(h.Value || '').toLowerCase()).join(' ');
  const ok = allowed(env);
  // The Gmail script only sends mail from your own mailbox that you labelled, so any original sender is fine.
  const by = m.Source === 'gmail-script' ? 'gmail' : ok.find(a => a === from) || ok.find(a => fwd.includes(a));
  if (!by) { console.warn('inbound: sender not allowed', from); return json(403, { error: 'Sender not allowed' }); }

  const atts = (m.Attachments || []).filter(a => a && a.Content);
  let text = String(m.TextBody || '').trim();
  if (text.length < 200 && m.HtmlBody) text = htmlToText(m.HtmlBody);
  // Calendar invites carry times and places in plain text: add them to the text.
  for (const a of atts.filter(a => /calendar|\.ics$/i.test(a.ContentType + ' ' + a.Name)))
    text += '\n\n[Calendar attachment ' + a.Name + ']\n' + Buffer.from(a.Content, 'base64').toString('utf8').slice(0, 5000);
  text = text.slice(0, MAX_TEXT);

  // PDFs always; images only when they aren't small inline logos.
  const keep = atts.filter(a => KEEP.test(a.ContentType || '') && (/pdf/i.test(a.ContentType) || (a.ContentLength || 0) > 15000 || !a.ContentID));
  const files = [], skipped = [];
  let fileError;
  if (keep.length) {
    try {
      const drive = await driveClient(env, f);
      const folder = await drive.folder(FOLDER);
      const up = await Promise.allSettled(keep.slice(0, 6).map(a => drive.upload({ name: String(a.Name || 'attachment').slice(0, 140), mime: a.ContentType.toLowerCase(), data: Buffer.from(a.Content, 'base64'), parent: folder })
        .then(r => ({ id: r.id, name: r.name, mime: a.ContentType.toLowerCase(), size: a.ContentLength || Buffer.from(a.Content, 'base64').length }))));
      up.forEach((r, i) => r.status === 'fulfilled' ? files.push(r.value) : skipped.push(keep[i].Name));
      if (up.some(r => r.status === 'rejected')) fileError = String(up.find(r => r.status === 'rejected').reason?.message || '').slice(0, 200);
    } catch (e) { fileError = String(e.message || e).slice(0, 200); keep.forEach(a => skipped.push(a.Name)); }
  }
  atts.filter(a => !keep.includes(a) && !/calendar|\.ics$/i.test(a.ContentType + ' ' + a.Name) && !a.ContentID).forEach(a => skipped.push(a.Name));

  if (!text.trim() && !files.length) return json(200, { ok: true, note: 'nothing to keep' });
  const id = String(m.MessageID || now().getTime()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || String(now().getTime());
  const item = {
    from: from.slice(0, 120), by, subject: String(m.Subject || '').slice(0, 300), date: String(m.Date || '').slice(0, 60),
    text, files, receivedAt: now().toISOString(),
  };
  if (skipped.length) item.skipped = skipped.map(s => String(s).slice(0, 140)).slice(0, 10);
  if (fileError) item.fileError = fileError;
  await save(id, item);
  return json(200, { ok: true, id, files: files.length });
}

export default async (req) => {
  try { return await handle(req, { save: (id, item) => firestore().collection('bookingInbox').doc(id).set(item) }); }
  catch (e) { console.error('inbound failed', e); return json(500, { error: 'failed' }); }
};

export const config = { path: '/api/inbound' };
