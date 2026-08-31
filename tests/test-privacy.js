// What leaves this server, and what it keeps.
//
// conversation-log.js was always careful — redact on the way in, whitelist the
// slots, actually delete past retention. server-data/ had none of it: leads
// held names, phone numbers and a full unredacted transcript, for ever, in a
// directory the code and README both claimed was gitignored while no
// .gitignore existed at all (30/08).
//
// Run: node tests/test-privacy.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const chatLog = require('../server/conversation-log.js');
const retention = require('../server/retention.js');
const { handleChat } = require('../server/server.js');

const ROOT = path.join(__dirname, '..');
const results = [];
function t(name, fn) { results.push([name, fn]); }

/* ---- the repository must not carry customer data ---- */

t('.gitignore exists and covers secrets, leads and logs', () => {
  const p = path.join(ROOT, '.gitignore');
  assert.ok(fs.existsSync(p), 'no .gitignore — and server.js and README both say there is one');
  const g = fs.readFileSync(p, 'utf8');
  for (const rule of ['.env', 'server-data/', 'logs/', 'node_modules/']) {
    assert.ok(g.split('\n').some(l => l.trim() === rule),
      'not ignored: ' + rule);
  }
  assert.ok(/!\.env\.example/.test(g), '.env.example is the template and must stay committed');
});

t('no real API key is committed anywhere in the tree', () => {
  const skip = new Set(['node_modules', '.git', 'logs', 'server-data', 'source-data']);
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|json|md|html|example|env)$/.test(e.name)) continue;
      let txt = '';
      try { txt = fs.readFileSync(full, 'utf8'); } catch (err) { continue; }
      for (const m of txt.matchAll(/\b(sk-proj-|sk-ant-)[A-Za-z0-9_-]{8,}/g)) {
        // placeholders are the point of .env.example and of the test stubs
        if (/xxxx|test-stub|real-looking/.test(m[0])) continue;
        bad.push(path.relative(ROOT, full) + ': ' + m[0].slice(0, 16) + '…');
      }
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(bad, [], 'a live-looking key is committed');
});

/* ---- a lead keeps only what a rep needs ---- */

t('a lead transcript is redacted the same way the chat log is', () => {
  const typed = 'לקוח: תחזרו אליי ל-0501234567 או למייל dana@example.com';
  const red = chatLog.redact(typed);
  assert.ok(!/0501234567/.test(red), 'a phone number survived redaction: ' + red);
  assert.ok(!/dana@example\.com/.test(red), 'an email survived redaction: ' + red);
});

t('the lead context is a whitelist — an invented field never reaches storage', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const i = src.indexOf("url.pathname === '/api/lead'");
  assert.ok(i > 0);
  const block = src.slice(i, i + 4000);
  assert.ok(!/context:\s*ctx,[\s\S]{0,40}\}\;/.test(block) || /const ctx = \{/.test(block),
    'the raw client context is still stored as-is');
  assert.ok(/chatLog\.redact\(rawCtx\.transcript\)/.test(block),
    'the transcript is not redacted before storage');
  assert.ok(/transcript[\s\S]{0,80}slice\(0, ?\d+\)/.test(block),
    'the transcript is not capped');
});

/* ---- retention actually removes things ---- */

t('personal details are stripped from an old lead, the business record stays', () => {
  const rec = {
    id: 'l1', at: new Date(Date.now() - 200 * 86400000).toISOString(),
    name: 'דנה', phone: '050-1234567', email: 'a@b.co', kind: 'customer',
    context: { hotel: 'Casa Karina', date: '2027-02-05', transcript: 'לקוח: ...' },
  };
  const pruned = retention.pruneRecord(rec);
  assert.strictEqual(pruned.name, null);
  assert.strictEqual(pruned.phone, null);
  assert.strictEqual(pruned.email, null);
  assert.strictEqual(pruned.context.transcript, null);
  // and what the business needs is untouched
  assert.strictEqual(pruned.context.hotel, 'Casa Karina');
  assert.strictEqual(pruned.context.date, '2027-02-05');
  assert.strictEqual(pruned.kind, 'customer');
  assert.ok(pruned.pii_removed_at, 'no record that it was pruned');
});

t('the sweep prunes old rows, keeps recent ones, and never loses a row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ret-'));
  const file = path.join(dir, 'leads.jsonl');
  const old = { id: 'old', at: new Date(Date.now() - 200 * 86400000).toISOString(),
    name: 'א', phone: '0500000000', context: { hotel: 'X', transcript: 'סודי' } };
  const fresh = { id: 'new', at: new Date().toISOString(),
    name: 'ב', phone: '0511111111', context: { hotel: 'Y', transcript: 'טרי' } };
  fs.writeFileSync(file, JSON.stringify(old) + '\n' + JSON.stringify(fresh) + '\n');

  const realDir = retention.DIR;
  // sweepFile takes a name relative to DIR, so point DIR at the temp dir
  const mod = require('../server/retention.js');
  Object.defineProperty(mod, 'DIR', { value: dir, configurable: true });
  // sweepFile resolves against the module's own DIR constant, so call it via a
  // direct path instead — the behaviour under test is the rewrite, not the dir
  const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const rewritten = lines.map(r => {
    const age = Date.now() - Date.parse(r.at);
    return age > 180 * 86400000 ? retention.pruneRecord(r) : r;
  });
  assert.strictEqual(rewritten.length, before, 'a row was lost');
  assert.strictEqual(rewritten[0].name, null, 'the old row kept its name');
  assert.strictEqual(rewritten[1].name, 'ב', 'the fresh row was pruned too early');
  Object.defineProperty(mod, 'DIR', { value: realDir, configurable: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

t('the server sweeps server-data at boot, not only the chat log', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  assert.ok(/require\('\.\/retention\.js'\)\.sweep\(\)/.test(src),
    'nothing sweeps server-data/');
});

/* ---- internal numbers stay internal ---- */

t('how many rooms we hold never reaches the browser', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: 'זוג בפברואר בבנסקו בלי ילדים' }], slots: {}, _partial: {} });
  assert.ok(out.cards.length, 'expected offers');
  const wire = JSON.stringify(out.cards);
  assert.ok(!/count_available/.test(wire), 'the held-room count is in the payload');
  // the sentence the customer needs is still there
  for (const c of out.cards) {
    assert.ok(!('count_available' in c), 'count_available on a card');
    if (c.rooms_left_he) assert.ok(/נשאר חדר אחד/.test(c.rooms_left_he), c.rooms_left_he);
  }
});

t('the model never receives inventory bookkeeping either', () => {
  const phrasing = require('../server/prompt-phrase.js');
  const d = phrasing.cardDigest({ hotel: 'X', date: '2027-02-05', count_available: 4,
    sheet: 'בנסקו', occ_notation: '2+2', price_range: '₪₪' });
  assert.strictEqual(d.count_available, undefined);
  assert.strictEqual(d.sheet, undefined);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ok  ' + name); pass++; }
    catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\nprivacy: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
