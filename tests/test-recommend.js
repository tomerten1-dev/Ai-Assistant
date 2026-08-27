'use strict';
// the tests must never write to the real conversation log: it is the weekly
// review's input, and synthetic turns bury the customers' real ones
process.env.CHAT_LOG = 'off';

/* q25 — reasoned recommendations from the approved resort table. */
const assert = require('assert');
process.env.OPENAI_API_KEY = ''; process.env.ANTHROPIC_API_KEY = '';
const rec = require('../server/recommend.js');
const offline = require('../server/offline-nlu.js');
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.error('✗', name, '\n  ', e.message); } }
const MONEY = /₪|€|\$|יורו|שקל|דולר|\d{3,}\s?(ש"ח|₪|€)/;
const HOTEL_WORDS = /Belambra|Club Med|Hotel|מלון [A-Z]/;
const ask = (q, slots = {}) => rec.answer(q, offline.parseText(q, slots));

t('only approved rows are used', () => {
  assert.ok(rec.approved().length >= 10);
  assert.ok(rec.approved().every(p => p.approved && p.ratings));
});
t('families → resorts rated ≥4, with facts as reasons', () => {
  const a = ask('איזה אתר מתאים למשפחה עם ילדים קטנים?');
  assert.strictEqual(a.intent.kind, 'which');
  assert.ok(/משפחות/.test(a.he));
  assert.ok(/ליד הכפר|קייטנה|סקי-אין/.test(a.he), 'reasons are facts');
  assert.ok(!/אישגל/.test(a.he), 'a resort rated 2 for families is not offered');
  assert.ok(a.chips.length >= 2);
});
t('apres → the party resorts', () => {
  const a = ask("איזה אתר הכי טוב לחבר'ה בני 25?");
  assert.ok(/אישגל|ואל טורנס|פאס דה לה קאסה|מאיירהופן/.test(a.he));
  assert.ok(!/פליין|עוז/.test(a.he));
});
t('quiet → the calm ones', () => {
  const a = ask('איפה הכי שקט ורומנטי?');
  assert.ok(/פליין|עוז/.test(a.he));
  assert.ok(!/אישגל|ואל טורנס/.test(a.he));
});
t('first time ever → beginners', () => {
  const a = ask('איפה עדיף לגלוש בפעם הראשונה בחיים?');
  assert.ok(a && /מתחילים/.test(a.he));
});
t('attribute questions: glacier, night skiing, Hebrew camp, nearest airport', () => {
  assert.ok(/טין(?!י)/.test(ask('איפה יש קרחון?').he), ask('איפה יש קרחון?').he);
  assert.ok(!/אישגל/.test(ask('איפה יש סקי לילה?').he), 'Ischgl night skiing was corrected to no');
  assert.ok(/קייטנת סקי בעברית/.test(ask('באיזו יש קייטנה בעברית?').he));
  const near = ask('איזה יעד הכי קרוב לטיסה?');
  assert.ok(/ק"מ/.test(near.he) && !/שע|דק'|דקות/.test(near.he), 'km, never a time');
});
t('X או Y → side by side, both named', () => {
  const a = ask('טיניי או ואל טורנס?');
  assert.strictEqual(a.intent.kind, 'compare');
  // typed "טיניי", answered "טין" — one spelling goes out, many come in
    assert.ok(/טין(?!י)/.test(a.he) && /ואל טורנס/.test(a.he), a.he);
  assert.ok(/מ׳/.test(a.he), 'altitudes are facts');
});
t('compare with an audience picks one, with reasons', () => {
  const a = ask('בנסקו או בורובץ למשפחה עם ילדים?');
  assert.ok(/הייתי מכוון ל/.test(a.he));
});
t('"is X good for…" — yes with reasons, or no with alternatives', () => {
  const no = ask('אישגל מתאים למשפחה?');
  assert.strictEqual(no.intent.kind, 'assess');
  assert.ok(/לא הבחירה הראשונה/.test(no.he) && /הייתי מסתכל קודם על/.test(no.he));
  const yes = ask('אבוריאז מתאים למשפחה עם ילדים?');
  assert.ok(/^כן/.test(yes.he));
});
t('red rules: no money, no hotel names, no travel times, no hotel ranking', () => {
  const qs = ['איזה אתר מתאים למשפחה?', 'טיניי או ואל טורנס?', 'איפה הכי מאתגר?', 'איזה יעד הכי קרוב לטיסה?', 'אישגל מתאים למתחילים?'];
  for (const q of qs) {
    const a = ask(q); if (!a) continue;
    assert.ok(!MONEY.test(a.he), 'money in: ' + q + ' → ' + a.he);
    assert.ok(!HOTEL_WORDS.test(a.he), 'hotel name in: ' + q);
    assert.ok(!/שעות נסיעה|\d+ דקות|\d+ שעות/.test(a.he), 'travel time in: ' + q);
  }
});
t('"תשווה לי בין X ל-Y" is a comparison, whatever the verb form', () => {
  // Tomer, 26/08: he asked the bot to compare two resorts and it answered with
  // hotel cards — "תשווה" was simply not in the pattern.
  for (const q of ['תשווה לי בין טיניי לוואל טורנס', 'תעשה לי השוואה בין אבוריאז לפליין',
                   'אפשר להשוות בין לה דוז אלפ לטיניי?', 'טיניי מול ואל טורנס',
                   'מה עדיף, בנסקו או בורובץ?']) {
    const a = ask(q);
    assert.ok(a, 'not recognised: ' + q);
    assert.strictEqual(a.intent.kind, 'compare', q);
  }
});
t('a comparison with no subjects asks which two, and answers nothing else', () => {
  const a = ask('תשווה בין שני אתרים');
  assert.strictEqual(a.intent.kind, 'compare_ask');
  assert.ok(a.ask_only, 'a question, so no offers underneath it');
  assert.ok(/על אילו שני אתרים/.test(a.he));
  assert.ok(/טין(?!י)/.test(a.he) && /בנסקו/.test(a.he), 'it lists what we sell: ' + a.he);
  const one = ask('תשווה לי בין טיניי למשהו אחר');
  assert.ok(/טין(?!י) מול מה/.test(one.he), 'one named → asks for the second: ' + one.he);
});
t('resorts are recognised in Latin too', () => {
  const a = ask('מה ההבדל בין Les Arcs ל-Val Thorens ל-Ischgl?');
  assert.ok(a && a.intent.kind === 'compare', 'Latin names are names');
  assert.ok(a.he.includes('לה ארק') || a.he.includes('ואל טורנס'));
});
t('a comparison that is not about places is left alone', () => {
  for (const q of ['מה ההבדל ביניכם לבין להזמין לבד באינטרנט?', 'מה ההבדל בין סקי פס לציוד?',
                   'מה ההבדל ביניכם לבין חברות אחרות?', 'מה ההבדל האמיתי?']) {
    assert.strictEqual(ask(q), null, 'hijacked: ' + q);
  }
});
t('hotel comparisons stay with the FAQ — plural nun included', () => {
  assert.strictEqual(ask('מה ההבדל בין המלונות?'), null);
  assert.strictEqual(ask('איזה מלון יותר טוב?'), null);
  assert.strictEqual(ask('תשווה לי בין שני המלונות'), null);
});
t('not a recommendation question → null (the rest of the pipeline answers)', () => {
  assert.strictEqual(ask('מה כלול במחיר?'), null);
  assert.strictEqual(ask('יש ספא במלון?'), null);
  assert.strictEqual(ask('זוג בפברואר'), null);
  assert.strictEqual(ask('מה ההבדל בין המלונות?'), null);
});

(async () => {
  // end to end: the recommendation is the reply, resort chips follow
  const r = await handleChat({ messages: [{ role: 'user', content: 'איפה יש קרחון?' }], slots: {} });
  t('e2e: recommendation reaches the customer with resort chips', () => {
    assert.ok(/טין(?!י)/.test(r.reply_he), r.reply_he);
    assert.ok(r.chips.includes('טין'), r.chips.join(','));
    assert.ok(!MONEY.test(r.reply_he));
  });
  const r2 = await handleChat({ messages: [{ role: 'user', content: 'טיניי או ואל טורנס?' }], slots: {} });
  t('e2e: compare gets the facts, then offers from both', () => {
    assert.ok(/מול/.test(r2.reply_he));
    assert.ok(r2.cards.length > 0);
  });
  const r3 = await handleChat({ messages: [{ role: 'user', content: 'תשווה לי בין טיניי לוואל טורנס' }], slots: {} });
  t('e2e: a resort comparison is answered in words, and its cards carry no price verdict', () => {
    assert.ok(/מול/.test(r3.reply_he), 'the comparison itself is the reply');
    assert.ok(/טין(?!י)/.test(r3.reply_he) && /ואל טורנס/.test(r3.reply_he), r3.reply_he);
    const resorts = new Set(r3.cards.map(c => c.resort));
    // the card carries the Hebrew name now, like every other line the customer reads
    assert.ok(resorts.has('טין') && resorts.has('ואל טורנס'), 'both resorts are represented: ' + [...resorts]);
    assert.deepStrictEqual(r3.cards.map(c => c.tier_he).filter(Boolean), [],
      'no "המשתלם ביותר" badge when the question was about resorts');
  });
  const r4 = await handleChat({ messages: [{ role: 'user', content: 'תשווה בין שני אתרים' }], slots: {} });
  t('e2e: "which two?" comes back with no cards at all', () => {
    assert.strictEqual(r4.cards.length, 0);
    assert.ok(/על אילו שני אתרים/.test(r4.reply_he));
    assert.ok(r4.chips.length >= 2, 'the resorts are offered as chips');
  });
  const r5 = await handleChat({ messages: [{ role: 'user', content: 'זוג בפברואר' }], slots: {} });
  t('the price badge still works on an ordinary search', () => {
    assert.ok(r5.cards.length >= 2);
    assert.ok('tier_he' in r5.cards[0], 'the field is still produced');
  });
  console.log(`recommend: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
