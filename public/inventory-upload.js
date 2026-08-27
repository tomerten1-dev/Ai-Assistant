/* The browser half of the inventory update.
 *
 * Everything specific to running in a browser lives here; the parsing itself is
 * the server's own code, served untouched from /mod/... and loaded above. That
 * is the whole point — a workbook parsed in Chrome must produce exactly what a
 * workbook parsed by the build produces, and the only way to be sure is for it
 * to be the same code.
 *
 * Two things node has that a browser does not:
 *   fs      — replaced by the dropped File
 *   zlib    — replaced by DecompressionStream('deflate-raw')
 * and Buffer, whose five methods the reader uses are shimmed below.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Buffer, as much of it as tools/xlsx-read.js asks for ---------- */
  function wrap(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    u8.readUInt16LE = function (o) { return dv.getUint16(o, true); };
    u8.readUInt32LE = function (o) { return dv.getUint32(o, true); };
    u8.toString = function (enc) {
      // the reader only ever asks for utf8, and the workbook's XML is utf8
      return new TextDecoder(enc === 'utf8' || !enc ? 'utf-8' : enc).decode(u8);
    };
    var slice = u8.slice.bind(u8), sub = u8.subarray.bind(u8);
    u8.slice = function (a, b) { return wrap(slice(a, b)); };
    u8.subarray = function (a, b) { return wrap(sub(a, b)); };
    return u8;
  }

  /* ---------- unzip, the one part that cannot be shared ---------- */
  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return wrap(new Uint8Array(await out.arrayBuffer()));
  }
  async function unzip(buf) {
    // same walk as the node reader: find the end-of-central-directory, then
    // read each entry's local header for its true data offset
    var eocd = -1;
    for (var i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('הקובץ אינו xlsx/xlsm תקין');
    var n = buf.readUInt16LE(eocd + 10), off = buf.readUInt32LE(eocd + 16), files = {};
    for (var k = 0; k < n; k++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir');
      var method = buf.readUInt16LE(off + 10);
      var csize = buf.readUInt32LE(off + 20);
      var nameLen = buf.readUInt16LE(off + 28);
      var extraLen = buf.readUInt16LE(off + 30);
      var cmtLen = buf.readUInt16LE(off + 32);
      var lho = buf.readUInt32LE(off + 42);
      var name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
      var lNameLen = buf.readUInt16LE(lho + 26), lExtraLen = buf.readUInt16LE(lho + 28);
      var start = lho + 30 + lNameLen + lExtraLen;
      var raw = buf.subarray(start, start + csize);
      files[name] = method === 0 ? wrap(raw) : await inflateRaw(raw);
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return files;
  }

  /* ---------- the page ---------- */
  var steps = $('progress');
  function step(text, state) {
    var d = document.createElement('div');
    d.className = 'step ' + (state || '');
    d.innerHTML = '<i>' + (state === 'ok' ? '✓' : state === 'bad' ? '✕' : '·') + '</i><span></span>';
    d.lastChild.textContent = text;
    steps.appendChild(d); steps.hidden = false;
    return d;
  }

  var payload = null;

  async function handle(file) {
    steps.innerHTML = ''; steps.hidden = true;
    $('result').hidden = true; $('sent').textContent = ''; payload = null;
    var t0 = Date.now();
    try {
      step('נקרא: ' + file.name + ' (' + (file.size / 1048576).toFixed(1) + ' MB)', 'ok');
      var files = await unzip(wrap(new Uint8Array(await file.arrayBuffer())));
      step('נפרק (' + Object.keys(files).length + ' חלקים)', 'ok');

      var inv = window.__mods['data/inventory.js'];
      var rows = inv.parseWorkbookFiles(files);
      var st = inv.stats(rows);
      step('פוענח: ' + rows.length + ' שורות, מתוכן ' + (st.status.free || 0) + ' פנויות', 'ok');

      var out = window.__mods['data/aggregate.js'].toAvailability(rows, st);
      var problems = window.__mods['data/pii-gate.js'].check(out);
      if (problems.length) {
        step('בדיקת מידע אישי נכשלה — לא נשלח כלום', 'bad');
        problems.slice(0, 5).forEach(function (p) { step(p, 'bad'); });
        return;
      }
      step('בדיקת מידע אישי: נקי — אין שמות, טלפונים או מספרי הזמנה', 'ok');
      step('סה"כ ' + ((Date.now() - t0) / 1000).toFixed(1) + ' שניות', '');

      payload = out;
      show(out);
    } catch (e) {
      step('שגיאה: ' + (e && e.message || e), 'bad');
    }
  }

  function show(out) {
    var rooms = out.units.reduce(function (n, u) { return n + u.count; }, 0);
    var hotels = {}; out.units.forEach(function (u) { hotels[u.hotel] = 1; });
    $('counts').innerHTML = '';
    [[out.units.length, 'שורות מלאי'], [rooms, 'חדרים פנויים'],
     [Object.keys(hotels).length, 'מלונות'],
     [out.season.first_date + ' – ' + out.season.last_date, 'טווח']].forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'big'; d.textContent = p[0];
      var s = document.createElement('span'); s.textContent = p[1];
      d.appendChild(s); $('counts').appendChild(d);
    });

    var t = $('preview');
    t.innerHTML = '<tr><th>מלון</th><th>תאריך</th><th>חדר</th><th>פנויים</th></tr>';
    out.units.slice(0, 8).forEach(function (u) {
      var tr = t.insertRow();
      [u.hotel, u.date, u.room, u.count].forEach(function (v, i) {
        var td = tr.insertCell();
        td.textContent = v;
        // Latin text inside an RTL table: "2 bedroom apt 4-5 pax" renders as
        // "bedroom apt 4-5 pax 2" without this — the leading number is taken
        // for part of the Hebrew run and moved to the other end
        if (i < 3) { td.dir = 'ltr'; td.style.textAlign = 'right'; }
      });
    });
    if (out.units.length > 8) {
      var tr = t.insertRow(); var td = tr.insertCell();
      td.colSpan = 4; td.style.color = 'var(--dim)';
      td.textContent = 'ועוד ' + (out.units.length - 8) + ' שורות';
    }
    $('raw').textContent = JSON.stringify(out, null, 1).slice(0, 4000) + '\n…';
    $('result').hidden = false;
    $('send').disabled = !$('token').value.trim();
  }

  /* ---------- drop target ---------- */
  var drop = $('drop'), input = $('file');
  drop.addEventListener('click', function () { input.click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', function () { if (input.files[0]) handle(input.files[0]); });
  ['dragenter', 'dragover'].forEach(function (n) {
    drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (n) {
    drop.addEventListener(n, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files[0];
    if (f) handle(f);
  });

  $('token').addEventListener('input', function () {
    $('send').disabled = !payload || !$('token').value.trim();
  });

  $('send').addEventListener('click', async function () {
    var btn = $('send'); btn.disabled = true; $('sent').textContent = 'שולח…';
    try {
      var r = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'content-type': 'application/json',
                   authorization: 'Bearer ' + $('token').value.trim() },
        body: JSON.stringify(payload),
      });
      var body = await r.json().catch(function () { return {}; });
      if (r.ok) {
        $('sent').className = 'ok';
        $('sent').textContent = '✓ המלאי עודכן: ' + body.units + ' שורות, ' + body.rooms + ' חדרים.';
      } else {
        $('sent').className = 'bad';
        $('sent').textContent = '✕ השרת דחה (' + r.status + '): ' + (body.error || '');
        btn.disabled = false;
      }
    } catch (e) {
      $('sent').className = 'bad';
      $('sent').textContent = '✕ לא הצלחנו להגיע לשרת: ' + e.message;
      btn.disabled = false;
    }
  });
})();
