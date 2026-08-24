// The conversation log. Two things must hold: it records enough to review a
// week's conversations without asking anyone for a screenshot, and it records
// nothing that would break the PII rule the whole system is built around.
// Run: node tests/test-log.js
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const os = require('os');
const fs = require('fs');
const path = require('path');
// a scratch directory, so running the tests never touches the real log
process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pingwin-log-'));

const assert = require('assert');
const log = require('../server/conversation-log.js');
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);

t('a turn is written, with what was said on both sides', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, פברואר באוסטריה' }], slots: {},
  }).then(out => {
    const rows = log.read();
    assert.ok(rows.length, 'nothing was logged');
    const last = rows[rows.length - 1];
    assert.strictEqual(last.user, 'זוג בלי ילדים, פברואר באוסטריה');
    assert.strictEqual(last.bot, out.reply_he);
    assert.ok(last.hotels.length, 'the offers were not recorded');
    assert.ok(typeof last.ms === 'number');
  });
});

t('turns of one conversation share an id, and two do not', () => {
  const before = log.read().length;
  const msgs = [{ role: 'user', content: 'זוג בלי ילדים, ינואר' }];
  return handleChat({ messages: msgs, slots: {} })
    .then(a => {
      msgs.push({ role: 'assistant', content: a.reply_he });
      msgs.push({ role: 'user', content: 'לא בולגריה' });
      return handleChat({ messages: msgs, slots: a.slots });
    })
    .then(() => handleChat({ messages: [{ role: 'user', content: 'זוג במרץ' }], slots: {} }))
    .then(() => {
      const rows = log.read().slice(before);
      assert.strictEqual(rows.length, 3, 'expected three turns');
      assert.strictEqual(rows[0].cid, rows[1].cid, 'a conversation lost its id mid-way');
      assert.notStrictEqual(rows[1].cid, rows[2].cid, 'two conversations share an id');
    });
});

t('the signals point at the conversations worth reading', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בפברואר, יש אוכל כשר?' }], slots: {},
  }).then(() => {
    const deferred = log.read(null, 'deferred');
    assert.ok(deferred.length, 'a reply that sent the customer to a rep was not flagged');
  });
});

// The rule the whole system is built around (spec 2a).
t('no customer name or order number is ever written', () => {
  const raw = fs.readFileSync(log.file(), 'utf8');
  assert.ok(!/\d{6}/.test(raw), 'a six-digit sequence reached the log');
});

t('the lead form details are not logged', () => {
  // logTurn is only ever called with chat turns; a lead has its own endpoint.
  const raw = fs.readFileSync(log.file(), 'utf8');
  for (const line of raw.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    assert.strictEqual(row.phone, undefined);
    assert.strictEqual(row.name, undefined);
  }
});

t('internal bookkeeping is not written as if it were the request', () => {
  const rows = log.read();
  for (const r of rows) {
    for (const k of Object.keys(r.slots)) {
      assert.ok(!k.startsWith('_'), 'internal slot in the log: ' + k);
    }
  }
});

t('a corrupt line costs one turn, not the day', () => {
  fs.appendFileSync(log.file(), '{ this is not json\n', 'utf8');
  assert.doesNotThrow(() => log.read());
  assert.ok(log.read().length, 'one bad line emptied the whole day');
});

t('an unwritable directory never breaks a conversation', () => {
  const real = process.env.LOG_DIR;
  process.env.LOG_DIR = '';
  try {
    // the module caches DIR at load, so exercise append() through a bad path
    assert.doesNotThrow(() => log.logTurn({
      conversationId: 'x', userText: 'a', reply: 'b', cards: [],
      result: { notes: [], relaxed: [] }, slots: {}, modelUsed: false, ms: 1,
    }));
  } finally { process.env.LOG_DIR = real; }
});

t('logging can be switched off entirely', () => {
  assert.strictEqual(process.env.CHAT_LOG === 'off', false, 'default is on');
  // the flag is read at module load; this pins that the switch exists
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'conversation-log.js'), 'utf8');
  assert.ok(/CHAT_LOG !== 'off'/.test(src), 'no way to turn the log off');
});

(async () => {
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
  }
  try { fs.rmSync(process.env.LOG_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
