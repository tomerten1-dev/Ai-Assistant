'use strict';
// The room ids pingwin.co.il's own booking engine uses.
//
// Why: the prefill matches a room by NAME, and the two sources spell rooms
// differently — the commitments workbook says "1 bdrm apt 2-4 pax 27 mr
// privilege", the site's dropdown says "2 ח\"ש וסלון 2-4 אורחים". Hebrew
// against English never matches, so most offers arrived with the dates filled
// and the room left blank (Tomer, 26/08).
//
// The site's own form gets its list from a plain GET:
//   /ajax_order_odyssea.php?act=roomList&sid=<siteID>&from=<yyyy-mm-dd>
//                          &till=<yyyy-mm-dd>&nofly=0&flight=0
//   → { rooms: [ { roomID, roomName, showOrder, … } ], … }
// so we ask the same question and put the real id in the link.
//
// Three rules this module lives by:
//  1. It NEVER blocks a reply. Offers are built from a cache that is warmed in
//     the background; a cold cache simply means the link carries the name, the
//     way it did before this file existed.
//  2. It never guesses. One unambiguous match, or nothing.
//  3. It is switchable off (SITE_ROOMS=off) and cannot cost more than one
//     request per hotel+dates per TTL.

const path = require('path');
const fs = require('fs');

const BASE = process.env.SITE_ROOMS_BASE || 'https://www.pingwin.co.il';
const API = '/ajax_order_odyssea.php';
const TTL_MS = Number(process.env.SITE_ROOMS_TTL_MS || 6 * 60 * 60 * 1000);   // 6h
const TIMEOUT_MS = Number(process.env.SITE_ROOMS_TIMEOUT_MS || 12000);   // their engine can take ~8s
const CACHE_FILE = path.join(__dirname, '..', 'server-data', 'site-rooms.json');

const enabled = () => String(process.env.SITE_ROOMS || 'on').toLowerCase() !== 'off';

let mem = null;            // { key: { at, rooms:[{roomID,roomName}] } }
const inFlight = new Map();

function load() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { mem = {}; }
  return mem;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(mem));
    } catch (e) { /* a cache we cannot persist is still a cache */ }
  }, 500);
  if (saveTimer.unref) saveTimer.unref();
}

const key = (siteID, from, till) => `${siteID}|${from}|${till}`;

// The site wants yyyy-mm-dd (its own properDate()).
function fresh(entry) { return entry && (Date.now() - entry.at) < TTL_MS; }

async function fetchRooms(siteID, from, till, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const url = `${BASE}${API}?act=roomList&sid=${encodeURIComponent(siteID)}` +
    `&from=${encodeURIComponent(from)}&till=${encodeURIComponent(till)}&nofly=0&flight=0`;
  const res = await doFetch(url, {
    headers: {
      // their WAF answers 403 to anything that looks automated
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'x-requested-with': 'XMLHttpRequest',
      'referer': `${BASE}/`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  const rooms = body && body.rooms;
  if (!rooms) throw new Error('no rooms in the answer');
  // the shape is an object keyed by id in some responses, an array in others
  const list = Array.isArray(rooms) ? rooms : Object.values(rooms);
  return list
    .map(r => ({
      roomID: String(r.roomID != null ? r.roomID : r.id),
      // the engine returns HTML entities: `2 ח&quot;ש וסלון 2-4 אורחים`
      roomName: decodeEntities(String(r.roomName || r.name || '')),
    }))
    .filter(r => r.roomID && r.roomName);
}

// Warm the cache without making anybody wait for it.
function warm(siteID, from, till, deps) {
  if (!enabled() || !siteID || !from || !till) return;
  const k = key(siteID, from, till);
  if (fresh(load()[k]) || inFlight.has(k)) return;
  const p = fetchRooms(siteID, from, till, deps)
    .then(rooms => { load()[k] = { at: Date.now(), rooms }; save(); return rooms; })
    .catch(e => {
      // remember the failure briefly too, so a site that is down is not asked
      // again on every single reply
      load()[k] = { at: Date.now(), rooms: [], error: e.message };
      save();
      if (!warm._quiet) console.error('roomList failed for %s (%s→%s): %s', siteID, from, till, e.message);
      return [];
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, p);
  return p;
}

/* ---------- matching ----------
   The two sources describe the same room in different languages and different
   habits. Real examples from Pingwin's own engine (26/08):

     ours                              theirs
     CONN Premium with View 5 pax      Premium with View 4-5 pax
     Premium Amazing View 5 pax        Premium Amazing View 2-5 pax
     2 bedroom apt 4-5 pax             2 ח"ש וסלון 2-4 אורחים

   So the match is done on two axes at once: the room's DESCRIPTION reduced to
   meaningful tokens (in one language), and its OCCUPANCY as a range. A
   candidate must agree on both, and must be the only one that does. */
function decodeEntities(t) {
  return String(t)
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

const norm = s => decodeEntities(String(s || '')).toLowerCase()
  .replace(/["'׳״]/g, '')
  // "2Bdrm", "Type2", "45M" — one token to a human, two to us
  .replace(/(\d)([a-zא-ת])/g, '$1 $2').replace(/([a-zא-ת])(\d)/g, '$1 $2')
  .replace(/[^א-תa-z0-9]+/g, ' ')
  .trim();

// How many people the name says the room holds. Two ways of saying it, and the
// second one has no word attached at all:
//   "5 pax", "2-5 pax", "2+1 pax", "5 אורחים", "2-4 אורחים"   ← spelled out
//   "Premium Room 2-3", "Premium with Balcony 3+1"           ← just the range
// A bare number is NOT occupancy — "2 ח\"ש", "2 bdrm" count bedrooms — so the
// second form is only read when it is a range or a plus, and only when no
// bedroom word follows it.
const PEOPLE = 'pax|ppl|people|אורחים|נופשים|אנשים';
const BEDS = "bdrm|bedrooms?|ח[\"'׳״]?ש|חדרי|rooms?";
const OCC = new RegExp('(\\d+)\\s*(?:[-–]\\s*(\\d+)|\\+\\s*(\\d+))?\\s*(?:' + PEOPLE + ')', 'i');
const OCC_BARE = new RegExp('(\\d+)\\s*(?:[-–]\\s*(\\d+)|\\+\\s*(\\d+))(?!\\s*(?:' + BEDS + ')\\b)', 'i');
function occOf(name) {
  const text = decodeEntities(String(name || ''));
  const m = OCC.exec(text) || OCC_BARE.exec(text);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : (m[3] ? a + parseInt(m[3], 10) : a);
  return { min: Math.min(a, b), max: Math.max(a, b), said: m[0] };
}
const overlaps = (x, y) => !x || !y || (x.min <= y.max && y.min <= x.max);
// does this room take exactly the party that is travelling?
const holds = (occ, party) => !party || !occ || (occ.min <= party && party <= occ.max);
// can this room hold the whole range we sell?
const covers = (occ, ours) => !occ || !ours || (occ.min <= ours.min && ours.max <= occ.max);

// The apartments are the hardest names to line up — "1 bdrm apt 2-4 pax 27 mr
// privilege" against "חדר שינה וסלון כ-27 מ\"ר פריבילג' 2-4" — and both sides
// state the floor area. Two rooms in one residence never share it, so when both
// say a size and the sizes differ, they are not the same room. Nothing else in
// this file is that decisive.
const SIZE = /(\d+)\s*(?:m²|sqm|מ["'׳״]?ר|mr\b|m\b)/i;
function sizeOf(name) {
  const m = SIZE.exec(decodeEntities(String(name || '')));
  return m ? { m2: parseInt(m[1], 10), said: m[0] } : null;
}
const sizeAgrees = (a, b) => !a || !b || a.m2 === b.m2;

// one vocabulary for both languages, and the words that carry no information
const SAME = new Map([
  ['bdrm', 'bdrm'], ['bedroom', 'bdrm'], ['bedrooms', 'bdrm'], ['חש', 'bdrm'],
  ['חדרי', 'bdrm'], ['שינה', ''], ['ח', ''], ['ש', ''],
  ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'],
  ['view', 'view'], ['נוף', 'view'],
  ['balcony', 'balcony'], ['מרפסת', 'balcony'],
  ['studio', 'studio'], ['סטודיו', 'studio'],
  ['pmr', 'pmr'], ['נכים', 'pmr'], ['נגיש', 'pmr'],
  // the bed types, in the four ways the two systems write them
  ['dbl', 'double'], ['double', 'double'], ['doubles', 'double'], ['זוגי', 'double'], ['זוגית', 'double'],
  ['sgl', 'single'], ['single', 'single'], ['יחיד', 'single'],
  ['twin', 'twin'], ['טווין', 'twin'],
  ['triple', 'triple'], ['טריפל', 'triple'],
  ['dlx', 'deluxe'], ['deluxe', 'deluxe'], ['דלוקס', 'deluxe'],
  ['j', 'junior'], ['junior', 'junior'], ['גוניור', 'junior'],
  ['standard', 'standard'], ['סטנדרט', 'standard'], ['סטנדרד', 'standard'],
  ['classic', 'classic'], ['קלאסיק', 'classic'],
  ['privilege', 'privilege'], ['פריבילג', 'privilege'],
  ['comfort', 'comfort'], ['קומפורט', 'comfort'],
  ['premier', 'premier'], ['פרמייר', 'premier'],
  ['cabin', 'cabin'], ['נישה', 'cabin'],
  ['sauna', 'sauna'], ['סאונה', 'sauna'],
  ['gallery', 'gallery'], ['גלריה', 'gallery'],
  ['mountain', 'mountain'], ['הר', 'mountain'],
  ['south', 'south'], ['דרום', 'south'], ['פונה', ''],
  ['amazing', 'amazing'], ['premium', 'premium'], ['prestige', 'prestige'],
  ['superior', 'superior'], ['suite', 'suite'], ['סוויטה', 'suite'],
  ['suites', 'suite'], ['family', 'family'], ['משפחתי', 'family'],
]);
// the generic words for "a room" — dropped only as a last resort, when the two
// sides share nothing else. Montgenèvre sells our "DBL 2-4" as "Standard 1-5".
const GENERIC = new Set(['double', 'standard']);
// words that appear on one side only, or in both with no distinguishing power
const NOISE = new Set(['apt', 'apartment', 'apartments', 'appartement', 'app', 'appt', 'apts',
  'דירה', 'דירת', 'room', 'rooms', 'חדר', 'חדרים',
  'וסלון', 'סלון', 'living', 'lounge', 'with', 'and', 'the', 'of', 'pax', 'ppl', 'people',
  'אורחים', 'נופשים', 'אנשים', 'עם', 'ו', 'conn', 'connecting', 'connected', 'מחוברים',
  'type', 'טיפוס', 'כ', 'mr', 'מר', 'm', 'sqm']);

function tokens(name) {
  // the occupancy is removed BEFORE normalising: norm() deletes the hyphen in
  // "2-5 pax", and then the range no longer looks like one — "2" survived as a
  // token and no Belambra room ever matched (Tomer's run, 26/08).
  let text = decodeEntities(String(name || ''));
  const size = sizeOf(text);
  if (size) text = text.split(size.said).join(' ');
  const occ = occOf(text);
  if (occ) text = text.split(occ.said).join(' ');
  const cleaned = norm(text);
  const out = new Set();
  for (let w of cleaned.split(/\s+/)) {
    if (!w) continue;
    if (SAME.has(w)) w = SAME.get(w);
    if (!w || NOISE.has(w)) continue;
    out.add(w);
  }
  return out;
}
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const subset = (a, b) => [...a].every(x => b.has(x));

// A manual bridge for the rooms whose two names will never look alike.
// { "<siteID>": { "<workbook room name>": "<roomID>" } }
let overrides = null;
function overrideFor(siteID, room) {
  if (overrides === null) {
    try { overrides = require('../config/room-map.json'); }
    catch (e) { overrides = {}; }
  }
  const forSite = overrides[String(siteID)] || {};
  const hit = forSite[room] || forSite[norm(room)] || null;
  // keys starting with _ are notes to whoever edits the file, not room ids
  return hit && !String(room).startsWith('_') ? hit : null;
}

// The room in the site's own list, or null. Never throws, never waits.
// `hint` carries what the workbook knows and the name does not always say:
// { type: 'CONN Premium with View', occMin: 5, occMax: 5 }.
function match(rooms, room, hint = {}) {
  if (!rooms || !rooms.length || !room) return null;
  // the workbook splits the same name across two columns and neither is
  // complete: room_type for "Premium 3 +1 balcony" is just "Premium". So the
  // description is everything both columns say.
  const ourTokens = tokens(room);
  for (const w of tokens(hint.type || '')) ourTokens.add(w);
  const ourOcc = (hint.occMin || hint.occMax)
    ? { min: hint.occMin || hint.occMax, max: hint.occMax || hint.occMin }
    : occOf(room);
  const ourSize = sizeOf(room) || sizeOf(hint.type || '');

  // Anything that cannot be this room is gone before a single name is compared:
  // a room that cannot hold our party, and a room whose floor area is a
  // different number from ours.
  const scored = rooms.map(r => ({ r, tk: tokens(r.roomName), occ: occOf(r.roomName), size: sizeOf(r.roomName) }))
    .filter(x => overlaps(ourOcc, x.occ) && sizeAgrees(ourSize, x.size));
  if (!scored.length) return null;
  // The area named it: both sides stated a floor area, they agree, and one room
  // is left. It still has to not contradict us — a 45 m² one-bedroom and a
  // 45 m² two-bedroom are different rooms, so the two descriptions must share a
  // word, or one of them must say nothing beyond the area.
  if (scored.length === 1 && ourSize && scored[0].size) {
    const theirs = scored[0].tk;
    const shares = [...ourTokens].some(w => theirs.has(w));
    if (shares || !theirs.size || !ourTokens.size) return scored[0].r.roomID;
  }

  // Two rooms left that describe the same thing. Three ways to tell them apart,
  // in the order we trust them:
  const pick = list => {
    if (list.length === 1) return list[0].r.roomID;
    if (list.length < 2) return null;
    // 1 · who is travelling. We sell "2 bedroom apt 4-5 pax" as one unit; Plein
    //     Sud sells that apartment twice, "2 ח"ש וסלון 2-4 אורחים" and
    //     "2 ח"ש וסלון 5 אורחים". Only the party separates them, and the
    //     customer already told us.
    if (hint.party) {
      const fits = list.filter(x => holds(x.occ, hint.party));
      if (fits.length === 1) return fits[0].r.roomID;
    }
    // 2 · capacity. Ferienhof sells "DBL room type 2" at 1-2 and again at 1-3;
    //     our two units are "DBL 2-2 (Type2)" and "DBL 2-3 (Type2)". The room
    //     whose ceiling is our ceiling AND which holds our whole range is the
    //     one. That second half is what stops this from guessing at Plein Sud,
    //     where the 5-only room cannot take our 4-person low end.
    if (ourOcc) {
      const same = list.filter(x => x.occ && x.occ.max === ourOcc.max && covers(x.occ, ourOcc));
      if (same.length === 1) return same[0].r.roomID;
    }
    return null;
  };

  const tiers = [
    // exactly the same description, in whichever language
    tk => sameSet(ourTokens, tk),
    // one description contains the other (ours is shorter, or theirs is)
    tk => ourTokens.size && (subset(ourTokens, tk) || subset(tk, ourTokens)),
  ];
  for (const fits of tiers) {
    const chosen = pick(scored.filter(x => fits(x.tk)));
    if (chosen) return chosen;
  }

  // The hotel's own name, when the site puts it in the room and we do not.
  // siteID 269 answers for Sport AND Strass in one list: "Strass Double Room"
  // and "Sport Deluxe Double Room" both look like our "DBL". Only tried once
  // nothing else worked, and it still has to be the only candidate.
  if (hint.hotel) {
    const withHotel = new Set(ourTokens);
    for (const w of tokens(hint.hotel)) withHotel.add(w);
    if (withHotel.size > ourTokens.size) {
      for (const fits of [tk => sameSet(withHotel, tk), tk => subset(tk, withHotel)]) {
        const chosen = pick(scored.filter(x => fits(x.tk)));
        if (chosen) return chosen;
      }
    }
  }

  // Last: drop the words that only mean "a room". Montgenèvre sells our
  // "DBL 2-4" as "Standard 1-5" — nothing is shared until both words go. Exact
  // agreement only here, because after dropping them a set is often empty and
  // "contains" would match everything.
  const plain = set => new Set([...set].filter(w => !GENERIC.has(w)));
  const ourPlain = plain(ourTokens);
  if (ourPlain.size < ourTokens.size || !ourTokens.size) {
    const chosen = pick(scored.filter(x => sameSet(ourPlain, plain(x.tk))));
    if (chosen) return chosen;
  }
  // anything else is a guess, and a guess books the wrong room
  return null;
}

function idFor(siteID, from, till, room, hint, deps) {
  if (!enabled() || !siteID || !room) return null;
  const manual = overrideFor(siteID, room);
  if (manual) return String(manual);
  const entry = load()[key(siteID, from, till)];
  if (!fresh(entry)) { warm(siteID, from, till, deps); return null; }
  return match(entry.rooms || [], room, hint || {});
}

module.exports = { idFor, match, warm, fetchRooms, enabled, norm, tokens, occOf, sizeOf, holds, decodeEntities,
  _cache: load, _key: key, CACHE_FILE };
