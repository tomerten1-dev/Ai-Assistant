// The weekly pass. Prints the conversations worth reading, not all of them.
//
//   node tools/review-log.js                 today, the ones that went wrong
//   node tools/review-log.js 2026-08-24      a specific day
//   node tools/review-log.js today all       everything from today
//
// Filters: dead_end (nothing offered), deferred (sent to a rep), objection
// ("יקר לי"), widened (we had to relax something), asked (the bot questioned).
const log = require('../server/conversation-log.js');

const [, , dayArg, filterArg] = process.argv;
const day = !dayArg || dayArg === 'today' ? null : dayArg;
const filter = filterArg && filterArg !== 'all' ? filterArg : null;

const rows = log.read(day, filter);
if (!rows.length) {
  console.log('אין שיחות ביום הזה (' + log.file(day ? new Date(day) : new Date()) + ')');
  process.exit(0);
}

// group by conversation so a turn is read in context, never alone
const byConv = new Map();
for (const r of rows) {
  if (!byConv.has(r.cid)) byConv.set(r.cid, []);
  byConv.get(r.cid).push(r);
}

const worth = (r) => r.signals.dead_end || r.signals.deferred || r.signals.objection;
let shown = 0;

for (const [cid, turns] of byConv) {
  const flagged = turns.filter(worth);
  if (!filter && !flagged.length) continue;      // nothing went wrong here
  shown++;
  console.log('\n' + '='.repeat(66));
  console.log(cid + '  ·  ' + turns.length + ' תורות  ·  ' + turns[0].at.slice(0, 16).replace('T', ' '));
  for (const r of turns) {
    const marks = Object.entries(r.signals)
      .filter(([k, v]) => v === true && k !== 'asked')
      .map(([k]) => k);
    console.log('\n  לקוח: ' + r.user);
    console.log('  בוט : ' + r.bot.split('\n').join('\n        '));
    console.log('  → ' + (r.hotels.length ? r.hotels.join(' | ') : 'אין הצעות')
      + (marks.length ? '   [' + marks.join(', ') + ']' : ''));
  }
}

console.log('\n' + '='.repeat(66));
const all = log.read(day);
console.log(`${all.length} תורות, ${byConv.size} שיחות. ${shown} שיחות מסומנות לקריאה.`);
for (const f of ['dead_end', 'deferred', 'objection', 'widened']) {
  console.log('  ' + f.padEnd(10) + log.read(day, f).length);
}
