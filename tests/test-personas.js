// 30 שיחות פרסונה — שיחות מלאות, לא הודעה ראשונה. tests/persona-bank.json.
//   node tests/test-personas.js            אופליין (מפתחות מנוטרלים, חינם)
//   node tests/test-personas.js --live     דרך המודל האמיתי (.env), עם התקדמות חיה
// כותב tests/persona-results[-live].json — כל תור: מה הלקוח כתב, מה פינגי ענה.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const P = JSON.parse(fs.readFileSync(path.join(__dirname, 'persona-bank.json'), 'utf8'));
const live = process.argv.includes('--live');
// --only P01,P05 — a few conversations instead of all thirty (cents, not a dollar)
const onlyArg = process.argv.find(a => a.startsWith('--only'));
const only = onlyArg ? String(onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[process.argv.indexOf(onlyArg) + 1] || '').split(',').map(x => x.trim()).filter(Boolean) : [];
const PORT = 8846;
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

const OUT = path.join(__dirname, (live ? 'persona-results-live' : 'persona-results') + (only.length ? '-only' : '') + '.json');
const results = [];
const total = P.filter(p => !only.length || only.includes(p.id)).reduce((n, p) => n + p.turns.length, 0);
let done = 0;
const t0 = Date.now();
const clock = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;

function save(partial) {
  fs.writeFileSync(OUT, JSON.stringify({ live, saved_at: new Date().toISOString(), partial, conversations: results }, null, 1));
}
process.on('SIGINT', () => { save(true); console.log('\nנעצר — נשמר מה שנמדד עד כה ב-' + path.relative(ROOT, OUT)); process.exit(130); });

(async () => {
  await new Promise(r => setTimeout(r, 1500));
  try { await fetch(`http://localhost:${PORT}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}' }); }
  catch (e) { console.error('השרת לא עלה:\n' + serverErr.slice(-800)); process.exit(1); }

  console.log(`\n30 שיחות פרסונה · ${total} תורות · ${live ? 'לייב — דרך המודל' : 'אופליין — בלי מודל'}\n`);
  for (const p of P) {
    if (only.length && !only.includes(p.id)) continue;
    let slots = {}, messages = [{ role: 'assistant', content: GREET }];
    const steps = [];
    for (const t of p.turns) {
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
        model: !!res.model_used, ms: Date.now() - at, error: res.error || null,
        gate: d.gate || null, slots: { month: slots.month ?? null, flexible_dates: slots.flexible_dates ?? null,
          country: slots.country ?? null, adults: slots.adults ?? null, children_ages: slots.children_ages || [] } });
      done++;
      const secs = (Date.now() - t0) / 1000;
      const left = Math.round((total - done) / Math.max(done / Math.max(secs, 0.001), 0.001));
      const short = t.length > 34 ? t.slice(0, 33) + '…' : t;
      process.stdout.write(`${p.id}  ${String(done).padStart(3)}/${total}  ${String(Date.now() - at).padStart(5)}ms  ~${clock(left)}  ${short}\n`);
    }
    results.push({ id: p.id, who: p.who, steps });
    save(true);
  }
  save(false);
  server.kill();
  const modelTurns = results.reduce((n, c) => n + c.steps.filter(s => s.model).length, 0);
  console.log(`\nסיום: 30 שיחות, ${total} תורות${live ? `, ${modelTurns} מהן עברו דרך המודל` : ''}.`);
  console.log('נשמר: ' + path.relative(ROOT, OUT));
})();
