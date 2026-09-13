// How many of the rooms we sell would the booking form pick by itself?
//
// Runs the real matcher over tests/fixtures/site-rooms-live.json — every room
// pingwin.co.il returned during the --coverage run — so the matcher can be
// worked on without hitting their site once. `npm run rooms -- --coverage` is
// still the truth; this is the fast loop between those runs.
//
//   node tools/match-score.js            the score, and every miss
//   node tools/match-score.js --quiet    just the score
const sr = require('../server/site-rooms.js');
const resorts = require('../data/resorts.json');
const units = require('../data/availability.json').units || [];
const live = require('../tests/fixtures/site-rooms-live.json');
const { pageFor } = require('../config/booking-url.js');
const quiet = process.argv.includes('--quiet');

// hotel|room|page — a hotel with a second booking page answers about the same
// room with a different id, so the page is part of the row
const rows = new Map();
for (const u of units) {
  const info = resorts.hotels[u.hotel];
  if (!info || !info.siteID) continue;
  const site = String(pageFor(info, u.nights).siteID);
  if (!live[site]) continue;
  const k = u.hotel + '|' + u.room + '|' + site;
  if (!rows.has(k)) rows.set(k, u);
}

let hit = 0;
const missed = [];
for (const [, u] of rows) {
  const siteID = pageFor(resorts.hotels[u.hotel], u.nights).siteID;
  const rooms = live[String(siteID)].map(([roomID, roomName]) => ({ roomID, roomName }));
  const base = { type: u.room_type, occMin: u.occ_min, occMax: u.occ_max, hotel: u.hotel };
  const lo = u.occ_min || u.occ_max || 0, hi = u.occ_max || u.occ_min || 0;
  let got = sr.match(rooms, u.room, base) || sr.idFor(String(siteID), '', '', u.room);
  for (let n = lo; !got && n <= hi; n++) got = sr.match(rooms, u.room, { ...base, party: n });
  if (got) hit++; else missed.push({ u, siteID, rooms });
}

if (!quiet) {
  let last = '';
  for (const m of missed) {
    if (m.u.hotel !== last) {
      last = m.u.hotel;
      console.log(`\n── ${m.u.hotel} (${m.siteID})`);
      m.rooms.forEach(r => console.log(`     ${String(r.roomID).padEnd(6)} ${r.roomName}`));
    }
    console.log(`   ✗ ${m.u.room}`);
  }
  console.log('');
}
console.log(`${hit}/${rows.size} חדרים זוהו  (${Math.round(hit / rows.size * 100)}%)`);
