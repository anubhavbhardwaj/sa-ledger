// Reads a payment notification (title + text) and pulls out amount, currency, merchant and direction.
// Shared by the app (browser) and the capture function (Netlify). No dependencies.

const SYMBOLS = { '€': 'EUR', '₹': 'INR', '$': 'USD', '£': 'GBP', 'Rs': 'INR', 'Rs.': 'INR', 'Fr.': 'CHF', 'CHF': 'CHF' };
const CODES = ['EUR', 'INR', 'USD', 'GBP', 'CHF', 'CZK', 'PLN', 'HUF', 'DKK', 'SEK', 'NOK', 'TRY', 'JPY', 'CAD', 'AUD', 'SGD', 'THB'];
const CUR = `(€|₹|\\$|£|Rs\\.?|Fr\\.|${CODES.join('|')})`;
const NUM = `(\\d{1,3}(?:[.,' \\u202f]\\d{3})*(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)`;
const AMOUNT_RES = [new RegExp(`${CUR}\\s?-?\\s?${NUM}`, 'i'), new RegExp(`-?${NUM}\\s?${CUR}`, 'i')];

// "1.234,56" / "1,234.56" / "12,50" / "1 234,56" -> number
export function toNumber(v) {
  let s = String(v).replace(/[\s ']/g, '').replace(/[^\d.,-]/g, '');
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc > -1) s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : NaN;
}

const IGNORE = /\b(declined|failed|rejected|abgelehnt|fehlgeschlagen|rifiutat|non riuscit|otp|one[- ]time|verification code|bestätigungscode|codice|security code|login|anmeldung|limit reached|balance is|kontostand|saldo)\b/i;
const INCOMING = /\b(received|credited|refund(?:ed)?|money in|incoming|erhalten|gutschrift|eingegangen|erstattet|rückerstattung|accredit|ricevut|rimbors)/i;
const MERCHANT_RES = [
  /\b(?:at|bei|presso|chez)\s+(.+?)(?=\s+(?:on|am|il|le|with|mit|con|using|via|for|für|per|from|von|•|\(|\d{1,2}[./]\d)|[.,;:!\n]|$)/i,
  /\b(?:to|an|a favore di)\s+(.+?)(?=\s+(?:on|am|il|with|mit|from|von|•|\()|[.,;:!\n]|$)/i,
  /\b(?:from|von|da)\s+(.+?)(?=\s+(?:on|am|il|to|an|•|\()|[.,;:!\n]|$)/i,
];

function clean(m) {
  return m.replace(/\s{2,}/g, ' ').replace(/^[\s"'“”‘’-]+|[\s"'“”‘’*-]+$/g, '').slice(0, 80);
}

export function parseNotification({ app = '', title = '', text = '' } = {}) {
  const t = String(title || '').trim(), x = String(text || '').trim();
  const all = `${t}\n${x}`.replace(/ /g, ' ');
  if (!all.trim() || IGNORE.test(all)) return null;

  let amount = NaN, currency = 'EUR', hit = '';
  for (const re of AMOUNT_RES) {
    const m = all.match(re);
    if (!m) continue;
    const [sym, num] = /\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    amount = toNumber(num);
    currency = SYMBOLS[sym] || SYMBOLS[sym?.replace(/\.$/, '')] || sym.toUpperCase();
    hit = m[0];
    break;
  }
  if (!(amount > 0)) return null;

  const direction = INCOMING.test(all) ? 'in' : 'out';
  let merchant = '';
  for (const re of MERCHANT_RES) {
    const m = all.replace(hit, ' ').match(re);
    if (m && m[1] && !/\d{3,}/.test(m[1]) && m[1].length > 1) { merchant = clean(m[1]); break; }
  }
  // Google Wallet style: title is the merchant, text carries the amount.
  if (!merchant && t && !AMOUNT_RES.some(re => re.test(t)) && t.toLowerCase() !== String(app).toLowerCase() && t.length <= 60
      && !/\b(payment|zahlung|pagamento|transaction|transaktion|card|karte|carta|purchase|spent|ausgabe)\b/i.test(t)) merchant = clean(t);

  return { amount, currency, merchant, direction };
}

// Best guess of the account from the app that sent the notification.
export function guessAccount(app = '') {
  const a = String(app).toLowerCase();
  if (/wise/.test(a)) return 'Wise - Common';
  if (/deutsche|\bdb\b/.test(a)) return 'Deutsche Bank';
  if (/amex|american express/.test(a)) return 'AMEX';
  if (/raiffeisen/.test(a)) return 'Raiffeisen Bank';
  return '';
}
