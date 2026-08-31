'use strict';
/* Retention for server-data/.

   conversation-log.js gets this right for logs/: it redacts on the way in and
   it actually DELETES past the retention window — deleting is what makes a
   retention promise real. server-data/ got none of it: leads.jsonl held names,
   phone numbers and (before 30/08) unredacted transcripts, and grew for ever.

   A lead is not a log, so it is not simply dropped after N days. It is
   *pruned*: once a lead is old enough that a rep has plainly acted on it or
   never will, the personal fields are stripped and the row is kept as a
   business record — how many leads, for which hotel, on which date. That
   keeps the reporting and removes the reason to worry about the file.

   Two knobs, both in .env:
     LEAD_PII_DAYS   how long name/phone/email/transcript are kept (default 180)
     LEAD_KEEP_DAYS  how long the pruned row itself is kept (default 0 = for ever)
*/

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'server-data');
const PII_FIELDS = ['name', 'phone', 'email'];

function num(k, d) {
  const v = +(process.env[k] || 0);
  return Number.isFinite(v) && v > 0 ? v : d;
}

function pruneRecord(rec) {
  const out = { ...rec, pii_removed_at: new Date().toISOString() };
  for (const f of PII_FIELDS) if (out[f] != null) out[f] = null;
  if (out.context && typeof out.context === 'object') {
    out.context = { ...out.context, transcript: null };
  }
  return out;
}

/* Rewrites one .jsonl in place. Returns {pruned, dropped, kept}.
   Written to a temp file and renamed, so an interrupted sweep cannot leave a
   half-written leads file — losing a lead is the one outcome worth more than
   any tidiness this buys. */
function sweepFile(name, { piiDays, keepDays, now = Date.now() }) {
  const file = path.join(DIR, name);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { pruned: 0, dropped: 0, kept: 0 }; }
  const piiCut = piiDays ? now - piiDays * 86400000 : null;
  const keepCut = keepDays ? now - keepDays * 86400000 : null;
  const out = [];
  let pruned = 0, dropped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { out.push(line); continue; }  // keep what we cannot read
    const at = Date.parse(rec.at || '') || null;
    if (!at) { out.push(line); continue; }
    if (keepCut && at < keepCut) { dropped++; continue; }
    if (piiCut && at < piiCut && !rec.pii_removed_at) {
      const hadPii = PII_FIELDS.some(f => rec[f] != null) ||
        !!(rec.context && rec.context.transcript);
      if (hadPii) { pruned++; out.push(JSON.stringify(pruneRecord(rec))); continue; }
    }
    out.push(line);
  }
  if (!pruned && !dropped) return { pruned: 0, dropped: 0, kept: out.length };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out.length ? out.join('\n') + '\n' : '');
  fs.renameSync(tmp, file);
  return { pruned, dropped, kept: out.length };
}

function sweep(opts) {
  const piiDays = (opts && opts.piiDays) != null ? opts.piiDays : num('LEAD_PII_DAYS', 180);
  const keepDays = (opts && opts.keepDays) != null ? opts.keepDays : num('LEAD_KEEP_DAYS', 0);
  const now = (opts && opts.now) || Date.now();
  const totals = { pruned: 0, dropped: 0 };
  for (const name of ['leads.jsonl', 'leads-undelivered.jsonl', 'feedback.jsonl']) {
    try {
      const r = sweepFile(name, { piiDays, keepDays, now });
      totals.pruned += r.pruned; totals.dropped += r.dropped;
    } catch (e) { /* a sweep must never take the server down */ }
  }
  if (totals.pruned || totals.dropped) {
    console.log(`retention: ${totals.pruned} leads pruned of personal details, ${totals.dropped} removed`);
  }
  return totals;
}

module.exports = { sweep, sweepFile, pruneRecord, DIR };
