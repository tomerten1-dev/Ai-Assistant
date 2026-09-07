#!/usr/bin/env node
'use strict';
/* בדיקת נכונות — האם הבוט עונה נכון, לא רק אם ענה.
   ==================================================
   tests/test-bank.js שואל את אותן 1,215 שאלות ומסווג התנהגות: ענה / שאל /
   סירב / הפנה. זה שימושי, אבל בוט יכול "להתנהג נכון" ולומר דבר שגוי — להציע
   מלון שאינו במלאי, לנקוב בתאריך שאין בו יציאה, להבטיח קייטנה בשבוע שאין בו
   קייטנה, או לענות תשובה מאושרת אחת על שאלה אחרת.
   הקובץ הזה בודק את התוכן מול הנתונים עצמם.
   
   העלות: אפס. שני המפתחות מנוטרלים, בדיוק כמו בריצת הבנק הרגילה, ולכן זו
   בדיקה של השכבה הדטרמיניסטית — זו שאחראית על העובדות ממילא. המודל אף פעם
   לא רואה מלאי, אז כל טענה עובדתית שיוצאת מכאן חייבת להיות נכונה או שבורה.

   הרצה:
     node tests/test-correctness.js                 כל הבנק
     node tests/test-correctness.js --typical       רק שאלות של לקוח רגיל
     node tests/test-correctness.js --cluster=camps
     node tests/test-correctness.js --grep=קייטנה
     node tests/test-correctness.js --sample=200    פרוסה דטרמיניסטית
     node tests/test-correctness.js --show          כל שגיאה מודפסת מיד

   פלט:
     מד התקדמות חי תוך כדי ריצה
     tests/correctness-report.md    דוח קריא בעברית — מה שגוי ולמה
     tests/correctness-results.json כל השורות, למי שרוצה לחפור

   קוד יציאה 1 אם יש ולו תקלה קריטית אחת (עובדה מומצאת). */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8801;
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));

const BANK = JSON.parse(fs.readFileSync(path.join(__dirname, 'question-bank.json'), 'utf8'));
const AVAIL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'availability.json'), 'utf8'));
const CAMPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'camps.json'), 'utf8'));

/* המפתחות מנוטרלים לפני שכל דבר אחר נטען, כדי שגם טעינה בתהליך הזה לא תוכל
   לפנות למודל. --live לא קיים כאן בכוונה: הבדיקה הזאת אמורה להיות חינם. */
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';
const offline = require('../server/offline-nlu.js');

/* ---------- אמת הקרקע ---------- */

const displayHotel = n => String(n || '').replace(/\s*\((allotment|Allotment)\)\s*/g, ' ').trim();

// כל יחידה פנויה, לפי מלון+תאריך+חדר — זה מה שכרטיס חייב להתאים לו
const UNITS = new Map();
for (const u of AVAIL.units) {
  UNITS.set([displayHotel(u.hotel), u.date, u.room].join('||'), u);
}
const HOTELS = new Set(AVAIL.units.map(u => displayHotel(u.hotel)));
const HOTEL_DATES = new Set(AVAIL.units.map(u => displayHotel(u.hotel) + '||' + u.date));
const DEPARTURES = new Set(AVAIL.units.map(u => u.date));
// "5.12" — הצורה שבה הבוט כותב תאריך (HE_DATE ב-server.js)
const DEP_SHORT = new Set([...DEPARTURES].map(d => `${+d.slice(8, 10)}.${+d.slice(5, 7)}`));
const SEASON_MONTHS = new Set([...DEPARTURES].map(d => +d.slice(5, 7)));

// שבועות שאין בהם קייטנה בכלל, ושבועות שיש בהם — לפי אתר, כדי לבדוק טענות
const CAMP_NO = new Set(CAMPS.weeks.filter(w => w.no_camp).map(w => w.week));
const CAMP_YES = new Set(CAMPS.weeks.filter(w => !w.no_camp).map(w => w.week));

/* אוצר המילים הלטיני המותר: כל מילה שמופיעה בשם מלון אמיתי, באתר, או בטקסט
   מאושר כלשהו. מילה לטינית שאיננה כאן היא מילה שהבוט המציא — וזה כמעט תמיד
   שם מלון. */
const LATIN_OK = new Set();
const trimWord = w => w.replace(/^[.'&-]+|[.'&-]+$/g, '');
const addLatin = text => {
  for (const w of String(text).match(/[A-Za-z][A-Za-z'&.-]*/g) || []) {
    const t = trimWord(w);
    if (t) LATIN_OK.add(t.toLowerCase());
  }
};
for (const u of AVAIL.units) addLatin([u.hotel, u.room, u.room_type, u.sheet].join(' '));
for (const f of ['catalogue.json', 'resorts.json', 'hotel-facts.json', 'restrictions.json', 'camps.json', 'pricing.json']) {
  try { addLatin(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch (e) { }
}
for (const f of fs.readdirSync(path.join(ROOT, 'config'))) {
  try { addLatin(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8')); } catch (e) { }
}
/* רצפי ספרות שמופיעים בטקסט מאושר — מספרי הטלפון של פינגווין, קודי מסלולים
   וכיוצא באלה. בלעדיהם המבחן של "6 ספרות = מספר הזמנה" נופל על 04-8557722. */
const DIGITS_OK = new Set();
const addDigits = text => {
  for (const n of String(text).match(/\d{4,}/g) || []) DIGITS_OK.add(n);
};
for (const f of fs.readdirSync(path.join(ROOT, 'config'))) {
  try { addDigits(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8')); } catch (e) { }
}
for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
  if (!f.endsWith('.json')) continue;
  try { addDigits(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8')); } catch (e) { }
}
try { addDigits(fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8')); } catch (e) { }
try { addDigits(fs.readFileSync(path.join(ROOT, 'server', 'offline-nlu.js'), 'utf8')); } catch (e) { }

// מילים לטיניות שמותר לבוט לכתוב מעצמו
for (const w of ['whatsapp', 'wifi', 'wi', 'fi', 'sms', 'email', 'ok', 'co', 'il', 'www', 'https', 'http', 'pingwin', 'info', 'a', 'b', 'c', 'x', 'i', 'e', 'g']) LATIN_OK.add(w);

/* ---------- כללים אדומים ---------- */

// המלכודת שנשכה את הפרויקט ארבע פעמים: \b לא עובד אחרי אות עברית ב-JS,
// כי עברית איננה \w. הגבול העברי נכתב במפורש: (?![א-ת])
const CURRENCY = 'אירו|יורו|שקל|שקלים|דולר|eur|usd|ils';
const MONEY = new RegExp('[€$₪]' +
  '|\\d[\\d,.]*\\s*(?:' + CURRENCY + ')(?![א-ת])' +
  '|(?:' + CURRENCY + ')\\s*\\d' +
  '|מחיר\\S*\\s+\\S*\\d', 'i');
const JOURNEY = /\d+(?:[.,]\d+)?\s*(?:שעות|שעה|דקות)(?![א-ת])\s*(?:נסיעה|העברה|מהשדה|משדה|דרך|טיסה)|נסיעה\s*(?:של\s*)?(?:כ-?\s*)?\d/;
const LONG_NUM = /\d{6,}/;

// טקסט שנקטע באמצע — אותם שני מבחנים שנוספו ל-prompt-phrase.validate
const DANGLING = /\s(את|של|עם|על|כדי|אבל|וגם|או|כי|אם|לפי|בין|מול|לכל|לפני|אחרי|יותר|פחות)[.…]?\s*$/;
const ENDS_OK = /[.!?:…)\]"'׳״]\s*$/;

const DEAD_END = /לא בטוח שהבנתי|אני כאן בעיקר להתאמת חופשות סקי/;
const OFF_TOPIC_LINE = /אני כאן בעיקר להתאמת חופשות סקי/;
/* מילים שאם הן בשאלה, השאלה היא על החופשה — ולומר עליה "אני כאן בעיקר
   להתאמת חופשות סקי" זה לסלק לקוח ששאל שאלה לגיטימית. הרשימה הזאת רחבה
   בהרבה מזו שב-server.js, וזה בדיוק העניין: הפער ביניהן הוא הבאג. */
const DOMAIN_WIDE = /הנחה|מדריך|מעלי|רכבל|העבר|טיסה|טיסות|שדה|עגל|תינוק|גובה|כרטיס|בית ספר|ציוד|מגלש|מקל|קסד|מזווד|כבוד|ביטוח|ארוח|אוכל|כשר|בריכ|ספא|סאונה|חני|מקרר|מטבח|מכונת|כביס|מגבת|וויפי|אינטרנט|חשמל|שקע|בייבי|שמרטף|מטפל|קייטנ|מועדון|הורה|משפח|ילד|נער|תינוק|קבוצ|חבר|יחד|צמוד|סמוך|שלג|מסלול|ירוק|כחול|אדום|שחור|פארק|סנובורד|מתחיל|מתקדם|שיעור|לימוד|אתר|כפר|עיירה|מרכז|לילה|לילות|חדר|סוויט|מיטה|ספה|נוף|מרפסת|תשלום|ביטול|שינוי|דרכון|ויזה|חיסון|רפוא|מרפא|בטיח|חילוץ|פינוי/;
const INFORMATIONAL = /^\s*(מה|כמה|יש|אפשר|האם|איך|מתי|למה|איפה|איזה|איזו|באיזה|מאיזה|צריך|חייב|אתם|תבטיחו|קיבלתי|שווה|עד )|\?\s*$/;
const REFUSAL_OK = new Set(['adversarial', 'promises']);

// ניגודים: אותו נושא, שתי תשובות הפוכות באותה תשובה
const CONTRADICT = [
  ['קייטנה', /(?:יש|פועלת|נפתחה|מתקיימת)\s*(?:לנו\s*)?קייטנ/, /אין\s*(?:לנו\s*)?קייטנ|קייטנה\s*לא\s*(?:פועלת|מתקיימת)/],
  ['סקי פס', /סקי פס\s*כלול|כולל סקי פס/, /סקי פס\s*(?:אינו|לא)\s*כלול/],
  ['ארוחות', /ארוחות\s*כלולות|כולל ארוחות/, /ארוחות\s*(?:אינן|לא)\s*כלולות/],
];

/* ---------- הבדיקות ---------- */
// כל בדיקה מחזירה תקלה אחת או יותר. severity: 'critical' = עובדה מומצאת
// שיוצאת ללקוח; 'high' = הלקוח לא קיבל תשובה או קיבל תשובה לשאלה אחרת;
// 'medium' = הניסוח פגום.
const CHECKS = {
  hotel_invented:   { sev: 'critical', he: 'שם מלון שאינו קיים במלאי' },
  hotel_not_offered:{ sev: 'high',     he: 'הזכיר מלון אמיתי שלא הוצע ולא נשאל עליו' },
  date_invented:    { sev: 'critical', he: 'תאריך שאין בו יציאה' },
  card_not_in_stock:{ sev: 'critical', he: 'כרטיס הצעה שאין לו יחידה פנויה בקובץ ההתחייבויות' },
  camp_wrong:       { sev: 'critical', he: 'טענה על קייטנה שאינה תואמת את camps.json' },
  money:            { sev: 'critical', he: 'סכום כסף בטקסט שאינו תשובה מאושרת' },
  journey_time:     { sev: 'critical', he: 'זמן נסיעה — נתון שאין לנו' },
  long_number:      { sev: 'critical', he: 'רצף של 6 ספרות ומעלה (מספר הזמנה?)' },
  wrong_topic:      { sev: 'high',     he: 'ענה תשובה מאושרת אחרת מזו שהשאלה מבקשת' },
  no_answer:        { sev: 'high',     he: 'יש לנו תשובה מאושרת לשאלה והבוט לא נתן אותה' },
  dead_end:         { sev: 'high',     he: 'סתם "לא הבנתי" על שאלה שאנחנו יודעים לענות עליה' },
  truncated:        { sev: 'medium',   he: 'המשפט נקטע באמצע' },
  repeat:           { sev: 'medium',   he: 'אותה פסקה פעמיים באותה תשובה' },
  contradiction:    { sev: 'high',     he: 'סתירה פנימית בתוך אותה תשובה' },
  empty:            { sev: 'high',     he: 'תשובה ריקה' },
  // לא באג בקוד — חוסר תוכן. נספר בנפרד מ"שגוי", כי התיקון שונה לגמרי:
  // להוסיף ערך ל-config/faq.json, לא לגעת בקוד.
  off_topic_wrongly:{ sev: 'high',     he: 'אמר "אני כאן בעיקר להתאמת חופשות סקי" על שאלה שהיא כן על החופשה' },
  ignored:          { sev: 'content',  he: 'ענה בשאלה במקום לענות על השאלה' },
  no_content:       { sev: 'content',  he: 'אין תשובה מאושרת לשאלה הזאת בכלל' },
};
const CONTENT = new Set(['ignored', 'no_content']);
// מסלולים שכולם מחזירים טקסט מאושר. תשובה שהגיעה דרך אחד מהם היא תשובה,
// גם אם היא לא הערך מ-faq.json שהמנוע הדטרמיניסטי היה בוחר.
const APPROVED_ROUTES = ['faq', 'router', 'deflect', 'guard', 'dates', 'cards', 'lead', 'lang', 'recommend'];

const lines0 = t => String(t).split('\n').map(l => l.trim()).filter(Boolean);

function checkOne(entry, res) {
  const faults = [];
  const add = (code, detail) => faults.push({ code, detail });
  const reply = String(res.reply_he || '');
  const d = res.debug || {};
  const cards = res.cards || [];
  const approved = APPROVED_ROUTES.includes(d.answered_by);

  if (!reply.trim()) { add('empty', ''); return faults; }

  /* --- 1. מלונות --- */
  // מילה לטינית שלא מופיעה בשום מקום בנתונים או בטקסט המאושר
  // הנקודה בסוף משפט איננה חלק מהמילה: בלי הקיצוץ הזה
  // "Falkensteiner Club Funimation." נספר כמלון מומצא, והוא קיים בקטלוג.
  const latin = [...new Set((reply.match(/[A-Za-z][A-Za-z'&.-]*/g) || [])
    .map(trimWord)
    .filter(w => w.length > 1))]
    .filter(w => !LATIN_OK.has(w.toLowerCase()));
  if (latin.length) add('hotel_invented', latin.join(', '));

  // מלון אמיתי שהוזכר בשם, לא הוצע בכרטיסים, והלקוח לא שאל עליו.
  // חריג: תשובות מבוססות-נתונים (דירוגים, מתקנים) מונות מלונות בכוונה —
  // "יש בריכה מחוממת ב: X, Y" — ואלה עובדות מהדפים, לא הצעה.
  const dataAnswer = /לפי דפי המלונות באתר פינגווין|מדף המלון באתר פינגווין|לפי הנתונים שבאתר פינגווין/.test(reply);
  const offered = new Set(cards.map(c => c.hotel));
  for (const h of HOTELS) {
    if (dataAnswer) break;
    if (h.length < 6) continue;
    if (!reply.includes(h)) continue;
    if (offered.has(h)) continue;
    if (entry.q.includes(h)) continue;
    add('hotel_not_offered', h);
  }

  /* --- 2. תאריכים --- */
  for (const m of reply.matchAll(/(?<![\d.,])(\d{1,2})\.(\d{1,2})(?![\d.,])/g)) {
    const day = +m[1], mon = +m[2];
    if (day < 1 || day > 31 || !SEASON_MONTHS.has(mon)) continue;   // לא נראה כמו תאריך יציאה
    if (!DEP_SHORT.has(`${day}.${mon}`)) add('date_invented', m[0]);
  }

  /* --- 3. כרטיסים מול המלאי --- */
  for (const c of cards) {
    const key = [c.hotel, c.date, c.room].join('||');
    const unit = UNITS.get(key);
    if (!unit) {
      // אולי החדר הוצג בשם אחר — לפחות מלון+תאריך חייבים להתקיים
      if (!HOTEL_DATES.has(c.hotel + '||' + c.date)) add('card_not_in_stock', `${c.hotel} ${c.date} ${c.room}`);
      else add('card_not_in_stock', `חדר לא מזוהה: ${c.hotel} ${c.date} — "${c.room}"`);
      continue;
    }
    if (c.nights != null && unit.nights != null && c.nights !== unit.nights) {
      add('card_not_in_stock', `${c.hotel} ${c.date}: ${c.nights} לילות בכרטיס מול ${unit.nights} בקובץ`);
    }
    if (c.occ != null && unit.occ_max != null && c.occ > unit.occ_max) {
      add('card_not_in_stock', `${c.hotel} ${c.date}: תפוסה ${c.occ} מעל ${unit.occ_max}`);
    }
  }

  /* --- 4. קייטנה --- */
  // טענה חיובית על קייטנה בשבוע ספציפי שמופיע בתשובה
  if (/קייטנ/.test(reply)) {
    for (const m of reply.matchAll(/(?<![\d.,])(\d{1,2})\.(\d{1,2})(?![\d.,])/g)) {
      const iso = [...DEPARTURES].find(dt => +dt.slice(8, 10) === +m[1] && +dt.slice(5, 7) === +m[2]);
      if (!iso) continue;
      const positive = /(?:יש|פועלת|נפתחה|מתקיימת|זמינה)\s*(?:לנו\s*)?קייטנ|קייטנ\S*\s*(?:פועלת|קיימת|זמינה)/.test(reply);
      if (positive && CAMP_NO.has(iso)) add('camp_wrong', `הבטיח קייטנה ב-${m[0]} — camps.json אומר no_camp`);
    }
    // הבטחה גורפת ללא נתונים
    if (/קייטנ\S*\s*(?:פועלת|יש)\s*(?:בכל|בכל השבועות|תמיד)/.test(reply)) {
      add('camp_wrong', 'הבטיח קייטנה בכל השבועות — יש שבועות ללא קייטנה');
    }
  }

  /* --- 5. כללים אדומים --- */
  if (!approved) {
    if (MONEY.test(reply)) add('money', (reply.match(MONEY) || [''])[0]);
    if (JOURNEY.test(reply)) add('journey_time', (reply.match(JOURNEY) || [''])[0]);
  }
  for (const n of reply.match(LONG_NUM) || []) {
    if (DIGITS_OK.has(n)) continue;                 // מספר שמופיע בטקסט מאושר
    add('long_number', n);
  }

  /* --- 6. האם זו התשובה הנכונה לשאלה הזאת --- */
  // אם המנוע הדטרמיניסטי יודע איזו תשובה מאושרת מתאימה לשאלה, היא חייבת
  // להופיע. אם הופיעה אחרת — הבוט ענה על שאלה אחרת.
  let expectedFaq = null;
  try { expectedFaq = offline.faqMulti(entry.q); } catch (e) { }
  const refusalFine = REFUSAL_OK.has(entry.cluster) && (d.guard || d.answered_by === 'deflect' || d.answered_by === 'guard');
  if (expectedFaq && !refusalFine) {
    const wantIds = (expectedFaq.all || [expectedFaq]).map(a => a.id);
    const gotIds = d.faq_ids || [];
    const wantText = (expectedFaq.all || [expectedFaq])
      .map(a => String(a.he || '').split('\n')[0].slice(0, 40));
    const said = wantText.some(t => t && reply.includes(t));
    /* התשובה המאושרת לא נאמרה מילה במילה — אבל ייתכן שהבוט ענה על אותו נושא
       בדרך אחרת (recommend, כרטיסים, שורת תאריכים). "גלישת לילה באיזה ימים?"
       נענתה ברשימת אתרים עם סקי לילה: זו לא תשובה לשאלה אחרת. לכן הנושא נחשב
       מכוסה אם אחת ממילות התוכן של הביטוי שהלקוח כתב חוזרת בתשובה. */
    const topicWords = String(expectedFaq.matched || '')
      .split(/[^א-תA-Za-z]+/).filter(w => w.length >= 3);
    const onTopic = topicWords.length && topicWords.some(w => reply.includes(w));
    if (!said && !onTopic) {
      // recommend רשאי להחליף את ההרצאות הגנריות — זה מתוכנן (server.js,
      // RECOMMEND_MAY_REPLACE), ולכן אינו טעות.
      const genericOverride = gotIds.includes('recommend') &&
        wantIds.some(id => ['compare', 'compare_countries'].includes(id));
      if (gotIds.length && !gotIds.some(id => wantIds.includes(id)) && !genericOverride) {
        add('wrong_topic', `ציפינו ל-${wantIds.join('+')} וקיבלנו ${gotIds.join('+')}`);
      } else if (DEAD_END.test(reply) && reply.split('\n').filter(l => l.trim()).every(l => DEAD_END.test(l))) {
        add('dead_end', `יש תשובה מאושרת: ${wantIds.join('+')}`);
      } else if (!cards.length && !approved) {
        add('no_answer', `יש תשובה מאושרת: ${wantIds.join('+')}`);
      }
    }
  } else if (!expectedFaq && INFORMATIONAL.test(entry.q) && !cards.length &&
             d.answered_by !== 'lang') {
    // 'lang' עונה בשפת הלקוח או מזמין לכתוב בעברית — זו תשובה, לא התעלמות.
    // שאלת מידע, אין תשובה מאושרת, ואין הצעה על המסך.
    const onlyAsk = lines0(reply).every(l => /\?\s*$/.test(l) || DEAD_END.test(l));
    // באשכולות המלכודת (הבטחות, פרובוקציות) "אני כאן בעיקר להתאמת חופשות
    // סקי" היא התשובה הנכונה, לא באג.
    if (OFF_TOPIC_LINE.test(reply) && DOMAIN_WIDE.test(entry.q) && !REFUSAL_OK.has(entry.cluster)) {
      add('off_topic_wrongly', (entry.q.match(DOMAIN_WIDE) || [''])[0]);
    } else if (DEAD_END.test(reply)) add('no_content', '');
    else if (onlyAsk) add('ignored', '');
  }

  /* --- 7. איכות הטקסט --- */
  const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
  const seen = new Set();
  for (const l of lines) {
    if (l.length < 25) continue;
    if (seen.has(l)) { add('repeat', l.slice(0, 60) + '…'); break; }
    seen.add(l);
  }
  const last = lines[lines.length - 1] || '';
  if (last.length > 80 && !ENDS_OK.test(last) && !/[?]$/.test(last)) add('truncated', '…' + last.slice(-50));
  else if (DANGLING.test(last)) add('truncated', '…' + last.slice(-40));

  for (const [topic, yes, no] of CONTRADICT) {
    if (yes.test(reply) && no.test(reply)) add('contradiction', topic);
  }

  return faults;
}

/* ---------- מבחן עצמי ----------
   בודק שהבודקים עצמם עובדים. אפס תקלות קריטיות שווה משהו רק אם אפשר להראות
   שהבדיקה כן נדלקת כשמזינים לה תשובה פגומה. node tests/test-correctness.js
   --selftest מריץ תשובות מזויפות דרך אותה checkOne ומוודא שכל בדיקה תופסת. */
function selftest() {
  const anyDate = [...DEPARTURES][0];
  const anyUnit = AVAIL.units[0];
  // תאריך בתוך העונה שאין בו יציאה
  let fakeDate = null;
  for (let d = 1; d <= 28 && !fakeDate; d++) {
    for (const m of SEASON_MONTHS) if (!DEP_SHORT.has(`${d}.${m}`)) { fakeDate = `${d}.${m}`; break; }
  }
  // שבוע שאין בו קייטנה ושהוא גם תאריך יציאה
  const noCampDep = [...CAMP_NO].find(w => DEPARTURES.has(w));
  const noCampShort = noCampDep ? `${+noCampDep.slice(8, 10)}.${+noCampDep.slice(5, 7)}` : null;

  const R = (reply, extra = {}) => ({ reply_he: reply, debug: { answered_by: null, faq_ids: [] }, cards: [], ...extra });
  const Q = (q, cluster = 'core') => ({ q, cluster, section: '' });

  const cases = [
    ['hotel_invented', Q('איזה מלון?'), R('אנחנו עובדים עם Grand Alpenblick Royal Palace ביעד הזה.')],
    fakeDate && ['date_invented', Q('מתי יש יציאות?'), R(`היציאה הקרובה היא ב-${fakeDate} וזה מה שיש.`)],
    ['money', Q('כמה זה עולה?'), R('המחיר הוא 1200 אירו לאדם כולל הכל.')],
    ['journey_time', Q('כמה זמן מהשדה?'), R('ההעברה משדה התעופה היא 2 שעות נסיעה בערך.')],
    ['long_number', Q('מה מספר ההזמנה?'), R('מספר ההזמנה שלכם הוא 4471903 והוא מאושר.')],
    ['card_not_in_stock', Q('יש חדר?'), R('הנה מה שמצאתי.', { cards: [{ hotel: 'Nonexistent Palace', date: anyDate, room: 'Suite', nights: 7, occ: 4 }] })],
    ['card_not_in_stock', Q('יש חדר?'), R('הנה מה שמצאתי.', { cards: [{ hotel: displayHotel(anyUnit.hotel), date: anyUnit.date, room: anyUnit.room, nights: (anyUnit.nights || 7) + 3, occ: anyUnit.occ_max }] })],
    noCampShort && ['camp_wrong', Q('יש קייטנה?'), R(`ביציאה של ${noCampShort} יש קייטנה בעברית לילדים.`)],
    ['repeat', Q('מה כלול?'), R('בכל החבילות כלולות טיסות הלוך ושוב והסעות מהשדה.\nבכל החבילות כלולות טיסות הלוך ושוב והסעות מהשדה.')],
    ['truncated', Q('מה כלול?'), R('החבילה כוללת טיסה ישירה מתל אביב, העברות מהשדה למלון ובחזרה, לינה בחדר שנבחר, וכן את')],
    ['contradiction', Q('יש קייטנה?'), R('יש קייטנה בעברית ביעד הזה.\nאין קייטנה בשבוע שביקשתם.')],
    ['empty', Q('מה שלומך?'), R('')],
    ['off_topic_wrongly', Q('יש חנות מזכרות ליד הרכבל?'), R('אני כאן בעיקר להתאמת חופשות סקי של פינגווין.')],
    ['no_content', Q('מה גובה התקרה בחדר?'), R('לא בטוח שהבנתי למה הכוונה — אפשר לנסח מחדש?')],
    ['ignored', Q('מה גובה התקרה בחדר?'), R('כמה תהיו בסך הכל?')],
    ['hotel_not_offered', Q('מה יש בצרפת?'), R(`מומלץ מאוד ${[...HOTELS].find(h => h.length >= 10)} ביעד הזה.`)],
    ['wrong_topic', Q('אפשר לבטל את ההזמנה?'), R('בכל החבילות כלולות טיסות הלוך ושוב והסעות מהשדה.',
      { debug: { answered_by: 'faq', faq_ids: ['whats_included'] } })],
  ].filter(Boolean);

  console.log('\nמבחן עצמי — כל בדיקה מקבלת תשובה פגומה ואמורה להידלק:\n');
  let bad = 0;
  for (const [code, entry, res] of cases) {
    const got = checkOne(entry, res).map(f => f.code);
    const ok = got.includes(code);
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${String(code).padEnd(20)} ${ok ? 'נדלקה' : 'לא נדלקה! קיבלנו: ' + (got.join(', ') || 'כלום')}`);
  }
  // ביקורת נגדית: תשובה תקינה לא אמורה להדליק כלום
  const clean = checkOne(Q('מה כלול במחיר?'), {
    reply_he: 'בכל החבילות כלולות טיסות הלוך ושוב והסעות משדה התעופה למלון ובחזרה.',
    debug: { answered_by: 'faq', faq_ids: ['whats_included'] }, cards: [],
  }).filter(f => !CONTENT.has(f.code));
  console.log(`  ${clean.length ? '✗' : '✓'} ${'תשובה תקינה'.padEnd(20)} ${clean.length ? 'נדלקה בטעות: ' + clean.map(f => f.code).join(', ') : 'שקטה'}`);
  if (clean.length) bad++;
  console.log(`\n${bad ? bad + ' בדיקות לא עובדות' : 'כל הבדיקות עובדות'}\n`);
  process.exit(bad ? 1 : 0);
}
if (args.selftest) selftest();

/* ---------- מד ההתקדמות ---------- */
const TTY = process.stdout.isTTY && !args.show;
const clock = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s) % 60).padStart(2, '0')}`;

function makeMeter(total) {
  let drawn = 0;
  const WIDTH = 34;
  return {
    draw(n, startedAt, current) {
      const { done, right, wrong, gap, crit } = n;
      const secs = (Date.now() - startedAt) / 1000;
      const rate = done / Math.max(secs, 0.001);
      const left = (total - done) / Math.max(rate, 0.001);
      const pct = done / total;
      const filled = Math.round(pct * WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(WIDTH - filled);
      const q = current.length > 46 ? current.slice(0, 45) + '…' : current;
      const block = [
        `  [${bar}] ${String(Math.round(pct * 100)).padStart(3)}%   ${done}/${total}`,
        `  ✓ ${String(right).padStart(4)} נכון    ✗ ${String(wrong).padStart(4)} שגוי    ` +
        `? ${String(gap).padStart(4)} לא ענה    ${crit ? '⚠ ' + crit + ' קריטי' : ''}`,
        `  ⏱ ${clock(secs)} עברו · ~${clock(left)} נותרו · ${rate.toFixed(1)} שאלות/שנייה`,
        `  › ${q}`,
      ];
      if (TTY) {
        if (drawn) process.stdout.write(`\x1b[${drawn}A`);
        for (const line of block) process.stdout.write('\x1b[2K' + line + '\n');
        drawn = block.length;
      } else if (done === 1 || done % 100 === 0 || done === total) {
        process.stdout.write(`  ${String(done).padStart(4)}/${total}  ` +
          `✓${right} ✗${wrong} ?${gap}${crit ? ` ⚠${crit}` : ''}  ~${clock(left)} נותרו\n`);
      }
    },
  };
}

/* ---------- הרצה ---------- */
async function ask(q) {
  const r = await fetch(`http://localhost:${PORT}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'assistant', content: 'שלום, ספרו לנו כמה נוסעים, גילאי ילדים אם יש, ומתי תרצו לצאת.' },
        { role: 'user', content: q }],
      slots: {},
    }),
  });
  return r.json();
}

const ROWS = [];
let TOTAL = 0, STOPPED = false;

(async () => {
  let list = BANK;
  if (args.cluster) list = list.filter(e => e.cluster === args.cluster);
  if (args.grep) list = list.filter(e => e.q.includes(args.grep));
  if (args.typical) {
    const NOT = new Set(['adversarial', 'promises', 'b2b_offtopic', 'format_emotional']);
    list = list.filter(e => !NOT.has(e.cluster));
  }
  if (args.sample) {
    const n = Math.max(1, Math.min(list.length, parseInt(args.sample, 10) || 100));
    const step = list.length / n;
    list = Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
  }
  TOTAL = list.length;

  console.log(`\nפינגי — בדיקת נכונות`);
  console.log(`${list.length} שאלות · ${AVAIL.units.length} יחידות במלאי · ${CAMPS.weeks.length} שבועות קייטנה`);
  console.log(`ללא עלות: שני מפתחות ה-API מנוטרלים, אין קריאה לשום מודל.\n`);

  const server = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), BANK_DEBUG: '1', CHAT_LOG: 'off',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
      RATE_CHAT_PER_MIN: '1000000', RATE_CHAT_PER_HOUR: '1000000', MAX_TURNS_PER_CHAT: '100000',
    },
    // stderr נלכד ולא מודפס: הודעות השרת (אזהרת ה-.env, ניסיונות roomList
    // שנופלים בלי רשת) שוברות את מד ההתקדמות. הן נכתבות לקובץ.
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', d => { serverErr += d; });
  const bye = () => {
    try { server.kill(); } catch (e) { }
    if (serverErr) { try { fs.writeFileSync(path.join(__dirname, 'correctness-server.log'), serverErr); } catch (e) { } }
  };
  process.on('exit', bye);
  await new Promise(r => setTimeout(r, 1200));
  try { await fetch(`http://localhost:${PORT}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}' }); }
  catch (e) {
    console.error('השרת לא עלה על פורט ' + PORT + ':\n' + serverErr.slice(-1500));
    process.exit(1);
  }

  const meter = makeMeter(list.length);
  const startedAt = Date.now();
  const n = { done: 0, right: 0, wrong: 0, gap: 0, crit: 0 };

  process.on('SIGINT', () => {
    if (STOPPED) process.exit(130);
    STOPPED = true;
    console.log('\n\nעוצר — מסכם את מה שנמדד עד כה…');
    bye(); report(true);
  });

  for (const e of list) {
    let res;
    try { res = await ask(e.q); } catch (err) { res = { reply_he: '', debug: {}, error: String(err) }; }
    const faults = checkOne(e, res);
    const real = faults.filter(f => !CONTENT.has(f.code));
    const gap = faults.some(f => CONTENT.has(f.code));
    const critical = real.filter(f => CHECKS[f.code].sev === 'critical');
    n.done++;
    if (real.length) { n.wrong++; if (critical.length) n.crit++; }
    else if (gap) n.gap++;
    else n.right++;
    ROWS.push({
      q: e.q, cluster: e.cluster, section: e.section,
      answered_by: (res.debug || {}).answered_by || null,
      faq_ids: (res.debug || {}).faq_ids || [],
      cards: (res.cards || []).length,
      verdict: real.length ? 'wrong' : gap ? 'unanswered' : 'correct',
      correct: !real.length && !gap,
      faults: faults.map(f => ({ ...f, sev: CHECKS[f.code].sev, he: CHECKS[f.code].he })),
      reply: String(res.reply_he || '').slice(0, 400),
    });
    meter.draw(n, startedAt, e.q);
    if (args.show && real.length) {
      console.log(`\n✗ [${e.cluster}] ${e.q}`);
      for (const f of real) console.log(`    ${CHECKS[f.code].sev.toUpperCase()} ${f.code}: ${CHECKS[f.code].he}${f.detail ? ' — ' + f.detail : ''}`);
      console.log('    ' + String(res.reply_he || '').replace(/\n/g, ' | ').slice(0, 200));
    }
  }
  bye();
  report(false);
})();

/* ---------- הדוח ---------- */
function report(partial) {
  if (!ROWS.length) { console.log('\nלא נמדד דבר'); process.exit(1); }
  const rows = ROWS;
  const correct = rows.filter(r => r.verdict === 'correct').length;
  const wrong = rows.filter(r => r.verdict === 'wrong').length;
  const gap = rows.filter(r => r.verdict === 'unanswered').length;

  // לפי סוג תקלה
  const byCode = new Map();
  for (const r of rows) for (const f of r.faults) {
    if (!byCode.has(f.code)) byCode.set(f.code, new Set());
    byCode.get(f.code).add(r);
  }
  const order = ['critical', 'high', 'medium', 'content'];
  const codes = [...byCode.keys()].sort((a, b) =>
    order.indexOf(CHECKS[a].sev) - order.indexOf(CHECKS[b].sev) ||
    byCode.get(b).size - byCode.get(a).size);
  const bugCodes = codes.filter(c => !CONTENT.has(c));
  const gapCodes = codes.filter(c => CONTENT.has(c));

  // לפי אשכול
  const byCluster = new Map();
  for (const r of rows) {
    const b = byCluster.get(r.cluster) || { n: 0, ok: 0, wrong: 0, gap: 0 };
    b.n++; b[r.verdict === 'correct' ? 'ok' : r.verdict === 'wrong' ? 'wrong' : 'gap']++;
    byCluster.set(r.cluster, b);
  }

  const pad = (s, n) => String(s).padEnd(n);
  const padS = (s, n) => String(s).padStart(n);
  const pc = x => (100 * x / rows.length).toFixed(1) + '%';
  console.log('\n' + '─'.repeat(74));
  console.log(`  ✓ נכון      ${padS(correct, 5)}   ${pc(correct)}`);
  console.log(`  ✗ שגוי      ${padS(wrong, 5)}   ${pc(wrong)}   — הבוט אמר משהו לא נכון או שבור`);
  console.log(`  ? לא ענה    ${padS(gap, 5)}   ${pc(gap)}   — אין תוכן מאושר לשאלה`);
  console.log('─'.repeat(74));
  if (partial) console.log(`⚠ ריצה חלקית — נעצרה אחרי ${rows.length} מתוך ${TOTAL}`);

  let criticalTotal = 0;
  for (const c of bugCodes) if (CHECKS[c].sev === 'critical') criticalTotal += byCode.get(c).size;

  console.log('\nתקלות (מה לתקן בקוד):\n');
  if (!bugCodes.length) console.log('  אין.');
  for (const c of bugCodes) {
    console.log('  ' + pad(CHECKS[c].sev, 10) + padS(byCode.get(c).size, 5) + '   ' + CHECKS[c].he + `  (${c})`);
  }

  if (gapCodes.length) {
    console.log('\nפערי תוכן (מה להוסיף ל-config/faq.json):\n');
    for (const c of gapCodes) {
      console.log('  ' + pad('content', 10) + padS(byCode.get(c).size, 5) + '   ' + CHECKS[c].he + `  (${c})`);
    }
  }

  console.log('\nלפי אשכול:\n');
  const clusters = [...byCluster.entries()].sort((a, b) => (a[1].ok / a[1].n) - (b[1].ok / b[1].n));
  for (const [c, b] of clusters) {
    const p = Math.round(100 * b.ok / b.n);
    const f = Math.round(p / 5);
    console.log('  ' + pad(c, 24) + '█'.repeat(f) + '░'.repeat(20 - f) + padS(p + '%', 6) +
      padS(`${b.ok}/${b.n}`, 10) + (b.wrong ? `  ✗${b.wrong}` : '') + (b.gap ? `  ?${b.gap}` : ''));
  }

  // ---- הקבצים ----
  fs.writeFileSync(path.join(__dirname, 'correctness-results.json'), JSON.stringify(rows, null, 1));

  const md = [];
  const sec = (title, list, c) => {
    md.push(`### ${title}`, '');
    md.push(`חומרה: **${CHECKS[c].sev}** · ${list.length} שאלות · קוד: \`${c}\``, '');
    md.push('| השאלה | מה לא בסדר | דרך התשובה |', '|---|---|---|');
    for (const r of list) {
      const f = r.faults.find(x => x.code === c);
      md.push(`| ${r.q.replace(/\|/g, '/')} | ${(f.detail || '—').replace(/\|/g, '/')} | ${r.answered_by || '—'}${r.faq_ids.length ? ' (' + r.faq_ids.join('+') + ')' : ''} |`);
    }
    md.push('');
    md.push('<details><summary>התשובות עצמן</summary>', '');
    for (const r of list.slice(0, 30)) {
      md.push(`**${r.q}**`, '');
      md.push('> ' + r.reply.replace(/\n/g, '\n> '), '');
    }
    if (list.length > 30) md.push(`_ועוד ${list.length - 30} — ב-tests/correctness-results.json_`, '');
    md.push('</details>', '');
  };

  md.push('# בדיקת נכונות — פינגי', '');
  md.push(`${rows.length} שאלות מבנק השאלות, כל אחת כהודעה ראשונה בשיחה חדשה.`, '');
  md.push('הריצה כולה **ללא מודל** — שני מפתחות ה-API מנוטרלים, ולכן היא חינם וחוזרת על עצמה בדיוק.');
  md.push('כל טענה עובדתית בתשובה הושוותה למקור: `data/availability.json` למלונות, לתאריכים ולחדרים,');
  md.push('`data/camps.json` לקייטנות, ו-`config/faq.json` לשאלה אם התשובה שניתנה היא התשובה לשאלה שנשאלה.', '');
  md.push('| | כמה | אחוז | מה זה אומר |');
  md.push('|---|---|---|---|');
  md.push(`| ✓ נכון | ${correct} | ${pc(correct)} | לא נמצאה בעיה |`);
  md.push(`| ✗ שגוי | ${wrong} | ${pc(wrong)} | הבוט אמר משהו לא נכון, לא שלם, או לא לעניין |`);
  md.push(`| ? לא ענה | ${gap} | ${pc(gap)} | אין תוכן מאושר — צריך להוסיף תשובה |`);
  md.push('');
  if (partial) md.push(`> ריצה חלקית: ${rows.length} מתוך ${TOTAL}.`, '');

  md.push('## מה לתקן בקוד', '');
  if (!bugCodes.length) md.push('אין תקלות.', '');
  else {
    md.push('| חומרה | שאלות | מה קרה |', '|---|---|---|');
    for (const c of bugCodes) md.push(`| ${CHECKS[c].sev} | ${byCode.get(c).size} | ${CHECKS[c].he} |`);
    md.push('');
    for (const c of bugCodes) sec(CHECKS[c].he, [...byCode.get(c)], c);
  }

  if (gapCodes.length) {
    md.push('## מה להוסיף לתוכן', '');
    md.push('אלה שאלות שהבוט לא ענה עליהן כי אין תשובה מאושרת ב-`config/faq.json`.');
    md.push('התיקון הוא ערך חדש בקובץ התשובות, לא שינוי בקוד.', '');
    for (const c of gapCodes) sec(CHECKS[c].he, [...byCode.get(c)], c);
  }

  md.push('## לפי אשכול', '');
  md.push('| אשכול | נכון | שגוי | לא ענה | סה"כ |', '|---|---|---|---|---|');
  for (const [c, b] of clusters) md.push(`| ${c} | ${b.ok} | ${b.wrong} | ${b.gap} | ${b.n} |`);
  md.push('');

  fs.writeFileSync(path.join(__dirname, 'correctness-report.md'), md.join('\n'));

  console.log('\nנכתבו:');
  console.log('  tests/correctness-report.md    ← הדוח לקריאה');
  console.log('  tests/correctness-results.json ← כל השורות');
  if (fs.existsSync(path.join(__dirname, 'correctness-server.log'))) {
    console.log('  tests/correctness-server.log   ← מה שהשרת כתב ל-stderr');
  }
  console.log(`\nתקלות קריטיות (עובדה מומצאת שיצאה ללקוח): ${criticalTotal}\n`);
  process.exit(criticalTotal ? 1 : 0);
}
