// OFFLINE demo mode — deterministic Hebrew understanding, zero AI, zero cost.
// Used automatically when no ANTHROPIC_API_KEY is configured. When Tomer adds
// a key to .env the server upgrades itself to Claude (server.js decides).
// Not as flexible as Claude, but honors the exact same slot schema and the
// same conversation policy (max 2 questions, one per message).

const { SkiSearch } = require('../data/filter.js');

const HE_NUM = {
  'אחד': 1, 'אחת': 1, 'שניים': 2, 'שתיים': 2, 'שני': 2, 'שתי': 2,
  'שלושה': 3, 'שלוש': 3, 'שלושת': 3, 'ארבעה': 4, 'ארבע': 4, 'ארבעת': 4,
  'חמישה': 5, 'חמש': 5, 'חמשת': 5, 'שישה': 6, 'שש': 6, 'ששת': 6,
  'שבעה': 7, 'שבע': 7, 'שמונה': 8, 'תשעה': 9, 'תשע': 9, 'עשרה': 10, 'עשר': 10,
};
function heNum(w) { return HE_NUM[w] || null; }

// Patterns are deliberately spelling-tolerant. Real customers type "ינוואר",
// "צרפט", "חיפא" — and a missed destination is not a harmless miss: an
// unrecognised "חיפא" would have offered a Haifa customer flights to France.
const MONTHS = [
  [/דצמבר|דצמבר|חנוכה|דצמ(?![א-ת])/, 12],
  [/ינו?ו?א?ר|ינאור|ינו['׳](?![א-ת])/, 1],
  [/פברו?א?ר|פבואר|פברוא|פבר(?![א-ת])/, 2],
  [/מר[ץץז]|מארס|מרס|פורים/, 3],
];
const COUNTRIES = [
  [/צרפ[תט]/, 'france'], [/אוסטרי+[הא]?/, 'austria'],
  [/אנדור[הא]/, 'andorra'], [/בולגרי+[הא]/, 'bulgaria'],
];
const DESTS = [
  [/מ[אי]?יי?רהופן|מאירהופן/, 'Mayrhofen', 'austria'], [/אישגי?ל/, 'Ischgl', 'austria'],
  [/ו?ואל ?טורנס/, 'Val Thorens', 'france'], [/טין(?![א-ת])|טיניי|Tignes/i, 'Tignes', 'france'],
  [/לה ?דוז|לה ?דו ?אלפ|לה 2|les 2/i, 'Les 2 Alpes', 'france'], [/בנסק[וו]?/, 'Bansko', 'bulgaria'],
  [/בורוב[ץץז]/, 'Borovets', 'bulgaria'], [/אבורי?אז/, 'Avoriaz', 'france'],
  [/לז ?ארק|לה ?ארק/, 'Les Arcs', 'france'], [/פליין|גרנד ?מסיף/, 'Flaine Grand Massif', 'france'],
  [/אלפ ד|אלף ד/, "Alpe d'Huez", 'france'], [/מונט?ז['׳״"]?נבר/, 'Montgenevre', 'france'],
  // Les Menuires was missing entirely — "לה מנואר" named a resort we sell and
  // the bot heard nothing, so it could be neither asked for nor ruled out
  [/לה ?מנו[אי]?ר|מנואר|les ?menuires/i, 'Les Menuires', 'france'],
  [/סולד[אי]?ו|soldeu/i, 'Soldeu', 'andorra'], [/עוז אן|oz.?en/i, 'Oz en Oisans', 'france'], [/פ[א]?ס ?דה ?לה ?קאסה|פאס(?![א-ת])/, 'Pas de la Casa', 'andorra'],
];
// Resorts and brands pingwin sells, but which carry NO room commitments in
// the winter 26/27 workbook.
//
// Tomer, 23/08: these ARE sellable — but only on dates that are not under a
// "מכירת התחייבויות בלבד" restriction, and always subject to confirmation
// with the hotel. So the bot must not claim they are unavailable, and must
// not quote availability for them either: it says what it has on commitment,
// and hands the rest to a rep.
const OFF_COMMITMENT = [
  [/זאלבאך|סאלבאך/, 'זאלבאך', 'austria'], [/צל אם ?זה|צל ?אם|zell/i, 'צל אם זה', 'austria'],
  [/סנט ?אנטון|st\.? ?anton/i, 'סנט אנטון', 'austria'], [/הינטרגלם/, 'הינטרגלם', 'austria'],
  [/קצברג/, 'קצברג', 'austria'],
  [/ואל ?ד'?יזר|val ?d/i, "ואל ד'יזר", 'france'], [/לה ?פלאן|la ?plagne/i, 'לה פלאן', 'france'],
  [/קלאב ?מד|club ?med/i, 'קלאב מד', null],
  [/פראגלטו|פרגלטו/, 'פראגלטו', null], [/סוצ'?י/, "סוצ'י", null],
  [/סנט ?מוריץ/, 'סנט מוריץ', null], [/דולומיטים|איטליה/, 'איטליה', null],
  [/שוויץ/, 'שוויץ', null],
];

// Customers describe what they want, not our tag names: "סאונה וג'קוזי" is
// a spa request and "מרחק הליכה קצר מהמעליות" is a slopes-proximity request.
const PREFS = [
  [/אפרה|חיי לילה|(?:^|[^א-ת])ברים(?![א-ת])|פאבים/, 'אפרה-סקי'],
  [/ספא|סאונה|ג'?קוזי|בריכה|עיסוי|מרחץ/, 'ספא'],
  [/קרוב למסלול|על המסלול|קרוב למעלי|ליד המעלי|הליכה קצרה|מרחק הליכה קצר|ski ?in/i, 'קרוב למסלולים'],
  [/שקט|רגוע|לא רועש/, 'שקט'],
  [/מתחיל|לא גלשנו|פעם ראשונה|ללמוד לגלוש/, 'מתחילים'],
  [/זול|תקציב|חסכוני|משתלם|לא יקר|שלא יהיה יקר|יקר מדי|לקרוע את הכיס|במחיר נמוך|מחיר שפוי/, 'תקציב'],
  [/עיירה|אטרקציות|בילויים|דברים לעשות|אווירה טובה|אווירה/, 'עיירה תוססת'],
  [/הכל כלול/, 'הכל כלול'],
  [/משפח|ילדים קטנים/, 'משפחות'],
];

// is the word at `idx` preceded by a negation? covers "לא צרפת",
// "לא רוצים צרפת", "חוץ מצרפת", "בלי צרפת", "מלבד צרפת", "לא לצרפת"
function isNegated(t, idx) {
  const before = t.slice(Math.max(0, idx - 24), idx);
  // the leading ו matters: in "לא צרפת ולא בולגריה" the second negation is
  // written "ולא", and missing it left Bulgaria selected — the exact bug again
  return /(?:^|[^א-ת])ו?(?:לא|בלי|בלא|חוץ ?מ|מלבד|למעט|פרט ל)\s*(?:רוצים?|רוצה|מעוניינים?|מעוניין|צריכים?|צריך|רוצות)?\s*(?:ל|ב|מ|את)?\s*$/.test(before);
}

function parseText(text, slots) {
  const s = { ...slots };
  // normalise before matching: hyphens used as word separators ("זוג-בלי-ילדים")
  // and repeated punctuation ("ינואר!!!") otherwise defeat every pattern below.
  // A hyphen BETWEEN DIGITS is left alone — "5-9" is an occupancy range.
  // Hebrew keyboards and copy-paste bring niqqud along; זוּג and זוג are the
  // same word to a reader and two different strings to a regex.
  const t = ' ' + text
    .replace(/[\u0591-\u05C7]/g, '')
    // "3 ו-10 חודשים" is one age, not two numbers
    .replace(/(\d{1,2})\s*ו-?\s*\d{1,2}\s*חודשים/g, '$1 וחצי')
    .replace(/[\u05F4\u201C\u201D]/g, '"')
    .replace(/[\u05F3\u2018\u2019]/g, "'")
    .replace(/([א-ת])[-–—]([א-ת])/g, '$1 $2')
    .replace(/[!?.,]{2,}/g, ' ')
    .replace(/\s+/g, ' ').trim() + ' ';

  // "בעצם תשכח מהכל" — starting over. Merging the new sentence into the old
  // answers a question the customer just withdrew. It runs before the other
  // parsers, so what the same sentence goes on to say is kept.
  if (/תשכח מהכל|תשכחי מהכל|נתחיל מחדש|בוא נתחיל מהתחלה|תתחיל מחדש|תמחק הכל|שכח מה שאמרתי/.test(t)) {
    for (const k of ['month', 'country', 'destination', 'month_part', 'exact_day', 'hotel',
      'nights_wanted', 'needs_hebrew_kids_club', 'wants_two_rooms']) s[k] = null;
    s.children_ages = []; s.no_children = null; s.adults = null;
    s.preferences = []; s.excluded_countries = []; s.excluded_destinations = [];
  }

  // The question we just asked is the strongest signal about what this
  // message means. A bare "4" after "באילו גילאים?" is an AGE — never a count.
  const answering = s._lastQuestion || null;
  const askedChildren = answering === 'children' || answering === 'children_ages';
  // set by the children block below; the adults block must not also swallow
  // a bare number that was plainly an answer about the children
  const expectingAgesRef = { value: false };
  const allNums = [...t.matchAll(/(?:^|[^\d])(\d{1,2})(?![\d])/g)].map(x => +x[1]);

  // --- explicit "no children"
  if (/בלי ילדים|אין ילדים|רק מבוגרים|ללא ילדים|לא נוסעים ילדים/.test(t) ||
      (askedChildren && /^ ?(לא|אין|לא נוסעים|בלי) ?$/.test(t))) {
    s.no_children = true; s.children_ages = []; s.children_count = 0;
  } else {
    // --- ages stated with an age word: "ילדים בני 5 ו-9", "ילד בן 7", "גילאי 4 ו-6"
    // The chunk must span commas: "בני 4, 6, 9, 12" is FOUR children, and
    // stopping at the first comma silently dropped three of them — which
    // books a room for the wrong number of people. It stops at a month name
    // instead, so "בני 5 ו-9, פברואר" doesn't swallow the date.
    // The age words need Hebrew boundaries. Without them "לא בשבת" matched the
    // "בת" inside "שבת" and invented a 2-year-old out of "יש 2 חברים שומרים",
    // which then cost the party an adult. JS \b does not work here.
    // a decimal ("12.5") is not a sentence end; "נהיה 13" states an age too
    const ageChunk = t.match(/(?:^|[^א-ת])(?:בני|בנות|בגילאי|גילאי|בגיל|בן|בת|(?:הבן|הבת|הילד|הילדה|הוא|היא) (?:נהיה|נהיית|יהיה|תהיה))(?![א-ת])(?:[^.!?]|\.(?=\d)){0,45}/g);
    let ages = [], grownUps = 0;
    if (ageChunk) {
      for (let chunk of ageChunk) {
        // stop at a month, and at "קייטנה של 4" — that 4 is a club, not a child
        chunk = chunk.split(/ינואר|פברואר|מרץ|מארס|דצמבר|חנוכה|פורים|קייטנה|קבוצה|מועדון|קיטנה/)[0];
        // "3 ו-10 חודשים", "בת שלוש וחצי", "3.5" — the whole years count now,
        // and the boundary is flagged so the bot says how the age is reckoned
        chunk = chunk.replace(/(\d{1,2})\s*ו-?\s*\d{1,2}\s*חודשים/g, (m0, y) => { s.age_boundary = +y; return y; })
          .replace(/(\d{1,2})\s*וחצי/g, (m0, y) => { s.age_boundary = +y; return y; })
          .replace(/(\d{1,2})[.,]5(?![\d])/g, (m0, y) => { s.age_boundary = +y; return y; })
          .replace(/(שלוש|ארבע|חמש|שש|שבע|שמונה|תשע|עשר|אחת עשרה|שתים עשרה) וחצי/g, (m0, w) => { s.age_boundary = HE_NUM[w] != null ? HE_NUM[w] : null; return w; });
        if (/(נהיה|תהיה|יהיה|יגיע|תגיע|ימלאו|חוגג|חוגגת) .{0,12}(לפני|עד|ב) ?(הטיסה|היציאה|הנסיעה|חודש|קרוב)/.test(chunk)) s.age_boundary = s.age_boundary ?? -1;
        for (const m of chunk.matchAll(/(?:^|[^\d])(\d{1,2})(?![\d])/g)) {
          const n = +m[1];
          if (n >= 0 && n <= 17) ages.push(n);
          // 18 and over is an adult, whatever the sentence called them
          else if (n >= 18 && n <= 99) grownUps++;
        }
        // ages spelled out: "בני שש ותשע"
        if (!ages.length) {
          for (const w of chunk.split(/[^א-ת]+/)) {
            // "שש ותשע" — the second number carries the connecting vav
            const n = HE_NUM[w] != null ? HE_NUM[w] : HE_NUM[w.replace(/^ו/, '')];
            if (n != null && n >= 1 && n <= 17) ages.push(n);
          }
        }
      }
    }
    // ages written as words: "תינוק בן שנה", "בן שנתיים"
    if (!ages.length) {
      if (/בן שנה|בת שנה|תינוק בן שנה/.test(t)) ages = [1];
      else if (/שנתיים/.test(t)) ages = [2];
    }
    // --- bare numbers ARE the ages when we know there are children and do not
    // know how old they are. This used to require having JUST asked, which
    // stopped working the moment a question stopped being repeated.
    const expectingAges = expectingAgesRef.value = askedChildren ||
      ((s.no_children === false || s.children_count) && !(s.children_ages || []).length);
    if (!ages.length && expectingAges && /^[\s\d,.\u05d5-]+$/.test(t)) {
      ages = allNums.filter(n => n >= 0 && n <= 17).slice(0, 4);
    }
    // Remembered, not applied: the adults parser runs further down and would
    // overwrite the sum. "ילד בן 18" is an adult, whatever the sentence called
    // them, and asking "בן כמה הילד?" after being told 18 reads as not listening.
    if (grownUps) s._grownUps = grownUps;
    if (ages.length) {
      // "צריך קבוצה לילד בן 4" names one child out of two, and used to replace
      // the whole list — a family of four silently became a family of three
      // and was quoted the wrong room. A single age that we already know about
      // is a reference to a child, not a new census. A full re-count ("הילדים
      // בני 4, 8") replaces, because that IS a census.
      const known = s.children_ages || [];
      const oneKnownChild = ages.length === 1 && known.length > 1 && known.includes(ages[0]);
      if (!oneKnownChild) { s.children_ages = ages; }
      s.no_children = false;
    }

    // --- child COUNT when no ages given yet: "שני ילדים", "3 ילדים",
    //     "ילד אחד", and bare singular "ילד" / "ילדה" (Hebrew has no \b)
    if (!(s.children_ages || []).length) {
      const cm = t.match(/(\d{1,2}|[א-ת]+)\s*ילדים|(\d{1,2})\s*קטנים/);
      if (cm) { const n = +cm[1] || heNum(cm[1]) || +cm[2]; if (n) { s.children_count = n; s.no_children = false; } }
      else if (/(?:^|[^א-ת])(?:ילד|ילדה|בת|בן)(?![א-ת])/.test(t) || /ילד אחד|ילדה אחת/.test(t)) {
        s.children_count = 1; s.no_children = false;
      }
      // "זוג עם ילדים" — plural with no number. We do not know HOW MANY, but we
      // certainly know there ARE children, and asking "נוסעים גם ילדים?" after
      // the customer just said so reads as not having listened.
      if (/(?:^|[^א-ת])(?:ילדים|ילדות|קטנים|הילדים)(?![א-ת])/.test(t) && !/בלי ילדים|ללא ילדים|אין ילדים/.test(t)) {
        s.no_children = false;
      }
      // "וילד בן 18" was counted BOTH as a child here and as an adult above,
      // and "אנחנו 2" then had that phantom child subtracted from it — a party
      // of three came out as one adult.
      if (s._grownUps && s.children_count) {
        s.children_count = Math.max(0, s.children_count - s._grownUps);
        if (!s.children_count) { s.no_children = true; s.children_ages = []; }
      }
    }
    // "2 ילדים 5+9" — once we know HOW MANY children there are, a digit pair
    // is their ages rather than another party count. Must run after the count
    // above, or there is nothing to disambiguate against.
    if (!(s.children_ages || []).length && s.children_count) {
      const pair = t.match(/(?:^|[^\d])(\d{1,2})\s*\+\s*(\d{1,2})(?![\d])/);
      if (pair && +pair[1] <= 17 && +pair[2] <= 17 &&
          !(+pair[1] === s.adults && +pair[2] === s.children_count)) {
        s.children_ages = [+pair[1], +pair[2]];
        s.no_children = false;
      }
    }
  }

  // --- adults: "זוג", "2 מבוגרים", "אנחנו 4", "4 אנשים"
  // A correction ("בעצם 4", "סליחה, 3") must override an earlier number —
  // silently keeping the first one books the wrong size room.
  const correcting = /בעצם|סליחה|טעות|תתקן|לא נכון|התכוונתי|שיניתי|בעצמנו/.test(t);
  if (/(?:^|[^א-ת])(?:אני לבד|לבד|רק אני|נוסע לבד|נוסעת לבד)(?![א-ת])/.test(t) && !/חדר לבד/.test(t)) {
    s.adults = 1;
    // travelling alone answers the children question too — asking it anyway
    // reads as not having listened
    if (!(s.children_ages || []).length && !s.children_count) {
      s.no_children = true; s.children_ages = [];
    }
  }
  // "חדר ליחיד", "חדר סינגל" — one traveller, said through the room
  if (/חדר ליחיד|לנוסע יחיד|חדר סינגל|אני יחיד/.test(t) && s.adults == null) s.adults = 1;
  if (s.adults === 1 && !(s.notes_from_customer || []).includes('חופשה לנוסע יחיד')) {
    s.notes_from_customer = [...(s.notes_from_customer || []), 'חופשה לנוסע יחיד'];
  }
  // "שני זוגות" is four people, not two
  let pm = t.match(/(\d{1,2}|[א-ת]+)\s*זוגות/);
  if (pm) { const n = +pm[1] || heNum(pm[1]); if (n) s.adults = n * 2; }
  else if (/זוג(?!ל|ות)/.test(t) && (s.adults == null || correcting)) {
    s.adults = 2;
    // "אנחנו זוג" means two, no children — unless children are named, which
    // the children parser handles and overrides
    if (!(s.children_ages || []).length && !/ילד|קטנ|תינוק|נכד/.test(t)) s.no_children = s.no_children ?? true;
  }
  // "שני הורים" / "ההורים" — parents are adults
  let hm = t.match(/(\d{1,2}|[א-ת]+)\s*הורים/);
  if (hm) { const n = +hm[1] || heNum(hm[1]); if (n) s.adults = n; }
  else if (/ההורים|הורים/.test(t) && s.adults == null) s.adults = 2;
  // "סבא וסבתא עם שני נכדים" — two adults, said without the word מבוגרים
  else if (/סבא ו?סבתא|סבתא ו?סבא/.test(t) && s.adults == null) s.adults = 2;
  // "אנחנו רוצים חופשה עם שני נכדים בני 8 ו-11" — the grandchildren were counted
  // and the grandparents were not, so every offer was sized for two people
  // short of the family.
  else if (/נכד|נכדה|נכדים|נכדות/.test(t) && s.adults == null) s.adults = 2;
  // "עם 3 נכדים" — grandchildren are children; without ages we still know how
  // many seats they take. A party of five was being offered rooms for two.
  {
    const g = t.match(/(\d{1,2}|שני|שתי|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש)\s*נכד(?:ים|ות)?(?![א-ת])/);
    if (g && !(s.children_ages || []).length && s.children_count == null) {
      const n = +g[1] || heNum(g[1]);
      if (n >= 1 && n <= 8) { s.children_count = n; s.no_children = false; }
    }
  }

  // "2+2" — the standard Israeli shorthand for two adults and two children
  if (s.adults == null && !/מבוגר/.test(t)) {
    const pp = t.match(/(?:^|[^\d])(\d)\s*\+\s*(\d)(?![\d])/);
    if (pp) {
      s.adults = +pp[1];
      // "2+2 בני 6 ו-9" states the children twice; the ages are the better
      // half, so the count is only taken when no ages were given.
      if (+pp[2] && !(s.children_ages || []).length) {
        s.children_count = +pp[2]; s.no_children = false;
      }
    }
  }
  let m = t.match(/(\d{1,2}|[א-ת]+)\s*(?:מבוגר[יי]?[םמ]|גדולים)/);
  if (m) s.adults = +m[1] || heNum(m[1]) || s.adults;
  // an explicit party statement always wins, corrected or not
  // "4 חברים לסנובורד" states the party as plainly as "4 אנשים" does; missing
  // it sent a group of four to be asked "כמה מבוגרים?" they had just answered.
  // Word numbers count too ("שני חברים"). "בנים"/"בנות" are left out on
  // purpose — they usually mean children.
  // "משפחה של 4" is the Israeli 2+2 until told otherwise — assuming four
  // ADULTS put "ארבעה מבוגרים" in front of a family
  {
    const fam = t.match(/משפחה של (\d{1,2})(?![\d])/);
    if (fam && s.adults == null && !(s.children_ages || []).length && !/מבוגר/.test(t)) {
      const total = +fam[1];
      if (total >= 3 && total <= 8) { s.adults = 2; s.children_count = total - 2; s.no_children = false; }
    }
  }
  // "הבן נהיה 13" is a birthday, not thirteen travellers
  const childTurns = /(הבן|הבת|הילד|הילדה|הוא|היא|הקטן|הקטנה|הגדול|הגדולה) (נהיה|נהיית|יהיה|תהיה) ?\d/.test(t);
  m = (childTurns ? null : t.match(/(?:אנחנו|נהיה|סה"כ|סהכ)\s*(\d{1,2}|שניים|שתיים|שלושה|שלוש|ארבעה|ארבע|חמישה|חמש|שישה|שש|שבעה|שבע|שמונה)(?![א-ת])/)) ||
      t.match(/(\d{1,2}|[א-ת]+)\s*(?:אנשים|נוסעים|אורחים|חברים|חברות|בחורים|בחורות|גברים|נשים)(?![א-ת])/);
  if (m) {
    const total = +m[1] || heNum(m[1]);
    if (total) {
      // the children may be known by age OR only by count — "אנחנו 5 עם שלושה
      // ילדים" said five adults before this, and would have booked for eight
      const kids = (s.children_ages || []).length || s.children_count || 0;
      s.adults = kids && total > kids ? total - kids : total;
    }
  }
  // "בעצם 4" — a bare number that is explicitly a correction
  if (correcting) {
    const cm = t.match(/(?:בעצם|סליחה|טעות|התכוונתי|שיניתי)[^\d]{0,12}(\d{1,2})(?!\d)/);
    if (cm) {
      const n = +cm[1];
      const kids = (s.children_ages || []).length;
      if (n >= 1 && n <= 20) s.adults = kids && n > kids ? n - kids : n;
    }
  }
  // "משפחה של 4" / "4 נפשות" with known kids
  if (s.adults == null) {
    m = t.match(/(?<!קייטנה |קבוצה |מועדון |קיטנה |בגיל |גיל )(?:משפחה של|של)\s*(\d{1,2})/);
    if (m) {
      const total = +m[1], kids = (s.children_ages || []).length;
      // "משפחה של 5, הילדים בני 6 ו-9" → three adults.
      // "משפחה של 4" alone is still four travellers; leaving adults unknown
      // meant asking "כמה מבוגרים?" of someone who had just said.
      if (kids && total > kids) s.adults = total - kids;
      else if (!kids && total >= 1 && total <= 20) s.adults = total;
    }
  }
  // the over-18s counted among the "children" join the adults
  if (s._grownUps) {
    s.adults = (s.adults || 0) + s._grownUps;
    if (!(s.children_ages || []).length && !s.children_count) {
      s.no_children = true; s.children_ages = [];
    }
    delete s._grownUps;
  }

  // "אני ואחי", "אני, אשתי ו..." — count adult person-words.
  // NOTE: JS \b doesn't work with Hebrew letters, so boundaries are explicit.
  if (s.adults == null) {
    const people = [];
    for (const m2 of t.matchAll(/(?:^|[^א-ת])(?:ו|ש|וש|כש)?(אני|אחי|אחותי|אשתי|בעלי|בן זוגי|בת זוגי|אמא שלי|אבא שלי|חבר שלי|חברה שלי|סבא|סבתא)(?![א-ת])/g)) people.push(m2[1]);
    const uniq = new Set(people);
    if (uniq.has('אני') && uniq.size >= 2) s.adults = uniq.size;
  }

  // A message written in English. The model handles these in production; this
  // is the floor beneath it, so an English sentence is not parsed as silence.
  {
    const en = String(text || '').toLowerCase();
    if (/[a-z]{3}/.test(en) && !/[א-ת]/.test(en)) {
      const EN_M = [[/january|jan\b/, 1], [/february|feb\b/, 2], [/march|mar\b/, 3], [/december|dec\b/, 12]];
      for (const [re, v] of EN_M) if (re.test(en) && s.month == null) { s.month = v; break; }
      const EN_C = [[/bulgaria|bansko/, 'bulgaria'], [/austria|austrian/, 'austria'],
        [/france|french|alps/, 'france'], [/andorra/, 'andorra']];
      for (const [re, v] of EN_C) if (re.test(en) && s.country == null) { s.country = v; break; }
      const ages = [...en.matchAll(/aged? (\d{1,2})(?: and (\d{1,2}))?/g)]
        .flatMap(m => [m[1], m[2]]).filter(Boolean).map(Number).filter(a => a >= 0 && a <= 17);
      if (ages.length && !(s.children_ages || []).length) s.children_ages = ages;
      const fam = en.match(/family of (\d{1,2})|(\d{1,2}) (?:people|persons|travell?ers|adults)/);
      if (fam && s.adults == null) {
        const total = +(fam[1] || fam[2]);
        s.adults = Math.max(1, total - (s.children_ages || []).length);
      }
      if (s.adults == null && /couple|two of us|my wife|my husband/.test(en)) s.adults = 2;
    }
  }

  // A year that is not the season we sell. "אפשר בדצמבר 2025?" was answered
  // with December 2026 offers and no word about the year they actually asked
  // for — the one thing that made the answer wrong.
  s.wrong_year = null;
  {
    const y = t.match(/(?:^|[^\d])(20\d{2})(?![\d])/);
    if (y && +y[1] !== 2026 && +y[1] !== 2027) s.wrong_year = +y[1];
  }

  // --- month
  s.out_of_season = false;
  // "ומרץ ולא ינואר" names two months and wants one of them. The negated half
  // is removed before the scan, or the first name in the sentence wins and the
  // customer is offered exactly the month they just ruled out.
  const tMonth = t.replace(/(?:^|[^א-ת])(?:ולא|לא|במקום|חוץ מ)\s*ב?(דצמבר|ינואר|פברואר|מרץ|מארס|מרס)(?![א-ת])/g, ' ');
  // "דצמבר או ינואר" names two months and means either. Keeping the first and
  // never mentioning the second read as ignoring half the request.
  {
    const found = [];
    for (const [re, v] of MONTHS) if (re.test(tMonth)) found.push(v);
    if (found.length) s.month = found[0];
    s.month_alt = found.length > 1 ? found[1] : (s.month_alt ?? null);
  }
  // a numeric date the customer wrote as "15.2" / "5/1"
  // an exact day, not just its month: "12.2.27", "5/1"
  {
    const dm2 = t.match(/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d])/);
    if (dm2 && +dm2[1] >= 1 && +dm2[1] <= 31 && [12, 1, 2, 3].includes(+dm2[2])) {
      s.exact_day = +dm2[1];
      s.month = +dm2[2];
    }
  }
  if (s.month == null) {
    const dm = t.match(/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?![\d])/);
    if (dm) {
      const mo = +dm[2];
      if ([12, 1, 2, 3].includes(mo)) s.month = mo;
      else if (mo >= 1 && mo <= 12) s.out_of_season = true;
    }
  }
  // the season runs December–March; anything else should be said out loud
  // rather than answered with a repeat of "מתי תרצו לצאת?"
  if (s.month == null && /אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|קיץ|פסח/.test(t)
      && !/דרכון|בתוקף|תוקף|נולד|יום הולדת|passport/.test(t)) {
    s.out_of_season = true;
  }
  // "סוף פברואר" is not February. The bot heard the month, ignored the half,
  // and offered the 4th — the opposite end of what was asked for.
  // The part word has to sit next to the month, or "סוף שבוע" would mean late.
  const partMatch = t.match(/(תחילת|ראשית|בתחילת|אמצע|באמצע|סוף|בסוף|שלהי)\s*(?:ה?חודש|דצמבר|ינואר|פברואר|מרץ|מארס)/);
  if (partMatch) {
    const w = partMatch[1];
    if (/תחילת|ראשית/.test(w)) s.month_part = 'early';
    else if (/אמצע/.test(w)) s.month_part = 'mid';
    else s.month_part = 'late';
  } else if (/^ ?(תחילת|אמצע|סוף) ?(החודש)? ?$/.test(t)) {
    // a bare answer to "מתי בחודש?"
    s.month_part = /תחילת/.test(t) ? 'early' : (/אמצע/.test(t) ? 'mid' : 'late');
  }
  // The Israeli calendar, not only the month: חנוכה תשפ"ז is 5–12.12.2026 and
  // פורים is 23–24.3.2027. A family that says "בחנוכה" means that week, and
  // was being shown the whole of December.
  if (/חנוכה/.test(t) && !partMatch) { s.month = 12; s.month_part = 'early'; s.holiday = 'חנוכה'; }
  else if (/פורים/.test(t) && !partMatch) { s.month = 3; s.month_part = 'late'; s.holiday = 'פורים'; }
  else if (s.month !== (slots || {}).month) s.holiday = null;   // moved on to a plain month

  // "גמיש בתאריך" said on its own RELEASES the month rather than merely filling
  // it in when empty — that is what a customer means by flexible, and until now
  // they kept being shown February after explicitly letting go of it.
  if (/גמיש[יי]?[םמ]? בתארי|לא משנה התארי|לא משנה מתי|כל תאריך|מתי שיש/.test(t)) {
    s.month = 'any'; s.flexible_dates = true; s.month_part = null; s.exact_day = null; s.holiday = null;
  } else if (/לא משנה|גמיש|אין העדפה/.test(t)) {
    if (s.month == null) s.month = 'any';
    s.flexible_dates = true;
    s.month_part = null;
  }
  // and the same for the destination, which had no release at all
  if (/לא משנה איז[הו] (?:מדינה|יעד)|לא משנה היעד|לא משנה לאן|כל יעד|כל מדינה/.test(t)) {
    s.country = 'any'; s.destination = null; s.hotel = null;
    s.excluded_countries = []; s.excluded_destinations = [];
  }

  // --- requirements the commitments workbook has no data for (spec 3.6: no
  // board basis, no ski pass, no equipment, no bed layout). Naming them and
  // handing them to a rep is honest; ignoring them looks like we didn't read.
  const UNVERIFIABLE = [
    [/מיטות נפרדות|מיטות ?נפרדות|טווין|twin/i, 'מיטות נפרדות'],
    [/ארוחת בוקר|חצי פנסיון|פנסיון מלא|הכל כלול|כולל ארוחות|ארוחות|בסיס ה?אירוח|לינה בלבד/, 'בסיס האירוח'],
    [/סקי ?פס/, 'סקי פס'],
    [/השכרת ציוד|ציוד סנובורד|ציוד סקי|השכרה/, 'השכרת ציוד'],
    [/הסעות|העברות|טרנספר/, 'הסעות משדה התעופה'],
    [/נסיעה קצרה|קרוב לשדה|זמן נסיעה|כמה זמן מהשדה|מרחק מהשדה/, 'המרחק משדה התעופה'],
    [/חדר גדול|חדר מרווח|סוויטה|חדרי שינה|כמה חדרים|דירה גדולה|כמה מ"ר|גודל החדר/, 'גודל החדר'],
    [/מקלח|אמבטי|שירותים בחדר|חדרי רחצה|כמה שירותים/, 'חדרי רחצה'],
    [/wifi|וויפי|ויי ?פיי|אינטרנט/i, 'WIFI'],
    [/ספא|בריכה|סאונה|ג'קוזי|חמאם/, 'ספא ובריכה'],
  ];
  s.unverifiable = [];
  for (const [re, label] of UNVERIFIABLE) if (re.test(t) && !s.unverifiable.includes(label)) s.unverifiable.push(label);
  // Which board basis, specifically. Someone asking for פנסיון מלא and shown
  // חצי פנסיון first was answered but not served.
  if (/הכל כלול|all inclusive/i.test(t)) s.board_wanted = 'all_inclusive';
  else if (/פנסיון מלא/.test(t)) s.board_wanted = 'full';
  else if (/חצי פנסיון/.test(t)) s.board_wanted = 'half';
  else if (/ארוחת בוקר/.test(t)) s.board_wanted = 'breakfast';

  // Taking a constraint back. Without these the bot kept repeating the Haifa
  // note to a customer who had just said Haifa was not required.
  if (/אפשר גם בשבת|אפשר בשבת|לא אכפת לנו משבת|לא שומרים שבת|לא שומרי שבת/.test(t)) {
    s.no_saturday_flights = false;
  }

  // --- Sabbath observance: a hard constraint, not a preference. Saturday
  // departures must disappear entirely rather than be ranked lower.
  // NOT כשר: asking whether the food is kosher says nothing about flying on
  // Saturday, and inferring it silently removed every Saturday departure from
  // a customer who had only asked about a meal.
  if (/שומר(?:ת|ים|ות|י)? שבת|לא בשבת|לא ביום שבת|לא טסים בשבת|דתי|דתיים|שבת שלום/.test(t)) {
    s.no_saturday_flights = true;
  }

  // --- trip length: "לשבוע" is a requirement, not a wish. A 3-night weekend
  // shown to someone who asked for a week is the wrong product.
  // "סופ״ש" is a real product (Bansko, Friday to Wednesday), not off topic
  if (/סופ.?ש|סוף שבוע|סופשבוע|סופ שבוע|רק לכמה ימים|אין לנו שבוע/.test(t)) s.nights_wanted = 3;
  else if (/לשבוע|שבוע שלם|7 לילות|שבועיים/.test(t)) s.nights_wanted = 7;
  else {
    const nm = t.match(/(\d{1,2})\s*לילות/);
    if (nm) s.nights_wanted = +nm[1];
  }

  // --- departure airport. A city name alone is NOT a departure airport:
  // "מה מזג האוויר בתל אביב" used to set the airport. Require either a
  // "from" prefix or an explicit flight word nearby.
  const flightCtx = /טיס|ממריא|יוצאים|יוצא|לעוף|לטוס|המראה|שדה/.test(t);
  if (/מחיפ[הא]/.test(t) || (flightCtx && /חיפ[הא]/.test(t))) s.departure_airport = 'haifa';
  else if (/מתל ?-?אביב|מנתב"ג|מנתבג|מבן ?-?גוריון/.test(t) ||
           (flightCtx && /תל ?-?אביב|ת"א|נתב"ג|נתבג|בן ?-?גוריון/.test(t))) s.departure_airport = 'tlv';
  else if (answering === 'airport') {
    // answering the airport question — a bare city name is unambiguous here
    if (/חיפה/.test(t)) s.departure_airport = 'haifa';
    else if (/תל ?-?אביב|ת"א|נתב"ג|נתבג|בן ?-?גוריון|מרכז/.test(t)) s.departure_airport = 'tlv';
    // "לא משנה" = no constraint, but stop asking
    else if (/לא משנה|כל אחד|שניהם|מה שיש|לא חשוב/.test(t)) s.departure_airport = 'any';
  }

  // Taking the airport back. This has to run AFTER the parser above, which
  // would otherwise read "מחיפה" out of the very sentence releasing it.
  if (/לא חייב מחיפה|לא חייב מנתב|לא משנה מאיפה|לא משנה משדה|כל שדה|לא חייב משדה|מאיפה שיוצא/.test(t)) {
    s.departure_airport = 'any';
  }

  // "לא משנה" answering the destination question
  if (answering === 'country' && /לא משנה|כל מקום|מה שיש|אין העדפה|לא חשוב/.test(t)) s.country = 'any';

  // --- country / destination, honouring negation.
  // "לא צרפת" names France but ASKS FOR ITS OPPOSITE — matching the word and
  // ignoring the "לא" is worse than not understanding at all, because the
  // customer gets exactly what they ruled out.
  s.excluded_countries = [...(s.excluded_countries || [])];
  // NO break: "לא צרפת ולא בולגריה" names two countries and rules out both.
  // Stopping at the first match served the customer the second one.
  for (const [re, v] of COUNTRIES) {
    const m2 = re.exec(t);
    if (!m2) continue;
    if (isNegated(t, m2.index)) {
      if (!s.excluded_countries.includes(v)) s.excluded_countries.push(v);
      if (s.country === v) s.country = null;         // retract an earlier pick
    } else {
      // a plain mention also RETRACTS an earlier exclusion — people change
      // their mind ("לא צרפת" … "בעצם כן צרפת") and must be able to say so
      s.excluded_countries = s.excluded_countries.filter(x => x !== v);
      s.country = v;
      // "רק אוסטריה" is a decision. Suggesting they consider other countries
      // two lines later is the opposite of listening.
      if (/רק |ורק |בלבד|דווקא/.test(t)) s.country_fixed = true;
    }
  }
  // A resort can be ruled out just like a country. "לא בנסקו" used only to clear a
  // resort the customer had picked; it never recorded the refusal, so three
  // Bansko hotels came straight back. Ruling out a resort does NOT rule out
  // its country — Bansko is not Bulgaria, Borovets is still on the table.
  s.excluded_destinations = [...(s.excluded_destinations || [])];
  for (const [re, dest, country] of DESTS) {
    const m2 = re.exec(t);
    if (!m2) continue;
    if (isNegated(t, m2.index)) {
      if (!s.excluded_destinations.includes(dest)) s.excluded_destinations.push(dest);
      if (s.destination === dest) s.destination = null;
    } else {
      // naming it plainly retracts an earlier refusal — people change their mind
      s.excluded_destinations = s.excluded_destinations.filter(x => x !== dest);
      s.destination = dest;
      s.excluded_countries = s.excluded_countries.filter(x => x !== country);
      s.country = s.country || country;
    }
  }

  // Two places named in one breath ("בנסקו או אנדורה", "מתלבטים בין איטליה
  // לצרפת") is a comparison, not a correction. Taking the last one and
  // answering "the options are outside the destination you asked for" is the
  // worst of both.
  {
    const named = [];
    for (const [re, dest] of DESTS) {
      const m2 = re.exec(t);
      if (m2 && !isNegated(t, m2.index)) named.push({ destination: dest });
    }
    for (const [re, v] of COUNTRIES) {
      const m2 = re.exec(t);
      if (m2 && !isNegated(t, m2.index) && !named.some(n => n.country === v)) {
        // a country whose resort was already named is the same wish twice
        if (!named.some(n => DESTS.some(d => d[1] === n.destination && d[2] === v))) {
          named.push({ country: v });
        }
      }
    }
    s.compare = named.length > 1 ? named.slice(0, 3) : null;
  }

  // --- a hotel named by name
  {
    const named = hotelNamed(t);
    if (named) s.hotel = named;
  }

  // --- a resort pingwin sells but holds no commitments for. Saying nothing
  // and quietly showing something else reads as a bot that ignored the
  // question; claiming it is unavailable would be wrong. Name it and route it.
  s.off_commitment_destination = null;
  s.off_commitment_country = null;
  for (const [re, label, country] of OFF_COMMITMENT) {
    if (!re.test(t)) continue;
    s.off_commitment_destination = label;
    s.off_commitment_country = country;
    break;
  }

  // --- "יקר לי". Tomer, 24/08: show a cheaper one and say so; if there is
  // nothing cheaper, say plainly that these are the best prices we can offer.
  // The trigger words and both sentences live in config/guidance.json.
  {
    const obj = guidance.objection('too_expensive');
    if (obj && obj.match.test(t)) {
      s.price_objection = true;
      s.preferences = [...new Set([...(s.preferences || []), 'תקציב'])];
    }
  }

  // "אפשר להן חדר משלהן" — a second room, asked for in the words a parent
  // uses. Without this the request fell on the floor and the reply offered
  // one room for four.
  if (/חדר משלה[םן]|חדר בנפרד|חדר נפרד|חדרים נפרדים|שני חדרים|2 חדרים|חדר לילדים/.test(t)) {
    s.wants_two_rooms = true;
    s.notes_from_customer = [...new Set([...(s.notes_from_customer || []), 'חדר נפרד לילדים'])];
  }

  // "אנחנו 12 אנשים, 6 זוגות" — couples, so no children, and asking anyway
  // reads as not having listened.
  if (/\d+ ?זוגות|זוגות בלבד|כמה זוגות/.test(t) && !(s.children_ages || []).length) {
    s.no_children = true;
  }

  // A party that grows or shrinks mid-conversation: "מצטרפים אלינו עוד שניים",
  // "בסוף אנחנו רק שלושה". Without this the offers stayed sized for the old
  // group and nothing in the reply admitted that anything was said.
  {
    const WORD_N = { 'אחד': 1, 'אחת': 1, 'שניים': 2, 'שתיים': 2, 'שלושה': 3, 'שלוש': 3, 'ארבעה': 4, 'ארבע': 4 };
    const more = t.match(/(?:מצטרפ(?:ים|ת|)|מתווספ(?:ים|ת)|מגיעים|יבואו|נוסעים) (?:אלינו )?עוד (\d{1,2}|אחד|אחת|שניים|שתיים|שלושה|שלוש|ארבעה|ארבע)(?![א-ת])/);
    if (more && s.adults != null) {
      const n = WORD_N[more[1]] || +more[1];
      if (n >= 1 && n <= 8) s.adults = Math.min(12, s.adults + n);
    }
  }

  // A budget said in shekels or euros. The exact price is never ours to quote
  // (red rule 3), but hearing the number and showing the affordable end of the
  // list is not the same as quoting one.
  if (/\d{3,5}\s*(₪|ש"ח|שקל|שח)|עד \d{3,5} (?:יורו|אירו|€)|תקציב של \d{3,5}|\d{3,5} לאדם|עד \d{3,5}(?![\d])/.test(t)
      && !/תקציב לא מגביל|לא מגביל/.test(t)) {
    s.price_objection = true;
    s.preferences = [...new Set([...(s.preferences || []), 'תקציב'])];
    // a stated ceiling deserves an explicit word: we sort for it, we never
    // quote a price, and a rep confirms the number
    s.notes_from_customer = [...new Set([...(s.notes_from_customer || []),
      'תקציב לאדם שציינתם'])];
  }

  // "תאומים בני 5 ועוד ילד בן 9" — two fives, not one. The party was one seat
  // short and the offers were sized for a family that does not exist.
  {
    const tw = t.match(/תאומים בני (\d{1,2})|תאומות בנות (\d{1,2})/);
    if (tw) {
      const age = +(tw[1] || tw[2]);
      const ages = s.children_ages || [];
      if (ages.filter(a => a === age).length === 1) s.children_ages = [...ages, age].sort((a, b) => a - b);
    }
  }

  // Requirements we can hear but cannot filter on. Without this they fell on
  // the floor — the reply answered everything else and said nothing about the
  // kitchenette, and the customer rightly read that as not listening.
  {
    const ASKS = ASK_LEXICON;
    const notes = [...(s.notes_from_customer || [])];
    for (const [re, label] of ASKS) {
      if (re.test(t) && !notes.includes(label)) notes.push(label);
    }
    s.notes_from_customer = notes;
  }

  // --- kids club (גם האיות "קיטנה")
  if (/בלי קי?יטנה|לא צריך קי?יטנה|בלי ליווי/.test(t)) s.needs_hebrew_kids_club = false;
  else if (/קי?יטנ|ליווי בעברית|מדריך לילדים|מדריכים.{0,20}ילדים/.test(t)) s.needs_hebrew_kids_club = true;
  // "צריך קבוצה לילד בן 4", "כן בשביל הקטן", "חשוב לנו" — an answer to
  // "תרצו קייטנה?" is rarely the bare word כן, and treating anything else as
  // no answer at all left the camp requirement unset and offered weeks with no
  // group for the child.
  if (s._lastQuestion === 'kids_club') {
    if (/^ ?(כן|בטח|כמובן|חובה|צריך|רוצים|כן כן) ?$/.test(t)) s.needs_hebrew_kids_club = true;
    else if (/כן|צריך|רוצה|רוצים|חשוב|בהחלט|נשמח|מעוניינ|קבוצה|קייטנ|קיטנ|הדרכ|מדריך/.test(t)) {
      s.needs_hebrew_kids_club = true;
    }
  }
  if (/^ ?(לא|אין צורך|לא צריך) ?$/.test(t) && s._lastQuestion === 'kids_club') s.needs_hebrew_kids_club = false;
  if (/^ ?(לא|אין|בלי) ?$/.test(t) && s._lastQuestion === 'children') { s.no_children = true; s.children_ages = []; }

  // "כולם מעל גיל 18 חוץ מאחת" is an answer, not noise: it says everyone is an
  // adult apart from one minor. Read literally it used to leave the party size
  // unknown, and the bot then announced there was no availability at all.
  const allAdults = /כולם\s*(?:הם\s*)?(?:מבוגרים|מעל\s*(?:גיל\s*)?1[89]|בני\s*1[89]\s*ומעלה)/.test(t);
  if (allAdults) {
    const except = t.match(/חוץ\s*מ(אחת|אחד|שניים|שתיים|שלושה|שלוש|אחד\s*מהם|אחת\s*מהן)/);
    if (except) {
      const n = heNum(except[1].split(/\s/)[0]) || 1;
      s.children_count = n;          // corrects an earlier guess — they just counted for us
      s.no_children = false;
    } else {
      s.no_children = true;
      s.children_ages = [];
    }
  }

  // bare answer to the adults question — digits ("2") or words ("שניים")
  // chip taps: "4 נוסעים", "5+ נוסעים"
  const chipParty = t.match(/(?:^|\s)(\d{1,2})\s*\+?\s*נוסעים\s*$/);
  if (chipParty && s.adults == null) {
    const n = +chipParty[1];
    const kids = (s.children_ages || []).length;
    if (n >= 1 && n <= 20) s.adults = kids && n > kids ? n - kids : n;
  }
  // A bare number when the party size is the thing we do not know. Same
  // reasoning as the ages above: understood by what is missing, not by what
  // was last asked — questions are asked once now, answers arrive later.
  if (s.adults == null && !allAdults && !expectingAgesRef.value) {
    const bare2 = t.trim().match(/^(\d{1,2})$/);
    if (bare2 && +bare2[1] >= 1 && +bare2[1] <= 20) s.adults = +bare2[1];
  }
  if (answering === 'adults' && s.adults == null && !allAdults) {
    const bare = t.trim().match(/^(\d{1,2}|[א-ת]+)(?:\s*(?:אנשים|נוסעים|מבוגרים))?$/);
    if (bare) { const n = +bare[1] || heNum(bare[1]); if (n) s.adults = n; }
  } else if (answering === 'month' && s.month == null) {
    const bare = t.trim().match(/^(\d{1,2})$/);
    if (bare && +bare[1] >= 1 && +bare[1] <= 12) s.month = +bare[1];
  }

  // --- preferences (only if mentioned!)
  // "לא מחפש את הכי זולה", "בלי ספא" — a preference someone just ruled out
  // must not be recorded as one
  const tPrefs = t.replace(/(?:לא|בלי|אין צורך ב|לא חייב)[^,.!?]{0,35}?(זול|הכי זולה|תקציב|ספא|בריכה|חיי לילה|אפרה)/g, ' ');
  const prefs = new Set(s.preferences || []);
  // "מה יותר משתלם" IS a budget preference stated as a question
  if (/מה יותר משתלם|מה הכי משתלם|איפה יוצא הכי זול|מה כדאי יותר/.test(t)) prefs.add('תקציב');
  // "תקציב לא מגביל" is the OPPOSITE of a budget constraint. Matching the bare
  // word inverted exactly the customer it mattered most to: the one who said
  // money was no object was sorted cheapest-first and shown our cheapest rooms.
  const budgetIsOpen = /תקציב לא מגביל|תקציב לא משנה|המחיר לא משנה|מחיר לא משנה|לא מגבילים תקציב|בלי הגבלת תקציב|כסף לא בעיה|לא אכפת לנו מהמחיר/.test(t);
  for (const [re, v] of PREFS) {
    if (!re.test(tPrefs)) continue;
    if (v === 'תקציב' && budgetIsOpen) continue;
    prefs.add(v);
  }
  if (budgetIsOpen) prefs.delete('תקציב');
  s.preferences = [...prefs];

  return s;
}

// which single question to ask next (the cap lives in server.js).
// Ordered by how much each parameter narrows the search: party size and dates
// are blocking, then the ones that change WHICH packages qualify (kids club,
// departure airport), then destination. Preferences are never asked — they
// arrive only if the customer raises them, or via the chips after results.
// prevKey = the question the user just answered; never repeat it verbatim —
// if the answer wasn't understood, ask again in a clearer way.
function nextQuestion(slots, prevKey) {
  let q = null;
  const kidsInCampRange = (slots.children_ages || []).some(a => a >= 4 && a <= 13);
  // Nothing blocks any more. The bot searches with whatever it has and asks
  // alongside the offers, because a customer who has to answer three questions
  // before seeing anything is being interviewed, not helped (Tomer, 24/08).
  // `blocking` now means only "ask this one first", never "refuse to search".
  // someone who said they travel alone has answered this already
  if (slots.adults == null && !(slots.notes_from_customer || []).some(n => /נוסע יחיד/.test(n))) {
    q = { key: 'adults', blocking: true, he: 'כמה תהיו בסך הכל? אדייק לפי זה' };
  }
  else if (!(slots.children_ages || []).length && slots.no_children !== true) {
    // no_children === false means we were told there ARE children, even when
    // the count is still unknown — so ask what is missing, not what we know
    q = (slots.children_count || slots.no_children === false)
      ? { key: 'children_ages', blocking: true, he: slots.children_count === 1 ? 'בן כמה הילד?' : 'באילו גילאים הילדים?' }
      : { key: 'children', blocking: true, he: 'נוסעים גם ילדים, ואם כן — באילו גילאים?' };
  }
  else if (slots.month == null) q = { key: 'month', blocking: true, he: 'מתי תרצו לצאת? (דצמבר–מרץ, אפשר גם "גמיש")' };
  // a kids club can invalidate an entire week, so it is worth asking up front
  else if (kidsInCampRange && slots.needs_hebrew_kids_club == null)
    q = { key: 'kids_club', blocking: true, he: 'תרצו קייטנת סקי בעברית לילדים?' };
  // non-blocking: these sharpen the match, but the customer sees offers first
  // and refines from there rather than being interviewed
  else if (slots.departure_airport == null)
    q = { key: 'airport', blocking: false, he: 'מאיפה נוח לכם לטוס — נתב"ג או חיפה? (מחיפה יש רק בנסקו)' };
  else if (slots.country == null && slots.destination == null)
    q = { key: 'country', blocking: false, he: 'יש יעד שמושך אתכם — אוסטריה, צרפת, אנדורה או בולגריה? (אפשר גם "לא משנה")' };
  if (q && prevKey && (q.key === prevKey ||
      (q.key === 'children' && prevKey === 'children_ages') ||
      (q.key === 'children_ages' && prevKey === 'children'))) {
    const retry = {
      adults: 'סליחה, לא הצלחתי להבין — רק מספר המבוגרים (למשל: 2)',
      children: 'רק גילאי הילדים במספרים, למשל: 5 ו-9 (או "בלי ילדים")',
      children_ages: 'רק הגילאים במספרים, למשל: 5 ו-9',
      month: 'באיזה חודש? דצמבר, ינואר, פברואר או מרץ (או "גמיש")',
      kids_club: 'קייטנה בעברית לילדים — כן או לא?',
      airport: 'שדה היציאה — נתב"ג או חיפה?',
      country: 'איזו מדינה — אוסטריה, צרפת, אנדורה, בולגריה, או "לא משנה"?',
    };
    // keep `blocking`: dropping it turned a question we must ask into a chip,
    // and the turn then asked nothing at all
    q = { key: q.key, blocking: q.blocking, he: retry[q.key] || q.he };
  }
  return q;
}

/* ---------- template phrasing (offline replacement for the phrasing model) ---------- */
const OFF_COMMITMENT_COPY = JSON.parse(
  require('fs').readFileSync(require('path').join(__dirname, '..', 'config', 'off-commitment.json'), 'utf8'));

const MONTH_HE = { 12: 'דצמבר', 1: 'ינואר', 2: 'פברואר', 3: 'מרץ' };
function fmtDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
}

// The comparison verdict: which of the two named places actually has room.
// Deterministic and printed verbatim — the model kept rewriting "באוסטריה לא
// מצאתי" into something friendlier and wrong.
// "ציינתם דצמבר או ינואר — הצגתי משניהם." Verbatim, like the comparison
// verdict — the model kept absorbing it into nothing.
function bothMonthsLine(result, slots, hasCards) {
  if (!slots.month_alt || !hasCards) return null;
  if (!MONTH_HE[slots.month] || !MONTH_HE[slots.month_alt]) return null;
  const a = MONTH_HE[slots.month], b = MONTH_HE[slots.month_alt];
  if ((result.notes || []).some(n => n.type === 'both_months')) {
    return `ציינתם ${a} או ${b} — הצגתי משניהם.`;
  }
  if ((result.relaxed || []).some(r => r.type === 'month')) return null;
  return `ציינתם ${a} או ${b} — הצגתי מ${a}; ב${b} לא מצאתי בתנאים האלה.`;
}

function comparingLine(result, slots) {
  const cmp = (result.notes || []).find(n => n.type === 'comparing');
  if (!cmp) return null;
  const he = p => ({ france: 'צרפת', austria: 'אוסטריה', andorra: 'אנדורה', bulgaria: 'בולגריה' })[p.country] || p.destination;
  const empty = (cmp.places || []).filter(p => !p.found).map(he).filter(Boolean);
  const full = (cmp.places || []).filter(p => p.found).map(he).filter(Boolean);
  const nPlaces = (cmp.places || []).length;
  const fromAll = nPlaces > 2 ? 'מכל היעדים שציינתם' : 'משני היעדים שציינתם';
  if (!empty.length) return `הצגתי הצעות ${fromAll}, כדי שתוכלו להשוות.`;
  // one side empty: claiming "from both" while one is empty contradicts itself
  return `ב${full.join(' וב')} יש אפשרויות שנראות פנויות; ב${empty.join(' וב')} לא מצאתי בתנאים האלה.`;
}

// A destination pingwin sells but holds no commitments for. Deterministic, and
// printed verbatim — see the note inside phrase().
function offCommitmentLine(result, slots) {
  const offComm = (result.notes || []).find(n => n.type === 'destination_off_commitment');
  if (!offComm) return null;
  // wording lives in config/off-commitment.json so Tomer can edit it without
  // touching code. Never the word "התחייבויות" — that is internal jargon and
  // reads as a refusal; explain the real constraint (seats) instead.
  const cfg = OFF_COMMITMENT_COPY;
  const tpl = (cfg.constraint_by_country || {})[offComm.country] || cfg.constraint_default;
  const dates = (offComm.open_dates || []).map(fmtDay);
  return [
    tpl.replace('{resort}', offComm.name),
    dates.length ? cfg.with_dates_he.replace('{dates}', dates.join(', '))
      : (slots.month == null || slots.month === 'any' ? cfg.no_dates_no_month_he : cfg.no_dates_he),
    cfg.caveat_he,
  ].join(' ');
}

// What the search had to give up on, in fixed words. Printed above anything the
// model writes: asked for December, it showed January and said nothing about
// the gap in three separate audit rounds.
function relaxationLines(result, slots) {
  const out = [];
  for (const r of result.relaxed || []) {
    if (r.type === 'month') {
      // "יש סקי בבולגריה בדצמבר?" deserves a yes/no with the place named, not
      // a generic "לא מצאתי בדיוק"
      const DEST_HE2 = { 'Bansko': 'בנסקו', 'Borovets': 'בורובץ', 'Tignes': 'טיניי',
        'Les 2 Alpes': 'לה דוז אלפ', 'Val Thorens': 'ואל טורנס', 'Avoriaz': 'אבוריאז',
        'Les Arcs': 'לה ארק', 'Flaine Grand Massif': 'פליין גרנד מסיף', "Alpe d'Huez": "אלפ ד'הואז",
        'Montgenevre': "מונז'נבר", 'Les Menuires': 'לה מנואר', 'Soldeu': 'סולדו',
        'Pas de la Casa': 'פאס דה לה קאסה', 'Mayrhofen': 'מאיירהופן', 'Ischgl': 'אישגל' };
      const place = slots && ((slots.destination && (DEST_HE2[slots.destination] || null)) ||
        ({ france: 'צרפת', austria: 'אוסטריה', andorra: 'אנדורה', bulgaria: 'בולגריה' })[slots.country]) || null;
      // asked for a holiday by name — answer about the holiday, not the month
      const fromHe = (slots && slots.holiday && slots.holiday !== 'any') ? slots.holiday : (MONTH_HE[r.from] || r.from);
      out.push(place
        ? `ב${place} אין לי יציאות פנויות ב${fromHe}; הקרוב ביותר — ${MONTH_HE[r.to] || r.to}:`
        : `לא מצאתי בדיוק ב${fromHe}, אז הרחבתי ל${MONTH_HE[r.to] || r.to}:`);
    }
    if (r.type === 'location') {
      const sat = (result.notes || []).some(n => n.type === 'saturday_only');
      out.push(sat
        ? 'ביעד שביקשתם כל היציאות בחודש הזה יוצאות בשבת, ולכן הצגתי יעדים אחרים — כל מה שמוצג כאן יוצא בלי טיסה בשבת:'
        : 'לא מצאתי ביעד שביקשתם, אז הנה אופציות פנויות ביעדים אחרים:');
    }
    if (r.type === 'two_rooms') out.push('אין יחידה אחת שמתאימה לכל ההרכב — אבל אפשר לשלב שני חדרים באותו מלון:');
    if (r.type === 'nights') out.push(`לא מצאתי בדיוק ${r.wanted} לילות, אז הרחבתי גם למשכים אחרים:`);
  }
  return out;
}

function phrase(result, slots, cards) {
  let lines = [];
  const note = ty => (result.notes || []).find(n => n.type === ty);

  // a resort we sell but hold no commitments for: never say "unavailable",
  // never quote availability we don't have — say what it depends on and route
  // it to a rep, while still showing what IS on commitment
  // The line itself is printed by the server, above anything the model writes:
  // asked for Italy, the model rewrote the paragraph in its own words and the
  // explanation — why Italy is limited, and that a rep can check dates —
  // vanished. Facts of this weight are not the model's to rephrase.
  const offComm = note('destination_off_commitment');

  // NOTE: the out-of-season line is printed by the server preamble. Repeating
  // it here said the same sentence twice, two words apart.


  // the child's age group does not run on some of these weeks — name the ones
  // where it does, instead of only flagging what is missing
  const gap = note('camp_group_gap');
  if (gap && gap.missing.length) {
    const fmt = d => { const [y, m, dd] = d.split('-'); return +dd + '.' + +m; };
    // chronological, and only a handful — a wall of dates is not an answer
    const when = [...new Set([...(gap.dates || []), ...(gap.other_dates || [])])].sort().slice(0, 4);
    lines.push(when.length
      ? `שימו לב: קבוצת ${gap.missing.join(', ')} לא פועלת בכל השבועות. היא כן פועלת ב-${when.map(fmt).join(', ')} — כדאי לשקול את התאריכים האלה.`
      : `שימו לב: קבוצת ${gap.missing.join(', ')} אינה פועלת בתאריכים שמצאתי. נציג יבדוק מתי היא נפתחת.`);
  }

  // the list is short because weeks without the child's group were removed,
  // not because we have little to sell
  const narrowed = note('camp_narrowed');
  if (narrowed && narrowed.groups.length) {
    lines.push(`קבוצת ${narrowed.groups.join(', ')} פועלת רק בחלק מהשבועות, אז הצגתי רק תאריכים שבהם היא כן פועלת:`);
  }

  const partial = note('camp_age_partial');
  if (partial && partial.ages.length) {
    const ages = partial.ages.join(', ');
    lines.push(`שימו לב: הקייטנות מיועדות לגילאי 4-14, כך שלגיל ${ages} אין קבוצה. לשאר הילדים כן.`);
  }

  if (slots.wrong_year) {
    lines.push(`אנחנו מוכרים כרגע את עונת חורף 2026/27 — דצמבר 2026 עד סוף מרץ 2027. הנה מה שפנוי בעונה הזו:`);
  }

  const campAge = note('camp_age_mismatch');
  if (campAge) {
    const a = (campAge.ages || []);
    const ages = a.length > 1 ? a.slice(0, -1).join(', ') + ' ו-' + a[a.length - 1] : a.join('');
    lines.push(ages
      ? `שימו לב: הקייטנות שלנו מיועדות לגילאי 4-14, ולכן אין קבוצה מתאימה לגיל ${ages}. הנה מה שפנוי:`
      : 'הקייטנות שלנו מיועדות לגילאי 4-14. הנה מה שפנוי:');
  }

  const airportNote = (result.notes || []).find(n => n.type === 'airport_cannot_reach');
  if (airportNote) {
    const c = { france: 'לצרפת', austria: 'לאוסטריה', andorra: 'לאנדורה', bulgaria: 'לבולגריה' }[airportNote.requested_country] || '';
    lines.push(`אין לנו טיסות מ${airportNote.airport_he} ${c}. ${airportNote.note_he} הנה מה שיוצא מ${airportNote.airport_he}:`);
  } else {
    const limited = (result.notes || []).find(n => n.type === 'airport_limited');
    if (limited) lines.push(limited.note_he);
  }
  if ((result.notes || []).some(n => n.type === 'france_february_gap')) {
    // without cards, "הנה מה שפנוי" is followed by nothing — which reads as a
    // broken promise. Say the gap, and let the no-match line do its job.
    // Don't announce "הנה מה שפנוי" when a relaxation line is about to explain
    // what was actually shown — two openings in a row read as two answers.
    const willExplain = (result.relaxed || []).length > 0;
    lines.push('שימו לב: אין לנו יציאות לצרפת בפברואר (מדלגים מ-30.1 ל-6.3)' +
      (cards.length && !willExplain ? ' — אבל באוסטריה, אנדורה ובולגריה דווקא יש! הנה מה שפנוי:' : '.'));
  }
  for (const r of result.relaxed || []) {
    // month / location / two_rooms / nights are printed by the server, verbatim
    // — see relaxationLines() above. Everything else below still belongs to the
    // model's paragraph, because it is detail rather than a correction.
    // "קבוצת הגיל של הילד" with two children in two groups left the parent
    // guessing which child has no group — name the groups when there are two
    const groupsHe = (() => {
      const g = [...SkiSearch.neededAgeGroups(slots.children_ages)];
      const u = [...new Set(g)];
      return u.length > 1 ? { s: `קבוצות ${u.join(' ו-')}`, v: 'פועלות', p: 'הן' } : { s: 'קבוצת הגיל של הילד', v: 'פועלת', p: 'היא' };
    })();
    if (r.type === 'camp_month') {
      lines.push(`ב${MONTH_HE[r.from] || 'חודש שביקשתם'} אין שבוע שבו ${groupsHe.v} ${groupsHe.s}, אז הצגתי את ${MONTH_HE[r.to] || 'חודש אחר'} — שם ${groupsHe.p} כן ${groupsHe.v}:`);
    }
    if (r.type === 'camp_location') {
      const CH = { austria: 'אוסטריה', france: 'צרפת', andorra: 'אנדורה', bulgaria: 'בולגריה' };
      const from = CH[r.from_country] || 'היעד שביקשתם';
      const to = (r.to_countries || []).map(c => CH[c] || c).filter(Boolean);
      const where = to.length ? to.join(' ו-') : 'יעדים אחרים';
      const month = r.to && MONTH_HE[r.to] ? ` ב${MONTH_HE[r.to]}` : '';
      lines.push(`ב${from} אין שבוע שבו ${groupsHe.v} ${groupsHe.s}, אז הצגתי את ${where}${month} — שם ${groupsHe.p} כן ${groupsHe.v}:`);
    }
    if (r.type === 'exact_day') {
      lines.push(`אין יציאה ב-${r.wanted}.${r.month} בדיוק — היציאות שלנו שבועיות. הנה הקרובות אליה:`);
    }
    if (r.type === 'month_part') {
      const HE = { early: 'תחילת', mid: 'אמצע', late: 'סוף' };
      lines.push(`ב${HE[r.wanted] || ''} החודש שביקשתם אין יציאה מתאימה, אז הרחבתי לכל החודש:`);
    }
    if (r.type === 'human_rep') lines.push(noMatchAnswer());
  }
  // Offline, or when the model's wording is rejected, these still must not
  // vanish — the template says them plainly rather than well.
  // Only what has NOT been addressed yet. The list accumulates across the
  // conversation, and repeating "אעביר את זה לנציג" about the same sentence
  // every turn is how a bot sounds like it is not listening.
  const heard = (slots.notes_from_customer || []).filter(Boolean)
    .filter(n => !(slots._notes_said || []).includes(n))
    // not a restatement of the request in the third person, and not the
    // destination the line above has just answered about
    .filter(n => !/^ ?(הלקוח|הלקוחה|המשפחה|הזוג|הם |הוא |היא |הנוסע)/.test(n))
    .filter(n => !(offComm && n.includes(offComm.name)));
  if (cards.length && heard.length) {
    lines.push('רשמתי לפניי: ' + heard.join(', ') + '. אעביר את זה לנציג שילווה אתכם.');
  }

  // Nine travellers and up is a group booking: flight seats and hotel rooms
  // are checked together, by a person. A two-room split for twelve is not an
  // answer, and offering one quietly wastes the customer's time.
  const partySize = SkiSearch.partyOf(slots);
  if (partySize >= 9) {
    lines.push(note('group_rooms_by_rep')
      ? 'אלה המלונות והתאריכים הפנויים בתנאים שביקשתם. בחבורה בגודל הזה החלוקה לחדרים ' +
        'ומקומות הטיסה נסגרים מול נציג — השאירו שם וטלפון או התקשרו ל-04-8557722.'
      : 'בחבורה בגודל הזה החלוקה לחדרים ומקומות הטיסה נסגרים מול נציג. ' +
        'השאירו שם וטלפון ונציג ישלים אתכם את ההצעה, או התקשרו ל-04-8557722.');
  }

  // The answer to "יקר לי", in Tomer's own words from config/guidance.json.
  const obj = guidance.objection('too_expensive');
  if (obj && note('cheaper_found')) lines.push(obj.cheaper);
  if (obj && note('no_cheaper')) lines.push(obj.none);

  // acknowledge an active preference, so a refine chip visibly does something
  const prefs = slots.preferences || [];
  if (cards.length && prefs.length && !lines.length) {
    const budget = /תקציב/.test(prefs.join(' '));
    const others = prefs.filter(p => !/תקציב/.test(p));
    const bits = [];
    if (budget) bits.push('החסכוניות קודם');
    if (others.length) bits.push('לפי ' + others.join(', '));
    lines.push('סידרתי לפי מה שביקשתם — ' + bits.join(', ') + ' (הנציג יאשר סופית):');
  }
  // say out loud what was taken into account, then what a rep must confirm
  const applied = note('applied_requirements');
  if (cards.length && applied && applied.items.length >= 2) {
    lines.push('לקחתי בחשבון: ' + applied.items.join(', ') + '.');
  }
  if (cards.length && !lines.length) lines.push('הנה מה שנראה פנוי אצלנו (הנציג יאשר סופית):');
  // the trade-off is advice about the offers, so it follows their introduction —
  // it used to be the first and only sentence above three cards
  // What one bend would open up. Said once, for the single best trade — a list
  // of alternatives is a menu, and a menu is not advice.
  const trade = note('tradeoffs');
  if (cards.length && trade && trade.items.length) {
    const best = trade.items[0];
    const HE = {
      camp: 'אם תוותרו על הקייטנה בעברית',
      month: 'אם תהיו גמישים בתאריך',
      country: 'אם תשקלו גם יעדים אחרים',
      nights: 'אם תהיו גמישים במספר הלילות',
    };
    // A precise count is useful up to a point; past it, "69 אפשרויות" reads as
    // noise rather than advice.
    if (HE[best.drop] && best.gain >= 2) {
      const much = best.gain >= 12
        ? 'נפתחות הרבה יותר אפשרויות'
        : `נפתחות עוד ${best.gain} אפשרויות`;
      lines.push(`${HE[best.drop]} — ${much}. אני כאן אם תרצו לראות אותן.`);
    }
  }

  // Requirements the customer named. Most of them now HAVE an answer, taken
  // from the hotel's own page on pingwin.co.il (data/rooms-raw.json), so the
  // bot answers instead of handing everything to a rep. Only what the page
  // does not state is passed on — silently dropping a stated requirement reads
  // as not having read the message.
  if (cards.length && (slots.unverifiable || []).length) {
    const open = new Set(slots.unverifiable);
    for (const c of cards) c.facts_he = cardFacts(c, slots.unverifiable, open);
    if (open.has('הסעות משדה התעופה')) {
      lines.push('הסעות משדה התעופה למלון ובחזרה כלולות בכל החבילות שלנו.');
      open.delete('הסעות משדה התעופה');
    }
    if (open.size) {
      lines.push('את ' + [...open].join(', ') + ' נציג יאמת מול המלון לפני הסגירה.');
    }
  }

  for (const c of cards) {
    const why = [];
    if (c.occ && c.occ.max != null) why.push(`מתאים ל-${slots.adults != null ? SkiSearch.partyOf(slots) : c.occ.max} נוסעים`);
    if (c.camps && c.camps.full && (slots.children_ages || []).length) why.push('קייטנה בעברית לכל הילדים באותו שבוע');
    else if (c.camps && !c.camps.full && c.camps.missing.length) why.push(`שימו לב: פועלת רק קבוצת ${c.camps.running.join(' + ')} — אין קבוצת ${c.camps.missing.join(', ')} בשבוע זה`);
    else if (c.camps && c.camps.waitlist_only && c.camps.waitlist_only.length) why.push(`קבוצת ${c.camps.waitlist_only.join(',')} בהרשמת המתנה (ללא חיוב)`);
    // reference the customer's own stated preferences that this hotel matches
    const matched = (slots.preferences || []).filter(p => (c.tags || []).includes(p));
    if (matched.length) why.push('תואם למה שביקשתם: ' + matched.join(', '));
    if (c.recommended) why.push('מהמבוקשים ביותר אצלנו');
    if ((slots.preferences || []).includes('תקציב') && c.price_range.length <= 2) why.push('ידידותי לתקציב');
    c.why_he = why.join(', ');
  }
  // Five true sentences stacked on top of each other is not an explanation, it
  // is a wall. Keep the ones that change what the customer should DO — a
  // constraint we could not meet, a date we moved — and drop the softer ones.
  // The model, when available, gets all of them as context and writes something
  // shorter; this is the templated floor.
  if (lines.length > 3) {
    const HARD = /אין לנו|לא מצאתי|לא פועלת|אינה פועלת|שימו לב|הרחבתי|הצגתי|אין יציאה/;
    const hard = lines.filter(l => HARD.test(l));
    const soft = lines.filter(l => !HARD.test(l));
    lines = [...hard.slice(0, 3), ...soft].slice(0, 4);
  }
  return lines.join('\n');
}

// Answers, per offered unit, to the things the customer actually asked about.
// Every string here is either verbatim from the hotel page or a package rule
// Tomer stated (config/inclusions.json) — nothing is inferred (red rule 1).
// `open` starts as the full set of asked topics; a topic is removed as soon as
// any card can answer it, so the closing "a rep will confirm" line names only
// what really is unknown.
function cardFacts(c, asked, open) {
  const rf = c.room_facts || {};
  const out = [];
  const say = (topic, text) => { if (text) { out.push(text); open.delete(topic); } };
  // this card cannot answer it, but another card might — so it is named here
  // rather than swept into one blanket sentence at the end
  const defer = (label) => out.push(label + ' — נציג יאמת מול המלון');

  for (const topic of asked) {
    switch (topic) {
      case 'מיטות נפרדות':
        if (c.separate_beds === 'yes') say(topic, 'מיטות: ' + rf.beds_he);
        else if (c.separate_beds === 'other_room') {
          say(topic, (rf.beds_he ? 'בחדר המוצע: ' + rf.beds_he + '. ' : '') +
            'במלון יש גם ' + c.separate_beds_other_he + ' — נציג יבדוק זמינות');
        } else defer('מיטות נפרדות');
        break;
      case 'גודל החדר':
        if (rf.size_he) say(topic, 'גודל: ' + rf.size_he + (rf.bath_he ? ' · ' + rf.bath_he : ''));
        else defer('גודל החדר');
        break;
      case 'בסיס האירוח':
        if (c.board_he) say(topic, 'בסיס אירוח: ' + c.board_he);
        else defer('בסיס האירוח');
        break;
      case 'סקי פס':
        say(topic, c.ski_pass_included
          ? (c.ski_pass_he ? 'סקי פס: ' + c.ski_pass_he + ' (כלול)' : 'סקי פס כלול בחבילה')
          : 'סקי פס: אינו כלול בבולגריה, נרכש בנפרד');
        break;
      case 'השכרת ציוד':
        say(topic, c.equipment_he);
        break;
      case 'WIFI':
        if (c.wifi_he) say(topic, 'WIFI: ' + c.wifi_he);
        else defer('WIFI');
        break;
      // The hotel page names the facilities but usually does NOT say whether
      // using them is included, so we quote what it says and stop there.
      case 'ספא ובריכה': {
        if (c.spa_access === 'none') { say(topic, 'אין ספא במלון הזה'); break; }
        if (!c.spa_he && !c.spa_access_he) { defer('ספא ובריכה'); break; }
        // Facilities first, then the access terms — but the facilities quote
        // often already states them, and repeating "כניסה חופשית" three times
        // in one line reads like a machine, not an answer.
        const ACCESS_WORDS = /כניסה חופשית|חינם|כלול|בתשלום|בתוספת|לרשות האורחים|לשימוש אורחי/;
        const bits = [c.spa_he];
        if (c.spa_access_he && !(c.spa_he && ACCESS_WORDS.test(c.spa_he))) bits.push(c.spa_access_he);
        let said = bits.filter(Boolean).join(' ');
        if (c.spa_note_he && !said.includes(c.spa_note_he.slice(0, 14))) bits.push(c.spa_note_he);
        said = bits.filter(Boolean).join(' ');   // recompute: the note often carries the age itself
        if (c.spa_min_age && !said.includes('מגיל')) bits.push('מגיל ' + c.spa_min_age + ' ומעלה');
        say(topic, 'ספא: ' + bits.filter(Boolean).join('. '));
        break;
      }
      case 'חדרי רחצה':
        if (rf.bath_he) say(topic, 'חדרי רחצה: ' + rf.bath_he);
        else defer('חדרי הרחצה');
        break;
      // Distance in km only, never a duration (Tomer, 24/08): the time
      // depends on weather, traffic and snow on the road, and a number we
      // cannot honour is worse than no number at all.
      case 'המרחק משדה התעופה':
        if (c.transfer_he) say(topic, 'הסעות: ' + c.transfer_he);
        else defer('המרחק משדה התעופה');
        break;
      // 'הסעות משדה התעופה' is a package-wide rule, phrased once for all cards
    }
  }
  return out;
}

// Hotels by name. A customer who writes "אני רוצה את קאזה קארינה" has named
// the thing they want; showing it alongside two others is not an answer.
// Built from the workbook's own hotel list, so it is a closed universe by
// construction — a name that is not in here is not something we sell.
const HOTEL_NAMES = (() => {
  let hotels = {};
  try { hotels = require('../data/resorts.json').hotels; } catch (e) { return []; }
  const out = [];
  for (const name of Object.keys(hotels)) {
    // the latin name as written, plus a loose Hebrew transliteration key
    out.push([name, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]);
  }
  return out;
})();

// Hebrew spellings customers actually type. Only hotels whose Hebrew name is
// unambiguous are listed; a wrong match is worse than no match.
const HOTEL_HE = [
  [/קאזה ?קארינה|קזה ?קרינה/, 'Casa Karina'],
  [/רגנום/, 'Regnum'],
  [/ויהרן|וירן/, 'Vihren'],
  [/רילה/, 'Rila'],
  [/שטראס|סטראס/, 'Strass'],
  [/ספורט ?אנד ?ספא/, 'Sport'],
  [/פריינהוף|פרינהוף/, 'Hotel Ferienhof'],
  [/אלפנהוף/, 'Alpenhof Kristal'],
  [/ברגהוף/, 'Berghof'],
  [/שבל ?בלאן|שוואל ?בלאן/, 'Cheval Blanc (allotment)'],
  [/אוקסליס|אוקסאליס/, 'Residence Oxalys'],
  [/קשמיר/, 'Hotel Kashmir'],
  [/לודג' ?פארק|לודז ?פארק/, 'LODGE PARK (Allotment)'],
];

// Returns a hotel only when EXACTLY one is named. "מה עדיף קאזה קארינה או
// רגנום?" names two, and locking the search to whichever matched first answers
// a question the customer did not ask.
function hotelNamed(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  const found = new Set();
  for (const [re, name] of HOTEL_HE) if (re.test(t)) found.add(name);
  for (const [name, re] of HOTEL_NAMES) if (name.length >= 5 && re.test(t)) found.add(name);
  return found.size === 1 ? [...found][0] : null;
}

// "יש עוד?" is a request for the NEXT options, not a topic to discuss. It used
// to get "that is not my subject" and the same three cards again.
const WANTS_MORE = /^ ?ו?(יש עוד|עוד|עוד אפשרויות|תראה עוד|מה עוד יש|יש עוד משהו|אפשרויות נוספות|עוד הצעות|יש אחרים|משהו אחר)\s*\??\s*$/;
function wantsMore(text) {
  return WANTS_MORE.test(String(text || '').trim());
}

// A hotel we do not sell. The customer named one specific place; answering
// with three others and no explanation reads as not having heard them.
function unknownHotel(text, known) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  const NAMES = /(הילטון|מריוט|שרתון|קראון פלאזה|רדיסון|נובוטל|הוליי?דיי אין|קמפינסקי|רמדה|בסט ווסטרן|hilton|marriott|sheraton|radisson|novotel|kempinski|hyatt|ריץ|ritz)/i;
  const m = t.match(NAMES);
  if (!m) return null;
  if (known && known.some(h => new RegExp(m[1], 'i').test(h))) return null;
  // "התחייבות" is how the workbook talks; a customer never hears it.
  return 'את המלון הזה אנחנו לא מוכרים — אני מציג רק מלונות שאנחנו עובדים איתם בפועל, ' +
    'וזו הסיבה שמה שמופיע כאן באמת פנוי. אשמח להציע מלון דומה באותו יעד.';
}

// The slot model answers in the customer's language: it returned "בנסקו" where
// the inventory says "Bansko", and a resort we sell became a resort we do not
// have. Anything it hands back goes through the same map the regex layer uses,
// and a name that cannot be resolved is dropped rather than searched for.
function canonicalDestination(name) {
  const t = String(name || '').trim();
  if (!t) return null;
  for (const [, canon] of DESTS.map(d => [d[0], d[1]])) {
    if (canon.toLowerCase() === t.toLowerCase()) return canon;
  }
  for (const [re, canon] of DESTS) if (re.test(' ' + t + ' ')) return canon;
  return null;
}

// A typo, a cat on the keyboard, a test — one short token that means nothing.
// Tomer, 24/08: "שלחתי סתם אותיות והוא הציע לי חנוכה". Three hotels in answer
// to "מיע" is worse than admitting we did not understand.
const COURTESY = /^ ?(תודה|תודה רבה|אוקיי|אוקי|ok|בסדר|סבבה|מעולה|יופי|אשמח|כן|לא|נחמד)[\s!.?]*$/i;
function notUnderstood(text) {
  const t = String(text || '').trim();
  // Up to two short tokens. Longer than that and the off-topic line is the
  // better answer: a real sentence we cannot use is not the same as noise.
  const tokens = t.split(/\s+/);
  if (!t || tokens.length > 2 || t.length > 14) return null;
  if (/\d/.test(t) || COURTESY.test(t)) return null;
  return 'לא בטוח שהבנתי. כתבו לי כמה אתם נוסעים ומתי בערך — בין דצמבר למרץ — ואביא אפשרויות פנויות.';
}

const ASK_LEXICON = [
  [/מטבחון|פינת בישול|קומקום בחדר|מיני בר/, 'מטבחון או פינת בישול'],
  [/חב"ד|חבד|בית כנסת|מניין/, 'בית חב"ד או בית כנסת בקרבת מקום'],
  [/גן ילדים|פעוטון|משהו לפעוטות|שמרטף/, 'מסגרת לילדים קטנים'],
  [/פעילויות לילדים|מה יש לילדים|תעסוקה לילדים|שהילדים לא ישתעממו|יתעייפו מהסקי/, 'פעילויות לילדים מחוץ לסקי'],
  [/הדרכה לילדים|גן סקי|שיעורי סקי לילדים|בית ספר לסקי לילדים|ללמד את הילדים/, 'הדרכה לילדים'],
  [/5 כוכבים|חמישה כוכבים|מלון יוקרתי|ברמה הכי גבוהה|דלוקס|הכי מפואר|ממש ברמה|לא משהו המוני|רמה גבוהה|סוויטה|מפנק/, 'רמת מלון גבוהה או סוויטה'],
  [/פשוט להגיע|קל להגיע|הגעה קלה|מסובך להגיע|נסיעה קצרה מהשדה|קרוב לשדה/, 'הגעה נוחה משדה התעופה'],
  [/טיסות במחיר סביר|טיסה זולה|טיסות זולות/, 'מחיר טיסה נוח'],
  [/מלון נוח|נוח למבוגרים|בלי הרבה מדרגות/, 'מלון נוח'],
  [/בריכה מחוממת|בריכת שחייה/, 'בריכה'],
  [/ללכת ברגל|הליכה למסלול|בלי שאטל/, 'מרחק הליכה מהמסלולים'],
  [/סקי אין|ski.?in.?ski.?out|על המסלול|יציאה מהמלון למסלול/i, 'סקי אין-סקי אאוט (מלון על המסלול)'],
  [/מסעד|אוכל טוב באזור|שף/, 'מסעדות טובות באזור'],
  [/מסלולים קלים|מסלולים ירוקים|מסלולים למתחילים/, 'מסלולים קלים'],
  [/מעלית בשבת|מעלית שבת/, 'מעלית שבת במלון'],
  [/מזוודה|כבודה כלולה|טרולי/, 'מזוודה בטיסה'],
];

// a note that names a REQUIREMENT (from the lexicon above), as opposed to a
// question the model echoed back — requirements survive an FAQ answer in the
// same turn, questions do not
function isRequirementNote(note) {
  // a stated per-person ceiling is a requirement like any other — it was being
  // filtered out of the reply whenever the same message also hit an FAQ
  if (/תקציב לאדם/.test(note)) return true;
  return ASK_LEXICON.some(([, label]) => label === note);
}

// The human word that comes before business. "טסנו איתכם שנה שעברה והיה
// ממש טוב" was answered with three cards and a question — correct, and cold.
// One warm line first; the offers still follow.
function socialLine(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  const returning = /טסנו איתכם|היינו איתכם|נסענו איתכם|הזמנו אצלכם|היינו אצלכם|לקוחות שלכם|פעם שעברה איתכם|שוב איתכם|זה שוב אנחנו|זו שוב אני|מהחופשה .{0,25}שנה שעברה|חוזרים אליכם/.test(t);
  const praise = /היה (ממש |מאוד |פשוט )?(טוב|מעולה|כיף|מושלם|מדהים|נהדר)|נהנינו|היה חלום|אהבנו|מרוצים מכם|שירות מעולה|אתם אלופים/.test(t);
  // disappointment first: "הבטחתם לי" deserves a human word before any offer
  if (/הבטחתם|לא מה שסוכם|התאכזב|מאוכזב|עגמת נפש|זה לא מה שאמרתם|למשוך אותי|תמרחו|אל תמרח|תגידו פשוט|די לחפור|אף אחד לא חזר|לא מצליח לקבל|המחיר קופץ|כל פעם ש.{0,20}(אין|קופץ)|באמת מאכזב/.test(t)) {
    return 'מצטער לשמוע, ואני לוקח את זה ברצינות — אעביר את זה לנציג שיטפל בכם אישית.';
  }
  if (returning && praise) return 'איזה כיף לשמוע שנהניתם — נשמח לארח אתכם שוב.';
  if (returning) return 'ברוכים השבים! נשמח לתפור לכם גם את החופשה הבאה.';
  if (praise) return 'תודה על המילים החמות!';
  if (/מתרגשים|חוגגים|יום הולדת|יום נישואין|ירח דבש|הצעת נישואין/.test(t)) return null; // celebration has its own answer
  return null;
}

// A person leaving: "לא רוצה כלום, סתם בדקתי", "תודה, ביי". Three more hotels
// on the way out is exactly what makes a chat feel like a machine.
// "אני צריך לבדוק עם אשתי" — a pause. Pushing more offers at someone who
// asked for a moment reads as a pushy salesman.
const PAUSE = /עזבו? רגע|צריך לבדוק עם|צריכה לבדוק עם|אחשוב על זה|נחשוב על זה|תנו לי לחשוב|אחזור אליכם|נחזור אליכם בהמשך|נדבר על זה בבית/;
function isPause(text) {
  return PAUSE.test(String(text || ''));
}
const PAUSE_HE = 'בכיף, קחו את הזמן — ההצעות לא בורחות ואני כאן כשתחזרו. ואם נוח יותר, השאירו שם וטלפון ונציג יחזור אליכם מתי שתבחרו.';

const FAREWELL = /תפסיק לשלוח|תפסיקו לשלוח|די עם ההצעות|עזוב אותי|תפסיק להציע|לא רוצה כלום|סתם בדקתי|סתם הסתכלתי|רק מסתכל|לא מעוניין|לא רלוונטי כרגע|אולי בפעם הבאה|תודה רבה ביי|^ ?(ביי|להתראות|תודה וביי)[\s!.]*$/;
function isFarewell(text) {
  return FAREWELL.test(String(text || '').trim());
}
const FAREWELL_HE = 'אין בעיה בכלל. אם בהמשך תרצו לבדוק — אני כאן, ואפשר גם להתקשר ל-04-8557722. חורף נעים!';

// A resort a customer knows from elsewhere and we do not sell this season.
// "מתלבטים בין בנסקו לזולדן" used to be answered about Bansko alone, as if
// the other half of the question had not been said.
const FOREIGN_RESORTS = /(זולדן|סולדן|צרמט|קיצביהל|קיצבוהל|ואל גרדנה|ולגרדנה|ליווינ[יי]ו|ליבינ[יי]ו|סנט אנטון|סט אנטון|בורמיו|קורטינה|שאמוני|s[oö]lden|zermatt|kitzb\w*|livigno|st\.? ?anton|chamonix|cortina|bormio)/i;
function unknownResort(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  const m = t.match(FOREIGN_RESORTS);
  if (!m) return null;
  return `את ${m[1].trim()} אנחנו לא מוכרים העונה — אני מציג רק יעדים שיש לנו בהם מקומות בפועל: ` +
    'בולגריה, אוסטריה, צרפת ואנדורה. אשמח להציע אתר דומה מתוכם.';
}

// "היי" alone. Answering it with three arbitrary offers reads as a machine
// emptying its stock; a first turn is for saying hello and asking one thing.
const GREETING = /^ ?(היי|הי|שלום|בוקר טוב|ערב טוב|צהריים טובים|הלו|אהלן|יש מישהו|hi|hello|hey)[\s!.,?]*$/i;
function isGreeting(text) {
  const t = String(text || '').trim();
  // "שלום שלום" is a greeting said twice, not a puzzle
  return t.split(/\s+/).every(w => GREETING.test(w));
}

// Standing answers to the questions customers actually ask (config/faq.json).
// Before this, anything with a question mark and no ski vocabulary in it got
// "אני כאן בעיקר להתאמת חופשות סקי" — i.e. a customer asking about
// cancellation or kosher food was told that is not our subject.
const guidance = require('./guidance.js');

const FAQ = (() => {
  const raw = JSON.parse(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'config', 'faq.json'), 'utf8'));
  return raw.entries.map(e => ({ id: e.id, re: new RegExp(e.match, 'i'), he: e.answer_he, match: e.match }));
})();

// Order matters: the file lists the more specific patterns first, and the
// first match wins. Returns {id, he} so callers can log which answer fired.
// The approved answers, for the semantic router in server/answer-router.js.
// Same list the regex layer uses — one source, two ways of reaching it.
function faqEntries() {
  return FAQ.map(e => ({ id: e.id, answer_he: e.he, match: e.match }));
}

// Two questions in one message, both of which the patterns know. Free and
// deterministic: each question segment is matched on its own, so "יש חניה?
// ומה עם ביטוח?" gets both answers without a model call. The model router
// remains the fallback for phrasings the patterns do not know at all.
function faqMulti(text) {
  const segs = String(text || '').split(/[?!\n]+/).map(x => x.trim()).filter(Boolean);
  const hits = [];
  for (const seg of segs) {
    const h = faq(seg);
    if (h && !hits.some(x => x.id === h.id)) hits.push(h);
    if (hits.length === 2) break;
  }
  // a run-on sentence names several known topics with no punctuation between
  // them; the whole-text scan picks up what the segments missed, to a cap of
  // three answers per reply
  // a booking question that merely mentions a passport is not a passport
  // question; the six-months paragraph beside it reads as a non-sequitur
  if (hits.some(h => h.id === 'my_booking')) {
    return { id: 'my_booking', he: hits.find(h => h.id === 'my_booking').he,
      all: [hits.find(h => h.id === 'my_booking')] };
  }
  if (hits.length < 3) {
    const whole = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
    for (const e of FAQ) {
      if (hits.length >= 3) break;
      if (hits.some(h => h.id === e.id)) continue;
      if (e.re.test(whole)) hits.push({ id: e.id, he: e.he });
    }
  }
  if (!hits.length) return null;
  return { id: hits[0].id, he: hits.map(h => h.he).join(String.fromCharCode(10)),
    all: hits.map(h => ({ id: h.id, he: h.he })) };
}

function faq(text) {
  // Hebrew keyboards produce ׳ and ״ (geresh/gershayim) where the patterns
  // use ' and " — "צ׳ק אין" must match "צ'ק אין"
  const t = ' ' + String(text || '')
    .replace(/[׳‘’]/g, "'")
    .replace(/[״“”]/g, '"')
    .replace(/\s+/g, ' ') + ' ';
  for (const e of FAQ) if (e.re.test(t)) return { id: e.id, he: e.he };
  return null;
}

// Questions that deserve a real answer rather than another round of offers:
// asking for someone else's booking, or for an exact price. Silence here reads
// as evasion; these say plainly what the bot can and cannot do (red rules 2-3).
// When the bot genuinely has no answer, it says so and offers a person —
// phrased for the hour, so it never implies someone will pick up at 23:00.
// Nothing matched — which is different from not knowing the answer. Says so,
// and offers a person in words that fit the hour.
function noMatchAnswer() {
  const h = (guidance.load().handoff_he || {});
  return [h.when_no_match_he, guidance.handoffLine()].filter(Boolean).join(' ');
}

function unknownAnswer() {
  const h = (guidance.load().handoff_he || {});
  return [h.when_unknown_he, guidance.handoffLine()].filter(Boolean).join(' ');
}

// Red-rule guards, separated from the conversational deflections because they
// must NEVER be conditional. deflect() is skipped when the message also fills
// a slot — a sensible economy for "how many nights is it", and a hole for
// "who booked the room on 5.2", which fills the month and then walks past the
// customer-data guard.
// "תחזרו אליי" is a request to be called, not a topic to discuss. The widget
// turns this into an actual form rather than telling the customer where to
// find a button.
const WANTS_CALLBACK = /תחזרו אליי|תחזור אליי|שיחזרו אליי|תתקשרו אליי|רוצה שיחזרו|רוצה שתחזרו|תשאיר.{0,10}נציג|שנציג יחזור|שידברו איתי|רוצה לדבר עם נציג|רוצה נציג/;
/* ---- which language? ----
   A Cyrillic, Arabic or French/English sentence gets one fixed sentence in
   that language and the form; Hebrew typed in Latin letters ("yesh lachem
   chavilot") gets a Hebrew invitation to write Hebrew. Anything the English
   floor above can already parse (month, country, ages) still counts. */
const TRANSLIT = /\b(yesh|lachem|lecha|lach|ani|anachnu|anahnu|rotze|rotza|rotzim|chavila|chavilot|havila|havilot|kama|ma\b|mah\b|mechir|hamechir|yeladim|zug|mishpacha|efshar|shalom|toda|todah|bevakasha|matai|eifo|sheli|shelanu)\b/i;
function foreignLanguage(text) {
  const raw = String(text || '');
  if (/[א-ת]/.test(raw)) return null;                       // any Hebrew — it is a Hebrew message
  if (/[\u0400-\u04FF]{3}/.test(raw)) return 'ru';
  if (/[\u0600-\u06FF]{3}/.test(raw)) return 'ar';
  if (!/[a-z]{3}/i.test(raw)) return null;                  // digits, emoji, punctuation
  if (TRANSLIT.test(raw)) return 'translit';
  if (/\b(bonjour|vous|avez|séjour|sejour|nous|est-ce|merci|semaine|enfants)\b/i.test(raw)) return 'fr';
  return 'en';
}

/* ---- who is writing? ----
   Not every message is a customer looking for a holiday. A travel agent, a
   company, a school, a journalist, someone who already booked, someone who
   simply pasted their phone number — each used to get "כמה תהיו?" back.
   Returns {kind, he, prefill?} or null. Wording lives in config/guidance.json. */
const PHONE_RE = /(?:\+972|0)5\d[-\s]?\d{3}[-\s]?\d{4}/;
function leadIntent(text) {
  const raw = String(text || '').trim();
  const t = ' ' + raw.replace(/\s+/g, ' ') + ' ';
  const L = kind => ({ kind, he: guidance.leadIntentText(kind) });
  // a phone number with at most a name around it — the customer skipped the form
  const ph = raw.match(PHONE_RE);
  if (ph && raw.replace(PHONE_RE, '').replace(/[\s,.:;\-|]/g, '').length <= 25 && !/\?/.test(raw)) {
    const name = raw.replace(PHONE_RE, '').replace(/[,.:;|\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return { ...L('phone_only'), prefill: { phone: ph[0], name: name || '' } };
  }
  if (/אני סוכן|סוכנת נסיעות|סוכן נסיעות|משרד נסיעות|תנאי סוכנים|עמלת סוכן|עמלה לסוכנים|נטו לסוכן|מחיר נטו/.test(t)) return L('agent');
  if (/נופש חברה|ועד עובדים|ועד ה?עובדים|לעובדים שלנו|החברה שלנו רוצה|הצעת מחיר רשמית|לחברה של|גיבוש (חברה|צוות)|כנס חברה|\d{2,3} עובדים/.test(t)) return L('corporate');
  if (/תנועת נוער|משלחת|בית ספר|תיכון|חניכים|כיתה [א-יא-ת]|מורים ותלמידים|תלמידים/.test(t) && !/הילדים מפסידים|ימי בית ספר|חופשת|חופש/.test(t)) return L('school');
  if (/בר מצווה|בת מצווה|בר-מצווה|בת-מצווה|שבת חתן|חתונה באתר|חתונה ב|אירוע משפחתי של|\d{2,3} איש/.test(t) && !/עוגה/.test(t)) return L('celebration_group');
  if (/עיתונא|כתבה|כתב ב|בלוגר|משפיענ|שת"פ|שיתוף פעולה|נסיעה במימון|ynet|וואלה|כלכליסט|דה מרקר/.test(t)) return L('press');
  if (/מחפש עבודה|מחפשת עבודה|קורות חיים|לעבוד אצלכם|לעבוד איתכם|מדריך מוסמך|משרה|דרושים|מה השכר|לעבוד בקייטנה/.test(t)) return L('job');
  if (/אנחנו מלון|רשת מלונות|hotel chain|ספק ביטוח|להיכנס למאגר|רוצה לפרסם אצלכם|תכנית שותפים|אפיליי|משקיעים|בניתי מערכת|contracting/i.test(t)) return L('partnership');
  if (/סקי מותאם|סקי לנכים|sit.?ski|כיסא גלגלים|כסא גלגלים|מעלון|לקוי ראייה|לקוית ראייה|עיוור|כלב נחייה|נגיש(ות)? ל|prm|אדפטיבי/i.test(t)) return L('adaptive');
  if (/הזמנה (מספר|מס'?) ?\d+|מספר הזמנה \d+|הזמנתי כבר|כבר הזמנתי|הזמנו כבר|כבר הזמנו|ביטלתי (לפני|ועדיין)|לא קיבלתי (החזר|חשבונית|את הכרטיסים|אישור)|איפה הכרטיסים|סטטוס ההחזר|חויבתי פעמיים|ההזמנה שלי (מאושרת|קיימת)|קיבלנו מייל שהמלון|הטיסה (שלנו )?בוטלה|רוצה לשדרג את ההזמנה|להוסיף .{0,20}להזמנה (שלי|שלנו|קיימת)|אנחנו עומדים ב.{0,20}עכשיו/.test(t)) return L('existing');
  return null;
}

function wantsCallback(text) {
  return WANTS_CALLBACK.test(' ' + String(text || '').replace(/\s+/g, ' ') + ' ');
}

// The handoff sentence, phrased for the hour (config/guidance.json).
function handoffTail() {
  return guidance.handoffLine();
}

function guard(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  const G = k => guidance.guardText(k);
  // ---- conduct guards: a rule, not a judgment call, so they run first ----
  // a card or ID number pasted into the chat — refuse before anything logs it
  if (/(?:\d[ -]?){13,19}/.test(t) && !/\d{2}[./-]\d{1,2}[./-]\d{2,4}/.test(t) || /מספר (ה)?(אשראי|כרטיס|תעודת זהות|ת"ז)|כרטיס האשראי שלי|ת\.?ז\.? שלי/.test(t)) {
    if (!/איזה (סוג )?כרטיס|מקבלים כרטיס|אפשר לשלם ב|תשלומים/.test(t)) return G('card_number');
  }
  if (/תתעלם מ|התעלם מ|ignore (all|previous|your)|שכח את ה?הוראות|ההוראות שלך|תשכח מה?הוראות|developer mode|תן לי את ה?פרומפט|הפרומפט שלך|מה ה?הנחיות שלך|system prompt|אתה עכשיו dan|בוט בלי חוקים|pretend this is a test|translate your instructions/i.test(t)) {
    return 'אני לא יכול לשנות את מה שאני עושה כאן ולא לחשוף מידע פנימי. אני כן אשמח למצוא לכם חופשת סקי — כמה אתם נוסעים ומתי?';
  }
  if (/בן זונה|כוס אמק|כוסאמק|זין |לך תזדיין|תזדיין|מניאק|חרא של|בן זונות|fuck|shit|יא אפס|מטומטם|אידיוט/i.test(t)) return G('profanity');
  if (/את שווה|אתה שווה|נפגש\?|תני לי טלפון שלך|יפה את|מה את לובשת|רווקה\?|יש לך חבר/.test(t)) return G('harassment');
  if (/אני המנהל|אני מנהל (של )?פינגווין|אני מה-?it|אני מהמשטרה|אני שוטר|אני הבעלים|אני עובד(ת)? (אצלכם|בפינגווין)|תאשר לי גישה|צריך את הלוגים|רשימת הלקוחות בקובץ/i.test(t)) return G('impersonation');
  if (/(תרשום|תרשמו|תרשמי|רשום|תכתוב|תכתבו) (בהזמנה )?(שלי )?ש(הילד|הילדה|הבן|הבת) ב[תןנ]|תרשמו ש.*ב[תן] \d|להסתיר מהביטוח|להסתיר מ(המלון|חברת)|מכתב ביטוח מזויף|ביקורת (חיובית )?מזויפת|תזייף|לזייף|בלי לשלם.*אשלם אחר כך|לרשום גיל אחר/.test(t)) return G('fraud');
  if (/בטוח לטוס|מסוכן לטוס|המצב הביטחוני|אם תהיה מלחמה|בגלל המלחמה|טילים|חות'ים|יסגרו את השמיים|לסגור את השמיים|מלחמה עם איראן|אזעק/.test(t) &&
      !/גרנטי|guarantee|הגנת מלחמה|החזר|מבטלים|ביטול/.test(t)) return G('security');
  if (/אנטישמי|שונאים ישראלים|מסוכן לישראלים|בטוח לישראלים|יהודים לא רצויים|לדבר עברית שם זה בסדר/.test(t)) return G('antisemitism');
  if (/ביבי|נתניהו|בנט|לפיד|גנץ|בן גביר|סמוטריץ|הממשלה|בחירות|המלחמה בעזה|עזה|הפגנ|שמאלנ|ימני|קואליציה|טראמפ|ביידן/.test(t) && /דעה|מה אתה חושב|מה אתם חושבים|בעד|נגד|מצביע/.test(t)) return G('politics');
  if (/כלב נחייה|כלב נחיה|כלב שירות|כלב עזר/.test(t)) return G('guide_dog');
  if (/דיזנהאוז|סקי דיל|skideal|אשת טורס|אשת תיירות|קווי חופשה|דקה 90|גוליבר|איסתא|אופיר טורס|קשרי תעופה|סופר סקי|superski|club ?med|קלאב מד/i.test(t) && !/דרך (איסתא|סוכן)|הזמנו דרך|הזמנתי דרך/.test(t)) return G('competitor_named');
  // their OWN booking is not a red rule — "לא מצליח להיכנס לאזור האישי עם
  // מספר ההזמנה" belongs to the my-booking answer, not to this refusal
  if (/שלי|שלנו|אזור האישי|לא מצליח להיכנס|הזמנתי|ביצעתי הזמנה|איפה אני רואה|הסטטוס של/.test(t)) { /* fall through */ }
  else if (/מי הזמין|שם של מי|מספר ה?הזמנה|מס' ה?הזמנה|מי גר|מי נמצא|רשימת ה?לקוחות|רשימת ה?הזמנות|פרטי ה?לקוח|פרטיו של לקוח|מי תפס|שמות ה?לקוחות|שמות או טלפונים|טלפונים של (נוסעים|לקוחות|אנשים)|פרטי קשר של (נוסעים|לקוחות)|להתחבר לנוסעים|נוסעים שכבר הזמינו|מי עוד הזמין|מי נוסע איתנו/.test(t)) {
    // Their OWN booking is a different question with a different answer: we
    // still show nothing, but "אין לי גישה לפרטי לקוחות אחרים" reads as an
    // accusation when someone is asking about the holiday they just bought.
    if (/שלי|שלנו|שהזמנתי|שהזמנו|שביצעתי/.test(t)) {
      return 'אין לי גישה למערכת ההזמנות ולא אוכל לראות הזמנה קיימת. ' +
        'נציג כן יכול — 04-8557722, או השאירו כאן שם וטלפון ונחזור אליכם.';
    }
    return 'אין לי גישה לפרטי לקוחות אחרים ולא אוכל לשתף אותם. אני יכול להראות רק מה פנוי.';
  }
  // Our cost price and commission are internal, full stop. The phrasing model
  // once answered "נציג יעביר לכם את עלות החדר לסוכן ואת העמלה" — a promise to
  // leak the margin, invented from thin air. This runs before any model sees
  // the message.
  if (/כמה (באמת )?עולה לכם|העלות שלכם|עלות החדר לכם|העמלה|כמה אתם מרוויחים|מחיר עלות|כמה אתם לוקחים לעצמכם|הרווח שלכם/.test(t)) {
    return 'מחירי העלות והתנאים המסחריים שלנו מול המלונות הם מידע פנימי שאני לא חושף. המחיר שרלוונטי לכם הוא המחיר בהצעה — והוא כולל את מה שכתוב עליה.';
  }

  // Red rule 10. An attempt to replace the instructions is answered plainly and
  // once. Ignoring it and answering the rest of the sentence leaves the
  // customer thinking it might work on the next try.
  // Red rule 3. This lived in deflect(), which is skipped when the message also
  // fills a slot — and "רק רוצה לדעת כמה עולה שבוע לזוג" fills one. A guard
  // that protects a rule cannot be conditional on what else the sentence did.
  // "בשקלים או ביורו? לפי איזה שער?" asks about the currency, not for a sum
  if (/שער|מטבע|או ביורו|או בשקלים|בשקלים או|ביורו או|לשלם ב(שקל|יורו|דולר)/.test(t)) return null;
  if (/כמה (זה )?עולה|מה המחיר|המחיר המדויק|מחיר מדויק|כמה יעלה|בשקלים|ביורו|תן לי מחיר|תגיד לי מחיר|תגידו לי מחיר|כמה כסף|מה העלות|בכמה (זה )?יוצא|כמה זה יוצא|כמה עולות/.test(t)) {
    return 'המחיר המדויק לחדר ולתאריך שלכם מוצג במסך ההזמנה, ונציג יאשר אותו סופית. כאן אני מציג טווח בלבד.';
  }
  return null;
}

function deflect(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  // "מספר ההזמנה" with the definite article was walking straight past this
  if (/מי הזמין|שם של מי|מספר ה?הזמנה|מס' ה?הזמנה|מי גר|מי נמצא|רשימת לקוחות|פרטי לקוח|פרטיו של לקוח|מי תפס/.test(t)) {
    return 'אין לי גישה לפרטי לקוחות אחרים ולא אוכל לשתף אותם. אני יכול להראות רק מה פנוי.';
  }
  // any request for a number in money — "מה המחיר המדויק" and "מחיר בשקלים"
  // were slipping past and reaching the offers instead of the red-rule answer
  if (/כמה (זה )?עולה|מחיר מדויק|המחיר המדויק|בכמה|כמה יעלה|בשקלים|ביורו|מה המחיר|תן לי מחיר|תן לי הנחה|הנחה של|בחינם/.test(t)) {
    return 'המחיר המדויק לחדר ולתאריך שלכם מוצג במסך ההזמנה, ונציג יאשר אותו סופית. כאן אני מציג טווח בלבד.';
  }
  // Common follow-ups that were being answered by silently re-showing the same
  // three cards — which reads as a bot that did not listen.
  // not "כמה זמן הטיסה" — that is a different question with its own answer
  if (/כמה לילות|כמה ימים|כמה זמן.{0,12}חופשה|משך החופשה/.test(t) && !/טיסה|נסיעה/.test(t)) {
    return 'מספר הלילות מופיע על כל כרטיס — הוא משתנה לפי המוצר (7 לילות ברוב היעדים, ובבנסקו יש גם סופי שבוע קצרים).';
  }
  // "למה דווקא את אלה?" — the reason is already computed per card (why_he);
  // this points at it rather than leaving the customer to guess.
  if (/למה דווקא|למה אלה|למה בחרת|על סמך מה|איך בחרת|למה הצעת/.test(t)) {
    return 'בחרתי לפי מה שאמרתם: גודל החבורה, החודש, היעד ומה שציינתם שחשוב לכם. ' +
      'על כל הצעה כתוב למטה למה היא מתאימה. אם משהו לא מדויק — תגידו לי מה לשנות.';
  }

  // "אם זה לא סגור באמת תגידו לי" — a customer who wants to know whether what
  // they are looking at is firm. The honest answer is the whole architecture.
  if (/לא סגור באמת|זה סגור\?|באמת פנוי|זה ודאי|תגידו לי עכשיו|לא רציני/.test(t)) {
    return 'אני מציג רק מה שרשום אצלנו כפנוי בפועל — לא פרסום. מה שאני לא יכול הוא לשריין: ' +
      'ההזמנה נסגרת מול נציג, והוא זה שמאשר סופית מול המלון והטיסה. ' +
      'אם חשוב לכם לנעול תאריך, השאירו שם וטלפון ונציג יחזור אליכם מהר.';
  }

  // "זה לא עונה לי" — a refusal without a reason. Asking what to change beats
  // repeating the same three offers with a different sentence above them.
  if (/לא עונה לי|לא מתאים לי|לא זה|לא אהבתי|משהו אחר לגמרי|לא בא לי אף אחד/.test(t)) {
    return 'תגידו לי מה לשנות — יעד אחר, חודש אחר, קרוב יותר למסלול או תקציב נמוך יותר — ואביא הצעות אחרות.';
  }

  // Ski pass and transfers are package-wide rules we know, so answer them
  // instead of pointing at the booking screen. Handled per offer as well, on
  // the card, where the pass area (local vs extended) is stated.
  if (/סקי ?פס/.test(t)) {
    return 'סקי פס כלול בחבילות לאוסטריה, צרפת ואנדורה. בבולגריה הוא נרכש בנפרד. ' +
      'היקף הפס (מקומי או מרחבי) משתנה בין היעדים ומצוין על כל הצעה.';
  }
  if (/מה כלול|כלול במחיר|מה מקבלים|כולל טיסה|כולל טיסות|מה כולל|כולל המחיר|החבילה כוללת|מה יש בחבילה|זה עם טיסות/.test(t)) {
    return 'בכל החבילות כלולות טיסות הלוך ושוב והסעות משדה התעופה למלון ובחזרה. ' +
      'סקי פס כלול בכל היעדים למעט בולגריה, והשכרת ציוד היא תוספת בתשלום (במועדוני השמש היא כלולה). ' +
      'בסיס האירוח משתנה בין המלונות ומצוין על כל הצעה.';
  }
  if (/שעה|שעות טיסה|מתי ממריא|מתי הטיסה|לוח טיסות/.test(t)) {
    return 'שעות הטיסה אינן סופיות ועשויות להשתנות, ולכן לא אציין אותן כאן. נציג ימסור לכם את הפרטים המעודכנים.';
  }
  // "תחזרו אליי" is a request, not small talk. It used to fall through to the
  // offers and be ignored entirely.
  if (WANTS_CALLBACK.test(t)) {
    // the widget opens the form itself (see wantsCallback below), so this only
    // has to say what is about to happen
    // the form is about to open, so do not also explain where to find a button
    const h = (guidance.load().handoff_he || {});
    return `בשמחה — השאירו כאן שם וטלפון ונציג יחזור אליכם${h.phone ? `, או שאפשר להתקשר ל-${h.phone}` : ''}.`;
  }
  // An existing booking is never something this bot should touch.
  if (/הזמנה קיימת|כבר הזמנתי|ההזמנה שלי|לשנות תאריך.{0,15}הזמנה|לבטל את ההזמנה|שינוי בהזמנה/.test(t)) {
    return 'שינוי בהזמנה קיימת נעשה מול נציג ולא דרכי. ' + handoffTail();
  }
  // Dissatisfaction is on topic by definition. It used to get "I only handle
  // ski holidays", which is the worst possible answer to an unhappy customer.
  if (/לא מה שחיפשתי|לא מה שרציתי|לא מתאים לי|לא אהבתי|משהו אחר|לא זה/.test(t)) {
    return 'סליחה, בואו נדייק — מה לשנות? תאריך, יעד, גודל החדר או משהו אחר?';
  }
  // Travelling with a pet is an ordinary travel question, not off topic.
  if (/כלב|חתול|חיית מחמד|בעל ?חיים/.test(t)) {
    return 'מדיניות בעלי חיים נקבעת על ידי המלון וחברת התעופה ומשתנה ביניהם. ' + handoffTail();
  }
  if (/רוצה להזמין|אני מזמין|לסגור|נסגור|איך מזמינים|רוצה לקחת|קח את|ניקח את|בוא ניקח|נלך על|אני בוחר|אנחנו בוחרים|זה נראה לי|מתאים לנו/.test(t)
      && !/לא מצליח|לא מצליחה|מנסה כבר|כבר שבוע|אף אחד לא|בעיה/.test(t)) {
    return 'מצוין. לחצו "המשך להזמנה" בכרטיס שבחרתם כדי לראות את המחיר המדויק, או "תחזרו אליי" ונציג יסגור איתכם — ההזמנה סופית רק אחרי אישור נציג ומייל עם קבלה.';
  }
  if (/הכי משתלם|הכי זול|מתי זול|איפה זול|הכי כדאי מבחינת מחיר/.test(t)) {
    return 'המחיר משתנה לפי יעד, מלון ותאריך. אמרו לי מתי נוח לכם ואציג את האפשרויות מהזול ליקר — או לחצו "תקציב חסכוני" אחרי שתראו הצעות.';
  }
  if (/מה ההבדל|במה שונ|להשוות|השוואה|איזה עדיף|מה ממליץ|מה הכי טוב/.test(t)) {
    return 'ההבדלים המרכזיים מופיעים על כל כרטיס — היישוב, המרחק מהמעלית, מה יש במלון וטווח המחיר. נציג ישמח לעבור איתכם על ההבדלים לעומק.';
  }
  if (/לא מה שביקשתי|לא התאים|לא רלוונטי|לא זה|לא מדויק/.test(t)) {
    return 'סליחה על כך. אפשר לחדד — יעד אחר, חודש אחר, או תקציב? אפשר גם ללחוץ על אחד הצ׳יפים למטה.';
  }
  if (/^ ?(תודה|תודה רבה|מעולה|מגניב|סבבה|יופי)[!. ]* ?$/.test(t)) {
    return 'בשמחה. אם תרצו לחדד משהו — יעד, חודש או תקציב — אני כאן.';
  }
  return null;
}

module.exports = {
  faq,
  faqMulti,
  faqEntries,
  isPause,
  PAUSE_HE,
  comparingLine,
  bothMonthsLine,
  isRequirementNote,
  socialLine,
  unknownResort,
  relaxationLines,
  guard,
  offCommitmentLine,
  canonicalDestination,
  notUnderstood,
  isFarewell,
  FAREWELL_HE,
  unknownHotel,
  isGreeting,
  wantsMore,
  hotelNamed,
  wantsCallback,
  unknownAnswer,
  noMatchAnswer, parseText, nextQuestion, phrase, deflect, leadIntent, foreignLanguage };
