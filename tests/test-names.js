'use strict';
/* What a customer is allowed to call things, and what we call them back.
 *
 * Both halves come from the same day (Tomer, 27/08): the bot did not know
 * "קלאב דו סוליי" was four of our hotels, and the card said TIGNES in Latin
 * beside a Hebrew sentence — with two different Hebrew spellings of the same
 * resort living in two different files.
 * Run: node tests/test-names.js
 */
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = ''; process.env.SITE_ROOMS = 'off';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resortHe, all } = require('../data/resort-names.js');
const offline = require('../server/offline-nlu.js');
const resorts = require('../data/resorts.json');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

// ── resort names ──────────────────────────────────────────────────────────
t('every resort we sell has a Hebrew name', () => {
  const used = new Set(Object.values(resorts.hotels).map(h => h.resort).filter(Boolean));
  const missing = [...used].filter(r => resortHe(r) === r);
  assert.deepStrictEqual(missing, [], 'no Hebrew for: ' + missing.join(', '));
});
t('the ones Tomer corrected are the ones we use', () => {
  assert.strictEqual(resortHe('Tignes'), 'טין');            // not טיניי
  assert.strictEqual(resortHe('Les 2 Alpes'), 'לה דוז אלפ'); // not לה דו אלפ
});
t('and the table is written down exactly once', () => {
  // it lived in three files with three spellings; a fourth copy is how that
  // comes back
  const copies = [];
  for (const f of ['server/prompt-phrase.js', 'server/server.js', 'tools/build-catalogue.js',
                   'server/prompt-answer.js', 'server/offline-nlu.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    // a Latin resort name mapped to a Hebrew string, anywhere
    if (/['"][A-Z][A-Za-z' .]+['"]\s*:\s*['"][\u0590-\u05FF]/.test(src)) copies.push(f);
  }
  assert.deepStrictEqual(copies, [], 'a second Hebrew resort table in: ' + copies.join(', '));
});
t('an unknown resort keeps its own name rather than going blank', () => {
  assert.strictEqual(resortHe('Nowhere'), 'Nowhere');
  assert.strictEqual(resortHe(''), '');
  assert.strictEqual(resortHe(null), null);
});

// ── hotel chains ──────────────────────────────────────────────────────────
t('the chains name hotels we actually hold rooms for', () => {
  for (const g of offline.hotelGroups()) {
    const unknown = g.hotels.filter(h => !resorts.hotels[h]);
    assert.deepStrictEqual(unknown, [], g.id + ' names hotels we do not have: ' + unknown.join(', '));
    assert.ok(g.hotels.length > 1, g.id + ' is a chain of one — that is a hotel, not a chain');
  }
});
t('a customer naming a chain is understood, however they spell it', () => {
  const find = txt => (offline.hotelGroups().find(g => g.re.test(txt)) || {}).id;
  for (const txt of ['מה עם קלאב דו סוליי?', 'קלאב סוליי', 'קלאב דה סולי', 'Club Soleil']) {
    assert.strictEqual(find(txt), 'club_soleil', txt);
  }
  for (const txt of ['בלמברה', 'מה יש בבלאמברה', 'Belambra']) {
    assert.strictEqual(find(txt), 'belambra', txt);
  }
  assert.strictEqual(find('מה עם ארוחת בוקר?'), undefined, 'matched a chain in an ordinary question');
});

const { handleChat } = require('../server/server.js');
(async () => {
  const first = await handleChat({ messages: [{ role: 'user', content: '4 מבוגרים בינואר בצרפת' }], slots: {} });
  const ask = q => handleChat({ messages: [{ role: 'user', content: q }], slots: first.slots });

  const soleil = await ask('מה עם קלאב דו סוליי?');
  t('"מה עם קלאב דו סוליי?" shows Club Soleil, not a rep\'s phone number', () => {
    assert.ok(soleil.cards.length, 'no offers at all');
    for (const c of soleil.cards) {
      assert.ok(/^Club Soleil/.test(c.hotel), 'showed ' + c.hotel);
    }
    assert.ok(!/להתאמת חופשות סקי/.test(soleil.reply_he || ''),
      'answered the off-topic line over its own offers: ' + soleil.reply_he);
  });
  t('naming one hotel still narrows to that hotel', () => {
    assert.ok(!soleil.slots.hotel, 'locked to one hotel out of four');
    assert.strictEqual(soleil.slots.hotel_group.id, 'club_soleil');
  });

  const karina = await ask('ומה עם קאזה קארינה?');
  t('and naming a single hotel is not off-topic either', () => {
    assert.ok(karina.cards.every(c => c.hotel === 'Casa Karina'), karina.cards.map(c => c.hotel).join(','));
    assert.ok(!/להתאמת חופשות סקי/.test(karina.reply_he || ''), karina.reply_he);
  });

  t('the card names the resort in Hebrew', () => {
    for (const c of first.cards) {
      assert.ok(!/[A-Za-z]/.test(c.resort || ''), 'Latin resort on a card: ' + c.resort);
    }
    assert.ok(first.cards.some(c => c.resort === 'טין' || c.resort === 'לה דוז אלפ'),
      first.cards.map(c => c.resort).join(','));
  });

  console.log(`names: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
