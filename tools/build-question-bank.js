// BUILD STEP: research report → tests/question-bank.json
// Turns the persona research (the <details> sections of the report) into a
// flat list of {q, section, cluster, expect[]} entries. `expect` is the set of
// BEHAVIOURS the bot may show for that question — not the answer text. The
// harness (tests/test-bank.js) checks behaviour, never facts:
//   faq       an approved answer was chosen (id in faq.json)
//   match     the message drove the search: cards shown, or a matching question asked
//   escalate  a rep was offered (lead form / phone) instead of an answer
//   refuse    a guard or deflection fired (promises, prices, security, injection…)
//   ask       a clarifying question came back
// A question whose truthful answer we do not hold yet is tagged `nofact`: the
// only failure there is inventing one.
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(process.env.HOME || '/root', 'pingwin-research', 'report.html');
const OUT = path.join(__dirname, '..', 'tests', 'question-bank.json');

// section title (substring) → cluster + allowed behaviours
const SECTIONS = [
  ['60 השאלות שכל פרסונה', 'core', ['faq', 'match', 'ask', 'escalate']],
  ['פעוטות 0–3', 'toddlers', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['ילדים 4–6', 'camp_4_6', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['ילדים 7–13', 'camp_7_13', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['בני נוער', 'teens', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['גילאים מעורבים', 'family_mixed', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['הורה גרוש', 'family_edge', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['צרכים מיוחדים', 'special_needs', ['escalate', 'faq', 'nofact']],
  ['משפחה דתית', 'religious', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['תקציב מצומצם', 'budget_rooms_dates', ['faq', 'match', 'ask', 'escalate', 'refuse', 'nofact']],
  ['זוג צעיר', 'couple_first', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['זוג מעורב', 'couple_senior', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ["חבר'ה 4–8", 'groups', ['faq', 'match', 'ask', 'escalate', 'refuse', 'nofact']],
  ['נוסע יחיד', 'solo_lgbt_nonskier', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['סנובורדיסט', 'advanced_city_gift', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['דוברי אנגלית', 'language_access', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['לפני הזמנה — מושגי יסוד', 'beginner_basics', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['הזמנה, מחיר, תשלום', 'booking_docs', ['faq', 'escalate', 'refuse', 'nofact']],
  ['טיסות · העברות', 'logistics', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['בטיחות · שינויים', 'safety_cancel_security', ['faq', 'escalate', 'refuse', 'nofact']],
  ['מדינה מול מדינה', 'compare', ['faq', 'match', 'ask', 'escalate', 'nofact']],
  ['תאריכים · שטח הגלישה', 'dates_area_recommend', ['faq', 'match', 'ask', 'escalate', 'refuse', 'nofact']],
  // an approved answer that says "אנחנו לא מבטיחים" is a refusal too
  ['ניסיונות לחלץ הבטחות', 'promises', ['refuse', 'escalate', 'faq']],
  ['לקוחות קיימים', 'existing_customer', ['escalate', 'faq']],
  ['B2B ואינטנטים', 'b2b_offtopic', ['escalate', 'refuse', 'faq', 'offtopic', 'ask']],
  ['אדברסריאלי', 'adversarial', ['refuse', 'escalate', 'offtopic', 'faq']],
  ['שפה ופורמט', 'format_emotional', ['faq', 'match', 'ask', 'escalate', 'refuse', 'offtopic']],
];

const html = fs.readFileSync(SRC, 'utf8');
const bank = [];
const seen = new Set();
const detailsRe = /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;
let m;
while ((m = detailsRe.exec(html))) {
  const title = m[1].replace(/<[^>]+>/g, '').trim();
  const sec = SECTIONS.find(([k]) => title.includes(k));
  if (!sec) continue;
  const [, cluster, expect] = sec;
  const items = [...m[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map(x => x[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  for (const raw of items) {
    // strip the strategy notes in parentheses the research added for us
    const cleaned = raw.replace(/\((?:[^()]*(?:→|לענות|סירוב|הסלמה|תמיד|גנרי|זיהוי|לאשר|debounce|voice|typo|לא ב-|בלי|חירום|שימור|להציע)[^()]*)\)/g, '').trim();
    // one <li> often holds two or three questions — split on the question
    // marks, keep pieces that are still a sentence
    // "…?" and " / " both separate alternatives the research packed into one line
    const parts = cleaned.split(/\?\s*|\s\/\s/).map(x => x.replace(/^\/\s*/, '').trim())
      .filter(x => x.length >= 6 && /[\u0590-\u05FFA-Za-z\u0400-\u04FF\u0600-\u06FF]/.test(x));
    // a fragment that only continues the previous alternative ("לזוג?") is not a message
    // "חוזרים מתי?" split off "באיזו שעה? חוזרים מתי?" is a follow-up, not a
    // first message — a fresh conversation cannot be expected to answer it
    const qs = parts.length > 1 ? parts.filter(x => x.split(/\s+/).length >= 3 || /^[\u0400-\u06FF]/.test(x)).map(x => /[?!.]$/.test(x) ? x : x + '?') : [cleaned];
    for (const q of qs) {
      const key = q.replace(/[?\s]/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      bank.push({ q, section: title, cluster, expect });
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify(bank, null, 1));
const byCluster = {};
for (const e of bank) byCluster[e.cluster] = (byCluster[e.cluster] || 0) + 1;
console.log(`wrote ${bank.length} questions to tests/question-bank.json`);
console.log(byCluster);
