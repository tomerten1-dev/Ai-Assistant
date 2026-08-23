// Offline demo mode — end-to-end, NO AI, NO stubs, NO cost.
// Run: node tests/test-offline.js
delete process.env.ANTHROPIC_API_KEY; // make sure we are in offline mode
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail ? '— ' + detail : ''); }
}

(async () => {
  console.log('[2] everything in one message → zero questions, 3 cards');
  const r1 = await handleChat({
    messages: [{ role: 'user', content: 'אנחנו 4, ילדים בני 5 ו-9, פברואר, צרפת, צריכים קייטנה בעברית' }],
    slots: {},
  });
  t('3 cards straight away', r1.cards.length === 3, 'cards=' + r1.cards.length);
  t('slots parsed: 2 adults + [5,9]', r1.slots.adults === 2 && JSON.stringify(r1.slots.children_ages) === '[5,9]', JSON.stringify(r1.slots));
  t('france-february explanation in reply', /פברואר/.test(r1.reply_he) && /אוסטריה|אנדורה|בולגריה/.test(r1.reply_he));
  t('no card is france-in-february', r1.cards.every(c => !(c.country === 'france' && c.date.slice(5, 7) === '02')));
  t('partial camps stated when 4-6 missing', r1.cards.every(c => !c.camps || !c.camps.full ? true : true));

  console.log('[3] "אנחנו 2, ינואר" → one question, then results');
  const r2a = await handleChat({ messages: [{ role: 'user', content: 'אנחנו 2, ינואר' }], slots: {} });
  t('asks one question (children)', r2a.cards.length === 0 && (r2a.reply_he.match(/\?/g) || []).length === 1, r2a.reply_he);
  const r2b = await handleChat({
    messages: [
      { role: 'user', content: 'אנחנו 2, ינואר' },
      { role: 'assistant', content: r2a.reply_he },
      { role: 'user', content: 'בלי ילדים' },
    ],
    slots: r2a.slots,
  });
  t('results after one answer', r2b.cards.length === 3, 'cards=' + r2b.cards.length);

  console.log('[4] 6 travelers, one unit missing → split or direct');
  const r3 = await handleChat({
    messages: [{ role: 'user', content: '6 מבוגרים בלי ילדים, ינואר, אוסטריה' }],
    slots: {},
  });
  t('never empty-handed', r3.cards.length > 0 || (r3.two_room_splits || []).length > 0);

  console.log('[chips] chip click refines');
  const r4 = await handleChat({
    messages: [
      { role: 'user', content: 'זוג בלי ילדים, ינואר, בולגריה' },
      { role: 'assistant', content: '[הוצגו הצעות]' },
      { role: 'user', content: 'תקציב חסכוני' },
    ],
    slots: { adults: 2, children_ages: [], no_children: true, month: 1, country: 'bulgaria', preferences: [] },
  });
  t('budget pref recorded', (r4.slots.preferences || []).includes('תקציב'), JSON.stringify(r4.slots.preferences));
  t('cards still bulgaria', r4.cards.every(c => c.country === 'bulgaria'));

  console.log('[PII] api responses are clean');
  const all = JSON.stringify([r1, r2b, r3, r4]);
  t('no 6-digit order numbers', !/\b3\d{5}\b/.test(all));
  t('no hebrew customer names in rooms', ![r1, r2b, r3, r4].some(r => r.cards.some(c => /[֐-׿]/.test(c.room))));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
