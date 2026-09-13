'use strict';
/* Re-send leads the CRM never received.
 *
 *   node tools/leads-retry.js          — re-send everything queued
 *   node tools/leads-retry.js --list   — show what is queued, send nothing
 *
 * The queue is server-data/leads-undelivered.jsonl, written by the server when
 * a lead's webhook fails all three attempts (the CRM was down, the URL moved,
 * a token expired). The lead itself was never lost — leads.jsonl on disk and
 * the rep's email both have it — but it is missing from the CRM, and that is
 * the kind of gap nobody notices until a customer asks why nobody called.
 *
 * Safe to run twice: every lead carries the same lead_id, so a CRM that keys on
 * it de-duplicates. Whatever still fails stays in the queue for the next run.
 */
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../server/env.js');
const crmLead = require('../server/crm-lead.js');

loadEnv();

const FILE = path.join(__dirname, '..', 'server-data', 'leads-undelivered.jsonl');
const listOnly = process.argv.includes('--list');

function read() {
  let raw = '';
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function send(record) {
  const url = process.env.LEAD_WEBHOOK_URL;
  const body = JSON.stringify(crmLead.toCrm(record));
  const headers = { 'content-type': 'application/json', 'x-lead-id': record.id,
    'x-lead-schema': crmLead.SCHEMA, 'x-lead-retry': '1' };
  if (process.env.LEAD_WEBHOOK_SECRET) {
    headers['x-signature'] = require('crypto')
      .createHmac('sha256', process.env.LEAD_WEBHOOK_SECRET).update(body).digest('hex');
  }
  const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}

(async () => {
  const queued = read();
  if (!queued.length) { console.log('אין לידים ממתינים — הכל הגיע ל-CRM.'); return; }

  console.log(`${queued.length} לידים לא הגיעו ל-CRM:`);
  for (const q of queued) {
    const r = q.record || {};
    const ctx = r.context || {};
    console.log(`  ${r.id}  ${String(q.at).slice(0, 16).replace('T', ' ')}  ` +
      `${ctx.hotel || 'ללא הצעה'}  — ${q.error}`);
  }
  if (listOnly) return;

  if (!process.env.LEAD_WEBHOOK_URL) {
    console.log('\nאין LEAD_WEBHOOK_URL ב-.env — אין לאן לשלוח. הגדירו אותו והריצו שוב.');
    process.exitCode = 1;
    return;
  }

  console.log('\nשולח שוב…');
  const stillFailing = [];
  let sent = 0;
  for (const q of queued) {
    try { await send(q.record); sent++; console.log(`  ✓ ${q.record.id}`); }
    catch (e) {
      stillFailing.push({ ...q, at: new Date().toISOString(), error: String(e.message).slice(0, 200) });
      console.log(`  ✗ ${q.record.id} — ${e.message}`);
    }
  }
  // rewrite the queue with only what is still stuck, so a second run is not a
  // second delivery of everything that already went through
  if (stillFailing.length) fs.writeFileSync(FILE, stillFailing.map(x => JSON.stringify(x)).join('\n') + '\n');
  else fs.unlinkSync(FILE);
  console.log(`\nנשלחו ${sent}, נותרו ${stillFailing.length}.`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
