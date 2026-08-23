// תבנית ה-URL של כפתור "המשך להזמנה" — שם הלקוח רואה את המחיר המדויק.
// הבוט עצמו לא מחשב ולא מציג מחיר (חוק אדום 3).
//
// TODO (תומר): למלא את הפורמט האמיתי של מנוע ההזמנות.
// ה-siteID של כל מלון כבר קיים ב-data/resorts.json (נאסף מהאתר).
// דף מלון באתר: https://www.pingwin.co.il/<page>?siteID=<siteID>
// כנראה שמנוע ההזמנות מקבל גם תאריך/הרכב — יש לאמת את שמות הפרמטרים.
const BOOKING_BASE = 'https://www.pingwin.co.il'; // TODO: כתובת מנוע ההזמנות המדויקת

function buildBookingUrl({ siteID, date, room, adults, children_ages }) {
  if (!siteID) return null;
  const p = new URLSearchParams();
  p.set('siteID', String(siteID));
  if (date) p.set('date', date);              // TODO: שם פרמטר אמיתי
  if (room) p.set('room', room);              // TODO: שם פרמטר אמיתי
  if (adults != null) p.set('adults', String(adults));   // TODO
  if (children_ages && children_ages.length) p.set('children', children_ages.join(',')); // TODO
  return `${BOOKING_BASE}/?${p.toString()}`;  // פלייסהולדר לדמו
}

module.exports = { buildBookingUrl, BOOKING_BASE };
