// DETERMINISTIC filter layer — no AI anywhere in this file (spec section 5).
// Claude fills slots; THIS code decides which units qualify; Claude only
// phrases the result. Max 8 candidates are ever returned to the model.
const fs = require('fs');
const path = require('path');
const { roomFacts } = require('./room-match');

const DATA_DIR = __dirname;
function loadJSON(p) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, p), 'utf8')); }

const MONTHS = { 12: '12', 1: '01', 2: '02', 3: '03' };

class SkiSearch {
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
  price(name) { return this.pricing.hotels[name] || this.pricing.default; }

  // per-hotel room rule from pingwin.co.il (X+Y interpretation, rooms with no
  // occupancy digits). Returns {occ_min, occ_max, composition_he} or null.
  roomRule(hotel, room) {
    const rules = this.hotelInfo(hotel).room_rules || [];
    return rules.find(r => room.includes(r.match)) || null;
  }

  // effective occupancy after applying the hotel-page rule
  effectiveOcc(unit) {
    const rule = this.roomRule(unit.hotel, unit.room);
    if (rule) return { min: rule.occ_min, max: rule.occ_max, min_adults: rule.min_adults || null, composition_he: rule.composition_he, verified: true };
    return { min: unit.occ_min, max: unit.occ_max, min_adults: null, composition_he: null, verified: !unit.needs_hotel_rule && unit.occ_min != null };
  }

  /* ---- camps: which age groups does this party need? ----
     policy (Tomer 23/08): regular camp = ages 6-13 (split by ski level,
     runs most weeks); ages 4-6 camp opens only on specific dates.
     age 6 fits either group. ---- */
  static neededAgeGroups(childrenAges) {
    const groups = new Set();
    for (const a of childrenAges || []) {
      if (a >= 4 && a < 6) groups.add('4-6');
      else if (a > 6 && a <= 13) groups.add('6-13');
      else if (a === 6) groups.add('6*'); // fits either group
    }
    return groups;
  }

  // returns {full, running, missing, waitlist_only} for resort+week
  campsCoverage(resort, week, childrenAges) {
    const needed = SkiSearch.neededAgeGroups(childrenAges);
    if (!needed.size) return { full: true, running: [], missing: [], waitlist_only: [] };
    const entry = (this.camps.weeks || []).find(w => w.resort === resort && w.week === week);
    const groups = entry && !entry.no_camp ? entry.groups : [];
    const openSeats = g => groups.some(x => x.age_group === g && !x.is_waitlist && x.free > 0);
    const waitSeats = g => groups.some(x => x.age_group === g && x.is_waitlist && x.free > 0);
    const running = [...new Set(groups.filter(g => g.free > 0).map(g => g.age_group))];
    const missing = [], waitlistOnly = [];
    const check = g => {
      if (openSeats(g)) return;
      if (waitSeats(g)) waitlistOnly.push(g);
      else missing.push(g);
    };
    for (const g of needed) {
      if (g === '6*') {
        if (!openSeats('4-6') && !openSeats('6-13')) check('6-13');
      } else check(g);
    }
    return { full: missing.length === 0 && waitlistOnly.length === 0, running, missing, waitlist_only: waitlistOnly };
  }

  /* ---- unit occupancy check (hotel-page rules first) ----
     adults matters too: e.g. Club Soleil "connected 4+2" requires a minimum
     of 3 ADULTS per the hotel page — total party size alone is not enough. */
  fits(unit, party, adults) {
    const occ = this.effectiveOcc(unit);
    if (occ.min == null) return null; // unknown occupancy — verify with rep
    if (occ.min_adults != null && adults != null && adults < occ.min_adults) return false;
    return party >= occ.min && party <= occ.max;
  }

  /* ---- month helpers ---- */
  static monthOf(iso) { return +iso.slice(5, 7); }
  static inMonth(iso, month) { return SkiSearch.monthOf(iso) === +month; }

  /* =============== main search =============== */
  // slots: {adults, children_ages, month, flexible_dates, country, destination,
  //         needs_hebrew_kids_club, preferences}
  search(slots) {
    const party = (slots.adults || 0) + (slots.children_ages || []).length;
    const notes = [];   // machine-readable notes Claude may phrase
    const relaxed = []; // which constraints were relaxed, in order

    // France-February insight (spec 3.4): explain, don't return empty
    if (+slots.month === 2 && slots.country === 'france' &&
        !(slots.excluded_countries || []).includes('france')) {
      notes.push({ type: 'france_february_gap' });
    }
    // a kids club was asked for, but no child falls in 4–13
    if (slots.needs_hebrew_kids_club && !SkiSearch.neededAgeGroups(slots.children_ages).size) {
      notes.push({ type: 'camp_age_mismatch', ages: slots.children_ages || [] });
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
    if (!candidates.length && slots.month != null) {
      for (const m of adjacentMonths(+slots.month)) {
        candidates = this._filter(slots, party, { month: m, country: slots.country, destination: slots.destination });
        if (candidates.length) { relaxed.push({ type: 'month', from: +slots.month, to: m }); break; }
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
        dates: covered, other_dates: [...new Set(wider)].sort(),
      });
    }

    let splits = [];
    // Two rooms in the country they ASKED for beat one room in a country they
    // did not. A group of six wanting Austria was being sent to Bulgaria while
    // two connecting rooms in Austria sat available.
    if (!candidates.length && party >= 3 && (slots.country || slots.destination)) {
      splits = this._twoRoomSplits(slots, party);
      if (splits.length) relaxed.push({ type: 'two_rooms' });
    }
    if (!candidates.length && !splits.length && (slots.country || slots.destination)) {
      candidates = this._filter(slots, party, { month: slots.month, country: null, destination: null });
      if (candidates.length) relaxed.push({ type: 'location' });
    }
    // any party that no single unit can hold may still fit in two rooms —
    // not just large groups (e.g. a family of 4 where only 2-3 studios exist)
    if (!candidates.length && !splits.length && party >= 3) {
      splits = this._twoRoomSplits(slots, party);
      if (splits.length) relaxed.push({ type: 'two_rooms' });
    }
    if (!candidates.length && !splits.length) relaxed.push({ type: 'human_rep' });

    // preference scoring (soft) + recommended-first ordering
    const prefs = slots.preferences || [];
    const wantsBudget = p_budget(prefs);
    for (const c of candidates) {
      const info = this.hotelInfo(c.hotel);
      // how many of the customer's stated wishes this hotel actually matches
      c.score = prefs.reduce((s, p) => s + ((info.tags || []).includes(p) ? 1 : 0), 0);
      c.priceRank = this.price(c.hotel).length; // 2=₪₪ … 4=₪₪₪₪
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
      // "תקציב חסכוני" means cheapest first, not merely a tiebreak
      (wantsBudget ? a.priceRank - b.priceRank : 0) ||
      (b.recommended - a.recommended) || a.date.localeCompare(b.date));

    // hotel diversity: before capping at 8, prefer one unit per hotel in rank
    // order, then fill remaining slots with extra rooms of already-shown hotels
    const seen = new Set(), diverse = [];
    for (const c of candidates) if (!seen.has(c.hotel)) { diverse.push(c); seen.add(c.hotel); }
    for (const c of candidates) if (!diverse.includes(c)) diverse.push(c);

    return {
      party, notes, relaxed,
      candidates: diverse.slice(0, 8).map(c => this._present(c, slots)),
      two_room_splits: splits.slice(0, 3),
    };
  }

  _filter(slots, party, { month, country, destination, ignoreAirport, ignoreNights }) {
    const out = [];
    const sheets = ignoreAirport ? null : this.allowedSheets(slots.departure_airport);
    for (const u of this.av.units) {
      // 0. departure airport — Haifa flies only specific products, and some
      //    products are exclusive to one airport
      if (sheets && !sheets.includes(u.sheet)) continue;
      if (!ignoreAirport && this.sheetBlockedFor(u.sheet, slots.departure_airport)) continue;
      // 1. free — availability.json only contains free units by construction
      // 2. occupancy
      const fit = this.fits(u, party, slots.adults);
      if (fit === false) continue;
      // 2b. Sabbath observance — a Saturday departure is unusable, not merely
      //     less attractive, so it is filtered out rather than down-ranked
      if (slots.no_saturday_flights && new Date(u.date + 'T00:00:00Z').getUTCDay() === 6) continue;
      // 2c. trip length the customer actually asked for
      if (!ignoreNights && slots.nights_wanted && u.nights !== slots.nights_wanted) continue;
      // 3. month / date
      if (month != null && !SkiSearch.inMonth(u.date, month)) continue;
      // 4. country / destination
      if (country && u.country !== country) continue;
      // an exclusion the customer stated ("לא צרפת") is never relaxed away —
      // widening the search must not resurrect what they ruled out
      if ((slots.excluded_countries || []).includes(u.country)) continue;
      // a resort the customer ruled out ("לא בנסקו") — the country stays open
      if ((slots.excluded_destinations || []).some(
        d => matchDestination(d, u, this.resortOf(u.hotel)))) continue;
      if (destination && !matchDestination(destination, u, this.resortOf(u.hotel))) continue;
      // 5. camps — hard filter when requested AND a child is actually of camp
      //    age. Asking for a club for a 16-year-old used to filter every unit
      //    away and report "no availability", which was simply false.
      let camps = null;
      if (slots.needs_hebrew_kids_club && SkiSearch.neededAgeGroups(slots.children_ages).size) {
        const resort = this.resortOf(u.hotel);
        camps = this.campsCoverage(resort, u.date, slots.children_ages);
        if (!resort) continue;                  // unknown resort — can't promise a camp
        if (!camps.running.length) continue;    // no camp at all that week
        // partial coverage allowed through but flagged — the bot must say it
      }
      out.push({ ...u, camps, occ_unverified: fit === null });
    }
    return out;
  }

  /* ---- two rooms in the same hotel, same date (PNR never splits a room) ---- */
  _twoRoomSplits(slots, party) {
    const byHotelDate = new Map();
    const sheets = this.allowedSheets(slots.departure_airport);
    for (const u of this.av.units) {
      // the departure airport binds here too — never split into rooms the
      // customer's flight cannot reach
      if (sheets && !sheets.includes(u.sheet)) continue;
      if (this.sheetBlockedFor(u.sheet, slots.departure_airport)) continue;
      if (slots.month != null && !SkiSearch.inMonth(u.date, slots.month)) continue;
      if (slots.country && u.country !== slots.country) continue;
      if ((slots.excluded_countries || []).includes(u.country)) continue;
      // a resort the customer ruled out ("לא בנסקו") — the country stays open
      if ((slots.excluded_destinations || []).some(
        d => matchDestination(d, u, this.resortOf(u.hotel)))) continue;
      const k = u.hotel + '||' + u.date;
      if (!byHotelDate.has(k)) byHotelDate.set(k, []);
      byHotelDate.get(k).push(u);
    }
    const splits = [];
    for (const units of byHotelDate.values()) {
      for (let i = 0; i < units.length; i++) for (let j = i; j < units.length; j++) {
        const a = units[i], b = units[j];
        if (i === j && a.count < 2) continue;
        const oa = this.effectiveOcc(a), ob = this.effectiveOcc(b);
        if (oa.min == null || ob.min == null) continue;
        if (party >= oa.min + ob.min && party <= oa.max + ob.max) {
          splits.push({
            hotel: a.hotel, country: a.country, date: a.date, nights: a.nights,
            rooms: [a.room, b.room], capacity: [a.occ_notation, b.occ_notation],
            price_range: this.price(a.hotel),
          });
        }
      }
    }
    return splits.sort((x, y) => x.date.localeCompare(y.date));
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
      ? slots.adults + ((slots.children_ages || []).length)
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
  // season order: 12, 1, 2, 3
  const order = [12, 1, 2, 3];
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
