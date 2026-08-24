// OFFLINE demo mode — deterministic Hebrew understanding, zero AI, zero cost.
// Used automatically when no ANTHROPIC_API_KEY is configured. When Tomer adds
// a key to .env the server upgrades itself to Claude (server.js decides).
// Not as flexible as Claude, but honors the exact same slot schema and the
// same conversation policy (max 2 questions, one per message).

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
  [/סולדאו/, 'Soldeu', 'andorra'], [/פ[א]?ס ?דה ?לה ?קאסה|פאס(?![א-ת])/, 'Pas de la Casa', 'andorra'],
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
  [/אפרה|חיי לילה|ברים/, 'אפרה-סקי'],
  [/ספא|סאונה|ג'?קוזי|בריכה|עיסוי|מרחץ/, 'ספא'],
  [/קרוב למסלול|על המסלול|קרוב למעלי|ליד המעלי|הליכה קצרה|מרחק הליכה קצר|ski ?in/i, 'קרוב למסלולים'],
  [/שקט|רגוע|לא רועש/, 'שקט'],
  [/מתחיל|לא גלשנו|פעם ראשונה|ללמוד לגלוש/, 'מתחילים'],
  [/זול|תקציב|חסכוני|משתלם/, 'תקציב'],
  [/עיירה|אטרקציות|בילויים|דברים לעשות/, 'עיירה תוססת'],
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
  const t = ' ' + text
    .replace(/([א-ת])[-–—]([א-ת])/g, '$1 $2')
    .replace(/[!?.,]{2,}/g, ' ')
    .replace(/\s+/g, ' ').trim() + ' ';

  // The question we just asked is the strongest signal about what this
  // message means. A bare "4" after "באילו גילאים?" is an AGE — never a count.
  const answering = s._lastQuestion || null;
  const askedChildren = answering === 'children' || answering === 'children_ages';
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
    const ageChunk = t.match(/(?:^|[^א-ת])(?:בני|בנות|בגילאי|גילאי|בגיל|בן|בת)(?![א-ת])[^.!?]{0,45}/g);
    let ages = [];
    if (ageChunk) {
      for (let chunk of ageChunk) {
        chunk = chunk.split(/ינואר|פברואר|מרץ|מארס|דצמבר|חנוכה|פורים/)[0];
        for (const m of chunk.matchAll(/(?:^|[^\d])(\d{1,2})(?![\d])/g)) {
          const n = +m[1];
          if (n >= 0 && n <= 17) ages.push(n);
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
    // --- bare numbers answering the children question ARE the ages
    if (!ages.length && askedChildren) {
      ages = allNums.filter(n => n >= 0 && n <= 17).slice(0, 4);
    }
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
  if (/אני לבד|לבד|רק אני|נוסע לבד|נוסעת לבד/.test(t)) s.adults = 1;
  // "שני זוגות" is four people, not two
  let pm = t.match(/(\d{1,2}|[א-ת]+)\s*זוגות/);
  if (pm) { const n = +pm[1] || heNum(pm[1]); if (n) s.adults = n * 2; }
  else if (/זוג(?!ל|ות)/.test(t) && (s.adults == null || correcting)) s.adults = 2;
  // "שני הורים" / "ההורים" — parents are adults
  let hm = t.match(/(\d{1,2}|[א-ת]+)\s*הורים/);
  if (hm) { const n = +hm[1] || heNum(hm[1]); if (n) s.adults = n; }
  else if (/ההורים|הורים/.test(t) && s.adults == null) s.adults = 2;
  // "2+2" — the standard Israeli shorthand for two adults and two children
  if (s.adults == null && !/מבוגר|ילד|גיל|בני/.test(t)) {
    const pp = t.match(/(?:^|[^\d])(\d)\s*\+\s*(\d)(?![\d])/);
    if (pp) { s.adults = +pp[1]; if (+pp[2]) { s.children_count = +pp[2]; s.no_children = false; } }
  }
  let m = t.match(/(\d{1,2}|[א-ת]+)\s*(?:מבוגר[יי]?[םמ]|גדולים)/);
  if (m) s.adults = +m[1] || heNum(m[1]) || s.adults;
  // an explicit party statement always wins, corrected or not
  // "4 חברים לסנובורד" states the party as plainly as "4 אנשים" does; missing
  // it sent a group of four to be asked "כמה מבוגרים?" they had just answered.
  // Word numbers count too ("שני חברים"). "בנים"/"בנות" are left out on
  // purpose — they usually mean children.
  m = t.match(/(?:אנחנו|נהיה|סה"כ|סהכ)\s*(\d{1,2})/) ||
      t.match(/(\d{1,2}|[א-ת]+)\s*(?:אנשים|נוסעים|אורחים|חברים|חברות|בחורים|בחורות|גברים|נשים)(?![א-ת])/);
  if (m) {
    const total = +m[1] || heNum(m[1]);
    if (total) {
      const kids = (s.children_ages || []).length;
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
    m = t.match(/(?:משפחה של|של)\s*(\d{1,2})/);
    if (m) {
      const total = +m[1], kids = (s.children_ages || []).length;
      // "משפחה של 5, הילדים בני 6 ו-9" → three adults.
      // "משפחה של 4" alone is still four travellers; leaving adults unknown
      // meant asking "כמה מבוגרים?" of someone who had just said.
      if (kids && total > kids) s.adults = total - kids;
      else if (!kids && total >= 1 && total <= 20) s.adults = total;
    }
  }
  // "אני ואחי", "אני, אשתי ו..." — count adult person-words.
  // NOTE: JS \b doesn't work with Hebrew letters, so boundaries are explicit.
  if (s.adults == null) {
    const people = [];
    for (const m2 of t.matchAll(/(?:^|[^א-ת])(?:ו|ש|וש|כש)?(אני|אחי|אחותי|אשתי|בעלי|בן זוגי|בת זוגי|אמא שלי|אבא שלי|חבר שלי|חברה שלי)(?![א-ת])/g)) people.push(m2[1]);
    const uniq = new Set(people);
    if (uniq.has('אני') && uniq.size >= 2) s.adults = uniq.size;
  }

  // --- month
  s.out_of_season = false;
  for (const [re, v] of MONTHS) if (re.test(t)) { s.month = v; break; }
  // a numeric date the customer wrote as "15.2" / "5/1"
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
  if (s.month == null && /אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|קיץ|פסח/.test(t)) {
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

  if (/לא משנה|גמיש|מתי שיש|כל תאריך|אין העדפה/.test(t)) {
    if (s.month == null) s.month = 'any';
    s.flexible_dates = true;
    s.month_part = null;
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

  // --- Sabbath observance: a hard constraint, not a preference. Saturday
  // departures must disappear entirely rather than be ranked lower.
  // NOT כשר: asking whether the food is kosher says nothing about flying on
  // Saturday, and inferring it silently removed every Saturday departure from
  // a customer who had only asked about a meal.
  if (/שומר[יי]? שבת|שומרים שבת|לא בשבת|לא ביום שבת|לא טסים בשבת|דתי|שבת שלום/.test(t)) {
    s.no_saturday_flights = true;
  }

  // --- trip length: "לשבוע" is a requirement, not a wish. A 3-night weekend
  // shown to someone who asked for a week is the wrong product.
  if (/לשבוע|שבוע שלם|7 לילות|שבועיים/.test(t)) s.nights_wanted = 7;
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
  if (answering === 'adults' && s.adults == null && !allAdults) {
    const bare = t.trim().match(/^(\d{1,2}|[א-ת]+)(?:\s*(?:אנשים|נוסעים|מבוגרים))?$/);
    if (bare) { const n = +bare[1] || heNum(bare[1]); if (n) s.adults = n; }
  } else if (answering === 'month' && s.month == null) {
    const bare = t.trim().match(/^(\d{1,2})$/);
    if (bare && +bare[1] >= 1 && +bare[1] <= 12) s.month = +bare[1];
  }

  // --- preferences (only if mentioned!)
  const prefs = new Set(s.preferences || []);
  for (const [re, v] of PREFS) if (re.test(t)) prefs.add(v);
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
  if (slots.adults == null) q = { key: 'adults', blocking: true, he: 'כמה תהיו בסך הכל? אדייק לפי זה' };
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
    q = { key: q.key, he: retry[q.key] || q.he };
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

function phrase(result, slots, cards) {
  const lines = [];
  const note = ty => (result.notes || []).find(n => n.type === ty);

  // a resort we sell but hold no commitments for: never say "unavailable",
  // never quote availability we don't have — say what it depends on and route
  // it to a rep, while still showing what IS on commitment
  const offComm = note('destination_off_commitment');
  if (offComm) {
    // wording lives in config/off-commitment.json so Tomer can edit it without
    // touching code. Never the word "התחייבויות" — that is internal jargon and
    // reads as a refusal; explain the real constraint (seats) instead.
    const cfg = OFF_COMMITMENT_COPY;
    const tpl = (cfg.constraint_by_country || {})[offComm.country] || cfg.constraint_default;
    const dates = (offComm.open_dates || []).map(fmtDay);
    lines.push([
      tpl.replace('{resort}', offComm.name),
      dates.length ? cfg.with_dates_he.replace('{dates}', dates.join(', ')) : cfg.no_dates_he,
      cfg.caveat_he,
      cfg.meanwhile_he,
    ].join(' '));
  }

  if (note('out_of_season')) {
    lines.push('עונת הסקי שלנו היא דצמבר עד סוף מרץ. בחודשים אחרים אין לנו יציאות.');
  }

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

  const campAge = note('camp_age_mismatch');
  if (campAge) {
    const ages = (campAge.ages || []).join(', ');
    lines.push(ages
      ? `שימו לב: הקייטנות שלנו מיועדות לגילאי 4-13, ולכן אין קבוצה מתאימה לגיל ${ages}. הנה מה שפנוי:`
      : 'הקייטנות שלנו מיועדות לגילאי 4-13. הנה מה שפנוי:');
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
    if (r.type === 'month') lines.push(`לא מצאתי בדיוק ב${MONTH_HE[r.from] || r.from}, אז הרחבתי ל${MONTH_HE[r.to] || r.to}:`);
    if (r.type === 'location') lines.push('לא מצאתי ביעד שביקשתם, אז הנה אופציות פנויות ביעדים אחרים:');
    if (r.type === 'two_rooms') lines.push('אין יחידה אחת שמתאימה לכל ההרכב — אבל אפשר לשלב שני חדרים באותו מלון:');
    if (r.type === 'nights') lines.push(`לא מצאתי בדיוק ${r.wanted} לילות, אז הרחבתי גם למשכים אחרים:`);
    if (r.type === 'camp_month') {
      lines.push(`ב${MONTH_HE[r.from] || 'חודש שביקשתם'} אין שבוע שבו פועלת קבוצת הגיל של הילד, אז הצגתי את ${MONTH_HE[r.to] || 'חודש אחר'} — שם היא כן פועלת:`);
    }
    if (r.type === 'camp_location') {
      lines.push('ביעד שביקשתם אין שבוע שבו פועלת קבוצת הגיל של הילד. הנה יעדים שבהם היא כן פועלת:');
    }
    if (r.type === 'month_part') {
      const HE = { early: 'תחילת', mid: 'אמצע', late: 'סוף' };
      lines.push(`ב${HE[r.wanted] || ''} החודש שביקשתם אין יציאה מתאימה, אז הרחבתי לכל החודש:`);
    }
    if (r.type === 'human_rep') lines.push(noMatchAnswer());
  }
  // Offline, or when the model's wording is rejected, these still must not
  // vanish — the template says them plainly rather than well.
  const heard = (slots.notes_from_customer || []).filter(Boolean);
  if (cards.length && heard.length) {
    lines.push('רשמתי לפניי: ' + heard.join(' · ') + '. אעביר את זה לנציג שילווה אתכם.');
  }

  // The answer to "יקר לי", in Tomer's own words from config/guidance.json.
  const obj = guidance.objection('too_expensive');
  if (obj && note('cheaper_found')) lines.push(obj.cheaper);
  if (obj && note('no_cheaper')) lines.push(obj.none);

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

  // acknowledge an active preference, so a refine chip visibly does something
  const prefs = slots.preferences || [];
  if (cards.length && prefs.length && !lines.length) {
    const budget = /תקציב/.test(prefs.join(' '));
    const others = prefs.filter(p => !/תקציב/.test(p));
    const bits = [];
    if (budget) bits.push('מהזול ליקר');
    if (others.length) bits.push('לפי ' + others.join(', '));
    lines.push('סידרתי מחדש ' + bits.join(' ו') + ' (הנציג יאשר סופית):');
  }
  // say out loud what was taken into account, then what a rep must confirm
  const applied = note('applied_requirements');
  if (cards.length && applied && applied.items.length >= 2) {
    lines.push('לקחתי בחשבון: ' + applied.items.join(' · ') + '.');
  }
  if (cards.length && !lines.length) lines.push('הנה מה שנראה פנוי אצלנו (הנציג יאשר סופית):');
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
    if (c.occ && c.occ.max != null) why.push(`מתאים ל-${slots.adults != null ? (slots.adults + (slots.children_ages || []).length) : c.occ.max} נוסעים`);
    if (c.camps && c.camps.full && (slots.children_ages || []).length) why.push('קייטנה בעברית לכל הילדים באותו שבוע');
    else if (c.camps && !c.camps.full && c.camps.missing.length) why.push(`שימו לב: פועלת רק קבוצת ${c.camps.running.join(' + ')} — אין קבוצת ${c.camps.missing.join(', ')} בשבוע זה`);
    else if (c.camps && c.camps.waitlist_only && c.camps.waitlist_only.length) why.push(`קבוצת ${c.camps.waitlist_only.join(',')} בהרשמת המתנה (ללא חיוב)`);
    // reference the customer's own stated preferences that this hotel matches
    const matched = (slots.preferences || []).filter(p => (c.tags || []).includes(p));
    if (matched.length) why.push('תואם למה שביקשתם: ' + matched.join(', '));
    if (c.recommended) why.push('מהמבוקשים ביותר אצלנו');
    if ((slots.preferences || []).includes('תקציב') && c.price_range.length <= 2) why.push('ידידותי לתקציב');
    c.why_he = why.join(' · ');
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

// Standing answers to the questions customers actually ask (config/faq.json).
// Before this, anything with a question mark and no ski vocabulary in it got
// "אני כאן בעיקר להתאמת חופשות סקי" — i.e. a customer asking about
// cancellation or kosher food was told that is not our subject.
const guidance = require('./guidance.js');

const FAQ = (() => {
  const raw = JSON.parse(require('fs').readFileSync(
    require('path').join(__dirname, '..', 'config', 'faq.json'), 'utf8'));
  return raw.entries.map(e => ({ id: e.id, re: new RegExp(e.match, 'i'), he: e.answer_he }));
})();

// Order matters: the file lists the more specific patterns first, and the
// first match wins. Returns {id, he} so callers can log which answer fired.
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
  if (/כמה לילות|כמה ימים|משך|כמה זמן/.test(t)) {
    return 'מספר הלילות מופיע על כל כרטיס — הוא משתנה לפי המוצר (7 לילות ברוב היעדים, ובבנסקו יש גם סופי שבוע קצרים).';
  }
  // Ski pass and transfers are package-wide rules we know, so answer them
  // instead of pointing at the booking screen. Handled per offer as well, on
  // the card, where the pass area (local vs extended) is stated.
  if (/סקי ?פס/.test(t)) {
    return 'סקי פס כלול בחבילות לאוסטריה, צרפת ואנדורה. בבולגריה הוא נרכש בנפרד. ' +
      'היקף הפס (מקומי או מרחבי) משתנה בין היעדים ומצוין על כל הצעה.';
  }
  if (/מה כלול|כלול במחיר|מה מקבלים|כולל טיסה/.test(t)) {
    return 'בכל החבילות כלולות טיסות הלוך ושוב והסעות משדה התעופה למלון ובחזרה. ' +
      'סקי פס כלול בכל היעדים למעט בולגריה, והשכרת ציוד היא תוספת בתשלום (במועדוני השמש היא כלולה). ' +
      'בסיס האירוח משתנה בין המלונות ומצוין על כל הצעה.';
  }
  if (/שעה|שעות טיסה|מתי ממריא|מתי הטיסה|לוח טיסות/.test(t)) {
    return 'שעות הטיסה אינן סופיות ועשויות להשתנות, ולכן לא אציין אותן כאן. נציג ימסור לכם את הפרטים המעודכנים.';
  }
  if (/רוצה להזמין|אני מזמין|לסגור|נסגור|איך מזמינים|רוצה לקחת/.test(t)) {
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
  unknownAnswer,
  noMatchAnswer, parseText, nextQuestion, phrase, deflect };
