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

// the same aggregation the browser page runs (data/aggregate.js) — one
// function, so a workbook parsed in Chrome and one parsed here cannot disagree
const out = require('../data/aggregate.js').toAvailability(rows, st);
const units = out.units;

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
