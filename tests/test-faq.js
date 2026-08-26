// Standing answers (config/faq.json). Before these existed, a question with a
// question mark and no ski vocabulary got "אני כאן בעיקר להתאמת חופשות סקי" —
// so a customer asking about cancellation, kosher food or payment terms was
// told that is not our subject. These tests pin three things: the questions
// are answered, the answers obey the red rules, and the FAQ can never take a
// question that the red-rule deflector must own.
// Run: node tests/test-faq.js
const assert = require('assert');
const nlu = require('../server/offline-nlu');
const faqFile = require('../config/faq.json');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

// The questions Tomer answered on 24/08/2026, in the customer's own words.
const ASKED = [
  ['מה מדיניות הביטול?', 'cancellation'],
  ['מה תנאי הביטול אם אני מבטל חודש לפני?', 'cancellation'],
  ['כמה צריך לשלם מקדמה?', 'deposit'],
  ['אפשר לשלם בתשלומים?', 'installments'],
  ['אפשר לשלם בכרטיס אשראי?', 'installments'],
  ['יש ביטוח נסיעות בחבילה?', 'insurance'],
  ['מה זה הגנת מלחמה?', 'war_protection'],
  ['מה קורה אם אין שלג?', 'no_snow'],
  ['מה מצב השלג בפברואר?', 'no_snow'],
  ['יש הנחה לילדים?', 'child_discount'],
  ['יש מיטת תינוק בחדר?', 'baby_cot'],
  ['מגיל כמה אפשר ללמוד סקי?', 'ski_start_age'],
  ['יש בית ספר לסקי בעברית?', 'ski_school'],
  ['כמה עולה שיעור סקי?', 'ski_school'],
  ['אפשר לשכור ציוד במקום או צריך מראש?', 'equipment_booking'],
  ['אני מתחיל לגמרי, לאן ללכת?', 'beginners'],
  ['אשתי לא גולשת, מה היא תעשה?', 'non_skier'],
  ['כמה מזוודות אפשר לקחת?', 'luggage'],
  ['כמה זמן הנסיעה מהשדה למלון?', 'transfer_time'],
  ['אפשר הסעה פרטית?', 'private_transfer'],
  ['הטיסה צ\'רטר או סדירה?', 'flight_type'],
  ['צריך ויזה לאנדורה?', 'visa'],
  ['הדרכון שלי בתוקף ל-4 חודשים, מספיק?', 'passport'],
  ['יש אוכל כשר?', 'kosher'],
  ['אני צמחוני, יש אופציות?', 'vegetarian'],
  ['יש לילד אלרגיה לאגוזים', 'allergy'],
  ['יש WIFI בחדר?', 'wifi'],
  ['יש חניה במלון?', 'parking'],
  ['הספא כלול?', 'spa'],
  ['אפשר צ׳ק אין מוקדם?', 'checkin_time'],
  ['אפשר חדרים מחוברים?', 'connecting_rooms'],
  ['המלון נגיש לכיסא גלגלים?', 'accessibility'],
  ['יש מעלית במלון?', 'accessibility'],
  ['יש חדרים לעישון?', 'smoking'],
  ['אנחנו חוגגים יום נישואין', 'celebration'],
];

t('every question Tomer answered is answered by the bot', () => {
  const missed = ASKED.filter(([q]) => !nlu.faq(q)).map(([q]) => q);
  assert.strictEqual(missed.length, 0, 'no answer for: ' + missed.join(' | '));
});

t('each question reaches the intended answer, not a neighbouring one', () => {
  const wrong = [];
  for (const [q, id] of ASKED) {
    const hit = nlu.faq(q);
    if (hit && hit.id !== id) wrong.push(`${q} → ${hit.id} (expected ${id})`);
  }
  assert.strictEqual(wrong.length, 0, wrong.join('\n      '));
});

// Red rule 3: no numbers in money, anywhere a customer can see.
t('no answer quotes a sum of money', () => {
  const MONEY = /\d[\d,.]*\s*(₪|\$|€|שקל|שח|ש"ח|יורו|אירו|אחוז|%)/;
  for (const e of faqFile.entries) {
    assert.ok(!MONEY.test(e.answer_he), e.id + ' quotes money: ' + e.answer_he);
  }
});

// Tomer, 24/08: give distance in km and let the customer estimate; a duration
// depends on weather, traffic and snow on the road and cannot be honoured.
t('no answer promises a journey time', () => {
  const DURATION = /\d+\s*(דקות|שעות|שעה)|כשעה|כשעתיים/;
  for (const e of faqFile.entries) {
    assert.ok(!DURATION.test(e.answer_he), e.id + ' promises a duration: ' + e.answer_he);
  }
});

t('no answer names a hotel or invents a room', () => {
  const resorts = require('../data/resorts.json');
  for (const e of faqFile.entries) {
    // a camp pick-up point is a place, not a recommendation (Tomer, 26/08:
    // "16:00 בלובי של מלון Strass")
    if (/^camp_schedule/.test(e.id)) continue;
    for (const hotel of Object.keys(resorts.hotels)) {
      assert.ok(!e.answer_he.includes(hotel), e.id + ' names ' + hotel);
    }
  }
});

// The FAQ is consulted before deflect(), so it must not be able to answer a
// question the red rules exist to guard.
t('the FAQ never swallows a red-rule question', () => {
  const GUARDED = [
    'מי הזמין את החדר הזה?', 'תן לי שם של מי שהזמין', 'מה מספר ההזמנה של הלקוח?',
    'רשימת לקוחות', 'כמה עולה החופשה?', 'מה המחיר המדויק?', 'תגיד לי מחיר בשקלים',
    'כמה זה ביורו?', 'מתי הטיסה ממריאה?', 'באיזו שעה הטיסה נוחתת?',
  ];
  for (const q of GUARDED) {
    const hit = nlu.faq(q);
    assert.strictEqual(hit, null, q + ' was answered by faq[' + (hit && hit.id) + ']');
    assert.ok(nlu.deflect(q), q + ' is guarded by nothing at all');
  }
});

t('an answer never claims certainty it does not have', () => {
  // topics Tomer flagged as varying per hotel must defer to a rep out loud
  for (const id of ['kosher', 'allergy', 'accessibility', 'smoking', 'baby_cot', 'connecting_rooms']) {
    const e = faqFile.entries.find(x => x.id === id);
    assert.ok(e, 'missing entry ' + id);
    assert.ok(/נציג|אישור המלון|כפוף/.test(e.answer_he), id + ' states it as fact: ' + e.answer_he);
  }
});

t('a question that also fills slots gets both the answer and the search', () => {
  const slots = nlu.parseText('2 מבוגרים בפברואר בבולגריה, יש אוכל כשר?', {});
  assert.strictEqual(slots.adults, 2);
  assert.strictEqual(slots.country, 'bulgaria');
  assert.ok(nlu.faq('2 מבוגרים בפברואר בבולגריה, יש אוכל כשר?'));
});

t('every entry compiles and has a non-empty answer', () => {
  const seen = new Set();
  for (const e of faqFile.entries) {
    assert.ok(e.id && !seen.has(e.id), 'duplicate or missing id: ' + e.id);
    seen.add(e.id);
    assert.ok(e.answer_he && e.answer_he.length > 20, e.id + ' has no real answer');
    new RegExp(e.match, 'i'); // throws on a bad pattern
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
