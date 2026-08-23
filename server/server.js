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
const { SLOT_PROMPT, PHRASE_PROMPT } = require('./prompts.js');
const offline = require('./offline-nlu.js');
const { SkiSearch } = require('../data/filter.js');
const { buildBookingUrl } = require('../config/booking-url.js');

loadEnv();
// no API key → free offline demo mode (regex NLU, template phrasing).
// add a key to .env and restart to upgrade to Claude automatically.
function aiMode() {
  const k = process.env.ANTHROPIC_API_KEY;
  return k && !k.includes('xxxx') ? 'claude' : 'offline';
}
const PORT = +(process.env.PORT || 8787);
const ROOT = path.join(__dirname, '..');
const engine = new SkiSearch();

const EMPTY_SLOTS = {
  adults: null, children_ages: [], no_children: null, month: null,
  flexible_dates: null, country: null, destination: null,
  needs_hebrew_kids_club: null, preferences: [],
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
  return {
    ...slots,
    month: slots.month === 'any' ? null : slots.month,
  };
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

  let slots, replyIfNotReady = null;
  if (aiMode() === 'claude') {
    // ---- call 1: slot filling (Claude) ----
    const slotInput = [
      ...messages,
      { role: 'user', content: `<מצב-נוכחי>\nslots עדכני: ${JSON.stringify(prevSlots)}\nמספר שאלות שכבר נשאלו: ${questionsAsked}\n</מצב-נוכחי>\nעדכן את ה-slots לפי השיחה והחזר JSON בלבד.` },
    ];
    const parsed = parseModelJSON(await callClaude({ system: SLOT_PROMPT, messages: slotInput }));
    if (!parsed || !parsed.slots) return { reply_he: FALLBACK_HE, slots: prevSlots, cards: [], chips: [] };
    slots = { ...EMPTY_SLOTS, ...parsed.slots };
    if (!parsed.ready_to_search) replyIfNotReady = parsed.reply_he || FALLBACK_HE;
  } else {
    // ---- offline demo mode: regex NLU, zero cost ----
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    slots = offline.parseText(lastUser ? lastUser.content : '', prevSlots);
    const q = offline.nextQuestion(slots, prevSlots._lastQuestion || null);
    if (q) { slots._lastQuestion = q.key; replyIfNotReady = q.he; }
    else delete slots._lastQuestion;
  }

  const missing = requiredMissing(slots);
  const mustSearch = missing.length === 0 || questionsAsked >= 2 || replyIfNotReady == null;

  if (!mustSearch) {
    return { reply_he: replyIfNotReady, slots, cards: [], chips: [] };
  }

  // ---- deterministic search (no AI) ----
  const result = engine.search(toSearchSlots(slots));
  const cards = presentCards(result, slots);

  // ---- call 2: phrasing ----
  const phrasingPayload = {
    conversation_summary: messages.filter(m => m.role === 'user').map(m => m.content).join(' | ').slice(0, 800),
    slots,
    notes: result.notes, relaxed: result.relaxed,
    two_room_splits: result.two_room_splits,
    cards: cards.map(c => ({
      index: c.index, hotel: c.hotel, resort: c.resort, country_he: c.country_he,
      date: c.date, date_label: c.date_label, nights: c.nights, room: c.room,
      occ: c.occ, occ_composition_he: c.occ_composition_he,
      desc_he: c.desc_he, lift_he: c.lift_he, tags: c.tags,
      price_range: c.price_range, recommended: c.recommended,
      camps: c.camps, occ_unverified: c.occ_unverified,
    })),
  };
  let intro;
  if (aiMode() === 'claude') {
    let phrased = null;
    try {
      phrased = parseModelJSON(await callClaude({
        system: PHRASE_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(phrasingPayload) }],
        maxTokens: 900,
      }));
    } catch (e) { /* fall back to plain intro below */ }
    intro = (phrased && phrased.intro_he) ||
      (cards.length ? 'הנה מה שנראה פנוי אצלנו — הנציג יאשר סופית:' :
        'לא מצאתי התאמה מדויקת — נציג ישמח לעזור: 04-8557722');
    for (const c of cards) {
      const w = phrased && (phrased.cards || []).find(x => x.index === c.index);
      c.why_he = (w && w.why_he) || '';
    }
    if (phrased && phrased.outro_he) intro = [intro, phrased.outro_he].join('\n');
  } else {
    intro = offline.phrase(result, slots, cards) ||
      (cards.length ? 'הנה מה שנראה פנוי אצלנו — הנציג יאשר סופית:' :
        'לא מצאתי התאמה מדויקת — נציג ישמח לעזור: 04-8557722');
  }

  return {
    reply_he: intro,
    slots, cards,
    two_room_splits: result.two_room_splits,
    notes: result.notes, relaxed: result.relaxed,
    chips: cards.length ? CHIP_LABELS : [],
    chip_to_pref: CHIP_TO_PREF,
  };
}

/* ---------- http plumbing ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
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
