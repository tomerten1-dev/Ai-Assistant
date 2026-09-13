'use strict';
/* Foreign-language customers — content, not a canned line.
   (Tomer, 06/09 evening, after Sunny answered an English question with the
   actual sea-view rooms per hotel while Pingi replied with one fixed sentence.)

   The bot's whole brain is Hebrew: the parser, the FAQ patterns, the guards,
   the search echo, the editor. Teaching each of them English and Russian is
   not on the table. So the customer's message is translated INTO Hebrew, the
   turn runs exactly as a Hebrew turn would, and the finished reply is
   translated OUT into the customer's language. Two model calls, both with
   guards; when either fails, the customer gets the fixed sentence in their
   language that they got before — never a half-translated reply.

   What the guards hold: every number in the Hebrew reply is in the
   translation and vice versa (phone numbers, ages, dates); every Latin word
   in the Hebrew reply (hotel names) survives; no Hebrew letters leak into the
   translation; the length stays within reason. The Hebrew translation of the
   customer's message must contain Hebrew and keep the customer's numbers.
   Nothing in either direction may add a fact — the prompts say so, and the
   number guard is the part of that which a machine can check. */

const LANG_NAME = { en: 'English', ru: 'Russian', fr: 'French', ar: 'Arabic' };
const TRANSLATABLE = new Set(Object.keys(LANG_NAME));

const IN_PROMPT = `אתה מתרגם הודעות של לקוחות לסוכנות חופשות סקי ישראלית (פינגווין). תרגם את הודעת הלקוח לעברית טבעית ומדוברת, כפי שלקוח ישראלי היה כותב אותה בצ'אט.
כללים: אל תוסיף ואל תשמיט מידע. מספרים, גילאים, תאריכים, שמות מלונות ואתרי סקי — נשארים בדיוק (שמות באותיות לטיניות נשארים לטיניים). שאלה נשארת שאלה. אם ההודעה אינה בשפה שאתה מזהה, תרגם כמיטב יכולתך.
החזר JSON בלבד: {"he": "<ההודעה בעברית>"}`;

function outPrompt(lang) {
  const name = LANG_NAME[lang] || 'English';
  return `You translate replies of an Israeli ski-holiday agency's chat assistant from Hebrew into ${name}. Translate faithfully, in the natural, warm register of a customer-service chat.
Rules: do not add, drop or soften anything. Keep every number, age, date, price range and phone number exactly as written (the office number may be written in international form, +972-4-…). Keep hotel and resort names exactly as written (Latin names unchanged; Hebrew resort names transliterated the usual way, e.g. בנסקו → Bansko, מאיירהופן → Mayrhofen, לה דוז אלפ → Les 2 Alpes). The company is "Pingwin" (פינגווין) — never translate it as a bird. "עברית" is the Hebrew language: the kids' club runs in Hebrew, and that stays "Hebrew" in every language — never the customer's own language. A refusal stays a refusal; "a rep will confirm" stays. One question at the end stays one question. No emoji, no bullet points, no headings.
Return the translated text only.`;
}

function numbersIn(s) {
  // the local and the international form of the office number are the same number
  return (String(s || '').match(/\d+/g) || []).map(n => n.replace(/^0+(?=\d)/, '')).filter(n => n !== '972');
}
function sameNumbers(a, b) {
  const A = numbersIn(a).sort().join(','), B = numbersIn(b).sort().join(',');
  return A === B;
}

/* the Hebrew the pipeline will see — or null when the translation is unusable */
function validateIn(he, original, knownNames) {
  const t = String(he || '').trim();
  if (!t || t.length < 2 || t.length > 1200) return null;
  if (!/[א-ת]{2}/.test(t)) return null;
  // the customer's numbers are the customer's: ages, dates, party size — all
  // of them survive; "two adults" → "2 מבוגרים" may add a small one
  const want = numbersIn(original), got = numbersIn(t);
  if (!want.every(n => got.includes(n))) return null;
  if (got.some(n => !want.includes(n) && +n > 31)) return null;
  // a hotel or resort WE know, named in the original, must survive — that is
  // the one Latin word the Hebrew pipeline needs verbatim
  for (const name of knownNames || []) {
    if (name && /^[A-Za-z]/.test(name) && new RegExp('(^|[^A-Za-z])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z]|$)', 'i').test(original) && !t.toLowerCase().includes(name.toLowerCase())) return null;
  }
  return t;
}

/* the reply in the customer's language — or null when the translation is unusable */
function validateOut(text, hebrewReply, lang) {
  const t = String(text || '').trim();
  if (!t) return null;
  const src = String(hebrewReply || '');
  if (/[א-ת]/.test(t)) return null;                            // Hebrew leaked through
  if (lang === 'ru' && !/[Ѐ-ӿ]{3}/.test(t)) return null;
  if (lang === 'ar' && !/[؀-ۿ]{3}/.test(t)) return null;
  if ((lang === 'en' || lang === 'fr') && !/[A-Za-zÀ-ÿ]{3}/.test(t)) return null;
  // no invented numbers; the reply's own numbers mostly survive ("2 מבוגרים"
  // may become "two adults", the office number may not become anything else)
  const srcNums = numbersIn(src), outNums = numbersIn(t);
  if (outNums.some(n => !srcNums.includes(n))) return null;
  const kept = srcNums.filter(n => outNums.includes(n)).length;
  if (srcNums.length && kept / srcNums.length < 0.7) return null;
  if (srcNums.some(n => n.length >= 7) && !srcNums.filter(n => n.length >= 7).every(n => outNums.includes(n))) return null;
  for (const w of src.match(/[A-Za-z][A-Za-z'.-]{2,}/g) || []) {
    if (!new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t)) return null;
  }
  // the brand is the brand ("Penguin", live 06/09), and the language of the
  // kids' club is Hebrew in every language ("лагерь на русском языке", same run)
  if (/פינגווין/.test(src) && !/pingwin|пингвин|بينجوين|بنغوين/i.test(t)) return null;
  const HEBREW_WORD = { en: /hebrew/i, fr: /h[ée]breu/i, ru: /иврит/i, ar: /العبري|عبري/ };
  if (/עברית/.test(src) && HEBREW_WORD[lang] && !HEBREW_WORD[lang].test(t)) return null;
  const ratio = t.length / Math.max(src.length, 1);
  if (ratio < 0.5 || ratio > 3) return null;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) return null;
  if (/^\s*[-•*]/m.test(t)) return null;
  return t;
}

module.exports = { LANG_NAME, TRANSLATABLE, IN_PROMPT, outPrompt, validateIn, validateOut, sameNumbers };
