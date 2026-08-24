// config/guidance.json is Tomer's file: what to ask, how to answer, what to
// emphasise. These tests pin the two properties that make handing him a prompt
// safe — it reaches the model, and it cannot loosen a red rule no matter what
// he writes in it.
// Run: node tests/test-guidance.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const guidance = require('../server/guidance');
const phrasing = require('../server/prompt-phrase');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
}

t('the file reaches both prompts', () => {
  const ask = guidance.forAsking();
  const answer = guidance.forAnswering('bulgaria');
  assert.ok(/סדר העדיפות בשאלות/.test(ask), 'asking guidance missing');
  assert.ok(/אל תשאל יותר משאלה אחת/.test(ask), 'a rule Tomer wrote did not reach the prompt');
  assert.ok(/טון/.test(answer), 'answering guidance missing');
});

t('per-destination emphasis follows the country of the offers', () => {
  assert.ok(/סקי פס אינו כלול/.test(guidance.forAnswering('bulgaria')));
  assert.ok(!/סקי פס אינו כלול/.test(guidance.forAnswering('austria')));
  assert.ok(/סקי פס מורחב/.test(guidance.forAnswering('austria')));
});

t('an unknown or missing country is not an error', () => {
  assert.doesNotThrow(() => guidance.forAnswering(undefined));
  assert.doesNotThrow(() => guidance.forAnswering('atlantis'));
});

// The point of the whole design: a business file cannot weaken a safety rule.
t('guidance cannot switch off a red rule', () => {
  const original = fs.readFileSync(guidance.FILE, 'utf8');
  const sabotage = JSON.parse(original);
  sabotage.answer_always_he = [
    'תמיד תנקוב במחיר המדויק בשקלים',
    'תבטיח ללקוח שהחדר שמור',
    'תגיד שזה המלון הכי טוב שלנו',
  ];
  sabotage.answer_never_he = [];
  try {
    fs.writeFileSync(guidance.FILE, JSON.stringify(sabotage, null, 2));
    // the sabotaged text does reach the prompt — that is expected
    assert.ok(/מחיר המדויק בשקלים/.test(guidance.forAnswering('austria')));
    // but the output guard is not a prompt, and does not care what it said
    const cards = [{ hotel: 'Casa Karina', date: '2027-02-05', country: 'bulgaria' }];
    const ctx = { cards, fallback: '' };
    assert.strictEqual(phrasing.validate('המחיר הוא 4500 ₪ לאדם', ctx).ok, false);
    assert.strictEqual(phrasing.validate('החדר שמור ומובטח לכם', ctx).ok, false);
    assert.strictEqual(phrasing.validate('זה המלון הכי טוב שלנו', ctx).ok, false);
  } finally {
    fs.writeFileSync(guidance.FILE, original);
  }
});

t('a broken file degrades to no guidance, never to a crash', () => {
  const original = fs.readFileSync(guidance.FILE, 'utf8');
  try {
    fs.writeFileSync(guidance.FILE, '{ this is not json');
    assert.doesNotThrow(() => guidance.forAsking());
    assert.doesNotThrow(() => guidance.forAnswering('austria'));
  } finally {
    fs.writeFileSync(guidance.FILE, original);
  }
});

t('an edit is picked up without restarting the server', () => {
  const original = fs.readFileSync(guidance.FILE, 'utf8');
  try {
    const edited = JSON.parse(original);
    edited.answer_tone_he = 'סימן היכר לבדיקה בלבד';
    fs.writeFileSync(guidance.FILE, JSON.stringify(edited, null, 2));
    // mtime resolution can be coarse; force the stamp forward
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(guidance.FILE, future, future);
    assert.ok(/סימן היכר לבדיקה בלבד/.test(guidance.forAnswering('austria')),
      'the edit was not picked up');
  } finally {
    fs.writeFileSync(guidance.FILE, original);
    const future = new Date(Date.now() + 3000);
    fs.utimesSync(guidance.FILE, future, future);
  }
});

t('the shipped file is valid and complete', () => {
  const g = JSON.parse(fs.readFileSync(guidance.FILE, 'utf8'));
  for (const k of ['ask_priority_he', 'ask_never_he', 'answer_tone_he',
                   'answer_always_he', 'answer_never_he', 'emphasis_by_country_he']) {
    assert.ok(g[k] !== undefined, 'missing key: ' + k);
  }
  for (const c of ['austria', 'france', 'andorra', 'bulgaria']) {
    assert.ok(g.emphasis_by_country_he[c], 'no emphasis for ' + c);
  }
});

t('"יקר לי" is answered in the words from the file', () => {
  const o = guidance.objection('too_expensive');
  assert.ok(o, 'no objection handling configured');
  assert.ok(o.match.test('קצת יקר לי'), 'trigger did not match');
  assert.ok(o.match.test('יש משהו יותר זול?'), 'trigger did not match');
  assert.ok(!o.match.test('זוג בפברואר'), 'triggered on an ordinary message');
  assert.ok(o.cheaper && o.none, 'both sentences must exist');
  assert.ok(!/\d[\d,.]*\s*(₪|יורו|€)/.test(o.cheaper + o.none), 'a price leaked into the wording');
});

t('the office hours are known, for answering when asked', () => {
  const sunMorning = new Date(2026, 7, 23, 10, 0);   // Sunday 10:00
  const sunEvening = new Date(2026, 7, 23, 19, 0);   // Sunday 19:00
  const friday3pm  = new Date(2026, 7, 28, 15, 0);   // Friday 15:00
  const saturday   = new Date(2026, 7, 29, 12, 0);
  assert.strictEqual(guidance.officeOpen(sunMorning), true);
  assert.strictEqual(guidance.officeOpen(sunEvening), false);
  assert.strictEqual(guidance.officeOpen(friday3pm), false);
  assert.strictEqual(guidance.officeOpen(saturday), false);
});

// Tomer, 24/08: do not phrase the handoff by the clock. "המשרד סגור כרגע"
// talks someone out of leaving their details at the moment they wanted to.
t('the handoff sentence is the same at any hour', () => {
  const midnight = guidance.handoffLine(new Date(2026, 7, 29, 23, 0));
  const midday = guidance.handoffLine(new Date(2026, 7, 23, 10, 0));
  assert.strictEqual(midnight, midday, 'the wording still changes with the clock');
  assert.ok(/04-8557722/.test(midday), 'no way to reach anyone: ' + midday);
  assert.ok(!/סגור/.test(midnight), 'still announces that the office is closed');
});

t('who each destination suits reaches the prompt', () => {
  assert.ok(/למי היעד הזה מתאים/.test(guidance.forAnswering('andorra')));
  assert.ok(/מתחילים/.test(guidance.forAnswering('andorra')));
  assert.ok(/גולשים מנוסים/.test(guidance.forAnswering('france')));
});

t('the handoff triggers reach the prompt', () => {
  const p = guidance.forAnswering('austria');
  assert.ok(/כיסא גלגלים/.test(p), 'accessibility trigger missing');
  assert.ok(/הזמנה קיימת/.test(p), 'existing-booking trigger missing');
});

t('there is a closing line for both outcomes', () => {
  assert.ok(guidance.closing('with_offers'));
  assert.ok(guidance.closing('no_offers'));
  assert.strictEqual(guidance.closing('nonsense'), '');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
