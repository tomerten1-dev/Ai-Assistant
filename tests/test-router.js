// Does the model route to the right approved answer?
//
// The regex layer answers by matching words; this asks the model which answer
// applies. The question is whether it is at least as good — measured on the
// questions Tomer actually answered, asked twice: once in the words the
// patterns already know, and once the way a different customer would say it.
//
// Costs a model call per line, so it is not part of `npm test`:
//   node tests/test-router.js
const { loadEnv } = require('../server/env.js');
loadEnv();
const offline = require('../server/offline-nlu.js');
const routerMod = require('../server/answer-router.js');
const { callOpenAI } = require('../server/openai.js');

const entries = offline.faqEntries();
const system = routerMod.buildPrompt(entries);

// [question, expected id]. The paraphrases are the point: none of them repeats
// the pattern's own vocabulary.
const CASES = [
  ['מה מדיניות הביטול?', 'cancellation'],
  ['אני צריך לדעת אם אפשר להחזיר את הכסף אם משהו ישתבש', 'cancellation'],
  ['צריך לשלם מקדמה?', 'deposit'],
  ['אם אנחנו מזמינים היום, מתי אני משלם בפועל?', 'deposit'],
  ['אפשר לפרוס לתשלומים?', 'installments'],
  ['אפשר לחלק את זה לכמה חיובים בכרטיס?', 'installments'],
  ['הביטוח כלול?', 'insurance'],
  ['צריך לקנות ביטוח בנפרד או שזה מסודר?', 'insurance'],
  ['מגיל כמה מקבלים לקייטנה?', 'ski_start_age'],
  ['הקטן שלנו בן 3 וחצי, הוא יכול להשתתף?', 'ski_start_age'],
  ['הקייטנה כלולה במחיר?', 'camp_price'],
  ['על הקייטנה משלמים בנפרד או שזה בתוך החבילה?', 'camp_price'],
  ['יש ספא במלון?', 'spa'],
  ['אפשר להשתמש בבריכה ובסאונה בלי לשלם?', 'spa'],
  ['יש אינטרנט?', 'wifi'],
  ['אפשר לעבוד מהמלון? צריך רשת טובה', 'wifi'],
  ['יש אוכל כשר?', 'kosher'],
  ['אנחנו שומרי כשרות, מה האפשרויות שלנו שם?', 'kosher'],
  ['כמה זמן הנסיעה מהשדה?', 'transfer_time'],
  ['אחרי שנוחתים, כמה זה לוקח עד שאנחנו בחדר?', 'transfer_time'],
  ['אפשר חדרים מחוברים?', 'connecting_rooms'],
  ['אנחנו רגילים לישון עם דלת פתוחה בין החדרים, יש כזה?', 'connecting_rooms'],
  ['מתי כדאי להזמין?', 'when_to_book'],
  ['יש טעם לחכות או שכדאי לסגור עכשיו?', 'when_to_book'],
  ['מי מלמד את הילדים בקייטנה?', 'ski_school'],
  ['ההדרכה בעברית או שהילדים לא יבינו כלום?', 'ski_school'],
  ['יש השכרת ציוד?', 'equipment_booking'],
  ['את המגלשיים לוקחים שם או מביאים מהבית?', 'equipment_booking'],
  ['יש חניה במלון?', 'parking'],
  ['אנחנו שוכרים רכב, איפה מחנים?', 'parking'],
  ['מה שעת הצ׳ק אין?', 'checkin_time'],
  ['אפשר להיכנס לחדר מוקדם ביום הראשון?', 'checkin_time'],
  ['צריך ויזה?', 'visa'],
  ['צריך אישור כניסה מיוחד לאירופה?', 'visa'],
  // and the ones that must NOT route anywhere
  ['זוג בפברואר בבולגריה', null],
  ['משפחה של 4 עם ילדים בני 6 ו-9', null],
  ['תראה לי משהו באוסטריה', null],
];

(async () => {
  let ok = 0, wrong = 0, missed = 0;
  for (const [q, want] of CASES) {
    let got = null;
    try {
      const raw = await callOpenAI({ system, messages: [{ role: 'user', content: q }], maxTokens: 600 });
      const hit = routerMod.pick(raw, entries);
      got = hit ? hit.id : null;
    } catch (e) { got = 'ERROR:' + e.message; }
    const pass = got === want;
    if (pass) ok++;
    else if (want && !got) missed++;
    else wrong++;
    if (!pass) console.log(`  ✗ ${q}\n      want ${want} · got ${got}`);
  }
  console.log(`\n${ok}/${CASES.length} routed correctly · ${wrong} wrong · ${missed} missed`);
})();
