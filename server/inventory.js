'use strict';
/* Taking a new inventory file from Pingwin's office.
 *
 * The commitments workbook lives on F:, a share inside the office network that
 * this server cannot reach. So the office pushes rather than the server pulls
 * (tools/push-availability.ps1, on Windows Task Scheduler):
 *
 *     F:\...\commitments.xlsm
 *        → node tools/build-availability.js       ← runs IN the office
 *        → availability.json  (free units, no PII)
 *        → POST /api/inventory                    ← only this crosses the wire
 *
 * The workbook has customers' names in it and never leaves the building.
 *
 * What this module refuses, and why each one is a real way to lose a season:
 *   - a wrong or missing token                     → anyone could set our stock
 *   - anything that fails the PII gate             → the sender is not trusted
 *   - a file that lost most of its units           → a half-written or
 *     truncated workbook would empty the bot silently
 *   - a file older than the one we already have    → a retry of an old push,
 *     or two machines pushing, must not move us backwards
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gate = require('../data/pii-gate.js');

const FILE = path.join(__dirname, '..', 'data', 'availability.json');
const STAMP = path.join(__dirname, '..', 'server-data', 'inventory-stamp.json');
// a push that drops the stock by more than this is treated as a broken file
const MIN_KEEP = Number(process.env.INVENTORY_MIN_RATIO || 0.5);

const token = () => process.env.INVENTORY_TOKEN || '';
const enabled = () => !!token() || localOnly();

/* Running on a laptop with no token set, reached from that same laptop.
 *
 * Not a back door: whoever can open a socket on 127.0.0.1 of this machine can
 * already read the files this endpoint writes. It exists so that trying the
 * page locally does not require inventing a secret first.
 *
 * Two guards, and both must hold. TRUST_PROXY means a proxy is in front, and
 * then EVERY request looks like it came from 127.0.0.1 — that is the one way
 * this could become a real hole, so it is off entirely in that case. And a
 * server with a token configured is a real one; it never takes this path.
 */
function localOnly() {
  return !token() && process.env.TRUST_PROXY !== '1';
}
function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function authorised(req) {
  const want = token();
  if (!want) return localOnly() && isLoopback(req);
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  // constant time, and only after the lengths match — timingSafeEqual throws
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function current() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return null; }
}

// Everything that must be true before this replaces a working season's stock.
function validate(next, now = current()) {
  if (!next || typeof next !== 'object') return 'not a JSON object';
  if (!Array.isArray(next.units)) return 'no units list';
  if (!next.units.length) return 'no units at all';
  const problems = gate.check(next);
  if (problems.length) return 'PII gate: ' + problems.slice(0, 3).join('; ');
  const have = (now && Array.isArray(now.units)) ? now.units.length : 0;
  if (have && next.units.length < have * MIN_KEEP) {
    return `only ${next.units.length} units against ${have} — refusing, this looks truncated`;
  }
  const ts = Date.parse(next.generated_at || '');
  if (!ts) return 'no generated_at — cannot tell how old this is';
  if (ts > Date.now() + 6 * 3600e3) return 'generated_at is in the future';
  const had = Date.parse((now && now.generated_at) || '') || 0;
  if (had && ts < had) return 'older than the file we already have';
  return null;
}

// Written to a neighbour and renamed: a half-written availability.json is the
// one file that would take the whole bot down.
function writeAtomic(text) {
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, FILE);
}

function stamp(rec) {
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, JSON.stringify(rec));
  } catch (e) { /* the stamp is a convenience; the file's mtime is the truth */ }
}
function lastPush() {
  try { return JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch (e) { return null; }
}

// Accept or refuse. Returns {ok, status, body} — never throws at the caller.
function accept(req, next) {
  if (!authorised(req)) {
    return token()
      ? { ok: false, status: 401, body: { error: 'bad token' } }
      : { ok: false, status: 503, body: { error: 'INVENTORY_TOKEN is not set on this server' } };
  }
  const now = current();
  const why = validate(next, now);
  if (why) {
    console.error('inventory push REFUSED: %s', why);
    stamp({ at: new Date().toISOString(), ok: false, why });
    return { ok: false, status: 422, body: { error: why } };
  }
  try {
    writeAtomic(JSON.stringify(next, null, 1));
  } catch (e) {
    console.error('inventory push could not be written: %s', e.message);
    return { ok: false, status: 500, body: { error: 'could not write' } };
  }
  const rec = {
    at: new Date().toISOString(), ok: true,
    generated_at: next.generated_at,
    units: next.units.length,
    rooms: next.units.reduce((n, u) => n + (u.count || 0), 0),
    was: now && Array.isArray(now.units) ? now.units.length : 0,
  };
  stamp(rec);
  console.log('inventory updated — %d unit groups (%d rooms), workbook read %s',
    rec.units, rec.rooms, rec.generated_at);
  return { ok: true, status: 200, body: rec };
}

/* ---------- freshness ----------
   Nothing here can stop a room being sold between two pushes; the point is to
   know how wide that window currently is, and to stop making the one claim
   that goes stale fastest. */
const STALE_HOURS = Number(process.env.INVENTORY_STALE_HOURS || 12);
function ageHours(av) {
  const ts = Date.parse((av && av.generated_at) || '');
  if (!ts) return null;                       // an older file with no stamp
  return (Date.now() - ts) / 3600e3;
}
function stale(av) {
  const h = ageHours(av);
  return h != null && h > STALE_HOURS;
}

module.exports = { accept, validate, authorised, enabled, localOnly, current, lastPush,
  ageHours, stale, STALE_HOURS, FILE, STAMP };
