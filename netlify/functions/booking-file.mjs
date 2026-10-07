// Keeps the original booking files (PDFs, ticket images) in Google Drive, folder "S&A Ledger bookings".
//   POST   /api/booking-file          body = the file, header x-file-name   → { id, name, size }
//   GET    /api/booking-file?id=…     → the file
//   DELETE /api/booking-file?id=…
// Only the two members can call it (Firebase sign-in). Drive scope drive.file: it only sees files it made.

import { member, json, verifyToken } from '../lib/members.mjs';
import { driveClient, BOOKINGS_FOLDER } from '../lib/drive.mjs';

const FOLDER = BOOKINGS_FOLDER;
export const MAX_BYTES = 4 * 1024 * 1024;   // Netlify passes at most ~6 MB through a function, base64-encoded
const OK_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic)|text\/plain|text\/calendar|message\/rfc822)$/;

export async function handle(req, { env = process.env, verify = verifyToken, fetch: f = fetch } = {}) {
  const m = await member(req, verify); if (m.res) return m.res;
  const url = new URL(req.url);
  const drive = await driveClient(env, f).catch(e => { throw Object.assign(e, { setup: true }); });

  if (req.method === 'POST') {
    const mime = (req.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (!OK_TYPES.test(mime)) return json(415, { error: 'Only PDFs, images and text files can be kept.' });
    const data = new Uint8Array(await req.arrayBuffer());
    if (!data.length) return json(400, { error: 'Empty file' });
    if (data.length > MAX_BYTES) return json(413, { error: 'That file is over 4 MB, too big to keep in Drive from here.' });
    let name = 'booking';
    try { name = decodeURIComponent(req.headers.get('x-file-name') || 'booking'); } catch {}
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 140) || 'booking';
    const folder = await drive.folder(FOLDER);
    const file = await drive.upload({ name, mime, data, parent: folder });
    return json(200, { id: file.id, name: file.name, size: data.length, mime });
  }

  const id = url.searchParams.get('id') || '';
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return json(400, { error: 'Missing file id' });
  if (req.method === 'GET') {
    const meta = await drive.meta(id);
    const r = await drive.download(id);
    return new Response(r.body, { status: 200, headers: {
      'content-type': meta.mimeType || 'application/octet-stream',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name || 'booking')}`,
      'cache-control': 'private, max-age=86400',
    } });
  }
  if (req.method === 'DELETE') {
    try { await drive.remove(id); } catch (e) { if (e.status !== 404) throw e; }
    return json(200, { ok: true });
  }
  return json(405, { error: 'Method not allowed' });
}

export default async (req) => {
  try { return await handle(req); }
  catch (e) {
    console.error('booking-file failed', e);
    if (e.status === 404) return json(404, { error: 'That file is no longer in Drive.' });
    return json(500, { error: e.setup ? 'Drive isn’t reachable: ' + String(e.message).slice(0, 160) : 'Drive error: ' + String(e.message || e).slice(0, 160) });
  }
};

export const config = { path: '/api/booking-file' };
