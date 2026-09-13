'use strict';
/* The shape a lead arrives in at Pingwin's CRM.
 *
 * Why this is its own file (30/08): the webhook body used to be our internal
 * record, nested and named for us — `context.party.children_ages`, a raw
 * transcript, fields that exist because the widget happened to send them. That
 * is fine for a file on disk and wrong for an integration: whoever maps this
 * into the CRM (Priority / Monday / Make / Zapier) reads the JSON once and
 * writes a mapping against it, and every rename afterwards silently breaks a
 * live lead pipeline.
 *
 * So the wire format is flat, documented, versioned, and decided HERE. When
 * Pingwin says which CRM it is, this is the only file that changes — the
 * server, the widget and the tests do not.
 *
 * Two rules it inherits from the rest of the bot:
 *   - No money. Red rule 3 holds on the way out too: we send the offer's hotel,
 *     date and room, never a price. The rep quotes the price.
 *   - Whitelist, never spread. The widget is a browser and its payload is
 *     input, not truth: only the fields listed below cross into the CRM, and
 *     every one of them is clamped to a sane type and length.
 */

const SCHEMA = 'pingwin.lead/1';

const MONTH_HE = { 1: 'ינואר', 2: 'פברואר', 3: 'מרץ', 12: 'דצמבר' };
const { COUNTRY_HE } = require('./labels.js');
const AIRPORT_HE = { tlv: 'נתב"ג', haifa: 'חיפה' };

const str = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max || 200));
const num = (v) => (Number.isFinite(+v) ? +v : null);
const bool = (v) => (v === true ? true : v === false ? false : null);
const list = (v, max, each) => (Array.isArray(v) ? v.slice(0, max).map(x => str(x, each || 120)).filter(Boolean) : []);
const ages = (v) => (Array.isArray(v) ? v.map(num).filter(a => a != null && a >= 0 && a < 120).slice(0, 12) : []);

/* What the customer was looking for. Everything here is something they typed
   or tapped themselves — the CRM can filter and route on it, which a transcript
   does not allow. */
function request(r) {
  const kids = ages(r.children_ages);
  const month = num(r.month);
  const monthAlt = num(r.month_alt);
  const country = str(r.country, 20);
  return {
    adults: num(r.adults),
    children_ages: kids,
    children_count: kids.length,
    party_size: (num(r.adults) || 0) + kids.length || null,
    month, month_he: (month && MONTH_HE[month]) || null,
    month_alt: monthAlt, month_alt_he: (monthAlt && MONTH_HE[monthAlt]) || null,
    exact_day: str(r.exact_day, 20),
    flexible_dates: bool(r.flexible_dates),
    nights: num(r.nights_wanted),
    country: country === 'any' ? null : country,
    country_he: (country && COUNTRY_HE[country]) || null,
    destination: str(r.destination, 80),
    departure_airport: str(r.departure_airport, 20),
    departure_airport_he: AIRPORT_HE[r.departure_airport] || null,
    hebrew_kids_club: bool(r.needs_hebrew_kids_club),
    no_saturday_flights: r.no_saturday_flights === true,
    // what they said mattered to them ("ספא", "קרוב למסלולים") and anything
    // that fits no field at all ("אשתי בהריון") — the two things a rep most
    // wants to know before picking up the phone
    preferences: list(r.preferences, 10),
    notes: list(r.notes_from_customer, 8, 200),
  };
}

/* The offer they were looking at when they asked to be called. Deliberately
   no price: red rule 3. */
function offer(c) {
  if (!c || !c.hotel) return null;
  return {
    hotel: str(c.hotel, 120),
    resort: str(c.resort, 80),
    country: str(c.country, 20),
    date: str(c.date, 20),
    nights: num(c.nights),
    room: str(c.room, 120),
    board: str(c.board, 60),
  };
}

/* internal record (server-data/leads.jsonl) → what goes on the wire */
function toCrm(record) {
  const ctx = (record && record.context) || {};
  const party = ctx.party || {};
  // the widget sends `request` (whitelisted there too); `party` is the older
  // shape and still fills the two fields it carried, so a cached widget on a
  // customer's machine never produces a lead with no party size in the CRM
  const req = request({ ...party, ...(ctx.request || {}) });
  return {
    schema: SCHEMA,
    lead_id: str(record.id, 40),
    created_at: str(record.at, 40),
    source: 'web-chat',
    // 'customer' | 'agent' | … — set by the widget; the CRM routes on it
    kind: str(record.kind, 30) || 'customer',
    customer: {
      name: str(record.name, 80),
      phone: str(record.phone, 30),
      email: str(record.email, 120),
    },
    request: req,
    offer: offer(ctx),
    conversation: {
      // the same id the customer sees in the chat and the chat log carries —
      // this is what lets a rep open the conversation behind the lead
      id: str(ctx.conversation_id || (ctx.slots && ctx.slots._cid), 40),
      transcript: str(ctx.transcript, 4000),
    },
    consent: ctx.consent ? {
      privacy: ctx.consent.privacy === true,
      at: str(ctx.consent.at, 40),
      text: str(ctx.consent.text, 400),
    } : null,
  };
}

module.exports = { toCrm, SCHEMA };
