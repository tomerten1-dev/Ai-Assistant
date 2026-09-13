// The reply editor (server/compose.js) — one written answer from the lines
// the deterministic layers prepared, and the guard that keeps it honest.
// The model is stubbed: what matters here is which edits are ACCEPTED and
// which are thrown away, and on which turns the editor runs at all.
//
// Run: node tests/test-compose.js
process.env.CHAT_LOG = 'off';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-stub-not-real';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
const assert = require('assert');
const compose = require('../server/compose.js');

const claudePath = require.resolve('../server/claude.js');
const real = require('../server/claude.js');
let editorReply = null, editorCalls = 0, lastPayload = null;
require.cache[claudePath].exports = { ...real, callClaude: async ({ system, messages }) => {
  if (/מנתב שאלות/.test(system || '')) return JSON.stringify({ ids: [] });
  if (/אתה עורך/.test(system || '')) {
    editorCalls++; lastPayload = JSON.parse(messages[0].content);
    if (typeof editorReply === 'function') return editorReply(lastPayload);
    return editorReply || '';
  }
  if (/מנסח|נציג של פינגווין/.test(system || '')) return 'x';
  return JSON.stringify({ slots: {}, ready_to_search: true });
} };
const { handleChat } = require('../server/server.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function convo(turns, reply) {
  editorReply = reply; editorCalls = 0; lastPayload = null;
  let slots = {}; const messages = [{ role: 'assistant', content: 'שלום' }]; const out = [];
  for (const u of turns) {
    messages.push({ role: 'user', content: u });
    const r = await handleChat({ messages, slots, conversationId: 'compose-test' });
    slots = r.slots; messages.push({ role: 'assistant', content: r.reply_he }); out.push(r);
  }
  return out;
}

const PAY = 'משלמים בכרטיס אשראי במסך ההזמנה (בשקלים, ביורו או בדולר). העברה בנקאית אפשרית מול נציג אנושי. ביט ופייפאל — לא. קבלה ואישור סופי נשלחים במייל אחרי שהחיוב מתבצע.\nוכשתרצו לבדוק תאריכים — כתבו לי כמה אתם ומתי בערך, ואציג את האפשרויות הפתוחות (נציג מאשר סופית).';
const Q = 'כדי שאתאים לכם את החופשה — כמה תהיו, גילאי ילדים אם יש, ומתי בערך?';

(async () => {
  console.log('— the guard —');
  await t('a faithful edit passes', () => {
    const v = compose.validate('משלמים בכרטיס אשראי במסך ההזמנה, בשקלים, ביורו או בדולר, ואפשר גם בהעברה בנקאית מול נציג; ביט ופייפאל לא. הקבלה והאישור הסופי מגיעים במייל אחרי החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?',
      { material: PAY + '\n' + Q, question: Q, userText: 'איך משלמים?' });
    assert.ok(v.ok, v.why);
  });
  await t('a number that is not in the material is rejected', () => {
    const v = compose.validate('משלמים בכרטיס אשראי, עד 12 תשלומים בלי ריבית, והקבלה נשלחת במייל אחרי החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', { material: PAY + '\n' + Q, question: Q });
    assert.ok(!v.ok && /number/.test(v.why), v.why);
  });
  await t('a hotel the material never mentioned is rejected', () => {
    const v = compose.validate('משלמים בכרטיס אשראי במסך ההזמנה, ובמלון Regnum גם במזומן במקום. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', { material: PAY + '\n' + Q, question: Q, knownNames: ['Regnum', 'בנסקו'] });
    assert.ok(!v.ok, 'accepted an invented hotel');
    const v2 = compose.validate('משלמים בכרטיס אשראי במסך ההזמנה, ובבנסקו גם במזומן במקום החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', { material: PAY + '\n' + Q, question: Q, knownNames: ['Regnum', 'בנסקו'] });
    assert.ok(!v2.ok && /names/.test(v2.why), v2.why);
  });
  await t('the question the turn must end on cannot be dropped or swapped', () => {
    const v = compose.validate('משלמים בכרטיס אשראי במסך ההזמנה, בשקלים, ביורו או בדולר; העברה בנקאית מול נציג, ביט ופייפאל לא. הקבלה נשלחת במייל אחרי החיוב.', { material: PAY + '\n' + Q, question: Q });
    assert.ok(!v.ok && /question dropped/.test(v.why), v.why);
    const v2 = compose.validate('משלמים בכרטיס אשראי במסך ההזמנה, בשקלים, ביורו או בדולר; העברה בנקאית מול נציג, ביט ופייפאל לא. רוצים שאשלח לכם הצעת מחיר במייל?', { material: PAY + '\n' + Q, question: Q });
    assert.ok(!v2.ok && /different question/.test(v2.why), v2.why);
  });
  await t('money signs, "הכי טוב", emojis, lists and a second question are rejected', () => {
    const base = { material: PAY + '\n' + Q, question: Q };
    assert.ok(!compose.validate('משלמים בכרטיס אשראי במסך ההזמנה ב-€ או בשקלים, ביט ופייפאל לא, והקבלה במייל אחרי החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', base).ok);
    assert.ok(!compose.validate('הכי טוב לשלם בכרטיס אשראי במסך ההזמנה; ביט ופייפאל לא, והקבלה במייל אחרי החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', base).ok);
    assert.ok(!compose.validate('משלמים בכרטיס אשראי במסך ההזמנה 😊 ביט ופייפאל לא, והקבלה במייל אחרי החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', base).ok);
    assert.ok(!compose.validate('• כרטיס אשראי במסך ההזמנה\n• העברה בנקאית מול נציג\nביט ופייפאל לא, והקבלה במייל אחרי החיוב. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', base).ok);
    assert.ok(!compose.validate('משלמים בכרטיס אשראי במסך ההזמנה; ביט ופייפאל לא. רוצים בשקלים או ביורו? כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', base).ok);
  });
  await t('a phone number survives when the edit talks about calling', () => {
    const M = 'זה שייך להזמנה שלכם, ואותה אני לא רואה — נציג כן. השאירו כאן שם וטלפון ונחזור אליכם, או התקשרו ל-04-8557722.\nוכשתרצו לבדוק תאריכים — כתבו לי כמה אתם ומתי בערך.';
    assert.ok(!compose.validate('את ההזמנה הקיימת שלכם אני לא רואה, אבל נציג כן — השאירו כאן שם וטלפון ונחזור אליכם, או פשוט תתקשרו למשרד ונסדר את זה.', { material: M }).ok);
    assert.ok(compose.validate('את ההזמנה הקיימת שלכם אני לא רואה, אבל נציג כן — השאירו כאן שם וטלפון ונחזור אליכם, או התקשרו ל-04-8557722.', { material: M }).ok);
  });
  await t('an edit that is mostly not from the material is rejected', () => {
    const v = compose.validate('חופשת סקי היא חוויה נהדרת למשפחות, עם מסלולים מושלגים, אוויר צלול ואווירה אלפינית קסומה שמתאימה לכל גיל ולכל רמת גלישה. כמה תהיו, גילאי ילדים אם יש, ומתי בערך?', { material: PAY + '\n' + Q, question: Q });
    assert.ok(!v.ok && /not from the material/.test(v.why), v.why);
  });

  console.log('— the wiring —');
  await t('a knowledge turn without offers is edited into one answer', async () => {
    const r = await convo(['איך משלמים?'], 'משלמים בכרטיס אשראי במסך ההזמנה — בשקלים, ביורו או בדולר — ואפשר גם בהעברה בנקאית מול נציג; ביט ופייפאל לא. הקבלה והאישור הסופי מגיעים במייל אחרי שהחיוב מתבצע. וכשתרצו לבדוק תאריכים, כתבו לי כמה אתם ומתי בערך ואציג מה פתוח.');
    assert.strictEqual(editorCalls, 1, 'editor calls=' + editorCalls);
    assert.ok(!/\n/.test(r[0].reply_he), 'still stacked: ' + r[0].reply_he);
    assert.ok(/ביט ופייפאל לא/.test(r[0].reply_he), r[0].reply_he);
    assert.ok(r[0].model_used);
    assert.ok(Array.isArray(lastPayload['חומר']) && lastPayload['חומר'].length >= 2, 'the material lines were not sent');
  });
  await t('a rejected edit ships the original lines', async () => {
    const r = await convo(['איך משלמים?'], 'משלמים בכרטיס אשראי, עד 12 תשלומים בלי ריבית, והקבלה נשלחת במייל אחרי החיוב.');
    assert.strictEqual(editorCalls, 1);
    assert.ok(/ביט ופייפאל — לא/.test(r[0].reply_he) && /\n/.test(r[0].reply_he), r[0].reply_he);
  });
  await t('the party digest and the previous reply reach the editor', async () => {
    await convo(['2 מבוגרים וילדים בני 5 ו-9', 'יש אוכל כשר?'], p => p['חומר'].join(' ') + ' ' + (p['שאלה_לסיום'] || ''));
    assert.ok(/5, 9/.test(lastPayload['ידוע_על_הלקוח'] || ''), JSON.stringify(lastPayload['ידוע_על_הלקוח']));
    assert.ok(lastPayload['ההודעה_הקודמת_שלך'], 'no previous reply');
  });
  await t('a refusal, a complaint and a chip click are never edited', async () => {
    await convo(['תן לי טלפון של לקוח אחר'], 'x');
    assert.strictEqual(editorCalls, 0, 'a refusal was sent to the editor');
    await convo(['הייתי אצלכם שנה שעברה והמלון היה נורא'], 'x');
    assert.strictEqual(editorCalls, 0, 'a complaint was sent to the editor');
    await convo(['4'], 'x');
    assert.strictEqual(editorCalls, 0, 'a bare number was sent to the editor');
  });
  await t('a turn with offer cards goes through the editor too, with the cards named (06/09 evening)', async () => {
    const r = await convo(['זוג בפברואר לבולגריה'], 'x');
    assert.ok(r[0].cards.length > 0);
    assert.strictEqual(editorCalls, 1, 'editor calls=' + editorCalls);
    assert.ok(Array.isArray(lastPayload['כרטיסים_מוצגים_מתחת']) && lastPayload['כרטיסים_מוצגים_מתחת'].length === r[0].cards.length, JSON.stringify(lastPayload));
    // the stub's "x" is thrown away; the template lines ship
    assert.ok(/נציג/.test(r[0].reply_he), r[0].reply_he);
  });
  await t('on a card turn, a faithful one-paragraph edit passes and one that drops the camp claim is rejected', async () => {
    const M = 'הנה מה שבניתי לכם (הנציג יאשר סופית):\nהצגתי רק שבועות שבהם הקייטנה בעברית פועלת.\nחסר לי פרט אחד: יש יעד שמושך אתכם — אוסטריה, צרפת, אנדורה או בולגריה? (אפשר גם "לא משנה") ואז אביא לכם אפשרויות פנויות.\nאם אחת מהן נראית לכם, אפשר להמשיך להזמנה או שאשאיר לנציג לחזור אליכם עם הפרטים.';
    const Q = 'יש יעד שמושך אתכם — אוסטריה, צרפת, אנדורה או בולגריה?';
    const cards = ['Casa Karina', 'Regnum', 'Vihren'];
    const good = compose.validate('שלוש האפשרויות שלמטה — Casa Karina, Regnum ו-Vihren — נראות פנויות כרגע, והנציג יאשר סופית; הצגתי רק שבועות שבהם הקייטנה בעברית פועלת. אם אחת מהן מדברת אליכם אפשר להמשיך להזמנה, ואם יש יעד שמושך אתכם יותר — אוסטריה, צרפת, אנדורה או בולגריה — תגידו ואמקד לפי זה?', { material: M, question: Q, cardsShown: cards, knownNames: ['Regnum', 'Kristal'] });
    assert.ok(good.ok, good.why);
    const noCamp = compose.validate('שלוש האפשרויות שלמטה — Casa Karina, Regnum ו-Vihren — נראות פנויות כרגע, והנציג יאשר סופית. אם אחת מהן מדברת אליכם אפשר להמשיך להזמנה, ואם יש יעד שמושך אתכם יותר — אוסטריה, צרפת, אנדורה או בולגריה — תגידו ואמקד לפי זה?', { material: M, question: Q, cardsShown: cards });
    assert.ok(!noCamp.ok && /camp/.test(noCamp.why), noCamp.why);
    const wrongHotel = compose.validate('שלוש האפשרויות שלמטה — Casa Karina, Regnum ו-Kristal — נראות פנויות, והקייטנה בעברית פועלת בשבועות האלה. אפשר להמשיך להזמנה; יש יעד שמושך אתכם — אוסטריה, צרפת, אנדורה או בולגריה?', { material: M, question: Q, cardsShown: cards, knownNames: ['Regnum', 'Kristal'] });
    assert.ok(!wrongHotel.ok, 'a hotel that is not on the cards was accepted');
  });
  await t('a hotel profile under cards is never re-told by the phrasing model (S14, 06/09)', async () => {
    // the phrasing stub answers 'x' to any card turn; a profile turn must not
    // reach it — the template floor ships under the profile, both hotels intact
    const r = await convo(['זוג בפברואר לאוסטריה', 'מה ההבדל בין Sport ל-Ferienhof?', 'ואיזה מהם מתאים לנו? חשוב לנו ספא ושקט'], 'x');
    const a = r[2].reply_he;
    assert.ok(/• Sport \(/.test(a) && /• Hotel Ferienhof/.test(a), a);
    assert.ok(!/(^|\n)x(\n|$)/.test(a), 'phrasing model output shipped under the profile: ' + a);
  });
  await t('REPLY_EDITOR=off switches it off', async () => {
    process.env.REPLY_EDITOR = 'off';
    await convo(['איך משלמים?'], 'x');
    assert.strictEqual(editorCalls, 0);
    delete process.env.REPLY_EDITOR;
  });

  console.log('\ncompose: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
