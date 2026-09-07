#!/usr/bin/env node
'use strict';
/* Rebuild data/availability.json from the commitments workbook.
   `npm run build:data` named this script and it did not exist, so there was no
   path at all from a new season's .xlsm to the file the whole bot rests on —
   and no way to verify that the free-only guarantee actually holds.

   Usage:
     node tools/build-availability.js [workbook.xlsm]        write the file
     node tools/build-availability.js --verify [workbook]    compare, write nothing

   --verify is the one to run first after a rollover, and the one worth running
   on the CURRENT season before trusting this script at all: it rebuilds in
   memory and diffs against the committed JSON, so a parser change that
   silently moves a room shows up as a diff instead of as a wrong offer.

   The rule this file exists to enforce: ONLY rows whose status is 'free' are
   written. Everything else — sold, reserved, not_for_sale, and anything whose
   cell colour could not be decoded (`unknown`) — is dropped here and can
   therefore never reach a customer. */

const fs = require('fs');
const path = require('path');
const { parseInventory, stats } = require('../data/inventory.js');
const season = require('../server/season.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'availability.json');

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const workbook = args.find(a => !a.startsWith('--')) ||
  path.join(ROOT, 'source-data', `commitments-winter-${season.endYear()}.xlsm`);

if (!fs.existsSync(workbook)) {
  console.error('workbook not found:', workbook);
  console.error('pass the path as an argument, or put it in source-data/.');
  process.exit(2);
}

/* One unit per (sheet, hotel, date, room), with a count — the workbook has one
   ROW per physical room, and the bot needs "how many of these are free". */
function build(rows) {
  const free = rows.filter(r => r.status === 'free');
  const byKey = new Map();
  for (const r of free) {
    const key = [r.sheet, r.hotel, r.date, r.room].join('||');
    const found = byKey.get(key);
    if (found) { found.count++; continue; }
    byKey.set(key, {
      sheet: r.sheet, hotel: r.hotel, country: r.country,
      date: r.date, date_label: r.date_label || null, nights: r.nights,
      room: r.room, room_type: r.room_type,
      occ_min: r.occ_min, occ_max: r.occ_max, occ_notation: r.occ_notation,
      needs_hotel_rule: !!r.needs_hotel_rule,
      count: 1,
    });
  }
  const units = [...byKey.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || a.hotel.localeCompare(b.hotel) || a.room.localeCompare(b.room));
  const st = stats(rows);
  return {
    generated_note: 'נבנה מקובץ ההתחייבויות על ידי tools/build-availability.js — ' +
      'רק שורות במצב free. אין לערוך ידנית.',
    season: season.bounds(),
    source_stats: { parsed_rows: st.total, free_rows: free.length },
    units,
  };
}

const rows = parseInventory(workbook);
const built = build(rows);

/* The guarantee, asserted here rather than assumed. If any of these fail the
   file is not written: a wrong availability file is worse than a stale one. */
const problems = [];
const counted = built.units.reduce((n, u) => n + u.count, 0);
if (counted !== built.source_stats.free_rows) {
  problems.push(`grouped ${counted} units but parsed ${built.source_stats.free_rows} free rows`);
}
if (rows.some(r => r.status !== 'free' && built.units.some(u =>
  u.hotel === r.hotel && u.date === r.date && u.room === r.room && u.sheet === r.sheet &&
  !rows.some(o => o.status === 'free' && o.hotel === r.hotel && o.date === r.date && o.room === r.room && o.sheet === r.sheet)))) {
  problems.push('a non-free row reached the output');
}
for (const u of built.units) {
  if (/[֐-׿]/.test([u.hotel, u.room, u.room_type].join(''))) {
    problems.push('Hebrew text in a public field: ' + u.hotel + ' / ' + u.room);
    break;
  }
}
if (/\d{6,}/.test(JSON.stringify(built.units))) problems.push('a 6-digit sequence (order number?) reached the output');
// and the gate the server runs on a pushed file — the same code, so the two never drift
for (const p of require('../data/pii-gate.js').check(built)) if (!problems.includes(p)) problems.push(p);

if (problems.length) {
  console.error('REFUSING to write — the output failed its own checks:');
  for (const p of problems) console.error('  ✗', p);
  process.exit(1);
}

const text = JSON.stringify(built, null, 1) + '\n';

if (verify) {
  let current = null;
  try { current = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* none yet */ }
  if (!current) { console.log('no existing file to compare with'); process.exit(0); }
  const key = u => [u.sheet, u.hotel, u.date, u.room].join('||');
  const a = new Map(current.units.map(u => [key(u), u]));
  const b = new Map(built.units.map(u => [key(u), u]));
  const added = [...b.keys()].filter(k => !a.has(k));
  const removed = [...a.keys()].filter(k => !b.has(k));
  const changed = [...b.keys()].filter(k => a.has(k) && a.get(k).count !== b.get(k).count);
  console.log(`current ${current.units.length} units, rebuilt ${built.units.length}`);
  console.log(`  added   ${added.length}`);
  console.log(`  removed ${removed.length}`);
  console.log(`  count changed ${changed.length}`);
  for (const k of [...added.slice(0, 5)]) console.log('   + ' + k);
  for (const k of [...removed.slice(0, 5)]) console.log('   - ' + k);
  for (const k of changed.slice(0, 5)) console.log(`   ~ ${k}: ${a.get(k).count} → ${b.get(k).count}`);
  process.exit(added.length || removed.length || changed.length ? 1 : 0);
}

fs.writeFileSync(OUT, text);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${built.units.length} units, ` +
  `${built.source_stats.free_rows} free rows of ${built.source_stats.parsed_rows} parsed`);
