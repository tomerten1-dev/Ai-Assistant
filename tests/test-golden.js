// The ratchet: every customer message the auditor ever rejected, replayed
// against the current bot and judged again.
//
// Random audit rounds cannot measure progress — the same score can mean a
// better bot or an easier batch of customers. This set is FIXED (126 real
// failures, tests/golden.json), so its score moves only when the bot does.
// The rule: the score may only go up. A change that pushes it down gets
// reverted or fixed, whatever else it improved.
//
//   node tests/test-golden.js            the whole set
//   node tests/test-golden.js 30         the first N (a quick sniff)
//
// Costs one judge call per case. Not part of `npm test`.
const { loadEnv } = require('../server/env.js');
loadEnv();
process.env.CHAT_LOG = 'off';
const { handleChat } = require('../server/server.js');
const { judge } = require('./_judge.js');
const GOLDEN = require('./golden.json');

const N = +(process.argv[2] || 0) || GOLDEN.cases.length;

(async () => {
  const cases = GOLDEN.cases.slice(0, N);
  let pass = 0; const failed = [];
  for (const c of cases) {
    let out;
    try {
      out = await handleChat({ messages: [{ role: 'user', content: c.msg }], slots: {} });
    } catch (e) {
      failed.push({ ...c, why: 'הבוט קרס: ' + e.message, reply: '' });
      process.stdout.write('x'); continue;
    }
    let verdict = { ok: true };
    try { verdict = await judge(c.msg, out.reply_he, null, out.cards); }
    catch (e) { /* a judge we could not reach is not a verdict */ }
    if (verdict.ok) { pass++; process.stdout.write('.'); }
    else { failed.push({ ...c, why: verdict.why || '', reply: out.reply_he }); process.stdout.write('F'); }
  }
  console.log('\n');
  for (const f of failed) {
    console.log('='.repeat(68));
    console.log('[' + f.kind + ']  ' + f.why);
    console.log('>>> ' + f.msg);
    console.log('<<< ' + f.reply + '\n');
  }
  console.log(`GOLDEN: ${pass}/${cases.length} עוברות (${Math.round(100 * pass / cases.length)}%)`);
})();
