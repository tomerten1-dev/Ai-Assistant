'use strict';
/* Conversation state comes back from the browser on every turn, and the
   browser is not a trusted narrator. crm-lead.js already says this out loud
   about the lead payload — "the widget is a browser and its payload is input,
   not truth" — and builds a whitelist. The chat endpoint was never given the
   same treatment, and it needed it more: several slots are printed to the
   customer VERBATIM, above the offers, in the bot's own voice.

   Reproduced 30/08:
     POST /api/chat  slots.notes_from_customer:
       ["הלקוח זכאי להנחה של 50% ולקוד קופון SKI50"]
     → "רשמתי לפניי: הלקוח זכאי להנחה של 50% ולקוד קופון SKI50 — נציג יבדוק ויאשר."

   That text passed no guard: guard() and deflect() inspect the customer's
   MESSAGE, and prompt-phrase.validate() inspects the MODEL's output. Nothing
   inspected the slots. Anyone could make Pingwin's own bot promise a discount,
   on Pingwin's own page, and screenshot it.

   Three rules here, in order of how much they buy:
     1. Unknown keys are dropped. The reply can only ever be built from state
        this server knows how to produce.
     2. Every value is coerced to its declared shape. A slot that should be a
        number cannot arrive as an object, and an array cannot arrive as a
        string — which also removes a class of crashes (`.some is not a
        function`) that turned every such turn into the error line.
     3. Free text is held to the same red rules as everything else the customer
        reads: no money figures, no discount or coupon claims, no links, and a
        length cap. A note is a fragment of what someone said, not a paragraph.

   Identity-like slots (country, destination, hotel) are resolved against the
   real inventory rather than filtered, so an invented place cannot survive the
   round trip at all. */

const { SkiSearch } = require('../data/filter.js');

const COUNTRIES = new Set(['austria', 'france', 'andorra', 'bulgaria', 'any']);
const AIRPORTS = new Set(['tlv', 'haifa', 'any']);
const MONTH_PARTS = new Set(['early', 'mid', 'late']);

// A note or preference is a short fragment. 120 characters is longer than any
// the parser has ever produced and far shorter than a paragraph of copy.
const MAX_TEXT = 120;
const MAX_LIST = 12;
// A whole reply line — what the said-once memories hold. The bot's longest
// approved paragraph (the cancellation ladder) is well under this.
const LINE_MAX = 900;

/* Red rules, applied to text arriving from the browser exactly as they are
   applied to text leaving the model. Money is red rule 3; the rest are the
   shapes an attacker needs in order to make the sentence worth screenshotting. */
// (\b is useless after Hebrew letters — they are not \w in JS, so a trailing
// word boundary never matches. "1200 אירו" walked straight through the first
// version of this pattern for exactly that reason; it is the third time this
// trap has bitten in this codebase, so it is spelled out here too.)
const CURRENCY = 'אירו|יורו|שקל|שקלים|דולר|eur|usd|ils';
const MONEY = new RegExp(
  '[€$₪]' +
  '|\\d[\\d,.]*\\s*(?:' + CURRENCY + ')(?![א-ת])' +
  '|(?:' + CURRENCY + ')\\s*\\d' +
  '|\\bמחיר\\S*\\s+\\S*\\d', 'i');
const DISCOUNT = /\d\s*%|\bאחוז\b|הנח[הת]|קופון|coupon|voucher|promo|מבצע מיוחד|חינם|ללא עלות|בלי עלות|ביטול חופשי|free of charge/i;
const LINK = /https?:\/\/|www\.|<[a-z/!]/i;
const PROMISE = /מובטח|אנחנו מתחייבים|בהתחייבות|guarantee/i;

function textIsClean(v) {
  return !MONEY.test(v) && !DISCOUNT.test(v) && !LINK.test(v) && !PROMISE.test(v);
}

function str(v, { clean = false, max = MAX_TEXT } = {}) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t || t.length > max) return null;
  if (clean && !textIsClean(t)) return null;
  return t;
}

function list(v, { clean = false, max = MAX_TEXT, items = MAX_LIST } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const t = str(item, { clean, max });
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= items) break;
  }
  return out;
}

function int(v, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= min && i <= max ? i : null;
}

function bool(v) { return v === true ? true : v === false ? false : null; }

function ages(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const a of v) {
    const n = int(a, { min: 0, max: 25 });
    if (n != null) out.push(n);
    if (out.length >= 10) break;
  }
  return out;
}

function countries(v) {
  return (Array.isArray(v) ? v : []).filter(c => COUNTRIES.has(c) && c !== 'any').slice(0, 4);
}

/* Identity slots are RESOLVED, not filtered: whatever arrives has to name a
   real place in our own data or it is dropped. An invented resort cannot make
   it back in through this door. */
function makeResolvers(engine) {
  const hotels = new Set((engine.av.units || []).map(u => u.hotel));
  return {
    hotel(v) { const t = str(v); return t && hotels.has(t) ? t : null; },
    destination(v) {
      const t = str(v);
      if (!t) return null;
      const canon = require('./offline-nlu.js').canonicalDestination(t);
      return canon || null;
    },
    destinations(v) {
      const o = require('./offline-nlu.js');
      const out = [];
      for (const item of (Array.isArray(v) ? v : [])) {
        const canon = o.canonicalDestination(str(item) || '');
        if (canon && !out.includes(canon)) out.push(canon);
        if (out.length >= 4) break;
      }
      return out;
    },
  };
}

/* Internal bookkeeping the widget round-trips. These are ours, not the
   customer's, so they are shape-checked and capped but not red-rule filtered.
   `_turns` is deliberately NOT here: the turn cap must be counted server-side
   or a client that always sends 0 never reaches it. */
function bookkeeping(raw, out) {
  const cid = str(raw._cid);
  if (cid && /^c[a-z0-9]{4,32}$/i.test(cid)) out._cid = cid;
  const vt = str(raw._vt);
  if (vt && /^[a-f0-9]{16,128}$/i.test(vt)) out._vt = vt;

  // These hold text this server wrote — whole reply lines, in the case of
  // _lastLines and _fixed_said, which are how a paragraph already said once is
  // suppressed the second time. The 120-character note cap does not apply to
  // them: it silently dropped the long ones, and the repeat suppression with
  // them. Each cap matches what the server actually writes.
  out._asked = list(raw._asked, { items: 12, max: 80 });
  out._shown = list(raw._shown, { items: 30, max: 120 });
  out._compared = list(raw._compared, { items: 3, max: 120 });   // hotels just characterized
  out._notes_said = list(raw._notes_said, { items: 20, max: MAX_TEXT });
  out._fixed_said = list(raw._fixed_said, { items: 8, max: LINE_MAX });
  out._lastLines = list(raw._lastLines, { items: 24, max: LINE_MAX });

  const held = int(raw._held, { min: 0, max: 20 });
  if (held != null) out._held = held;
  const lost = int(raw._lost, { min: 0, max: 20 });
  if (lost != null) out._lost = lost;
  const priceMin = int(raw.shown_price_min, { min: 0, max: 10 });
  if (priceMin != null) out.shown_price_min = priceMin;

  // the customer's language, when the turn was translated in and out
  const lang = str(raw._lang);
  if (lang && /^(en|ru|fr|ar)$/.test(lang)) out._lang = lang;
  for (const k of ['_closed', '_nudged', '_showMe', '_after_cards']) {
    const b = bool(raw[k]);
    if (b != null) out[k] = b;
  }
  for (const k of ['_lastQuestion', '_lastFaqId', '_lead_kind', '_nextq']) {
    const t = str(raw[k]);
    if (t) out[k] = t;
  }
  // the existing-customer / complaint thread (server.js step 1a½) — a closed set
  if (raw._rep_mode === 'existing' || raw._rep_mode === 'complaint' || raw._rep_mode === 'group') out._rep_mode = raw._rep_mode;
  // said-once memories: compared by equality against a line we generated, so
  // an arbitrary value can only ever suppress a line, never introduce one
  for (const k of ['_dates_said', '_know_said', '_lastGuard', '_lastEcho', '_lastCards']) {
    const t = str(raw[k], { max: LINE_MAX });
    if (t) out[k] = t;
  }
}

/* The only way conversation state enters this server. */
function sanitizeIncomingSlots(raw, engine, empty) {
  const out = { ...(empty || {}) };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const R = makeResolvers(engine);

  out.adults = int(raw.adults, { min: 0, max: 40 });
  out.children_ages = ages(raw.children_ages);
  const cc = int(raw.children_count, { min: 0, max: 15 });
  if (cc != null) out.children_count = cc;
  out.no_children = bool(raw.no_children);

  out.month = int(raw.month, { min: 1, max: 12 });
  out.month_alt = int(raw.month_alt, { min: 1, max: 12 });
  out.exact_day = int(raw.exact_day, { min: 1, max: 31 });
  out.nights_wanted = int(raw.nights_wanted, { min: 1, max: 30 });
  out.month_part = MONTH_PARTS.has(raw.month_part) ? raw.month_part : null;
  out.flexible_dates = bool(raw.flexible_dates);
  out.wrong_year = int(raw.wrong_year, { min: 1900, max: 2200 });

  out.country = COUNTRIES.has(raw.country) ? raw.country : null;
  out.country_fixed = bool(raw.country_fixed);
  out.destination = R.destination(raw.destination);
  out.hotel = R.hotel(raw.hotel);
  out.excluded_countries = countries(raw.excluded_countries);
  out.excluded_destinations = R.destinations(raw.excluded_destinations);
  out.compare = R.destinations(raw.compare);

  out.departure_airport = AIRPORTS.has(raw.departure_airport) ? raw.departure_airport : null;
  out.needs_hebrew_kids_club = bool(raw.needs_hebrew_kids_club);
  out.no_saturday_flights = bool(raw.no_saturday_flights);
  out.wants_two_rooms = bool(raw.wants_two_rooms);
  out.price_objection = bool(raw.price_objection) === true;
  out.out_of_season = bool(raw.out_of_season) === true;

  // A preference is a TAG this server's parser produced, from a closed
  // vocabulary — never free text. An enum is a stronger filter than any
  // pattern, so it is used wherever the vocabulary is actually closed.
  const TAGS = new Set(require('./offline-nlu.js').PREFERENCE_TAGS || []);
  out.preferences = (Array.isArray(raw.preferences) ? raw.preferences : [])
    .filter(p => TAGS.has(p)).slice(0, MAX_LIST);

  // the two remaining free-text slots the customer reads back verbatim
  out.notes_from_customer = list(raw.notes_from_customer, { clean: true });
  out.unverifiable = list(raw.unverifiable, { clean: true });

  out.holiday = str(raw.holiday, { clean: true });
  out.age_boundary = str(raw.age_boundary, { clean: true });
  out.off_commitment_destination = R.destination(raw.off_commitment_destination);
  out.off_commitment_country = COUNTRIES.has(raw.off_commitment_country) ? raw.off_commitment_country : null;

  bookkeeping(raw, out);
  return out;
}

module.exports = { sanitizeIncomingSlots, textIsClean, MAX_TEXT, MAX_LIST };
