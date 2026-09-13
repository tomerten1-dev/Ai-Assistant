'use strict';
/* Hotel characterization — "מה ההבדל בין Sport ל-Ferienhof?", "איזה מהם
   מתאים לנו?" (Tomer, 06/09, after the Sunny session: "כן תיתן לו לאפיין
   אבל שלא ייתן מחירים ספציפיים").

   Sunny does not rank ("הכי טוב") — she characterizes: what each hotel is
   about, and "אם חשוב לכם X — A; אם Y — B". This does the same from data we
   already hold and Tomer already approved: the hotel's tags, stars and
   booking score, and the facts quoted from its page on pingwin.co.il
   (data/resorts.json → page_facts, lift_he, board_he). Nothing is generated.

   Red rules kept: no money (rule 3), no "הכי" (rule 4 — a characterization
   is not a ranking), what the page does not say is said to be unknown. */

const COMPARE_ASK = /מה ההבדל|במה (?:הם |הן )?שונ|להשוות|השוואה|תשוו|נשוו|השווה|מה עדיף|מה יותר טוב|איזה (?:מהם|משניהם|מהמלונות|מה?שלושה|יותר|עדיף|טוב|מתאים|מומלץ)|איזו (?:מהן|משתיהן|יותר|עדיפה|מתאימה)|מי מהם|תדרג|תאפיין|תאפייני|מה (?:יותר )?מתאים ל|מה מיוחד ב|ספר(?:ו|י)? לי על|תספר(?:ו|י)? (?:לי )?על|מה ההבדל ביניהם|ההבדל ביניהם|מה מבדיל|במה הם שונים|מה ההבדלים/;
const ONE_ASK = /מה מיוחד ב|ספר(?:ו|י)? לי על|תספר(?:ו|י)? (?:לי )?על|איך (?:ה)?מלון|מה דעתך על|מה אתה יודע על|מה יש ב/;

// Which of the page facts / tags say what. Neutral labels only — no
// superlatives from the marketing copy ("המיקום הכי טוב שאפשר!").
function attrs(info) {
  const pf = info.page_facts || {};
  const tags = new Set(info.tags || []);
  const txt = k => String(pf[k] || info[k] || '');
  const lift = txt('lift_he') + ' ' + txt('lift_page_he') + ' ' + txt('location_he');
  const out = {};
  if (/ski.?in|סקי.?אין|צמוד ל(?:מעלית|מסלול|גונדולה)|יציאה ישירה למסלול|על המסלול|חזרה על מגלשיים/i.test(lift)) out.lift = 'ממש על המסלול / צמוד למעלית';
  else {
    const m = lift.match(/כ-?\s?(\d{2,4})\s*מטר/);
    if (m && +m[1] <= 300) out.lift = 'כ-' + m[1] + ' מטר מהמעלית';
    else if (m) out.walk = 'כ-' + m[1] + ' מטר מהמעלית';
    else if (/דקות הליכה|הליכה קצרה/.test(lift)) out.walk = 'כמה דקות הליכה מהמעלית';
    else if (/סקי.?בס|שאטל|אוטובוס/.test(lift)) out.shuttle = 'שאטל/סקי-בס למעליות';
    else if (tags.has('קרוב למסלולים')) out.lift = 'קרוב למסלולים';
  }
  if (tags.has('ספא') || /ספא|סאונה|ג'קוזי/.test(txt('spa_he') + txt('spa_page_he'))) out.spa = 'ספא' + (/ג'קוזי/.test(txt('spa_he') + txt('spa_page_he')) ? ' עם ג׳קוזי' : '');
  if (pf.pool_heated === true) out.pool = 'בריכה מחוממת';
  else if (/בריכ/.test(txt('pool_he'))) out.pool = /מקור/.test(txt('pool_he')) ? 'בריכה מקורה' : 'בריכה';
  if (txt('kids_he') || tags.has('משפחות')) out.kids = txt('kids_he') && /משחק|מועדון|ילדים/.test(txt('kids_he')) ? 'חדר משחקים / פינת ילדים' : 'מתויג למשפחות';
  if (tags.has('אפרה-סקי') || /אפרה|מועדון לילה/.test(txt('restaurant_he'))) out.apres = 'אפרה-סקי ובילויים צמודים';
  if (tags.has('עיירה תוססת')) out.lively = 'עיירה תוססת';
  if (tags.has('שקט') || /שקט|רגוע/.test(txt('location_he'))) out.quiet = 'מיקום שקט';
  if (tags.has('מתחילים')) out.beginners = 'מתאים למתחילים';
  if (tags.has('הכל כלול') || /הכל כלול|all inclusive/i.test(txt('board_he'))) out.allin = 'הכל כלול';
  const ren = txt('renovated_he').match(/20\d\d/);
  if (ren) out.renovated = 'שופץ ב-' + ren[0];
  if (/מרבית|כל החדרים/.test(txt('balcony_he'))) out.balcony = 'מרפסות ברוב החדרים';
  if (/חדר כושר/.test(txt('gym_he') + txt('spa_he'))) out.gym = 'חדר כושר';
  if (/לוקר|חדר סקי/.test(txt('ski_room_he'))) out.skiroom = 'חדר סקי / לוקרים';
  return out;
}

const PRIORITY = ['lift', 'allin', 'spa', 'pool', 'kids', 'apres', 'lively', 'quiet', 'beginners', 'renovated', 'balcony', 'gym', 'walk', 'shuttle', 'skiroom'];
const WANTS = [
  ['spa', /ספא|סאונה|ג'קוזי|לנוח|פינוק/], ['pool', /בריכ/], ['lift', /מסלול|מעלית|קרוב|ללכת|הליכה|סקי.?אין/],
  ['kids', /ילד|משפח|קטנים/], ['apres', /אפרה|לילה|בילוי|ברים|מסיב/], ['quiet', /שקט|רומנטי|רגוע/],
  ['beginners', /מתחיל|פעם ראשונה|לא גלש/], ['allin', /הכל כלול|אוכל|ארוחות/], ['renovated', /חדש|משופץ|שיפוץ|ישן/],
];

function shownHotels(prevSlots, engine, displayHotel) {
  const shown = (prevSlots._on_screen || []).length ? prevSlots._on_screen.slice(0, 3)
    : [...new Set((prevSlots._shown || []).map(x => String(x).split('|')[0]))].slice(-3);
  const keys = Object.keys(engine.resorts.hotels);
  return shown.map(d => keys.find(k => displayHotel(k) === d)).filter(Boolean);
}

/* The line, or null when this is not a characterization question. */
function line(lastUser, prevSlots, slots, engine, helpers) {
  const { displayHotel, ratingBadge, resortHe, hotelsNamed } = helpers;
  const text = String(lastUser || '');
  const named = [...new Set(hotelsNamed(text))].slice(0, 3);
  const asksCompare = COMPARE_ASK.test(text);
  const asksOne = ONE_ASK.test(text);
  let names = named;
  // "ואיזה מהם מתאים לנו?" right after "מה ההבדל בין Sport ל-Ferienhof?" is
  // about THOSE two — not the three cards on screen (S14, 06/09 smoke, which
  // profiled the cards and left Sport out). The pair just characterized is
  // remembered on the slots and wins over the cards; the cards remain the
  // fallback when nothing was compared yet.
  const lastCompared = (prevSlots._compared || []).filter(k => engine.hotelInfo(k));
  // "מה ההבדל בין אוסטריה לצרפת?" names two PLACES. That is the resort
  // engine's question (recommend.js), not a profile of whatever hotels happen
  // to be on screen (13/09: two Bansko cards were compared instead).
  if (!named.length && (slots.compare || []).length >= 2) return null;
  if (names.length < 2 && asksCompare) {
    const pool = lastCompared.length >= 2 ? lastCompared : shownHotels(prevSlots, engine, displayHotel);
    names = [...new Set([...named, ...pool])].slice(0, 3);
  }
  if (!names.length) return null;
  if (names.length === 1 && !asksOne && !asksCompare) return null;
  if (names.length >= 2 && !asksCompare && !asksOne) return null;
  slots._compared = names;

  const profiles = names.map(n => {
    const info = engine.hotelInfo(n) || {};
    return { key: n, name: displayHotel(n), resort: resortHe(info.resort) || info.resort || '', badge: ratingBadge(info), a: attrs(info) };
  });
  // what the customer said matters comes first in every list
  const wanted = WANTS.filter(([, re]) => re.test(text) || (slots.preferences || []).some(p => re.test(p))).map(([k]) => k);
  if ((slots.children_ages || []).length && !wanted.includes('kids')) wanted.push('kids');
  const order = [...wanted, ...PRIORITY.filter(k => !wanted.includes(k))];

  const lines = [];
  lines.push(names.length === 1 ? 'לפי דף המלון באתר פינגווין:' : 'במה הם שונים — לפי דפי המלונות באתר פינגווין:');
  for (const p of profiles) {
    const bits = order.map(k => p.a[k]).filter(Boolean).slice(0, 6);
    const head = p.name + (p.resort ? ' (' + p.resort + (p.badge ? ', ' + p.badge : '') + ')' : (p.badge ? ' (' + p.badge + ')' : ''));
    lines.push('• ' + head + ': ' + (bits.length ? bits.join(' · ') : 'הדף לא מפרט מתקנים — נציג יאמת') + '.');
  }
  if (profiles.length >= 2) {
    const ifs = [], both = [];
    for (const k of order) {
      const have = profiles.filter(p => p.a[k]);
      if (!have.length || k === 'walk' || k === 'shuttle') continue;
      if (have.length === profiles.length) { both.push(p_label(k)); continue; }
      if (ifs.length < 3) ifs.push('אם חשוב לכם ' + p_label(k) + ' — ' + have.map(p => p.name).join(' או '));
    }
    if (ifs.length) lines.push(ifs.join('. ') + '.');
    if (both.length) lines.push((profiles.length === 2 ? 'בשניהם' : 'בכולם') + ' יש ' + both.slice(0, 3).join(', ') + '.');
    // what they asked for and none of the pages mention — said, not skipped
    const missing = wanted.filter(k => !profiles.some(p => p.a[k]));
    if (missing.length) lines.push('לגבי ' + missing.map(p_label).join(' ו') + ' — הדפים של המלונות האלה לא מציינים, נציג יאמת.');
  }
  lines.push('מה שלא כתוב בדף — נציג יאמת; את המחיר המדויק לתאריך שלכם תראו במסך ההזמנה.');
  return lines.join('\n');
}
function p_label(k) {
  return { lift: 'קרבה ממש למעלית', allin: 'הכל כלול', spa: 'ספא', pool: 'בריכה', kids: 'מסגרת לילדים במלון',
    apres: 'אפרה-סקי ובילויים', lively: 'עיירה תוססת', quiet: 'שקט', beginners: 'התאמה למתחילים', renovated: 'מלון משופץ',
    balcony: 'מרפסת', gym: 'חדר כושר', skiroom: 'חדר סקי' }[k] || k;
}

module.exports = { line, attrs, COMPARE_ASK };
