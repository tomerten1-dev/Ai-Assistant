'use strict';
// A lead is the only thing this bot produces that is worth money. These tests
// pin the path it travels: the widget's payload → the file → the rep's inbox,
// and the conversation id that ties it back to the chat that produced it.
// Run: node tests/test-lead.js
process.env.CHAT_LOG = 'off';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const leadMail = require('../server/lead-mail.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ✓ ' + name); },
    e => { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); });
}

const REC = {
  id: 'labc', at: '2026-08-26T18:00:00.000Z', name: 'תומר כהן', phone: '0501234567',
  email: 'tomer@example.com', kind: 'customer',
  context: {
    hotel: 'Hotel Ferienhof', resort: 'מאיירהופן', date: '2027-01-09', nights: 7, room: 'DBL 2-2',
    party: { adults: 2, children_ages: [5, 9] }, conversation_id: 'cxyz',
    transcript: 'לקוח: זוג בפברואר\nבוט: הנה מה שפנוי',
  },
};

async function unit() {
  await t('the subject line carries who, what kind, and which offer', () => {
    const s = leadMail.subject(REC);
    assert.ok(s.includes('תומר כהן') && s.includes('Hotel Ferienhof') && s.includes('2027-01-09'), s);
    assert.ok(s.length < 120, 'too long for a phone notification: ' + s.length);
  });
  await t('the body carries everything a rep needs to make the call', () => {
    const b = leadMail.body(REC);
    for (const must of ['0501234567', 'tomer@example.com', 'Hotel Ferienhof', 'מאיירהופן',
      '7 לילות', 'DBL 2-2', '2 מבוגרים', '5, 9', 'cxyz', 'זוג בפברואר']) {
      assert.ok(b.includes(must), 'missing from the email: ' + must);
    }
  });
  await t('a lead with no offer attached still produces a sane email', () => {
    const bare = { id: 'l2', at: REC.at, name: 'דנה', phone: '0521111111', kind: 'agent', context: {} };
    const s = leadMail.subject(bare), b = leadMail.body(bare);
    assert.ok(s.includes('ללא הצעה ספציפית') && s.includes('סוכן נסיעות'), s);
    assert.ok(b.includes('לא נבחרה הצעה ספציפית') && !/undefined|null/.test(b), b);
  });
  await t('nothing is sent, and nothing throws, when no mail server is configured', async () => {
    delete process.env.SMTP_URL; delete process.env.LEAD_EMAIL_TO;
    leadMail._reset();
    assert.strictEqual(leadMail.configured(), false);
    assert.deepStrictEqual(await leadMail.sendLead(REC), { sent: false, why: 'not configured' });
  });
  await t('a mail server that is down costs a log line, never the lead', async () => {
    process.env.SMTP_URL = 'smtp://user:pass@localhost:1'; process.env.LEAD_EMAIL_TO = 'x@y.com';
    leadMail._reset();
    const stub = { createTransport: () => ({ sendMail: async () => { throw new Error('ECONNREFUSED'); } }) };
    const r = await leadMail.sendLead(REC, { nodemailer: stub });
    assert.strictEqual(r.sent, false);
    assert.ok(/ECONNREFUSED/.test(r.why));
    delete process.env.SMTP_URL; delete process.env.LEAD_EMAIL_TO;
    leadMail._reset();
  });
  await t('a configured server gets one mail, addressed and replyable', async () => {
    process.env.SMTP_URL = 'smtp://u:p@mail.example.com:587';
    process.env.LEAD_EMAIL_TO = 'ops@pingwin.co.il';
    process.env.LEAD_EMAIL_FROM = 'bot@pingwin.co.il';
    leadMail._reset();
    const sent = [];
    const stub = { createTransport: () => ({ sendMail: async m => { sent.push(m); return { ok: 1 }; } }) };
    const r = await leadMail.sendLead(REC, { nodemailer: stub });
    assert.strictEqual(r.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, 'ops@pingwin.co.il');
    assert.strictEqual(sent[0].replyTo, 'tomer@example.com', 'reply goes to the customer');
    assert.ok(sent[0].text.includes('0501234567'));
    delete process.env.SMTP_URL; delete process.env.LEAD_EMAIL_TO; delete process.env.LEAD_EMAIL_FROM;
    leadMail._reset();
  });
}

/* ---- the route, end to end ---- */
function startServer(port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
      env: { ...process.env, PORT: String(port), CHAT_LOG: 'off', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ALLOWED_ORIGINS: '*' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; if (out.includes('http://localhost')) resolve(p); });
    p.stderr.on('data', () => { });
    p.on('exit', c => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 8000).unref();
  });
}
// Windows aborts the whole process ("Assertion failed: !(handle->flags &
// UV_HANDLE_CLOSING)", 07/09) when process.exit() runs while the child
// process handle is still closing. So: kill, wait for the child to be gone,
// and only then leave.
function stopServer(p) {
  return new Promise(resolve => {
    const done = () => resolve();
    p.once('exit', done);
    setTimeout(done, 3000).unref();
    p.kill();
  });
}
const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

async function integration() {
  const port = 8803;
  const srv = await startServer(port);
  const file = path.join(__dirname, '..', 'server-data', 'leads.jsonl');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').length : 0;
  try {
    await t('the conversation id comes back on every turn, with or without Turnstile', async () => {
      const r = await post(port, '/api/chat', { messages: [{ role: 'user', content: 'שלום' }], slots: {} });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.slots._cid, 'no conversation id — a lead could never be tied to its chat');
      // and it stays the same on the next turn
      const r2 = await post(port, '/api/chat', { messages: [{ role: 'user', content: 'זוג בפברואר' }], slots: r.json.slots });
      assert.strictEqual(r2.json.slots._cid, r.json.slots._cid, 'the id changed mid-conversation');
    });
    await t('an optional email is stored with the lead, and a missing one is not invented', async () => {
      const ok = await post(port, '/api/lead', {
        name: 'בדיקה', phone: '0501234567', email: 'a@b.co',
        context: { kind: 'customer', conversation_id: 'ctest' },
      });
      assert.strictEqual(ok.status, 200);
      const bare = await post(port, '/api/lead', { name: 'בדיקה2', phone: '0502222222', context: {} });
      assert.strictEqual(bare.status, 200);
      const lines = fs.readFileSync(file, 'utf8').slice(before).trim().split('\n').map(JSON.parse);
      const withMail = lines.find(l => l.name === 'בדיקה');
      const without = lines.find(l => l.name === 'בדיקה2');
      assert.strictEqual(withMail.email, 'a@b.co');
      assert.strictEqual(without.email, null);
      assert.strictEqual(withMail.context.conversation_id, 'ctest');
    });
    await t('the board the customer chose on the card reaches the lead (Tomer, 10/09)', async () => {
      const ok = await post(port, '/api/lead', {
        name: 'בדיקה3', phone: '0503333333',
        context: { kind: 'customer', hotel: 'Strass', room: 'DBL 2-2', board: 'חצי פנסיון', conversation_id: 'ctest3' },
      });
      assert.strictEqual(ok.status, 200);
      const lines = fs.readFileSync(file, 'utf8').slice(before).trim().split('\n').map(JSON.parse);
      const rec = lines.find(l => l.name === 'בדיקה3');
      assert.strictEqual(rec.context.board, 'חצי פנסיון');
      const crm = require('../server/crm-lead.js').toCrm(rec);
      assert.strictEqual(crm.offer.board, 'חצי פנסיון');
    });
    await t('name and phone are still required', async () => {
      assert.strictEqual((await post(port, '/api/lead', { name: 'רק שם' })).status, 400);
    });
  } finally { await stopServer(srv); }
}

/* The shape the CRM receives (server/crm-lead.js). Whoever maps this into
   Priority / Monday / Make writes that mapping once — so these tests exist to
   make a silent rename impossible. */
async function crm() {
  const crmLead = require('../server/crm-lead.js');
  const FULL = {
    ...REC,
    context: {
      ...REC.context,
      request: {
        adults: 2, children_ages: [5, 9], month: 2, country: 'austria',
        needs_hebrew_kids_club: true, no_saturday_flights: true,
        preferences: ['ספא'], notes_from_customer: ['חוגגים יום נישואין'],
        nights_wanted: 7, departure_airport: 'tlv',
      },
      consent: { privacy: true, at: '2026-08-26T18:00:00.000Z', text: 'מאשר' },
    },
  };

  await t('the payload is versioned, so a CRM mapping can pin what it expects', () => {
    const out = crmLead.toCrm(FULL);
    assert.strictEqual(out.schema, 'pingwin.lead/1');
    assert.strictEqual(out.lead_id, 'labc');
    assert.strictEqual(out.source, 'web-chat');
  });

  await t('the customer, the request and the offer each arrive as flat fields', () => {
    const out = crmLead.toCrm(FULL);
    assert.strictEqual(out.customer.name, 'תומר כהן');
    assert.strictEqual(out.customer.phone, '0501234567');
    assert.strictEqual(out.request.adults, 2);
    assert.deepStrictEqual(out.request.children_ages, [5, 9]);
    assert.strictEqual(out.request.children_count, 2);
    assert.strictEqual(out.request.party_size, 4);
    assert.strictEqual(out.request.month_he, 'פברואר');
    assert.strictEqual(out.request.country_he, 'אוסטריה');
    assert.strictEqual(out.request.hebrew_kids_club, true);
    assert.strictEqual(out.request.no_saturday_flights, true);
    assert.deepStrictEqual(out.request.preferences, ['ספא']);
    assert.deepStrictEqual(out.request.notes, ['חוגגים יום נישואין']);
    assert.strictEqual(out.offer.hotel, 'Hotel Ferienhof');
    assert.strictEqual(out.offer.date, '2027-01-09');
  });

  await t('the conversation id travels with the lead — it is how a rep finds the chat', () => {
    assert.strictEqual(crmLead.toCrm(FULL).conversation.id, 'cxyz');
  });

  await t('RED RULE 3: no price ever leaves on the wire', () => {
    const priced = { ...FULL, context: { ...FULL.context, price_range: '₪₪₪', price: 4500 } };
    const json = JSON.stringify(crmLead.toCrm(priced));
    assert.ok(!/price|₪|4500/.test(json), 'a price reached the CRM payload: ' + json.slice(0, 200));
  });

  await t('only whitelisted fields cross — internal slots never reach the CRM', () => {
    const dirty = { ...FULL, context: { ...FULL.context,
      request: { ...FULL.context.request, _cid: 'secret', _vt: 'stamp', _asked: ['adults'] } } };
    const json = JSON.stringify(crmLead.toCrm(dirty));
    assert.ok(!/_cid|_vt|_asked|secret|stamp/.test(json), 'an internal field leaked: ' + json.slice(0, 200));
  });

  await t('an older widget that sends only `party` still produces a usable lead', () => {
    const old = { ...REC };                       // no context.request at all
    const out = crmLead.toCrm(old);
    assert.strictEqual(out.request.adults, 2);
    assert.deepStrictEqual(out.request.children_ages, [5, 9]);
  });

  await t('a lead with no offer is legitimate and does not crash the mapping', () => {
    const out = crmLead.toCrm({ id: 'l1', at: 'now', name: 'א', phone: '0500000000', context: {} });
    assert.strictEqual(out.offer, null);
    assert.strictEqual(out.kind, 'customer');
  });
}

(async () => {
  await unit();
  await crm();
  await integration();
  console.log(`lead: ${pass} passed, ${fail} failed`);
  // a beat for libuv to finish closing the child and the keep-alive sockets
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})();
