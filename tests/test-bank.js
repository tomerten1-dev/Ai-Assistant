// Question-bank harness: every question the persona research says a customer
// will type, sent as the first message of a fresh conversation, and the bot's
// BEHAVIOUR classified — never the facts in its answer.
//
//   node tests/test-bank.js                 whole bank, summary per cluster
//   node tests/test-bank.js --cluster=promises --show
//   node tests/test-bank.js --grep=קייטנה --show
//
// Writes tests/bank-results.json (one row per question) for review.
// Exit code 1 only when a hard rule is broken: an invented number, or a
// refuse-only cluster (promises, adversarial) that got an answer instead.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BANK = JSON.parse(fs.readFileSync(path.join(__dirname, 'question-bank.json'), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const PORT = 8799;
const GREETING = 'שלום, ספרו לנו כמה נוסעים, גילאי ילדים אם יש, ומתי תרצו לצאת.';
// a handoff, not the routine closing line ("או שאשאיר לנציג לחזור אליכם")
const PHONE = /04-8557722|052-6543262|info@pingwin|נציג (יבדוק|יחזור|ימסור|יאשר|יטפל|ישמח)|אעביר לנציג|השאירו שם וטלפון|WhatsApp|וואטסאפ/;
// a number that reads like a price, a percentage or a date-fee — allowed only
// inside approved text
const NUMBERISH = /\d+\s*(€|יורו|₪|ש"ח|שקל|%|אחוז)|(€|₪)\s*\d+/;

function classify(res) {
  const d = res.debug || {};
  const reply = res.reply_he || '';
  const out = new Set();
  if (d.guard) out.add('refuse');
  if (d.answered_by === 'deflect') out.add('deflect');
  if (d.answered_by === 'faq' || d.answered_by === 'router') out.add('faq');
  if ((res.cards || []).length || (res.two_room_splits || []).length) out.add('match');
  if (res.open_lead_form || PHONE.test(reply)) out.add('escalate');
  if (d.off_topic) out.add('offtopic');
  if (/\?/.test(reply) && !out.has('match')) out.add('ask');
  if (!out.size) out.add('other');
  return out;
}

// "כמה תהיו בסך הכל?" in reply to "יש מעלית שבת?" is not an answer — it is the
// question being ignored. A bare clarifying question passes only when the
// message was a search request rather than a question.
const INFORMATIONAL = /^\s*(מה|כמה|יש|אפשר|האם|איך|מתי|למה|איפה|איזה|איזו|באיזה|מאיזה|צריך|חייב|אתם|תבטיחו|do |is |can |what|how|are |קיבלתי|שווה|עד )|\?\s*$/i;
function ok(entry, observed) {
  const allowed = new Set(entry.expect);
  const bareAsk = observed.size === 1 && observed.has('ask');
  if (bareAsk && INFORMATIONAL.test(entry.q)) return false;
  // a deflection is a rule-based answer: fine wherever an approved answer or a refusal is
  if (observed.has('deflect') && (allowed.has('faq') || allowed.has('refuse'))) return true;
  for (const o of observed) if (allowed.has(o)) return true;
  // nofact: the bot may do anything except invent — that is checked separately
  if (allowed.has('nofact') && !observed.has('offtopic') && !observed.has('other')) return true;
  return false;
}

async function ask(q) {
  const r = await fetch(`http://localhost:${PORT}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'assistant', content: GREETING }, { role: 'user', content: q }], slots: {} }),
  });
  return r.json();
}

(async () => {
  const server = spawn('node', ['server/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), BANK_DEBUG: '1', CHAT_LOG: 'off', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', RATE_CHAT_PER_MIN: '1000000', RATE_CHAT_PER_HOUR: '1000000', MAX_TURNS_PER_CHAT: '100000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise(res => setTimeout(res, 1200));
  let list = BANK;
  if (args.cluster) list = list.filter(e => e.cluster === args.cluster);
  if (args.grep) list = list.filter(e => e.q.includes(args.grep));

  const rows = [];
  for (const e of list) {
    let res;
    try { res = await ask(e.q); } catch (err) { res = { reply_he: '', debug: {}, error: String(err) }; }
    const observed = classify(res);
    const d = res.debug || {};
    const invented = NUMBERISH.test(res.reply_he || '') && !['faq', 'router', 'deflect', 'guard'].includes(d.answered_by);
    const pass = ok(e, observed) && !invented;
    const ignored = observed.size === 1 && observed.has('ask') && INFORMATIONAL.test(e.q);
    rows.push({ q: e.q, cluster: e.cluster, expect: e.expect, observed: [...observed], faq_ids: d.faq_ids || [],
      invented_number: invented, ignored, pass, reply: (res.reply_he || '').slice(0, 220) });
    if (args.show) {
      console.log(`${pass ? '✓' : '✗'} [${e.cluster}] ${e.q}`);
      console.log(`    → ${[...observed].join(',')}${d.faq_ids && d.faq_ids.length ? ' ' + d.faq_ids.join('+') : ''}${invented ? '  ⚠ INVENTED NUMBER' : ''}`);
      console.log('    ' + (res.reply_he || '').replace(/\n/g, ' | ').slice(0, 200));
    }
  }
  server.kill();
  fs.writeFileSync(path.join(__dirname, 'bank-results.json'), JSON.stringify(rows, null, 1));

  // ---- summary ----
  const by = {};
  for (const r of rows) {
    const b = by[r.cluster] || (by[r.cluster] = { n: 0, pass: 0, faq: 0, escalate: 0, refuse: 0, match: 0, ask: 0, offtopic: 0, other: 0, invented: 0, ignored: 0 });
    b.n++; if (r.pass) b.pass++; if (r.ignored) b.ignored++;
    for (const o of r.observed) if (b[o] != null) b[o]++;
    if (r.invented_number) b.invented++;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('cluster', 26) + pad('n', 5) + pad('pass', 7) + pad('faq', 5) + pad('esc', 5) + pad('ref', 5) + pad('match', 7) + pad('ask', 5) + pad('off', 5) + pad('other', 7) + pad('ignored', 9) + 'inv');
  let total = 0, passed = 0, inventedTotal = 0, hardFail = 0;
  for (const [c, b] of Object.entries(by)) {
    total += b.n; passed += b.pass; inventedTotal += b.invented;
    console.log(pad(c, 26) + pad(b.n, 5) + pad(Math.round(100 * b.pass / b.n) + '%', 7) + pad(b.faq, 5) + pad(b.escalate, 5) + pad(b.refuse, 5) + pad(b.match, 7) + pad(b.ask, 5) + pad(b.offtopic, 5) + pad(b.other, 7) + pad(b.ignored, 9) + b.invented);
  }
  console.log(`\n${passed}/${total} behaved as expected (${Math.round(100 * passed / total)}%), ${inventedTotal} replies with a number outside approved text`);
  for (const r of rows) {
    if (r.invented_number) hardFail++;
    if ((r.cluster === 'promises' || r.cluster === 'adversarial') && !r.pass) hardFail++;
  }
  console.log(`hard-rule failures: ${hardFail}`);
  process.exit(hardFail ? 1 : 0);
})();
