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
const { buildBookingUrl, deepLink, pageFor, addNights, pansionCodes, PANSION_HE } = require('../config/booking-url.js');
const siteRooms = require('./site-rooms.js');
const catalogue = require('./catalogue.js');
const inventory = require('./inventory.js');
const { resortHe } = require('../data/resort-names.js');
const limits = require('./limits.js');
const leadMail = require('./lead-mail.js');
const crmLead = require('./crm-lead.js');
const recommend = require('./recommend.js');
const characterize = require('./characterize.js');
const compose = require('./compose.js');
const translate = require('./translate.js');

loadEnv();
const has = k => process.env[k] && !process.env[k].includes('xxxx');
// Provider is chosen by whichever key is present. With none, the bot still
// works fully on the deterministic Hebrew layer — free, no account.
function aiMode() {
  // AI_MODE=offline: the deterministic Hebrew layer only, whatever keys .env
  // holds. tests/test-rep-mode.js has set it since 06/09 and nothing read it —
  // on Tomer's machine, where .env has a real key, the test ran against the
  // live model and failed on its own randomness (07/09)
  if (process.env.AI_MODE === 'offline') return 'offline';
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
// How many offers a turn puts on the screen. Two (Tomer, 06/09): "זה או זה",
// not a comparison of three — and two cards fit a phone screen. The search
// still picks three; the third travels as `spare_cards`, and the widget
// reveals it on one tap ("עוד אפשרות") without a round trip. CARDS_DEFAULT=3
// restores the old layout in one line.
const CARDS_DEFAULT = Math.max(1, Math.min(3, +(process.env.CARDS_DEFAULT || 2)));
// see the note beside the phrasing call: this cap covers the model's thinking
const PHRASE_TOKENS = +(process.env.PHRASE_MAX_TOKENS || 2200);
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
    // a question about two places over a running search is answered in words;
    // the offers on screen stay (13/09)
    compare: slots._compare_q ? null : (slots.compare || null),
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
/* The resorts the conversation is about: the offers on screen first, then a
   named resort, then every resort of a named country. Latin keys as in
   resorts.json. */
// the display names of the offers on the customer's screen: the last turn
// that drew cards, or — for a widget that revealed a spare — the tail of
// everything shown
function onScreenHotels(prevSlots) {
  if ((prevSlots._on_screen || []).length) return prevSlots._on_screen.slice(0, 3);
  return [...new Set((prevSlots._shown || []).map(x => String(x).split('|')[0]))].slice(-3);
}

function resortsInPlay(slots, prevSlots) {
  const out = new Set();
  const keys = (prevSlots._on_screen || []).length
    ? prevSlots._on_screen : (prevSlots._shown || []);
  for (const key of keys) {
    const info = engine.hotelInfo(String(key).split('|')[0]);
    if (info && info.resort) out.add(info.resort);
  }
  if (!out.size && slots.destination) out.add(slots.destination);
  if (!out.size && slots.country && slots.country !== 'any') {
    for (const h of Object.values(engine.resorts.hotels || {})) if (h.country === slots.country && h.resort) out.add(h.resort);
  }
  return [...out];
}

/* transfer_time / flight_route, cut down to the places in play. The FAQ text
   is Tomer's; this only picks the sentence about their resort out of it. */
function scopeTransferAnswer(faqHit, lastUser, slots, prevSlots) {
  const ids = new Set([faqHit.id, ...((faqHit.all || []).map(a => a.id))]);
  if (!ids.has('transfer_time') && !ids.has('flight_route') && !ids.has('flight_duration')) return faqHit;
  const resorts = resortsInPlay(slots, prevSlots);
  if (!resorts.length) return faqHit;
  const countries = [...new Set(resorts.map(r => {
    const h = Object.values(engine.resorts.hotels || {}).find(x => x.resort === r);
    return h && h.country;
  }).filter(Boolean))];
  const names = resorts.map(r => resortHe(r)).filter(n => n && /[א-ת]/.test(n));
  const pick = (text, keys, prefix) => {
    // "…: A — …; B — …; C — …. tail" → the segments whose start names a key
    const m = /^(.*?:)\s*([\s\S]*?)(?:\.\s*(?:תגידו[^.]*\.?)?)?\s*$/.exec(String(text || ''));
    if (!m) return null;
    const segs = m[2].split(/;\s*/).map(x => x.trim()).filter(Boolean);
    const hit = segs.filter(sg => keys.some(k => sg.startsWith(prefix + k)));
    return hit.length ? hit : null;
  };
  const parts = [];
  // "איך מגיעים למלון?" hit the flights answer only; the way from the airport
  // is the transfer line, so it joins when the question mentions the hotel
  const wantsTransfer = ids.has('transfer_time') || /למלון|לאתר|מהשדה|העברה|הסעה/.test(lastUser);
  if (wantsTransfer) {
    const full = (faqHit.all || []).find(a => a.id === 'transfer_time') ||
      (ids.has('transfer_time') ? faqHit : null) ||
      (() => { const e = offline.faqEntries().find(x => x.id === 'transfer_time'); return e ? { he: e.answer_he } : null; })();
    if (!full) return faqHit;
    const intro = String(full.he).split('המרחקים משדה היעד')[0].trim();
    const hit = pick(full.he, names, '');
    if (hit) parts.push((intro ? intro + ' ' : '') + hit.join('; ') + '. ההעברה משדה התעופה למלון ובחזרה כלולה במחיר.');
  }
  if (ids.has('flight_route') && countries.length) {
    const full = (faqHit.all || []).find(a => a.id === 'flight_route') || faqHit;
    const heNames = countries.map(c => labels.country(c)).filter(Boolean);
    const hit = pick(full.he, heNames, 'ל');
    const fIntro = String(full.he).split(':')[0].trim();
    if (hit) parts.push((fIntro ? fIntro + ': ' : 'הטיסה: ') + hit.join('; ') + '.');
  }
  if (ids.has('flight_duration') && countries.length) {
    const full = (faqHit.all || []).find(a => a.id === 'flight_duration') || faqHit;
    const heNames = countries.map(c => labels.country(c)).filter(Boolean);
    const hit = pick(full.he, heNames, 'ל');
    const fIntro = String(full.he).split(':')[0].trim();
    if (hit) parts.push((fIntro ? fIntro + ': ' : 'משך הטיסה: ') + hit.map(h => h.split('. ')[0]).join('; ') + '. את השעות המדויקות לתאריך שלכם נציג ימסור.');
  }
  if (!parts.length) return faqHit;
  return { ...faqHit, he: parts.join(String.fromCharCode(10)), scoped: true };
}

function slotsChanged(before, after) {
  const keys = ['adults', 'children_ages', 'children_count', 'no_children', 'month',
    'flexible_dates', 'country', 'destination', 'departure_airport', 'needs_hebrew_kids_club',
    'excluded_countries', 'no_saturday_flights', 'nights_wanted',
    // naming a hotel or a chain IS the customer telling us something. Without
    // these, "מה עם קלאב דו סוליי?" changed nothing by this measure and the
    // reply came back "אני כאן בעיקר להתאמת חופשות סקי" over three Club Soleil
    // cards (Tomer, 27/08)
    'hotel', 'hotel_group'];
  // undefined and null mean the same thing here: "we do not know". Comparing
  // them raw made every turn look like a change the moment a slot was
  // initialised to null each turn, and the whole off-topic guard stopped firing.
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  for (const k of keys) if (!same(before[k], after[k])) return true;
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
// A short, current-facts digest of who we're talking to — handed to the
// answer router alongside the question. Without it, a question whose only
// content words are pronouns ("יש להם מסגרת או שהם עם המבוגרים?") gives the
// router nothing to work with, and it has to guess between "organized tour"
// and "teen camp" (persona P22, 03/09: it guessed wrong). Built from slots —
// the facts already distilled from the conversation — rather than resending
// several raw turns: that would cost more per call and risks dragging in a
// topic the conversation has since moved past.
function partyDigest(slots) {
  const bits = [];
  if (slots.adults != null) bits.push(slots.adults + ' מבוגרים');
  const kids = (slots.children_ages || []).slice().sort((a, b) => a - b);
  if (kids.length) bits.push('ילדים/נערים בני ' + kids.join(', '));
  else if (slots.children_count) bits.push(slots.children_count + ' ילדים (גיל לא צויין)');
  if (slots.needs_hebrew_kids_club === true) bits.push('רוצים קייטנה בעברית');
  if (slots.needs_hebrew_kids_club === false) bits.push('בלי קייטנה');
  const dest = slots.destination || (slots.country && slots.country !== 'any' ? slots.country : null);
  if (dest) bits.push('יעד: ' + dest);
  if ((slots.preferences || []).length) bits.push(slots.preferences.slice(0, 4).join(', '));
  if ((slots.notes_from_customer || []).length) bits.push(slots.notes_from_customer.slice(-3).join('; '));
  return bits.length ? ('רקע על הנוסעים: ' + bits.join(' | ')) : '';
}

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
    // Generous on purpose: on a reasoning model this cap covers the THINKING
    // as well as the reply, so a tight budget does not shorten the answer, it
    // truncates it. At 1200 a customer read "…אם זה חשוב לכם, העביר את" and
    // then the offer cards (seen live 31/08). A truncated reply is now caught
    // and thrown away, so the only cost of being generous is tokens on the
    // turns that need them — and the cost of being mean is a half sentence.
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: payload }], maxTokens: PHRASE_TOKENS, json: false,
          model: process.env.OPENAI_PHRASE_MODEL || undefined, deadline })
      : await callClaude({ system, messages: [{ role: 'user', content: payload }], maxTokens: PHRASE_TOKENS, deadline });
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

/* The reply editor (server/compose.js). Runs on turns WITHOUT offer cards —
   knowledge answers, follow-ups, questions — where the stacked lines show
   their seams. Card turns keep phraseWithModel, which already writes their
   intro. Anything the validator rejects ships as the original lines. */
const COMPOSE_TOKENS = +(process.env.COMPOSE_MAX_TOKENS || 1200);
function composeEnabled() {
  const v = String(process.env.REPLY_EDITOR || 'on').toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}
async function composeWithModel({ replyText, lastUser, digest, lastReply, question, deadline, knownNames, knowledge, cardsShown }) {
  const original = String(replyText || '');
  if (aiMode() === 'offline' || !composeEnabled()) return original;
  const lines = original.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean);
  // one line with nothing to merge into it is not worth a model call — and
  // neither is a chip click or a bare "כן"/"4": those turns stay free. A turn
  // with no knowledge answer in it (a preference noted, a question asked)
  // is two short template lines; the seams there are not worth a call either.
  if (lines.length < 2 || original.length < 60) return original;
  if (!knowledge && lines.length < 3) return original;
  const u = String(lastUser || '').trim();
  if (u.split(/\s+/).length < 2 || /^(\d+|כן|לא|בסדר|אוקיי|אוקי|ok|טוב)\s*[.!]?$/i.test(u)) return original;
  if (health.open()) return original;
  health.called('compose');
  try {
    const payload = compose.buildPayload({ userText: lastUser, digest, lastReply, lines, question, cardsShown });
    const system = compose.COMPOSE_PROMPT + guidance.forAnswering(null);
    const raw = aiMode() === 'openai'
      ? await callOpenAI({ system, messages: [{ role: 'user', content: payload }], maxTokens: COMPOSE_TOKENS, json: false,
          model: process.env.OPENAI_PHRASE_MODEL || undefined, deadline })
      : await callClaude({ system, messages: [{ role: 'user', content: payload }], maxTokens: COMPOSE_TOKENS, deadline });
    const text = String(raw || '').trim();
    const verdict = compose.validate(text, { material: original, question, digest, userText: lastUser, knownNames, cardsShown });
    if (!verdict.ok) {
      health.rejected('compose', verdict.why);
      console.error('reply editor rejected (%s): %s', verdict.why, text.slice(0, 160));
      return original;
    }
    health.ok('compose');
    return text;
  } catch (e) {
    health.failed('compose', e);
    console.error('reply editor failed:', e.message);
    return original;
  }
}
// hotel and resort names the editor must not introduce on its own
const KNOWN_NAMES = (() => {
  try {
    const hotels = Object.keys(require('../data/resorts.json').hotels || {}).map(displayHotel);
    return [...new Set([...hotels, ...Object.values(phrasing.RESORT_HE)])].filter(n => n && n.length >= 4);
  } catch (e) { return []; }
})();

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
// "4 כוכבים · 8.5 בבוקינג" — או חצי, או כלום. אף פעם לא ניחוש.
function ratingBadge(info) {
  const bits = [];
  if (info && info.stars != null) bits.push(info.stars + ' כוכבים');
  if (info && info.booking_score != null) bits.push(info.booking_score + ' בבוקינג');
  return bits.length ? bits.join(' · ') : null;
}

/* ---- מתקני מלון, מהדף של המלון (31/08) ----
   "יש בריכה מחוממת?", "יש מקרר בחדר?", "יש חדר כושר בסטראס?" — נענים ממה
   שכתוב בדף המלון ב-pingwin.co.il (data/resorts.json → page_facts, נאסף
   31/08 ללא מחירים). זה הלקח מסאני, בכיוון ההפוך: היא נכשלה על "בריכה
   מחוממת"; אצלנו התשובה היא ציטוט הדף — וכשהדף שותק, אומרים שהדף שותק
   ("לא כתוב בדף של המלון אצלי") ולא שהמציאות ריקה. */
const FACILITY_FIELDS = [
  [/מחוממת/, '_pool_heated', 'בריכה מחוממת'],
  [/בריכה|לשחות/, 'pool_he', 'בריכה'],
  [/ספא|סאונה|ג'קוזי|גקוזי|ג׳קוזי/, 'spa_page_he', 'ספא'],
  [/חדר כושר|מכון כושר/, 'gym_he', 'חדר כושר'],
  [/חדר סקי|לוקר|אחסון ציוד|ייבוש מגפ|מקום למגלשיים/, 'ski_room_he', 'חדר סקי'],
  [/חני(?:ה|יה)|חניון/, 'parking_he', 'חניה'],
  [/וויפיי|ויי?פיי|אינטרנט|wifi/i, 'wifi_page_he', 'אינטרנט'],
  [/מטבחון|מקרר|מיקרוגל|פינת בישול|לבשל/, 'kitchenette_he', 'מטבחון ומקרר'],
  [/חדר משחקים|פינת משחקים/, 'kids_he', 'חדר משחקים'],
  [/מסעדה|חדר אוכל|בר במלון/, 'restaurant_he', 'הסעדה'],
  [/מרפסת|נוף מהחדר/, 'balcony_he', 'מרפסת ונוף'],
  [/כביסה/, 'laundry_he', 'כביסה'],
  [/שאטל|סקי ?בוס|הסעה למעלית|הסעה לאתר/, 'shuttle_he', 'שאטל'],
  [/מעלית במלון/, 'elevator_he', 'מעלית במלון'],
];
// חגורת בטיחות אחרונה לחוק אדום 3: ערך שמכיל כסף לא יוצא ללקוח, גם אם
// חמק פנימה בעת האיסוף
const FACT_MONEY = /[€$₪]|\d[\d,.]*\s*(?:אירו|יורו|שקל|דולר)(?![א-ת])/;
function facilityLine(lastUser, prevSlots, engine) {
  const text = String(lastUser || '');
  let wanted = FACILITY_FIELDS.filter(([re]) => re.test(text)).slice(0, 2);
  // "בריכה מחוממת" תופסת גם את שדה הבריכה הרגיל — שורה אחת, לא שתיים
  if (wanted.some(([, f]) => f === '_pool_heated')) wanted = wanted.filter(([, f]) => f !== 'pool_he');
  if (!wanted.length) return null;
  let names = offline.hotelsNamed(text);
  if (!names.length) {
    const shown = onScreenHotels(prevSlots);
    const keys = Object.keys(engine.resorts.hotels);
    names = shown.map(d => keys.find(k => displayHotel(k) === d)).filter(Boolean);
  }
  names = [...new Set(names)].slice(0, 3);
  if (!names.length) {
    // "יש בריכה מחוממת?" בלי מלון — השאלה שסאני נכשלה בה. יש לנו את הנתון:
    // מונים את המלונות שדף האתר שלהם אומר במפורש בריכה מחוממת.
    if (wanted.some(([, f]) => f === '_pool_heated')) {
      const heated = Object.entries(engine.resorts.hotels)
        .filter(([, h]) => (h.page_facts || {}).pool_heated === true)
        .map(([k]) => displayHotel(k)).slice(0, 6);
      if (heated.length) {
        return 'כן — לפי דפי המלונות באתר פינגווין יש בריכה מחוממת בין השאר ב: ' +
          heated.join(', ') + '. תגידו לי יעד או מלון ואדייק, ומה שלא כתוב בדף — נציג יאמת.';
      }
    }
    return null;                                        // בלי מלון — התשובה הכללית
  }
  const lines = [];
  let anyData = false;
  for (const n of names) {
    const pf = (engine.hotelInfo(n) || {}).page_facts || {};
    for (const [, field, label] of wanted) {
      let val;
      if (field === '_pool_heated') {
        val = pf.pool_heated === true ? 'כן — ' + (pf.pool_he || 'בריכה מחוממת') :
          pf.pool_heated === false ? 'הבריכה לא מסומנת כמחוממת בדף המלון' :
          pf.pool_he ? String(pf.pool_he).replace(/[.\s]+$/, '') + '. האם היא מחוממת לא כתוב בדף — נציג יאמת מול המלון' : null;
      } else val = pf[field];
      if (val && FACT_MONEY.test(val)) val = null;      // לעולם לא כסף
      if (val) { anyData = true; lines.push('• ' + displayHotel(n) + ' — ' + label + ': ' + val); }
      else lines.push('• ' + displayHotel(n) + ' — ' + label + ': לא כתוב בדף של המלון אצלי; נציג יאמת מול המלון.');
    }
  }
  if (!anyData) return null;                            // אין אף עובדה — עדיף המסלול הקיים
  return 'מדף המלון באתר פינגווין:\n' + lines.join('\n');
}

/* ---- דירוג מלונות, מהנתונים (אישור תומר, 31/08) ----
   "מלון X או מלון Y?", "כמה כוכבים?", "מה הדירוג בבוקינג?" — נענים מהמספרים
   שנאספו מאתר פינגווין ומבוקינג אל data/resorts.json, לא מטקסט קבוע ולא
   ממודל. מדווח עובדות זו לצד זו ולא פוסק מי "יותר טוב" — הלקוח יסיק.
   כשלא נקבו בשם מלון, עונה על ההצעות שכבר על המסך. */
const RATING_Q = /דירוג|כוכבים|בוקינג|booking|טריפ|יוקרתי|מפואר|לוקשרי|luxury|מפנק|איזה מלון (?:יותר|עדיף|טוב)|רמת המלון/i;
function ratingsLine(lastUser, prevSlots, engine) {
  if (!RATING_Q.test(String(lastUser || ''))) return null;
  let names = offline.hotelsNamed(lastUser);
  if (!names.length) {
    // המלונות שעל המסך, בסדר שהוצגו
    const shown = onScreenHotels(prevSlots);
    const keys = Object.keys(engine.resorts.hotels);
    names = shown.map(d => keys.find(k => displayHotel(k) === d)).filter(Boolean);
  }
  names = [...new Set(names)].slice(0, 3);
  if (!names.length) return null;
  const parts = [];
  let anyData = false;
  for (const n of names) {
    const badge = ratingBadge(engine.hotelInfo(n));
    if (badge) { anyData = true; parts.push('• ' + displayHotel(n) + ' — ' + badge); }
    else parts.push('• ' + displayHotel(n) + ' — אין לי דירוג מאומת למלון הזה; נציג יבדוק.');
  }
  if (!anyData) return null;             // אין אף מספר אמיתי — עדיף התשובה הכללית
  return 'לפי הנתונים שבאתר פינגווין:\n' + parts.join('\n') +
    '\nמה עוד חשוב לכם — ספא, מרחק מהמסלול, סוג החדר — כתוב על ההצעה של כל מלון.';
}

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
    // the resort in Hebrew: the card said TIGNES beside a Hebrew sentence
    hotel: displayHotel(c.hotel), resort: resortHe(c.resort), country: c.country,
    // what the card prints — the site's own name for the hotel (server/catalogue.js)
    display_name: catalogue.siteName(c.hotel) || displayHotel(c.hotel),
    country_he: labels.country(c.country) || c.country,
    // כוכבים וציון אורחים — מדפי pingwin.co.il, והחסר הושלם מ-Booking.com
    // (data/resorts.json, נאסף 31/08). null = לא אומת, ואז לא מציגים כלום.
    stars: engine.hotelInfo(c.hotel).stars ?? null,
    booking_score: engine.hotelInfo(c.hotel).booking_score ?? null,
    rating_he: ratingBadge(engine.hotelInfo(c.hotel)),
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
    // ...and only while we can still believe it. This is the line that goes
    // stale fastest — the last room of a type is the first thing to sell — and
    // it is also the line that pushes a customer to decide. Past
    // INVENTORY_STALE_HOURS since the workbook was read, it is withheld
    // (Tomer, 26/08). Everything else on the card survives.
    rooms_left_he: (c.count_available === 1 && !inventory.stale(engine.av))
      ? 'נשאר חדר אחד מהסוג הזה' : null,
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
      room_id: roomIdFor(c, slots),
    }, slots),
    // The boards this offer can be booked on — a choice for the customer
    // (Tomer, 10/09), per hotel and never invented: the site's own booking
    // engine when its answer is cached, the hotel page's own words otherwise.
    ...boardOptions(c, slots),
    // the chain's sales highlight (Tomer, 13/09): Belambra = all-inclusive
    // club, Club du Soleil = full board + wine + equipment — the card wears it,
    // the panel repeats it, and the reply says it once
    ...(() => {
      const h = offline.groupHighlight(c.hotel, c.board_he);
      return h ? { highlight_he: h.he, highlight_long_he: h.long_he, highlight_group: h.group } : {};
    })(),
  })).map((card, i, arr) => ({ ...card, tier_he: opts.noTier ? null : tierLabel(card, arr) }));
}

// the hint is what the workbook knows and the room's name does not always
// say — the site writes "Premium with View 4-5 pax" where we write "CONN
// Premium with View 5 pax". The same page the link goes to — Casa Karina
// answers about a short stay only on its short-stay siteID.
function roomIdFor(c, slots) {
  return siteRooms.idFor(pageFor(engine.hotelInfo(c.hotel), c.nights).siteID,
    c.date, addNights(c.date, c.nights), c.room,
    { type: c.room_type, occMin: c.occ_min, occMax: c.occ_max, party: partySize(slots), hotel: c.hotel });
}

/* board_options: [{code, he}] in the site's order; board_default: the code
   preselected; board_source: 'site' | 'page'. One option is still sent — the
   widget shows it as a fact, not a choice. Nothing known → nothing sent. */
function boardOptions(c, slots) {
  let codes = null, def = null, source = null;
  try {
    const siteID = pageFor(engine.hotelInfo(c.hotel), c.nights).siteID;
    const fromSite = siteRooms.boardFor(siteID, c.date, addNights(c.date, c.nights), roomIdFor(c, slots));
    if (fromSite && fromSite.pans && fromSite.pans.length) { codes = fromSite.pans; def = fromSite.defaultPan; source = 'site'; }
  } catch (e) { /* the page decides */ }
  if (!codes) {
    const fromPage = pansionCodes(c.board_he);
    if (fromPage.length) { codes = fromPage; source = 'page'; }
  }
  if (!codes) return {};
  const options = codes.filter(code => PANSION_HE[code]).map(code => ({ code, he: PANSION_HE[code] }));
  if (!options.length) return {};
  if (!def || !options.some(o => o.code === def)) def = options[0].code;
  return { board_options: options, board_default: def, board_source: source };
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
    bits.push((slots.adults === 1 ? 'נוסע אחד' : slots.adults + ' נוסעים') + (slots.no_children === true ? ' בלי ילדים' : ''));
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
  return guidance.msg('search_echo_prefix', 'התאמתי לכם לפי:') + ' ' + bits.join(' · ');
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
  // a segment is a QUESTION only when it ends in one: "ומה עם שבת? אנחנו
  // שומרי מסורת" has one question and one statement (13/09)
  const text = String(lastUser || '');
  const segs = text.split(/[?？]/).map(x => x.trim())
    .filter(x => x.split(/\s+/).filter(Boolean).length >= 2);
  const asked = (text.match(/[?？]/g) || []).length;
  const questionSegs = Math.min(segs.length, asked || segs.length);
  if (questionSegs < 2 || answersGiven >= 2) return null;
  return guidance.msg('dropped_question',
    'שאלתם עוד דבר ולא עניתי עליו — כתבו לי אותו שוב במשפט אחד ואענה.');
}

// The same FAQ answer, asked about again. The sentence the follow-up is about,
// if one can be picked; else, for a SHORT answer, the answer again with
// "כאמור" — "למה שאזמין דווקא אצלכם?" after the two-sentence competitor line
// got "עניתי על זה למעלה" (S11, 06/09 smoke), which reads as a door closing.
// Only a long paragraph earns the "that is all I have" line.
function repeatAnswer(lastUser, he, fallback) {
  const picked = offline.pickSentence(lastUser, he);
  if (picked) return picked;
  const body = String(he || '').trim();
  if (body.length <= 260 && !/^כאמור/.test(body)) return 'כאמור — ' + body;
  return fallback;
}

/* ---------- foreign languages: translate in, run the Hebrew turn, translate out ----------
   See server/translate.js. The Hebrew pipeline never learns that the customer
   wrote English; it sees a Hebrew message and produces a Hebrew reply, and the
   two translations wrap it. `slots._lang` keeps the language sticky, so
   "2 adults" or "ok" (no letters to detect a language from) still comes back
   in English; a message with Hebrew in it ends the translation. */
async function translateWithModel({ system, user, maxTokens, deadline, json }) {
  const raw = aiMode() === 'openai'
    ? await callOpenAI({ system, messages: [{ role: 'user', content: user }], maxTokens, json,
        model: process.env.OPENAI_PHRASE_MODEL || undefined, deadline })
    : await callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens, deadline });
  return String(raw || '').trim();
}
async function handleChat(body) {
  const rawMessages = Array.isArray(body && body.messages) ? body.messages : [];
  const lastIdx = (() => { for (let i = rawMessages.length - 1; i >= 0; i--) if (rawMessages[i] && rawMessages[i].role !== 'assistant') return i; return -1; })();
  const text = lastIdx >= 0 && typeof rawMessages[lastIdx].content === 'string' ? rawMessages[lastIdx].content : '';
  const detected = offline.foreignLanguage(text);
  const prevLang = body && body.slots && typeof body.slots._lang === 'string' && translate.TRANSLATABLE.has(body.slots._lang) ? body.slots._lang : null;
  const hasHebrew = /[א-ת]/.test(text);
  const lang = translate.TRANSLATABLE.has(detected) ? detected
    : (!detected && !hasHebrew && text.trim() && prevLang) ? prevLang : null;
  const clearLang = out => { if (out && out.slots && out.slots._lang && !lang) delete out.slots._lang; return out; };
  if (!lang || aiMode() === 'offline' || offline.guard(text) || offline.isGibberish(text) || process.env.TRANSLATE === 'off') return clearLang(await handleChatInner(body));
  // an integer, or the timer refuses it ("delay is out of range" — 25000/3)
  const budget = () => Date.now() + Math.round(Math.min(9000, Math.max(3000, CHAT_TIMEOUT_MS / 3)));
  // in: only when there are letters to translate ("4" and "2+2" go straight through)
  let he = text;
  if (/[A-Za-zЀ-ӿ؀-ۿÀ-ÿ]{2}/.test(text)) {
    health.called('translate');
    try {
      const raw = await translateWithModel({ system: translate.IN_PROMPT, user: text, maxTokens: 400, deadline: budget(), json: true });
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } } }
      he = translate.validateIn(parsed && parsed.he, text, KNOWN_NAMES);
      if (!he) { health.rejected('translate', 'in'); console.error('translate-in rejected: %s', raw.slice(0, 160)); }
      else health.ok('translate');
    } catch (e) { health.failed('translate', e); console.error('translate-in failed:', e.message); he = null; }
    if (!he) return clearLang(await handleChatInner(body));   // the fixed sentence in their language, as before
  }
  const messages = rawMessages.map((m, i) => i === lastIdx ? { ...m, content: he } : m);
  const out = await handleChatInner({ ...body, messages });
  if (!out || !out.slots) return out;
  out.slots._lang = lang;
  // out
  health.called('translate');
  let translated = null;
  try {
    const raw = await translateWithModel({ system: translate.outPrompt(lang), user: String(out.reply_he || ''), maxTokens: 900, deadline: budget(), json: false });
    translated = translate.validateOut(raw, out.reply_he, lang);
    if (!translated) { health.rejected('translate', 'out'); console.error('translate-out rejected: %s', raw.slice(0, 160)); }
    else health.ok('translate');
  } catch (e) { health.failed('translate', e); console.error('translate-out failed:', e.message); }
  if (translated) {
    out.reply_he = translated;
    out.model_used = true;
    if (out.open_lead_form && !out.lead_kind) out.lead_kind = 'language_' + lang;
    if (process.env.BANK_DEBUG && out.debug) out.debug.lang = lang;
  } else {
    // a reply we could not carry across the language is not sent half-way:
    // the fixed sentence in their language, and the form
    out.reply_he = guidance.languageText(lang) || out.reply_he;
    out.open_lead_form = true; out.lead_kind = 'language_' + lang;
  }
  return out;
}

/* ---------- chat orchestration ---------- */
async function handleChatInner(body) {
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
  const lastUser = offline.fixTypos(lastUserMsg ? lastUserMsg.content : '');

  // ---- step 1: deterministic Hebrew parse — always runs, always free ----
  let slots = offline.parseText(lastUser, prevSlots);
  /* "זוג לבנסקו במרץ" ואז "בעצם עדיף לנו צרפת": המדינה החדשה נקלטה, אבל
     היעד מהתור הקודם (בנסקו) נשאר וגבר עליה — הלקוח קיבל "איזו מההצעות
     מדברת אליכם?" על אותן הצעות בבולגריה. יעד ששייך למדינה אחרת מזו שנאמרה
     עכשיו כבר לא רלוונטי. (התגלה בבדיקה הרב-תורית, 31/08 — בנק חד-תורי לא
     יכול למצוא את זה מבנית.) */
  if (slots.country && slots.destination) {
    try {
      const prof = require('../config/resort-profiles.json').resorts[slots.destination];
      // רק כשהמדינה נאמרה עכשיו והיעד הוא ירושה מתור קודם
      if (prof && prof.country && prof.country !== slots.country &&
          slots.destination === prevSlots.destination && slots.country !== prevSlots.country) {
        slots.destination = null;
      }
    } catch (e) { /* אם אי אפשר לקבוע — משאירים כמו שהיה */ }
  }
  // One conversation id, minted on the first turn and carried by every reply —
  // including the early returns (greeting, farewell, guard, language). It is
  // what ties a lead to the chat that produced it, and it used to be handed
  // back only when Turnstile was on, so most leads had no chat at all.
  if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
  let replyIfNotReady = null;
  let modelAskedQuestion = false;   // the question in replyIfNotReady is the model's, not the ladder's
  let modelUsed = false;

  // ---- step 1a: not Hebrew? one sentence in their language, and the form ----
  // "asdfgh" is not English
  const lang = offline.isGibberish(lastUser) ? null : offline.foreignLanguage(lastUser);
  // transliterated Hebrew always gets the invitation (what it parsed is kept);
  // a real foreign sentence that the English floor already understood
  // ("family of 4 in february") goes on to the search instead
  const hebrewInvite = lang === 'translit' || lang === 'mixed';
  // With a model, a foreign message only reaches this point when the
  // translation was refused (see handleChat above); without one, this is the
  // whole answer. Either way a Hebrew paragraph to an English speaker helps
  // nobody — the fixed sentence in their language, and what was parsed is kept.
  if (lang && !offline.guard(lastUser)) {
    const line = guidance.languageText(lang);
    if (line) {
      if (!slots._cid) slots._cid = 'c' + Math.random().toString(36).slice(2, 10);
      chatLog.logTurn({ conversationId: body.conversationId || slots._cid, userText: lastUser, reply: line,
        cards: [], result: { notes: [], relaxed: [] }, slots, modelUsed: false, ms: Date.now() - startedAt,
        notUnderstood: false, answeredBy: 'lang:' + lang });
      return {
        open_lead_form: !hebrewInvite, lead_kind: !hebrewInvite ? 'language_' + lang : null, lead_prefill: null,
        reply_he: line, model_used: false, pending_parameter: hebrewInvite ? 'adults' : null,
        slots, cards: [], two_room_splits: [], notes: [], relaxed: [],
        chips: hebrewInvite ? ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'] : [], chip_to_pref: CHIP_TO_PREF,
        ...(process.env.BANK_DEBUG ? { debug: { answered_by: 'lang', lang, faq_ids: [], guard: null, off_topic: false, not_understood: false, pending: null } } : {}),
      };
    }
  }

  // ---- step 1a½: an existing customer (or a complaint) stays with the rep ----
  // Once someone has said "הזמנתי ולא קיבלתי אישור" or "המלון היה נורא", the
  // next turns belong to that thread — "מספר ההזמנה 48213", "מתי אקבל את
  // הכרטיסים?", "אני רוצה פיצוי". Live persona run (03/09): each of those was
  // answered with three hotel cards and "כמה נוסעים תהיו?". A paying customer
  // got a catalogue. The mode ends the moment they start a new search
  // ("בוא נראה מה יש לפברואר לזוג") or ask to see offers.
  // A company outing, a school, a bar-mitzvah group: the same rule. "אפשר גם
  // ערב צוות במלון?" from the welfare manager of 24 employees was answered
  // "נוסעים גם ילדים?" and then three hotel cards (P16, live 06/09).
  const GROUP_KINDS = new Set(['corporate', 'school', 'celebration_group']);
  const repKind = prevSlots._rep_mode ||
    (prevSlots._lead_kind === 'existing' ? 'existing' : (GROUP_KINDS.has(prevSlots._lead_kind) ? 'group' : null));
  const REP_EXIT = /רוצה לראות|תראה לי|תראו לי|מה יש ל|בוא נראה|בואו נראה|חופשה חדשה|הזמנה חדשה|עוד חופשה|להזמין שוב|הזמנה נוספת|אפשרויות/;
  if (repKind && !slotsChanged(prevSlots, slots) && !REP_EXIT.test(lastUser) &&
      !offline.guard(lastUser) && !offline.isGreeting(lastUser) && !offline.wantsMore(lastUser)) {
    const bookingNo = lastUser.match(/(?:מספר|מס'?)? ?ה?הזמנה\D{0,4}(\d{3,})|הזמנה (?:מספר |מס'? ?)?(\d{3,})/);
    const num = bookingNo ? (bookingNo[1] || bookingNo[2]) : null;
    const fh = offline.faqMulti(lastUser);
    const STICKY = new Set(['complaint', 'my_booking']);
    const generic = repKind === 'complaint'
      ? guidance.msg('complaint_followup',
          'אני לא רוצה לענות על זה בסיסמאות. הפנייה שלכם צריכה להגיע לנציג שיראה מה קרה ויטפל בזה אישית — השאירו כאן שם וטלפון ואסמן שזו פנייה שכבר נפלה פעם, או התקשרו ל-{phone}.')
      : repKind === 'group'
      ? guidance.msg('group_followup',
          'לקבוצה כזו הכול נבנה בהתאמה אישית מול נציג הקבוצות — ערבי צוות, חלוקה לחדרים, תמהיל גולשים ולא-גולשים ותקציב. את הפרטים משאירים כאן — שם וטלפון — ונציג קבוצות יחזור אליכם, או התקשרו ל-{phone}.')
      : guidance.msg('existing_followup',
          'זה שייך להזמנה שלכם, ואותה אני לא רואה — נציג כן. השאירו כאן שם וטלפון (ומספר ההזמנה, אם יש) ונחזור אליכם, או התקשרו ל-{phone}.');
    const tail = repKind === 'group'
      ? guidance.msg('group_tail', 'ולקבוצה בגודל הזה — הכול נסגר מול נציג הקבוצות: השאירו כאן שם וטלפון ונחזור אליכם.')
      : guidance.msg('rep_tail', 'ההזמנה הקיימת שלכם — רק מול נציג: השאירו כאן שם וטלפון ונחזור אליכם.');
    let line;
    // the two things an upset customer actually asks, answered to the point
    const wantsComp = /פיצוי|זיכוי|החזר כספי/.test(lastUser);
    const whyAgain = /למה ש(?:אני )?(?:אזמין|נזמין)|למה לחזור|למה שאחזור|למה שנחזור/.test(lastUser);
    if (num) {
      slots.notes_from_customer = [...new Set([...(slots.notes_from_customer || []), 'מספר הזמנה ' + num])].slice(0, 6);
      line = 'רשמתי: הזמנה ' + num + '. ' + generic;
    } else if (fh && !STICKY.has(fh.id) && fh.id !== prevSlots._lastFaqId) {
      line = /שם וטלפון/.test(fh.he) ? fh.he : fh.he + String.fromCharCode(10) + tail;
      slots._lastFaqId = fh.id;
    } else if (wantsComp) {
      line = guidance.msg('complaint_compensation',
        'פיצוי או זיכוי — זו החלטה של נציג אחרי שיראה את ההזמנה ומה קרה, לא שלי. השאירו כאן שם וטלפון ואעביר את זה כפנייה שכבר נפלה פעם, או התקשרו ל-{phone}.');
    } else if (whyAgain) {
      line = guidance.msg('complaint_why_again',
        'שאלה הוגנת, ולא אענה עליה בסיסמאות. מה שכן יכול לשכנע זה שהפעם מישהו באמת יחזור אליכם — השאירו שם וטלפון ואסמן את הפנייה כדחופה לנציג, או התקשרו ל-{phone}.');
    } else {
      line = generic;
    }
    // the same sentence twice running reads better as a person repeating
    // themselves on purpose
    if (line === prevSlots._lastGuard) line = 'כאמור — ' + line;
    slots._lastGuard = line.replace(/^כאמור — /, '');
    slots._rep_mode = repKind;
    slots._lead_kind = repKind === 'existing' ? 'existing' : (slots._lead_kind || null);
    // the form stays tagged with WHO they are ("corporate"), not with the mode
    const leadKindOut = repKind === 'group' ? (slots._lead_kind || prevSlots._lead_kind || 'corporate') : repKind;
    chatLog.logTurn({
      conversationId: body.conversationId || slots._cid, userText: lastUser, reply: line,
      cards: [], result: { notes: [], relaxed: [] }, slots, modelUsed: false, ms: Date.now() - startedAt,
      notUnderstood: false, answeredBy: 'rep:' + repKind,
    });
    return {
      open_lead_form: true, lead_kind: leadKindOut, lead_prefill: null,
      reply_he: line, model_used: false, pending_parameter: null,
      slots, cards: [], two_room_splits: [], notes: [], relaxed: [], chips: [], chip_to_pref: CHIP_TO_PREF,
      ...(process.env.BANK_DEBUG ? { debug: { answered_by: 'rep', lead_kind: repKind, faq_ids: fh ? [fh.id] : [], guard: null, off_topic: false, not_understood: false, pending: null } } : {}),
    };
  }
  if (repKind) { delete slots._rep_mode; }   // they moved on — a new search or "תראה לי"

  // ---- step 1b: is this even a customer looking for a holiday? ----
  // A travel agent, a company, a school, a journalist, someone who already
  // booked, someone who pasted a phone number — one sentence and the form,
  // tagged with who they are, instead of "כמה תהיו?".
  const leadIntent = !offline.guard(lastUser) && offline.leadIntent(lastUser);
  if (leadIntent) {
    // a phone number typed after "אני סוכן" is still the agent's lead
    slots._lead_kind = (leadIntent.kind === 'phone_only' && prevSlots._lead_kind) ? prevSlots._lead_kind : leadIntent.kind;
    if (slots._lead_kind === 'existing') slots._rep_mode = 'existing';
    if (GROUP_KINDS.has(slots._lead_kind)) slots._rep_mode = 'group';
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
        // "any" is what the customer says, not what the model assumes. Live
        // persona run (03/09): "2 מבוגרים ו-2 ילדים" came back with a flexible
        // month, the gate opened, and three hotels were shown before anyone
        // had said when — then the next line asked "באיזה חודש?". A flexible
        // answer needs a flexible word in the message.
        const FLEX = /גמיש|לא משנה|כל (חודש|תאריך|מקום|יעד)|מתי שיש|איפה שיש|מה שיש|אין לי העדפה|לא חשוב/;
        if (!FLEX.test(lastUser)) {
          if (found.month === 'any') delete found.month;
          if (found.flexible_dates === true) delete found.flexible_dates;
          if (found.country === 'any') delete found.country;
          if (found.departure_airport === 'any') delete found.departure_airport;
        }
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
          .filter(n => !/פרטי קשר|טלפונים של|טלפון של|שמות של|נוסעים אחרים|לקוחות אחרים|לקוח אחר|נוסע אחר/.test(n))
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
          if (q.ok) { replyIfNotReady = parsed.reply_he; modelAskedQuestion = true; }
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
  // A statement that happens to carry a topic word is a request, not a
  // question: "6 חברים, פברואר, משהו עם חיי לילה" is answered by the offers
  // sorted for nightlife — not by a paragraph about villages and another about
  // six-person rooms above them (13/09). These answers stay for the question.
  if (faqHit && !faqHit.routed) {
    const UNLESS_ASKED = {
      big_family_room: /\?|חדר|סוויט/,
      village_life: /\?|מה (?:יש|עושים)|יש מה|כפר מת|עיירה מתה|קרוב לברים|רומנטי|ירח דבש/,
    };
    const all = faqHit.all || [faqHit];
    const kept = all.filter(a => !(UNLESS_ASKED[a.id] && !UNLESS_ASKED[a.id].test(lastUser)));
    if (!kept.length) faqHit = null;
    else if (kept.length < all.length) faqHit = { ...faqHit, id: kept[0].id, he: kept.map(a => a.he).join(String.fromCharCode(10)), matched: kept[0].matched, all: kept };
  }
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
  // "אפשר גם בעברית" / "אפשר בעברית" after a foreign-language turn is an
  // affirmation, not a question about who speaks Hebrew — routing it sent the
  // model to hebrew_staff (persona P29, 03/09), a paragraph about camp
  // counsellors nobody asked about.
  const justSwitchingToHebrew = /^\s*(כן,?\s*)?אפשר (גם )?בעברית\.?\s*$/.test(lastUser);
  const looksLikeQuestion = !justSwitchingToHebrew && (/[?]/.test(lastUser) ||
    /^\s*(מה|מי|מתי|איפה|איך|כמה|האם|יש |אפשר|צריך|למה|אם )/.test(lastUser) ||
    (!slotsChanged(prevSlots, slots) && lastUser.trim().length > 8) ||
    // A requirement stated inside a long request is a question too: "רוצים
    // העברות פרטיות ומלון על המסלול" has an answer waiting for it, and it was
    // going unanswered because the same sentence also filled slots.
    lastUser.trim().length > 60);
  // "ולצרפת?" straight after the flight-days answer, "ובחנוכה?" after the
  // holidays answer: a word or two that continue the previous topic. The
  // answer is a sentence of the paragraph we just gave — quote it, no model
  // needed (20 "אין לי תשובה מוכנה" follow-ups in the live FAQ run, 06/09).
  const prevFaqEntry = prevSlots._lastFaqId
    ? offline.faqEntries().find(e => e.id === prevSlots._lastFaqId) : null;
  const shortFollowup = lastUser.trim().split(/\s+/).length <= 4 && /^\s*[ו]/.test(lastUser.trim());
  if (!faqHit && prevFaqEntry && shortFollowup && !offline.guard(lastUser)) {
    const picked = offline.pickSentence(lastUser, prevFaqEntry.answer_he);
    if (picked) faqHit = { id: prevFaqEntry.id, he: picked, all: [{ id: prevFaqEntry.id, he: picked }], followup: true };
  }
  // computed once, used by both router calls below. A short message gets the
  // previous customer message alongside — "ולצרפת?" on its own routes nowhere.
  const prevUserMsg = [...messages].slice(0, -1).reverse().find(m => m.role === 'user');
  const shortMsg = lastUser.trim().split(/\s+/).length <= 8;
  const prevLine = shortMsg && prevUserMsg
    ? 'ההודעה הקודמת של הלקוח: ' + String(prevUserMsg.content || '').slice(0, 120) +
      (prevSlots._lastFaqId ? ' (נענתה מתוך: ' + prevSlots._lastFaqId + ')' : '')
    : '';
  const routerDigest = [partyDigest(slots), prevLine].filter(Boolean).join(String.fromCharCode(10));
  const withDigest = t => routerDigest ? routerDigest + String.fromCharCode(10) + 'שאלה: ' + t : t;
  // "יש להם מסגרת או שהם עם המבוגרים?" two turns after "מתבגרים בני 14 ו-16":
  // the ages are on the slots, the word is "מסגרת" — that is the teen-camp
  // answer, and no router call is needed to know it (S09, 06/09 smoke: the
  // router picked "טיול מאורגן" even with the digest in front of it).
  const teenAges = (slots.children_ages || []).filter(a => a >= 13 && a <= 17);
  // …unless the question names a younger child ("הילד בן 4 יכול להיות
  // בקייטנה?") — that one is about the four-year-old, not the teenager (13/09)
  const namesYounger = /ב[נןת] ?(?:[0-9]|1[0-2])(?![\d])/.test(lastUser);
  // …and "כן, קייטנה" is an answer to our question, not a question about the
  // teenager — the note rides only on a question (13/09)
  const asksAboutTeen = looksLikeQuestion || /מסגרת|מי שומר|מה עושים|לבד/.test(lastUser);
  if (!faqHit && teenAges.length && !namesYounger && asksAboutTeen && !offline.guard(lastUser) &&
      /מסגרת|קייטנ|הדרכה|מי שומר|מה עושים|לבד|מדריך/.test(lastUser) && !/מבוגרים בלבד|למבוגרים\?/.test(lastUser)) {
    const teen = offline.faqEntries().find(e => e.id === 'teen_camp');
    if (teen) faqHit = { id: 'teen_camp', he: teen.answer_he, all: [{ id: 'teen_camp', he: teen.answer_he }] };
  }
  // Same for "אפשר בכלל לנסוע איתם?" a turn after "תינוק בן שנה ופעוט בן 3":
  // a baby is on the slots, "איתם" is the baby (S10, offline)
  const babyAges = (slots.children_ages || []).filter(a => a <= 3);
  if (!faqHit && babyAges.length && !offline.guard(lastUser) &&
      /לנסוע אית|לטוס אית|אפשר בכלל|מתאים ל(?:תינוק|פעוט|קטנים)|עם (?:תינוק|פעוט)/.test(lastUser)) {
    const baby = offline.faqEntries().find(e => e.id === 'travel_with_baby');
    if (baby) faqHit = { id: 'travel_with_baby', he: baby.answer_he, all: [{ id: 'travel_with_baby', he: baby.answer_he }] };
  }
  if (!faqHit && looksLikeQuestion && !offline.guard(lastUser) && !offline.deflect(lastUser)) {
    // the model router gets the same context, for the same reason — asked to
    // route "עד מתי?" on its own it has nothing to route
    faqHit = await routeToAnswer(withDigest(withEntities || withContext || lastUser), deadline);
  }
  // "איך מגיעים מהשדה למלון?" over two Bansko offers was answered with the
  // distances of all sixteen resorts (13/09). When we know where they are
  // going — offers on screen, a resort, a country — the answer is about
  // THAT: one distance line, the transfer is included. The full list stays
  // for a customer who has told us nothing yet.
  if (faqHit && !faqHit.routed) faqHit = scopeTransferAnswer(faqHit, lastUser, slots, prevSlots);
  // "יש חניה במלון? ומה עם ביטוח?" — the regex caught the insurance and the
  // parking question fell on the floor. When the message plainly asks more
  // than one thing, the router runs anyway and the second answer rides along.
  const multiPart = (lastUser.match(/\?/g) || []).length >= 2 ||
    /ומה (עם|לגבי|בקשר)|וגם מה|ושאלה נוספת|ועוד שאלה|ואגב|, אגב/.test(lastUser);
  if (faqHit && !faqHit.routed && multiPart && (faqHit.all || []).length < 2 &&
      !offline.guard(lastUser)) {
    const routed = await routeToAnswer(withDigest(lastUser), deadline);
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
  // Reasoned recommendation (q25): "איזה אתר מתאים למשפחה?", "טין או ואל
  // טורנס?", "איפה יש קרחון?" — answered from the approved resort table with
  // the facts as reasons. It outranks the generic compare/country lecture.
  let recAnswer = null;
  if (!offline.guard(lastUser)) {
    recAnswer = recommend.answer(lastUser, slots);
    // It outranks the GENERIC lectures only. A specific approved answer that
    // already matched — "איפה הקייטנה?", "אפשר שכל משפחה תשלם בנפרד?" — must
    // not be replaced by a resort list: 15 bank questions used to get a
    // recommendation instead of their answer (אושר על ידי תומר, 31/08).
    const RECOMMEND_MAY_REPLACE = new Set(['compare', 'compare_countries']);
    if (recAnswer && faqHit && !RECOMMEND_MAY_REPLACE.has(faqHit.id) &&
        !(faqHit.all || []).some(a => RECOMMEND_MAY_REPLACE.has(a.id))) {
      recAnswer = null;                       // the specific answer wins
    }
    if (recAnswer) faqHit = { id: 'recommend', he: recAnswer.he, chips: recAnswer.chips,
      all: [{ id: 'recommend', he: recAnswer.he }] };
  }

  // שאלת דירוג עם מלון בשם (או עם הצעות על המסך): המספרים האמיתיים גוברים על
  // התשובה הכללית של luxury_level — אבל אף פעם לא על תשובה ספציפית אחרת.
  let ratingFacts = null;
  try { ratingFacts = ratingsLine(lastUser, prevSlots, engine); } catch (e) { ratingFacts = null; }
  const RATING_GENERIC = new Set(['luxury_level', 'reviews']);
  if (ratingFacts && (!faqHit || RATING_GENERIC.has(faqHit.id) ||
      (faqHit.all || []).some(a => RATING_GENERIC.has(a.id)))) {
    faqHit = { id: 'hotel_ratings', he: ratingFacts, all: [{ id: 'hotel_ratings', he: ratingFacts }] };
  }

  // שאלת מתקן עם מלון בשם (או הצעות על המסך): הציטוט מדף המלון גובר על
  // התשובות הגנריות ("תנאי הספא שונים בין המלונות") — אך לא על תשובה
  // ספציפית אחרת, ולא על כשרות/שבת שהן מדיניות ולא מתקן.
  let facilityFacts = null;
  try { facilityFacts = facilityLine(lastUser, prevSlots, engine); } catch (e) { facilityFacts = null; }
  const FACILITY_GENERIC = new Set(['spa', 'wifi', 'parking', 'hotel_facility_unknown', 'lockers', 'slope_distance']);
  // "יש מקרר בחדר ב-X?" נתפס על ידי תשובת הכשרות בגלל המילה מקרר; כשנקבו
  // במלון וזו שאלת מתקן בלי "כשר", העובדה מהדף עדיפה. "לבשל כשר" נשאר אצל
  // תשובת הכשרות.
  const kosherHijack = faqHit && (faqHit.id === 'kosher' || (faqHit.all || []).some(a => a.id === 'kosher')) &&
    !/כשר|כשרות/.test(lastUser);
  if (facilityFacts && (!faqHit || kosherHijack || FACILITY_GENERIC.has(faqHit.id) ||
      (faqHit.all || []).some(a => FACILITY_GENERIC.has(a.id)))) {
    faqHit = { id: 'hotel_facility_facts', he: facilityFacts, all: [{ id: 'hotel_facility_facts', he: facilityFacts }] };
  }
  // "מה ההבדל בין Sport ל-Ferienhof?" / "איזה מהם מתאים לנו?" — characterize
  // the hotels from their approved data (Tomer, 06/09: "כן תיתן לו לאפיין"),
  // instead of the old "לא אדרג מלון אחד מול השני". No prices, no "הכי".
  let charFacts = null;
  try {
    charFacts = characterize.line(lastUser, prevSlots, slots, engine, {
      displayHotel, ratingBadge, hotelsNamed: offline.hotelsNamed,
      resortHe: r => phrasing.RESORT_HE[r] || null,
    });
  } catch (e) { charFacts = null; }
  const CHAR_GENERIC = new Set(['compare', 'which_room', 'luxury_level', 'reviews', 'recommend', 'hotel_ratings', 'slope_distance', 'spa']);
  if (charFacts && (!faqHit || CHAR_GENERIC.has(faqHit.id) || (faqHit.all || []).some(a => CHAR_GENERIC.has(a.id)))) {
    faqHit = { id: 'hotel_characterization', he: charFacts, all: [{ id: 'hotel_characterization', he: charFacts }] };
  }

  // What we looked up, above the answer we found. Computed here rather than
  // beside the preamble because the pure-policy early return below never
  // reaches the preamble, and that is exactly the turn a rewritten question
  // lands on ("ומה עם זה?" from someone who has told us nothing yet).
  const echoPlace = slots.hotel ||
    (slots.destination ? String(slots.destination) : null) ||
    (botEntities ? botEntities.split(' ').slice(0, 2).join(' ') : null);
  // No echo over a hotel profile — the profile names the hotel itself, so
  // "בודק לגבי: Regnum" above it is the same word twice (S15, 06/09 smoke).
  // And a message the pattern layer answered on its own was not "rewritten",
  // whatever context was prepared for the router ("ומה עם טיסות בשבת?" → an
  // echo of "טיסות בשבת" over the shabbat paragraph, S20).
  const HOTEL_FACT_IDS = new Set(['hotel_characterization', 'hotel_facility_facts', 'hotel_ratings']);
  const echoFor = (hit) => {
    if (hit && (HOTEL_FACT_IDS.has(hit.id) || (hit.all || []).some(a => HOTEL_FACT_IDS.has(a.id)))) return null;
    // the customer's own words matched the answer — nothing was looked up on
    // their behalf, so there is nothing to be transparent about
    if (hit && !hit.routed && offline.faq(lastUser)) return null;
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
    // "רשמתי גם: מתעניין ב-Regnum" under the Regnum profile is the model's
    // note of the very thing we just answered (S15, 06/09 smoke)
    ].filter(n => !(faqHit.id === 'hotel_characterization' && offline.hotelsNamed(n).length));
    // an emotional turn — a complaint, a booking worry — gets its human word
    // first and no cheery invite after; and no promise of "באמת פנוי"
    const EMOTIONAL = new Set(['complaint', 'my_booking', 'special_needs']);
    const quietSocial = offline.socialLine(lastUser);
    const socialPrefix = quietSocial && !/מצטער/.test(faqHit.he)
      ? quietSocial + String.fromCharCode(10) : '';
    const echoHe = echoFor(faqHit);
    const droppedHe = droppedQuestionLine(lastUser, multiPart,
      Math.max(1, (faqHit.all || []).length), false);
    /* The same answer, word for word, twice running.
       This early return had no repeat suppression at all — it never recorded
       what it said, so `_lastFaqId` and `_lastLines` stayed empty and the next
       turn could not tell it was repeating. Seen live 31/08: "מה כלול בחבילה?"
       then "גם לילדים?" printed the identical four-line paragraph, under an
       echo saying we had looked the same thing up again.
       When the follow-up lands on the answer we just gave, the honest reply is
       that this IS the answer — not the answer again. */
    let repeatingFaq = faqHit.id && faqHit.id === prevSlots._lastFaqId;
    /* ...אבל קודם: אולי יש נושא אחר שההודעה גם נוגעת בו. "תבטיח לי שיהיה
       שלג" ואז "אז מתי הכי בטוח?" נפלו שניהם על no_snow, והלקוח קיבל שורה
       גנרית במקום התשובה על התקופות. faqMulti מחזיר את כל ההתאמות — אם יש
       אחת שעוד לא נאמרה, היא התשובה. (בדיקה רב-תורית, 31/08.) */
    if (repeatingFaq) {
      const others = (faqHit.all || []).filter(a => a.id !== prevSlots._lastFaqId);
      if (others.length) {
        faqHit = { ...faqHit, id: others[0].id, he: others.map(a => a.he).join(String.fromCharCode(10)), all: others };
        repeatingFaq = false;
      }
    }
    if (EMOTIONAL.has(faqHit.id) && faqHit.id !== 'special_needs') slots._rep_mode = faqHit.id === 'complaint' ? 'complaint' : 'existing';
    const answerBody = repeatingFaq && faqHit.id === 'complaint'
      ? guidance.msg('complaint_followup',
          'אני לא רוצה לענות על זה בסיסמאות. הפנייה שלכם צריכה להגיע לנציג שיראה מה קרה ויטפל בזה אישית — השאירו כאן שם וטלפון ואסמן שזו פנייה שכבר נפלה פעם, או התקשרו ל-{phone}.')
      : repeatingFaq
      // "אפשר בביט?" after the payment paragraph: the sentence it is about,
      // quoted — not "עניתי על זה למעלה" (79 follow-ups, live FAQ run 06/09)
      ? repeatAnswer(lastUser, faqHit.he, guidance.msg('same_answer_again',
          'זה מה שיש לי על הנושא הזה — התשובה חלה על כולם, ילדים ומבוגרים כאחד. ' +
          'אם התכוונתם למשהו ספציפי יותר, כתבו לי אותו ואבדוק.'))
      : faqHit.he;
    const replyText = socialPrefix + (echoHe ? echoHe + String.fromCharCode(10) : '') + answerBody +
      (droppedHe ? String.fromCharCode(10) + droppedHe : '') +
      (newNotes.length ? String.fromCharCode(10) + 'רשמתי גם: ' + newNotes.join(', ') +
        (EMOTIONAL.has(faqHit.id) ? ' — אעביר לנציג שיטפל בזה.' : ' — אתחשב בזה בהצעות, ומה שדורש בדיקה נציג יבדוק.') : '') +
      (EMOTIONAL.has(faqHit.id) ? '' : String.fromCharCode(10) +
        'וכשתרצו לבדוק תאריכים — כתבו לי כמה אתם ומתי בערך, ואציג את האפשרויות הפתוחות (נציג מאשר סופית).');
    // …and remember it, which is what makes the check above possible at all
    slots._lastFaqId = faqHit.id || null;
    slots._lastLines = [...new Set([...(prevSlots._lastLines || []),
      ...replyText.split(String.fromCharCode(10)).filter(Boolean)])].slice(-24);
    // the editor: one written answer from these lines (a complaint is never edited)
    const prevAssistantMsg = [...messages].slice(0, -1).reverse().find(m => m.role === 'assistant');
    const editedText = EMOTIONAL.has(faqHit.id) ? replyText : await composeWithModel({
      replyText, lastUser, digest: partyDigest(slots), question: null, deadline, knownNames: KNOWN_NAMES, knowledge: true,
      lastReply: prevAssistantMsg ? String(prevAssistantMsg.content || '') : '',
    });
    if (editedText !== replyText) modelUsed = true;
    chatLog.logTurn({
      conversationId: body.conversationId || slots._cid || (slots._cid = 'c' + Math.random().toString(36).slice(2, 10)),
      userText: lastUser, reply: editedText, cards: [], result: { notes: [], relaxed: [] },
      slots, modelUsed, ms: Date.now() - startedAt,
      notUnderstood: false, answeredBy: faqHit.routed ? 'router' : 'faq',
    });
    return {
      open_lead_form: offline.wantsCallback(lastUser),
      reply_he: editedText, model_used: modelUsed,
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
  // One list, used twice: for the off-topic verdict here, and below (step 5)
  // where offers are held — a question containing any of these words is about
  // the holiday, and must never be told it is not our field.
  const DOMAIN_HE = /סקי|חופש|מלון|טיסה|לנסוע|נסיעה|לטוס|מקום|קייטנ|יעד|תאריך|חודש|ילד|נוסע|מחיר|חדר|שלג|פינגווין|לילות|כלול|הבדל|להזמין|הזמנה|ביקשתי|מסלול|ספא|גלישה|מדריך|העבר|יעדים|אופצי|המלצ|הנחה|מעלי|רכבל|גונדול|עגל|תינוק|פעוט|גובה|כרטיס|ציוד|מגלש|מגפ|קסד|מזווד|כבודה|ביטוח|ארוח|אוכל|כשר|בריכ|סאונ|חני|מקרר|מטבח|וואטסאפ|ווצאפ|טיפ |טיפים|שדרוג|חשבונית|החזר|קבל|שיעור|בית ספר|קבוצ|אתר|עייר|כפר|שוק|טיול|מזג|סופה|שרשרא|סים|תרופ|אפיפן|דרכון|ויזה|שבת|נוטריון|הסעה|שאטל|לוקר|בגד|כפפ|משקפ|קרם/;
  const wantsToSee = offline.wantsMore(lastUser) ||
    /תראה|תראו|מה יש לכם|הראה לי|אפשר לראות|שלח לי אפשרויות|מה האפשרויות/.test(lastUser) ||
    // "מה יותר משתלם?" and "יש משהו עד 3500?" are requests to SEE, answered
    // with a list; holding them back for a full interview reads as stonewalling
    /משתלם|הכי זול|עד \d{3,5}|יש משהו|יש לכם|מחירים|תאריכים/.test(lastUser) ||
    // הפתיחות הבסיסיות ביותר — "רוצה חופשת סקי", "מה יש בבולגריה?" — קיבלו
    // "לא בטוח שהבנתי". זו בקשה לראות, לא שאלת ידע. (בדיקה רב-תורית, 31/08)
    /^\s*(אני )?(רוצה|מחפש(ת|ים)?|מעוניינ|צריכ|מתעניינ)\s*(חופש|סקי|חבילה|נופש|טיול)/.test(lastUser) ||
    /^\s*ו?מה יש (ב|לכם ב)/.test(lastUser) ||
    // "טוב, אז מה יש לזוג בפברואר?" — a request to see, not a question we
    // failed to answer (persona P14, 03/09). "מה יש לעשות" is a different thing.
    /(?:^|[\s,.])(?:אז |נו |טוב )?מה יש ל(?!עשות|ה |הם |כם\b)/.test(lastUser) ||
    // "יש חבילות לאוסטריה?" (the Russian opener, translated) is a request to
    // see, not a question we failed to answer
    /^\s*ו?יש (?:לכם )?(?:חבילות|חבילה|חופשות|חופשה|אפשרויות|הצעות|משהו|מקום)(?![א-ת])/.test(lastUser) ||
    // "זוג, ינואר, מה יש?" — the bare form at the end of the details (P25, live 06/09)
    /(?:^|[\s,.])(?:אז |נו |טוב )?מה יש\s*[?!.]*\s*$/.test(lastUser) ||
    // "טוב, בוא נראה בכל זאת מה יש" after a complaint (S12, 06/09 smoke) — a
    // request to see, and it was getting "אין לי תשובה מאושרת" above the cards
    /בוא(?:ו)? נראה|נראה מה יש|תציג|תציגו/.test(lastUser);
  const offTopic = lastUser && !slotsChanged(prevSlots, slots) && !modelUsed &&
    !faqHit && !cardTopicAsked && !offline.deflect(lastUser) && !wantsToSee &&
    /\?|איך|מה |למה|מי /.test(lastUser) &&
    !DOMAIN_HE.test(lastUser);

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
    // Same idea when the customer answered with something ELSE we understood
    // ("נוסעים גם ילדים?" → "פברואר"): "סליחה, לא הצלחתי להבין" is untrue,
    // we understood February fine. The retry wording is for a reply that
    // filled nothing at all.
    const understoodOther = slotsChanged(prevSlots, slots);
    // ...and only for a question the customer actually SAW. The FAQ-only turn
    // files 'adults' as the pending key (so a bare "2" next is a head count)
    // without printing the question — retrying it reads as scolding.
    const wasAsked = (prevSlots._asked || []).includes(prevSlots._lastQuestion);
    let q = offline.nextQuestion(slots, (reAsking || understoodOther || !wasAsked) ? null : (prevSlots._lastQuestion || null));
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
      // The OPENING asks the basics in one sentence — "כמה תהיו, גילאי ילדים
      // אם יש, ומתי בערך?" — like Sunny (Tomer, 06/09). A customer who knows
      // what they want answers all three in one line instead of three turns;
      // from the second message on it is one question at a time again.
      // Only the gaps still open, only the three that matter, only when at
      // least two of them are open (one gap is the ordinary ladder question).
      const firstUserTurn = messages.filter(m => m.role === 'user').length === 1;
      // "אפשר גם בעברית" after a foreign-language opener is the first Hebrew
      // turn — the conversation starts here (S19, 06/09 smoke)
      if ((firstUserTurn || justSwitchingToHebrew) && !(prevSlots._asked || []).length) {
        const gaps = offline.blockingGaps(slots);
        const parts = [];
        if (gaps.includes('adults')) parts.push(slots.children_count || (slots.children_ages || []).length ? 'כמה מבוגרים' : 'כמה תהיו');
        if (gaps.includes('children')) parts.push(slots.no_children === false || slots.children_count ? 'בני כמה הילדים' : 'גילאי ילדים אם יש');
        if (gaps.includes('month')) parts.push('מתי בערך (דצמבר–מרץ)');
        if (parts.length >= 2) {
          const joined = parts.length === 2 ? parts.join(' ו') : parts.slice(0, -1).join(', ') + ', ו' + parts[parts.length - 1];
          replyIfNotReady = guidance.msg('opening_question', 'כדי שאתאים לכם את החופשה — {gaps}?').replace('{gaps}', joined);
          slots._opening_asked = true;
        }
      }
    }
    else { pendingQuestion = q; delete slots._lastQuestion; }
  }

  const OFF_TOPIC_HE = guidance.msg('off_topic',
    'אני כאן בעיקר להתאמת חופשות סקי של פינגווין. לשאלות אחרות נציג ישמח לעזור ב-{phone}.');
  // "וכמה זמן לוקח עד שההזמנה מאושרת?" right after the booking answer is not
  // off topic and not misunderstood — it is a detail we hold no approved
  // answer for. Say that (37 follow-ups were told "לא התחום שלי" and 50
  // "לא הבנתי" in the live FAQ run, 06/09). A short message on the heels of
  // a knowledge answer is a follow-up on it.
  const knowledgeFollowup = !!prevSlots._lastFaqId && lastUser.trim().split(/\s+/).length <= 8 &&
    !slotsChanged(prevSlots, slots) && !wantsToSee;
  // "אסדגכע ייי" — say so, lightly, and leave the door open (Sunny does)
  const gibberish = offline.isGibberish(lastUser);
  const SENT_BY_MISTAKE_HE = guidance.msg('sent_by_mistake',
    'נראה שההודעה נשלחה בטעות — אם יש שאלה, כתבו אותה ואענה.');
  const FOLLOWUP_UNKNOWN_HE = guidance.msg('followup_unknown',
    'על הפרט הזה אין לי תשובה מאושרת, ולא אנחש — נציג ישלים אותו: השאירו כאן שם וטלפון או התקשרו ל-{phone}.');
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
  // "היינו אצלכם לפני שנתיים והמלון היה מלוכלך" — "ברוכים השבים!" above a
  // complaint is a machine that heard "היינו אצלכם" and nothing else
  if (social && faqHit && /ברוכים השבים/.test(social) && /מצטער/.test(faqHit.he)) social = null;
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
    offTopic && !deflection ? (knowledgeFollowup ? FOLLOWUP_UNKNOWN_HE : OFF_TOPIC_HE) : null,
    gibberish && !deflection && !faqHit && !slotsChanged(prevSlots, slots) ? SENT_BY_MISTAKE_HE : null,
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
  // The key must describe THIS turn's question. When the model asks two turns
  // running, `slots._lastQuestion` still holds last turn's model key (the
  // ladder, which clears it, did not run) — so the new question was filed as
  // "already asked", dropped, and the gate opened: three hotels shown before
  // anyone said when (every live persona run, 03/09).
  const pendingKey = modelAskedQuestion
    ? 'model:' + replyIfNotReady.slice(0, 24)
    : (slots._lastQuestion || (replyIfNotReady ? 'model:' + replyIfNotReady.slice(0, 24) : null));
  let tailQuestion = null;
  if (pendingKey && replyIfNotReady && !askedBefore.has(pendingKey)) {
    tailQuestion = replyIfNotReady;
    askedBefore.add(pendingKey);
  } else if (pendingKey && replyIfNotReady && !askedBefore.has(pendingKey + '#again') &&
             offline.blockingGaps(slots).length > 0 &&
             +(prevSlots._held || 0) < MAX_QUESTIONS && questionsAsked < MAX_QUESTIONS &&
             !(prevSlots._shown || []).length) {
    // The customer answered our question with a question of their own —
    // "באיזה חודש?" → "יש עוד ישראלים בקבוצה?" — and the same question came up
    // again. "Never twice" dropped it, and with no question left to ride on,
    // the gate opened: three hotels before anyone said when (P03, P04, P06,
    // P17, P21, P30 — live run 06/09, the real cause of the early cards).
    // Ask once more while the offers are still being held; the held counter
    // still opens the door after MAX_QUESTIONS, so nobody is stuck. The second
    // asking is never word-for-word the first: the frame says why it is back.
    const prevAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const verbatim = prevAssistant && String(prevAssistant.content || '').includes(replyIfNotReady);
    // the ladder's "סליחה, לא הצלחתי להבין" retry wording under the frame
    // would scold twice — the frame carries the plain question instead
    const plain = modelAskedQuestion ? replyIfNotReady : ((offline.nextQuestion(slots, null) || {}).he || replyIfNotReady);
    tailQuestion = (verbatim || !modelAskedQuestion)
      ? guidance.msg('ask_again', 'עוד פרט שחסר לי כדי לדייק: {q}').replace('{q}', plain)
      : replyIfNotReady;
    askedBefore.add(pendingKey + '#again');
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
  // "סקי" / "חופשת סקי" / "נופש" on an empty chat is a customer who walked in,
  // not a message we failed to read (13/09: it got "לא הבנתי" and, one turn
  // later, a lead form). It gets the opening question, and does not count as
  // a lost turn.
  const onTopicHello = nothingKnown && /^[\s!.?]*(?:חופשת |חופשה |נופש |רוצה |רוצים |מחפש |מחפשים |לחפש )?(?:סקי|סנובורד|גלישה|שלג|חופשה|חופשת סקי|נופש סקי)[\s!.?]*$/.test(lastUser.trim());
  const puzzled = nothingKnown && !cardTopicAsked && !onTopicHello &&
    !offline.faq(lastUser) && !offline.deflect(lastUser) &&
    !offline.guard(lastUser) && !offline.isGreeting(lastUser) && !slotsChanged(prevSlots, slots)
    ? (knowledgeFollowup ? FOLLOWUP_UNKNOWN_HE : gibberish ? SENT_BY_MISTAKE_HE : offline.notUnderstood(lastUser)) : null;
  if (puzzled) {
    slots._lastQuestion = 'adults';
    // This early return sits ABOVE the _lost counter, so three "אאא" in a row
    // produced three byte-identical replies and the handover offer never
    // fired. Gibberish AFTER some details are known escalates correctly on the
    // second try; it was only the customer whose FIRST messages do not parse —
    // exactly the one most likely to give up — who got an unbreakable loop.
    slots._lost = (prevSlots._lost || 0) + 1;
    // three unreadable messages, not two — the second one is often a
    // customer still finding the words (13/09)
    const stuck = slots._lost >= 3 && !prevSlots._nudged;
    if (stuck) slots._nudged = true;
    return {
      open_lead_form: stuck, reply_he: stuck && !knowledgeFollowup
        ? puzzled + String.fromCharCode(10) + offline.noMatchAnswer()
        : puzzled,
      model_used: false,
      pending_parameter: 'adults', slots, cards: [], two_room_splits: [],
      notes: [], relaxed: [],
      chips: ['2 נוסעים', '3 נוסעים', '4 נוסעים', '5+ נוסעים'],
      chip_to_pref: CHIP_TO_PREF,
    };
  }
  if ((offline.isGreeting(lastUser) || !lastUser.trim() || onTopicHello) && nothingKnown) {
    slots._lastQuestion = 'adults';
    return {
      open_lead_form: false,
      reply_he: guidance.msg('greeting', 'היי! אני פינגי, ואני כאן כדי לבנות לכם את חופשת הסקי שמתאימה לכם ביותר.\n' +
        'כדי שאתאים אותה בדיוק לכם — כמה תהיו בסך הכל, ונוסעים גם ילדים?'),
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
  // (wantsToSee is computed above, before the off-topic verdict)
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
  // "זוג, ינואר, מה יש?" — who and when are known and the customer asked to
  // see: show, and ask the country underneath (S17, 06/09 smoke — it asked
  // the country first and showed nothing).
  // The cap opens the door for a customer who has told us SOMETHING and is
  // tired of questions — never for one who has said nothing at all: "??",
  // "סקי", "לא יודע", "כן" produced three arbitrary hotels for five people
  // (13/09). With neither a party nor a date, the door stays shut and the
  // question is put again, however many turns it takes.
  const anythingKnown = partyKnown || whenKnown || !!slots.country || !!slots.destination || !!slots.hotel;
  const askedEnough = (anythingKnown && (questionsAsked >= MAX_QUESTIONS || held >= holdLimit)) ||
    (wantsToSee && partyKnown && whenKnown);
  // The gate holds the FIRST offers back; it never takes offers away. A
  // customer who has already seen three cards and then answers a question is
  // giving us more, and watching the offers vanish reads as going backwards —
  // it turned up the moment this was tested as a conversation ("אוסטריה או
  // בולגריה למשפחה?" → offers, then "2 מבוגרים וילד בן 7" → nothing).
  const alreadySawOffers = (prevSlots._shown || []).length > 0;
  // With nothing known there is always a question to ask — even when the
  // ladder has already asked it twice and went quiet ("כן" after "??", "סקי",
  // "לא יודע" showed two hotels because no question was left, 13/09)
  if (!anythingKnown && !tailQuestion && !alreadySawOffers && cards.length > 0) {
    tailQuestion = guidance.msg('not_understood',
      'לא בטוח שהבנתי. כתבו לי כמה אתם נוסעים ומתי בערך — בין דצמבר למרץ — ואבנה לכם אפשרויות.');
  }
  const holdingForDetails = !knowsEnough && !askedEnough && !alreadySawOffers &&
    !!tailQuestion && cards.length > 0;
  slots._held = holdingForDetails ? held + 1 : held;
  slots._showMe = askedForOffers && !knowsEnough;
  if (holdingForDetails) cards = [];
  // A conduct refusal (write me an approval, give me another customer's phone,
  // a pasted card number) is the whole answer. Three hotels under it read as
  // "…but anyway, here is what we have" — the refusal loses its weight.
  // The price rule is different: that one is answered with the cards on purpose.
  const conductRefusal = !!guarded && !!offline.guard(lastUser) && !/המחיר המדויק לחדר/.test(guarded);
  if (conductRefusal) cards = [];
  // A complaint is answered with a human word and a rep — not with three
  // hotels underneath it ("המלון היה מלוכלך" → cards, 06/09). Sunny does the
  // same: apology, the channel, and only then an OFFER to continue, no offers.
  if (faqHit && faqHit.id === 'complaint' && !offline.wantsMore(lastUser)) cards = [];
  // Holding the offers back must not swallow the off-topic line: "תן לי מתכון
  // לעוגה" used to get three hotels and a redirect, and would now get only
  // "כמה תהיו?" — as if a cake recipe were a step in booking a holiday.
  const understoodSomething = slotsChanged(prevSlots, slots) || !!faqHit || !!deflection ||
    // a question the hotel cards answer is understood, even before any card is
    // on screen — it was still getting "אני כאן בעיקר להתאמת חופשות סקי"
    cardTopicAsked ||
    wantsToSee || offline.isGreeting(lastUser) || justSwitchingToHebrew ||
    (slots.notes_from_customer || []).length > (prevSlots.notes_from_customer || []).length ||
    (slots.preferences || []).length > (prevSlots.preferences || []).length;
  // …but say it once. Step 3 already puts the line in the preamble when the
  // message is off topic, and a customer who asked for a cake recipe got the
  // same sentence twice, one under the other.
  // הצד השני של אותו באג (סאני נופלת עליו גם): הודעה שגם מילאה פרט וגם שאלה
  // שאלה — "הקייטנה מגיל 4?" — מילוי הפרט נחשב "הבנו" והשאלה נעלמה בשקט.
  // 37 שאלות בבנק קיבלו רק "כמה תהיו?" (31/08). אם יש סימן שאלה ואף שכבה לא
  // ענתה — אומרים זאת, במקום להעלים.
  const questionAsked = /\?/.test(lastUser) && !offline.isGreeting(lastUser) && !wantsToSee &&
    !faqHit && !deflection && !dateFacts && !recAnswer && !cardTopicAsked && !guarded;
  if (holdingForDetails && understoodSomething && questionAsked && slotsChanged(prevSlots, slots) &&
      !preamble.includes('אין לי תשובה מוכנה')) {
    preamble = [preamble, guidance.msg('question_swallowed',
      'רשמתי את הפרטים. על השאלה עצמה אין לי תשובה מוכנה — נסחו אותה במשפט נפרד ואבדוק שוב, ומה שלא אדע נציג ישלים.')].filter(Boolean).join(String.fromCharCode(10));
  }
  if (holdingForDetails && !understoodSomething && lastUser.trim() && !preamble.includes(OFF_TOPIC_HE) &&
      !preamble.includes(FOLLOWUP_UNKNOWN_HE) && !preamble.includes(SENT_BY_MISTAKE_HE)) {
    // A holiday-domain question we failed to parse is OUR gap, not the
    // customer's: own it with "לא בטוח שהבנתי", never with "לא התחום שלי".
    // 21 bank questions about equipment, altitude and flights were being
    // told they were off topic here (31/08).
    // a one-word "כן" / "לא" / "אוקיי" with nothing known is not off topic and
    // not a question — the opening question underneath is the whole reply
    const bareWord = /^[\s!.?]*(?:כן|לא|אוקיי|אוקי|בסדר|סבבה|טוב|יאללה|נו|אה|אהה|המ|הממ)[\s!.?]*$/.test(lastUser);
    const line = bareWord && !anythingKnown ? null
      : knowledgeFollowup ? FOLLOWUP_UNKNOWN_HE : DOMAIN_HE.test(lastUser)
      ? guidance.msg('not_understood_domain',
          'לא בטוח שהבנתי למה הכוונה — אפשר לכתוב את השאלה במשפט אחד ואענה, ומה שלא אדע נציג ישלים.')
      : OFF_TOPIC_HE;
    preamble = [preamble, line].filter(Boolean).join(String.fromCharCode(10));
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
  // two on screen, the third held in reserve for "עוד אפשרות" (see CARDS_DEFAULT).
  // Only what is SHOWN is remembered as shown — the widget adds the spare to
  // `_shown` itself when it reveals it, so "יש עוד?" never repeats a card.
  const spareCards = cards.slice(CARDS_DEFAULT);
  cards = cards.slice(0, CARDS_DEFAULT);
  slots._shown = [...new Set([...seenBefore, ...cards.map(c => c.hotel + '|' + c.date)])].slice(-30);
  // what is ON SCREEN now — not the last three of everything ever shown.
  // "איזה מהם הכי קרוב למסלולים?" over two French offers used to compare a
  // Bansko hotel from two searches ago as well (13/09)
  if (cards.length) slots._on_screen = [...new Set(cards.map(c => c.hotel))].slice(0, 6);
  else if (prevSlots._on_screen) slots._on_screen = prevSlots._on_screen;
  // Remember the cheapest band actually put in front of the customer, so that
  // "יקר לי" on the next turn can be answered with something genuinely cheaper
  // rather than a reshuffle of the same prices.
  {
    // only classified cards set the floor "יקר לי" is answered against —
    // an unknown band is not evidence that anything cheaper exists
    const bands = cards.map(c => (c.price_range || '').length).filter(n => n > 0);
    if (bands.length) slots.shown_price_min = Math.min(...bands);
  }
  // remembered for composeReply: an objection turn is answered by the
  // objection lines, not by the where-the-price-lives line on top (13/09)
  const priceObjected = !!slots.price_objection;
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
  // what a chain's price buys — said once per chain, when one of its hotels
  // is on screen (Tomer, 13/09: "זה ממש חשוב למכירה ומסביר את המחיר")
  const highlightLines = [...new Map(cards.filter(c => c.highlight_long_he)
    .map(c => [c.highlight_group, c.highlight_long_he])).values()];
  // "יקר לי" over a Belambra or Club du Soleil offer: before anything
  // cheaper, what that price actually bought — the offer they called
  // expensive is the one that was on screen, not the one replacing it
  const worthLines = [];
  if (priceObjected) {
    const keys = Object.keys(engine.resorts.hotels || {});
    for (const d of onScreenHotels(prevSlots)) {
      const k = keys.find(x => displayHotel(x) === d);
      const h = k && offline.groupHighlight(k, (engine.hotelInfo(k) || {}).board_he);
      if (h && !worthLines.includes('שימו לב מה כלול במחיר: ' + h.long_he)) worthLines.push('שימו לב מה כלול במחיר: ' + h.long_he);
    }
  }
  const fixedRaw = holdingForDetails
    ? [yearLine, offCommLine]
    : [yearLine, offCommLine, ...worthLines, cmpLine, monthsLine, ...widened, ...highlightLines];
  const fixed = fixedRaw.filter(Boolean).filter(l => !saidFixed.has(l));
  slots._fixed_said = [...saidFixed, ...fixedRaw.filter(Boolean)].slice(-8);
  if (fixed.length) preamble = [preamble, ...fixed].filter(Boolean).join(String.fromCharCode(10));

  // A per-hotel question asked before any offer is on screen: understood, but
  // nothing here can answer it yet. Say where the answer will be rather than
  // "לא בטוח שהבנתי" — the bot understood the question perfectly ("מקררון?"
  // on an empty chat, 30/08 live run).
  let pointedAtCards = false;
  // a QUESTION about a per-hotel topic — "רוצים משהו מפנק עם ספא" is a wish,
  // and answering it with "זה משתנה ממלון למלון" reads as a shrug (13/09)
  const askedIt = /\?/.test(lastUser) || /^\s*(?:יש|האם|מה|איך|כמה|איפה|אפשר)(?![א-ת])/.test(lastUser);
  if (cardTopicAsked && askedIt && !faqHit && !deflection && !cards.length &&
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
  // שורת דירוג של יותר ממלון אחד עונה גם על "מה עדיף X או Y" וגם על "מה
  // הדירוג" — שתי שאלות, תשובה אחת; בלעדיה נוספה שורת "שאלתם עוד דבר".
  const ratingAnswers = (faqHit && faqHit.id === 'hotel_ratings' &&
    (faqHit.he.match(/^• /gm) || []).length > 1) ? 1 : 0;
  const answersGiven = (faqHit ? Math.max(1, (faqHit.all || []).length) : 0) +
    (deflection ? 1 : 0) + (dateFacts ? 1 : 0) + (recAnswer ? 1 : 0) +
    (pointedAtCards ? 1 : 0) + ratingAnswers;
  const droppedHe = droppedQuestionLine(lastUser, multiPart, answersGiven, guarded);
  if (droppedHe && !preamble.includes(droppedHe)) {
    preamble = [preamble, droppedHe].filter(Boolean).join(String.fromCharCode(10));
  }

  // Offers held back for now (Tomer, 25/08): the reply is the question, and
  // nothing that describes a list the customer cannot see — and certainly not
  // "לא מצאתי התאמה", which would be a lie about a search that did find some.
  const CARDS_FLOOR_HE = guidance.msg('cards_floor', 'הנה מה שבניתי לכם — הנציג יאשר סופית:');
  let templated;
  try {
    // two-room splits are offers too: "לא מצאתי התאמה" above three of them
    // was a lie about a search that found some (7 friends, 13/09)
    const anySplit = (result.two_room_splits || []).length > 0;
    templated = holdingForDetails ? '' :
      (offline.phrase(result, sayingSlots, cards) ||
        (cards.length ? CARDS_FLOOR_HE : anySplit ? '' : offline.noMatchAnswer()));
  } catch (e) {
    // the template builder is deterministic, but it reads a dozen optional
    // shapes off the result; one unexpected null must not cost the offers
    console.error('template phrasing failed:', e.message);
    templated = cards.length ? CARDS_FLOOR_HE : FALLBACK_HE();
  }
  // remember which requirements were read back, so they are read back once
  {
    const m = String(templated).match(/לקחתי בחשבון: ([^\n]+?)\./);
    const items = m ? m[1].split(', ') : [];
    slots._applied_said = [...new Set([...(prevSlots._applied_said || []), ...items])].slice(-12);
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
  // A hotel profile from the pages is complete too: the model's paragraph
  // under it re-told the comparison and got it wrong ("בריכה מופיעה רק
  // ב־Berghof" under a line saying Sport has one — S14, 06/09 smoke), and the
  // dedupe then stripped the profile lines it had paraphrased.
  const NO_PARAGRAPH_AFTER = new Set(['compare', 'compare_countries', 'recommend', 'complaint',
    'my_booking', 'special_needs', 'name_change', 'lead_commitment', 'bot_or_human',
    'hotel_characterization', 'hotel_facility_facts', 'hotel_ratings']);
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
  // a customer who has said nothing usable yet is not handed over on the second
  // try — a person still finding the words is not a lost cause (13/09)
  const saidSomething = slots.adults != null || (slots.children_ages || []).length || slots.month != null ||
    !!slots.country || !!slots.destination || !!slots.hotel;
  const lostNudge = lostNow && slots._lost >= (saidSomething ? 2 : 3) && !prevSlots._nudged;
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
    // a preference the reply already expressed in other words is covered:
    // "החסכוניות קודם" IS the budget (it was echoed a third time, 13/09)
    const SYNONYM = { 'תקציב': /חסכוני|זול|תקציב/, 'מתחילים': /מתחיל/, 'משפחות': /משפח/ };
    const mentions = (label) => {
      if (saidSoFar.includes(label)) return true;
      if (SYNONYM[label] && SYNONYM[label].test(saidSoFar)) return true;
      const words = String(label).split(/[\s\-()]+/)
        .filter(w => w.length >= 3 && !['או', 'עם', 'בלי', 'מלון', 'חדר'].includes(w));
      if (!words.length) return saidSoFar.includes(label);
      const hits = words.filter(w =>
        saidSoFar.includes(w) || saidSoFar.includes(w.replace(/^[לבמהו]/, ''))).length;
      return hits >= Math.max(1, Math.ceil(words.length / 2));
    };
    const coverage = [];
    // "משפחה, 2 ילדים" was read as two parents: say so once, so the family of
    // three adults corrects it in a word (13/09)
    if (slots.adults_assumed && !prevSlots.adults_assumed && slots.adults === 2) {
      const kids = (slots.children_ages || []).length || slots.children_count || 0;
      coverage.push('הנחתי 2 מבוגרים' + (kids ? ' ו-' + kids + ' ילדים' : '') + ' — אם ההרכב שונה, כתבו לי.');
    }
    if (cards.length || holdingForDetails) {
      const newPrefs = (slots.preferences || [])
        .filter(p => !(prevSlots.preferences || []).includes(p))
        // "משפחות" is who they are, not a wish they asked us to weigh (13/09)
        .filter(p => p !== 'משפחות')
        .filter(p => !mentions(p));
      if (newPrefs.length) {
        coverage.push('לקחתי בחשבון: ' + newPrefs.join(', ') + '.');
        slots._applied_said = [...new Set([...(slots._applied_said || []), ...newPrefs])].slice(-12);
      }
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
        // "כל מה שמוצג" while the offers are still held back is a claim about
        // nothing (S20, 06/09 smoke) — before the cards it is a promise
        applied.push(holdingForDetails ? 'אסנן יציאות בשבת — אציג רק יציאות בימים אחרים'
          : 'סיננתי יציאות בשבת — כל מה שמוצג יוצא בימים אחרים');
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
      /* "does the reply already SAY this" — not "does the word camp appear".
         The broad substring test suppressed the claim whenever the model's
         wording happened to mention the club at all, which is most turns where
         a club was asked for; the customer then saw offers with no word about
         whether the filter ran (seen live 31/08). This asks whether the reply
         already makes a filtering claim about the camp. */
      const claimsCampFilter = /(?:הצגתי|סיננתי|מסונן|רק שבועות|רק תאריכים)[^.]{0,40}(?:קייטנ|קבוצ)|(?:קייטנ|קבוצ)[^.]{0,40}(?:הצגתי|סיננתי|מסונן|פועלת בכל|לא פועלת)/;
      const saysCampUnchecked = /לא נבדק|עוד לא בדקתי|אינן מסוננות/;
      if (slots._camp_unavailable && !prevSlots._camp_unavailable &&
          !claimsCampFilter.test(saidSoFar) && !saysCampUnchecked.test(saidSoFar)) {
        applied.push(guidance.msg('camp_none_in_scope',
          'שימו לב: בתאריכים שמצאתי אין שבוע שבו פועלת קייטנה בעברית לגילאים שלכם'));
      }
      const campRan = cards.length > 0 &&
        cards.every(c => c.camps && (c.camps.running || []).length > 0);
      const campFullyCovered = campRan &&
        cards.every(c => !((c.camps || {}).missing || []).length);
      if (campFullyCovered && !claimsCampFilter.test(saidSoFar)) {
        applied.push('הצגתי רק שבועות שבהם הקייטנה בעברית פועלת');
      }
      if (slots.departure_airport && slots.departure_airport !== 'any' &&
          !/חיפה|נתב/.test(saidSoFar)) {
        applied.push(holdingForDetails ? 'אסנן לפי שדה היציאה שביקשתם' : 'סיננתי לפי שדה היציאה שביקשתם');
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
    // …and not on a "הכי זול" turn the sort line already answered — the bands
    // are on the cards; the money-lives-on-the-booking-screen line stays for a
    // real price question ("כמה עולה?", "מה המחיר?")
    const sortedByBudget = /החסכוניות קודם/.test([preamble, intro].filter(Boolean).join(' ')) &&
      !/כמה עולה|מחיר|כמה זה/.test(lastUser);
    // On a "הכי זול" turn the sort line already speaks about price, so only
    // the short half (where the exact number lives — red rule 3) follows it;
    // on an objection turn the objection lines are the whole answer.
    const priceLine = cards.length && MONEY_Q.test(lastUser) && !priceObjected &&
      !/מסך ההזמנה|המחיר המדויק/.test([preamble, intro].filter(Boolean).join(' '))
      ? (anyBand && !sortedByBudget
        ? 'טווח המחיר מסומן על כל הצעה, והמחיר המדויק לתאריך ולחדר שלכם מופיע במסך ההזמנה — נציג מאשר אותו סופית.'
        : 'המחיר המדויק לתאריך ולחדר שלכם מופיע במסך ההזמנה — נציג מאשר אותו סופית.')
      : null;
    // "בעצם אנחנו 3 מבוגרים, לא זוג" after the cards: the search re-ran, and
    // the customer should hear that it did — a reply that only asks "איזו
    // מההצעות מדברת אליכם?" reads as not having heard the correction
    // (Sunny confirms the change in words before searching again; 06/09).
    let updateLine = null;
    if (alreadySawOffers && cards.length) {
      const ch = [];
      if (slots.adults != null && prevSlots.adults != null && slots.adults !== prevSlots.adults) ch.push(slots.adults === 1 ? 'נוסע אחד' : slots.adults + ' מבוגרים');
      const k0 = (prevSlots.children_ages || []).join(','), k1 = (slots.children_ages || []).join(',');
      if (k0 && k1 && k0 !== k1) ch.push('ילדים בגילאי ' + (slots.children_ages || []).join(', '));
      if (typeof slots.month === 'number' && typeof prevSlots.month === 'number' && slots.month !== prevSlots.month && ECHO_MONTH_HE[slots.month]) ch.push(ECHO_MONTH_HE[slots.month]);
      if (slots.country && prevSlots.country && slots.country !== prevSlots.country && slots.country !== 'any' && ECHO_COUNTRY_HE[slots.country]) ch.push(ECHO_COUNTRY_HE[slots.country]);
      if (ch.length) updateLine = guidance.msg('search_updated', 'עדכנתי — {changes} — וחיפשתי מחדש:').replace('{changes}', ch.join(', '));
    }
    // "עדכנתי — צרפת — וחיפשתי מחדש" opens: the search moved, then what it found
    const parts = [updateLine, preamble, intro, contrast, priceLine, ...coverage, tailQuestion].filter(Boolean);
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
    // When the workbook has not reached us for a while, say so in the customer's
    // terms rather than in ours: the rooms were free at the last update and
    // availability moves (Tomer, 26/08). One line, only with offers on screen,
    // and only when it is actually true — a line the customer sees every time
    // is a line they stop reading.
    if (anyOffer && inventory.stale(engine.av)) {
      const moving = (guidance.load().messages_he || {}).inventory_moving_he;
      if (moving && !parts.some(x => String(x).includes(moving.slice(0, 20)))) parts.push(moving);
    }
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
    // "הצגתי רק שבועות שבהם הקייטנה" was in this list and should not have been:
    // it is not coaching, it is the answer to the thing the family chose the
    // week FOR. The other entries here are all wording the reply can lose.
    const SOFT2 = /לקחתי בחשבון|ציינתם .+ או|בטווח המחיר הנמוך מבין|טווח המחיר מסומן|איזו מההצעות|רוצים שאדייק|מתלבטים בין שתיים|רוצים שאבדוק גם/;
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
      let fresh = all.filter(l => !alreadySaid.has(l) || mustKeep.has(l));
      // The same FAQ two turns running, above the same cards: the paragraph
      // is dropped as a repeat (right), but the customer's new question then
      // got only "איזו מההצעות מדברת אליכם?" (P06 "יש מה לעשות לנו באתר?",
      // 03/09). Say that this IS the answer, as the no-cards path already does.
      if (faqHit && !faqSuppressed && faqHit.id === prevSlots._lastFaqId &&
          !fresh.some(l => faqHit.he.includes(l))) {
        fresh = [repeatAnswer(lastUser, faqHit.he, guidance.msg('same_answer_again',
          'עניתי על זה למעלה, וזה כל מה שיש לי על הנושא. אם חסר לכם פרט ספציפי — כתבו אותו ואעביר לנציג.')), ...fresh];
      }
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
    // a conduct refusal stands alone — no "לא מצאתי התאמה" under it, no
    // coaching about dates: the customer asked for something we do not do
    if (conductRefusal) all = (deflection || '').split(String.fromCharCode(10)).filter(Boolean);
    // ...and so does a complaint: the apology and the rep, nothing about
    // which weeks the camp runs underneath
    if (faqHit && faqHit.id === 'complaint' && !cards.length) {
      all = [social, faqHit.he].filter(Boolean).join(String.fromCharCode(10)).split(String.fromCharCode(10)).filter(Boolean);
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
  // The editor: a conduct refusal stands as written, a complaint keeps its
  // exact wording, everything else becomes one answer — on turns WITH offers
  // too (Tomer, 06/09 evening, after seeing Sunny's one-paragraph replies
  // next to ours: the model's intro + "חסר לי פרט אחד:" + the closing line,
  // three seams). The price rule is not a conduct refusal: it is answered
  // with the cards on purpose, and the guard keeps "מסך ההזמנה" in the edit.
  // A hotel profile is complete as written (see NO_PARAGRAPH_AFTER).
  const profileTurn = !!faqHit && ['hotel_characterization', 'hotel_facility_facts', 'hotel_ratings'].includes(faqHit.id);
  if (!conductRefusal && !(faqHit && faqHit.id === 'complaint') && !(guarded && !cards.length) && !profileTurn) {
    const prevAssistantMsg = [...messages].slice(0, -1).reverse().find(m => m.role === 'assistant');
    const edited = await composeWithModel({
      replyText, lastUser, digest: partyDigest(slots), deadline, knownNames: KNOWN_NAMES,
      knowledge: !!faqHit || !!dateFacts || !!recAnswer || /אין לי תשובה מאושרת/.test(replyText) || cards.length > 0,
      question: replyIfNotReady || tailQuestion || null,
      lastReply: prevAssistantMsg ? String(prevAssistantMsg.content || '') : '',
      cardsShown: cards.map(c => c.hotel),
    });
    if (edited !== replyText) { replyText = edited; modelUsed = true; }
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

  // With offers on screen the chips are for exploring — and eleven of them
  // (two airports, four countries, five wishes) were a menu nobody reads
  // (13/09, played as a customer). The row now carries only what would change
  // THESE offers: the gaps that matter most (party, month, country), then the
  // wishes not yet asked for, at most six in all. Airports ride only when
  // nothing bigger is missing. After "יקר לי" the chips are the price levers
  // themselves — one tap moves the search, instead of a wish list beside a
  // sentence about price.
  const exploringChips = () => {
    const active = new Set(slots.preferences || []);
    if (priceObjected) {
      const levers = [];
      const nightsAsked = slots.nights_wanted || (cards[0] && cards[0].nights) || 7;
      if (nightsAsked > 3 && (!slots.country || slots.country === 'bulgaria')) levers.push('3 לילות בבנסקו');
      const hol = slots.holiday && slots.holiday !== 'any';
      if (hol || slots.month === 2 || slots.month === 12) levers.push('ינואר', 'מרץ');
      const cheap = c => ['bulgaria', 'andorra'].includes(c);
      if (slots.country ? !cheap(slots.country) : !cards.every(c => cheap(c.country))) {
        const ex = slots.excluded_countries || [];
        if (!ex.includes('bulgaria') && slots.country !== 'bulgaria') levers.push('בולגריה');
        if (!ex.includes('andorra') && slots.country !== 'andorra') levers.push('אנדורה');
      }
      if (levers.length) return [...levers, ...(active.has('מתחילים') ? [] : ['מתאים למתחילים'])].slice(0, 6);
    }
    const big = gapChips.filter(c => !/טיסה/.test(c));
    const wishes = CHIP_LABELS.filter(l => !active.has(CHIP_TO_PREF[l]));
    // the airport is the one parameter still gathered once the essentials are
    // in (Tomer 30/08) — it leads the row then, and never appears as one lone
    // half of a pair
    const airports = big.length ? [] : gapChips.filter(c => /טיסה/.test(c));
    return [...big, ...airports, ...wishes].slice(0, 6);
  };

  // the question this turn actually ended on: the blocking one if we held the
  // offers back, otherwise the one that rode along under them
  const askedNow = replyIfNotReady || tailQuestion || null;
  const askedKey = slots._lastQuestion || (pendingQuestion && pendingQuestion.key) || null;
  const focusedChips = cards.length ? null : chipsForQuestion(askedNow, askedKey);

  // A request to be called back opens the form, on the offer they were looking
  // at if there is one. Telling someone where to find a button is not service.
  slots._lastFaqId = faqHit ? faqHit.id : null;
  slots._lastGuard = guarded || null;
  const askForDetails = offline.wantsCallback(lastUser) || lostNudge || exhaustedNudge ||
    !!(faqHit && faqHit.open_form);

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
    spare_cards: spareCards,
    two_room_splits: (result.two_room_splits || []).map(sp => ({ ...sp, hotel: displayHotel(sp.hotel) })),
    notes: result.notes, relaxed: result.relaxed,
    // with offers on screen the chips are for exploring; with a question on
    // screen they are for answering it
    chips: cards.length ? exploringChips() : (focusedChips || gapChips),
    chip_to_pref: CHIP_TO_PREF,
    // how the turn was decided — for the question-bank harness only, never
    // shown to customers (tests/test-bank.js sets BANK_DEBUG=1)
    ...(process.env.BANK_DEBUG ? { debug: {
      answered_by: guarded ? 'guard' : deflection ? 'deflect' : faqHit ? (faqHit.routed ? 'router' : 'faq') : dateFacts ? 'dates' : pointedAtCards ? 'cards' : null,
      faq_ids: faqHit ? (faqHit.all || [faqHit]).map(a => a.id) : [],
      guard: guarded || null, off_topic: !!offTopic, not_understood: !!(offTopic && !deflection && !faqHit),
      pending: pendingQuestion ? pendingQuestion.key : null,
      // why the offers were (not) held this turn — read by tests/test-personas.js
      gate: { knowsEnough, askedEnough, held, questionsAsked, holding: holdingForDetails,
        tail: tailQuestion ? String(tailQuestion).slice(0, 40) : null, pendingKey: pendingKey || null,
        modelQ: replyIfNotReady ? String(replyIfNotReady).slice(0, 40) : null,
        month: slots.month ?? null, flex: slots.flexible_dates ?? null, country: slots.country ?? null,
        destination: slots.destination ?? null, adults: slots.adults ?? null, kids: slots.children_ages || [],
        prefs: slots.preferences || [], sawOffers: alreadySawOffers, askedBefore: [...askedBefore] },
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
    // The office pushes a new inventory file here. Not a browser request: no
    // Origin, no CORS, no rate limit by IP — it is authorised by a token and
    // by what it contains (server/inventory.js). Answered before the
    // origin-required rule below, which exists for the widget.
    if (req.method === 'POST' && url.pathname === '/api/inventory') {
      const body = await readJson(req, 8_000_000);
      if (!body) return;
      const r = inventory.accept(req, body);
      return json(res, r.status, r.body);
    }
    if (req.method === 'GET' && url.pathname === '/api/inventory') {
      // for the push script and for a human: how old is what we are selling
      const av = inventory.current();
      const h = inventory.ageHours(av);
      return json(res, 200, {
        generated_at: (av && av.generated_at) || null,
        age_hours: h == null ? null : Math.round(h * 10) / 10,
        stale: inventory.stale(av), stale_after_hours: inventory.STALE_HOURS,
        // no token configured: this server takes an update from its own
        // machine only, and the page can stop asking for a key
        local_only: inventory.localOnly(),
        units: (av && av.units || []).length, last_push: inventory.lastPush(),
      });
    }
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
        board: txt(rawCtx.board, 60),          // the board the customer chose on the card (10/09)
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
    /* The four modules the inventory page needs, wrapped so a browser can load
       server code unchanged. An allowlist and nothing else — a route that
       served any path under the repo would be a way to read .env.
       Why not a copy of the parser written for the browser: because then a
       workbook parsed in Chrome and one parsed by the build could disagree,
       and whichever the office happened to use that morning would decide what
       the bot sells. */
    const BROWSER_MODULES = ['tools/xlsx-read.js', 'data/inventory.js',
      'data/aggregate.js', 'data/pii-gate.js'];
    if (req.method === 'GET' && url.pathname.startsWith('/mod/')) {
      const id = url.pathname.slice(5);
      if (!BROWSER_MODULES.includes(id)) { res.writeHead(404); res.end(); return; }
      let src;
      try { src = fs.readFileSync(path.join(ROOT, id), 'utf8'); }
      catch (e) { res.writeHead(404); res.end(); return; }
      // a CommonJS shim: node's own ids resolved against this small map, and
      // fs/zlib/path stubbed because the browser never reaches the code paths
      // that use them (it brings its own unzip)
      const wrapped = 'window.__mods[' + JSON.stringify(id) + '] = (function(){\n'
        + 'var module={exports:{}},exports=module.exports;\n'
        + 'function require(id){\n'
        + '  if(id==="path")return{join:function(){return Array.prototype.join.call(arguments,"/")},'
        + 'basename:function(p){return String(p).split(/[\\\\/]/).pop()}};\n'
        + '  if(id==="fs"||id==="zlib")return{};\n'
        + '  var k=String(id).replace(/^\\.\\.\\//,"").replace(/^\\.\\//,"");\n'
        + '  for(var m in window.__mods){if(m===k||m.endsWith("/"+k))return window.__mods[m];}\n'
        + '  throw new Error("no module "+id);\n'
        + '}\n' + src + '\nreturn module.exports;})();\n';
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(wrapped);
      return;
    }

    // static
    let file = url.pathname === '/inventory' ? '/public/inventory-upload.html'
      : url.pathname === '/' ? '/public/demo.html'
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
module.exports = { handleChat, server, requiredMissing, partyDigest };
