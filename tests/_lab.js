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
  ['משנה דעת על הקייטנה', ['משפחה 2+2 בני 6 ו-9, פברואר, בולגריה', 'צריך קייטנה', 'בעצם לא צריך קייטנה']],
  ['שואל שאלה אחרי שאלה', ['זוג בפברואר', 'יש ספא?', 'ויש בריכה?', 'ואינטרנט?', 'וחניה?']],
  ['מבקש לדבר עם נציג מיד', ['אני רוצה לדבר עם נציג עכשיו']],
  ['מבטל את הבקשה', ['לא רוצה כלום, סתם בדקתי']],
  ['שואל על תוספת יחיד', ['אני נוסע לבד, יש תוספת ליחיד?']],
  ['רוצה חדר לעשן בו', ['אפשר חדר מעשנים?']],
  ['שואל על מלון ספציפי ותאריך', ['רגנום ב-12.2 לזוג']],
  ['מזכיר ילד עם צרכים מיוחדים', ['לבן שלי יש אוטיזם, יש קייטנה שתתאים?']],
  ['לא מרוצה מהתשובה', ['זוג בפברואר', 'זה לא עונה לי']],
  ['רוצה לשנות רק את החודש', ['זוג בפברואר בבולגריה', 'ובמרץ?']],
  ['שואל אם אפשר לשלם בהמשך', ['אפשר לשריין עכשיו ולשלם אחר כך?']],
  ['ילדים בגילאים שונים מאוד', ['2 מבוגרים, ילדים בני 2, 7 ו-15, פברואר']],
  ['רוצה לדעת מה גודל החדר', ['כמה מטרים החדר?']],
  ['מבקש מלון עם מעלית סקי צמודה', ['רוצה מלון ממש על המסלול, לא לנסוע בכלל']],
  ['שואל על ילדים שלא גולשים', ['הילד הקטן לא יגלוש, יש מה לעשות איתו?']],
  ['שואל על חילוץ וביטוח סקי', ['אם נשבר לי רגל במדרון מי משלם?']],
  ['בודק זמינות ברגע האחרון', ['יש משהו לשבוע הבא?']],
  ['רוצה לדעת אם יש טיסה ישירה', ['הטיסה ישירה או עם עצירה?']],
  ['מתעניין באוסטריה בלבד', ['רק אוסטריה, זוג, ומה יש בינואר?']],
  ['שואל על החזר אם חולים', ['ואם נחלה יומיים לפני?']],
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
