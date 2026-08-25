// OpenAI provider — same contract as server/claude.js (callModel + usage).
// The API key lives in .env and never reaches the browser.
//
// Model: GPT-5.6 Luna by default — the cheap tier ($0.20/$1.20 per 1M tokens).
// That is deliberate: this bot's model only has to read Hebrew and fill 8
// slots. The hard thinking (availability, camps, airports) is deterministic
// code, so paying for a bigger model buys nothing here.
// Override with OPENAI_MODEL in .env; verify the exact id in your dashboard.
const DEFAULT_MODEL = 'gpt-5.6-luna';
const API_URL = 'https://api.openai.com/v1/chat/completions';

// per-1M-token list prices, for the running cost estimate in the logs
const PRICES = {
  'gpt-5.6-luna':  { in: 0.20, out: 1.20 },
  'gpt-5.6-terra': { in: 2.00, out: 12.00 },
  'gpt-5.6-sol':   { in: 5.00, out: 30.00 },
};

const spend = { input: 0, output: 0, calls: 0, usd: 0 };

function model() { return process.env.OPENAI_MODEL || DEFAULT_MODEL; }

// `json` is on by default because slot filling wants a parseable object. The
// phrasing call wants prose, and JSON mode would make it wrap a sentence in a
// object for no reason and no benefit.
// `model` (optional) overrides the default for THIS call. The slot filler and
// the answer router read Hebrew and pick from lists — the cheap tier is right
// for them. The phrasing call writes the sentence the customer actually reads,
// and OPENAI_PHRASE_MODEL lets that one job ride a better model without
// paying for it everywhere else.
async function callOpenAI({ system, messages, maxTokens = 400, json = true, model: modelOverride }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || key.includes('xxxx')) {
    const err = new Error('missing_api_key');
    err.friendly = 'חסר מפתח OPENAI_API_KEY בקובץ .env בשרת.';
    throw err;
  }
  const chosen = modelOverride || model();
  const body = {
    model: chosen,
    max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  // JSON mode: the reply is always parseable, so no fence-stripping and no
  // tokens wasted on the model explaining itself
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`openai_${res.status}`);
    err.friendly = res.status === 429
      ? 'השירות עמוס כרגע — נסו שוב בעוד רגע.'
      : 'תקלה זמנית בשירות — נסו שוב בעוד רגע.';
    err.detail = detail.slice(0, 400);
    throw err;
  }
  const data = await res.json();
  track(data.usage, chosen);
  return (data.choices && data.choices[0] && data.choices[0].message.content) || '';
}

function track(usage, usedModel) {
  if (!usage) return;
  const p = PRICES[usedModel || model()] || PRICES[DEFAULT_MODEL];
  const inTok = usage.prompt_tokens || 0;
  const outTok = usage.completion_tokens || 0;
  spend.calls++; spend.input += inTok; spend.output += outTok;
  spend.usd += (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
  console.log(
    `[openai] ${usedModel || model()} in=${inTok} out=${outTok} | ` +
    `total: ${spend.calls} calls, $${spend.usd.toFixed(4)} (~${(spend.usd * 3.7).toFixed(2)}₪)`
  );
}

module.exports = { callOpenAI, spend, model, DEFAULT_MODEL };
