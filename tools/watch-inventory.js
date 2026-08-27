// שומר על המלאי מעודכן לבד. פותחים חלון אחד בבוקר ושוכחים ממנו.
//
//     npm run watch
//
// מה זה עושה: מסתכל על קובץ ההתחייבויות ב-F: כל דקה. ברגע שמישהו שומר אותו,
// מפענח מחדש ומעדכן את הבוט. לא כל כמה שעות — תוך פחות מדקה.
//
// מה זה לא דורש: התקנה, הרשאות מנהל, משימה מתוזמנת, אישור IT. Node כבר כאן,
// והקובץ ב-F: כבר פתוח לך. זה קורא אותו, כמו שאת/ה קורא אותו.
//
// הקובץ המקורי לא זז לשום מקום: הפענוח קורה כאן, ומה שנשלח זה רק ספירות של
// חדרים פנויים. אותו שער PII של הבנייה רץ לפני כל שליחה.
//
// הגדרה (פעם אחת):
//     set PINGWIN_WORKBOOK=F:\<תיקייה>\commitments-winter-2027.xlsm
//     set PINGWIN_BOT_URL=http://localhost:8787      ← או השרת, כשיהיה
//     set PINGWIN_BOT_TOKEN=<INVENTORY_TOKEN>        ← לא נדרש בלוקאלהוסט
//
// בלי PINGWIN_BOT_URL הוא פשוט כותב את data/availability.json כאן, וזה מספיק
// כשהבוט רץ מאותה תיקייה.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WB = process.argv[2] || process.env.PINGWIN_WORKBOOK
  || path.join(ROOT, 'source-data', 'commitments-winter-2027.xlsm');
const URL_ = (process.env.PINGWIN_BOT_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.PINGWIN_BOT_TOKEN || '';
const EVERY = Number(process.env.PINGWIN_WATCH_SECONDS || 60) * 1000;

const { parseInventory, stats } = require('../data/inventory.js');
const { toAvailability } = require('./../data/aggregate.js');
const gate = require('../data/pii-gate.js');

const clock = () => new Date().toLocaleTimeString('he-IL', { hour12: false });
const say = (...a) => console.log(clock(), ...a);

/* fs.watch does not work on a network share — SMB does not deliver change
   events. So: a stat every minute, which is cheap, and a change is only acted
   on once the file has stopped moving. Someone saving a 300 KB workbook over
   the network is not atomic, and parsing it halfway through is how you push a
   truncated season. */
function snapshot() {
  try {
    const st = fs.statSync(WB);
    return st.mtimeMs + ':' + st.size;
  } catch (e) { return null; }
}
async function settled() {
  let a = snapshot();
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const b = snapshot();
    if (b && b === a) return b;
    a = b;
  }
  return null;
}

async function push(out) {
  if (!URL_) {
    fs.writeFileSync(path.join(ROOT, 'data', 'availability.json'), JSON.stringify(out, null, 1));
    say('נכתב מקומית: data/availability.json');
    return true;
  }
  const res = await fetch(URL_ + '/api/inventory', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      TOKEN ? { authorization: 'Bearer ' + TOKEN } : {}),
    body: JSON.stringify(out),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { say('השרת דחה (' + res.status + '):', body.error || ''); return false; }
  say(`עודכן: ${body.units} שורות, ${body.rooms} חדרים` + (body.was ? ` (היה ${body.was})` : ''));
  return true;
}

async function once(why) {
  // work on a copy: the workbook is open in Excel on someone's screen almost
  // always, and the parser should not be reading a file that is being written
  const tmp = path.join(os.tmpdir(), 'pingwin-wb-' + process.pid + '.xlsm');
  try {
    fs.copyFileSync(WB, tmp);
    const rows = parseInventory(tmp);
    const st = stats(rows);
    const out = toAvailability(rows, st);
    const problems = gate.check(out);
    if (problems.length) {
      say('שער המידע האישי נכשל — לא נשלח כלום:', problems.slice(0, 2).join(' · '));
      return false;
    }
    say(`${why}: ${rows.length} שורות, ${st.status.free || 0} פנויות`);
    return await push(out);
  } catch (e) {
    say('נכשל:', e.message);
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* nothing to clean */ }
  }
}

(async () => {
  say('מסתכל על', WB);
  say(URL_ ? 'מעדכן את ' + URL_ : 'כותב מקומית (בלי PINGWIN_BOT_URL)');
  if (!snapshot()) {
    console.error(clock(), 'הקובץ לא נמצא. להגדיר PINGWIN_WORKBOOK, או להעביר נתיב כארגומנט.');
    process.exit(1);
  }
  let seen = await settled();
  await once('עדכון ראשון');
  say(`בודק כל ${EVERY / 1000} שניות. אפשר להשאיר את החלון פתוח ולשכוח.`);

  let quiet = 0;
  setInterval(async () => {
    const now = snapshot();
    if (!now) { say('הקובץ לא נגיש כרגע — ממשיך לנסות'); return; }
    if (now === seen) {
      // one line an hour, so the window shows it is alive without filling up
      if (++quiet >= Math.max(1, Math.round(3600000 / EVERY))) { quiet = 0; say('אין שינוי'); }
      return;
    }
    quiet = 0;
    say('הקובץ השתנה — מחכה שיסיים להישמר');
    const after = await settled();
    if (!after) { say('הקובץ עדיין משתנה — אנסה שוב בסבב הבא'); return; }
    seen = after;
    await once('עדכון');
  }, EVERY).unref?.();
  // keep the process alive even with unref'd timer
  setInterval(() => {}, 1 << 30);
})();
