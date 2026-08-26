'use strict';
/* Production guards for the public endpoints (work plan, stage C).
   Everything here is in-memory — one process, one site. Nothing is
   customer-visible except a polite "slow down" line.

   Env (all optional, defaults suit one busy site):
     RATE_CHAT_PER_MIN=30     turns per IP per minute
     RATE_CHAT_PER_HOUR=300   turns per IP per hour
     RATE_LEAD_PER_10MIN=5    lead submissions per IP per 10 minutes
     MAX_TURNS_PER_CHAT=80    after that the bot hands over to a human
     CHAT_TIMEOUT_MS=25000    the reply must be on its way by then
     DAILY_BUDGET_USD=0       0 = unlimited; above it the bot answers offline
     TRUST_PROXY=1            read the client IP from x-forwarded-for
     TURNSTILE_SECRET=        set → /api/chat (first turn) and /api/lead need a token
     TURNSTILE_SITEKEY=       passed to the widget via /api/config
*/
const crypto = require('crypto');

const num = (k, d) => { const v = +process.env[k]; return Number.isFinite(v) && v >= 0 ? v : d; };

/* ---------- rate limiting: fixed windows per IP, swept lazily ---------- */
const buckets = new Map(); // key → { count, resetAt }
function hit(key, limit, windowMs, now = Date.now()) {
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  return b.count <= limit ? null : Math.ceil((b.resetAt - now) / 1000);
}
// returns null when allowed, or seconds-until-retry when not
function checkRate(kind, ip, now) {
  if (kind === 'chat') {
    return hit(`c1:${ip}`, num('RATE_CHAT_PER_MIN', 30), 60_000, now)
      || hit(`c60:${ip}`, num('RATE_CHAT_PER_HOUR', 300), 3_600_000, now);
  }
  if (kind === 'lead') return hit(`l:${ip}`, num('RATE_LEAD_PER_10MIN', 5), 600_000, now);
  return null;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------- per-conversation turn cap ---------- */
const MAX_TURNS = () => num('MAX_TURNS_PER_CHAT', 80);
function turnsExceeded(slots) {
  const t = (+slots._turns || 0) + 1;
  slots._turns = t;
  return t > MAX_TURNS();
}

/* ---------- daily LLM budget ---------- */
let dayKey = null, dayStartUsd = 0;
function budgetExceeded(spendUsd, now = Date.now()) {
  const cap = num('DAILY_BUDGET_USD', 0);
  if (!cap) return false;
  const k = new Date(now).toISOString().slice(0, 10);
  if (k !== dayKey) { dayKey = k; dayStartUsd = spendUsd; }
  return (spendUsd - dayStartUsd) >= cap;
}

/* ---------- timeout ---------- */
function withTimeout(promise, ms, onTimeout) {
  let timer;
  const t = new Promise(resolve => { timer = setTimeout(() => resolve(onTimeout()), ms); });
  return Promise.race([promise.finally(() => clearTimeout(timer)), t]);
}

/* ---------- Cloudflare Turnstile ----------
   The widget solves an invisible challenge once, sends the token with the
   first turn; the server verifies it and hands back a signed stamp in the
   slots (slots._vt). Later turns carry the stamp, not a new token — one
   verification per conversation, and the stamp cannot be forged because the
   client never sees the secret. */
const turnstileOn = () => !!process.env.TURNSTILE_SECRET;
function stamp(cid) {
  return crypto.createHmac('sha256', process.env.TURNSTILE_SECRET).update('vt:' + cid).digest('base64url').slice(0, 24);
}
function stampValid(slots) {
  return !!(slots && slots._cid && slots._vt && slots._vt === stamp(slots._cid));
}
async function verifyTurnstile(token, ip, fetchImpl = fetch) {
  if (!token) return false;
  try {
    const r = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}

module.exports = { checkRate, clientIp, turnsExceeded, budgetExceeded, withTimeout,
  turnstileOn, stamp, stampValid, verifyTurnstile, _buckets: buckets };
