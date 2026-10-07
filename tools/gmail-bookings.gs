// S&A Ledger: send booking emails from Gmail to the app.
//
// Runs in your own Google account (script.google.com), every 10 minutes. It picks up emails that have the label
// "Ledger bookings", sends each one (text + PDF and image attachments) to the app, and then swaps the label for
// "Ledger bookings/sent". To send an email to the app, either:
//   - forward it (or have Sulekha forward it) to anubhav.iiitb+trips@gmail.com, or
//   - put the "Ledger bookings" label on it yourself.
// The script finds +trips emails itself (Gmail filters skip mail you send to yourself), so no filter is needed.
//
// Setup: paste this file into a new Apps Script project, fill in the two values in Project Settings →
// Script properties (LEDGER_URL, INBOUND_TOKEN), run setup() once and allow the permissions it asks for.

const LABEL = 'Ledger bookings';
const DONE = 'Ledger bookings/sent';
const ADDRESS = 'anubhav.iiitb+trips@gmail.com';
const MAX_ATTACHMENT = 4 * 1024 * 1024;   // larger files can't pass through the Netlify function

function setup() {
  GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  GmailApp.getUserLabelByName(DONE) || GmailApp.createLabel(DONE);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendBookings').timeBased().everyMinutes(10).create();
  sendBookings();
}

function sendBookings() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('LEDGER_URL'), token = props.getProperty('INBOUND_TOKEN');
  if (!url || !token) throw new Error('Set LEDGER_URL and INBOUND_TOKEN in Project Settings → Script properties');
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  const done = GmailApp.getUserLabelByName(DONE) || GmailApp.createLabel(DONE);
  // in:anywhere includes Sent, where emails you forward to yourself end up.
  const threads = GmailApp.search(`in:anywhere (label:"${LABEL}" OR to:${ADDRESS} OR deliveredto:${ADDRESS}) -label:"${DONE}" newer_than:30d`, 0, 10);
  for (const thread of threads) {
    let ok = true;
    const all = thread.getMessages();
    // Only the forwarded copy, not the original it was forwarded from; with a hand-put label, the newest email.
    let msgs = all.filter(m => (m.getTo() + ',' + m.getCc()).toLowerCase().includes(ADDRESS));
    if (!msgs.length) msgs = [all[all.length - 1]];
    for (const msg of msgs) {
      // Real attachments (PDFs, calendar invites, photos); pictures inside the email only when they look like a code.
      const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true })
        .filter(a => /^(application\/pdf|text\/calendar|image\/)/i.test(a.getContentType()) && a.getSize() <= MAX_ATTACHMENT)
        .slice(0, 6)
        .map(a => ({ Name: a.getName(), ContentType: a.getContentType(), ContentLength: a.getSize(), Content: Utilities.base64Encode(a.getBytes()) }));
      atts.push(...codeImages(msg));
      // Netlify takes about 6 MB per call: keep PDFs first, then images, within that.
      let room = 5.5 * 1024 * 1024;
      const fit = atts.sort((a, b) => (/pdf/i.test(b.ContentType) ? 1 : 0) - (/pdf/i.test(a.ContentType) ? 1 : 0))
        .filter(a => (room -= a.Content.length) >= 0);
      const body = {
        Source: 'gmail-script', MessageID: msg.getId(), From: msg.getFrom(), Subject: msg.getSubject(),
        Date: msg.getDate().toISOString(), TextBody: msg.getPlainBody(), HtmlBody: msg.getBody().slice(0, 200000), Attachments: fit,
      };
      const r = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/api/inbound?token=' + encodeURIComponent(token), {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
      });
      console.log(msg.getSubject() + ': sending ' + (fit.map(a => a.Name + ' (' + Math.round(a.ContentLength / 1024) + ' KB)').join(', ') || 'no attachments or images'));
      if (r.getResponseCode() !== 200) { ok = false; console.error('Ledger refused ' + msg.getSubject() + ': ' + r.getResponseCode() + ' ' + r.getContentText()); }
    }
    if (ok) { thread.removeLabel(label); thread.addLabel(done); console.log('Sent to the ledger: ' + thread.getFirstMessageSubject()); }
  }
}

// Many boarding-pass emails show the QR code as a picture loaded from the airline's server rather than as an
// attachment. Fetch the pictures that look like a code (by their name or alt text, or square and big enough).
function codeImages(msg) {
  const out = [], seen = {};
  const tags = String(msg.getBody() || '').match(/<img\b[^>]*>/gi) || [];
  let raw = null;
  for (const tag of tags) {
    if (out.length >= 6) break;
    const attr = n => ((tag.match(new RegExp('\\b' + n + '\\s*=\\s*["\']([^"\']*)["\']', 'i')) || [])[1] || '').replace(/&amp;/g, '&');
    const src = attr('src'); if (!src || seen[src]) continue; seen[src] = 1;
    const w = +attr('width'), h = +attr('height');
    console.log('Image in email: ' + src.slice(0, 120) + (attr('alt') ? ' alt="' + attr('alt').slice(0, 40) + '"' : '') + (w ? ' ' + w + 'x' + h : ''));
    const hint = [src, attr('alt'), attr('title'), attr('class'), attr('id')].join(' ');
    if (/logo|icon|social|facebook|twitter|instagram|linkedin|spacer|pixel|track|banner|app.?store|google.?play/i.test(hint)) continue;
    const looksLikeCode = /qr|bar.?code|aztec|pdf417|boarding|mobile.?pass|e.?ticket|ticket|pass/i.test(hint) || (w >= 100 && h >= 100 && Math.abs(w - h) <= w * 0.25);
    if (!looksLikeCode) continue;
    try {
      let bytes, type;
      if (/^cid:/i.test(src)) {
        // A picture carried inside the email (Gmail shows it as an attachment called "inline"): find it by its Content-ID.
        raw = raw || msg.getRawContent();
        const part = mimePart(raw, src.slice(4));
        if (!part) continue;
        type = part.type; bytes = Utilities.base64Decode(part.data);
      } else if (/^data:image\//i.test(src)) { type = src.slice(5, src.indexOf(';')); bytes = Utilities.base64Decode(src.slice(src.indexOf(',') + 1)); }
      else if (/^https?:\/\//i.test(src)) {
        const r = UrlFetchApp.fetch(src, { muteHttpExceptions: true, followRedirects: true });
        if (r.getResponseCode() !== 200) continue;
        const blob = r.getBlob(); type = blob.getContentType() || ''; bytes = blob.getBytes();
      } else continue;
      if (!/^image\/(png|jpe?g|gif|webp)/i.test(type) || bytes.length < 300 || bytes.length > 300 * 1024) continue;
      out.push({ Name: 'code-' + (out.length + 1) + '.' + type.split('/')[1].replace('jpeg', 'jpg'), ContentType: type, ContentLength: bytes.length, Content: Utilities.base64Encode(bytes) });
    } catch (e) { console.warn('Couldn\'t fetch an image: ' + e.message); }
  }
  return out;
}

// The part of a raw email whose Content-ID is cid, as { type, data (base64) }.
function mimePart(raw, cid) {
  const at = raw.search(new RegExp('Content-ID:\\s*<?' + cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>?', 'i'));
  if (at < 0) return null;
  const start = raw.lastIndexOf('\n--', at), end = raw.indexOf('\n--', at);
  const part = raw.slice(start < 0 ? 0 : start, end < 0 ? raw.length : end);
  const split = part.search(/\r?\n\r?\n/);
  if (split < 0 || !/Content-Transfer-Encoding:\s*base64/i.test(part.slice(0, split))) return null;
  const type = ((part.slice(0, split).match(/Content-Type:\s*([^;\s]+)/i) || [])[1] || '').toLowerCase();
  return { type, data: part.slice(split).replace(/\s+/g, '') };
}
