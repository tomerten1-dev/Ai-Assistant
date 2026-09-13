'use strict';
/* ONE place that knows which season we are selling.

   It used to be written out in about a dozen: the years 2026/2027 in five
   files, the four month numbers in eleven, and the Hebrew holiday dates keyed
   to one Hebrew year. Meanwhile data/config/date-labels.json declared the
   season start and end — and nothing read it. It was documentation, not
   configuration.

   The dangerous one was data/inventory.js: `y = mo >= 11 ? '2026' : '2027'`.
   Next season that stamps the WRONG year onto every workbook row with a bare
   dd/mm label, and produces a complete, self-consistent, wrong inventory that
   no test catches. It fails silently, which is the worst way to fail.

   Everything here comes from data/config/date-labels.json. Rolling the season
   over is editing that file. */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'config', 'date-labels.json');

// Hebrew month names, for the labels the customer reads. Keyed by number, so
// a season that includes November needs no code change — only the config.
const MONTH_HE = {
  1: 'ינואר', 2: 'פברואר', 3: 'מרץ', 4: 'אפריל', 5: 'מאי', 6: 'יוני',
  7: 'יולי', 8: 'אוגוסט', 9: 'ספטמבר', 10: 'אוקטובר', 11: 'נובמבר', 12: 'דצמבר',
};

let cached = null, cachedAt = 0;

function raw() {
  // re-read on change, like guidance.js and catalogue.js — a season rollover
  // should not need a restart, and a broken edit must not empty the season
  try {
    const mtime = fs.statSync(FILE).mtimeMs;
    if (cached && mtime === cachedAt) return cached;
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cached = parsed; cachedAt = mtime;
    return parsed;
  } catch (e) {
    return cached || {};
  }
}

function bounds() {
  const s = (raw().season || {});
  const start = String(s.start || '2026-12-05');
  const end = String(s.end || '2027-03-28');
  return { start, end };
}

function startYear() { return +bounds().start.slice(0, 4); }
function endYear() { return +bounds().end.slice(0, 4); }

/* The months we sell, in selling order, derived from the bounds rather than
   listed. December→March comes out as [12, 1, 2, 3]; a season that started in
   November would come out as [11, 12, 1, 2, 3] with no code change. */
function months() {
  const { start, end } = bounds();
  const out = [];
  let y = +start.slice(0, 4), m = +start.slice(5, 7);
  const ey = +end.slice(0, 4), em = +end.slice(5, 7);
  for (let guard = 0; guard < 24; guard++) {
    out.push(m);
    if (y === ey && m === em) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function inSeason(month) { return months().includes(+month); }

// which calendar year a given month of this season falls in
function yearOf(month) {
  const m = +month;
  const { start } = bounds();
  const sy = +start.slice(0, 4), sm = +start.slice(5, 7);
  // months at or after the starting month belong to the starting year; the
  // rest have wrapped into the next one
  return m >= sm ? sy : sy + 1;
}

// "2026/27" for the sentence that tells a customer which season we sell
function label() {
  const a = startYear(), b = endYear();
  return b === a ? String(a) : a + '/' + String(b).slice(-2);
}

function monthHe(month) { return MONTH_HE[+month] || null; }

// the human sentence, generated rather than written out in two files
function seasonSentence() {
  const ms = months();
  const first = monthHe(ms[0]), last = monthHe(ms[ms.length - 1]);
  return `אנחנו מוכרים כרגע את עונת חורף ${label()} — ${first} ${startYear()} עד סוף ${last} ${endYear()}.`;
}

// a year the customer named that is not part of this season
function isWrongYear(year) {
  const y = +year;
  if (!y) return false;
  return y !== startYear() && y !== endYear();
}

/* Jewish holidays move by weeks between Hebrew years, so they cannot be a
   constant in code — and they were one: חנוכה was hard-coded to early
   December and פורים to late March, which is תשפ"ז and nothing else. A family
   saying "בפורים" next season would be filtered, silently, to the wrong third
   of the month.
   Each entry may carry `month`, `month_part` and an ISO `from`/`to`. */
function holidays() {
  const labels = raw().labels || {};
  const out = {};
  for (const [name, def] of Object.entries(labels)) {
    if (!def || def.type !== 'holiday') continue;
    out[name] = {
      display_he: def.display_he || name,
      month: def.month != null ? +def.month : null,
      month_part: def.month_part || null,
      from: def.from || null,
      to: def.to || null,
      sellable: def.sellable !== false,
    };
  }
  return out;
}

function holiday(name) { return holidays()[name] || null; }

module.exports = {
  bounds, startYear, endYear, months, inSeason, yearOf, label, monthHe,
  seasonSentence, isWrongYear, holidays, holiday, MONTH_HE,
};
