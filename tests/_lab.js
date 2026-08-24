// A reading lab: many kinds of customer, plus automatic suspicion checks so a
// human eye goes to the turns most likely to be wrong instead of all of them.
// Not an assertion suite — flags are hints, and every flag is read.
//   node tests/_lab.js            all personas
//   node tests/_lab.js flags      only the turns that tripped a check
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-off';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-off';
process.env.CHAT_LOG = 'off';
const { handleChat } = require('../server/server.js');

const P = [
  ['סבים ונכדים', ['סבא וסבתא עם שני נכדים בני 9 ו-12, פברואר']],
  ['שתי משפחות יחד', ['אנחנו שתי משפחות, 4 מבוגרים ו-4 ילדים בני 6,8,10,13, פברואר']],
  ['רק סוף שבוע', ['אפשר רק לסופ"ש? אין לנו שבוע פנוי']],
  ['תקציב פתוח', ['זוג, התקציב לא מגביל, רוצים משהו יוקרתי בינואר']],
  ['שומרי שבת', ['משפחה שומרת שבת, 2+2 בני 7 ו-10, פברואר, ואוכל כשר']],
  ['מבקש מחיר מדויק שוב ושוב', ['זוג בפברואר', 'כמה זה עולה בשקלים?', 'נו תגיד לי מחיר']],
  ['מתחיל גולש', ['אף אחד מאיתנו לא גלש אף פעם, זוג, פברואר']],
  ['רוצה ללמוד לגלוש בגיל 50', ['אני בן 52 ומעולם לא גלשתי, זה מאוחר מדי?']],
  ['שואל על ילד בן 3', ['יש לנו ילד בן 3, הוא יכול לגלוש?']],
  ['מבקש להשוות מלונות', ['זוג בפברואר בבנסקו', 'מה עדיף קאזה קארינה או רגנום?']],
  ['בקשה משונה', ['אפשר לישון באוהל?']],
  ['הודעה ריקה', ['', 'אה סליחה, זוג בפברואר']],
  ['ניסוח שלילי', ['לא בולגריה ולא צרפת, זוג בפברואר']],
  ['שואל על חניה ורכב שכור', ['אנחנו שוכרים רכב, יש חניה במלון?']],
  ['לחוץ על תקציב', ['יש לנו עד 5000 שקל לזוג, אפשר?']],
  ['מזג אוויר וביטול', ['ואם לא יהיה שלג מבטלים? מקבלים החזר?']],
  ['שואל על גיל הילדים לקייטנה', ['ילדים בני 3 ו-14, יש קייטנה לשניהם?']],
  ['רוצה מלון ספציפי שכן קיים', ['אפשר את קאזה קארינה בפברואר לזוג?']],
  ['מדבר בסלנג', ['אחי מה יש לכם לפברואר לזוג משהו שווה?']],
  ['משנה מספר נוסעים תוך כדי', ['זוג בפברואר בבולגריה', 'רגע, מצטרפים אלינו עוד שניים']],
];

const FLAGS = [
  ['repeat', (r) => { const l = r.split('\n').filter(Boolean); return new Set(l).size !== l.length; }],
  ['wall', (r) => r.split('\n').filter(Boolean).length > 5],
  ['offtopic', (r) => /אני כאן בעיקר להתאמת/.test(r)],
  ['money', (r) => /\d[\d,.]*\s*(₪|\$|€|שקל|ש"ח|יורו|אירו)/.test(r)],
  ['promise', (r) => /מובטח|אני מבטיח|בטוח פנוי/.test(r)],
  ['internal', (r) => /התחייבו/.test(r)],
  ['best', (r) => /הכי טוב|הטוב ביותר/.test(r)],
  ['empty', (r) => !r.trim()],
];

const onlyFlags = process.argv[2] === 'flags';
let turns = 0, flagged = 0;

(async () => {
  for (const [label, msgs] of P) {
    let slots = {}; const hist = []; const lines = [];
    let any = false;
    for (const t of msgs) {
      hist.push({ role: 'user', content: t });
      const out = await handleChat({ messages: hist, slots });
      slots = out.slots; hist.push({ role: 'assistant', content: out.reply_he });
      turns++;
      const hits = FLAGS.filter(([, f]) => f(out.reply_he)).map(([n]) => n);
      if (hits.length) { flagged++; any = true; }
      lines.push('\n>>> ' + t);
      lines.push('<<< ' + out.reply_he);
      lines.push('    ' + (out.cards.map(c => c.hotel + ' ' + c.date.slice(5)).join(' | ') || '(אין)')
        + ((out.two_room_splits || []).length ? ' [' + out.two_room_splits.length + ' פיצולים]' : '')
        + (hits.length ? '   ⚑ ' + hits.join(',') : ''));
    }
    if (onlyFlags && !any) continue;
    console.log('\n' + '='.repeat(68));
    console.log('### ' + label);
    console.log(lines.join('\n'));
  }
  console.log('\n' + '='.repeat(68));
  console.log(turns + ' תורות, ' + flagged + ' סומנו');
})();
