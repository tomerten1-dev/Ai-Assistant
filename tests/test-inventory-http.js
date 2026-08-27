'use strict';
/* The endpoint the office pushes to, over real HTTP — the security boundary.
   Run: node tests/test-inventory-http.js */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8831;
const TOKEN = 'a-long-shared-secret-for-the-test';
const AV = path.join(__dirname, '..', 'data', 'availability.json');
const original = fs.readFileSync(AV, 'utf8');

const post = (body, token, method = 'POST') => new Promise(res => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request({ port: PORT, path: '/api/inventory', method,
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {},
      method === 'POST' ? { 'content-length': Buffer.byteLength(data) } : {}) },
    r => { let t = ''; r.on('data', c => t += c); r.on('end', () => res({ status: r.statusCode, body: t })); });
  req.on('error', e => res({ status: 0, body: e.message }));
  if (method === 'POST') req.write(data);
  req.end();
});

(async () => {
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CHAT_LOG: 'off', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
      SITE_ROOMS: 'off', INVENTORY_TOKEN: TOKEN, ALLOWED_ORIGINS: 'https://www.pingwin.co.il' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ok, no) => {
    let out = '';
    srv.stdout.on('data', d => { out += d; if (out.includes('http://localhost')) ok(); });
    setTimeout(() => no(new Error('server did not start')), 8000);
  });

  const good = JSON.parse(original);
  good.generated_at = new Date().toISOString();

  try {
    let r = await post(good, null);
    t('no token, no entry', () => assert.strictEqual(r.status, 401));
    r = await post(good, 'wrong-token-of-the-same-length!!');
    t('a wrong token is refused even with a valid file', () => assert.strictEqual(r.status, 401));

    r = await post({ units: [{ hotel: 'משפחת לוי', room: 'x' }], generated_at: new Date().toISOString() }, TOKEN);
    t('a file with a customer name in it is refused', () => {
      assert.strictEqual(r.status, 422);
      assert.ok(/PII/.test(r.body), r.body);
    });

    r = await post('{ this is not json', TOKEN);
    t('a broken body does not take the server down', () => assert.ok(r.status >= 400 && r.status < 500, r.status));

    const before = fs.readFileSync(AV, 'utf8');
    r = await post(good, TOKEN);
    t('the real file, with the real token, is taken', () => {
      assert.strictEqual(r.status, 200, r.body);
      const got = JSON.parse(r.body);
      assert.ok(got.units > 0 && got.rooms > 0, r.body);
    });
    t('and every refusal above left the stock alone', () => {
      // the file only changed on the accepted push, not on any refused one
      assert.strictEqual(JSON.parse(before).units.length, JSON.parse(fs.readFileSync(AV, 'utf8')).units.length);
    });

    r = await post(null, TOKEN, 'GET');
    t('anyone can ask how old the stock is', () => {
      assert.strictEqual(r.status, 200);
      const s = JSON.parse(r.body);
      assert.ok(s.generated_at && s.age_hours != null && s.units > 0, r.body);
      assert.strictEqual(s.stale, false);
      assert.ok(s.last_push && s.last_push.ok, 'the push was not recorded');
    });

    // the widget's own rules must not have been loosened to let this in
    const chat = await new Promise(res => {
      const d = JSON.stringify({ messages: [{ role: 'user', content: 'היי' }], slots: {} });
      const q = http.request({ port: PORT, path: '/api/chat', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } },
        x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode })); });
      q.on('error', () => res({ status: 0 })); q.write(d); q.end();
    });
    t('a browser POST with no Origin is still refused', () => assert.strictEqual(chat.status, 403));
  } finally {
    srv.kill();
    fs.writeFileSync(AV, original);
  }
  console.log(`inventory-http: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
