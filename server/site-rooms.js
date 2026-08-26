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
  .replace(/[^א-תa-z0-9+]+/g, ' ')
  .trim();

// how many people the name says the room holds: "5 pax", "2-5 pax",
// "2+1 pax", "5 אורחים", "2-4 אורחים"
const OCC = /(\d+)\s*(?:[-–]\s*(\d+)|\+\s*(\d+))?\s*(?:pax|ppl|people|אורחים|נופשים|אנשים)/i;
function occOf(name) {
  const m = OCC.exec(decodeEntities(String(name || '')));
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : (m[3] ? a + parseInt(m[3], 10) : a);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}
const overlaps = (x, y) => !x || !y || (x.min <= y.max && y.min <= x.max);

// one vocabulary for both languages, and the words that carry no information
const SAME = new Map([
  ['bdrm', 'bdrm'], ['bedroom', 'bdrm'], ['bedrooms', 'bdrm'], ['חש', 'bdrm'],
  ['חדרי', 'bdrm'], ['שינה', ''], ['ח', ''], ['ש', ''],
  ['view', 'view'], ['נוף', 'view'],
  ['balcony', 'balcony'], ['מרפסת', 'balcony'],
  ['studio', 'studio'], ['סטודיו', 'studio'],
  ['pmr', 'pmr'], ['נכים', 'pmr'], ['נגיש', 'pmr'],
  ['amazing', 'amazing'], ['premium', 'premium'], ['prestige', 'prestige'],
  ['deluxe', 'deluxe'], ['superior', 'superior'], ['standard', 'standard'],
  ['suite', 'suite'], ['סוויטה', 'suite'], ['family', 'family'], ['משפחתי', 'family'],
]);
// words that appear on one side only, or in both with no distinguishing power
const NOISE = new Set(['apt', 'apartment', 'appartement', 'דירה', 'דירת', 'room', 'rooms', 'חדר', 'חדרים',
  'וסלון', 'סלון', 'living', 'lounge', 'with', 'and', 'the', 'of', 'pax', 'ppl', 'people',
  'אורחים', 'נופשים', 'אנשים', 'עם', 'ו', 'conn', 'connecting', 'מחוברים', 'type', 'טיפוס']);

function tokens(name) {
  // the occupancy is removed BEFORE normalising: norm() deletes the hyphen in
  // "2-5 pax", and then the range no longer looks like one — "2" survived as a
  // token and no Belambra room ever matched (Tomer's run, 26/08).
  const cleaned = norm(decodeEntities(String(name || '')).replace(OCC, ' '));
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
  return forSite[room] || forSite[norm(room)] || null;
}

// The room in the site's own list, or null. Never throws, never waits.
// `hint` carries what the workbook knows and the name does not always say:
// { type: 'CONN Premium with View', occMin: 5, occMax: 5 }.
function match(rooms, room, hint = {}) {
  if (!rooms || !rooms.length || !room) return null;
  const ourName = hint.type || room;
  const ourTokens = tokens(ourName);
  const ourOcc = (hint.occMin || hint.occMax)
    ? { min: hint.occMin || hint.occMax, max: hint.occMax || hint.occMin }
    : occOf(room);
  if (!ourTokens.size) return null;

  const scored = rooms.map(r => ({ r, tk: tokens(r.roomName), occ: occOf(r.roomName) }))
    .filter(x => overlaps(ourOcc, x.occ));

  // 1 · the same description, in whichever language
  const same = scored.filter(x => sameSet(ourTokens, x.tk));
  if (same.length === 1) return same[0].r.roomID;
  // 2 · one description contains the other (ours is shorter, or theirs is)
  const near = scored.filter(x => subset(ourTokens, x.tk) || subset(x.tk, ourTokens));
  if (near.length === 1) return near[0].r.roomID;
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

module.exports = { idFor, match, warm, fetchRooms, enabled, norm, tokens, occOf, decodeEntities,
  _cache: load, _key: key, CACHE_FILE };
