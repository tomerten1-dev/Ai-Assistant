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
  ['שיחה ארוכה עד סגירה', ['היי', '2 מבוגרים ו-2 ילדים בני 5 ו-11', 'פברואר', 'בולגריה', 'צריך קייטנה בעברית', 'מה כולל המחיר?', 'כמה עולה השכרת ציוד?', 'מעולה, ניקח את הראשון', 'תחזרו אליי']],
  ['מתלבט בין שתי הצעות', ['משפחה 2+2 בני 8 ו-11, פברואר, צרפת', 'מה ההבדל בין השניים הראשונים?', 'ומה עם הספא?']],
  ['רוצה תאריך מדויק', ['זוג ב-14.2 לבנסקו']],
  ['ילד בן שנה', ['זוג עם תינוק בן שנה, ינואר']],
  ['שואל על מרחק מהמסלול', ['כמה רחוק המלון מהמסלול?']],
  ['רוצה ארוחת ערב', ['אנחנו רוצים חצי פנסיון, זוג בפברואר']],
  ['מתעקש על מלון שאין', ['אני רוצה את מלון הילטון בבנסקו']],
  ['שואל אחרי הצעה על החדר', ['זוג בפברואר בבולגריה', 'איזה חדר זה בדיוק?']],
  ['מבטל ומתחיל מחדש', ['משפחה 2+3, מרץ, אוסטריה', 'בעצם תשכח מהכל, זוג בלבד לבולגריה']],
  ['שואל למה אין', ['משפחה של 6 באנדורה בדצמבר', 'למה אין?']],
  ['מברר על מדריך פרטי', ['אפשר מדריך פרטי בעברית?']],
  ['רוצה לדעת מי אתה', ['אתה בוט או בן אדם?']],
  ['כותב הכל באנגלית', ['family of 4, two kids aged 7 and 9, february, bulgaria']],
  ['שואל על שעות טיסה', ['באיזו שעה הטיסה יוצאת?']],
  ['תלונה', ['הייתי אצלכם בשנה שעברה והמלון היה מאכזב']],
  ['מבקש הנחה', ['יש הנחה אם מזמינים עכשיו?']],
  ['רוצה חדר מחובר', ['משפחה של 5, צריך חדרים מחוברים, פברואר']],
  ['אמא לבד עם ילדים', ['אני לבד עם שני ילדים בני 6 ו-9, פברואר']],
  ['שואל על העברות משדה', ['כמה זמן ההעברה מהשדה למלון?']],
  ['רוצה הכל כלול', ['יש אופציה של הכל כלול?']],
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
