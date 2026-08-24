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
  ['מבלבל את עצמו', ['זוג בפברואר', 'לא, אנחנו שלושה', 'סליחה, ארבעה עם שני ילדים בני 5 ו-8']],
  ['שואל על תאריך שעבר', ['אפשר בדצמבר 2025?']],
  ['מבקש הצעה במייל', ['אפשר לשלוח לי את זה למייל?']],
  ['מלון שלא קיים באנגלית', ['do you have the Kempinski in Bansko?']],
  ['שאלה על ילד בן 13', ['ילד בן 13, הוא בקייטנה או עם המבוגרים?']],
  ['רוצה שני יעדים בשבוע אחד', ['אפשר חצי שבוע בבנסקו וחצי בבורובץ?']],
  ['שואל על מזוודות וסקי', ['אפשר לקחת מגלשיים משלי בטיסה?']],
  ['לחוץ מהתחייבות', ['אם אני משאיר פרטים זה מחייב אותי במשהו?']],
  ['משתמש בשמות מלונות שלנו', ['מה ההבדל בין קאזה קארינה לוויהרן?']],
  ['שואל על שעת צ׳ק אין', ['מתי אפשר להיכנס לחדר?']],
  ['רוצה מתנה ליום הולדת', ['אני רוצה להפתיע את אשתי ליום הולדת, זוג, פברואר']],
  ['שואל על מספר מסלולים', ['כמה מסלולים יש בבנסקו?']],
  ['רוצה לדעת אם כדאי דצמבר', ['כדאי לנסוע בדצמבר או לחכות לפברואר?']],
  ['ילדים תאומים', ['יש לנו תאומים בני 5 ועוד ילד בן 9, פברואר']],
  ['שואל אם הצוות מחוסן', ['יש דרישות בריאות מיוחדות?']],
  ['רוצה חדר עם נוף', ['אפשר חדר עם נוף להרים?']],
  ['בודק על ביטוח ילדים', ['הביטוח מכסה גם את הילדים?']],
  ['שואל אחרי הצעה על הקייטנה', ['משפחה 2+2 בני 6 ו-9, פברואר בבולגריה', 'הקייטנה כלולה במחיר?']],
  ['שולח מספר טלפון', ['תחזרו אליי 050-1234567']],
  ['מבקש לבטל שיחה', ['תפסיק לשלוח לי הצעות']],
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
