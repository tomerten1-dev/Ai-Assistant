// Realistic Hebrew phrasings the offline NLU must handle.
// Run: node tests/test-phrasings.js
// Each case: [answered-question-key or null, text, expected slot subset]
const { parseText, nextQuestion, deflect } = require('../server/offline-nlu.js');

let pass = 0, fail = 0;
function check(label, prev, text, expect) {
  const got = parseText(text, prev || {});
  const bad = [];
  for (const [k, v] of Object.entries(expect)) {
    const g = got[k];
    // an unset slot may be undefined or null — both mean "we don't know"
    const same = Array.isArray(v)
      ? JSON.stringify((g || []).slice().sort()) === JSON.stringify(v.slice().sort())
      : (v === null ? g == null : g === v);
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

console.log('\n— negation: naming a country to RULE IT OUT —');
check('לא צרפת', null, 'לא צרפת', { excluded_countries: ['france'] });
check('לא רוצים צרפת', null, 'לא רוצים צרפת', { excluded_countries: ['france'] });
check('חוץ מצרפת', null, 'חוץ מצרפת', { excluded_countries: ['france'] });
check('בלי צרפת', null, 'בלי צרפת', { excluded_countries: ['france'] });
check('מלבד צרפת', null, 'מלבד צרפת', { excluded_countries: ['france'] });
check('לא לצרפת', null, 'לא לצרפת', { excluded_countries: ['france'] });
check('a plain mention is still positive', null, 'רוצים לצרפת', { country: 'france' });
check('negation retracts an earlier pick', { country: 'france' }, 'לא צרפת', { country: null, excluded_countries: ['france'] });

console.log('\n— negation, harder cases (found by the stress run) —');
check('two countries at once', null, 'לא צרפת ולא בולגריה', { excluded_countries: ['france', 'bulgaria'] });
check('second negation with a comma', null, 'לא צרפת, גם לא אוסטריה', { excluded_countries: ['france', 'austria'] });
check('changing your mind retracts it', { excluded_countries: ['france'] }, 'בעצם כן צרפת', { country: 'france', excluded_countries: [] });

// A resort can be refused just like a country. "לא בנסקו" used to clear a resort the
// customer had chosen and record nothing, so Bansko came straight back.
check('a refused resort is remembered', null, 'לא בנסקו', { excluded_destinations: ['Bansko'] });
check('refusing a resort keeps its country open', { country: 'bulgaria' }, 'לא בנסקו',
  { country: 'bulgaria', excluded_destinations: ['Bansko'] });
check('naming it again retracts the refusal', { excluded_destinations: ['Bansko'] }, 'בעצם כן בנסקו',
  { destination: 'Bansko', excluded_destinations: [] });

console.log('\n— party size corrections and edge sizes —');
check('בעצם 4 overrides an earlier 2', { adults: 2 }, 'בעצם 4', { adults: 4 });
check('סליחה, 3', { adults: 2 }, 'סליחה, 3', { adults: 3 });
check('אני לבד = one adult', null, 'אני לבד, ינואר', { adults: 1, month: 1 });

console.log('\n— dates —');
check('numeric date 15.2', null, 'זוג בלי ילדים, 15.2', { month: 2, adults: 2 });
check('out-of-season month is flagged', null, 'זוג בלי ילדים, אוגוסט', { out_of_season: true, month: null });
check('in-season month is not flagged', null, 'זוג בלי ילדים, ינואר', { out_of_season: false, month: 1 });

console.log('\n— places pingwin markets but does not sell this winter —');
check('זאלבאך', null, 'רוצים לזאלבאך', { off_commitment_destination: 'זאלבאך' });
check('קלאב מד', null, 'קלאב מד בבקשה', { off_commitment_destination: 'קלאב מד' });
check('a resort we DO hold commitments for is not flagged', null, 'רוצים לבנסקו', { off_commitment_destination: null, destination: 'Bansko' });

console.log('\n— every child must survive the parse (round-2 stress findings) —');
check('four ages separated by commas', null, '2 מבוגרים וארבעה ילדים בני 4, 6, 9, 12, ינואר',
  { adults: 2, children_ages: [4, 6, 9, 12], month: 1 });
check('three ages, comma and vav', null, 'זוג עם ילדים בני 5, 8 ו-12, מרץ', { children_ages: [5, 8, 12], month: 3 });
check('ages spelled out', null, 'זוג שני ילדים בני שש ותשע פברואר', { children_ages: [6, 9], month: 2 });
check('the month is not swallowed as an age', null, 'זוג עם ילדים בני 5 ו-9, פברואר', { children_ages: [5, 9], month: 2 });

console.log('\n— party words —');
check('שני זוגות = 4 adults', null, 'שני זוגות, ינואר', { adults: 4 });
check('שני הורים = 2 adults', null, 'שני הורים ושני ילדים בני 7 ו-11', { adults: 2, children_ages: [7, 11] });
check('a single זוג is still 2', null, 'זוג, ינואר', { adults: 2 });

console.log('\n— follow-up questions get answers, not another card dump —');
{
  const cases = [
    ['כמה לילות זה?', /לילות/],
    ['מה כלול במחיר?', /טיסה|העברות|סקי פס/],
    ['באיזו שעה הטיסה?', /אינן סופיות|לא אציין/],
    ['אני רוצה להזמין את הראשון', /המשך להזמנה|תחזרו אליי/],
    ['מה ההבדל בין המלונות?', /ההבדלים|כרטיס/],
    ['זה לא מה שביקשתי', /לחדד|צ׳יפים/],
    ['תודה רבה!', /בשמחה/],
  ];
  let ok = true;
  for (const [msg, re] of cases) {
    const got = deflect(msg);
    if (!got || !re.test(got)) { ok = false; console.log(`      ✗ "${msg}" → ${got}`); }
  }
  ok ? pass++ : fail++;
  console.log(ok ? '  ✓ all seven common follow-ups are answered' : '  ✗ some follow-ups unanswered');
}

console.log('\n— spelling mistakes real customers make —');
check('ינוואר', null, 'זוג בלי ילדים, ינוואר', { month: 1 });
check('ינאור', null, 'זוג בלי ילדים, ינאור', { month: 1 });
check('פבואר', null, 'זוג בלי ילדים, פבואר', { month: 2 });
check('פברוא', null, 'זוג בלי ילדים, פברוא', { month: 2 });
check('פבר (abbreviated)', null, 'זוג בלי ילדים, פבר', { month: 2 });
check('אוסטרייה', null, 'ינואר, אוסטרייה', { country: 'austria' });
check('צרפט', null, 'ינואר, צרפט', { country: 'france' });
check('אנדורא', null, 'ינואר, אנדורא', { country: 'andorra' });
check('בולגריא', null, 'ינואר, בולגריא', { country: 'bulgaria' });
check('בנסק', null, 'ינואר, בנסק', { destination: 'Bansko' });
check('מיירהופן', null, 'ינואר, מיירהופן', { destination: 'Mayrhofen' });
check('מבוגרם', null, '2 מבוגרם, ינואר', { adults: 2 });
check('קיטנא', null, 'ילד בן 7, קיטנא', { needs_hebrew_kids_club: true });
// the dangerous one: a missed "חיפא" would offer flights Haifa cannot take
check('חיפא — the airport must still be caught', null, 'טיסה מחיפא', { departure_airport: 'haifa' });

console.log('\n— sloppy formatting —');
check('hyphens used as separators', null, 'זוג-בלי-ילדים-ינואר', { adults: 2, no_children: true, month: 1 });
check('repeated punctuation', null, 'זוג בלי ילדים!!! ינואר!!!', { adults: 2, month: 1 });
check('emoji in the message', null, 'זוג בלי ילדים ינואר 🎿', { adults: 2, month: 1 });
check('double spaces', null, 'זוג   בלי   ילדים,   ינואר', { adults: 2, month: 1 });

console.log('\n— Israeli shorthand —');
check('2+2 party notation', null, '2+2, ינואר', { adults: 2, children_count: 2 });
check('ages as 5+9 after a count', null, '2 מבוגרים 2 ילדים 5+9 פבר', { adults: 2, children_ages: [5, 9], month: 2 });
check('גדולים / קטנים', null, '2 גדולים 2 קטנים ינואר', { adults: 2, children_count: 2, month: 1 });

console.log('\n— the snowboard-group brief (a real customer message) —');
{
  const brief = 'אנחנו 4 חברים ומחפשים חבילת סנובורד לשבוע במהלך חודש פברואר, ' +
    'מלון עם מיטות נפרדות, חדר גדול, מרחק הליכה קצר מהמעליות, סאונה וג׳קוזי במלון, ' +
    'ארוחת בוקר כלולה, סקי פס, השכרת ציוד סנובורד, הסעות משדה התעופה, ' +
    'טיסות לא בשבת יש 2 חברים שומרים';
  const s = parseText(brief, {});
  const checks = [
    ['four adults, not three', s.adults === 4],
    // "לא בשבת" contains "בת" — it must not become a 2-year-old
    ['no phantom child from "שבת"', (s.children_ages || []).length === 0],
    ['February', s.month === 2],
    ['a week', s.nights_wanted === 7],
    ['Sabbath constraint captured', s.no_saturday_flights === true],
    ['sauna/jacuzzi read as spa', (s.preferences || []).includes('ספא')],
    ['short walk read as slope proximity', (s.preferences || []).includes('קרוב למסלולים')],
    ['unverifiable items collected', (s.unverifiable || []).includes('מיטות נפרדות') &&
      (s.unverifiable || []).includes('השכרת ציוד')],
  ];
  const bad = checks.filter(c => !c[1]).map(c => c[0]);
  bad.length ? fail++ : pass++;
  console.log(bad.length ? '  ✗ brief: ' + bad.join('; ') : '  ✓ every requirement in the brief was read correctly');
}

console.log('\n— a city name is not a departure airport —');
check('weather question sets no airport', null, 'מה מזג האוויר בתל אביב?', { departure_airport: null });
check('but "מתל אביב" does', null, 'טיסה מתל אביב', { departure_airport: 'tlv' });

console.log('\n— direct questions get direct answers —');
{
  const price = deflect('כמה זה עולה בדיוק בשקלים?');
  const pii = deflect('מי הזמין את החדרים האחרים?');
  const normal = deflect('זוג בלי ילדים, ינואר');
  const ok = /מסך ההזמנה/.test(price || '') && /לא אוכל לשתף|אין לי גישה/.test(pii || '') && normal === null;
  ok ? pass++ : fail++;
  console.log(ok ? '  ✓ price and PII probes get an explicit answer, normal text does not'
                 : `  ✗ price=${price} pii=${pii} normal=${normal}`);
}

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

console.log('\n— never ask what the customer just told us —');
{
  const { nextQuestion } = require('../server/offline-nlu');
  const ask = (text) => {
    const slots = parseText(text, {});
    if (slots.adults == null) slots.adults = 2;   // step past the adults question
    return nextQuestion(slots, null) || {};
  };
  const want = (text, key) => {
    const q = ask(text);
    if (q.key === key) { pass++; console.log('  ✓ "' + text + '" → ' + q.he); }
    else { fail++; console.log('  ✗ "' + text + '" asked ' + q.key + ': ' + q.he); }
  };
  // "זוג עם ילדים" was answered with "נוסעים גם ילדים?" — they just said so.
  want('זוג עם ילדים', 'children_ages');
  want('משפחה עם ילדים, פברואר', 'children_ages');
  want('אנחנו 4 עם הילדים', 'children_ages');
  want('זוג עם 2 ילדים', 'children_ages');
  want('זוג עם ילד', 'children_ages');
  const q = ask('זוג בלי ילדים');
  if (!/ילד/.test(q.he || '')) { pass++; console.log('  ✓ "בלי ילדים" skips the question entirely'); }
  else { fail++; console.log('  ✗ asked about children anyway: ' + q.he); }
}

console.log('\n— kosher food is not a Sabbath constraint —');
check('asking about kosher food does not ban Saturday flights', null, 'יש אוכל כשר?', { no_saturday_flights: null });
check('nor does a kosher kitchen', null, 'יש מטבח כשר במלון?', { no_saturday_flights: null });
check('but saying you keep Shabbat does', null, 'אנחנו שומרי שבת', { no_saturday_flights: true });
check('and so does asking not to fly on Saturday', null, 'לא טסים בשבת', { no_saturday_flights: true });

console.log('\n— סוף פברואר is not פברואר —');
check('end of the month', null, 'סוף פברואר', { month: 2, month_part: 'late' });
check('start of the month', null, 'תחילת מרץ', { month: 3, month_part: 'early' });
check('middle of the month', null, 'אמצע ינואר', { month: 1, month_part: 'mid' });
check('סוף שבוע is a weekend, not late in the month', null, 'סוף שבוע בבנסקו', { month_part: null });
check('a plain month sets no half', null, 'פברואר', { month: 2, month_part: null });
check('גמיש clears an earlier half', { month: 2, month_part: 'late' }, 'בעצם גמיש', { month_part: null });

console.log('\n— Hebrew has no word boundary, so every one is written out —');
check('"בלבד" is not "לבד"', null, 'זוג בדצמבר בלבד', { adults: 2 });
check('but travelling alone still counts', null, 'אני נוסע לבד', { adults: 1 });
check('שומרת שבת, feminine', null, 'משפחה שומרת שבת', { no_saturday_flights: true });
check('שומרות שבת, plural feminine', null, 'שומרות שבת', { no_saturday_flights: true });
check('niqqud is stripped before matching', null, 'זוּג בּפברואר', { adults: 2, month: 2 });
check('releasing the airport', { departure_airport: 'haifa' }, 'לא חייב מחיפה', { departure_airport: 'any' });
check('releasing the Sabbath constraint', { no_saturday_flights: true }, 'אפשר גם בשבת', { no_saturday_flights: false });
check('naming Haifa still sets it', null, 'זוג מחיפה בפברואר', { departure_airport: 'haifa' });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
