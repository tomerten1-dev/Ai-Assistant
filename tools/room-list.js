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
    // which of OUR rooms for this hotel+date the server would identify —
    // the same call server.js makes when it builds the link
    const ours = [];
    for (const x of units.filter(y => y.hotel === u.hotel && y.date === u.date)) {
      if (!ours.some(o => o.room === x.room)) ours.push(x);
    }
    console.log('   החדרים שלנו לאותה יציאה:');
    for (const x of ours) {
      // the same call server.js makes, once per party size this unit can take —
      // the site often splits one of our units into a room per party size
      const base = { type: x.room_type, occMin: x.occ_min, occMax: x.occ_max };
      const lo = x.occ_min || x.occ_max || 0, hi = x.occ_max || x.occ_min || 0;
      const by = new Map();
      for (let n = lo; n <= hi; n++) {
        const id = siteRooms.match(rooms, x.room, { ...base, party: n });
        const hit = id && rooms.find(r => String(r.roomID) === String(id));
        if (hit) by.set(String(n), hit);
      }
      if (!by.size) {
        console.log(`     ${x.room}\n        → ✗ אין התאמה`);
        continue;
      }
      matched++;
      const ids = new Set([...by.values()].map(h => h.roomID));
      if (ids.size === 1) {
        const h = [...by.values()][0];
        console.log(`     ${x.room}\n        → ✓ ${h.roomID} (${h.roomName})`);
      } else {
        console.log(`     ${x.room}`);
        for (const [n, h] of by) console.log(`        → ✓ ${n} אנשים: ${h.roomID} (${h.roomName})`);
      }
    }
    console.log('');
  }
  console.log(`סיכום: ${ok} בקשות הצליחו, ${failed} נכשלו, ${matched} חדרים שלנו זוהו אוטומטית.`);
  if (failed) console.log('בקשה שנכשלת = הקישור עדיין יעבוד, אבל בלי בחירת חדר אוטומטית.');
  if (!failed && matched === 0) {
    console.log('אף חדר לא זוהה — צריך למפות ידנית ב-config/room-map.json (ראו README של הקובץ).');
  }
})();
