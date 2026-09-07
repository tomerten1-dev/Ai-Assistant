// ═══ הדבק את כל הקובץ הזה בקונסול (F12) ═══
// 1. פתח קודם את הדף הזה — שים לב ל-tab=20, בלעדיו אין טופס הזמנה בדף:
//    https://www.pingwin.co.il/Plein+Sud.html?siteID=1288&tab=20&pwfrom=30.01.2027&pwtill=06.02.2027&pwroomid=3721&pwroom=2+bedroom+apt+4-5+pax&pwad=5&pwpans=1&pwquote=1
// 2. F12 ← Console. אם כרום חוסם הדבקה — הקלד allow pasting ו-Enter, ואז הדבק.
// 3. הדבק הכל (Ctrl+A ← Ctrl+C מכאן) ← Enter.
// אמור למלא: תאריכים 30.01–06.02.2027, חדר 3721 (2 ח"ש וסלון 5 אורחים), 5 מבוגרים,
// ואז להפיק הצעת מחיר. מעל הטופס תופיע שורה תכולה שמסבירה מאיפה הפרטים.

(function () {
  'use strict';
  if (window.__pwPrefillRan) return;
  window.__pwPrefillRan = true;
  var NS = 'pw';
  var q = {};
  try {
    var sp = new URLSearchParams(window.location.search);
    ['from', 'till', 'room', 'roomid', 'ad', 'kids', 'pans', 'quote'].forEach(function (k) {
      var v = sp.get(NS + k);
      if (v) q[k] = v;
    });
  } catch (e) { return; }
  if (!q.from || !q.till) return;                    
  var DATE = /^\d{2}\.\d{2}\.\d{4}$/;
  if (!DATE.test(q.from) || !DATE.test(q.till)) return;
  function notice(text) {
    try {
      var host = document.getElementById('step1');
      if (!host) return;
      var d = document.getElementById('pw-prefill-note');
      if (d) { d.textContent = text; return; }
      d = document.createElement('div');
      d.id = 'pw-prefill-note';
      d.setAttribute('style', 'margin:10px 0;padding:9px 13px;border-radius:9px;background:#eaf2f8;' +
        'color:#1c3d5a;font-size:14px;line-height:1.5;direction:rtl;text-align:right');
      d.textContent = text;
      host.parentNode.insertBefore(d, host);
    } catch (e) { }
  }
  var waited = 0;
  var timer = setInterval(function () {
    waited += 150;
    var om = window.orderMan;
    if (!om || typeof om.setDates !== 'function') {
      if (waited > 15000) {
        clearInterval(timer);
        if (q.from || q.roomid) {
          notice('לא הצלחתי למלא את התאריכים מהצ׳אט בדף הזה — אפשר לבחור אותם כאן.');
        }
      }
      return;
    }
    clearInterval(timer);
    try { run(om); } catch (e) {  }
  }, 150);
  function run(om) {
    var people = {};
    if (q.ad) people.adults = parseInt(q.ad, 10) || 0;
    if (q.kids) {
      people.kids = q.kids.split(',').map(function (x) { return parseInt(x, 10); })
        .filter(function (x) { return !isNaN(x) && x >= 0 && x <= 17; });
    }
    var p;
    try { p = om.setDates(q.from, q.till); } catch (e) { return; }
    Promise.resolve(p).then(function () {
      return waitForRooms();
    }).then(function (roomID) {
      if (roomID) return om.loadRoom(0, roomID, people, q.pans ? parseInt(q.pans, 10) : undefined);
      if (people.adults) {
        var sel = document.querySelector('#roomsBlock .travels select');
        if (sel) { sel.value = String(people.adults); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      return null;
    }).then(function (matched) {
      notice(matched === null
        ? 'התאריכים מולאו לפי מה שביקשתם בצ׳אט. את סוג החדר אפשר לבחור למטה.'
        : 'התאריכים והחדר מולאו לפי מה שביקשתם בצ׳אט — אפשר לשנות הכל כאן.');
      if (matched && q.quote === '1') return quoteWhenPriced();
      return null;
    }).catch(function () { });
  }
  function quoteWhenPriced() {
    var tries = 0;
    return new Promise(function (resolve) {
      var t = setInterval(function () {
        tries++;
        var price = document.querySelector('#roomsBlock .section.price span');
        var btn = document.getElementById('prop');
        if (price && String(price.textContent).trim() && btn) {
          clearInterval(t);
          notice('התאריכים והחדר מולאו לפי מה שביקשתם בצ׳אט, והצעת המחיר מופקת עכשיו — אפשר לשנות הכל למעלה.');
          btn.click();
          return resolve(true);
        }
        if (tries > 60) { clearInterval(t); resolve(false); }   
      }, 150);
    });
  }
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/["'׳״]/g, '').replace(/[֑-ׇ]/g, '')
      .replace(/(\d)([a-zא-ת])/g, '$1 $2').replace(/([a-zא-ת])(\d)/g, '$1 $2')
      .replace(/[^א-תa-z0-9]+/g, ' ').trim();
  }
  var OCC = /(\d+)\s*(?:[-–]\s*(\d+)|\+\s*(\d+))?\s*(?:pax|ppl|people|אורחים|נופשים|אנשים)/i;
  var OCC_BARE = /(\d+)\s*(?:[-–]\s*(\d+)|\+\s*(\d+))(?!\s*(?:bdrm|bedrooms?|ח["'׳״]?ש|חדרי|rooms?)\b)/i;
  function occOf(s) {
    var text = String(s || '');
    var m = OCC.exec(text) || OCC_BARE.exec(text);
    if (!m) return null;
    var a = parseInt(m[1], 10);
    var b = m[2] ? parseInt(m[2], 10) : (m[3] ? a + parseInt(m[3], 10) : a);
    return { min: Math.min(a, b), max: Math.max(a, b), said: m[0] };
  }
  function overlaps(x, y) { return !x || !y || (x.min <= y.max && y.min <= x.max); }
  function holds(occ, party) { return !party || !occ || (occ.min <= party && party <= occ.max); }
  function covers(occ, ours) { return !occ || !ours || (occ.min <= ours.min && ours.max <= occ.max); }
  var SIZE = /(\d+)\s*(?:m²|sqm|מ["'׳״]?ר|mr\b|m\b)/i;
  function sizeOf(s) {
    var m = SIZE.exec(String(s || ''));
    return m ? { m2: parseInt(m[1], 10), said: m[0] } : null;
  }
  function sizeAgrees(a, b) { return !a || !b || a.m2 === b.m2; }
  function party() {
    var n = (parseInt(q.ad, 10) || 0) + (q.kids ? String(q.kids).split(',').filter(Boolean).length : 0);
    return n > 0 ? n : 0;
  }
  var SAME = {
    "bdrm": "bdrm", "bedroom": "bdrm", "bedrooms": "bdrm", "חש": "bdrm", "חדרי": "bdrm",
    "שינה": "", "ח": "", "ש": "", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "view": "view", "נוף": "view", "balcony": "balcony", "מרפסת": "balcony",
    "studio": "studio", "סטודיו": "studio", "pmr": "pmr", "נכים": "pmr", "נגיש": "pmr",
    "dbl": "double", "double": "double", "doubles": "double", "זוגי": "double",
    "זוגית": "double", "sgl": "single", "single": "single", "יחיד": "single", "twin": "twin",
    "טווין": "twin", "triple": "triple", "טריפל": "triple", "dlx": "deluxe", "deluxe": "deluxe",
    "דלוקס": "deluxe", "j": "junior", "junior": "junior", "גוניור": "junior",
    "standard": "standard", "סטנדרט": "standard", "סטנדרד": "standard", "classic": "classic",
    "קלאסיק": "classic", "privilege": "privilege", "פריבילג": "privilege", "comfort": "comfort",
    "קומפורט": "comfort", "premier": "premier", "פרמייר": "premier", "cabin": "cabin",
    "נישה": "cabin", "sauna": "sauna", "סאונה": "sauna", "gallery": "gallery",
    "גלריה": "gallery", "mountain": "mountain", "הר": "mountain", "south": "south",
    "דרום": "south", "פונה": "", "amazing": "amazing", "premium": "premium",
    "prestige": "prestige", "superior": "superior", "suite": "suite", "סוויטה": "suite",
    "suites": "suite", "family": "family", "משפחתי": "family"
  };
  var NOISE = {
    "apt": 1, "apartment": 1, "apartments": 1, "appartement": 1, "app": 1, "appt": 1, "apts": 1,
    "דירה": 1, "דירת": 1, "room": 1, "rooms": 1, "חדר": 1, "חדרים": 1, "וסלון": 1, "סלון": 1,
    "living": 1, "lounge": 1, "with": 1, "and": 1, "the": 1, "of": 1, "pax": 1, "ppl": 1,
    "people": 1, "אורחים": 1, "נופשים": 1, "אנשים": 1, "עם": 1, "ו": 1, "conn": 1,
    "connecting": 1, "connected": 1, "מחוברים": 1, "type": 1, "טיפוס": 1, "כ": 1, "mr": 1,
    "מר": 1, "m": 1, "sqm": 1
  };
  var GENERIC = { "double": 1, "standard": 1 };
  function tokens(s) {
    var text = String(s || ''), size = sizeOf(text);
    if (size) text = text.split(size.said).join(' ');
    var occ = occOf(text);
    if (occ) text = text.split(occ.said).join(' ');
    var words = norm(text).split(/\s+/);
    var out = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (Object.prototype.hasOwnProperty.call(SAME, w)) w = SAME[w];
      if (!w || NOISE[w] === 1 || out.indexOf(w) >= 0) continue;
      out.push(w);
    }
    return out;
  }
  function subset(a, b) {
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) < 0) return false;
    return true;
  }
  function sameSet(a, b) { return a.length === b.length && subset(a, b); }
  function byDescription(opts, want) {
    var ours = tokens(want), ourOcc = occOf(want), ourSize = sizeOf(want);
    var live = [], i;
    for (i = 0; i < opts.length; i++) {
      var name = opts[i].textContent;
      if (overlaps(ourOcc, occOf(name)) && sizeAgrees(ourSize, sizeOf(name))) {
        live.push({ o: opts[i], tk: tokens(name), occ: occOf(name), size: sizeOf(name) });
      }
    }
    if (!live.length) return null;
    if (live.length === 1 && ourSize && live[0].size) {
      var theirs = live[0].tk, shares = false;
      for (i = 0; i < ours.length; i++) if (theirs.indexOf(ours[i]) >= 0) shares = true;
      if (shares || !theirs.length || !ours.length) return live[0].o.value;
    }
    var pick = function (list) {
      if (list.length === 1) return list[0].o.value;
      if (list.length < 2) return null;
      var fits = list.filter(function (x) { return holds(x.occ, party()); });
      if (party() && fits.length === 1) return fits[0].o.value;
      if (ourOcc) {
        var same = list.filter(function (x) {
          return x.occ && x.occ.max === ourOcc.max && covers(x.occ, ourOcc);
        });
        if (same.length === 1) return same[0].o.value;
      }
      return null;
    };
    var tiers = [
      function (tk) { return sameSet(ours, tk); },
      function (tk) { return ours.length && (subset(ours, tk) || subset(tk, ours)); },
    ];
    for (i = 0; i < tiers.length; i++) {
      var chosen = pick(live.filter(function (x) { return tiers[this](x.tk); }, i));
      if (chosen) return chosen;
    }
    var plain = function (list) { return list.filter(function (w) { return GENERIC[w] !== 1; }); };
    var ourPlain = plain(ours);
    if (ourPlain.length < ours.length || !ours.length) {
      return pick(live.filter(function (x) { return sameSet(ourPlain, plain(x.tk)); }));
    }
    return null;
  }
  function waitForRooms() {
    if (!q.room && !q.roomid) return Promise.resolve(null);
    var want = norm(q.room);
    var tries = 0;
    return new Promise(function (resolve) {
      var t = setInterval(function () {
        tries++;
        var sel = document.querySelector('#roomsBlock select.roomSelect');
        var opts = sel ? Array.prototype.slice.call(sel.options).filter(function (o) { return o.value && o.value !== '0'; }) : [];
        if (!opts.length) {
          if (tries > 60) { clearInterval(t); resolve(null); }   
          return;
        }
        clearInterval(t);
        if (q.roomid) {
          var byId = opts.filter(function (o) { return o.value === q.roomid; });
          if (byId.length === 1) return resolve(byId[0].value);
        }
        if (!want) return resolve(null);
        var exact = opts.filter(function (o) { return norm(o.textContent) === want; });
        if (exact.length === 1) return resolve(exact[0].value);
        var partial = opts.filter(function (o) {
          var n = norm(o.textContent);
          return n.indexOf(want) >= 0 || want.indexOf(n) >= 0;
        });
        if (partial.length === 1) return resolve(partial[0].value);
        resolve(byDescription(opts, q.room));
      }, 150);
    });
  }
})();