// Merges data/rooms-raw.json (room-level facts scraped from pingwin.co.il —
// the only permitted content source, red rule 5) into data/resorts.json.
//
// Why this exists: the commitments workbook knows a room CODE and an occupancy
// notation, nothing else. It cannot answer "are the beds separate?", "is
// breakfast included?", "how far is the airport?". Those answers live on the
// hotel page, so we mirror them here once at build time instead of guessing at
// runtime. Nothing in this file invents content: every string is verbatim.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rawPath = path.join(ROOT, 'data', 'rooms-raw.json');
const resortsPath = path.join(ROOT, 'data', 'resorts.json');

const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const resorts = JSON.parse(fs.readFileSync(resortsPath, 'utf8'));

// --- PII gate (spec 2a). This file is public content, so it must not carry a
// customer name or an order number even by accident.
const ORDER_RE = /\d{6}/;

// Red rule 3: no numbers in money reach the customer. Two hotel pages price
// spa entry ("בתשלום של כ-20 יורו"), and that text feeds straight onto a card, so
// the figure is removed here rather than trusted to never be shown.
function stripMoney(text) {
  return String(text)
    .replace(/\s*\(?\s*כ?-?\s*\d[\d,.]*\s*(?:€|יורו|אירו|₪|ש\"?ח|שקלים?)[^)א-ת]*\)?/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}
const flat = JSON.stringify(raw);
if (ORDER_RE.test(flat)) {
  console.error('PII gate: rooms-raw.json contains a 6-digit sequence (order number?)');
  process.exit(1);
}

// What the customer is told about spa access. "not_stated" is the honest
// majority case: the page lists the facilities and says nothing about whether
// using them is included, so we say that rather than guess. An earlier scrape
// DID guess, and answered "כלול" for hotels that charge for entry.
function spaSentence(sp) {
  switch (sp.access) {
    case 'free':
      return 'הספא כלול — כניסה חופשית לאורחי המלון';
    case 'entries':
      return sp.entries + ' כניסות חופשיות לספא כלולות במחיר לאורחי פינגווין';
    case 'paid':
      return 'הכניסה לספא בתוספת תשלום במקום — נציג ימסור את העלות';
    // Tomer, 24/08: "לשימוש אורחי המלון" and "לרשות האורחים" mean free.
    // The bucket stays separate in the data because it records what the page
    // actually said, but the customer hears the same thing as 'free'.
    case 'guests':
      return 'הספא כלול — כניסה חופשית לאורחי המלון';
    default:
      return 'יש ספא במלון; דף המלון אינו מציין אם השימוש כלול — נציג יאמת מול המלון';
  }
}

const FIELDS = ['board_he', 'transfer_he', 'ski_pass_he', 'equipment_he',
                'wifi_he', 'spa_he'];

// Some Bulgarian hotel pages list a ski pass among their inclusions. Tomer's
// rule (confirmed 23/08/2026) is that the ski pass is NOT part of a Bulgarian
// package — the rule wins over the page, so the claim is dropped here rather
// than left in the data for something downstream to quote by accident.
const inclusions = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'config', 'inclusions.json'), 'utf8'));
const NO_PASS = inclusions.ski_pass.excluded_countries;

let hotels = 0, rooms = 0, missing = [], dropped = [];
for (const [name, info] of Object.entries(resorts.hotels)) {
  const r = raw.hotels[name];
  if (!r) { missing.push(name); continue; }
  for (const f of FIELDS) if (r[f]) info[f] = stripMoney(r[f]);
  // Spa access, phrased once here so every consumer says the same thing and
  // none of them has to decide. The internal cost never crosses this line.
  if (r.spa) {
    const sp = r.spa;
    // clear first: this file is merged into repeatedly, and a value left over
    // from a previous run is a claim nobody wrote
    delete info.spa_access_he; delete info.spa_note_he; delete info.spa_min_age;
    info.spa_access = sp.access;
    if (sp.access !== 'none') {
      info.spa_access_he = spaSentence(sp);
      if (sp.note_he) info.spa_note_he = sp.note_he;
      if (sp.min_age) info.spa_min_age = sp.min_age;
    } else {
      delete info.spa_he;
    }
  }
  if (NO_PASS.includes(info.country)) {
    if (info.ski_pass_he) dropped.push(name + ' (' + info.ski_pass_he + ')');
    info.ski_pass_he = null;
  }
  info.rooms = r.rooms || [];
  hotels++;
  rooms += info.rooms.length;
}

if (missing.length) {
  console.error('no room data for: ' + missing.join(', '));
  process.exit(1);
}

resorts._rooms_source = 'pingwin.co.il hotel pages, 23/08/2026 — see data/rooms-raw.json';
fs.writeFileSync(resortsPath, JSON.stringify(resorts, null, 2) + '\n');
console.log(`merged ${rooms} room types across ${hotels} hotels into data/resorts.json`);
if (dropped.length) {
  console.log('ski pass claim dropped (not included in ' + NO_PASS.join('/') + '): ' + dropped.join(', '));
}
