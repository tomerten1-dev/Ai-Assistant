'use strict';
// The Hebrew name of a ski resort, in one place.
//
// It used to be written three times — in the card, in the prompt that words the
// reply, and in the catalogue build — and the three had drifted: "לה דו אלפ"
// against "לה דוז אלפ", "סולדו" against "סולדאו", "אלפ ד'ואז" against
// "אלפ ד'הואז". A customer could read one spelling on the card and another in
// the sentence above it, in the same answer.
//
// config/resort-names.json is Tomer's file; a spelling he corrects is one edit.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'resort-names.json');
let cache = null, stamp = -1;

function load() {
  let now = 0;
  try { now = fs.statSync(FILE).mtimeMs; } catch (e) { now = 0; }
  if (cache && now === stamp) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8')).resorts || {};
  } catch (e) {
    // a broken edit must not take the bot down: keep what we had, and fall back
    // to showing the Latin name, which is wrong but readable
    if (stamp !== now) console.error('resort-names.json unreadable (%s)', e.message);
    cache = cache || {};
  }
  stamp = now;
  return cache;
}

// The Hebrew name, or the original if we have none — never empty.
function resortHe(name) {
  if (!name) return name;
  return load()[name] || name;
}
module.exports = { resortHe, all: load, FILE };
