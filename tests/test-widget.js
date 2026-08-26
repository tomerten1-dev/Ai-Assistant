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

    // Pingi — the character Tomer approved on 26/08. The launcher is a reception
    // desk: his face, a question, and who answers it. The red dot carries no
    // number and disappears the moment the chat is opened.
    await page.goto(URL + '?pwreset=1'); await page.waitForTimeout(700);
    const pingi = await page.evaluate(`(() => {
      const r = ${SHADOW};
      const fab = r.querySelector('.fab');
      const img = fab.querySelector('.av img');
      return {
        src: img ? img.getAttribute('src') : null,
        title: (fab.querySelector('.l1') || {}).textContent,
        sub: (fab.querySelector('.l2') || {}).textContent,
        dot: !!fab.querySelector('.dot'),
        seen: fab.classList.contains('seen'),
        headerImg: !!r.querySelector('.hdr .mark img'),
      };
    })()`);
    t('the launcher wears Pingi', () => assert.ok(/pingi\.png$/.test(pingi.src || ''), String(pingi.src)));
    t('it says what it is and who answers', () => {
      assert.ok(/לגלוש/.test(pingi.title || ''), 'title: ' + pingi.title);
      assert.ok(/פינגי/.test(pingi.sub || ''), 'sub: ' + pingi.sub);
    });
    t('the red dot is there on a first visit, and carries no number', () => {
      assert.ok(pingi.dot && !pingi.seen);
    });
    t('the chat header wears the same face', () => assert.ok(pingi.headerImg));

    await page.evaluate(`${SHADOW}.querySelector('.fab').click()`);
    await page.waitForTimeout(400);
    const after = await page.evaluate(`(() => {
      const r = ${SHADOW};
      return {
        seen: r.querySelector('.fab').classList.contains('seen'),
        greeting: (r.querySelector('.m.bot') || {}).textContent || '',
      };
    })()`);
    t('the dot goes away once the chat is opened', () => assert.ok(after.seen));
    t('Pingi introduces himself by name', () => assert.ok(/פינגי/.test(after.greeting), after.greeting.slice(0, 60)));

    // Pingi dresses for the room: on a destination page he is already on skis
    await page.goto(URL + '?pwreset=1&page=' + encodeURIComponent('חופשת סקי בצרפת'));
    await page.waitForTimeout(600);
    const outfit = await page.evaluate(`${SHADOW}.querySelector('.fab .av img').getAttribute('src')`);
    t('on a destination page the launcher wears the ski outfit', () => assert.ok(/pingi-ski\.png$/.test(outfit), String(outfit)));
    await page.evaluate(`${SHADOW}.querySelector('.fab').click()`);
    await page.waitForTimeout(400);
    const tiny = await page.evaluate(`getComputedStyle(${SHADOW}.querySelector('.m.bot'), '::before').backgroundImage`);
    t('the avatar beside every answer is Pingi in his winter clothes',
      () => assert.ok(/pingi\.png/.test(tiny) && !/plain|ski|board/.test(tiny), String(tiny)));

    // Tomer, 26/08 (screenshot): with the chat open and text typed, the window
    // grows over the same corner and Pingi floated on top of the message box.
    await page.goto(URL + '?pwreset=1'); await page.waitForTimeout(600);
    const closedState = await page.evaluate(`getComputedStyle(${SHADOW}.querySelector('.fab')).opacity`);
    await page.evaluate(`${SHADOW}.querySelector('.fab').click()`);
    await page.waitForTimeout(500);
    const openState = await page.evaluate(`(() => {
      const cs = getComputedStyle(${SHADOW}.querySelector('.fab'));
      return { opacity: cs.opacity, pointer: cs.pointerEvents };
    })()`);
    t('the launcher is out of the way while the chat is open', () => {
      assert.strictEqual(closedState, '1', 'hidden before it was opened');
      assert.strictEqual(openState.opacity, '0', 'still visible over the chat');
      assert.strictEqual(openState.pointer, 'none', 'still clickable under the chat');
    });
    // .x is worn by both the close button and "שיחה חדשה" — take the ✕ itself
    await page.evaluate(`[...${SHADOW}.querySelectorAll('.hdr .x')].find(b => b.textContent.trim() === '✕').click()`);
    await page.waitForTimeout(500);
    const backAgain = await page.evaluate(`getComputedStyle(${SHADOW}.querySelector('.fab')).opacity`);
    t('and it comes back when the chat is closed', () => assert.strictEqual(backAgain, '1'));

    t('no page errors', () => assert.deepStrictEqual(errors, []));
  } finally {
    await browser.close(); srv.kill();
  }
  console.log(`widget: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
