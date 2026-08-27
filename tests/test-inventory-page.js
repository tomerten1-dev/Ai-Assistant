'use strict';
/* The office updates the inventory from a browser, with nothing installed.
 *
 * This drives the real page in a real Chrome with the REAL workbook, and the
 * question it answers is the only one that matters: does a workbook parsed in
 * the browser produce exactly what the server-side build produces? If the two
 * ever disagree, whichever one Pingwin happened to use that morning decides
 * what the bot sells.
 *
 * Run: node tests/test-inventory-page.js   (skipped without playwright or the
 * workbook, which is gitignored — it has customers' names in it)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('inventory-page: skipped (playwright not installed)'); process.exit(0); }

const WB = path.join(__dirname, '..', 'source-data', 'commitments-winter-2027.xlsm');
if (!fs.existsSync(WB)) { console.log('inventory-page: skipped (no workbook)'); process.exit(0); }

const PORT = 8833;
const TOKEN = 'page-test-token-0123456789';
const AV = path.join(__dirname, '..', 'data', 'availability.json');

(async () => {
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

  const original = fs.readFileSync(AV, 'utf8');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CHAT_LOG: 'off', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
      SITE_ROOMS: 'off', INVENTORY_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, no) => {
    let out = ''; srv.stdout.on('data', d => { out += d; if (out.includes('http://localhost')) ok(); });
    setTimeout(() => no(new Error('server did not start')), 8000);
  });

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  let seen = null;
  // whatever the page sends is captured here — this is what leaves the machine
  await page.route('**/api/inventory', async r => {
    if (r.request().method() === 'POST') seen = JSON.parse(r.request().postData() || '{}');
    return r.continue();
  });

  try {
    await page.goto(`http://127.0.0.1:${PORT}/inventory`);
    await page.setInputFiles('#file', WB);
    await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    const view = await page.evaluate(`(() => ({
      steps: [...document.querySelectorAll('.step')].map(s => s.className.trim() + '|' + s.textContent.trim()),
      counts: document.getElementById('counts').textContent,
      rows: document.querySelectorAll('#preview tr').length,
      sendDisabled: document.getElementById('send').disabled,
    }))()`);

    t('the file is parsed in the browser, with nothing installed', () => {
      // the tick from the icon lands in textContent before the label
      assert.ok(view.steps.some(s => /^step ok\|.?פוענח/.test(s)), view.steps.join('\n'));
      assert.ok(!view.steps.some(s => s.startsWith('step bad')), view.steps.join('\n'));
    });
    t('and the PII gate runs there too, before anything can be sent', () => {
      assert.ok(view.steps.some(s => /בדיקת מידע אישי: נקי/.test(s)), view.steps.join('\n'));
    });
    t('you see what will be sent before you send it', () => {
      assert.ok(view.rows > 1, 'no preview table');
      assert.ok(/חדרים פנויים/.test(view.counts));
      assert.ok(view.sendDisabled, 'the send button was live before a key was typed');
    });

    // ── the whole point ──
    const { parseInventory, stats } = require('../data/inventory.js');
    const { toAvailability } = require('../data/aggregate.js');
    const fixed = new Date('2020-01-01T00:00:00.000Z');
    const here = toAvailability(parseInventory(WB), stats(parseInventory(WB)), fixed);

    await page.fill('#token', TOKEN);
    await page.click('#send');
    await page.waitForSelector('#sent.ok, #sent.bad', { timeout: 30000 });
    const sentText = await page.textContent('#sent');

    t('the server accepts what the browser produced', () => {
      assert.ok(/עודכן/.test(sentText), sentText);
    });
    t('and it is byte-for-byte what the build would have produced', () => {
      assert.ok(seen, 'nothing was posted');
      const a = { ...here, generated_at: null };
      const b = { ...seen, generated_at: null };
      assert.strictEqual(JSON.stringify(b), JSON.stringify(a),
        `browser ${seen.units.length} units / ${seen.units.reduce((n, u) => n + u.count, 0)} rooms, ` +
        `build ${here.units.length} / ${here.units.reduce((n, u) => n + u.count, 0)}`);
    });
    t('the workbook itself never left the machine', () => {
      // what was posted is the stripped list — no Hebrew room names, no long
      // digit runs, and nothing remotely the size of a 260KB spreadsheet
      assert.deepStrictEqual(require('../data/pii-gate.js').check(seen), []);
      assert.ok(JSON.stringify(seen).length < fs.statSync(WB).size * 2);
      assert.ok(!('file' in seen) && !('workbook' in seen));
    });
    t('no page errors', () => assert.deepStrictEqual(errors, []));
  } finally {
    await browser.close(); srv.kill();
    fs.writeFileSync(AV, original);
  }
  console.log(`inventory-page: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
