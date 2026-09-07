'use strict';
/* The reply editor — one written answer instead of a stack of lines.
   (Tomer, 06/09, after the Sunny session: "תעשה את 3.8 של הכתיבה".)

   What the deterministic layers produce is RIGHT and looks like a machine:
   the FAQ paragraph, then "רשמתי לפניי: …", then "לקחתי בחשבון: …", then the
   question, then a closing line. Sunny writes one paragraph for this
   customer. So does this: the model receives every line we were about to
   print, what is known about the customer, and the question the turn must
   end on — and writes the reply. It may reorder, merge, shorten and drop
   boilerplate. It may not add a fact.

   The guard is what makes that safe: validate() rejects any number, Latin
   word, hotel or resort name that is not in the material, any money sign,
   any "הכי", a dropped question, a dropped refusal, a dropped phone number,
   and any output whose content words mostly do not come from the material.
   A rejected edit ships the original lines — the customer never sees a
   guess, only, at worst, the seams. */

const COMPOSE_PROMPT = `אתה פינגי, הנציג הדיגיטלי של פינגווין — סוכנות חופשות סקי ישראלית. אתה עורך: מקבל את כל מה שהמערכת החליטה להגיד ללקוח בתור הזה, וכותב מזה הודעה אחת.

תקבל JSON עם:
- הודעת_הלקוח — מה הלקוח כתב עכשיו.
- ידוע_על_הלקוח — מה שכבר ידוע מהשיחה (הרכב, גילאים, חודש, יעד, הערות). יכול להיות ריק.
- ההודעה_הקודמת_שלך — מה כתבת בתור הקודם, כדי שלא תחזור על זה.
- חומר — השורות שהמערכת הכינה, בסדר שהוכנו. כל עובדה עסקית שמותר לך להגיד נמצאת שם, ורק שם.
- שאלה_לסיום — אם יש, ההודעה חייבת להסתיים בשאלה הזאת (מותר לנסח אותה מחדש בקצרה, אבל זו אותה שאלה, ואחת בלבד).

חוקים מוחלטים:
1. אל תוסיף שום עובדה שאינה ב"חומר": לא מלון, לא יעד, לא תאריך, לא שעה, לא מספר, לא מחיר, לא תנאי, לא שירות. אם ה"חומר" אומר "נציג יבדוק" — זה מה שאתה אומר.
2. מספרי טלפון, כתובות מייל ושמות מלונות — מועתקים בדיוק כפי שהם, אם הופיעו.
3. סירוב, התנצלות או "אין לי תשובה מאושרת" שמופיעים ב"חומר" — נשארים במשמעותם. אל תרכך "לא" ל"אולי".
4. אל תכתוב מחיר במספרים, אל תכתוב "הכי טוב", אל תכתוב "התחייבויות", אל תבטיח זמינות ("נראה פנוי", "נציג יאשר").
5. אל תחזור על מה שכתוב ב"ההודעה_הקודמת_שלך", ואל תסכם מחדש מה הלקוח ביקש.
6. אם ב"ידוע_על_הלקוח" יש הרכב (למשל ילדים בני 5 ו-9) והוא רלוונטי לתשובה — אפשר להזכיר אותו במילה, כמו שנציג שקרא את השיחה היה עושה. לא בכל הודעה.
7. שורות שהן רק תבנית ("וכשתרצו לבדוק תאריכים — כתבו לי…", "לקחתי בחשבון: …") — אפשר להשמיט או לקצר, אלא אם הן היחידות בחומר.
8. אם יש "כרטיסים_מוצגים_מתחת" — מתחת להודעה שלך מוצגים כרטיסי המלונות האלה. אפשר להתייחס אליהם בשמם או כ"האפשרויות שלמטה", ואסור להזכיר מלון שלא ברשימה. שורות כמו "הצגתי רק שבועות שבהם הקייטנה פועלת", "סיננתי יציאות בשבת", "אין שבוע שבו פועלת קייטנה" הן עובדות על מה שמוצג — לשמור אותן במשמעותן. "המשך להזמנה" / "תחזרו אליי" — לשמור, במשפט אחד.

סגנון: עברית טבעית וחמה, לשון רבים, בלי אימוג'ים, בלי רשימות, בלי כותרות, בלי צורות לוכסן. 2–5 משפטים. פסקה אחת, לכל היותר שתיים. ענייני — לא "שאלה מצוינת", לא "בשמחה" בתחילת כל הודעה.

החזר טקסט בלבד.`;

const STOP = /^(ו|גם|רק|זה|זו|זאת|הם|הן|אז|אבל|או|כן|לא|מה|יש|אין|האם|אפשר|צריך|כמה|מתי|איפה|איך|למה|מי|של|עם|את|על|כל|שם|בעצם|הזה|הזאת|האלה|עד|לפני|אחרי|בשביל|לגבי|אני|אנחנו|הוא|היא|לי|לנו|לכם|אם|ואם|ש|מ|ב|ל|כ|ה|יותר|פחות|בערך|ממש|כבר|עוד|קצת|מאוד|תמיד|בכלל|דווקא|בסוף|אחר|אחרת|משהו|מישהו|אתם|אתכם|שלכם|אליכם|לכן|כך|ככה|כדי|כי|וגם|אבל|אולי|כמובן|בהחלט|בשמחה|כאן|פה|תודה|היי|שלום)$/;
function stems(text) {
  const out = new Set();
  for (const w0 of String(text || '').replace(/[^֐-׿A-Za-z0-9\s]/g, ' ').split(/\s+/)) {
    if (!w0 || STOP.test(w0)) continue;
    let x = w0;
    for (let i = 0; i < 3; i++) {
      const y = x.replace(/(יות|ים|ות|ה|ת|י)$/, '');
      if (y.length >= 3) out.add(y);
      if (x.length >= 3) out.add(x);
      if (!/^[והבלמשכ]/.test(x) || x.length < 4) break;
      x = x.slice(1);
    }
  }
  return out;
}

// two Hebrew stems that share three consecutive letters share a root, near
// enough: "נשלחים"/"יישלחו" (שלח), "החיוב"/"החיוב" (חיב). Only for words long
// enough that three letters mean something.
function sharesRoot(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  for (let i = 0; i + 3 <= a.length; i++) if (b.includes(a.slice(i, i + 3))) return true;
  return false;
}

function validate(text, { material, question, digest, userText, knownNames, cardsShown }) {
  const t = String(text || '').trim();
  const src = [material, digest || '', userText || '', question || '', ...(cardsShown || [])].join('\n');
  if (!t) return { ok: false, why: 'empty' };
  // "העברה בנקאית אפשרית מול נציג אנושי." (37 chars) was thrown away as too
  // short in the 06/09 smoke run — it was the whole answer. Short is fine;
  // empty-ish is not.
  if (t.length < 25) return { ok: false, why: 'too short' };
  if (t.length > 900) return { ok: false, why: 'too long' };
  if (/[{}\[\]<>]|^\s*[-•*]/m.test(t)) return { ok: false, why: 'markup or list' };
  if (/[₪$€]/.test(t)) return { ok: false, why: 'money sign' };
  if (/הכי טוב|הכי מומלץ|התחייבויות/.test(t)) return { ok: false, why: 'red rule' };
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) return { ok: false, why: 'emoji' };
  // every number in the edit must exist in the material (phone numbers included)
  for (const n of t.match(/\d+/g) || []) if (!src.includes(n)) return { ok: false, why: 'number not in material: ' + n };
  // every latin word likewise (hotel names, "Pingwin Guarantee", emails)
  for (const w of t.match(/[A-Za-z][A-Za-z'.-]{2,}/g) || []) {
    if (!new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(src)) return { ok: false, why: 'latin word not in material: ' + w };
  }
  // a hotel or resort name we know, that the material did not mention
  for (const name of knownNames || []) {
    if (name && t.includes(name) && !src.includes(name)) return { ok: false, why: 'names ' + name };
  }
  // a phone number in the material must survive the edit when the edit talks about calling
  const phone = (material.match(/0\d-?\d{7}|\*\d{4}/) || [])[0];
  if (phone && /להתקשר|התקשרו|תתקשרו|בטלפון|לחייג|חייגו/.test(t) && !t.includes(phone)) return { ok: false, why: 'phone dropped' };
  // a refusal / apology / "no approved answer" in the material must keep its meaning
  // Each refusal has the wordings that keep its meaning; anything else is a
  // softening. (The old fallback, /(?:לא|אין)\b/, never matched — \b does not
  // work next to Hebrew letters — so "אין לי כרגע תשובה מאושרת" was rejected
  // while nothing stopped a refusal being talked around.)
  const musts = [
    [/לא אשווה/, /לא אשווה|לא משווה|אין לי (?:דרך|אפשרות) להשוות|לא (?:אוכל|יכול) להשוות/],
    [/מצטער/, /מצטער|מתנצל|צר לי/],
    [/אין לי תשובה מאושרת/, /אין (?:לי )?(?:כרגע |עדיין )?(?:תשובה|מידע|נתון|מחיר|עלות|פרט) מאושר/],
    [/לא (?:אוכל|יכול) לשתף/, /לא (?:אוכל|יכול|אשתף|נוכל)[^.]{0,20}לשתף|לא אשתף|אין לי (?:אפשרות|דרך) לשתף/],
    [/אין לי גישה/, /אין לי גישה|לא רואה|לא יכול לראות/],
    [/לא כותב אישורים/, /לא כותב אישורים|לא (?:אוכל|יכול) לכתוב אישור|אישורים? [^.]{0,20}רק נציג/],
    [/לא נוקב/, /לא נוקב|לא אנקוב|לא (?:אוכל|יכול) לנקוב|לא אציין מחיר/],
  ];
  for (const [inMaterial, keeps] of musts) {
    if (inMaterial.test(material) && !keeps.test(t)) return { ok: false, why: 'refusal softened' };
  }
  // On a turn with offers, the lines that say what the cards ARE — the price
  // rule, the camp filter, the shabbat filter, the way to book — must survive
  // in meaning, whatever else the editor merges or drops.
  const facts = [
    [/המחיר המדויק[^.\n]{0,60}(?:מסך|עמוד|דף) ההזמנה/, /מסך ההזמנה|עמוד ההזמנה|דף ההזמנה/, 'price rule dropped'],
    [/הצגתי רק שבועות|אין שבוע שבו פועלת|קייטנה בעברית לגילאים/, /קייטנ/, 'camp claim dropped'],
    [/סיננתי יציאות בשבת|אסנן יציאות בשבת/, /שבת/, 'shabbat filter dropped'],
    [/להמשיך להזמנה|המשך להזמנה/, /להזמנה|תחזרו אליי|נציג/, 'booking line dropped'],
    [/פיצול לשני חדרים|שני חדרים/, /שני חדרים|חדרים/, 'two-room split dropped'],
  ];
  for (const [inMaterial, keeps, why] of facts) {
    if (inMaterial.test(material) && !keeps.test(t)) return { ok: false, why };
  }
  // the question the turn must end on. A FAQ paragraph may itself carry a
  // question mark ("לא הגיע מייל? בדקו בספאם") — the edit may keep as many
  // as the material had, never more.
  const maxQ = Math.max(1, (material.match(/[?？]/g) || []).length, ((question || '').match(/[?？]/g) || []).length);
  const outQ = (t.match(/[?？]/g) || []).length;
  // "באיזה חודש? דצמבר, ינואר, פברואר או מרץ, או גמיש?" — one closing question
  // written as two marks is still one question (rejected as two, 06/09 smoke).
  // Two marks that both sit in the tail are the same question.
  // (an options list — no question word of its own, short — is not a second
  // question; "רוצים בשקלים או ביורו? כמה תהיו…?" is)
  const tailSegs = t.slice(-160).split(/[?？]/).slice(0, -1);
  const between = tailSegs.length >= 2 ? tailSegs[tailSegs.length - 1].trim() : null;
  const QWORD = /(?:^|[\s,(])(?:ו?מה|מי|מתי|כמה|איזה|איזו|איפה|האם|רוצים|תרצו|אפשר|צריך|יש|אין|למה|איך)(?=[\s,?]|$)/;
  const oneTooMany = outQ === maxQ + 1 && between != null && between.length <= 80 && !QWORD.test(between);
  if (question) {
    if (!/[?？]/.test(t)) return { ok: false, why: 'question dropped' };
    const qs = stems(question), tail = stems(t.slice(-160));
    let hit = 0; for (const s of qs) if (tail.has(s)) hit++;
    if (qs.size && hit === 0) return { ok: false, why: 'ends on a different question' };
    if (outQ > maxQ && !oneTooMany) return { ok: false, why: 'more than one question' };
  } else if (outQ > maxQ && !oneTooMany) return { ok: false, why: 'invented questions' };
  // the content of the edit comes from the material: most of its words do.
  // The numbers, Latin words and names above are the hard wall; this is the
  // backstop against a paragraph written from nowhere. A faithful paraphrase
  // conjugates ("נשלחים" → "יישלחו", "מתבצע" → "ביצוע"), so a shared root —
  // three letters in common between two stems — counts as covered, and the
  // bar is 60% (six faithful edits were thrown away at 60–71% in the 06/09
  // smoke run).
  const srcStems = stems(src), outStems = [...stems(t)];
  if (outStems.length >= 8) {
    const srcList = [...srcStems];
    const covered = outStems.filter(s => srcStems.has(s) ||
      srcList.some(k => (k.length >= 4 && (k.startsWith(s) || s.startsWith(k))) || sharesRoot(s, k))).length;
    const ratio = covered / outStems.length;
    if (ratio < 0.6) return { ok: false, why: 'too much not from the material (' + Math.round(ratio * 100) + '%)' };
  }
  return { ok: true };
}

function buildPayload({ userText, digest, lastReply, lines, question, cardsShown }) {
  return JSON.stringify({
    הודעת_הלקוח: userText,
    ידוע_על_הלקוח: digest || null,
    ההודעה_הקודמת_שלך: (lastReply || '').slice(0, 500) || null,
    חומר: lines,
    ...(cardsShown && cardsShown.length ? { כרטיסים_מוצגים_מתחת: cardsShown } : {}),
    שאלה_לסיום: question || null,
  });
}

module.exports = { COMPOSE_PROMPT, buildPayload, validate, stems };
