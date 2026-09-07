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
  // (?![א-ת]) — the Hebrew word-boundary trap, 5th occurrence in this
  // project: without it "מידה 42 אירופית" reads as "42 אירו".
  const MONEY = /\d[\d,.]*\s*(₪|\$|€|שקל|שח|ש"ח|יורו|אירו|אחוז|%)(?![א-ת])/;
  for (const e of faqFile.entries) {
    assert.ok(!MONEY.test(e.answer_he), e.id + ' quotes money: ' + e.answer_he);
  }
});

// Tomer, 24/08: give distance in km and let the customer estimate; a duration
// depends on weather, traffic and snow on the road and cannot be honoured.
t('no answer promises a journey time', () => {
  // The rule (Tomer, 24/08) is about JOURNEY durations — the transfer, the
  // flight, the road. A policy duration ("המחיר נשמר ל-48 שעות", his own
  // wording, 31/08) is not a journey; require travel context, exactly like
  // the phrase guard does.
  const DURATION = /(\d+\s*(דקות|שעות|שעה)|כשעה|כשעתיים)\s*(נסיעה|העברה|טיסה|בדרך|מהשדה|משדה)|(נסיעה|העברה|הדרך)\s*(של\s*)?(כ-?\s*)?(\d+\s*(דקות|שעות|שעה)|כשעה|כשעתיים)/;
  for (const e of faqFile.entries) {
    assert.ok(!DURATION.test(e.answer_he), e.id + ' promises a journey duration: ' + e.answer_he);
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


/* ---- the first typical-customer live run (26/08): 6 of 100 missed ---- */
t('what the live run of ordinary customer questions left unanswered', () => {
  for (const [q, id] of [
    ['בית מרקחת?', 'medical_on_site'],
    ['טובוגן ארוך?', 'snow_park'],
    ['אפשר סקיפס 5 ימים ל-6 לילות?', 'skipass_days'],
    ['צרפת יקרה יותר או שזה מיתוס?', 'country_price'],
  ]) {
    const a = nlu.faq(q);
    assert.ok(a && a.id === id, `${q} → ${a ? a.id : 'nothing'} (expected ${id})`);
  }
});
t('a price comparison between countries answers without ranking or a number', () => {
  const a = nlu.faq('צרפת יקרה יותר או שזה מיתוס?');
  assert.ok(!/₪|€|\$|יורו|שקל/.test(a.he), 'money: ' + a.he);
  assert.ok(/אין לזה תשובה גורפת/.test(a.he), a.he);
});
t('a Shabbat ski pass question still belongs to the Shabbat answer', () => {
  // "סקיפס ל-6 ימים" is asked by a religious family, not by someone shortening
  // the week — skipass_days must not take it
  assert.strictEqual(nlu.faq('סקיפס ל-6 ימים').id, 'shabbat_hotel');
});

// ── פברואר בצרפת ──────────────────────────────────────────────────────────
// תומר ראה את הבוט עונה על "למה אין בפברואר?" תשובה כללית על מלאי (why_none),
// במקום הסיבה האמיתית. 26/08.
t('"למה אין בפברואר" מקבל את הסיבה, לא הסבר כללי על מלאי', () => {
  const a = nlu.faqMulti('למה אין בפברואר?');
  assert.ok(a, 'לא נמצאה תשובה בכלל');
  assert.strictEqual(a.all[0].id, 'france_february', 'ענה ' + a.all[0].id);
  assert.ok(/וואקאנס/.test(a.he), 'בלי הסיבה: ' + a.he);
  assert.ok(!a.all.some(x => x.id === 'why_none'), 'התשובה הכללית נגררה אחריה');
});
t('גם כשהלקוח נוקב בצרפת במפורש', () => {
  for (const q of ['למה אין צרפת בפברואר?', 'למה לא צרפת בפברואר', 'אין לכם צרפת בפברואר?']) {
    const a = nlu.faqMulti(q);
    assert.ok(a && a.all[0].id === 'france_february', q + ' → ' + (a && a.all[0].id));
  }
});
t('"למה אין כלום" עדיין מקבל את התשובה הכללית', () => {
  const a = nlu.faqMulti('למה אין כלום?');
  assert.strictEqual(a.all[0].id, 'why_none');
});
t('התשובה על פברואר תואמת את מה שבאמת בטבלה', () => {
  // אם פינגווין יתחילו למכור צרפת בפברואר, או יפסיקו בינואר/מרץ, התשובה הזאת
  // הופכת לשקר — והבדיקה הזאת תיפול לפני שלקוח יקרא אותה
  const units = require('../data/availability.json').units;
  const monthsFR = new Set(units.filter(u => u.country === 'france')
    .map(u => Number(u.date.slice(5, 7))));
  assert.ok(!monthsFR.has(2), 'יש עכשיו יציאות לצרפת בפברואר — התשובה כבר לא נכונה');
  assert.ok(monthsFR.has(1) && monthsFR.has(3), 'התשובה מבטיחה ינואר ומרץ');
  const feb = new Set(units.filter(u => Number(u.date.slice(5, 7)) === 2).map(u => u.country));
  for (const c of ['austria', 'bulgaria', 'andorra']) {
    assert.ok(feb.has(c), 'התשובה מבטיחה ' + c + ' בפברואר, ואין');
  }
});
t('אין מספרי כסף בתשובה החדשה', () => {
  const e = require('../config/faq.json').entries.find(x => x.id === 'france_february');
  const g = require('../config/guidance.json').messages_he.france_february_he;
  for (const txt of [e.answer_he, g]) {
    assert.ok(!/[€$₪]|\d+\s*(אירו|יורו|שקל|דולר)/.test(txt), 'כסף בטקסט: ' + txt);
  }
});


/* ---- routing defects found by the 30/08 test run ---- */

t('"ביטול" reaches the cancellation answer, not the payment one', () => {
  // "ביט" (the payment app) is a substring of ביטול, and Hebrew letters are not
  // \w so \b cannot separate them. A customer asking about cancelling was told
  // about credit cards — the worst kind of wrong answer, a confident one.
  for (const q of ['ביטול', 'ומה עם ביטול?', 'מה עם ביטול', 'אפשר לבטל?',
                   'מדיניות הביטול', 'דמי ביטול', 'ביטול הזמנה']) {
    const hit = nlu.faq(q);
    assert.ok(hit, 'no answer at all for: ' + q);
    assert.strictEqual(hit.id, 'cancellation', q + ' → ' + hit.id);
  }
});

t('...and the payment app still reaches the payment answer', () => {
  for (const q of ['אפשר לשלם בביט?', 'ביט או פייפאל?', 'העברה בנקאית אפשרית?']) {
    assert.strictEqual((nlu.faq(q) || {}).id, 'payment_methods', q);
  }
  assert.strictEqual((nlu.faq('צריך ביטוח נסיעות?') || {}).id, 'insurance');
});

t('childcare while the parents ski is answered, not called off-topic', () => {
  // nine of these in the question bank, and every one got "אני כאן בעיקר
  // להתאמת חופשות סקי" — to the question that decides whether a young family
  // books at all
  for (const q of ['מה עושים עם התינוק בזמן שאנחנו גולשים?', 'יש שמרטפות?',
                   'מי שומר על הילד בזמן שאנחנו על המסלול?', 'מה עושים עם ילד בן 2?',
                   'איפה משאירים את התינוק?', 'יש מסגרת לתינוק בן שנה?']) {
    assert.strictEqual((nlu.faq(q) || {}).id, 'non_skiing_child', q);
  }
});

t('a buying signal is recognised as one', () => {
  for (const q of ['המשך להזמנה', 'אני רוצה להזמין', 'בואו נסגור', 'ניקח את הראשון',
                   'אני רוצה את זה', 'איך מזמינים?', 'תזמין לי את זה']) {
    assert.strictEqual((nlu.faq(q) || {}).id, 'next_step', q);
  }
});

t('"הציוד כלול?" is answered like "מה כלול"', () => {
  for (const q of ['הציוד כלול?', 'השכרת ציוד בתשלום?', 'סקי פס כלול?', 'מה נכנס במחיר?']) {
    assert.strictEqual((nlu.faq(q) || {}).id, 'whats_included', q);
  }
});

/* ---- what the 100-question LIVE run got wrong (30/08) ---- */

t('a question about dates is answered with dates', () => {
  const { SkiSearch } = require('../data/filter.js');
  const e = new SkiSearch();
  // the answer sat in the workbook while the bot asked "כמה תהיו בסך הכל?"
  assert.ok(e.departureDates({ holiday: 'חנוכה' }).length, 'no Hanukkah departures found');
  assert.ok(e.departureDates({ holiday: 'פורים' }).length >= 3, 'Purim flies on three days');
  assert.deepStrictEqual(e.departureDates({ from: '2026-12-22', to: '2026-12-29' }), [],
    'setup: December 22-29 should be empty, which is what makes the honest answer honest');
  assert.ok(e.departureDates({ month: 2 }).length > 5, 'February departures vanished');
});

t('shopping and duty-free go to a person, not to a guess', () => {
  // no data anywhere in the project says what Andorra costs, so the only
  // honest answers are "a rep will know" — never an invented one
  for (const q of ['אנדורה זה דיוטי פרי, שווה?', 'יש דיוטי פרי באנדורה?', 'כדאי לקנות באנדורה?']) {
    const hit = nlu.faq(q);
    assert.ok(hit && hit.id === 'shopping_duty_free', q + ' → ' + (hit || {}).id);
    assert.ok(/נציג/.test(hit.he), 'does not hand it to a person: ' + hit.he);
    assert.ok(!/זול|יקר|כדאי לקנות שם/.test(hit.he), 'made a claim about prices: ' + hit.he);
  }
});

t('a fridge or safe in the room is a per-hotel question', () => {
  for (const q of ['מקררון?', 'יש מקרר בחדר?', 'כספת בחדר?', 'מיני בר בחדר?']) {
    assert.ok((nlu.parseText(q, {}).unverifiable || []).includes('מקרר בחדר'), q);
  }
});

t('asking to see photos is answered — every card carries a gallery', () => {
  for (const q of ['אפשר לראות תמונות/סרטון של המלון?', 'יש תמונות?', 'איך המלון נראה?']) {
    assert.strictEqual((nlu.faq(q) || {}).id, 'hotel_photos', q);
  }
});

t('a per-hotel question is never treated as gibberish or off topic', () => {
  // "מקררון?" on an empty chat: understood (it sets a topic), but there is no
  // card to answer it yet — that is a pointer, not "לא בטוח שהבנתי"
  for (const q of ['מקררון?', 'כספת בחדר?', 'יש חדר כושר?']) {
    assert.ok((nlu.parseText(q, {}).unverifiable || []).length, q + ' set no topic');
  }
});

t('HEBREW SUBSTRING TRAP: a topic never fires on a word that merely contains it', () => {
  // \b does not work after Hebrew letters in JS, so any bare word in a pattern
  // matches inside longer words. It cost us three separate bugs in one day:
  // "ביט" inside ביטול, "ישן" inside פלייסטיישן, "חדש" inside "עולים חדשים".
  // Each one made the bot answer a question nobody asked.
  const traps = [
    ['פלייסטיישן?', 'שיפוץ'],
    ['יש הנחה לעולים חדשים?', 'שיפוץ'],
    ['ילד ישן בחדר?', 'שיפוץ'],
    ['כושר גופני נדרש?', 'חדר כושר'],
  ];
  for (const [q, topic] of traps) {
    const got = nlu.parseText(q, {}).unverifiable || [];
    assert.ok(!got.includes(topic), q + ' still matched "' + topic + '": ' + JSON.stringify(got));
  }
  // ...while the real questions still land
  for (const [q, topic] of [['המלון ישן?', 'שיפוץ'], ['מתי שופץ המלון?', 'שיפוץ'],
                            ['יש חדר כושר?', 'חדר כושר']]) {
    assert.ok((nlu.parseText(q, {}).unverifiable || []).includes(topic), q);
  }
});

t('PRIVACY: who else is on our departure is refused, not answered', () => {
  // Found by the full offline sweep, 30/08. These were neither guarded nor
  // answered — the bot simply asked how many people were travelling. They
  // cannot be answered without saying something about customers who never
  // agreed to it.
  for (const q of ['יש עוד משפחות ישראליות באותו תאריך?', 'יש עוד משפחות דתיות באותה יציאה?',
                   'מי עוד נרשם לתאריך הזה?', 'כמה אנשים כבר הזמינו?', 'מי איתנו בטיסה?']) {
    const g = nlu.guard(q);
    assert.ok(g, q + ' was not refused');
    assert.ok(/לא אוכל לשתף|אין לי גישה לפרטי לקוחות/.test(g), q + ' → ' + g);
  }
});

t('...and ordinary "יש עוד" questions still get through', () => {
  // "יש עוד ישראלים בקבוצה?" is about what our groups are like, not about
  // who booked a week — it has its own answer (persona P03, 03/09)
  for (const q of ['יש עוד אפשרויות?', 'יש עוד מלונות בבנסקו?', 'כמה אנשים נכנסים לחדר?',
                   'יש עוד תאריכים בפברואר?', 'מי המדריך בקייטנה?', 'יש עוד ישראלים בקבוצה?', 'יש עוד משפחות דתיות?']) {
    assert.ok(!nlu.guard(q), q + ' was refused by mistake: ' + nlu.guard(q));
  }
  assert.strictEqual((nlu.faqMulti('יש עוד ישראלים בקבוצה?') || {}).id, 'israelis_group');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
