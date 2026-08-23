// Minimal zero-dependency .xlsx/.xlsm reader.
// Returns cell TEXT + resolved FILL COLOR, which is what the commitments
// workbook uses to encode room status. Server/build side only.
const fs = require('fs');
const zlib = require('zlib');

/* ---------- zip ---------- */
function unzip(buf) {
  // locate End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // local header -> data start
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

/* ---------- xml helpers (attribute-level, no full DOM) ---------- */
function attr(tag, name) {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? m[1] : null;
}
function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/&amp;/g, '&');
}

/* ---------- indexed palette (legacy ColorIndex ordering) ---------- */
const INDEXED = ['000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
'000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF','800000','008000',
'000080','808000','800080','008080','C0C0C0','808080','9999FF','993366','FFFFCC','CCFFFF',
'660066','FF8080','0066CC','CCCCFF','000080','FF00FF','FFFF00','00FFFF','800080','800000',
'008080','0000FF','00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
'3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696','003366','339966',
'003300','333300','993300','993366','333399','333333'];

function themeColors(xml) {
  if (!xml) return [];
  const clr = xml.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/);
  if (!clr) return [];
  const out = [];
  for (const m of clr[0].matchAll(/<a:(sysClr|srgbClr)\s([^/>]*)\/?>/g)) {
    out.push(m[1] === 'sysClr' ? (attr(' ' + m[2], 'lastClr') || '000000')
                               : (attr(' ' + m[2], 'val') || '000000'));
  }
  // OOXML theme order is dk1/lt1/dk2/lt2; Excel indexes them lt1,dk1,lt2,dk2
  if (out.length >= 4) { const t = out[0]; out[0] = out[1]; out[1] = t;
                         const u = out[2]; out[2] = out[3]; out[3] = u; }
  return out;
}

function applyTint(hex, tint) {
  if (!tint) return hex;
  const t = parseFloat(tint);
  const ch = [0, 2, 4].map(i => parseInt(hex.substr(i, 2), 16));
  const out = ch.map(c => {
    const v = t < 0 ? c * (1 + t) : c * (1 - t) + 255 * t;
    return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  });
  return out.join('').toUpperCase();
}

/* ---------- styles ---------- */
function parseStyles(xml, theme) {
  const fills = [];
  const fillsBlock = xml.match(/<fills[\s\S]*?<\/fills>/);
  if (fillsBlock) {
    for (const f of fillsBlock[0].matchAll(/<fill>([\s\S]*?)<\/fill>/g)) {
      const body = f[1];
      const pat = body.match(/<patternFill[^>]*>/) || body.match(/<patternFill[^>]*\/>/);
      const type = pat ? attr(pat[0], 'patternType') : null;
      if (!type || type === 'none') { fills.push(null); continue; }
      const fg = body.match(/<fgColor[^>]*\/?>/);
      if (!fg) { fills.push(type === 'gray125' ? null : { rgb: null, raw: 'pattern:' + type }); continue; }
      const tag = fg[0];
      let rgb = null;
      const indexed = attr(tag, 'indexed'), themeIdx = attr(tag, 'theme');
      const direct = attr(tag, 'rgb');
      if (direct) rgb = direct.length === 8 ? direct.slice(2) : direct;
      else if (indexed != null) rgb = INDEXED[+indexed] || null;
      else if (themeIdx != null) rgb = theme[+themeIdx] || null;
      if (rgb) rgb = applyTint(rgb.toUpperCase(), attr(tag, 'tint'));
      fills.push({ rgb, indexed: indexed == null ? null : +indexed,
                   theme: themeIdx == null ? null : +themeIdx, tint: attr(tag, 'tint') });
    }
  }
  const xf = [];
  const cx = xml.match(/<cellXfs[\s\S]*?<\/cellXfs>/);
  if (cx) for (const m of cx[0].matchAll(/<xf\s[^>]*\/?>/g)) {
    xf.push({ fillId: +(attr(m[0], 'fillId') || 0),
              numFmtId: +(attr(m[0], 'numFmtId') || 0) });
  }
  return { fills, xf };
}

/* ---------- shared strings ---------- */
function parseSST(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = '';
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += unesc(t[1]);
    out.push(s);
  }
  return out;
}

/* ---------- serial date ---------- */
function serialToISO(n) {
  if (!(n > 0)) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function colToNum(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/); if (!m) return null;
  let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { col: c, row: +m[2] };
}

/* ---------- main ---------- */
function readWorkbook(path) {
  const files = unzip(fs.readFileSync(path));
  const txt = p => (files[p] ? files[p].toString('utf8') : null);
  const theme = themeColors(txt('xl/theme/theme1.xml'));
  const styles = parseStyles(txt('xl/styles.xml') || '', theme);
  const sst = parseSST(txt('xl/sharedStrings.xml'));

  const rels = {};
  for (const m of (txt('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\s[^>]*\/>/g)) {
    rels[attr(m[0], 'Id')] = attr(m[0], 'Target');
  }
  const sheets = [];
  for (const m of (txt('xl/workbook.xml') || '').matchAll(/<sheet\s[^>]*\/>/g)) {
    const name = unesc(attr(m[0], 'name') || '');
    const rid = attr(m[0], 'r:id');
    let target = rels[rid]; if (!target) continue;
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\/?/, '');
    sheets.push({ name, file: target });
  }

  return sheets.map(sh => {
    const xml = txt(sh.file) || '';
    // merged ranges matter: block headers are often merged cells
    const merges = [];
    for (const m of xml.matchAll(/<mergeCell\s+ref="([A-Z]+\d+):([A-Z]+\d+)"/g)) {
      const a = colToNum(m[1]), b = colToNum(m[2]);
      if (a && b) merges.push({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
    }
    const cells = new Map(); // "r,c" -> cell
    let maxRow = 0, maxCol = 0;
    for (const cm of xml.matchAll(/<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = '<c ' + cm[1] + '>';
      const inner = cm[3] || '';
      const ref = attr(tag, 'r'); if (!ref) continue;
      const rc = colToNum(ref); if (!rc) continue;
      const t = attr(tag, 't');
      const s = +(attr(tag, 's') || 0);
      let value = null, num = null;
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (t === 'inlineStr') {
        let str = ''; for (const q of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) str += unesc(q[1]);
        value = str;
      } else if (vm) {
        const raw = unesc(vm[1]);
        if (t === 's') value = sst[+raw] != null ? sst[+raw] : '';
        else if (t === 'str' || t === 'e') value = raw;
        else if (t === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else { num = parseFloat(raw); value = raw; }
      }
      const fm = inner.match(/<f[^>]*>([\s\S]*?)<\/f>/);
      const xf = styles.xf[s] || {};
      const fill = styles.fills[xf.fillId || 0] || null;
      const numFmtId = xf.numFmtId || 0;
      const isDateFmt = (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47) || numFmtId >= 164;
      const cell = {
        row: rc.row, col: rc.col, ref,
        text: value == null ? '' : String(value).trim(),
        num, fillRgb: fill ? fill.rgb : null, fillId: xf.fillId || 0,
        fillIndexed: fill ? fill.indexed : null,
        formula: fm ? unesc(fm[1]) : null,
        dateISO: (num != null && isDateFmt) ? serialToISO(num) : null,
      };
      cells.set(rc.row + ',' + rc.col, cell);
      if (rc.row > maxRow) maxRow = rc.row;
      if (rc.col > maxCol) maxCol = rc.col;
    }
    return { name: sh.name, file: sh.file, cells, merges, maxRow, maxCol,
             get(r, c) { return cells.get(r + ',' + c) || null; } };
  });
}

module.exports = { readWorkbook, serialToISO };
