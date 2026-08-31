// Pingwin ski-bot server — zero dependencies (Node 18+).
//   node server/server.js
// Serves: /            → public/demo.html
//         /pingwin-bot.js → the widget bundle
//         POST /api/chat  → slot filling (Claude) → deterministic search (code)
//                           → phrasing (Claude) → {reply, cards, chips}
// The Excel never gets here — only data/availability.json (PII-scrubbed).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./env.js');
const { callClaude, parseModelJSON } = require('./claude.js');
const { callOpenAI, spend: openaiSpend, model: openaiModel } = require('./openai.js');
const { SLOT_PROMPT: SLOT_PROMPT_LEAN } = require('./prompt-slots.js');
const offline = require('./offline-nlu.js');
const phrasing = require('./prompt-phrase.js');
const guidance = require('./guidance.js');
const router = require('./answer-router.js');
const chatLog = require('./conversation-log.js');
const { SkiSearch } = require('../data/filter.js');
const incoming = require('./incoming-slots.js');
const health = require('./model-health.js');
const season = require('./season.js');
const labels = require('./labels.js');
const { buildBookingUrl, deepLink, pageFor, addNights } = require('../config/booking-url.js');
const siteRooms = require('./site-rooms.js');
const limits = require('./limits.js');
const leadMail = require('./lead-mail.js');
const crmLead = require('./crm-lead.js');
const recommend = require('./recommend.js');

loadEnv();
const has = k => process.env[k] && !process.env[k].includes('xxxx');
// Provider is chosen by whichever key is present. With none, the bot still
// works fully on the deterministic Hebrew layer — free, no account.
function aiMode() {
  // over the daily budget the bot keeps answering — on the free Hebrew layer
  if (limits.budgetExceeded(openaiSpend.usd)) return 'offline';
  // …and the same when the provider has failed repeatedly. Without this, a
  // degraded provider cost every customer a slow turn until someone noticed,
  // and nobody could notice: /healthz reported the provider as live from the
  // mere presence of a key. The breaker closes itself after a cooldown.
  if (health.open()) return 'offline';
  if (has('OPENAI_API_KEY')) return 'openai';
  if (has('ANTHROPIC_API_KEY')) return 'claude';
  return 'offline';
}
// how many questions the bot may ask before it must show results
const MAX_QUESTIONS = +(process.env.MAX_QUESTIONS || 3);
// Questions that may be skipped when the answer cannot change the result.
// adults and children_ages are NOT here: the party size decides which rooms
// even fit, so it is never merely informative.
const SKIPPABLE = new Set(['month', 'country', 'airport', 'kids_club']);
const PORT = +(process.env.PORT || 8787);
const BOT_VERSION = require('../package.json').version;
const ROOT = path.join(__dirname, '..');
const engine = new SkiSearch();

const EMPTY_SLOTS = {
  adults: null, children_ages: [], no_children: null, month: null,
  flexible_dates: null, country: null, destination: null,
  departure_airport: null, needs_hebrew_kids_club: null, preferences: [],
  excluded_countries: [], excluded_destinations: [], notes_from_customer: [],
  price_objection: false, shown_price_min: null, month_part: null, exact_day: null, hotel: null,
  month_alt: null, holiday: null, age_boundary: null,
  off_commitment_destination: null, off_commitment_country: null, out_of_season: false,
  no_saturday_flights: null, nights_wanted: null, unverifiable: [], wants_two_rooms: null,
  wrong_year: null,
  country_fixed: null,
};

const CHIP_LABELS = ['חשוב לי אפרה-סקי', 'חשוב לי ספא', 'קרוב למסלולים', 'מתאים למתחילים', 'תקציב חסכוני'];
const CHIP_TO_PREF = {
  'חשוב לי אפרה-סקי': 'אפרה-סקי', 'חשוב לי ספא': 'ספא', 'קרוב למסלולים': 'קרוב למסלולים',
  'מתאים למתחילים': 'מתחילים', 'תקציב חסכוני': 'תקציב',
};

// Every fixed sentence the bot says comes from config/guidance.json
// (messages_he), with the wording below as the built-in floor. The office
// phone number lives in exactly one place: handoff_he.phone.
const FALLBACK_HE = () => guidance.msg('fallback',
  'סליחה, משהו השתבש לרגע. אפשר לנסח שוב? לחלופין, נציג זמין בטלפון {phone}.');
// A slow provider is not a badly-phrased question. The fallback above asks the
// customer to rephrase, which was the wrong thing to say when nothing was
// wrong with what they wrote — and there was no retry button either, because
// the turn returned 200.
// An oversized message deserves a sentence, not a dropped connection.
const TOO_LONG_MSG_HE = () => guidance.msg('message_too_long',
  'ההודעה ארוכה מדי בשבילי. אפשר לקצר אותה, או לשלוח אותה בכמה הודעות?');
const SLOW_HE = () => guidance.msg('slow',
  'לוקח לי יותר זמן מהרגיל לענות. אפשר לנסות שוב בעוד רגע, או להתקשר ל-{phone}.');

/* ---------- helpers ---------- */
function requiredMissing(slots) {
  const missing = [];
  if (slots.adults == null) missing.push('adults');
  if ((slots.children_ages || []).length === 0 && slots.no_children !== true) missing.push('children');
  if (slots.month == null) missing.push('month');
  const kidsInRange = (slots.children_ages || []).some(a => SkiSearch.inCampAge(a));
  if (kidsInRange && slots.needs_hebrew_kids_club == null) missing.push('kids_club');
  return missing;
}

// Three offers read faster as a ladder: which is the cheapest, which is the
// premium. Derived only from the symbolic price band, only when the bands
// actually differ — three identical ₪₪₪ cards get no labels rather than
// invented ones. Never "מומלץ": that word belongs to the hotel data.
// A hotel with no classified band takes part in no comparison at all: it gets
// no badge, and it does not set the floor or the ceiling for anyone else's.
// The badge used to be decided from pricing.json's TODO default, so an
// unclassified hotel could be crowned "המשתלם ביותר" on no evidence.
function tierLabel(card, cards) {
  const rank = p => { const n = (String(p || '').match(/₪/g) || []).length; return n || null; };
  const ranked = cards.map(c => rank(c.price_range)).filter(r => r != null);
  const r = rank(card.price_range);
  if (r == null || ranked.length < 2) return null;
  const lo = Math.min(...ranked), hi = Math.max(...ranked);
  if (lo === hi) return null;
  if (r === lo && ranked.filter(x => x === lo).length === 1) return 'המשתלם ביותר';
  if (r === hi && ranked.filter(x => x === hi).length === 1) return 'הפרימיום';
  return null;
}

// the widget's "[הוצגו N הצעות: …]" marker — context for the models, never a reply
function isBookkeeping(content) {
  return /^\s*\[הוצגו \d+ הצעות/.test(String(content || ''));
}

function assistantQuestionCount(messages) {
  return messages.filter(m => m.role === 'assistant' && !isBookkeeping(m.content) &&
    /\?/.test(String(m.content))).length;
}

function toSearchSlots(slots) {
  // "any" is a real answer ("לא משנה") — it means asked-and-answered, so we
  // stop asking, but it must not become a filter
  const any = v => (v === 'any' ? null : v);
  return {
    ...slots,
    month: any(slots.month),
    month_alt: slots.month_alt || null,
    country: any(slots.country),
    departure_airport: any(slots.departure_airport),
    month_part: slots.month_part || null,
    exact_day: slots.exact_day || null,
    hotel: slots.hotel || null,
    price_objection: !!slots.price_objection,
    shown_price_min: slots.shown_price_min || null,
    off_commitment_destination: slots.off_commitment_destination || null,
    off_commitment_country: slots.off_commitment_country || null,
    no_saturday_flights: !!slots.no_saturday_flights,
    nights_wanted: slots.nights_wanted || null,
    out_of_season: !!slots.out_of_season,
    wants_two_rooms: !!slots.wants_two_rooms,
    country_fixed: !!slots.country_fixed,
  };
}

/* ---------- understanding: the model reads every real message ----------
   This used to escalate to the model only when the Hebrew regex layer learned
   nothing, which was cheap and endlessly frustrating: every phrasing a customer
   invented was a new bug to find and patch by hand. Tomer's call, 24/08 — pay
   for understanding on every turn and stop playing whack-a-mole.

   The regex layer still runs first, for three reasons: it is the fallback when
   the API is down, it seeds the model with what we already understood, and it
   still answers trivial turns ("2", "כן", a chip click) without paying at all.

   What the model may NOT do is unchanged: it never sees inventory, so it can
   never invent a hotel, a date or an availability claim. */
function slotsChanged(before, after) {
  const keys = ['adults', 'children_ages', 'children_count', 'no_children', 'month',
    'flexible_dates', 'country', 'destination', 'departure_airport', 'needs_hebrew_kids_club',
    'excluded_countries', 'no_saturday_flights', 'nights_wanted'];
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return true;
  return (after.preferences || []).length !== (before.preferences || []).length;
}
function shouldAskModel(before, after, text) {
  const t = (text || '').trim();
  if (!t) return false;
  // A bare number, "כן"/"לא", or a chip click is answering a question we just
  // asked. The regex layer gets those right every time and a model call would
  // buy nothing — this is the whole remaining token economy.
  if (/^[\d\s,.\-ו]{1,8}$/.test(t)) return false;
  if (/^(כן|לא|בטח|כמובן|אוקיי|אוקי|ok|תודה|יאללה)[!.?]?$/i.test(t)) return false;
  if (CHIP_TO_PREF[t] || t.length <= 2) return false;
  // A short message the free layer already understood in full ("ינואר",
  // "לא בנסקו", "בלי ילדים") has nothing left in it to pay for.
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words <= 3 && slotsChanged(before, after)) return false;
  return true;
}

async function fillSlotsWithModel(messages, prevSlots, questionsAsked, deadline) {
  // only the last few turns are sent — older ones are already folded into slots
  const recent = messages.slice(-4);
  const payload = [
    ...recent,
    { role: 'user', content: `slots: ${JSON.stringify(prevSlots)}\nשאלות שנשאלו: ${questionsAsked}/${MAX_QUESTIONS}\nהחזר JSON.` },
  ];
  // Tomer's instructions go BEFORE the built-in rules, so the hard ones stay
  // the last word in the prompt (see server/guidance.js).
  const system = SLOT_PROMPT_LEAN + guidance.forAsking();
  health.called('slots');
  let raw;
  try {
    raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: payload, maxTokens: 400, deadline })
      : await callClaude({ system, messages: payload, maxTokens: 400, deadline });
  } catch (e) { health.failed('slots', e); throw e; }
  const parsed = parseModelJSON(raw);
  if (parsed) health.ok('slots'); else health.rejected('slots', 'unparseable');
  return parsed;
}

// Which standing answer applies (server/answer-router.js). One small call, and
// only when the free regex layer missed. Cached, because customers ask the
// same twenty questions and a repeat should cost nothing.
const ROUTE_CACHE = new Map();
async function routeToAnswer(text, deadline) {
  if (aiMode() === 'offline') return null;
  const entries = offline.faqEntries();
  if (!entries.length) return null;
  const key = text.trim().slice(0, 200);
  if (ROUTE_CACHE.has(key)) return ROUTE_CACHE.get(key);
  let hit = null, asked = false;
  health.called('router');
  try {
    const system = router.buildPrompt(entries);
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: key }], maxTokens: 600, deadline })
      : await callClaude({ system, messages: [{ role: 'user', content: key }], maxTokens: 600, deadline });
    asked = true;
    hit = router.pick(raw, entries);
    if (hit) health.ok('router'); else health.rejected('router', 'no id matched');
  } catch (e) {
    health.failed('router', e);
    console.error('answer router failed:', e.message);   // never breaks a turn
  }
  // Only what we actually learned is remembered. The cache used to be written
  // on the failure path too, so one transient 429 poisoned that question for
  // the life of the process: the customer who asked it — and everyone who
  // phrased it the same way afterwards — got "I'm mainly here for ski
  // holidays" instead of the approved answer, with nothing to distinguish
  // "we asked and there is no answer" from "we could not ask".
  if (asked) {
    if (ROUTE_CACHE.size > 500) ROUTE_CACHE.clear();
    ROUTE_CACHE.set(key, hit);
  }
  return hit;
}

async function phraseWithModel({ slots, cards, result, fallback, lastReply, answered, deadline, lastUserText }) {
  if (aiMode() === 'offline') return fallback;
  // Nothing to phrase: the turn is a question or a no-match, and the template
  // for those is careful, short and already right. Paying to reword it would
  // buy nothing and risks softening a "no" that must stay clear.
  if (!cards.length) return fallback;
  health.called('phrase');
  try {
    const payload = phrasing.buildPayload({ slots, cards, result, fallback, lastReply, answered });
    const system = phrasing.PHRASE_PROMPT + guidance.forAnswering(cards[0] && cards[0].country);
    // 1200, not 320: on a reasoning model max_completion_tokens covers the
    // thinking too, and a 320 cap produced an empty reply that then failed
    // validation and silently fell back to the template on every turn. The
    // auditor still caught the occasional empty at 900, so there is headroom
    // here — an empty reply costs the same as a full one.
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: payload }], maxTokens: 1200, json: false,
          model: process.env.OPENAI_PHRASE_MODEL || undefined, deadline })
      : await callClaude({ system, messages: [{ role: 'user', content: payload }], maxTokens: 1200, deadline });
    let text = String(raw || '').trim();
    // Whole sentences it already said last turn, dropped. "ההצעות נראות פנויות,
    // ונציג יאשר סופית" is true every time and worth saying once.
    if (lastReply) {
      // Near enough is repetition: "ההצעות נראות פנויות, ונציג יאשר סופית" and
      // "הן נראות פנויות ונציג יאשר סופית את הזמינות" are the same sentence to
      // a reader, and only the second one annoys them.
      const norm = x => x.replace(/[\s.,;:!?"'׳״\-—]+/g, '').trim();
      const shape = x => norm(x).slice(0, 24);
      const before = new Set(String(lastReply).split(/(?<=[.!?])\s+/).map(shape).filter(Boolean));
      const kept = text.split(/(?<=[.!?])\s+/).filter(x => !before.has(shape(x)));
      if (kept.length && kept.join(' ').trim().length > 25) text = kept.join(' ').trim();
    }
    const verdict = phrasing.validate(text, { cards, fallback, payload, userText: lastUserText });
    if (!verdict.ok) {
      // worth seeing in the log: a rejected phrasing is either a prompt bug or
      // a model drifting towards something a customer must never be told.
      // Counted apart from a failure: the provider answered, we declined it.
      health.rejected('phrase', verdict.why);
      console.error('phrasing rejected (%s): %s', verdict.why, text.slice(0, 160));
      return fallback;
    }
    health.ok('phrase');
    return text;
  } catch (e) {
    health.failed('phrase', e);
    console.error('phrasing model failed:', e.message);
    return fallback;
  }
}

// The hotel's name as a customer should read it.
function displayHotel(name) {
  return String(name || '').replace(/\s*\((allotment|Allotment)\)\s*/g, ' ').trim();
}

// How many people are actually travelling. The site sells one apartment as two
// products — "2 ח\"ש וסלון 2-4 אורחים" and "2 ח\"ש וסלון 5 אורחים" — and only
// this number tells them apart.
// How many people are travelling. There is exactly ONE answer to that, and it
// lives in SkiSearch.partyOf. This used to be a second, subtly different
// implementation: it counted only children whose AGES were known, and fell
// back to `slots.children` — a slot nothing in this codebase ever sets. So
// "זוג עם 3 ילדים" was five people to the search and two people here, and this
// is the number handed to siteRooms.idFor as the tie-break between
// "סלון 2-4 אורחים" and "סלון 5 אורחים". The search was right and the booking
// link was prefilled with the wrong room.
function partySize(slots) {
  const n = SkiSearch.partyOf(slots || {});
  return n > 0 ? n : null;
}

// `opts.noTier` drops the "המשתלם ביותר" / "הפרימיום" badge. The badge ranks
// two hotels by price band, which is right when the customer is choosing among
// offers and wrong when they asked us to compare two RESORTS — there it reads
// as a verdict about a hotel nobody asked about (Tomer, 26/08).
function presentCards(result, slots, skip, opts = {}) {
  // top 3 for display; ranked by the deterministic sort, but prefer showing
  // three DIFFERENT hotels before a second room of the same hotel
  // never show the same hotel on the same date twice — with only one hotel
  // in a resort (Borovets) the fill step used to repeat an identical card
  const uniq = [];
  const seenExact = new Set();
  for (const c of result.candidates) {
    // one card per hotel+date: a second room type at the same hotel on the
    // same day looks like a duplicate to the customer, and the rep handles
    // room choice anyway
    const k = `${c.hotel}|${c.date}`;
    if (seenExact.has(k)) continue;
    if (skip && skip.has(k)) continue;        // already shown; "יש עוד?" wants the next ones
    seenExact.add(k); uniq.push(c);
  }
  const seen = new Set(), diverse = [];
  for (const c of uniq) if (!seen.has(c.hotel)) { diverse.push(c); seen.add(c.hotel); }
  for (const c of uniq) if (!diverse.includes(c)) diverse.push(c);
  return diverse.slice(0, 3).map((c, i) => ({
    index: i,
    // "(allotment)" is a word from the commitments workbook meaning we hold
    // rooms there. It is not part of the hotel's name and it went out to
    // customers on the cards and in the model's sentences.
    hotel: displayHotel(c.hotel), resort: c.resort, country: c.country,
    country_he: labels.country(c.country) || c.country,
    date: c.date, date_label: c.date_label, nights: c.nights,
    room: c.room, occ: c.occ_effective, occ_composition_he: c.occ_composition_he,
    desc_he: c.desc_he, lift_he: c.lift_he, tags: c.tags, image: c.image,
    // the whole gallery, so the card can page through the hotel's own photos
    images: (engine.hotelInfo(c.hotel).images || []).slice(0, 12),
    // what THIS package includes, verbatim from the hotel page. It differs
    // hotel by hotel — half board only, breakfast with half board for a
    // supplement, ski pass or not — so a generic sentence would be wrong.
    package_includes_he: engine.hotelInfo(c.hotel).package_includes_he || null,
    // count_available is deliberately NOT here. It is how many rooms Pingwin
    // holds at that hotel on that date — commitments-workbook data, exactly
    // the class of thing the note at the top of this file says never reaches
    // this process. The widget only ever renders the derived sentence below,
    // but the raw number was sitting in the JSON for anyone with a network tab.
    rooms_left_sole: c.count_available === 1,
    // soft, factual urgency: the workbook says how many rooms of this type we
    // still hold. "נשארו 2 חדרים" is true; a countdown timer would not be.
    // only the last room of its type earns the line — a third of the workbook
    // is 2–3 rooms, and a badge on every card is noise, not information
    rooms_left_he: c.count_available === 1 ? 'נשאר חדר אחד מהסוג הזה' : null,
    price_range: c.price_range, recommended: c.recommended,
    camps: c.camps, occ_unverified: c.occ_unverified,
    // Everything the hotel pages taught us about THIS unit. This list used to
    // stop at the line above, so the bot answered "נציג יאמת" about beds, board
    // and spa while the answers sat one object away — the tests missed it
    // because they phrased result.candidates directly and never came through
    // here. tests/test-end-to-end.js now does.
    room_facts: c.room_facts, board_he: c.board_he, transfer_he: c.transfer_he,
    ski_pass_he: c.ski_pass_he, ski_pass_included: c.ski_pass_included,
    equipment_he: c.equipment_he, equipment_included: c.equipment_included,
    wifi_he: c.wifi_he, spa_he: c.spa_he, spa_access: c.spa_access, page_facts: c.page_facts || null,
    spa_access_he: c.spa_access_he, spa_note_he: c.spa_note_he, spa_min_age: c.spa_min_age,
    separate_beds: c.separate_beds, separate_beds_other_he: c.separate_beds_other_he,
    // the hotel's own page — the customer clicked this hotel, not the home page
    // the hotel's own quote form, with the dates, the party and (when we can
    // match it) the room already filled — see config/booking-url.js
    booking_url: deepLink(engine.hotelInfo(c.hotel), {
      date: c.date, nights: c.nights, room: c.room, board_he: c.board_he,
      // the hint is what the workbook knows and the room's name does not
      // always say — the site writes "Premium with View 4-5 pax" where we
      // write "CONN Premium with View 5 pax"
      // the same page the link goes to — Casa Karina answers about a short
      // stay only on its short-stay siteID
      room_id: siteRooms.idFor(pageFor(engine.hotelInfo(c.hotel), c.nights).siteID,
        c.date, addNights(c.date, c.nights), c.room,
        { type: c.room_type, occMin: c.occ_min, occMax: c.occ_max,
          party: partySize(slots), hotel: c.hotel }),
    }, slots),
  })).map((card, i, arr) => ({ ...card, tier_he: opts.noTier ? null : tierLabel(card, arr) }));
}

/* ---------- lead delivery ----------
   A lead nobody saw is a customer lost. LEAD_WEBHOOK_URL (Make/Zapier/Sheets/
   CRM) receives every lead as JSON, signed with LEAD_WEBHOOK_SECRET when set;
   three attempts with backoff, and the JSONL on disk is the record of truth
   either way. Email/WhatsApp delivery plugs in here once Pingwin says where. */
async function notifyLead(record) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return;
  // Flat, versioned, decided in server/crm-lead.js — not our internal record.
  // Whoever maps this into the CRM writes that mapping once; see the file.
  const body = JSON.stringify(crmLead.toCrm(record));
  const headers = { 'content-type': 'application/json', 'x-lead-id': record.id,
    'x-lead-schema': crmLead.SCHEMA };
  if (process.env.LEAD_WEBHOOK_SECRET) {
    headers['x-signature'] = require('crypto').createHmac('sha256', process.env.LEAD_WEBHOOK_SECRET).update(body).digest('hex');
  }
  const delays = [0, 2000, 10000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
      if (r.ok) return;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error('rejected ' + r.status);
    } catch (e) { if (i === delays.length - 1) throw e; }
  }
}

/* A lead the CRM never received (it was down, the token expired, the URL moved)
   used to leave one line on stdout and nothing else — invisible unless someone
   was watching the console at that second. It is written down instead, with the
   reason, and `npm run leads:retry` re-sends everything in the file. The lead
   itself was never at risk: leads.jsonl and the rep's email both already have
   it. What was at risk is it being missing from the CRM and nobody knowing. */
function markUndelivered(record, err) {
  try {
    const dir = path.join(ROOT, 'server-data');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'leads-undelivered.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), error: String(err && err.message || err).slice(0, 200), record }) + '\n');
  } catch (e) { console.error('could not record undelivered lead:', e.message); }
}

/* ---------- "מה התאריכים ב…?" (30/08, after the live run) ----------
   Two of the six live failures were customers asking WHICH DATES we fly, and
   both got "כמה תהיו בסך הכל?" while the answer sat in the workbook. Dates are
   facts, not prices, so we may simply say them — and for a customer with a
   fixed window ("יש לי את הילדים רק מ-22 עד 29 בדצמבר") it is the only thing
   that matters before anything else is worth discussing.

   Deterministic: the dates come from engine.departureDates(), never a model,
   so this can state what exists and — just as usefully — what does not. */
const DATES_Q = /מה ה?תאריכים|אילו תאריכים|איזה תאריכים|מתי ה?יציאות|מתי אתם טסים|מתי יש (?:לכם )?(?:יציאות|טיסות)|יש (?:לכם )?(?:יציאה|טיסה|חבילה) ב|באילו תאריכים|תאריכים יש/;
const HE_DATE = iso => `${+iso.slice(8, 10)}.${+iso.slice(5, 7)}`;
function datesLine(slots, lastUser, engine) {
  if (!DATES_Q.test(lastUser)) return null;
  // an explicit window the customer named: "מ-22 עד 29 בדצמבר"
  let from = null, to = null;
  const win = lastUser.match(/(\d{1,2})\s*(?:עד|[-\u2013])\s*(\d{1,2})\s*ב?(דצמבר|ינואר|פברואר|מרץ)/);
  // built from the season file, so a rollover does not need this line edited
  const MON = {};
  for (const m of season.months()) {
    MON[season.monthHe(m)] = [String(season.yearOf(m)), String(m).padStart(2, '0')];
  }
  if (win && MON[win[3]]) {
    const [y, m] = MON[win[3]];
    const pad = n => String(n).padStart(2, '0');
    from = `${y}-${m}-${pad(win[1])}`; to = `${y}-${m}-${pad(win[2])}`;
  }
  const holiday = slots.holiday && slots.holiday !== 'any' ? slots.holiday : null;
  const month = (!holiday && !from && typeof slots.month === 'number') ? slots.month : null;
  if (!holiday && !from && month == null) return null;      // nothing specific enough to answer
  let dates;
  try { dates = engine.departureDates({ holiday, month, from, to }); }
  catch (e) { return null; }                                // never let this break a turn
  const label = holiday || (from ? `-${+win[1]}\u2013${+win[2]} ב${win[3]}` : ECHO_MONTH_HE[month]);
  if (dates.length) return `היציאות שלנו ב${label}: ${dates.map(HE_DATE).join(', ')}.`;
  // Nothing in the window they named. Saying so, plus what IS near it, is the
  // answer — "כמה תהיו?" is not.
  let near = [];
  try { near = engine.departureDates({ month: from ? +from.slice(5, 7) : month }); }
  catch (e) { near = []; }
  const monthHe = from ? win[3] : (ECHO_MONTH_HE[month] || '');
  if (near.length) return `ב${label} אין לנו יציאה. ב${monthHe} היציאות שלנו: ${near.map(HE_DATE).join(', ')}.`;
  return `ב${label} אין לנו יציאה בתאריכים האלה — נציג יבדוק אם נפתח משהו.`;
}

/* ---------- the Sunny lesson: say what you searched for (30/08) ----------
   Isrotel's "סאני" prints "מחפשת זמינות חדרים בתאריכים 6–9 בדצמבר ב-8 מלונות"
   before every result set — the customer sees their own request understood, in
   the bot's words, before any offer, and it was the most trust-building line
   in that chat. Ours is deterministic: built from slots, never by a model, so
   it can only echo what was actually searched. Shown once per DISTINCT search
   (repeating it over the same offers is noise), as a quiet status line the
   widget renders above the cards. */
const ECHO_MONTH_HE = { 12: 'דצמבר', 1: 'ינואר', 2: 'פברואר', 3: 'מרץ' };
const ECHO_COUNTRY_HE = labels.COUNTRY_HE;
function searchEcho(slots) {
  const bits = [];
  const kids = slots.children_ages || [];
  if (slots.adults != null && kids.length) {
    bits.push(slots.adults + ' מבוגרים + ' +
      (kids.length === 1 ? 'ילד (גיל ' + kids[0] + ')' : kids.length + ' ילדים (גילאי ' + kids.join(', ') + ')'));
  } else if (slots.adults != null) {
    bits.push(slots.adults + ' נוסעים' + (slots.no_children === true ? ' בלי ילדים' : ''));
  } else if (kids.length) {
    bits.push(kids.length + ' ילדים (גילאי ' + kids.join(', ') + ')');
  }
  if (typeof slots.month === 'number') {
    let m = ECHO_MONTH_HE[slots.month] || '';
    if (typeof slots.month_alt === 'number' && ECHO_MONTH_HE[slots.month_alt]) m += ' או ' + ECHO_MONTH_HE[slots.month_alt];
    if (m) bits.push(m);
  } else if (slots.flexible_dates) bits.push('תאריכים גמישים');
  if (slots.nights_wanted) bits.push(slots.nights_wanted + ' לילות');
  if (slots.destination) bits.push(String(slots.destination));
  else if (slots.country && slots.country !== 'any') bits.push(ECHO_COUNTRY_HE[slots.country] || String(slots.country));
  for (const ex of slots.excluded_countries || []) {
    if (ECHO_COUNTRY_HE[ex]) bits.push('בלי ' + ECHO_COUNTRY_HE[ex]);
  }
  if (slots.needs_hebrew_kids_club === true) bits.push('קייטנה בעברית');
  if (slots.no_saturday_flights) bits.push('בלי טיסות בשבת');
  if (slots.departure_airport === 'haifa') bits.push('טיסה מחיפה');
  else if (slots.departure_airport === 'tlv') bits.push('טיסה מנתב"ג');
  for (const p of (slots.preferences || []).slice(0, 3)) bits.push(p);
  // an echo with nothing personal in it teaches nothing — skip it
  if (bits.length < 2) return null;
  return guidance.msg('search_echo_prefix', 'חיפשתי במלאי לפי:') + ' ' + bits.join(' · ');
}

// The retrieval echo for a KNOWLEDGE answer, as distinct from searchEcho()
// above, which echoes the inventory search. Sunny (Isrotel/Abra) prints
// `בודקת עבורך מידע לגבי: "בריכה מחוממת אילת"` before every knowledge answer,
// and on an elliptical follow-up it prints the REWRITTEN query — which is how
// a customer can tell, in one glance, that a three-word question landed on the
// right subject. Ours shows the customer's own matched words plus the place in
// scope; it never invents a topic name.
//
// Not on every answer: a plain "מה כלול?" answered from the patterns needs no
// preamble, and a line above every reply is noise. It earns its place exactly
// where the customer cannot otherwise tell what we understood — a question we
// had to rewrite from context, a question the model routed, or a question
// whose answer depends on which hotel is in scope.
function knowledgeEcho(faqHit, slots, opts) {
  if (!faqHit) return null;
  const o = opts || {};
  if (!o.rewritten && !faqHit.routed && !o.place) return null;
  const terms = [...new Set(((faqHit.all && faqHit.all.length ? faqHit.all : [faqHit])
    .map(a => a && a.matched).filter(Boolean)))].slice(0, 3);
  const bits = [...terms];
  if (o.place) bits.push(o.place);
  if (!bits.length) return null;
  return guidance.msg('knowledge_echo_prefix', 'בודק לגבי:') + ' ' + bits.join(' · ');
}

// A second question that got no answer. Sunny drops these silently — asked it
// about a hotel it does not have AND about parking there (30/08), it corrected
// the hotel and the parking half simply vanished. A customer cannot tell the
// difference between refused, missed, and still coming, so we say which it is.
// Guarded messages are excluded on purpose: a red-rule refusal is deliberate,
// and calling it an unanswered question invites the customer to ask again.
function droppedQuestionLine(lastUser, multiPart, answersGiven, guarded) {
  if (!multiPart || guarded) return null;
  const segs = String(lastUser || '').split(/[?？]/).map(x => x.trim())
    .filter(x => x.split(/\s+/).filter(Boolean).length >= 2);
  if (segs.length < 2 || answersGiven >= 2) return null;
  return guidance.msg('dropped_question',
    'שאלתם עוד דבר ולא עניתי עליו — כתבו לי אותו שוב במשפט אחד ואענה.');
}

/* ---------- chat orchestration ---------- */
async function handleChat(body) {
  const startedAt = Date.now();
  // Pick up a re-exported workbook without a restart. Cheap (five stat calls)
  // and it is the one file where reading a stale copy means telling a customer
  // a sold-out week is available.
  try { engine.reloadIfChanged(); } catch (e) { /* keep serving what we have */ }
  // One turn, one time budget. The three model calls run in sequence, so a
  // fixed ceiling on each of them let two slow calls blow the outer cap
  // between them. They now share what is left of this, minus a margin for
  // assembling and sending the reply.
  const deadline = startedAt + Math.max(2000, CHAT_TIMEOUT_MS - 2500);
  // The transcript is input too: `messages` arriving as a string used to throw
  // `.map is not a function`, which the outer catch turned into the "something
  // went wrong" line — so a malformed body could put every turn into the error
  // path. Anything that is not a list of objects is simply an empty transcript.
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const MAX_MSG = 2000;
  let trimmedLast = false;
  const messages = rawMessages
    .filter(m => m && typeof m === 'object' && !Array.isArray(m))
    .slice(-20)
    .map((m, i, arr) => {
      const full = typeof m.content === 'string' ? m.content : '';
      // Silently dropping half of what someone wrote is worse than the length
      // limit itself: a 4,000-character requirements message was accepted, cut
      // at 2,000, and answered as though the rest had never been typed.
      if (i === arr.length - 1 && m.role !== 'assistant' && full.length > MAX_MSG) trimmedLast = true;
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: full.slice(0, MAX_MSG),
      };
    });
  // Conversation state arrives from the browser, and the browser is not a
  // trusted narrator — several of these slots are printed to the customer
  // verbatim. See server/incoming-slots.js for what that allowed (30/08).
  const prevSlots = incoming.sanitizeIncomingSlots(body.slots, engine, EMPTY_SLOTS);
  const questionsAsked = assistantQuestionCount(messages);

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const lastUser = lastUserMsg ? lastUserMsg.content : '';

  // ---- step 1: deterministic Hebrew parse — always runs, always free ----
  let slots = offline.parseText(lastUser, prevSlots);
  // One conversation id, minted on the first turn and carried by every reply —
  // including the early returns (greeting, farewell, guard, language). It is
  // what ties a lead to the chat that produced it, and it used to be handed
  // back only when Turnstile was on, so most leads had no chat at all.
  if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
  let replyIfNotReady = null;
  let modelUsed = false;

  // ---- step 1a: not Hebrew? one sentence in their language, and the form ----
  const lang = offline.foreignLanguage(lastUser);
  // transliterated Hebrew always gets the invitation (what it parsed is kept);
  // a real foreign sentence that the English floor already understood
  // ("family of 4 in february") goes on to the search instead
  if (lang && (lang === 'translit' || !slotsChanged(prevSlots, slots)) && !offline.guard(lastUser)) {
    const line = guidance.languageText(lang);
    if (line) {
      if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
      chatLog.logTurn({ conversationId: body.conversationId || slots._cid, userText: lastUser, reply: line,
        cards: [], result: { notes: [], relaxed: [] }, slots, modelUsed: false, ms: Date.now() - startedAt,
        notUnderstood: false, answeredBy: 'lang:' + lang });
      return {
        open_lead_form: lang !== 'translit', lead_kind: lang !== 'translit' ? 'language_' + lang : null, lead_prefill: null,
        reply_he: line, model_used: false, pending_parameter: lang === 'translit' ? 'adults' : null,
        slots, cards: [], two_room_splits: [], notes: [], relaxed: [],
        chips: lang === 'translit' ? ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'] : [], chip_to_pref: CHIP_TO_PREF,
        ...(process.env.BANK_DEBUG ? { debug: { answered_by: 'lang', lang, faq_ids: [], guard: null, off_topic: false, not_understood: false, pending: null } } : {}),
      };
    }
  }

  // ---- step 1b: is this even a customer looking for a holiday? ----
  // A travel agent, a company, a school, a journalist, someone who already
  // booked, someone who pasted a phone number — one sentence and the form,
  // tagged with who they are, instead of "כמה תהיו?".
  const leadIntent = !offline.guard(lastUser) && offline.leadIntent(lastUser);
  if (leadIntent) {
    // a phone number typed after "אני סוכן" is still the agent's lead
    slots._lead_kind = (leadIntent.kind === 'phone_only' && prevSlots._lead_kind) ? prevSlots._lead_kind : leadIntent.kind;
    if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
    chatLog.logTurn({
      conversationId: body.conversationId || slots._cid, userText: lastUser, reply: leadIntent.he,
      cards: [], result: { notes: [], relaxed: [] }, slots, modelUsed: false, ms: Date.now() - startedAt,
      notUnderstood: false, answeredBy: 'lead:' + leadIntent.kind,
    });
    return {
      open_lead_form: leadIntent.kind !== 'job' && leadIntent.kind !== 'partnership',
      lead_kind: leadIntent.kind, lead_prefill: leadIntent.prefill || null,
      reply_he: leadIntent.he, model_used: false, pending_parameter: null,
      slots, cards: [], two_room_splits: [], notes: [], relaxed: [], chips: [], chip_to_pref: CHIP_TO_PREF,
      ...(process.env.BANK_DEBUG ? { debug: { answered_by: 'lead', lead_kind: leadIntent.kind, faq_ids: [], guard: null, off_topic: false, not_understood: false, pending: null } } : {}),
    };
  }

  // ---- step 2: escalate to the model ONLY if step 1 learned nothing ----
  if (aiMode() !== 'offline' && shouldAskModel(prevSlots, slots, lastUser)) {
    try {
      const parsed = await fillSlotsWithModel(messages, prevSlots, questionsAsked, deadline);
      if (parsed && parsed.slots) {
        // union the preference lists rather than letting the model's replace
        // the regex layer's: "סאונה וג'קוזי" was read as ספא locally, and a
        // model reply that omitted it was silently dropping the request
        // Only what the model actually FOUND may override the regex layer. It
        // returns null for anything it did not see, and a spread let those
        // nulls erase real answers — "בבנסקו" became no destination at all,
        // and the customer was shown France.
        const found = Object.fromEntries(Object.entries(parsed.slots)
          .filter(([, v]) => v !== null && v !== undefined &&
            !(Array.isArray(v) && v.length === 0)));
        // and a resort name it wrote in Hebrew is mapped to the one the
        // inventory uses, or dropped — never searched for as written
        // 'any' is the model's way of saying "flexible" — it must not erase
        // a concrete month the regex layer already parsed ("דצמבר או ינואר"
        // became "any או ינואר" in front of a customer)
        if (found.month === 'any' && typeof slots.month === 'number') delete found.month;
        // "טסנו איתכם לפני שנתיים" is two years AGO, not a two-year-old.
        // Children arriving only from the model, in a message with no child
        // word in it, are an invention.
        if (found.children_ages && !(slots.children_ages || []).length &&
            !/ילד|בן |בת |בני |בנות |תינוק|נכד|קטנ/.test(lastUser)) {
          delete found.children_ages;
        }
        if (found.destination) {
          found.destination = offline.canonicalDestination(found.destination) ||
            slots.destination || null;
          if (!found.destination) delete found.destination;
        }
        const merged = { ...slots, ...found };
        merged.preferences = [...new Set([
          ...(slots.preferences || []), ...(parsed.slots.preferences || []),
        ])];
        // Things the customer said that no slot can hold — "אשתי בהריון",
        // "הגדול על סנובורד", "חוגגים יום נישואין". They used to fall on the
        // floor: not filtered on, not answered, not mentioned, which is what
        // makes a bot feel like it did not listen. They accumulate, and the
        // phrasing layer is required to acknowledge them.
        // The model narrates in the third person ("המשפחה טסה איתנו...",
        // "הלקוח מבקש...") and we read those notes back to the customer
        // verbatim — inventing a "משפחה" nobody mentioned. And a wish we
        // already filter on (Sabbath) is not a note for a rep.
        merged.notes_from_customer = [...new Set([
          ...(slots.notes_from_customer || []),
          ...(parsed.slots.notes_from_customer || []),
        ])]
          .filter(n => !/^ ?(הלקוח|הלקוחה|המשפחה|הזוג|הם |הוא |היא |הנוסע)/.test(n))
          // "חשוב להם", "מבקשים ש...", "מעוניינים ב..." — the model narrating
          // the customer in the third person, read back to their face
          .filter(n => !/חשוב להם|מבקשים|מעוניינים|רוצים ש|מחפשים ש/.test(n))
          // a request for other customers' details is refused by the guard —
          // it must never resurface as a note promising a rep will "check"
          .filter(n => !/פרטי קשר|טלפונים של|שמות של|נוסעים אחרים|לקוחות אחרים/.test(n))
          .filter(n => !(/שבת/.test(n) && merged.no_saturday_flights))
          .slice(0, 6);
        slots = merged;
        modelUsed = true;
        // The model's own question goes to the customer, so it is validated
        // like everything else the model writes. It used to go straight into
        // the reply — the one model channel with no check on it at all, on a
        // model whose prompt names our resorts and season dates. When it does
        // not pass, the deterministic ladder asks instead, which is never
        // wrong, only plainer.
        if (!parsed.ready_to_search && parsed.reply_he) {
          const q = phrasing.validateQuestion(parsed.reply_he);
          if (q.ok) replyIfNotReady = parsed.reply_he;
          else console.error('slot question rejected (' + q.why + '):', String(parsed.reply_he).slice(0, 120));
        }
      }
    } catch (e) {
      // model unreachable → carry on with what the free layer understood
      console.error('slot model failed:', e.message, e.detail || '');
    }
  }

  // ---- off-topic: acknowledge, then steer back (red rule 9) ----
  // Answering "what's the weather in Tel Aviv?" with "how many adults?" is a
  // non-sequitur; one line of acknowledgement makes it a conversation.
  // A question we have a real answer for is NOT off topic — "כמה לילות זה?"
  // was getting the "I only do ski holidays" line, which is absurd. Anything
  // deflect() recognises is on topic by definition, and the vocabulary below
  // covers the rest of the domain.
  // A standing answer exists for most of what customers actually ask
  // (config/faq.json). It is on topic by definition, so it also switches the
  // off-topic line off — telling someone that cancellation terms are "not my
  // subject" was the most expensive sentence this bot could say.
  // faqMulti: each question segment matched on its own, so a message that
  // asks two known things gets both answers with no model involved
  let faqHit = offline.faqMulti(lastUser);
  // A SHORT follow-up carries its subject in the previous turn, not in itself.
  // "מה כלול בחבילה?" … "גם לילדים?" — the second message has no topic a
  // pattern can find, and the bot answered "לא בטוח שהבנתי" to a question a
  // human would have understood instantly. Measured 30/08: 89 of the 162
  // question-bank failures are messages of four words or fewer.
  //
  // So when a short question matches nothing, look it up again with the
  // previous user message in front of it. The bank cannot show this working —
  // it sends every question as a first message, with no previous turn — but it
  // is what a real conversation is made of. Repetition is already handled:
  // server.js drops an FAQ paragraph that was the answer last turn too.
  //
  // Two things make a message elliptical, and the opener list only caught one
  // of them. Sunny (Isrotel/Abra, observed 30/08) rewrites "וגם לילדים?" into
  // the standalone query "בריכה מחוממת ילדים ים סוף אילת רויאל ביץ' אילת" —
  // the previous topic PLUS the places IT had just named — and shows that
  // rewritten query to the customer before answering. Two lessons: the test
  // for "has no subject of its own" is about the words present, not the word
  // it opens with; and the entities the BOT named are part of the context, not
  // only what the customer wrote.
  //
  // So: a short message is elliptical when every one of its words is a
  // function word or a qualifier — nothing in it refers to a subject. That is
  // strictly broader than the old opener list ("ומתי זה?" was missed) and it
  // keeps the guard that mattered: "יש חדר משפחתי?" after "יש ספא?" contains
  // the content word "חדר", so it is a NEW subject and goes to the router
  // rather than being answered about the spa.
  // (\b is useless here: Hebrew letters are not \w in JS, so a word boundary
  // never matches after them — the same trap as the "ביט" pattern above.)
  const shortFollowUp = offline.isElliptical(lastUser);
  const prevUser = [...messages].reverse().filter(m => m.role === 'user')[1];
  const withContext = (shortFollowUp && prevUser)
    ? (prevUser.content + ' ' + lastUser).slice(-300) : null;
  // The entities the bot itself named last turn. Without them "וגם לילדים?"
  // is looked up with no hotel in it, and the answer is about the wrong place.
  const prevBot = [...messages].reverse().find(m => m.role === 'assistant');
  const botEntities = (() => {
    if (!shortFollowUp || !prevBot) return '';
    const names = offline.hotelsNamed(prevBot.content) || [];
    const dest = offline.canonicalDestination(prevBot.content) || '';
    return [...new Set([...names, dest].filter(Boolean))].join(' ');
  })();
  // Entities are kept OUT of the pattern lookup (a hotel name in the string
  // can only make a regex match worse) and handed to the router, which is the
  // layer that needs to know which hotel the question is about.
  const withEntities = withContext
    ? [withContext, botEntities].filter(Boolean).join(' ').slice(-360) : null;
  // A card topic asked elliptically never reached parseText, so
  // slots.unverifiable stayed empty and the cards below did not answer it.
  // Re-parse the rewritten text into a throwaway copy and lift ONLY the card
  // topics out of it, so no slot is filled twice from the same sentence.
  if (withContext) {
    try {
      const echoSlots = offline.parseText(withContext, JSON.parse(JSON.stringify(prevSlots)));
      const extra = (echoSlots.unverifiable || [])
        .filter(t => !(slots.unverifiable || []).includes(t));
      if (extra.length) slots.unverifiable = [...(slots.unverifiable || []), ...extra];
    } catch (e) { /* context is a bonus; never let it break the turn */ }
  }
  if (!faqHit && withContext) faqHit = offline.faqMulti(withContext);
  // The regex found nothing. That is usually not "we have no answer" — it is
  // "the customer said it differently", which was the single largest source of
  // defects in this project. The model picks WHICH approved answer applies; it
  // never writes one, and its whole output is an id from a closed list.
  // Only for something that looks like a question. "ינואר", "כן", "4" and
  // "חשוב לי ספא" are answers to us, not questions to route — paying to route
  // them would be the token policy thrown away for nothing.
  const looksLikeQuestion = /[?]/.test(lastUser) ||
    /^\s*(מה|מי|מתי|איפה|איך|כמה|האם|יש |אפשר|צריך|למה|אם )/.test(lastUser) ||
    (!slotsChanged(prevSlots, slots) && lastUser.trim().length > 8) ||
    // A requirement stated inside a long request is a question too: "רוצים
    // העברות פרטיות ומלון על המסלול" has an answer waiting for it, and it was
    // going unanswered because the same sentence also filled slots.
    lastUser.trim().length > 60;
  if (!faqHit && looksLikeQuestion && !offline.guard(lastUser) && !offline.deflect(lastUser)) {
    // the model router gets the same context, for the same reason — asked to
    // route "עד מתי?" on its own it has nothing to route
    faqHit = await routeToAnswer(withEntities || withContext || lastUser, deadline);
  }
  // "יש חניה במלון? ומה עם ביטוח?" — the regex caught the insurance and the
  // parking question fell on the floor. When the message plainly asks more
  // than one thing, the router runs anyway and the second answer rides along.
  const multiPart = (lastUser.match(/\?/g) || []).length >= 2 ||
    /ומה (עם|לגבי|בקשר)|וגם מה|ושאלה נוספת|ועוד שאלה/.test(lastUser);
  if (faqHit && !faqHit.routed && multiPart && (faqHit.all || []).length < 2 &&
      !offline.guard(lastUser)) {
    const routed = await routeToAnswer(lastUser, deadline);
    const extra = routed && (routed.all || []).find(a => a.id !== faqHit.id);
    if (extra) faqHit = { ...faqHit, he: faqHit.he + String.fromCharCode(10) + extra.he };
  }
  // "מה יותר משתלם מבחינת קרבה למסלולים?" is a request to SORT and explain,
  // not a request for the definition of slope distance. The FAQ that happens
  // to mention the topic steps aside; the offers answer.
  const VALUE_Q = /מה יותר משתלם|מה הכי משתלם|מה עדיף מבחינת|מה כדאי יותר|איפה יוצא הכי|משתלם בסוף|מה משתלם|איזה.{0,15}משתלם/;
  const FACTUAL = new Set(['cancellation', 'deposit', 'installments', 'insurance',
    'my_booking', 'complaint', 'passport', 'visa', 'whats_included', 'camp_price']);
  if (faqHit && VALUE_Q.test(lastUser) && !FACTUAL.has(faqHit.id)) faqHit = null;

  // A customer already comparing two named destinations sees them side by
  // side; printing the four-country lecture on top ("מתפזרת ליעדים שלא
  // הוזכרו") answers a question they did not ask.
  if (faqHit && faqHit.id === 'compare_countries' && (slots.compare || []).length) {
    faqHit = null;
  }
  // Reasoned recommendation (q25): "איזה אתר מתאים למשפחה?", "טיניי או ואל
  // טורנס?", "איפה יש קרחון?" — answered from the approved resort table with
  // the facts as reasons. It outranks the generic compare/country lecture.
  let recAnswer = null;
  if (!offline.guard(lastUser)) {
    recAnswer = recommend.answer(lastUser, slots);
    if (recAnswer) faqHit = { id: 'recommend', he: recAnswer.he, chips: recAnswer.chips,
      all: [{ id: 'recommend', he: recAnswer.he }] };
  }

  // What we looked up, above the answer we found. Computed here rather than
  // beside the preamble because the pure-policy early return below never
  // reaches the preamble, and that is exactly the turn a rewritten question
  // lands on ("ומה עם זה?" from someone who has told us nothing yet).
  const echoPlace = slots.hotel ||
    (slots.destination ? String(slots.destination) : null) ||
    (botEntities ? botEntities.split(' ').slice(0, 2).join(' ') : null);
  const echoFor = (hit) => {
    const line = knowledgeEcho(hit, slots, { rewritten: !!withContext, place: echoPlace });
    if (!line || line === prevSlots._know_said) return null;
    slots._know_said = line;
    return line;
  };

  // A pure policy question from someone who has told us nothing — cancellation
  // terms, deposits, insurance — used to be answered correctly and then buried
  // under three arbitrary hotels and "כמה נוסעים תהיו?". The judge called the
  // pivot confusing, and it is: answer the question, invite the search, stop.
  const nothingKnownYet = slots.adults == null && !(slots.children_ages || []).length &&
    slots.month == null && slots.country == null && slots.destination == null &&
    !slots.children_count;
  const PER_CARD_IDS = new Set(['spa', 'wifi', 'help_me']);
  // "על אילו שני אתרים להשוות?" is a question back to the customer. Three
  // hotels underneath it answer something nobody asked — which is how a
  // request to compare two resorts came back as one hotel with a price badge.
  if (recAnswer && recAnswer.ask_only) {
    slots._lastQuestion = 'compare_which';
    chatLog.logTurn({
      conversationId: body.conversationId || slots._cid || (slots._cid = 'c' + Math.random().toString(36).slice(2, 10)),
      userText: lastUser, reply: recAnswer.he, cards: [], result: { notes: [], relaxed: [] },
      slots, modelUsed, ms: Date.now() - startedAt, notUnderstood: false, answeredBy: 'recommend',
    });
    return {
      open_lead_form: false, reply_he: recAnswer.he, model_used: false,
      pending_parameter: null, slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [], chips: recAnswer.chips || [], chip_to_pref: CHIP_TO_PREF,
      ...(process.env.BANK_DEBUG ? { debug: { answered_by: 'recommend', faq_ids: ['recommend'],
        guard: null, off_topic: false, not_understood: false, pending: 'compare_which' } } : {}),
    };
  }
  if (faqHit && nothingKnownYet && !slotsChanged(prevSlots, slots) &&
      !PER_CARD_IDS.has(faqHit.id) && !offline.guard(lastUser)) {
    slots._lastQuestion = 'adults';
    // requirements stated in the same breath ("או לפחות מטבחון") ride along —
    // the early return must not swallow them
    const newNotes = [
      ...(slots.notes_from_customer || [])
        .filter(n => !(prevSlots.notes_from_customer || []).includes(n)),
      ...(slots.preferences || [])
        .filter(pf => !(prevSlots.preferences || []).includes(pf)),
    ];
    // an emotional turn — a complaint, a booking worry — gets its human word
    // first and no cheery invite after; and no promise of "באמת פנוי"
    const EMOTIONAL = new Set(['complaint', 'my_booking', 'special_needs']);
    const quietSocial = offline.socialLine(lastUser);
    const socialPrefix = quietSocial && !/מצטער/.test(faqHit.he)
      ? quietSocial + String.fromCharCode(10) : '';
    const echoHe = echoFor(faqHit);
    const droppedHe = droppedQuestionLine(lastUser, multiPart,
      Math.max(1, (faqHit.all || []).length), false);
    const replyText = socialPrefix + (echoHe ? echoHe + String.fromCharCode(10) : '') + faqHit.he +
      (droppedHe ? String.fromCharCode(10) + droppedHe : '') +
      (newNotes.length ? String.fromCharCode(10) + 'רשמתי גם: ' + newNotes.join(', ') +
        (EMOTIONAL.has(faqHit.id) ? ' — אעביר לנציג שיטפל בזה.' : ' — אתחשב בזה בהצעות, ומה שדורש בדיקה נציג יבדוק.') : '') +
      (EMOTIONAL.has(faqHit.id) ? '' : String.fromCharCode(10) +
        'וכשתרצו לבדוק תאריכים — כתבו לי כמה אתם ומתי בערך, ואציג את האפשרויות הפתוחות (נציג מאשר סופית).');
    chatLog.logTurn({
      conversationId: body.conversationId || slots._cid || (slots._cid = 'c' + Math.random().toString(36).slice(2, 10)),
      userText: lastUser, reply: replyText, cards: [], result: { notes: [], relaxed: [] },
      slots, modelUsed, ms: Date.now() - startedAt,
      notUnderstood: false, answeredBy: faqHit.routed ? 'router' : 'faq',
    });
    return {
      open_lead_form: offline.wantsCallback(lastUser),
      reply_he: replyText, model_used: modelUsed,
      pending_parameter: 'adults', slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [],
      chips: (faqHit.chips && faqHit.chips.length) ? faqHit.chips : ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'],
      chip_to_pref: CHIP_TO_PREF,
      ...(process.env.BANK_DEBUG ? { debug: {
        answered_by: faqHit.routed ? 'router' : 'faq', faq_ids: (faqHit.all || [faqHit]).map(a => a.id),
        guard: null, off_topic: false, not_understood: false, pending: 'adults', early_return: true,
      } } : {}),
    };
  }

  // A question the CARDS will answer is on topic by definition. "מקררון?" put
  // "מקרר בחדר" in the topic list and the card answered it — while the reply
  // above still said "אני כאן בעיקר להתאמת חופשות סקי" (30/08 live run). Same
  // principle as the per-card FAQ suppression: when the offer knows, the bot
  // does not disown the question.
  const cardTopicAsked = (slots.unverifiable || []).length >
    (prevSlots.unverifiable || []).length;
  const offTopic = lastUser && !slotsChanged(prevSlots, slots) && !modelUsed &&
    !faqHit && !cardTopicAsked && !offline.deflect(lastUser) && !offline.wantsMore(lastUser) &&
    /\?|איך|מה |למה|מי /.test(lastUser) &&
    !/סקי|חופש|מלון|טיסה|קייטנ|יעד|תאריך|חודש|ילד|נוסע|מחיר|חדר|שלג|פינגווין|לילות|כלול|הבדל|להזמין|הזמנה|ביקשתי|מסלול|ספא|גלישה|מדריך|העבר|יעדים|אופצי|המלצ/.test(lastUser);

  // ---- step 3: what to ask next (same logic whichever layer filled slots) ----
  // Only BLOCKING gaps hold results back. The rest (departure airport,
  // destination) are gathered after the customer has seen something concrete —
  // being interviewed before any offer is what makes a bot feel like a form.
  let pendingQuestion = null;
  if (!replyIfNotReady) {
    // A question we are deliberately putting again is not a retry — the
    // customer did not fail to answer, we simply had no reason to ask before.
    // Passing the previous key would greet them with "סליחה, לא הצלחתי להבין".
    const reAsking = !(prevSlots.children_ages || []).length &&
      (slots.children_ages || []).length > 0 && slots.adults == null;
    let q = offline.nextQuestion(slots, reAsking ? null : (prevSlots._lastQuestion || null));
    // A question whose every answer leads to the same offers is not a question.
    // Skip it and take the next one, rather than spending the customer's turn.
    const asked = new Set();
    while (q && !asked.has(q.key) && SKIPPABLE.has(q.key)) {
      asked.add(q.key);
      let value = 2;
      try { value = engine.questionValue(q.key, toSearchSlots(slots)); }
      catch (e) { value = 2; }                       // never let this block a turn
      if (value > 1) break;
      // record the non-answer so nextQuestion moves on, and try the next gap
      if (q.key === 'month') slots.month = slots.month || 'any';
      if (q.key === 'country') slots.country = slots.country || 'any';
      if (q.key === 'airport') slots.departure_airport = slots.departure_airport || 'any';
      // questionValue returns 1 for kids_club precisely when NO week in scope
      // runs this child's group. Skipping is right — the answer cannot change
      // the offer set — but the old code also wrote `false` into the slot and
      // then said nothing, so a family with a five-year-old was never told the
      // club does not run on any of these dates. The slot still records the
      // skip (nothing downstream changes); the family gets told.
      if (q.key === 'kids_club') {
        slots.needs_hebrew_kids_club = slots.needs_hebrew_kids_club ?? false;
        if ((slots.children_ages || []).some(a => SkiSearch.inCampAge(a))) {
          slots._camp_unavailable = true;
        }
      }
      q = offline.nextQuestion(slots, null);
    }
    if (q && q.blocking) {
      slots._lastQuestion = q.key;
      // The LAST blocking gap is worth naming as such. Sunny (30/08): "חסר לי
      // פרט אחד: כמה מבוגרים יהיו בחדר?" followed by what it will do once it
      // has it. A customer who knows they are one answer from seeing offers
      // answers it; one who thinks the questions never end closes the tab.
      // Not on a retry — "סליחה, לא הצלחתי להבין" is already its own frame,
      // and stacking "חסר לי פרט אחד" on top of it reads as nagging.
      const lastGap = offline.blockingGaps(slots).length === 1 &&
        q.key !== (prevSlots._lastQuestion || null);
      replyIfNotReady = lastGap
        ? [guidance.msg('one_detail_left', 'חסר לי פרט אחד:'), q.he,
           guidance.msg('one_detail_then', 'ואז אביא לכם אפשרויות פנויות.')]
            .filter(Boolean).join(' ')
        : q.he;
    }
    else { pendingQuestion = q; delete slots._lastQuestion; }
  }

  const OFF_TOPIC_HE = guidance.msg('off_topic',
    'אני כאן בעיקר להתאמת חופשות סקי של פינגווין. לשאלות אחרות נציג ישמח לעזור ב-{phone}.');
  const SEASON_HE = guidance.msg('out_of_season',
    'עונת הסקי שלנו היא דצמבר עד סוף מרץ — בחודשים אחרים אין לנו יציאות.');
  // a direct answer to a direct question (exact price, other customers'
  // bookings) — showing offers again instead would read as evasion
  // A briefing is not a question. "…- סקי פס - השכרת ציוד…" inside a long
  // requirements list used to trigger the "what's included" explainer and
  // push the actual answer down; those items are covered by the
  // unverifiable line instead.
  // The FAQ is checked first: it holds the topic-specific answer, so "כמה עולה
  // שיעור סקי?" gets the lesson answer rather than the generic price line.
  // No FAQ pattern can match a red-rule question (customer names, exact
  // prices, flight times) — tests/test-faq.js pins that.
  // The red-rule guard runs unconditionally — not gated on the FAQ, not gated
  // on whether the message also filled a slot.
  let guarded = offline.guard(lastUser) ||
    offline.unknownHotel(lastUser) || offline.catalogueHotelLine(lastUser) || offline.unknownResort(lastUser);
  // the same refusal twice running is right to repeat — and reads better as a
  // person repeating themselves on purpose
  if (guarded && guarded === prevSlots._lastGuard) guarded = 'כאמור — ' + guarded;
  const deflection = guarded || (faqHit ? null
    : (slotsChanged(prevSlots, slots) ? null : offline.deflect(lastUser)));
  // deflect() guards the red rules (no customer names, no exact prices) so it
  // wins; the FAQ answer follows only when there is nothing to guard against.
  // Unlike deflect(), the FAQ answers even when the same message also filled
  // slots — "2 מבוגרים בפברואר, יש אוכל כשר?" deserves an answer and offers.
  // Topics the CARDS answer per hotel. Printing the general FAQ paragraph
  // above three cards that each state their own spa terms is noise, and worse,
  // it reads as a hedge right before the specific answer.
  // `hotel_facility_unknown` joined the list on 30/08: it is the generic "we
  // cannot know what every hotel has" paragraph, and since the hotel-page facts
  // landed, the cards below it often DO know. Printing it above them made the
  // bot contradict its own offer ("יש חדר כושר?" → "נציג יאמת" over a card
  // reading "חדר כושר: חדר כושר").
  const PER_CARD_FAQ = new Set(['spa', 'wifi', 'hotel_facility_unknown']);
  // "אחי מה יש לכם לפברואר לזוג?" matches the help entry and also states
  // the party and the month. Asking them again for both is not listening.
  const faqSuppressed = (faqHit && PER_CARD_FAQ.has(faqHit.id)) ||
    (faqHit && faqHit.id === 'help_me' && slotsChanged(prevSlots, slots));
  // Suppressed is not the same as unanswered: without a word the customer is
  // left wondering whether the question landed. One line points at the place
  // the per-hotel answer actually is.
  // A per-hotel question asked BEFORE any offer is on screen has no card to
  // answer it, and fell through to "לא בטוח שהבנתי" — for a question the bot
  // understood perfectly ("מקררון?" on an empty chat, 30/08 live run). Say
  // where the answer lives, then carry on gathering.
  const CARD_TOPIC_POINTER = 'זה משתנה ממלון למלון, ומה שחל על כל אחד כתוב על ההצעה שלו — ברגע שאציג הצעות תראו את זה על כל אחת.';

  const PER_CARD_POINTER = {
    spa: 'תנאי הספא שונים בין המלונות — מה שחל על כל אחד מהם כתוב על ההצעה שלו.',
    wifi: 'תנאי האינטרנט שונים בין המלונות — מה שחל על כל אחד מהם כתוב על ההצעה שלו.',
    hotel_facility_unknown: 'המתקנים שונים בין המלונות — מה שכתוב בדף של כל מלון מופיע על ההצעה שלו.',
  };
  // the human word before business: a returning customer, a compliment.
  // Correct offers with no acknowledgement read as a machine that did not
  // hear the nice thing that was just said to it. But one apology is enough —
  // when the complaint answer opens with its own, the social line yields.
  let social = offline.socialLine(lastUser);
  if (social && faqHit && /מצטער/.test(social) && /מצטער/.test(faqHit.he)) social = null;
  // "בת 3 ו-10 חודשים" — say how the age is reckoned, once
  const ageLine = slots.age_boundary != null && prevSlots.age_boundary == null ? guidance.languageText('age_boundary') : null;
  // "מה התאריכים בחנוכה?" — a fact we hold, said before anything else. It goes
  // in the preamble so it survives the offers gate: a customer asking which
  // dates exist gets the dates even on a turn where we are still asking who
  // they are.
  let dateFacts = null;
  try { dateFacts = datesLine(slots, lastUser, engine); } catch (e) { dateFacts = null; }
  if (dateFacts && dateFacts === prevSlots._dates_said) dateFacts = null;   // said once
  if (dateFacts) slots._dates_said = dateFacts;

  const knowEcho = (!deflection && faqHit && !faqSuppressed) ? echoFor(faqHit) : null;

  let preamble = [
    trimmedLast ? guidance.msg('message_trimmed',
      'ההודעה הייתה ארוכה, אז קראתי את החלק הראשון שלה. אם פספסתי משהו — כתבו לי אותו שוב בקצרה.') : null,
    social,
    ageLine,
    dateFacts,
    deflection,
    knowEcho,
    !deflection && faqHit && !faqSuppressed ? faqHit.he : null,
    !deflection && faqSuppressed ? PER_CARD_POINTER[faqHit.id] : null,
    offTopic && !deflection ? OFF_TOPIC_HE : null,
    slots.out_of_season ? SEASON_HE : null,
  ].filter(Boolean).join('\n');

  // ALWAYS search. The question, if there is one, rides along after the offers
  // rather than standing in front of them. A customer is never held at the
  // door waiting to supply a number (Tomer, 24/08: "שלא יהיה חייב להשיג פרטים
  // ויתקע"), and the same question is never asked twice.
  const askedBefore = new Set(prevSlots._asked || []);
  const closedBefore = !!prevSlots._closed;
  // Asked once, not asked blindly. The party size question was put before we
  // knew anything; once the children turn up it is a different question, and
  // worth putting again — a family answered every other question and finished
  // the conversation with the room size never established.
  const kidsJustKnown = !(prevSlots.children_ages || []).length &&
    (slots.children_ages || []).length > 0;
  if (kidsJustKnown && slots.adults == null) askedBefore.delete('adults');
  // Only the gaps that genuinely change which rooms fit are worth a sentence.
  // The rest — airport, destination — stay as one-tap chips: a customer looking
  // at three real offers should not also be interviewed.
  // The question may come from the offline ladder (which names its key) or
  // from the model itself. Either way it rides along; a model question with no
  // key used to be discarded silently, so the turn asked nothing at all.
  const pendingKey = slots._lastQuestion || (replyIfNotReady ? 'model:' + replyIfNotReady.slice(0, 24) : null);
  let tailQuestion = null;
  if (pendingKey && replyIfNotReady && !askedBefore.has(pendingKey)) {
    tailQuestion = replyIfNotReady;
    askedBefore.add(pendingKey);
  }
  slots._asked = [...askedBefore];
  delete slots._lastQuestion;
  if (tailQuestion) slots._lastQuestion = pendingKey;

  // ---- deterministic search (no AI, ever) ----
  // "היי" on its own, before the customer has told us anything. Answering it
  // with three hotels in three countries is a machine emptying its stock.
  const nothingKnown = slots.adults == null && !(slots.children_ages || []).length &&
    slots.month == null && slots.country == null && slots.destination == null;
  if (offline.isPause(lastUser)) {
    // "אחשוב על זה" is the moment to offer the form — once. The research
    // (delayed capture, after value) says this beats asking up front.
    const nudge = !prevSlots._nudged && (prevSlots._shown || []).length > 0;
    if (nudge) slots._nudged = true;
    return {
      open_lead_form: nudge, reply_he: offline.PAUSE_HE, model_used: false,
      pending_parameter: null, slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [], chips: [], chip_to_pref: CHIP_TO_PREF,
    };
  }
  if (offline.isFarewell(lastUser)) {
    return {
      open_lead_form: false, reply_he: offline.FAREWELL_HE, model_used: false,
      // the one moment Pingi is worth more than 24 pixels: he waves goodbye
      mood: 'wave',
      pending_parameter: null, slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [], chips: [], chip_to_pref: CHIP_TO_PREF,
    };
  }
  // Gibberish, before the customer has told us anything. It used to run a
  // search on an empty request and answer "מיע" with three hotels.
  // A question whose TOPIC we recognised is not gibberish, whatever else we
  // failed to learn from it. "מקררון?" on an empty chat was understood — it
  // set the "מקרר בחדר" topic — and still got "לא בטוח שהבנתי" (30/08 live run).
  const puzzled = nothingKnown && !cardTopicAsked &&
    !offline.faq(lastUser) && !offline.deflect(lastUser) &&
    !offline.guard(lastUser) && !offline.isGreeting(lastUser) && !slotsChanged(prevSlots, slots)
    ? offline.notUnderstood(lastUser) : null;
  if (puzzled) {
    slots._lastQuestion = 'adults';
    // This early return sits ABOVE the _lost counter, so three "אאא" in a row
    // produced three byte-identical replies and the handover offer never
    // fired. Gibberish AFTER some details are known escalates correctly on the
    // second try; it was only the customer whose FIRST messages do not parse —
    // exactly the one most likely to give up — who got an unbreakable loop.
    slots._lost = (prevSlots._lost || 0) + 1;
    const stuck = slots._lost >= 2 && !prevSlots._nudged;
    if (stuck) slots._nudged = true;
    return {
      open_lead_form: stuck, reply_he: stuck
        ? puzzled + String.fromCharCode(10) + offline.noMatchAnswer()
        : puzzled,
      model_used: false,
      pending_parameter: 'adults', slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [],
      chips: ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'],
      chip_to_pref: CHIP_TO_PREF,
    };
  }
  if ((offline.isGreeting(lastUser) || !lastUser.trim()) && nothingKnown) {
    slots._lastQuestion = 'adults';
    return {
      open_lead_form: false,
      reply_he: guidance.msg('greeting', 'היי! אני עוזר למצוא חופשת סקי של פינגווין שבאמת פנויה.\n' +
        'כדי להתחיל — כמה תהיו בסך הכל, ונוסעים גם ילדים? אדייק לפי זה.'),
      model_used: false, pending_parameter: 'adults', slots, cards: [],
      two_room_splits: [], notes: [], relaxed: [],
      chips: ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים', 'בלי ילדים'],
      chip_to_pref: CHIP_TO_PREF,
    };
  }

  const result = engine.search(toSearchSlots(slots));
  // "יש עוד?" means the next options, not the same three again. Everything
  // already put in front of this customer is remembered and skipped; when the
  // list runs out we say so rather than silently looping.
  const more = offline.wantsMore(lastUser);
  const seenBefore = new Set(prevSlots._shown || []);
  // a resort comparison is answered in words above; the cards below it are
  // "what is open in each", not a ranking
  const comparingResorts = !!(recAnswer && (recAnswer.intent.kind === 'compare' || recAnswer.intent.kind === 'countries'));
  let cards = presentCards(result, slots, more ? seenBefore : null, { noTier: comparingResorts });

  // Tomer, 25/08: ask two or three questions FIRST, then show offers — unless
  // we already know enough. Showing three hotels after every message, before
  // the party size or the month is known, is a catalogue, not a salesperson:
  // the offers cannot be right yet, and the customer learns to ignore them.
  //
  // "Enough" is the party plus a when. Everything else (country, board, spa)
  // only sorts what we found; those two decide WHICH rooms even fit.
  // Tomer, 30/08 (after using Isrotel's "סאני"): understand enough FIRST, and
  // only then offer. Sunny's opening turn answered what it knew, said what it
  // was missing and asked for it — it did not put hotels on the screen until
  // the request was actually understood. Three hotels from three different
  // countries after "זוג בפברואר" is a catalogue, not a salesperson.
  //
  // "Enough" is the four things that decide WHICH packages even qualify:
  //   who is travelling · when · where · and, for a family, the Hebrew camp.
  // Everything else (spa, board, slope distance) only sorts what we found.
  const partyKnown = slots.adults != null ||
    (slots.children_ages || []).length > 0 || slots.children_count != null;
  const whenKnown = slots.month != null || slots.exact_day != null || !!slots.flexible_dates;
  // 'any' is a real answer — "לא משנה", or a question we decided not to spend a
  // turn on because it cannot change the result. Asked-and-answered counts as
  // known, or the gate would never open for a customer with no preference.
  const whereKnown = !!slots.destination || !!slots.hotel || slots.country != null;
  // The camp only decides anything when there is a child of camp age. It is the
  // difference between a week that works for this family and one that does not,
  // so for them it belongs on this side of the gate.
  const kidsOfCampAge = (slots.children_ages || []).some(a => SkiSearch.inCampAge(a));
  const kidsClubKnown = !kidsOfCampAge || slots.needs_hebrew_kids_club != null;
  const knowsEnough = partyKnown && whenKnown && whereKnown && kidsClubKnown;
  // A CONCRETE request is not the vague case this gate exists for. Someone who
  // named a hotel, a resort, or two destinations to compare has told us what
  // they want to look at; answering "כמה תהיו?" instead of showing it is the
  // opposite of listening. Sunny did the same — it searched the moment I named
  // two hotels. These never hold.
  // A resort we do NOT hold rooms in (St. Anton) is deliberately not here: the
  // sentence explaining what we can do there is a direct answer and always
  // survives (see fixedRaw below), but three alternative hotels chosen before
  // we know when they travel is the same catalogue this gate exists to stop.
  const namedPlace = !!slots.hotel || !!slots.destination || (slots.compare || []).length > 0;
  // A GENERIC "show me what you have" no longer skips the gate outright
  // (Tomer, 30/08) — it buys ONE question instead of the full round, and the
  // offers arrive on the next turn whatever the customer answered.
  const wantsToSee = more || offline.wantsMore(lastUser) ||
    /תראה|תראו|מה יש לכם|הראה לי|אפשר לראות|שלח לי אפשרויות|מה האפשרויות/.test(lastUser) ||
    // "מה יותר משתלם?" and "יש משהו עד 3500?" are requests to SEE, answered
    // with a list; holding them back for a full interview reads as stonewalling
    /משתלם|הכי זול|עד \d{3,5}|יש משהו|יש לכם|מחירים|תאריכים/.test(lastUser);
  // Whatever happens, the door opens by itself: after MAX_QUESTIONS turns of
  // asking, or after this conversation has already held the offers back that
  // many times. Nobody is ever stuck at the door — that rule has not changed,
  // only how much we learn before we open it.
  const held = +(prevSlots._held || 0);
  // "one question, then show" is a promise, so it has to outlive the turn the
  // customer made the request on: they answer the question on the next turn,
  // and that answer must arrive with the offers rather than another question.
  const askedForOffers = wantsToSee || !!prevSlots._showMe;
  const holdLimit = namedPlace ? 0 : (askedForOffers ? 1 : MAX_QUESTIONS);
  const askedEnough = questionsAsked >= MAX_QUESTIONS || held >= holdLimit;
  // The gate holds the FIRST offers back; it never takes offers away. A
  // customer who has already seen three cards and then answers a question is
  // giving us more, and watching the offers vanish reads as going backwards —
  // it turned up the moment this was tested as a conversation ("אוסטריה או
  // בולגריה למשפחה?" → offers, then "2 מבוגרים וילד בן 7" → nothing).
  const alreadySawOffers = (prevSlots._shown || []).length > 0;
  const holdingForDetails = !knowsEnough && !askedEnough && !alreadySawOffers &&
    !!tailQuestion && cards.length > 0;
  slots._held = holdingForDetails ? held + 1 : held;
  slots._showMe = askedForOffers && !knowsEnough;
  if (holdingForDetails) cards = [];
  // Holding the offers back must not swallow the off-topic line: "תן לי מתכון
  // לעוגה" used to get three hotels and a redirect, and would now get only
  // "כמה תהיו?" — as if a cake recipe were a step in booking a holiday.
  const understoodSomething = slotsChanged(prevSlots, slots) || !!faqHit || !!deflection ||
    // a question the hotel cards answer is understood, even before any card is
    // on screen — it was still getting "אני כאן בעיקר להתאמת חופשות סקי"
    cardTopicAsked ||
    wantsToSee || offline.isGreeting(lastUser) ||
    (slots.notes_from_customer || []).length > (prevSlots.notes_from_customer || []).length ||
    (slots.preferences || []).length > (prevSlots.preferences || []).length;
  // …but say it once. Step 3 already puts the line in the preamble when the
  // message is off topic, and a customer who asked for a cake recipe got the
  // same sentence twice, one under the other.
  if (holdingForDetails && !understoodSomething && lastUser.trim() && !preamble.includes(OFF_TOPIC_HE)) {
    preamble = [preamble, OFF_TOPIC_HE].filter(Boolean).join(String.fromCharCode(10));
  }
  let exhausted = false;
  if (more && !cards.length) {
    cards = presentCards(result, slots, null, { noTier: comparingResorts });   // start over rather than show nothing
    exhausted = true;
  }
  // de-duplicated: this used to concatenate a Set into an Array without one,
  // so the list filled with repeats (3 → 6 → 6 → 9 for three distinct offers)
  // and genuine entries were evicted by the 30-item cap — which is how "יש עוד?"
  // started showing hotels the customer had already been shown.
  slots._shown = [...new Set([...seenBefore, ...cards.map(c => c.hotel + '|' + c.date)])].slice(-30);
  // Remember the cheapest band actually put in front of the customer, so that
  // "יקר לי" on the next turn can be answered with something genuinely cheaper
  // rather than a reshuffle of the same prices.
  {
    // only classified cards set the floor "יקר לי" is answered against —
    // an unknown band is not evidence that anything cheaper exists
    const bands = cards.map(c => (c.price_range || '').length).filter(n => n > 0);
    if (bands.length) slots.shown_price_min = Math.min(...bands);
  }
  slots.price_objection = false;   // handled this turn; do not stick

  // the transparency line above the cards (see searchEcho above) — shown once
  // per distinct search, so the same offers reshuffled do not repeat it.
  // Two-room splits are offers too (the closing line already treats them so):
  // a family shown two rooms instead of one deserves the same "this is what I
  // searched for" as anyone else.
  let echoLine = null;
  if ((cards.length || (result.two_room_splits || []).length) && !holdingForDetails) {
    const echo = searchEcho(slots);
    if (echo && echo !== prevSlots._lastEcho) echoLine = echo;
    if (echo) slots._lastEcho = echo;
  }

  // ---- phrasing is templated, not generated ----
  // This halves the token bill, and it is also the strongest safety property
  // in the system: the model never sees the inventory, so it cannot invent a
  // hotel, a date, a price or an availability claim. Every word on a card
  // comes from the workbook or from pingwin.co.il.
  // Everything the customer mentioned accumulates in notes_from_customer, and
  // both the template and the model are required to address each item. Passing
  // the whole list every turn made a question answered four turns ago get
  // answered again, and again. Only the unaddressed ones are passed on.
  let freshNotes = (slots.notes_from_customer || [])
    .filter(n => !(prevSlots._notes_said || []).includes(n));
  // The model is required to address every note. When this same turn already
  // carries a standing answer, the note it would apologise about is usually the
  // very question that was just answered — and the reply contradicted itself.
  if (faqHit || deflection) {
    const before = new Set(prevSlots.notes_from_customer || []);
    // a REQUIREMENT stated in the same message ("...או לפחות מטבחון") is not
    // the question the FAQ just answered — it still deserves its word
    freshNotes = freshNotes.filter(n => before.has(n) || offline.isRequirementNote(n));
  }
  const sayingSlots = { ...slots, notes_from_customer: freshNotes, _notes_said: [] };

  // The off-commitment explanation is deterministic and printed verbatim: asked
  // for Italy, the model rewrote the paragraph in its own words and the reason
  // — limited flight and hotel places, and that a rep can check other dates —
  // vanished from the reply.
  // From here to the end of the turn nothing is allowed to throw away the
  // search result. Each deterministic line is built behind `safely`, so one
  // unexpected shape costs that sentence and not the three real offers under
  // it. (The template, the model phrasing and the final assembly are wrapped
  // the same way further down.)
  const safely = (what, fn, fallback = null) => {
    try { return fn(); }
    catch (e) { console.error(`reply line "${what}" failed:`, e.message); return fallback; }
  };
  const offCommLine = safely('off-commitment', () => offline.offCommitmentLine(result, slots));
  // What the search had to widen — a different month, a different country, two
  // rooms instead of one — is the most important sentence in the reply, and the
  // model kept paraphrasing it into nothing. Asked for December, shown January,
  // and not a word about the gap: three separate audit rounds.
  const widened = safely('relaxations', () => offline.relaxationLines(result, slots), []) || [];
  // ...but said once. A customer who has already read "לא מצאתי בדיוק בדצמבר,
  // אז הרחבתי לינואר" does not need it again on the next turn; they know.
  const saidFixed = new Set(prevSlots._fixed_said || []);
  // the comparison verdict rides in the same verbatim channel — the model kept
  // rewriting "באוסטריה לא מצאתי" into something friendlier and wrong
  let cmpLine = safely('comparison', () => offline.comparingLine(result, slots));
  const monthsLine = safely('both-months', () => offline.bothMonthsLine(result, slots, cards.length > 0));
  // "אפשר בדצמבר 2025?" — a fact about their request, true whether or not we
  // are showing offers this turn
  const yearLine = slots.wrong_year
    ? season.seasonSentence() : null;
  // "בבולגריה יש אפשרויות פנויות" + "בבולגריה אין יציאות בדצמבר" in the same
  // reply is a contradiction the customer has to untangle. When both fire, the
  // comparison keeps only the half the month line does not carry.
  if (cmpLine && widened.some(l => /אין לי יציאות פנויות/.test(l))) {
    cmpLine = /לא מצאתי בתנאים האלה/.test(cmpLine)
      ? cmpLine.replace(/^.*?;\s*/, 'הצגתי משני היעדים שציינתם; ')
      : 'הצגתי הצעות משני היעדים שציינתם, כדי שתוכלו להשוות.';
  }
  // While the offers are held back, only the lines that describe the REQUEST
  // survive — the year we are selling, and what we can or cannot do in the
  // resort they named. The rest ("הצגתי משני היעדים", "הרחבתי לינואר") describe
  // a list that is not on the screen, and over zero cards they are a lie.
  const fixedRaw = holdingForDetails
    ? [yearLine, offCommLine]
    : [yearLine, offCommLine, cmpLine, monthsLine, ...widened];
  const fixed = fixedRaw.filter(Boolean).filter(l => !saidFixed.has(l));
  slots._fixed_said = [...saidFixed, ...fixedRaw.filter(Boolean)].slice(-8);
  if (fixed.length) preamble = [preamble, ...fixed].filter(Boolean).join(String.fromCharCode(10));

  // A per-hotel question asked before any offer is on screen: understood, but
  // nothing here can answer it yet. Say where the answer will be rather than
  // "לא בטוח שהבנתי" — the bot understood the question perfectly ("מקררון?"
  // on an empty chat, 30/08 live run).
  let pointedAtCards = false;
  if (cardTopicAsked && !faqHit && !deflection && !cards.length &&
      !preamble.includes(CARD_TOPIC_POINTER)) {
    preamble = [preamble, CARD_TOPIC_POINTER].filter(Boolean).join(String.fromCharCode(10));
    pointedAtCards = true;
  }
  // a question the cards themselves answer is answered, not ignored
  if (cardTopicAsked && cards.length) pointedAtCards = true;

  // ---- a sub-question that fell on the floor (Sunny's own failure) --------
  // Asked Sunny "יש לכם את מלון X? וכמה עולה חניה שם?" (30/08) and the parking
  // half vanished — no answer, no acknowledgement, as if it had not been
  // written. That is the most annoying thing a bot does, because the customer
  // cannot tell whether it was refused, missed, or is coming.
  //
  // We know when it happened: the message plainly asked two things and only
  // one answer came back. Rather than guess at the second, say plainly that it
  // was not answered and invite it again — which is also the cheapest possible
  // repair, since the customer restates it in words the patterns may match.
  const answersGiven = (faqHit ? Math.max(1, (faqHit.all || []).length) : 0) +
    (deflection ? 1 : 0) + (dateFacts ? 1 : 0) + (recAnswer ? 1 : 0) +
    (pointedAtCards ? 1 : 0);
  const droppedHe = droppedQuestionLine(lastUser, multiPart, answersGiven, guarded);
  if (droppedHe && !preamble.includes(droppedHe)) {
    preamble = [preamble, droppedHe].filter(Boolean).join(String.fromCharCode(10));
  }

  // Offers held back for now (Tomer, 25/08): the reply is the question, and
  // nothing that describes a list the customer cannot see — and certainly not
  // "לא מצאתי התאמה", which would be a lie about a search that did find some.
  const CARDS_FLOOR_HE = guidance.msg('cards_floor', 'הנה מה שנראה פנוי אצלנו — הנציג יאשר סופית:');
  let templated;
  try {
    templated = holdingForDetails ? '' :
      (offline.phrase(result, sayingSlots, cards) ||
        (cards.length ? CARDS_FLOOR_HE : offline.noMatchAnswer()));
  } catch (e) {
    // the template builder is deterministic, but it reads a dozen optional
    // shapes off the result; one unexpected null must not cost the offers
    console.error('template phrasing failed:', e.message);
    templated = cards.length ? CARDS_FLOOR_HE : FALLBACK_HE();
  }
  // The model rewrites that in natural Hebrew (Tomer, 24/08). It only ever
  // sees the offers the deterministic filter already chose, so it cannot
  // invent one; and anything it returns must survive validate() or we ship
  // the template unchanged. The template is therefore the floor, never a
  // regression.
  // The widget files a bookkeeping line "[הוצגו 3 הצעות: …]" as an assistant
  // message after every card turn. It is not a reply — comparing the new
  // phrasing against it meant the real previous sentences were never deduped
  // whenever cards had been shown.
  const lastReply = [...messages].reverse().find(m => m.role === 'assistant' && !isBookkeeping(m.content));
  // A direct answer to a direct question — a price rule, a booking decision, a
  // refusal — is complete on its own. Letting the model add three sentences of
  // card facts under it turned "ניקח את הראשון" into a lecture.
  // Some standing answers are about what we will NOT do. Letting the model add
  // its own paragraph under them produced a reply that refused to rank hotels
  // and then ranked them.
  const NO_PARAGRAPH_AFTER = new Set(['compare', 'compare_countries', 'recommend', 'complaint',
    'my_booking', 'special_needs', 'name_change', 'lead_commitment', 'bot_or_human']);
  const answeredOnly = !!faqHit &&
    (!slotsChanged(prevSlots, slots) || NO_PARAGRAPH_AFTER.has(faqHit.id));
  // The search is already done at this point — three real, available hotels are
  // sitting in `cards`. Everything from here on is wording, and wording must
  // never be able to throw them away: a customer who reads "משהו השתבש" instead
  // of the offers we found is the most expensive failure this bot has.
  // …and that must hold for the OUTER timeout too, not only for a thrown
  // phrasing error. Until 30/08 a slow provider blew the 25-second cap and the
  // handler returned `{reply_he: FALLBACK, cards: []}` — throwing away offers
  // the deterministic layer had found in milliseconds, and telling the
  // customer to rephrase a message that was never the problem. It fires
  // exactly when a provider is degraded, so every customer gets it at once.
  // The template reply is complete right here, so it is published for the
  // timeout handler to return in place of an apology.
  if (body && body._partial) {
    body._partial.ready = {
      reply_he: [preamble, templated].filter(Boolean).join(String.fromCharCode(10)).trim() || templated,
      cards, slots, two_room_splits: result.two_room_splits || [],
    };
  }
  let intro;
  try {
    intro = (deflection || answeredOnly || holdingForDetails) ? templated : await phraseWithModel({
      slots: sayingSlots, cards, result, fallback: templated,
      lastReply: lastReply ? lastReply.content : null,
      answered: preamble || null, deadline, lastUserText: lastUser,
    });
  } catch (e) {
    console.error('phrasing failed, falling back to the template:', e.message);
    intro = templated;
  }
  slots._notes_said = [...new Set([...(prevSlots._notes_said || []),
    ...(slots.notes_from_customer || [])])].slice(-20);

  // still-unknown matching parameters ride along as one-tap chips, so the
  // customer completes the picture by choosing rather than by being asked
  // The party size and the children are the two gaps that most change the
  // answer, and they are asked at most once. After that they stay reachable as
  // one tap, so the picture can still be completed without being nagged for it.
  const gapChips = [];
  if (slots.adults == null) gapChips.push('2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים');
  else if (!(slots.children_ages || []).length && slots.no_children !== true) {
    gapChips.push('בלי ילדים');
  }
  // the school calendar is how families think about dates — Hanukkah and
  // Purim are one tap, the bare months stay for everyone else
  if (slots.month == null) gapChips.push('חנוכה', 'ינואר', 'פברואר', 'פורים');
  if (slots.departure_airport == null) gapChips.push('טיסה מנתב"ג', 'טיסה מחיפה');
  if (slots.country == null && slots.destination == null) {
    const ex = slots.excluded_countries || [];
    for (const [code, he] of Object.entries(labels.COUNTRY_HE)) {
      if (!ex.includes(code)) gapChips.push(he);
    }
  }

  // When the bot ASKS something, the chips must answer that question and
  // nothing else. Tomer, 26/08: under "באיזה חודש תרצו לצאת?" the widget also
  // offered "טיסה מנתב\"ג" and "טיסה מחיפה" — buttons that answer a question
  // nobody asked, next to a question with no month buttons for December or
  // March. Chips are the answer sheet for the question on screen.
  /* The chips that ANSWER the question this turn ended on.
     They used to be chosen by regex-matching the bot's own Hebrew output
     (/כמה תהיו|כמה נוסעים/ and so on), which coupled a UI control to a
     sentence Tomer is invited to edit: rewording a question in guidance.json —
     exactly what the config file exists for — silently left it with no chips.
     The question already carries a `key`; that is what decides now. The text
     match survives only as a fallback for a question the model wrote itself,
     which has no key. */
  const CHIPS_BY_KEY = {
    adults: () => ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'],
    children: () => ['בלי ילדים', 'ילד אחד', 'שני ילדים', 'שלושה ילדים'],
    children_ages: () => ['בלי ילדים', 'ילד אחד', 'שני ילדים', 'שלושה ילדים'],
    month: () => [...Object.keys(season.holidays()), ...season.months().map(m => season.monthHe(m)), 'גמיש'],
    kids_club: () => ['כן, קייטנה בעברית', 'בלי קייטנה'],
    airport: () => ['טיסה מנתב"ג', 'טיסה מחיפה'],
    country: () => {
      const ex = slots.excluded_countries || [];
      return Object.entries(labels.COUNTRY_HE)
        .filter(([code]) => !ex.includes(code)).map(([, he]) => he);
    },
  };
  const chipsForQuestion = (text, key) => {
    if (key && CHIPS_BY_KEY[key]) return CHIPS_BY_KEY[key]();
    const q = String(text || '');
    if (!q) return null;
    // fallback for a model-written question, which carries no key
    if (/כמה תהיו|כמה נוסעים|כמה אתם|בסך הכול|בסך הכל/.test(q)) return CHIPS_BY_KEY.adults();
    if (/גילאים|בן כמה|בת כמה|נוסעים גם ילדים|יש ילדים/.test(q)) return CHIPS_BY_KEY.children();
    if (/חודש|מתי תרצו|מתי לצאת|באיזה תאריך|אילו תאריכים/.test(q)) return CHIPS_BY_KEY.month();
    if (/קייטנ/.test(q)) return CHIPS_BY_KEY.kids_club();
    if (/לטוס|נתב"ג|נתב״ג|שדה התעופה/.test(q)) return CHIPS_BY_KEY.airport();
    if (/יעד שמושך|איזו מדינה|אוסטריה, צרפת/.test(q)) return CHIPS_BY_KEY.country();
    return null;
  };

  // The closing line goes last of all — after the question, so the reply ends
  // by moving forward rather than by asking. Skipped when the wording already
  // contains it, which happens when the model followed the same guidance.
  // nothing new left to show
  if (exhausted) {
    preamble = [preamble, 'אלה כל האפשרויות שמצאתי בתנאים האלה. אם נשנה תאריך או יעד — ייפתחו נוספות.']
      .filter(Boolean).join(String.fromCharCode(10));
  }
  // Two turns in a row the bot could not use is a bug report from a real
  // customer — and the point to hand over, once, rather than keep guessing.
  const lostNow = !!(lastUser && !slotsChanged(prevSlots, slots) && !modelUsed && !faqHit && !deflection &&
    !offline.wantsMore(lastUser) && !offline.isGreeting(lastUser) && !offline.wantsCallback(lastUser) &&
    !(slots.preferences || []).some(p => !(prevSlots.preferences || []).includes(p)));
  slots._lost = lostNow ? (prevSlots._lost || 0) + 1 : 0;
  const lostNudge = lostNow && slots._lost >= 2 && !prevSlots._nudged;
  const exhaustedNudge = exhausted && !prevSlots._nudged;
  if (lostNudge) {
    preamble = [preamble, 'נראה שלא הצלחתי להבין — עדיף שנציג ידבר אתכם. השאירו שם וטלפון, או כתבו לנו בוואטסאפ מהכפתור למעלה.']
      .filter(Boolean).join(String.fromCharCode(10));
  }
  if (lostNudge || exhaustedNudge) slots._nudged = true;

  // set by composeReply: true when this turn's offers are the ones already on
  // the customer's screen, so the widget can leave them where they are
  let sameOffersOut = false;
  const composeReply = () => {
    // THE COVERAGE GUARANTEE. The ack lines used to live inside the template,
    // and whenever the model's wording passed validation the template — acks
    // included — was replaced whole. That is where most "חסר" rejections came
    // from: the model mentioned two of three stated requirements and the third
    // vanished. Now the check runs on the final text: anything heard this turn
    // that the reply does not somehow mention is appended deterministically,
    // where no model can drop it.
    const saidSoFar = [preamble, intro].filter(Boolean).join(' ');
    // covered = the label itself appears, or at least half its distinctive
    // words do ("קרבה למסלולים" covers "קרוב למסלולים"; the word מלון alone
    // covers nothing)
    const mentions = (label) => {
      if (saidSoFar.includes(label)) return true;
      const words = String(label).split(/[\s\-()]+/)
        .filter(w => w.length >= 3 && !['או', 'עם', 'בלי', 'מלון', 'חדר'].includes(w));
      if (!words.length) return saidSoFar.includes(label);
      const hits = words.filter(w =>
        saidSoFar.includes(w) || saidSoFar.includes(w.replace(/^[לבמהו]/, ''))).length;
      return hits >= Math.max(1, Math.ceil(words.length / 2));
    };
    const coverage = [];
    if (cards.length || holdingForDetails) {
      const newPrefs = (slots.preferences || [])
        .filter(p => !(prevSlots.preferences || []).includes(p))
        .filter(p => !mentions(p));
      if (newPrefs.length) coverage.push('לקחתי בחשבון: ' + newPrefs.join(', ') + '.');
      const unheard = (sayingSlots.notes_from_customer || [])
        .filter(Boolean)
        // a stated number is never "covered" by the word תקציב elsewhere
        .filter(n => /תקציב לאדם/.test(n) ? true : !mentions(n))
        // and never a topic the CARDS are answering per hotel — promising a rep
        // will check the heated pool, directly above a card that names it, is
        // the bot contradicting its own offer (30/08)
        .filter(n => !(slots.unverifiable || []).some(u => u.includes(n) || n.includes(u)));
      // a stated per-person ceiling gets the plain answer to the question it
      // asked: we sort for it, we never quote a price, a rep confirms
      const ceiling = unheard.filter(n => /תקציב לאדם/.test(n));
      const rest = unheard.filter(n => !/תקציב לאדם/.test(n));
      if (ceiling.length) {
        coverage.push('לגבי התקציב לאדם שציינתם — סידרתי מהמשתלמות קודם, ' +
          'ואת המחיר המדויק מול המספר הזה נציג יאשר.');
      }
      if (rest.length) coverage.push('רשמתי לפניי: ' + rest.join(', ') + ' — נציג יבדוק ויאשר.');
      // constraints that live in slots, not in the preference list: they were
      // applied to the search and the customer never heard so
      const applied = [];
      if (slots.no_saturday_flights && !/שבת/.test(saidSoFar)) {
        applied.push('סיננתי יציאות בשבת — כל מה שמוצג יוצא בימים אחרים');
      }
      // Derived from the RESULT, never from the slot. The camp filter only
      // runs when ages are known (filter.js: it needs the age groups), so the
      // flag alone proves nothing about what was actually filtered — and the
      // old regex guard (`/קייטנ|קבוצת 4-6/`) missed the 6-13 gap line and
      // printed this sentence directly beneath a line saying the opposite.
      // Found 30/08: a family with no ages given was shown a week that
      // camps.json marks no_camp:true, under exactly this sentence.
      // No week in scope runs a group for these children — said once, plainly,
      // instead of the club silently never being mentioned again.
      if (slots._camp_unavailable && !prevSlots._camp_unavailable && !/קייטנ|קבוצ/.test(saidSoFar)) {
        applied.push(guidance.msg('camp_none_in_scope',
          'שימו לב: בתאריכים שמצאתי אין שבוע שבו פועלת קייטנה בעברית לגילאים שלכם'));
      }
      const campRan = cards.length > 0 &&
        cards.every(c => c.camps && (c.camps.running || []).length > 0);
      const campFullyCovered = campRan &&
        cards.every(c => !((c.camps || {}).missing || []).length);
      if (campFullyCovered && !/קייטנ|קבוצ/.test(saidSoFar)) {
        applied.push('הצגתי רק שבועות שבהם הקייטנה בעברית פועלת');
      }
      if (slots.departure_airport && slots.departure_airport !== 'any' &&
          !/חיפה|נתב/.test(saidSoFar)) {
        applied.push('סיננתי לפי שדה היציאה שביקשתם');
      }
      if (applied.length) coverage.push(applied.join('; ') + '.');
    }
    // "מה יותר משתלם?" deserves something to act on. Red rule 6 forbids
    // naming a winner (a reverted attempt cost 16 points on the fixed exam),
    // so this states the DIFFERENCE between the offers and leaves the choice
    // where it belongs.
    let contrast = null;
    if (cards.length > 1 && VALUE_Q.test(lastUser)) {
      const bands = cards.map(c => (c.price_range || '').length);
      const known = bands.filter(n => n > 0);
      const lo = known.length ? Math.min(...known) : 0;
      const hi = known.length ? Math.max(...known) : 0;
      const bits = [];
      if (lo < hi) {
        const cheap = cards.filter((c, i) => bands[i] === lo).map(c => c.hotel);
        bits.push(`בטווח המחיר הנמוך מבין המוצגות: ${cheap.join(' ו')}`);
      }
      const wanted = (slots.preferences || []).filter(p => p !== 'תקציב');
      for (const w of wanted.slice(0, 1)) {
        const has = cards.filter(c => (c.tags || []).includes(w)).map(c => c.hotel);
        if (has.length && has.length < cards.length) bits.push(`מסומנות ל${w}: ${has.join(' ו')}`);
      }
      if (bits.length) contrast = bits.join('; ') + '. מה מהם חשוב לכם יותר?';
    }
    // Anyone asking about money hears where the price lives. Saying nothing
    // was obedience to half a rule: we may not quote a number, and we may
    // always say that the exact one is on the booking screen.
    const MONEY_Q = /זול|יקר|תקציב|מחיר|כמה עולה|משתלם|לקרוע את הכיס|לאדם|כסף/;
    // …but only the half that is true of the cards on screen. A hotel with no
    // classified band shows no band, so "טווח המחיר מסומן על כל הצעה" would
    // contradict the very offers it sits above.
    const anyBand = cards.some(c => c.price_range);
    const priceLine = cards.length && MONEY_Q.test(lastUser) &&
      !/מסך ההזמנה|המחיר המדויק/.test([preamble, intro].filter(Boolean).join(' '))
      ? (anyBand
        ? 'טווח המחיר מסומן על כל הצעה, והמחיר המדויק לתאריך ולחדר שלכם מופיע במסך ההזמנה — נציג מאשר אותו סופית.'
        : 'המחיר המדויק לתאריך ולחדר שלכם מופיע במסך ההזמנה — נציג מאשר אותו סופית.')
      : null;
    const parts = [preamble, intro, contrast, priceLine, ...coverage, tailQuestion].filter(Boolean);
    // Once per conversation. Ending every turn with the same sentence is how
    // a bot sounds like a bot; a person says it when it is worth saying.
    // two-room splits are offers too — they render as their own cards in
    // the widget, so the closing must not tell the customer we found nothing
    const anyOffer = cards.length || (result.two_room_splits || []).length;
    // "אם אחת מהן" above a single card reads as a machine that did not look at
    // its own answer.
    const oneOnly = cards.length === 1 && !(result.two_room_splits || []).length;
    // "אפשר לשנות תאריך ואבדוק שוב" is the no-offers closing; while we are
    // deliberately holding offers back to ask a question, it is nonsense.
    const close = (closedBefore || holdingForDetails) ? ''
      : guidance.closing(anyOffer ? (oneOnly ? 'with_one_offer' : 'with_offers') : 'no_offers');
    const said = parts.join(String.fromCharCode(10));
    let closedNow = false;
    if (close && !said.includes(close.slice(0, 18))) { parts.push(close); slots._closed = true; closedNow = true; }
    // the widget prints the closing UNDER the offers, where the buttons it
    // refers to are; above three cards it pushed them below the fold
    if (close && anyOffer) slots._after_cards = close;
    // The second Sunny lesson (30/08): an answer that shows offers ends by
    // moving the conversation forward ("איזה מהמלונות מושך אתכם יותר?"). Only
    // when nothing in the reply already asks — one question per reply is our
    // own rule — not on top of the once-per-conversation closing CTA, and
    // never the same wording twice in a row. Wordings: guidance.nextSteps().
    const asksAlready = /\?\s*(\n|$)/.test(parts.join(String.fromCharCode(10)));
    if (cards.length && !asksAlready && !closedNow && !guarded) {
      const variants = guidance.nextSteps();
      const avoid = new Set(prevSlots._lastLines || []);
      const start = +(prevSlots._nextq || 0) % Math.max(variants.length, 1);
      for (let i = 0; i < variants.length; i++) {
        const cand = variants[(start + i) % variants.length];
        if (avoid.has(cand)) continue;
        parts.push(cand);
        slots._nextq = (start + i + 1) % variants.length;
        break;
      }
    }
    // A last trim on the assembled reply. phrase() caps its own lines, but a
    // FAQ answer, a question and a closing arrive from here — a kosher-keeping
    // family asking about camps got six paragraphs. The softer lines go first.
    // "לקחתי בחשבון" is the customer's proof of being heard — trimming it was
    // the single commonest complaint in the golden set. It is dropped only
    // after every coaching line is gone and the reply is still over the cap.
    const SOFT1 = /נפתחות|אני כאן אם תרצו/;
    const SOFT2 = /לקחתי בחשבון|ציינתם .+ או|סיננתי |הצגתי רק שבועות|בטווח המחיר הנמוך מבין|טווח המחיר מסומן|איזו מההצעות|רוצים שאדייק|מתלבטים בין שתיים|רוצים שאבדוק גם/;
    let all = parts.join(String.fromCharCode(10)).split(String.fromCharCode(10)).filter(Boolean);
    while (all.length > 5) {
      const drop = all.findIndex(l => SOFT1.test(l));
      const drop2 = drop < 0 ? all.findIndex(l => SOFT2.test(l)) : drop;
      if (drop2 < 0) break;
      all.splice(drop2, 1);
    }
    // A sentence the customer already read, above the same offers, is noise
    // the second time. It was the loudest thing about a long conversation:
    // five turns in a row opening with the same two lines.
    const cardKey = cards.map(c => c.hotel + '|' + c.date).join(',');
    const sameOffers = !!cardKey && cardKey === (prevSlots._lastCards || null);
    const alreadySaid = new Set(sameOffers ? (prevSlots._lastLines || []) : []);
    // coaching lines are not content: hearing "אם תהיו גמישים בתאריך" twice in
    // a row grates whatever the cards below are doing
    const STOCK = /אם (תהיו גמישים|תוותרו|תשקלו)|לא מצאתי התאמה במערכת|אני כאן אם תרצו/;
    for (const l of prevSlots._lastLines || []) if (STOCK.test(l)) alreadySaid.add(l);
    // A red-rule answer ("המחיר המדויק…") is the same sentence every time by
    // design. Dropping it as a repeat turned the third "תגיד לי מחיר" into a
    // line about cards — evasion where a rule was meant to speak.
    const mustKeep = new Set([
      ...(deflection || '').split(String.fromCharCode(10)).filter(Boolean),
      // an FAQ answer matched THIS turn is a direct answer to a direct
      // question — unless it is the SAME question as last turn, in which case
      // repeating the paragraph verbatim is the annoyance, not the answer
      ...(faqHit && !faqSuppressed && faqHit.id !== prevSlots._lastFaqId
        ? faqHit.he.split(String.fromCharCode(10)) : []),
      ...(faqSuppressed ? [PER_CARD_POINTER[faqHit.id]].filter(Boolean) : []),
    ]);
    if (alreadySaid.size) {
      const fresh = all.filter(l => !alreadySaid.has(l) || mustKeep.has(l));
      // Everything we were about to say has already been said, above these same
      // offers. Saying it all again is worse than saying one true short thing.
      // and when everything was already said, the one line we allow ourselves
      // reflects what the customer asked for instead of pointing at the cards
      const focus = [...(slots.preferences || [])].slice(0, 2);
      all = fresh.length ? fresh
        : !cards.length
          ? ['לא מצאתי משהו חדש להציע בתנאים האלה. רוצים שאבדוק חודש, יעד או הרכב אחר?']
          : [focus.length
            ? `אלה ההצעות שעונות הכי טוב על ${focus.join(' ו')} מתוך מה שפנוי כרגע. רוצים שאבדוק חודש או יעד אחר?`
            : 'אלה ההצעות הפתוחות כרגע בתנאים שלכם. רוצים שאבדוק חודש או יעד אחר?'];
    }
    slots._lastCards = cardKey;
    // The widget uses this to avoid drawing the same three cards again. They
    // were re-rendered on every turn — a six-turn conversation on a phone was
    // eighteen cards, fifteen of them duplicates, with the view jumping to the
    // newest copy each time so every turn looked like the bot had answered by
    // re-presenting the same hotels. The payload still carries them, so
    // nothing downstream has to care.
    sameOffersOut = sameOffers;
    // The memory accumulates while the offers stand still: suppressing a line
    // for one turn only to say it again on the next is the same repetition,
    // one turn later.
    slots._lastLines = [...new Set([...alreadySaid, ...all])].slice(-24);
    return all.join(String.fromCharCode(10));
  };
  // Same rule as the phrasing above: assembling the sentences is the last thing
  // that happens, and it happens after the expensive part succeeded. If it
  // throws, ship what we already have — the offers plus the plain template —
  // rather than losing the turn.
  let replyText;
  try {
    replyText = composeReply();
  } catch (e) {
    console.error('reply assembly failed, shipping the plain lines:', e.message, e.stack);
    replyText = [preamble, intro].filter(Boolean).join(String.fromCharCode(10)) || templated || FALLBACK_HE();
  }

  // One line per turn. Every defect in this project was found by a person
  // reading a reply; this is what makes that possible without waiting for a
  // screenshot.
  if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
  chatLog.logTurn({
    conversationId: body.conversationId || slots._cid,
    userText: lastUser, reply: replyText, cards, result, slots,
    modelUsed, ms: Date.now() - startedAt,
    // a turn we could not use is a bug report written by a real customer
    notUnderstood: offTopic && !deflection && !faqHit && !dateFacts,
    answeredBy: guarded ? 'guard' : deflection ? 'deflect'
      : faqHit ? (faqHit.routed ? 'router' : 'faq') : dateFacts ? 'dates' : pointedAtCards ? 'cards' : null,
  });

  // the question this turn actually ended on: the blocking one if we held the
  // offers back, otherwise the one that rode along under them
  const askedNow = replyIfNotReady || tailQuestion || null;
  const askedKey = slots._lastQuestion || (pendingQuestion && pendingQuestion.key) || null;
  const focusedChips = cards.length ? null : chipsForQuestion(askedNow, askedKey);

  // A request to be called back opens the form, on the offer they were looking
  // at if there is one. Telling someone where to find a button is not service.
  slots._lastFaqId = faqHit ? faqHit.id : null;
  slots._lastGuard = guarded || null;
  const askForDetails = offline.wantsCallback(lastUser) || lostNudge || exhaustedNudge;

  return {
    open_lead_form: askForDetails,
    // the remaining parameters are offered as chips, not asked as a question —
    // a customer looking at three real offers should not also face an interview
    search_echo_he: echoLine,
    reply_he: replyText,
    // true when these are the offers already on the customer's screen — the
    // widget then leaves them there instead of drawing a second copy
    cards_unchanged: sameOffersOut,
    after_cards_he: (cards.length && slots._after_cards && replyText.includes(slots._after_cards)) ? slots._after_cards : null,
    model_used: modelUsed,
    pending_parameter: pendingQuestion ? pendingQuestion.key : null,
    slots, cards,
    two_room_splits: (result.two_room_splits || []).map(sp => ({ ...sp, hotel: displayHotel(sp.hotel) })),
    notes: result.notes, relaxed: result.relaxed,
    // with offers on screen the chips are for exploring; with a question on
    // screen they are for answering it
    chips: cards.length ? [...gapChips, ...CHIP_LABELS] : (focusedChips || gapChips),
    chip_to_pref: CHIP_TO_PREF,
    // how the turn was decided — for the question-bank harness only, never
    // shown to customers (tests/test-bank.js sets BANK_DEBUG=1)
    ...(process.env.BANK_DEBUG ? { debug: {
      answered_by: guarded ? 'guard' : deflection ? 'deflect' : faqHit ? (faqHit.routed ? 'router' : 'faq') : dateFacts ? 'dates' : pointedAtCards ? 'cards' : null,
      faq_ids: faqHit ? (faqHit.all || [faqHit]).map(a => a.id) : [],
      guard: guarded || null, off_topic: !!offTopic, not_understood: !!(offTopic && !deflection && !faqHit),
      pending: pendingQuestion ? pendingQuestion.key : null,
    } } : {}),
  };
}

/* ---------- http plumbing ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

// Loaded via GTM, the widget runs on pingwin.co.il while this API runs
// elsewhere — so the browser needs CORS. ALLOWED_ORIGINS in .env is a
// comma-separated allowlist; "*" is fine for the demo, not for production.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  if (!ok) return false;
  res.setHeader('access-control-allow-origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-max-age', '86400');
  return true;
}

const STRICT_ORIGIN = !ALLOWED_ORIGINS.includes('*');
const CHAT_TIMEOUT_MS = +(process.env.CHAT_TIMEOUT_MS || 25_000);
const SLOW_DOWN_HE = () => guidance.msg('rate_limited',
  'קיבלנו הרבה הודעות ברצף — רגע אחד ונמשיך. אם דחוף, נשמח לעזור בטלפון {phone}.');
const TOO_LONG_HE = () => guidance.msg('chat_too_long',
  'השיחה התארכה — כדי לא לפספס כלום, מכאן נציג פינגווין ימשיך אתכם. השאירו טלפון ונחזור אליכם.');
const VERIFY_HE = () => guidance.msg('verify_failed',
  'לא הצלחנו לאמת שהבקשה הגיעה מהאתר. רעננו את הדף ונסו שוב, או חייגו {phone}.');

function json(res, code, obj, extra) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...(extra || {}) });
  res.end(JSON.stringify(obj));
}
/* Returns the parsed body, or the string 'too_large'. It used to return null
   and destroy the socket, and every caller then returned WITHOUT writing a
   response — so an oversized paste got no reply at all: the widget waited its
   full 28 seconds, showed the generic error, and offered a "נסו שוב" that
   reproduced the same two-minute wait. Always answer. */
async function readJson(req, cap) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > cap) { req.destroy(); return 'too_large'; }
  }
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    if (!applyCors(req, res)) { res.writeHead(403); res.end('origin not allowed'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    // in production every browser POST carries an Origin; one without it is not the widget
    if (STRICT_ORIGIN && req.method === 'POST' && !req.headers.origin) { res.writeHead(403); res.end('origin required'); return; }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      // `mode` used to be derived from the presence of a key, so a monitor saw
      // green through a total provider outage. `model` is what actually
      // happened; alert on `model.degraded`.
      const model = health.report();
      return json(res, 200, {
        ok: true, mode: aiMode(), version: BOT_VERSION,
        model, degraded: model.degraded,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      // what the widget needs to know before its first request
      // the widget's own copy comes from here too, so guidance.json is the
      // single place the office number is written down
      return json(res, 200, {
        version: BOT_VERSION,
        turnstile: process.env.TURNSTILE_SITEKEY || null,
        phone: guidance.phone() || null,
        messages: {
          send_error: guidance.msg('widget_send_error', 'תקלה בשליחה — נסו שוב או חייגו {phone}'),
          chat_error: guidance.msg('widget_chat_error', 'אירעה תקלה זמנית בתקשורת. נסו שוב בעוד רגע, או חייגו {phone}.'),
          // the launcher's two lines — the first thing anyone reads
          launcher_title: guidance.msg('launcher_title', 'מתלבטים איפה לגלוש?'),
          launcher_sub: guidance.msg('launcher_sub', 'פינגי כאן, ועונה תוך שנייה'),
          greeting_widget: guidance.msg('greeting_widget', ''),
          ai_disclosure: guidance.msg('ai_disclosure', ''),
        },
        // The lead form's labels per language. A customer who wrote in English
        // got a correct English reply and then a form that was entirely in
        // Hebrew — including the validation errors explaining why it was
        // rejected. Sent once with the config rather than per turn.
        lead_form: (guidance.load().languages_he || {}).form || {},
      }, { 'cache-control': 'no-store' });
    }
    const ip = limits.clientIp(req);
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const wait = limits.checkRate('chat', ip);
      if (wait) return json(res, 429, { reply_he: SLOW_DOWN_HE(), slots: {}, cards: [], chips: [], retry_after: wait }, { 'retry-after': String(wait) });
      const body = await readJson(req, 100_000);
      if (body === 'too_large') {
        return json(res, 413, { reply_he: TOO_LONG_MSG_HE(), slots: null, cards: [], chips: [] });
      }
      if (!body) return;
      const slots = { ...(body.slots || {}) };
      // minted here, before anything can return early, so the id the widget
      // gets back is the same one the log and the lead will carry
      if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
      if (limits.turnstileOn() && !limits.stampValid(slots)) {
        const ok = await limits.verifyTurnstile(body.turnstile, ip);
        if (!ok) return json(res, 403, { reply_he: VERIFY_HE(), slots: body.slots || {}, cards: [], chips: [], verify: true });
        slots._vt = limits.stamp(slots._cid);
      }
      if (limits.turnsExceeded(slots)) {
        return json(res, 200, { reply_he: TOO_LONG_HE(), slots, cards: [], chips: [], open_lead_form: true });
      }
      body.slots = slots;
      // handleChat publishes its finished deterministic reply here the moment
      // it has one, so a model that never comes back costs the customer the
      // model's wording — not the offers, and not an apology for a message
      // that was fine. See the note beside the publish site in handleChat.
      body._partial = {};
      let out;
      try {
        out = await limits.withTimeout(handleChat(body), CHAT_TIMEOUT_MS, () => {
          console.error('chat timeout after', CHAT_TIMEOUT_MS, 'ms');
          const ready = body._partial && body._partial.ready;
          if (ready) {
            return { ...ready, chips: [], timeout: true, model_used: false, notes: [], relaxed: [] };
          }
          return { reply_he: SLOW_HE(), slots, cards: [], chips: [], timeout: true };
        });
      } catch (e) {
        console.error('chat error:', e.message, e.detail || '');
        out = { reply_he: e.friendly || FALLBACK_HE(), slots, cards: [], chips: [] };
      }
      // the stamp and the turn counter must survive whatever handleChat did to the slots
      out.slots = { ...(out.slots || {}), _turns: slots._turns, _cid: slots._cid,
        ...(slots._vt ? { _vt: slots._vt } : {}) };
      return json(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/lead') {
      const wait = limits.checkRate('lead', ip);
      if (wait) return json(res, 429, { ok: false, retry_after: wait }, { 'retry-after': String(wait) });
      const lead = await readJson(req, 20_000);
      if (lead === 'too_large') return json(res, 413, { ok: false, reason: 'too_large' });
      if (!lead) return;
      if (!lead.name || !lead.phone) return json(res, 400, { ok: false });
      if (limits.turnstileOn()) {
        const ctxSlots = (lead.context && lead.context.slots) || null;
        const ok = limits.stampValid(ctxSlots) || await limits.verifyTurnstile(lead.turnstile, ip);
        if (!ok) return json(res, 403, { ok: false, verify: true });
      }
      // leads contain PII (name+phone) — stored server-side only, dir is gitignored.
      // Append-only JSONL: the old read-modify-write of one JSON array lost a
      // lead whenever two arrived together.
      const dir = path.join(ROOT, 'server-data');
      fs.mkdirSync(dir, { recursive: true });
      /* The lead context comes from the browser, so it is whitelisted and
         clamped exactly as crm-lead.js already does for the CRM payload — it
         used to be stored and emailed raw, unbounded, with a 12-turn
         transcript in it. Two problems that fixed:
           - a 20KB `transcript` of anything at all reached the reps' inbox,
             from Pingwin's own address, with an attacker-chosen Reply-To;
           - the transcript is the ONE place a phone number or an email the
             customer typed into the chat box was stored in the clear.
             conversation-log.js redacts exactly that on the way in; this path
             skipped it entirely. */
      const rawCtx = (lead.context && typeof lead.context === 'object' && !Array.isArray(lead.context))
        ? lead.context : {};
      const txt = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
      const ctx = {
        hotel: txt(rawCtx.hotel, 80), resort: txt(rawCtx.resort, 80),
        date: txt(rawCtx.date, 12), nights: Number.isFinite(+rawCtx.nights) ? +rawCtx.nights : null,
        room: txt(rawCtx.room, 120),
        kind: txt(rawCtx.kind, 30),
        conversation_id: txt(rawCtx.conversation_id, 40),
        slots: (rawCtx.slots && typeof rawCtx.slots === 'object')
          ? { _cid: txt(rawCtx.slots._cid, 40), _vt: txt(rawCtx.slots._vt, 128) } : null,
        party: (rawCtx.party && typeof rawCtx.party === 'object') ? {
          adults: Number.isFinite(+rawCtx.party.adults) ? +rawCtx.party.adults : null,
          children_ages: Array.isArray(rawCtx.party.children_ages)
            ? rawCtx.party.children_ages.map(Number).filter(Number.isFinite).slice(0, 10) : [],
        } : null,
        request: (rawCtx.request && typeof rawCtx.request === 'object' && !Array.isArray(rawCtx.request))
          ? rawCtx.request : null,
        consent: (rawCtx.consent && typeof rawCtx.consent === 'object') ? {
          privacy: rawCtx.consent.privacy === true,
          at: txt(rawCtx.consent.at, 40),
          text: txt(rawCtx.consent.text, 400),
        } : null,
        // redacted with the same function the chat log uses, and capped
        transcript: typeof rawCtx.transcript === 'string'
          ? chatLog.redact(rawCtx.transcript).slice(0, 4000) : null,
      };
      const record = {
        id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: new Date().toISOString(),
        name: String(lead.name).slice(0, 80), phone: String(lead.phone).slice(0, 30),
        // optional: the customer may want the offer in writing (Tomer, 26/08 —
        // the quote itself will be sent from Pingwin's own system later)
        email: lead.email ? String(lead.email).slice(0, 120) : null,
        kind: String(ctx.kind || 'customer').slice(0, 30),
        context: ctx,
      };
      fs.appendFileSync(path.join(dir, 'leads.jsonl'), JSON.stringify(record) + '\n');
      // no PII on stdout — only that a lead landed and what kind
      console.log(`lead ${record.id} [${record.kind}] → ${ctx.hotel || 'ללא הצעה ספציפית'} ${ctx.date || ''}`.trim());
      notifyLead(record).catch(e => {
        console.error('lead notify failed:', e.message);
        markUndelivered(record, e);          // so it can be re-sent, not just logged
      });
      // and the version that needs no integration: an email to a person
      leadMail.sendLead(record).then(r => {
        if (r.sent) console.log(`lead ${record.id} emailed`);
      }).catch(e => console.error('lead email crashed:', e.message));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: record.id }));
      return;
    }
    // Sunny lesson #3 (30/08): a thumbs-up/down under every answer. Each vote
    // lands in an append-only file with the reply it judged — a down-vote is a
    // bug report written by a real customer, and reviewing them is how the bot
    // improves. No PII: only the vote, the conversation id and the bot's text.
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      const wait = limits.checkRate('feedback', ip);
      if (wait) return json(res, 429, { ok: false, retry_after: wait }, { 'retry-after': String(wait) });
      const fb = await readJson(req, 10_000);
      if (fb === 'too_large') return json(res, 413, { ok: false, reason: 'too_large' });
      if (!fb) return;
      const vote = fb.vote === 'up' ? 'up' : fb.vote === 'down' ? 'down' : null;
      if (!vote) return json(res, 400, { ok: false });
      const dir = path.join(ROOT, 'server-data');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'feedback.jsonl'), JSON.stringify({
        at: new Date().toISOString(), vote,
        conversationId: String(fb.conversationId || '').slice(0, 40),
        reply: String(fb.reply || '').slice(0, 600),
      }) + '\n');
      console.log('feedback: ' + (vote === 'up' ? '👍' : '👎') + ' (' + String(fb.conversationId || '?').slice(0, 40) + ')');
      return json(res, 200, { ok: true });
    }
    // static
    let file = url.pathname === '/' ? '/public/demo.html'
      : url.pathname === '/pingwin-bot.js' ? '/public/pingwin-bot.js'
        : '/public' + url.pathname;
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return; }
    // the GTM loader appends ?v=<version>: a versioned URL may be cached for a
    // day, an unversioned one is re-checked every time
    const cache = url.searchParams.get('v') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': cache });
    res.end(fs.readFileSync(full));
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end();
  }
});

if (require.main === module) {
  // retention: delete conversation logs older than CHAT_LOG_DAYS (default 30)
  { const n = chatLog.sweep(); if (n) console.log(`chat log: removed ${n} day(s) past retention`); }
  // …and the same discipline for server-data/, which had none: leads kept
  // names, phone numbers and transcripts for ever. See server/retention.js.
  try { require('./retention.js').sweep(); } catch (e) { console.error('retention sweep failed:', e.message); }
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  leadMail.warnIfUnwatched();
  server.listen(PORT, () => console.log(`pingwin bot server v${BOT_VERSION} [${aiMode()}] → http://localhost:${PORT}`));
}
module.exports = { handleChat, server, requiredMissing };
