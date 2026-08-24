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
  price_objection: false, shown_price_min: null, month_part: null,
  off_commitment_destination: null, off_commitment_country: null, out_of_season: false,
  no_saturday_flights: null, nights_wanted: null, unverifiable: [],
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
    price_objection: !!slots.price_objection,
    shown_price_min: slots.shown_price_min || null,
    off_commitment_destination: slots.off_commitment_destination || null,
    off_commitment_country: slots.off_commitment_country || null,
    no_saturday_flights: !!slots.no_saturday_flights,
    nights_wanted: slots.nights_wanted || null,
    out_of_season: !!slots.out_of_season,
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

async function phraseWithModel({ slots, cards, result, fallback }) {
  if (aiMode() === 'offline') return fallback;
  // Nothing to phrase: the turn is a question or a no-match, and the template
  // for those is careful, short and already right. Paying to reword it would
  // buy nothing and risks softening a "no" that must stay clear.
  if (!cards.length) return fallback;
  try {
    const payload = phrasing.buildPayload({ slots, cards, result, fallback });
    const system = phrasing.PHRASE_PROMPT + guidance.forAnswering(cards[0] && cards[0].country);
    // 900, not 320: on a reasoning model max_completion_tokens covers the
    // thinking too, and a 320 cap produced an empty reply that then failed
    // validation and silently fell back to the template on every turn.
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: payload }], maxTokens: 900, json: false })
      : await callClaude({ system, messages: [{ role: 'user', content: payload }], maxTokens: 900 });
    const text = String(raw || '').trim();
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

function presentCards(result, slots) {
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
    seenExact.add(k); uniq.push(c);
  }
  const seen = new Set(), diverse = [];
  for (const c of uniq) if (!seen.has(c.hotel)) { diverse.push(c); seen.add(c.hotel); }
  for (const c of uniq) if (!diverse.includes(c)) diverse.push(c);
  return diverse.slice(0, 3).map((c, i) => ({
    index: i,
    hotel: c.hotel, resort: c.resort, country: c.country,
    country_he: { austria: 'אוסטריה', france: 'צרפת', andorra: 'אנדורה', bulgaria: 'בולגריה' }[c.country] || c.country,
    date: c.date, date_label: c.date_label, nights: c.nights,
    room: c.room, occ: c.occ_effective, occ_composition_he: c.occ_composition_he,
    desc_he: c.desc_he, lift_he: c.lift_he, tags: c.tags, image: c.image,
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
    booking_url: buildBookingUrl({
      siteID: engine.hotelInfo(c.hotel).siteID, date: c.date,
      room: c.room, adults: slots.adults, children_ages: slots.children_ages,
    }),
  }));
}

/* ---------- chat orchestration ---------- */
async function handleChat(body) {
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
        const merged = { ...slots, ...parsed.slots };
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
  const faqHit = offline.faq(lastUser);
  const offTopic = lastUser && !slotsChanged(prevSlots, slots) && !modelUsed &&
    !faqHit && !offline.deflect(lastUser) &&
    /\?|איך|מה |למה|מי /.test(lastUser) &&
    !/סקי|חופש|מלון|טיסה|קייטנ|יעד|תאריך|חודש|ילד|נוסע|מחיר|חדר|שלג|פינגווין|לילות|כלול|הבדל|להזמין|הזמנה|ביקשתי|מסלול|ספא|גלישה|מדריך|העבר|יעדים|אופצי|המלצ/.test(lastUser);

  // ---- step 3: what to ask next (same logic whichever layer filled slots) ----
  // Only BLOCKING gaps hold results back. The rest (departure airport,
  // destination) are gathered after the customer has seen something concrete —
  // being interviewed before any offer is what makes a bot feel like a form.
  let pendingQuestion = null;
  if (!replyIfNotReady) {
    let q = offline.nextQuestion(slots, prevSlots._lastQuestion || null);
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
  const deflection = faqHit ? null
    : (slotsChanged(prevSlots, slots) ? null : offline.deflect(lastUser));
  // deflect() guards the red rules (no customer names, no exact prices) so it
  // wins; the FAQ answer follows only when there is nothing to guard against.
  // Unlike deflect(), the FAQ answers even when the same message also filled
  // slots — "2 מבוגרים בפברואר, יש אוכל כשר?" deserves an answer and offers.
  // Topics the CARDS answer per hotel. Printing the general FAQ paragraph
  // above three cards that each state their own spa terms is noise, and worse,
  // it reads as a hedge right before the specific answer.
  const PER_CARD_FAQ = new Set(['spa', 'wifi']);
  const faqSuppressed = faqHit && PER_CARD_FAQ.has(faqHit.id);
  const preamble = [
    deflection,
    !deflection && faqHit && !faqSuppressed ? faqHit.he : null,
    offTopic && !deflection ? OFF_TOPIC_HE : null,
    slots.out_of_season ? SEASON_HE : null,
  ].filter(Boolean).join('\n');

  // ALWAYS search. The question, if there is one, rides along after the offers
  // rather than standing in front of them. A customer is never held at the
  // door waiting to supply a number (Tomer, 24/08: "שלא יהיה חייב להשיג פרטים
  // ויתקע"), and the same question is never asked twice.
  const askedBefore = new Set(prevSlots._asked || []);
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
  const result = engine.search(toSearchSlots(slots));
  const cards = presentCards(result, slots);
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
  const templated = offline.phrase(result, slots, cards) ||
    (cards.length ? 'הנה מה שנראה פנוי אצלנו — הנציג יאשר סופית:' :
      offline.noMatchAnswer());
  // The model rewrites that in natural Hebrew (Tomer, 24/08). It only ever
  // sees the offers the deterministic filter already chose, so it cannot
  // invent one; and anything it returns must survive validate() or we ship
  // the template unchanged. The template is therefore the floor, never a
  // regression.
  const intro = await phraseWithModel({ slots, cards, result, fallback: templated });

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

  return {
    // the remaining parameters are offered as chips, not asked as a question —
    // a customer looking at three real offers should not also face an interview
    // The closing line goes last of all — after the question, so the reply ends
    // by moving forward rather than by asking. Skipped when the wording already
    // contains it, which happens when the model followed the same guidance.
    reply_he: (() => {
      const parts = [preamble, intro, tailQuestion].filter(Boolean);
      const close = guidance.closing(cards.length ? 'with_offers' : 'no_offers');
      const said = parts.join(String.fromCharCode(10));
      if (close && !said.includes(close.slice(0, 18))) parts.push(close);
      return parts.join(String.fromCharCode(10));
    })(),
    model_used: modelUsed,
    pending_parameter: pendingQuestion ? pendingQuestion.key : null,
    slots, cards,
    two_room_splits: result.two_room_splits,
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
      console.log(`lead: ${lead.name} (${lead.phone}) → ${lead.context && lead.context.hotel} ${lead.context && lead.context.date}`);
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
