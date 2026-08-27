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
// A file, or the folder it lives in. A folder is the safer answer: the workbook
// is named in Hebrew and gets renamed between seasons, and a path typed once
// into an environment variable is a path that goes stale in silence.
const TARGET = process.argv[2] || process.env.PINGWIN_WORKBOOK
  || path.join(ROOT, 'source-data');
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
/* Which file to read.
   Given a folder, the newest workbook in it — so a rename, or next season's
   file, is picked up without anyone editing a setting.
   ~$ files are Excel's lock files: the moment somebody opens the workbook one
   appears beside it, and it is ALWAYS the newest thing in the folder. It is
   also a few hundred bytes of nothing. Picking it would mean that the instant
   a person opens the file, the bot stops being updated. */
const LOCK = /^~\$/;
const BOOK = /\.xls[xm]$/i;
function pick() {
  let st;
  try { st = fs.statSync(TARGET); } catch (e) { return null; }
  if (st.isFile()) return TARGET;
  let best = null, bestAt = -1;
  let names;
  try { names = fs.readdirSync(TARGET); } catch (e) { return null; }
  for (const name of names) {
    if (LOCK.test(name) || !BOOK.test(name)) continue;
    const full = path.join(TARGET, name);
    let s2;
    try { s2 = fs.statSync(full); } catch (e) { continue; }
    if (!s2.isFile()) continue;
    // an Excel lock file is tiny; so is a stub someone left behind
    if (s2.size < 20000) continue;
    if (s2.mtimeMs > bestAt) { bestAt = s2.mtimeMs; best = full; }
  }
  return best;
}

let WB = null;
function snapshot() {
  const f = pick();
  if (!f) return null;
  if (f !== WB) {
    if (WB) say('הקובץ התחלף:', path.basename(f));
    WB = f;
  }
  try {
    const st = fs.statSync(f);
    // the name is part of the identity: a new file with the same size and
    // timestamp is still a new file
    return f + ':' + st.mtimeMs + ':' + st.size;
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
    // written to a neighbour and renamed: the bot re-reads this file whenever
    // it changes, and reading it half-written is the one way this could take
    // the search down for a moment
    const dest = path.join(ROOT, 'data', 'availability.json');
    const tmp = dest + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
    fs.renameSync(tmp, dest);
    say('נכתב מקומית: data/availability.json — הבוט יקלוט את זה מיד');
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
  say('מסתכל על', TARGET);
  say(URL_ ? 'מעדכן את ' + URL_ : 'כותב מקומית (בלי PINGWIN_BOT_URL)');
  if (!snapshot()) {
    console.error(clock(), 'לא נמצא קובץ אקסל בנתיב הזה.');
    console.error('   אפשר להעביר נתיב לקובץ או לתיקייה:  npm run watch -- "F:\\...\\<שם>.xlsm"');
    console.error('   או להגדיר PINGWIN_WORKBOOK.');
    process.exit(1);
  }
  say('הקובץ:', path.basename(WB));
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
