// The "המשך להזמנה" link — where the customer goes to see the real price.
// The bot never calculates or displays a price itself (red rule 3).
//
// It used to point at https://www.pingwin.co.il/?siteID=…&date=…&room=…, with
// parameter names that were invented as placeholders. The site ignores them,
// so every offer landed on the home page and the customer had to find their
// hotel again. Tomer, 24/08: send them to the hotel they clicked.
//
// This is the hotel's own page, and the format is certain — it is the same URL
// this project fetches from all over the build tools:
//     https://www.pingwin.co.il/<page>?siteID=<siteID>
//
// STILL OPEN (Tomer): the real booking engine. The hotel page carries a
// pre-order popup whose fields are d_from, adults, teens, big, kids, infants —
// if you confirm what those mean and which endpoint they post to, deepLink()
// below is where a prefilled date and party would go. Until it is confirmed it
// stays unused: a link that lands on the right hotel beats a link that guesses
// at a booking URL and lands nowhere.
const BASE = 'https://www.pingwin.co.il';

function buildBookingUrl({ page, siteID }) {
  if (!page || !siteID) return null;
  return `${BASE}/${page}?siteID=${siteID}`;
}

// Placeholder for the day the engine's parameters are known. Deliberately not
// wired up — see above.
function deepLink() { return null; }

module.exports = { buildBookingUrl, deepLink, BOOKING_BASE: BASE };
