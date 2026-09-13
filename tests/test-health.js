// The model layer can be completely dead and the bot still answers — that is
// the design, and it is also why nobody would notice. Until 30/08 there were
// thirty console.error sites and not one counter, and /healthz reported the
// provider as live from the mere presence of a key, so a monitor watching it
// saw green through a total outage. These pin what it now reports and when it
// stops calling a provider that keeps failing.
//
// Run: node tests/test-health.js
process.env.CHAT_LOG = 'off';

const assert = require('assert');
const health = require('../server/model-health.js');

const results = [];
function t(name, fn) { results.push([name, fn]); }

t('a healthy run reports not degraded', () => {
  health.reset();
  for (let i = 0; i < 10; i++) { health.called('slots'); health.ok('slots'); }
  const r = health.report();
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.breaker_open, false);
  assert.strictEqual(r.calls, 10);
  assert.strictEqual(r.failed, 0);
});

t('failures are counted per stage and reported', () => {
  health.reset();
  health.called('router'); health.failed('router', new Error('anthropic_429'));
  health.called('phrase'); health.rejected('phrase', 'price');
  const r = health.report();
  assert.strictEqual(r.by_stage.router.failed, 1);
  assert.strictEqual(r.by_stage.phrase.rejected, 1);
  assert.strictEqual(r.by_stage.phrase.last_rejection, 'price');
});

t('a mostly-failing provider is reported as degraded', () => {
  health.reset();
  for (let i = 0; i < 8; i++) { health.called('slots'); health.failed('slots', new Error('timeout')); }
  assert.strictEqual(health.report().degraded, true);
});

t('a rejected answer is not a provider failure and never trips the breaker', () => {
  // The provider answered; a validator declined what it said. That is a prompt
  // or model-quality problem, and treating it as an outage would take the
  // model layer down over wording.
  health.reset();
  process.env.MODEL_BREAKER_FAILURES = '3';
  for (let i = 0; i < 20; i++) { health.called('phrase'); health.rejected('phrase', 'superlative'); }
  assert.strictEqual(health.open(), false);
  assert.strictEqual(health.report().degraded, false);
  delete process.env.MODEL_BREAKER_FAILURES;
});

t('the breaker opens after repeated failures and closes after the cooldown', () => {
  health.reset();
  process.env.MODEL_BREAKER_FAILURES = '3';
  process.env.MODEL_BREAKER_COOLDOWN_MS = '5000';   // clamped up to the 5s floor
  for (let i = 0; i < 2; i++) { health.called('slots'); health.failed('slots', new Error('x')); }
  assert.strictEqual(health.open(), false, 'opened too early');
  health.called('slots'); health.failed('slots', new Error('x'));
  assert.strictEqual(health.open(), true, 'did not open at the threshold');
  assert.strictEqual(health.report().degraded, true);
  delete process.env.MODEL_BREAKER_FAILURES;
  delete process.env.MODEL_BREAKER_COOLDOWN_MS;
});

t('one success closes the breaker immediately', () => {
  health.reset();
  process.env.MODEL_BREAKER_FAILURES = '2';
  health.called('slots'); health.failed('slots', new Error('x'));
  health.called('slots'); health.failed('slots', new Error('x'));
  assert.strictEqual(health.open(), true);
  health.called('slots'); health.ok('slots');
  assert.strictEqual(health.open(), false, 'a working provider stayed shut out');
  delete process.env.MODEL_BREAKER_FAILURES;
});

t('while the breaker is open the bot answers from the free layer, not an error', async () => {
  health.reset();
  process.env.MODEL_BREAKER_FAILURES = '1';
  process.env.OPENAI_API_KEY = 'sk-proj-real-looking-key-for-this-test';
  const { handleChat } = require('../server/server.js');
  health.called('slots'); health.failed('slots', new Error('anthropic_500'));
  assert.strictEqual(health.open(), true);
  const out = await handleChat({
    messages: [{ role: 'user', content: 'אנחנו 4, ילדים בני 6 ו-9, פברואר, בנסקו' }],
    slots: {}, _partial: {} });
  assert.ok(out.cards.length, 'the free layer stopped finding offers');
  assert.ok(!/משהו השתבש/.test(out.reply_he), out.reply_he);
  // and no further provider calls were attempted while it was open
  const after = health.report();
  assert.strictEqual(after.by_stage.phrase.calls, 0, 'called the provider with the breaker open');
  delete process.env.MODEL_BREAKER_FAILURES;
  process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
  health.reset();
});

t('the turn flags that go into the conversation log are small and truthful', () => {
  health.reset();
  const flags = health.turnFlags();
  assert.deepStrictEqual(Object.keys(flags).sort(), ['breaker_open', 'consecutive_failures']);
  assert.strictEqual(flags.breaker_open, false);
  health.called('slots'); health.failed('slots', new Error('x'));
  assert.strictEqual(health.turnFlags().consecutive_failures, 1);
  health.reset();
});

t('/healthz carries the model report, not only the configured mode', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../server/server.js'), 'utf8');
  const idx = src.indexOf("url.pathname === '/healthz'");
  assert.ok(idx > 0, 'no /healthz route');
  const route = src.slice(idx, idx + 500);
  assert.ok(/health\.report\(\)/.test(route), '/healthz does not read the model report');
  assert.ok(/degraded/.test(route), '/healthz exposes nothing to alert on');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ok  ' + name); pass++; }
    catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\nhealth: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
