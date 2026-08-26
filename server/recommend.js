'use strict';
/* Reasoned resort recommendations — questionnaire q25 (Tomer: "אני מסכים
   לגבי המלצה מנומקת מתוך נתונים מאושרים").

   Everything said here comes from config/resort-profiles.json rows with
   approved=true (Tomer signs the table in docs/resort-table.xlsx), plus the
   transfer distances / reps in departures.json and the camp list. The bot
   never ranks hotels (rule 4), never says a money number (rule 3), never a
   travel time (rule 5) — distances are km, altitudes are metres.

   Two kinds of question:
     • "איזה אתר מתאים ל…" / "איפה הכי…"  → the top matches for an audience or
       an attribute, each with the facts that make it a match.
     • "X או Y" / "מה ההבדל בין X ל-Y"     → side by side, then who each one suits.
*/
const fs = require('fs');
const path = require('path');
const CFG = path.join(__dirname, '..', 'config');
const profiles = JSON.parse(fs.readFileSync(path.join(CFG, 'resort-profiles.json'), 'utf8'));
const departures = JSON.parse(fs.readFileSync(path.join(CFG, 'departures.json'), 'utf8'));
let camps = { resorts: [] };
try { camps = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'camps.json'), 'utf8')); } catch { }

const COUNTRY_HE = { austria: 'אוסטריה', bulgaria: 'בולגריה', andorra: 'אנדורה', france: 'צרפת' };
const PRICE_HE = { budget: 'מהמשתלמים אצלנו', mid: 'ברמת מחיר בינונית', premium: 'ברמת הפרימיום' };

function approved() {
  return Object.entries(profiles.resorts)
    .filter(([, p]) => p.approved && p.ratings)
    .map(([name, p]) => ({ name, ...p, km: (departures.transfer_km[name] || {}).km || null,
      airport: (departures.transfer_km[name] || {}).airport || null,
      rep: departures.reps[name] || null, camp: camps.resorts.includes(name) }));
}

/* ---------- what is being asked ---------- */
const AUDIENCE = [
  ['families', /משפח|ילד|קטנים|פעוט|הורים/],
  ['beginners', /מתחיל|פעם ה?ראשונה|לא גלש|ללמוד|לומד|קל(?:ים|ה)? יותר|נוח למתחיל|לימוד/],
  ['apres', /אפרה|חיי לילה|מסיב|לצאת בלילה|ברים|מועדונ|צעירים|רווק|חבר'?ה|חברה של|סטודנט|בני 2\d|לבלות/],
  ['experts', /מנוס|מתקדמ|מאתגר|שחורים|אוף.?פיסט|פאודר|מקצוע|תלול|הרבה קילומטר|שטח גדול|הכי גדול/],
  ['quiet', /שקט|רומנטי|ירח דבש|זוג מבוגר|פנסיונר|לנוח|רגוע/],
];
const ATTR = [
  ['glacier', /קרחון|בטוח שלג|ודאות שלג|שלג מובטח|הכי גבוה|גבוהים|יש שלג ב/],
  ['night', /סקי לילה|גלישת לילה|בלילה על המסלול/],
  ['park', /סנואו ?פארק|סנופארק/],
  ['skiinout', /סקי.?אין|ski.?in|קרוב למסלול|צמוד למסלול|בלי אוטובוס|ליד המעלית/i],
  ['big', /הכי הרבה מסלולים|הכי הרבה קילומטר|שטח הגלישה הכי|הכי גדול|הכי הרבה כחולים|הרבה מסלולים/],
  ['near', /הכי קרוב לשדה|קרוב לטיסה|הכי קרוב לטיסה|העברה הכי קצרה|הכי פחות נסיעה|הכי קרוב לשדה התעופה/],
  ['camp', /קייטנה בעברית|באיזה (אתר|יעד|מקום).{0,12}קייטנה|באילו.{0,12}קייטנה|איפה.{0,12}קייטנה|באיזו.{0,6}קייטנה/],
];
// A recommendation question names a PLACE to choose ("איזה אתר", "איפה הכי",
// "לאן כדאי"). A requirement ("חשוב לנו ספא"), a child's age or a policy
// question also mention audiences — those belong to the rest of the pipeline.
const ASK_WHICH = /איפה ה?[א-ת\-' ]{0,20}הכי|איזה (אתר|יעד|מקום|מדינה)|איזו מדינה|באיזה (אתר|יעד|מקום)|באיזו (מדינה|עיירה)|באילו|איפה (הכי|עדיף|כדאי|יש|מתאים)|לאן (כדאי|עדיף|ללכת|לנסוע|הכי)|מה (הכי|עדיף|מתאים|מומלץ) (אתר|יעד|ל)|תמליצ|המלצה על (אתר|יעד)|הכי (מתאים|טוב|שקט|מאתגר|גבוה|קרוב|גדול|תוסס) (אתר|יעד|ל|בשביל)|יש אתר (עם|ש)|יש (קרחון|סקי לילה|סנואו)/;
const COMPARE = /(^|\s)או(\s|$)|מה ההבדל|במה שונ|להשוות|השוואה|מול|לעומת|עדיף/;

function detect(text, slots) {
  const t = String(text || '');
  const names = (slots && slots.compare || []).filter(n => n.destination).map(n => n.destination);
  const countries = (slots && slots.compare || []).filter(n => n.country).map(n => n.country);
  const single = slots && slots.destination;
  const audience = AUDIENCE.filter(([, re]) => re.test(t)).map(([k]) => k);
  const attrs = ATTR.filter(([, re]) => re.test(t)).map(([k]) => k);
  // party context counts as audience when the question is "what suits us"
  const asksUs = /לנו|בשבילנו|מתאים לי|בשבילי|איתנו/.test(t);
  if (asksUs && slots && (slots.children_ages || []).length && !audience.includes('families')) audience.push('families');

  // hotel / price / policy talk is not "which resort" — the FAQ owns it
  if (/מלון|חדר|ספא|מחיר|כמה עולה|ביטוח|ביטול|כולל|כלול|טיסות/.test(t)) return null;
  if (names.length >= 2 && COMPARE.test(t)) return { kind: 'compare', names: names.slice(0, 3), audience };
  if (countries.length >= 2 && !names.length && COMPARE.test(t)) return { kind: 'countries', countries: countries.slice(0, 3), audience, attrs };
  if (names.length < 2 && single && (audience.length || attrs.length) && /מתאים|טוב ל|כדאי|שווה|בסדר ל/.test(t)) {
    return { kind: 'assess', name: single, audience, attrs };
  }
  if ((audience.length || attrs.length) && ASK_WHICH.test(t)) return { kind: 'which', audience, attrs };
  if (asksUs && audience.length && /איזה|איפה|לאן|מה מתאים|מה הכי/.test(t)) return { kind: 'which', audience, attrs };
  if (attrs.length && !audience.length && /^\s*(יש|איפה|באיזה|באילו|באיזו)\s/.test(t) && t.length < 60) return { kind: 'which', audience, attrs };
  // a bare follow-up: "החיי לילה?", "הכי מאתגר?", "סנואו פארק?", "לקבוצה בני 25?"
  const bareAud = audience.filter(a => a !== 'families' || /משפח/.test(t));
  if ((bareAud.length || attrs.length) && /\?\s*$/.test(t) && t.trim().length <= 28 && !/\d|ילד|בן |בת |תינוק|פעוט/.test(t)) return { kind: 'which', audience: bareAud, attrs };
  return null;
}

/* ---------- reasons from facts ---------- */
function reasons(p, audience, attrs) {
  const r = [];
  const a = new Set(audience), x = new Set(attrs);
  if (a.has('families') || a.has('beginners')) {
    if (p.beginner_near_village === true) r.push('אזור מתחילים ממש ליד הכפר');
    else if (typeof p.beginner_near_village === 'string') r.push(p.beginner_near_village);
    if (p.easy_pct != null && p.easy_pct >= 50) r.push(`כ-${p.easy_pct}% מהמסלולים קלים`);
  }
  if (a.has('families')) {
    if (p.camp) r.push('קייטנת סקי בעברית');
    if (p.ski_in_out === true) r.push('סקי-אין/סקי-אאוט — בלי אוטובוסים עם ילדים');
  }
  if (a.has('apres')) {
    if ((p.ratings.apres || 0) >= 5) r.push('אפרה-סקי מהחזקים באלפים');
    else if ((p.ratings.apres || 0) >= 4) r.push('עיירה תוססת עם ברים ומוזיקה');
    if (p.night_skiing === true) r.push('סקי לילה');
  }
  if (a.has('quiet')) {
    if ((p.ratings.apres || 5) <= 2) r.push('עיירה שקטה, ערבים רגועים');
    if (p.ski_in_out === true) r.push('סקי-אין/סקי-אאוט');
  }
  if (a.has('experts') || x.has('big')) {
    if (p.linked_km) r.push(`${p.linked_km} ק"מ מסלולים באזור ${p.linked_name ? p.linked_name : 'המקושר'}`);
    else if (p.piste_km) r.push(`${p.piste_km} ק"מ מסלולים`);
    if (p.hard_pct != null && p.hard_pct >= 15) r.push(`כ-${p.hard_pct}% מסלולים קשים`);
  }
  if (a.has('experts') || x.has('glacier')) {
    if (p.glacier === true) r.push('קרחון — שלג בטוח גם בתחילת העונה');
    if (p.top_m) r.push(`גלישה עד ${p.top_m} מ׳`);
  }
  if (x.has('night') && p.night_skiing === true) r.push('סקי לילה');
  if (x.has('park') && p.snow_park === true) r.push('סנואו-פארק');
  if (x.has('skiinout') && p.ski_in_out === true) r.push('סקי-אין/סקי-אאוט');
  if (x.has('near') && p.km) r.push(`${p.km} ק"מ משדה התעופה ב${p.airport}`);
  if (x.has('camp') && p.camp) r.push('קייטנת סקי בעברית');
  if (p.rep && p.rep.on_site) r.push('נציג פינגווין באתר');
  return [...new Set(r)];
}

function score(p, audience, attrs) {
  let s = 0;
  for (const a of audience) {
    if (a === 'quiet') s += 6 - (p.ratings.apres || 3);
    else s += p.ratings[a] || 0;
  }
  for (const x of attrs) {
    if (x === 'glacier' && p.glacier === true) s += 5;
    if (x === 'night' && p.night_skiing === true) s += 5;
    if (x === 'park' && p.snow_park === true) s += 3;
    if (x === 'skiinout' && p.ski_in_out === true) s += 5;
    if (x === 'big') s += Math.min(5, (p.linked_km || p.piste_km || 0) / 120);
    if (x === 'near' && p.km) s += Math.max(0, 5 - p.km / 60);
    if (x === 'camp' && p.camp) s += 5;
  }
  return s;
}

function qualifies(p, audience, attrs) {
  for (const a of audience) {
    if (a === 'quiet' ? (p.ratings.apres || 3) > 2 : (p.ratings[a] || 0) < 4) return false;
  }
  for (const x of attrs) {
    if (x === 'glacier' && p.glacier !== true) return false;
    if (x === 'night' && p.night_skiing !== true) return false;
    if (x === 'park' && p.snow_park !== true) return false;
    if (x === 'skiinout' && p.ski_in_out !== true) return false;
    if (x === 'camp' && !p.camp) return false;
  }
  return true;
}

const LABEL = { families: 'למשפחות עם ילדים', beginners: 'למתחילים', apres: 'למי שרוצה אפרה-סקי', experts: 'לגולשים מנוסים', quiet: 'למי שמחפש שקט',
  glacier: 'עם קרחון', night: 'עם סקי לילה', park: 'עם סנואו-פארק', skiinout: 'עם סקי-אין/סקי-אאוט', big: 'עם שטח גלישה גדול', near: 'קרוב לשדה התעופה', camp: 'עם קייטנה בעברית' };

function topicLabel(audience, attrs) {
  return [...audience.map(a => LABEL[a]), ...attrs.map(x => LABEL[x])].filter(Boolean).join(' ו');
}

function limitCountry(list, slots) {
  const c = slots && slots.country;
  return c ? list.filter(p => p.country === c) : list;
}

/* ---------- answers ---------- */
function which(intent, slots) {
  const all = limitCountry(approved().filter(p => p.recommend), slots);
  const fit = all.filter(p => qualifies(p, intent.audience, intent.attrs))
    .sort((a, b) => score(b, intent.audience, intent.attrs) - score(a, intent.audience, intent.attrs));
  const topic = topicLabel(intent.audience, intent.attrs);
  if (!fit.length) {
    return { he: `מתוך היעדים שלנו אין אתר שמתאים במיוחד ${topic} לפי הנתונים שאישרנו — נציג ישמח לדייק איתכם. מה עוד חשוב לכם?`, chips: [] };
  }
  const top = fit.slice(0, 3);
  const lines = top.map(p => {
    let why = reasons(p, intent.audience, intent.attrs).slice(0, 4);
    // facts alone can be thin ("נציג באתר") — the approved one-line profile fills in
    if (why.filter(w => !/נציג/.test(w)).length < 2 && p.reason_he) why = [...why.filter(w => !/נציג/.test(w)), p.reason_he];
    return `• ${p.he} (${COUNTRY_HE[p.country]}) — ${why.join(', ')}`;
  });
  const more = fit.length > 3 ? `\nיש גם ${fit.slice(3, 6).map(p => p.he).join(', ')}.` : '';
  const he = `${topic ? 'האתרים שלנו שמתאימים במיוחד ' + topic : 'האתרים שמתאימים'} — לפי הנתונים של כל אתר:\n${lines.join('\n')}${more}`;
  return { he, chips: top.map(p => p.he) };
}

function factLine(p) {
  const bits = [];
  if (p.village_m) bits.push(`כפר ב-${p.village_m} מ׳`);
  if (p.top_m) bits.push(`גלישה עד ${p.top_m} מ׳`);
  if (p.linked_km) bits.push(`${p.linked_km} ק"מ באזור המקושר`);
  else if (p.piste_km) bits.push(`${p.piste_km} ק"מ מסלולים`);
  if (p.easy_pct != null) bits.push(`כ-${p.easy_pct}% מסלולים קלים`);
  if (p.glacier === true) bits.push('קרחון');
  if (p.ski_in_out === true) bits.push('סקי-אין/סקי-אאוט');
  if (p.night_skiing === true) bits.push('סקי לילה');
  if (p.camp) bits.push('קייטנה בעברית');
  if (p.km) bits.push(`${p.km} ק"מ מ${p.airport}`);
  return bits.join(' · ');
}
function suits(p) {
  const r = p.ratings, s = [];
  if (r.families >= 4) s.push('משפחות');
  if (r.beginners >= 4) s.push('מתחילים');
  if (r.apres >= 4) s.push('חובבי אפרה-סקי');
  if (r.experts >= 4) s.push('גולשים מנוסים');
  if (r.apres <= 2) s.push('מי שמחפש שקט');
  return s.length ? s.join(', ') : 'רוב הגולשים';
}

function compare(intent, slots) {
  const byName = Object.fromEntries(approved().map(p => [p.name, p]));
  const ps = intent.names.map(n => byName[n]).filter(Boolean);
  if (ps.length < 2) return null;
  const lines = ps.map(p => `• ${p.he}: ${factLine(p)}. ${PRICE_HE[p.price_level] || ''}. מתאים במיוחד ל${suits(p)}.`);
  let pick = '';
  if (intent.audience.length) {
    const best = [...ps].sort((a, b) => score(b, intent.audience, []) - score(a, intent.audience, []))[0];
    const why = reasons(best, intent.audience, []).slice(0, 3);
    pick = `\n${LABEL[intent.audience[0]]} הייתי מכוון ל${best.he}${why.length ? ' — ' + why.join(', ') : ''}.`;
  }
  const he = `${ps.map(p => p.he).join(' מול ')}, לפי הנתונים של כל אתר:\n${lines.join('\n')}${pick}`;
  return { he, chips: ps.map(p => p.he) };
}

function countriesCompare(intent) {
  const all = approved().filter(p => p.recommend);
  const lines = intent.countries.map(c => {
    const ps = all.filter(p => p.country === c);
    if (!ps.length) return `• ${COUNTRY_HE[c]}: על היעדים שם נציג ישמח לספר.`;
    const top = ps.map(p => p.top_m || 0).reduce((a, b) => Math.max(a, b), 0);
    const km = ps.map(p => p.linked_km || p.piste_km || 0).reduce((a, b) => Math.max(a, b), 0);
    const tags = [];
    if (ps.some(p => p.glacier === true)) tags.push('קרחון');
    if (ps.some(p => p.camp)) tags.push('קייטנה בעברית');
    if (ps.some(p => p.ratings.apres >= 5)) tags.push('אפרה-סקי חזק');
    if (ps.some(p => p.ratings.families >= 5)) tags.push('כפרים שבנויים למשפחות');
    if (ps.every(p => p.price_level === 'budget')) tags.push('מהמשתלמים אצלנו');
    const who = [...new Set(ps.flatMap(p => suits(p).split(', ')))].filter(w => w !== 'רוב הגולשים').slice(0, 3).join(', ');
    const names = ps.length > 4 ? ps.slice(0, 4).map(p => p.he).join(', ') + ' ועוד' : ps.map(p => p.he).join(', ');
    return `• ${COUNTRY_HE[c]} (${names}): גלישה עד ${top} מ׳${km ? `, עד ${km} ק"מ מסלולים` : ''}${tags.length ? ' · ' + tags.join(' · ') : ''}. מתאים במיוחד ל${who || 'רוב הגולשים'}.`;
  });
  let pick = '';
  if (intent.audience.length) {
    const best = [...all].filter(p => intent.countries.includes(p.country)).sort((a, b) => score(b, intent.audience, intent.attrs) - score(a, intent.audience, intent.attrs))[0];
    if (best) pick = `\n${LABEL[intent.audience[0]]} הייתי מכוון ל${COUNTRY_HE[best.country]} — ${best.he}: ${reasons(best, intent.audience, intent.attrs).slice(0, 3).join(', ') || best.reason_he}.`;
  }
  return { he: `${intent.countries.map(c => COUNTRY_HE[c]).join(' מול ')}, לפי היעדים שאנחנו מוכרים:\n${lines.join('\n')}${pick}`, chips: intent.countries.map(c => COUNTRY_HE[c]) };
}

function assess(intent, slots) {
  const p = approved().find(x => x.name === intent.name);
  if (!p) return null;
  const ok = qualifies(p, intent.audience, intent.attrs);
  const why = reasons(p, intent.audience, intent.attrs).slice(0, 4);
  const topic = topicLabel(intent.audience, intent.attrs);
  if (ok) {
    return { he: `כן — ${p.he} מתאים ${topic}: ${why.length ? why.join(', ') : p.reason_he}. רוצים שאבדוק מה פנוי שם?`, chips: [p.he] };
  }
  const alt = which({ audience: intent.audience, attrs: intent.attrs }, {});
  const altNames = alt.chips.filter(n => n !== p.he).slice(0, 2);
  return { he: `${p.he} הוא לא הבחירה הראשונה שלנו ${topic} — ${p.reason_he}${altNames.length ? ` ${topic} הייתי מסתכל קודם על ${altNames.join(' או ')}.` : ''} רוצים שאראה מה פנוי?`, chips: altNames.length ? altNames : [p.he] };
}

function answer(text, slots) {
  const intent = detect(text, slots);
  if (!intent) return null;
  const out = intent.kind === 'compare' ? compare(intent, slots)
    : intent.kind === 'countries' ? countriesCompare(intent)
    : intent.kind === 'assess' ? assess(intent, slots)
      : which(intent, slots);
  return out ? { id: 'recommend', ...out, intent } : null;
}

module.exports = { detect, answer, approved, reasons, _profiles: profiles };
