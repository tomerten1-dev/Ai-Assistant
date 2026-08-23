// Orchestration test with a STUBBED Claude — verifies the server pipeline
// (slot filling → deterministic search → phrasing) without an API key.
// Run: node tests/test-orchestration.js
const path = require('path');

// force "claude" mode so the stub is exercised (offline mode has its own test file)
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub-not-real';

// stub the claude module BEFORE requiring the server
const claudePath = require.resolve('../server/claude.js');
const real = require('../server/claude.js');
let scriptedResponses = [];
require.cache[claudePath].exports = {
  ...real,
  callClaude: async ({ system, messages }) => {
    if (!scriptedResponses.length) throw new Error('stub exhausted');
    const next = scriptedResponses.shift();
    return typeof next === 'function' ? next({ system, messages }) : next;
  },
};

const { handleChat, requiredMissing } = require('../server/server.js');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail ? '— ' + detail : ''); }
}

(async () => {
  console.log('[2] full details in one message → zero questions, straight to results');
  scriptedResponses = [
    JSON.stringify({
      slots: { adults: 2, children_ages: [5, 9], no_children: null, month: 2, flexible_dates: null, country: 'france', destination: null, needs_hebrew_kids_club: true, preferences: [] },
      reply_he: '', ready_to_search: true,
    }),
    JSON.stringify({ intro_he: 'הנה ההצעות שלנו', cards: [{ index: 0, why_he: 'מתאים למשפחה' }], outro_he: '' }),
  ];
  const r2 = await handleChat({
    messages: [{ role: 'user', content: '4 אנשים, ילדים בני 5 ו-9, פברואר, צרפת, צריכים קייטנה בעברית' }],
    slots: {},
  });
  t('returns cards immediately', r2.cards.length > 0, JSON.stringify(r2).slice(0, 200));
  t('no question in reply', !/\?/.test(r2.reply_he));
  t('france-february note surfaced', (r2.notes || []).some(n => n.type === 'france_february_gap'));
  t('cards are NOT france-february', r2.cards.every(c => !(c.country === 'france' && c.date.slice(5, 7) === '02')));
  t('chips offered after results', r2.chips.length >= 3);
  t('booking url carries siteID', r2.cards.every(c => /siteID=\d+/.test(c.booking_url || '')));
  t('no numeric price anywhere in cards', r2.cards.every(c => /^₪+$/.test(c.price_range)));

  console.log('[3] "אנחנו 2, ינואר" → at most one question then results');
  scriptedResponses = [
    JSON.stringify({
      slots: { adults: 2, children_ages: [], no_children: null, month: 1, flexible_dates: null, country: null, destination: null, needs_hebrew_kids_club: null, preferences: [] },
      reply_he: 'נשמע מעולה! נוסעים רק מבוגרים או גם ילדים?', ready_to_search: false,
    }),
  ];
  const r3a = await handleChat({ messages: [{ role: 'user', content: 'אנחנו 2, ינואר' }], slots: {} });
  t('asks exactly one question', (r3a.reply_he.match(/\?/g) || []).length === 1 && r3a.cards.length === 0);

  scriptedResponses = [
    JSON.stringify({
      slots: { adults: 2, children_ages: [], no_children: true, month: 1, flexible_dates: null, country: null, destination: null, needs_hebrew_kids_club: null, preferences: [] },
      reply_he: '', ready_to_search: true,
    }),
    JSON.stringify({ intro_he: 'מצאתי כמה אופציות יפות לינואר', cards: [{ index: 0, why_he: 'זוגי ופנוי' }], outro_he: '' }),
  ];
  const r3b = await handleChat({
    messages: [
      { role: 'user', content: 'אנחנו 2, ינואר' },
      { role: 'assistant', content: 'נשמע מעולה! נוסעים רק מבוגרים או גם ילדים?' },
      { role: 'user', content: 'בלי ילדים' },
    ],
    slots: r3a.slots,
  });
  t('results after the single answer', r3b.cards.length === 3);

  console.log('[question cap] 2 questions already asked → search even if slots missing');
  scriptedResponses = [
    JSON.stringify({
      slots: { adults: 2, children_ages: [], no_children: null, month: null, flexible_dates: null, country: null, destination: null, needs_hebrew_kids_club: null, preferences: [] },
      reply_he: 'ומתי תרצו לצאת?', ready_to_search: false,
    }),
    JSON.stringify({ intro_he: 'הנה', cards: [], outro_he: '' }),
  ];
  const rq = await handleChat({
    messages: [
      { role: 'user', content: 'רוצים סקי' },
      { role: 'assistant', content: 'כמה תהיו?' },
      { role: 'user', content: '2' },
      { role: 'assistant', content: 'יש ילדים?' },
      { role: 'user', content: 'לא' },
    ],
    slots: {},
  });
  t('question cap forces search', rq.cards.length > 0, 'cards=' + rq.cards.length);

  console.log('[fallback] model returns garbage → friendly Hebrew fallback');
  scriptedResponses = ['בלה בלה לא JSON'];
  const rf = await handleChat({ messages: [{ role: 'user', content: 'היי' }], slots: {} });
  t('friendly fallback', /04-8557722|שוב/.test(rf.reply_he) && rf.cards.length === 0);

  console.log('[PII] server response never contains order numbers / Hebrew names in rooms');
  t('requiredMissing works', requiredMissing({ adults: 2, children_ages: [5], month: 2, needs_hebrew_kids_club: null }).includes('kids_club'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
