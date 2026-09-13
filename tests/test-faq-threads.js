// שאלות נפוצות כשרשורים — שאלה, ואחרי התשובה עד שתי שאלות המשך. tests/faq-threads.json.
//   node tests/test-faq-threads.js                 אופליין (מפתחות מנוטרלים, חינם)
//   node tests/test-faq-threads.js --live          דרך המודל האמיתי (.env), עם התקדמות חיה
//   node tests/test-faq-threads.js --only F001,F050   רק שרשורים מסוימים
//   node tests/test-faq-threads.js --topic קייטנה     רק נושא אחד
//   node tests/test-faq-threads.js --first 20         רק 20 הראשונים
// כותב tests/faq-threads-results[-live].json, וגם תמליל קריא:
// docs/faq-threads-transcript[-live].md — שאלה, תשובה, שאלת המשך, תשובה...
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const live = argv.includes('--live');
const flag = name => {
  const i = argv.findIndex(a => a === name || a.startsWith(name + '='));
  if (i < 0) return null;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : (argv[i + 1] || '');
};
// --bank tests/smoke-threads.json — another bank in the same shape (the 20
// focused threads for a round of fixes, say); outputs are named after it
const BANK_FILE = path.resolve(ROOT, flag('--bank') || path.join('tests', 'faq-threads.json'));
const BANK_BASE = path.basename(BANK_FILE).replace(/\.json$/, '');
const BANK = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')).threads;
const only = (flag('--only') || '').split(',').map(x => x.trim()).filter(Boolean);
const topic = flag('--topic');
const first = +(flag('--first') || 0);
let threads = BANK.filter(t => (!only.length || only.includes(t.id)) && (!topic || t.topic === topic));
if (first > 0) threads = threads.slice(0, first);
if (!threads.length) { console.error('אין שרשורים שמתאימים לסינון.'); process.exit(1); }
const filtered = threads.length !== BANK.length;
const PORT = 8847;
const GREET = 'שלום, ספרו לנו כמה נוסעים, גילאי ילדים אם יש, ומתי תרצו לצאת.';

if (live) {
  require('../server/env.js').loadEnv();
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('--live צריך מפתח ב-.env (OPENAI_API_KEY=...)'); process.exit(1);
  }
}
const keys = live ? {} : { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };
const server = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
  cwd: ROOT,
  env: { ...process.env, ...keys, PORT: String(PORT), BANK_DEBUG: '1', CHAT_LOG: 'off',
    RATE_CHAT_PER_MIN: '1000000', RATE_CHAT_PER_HOUR: '1000000', MAX_TURNS_PER_CHAT: '100000' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', d => { serverErr += d; });
process.on('exit', () => { try { server.kill(); } catch (e) {} });

const suffix = (live ? '-live' : '') + (filtered ? '-only' : '');
const OUT = path.join(__dirname, BANK_BASE + '-results' + suffix + '.json');
const MD = path.join(ROOT, 'docs', BANK_BASE + '-transcript' + suffix + '.md');
const results = [];
const total = threads.reduce((n, t) => n + t.turns.length, 0);
let done = 0;
const t0 = Date.now();
const clock = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;

// The reply as the customer sees it, minus the hotel cards themselves
// (they are listed by name on the line below).
function writeTranscript(partial) {
  const lines = [];
  lines.push(`# שאלות נפוצות — תמליל ${live ? 'לייב (דרך המודל)' : 'אופליין (בלי מודל)'}`);
  lines.push('');
  lines.push(`${results.length} שרשורים · ${done} תורות · ${new Date().toLocaleString('he-IL')}${partial ? ' · (חלקי)' : ''}`);
  lines.push('');
  lines.push('סימונים: 🃏 = הוצגו כרטיסי מלונות · 📋 = נפתח טופס "תחזרו אליי" · 🌐 = תשובה בשפה זרה (בלי עברית) · ⚠ = "מחוץ לתחום" / "לא הבנתי" / "אין לי תשובה מוכנה" · ❔ = "אין לי תשובה מאושרת על הפרט הזה" (פער תוכן — צריך ניסוח מתומר)');
  lines.push('');
  let curTopic = null;
  for (const r of results) {
    if (r.topic !== curTopic) { curTopic = r.topic; lines.push(`## ${curTopic}`); lines.push(''); }
    lines.push(`### ${r.id}${r.title ? ' — ' + r.title : ''}`);
    lines.push('');
    if (r.checks) { lines.push(`_מה בודקים: ${r.checks}_`); lines.push(''); }
    r.steps.forEach((s, i) => {
      const marks = [s.cards.length ? '🃏' : '', s.form ? '📋' : '', (!/[א-ת]/.test(s.a) && s.a.trim()) ? '🌐' : '',
        /אני כאן בעיקר להתאמת|לא בטוח שהבנתי|לא הצלחתי להבין|אין לי תשובה מוכנה/.test(s.a) ? '⚠' : '',
        /אין לי תשובה מאושרת/.test(s.a) ? '❔' : ''].filter(Boolean).join(' ');
      lines.push(`**${i ? 'המשך' : 'לקוח'}:** ${s.u}`);
      lines.push('');
      lines.push(`**פינגי${marks ? ' ' + marks : ''}:** ${s.a.replace(/\n/g, '  \n')}`);
      if (s.cards.length) lines.push(`_כרטיסים: ${s.cards.join(' · ')}_`);
      lines.push('');
    });
  }
  fs.mkdirSync(path.dirname(MD), { recursive: true });
  fs.writeFileSync(MD, lines.join('\n'));
}
function save(partial) {
  fs.writeFileSync(OUT, JSON.stringify({ live, saved_at: new Date().toISOString(), partial, threads: results }, null, 1));
  writeTranscript(partial);
}
process.on('SIGINT', () => { save(true); console.log('\nנעצר — נשמר מה שנמדד עד כה ב-' + path.relative(ROOT, OUT)); process.exit(130); });

(async () => {
  // wait for the server — up to ten seconds, a slow machine is not a failure
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await fetch(`http://localhost:${PORT}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}' }); up = true; }
    catch (e) { /* not yet */ }
  }
  if (!up) { console.error('השרת לא עלה:\n' + serverErr.slice(-800)); process.exit(1); }

  console.log(`\n${threads.length} שרשורי שאלות · ${total} תורות · ${live ? 'לייב — דרך המודל' : 'אופליין — בלי מודל'}\n`);
  for (const th of threads) {
    let slots = {}, messages = [{ role: 'assistant', content: GREET }];
    const steps = [];
    for (const t of th.turns) {
      messages.push({ role: 'user', content: t });
      const at = Date.now();
      let res;
      try {
        res = await fetch(`http://localhost:${PORT}/api/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages, slots }),
        }).then(r => r.json());
      } catch (e) { res = { reply_he: '', debug: {}, error: String(e) }; }
      slots = res.slots || slots;
      const reply = String(res.reply_he || '');
      messages.push({ role: 'assistant', content: reply });
      const d = res.debug || {};
      steps.push({ u: t, a: reply, route: d.answered_by || null, faq: d.faq_ids || [],
        cards: (res.cards || []).map(c => c.hotel), form: !!res.open_lead_form,
        model: !!res.model_used, ms: Date.now() - at, error: res.error || null });
      done++;
      const secs = (Date.now() - t0) / 1000;
      const left = Math.round((total - done) / Math.max(done / Math.max(secs, 0.001), 0.001));
      const short = t.length > 34 ? t.slice(0, 33) + '…' : t;
      process.stdout.write(`${th.id}  ${String(done).padStart(3)}/${total}  ${String(Date.now() - at).padStart(5)}ms  ~${clock(left)}  ${short}\n`);
    }
    results.push({ id: th.id, topic: th.topic, title: th.title || null, checks: th.checks || null, steps });
    save(true);
  }
  save(false);
  server.kill();
  const modelTurns = results.reduce((n, c) => n + c.steps.filter(s => s.model).length, 0);
  const flagged = results.reduce((n, c) => n + c.steps.filter(s => /אני כאן בעיקר להתאמת|לא בטוח שהבנתי|לא הצלחתי להבין|אין לי תשובה מוכנה/.test(s.a)).length, 0);
  const gaps = results.reduce((n, c) => n + c.steps.filter(s => /אין לי תשובה מאושרת/.test(s.a)).length, 0);
  console.log(`\nסיום: ${results.length} שרשורים, ${total} תורות${live ? `, ${modelTurns} מהן עברו דרך המודל` : ''}. תורות בלי תשובה (⚠): ${flagged}. פערי תוכן (❔): ${gaps}.`);
  // the reply editor's rejections, for reading after a live run: how often the
  // guard threw an edit away, and why
  const rejections = serverErr.split(/\r?\n/).filter(l => /reply editor (rejected|failed)|translate-(in|out) (rejected|failed)/.test(l));
  if (live) {
    const LOG = path.join(__dirname, BANK_BASE + '-editor' + suffix + '.log');
    fs.writeFileSync(LOG, rejections.join('\n') + (rejections.length ? '\n' : ''));
    console.log(`עורך התשובה / תרגום: ${rejections.length} עריכות או תרגומים נדחו/נכשלו → ${path.relative(ROOT, LOG)}`);
  }
  console.log('נשמר: ' + path.relative(ROOT, OUT));
  console.log('תמליל קריא: ' + path.relative(ROOT, MD));
})();
