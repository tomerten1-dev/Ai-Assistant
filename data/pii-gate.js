'use strict';
// The one check that decides whether inventory may leave the office network.
//
// The commitments workbook has customers' names in it. data/availability.json
// is what the bot actually reads: free units only, aggregated with a count,
// nothing about who booked what. This gate is what makes that claim true, and
// it runs twice — once where the file is built (tools/build-availability.js,
// inside Pingwin's network) and again on whatever the server is handed, because
// a server that trusts its input has no gate at all.
//
// Two rules, both blunt on purpose:
//   1. No Hebrew in a hotel or room field. Every real one is Latin; a Hebrew
//      string in there means a row from the wrong column — a customer's name.
//   2. No run of six or more digits anywhere. Phone numbers, ID numbers and
//      booking references all look like that; nothing we legitimately publish
//      does (dates are 4+2+2, prices never reach the bot at all).
function check(out) {
  const problems = [];
  const units = (out && out.units) || [];
  if (!Array.isArray(units)) return ['units is not a list'];
  for (const u of units) {
    for (const f of ['hotel', 'room', 'room_type', 'occ_notation']) {
      if (u[f] && /[֐-׿]/.test(String(u[f]))) {
        problems.push(`Hebrew in ${f}: ${JSON.stringify(u[f])}`);
      }
    }
  }
  const text = JSON.stringify(out);
  for (const hit of (text.match(/\d{6,}/g) || [])) problems.push('6+ digit sequence: ' + hit);
  return problems;
}
module.exports = { check };
