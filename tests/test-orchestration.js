// Provider orchestration with a STUBBED model — verifies the token-economy
// rules without an API key: the model is called only when the free Hebrew
// layer failed, phrasing never calls a model, and a broken model degrades
// gracefully instead of breaking the bot.
// Run: node tests/test-orchestration.js
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub-not-real';
delete process.env.OPENAI_API_KEY;   // exercise the claude branch of the stub
process.env.MAX_QUESTIONS = '3';

const claudePath = require.resolve('../server/claude.js');
const real = require('../server/claude.js');
let scripted = [];
let callCount = 0;
require.cache[claudePath].exports = {
  ...real,
  callClaude: async () => {
    callCount++;
    if (!scripted.length) throw new Error('stub exhausted');
    return scripted.shift();
  },
};

const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail ? '— ' + detail : ''); }
}
const reset = (...s) => { scripted = s; callCount = 0; };

(async () => {
  console.log('[tokens] a message the Hebrew layer understands costs ZERO model calls');
  reset();
  const r1 = await handleChat({
    messages: [{ role: 'user', content: 'זוג עם ילדים בני 5 ו-9, פברואר, בלי קייטנה' }],
    slots: {},
  });
  t('no model call made', callCount === 0, 'calls=' + callCount);
  t('still produced offers', r1.cards.length === 3, 'cards=' + r1.cards.length);
  t('model_used reported false', r1.model_used === false);

  console.log('\n[tokens] chip clicks and short answers are free too');
  reset();
  await handleChat({ messages: [{ role: 'user', content: 'ינואר' }], slots: { adults: 2, no_children: true } });
  await handleChat({ messages: [{ role: 'user', content: 'כן' }], slots: { adults: 2, children_ages: [7], month: 1, _lastQuestion: 'kids_club' } });
  t('two more turns, still zero model calls', callCount === 0, 'calls=' + callCount);

  console.log('\n[tokens] only an unrecognised phrasing escalates to the model');
  reset(JSON.stringify({
    slots: { adults: 2, no_children: true, month: 1 },
    reply_he: '', ready_to_search: true,
  }));
  const r2 = await handleChat({
    // no number, no "זוג", no month name — nothing the regex vocabulary knows
    messages: [{ role: 'user', content: 'בא לנו לנשום קצת אוויר הרים אחרי החגים, מה אתם מציעים' }],
    slots: {},
  });
  t('model was called exactly once', callCount === 1, 'calls=' + callCount);
  t('model result used', r2.model_used === true);
  t('phrasing did NOT cost a second call', callCount === 1, 'calls=' + callCount);

  console.log('\n[safety] the model never sees inventory, so cards come from data only');
  t('cards present', r2.cards.length > 0);
  t('every card is a real workbook hotel', r2.cards.every(c => c.hotel && c.date && /^₪+$/.test(c.price_range)));

  console.log('\n[resilience] a broken model degrades to the free layer, not to an error');
  reset('this is not json at all');
  const r3 = await handleChat({
    messages: [{ role: 'user', content: 'משהו שהרג׳קס לא מכיר בכלל בבקשה תעזור' }],
    slots: {},
  });
  t('model was attempted', callCount === 1);
  t('bot still replied', !!r3.reply_he);
  t('reply is a sensible question, not an error', /\?/.test(r3.reply_he), r3.reply_he);

  console.log('\n[questions] blocking gaps ask; non-blocking gaps become chips');
  reset();
  const r4 = await handleChat({ messages: [{ role: 'user', content: 'אנחנו 2' }], slots: {} });
  t('missing children/month → asks', r4.cards.length === 0 && /\?/.test(r4.reply_he));
  reset();
  const r5 = await handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, ינואר' }], slots: {},
  });
  t('essentials complete → offers, no interview', r5.cards.length === 3 && !/\?/.test(r5.reply_he), r5.reply_he);
  t('airport still gathered — as chips', (r5.chips || []).some(c => c.includes('חיפה')));
  t('destination gathered as chips too', (r5.chips || []).some(c => c === 'אוסטריה'));
  t('pending parameter reported', r5.pending_parameter === 'airport');

  console.log('\n[cap] the bot never interrogates past MAX_QUESTIONS');
  reset();
  const rq = await handleChat({
    messages: [
      { role: 'user', content: 'רוצים סקי' },
      { role: 'assistant', content: 'כמה מבוגרים?' }, { role: 'user', content: '2' },
      { role: 'assistant', content: 'יש ילדים?' }, { role: 'user', content: 'לא' },
      { role: 'assistant', content: 'מתי?' }, { role: 'user', content: 'משהו לא ברור' },
    ],
    slots: { adults: 2, no_children: true },
  });
  t('cap reached → searches anyway', rq.cards.length > 0 || (rq.two_room_splits || []).length > 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
