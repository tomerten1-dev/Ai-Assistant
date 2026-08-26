'use strict';
/* Every room in the commitments workbook, against the room list pingwin.co.il's
   own engine returned for that hotel (tests/fixtures/site-rooms-live.json,
   captured 26/08). The expected answer for each was checked by hand.

   This is the test that decides whether "המשך להזמנה" opens the form on the
   room the customer was shown or on a blank dropdown — and, worse, whether it
   could ever open on the WRONG room. A diff here is a change in what a customer
   is quoted: read it, never regenerate it.

   Run: node tests/test-room-match.js */
process.env.CHAT_LOG = 'off';

const assert = require('assert');
const sr = require('../server/site-rooms.js');
const resorts = require('../data/resorts.json');
const units = require('../data/availability.json').units || [];
const live = require('../tests/fixtures/site-rooms-live.json');
const expected = require('../tests/fixtures/site-rooms-expected.json');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// the workbook row behind each hotel+room, so the hint is the real one
const unitFor = new Map();
for (const u of units) {
  const k = u.hotel + '|' + u.room;
  if (!unitFor.has(k)) unitFor.set(k, u);
}
const resolve = (hotel, room, party) => {
  const u = unitFor.get(hotel + '|' + room);
  const siteID = String((resorts.hotels[hotel] || {}).siteID);
  const rooms = (live[siteID] || []).map(([roomID, roomName]) => ({ roomID, roomName }));
  const hint = { type: u.room_type, occMin: u.occ_min, occMax: u.occ_max, hotel, party };
  return sr.match(rooms, room, hint) || sr.idFor(siteID, '', '', room);
};

let checked = 0, viaParty = 0;
const wrong = [];
for (const [hotel, rooms] of Object.entries(expected)) {
  if (hotel.startsWith('_')) continue;
  for (const [room, want] of Object.entries(rooms)) {
    if (room.startsWith('_')) continue;
    checked++;
    if (want && typeof want === 'object') {
      viaParty++;
      for (const [party, id] of Object.entries(want)) {
        const got = resolve(hotel, room, Number(party));
        if (got !== id) wrong.push(`${hotel} · ${room} · ${party} אנשים → ${got}, expected ${id}`);
      }
      // and with nobody counted, a room sold by party size must NOT be guessed
      const blind = resolve(hotel, room, null);
      if (blind) wrong.push(`${hotel} · ${room} · chose ${blind} without knowing the party`);
    } else {
      const u = unitFor.get(hotel + '|' + room);
      const got = resolve(hotel, room, u.occ_max || u.occ_min || null);
      if (got !== want) wrong.push(`${hotel} · ${room} → ${got}, expected ${want}`);
    }
  }
}

t(`all ${checked} rooms in the workbook resolve to the room the customer was shown`, () => {
  assert.deepStrictEqual(wrong, []);
});
t('every hotel we hold rooms for is covered by the corpus', () => {
  const hotels = new Set(units.map(u => u.hotel));
  const missing = [...hotels].filter(h => !expected[h]);
  assert.deepStrictEqual(missing, [], 'no captured room list for: ' + missing.join(', '));
});
t('a room the site sells by party size is never chosen blind', () => {
  assert.ok(viaParty >= 1, 'the Plein Sud split disappeared from the corpus');
});
t('nothing resolves to a room id the site did not actually list', () => {
  const bad = [];
  for (const [hotel, rooms] of Object.entries(expected)) {
    if (hotel.startsWith('_')) continue;
    const ids = new Set((live[String((resorts.hotels[hotel] || {}).siteID)] || []).map(([id]) => id));
    for (const [room, want] of Object.entries(rooms)) {
      if (room.startsWith('_')) continue;
      for (const id of (want && typeof want === 'object') ? Object.values(want) : [want]) {
        if (id && !ids.has(id)) bad.push(`${hotel} · ${room} → ${id}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

console.log(`room-match: ${pass} passed, ${fail} failed  (${checked} חדרים)`);
process.exit(fail ? 1 : 0);
