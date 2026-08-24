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
  ['משפחה מורחבת', ['אנחנו 3 משפחות, 6 מבוגרים ו-7 ילדים בגילאי 4 עד 14, פברואר']],
  ['משנה חודש ואז חוזר', ['זוג בינואר', 'בעצם מרץ', 'לא, נחזור לינואר']],
  ['שואל על הטיסה', ['מאיזה שדה הטיסות?', 'וכמה זמן הטיסה?']],
  ['מבקש המלצה לילדים', ['איזה יעד הכי מתאים לילדים קטנים?']],
  ['מתלונן', ['היינו אצלכם בשנה שעברה ולא היינו מרוצים']],
  ['שואל על ביטול מאוחר', ['זוג בפברואר', 'ואם נצטרך לבטל שבוע לפני?']],
  ['שני זוגות', ['שני זוגות חברים בפברואר, רוצים שני חדרים צמודים']],
  ['ילד בודד עם הורה', ['אני והבן שלי בן 11, מרץ']],
  ['רוצה אנדורה דווקא', ['זוג שרוצה דווקא אנדורה במרץ']],
  ['שואל על מזג אוויר', ['מה הטמפרטורות שם בפברואר?']],
  ['רוצה לשלם עכשיו', ['זוג בפברואר בבולגריה', 'אני רוצה לשלם עכשיו ולסגור']],
  ['שואל על מסלולים', ['כמה מסלולים יש בבנסקו?']],
  ['טעות כתיב קשות', ['משפחה של 4 עם ילדים בני 6 ו 9 בפברואר באוסטריה צריכים קיטנא בעברית וספא']],
  ['אחרי הצעה שואל על חדר', ['זוג בפברואר באוסטריה', 'מה גודל החדר ואיך המיטות?']],
  ['מבקש שקט', ['זוג מבוגר, רוצים מקום שקט בלי צעירים, ינואר']],
  ['שואל על הסעות', ['איך מגיעים משדה התעופה למלון?']],
  ['ערבוב שאלות', ['זוג במרץ, יש וויפי ובריכה ומה עם חניה?']],
  ['מבקש משהו שאין', ['זוג בפברואר בשוויץ']],
  ['משפחה עם נוער', ['זוג עם שני נערים בני 14 ו-16, פברואר']],
  ['סוגר עסקה', ['זוג בפברואר בבולגריה', 'מעולה, קח את קאזה קארינה', 'מה עכשיו?']],
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
