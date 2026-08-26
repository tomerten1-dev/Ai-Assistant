'use strict';
// The link behind "המשך להזמנה" — the only click in this product that leads to
// money. It used to land on a blank hotel page and make the customer type
// their dates, party and room again. Now it carries them.
//
// The rule these tests pin: a value we are not certain about is LEFT OUT.
// A wrong prefill is worse than an empty field — it books the wrong room.
// Run: node tests/test-booking-url.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = '';

const assert = require('assert');
const b = require('../config/booking-url.js');
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}
const INFO = { page: 'Plein+Sud.html', siteID: 1288 };
const parse = url => Object.fromEntries(new URL(url).searchParams.entries());

t('dates arrive in the format the site\'s own datepicker uses', () => {
  assert.strictEqual(b.ddmmyyyy('2027-01-30'), '30.01.2027');
  assert.strictEqual(b.ddmmyyyy('2026-12-05'), '05.12.2026');
  assert.strictEqual(b.ddmmyyyy('nonsense'), null);
});
t('the return date is the departure plus the nights, across a month and a year', () => {
  assert.strictEqual(b.addNights('2027-01-30', 7), '2027-02-06');
  assert.strictEqual(b.addNights('2026-12-26', 7), '2027-01-02');
  assert.strictEqual(b.addNights('2027-01-30', 0), null);
});
t('the whole link: hotel, dates, party and room', () => {
  const url = b.deepLink(INFO, { date: '2027-01-30', nights: 7, room: '2 ח"ש וסלון 2-4 אורחים', board_he: 'לינה בלבד' },
    { adults: 3, children_ages: [] });
  assert.ok(url.startsWith('https://www.pingwin.co.il/Plein+Sud.html?siteID=1288&'), url);
  const q = parse(url);
  assert.strictEqual(q.pwfrom, '30.01.2027');
  assert.strictEqual(q.pwtill, '06.02.2027');
  assert.strictEqual(q.pwad, '3');
  assert.strictEqual(q.pwroom, '2 ח"ש וסלון 2-4 אורחים');
  assert.strictEqual(q.pwpans, '1', 'לינה בלבד is board code 1');
  assert.ok(!('pwkids' in q), 'no children — no parameter');
  assert.strictEqual(q.pwquote, '1', 'the quote is produced for the customer');
});
t('children travel as ages, because that is what the form asks for', () => {
  const q = parse(b.deepLink(INFO, { date: '2027-01-09', nights: 7 }, { adults: 2, children_ages: [5, 9] }));
  assert.strictEqual(q.pwkids, '5,9');
  assert.strictEqual(q.pwad, '2');
});
t('an ambiguous board is not guessed', () => {
  assert.strictEqual(b.pansionCode('ארוחת בוקר או חצי פנסיון'), null);
  assert.strictEqual(b.pansionCode('חצי פנסיון'), 3);
  assert.strictEqual(b.pansionCode(''), null);
  const q = parse(b.deepLink(INFO, { date: '2027-01-09', nights: 7, board_he: 'ארוחת בוקר או חצי פנסיון' }, {}));
  assert.ok(!('pwpans' in q), 'guessed a board the offer did not commit to');
});
t('without dates the link still lands on the right hotel', () => {
  assert.strictEqual(b.deepLink(INFO, { date: null, nights: 7 }, {}),
    'https://www.pingwin.co.il/Plein+Sud.html?siteID=1288');
  assert.strictEqual(b.deepLink({}, { date: '2027-01-09', nights: 7 }, {}), null);
});
t('our parameters stay in our own namespace, so the site never collides with them', () => {
  const q = parse(b.deepLink(INFO, { date: '2027-01-09', nights: 7, room: 'x' }, { adults: 2 }));
  for (const k of Object.keys(q)) {
    assert.ok(k === 'siteID' || k.startsWith('pw'), 'stray parameter: ' + k);
  }
});
t('a stay shorter than a week goes to the page that sells one', () => {
  // Casa Karina is the only hotel with a second booking page. Asking the
  // ordinary one about 3 nights returns no rooms at all — npm run rooms proved
  // it — so the customer would land on a page that cannot price their holiday.
  const ck = require('../data/resorts.json').hotels['Casa Karina'];
  assert.strictEqual(b.pageFor(ck, 3).siteID, 1445);
  assert.strictEqual(b.pageFor(ck, 6).siteID, 1445);
  assert.strictEqual(b.pageFor(ck, 7).siteID, 1435, 'a full week belongs on the ordinary page');
  assert.strictEqual(b.pageFor(ck, null).siteID, 1435, 'no nights, no swap');
  const short = parse(b.deepLink(ck, { date: '2027-01-07', nights: 3 }, { adults: 2 }));
  assert.strictEqual(short.siteID, '1445');
  assert.ok(b.deepLink(ck, { date: '2027-01-07', nights: 3 }, {}).includes('Short+Stay'));
  const week = parse(b.deepLink(ck, { date: '2027-01-15', nights: 7 }, { adults: 2 }));
  assert.strictEqual(week.siteID, '1435');
});
t('and it is that hotel\'s property, not a rule about short stays', () => {
  // Regnum and Vihren sell 3-night stays on their own page — the live run got
  // full room lists from both. Sending them somewhere else would break them.
  const hotels = require('../data/resorts.json').hotels;
  for (const name of ['Regnum', 'Vihren']) {
    assert.strictEqual(b.pageFor(hotels[name], 3).siteID, hotels[name].siteID, name);
  }
  const withAlt = Object.entries(hotels).filter(([, h]) => h.short_stay).map(([n]) => n);
  assert.deepStrictEqual(withAlt, ['Casa Karina'], 'a second hotel grew a short-stay page: ' + withAlt);
});
t('the short-stay page is never offered as a hotel of its own', () => {
  const cat = require('../server/catalogue.js');
  const named = cat.hotels().map(h => h.name);
  assert.ok(!named.includes('Casa Karina Short Stay'), 'listed as a separate hotel in Bansko');
  assert.ok(named.includes('Casa Karina'));
  assert.ok(cat.allPages().some(h => h.siteID === 1445), 'the page itself was lost');
});
t('the companion script is shipped, and is inert without our parameters', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'pingwin-prefill.js'), 'utf8');
  assert.ok(/__pwPrefillRan/.test(src), 'nothing stops it running twice under GTM');
  assert.ok(/if \(!q\.from \|\| !q\.till\) return;/.test(src), 'it must do nothing on an ordinary page view');
  assert.ok(/orderMan/.test(src) && /setDates/.test(src) && /loadRoom/.test(src));
  assert.ok(/catch/.test(src), 'it must never be able to break Pingwin\'s own page');
});

(async () => {
  const r = await handleChat({ messages: [{ role: 'user', content: '3 מבוגרים בפברואר' }], slots: {} });
  t('every offer the customer sees carries a prefilled link', () => {
    assert.ok(r.cards.length, 'no offers to check');
    for (const c of r.cards) {
      assert.ok(c.booking_url && c.booking_url.startsWith('https://www.pingwin.co.il/'), c.booking_url);
      const q = parse(c.booking_url);
      assert.ok(q.siteID, 'no hotel id: ' + c.booking_url);
      assert.strictEqual(q.pwfrom, b.ddmmyyyy(c.date), 'the link and the card disagree about the date');
      assert.strictEqual(q.pwtill, b.ddmmyyyy(b.addNights(c.date, c.nights)));
      assert.strictEqual(q.pwad, '3', 'the party the customer stated did not travel with them');
    }
  });
  console.log(`booking-url: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
