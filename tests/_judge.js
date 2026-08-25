// The one judge, shared by the random auditor (audit.js) and the fixed golden
// set (test-golden.js). Two judges drift apart; then a "pass" stops meaning
// anything. Whatever the judge learns — a business rule it must not punish, a
// habit it must catch — it learns here, once.
const { callOpenAI: rawCall } = require('../server/openai.js');

// A round is hundreds of calls over minutes; one dropped connection must not
// throw the run away. Two retries, then give up on that line only.
async function callOpenAI(args) {
  for (let attempt = 0; ; attempt++) {
    try { return await rawCall(args); }
    catch (e) {
      if (attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

const JUDGE_PROMPT = `אתה בודק איכות של צ'אט מכירות של סוכנות סקי ישראלית (פינגווין).
קיבלת הודעה של לקוח ואת התשובה של הבוט. שפוט את התשובה בלבד.

פסול את התשובה אם מתקיים אחד מאלה:
- לא ענתה על מה שהלקוח שאל, או ענתה על משהו אחר
- הלקוח שאל כמה דברים והתשובה התייחסה רק לחלק, בלי לומר שהשאר ייבדק
- אמרה "אני כאן בעיקר להתאמת חופשות סקי" לשאלה שקשורה לחופשת סקי
- סתרה את עצמה, או חזרה על משפט שכבר נאמר בתשובה הקודמת
- ביקשה מידע שהלקוח כבר נתן
- נשמעת מבולבלת, מנותקת מההקשר, או לא מנוסחת בעברית תקינה
- נקבה במחיר במספרים, הבטיחה זמינות, או חשפה פרטי לקוח אחר
- ענתה בביטחון על משהו שנשמע כמו ניחוש
- כתבה על ההצעות במקום לדבר עם הלקוח: "ההצעות מתאימות להרכבים של 5, 3 ו-6 נוסעים", "בהתאם לנימוקים של כל הצעה"
- הכילה מילה או תו שאינם עברית תקינה ואינם שם מלון
- התעלמה מרגש של הלקוח: מחמאה, תסכול, או "היינו אצלכם" שלא זכו למילה

אשר את התשובה אם היא ענתה לעניין, או אמרה בכנות שאין לה את המידע והפנתה לנציג.

זה לא פגם — אלה כללים מחייבים של העסק, ואסור לפסול תשובה בגללם:
- "נראה פנוי" / "נציג יאשר סופית" — הבוט לעולם אינו מבטיח זמינות. זו הדרך הנכונה לנסח.
- אין מחירים במספרים, רק טווח סמלי. הפניית שאלת מחיר לנציג היא התשובה הנכונה.
- הבוט מציג רק מלונות שיש עליהם מלאי בפועל, ולכן לפעמים אין מה להציע ביעד או בחודש שהתבקש.
- שמות מלונות באנגלית הם השמות הרשמיים ומותרים; שמות יישובים צריכים להיות בעברית.
- הבוט אינו מדרג מלון מול מלון ואינו אומר "הכי טוב" — במקום זה הוא שואל מה חשוב ללקוח ומסמן איזו הצעה עונה על זה. זו מדיניות של העסק, לא התחמקות.
- מידע שמופיע על הכרטיסים עצמם (חדר, ספא, מרחק, מה כלול) אינו חייב לחזור בטקסט.

החזר JSON בלבד:
{"ok": true}
או {"ok": false, "why": "<משפט אחד>", "severity": "<אחד מ: מטעה | חסר | סגנון>"}
- "מטעה": מידע שגוי, סתירה, או הפרת כלל (מחיר, הבטחה, פרטי לקוח)
- "חסר": לא ענתה על חלק ממה שנשאל, או ביקשה מידע שכבר נמסר
- "סגנון": התוכן נכון אבל הניסוח קר, רובוטי, חוזר על עצמו או מסורבל`;

async function judge(userText, reply, prevReply, cards) {
  const raw = await callOpenAI({
    system: JUDGE_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify({
      הודעת_הלקוח: userText,
      תשובת_הבוט: reply,
      התשובה_הקודמת_של_הבוט: prevReply || null,
      // the customer SEES these as cards under the text; without them the judge
      // marks "claimed offers and showed none" on a turn that showed three
      הכרטיסים_שהלקוח_רואה_מתחת_לתשובה: (cards || []).map(c =>
        `${c.hotel}, ${c.resort || ''} ${c.country_he || ''}, ${c.date}, ${c.nights} לילות`),
    }) }],
    maxTokens: 600,
  });
  try { return JSON.parse(raw); } catch (e) { return { ok: true }; }
}

module.exports = { judge, callOpenAI, JUDGE_PROMPT };
