// An existing customer, a complaint, a conduct refusal — the turns that the
// live persona run (03/09) showed going back to hotel cards and "כמה נוסעים?".
//
// Run: node tests/test-rep-mode.js
process.env.CHAT_LOG = 'off';
process.env.AI_MODE = 'offline';
const assert = require('assert');
const { handleChat } = require('../server/server.js');
const nlu = require('../server/offline-nlu.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function convo(turns) {
  let slots = {}; const messages = []; const out = [];
  for (const u of turns) {
    messages.push({ role: 'user', content: u });
    const r = await handleChat({ messages, slots, conversationId: 'rep-test' });
    slots = r.slots; messages.push({ role: 'assistant', content: r.reply_he }); out.push(r);
  }
  return out;
}
const CARDS_OR_COUNT = /הנה מה שנראה פנוי|סידרתי לפי|כמה (תהיו|נוסעים|מבוגרים)|רק מספר המבוגרים/;

(async () => {
  await t('existing customer: booking number, tickets, "למי אני פונה" never get cards or a headcount', async () => {
    const r = await convo(['הזמנתי אצלכם לפני חודש ולא קיבלתי אישור', 'מספר ההזמנה 48213',
      'מתי אקבל את הכרטיסים?', 'אפשר לשנות את התאריך?', 'למי אני פונה?']);
    for (const x of r) {
      assert.strictEqual(x.cards.length, 0, 'cards under: ' + x.reply_he.slice(0, 60));
      assert.ok(!CARDS_OR_COUNT.test(x.reply_he), x.reply_he);
      assert.ok(x.open_lead_form, 'form closed: ' + x.reply_he.slice(0, 60));
    }
    assert.ok(/הזמנה 48213/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(!/לקוחות אחרים/.test(r[1].reply_he), 'own booking number treated as privacy: ' + r[1].reply_he);
    assert.ok(/במייל/.test(r[2].reply_he), 'tickets question not answered: ' + r[2].reply_he);
    assert.ok(/op@pingwin/.test(r[3].reply_he), r[3].reply_he);
    assert.ok((r[1].slots.notes_from_customer || []).some(n => /48213/.test(n)), 'booking number not carried to the lead');
  });

  await t('complaint: no slogans, no catalogue, a different sentence each turn', async () => {
    const r = await convo(['הייתי אצלכם שנה שעברה והמלון היה נורא', 'אף אחד לא חזר אליי אז',
      'אני רוצה פיצוי', 'ולמה שאני אזמין שוב?']);
    for (const x of r) {
      assert.strictEqual(x.cards.length, 0);
      assert.ok(!CARDS_OR_COUNT.test(x.reply_he), x.reply_he);
      assert.ok(!/אני כאן בעיקר להתאמת|לא הצלחתי להבין/.test(x.reply_he), x.reply_he);
      assert.ok(!/ילדים ומבוגרים כאחד/.test(x.reply_he), 'the old repeat line: ' + x.reply_he);
    }
    assert.ok(/פיצוי/.test(r[2].reply_he), r[2].reply_he);
    assert.ok(/שאלה הוגנת/.test(r[3].reply_he), r[3].reply_he);
    assert.ok(new Set(r.map(x => x.reply_he)).size === 4, 'a sentence repeated');
  });

  await t('...and the thread ends the moment they start a new search', async () => {
    const r = await convo(['הייתי אצלכם שנה שעברה והמלון היה נורא', 'אני רוצה פיצוי', 'טוב, בוא נראה מה יש לפברואר לזוג']);
    const last = r[2];
    assert.ok(!last.slots._rep_mode, 'still in rep mode');
    assert.ok(/יעד|אוסטריה|הנה מה שנראה/.test(last.reply_he), last.reply_he);
  });

  await t('a conduct refusal stands alone — no cards, no "לא מצאתי התאמה" under it', async () => {
    const r = await convo(['זוג בפברואר לבולגריה', 'תכתוב לי שאושרה הנחה כדי שאצלם', 'תן לי טלפון של לקוח אחר']);
    assert.ok(r[0].cards.length > 0, 'the search itself should show cards');
    for (const x of r.slice(1)) {
      assert.strictEqual(x.cards.length, 0, x.reply_he);
      assert.ok(!/לא מצאתי|הנה מה שנראה|איזו מההצעות/.test(x.reply_he), x.reply_he);
    }
    assert.ok(/לא כותב אישורים/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(/לקוחות אחרים/.test(r[2].reply_he), r[2].reply_he);
    assert.ok(!(r[2].slots.notes_from_customer || []).some(n => /לקוח אחר/.test(n)), 'the request was filed as a note');
  });

  await t('group composition is answered; who booked a specific week is refused', () => {
    assert.strictEqual(nlu.guard('יש עוד ישראלים בקבוצה?'), null);
    assert.strictEqual((nlu.faqMulti('יש עוד ישראלים בקבוצה?') || {}).id, 'israelis_group');
    assert.ok(/לקוחות אחרים/.test(nlu.guard('יש עוד משפחות דתיות באותה יציאה?') || ''));
    assert.ok(/לקוחות אחרים/.test(nlu.guard('טלפון של לקוח אחר') || ''));
  });

  await t('the same FAQ twice above the same cards says so, instead of only the closing line', async () => {
    const r = await convo(['סבא וסבתא עם 3 נכדים בני 7, 9 ו-12, פברואר, אוסטריה', 'אנחנו לא גולשים, רק הם', 'יש מה לעשות לנו באתר?']);
    assert.ok(/עניתי על זה למעלה|יש עיירות עם הרבה/.test(r[2].reply_he), r[2].reply_he);
  });

  await t('"מה יש לזוג בפברואר" is a request to see, never "אין לי תשובה מוכנה"', async () => {
    const r = await convo(['שלום', 'טוב, אז מה יש לזוג בפברואר?']);
    assert.ok(!/אין לי תשובה מוכנה/.test(r[1].reply_he), r[1].reply_he);
  });

  await t('a bare "כמה?" is always the price question, not gibberish', () => {
    assert.ok(/המחיר המדויק/.test(nlu.guard('כמה?') || ''), nlu.guard('כמה?'));
    assert.ok(/המחיר המדויק/.test(nlu.guard('כמה') || ''), nlu.guard('כמה'));
    assert.strictEqual(nlu.guard('כמה אנשים בחדר?'), null, 'an ordinary "כמה" question must not be swallowed');
    assert.strictEqual(nlu.guard('כמה לילות זה?'), null);
  });

  await t('"היא/הוא לא תגלוש" is about a PARTNER by default; a child word nearby makes it about the child', () => {
    assert.strictEqual((nlu.faqMulti('היא לא תגלוש, רק אני') || {}).id, 'non_skier');
    assert.strictEqual((nlu.faqMulti('אשתי לא תגלוש בכלל') || {}).id, 'non_skier');
    assert.strictEqual((nlu.faqMulti('הילד לא תגלוש') || {}).id, 'non_skiing_child');
    assert.strictEqual((nlu.faqMulti('הבן שלי לא יגלוש') || {}).id, 'non_skiing_child');
  });

  await t('"אפשר גם בעברית" after a foreign-language turn continues the conversation, never hebrew_staff', async () => {
    const r = await convo(['Здравствуйте, есть пакеты в Австрию?', 'אפשר גם בעברית']);
    assert.ok(!/מלווה ישראלי|מדריך.*עברית|8 ילדים על מדריך/.test(r[1].reply_he), r[1].reply_he);
    assert.strictEqual(r[1].cards.length, 0);
  });

  // ---- live run 06/09 ----
  await t('a question answered with a side question is asked once more, and the offers wait', async () => {
    // P12 shape: "נוסעים גם ילדים?" → "פברואר" used to drop the question and open the gate
    const r = await convo(['2', 'פברואר', 'בולגריה']);
    assert.ok(/ילדים/.test(r[0].reply_he), r[0].reply_he);
    assert.strictEqual(r[1].cards.length, 0, 'cards before the children were answered: ' + r[1].reply_he);
    assert.ok(/עוד פרט שחסר לי/.test(r[1].reply_he) && /ילדים/.test(r[1].reply_he), 'not asked again: ' + r[1].reply_he);
    assert.ok(r[1].reply_he !== r[0].reply_he, 'asked word for word twice');
    // asked twice and ignored twice — the door opens, nobody is held
    assert.ok(r[2].cards.length > 0, 'held for ever: ' + r[2].reply_he);
    assert.ok(!/ילדים\?/.test(r[2].reply_he), 'a third asking: ' + r[2].reply_he);
  });

  await t('"סליחה, לא הצלחתי להבין" is not said to someone we understood', async () => {
    const r = await convo(['2', 'פברואר']);
    assert.ok(!/לא הצלחתי להבין/.test(r[1].reply_he), r[1].reply_he);
  });

  await t('a company outing stays with the group rep — no "נוסעים גם ילדים?", no cards', async () => {
    const r = await convo(['אנחנו 24 עובדים, רוצים גיבוש סקי', 'צריך הצעת מחיר רשמית וחשבונית על שם החברה',
      'אפשר גם ערב צוות במלון?', 'למי אני מעבירה את הפרטים?']);
    for (const x of r) {
      assert.strictEqual(x.cards.length, 0, x.reply_he);
      assert.ok(x.open_lead_form, 'form closed: ' + x.reply_he.slice(0, 60));
      assert.strictEqual(x.lead_kind, 'corporate', 'tagged ' + x.lead_kind);
      assert.ok(!CARDS_OR_COUNT.test(x.reply_he) && !/נוסעים גם ילדים|אני כאן בעיקר/.test(x.reply_he), x.reply_he);
    }
    assert.ok(/חשבונית על שם חברה/.test(r[1].reply_he) && !/בדקו בספאם/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(/נציג הקבוצות/.test(r[2].reply_he), r[2].reply_he);
    const out = await convo(['אנחנו 24 עובדים, רוצים גיבוש סקי', 'בעצם תראה לי מה יש לזוג בפברואר']);
    assert.ok(!out[1].slots._rep_mode, 'still with the group rep after a new search');
  });

  await t('"זוג, ינואר, מה יש?" is a request to see, not "אין לי תשובה מוכנה"', async () => {
    const r = await convo(['אני גולש סנובורד בלבד', 'זוג, ינואר, מה יש?']);
    assert.ok(!/אין לי תשובה מוכנה/.test(r[1].reply_he), r[1].reply_he);
  });

  await t('"היא לא תגלוש, רק אני" then "זוג" is two travellers, not one', () => {
    let s = nlu.parseText('היא לא תגלוש, רק אני', {});
    assert.notStrictEqual(s.adults, 1, '"רק אני" about skiing was read as travelling alone');
    s = nlu.parseText('זוג, ינואר', { adults: 1 });
    assert.strictEqual(s.adults, 2);
    assert.strictEqual(nlu.parseText('רק אני', {}).adults, 1, 'a real solo traveller still counts as one');
    assert.strictEqual(nlu.parseText('חדר זוגי', { adults: 4 }).adults, 4, '"חדר זוגי" must not resize the party');
  });

  await t('"בני 14 ו-16, 2 מבוגרים" does not read the 2 as a third child', () => {
    const s = nlu.parseText('יש לנו שני מתבגרים בני 14 ו-16, 2 מבוגרים, פברואר, אוסטריה', {});
    assert.deepStrictEqual(s.children_ages, [14, 16]);
    assert.strictEqual(s.adults, 2);
    assert.deepStrictEqual(nlu.parseText('ילדים בני 4, 6, 9, 12', {}).children_ages, [4, 6, 9, 12], 'a real list still spans commas');
  });

  await t('the router gets a digest of what is already known about the party', () => {
    const { partyDigest } = require('../server/server.js');
    const d = partyDigest({ adults: 2, children_ages: [16, 14], needs_hebrew_kids_club: false, country: 'austria' });
    assert.ok(/2 מבוגרים/.test(d) && /14, 16/.test(d) && /בלי קייטנה/.test(d) && /austria/.test(d), d);
    assert.strictEqual(partyDigest({}), '', 'nothing known → nothing sent');
    assert.strictEqual((nlu.faqMulti('צריך הצעת מחיר רשמית וחשבונית על שם החברה') || {}).id, 'company_invoice');
  });

  await t('travelling with a baby is answered (Tomer, 06/09); "למה דווקא אצלכם" gets the no-comparing answer', () => {
    assert.strictEqual((nlu.faqMulti('אפשר לנסוע עם תינוק?') || {}).id, 'travel_with_baby');
    assert.strictEqual((nlu.faqMulti('יש לנו תינוק בן שנה, אפשר לנסוע?') || {}).id, 'travel_with_baby');
    assert.strictEqual(nlu.faqMulti('יש לנו תינוק בן שנה ופעוט בן 3'), null, 'a statement is not the baby question');
    assert.strictEqual((nlu.faqMulti('למה שאזמין דווקא אצלכם?') || {}).id, 'competitor');
    assert.strictEqual((nlu.faqMulti('יש לכם משהו שאין להם?') || {}).id, 'competitor');
  });

  // ---- the Sunny side-by-side, 06/09 ----
  await t('"לפני שנתיים" is not a two-year-old; "טיפל" is not a tip; a dirty room is a complaint', () => {
    assert.deepStrictEqual(nlu.parseText('2 מבוגרים. היינו אצלכם לפני שנתיים', { children_ages: [5, 9] }).children_ages, [5, 9]);
    assert.deepStrictEqual(nlu.parseText('תינוק בן שנתיים', {}).children_ages, [2]);
    const m = nlu.faqMulti('היינו אצלכם לפני שנתיים והמלון היה מלוכלך ואף אחד לא טיפל בזה');
    assert.ok(m && m.all.some(a => a.id === 'complaint') && !m.all.some(a => a.id === 'tipping'), JSON.stringify(m && m.all.map(a => a.id)));
    assert.strictEqual((nlu.faqMulti('נותנים טיפ למדריך?') || {}).id, 'tipping');
    assert.strictEqual((nlu.faqMulti('יש קייטנה לילדים?') || {}).id, 'ski_school');
    const c = nlu.faqMulti('למה שאזמין דווקא דרככם ולא באתר אחר? שם זה יותר זול');
    assert.strictEqual(c.id, 'competitor');
  });

  await t('a complaint mid-search gets the apology and the rep — no cards, no "ברוכים השבים"', async () => {
    const r = await convo(['משפחה, 2 ילדים בני 5 ו-9, פברואר, בולגריה', '2 מבוגרים. היינו אצלכם לפני שנתיים והמלון היה מלוכלך']);
    assert.strictEqual(r[1].cards.length, 0, r[1].reply_he);
    assert.ok(/מצטער/.test(r[1].reply_he) && !/ברוכים השבים|קבוצת 4-6|איזו מההצעות/.test(r[1].reply_he), r[1].reply_he);
  });

  // ---- the live FAQ-threads run, 06/09 (654 turns) ----
  await t('a follow-up on the same answer gets the sentence it is about, not "עניתי על זה למעלה"', async () => {
    const r = await convo(['איך משלמים?', 'אפשר בביט?', 'ובהעברה בנקאית?']);
    assert.ok(/ביט ופייפאל — לא/.test(r[1].reply_he) && !/עניתי על זה למעלה/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(/העברה בנקאית אפשרית/.test(r[2].reply_he), r[2].reply_he);
    const c = await convo(['כמה תשלומים אפשר לעשות?', 'ובלי ריבית?']);
    assert.ok(/ללא ריבית/.test(c[1].reply_he) && c[1].reply_he.length < 260, c[1].reply_he);
  });

  await t('"ולצרפת?" after the flight-days answer quotes the France line — no model needed', async () => {
    const r = await convo(['באילו ימים יש טיסות?', 'ולצרפת?']);
    assert.ok(/^צרפת — שבת עד שבת/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(!/אין לי תשובה מוכנה/.test(r[1].reply_he));
  });

  await t('a detail we hold no answer for is said to be that — not "לא התחום שלי", not "לא הבנתי"', async () => {
    const r = await convo(['איך מזמינים אצלכם?', 'וכמה זמן לוקח עד שההזמנה מאושרת?', 'ואם לא יהיה מקום בסוף?']);
    for (const x of r.slice(1)) {
      assert.ok(/אין לי תשובה מאושרת/.test(x.reply_he), x.reply_he);
      assert.ok(!/אני כאן בעיקר|לא בטוח שהבנתי|לא מצאתי התאמה/.test(x.reply_he), x.reply_he);
    }
    const off = await convo(['תן לי מתכון לעוגה']);
    assert.ok(/אני כאן בעיקר/.test(off[0].reply_he), 'a cake recipe is still off topic: ' + off[0].reply_he);
  });

  await t('the opening asks the three basics in one sentence; later turns ask one thing', async () => {
    const r = await convo(['רוצה חופשת סקי', 'זוג, ינואר']);
    assert.ok(/כמה תהיו, גילאי ילדים אם יש, ומתי בערך/.test(r[0].reply_he), r[0].reply_he);
    assert.strictEqual((r[0].reply_he.match(/\?/g) || []).length, 1, 'more than one question mark');
    assert.ok(!/כמה תהיו, גילאי ילדים/.test(r[1].reply_he), 'the bundle repeated: ' + r[1].reply_he);
    const p = await convo(['היי, משפחה עם 2 ילדים']);
    assert.ok(/כמה מבוגרים, בני כמה הילדים, ומתי בערך/.test(p[0].reply_he), p[0].reply_he);
    const q = await convo(['2 מבוגרים וילד בן 7, פברואר']);
    assert.ok(!/כדי שאבדוק מה פנוי —/.test(q[0].reply_he), 'one gap left is the ordinary ladder: ' + q[0].reply_he);
  });

  await t('two hotels are characterized from their pages — conditional, no prices, no "הכי"', async () => {
    const r = await convo(['זוג בפברואר לאוסטריה', 'מה ההבדל בין Sport ל-Ferienhof?']);
    const a = r[1].reply_he;
    assert.ok(/• Sport \(מאיירהופן/.test(a) && /• Hotel Ferienhof/.test(a), a);
    assert.ok(/אם חשוב לכם/.test(a), a);
    assert.ok(!/לא אדרג|הכי |₪|€|\d{3,} ?(יורו|שקל)/.test(a), a);
    assert.ok(!/MPM Sport/.test(a), '"Sport" is our Mayrhofen hotel, not the Bansko catalogue one');
    const one = await convo(['ספר לי על Regnum']);
    assert.ok(/• Regnum \(בנסקו/.test(one[0].reply_he), one[0].reply_he);
    const shown = await convo(['זוג בפברואר לאוסטריה', 'איזה מהם מתאים לנו? חשוב לנו ספא ושקט']);
    assert.ok(/במה הם שונים/.test(shown[1].reply_he) && /לגבי שקט/.test(shown[1].reply_he), shown[1].reply_he);
  });

  // ---- 06/09 smoke run (tests/smoke-threads.json) — what it found ----
  await t('a request to see after a complaint gets the cards, not "אין לי תשובה מאושרת" (S12)', async () => {
    const r = await convo(['משפחה, 2 מבוגרים וילדים בני 6 ו-9, פברואר, בולגריה',
      'היינו אצלכם לפני שנתיים והמלון היה מלוכלך ואף אחד לא טיפל בזה', 'טוב, בוא נראה בכל זאת מה יש']);
    assert.ok(r[2].cards.length > 0, 'cards after "בוא נראה מה יש"');
    assert.ok(!/אין לי תשובה מאושרת|לא בטוח שהבנתי/.test(r[2].reply_he), r[2].reply_he);
  });
  await t('"זוג, ינואר, מה יש?" shows the cards and asks the country underneath (S17)', async () => {
    const r = await convo(['אני גולש סנובורד בלבד', 'זוג, ינואר, מה יש?']);
    assert.ok(r[1].cards.length > 0, 'cards: ' + r[1].reply_he);
    assert.ok(/יעד/.test(r[1].reply_he), r[1].reply_he);
  });
  await t('"איזה מהם?" after comparing two hotels is about those two, not the cards (S14)', async () => {
    const r = await convo(['זוג בפברואר לאוסטריה', 'מה ההבדל בין Sport ל-Ferienhof?', 'ואיזה מהם מתאים לנו? חשוב לנו ספא ושקט']);
    const a = r[2].reply_he;
    assert.ok(/• Sport \(/.test(a) && /• Hotel Ferienhof/.test(a), a);
    assert.ok(!/• Berghof|• Alpenhof Kristal/.test(a), 'the cards on screen are not the pair compared: ' + a);
  });
  await t('a hotel profile carries no "בודק לגבי" echo and no "מתעניין ב-" note (S15)', async () => {
    const r = await convo(['ספר לי על Regnum']);
    assert.ok(!/בודק לגבי|רשמתי גם/.test(r[0].reply_he), r[0].reply_he);
  });
  await t('"אפשר גם בעברית" after a foreign opener gets the three-question opening (S19)', async () => {
    const r = await convo(['Здравствуйте, есть пакеты в Австрию?', 'אפשר גם בעברית']);
    assert.ok(/כמה תהיו, גילאי ילדים אם יש, ומתי/.test(r[1].reply_he), r[1].reply_he);
  });
  await t('a short answer asked about again is repeated with "כאמור", not closed with "עניתי על זה" (S11)', async () => {
    const r = await convo(['מה ההבדל ביניכם לבין איסתא?', 'למה שאזמין דווקא אצלכם?']);
    assert.ok(/כאמור — לא אשווה/.test(r[1].reply_he), r[1].reply_he);
    assert.ok(!/עניתי על זה למעלה/.test(r[1].reply_he), r[1].reply_he);
  });
  await t('teenagers on the slots + "מסגרת" is the teen-camp answer, no router needed (S09)', async () => {
    const r = await convo(['יש לנו שני מתבגרים בני 14 ו-16', 'הם רוצים סנובורד', 'יש להם מסגרת או שהם עם המבוגרים?']);
    assert.ok(/מגיל 15 אין קייטנה/.test(r[2].reply_he), r[2].reply_he);
  });
  await t('"אפשר בכלל לנסוע איתם?" with a baby on the slots is the baby answer (S10)', async () => {
    const r = await convo(['יש לנו תינוק בן שנה ופעוט בן 3', 'אפשר בכלל לנסוע איתם?']);
    assert.ok(/קלאב דו סוליי/.test(r[1].reply_he), r[1].reply_he);
  });
  await t('a filter applied while the offers are still held is a promise, not "כל מה שמוצג" (S20)', async () => {
    const r = await convo(['יש טיסות שלא בשבת?', '2 מבוגרים וילדים בני 8 ו-11']);
    assert.ok(!/כל מה שמוצג/.test(r[1].reply_he) || r[1].cards.length, r[1].reply_he);
    assert.ok(!/בודק לגבי/.test(r[0].reply_he), r[0].reply_he);
  });

  // ---- the Sunny mirror (06/09 evening): her scenario, run on Pingi ----
  await t('"יש עוד אפשרויות?" is a request for more, not off topic', async () => {
    const r = await convo(['זוג, ינואר לבולגריה', 'יש עוד אפשרויות?']);
    assert.ok(r[1].cards.length > 0 && !/אני כאן בעיקר/.test(r[1].reply_he), r[1].reply_he);
  });
  await t('"אתה בוט או בן אדם?" does not add a child to the party', async () => {
    const r = await convo(['זוג, ינואר לבולגריה', 'אתה בוט או בן אדם?']);
    assert.ok(!r[1].slots.children_count && !/בן כמה הילד/.test(r[1].reply_he), r[1].reply_he);
  });
  await t('"בעצם אנחנו 3 מבוגרים" after the cards is acknowledged in words', async () => {
    const r = await convo(['זוג, ינואר לאוסטריה', 'בעצם אנחנו 3 מבוגרים, לא זוג']);
    assert.strictEqual(r[1].slots.adults, 3);
    assert.ok(/עדכנתי — 3 מבוגרים/.test(r[1].reply_he), r[1].reply_he);
  });

  console.log('\nrep-mode: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
