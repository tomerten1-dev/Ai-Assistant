// PHRASING prompt — the model writes the Hebrew reply, and nothing else.
//
// The split that makes this safe: deterministic code has already decided WHAT
// is true (which units are free, which dates, which camp groups run, what the
// hotel page says). The model receives only that decision and turns it into
// something a person would say. It never sees the inventory, so it cannot
// invent a hotel, a date or an availability claim — the worst it can do is
// phrase the given facts badly, and validate() below catches the ways that
// matter.
//
// Templated phrasing remains in offline-nlu and is used verbatim whenever this
// call fails, is disabled, or produces output that fails validation.

const PHRASE_PROMPT = `אתה נציג של פינגווין, סוכנות חופשות סקי ישראלית. אתה כותב הודעה אחת בעברית ללקוח.

קיבלת JSON עם: מה הלקוח ביקש (slots), ההצעות שנבחרו עבורו (cards), והערות מהמערכת (notes).
תפקידך לנסח — לא להחליט ולא להוסיף מידע.

חוקים מוחלטים:
1. אל תכתוב שום עובדה שאינה ב-JSON. אין מלון, תאריך, מלצר, מסלול או שירות שלא מופיע שם.
2. אל תכתוב מחיר במספרים ואל תכתוב שם של לקוח או מספר הזמנה.
3. אל תבטיח זמינות. הניסוח הוא "נראה פנוי", "נציג יאשר סופית".
4. אל תכתוב "התחייבויות" — זו מילה פנימית שלנו.
5. אל תמציא שעות טיסה.
6. אם ב-notes כתוב שמשהו חסר או לא פועל — תגיד את זה בפירוש, אל תעגל פינות.
7. כל פריט ב-דברים_שהלקוח_ציין חייב לקבל התייחסות במשפט אחד — גם אם אי אפשר לסנן לפיו. אם זה משהו שנציג צריך לטפל בו, אמור שתעביר לנציג. אל תתעלם מאף פריט.
8. אל תמליץ "הכי טוב". אפשר "מומלץ".
9. הסבר בקצרה למה דווקא ההצעות האלה — קשור למה שהלקוח ביקש (חודש, יעד, גודל חבורה, קייטנה, ספא, תקציב). השתמש בשדה why של כל הצעה. משפט אחד או שניים, לא רשימה.
10. אל תנדב מידע שהלקוח לא ביקש ושלא משפיע על ההחלטה שלו. אם הוא לא שאל על ספא — אל תספר על הספא.

סגנון: עברית טבעית, חמה ועניינית. בלי אימוג'ים. 2-4 משפטים לכל היותר, ואל תחזור על מה שכתוב על הכרטיסים עצמם — הלקוח רואה אותם. התייחס למה שהלקוח ביקש בשמו, כדי שיהיה ברור שקראת.

החזר טקסט בלבד. בלי JSON, בלי כותרות, בלי רשימות.`;

// What the model is allowed to see about each offer. Deliberately narrow: no
// internal ids, no counts, no sheet names, no room codes from the workbook.
function cardDigest(c) {
  return {
    hotel: c.hotel,
    resort: c.resort,
    country_he: c.country_he,
    date_he: c.date_label ? `${c.date_label} ${c.date}` : c.date,
    nights: c.nights,
    room: c.room,
    fits: c.occ && c.occ.max,
    camps: c.camps ? { full: c.camps.full, running: c.camps.running, missing: c.camps.missing } : null,
    facts: c.facts_he || [],
    tags: c.tags || [],
    recommended: !!c.recommended,
    // why the deterministic filter picked this one — computed in offline-nlu
    // and sent so the model can explain the match instead of guessing at it
    why: c.why_he || null,
  };
}

function buildPayload({ slots, cards, result, fallback }) {
  return JSON.stringify({
    בקשת_הלקוח: {
      מבוגרים: slots.adults,
      גילאי_ילדים: slots.children_ages,
      חודש: slots.month,
      יעד: slots.country || slots.destination,
      לא_רוצים: [...(slots.excluded_countries || []), ...(slots.excluded_destinations || [])],
      דרישות: slots.unverifiable || [],
      העדפות: slots.preferences || [],
      בלי_טיסות_בשבת: !!slots.no_saturday_flights,
      לילות: slots.nights_wanted,
      דברים_שהלקוח_ציין: slots.notes_from_customer || [],
    },
    הצעות: cards.map(cardDigest),
    הערות_מערכת: (result.notes || []).map(n => n.type),
    הרחבות: (result.relaxed || []).map(r => r.type),
    הנוסח_התבניתי: fallback,   // the deterministic wording, as a floor to beat
  });
}

// The output guard. Anything the model could get wrong in a way that costs
// money or trust is checked here, and a failure means we ship the template.
function validate(text, { cards, fallback }) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, why: 'empty' };
  if (t.length > 700) return { ok: false, why: 'too long' };

  // red rule 3 — no sums of money
  if (/\d[\d,.]*\s*(₪|\$|€|שקל|ש"ח|שח|יורו|אירו)/.test(t)) return { ok: false, why: 'price' };
  // red rule 2 — no order numbers
  if (/\d{6}/.test(t)) return { ok: false, why: 'order number' };
  // internal vocabulary
  if (/התחייבו/.test(t)) return { ok: false, why: 'internal wording' };
  // red rule 4 — never promise availability outright
  if (/(מובטח|בטוח פנוי|אני מבטיח|מבטיחים לכם)/.test(t)) return { ok: false, why: 'promise' };
  // red rule 8 — no flight times
  if (/\b\d{1,2}:\d{2}\b/.test(t)) return { ok: false, why: 'flight time' };
  // red rule 6
  if (/הכי טוב|הטוב ביותר/.test(t)) return { ok: false, why: 'superlative' };

  // red rule 1 — every hotel it names must be one we actually offered
  const shown = cards.map(c => c.hotel);
  for (const name of KNOWN_HOTELS) {
    if (!shown.includes(name) && t.includes(name)) return { ok: false, why: 'hotel not offered: ' + name };
  }
  // Every date it names must be one we put in front of it — either an offered
  // departure, or one the deterministic layer already named in the template
  // (camp weeks, dates free of a commitments restriction).
  const allowed = new Set([
    ...cards.flatMap(c => datesOf(c)),
    ...datesIn(fallback || ''),
  ]);
  for (const key of datesIn(t)) {
    if (!allowed.has(key)) return { ok: false, why: 'invented date: ' + key };
  }
  return { ok: true };
}

// "5.2", "ב-26.2", "19/03" → "5.2" / "26.2" / "19.3"
function datesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?![\d])/g)) {
    out.push(+m[1] + '.' + +m[2]);
  }
  return out;
}

function datesOf(c) {
  if (!c.date) return [];
  const [y, m, d] = c.date.split('-');
  return [+d + '.' + +m];
}

// Loaded once; used only to catch the model naming a hotel we did not offer.
const KNOWN_HOTELS = (() => {
  try {
    return Object.keys(require('../data/resorts.json').hotels);
  } catch (e) { return []; }
})();

module.exports = { PHRASE_PROMPT, buildPayload, validate, cardDigest };
