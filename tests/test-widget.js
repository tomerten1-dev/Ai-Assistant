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

    // Tomer, 26/08 (Issta's bot): say plainly that this is an AI, that it can
    // be wrong, and where the privacy policy is — once, under the greeting.
    await page.goto(URL + '?pwreset=1'); await page.waitForTimeout(600);
    await page.evaluate(`${SHADOW}.querySelector('.fab').click()`);
    await page.waitForTimeout(600);
    const fine = await page.evaluate(`(() => {
      const r = ${SHADOW}, f = r.querySelector('.fine');
      return {
        text: f ? f.textContent : null,
        href: f && f.querySelector('a') ? f.querySelector('a').getAttribute('href') : null,
        target: f && f.querySelector('a') ? f.querySelector('a').getAttribute('target') : null,
        count: r.querySelectorAll('.fine').length,
      };
    })()`);
    t('the opening says it is an AI, that it can be wrong, and who confirms', () => {
      assert.ok(/בינה מלאכותית/.test(fine.text || ''), String(fine.text));
      assert.ok(/אי-דיוקים/.test(fine.text || ''), 'no inaccuracy notice');
      assert.ok(/נציג/.test(fine.text || ''), 'does not say a person confirms');
    });
    t('the privacy policy is a real link, opening in a new tab', () => {
      assert.ok(/pingwin\.co\.il/.test(fine.href || ''), String(fine.href));
      assert.strictEqual(fine.target, '_blank');
    });
    t('it is said once, not with every message', () => assert.strictEqual(fine.count, 1));

    // ── The card is the hotel's photograph ────────────────────────────────
    // Tomer, 26/08: "תעשה שהכרטיס כולו הוא התמונה של המלון... תשאיר את
    // האופציה להחליף בין התמונות של אותו מלון... תדאג שיראו את הטקסט".
    {
      const pic = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'stand-in.jpg'));
      const p3 = await browser.newPage({ viewport: { width: 430, height: 920 } });
      let served = 0;
      await p3.route('**pingwin.co.il/**', r => (/thumbMini|\.jpe?g|\.png/i.test(r.request().url())
        ? (served++, r.fulfill({ status: 200, contentType: 'image/jpeg', body: pic }))
        : r.continue()));
      let m = null, after = null;
      try {
        await p3.goto(URL + '?pwreset=1');
        await p3.waitForTimeout(500);
        await p3.evaluate(`${SHADOW}.querySelector('.fab').click()`);
        await p3.waitForTimeout(400);
        await p3.evaluate(`(() => { const r = ${SHADOW}; const ta = r.querySelector('textarea');
          ta.value = '4 מבוגרים בינואר בצרפת'; ta.dispatchEvent(new Event('input', { bubbles: true }));
          r.querySelector('.send, .snd, button[type=submit]').click(); })()`);
        await p3.waitForTimeout(3500);
        const read = `(() => { const r = ${SHADOW}; const c = r.querySelector('.card');
          const n = c.querySelector('.galn'), b = c.querySelector('.galb');
          const st = getComputedStyle(c.querySelector('.hname'));
          // the whole URL: the first 40 characters of two thumbMini links are
          // identical, so a prefix comparison would pass on a card that never
          // changed its photograph
          return { pbg: c.classList.contains('pbg'), bg: c.style.backgroundImage,
            counter: n && n.textContent, counterShown: n && getComputedStyle(n).opacity !== '0',
            arrowShown: b && getComputedStyle(b).opacity !== '0',
            nameColour: st.color, outline: st.textShadow.split('rgba').length - 1 }; })()`;
        m = await p3.evaluate(read);
        await p3.evaluate(`${SHADOW}.querySelector('.card .galb.next').click()`);
        await p3.waitForTimeout(400);
        after = await p3.evaluate(read);
      } finally { await p3.close(); }

      t('the offer is drawn as the hotel\'s photograph', () => {
        assert.ok(m.pbg, 'the card is not a photo card');
        assert.ok(/^url\("http/.test(m.bg), 'no photograph on it: ' + m.bg);
      });
      t('and the other photographs of the same hotel are one tap away', () => {
        assert.ok(m.arrowShown, 'the arrows are invisible');
        assert.ok(m.counterShown, 'nothing says there are more photographs');
        assert.ok(/^1\//.test(m.counter || ''), 'counter: ' + m.counter);
        assert.ok(/^2\//.test(after.counter || ''), 'the arrow did not page: ' + after.counter);
        assert.notStrictEqual(after.bg, m.bg, 'the card kept the same photograph');
      });
      t('white text on a photograph carries its own outline', () => {
        assert.strictEqual(m.nameColour, 'rgb(255, 255, 255)');
        // four hard shadows for the outline, two soft ones for the lift
        assert.ok(m.outline >= 5, 'only ' + m.outline + ' shadow layers — a snow photo will swallow it');
      });
    }

    // ── How much scrolling one answer costs ──────────────────────────────
    // Tomer, 26/08: "הבוט לא נוח מבחינה ui צריך לגלול הרבה". Measured then:
    // a single answer with three offers was 1.95 screens on a phone and 1.31
    // on a 1366 laptop. The card, the chips and the panel width were all
    // changed to fix it, and this is what stops any of it creeping back — it
    // measures the real thing in a real browser instead of trusting the CSS.
    for (const vp of [{ w: 1366, h: 768, max: 1.35, name: 'לפטופ 1366×768' },
                      { w: 390, h: 844, max: 1.65, name: 'מובייל 390×844' }]) {
      const p2 = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
      let m = null;
      try {
        await p2.goto(URL + '?pwreset=1');
        await p2.waitForTimeout(500);
        await p2.evaluate(`${SHADOW}.querySelector('.fab').click()`);
        await p2.waitForTimeout(400);
        await p2.evaluate(`(() => { const r = ${SHADOW}; const ta = r.querySelector('textarea');
          ta.value = '4 מבוגרים בינואר בצרפת'; ta.dispatchEvent(new Event('input', { bubbles: true }));
          r.querySelector('.send, .snd, button[type=submit]').click(); })()`);
        await p2.waitForTimeout(3500);
        m = await p2.evaluate(`(() => { const r = ${SHADOW}; const msgs = r.querySelector('.msgs');
          const chips = r.querySelector('.chips');
          return { scrollH: msgs.scrollHeight, viewH: msgs.clientHeight,
            cards: r.querySelectorAll('.card').length,
            cardH: Math.round((r.querySelector('.card') || {}).getBoundingClientRect
              ? r.querySelector('.card').getBoundingClientRect().height : 0),
            chipsH: chips ? Math.round(chips.getBoundingClientRect().height) : 0,
            chipRows: chips ? new Set([...chips.children].map(c =>
              Math.round(c.getBoundingClientRect().top))).size : 0 }; })()`);
      } finally { await p2.close(); }
      t(`${vp.name}: תשובה אחת עם 3 הצעות לא עולה על ${vp.max} מסכים`, () => {
        assert.ok(m.cards === 3, 'לא הוצגו 3 הצעות, אז המדידה חסרת משמעות: ' + m.cards);
        const screens = m.scrollH / m.viewH;
        assert.ok(screens <= vp.max,
          `${screens.toFixed(2)} מסכים (${m.scrollH}px בתוך ${m.viewH}px) — כרטיס ${m.cardH}px, צ'יפים ${m.chipsH}px`);
      });
      t(`${vp.name}: הצ'יפים בשורה אחת`, () => {
        // eight chips wrapping to four rows was 173px on a phone — more than
        // half a card, above the offers the customer came for
        assert.strictEqual(m.chipRows, 1, m.chipRows + ' שורות של צ\'יפים, ' + m.chipsH + 'px');
        assert.ok(m.chipsH > 20, 'שורת הצ\'יפים נמעכה ל-' + m.chipsH + 'px — היא לא נראית');
      });
      t(`${vp.name}: כרטיס סגור הוא כותרת, שורה וכפתור`, () => {
        assert.ok(m.cardH <= 230, 'כרטיס סגור ' + m.cardH + 'px');
      });
    }

    t('no page errors', () => assert.deepStrictEqual(errors, []));
  } finally {
    await browser.close(); srv.kill();
  }
  console.log(`widget: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
