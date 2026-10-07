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
      const atts = msg.getAttachments({ includeInlineImages: true, includeAttachments: true })
        .filter(a => /^(application\/pdf|text\/calendar)/i.test(a.getContentType()) || (/^image\//i.test(a.getContentType()) && a.getSize() > 15000))   // skip small logos
        .filter(a => a.getSize() <= MAX_ATTACHMENT)
        .slice(0, 6)
        .map(a => ({ Name: a.getName(), ContentType: a.getContentType(), ContentLength: a.getSize(), Content: Utilities.base64Encode(a.getBytes()) }));
      const body = {
        Source: 'gmail-script', MessageID: msg.getId(), From: msg.getFrom(), Subject: msg.getSubject(),
        Date: msg.getDate().toISOString(), TextBody: msg.getPlainBody(), HtmlBody: msg.getBody(), Attachments: atts,
      };
      const r = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/api/inbound?token=' + encodeURIComponent(token), {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true,
      });
      if (r.getResponseCode() !== 200) { ok = false; console.error('Ledger refused ' + msg.getSubject() + ': ' + r.getResponseCode() + ' ' + r.getContentText()); }
    }
    if (ok) { thread.removeLabel(label); thread.addLabel(done); console.log('Sent to the ledger: ' + thread.getFirstMessageSubject()); }
  }
}
