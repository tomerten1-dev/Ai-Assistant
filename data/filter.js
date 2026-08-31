// DETERMINISTIC filter layer — no AI anywhere in this file (spec section 5).
// Claude fills slots; THIS code decides which units qualify; Claude only
// phrases the result. Max 8 candidates are ever returned to the model.
const fs = require('fs');
const path = require('path');
const { roomFacts } = require('./room-match');

const DATA_DIR = __dirname;
function loadJSON(p) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, p), 'utf8')); }

// The season's months, in selling order, from data/config/date-labels.json.
// They were written out as [12, 1, 2, 3] in five places here and one more in
// offline-nlu.js, so adding November — or selling a southern-hemisphere
// season — meant finding all six.
const SEASON = require('../server/season.js');
const SEASON_MONTHS = () => SEASON.months();
const MONTHS = (() => {
  const m = {};
  for (const n of SEASON.months()) m[n] = String(n).padStart(2, '0');
  return m;
})();
// The camp age policy, read once at module load. It is a static property of
// the business (Tomer's ruling, recorded in camps.json with its citation), not
// per-instance state, and the static helpers below need it before any engine
// exists. A missing file falls back to the documented 4-14 rather than
// throwing — the boundary must never be undefined.
const CAMPS_POLICY = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'camps.json'), 'utf8')).age_policy || {}; }
  catch (e) { return {}; }
})();

class SkiSearch {
  /* Reload the inventory when its files change on disk.
     The engine used to be built once at boot and never again, while
     catalogue.js and guidance.js both re-stat their files on every call. So a
     workbook re-exported at 10:00 with a sold-out week removed kept being
     offered until someone restarted the server — the one file where a stale
     read is a wrong availability claim. */
  reloadIfChanged() {
    if (this._stamp === null) return this;      // injected data — never replace it
    const stamp = SkiSearch.dataStamp();
    if (stamp && stamp !== this._stamp) {
      try {
        this.av = loadJSON('availability.json');
        this.resorts = loadJSON('resorts.json');
        this.camps = loadJSON('camps.json');
        this.pricing = loadJSON('pricing.json');
        this.restrictions = loadJSON('restrictions.json');
        this._stamp = stamp;
      } catch (e) { /* keep the copy we have; a half-written file is not data */ }
    }
    return this;
  }

  // mtimes of every file the search reads, as one comparable string
  static dataStamp() {
    let out = '';
    for (const f of ['availability.json', 'resorts.json', 'camps.json', 'pricing.json', 'restrictions.json']) {
      try { out += f + ':' + fs.statSync(path.join(DATA_DIR, f)).mtimeMs + ';'; }
      catch (e) { return null; }
    }
    return out;
  }

  constructor({ availability, resorts, camps, pricing, departures } = {}) {
    this.av = availability || loadJSON('availability.json');
    this.resorts = resorts || loadJSON('resorts.json');
    this.camps = camps || loadJSON('camps.json');
    this.pricing = pricing || loadJSON('pricing.json');
    this.departures = departures ||
      JSON.parse(fs.readFileSync(path.join(DATA_DIR, '..', 'config', 'departures.json'), 'utf8'));
    this.restrictions = loadJSON('restrictions.json');
    // what every package includes and what costs extra (config/inclusions.json)
    this.inclusions = JSON.parse(fs.readFileSync(
      path.join(DATA_DIR, '..', 'config', 'inclusions.json'), 'utf8'));
    // only track reloads for an engine that owns its files; one built from
    // injected data (the tests do this) must keep exactly what it was given
    this._stamp = (availability || resorts || camps || pricing) ? null : SkiSearch.dataStamp();
  }

  /* "מה התאריכים בחנוכה?" / "יש חבילה בין 22 ל-29 בדצמבר?" — the departure
     dates we actually hold, straight from the workbook.

     Added 30/08 after the live run: both of those questions were answered with
     "כמה תהיו בסך הכל?" while the answer sat in the data. Dates are facts, not
     prices — red rule 3 does not touch them — and "what dates do you have" is
     one of the questions a customer with a fixed window most needs answered
     before anything else is worth discussing.

     Returns sorted ISO dates. Never a promise of availability: the caller says
     the departures exist, and the search says what is open on them. */
  departureDates({ holiday = null, month = null, from = null, to = null } = {}) {
    const out = new Set();
    for (const u of this.av.units || []) {
      if (!u.date) continue;
      if (holiday && u.date_label !== holiday) continue;
      if (month != null && month !== 'any' && SkiSearch.monthOf(u.date) !== +month) continue;
      if (from && u.date < from) continue;
      if (to && u.date > to) continue;
      out.add(u.date);
    }
    return [...out].sort();
  }

  // Dates in a country that carry NO "מכירת התחייבויות בלבד" note. On those,
  // hotels outside the workbook can also be sold — subject to the flight not
  // being full and to hotel confirmation, neither of which the workbook knows.
  // So this answers "worth a rep checking", never "available".
  openDates(country, month) {
    const all = (this.restrictions.open || {})[country] || [];
    return month == null ? all : all.filter(d => SkiSearch.monthOf(d) === +month);
  }

  // which sheets a departure airport can actually fly (config/departures.json).
  // null = no restriction.
  allowedSheets(airport) {
    const a = airport && this.departures.airports[airport];
    if (!a || a.all_products) return null;
    return a.sheets || [];
  }

  // some products are sold from ONE airport only (Fri→Wed Bansko is Haifa
  // exclusive). Hide them from everyone else, including customers who never
  // named an airport — offering a flight they cannot take is worse than
  // showing one option less.
  sheetBlockedFor(sheet, airport) {
    const owner = (this.departures.exclusive_sheets || {})[sheet];
    return !!owner && owner !== airport;
  }

  hotelInfo(name) { return this.resorts.hotels[name] || {}; }
  resortOf(name) { return this.hotelInfo(name).resort || null; }
  /* The price band, or null when this hotel has never been classified.
     Only 8 of the 40 hotels we can offer have a band; pricing.json still says
     so in its own _todo field ("ברירת מחדל לדמו"). The other 32 fell through
     to "₪₪₪" — and that placeholder was not merely displayed, it was REASONED
     FROM: it decided which card got the "המשתלם ביותר" badge, it answered
     "יקר לי" with something "cheaper", and it told customers another country
     was in a lower band. All of that from a TODO.
     Unknown is now unknown. Set `unclassified: "default"` in pricing.json to
     go back to treating it as mid-band. */
  price(name) {
    const known = this.pricing.hotels[name];
    if (known) return known;
    return this.pricing.unclassified === 'default' ? (this.pricing.default || null) : null;
  }
  priceKnown(name) { return !!this.price(name); }
  // length as a rank, with unknown sorting as "no opinion" rather than as mid
  priceRankOf(name) { const p = this.price(name); return p ? p.length : null; }

  // per-hotel room rule from pingwin.co.il (X+Y interpretation, rooms with no
  // occupancy digits). Returns {occ_min, occ_max, composition_he} or null.
  roomRule(hotel, room) {
    const rules = this.hotelInfo(hotel).room_rules || [];
    return rules.find(r => room.includes(r.match)) || null;
  }

  // effective occupancy after applying the hotel-page rule
  /* A hotel-page rule describes the hotel's PRODUCT LINE; the workbook row
     describes the specific room we hold. The rule may narrow that row, or
     interpret an ambiguous "2+1" notation the workbook left open — it must
     never widen it past a range the workbook stated outright.
     It did, until 30/08. Strass holds "J. Suite 2+1", recorded as 2-3, and the
     page rule for "J. Suite" says "up to 4 guests". On 6.3 that is the only
     free Strass unit, so a party of four was offered it, the card read
     "מתאים ל-4 נוסעים", and the booking link prefilled pwad=4 into a room the
     commitments file records as holding three. */
  effectiveOcc(unit) {
    const rule = this.roomRule(unit.hotel, unit.room);
    if (!rule) {
      return { min: unit.occ_min, max: unit.occ_max, min_adults: null, composition_he: null,
        verified: !unit.needs_hotel_rule && unit.occ_min != null };
    }
    // The workbook gave a number → the rule may only tighten it.
    // `needs_hotel_rule` marks the "2+1" notation, where what is ambiguous is
    // the COMPOSITION (may the +1 be an adult?) — not the total, which is
    // plainly three. So the ceiling still binds; the rule contributes the
    // composition and the minimum-adults instead.
    const stated = unit.occ_min != null && unit.occ_max != null;
    const min = stated ? Math.max(rule.occ_min, unit.occ_min) : rule.occ_min;
    const max = stated ? Math.min(rule.occ_max, unit.occ_max) : rule.occ_max;
    // a rule that contradicts the row outright (no overlap at all) is a data
    // problem, not a licence to pick one — fall back to what we hold
    if (min > max) {
      return { min: unit.occ_min, max: unit.occ_max, min_adults: rule.min_adults || null,
        composition_he: rule.composition_he, verified: false };
    }
    return { min, max, min_adults: rule.min_adults || null,
      composition_he: rule.composition_he, verified: true };
  }

  /* ---- camps: which age groups does this party need? ----
     policy (Tomer 23/08): regular camp = ages 6-13 (split by ski level,
     runs most weeks); ages 4-6 camp opens only on specific dates.
     age 6 fits either group. ---- */
  /* ---- how many seats does this party take? ----
     Children whose ages are not known yet still travel: "זוג עם 2 ילדים"
     must be four people everywhere — in the search, the trade-off counts and
     the card captions — not four in one place and two in another. */
  static partyOf(slots) {
    return (slots.adults || 0) +
      Math.max((slots.children_ages || []).length, slots.children_count || 0);
  }

  /* ---- ONE source for the camp age boundary ----
     It used to be written out in six places with two different ceilings (four
     said 4-13, two said 4-14, and the sentence the customer reads said 4-14),
     so a 14-year-old was simultaneously too old to trigger the club question,
     young enough to constrain the search, and told they were in range. The
     numbers now come from data/camps.json → age_policy.overall, which records
     Tomer's ruling of 26/08 with its citation, and every layer reads them from
     here. The customer-facing "4-14" is generated from the same two numbers. */
  static campAgeRange() {
    const p = ((CAMPS_POLICY || {}).overall) || {};
    return { min: p.age_min != null ? p.age_min : 4, max: p.age_max != null ? p.age_max : 14 };
  }
  static campAgeLabel() {
    const r = SkiSearch.campAgeRange();
    return r.min + '-' + r.max;
  }
  static inCampAge(age) {
    const r = SkiSearch.campAgeRange();
    return typeof age === 'number' && age >= r.min && age <= r.max;
  }

  /* ---- which group (or groups) would take each child ----
     Age six sits in the overlap: camps.json puts the young group at 4-6 and
     the regular at 6-13, so EITHER takes them. Reporting "6-13 does not run"
     for a six-year-old on a week that does run 4-6 is false — and false in the
     direction that loses a booking. Each child therefore produces a list of
     acceptable groups, not one group.
     Under four there is no group at all — "3 ו-10 חודשים" is a no, not a
     maybe — and past the ceiling there is none either. */
  static campRequirements(childrenAges) {
    const r = SkiSearch.campAgeRange();
    const reqs = [], seen = new Set();
    for (const a of childrenAges || []) {
      let ok = null;
      if (a >= r.min && a < 6) ok = ['4-6'];
      else if (a === 6) ok = ['4-6', '6-13'];
      else if (a > 6 && a <= r.max) ok = ['6-13'];
      if (!ok) continue;
      const key = ok.join('|');
      if (seen.has(key)) continue;
      seen.add(key); reqs.push(ok);
    }
    return reqs;
  }

  // The group each child is normally PLACED in — the label the reply prints.
  // Kept as the primary group so the wording never changes for a six-year-old,
  // while campRequirements above is what actually decides coverage.
  static neededAgeGroups(childrenAges) {
    const groups = new Set();
    for (const req of SkiSearch.campRequirements(childrenAges)) groups.add(req[req.length - 1]);
    return groups;
  }

  // returns {full, running, missing, waitlist_only} for resort+week
  campsCoverage(resort, week, childrenAges) {
    const reqs = SkiSearch.campRequirements(childrenAges);
    if (!reqs.length) return { full: true, running: [], missing: [], waitlist_only: [] };
    const entry = (this.camps.weeks || []).find(w => w.resort === resort && w.week === week);
    const groups = entry && !entry.no_camp ? entry.groups : [];
    const openSeats = g => groups.some(x => x.age_group === g && !x.is_waitlist && x.free > 0);
    const waitSeats = g => groups.some(x => x.age_group === g && x.is_waitlist && x.free > 0);
    const running = [...new Set(groups.filter(g => g.free > 0).map(g => g.age_group))];
    const missing = [], waitlistOnly = [];
    // a requirement is met when ANY of its acceptable groups has open seats
    for (const req of reqs) {
      const label = req[req.length - 1];
      if (req.some(openSeats)) continue;
      if (req.some(waitSeats)) waitlistOnly.push(label);
      else missing.push(label);
    }
    return { full: missing.length === 0 && waitlistOnly.length === 0, running, missing, waitlist_only: waitlistOnly };
  }

  /* ---- unit occupancy check (hotel-page rules first) ----
     adults matters too: e.g. Club Soleil "connected 4+2" requires a minimum
     of 3 ADULTS per the hotel page — total party size alone is not enough. */
  fits(unit, party, adults) {
    const occ = this.effectiveOcc(unit);
    // Party still unknown: every unit is a candidate. The bot shows a spread
    // and asks alongside, instead of holding the customer at the door until
    // they fill in a number (Tomer, 24/08 — it must never get stuck waiting).
    if (!party) return null;
    if (occ.min == null) return null; // unknown occupancy — verify with rep
    if (occ.min_adults != null && adults != null && adults < occ.min_adults) return false;
    return party >= occ.min && party <= occ.max;
  }

  /* ---- which third of the month a date falls in ----
     "סוף פברואר" asked for the last third and got the 4th, because only the
     month was ever read. */
  static partOf(iso) {
    const d = +iso.slice(8, 10);
    return d <= 10 ? 'early' : (d <= 20 ? 'mid' : 'late');
  }

  /* ---- month helpers ---- */
  static monthOf(iso) { return +iso.slice(5, 7); }
  static inMonth(iso, month) { return SkiSearch.monthOf(iso) === +month; }

  /* =============== main search =============== */
  // slots: {adults, children_ages, month, flexible_dates, country, destination,
  //         needs_hebrew_kids_club, preferences}
  search(slots) {
    // children whose ages we do not know yet still take seats: "עם 3 נכדים"
    // was a party of two by this arithmetic, and five people were offered
    // rooms for three
    const party = SkiSearch.partyOf(slots);
    const notes = [];   // machine-readable notes Claude may phrase
    let relaxed = []; // which constraints were relaxed, in order

    // France-February insight (spec 3.4): explain, don't return empty
    if (+slots.month === 2 && slots.country === 'france' &&
        !(slots.excluded_countries || []).includes('france')) {
      notes.push({ type: 'france_february_gap' });
    }
    // a kids club was asked for, but no child falls in 4–14
    // ...but only once the ages are known. With "2 ילדים" and no ages yet,
    // telling the family the camp is not for them — and then asking the
    // ages — was both wrong and rude.
    if (slots.needs_hebrew_kids_club && (slots.children_ages || []).length &&
        !SkiSearch.neededAgeGroups(slots.children_ages).size) {
      notes.push({ type: 'camp_age_mismatch', ages: slots.children_ages || [] });
    }
    // A club was asked for and we do not know a single age. The camp filter
    // below CANNOT run without ages (it needs the age groups), so nothing was
    // filtered — and saying "I showed only the weeks the club runs" over that
    // is a false availability claim. Found 30/08: a family asking for a club
    // with no ages given was shown Bansko 4.2, a week camps.json marks
    // no_camp:true, under exactly that sentence.
    if (slots.needs_hebrew_kids_club && !(slots.children_ages || []).length) {
      notes.push({ type: 'camp_unverified' });
    }
    // Some children are in range and some are not. Saying nothing about the
    // 14-year-old lets a parent assume all their children have a group.
    if (slots.needs_hebrew_kids_club) {
      const outside = (slots.children_ages || []).filter(a => !SkiSearch.inCampAge(a));
      if (outside.length && SkiSearch.neededAgeGroups(slots.children_ages).size) {
        notes.push({ type: 'camp_age_partial', ages: outside });
      }
    }
    // a resort pingwin sells but holds no commitments for — bookable only on
    // dates free of the "commitments only" restriction, and always subject to
    // hotel confirmation (Tomer 23/08). The bot routes it, never quotes it.
    if (slots.off_commitment_destination) {
      // name the dates that are actually free of the restriction, so the
      // customer gets something concrete instead of a vague "ask a rep"
      const c = slots.off_commitment_country || slots.country || null;
      const open = c ? this.openDates(c, slots.month) : [];
      notes.push({
        type: 'destination_off_commitment', name: slots.off_commitment_destination,
        needs_rep: true, open_dates: open, country: c,
      });
    }
    if (slots.out_of_season) notes.push({ type: 'out_of_season' });
    // Tell the customer which of their stated requirements actually shaped the
    // search, and which ones this system cannot verify — a long requirements
    // list answered with three silent cards looks like nothing was read.
    const applied = [];
    if (slots.no_saturday_flights) applied.push('בלי טיסות בשבת');
    if (slots.nights_wanted) applied.push(`${slots.nights_wanted} לילות`);
    if (slots.departure_airport && slots.departure_airport !== 'any') {
      applied.push('יציאה מ' + (this.departures.airports[slots.departure_airport] || {}).he);
    }
    for (const p of slots.preferences || []) applied.push(p);
    if (applied.length) notes.push({ type: 'applied_requirements', items: applied });

    // departure airport that cannot reach what was asked for — say so up front
    const airport = slots.departure_airport;
    const airportSheets = this.allowedSheets(airport);
    if (airportSheets) {
      const info = this.departures.airports[airport];
      const reachable = new Set(this.av.units.filter(u => airportSheets.includes(u.sheet)).map(u => u.country));
      if (slots.country && !reachable.has(slots.country)) {
        notes.push({
          type: 'airport_cannot_reach', airport, airport_he: info.he,
          requested_country: slots.country, note_he: info.note_he,
        });
      } else {
        notes.push({ type: 'airport_limited', airport, airport_he: info.he, note_he: info.note_he });
      }
    }

    let candidates = this._filter(slots, party, { month: slots.month, country: slots.country, destination: slots.destination });
    let splits = [];

    // A customer weighing two destinations against each other gets both, one
    // after the other, rather than whichever the parser happened to keep.
    if ((slots.compare || []).length > 1) {
      const mix = (month) => slots.compare.map(p => this._filter(
        { ...slots, country: p.country || null, destination: p.destination || null },
        party, { month, country: p.country || null, destination: p.destination || null }));
      let perPlace = mix(slots.month);
      // the month blocking BOTH sides must not silently dissolve the
      // comparison into whichever country the parser kept last — the nearby
      // months are tried with the comparison intact
      if (!perPlace.some(l => l.length) && slots.month != null) {
        for (const m of [slots.month_alt, ...adjacentMonths(+slots.month)].filter(Boolean)) {
          const again = mix(m);
          if (again.some(l => l.length)) {
            perPlace = again;
            relaxed.push({ type: 'month', from: +slots.month, to: +m });
            break;
          }
        }
      }
      const mixed = [];
      for (let i = 0; i < 3; i++) for (const list of perPlace) if (list[i]) mixed.push(list[i]);
      // one side empty is not "no comparison" — the empty side is the news
      // the customer most needs ("באנדורה לא מצאתי מקום פנוי")
      if (perPlace.some(l => l.length)) {
        candidates = mixed;
        // the comparison IS the answer; a leftover "we widened" note above it
        // reads as a contradiction of the cards right underneath
        relaxed = relaxed.filter(r => r.type !== 'location');
        notes.push({
          type: 'comparing',
          places: slots.compare.map((p, i) => ({ ...p, found: perPlace[i].length })),
        });
      }
    }

    // Nothing near the day they named — widen to the month and say so
    if (!candidates.length && slots.exact_day) {
      const wider = this._filter({ ...slots, exact_day: null }, party,
        { month: slots.month, country: slots.country, destination: slots.destination });
      if (wider.length) {
        candidates = wider;
        relaxed.push({ type: 'exact_day', wanted: slots.exact_day, month: slots.month });
      }
    }

    // Nothing in that third of the month — widen to the whole month and say so,
    // rather than silently serving the opposite end of it.
    if (!candidates.length && slots.month_part) {
      const wider = this._filter({ ...slots, month_part: null }, party,
        { month: slots.month, country: slots.country, destination: slots.destination });
      if (wider.length) {
        candidates = wider;
        relaxed.push({ type: 'month_part', wanted: slots.month_part });
      }
    }

    // asked for a country the chosen airport cannot fly → drop the country,
    // keep the airport (the flight is the hard constraint, not the wish)
    if (!candidates.length && notes.some(n => n.type === 'airport_cannot_reach')) {
      candidates = this._filter(slots, party, { month: slots.month, country: null, destination: null });
      if (candidates.length) relaxed.push({ type: 'location' });
    }

    // relaxation ladder (spec 6.1). Trip length gives before the month does —
    // a nearby week is usually closer to what was asked than a short break.
    // Sabbath observance is NEVER relaxed: it is not a preference.
    if (!candidates.length && slots.nights_wanted) {
      candidates = this._filter(slots, party, {
        month: slots.month, country: slots.country, destination: slots.destination, ignoreNights: true,
      });
      if (candidates.length) relaxed.push({ type: 'nights', wanted: slots.nights_wanted });
    }
    // A party too big for one room in the month they asked for. Two rooms in
    // February beats one room in January: the date is usually the constraint
    // people cannot move, and a school holiday never moves.
    if (!candidates.length && party >= 4 && slots.month != null) {
      const sameMonth = this._twoRoomSplits(slots, party);
      if (sameMonth.length) {
        splits = sameMonth;
        relaxed.push({ type: 'two_rooms' });
      }
    }
    // "דצמבר או ינואר" means either — both months are shown side by side,
    // like a destination comparison, not one month plus a permission question.
    if (slots.month_alt) {
      const alt = this._filter(slots, party,
        { month: slots.month_alt, country: slots.country, destination: slots.destination });
      if (candidates.length && alt.length) {
        const mixed = [];
        for (let i = 0; i < 3; i++) { if (candidates[i]) mixed.push(candidates[i]); if (alt[i]) mixed.push(alt[i]); }
        candidates = mixed;
        notes.push({ type: 'both_months' });
      } else if (!candidates.length && alt.length) {
        candidates = alt;
        relaxed.push({ type: 'month', from: +slots.month, to: +slots.month_alt });
      }
    }
    if (!candidates.length && !splits.length && slots.month != null) {
      for (const m of adjacentMonths(+slots.month)) {
        candidates = this._filter(slots, party, { month: m, country: slots.country, destination: slots.destination });
        if (candidates.length) { relaxed.push({ type: 'month', from: +slots.month, to: m }); break; }
      }
    }
    // A camp for a specific child is a hard requirement, not a preference. A
    // week where that child's age group does not run is not a cheaper version
    // of the holiday — it is a holiday where one child sits out. Offering it as
    // a match, with a footnote, is misleading (Tomer, 24/08).
    //
    // So when nothing in the requested scope covers the children, widen the
    // DATE — and then the destination — looking for a week that does, rather
    // than presenting weeks that do not. Only if no week anywhere covers them
    // do the partial ones come back, and then the phrasing says so plainly.
    const covers = (list) => list.some(c => c.camps && !(c.camps.missing || []).length);
    if (slots.needs_hebrew_kids_club && candidates.length && !covers(candidates)) {
      const months = SEASON_MONTHS().filter(m => m !== +slots.month);
      let found = null;
      for (const m of months) {
        const alt = this._filter(slots, party, { month: m, country: slots.country, destination: slots.destination });
        if (covers(alt)) { found = { list: alt, note: { type: 'camp_month', from: +slots.month || null, to: m } }; break; }
      }
      if (!found && (slots.country || slots.destination)) {
        for (const m of [+slots.month, ...months].filter(x => x != null)) {
          const alt = this._filter(slots, party, { month: m, country: null, destination: null });
          if (covers(alt)) {
            // name where the club actually runs — "יעדים אחרים" told a family
            // that asked for Austria nothing about where they were being sent
            const to_countries = [...new Set(alt.filter(c => c.camps && !(c.camps.missing || []).length).map(c => c.country))];
            found = { list: alt, note: { type: 'camp_location', to: m, from_country: slots.country || null, to_countries, groups: [...SkiSearch.neededAgeGroups(slots.children_ages)] } };
            break;
          }
        }
      }
      if (found) {
        candidates = found.list.filter(c => c.camps && !(c.camps.missing || []).length);
        // this supersedes any earlier month/location widening — saying "הרחבתי
        // לינואר" and then "הצגתי את מרץ" in the same breath is just confusing
        for (let i = relaxed.length - 1; i >= 0; i--) {
          if (relaxed[i].type === 'month' || relaxed[i].type === 'location') relaxed.splice(i, 1);
        }
        relaxed.push(found.note);
      }
    }

    // With covered weeks in hand, an uncovered one is not a lesser option to
    // round out the list — it is the thing the customer just ruled out. Filling
    // the third card with it is what made the bot look like it had not read.
    if (slots.needs_hebrew_kids_club && covers(candidates)) {
      const dropped = candidates.filter(c => c.camps && (c.camps.missing || []).length);
      candidates = candidates.filter(c => c.camps && !(c.camps.missing || []).length);
      // say why the list is short, or it looks like we simply have little
      if (dropped.length) {
        notes.push({
          type: 'camp_narrowed',
          groups: [...new Set(dropped.flatMap(c => c.camps.missing))],
        });
      }
    }

    // A family that asked for a camp and is shown weeks where their child's
    // age group does not run deserves to be told which week it DOES run. The
    // bot used to print "אין קבוצת 4-6 בשבוע זה" on three cards and never
    // mention that the group runs a fortnight later.
    if (slots.needs_hebrew_kids_club && candidates.some(c => (c.camps && c.camps.missing || []).length)) {
      const missing = [...new Set(candidates.flatMap(c => (c.camps && c.camps.missing) || []))];
      const covered = [...new Set(candidates
        .filter(c => c.camps && !(c.camps.missing || []).length)
        .map(c => c.date))].sort();
      // also look past the current filter: the group may run in another month
      const wider = [];
      for (const w of this.camps.weeks || []) {
        if (slots.country && w.country !== slots.country) continue;
        const cov = this.campsCoverage(w.resort, w.week, slots.children_ages);
        if (!cov.missing.length && !covered.includes(w.week)) wider.push(w.week);
      }
      notes.push({
        type: 'camp_group_gap', missing,
        dates: covered,
        // nearest first: a March request should not be answered with December
        other_dates: [...new Set(wider)].sort((a, b) => {
          const near = (d) => {
            const m = SkiSearch.monthOf(d);
            const want = +slots.month || m;
            const order = SEASON_MONTHS();
            return Math.abs(order.indexOf(m) - order.indexOf(want));
          };
          return near(a) - near(b) || a.localeCompare(b);
        }),
      });
    }

    // Two rooms in the country they ASKED for beat one room in a country they
    // did not. A group of six wanting Austria was being sent to Bulgaria while
    // two connecting rooms in Austria sat available.
    if (!candidates.length && party >= 3 && (slots.country || slots.destination)) {
      splits = this._twoRoomSplits(slots, party);
      if (splits.length) relaxed.push({ type: 'two_rooms' });
    }
    if (!candidates.length && !splits.length && (slots.country || slots.destination)) {
      // Before widening: is the Sabbath the only thing in the way? Saying so is
      // worth more to a Sabbath-observing family than a list of other countries.
      if (slots.no_saturday_flights) {
        const sat = this._filter({ ...slots, no_saturday_flights: false }, party,
          { month: slots.month, country: slots.country, destination: slots.destination });
        if (sat.length) notes.push({ type: 'saturday_only', country: slots.country || slots.destination });
      }
      candidates = this._filter(slots, party, { month: slots.month, country: null, destination: null });
      if (candidates.length) {
        // if the widened list still holds the wanted country, "לא מצאתי ביעד
        // שביקשתם" is simply false — some secondary constraint (a price
        // ceiling, a room shape) blocked the narrow query, not the country
        const stillWanted = candidates.some(c =>
          (slots.country && c.country === slots.country) ||
          (slots.destination && c.resort === slots.destination));
        if (!stillWanted) relaxed.push({ type: 'location' });
      }
    }
    // any party that no single unit can hold may still fit in two rooms —
    // not just large groups (e.g. a family of 4 where only 2-3 studios exist)
    if (!candidates.length && !splits.length && party >= 3) {
      splits = this._twoRoomSplits(slots, party);
      if (splits.length) relaxed.push({ type: 'two_rooms' });
    }
    // Asked for outright ("חדר משלהן", "שני חדרים נפרדים") — not only when a
    // single room cannot hold the party.
    if (slots.wants_two_rooms && !splits.length && party >= 3) {
      splits = this._twoRoomSplits(slots, party);
      if (splits.length) relaxed.push({ type: 'two_rooms' });
    }
    // Nine and up is a group booking (see the phrasing layer). Offering two
    // rooms for twelve people alongside that is a contradiction, and the
    // two-room offer is the false half.
    // Nine and up: no single unit holds them and a two-room split is a fiction,
    // but an empty screen is worse. Show the hotels and dates that are open in
    // what they asked for, and let a rep build the room split (Tomer, 24/08).
    if (party >= 9) {
      splits = []; relaxed = relaxed.filter(r => r.type !== 'two_rooms');
      if (!candidates.length) {
        candidates = this._filter({ ...slots, adults: null, children_ages: [] }, null,
          { month: slots.month, country: slots.country, destination: slots.destination });
        if (candidates.length) notes.push({ type: 'group_rooms_by_rep', party });
      }
    }
    if (!candidates.length && !splits.length) relaxed.push({ type: 'human_rep' });

    // "יקר לי" (Tomer, 24/08): show something CHEAPER than what they were just
    // shown and say so; if there is nothing cheaper, say plainly that these are
    // the best prices we can offer. Anything else — repeating the same band, or
    // quietly ignoring it — is what makes a customer leave.
    if (slots.price_objection && candidates.length) {
      const ceiling = slots.shown_price_min || null;
      const cheaper = ceiling
        ? candidates.filter(c => { const r = this.priceRankOf(c.hotel); return r != null && r < ceiling; })
        : [];
      if (cheaper.length) {
        candidates = cheaper;
        notes.push({ type: 'cheaper_found' });
      } else if (!ceiling) {
        // We have no classified band for anything on screen, so we cannot say
        // that one option is cheaper than another — and staying silent about
        // "יקר לי" is the worst of the three answers. Say what we can do.
        notes.push({ type: 'price_unranked' });
      } else if (ceiling) {
        // Nothing cheaper WITHIN what they asked for. Sunny's move (30/08): it
        // widened the search — "אני יכולה לבדוק בכל מלונות ישרוטל באילת" — and
        // came back with something genuinely cheaper.
        //
        // This also fixes a claim that could simply be false: "אלה המחירים
        // הטובים ביותר שאנחנו יכולים להציע" was said from inside a filter. A
        // customer who asked for Austria heard it while Bulgaria sat two price
        // bands below, unmentioned.
        //
        // We do NOT silently move them: they chose the destination. We look,
        // and if there is something cheaper elsewhere we say where and offer.
        const elsewhere = this._cheaperElsewhere(slots, ceiling);
        if (elsewhere) notes.push({ type: 'cheaper_elsewhere', ...elsewhere });
        else notes.push({ type: 'no_cheaper' });
      }
    }

    // What the customer could have if they bent one thing. Only worth saying
    // when they already have something — with an empty result set the
    // relaxation ladder above has already moved, and said so.
    if (candidates.length) {
      const room = this.tradeoffs(slots, party, this._distinctWeeks(candidates));
      if (room.length) notes.push({ type: 'tradeoffs', items: room.slice(0, 2) });
    }

    // preference scoring (soft) + recommended-first ordering
    const prefs = slots.preferences || [];
    const wantsBudget = p_budget(prefs);
    for (const c of candidates) {
      const info = this.hotelInfo(c.hotel);
      // how many of the customer's stated wishes this hotel actually matches
      c.score = prefs.reduce((s, p) => s + ((info.tags || []).includes(p) ? 1 : 0), 0);
      // unknown sits in the middle of the sort: it must not be ranked cheapest
      // (it would win the budget sort on no evidence) nor most expensive.
      c.priceRank = this.priceRankOf(c.hotel) != null ? this.priceRankOf(c.hotel) : 3; // 2=₪₪ … 4=₪₪₪₪
      c.recommended = !!info.recommended;
      // Stated requirements are not just things to ANSWER — they should move
      // the right hotel to the top. Someone who asked for a short transfer and
      // separate beds should not be shown the furthest hotel with a double bed
      // first, however well we then explain it.
      c.reqScore = this._requirementScore(c, slots);
    }
    // When a kids club was requested, coverage outranks everything else. The
    // ladder matters: a week where the child's age group DOES NOT RUN AT ALL
    // is not merely a bit worse than one where it runs with a waiting list —
    // it is useless to that family. Ranking both as "partial" put three weeks
    // with no 4-6 group ahead of the one week that had it.
    const campRank = (c) => {
      if (!c.camps) return 0;
      if (c.camps.full) return 3;                                  // runs, places free
      if (!(c.camps.missing || []).length) return 2;               // runs, waiting list
      return 1;                                                    // does not run at all
    };
    candidates.sort((a, b) =>
      (campRank(b) - campRank(a)) ||
      // hotels that actually satisfy what the customer named come first
      (b.reqScore - a.reqScore) ||
      // an explicit wish outranks "recommended" — the customer asked for it
      (b.score - a.score) ||
      // "תקציב חסכוני" means cheapest first, not merely a tiebreak. After
      // "יקר לי" it outranks everything else: saying these are our best prices
      // and then listing a dearer one first makes the sentence a lie.
      (slots.price_objection || wantsBudget ? a.priceRank - b.priceRank : 0) ||
      (b.recommended - a.recommended) || a.date.localeCompare(b.date));

    // With no party size, variety is the whole value of the answer: three
    // studios tell an undecided family nothing. Spread across occupancy sizes
    // first, then fall back to the normal ranking.
    if (!party && candidates.length > 3) {
      const bySize = new Map();
      for (const c of candidates) {
        const occ = this.effectiveOcc(c);
        const k = occ.max || 0;
        if (!bySize.has(k)) bySize.set(k, []);
        bySize.get(k).push(c);
      }
      const spread = [], pools = [...bySize.values()];
      let more = true;
      while (more) {
        more = false;
        for (const pool of pools) if (pool.length) { spread.push(pool.shift()); more = true; }
      }
      candidates = spread;
    }

    // A comparison is only a comparison if both places survive the sort. Ranked
    // purely by score, three Bansko hotels came out on top and Andorra — half
    // the question — never appeared.
    if ((slots.compare || []).length > 1) {
      // resortOf(), not c.resort: the raw candidate carries the hotel and the
      // country, and the resort is only attached later by _present().
      const bucket = (c) => slots.compare.findIndex(pl =>
        (pl.destination && this.resortOf(c.hotel) === pl.destination) ||
        (pl.country && !pl.destination && c.country === pl.country));
      const buckets = slots.compare.map((_, i) => candidates.filter(c => bucket(c) === i));
      const rest = candidates.filter(c => bucket(c) < 0);
      const woven = [];
      for (let i = 0; i < 4; i++) for (const b of buckets) if (b[i]) woven.push(b[i]);
      candidates = [...woven, ...rest];
    }

    // hotel diversity: before capping at 8, prefer one unit per hotel in rank
    // order, then fill remaining slots with extra rooms of already-shown hotels
    const seen = new Set(), diverse = [];
    for (const c of candidates) if (!seen.has(c.hotel)) { diverse.push(c); seen.add(c.hotel); }
    for (const c of candidates) if (!diverse.includes(c)) diverse.push(c);

    return {
      party, notes,
      // one note per kind of relaxation: the ladder can reach the two-room rung
      // by more than one road, and the customer read the same sentence twice
      relaxed: relaxed.filter((r, i, all) =>
        r.type !== 'two_rooms' || all.findIndex(o => o.type === 'two_rooms') === i),
      candidates: diverse.slice(0, 8).map(c => this._present(c, slots)),
      // One combination per hotel and date. Three cards reading "Casa Karina,
      // 5.2" that differ only in which two flats they pair is not three
      // choices — it is the same offer, printed three times.
      two_room_splits: splits.filter((sp, i, all) =>
        all.findIndex(o => o.hotel === sp.hotel && o.date === sp.date) === i).slice(0, 3),
    };
  }

  /* ---- the rules every unit must pass, whichever path is looking at it ----
     _filter uses this for single rooms and _twoRoomSplits for the pool it
     pairs from. It exists as ONE function because it used to be two
     hand-maintained copies, and the copies drifted: the split path silently
     lacked the kids-club rule, so a family that required a Hebrew club was
     offered two rooms in a week where no group ran at all (found 30/08).
     Occupancy is deliberately NOT here — a single room must hold the whole
     party, a pair must hold it between them, and that is the real difference
     between the two callers.
     Returns null when the unit is out, or { camps } when it is in. */
  _unitPasses(u, slots, opts) {
    const o = opts || {};
    const sheets = o.ignoreAirport ? null : this.allowedSheets(slots.departure_airport);
    // 0. departure airport — Haifa flies only specific products, and some
    //    products are exclusive to one airport
    if (sheets && !sheets.includes(u.sheet)) return null;
    if (!o.ignoreAirport && this.sheetBlockedFor(u.sheet, slots.departure_airport)) return null;
    // 1. Sabbath observance — a Saturday departure is unusable, not merely
    //    less attractive, so it is filtered out rather than down-ranked
    if (slots.no_saturday_flights && new Date(u.date + 'T00:00:00Z').getUTCDay() === 6) return null;
    // 2. trip length the customer actually asked for
    if (!o.ignoreNights && slots.nights_wanted && u.nights !== slots.nights_wanted) return null;
    // 3. month / date
    if (o.month != null && !SkiSearch.inMonth(u.date, o.month)) return null;
    // 4. country / destination
    if (o.country && u.country !== o.country) return null;
    // an exclusion the customer stated ("לא צרפת") is never relaxed away —
    // widening the search must not resurrect what they ruled out
    if ((slots.excluded_countries || []).includes(u.country)) return null;
    // named a hotel by name — that is the search, not a ranking hint
    if (slots.hotel && u.hotel !== slots.hotel) return null;
    // asked for a specific third of the month
    if (slots.month_part && SkiSearch.partOf(u.date) !== slots.month_part) return null;
    // asked for an exact departure day — within a few days of it counts,
    // because departures are weekly and the customer means "around then"
    if (slots.exact_day && Math.abs(+u.date.slice(8, 10) - slots.exact_day) > 3) return null;
    // a resort the customer ruled out ("לא בנסקו") — the country stays open
    if ((slots.excluded_destinations || []).some(
      d => matchDestination(d, u, this.resortOf(u.hotel)))) return null;
    if (o.destination && !matchDestination(o.destination, u, this.resortOf(u.hotel))) return null;
    // 5. camps — a hard filter when a club was requested AND a child is
    //    actually of camp age. Asking for a club for a 16-year-old used to
    //    filter every unit away and report "no availability", which was false.
    //    With no age known at all the filter cannot run; search() emits
    //    camp_unverified so the reply says so rather than implying otherwise.
    let camps = null;
    if (slots.needs_hebrew_kids_club && SkiSearch.neededAgeGroups(slots.children_ages).size) {
      const resort = this.resortOf(u.hotel);
      if (!resort) return null;               // unknown resort — can't promise a camp
      camps = this.campsCoverage(resort, u.date, slots.children_ages);
      if (!camps.running.length) return null; // no camp at all that week
      // partial coverage allowed through but flagged — the bot must say it
    }
    return { camps };
  }

  _filter(slots, party, { month, country, destination, ignoreAirport, ignoreNights }) {
    const out = [];
    for (const u of this.av.units) {
      // free — availability.json only contains free units by construction
      // occupancy: one room must hold the whole party
      const fit = this.fits(u, party, slots.adults);
      if (fit === false) continue;
      const pass = this._unitPasses(u, slots, { month, country, destination, ignoreAirport, ignoreNights });
      if (!pass) continue;
      out.push({ ...u, camps: pass.camps, occ_unverified: fit === null });
    }
    return out;
  }

  /* ---- two rooms in the same hotel, same date (PNR never splits a room) ---- */
  _twoRoomSplits(slots, party) {
    const byHotelDate = new Map();
    // Same rules as a single room, from the same function — see _unitPasses.
    // The months the customer named: "דצמבר או ינואר" must open both here too,
    // or a split silently answers only half the question.
    const months = slots.month == null ? [null]
      : [slots.month, ...(slots.month_alt ? [slots.month_alt] : [])];
    for (const u of this.av.units) {
      let pass = null;
      for (const m of months) {
        pass = this._unitPasses(u, slots, {
          month: m, country: slots.country, destination: slots.destination });
        if (pass) break;
      }
      if (!pass) continue;
      const k = u.hotel + '||' + u.date;
      if (!byHotelDate.has(k)) byHotelDate.set(k, []);
      byHotelDate.get(k).push({ ...u, camps: pass.camps });
    }
    const splits = [];
    for (const units of byHotelDate.values()) {
      for (let i = 0; i < units.length; i++) for (let j = i; j < units.length; j++) {
        const a = units[i], b = units[j];
        if (i === j && a.count < 2) continue;
        const oa = this.effectiveOcc(a), ob = this.effectiveOcc(b);
        if (oa.min == null || ob.min == null) continue;
        if (party < oa.min + ob.min || party > oa.max + ob.max) continue;
        // a room composition rule binds a pair exactly as it binds one room
        const minAdults = Math.max(oa.min_adults || 0, ob.min_adults || 0);
        if (minAdults && (slots.adults || 0) < minAdults) continue;
        splits.push({
          hotel: a.hotel, country: a.country, date: a.date, nights: a.nights,
          rooms: [a.room, b.room], capacity: [a.occ_notation, b.occ_notation],
          price_range: this.price(a.hotel),
          // carried so the reply can caveat a partially-covered week; without
          // it the caveat layer had nothing to read and said nothing at all
          camps: a.camps,
        });
      }
    }
    return splits.sort((x, y) => x.date.localeCompare(y.date));
  }

  /* ---- is this question worth asking? ----
     The bot asked a fixed ladder: adults, children, month, camp, airport,
     destination — every time, in that order, whether or not the answer could
     change anything. A rep does not do that. If only one month has anything
     for this party, "מתי תרצו לצאת?" is not a question, it is a formality; and
     if every remaining option flies from the same airport, asking which
     airport wastes the customer's turn.

     Returns the number of DISTINCT answers that would lead to different
     results. 1 or 0 means the question is not worth asking. */
  questionValue(key, slots) {
    const party = (slots.adults || 0) +
      Math.max((slots.children_ages || []).length, slots.children_count || 0);
    if (!party) return 2;                      // nothing known yet — must ask
    // The constraint under test must be LIFTED before counting, or the answer
    // is circular: filtering to January and then asking how many months are
    // available always returns one.
    const run = (over, opts) => this._filter({ ...slots, ...over }, party, {
      month: slots.month, country: slots.country, destination: slots.destination, ...opts,
    });

    if (key === 'month') {
      const all = run({ month: null }, { month: null });
      return new Set(all.map(u => SkiSearch.monthOf(u.date))).size;
    }
    if (key === 'country') {
      const all = run({ country: null, destination: null }, { country: null, destination: null });
      return new Set(all.map(u => u.country)).size;
    }
    if (key === 'airport') {
      // worth asking only if the answer would change what we can offer
      const sizes = new Set([run({ departure_airport: null }, {}).length]);
      for (const a of Object.keys(this.departures.airports || {})) {
        sizes.add(run({ departure_airport: a }, {}).length);
      }
      return sizes.size;
    }
    if (key === 'kids_club') {
      // worth asking only when some weeks run a camp for THESE children and
      // some do not — otherwise the answer cannot change the offer set
      const base = run({ needs_hebrew_kids_club: false }, {});
      if (!base.length) return 2;
      const withCamp = base.filter(u => {
        const cov = this.campsCoverage(this.resortOf(u.hotel), u.date, slots.children_ages);
        return cov.running.length && !cov.missing.length;
      }).length;
      return withCamp > 0 && withCamp < base.length ? 2 : 1;
    }
    return 2;
  }

  /* ---- what would open up if one constraint were dropped ----
     A rep who is worth talking to does not just answer the question asked. He
     says "with the Hebrew camp there is one week; without it there are eleven;
     move a week and there are three WITH it." The bot never said anything of
     the kind, because the relaxation ladder only ran when the result set was
     EMPTY — with two offers in hand it stayed quiet about the eight the
     customer could have had.

     This is pure counting against the same deterministic filter. No model, no
     invention: each entry is "how many units qualify if exactly this one
     constraint is lifted". */
  tradeoffs(slots, party, currentCount) {
    const out = [];
    const count = (over) => {
      const alt = { ...slots, ...over };
      const p = SkiSearch.partyOf(alt);
      let list = this._filter(alt, p || party, {
        month: alt.month, country: alt.country, destination: alt.destination,
        ignoreNights: over.nights_wanted === null,
      });
      if (alt.needs_hebrew_kids_club) {
        list = list.filter(c => c.camps && !(c.camps.missing || []).length);
      }
      return this._distinctWeeks(list);
    };

    if (slots.needs_hebrew_kids_club) {
      const n = count({ needs_hebrew_kids_club: false });
      if (n > currentCount) out.push({ drop: 'camp', gain: n - currentCount, total: n });
    }
    if (slots.month != null && slots.month !== 'any') {
      const n = count({ month: null });
      if (n > currentCount) out.push({ drop: 'month', gain: n - currentCount, total: n });
    }
    // "רק אוסטריה" is not a preference we may bargain with. Offering to drop
    // the country right after the customer said "only" reads as not listening.
    if ((slots.country || slots.destination) && !slots.country_fixed &&
        !(slots.compare || []).length) {
      const n = count({ country: null, destination: null });
      if (n > currentCount) out.push({ drop: 'country', gain: n - currentCount, total: n });
    }
    if (slots.nights_wanted) {
      const n = count({ nights_wanted: null });
      if (n > currentCount) out.push({ drop: 'nights', gain: n - currentCount, total: n });
    }
    // NOT offered: Sabbath flights. It is not a preference to be traded away,
    // and suggesting it would be offensive rather than helpful.
    return out.sort((a, b) => b.gain - a.gain);
  }

  // distinct hotel+date pairs — the unit a customer actually chooses between
  _distinctWeeks(list) {
    return new Set(list.map(c => c.hotel + '|' + c.date)).size;
  }

  /* "יקר לי", and nothing cheaper inside what they asked for. Look ONE step
     wider and report where a lower price band actually exists — the destination
     first (a customer who fixed on Austria may not know Bulgaria is two bands
     below), then the month.

     Deliberately conservative:
       - it never returns the customer's own filter back to them;
       - it only reports a band that is genuinely LOWER than what they saw;
       - it reports where, never a number (red rule 3);
       - it does not change `candidates`. The customer picked a destination;
         moving them without asking is not a discount, it is not listening.
     Returns { by: 'country'|'month', country?, month?, band } or null. */
  _cheaperElsewhere(slots, ceiling) {
    const quiet = { ...slots, price_objection: false, shown_price_min: null };
    const bandOf = list => (list.length
      ? Math.min(...list.map(c => this.priceRankOf(c.hotel)).filter(r => r != null)) : Infinity);

    // 1. the same dates, somewhere else. Their explicit exclusions still hold —
    //    "לא בולגריה" means not Bulgaria, cheap or otherwise.
    if (slots.country || slots.destination) {
      const excluded = new Set(slots.excluded_countries || []);
      let best = null;
      for (const country of ['bulgaria', 'andorra', 'austria', 'france']) {
        if (country === slots.country || excluded.has(country)) continue;
        let found;
        try {
          found = this.search({ ...quiet, country, destination: null, hotel: null });
        } catch (e) { continue; }              // never let this break the turn
        const band = bandOf(found.candidates || []);
        if (band < ceiling && (!best || band < best.band)) best = { country, band };
      }
      if (best) return { by: 'country', country: best.country, band: best.band };
    }

    // 2. the same destination, a different month — the other lever a customer
    //    can actually pull.
    if (slots.month != null && slots.month !== 'any') {
      let best = null;
      for (const month of SEASON_MONTHS()) {
        if (month === +slots.month) continue;
        let found;
        try {
          found = this.search({ ...quiet, month, month_alt: null, exact_day: null, month_part: null });
        } catch (e) { continue; }
        const band = bandOf(found.candidates || []);
        if (band < ceiling && (!best || band < best.band)) best = { month, band };
      }
      if (best) return { by: 'month', month: best.month, band: best.band };
    }
    return null;
  }

  // How well a hotel meets the requirements the customer named in words
  // (separate beds, breakfast, a short transfer, ski pass, equipment). Soft:
  // it reorders, it never removes — the workbook, not this, decides what is
  // available. Everything it reads comes from the hotel's own page.
  _requirementScore(c, slots) {
    const asked = new Set(slots.unverifiable || []);
    if (!asked.size) return 0;
    const info = this.hotelInfo(c.hotel);
    let s = 0;
    if (asked.has('מיטות נפרדות')) {
      const facts = roomFacts(c.room, info.rooms, null);
      const SEP = /מיטות נפרדות|מיטות יחיד|2 מיטות|שתי מיטות|טווין|twin/i;
      if (facts && SEP.test(facts.beds_he || '')) s += 3;
      else if ((info.rooms || []).some(r => SEP.test(r.beds_he || '') || /twin|טווין/i.test(r.name))) s += 1;
    }
    if (asked.has('בסיס האירוח')) {
      const board = info.board_he || '';
      // rank by what was actually asked for, not merely by having a board
      const RANK = { all_inclusive: /הכל כלול/, full: /פנסיון מלא|הכל כלול/, half: /חצי פנסיון|פנסיון מלא|הכל כלול/, breakfast: /ארוחת בוקר|חצי פנסיון|פנסיון מלא|הכל כלול/ };
      const want = slots.board_wanted;
      if (want && RANK[want]) s += RANK[want].test(board) ? 3 : -1;
      else if (/ארוחת בוקר|חצי פנסיון|פנסיון מלא|הכל כלול/.test(board)) s += 2;
    }
    if (asked.has('המרחק משדה התעופה')) {
      const km = SkiSearch.transferKm(info.transfer_he);
      // most pages give no distance; that silence is not evidence of a long
      // drive, so unknown scores the same as an average one — only a genuinely
      // short transfer is rewarded and a genuinely long one penalised
      if (km != null) s += km <= 100 ? 2 : (km > 170 ? -1 : 0);
    }
    if (asked.has('סקי פס') && !this.inclusions.ski_pass.excluded_countries.includes(c.country)) s += 1;
    if (asked.has('השכרת ציוד') &&
        (this.inclusions.equipment_rental.included_at_he || []).includes(c.hotel)) s += 2;
    return s;
  }

  // "כ-160 ק"מ משדה התעופה סופיה" → 160
  static transferKm(text) {
    const m = String(text || '').match(/(\d{2,3})\s*ק"?מ/);
    return m ? +m[1] : null;
  }

  _present(c, slots) {
    const occ = this.effectiveOcc(c);
    const info = this.hotelInfo(c.hotel);
    // Bed layout / size / bathrooms of the offered unit, read off the hotel
    // page (never inferred). Party-aware: a "DBL 2-4" is a different physical
    // room for a couple than for a family of four.
    const party = (slots && slots.adults != null)
      ? slots.adults + Math.max((slots.children_ages || []).length, slots.children_count || 0)
      : null;
    const facts = roomFacts(c.room, info.rooms, party);
    // "separate beds" is the single most common hard requirement (couples who
    // are siblings or friends, Sabbath-observant guests). If the offered unit
    // is not a twin, the hotel may still HAVE one — saying so is a fact from
    // the hotel page, and is explicitly not a promise of availability.
    const SEP = /מיטות נפרדות|מיטות יחיד|2 מיטות|שתי מיטות|טווין|twin/i;
    const offeredTwin = !!(facts && facts.beds_he && SEP.test(facts.beds_he));
    const twinElsewhere = offeredTwin ? null
      : (info.rooms || []).find(r => SEP.test(r.beds_he || '') || /twin|טווין/i.test(r.name)) || null;
    const inc = this.inclusions;
    const skiPassIncluded = !inc.ski_pass.excluded_countries.includes(c.country);
    const equipIncluded = (inc.equipment_rental.included_at_he || []).includes(c.hotel);
    return {
      req_score: c.reqScore != null ? c.reqScore : 0, // how many stated wishes it meets
      room_facts: facts,                       // {name, exact, size_he, beds_he, bath_he}
      separate_beds: offeredTwin ? 'yes' : (twinElsewhere ? 'other_room' : 'unknown'),
      separate_beds_other_he: twinElsewhere
        ? twinElsewhere.name + ' — ' + (twinElsewhere.beds_he || 'מיטות נפרדות')
        : null,
      board_he: info.board_he || null,         // בסיס האירוח מדף המלון
      wifi_he: info.wifi_he || null,           // ציטוט מדף המלון
      spa_he: info.spa_he || null,             // ציטוט מדף המלון
      page_facts: info.page_facts || null,     // נוף, בריכה, מיקום, מסעדה… — ציטוטים מדף המלון (data/hotel-facts.json)
      spa_access: info.spa_access || 'none',   // free|entries|paid|guests|not_stated|none
      spa_access_he: info.spa_access_he || null,
      spa_note_he: info.spa_note_he || null,
      spa_min_age: info.spa_min_age || null,
      transfer_he: info.transfer_he || null,   // הסעות / מרחק מהשדה
      ski_pass_he: skiPassIncluded ? (info.ski_pass_he || null) : null,
      ski_pass_included: skiPassIncluded,
      equipment_included: equipIncluded,
      equipment_he: equipIncluded
        ? (info.equipment_he || inc.equipment_rental.included_he)
        : inc.equipment_rental.supplement_he,
      occ_effective: { min: occ.min, max: occ.max },
      occ_composition_he: occ.composition_he, // e.g. "זוג + ילד עד גיל 10" — from the hotel page
      desc_he: info.desc_he || null,          // one-liner from the pingwin hotel page
      lift_he: info.lift_he || null,
      tags: info.tags || [],
      image: info.image || null,              // official photo from the pingwin site
      hotel: c.hotel,
      resort: this.resortOf(c.hotel),          // null = not yet verified vs pingwin site
      country: c.country,
      date: c.date, date_label: c.date_label, nights: c.nights,
      room: c.room, room_type: c.room_type,
      occ_notation: c.occ_notation, occ_min: c.occ_min, occ_max: c.occ_max,
      needs_hotel_rule: c.needs_hotel_rule,    // X+Y — exact composition per hotel page (TODO)
      count_available: c.count,
      price_range: this.price(c.hotel),
      recommended: c.recommended,
      camps: c.camps,                          // {full, running, missing} or null
      occ_unverified: !!c.occ_unverified,
    };
  }
}

function adjacentMonths(m) {
  // season order, from the season file rather than written out again
  const order = SEASON_MONTHS();
  const i = order.indexOf(m);
  if (i < 0) return order;
  return [order[i - 1], order[i + 1]].filter(Boolean);
}

function matchDestination(dest, unit, resort) {
  const d = String(dest).toLowerCase();
  return unit.hotel.toLowerCase().includes(d) ||
         (resort && resort.toLowerCase().includes(d)) ||
         unit.sheet.toLowerCase().includes(d);
}

function p_budget(prefs) { return prefs.some(p => /תקציב|budget|זול/.test(p)); }

module.exports = { SkiSearch };
