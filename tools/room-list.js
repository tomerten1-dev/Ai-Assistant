// בדיקה: האם אנחנו מצליחים לשאול את מנוע ההזמנות של פינגווין מה החדרים
// שלו, ואילו מהחדרים שלנו מזוהים אוטומטית.
//
// למה זה קיים: השמות שלנו באים מקובץ ההתחייבויות ("1 bdrm apt 2-4 pax")
// ואלה של האתר מגיעים ממערכת ההזמנות ("2 ח\"ש וסלון 2-4 אורחים"). כדי
// שכפתור "המשך להזמנה" יבחר את החדר הנכון, השרת שואל את האתר מה המזהה
// האמיתי. הסקריפט הזה מראה בדיוק מה חוזר.
//
// הרצה (מהתיקייה של הפרויקט):
//     npm run rooms                    שלושה מלונות לדוגמה (מהיר)
//     npm run rooms -- "Plein Sud"     מלון מסוים
//     npm run rooms -- --coverage      כל 40 המלונות, כל החדרים (כמה דקות)
//
// --coverage הוא המספר שקובע: כמה מהחדרים שאנחנו מוכרים ייבחרו לבד בטופס
// של האתר. מה שלא זוהה מודפס בסוף בפורמט מוכן להדבקה ל-config/room-map.json.
//
// אם רואים "403" או "timeout" — האתר חוסם את השרת, וצריך להוסיף את כתובת
// השרת לרשימה הלבנה אצל מי שמתחזק את האתר.

const siteRooms = require('../server/site-rooms.js');
const { addNights } = require('../config/booking-url.js');

const resorts = require('../data/resorts.json');
const units = (require('../data/availability.json').units || []);

const argv = process.argv.slice(2);
const arg = argv.filter(a => !a.startsWith('--'))[0];
const all = argv.includes('--all');
const coverage = argv.includes('--coverage');
const CONCURRENCY = Number(process.env.ROOMS_CONCURRENCY || 3);

const wanted = u => {
  const info = resorts.hotels[u.hotel];
  if (!info || !info.siteID) return false;
  return !arg || u.hotel.toLowerCase().includes(arg.toLowerCase());
};

/* Which hotel+date combinations to ask about.
   A hotel's room list depends on the date it is asked about, so one date per
   hotel can miss a room that is only sold on another week. --coverage keeps
   adding dates for a hotel until every room name we sell there has been seen
   at least once (three dates at most — past that it is a data problem, not a
   matching one). */
function combos() {
  const byHotel = new Map();
  for (const u of units) {
    if (!wanted(u)) continue;
    if (!byHotel.has(u.hotel)) byHotel.set(u.hotel, []);
    byHotel.get(u.hotel).push(u);
  }
  const out = [];
  for (const [hotel, us] of byHotel) {
    if (!coverage && !all) { out.push(us[0]); continue; }
    if (all) {
      const dates = new Set();
      for (const u of us) if (!dates.has(u.date)) { dates.add(u.date); out.push(u); }
      continue;
    }
    const need = new Set(us.map(u => u.room));
    const dates = [...new Set(us.map(u => u.date))];
    for (const date of dates) {
      if (!need.size || out.filter(x => x.hotel === hotel).length >= 3) break;
      const here = us.filter(u => u.date === date);
      if (!here.some(u => need.has(u.room))) continue;
      here.forEach(u => need.delete(u.room));
      out.push(here[0]);
    }
  }
  return out.slice(0, all ? 200 : coverage ? 200 : 3);
}

const BASE = process.env.SITE_ROOMS_BASE || 'https://www.pingwin.co.il';

// what the server would choose, per party size this unit can take
function verdict(rooms, x) {
  const base = { type: x.room_type, occMin: x.occ_min, occMax: x.occ_max, hotel: x.hotel };
  const lo = x.occ_min || x.occ_max || 0, hi = x.occ_max || x.occ_min || 0;
  const by = new Map();
  for (let n = lo; n <= hi; n++) {
    const id = siteRooms.match(rooms, x.room, { ...base, party: n });
    const hit = id && rooms.find(r => String(r.roomID) === String(id));
    if (hit) by.set(String(n), hit);
  }
  if (!by.size) {
    const any = siteRooms.match(rooms, x.room, base);
    const hit = any && rooms.find(r => String(r.roomID) === String(any));
    if (hit) by.set('', hit);
  }
  // and the manual bridge, for the names that will never look alike — it is
  // what the server uses too, so a report that ignored it would be lying
  if (!by.size) {
    const manual = siteRooms.idFor(String(siteIDof(x.hotel)), '', '', x.room);
    const hit = manual && rooms.find(r => String(r.roomID) === String(manual));
    if (hit) { hit.manual = true; by.set('', hit); }
  }
  return by;
}
const siteIDof = hotel => (resorts.hotels[hotel] || {}).siteID;

async function askAbout(u) {
  const info = resorts.hotels[u.hotel];
  const till = addNights(u.date, u.nights);
  const lines = [`── ${u.hotel} (siteID ${info.siteID}) · ${u.date} → ${till}`];
  let rooms;
  try {
    rooms = await siteRooms.fetchRooms(info.siteID, u.date, till);
  } catch (e) {
    lines.push('   ✗ לא הצלחנו לקבל רשימת חדרים: ' + e.message);
    return { lines, failed: true, results: [] };
  }
  lines.push(`   האתר מחזיר ${rooms.length} חדרים:`);
  rooms.forEach(r => lines.push(`     ${String(r.roomID).padEnd(8)} ${r.roomName}`));

  const ours = [];
  for (const x of units.filter(y => y.hotel === u.hotel && y.date === u.date)) {
    if (!ours.some(o => o.room === x.room)) ours.push(x);
  }
  lines.push('   החדרים שלנו לאותה יציאה:');
  const results = [];
  for (const x of ours) {
    const by = verdict(rooms, x);
    const first = [...by.values()][0];
    results.push({ hotel: x.hotel, siteID: info.siteID, room: x.room,
      hit: by.size > 0, manual: !!(first && first.manual) });
    if (!by.size) { lines.push(`     ${x.room}\n        → ✗ אין התאמה`); continue; }
    const ids = new Set([...by.values()].map(h => h.roomID));
    if (ids.size === 1) {
      const h = [...by.values()][0];
      lines.push(`     ${x.room}\n        → ✓ ${h.roomID} (${h.roomName})` +
        (h.manual ? '   [מיפוי ידני מ-config/room-map.json]' : ''));
    } else {
      lines.push(`     ${x.room}`);
      for (const [n, h] of by) lines.push(`        → ✓ ${n} אנשים: ${h.roomID} (${h.roomName})`);
    }
  }
  return { lines, failed: false, results };
}

// a few at a time: their engine takes ~8s per answer, and 40 hotels one after
// another is ten minutes of waiting for a number we need in two
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

(async () => {
  const list = combos();
  if (!list.length) { console.log('לא נמצאו יציאות שמתאימות לחיפוש.'); return; }
  console.log(`בודק ${list.length} שילובים של מלון ותאריך מול ${BASE}`);
  if (list.length > 6) console.log(`(${CONCURRENCY} במקביל — זה לוקח כמה דקות)\n`); else console.log('');

  let done = 0;
  const answers = await pool(list, CONCURRENCY, async (u) => {
    const a = await askAbout(u);
    done++;
    if (list.length > 6) process.stdout.write(`\r   ${done}/${list.length}…   `);
    return a;
  });
  if (list.length > 6) process.stdout.write('\r' + ' '.repeat(24) + '\r');

  let ok = 0, failed = 0;
  const seenRoom = new Map();          // hotel|room → matched?
  for (const a of answers) {
    console.log(a.lines.join('\n') + '\n');
    if (a.failed) { failed++; continue; }
    ok++;
    for (const r of a.results) {
      const k = r.hotel + '|' + r.room;
      if (!seenRoom.get(k)) seenRoom.set(k, r.hit ? r : false);
      if (r.hit) seenRoom.set(k, r);
    }
  }
  const rows = [...seenRoom.entries()];
  const missed = rows.filter(([, v]) => !v);
  const manual = rows.filter(([, v]) => v && v.manual).length;
  console.log(`סיכום: ${ok} בקשות הצליחו, ${failed} נכשלו, ` +
    `${rows.length - missed.length} מתוך ${rows.length} חדרים זוהו` +
    (manual ? ` (${manual} מהם דרך מיפוי ידני).` : '.'));
  if (failed) console.log('בקשה שנכשלת = הקישור עדיין יעבוד, אבל בלי בחירת חדר אוטומטית.');

  if (missed.length) {
    // ready to paste: the manual bridge takes exactly this shape
    const bySite = {};
    for (const [k] of missed) {
      const [hotel, room] = k.split('|');
      const id = (resorts.hotels[hotel] || {}).siteID;
      if (!id) continue;
      (bySite[id] = bySite[id] || {})[room] = '';
    }
    console.log(`\nלא זוהו ${missed.length} חדרים. אפשר למפות אותם ידנית —`);
    console.log('להעתיק לתוך config/room-map.json ולמלא את המזהה מתוך הרשימה למעלה:');
    console.log(JSON.stringify(bySite, null, 2));
    console.log('\n(אפשר גם פשוט לשלוח לי את הפלט הזה ואני אמלא.)');
  }
})();
