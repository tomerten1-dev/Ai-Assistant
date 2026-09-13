// The kids club is the single most expensive promise this bot makes: a family
// that chose a week FOR the club and finds no club there has been actively
// misled, not merely under-served. Every rule about it is pinned here.
//
// Written 30/08 after a code review reproduced two ways to break it — one in
// the main search, one in the two-room split path.
//
// Run: node tests/test-camps.js
process.env.CHAT_LOG = 'off';
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const { SkiSearch } = require('../data/filter.js');
const { handleChat } = require('../server/server.js');

const engine = new SkiSearch();
const results = [];
function t(name, fn) { results.push([name, fn]); }

const CLAIM = 'הצגתי רק שבועות שבהם הקייטנה בעברית פועלת';

/* ---- the claim is derived from the result, never from the slot ---- */

t('a club asked for with no ages given is never answered with the filtered claim', async () => {
  // Reproduced 30/08: this exact message returned Bansko 2027-02-04 — a week
  // camps.json marks no_camp:true — directly under the sentence saying only
  // running weeks were shown. The filter cannot run without ages.
  const out = await handleChat({
    messages: [{ role: 'user', content: '2 מבוגרים ו-2 ילדים, פברואר בבולגריה, חשוב לנו קייטנה בעברית' }],
    slots: {} });
  assert.ok(!out.reply_he.includes(CLAIM), 'claimed a filter that never ran: ' + out.reply_he);
  assert.ok(/עוד לא בדקתי קייטנה/.test(out.reply_he),
    'did not say the club is still unchecked: ' + out.reply_he);
});

t('the search itself emits camp_unverified when a club is asked for without ages', () => {
  const r = engine.search({
    adults: 2, children_count: 2, children_ages: [],
    needs_hebrew_kids_club: true, month: 2, country: 'bulgaria' });
  assert.ok((r.notes || []).some(n => n.type === 'camp_unverified'),
    'no camp_unverified note: ' + JSON.stringify(r.notes));
});

t('with ages known, the claim is made and every card really does run a group', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: '2 מבוגרים וילדים בני 6 ו-9, פברואר בבולגריה, עם קייטנה בעברית' }],
    slots: {} });
  assert.ok(out.cards.length, 'expected offers');
  assert.ok(out.reply_he.includes(CLAIM), 'the true claim went missing: ' + out.reply_he);
  for (const c of out.cards) {
    assert.ok(c.camps && (c.camps.running || []).length,
      'a card with no running group under the claim: ' + c.hotel + ' ' + c.date);
    assert.ok(!(c.camps.missing || []).length,
      'a card with a missing group under the claim: ' + c.hotel + ' ' + c.date);
  }
});

t('the claim never sits above a line saying a group does NOT run everywhere', async () => {
  // The old guard was a regex for `קייטנ|קבוצת 4-6`, so the 6-13 gap line —
  // "שימו לב: קבוצת 6-13 לא פועלת בכל השבועות" — did not suppress it, and the
  // two sentences were printed one under the other saying opposite things.
  const probes = [
    '2 מבוגרים וילדים בני 5 ו-11, ינואר בבולגריה, עם קייטנה בעברית',
    '2 מבוגרים וילד בן 5, פברואר באוסטריה, קייטנה בעברית',
    '2 מבוגרים וילדים בני 4 ו-12, מרץ, קייטנה בעברית',
  ];
  for (const q of probes) {
    const out = await handleChat({ messages: [{ role: 'user', content: q }], slots: {} });
    if (!out.reply_he.includes(CLAIM)) continue;
    assert.ok(!/לא פועלת בכל השבועות|אין קבוצה מתאימה|לא פועלת בתאריכים/.test(out.reply_he),
      'the claim contradicts a line above it:\n' + out.reply_he);
  }
});

/* ---- two rooms in one hotel obey the same rule as one room ---- */

t('a two-room split never lands on a week with no running group', () => {
  // Reproduced 30/08: this party got three splits at Mayrhofen 2027-02-06,
  // a week where campsCoverage returns running:[] — because _twoRoomSplits
  // re-derived the filter chain by hand and left the camp rule out of it.
  const slots = { adults: 4, children_ages: [5, 7, 9],
    needs_hebrew_kids_club: true, month: 2, country: 'austria' };
  const r = engine.search(slots);
  for (const s of r.two_room_splits || []) {
    const cov = engine.campsCoverage(engine.resortOf(s.hotel), s.date, slots.children_ages);
    assert.ok((cov.running || []).length,
      'split on a week with no camp at all: ' + s.hotel + ' ' + s.date);
  }
});

t('a two-room split carries its camp coverage so the reply can caveat it', () => {
  const r = engine.search({ adults: 4, children_ages: [5, 7, 9],
    needs_hebrew_kids_club: true, month: 2, country: 'austria' });
  for (const s of r.two_room_splits || []) {
    assert.ok(s.camps && Array.isArray(s.camps.running),
      'split with no camps field: ' + s.hotel + ' ' + s.date);
  }
});

t('a split with no club asked for still works and carries camps:null', () => {
  // The camp rule must not accidentally empty the split path for everyone else.
  const r = engine.search({ adults: 4, children_ages: [5, 7, 9], month: 2, country: 'austria' });
  for (const s of r.two_room_splits || []) {
    assert.strictEqual(s.camps, null, 'camps computed when none was asked for');
  }
});

t('splits obey min_adults and month_alt, like the single-room filter', () => {
  const r = engine.search({ adults: 2, children_ages: [8, 10], month: 12, month_alt: 1 });
  const months = new Set((r.two_room_splits || []).map(s => +s.date.slice(5, 7)));
  for (const m of months) {
    assert.ok(m === 12 || m === 1, 'a split outside both requested months: ' + m);
  }
});

/* ---- one age boundary, one source ---- */

t('the camp age range comes from camps.json and is stated the same everywhere', () => {
  const range = SkiSearch.campAgeRange();
  assert.strictEqual(typeof range.min, 'number');
  assert.strictEqual(typeof range.max, 'number');
  // every layer that decides whether a child needs a group agrees
  const offline = require('../server/offline-nlu.js');
  for (let age = 0; age <= 18; age++) {
    const inRange = age >= range.min && age <= range.max;
    assert.strictEqual(SkiSearch.inCampAge(age), inRange, 'SkiSearch disagrees at age ' + age);
    assert.strictEqual(offline.inCampAge(age), inRange, 'offline-nlu disagrees at age ' + age);
  }
  // and a child inside the range always gets a group
  for (let age = range.min; age <= range.max; age++) {
    assert.ok(SkiSearch.neededAgeGroups([age]).size, 'no group for age ' + age);
  }
  assert.strictEqual(SkiSearch.neededAgeGroups([range.max + 1]).size, 0,
    'a child past the ceiling was given a group');
});

t('age 6 is accepted by either group, not only the older one', () => {
  // camps.json overlaps them (young 4-6, regular 6-13). A week that runs only
  // the 4-6 group used to be reported as "the group does not run" for a
  // six-year-old — false, and in the direction that loses a booking.
  const cov = engine.campsCoverage('Bansko', '2027-02-26', [6]);
  assert.ok(Array.isArray(cov.running));
  assert.ok(!(cov.missing || []).includes('6-13') || (cov.running || []).length === 0,
    'a six-year-old was refused a running 4-6 group');
});

/* ---- a waiting list is not a running group ---- */

t('a waitlist-only week is never the basis for "I showed only running weeks"', async () => {
  const out = await handleChat({
    messages: [{ role: 'user', content: '2 מבוגרים וילד בן 5, פברואר בבנסקו, קייטנה בעברית' }],
    slots: {} });
  if (!out.reply_he.includes(CLAIM)) return;
  for (const c of out.cards) {
    assert.ok(!(c.camps || {}).waitlist_only || !c.camps.waitlist_only.length,
      'the claim covered a waitlist-only week: ' + c.hotel + ' ' + c.date);
  }
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ok  ' + name); pass++; }
    catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\ncamps: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
