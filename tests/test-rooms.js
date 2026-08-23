// Room-level facts from the pingwin.co.il hotel pages: the matcher, the
// closed-universe guarantee (never name a room the hotel page does not list),
// and the package rules Tomer stated (ski pass, equipment, transfers).
const assert = require('assert');
const { SkiSearch } = require('../data/filter');
const { matchRoom, roomFacts } = require('../data/room-match');
const nlu = require('../server/offline-nlu');
const resorts = require('../data/resorts.json');
const raw = require('../data/rooms-raw.json');
const inclusions = require('../config/inclusions.json');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.log('  \u2717 ' + name + '\n      ' + e.message); fail++; }
}

const search = new SkiSearch();

t('every hotel has room data from the site', () => {
  for (const [name, info] of Object.entries(resorts.hotels)) {
    assert.ok(Array.isArray(info.rooms) && info.rooms.length, name + ' has no rooms[]');
  }
});

t('room data carries no order numbers (PII gate, spec 2a)', () => {
  assert.ok(!/\d{6}/.test(JSON.stringify(raw)), 'a 6-digit sequence appears in rooms-raw.json');
});

t('closed universe: a named room always exists on that hotel page', () => {
  for (const u of require('../data/availability.json').units) {
    const rooms = (resorts.hotels[u.hotel] || {}).rooms || [];
    const hit = matchRoom(u.room, rooms);
    if (!hit) continue;
    assert.ok(rooms.some(r => r.name === hit.name),
      u.hotel + ': invented room "' + hit.name + '"');
  }
});

t('an ambiguous match returns no room rather than the wrong one', () => {
  // Tignes sells a CONNECTED pair; the hotel page describes no connected unit
  const rooms = resorts.hotels['Belambra Tignes Val Claret'].rooms;
  assert.strictEqual(matchRoom('CONN Premium with View 5 pax', rooms, 5), null);
});

t('matching is party-aware where one workbook room spans two site rooms', () => {
  const rooms = resorts.hotels['Club Soleil Oz'].rooms;
  assert.strictEqual(matchRoom('DBL 2-4', rooms, 2).name, 'חדר 1-2');
  assert.strictEqual(matchRoom('DBL 2-4', rooms, 4).name, 'חדר 3-4');
});

t('ambiguity still yields facts when every candidate agrees', () => {
  const rooms = resorts.hotels['Club Soleil Montgenevre'].rooms;
  const f = roomFacts('DBL 2-4', rooms);
  assert.strictEqual(f.exact, false);
  assert.ok(f.beds_he, 'both Montgenevre rooms share a bed layout — it should be stated');
});

t('bulgaria never claims the ski pass is included (Tomer, 23/08/2026)', () => {
  const r = search.search({ adults: 2, children_ages: [], country: 'bulgaria' });
  assert.ok(r.candidates.length, 'no bulgarian candidates to check');
  for (const c of r.candidates) {
    assert.strictEqual(c.ski_pass_included, false, c.hotel);
    assert.strictEqual(c.ski_pass_he, null, c.hotel);
  }
});

t('the four Club Soleil hotels include equipment', () => {
  const named = inclusions.equipment_rental.included_at_he;
  for (const h of named) assert.ok(resorts.hotels[h], 'unknown hotel in inclusions.json: ' + h);
  const r = search.search({ adults: 2, children_ages: [], destination: 'Les 2 Alpes' });
  const cs = r.candidates.filter(c => named.includes(c.hotel));
  for (const c of cs) assert.strictEqual(c.equipment_included, true, c.hotel);
});

t('no numeric equipment price reaches the customer (red rule 3)', () => {
  const slots = nlu.parseText('כמה עולה השכרת ציוד סקי?');
  const r = search.search({ ...slots, adults: 2, children_ages: [] });
  const cards = r.candidates.slice(0, 3);
  nlu.phrase(r, slots, cards);
  for (const c of cards) {
    for (const f of c.facts_he || []) {
      assert.ok(!/\d{2,3}\s*(יורו|אירו|€)/.test(f), 'price leaked: ' + f);
    }
  }
});

t('asking about beds gets an answer or a named follow-up, never silence', () => {
  const slots = nlu.parseText('2 חברים, חשוב מיטות נפרדות, בפברואר');
  const r = search.search(slots);
  const cards = r.candidates.slice(0, 3);
  nlu.phrase(r, slots, cards);
  assert.ok(cards.length, 'no cards');
  for (const c of cards) {
    const facts = (c.facts_he || []).join(' ');
    assert.ok(/מיטות|נציג יאמת/.test(facts), c.hotel + ' said nothing about beds');
  }
});

t('board basis and transfer come from the hotel page verbatim', () => {
  const slots = nlu.parseText('אנחנו זוג, מחפשים ארוחת בוקר כלולה ונסיעה קצרה מהשדה');
  const r = search.search({ ...slots, month: 2 });
  const cards = r.candidates.slice(0, 3);
  nlu.phrase(r, slots, cards);
  for (const c of cards) {
    const info = resorts.hotels[c.hotel];
    const facts = (c.facts_he || []).join(' | ');
    if (info.board_he) assert.ok(facts.includes(info.board_he), c.hotel + ' board not quoted');
    if (info.transfer_he) assert.ok(facts.includes(info.transfer_he), c.hotel + ' transfer not quoted');
  }
});

t('transfers are stated as included, once, for everyone', () => {
  const slots = nlu.parseText('ההסעות משדה התעופה כלולות?');
  const r = search.search({ ...slots, adults: 2, children_ages: [] });
  const text = nlu.phrase(r, slots, r.candidates.slice(0, 3));
  assert.ok(/הסעות משדה התעופה למלון ובחזרה כלולות/.test(text), text);
});


t('the board basis asked for outranks merely having one', () => {
  const slots = nlu.parseText('אני ואשתי, ינואר, מחפשים פנסיון מלא');
  assert.strictEqual(slots.board_wanted, 'full');
  const r = search.search(slots);
  const top = r.candidates[0];
  assert.ok(/פנסיון מלא|הכל כלול/.test(resorts.hotels[top.hotel].board_he || ''),
    'top offer is ' + top.hotel + ' with board "' + resorts.hotels[top.hotel].board_he + '"');
});

t('bathroom questions are answered from the hotel page', () => {
  const slots = nlu.parseText('זוג במרץ, כמה מקלחות ושירותים בחדר?');
  assert.ok(slots.unverifiable.includes('חדרי רחצה'), JSON.stringify(slots.unverifiable));
  const r = search.search(slots);
  const cards = r.candidates.slice(0, 3);
  nlu.phrase(r, slots, cards);
  assert.ok(cards.some(c => (c.facts_he || []).some(f => /חדרי רחצה/.test(f))), 'no bathroom answer');
});

t('two rooms in the requested country beat one room somewhere else', () => {
  const r = search.search({ adults: 6, children_ages: [], country: 'austria', month: 3 });
  assert.strictEqual(r.candidates.length, 0, 'expected no single unit for six');
  assert.ok(r.two_room_splits.length, 'no two-room split offered');
  assert.ok(!r.relaxed.some(x => x.type === 'location'), 'destination was dropped instead of splitting');
});

t('the France-February note never promises offers that are not there', () => {
  const slots = { adults: 5, children_ages: [], country: 'france', month: 2 };
  const r = search.search(slots);
  const text = nlu.phrase(r, slots, []);
  assert.ok(!/הנה מה שפנוי/.test(text), text);
});

t('a package-wide question is answered, not deferred to the booking screen', () => {
  const a = nlu.deflect('סקי פס כלול?');
  assert.ok(/אוסטריה, צרפת ואנדורה/.test(a), a);
  assert.ok(/בבולגריה/.test(a), a);
  const b = nlu.deflect('מה כלול בחבילה?');
  assert.ok(/הסעות משדה התעופה/.test(b), b);
  assert.ok(!/[0-9]/.test(b), 'a package summary must carry no numbers (red rule 3): ' + b);
});


t('no bulgarian hotel carries a ski-pass claim at all (Tomer: ignore the page)', () => {
  for (const [name, info] of Object.entries(resorts.hotels)) {
    if (info.country !== 'bulgaria') continue;
    assert.strictEqual(info.ski_pass_he, null, name + ' still claims: ' + info.ski_pass_he);
  }
});

t('the equipment supplement stays a number the customer never sees', () => {
  assert.strictEqual(inclusions.equipment_rental._show_price_to_customer, false);
  const say = inclusions.equipment_rental.supplement_he;
  assert.ok(!/[0-9]/.test(say), 'supplement wording carries a number: ' + say);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
