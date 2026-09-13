// Foreign languages (server/translate.js): the customer's message is translated
// into Hebrew, the turn runs as Hebrew, the reply is translated back — with
// guards — and the language sticks for the next turn. Plus the gibberish line.
// The model is stubbed. Run: node tests/test-translate.js
process.env.CHAT_LOG = 'off';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub-not-real';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
const assert = require('assert');
const translate = require('../server/translate.js');
const offline = require('../server/offline-nlu.js');

const claudePath = require.resolve('../server/claude.js');
const real = require('../server/claude.js');
let inCalls = 0, outCalls = 0, outReply = null, inReply = null;
let badDeadline = null;
require.cache[claudePath].exports = { ...real, callClaude: async ({ system, messages, deadline }) => {
  const user = messages[0].content;
  // the real client hands the deadline to a timer, which refuses a fraction
  // (25000/3 did exactly that on 06/09 and silently skipped every translation)
  if (deadline != null && !Number.isInteger(deadline)) badDeadline = deadline;
  if (/אתה מתרגם הודעות/.test(system || '')) {
    inCalls++;
    if (typeof inReply === 'function') return inReply(user);
    const map = {
      'We are 2 adults and a child aged 7, February, Bulgaria': 'אנחנו 2 מבוגרים וילד בן 7, פברואר, בולגריה',
      'Is there a kids club in Hebrew?': 'יש קייטנה בעברית?',
      'Thanks, bye': 'תודה, ביי',
      'do you have the Kempinski in Bansko?': 'יש לכם את הקמפינסקי בבנסקו?',
    };
    return JSON.stringify({ he: map[user] || 'זוג בינואר' });
  }
  if (/^You translate replies/.test(system || '')) {
    outCalls++;
    if (typeof outReply === 'function') return outReply(user);
    // a stand-in translation: Hebrew letters become x, everything else survives
    return 'Translated: ' + user.replace(/עברית/g, 'Hebrew').replace(/פינגווין/g, 'Pingwin').replace(/[א-ת]/g, 'x');
  }
  if (/מנתב שאלות/.test(system || '')) return JSON.stringify({ ids: [] });
  if (/אתה עורך/.test(system || '')) return '';
  if (/מנסח|נציג של פינגווין/.test(system || '')) return 'x';
  return JSON.stringify({ slots: {}, ready_to_search: true });
} };
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function convo(turns) {
  inCalls = 0; outCalls = 0;
  let slots = {}; const messages = [{ role: 'assistant', content: 'שלום' }]; const out = [];
  for (const u of turns) {
    messages.push({ role: 'user', content: u });
    const r = await handleChat({ messages, slots, conversationId: 'translate-test' });
    slots = r.slots; messages.push({ role: 'assistant', content: r.reply_he }); out.push(r);
  }
  return out;
}

(async () => {
  console.log('— the guards —');
  await t('translate-in keeps the customer\'s numbers and Latin names', () => {
    assert.ok(translate.validateIn('אנחנו 2 מבוגרים וילד בן 7, פברואר', 'We are 2 adults and a child aged 7, February'));
    assert.strictEqual(translate.validateIn('אנחנו 2 מבוגרים וילד בן 9, פברואר', 'We are 2 adults and a child aged 7, February'), null);
    assert.ok(translate.validateIn('אנחנו 2 מבוגרים, פברואר', 'We are two adults, February'), 'a spelled-out number may become a digit');
    assert.strictEqual(translate.validateIn('ספר לי על המלון', 'Tell me about Regnum', ['Regnum']), null, 'a hotel name must survive');
    assert.ok(translate.validateIn('יש קייטנה בעברית?', 'Is there a kids club in Hebrew?', ['Regnum']), 'an ordinary capitalised word is not a name');
    assert.strictEqual(translate.validateIn('no hebrew here', 'Tell me'), null);
  });
  await t('translate-out: no Hebrew leak, no invented numbers, names and phone survive', () => {
    const he = 'לזוג בינואר 2027 הצגתי שלוש אפשרויות ב-Regnum וב-Vihren; נציג יאשר סופית. אפשר להתקשר ל-04-8557722.';
    assert.ok(translate.validateOut('For a couple in January 2027 I showed three options at Regnum and Vihren; a rep will confirm. You can call 04-8557722.', he, 'en'));
    assert.ok(translate.validateOut('For a couple in January 2027 I showed three options at Regnum and Vihren; a rep will confirm. You can call +972-4-8557722.', he, 'en'), 'the international form of the phone number is the same number');
    assert.strictEqual(translate.validateOut('For a couple in January 2027 — Regnum וב-Vihren; a rep will confirm. Call 04-8557722.', he, 'en'), null, 'Hebrew leaked');
    assert.strictEqual(translate.validateOut('For a couple in January 2027 I showed 5 options at Regnum and Vihren; a rep will confirm. Call 04-8557722.', he, 'en'), null, 'an invented number');
    assert.strictEqual(translate.validateOut('For a couple in January 2027 I showed three options at Regnum; a rep will confirm. Call 04-8557722.', he, 'en'), null, 'a hotel name dropped');
    assert.strictEqual(translate.validateOut('For a couple in January 2027 I showed three options at Regnum and Vihren; a rep will confirm. Call 04-8557723.', he, 'en'), null, 'the phone number changed');
    assert.strictEqual(translate.validateOut('Ok.', he, 'en'), null, 'far too short');
    assert.strictEqual(translate.validateOut('For a couple in January 2027 — Regnum and Vihren, 04-8557722.', he, 'ru'), null, 'Russian without Cyrillic');
    const camp = 'בקייטנה של פינגווין המדריך מלמד באנגלית ומלווה ישראלי מתרגם לילדים לעברית.';
    assert.ok(translate.validateOut('In the Pingwin ski camp the instructor teaches in English and an Israeli escort translates for the children into Hebrew.', camp, 'en'));
    assert.strictEqual(translate.validateOut('In the Penguin ski camp the instructor teaches in English and an Israeli escort translates for the children into Hebrew.', camp, 'en'), null, 'the brand became a bird');
    assert.strictEqual(translate.validateOut('В лагере Pingwin инструктор преподаёт на английском, а израильский сопровождающий переводит детям на русский язык.', camp, 'ru'), null, 'Hebrew became Russian');
    assert.ok(translate.validateOut('В лагере Pingwin инструктор преподаёт на английском, а израильский сопровождающий переводит детям на иврит.', camp, 'ru'));
  });

  console.log('— the wiring —');
  await t('an English message is answered in English, with the cards, and the language sticks', async () => {
    const r = await convo(['We are 2 adults and a child aged 7, February, Bulgaria']);
    assert.strictEqual(inCalls, 1); assert.strictEqual(outCalls, 1);
    assert.ok(/^Translated: /.test(r[0].reply_he), r[0].reply_he);
    assert.ok(!/[א-ת]/.test(r[0].reply_he), 'Hebrew in the reply: ' + r[0].reply_he);
    assert.strictEqual(r[0].slots._lang, 'en');
    assert.strictEqual(r[0].slots.adults, 2);
    assert.deepStrictEqual(r[0].slots.children_ages, [7]);
    assert.ok(r[0].model_used);
    assert.strictEqual(badDeadline, null, 'a fractional deadline reached the model client: ' + badDeadline);
  });
  await t('"4" on the next turn has nothing to translate in, and still comes back in English', async () => {
    const r = await convo(['We are 2 adults and a child aged 7, February, Bulgaria', 'Is there a kids club in Hebrew?', '4']);
    assert.strictEqual(inCalls, 2, 'in calls=' + inCalls);
    assert.strictEqual(outCalls, 3, 'out calls=' + outCalls);
    assert.ok(/^Translated: /.test(r[2].reply_he), r[2].reply_he);
    assert.strictEqual(r[2].slots._lang, 'en');
  });
  await t('a Hebrew message ends the translation', async () => {
    const r = await convo(['We are 2 adults and a child aged 7, February, Bulgaria', 'אפשר גם בעברית']);
    assert.ok(/[א-ת]/.test(r[1].reply_he) && !/^Translated/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(!r[1].slots._lang, 'language still sticky: ' + r[1].slots._lang);
  });
  await t('a translation that leaks Hebrew is thrown away: the fixed English line and the form ship instead', async () => {
    outReply = user => 'Translated with a leak: ' + user;
    const r = await convo(['We are 2 adults and a child aged 7, February, Bulgaria']);
    outReply = null;
    assert.ok(/^Hi! I'm Pingwin's automatic assistant/.test(r[0].reply_he), r[0].reply_he);
    assert.ok(r[0].open_lead_form);
  });
  await t('a translate-in the guard refuses falls back to the fixed line, as before', async () => {
    inReply = () => JSON.stringify({ he: 'אנחנו 5 מבוגרים' });
    const r = await convo(['We are 2 adults and a child aged 7, February, Bulgaria']);
    inReply = null;
    assert.ok(/^Hi! I'm Pingwin's automatic assistant/.test(r[0].reply_he) || /[א-ת]/.test(r[0].reply_he), r[0].reply_he);
    assert.ok(!r[0].slots._lang);
  });
  await t('a brand we do not sell, asked in English, gets the refusal — translated', async () => {
    const r = await convo(['do you have the Kempinski in Bansko?']);
    assert.ok(/^Translated: /.test(r[0].reply_he) && /Kempinski|xx xxxxxx/.test(r[0].reply_he), r[0].reply_he);
    assert.strictEqual(r[0].slots.destination, 'Bansko');
  });
  await t('TRANSLATE=off restores the fixed line', async () => {
    process.env.TRANSLATE = 'off';
    const r = await convo(['Is there a kids club in Hebrew?']);
    delete process.env.TRANSLATE;
    assert.strictEqual(inCalls, 0);
    assert.ok(/^Hi! I'm Pingwin's automatic assistant/.test(r[0].reply_he), r[0].reply_he);
  });

  console.log('— gibberish —');
  await t('keyboard runs and repeated letters are noise; words, laughter and numbers are not', () => {
    for (const g of ['אסדגכע ייי', 'asdfgh', 'ממממ', 'קראטון', 'שדגכ עיחל']) assert.ok(offline.isGibberish(g), g);
    for (const w of ['שלום', 'זוג בינואר', '2 מבוגרים', 'הההה', 'חחח', 'ok', 'יש חניה?', 'סבבה']) assert.ok(!offline.isGibberish(w), w);
  });
  await t('gibberish gets "נראה שההודעה נשלחה בטעות" — before the offers and after them', async () => {
    const a = await convo(['אסדגכע ייי']);
    assert.ok(/נשלחה בטעות/.test(a[0].reply_he), a[0].reply_he);
    const b = await convo(['זוג, ינואר, בולגריה', 'אסדגכע ייי']);
    assert.ok(/נשלחה בטעות/.test(b[1].reply_he), b[1].reply_he);
    assert.ok(b[1].cards.length > 0, 'the cards stay');
    const c = await convo(['asdfgh']);
    assert.ok(/נשלחה בטעות/.test(c[0].reply_he) && !/Pingwin's automatic/.test(c[0].reply_he), 'Latin noise is not English: ' + c[0].reply_he);
  });

  console.log('\ntranslate: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
