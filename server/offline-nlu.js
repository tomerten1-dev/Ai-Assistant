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

const MONTHS = [
  [/דצמבר|חנוכה/, 12], [/ינואר/, 1], [/פברואר/, 2], [/מרץ|מארס|פורים/, 3],
];
const COUNTRIES = [
  [/צרפת/, 'france'], [/אוסטריה/, 'austria'], [/אנדורה/, 'andorra'], [/בולגריה/, 'bulgaria'],
];
const DESTS = [
  [/מאיירהופן|מאירהופן/, 'Mayrhofen', 'austria'], [/אישגיל/, 'Ischgl', 'austria'],
  [/ואל טורנס|וואל טורנס/, 'Val Thorens', 'france'], [/טין(?![א-ת])|טיניי|Tignes/i, 'Tignes', 'france'],
  [/לה דוז|לה 2|les 2/i, 'Les 2 Alpes', 'france'], [/בנסקו/, 'Bansko', 'bulgaria'],
  [/בורובץ/, 'Borovets', 'bulgaria'], [/אבוריאז/, 'Avoriaz', 'france'],
  [/לז ארק|לה ארק/, 'Les Arcs', 'france'], [/פליין|גרנד מסיף/, 'Flaine Grand Massif', 'france'],
  [/אלפ ד|אלף ד/, "Alpe d'Huez", 'france'], [/מונז'נבר|מונזנבר/, 'Montgenevre', 'france'],
  [/סולדאו/, 'Soldeu', 'andorra'], [/פאס דה לה קאסה|פאס/, 'Pas de la Casa', 'andorra'],
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

const PREFS = [
  [/אפרה/, 'אפרה-סקי'], [/ספא/, 'ספא'], [/קרוב למסלול|על המסלול/, 'קרוב למסלולים'],
  [/שקט/, 'שקט'], [/מתחיל/, 'מתחילים'], [/זול|תקציב|חסכוני/, 'תקציב'],
  [/עיירה|אטרקציות|חיי לילה|בילויים|דברים לעשות/, 'עיירה תוססת'],
  [/הכל כלול/, 'הכל כלול'],
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
  const t = ' ' + text.replace(/\s+/g, ' ').trim() + ' ';

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
    const ageChunk = t.match(/(?:בני|בנות|בגילאי|גילאי|בגיל|בן|בת)[^.!?]{0,45}/g);
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
    if (ages.length) { s.children_ages = ages; s.no_children = false; }

    // --- child COUNT when no ages given yet: "שני ילדים", "3 ילדים",
    //     "ילד אחד", and bare singular "ילד" / "ילדה" (Hebrew has no \b)
    if (!(s.children_ages || []).length) {
      const cm = t.match(/(\d{1,2}|[א-ת]+)\s*ילדים/);
      if (cm) { const n = +cm[1] || heNum(cm[1]); if (n) { s.children_count = n; s.no_children = false; } }
      else if (/(?:^|[^א-ת])(?:ילד|ילדה|בת|בן)(?![א-ת])/.test(t) || /ילד אחד|ילדה אחת/.test(t)) {
        s.children_count = 1; s.no_children = false;
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
  let m = t.match(/(\d{1,2}|[א-ת]+)\s*מבוגרים/);
  if (m) s.adults = +m[1] || heNum(m[1]) || s.adults;
  // an explicit party statement always wins, corrected or not
  m = t.match(/(?:אנחנו|נהיה|סה"כ|סהכ)\s*(\d{1,2})/) || t.match(/(\d{1,2})\s*(?:אנשים|נוסעים|אורחים)/);
  if (m) {
    const total = +m[1];
    const kids = (s.children_ages || []).length;
    s.adults = kids && total > kids ? total - kids : total;
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
      if (kids && total > kids) s.adults = total - kids;
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
  if (/לא משנה|גמיש|מתי שיש|כל תאריך|אין העדפה/.test(t)) {
    if (s.month == null) s.month = 'any';
    s.flexible_dates = true;
  }

  // --- departure airport. A city name alone is NOT a departure airport:
  // "מה מזג האוויר בתל אביב" used to set the airport. Require either a
  // "from" prefix or an explicit flight word nearby.
  const flightCtx = /טיס|ממריא|יוצאים|יוצא|לעוף|לטוס|המראה|שדה/.test(t);
  if (/מחיפה/.test(t) || (flightCtx && /חיפה/.test(t))) s.departure_airport = 'haifa';
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
  for (const [re, dest, country] of DESTS) {
    const m2 = re.exec(t);
    if (!m2) continue;
    if (isNegated(t, m2.index)) {
      if (s.destination === dest) s.destination = null;
    } else {
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

  // --- kids club (גם האיות "קיטנה")
  if (/בלי קי?יטנה|לא צריך קי?יטנה|בלי ליווי/.test(t)) s.needs_hebrew_kids_club = false;
  else if (/קי?יטנ|ליווי בעברית|מדריך לילדים|מדריכים.{0,20}ילדים/.test(t)) s.needs_hebrew_kids_club = true;
  if (/^ ?(כן|בטח|כמובן|חובה|צריך|רוצים|כן כן) ?$/.test(t) && s._lastQuestion === 'kids_club') s.needs_hebrew_kids_club = true;
  if (/^ ?(לא|אין צורך|לא צריך) ?$/.test(t) && s._lastQuestion === 'kids_club') s.needs_hebrew_kids_club = false;
  if (/^ ?(לא|אין|בלי) ?$/.test(t) && s._lastQuestion === 'children') { s.no_children = true; s.children_ages = []; }

  // bare answer to the adults question — digits ("2") or words ("שניים")
  if (answering === 'adults' && s.adults == null) {
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
  // blocking: without these the search cannot run at all
  if (slots.adults == null) q = { key: 'adults', blocking: true, he: 'כמה מבוגרים תהיו בחופשה?' };
  else if (!(slots.children_ages || []).length && slots.no_children !== true) {
    q = slots.children_count
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
    lines.push('שימו לב: אין לנו יציאות לצרפת בפברואר (מדלגים מ-30.1 ל-6.3) — אבל באוסטריה, אנדורה ובולגריה דווקא יש! הנה מה שפנוי:');
  }
  for (const r of result.relaxed || []) {
    if (r.type === 'month') lines.push(`לא מצאתי בדיוק ב${MONTH_HE[r.from] || r.from}, אז הרחבתי ל${MONTH_HE[r.to] || r.to}:`);
    if (r.type === 'location') lines.push('לא מצאתי ביעד שביקשתם, אז הנה אופציות פנויות ביעדים אחרים:');
    if (r.type === 'two_rooms') lines.push('אין יחידה אחת שמתאימה לכל ההרכב — אבל אפשר לשלב שני חדרים באותו מלון:');
    if (r.type === 'human_rep') lines.push('לא מצאתי התאמה במערכת — נציג אנושי ישמח לעזור: 04-8557722.');
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
  if (cards.length && !lines.length) lines.push('הנה מה שנראה פנוי אצלנו (הנציג יאשר סופית):');

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

// Questions that deserve a real answer rather than another round of offers:
// asking for someone else's booking, or for an exact price. Silence here reads
// as evasion; these say plainly what the bot can and cannot do (red rules 2-3).
function deflect(text) {
  const t = ' ' + String(text || '').replace(/\s+/g, ' ') + ' ';
  if (/מי הזמין|שם של מי|מספר הזמנה|מי גר|מי נמצא|רשימת לקוחות|פרטי לקוח|מי תפס/.test(t)) {
    return 'אין לי גישה לפרטי לקוחות אחרים ולא אוכל לשתף אותם. אני יכול להראות רק מה פנוי.';
  }
  if (/כמה (זה )?עולה|מחיר מדויק|בכמה|כמה יעלה|כמה בשקלים|תן לי הנחה|הנחה של|בחינם/.test(t)) {
    return 'המחיר המדויק לחדר ולתאריך שלכם מוצג במסך ההזמנה, ונציג יאשר אותו סופית. כאן אני מציג טווח בלבד.';
  }
  // Common follow-ups that were being answered by silently re-showing the same
  // three cards — which reads as a bot that did not listen.
  if (/כמה לילות|כמה ימים|משך|כמה זמן/.test(t)) {
    return 'מספר הלילות מופיע על כל כרטיס — הוא משתנה לפי המוצר (7 לילות ברוב היעדים, ובבנסקו יש גם סופי שבוע קצרים).';
  }
  if (/מה כלול|כלול במחיר|מה מקבלים|כולל טיסה|סקי פס/.test(t)) {
    return 'ההרכב המדויק משתנה בין המלונות — טיסה, העברות, לינה וסקי פס מפורטים בדף המלון ובמסך ההזמנה, ונציג יעבור על זה איתכם.';
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

module.exports = { parseText, nextQuestion, phrase, deflect };
