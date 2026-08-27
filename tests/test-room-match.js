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
const { pageFor } = require('../config/booking-url.js');
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
const resolve = (hotel, room, party, nights) => {
  const u = unitFor.get(hotel + '|' + room);
  // the page that sells THIS stay, exactly as server.js picks it
  const info = pageFor(resorts.hotels[hotel] || {}, nights || (u && u.nights));
  const siteID = String(info.siteID);
  const rooms = (live[siteID] || []).map(([roomID, roomName]) => ({ roomID, roomName }));
  const hint = { type: u.room_type, occMin: u.occ_min, occMax: u.occ_max, hotel, party };
  return { siteID, id: sr.match(rooms, room, hint) || sr.idFor(siteID, '', '', room) };
};

let checked = 0, byParty = 0, byNights = 0;
const wrong = [];
for (const [hotel, rooms] of Object.entries(expected)) {
  if (hotel.startsWith('_')) continue;
  for (const [room, want] of Object.entries(rooms)) {
    if (room.startsWith('_')) continue;
    checked++;
    const u = unitFor.get(hotel + '|' + room);
    const party = u.occ_max || u.occ_min || null;

    if (want && want.by_nights) {
      // the same room on two booking pages — the length of the stay picks both
      // the page and the id, and they must agree or the customer lands on a
      // page where the room we selected does not exist
      byNights++;
      for (const [nights, exp] of Object.entries(want.by_nights)) {
        const got = resolve(hotel, room, party, Number(nights));
        if (got.siteID !== exp.siteID) {
          wrong.push(`${hotel} · ${room} · ${nights} לילות → page ${got.siteID}, expected ${exp.siteID}`);
        }
        if (got.id !== exp.room_id) {
          wrong.push(`${hotel} · ${room} · ${nights} לילות → ${got.id}, expected ${exp.room_id}`);
        }
      }
    } else if (want && typeof want === 'object') {
      byParty++;
      for (const [p, id] of Object.entries(want.party)) {
        const got = resolve(hotel, room, Number(p));
        if (got.id !== id) wrong.push(`${hotel} · ${room} · ${p} אנשים → ${got.id}, expected ${id}`);
      }
      const blind = resolve(hotel, room, null);
      if (blind.id) wrong.push(`${hotel} · ${room} · chose ${blind.id} without knowing the party`);
    } else {
      const got = resolve(hotel, room, party);
      if (got.id !== want) wrong.push(`${hotel} · ${room} → ${got.id}, expected ${want}`);
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
  assert.ok(byParty >= 1, 'the Plein Sud split disappeared from the corpus');
});
t('a hotel with two booking pages is still covered on both', () => {
  assert.ok(byNights >= 1, 'the Casa Karina short-stay page disappeared from the corpus');
  // and the id really is different, which is the whole point
  const ck = expected['Casa Karina']['Standard 2-3'].by_nights;
  assert.notStrictEqual(ck['3'].room_id, ck['7'].room_id,
    'if the two pages shared an id this test would prove nothing');
});
t('nothing resolves to a room id the site did not actually list', () => {
  const bad = [];
  for (const [hotel, rooms] of Object.entries(expected)) {
    if (hotel.startsWith('_')) continue;
    for (const [room, want] of Object.entries(rooms)) {
      if (room.startsWith('_')) continue;
      const u = unitFor.get(hotel + '|' + room);
      const pairs = want && want.by_nights
        ? Object.values(want.by_nights).map(x => [x.siteID, x.room_id])
        : (want && typeof want === 'object' ? Object.values(want.party) : [want])
            .map(id => [String(pageFor(resorts.hotels[hotel] || {}, u.nights).siteID), id]);
      for (const [site, id] of pairs) {
        const ids = new Set((live[site] || []).map(([x]) => x));
        if (id && !ids.has(id)) bad.push(`${hotel} · ${room} → ${id} (siteID ${site})`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});

console.log(`room-match: ${pass} passed, ${fail} failed  (${checked} חדרים)`);
process.exit(fail ? 1 : 0);
