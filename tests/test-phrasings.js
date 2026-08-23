// Realistic Hebrew phrasings the offline NLU must handle.
// Run: node tests/test-phrasings.js
// Each case: [answered-question-key or null, text, expected slot subset]
const { parseText, nextQuestion } = require('../server/offline-nlu.js');

let pass = 0, fail = 0;
function check(label, prev, text, expect) {
  const got = parseText(text, prev || {});
  const bad = [];
  for (const [k, v] of Object.entries(expect)) {
    const g = got[k];
    const same = Array.isArray(v) ? JSON.stringify((g || []).slice().sort()) === JSON.stringify(v.slice().sort()) : g === v;
    if (!same) bad.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(g)}`);
  }
  if (bad.length) { fail++; console.log('  ✗', label, '|', JSON.stringify(text)); bad.forEach(b => console.log('      ', b)); }
  else { pass++; console.log('  ✓', label); }
}

console.log('— party size, free text —');
check('זוג', null, 'זוג, ינואר', { adults: 2 });
check('שני מבוגרים', null, 'שני מבוגרים', { adults: 2 });
check('2 מבוגרים', null, '2 מבוגרים', { adults: 2 });
check('אנחנו 4', null, 'אנחנו 4, מרץ', { adults: 4 });
check('אני ואחי', null, 'אני ואחי רוצים לטוס', { adults: 2 });
check('4 אנשים', null, '4 אנשים בפברואר', { adults: 4 });

console.log('\n— children: singular / plural / count only —');
check('זוג עם ילד', null, 'זוג עם ילד', { adults: 2, children_count: 1 });
check('זוג עם ילדה', null, 'זוג עם ילדה', { adults: 2, children_count: 1 });
check('זוג עם שני ילדים', null, 'זוג עם שני ילדים פברואר', { adults: 2, children_count: 2, month: 2 });
check('עם 3 ילדים', null, 'אנחנו 2 עם 3 ילדים', { children_count: 3 });
check('ילד אחד', null, 'זוג + ילד אחד', { adults: 2, children_count: 1 });

console.log('\n— children ages inline —');
check('ילדים בני 5 ו-9', null, 'זוג עם ילדים בני 5 ו-9', { adults: 2, children_ages: [5, 9] });
check('ילד בן 7', null, 'זוג עם ילד בן 7', { children_ages: [7] });
check('ילדה בת 6', null, 'ילדה בת 6', { children_ages: [6] });
check('גילאי 4 ו-6', null, 'שני ילדים גילאי 4 ו-6', { children_ages: [4, 6] });

console.log('\n— bare numbers ANSWERING the ages question (the screenshot bug) —');
check('single age "4"', { _lastQuestion: 'children', adults: 2, children_count: 1 }, '4', { children_ages: [4] });
check('single age, no count known', { _lastQuestion: 'children', adults: 2 }, '4', { children_ages: [4] });
check('two ages "4 ו 9"', { _lastQuestion: 'children_ages', adults: 2, children_count: 2 }, '4 ו 9', { children_ages: [4, 9] });
check('comma ages "5,9"', { _lastQuestion: 'children_ages', adults: 2 }, '5,9', { children_ages: [5, 9] });
check('three ages', { _lastQuestion: 'children_ages', adults: 2 }, '3 7 11', { children_ages: [3, 7, 11] });
check('"בני 8"', { _lastQuestion: 'children_ages', adults: 2 }, 'בני 8', { children_ages: [8] });

console.log('\n— no children —');
check('בלי ילדים', { _lastQuestion: 'children', adults: 2 }, 'בלי ילדים', { no_children: true });
check('לא (as answer)', { _lastQuestion: 'children', adults: 2 }, 'לא', { no_children: true });
check('אין ילדים', null, 'זוג, אין ילדים, ינואר', { no_children: true });

console.log('\n— adults answering the adults question —');
check('bare "2"', { _lastQuestion: 'adults' }, '2', { adults: 2 });
check('bare "שניים"', { _lastQuestion: 'adults' }, 'שניים', { adults: 2 });

console.log('\n— month —');
check('פברואר', null, 'פברואר', { month: 2 });
check('בפברואר', null, 'רוצים לצאת בפברואר', { month: 2 });
check('גמיש', { _lastQuestion: 'month' }, 'גמיש', { month: 'any' });
check('לא משנה', { _lastQuestion: 'month' }, 'לא משנה לנו', { month: 'any' });
check('חנוכה', null, 'חנוכה', { month: 12 });

console.log('\n— kids club yes/no —');
check('כן', { _lastQuestion: 'kids_club', children_ages: [7] }, 'כן', { needs_hebrew_kids_club: true });
check('לא', { _lastQuestion: 'kids_club', children_ages: [7] }, 'לא', { needs_hebrew_kids_club: false });
check('קייטנה', null, 'רוצים קייטנה בעברית', { needs_hebrew_kids_club: true });
check('קיטנה (misspelled)', null, 'חשוב שתהיה קיטנה', { needs_hebrew_kids_club: true });

console.log('\n— destination / country —');
check('צרפת', null, 'צרפת', { country: 'france' });
check('בנסקו', null, 'רוצים לבנסקו', { destination: 'Bansko', country: 'bulgaria' });
check('מאיירהופן', null, 'מאיירהופן בבקשה', { destination: 'Mayrhofen', country: 'austria' });

console.log('\n— departure airport (Haifa flies Bansko only) —');
check('טיסה מחיפה', null, 'טיסה מחיפה', { departure_airport: 'haifa' });
check('יוצאים מחיפה', null, 'אנחנו 2 ויוצאים מחיפה בינואר', { departure_airport: 'haifa', adults: 2, month: 1 });
check('מתל אביב', null, 'טיסה מתל אביב', { departure_airport: 'tlv' });
check('נתב"ג', null, 'יוצאים מנתב"ג', { departure_airport: 'tlv' });

console.log('\n— never repeat the same question —');
{
  // asked about children, answer not understood → must rephrase, not echo
  const q1 = nextQuestion({ adults: 2 }, null);
  const q2 = nextQuestion({ adults: 2 }, 'children');
  const ok = q1 && q2 && q1.he !== q2.he;
  ok ? pass++ : fail++;
  console.log(ok ? '  ✓ rephrases instead of repeating' : `  ✗ repeated identical question: ${q1 && q1.he}`);
}
{
  // every matching parameter known → nothing left to ask
  const q = nextQuestion({
    adults: 2, children_ages: [5, 9], month: 2, needs_hebrew_kids_club: true,
    departure_airport: 'tlv', country: 'austria',
  }, null);
  q === null ? pass++ : fail++;
  console.log(q === null ? '  ✓ no question when every parameter is known' : `  ✗ asked anyway: ${q.he}`);
}
{
  // essentials known but airport/destination still open → keep gathering
  const q = nextQuestion({ adults: 2, children_ages: [5, 9], month: 2, needs_hebrew_kids_club: true }, null);
  const ok = q && q.key === 'airport';
  ok ? pass++ : fail++;
  console.log(ok ? '  ✓ asks about the departure airport once essentials are in'
                 : `  ✗ expected the airport question, got ${q && q.key}`);
}
{
  // "לא משנה" is an answer, not a gap — it must not be re-asked
  const s = parseText('לא משנה', { _lastQuestion: 'airport', adults: 2, children_ages: [7], month: 1, needs_hebrew_kids_club: false });
  const ok = s.departure_airport === 'any' && (nextQuestion(s, 'airport') || {}).key !== 'airport';
  ok ? pass++ : fail++;
  console.log(ok ? '  ✓ "לא משנה" on the airport question stops the asking'
                 : `  ✗ got departure_airport=${s.departure_airport}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
