// The model now writes the customer-facing reply (Tomer, 24/08). That is only
// safe because of two things, and this suite pins both:
//
//   1. it never sees inventory — only the offers the deterministic filter
//      already chose, so there is nothing to hallucinate FROM;
//   2. whatever it returns must survive validate(), or the templated wording
//      ships instead. The template is the floor; the model can only improve on
//      it, never regress past it.
//
// Run: node tests/test-phrase-guard.js
const assert = require('assert');
const phrasing = require('../server/prompt-phrase');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

const CARDS = [
  { hotel: 'Casa Karina', resort: 'Bansko', country_he: 'בולגריה', date: '2027-02-05',
    date_label: null, nights: 7, room: 'Standard 2-3', occ: { max: 3 }, camps: null,
    facts_he: ['בסיס אירוח: חצי פנסיון + שתייה'], tags: ['ספא'], recommended: false },
  { hotel: 'Regnum', resort: 'Bansko', country_he: 'בולגריה', date: '2027-02-04',
    date_label: null, nights: 3, room: 'Deluxe Suite 2-4', occ: { max: 4 }, camps: null,
    facts_he: [], tags: [], recommended: true },
];
const OK = { cards: CARDS, fallback: 'הנה מה שנראה פנוי אצלנו (הנציג יאשר סופית):' };

const good = 'מצאתי שתי אפשרויות בבנסקו שנראות פנויות — קאזה קארינה לשבוע שלם, ורגנום לסוף שבוע קצר. הנציג יאשר סופית.';

t('a reasonable Hebrew reply passes', () => {
  assert.strictEqual(phrasing.validate(good, OK).ok, true);
});

t('an empty or huge reply is refused', () => {
  assert.strictEqual(phrasing.validate('', OK).ok, false);
  assert.strictEqual(phrasing.validate('   ', OK).ok, false);
  assert.strictEqual(phrasing.validate('א'.repeat(900), OK).ok, false);
});

// red rule 3 — this is the one a model is most likely to break, by being helpful
t('a price in any currency is refused', () => {
  for (const bad of [
    'המחיר הוא 4500 ₪ לאדם', 'זה יוצא בערך 1200 יורו', 'כ-350 אירו לאדם',
    'עולה 990 שקל', 'רק 250$ לאדם', 'תוספת של 100 ש"ח',
  ]) {
    const v = phrasing.validate(bad, OK);
    assert.strictEqual(v.ok, false, 'accepted: ' + bad);
    assert.strictEqual(v.why, 'price', bad + ' → ' + v.why);
  }
});

t('an order number is refused (red rule 2)', () => {
  const v = phrasing.validate('ההזמנה שלכם 483920 מאושרת', OK);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.why, 'order number');
});

t('a hotel we did not offer is refused (red rule 1)', () => {
  const v = phrasing.validate('אפשר גם את Vihren באותו שבוע', OK);
  assert.strictEqual(v.ok, false);
  assert.ok(/hotel not offered/.test(v.why), v.why);
});

t('a hotel we DID offer is fine', () => {
  assert.strictEqual(phrasing.validate('Casa Karina נראה מתאים לכם', OK).ok, true);
});

t('a date we never offered is refused', () => {
  const v = phrasing.validate('יש גם יציאה ב-19.3 שיכולה להתאים', OK);
  assert.strictEqual(v.ok, false);
  assert.ok(/invented date/.test(v.why), v.why);
});

t('a date that came from the template is allowed through', () => {
  // the deterministic layer legitimately names camp weeks and open dates
  const withDates = { cards: CARDS, fallback: 'קבוצת 4-6 פועלת ב-15.1, 26.2 ו-19.3.' };
  assert.strictEqual(phrasing.validate('הקבוצה פועלת ב-26.2, כדאי לשקול', withDates).ok, true);
});

t('an offered date is allowed', () => {
  assert.strictEqual(phrasing.validate('היציאה ב-5.2 נראית פנויה', OK).ok, true);
});

t('a promise of availability is refused (red rule 4)', () => {
  for (const bad of ['החדר מובטח לכם', 'אני מבטיח שזה פנוי', 'מבטיחים לכם מקום']) {
    assert.strictEqual(phrasing.validate(bad, OK).ok, false, 'accepted: ' + bad);
  }
});

t('a flight time is refused (red rule 8)', () => {
  const v = phrasing.validate('הטיסה ממריאה ב-06:40 בבוקר', OK);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.why, 'flight time');
});

t('"הכי טוב" is refused (red rule 6)', () => {
  assert.strictEqual(phrasing.validate('זה המלון הכי טוב שלנו', OK).ok, false);
  assert.strictEqual(phrasing.validate('זה מלון מומלץ אצלנו', OK).ok, true);
});

t('internal vocabulary is refused', () => {
  const v = phrasing.validate('המלון לא נמצא בהתחייבויות שלנו', OK);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.why, 'internal wording');
});

t('the payload carries offers but never the inventory', () => {
  const payload = phrasing.buildPayload({
    slots: { adults: 2, children_ages: [], month: 2, country: 'bulgaria' },
    cards: CARDS,
    result: { notes: [{ type: 'applied_requirements', items: ['x'] }], relaxed: [] },
    fallback: OK.fallback,
  });
  const obj = JSON.parse(payload);
  assert.strictEqual(obj.הצעות.length, 2);
  // no room codes, counts or sheet names from the workbook
  assert.ok(!/count_available|sheet|occ_notation|price_range/.test(payload), payload.slice(0, 200));
  // and no hotel that was not offered
  assert.ok(!payload.includes('Vihren'));
});

t('a digest never carries how many units are left', () => {
  const d = phrasing.cardDigest({ ...CARDS[0], count_available: 4, sheet: 'בנסקו סופ"ש' });
  assert.strictEqual(d.count_available, undefined);
  assert.strictEqual(d.sheet, undefined);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
