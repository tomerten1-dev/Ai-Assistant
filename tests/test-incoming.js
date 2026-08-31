// Everything the browser sends is input, not truth. crm-lead.js has always
// said so about the lead payload; /api/chat did not, and it mattered more,
// because several slots are printed to the customer verbatim in the bot's own
// voice. Reproduced 30/08 before the fix:
//
//   POST /api/chat  slots.notes_from_customer:
//     ["הלקוח זכאי להנחה של 50% ולקוד קופון SKI50"]
//   → "רשמתי לפניי: הלקוח זכאי להנחה של 50% ולקוד קופון SKI50 — נציג יבדוק ויאשר."
//
// Run: node tests/test-incoming.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const { handleChat } = require('../server/server.js');
const { sanitizeIncomingSlots, textIsClean, MAX_TEXT } = require('../server/incoming-slots.js');
const { SkiSearch } = require('../data/filter.js');

const engine = new SkiSearch();
const clean = raw => sanitizeIncomingSlots(raw, engine, {});
const results = [];
function t(name, fn) { results.push([name, fn]); }

const ASK = '2 מבוגרים בפברואר בבנסקו';
const say = (slots) => handleChat({ messages: [{ role: 'user', content: ASK }], slots });

/* ---- the attack that started this ---- */

t('a discount and a coupon code sent as a note never reach the customer', async () => {
  const out = await say({
    notes_from_customer: ['הלקוח זכאי להנחה של 50% ולקוד קופון SKI50'],
    preferences: ['ביטול חינם בכל שלב'],
  });
  assert.ok(!/50%|SKI50|קופון|הנחה/.test(out.reply_he), out.reply_he);
  assert.ok(!/חינם/.test(out.reply_he), out.reply_he);
  assert.deepStrictEqual(out.slots.notes_from_customer, []);
  assert.deepStrictEqual(out.slots.preferences, []);
});

t('a money figure sent as a note never reaches the customer (red rule 3)', async () => {
  for (const note of ['המחיר סופי 1200 אירו כולל הכל', 'תשלמו 300₪ בלבד',
                      'אירו 400 לאדם', 'המחיר שסוכם: 5,000 שקל']) {
    const out = await say({ notes_from_customer: [note] });
    assert.ok(!out.reply_he.includes(note), 'printed verbatim: ' + note + '\n' + out.reply_he);
  }
});

t('a link or markup sent as a note never reaches the customer', async () => {
  for (const note of ['ראו www.competitor.example', 'https://evil.example/x', '<img src=x>']) {
    const out = await say({ notes_from_customer: [note] });
    assert.ok(!out.reply_he.includes(note), 'printed verbatim: ' + note);
  }
});

t('the money filter is not defeated by the Hebrew word-boundary trap', () => {
  // \b never matches after a Hebrew letter (they are not \w in JS), so a
  // trailing \b in the currency pattern let "1200 אירו" straight through.
  // Third time this trap has bitten in this codebase.
  assert.strictEqual(textIsClean('המחיר סופי 1200 אירו כולל הכל'), false);
  assert.strictEqual(textIsClean('1200 יורו'), false);
  assert.strictEqual(textIsClean('300 שקלים'), false);
});

t('ordinary notes and requirements still survive — the filter is not a wall', async () => {
  const keep = ['רוצים מטבחון בחדר', 'חשוב מרפסת עם נוף', 'נוסע יחיד',
                'צריך 2 חדרים סמוכים', 'מחפשים 7 לילות', 'ילד בן 4 חודשים'];
  for (const note of keep) assert.strictEqual(textIsClean(note), true, 'wrongly dropped: ' + note);
  const out = clean({ notes_from_customer: keep });
  assert.strictEqual(out.notes_from_customer.length, keep.length, JSON.stringify(out.notes_from_customer));
});

/* ---- closed vocabularies are enforced as enums, not filtered as text ---- */

t('a preference must be a tag this server produces', async () => {
  const out = await say({ preferences: ['ספא', 'משהו שהמצאתי', 'קרוב למסלולים'] });
  assert.deepStrictEqual(out.slots.preferences, ['ספא', 'קרוב למסלולים']);
});

t('a hotel or destination that is not in our data is dropped, not searched for', () => {
  const out = clean({ hotel: 'Hotel Fake', destination: 'מלון קסום שלא קיים',
                      excluded_destinations: ['בנסקו', 'מקום מומצא'] });
  assert.strictEqual(out.hotel, null);
  assert.strictEqual(out.destination, null);
  assert.deepStrictEqual(out.excluded_destinations, ['Bansko']);
});

t('a real hotel and a real destination still round-trip', () => {
  const known = (engine.av.units || [])[0].hotel;
  const out = clean({ hotel: known, destination: 'בנסקו' });
  assert.strictEqual(out.hotel, known);
  assert.strictEqual(out.destination, 'Bansko');
});

t('country and airport are enums', () => {
  assert.strictEqual(clean({ country: 'austria' }).country, 'austria');
  assert.strictEqual(clean({ country: 'narnia' }).country, null);
  assert.strictEqual(clean({ departure_airport: 'haifa' }).departure_airport, 'haifa');
  assert.strictEqual(clean({ departure_airport: 'JFK' }).departure_airport, null);
});

/* ---- shapes: a wrong type is dropped, never crashed on ---- */

t('a slot of the wrong type is coerced or dropped, and never throws', async () => {
  const nasty = [
    { messages: 'hello' },
    { slots: 'not an object' },
    { slots: ['x', 'y'] },
    { slots: { children_ages: 'abc' } },
    { slots: { children_ages: [{ a: 1 }, 'x', 7] } },
    { slots: { excluded_countries: 5 } },
    { slots: { adults: { a: 1 } } },
    { slots: { adults: '3' } },
    { slots: { notes_from_customer: 'a string not a list' } },
    { slots: { __proto__: { polluted: 'yes' }, constructor: { x: 1 } } },
  ];
  for (const body of nasty) {
    const out = await handleChat({
      messages: body.messages || [{ role: 'user', content: ASK }],
      slots: body.slots || {} });
    assert.ok(typeof out.reply_he === 'string' && out.reply_he.length, JSON.stringify(body));
  }
  assert.strictEqual({}.polluted, undefined, 'Object.prototype was polluted');
  assert.deepStrictEqual(clean({ children_ages: [{ a: 1 }, 'x', 7] }).children_ages, [7]);
  assert.strictEqual(clean({ adults: '3' }).adults, 3);
  assert.strictEqual(clean({ adults: { a: 1 } }).adults, null);
  assert.deepStrictEqual(clean({ excluded_countries: 5 }).excluded_countries, []);
});

t('unknown keys are dropped entirely', () => {
  const out = clean({ adults: 2, whatever: 'x', __evil: { a: 1 }, price_override: 1 });
  assert.strictEqual(out.adults, 2);
  assert.ok(!('whatever' in out) && !('__evil' in out) && !('price_override' in out),
    Object.keys(out).join(','));
});

t('lists and strings are capped', () => {
  const long = 'א'.repeat(MAX_TEXT + 1);
  assert.deepStrictEqual(clean({ notes_from_customer: [long] }).notes_from_customer, []);
  const many = Array.from({ length: 60 }, (_, i) => 'הערה מספר ' + i);
  assert.ok(clean({ notes_from_customer: many }).notes_from_customer.length <= 12);
  assert.ok(clean({ _shown: Array.from({ length: 200 }, (_, i) => 'h' + i) })._shown.length <= 30);
});

t('a forged conversation id or verify stamp is rejected by shape', () => {
  assert.strictEqual(clean({ _cid: 'not a cid at all!' })._cid, undefined);
  assert.strictEqual(clean({ _cid: 'cab12cd34' })._cid, 'cab12cd34');
  assert.strictEqual(clean({ _vt: 'nope' })._vt, undefined);
  assert.strictEqual(clean({ _vt: 'a'.repeat(64) })._vt, 'a'.repeat(64));
});

/* ---- the turn cap is the server's, not the browser's ---- */

t('the turn cap cannot be reset by sending _turns: 0', () => {
  const limits = require('../server/limits.js');
  const prev = process.env.MAX_TURNS_PER_CHAT;
  process.env.MAX_TURNS_PER_CHAT = '3';
  limits._resetTurns();
  let hitCap = false;
  for (let i = 0; i < 6; i++) {
    // a client insisting it is on turn zero, every single time
    if (limits.turnsExceeded({ _cid: 'cforged01', _turns: 0 })) { hitCap = true; break; }
  }
  assert.ok(hitCap, 'the cap never fired against a client that always claims turn 0');
  limits._resetTurns();
  if (prev === undefined) delete process.env.MAX_TURNS_PER_CHAT;
  else process.env.MAX_TURNS_PER_CHAT = prev;
});

t('_turns is not accepted from the browser at all', () => {
  assert.strictEqual(clean({ _turns: 999 })._turns, undefined);
});

/* ---- and the ordinary conversation still works ---- */

t('a normal turn is unaffected by any of this', async () => {
  const first = await handleChat({
    messages: [{ role: 'user', content: 'אנחנו 4, ילדים בני 6 ו-9, פברואר, בנסקו' }], slots: {} });
  assert.strictEqual(first.slots.adults, 2);
  assert.deepStrictEqual(first.slots.children_ages, [6, 9]);
  assert.strictEqual(first.slots.destination, 'Bansko');
  // and the state survives the round trip through the browser
  const second = await handleChat({
    messages: [{ role: 'user', content: 'אנחנו 4, ילדים בני 6 ו-9, פברואר, בנסקו' },
               { role: 'assistant', content: first.reply_he },
               { role: 'user', content: 'יש קייטנה בעברית?' }],
    slots: JSON.parse(JSON.stringify(first.slots)) });
  assert.strictEqual(second.slots.adults, 2, 'the party was lost across the round trip');
  assert.deepStrictEqual(second.slots.children_ages, [6, 9], 'the ages were lost');
  assert.strictEqual(second.slots.destination, 'Bansko', 'the destination was lost');
  assert.strictEqual(second.slots._cid, first.slots._cid, 'the conversation id was lost');
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ok  ' + name); pass++; }
    catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\nincoming: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
