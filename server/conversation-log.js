// A log of real conversations, so bugs stop depending on Tomer noticing them.
//
// Every defect found in this project so far was found by a person reading a
// reply — the 83-scenario adversarial suite reported "clean" every single time.
// That does not scale past the two of us. This writes what customers actually
// said and what the bot actually answered, so a weekly pass over the stuck
// conversations replaces waiting for a screenshot.
//
// PII, deliberately (spec 2a): the workbook's customer names never reach this
// process, and the lead form's name and phone are NOT written here. What is
// stored is the customer's own words, which they typed into a chat box, plus
// the bot's reply and the machine state behind it. A conversation id is a
// random string, not anything that identifies a person.
//
// But customers type phone numbers and e-mails into a chat box anyway — that is
// why offline-nlu has a phone regex at all — so `redact()` strips them on the
// way in. And the file is not kept forever: CHAT_LOG_DAYS (default 30) sweeps
// older days at startup. A log nobody can delete from is a liability, not an
// asset.
//
// Storage is one JSON object per line (JSONL): appending is atomic enough for
// this volume, a corrupt line loses one turn rather than the file, and it can
// be read with any text editor.
const fs = require('fs');
const path = require('path');

const DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
// read per call, not once at require: the test runners switch it off before
// they load the server, and a module-level constant ignored them — which is how
// one day's log grew to 23MB of synthetic turns with the real ones buried in it
const enabled = () => process.env.CHAT_LOG !== 'off';

let warned = false;

/* ---------- PII on the way in ---------- */
// Nine or more digits in one run is a phone number or a card, never a price, a
// year or an age. Written as a class of separators so "050-123 4567" is caught.
const DIGIT_RUN = /(?:[+(]?\d[\d\-().\u00A0 ]{7,}\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(EMAIL, '[מייל]')
    .replace(DIGIT_RUN, m => {
      const n = (m.match(/\d/g) || []).length;
      return n >= 13 ? '[מספר]' : n >= 9 ? '[טלפון]' : m;   // 13+ digits is a card, not a phone
    });
}

/* ---------- retention ---------- */
// Runs once, at startup. Deleting is the only way a retention promise is real.
function sweep(days) {
  const keep = +(days != null ? days : process.env.CHAT_LOG_DAYS || 30);
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  const cutoff = Date.now() - keep * 86400000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(DIR)) {
      const m = /^chat-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      if (Date.parse(m[1] + 'T23:59:59Z') < cutoff) { fs.unlinkSync(path.join(DIR, name)); removed++; }
    }
  } catch (e) { /* no log dir yet, or no permission — never fatal */ }
  return removed;
}

function file(d) {
  const day = (d || new Date()).toISOString().slice(0, 10);
  return path.join(DIR, `chat-${day}.jsonl`);
}

// Turns a reply into the handful of flags worth filtering on later. The point
// is to be able to ask "show me every conversation that ended with no offers"
// without reading all of them.
function signals({ cards, result, slots, reply, notUnderstood, answeredBy }) {
  const relaxed = (result && result.relaxed || []).map(r => r.type);
  const notes = (result && result.notes || []).map(n => n.type);
  return {
    offers: cards.length,
    splits: (result && result.two_room_splits || []).length,
    relaxed,
    notes,
    asked: /\?/.test(reply || ''),
    // the three shapes worth reviewing weekly
    dead_end: cards.length === 0 && !(result && result.two_room_splits || []).length,
    deferred: /נציג (אנושי )?(יאמת|יבדוק|ימסור|יחזור|יסביר|יאשר|יסדיר|יטפל|יעביר)|השאירו שם וטלפון/.test(reply || ''),
    // read from the notes, not the slot: the slot is cleared once handled
    objection: notes.includes('cheaper_found') || notes.includes('no_cheaper'),
    widened: relaxed.length > 0,
    // Nothing understood and nothing answered: the customer said something we
    // could not use, and got the off-topic line. Every defect Tomer found by
    // chatting looked like this from the inside, so it is worth a flag of its
    // own — a real conversation is a better bug report than any persona I write.
    not_understood: !!notUnderstood,
    // which layer answered, so we can see whether the semantic router is
    // carrying questions the patterns miss
    answered_by: answeredBy || null,
  };
}

function append(entry) {
  if (!enabled()) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(file(), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    // Logging must never break a conversation. Say it once and carry on.
    if (!warned) { console.error('chat log unavailable:', e.message); warned = true; }
  }
}

// `slots` carries internal bookkeeping (_asked, _closed, _lastQuestion) that is
// noise in a log. Keep the ones that describe the customer's request.
const KEEP = ['adults', 'children_ages', 'children_count', 'no_children', 'month',
  'month_part', 'country', 'destination', 'excluded_countries', 'excluded_destinations',
  'departure_airport', 'needs_hebrew_kids_club', 'nights_wanted', 'no_saturday_flights',
  'preferences', 'unverifiable', 'notes_from_customer', 'price_objection', 'out_of_season'];

function tidySlots(slots) {
  const out = {};
  for (const k of KEEP) {
    const v = slots[k];
    if (v == null) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (v === false) continue;
    // notes_from_customer quotes the customer back — same redaction as `user`
    out[k] = Array.isArray(v) ? v.map(x => (typeof x === 'string' ? redact(x) : x))
      : (typeof v === 'string' ? redact(v) : v);
  }
  return out;
}

function logTurn({ conversationId, userText, reply, cards, result, slots, modelUsed, ms,
  notUnderstood, answeredBy }) {
  append({
    at: new Date().toISOString(),
    cid: conversationId,
    user: redact(userText),
    bot: reply,
    hotels: cards.map(c => `${c.hotel} ${c.date}`),
    slots: tidySlots(slots),
    signals: signals({ cards, result, slots, reply, notUnderstood, answeredBy }),
    model: !!modelUsed,
    ms,
  });
}

// Read a day back, for the weekly pass. `filter` is one of the signal names.
function read(day, filter) {
  const p = file(day ? new Date(day) : new Date());
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!filter || row.signals[filter]) rows.push(row);
    } catch (e) { /* one bad line is one lost turn, not a lost day */ }
  }
  return rows;
}

module.exports = { logTurn, read, file, DIR, redact, sweep, enabled,
  // kept for callers that read it as a value; prefer enabled()
  get ENABLED() { return enabled(); } };
