// The "המשך להזמנה" link — where the customer goes to see the real price.
// The bot never calculates or displays a price itself (red rule 3).
//
// ── How the booking form on pingwin.co.il actually works (read 26/08/2026) ──
//
// The hotel page's quote section is `?siteID=<id>&tab=20`. Its form is not
// server-rendered: `order_odyssea.js` builds it in the browser from an `oprm`
// object, and the room list only arrives from `/ajax_order_odyssea.php`
// (`act:roomList`) AFTER the dates are chosen. The page reads no dates, no
// party and no room from the query string — we tested `?from=&till=` and the
// server ignored them.
//
// What the script does expose on the page, as a global `orderMan`:
//     orderMan.setDates(from, till)                     dd.mm.yyyy
//     orderMan.loadRoom(0, roomID, {adults, kids:[]}, pansion)
//
// So the deep link carries our values in its own namespaced parameters, and a
// small companion script on the hotel page (public/pingwin-prefill.js, loaded
// by one GTM tag — see docs/DEPLOY.md) reads them and drives those two calls.
// Nothing on Pingwin's side has to change, and if the tag is ever removed the
// link still lands on the right hotel page: the parameters are simply ignored.
//
// Tomer, 26/08: "שהפרטים שהם ביקשו יהיו כבר בפנים".
const BASE = 'https://www.pingwin.co.il';
const NS = 'pw';   // our parameters, kept out of the site's own namespace

function buildBookingUrl({ page, siteID }) {
  if (!page || !siteID) return null;
  return `${BASE}/${page}?siteID=${siteID}`;
}

// Which of a hotel's pages sells THIS stay.
//
// Casa Karina sells anything shorter than a week on a page of its own
// (siteID 1445). It is not a different hotel and the customer should never see
// it as one — but the booking engine treats the two as unrelated: ask the
// ordinary page (1435) for a 3-night stay and it answers with no rooms at all,
// which is exactly what `npm run rooms` reported. It is the only hotel with
// such a page (Tomer, 26/08), so this is a property of that hotel and not a
// rule about short stays.
function pageFor(info, nights) {
  const alt = info && info.short_stay;
  if (!alt || !nights || !alt.siteID || !alt.page) return info || {};
  if (Number(nights) > Number(alt.max_nights || 6)) return info;
  return { ...info, siteID: alt.siteID, page: alt.page };
}

// The site's date format, and the one its datepicker accepts.
function ddmmyyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  return `${m[3]}.${m[2]}.${m[1]}`;
}
function addNights(iso, nights) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || !nights) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + Number(nights));
  return d.toISOString().slice(0, 10);
}

// The board codes order_odyssea.js uses in its pansion <select>.
const PANSION = {
  'לינה בלבד': 1, 'ארוחת בוקר': 2, 'חצי פנסיון': 3, 'חצי פנסיון + שתיה': 5,
  'פנסיון מלא': 6, 'הכל כלול': 7, 'ארוחת ערב': 8, 'באגט וקרואסון': 9,
  'באגט וקרואסון + ארוחת ערב': 10, 'אולטרה הכל כלול': 12,
  'חצי פנסיון + ארוחת צהרים קלה': 15,
};
// our board text is a sentence ("ארוחת בוקר או חצי פנסיון"); take the first
// board it names, and only when it is unambiguous
function pansionCode(boardHe) {
  const t = String(boardHe || '');
  if (!t || /או|\/|,/.test(t)) return null;         // more than one option — let the customer choose
  for (const [he, code] of Object.entries(PANSION)) if (t.trim() === he) return code;
  return null;
}

// The link the customer clicks, with everything we already know about their
// holiday. `card` is what the widget shows; `party` is the slots.
//
// Deliberately conservative: a value we are not sure about is left out, so the
// form opens with the fields we know filled and the rest untouched. A wrong
// prefill is worse than an empty one — the customer would book the wrong room.
function deepLink(hotelInfo, card, party) {
  const base = buildBookingUrl(pageFor(hotelInfo || {}, card && card.nights));
  if (!base) return null;
  const from = ddmmyyyy(card && card.date);
  const till = ddmmyyyy(addNights(card && card.date, card && card.nights));
  if (!from || !till) return base;                  // no dates, nothing to prefill

  const p = new URLSearchParams();
  p.set(NS + 'from', from);
  p.set(NS + 'till', till);
  // the site's own id when we know it (server/site-rooms.js asked the booking
  // engine); the name stays as the fallback the browser can still match on
  if (card.room_id) p.set(NS + 'roomid', String(card.room_id));
  if (card.room) p.set(NS + 'room', card.room);
  const adults = party && party.adults;
  if (adults) p.set(NS + 'ad', String(adults));
  const kids = (party && party.children_ages) || [];
  if (kids.length) p.set(NS + 'kids', kids.join(','));
  const pans = pansionCode(card.board_he);
  if (pans) p.set(NS + 'pans', String(pans));
  // and produce the quote for them (Tomer, 26/08). The companion script only
  // presses it once the room has a price — that is, only when the prefill
  // actually succeeded; on a half-filled form the customer is left to choose.
  p.set(NS + 'quote', '1');
  return base + '&' + p.toString();
}

module.exports = { buildBookingUrl, deepLink, pageFor, ddmmyyyy, addNights, pansionCode, BOOKING_BASE: BASE, NS };
