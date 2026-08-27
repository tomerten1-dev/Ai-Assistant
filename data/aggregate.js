'use strict';
// rows from the workbook → data/availability.json
//
// One function, because it runs in two places and the two must agree exactly:
// tools/build-availability.js on a machine with node, and the browser page the
// office uses when there is no node and no permission to install one
// (public/inventory-upload.html). If these ever diverge, whichever one Pingwin
// happened to use that morning decides what the bot sells.
//
// Only FREE rooms are emitted, grouped by (hotel, date, room, occupancy) with a
// count. Individual sold or reserved rows — the ones carrying a customer's name
// — never survive this step.
function toAvailability(rows, st, now) {
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

  return {
    generated_note: 'derived from commitments workbook — free units only, PII stripped',
    season: { first_date: st.firstDate, last_date: st.lastDate },
    source_stats: { parsed_rows: st.total, free_rows: st.status.free || 0 },
    // when the workbook was read. Everything downstream — the staleness rule,
    // the alert, the line the customer sees — hangs off this one field.
    generated_at: (now || new Date()).toISOString(),
    units,
  };
}
module.exports = { toAvailability };
