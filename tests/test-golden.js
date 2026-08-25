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
  let pass = 0, unreachable = 0; const failed = [];
  // eight cases in flight at once: a case is bot-call + judge-call, fully
  // independent of its neighbours, and running them in series made every
  // measurement a 25-minute wait
  // 8 in flight x (1 bot + 3 judges) burst past the rate limit and 25 calls
  // failed mid-run, which degrades the very replies being judged. 4 is the
  // most that stays under it.
  const CONCURRENCY = 4;
  const runOne = async (c) => {
    let out;
    try {
      out = await handleChat({ messages: [{ role: 'user', content: c.msg }], slots: {} });
    } catch (e) {
      failed.push({ ...c, why: 'הבוט קרס: ' + e.message, reply: '' });
      process.stdout.write('x'); return;
    }
    // one judge flips ~15% of cases between runs on nothing at all; three
    // judges and a majority make a verdict worth acting on
    // A judge we could not reach is NOT a pass. Defaulting to ok:true turned
    // an out-of-credit run into a perfect 100% — the most dangerous kind of
    // wrong number, because it looks like success.
    const votes = await Promise.all([0, 1, 2].map(async () => {
      try { return await judge(c.msg, out.reply_he, null, out.cards); }
      catch (e) { return { unreachable: true }; }
    }));
    if (votes.every(v => v.unreachable)) {
      unreachable++; process.stdout.write('?'); return;
    }
    const heard = votes.filter(v => !v.unreachable);
    const fails = heard.filter(v => !v.ok);
    if (fails.length * 2 <= heard.length) { pass++; process.stdout.write('.'); }
    else { failed.push({ ...c, why: fails[0].why || '', reply: out.reply_he }); process.stdout.write('F'); }
  };
  for (let i = 0; i < cases.length; i += CONCURRENCY) {
    await Promise.all(cases.slice(i, i + CONCURRENCY).map(runOne));
  }
  console.log('\n');
  for (const f of failed) {
    console.log('='.repeat(68));
    console.log('[' + f.kind + ']  ' + f.why);
    console.log('>>> ' + f.msg);
    console.log('<<< ' + f.reply + '\n');
  }
  const scored = cases.length - unreachable;
  if (unreachable) {
    console.log(`אזהרה: ${unreachable} מקרים לא נשפטו (השופט לא היה זמין) — הציון חושב על ${scored} בלבד.`);
  }
  console.log(`GOLDEN: ${pass}/${scored} עוברות (${scored ? Math.round(100 * pass / scored) : 0}%)`);
})();
