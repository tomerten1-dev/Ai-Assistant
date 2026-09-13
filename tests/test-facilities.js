// מתקני מלון מדף המלון (31/08) — הלקח מסאני, בכיוון ההפוך: היא נכשלה על
// "בריכה מחוממת", אצלנו התשובה היא ציטוט הדף — וכשהדף שותק, אומרים זאת.
// Run: node tests/test-facilities.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const { handleChat } = require('../server/server.js');
const resorts = require('../data/resorts.json');
const catalogue = require('../data/catalogue.json');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ask = (content, slots = {}) => handleChat({ messages: [{ role: 'user', content }], slots });
const MONEY = /[€$₪]|\d[\d,.]*\s*(?:אירו|יורו|שקל|דולר)(?![א-ת])/;

/* ---------- the data ---------- */
t('no collected fact carries a sum of money (red rule 3)', () => {
  const all = [...Object.values(resorts.hotels).map(h => h.page_facts || {}),
    ...catalogue.hotels.map(h => h.facts || {})];
  for (const pf of all) for (const [k, v] of Object.entries(pf)) {
    if (typeof v !== 'string') continue;
    assert.ok(!MONEY.test(v), k + ': ' + v);
  }
});

t('coverage did not silently shrink', () => {
  const n = f => Object.values(resorts.hotels).filter(h => (h.page_facts || {})[f] != null).length;
  assert.ok(n('location_he') >= 40, 'location: ' + n('location_he'));
  assert.ok(n('lift_page_he') >= 40, 'lift: ' + n('lift_page_he'));
  assert.ok(n('spa_page_he') >= 30, 'spa: ' + n('spa_page_he'));
  assert.ok(n('pool_he') >= 25, 'pool: ' + n('pool_he'));
  assert.ok(catalogue.hotels.filter(h => h.facts).length >= 110, 'catalogue facts');
});

/* ---------- the answers ---------- */
t('a named hotel with the fact gets the page wording', async () => {
  const out = await ask('יש ספא במלון סטראס?');
  assert.ok(/מדף המלון באתר פינגווין/.test(out.reply_he), out.reply_he.slice(0, 200));
  assert.ok(/Strass — ספא: /.test(out.reply_he), out.reply_he.slice(0, 200));
});

t('"בריכה מחוממת" gives one honest line, not two', async () => {
  const out = await ask('יש בריכה מחוממת במלון סטראס?');
  const lines = (out.reply_he.match(/^• /gm) || []).length;
  assert.strictEqual(lines, 1, out.reply_he);
  assert.ok(/מחוממת לא כתוב בדף|כן — |לא מסומנת כמחוממת/.test(out.reply_he), out.reply_he.slice(0, 250));
});

t('a heated pool the page confirms is confirmed', async () => {
  // קאזה קארינה: הדף אומר בריכת שחייה מחוממת
  const pf = resorts.hotels['Casa Karina'].page_facts;
  if (pf.pool_heated !== true) return;                 // fixture guard
  const out = await ask('יש בריכה מחוממת בקאזה קארינה?');
  assert.ok(/כן — /.test(out.reply_he), out.reply_he.slice(0, 200));
});

t('a fact the page does not state says so instead of inventing', async () => {
  // Rila: אין לו laundry_he בדף. כשאין אף עובדה, facilityLine מוותר בכוונה
  // והמסלול הקיים (unverifiable) עונה — העיקר שהתשובה מודה שהדף שותק ולא
  // ממציאה מכונת כביסה.
  const pf = resorts.hotels['Rila'].page_facts || {};
  if (pf.laundry_he != null) return;                   // fixture guard
  const out = await ask('יש מכונת כביסה במלון רילה?');
  assert.ok(/לא כתוב בדף|לא מצאתי בדפי המלונות|נציג יאמת/.test(out.reply_he), out.reply_he.slice(0, 250));
  assert.ok(!/יש מכונת כביסה|כולל מכונת כביסה/.test(out.reply_he), 'invented: ' + out.reply_he.slice(0, 200));
});

t('a facility question about the cards on screen answers for those hotels', async () => {
  const first = await ask('זוג לבנסקו בפברואר');
  assert.ok(first.cards.length, 'no cards');
  const out = await handleChat({
    messages: [{ role: 'user', content: 'זוג לבנסקו בפברואר' }, { role: 'assistant', content: 'הנה' },
      { role: 'user', content: 'יש ספא במלונות האלה?' }],
    slots: first.slots,
  });
  assert.ok(/מדף המלון באתר פינגווין/.test(out.reply_he), out.reply_he.slice(0, 200));
  assert.ok((out.reply_he.match(/^• /gm) || []).length >= 2, out.reply_he.slice(0, 300));
});

t('no hotel and no cards → the honest generic answer, no invented hotel', async () => {
  const out = await ask('יש חדר כושר?');
  assert.ok(!/מדף המלון באתר פינגווין/.test(out.reply_he), out.reply_he.slice(0, 200));
});

t('a kashrut question stays with the kashrut answer even with a hotel named', async () => {
  const out = await ask('יש אוכל כשר בסטראס? יש מטבחון לבשל?');
  assert.ok(/אין לנו חבילה כשרה/.test(out.reply_he), out.reply_he.slice(0, 200));
});

t('"יש מקרר בחדר ברגנום?" is a facility, not a kashrut lecture', async () => {
  const out = await ask('יש מקרר בחדר ברגנום?');
  assert.ok(/Regnum — מטבחון ומקרר/.test(out.reply_he), out.reply_he.slice(0, 200));
  assert.ok(!/אין לנו חבילה כשרה/.test(out.reply_he), 'kosher hijacked it');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok ', name); pass++; }
    catch (e) { console.log('  ✗  ', name); console.log('      ' + String(e.message).slice(0, 300)); fail++; }
  }
  console.log(`\nfacilities: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
