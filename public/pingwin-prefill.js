/* pingwin-prefill.js — fills the booking form on a hotel page with what the
   customer already told Pingi.
   -----------------------------------------------------------------------
   Loaded by ONE GTM tag on pingwin.co.il (see docs/DEPLOY.md). It does nothing
   at all unless the URL carries our parameters, which only Pingi's
   "המשך להזמנה" button puts there:

       …/Plein+Sud.html?siteID=1288&pwfrom=30.01.2027&pwtill=06.02.2027
                        &pwad=3&pwkids=5,9&pwroom=2%20ח״ש%20וסלון&pwpans=1

   Why a companion script rather than a link the site understands: the quote
   form is built in the browser by order_odyssea.js, and its room list only
   arrives from the server after the dates are picked. Nothing in that flow
   reads the query string. What it does expose is the instance itself —
   window.orderMan — with setDates() and loadRoom().

   Rules this file lives by:
   - It never invents. A room it cannot match by name is left for the customer.
   - It never blocks. Every step is guarded; a failure leaves the ordinary page.
   - It runs once, and only on a page that has the booking form.            */
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

  // the customer should know why the form is already filled — and be able to
  // change it. One quiet line above the form, in their own words.
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

  // wait for order_odyssea.js to build the instance — it is created inside a
  // promise chain, so it is not there on DOMContentLoaded
  var waited = 0;
  var timer = setInterval(function () {
    waited += 150;
    var om = window.orderMan;
    if (!om || typeof om.setDates !== 'function') {
      if (waited > 15000) clearInterval(timer);     // the page is not a booking page
      return;
    }
    clearInterval(timer);
    try { run(om); } catch (e) { /* never break their page */ }
  }, 150);

  function run(om) {
    var people = {};
    if (q.ad) people.adults = parseInt(q.ad, 10) || 0;
    if (q.kids) {
      people.kids = q.kids.split(',').map(function (x) { return parseInt(x, 10); })
        .filter(function (x) { return !isNaN(x) && x >= 0 && x <= 17; });
    }

    // setDates triggers the room list; only then can a room be chosen
    var p;
    try { p = om.setDates(q.from, q.till); } catch (e) { return; }
    Promise.resolve(p).then(function () {
      return waitForRooms();
    }).then(function (roomID) {
      if (roomID) return om.loadRoom(0, roomID, people, q.pans ? parseInt(q.pans, 10) : undefined);
      // no room matched: still set the party on the first room row, so the
      // customer only has to pick the room itself
      if (people.adults) {
        var sel = document.querySelector('#roomsBlock .travels select');
        if (sel) { sel.value = String(people.adults); sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      return null;
    }).then(function (matched) {
      notice(matched === null
        ? 'התאריכים מולאו לפי מה שביקשתם בצ׳אט. את סוג החדר אפשר לבחור למטה.'
        : 'התאריכים והחדר מולאו לפי מה שביקשתם בצ׳אט — אפשר לשנות הכל כאן.');
      // Tomer, 26/08: once everything is in, produce the quote for them too.
      // "הפקת הצעת מחיר" only reveals the price breakdown and the email box —
      // it books nothing and sends nothing; the customer still decides.
      if (matched && q.quote === '1') return quoteWhenPriced();
      return null;
    }).catch(function () { });
  }

  // The quote button errors if the room has no price yet, so wait for the
  // price the server put on the row — and give up quietly if it never comes.
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

  // The room <select> is filled from the server. Match OUR room name against
  // the option text: both come from Pingwin, but the workbook and the site do
  // not always spell a room the same way, so the match is deliberately loose
  // AND deliberately unique — two candidates mean we choose none.
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
