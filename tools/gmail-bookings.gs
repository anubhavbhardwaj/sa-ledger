// S&A Ledger: send booking emails from Gmail to the app.
//
// Runs in your own Google account (script.google.com), every 10 minutes. It picks up emails that have the label
// "Ledger bookings", sends each one (text + PDF and image attachments) to the app, and then swaps the label for
// "Ledger bookings/sent". To send an email to the app, either:
//   - forward it (or have Sulekha forward it) to anubhav.iiitb+trips@gmail.com, which a Gmail filter labels, or
//   - put the "Ledger bookings" label on it yourself.
//
// Setup: paste this file into a new Apps Script project, fill in the two values in Project Settings →
// Script properties (LEDGER_URL, INBOUND_TOKEN), run setup() once and allow the permissions it asks for.

const LABEL = 'Ledger bookings';
const DONE = 'Ledger bookings/sent';
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
  const label = GmailApp.getUserLabelByName(LABEL), done = GmailApp.getUserLabelByName(DONE);
  if (!label) return;
  for (const thread of label.getThreads(0, 10)) {
    let ok = true;
    for (const msg of thread.getMessages()) {
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
    if (ok) { thread.removeLabel(label); thread.addLabel(done); }
  }
}
