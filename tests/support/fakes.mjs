// Shared fakes for the server tests: a signed-in member, a JSON response, a fake SerpApi and a fake Groq.
export const verify = async () => ({ email: 'anubhav.iiitb@gmail.com' });
export const req = (body, path = '/api/x') => new Request('http://test' + path, { method: 'POST', headers: { authorization: 'Bearer test' }, body: JSON.stringify(body) });
export const res = (status, body) => ({ ok: status < 300, status, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });

const pad = n => String(n).padStart(2, '0');
const at = (date, h, m) => `${date} ${h}:${pad(m)}`;
export const seg = (from, to, date, h, m, mins, airline = 'Lufthansa', number = 'LH 1') => {
  const t = new Date(Date.parse(`${date}T${pad(h)}:${pad(m)}:00Z`) + mins * 60e3);
  return { departure_airport: { id: from, time: at(date, h, m) }, arrival_airport: { id: to, time: `${t.toISOString().slice(0, 10)} ${t.getUTCHours()}:${pad(t.getUTCMinutes())}` }, airline, flight_number: number };
};

// SerpApi stand-in. Flights exist for every route, departing 07:10, 13:00 and 21:30, except that a group of airports
// ending in Rome ("…,CIA") returns nothing, the way Google did for ATH → FCO,CIA (each airport alone works).
export function fakeSerpApi({ calls = [], emptyGroups = /,CIA$/ } = {}){
  return async url => {
    const u = new URL(url), p = Object.fromEntries(u.searchParams);
    if (u.pathname.endsWith('/account.json')) return res(200, { total_searches_left: 200 });
    calls.push(p);
    if (p.engine === 'google_travel_explore'){
      const rome = p.departure_id.includes('FCO');
      const d = (id, name, country, code, price, hotel) => ({ destination_id: id, name, country, destination_airport: { code }, flight_price: price, hotel_price: hotel, flight_duration: 140, number_of_stops: 0, airline: 'Aegean' });
      return res(200, { destinations: [d('/m/ath', 'Athens', 'Greece', 'ATH', rome ? 160 : 200, 70), d('/m/vie', 'Vienna', 'Austria', 'VIE', rome ? 150 : 90, 95), d('/m/rom', 'Rome', 'Italy', 'FCO', 120, 90),
        rome ? d('/m/lis', 'Lisbon', 'Portugal', 'LIS', 170, 80) : d('/m/opo', 'Porto', 'Portugal', 'OPO', 130, 60)] });
    }
    if (emptyGroups && emptyGroups.test(p.arrival_id)) return res(400, { error: "Google Flights hasn't returned any results for this query." });
    const from = p.departure_id.split(',')[0], to = p.arrival_id.split(',')[0], d = p.outbound_date;
    return res(200, {
      best_flights: [{ flights: [seg(from, to, d, 7, 10, 110, 'Lufthansa', 'LH 100')], total_duration: 110, price: 140 }],
      other_flights: [{ flights: [seg(from, to, d, 13, 0, 110, 'ITA Airways', 'AZ 200')], total_duration: 110, price: 95 },
        { flights: [seg(from, to, d, 21, 30, 110, 'Ryanair', 'FR 300')], total_duration: 110, price: 45 }],
      price_insights: { price_level: 'typical', lowest_price: 45, typical_price_range: [60, 150] },
    });
  };
}

// Groq stand-in: answers with whatever JSON the test gives it, and keeps what it was sent.
export function fakeGroq(answer, sent = []){
  return async (url, opt) => { sent.push(JSON.parse(opt.body)); return res(200, { choices: [{ message: { content: JSON.stringify(typeof answer === 'function' ? answer(JSON.parse(opt.body)) : answer) } }] }); };
}
export const memoryCache = () => { const m = new Map(); return { m, get: async id => m.get(id), set: async (id, v) => { m.set(id, v); } }; };
