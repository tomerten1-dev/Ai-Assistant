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

/* The console this prints into is a Windows one, and its default code page is
   not UTF-8 — so every Hebrew line here, and every Hebrew file name, arrives as
   gibberish. Node writes UTF-8 regardless; it is the window that has to be told. */
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) { /* older shell */ }
}
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
// why the target could not be read, in the caller's words — over a network
// share "not found" and "not allowed" are different problems with different
// fixes, and errno is the only thing that tells them apart
let lastError = null;
function explain(e) {
  const c = e && e.code;
  if (c === 'ENOENT') return 'הנתיב לא קיים — לבדוק אותיות ורווחים, ושהתיקייה היא הנכונה';
  if (c === 'EACCES' || c === 'EPERM') return 'אין הרשאה לקרוא מהנתיב הזה מהמחשב הזה';
  if (c === 'ENOTDIR') return 'זה לא נתיב לתיקייה';
  if (c === 'EBUSY' || c === 'ETIMEDOUT' || c === 'ENETUNREACH' || c === 'EHOSTUNREACH') {
    return 'הרשת לא זמינה כרגע — כונן רשת שנפל, או המחשב לא מחובר';
  }
  return (e && e.message) || String(e);
}
const DEPTH = Number(process.env.PINGWIN_WATCH_DEPTH || 3);

// the newest real workbook directly inside one folder
function bestIn(dir) {
  let best = null, bestAt = -1, names;
  try { names = fs.readdirSync(dir); }
  catch (e) { lastError = explain(e); return null; }
  for (const name of names) {
    if (LOCK.test(name) || !BOOK.test(name)) continue;
    const full = path.join(dir, name);
    let s2;
    try { s2 = fs.statSync(full); } catch (e) { continue; }
    // an Excel lock file is a few hundred bytes; so is a stub left behind
    if (!s2.isFile() || s2.size < 20000) continue;
    if (s2.mtimeMs > bestAt) { bestAt = s2.mtimeMs; best = full; }
  }
  return best;
}

/* Given the root of a share, look inside it.
   The folder is named in Hebrew, and a Hebrew path typed into a Windows console
   does not survive the code page — so finding the file rather than being told
   where it is is not a convenience here, it is the difference between working
   and not. Bounded, and only until something is found: after that one folder is
   watched, once a minute, which is a single stat over the network. */
let searched = null;
function findAnywhere(root, depth) {
  const here = bestIn(root);
  if (here) return here;
  if (depth <= 0) return null;
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
  let best = null, bestAt = -1;
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const hit = findAnywhere(path.join(root, d.name), depth - 1);
    if (!hit) continue;
    let s2; try { s2 = fs.statSync(hit); } catch (e) { continue; }
    if (s2.mtimeMs > bestAt) { bestAt = s2.mtimeMs; best = hit; }
  }
  return best;
}

function pick() {
  let st;
  try { st = fs.statSync(TARGET); lastError = null; }
  catch (e) { lastError = explain(e); return null; }
  if (st.isFile()) return TARGET;
  // the folder we settled on last time, while it still holds a workbook
  if (searched) {
    const again = bestIn(searched);
    if (again) return again;
  }
  const found = findAnywhere(TARGET, DEPTH);
  if (found) {
    const dir = path.dirname(found);
    if (dir !== searched) {
      searched = dir;
      if (dir !== TARGET) say('נמצא בתוך:', dir);
    }
  }
  if (!found && !lastError) {
    lastError = 'לא נמצא קובץ אקסל (xlsx/xlsm) גדול מ-20KB בנתיב הזה ולא בתת-תיקיות (' + DEPTH + ' רמות)';
  }
  return found;
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
    console.error(clock(), lastError || 'לא נמצא בנתיב הזה קובץ אקסל (xlsx/xlsm) גדול מ-20KB.');
    console.error('   נתיב לתיקייה או לקובץ:  npm run watch -- "\\\\<שרת>\\<שיתוף>\\<תיקייה>"');
    console.error('   כונן ממופה עובד גם:     npm run watch -- "F:\\<תיקייה>"');
    if (/הרשאה/.test(lastError || '')) {
      console.error('   לחיבור עם משתמש אחר:   net use \\\\<שרת>\\<שיתוף> /user:<domain>\\<user>');
    }
    process.exit(1);
  }
  say('הקובץ:', path.basename(WB));
  let seen = await settled();
  await once('עדכון ראשון');
  say(`בודק כל ${EVERY / 1000} שניות. אפשר להשאיר את החלון פתוח ולשכוח.`);

  let quiet = 0;
  setInterval(async () => {
    const now = snapshot();
    if (!now) { say('לא נגיש כרגע (' + (lastError || '') + ') — ממשיך לנסות'); return; }
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
