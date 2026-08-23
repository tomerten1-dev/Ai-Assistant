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
const PREFS = [
  [/אפרה/, 'אפרה-סקי'], [/ספא/, 'ספא'], [/קרוב למסלול|על המסלול/, 'קרוב למסלולים'],
  [/שקט/, 'שקט'], [/מתחיל/, 'מתחילים'], [/זול|תקציב|חסכוני/, 'תקציב'],
  [/עיירה|אטרקציות|חיי לילה|בילויים|דברים לעשות/, 'עיירה תוססת'],
  [/הכל כלול/, 'הכל כלול'],
];

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
    const ageChunk = t.match(/(?:בני|בנות|בגילאי|גילאי|בגיל|בן|בת)[^.,!?]{0,30}/g);
    let ages = [];
    if (ageChunk) {
      for (const chunk of ageChunk) {
        for (const m of chunk.matchAll(/(?:^|[^\d])(\d{1,2})(?![\d])/g)) {
          const n = +m[1];
          if (n >= 0 && n <= 17) ages.push(n);
        }
      }
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
  if (/זוג(?!ל)/.test(t) && s.adults == null) s.adults = 2;
  let m = t.match(/(\d{1,2}|[א-ת]+)\s*מבוגרים/);
  if (m) s.adults = +m[1] || heNum(m[1]) || s.adults;
  if (s.adults == null) {
    m = t.match(/(?:אנחנו|נהיה|סה"כ|סהכ)\s*(\d{1,2})/) || t.match(/(\d{1,2})\s*(?:אנשים|נוסעים|אורחים)/);
    if (m) {
      const total = +m[1];
      const kids = (s.children_ages || []).length;
      s.adults = kids && total > kids ? total - kids : total;
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
  for (const [re, v] of MONTHS) if (re.test(t)) { s.month = v; break; }
  if (/לא משנה|גמיש|מתי שיש|כל תאריך|אין העדפה/.test(t)) {
    if (s.month == null) s.month = 'any';
    s.flexible_dates = true;
  }

  // --- departure airport (config/departures.json holds what each one flies)
  if (/מחיפה|מ ?חיפה|חיפה/.test(t)) s.departure_airport = 'haifa';
  else if (/תל ?-?אביב|ת"א|נתב"ג|בן ?-?גוריון/.test(t)) s.departure_airport = 'tlv';

  // --- country / destination
  for (const [re, v] of COUNTRIES) if (re.test(t)) { s.country = v; break; }
  for (const [re, dest, country] of DESTS) if (re.test(t)) { s.destination = dest; s.country = s.country || country; break; }

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

// which single question to ask next (max 2 total is enforced by server.js).
// prevKey = the question the user just answered; never repeat it verbatim —
// if the answer wasn't understood, ask again in a clearer way.
function nextQuestion(slots, prevKey) {
  let q = null;
  if (slots.adults == null) q = { key: 'adults', he: 'כמה מבוגרים תהיו בחופשה?' };
  else if (!(slots.children_ages || []).length && slots.no_children !== true) {
    q = slots.children_count
      ? { key: 'children_ages', he: slots.children_count === 1 ? 'בן כמה הילד?' : 'באילו גילאים הילדים?' }
      : { key: 'children', he: 'נוסעים גם ילדים, ואם כן — באילו גילאים?' };
  }
  else if (slots.month == null) q = { key: 'month', he: 'מתי תרצו לצאת? (דצמבר–מרץ, אפשר גם "גמיש")' };
  else {
    const kids = (slots.children_ages || []).some(a => a >= 4 && a <= 13);
    if (kids && slots.needs_hebrew_kids_club == null)
      q = { key: 'kids_club', he: 'תרצו קייטנת סקי בעברית לילדים?' };
  }
  if (q && prevKey && (q.key === prevKey ||
      (q.key === 'children' && prevKey === 'children_ages') ||
      (q.key === 'children_ages' && prevKey === 'children'))) {
    const retry = {
      adults: 'סליחה, לא הצלחתי להבין — רק מספר המבוגרים (למשל: 2)',
      children: 'רק גילאי הילדים במספרים, למשל: 5 ו-9 (או "בלי ילדים")',
      children_ages: 'רק הגילאים במספרים, למשל: 5 ו-9',
      month: 'באיזה חודש? דצמבר, ינואר, פברואר או מרץ (או "גמיש")',
      kids_club: 'קייטנה בעברית לילדים — כן או לא?',
    };
    q = { key: q.key, he: retry[q.key] || q.he };
  }
  return q;
}

/* ---------- template phrasing (offline replacement for the phrasing model) ---------- */
const MONTH_HE = { 12: 'דצמבר', 1: 'ינואר', 2: 'פברואר', 3: 'מרץ' };

function phrase(result, slots, cards) {
  const lines = [];
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

module.exports = { parseText, nextQuestion, phrase };
