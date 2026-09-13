// Six changes drawn from five recorded conversations with Sunny, Isrotel's
// digital agent (built by Abra), 30/08. Each test names the observed behaviour
// it copies — or, in the last pair, the mistake Sunny made that we chose not
// to repeat. Kept in its own file so the origin of the rules stays visible.
//
// Run: node tests/test-sunny.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const { handleChat } = require('../server/server.js');
const offline = require('../server/offline-nlu.js');
const guidance = require('../server/guidance.js');

const results = [];
function t(name, fn) { results.push([name, fn]); }

/* ---- 1. an elliptical follow-up is rewritten, not guessed at ---- */
t('a short follow-up with no subject of its own is looked up with the previous turn', async () => {
  // Sunny turned "וגם לילדים?" into the query "בריכה מחוממת ילדים ים סוף אילת
  // רויאל ביץ' אילת" — the previous topic plus the hotels it had just named.
  // The old opener list missed "ומתי זה?" and "רק לכולם?"; the test is now
  // whether every word is a function word, which is what "no subject of its
  // own" actually means.
  const first = await handleChat({
    messages: [{ role: 'user', content: 'מה כלול בחבילה?' }], slots: {} });
  const msgs = [{ role: 'user', content: 'מה כלול בחבילה?' },
                { role: 'assistant', content: first.reply_he }];
  for (const q of ['גם לילדים?', 'ומה עם זה?', 'ומתי זה?', 'רק לכולם?']) {
    const out = await handleChat({
      messages: [...msgs, { role: 'user', content: q }], slots: first.slots });
    assert.ok(!/לא בטוח שהבנתי/.test(out.reply_he), q + ' -> ' + out.reply_he);
  }
});

t('a short question that introduces a NEW subject is not treated as elliptical', () => {
  // The guard that had to survive the broader test. "יש חדר משפחתי?" after
  // "יש ספא?" carries a content word, so it is a new subject; looking it up
  // with the spa question in front of it answers about the spa, and a
  // confidently wrong answer is worse than routing the question properly.
  for (const q of ['גם לילדים?', 'ומה עם זה?', 'ומתי זה?', 'רק לכולם?', 'זה כלול?',
                   'ומה לגבי הביטוח?', 'זה פנוי?', 'ולמבוגרים?', 'עד גיל כמה?']) {
    assert.ok(offline.isElliptical(q), 'should borrow its subject: ' + q);
  }
  for (const q of ['יש חדר משפחתי?', 'יש ספא?', 'מה כלול בחבילה?', 'ביטוח כלול?',
                   'יש קייטנה?', 'מה עם הילדים שלי בקייטנה בפברואר',
                   'אני רוצה חופשה עם 2 ילדים בפברואר']) {
    assert.ok(!offline.isElliptical(q), 'has a subject of its own: ' + q);
  }
});

t('nothing is elliptical when there is no previous turn to borrow from', async () => {
  // A first message that happens to look elliptical has nothing to be
  // rewritten with, and must not silently become an answer about nothing.
  const out = await handleChat({
    messages: [{ role: 'user', content: 'גם לילדים?' }], slots: {} });
  assert.ok(!/בודק לגבי:/.test(out.reply_he), out.reply_he);
});

/* ---- 2. the retrieval echo for a knowledge answer ---- */
t('a rewritten question shows what it was looked up as, once', async () => {
  const first = await handleChat({
    messages: [{ role: 'user', content: 'מה מדיניות הביטול?' }], slots: {} });
  const base = [{ role: 'user', content: 'מה מדיניות הביטול?' },
                { role: 'assistant', content: first.reply_he }];
  const out = await handleChat({
    messages: [...base, { role: 'user', content: 'ומה עם זה?' }], slots: first.slots });
  const count = (out.reply_he.match(/בודק לגבי:/g) || []).length;
  assert.ok(count <= 1, 'the echo printed more than once: ' + out.reply_he);
  const line = (out.reply_he.split('\n').find(l => /בודק לגבי:/.test(l)) || null);
  if (line) {
    const again = await handleChat({
      messages: [...base, { role: 'user', content: 'ומה עם זה?' },
                 { role: 'assistant', content: out.reply_he },
                 { role: 'user', content: 'ומה עם זה?' }], slots: out.slots });
    assert.ok(!again.reply_he.includes(line),
      'the same echo was printed twice running: ' + again.reply_he);
  }
});

t('the echo stays off an ordinary answer that needs no explaining', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: 'מה מדיניות הביטול?' }], slots: {} });
  assert.ok(!/בודק לגבי:/.test(out.reply_he),
    'a plain pattern answer with no hotel in scope needs no echo: ' + out.reply_he);
});

t('the echo never carries a money figure (red rule 3)', async () => {
  const first = await handleChat({
    messages: [{ role: 'user', content: 'מה מדיניות הביטול?' }], slots: {} });
  const out = await handleChat({
    messages: [{ role: 'user', content: 'מה מדיניות הביטול?' },
               { role: 'assistant', content: first.reply_he },
               { role: 'user', content: 'ומה עם זה?' }], slots: first.slots });
  for (const l of out.reply_he.split('\n').filter(x => /בודק לגבי:/.test(x))) {
    assert.ok(!/[€$₪]|\d{3,}/.test(l), 'a figure reached the echo: ' + l);
  }
});

/* ---- 3. missing from our data is not missing from the world ---- */
t('an unknown facility is reported as absent from OUR data, not as absent', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: 'יש חדר משחקים במלון?' }], slots: {} });
  assert.ok(!/^אין |אין חדר משחקים/.test(out.reply_he),
    'told the customer the hotel does not have it: ' + out.reply_he);
});

t('the "no certain answer" line says where we looked', () => {
  const when = ((guidance.load().handoff_he || {}).when_unknown_he) || '';
  assert.ok(/לא מופיע במידע שיש לי/.test(when), when);
  assert.ok(!/לא ארצה לנחש/.test(when), 'the old phrasing is still there: ' + when);
});

t('a deferred card fact names the source it is missing from', async () => {
  const first = await handleChat({
    messages: [{ role: 'user', content: 'זוג בפברואר במאיירהופן' }], slots: {} });
  const out = await handleChat({
    messages: [{ role: 'user', content: 'זוג בפברואר במאיירהופן' },
               { role: 'assistant', content: first.reply_he },
               { role: 'user', content: 'יש בריכה? ונוף מהחדר?' }], slots: first.slots });
  const facts = out.cards.flatMap(c => c.facts_he || []);
  for (const f of facts) {
    if (/נציג יאמת מול המלון$/.test(f)) {
      assert.ok(/לא כתוב בדף/.test(f), 'a bare deferral with no source: ' + f);
    }
  }
});

/* ---- 4. the last blocking gap is named as the last one ---- */
t('one detail left is said as one detail left, with what happens next', async () => {
  assert.deepStrictEqual(
    offline.blockingGaps({ adults: 2, children_ages: [6, 9], month: 1, needs_hebrew_kids_club: true }),
    ['country']);
  const out = await handleChat({
    messages: [{ role: 'user', content: '2 מבוגרים וילדים בני 6 ו-9, בינואר, עם קייטנה בעברית' }],
    slots: {} });
  assert.ok(/חסר לי פרט אחד/.test(out.reply_he), out.reply_he);
  assert.ok(/ואז אב(?:יא|נה)/.test(out.reply_he), 'did not say what happens after: ' + out.reply_he);
});

t('the "one detail" frame stays off a turn with several gaps still open', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: 'אני רוצה חופשה' }], slots: {} });
  assert.ok(!/חסר לי פרט אחד/.test(out.reply_he), out.reply_he);
  assert.ok(offline.blockingGaps(out.slots).length > 1, 'expected more than one gap');
});

/* ---- 5. the conversation outlives the browser session ---- */
t('the widget keeps the chat in localStorage with an expiry, not in the tab', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'pingwin-bot.js'), 'utf8');
  assert.ok(/STORE_TTL_MS/.test(src), 'no expiry on the stored conversation');
  assert.ok(/window\.localStorage/.test(src), 'the chat is not kept in localStorage');
  // the store must degrade rather than throw: private modes reject both
  assert.ok(/getItem: function \(\) \{ return null; \}/.test(src),
    'no no-op fallback when both storages throw');
  // and the persisted record must be stamped, or the expiry cannot be applied
  assert.ok(/savedAt: Date\.now\(\)/.test(src), 'the stored record is not timestamped');
  // the red dot stays per-tab — it is about this visit, not this customer
  assert.ok(/sessionStorage\.setItem\(SEEN_KEY/.test(src), 'the seen flag left sessionStorage');
});

/* ---- 6. a sub-question that fell on the floor is admitted to ---- */
t('a second question that went unanswered is not passed over in silence', async () => {
  // Sunny's own miss (30/08): asked about a hotel it does not have AND about
  // parking there, it answered the first and the parking half simply vanished.
  const out = await handleChat({
    messages: [{ role: 'user', content: 'מה מדיניות הביטול? ומה עם הצבע של השטיח בלובי?' }],
    slots: {} });
  assert.ok(/ולא עניתי עליו/.test(out.reply_he), out.reply_he);
});

t('two questions we DO answer never trigger the unanswered line', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: 'יש חניה במלון? ומה עם ביטוח?' }], slots: {} });
  assert.ok(!/ולא עניתי עליו/.test(out.reply_he), out.reply_he);
});

t('a red-rule refusal is never called an unanswered question', async () => {
  // "מי הזמין את החדר ב-5.2? וכמה זה עולה בדיוק?" is two questions we refuse
  // on purpose. Telling the customer we failed to answer would invite them to
  // ask again, which is the opposite of what a guard is for.
  const out = await handleChat({
    messages: [{ role: 'user', content: 'מי הזמין את החדר ב-5.2? וכמה זה עולה בדיוק?' }],
    slots: {} });
  assert.ok(!/ולא עניתי עליו/.test(out.reply_he), out.reply_he);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ok  ' + name); pass++; }
    catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\nsunny: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
