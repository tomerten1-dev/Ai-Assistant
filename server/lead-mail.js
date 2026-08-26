'use strict';
// A lead is worth thousands of euros. Until now it landed in
// server-data/leads.jsonl and waited for somebody to open the file.
//
// Tomer, 26/08: every lead is emailed to a person the moment it arrives. The
// webhook stays (it is what a CRM would use); this is the version that works
// on day one, with nothing to integrate.
//
// Configure in .env:
//   SMTP_URL=smtp://user:pass@smtp.example.com:587   (or smtps:// for 465)
//   LEAD_EMAIL_TO=info@pingwin.co.il,ops@pingwin.co.il
//   LEAD_EMAIL_FROM="פינגי" <bot@pingwin.co.il>
// Nothing configured → nothing sent, and the server says so loudly at boot.

let transport = null, tried = false;

function configured() {
  return !!(process.env.SMTP_URL && process.env.LEAD_EMAIL_TO);
}

function getTransport(make) {
  if (transport || tried) return transport;
  tried = true;
  try {
    const nodemailer = make || require('nodemailer');
    transport = nodemailer.createTransport(process.env.SMTP_URL, {
      // a lead must never hold the customer's browser waiting
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    });
  } catch (e) {
    console.error('lead email disabled — could not create the transport:', e.message);
    transport = null;
  }
  return transport;
}

const he = { customer: 'לקוח', agent: 'סוכן נסיעות', corporate: 'חברה / ועד', school: 'בית ספר / תנועת נוער',
  celebration_group: 'אירוע קבוצתי', press: 'עיתונות', job: 'דרושים', partnership: 'שיתוף פעולה',
  existing: 'הזמנה קיימת', adaptive: 'נגישות / סקי מותאם', phone_only: 'השאיר טלפון' };

// The subject line is what a rep sees on a phone, so it carries the three
// things that decide whether to call now: who, what kind, and which offer.
function subject(rec) {
  const c = rec.context || {};
  const kind = he[rec.kind] || rec.kind;
  const what = c.hotel ? `${c.hotel}${c.date ? ' · ' + c.date : ''}` : 'ללא הצעה ספציפית';
  return `ליד מהבוט · ${rec.name} · ${kind} · ${what}`;
}

function body(rec) {
  const c = rec.context || {};
  const party = c.party || {};
  const kids = (party.children_ages || []).length ? `, ילדים: ${party.children_ages.join(', ')}` : '';
  const lines = [
    `שם: ${rec.name}`,
    `טלפון: ${rec.phone}`,
    rec.email ? `מייל: ${rec.email}` : null,
    `סוג הפנייה: ${he[rec.kind] || rec.kind}`,
    '',
    c.hotel ? `ההצעה שהוא הסתכל עליה: ${c.hotel}${c.resort ? ' (' + c.resort + ')' : ''}` : 'לא נבחרה הצעה ספציפית',
    c.date ? `תאריך: ${c.date}${c.nights ? ` · ${c.nights} לילות` : ''}` : null,
    c.room ? `חדר: ${c.room}` : null,
    (party.adults || kids) ? `נוסעים: ${party.adults || '?'} מבוגרים${kids}` : null,
    '',
    `מזהה שיחה: ${c.conversation_id || rec.id}`,
    `התקבל: ${new Date(rec.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
    '',
    '— מה נאמר בשיחה —',
    c.transcript || '(אין תמלול)',
  ];
  return lines.filter(l => l !== null).join('\n');
}

// Never throws at the caller: a mail server that is down must not cost a lead.
async function sendLead(rec, deps = {}) {
  if (!configured()) return { sent: false, why: 'not configured' };
  const t = getTransport(deps.nodemailer);
  if (!t) return { sent: false, why: 'no transport' };
  try {
    await t.sendMail({
      from: process.env.LEAD_EMAIL_FROM || process.env.LEAD_EMAIL_TO,
      to: process.env.LEAD_EMAIL_TO,
      replyTo: rec.email || undefined,
      subject: subject(rec),
      text: body(rec),
    });
    return { sent: true };
  } catch (e) {
    console.error('lead email FAILED for %s: %s', rec.id, e.message);
    return { sent: false, why: e.message };
  }
}

// Said once at boot, where somebody will see it.
function warnIfUnwatched() {
  if (configured() || process.env.LEAD_WEBHOOK_URL) return false;
  console.error('\n' + '='.repeat(70));
  console.error('אזהרה: לידים נשמרים רק לקובץ server-data/leads.jsonl ואף אחד לא מקבל התראה.');
  console.error('הגדירו ב-.env אחד מהשניים:');
  console.error('  SMTP_URL + LEAD_EMAIL_TO   (מייל לנציג על כל ליד)');
  console.error('  LEAD_WEBHOOK_URL           (למערכת ה-CRM)');
  console.error('='.repeat(70) + '\n');
  return true;
}

module.exports = { sendLead, configured, warnIfUnwatched, subject, body, _reset: () => { transport = null; tried = false; } };
