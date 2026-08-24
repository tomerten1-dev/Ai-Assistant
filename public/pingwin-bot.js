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
    position: 'left'           // 'left' | 'right' — פינת הבועה
  };

  /* ============== api base — נגזר מכתובת הסקריפט עצמו ============== */
  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[data-pingwin-bot]');
    return s[s.length - 1];
  })();
  var API_BASE = (script && script.getAttribute('data-api')) ||
    (script && script.src ? new URL(script.src).origin : '') || '';

  /* ============== state ============== */
  var state = {
    open: false,
    messages: [],   // {role:'user'|'assistant', content}
    slots: {},
    busy: false,
    booted: false
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
    + '.fab{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:' + THEME.primary + ';color:#fff;'
    + 'box-shadow:0 3px 12px rgba(16,32,48,.28);display:flex;align-items:center;justify-content:center;transition:transform .15s}'
    + '.fab:hover{transform:scale(1.06)}'
    + '.fab:focus-visible{outline:3px solid ' + THEME.accent + '}'
    + '.win{position:fixed;bottom:92px;' + THEME.position + ':20px;width:min(460px,calc(100vw - 24px));height:min(720px,calc(100dvh - 110px));'
    + 'background:' + THEME.bg + ';border-radius:' + THEME.radius + ';box-shadow:0 10px 36px rgba(16,32,48,.22);border:1px solid #dfe5ea;display:none;flex-direction:column;overflow:hidden;'
    + 'transition:width .25s ease,height .25s ease}'
    + '.win.open{display:flex}'
    // מצב מורחב — נפתח בהקלדה וכשמוצגות הצעות: רחב מספיק לשלושה כרטיסים בשורה
    + '.win.big{width:min(1100px,calc(100vw - 32px));height:calc(100dvh - 116px)}'
    + '.win.max{width:calc(100vw - 32px);height:calc(100dvh - 32px);bottom:16px;' + THEME.position + ':16px}'
    + '.win.max .msgs{padding:20px 24px}'
    + '@media (max-width:480px){.win{bottom:0;' + THEME.position + ':0;width:100vw;height:100dvh;border-radius:0}}'
    // כותרת שקטה על רקע בהיר — פחות "באנר", יותר ממשק
    + '.hdr{background:' + THEME.bg + ';color:' + THEME.text + ';padding:13px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #e8edf1}'
    + '.hdr .ttl{font-weight:700;font-size:14.5px;letter-spacing:.1px}'
    + '.hdr .sub{font-size:11.5px;color:' + THEME.textLight + '}'
    + '.hdr .exp{margin-inline-start:auto;font-size:16px}'
    + '.hdr .exp + .x{margin-inline-start:0}'
    + '.hdr .x{margin-inline-start:auto;background:none;border:none;color:' + THEME.textLight + ';font-size:19px;cursor:pointer;padding:3px 7px;border-radius:7px;line-height:1}'
    + '.hdr .x:hover{background:' + THEME.bgAlt + ';color:' + THEME.text + '}'
    // אזור השיחה בסגנון עוזר AI: תשובות הבוט כטקסט זורם עם סימן זהות,
    // הודעות הלקוח כבועה עדינה — במקום שתי בועות צבעוניות זו מול זו
    + '.msgs{position:relative;flex:1;overflow-y:auto;overflow-x:hidden;padding:22px 20px 18px;background:' + THEME.bg + ';display:flex;flex-direction:column;gap:20px;scroll-behavior:smooth}'
    // the default Windows scrollbar is a slab down the side of a small window
    + '.msgs::-webkit-scrollbar{width:8px}'
    + '.msgs::-webkit-scrollbar-thumb{background:#d3dae1;border-radius:99px;border:2px solid ' + THEME.bg + '}'
    + '.msgs::-webkit-scrollbar-thumb:hover{background:#b9c4ce}'
    + '.msgs::-webkit-scrollbar-track{background:transparent}'
    + '.m{font-size:15px;line-height:1.7;white-space:pre-wrap;word-wrap:break-word}'
    + '.m.user{align-self:flex-start;max-width:min(82%,460px);background:' + THEME.bgAlt + ';color:' + THEME.text + ';'
    + 'border:1px solid #e4e9ee;border-radius:16px 16px 16px 4px;padding:10px 15px}'
    + '.m.bot{align-self:stretch;max-width:min(100%,640px);color:' + THEME.text + ';padding-inline-start:32px;position:relative}'
    + '.m.bot::before{content:"P";position:absolute;inset-inline-start:0;top:0;width:22px;height:22px;border-radius:6px;'
    + 'background:' + THEME.primary + ';color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;letter-spacing:.3px}'
    + '.typing{align-self:stretch;padding:2px 0 2px 32px;padding-inline-start:32px;display:flex;gap:5px;align-items:center;position:relative}'
    + '.typing::before{content:"P";position:absolute;inset-inline-start:0;top:0;width:22px;height:22px;border-radius:6px;'
    + 'background:' + THEME.primary + ';color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}'
    + '.typing i{width:6px;height:6px;border-radius:50%;background:' + THEME.textLight + ';animation:pb 1s infinite}'
    + '.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}'
    + '@keyframes pb{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}'
    // שורת הצעות: שלושה כרטיסים זה לצד זה, יורדים לטור רק כשאין רוחב
    + '.cards-row{align-self:stretch;display:flex;gap:10px;flex-wrap:wrap}'
    + '.cards-row .card{flex:1 1 270px;min-width:0}'
    + '.card{align-self:stretch;background:' + THEME.bg + ';border:1px solid #dde6ee;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:7px;'
    + 'box-shadow:0 1px 2px rgba(16,32,48,.05);transition:box-shadow .18s,transform .18s,border-color .18s}'
    + '.card:hover{box-shadow:0 6px 18px rgba(16,32,48,.10);transform:translateY(-2px);border-color:#c8d5e2}'
    // gallery: the photo fills the top of the card, arrows sit on it
    + '.card .gal{position:relative;width:calc(100% + 28px);margin:-14px -14px 8px;border-radius:13px 13px 0 0;overflow:hidden;background:#e8edf1}'
    + '.card .photo{width:100%;height:150px;object-fit:cover;display:block}'
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
    + '.card .rows{display:flex;flex-direction:column;gap:5px;padding:8px 0;border-top:1px solid #edf1f5;border-bottom:1px solid #edf1f5}'
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

    + '.card .cdesc{font-size:13.5px;color:' + THEME.text + ';line-height:1.55}'
    + '.card .cfoot{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:2px}'
    + '.card .fits{font-size:13px;color:' + THEME.textLight + '}'
    + '.card .clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}'
    + '.card .hname{font-weight:700;font-size:15.5px;color:' + THEME.text + ';line-height:1.3;letter-spacing:-.2px}'
    + '.card .meta{font-size:13px;color:' + THEME.textLight + ';line-height:1.5}'
    + '.card .facts{display:flex;flex-direction:column;gap:3px;border-inline-start:2px solid ' + THEME.primary + ';padding-inline-start:8px}'
    + '.card .facts div{font-size:13px;color:' + THEME.text + ';line-height:1.5}'
    + '.card .why{font-size:13px;color:' + THEME.text + ';background:' + THEME.bgAlt + ';border-radius:8px;padding:8px 10px;line-height:1.5}'
    + '.card .tags{display:flex;gap:6px;flex-wrap:wrap}'
    + '.tag{font-size:12px;padding:4px 10px;border-radius:6px;background:#e9eef2;color:#33475b;border:1px solid #d5dde4}'
    + '.tag.warn{background:#f7f1e3;color:#7a5c1e;border:1px solid #e5d9bd}'
    + '.tag.rec{background:#e8eef4;color:' + THEME.primaryDark + ';border:1px solid #cfdae4}'
    + '.card .price{font-size:14.5px;font-weight:700;color:' + THEME.primaryDark + ';letter-spacing:.3px}'
    + '.card .btns{display:flex;gap:7px;margin-top:auto;padding-top:8px;flex-wrap:wrap}'
    + '.btn{flex:1 1 0;min-width:112px;padding:10px 12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:background .15s,border-color .15s}'
    + '.btn.pri{background:' + THEME.primary + ';color:#fff}'
    + '.btn.pri:hover{background:' + THEME.primaryDark + '}'
    + '.btn.sec{background:' + THEME.bg + ';color:' + THEME.primaryDark + ';border:1.5px solid ' + THEME.primary + '}'
    + '.btn.sec:hover{background:' + THEME.bgAlt + '}'
    + '.chips{display:flex;flex-wrap:wrap;gap:7px;align-self:stretch;padding-inline-start:32px}'
    + '.chip{border:1px solid #d8dfe6;background:' + THEME.bg + ';color:' + THEME.textLight + ';border-radius:99px;'
    // min-height 36px: a 30px chip is below the comfortable tap target on a
    // phone, and chips are the main way a customer refines on mobile
    + 'padding:9px 15px;min-height:38px;font-size:13px;cursor:pointer;font-family:inherit;font-weight:500;transition:all .15s}'
    + '.chip:hover{background:' + THEME.bgAlt + ';color:' + THEME.primaryDark + ';border-color:' + THEME.primary + '}'
    // שורת הקלט כמסגרת אחת שעוטפת גם את כפתור השליחה — כמו בממשקי AI
    + '.inp{display:flex;gap:8px;padding:12px 16px 16px;background:' + THEME.bg + ';align-items:flex-end;border-top:1px solid #eef2f5}'
    + '.inp .box{flex:1;display:flex;align-items:flex-end;gap:6px;border:1px solid #d8dfe6;border-radius:14px;'
    + 'padding:5px 6px 5px 12px;background:' + THEME.bg + ';transition:border-color .15s,box-shadow .15s}'
    + '.inp .box:focus-within{border-color:' + THEME.primary + ';box-shadow:0 0 0 3px rgba(28,61,90,.08)}'
    + '.inp textarea{flex:1;border:none;background:none;padding:9px 4px;font-size:15px;font-family:inherit;direction:rtl;'
    + 'resize:none;overflow-y:auto;line-height:1.5;max-height:110px;min-height:32px;color:' + THEME.text + '}'
    + '.inp textarea:focus{outline:none}'
    + '.send:hover:not(:disabled){background:' + THEME.primaryDark + '}'
    + '.send{background:' + THEME.primary + ';border:none;color:#fff;border-radius:10px;width:36px;height:36px;flex:none;'
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

  /* ============== dom ============== */
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  var wrap = el('div', 'wrap');
  var fab = el('button', 'fab');
  fab.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  fab.setAttribute('aria-label', 'פתיחת ייעוץ חופשות סקי');
  var win = el('div', 'win');
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', 'צ׳אט פינגווין');

  var hdr = el('div', 'hdr');
  var hTxt = el('div');
  hTxt.appendChild(el('div', 'ttl', 'פינגווין | ייעוץ חופשות סקי'));
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
  var hX = el('button', 'x', '✕');
  hX.setAttribute('aria-label', 'סגירת הצ׳אט');
  hdr.appendChild(hTxt); hdr.appendChild(hExp); hdr.appendChild(hX);

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
  // bring an element to the TOP of the view — used when offers arrive, so the
  // customer sees them from the first card instead of landing past them
  function scrollToTopOf(node) {
    if (!node) return;
    msgs.scrollTop = Math.max(0, node.offsetTop - msgs.offsetTop - 12);
  }

  function addMsg(role, text) {
    if (!text) return null;
    var m = el('div', 'm ' + (role === 'user' ? 'user' : 'bot'), text);
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

    // ---- gallery: the hotel's own photos, paged with two arrows
    var photos = (c.images && c.images.length ? c.images : (c.image ? [c.image] : []));
    if (photos.length) {
      var gal = el('div', 'gal');
      var im = document.createElement('img');
      im.className = 'photo';
      im.src = photos[0];
      im.alt = c.hotel;
      im.loading = 'lazy';
      im.addEventListener('error', function () { gal.remove(); });
      gal.appendChild(im);
      if (photos.length > 1) {
        var at = 0;
        var count = el('div', 'galn', '1/' + photos.length);
        var step = function (d) {
          return function (ev) {
            ev.stopPropagation();
            at = (at + d + photos.length) % photos.length;
            im.src = photos[at];
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
      card.appendChild(gal);
    }

    // ---- name, with the country beside it
    var head = el('div', 'chead');
    head.appendChild(el('div', 'hname', c.hotel));
    head.appendChild(el('div', 'cwhere', c.country_he + (c.resort ? ' · ' + c.resort : '')));
    card.appendChild(head);

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

    if (c.desc_he) card.appendChild(el('div', 'cdesc', c.desc_he));
    if (c.lift_he) card.appendChild(el('div', 'meta', 'מעלית: ' + c.lift_he));

    // answers to what THIS customer asked about (beds, board, ski pass, ...)
    if (c.facts_he && c.facts_he.length) {
      var facts = el('div', 'facts');
      for (var fi = 0; fi < c.facts_he.length; fi++) facts.appendChild(el('div', '', c.facts_he[fi]));
      card.appendChild(facts);
    }

    var tags = el('div', 'tags');
    if (c.recommended) tags.appendChild(el('span', 'tag rec', 'מומלץ'));
    if (c.camps && c.camps.running && c.camps.running.length) {
      tags.appendChild(el('span', 'tag', 'קייטנה בעברית'));
      if (!c.camps.full) tags.appendChild(el('span', 'tag warn', 'קייטנה חלקית — ראו פירוט'));
    }
    if (c.occ_unverified) tags.appendChild(el('span', 'tag warn', 'ההרכב יאומת מול נציג'));
    if (tags.childNodes.length) card.appendChild(tags);

    var foot = el('div', 'cfoot');
    foot.appendChild(el('div', 'price', 'טווח מחיר: ' + c.price_range));
    if (c.occ && c.occ.max != null) {
      foot.appendChild(el('div', 'fits', 'מתאים ל-' + c.occ.max + ' נוסעים'));
    }
    card.appendChild(foot);

    if (c.why_he) card.appendChild(el('div', 'why clamp', c.why_he));

    var btns = el('div', 'btns');
    var b1 = el('button', 'btn sec', 'תחזרו אליי');
    b1.title = 'תחזרו אליי עם פרטים על ההצעה הזו';
    b1.addEventListener('click', function () { openLeadForm(c); });
    btns.appendChild(b1);
    if (c.booking_url) {
      var b2 = el('button', 'btn pri', 'המשך להזמנה');
      b2.addEventListener('click', function () { window.open(c.booking_url, '_blank', 'noopener'); });
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
    labels.forEach(function (l) {
      var ch = el('button', 'chip', l);
      ch.addEventListener('click', function () { sendText(l); });
      box.appendChild(ch);
    });
    msgs.appendChild(box);
  }

  /* lead form — שם + טלפון בלבד (חוק אדום 8) */
  // `card` is optional: someone who simply types "תחזרו אליי" has not picked an
  // offer yet, and should still get the form rather than a pointer to a button.
  function openLeadForm(card) {
    var f = el('div', 'form');
    if (card) {
      f.appendChild(el('div', 'hname', 'נציג יחזור אליכם על: ' + card.hotel));
      f.appendChild(el('div', 'note', fmtDate(card.date, card.date_label) + ' · ' + card.nights + ' לילות · ' + card.room));
    } else {
      f.appendChild(el('div', 'hname', 'נציג יחזור אליכם'));
      f.appendChild(el('div', 'note', 'השאירו שם וטלפון ונציג פינגווין יחזור אליכם.'));
    }
    var lName = el('label', null, 'שם'); var iName = document.createElement('input');
    iName.setAttribute('aria-label', 'שם');
    var lPhone = el('label', null, 'טלפון'); var iPhone = document.createElement('input');
    iPhone.type = 'tel'; iPhone.setAttribute('aria-label', 'טלפון');
    var go = el('button', 'btn pri', 'שלחו לנציג');
    var note = el('div', 'note', 'רק שם וטלפון — בלי התחייבות. ההזמנה סופית רק אחרי אישור נציג ומייל עם קבלה.');
    f.appendChild(lName); f.appendChild(iName);
    f.appendChild(lPhone); f.appendChild(iPhone);
    f.appendChild(note); f.appendChild(go);
    msgs.appendChild(f); scrollDown();
    go.addEventListener('click', function () {
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
      go.disabled = true;
      fetch(API_BASE + '/api/lead', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: nameVal, phone: phoneVal,
          context: {
            hotel: card ? card.hotel : null, resort: card ? card.resort : null,
            date: card ? card.date : null, nights: card ? card.nights : null,
            room: card ? card.room : null,
            party: state.slots ? { adults: state.slots.adults, children_ages: state.slots.children_ages } : null
          }
        })
      }).then(function (r) { return r.json(); }).then(function () {
        f.remove();
        addMsg('bot', card
          ? 'הפרטים התקבלו. נציג פינגווין יחזור אליכם בהקדם בנוגע ל-' + card.hotel + '.'
          : 'הפרטים התקבלו. נציג פינגווין יחזור אליכם בהקדם.');
      }).catch(function () {
        go.disabled = false; note.textContent = 'תקלה בשליחה — נסו שוב או חייגו 04-8557722';
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
    var call = fetch(API_BASE + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: state.messages, slots: state.slots })
    }).then(function (r) { return r.json(); });

    Promise.all([call, minWait]).then(function (both) {
      var data = both[0];
      showTyping(false);
      state.slots = data.slots || state.slots;
      var introEl = null;
      if (data.reply_he) {
        introEl = addMsg('bot', data.reply_he);
        state.messages.push({ role: 'assistant', content: data.reply_he });
      }
      if (data.cards && data.cards.length) {
        // three offers side by side, so the customer barely scrolls
        win.classList.add('big');
        var row = el('div', 'cards-row');
        msgs.appendChild(row);
        data.cards.forEach(function (c) { addCard(c, row); });
        state.lastCards = data.cards;
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
        openLeadForm(state.lastCards && state.lastCards.length === 1 ? state.lastCards[0] : null);
      } else if (data.chips && data.chips.length) addChips(data.chips);
      // chips render below the offers; re-anchor so the offers stay in view
      if (data.cards && data.cards.length) scrollToTopOf(introEl || row);
      else scrollDown();
    }).catch(function () {
      showTyping(false);
      addMsg('bot', 'אירעה תקלה זמנית בתקשורת. נסו שוב בעוד רגע, או חייגו 04-8557722.');
    }).then(function () {
      state.busy = false; send.disabled = false; input.focus();
    });
  }

  /* ============== events ============== */
  var STARTERS = [
    'זוג בפברואר',
    'משפחה עם ילדים',
    'מה כלול בחבילה?',
    'מתאים למתחילים',
  ];

  function openWin() {
    state.open = true; win.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    if (!state.booted) {
      state.booted = true;
      addMsg('bot', 'שלום, כאן שירות התאמת החופשות של פינגווין.\nספרו לי בקצרה כמה נוסעים, גילאי הילדים אם יש ומתי תרצו לצאת — ואציג אפשרויות פנויות מהמלאי שלנו.');
      state.messages.push({ role: 'assistant', content: 'שלום, ספרו לנו כמה נוסעים, גילאי ילדים אם יש, ומתי תרצו לצאת.' });
      addChips(STARTERS);
    }
    setTimeout(function () { input.focus(); }, 50);
  }
  function closeWin() {
    state.open = false; win.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false'); fab.focus();
  }
  fab.addEventListener('click', function () { state.open ? closeWin() : openWin(); });
  hX.addEventListener('click', closeWin);
  win.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeWin(); });
  send.addEventListener('click', function () { sendText(input.value); });
  input.addEventListener('keydown', function (e) {
    // Enter sends; Shift+Enter opens a new line
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value); }
  });
})();
