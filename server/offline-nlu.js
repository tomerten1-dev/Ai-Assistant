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

  // --- children ages: "ילדים בני 5 ו-9", "ילד בן 7", "בני 5,9", "גילאי 4 ו-6"
  const ageChunk = t.match(/(?:ילדים|ילד|ילדה|בני|בגילאי|גילאי|בן|בת)[^.,!?]{0,30}/g);
  if (ageChunk) {
    const ages = [];
    for (const chunk of ageChunk) {
      for (const m of chunk.matchAll(/\b(\d{1,2})\b/g)) {
        const n = +m[1];
        if (n >= 0 && n <= 17) ages.push(n);
      }
    }
    if (ages.length) { s.children_ages = ages; s.no_children = false; }
  }
  if (/בלי ילדים|אין ילדים|רק מבוגרים|ללא ילדים/.test(t)) { s.no_children = true; s.children_ages = []; }

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

  // --- country / destination
  for (const [re, v] of COUNTRIES) if (re.test(t)) { s.country = v; break; }
  for (const [re, dest, country] of DESTS) if (re.test(t)) { s.destination = dest; s.country = s.country || country; break; }

  // --- kids club (גם האיות "קיטנה")
  if (/בלי קי?יטנה|לא צריך קי?יטנה|בלי ליווי/.test(t)) s.needs_hebrew_kids_club = false;
  else if (/קי?יטנ|ליווי בעברית|מדריך לילדים|מדריכים.{0,20}ילדים/.test(t)) s.needs_hebrew_kids_club = true;
  if (/^ ?(כן|בטח|כמובן|חובה|צריך|רוצים|כן כן) ?$/.test(t) && s._lastQuestion === 'kids_club') s.needs_hebrew_kids_club = true;
  if (/^ ?(לא|אין צורך|לא צריך) ?$/.test(t) && s._lastQuestion === 'kids_club') s.needs_hebrew_kids_club = false;
  if (/^ ?(לא|אין|בלי) ?$/.test(t) && s._lastQuestion === 'children') { s.no_children = true; s.children_ages = []; }

  // bare numbers as an answer to the open question
  const bare = t.trim().match(/^(\d{1,2})(?:\s*(?:אנשים|נוסעים))?$/);
  if (bare) {
    if (s._lastQuestion === 'adults' || s.adults == null) s.adults = +bare[1];
    else if (s._lastQuestion === 'month' && +bare[1] >= 1 && +bare[1] <= 12) s.month = +bare[1];
  }

  // --- preferences (only if mentioned!)
  const prefs = new Set(s.preferences || []);
  for (const [re, v] of PREFS) if (re.test(t)) prefs.add(v);
  s.preferences = [...prefs];

  return s;
}

// which single question to ask next (max 2 total is enforced by server.js)
function nextQuestion(slots) {
  if (slots.adults == null) return { key: 'adults', he: 'כמה מבוגרים תהיו בחופשה?' };
  if (!(slots.children_ages || []).length && slots.no_children !== true)
    return { key: 'children', he: 'נוסעים גם ילדים, ואם כן — באילו גילאים?' };
  if (slots.month == null) return { key: 'month', he: 'מתי תרצו לצאת? (דצמבר–מרץ, אפשר גם "גמיש")' };
  const kids = (slots.children_ages || []).some(a => a >= 4 && a <= 13);
  if (kids && slots.needs_hebrew_kids_club == null)
    return { key: 'kids_club', he: 'תרצו קייטנת סקי בעברית לילדים?' };
  return null;
}

/* ---------- template phrasing (offline replacement for the phrasing model) ---------- */
const MONTH_HE = { 12: 'דצמבר', 1: 'ינואר', 2: 'פברואר', 3: 'מרץ' };

function phrase(result, slots, cards) {
  const lines = [];
  if ((result.notes || []).some(n => n.type === 'france_february_gap')) {
    lines.push('שימו לב: אין לנו יציאות לצרפת בפברואר (מדלגים מ-30.1 ל-6.3) — אבל באוסטריה, אנדורה ובולגריה דווקא יש! הנה מה שפנוי:');
  }
  for (const r of result.relaxed || []) {
    if (r.type === 'month') lines.push(`לא מצאתי בדיוק ב${MONTH_HE[r.from] || r.from}, אז הרחבתי ל${MONTH_HE[r.to] || r.to}:`);
    if (r.type === 'location') lines.push('לא מצאתי ביעד שביקשתם, אז הנה אופציות פנויות ביעדים אחרים:');
    if (r.type === 'two_rooms') lines.push('אין יחידה אחת שמתאימה לכל ההרכב — אבל אפשר לשלב שני חדרים באותו מלון:');
    if (r.type === 'human_rep') lines.push('לא מצאתי התאמה במערכת — נציג אנושי ישמח לעזור: 04-8557722.');
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
