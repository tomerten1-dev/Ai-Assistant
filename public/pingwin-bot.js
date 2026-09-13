/* Pingwin Ski Bot — ווידג'ט צ'אט צף, קובץ יחיד, ללא תלויות.
   הטמעה באתר:  <script src="https://<host>/pingwin-bot.js" data-pingwin-bot></script>
   Shadow DOM מלא — לא מתנגש עם ה-CSS של האתר המארח. RTL, mobile-first. */
(function () {
  'use strict';
  if (window.__pingwinBotLoaded) return;
  window.__pingwinBotLoaded = true;

  /* ============== THEME — פלייסהולדרים להחלפה לצבעי פינגווין ============== */
  /* הצבעים והפונט נלקחו מהאתר החי של פינגווין (31/08) — לא עוד placeholder:
     #37455C הוא כחול-הצפחה של המותג, #F0674C הכתום-אלמוג של הכפתורים,
     והפונט הוא Open Sans Hebrew כמו בכל האתר. המבנה (כרטיסים ברוחב מלא,
     פינות 8px, צל עדין, מרווח צפוף) מגיע מסאני — נמדד מה-CSS החי שלה. */
  var THEME = {
    primary: '#37455C',        // כחול הצפחה של פינגווין (מהאתר)
    primaryDark: '#2A3547',
    accent: '#F0674C',         // אלמוג פינגווין — הדגשות בלבד
    ice: '#E9EEF6',            // תכלת עדין: בועת הלקוח ומסגרת שדה הקלט
    grad: 'linear-gradient(135deg,#37455C 0%,#4A5B72 100%)',
    bg: '#ffffff',
    bgAlt: '#F4F6FA',
    text: '#1E2733',
    textLight: '#66717F',
    bubbleUser: '#37455C',
    bubbleUserText: '#ffffff',
    bubbleBot: '#ffffff',
    bubbleBotText: '#1E2733',
    radius: '10px',
    font: "'Open Sans Hebrew','Assistant','Segoe UI',system-ui,sans-serif",
    zIndex: 2147483000,
    position: 'left',          // 'left' | 'right' — פינת הבועה
    whatsapp: '972526543262',  // הכפתור בכותרת: יציאה לאדם מכל מצב (data-whatsapp על התג דורס)
    brand: 'פינגווין',
    privacyUrl: 'https://www.pingwin.co.il/%D7%93%D7%A4%D7%99%D7%9D/%D7%9E%D7%93%D7%99%D7%A0%D7%99%D7%95%D7%AA+%D7%95%D7%A4%D7%A8%D7%98%D7%99%D7%95%D7%AA.html'
  };

  /* ============== api base — נגזר מכתובת הסקריפט עצמו ============== */
  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[data-pingwin-bot]');
    return s[s.length - 1];
  })();
  var API_BASE = (script && script.getAttribute('data-api')) ||
    (script && script.src ? new URL(script.src).origin : '') || '';
  var WHATSAPP = (script && script.getAttribute('data-whatsapp')) || THEME.whatsapp;
  // פינגי — הדמות של פינגווין (תומר אישר את האיור, 26/08). מוגש מאותו שרת
  // כמו הווידג'ט, עם הגרסה בכתובת כדי שהדפדפן יוכל לשמור אותו במטמון.
  var PINGI = API_BASE + '/pingi.png';
  var SEEN_KEY = 'pw_seen';
  // which page the customer is standing on — it decides the opening suggestions
  // and which Pingi greets them from the corner
  var PAGE = (function () {
    // the title too, not just the address: a hotel page on pingwin.co.il is
    // "/Sport+%26+Spa+Hotel+Strass.html?siteID=269" — nothing in the URL says
    // Mayrhofen, but the page's own title does
    var u = (location.pathname + ' ' + location.href + ' ' + (document.title || '')).toLowerCase();
    var h = decodeURIComponent(u);
    if (/בנסקו|bansko|בולגריה|bulgaria/.test(h)) return { country: 'בולגריה' };
    if (/אוסטריה|austria|ischgl|mayrhofen|saalbach|zillertal/.test(h)) return { country: 'אוסטריה' };
    if (/צרפת|france|tignes|arcs|thorens|alpes|avoriaz|flaine/.test(h)) return { country: 'צרפת' };
    if (/אנדורה|andorra|soldeu|grandvalira/.test(h)) return { country: 'אנדורה' };
    if (/קייטנ|בעברית|hebrew/.test(h)) return { camp: true };
    if (/סנובורד|snowboard|freestyle|פארק/.test(h)) return { board: true };
    return {};
  })();
  // Pingi dresses for the room. On a destination page he is already on the
  // slope; on the camps page he is the one building a snowman with the kids;
  // everywhere else he is simply waving. Below ~40px the ski and board poses
  // turn to mush, which is why the tiny avatar beside every message uses the plain
  // one — legibility beats charm at 24 pixels.
  var PINGI_LAUNCH = PAGE.board ? (API_BASE + '/pingi-board.png')
    : PAGE.country ? (API_BASE + '/pingi-ski.png')
      : PAGE.camp ? (API_BASE + '/pingi-wave.png')
        : PINGI;
  // pingi-plain.png נשאר בתיקייה לשימוש עתידי — תומר ביקש (26/08) שגם ליד
  // ההודעות יופיע פינגי עם בגדי החורף, בגודל גדול יותר
  var PINGI_WAVE = API_BASE + '/pingi-wave.png';
  var PINGI_BOARD = API_BASE + '/pingi-board.png';   // on hover, the launcher shows him riding
  var PRIVACY_URL = (script && script.getAttribute('data-privacy')) || THEME.privacyUrl;
  var BOT_NAME = 'פינגי';
  var LAUNCH_T = 'מתלבטים איפה לגלוש?';
  var LAUNCH_S = 'פינגי כאן, ועונה תוך שנייה';

  /* ============== analytics — dataLayer (GTM/GA4) ==============
     Every event carries event:'pw_bot' + action, so one GA4 tag in GTM catches
     them all. Nothing personal is pushed — never a name, phone or free text. */
  // the conversation id the server gave us — every event carries it, so a lead
  // and the chat that produced it can be put side by side
  function cid() { return (state && state.slots && state.slots._cid) || null; }
  // FSI…PDI around a foreign name, so the punctuation around it stays put
  function iso(x) { return '\u2068' + String(x == null ? '' : x) + '\u2069'; }
  function track(action, extra) {
    try {
      var w = window; w.dataLayer = w.dataLayer || [];
      var ev = { event: 'pw_bot', pw_action: action };
      if (extra) for (var k in extra) ev['pw_' + k] = extra[k];
      w.dataLayer.push(ev);
    } catch (e) { }
  }

  /* ============== Cloudflare Turnstile (optional) ==============
     Enabled by the server (/api/config returns a site key). An invisible
     challenge runs once; the token rides on the first chat turn or the lead,
     after which the server stamps the session and no more tokens are needed. */
  // Filled from /api/config: the widget's fixed sentences and the office phone
  // come from the server's guidance.json, not from this file, so changing the
  // number is one edit in one place. The literals below are the floor for the
  // moment before the config lands (or if it never does).
  var CONFIG = { turnstile: null, version: null, phone: '04-8557722', messages: {} };
  function say(key, fallback) {
    var t = (CONFIG.messages && CONFIG.messages[key]) || fallback;
    return String(t).split('{phone}').join(CONFIG.phone || '');
  }
  var configReady = fetchWithTimeout(API_BASE + '/api/config', { method: 'GET' }, 6000)
    .then(function (r) { return r.json(); })
    .then(function (c) {
      if (c) { CONFIG.turnstile = c.turnstile; CONFIG.version = c.version; CONFIG.messages = c.messages || {}; if (c.phone) CONFIG.phone = c.phone; }
      // the launcher rendered before this arrived; swap in Tomer's wording
      try {
        var l1 = fab.querySelector('.l1'), l2 = fab.querySelector('.l2');
        if (l1) l1.textContent = say('launcher_title', LAUNCH_T);
        if (l2) l2.textContent = say('launcher_sub', LAUNCH_S);
        fab.setAttribute('aria-label', say('launcher_title', LAUNCH_T) + ' — ' + say('launcher_sub', LAUNCH_S));
      } catch (e) { }
      if (CONFIG.turnstile) loadTurnstile();
    })
    .catch(function () { });
  var tsLoaded = null, tsHost = null;
  function loadTurnstile() {
    if (tsLoaded) return tsLoaded;
    tsLoaded = new Promise(function (resolve) {
      if (window.turnstile) return resolve();
      // A timeout on the LOAD, not only on the challenge. This promise used to
      // settle from onload/onerror alone, and the 12-second guard below starts
      // only after it resolves — so a host that stalls rather than fails (a
      // corporate proxy, some ad blockers) left it pending forever. The turn
      // never settled: the typing dots span on, the send button stayed
      // disabled, and only a page reload recovered.
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      setTimeout(finish, 8000);
      var t = document.createElement('script');
      t.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      t.async = true; t.onload = finish; t.onerror = finish;
      document.head.appendChild(t);
    });
    return tsLoaded;
  }
  // resolves to a token, or null when Turnstile is off / unavailable
  function turnstileToken() {
    if (!CONFIG.turnstile) return Promise.resolve(null);
    return loadTurnstile().then(function () {
      if (!window.turnstile) return null;
      return new Promise(function (resolve) {
        if (!tsHost) { tsHost = document.createElement('div'); tsHost.style.cssText = 'position:fixed;bottom:0;left:0;width:0;height:0;overflow:hidden'; document.body.appendChild(tsHost); }
        var done = false, timer = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 12000);
        try {
          var id = window.turnstile.render(tsHost, {
            sitekey: CONFIG.turnstile, size: 'invisible',
            callback: function (tok) { if (!done) { done = true; clearTimeout(timer); resolve(tok); } try { window.turnstile.remove(id); } catch (e) { } },
            'error-callback': function () { if (!done) { done = true; clearTimeout(timer); resolve(null); } },
          });
        } catch (e) { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
      });
    });
  }
  function needsToken() { return !!CONFIG.turnstile && !(state.slots && state.slots._vt); }

  // a phone keyboard covers half the screen: never pop it uninvited there
  var IS_TOUCH = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) || ('ontouchstart' in window);
  function focusInput() { if (!IS_TOUCH) input.focus(); }

  /* ============== state ============== */
  var state = {
    open: false,
    messages: [],   // {role:'user'|'assistant', content}
    slots: {},
    busy: false,
    booted: false,
    log: []         // what was rendered, for replay after navigation: {t:'user'|'bot'|'cards'|'chips', v}
  };

  /* ============== host + shadow ============== */
  var host = document.createElement('div');
  host.id = 'pingwin-bot-host';
  var root = host.attachShadow({ mode: 'open' });
  function mount() { (document.body || document.documentElement).appendChild(host); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  /* ============== styles ============== */
  var css = ''
    + ':host{all:initial}'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + '.wrap{position:fixed;bottom:20px;' + THEME.position + ':20px;z-index:' + THEME.zIndex + ';font-family:' + THEME.font + ';direction:rtl}'
    // הכפתור הוא "דלפק קבלה": פינגי, שאלה, ומי עונה עליה (תומר, 26/08).
    // הלקוח לא צריך לנחש מה קורה כשלוחצים.
    + '.fab{display:flex;align-items:center;gap:12px;padding:10px;padding-inline:10px 18px;border:none;cursor:pointer;'
    + 'background:' + THEME.grad + ';color:#fff;border-radius:18px;font-family:inherit;text-align:start;'
    + 'box-shadow:0 10px 24px rgba(28,61,90,.32),0 0 0 4px rgba(28,61,90,.06);transition:transform .18s,box-shadow .18s}'
    + '.fab:hover{transform:translateY(-2px);box-shadow:0 14px 30px rgba(28,61,90,.4),0 0 0 6px rgba(28,61,90,.07)}'
    + '.fab:focus-visible{outline:3px solid ' + THEME.accent + ';outline-offset:3px}'
    // While the chat is open the launcher has nothing left to say, and the
    // expanded window reaches down over the same corner — which is how Pingi
    // ended up floating on top of the message box (תומר, 26/08). The window
    // closes with its own ✕.
    + '.wrap.chatting .fab{opacity:0;transform:translateY(10px) scale(.92);pointer-events:none}'
    + '.fab .av{width:50px;height:50px;border-radius:14px;flex:none;position:relative;background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center}'
    + '.fab .av img{width:44px;height:44px;display:block;object-fit:contain}'
    // נקודה אדומה בלי מספר: "יש כאן משהו". נעלמת ברגע שפותחים, וחוזרת בביקור הבא
    /* 06/09 (Tomer): green, not red — "מחובר", pulsing the same way */
    + '.fab .dot{position:absolute;top:-4px;inset-inline-end:-4px;width:14px;height:14px;border-radius:50%;background:#2fb26a;box-shadow:0 0 0 3px ' + THEME.primary + '}'
    + '.fab .dot::after{content:"";position:absolute;inset:-1px;border-radius:50%;background:#2fb26a;opacity:.5;animation:pwPing 2.4s ease-out infinite}'
    /* hover: Pingi on his board. Two images stacked, the second fades in — no
       flicker, and the board one is preloaded because it is already in the DOM */
    + '.fab .av img.alt{position:absolute;inset:0;margin:auto;opacity:0;transition:opacity .22s ease}'
    + '.fab:hover .av img.alt,.fab:focus-visible .av img.alt{opacity:1}'
    + '.fab:hover .av img.base,.fab:focus-visible .av img.base{opacity:0}'
    + '.fab .av img.base{transition:opacity .22s ease}'
    /* ---- the ride (Tomer, 06/09): on the first open of a visit Pingi rides
       his board from the launcher up to the header portrait, and the window
       unrolls from the bottom behind him. .riding hides the portrait until he
       lands; the rider itself is a fixed <img> moved with the Web Animations
       API (see rideIn), so nothing here needs coordinates. */
    + '.rider{position:fixed;width:54px;height:54px;object-fit:contain;z-index:2147483001;pointer-events:none;'
    + 'filter:drop-shadow(0 6px 10px rgba(16,32,48,.35))}'
    + '.win.riding .hdr .mark img{opacity:0}'
    + '.win.riding .hdr .mark{background:rgba(255,255,255,.55)}'
    + '.hdr .mark.landed img{animation:pwLand .45s cubic-bezier(.34,1.56,.64,1)}'
    + '@keyframes pwLand{0%{transform:scale(.6) translateY(4px)}60%{transform:scale(1.12)}100%{transform:scale(1)}}'
    + '.fab.seen .dot{display:none}'
    + '@keyframes pwPing{0%{transform:scale(1);opacity:.5}70%,100%{transform:scale(2.3);opacity:0}}'
    + '.fab .txt{display:flex;flex-direction:column;align-items:flex-start;line-height:1.3;gap:1px}'
    + '.fab .txt b{font-size:15px;font-weight:700}'
    + '.fab .txt span{font-size:12.5px;opacity:.85}'
    + '.fab .go{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;flex:none}'
    // במובייל הדלפק מתכווץ לעיגול: שורת טקסט בפינת מסך טלפון מסתירה חצי עמוד
    // ובעיגול הקטן הרקע בהיר: פינגי שחור על כחול כהה מאבד את המתאר שלו
    + '@media (max-width:560px){.fab{padding:5px;border-radius:50%;gap:0;background:' + THEME.bg + ';'
    + 'box-shadow:0 8px 20px rgba(28,61,90,.28),0 0 0 3px rgba(28,61,90,.10)}'
    + '.fab .txt,.fab .go{display:none}'
    + '.fab .av{background:transparent;width:54px;height:54px}.fab .av img{width:52px;height:52px}'
    + '.fab .dot{box-shadow:0 0 0 3px ' + THEME.bg + '}}'
    // מי שביקש פחות תנועה מקבל אפס תנועה — לא רק בנקודה האדומה
    + '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.msgs{scroll-behavior:auto!important}}'
    /* 10/09: the launcher hides while the chat is open, so the window no
       longer has to sit above it — it starts 20px from the bottom and gets
       the 72px that used to be air. On a 768px laptop that is 70px more
       conversation, which is half a row card. */
    + '.win{position:fixed;bottom:20px;' + THEME.position + ':20px;width:min(460px,calc(100vw - 24px));height:min(760px,calc(100vh - 40px));height:min(760px,calc(100dvh - 40px));'
    + 'background:' + THEME.bg + ';border-radius:18px;box-shadow:0 24px 64px rgba(16,32,48,.26),0 2px 8px rgba(16,32,48,.08);border:1px solid #e3e9ef;display:none;flex-direction:column;overflow:hidden;'
    + 'transition:width .25s ease,height .25s ease}'
    + '.win.open{display:flex}'
    // מצב מורחב — נפתח בהקלדה וכשמוצגות הצעות: רחב מספיק לשלושה כרטיסים בשורה
    // Tomer, 06/09 (screenshot): the full width already for TWO offers — each
    // card gets real room and a real photograph; the third simply joins the row
    + '.win.big{width:min(1100px,calc(100vw - 32px));height:calc(100vh - 40px);height:calc(100dvh - 40px)}'
    + '.win.big.wide{width:min(1100px,calc(100vw - 32px))}'
    + '.win.max{width:calc(100vw - 32px);height:calc(100vh - 32px);height:calc(100dvh - 32px);bottom:16px;' + THEME.position + ':16px}'
    + '.win.max .msgs{padding:20px 24px}'
    // on a phone the window is the screen, whatever .big/.max say — those two
    // used to win on specificity and leave a lopsided box with a 32px gap
    + '@media (max-width:480px){.win,.win.big,.win.max{bottom:0;' + THEME.position + ':0;width:100vw;height:100vh;height:100dvh;border-radius:0;margin:0}'
    + '.hdr .sub{display:none}.hdr .ttl{font-size:14px;white-space:nowrap}.hdr .ttl .long{display:none}.hdr .wa span{display:none}.hdr .wa{padding:7px}}'
    // כותרת שקטה על רקע בהיר — פחות "באנר", יותר ממשק
    /* הכותרת בפרופורציות של סאני: סימן זהות גדול (44px), שם 17/700 בצבע
       המותג ותפקיד 12px מתחתיו — ולא באנר צבעוני. */
    /* 06/09 — closer to Sunny: a soft blue band, a round portrait with a
       white ring, the name large and the role under it. */
    + '.hdr{background:linear-gradient(180deg,#DCE9F6 0%,#EEF4FA 100%);color:' + THEME.text + ';padding:12px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #D9E4F0}'
    + '.hdr .mark{width:50px;height:50px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px #fff,0 2px 8px rgba(30,60,90,.18);display:flex;align-items:center;justify-content:center;flex:none;position:relative}'
    + '.hdr .mark img{width:42px;height:42px;display:block;object-fit:contain}'
    + '.hdr .mark::after{content:"";position:absolute;inset-inline-end:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;background:#2fb26a;border:2px solid ' + THEME.bg + '}'
    + '.hdr .ttl{font-weight:800;font-size:19px;letter-spacing:0;color:' + THEME.primaryDark + ';line-height:1.2}'
    + '.hdr .ttl .long{font-weight:500;font-size:13px;color:' + THEME.textLight + '}'
    + '.hdr .sub{font-size:12.5px;color:' + THEME.textLight + ';line-height:1.35}'
    + '.form .consent{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:' + THEME.textLight + ';margin:10px 0 4px;line-height:1.4;cursor:pointer}'
    + '.form .consent input{margin-top:3px;flex:none;width:16px;height:16px;accent-color:' + THEME.primaryDark + '}'
    + '.form .consent a{color:' + THEME.primaryDark + ';text-decoration:underline}'
    + '.hdr .wa{margin-inline-start:auto;display:inline-flex;align-items:center;gap:6px;background:#e7f6ec;color:#1b6b3a;border:1px solid #cfe9d8;border-radius:999px;padding:5px 11px;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}'
    + '.hdr .wa:hover{background:#d9f0e1}'
    + '.hdr .wa:focus-visible{outline:2px solid ' + THEME.accent + ';outline-offset:2px}'
    + '.hdr .wa + .exp{margin-inline-start:0}'
    + '.hdr .exp + .x{margin-inline-start:0}'
    + '.hdr .exp{margin-inline-start:auto;font-size:16px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:10px}'
    + '.hdr .exp + .x{margin-inline-start:0}'
    + '.hdr .x{margin-inline-start:auto;background:none;border:none;color:' + THEME.textLight + ';font-size:19px;cursor:pointer;'
    + 'min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:10px;line-height:1}'
    + '.hdr .x:focus-visible,.hdr .exp:focus-visible,.send:focus-visible,.chip:focus-visible,.btn:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:2px}'
    + '.hdr .x:hover{background:' + THEME.bgAlt + ';color:' + THEME.text + '}'
    // אזור השיחה בסגנון עוזר AI: תשובות הבוט כטקסט זורם עם סימן זהות,
    // הודעות הלקוח כבועה עדינה — במקום שתי בועות צבעוניות זו מול זו
    + '.msgs{position:relative;flex:1;overflow-y:auto;overflow-x:hidden;padding:8px 12px 12px;background:' + THEME.bg + ';display:flex;flex-direction:column;gap:6px;scroll-behavior:smooth}'
    /* 06/09 (Tomer: "צריך לגלול הרבה"): the time under every message cost a
       line each. Now a small centred time appears only when the conversation
       paused for half an hour or moved to another day — like a phone chat. */
    + '.tdiv{align-self:center;font-size:11px;color:' + THEME.textLight + ';background:' + THEME.bgAlt + ';border-radius:99px;padding:2px 10px;margin:2px 0;font-variant-numeric:tabular-nums}'
    /* back to the latest message, when the customer scrolled up to reread */
    + '.jump{position:sticky;bottom:6px;align-self:center;background:' + THEME.primaryDark + ';color:#fff;border:none;border-radius:99px;'
    + 'padding:6px 14px;font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(28,45,70,.3);display:none;z-index:2;order:9999}'
    + '.jump.on{display:inline-flex;align-items:center;gap:6px}'
    /* התיקון לטקסט שנערם (תומר, 31/08): ‎.msgs היא עמודת flex עם גלילה, וילדי
       flex מתכווצים כברירת מחדל לפני שהגלילה נכנסת. ברגע שהשיחה ארוכה מהחלון
       הדפדפן כיווץ את בועות הבוט — min-height:36px התיר לרדת מתחת לגובה
       הטקסט — והטקסט נצבע מעבר לקופסה, על ההודעות והצ'יפים שאחריה. לכן זה
       הופיע רק בשיחות ארוכות/משוחזרות ולא בבדיקות שמדדו קופסאות. אף הודעה
       לא מתכווצת — הגלילה היא שסופגת את האורך. */
    + '.msgs>*{flex-shrink:0}'
    // the default Windows scrollbar is a slab down the side of a small window
    + '.msgs::-webkit-scrollbar{width:8px}'
    + '.msgs::-webkit-scrollbar-thumb{background:#d3dae1;border-radius:99px;border:2px solid ' + THEME.bg + '}'
    + '.msgs::-webkit-scrollbar-thumb:hover{background:#b9c4ce}'
    + '.msgs::-webkit-scrollbar-track{background:transparent}'
    /* ---- שפת ההודעות, בעקבות סאני (נמדד מה-CSS החי שלה, 31/08) ----
       שני הצדדים הם אותו כרטיס: רוחב מלא, פינות 8px, ריפוד 14px וצל אחד
       עדין; רק צבע הרקע מבדיל ביניהם. זה מה שנותן לסאני את התחושה הרגועה —
       אין פינג-פונג של בועות מימין ומשמאל, והטקסט מקבל את כל רוחב החלון.
       מה שנשאר שלנו: הפינגווין, שמופיע פעם אחת לכל רצף של פינגי במקום על
       כל הודעה — כך המיתוג נשמר בלי החזרתיות שהעמיסה את המסך. */
    + '.m{font-size:14px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;align-self:stretch;'
    + 'border-radius:12px;padding:9px 12px;box-shadow:0 1px 3px rgba(30,39,51,.06)}'
    + '.m.user{background:#E4EEF8;color:' + THEME.text + ';border:1px solid #D6E3F1}'
    + '.m.bot{background:#F3F6FA;color:' + THEME.text + ';border:1px solid #EBF0F5;position:relative;'
    + 'padding-inline-start:15px}'
    /* הפינגווין רק בראש רצף — .m.bot.lead */
    + '.m.bot.lead{padding-inline-start:46px;min-height:42px}'
    + '.m.bot.lead::before{content:"";position:absolute;inset-inline-start:9px;top:7px;width:28px;height:28px;border-radius:9px;'
    + 'background:' + THEME.ice + ' url(' + PINGI + ') center/28px 28px no-repeat}'
    + '.typing{align-self:stretch;background:#F3F6FA;border:1px solid #EBF0F5;border-radius:12px;'
    + 'box-shadow:0 2px 6px 1px rgba(30,39,51,.05);padding:13px 15px;padding-inline-start:52px;min-height:46px;'
    + 'display:flex;gap:5px;align-items:center;position:relative}'
    + '.typing::before{content:"";position:absolute;inset-inline-start:11px;top:11px;width:30px;height:30px;border-radius:9px;'
    + 'background:' + THEME.ice + ' url(' + PINGI + ') center/28px 28px no-repeat}'
    + '.typing i{width:6px;height:6px;border-radius:50%;background:' + THEME.textLight + ';animation:pb 1s infinite}'
    + '.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}'
    + '@keyframes pb{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'
    // שורת הצעות: שלושה כרטיסים זה לצד זה, יורדים לטור רק כשאין רוחב
    + '.cards-row{align-self:stretch;display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-start}'
    /* a card is never wider than half the full window: one offer alone
       used to stretch across the whole screen (Tomer, 06/09, screenshot) */
    + '.cards-row .card{flex:1 1 250px;min-width:0;max-width:min(100%,540px)}'
    + '.cards-row .card.r{flex:1 1 100%;max-width:100%}'
    // one tap for the third offer — no round trip, the card is already here
    + '.more-opt{align-self:stretch;background:' + THEME.bg + ';border:1.5px dashed #C9D3E2;color:' + THEME.primaryDark + ';'
    + 'border-radius:10px;padding:11px 14px;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer;margin-top:-2px;transition:background .15s,border-color .15s}'
    + '.more-opt:hover{background:' + THEME.bgAlt + ';border-color:' + THEME.primary + '}'
    + '.more-opt:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:2px}'
    + '.card{align-self:stretch;background:' + THEME.bg + ';border:1px solid #E7ECF3;border-radius:8px;padding:10px 12px 10px;display:flex;flex-direction:column;gap:4px;box-shadow:0 2px 6px 1px rgba(30,39,51,.05);'
    + 'box-shadow:0 1px 2px rgba(16,32,48,.05);transition:box-shadow .18s,transform .18s,border-color .18s}'
    + '.card:hover{box-shadow:0 8px 22px rgba(30,39,51,.11);transform:translateY(-2px);border-color:#C9D3E2}'
    /* ---- variant: the photo IS the card (?pwcard=photo) ----
       Closed, the hotel's own photograph fills the card and the text sits on a
       scrim over it. Opened, it hands back to the ordinary white card: the
       details are a lot of small text, and small text on a photograph is where
       this idea stops being worth it. Every colour below is scoped to the
       CLOSED card — white text stayed white on the opened white card, and
       "מתאים ל-4 נוסעים" went invisible. */
    + '.card.pbg{position:relative;background-size:cover;background-position:center;overflow:hidden}'
    /* the bottom strip belongs to the controls: "פרטים" at the start, the photo
       arrows at the end. Reserved, because a card with one line less of text
       put the arrows straight on top of "המשך להזמנה". */
    + '.card.pbg:not(.open){border-color:transparent;min-height:214px;justify-content:flex-end;'
    + 'color:#fff;padding-bottom:48px}'
    + '.card.pbg:not(.open) .dtog{position:absolute;bottom:15px;inset-inline-start:14px;margin:0;z-index:3}'
    + '.card.pbg:not(.open)::before{content:"";position:absolute;inset:0;pointer-events:none;'
    /* A ski photograph is mostly snow and sky, so the contrast is the scrim's
       job, not the picture's — and once the scrim really carries it, the type
       needs no outline. Outlined white text is what made this look homemade. */
    + 'background:linear-gradient(to top,rgba(6,14,26,.95) 0%,rgba(6,14,26,.90) 30%,'
    + 'rgba(6,14,26,.62) 52%,rgba(6,14,26,.24) 72%,rgba(6,14,26,.10) 86%,rgba(6,14,26,.30) 100%)}'
    + '.card.pbg:not(.open) > *{position:relative;z-index:1}'
    /* the hotel's other photographs, over the whole card instead of inside a
       strip at the top of it */
    + '.card.pbg:not(.open) .gal{position:absolute;inset:0;margin:0;width:auto;'
    + 'border-radius:16px;overflow:hidden;pointer-events:none;z-index:2;background:none}'
    + '.card.pbg:not(.open) .gal > *{pointer-events:auto}'
    + '.card.pbg:not(.open) .gal .photo{display:none}'
    + '.card.pbg:not(.open) .gal::after{display:none}'
    /* Where the photo controls go, on a card that is all photo and all text.
       Centred, they sat on the room name; at the top, on the hotel name. The
       one corner with nothing in it is the bottom end — "פרטים" is at the
       bottom start — so they cluster there as ‹ 3/12 ›. */
    /* Glass, not white bubbles: at this size a solid white circle is the single
       most toy-like thing on the card. */
    + '.card.pbg:not(.open) .galb{opacity:1;top:auto;bottom:10px;transform:none;width:29px;height:29px;'
    + 'background:rgba(10,20,34,.42);color:rgba(255,255,255,.92);border:1px solid rgba(255,255,255,.28);'
    + 'box-shadow:none;backdrop-filter:blur(6px)}'
    + '.card.pbg:not(.open) .galb:hover{background:rgba(10,20,34,.72);border-color:rgba(255,255,255,.5)}'
    + '.card.pbg:not(.open) .galb.next{inset-inline-end:12px;inset-inline-start:auto}'
    + '.card.pbg:not(.open) .galb.prev{inset-inline-end:82px;inset-inline-start:auto}'
    /* .card:not(.open) .galn is hidden on the plain card — here it is the only
       thing telling you there are more photographs */
    + '.card.pbg:not(.open) .gal .galn{opacity:1;bottom:18px;top:auto;inset-inline-end:45px;inset-inline-start:auto;'
    + 'transform:none;background:none;padding:0;font-size:11px;font-weight:500;letter-spacing:.06em;'
    + 'color:rgba(255,255,255,.7);font-variant-numeric:tabular-nums;text-shadow:0 1px 3px rgba(6,14,26,.7)}'
    /* One shadow, soft and short — enough to lift the type off a busy picture,
       not enough to be seen as an effect. */
    + '.card.pbg:not(.open) .chead,.card.pbg:not(.open) .brief,.card.pbg:not(.open) .why'
    + '{text-shadow:0 1px 3px rgba(6,14,26,.55)}'
    /* the place first and small, then the name — the order a hotel's own
       material uses, and the one that reads as a masthead and not a label */
    /* the text starts under the badge row: the site's full hotel name (13/09) is
       long enough to reach the corner the badges sit in */
    + '.card.pbg:not(.open) .chead{flex-direction:column;align-items:flex-start;gap:1px;margin-top:30px}'
    /* only the place line makes room for the badge — the hotel name gets the
       full width, or a long one wraps and the card grows for nothing */
    + '.card.pbg:not(.open) .cwhere{order:-1;font-size:11px;font-weight:600;letter-spacing:.09em;'
    + 'text-transform:uppercase;color:rgba(255,255,255,.66);padding-inline-end:58px;line-height:1.35}'
    /* the site's full name can wrap; the first line must not run under the badges */
    + '.card.pbg:not(.open) .hname{font-size:19px;font-weight:600;line-height:1.18;'
    + 'letter-spacing:-.012em;color:#fff}'
    /* a short rule between the name and the facts — the oldest way to say
       "the heading ends here" without adding another weight or colour */
    /* A short rule, not a divider across the card. The pseudo has to be a
       full-width flex row to break the line at all, so the length comes from
       the gradient instead of from its width. */
    + '.card.pbg:not(.open) .brief::before{content:"";flex-basis:100%;height:1px;margin:7px 0 2px;'
    + 'background:linear-gradient(to left,rgba(255,255,255,.34) 0 26px,transparent 26px)}'
    + '.card.pbg:not(.open) .brief{font-size:12.5px;gap:3px 7px;color:rgba(255,255,255,.9)}'
    + '.card.pbg:not(.open) .brief b{font-weight:600;color:#fff}'
    + '.card.pbg:not(.open) .brief .sep{color:rgba(255,255,255,.34)}'
    /* the price band is information, not an accent — one weight up, no colour.
       .card .brief .bprice outranks .card.pbg .bprice, hence the longer
       selector; it stayed navy on the photograph before this. */
    /* the price band leaves the sentence: on a phone it wrapped onto a line of
       its own and sat there orphaned. Same glass as the photo controls. */
    /* exactly one of each pair is ever visible */
    + '.topbar{display:none}'
    + '.card.pbg:not(.open) .brief .bprice,.card.pbg:not(.open) .brief .bsep{display:none}'
    + '.card.pbg:not(.open) .gal .tier{display:none}'
    /* the top END corner, the only one with nothing in it — the resort and the
       hotel name both start at the top start. No direction:ltr here: the
       property resolves against the ELEMENT's own direction, so setting it
       moved the whole cluster to the other corner, on top of the resort. */
    + '.card.pbg:not(.open) > .topbar{display:flex;gap:6px;align-items:center;'
    + 'position:absolute;top:12px;inset-inline-end:12px;z-index:3}'
    + '.card.pbg:not(.open) .topbar .bprice{font-size:11px;font-weight:600;letter-spacing:.08em;color:#fff;'
    + 'padding:3px 9px;border-radius:999px;background:rgba(10,20,34,.42);'
    + 'border:1px solid rgba(255,255,255,.26);backdrop-filter:blur(6px);text-shadow:none}'
    + '.card.pbg:not(.open) .topbar .tier{position:static;font-size:11px;font-weight:600;letter-spacing:.04em;'
    + 'padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.9);color:' + THEME.primaryDark + ';'
    + 'border:1px solid rgba(255,255,255,.35);text-transform:none;box-shadow:none;white-space:nowrap}'
    + '.card.pbg:not(.open) .dtog{color:rgba(255,255,255,.78);font-size:12px;font-weight:500;letter-spacing:.03em}'
    + '.card.pbg:not(.open) .dtog:hover{color:#fff;text-decoration:none}'
    /* no panel around the reason: a translucent box over a picture reads as an
       empty grey bar, and the scrim already carries the text */
    + '.card.pbg:not(.open) .why{background:none;color:rgba(255,255,255,.62);padding:2px 0;font-size:12px;line-height:1.45}'
    + '.card.pbg:not(.open) .tag{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.24);'
    + 'font-size:11px;font-weight:600;letter-spacing:.05em;padding:3px 8px}'
    + '.card.pbg:not(.open) .tag.rec{background:rgba(255,255,255,.92);color:' + THEME.primaryDark + '}'
    /* the buttons carry their own contrast — they must never depend on the
       photograph behind them. One filled, one outlined; a 1px border, not 1.5. */
    + '.card.pbg:not(.open) .btn{font-weight:600;letter-spacing:.01em}'
    + '.card.pbg:not(.open) .btn.sec{background:rgba(10,20,34,.34);color:#fff;'
    + 'border:1px solid rgba(255,255,255,.46);backdrop-filter:blur(6px)}'
    + '.card.pbg:not(.open) .btn.sec:hover{background:rgba(10,20,34,.6);border-color:rgba(255,255,255,.75)}'
    + '.card.pbg:not(.open) .btn.pri{box-shadow:0 2px 12px rgba(6,14,26,.45)}'
    + '.card.pbg:hover{box-shadow:0 14px 30px rgba(9,20,35,.28)}'
    + '.card.pbg.open{background-image:none!important;border-color:#e1e8ef}'
    // gallery: the photo fills the top of the card, arrows sit on it
    + '.card .gal{position:relative;width:calc(100% + 24px);margin:-10px -12px 6px;border-radius:8px 8px 0 0;overflow:hidden;background:#e8edf1}'
    + '.card .gal::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 55%,rgba(16,32,48,.35) 100%);pointer-events:none}'
    + '.card .gal .galb,.card .gal .galn,.card .gal .tier{z-index:1}'
    // 112px: three cards with their date, room, price and both buttons fit a
    // laptop screen without scrolling — the photo is the first thing to give
    /* the photograph, not a sliver of it: a 16:9 window that scales with the
       card (Tomer, 06/09: "שיראו את התמונות כמו שצריך ולא רבע מהן") */
    + '.card .photo{width:100%;height:auto;aspect-ratio:16/9;max-height:clamp(100px,24vh,210px);object-fit:cover;display:block;transition:height .18s ease}'
    /* on a short screen the photo gives way, so the name, the date and the
       buttons stay above the fold (Tomer, 06/09: "looks messy") */
    + '@media (max-height:640px){.card .photo{max-height:110px}}'
    + '.card.open .photo{aspect-ratio:16/9}'
    + '.card .gal .tier{position:absolute;top:8px;inset-inline-start:8px;box-shadow:0 1px 4px rgba(0,0,0,.25)}'
    // everything that is nice to know but not needed to choose lives behind one toggle
    + '.card .details{display:none;flex-direction:column;gap:6px}'
    + '.card.open .details{display:flex;gap:5px}'
    // Closed, a card shows only what helps to CHOOSE between three of them:
    // the hotel, where it is, one line of when/what, and the button. Everything
    // else is one click away. Three cards used to be 807px — two mobile screens
    // for a single answer (Tomer, 26/08).
    + '.card .brief{font-size:13px;color:' + THEME.text + ';display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline}'
    + '.card .brief b{font-weight:600}'
    + '.card .brief .bprice{color:' + THEME.primaryDark + ';font-weight:600}'
    + '.card:not(.open) .cfoot{display:none}'
    + '.card .chead{row-gap:0}'
    + '.card .brief .sep{color:#c3ccd6}'
    + '.card.open .brief{display:none}'
    + '.card:not(.open) .rows,.card:not(.open) .rpanel,.card:not(.open) .facts{display:none}'
    + '.card .gal .galb,.card:not(.open) .gal .galn{opacity:0}'
    + '.card.open .gal .galb{opacity:.9}'
    + '.card:not(.open) .tags .tag:not(.tier):not(.rec):not(.left){display:none}'
    /* 06/09 (Tomer): a small link at the card's edge was easy to miss and hard
       to hit — now a full-width row, 40px tall, with a rule above it */
    + '.card .dtog{align-self:stretch;text-align:center;background:none;border:none;border-top:1px solid #EEF2F6;'
    + 'margin:6px -12px -10px;padding:9px 12px;min-height:40px;border-radius:0 0 8px 8px;font-family:inherit;font-size:13.5px;'
    + 'color:' + THEME.primaryDark + ';cursor:pointer;font-weight:600;order:8;transition:background .15s}'
    + '.card .dtog:hover{background:#F3F6FA;text-decoration:none}'
    + '.card .dtog:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:-3px}'
    + '.card .details{order:9}.card .facts{order:7}.card .acts,.card .cta{order:10}'
    /* the "עוד/פחות פרטים" row is the card's last row in both states; open,
       the buttons move under the details (they overlapped, Tomer 06/09) */
    + '.card .dtog{order:20}.card.open .btns,.card.j.open .btns{order:12}.card.open .cfoot{order:11}'

    + '.card .galb{position:absolute;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;'
    + 'border:none;background:rgba(255,255,255,.92);color:' + THEME.text + ';line-height:0;cursor:pointer;padding:0;'
    + 'display:flex;align-items:center;justify-content:center;box-shadow:0 1px 5px rgba(16,32,48,.25);opacity:0;transition:opacity .15s}'
    + '.card:hover .galb,.card:focus-within .galb{opacity:1}'
    // always reachable on a touch screen, where there is no hover
    + '@media (hover:none){.card .galb{opacity:1}}'
    + '.card .galb:hover{background:#fff}'
    + '.card .galb.prev{inset-inline-start:8px}'
    + '.card .galb.next{inset-inline-end:8px}'
    + '.card .galn{position:absolute;bottom:8px;inset-inline-end:10px;background:rgba(16,32,48,.62);color:#fff;'
    + 'font-size:11.5px;padding:2px 8px;border-radius:99px;letter-spacing:.4px}'

    // name and country on one line, so the eye finds the hotel first
    + '.card .chead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}'
    + '.card .cwhere{font-size:13px;color:' + THEME.textLight + '}'

    // labelled rows: label in grey, value in ink — readable at a glance
    + '.card .rows{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid #edf1f5;border-bottom:1px solid #edf1f5}'
    + '.card .row{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}'
    + '.card .rlab{font-size:12.5px;color:' + THEME.textLight + ';flex:none}'
    + '.card .rval{font-size:13.5px;color:' + THEME.text + ';font-weight:600}'
    + '.card .rlink{font-size:13.5px;color:' + THEME.primaryDark + ';font-weight:600;background:none;border:none;'
    + 'padding:0;cursor:pointer;font-family:inherit;text-align:start;text-decoration:underline;text-underline-offset:3px}'
    + '.card .rlink:hover{color:' + THEME.primary + '}'
    + '.card .rpanel{display:flex;flex-direction:column;gap:4px;background:' + THEME.bgAlt + ';border-radius:8px;padding:9px 11px;margin-top:2px}'
    + '.card .rline{display:flex;gap:7px;align-items:baseline}'
    + '.card .rline .rval{font-weight:500;font-size:13px}'
    + '.card .rnote{font-size:12px;color:' + THEME.textLight + ';padding-top:2px}'

    + '.card .inc{background:#f2f6f9;border:1px solid #e0e9f0;border-radius:9px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}'
    + '.card .ilab{font-size:12px;font-weight:700;color:' + THEME.primaryDark + ';letter-spacing:.2px}'
    + '.card .itxt{font-size:13px;color:' + THEME.text + ';line-height:1.55}'
    + '.card .clamp3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}'
    + '.card .imore{align-self:flex-start;background:none;border:none;padding:0;font-family:inherit;font-size:12.5px;'
    + 'color:' + THEME.primary + ';cursor:pointer;text-decoration:underline;text-underline-offset:3px}'
    + '.card .cdesc{font-size:13.5px;color:' + THEME.text + ';line-height:1.55}'
    + '.card .cfoot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:2px}'
    + '.card .fits{font-size:13px;color:' + THEME.textLight + '}'
    + '.card .clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
    + '.card .hname{font-weight:700;font-size:15px;color:' + THEME.text + ';line-height:1.25;letter-spacing:-.2px}'
    + '.card .meta{font-size:13px;color:' + THEME.textLight + ';line-height:1.5}'
    + '.card .hrating{font-size:12.5px;color:' + THEME.textLight + ';line-height:1.4;margin-top:1px}'
    + '.card .facts{display:flex;flex-direction:column;gap:3px;border-inline-start:2px solid ' + THEME.primary + ';padding-inline-start:8px}'
    + '.card .facts div{font-size:13px;color:' + THEME.text + ';line-height:1.5}'
    + '.m.bot.wave{padding-inline-start:66px;min-height:58px}'
    + '.m.bot.wave::before{width:46px;height:46px;border-radius:12px;top:9px;inset-inline-start:10px;'
    + 'background:' + THEME.ice + ' url(' + PINGI_WAVE + ') center/42px 42px no-repeat}'
    /* השעה יושבת בפינת הכרטיס, לא על שורה משלה: בכרטיס ברוחב מלא שורה
       נפרדת השאירה את השעה תלויה באוויר בצד שמאל. (סאני לא מציגה שעות
       בכלל; אצלנו הן נשארות — שיחה שנמשכת למחרת בלי שעות נקראת כמקשה אחת,
       תומר 26/08 — רק דיסקרטיות יותר.) */
    + '.ts{position:absolute;bottom:7px;inset-inline-start:13px;font-size:10px;line-height:1;'
    + 'color:' + THEME.textLight + ';opacity:.6;font-variant-numeric:tabular-nums;direction:ltr}'
    + '.m{position:relative;padding-bottom:10px}'
    + '.ts{display:none}'
    + '.m.bot.after{padding-bottom:0}'
    /* 31/08: הבועה של הלקוח בהירה מזמן — שעה לבנה עליה הייתה בלתי נראית */
    + '.m.user .ts{color:inherit;opacity:.55}'
    /* פס תחתון: מס\' שיחה ו"שיחה חדשה" — בדיוק איפה שסאני שמה אותם */
    + '.foot{display:flex;align-items:center;justify-content:space-between;gap:10px;'
    + 'padding:0 18px 6px;background:' + THEME.bg + ';font-size:11.5px;line-height:1.3;color:' + THEME.textLight + '}'
    + '.foot .fcid{font-variant-numeric:tabular-nums;letter-spacing:.2px}'
    + '.foot .fnew{background:none;border:none;padding:1px 0;font:inherit;font-size:12.5px;font-weight:600;'
    + 'color:' + THEME.primary + ';text-decoration:underline;cursor:pointer}'
    + '.foot .fnew:hover{color:' + THEME.accent + '}'
    + '.foot .fnew:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:2px;border-radius:4px}'
    + '.m.after .ts,.m.wave .ts{display:none}'
    /* שורת הסיום ("אם אחת מהן נראית לכם…") היא הערה, לא הודעה: בלי כרטיס */
    + '.m.bot.after{font-size:12.5px;line-height:1.4;color:' + THEME.textLight + ';margin-top:-3px;background:transparent;'
    + 'border:none;box-shadow:none;padding:0 4px}'
    + '.m.bot.after::before{display:none}'
    /* a long reply shows its first lines and folds the rest behind "עוד" —
       above the offers three lines, elsewhere six (Tomer, 10/09) */
    + '.m .mtxt{display:block}'
    + '.m.fold .mtxt{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;-webkit-line-clamp:6}'
    + '.m.fold.tight .mtxt{-webkit-line-clamp:3}'
    + '.m .mmore{display:none;background:none;border:none;padding:2px 0 0;font-family:inherit;font-size:12.5px;font-weight:600;'
    + 'color:' + THEME.primaryDark + ';cursor:pointer;text-decoration:underline;text-underline-offset:3px}'
    + '.m.folded .mmore{display:inline-block}'
    // גילוי נאות: הערת שוליים, לא הודעה של פינגי — ולכן בלי הפרצוף שלו,
    // ובלי המחלקה .m, שסופרת הודעות בשיחה
    + '.fine{align-self:stretch;max-width:min(100%,640px);font-size:12px;line-height:1.55;'
    + 'color:' + THEME.textLight + ';margin-top:-6px;padding-inline-start:46px}'
    + '.fine a{color:' + THEME.primary + ';text-decoration:underline}'
    // שורת שקיפות בסגנון סאני (30/08): "חיפשתי במלאי לפי: ..." — סטטוס שקט מעל ההצעות
    + '.status{align-self:stretch;padding-inline-start:46px;font-size:12px;color:' + THEME.textLight + ';font-style:italic;line-height:1.45}'
    // חיווי המתנה מדבר — הטקסט שמצטרף לנקודות אחרי שנייה וחצי
    + '.typing .tlab{font-size:12.5px;color:' + THEME.textLight + ';margin-inline-start:4px}'
    // פידבק על תשובה — אגודל למעלה/למטה, מתחת לתשובה האחרונה בלבד
    + '.fb{align-self:stretch;display:flex;gap:2px;padding-inline-start:6px;align-items:center;margin-top:-6px;min-height:22px}'
    + '.fb button{background:none;border:none;cursor:pointer;font-size:14px;padding:3px 6px;border-radius:6px;opacity:.55;transition:opacity .15s,background .15s;font-family:inherit}'
    + '.fb button:hover{opacity:1;background:' + THEME.bgAlt + '}'
    + '.fb button.on{opacity:1;background:' + THEME.bgAlt + '}'
    + '.fb .fbnote{font-size:11.5px;color:' + THEME.textLight + '}'
    + '.card .why{font-size:13px;color:' + THEME.text + ';background:' + THEME.bgAlt + ';border-radius:8px;padding:8px 10px;line-height:1.5}'
    + '.card .tags{display:flex;gap:6px;flex-wrap:wrap}'
    + '.tag{font-size:12px;padding:4px 10px;border-radius:6px;background:#e9eef2;color:#33475b;border:1px solid #d5dde4}'
    + '.tag.warn{background:#f7f1e3;color:#7a5c1e;border:1px solid #e5d9bd}'
    + '.tag.rec{background:#e8eef4;color:' + THEME.primaryDark + ';border:1px solid #cfdae4}'
    /* the chain's sales point (Tomer, 13/09): Belambra = all-inclusive club,
       Club du Soleil = full board + wine + equipment. Coral, and never hidden
       on a closed card — it is what explains the price. */
    + '.tag.hl{background:' + THEME.accent + ';color:#fff;border:1px solid ' + THEME.accent + ';font-weight:700}'
    + '.card:not(.open) .tags .tag.hl{display:inline-block}'
    + '.card.r .rmeta .tag.hl{font-size:11px;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}'
    + '.side .shl{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 11px;border-radius:8px;'
    + 'background:#fff3ef;border:1px solid #f7c6bb;color:' + THEME.text + ';font-size:13px;line-height:1.4}'
    + '.side .shl .tag.hl{flex:none}'
    + '.tag.tier{background:' + THEME.primaryDark + ';color:#fff;border:1px solid ' + THEME.primaryDark + ';font-weight:600}'
    + '.tag.left{background:#fbeeea;color:#8a3b2a;border:1px solid #efcfc6}'
    + '.card .price{font-size:13.5px;font-weight:700;color:' + THEME.primaryDark + ';letter-spacing:.3px;background:' + THEME.ice + ';border-radius:8px;padding:4px 10px}'
    + '.card .btns{display:flex;gap:7px;margin-top:auto;padding-top:8px;flex-wrap:wrap}'
    /* ---- option י: band + tiles (white card) ---- */
    + '.card.j{padding-top:0}'
    + '.card.j .gal{margin-top:0;border-radius:8px 8px 0 0}'
    + '.card.j .band{display:flex;justify-content:space-between;align-items:center;gap:10px;'
    + 'background:' + THEME.grad + ';color:#fff;margin:0 -12px 8px;padding:9px 14px}'
    + '.card.j .band .bname{font-weight:700;font-size:16px;line-height:1.25;color:#fff}'
    + '.card.j .band .bwhere{font-size:12.5px;color:rgba(255,255,255,.82);line-height:1.3}'
    + '.card.j .band .bscore{flex:none;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.22);border-radius:99px;'
    + 'padding:3px 10px;font-size:12.5px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}'
    + '.card.j .facts4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}'
    + '.card.j .btns{order:6}'
    + '.card.j .ft{background:' + THEME.bgAlt + ';border-radius:8px;padding:6px 4px;text-align:center;min-width:0}'
    + '.card.j .ft .fk{font-size:11px;color:' + THEME.textLight + ';letter-spacing:.02em}'
    + '.card.j .ft .fv{font-weight:700;font-size:13px;margin-top:1px;line-height:1.2;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}'
    + '.card.j .chead,.card.j .brief,.card.j .hrating{display:none}'
    + '.card.j.open .facts4{display:none}'

    /* outranks the generic "hide the other tags on a closed card" rule */
    + '.cards-row .card.j:not(.open) .tags .tag.amen,.cards-row .card.j:not(.open) .tags .tag.rec,.cards-row .card.j:not(.open) .tags .tag.left{display:inline-block}'
    + '.card.j:not(.open) .tags .tag.tier{display:none}'
    /* the closed card shows at most four tags */
    + '.card.j:not(.open) .tags .tag:nth-child(n+5){display:none}'
    /* ---- the row card (default since 10/09) ---- */
    + '.card.r{padding:9px 10px;gap:0}'
    + '.card.r .rhead{display:flex;gap:10px;align-items:stretch;order:1}'
    + '.card.r .thumb{width:96px;height:78px;border-radius:7px;object-fit:cover;flex:none;background:#e8edf1}'
    + '.card.r .rmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;justify-content:center}'
    + '.card.r .rtop{display:flex;align-items:center;gap:8px;min-width:0}'
    + '.card.r .rtop .hname{font-size:14.5px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;unicode-bidi:plaintext;text-align:end}'
    + '.card.r .rtop .bscore{flex:none;font-size:11.5px;font-weight:600;color:' + THEME.primaryDark + ';background:' + THEME.ice + ';border-radius:99px;padding:1px 7px;font-variant-numeric:tabular-nums}'
    + '.card.r .rwhere{font-size:12px;color:' + THEME.textLight + ';line-height:1.3}'
    /* wraps rather than clips: a long room name goes to a second line whole */
    + '.card.r .rline{font-size:13px;color:' + THEME.text + ';line-height:1.35;margin-top:2px;display:flex;flex-wrap:wrap;align-items:baseline;gap:0 5px}'
    + '.card.r .rline b{font-weight:600}.card.r .rline .sep{color:#c3ccd6}'
    + '@media (max-width:480px){.card.r .thumb{width:84px;height:70px}}'
    + '.card.r .rmeta{display:flex;align-items:center;gap:6px;margin-top:2px;min-width:0}'
    + '.card.r .rprice{font-size:13px;font-weight:700;color:' + THEME.primaryDark + ';letter-spacing:.3px}'
    + '.card.r .rmeta .tag{font-size:11px;padding:1px 7px;border-radius:99px;white-space:nowrap}'
    + '.card.r .rmeta .sep{color:#c3ccd6}'
    /* one row of actions: the details toggle at the start, the two buttons at the end */
    + '.card.r .rfoot{display:flex;align-items:center;gap:6px;order:20;margin-top:6px;padding-top:6px;border-top:1px solid #EEF2F6}'
    + '.card.r .rfoot .dtog{flex:none;align-self:auto;margin:0;padding:5px 4px;min-height:34px;border:none;border-radius:6px;font-size:13px;text-align:start;order:0}'
    + '.card.r .rfoot .btns{margin:0;margin-inline-start:auto;padding:0;flex-wrap:nowrap;gap:6px;order:1}'
    + '.card.r .rfoot .btns .btn{min-width:0;min-height:34px}'
    + '.card.r .rfoot .btns .btn.pri{flex:none;flex-basis:auto;order:1;padding:7px 14px;font-size:13px;border-radius:7px}'
    + '.card.r .rfoot .btns .btn.sec{flex:none;flex-basis:auto;padding:6px 12px;font-size:13px;order:0;text-decoration:none;'
    + 'border:1.5px solid #C9D3E2;border-radius:7px;color:' + THEME.primaryDark + ';background:' + THEME.bg + '}'
    + '.card.r .rfoot .btns .btn.sec:hover{border-color:' + THEME.primary + ';background:' + THEME.ice + ';color:' + THEME.primaryDark + '}'
    /* closed: the head is the card; everything else waits behind "עוד פרטים" */
    + '.card.r .chead,.card.r .brief,.card.r .hrating{display:none}'
    + '.card.r:not(.open) .gal,.card.r:not(.open) .tags,.card.r:not(.open) .why,.card.r:not(.open) .facts,.card.r:not(.open) .rows{display:none}'
    /* open: the photograph on top, the head under it without the thumbnail, then the facts */
    + '.card.r.open{padding-top:0}'
    + '.card.r.open .gal{display:block;order:0;margin:0 -10px 8px;width:calc(100% + 20px);border-radius:8px 8px 0 0}'
    + '.card.r.open .thumb,.card.r.open .rline,.card.r.open .rmeta{display:none}'
    + '.card.r.open .rows{order:2;margin-top:6px}.card.r.open .tags{order:3;margin-top:6px}.card.r.open .why{order:4;margin-top:6px}'
    + '.card.r.open .facts{order:7;margin-top:6px}.card.r.open .details{order:9;margin-top:6px}.card.r.open .cfoot{order:11}'
    + '.card.r.open .rfoot{flex-wrap:wrap}'
    /* the dtog's generic rule gives it a top border and negative margins — not here */
    + '.card.r .rfoot .dtog:hover{background:#F3F6FA}'
    /* ---- the details panel (Tomer, 10/09: "שיפתח את זה בצד ולא בתוך הצ'אט") ----
       Beside the window on a desktop — the same height, the same corner
       radius, the same shadow, 12px away — so the two read as one surface.
       Where there is no room beside it (a narrow screen, the maximised
       window, a phone) it lays over the window instead, with its own ✕. */
    + '.side{position:fixed;bottom:20px;' + THEME.position + ':calc(20px + min(460px,calc(100vw - 24px)) + 12px);'
    + 'width:min(420px,calc(100vw - 20px - min(460px,calc(100vw - 24px)) - 44px));height:min(760px,calc(100vh - 40px));height:min(760px,calc(100dvh - 40px));'
    + 'background:' + THEME.bg + ';border-radius:18px;box-shadow:0 24px 64px rgba(16,32,48,.26),0 2px 8px rgba(16,32,48,.08);border:1px solid #e3e9ef;'
    + 'display:none;flex-direction:column;overflow:hidden;z-index:1}'
    + '.side.on{display:flex;animation:pwSide .22s cubic-bezier(.05,.7,.1,1)}'
    + '@keyframes pwSide{from{opacity:0;transform:translateX(' + (THEME.position === 'left' ? '-' : '') + '14px)}to{opacity:1;transform:none}}'
    /* over the window: same box as .win, one layer up */
    + '.side.over{' + THEME.position + ':20px;width:min(460px,calc(100vw - 24px));z-index:2}'
    + '.win.max ~ .side.over{width:calc(100vw - 32px);height:calc(100vh - 32px);height:calc(100dvh - 32px);bottom:16px;' + THEME.position + ':16px}'
    + '@media (max-width:480px){.side,.side.over{bottom:0;' + THEME.position + ':0;width:100vw;height:100vh;height:100dvh;border-radius:0}}'
    + '.side .shead{display:flex;align-items:center;gap:10px;padding:10px 12px 10px 16px;border-bottom:1px solid #E7ECF3;background:' + THEME.bg + '}'
    + '.side .shead .stitle{font-weight:800;font-size:16px;color:' + THEME.primaryDark + ';flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.side .shead .sx{background:none;border:none;color:' + THEME.textLight + ';font-size:19px;cursor:pointer;min-width:40px;min-height:40px;border-radius:10px;line-height:1;font-family:inherit}'
    + '.side .shead .sx:hover{background:' + THEME.bgAlt + ';color:' + THEME.text + '}'
    + '.side .shead .sx:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:-3px}'
    + '.side .sbody{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:12px;padding:0 0 14px}'
    + '.side .sbody::-webkit-scrollbar{width:8px}.side .sbody::-webkit-scrollbar-thumb{background:#d3dae1;border-radius:99px;border:2px solid ' + THEME.bg + '}'
    /* the gallery: a 16:9 window, two round arrows that are always visible and
       always clickable — nothing else is drawn over them */
    + '.side .sgal{position:relative;background:#e8edf1;aspect-ratio:16/9;max-height:min(260px,36vh);overflow:hidden;flex:none}'
    + '.side .sgal img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.side .sgal .galb{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:38px;border-radius:50%;border:none;'
    + 'background:rgba(255,255,255,.94);color:' + THEME.text + ';line-height:0;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;'
    + 'opacity:1;z-index:5;box-shadow:0 1px 6px rgba(16,32,48,.3)}'
    + '.side .sgal .galb:hover{background:#fff}.side .sgal .galb:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:2px}'
    + '.side .sgal .galb.prev{inset-inline-start:10px}.side .sgal .galb.next{inset-inline-end:10px}'
    + '.side .sgal .galn{position:absolute;bottom:10px;inset-inline-end:12px;background:rgba(16,32,48,.62);color:#fff;'
    + 'font-size:12px;padding:2px 8px;border-radius:99px;letter-spacing:.4px;opacity:1;z-index:5}'
    + '.side .sgal .tier{position:absolute;top:10px;inset-inline-start:10px;z-index:5;box-shadow:0 1px 4px rgba(0,0,0,.25)}'
    + '.side .sgal .dots{position:absolute;bottom:12px;inset-inline-start:50%;transform:translateX(50%);display:flex;gap:5px;z-index:5}'
    + '.side .sgal .dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.55);display:block}'
    + '.side .sgal .dots i.on{background:#fff;width:14px;border-radius:3px}'
    + '.side .sec{padding:0 16px;display:flex;flex-direction:column;gap:6px}'
    + '.side .sname{font-weight:800;font-size:19px;line-height:1.25;color:' + THEME.text + ';display:flex;align-items:center;gap:8px;flex-wrap:wrap}'
    + '.side .sname .bscore{font-size:12px;font-weight:600;color:' + THEME.primaryDark + ';background:' + THEME.ice + ';border-radius:99px;padding:2px 9px;font-variant-numeric:tabular-nums}'
    + '.side .swhere{font-size:13.5px;color:' + THEME.textLight + '}'
    + '.side .sfacts{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}'
    + '.side .sfacts .ft{background:' + THEME.bgAlt + ';border-radius:10px;padding:8px 10px;min-width:0}'
    + '.side .sfacts .fk{font-size:11.5px;color:' + THEME.textLight + '}'
    + '.side .sfacts .fv{font-weight:700;font-size:14px;margin-top:2px;line-height:1.3;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}'
    + '.side .slab{font-size:12.5px;font-weight:700;color:' + THEME.primaryDark + ';letter-spacing:.2px}'
    + '.side .stxt{font-size:13.5px;color:' + THEME.text + ';line-height:1.55}'
    + '.side .srow{display:flex;gap:8px;align-items:baseline;font-size:13.5px;line-height:1.5}'
    + '.side .srow .rlab{color:' + THEME.textLight + ';flex:none}'
    + '.side .srow .rval{color:' + THEME.text + ';font-weight:600}'
    + '.side .snote{font-size:12px;color:' + THEME.textLight + '}'
    + '.side .tags{display:flex;gap:6px;flex-wrap:wrap}'
    + '.side .sfoot{display:flex;gap:8px;padding:10px 16px 14px;border-top:1px solid #E7ECF3;background:' + THEME.bg + ';flex:none}'
    + '.side .sfoot .btn{min-height:44px;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;padding:10px 14px}'
    + '.side .sfoot .btn.pri{flex:1.4}'
    + '.side .sfoot .btn.sec{flex:1;background:' + THEME.bg + ';color:' + THEME.primaryDark + ';border:1.5px solid ' + THEME.primary + '}'
    + '.side .sfoot .btn.sec:hover{background:' + THEME.ice + '}'
    /* the board chooser: a segmented control, one button per board the hotel
       actually sells (Tomer, 10/09). A single board is a fact, not a control */
    + '.bsel{display:flex;gap:6px;flex-wrap:wrap}'
    + '.bsel button{font-family:inherit;font-size:13px;font-weight:600;padding:7px 12px;border-radius:99px;cursor:pointer;'
    + 'border:1.5px solid #C9D3E2;background:' + THEME.bg + ';color:' + THEME.textLight + ';transition:background .15s,border-color .15s,color .15s}'
    + '.bsel button:hover{border-color:' + THEME.primary + ';color:' + THEME.primaryDark + '}'
    + '.bsel button.on{background:' + THEME.primaryDark + ';border-color:' + THEME.primaryDark + ';color:#fff}'
    + '.bsel button:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:2px}'
    /* on the closed row card the same choice is a small select beside the price */
    + '.card.r .rmeta .rboard{font-size:12px;color:' + THEME.textLight + ';white-space:nowrap}'
    + '.card.r .rmeta select.rbsel{font-family:inherit;font-size:12px;font-weight:600;color:' + THEME.primaryDark + ';background:' + THEME.ice + ';'
    + 'border:1px solid #D6E3F1;border-radius:99px;padding:2px 8px;cursor:pointer;max-width:170px}'
    + '.card.r.sel{border-color:' + THEME.primary + ';box-shadow:0 0 0 2px rgba(28,61,90,.12)}'
    /* Sunny's card ends in one wide navy button; the callback is a link under it */
    + '.card:not(.pbg) .btns .btn.pri{flex-basis:100%;order:-1;padding:11px 12px;font-size:14px;border-radius:8px}'
    + '.card:not(.pbg) .btns .btn.sec{flex-basis:100%;background:none;border:none;color:' + THEME.primaryDark + ';'
    + 'text-decoration:underline;text-underline-offset:3px;padding:4px 0;font-weight:600;box-shadow:none}'
    + '.card:not(.pbg) .btns .btn.sec:hover{background:none;color:' + THEME.primary + '}'
    + '.btn{flex:1 1 0;min-width:112px;min-height:40px;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:background .15s,border-color .15s}'
    + '.btn.pri{background:' + THEME.grad + ';color:#fff;box-shadow:0 2px 6px rgba(28,61,90,.25)}'
    + '.btn.pri:hover{filter:brightness(1.08);box-shadow:0 4px 12px rgba(28,61,90,.3)}'
    + '.btn.sec{background:' + THEME.bg + ';color:' + THEME.primaryDark + ';border:1.5px solid ' + THEME.primary + '}'
    + '.btn.sec:hover{background:' + THEME.bgAlt + '}'
    // One row that scrolls sideways, not four rows that push the offers off the
    // screen. Eight chips wrapping was 173px on a phone — the second largest
    // thing in the conversation after the offers themselves (measured 26/08).
    + '.chips{display:flex;flex-wrap:nowrap;gap:7px;align-self:stretch;padding-inline-start:2px;'
    + 'overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;'
    + 'scroll-snap-type:x proximity;padding-bottom:2px;'
    // flex:none is load-bearing. A scroll container's automatic minimum size is
    // 0, not its content — so as a flex item in the scrolling message column it
    // squashed to nothing the moment the conversation overflowed.
    + 'flex:none;min-width:0;max-width:100%}'
    + '.chips::-webkit-scrollbar{height:0}'
    /* the row scrolls sideways; when more chips wait past the edge, that edge
       fades instead of looking cut off (Tomer, 06/09: "למה זה ככה?") */
    + '.chips.more{-webkit-mask-image:linear-gradient(to left,#000 calc(100% - 56px),transparent);mask-image:linear-gradient(to left,#000 calc(100% - 56px),transparent)}'
    /* the narrow window keeps the header to one line each: role only, and
       the WhatsApp pill as an icon */
    + '.win:not(.big) .hdr .sub .long2,.win:not(.big) .hdr .ttl .long{display:none}'
    + '.win:not(.big) .hdr .wa span{display:none}.win:not(.big) .hdr .wa{padding:7px}'
    + '.chip{scroll-snap-align:start;flex:none}'
    + '.chip{border:1px solid #d8dfe6;background:' + THEME.bg + ';color:' + THEME.textLight + ';border-radius:99px;'
    // min-height 36px: a 30px chip is below the comfortable tap target on a
    // phone, and chips are the main way a customer refines on mobile
    + 'padding:9px 15px;min-height:38px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:500;transition:all .15s}'
    + '.chip:hover{background:' + THEME.primary + ';color:#fff;border-color:' + THEME.primary + '}'
    // שורת הקלט כמסגרת אחת שעוטפת גם את כפתור השליחה — כמו בממשקי AI
    + '.inp{display:flex;gap:10px;padding:8px 16px 6px;background:' + THEME.bg + ';align-items:center;border-top:1px solid #E7ECF3}'
    /* "התשובות בגדר המלצה" — where Sunny keeps it: above the field, always visible */
    + '.legal{text-align:center;font-size:11.5px;color:' + THEME.textLight + ';padding:6px 16px 0;background:' + THEME.bg + ';border-top:1px solid #E7ECF3}'
    + '.legal + .inp{border-top:none;padding-top:4px}'
    /* שדה הקלט של סאני: פינות 8px ומסגרת בגוון בועת הלקוח */
    + '.inp .box{flex:1;display:flex;align-items:flex-end;gap:6px;border:1px solid #D6DFEA;border-radius:14px;'
    + 'padding:6px;padding-inline:14px 8px;background:' + THEME.bg + ';box-shadow:0 1px 3px rgba(30,39,51,.06);transition:border-color .15s,box-shadow .15s}'
    + '.inp .box:focus-within{border-color:' + THEME.primary + ';box-shadow:0 0 0 3px rgba(55,69,92,.10)}'
    + '.inp textarea{flex:1;border:none;background:none;padding:9px 4px;font-size:15px;font-family:inherit;direction:rtl;'
    + 'resize:none;overflow-y:auto;line-height:1.5;max-height:110px;min-height:32px;color:' + THEME.text + '}'
    + '.inp textarea:focus{outline:none}'
    + '.send:hover:not(:disabled){filter:brightness(1.1)}'
    + '.send{background:' + THEME.primaryDark + ';border:none;color:#fff;border-radius:50%;width:44px;height:44px;flex:none;'
    + 'box-shadow:0 2px 8px rgba(28,45,70,.28);'
    + 'cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}'
    + '.send:hover{background:' + THEME.primaryDark + '}'
    + '.send:disabled{opacity:.45;cursor:default}'
    /* the conversion moment gets the same visual language as the rest of the
       widget: card border + elevation instead of a heavy primary frame, inputs
       styled like the composer, and a real focus ring. It used to look pasted
       from another product (design audit, 27/08). */
    + '.form{align-self:stretch;background:' + THEME.bg + ';border:1px solid #dde5ec;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:8px;'
    + 'box-shadow:0 1px 3px rgba(16,32,48,.05)}'
    + '.form .ftitle{font-size:15px;font-weight:700;color:' + THEME.text + ';line-height:1.35}'
    + '.form label{font-size:12px;color:' + THEME.textLight + '}'
    + '.form input{border:1px solid #dde5ec;border-radius:12px;padding:9px 12px;font-size:16px;font-family:inherit;direction:rtl;color:' + THEME.text + ';'
    + 'transition:border-color .15s,box-shadow .15s}'
    + '.form input:focus{outline:none;border-color:' + THEME.primary + ';box-shadow:0 0 0 3px rgba(28,61,90,.08)}'
    + '.form input[aria-invalid="true"]{border-color:#b3261e}'
    + '.form .note{font-size:12px;color:' + THEME.textLight + '}'
    + '.form .note.err{color:#b3261e;font-weight:600}'
    /* everything that enters the conversation rises 8px and fades in over
       180ms, decelerating (craft research, 27/08) */
    + '.m,.cards-row,.form,.typing,.chips{animation:pwIn .18s cubic-bezier(.05,.7,.1,1) both}'
    + '@keyframes pwIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'
    /* pressed state: the 100ms feedback rule — the widget had zero :active styles */
    + '.btn:active,.chip:active,.send:active,.hdr .x:active,.hdr .exp:active,.galb:active,.dtog:active,.wa:active{transform:scale(.96)}'
    + '.btn:disabled,.chip:disabled{opacity:.55;cursor:default;transform:none}'
    /* one focus ring for the controls that had none */
    + '.rlink:focus-visible,.imore:focus-visible,.galb:focus-visible,.fine a:focus-visible,.consent a:focus-visible,.form input:focus-visible,.galn:focus-visible'
    + '{outline:2px solid ' + THEME.primaryDark + ';outline-offset:2px}'
    // visually hidden, still read aloud — the live region above
    + '.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;'
    + 'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}'
    // מס' השיחה, כמו אצל סאני: הלקוח יכול לצטט אותו לנציג, והנציג מוצא בעזרתו
    // את השיחה ביומן ואת הליד ב-CRM. יושב בשורת הכותרת ולא בשורה משלו — שורה
    // נוספת בתחתית גזלה גובה, והפילה את מבחן הגלילה במובייל (1.65 מסכים).
    + '.hdr .cidsub{opacity:.75;letter-spacing:.3px}';

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);
  // Hebrew brand face. Loaded into the host document (fonts do not cross the
  // shadow boundary); falls back to the system stack if the CDN is blocked.
  try {
    if (!document.querySelector('link[data-pw-font]')) {
      var fl = document.createElement('link');
      fl.rel = 'stylesheet'; fl.setAttribute('data-pw-font', '');
      fl.href = 'https://fonts.googleapis.com/css2?family=Assistant:wght@400;500;600;700&display=swap';
      document.head.appendChild(fl);
    }
  } catch (e) { }

  /* ============== dom ============== */
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  var wrap = el('div', 'wrap');
  var fab = el('button', 'fab');
  fab.innerHTML =
    '<span class="av"><img class="base" src="' + PINGI_LAUNCH + '" alt="" aria-hidden="true">' +
    (PINGI_LAUNCH !== PINGI_BOARD ? '<img class="alt" src="' + PINGI_BOARD + '" alt="" aria-hidden="true">' : '') +
    '<span class="dot" aria-hidden="true"></span></span>' +
    '<span class="txt"><b class="l1">' + LAUNCH_T + '</b><span class="l2">' + LAUNCH_S + '</span></span>' +
    '<span class="go" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none">' +
    '<path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  fab.setAttribute('aria-label', LAUNCH_T + ' — ' + LAUNCH_S);
  // הנקודה האדומה מופיעה פעם אחת לביקור. אדומה קבועה מאבדת את הכוח שלה
  // תוך יומיים — אפקט שמתרגלים אליו כבר לא מושך.
  try { if (sessionStorage.getItem(SEEN_KEY)) fab.classList.add('seen'); } catch (e) { }
  var win = el('div', 'win');
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'צ׳אט פינגווין');

  var hdr = el('div', 'hdr');
  var mark = el('div', 'mark');
  mark.innerHTML = '<img src="' + PINGI + '" alt="" aria-hidden="true">';
  hdr.appendChild(mark);
  var hTxt = el('div');
  var ttl = el('div', 'ttl', 'פינגי');
  ttl.appendChild(el('span', 'long', ' · פינגווין'));
  hTxt.appendChild(ttl);
  var hSub = el('div', 'sub', 'נציג דיגיטלי');
  hSub.appendChild(el('span', 'long2', ' · בונה לכם את החופשה המתאימה'));
  // מס' שיחה גלוי (הלקח מסאני): הלקוח יכול לצטט אותו לנציג, והנציג מוצא בעזרתו
  // את השיחה ביומן ואת הליד ב-CRM — שלושתם נושאים את אותו מזהה.
  var hCid = el('span', 'cidsub', '');
  hSub.appendChild(hCid);
  hTxt.appendChild(hSub);
  function updateCid() {
    var id = cid();
    var short = id ? String(id).replace(/^c/, '').slice(0, 8) : '';
    hCid.textContent = short ? ' · מס׳ שיחה ' + short : '';
    // foot is built further down; guard so the first call (before it exists)
    // does not throw and kill the whole widget
    if (typeof fCid !== 'undefined' && fCid) fCid.textContent = short ? 'מס׳ שיחה ' + short : '';
  }
  // Let the customer decide how much room the chat gets. A fixed box the
  // page cannot escape is the most common complaint about widgets like this,
  // and three offers side by side need real width to be readable.
  var hExp = el('button', 'x exp', '⤡');
  hExp.title = 'הגדלת החלון';
  hExp.setAttribute('aria-label', hExp.title);
  function setExpanded(max) {
    win.classList.toggle('max', max);
    hExp.textContent = max ? '⤢' : '⤡';
    hExp.title = max ? 'הקטנת החלון' : 'הגדלת החלון';
    hExp.setAttribute('aria-label', hExp.title);
    // not remembered across page loads: a window that was maximised once
    // came back maximised on every visit, and read as "opens full screen"
    try { localStorage.removeItem('pingwin_bot_max'); } catch (e) {}
    scrollDown();
  }
  hExp.addEventListener('click', function () { setExpanded(!win.classList.contains('max')); });
  try { localStorage.removeItem('pingwin_bot_max'); } catch (e) {}
  var hX = el('button', 'x', '✕');
  hX.setAttribute('aria-label', 'סגירת הצ׳אט');
  // a human is one tap away from every state — the research is unambiguous
  // that customers who cannot find the exit stop trusting the bot
  var hWa = null;
  if (WHATSAPP) {
    hWa = document.createElement('a');
    hWa.className = 'wa'; hWa.target = '_blank'; hWa.rel = 'noopener';
    hWa.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.8-1.4.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 12 12 0 0 0 4.6 4c.6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.5-.3z"/></svg><span>וואטסאפ</span>';
    hWa.setAttribute('aria-label', 'המשך בוואטסאפ עם נציג');
    hWa.addEventListener('click', function () {
      // The rep used to get three fragments of the customer's own words and
      // nothing else — no hotel, no dates, no way to find the conversation.
      var gist = state.messages.filter(function (m) { return m.role === 'user'; }).slice(-3).map(function (m) { return m.content; }).join(' / ');
      var last = (state.lastCards || [])[0];
      var sl = state.slots || {};
      var bits = ['שלום, הגעתי מהצ׳אט באתר של פינגווין.'];
      if (last) {
        bits.push('ההצעה שראיתי: ' + last.hotel + (last.resort ? ' (' + last.resort + ')' : '') +
          (last.date ? ', ' + fmtDate(last.date) : '') + (last.nights ? ', ' + last.nights + ' לילות' : ''));
      }
      var who = [];
      if (sl.adults) who.push(sl.adults + ' מבוגרים');
      if ((sl.children_ages || []).length) who.push('ילדים בגילאי ' + sl.children_ages.join(', '));
      if (who.length) bits.push('נוסעים: ' + who.join(' + '));
      if (gist) bits.push('מה שחיפשתי: ' + gist);
      if (cid()) bits.push('מזהה שיחה: ' + cid());
      hWa.href = 'https://wa.me/' + WHATSAPP + '?text=' + encodeURIComponent(bits.join('\n'));
      track('whatsapp', { hotel: last ? last.hotel : null, cid: cid() });
    });
    hWa.href = 'https://wa.me/' + WHATSAPP;
  }
  hdr.appendChild(hTxt); if (hWa) hdr.appendChild(hWa); hdr.appendChild(hExp); hdr.appendChild(hX);

  var msgs = el('div', 'msgs');
  /* The live region is a small dedicated node, not the whole scroll container.
     With aria-live on `.msgs`, every card, chip row, status line and form was
     a change inside a live region — and a restored session injected the entire
     transcript into it at page load, so a screen-reader user heard the whole
     conversation again on every reply. Now only the bot's new sentence is
     announced, and the transcript stays in the reading order where it belongs. */
  var live = el('div', 'sr');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  function announce(text) {
    if (!text) return;
    // replacing the text is what makes it an announcement
    live.textContent = '';
    setTimeout(function () { live.textContent = String(text).slice(0, 400); }, 30);
  }

  var inp = el('div', 'inp');
  var input = document.createElement('textarea');
  input.rows = 1;
  input.placeholder = 'אפשר לכתוב כאן…';
  input.setAttribute('aria-label', 'הודעה לבוט');
  // auto-grow up to ~4 lines so long messages stay visible while typing,
  // and expand the whole window once the user starts typing
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    // (typing no longer widens the window — only offers do)
  });
  var send = el('button', 'send');
  send.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(180deg)" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
  send.setAttribute('aria-label', 'שליחה');
  var inpBox = el('div', 'box');
  inpBox.appendChild(input);
  inp.appendChild(inpBox); inp.appendChild(send);
  var legal = el('div', 'legal', 'התשובות בגדר המלצה — כל הזמנה מאושרת סופית על ידי נציג');

  /* פס תחתון בסגנון סאני: מס' השיחה בקצה אחד, "שיחה חדשה" בשני. במחקר
     מ-30/08 ציינו שאצלה זה בתחתית ואצלנו בכותרת — עכשיו זה בשני המקומות:
     בכותרת כהקשר, וכאן כפעולה שהלקוח מוצא בלי לחפש. */
  var foot = el('div', 'foot');
  var fCid = el('span', 'fcid', '');
  var fNew = el('button', 'fnew', 'שיחה חדשה');
  fNew.addEventListener('click', function () { resetChat(); });
  foot.appendChild(fCid); foot.appendChild(fNew);

  var jump = el('button', 'jump', '↓ להודעה האחרונה');
  jump.setAttribute('aria-label', 'גלילה להודעה האחרונה');
  jump.addEventListener('click', function () { scrollDown(); });
  msgs.appendChild(jump);
  var jumpArmed = false;
  ['wheel', 'touchmove'].forEach(function (evn) { msgs.addEventListener(evn, function () { jumpArmed = true; }, { passive: true }); });
  msgs.addEventListener('keydown', function (e) { if (/Arrow|Page|Home|End/.test(e.key)) jumpArmed = true; });
  msgs.addEventListener('scroll', function () {
    jump.classList.toggle('on', jumpArmed && msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight > 240);
  });
  win.appendChild(hdr); win.appendChild(msgs); win.appendChild(live); win.appendChild(legal); win.appendChild(inp); win.appendChild(foot);
  // the details panel lives beside the window (see openSide)
  var side = el('div', 'side');
  side.setAttribute('role', 'dialog');
  side.setAttribute('aria-label', 'פרטי המלון');
  wrap.appendChild(win); wrap.appendChild(side); wrap.appendChild(fab);
  root.appendChild(wrap);

  /* ============== ui helpers ============== */
  function scrollDown() {
    // the jump button lives at the end of the column: keep it there as messages are added
    if (typeof jump !== 'undefined' && jump && jump.parentNode === msgs && msgs.lastElementChild !== jump) msgs.appendChild(jump);
    if (typeof jumpArmed !== 'undefined') { jumpArmed = false; }
    if (typeof jump !== 'undefined' && jump) jump.classList.remove('on');
    msgs.scrollTop = msgs.scrollHeight;
  }
  // a hung request must not lock the chat forever
  function fetchWithTimeout(url, opts, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; },
      function (e) { clearTimeout(timer); throw e; });
  }
  /* ============== session persistence ==============
     "המשך להזמנה" navigates to a hotel page; without this the customer came
     back to an empty chat.
     30/08: sessionStorage cleared the whole conversation the moment the tab
     closed. Sunny (Isrotel/Abra) restores the previous conversation days
     later, under the same conversation id — reopened it the next morning and
     the last exchange was still there. For a holiday people decide on over a
     week that is the difference between a warm lead and starting from zero, so
     we keep the chat in localStorage with an explicit expiry.
     A transcript that outlives the browser session is also a transcript on a
     shared computer, so: a hard TTL, the "שיחה חדשה" button in the header, and
     ?pwreset=1 all clear it, and only the last 20 turns are kept. */
  // The offer is the hotel's photograph, with the text on it (Tomer, 26/08).
  // ?pwcard=plain — or ...pingwin-bot.js?card=plain on the tag — draws the
  // older white card instead; kept because it is the fallback whenever a hotel
  // has no photo at all, and the two are worth comparing on real traffic.
  var CARD_STYLE = (function () {
    try {
      var v = new URLSearchParams(window.location.search).get('pwcard');
      if (!v && script && script.src) v = new URL(script.src).searchParams.get('card');
      // 06/09 (Tomer: "שהבוט ייראה יותר כמו סאני"): the white card with the
      // photograph on top; ?pwcard=photo brings the photo-card back.
      // 10/09 (Tomer: "צריך לגלול הרבה, אולי להקטין את המלונות"): the row card
      // is the default — a thumbnail, the facts on one line, the buttons on
      // one row, ~130px instead of ~540. ?pwcard=plain keeps option י.
      return v === 'photo' ? 'photo' : v === 'plain' ? 'plain' : 'row';
    } catch (e) { return 'row'; }
  })();

  // the thumbs-up/down row under answers — off by default (Tomer, 10/09)
  var FEEDBACK_THUMBS = (function () {
    try {
      var v = new URLSearchParams(window.location.search).get('pwthumbs');
      if (!v && script && script.src) v = new URL(script.src).searchParams.get('thumbs');
      return v === '1';
    } catch (e) { return false; }
  })();

  var STORE_KEY = 'pingwin_bot_session_v1';
  // Days a conversation is worth resuming. Long enough to cover "אחשוב על זה
  // ואחזור", short enough that a chat is not sitting on a family computer for
  // a season. Tomer can change it in one place.
  var STORE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  // localStorage where it exists (survives the tab closing), sessionStorage
  // where it does not, and a no-op in private modes that throw on both — the
  // widget must never fail to load because storage is unavailable.
  var store = (function () {
    function usable(s) {
      try { var k = '__pw'; s.setItem(k, '1'); s.removeItem(k); return true; }
      catch (e) { return false; }
    }
    try { if (usable(window.localStorage)) return window.localStorage; } catch (e) {}
    try { if (usable(window.sessionStorage)) return window.sessionStorage; } catch (e) {}
    return { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  })();
  // The widget's own build, taken from its script URL (?v=0.2.0 in the GTM tag).
  // A conversation started on an older build is not resumed on a newer one: the
  // replay would mix old wording and old cards into a new bot.
  var BUILD = (function () {
    try { return new URL(script.src).searchParams.get('v') || '0'; } catch (e) { return '0'; }
  })();
  function persist() {
    try {
      store.setItem(STORE_KEY, JSON.stringify({
        build: BUILD, savedAt: Date.now(),
        messages: state.messages.slice(-20), slots: state.slots, lastCards: state.lastCards || null,
        booted: state.booted, open: state.open, log: state.log.slice(-40)
      }));
    } catch (e) {}
  }
  // Flags that mean "already said once in this conversation". They are right
  // within a sitting and wrong across a fortnight: a customer returning a week
  // later had the closing line permanently suppressed, the offer to hand over
  // to a person permanently suppressed, and offers they no longer remember
  // hidden as already-seen. Dropped on restore so a returning customer gets a
  // conversation that still talks to them.
  var STALE_ON_RESTORE = ['_closed', '_nudged', '_lastLines', '_shown', '_fixed_said',
    '_notes_said', '_dates_said', '_know_said', '_lastEcho', '_held', '_showMe', '_lost'];

  function restore() {
    try {
      // ?pwreset=1 in the URL (or #pwreset) forces a clean chat — the switch
      // testers reach for when a hard refresh keeps replaying the old session
      // a clean chat means clean all the way: the red dot comes back too,
      // otherwise a tester can never see the launcher as a first-time visitor
      if (/[?&#]pwreset\b/.test(location.href)) {
        store.removeItem(STORE_KEY);
        try { sessionStorage.removeItem(SEEN_KEY); sessionStorage.removeItem('pw_rode'); fab.classList.remove('seen'); } catch (e) { }
        return null;
      }
      var raw = store.getItem(STORE_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !Array.isArray(d.messages)) return null;
      if (d.build !== BUILD) { store.removeItem(STORE_KEY); return null; }
      // Expired is the same as absent — and it is cleared rather than left to
      // sit there, so a stale transcript does not outlive its own welcome.
      if (d.savedAt && (Date.now() - d.savedAt) > STORE_TTL_MS) {
        store.removeItem(STORE_KEY); return null;
      }
      // a conversation resumed on another day starts its once-per-conversation
      // behaviours again — see STALE_ON_RESTORE above
      var sameDay = d.savedAt && (Date.now() - d.savedAt) < 12 * 60 * 60 * 1000;
      if (!sameDay && d.slots) {
        for (var i = 0; i < STALE_ON_RESTORE.length; i++) delete d.slots[STALE_ON_RESTORE[i]];
      }
      return d;
    } catch (e) { return null; }
  }
  // Start over — for a customer whose plans changed, and for us while testing.
  function resetChat() {
    try { closeSide(); } catch (e) { /* not built yet */ }
    try { store.removeItem(STORE_KEY); } catch (e) {}
    state.messages = []; state.slots = {}; state.lastCards = null; state.log = [];
    state.booted = false; state.turn = 0; state.busy = false;
    state.gen = (state.gen || 0) + 1;      // orphan anything still in flight
    while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
    msgs.appendChild(jump); state._lastAt = null;
    updateCid();                          // a new conversation gets a new id
    win.classList.remove('big');
    send.disabled = false;
    state.open = false; openWin();        // re-runs the greeting and the starters
    track('reset');
  }
  // bring an element to the TOP of the view — used when offers arrive, so the
  // customer sees them from the first card instead of landing past them
  function scrollToTopOf(node) {
    if (!node) return;
    // a view we positioned on purpose is not "the customer scrolled up"
    if (typeof jumpArmed !== 'undefined') { jumpArmed = false; }
    if (typeof jump !== 'undefined' && jump) jump.classList.remove('on');
    msgs.scrollTop = Math.max(0, node.offsetTop - msgs.offsetTop - 12);
  }

  // "12:04" in the customer's own clock. A conversation that is resumed a day
  // later without times reads as one long block — and this chat is meant to be
  // picked up again (Tomer, 26/08, after Issta's bot).
  function clockOf(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function addMsg(role, text, silent, at) {
    if (!text) return null;
    /* מספר טלפון בתוך משפט עברי חייב להיצבע משמאל לימין.
       קודם הוחלף כאן המקף הרגיל במקף לא-שביר (U+2011) כדי שהמספר לא יישבר
       בין שתי שורות — אבל U+2011 הוא תו נייטרלי באלגוריתם הדו-כיווניות, ולכן
       הוא הפריד את "04" מ-"8557722" ושתי הקבוצות נצבעו בסדר עברי:
       הלקוח ראה 8557722-04. (תומר צילם את זה, 31/08; נמדד בדפדפן.)
       הפתרון: מקף רגיל (שמחבר שתי קבוצות ספרות לרצף אחד), עטוף בבידוד
       LTR — כך הכיוון מובטח גם אם המספר יושב בקצה שורה או ליד מספר אחר. */
    var shown = String(text).replace(/(\d{2,3})-(\d{7})/g, '\u2066$1-$2\u2069');
    // הפינגווין רק בראש רצף: אם ההודעה הקודמת באזור היא גם של הבוט, אין
    // אווטאר — כך רצף של שלוש שורות מפינגי נראה כמו תשובה אחת, לא כמו שלוש.
    var prev = msgs.lastElementChild;
    // the jump button and a time divider are not messages — look past them
    while (prev && prev.classList && (prev.classList.contains('jump') || prev.classList.contains('tdiv'))) prev = prev.previousElementSibling;
    var lead = role !== 'user' && !(prev && prev.classList &&
      prev.classList.contains('m') && prev.classList.contains('bot'));
    var m = el('div', 'm ' + (role === 'user' ? 'user' : 'bot' + (lead ? ' lead' : '')));
    m.appendChild(el('span', 'mtxt', shown));
    var ts = el('span', 'ts', clockOf(at));
    ts.setAttribute('aria-hidden', 'true');   // the time is decoration for a screen reader
    m.appendChild(ts);
    // a time marker only when the conversation paused (30 min) or crossed a day
    var when = at ? new Date(at) : new Date();
    if (isNaN(when.getTime())) when = new Date();
    var prevAt = state._lastAt ? new Date(state._lastAt) : null;
    if (!prevAt || (when - prevAt) > 30 * 60 * 1000 || when.toDateString() !== prevAt.toDateString()) {
      var sameDay = when.toDateString() === new Date().toDateString();
      var lab = (sameDay ? '' : ('0' + when.getDate()).slice(-2) + '.' + ('0' + (when.getMonth() + 1)).slice(-2) + ' · ') + clockOf(when.toISOString());
      var dv = el('div', 'tdiv', lab); dv.setAttribute('aria-hidden', 'true');
      msgs.appendChild(dv);
    }
    state._lastAt = when.toISOString();
    msgs.appendChild(m); scrollDown();
    if (!silent) state.log.push({ t: role === 'user' ? 'user' : 'bot', v: text, at: at || new Date().toISOString() });
    return m;
  }

  /* Fold a long reply: the first lines stay, the rest opens on "עוד". Only
     when the fold actually saves lines — a reply that fits is left alone.
     `tight` is the version above the offers (three lines). */
  function foldMsg(m, tight) {
    if (!m || !m.querySelector) return;
    var txt = m.querySelector('.mtxt');
    if (!txt) return;
    m.classList.add('fold'); if (tight) m.classList.add('tight');
    var clipped = txt.scrollHeight - txt.clientHeight > 8;
    if (!clipped) { m.classList.remove('fold', 'tight'); return; }
    m.classList.add('folded');
    var more = el('button', 'mmore', 'עוד ▾');
    more.type = 'button';
    more.addEventListener('click', function () {
      var open = !m.classList.contains('fold');
      if (open) { m.classList.add('fold'); more.textContent = 'עוד ▾'; }
      else { m.classList.remove('fold'); more.textContent = 'פחות ▴'; }
    });
    m.appendChild(more);
  }

  // The fine print every AI assistant owes the person reading it. Kept to two
  // short sentences: a wall of legal text at the top of a chat is not read, and
  // the parts that matter here are that it can be wrong and that a human
  // confirms. תומר, 26/08 — לפי מה שאיסתא מציגים בבוט שלהם.
  function addDisclosure() {
    var txt = say('ai_disclosure',
      'השיחה מבוססת בינה מלאכותית — ייתכנו אי-דיוקים, וכל הזמנה מאושרת סופית על ידי נציג. המידע נשמר לשיפור השירות, בהתאם ל{privacy}.');
    var m = el('div', 'fine');
    var parts = String(txt).split('{privacy}');
    m.appendChild(document.createTextNode(parts[0]));
    if (parts.length > 1) {
      var a = document.createElement('a');
      a.href = PRIVACY_URL; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'מדיניות הפרטיות';
      m.appendChild(a);
      m.appendChild(document.createTextNode(parts.slice(1).join('{privacy}')));
    }
    msgs.appendChild(m); scrollDown();
    return m;
  }

  var typingEl = null, typingTimer = null;
  function showTyping(on) {
    if (on && !typingEl) {
      typingEl = el('div', 'typing');
      typingEl.appendChild(el('i')); typingEl.appendChild(el('i')); typingEl.appendChild(el('i'));
      msgs.appendChild(typingEl); scrollDown();
      // כמו אצל סאני: כשהתשובה לוקחת רגע, אומרים מה קורה במקום להשאיר נקודות.
      // רק אחרי שנייה וחצי — תשובה מהירה לא צריכה את זה.
      typingTimer = setTimeout(function () {
        if (typingEl) { typingEl.appendChild(el('span', 'tlab', 'מתאים לכם אפשרויות…')); scrollDown(); }
      }, 1500);
    } else if (!on && typingEl) {
      clearTimeout(typingTimer); typingTimer = null;
      typingEl.remove(); typingEl = null;
    }
  }

  // שורת השקיפות מעל הצעות — מגיעה מהשרת מוכנה (search_echo_he), ונשמרת
  // ביומן כדי שתשוחזר יחד עם שאר השיחה
  function addStatus(text, silent) {
    if (!text) return null;
    // a thin line icon, not an emoji (Tomer, 06/09: "זה ילדותי")
    var s = el('div', 'status');
    s.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" style="vertical-align:-1px;margin-inline-end:5px;opacity:.7"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';
    s.appendChild(document.createTextNode(text));
    msgs.appendChild(s); scrollDown();
    if (!silent) state.log.push({ t: 'status', v: text });
    return s;
  }

  /* מה שהלקוח חיפש, כשדות — נוסע עם הליד ל-CRM (server/crm-lead.js).
     רשימה סגורה במכוון: מוסיפים כאן שדה רק אם רוצים שהוא יגיע ל-CRM. */
  var LEAD_FIELDS = ['adults', 'children_ages', 'month', 'month_alt', 'exact_day',
    'flexible_dates', 'nights_wanted', 'country', 'destination', 'departure_airport',
    'needs_hebrew_kids_club', 'no_saturday_flights', 'preferences', 'notes_from_customer'];
  function leadRequest() {
    var s = state.slots || {}, out = {};
    LEAD_FIELDS.forEach(function (k) {
      var v = s[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
      out[k] = v;
    });
    return out;
  }

  /* פידבק בסגנון סאני (30/08): אגודל למעלה/למטה מתחת לתשובה האחרונה בלבד.
     ההצבעה נשלחת ל-/api/feedback ונשמרת בצד השרת — בלי פרטים אישיים. */
  function addFeedback(replyText) {
    var old = msgs.querySelectorAll('.fb');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var row = el('div', 'fb');
    var note = el('span', 'fbnote', '');
    function voteBtn(sym, vote, label) {
      var b = el('button', null, sym);
      b.setAttribute('aria-label', label);
      b.addEventListener('click', function () {
        if (b.classList.contains('on')) return;
        var sib = row.querySelectorAll('button');
        for (var j = 0; j < sib.length; j++) sib[j].classList.remove('on');
        b.classList.add('on');
        note.textContent = vote === 'up' ? 'תודה!' : 'תודה — נלמד מזה.';
        track('feedback', { vote: vote });
        fetchWithTimeout(API_BASE + '/api/feedback', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            vote: vote, conversationId: cid(),
            reply: String(replyText || '').slice(0, 600)
          })
        }, 10000).catch(function () { });
      });
      return b;
    }
    row.appendChild(voteBtn('👍', 'up', 'תשובה טובה'));
    row.appendChild(voteBtn('👎', 'down', 'תשובה פחות טובה'));
    row.appendChild(note);
    msgs.appendChild(row);
    return row;
  }

  // `bare` drops the "יציאה ביום" prefix — the card now labels the row itself,
  // and "תאריך יציאה: יציאה ביום חמישי" says it twice.
  function fmtDate(iso, label, bare) {
    var d = new Date(iso + 'T00:00:00');
    var days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    var s = (bare ? 'יום ' : 'יציאה ביום ') + days[d.getDay()] + ' ' +
      d.getDate() + '.' + (d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2);
    if (label) s += ' (' + label + ')';
    return s;
  }

  // the name printed on a card: the site's own (display_name), the workbook's as the fallback
  function shownName(c) { return c.display_name || c.hotel; }

  /* ---------- the board (בסיס אירוח) the customer picks ----------
     c.board_options come from the server, per hotel: the site's own booking
     engine when it answered, the hotel page otherwise. The choice rides on
     the card object (c._board), so the panel, the card and the booking link
     all agree, and a restored chat remembers it. */
  function boardOf(c) {
    var opts = c.board_options || [];
    if (!opts.length) return null;
    var code = c._board || c.board_default || opts[0].code;
    for (var i = 0; i < opts.length; i++) if (opts[i].code === code) return opts[i];
    return opts[0];
  }
  function setBoard(c, code) {
    c._board = code;
    var b = boardOf(c);
    c._board_he = b ? b.he : null;
    // the link the customer clicks carries the board they chose
    if (c.booking_url && b) c.booking_url = withParam(c.booking_url, 'pwpans', String(b.code));
    // every control that shows this card's board follows
    var ctrls = (c._boardCtrls || []);
    for (var i = 0; i < ctrls.length; i++) { try { ctrls[i](b); } catch (e) { /* a control that is gone */ } }
    persist();
  }
  function withParam(url, name, value) {
    try {
      var u = new URL(url, window.location.href);
      u.searchParams.set(name, value);
      return u.toString();
    } catch (e) { return url; }
  }
  // a segmented control (the panel) or a small select (the card)
  function boardControl(c, kind) {
    var opts = c.board_options || [];
    if (!opts.length) return null;
    var cur = boardOf(c);
    if (opts.length === 1) {
      return el('span', kind === 'select' ? 'rboard' : 'stxt', cur.he);
    }
    var node;
    if (kind === 'select') {
      node = document.createElement('select');
      node.className = 'rbsel';
      node.setAttribute('aria-label', 'בסיס אירוח');
      opts.forEach(function (o) {
        var op = document.createElement('option'); op.value = String(o.code); op.textContent = o.he;
        if (cur && o.code === cur.code) op.selected = true;
        node.appendChild(op);
      });
      node.addEventListener('change', function () { setBoard(c, +node.value); track('board_pick', { hotel: c.hotel, board: node.value }); });
      node.addEventListener('click', function (ev) { ev.stopPropagation(); });
      c._boardCtrls = (c._boardCtrls || []).concat(function (b) { if (b) node.value = String(b.code); });
    } else {
      node = el('div', 'bsel');
      node.setAttribute('role', 'radiogroup');
      node.setAttribute('aria-label', 'בסיס אירוח');
      var btns = [];
      opts.forEach(function (o) {
        var b = el('button', 'bopt' + (cur && o.code === cur.code ? ' on' : ''), o.he);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(!!(cur && o.code === cur.code)));
        b.addEventListener('click', function () { setBoard(c, o.code); track('board_pick', { hotel: c.hotel, board: o.code }); });
        node.appendChild(b); btns.push([b, o]);
      });
      c._boardCtrls = (c._boardCtrls || []).concat(function (b) {
        btns.forEach(function (pair) { var on = b && pair[1].code === b.code; pair[0].classList.toggle('on', on); pair[0].setAttribute('aria-checked', String(on)); });
      });
    }
    return node;
  }

  /* ---------- the details panel ----------
     Everything we know about one offer, beside the chat instead of inside
     it (Tomer, 10/09). Built fresh each time from the card the server sent —
     the widget invents nothing. */
  var sideFor = null;      // the card object the panel currently shows
  function openSide(c, cardEl) {
    sideFor = c;
    side.innerHTML = '';
    var over = window.innerWidth < 900 || win.classList.contains('max');
    side.classList.toggle('over', over);
    var photos = (c.images && c.images.length ? c.images : (c.image ? [c.image] : []));

    var head = el('div', 'shead');
    var sx = el('button', 'sx', '✕');
    sx.type = 'button'; sx.setAttribute('aria-label', 'סגירת הפרטים');
    sx.addEventListener('click', closeSide);
    head.appendChild(el('div', 'stitle', shownName(c)));
    head.appendChild(sx);
    side.appendChild(head);

    var body = el('div', 'sbody');
    if (photos.length) {
      var g = el('div', 'sgal');
      var im = document.createElement('img'); im.src = photos[0]; im.alt = shownName(c); g.appendChild(im);
      im.addEventListener('error', function () { g.remove(); });
      if (c.tier_he) g.appendChild(el('span', 'tag tier', c.tier_he));
      if (photos.length > 1) {
        var at = 0;
        var count = el('div', 'galn', '1/' + photos.length);
        var dots = el('div', 'dots');
        var dot = [];
        for (var di = 0; di < Math.min(photos.length, 12); di++) { var d = el('i'); if (!di) d.className = 'on'; dots.appendChild(d); dot.push(d); }
        var go = function (n) {
          at = (n + photos.length) % photos.length;
          im.src = photos[at];
          count.textContent = (at + 1) + '/' + photos.length;
          dot.forEach(function (d, i) { d.classList.toggle('on', i === at); });
        };
        var arrow = function (pointsLeft, delta, label, cls) {
          var b = el('button', 'galb ' + cls);
          b.type = 'button'; b.setAttribute('aria-label', label);
          b.innerHTML = '<svg width="10" height="16" viewBox="0 0 9 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + (pointsLeft ? '<polyline points="7.5 1.5 1.5 7.5 7.5 13.5"/>' : '<polyline points="1.5 1.5 7.5 7.5 1.5 13.5"/>') + '</svg>';
          b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); go(at + delta); });
          return b;
        };
        // RTL: the arrow on the LEFT moves forward, the one on the RIGHT back —
        // both are real buttons on their own layer, nothing sits over them
        g.appendChild(arrow(true, 1, 'התמונה הבאה', 'next'));
        g.appendChild(arrow(false, -1, 'התמונה הקודמת', 'prev'));
        g.appendChild(count); g.appendChild(dots);
        // keyboard and a finger both page the gallery
        side.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowLeft') { go(at + 1); e.preventDefault(); }
          if (e.key === 'ArrowRight') { go(at - 1); e.preventDefault(); }
        });
        var tx = null;
        g.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; }, { passive: true });
        g.addEventListener('touchend', function (e) {
          if (tx == null) return;
          var dx = e.changedTouches[0].clientX - tx; tx = null;
          if (dx < -40) go(at + 1); else if (dx > 40) go(at - 1);
        }, { passive: true });
      }
      body.appendChild(g);
    }

    var top = el('div', 'sec');
    var nm = el('div', 'sname'); nm.appendChild(document.createTextNode(shownName(c)));
    if (c.rating_he) nm.appendChild(el('span', 'bscore', '★ ' + c.rating_he.replace(' כוכבים', '')));
    top.appendChild(nm);
    top.appendChild(el('div', 'swhere', (c.resort ? c.resort + ' · ' : '') + c.country_he));
    if (c.highlight_he) {
      var shl = el('div', 'shl');
      shl.appendChild(el('span', 'tag hl', c.highlight_he));
      shl.appendChild(el('span', '', c.highlight_long_he || ''));
      top.appendChild(shl);
    }
    body.appendChild(top);

    var facts = el('div', 'sec');
    var grid = el('div', 'sfacts');
    var tile = function (k, v) { var t = el('div', 'ft'); t.appendChild(el('div', 'fk', k)); t.appendChild(el('div', 'fv', v)); grid.appendChild(t); };
    tile('יציאה', fmtDate(c.date, c.date_label, true).replace(/^יום /, ''));
    tile('לילות', String(c.nights));
    tile('חדר', c.room || '—');
    tile('טווח מחיר', c.price_range || 'נציג יאשר');
    facts.appendChild(grid);
    body.appendChild(facts);

    // the board: a choice when the hotel sells more than one
    var bc = boardControl(c, 'segment');
    if (bc) {
      var bsec = el('div', 'sec');
      bsec.appendChild(el('div', 'slab', 'בסיס אירוח'));
      bsec.appendChild(bc);
      if ((c.board_options || []).length > 1) bsec.appendChild(el('div', 'snote', 'הבחירה עוברת לטופס ההזמנה; המחיר המדויק לכל בסיס מופיע שם.'));
      body.appendChild(bsec);
    }

    // answers to what THIS customer asked (beds, board, ski pass…)
    if (c.facts_he && c.facts_he.length) {
      var fs = el('div', 'sec');
      fs.appendChild(el('div', 'slab', 'מה ששאלתם'));
      c.facts_he.forEach(function (f) { fs.appendChild(el('div', 'stxt', f)); });
      body.appendChild(fs);
    }
    if (c.why_he) { var w = el('div', 'sec'); w.appendChild(el('div', 'stxt', c.why_he)); body.appendChild(w); }

    var tagSec = el('div', 'sec'); var tags = el('div', 'tags');
    if (c.recommended) tags.appendChild(el('span', 'tag rec', 'מומלץ'));
    if (c.rooms_left_he) tags.appendChild(el('span', 'tag left', c.rooms_left_he));
    if (c.camps && c.camps.running && c.camps.running.length) {
      tags.appendChild(el('span', 'tag', 'קייטנה בעברית'));
      if (!c.camps.full) tags.appendChild(el('span', 'tag warn', 'קייטנה חלקית — ראו פירוט'));
    }
    if (c.occ_unverified) tags.appendChild(el('span', 'tag warn', 'ההרכב יאומת מול נציג'));
    (c.tags || []).forEach(function (tg) { if (tg) tags.appendChild(el('span', 'tag amen', tg)); });
    if (tags.childNodes.length) { tagSec.appendChild(tags); body.appendChild(tagSec); }

    // the room, as the hotel page describes it
    var rf = c.room_facts || {};
    if (rf.size_he || rf.beds_he || rf.bath_he || rf.occupancy_he || c.occ_composition_he) {
      var rs = el('div', 'sec');
      rs.appendChild(el('div', 'slab', 'החדר: ' + c.room));
      var line = function (label, val) { if (!val) return; var r = el('div', 'srow'); r.appendChild(el('span', 'rlab', label)); r.appendChild(el('span', 'rval', val)); rs.appendChild(r); };
      if (rf.name && rf.name !== c.room) line('שם החדר באתר', rf.name);
      line('גודל', rf.size_he); line('מיטות', rf.beds_he); line('רחצה', rf.bath_he);
      line('תפוסה', rf.occupancy_he || c.occ_composition_he);
      if (c.occ && c.occ.max != null) line('מתאים ל', c.occ.max + ' נוסעים');
      if (rf.exact === false) rs.appendChild(el('div', 'snote', 'הפרטים משותפים לכל חדרי המלון — נציג יאמת את החדר המדויק.'));
      body.appendChild(rs);
    }

    if (c.package_includes_he) {
      var inc = el('div', 'sec');
      inc.appendChild(el('div', 'slab', 'החבילה כוללת'));
      inc.appendChild(el('div', 'stxt', c.package_includes_he));
      body.appendChild(inc);
    }
    // what the hotel page says about the stay — only what it actually says
    var more = el('div', 'sec'); var any = false;
    var mline = function (label, val) { if (!val) return; any = true; var r = el('div', 'srow'); r.appendChild(el('span', 'rlab', label)); r.appendChild(el('span', 'rval', val)); more.appendChild(r); };
    more.appendChild(el('div', 'slab', 'עוד על החופשה'));
    mline('העברות', c.transfer_he); mline('סקי פס', c.ski_pass_he); mline('ציוד', c.equipment_he);
    mline('אינטרנט', c.wifi_he); mline('ספא', c.spa_access_he || c.spa_he); mline('מעלית', c.lift_he);
    if (any) body.appendChild(more);
    if (c.desc_he) { var ds = el('div', 'sec'); ds.appendChild(el('div', 'slab', 'על המלון')); ds.appendChild(el('div', 'stxt', c.desc_he)); body.appendChild(ds); }
    side.appendChild(body);

    var foot = el('div', 'sfoot');
    var b1 = el('button', 'btn sec', 'תחזרו אליי');
    b1.type = 'button';
    b1.addEventListener('click', function () { track('lead_form_open', { where: 'side', hotel: c.hotel, cid: cid() }); closeSide(); openLeadForm(c); });
    foot.appendChild(b1);
    if (c.booking_url) {
      var b2 = el('button', 'btn pri', 'המשך להזמנה');
      b2.type = 'button';
      b2.addEventListener('click', function () {
        track('booking_click', { hotel: c.hotel, resort: c.resort, date: c.date, nights: c.nights, board: c._board || null, where: 'side', cid: cid() });
        window.open(c.booking_url, '_blank', 'noopener');
      });
      foot.appendChild(b2);
    }
    side.appendChild(foot);

    side.classList.add('on');
    var sel = msgs.querySelectorAll('.card.sel');
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove('sel');
    if (cardEl) cardEl.classList.add('sel');
    body.scrollTop = 0;
    sx.focus();
    track('card_expand', { hotel: c.hotel, open: true, where: 'side', cid: cid() });
  }
  function closeSide() {
    if (!side.classList.contains('on')) return;
    side.classList.remove('on');
    var sel = msgs.querySelectorAll('.card.sel');
    for (var i = 0; i < sel.length; i++) sel[i].classList.remove('sel');
    var was = sideFor; sideFor = null;
    // hand focus back to the card's own button, so a keyboard user is not lost
    try { var d = msgs.querySelector('.card .dtog'); if (was && d) d.focus(); } catch (e) { }
  }
  side.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeSide(); } });
  window.addEventListener('resize', function () {
    if (side.classList.contains('on')) side.classList.toggle('over', window.innerWidth < 900 || win.classList.contains('max'));
  });

  /* ---------- hotel card ----------
     Structure asked for by Tomer, 24/08: gallery with arrows, hotel name with
     its country, labelled departure date and nights, the room as a control
     that opens what the hotel page says about it, the hotel blurb, the price
     band, and who it fits. Every value comes from the card the server sent —
     the widget invents nothing. */
  function addCard(c, container) {
    var card = el('div', 'card');
    if (c._board) { c._boardCtrls = []; setBoard(c, c._board); }
    var photos = (c.images && c.images.length ? c.images : (c.image ? [c.image] : []));
    // the offer IS the photograph, unless there is no photograph
    var asPhoto = CARD_STYLE === 'photo' && photos.length > 0;
    if (asPhoto) card.classList.add('pbg');
    var showPhoto = function (i) {
      if (asPhoto) card.style.backgroundImage = 'url("' + String(photos[i]).replace(/"/g, '%22') + '")';
    };
    showPhoto(0);

    // ---- gallery: the hotel's own photos, paged with two arrows. On a photo
    // card the arrows sit over the whole card and change its background; on the
    // plain one they page the strip at the top. Same code, same index.
    if (photos.length) {
      var gal = el('div', 'gal');
      var im = document.createElement('img');
      im.className = 'photo';
      im.src = photos[0];
      im.alt = shownName(c);
      im.loading = 'lazy';
      im.addEventListener('error', function () {
        // a photo we cannot load must not leave a grey rectangle where the
        // offer should be — fall back to the readable white card
        gal.remove();
        if (asPhoto) { asPhoto = false; card.classList.remove('pbg'); card.style.backgroundImage = ''; }
      });
      gal.appendChild(im);
      if (photos.length > 1) {
        var at = 0;
        var count = el('div', 'galn', '1/' + photos.length);
        gal.setAttribute('data-many', '1');
        var step = function (d) {
          return function (ev) {
            ev.stopPropagation();
            at = (at + d + photos.length) % photos.length;
            im.src = photos[at];
            showPhoto(at);
            count.textContent = (at + 1) + '/' + photos.length;
          };
        };
        // Chevrons drawn as SVG, not written as the characters U+2039/U+203A:
        // those carry the Bidi_Mirrored property, so inside an RTL container the
        // browser flips them and both arrows end up pointing outwards. The DOM
        // was right and the screen was wrong.
        var chevron = function (pointsLeft) {
          var b = el('button', 'galb');
          b.innerHTML = '<svg width="9" height="15" viewBox="0 0 9 15" fill="none" stroke="currentColor"'
            + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + (pointsLeft ? '<polyline points="7.5 1.5 1.5 7.5 7.5 13.5"/>'
                          : '<polyline points="1.5 1.5 7.5 7.5 1.5 13.5"/>') + '</svg>';
          return b;
        };
        // RTL: the chevron on the LEFT is the one that moves forward
        var prev = chevron(true);
        prev.className = 'galb next';
        prev.setAttribute('aria-label', 'התמונה הבאה');
        prev.addEventListener('click', step(1));
        var next = chevron(false);
        next.className = 'galb prev';
        next.setAttribute('aria-label', 'התמונה הקודמת');
        next.addEventListener('click', step(-1));
        gal.appendChild(prev); gal.appendChild(next); gal.appendChild(count);
      }
      if (c.tier_he) gal.appendChild(el('span', 'tag tier', c.tier_he));
      card.appendChild(gal);
    }

    // ---- name, with the country beside it
    var head = el('div', 'chead');
    head.appendChild(el('div', 'hname', shownName(c)));
    // "★ 4 כוכבים · 8.5 בבוקינג" — רק כשיש נתון מאומת (rating_he מהשרת);
    // מלון בלי דירוג פשוט לא מציג את השורה
    if (c.rating_he) head.appendChild(el('div', 'hrating', '★ ' + c.rating_he));
    head.appendChild(el('div', 'cwhere', c.country_he + (c.resort ? ' · ' + c.resort : '')));
    card.appendChild(head);

    // The closed card's whole body: when, how long, which room. Everything the
    // customer needs to tell three offers apart, on one line.
    var brief = el('div', 'brief');
    brief.appendChild(el('b', '', fmtDate(c.date, c.date_label, true)));
    brief.appendChild(el('span', 'sep', '·'));
    brief.appendChild(el('span', '', c.nights + ' לילות'));
    if (c.room) {
      brief.appendChild(el('span', 'sep', '·'));
      brief.appendChild(el('span', '', c.room));
    }
    if (c.price_range) {
      // Both are drawn and CSS shows one: inline in the sentence on the white
      // card, a badge in the corner on the photo card. Deciding here in JS was
      // wrong — a photo that fails to load flips the card back to white AFTER
      // this runs, and the badge stayed, in the flow, 19px tall.
      //
      // The badge is a direct child of the card because
      // `.card.pbg > *{position:relative}` makes this line a containing block,
      // and an absolute badge inside it positioned against the line instead.
      brief.appendChild(el('span', 'sep bsep', '·'));
      brief.appendChild(el('span', 'bprice', c.price_range));
    }
    // The badges live together in the one corner the card has free. The tier
    // used to sit at the top start, straight on top of the resort and the
    // hotel name (Tomer, 26/08). Always built, shown by CSS only on a photo
    // card — deciding in JS breaks when a failed photo flips the card back.
    var topbar = el('div', 'topbar');
    if (c.tier_he) topbar.appendChild(el('span', 'tag tier', c.tier_he));
    if (c.price_range) topbar.appendChild(el('span', 'bprice corner', c.price_range));
    if (topbar.childNodes.length) card.appendChild(topbar);
    card.appendChild(brief);

    /* ---- Tomer's pick (06/09, option י): a navy band with the name, the
       place and the rating right under the photograph, then four tiles —
       יציאה · לילות · חדר · מחיר. Built for the white card only; the photo
       card keeps its scrim. head/brief stay in the DOM (the open card and the
       photo card use them) and CSS hides them under the band. */
    var asRow = !asPhoto && CARD_STYLE === 'row';
    if (asRow) {
      /* ---- the row card (Tomer, 10/09): what Booking's list does on a phone.
         Closed: a thumbnail at the start, the name, the place, one line of
         when/how long/which room, the price band — and one row of actions.
         Everything else (the full photograph, the room facts, what the
         package includes, the tags) opens under "עוד פרטים". */
      card.classList.add('r');
      var rhead = el('div', 'rhead');
      if (photos.length) {
        var th = document.createElement('img');
        th.className = 'thumb'; th.src = photos[0]; th.alt = ''; th.loading = 'lazy';
        th.addEventListener('error', function () { th.remove(); });
        rhead.appendChild(th);
      }
      var rmain = el('div', 'rmain');
      var rtop = el('div', 'rtop');
      rtop.appendChild(el('div', 'hname', shownName(c)));
      if (c.rating_he) rtop.appendChild(el('span', 'bscore', '★ ' + c.rating_he.replace(' כוכבים', '')));
      rmain.appendChild(rtop);
      rmain.appendChild(el('div', 'rwhere', (c.resort ? c.resort + ' · ' : '') + c.country_he));
      var rd = new Date(c.date + 'T00:00:00');
      var rdays = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
      var rline = el('div', 'rline');
      rline.appendChild(el('b', '', 'יום ' + rdays[rd.getDay()] + ' ' + rd.getDate() + '.' + (rd.getMonth() + 1)));
      rline.appendChild(el('span', 'sep', '·'));
      rline.appendChild(el('span', '', c.nights + ' לילות'));
      if (c.room) { rline.appendChild(el('span', 'sep', '·')); rline.appendChild(el('span', 'rroom', c.room)); }
      rmain.appendChild(rline);
      var rmeta = el('div', 'rmeta');
      rmeta.appendChild(el('span', 'rprice', c.price_range || 'מחיר: נציג יאשר'));
      // the board, chosen here or in the panel — the two stay in step
      var rb = boardControl(c, 'select');
      // the chain's sales point stands in for a single-board fact: "קלאב
      // הכל כלול" says more than "הכל כלול" (Tomer, 13/09)
      var hlOnly = c.highlight_he && !(rb && rb.tagName === 'SELECT');
      if (rb && !hlOnly) { rmeta.appendChild(el('span', 'sep', '·')); rmeta.appendChild(rb); }
      if (c.highlight_he) { rmeta.appendChild(el('span', 'sep', '·')); rmeta.appendChild(el('span', 'tag hl', c.highlight_he)); }
      // one flag at most beside the price — the row must stay a row
      if (c.highlight_he) { /* the highlight is the flag */ }
      else if (c.rooms_left_he) rmeta.appendChild(el('span', 'tag left', 'נשאר חדר אחד'));
      else if (c.tier_he) rmeta.appendChild(el('span', 'tag tier', c.tier_he));
      else if (c.recommended) rmeta.appendChild(el('span', 'tag rec', 'מומלץ'));
      rmain.appendChild(rmeta);
      rhead.appendChild(rmain);
      card.insertBefore(rhead, card.firstChild);
    }
    if (!asPhoto && !asRow) {
      card.classList.add('j');
      var band = el('div', 'band');
      var bandTxt = el('div', 'btxt');
      bandTxt.appendChild(el('div', 'bname', shownName(c)));
      bandTxt.appendChild(el('div', 'bwhere', (c.resort ? c.resort + ' · ' : '') + c.country_he));
      band.appendChild(bandTxt);
      if (c.rating_he) band.appendChild(el('span', 'bscore', '★ ' + c.rating_he.replace(' כוכבים', '')));
      var tiles = el('div', 'facts4');
      var tile = function (k, v) {
        var t = el('div', 'ft');
        t.appendChild(el('div', 'fk', k)); t.appendChild(el('div', 'fv', v));
        tiles.appendChild(t);
      };
      var dd = new Date(c.date + 'T00:00:00');
      var days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
      tile('יציאה', days[dd.getDay()] + ' ' + dd.getDate() + '.' + (dd.getMonth() + 1) + (c.date_label ? ' · ' + c.date_label : ''));
      tile('לילות', String(c.nights));
      tile('חדר', c.room || '—');
      tile('מחיר', c.price_range || 'נציג יאשר');
      // the band goes straight under the gallery; the tiles where the brief was
      if (card.querySelector('.gal')) card.querySelector('.gal').insertAdjacentElement('afterend', band);
      else card.insertBefore(band, card.firstChild);
      brief.insertAdjacentElement('afterend', tiles);
    }

    var rows = el('div', 'rows');
    var row = function (label, value, node) {
      var r = el('div', 'row');
      r.appendChild(el('span', 'rlab', label));
      if (node) r.appendChild(node); else r.appendChild(el('span', 'rval', value));
      rows.appendChild(r);
      return r;
    };

    row('תאריך יציאה', fmtDate(c.date, c.date_label, true) + ' · ' + c.nights + ' לילות');

    // ---- the room opens what the hotel page says about it
    var rf = c.room_facts || {};
    var hasRoomInfo = rf.size_he || rf.beds_he || rf.bath_he || rf.occupancy_he || c.occ_composition_he;
    if (hasRoomInfo) {
      var btn = el('button', 'rlink', c.room + ' ▾');
      btn.setAttribute('aria-expanded', 'false');
      var panel = el('div', 'rpanel');
      var line = function (label, val) {
        if (!val) return;
        var d = el('div', 'rline');
        d.appendChild(el('span', 'rlab', label));
        d.appendChild(el('span', 'rval', val));
        panel.appendChild(d);
      };
      if (rf.name && rf.name !== c.room) line('שם החדר', rf.name);
      line('גודל', rf.size_he);
      line('מיטות', rf.beds_he);
      line('רחצה', rf.bath_he);
      line('תפוסה', rf.occupancy_he || c.occ_composition_he);
      if (rf.exact === false) panel.appendChild(el('div', 'rnote', 'הפרטים משותפים לכל חדרי המלון — נציג יאמת את החדר המדויק.'));
      panel.style.display = 'none';
      btn.addEventListener('click', function () {
        var open = panel.style.display === 'none';
        panel.style.display = open ? 'flex' : 'none';
        btn.textContent = c.room + (open ? ' ▴' : ' ▾');
        btn.setAttribute('aria-expanded', String(open));
      });
      row('חדר במלון', null, btn);
      rows.appendChild(panel);
    } else {
      row('חדר במלון', c.room);
    }
    card.appendChild(rows);

    // ---- the fold: what helps to CHOOSE stays visible (date, room, price,
    // answers to what the customer asked); what helps to DECIDE LATER (what the
    // package includes, the hotel blurb, lift distance) opens on one click.
    // Three cards used to run past the bottom of a laptop screen.
    var details = el('div', 'details');

    // What this package includes, straight from the hotel page. Clamped to
    // three lines because some run to a paragraph; the whole thing opens on a
    // click, the same disclosure the room row uses.
    if (c.package_includes_he) {
      var inc = el('div', 'inc');
      inc.appendChild(el('span', 'ilab', 'החבילה כוללת'));
      var itxt = el('div', 'itxt clamp3', c.package_includes_he);
      inc.appendChild(itxt);
      if (c.package_includes_he.length > 110) {
        var more = el('button', 'imore', 'עוד');
        more.addEventListener('click', function () {
          var open = itxt.classList.toggle('clamp3');
          more.textContent = open ? 'עוד' : 'פחות';
        });
        itxt.classList.add('clamp3');
        inc.appendChild(more);
      }
      details.appendChild(inc);
    }

    if (c.desc_he) details.appendChild(el('div', 'cdesc', c.desc_he));
    if (c.lift_he) details.appendChild(el('div', 'meta', 'מעלית: ' + c.lift_he));
    // One toggle for the whole card, not one per section. Closed it is the
    // hotel, one line and the button; open it is everything we know.
    var dtog = el('button', 'dtog', 'עוד פרטים ▾');
    dtog.type = 'button';
    dtog.setAttribute('aria-expanded', 'false');
    dtog.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      // the row card opens its details in the panel beside the chat, not inline
      if (card.classList.contains('r')) { openSide(c, card); return; }
      var open = card.classList.toggle('open');
      dtog.textContent = open ? 'פחות פרטים ▴' : 'עוד פרטים ▾';
      dtog.setAttribute('aria-expanded', String(open));
      track('card_expand', { hotel: c.hotel, open: open, cid: cid() });
      // Opening a card adds a screenful of text below the fold, and the
      // customer had to scroll to read what they just asked for (Tomer,
      // 26/08). Bring the card to the top of the panel instead — the details
      // are then the first thing under their thumb, not the last.
      if (!open) return;
      try {
        var pane = card.closest ? card.closest('.msgs') : null;
        if (!pane) return;
        // Tomer, 06/09: opening used to fling the card to the top of the
        // panel. Now the view moves only as far as it must for the opened
        // section to be seen — and never past the top of the card.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            var det = card.querySelector('.details') || card;
            var db = det.getBoundingClientRect(), cb = card.getBoundingClientRect(), pb = pane.getBoundingClientRect();
            var overflow = db.bottom - pb.bottom + 12;          // how much of the details is below the fold
            var roomAbove = Math.max(0, cb.top - pb.top - 8);   // how far we may go before the card's top leaves the view
            var by = Math.min(Math.max(0, overflow), roomAbove);
            if (by > 2) pane.scrollBy({ top: by, behavior: 'smooth' });
          });
        });
      } catch (e) { /* a card that will not scroll is still a card that opened */ }
    });
    card.appendChild(dtog);
    if (details.childNodes.length) card.appendChild(details);

    // answers to what THIS customer asked about (beds, board, ski pass, ...)
    if (c.facts_he && c.facts_he.length) {
      var facts = el('div', 'facts');
      for (var fi = 0; fi < c.facts_he.length; fi++) facts.appendChild(el('div', '', c.facts_he[fi]));
      card.appendChild(facts);
    }

    var tags = el('div', 'tags');
    if (c.highlight_he) tags.appendChild(el('span', 'tag hl', c.highlight_he));
    if (c.tier_he && !photos.length) tags.appendChild(el('span', 'tag tier', c.tier_he));
    if (c.recommended) tags.appendChild(el('span', 'tag rec', 'מומלץ'));
    if (c.rooms_left_he) tags.appendChild(el('span', 'tag left', c.rooms_left_he));
    if (c.camps && c.camps.running && c.camps.running.length) {
      tags.appendChild(el('span', 'tag', 'קייטנה בעברית'));
      if (!c.camps.full) tags.appendChild(el('span', 'tag warn', 'קייטנה חלקית — ראו פירוט'));
    }
    if (c.occ_unverified) tags.appendChild(el('span', 'tag warn', 'ההרכב יאומת מול נציג'));
    // the hotel's own tags from the pages (ספא, קרוב למסלולים, הכל כלול…) —
    // up to three on the closed card, the rest under "עוד פרטים"
    (c.tags || []).slice(0, 3).forEach(function (tg) { if (tg && tg.length <= 18) tags.appendChild(el('span', 'tag amen', tg)); });
    if (tags.childNodes.length) card.appendChild(tags);

    var foot = el('div', 'cfoot');
    // A hotel with no classified price band shows no band. It used to show the
    // TODO default from pricing.json as though it were data, and a missing
    // field would have printed the word "undefined" to a customer.
    if (c.price_range) foot.appendChild(el('div', 'price', 'טווח מחיר: ' + c.price_range));
    // "מתאים ל-4 נוסעים" already opens the why-line on most cards — once is enough
    if (c.occ && c.occ.max != null && !(c.why_he && c.why_he.indexOf('מתאים ל-') === 0)) {
      foot.appendChild(el('div', 'fits', 'מתאים ל-' + c.occ.max + ' נוסעים'));
    }
    card.appendChild(foot);

    if (c.why_he) card.appendChild(el('div', 'why clamp', c.why_he));

    var btns = el('div', 'btns');
    var b1 = el('button', 'btn sec', 'תחזרו אליי');
    b1.title = 'תחזרו אליי עם פרטים על ההצעה הזו';
    b1.addEventListener('click', function () {
      track('lead_form_open', { where: 'card', hotel: c.hotel, cid: cid() });
      openLeadForm(c);
    });
    btns.appendChild(b1);
    if (c.booking_url) {
      var b2 = el('button', 'btn pri', 'המשך להזמנה');
      b2.addEventListener('click', function () {
        // THE conversion event. Without it there is no way to show that the
        // bot pays for itself — every other number is activity, not outcome.
        track('booking_click', { hotel: c.hotel, resort: c.resort, date: c.date, nights: c.nights, board: c._board || null, cid: cid() });
        window.open(c.booking_url, '_blank', 'noopener');
      });
      btns.appendChild(b2);
    }
    if (card.classList.contains('r')) {
      var rfoot = el('div', 'rfoot');
      rfoot.appendChild(dtog); rfoot.appendChild(btns);
      card.appendChild(rfoot);
    } else card.appendChild(btns);
    (container || msgs).appendChild(card);
    if (!container) scrollDown();
  }

  function addChips(labels) {
    // only the newest row of suggestions is live; older ones are history and
    // tapping them would answer a question that has moved on
    var old = msgs.querySelectorAll('.chips');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var box = el('div', 'chips');
    // two rows of chips is a menu, not a nudge — the first ten carry the intent
    labels = labels.slice(0, 10);
    labels.forEach(function (l) {
      var ch = el('button', 'chip', l);
      ch.addEventListener('click', function () { sendText(l); });
      box.appendChild(ch);
    });
    msgs.appendChild(box);
    // Mark the row when it really does overflow, so the fade only appears when
    // there is something past the edge. Mouse-only users had no sign at all
    // that chips 5-10 existed: the scrollbar is hidden on both engines.
    var markOverflow = function () {
      if (!box.isConnected) return;
      box.classList.toggle('more', box.scrollWidth - box.clientWidth > 4);
    };
    markOverflow();
    setTimeout(markOverflow, 60);            // after fonts settle
    box.addEventListener('scroll', function () {
      box.classList.toggle('more', box.scrollWidth - box.clientWidth - box.scrollLeft > 4);
    });
    state.log.push({ t: 'chips', v: labels });
  }
  function addCardsRow(cards) {
    // 10/09: the window stays its opening size. Row cards stack under each
    // other and read fine at 460px; the 1100px expansion covered the site
    // and felt like a full-screen takeover (Tomer, twice). The header's
    // expand button is still there for whoever wants the room.
    if (CARD_STYLE !== 'row') { win.classList.add('big'); if (cards.length > 2) win.classList.add('wide'); }
    var row = el('div', 'cards-row');
    msgs.appendChild(row);
    cards.forEach(function (c) { addCard(c, row); });
    state.lastCards = cards;
    return row;
  }
  /* The third offer, one tap away (Tomer, 06/09: two on screen, three on
     request). The card is already here — no round trip — and the server is
     told it was shown, so "יש עוד?" brings something new. Logged into the
     same cards entry, so a restored chat shows what the customer saw. */
  function addSpareButton(row, spare, logEntry) {
    if (!spare || !spare.length) return null;
    var b = el('button', 'more-opt', '+ עוד אפשרות');
    b.setAttribute('aria-label', 'הצגת אפשרות נוספת');
    row.insertAdjacentElement('afterend', b);
    b.addEventListener('click', function () {
      b.remove();
      spare.forEach(function (c) { addCard(c, row); });
      if (CARD_STYLE !== 'row') win.classList.add('wide');
      state.lastCards = (state.lastCards || []).concat(spare);
      if (logEntry) logEntry.v = (logEntry.v || []).concat(spare);
      state.slots = state.slots || {};
      state.slots._shown = (state.slots._shown || []).concat(spare.map(function (c) { return c.hotel + '|' + c.date; })).slice(-30);
      state.messages.push({ role: 'assistant', content: '[הוצגו עוד ' + spare.length + ' הצעות: ' + spare.map(function (c) { return c.hotel + ' ' + c.date; }).join(', ') + ']' });
      track('more_option', { count: spare.length });
      persist();
      scrollToTopOf(row);
    });
    return b;
  }
  // replay a saved conversation after the page changed under us
  function replay(d) {
    state.messages = d.messages; state.slots = d.slots || {}; state.booted = !!d.booted;
    state.log = [];
    (d.log || []).forEach(function (e) {
      if (e.t === 'user') addMsg('user', e.v, false, e.at);
      else if (e.t === 'bot') addMsg('bot', e.v, false, e.at);
      else if (e.t === 'cards') { addCardsRow(e.v); state.log.push(e); }
      else if (e.t === 'chips') addChips(e.v);
      else if (e.t === 'status') addStatus(e.v);
    });
    if (d.lastCards) state.lastCards = d.lastCards;
    updateCid();                          // a resumed conversation keeps its id
    // chips of a finished turn are still live — the customer may pick up where they left
    scrollDown();
  }

  // three offers on screen and a typed "תחזרו אליי": ask which one, so the
  // rep calls about a hotel and not about "no specific offer"
  function openLeadPicker(cards) {
    var old = msgs.querySelectorAll('.chips');
    for (var i = 0; i < old.length; i++) old[i].remove();
    addMsg('bot', 'על איזו מההצעות תרצו שנציג יחזור אליכם?');
    var box = el('div', 'chips');
    cards.forEach(function (c) {
      var ch = el('button', 'chip', iso(shownName(c)) + ' · ' + fmtDate(c.date, c.date_label));
      ch.addEventListener('click', function () { box.remove(); openLeadForm(c); });
      box.appendChild(ch);
    });
    var any = el('button', 'chip', 'לא משנה, שיחזרו אליי');
    any.addEventListener('click', function () { box.remove(); openLeadForm(null); });
    box.appendChild(any);
    msgs.appendChild(box); scrollDown();
  }

  /* lead form — שם + טלפון בלבד (חוק אדום 8) */
  // `card` is optional: someone who simply types "תחזרו אליי" has not picked an
  // offer yet, and should still get the form rather than a pointer to a button.
  function openLeadForm(card, opts) {
    opts = opts || {};
    // one open form at a time — pressing "תחזרו אליי" twice stacked two forms
    var prev = msgs.querySelectorAll('.form');
    for (var pi = 0; pi < prev.length; pi++) prev[pi].remove();
    var f = document.createElement('form'); f.className = 'form';
    f.setAttribute('novalidate', '');
    if (card) {
      f.appendChild(el('div', 'ftitle', 'נציג יחזור אליכם על: ' + iso(shownName(card))));
      f.appendChild(el('div', 'note', fmtDate(card.date, card.date_label) + ' · ' + card.nights + ' לילות · ' + card.room));
    } else {
      f.appendChild(el('div', 'ftitle', 'נציג יחזור אליכם'));
      f.appendChild(el('div', 'note', 'השאירו שם וטלפון ונציג פינגווין יחזור אליכם.'));
    }
    var leadKind = opts.kind || (state.slots && state.slots._lead_kind) || 'customer';
    /* A customer who wrote in English got a correct English reply and then a
       form that was entirely in Hebrew — labels, consent line, and the
       validation errors telling them why it was rejected. lead_kind carries
       the language ("language_en"), so the form follows it. Hebrew stays the
       default and the fallback for every string a translation is missing. */
    var langCode = /^language_([a-z]{2})$/.exec(leadKind);
    var L = (langCode && CONFIG.lead_form && CONFIG.lead_form[langCode[1]]) || {};
    var lang = function (k, he) { return L[k] || he; };
    if (langCode) f.setAttribute('dir', langCode[1] === 'ar' ? 'rtl' : 'ltr');

    var lName = el('label', null, lang('name', 'שם')); var iName = document.createElement('input');
    iName.setAttribute('aria-label', lang('name', 'שם')); iName.name = 'name'; iName.autocomplete = 'name'; lName.htmlFor = iName.id = 'pw-lead-name';
    if (opts.prefill && opts.prefill.name) iName.value = opts.prefill.name;
    var lPhone = el('label', null, lang('phone', 'טלפון')); var iPhone = document.createElement('input');
    if (opts.prefill && opts.prefill.phone) iPhone.value = opts.prefill.phone;
    iPhone.type = 'tel'; iPhone.dir = 'ltr'; iPhone.setAttribute('aria-label', lang('phone', 'טלפון')); iPhone.name = 'phone'; iPhone.autocomplete = 'tel'; iPhone.inputMode = 'tel'; lPhone.htmlFor = iPhone.id = 'pw-lead-phone';
    // Optional, and said plainly why: the customer who wants the offer in
    // writing is the customer who is showing it to somebody else tonight.
    var lMail = el('label', null, lang('email', 'מייל (לא חובה — לקבלת ההצעה בכתב)'));
    var iMail = document.createElement('input');
    iMail.type = 'email'; iMail.setAttribute('aria-label', 'מייל לקבלת ההצעה'); iMail.name = 'email';
    iMail.autocomplete = 'email'; iMail.inputMode = 'email'; iMail.dir = 'ltr';
    lMail.htmlFor = iMail.id = 'pw-lead-email';
    if (opts.prefill && opts.prefill.email) iMail.value = opts.prefill.email;
    var go = el('button', 'btn pri', lang('send', 'שלחו לנציג')); go.type = 'submit';
    var note = el('div', 'note', 'רק שם וטלפון — בלי התחייבות. ההזמנה סופית רק אחרי אישור נציג ומייל עם קבלה.');
    // consent (Tomer, q30; Privacy Protection Law amendment 13): an unticked
    // box the customer must tick, next to a link to Pingwin's privacy policy
    var consent = el('label', 'consent');
    var iConsent = document.createElement('input'); iConsent.type = 'checkbox'; iConsent.id = 'pw-lead-consent'; iConsent.name = 'consent';
    consent.htmlFor = iConsent.id;
    consent.appendChild(iConsent);
    var cTxt = el('span', null, L.consent
      ? L.consent + ' '
      : 'אני מאשר/ת שפינגווין תשמור את הפרטים ותיצור איתי קשר בנוגע לפנייה זו, בהתאם ל');
    var cLink = document.createElement('a'); cLink.href = THEME.privacyUrl; cLink.target = '_blank'; cLink.rel = 'noopener';
    cLink.textContent = L.consent ? 'privacy policy' : 'מדיניות הפרטיות';
    cTxt.appendChild(cLink); cTxt.appendChild(document.createTextNode('.'));
    consent.appendChild(cTxt);
    f.appendChild(lName); f.appendChild(iName);
    f.appendChild(lPhone); f.appendChild(iPhone);
    f.appendChild(lMail); f.appendChild(iMail);
    f.appendChild(consent);
    f.appendChild(note); f.appendChild(go);
    msgs.appendChild(f); scrollDown();
    /* Errors are SAID, not whispered: the note goes red and bold, the field is
       marked aria-invalid, and a screen reader hears it (role=alert). The
       reassuring default text comes back the moment the problem is fixed —
       the old code destroyed it permanently on the first slip. */
    var noteDefault = note.textContent;
    var complain = function (msg, field) {
      note.textContent = msg;
      note.classList.add('err');
      note.setAttribute('role', 'alert');
      if (field && field.setAttribute) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
    };
    var calm = function () {
      note.classList.remove('err');
      note.removeAttribute('role');
      [iName, iPhone, iMail].forEach(function (i) { i.removeAttribute('aria-invalid'); });
    };
    [iName, iPhone, iMail].forEach(function (i) {
      i.addEventListener('input', function () {
        if (note.classList.contains('err')) { calm(); note.textContent = noteDefault; }
      });
    });
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      calm();
      var nameVal = iName.value.trim();
      var phoneVal = iPhone.value.trim();
      if (!nameVal || !phoneVal) { complain(lang('err_required', 'נדרשים שם וטלפון ליצירת קשר.'), !nameVal ? iName : iPhone); return; }
      // a rep can do nothing with "אבג" — require a real Israeli-length number
      var digits = phoneVal.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) {
        complain(lang('err_phone', 'מספר הטלפון לא נראה תקין. לדוגמה: 050-1234567'), iPhone);
        return;
      }
      if (nameVal.length < 2) { complain('נשמח לשם מלא ליצירת קשר.', iName); return; }
      var mailVal = iMail.value.trim();
      if (mailVal && !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(mailVal)) {
        complain(lang('err_email', 'כתובת המייל לא נראית תקינה. אפשר גם להשאיר ריק.'), iMail); return;
      }
      if (!iConsent.checked) { complain(lang('err_consent', 'כדי שנוכל לחזור אליכם צריך לאשר את מדיניות הפרטיות (הסימון למטה).')); iConsent.focus(); return; }
      // Up to 27 seconds could pass here — Turnstile, then the request — and
      // the only sign was the button going pale. Customers tapped it again and
      // then closed the widget, at the highest-intent moment in the flow.
      go.disabled = true;
      var goLabel = go.textContent;
      go.textContent = lang('sending', 'שולח…');
      var restoreBtn = function () { go.disabled = false; go.textContent = goLabel; };
      turnstileToken().then(function (tok) { return fetchWithTimeout(API_BASE + '/api/lead', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: nameVal, phone: phoneVal, email: mailVal || null, turnstile: tok,
          context: {
            slots: state.slots ? { _cid: state.slots._cid, _vt: state.slots._vt } : null,
            hotel: card ? card.hotel : null, resort: card ? card.resort : null,
            date: card ? card.date : null, nights: card ? card.nights : null,
            room: card ? card.room : null,
            board: card && card._board_he ? card._board_he : null,
            party: state.slots ? { adults: state.slots.adults, children_ages: state.slots.children_ages } : null,
            // מה שהלקוח חיפש, בשדות מסודרים — כדי שה-CRM יוכל לסנן ולנתב לפי
            // חודש, יעד וקהל, ולא רק לקרוא תמליל. רשימה סגורה: שום שדה פנימי
            // (כל מה שמתחיל ב-_) לא יוצא מכאן. השרת מסנן שוב מצדו.
            request: leadRequest(),
            kind: leadKind,
            consent: { privacy: true, at: new Date().toISOString(), text: consent.textContent },
            conversation_id: state.slots ? state.slots._cid : null,
            // the rep should see what the customer asked, not only a hotel name
            transcript: state.messages.slice(-12).map(function (m) { return (m.role === 'user' ? 'לקוח: ' : 'בוט: ') + m.content; }).join('\n')
          }
        })
      }, 15000); }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j && j.ok !== false, j: j }; }); }).then(function (res) {
        // a 400 used to show "הפרטים התקבלו" — a lost lead disguised as success
        if (!res.ok) throw new Error('lead rejected');
        track('lead', { kind: leadKind || 'customer', has_offer: !!card });
        f.remove();
        // כמו אצל סאני: אומרים ללקוח שסיכום השיחה עובר לנציג — שלא יצטרך
        // לספר הכל מהתחלה בטלפון (ה-transcript כבר נשלח עם הליד)
        addMsg('bot', card
          ? 'הפרטים התקבלו, יחד עם סיכום מה שחיפשתם כאן — כך שלא תצטרכו לחזור על הכל. נציג פינגווין יחזור אליכם בהקדם בנוגע ל-' + iso(shownName(card)) + '.'
          : 'הפרטים התקבלו, יחד עם סיכום מה שחיפשתם כאן — כך שלא תצטרכו לחזור על הכל. נציג פינגווין יחזור אליכם בהקדם.');
      }).catch(function () {
        track('error', { where: 'lead' });
        restoreBtn(); complain(say('send_error', 'תקלה בשליחה — נסו שוב או חייגו {phone}'));
      });
    });
  }

  /* ============== chat flow ============== */
  function sendText(text) {
    text = (text || '').trim();
    if (!text || state.busy) return;
    // A turn is stamped, and a response whose stamp is stale is discarded.
    // "שיחה חדשה" mid-turn used to let the OLD conversation's reply, cards and
    // slots land in the fresh one — including its conversation id, which then
    // reappeared in the header.
    var gen = (state.gen = (state.gen || 0) + 1);
    var sentLogAt = state.log.length;
    var sentBubble = addMsg('user', text);
    state.messages.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto'; // shrink back after send
    state.busy = true; send.disabled = true; showTyping(true);
    // Last resort. Every path below settles, but "every path settles" was true
    // of the Turnstile loader too until it wasn't, and the cost of being wrong
    // is a widget locked with the dots spinning until the customer reloads.
    // This can only ever unlock it; a normal turn clears the timer first.
    var stuck = setTimeout(function () {
      if (!state.busy) return;
      state.busy = false; send.disabled = false; showTyping(false);
      addMsg('bot', say('chat_error', 'אירעה תקלה זמנית בתקשורת. נסו שוב בעוד רגע, או חייגו {phone}.'));
      scrollDown();
    }, 35000);

    // keep the typing indicator on screen long enough to be seen — offline
    // mode answers almost instantly, which otherwise feels like a jump cut
    var minWait = new Promise(function (res) { setTimeout(res, 650); });
    // the server reads the last 20 turns anyway; sending the whole history
    // grew past its 100KB body cap in long chats and killed every turn after
    state.turn = (state.turn || 0) + 1;
    track('message', { turn: state.turn });
    var call = configReady.then(function () { return needsToken() ? turnstileToken() : null; }).then(function (tok) {
      return fetchWithTimeout(API_BASE + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: state.messages.slice(-20), slots: state.slots, turnstile: tok })
      }, 28000);
    }).then(function (r) {
      if (r.ok) return r.json();
      // A non-200 that still carries a Hebrew reply IS the reply: 429 says
      // "slow down", 403 says "refresh the page and try again". Throwing on
      // everything but 429 meant the 403 line — the most actionable sentence
      // the server has — was never shown; the customer got the generic error
      // and a "נסו שוב" chip that could only fail the same way, while the
      // sentence that would have fixed it sat unread in the response.
      return r.json().then(function (j) {
        if (j && j.reply_he) {
          // keep our own conversation state on an error: the 403 body returns
          // slots without the conversation id, which would wipe the chat
          j.slots = (j.slots && j.slots._cid) ? j.slots : state.slots;
          j.no_retry = !!j.verify;      // retrying a failed verification cannot help
          return j;
        }
        throw new Error('http ' + r.status);
      }, function () { throw new Error('http ' + r.status); });
    });

    Promise.all([call, minWait]).then(function (both) {
      if (gen !== state.gen) return;          // a newer turn, or a reset, won
      var data = both[0];
      showTyping(false);
      state.slots = data.slots || state.slots;
      updateCid();
      // "חיפשתי במלאי לפי: ..." — הלקוח רואה שהבקשה שלו הובנה, לפני ההצעות
      if (data.search_echo_he && ((data.cards && data.cards.length) ||
          (data.two_room_splits && data.two_room_splits.length))) addStatus(data.search_echo_he);
      var introEl = null;
      // the closing sentence ("אם אחת מהן נראית לכם…") talks about the buttons —
      // so it goes under the cards, not above them
      var after = (data.cards && data.cards.length && data.after_cards_he) ? data.after_cards_he : null;
      var shown = data.reply_he;
      if (after && shown) shown = shown.split(after).join('').replace(/\n+$/, '').replace(/\n\n+/g, '\n');
      if (shown) {
        introEl = addMsg('bot', shown);
        // the server says when the moment deserves more than the small avatar
        if (data.mood === 'wave') introEl.classList.add('wave');
        // less text around the offers (Tomer, 10/09): above cards the intro
        // shows three lines; a really long answer elsewhere shows six
        var withCards = !!(data.cards && data.cards.length && !data.cards_unchanged);
        if (withCards ? shown.length > 160 : shown.length > 420) foldMsg(introEl, withCards);
        // the one thing a screen reader should hear on this turn
        announce(shown + (data.cards && data.cards.length && !data.cards_unchanged
          ? ' — ' + data.cards.length + ' הצעות' : ''));
        state.messages.push({ role: 'assistant', content: data.reply_he });
      }
      // The same three offers were re-drawn on every turn: a six-turn chat on a
      // phone was eighteen cards, fifteen of them duplicates, and the view
      // jumped to the newest copy each time — so every turn looked as though
      // the bot had answered by presenting the same hotels again. The server
      // says when the set has not changed; the cards stay where they are.
      if (data.cards && data.cards.length && data.cards_unchanged) {
        state.lastCards = data.cards;
      } else if (data.cards && data.cards.length) {
        track('offers', { count: data.cards.length });
        // three offers side by side, so the customer barely scrolls
        var row = addCardsRow(data.cards);
        var cardsEntry = { t: 'cards', v: data.cards };
        addSpareButton(row, data.spare_cards, cardsEntry);
        if (after) addMsg('bot', after).classList.add('after');
        state.log.push(cardsEntry);
        // park the view on the intro line + first card, not below them
        scrollToTopOf(introEl || row);
        state.messages.push({ role: 'assistant', content: '[הוצגו ' + data.cards.length + ' הצעות: ' + data.cards.map(function (c) { return c.hotel + ' ' + c.date; }).join(', ') + ']' });
      }
      if (data.two_room_splits && data.two_room_splits.length && !data.cards_unchanged &&
          (!data.cards || !data.cards.length)) {
        data.two_room_splits.slice(0, 3).forEach(function (s) {
          addMsg('bot', s.hotel + ' — ' + fmtDate(s.date) + ' · ' + s.nights + ' לילות\nשני חדרים: ' + s.rooms.join(' + ') +
            (s.price_range ? ' · ' + s.price_range : ''));
        });
      }
      // asked to be called back — open the form on the offer they were looking
      // at, or a blank one if they have not chosen yet
      // אגודלים מתחת לתשובה האחרונה — לא כשנפתח טופס ליד, שלא להסיח
      // 10/09 (Tomer): the thumbs under every answer are gone — "ילדותי ולא
      // מקצועי". /api/feedback stays on the server; FEEDBACK_THUMBS=1 on the
      // tag brings the row back for a test period.
      if (FEEDBACK_THUMBS && data.reply_he && !data.open_lead_form && !data.no_retry) addFeedback(data.reply_he);
      if (data.open_lead_form) {
        var lc = state.lastCards || [];
        if (data.lead_kind) openLeadForm(null, { kind: data.lead_kind, prefill: data.lead_prefill || null });
        else if (lc.length === 1) openLeadForm(lc[0]);
        else if (lc.length > 1) openLeadPicker(lc);   // "על איזו הצעה?" — not "ללא הצעה ספציפית"
        else openLeadForm(null);
      } else if (data.chips && data.chips.length) addChips(data.chips);
      // chips render below the offers; re-anchor so the offers stay in view
      if (data.cards && data.cards.length) scrollToTopOf(introEl || row);
      else scrollDown();
    }).catch(function () {
      if (gen !== state.gen) return;          // a newer turn, or a reset, won
      showTyping(false);
      track('error', { where: 'chat' });
      // The message stays in history; "נסו שוב" re-sends it without retyping.
      // The bubble and the log entry are removed with it — leaving them meant
      // the retry drew the customer's own message a second time, with the
      // error between the two copies, and both survived a reload.
      state.messages.pop();
      if (sentBubble && sentBubble.parentNode) sentBubble.parentNode.removeChild(sentBubble);
      if (sentLogAt != null && state.log.length > sentLogAt) state.log.splice(sentLogAt, 1);
      addMsg('bot', say('chat_error', 'אירעה תקלה זמנית בתקשורת. נסו שוב בעוד רגע, או חייגו {phone}.'));
      var retry = el('div', 'chips');
      var rb = el('button', 'chip', 'נסו שוב');
      rb.addEventListener('click', function () { retry.remove(); sendText(text); });
      retry.appendChild(rb); msgs.appendChild(retry); scrollDown();
    }).then(function () {
      clearTimeout(stuck);
      if (gen !== state.gen) return;          // the newer turn owns the UI now
      state.busy = false; send.disabled = false; focusInput();
      persist();
    });
  }

  /* ============== events ============== */
  // The first message says what this is (an AI assistant — the research shows
  // the disclosure cuts abandonment after a mistake) and offers starters that
  // fit the page the customer is on, not "how can I help?"
  var STARTERS = PAGE.country
    ? ['משפחה עם ילדים ב' + PAGE.country, 'זוג ב' + PAGE.country + ' בפברואר', 'מה כלול בחבילה?', 'יש קייטנה בעברית ב' + PAGE.country + '?']
    : PAGE.camp
      ? ['ילדים בני 5 ו-9, מתי יש קייטנה?', 'מאיזה גיל הקייטנה?', 'משפחה עם ילדים בחנוכה', 'מה כלול בחבילה?']
      : ['זוג בפברואר', 'משפחה עם ילדים', 'מה כלול בחבילה?', 'מתאים למתחילים'];

  // How wide the panel opens. Three offers side by side need the wide panel;
  // in the narrow one they stack, and a single answer ran past the bottom of a
  // laptop screen (Tomer, 26/08 — "צריך לגלול הרבה"). Below 1180px there is no
  // room for it beside the page, so it stays narrow and widens when it must.
  // 06/09 (Tomer: "למה פינגי נפתח על כל המסך?"): it opened wide on every
  // desktop because of this — now the window opens small and grows only
  // when offers arrive (addCardsRow), or when the customer presses ⤡.
  function fitWidth() { /* the small window is the opening size */ }
  /* Pingi rides from the launcher to the header portrait; the window unrolls
     behind him. Once per visit (sessionStorage), never for reduced motion,
     never when the launcher is not on screen. ~0.9s, diagonal like a slope. */
  var RODE_KEY = 'pw_rode';
  function rideIn() {
    try {
      if (sessionStorage.getItem(RODE_KEY)) return false;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      if (typeof win.animate !== 'function') return false;
      var from = fab.querySelector('.av').getBoundingClientRect();
      var to = mark.getBoundingClientRect();
      if (!from.width || !to.width) return false;
      sessionStorage.setItem(RODE_KEY, '1');
      var DUR = 900;
      win.classList.add('riding');
      // the window unrolls from the bottom up, in step with the climb
      win.animate([{ clipPath: 'inset(100% 0 0 0 round 18px)', opacity: .6 }, { clipPath: 'inset(0 0 0 0 round 18px)', opacity: 1 }],
        { duration: DUR, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'both' });
      var rider = document.createElement('img');
      rider.className = 'rider'; rider.src = PINGI_BOARD; rider.alt = ''; rider.setAttribute('aria-hidden', 'true');
      rider.style.left = from.left + 'px'; rider.style.top = from.top + 'px';
      root.appendChild(rider);
      var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
      var dy = (to.top + to.height / 2) - (from.top + from.height / 2);
      // a slight arc: he leans into the slope, straightens as he lands
      var lean = dx < 0 ? 14 : -14;
      var anim = rider.animate([
        { transform: 'translate(0,0) rotate(0deg) scale(1)', offset: 0 },
        { transform: 'translate(' + (dx * .45) + 'px,' + (dy * .55) + 'px) rotate(' + lean + 'deg) scale(1.08)', offset: .5 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) rotate(0deg) scale(' + (to.width / from.width) + ')', offset: 1 }
      ], { duration: DUR, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' });
      var done = function () {
        rider.remove();
        win.classList.remove('riding');
        mark.classList.add('landed');
        setTimeout(function () { mark.classList.remove('landed'); }, 600);
      };
      anim.onfinish = done;
      setTimeout(function () { if (rider.parentNode) done(); }, DUR + 200);   // belt and braces
      return true;
    } catch (e) { win.classList.remove('riding'); return false; }
  }
  function openWin() {
    state.open = true; win.classList.add('open'); wrap.classList.add('chatting');
    fitWidth();
    rideIn();
    fab.setAttribute('aria-expanded', 'true');
    // the red dot has done its job — it does not come back this visit
    fab.classList.add('seen');
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { }
    track('open', { first: !state.booted });
    if (!state.booted) {
      state.booted = true;
      addMsg('bot', say('greeting_widget',
        'היי, אני ' + BOT_NAME + ' — ואני בונה אתכם את חופשת הסקי שמתאימה לכם ביותר. נציג אנושי זמין בכפתור הוואטסאפ למעלה בכל שלב.\nספרו לי בקצרה כמה נוסעים, גילאי הילדים אם יש ומתי תרצו לצאת.'));
      // Disclosure, once, under the greeting: this is an AI, it can be wrong,
      // and a person confirms everything. {privacy} becomes a real link.
      // Not logged and not sent to the model — it is a notice, not a turn.
      addDisclosure();
      state.messages.push({ role: 'assistant', content: 'שלום, ספרו לנו כמה נוסעים, גילאי ילדים אם יש, ומתי תרצו לצאת.' });
      addChips(STARTERS);
    }
    setTimeout(focusInput, 50);
    persist();
  }
  function closeWin() {
    closeSide();
    state.open = false; win.classList.remove('open'); wrap.classList.remove('chatting');
    fab.setAttribute('aria-expanded', 'false'); fab.focus();
    persist();
  }
  fab.addEventListener('click', function () { state.open ? closeWin() : openWin(); });
  // came back from a hotel page? pick the conversation up where it was
  (function () {
    var saved = restore();
    if (!saved || !saved.booted) return;
    replay(saved);
    // The transcript is restored; the WINDOW is not re-opened. It used to be,
    // and once the conversation moved to localStorage (30/08) that meant a
    // customer who left the chat open and simply navigated away landed on the
    // home page days later with the whole screen taken by the bot — at ≤480px
    // the panel is 100vw/100dvh — without having touched anything, and without
    // focus moving into it either. The launcher is right there; reopening is
    // one tap, and then it is their choice.
  })();
  hX.addEventListener('click', closeWin);
  win.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeWin(); });
  send.addEventListener('click', function () { sendText(input.value); });
  input.addEventListener('keydown', function (e) {
    // Enter sends; Shift+Enter opens a new line
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value); }
  });
})();
