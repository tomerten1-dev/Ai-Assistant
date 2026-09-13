// What the customer gets when the model provider is slow or down.
//
// Every stage of this bot degrades to a deterministic floor — that was true
// per stage and false for the turn as a whole. Until 30/08 the 25-second outer
// cap returned `{reply_he: FALLBACK, cards: []}`, so a hung provider threw
// away offers the search had found in milliseconds and told the customer to
// rephrase a message that was never the problem. It fires precisely during a
// provider incident, so every customer gets it at the same moment.
//
// Run: node tests/test-slow-model.js
process.env.CHAT_LOG = 'off';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub-not-real';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
// short caps so the suite runs in seconds rather than in half a minute
process.env.CHAT_TIMEOUT_MS = '3000';

const assert = require('assert');
const claudePath = require.resolve('../server/claude.js');
const real = require('../server/claude.js');

let mode = 'hang';               // 'hang' | 'throw' | 'ok'
require.cache[claudePath].exports = {
  ...real,
  callClaude: async ({ deadline }) => {
    if (mode === 'throw') throw new Error('anthropic_500');
    if (mode === 'ok') return '{"slots":{},"ready_to_search":true}';
    // hang, but never past the turn's own budget — the point of `deadline`
    const ms = deadline ? Math.max(0, deadline - Date.now()) + 500 : 30_000;
    await new Promise(r => setTimeout(r, ms));
    return '{}';
  },
};

const { handleChat, startServer } = require('../server/server.js');
const results = [];
function t(name, fn) { results.push([name, fn]); }

const FULL = 'אנחנו 4, ילדים בני 6 ו-9, פברואר, בנסקו';

/* ---- the deterministic reply survives a hung provider ---- */

t('a hung provider still returns the offers the search already found', async () => {
  mode = 'hang';
  const body = { messages: [{ role: 'user', content: FULL }], slots: {}, _partial: {} };
  const limits = require('../server/limits.js');
  const out = await limits.withTimeout(handleChat(body), 3000, () => {
    const ready = body._partial && body._partial.ready;
    return ready ? { ...ready, chips: [], timeout: true } : { reply_he: 'SLOW', cards: [] };
  });
  assert.ok(out.cards && out.cards.length,
    'the offers were thrown away on timeout: ' + JSON.stringify(out.reply_he));
  assert.ok(!/משהו השתבש/.test(out.reply_he || ''),
    'apologised instead of answering: ' + out.reply_he);
  assert.ok((out.reply_he || '').length > 10, out.reply_he);
});

t('handleChat publishes its deterministic reply before it calls the model', async () => {
  mode = 'hang';
  const body = { messages: [{ role: 'user', content: FULL }], slots: {}, _partial: {} };
  handleChat(body).catch(() => {});          // deliberately not awaited
  // Slot filling runs BEFORE the search, so the publish cannot happen until
  // that call gives up — which the shared deadline guarantees it does, leaving
  // the rest of the outer cap for the search and the reply. Wait past it.
  await new Promise(r => setTimeout(r, 2900));
  assert.ok(body._partial.ready, 'nothing was published for the timeout to use');
  assert.ok(body._partial.ready.cards.length, 'published a reply with no offers');
});

t('a thrown provider error keeps the offers too', async () => {
  mode = 'throw';
  const out = await handleChat({ messages: [{ role: 'user', content: FULL }], slots: {}, _partial: {} });
  assert.ok(out.cards.length, 'a 500 from the provider cost the customer the offers');
  assert.ok(!/משהו השתבש/.test(out.reply_he), out.reply_he);
});

/* ---- one turn, one time budget ---- */

t('the model calls share the turn budget instead of each taking the ceiling', async () => {
  mode = 'hang';
  const started = Date.now();
  const body = { messages: [{ role: 'user', content: FULL }], slots: {}, _partial: {} };
  await handleChat(body).catch(() => {});
  const spent = Date.now() - started;
  // three sequential calls at a fixed 20s ceiling would be far past this;
  // sharing one budget keeps the whole turn inside the outer cap
  assert.ok(spent < 3000 * 3, 'the turn took ' + spent + 'ms — the budget is not shared');
});

t('the budget floor keeps a nearly-spent turn from firing a doomed request', () => {
  const { callBudgetMs } = require('../server/claude.js');
  assert.strictEqual(typeof callBudgetMs, 'function', 'callBudgetMs is not exported');
  assert.strictEqual(callBudgetMs(0), +(process.env.MODEL_TIMEOUT_MS || 20000),
    'no deadline should mean the plain ceiling');
  assert.ok(callBudgetMs(Date.now() + 500) >= 1200, 'no floor on an almost-spent budget');
  assert.ok(callBudgetMs(Date.now() - 10_000) >= 1200, 'a past deadline produced a negative timeout');
  const mid = callBudgetMs(Date.now() + 4000);
  assert.ok(mid > 3000 && mid <= 4100, 'expected roughly the remaining budget, got ' + mid);
});

/* ---- the wording the customer reads when it really is just slow ---- */

t('a timeout says it is slow, not that the customer phrased it badly', () => {
  const guidance = require('../server/guidance.js');
  const slow = guidance.msg('slow', '');
  assert.ok(slow && /יותר זמן|נסות שוב/.test(slow), 'no distinct slow-path wording: ' + slow);
  assert.ok(!/לנסח שוב/.test(slow), 'still blames the wording: ' + slow);
});

t('a normal turn is unaffected once the provider answers', async () => {
  mode = 'ok';
  const out = await handleChat({ messages: [{ role: 'user', content: FULL }], slots: {}, _partial: {} });
  assert.ok(out.cards.length, 'a healthy provider lost the offers');
  assert.ok(!out.timeout);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ok  ' + name); pass++; }
    catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\nslow-model: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
