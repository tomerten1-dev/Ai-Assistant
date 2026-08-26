'use strict';
/* Widget behaviour in a real browser. Not part of `npm test` (needs Playwright
   and a running server) — run with: npm start, then `npm run test:ui`.
   Covers the session rules: a reload resumes, "שיחה חדשה" clears, a new build
   never replays an old conversation, and ?pwreset forces a clean chat. */
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('widget: skipped (playwright not installed)'); process.exit(0); }

const PORT = 8802;
const SHADOW = "[...document.querySelectorAll('*')].find(e=>e.shadowRoot&&e.shadowRoot.querySelector('.fab')).shadowRoot";
const count = p => p.evaluate(`${SHADOW}.querySelectorAll('.m').length`);

function startServer() {
  return new Promise((resolve, reject) => {
    const s = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
      env: { ...process.env, PORT: String(PORT), CHAT_LOG: 'off', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    s.stdout.on('data', d => { out += d; if (out.includes('http://localhost')) resolve(s); });
    s.on('exit', c => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('✗', name, '\n  ', e.message); } };
  const srv = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const URL = `http://127.0.0.1:${PORT}/`;
  try {
    await page.goto(URL);
    await page.evaluate(`${SHADOW}.querySelector('.fab').click()`);
    await page.waitForTimeout(300);
    await page.evaluate(`{const r=${SHADOW};r.querySelector('textarea').value='זוג בפברואר';r.querySelector('.send').click();}`);
    await page.waitForTimeout(2500);
    const talking = await count(page);
    t('a conversation renders', () => assert.ok(talking >= 3, 'messages: ' + talking));

    await page.reload(); await page.waitForTimeout(1200);
    const afterReload = await count(page);
    t('a reload resumes the same conversation', () => assert.strictEqual(afterReload, talking));

    await page.evaluate(`${SHADOW}.querySelector('.newc').click()`);
    await page.waitForTimeout(400);
    const afterReset = await count(page);
    t('"שיחה חדשה" leaves only the greeting', () => assert.strictEqual(afterReset, 1));

    await page.reload(); await page.waitForTimeout(1000);
    const afterResetReload = await count(page);
    t('the cleared chat stays cleared across a reload', () => assert.strictEqual(afterResetReload, 1));

    await page.evaluate(`sessionStorage.setItem('pingwin_bot_session_v1', JSON.stringify({build:'stale',messages:[{role:'user',content:'x'}],booted:true,open:true,log:[{t:'user',v:'x'}]}))`);
    await page.reload(); await page.waitForTimeout(1000);
    const afterStale = await count(page);
    t('a session from an older build is not replayed', () => assert.strictEqual(afterStale, 0));

    await page.goto(URL + '?pwreset=1'); await page.waitForTimeout(800);
    const stored = await page.evaluate(`sessionStorage.getItem('pingwin_bot_session_v1')`);
    t('?pwreset clears the stored session', () => assert.strictEqual(stored, null));

    t('no page errors', () => assert.deepStrictEqual(errors, []));
  } finally {
    await browser.close(); srv.kill();
  }
  console.log(`widget: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
