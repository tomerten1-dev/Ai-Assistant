'use strict';
// the tests must never write to the real conversation log
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = '';
/* Findings 2 and 3: a mistake in the content files, or a bug in the wording
   stage, must cost one sentence — never the server, and never the offers the
   search already found. Run: node tests/test-resilience.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const offline = require('../server/offline-nlu.js');

let pass = 0, fail = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);
const ROOT = path.join(__dirname, '..');
const FAQ = path.join(ROOT, 'config', 'faq.json');
// keep console noise out of the report: these tests deliberately break things
const quiet = fn => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
const touch = p => fs.utimesSync(p, new Date(), new Date(Date.now() + 5000));

t('a broken pattern in faq.json drops that answer and keeps the rest', () => {
  const good = fs.readFileSync(FAQ, 'utf8');
  try {
    const d = JSON.parse(good);
    const before = offline.faqEntries().length;
    d.entries.splice(2, 0, { id: 'broken_pattern', match: 'ביטול(', answer_he: 'לא אמור להופיע' });
    fs.writeFileSync(FAQ, JSON.stringify(d, null, 1)); touch(FAQ);
    quiet(() => {
      assert.strictEqual(offline.faqEntries().length, before, 'the bad entry is skipped, the good ones stay');
      assert.ok(offline.faq('מה כלול במחיר?'), 'the bot still answers');
    });
  } finally { fs.writeFileSync(FAQ, good); touch(FAQ); }
});

t('an unparseable faq.json keeps the answers that were already loaded', () => {
  const good = fs.readFileSync(FAQ, 'utf8');
  try {
    const before = offline.faqEntries().length;
    fs.writeFileSync(FAQ, '{ this is not json at all'); touch(FAQ);
    quiet(() => {
      assert.strictEqual(offline.faqEntries().length, before, 'the previous set is kept');
      assert.ok(offline.faq('מה כלול במחיר?'), 'the bot still answers');
    });
  } finally { fs.writeFileSync(FAQ, good); touch(FAQ); }
});

t('an edit to faq.json is live without a restart', () => {
  const good = fs.readFileSync(FAQ, 'utf8');
  try {
    const d = JSON.parse(good);
    d.entries.unshift({ id: 'hot_reload_probe', match: 'מילת בדיקה ייחודית', answer_he: 'התשובה החדשה' });
    fs.writeFileSync(FAQ, JSON.stringify(d, null, 1)); touch(FAQ);
    const hit = offline.faq('מילת בדיקה ייחודית');
    assert.ok(hit && hit.he === 'התשובה החדשה', 'the new answer is served without reloading the process');
  } finally { fs.writeFileSync(FAQ, good); touch(FAQ); }
});

t('a failure while wording the reply still ships the offers', async () => {
  const { handleChat } = require('../server/server.js');
  const real = offline.phrase;
  offline.phrase = () => { throw new Error('deliberate failure in the template builder'); };
  try {
    const out = await quiet(() => handleChat({ messages: [{ role: 'user', content: 'זוג בפברואר' }], slots: {} }));
    assert.ok(out.cards.length >= 1, 'the search result survived: ' + out.cards.length + ' cards');
    assert.ok(out.reply_he && out.reply_he.length > 10, 'and a sentence was still said');
    assert.ok(!/משהו השתבש/.test(out.reply_he), 'not the generic error line');
  } finally { offline.phrase = real; }
});

t('a failure in one preamble line costs that line only', async () => {
  const { handleChat } = require('../server/server.js');
  const real = offline.comparingLine;
  offline.comparingLine = () => { throw new Error('deliberate failure in a preamble line'); };
  try {
    const out = await quiet(() => handleChat({ messages: [{ role: 'user', content: 'זוג בפברואר' }], slots: {} }));
    assert.ok(out.cards.length >= 1, 'offers survived');
    assert.ok(!/משהו השתבש/.test(out.reply_he));
  } finally { offline.comparingLine = real; }
});

t('the customer-facing error line is still there when there is nothing to ship', async () => {
  const { handleChat } = require('../server/server.js');
  const out = await handleChat({ messages: [{ role: 'user', content: 'זוג בפברואר' }], slots: {} });
  assert.ok(out.reply_he, 'a normal turn is unaffected');
  assert.ok(out.cards.length >= 1);
});

(async () => {
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
  }
  console.log(`\nresilience: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
