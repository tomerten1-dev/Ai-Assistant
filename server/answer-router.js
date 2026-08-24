// Semantic routing to a standing answer.
//
// Why this exists: almost every defect Tomer found by chatting was the same
// shape — he asked a question we HAVE an approved answer for, in words the
// regex did not contain. "מה כולל המחיר" against a pattern that knew
// "מה כלול". "ואינטרנט?" against one that knew "וויפי". "כמה זמן ההעברה"
// against one that knew "כמה זמן הנסיעה". Every one of those was fixed by
// adding another alternative to another pattern, which is a treadmill: Hebrew
// has more ways to ask a question than we have patience to enumerate.
//
// So the model reads the question and picks WHICH approved answer applies. It
// never writes one. The reply that ships is Tomer's text, verbatim, chosen by
// id — the model cannot invent a fact here even if it wants to, because its
// entire output is one id from a closed list.
//
// The regex layer stays in front of it: it is free, instant, and right most of
// the time. This runs only when the regex found nothing.

// One line per answer, so the model can tell them apart without reading all
// seventy in full. Built from the answer itself — nothing to maintain by hand.
function topicLine(entry) {
  // The first sentence of an answer is not always about its topic — the entry
  // for big groups opens "בשמחה, אני יכול להראות לכם אפשרויות", which reads
  // like a match for "תראה לי משהו באוסטריה". The pattern's own first few
  // alternatives say what the entry is ABOUT, so both go in.
  const keys = String(entry.match || '').split('|')
    .map(k => k.replace(/[\^$?*+\()\[\]{}]/g, '').replace(/\.\{[^}]*\}/g, ' ').trim())
    .filter(k => k && k.length > 2).slice(0, 4).join(' / ');
  const first = String(entry.answer_he || '').split(/[.!?]/)[0].trim();
  return `${entry.id} [${keys}]: ${first.slice(0, 80)}`;
}

function buildPrompt(entries) {
  return `אתה מנתב שאלות של לקוחות בצ'אט של סוכנות סקי לתשובה מוכנה מראש.

לפניך רשימת תשובות מאושרות, כל אחת עם מזהה. הלקוח שולח הודעה. תפקידך היחיד:
להחליט איזו תשובה עונה על מה שהלקוח שאל — או שאף אחת לא עונה.

חוקים:
- אל תכתוב תשובה משלך. אתה מחזיר מזהה בלבד.
- אם ההודעה אינה שאלה אלא בקשה לחופשה ("זוג בפברואר", "משפחה של 4 לבולגריה") — החזר null.
- אם השאלה אינה קשורה לאף תשובה ברשימה — החזר null. עדיף null מאשר תשובה שלא עונה.
- אם הלקוח שואל כמה משהו עולה במספרים — החזר null.
- שאלה יכולה להיות מנוסחת בכל דרך, כולל שגיאות כתיב, סלנג, אנגלית או משפט ארוך.

התשובות המאושרות:
${entries.map(topicLine).join('\n')}

החזר JSON בלבד: {"id": "<מזהה מהרשימה>"} או {"id": null}`;
}

// The model's answer is a key into our own data or it is nothing. Anything we
// do not recognise becomes null rather than a guess.
function pick(raw, entries) {
  let id = null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    id = parsed && parsed.id;
  } catch (e) { return null; }
  if (!id || typeof id !== 'string') return null;
  const hit = entries.find(e => e.id === id);
  return hit ? { id: hit.id, he: hit.answer_he, routed: true } : null;
}

module.exports = { buildPrompt, pick, topicLine };
