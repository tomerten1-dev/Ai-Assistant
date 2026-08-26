/* Pingwin Ski Bot — ווידג'ט צ'אט צף, קובץ יחיד, ללא תלויות.
   הטמעה באתר:  <script src="https://<host>/pingwin-bot.js" data-pingwin-bot></script>
   Shadow DOM מלא — לא מתנגש עם ה-CSS של האתר המארח. RTL, mobile-first. */
(function () {
  'use strict';
  if (window.__pingwinBotLoaded) return;
  window.__pingwinBotLoaded = true;

  /* ============== THEME — פלייסהולדרים להחלפה לצבעי פינגווין ============== */
  var THEME = {
    primary: '#1c3d5a',        // TODO: להחליף לכחול פינגווין הרשמי
    primaryDark: '#132c42',
    accent: '#8a9bab',         // אפור-כחול מאופק
    ice: '#eaf2f8',            // רקע "קרח" עדין להדגשות
    grad: 'linear-gradient(135deg,#1c3d5a 0%,#2b5f86 100%)',  // כפתורים ראשיים ובועה
    bg: '#ffffff',
    bgAlt: '#f5f7f9',
    text: '#212b33',
    textLight: '#5e6b76',
    bubbleUser: '#1c3d5a',
    bubbleUserText: '#ffffff',
    bubbleBot: '#eef1f4',
    bubbleBotText: '#212b33',
    radius: '10px',
    font: "'Assistant','Rubik','Segoe UI',system-ui,sans-serif", // TODO: פונט המותג
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
      var t = document.createElement('script');
      t.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      t.async = true; t.onload = function () { resolve(); }; t.onerror = function () { resolve(); };
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
    + '.fab .dot{position:absolute;top:-4px;inset-inline-end:-4px;width:14px;height:14px;border-radius:50%;background:#e0392b;box-shadow:0 0 0 3px ' + THEME.primary + '}'
    + '.fab .dot::after{content:"";position:absolute;inset:-1px;border-radius:50%;background:#e0392b;opacity:.5;animation:pwPing 2.4s ease-out infinite}'
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
    + '.win{position:fixed;bottom:92px;' + THEME.position + ':20px;width:min(460px,calc(100vw - 24px));height:min(720px,calc(100vh - 110px));height:min(720px,calc(100dvh - 110px));'
    + 'background:' + THEME.bg + ';border-radius:18px;box-shadow:0 24px 64px rgba(16,32,48,.26),0 2px 8px rgba(16,32,48,.08);border:1px solid #e3e9ef;display:none;flex-direction:column;overflow:hidden;'
    + 'transition:width .25s ease,height .25s ease}'
    + '.win.open{display:flex}'
    // מצב מורחב — נפתח בהקלדה וכשמוצגות הצעות: רחב מספיק לשלושה כרטיסים בשורה
    + '.win.big{width:min(1100px,calc(100vw - 32px));height:calc(100vh - 116px);height:calc(100dvh - 116px)}'
    + '.win.max{width:calc(100vw - 32px);height:calc(100vh - 32px);height:calc(100dvh - 32px);bottom:16px;' + THEME.position + ':16px}'
    + '.win.max .msgs{padding:20px 24px}'
    // on a phone the window is the screen, whatever .big/.max say — those two
    // used to win on specificity and leave a lopsided box with a 32px gap
    + '@media (max-width:480px){.win,.win.big,.win.max{bottom:0;' + THEME.position + ':0;width:100vw;height:100vh;height:100dvh;border-radius:0;margin:0}'
    + '.hdr .sub{display:none}.hdr .ttl{font-size:14px;white-space:nowrap}.hdr .ttl .long{display:none}.hdr .wa span{display:none}.hdr .wa{padding:7px}}'
    // כותרת שקטה על רקע בהיר — פחות "באנר", יותר ממשק
    + '.hdr{background:' + THEME.bg + ';color:' + THEME.text + ';padding:12px 16px;display:flex;align-items:center;gap:11px;border-bottom:1px solid #e8edf1}'
    + '.hdr .mark{width:38px;height:38px;border-radius:12px;background:' + THEME.ice + ';display:flex;align-items:center;justify-content:center;flex:none;position:relative}'
    + '.hdr .mark img{width:34px;height:34px;display:block;object-fit:contain}'
    + '.hdr .mark::after{content:"";position:absolute;inset-inline-end:-2px;bottom:-2px;width:10px;height:10px;border-radius:50%;background:#2fb26a;border:2px solid ' + THEME.bg + '}'
    + '.hdr .ttl{font-weight:700;font-size:14.5px;letter-spacing:.1px}'
    + '.hdr .sub{font-size:11.5px;color:' + THEME.textLight + '}'
    + '.form .consent{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:' + THEME.textLight + ';margin:10px 0 4px;line-height:1.4;cursor:pointer}'
    + '.form .consent input{margin-top:3px;flex:none;width:16px;height:16px;accent-color:' + THEME.primaryDark + '}'
    + '.form .consent a{color:' + THEME.primaryDark + ';text-decoration:underline}'
    + '.hdr .wa{margin-inline-start:auto;display:inline-flex;align-items:center;gap:6px;background:#e7f6ec;color:#1b6b3a;border:1px solid #cfe9d8;border-radius:999px;padding:5px 11px;font-size:12.5px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}'
    + '.hdr .wa:hover{background:#d9f0e1}'
    + '.hdr .wa:focus-visible{outline:2px solid ' + THEME.accent + ';outline-offset:2px}'
    + '.hdr .wa + .newc,.hdr .wa + .exp{margin-inline-start:0}'
    + '.hdr .newc{margin-inline-start:auto;display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;border-radius:10px}'
    + '.hdr .newc + .exp,.hdr .exp + .x{margin-inline-start:0}'
    + '.hdr .exp{margin-inline-start:auto;font-size:16px;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:10px}'
    + '.hdr .exp + .x{margin-inline-start:0}'
    + '.hdr .x{margin-inline-start:auto;background:none;border:none;color:' + THEME.textLight + ';font-size:19px;cursor:pointer;'
    + 'min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;border-radius:10px;line-height:1}'
    + '.hdr .x:focus-visible,.hdr .newc:focus-visible,.hdr .exp:focus-visible,.send:focus-visible,.chip:focus-visible,.btn:focus-visible{outline:3px solid ' + THEME.primaryDark + ';outline-offset:2px}'
    + '.hdr .x:hover{background:' + THEME.bgAlt + ';color:' + THEME.text + '}'
    // אזור השיחה בסגנון עוזר AI: תשובות הבוט כטקסט זורם עם סימן זהות,
    // הודעות הלקוח כבועה עדינה — במקום שתי בועות צבעוניות זו מול זו
    + '.msgs{position:relative;flex:1;overflow-y:auto;overflow-x:hidden;padding:22px 20px 18px;background:linear-gradient(180deg,#fbfcfd 0%,#f4f7fa 100%);display:flex;flex-direction:column;gap:18px;scroll-behavior:smooth}'
    // the default Windows scrollbar is a slab down the side of a small window
    + '.msgs::-webkit-scrollbar{width:8px}'
    + '.msgs::-webkit-scrollbar-thumb{background:#d3dae1;border-radius:99px;border:2px solid ' + THEME.bg + '}'
    + '.msgs::-webkit-scrollbar-thumb:hover{background:#b9c4ce}'
    + '.msgs::-webkit-scrollbar-track{background:transparent}'
    + '.m{font-size:15px;line-height:1.7;white-space:pre-wrap;word-wrap:break-word}'
    + '.m.user{align-self:flex-start;max-width:min(82%,460px);background:' + THEME.ice + ';color:' + THEME.text + ';'
    + 'border:1px solid #d9e6f0;border-radius:16px 16px 16px 4px;padding:10px 15px}'
    + '.m.bot{align-self:stretch;max-width:min(100%,640px);color:' + THEME.text + ';padding-inline-start:46px;position:relative;min-height:36px}'
    + '.m.bot::before{content:"";position:absolute;inset-inline-start:0;top:-2px;width:36px;height:36px;border-radius:11px;'
    + 'background:' + THEME.ice + ' url(' + PINGI + ') center/34px 34px no-repeat}'
    + '.typing{align-self:stretch;padding:4px 0;padding-inline-start:46px;min-height:34px;display:flex;gap:5px;align-items:center;position:relative}'
    + '.typing::before{content:"";position:absolute;inset-inline-start:0;top:-1px;width:36px;height:36px;border-radius:11px;'
    + 'background:' + THEME.ice + ' url(' + PINGI + ') center/34px 34px no-repeat}'
    + '.typing i{width:6px;height:6px;border-radius:50%;background:' + THEME.textLight + ';animation:pb 1s infinite}'
    + '.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}'
    + '@keyframes pb{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'
    // שורת הצעות: שלושה כרטיסים זה לצד זה, יורדים לטור רק כשאין רוחב
    + '.cards-row{align-self:stretch;display:flex;gap:10px;flex-wrap:wrap}'
    + '.cards-row .card{flex:1 1 270px;min-width:0}'
    + '.card{align-self:stretch;background:' + THEME.bg + ';border:1px solid #e1e8ef;border-radius:16px;padding:12px 14px 12px;display:flex;flex-direction:column;gap:4px;box-shadow:0 1px 3px rgba(16,32,48,.05);'
    + 'box-shadow:0 1px 2px rgba(16,32,48,.05);transition:box-shadow .18s,transform .18s,border-color .18s}'
    + '.card:hover{box-shadow:0 10px 26px rgba(16,32,48,.12);transform:translateY(-2px);border-color:#c8d5e2}'
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
    /* A ski photograph is mostly snow and sky, so the floor has to be set by
       the scrim rather than hoped for from the picture. */
    + 'background:linear-gradient(180deg,rgba(9,20,35,.34) 0%,rgba(9,20,35,.16) 26%,'
    + 'rgba(9,20,35,.62) 58%,rgba(9,20,35,.88) 82%,rgba(9,20,35,.95) 100%)}'
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
    + '.card.pbg:not(.open) .galb{opacity:1;top:auto;bottom:7px;transform:none;width:34px;height:34px;'
    + 'background:rgba(255,255,255,.9);color:#16283d;box-shadow:0 1px 5px rgba(9,20,35,.4)}'
    + '.card.pbg:not(.open) .galb:hover{background:#fff}'
    + '.card.pbg:not(.open) .galb.next{inset-inline-end:8px;inset-inline-start:auto}'
    + '.card.pbg:not(.open) .galb.prev{inset-inline-end:84px;inset-inline-start:auto}'
    /* .card:not(.open) .galn is hidden on the plain card — here it is the only
       thing telling you there are more photographs */
    + '.card.pbg:not(.open) .gal .galn{opacity:1;bottom:17px;top:auto;inset-inline-end:46px;inset-inline-start:auto;'
    + 'transform:none;background:rgba(9,20,35,.72);font-variant-numeric:tabular-nums}'
    + '.card.pbg:not(.open) .gal .tier{top:10px;bottom:auto;inset-inline-start:10px}'
    /* An outline, drawn as four hard shadows plus two soft ones. -webkit-text
       -stroke paints the stroke OVER the glyph and thins it; this does not, and
       it works in every browser we care about. */
    + '.card.pbg:not(.open) .hname,.card.pbg:not(.open) .brief,.card.pbg:not(.open) .brief b,'
    + '.card.pbg:not(.open) .cwhere,.card.pbg:not(.open) .why,.card.pbg:not(.open) .dtog'
    + '{text-shadow:1px 1px 0 rgba(9,20,35,.55),-1px 1px 0 rgba(9,20,35,.55),'
    + '1px -1px 0 rgba(9,20,35,.55),-1px -1px 0 rgba(9,20,35,.55),'
    + '0 1px 3px rgba(9,20,35,.95),0 0 10px rgba(9,20,35,.7)}'
    + '.card.pbg:not(.open) .hname,.card.pbg:not(.open) .brief,.card.pbg:not(.open) .brief b{color:#fff}'
    + '.card.pbg:not(.open) .cwhere{color:rgba(255,255,255,.92)}'
    + '.card.pbg:not(.open) .brief .sep{color:rgba(255,255,255,.45)}'
    /* .card .brief .bprice outranks .card.pbg .bprice, so the price band stayed
       navy — unreadable against the photograph */
    + '.card.pbg:not(.open) .brief .bprice{color:#9fd4ff}'
    + '.card.pbg:not(.open) .dtog{color:#fff;opacity:.9}'
    /* no panel around the reason: a translucent box over a picture reads as an
       empty grey bar, and the scrim already carries the text */
    + '.card.pbg:not(.open) .why{background:none;color:#fff;padding:2px 0}'
    + '.card.pbg:not(.open) .tag{background:rgba(255,255,255,.18);color:#fff;border-color:rgba(255,255,255,.25)}'
    + '.card.pbg:not(.open) .tag.rec{background:rgba(255,255,255,.92);color:' + THEME.primaryDark + '}'
    /* the buttons carry their own contrast — they must never depend on the
       photograph behind them */
    + '.card.pbg:not(.open) .btn.sec{background:rgba(9,20,35,.55);color:#fff;'
    + 'border-color:rgba(255,255,255,.8);backdrop-filter:blur(3px)}'
    + '.card.pbg:not(.open) .btn.pri{box-shadow:0 2px 10px rgba(9,20,35,.5)}'
    + '.card.pbg:hover{box-shadow:0 14px 30px rgba(9,20,35,.28)}'
    + '.card.pbg.open{background-image:none!important;border-color:#e1e8ef}'
    // gallery: the photo fills the top of the card, arrows sit on it
    + '.card .gal{position:relative;width:calc(100% + 28px);margin:-12px -14px 6px;border-radius:15px 15px 0 0;overflow:hidden;background:#e8edf1}'
    + '.card .gal::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 55%,rgba(16,32,48,.35) 100%);pointer-events:none}'
    + '.card .gal .galb,.card .gal .galn,.card .gal .tier{z-index:1}'
    // 112px: three cards with their date, room, price and both buttons fit a
    // laptop screen without scrolling — the photo is the first thing to give
    + '.card .photo{width:100%;height:72px;object-fit:cover;display:block;transition:height .18s ease}'
    + '.card.open .photo{height:132px}'
    + '.card .gal .tier{position:absolute;top:8px;inset-inline-start:8px;box-shadow:0 1px 4px rgba(0,0,0,.25)}'
    // everything that is nice to know but not needed to choose lives behind one toggle
    + '.card .details{display:none;flex-direction:column;gap:6px}'
    + '.card.open .details{display:flex}'
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
    + '.card .dtog{align-self:flex-start;background:none;border:none;padding:2px 0;font-family:inherit;font-size:12.5px;color:' + THEME.primaryDark + ';cursor:pointer;font-weight:600;order:8}'
    + '.card .details{order:9}.card .facts{order:7}.card .acts,.card .cta{order:10}'
    + '.card .dtog:hover{text-decoration:underline}'
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

    + '.card .inc{background:#f2f6f9;border:1px solid #e0e9f0;border-radius:9px;padding:9px 11px;display:flex;flex-direction:column;gap:3px}'
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
    + '.card .facts{display:flex;flex-direction:column;gap:3px;border-inline-start:2px solid ' + THEME.primary + ';padding-inline-start:8px}'
    + '.card .facts div{font-size:13px;color:' + THEME.text + ';line-height:1.5}'
    + '.m.bot.wave{padding-inline-start:74px;min-height:64px}'
    + '.m.bot.wave::before{width:64px;height:64px;border-radius:16px;top:-6px;background:' + THEME.ice + ' url(' + PINGI_WAVE + ') center/60px 60px no-repeat}'
    + '.ts{display:block;font-size:10.5px;line-height:1.4;color:' + THEME.textLight + ';opacity:.75;margin-top:3px;font-variant-numeric:tabular-nums;direction:ltr;text-align:start}'
    + '.m.user .ts{color:rgba(255,255,255,.75)}'
    + '.m.after .ts,.m.wave .ts{display:none}'
    + '.m.bot.after{font-size:13px;color:' + THEME.textLight + ';margin-top:-8px}'
    + '.m.bot.after::before{display:none}'
    // גילוי נאות: הערת שוליים, לא הודעה של פינגי — ולכן בלי הפרצוף שלו,
    // ובלי המחלקה .m, שסופרת הודעות בשיחה
    + '.fine{align-self:stretch;max-width:min(100%,640px);font-size:12px;line-height:1.55;'
    + 'color:' + THEME.textLight + ';margin-top:-6px;padding-inline-start:46px}'
    + '.fine a{color:' + THEME.primary + ';text-decoration:underline}'
    + '.card .why{font-size:13px;color:' + THEME.text + ';background:' + THEME.bgAlt + ';border-radius:8px;padding:8px 10px;line-height:1.5}'
    + '.card .tags{display:flex;gap:6px;flex-wrap:wrap}'
    + '.tag{font-size:12px;padding:4px 10px;border-radius:6px;background:#e9eef2;color:#33475b;border:1px solid #d5dde4}'
    + '.tag.warn{background:#f7f1e3;color:#7a5c1e;border:1px solid #e5d9bd}'
    + '.tag.rec{background:#e8eef4;color:' + THEME.primaryDark + ';border:1px solid #cfdae4}'
    + '.tag.tier{background:' + THEME.primaryDark + ';color:#fff;border:1px solid ' + THEME.primaryDark + ';font-weight:600}'
    + '.tag.left{background:#fbeeea;color:#8a3b2a;border:1px solid #efcfc6}'
    + '.card .price{font-size:13.5px;font-weight:700;color:' + THEME.primaryDark + ';letter-spacing:.3px;background:' + THEME.ice + ';border-radius:8px;padding:4px 10px}'
    + '.card .btns{display:flex;gap:7px;margin-top:auto;padding-top:6px;flex-wrap:wrap}'
    + '.btn{flex:1 1 0;min-width:112px;padding:9px 12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:background .15s,border-color .15s}'
    + '.btn.pri{background:' + THEME.grad + ';color:#fff;box-shadow:0 2px 6px rgba(28,61,90,.25)}'
    + '.btn.pri:hover{filter:brightness(1.08);box-shadow:0 4px 12px rgba(28,61,90,.3)}'
    + '.btn.sec{background:' + THEME.bg + ';color:' + THEME.primaryDark + ';border:1.5px solid ' + THEME.primary + '}'
    + '.btn.sec:hover{background:' + THEME.bgAlt + '}'
    // One row that scrolls sideways, not four rows that push the offers off the
    // screen. Eight chips wrapping was 173px on a phone — the second largest
    // thing in the conversation after the offers themselves (measured 26/08).
    + '.chips{display:flex;flex-wrap:nowrap;gap:7px;align-self:stretch;padding-inline-start:32px;'
    + 'overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;'
    + 'scroll-snap-type:x proximity;padding-bottom:2px;'
    // flex:none is load-bearing. A scroll container's automatic minimum size is
    // 0, not its content — so as a flex item in the scrolling message column it
    // squashed to nothing the moment the conversation overflowed.
    + 'flex:none;min-width:0;max-width:100%}'
    + '.chips::-webkit-scrollbar{height:0}'
    + '.chip{scroll-snap-align:start;flex:none}'
    + '.chip{border:1px solid #d8dfe6;background:' + THEME.bg + ';color:' + THEME.textLight + ';border-radius:99px;'
    // min-height 36px: a 30px chip is below the comfortable tap target on a
    // phone, and chips are the main way a customer refines on mobile
    + 'padding:9px 15px;min-height:38px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:500;transition:all .15s}'
    + '.chip:hover{background:' + THEME.primary + ';color:#fff;border-color:' + THEME.primary + '}'
    // שורת הקלט כמסגרת אחת שעוטפת גם את כפתור השליחה — כמו בממשקי AI
    + '.inp{display:flex;gap:8px;padding:12px 16px 16px;background:' + THEME.bg + ';align-items:flex-end;border-top:1px solid #eef2f5}'
    + '.inp .box{flex:1;display:flex;align-items:flex-end;gap:6px;border:1px solid #d8dfe6;border-radius:14px;'
    + 'padding:5px;padding-inline:12px 6px;background:' + THEME.bg + ';transition:border-color .15s,box-shadow .15s}'
    + '.inp .box:focus-within{border-color:' + THEME.primary + ';box-shadow:0 0 0 3px rgba(28,61,90,.08)}'
    + '.inp textarea{flex:1;border:none;background:none;padding:9px 4px;font-size:15px;font-family:inherit;direction:rtl;'
    + 'resize:none;overflow-y:auto;line-height:1.5;max-height:110px;min-height:32px;color:' + THEME.text + '}'
    + '.inp textarea:focus{outline:none}'
    + '.inp .box:focus-within{outline:3px solid ' + THEME.primaryDark + ';outline-offset:1px}'
    + '.send:hover:not(:disabled){filter:brightness(1.1)}'
    + '.send{background:' + THEME.grad + ';border:none;color:#fff;border-radius:12px;width:44px;height:44px;flex:none;'
    + 'cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}'
    + '.send:disabled{opacity:.5;cursor:default}'
    + '.form{align-self:stretch;background:' + THEME.bg + ';border:1.5px solid ' + THEME.primary + ';border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px}'
    + '.form label{font-size:12.5px;color:' + THEME.textLight + '}'
    + '.form input{border:1.5px solid #cfdae4;border-radius:9px;padding:8px 12px;font-size:14px;font-family:inherit;direction:rtl}'
    + '.form .note{font-size:11.5px;color:' + THEME.textLight + '}'
    + '.srhint{font-size:11px;color:' + THEME.textLight + ';text-align:center;padding:2px 0 6px;background:' + THEME.bg + '}';

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);
  // Hebrew brand face. Loaded into the host document (fonts do not cross the
  // shadow boundary); falls back to the system stack if the CDN is blocked.
  try {
    if (!document.querySelector('link[data-pw-font]')) {
      var fl = document.createElement('link');
      fl.rel = 'stylesheet'; fl.setAttribute('data-pw-font', '');
      fl.href = 'https://fonts.googleapis.com/css2?family=Assistant:wght@400;600;700&display=swap';
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
    '<span class="av"><img src="' + PINGI_LAUNCH + '" alt="" aria-hidden="true"><span class="dot" aria-hidden="true"></span></span>' +
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
  var ttl = el('div', 'ttl', 'פינגווין');
  ttl.appendChild(el('span', 'long', ' | ייעוץ חופשות סקי'));
  hTxt.appendChild(ttl);
  hTxt.appendChild(el('div', 'sub', 'זמינות בזמן אמת מתוך המלאי שלנו'));
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
    try { localStorage.setItem('pingwin_bot_max', max ? '1' : '0'); } catch (e) {}
    scrollDown();
  }
  hExp.addEventListener('click', function () { setExpanded(!win.classList.contains('max')); });
  try { if (localStorage.getItem('pingwin_bot_max') === '1') setExpanded(true); } catch (e) {}
  var hNew = el('button', 'x newc');
  hNew.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/></svg>';
  hNew.title = 'שיחה חדשה';
  hNew.setAttribute('aria-label', hNew.title);
  hNew.addEventListener('click', function () { resetChat(); });
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
  hdr.appendChild(hTxt); if (hWa) hdr.appendChild(hWa); hdr.appendChild(hNew); hdr.appendChild(hExp); hdr.appendChild(hX);

  var msgs = el('div', 'msgs');
  msgs.setAttribute('aria-live', 'polite');

  var inp = el('div', 'inp');
  var input = document.createElement('textarea');
  input.rows = 1;
  input.placeholder = 'לדוגמה: זוג עם שני ילדים, פברואר';
  input.setAttribute('aria-label', 'הודעה לבוט');
  // auto-grow up to ~4 lines so long messages stay visible while typing,
  // and expand the whole window once the user starts typing
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    if (input.value.length > 0) win.classList.add('big');
  });
  var send = el('button', 'send');
  send.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(180deg)" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
  send.setAttribute('aria-label', 'שליחה');
  var inpBox = el('div', 'box');
  inpBox.appendChild(input); inpBox.appendChild(send);
  inp.appendChild(inpBox);

  win.appendChild(hdr); win.appendChild(msgs); win.appendChild(inp);
  wrap.appendChild(win); wrap.appendChild(fab);
  root.appendChild(wrap);

  /* ============== ui helpers ============== */
  function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }
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
     back to an empty chat. sessionStorage: same tab, cleared when it closes. */
  // The offer is the hotel's photograph, with the text on it (Tomer, 26/08).
  // ?pwcard=plain — or ...pingwin-bot.js?card=plain on the tag — draws the
  // older white card instead; kept because it is the fallback whenever a hotel
  // has no photo at all, and the two are worth comparing on real traffic.
  var CARD_STYLE = (function () {
    try {
      var v = new URLSearchParams(window.location.search).get('pwcard');
      if (!v && script && script.src) v = new URL(script.src).searchParams.get('card');
      return v === 'plain' ? 'plain' : 'photo';
    } catch (e) { return 'photo'; }
  })();

  var STORE_KEY = 'pingwin_bot_session_v1';
  // The widget's own build, taken from its script URL (?v=0.2.0 in the GTM tag).
  // A conversation started on an older build is not resumed on a newer one: the
  // replay would mix old wording and old cards into a new bot.
  var BUILD = (function () {
    try { return new URL(script.src).searchParams.get('v') || '0'; } catch (e) { return '0'; }
  })();
  function persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        build: BUILD,
        messages: state.messages.slice(-20), slots: state.slots, lastCards: state.lastCards || null,
        booted: state.booted, open: state.open, log: state.log.slice(-40)
      }));
    } catch (e) {}
  }
  function restore() {
    try {
      // ?pwreset=1 in the URL (or #pwreset) forces a clean chat — the switch
      // testers reach for when a hard refresh keeps replaying the old session
      // a clean chat means clean all the way: the red dot comes back too,
      // otherwise a tester can never see the launcher as a first-time visitor
      if (/[?&#]pwreset\b/.test(location.href)) {
        sessionStorage.removeItem(STORE_KEY);
        try { sessionStorage.removeItem(SEEN_KEY); fab.classList.remove('seen'); } catch (e) { }
        return null;
      }
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || !Array.isArray(d.messages)) return null;
      if (d.build !== BUILD) { sessionStorage.removeItem(STORE_KEY); return null; }
      return d;
    } catch (e) { return null; }
  }
  // Start over — for a customer whose plans changed, and for us while testing.
  function resetChat() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
    state.messages = []; state.slots = {}; state.lastCards = null; state.log = [];
    state.booted = false; state.turn = 0; state.busy = false;
    while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
    win.classList.remove('big');
    send.disabled = false;
    state.open = false; openWin();        // re-runs the greeting and the starters
    track('reset');
  }
  // bring an element to the TOP of the view — used when offers arrive, so the
  // customer sees them from the first card instead of landing past them
  function scrollToTopOf(node) {
    if (!node) return;
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
    // a phone number that wraps mid-way reads as a typo ("04--8557722"): show
    // it with a non-breaking hyphen so it always stays on one line
    var shown = String(text).replace(/(\d{2,3})-(\d{7})/g, '$1\u2011$2');
    var m = el('div', 'm ' + (role === 'user' ? 'user' : 'bot'), shown);
    var ts = el('span', 'ts', clockOf(at));
    ts.setAttribute('aria-hidden', 'true');   // the time is decoration for a screen reader
    m.appendChild(ts);
    msgs.appendChild(m); scrollDown();
    if (!silent) state.log.push({ t: role === 'user' ? 'user' : 'bot', v: text, at: at || new Date().toISOString() });
    return m;
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

  var typingEl = null;
  function showTyping(on) {
    if (on && !typingEl) {
      typingEl = el('div', 'typing');
      typingEl.appendChild(el('i')); typingEl.appendChild(el('i')); typingEl.appendChild(el('i'));
      msgs.appendChild(typingEl); scrollDown();
    } else if (!on && typingEl) { typingEl.remove(); typingEl = null; }
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

  /* ---------- hotel card ----------
     Structure asked for by Tomer, 24/08: gallery with arrows, hotel name with
     its country, labelled departure date and nights, the room as a control
     that opens what the hotel page says about it, the hotel blurb, the price
     band, and who it fits. Every value comes from the card the server sent —
     the widget invents nothing. */
  function addCard(c, container) {
    var card = el('div', 'card');
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
      im.alt = c.hotel;
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
    head.appendChild(el('div', 'hname', c.hotel));
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
      brief.appendChild(el('span', 'sep', '·'));
      brief.appendChild(el('span', 'bprice', c.price_range));
    }
    card.appendChild(brief);

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
    var dtog = el('button', 'dtog', 'פרטים ▾');
    dtog.setAttribute('aria-expanded', 'false');
    dtog.addEventListener('click', function () {
      var open = card.classList.toggle('open');
      dtog.textContent = open ? 'פחות ▴' : 'פרטים ▾';
      dtog.setAttribute('aria-expanded', String(open));
      track('card_expand', { hotel: c.hotel, open: open, cid: cid() });
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
    if (c.tier_he && !photos.length) tags.appendChild(el('span', 'tag tier', c.tier_he));
    if (c.recommended) tags.appendChild(el('span', 'tag rec', 'מומלץ'));
    if (c.rooms_left_he) tags.appendChild(el('span', 'tag left', c.rooms_left_he));
    if (c.camps && c.camps.running && c.camps.running.length) {
      tags.appendChild(el('span', 'tag', 'קייטנה בעברית'));
      if (!c.camps.full) tags.appendChild(el('span', 'tag warn', 'קייטנה חלקית — ראו פירוט'));
    }
    if (c.occ_unverified) tags.appendChild(el('span', 'tag warn', 'ההרכב יאומת מול נציג'));
    if (tags.childNodes.length) card.appendChild(tags);

    var foot = el('div', 'cfoot');
    foot.appendChild(el('div', 'price', 'טווח מחיר: ' + c.price_range));
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
        track('booking_click', { hotel: c.hotel, resort: c.resort, date: c.date, nights: c.nights, cid: cid() });
        window.open(c.booking_url, '_blank', 'noopener');
      });
      btns.appendChild(b2);
    }
    card.appendChild(btns);
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
    state.log.push({ t: 'chips', v: labels });
  }
  function addCardsRow(cards) {
    win.classList.add('big');
    var row = el('div', 'cards-row');
    msgs.appendChild(row);
    cards.forEach(function (c) { addCard(c, row); });
    state.lastCards = cards;
    return row;
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
    });
    if (d.lastCards) state.lastCards = d.lastCards;
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
      var ch = el('button', 'chip', iso(c.hotel) + ' · ' + fmtDate(c.date, c.date_label));
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
      f.appendChild(el('div', 'hname', 'נציג יחזור אליכם על: ' + iso(card.hotel)));
      f.appendChild(el('div', 'note', fmtDate(card.date, card.date_label) + ' · ' + card.nights + ' לילות · ' + card.room));
    } else {
      f.appendChild(el('div', 'hname', 'נציג יחזור אליכם'));
      f.appendChild(el('div', 'note', 'השאירו שם וטלפון ונציג פינגווין יחזור אליכם.'));
    }
    var leadKind = opts.kind || (state.slots && state.slots._lead_kind) || 'customer';
    var lName = el('label', null, 'שם'); var iName = document.createElement('input');
    iName.setAttribute('aria-label', 'שם'); iName.name = 'name'; iName.autocomplete = 'name'; lName.htmlFor = iName.id = 'pw-lead-name';
    if (opts.prefill && opts.prefill.name) iName.value = opts.prefill.name;
    var lPhone = el('label', null, 'טלפון'); var iPhone = document.createElement('input');
    if (opts.prefill && opts.prefill.phone) iPhone.value = opts.prefill.phone;
    iPhone.type = 'tel'; iPhone.dir = 'ltr'; iPhone.setAttribute('aria-label', 'טלפון'); iPhone.name = 'phone'; iPhone.autocomplete = 'tel'; iPhone.inputMode = 'tel'; lPhone.htmlFor = iPhone.id = 'pw-lead-phone';
    // Optional, and said plainly why: the customer who wants the offer in
    // writing is the customer who is showing it to somebody else tonight.
    var lMail = el('label', null, 'מייל (לא חובה — לקבלת ההצעה בכתב)');
    var iMail = document.createElement('input');
    iMail.type = 'email'; iMail.setAttribute('aria-label', 'מייל לקבלת ההצעה'); iMail.name = 'email';
    iMail.autocomplete = 'email'; iMail.inputMode = 'email'; iMail.dir = 'ltr';
    lMail.htmlFor = iMail.id = 'pw-lead-email';
    if (opts.prefill && opts.prefill.email) iMail.value = opts.prefill.email;
    var go = el('button', 'btn pri', 'שלחו לנציג'); go.type = 'submit';
    var note = el('div', 'note', 'רק שם וטלפון — בלי התחייבות. ההזמנה סופית רק אחרי אישור נציג ומייל עם קבלה.');
    // consent (Tomer, q30; Privacy Protection Law amendment 13): an unticked
    // box the customer must tick, next to a link to Pingwin's privacy policy
    var consent = el('label', 'consent');
    var iConsent = document.createElement('input'); iConsent.type = 'checkbox'; iConsent.id = 'pw-lead-consent'; iConsent.name = 'consent';
    consent.htmlFor = iConsent.id;
    consent.appendChild(iConsent);
    var cTxt = el('span', null, 'אני מאשר/ת שפינגווין תשמור את הפרטים ותיצור איתי קשר בנוגע לפנייה זו, בהתאם ל');
    var cLink = document.createElement('a'); cLink.href = THEME.privacyUrl; cLink.target = '_blank'; cLink.rel = 'noopener'; cLink.textContent = 'מדיניות הפרטיות';
    cTxt.appendChild(cLink); cTxt.appendChild(document.createTextNode('.'));
    consent.appendChild(cTxt);
    f.appendChild(lName); f.appendChild(iName);
    f.appendChild(lPhone); f.appendChild(iPhone);
    f.appendChild(lMail); f.appendChild(iMail);
    f.appendChild(consent);
    f.appendChild(note); f.appendChild(go);
    msgs.appendChild(f); scrollDown();
    f.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var nameVal = iName.value.trim();
      var phoneVal = iPhone.value.trim();
      if (!nameVal || !phoneVal) { note.textContent = 'נדרשים שם וטלפון ליצירת קשר.'; return; }
      // a rep can do nothing with "אבג" — require a real Israeli-length number
      var digits = phoneVal.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) {
        note.textContent = 'מספר הטלפון לא נראה תקין. לדוגמה: 050-1234567';
        return;
      }
      if (nameVal.length < 2) { note.textContent = 'נשמח לשם מלא ליצירת קשר.'; return; }
      var mailVal = iMail.value.trim();
      if (mailVal && !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(mailVal)) {
        note.textContent = 'כתובת המייל לא נראית תקינה. אפשר גם להשאיר ריק.'; iMail.focus(); return;
      }
      if (!iConsent.checked) { note.textContent = 'כדי שנוכל לחזור אליכם צריך לאשר את מדיניות הפרטיות (הסימון למטה).'; iConsent.focus(); return; }
      go.disabled = true;
      turnstileToken().then(function (tok) { return fetchWithTimeout(API_BASE + '/api/lead', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: nameVal, phone: phoneVal, email: mailVal || null, turnstile: tok,
          context: {
            slots: state.slots ? { _cid: state.slots._cid, _vt: state.slots._vt } : null,
            hotel: card ? card.hotel : null, resort: card ? card.resort : null,
            date: card ? card.date : null, nights: card ? card.nights : null,
            room: card ? card.room : null,
            party: state.slots ? { adults: state.slots.adults, children_ages: state.slots.children_ages } : null,
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
        addMsg('bot', card
          ? 'הפרטים התקבלו. נציג פינגווין יחזור אליכם בהקדם בנוגע ל-' + iso(card.hotel) + '.'
          : 'הפרטים התקבלו. נציג פינגווין יחזור אליכם בהקדם.');
      }).catch(function () {
        track('error', { where: 'lead' });
        go.disabled = false; note.textContent = say('send_error', 'תקלה בשליחה — נסו שוב או חייגו {phone}');
      });
    });
  }

  /* ============== chat flow ============== */
  function sendText(text) {
    text = (text || '').trim();
    if (!text || state.busy) return;
    addMsg('user', text);
    state.messages.push({ role: 'user', content: text });
    input.value = '';
    input.style.height = 'auto'; // shrink back after send
    state.busy = true; send.disabled = true; showTyping(true);

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
      // 429 = "slow down": the server sends a polite line, show it as a reply
      if (r.status === 429) return r.json().then(function (j) { j.slots = state.slots; return j; });
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });

    Promise.all([call, minWait]).then(function (both) {
      var data = both[0];
      showTyping(false);
      state.slots = data.slots || state.slots;
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
        state.messages.push({ role: 'assistant', content: data.reply_he });
      }
      if (data.cards && data.cards.length) {
        track('offers', { count: data.cards.length });
        // three offers side by side, so the customer barely scrolls
        var row = addCardsRow(data.cards);
        if (after) addMsg('bot', after).classList.add('after');
        state.log.push({ t: 'cards', v: data.cards });
        // park the view on the intro line + first card, not below them
        scrollToTopOf(introEl || row);
        state.messages.push({ role: 'assistant', content: '[הוצגו ' + data.cards.length + ' הצעות: ' + data.cards.map(function (c) { return c.hotel + ' ' + c.date; }).join(', ') + ']' });
      }
      if (data.two_room_splits && data.two_room_splits.length && (!data.cards || !data.cards.length)) {
        data.two_room_splits.slice(0, 3).forEach(function (s) {
          addMsg('bot', s.hotel + ' — ' + fmtDate(s.date) + ' · ' + s.nights + ' לילות\nשני חדרים: ' + s.rooms.join(' + ') + ' · ' + s.price_range);
        });
      }
      // asked to be called back — open the form on the offer they were looking
      // at, or a blank one if they have not chosen yet
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
      showTyping(false);
      track('error', { where: 'chat' });
      // the message stays in history; "נסו שוב" re-sends it without retyping
      state.messages.pop();
      addMsg('bot', say('chat_error', 'אירעה תקלה זמנית בתקשורת. נסו שוב בעוד רגע, או חייגו {phone}.'));
      var retry = el('div', 'chips');
      var rb = el('button', 'chip', 'נסו שוב');
      rb.addEventListener('click', function () { retry.remove(); sendText(text); });
      retry.appendChild(rb); msgs.appendChild(retry); scrollDown();
    }).then(function () {
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
  var WIDE = 1180;
  function fitWidth() {
    try { if (window.innerWidth >= WIDE) win.classList.add('big'); } catch (e) {}
  }
  function openWin() {
    state.open = true; win.classList.add('open'); wrap.classList.add('chatting');
    fitWidth();
    fab.setAttribute('aria-expanded', 'true');
    // the red dot has done its job — it does not come back this visit
    fab.classList.add('seen');
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { }
    track('open', { first: !state.booted });
    if (!state.booted) {
      state.booted = true;
      addMsg('bot', say('greeting_widget',
        'היי, אני ' + BOT_NAME + ' — העוזר של ' + THEME.brand + '. מציג רק חופשות שבאמת פנויות אצלנו, ונציג אנושי זמין בכפתור הוואטסאפ למעלה בכל שלב.\nספרו לי בקצרה כמה נוסעים, גילאי הילדים אם יש ומתי תרצו לצאת.'));
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
    if (saved.open) {
      state.open = true; win.classList.add('open'); wrap.classList.add('chatting');
      fitWidth();
      fab.setAttribute('aria-expanded', 'true');
    }
  })();
  hX.addEventListener('click', closeWin);
  win.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeWin(); });
  send.addEventListener('click', function () { sendText(input.value); });
  input.addEventListener('keydown', function (e) {
    // Enter sends; Shift+Enter opens a new line
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value); }
  });
})();
