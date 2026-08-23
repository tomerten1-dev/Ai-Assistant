// BUILD STEP: which departure dates carry "מכירת התחייבויות בלבד".
//
// Tomer, 23/08: the restriction is per departure block, not global. On a
// restricted date only the workbook's hotels may be sold. On a date with no
// such note, hotels outside the workbook can be sold too — subject to the
// flight not being full and to confirmation with the hotel, neither of which
// this workbook knows. So the output marks dates OPEN or RESTRICTED, and the
// bot phrases an open date as "a rep can check", never as "available".
//
// Verified against Tomer's example: Mayrhofen 06/03 is open, 20/02 is not.
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./xlsx-read.js');

const ROOT = path.join(__dirname, '..');
const SRC = process.argv[2] || path.join(ROOT, 'source-data', 'commitments-winter-2027.xlsm');
const OUT = path.join(ROOT, 'data', 'restrictions.json');

const SHEET_COUNTRY = {
  'מאיירהופן': 'austria', 'אישגיל': 'austria',
  'ואל טורנס': 'france', 'בלמברה (שבת)': 'france', 'Odalys+Ynycio': 'france',
  'קלאב סוליי VCS': 'france', 'צרפת יום ראשון': 'france',
  'חנוכה בלמברה טין 5-12.12': 'france',
  'אנדורה': 'andorra',
  'בולגריה שבועי שישי': 'bulgaria', 'בולגריה סופ"ש שישי-שלישי': 'bulgaria',
  'בולגריה סופ"ש שישי-רביעי': 'bulgaria', 'בולגריה ראשון+חמישי': 'bulgaria',
};

const NOTE = /מכירת התחייבויות בלבד/;
const wb = readWorkbook(SRC);
const blocks = [];

for (const sheet of wb) {
  const country = SHEET_COUNTRY[sheet.name] || null;
  // block corners: every cell whose text starts with "תאריך יציאה"
  const corners = [];
  for (let r = 1; r <= sheet.maxRow; r++) {
    for (let c = 1; c <= sheet.maxCol; c++) {
      const cell = sheet.get(r, c);
      if (cell && /^תאריך יציאה/.test(String(cell.text))) corners.push({ r, c });
    }
  }
  // group corners by column so horizontally repeated blocks stay separate
  const byCol = new Map();
  for (const k of corners) { if (!byCol.has(k.c)) byCol.set(k.c, []); byCol.get(k.c).push(k.r); }

  for (const [col, startRows] of byCol) {
    startRows.sort((a, b) => a - b);
    const bounds = [...startRows, sheet.maxRow + 1];
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = bounds[i], to = bounds[i + 1];
      const dates = new Set();
      let restricted = false;
      for (let r = from; r < to; r++) {
        const d = sheet.get(r, col);
        // Some blocks store the departure date as TEXT rather than a date cell
        // (Mayrhofen 27/02/2027 is one) — reading only dateISO silently
        // dropped a whole departure, and with it its restriction.
        if (d) {
          if (d.dateISO) dates.add(d.dateISO);
          else {
            const txt = String(d.text || '').trim();
            // plain "27/02/2027", and holiday labels the workbook writes as
            // "חנוכה 05/12/2026" or "פורים 19/03" (no year — it's the season's)
            // the label may lead OR trail the date: "פורים 19/03" and
            // "21/03/2027 פורים" both appear in the workbook
            const m = txt.match(/(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/);
            if (m && !/^\d+$/.test(txt)) {
              const mo = +m[2];
              const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : (mo >= 11 ? '2026' : '2027');
              dates.add(`${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`);
            }
          }
        }
        // the note sits in the hotel columns of this block, to the right
        for (let c = col; c < Math.min(col + 22, sheet.maxCol + 1); c++) {
          const x = sheet.get(r, c);
          if (x && NOTE.test(String(x.text))) restricted = true;
        }
      }
      for (const date of dates) blocks.push({ sheet: sheet.name, country, date, restricted });
    }
  }
}

// one verdict per (country, date): restricted if ANY product that day is
const byKey = new Map();
for (const b of blocks) {
  if (!b.country) continue;
  const k = b.country + '|' + b.date;
  byKey.set(k, (byKey.get(k) || false) || b.restricted);
}

const open = {}, restricted = {};
for (const [k, isRestricted] of [...byKey].sort()) {
  const [country, date] = k.split('|');
  const bucket = isRestricted ? restricted : open;
  (bucket[country] = bucket[country] || []).push(date);
}

const out = {
  _comment: 'תאריכים שבהם חלה ההגבלה "מכירת התחייבויות בלבד" (restricted) מול תאריכים חופשיים ממנה (open). בתאריך חופשי אפשר להציע גם מלונות שאינם בקובץ — בכפוף לכך שהטיסה לא מלאה ולאישור מול המלון, ושני אלה אינם ידועים מהקובץ.',
  _rule_he: 'תאריך ללא התחייבות = הטיסה למדינה ולשדה אינה מלאה ולא רשום "מכירת התחייבויות בלבד". תומר, 23/08/2026.',
  restricted, open,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

console.log('wrote data/restrictions.json');
for (const c of ['austria', 'france', 'andorra', 'bulgaria']) {
  console.log(` ${c.padEnd(9)} מוגבל: ${(restricted[c] || []).length}  חופשי: ${(open[c] || []).length}`);
  if ((open[c] || []).length) console.log(`   תאריכים חופשיים: ${open[c].join(', ')}`);
}
