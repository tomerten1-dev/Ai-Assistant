'use strict';
/* Whether the model layer is actually working.

   Every stage of this bot degrades to a deterministic floor, which is the
   right design and also the reason a total provider outage is invisible: the
   customer still gets an answer, just a plainer one, with FAQ routing quietly
   switched off. There were thirty `console.error` sites and not one counter,
   and `/healthz` reported `mode: "openai"` from the mere presence of a key —
   so a monitor watching it saw green while 100% of calls failed.

   Two jobs here:
     1. Count what happens, per stage, so /healthz and the conversation log can
        say "the model layer is off" instead of implying it is on.
     2. Trip a breaker after repeated transport failures, so a degraded
        provider costs one slow turn rather than every turn until someone
        notices. It closes again on its own after a cooldown. */

const STAGES = ['slots', 'router', 'phrase'];

function blank() {
  const s = {};
  for (const k of STAGES) s[k] = { calls: 0, ok: 0, failed: 0, rejected: 0 };
  return s;
}

let stats = blank();
let startedAt = Date.now();
// consecutive transport failures across all stages — a provider that is down
// fails every stage, so they are counted together
let consecutiveFailures = 0;
let openedAt = 0;

const THRESHOLD = () => Math.max(1, +(process.env.MODEL_BREAKER_FAILURES || 5));
const COOLDOWN_MS = () => Math.max(5_000, +(process.env.MODEL_BREAKER_COOLDOWN_MS || 60_000));

function stage(name) { return STAGES.includes(name) ? name : 'slots'; }

function called(name) { stats[stage(name)].calls++; }

function ok(name) {
  stats[stage(name)].ok++;
  consecutiveFailures = 0;
  openedAt = 0;
}

/* A transport failure: timeout, 429, 5xx, network. This is what trips the
   breaker — unlike a rejection, it says nothing about the answer and
   everything about the provider. */
function failed(name, err) {
  stats[stage(name)].failed++;
  consecutiveFailures++;
  if (consecutiveFailures >= THRESHOLD() && !openedAt) {
    openedAt = Date.now();
    console.error('model breaker OPEN after', consecutiveFailures,
      'consecutive failures; falling back to the free layer for',
      Math.round(COOLDOWN_MS() / 1000) + 's. last error:', err && err.message);
  }
}

/* The call succeeded and the answer was thrown away by a validator. Worth
   counting separately — it is a prompt or model-quality problem, not an
   outage — and it must never trip the breaker. */
function rejected(name, why) {
  stats[stage(name)].rejected++;
  consecutiveFailures = 0;
  if (why) stats[stage(name)].last_rejection = String(why).slice(0, 80);
}

// true while the breaker is open; closes itself when the cooldown elapses
function open() {
  if (!openedAt) return false;
  if (Date.now() - openedAt >= COOLDOWN_MS()) {
    openedAt = 0;
    consecutiveFailures = 0;
    console.error('model breaker CLOSED — trying the provider again');
    return false;
  }
  return true;
}

function totals() {
  let calls = 0, failed_ = 0, rejected_ = 0;
  for (const k of STAGES) {
    calls += stats[k].calls; failed_ += stats[k].failed; rejected_ += stats[k].rejected;
  }
  return { calls, failed: failed_, rejected: rejected_ };
}

/* What /healthz reports. `degraded` is the field a monitor should alert on:
   it is true when the breaker is open, or when a meaningful share of recent
   calls failed — not merely when a key is missing, which is a configuration
   choice rather than a fault. */
function report() {
  const t = totals();
  const failRate = t.calls ? t.failed / t.calls : 0;
  return {
    breaker_open: open(),
    degraded: open() || (t.calls >= 5 && failRate > 0.5),
    since: new Date(startedAt).toISOString(),
    consecutive_failures: consecutiveFailures,
    ...t,
    by_stage: stats,
  };
}

// per-turn summary for the conversation log, so a quiet degradation is visible
// in the weekly review rather than only in a live health check
function turnFlags() {
  return { breaker_open: open(), consecutive_failures: consecutiveFailures };
}

function reset() { stats = blank(); startedAt = Date.now(); consecutiveFailures = 0; openedAt = 0; }

module.exports = { called, ok, failed, rejected, open, report, turnFlags, reset, STAGES };
