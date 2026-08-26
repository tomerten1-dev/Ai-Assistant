'use strict';
/* Stage C guards: rate limits, turn cap, budget, timeout, Turnstile stamp,
   strict origin, /healthz, /api/config, versioned cache. Spawns the server. */
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const limits = require('../server/limits.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; }, e => { fail++; console.error('✗', name, '\n  ', e.message); });
}

/* ---- unit: limits.js ---- */
async function unit() {
  await t('rate: chat limit per minute', () => {
    process.env.RATE_CHAT_PER_MIN = '3';
    limits._buckets.clear();
    assert.strictEqual(limits.checkRate('chat', '1.1.1.1'), null);
    assert.strictEqual(limits.checkRate('chat', '1.1.1.1'), null);
    assert.strictEqual(limits.checkRate('chat', '1.1.1.1'), null);
    const wait = limits.checkRate('chat', '1.1.1.1');
    assert.ok(wait > 0 && wait <= 60, 'fourth call blocked with retry-after');
    assert.strictEqual(limits.checkRate('chat', '2.2.2.2'), null, 'another ip unaffected');
    delete process.env.RATE_CHAT_PER_MIN;
  });
  await t('rate: window resets', () => {
    limits._buckets.clear();
    process.env.RATE_LEAD_PER_10MIN = '1';
    const now = 1_000_000;
    assert.strictEqual(limits.checkRate('lead', 'x', now), null);
    assert.ok(limits.checkRate('lead', 'x', now + 1000) > 0);
    assert.strictEqual(limits.checkRate('lead', 'x', now + 600_001), null);
    delete process.env.RATE_LEAD_PER_10MIN;
  });
  await t('turn cap', () => {
    process.env.MAX_TURNS_PER_CHAT = '2';
    const s = {};
    assert.strictEqual(limits.turnsExceeded(s), false);
    assert.strictEqual(limits.turnsExceeded(s), false);
    assert.strictEqual(limits.turnsExceeded(s), true);
    assert.strictEqual(s._turns, 3);
    delete process.env.MAX_TURNS_PER_CHAT;
  });
  await t('daily budget', () => {
    process.env.DAILY_BUDGET_USD = '1';
    const d0 = Date.UTC(2026, 0, 1, 10);
    assert.strictEqual(limits.budgetExceeded(0.2, d0), false);
    assert.strictEqual(limits.budgetExceeded(1.3, d0), true);
    assert.strictEqual(limits.budgetExceeded(1.3, d0 + 86_400_000), false, 'new day, new budget');
    delete process.env.DAILY_BUDGET_USD;
    assert.strictEqual(limits.budgetExceeded(999), false, 'unset = unlimited');
  });
  await t('timeout', async () => {
    const slow = new Promise(r => setTimeout(() => r('late'), 200));
    assert.strictEqual(await limits.withTimeout(slow, 20, () => 'fallback'), 'fallback');
    assert.strictEqual(await limits.withTimeout(Promise.resolve('fast'), 20, () => 'fallback'), 'fast');
  });
  await t('turnstile stamp', () => {
    process.env.TURNSTILE_SECRET = 'test-secret';
    assert.ok(limits.turnstileOn());
    const st = limits.stamp('c123');
    assert.ok(limits.stampValid({ _cid: 'c123', _vt: st }));
    assert.ok(!limits.stampValid({ _cid: 'c124', _vt: st }), 'stamp is bound to the conversation');
    assert.ok(!limits.stampValid({ _cid: 'c123', _vt: 'forged' }));
    assert.ok(!limits.stampValid(null));
    delete process.env.TURNSTILE_SECRET;
    assert.ok(!limits.turnstileOn());
  });
  await t('turnstile verify: no token / failing endpoint → false', async () => {
    process.env.TURNSTILE_SECRET = 's';
    assert.strictEqual(await limits.verifyTurnstile('', '1.1.1.1'), false);
    assert.strictEqual(await limits.verifyTurnstile('tok', '1.1.1.1', async () => { throw new Error('down'); }), false);
    assert.strictEqual(await limits.verifyTurnstile('tok', '1.1.1.1', async () => ({ json: async () => ({ success: true }) })), true);
    delete process.env.TURNSTILE_SECRET;
  });
  await t('client ip honours TRUST_PROXY only when set', () => {
    const req = { headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    delete process.env.TRUST_PROXY;
    assert.strictEqual(limits.clientIp(req), '127.0.0.1');
    process.env.TRUST_PROXY = '1';
    assert.strictEqual(limits.clientIp(req), '9.9.9.9');
    delete process.env.TRUST_PROXY;
  });
}

/* ---- integration: real server ---- */
function startServer(env, port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
      env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', d => { out += d; if (out.includes('http://localhost')) resolve(p); });
    p.stderr.on('data', () => { });
    p.on('exit', c => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
}
async function post(port, pathname, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
}

async function integration() {
  const port = 8801;
  let srv = await startServer({ RATE_CHAT_PER_MIN: '4', RATE_LEAD_PER_10MIN: '3', MAX_TURNS_PER_CHAT: '3', ALLOWED_ORIGINS: '*' }, port);
  try {
    await t('healthz + config', async () => {
      const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      assert.strictEqual(h.ok, true); assert.strictEqual(h.mode, 'offline'); assert.ok(h.version);
      const c = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
      assert.strictEqual(c.turnstile, null); assert.strictEqual(c.version, h.version);
    });
    await t('versioned widget is cacheable, unversioned is not', async () => {
      const a = await fetch(`http://127.0.0.1:${port}/pingwin-bot.js?v=1`);
      assert.ok(a.headers.get('cache-control').includes('max-age'));
      const b = await fetch(`http://127.0.0.1:${port}/pingwin-bot.js`);
      assert.strictEqual(b.headers.get('cache-control'), 'no-cache');
      assert.strictEqual(a.headers.get('x-content-type-options'), 'nosniff');
    });
    await t('oversized body is dropped (before the limiter counts it)', async () => {
      let threw = false;
      try { await post(port, '/api/lead', { messages: [{ role: 'user', content: 'x'.repeat(40_000) }] }); }
      catch { threw = true; }
      assert.ok(threw, 'connection closed without a reply');
    });
    await t('chat: turn cap hands over to a human', async () => {
      let slots = {};
      let last;
      for (let i = 0; i < 4; i++) {
        last = await post(port, '/api/chat', { messages: [{ role: 'user', content: 'שלום' }], slots });
        assert.strictEqual(last.status, 200);
        slots = last.json.slots;
      }
      assert.strictEqual(slots._turns, 4);
      assert.strictEqual(last.json.open_lead_form, true);
      assert.ok(/נציג/.test(last.json.reply_he));
      assert.ok(!/\d/.test(last.json.reply_he.replace(/04-8557722/, '')), 'no numbers besides the phone');
    });
    await t('chat: 5th message in a minute → 429 with a polite Hebrew line', async () => {
      const r = await post(port, '/api/chat', { messages: [{ role: 'user', content: 'שלום' }], slots: {} });
      assert.strictEqual(r.status, 429);
      assert.ok(r.headers.get('retry-after'));
      assert.ok(/רגע/.test(r.json.reply_he));
    });
    await t('lead: 4th in 10 minutes → 429 (the oversized one counted)', async () => {
      const lead = { name: 'בדיקה', phone: '0501234567', context: { kind: 'customer' } };
      assert.strictEqual((await post(port, '/api/lead', lead)).status, 200);
      assert.strictEqual((await post(port, '/api/lead', lead)).status, 200);
      assert.strictEqual((await post(port, '/api/lead', lead)).status, 429);
    });
  } finally { srv.kill(); }

  srv = await startServer({ ALLOWED_ORIGINS: 'https://www.pingwin.co.il', TURNSTILE_SECRET: 'unit', TURNSTILE_SITEKEY: 'site' }, port + 1);
  try {
    const p2 = port + 1;
    const ORIGIN = { origin: 'https://www.pingwin.co.il' };
    await t('strict origin: POST without Origin → 403, wrong origin → 403, right one → ok', async () => {
      assert.strictEqual((await post(p2, '/api/lead', { name: 'א', phone: '0501234567' })).status, 403);
      assert.strictEqual((await post(p2, '/api/lead', { name: 'א', phone: '0501234567' }, { origin: 'https://evil.example' })).status, 403);
      const ok = await post(p2, '/api/config', {}, ORIGIN); // any route with the right origin passes CORS
      assert.notStrictEqual(ok.status, 403);
    });
    await t('turnstile: config exposes the site key; chat without a token → 403 verify', async () => {
      const c = await (await fetch(`http://127.0.0.1:${p2}/api/config`)).json();
      assert.strictEqual(c.turnstile, 'site');
      const r = await post(p2, '/api/chat', { messages: [{ role: 'user', content: 'שלום' }], slots: {} }, ORIGIN);
      assert.strictEqual(r.status, 403); assert.strictEqual(r.json.verify, true);
      assert.ok(/רעננו/.test(r.json.reply_he));
    });
    await t('turnstile: a valid stamp skips verification', async () => {
      process.env.TURNSTILE_SECRET = 'unit';
      const slots = { _cid: 'cabc', _vt: limits.stamp('cabc') };
      delete process.env.TURNSTILE_SECRET;
      const r = await post(p2, '/api/chat', { messages: [{ role: 'user', content: 'שלום' }], slots }, ORIGIN);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.slots._vt, slots._vt, 'stamp survives the turn');
      assert.strictEqual(r.json.slots._cid, 'cabc');
      const l = await post(p2, '/api/lead', { name: 'בדיקה', phone: '0501234567', context: { slots } }, ORIGIN);
      assert.strictEqual(l.status, 200);
      const bad = await post(p2, '/api/lead', { name: 'בדיקה', phone: '0501234567', context: { slots: { _cid: 'cabc', _vt: 'forged' } } }, ORIGIN);
      assert.strictEqual(bad.status, 403);
    });
  } finally { srv.kill(); }
}

(async () => {
  await unit();
  await integration();
  console.log(`limits: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
