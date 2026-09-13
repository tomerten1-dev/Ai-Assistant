'use strict';
/* The names of things, in Hebrew, in one place.

   The country map was written out ten times across the codebase (five in
   offline-nlu.js alone, plus recommend.js, prompt-phrase.js, crm-lead.js and
   twice in server.js), the month map five times, and one of the copies was a
   variant with a ל prefix. Adding a fifth country meant finding all ten — for
   a product that is meant to be sold to other holiday companies, that is not
   configuration work, it is a code change.

   Months come from server/season.js, which reads the season file, so a season
   that includes November needs no edit here either. */

const season = require('./season.js');

const COUNTRY_HE = {
  austria: 'אוסטריה',
  france: 'צרפת',
  andorra: 'אנדורה',
  bulgaria: 'בולגריה',
};

// "לאוסטריה" / "לצרפת" — the same names with the preposition attached, which
// one of the ten copies did by hand and the others did not.
function countryTo(code) {
  const he = COUNTRY_HE[code];
  return he ? 'ל' + he : null;
}

// "באוסטריה" / "בצרפת"
function countryIn(code) {
  const he = COUNTRY_HE[code];
  return he ? 'ב' + he : null;
}

function country(code) { return COUNTRY_HE[code] || null; }

// the reverse direction: "אוסטריה" → "austria"
const BY_HE = Object.fromEntries(Object.entries(COUNTRY_HE).map(([k, v]) => [v, k]));
function countryCode(he) { return BY_HE[String(he || '').replace(/^[בל]/, '')] || null; }

function month(n) { return season.monthHe(n); }
function monthIn(n) { const he = season.monthHe(n); return he ? 'ב' + he : null; }

// "אוסטריה ובולגריה", "5, 7 ו-9" — the Hebrew list separator, which several
// call sites each re-implemented slightly differently
function list(items) {
  const xs = (items || []).filter(x => x != null && x !== '').map(String);
  if (xs.length <= 1) return xs.join('');
  return xs.slice(0, -1).join(', ') + ' ו-' + xs[xs.length - 1];
}

module.exports = {
  COUNTRY_HE, country, countryTo, countryIn, countryCode,
  month, monthIn, list, MONTHS: () => season.months(),
};
