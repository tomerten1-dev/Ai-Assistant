'use strict';
/* Taking a new inventory file from the office.
 *
 * Everything here is about one question: what would it take for this endpoint
 * to leave Pingwin selling rooms that are gone, or to leak a customer's name?
 * Run: node tests/test-inventory.js
 */
process.env.CHAT_LOG = 'off';
process.env.INVENTORY_TOKEN = 'test-token-1234567890';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const inv = require('../server/inventory.js');
const gate = require('../data/pii-gate.js');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

const unit = (over = {}) => ({
  hotel: 'Belambra Tignes Val Claret', country: 'france', date: '2027-01-02',
  nights: 7, room: 'Premium with View 4-5 pax', room_type: 'Premium with View',
  occ_min: 4, occ_max: 5, occ_notation: '4-5 pax', count: 2, ...over,
});
const file = (n, over = {}) => ({
  generated_at: new Date().toISOString(),
  units: Array.from({ length: n }, (_, i) => unit({ date: '2027-01-' + String((i % 28) + 1).padStart(2, '0') })),
  ...over,
});
const now = file(100);
const req = tok => ({ headers: { authorization: 'Bearer ' + tok } });

t('the token is the door, and a wrong one does not open it', () => {
  assert.ok(inv.authorised(req('test-token-1234567890')));
  assert.ok(!inv.authorised(req('test-token-1234567891')), 'one character out and it opened');
  assert.ok(!inv.authorised(req('')), 'an empty token opened it');
  assert.ok(!inv.authorised({ headers: {} }));
  assert.ok(!inv.authorised(req('test-token-1234567890x')), 'a longer token opened it');
});

t('a customer name in a room field never lands', () => {
  const bad = file(100);
  bad.units[3].room = 'משפחת כהן';
  const why = inv.validate(bad, now);
  assert.ok(/PII/.test(why || ''), 'accepted: ' + why);
});
t('nor a phone number anywhere in the file', () => {
  const bad = file(100);
  bad.units[7].occ_notation = '0501234567';
  assert.ok(/PII/.test(inv.validate(bad, now) || ''));
});
t('the gate is the same one the build runs', () => {
  // one file, so the check where it is built and the check on what arrives
  // cannot drift apart
  assert.deepStrictEqual(gate.check({ units: [unit()] }), []);
  assert.strictEqual(gate.check({ units: [unit({ hotel: 'מלון' })] }).length, 1);
});

t('a file that lost most of its rooms is refused, not published', () => {
  // a workbook saved mid-edit, or a parser that hit a renamed sheet, would
  // empty the bot in silence — the worst possible failure here
  assert.ok(/truncated/.test(inv.validate(file(20), now) || ''), 'accepted a 80% drop');
  assert.strictEqual(inv.validate(file(60), now), null, 'refused an ordinary week-to-week change');
  assert.ok(/no units/.test(inv.validate(file(0), now) || ''));
});

t('an old file cannot overwrite a newer one', () => {
  const older = file(100, { generated_at: new Date(Date.now() - 3600e3).toISOString() });
  const have = file(100, { generated_at: new Date().toISOString() });
  assert.ok(/older/.test(inv.validate(older, have) || ''), 'a retry of an old push moved us backwards');
  assert.strictEqual(inv.validate(file(100), have), null);
});
t('and neither can a file with no timestamp, or one from the future', () => {
  const noStamp = file(100); delete noStamp.generated_at;
  assert.ok(/generated_at/.test(inv.validate(noStamp, now) || ''));
  const ahead = file(100, { generated_at: new Date(Date.now() + 48 * 3600e3).toISOString() });
  assert.ok(/future/.test(inv.validate(ahead, now) || ''));
});
t('rubbish is refused without an exception reaching the caller', () => {
  for (const junk of [null, 'hello', 42, {}, { units: 'x' }]) {
    assert.ok(typeof inv.validate(junk, now) === 'string', JSON.stringify(junk));
  }
});

t('how old the stock is, in hours', () => {
  assert.strictEqual(Math.round(inv.ageHours(file(1, { generated_at: new Date(Date.now() - 7200e3).toISOString() }))), 2);
  assert.strictEqual(inv.ageHours({ units: [] }), null, 'a file with no stamp is not "0 hours old"');
  assert.ok(!inv.stale(file(1)));
  assert.ok(inv.stale(file(1, { generated_at: new Date(Date.now() - 30 * 3600e3).toISOString() })));
  assert.ok(!inv.stale({ units: [] }), 'an unstamped file must not read as stale — it predates the field');
});

// the card, with fresh stock and with stale stock
process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = ''; process.env.SITE_ROOMS = 'off';
const { handleChat } = require('../server/server.js');
const AV = path.join(__dirname, '..', 'data', 'availability.json');
const original = fs.readFileSync(AV, 'utf8');
const setAge = hours => {
  const av = JSON.parse(original);
  av.generated_at = new Date(Date.now() - hours * 3600e3).toISOString();
  fs.writeFileSync(AV, JSON.stringify(av, null, 1));
};

(async () => {
  try {
    setAge(1);
    const fresh = await handleChat({ messages: [{ role: 'user', content: '2 מבוגרים בפברואר' }], slots: {} });
    setAge(40);
    const old = await handleChat({ messages: [{ role: 'user', content: '2 מבוגרים בפברואר' }], slots: {} });

    t('with fresh stock the last room of its type is still worth saying', () => {
      assert.ok(fresh.cards.some(c => c.rooms_left_he), 'nothing said, so the stale case proves nothing');
    });
    t('stock we have not heard about for two days stops saying it', () => {
      // the first line to become a lie, and the one that pushes a customer to
      // decide — so it is the first to go
      assert.ok(!old.cards.some(c => c.rooms_left_he),
        'still claiming a last room from a two-day-old workbook');
      assert.strictEqual(old.cards.length, fresh.cards.length, 'the offers themselves disappeared');
    });
    t('and says so, once, in the customer\'s terms', () => {
      assert.ok(/הזמינות משתנה/.test(old.reply_he || ''), old.reply_he);
      assert.ok(!/הזמינות משתנה/.test(fresh.reply_he || ''), 'said it when the stock was an hour old');
      assert.strictEqual((old.reply_he.match(/הזמינות משתנה/g) || []).length, 1);
    });
  } finally {
    fs.writeFileSync(AV, original);
  }
  console.log(`inventory: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
