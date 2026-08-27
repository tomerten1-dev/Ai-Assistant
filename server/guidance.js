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

// Israel time, whatever the server's clock is set to. A cloud host runs in
// UTC, and at 23:30 in Haifa a UTC server still thinks it is 20:30 — the office
// would read as open. Everything below works off these parts, never getFullYear
// or getHours on the raw Date.
const IL_TZ = process.env.OFFICE_TZ || 'Asia/Jerusalem';
function israelParts(now) {
  const d = now || new Date();
  try {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: IL_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
    const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const hour = parseInt(p.hour, 10) % 24;   // some ICU builds render midnight as 24
    return { day: DAYS[p.weekday], hour, minute: parseInt(p.minute, 10) };
  } catch (e) {
    // no ICU data in this build: the local clock is a worse answer than none,
    // but it is the only one left
    return { day: d.getDay(), hour: d.getHours(), minute: d.getMinutes() };
  }
}

// The office's window for a given day of the week, or null when it is closed.
function windowFor(day, h) {
  return day === 6 ? h.sat : (day === 5 ? h.fri : h.sun_thu);
}
const hhmm = t => `${Math.floor(t)}:${String(Math.round((t % 1) * 60)).padStart(2, '0')}`;

// Is the office open right now? Hours come from the contact page on
// pingwin.co.il and live in Tomer's file, so he can change them without me.
function officeOpen(now) {
  const h = (load().handoff_he || {}).hours;
  if (!h) return null;                       // no hours configured — say nothing
  const { day, hour, minute } = israelParts(now);
  const win = windowFor(day, h);
  if (!win) return false;
  const t = hour + minute / 60;
  return t >= win[0] && t < win[1];
}

// Open now, or — when it is not — when it opens next, in the words the customer
// reads: "היום ב-9:00" / "מחר ב-9:00" / "ביום ראשון ב-9:00".
// Returns null when no hours are configured, so callers keep the neutral line.
function officeState(now) {
  const H = (load().handoff_he || {});
  const h = H.hours;
  if (!h) return null;
  const { day, hour, minute } = israelParts(now);
  const t = hour + minute / 60;
  const win = windowFor(day, h);
  if (win && t >= win[0] && t < win[1]) return { open: true, day, opens_he: '' };

  // still today?
  const W = H.opens_he || {};
  const DAY_HE = W.day_names_he || ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  if (win && t < win[0]) {
    return { open: false, day, when: 'today',
      opens_he: (W.today_he || 'היום ב-{time}').replace('{time}', hhmm(win[0])) };
  }
  // the next day that has a window at all — at most a week ahead
  for (let i = 1; i <= 7; i++) {
    const d2 = (day + i) % 7;
    const w2 = windowFor(d2, h);
    if (!w2) continue;
    const tpl = i === 1 ? (W.tomorrow_he || 'מחר ב-{time}')
      : (W.weekday_he || 'ביום {day} ב-{time}').replace('{day}', DAY_HE[d2]);
    return { open: false, day, when: i === 1 ? 'tomorrow' : 'later',
      opens_he: tpl.replace('{time}', hhmm(w2[0])) };
  }
  return { open: false, day, when: 'unknown', opens_he: '' };
}

// What to say when handing the customer to a person.
//
// Tomer, 24/08: do not talk someone out of leaving their details — "המשרד סגור"
// on its own reads as "come back tomorrow", and the moment they wanted to leave
// a phone number is the moment we lose.
// Tomer, 26/08: but a customer writing at 23:00 should not be told to call now,
// as if someone will pick up.
//
// Both hold at once, so the closed line says three things in one breath: it is
// closed, exactly when it opens, and that leaving details here works anyway —
// the invitation is never dropped, only the "call now" is.
function handoffLine(now) {
  const H = load().handoff_he || {};
  const st = officeState(now);
  if (!st || st.open || !H.line_closed_he || !st.opens_he) return H.line_he || '';
  return H.line_closed_he.split('{opens}').join(st.opens_he);
}

// The line the bot ends on. `kind` is 'with_offers' | 'no_offers' | 'after_question'.
// "אם אחת מהן נראית לכם" printed above a single card. A closing line that does
// not match what the customer is looking at is the kind of small wrongness that
// makes a chat feel automated.
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

// Fixed wording for a hard rule the code detected. The rule is ours; the
// sentence is Tomer's to edit. A missing key falls back to the built-in text so
// a trimmed file can never turn a refusal into silence.
const GUARD_DEFAULTS = {
  profanity: 'לא אמשיך בשיחה בסגנון הזה. אם תרצו עזרה בחופשת סקי — כתבו לי כמה אתם ומתי.',
  harassment: 'אני עוזר אוטומטי ונשאר בנושא חופשות סקי.',
  impersonation: 'אין לי דרך לאמת זהות ולא אמסור מידע פנימי בצ\'אט. פניות של צוות או רשויות — במשרד: {phone}.',
  security: 'זו שאלה שאף אחד לא יכול לענות עליה בוודאות. ההזמנה כפופה לתנאי הביטול שבתקנון, ונציג ישמח לעבור אתכם עליהם.',
  antisemitism: 'אין לי נתונים שמאפשרים לענות על זה באחריות. בכל היעדים שלנו יש נציג ישראלי באתר; נציג ישמח לספר מניסיון.',
  fraud: 'אני לא יכול לרשום פרט שאינו נכון, וזה עלול לבטל ביטוח או הזמנה.',
  politics: 'על פוליטיקה אני לא מדבר — אני עוזר לחופשות סקי.',
  card_number: 'אל תשלחו כאן מספרי כרטיס אשראי או תעודת זהות. התשלום מתבצע רק במסך ההזמנה המאובטח.',
  guide_dog: 'כלב נחייה אינו חיית מחמד; נציג יסדיר את האישורים מראש — השאירו שם וטלפון.',
  competitor_named: 'לא אשווה מול חברות אחרות — אני לא רואה מה כלול אצלן. מה שכלול אצלנו מופיע על כל הצעה.',
};
function guardText(key) {
  const g = load().guards_he || {};
  return fill((typeof g[key] === 'string' && g[key].trim()) ? g[key] : GUARD_DEFAULTS[key]);
}

function leadIntentText(kind) {
  const g = load().lead_intents_he || {};
  return (typeof g[kind] === 'string' && g[kind].trim()) ? g[kind]
    : fill('זו פנייה שנציג מטפל בה — השאירו שם וטלפון ונחזור אליכם, או התקשרו ל-{phone}.');
}

/* ---------- fixed sentences ----------
   The lines the bot says the same way every time: the fallback after an error,
   the off-topic line, "slow down", the greeting. They used to be string
   literals scattered across server.js and offline-nlu.js, which meant changing
   the office phone number was a code change in eleven places.

   `msg(key, fallback)` reads messages_he[key] from guidance.json, fills the
   {phone} / {whatsapp} / {handoff} placeholders from handoff_he, and returns
   the built-in wording when the key is missing — so a trimmed or broken
   guidance.json can never turn a sentence into an empty string. */
function fill(text) {
  const h = load().handoff_he || {};
  let out = String(text == null ? '' : text);
  for (const [k, v] of [['{phone}', h.phone], ['{whatsapp}', h.whatsapp], ['{email}', h.email]]) {
    if (!out.includes(k)) continue;
    // no number configured: drop the clause that offered it rather than
    // printing a placeholder at a customer
    out = v ? out.split(k).join(v) : out.replace(new RegExp(`[^,.!?]*\\${k}[^,.!?]*[,.]?`, 'g'), '');
  }
  if (out.includes('{handoff}')) out = out.split('{handoff}').join(handoffLine());
  return out.replace(/\s{2,}/g, ' ').trim();
}
function msg(key, fallback) {
  const m = load().messages_he || {};
  const raw = (typeof m[key] === 'string' && m[key].trim()) ? m[key] : fallback;
  return fill(raw);
}
// the office number, for the one or two places that need it on its own
function phone() { return (load().handoff_he || {}).phone || ''; }

function languageText(key) {
  const g = load().languages_he || {};
  return (typeof g[key] === 'string' && g[key].trim()) ? g[key] : null;
}

module.exports = { forAsking, forAnswering, objection, officeOpen, officeState, handoffLine, closing, guardText, leadIntentText, languageText, msg, fill, phone, load, FILE };
