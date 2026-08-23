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
const PORT = +(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');
const engine = new SkiSearch();

const EMPTY_SLOTS = {
  adults: null, children_ages: [], no_children: null, month: null,
  flexible_dates: null, country: null, destination: null,
  departure_airport: null, needs_hebrew_kids_club: null, preferences: [],
  excluded_countries: [], off_commitment_destination: null, off_commitment_country: null, out_of_season: false,
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
    off_commitment_destination: slots.off_commitment_destination || null,
    off_commitment_country: slots.off_commitment_country || null,
    out_of_season: !!slots.out_of_season,
  };
}

/* ---------- token economy: when is the model actually worth calling? ----------
   The Hebrew regex layer runs first and costs nothing. We only pay for a model
   call when that layer learned nothing from this message — i.e. the customer
   phrased something we don't recognise. Simple turns ("4 ו-9", "ינואר",
   "בלי ילדים", chip clicks) never reach the model at all. */
function slotsChanged(before, after) {
  const keys = ['adults', 'children_ages', 'children_count', 'no_children', 'month',
    'flexible_dates', 'country', 'destination', 'departure_airport', 'needs_hebrew_kids_club',
    'excluded_countries'];
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return true;
  return (after.preferences || []).length !== (before.preferences || []).length;
}
function shouldAskModel(before, after, text) {
  const t = (text || '').trim();
  if (!t || t.length <= 2) return false;              // "כן" / "לא" / "2"
  const words = t.split(/\s+/).length;
  // nothing was understood — the phrasing is outside the regex vocabulary
  if (!slotsChanged(before, after)) return true;
  // a long message usually carries more than the one thing we matched; pay for
  // it only while blocking slots are still open, so refinements stay free
  if (words >= 8 && requiredMissing(after).length > 0) return true;
  return false;
}

async function fillSlotsWithModel(messages, prevSlots, questionsAsked) {
  // only the last few turns are sent — older ones are already folded into slots
  const recent = messages.slice(-4);
  const payload = [
    ...recent,
    { role: 'user', content: `slots: ${JSON.stringify(prevSlots)}\nשאלות שנשאלו: ${questionsAsked}/${MAX_QUESTIONS}\nהחזר JSON.` },
  ];
  const raw = aiMode() === 'openai'
    ? await callOpenAI({ system: SLOT_PROMPT_LEAN, messages: payload, maxTokens: 400 })
    : await callClaude({ system: SLOT_PROMPT_LEAN, messages: payload, maxTokens: 400 });
  return parseModelJSON(raw);
}

function presentCards(result, slots) {
  // top 3 for display; ranked by the deterministic sort, but prefer showing
  // three DIFFERENT hotels before a second room of the same hotel
  const seen = new Set(), diverse = [];
  for (const c of result.candidates) if (!seen.has(c.hotel)) { diverse.push(c); seen.add(c.hotel); }
  for (const c of result.candidates) if (!diverse.includes(c)) diverse.push(c);
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
        slots = { ...slots, ...parsed.slots };
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
  const offTopic = lastUser && !slotsChanged(prevSlots, slots) && !modelUsed &&
    /\?|איך|מה |למה|מי /.test(lastUser) &&
    !/סקי|חופש|מלון|טיסה|קייטנ|יעד|תאריך|חודש|ילד|נוסע|מחיר|חדר|שלג|פינגווין/.test(lastUser);

  // ---- step 3: what to ask next (same logic whichever layer filled slots) ----
  // Only BLOCKING gaps hold results back. The rest (departure airport,
  // destination) are gathered after the customer has seen something concrete —
  // being interviewed before any offer is what makes a bot feel like a form.
  let pendingQuestion = null;
  if (!replyIfNotReady) {
    const q = offline.nextQuestion(slots, prevSlots._lastQuestion || null);
    if (q && q.blocking) { slots._lastQuestion = q.key; replyIfNotReady = q.he; }
    else { pendingQuestion = q; delete slots._lastQuestion; }
  }

  const OFF_TOPIC_HE = 'אני כאן בעיקר להתאמת חופשות סקי של פינגווין. לשאלות אחרות נציג ישמח לעזור ב-04-8557722.';
  const SEASON_HE = 'עונת הסקי שלנו היא דצמבר עד סוף מרץ — בחודשים אחרים אין לנו יציאות.';
  // a direct answer to a direct question (exact price, other customers'
  // bookings) — showing offers again instead would read as evasion
  const deflection = offline.deflect(lastUser);
  const preamble = [
    deflection,
    offTopic && !deflection ? OFF_TOPIC_HE : null,
    slots.out_of_season ? SEASON_HE : null,
  ].filter(Boolean).join('\n');

  const mustSearch = replyIfNotReady == null || questionsAsked >= MAX_QUESTIONS;
  if (!mustSearch) {
    return {
      reply_he: (preamble ? preamble + '\n' : '') + replyIfNotReady,
      slots, cards: [], chips: [], model_used: modelUsed,
    };
  }
  if (mustSearch && replyIfNotReady) { pendingQuestion = null; delete slots._lastQuestion; }

  // ---- deterministic search (no AI, ever) ----
  const result = engine.search(toSearchSlots(slots));
  const cards = presentCards(result, slots);

  // ---- phrasing is templated, not generated ----
  // This halves the token bill, and it is also the strongest safety property
  // in the system: the model never sees the inventory, so it cannot invent a
  // hotel, a date, a price or an availability claim. Every word on a card
  // comes from the workbook or from pingwin.co.il.
  const intro = offline.phrase(result, slots, cards) ||
    (cards.length ? 'הנה מה שנראה פנוי אצלנו — הנציג יאשר סופית:' :
      'לא מצאתי התאמה מדויקת — נציג ישמח לעזור: 04-8557722');

  // still-unknown matching parameters ride along as one-tap chips, so the
  // customer completes the picture by choosing rather than by being asked
  const gapChips = [];
  if (slots.departure_airport == null) gapChips.push('טיסה מנתב"ג', 'טיסה מחיפה');
  if (slots.country == null && slots.destination == null) {
    const ex = slots.excluded_countries || [];
    const byHe = { 'אוסטריה': 'austria', 'צרפת': 'france', 'אנדורה': 'andorra', 'בולגריה': 'bulgaria' };
    for (const [he, code] of Object.entries(byHe)) if (!ex.includes(code)) gapChips.push(he);
  }

  return {
    // the remaining parameters are offered as chips, not asked as a question —
    // a customer looking at three real offers should not also face an interview
    reply_he: (preamble ? preamble + '\n' : '') + intro,
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
