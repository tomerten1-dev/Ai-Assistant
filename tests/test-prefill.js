'use strict';
/* The booking-form prefill, in a real browser, against a page that behaves the
   way pingwin.co.il's does (tests/fixtures/mock-hotel.html — same ids, same
   global, same timing: the room list only arrives after the dates are set).

   Run: npm run test:prefill   (needs playwright; skipped if absent)

   What this pins is the promise the customer is given by the "המשך להזמנה"
   button: their dates and party are already in the form. And the promise made
   to Pingwin: on any ordinary page view this script does nothing at all. */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('prefill: skipped (playwright not installed)'); process.exit(0); }

const PORT = 8804;
const ROOT = path.join(__dirname, '..');
const FILES = {
  '/': path.join(__dirname, 'fixtures', 'mock-hotel.html'),
  '/pingwin-prefill.js': path.join(ROOT, 'public', 'pingwin-prefill.js'),
};

(async () => {
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.error('  ✗ ' + name + '\n      ' + e.message); } };

  const srv = http.createServer((req, res) => {
    const file = FILES[req.url.split('?')[0]];
    if (!file) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  }).listen(PORT);

  const browser = await chromium.launch();
  const errors = [];
  const open = async query => {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);   // instance appears at 400ms, rooms at +250ms
    return page;
  };
  const read = page => page.evaluate(`(() => ({
    from: document.getElementById('orderFrom').value,
    till: document.getElementById('orderTill').value,
    room: document.querySelector('#roomsBlock select.roomSelect').value,
    adults: document.querySelector('#roomsBlock .travels select').value,
    pans: document.querySelector('#roomsBlock select.panSelect').value,
    note: (document.getElementById('pw-prefill-note') || {}).textContent || null,
    calls: window.__calls.map(c => c[0]),
  }))()`);

  try {
    // 1 · the whole thing, the way the widget builds it
    let p = await open('?siteID=1288&tab=20&pwfrom=30.01.2027&pwtill=06.02.2027&pwad=3&pwroom=' +
      encodeURIComponent('2 ח"ש וסלון 2-4 אורחים') + '&pwpans=1');
    let r = await read(p);
    t('the dates the customer chose in the chat are in the form', () => {
      assert.strictEqual(r.from, '30.01.2027');
      assert.strictEqual(r.till, '06.02.2027');
    });
    t('so are the room, the party and the board', () => {
      assert.strictEqual(r.room, '811', 'the room was not matched by name');
      assert.strictEqual(r.adults, '3');
      assert.strictEqual(r.pans, '1');
    });
    t('and the customer is told why the form is already filled', () => {
      assert.ok(/מולאו/.test(r.note || ''), 'no explanation: ' + r.note);
      assert.ok(/לשנות/.test(r.note || ''), 'does not say it can be changed');
    });
    await p.close();

    // 2 · the quote is produced, once everything is really in
    p = await open('?siteID=1288&tab=20&pwfrom=30.01.2027&pwtill=06.02.2027&pwad=3&pwroom=' +
      encodeURIComponent('2 ח"ש וסלון 2-4 אורחים') + '&pwpans=1&pwquote=1');
    await p.waitForTimeout(800);
    r = await read(p);
    t('with pwquote=1 the quote button is pressed for the customer, once', () => {
      const clicks = r.calls.filter(c => c === 'click:prop');
      assert.strictEqual(clicks.length, 1, 'clicks: ' + JSON.stringify(r.calls));
      assert.ok(!r.calls.includes('click:order'), 'pressed the BOOKING button, which holds a credit card');
      assert.ok(/הצעת המחיר מופקת/.test(r.note || ''), 'the customer is not told what happened: ' + r.note);
    });
    await p.close();

    // 3 · the id from the booking engine beats any name matching
    p = await open('?siteID=1288&pwfrom=30.01.2027&pwtill=06.02.2027&pwad=3&pwroomid=813&pwroom=' +
      encodeURIComponent('שם שגוי לגמרי'));
    r = await read(p);
    t('the site\'s own room id is used when we have it', () => {
      assert.strictEqual(r.room, '813', 'the id was ignored in favour of a name that cannot match');
    });
    await p.close();

    // …and an id the list does not contain is not forced in
    p = await open('?siteID=1288&pwfrom=30.01.2027&pwtill=06.02.2027&pwad=3&pwroomid=999999');
    r = await read(p);
    t('a stale id selects nothing rather than the wrong room', () => {
      assert.strictEqual(r.room, '0');
    });
    await p.close();

    // 4 · a room name the site spells differently — dates still land
    p = await open('?siteID=1288&pwfrom=09.01.2027&pwtill=16.01.2027&pwad=2&pwroom=' +
      encodeURIComponent('CONN Premium with View 5 pax'));
    r = await read(p);
    t('a room we cannot match is left to the customer, and never guessed', () => {
      assert.strictEqual(r.room, '0', 'picked a room it could not identify: ' + r.room);
      assert.strictEqual(r.from, '09.01.2027', 'gave up on the dates too');
      assert.strictEqual(r.adults, '2', 'the party was dropped with the room');
      assert.ok(/סוג החדר אפשר לבחור/.test(r.note || ''), r.note);
    });
    await p.close();

    // and the quote is NOT produced off a half-filled form
    p = await open('?siteID=1288&pwfrom=09.01.2027&pwtill=16.01.2027&pwad=2&pwquote=1&pwroom=' +
      encodeURIComponent('CONN Premium with View 5 pax'));
    await p.waitForTimeout(800);
    r = await read(p);
    t('no room, no quote — the customer is never sent a price for the wrong room', () => {
      assert.ok(!r.calls.some(c => c.startsWith('click:')), JSON.stringify(r.calls));
    });
    await p.close();

    // 4b · the same room, spelled by two systems that share no words
    p = await open('?siteID=1288&pwfrom=20.02.2027&pwtill=27.02.2027&pwad=5&pwroom=' +
      encodeURIComponent('CONN Premium with View 5 pax'));
    r = await read(p);
    t('a room described differently on each side is still matched', () => {
      assert.strictEqual(r.room, '5588', 'ours "…with View 5 pax" vs theirs "…with View 4-5 pax"');
    });
    await p.close();

    p = await open('?siteID=1288&pwfrom=20.02.2027&pwtill=27.02.2027&pwad=5&pwroom=' +
      encodeURIComponent('Premium Amazing View 5 pax'));
    r = await read(p);
    t('and its neighbour, one word apart, is not confused with it', () => {
      assert.strictEqual(r.room, '5582');
    });
    await p.close();

    p = await open('?siteID=1288&pwfrom=20.02.2027&pwtill=27.02.2027&pwad=5&pwroom=' +
      encodeURIComponent('Premium 5 pax'));
    r = await read(p);
    t('a description that fits both rooms picks neither', () => {
      assert.strictEqual(r.room, '0', 'guessed between two Premium rooms: ' + r.room);
    });
    await p.close();

    // 4c · one room name, two products, told apart by who is travelling
    const plein = n => '?siteID=1288&pwfrom=13.03.2027&pwtill=20.03.2027&pwad=' + n +
      '&pwroom=' + encodeURIComponent('2 bedroom apt 4-5 pax');
    p = await open(plein(5));
    r = await read(p);
    t('five travellers get the room the site sells to five', () => {
      assert.strictEqual(r.room, '3721', 'ours "4-5 pax" → theirs "5 אורחים"');
    });
    await p.close();

    p = await open(plein(4));
    r = await read(p);
    t('four travellers get the other one, at the other price', () => {
      assert.strictEqual(r.room, '2882', 'ours "4-5 pax" → theirs "2-4 אורחים"');
    });
    await p.close();

    // 5 · the promise to Pingwin: an ordinary visitor sees nothing
    p = await open('?siteID=1288&tab=20');
    r = await read(p);
    t('on an ordinary page view it does nothing at all', () => {
      assert.strictEqual(r.from, '');
      assert.strictEqual(r.room, '0');
      assert.strictEqual(r.note, null);
      assert.deepStrictEqual(r.calls, [], 'it touched the booking form uninvited');
    });
    await p.close();

    // 6 · a broken link must not break their page
    p = await open('?siteID=1288&pwfrom=נונסנס&pwtill=06.02.2027&pwad=3');
    r = await read(p);
    t('a malformed date is ignored rather than typed into the form', () => {
      assert.strictEqual(r.from, '');
      assert.deepStrictEqual(r.calls, []);
    });
    await p.close();

    t('no page errors anywhere', () => assert.deepStrictEqual(errors, []));
  } finally {
    await browser.close(); srv.close();
  }
  console.log(`prefill: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
