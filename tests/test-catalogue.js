'use strict';
// The hotel catalogue: every hotel Pingwin sells, including the ones with no
// rooms in the commitments workbook.
//
// The rule this pins (Tomer, 26/08): a catalogue hotel may be NAMED and handed
// to a rep. It may never be offered — no date, no room, no price, no card.
// Run: node tests/test-catalogue.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = '';

const assert = require('assert');
const catalogue = require('../server/catalogue.js');
const offline = require('../server/offline-nlu.js');
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const all = catalogue.hotels();

t('the catalogue is loaded and complete-looking', () => {
  assert.ok(all.length >= 100, 'only ' + all.length + ' hotels');
  for (const h of all) {
    assert.ok(h.name && h.siteID && h.resort && h.country, 'incomplete row: ' + JSON.stringify(h));
    assert.ok(h.page.includes('pingwin.co.il'), 'not a pingwin page: ' + h.page);
  }
  assert.ok(new Set(all.map(h => h.resort)).size >= 20, 'too few resorts');
});

t('Club Med and the private chalets are out, as Tomer asked', () => {
  for (const h of all) {
    assert.ok(!/club ?med/i.test(h.name), 'Club Med in the catalogue: ' + h.name);
    // "Chalet Hôtel Kaya" in Les Menuires is a hotel, not a private chalet —
    // what Tomer excluded is the whole-house rentals ("12 אורחים, לינה בלבד")
    assert.ok(!/^chalet\s+(?!hotel)/i.test(h.name), 'a private chalet in the catalogue: ' + h.name);
  }
});

t('every hotel in the commitments workbook has a catalogue row', () => {
  const units = require('../data/availability.json').units || [];
  const workbook = [...new Set(units.map(u => u.hotel))];
  const covered = new Set(all.flatMap(h => h.commitment_names || []));
  const missing = workbook.filter(w => !covered.has(w));
  assert.deepStrictEqual(missing, [], 'workbook hotels with no catalogue row: ' + missing.join(', '));
});

t('the resorts that had no hotels at all now have them', () => {
  for (const [he, least] of [['סנט אנטון', 2], ['זאלבאך', 5], ['צל אם זה', 5], ["ואל ד'יזר", 3], ['לה פלאן', 3]]) {
    const there = catalogue.inResortHe(he);
    assert.ok(there.length >= least, `${he}: ${there.length} hotels`);
    assert.ok(there.every(h => !h.commitment), he + ' should be catalogue-only');
  }
});

t('a hotel we hold rooms for belongs to the search, not to the catalogue answer', () => {
  assert.strictEqual(offline.catalogueHotelLine('מה עם Hotel Ferienhof?'), null);
  assert.strictEqual(offline.catalogueHotelLine('זוג בפברואר'), null);
  assert.strictEqual(offline.catalogueHotelLine('מלון 4 כוכבים'), null);
});

t('a hotel we sell but hold no rooms for is confirmed, and handed to a person', () => {
  const line = offline.catalogueHotelLine('יש לכם את Alpin Resort?');
  assert.ok(line && /Alpin Resort/.test(line), line);
  assert.ok(/זאלבאך/.test(line), 'the resort is named: ' + line);
  assert.ok(/נציג/.test(line), 'handed to a person: ' + line);
  assert.ok(!/₪|€|\$|יורו/.test(line), 'money: ' + line);
  assert.ok(!/\d{1,2}\.\d{1,2}/.test(line), 'quoted a date: ' + line);
});

(async () => {
  const r1 = await handleChat({ messages: [{ role: 'user', content: 'שני אנשים סן אנטון, ינואר' }], slots: {} });
  t('"סן אנטון" is answered about St. Anton, with the hotels we work with there', () => {
    assert.ok(/סנט אנטון/.test(r1.reply_he), 'the resort is not even named: ' + r1.reply_he);
    assert.ok(/Karl Schranz/.test(r1.reply_he), 'no hotel named: ' + r1.reply_he);
    // the offers underneath are the ones we really hold — never St. Anton
    assert.ok(!r1.cards.some(c => /Schranz|Nassereinerhof/.test(c.hotel)), 'offered a hotel we hold no rooms for');
  });
  const r2 = await handleChat({ messages: [{ role: 'user', content: 'יש לכם את Alpin Resort?' }], slots: {} });
  t('a catalogue hotel never turns into a card', () => {
    assert.ok(/Alpin Resort/.test(r2.reply_he), r2.reply_he);
    assert.ok(!r2.cards.some(c => /Alpin/.test(c.hotel)), 'a catalogue hotel became an offer');
    assert.ok(!/\d[\d,.]*\s*(₪|€|יורו)/.test(r2.reply_he), 'money in the reply');
  });
  console.log('\ncatalogue: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
