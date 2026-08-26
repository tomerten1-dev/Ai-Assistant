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
// shared with report(): filled as the run progresses, so an interrupt can
// summarise what was already measured
const ROWS = [];
let LIVE = false, TOTAL = 0;
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
  // The bank runs OFFLINE by default: both keys are blanked, so a full run is
  // free, repeatable, and measures the deterministic layer on its own. That is
  // what makes the score a ratchet rather than a weather report.
  //
  // --live sends the same questions through the real model (slot filling, the
  // semantic router, the phrasing). That is the only way to see what a customer
  // in production actually gets — the router in particular exists precisely for
  // the phrasings the patterns miss, and it is invisible offline.
  //   node tests/test-bank.js --live                 the whole bank
  //   node tests/test-bank.js --live --stuck         only what dead-ended offline
  //   node tests/test-bank.js --live --sample=150    a deterministic slice
  //   node tests/test-bank.js --live --watch          one line per answer
  const live = !!args.live; LIVE = live;
  const keys = live ? {} : { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
  if (live && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    require('../server/env.js').loadEnv();
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      console.error('--live needs a key in .env (OPENAI_API_KEY=...)'); process.exit(1);
    }
  }
  const server = spawn('node', ['server/server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), BANK_DEBUG: '1', CHAT_LOG: 'off', ...keys, RATE_CHAT_PER_MIN: '1000000', RATE_CHAT_PER_HOUR: '1000000', MAX_TURNS_PER_CHAT: '100000' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await new Promise(res => setTimeout(res, 1200));
  let list = BANK;
  if (args.cluster) list = list.filter(e => e.cluster === args.cluster);
  if (args.grep) list = list.filter(e => e.q.includes(args.grep));
  // --stuck: only the questions the offline run brushed off ("לא בטוח שהבנתי" /
  // "אני כאן בעיקר..."). Read from the previous results file, so it costs a
  // fraction of a full live run and answers the one question worth paying for.
  if (args.stuck) {
    let prev = [];
    try { prev = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-results.json'), 'utf8')); }
    catch (e) { console.error('--stuck needs a previous run: node tests/test-bank.js first'); process.exit(1); }
    const DEAD = /לא בטוח שהבנתי|אני כאן בעיקר להתאמת חופשות סקי/;
    const stuck = new Set(prev.filter(r => {
      const lines = String(r.reply || '').split('\n').filter(l => l.trim());
      return lines.length && lines.every(l => DEAD.test(l) || l.includes('כמה תהיו') || l.includes('מתי תרצו'));
    }).map(r => r.q));
    list = list.filter(e => stuck.has(e.q));
    console.log(`--stuck: ${list.length} questions that dead-ended offline`);
  }
  if (args.sample) {
    // deterministic slice, so two runs compare like for like
    const n = Math.max(1, Math.min(list.length, parseInt(args.sample, 10) || 100));
    const step = list.length / n;
    list = Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
  }

  const rows = ROWS;   // the same array report() reads on interrupt
  // A silent loop over 1,215 questions is indistinguishable from a hung one.
  // One line every 25 questions, with the rate and an estimate of what is left,
  // so a live run can be watched instead of guessed at.
  TOTAL = list.length;
  // Ctrl+C: summarise what is already measured instead of losing the run
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);          // a second Ctrl+C means "now"
    stopping = true;
    console.log('\n\nstopping — summarising what was measured so far…');
    try { server.kill(); } catch (e) { }
    report(true);
  });
  const startedAt = Date.now();
  let done = 0, passing = 0, errored = 0;
  const clock = secs => `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.round(secs) % 60).padStart(2, '0')}`;
  const progress = () => {
    const secs = (Date.now() - startedAt) / 1000;
    const perSec = done / Math.max(secs, 0.001);
    const left = Math.round((list.length - done) / Math.max(perSec, 0.001));
    if (done === 1) {
      process.stdout.write(`     1/${list.length}  first answer in ${secs.toFixed(1)}s — running\n`);
      return;
    }
    process.stdout.write(`  ${String(done).padStart(4)}/${list.length}  ${Math.round(100 * passing / done)}% pass` +
      `${errored ? `  ${errored} errors` : ''}  ~${clock(left)} left\n`);
  };
  // --watch: one line per answer, as it lands. Slower to read but there is
  // never a moment where you cannot tell whether it is working — and you see
  // which question is slow, which is where a live run actually hurts.
  const watch = (e, pass, observed, ms) => {
    const secs = (Date.now() - startedAt) / 1000;
    const perSec = done / Math.max(secs, 0.001);
    const left = Math.round((list.length - done) / Math.max(perSec, 0.001));
    const q = e.q.length > 42 ? e.q.slice(0, 41) + '…' : e.q;
    process.stdout.write(
      `${pass ? '✓' : '✗'} ${String(done).padStart(4)}/${list.length}` +
      `  ${String(Math.round(ms)).padStart(5)}ms` +
      `  ${String(Math.round(100 * passing / done)).padStart(3)}%` +
      `  ~${clock(left)}` +
      `  ${[...observed].join(',').padEnd(14)}  ${q}\n`);
  };
  for (const e of list) {
    let res;
    const askedAt = Date.now();
    try { res = await ask(e.q); } catch (err) { res = { reply_he: '', debug: {}, error: String(err) }; }
    const ms = Date.now() - askedAt;
    if (res.error) errored++;
    const observed = classify(res);
    const d = res.debug || {};
    const invented = NUMBERISH.test(res.reply_he || '') && !['faq', 'router', 'deflect', 'guard'].includes(d.answered_by);
    const pass = ok(e, observed) && !invented;
    const ignored = observed.size === 1 && observed.has('ask') && INFORMATIONAL.test(e.q);
    rows.push({ q: e.q, cluster: e.cluster, expect: e.expect, observed: [...observed], faq_ids: d.faq_ids || [],
      invented_number: invented, ignored, pass, reply: (res.reply_he || '').slice(0, 220) });
    done++; if (pass) passing++;
    // A live question can take up to a minute (three model calls, 20s each), so
    // "every 25" could mean 20 minutes of silence before the first line. Print
    // the first one immediately — that is the "it started" signal — then every
    // 5 live / 25 offline.
    const every = live ? 5 : 25;
    if (args.watch && !args.show) watch(e, pass, observed, ms);
    else if (!args.show && (done === 1 || done % every === 0 || done === list.length)) progress();
    if (args.show) {
      console.log(`${pass ? '✓' : '✗'} [${e.cluster}] ${e.q}`);
      console.log(`    → ${[...observed].join(',')}${d.faq_ids && d.faq_ids.length ? ' ' + d.faq_ids.join('+') : ''}${invented ? '  ⚠ INVENTED NUMBER' : ''}`);
      console.log('    ' + (res.reply_he || '').replace(/\n/g, ' | ').slice(0, 200));
    }
  }
  server.kill();
  report(false);
})();

/* ---------- the summary, callable at any point ----------
   A live run takes an hour, and Ctrl+C used to throw away everything it had
   already measured. Now the same report prints on interrupt, over whatever
   was answered so far — a partial answer beats no answer, and 100 questions
   in is usually enough to see where things stand. */
function report(partial) {
  // a live run writes its own file: bank-results.json is the offline baseline
  // that --stuck reads, and overwriting it would erase the comparison
  const outFile = LIVE ? 'bank-results-live.json' : 'bank-results.json';
  if (!ROWS.length) { console.log('\nnothing measured yet'); process.exit(1); }
  fs.writeFileSync(path.join(__dirname, outFile), JSON.stringify(ROWS, null, 1));
  const rows = ROWS;

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
  if (partial) console.log(`⚠ partial run — stopped after ${rows.length} of ${TOTAL} questions`);
  if (LIVE) console.log(`(live run — results in tests/${outFile}; the offline baseline is untouched)`);
  process.exit(hardFail ? 1 : 0);
}
