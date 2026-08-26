// Claude API proxy helpers — the ONLY place that talks to Anthropic.
// API key comes from .env (server side); it never reaches the browser.
const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

async function callClaude({ system, messages, maxTokens = 700 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes('xxxx')) {
    const err = new Error('missing_api_key');
    err.friendly = 'חסר מפתח API בקובץ .env בשרת (ראה .env.example)';
    throw err;
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
    // same reason as in openai.js: a hung request must not hold the turn
    signal: AbortSignal.timeout(+(process.env.MODEL_TIMEOUT_MS || 20000)),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`anthropic_${res.status}`);
    err.friendly = 'תקלה זמנית בשירות — נסו שוב בעוד רגע.';
    err.detail = body.slice(0, 500);
    throw err;
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// robust JSON extraction: strips code fences, grabs the outermost {...}
function parseModelJSON(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through */ }
  // one repair attempt: remove trailing commas
  try { return JSON.parse(t.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')); } catch { return null; }
}

module.exports = { callClaude, parseModelJSON, MODEL };
