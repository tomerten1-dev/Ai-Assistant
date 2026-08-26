'use strict';
/* The room matcher that runs in the CUSTOMER'S browser.
   
   It is a second copy of the one in server/site-rooms.js, because the script
   that fills Pingwin's booking form has to be a single self-contained file for
   Google Tag Manager — it cannot require anything. Two copies drift, and a
   drift here means the room the customer was shown is not the room the form
   opens on. So this test executes the browser copy, out of its own source, over
   the same corpus of real room lists, and fails on any disagreement.

   Run: node tests/test-prefill-match.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sr = require('../server/site-rooms.js');
const resorts = require('../data/resorts.json');
const units = require('../data/availability.json').units || [];
const live = require('./fixtures/site-rooms-live.json');
const { pageFor } = require('../config/booking-url.js');
const expected = require('./fixtures/site-rooms-expected.json');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// lift the matcher out of the browser file and run it for real
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'pingwin-prefill.js'), 'utf8');
const from = src.indexOf('  function norm(s) {');
const to = src.indexOf('  function waitForRooms() {');
assert.ok(from > 0 && to > from, 'the matcher moved — update the slice in this test');
const sandbox = { q: {}, module: {} };
vm.runInNewContext(src.slice(from, to) +
  '\nmodule.exports = { byDescription: byDescription, tokens: tokens, occOf: occOf, sizeOf: sizeOf };',
  sandbox, { filename: 'pingwin-prefill.js (matcher)' });
const browser = sandbox.module.exports;

// the browser sees option elements; it only ever reads .textContent and .value
const asOptions = pairs => pairs.map(([value, textContent]) => ({ value, textContent }));
// the browser is already ON a page, so it is handed that page's option list
const askBrowser = (siteID, room, party) => {
  sandbox.q = party ? { ad: String(party) } : {};
  return browser.byDescription(asOptions(live[String(siteID)] || []), room) || null;
};
const pageOf = (hotel, nights) => String(pageFor(resorts.hotels[hotel] || {}, nights).siteID);

const unitFor = new Map();
for (const u of units) if (!unitFor.has(u.hotel + '|' + u.room)) unitFor.set(u.hotel + '|' + u.room, u);

t('the browser reads a room name exactly the way the server does', () => {
  const differ = [];
  for (const [hotel, rooms] of Object.entries(expected)) {
    if (hotel.startsWith('_')) continue;
    for (const room of Object.keys(rooms)) {
      if (room.startsWith('_')) continue;
      const a = [...sr.tokens(room)].sort().join(' ');
      const b = [...browser.tokens(room)].sort().join(' ');
      if (a !== b) differ.push(`${room}: server [${a}] browser [${b}]`);
      const so = sr.occOf(room), bo = browser.occOf(room);
      if (JSON.stringify(so && [so.min, so.max]) !== JSON.stringify(bo && [bo.min, bo.max])) {
        differ.push(`${room}: occupancy read differently`);
      }
      const ss = sr.sizeOf(room), bs = browser.sizeOf(room);
      if ((ss && ss.m2) !== (bs && bs.m2)) differ.push(`${room}: floor area read differently`);
    }
  }
  assert.deepStrictEqual(differ, []);
});

// The browser knows less than the server: the link carries the room name and
// the party, not the workbook's room_type column and not which of two hotels
// sharing a siteID this page is. So it is allowed to resolve FEWER rooms —
// never a different one.
const wrong = [];
let resolved = 0, total = 0;
for (const [hotel, rooms] of Object.entries(expected)) {
  if (hotel.startsWith('_')) continue;
  for (const [room, want] of Object.entries(rooms)) {
    if (room.startsWith('_')) continue;
    const u = unitFor.get(hotel + '|' + room);
    const party = u.occ_max || u.occ_min || null;
    // every (page, party) the customer can actually arrive with
    const cases = want && want.by_nights
      ? Object.entries(want.by_nights).map(([n, x]) => [x.siteID, party, x.room_id, n + ' לילות'])
      : want && typeof want === 'object'
        ? Object.entries(want.party).map(([p, id]) => [pageOf(hotel, u.nights), Number(p), id, p + ' אנשים'])
        : [[pageOf(hotel, u.nights), party, want, '']];
    for (const [site, p, id, label] of cases) {
      total++;
      const got = askBrowser(site, room, p);
      if (got) resolved++;
      if (got && got !== id) wrong.push(`${hotel} · ${room} ${label} → ${got}, השרת אומר ${id}`);
    }
  }
}

t('and never picks a different room from the one the server picked', () => {
  assert.deepStrictEqual(wrong, []);
});
t('it still fills most of them on its own, without the id from the server', () => {
  // not a target to chase — a floor, so a rewrite that quietly breaks the
  // browser copy is noticed. The server's id is the real path.
  assert.ok(resolved / total > 0.6, `only ${resolved}/${total}`);
});

console.log(`prefill-match: ${pass} passed, ${fail} failed  ` +
  `(הדפדפן לבדו: ${resolved}/${total})`);
process.exit(fail ? 1 : 0);
