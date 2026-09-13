#!/usr/bin/env node
'use strict';
/* PLACEHOLDER — this script does not exist yet, and says so instead of
   producing a file.

   `npm run build:data` has named tools/build-camps.js since the beginning and
   no such file was ever committed, so data/camps.json is a snapshot with no
   regenerator. That matters more than it sounds: camps.json decides whether a
   family is told the Hebrew kids' club runs on their week, which is the most
   expensive promise this bot makes.

   Writing it needs the SOURCE, which is not in this repository and which I
   have not seen: the per-week, per-group registration data (age group, level,
   waiting-list flag, minimum children, capacity, taken). It is not in the
   commitments workbook — that file holds rooms, not camp registrations.

   Guessing at that format would produce a plausible camps.json that is wrong,
   and wrong here means telling a family the club runs when it does not. So
   this refuses to run.

   To finish it, one of:
     - point it at the file or export the camp registrations come from, or
     - if they are maintained by hand, keep data/camps.json as the source of
       truth, delete this script, and remove it from `npm run build:data`.

   The shape it must produce is data/camps.json:
     { age_policy: { regular, young, overall }, resorts: [...],
       weeks: [ { resort, country, week: 'YYYY-MM-DD', no_camp: bool,
                  groups: [ { age_group: '4-6' | '6-13', level,
                              is_waitlist, min_children, capacity, taken, free } ] } ] }
   and data/camps.json → age_policy.overall is the ONE place the 4-14 boundary
   is written down (server/season.js and SkiSearch.campAgeRange read it). */

console.error([
  'tools/build-camps.js is not implemented.',
  '',
  'data/camps.json is currently maintained as data, not generated. It decides',
  'whether a family is told the Hebrew kids\' club runs on their week, so it is',
  'not something to reconstruct from a guessed source format.',
  '',
  'Either point this script at the camp registration export, or drop it from',
  'the build:data script and treat data/camps.json as hand-maintained.',
].join('\n'));
process.exit(2);
