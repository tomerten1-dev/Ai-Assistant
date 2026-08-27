'use strict';
// The hotels Pingwin sells, as opposed to the hotels we hold rooms for.
//
// data/catalogue.json has 117 of them; 38 carry commitments in the workbook and
// can be offered with a date and a room. The other 79 are real, sellable, and
// invisible to the search — Tomer, 26/08: on dates that are not under a
// "מכירת התחייבויות בלבד" restriction they can be sold, subject to
// confirmation with the hotel.
//
// So this module exists to let the bot SAY those hotels exist and hand them to
// a person. It never produces a card, a date, a room or a price: a catalogue
// hotel has none of those, and inventing them is the one thing that would make
// this feature worse than not having it.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'catalogue.json');
let cache = null, stamp = -1;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch (e) { return cache || { hotels: [] }; }
  if (cache && mtime === stamp) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    stamp = mtime;
  } catch (e) {
    console.error('catalogue.json unreadable (%s) — keeping what was loaded', e.message);
    cache = cache || { hotels: [] };
  }
  return cache;
}

// Every hotel the customer can be told about. A row with `same_as` is another
// BOOKING PAGE for a hotel already in this list — Casa Karina sells stays
// shorter than a week on a page of its own — and naming it as a second hotel in
// Bansko would be plainly wrong. The link still reaches it: config/booking-url.js
// picks the page from data/resorts.json, not from here.
const hotels = () => (load().hotels || []).filter(h => !h.same_as);
// including the alternate pages, for anything that works with siteIDs
const allPages = () => (load().hotels || []);

// Every hotel we sell in a resort, named the way the site names it.
// `resortHe` is what the customer's message resolved to ("סנט אנטון").
function inResortHe(resortHe) {
  const t = String(resortHe || '').trim();
  if (!t) return [];
  return hotels().filter(h => h.resort_he === t);
}
function inResort(resort) {
  return hotels().filter(h => h.resort === resort);
}

// A hotel the customer named that we sell but hold no rooms for. Returns the
// row, or null — including null for the hotels the search can already offer,
// which belong to the search and not here.
function catalogueOnly(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  for (const h of hotels()) {
    if (h.commitment) continue;
    // the distinctive part of the name, not "Hotel" or "Club": those match
    // half the catalogue and would answer a question nobody asked
    const words = h.name.split(/[\s\-]+/)
      .filter(w => w.length > 3 && !/^(hotel|club|residence|res|apart|apartment|prestige|resort|spa|the|des|les|del|du|de|la|le)$/i.test(w));
    if (!words.length) continue;
    const hit = words.every(w => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\']/g, '\\$&'), 'i').test(t));
    if (hit) return h;
  }
  return null;
}

// "אנחנו עובדים שם עם A, B ו-C". Capped: a list of nine hotel names is not an
// answer, it is a directory.
function names(list, cap = 4) {
  const xs = list.slice(0, cap).map(h => h.name);
  const rest = list.length - xs.length;
  const joined = xs.length > 1 ? xs.slice(0, -1).join(', ') + ' ו-' + xs[xs.length - 1] : xs[0];
  return rest > 0 ? `${joined} ועוד ${rest}` : joined;
}

module.exports = { load, hotels, allPages, inResort, inResortHe, catalogueOnly, names, FILE };
