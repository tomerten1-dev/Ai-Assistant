'use strict';
// npm run bank:followups — the measurement tests/test-bank.js structurally
// cannot make. The bank sends every question as a FIRST message, so a short
// follow-up ("גם לילדים?", "זה כלול?") arrives with no previous turn and can
// never be answered, however good the bot is. 89 of its 162 failures are that
// shape. This asks each of them again as a SECOND message, using the bank's own
// neighbouring question in the same cluster as the first turn — the context is
// the bank's, not one chosen to flatter the number.
// Run after tests/test-bank.js, which writes tests/bank-results.json.
// asked again as a follow-up — with the previous question in its own cluster
// as the first turn. Unbiased: the context is the bank's own neighbouring
// question, not one I chose to make the number look good.
const { handleChat } = require('../server/server.js');
const rows = require('../tests/bank-results.json');
const BANK = require('../tests/question-bank.json');
const all = BANK;

const LOST = /לא בטוח שהבנתי|אני כאן בעיקר להתאמת/;
const short = rows.filter(r => !r.pass &&
  r.q.trim().split(/\s+/).filter(Boolean).length <= 4 && r.q.trim().length <= 40);

// previous question in the same cluster = a realistic preceding turn
const byCluster = {};
for (const q of all) (byCluster[q.cluster] = byCluster[q.cluster] || []).push(q.q);
function contextFor(r) {
  const list = byCluster[r.cluster] || [];
  const i = list.indexOf(r.q);
  return i > 0 ? list[i - 1] : list.find(x => x !== r.q) || null;
}

(async () => {
  let answered = 0, lost = 0, n = 0;
  const examples = [];
  for (const r of short) {
    const ctx = contextFor(r);
    if (!ctx) continue;
    n++;
    const h = [{ role: 'user', content: ctx }];
    let first;
    try { first = await handleChat({ messages: h, slots: {} }); } catch { continue; }
    h.push({ role: 'assistant', content: first.reply_he }, { role: 'user', content: r.q });
    let second;
    try { second = await handleChat({ messages: h, slots: first.slots }); } catch { continue; }
    const reply = second.reply_he || '';
    const isLost = LOST.test(reply);
    if (isLost) lost++; else answered++;
    if (examples.length < 10 && !isLost) examples.push([ctx, r.q, reply.split('\n')[0].slice(0, 110)]);
  }
  console.log(`שאלות קצרות שנבדקו כהמשך לשיחה: ${n}`);
  console.log(`  נענו:        ${answered}  (${Math.round(100*answered/n)}%)`);
  console.log(`  "לא הבנתי":  ${lost}  (${Math.round(100*lost/n)}%)`);
  console.log();
  for (const [a,b,c] of examples) console.log(`👤 ${a}\n👤 ${b}\n🤖 ${c}\n`);
})().catch(e => { console.error(e); process.exit(1); });
