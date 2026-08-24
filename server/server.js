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
const { buildBookingUrl } = require('../config/booking-url.js');

loadEnv();
const has = k => process.env[k] && !process.env[k].includes('xxxx');
// Provider is chosen by whichever key is present. With none, the bot still
// works fully on the deterministic Hebrew layer — free, no account.
function aiMode() {
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
const ROOT = path.join(__dirname, '..');
const engine = new SkiSearch();

const EMPTY_SLOTS = {
  adults: null, children_ages: [], no_children: null, month: null,
  flexible_dates: null, country: null, destination: null,
  departure_airport: null, needs_hebrew_kids_club: null, preferences: [],
  excluded_countries: [], excluded_destinations: [], notes_from_customer: [],
  price_objection: false, shown_price_min: null, month_part: null, exact_day: null, hotel: null,
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

const FALLBACK_HE = 'סליחה, משהו השתבש לרגע. אפשר לנסח שוב? לחלופין, נציג זמין בטלפון 04-8557722.';

/* ---------- helpers ---------- */
function requiredMissing(slots) {
  const missing = [];
  if (slots.adults == null) missing.push('adults');
  if ((slots.children_ages || []).length === 0 && slots.no_children !== true) missing.push('children');
  if (slots.month == null) missing.push('month');
  const kidsInRange = (slots.children_ages || []).some(a => a >= 4 && a <= 13);
  if (kidsInRange && slots.needs_hebrew_kids_club == null) missing.push('kids_club');
  return missing;
}

function assistantQuestionCount(messages) {
  return messages.filter(m => m.role === 'assistant' && /\?/.test(String(m.content))).length;
}

function toSearchSlots(slots) {
  // "any" is a real answer ("לא משנה") — it means asked-and-answered, so we
  // stop asking, but it must not become a filter
  const any = v => (v === 'any' ? null : v);
  return {
    ...slots,
    month: any(slots.month),
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

async function fillSlotsWithModel(messages, prevSlots, questionsAsked) {
  // only the last few turns are sent — older ones are already folded into slots
  const recent = messages.slice(-4);
  const payload = [
    ...recent,
    { role: 'user', content: `slots: ${JSON.stringify(prevSlots)}\nשאלות שנשאלו: ${questionsAsked}/${MAX_QUESTIONS}\nהחזר JSON.` },
  ];
  // Tomer's instructions go BEFORE the built-in rules, so the hard ones stay
  // the last word in the prompt (see server/guidance.js).
  const system = SLOT_PROMPT_LEAN + guidance.forAsking();
  const raw = aiMode() === 'openai'
    ? await callOpenAI({ system, messages: payload, maxTokens: 400 })
    : await callClaude({ system, messages: payload, maxTokens: 400 });
  return parseModelJSON(raw);
}

// Which standing answer applies (server/answer-router.js). One small call, and
// only when the free regex layer missed. Cached, because customers ask the
// same twenty questions and a repeat should cost nothing.
const ROUTE_CACHE = new Map();
async function routeToAnswer(text) {
  if (aiMode() === 'offline') return null;
  const entries = offline.faqEntries();
  if (!entries.length) return null;
  const key = text.trim().slice(0, 200);
  if (ROUTE_CACHE.has(key)) return ROUTE_CACHE.get(key);
  let hit = null;
  try {
    const system = router.buildPrompt(entries);
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: key }], maxTokens: 600 })
      : await callClaude({ system, messages: [{ role: 'user', content: key }], maxTokens: 600 });
    hit = router.pick(raw, entries);
  } catch (e) {
    console.error('answer router failed:', e.message);   // never breaks a turn
  }
  if (ROUTE_CACHE.size > 500) ROUTE_CACHE.clear();
  ROUTE_CACHE.set(key, hit);
  return hit;
}

async function phraseWithModel({ slots, cards, result, fallback, lastReply, answered }) {
  if (aiMode() === 'offline') return fallback;
  // Nothing to phrase: the turn is a question or a no-match, and the template
  // for those is careful, short and already right. Paying to reword it would
  // buy nothing and risks softening a "no" that must stay clear.
  if (!cards.length) return fallback;
  try {
    const payload = phrasing.buildPayload({ slots, cards, result, fallback, lastReply, answered });
    const system = phrasing.PHRASE_PROMPT + guidance.forAnswering(cards[0] && cards[0].country);
    // 1200, not 320: on a reasoning model max_completion_tokens covers the
    // thinking too, and a 320 cap produced an empty reply that then failed
    // validation and silently fell back to the template on every turn. The
    // auditor still caught the occasional empty at 900, so there is headroom
    // here — an empty reply costs the same as a full one.
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: payload }], maxTokens: 1200, json: false })
      : await callClaude({ system, messages: [{ role: 'user', content: payload }], maxTokens: 1200 });
    let text = String(raw || '').trim();
    // Whole sentences it already said last turn, dropped. "ההצעות נראות פנויות,
    // ונציג יאשר סופית" is true every time and worth saying once.
    if (lastReply) {
      const norm = x => x.replace(/[\s.,;:!?"'׳״]+/g, '').trim();
      const before = new Set(String(lastReply).split(/(?<=[.!?])\s+/).map(norm).filter(Boolean));
      const kept = text.split(/(?<=[.!?])\s+/).filter(x => !before.has(norm(x)));
      if (kept.length && kept.join(' ').trim().length > 25) text = kept.join(' ').trim();
    }
    const verdict = phrasing.validate(text, { cards, fallback });
    if (!verdict.ok) {
      // worth seeing in the log: a rejected phrasing is either a prompt bug or
      // a model drifting towards something a customer must never be told
      console.error('phrasing rejected (%s): %s', verdict.why, text.slice(0, 160));
      return fallback;
    }
    return text;
  } catch (e) {
    console.error('phrasing model failed:', e.message);
    return fallback;
  }
}

// The hotel's name as a customer should read it.
function displayHotel(name) {
  return String(name || '').replace(/\s*\((allotment|Allotment)\)\s*/g, ' ').trim();
}

function presentCards(result, slots, skip) {
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
    country_he: { austria: 'אוסטריה', france: 'צרפת', andorra: 'אנדורה', bulgaria: 'בולגריה' }[c.country] || c.country,
    date: c.date, date_label: c.date_label, nights: c.nights,
    room: c.room, occ: c.occ_effective, occ_composition_he: c.occ_composition_he,
    desc_he: c.desc_he, lift_he: c.lift_he, tags: c.tags, image: c.image,
    // the whole gallery, so the card can page through the hotel's own photos
    images: (engine.hotelInfo(c.hotel).images || []).slice(0, 12),
    // what THIS package includes, verbatim from the hotel page. It differs
    // hotel by hotel — half board only, breakfast with half board for a
    // supplement, ski pass or not — so a generic sentence would be wrong.
    package_includes_he: engine.hotelInfo(c.hotel).package_includes_he || null,
    count_available: c.count_available,
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
    wifi_he: c.wifi_he, spa_he: c.spa_he, spa_access: c.spa_access,
    spa_access_he: c.spa_access_he, spa_note_he: c.spa_note_he, spa_min_age: c.spa_min_age,
    separate_beds: c.separate_beds, separate_beds_other_he: c.separate_beds_other_he,
    // the hotel's own page — the customer clicked this hotel, not the home page
    booking_url: buildBookingUrl(engine.hotelInfo(c.hotel)),
  }));
}

/* ---------- chat orchestration ---------- */
async function handleChat(body) {
  const startedAt = Date.now();
  const messages = (body.messages || []).slice(-20).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 2000),
  }));
  const prevSlots = { ...EMPTY_SLOTS, ...(body.slots || {}) };
  const questionsAsked = assistantQuestionCount(messages);

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const lastUser = lastUserMsg ? lastUserMsg.content : '';

  // ---- step 1: deterministic Hebrew parse — always runs, always free ----
  let slots = offline.parseText(lastUser, prevSlots);
  let replyIfNotReady = null;
  let modelUsed = false;

  // ---- step 2: escalate to the model ONLY if step 1 learned nothing ----
  if (aiMode() !== 'offline' && shouldAskModel(prevSlots, slots, lastUser)) {
    try {
      const parsed = await fillSlotsWithModel(messages, prevSlots, questionsAsked);
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
        merged.notes_from_customer = [...new Set([
          ...(slots.notes_from_customer || []),
          ...(parsed.slots.notes_from_customer || []),
        ])].slice(0, 6);
        slots = merged;
        modelUsed = true;
        if (!parsed.ready_to_search && parsed.reply_he) replyIfNotReady = parsed.reply_he;
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
  let faqHit = offline.faq(lastUser);
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
    faqHit = await routeToAnswer(lastUser);
  }
  const offTopic = lastUser && !slotsChanged(prevSlots, slots) && !modelUsed &&
    !faqHit && !offline.deflect(lastUser) && !offline.wantsMore(lastUser) &&
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
      if (q.key === 'kids_club') slots.needs_hebrew_kids_club = slots.needs_hebrew_kids_club ?? false;
      q = offline.nextQuestion(slots, null);
    }
    if (q && q.blocking) { slots._lastQuestion = q.key; replyIfNotReady = q.he; }
    else { pendingQuestion = q; delete slots._lastQuestion; }
  }

  const OFF_TOPIC_HE = 'אני כאן בעיקר להתאמת חופשות סקי של פינגווין. לשאלות אחרות נציג ישמח לעזור ב-04-8557722.';
  const SEASON_HE = 'עונת הסקי שלנו היא דצמבר עד סוף מרץ — בחודשים אחרים אין לנו יציאות.';
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
  const guarded = offline.guard(lastUser) ||
    offline.unknownHotel(lastUser);
  const deflection = guarded || (faqHit ? null
    : (slotsChanged(prevSlots, slots) ? null : offline.deflect(lastUser)));
  // deflect() guards the red rules (no customer names, no exact prices) so it
  // wins; the FAQ answer follows only when there is nothing to guard against.
  // Unlike deflect(), the FAQ answers even when the same message also filled
  // slots — "2 מבוגרים בפברואר, יש אוכל כשר?" deserves an answer and offers.
  // Topics the CARDS answer per hotel. Printing the general FAQ paragraph
  // above three cards that each state their own spa terms is noise, and worse,
  // it reads as a hedge right before the specific answer.
  const PER_CARD_FAQ = new Set(['spa', 'wifi']);
  // "אחי מה יש לכם לפברואר לזוג?" matches the help entry and also states
  // the party and the month. Asking them again for both is not listening.
  const faqSuppressed = (faqHit && PER_CARD_FAQ.has(faqHit.id)) ||
    (faqHit && faqHit.id === 'help_me' && slotsChanged(prevSlots, slots));
  // Suppressed is not the same as unanswered: without a word the customer is
  // left wondering whether the question landed. One line points at the place
  // the per-hotel answer actually is.
  const PER_CARD_POINTER = {
    spa: 'תנאי הספא שונים בין המלונות — מה שחל על כל אחד מהם כתוב על ההצעה שלו.',
    wifi: 'תנאי האינטרנט שונים בין המלונות — מה שחל על כל אחד מהם כתוב על ההצעה שלו.',
  };
  let preamble = [
    deflection,
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
  if (offline.isFarewell(lastUser)) {
    return {
      open_lead_form: false, reply_he: offline.FAREWELL_HE, model_used: false,
      pending_parameter: null, slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [], chips: [], chip_to_pref: CHIP_TO_PREF,
    };
  }
  // Gibberish, before the customer has told us anything. It used to run a
  // search on an empty request and answer "מיע" with three hotels.
  const puzzled = nothingKnown && !offline.faq(lastUser) && !offline.deflect(lastUser) &&
    !offline.guard(lastUser) && !offline.isGreeting(lastUser) && !slotsChanged(prevSlots, slots)
    ? offline.notUnderstood(lastUser) : null;
  if (puzzled) {
    slots._lastQuestion = 'adults';
    return {
      open_lead_form: false, reply_he: puzzled, model_used: false,
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
      reply_he: 'היי! אני עוזר למצוא חופשת סקי של פינגווין שבאמת פנויה.\n' +
        'כדי להתחיל — כמה תהיו בסך הכל, ונוסעים גם ילדים? אדייק לפי זה.',
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
  let cards = presentCards(result, slots, more ? seenBefore : null);
  let exhausted = false;
  if (more && !cards.length) {
    cards = presentCards(result, slots);      // start over rather than show nothing
    exhausted = true;
  }
  slots._shown = [...seenBefore, ...cards.map(c => c.hotel + '|' + c.date)].slice(-30);
  // Remember the cheapest band actually put in front of the customer, so that
  // "יקר לי" on the next turn can be answered with something genuinely cheaper
  // rather than a reshuffle of the same prices.
  if (cards.length) {
    slots.shown_price_min = Math.min(...cards.map(c => (c.price_range || '').length));
  }
  slots.price_objection = false;   // handled this turn; do not stick

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
    freshNotes = freshNotes.filter(n => before.has(n));
  }
  const sayingSlots = { ...slots, notes_from_customer: freshNotes, _notes_said: [] };

  // The off-commitment explanation is deterministic and printed verbatim: asked
  // for Italy, the model rewrote the paragraph in its own words and the reason
  // — limited flight and hotel places, and that a rep can check other dates —
  // vanished from the reply.
  const offCommLine = offline.offCommitmentLine(result, slots);
  // What the search had to widen — a different month, a different country, two
  // rooms instead of one — is the most important sentence in the reply, and the
  // model kept paraphrasing it into nothing. Asked for December, shown January,
  // and not a word about the gap: three separate audit rounds.
  const widened = offline.relaxationLines(result);
  // ...but said once. A customer who has already read "לא מצאתי בדיוק בדצמבר,
  // אז הרחבתי לינואר" does not need it again on the next turn; they know.
  const saidFixed = new Set(prevSlots._fixed_said || []);
  const fixed = [offCommLine, ...widened].filter(Boolean).filter(l => !saidFixed.has(l));
  slots._fixed_said = [...saidFixed, ...[offCommLine, ...widened].filter(Boolean)].slice(-8);
  if (fixed.length) preamble = [preamble, ...fixed].filter(Boolean).join(String.fromCharCode(10));

  const templated = offline.phrase(result, sayingSlots, cards) ||
    (cards.length ? 'הנה מה שנראה פנוי אצלנו — הנציג יאשר סופית:' :
      offline.noMatchAnswer());
  // The model rewrites that in natural Hebrew (Tomer, 24/08). It only ever
  // sees the offers the deterministic filter already chose, so it cannot
  // invent one; and anything it returns must survive validate() or we ship
  // the template unchanged. The template is therefore the floor, never a
  // regression.
  const lastReply = [...messages].reverse().find(m => m.role === 'assistant');
  // A direct answer to a direct question — a price rule, a booking decision, a
  // refusal — is complete on its own. Letting the model add three sentences of
  // card facts under it turned "ניקח את הראשון" into a lecture.
  const answeredOnly = !!faqHit && !slotsChanged(prevSlots, slots);
  const intro = (deflection || answeredOnly) ? templated : await phraseWithModel({
    slots: sayingSlots, cards, result, fallback: templated,
    lastReply: lastReply ? lastReply.content : null,
    answered: preamble || null,
  });
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
  if (slots.month == null) gapChips.push('דצמבר', 'ינואר', 'פברואר', 'מרץ');
  if (slots.departure_airport == null) gapChips.push('טיסה מנתב"ג', 'טיסה מחיפה');
  if (slots.country == null && slots.destination == null) {
    const ex = slots.excluded_countries || [];
    const byHe = { 'אוסטריה': 'austria', 'צרפת': 'france', 'אנדורה': 'andorra', 'בולגריה': 'bulgaria' };
    for (const [he, code] of Object.entries(byHe)) if (!ex.includes(code)) gapChips.push(he);
  }

  // The closing line goes last of all — after the question, so the reply ends
  // by moving forward rather than by asking. Skipped when the wording already
  // contains it, which happens when the model followed the same guidance.
  // nothing new left to show
  if (exhausted) {
    preamble = [preamble, 'אלה כל האפשרויות שמצאתי בתנאים האלה. אם נשנה תאריך או יעד — ייפתחו נוספות.']
      .filter(Boolean).join(String.fromCharCode(10));
  }

  const replyText = (() => {
    const parts = [preamble, intro, tailQuestion].filter(Boolean);
    // Once per conversation. Ending every turn with the same sentence is how
    // a bot sounds like a bot; a person says it when it is worth saying.
    // two-room splits are offers too — they render as their own cards in
    // the widget, so the closing must not tell the customer we found nothing
    const anyOffer = cards.length || (result.two_room_splits || []).length;
    // "אם אחת מהן" above a single card reads as a machine that did not look at
    // its own answer.
    const oneOnly = cards.length === 1 && !(result.two_room_splits || []).length;
    const close = closedBefore ? ''
      : guidance.closing(anyOffer ? (oneOnly ? 'with_one_offer' : 'with_offers') : 'no_offers');
    const said = parts.join(String.fromCharCode(10));
    if (close && !said.includes(close.slice(0, 18))) { parts.push(close); slots._closed = true; }
    // A last trim on the assembled reply. phrase() caps its own lines, but a
    // FAQ answer, a question and a closing arrive from here — a kosher-keeping
    // family asking about camps got six paragraphs. The softer lines go first.
    const SOFT = /נפתחות|לקחתי בחשבון|אני כאן אם תרצו/;
    let all = parts.join(String.fromCharCode(10)).split(String.fromCharCode(10)).filter(Boolean);
    while (all.length > 5) {
      const drop = all.findIndex(l => SOFT.test(l));
      if (drop < 0) break;
      all.splice(drop, 1);
    }
    // A sentence the customer already read, above the same offers, is noise
    // the second time. It was the loudest thing about a long conversation:
    // five turns in a row opening with the same two lines.
    const cardKey = cards.map(c => c.hotel + '|' + c.date).join(',');
    const sameOffers = !!cardKey && cardKey === (prevSlots._lastCards || null);
    const alreadySaid = new Set(sameOffers ? (prevSlots._lastLines || []) : []);
    // A red-rule answer ("המחיר המדויק…") is the same sentence every time by
    // design. Dropping it as a repeat turned the third "תגיד לי מחיר" into a
    // line about cards — evasion where a rule was meant to speak.
    const mustKeep = new Set([
      ...(deflection || '').split(String.fromCharCode(10)).filter(Boolean),
      ...(faqSuppressed ? [PER_CARD_POINTER[faqHit.id]].filter(Boolean) : []),
    ]);
    if (alreadySaid.size) {
      const fresh = all.filter(l => !alreadySaid.has(l) || mustKeep.has(l));
      // Everything we were about to say has already been said, above these same
      // offers. Saying it all again is worse than saying one true short thing.
      all = fresh.length ? fresh
        : ['הפרטים המלאים של כל הצעה מופיעים על הכרטיס שלה. תגידו לי מה חשוב לכם ואדייק.'];
    }
    slots._lastCards = cardKey;
    // The memory accumulates while the offers stand still: suppressing a line
    // for one turn only to say it again on the next is the same repetition,
    // one turn later.
    slots._lastLines = [...new Set([...alreadySaid, ...all])].slice(-24);
    return all.join(String.fromCharCode(10));
  })();

  // One line per turn. Every defect in this project was found by a person
  // reading a reply; this is what makes that possible without waiting for a
  // screenshot.
  if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
  chatLog.logTurn({
    conversationId: body.conversationId || slots._cid,
    userText: lastUser, reply: replyText, cards, result, slots,
    modelUsed, ms: Date.now() - startedAt,
    // a turn we could not use is a bug report written by a real customer
    notUnderstood: offTopic && !deflection && !faqHit,
    answeredBy: guarded ? 'guard' : deflection ? 'deflect'
      : faqHit ? (faqHit.routed ? 'router' : 'faq') : null,
  });

  // A request to be called back opens the form, on the offer they were looking
  // at if there is one. Telling someone where to find a button is not service.
  const askForDetails = offline.wantsCallback(lastUser);

  return {
    open_lead_form: askForDetails,
    // the remaining parameters are offered as chips, not asked as a question —
    // a customer looking at three real offers should not also face an interview
    reply_he: replyText,
    model_used: modelUsed,
    pending_parameter: pendingQuestion ? pendingQuestion.key : null,
    slots, cards,
    two_room_splits: (result.two_room_splits || []).map(sp => ({ ...sp, hotel: displayHotel(sp.hotel) })),
    notes: result.notes, relaxed: result.relaxed,
    chips: cards.length ? [...gapChips, ...CHIP_LABELS] : gapChips,
    chip_to_pref: CHIP_TO_PREF,
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!applyCors(req, res)) { res.writeHead(403); res.end('origin not allowed'); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) { req.destroy(); return; } }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { }
      let out;
      try { out = await handleChat(body); }
      catch (e) {
        console.error('chat error:', e.message, e.detail || '');
        out = { reply_he: e.friendly || FALLBACK_HE, slots: body.slots || EMPTY_SLOTS, cards: [], chips: [] };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/lead') {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 20_000) { req.destroy(); return; } }
      let lead = {};
      try { lead = JSON.parse(raw || '{}'); } catch { }
      if (!lead.name || !lead.phone) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false })); return;
      }
      // leads contain PII (name+phone) — stored server-side only, dir is gitignored
      const dir = path.join(ROOT, 'server-data');
      fs.mkdirSync(dir, { recursive: true });
      const leadsPath = path.join(dir, 'leads.json');
      let leads = [];
      try { leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8')); } catch { }
      leads.push({ ...lead, at: new Date().toISOString() });
      fs.writeFileSync(leadsPath, JSON.stringify(leads, null, 1));
      // a lead with no hotel is legitimate: "תחזרו אליי" before choosing one
      const ctx = lead.context || {};
      console.log(`lead: ${lead.name} (${lead.phone}) → ${ctx.hotel || 'ללא הצעה ספציפית'} ${ctx.date || ''}`.trim());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // static
    let file = url.pathname === '/' ? '/public/demo.html'
      : url.pathname === '/pingwin-bot.js' ? '/public/pingwin-bot.js'
        : '/public' + url.pathname;
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(fs.readFileSync(full));
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`pingwin bot server → http://localhost:${PORT}`));
}
module.exports = { handleChat, server, requiredMissing };
