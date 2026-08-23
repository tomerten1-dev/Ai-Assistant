// BUILD STEP: fetch each hotel page on pingwin.co.il and record its main
// gallery image into data/resorts.json (image field, thumbMini.php URL).
// Content source rule: pingwin site only — these ARE their official photos.
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', 'data', 'resorts.json');
const resorts = JSON.parse(fs.readFileSync(P, 'utf8'));
const BASE = 'https://www.pingwin.co.il';

async function mainImage(page, siteID) {
  const url = `${BASE}/${page}?siteID=${siteID}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const html = await res.text();
  // gallery slides: style="background-image:url('thumbMini.php?src=FILE&targ=sID&height=999&width=640')"
  const m = html.match(/thumbMini\.php\?src=([^&'"]+)&targ=([^&'"]+)&height=\d+&width=640/);
  if (!m) return null;
  return `${BASE}/thumbMini.php?src=${m[1]}&targ=${m[2]}&height=600&width=480`;
}

(async () => {
  let ok = 0, miss = 0;
  for (const [name, info] of Object.entries(resorts.hotels)) {
    if (!info.page || !info.siteID) { miss++; continue; }
    try {
      const img = await mainImage(info.page, info.siteID);
      if (img) { info.image = img; ok++; console.log('ok  ', name); }
      else { miss++; console.log('MISS', name); }
    } catch (e) { miss++; console.log('ERR ', name, e.message); }
  }
  fs.writeFileSync(P, JSON.stringify(resorts, null, 2));
  console.log(`\nimages: ${ok} found, ${miss} missing — saved to resorts.json`);
})();
