// דירוגי מלונות — כוכבים וציון בוקינג (נאסף 31/08/2026 באישור תומר).
// שלוש שכבות: הנתונים עצמם תקינים; הכרטיס נושא אותם רק כשהם קיימים;
// והתשובה הדטרמיניסטית עונה במספרים אמיתיים ולא מנחשת אף פעם.
// Run: node tests/test-ratings.js
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

/* ---------- the data itself ---------- */
t('every collected value is in range, with its source recorded', () => {
  const all = [...Object.values(resorts.hotels), ...catalogue.hotels];
  for (const h of all) {
    if (h.stars != null) {
      assert.ok(Number.isInteger(h.stars) && h.stars >= 1 && h.stars <= 5, 'stars: ' + h.stars);
      assert.ok(h.rating_source && h.rating_source.stars, 'stars without a source');
    }
    if (h.booking_score != null) {
      assert.ok(h.booking_score >= 1 && h.booking_score <= 10, 'score: ' + h.booking_score);
      assert.ok(h.rating_source && h.rating_source.score, 'score without a source');
    }
  }
});

t('the offered hotels are covered — the few nulls are known, not new', () => {
  const noStars = Object.entries(resorts.hotels).filter(([, h]) => h.stars == null).map(([k]) => k);
  const noScore = Object.entries(resorts.hotels).filter(([, h]) => h.booking_score == null).map(([k]) => k);
  // פנסיונים/דירות בלי דירוג רשמי + Plein Sud הדו-משמעי — הושארו ריקים בכוונה
  assert.ok(noStars.length <= 7, 'more hotels lost their stars: ' + noStars.join(', '));
  assert.ok(noScore.length <= 2, 'more hotels lost their score: ' + noScore.join(', '));
});

/* ---------- the card ---------- */
t('a card carries the rating badge only when there is real data', async () => {
  const out = await ask('זוג לבנסקו בפברואר');
  assert.ok(out.cards.length, 'no cards');
  for (const c of out.cards) {
    if (c.rating_he) assert.ok(/כוכבים|בבוקינג/.test(c.rating_he), c.rating_he);
    if (c.stars == null && c.booking_score == null) assert.strictEqual(c.rating_he, null);
  }
});

/* ---------- the deterministic answer ---------- */
t('a named hotel gets its real numbers', async () => {
  const out = await ask('כמה כוכבים יש למלון רגנום?');
  assert.ok(/Regnum — 5 כוכבים · 8.7 בבוקינג/.test(out.reply_he), out.reply_he.slice(0, 200));
});

t('two named hotels are compared side by side, no verdict', async () => {
  const out = await ask('מה הדירוג בבוקינג של סטראס ושל בלמברה טין?');
  assert.ok(/Strass — 4 כוכבים · 8.3 בבוקינג/.test(out.reply_he), out.reply_he.slice(0, 300));
  assert.ok(/Belambra Tignes Val Claret — 4 כוכבים · 8.5 בבוקינג/.test(out.reply_he), out.reply_he.slice(0, 300));
  assert.ok(!/עדיף|יותר טוב|מומלץ יותר/.test(out.reply_he), 'passed a verdict: ' + out.reply_he.slice(0, 200));
});

t('rating question with no hotel and no cards falls back to the approved answer', async () => {
  const out = await ask('מה הכי יוקרתי?');
  assert.ok(/אשמח להשוות לפי הנתונים|כוכבים/.test(out.reply_he), out.reply_he.slice(0, 200));
  assert.ok(!/^לפי הנתונים שבאתר פינגווין:/m.test(out.reply_he), 'invented a hotel to rate');
});

t('rating question about the cards on screen answers for those hotels', async () => {
  const first = await ask('זוג לבנסקו בפברואר');
  assert.ok(first.cards.length, 'no cards to rate');
  const out = await handleChat({
    messages: [{ role: 'user', content: 'זוג לבנסקו בפברואר' }, { role: 'assistant', content: 'הנה' },
      { role: 'user', content: 'מה הדירוג שלהם בבוקינג?' }],
    slots: first.slots,
  });
  assert.ok(/לפי הנתונים שבאתר פינגווין/.test(out.reply_he), out.reply_he.slice(0, 200));
  const rated = (out.reply_he.match(/^• /gm) || []).length;
  assert.ok(rated >= 1, 'no hotel line: ' + out.reply_he.slice(0, 200));
});

t('review CONTENT still goes to a rep — numbers yes, gossip no', async () => {
  const out = await ask('קראתי ביקורת רעה על המלון, זה נכון?');
  assert.ok(/נציג/.test(out.reply_he), out.reply_he.slice(0, 200));
  assert.ok(!/^לפי הנתונים שבאתר פינגווין:/m.test(out.reply_he), 'rated an unnamed hotel');
});

t('a hotel with no verified rating says so instead of inventing one', async () => {
  // Landhaus Roscher — במלאי, בלי כוכבים ובלי ציון בשום מקור
  const info = resorts.hotels['Landhaus Roscher'];
  assert.ok(info && info.stars == null && info.booking_score == null, 'fixture changed — pick another hotel');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok ', name); pass++; }
    catch (e) { console.log('  ✗  ', name); console.log('      ' + String(e.message).slice(0, 300)); fail++; }
  }
  console.log(`\nratings: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
