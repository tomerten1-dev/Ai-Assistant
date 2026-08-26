'use strict';
// Asking pingwin.co.il's booking engine for its own room ids.
//
// The rule: this may improve a link, and may never delay a reply or select the
// wrong room. Every test here is about one of those two.
// Run: node tests/test-site-rooms.js
process.env.CHAT_LOG = 'off';
process.env.SITE_ROOMS_BASE = 'https://example.test';

const assert = require('assert');
const sr = require('../server/site-rooms.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + name); },
    e => { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); });
}
const clear = () => { const c = sr._cache(); for (const k of Object.keys(c)) delete c[k]; };
const ROOMS = { rooms: [
  { roomID: 811, roomName: '2 ח"ש וסלון 2-4 אורחים', showOrder: 1 },
  { roomID: 812, roomName: 'סטודיו 2-3 אורחים', showOrder: 2 },
  { roomID: 813, roomName: '1 bdrm apt 2-4 pax', showOrder: 3 },
] };
const okFetch = (seen) => async (url) => {
  if (seen) seen.push(url);
  return { ok: true, status: 200, json: async () => ROOMS };
};

(async () => {
  await t('it asks the same question the site\'s own form asks', async () => {
    const seen = [];
    const rooms = await sr.fetchRooms(1288, '2027-01-30', '2027-02-06', { fetch: okFetch(seen) });
    assert.strictEqual(seen.length, 1);
    const u = new URL(seen[0]);
    assert.strictEqual(u.pathname, '/ajax_order_odyssea.php');
    assert.strictEqual(u.searchParams.get('act'), 'roomList');
    assert.strictEqual(u.searchParams.get('sid'), '1288');
    assert.strictEqual(u.searchParams.get('from'), '2027-01-30', 'the engine wants yyyy-mm-dd');
    assert.strictEqual(u.searchParams.get('till'), '2027-02-06');
    assert.strictEqual(rooms.length, 3);
    assert.deepStrictEqual(rooms[0], { roomID: '811', roomName: '2 ח"ש וסלון 2-4 אורחים' });
  });

  await t('a response keyed by id parses the same as a list', async () => {
    const keyed = { rooms: { 811: { roomID: 811, roomName: 'A' }, 812: { roomID: 812, roomName: 'B' } } };
    const rooms = await sr.fetchRooms(1, '2027-01-30', '2027-02-06',
      { fetch: async () => ({ ok: true, json: async () => keyed }) });
    assert.deepStrictEqual(rooms.map(r => r.roomID), ['811', '812']);
  });

  await t('a cold cache costs the customer nothing — no id, no waiting', () => {
    const started = Date.now();
    const id = sr.idFor(1288, '2027-01-30', '2027-02-06', 'anything', { fetch: okFetch() });
    assert.strictEqual(id, null);
    assert.ok(Date.now() - started < 50, 'idFor blocked while it fetched');
  });

  await t('once warm, our room name resolves to the site\'s own id', async () => {
    await sr.warm(1289, '2027-01-30', '2027-02-06', { fetch: okFetch() });
    assert.strictEqual(sr.idFor(1289, '2027-01-30', '2027-02-06', '1 bdrm apt 2-4 pax'), '813');
    assert.strictEqual(sr.idFor(1289, '2027-01-30', '2027-02-06', '2 ח"ש וסלון 2-4 אורחים'), '811');
    // and a near-miss in spelling still lands
    assert.strictEqual(sr.idFor(1289, '2027-01-30', '2027-02-06', '1 BDRM APT 2-4 PAX'), '813');
  });

  await t('two candidates, or none, means no room is chosen', async () => {
    await sr.warm(2, '2027-01-30', '2027-02-06', {
      fetch: async () => ({ ok: true, json: async () => ({ rooms: [
        { roomID: 1, roomName: 'Standard Plus' }, { roomID: 2, roomName: 'Standard Deluxe' }] }) }),
    });
    // "Standard" sits inside both names — that is exactly when we must not choose
    assert.strictEqual(sr.idFor(2, '2027-01-30', '2027-02-06', 'Standard'), null, 'picked one of two');
    assert.strictEqual(sr.idFor(2, '2027-01-30', '2027-02-06', 'Penthouse'), null);
    // an exact name, though, is not ambiguous at all
    assert.strictEqual(sr.idFor(2, '2027-01-30', '2027-02-06', 'Standard Deluxe'), '2');
  });

  await t('a hotel the site refuses to answer about is not asked again immediately', async () => {
    clear();
    let calls = 0;
    const bad = async () => { calls++; return { ok: false, status: 403 }; };
    await sr.warm(3, '2027-01-30', '2027-02-06', { fetch: bad });
    sr.idFor(3, '2027-01-30', '2027-02-06', 'x', { fetch: bad });
    sr.idFor(3, '2027-01-30', '2027-02-06', 'x', { fetch: bad });
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(calls, 1, 'hammered a site that said no: ' + calls);
  });

  await t('the manual bridge wins, for the rooms whose names will never match', () => {
    clear();
    const map = require.resolve('../config/room-map.json');
    const before = require.cache[map];
    require.cache[map] = { id: map, filename: map, loaded: true, exports: { 1288: { 'CONN Premium with View 5 pax': '999' } } };
    delete require.cache[require.resolve('../server/site-rooms.js')];
    const fresh = require('../server/site-rooms.js');
    assert.strictEqual(fresh.idFor(1288, '2027-01-30', '2027-02-06', 'CONN Premium with View 5 pax'), '999');
    if (before) require.cache[map] = before; else delete require.cache[map];
  });

  await t('SITE_ROOMS=off turns the whole thing into nothing', () => {
    process.env.SITE_ROOMS = 'off';
    assert.strictEqual(sr.enabled(), false);
    assert.strictEqual(sr.idFor(1288, '2027-01-30', '2027-02-06', '1 bdrm apt 2-4 pax'), null);
    delete process.env.SITE_ROOMS;
  });

  console.log(`site-rooms: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
