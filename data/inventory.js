// SERVER/BUILD ONLY — parses the commitments workbook (.xlsm).
// The raw file contains customer names + order numbers; NOTHING raw leaves
// this module. Every room text is sanitized (PII stripped) at parse time.
//
// Status mechanism: next to every hotel column there is a helper column with
// a macro formula (cellcolour*) whose CACHED VALUE is the Excel ColorIndex of
// the room cell. We use that cached code as primary status signal and
// cross-check with the cell's actual fill RGB + text rules.
const path = require('path');
const { readWorkbook, readWorkbookFiles } = require('../tools/xlsx-read.js');

/* ================= sheet configuration ================= */
// nights per product family (spec 3.4 — pending Tomer's confirmation)
const SHEETS = {
  'מאיירהופן':                { country: 'austria',  nights: () => 7 },
  'אישגיל':                   { country: 'austria',  nights: () => 7 },
  'ואל טורנס':                { country: 'france',   nights: () => 7 },
  'בלמברה (שבת)':             { country: 'france',   nights: () => 7 },
  'Odalys+Ynycio':            { country: 'france',   nights: () => 7 },
  'קלאב סוליי VCS':           { country: 'france',   nights: () => 7 },
  'צרפת יום ראשון':           { country: 'france',   nights: () => 7 },
  'חנוכה בלמברה טין 5-12.12': { country: 'france',   nights: () => 7, special: 'hanukkah' },
  'אנדורה':                   { country: 'andorra',  nights: () => 7 },
  'בולגריה שבועי שישי':       { country: 'bulgaria', nights: () => 7 },
  'בולגריה סופ"ש שישי-שלישי': { country: 'bulgaria', nights: () => 4 },
  'בולגריה סופ"ש שישי-רביעי': { country: 'bulgaria', nights: () => 5 },
  // Sunday departure = 4 nights, Thursday departure = 3 nights
  'בולגריה ראשון+חמישי':      { country: 'bulgaria', nights: iso => (isoWeekday(iso) === 4 ? 3 : 4) },
};

/* ================= helpers ================= */
function isoWeekday(iso) { // 0=Sun..6=Sat (UTC)
  return new Date(iso + 'T00:00:00Z').getUTCDay();
}

const ORDER_RE = /\b3\d{5}\b/;          // order numbers: 34xxxx (spec: 6 digits starting with 3)
const HEBREW_RE = /[֐-׿]/;

// Hebrew tokens that are NOT customer names (channel notes / status words)
const HEBREW_NON_NAME = new Set(['ישיר', 'שמור', 'עמותת', 'שבט', 'ארז']);
// NOTE: 'ארז' is whitelisted ONLY inside the phrase 'שמור ארז' (Bulgaria's
// alias for the shevet association). A standalone 'ארז' next to an order
// number is a customer name and is treated as such (see hasCustomerName).

const NON_ROOM_TEXTS = [
  'מכירת התחייבויות בלבד',
  'אין חדרים',
];

// date labels: "חנוכה 05/12/2026", "פורים 20/03", "21/03/2027 פורים", "27/02/2027"
function parseDateLabel(text) {
  if (!text) return null;
  if (text.includes('ואקאנס')) return { vacances: true };
  const m = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (!y) y = +mo >= 11 ? '2026' : '2027'; // winter 26/27 season
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const label = text.replace(m[0], '').replace(/[\s-]+/g, ' ').trim(); // e.g. "חנוכה", "פורים"
  return { iso, label: label || null };
}

function hasCustomerName(text) {
  // any Hebrew token that is not whitelisted; 'שמור ארז' handled via שמור
  const tokens = text.match(/[֐-׿\"']+/g) || [];
  return tokens.some(t => {
    const w = t.replace(/["']/g, '');
    return w && !HEBREW_NON_NAME.has(w);
  });
}

// strip PII from room text: order numbers + ALL Hebrew (names, notes — none of
// it belongs in the public payload). Runs on every text we keep, no exceptions.
function sanitizeRoomText(text) {
  return text
    .replace(/\b3\d{5}\b/g, '')
    .replace(/[֐-׿֑-ׇ]+/g, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// occupancy from sanitized text: "2-3" range · "4 pax" exact · "2+1"/"2+2" per-hotel
function parseOccupancy(clean) {
  // "2 bedroom apt 4-5 pax" — range wins over the leading bedroom count
  let m = clean.match(/(\d)\s*-\s*(\d)(?:\s*pax)?\b/);
  if (m) return { min: +m[1], max: +m[2], notation: `${m[1]}-${m[2]}` };
  m = clean.match(/(\d)\s*\+\s*(\d)(?:\s*pax)?\b/);
  if (m) return { min: +m[1], max: +m[1] + +m[2], notation: `${m[1]}+${m[2]}`, needsHotelRule: true };
  m = clean.match(/(\d+)\s*pax\b/i);
  if (m) return { min: +m[1], max: +m[1], notation: `${m[1]} pax` };
  if (/^SGL\b/i.test(clean)) return { min: 1, max: 1, notation: 'SGL' };
  return { min: null, max: null, notation: null };
}

function roomType(clean) {
  // type = text before the occupancy token; drop size ("27 m r") and trailing junk
  let t = clean.replace(/\d\s*[-+]\s*\d(\s*pax)?.*$/i, '')
               .replace(/\b\d+\s*pax\b.*$/i, '')
               .replace(/\b\d+\s*m\s*r?\b.*$/i, '')
               .replace(/\s+/g, ' ').trim();
  return t || clean;
}

function isNonRoom(text) {
  if (!text) return true;
  if (NON_ROOM_TEXTS.some(t => text.includes(t))) return true;
  return false;
}

/* ================= status decision =================
   free  = colorIndex 0 (white) AND no order number AND no name AND no שמור
   sold  = colored (6 yellow / 4,43 green / others) or order+name present
   reserved = text contains שמור (shevet association — never sellable)
   unknown  = color/text contradiction → excluded from results               */
function decideStatus(rawText, code, fill) {
  const reserved = rawText.includes('שמור');
  const soldByText = ORDER_RE.test(rawText) || hasCustomerName(rawText);
  if (reserved) return 'reserved';
  if (code === 0) return soldByText ? 'unknown' : 'free';
  if (code === null) return soldByText ? 'sold' : 'unknown'; // no helper cell — text only
  // gray (2/15) on a real room row = exists but not marketed via this table
  // (Tomer 23/08: "לא למכירה — פשוט לא לשווק"). Excluded from bot results.
  if (code === 2 || code === 15) return 'not_for_sale';
  // stale macro cache: helper still holds an old color but the cell itself is
  // white with no order/name (e.g. חנוכה D58, confirmed free by Tomer 23/08)
  if (fill === null && !soldByText) return 'free';
  return 'sold'; // any other non-zero color on a room row
}

/* ================= generic block parser ================= */
function parseSheet(sheet, cfg) {
  const rows = [];
  // 1. anchors: every cell whose text starts with 'תאריך יציאה'
  const anchors = [...sheet.cells.values()]
    .filter(c => c.text.startsWith('תאריך יציאה'))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  if (!anchors.length) return rows;

  const anchorCols = [...new Set(anchors.map(a => a.col))].sort((a, b) => a - b);
  const rowsByCol = new Map(); // anchor col -> sorted anchor rows
  for (const a of anchors) {
    if (!rowsByCol.has(a.col)) rowsByCol.set(a.col, []);
    rowsByCol.get(a.col).push(a.row);
  }
  for (const list of rowsByCol.values()) list.sort((a, b) => a - b);

  for (const a of anchors) {
    // horizontal extent: up to the next anchor column (or maxCol)
    const nextCol = anchorCols.find(c => c > a.col) || sheet.maxCol + 1;
    // vertical extent: down to the next anchor in the same column (or maxRow)
    const colAnchors = rowsByCol.get(a.col);
    const nextRow = colAnchors.find(r => r > a.row) || sheet.maxRow + 1;

    // hotel columns: header text present, helper column to the right holds the color code
    const hotelCols = [];
    for (let c = a.col + 1; c < nextCol; c++) {
      const h = sheet.get(a.row, c);
      if (!h || !h.text || h.text.startsWith('תאריך')) continue;
      const helper = sheet.get(a.row, c + 1);
      if (helper && (helper.formula || helper.text === '44')) {
        hotelCols.push({ col: c, hotel: h.text.trim() });
      }
    }

    let lastDate = null;
    for (let r = a.row + 1; r < nextRow; r++) {
      const dc = sheet.get(r, a.col);
      let dateISO = null, dateLabel = null, vacances = false;
      if (dc && (dc.dateISO || dc.text)) {
        if (dc.dateISO) { dateISO = dc.dateISO; }
        else {
          const p = parseDateLabel(dc.text);
          if (p && p.vacances) vacances = true;
          else if (p) { dateISO = p.iso; dateLabel = p.label; }
        }
        if (dateISO) lastDate = { iso: dateISO, label: dateLabel };
      } else if (lastDate) { dateISO = lastDate.iso; dateLabel = lastDate.label; }
      if (vacances) continue;              // פינגווין לא מוכרת בתאריכי ואקאנס
      if (!dateISO) continue;

      for (const hc of hotelCols) {
        const cell = sheet.get(r, hc.col);
        if (!cell || !cell.text) continue;
        const raw = cell.text;
        if (raw.includes('ואקאנס')) continue;
        if (isNonRoom(raw)) continue;
        const helper = sheet.get(r, hc.col + 1);
        const code = helper && helper.text !== '' && helper.formula ? +helper.text : null;
        // NOTE: code 44 (orange) is NOT only block headers — Bulgaria marks
        // "שמור ארז" rooms orange too. Header rows never reach this loop
        // (anchor rows are excluded), so no code-based header skip here.
        const clean = sanitizeRoomText(raw);
        if (!clean && !HEBREW_RE.test(raw)) continue;
        if (/^[-\d\s.]*$/.test(clean)) continue;          // junk: '-', bare numbers
        if (clean === hc.hotel) continue;                 // repeated in-block header row
        const occ = parseOccupancy(clean);
        // orange banner cells that aren't rooms (e.g. hotel-rename notes) —
        // but orange ROOMS exist too ("Appt 1 bedroom שמור ארז"), so only drop
        // when the text carries no room vocabulary and no שמור
        if (code === 44 && occ.notation == null && !raw.includes('שמור') &&
            !/(dbl|twin|sgl|suite|apt|appt|bedroom|bdrm|studio|premium|classic|deluxe|standard|family)/i.test(clean)) continue;
        const status = decideStatus(raw, Number.isFinite(code) ? code : null, cell.fillRgb);
        rows.push({
          sheet: sheet.name, hotel: hc.hotel,
          date: dateISO, date_label: dateLabel,
          nights: cfg.nights(dateISO), country: cfg.country,
          room: clean, room_type: roomType(clean),
          occ_min: occ.min, occ_max: occ.max, occ_notation: occ.notation,
          needs_hotel_rule: !!occ.needsHotelRule,
          status, color_code: code, fill: cell.fillRgb,
        });
      }
    }
  }
  return rows;
}

/* ================= special: חנוכה בלמברה טין =================
   Single fixed departure (05/12/2026, 7 nights) at Belambra Tignes Val Claret.
   Layout: column groups of (text col, color-code col); each group headed by a
   room-type banner + inventory-code row, then one row per unit.               */
function parseHanukkahSheet(sheet, cfg) {
  const rows = [];
  const DATE = '2026-12-05';
  const HOTEL = 'Belambra Tignes Val Claret';
  // column groups = every column whose right neighbor holds the code formula
  const groups = new Set();
  for (const c of sheet.cells.values()) if (c.formula) groups.add(c.col - 1);
  for (const col of [...groups].sort((a, b) => a - b)) {
    for (let r = 1; r <= sheet.maxRow; r++) {
      const cell = sheet.get(r, col);
      if (!cell || !cell.text) continue;
      const raw = cell.text;
      const helper = sheet.get(r, col + 1);
      const code = helper && helper.formula && helper.text !== '' ? +helper.text : null;
      if (code === 19) continue;                          // inventory-code rows
      if (isNonRoom(raw) || raw.includes('חנוכה')) continue;
      const clean = sanitizeRoomText(raw);
      const occ = parseOccupancy(clean);
      if (occ.min == null && !/\bCONN\b/i.test(clean)) continue; // type banners have no pax
      // code 44 here is either a stale-cache room (D58) or a yellow-filled
      // room with a stale code (J49) — both are real rooms, decided by fill+text
      const status = decideStatus(raw, Number.isFinite(code) ? code : null, cell.fillRgb);
      rows.push({
        sheet: sheet.name, hotel: HOTEL,
        date: DATE, date_label: 'חנוכה',
        nights: cfg.nights(DATE), country: cfg.country,
        room: clean, room_type: roomType(clean),
        occ_min: occ.min, occ_max: occ.max, occ_notation: occ.notation,
        needs_hotel_rule: !!occ.needsHotelRule,
        status, color_code: code, fill: cell.fillRgb,
      });
    }
  }
  return rows;
}

/* ================= entry point ================= */
function parseInventory(xlsmPath) {
  return parseWorkbook(readWorkbook(xlsmPath));
}

// The same parse, from an already-unzipped workbook. This is the entry point
// the browser uses (public/inventory-upload.html): the office can turn the
// workbook into free-room counts without installing anything and without the
// file leaving the machine.
function parseWorkbookFiles(files) {
  return parseWorkbook(readWorkbookFiles(files));
}

function parseWorkbook(wb) {
  const all = [];
  for (const sheet of wb) {
    const cfg = SHEETS[sheet.name];
    if (!cfg) { console.warn('unknown sheet, skipped:', sheet.name); continue; }
    const rows = cfg.special === 'hanukkah'
      ? parseHanukkahSheet(sheet, cfg)
      : parseSheet(sheet, cfg);
    all.push(...rows);
  }
  return all;
}

function stats(rows) {
  const by = k => rows.reduce((m, r) => (m[r[k]] = (m[r[k]] || 0) + 1, m), {});
  const dates = [...new Set(rows.map(r => r.date))].sort();
  return {
    total: rows.length,
    status: by('status'),
    hotels: new Set(rows.map(r => r.sheet + '|' + r.hotel)).size,
    hotelNames: new Set(rows.map(r => r.hotel)).size,
    departureDates: dates.length,
    firstDate: dates[0], lastDate: dates[dates.length - 1],
    bySheet: by('sheet'),
  };
}

module.exports = { parseInventory, parseWorkbookFiles, stats, sanitizeRoomText, parseOccupancy, parseDateLabel };

if (require.main === module) {
  const p = process.argv[2] || path.join(__dirname, '..', 'source-data', 'commitments-winter-2027.xlsm');
  const rows = parseInventory(p);
  console.log(JSON.stringify(stats(rows), null, 2));
}
