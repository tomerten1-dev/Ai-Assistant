// PHRASING prompt — the model writes the Hebrew reply, and nothing else.
//
// The split that makes this safe: deterministic code has already decided WHAT
// is true (which units are free, which dates, which camp groups run, what the
// hotel page says). The model receives only that decision and turns it into
// something a person would say. It never sees the inventory, so it cannot
// invent a hotel, a date or an availability claim — the worst it can do is
// phrase the given facts badly, and validate() below catches the ways that
// matter.
//
// Templated phrasing remains in offline-nlu and is used verbatim whenever this
// call fails, is disabled, or produces output that fails validation.

const PHRASE_PROMPT = `אתה נציג של פינגווין, סוכנות חופשות סקי ישראלית. אתה כותב הודעה אחת בעברית ללקוח.

קיבלת JSON עם: מה הלקוח ביקש (slots), ההצעות שנבחרו עבורו (cards), והערות מהמערכת (notes).
תפקידך לנסח — לא להחליט ולא להוסיף מידע.

חוקים מוחלטים:
1. אל תכתוב שום עובדה שאינה ב-JSON. אין מלון, תאריך, מלצר, מסלול או שירות שלא מופיע שם.
2. אל תכתוב מחיר במספרים ואל תכתוב שם של לקוח או מספר הזמנה.
3. אל תבטיח זמינות. הניסוח הוא "נראה פנוי", "נציג יאשר סופית".
4. אל תכתוב "התחייבויות" — זו מילה פנימית שלנו.
5. אל תמציא שעות טיסה.
6. אם ב-notes כתוב שמשהו חסר או לא פועל — תגיד את זה בפירוש, אל תעגל פינות.
7. כל פריט ב-דברים_שהלקוח_ציין חייב לקבל התייחסות במשפט אחד — גם אם אי אפשר לסנן לפיו. אם זה משהו שנציג צריך לטפל בו, אמור שתעביר לנציג. אל תתעלם מאף פריט.
8. אל תמליץ "הכי טוב". אפשר "מומלץ".
9. הסבר בקצרה למה דווקא ההצעות האלה — קשור למה שהלקוח ביקש (חודש, יעד, גודל חבורה, קייטנה, ספא, תקציב). השתמש בשדה why של כל הצעה. משפט אחד או שניים, לא רשימה.
10. אל תנדב מידע שהלקוח לא ביקש ושלא משפיע על ההחלטה שלו. אם הוא לא שאל על ספא — אל תספר על הספא.
11. אל תסיים בקריאה לפעולה ("אפשר להמשיך להזמנה", "אשאיר לנציג לחזור אליכם") — המערכת מוסיפה את זה בעצמה פעם אחת. אתה כותב רק את גוף התשובה.
12. הלקוח קורא את התשובה הזו אחרי שכבר דיברתם. בשדה מה_כבר_אמרת נמצאת ההודעה הקודמת שלך — אל תחזור על אף נקודה שכבר נאמרה בה, ואל תסכם מחדש את מה שהלקוח ביקש. ענה על ההודעה האחרונה שלו בלבד.
13. אם יש ערך ב-יעד_שאין_לנו_עליו_מלאי — הלקוח ביקש יעד שאנחנו מוכרים אך אין לנו עליו מקום פנוי כרגע. ההסבר על כך כבר מוצג ללקוח מעליך; אל תחזור עליו ואל תכתוב שהלקוח לא ציין יעד.
14. דבר עם הלקוח, לא על ההצעות. אסור לכתוב משפטים כמו "ההצעות נבחרו כי הן מתאימות להרכבים של 5, 3 ו-6 נוסעים", "בהתאם לנימוקים של כל הצעה", "להרכבי הנוסעים שסומנו". הלקוח לא יודע מה זה הרכב, נימוק או סימון — אלה מילים מתוך המערכת. כתוב מה שאדם היה אומר: מה יש שם, למה זה מתאים למה שהם ביקשו, ומה חסר.
15. אל תקרא לחופשה "משפחתית" ואל תזכיר משפחה אם הלקוח לא הזכיר ילדים — תגית "משפחות" על כרטיס היא מאפיין של המלון, לא תיאור של מי שנוסע.
15ב. אל תכתוב כמה נוסעים הם, אלא אם הם אמרו. השדה fits בכרטיס הוא מה שהחדר מכיל, לא מי שנוסע — "מתאימות לחמישה נוסעים" נכתב ללקוח שלא אמר כמה הם, וזה נשמע כאילו לא הקשבת.
16. אתה רשאי לנקוב בשם המלון, בשם היישוב ובתאריך — הם מופיעים ב-JSON. עדיף משפט עם שם מלון אחד קונקרטי על פני משפט על "ההצעות" בכלליות.
17. שמות היישובים ב-JSON כתובים בעברית — השתמש בהם ככה. אל תכתוב "ב-Bansko" או "ב־Les Arcs" באמצע משפט בעברית. שם המלון עצמו נשאר כפי שהוא מופיע.
18. כתוב עברית בלבד. אין מילים באנגלית או תווים אקראיים, למעט שמות מלונות ויישובים כפי שהם מופיעים ב-JSON.
19. בשדה כבר_ענינו_בהודעה_הזו נמצא טקסט שכבר מוצג ללקוח בתשובה הזו עצמה, מעליך. אל תסתור אותו ואל תכתוב שאין לך תשובה על משהו שכבר נענה שם.
20. אם בלי_טיסות_בשבת הוא true — הסינון כבר בוצע: כל מה שמוצג הוא ללא טיסה בשבת. אמור זאת בביטחון ("בהתאם לבקשתכם, בלי טיסות בשבת"); אל תכתוב שאין לך תשובה על זה.

סגנון: עברית טבעית, חמה ועניינית. בלי אימוג'ים. בלי צורות לוכסן ("בן/בת", "ילד/ה") — כתוב בלשון רבים או נטרלית. עד 3 משפטים, ואל תחזור על מה שכתוב על הכרטיסים עצמם — הלקוח רואה אותם. התייחס למה שהלקוח ביקש בשמו, כדי שיהיה ברור שקראת.

החזר טקסט בלבד. בלי JSON, בלי כותרות, בלי רשימות.`;

// What the model is allowed to see about each offer. Deliberately narrow: no
// internal ids, no counts, no sheet names, no room codes from the workbook.
// Every resort we sell, in the Hebrew people actually say. Used for the model's
// prose — the cards themselves keep the name the site uses.
const RESORT_HE = {
  'Bansko': 'בנסקו', 'Borovets': 'בורובץ',
  'Mayrhofen': 'מאיירהופן', 'Ischgl': 'אישגל',
  'Val Thorens': 'ואל טורנס', 'Tignes': 'טיניי', 'Les 2 Alpes': 'לה דו אלפ',
  'Avoriaz': 'אבוריאז', 'Les Arcs': 'לז ארק', 'Les Menuires': 'לה מנואר',
  'Flaine Grand Massif': 'פליין גראנד מסיף', "Alpe d'Huez": "אלפ ד'ואז",
  'Montgenevre': 'מונז׳נבר', 'Oz en Oisans': 'עוז אן אואזן',
  'Soldeu': 'סולדאו', 'Pas de la Casa': 'פאס דה לה קאסה',
};

function cardDigest(c) {
  return {
    hotel: c.hotel,
    resort: RESORT_HE[c.resort] || c.resort,
    country_he: c.country_he,
    date_he: c.date_label ? `${c.date_label} ${c.date}` : c.date,
    nights: c.nights,
    room: c.room,
    fits: c.occ && c.occ.max,
    camps: c.camps ? { full: c.camps.full, running: c.camps.running, missing: c.camps.missing } : null,
    facts: c.facts_he || [],
    tags: c.tags || [],
    recommended: !!c.recommended,
    // why the deterministic filter picked this one — computed in offline-nlu
    // and sent so the model can explain the match instead of guessing at it
    why: c.why_he || null,
  };
}

function buildPayload({ slots, cards, result, fallback, lastReply, answered }) {
  return JSON.stringify({
    בקשת_הלקוח: {
      מבוגרים: slots.adults,
      גילאי_ילדים: slots.children_ages,
      חודש: ({ 12: 'דצמבר', 1: 'ינואר', 2: 'פברואר', 3: 'מרץ', any: 'גמיש' })[slots.month] || slots.month,
      // A comparison holds MORE than the one country the slot keeps — telling
      // the model only about Bulgaria made it call Mayrhofen "outside the
      // destination you asked for" to a customer who asked Austria-or-Bulgaria.
      משווים_בין: (slots.compare || []).map(p =>
        ({ france: 'צרפת', austria: 'אוסטריה', andorra: 'אנדורה', bulgaria: 'בולגריה' })[p.country] || p.destination) || undefined,
      // A destination we sell but hold nothing for is still a destination the
      // customer named. Leaving it out made the model write "מאחר שלא ציינתם
      // יעד" to someone who had just said Italy.
      יעד: slots.country || slots.destination || slots.off_commitment_destination || null,
      יעד_שאין_לנו_עליו_מלאי: slots.off_commitment_destination || null,
      לא_רוצים: [...(slots.excluded_countries || []), ...(slots.excluded_destinations || [])],
      דרישות: slots.unverifiable || [],
      העדפות: slots.preferences || [],
      בלי_טיסות_בשבת: !!slots.no_saturday_flights,
      לילות: slots.nights_wanted,
      דברים_שהלקוח_ציין: slots.notes_from_customer || [],
    },
    הצעות: cards.map(cardDigest),
    הערות_מערכת: (result.notes || []).map(n => n.type),
    הרחבות: (result.relaxed || []).map(r => r.type),
    // what we already said, so it neither repeats itself nor contradicts the
    // FAQ paragraph printed above it in the same reply
    מה_כבר_אמרת: (lastReply || '').slice(0, 600) || null,
    כבר_ענינו_בהודעה_הזו: (answered || '').slice(0, 600) || null,
    הנוסח_התבניתי: fallback,   // the deterministic wording, as a floor to beat
  });
}

// The output guard. Anything the model could get wrong in a way that costs
// money or trust is checked here, and a failure means we ship the template.
function validate(text, { cards, fallback }) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: 'empty' };
  if (t.length > 700) return { ok: false, why: 'too long' };

  // red rule 3 — no sums of money
  if (/\d[\d,.]*\s*(₪|\$|€|שקל|ש"ח|שח|יורו|אירו)/.test(t)) return { ok: false, why: 'price' };
  // red rule 2 — no order numbers
  if (/\d{6}/.test(t)) return { ok: false, why: 'order number' };
  // internal vocabulary
  if (/התחייבו/.test(t)) return { ok: false, why: 'internal wording' };
  // red rule 4 — never promise availability outright
  if (/(מובטח|בטוח פנוי|אני מבטיח|מבטיחים לכם)/.test(t)) return { ok: false, why: 'promise' };
  // red rule 8 — no flight times
  if (/\b\d{1,2}:\d{2}\b/.test(t)) return { ok: false, why: 'flight time' };
  // red rule 6
  if (/הכי טוב|הטוב ביותר/.test(t)) return { ok: false, why: 'superlative' };

  // Writing ABOUT the offers instead of to the customer. Three audit rounds in
  // a row flagged the same handful of constructions, all of them lifted
  // straight out of our own JSON field names.
  if (/ההצעות (נבחרו|מתאימות|הוצגו|שנבחרו|שמוצגות)|האפשרויות (נבחרו|מתאימות|שמוצגות|שנמצאו|שנבחרו|שמופיעות)|להרכב(ים)? של|שסומנו|נימוק|בהתאם לנימוקים|ההצעה נבחרה|הסינון בוצע|נבחרו עבורכם|נבחרו (משום|כי|בגלל)|רוכזו (כאן|עבורכם)|מתאימות לבקשה שלכם|תואמות לבקשה|האפשרויות כוללות|עשויות להתאים להרכבים|מתאימות להרכבים/.test(t)) {
    return { ok: false, why: 'writes about the offers, not to the customer' };
  }

  // red rule 1 — every hotel it names must be one we actually offered
  const shown = cards.map(c => c.hotel);
  for (const name of KNOWN_HOTELS) {
    if (!shown.includes(name) && t.includes(name)) return { ok: false, why: 'hotel not offered: ' + name };
  }
  // Latin letters that are not the name of something we showed. The model
  // emitted the word "Baebele" mid-sentence to a customer; nothing caught it,
  // because every other check is about what the words MEAN.
  // any letter from a script that is neither Hebrew nor Latin is never a
  // hotel name we sell — the model once emitted an Armenian word mid-sentence
  // An allow-list, not a block-list: the block-list missed Devanagari and
  // Gujarati, and "विकल्प" and "જણ" reached customers mid-sentence.
  {
    const stray = String(t).replace(/[֐-׿ -~ -ÿ\s]/g, '')
      .replace(/[—–…״׳“”‘’·•₪€°]/g, '');
    if (stray) return { ok: false, why: 'foreign script: ' + stray.slice(0, 12) };
  }
  {
    const allowed = new Set();
    for (const c of cards) {
      for (const part of [c.hotel, c.room, (c.facts_he || []).join(' ')]) {
        for (const w of String(part || '').split(/[^A-Za-z]+/)) if (w) allowed.add(w.toLowerCase());
      }
    }
    for (const w of ['pingwin', 'guarantee', 'wifi', 'wi', 'fi', 'ski', 'in', 'out', 'spa']) allowed.add(w);
    for (const w of String(t).split(/[^A-Za-z]+/)) {
      if (w && !allowed.has(w.toLowerCase())) return { ok: false, why: 'foreign word: ' + w };
    }
  }

  // Every date it names must be one we put in front of it — either an offered
  // departure, or one the deterministic layer already named in the template
  // (camp weeks, dates free of a commitments restriction).
  const allowed = new Set([
    ...cards.flatMap(c => datesOf(c)),
    ...datesIn(fallback || ''),
  ]);
  for (const key of datesIn(t)) {
    if (!allowed.has(key)) return { ok: false, why: 'invented date: ' + key };
  }
  return { ok: true };
}

// "5.2", "ב-26.2", "19/03" → "5.2" / "26.2" / "19.3"
function datesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?![\d])/g)) {
    out.push(+m[1] + '.' + +m[2]);
  }
  return out;
}

function datesOf(c) {
  if (!c.date) return [];
  const [y, m, d] = c.date.split('-');
  return [+d + '.' + +m];
}

// Loaded once; used only to catch the model naming a hotel we did not offer.
const KNOWN_HOTELS = (() => {
  try {
    return Object.keys(require('../data/resorts.json').hotels);
  } catch (e) { return []; }
})();

module.exports = { PHRASE_PROMPT, buildPayload, validate, cardDigest };
