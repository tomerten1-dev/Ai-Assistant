// Tomer's own instructions to the bot, in a file he edits (config/guidance.json).
//
// Why this exists: "what to ask and how to answer" is a business decision, not
// an engineering one. It was buried in two system prompts inside the source,
// so changing the tone of a sentence meant changing code. Now it is a plain
// Hebrew file, reloaded whenever it changes, with no restart.
//
// What it deliberately CANNOT do: soften a red rule. The guidance is rendered
// FIRST and the hard rules are appended after it, so the last word in the
// prompt is always ours; and validate() in prompt-phrase.js checks the output
// regardless of what any prompt said. A typo in this file can make the bot
// worse at selling. It cannot make it unsafe.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'guidance.json');

let cache = null;
let cachedAt = 0;

function load() {
  let stamp = 0;
  try { stamp = fs.statSync(FILE).mtimeMs; } catch (e) { stamp = 0; }
  if (cache && stamp === cachedAt) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cachedAt = stamp;
  } catch (e) {
    // A broken file must never take the bot down: fall back to no guidance,
    // which leaves the built-in prompts exactly as they were.
    console.error('guidance.json unreadable (%s) — running without it', e.message);
    cache = {};
    cachedAt = stamp;
  }
  return cache;
}

const list = (title, items) => {
  const rows = (items || []).filter(Boolean);
  return rows.length ? `${title}:\n` + rows.map(r => '- ' + r).join('\n') : '';
};
const para = (title, text) => (text ? `${title}: ${text}` : '');

// what to ask, for the slot-filling prompt
function forAsking() {
  const g = load();
  const blocks = [
    list('סדר העדיפות בשאלות', g.ask_priority_he),
    list('אסור בשאלות', g.ask_never_he),
    para('טון', g.answer_tone_he),
    g.extra_he || '',
  ].filter(Boolean);
  return blocks.length ? '\n\nהנחיות מהמנהל:\n' + blocks.join('\n') : '';
}

// how to answer, for the phrasing prompt
function forAnswering(country) {
  const g = load();
  const emphasis = country && (g.emphasis_by_country_he || {})[country];
  const blocks = [
    para('טון', g.answer_tone_he),
    para('אורך', g.answer_length_he),
    list('תמיד', g.answer_always_he),
    list('אסור', g.answer_never_he),
    para('להדגיש ביעד הזה', emphasis),
    para('למי היעד הזה מתאים', country && (g.suits_by_country_he || {})[country]),
    list('תמיד להעביר לנציג', (g.handoff_he || {}).always_handoff_he),
    para('כשאין לך תשובה ודאית', (g.handoff_he || {}).when_unknown_he),
    para('העברה לנציג עכשיו', handoffLine()),
    para('משפט סיום', closing('with_offers')),
    para('השארת פרטים', g.lead_he),
    g.extra_he || '',
  ].filter(Boolean);
  return blocks.length ? '\n\nהנחיות מהמנהל:\n' + blocks.join('\n') : '';
}

// Is the office open right now? Hours come from the contact page on
// pingwin.co.il and live in Tomer's file, so he can change them without me.
function officeOpen(now) {
  const h = (load().handoff_he || {}).hours;
  if (!h) return null;                       // no hours configured — say nothing
  const d = now || new Date();
  const day = d.getDay();                    // 0 = Sunday
  const win = day === 6 ? h.sat : (day === 5 ? h.fri : h.sun_thu);
  if (!win) return false;
  const t = d.getHours() + d.getMinutes() / 60;
  return t >= win[0] && t < win[1];
}

// What to say when handing the customer to a person. Deliberately NOT phrased
// for the hour (Tomer, 24/08): telling someone at 23:00 that the office is
// closed discourages them from leaving details at the moment they wanted to.
// One sentence, true at any hour. officeOpen() stays for answering "what are
// your hours" — it just no longer decides how we speak.
function handoffLine() {
  return (load().handoff_he || {}).line_he || '';
}

// The line the bot ends on. `kind` is 'with_offers' | 'no_offers' | 'after_question'.
function closing(kind) {
  const c = load().closing_he || {};
  return c[kind + '_he'] || '';
}

// Objection handling, read straight out of Tomer's file so the wording is his.
// Returns {match: RegExp, cheaper: string, none: string} or null.
function objection(kind) {
  const o = ((load().objections_he || {})[kind]) || null;
  if (!o || !(o.match_he || []).length) return null;
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    match: new RegExp(o.match_he.map(esc).join('|')),
    cheaper: o.if_cheaper_exists_he || '',
    none: o.if_none_cheaper_he || '',
  };
}

module.exports = { forAsking, forAnswering, objection, officeOpen, handoffLine, closing, load, FILE };
