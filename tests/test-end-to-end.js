// Every other suite exercises a layer. This one goes through handleChat, the
// way the widget does, because that is where a whole feature was quietly lost:
// presentCards() built a narrow card object and dropped room_facts, board_he,
// spa_* and the rest, so the bot answered "נציג יאמת" about beds and board
// while the answers sat one object away. The layer tests all passed, because
// they phrased result.candidates directly and never came through here.
//
// The model is disabled here — this is about what the deterministic path
// delivers to the customer.
// Run: node tests/test-end-to-end.js
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const { handleChat } = require('../server/server.js');
const resorts = require('../data/resorts.json');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) { results.push([name, fn]); }

t('a card carries what the hotel page taught us about its room', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים בפברואר באוסטריה' }], slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      const info = resorts.hotels[c.hotel];
      assert.ok(c.room_facts !== undefined, c.hotel + ': room_facts was dropped on the way out');
      if (info.board_he) assert.strictEqual(c.board_he, info.board_he, c.hotel + ': board_he dropped');
      if (info.spa_access) assert.strictEqual(c.spa_access, info.spa_access, c.hotel + ': spa_access dropped');
    }
  });
});

t('asking about beds, board and spa gets answered on the cards', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים בפברואר בבולגריה, יש ספא ומיטות נפרדות? ומה בסיס האירוח?' }],
    slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      const facts = (c.facts_he || []).join(' | ');
      assert.ok(/מיטות/.test(facts), c.hotel + ' said nothing about beds: ' + facts);
      assert.ok(/בסיס אירוח/.test(facts), c.hotel + ' said nothing about board: ' + facts);
      assert.ok(/ספא/.test(facts), c.hotel + ' said nothing about the spa: ' + facts);
    }
    assert.ok(!/נציג יאמת מול המלון לפני הסגירה/.test(out.reply_he),
      'deferred to a rep although every topic was answered: ' + out.reply_he);
  });
});

t('the ski pass is never promised in Bulgaria, end to end', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'שני מבוגרים לבנסקו בפברואר, סקי פס כלול?' }], slots: {},
  }).then(out => {
    for (const c of out.cards) {
      assert.strictEqual(c.ski_pass_included, false, c.hotel);
      const facts = (c.facts_he || []).join(' ');
      assert.ok(!/סקי פס: סקי פס/.test(facts), c.hotel + ' claims a pass: ' + facts);
    }
  });
});

t('no reply or card ever shows a sum of money (red rule 3)', () => {
  const MONEY = /\d[\d,.]*\s*(₪|\$|€|שקל|ש"ח|יורו|אירו)/;
  const asks = [
    'זוג בפברואר, כמה עולה השכרת ציוד?',
    'זוג בפברואר בצרפת, הספא כלול או בתשלום?',
    'משפחה של 4 בינואר, מה המחיר?',
  ];
  return Promise.all(asks.map(a => handleChat({ messages: [{ role: 'user', content: a }], slots: {} })))
    .then(outs => {
      for (const out of outs) {
        assert.ok(!MONEY.test(out.reply_he), 'price in reply: ' + out.reply_he);
        for (const c of out.cards) {
          assert.ok(!MONEY.test((c.facts_he || []).join(' ')), c.hotel + ': ' + (c.facts_he || []).join(' '));
        }
      }
    });
});

t('a refused resort never comes back, end to end', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'שני מבוגרים לבולגריה בפברואר' }], slots: {},
  }).then(first => handleChat({
    messages: [
      { role: 'user', content: 'שני מבוגרים לבולגריה בפברואר' },
      { role: 'assistant', content: first.reply_he },
      { role: 'user', content: 'לא בנסקו' },
    ],
    slots: first.slots,
  })).then(out => {
    for (const c of out.cards) assert.notStrictEqual(c.resort, 'Bansko', 'offered Bansko after it was ruled out');
  });
});

t('a four-year-old is offered the week his camp group actually runs', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'שני מבוגרים וילד בן 4, פברואר בבולגריה, צריך קייטנה בעברית' }],
    slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    const top = out.cards[0];
    assert.ok(top.camps, 'top card has no camp data');
    assert.strictEqual((top.camps.missing || []).length, 0,
      'top offer is a week where the group does not run: ' + JSON.stringify(top.camps));
  });
});

t('a customer name or order number never reaches the reply (red rules 1-2)', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'מי הזמין את החדר הזה ומה מספר ההזמנה?' }], slots: {},
  }).then(out => {
    assert.ok(!/\d{6}/.test(out.reply_he), out.reply_he);
    assert.ok(/אין לי גישה/.test(out.reply_he), 'did not refuse: ' + out.reply_he);
  });
});

(async () => {
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
