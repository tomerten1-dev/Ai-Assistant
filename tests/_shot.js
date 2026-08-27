// Dev helper: screenshot a scripted conversation in the widget.
// node tests/_shot.js <width> <out.png> "msg1" "msg2" ...   (server must be running on :8787)
const { chromium } = require('playwright');
(async () => {
  const [width, out, ...turns] = process.argv.slice(2);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const mobile = +width <= 480;
  const page = await (await b.newContext({ viewport: { width: +width, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile })).newPage();
  await page.goto('http://localhost:8787/demo.html');
  await page.evaluate(() => document.querySelector('#pingwin-bot-host').shadowRoot.querySelector('.fab').click());
  for (const t of turns) {
    await page.evaluate((t) => { const r = document.querySelector('#pingwin-bot-host').shadowRoot; const i = r.querySelector('textarea'); i.value = t; i.dispatchEvent(new Event('input')); r.querySelector('.send').click(); }, t);
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: out });
  await b.close();
})();
