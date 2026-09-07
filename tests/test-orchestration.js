// Provider orchestration with a STUBBED model — verifies the token-economy
// rules without an API key: the model is called only when the free Hebrew
// layer failed, phrasing never calls a model, and a broken model degrades
// gracefully instead of breaking the bot.
// Run: node tests/test-orchestration.js
// the tests must never write to the real conversation log: it is the weekly
// review's input, and synthetic turns bury the customers' real ones
process.env.CHAT_LOG = 'off';

process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub-not-real';
// a placeholder value, not a delete: loadEnv() would otherwise pull the real
// key out of .env and this suite would bill actual API calls
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.MAX_QUESTIONS = '3';

const claudePath = require.resolve('../server/claude.js');
const real = require('../server/claude.js');
let scripted = [];
let callCount = 0;
// Two different jobs now go to the model: understanding the message, and
// wording the reply. They are counted separately, because the token policy is
// about understanding — wording only happens when there are offers to word.
// A third job joined them (24/08): choosing WHICH approved answer a question
// deserves. It is counted apart, because it is not understanding and not
// wording — and because it must not fire on a bare "כן".
// A fourth (06/09): the reply editor, which turns the assembled lines of a
// no-offers turn into one written answer. Counted apart; never on a chip.
let slotCalls = 0, phraseCalls = 0, routeCalls = 0, composeCalls = 0;
require.cache[claudePath].exports = {
  ...real,
  callClaude: async ({ system }) => {
    callCount++;
    if (/מנתב שאלות/.test(system || '')) routeCalls++;
    else if (/אתה עורך/.test(system || '')) composeCalls++;
    else if (/מנסח|נציג של פינגווין/.test(system || '')) phraseCalls++;
    else slotCalls++;
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
const reset = (...s) => { scripted = s; callCount = 0; slotCalls = 0; phraseCalls = 0; routeCalls = 0; composeCalls = 0; };

(async () => {
  // Policy changed 24/08 (Tomer): the model reads every real message, because
  // hand-written regexes could never keep up with how customers actually write.
  // What stays free is the class of turns the regex layer gets right every
  // time - a bare number, yes/no, a chip click.
  console.log('[tokens] a real sentence is worth exactly one model call');
  reset(JSON.stringify({ slots: {}, ready_to_search: true }));
  const r1 = await handleChat({
    // the destination is stated so the 30/08 gate is satisfied — this test is
    // about how many model calls a real sentence costs, not about the gate
    messages: [{ role: 'user', content: 'זוג עם ילדים בני 5 ו-9, פברואר באוסטריה, בלי קייטנה' }],
    slots: {},
  });
  t('one call to understand, one to phrase', slotCalls === 1 && phraseCalls === 1, 'slot=' + slotCalls + ' phrase=' + phraseCalls);
  t('still produced offers', r1.cards.length === 2, 'cards=' + r1.cards.length);

  console.log('[tokens] chip clicks and one-word answers are still free');
  reset();
  await handleChat({ messages: [{ role: 'user', content: 'ינואר' }], slots: { adults: 2, no_children: true } });
  await handleChat({ messages: [{ role: 'user', content: 'כן' }], slots: { adults: 2, children_ages: [7], month: 1, _lastQuestion: 'kids_club' } });
  await handleChat({ messages: [{ role: 'user', content: '4' }], slots: { _lastQuestion: 'adults' } });
  // a bare number, a yes, a month: understood for free AND not worth editing
  t('chip-like turns are never sent to the reply editor', composeCalls === 0, 'compose calls=' + composeCalls);
  await handleChat({ messages: [{ role: 'user', content: 'חשוב לי ספא' }], slots: { adults: 2, no_children: true, month: 1 } });
  // phrasing of the offers they produce, never a second look at the message.
  // Each of these is understood for free; the calls counted here are the
  t('cheap turns never pay to be understood', slotCalls === 0, 'slot calls=' + slotCalls);
  t('and they are not routed either', routeCalls === 0, 'route calls=' + routeCalls);

  console.log('\n[tokens] only an unrecognised phrasing escalates to the model');
  reset(JSON.stringify({
    slots: { adults: 2, no_children: true, month: 1, country: 'austria' },
    reply_he: '', ready_to_search: true,
  }));
  const r2 = await handleChat({
    // no number, no "זוג", no month name — nothing the regex vocabulary knows
    messages: [{ role: 'user', content: 'בא לנו לנשום קצת אוויר הרים אחרי החגים, מה אתם מציעים' }],
    slots: {},
  });
  t('an unrecognised phrasing is understood by the model', callCount >= 1, 'calls=' + callCount);
  t('model result used', r2.model_used === true);
  // Policy changed 24/08: phrasing IS a model call now, and its output must
  // survive validation or the template ships instead.
  t('a reply was produced either way', typeof r2.reply_he === 'string' && r2.reply_he.length > 0);

  console.log('\n[safety] the model never sees inventory, so cards come from data only');
  t('cards present', r2.cards.length > 0);
  // 30/08: a price band is now present only for a hotel Tomer has actually
  // classified. It used to fall back to pricing.json's TODO default for the 32
  // of 40 hotels that have none, and that placeholder was then reasoned from.
  // What this test is really pinning is that a band, when shown, is real.
  t('every card is a real workbook hotel',
    r2.cards.every(c => c.hotel && c.date && (c.price_range == null || /^₪+$/.test(c.price_range))));

  console.log('\n[resilience] a broken model degrades to the free layer, not to an error');
  reset('this is not json at all');
  const r3 = await handleChat({
    messages: [{ role: 'user', content: 'משהו שהרג׳קס לא מכיר בכלל בבקשה תעזור' }],
    slots: {},
  });
  t('model was attempted', callCount >= 1, 'calls=' + callCount);
  t('bot still replied', !!r3.reply_he);
  t('reply is a sensible question, not an error', /\?/.test(r3.reply_he), r3.reply_he);

  console.log('\n[questions] two or three questions FIRST, then the offers');
  reset();
  const r4 = await handleChat({ messages: [{ role: 'user', content: 'אנחנו 2' }], slots: {} });
  // Tomer, 24/08: never hold the customer at the door. Search with what we
  // have, ask the gap after the offers, and never ask the same thing twice.
  // Policy changed 25/08 (Tomer): "אני רוצה שהוא ישאל 2/3 שאלות ואז יתן את
  // האופציות". Party AND when decide which rooms even fit; with only a party
  // size the offers cannot be right yet.
  t('a party size alone holds the offers back', r4.cards.length === 0, 'cards=' + r4.cards.length);
  t('and asks for what is missing', /[?]/.test(r4.reply_he), r4.reply_he);
  // Policy changed 30/08 (Tomer, after using "סאני"): the destination joined
  // the essentials. Who, when and where decide which packages qualify; the
  // airport only filters them, so it is still gathered as chips afterwards.
  reset();
  const r4b = await handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, ינואר' }], slots: {},
  });
  t('who and when without where holds the offers', r4b.cards.length === 0, 'cards=' + r4b.cards.length);
  t('and asks where', /יעד|אוסטריה/.test(r4b.reply_he), r4b.reply_he);

  reset();
  const r5 = await handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, ינואר באוסטריה' }], slots: {},
  });
  t('essentials complete -> offers, no question at all',
    r5.cards.length === 2 && !/[?]/.test(r5.reply_he), r5.reply_he);
  t('airport still gathered — as chips', (r5.chips || []).some(c => c.includes('חיפה')));
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
