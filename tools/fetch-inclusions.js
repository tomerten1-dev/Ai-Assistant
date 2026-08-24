// BUILD STEP: read "המחיר כולל" off each hotel page on pingwin.co.il and store
// it per hotel, so a card can say what THAT package includes.
//
// It differs hotel by hotel and that is the point: some are half board only,
// some let the customer choose breakfast or half board for a supplement, some
// include a ski pass and Bulgaria never does, some run their own morning
// shuttle. A single generic sentence would be wrong for most of them.
//
// Deterministic parsing, no model: the pages lay it out as
//     <div class="mini_td1">המחיר כולל</div><div class="mini_td2">…</div>
// so the text is taken verbatim (red rule 5 — pingwin.co.il is the only source).
const fs = require('fs');
const path = require('path');

const P = path.join(__dirname, '..', 'data', 'resorts.json');
const resorts = JSON.parse(fs.readFileSync(P, 'utf8'));
const BASE = 'https://www.pingwin.co.il';

// the label cell, then the value cell that follows it
const CELL = /<div class="mini_td1">([^<]{1,40})<\/div>\s*<div class="mini_td2">([\s\S]*?)<\/div>/g;

function clean(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'")
    .split('\n').map(x => x.trim()).filter(Boolean).join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function inclusions(page, siteID) {
  const res = await fetch(`${BASE}/${page}?siteID=${siteID}`, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const found = {};
  for (const m of html.matchAll(CELL)) {
    const label = clean(m[1]);
    if (/כולל/.test(label)) found[label] = clean(m[2]);
  }
  // "המחיר כולל" is the one we want; a page may also carry "המחיר אינו כולל"
  const includes = found['המחיר כולל'] || null;
  const excludes = found['המחיר אינו כולל'] || found['המחיר לא כולל'] || null;
  return { includes, excludes };
}

(async () => {
  let ok = 0, miss = [];
  for (const [name, info] of Object.entries(resorts.hotels)) {
    if (!info.page || !info.siteID) { miss.push(name); continue; }
    try {
      const r = await inclusions(info.page, info.siteID);
      if (r && r.includes) {
        info.package_includes_he = r.includes;
        if (r.excludes) info.package_excludes_he = r.excludes;
        else delete info.package_excludes_he;
        ok++;
        console.log(`ok   ${name.padEnd(30)} ${r.includes.slice(0, 60)}…`);
      } else {
        miss.push(name);
        console.log('MISS ' + name);
      }
    } catch (e) { miss.push(name); console.log('ERR  ' + name + ' ' + e.message); }
    await new Promise(r => setTimeout(r, 120));
  }
  fs.writeFileSync(P, JSON.stringify(resorts, null, 2) + '\n');
  console.log(`\n${ok} hotels with "המחיר כולל"` + (miss.length ? `, ${miss.length} without: ${miss.join(', ')}` : ''));
})();
