// Maps a workbook room string ("J. Suite 2+1", "DBL 2-2 (Type2)") onto the
// room described on the pingwin.co.il hotel page, so the bot can answer bed
// layout / size / bathroom questions about the SPECIFIC unit on offer.
//
// Deliberately conservative. When two site rooms fit equally well the matcher
// returns no match — naming the wrong room's bed layout is worse than saying a
// rep will confirm (red rule 1: never invent a room). But when the ambiguous
// candidates all AGREE on a field, that agreed value is still safe to state,
// which is what roomFacts() falls back to.
const KW = [
  ['premium', /premium/i],
  ['classic', /classic|קלאסיק/i],
  ['deluxe', /deluxe|dlx|דלוקס/i],
  ['suite', /suite|סוויט/i],
  ['junior', /junior|\bj\.?\s/i],
  ['penthouse', /penthouse/i],
  ['family', /family|משפח/i],
  ['prestige', /prestige/i],
  ['privilege', /privilege|פריבילג/i],
  ['superior', /superior/i],
  ['signature', /signature/i],
  ['studio', /studio|סטודיו/i],
  ['single', /\bsingle\b|\bsgl\b|יחיד\b/i],
  ['twin', /twin|טווין/i],
  ['dbl', /\bdbl\b|double|זוגי/i],
  ['resort', /resort/i],
  ['triple', /triple|טריפל/i],
  ['connected', /\bconn\b|connected|מקושר/i],
  ['balcony', /balcony|מרפסת/i],
  ['view', /view|נוף/i],
  ['amazing', /amazing/i],
  ['sauna', /sauna|סאונה/i],
  ['plus', /\bplus\b/i],
  ['comfort', /comfort|קומפורט/i],
  ['grand', /grand/i],
  ['pmr', /\bpmr\b|נכים|נגיש/i],
  ['interior', /interior/i],
  ['exterior', /exterior/i],
  ['slopes', /slopes|מסלולים/i],
];

// "DBL", "Room", "חדר", "Standard", "Appt" carry no distinguishing meaning —
// every room is one. Scoring them would punish correct matches.
// NOTE: DBL/TWIN are NOT generic — that is exactly the distinction a
// customer asking for separate beds cares about, so they stay scored.
const GENERIC = /\b(room|rooms|apt|appt|apart|apartment|standard|std|pax)\b|סטנדרט/gi;

const HE_NUM = { 'שני': 2, 'שתי': 2, 'שלושה': 3, 'שלוש': 3, 'ארבעה': 4, 'ארבע': 4 };

// Structure (size, bedroom count, capacity) is read from the raw string;
// keywords are read from a copy with the meaningless words removed, so that
// "Standard"/"Apartment" cannot outvote "Junior"/"Twin".
function feat(s) {
  const t = String(s || '');
  const stripped = t.replace(GENERIC, ' ');
  const f = { kw: new Set(), tok: new Set(), bedrooms: null, cabin: false, sqm: null, type: null, min: null, max: null };
  // proper names the keyword list cannot know about ("Ziller", "Stilluptal",
  // "Privilege") — a shared one is a strong hint that these are the same room
  for (const w of stripped.toLowerCase().match(/[a-z֐-׿]{4,}/g) || []) f.tok.add(w);
  for (const [k, re] of KW) if (re.test(stripped)) f.kw.add(k);

  let m = t.match(/(\d)\s*(?:bed\s?rooms?|bdrm|ח"ש|חדרי שינה)/i);
  if (m) f.bedrooms = +m[1];
  else if (/1\s*bed\s?room|one bedroom|1\s*bdrm|(?:^|\s)חדר שינה/i.test(t)) f.bedrooms = 1;
  else if (/two[- ]bedroom/i.test(t)) f.bedrooms = 2;
  else { for (const [w, n] of Object.entries(HE_NUM)) if (new RegExp(w + ' חדרי').test(t)) f.bedrooms = n; }

  f.cabin = /cabin|נישה/i.test(t);

  m = t.match(/(\d{2,3})\s*(?:mr|m\b|מ"ר|מ״ר)/i);
  if (m) f.sqm = +m[1];

  // Ferienhof-style "(Type2)" / "room type 2"
  m = t.match(/type\s*(\d)/i);
  if (m) f.type = +m[1];

  m = t.match(/(\d)\s*[-–]\s*(\d)/);
  if (m) { f.min = +m[1]; f.max = +m[2]; }
  else if ((m = t.match(/(\d)\s*\+\s*(\d)/))) { f.min = +m[1]; f.max = +m[1] + +m[2]; }
  else if ((m = t.match(/(\d)\s*pax/i))) { f.min = f.max = +m[1]; }
  else if ((m = t.match(/(?:^|\s)חדר\s+(\d)(?:\s|$)/))) { f.min = f.max = +m[1]; }
  // a bare trailing digit is a capacity ("2 חדרי שינה וסלון 5"); a 4-digit
  // resort name ("Arc 1800") must not be read as one
  else if ((m = t.match(/(?:^|\s)(\d)\s*$/))) { f.min = f.max = +m[1]; }
  return f;
}

// Features of a hotel-page room: its name plus the floor area, which the page
// keeps in a separate field ("כ-50-56 מ\"ר") rather than in the room name.
function featRoom(r) {
  const f = feat(r.name);
  // the page states capacity in its own field too ("2-4 אנשים")
  const o = String(r.occupancy_he || '').match(/(\d)\s*[-–]\s*(\d)/);
  if (o) { f.min = f.min == null ? +o[1] : Math.min(f.min, +o[1]); f.max = f.max == null ? +o[2] : Math.max(f.max, +o[2]); }
  if (f.sqm != null) { f.sqmMin = f.sqmMax = f.sqm; return f; }
  const m = String(r.size_he || '').match(/(\d{2,3})(?:\s*[-–]\s*(\d{2,3}))?/);
  if (m) { f.sqmMin = +m[1]; f.sqmMax = m[2] ? +m[2] : +m[1]; }
  else { f.sqmMin = f.sqmMax = null; }
  return f;
}

function score(a, b) {
  let s = 0;
  if (a.sqm != null && b.sqmMin != null) {
    // the workbook often carries the floor area ("2 bedroom apart 6 pax 50 mr")
    // and the hotel page states it as a range ("50-56 מ\"ר") — a strong signal
    s += (a.sqm >= b.sqmMin - 2 && a.sqm <= b.sqmMax + 2) ? 6 : -4;
  }
  if (a.type != null && b.type != null) s += a.type === b.type ? 4 : -4;
  if (a.bedrooms != null && b.bedrooms != null) s += a.bedrooms === b.bedrooms ? 3 : -4;
  // a plain "Standard 2-3" is not a one-bedroom apartment, and vice versa
  else if (a.bedrooms != null || b.bedrooms != null) s -= 1.5;
  if (a.cabin !== b.cabin && (a.cabin || b.cabin)) s -= 1; else if (a.cabin) s += 1;
  if (a.max != null && b.max != null) {
    if (a.max === b.max) s += 3;
    else if (Math.abs(a.max - b.max) === 1) s += 0.5;
    else s -= 2;
    if (a.min === b.min) s += 1;
    // a site room whose range CONTAINS the workbook range still fits
    if (b.min != null && a.min != null && a.min >= b.min && a.max <= b.max) s += 1.5;
  }
  for (const t of a.tok) if (b.tok.has(t)) s += 1.5;
  for (const k of a.kw) s += b.kw.has(k) ? 2.5 : -1;
  for (const k of b.kw) if (!a.kw.has(k)) s -= 1;
  return s;
}

// `party` = how many people will actually sleep in it. A workbook room sold as
// "DBL 2-4" can be two different rooms on the hotel page (1-2 and 3-4); which
// one the customer gets depends on the party size, and so does the bed layout.
function matchRoom(invRoom, siteRooms, party) {
  if (!siteRooms || !siteRooms.length) return null;
  const a = feat(invRoom);
  let pool = siteRooms;
  if (party != null) {
    const fits = pool.filter(r => {
      const b = featRoom(r);
      return b.max == null || (party <= b.max && (b.min == null || party >= b.min));
    });
    if (fits.length) pool = fits;
  }
  // a room that sleeps fewer people than the unit sold cannot be that unit
  const big = pool.filter(r => {
    const b = featRoom(r);
    return b.max == null || a.max == null || b.max >= a.max;
  });
  if (big.length) pool = big;
  // "CONN" is a PAIR of connected rooms, not one room. If the hotel page does
  // not describe a connected unit, we do not have its layout — better to say
  // a rep will confirm than to quote the wrong room's beds.
  if (a.kw.has('connected')) pool = pool.filter(r => featRoom(r).kw.has('connected'));
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0];
  // A word that appears in exactly ONE candidate name is that room's proper
  // name ("Ziller", "Stilluptal", "Interior"). If the workbook uses the same
  // word, that is near-proof, and it must outweigh a closer capacity range.
  const freq = new Map();
  for (const r of pool) for (const t of featRoom(r).tok) freq.set(t, (freq.get(t) || 0) + 1);
  const scored = pool
    .map(r => {
      const b = featRoom(r);
      let s = score(a, b);
      for (const t of b.tok) if (a.tok.has(t) && freq.get(t) === 1) s += 5;
      return { r, s };
    })
    .sort((x, y) => y.s - x.s);
  if (scored[0].s < 2) return null;
  if (scored[1] && scored[0].s - scored[1].s < 1.5) return null;   // ambiguous
  return scored[0].r;
}

const FACT_FIELDS = ['size_he', 'occupancy_he', 'beds_he', 'bath_he'];

// Facts about the offered unit. `exact` says whether they describe this room
// specifically, or a detail every room in the hotel shares.
function roomFacts(invRoom, siteRooms, party) {
  const hit = matchRoom(invRoom, siteRooms, party);
  if (hit) return { name: hit.name, exact: true, ...pick(hit) };
  if (!siteRooms || !siteRooms.length) return null;
  const out = { name: null, exact: false };
  for (const f of FACT_FIELDS) {
    const vals = [...new Set(siteRooms.map(r => r[f]).filter(Boolean))];
    out[f] = vals.length === 1 ? vals[0] : null;
  }
  return out;
}

function pick(r) {
  const o = {};
  for (const f of FACT_FIELDS) o[f] = r[f] || null;
  return o;
}

module.exports = { matchRoom, roomFacts, feat, featRoom, score };
