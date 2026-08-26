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
const TIMEOUT_MS = Number(process.env.SITE_ROOMS_TIMEOUT_MS || 6000);
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
    .map(r => ({ roomID: String(r.roomID != null ? r.roomID : r.id), roomName: String(r.roomName || r.name || '') }))
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

/* ---------- matching ---------- */
const norm = s => String(s || '').toLowerCase()
  .replace(/["'׳״]/g, '')
  .replace(/[^א-תa-z0-9]+/g, ' ')
  .trim();

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

// Returns a roomID, or null. Never throws, never waits.
function idFor(siteID, from, till, room, deps) {
  if (!enabled() || !siteID || !room) return null;
  const manual = overrideFor(siteID, room);
  if (manual) return String(manual);
  const entry = load()[key(siteID, from, till)];
  if (!fresh(entry)) { warm(siteID, from, till, deps); return null; }
  const rooms = entry.rooms || [];
  if (!rooms.length) return null;
  const want = norm(room);
  if (!want) return null;
  const exact = rooms.filter(r => norm(r.roomName) === want);
  if (exact.length === 1) return exact[0].roomID;
  const partial = rooms.filter(r => {
    const n = norm(r.roomName);
    return n && (n.indexOf(want) >= 0 || want.indexOf(n) >= 0);
  });
  return partial.length === 1 ? partial[0].roomID : null;
}

module.exports = { idFor, warm, fetchRooms, enabled, norm, _cache: load, _key: key, CACHE_FILE };
