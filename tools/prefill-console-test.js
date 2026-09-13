// בדיקה ידנית של מילוי טופס ההזמנה — בלי GTM ובלי שרת.
//
// למה זה קיים: הסקריפט האמיתי (public/pingwin-prefill.js) מוגש מהשרת שלנו
// ונטען לדף של פינגווין דרך תג GTM. עד שהתג עולה לאוויר אין דרך לטעון אותו
// לאתר האמיתי — ולכן קישור עם הפרמטרים לבדו לא עושה כלום. זה לא תקלה.
//
// הקובץ הזה לא מחזיק עותק של הסקריפט. הוא מדפיס את הקובץ האמיתי, כדי שבדיקה
// ידנית תבדוק תמיד את מה שבאמת יעלה לאוויר. (קודם כאן ישב עותק שנכתב ביד, והוא
// כבר פיגר אחרי הקוד — בלי pwroomid ובלי כל התאמת החדרים של 26/08.)
//
// שימוש:
//     node tools/prefill-console-test.js            להעתקה מהמסך
//     node tools/prefill-console-test.js --out      נשמר לקובץ prefill-paste.js
//
// ואז:
//   1. פותחים דף מלון עם הפרמטרים (הקישור שהבוט מייצר, או הדוגמה שמודפסת למטה)
//   2. F12 → Console
//   3. מדביקים את הכל → Enter
//   4. התאריכים, החדר, מספר האורחים ובסיס האירוח מתמלאים, ועם pwquote=1 גם
//      נלחץ "הפקת הצעת מחיר" — אבל רק אחרי שהחדר נבחר ויש לו מחיר.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'pingwin-prefill.js');
const code = fs.readFileSync(SRC, 'utf8');

// a link that exercises every part of it, built by the same code the bot uses
const { deepLink } = require('../config/booking-url.js');
const resorts = require('../data/resorts.json');
const example = deepLink(resorts.hotels['Plein Sud (allotment)'], {
  date: '2027-01-30', nights: 7, room: '2 bedroom apt 4-5 pax',
  board_he: 'לינה בלבד', room_id: '3721',
}, { adults: 5, children_ages: [] });

if (process.argv.includes('--out')) {
  const out = path.join(process.cwd(), 'prefill-paste.js');
  fs.writeFileSync(out, code);
  console.log('נשמר: ' + out);
  console.log('\nלפתוח קודם את הדף הזה, ואז להדביק את תוכן הקובץ בקונסול:\n');
  console.log(example);
} else {
  console.log('── פותחים את הדף הזה: ──\n');
  console.log(example);
  console.log('\n── ואז F12 → Console → מדביקים את כל זה: ──\n');
  console.log(code);
}
