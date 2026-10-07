// Google Drive helpers shared by the backup and booking functions. Uses the OAuth refresh token in
// GDRIVE_REFRESH_TOKEN (scope drive.file: these functions only ever see files they created themselves).

export const BOOKINGS_FOLDER = 'S&A Ledger bookings';
export const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export async function driveClient(env = process.env, f = fetch) {
  for (const k of ['GDRIVE_CLIENT_ID', 'GDRIVE_CLIENT_SECRET', 'GDRIVE_REFRESH_TOKEN'])
    if (!env[k]) throw new Error(k + ' is not set');
  const tr = await f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, refresh_token: env.GDRIVE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const tj = await tr.json();
  if (!tr.ok || !tj.access_token) throw new Error('Google sign-in failed: ' + (tj.error_description || tj.error || tr.status));
  const auth = { authorization: 'Bearer ' + tj.access_token };

  const raw = async (url, opt = {}) => {
    const r = await f(url, { ...opt, headers: { ...auth, ...(opt.headers || {}) } });
    if (!r.ok) throw Object.assign(new Error('Drive ' + (opt.method || 'GET') + ' failed: ' + r.status + ' ' + (await r.text()).slice(0, 200)), { status: r.status });
    return r;
  };
  const api = async (url, opt = {}) => { const r = await raw(url, opt); return r.status === 204 ? null : r.json(); };

  const folders = {};
  async function folder(name) {
    if (folders[name]) return folders[name];
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    let id = (await api(`${DRIVE}?q=${q}&fields=files(id)`)).files?.[0]?.id;
    if (!id) id = (await api(`${DRIVE}?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }) })).id;
    return (folders[name] = id);
  }

  // data: string or bytes (Uint8Array/Buffer).
  async function upload({ name, mime = 'application/octet-stream', data, parent }) {
    const boundary = 'sa' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: parent ? [parent] : undefined, mimeType: mime })}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--`);
    const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    return api(`${UPLOAD}?uploadType=multipart&fields=id,name,mimeType,size`, {
      method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
  }

  const list = (q, extra = '') => api(`${DRIVE}?q=${encodeURIComponent(q)}${extra}`);
  const meta = id => api(`${DRIVE}/${encodeURIComponent(id)}?fields=id,name,mimeType,size,parents`);
  const download = id => raw(`${DRIVE}/${encodeURIComponent(id)}?alt=media`);
  const remove = id => api(`${DRIVE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { api, folder, upload, list, meta, download, remove };
}
