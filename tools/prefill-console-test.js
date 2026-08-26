// בדיקה ידנית של מילוי טופס ההזמנה — בלי GTM ובלי שרת.
//
// למה זה קיים: הסקריפט האמיתי (public/pingwin-prefill.js) מוגש מהשרת שלנו
// ונטען לדף של פינגווין דרך תג GTM. עד שהשרת עולה לאוויר אין דרך לטעון אותו
// לאתר האמיתי — ולכן קישור עם הפרמטרים לבדו לא עושה כלום.
//
// איך בודקים עכשיו:
//   1. לפתוח דף מלון עם הפרמטרים, למשל:
//      https://www.pingwin.co.il/Plein+Sud.html?siteID=1288&tab=20&pwfrom=30.01.2027&pwtill=06.02.2027&pwad=3&pwroom=2%20%D7%97%22%D7%A9%20%D7%95%D7%A1%D7%9C%D7%95%D7%9F%202-4%20%D7%90%D7%95%D7%A8%D7%97%D7%99%D7%9D&pwpans=1&pwquote=1
//   2. F12 → Console
//   3. להדביק את כל מה שמתחת → Enter
//   4. התאריכים, החדר, מספר האורחים ובסיס האירוח מתמלאים, ואם יש pwquote=1
//      גם נלחץ "הפקת הצעת מחיר" — אבל רק אחרי שיש מחיר לחדר.
//
// זה בדיוק אותו קוד שיגיע דרך GTM, בלי ההערות.

(function () {
  'use strict';
  if (window.__pwPrefillRan) return;
  window.__pwPrefillRan = true;
  var NS = 'pw';
  var q = {};
  try {
    var sp = new URLSearchParams(window.location.search);
    ['from', 'till', 'room', 'ad', 'kids', 'pans', 'quote'].forEach(function (k) {
      var v = sp.get(NS + k);
      if (v) q[k] = v;
    });
  } catch (e) { return; }
  if (!q.from || !q.till) return;                    // not one of our links
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
      if (waited > 15000) clearInterval(timer);     // the page is not a booking page
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
        if (tries > 60) { clearInterval(t); resolve(false); }   // ~9s
      }, 150);
    });
  }
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/["'׳״]/g, '').replace(/[֑-ׇ]/g, '')
      .replace(/[^א-תa-z0-9]+/g, ' ').trim();
  }
  function waitForRooms() {
    if (!q.room) return Promise.resolve(null);
    var want = norm(q.room);
    if (!want) return Promise.resolve(null);
    var tries = 0;
    return new Promise(function (resolve) {
      var t = setInterval(function () {
        tries++;
        var sel = document.querySelector('#roomsBlock select.roomSelect');
        var opts = sel ? Array.prototype.slice.call(sel.options).filter(function (o) { return o.value && o.value !== '0'; }) : [];
        if (!opts.length) {
          if (tries > 60) { clearInterval(t); resolve(null); }   // ~9s
          return;
        }
        clearInterval(t);
        var exact = opts.filter(function (o) { return norm(o.textContent) === want; });
        if (exact.length === 1) return resolve(exact[0].value);
        var partial = opts.filter(function (o) {
          var n = norm(o.textContent);
          return n.indexOf(want) >= 0 || want.indexOf(n) >= 0;
        });
        resolve(partial.length === 1 ? partial[0].value : null);
      }, 150);
    });
  }
})();