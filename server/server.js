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
const limits = require('./limits.js');
const recommend = require('./recommend.js');

loadEnv();
const has = k => process.env[k] && !process.env[k].includes('xxxx');
// Provider is chosen by whichever key is present. With none, the bot still
// works fully on the deterministic Hebrew layer — free, no account.
function aiMode() {
  // over the daily budget the bot keeps answering — on the free Hebrew layer
  if (limits.budgetExceeded(openaiSpend.usd)) return 'offline';
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

// Three offers read faster as a ladder: which is the cheapest, which is the
// premium. Derived only from the symbolic price band, only when the bands
// actually differ — three identical ₪₪₪ cards get no labels rather than
// invented ones. Never "מומלץ": that word belongs to the hotel data.
function tierLabel(card, cards) {
  const rank = p => (String(p || '').match(/₪/g) || []).length;
  const ranks = cards.map(c => rank(c.price_range));
  const lo = Math.min(...ranks), hi = Math.max(...ranks);
  if (cards.length < 2 || lo === hi) return null;
  const r = rank(card.price_range);
  if (r === lo && ranks.filter(x => x === lo).length === 1) return 'המשתלם ביותר';
  if (r === hi && ranks.filter(x => x === hi).length === 1) return 'הפרימיום';
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
      ? await callOpenAI({ system, messages: [{ role: 'user', content: payload }], maxTokens: 1200, json: false,
          model: process.env.OPENAI_PHRASE_MODEL || undefined })
      : await callClaude({ system, messages: [{ role: 'user', content: payload }], maxTokens: 1200 });
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
    booking_url: buildBookingUrl(engine.hotelInfo(c.hotel)),
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
  const body = JSON.stringify(record);
  const headers = { 'content-type': 'application/json', 'x-lead-id': record.id };
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
  // faqMulti: each question segment matched on its own, so a message that
  // asks two known things gets both answers with no model involved
  let faqHit = offline.faqMulti(lastUser);
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
  // "יש חניה במלון? ומה עם ביטוח?" — the regex caught the insurance and the
  // parking question fell on the floor. When the message plainly asks more
  // than one thing, the router runs anyway and the second answer rides along.
  const multiPart = (lastUser.match(/\?/g) || []).length >= 2 ||
    /ומה (עם|לגבי|בקשר)|וגם מה|ושאלה נוספת|ועוד שאלה/.test(lastUser);
  if (faqHit && !faqHit.routed && multiPart && (faqHit.all || []).length < 2 &&
      !offline.guard(lastUser)) {
    const routed = await routeToAnswer(lastUser);
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
    const replyText = socialPrefix + faqHit.he +
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
  // the human word before business: a returning customer, a compliment.
  // Correct offers with no acknowledgement read as a machine that did not
  // hear the nice thing that was just said to it. But one apology is enough —
  // when the complaint answer opens with its own, the social line yields.
  let social = offline.socialLine(lastUser);
  if (social && faqHit && /מצטער/.test(social) && /מצטער/.test(faqHit.he)) social = null;
  // "בת 3 ו-10 חודשים" — say how the age is reckoned, once
  const ageLine = slots.age_boundary != null && prevSlots.age_boundary == null ? guidance.languageText('age_boundary') : null;
  let preamble = [
    social,
    ageLine,
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
  const partyKnown = slots.adults != null ||
    (slots.children_ages || []).length > 0 || slots.children_count != null;
  const whenKnown = slots.month != null || slots.exact_day != null || !!slots.flexible_dates;
  const knowsEnough = partyKnown && whenKnown;
  // an explicit "show me" overrides the gate — they asked to see, not to be
  // interviewed; so does a hotel or resort named outright, and "יש עוד?"
  const wantsToSee = more || offline.wantsMore(lastUser) ||
    /תראה|תראו|מה יש לכם|הראה לי|אפשר לראות|שלח לי אפשרויות|מה האפשרויות/.test(lastUser) ||
    // "מה יותר משתלם?" and "יש משהו עד 3500?" are requests to SEE, answered
    // with a list; holding them back to ask the month reads as stonewalling
    /משתלם|הכי זול|עד \d{3,5}|יש משהו|יש לכם|מחירים|תאריכים/.test(lastUser) ||
    !!slots.hotel || !!slots.destination;
  // and the gate opens by itself after MAX_QUESTIONS, so nobody is ever stuck
  // at the door (the rule that produced the always-search design)
  const askedEnough = questionsAsked >= MAX_QUESTIONS;
  const holdingForDetails = !knowsEnough && !wantsToSee && !askedEnough &&
    !!tailQuestion && cards.length > 0;
  if (holdingForDetails) cards = [];
  // Holding the offers back must not swallow the off-topic line: "תן לי מתכון
  // לעוגה" used to get three hotels and a redirect, and would now get only
  // "כמה תהיו?" — as if a cake recipe were a step in booking a holiday.
  const understoodSomething = slotsChanged(prevSlots, slots) || !!faqHit || !!deflection ||
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
    ? 'אנחנו מוכרים כרגע את עונת חורף 2026/27 — דצמבר 2026 עד סוף מרץ 2027.' : null;
  // "בבולגריה יש אפשרויות פנויות" + "בבולגריה אין יציאות בדצמבר" in the same
  // reply is a contradiction the customer has to untangle. When both fire, the
  // comparison keeps only the half the month line does not carry.
  if (cmpLine && widened.some(l => /אין לי יציאות פנויות/.test(l))) {
    cmpLine = /לא מצאתי בתנאים האלה/.test(cmpLine)
      ? cmpLine.replace(/^.*?;\s*/, 'הצגתי משני היעדים שציינתם; ')
      : 'הצגתי הצעות משני היעדים שציינתם, כדי שתוכלו להשוות.';
  }
  const fixedRaw = holdingForDetails
    ? [yearLine]                       // "הצגתי משני היעדים" over zero cards is a lie
    : [yearLine, offCommLine, cmpLine, monthsLine, ...widened];
  const fixed = fixedRaw.filter(Boolean).filter(l => !saidFixed.has(l));
  slots._fixed_said = [...saidFixed, ...fixedRaw.filter(Boolean)].slice(-8);
  if (fixed.length) preamble = [preamble, ...fixed].filter(Boolean).join(String.fromCharCode(10));

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
  let intro;
  try {
    intro = (deflection || answeredOnly || holdingForDetails) ? templated : await phraseWithModel({
      slots: sayingSlots, cards, result, fallback: templated,
      lastReply: lastReply ? lastReply.content : null,
      answered: preamble || null,
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
    const byHe = { 'אוסטריה': 'austria', 'צרפת': 'france', 'אנדורה': 'andorra', 'בולגריה': 'bulgaria' };
    for (const [he, code] of Object.entries(byHe)) if (!ex.includes(code)) gapChips.push(he);
  }

  // When the bot ASKS something, the chips must answer that question and
  // nothing else. Tomer, 26/08: under "באיזה חודש תרצו לצאת?" the widget also
  // offered "טיסה מנתב\"ג" and "טיסה מחיפה" — buttons that answer a question
  // nobody asked, next to a question with no month buttons for December or
  // March. Chips are the answer sheet for the question on screen.
  const chipsForQuestion = (text) => {
    const q = String(text || '');
    if (/כמה תהיו|כמה נוסעים|כמה אתם|בסך הכול|בסך הכל/.test(q)) {
      return ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'];
    }
    if (/גילאים|בן כמה|בת כמה|נוסעים גם ילדים|יש ילדים/.test(q)) {
      return ['בלי ילדים', 'ילד אחד', 'שני ילדים', 'שלושה ילדים'];
    }
    if (/חודש|מתי תרצו|מתי לצאת|באיזה תאריך|אילו תאריכים/.test(q)) {
      return ['חנוכה', 'דצמבר', 'ינואר', 'פברואר', 'מרץ', 'פורים', 'גמיש'];
    }
    if (/קייטנ/.test(q)) return ['כן, קייטנה בעברית', 'בלי קייטנה'];
    if (/לטוס|נתב"ג|נתב״ג|שדה התעופה/.test(q)) return ['טיסה מנתב"ג', 'טיסה מחיפה'];
    if (/יעד שמושך|איזו מדינה|אוסטריה, צרפת/.test(q)) {
      const ex = slots.excluded_countries || [];
      const byHe = { 'אוסטריה': 'austria', 'צרפת': 'france', 'אנדורה': 'andorra', 'בולגריה': 'bulgaria' };
      return Object.entries(byHe).filter(([, c]) => !ex.includes(c)).map(([he]) => he);
    }
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
        .filter(n => /תקציב לאדם/.test(n) ? true : !mentions(n));
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
      if (slots.needs_hebrew_kids_club && !/קייטנ|קבוצת 4-6/.test(saidSoFar)) {
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
      const lo = Math.min(...bands), hi = Math.max(...bands);
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
    const priceLine = cards.length && MONEY_Q.test(lastUser) &&
      !/מסך ההזמנה|המחיר המדויק/.test([preamble, intro].filter(Boolean).join(' '))
      ? 'טווח המחיר מסומן על כל הצעה, והמחיר המדויק לתאריך ולחדר שלכם מופיע במסך ההזמנה — נציג מאשר אותו סופית.'
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
    if (close && !said.includes(close.slice(0, 18))) { parts.push(close); slots._closed = true; }
    // the widget prints the closing UNDER the offers, where the buttons it
    // refers to are; above three cards it pushed them below the fold
    if (close && anyOffer) slots._after_cards = close;
    // A last trim on the assembled reply. phrase() caps its own lines, but a
    // FAQ answer, a question and a closing arrive from here — a kosher-keeping
    // family asking about camps got six paragraphs. The softer lines go first.
    // "לקחתי בחשבון" is the customer's proof of being heard — trimming it was
    // the single commonest complaint in the golden set. It is dropped only
    // after every coaching line is gone and the reply is still over the cap.
    const SOFT1 = /נפתחות|אני כאן אם תרצו/;
    const SOFT2 = /לקחתי בחשבון|ציינתם .+ או|סיננתי |הצגתי רק שבועות|בטווח המחיר הנמוך מבין|טווח המחיר מסומן/;
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
    notUnderstood: offTopic && !deflection && !faqHit,
    answeredBy: guarded ? 'guard' : deflection ? 'deflect'
      : faqHit ? (faqHit.routed ? 'router' : 'faq') : null,
  });

  // the question this turn actually ended on: the blocking one if we held the
  // offers back, otherwise the one that rode along under them
  const askedNow = replyIfNotReady || tailQuestion || null;
  const focusedChips = cards.length ? null : chipsForQuestion(askedNow);

  // A request to be called back opens the form, on the offer they were looking
  // at if there is one. Telling someone where to find a button is not service.
  slots._lastFaqId = faqHit ? faqHit.id : null;
  slots._lastGuard = guarded || null;
  const askForDetails = offline.wantsCallback(lastUser) || lostNudge || exhaustedNudge;

  return {
    open_lead_form: askForDetails,
    // the remaining parameters are offered as chips, not asked as a question —
    // a customer looking at three real offers should not also face an interview
    reply_he: replyText,
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
      answered_by: guarded ? 'guard' : deflection ? 'deflect' : faqHit ? (faqHit.routed ? 'router' : 'faq') : null,
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
async function readJson(req, cap) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > cap) { req.destroy(); return null; } }
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
      return json(res, 200, { ok: true, mode: aiMode(), version: BOT_VERSION });
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
        },
      }, { 'cache-control': 'no-store' });
    }
    const ip = limits.clientIp(req);
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const wait = limits.checkRate('chat', ip);
      if (wait) return json(res, 429, { reply_he: SLOW_DOWN_HE(), slots: {}, cards: [], chips: [], retry_after: wait }, { 'retry-after': String(wait) });
      const body = await readJson(req, 100_000);
      if (!body) return;
      const slots = { ...(body.slots || {}) };
      if (limits.turnstileOn() && !limits.stampValid(slots)) {
        const ok = await limits.verifyTurnstile(body.turnstile, ip);
        if (!ok) return json(res, 403, { reply_he: VERIFY_HE(), slots: body.slots || {}, cards: [], chips: [], verify: true });
        if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
        slots._vt = limits.stamp(slots._cid);
      }
      if (limits.turnsExceeded(slots)) {
        return json(res, 200, { reply_he: TOO_LONG_HE(), slots, cards: [], chips: [], open_lead_form: true });
      }
      body.slots = slots;
      let out;
      try {
        out = await limits.withTimeout(handleChat(body), CHAT_TIMEOUT_MS, () => {
          console.error('chat timeout after', CHAT_TIMEOUT_MS, 'ms');
          return { reply_he: FALLBACK_HE(), slots, cards: [], chips: [], timeout: true };
        });
      } catch (e) {
        console.error('chat error:', e.message, e.detail || '');
        out = { reply_he: e.friendly || FALLBACK_HE(), slots, cards: [], chips: [] };
      }
      // the stamp and the turn counter must survive whatever handleChat did to the slots
      out.slots = { ...(out.slots || {}), _turns: slots._turns, ...(slots._vt ? { _vt: slots._vt, _cid: slots._cid } : {}) };
      return json(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/lead') {
      const wait = limits.checkRate('lead', ip);
      if (wait) return json(res, 429, { ok: false, retry_after: wait }, { 'retry-after': String(wait) });
      const lead = await readJson(req, 20_000);
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
      const ctx = lead.context || {};
      const record = {
        id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: new Date().toISOString(),
        name: String(lead.name).slice(0, 80), phone: String(lead.phone).slice(0, 30),
        kind: String(ctx.kind || 'customer').slice(0, 30),
        context: ctx,
      };
      fs.appendFileSync(path.join(dir, 'leads.jsonl'), JSON.stringify(record) + '\n');
      // no PII on stdout — only that a lead landed and what kind
      console.log(`lead ${record.id} [${record.kind}] → ${ctx.hotel || 'ללא הצעה ספציפית'} ${ctx.date || ''}`.trim());
      notifyLead(record).catch(e => console.error('lead notify failed:', e.message));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: record.id }));
      return;
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
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(PORT, () => console.log(`pingwin bot server v${BOT_VERSION} [${aiMode()}] → http://localhost:${PORT}`));
}
module.exports = { handleChat, server, requiredMissing };
