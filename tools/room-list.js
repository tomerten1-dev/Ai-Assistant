// בדיקה: האם אנחנו מצליחים לשאול את מנוע ההזמנות של פינגווין מה החדרים
// שלו, ואילו מהחדרים שלנו מזוהים אוטומטית.
//
// למה זה קיים: השמות שלנו באים מקובץ ההתחייבויות ("1 bdrm apt 2-4 pax")
// ואלה של האתר מגיעים ממערכת ההזמנות ("2 ח\"ש וסלון 2-4 אורחים"). כדי
// שכפתור "המשך להזמנה" יבחר את החדר הנכון, השרת שואל את האתר מה המזהה
// האמיתי. הסקריפט הזה מראה בדיוק מה חוזר.
//
// הרצה (מהתיקייה של הפרויקט):
//     node tools/room-list.js                 שלושה מלונות לדוגמה
//     node tools/room-list.js "Plein Sud"     מלון מסוים
//     node tools/room-list.js --all           כל מה שיש בחודש הקרוב (איטי)
//
// אם רואים "403" או "timeout" — האתר חוסם את השרת, וצריך להוסיף את כתובת
// השרת לרשימה הלבנה אצל מי שמתחזק את האתר.

const path = require('path');
const siteRooms = require('../server/site-rooms.js');
const { addNights } = require('../config/booking-url.js');

const resorts = require('../data/resorts.json');
const units = (require('../data/availability.json').units || []);

const arg = process.argv.slice(2).filter(a => !a.startsWith('--'))[0];
const all = process.argv.includes('--all');

// one real, bookable combination per hotel — the same ones the bot offers
const seen = new Map();
for (const u of units) {
  const info = resorts.hotels[u.hotel];
  if (!info || !info.siteID) continue;
  if (arg && !u.hotel.toLowerCase().includes(arg.toLowerCase())) continue;
  const k = u.hotel + '|' + u.date;
  if (seen.has(u.hotel) && !all) continue;
  if (!seen.has(k)) seen.set(all ? k : u.hotel, u);
}
const list = [...seen.values()].slice(0, all ? 200 : 3);

(async () => {
  if (!list.length) { console.log('לא נמצאו יציאות שמתאימות לחיפוש.'); return; }
  console.log(`בודק ${list.length} שילובים של מלון ותאריך מול ${process.env.SITE_ROOMS_BASE || 'https://www.pingwin.co.il'}\n`);
  let ok = 0, failed = 0, matched = 0;
  for (const u of list) {
    const info = resorts.hotels[u.hotel];
    const till = addNights(u.date, u.nights);
    process.stdout.write(`── ${u.hotel} (siteID ${info.siteID}) · ${u.date} → ${till}\n`);
    let rooms;
    try {
      rooms = await siteRooms.fetchRooms(info.siteID, u.date, till);
      ok++;
    } catch (e) {
      failed++;
      console.log('   ✗ לא הצלחנו לקבל רשימת חדרים: ' + e.message + '\n');
      continue;
    }
    console.log(`   האתר מחזיר ${rooms.length} חדרים:`);
    rooms.forEach(r => console.log(`     ${String(r.roomID).padEnd(8)} ${r.roomName}`));
    // which of OUR room names for this hotel+date would be matched
    const ours = [...new Set(units.filter(x => x.hotel === u.hotel && x.date === u.date).map(x => x.room))];
    console.log('   החדרים שלנו לאותה יציאה:');
    for (const room of ours) {
      const want = siteRooms.norm(room);
      const hit = rooms.filter(r => {
        const n = siteRooms.norm(r.roomName);
        return n === want || n.indexOf(want) >= 0 || want.indexOf(n) >= 0;
      });
      const verdict = hit.length === 1 ? `✓ ${hit[0].roomID} (${hit[0].roomName})`
        : hit.length ? `? ${hit.length} התאמות — לא נבחר` : '✗ אין התאמה';
      if (hit.length === 1) matched++;
      console.log(`     ${room}\n        → ${verdict}`);
    }
    console.log('');
  }
  console.log(`סיכום: ${ok} בקשות הצליחו, ${failed} נכשלו, ${matched} חדרים שלנו זוהו אוטומטית.`);
  if (failed) console.log('בקשה שנכשלת = הקישור עדיין יעבוד, אבל בלי בחירת חדר אוטומטית.');
  if (!failed && matched === 0) {
    console.log('אף חדר לא זוהה — צריך למפות ידנית ב-config/room-map.json (ראו README של הקובץ).');
  }
})();
