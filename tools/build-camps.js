// BUILD STEP (server side): escort/kids-club workbooks → data/camps.json
// The source files contain CHILDREN'S PII (names, docket numbers) — nothing
// but aggregate seat counts ever leaves this script. PII gate at the end.
//
// Model (Tomer, 23/08/2026):
// - regular camp = ages 6-13, split internally into level groups
//   (מתחילים / רמה 1 / רמה בינונית); the popular one, runs most weeks
// - ages 4-6 camp opens ONLY on specific dates (its own group header)
// - empty numbered row inside a group = seat that can be offered
//   (customer not committed until final approval + confirmation email)
// - "בתאריך זה לא מוצעות קייטנות" = no camp that week
// - camps exist in exactly 4 resorts: Mayrhofen, Les 2 Alpes, Tignes, Bansko
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('../tools/xlsx-read.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'camps.json');

const FILES = [
  { file: 'camps-austria.xlsx', resort: () => 'Mayrhofen', country: 'austria' },
  { file: 'camps-france.xlsx', resort: n => (n.includes('טין') ? 'Tignes' : 'Les 2 Alpes'), country: 'france' },
  { file: 'camps-bansko-sun-thu.xlsx', resort: () => 'Bansko', country: 'bulgaria' },
  { file: 'camps-bansko-fri.xlsx', resort: () => 'Bansko', country: 'bulgaria' },
];

/* sheet name → ISO departure date (winter 26/27). Returns null to skip sheet. */
function sheetDate(name) {
  const n = name.trim();
  // Bansko legacy sheets from a past season: "05.01".."15.03" (no day word,
  // no year) — Tomer 23/08: ignore them. Real bansko sheets carry a day word.
  if (/^\d{2}\.\d{2}$/.test(n)) return null;
  // "09.01.27" / "20.03.27 פורים"
  let m = n.match(/^(\d{1,2})\.(\d{1,2})\.27/);
  if (m) return `2027-${pad(m[2])}-${pad(m[1])}`;
  // "לה דוז 2.1" / "טין 20.3" / "ראשון 10.1" / "שישי 8.1" / "חמישי 7.1" / "טין חנוכה 5.12"
  m = n.match(/(\d{1,2})\.(\d{1,2})\s*$/);
  if (m) {
    const month = +m[2];
    const year = month >= 11 ? 2026 : 2027;
    return `${year}-${pad(m[2])}-${pad(m[1])}`;
  }
  return null;
}
function pad(x) { return String(x).padStart(2, '0'); }

function classifyGroup(header) {
  const h = header.replace(/\s+/g, ' ');
  const isWait = /המתנה/.test(h);
  const age = /4\s*-\s*6/.test(h) ? '4-6' : '6-13';
  let level = null;
  if (/מתחילים/.test(h)) level = 'beginners';
  else if (/בינונ/.test(h)) level = 'intermediate';
  else if (/רמה 1/.test(h)) level = 'level1';
  const min = (h.match(/מינימום (\d+)/) || [])[1];
  return { age_group: age, level, is_waitlist: isWait, min_children: min ? +min : null };
}

const weeks = new Map(); // resort|date -> {resort,country,date,groups:[],no_camp}
let piiRows = 0;

for (const src of FILES) {
  const wb = readWorkbook(path.join(ROOT, 'source-data', src.file));
  for (const sheet of wb) {
    const date = sheetDate(sheet.name);
    if (!date) continue;
    const resort = src.resort(sheet.name);
    const key = resort + '|' + date;
    if (!weeks.has(key)) weeks.set(key, { resort, country: src.country, week: date, groups: [], no_camp: false });
    const entry = weeks.get(key);

    let current = null;
    for (let r = 1; r <= sheet.maxRow; r++) {
      const c1 = sheet.get(r, 1);
      const t1 = c1 ? c1.text : '';
      if (/לא מוצעות קייטנות|לא מתקיימת קייטנה/.test(rowText(sheet, r))) { entry.no_camp = true; }
      if (/קבוצ|רשימת המתנה/.test(t1) && !/^\d+$/.test(t1) && t1.length > 6) {
        current = { header: t1.replace(/\b3\d{5}\b/g, '').replace(/\s+/g, ' ').trim(), ...classifyGroup(t1), capacity: 0, taken: 0 };
        entry.groups.push(current);
        continue;
      }
      if (current && /^\d{1,2}$/.test(t1)) {
        current.capacity++;
        const docket = sheet.get(r, 2), name = sheet.get(r, 3);
        const has = (docket && docket.text) || (name && name.text && !/לא מוצעות/.test(name.text));
        if (has) { current.taken++; piiRows++; }
      }
    }
  }
}

function rowText(sheet, r) {
  let s = '';
  for (let c = 1; c <= sheet.maxCol; c++) { const cell = sheet.get(r, c); if (cell && cell.text) s += cell.text + ' '; }
  return s;
}

const list = [...weeks.values()]
  .map(w => ({
    ...w,
    groups: w.no_camp ? [] : w.groups.map(g => ({
      age_group: g.age_group, level: g.level, is_waitlist: g.is_waitlist,
      min_children: g.min_children, capacity: g.capacity,
      taken: g.taken, free: Math.max(0, g.capacity - g.taken),
    })),
  }))
  .sort((a, b) => a.week.localeCompare(b.week) || a.resort.localeCompare(b.resort));

const out = {
  _comment: 'נבנה אוטומטית מקבצי הליווי — ספירת מקומות בלבד, אפס פרטים אישיים. קבוצה רגילה = גילאי 6-13 (מחולקת לרמות); קבוצות 4-6 נפתחות רק בתאריכים ספציפיים. הלקוח לא מחויב עד אישור סופי במייל + קבלה.',
  age_policy: {
    regular: { age_min: 6, age_max: 13, note: 'הקבוצה הפופולרית, רוב השבועות' },
    young: { age_min: 4, age_max: 6, note: 'רק בשבועות שבהם מופיעה קבוצת גילאי 4-6' },
  },
  resorts: ['Mayrhofen', 'Les 2 Alpes', 'Tignes', 'Bansko'],
  weeks: list,
};

/* ---------- PII gate: no names, no dockets in the output ---------- */
const json = JSON.stringify(out, null, 1);
const leaks = [];
if (/\b3\d{5}\b/.test(json)) leaks.push('docket-like 6-digit sequence');
// Hebrew is fine here (labels), but Latin surname-like ALLCAPS pairs are not:
for (const m of json.match(/"[A-Z]{3,} [A-Z]{3,}"/g) || []) leaks.push('name-like: ' + m);
if (leaks.length) {
  console.error('PII GATE FAILED — camps.json NOT written:', leaks.slice(0, 10));
  process.exit(1);
}
fs.writeFileSync(OUT, json);

const withCamps = list.filter(w => !w.no_camp && w.groups.length);
console.log('PII gate: CLEAN (' + piiRows + ' child rows read, 0 emitted)');
console.log('wrote data/camps.json —', list.length, 'resort-weeks,', withCamps.length, 'with camps');
for (const w of list) {
  const g46 = w.groups.filter(g => g.age_group === '4-6' && !g.is_waitlist);
  const g613 = w.groups.filter(g => g.age_group === '6-13' && !g.is_waitlist);
  console.log(' ', w.week, w.resort.padEnd(12),
    w.no_camp ? 'NO CAMP' :
    `6-13: ${g613.reduce((n, g) => n + g.free, 0)}/${g613.reduce((n, g) => n + g.capacity, 0)} free` +
    (g46.length ? ` | 4-6: ${g46.reduce((n, g) => n + g.free, 0)}/${g46.reduce((n, g) => n + g.capacity, 0)} free` : ''));
}
