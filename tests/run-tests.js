// Deterministic test suite — no AI involved. Run: node tests/run-tests.js
// Covers spec section 9 items 1, 4, 4b, 4c, 5, 6 (2/3/7 need the live bot).
const fs = require('fs');
const path = require('path');
const { parseInventory, stats } = require('../data/inventory.js');
const { SkiSearch } = require('../data/filter.js');

const ROOT = path.join(__dirname, '..');
const XLSM = path.join(ROOT, 'source-data', 'commitments-winter-2027.xlsm');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail ? '—' + detail : ''); }
}

console.log('— parsing workbook —');
const rows = parseInventory(XLSM);
const st = stats(rows);

console.log('\n[6] parse counts vs approved reference (spec 3.5 + Tomer 23/08)');
t('total rows 3804', st.total === 3804, 'got ' + st.total);
t('free 2282', st.status.free === 2282, 'got ' + st.status.free);
t('sold 1432', st.status.sold === 1432, 'got ' + st.status.sold);
t('reserved 68 (exact per spec)', st.status.reserved === 68, 'got ' + st.status.reserved);
t('not_for_sale 20', st.status.not_for_sale === 20, 'got ' + st.status.not_for_sale);
t('unknown (contradictions) 2', st.status.unknown === 2, 'got ' + st.status.unknown);
t('season range', st.firstDate === '2026-12-05' && st.lastDate === '2027-03-28');
t('hanukkah sheet: exactly 3 free (Tomer)', rows.filter(r => r.sheet.includes('חנוכה') && r.status === 'free').length === 3);
t('Belambra Grand Massif kept in BOTH sheets (not merged)',
  new Set(rows.filter(r => r.hotel === 'Belambra Grand Massif').map(r => r.sheet)).size === 2);

console.log('\n[4c] ואקאנס + שמור never reach results');
t('no vacances rows parsed', !rows.some(r => /ואקאנס/.test(JSON.stringify(r))));
const av = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'availability.json'), 'utf8'));
t('availability.json holds only free units (no reserved/sold leak possible)',
  av.units.length > 0 && av.source_stats.free_rows === av.units.reduce((n, u) => n + u.count, 0));
t('no France departures in February anywhere in data (3.4 gap is real)',
  !av.units.some(u => u.country === 'france' && u.date.slice(5, 7) === '02'));

console.log('\n[5] PII scan on the public JSON');
const raw = fs.readFileSync(path.join(ROOT, 'data', 'availability.json'), 'utf8');
t('zero Hebrew chars in room/hotel fields',
  !av.units.some(u => [u.hotel, u.room, u.room_type].some(v => /[֐-׿]/.test(String(v)))));
t('zero 6-digit sequences', !/\d{6,}/.test(raw));

console.log('\n— search engine —');
const engine = new SkiSearch();

console.log('\n[1] family 2+2 (ages 5, 9), February, needs Hebrew kids club');
// REAL camps data: no 4-6 group opens anywhere in February → results must be
// partial-coverage, explicitly flagged missing "4-6" (never silently "full")
const r1 = engine.search({ adults: 2, children_ages: [5, 9], month: 2, needs_hebrew_kids_club: true });
t('returns results (not empty)', r1.candidates.length > 0);
t('every result runs at least one camp that week', r1.candidates.every(c => c.camps && c.camps.running.length > 0));
t('February: NO candidate claims full coverage (no 4-6 camp exists)', r1.candidates.every(c => !c.camps.full));
t('the missing 4-6 group is named explicitly',
  r1.candidates.every(c => c.camps.missing.includes('4-6') || c.camps.waitlist_only.includes('4-6')));
// positive control: 20/03 Les 2 Alpes runs BOTH groups with free seats
const r1b = engine.search({ adults: 2, children_ages: [5, 9], month: 3, needs_hebrew_kids_club: true });
const full1b = r1b.candidates.filter(c => c.camps.full);
t('March: full coverage exists (Les 2 Alpes 20/03 runs both groups)', full1b.length > 0);
t('full-coverage weeks run BOTH 4-6 and 6-13',
  full1b.every(c => c.camps.running.includes('4-6') && c.camps.running.includes('6-13')));

console.log('\n[4] 6 travelers with no single unit for 6 → two-room split, not empty');
const r4 = engine.search({ adults: 6, children_ages: [], month: 1, country: 'austria' });
t('offers two-room splits or direct results', r4.candidates.length > 0 || r4.two_room_splits.length > 0);
if (!r4.candidates.length) {
  t('split marked as relaxation', r4.relaxed.some(x => x.type === 'two_rooms'));
  t('split rooms share hotel+date', r4.two_room_splits.every(s => s.rooms.length === 2));
}

console.log('\n[4b] February in France → explanation + alternatives, not empty');
const r4b = engine.search({ adults: 2, children_ages: [], month: 2, country: 'france' });
t('france_february_gap note present', r4b.notes.some(n => n.type === 'france_february_gap'));
t('offers alternatives (relaxed location or month)', r4b.candidates.length > 0);
t('alternatives are NOT France-in-February', r4b.candidates.every(c => !(c.country === 'france' && c.date.slice(5, 7) === '02')));

console.log('\n[departure airport] Haifa flies only Bansko, Friday→Wednesday (Tomer 23/08)');
const haifa = engine.search({ adults: 2, children_ages: [], no_children: true, month: 1, departure_airport: 'haifa' });
t('returns results from Haifa', haifa.candidates.length > 0);
t('every Haifa result is Bulgaria', haifa.candidates.every(c => c.country === 'bulgaria'));
t('every Haifa result departs on a Friday',
  haifa.candidates.every(c => new Date(c.date + 'T00:00:00Z').getUTCDay() === 5),
  haifa.candidates.map(c => c.date).join(','));
t('every Haifa result is the 5-night Fri→Wed product', haifa.candidates.every(c => c.nights === 5));
t('Haifa never offers France/Austria/Andorra', !haifa.candidates.some(c => c.country !== 'bulgaria'));

const haifaFrance = engine.search({ adults: 2, children_ages: [], no_children: true, month: 1, country: 'france', departure_airport: 'haifa' });
t('Haifa+France explains instead of listing France',
  haifaFrance.notes.some(n => n.type === 'airport_cannot_reach' && n.requested_country === 'france'));
t('Haifa+France offers Bulgaria alternatives, not France',
  haifaFrance.candidates.length > 0 && haifaFrance.candidates.every(c => c.country === 'bulgaria'));

const tlv = engine.search({ adults: 2, children_ages: [], no_children: true, month: 1, departure_airport: 'tlv' });
t('Tel Aviv still gets results', tlv.candidates.length > 0);

// the Fri→Wed product is Haifa-exclusive (Tomer 23/08): nobody else sees it
const FRI_WED = 'בולגריה סופ"ש שישי-רביעי';
const friWedDates = new Set(av.units.filter(u => u.sheet === FRI_WED).map(u => u.date));
const leaks = s => s.candidates.filter(c => c.country === 'bulgaria' && c.nights === 5 && friWedDates.has(c.date));
t('Tel Aviv never sees the Haifa-exclusive product', leaks(tlv).length === 0);
const noAirport = engine.search({ adults: 2, children_ages: [], no_children: true, month: 1 });
t('customers who named no airport do not see it either', leaks(noAirport).length === 0);
t('Haifa still does see it', engine.search({ adults: 2, children_ages: [], no_children: true, month: 1, departure_airport: 'haifa' }).candidates.length > 0);
t('two-room splits respect the exclusivity too',
  engine.search({ adults: 4, children_ages: [], no_children: true, month: 2, departure_airport: 'tlv' })
    .two_room_splits.every(s => !friWedDates.has(s.date) || s.country !== 'bulgaria'));

// Feb from Haifa has only 2-3 studios: a family of 4 needs two rooms, and
// those rooms must still be inside the Haifa-reachable product
const haifaFamily = engine.search({ adults: 2, children_ages: [5, 9], month: 2, departure_airport: 'haifa' });
t('family of 4 from Haifa gets a two-room option, not an empty answer',
  haifaFamily.candidates.length > 0 || haifaFamily.two_room_splits.length > 0);
t('those two-room options stay in Bulgaria',
  haifaFamily.two_room_splits.every(s => s.country === 'bulgaria'));

console.log('\n[negation] a ruled-out country never comes back — not even via relaxation');
const noFrance = engine.search({
  adults: 2, children_ages: [], no_children: true, month: 2, excluded_countries: ['france'],
});
t('returns results', noFrance.candidates.length > 0);
t('zero France results', noFrance.candidates.every(c => c.country !== 'france'),
  [...new Set(noFrance.candidates.map(c => c.country))].join(','));
t('no France-February note when France was ruled out',
  !noFrance.notes.some(n => n.type === 'france_february_gap'));
// the relaxation ladder widens the search — the exclusion must survive it
const noFranceTight = engine.search({
  adults: 9, children_ages: [], no_children: true, month: 2, excluded_countries: ['france'],
});
t('exclusion holds through relaxation and two-room splits',
  noFranceTight.candidates.every(c => c.country !== 'france') &&
  (noFranceTight.two_room_splits || []).every(s => s.country !== 'france'));

console.log('\n[restrictions] "מכירת התחייבויות בלבד" is per departure date (Tomer 23/08)');
const restrictions = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'restrictions.json'), 'utf8'));
const isOpen = (c, d) => (restrictions.open[c] || []).includes(d);
const isRestricted = (c, d) => (restrictions.restricted[c] || []).includes(d);
// the three dates Tomer named explicitly
t('Austria 06/03 is open', isOpen('austria', '2027-03-06'));
t('Austria 20/02 is restricted', isRestricted('austria', '2027-02-20'));
t('Austria 27/02 is restricted', isRestricted('austria', '2027-02-27'),
  'this date is stored as text, not a date cell — it must still be read');
t('no date is both open and restricted',
  Object.keys(restrictions.open).every(c => (restrictions.open[c] || []).every(d => !isRestricted(c, d))));
t('every workbook departure date is classified',
  [...new Set(av.units.map(u => u.country + '|' + u.date))]
    .every(k => { const [c, d] = k.split('|'); return isOpen(c, d) || isRestricted(c, d); }));
// an off-commitment resort must be routed, never quoted as available
const offComm = engine.search({
  adults: 2, children_ages: [], no_children: true, month: 3,
  off_commitment_destination: 'זאלבאך', off_commitment_country: 'austria',
});
const note = offComm.notes.find(n => n.type === 'destination_off_commitment');
t('off-commitment resort raises a rep-routing note', !!note && note.needs_rep === true);
t('it names only genuinely open dates',
  !!note && note.open_dates.length > 0 && note.open_dates.every(d => isOpen('austria', d)));
t('it never appears as a bookable card', offComm.candidates.every(c => c.hotel !== 'זאלבאך'));

console.log('\n— guardrails —');
const r5 = engine.search({ adults: 2, children_ages: [], month: 1 });
t('never more than 8 candidates', r5.candidates.length <= 8);
t('price is symbolic only (₪ glyphs)', r5.candidates.every(c => /^₪+$/.test(c.price_range)));
t('closed universe: every candidate hotel exists in the workbook',
  r5.candidates.every(c => rows.some(r => r.hotel === c.hotel)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
