// BUILD STEP: fetch each hotel page on pingwin.co.il and record its gallery
// into data/resorts.json — `image` (the first, used as the card thumbnail) and
// `images[]` (the whole gallery, which the card lets the customer page through).
//
// Content source rule (red rule 5): pingwin.co.il only. These ARE their own
// official photos, served from their own thumbnail endpoint, which also means
// we never copy or re-host anything.
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', 'data', 'resorts.json');
const resorts = JSON.parse(fs.readFileSync(P, 'utf8'));
const BASE = 'https://www.pingwin.co.il';

// The page lays the gallery out twice: full slides at width=640 and a filmstrip
// at width=110. Same files, same order — read the slides and ask for the size
// the card actually needs.
const SLIDE = /thumbMini\.php\?src=([^&'"]+)&targ=([^&'"]+)&height=999&width=640/g;
const MAX = 12;   // a customer will not page through thirty photos of a lobby

async function gallery(page, siteID) {
  const res = await fetch(`${BASE}/${page}?siteID=${siteID}`, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const seen = new Set(), out = [];
  for (const m of html.matchAll(SLIDE)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(`${BASE}/thumbMini.php?src=${m[1]}&targ=${m[2]}&height=600&width=480`);
    if (out.length >= MAX) break;
  }
  return out;
}

(async () => {
  let ok = 0, miss = 0, photos = 0;
  for (const [name, info] of Object.entries(resorts.hotels)) {
    if (!info.page || !info.siteID) { miss++; continue; }
    try {
      const imgs = await gallery(info.page, info.siteID);
      if (imgs.length) {
        info.image = imgs[0];
        info.images = imgs;
        ok++; photos += imgs.length;
        console.log(`ok   ${name.padEnd(32)} ${imgs.length} תמונות`);
      } else {
        miss++; console.log('MISS ' + name);
      }
    } catch (e) { miss++; console.log('ERR  ' + name + ' ' + e.message); }
    await new Promise(r => setTimeout(r, 120));   // be a polite guest
  }
  fs.writeFileSync(P, JSON.stringify(resorts, null, 2) + '\n');
  console.log(`\n${ok} hotels, ${photos} photos, ${miss} without a gallery`);
})();
