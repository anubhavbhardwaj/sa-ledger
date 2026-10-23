// Boarding pass barcodes (IATA Bar Coded Boarding Pass, Resolution 792): the QR / Aztec / PDF417 code on every
// boarding pass carries name, booking reference, route, flight, date and seat in fixed positions. Decoding it needs
// no AI and is exact. Times are not in the code; the flight status checker fills them in.

// Airports that come up often, so a code shows as "Munich (MUC)". Others stay as the 3-letter code.
export const AIRPORTS = {
  MUC: 'Munich', NUE: 'Nuremberg', FMM: 'Memmingen', STR: 'Stuttgart', FRA: 'Frankfurt', HHN: 'Frankfurt-Hahn', BER: 'Berlin',
  HAM: 'Hamburg', DUS: 'Düsseldorf', CGN: 'Cologne', FKB: 'Karlsruhe', FDH: 'Friedrichshafen', SZG: 'Salzburg', INN: 'Innsbruck',
  VIE: 'Vienna', ZRH: 'Zurich', BSL: 'Basel', GVA: 'Geneva',
  FCO: 'Rome Fiumicino', CIA: 'Rome Ciampino', MXP: 'Milan Malpensa', LIN: 'Milan Linate', BGY: 'Milan Bergamo', NAP: 'Naples',
  CTA: 'Catania', PMO: 'Palermo', BLQ: 'Bologna', VCE: 'Venice', TSF: 'Venice Treviso', FLR: 'Florence', PSA: 'Pisa', BRI: 'Bari',
  CAG: 'Cagliari', OLB: 'Olbia', TRN: 'Turin', GOA: 'Genoa', VRN: 'Verona',
  CDG: 'Paris CDG', ORY: 'Paris Orly', LHR: 'London Heathrow', LGW: 'London Gatwick', STN: 'London Stansted', LTN: 'London Luton',
  AMS: 'Amsterdam', BRU: 'Brussels', CPH: 'Copenhagen', ARN: 'Stockholm', OSL: 'Oslo', HEL: 'Helsinki', DUB: 'Dublin', EDI: 'Edinburgh',
  BCN: 'Barcelona', MAD: 'Madrid', PMI: 'Palma', AGP: 'Málaga', LIS: 'Lisbon', OPO: 'Porto', ATH: 'Athens', HER: 'Heraklion',
  PRG: 'Prague', BUD: 'Budapest', WAW: 'Warsaw', KRK: 'Kraków', SPU: 'Split', DBV: 'Dubrovnik', MLA: 'Malta', IST: 'Istanbul',
  SAW: 'Istanbul Sabiha', AYT: 'Antalya',
  DEL: 'Delhi', BOM: 'Mumbai', BLR: 'Bengaluru', JAI: 'Jaipur', HYD: 'Hyderabad', MAA: 'Chennai', CCU: 'Kolkata', GOI: 'Goa',
  DXB: 'Dubai', AUH: 'Abu Dhabi', DOH: 'Doha', JFK: 'New York JFK', EWR: 'Newark', SIN: 'Singapore', BKK: 'Bangkok',
};
export const placeOf = code => AIRPORTS[code] ? `${AIRPORTS[code]} (${code})` : code;

const CABIN = { F: 'First', A: 'First', J: 'Business', C: 'Business', D: 'Business', I: 'Business', Z: 'Business', W: 'Premium economy', P: 'Premium economy' };

// Day of year (1..366) + year → YYYY-MM-DD
function fromJulian(year, doy){
  const d = new Date(Date.UTC(year, 0, 1)); d.setUTCDate(doy);
  return d.toISOString().slice(0, 10);
}
const doyOf = iso => { const d = new Date(iso + 'T12:00:00Z'); return Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1; };

// "BHARDWAJ/ANUBHAV MR" → "Anubhav Bhardwaj"
function nameOf(raw){
  const [last, first = ''] = raw.trim().split('/');
  const cap = s => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, m => m.toUpperCase());
  const given = first.replace(/\s+(MR|MRS|MS|MISS|MSTR|DR|PROF|CHD|INF)$/i, '').trim();
  return [cap(given), cap(last.trim())].filter(Boolean).join(' ');
}

// The year a flight on day `doy` most likely falls in. `issued` (from the code, if present) wins; otherwise the
// date closest to `ref` (the document's date or today), allowing for passes saved a while before the flight.
function yearFor(doy, ref, issued){
  if (issued){
    const y = issued.year;
    return doy >= issued.doy - 1 ? y : y + 1;          // a flight early next year on a pass issued in December
  }
  const ry = +ref.slice(0, 4);
  const best = [ry - 1, ry, ry + 1].map(y => ({ y, d: fromJulian(y, doy) }))
    .map(x => ({ ...x, gap: (Date.parse(x.d) - Date.parse(ref)) / 864e5 }))
    .filter(x => x.gap > -300 && x.gap < 330)
    .sort((a, b) => Math.abs(a.gap - 20) - Math.abs(b.gap - 20))[0];
  return best ? best.y : ry;
}

// Decode one barcode text. Returns null if it isn't a boarding pass; otherwise { legs: [...] } with one entry per
// flight leg in the code (usually one).
export function decodeBCBP(text, ref = new Date().toISOString().slice(0, 10)){
  const t = String(text || '').replace(/\r?\n/g, '');
  if (!/^M[1-4]/.test(t) || t.length < 60) return null;
  const nLegs = +t[1], name = nameOf(t.slice(2, 22)), eticket = t[22] === 'E';
  let p = 23; const legs = []; let issued = null;
  for (let i = 0; i < nLegs; i++){
    if (t.length < p + 37) break;
    const f = t.slice(p, p + 37);
    const leg = {
      pnr: f.slice(0, 7).trim(), from: f.slice(7, 10).trim(), to: f.slice(10, 13).trim(), carrier: f.slice(13, 16).trim(),
      flight: f.slice(16, 21).trim(), doy: parseInt(f.slice(21, 24), 10), cabin: f.slice(24, 25).trim(),
      seat: f.slice(25, 29).trim(), seq: f.slice(29, 34).trim(), status: f.slice(34, 35),
    };
    const varSize = parseInt(f.slice(35, 37), 16) || 0;
    const cond = t.slice(p + 37, p + 37 + varSize);
    // The first leg's conditional part may start with the "unique" block (">" + version), which has the issue date.
    if (i === 0 && cond[0] === '>' && cond.length >= 11){
      const uSize = parseInt(cond.slice(2, 4), 16) || 0, u = cond.slice(4, 4 + uSize);
      const di = u.slice(3, 7);
      if (/^\d{4}$/.test(di)){
        const lastDigit = +di[0], doy = +di.slice(1);
        const ry = +ref.slice(0, 4); let y = ry - ((ry % 10) - lastDigit + 10) % 10;   // latest year ≤ ref ending in that digit
        if (y < ry - 9) y += 10;
        if (doy >= 1 && doy <= 366) issued = { year: y, doy };
      }
    }
    if (!/^[A-Z]{3}$/.test(leg.from) || !/^[A-Z]{3}$/.test(leg.to) || !/^[A-Z0-9]{2,3}$/.test(leg.carrier) || !(leg.doy >= 1 && leg.doy <= 366)) return null;
    legs.push(leg);
    p += 37 + varSize;
  }
  if (!legs.length) return null;
  return { name, eticket, legs: legs.map(l => {
    const num = l.flight.replace(/^0+(?=\d)/, '');
    const date = fromJulian(yearFor(l.doy, ref, issued), l.doy);
    const seat = l.seat.replace(/^0+(?=\d)/, '');
    return {
      type: 'flight', number: l.carrier + num, ref: l.pnr || undefined, travellers: name ? [name] : undefined,
      from: placeOf(l.from), to: placeOf(l.to), start: date,
      title: `${l.carrier}${num} ${AIRPORTS[l.from] || l.from} → ${AIRPORTS[l.to] || l.to}`,
      seat: seat && !/^0*$/.test(seat) && !/INF|GATE/.test(seat) ? 'Seat ' + seat : undefined,
      details: [CABIN[l.cabin] ? CABIN[l.cabin] : '', l.seq && !/^0*$/.test(l.seq) ? 'boarding pass, check-in no. ' + l.seq.replace(/^0+/, '') : 'boarding pass'].filter(Boolean).join(' · '),
    };
  }) };
}
export { doyOf };
