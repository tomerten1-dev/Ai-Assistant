// Standing answers (config/faq.json). Before these existed, a question with a
// question mark and no ski vocabulary got "אני כאן בעיקר להתאמת חופשות סקי" —
// so a customer asking about cancellation, kosher food or payment terms was
// told that is not our subject. These tests pin three things: the questions
// are answered, the answers obey the red rules, and the FAQ can never take a
// question that the red-rule deflector must own.
// Run: node tests/test-faq.js
// the tests must never write to the real conversation log: it is the weekly
// review's input, and synthetic turns bury the customers' real ones
process.env.CHAT_LOG = 'off';

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


/* ---- Aqaba and the 2023 precedent (Tomer, 26/08) ---- */
t('what we did last year is told as effort, never as a promise', () => {
  const a = nlu.faq('תוציאו אותנו דרך עקבה?');
  assert.ok(a && a.id === 'aqaba_precedent', 'answered: ' + (a && a.id));
  assert.ok(/כל שביכולתה/.test(a.he), 'says what the company did');
  assert.ok(/כל מקרה נבחן לגופו|אי אפשר להבטיח/.test(a.he), 'and that it is not a guarantee');
  assert.ok(!/נבטיח|מתחייב|בטוח שנוציא/.test(a.he), 'no promise: ' + a.he);
});
t('the October 2023 terms are never quoted', () => {
  // Tomer decided the bot does not repeat what was refunded then: it would read
  // as a commitment to do the same again.
  const MONEY_2023 = /אוקטובר 2023.*(€|יורו|₪|קרדיט מלא|בונוס|15)/s;
  for (const e of faqFile.entries) {
    assert.ok(!MONEY_2023.test(e.answer_he), 'the 2023 precedent is quoted in: ' + e.id);
    assert.ok(!/בניכוי €?15|קרדיט מלא \+ בונוס/.test(e.answer_he), 'the 2023 terms appear in: ' + e.id);
  }
  const a = nlu.faq('מה עשיתם באוקטובר 2023?');
  assert.ok(a && a.id === 'aqaba_precedent');
  assert.ok(!/2023/.test(a.he), 'the answer does not name the event: ' + a.he);
});
t('the guarantee answer no longer implies Aqaba is on offer', () => {
  const g = nlu.faq('מה זה Pingwin Guarantee?');
  assert.ok(g && g.id === 'war_protection');
  assert.ok(/אינו מובטח מראש|נבחן לגופו/.test(g.he), 'Aqaba is qualified: ' + g.he);
});

/* ---- age boundaries (Tomer, 26/08) ---- */
t('under four there is no group and no flexibility', () => {
  const a = nlu.faq('הבן שלי בן 3 ו-10 חודשים, אפשר לצרף לקייטנה?');
  assert.ok(a && /אין קבוצה ואין גמישות/.test(a.he), a && a.he);
});
t('15 to 17: no camp, but lessons in English can be booked through us', () => {
  for (const q of ['יש קייטנה לנער בן 16?', 'בן 15 יש לו קייטנה?', 'בת 17 יכולה להצטרף לקייטנה?']) {
    const a = nlu.faq(q);
    assert.ok(a && a.id === 'teen_camp', 'not answered: ' + q);
    assert.ok(/מגיל 15 אין קייטנה/.test(a.he), q);
    assert.ok(/מדריך מקומי באנגלית/.test(a.he), 'the alternative is named: ' + q);
  }
});
t('a teenager merely mentioned in a search is not lectured about camps', () => {
  // "זוג עם ילד בן 16, מרץ" is a request for offers, not a question about camps
  for (const q of ['זוג עם ילד בן 16, מרץ', 'משפחה עם בן 13 בפברואר']) {
    const a = nlu.faq(q);
    assert.ok(!a || a.id !== 'teen_camp', 'volunteered a camp answer to: ' + q);
  }
});

/* ---- phrasings the first live bank run exposed (26/08) ---- */
t('two-word questions reach the answer that already exists', () => {
  // Every one of these had an approved answer; only the pattern was missing,
  // so the customer got "לא בטוח שהבנתי" instead.
  for (const [q, id] of [
    ['מקבלים שקלים?', 'currency'],
    ['להעביר לחבר?', 'name_change'],
    ['אפשר לדחות?', 'change_date'],
    ['איך מגיעים?', 'flight_route'],
    ['משקפי סקי?', 'clothing'],
  ]) {
    const a = nlu.faq(q);
    assert.ok(a && a.id === id, `${q} → ${a ? a.id : 'nothing'} (expected ${id})`);
  }
});

/* ---- the second content questionnaire (Tomer, 26/08) ---- */
t('the twelve answers from the second questionnaire reach the customer', () => {
  for (const [q, id] of [
    ['משקפי סקי וכפפות כלולים בהשכרה?', 'clothing'],
    ['יש heli-ski?', 'offpiste_heli'],
    ['אפשר אוף פיסט עם מדריך?', 'offpiste_heli'],
    ['לנגלאוף?', 'cross_country'],
    ['רכבלים סגורים?', 'lifts_closed'],
    ['החזר אם המסלולים סגורים?', 'lifts_closed'],
    ['תותחי שלג?', 'snow_making'],
    ['יש תפריט ילדים?', 'kids_menu'],
    ['ארוחות ילדים?', 'kids_menu'],
    ['יש רופא ילדים באתר?', 'medical_on_site'],
    ['יש חבילה לסינגלים?', 'singles_package'],
    ['בולגריה בסדר לזוג חד מיני?', 'any_couple'],
    ['בחופשת פברואר עמוס?', 'busy_periods'],
    ['מעיינות חמים?', 'hot_springs'],
    ['חדר משחקים?', 'hotel_facility_unknown'],
    ['יש סנואו פארק?', 'snow_park'],
    ['יש בית קפה בכפר או שזה כפר מת?', 'village_life'],
    ['איזה bindings?', 'equipment_booking'],
    ['יש לסבא בן 74 מחלות רקע?', 'health_rules'],
  ]) {
    const a = nlu.faq(q);
    assert.ok(a && a.id === id, `${q} → ${a ? a.id : 'nothing'} (expected ${id})`);
  }
});
t('goggles and gloves are not part of the rental', () => {
  const a = nlu.faq('משקפי סקי?');
  assert.ok(/משקפי סקי וכפפות אינם חלק מהשכרת הציוד/.test(a.he), a.he);
  assert.ok(/בארץ/.test(a.he), 'most people buy them here first');
});
t('nothing we do not sell is offered: heli-ski, off-piste, cross-country', () => {
  for (const id of ['offpiste_heli', 'cross_country']) {
    const he = faqFile.entries.find(e => e.id === id).answer_he;
    assert.ok(/אינם? חלק מהחבילות|אינה משהו שאנחנו מסדרים/.test(he), id + ': ' + he);
    assert.ok(!/נסדר לכם|אפשר להזמין דרכנו/.test(he), id + ' offers it anyway');
  }
});
t('snow and lifts are never promised, and the answer says what we do instead', () => {
  const a = nlu.faq('רכבלים סגורים?');
  assert.ok(/לא מבטיחים שלג/.test(a.he) && /לא יכולים להבטיח/.test(a.he), a.he);
  assert.ok(/נבדק לגופו/.test(a.he) && /כל שביכולתה/.test(a.he), 'and what the company does: ' + a.he);
  assert.ok(!/נפצה|החזר כספי מלא|מתחייבים/.test(a.he), 'no promise of compensation: ' + a.he);
});
t('what we do not hold per hotel is sent to the site and to a person, never guessed', () => {
  for (const id of ['snow_making', 'hot_springs', 'hotel_facility_unknown', 'snow_park']) {
    const he = faqFile.entries.find(e => e.id === id).answer_he;
    assert.ok(/פינגווין|נציג/.test(he), id + ' does not point anywhere: ' + he);
    assert.ok(!/\b\d+\b/.test(he.replace(/4–12|12–13|04-8557722/g, '')), id + ' quotes a number: ' + he);
  }
});
t('every couple gets the same answer, and no lecture', () => {
  const a = nlu.faq('בולגריה בסדר לזוג חד מיני?');
  assert.ok(/מתאימות לכל זוג/.test(a.he), a.he);
  assert.ok(a.he.length < 320, 'short and matter of fact');
});
t('February is named as the busy week, with no period to avoid', () => {
  const a = nlu.faq('בחופשת פברואר עמוס?');
  assert.ok(/פברואר/.test(a.he) && /אין תקופה שאנחנו ממליצים להימנע/.test(a.he), a.he);
});
t('the new answers obey the red rules like the rest', () => {
  const NEW = ['offpiste_heli', 'cross_country', 'lifts_closed', 'snow_making', 'kids_menu',
    'medical_on_site', 'singles_package', 'any_couple', 'busy_periods', 'hot_springs',
    'hotel_facility_unknown', 'snow_park', 'village_life'];
  for (const id of NEW) {
    const e = faqFile.entries.find(x => x.id === id);
    assert.ok(e, 'missing entry: ' + id);
    assert.ok(!/₪|€|\$|שקל|יורו|דולר/.test(e.answer_he), 'money in ' + id);
    assert.ok(!/שעות נסיעה|\d+ דקות/.test(e.answer_he), 'travel time in ' + id);
    assert.ok(!/Belambra|Club Med|מלון [A-Z]/.test(e.answer_he), 'a hotel is named in ' + id);
  }
});


t('a leading question about the Hebrew escort is answered, not turned into a headcount question', () => {
  // the offline bank's only hard-rule failure: "שמאשרים ילדים במועדון גם בלי
  // מדריך עברית?" — the pattern knew "מדריך בעברית" and not "מדריך עברית"
  for (const q of ['שמאשרים ילדים במועדון גם בלי מדריך עברית?', 'יש מלווה ישראלי?']) {
    const a = nlu.faq(q);
    assert.ok(a && a.id === 'hebrew_staff', `${q} → ${a ? a.id : 'nothing'}`);
    assert.ok(/מלווה ולא מדריך/.test(a.he), 'the distinction survives: ' + q);
  }
});


console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
