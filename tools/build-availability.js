// BUILD STEP (server side): xlsm → data/availability.json
// Only FREE units are emitted, aggregated by (hotel, date, room_type, occupancy)
// with a count — individual sold/reserved rows never leave the parser.
//
// PII GATE: the build FAILS (exit 1) if the output contains a Hebrew character
// in any room/hotel field or any 6-digit sequence anywhere (spec section 2a).
const fs = require('fs');
const path = require('path');
const { parseInventory, stats } = require('../data/inventory.js');

const SRC = process.argv[2] || path.join(__dirname, '..', 'source-data', 'commitments-winter-2027.xlsm');
const OUT = path.join(__dirname, '..', 'data', 'availability.json');

const rows = parseInventory(SRC);
const st = stats(rows);

// aggregate free units
const map = new Map();
for (const r of rows) {
  if (r.status !== 'free') continue;
  const key = [r.sheet, r.hotel, r.date, r.room, r.occ_notation].join('||');
  if (!map.has(key)) {
    map.set(key, {
      sheet: r.sheet, hotel: r.hotel, country: r.country,
      date: r.date, date_label: r.date_label, nights: r.nights,
      room: r.room, room_type: r.room_type,
      occ_min: r.occ_min, occ_max: r.occ_max, occ_notation: r.occ_notation,
      needs_hotel_rule: r.needs_hotel_rule,
      count: 0,
    });
  }
  map.get(key).count++;
}
const units = [...map.values()].sort((a, b) =>
  a.date.localeCompare(b.date) || a.hotel.localeCompare(b.hotel) || a.room.localeCompare(b.room));

const out = {
  generated_note: 'derived from commitments workbook — free units only, PII stripped',
  season: { first_date: st.firstDate, last_date: st.lastDate },
  source_stats: { parsed_rows: st.total, free_rows: st.status.free || 0 },
  // when the workbook was read. Everything downstream — the staleness rule,
  // the alert, the line the customer sees — hangs off this one field.
  generated_at: new Date().toISOString(),
  units,
};

/* ---------- PII gate ---------- */
// the same check the server runs on whatever it is handed — one file, so the
// two can never drift apart (data/pii-gate.js)
const problems = require('../data/pii-gate.js').check(out);
const json = JSON.stringify(out, null, 1);

if (problems.length) {
  console.error('PII GATE FAILED — output NOT written:');
  for (const p of problems.slice(0, 20)) console.error('  ', p);
  process.exit(1);
}

fs.writeFileSync(OUT, json);
console.log('PII gate: CLEAN');
console.log('wrote', OUT, '—', units.length, 'aggregated unit groups,',
  units.reduce((n, u) => n + u.count, 0), 'free rooms');
