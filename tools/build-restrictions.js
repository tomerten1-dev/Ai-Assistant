#!/usr/bin/env node
'use strict';
/* PLACEHOLDER — this script does not exist yet, and says so instead of
   producing a file.

   Same situation as tools/build-camps.js: `npm run build:data` has always
   named it and it was never committed, so data/restrictions.json is a snapshot
   with no regenerator.

   restrictions.json records which departure dates carry the "commitments only"
   rule (restricted) and which are free of it (open). On an open date the bot
   may name a hotel we hold no commitment for; on a restricted one it may not.
   Getting that backwards means offering something we cannot supply.

   The source is a business decision per departure date, not a derivation from
   the commitments workbook — which is why it cannot be rebuilt from the .xlsm
   the way availability can.

   To finish it, either point it at wherever those dates are recorded, or drop
   it from build:data and keep data/restrictions.json hand-maintained.

   Shape:
     { restricted: ['YYYY-MM-DD', ...], open: ['YYYY-MM-DD', ...] } */

console.error([
  'tools/build-restrictions.js is not implemented.',
  '',
  'data/restrictions.json is a business decision per departure date, not a',
  'derivation from the commitments workbook, so there is nothing to rebuild it',
  'FROM inside this repository.',
  '',
  'Either point this script at the source, or drop it from the build:data',
  'script and treat data/restrictions.json as hand-maintained.',
].join('\n'));
process.exit(2);
