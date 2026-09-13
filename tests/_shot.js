// Dev helper: screenshot a scripted conversation in the widget.
// node tests/_shot.js <width> <height> <out.png> "msg1" "msg2" ...   (server on :8787)
// Hotel photographs are served as a placeholder: the sandbox cannot reach pingwin.co.il.
const { chromium } = require('playwright');
(async () => {
  const [width, height, out, ...turns] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const mobile = +width <= 480;
  const ctx = await b.newContext({ viewport: { width: +width, height: +height }, isMobile: mobile, hasTouch: mobile });
  const svg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fa7d6"/><stop offset="1" stop-color="#dfe9f5"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><polygon points="0,360 200,150 330,270 430,190 640,360" fill="#fff" opacity=".85"/><text x="20" y="40" font-size="26" fill="#1c3d5a" font-family="sans-serif">${t}</text></svg>`;
  await ctx.route(/pingwin\.co\.il.*\.(jpe?g|png|webp)/i, r => r.fulfill({ contentType: 'image/svg+xml', body: svg('hotel photo') }));
  const page = await ctx.newPage();
  await page.goto('http://localhost:8787/demo.html?pwreset=1');
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#pingwin-bot-host').shadowRoot.querySelector('.fab').click());
  await page.waitForTimeout(1300);
  for (const t of turns) {
    if (t.startsWith('@click:')) {
      await page.evaluate((sel) => { const r = document.querySelector('#pingwin-bot-host').shadowRoot; const e = r.querySelector(sel); if (e) e.click(); }, t.slice(7));
      await page.waitForTimeout(700); continue;
    }
    await page.evaluate((t) => { const r = document.querySelector('#pingwin-bot-host').shadowRoot; const i = r.querySelector('textarea'); i.value = t; i.dispatchEvent(new Event('input')); r.querySelector('.send').click(); }, t);
    await page.waitForTimeout(2200);
  }
  const m = await page.evaluate(() => { const r = document.querySelector('#pingwin-bot-host').shadowRoot; const p = r.querySelector('.msgs'); const cards = [...r.querySelectorAll('.card')].map(c => Math.round(c.getBoundingClientRect().height)); const win = r.querySelector('.win').getBoundingClientRect(); return { scrollH: p.scrollHeight, clientH: p.clientHeight, screens: +(p.scrollHeight / p.clientHeight).toFixed(2), cards, win: [Math.round(win.width), Math.round(win.height)] }; });
  console.log(out, JSON.stringify(m));
  await page.screenshot({ path: out });
  await b.close();
})();
