'use strict';
/* The weekly pass over real conversations — one screen, no spreadsheet.
 *
 *   npm run review                — today
 *   npm run review -- 2026-09-03  — a particular day
 *   npm run review -- --days=7    — the last week
 *
 * Three questions it answers, in the order they matter:
 *   1. What did customers say that the bot could not use?   (not_understood)
 *   2. Which answers did customers thumb DOWN?              (feedback.jsonl)
 *   3. Which leads never reached the CRM?                   (leads-undelivered)
 *
 * Every defect in this project so far was found by a person reading a reply.
 * This is that, made cheap enough to do every week.
 */
const fs = require('fs');
const path = require('path');
const chatLog = require('../server/conversation-log.js');

const args = process.argv.slice(2);
const daysBack = +(String(args.find(a => /^--days=/.test(a)) || '').split('=')[1] || 1);
const dayArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

function daysToRead() {
  if (dayArg) return [dayArg];
  const out = [];
  for (let i = 0; i < Math.max(1, daysBack); i++) {
    out.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  return out.reverse();
}

const rows = [];
for (const d of daysToRead()) for (const r of chatLog.read(d)) rows.push(r);

const H = s => '\n[1m' + s + '[0m';
const dim = s => '[2m' + s + '[0m';
const clip = (s, n) => (String(s || '').replace(/\n/g, ' ⏎ ').slice(0, n));

if (!rows.length) {
  console.log('אין שיחות ביומן לתקופה הזו (' + daysToRead().join(', ') + ').');
} else {
  const convos = new Set(rows.map(r => r.cid));
  const offers = rows.filter(r => r.signals.offers > 0).length;
  const lost = rows.filter(r => r.signals.not_understood);
  const dead = rows.filter(r => r.signals.dead_end);
  const model = rows.filter(r => r.model).length;

  console.log(H('סיכום'));
  console.log(`  ${rows.length} תורים ב-${convos.size} שיחות · ${offers} תורים עם הצעות · ` +
    `${model} קריאות למודל · ${lost.length} לא הובנו · ${dead.length} בלי תוצאה`);

  if (lost.length) {
    console.log(H('לא הובן — מה שלקוחות כתבו והבוט לא ידע לעשות איתו'));
    for (const r of lost.slice(0, 25)) {
      console.log(`  ${dim(r.at.slice(11, 16))} "${clip(r.user, 90)}"`);
    }
    if (lost.length > 25) console.log(dim(`  …ועוד ${lost.length - 25}`));
  }

  if (dead.length) {
    console.log(H('בלי תוצאה — חיפושים שלא החזירו כלום'));
    const seen = new Set();
    for (const r of dead) {
      const k = JSON.stringify(r.slots);
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`  ${dim(r.at.slice(11, 16))} ${clip(JSON.stringify(r.slots), 110)}`);
      if (seen.size >= 15) break;
    }
  }
}

/* ---------- thumbs, from the widget ---------- */
function readJsonl(name) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'server-data', name), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

const fb = readJsonl('feedback.jsonl');
if (fb.length) {
  const up = fb.filter(f => f.vote === 'up').length;
  const down = fb.filter(f => f.vote === 'down');
  console.log(H(`פידבק מלקוחות — ${up} 👍 · ${down.length} 👎`));
  for (const f of down.slice(-15)) {
    console.log(`  ${dim(f.at.slice(0, 16).replace('T', ' '))} [${f.conversationId || '?'}]`);
    console.log(`    ${clip(f.reply, 150)}`);
  }
  if (!down.length) console.log(dim('  אף לקוח לא סימן 👎 — אין מה לתקן כאן.'));
}

/* ---------- leads that never reached the CRM ---------- */
const stuck = readJsonl('leads-undelivered.jsonl');
if (stuck.length) {
  console.log(H(`⚠ ${stuck.length} לידים לא הגיעו ל-CRM`));
  for (const q of stuck.slice(0, 15)) {
    const r = q.record || {};
    console.log(`  ${dim(String(q.at).slice(0, 16).replace('T', ' '))} ${r.id} — ${q.error}`);
  }
  console.log(dim('  לשליחה חוזרת: npm run leads:retry'));
}
console.log('');
