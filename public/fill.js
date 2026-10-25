// Filling a booking form (airline, hotel, train) on any website with details from People & details.
// In the app: choose who travels and copy (a small JSON with a marker). On the booking page: click the
// "Fill from S&A" bookmark. It reads the clipboard (or asks you to paste), recognises the fields by their labels,
// names and placeholders (English, German, Italian) and fills the empty ones, marking them in yellow.
// fillForm and showFillResult run inside the bookmark on another website, so they must not use anything outside
// themselves (no imports, no module variables) and no // comments.

export const MARK = 'saLedger';
// Raised whenever the filler changes: the bookmark has its own copy of the code, so it has to be dragged again.
export const FILLER_VERSION = 2;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GENDER = { male: 'Male', female: 'Female', x: 'Diverse / X' };

// What the app copies for the bookmark: only the details a form needs, in passenger order.
export function formPayload(people){
  return { [MARK]: 1, v: 1, people: people.map(p => Object.fromEntries(['first', 'last', 'gender', 'passport', 'passportExp', 'email', 'phone'].filter(k => p[k]).map(k => [k, p[k]]))) };
}

// The same details as plain text, to paste into a message or an email.
export function peopleText(people){
  return people.map(p => {
    const [y, m, d] = String(p.passportExp || '').split('-');
    return [[p.first, p.last].filter(Boolean).join(' '),
      p.first && 'First name(s): ' + p.first, p.last && 'Last name: ' + p.last, p.gender && 'Gender: ' + GENDER[p.gender],
      p.passport && 'Passport number: ' + p.passport, d && `Passport expiry: ${+d} ${MON[+m - 1]} ${y} (${d}.${m}.${y})`,
      p.email && 'Email: ' + p.email, p.phone && 'Phone: ' + p.phone].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function fillForm(doc, data){
  const people = (data && data.people) || [], win = doc.defaultView || window;
  const out = { filled: 0, per: people.map(() => 0), skipped: 0, notes: [], fields: [] };
  if (!people.length) return out;
  const low = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const pad = n => String(n).padStart(2, '0');
  const has = (re, s) => re.test(s);

  /* What a field is about: its name, id, placeholder, labels, and short nearby text. */
  const desc = el => {
    const p = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.getAttribute('data-testid'), el.title];
    if (el.labels) for (const l of el.labels) p.push(l.textContent);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach(id => { const x = doc.getElementById(id); if (x) p.push(x.textContent); });
    if (el.type === 'radio' || (!(el.labels && el.labels.length) && !el.getAttribute('aria-label'))){
      let q = el.parentElement;
      for (let i = 0; i < 3 && q; i++, q = q.parentElement){
        const c = q.cloneNode(true); c.querySelectorAll('option,select,script,style').forEach(x => x.remove());
        const t = low(c.textContent); if (t && t.length < 60){ p.push(t); break; }
      }
    }
    return low(p.filter(Boolean).join(' | '));
  };
  const CARD = /card|karte|carta|cvv|cvc|iban|holder|inhaber|titolare|cc-|mm ?\/ ?yy(?!yy)|coupon|voucher|promo|frequent|loyalty|search|suche|cerca|password|passwort/;
  const DATEFMT = /(dd|tt|gg)[.\/\- ]?mm[.\/\- ]?(yyyy|jjjj|aaaa)|mm[.\/\- ]?(dd)[.\/\- ]?yyyy|(yyyy|jjjj|aaaa)[.\/\- ]?mm[.\/\- ]?(dd|tt|gg)/;
  const kindOf = (el, d) => {
    const tag = el.tagName, t = low(el.type), ac = low(el.getAttribute('autocomplete'));
    if (['hidden', 'password', 'submit', 'button', 'checkbox', 'file', 'search', 'image', 'reset', 'color', 'range'].includes(t) || el.disabled || el.readOnly) return null;
    if (has(CARD, d)) return null;
    if (has(/expir|valid.?(until|thru|till|to)|gültig|gultig|ablauf|scadenza|verfall|caducidad|vencimiento|validez/, d)){
      if (t === 'date' || has(DATEFMT, d)) return 'exp';
      if (has(/(^|\W)(day|tag|giorno|dd|tt|gg)(\W|$)/, d)) return 'expDay';
      if (has(/(^|\W)(month|monat|mese|mm)(\W|$)/, d)) return 'expMonth';
      if (has(/(^|\W)(year|jahr|anno|yyyy|yy|jjjj|aaaa)(\W|$)/, d)) return 'expYear';
      return tag === 'SELECT' ? null : 'exp';
    }
    if (has(/passport|reisepass|passnummer|passaporto|pasaporte|passeport|document.?(number|no\b|num)|n(ú|u)mero.?de.?documento|dokumentennummer|ausweisnummer|numero.?(del.?)?documento|travel.?document|doc.?(number|no\b|num)/, d)
      && !has(/country|issu|ausstell|nation|paese|rilascio|type|date|datum|place|luogo|(^|\W)(land|ort|typ|tipo|data)(\W|$)/, d)) return tag === 'SELECT' ? null : 'passport';
    if (t === 'email' || ac.includes('email') || has(/e-?mail|courriel|correo/, d)) return has(/confirm|repeat|wiederhol|bestätig|bestatig|conferma|ripeti|re-?enter|retype|again/, d) ? 'email2' : 'email';
    if (ac === 'tel-country-code' || has(/country.?code|dial.?(ling)?.?code|calling.?code|(phone|tel|mobile).?(code|prefix)|vorwahl|prefisso|indicativo/, d)) return 'phoneCode';
    if (t === 'tel' || ac.startsWith('tel') || has(/phone|telefon|tel(é|e)fono|cellulare|rufnummer|(^|\W)(tel|mobile|mobil|cell|handy)(\W|$)/, d)) return tag === 'SELECT' ? null : 'phone';
    if ((tag === 'SELECT' || t === 'radio') && has(/title|anrede|salutation|titolo|gender|(^|\W)sex(\W|$)|geschlecht|sesso|(^|\W)(mr|herr|sig)(\W|$)/, d)) return 'title';
    if (tag === 'SELECT' && [...el.options].filter(o => /^(mr|mrs|ms|miss|herr|frau|male|female|signor|signora)$/.test(low(o.textContent).replace(/[.:]/g, ''))).length >= 2) return 'title';
    if (tag === 'SELECT' || t === 'radio') return null;
    if (ac === 'name' || has(/full.?name|fullname|passenger.?name|nome.?e.?cognome|nome.?completo|vor.?und.?nach.?name|complete.?name/, d)) return 'full';
    if (ac === 'given-name' || has(/first.?name|given.?name|forename|vorname|(^|\W)(nome|nombre)(\W|$)|fname|prénom|prenom/, d)) return 'first';
    if (ac === 'family-name' || has(/last.?name|surname|family.?name|nachname|cognome|apellido|lname|nom de famille/, d)) return 'last';
    if (has(/middle/, d)) return null;
    /* Just "Name": decided below from the other fields on the form. */
    const bare = x => low(x).replace(/[*:()]/g, '').trim();
    if ([el.name, el.id, el.placeholder, el.getAttribute('aria-label'), ...(el.labels ? [...el.labels].map(l => l.textContent) : [])].some(x => ['name', 'nom'].includes(bare(x)))) return 'name?';
    return null;
  };

  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    el.dispatchEvent(new win.FocusEvent('blur'));
  };
  const optText = o => low(o.textContent).replace(/[.:]/g, '');
  const pickOption = (sel, tests) => {
    for (const test of tests){
      const o = [...sel.options].find(o => o.value !== '' && (test(optText(o)) || test(low(o.value))));
      if (o){ setVal(sel, o.value); return true; }
    }
    return false;
  };
  const MONTHS = [['jan', 'gen'], ['feb'], ['mar', 'mär', 'mae'], ['apr'], ['may', 'mai', 'mag'], ['jun', 'giu'], ['jul', 'lug'], ['aug', 'ago'], ['sep', 'set'], ['oct', 'okt', 'ott'], ['nov'], ['dec', 'dez', 'dic']];
  const titleTests = g => g === 'male' ? [s => /^(mr|mister|herr|male|man|m|signor|sig|maschio|männlich|maennlich|monsieur|sr)$/.test(s)]
    : g === 'female' ? [s => /^(ms|frau|female|woman|f|w|signora|sigra|donna|femmina|weiblich|madame|mme)$/.test(s), s => /^(mrs|miss)$/.test(s)]
    : g === 'x' ? [s => /^(divers|diverse|x|other|andere|altro|mx)$/.test(s)] : [];
  const code = ph => { const s = String(ph || '').trim(); if (!s.startsWith('+') && !s.startsWith('00')) return '';
    const d = s.replace(/^00/, '+'); const m = d.match(/^\+(\d{1,3})[\s\-\/(]/); if (m) return m[1];
    const digits = d.replace(/\D/g, ''); return ['1', '7'].includes(digits[0]) ? digits[0] : ['971', '972', '353', '351', '358', '420'].find(c => digits.startsWith(c)) || digits.slice(0, 2); };

  const fields = [...doc.querySelectorAll('input, select, textarea')];
  /* Headings in page order: a field belongs to the last heading before it ("General 2", "Passenger 2", "Contact details"). */
  const heads = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [role=heading]')];
  const headOf = el => { let h = null; for (const x of heads){ if (x.compareDocumentPosition(el) & 4) h = x; else break; } return h; };
  const SKIP = /emergency|notfall|emergenza|payment|zahlung|pagamento|kreditkarte|credit card|billing card/;
  const CONTACT_RE = /contact|kontakt|contatto|contacto|booker|ansprechpartner|buchende|lead.?passenger/;
  const items = [], doneRadio = new Set();
  for (const el of fields){
    if (el.type !== 'radio' && !el.getClientRects().length) continue;
    const d = desc(el), k = kindOf(el, d); if (!k) continue;
    if (el.type === 'radio'){ if (doneRadio.has(el.name)) continue; doneRadio.add(el.name); }
    const hEl = headOf(el), h = hEl ? low(hEl.textContent) : '';
    if (has(SKIP, h + ' ' + d)) continue;
    items.push({ el, d, k, hEl, h });
  }
  /* A lone "Name" is the first name when the form also asks for a surname, the surname when it asks for a first name
     ("Vorname" and "Name"), and otherwise the full name. */
  const kinds = new Set(items.map(x => x.k));
  items.forEach(x => { if (x.k === 'name?') x.k = kinds.has('last') ? 'first' : kinds.has('first') ? 'last' : 'full'; });
  /* A single email or phone field on a form for several people is the contact: the first person. */
  const count = {}; items.forEach(x => { count[x.k] = (count[x.k] || 0) + 1; });
  const hasCodeField = !!count.phoneCode;
  const NAMES = ['title', 'full', 'first', 'last'], CONTACTS = ['email', 'email2', 'phone', 'phoneCode'];
  const blockKinds = new Map(); items.forEach(x => { const b = blockKinds.get(x.hEl) || new Set(); b.add(x.k); blockKinds.set(x.hEl, b); });
  /* Who each field is for: the next person starts when a new block asks for names already given, or when a detail
     is asked again. Contact fields go to the first person and don't move on to the next. */
  let idx = 0, seen = new Set(), block;

  for (const x of items){
    const { el, d, k } = x;
    if (x.hEl !== block){
      block = x.hEl;
      if ([...blockKinds.get(block)].some(b => NAMES.includes(b) && seen.has(b))){ idx++; seen = new Set(); }
    }
    let who;
    if (has(CONTACT_RE, d) || (CONTACTS.includes(k) && (has(CONTACT_RE, x.h) || (count[k] || 0) <= 1))) who = 0;
    else {
      if (k !== 'email2'){ if (seen.has(k)){ idx++; seen = new Set(); } seen.add(k); }
      who = idx;
    }
    if (who >= people.length){ if (CONTACTS.includes(k)) who = 0; else continue; }
    const p = people[who] || {};

    if (el.type === 'radio'){
      const group = fields.filter(r => r.type === 'radio' && r.name === el.name);
      if (group.some(r => r.checked)){ out.skipped++; continue; }
      const lab = r => low((r.labels && r.labels[0] && r.labels[0].textContent) || r.value).replace(/[.:]/g, '');
      let hit = null; for (const test of titleTests(p.gender)){ hit = group.find(r => test(lab(r)) || test(low(r.value))); if (hit) break; }
      if (hit){ hit.click(); hit.style.outline = '2px solid #E6AE4A'; out.filled++; out.per[who]++; out.fields.push({ kind: k, who, value: hit.value }); }
      continue;
    }
    const empty = el.tagName === 'SELECT' ? (el.selectedIndex <= 0 || !el.value) : !String(el.value || '').trim();
    if (!empty){ out.skipped++; continue; }

    const [y, m, dd] = String(p.passportExp || '').split('-');
    let ok = false, val = null;
    if (k === 'title'){ ok = !!p.gender && el.tagName === 'SELECT' && pickOption(el, titleTests(p.gender)); }
    else if (k === 'phoneCode'){
      const c = code(p.phone);
      if (c) ok = el.tagName === 'SELECT' ? pickOption(el, [s => new RegExp('\\+' + c + '(\\D|$)').test(s), s => s === c || s === '+' + c || s === '00' + c]) : (setVal(el, '+' + c), true);
    }
    else if (k === 'expDay' || k === 'expMonth' || k === 'expYear'){
      if (y){
        const part = k === 'expDay' ? +dd : k === 'expMonth' ? +m : +y;
        if (el.tagName === 'SELECT') ok = pickOption(el, [s => s === String(part) || s === pad(part), s => k === 'expMonth' && MONTHS[part - 1].some(n => s.startsWith(n)), s => k === 'expYear' && s === String(part).slice(2)]);
        else { val = k === 'expYear' ? (el.maxLength === 2 ? y.slice(2) : y) : pad(part); }
      }
    }
    else if (k === 'exp'){
      if (y){
        if (el.type === 'date') val = `${y}-${m}-${dd}`;
        else if (el.type === 'month') val = `${y}-${m}`;
        else {
          const f = d.match(DATEFMT), s = f ? f[0] : '', sep = (s.match(/[.\/\- ]/) || [''])[0];
          if (/^(yyyy|jjjj|aaaa)/.test(s)) val = [y, m, dd].join(sep);
          else if (/^mm/.test(s)) val = [m, dd, y].join(sep);
          else if (s) val = [dd, m, y].join(sep);
          else { val = `${dd}/${m}/${y}`; out.notes.push(`Passport expiry for ${p.first || 'person ' + (who + 1)} typed as ${val} (day first): check the site’s date format.`); }
        }
      }
    }
    else if (k === 'phone'){
      if (p.phone){ const c = code(p.phone), digits = p.phone.replace(/\D/g, '').replace(/^00/, ''); val = hasCodeField && c && digits.startsWith(c) ? digits.slice(c.length).replace(/^0/, '') : (c ? '+' + digits : p.phone.replace(/\s/g, '')); }
    }
    else val = { full: [p.first, p.last].filter(Boolean).join(' '), first: p.first, last: p.last, passport: p.passport, email: p.email, email2: p.email }[k] || null;

    if (val){ setVal(el, val); ok = true; }
    if (ok){ el.style.outline = '2px solid #E6AE4A'; el.style.outlineOffset = '1px'; out.filled++; out.per[who]++; out.fields.push({ kind: k, who, value: el.value }); }
  }
  return out;
}

export function showFillResult(doc, r, people, version){
  const old = doc.getElementById('sa-fill-result'); if (old) old.remove();
  const box = doc.createElement('div'); box.id = 'sa-fill-result';
  box.setAttribute('style', 'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:340px;background:#fff;color:#14201b;border:2px solid #E6AE4A;border-radius:12px;padding:12px 14px;font:14px/1.4 system-ui,sans-serif;text-align:left;box-shadow:0 6px 24px rgba(0,0,0,.2)');
  const add = (text, bold) => { const e = doc.createElement('div'); e.textContent = text; e.style.margin = '2px 0'; if (bold) e.style.fontWeight = '700'; box.appendChild(e); };
  const who = people.map((p, i) => r.per[i] ? `${p.first || 'Person ' + (i + 1)} (${r.per[i]})` : '').filter(Boolean).join(', ');
  if (r.filled){ add(`S&A Ledger filled ${r.filled} field${r.filled === 1 ? '' : 's'}`, true); add(who); add('Filled fields are outlined in yellow. Check every value before you submit.'); }
  else { add('S&A Ledger found nothing to fill here', true); add('If the form is in a pop-up or a frame, open it in its own tab, or copy the details one by one in the app.'); }
  if (r.skipped) add(r.skipped === 1 ? '1 field that already had something was left alone.' : `${r.skipped} fields that already had something were left alone.`);
  r.notes.forEach(n => add('⚠ ' + n));
  const v = doc.createElement('div'); v.textContent = 'Form filler v' + (version || 1); v.setAttribute('style', 'margin-top:6px;font-size:11.5px;color:#6b776f'); box.appendChild(v);
  const x = doc.createElement('button'); x.type = 'button'; x.textContent = 'Close';
  x.setAttribute('style', 'margin-top:8px;padding:4px 12px;border:1px solid #ccc;border-radius:8px;background:#f4f4f4;color:#14201b;cursor:pointer;font:inherit');
  x.onclick = () => box.remove(); box.appendChild(x);
  doc.body.appendChild(box);
}

// The bookmark: reads the clipboard (or asks you to paste), fills the form and shows what it did.
export function bookmarkletSource(){
  return `(async()=>{const F=${fillForm.toString()};const S=${showFillResult.toString()};
let t='';try{t=await navigator.clipboard.readText()}catch(e){}
if(!t||t.indexOf('"${MARK}"')<0)t=prompt('Paste the details you copied in S&A Ledger (People & details, Fill a form), then OK.')||'';
let d=null;try{d=JSON.parse(t)}catch(e){}
if(!d||!d.${MARK}){if(t)alert('That is not S&A Ledger form data. Copy it again in the app.');return}
const r=F(document,d);S(document,r,d.people||[],${FILLER_VERSION});})()`;
}
export const bookmarklet = () => 'javascript:' + encodeURIComponent(bookmarkletSource());
