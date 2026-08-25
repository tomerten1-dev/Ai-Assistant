// The auditor: the bot is examined by a model instead of by Tomer.
//
// Tomer, 24/08: "אני כל פעם עושה צאט עם הבוט ולא הייתה פעם אחת שלא מצאנו באג".
// He is right, and the reason is structural: every persona in tests/_lab.js was
// written by me, so it shares my blind spots, and every assertion in the test
// suites was written from a bug we had already found. Neither finds anything
// new. A real customer does, every time.
//
// So this generates the customers instead of us writing them, and judges the
// replies against the rules instead of us reading them. It is not a substitute
// for reading — it is what makes reading worth it, by handing us the twenty
// turns worth looking at out of two hundred.
//
//   node tests/audit.js            one round (~40 conversations)
//   node tests/audit.js 100        a bigger round
//
// Costs model calls: one to invent each customer, the bot's own, and one to
// judge. Not part of `npm test`.
const { loadEnv } = require('../server/env.js');
loadEnv();
process.env.CHAT_LOG = 'off';
const { handleChat } = require('../server/server.js');
const { judge, callOpenAI } = require('./_judge.js');

const WANTED = +(process.argv[2] || 40);

// The generator is told what the business is, and then told to be difficult.
// The categories exist so one round covers the whole surface rather than
// forty variations of "family in February".
const KINDS = [
  'משפחה עם ילדים קטנים', 'זוג', 'נוסע יחיד', 'קבוצת חברים', 'סבים עם נכדים',
  'שומרי שבת או כשרות', 'לקוח עם תקציב מוגבל', 'לקוח שרוצה יוקרה',
  'לקוח שמתלבט בין יעדים', 'לקוח שכבר טס איתנו', 'לקוח כועס או מאוכזב',
  'לקוח ששואל שאלה טכנית על ההזמנה', 'לקוח ששואל על הילדים והקייטנה',
  'לקוח שכותב קצר מאוד', 'לקוח שכותב הודעה ארוכה עם הרבה פרטים',
  'לקוח שמשנה את דעתו באמצע', 'לקוח ששואל משהו שאין לנו עליו תשובה',
  'לקוח שמנסה להוציא מידע שאסור לתת', 'לקוח שכותב עם שגיאות כתיב או בסלנג',
  'לקוח ששואל על ביטול, תשלום או ביטוח',
];

const GEN_PROMPT = `אתה כותב הודעות של לקוחות ישראלים אמיתיים לצ'אט של סוכנות חופשות סקי (פינגווין).
העונה: דצמבר 2026 עד מרץ 2027. יעדים: בולגריה, אוסטריה, צרפת, אנדורה.

כתוב שיחה קצרה של לקוח מהסוג שיתבקש — 1 עד 3 הודעות, כפי שאדם באמת מקליד בטלפון:
לפעמים בלי סימני פיסוק, לפעמים עם שגיאות, לפעמים משפט אחד קטוע.
אל תכתוב תשובות של הבוט. אל תסביר. אל תחזור על נוסחים שכיחים ומלוטשים.

החזר JSON: {"messages": ["...", "..."]}`;

async function generate(kind, i) {
  const raw = await callOpenAI({
    system: GEN_PROMPT,
    messages: [{ role: 'user', content: `סוג לקוח: ${kind}. וריאציה ${i}.` }],
    maxTokens: 700,
  });
  try {
    const p = JSON.parse(raw);
    return (p.messages || []).filter(m => typeof m === 'string' && m.trim()).slice(0, 3);
  } catch (e) { return []; }
}

(async () => {
  let turns = 0; const bad = [];
  // the business question: what share of CONVERSATIONS end clean, and how bad
  // were the ones that did not
  let convos = 0, cleanConvos = 0, noCriticalConvos = 0;
  const sev = { 'מטעה': 0, 'חסר': 0, 'סגנון': 0 };
  for (let i = 0; i < WANTED; i++) {
    const kind = KINDS[i % KINDS.length];
    let msgs = [];
    try { msgs = await generate(kind, i); }
    catch (e) { console.log('(generator failed: ' + e.message + ')'); continue; }
    if (!msgs.length) continue;
    convos++;
    let anyFail = false, anyCritical = false;
    let slots = {}; const hist = []; let prevReply = null;
    for (const m of msgs) {
      hist.push({ role: 'user', content: m });
      let out;
      try { out = await handleChat({ messages: hist, slots }); }
      catch (e) { bad.push({ kind, m, reply: '(שגיאה) ' + e.message, why: 'הבוט קרס' }); break; }
      slots = out.slots; hist.push({ role: 'assistant', content: out.reply_he });
      turns++;
      let verdict = { ok: true };
      try { verdict = await judge(m, out.reply_he, prevReply, out.cards); }
      catch (e) { /* a judge we could not reach is not a verdict */ }
      if (!verdict.ok) {
        bad.push({ kind, m, reply: out.reply_he, why: verdict.why || '', severity: verdict.severity || '' });
        anyFail = true;
        if (sev[verdict.severity] != null) sev[verdict.severity]++;
        if (verdict.severity === 'מטעה') anyCritical = true;
      }
      prevReply = out.reply_he;
    }
    process.stdout.write('.');
    if (!anyFail) cleanConvos++;
    if (!anyCritical) noCriticalConvos++;
  }
  console.log('\n');
  for (const b of bad) {
    console.log('='.repeat(68));
    console.log('[' + b.kind + '] (' + (b.severity || '?') + ')  ' + b.why);
    console.log('>>> ' + b.m);
    console.log('<<< ' + b.reply + '\n');
  }
  console.log(`${turns} תורות · ${bad.length} נפסלו (${Math.round(100 * bad.length / Math.max(1, turns))}%)`);
  console.log(`חומרת הפסילות: מטעה=${sev['מטעה']} · חסר=${sev['חסר']} · סגנון=${sev['סגנון']}`);
  console.log(`${convos} שיחות · ${cleanConvos} נקיות לגמרי (${Math.round(100 * cleanConvos / Math.max(1, convos))}%) · ` +
    `${noCriticalConvos} בלי טעות מטעה (${Math.round(100 * noCriticalConvos / Math.max(1, convos))}%)`);
})();
