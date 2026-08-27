'use strict';
/* The watcher, running for real against a copy of the real workbook.
 *
 * The question it answers: if someone saves the commitments file, does the bot
 * know within the minute, without anybody doing anything? And the one that
 * decides whether this is safe to leave running — does it ever parse a file
 * that is still being written?
 *
 * Run: node tests/test-watch.js   (skipped without the workbook, which is
 * gitignored — it has customers' names in it)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const WB = path.join(__dirname, '..', 'source-data', 'commitments-winter-2027.xlsm');
if (!fs.existsSync(WB)) { console.log('watch: skipped (no workbook)'); process.exit(0); }

const PORT = 8841;
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

(async () => {
  const pushes = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      pushes.push(j);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ units: j.units.length, rooms: j.units.reduce((n, u) => n + u.count, 0), was: 0 }));
    });
  }).listen(PORT);

  // a copy, so the test never touches the real file
  const copy = path.join(os.tmpdir(), 'watch-test-' + process.pid + '.xlsm');
  fs.copyFileSync(WB, copy);

  const w = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'watch-inventory.js'), copy], {
    env: { ...process.env, PINGWIN_BOT_URL: `http://127.0.0.1:${PORT}`, PINGWIN_WATCH_SECONDS: '2' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  w.stdout.on('data', d => { log += d; });
  w.stderr.on('data', d => { log += d; });

  const waitFor = (n, ms) => new Promise(ok => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (pushes.length >= n || Date.now() - t0 > ms) { clearInterval(i); ok(); }
    }, 200);
  });

  try {
    await waitFor(1, 25000);
    t('it updates the bot as soon as it starts, without being asked', () => {
      assert.strictEqual(pushes.length, 1, log);
      assert.ok(pushes[0].units.length > 500, 'only ' + pushes[0].units.length + ' units');
    });

    // nothing changes: it must not push again
    await new Promise(r => setTimeout(r, 7000));
    t('and does nothing at all while the workbook sits still', () => {
      assert.strictEqual(pushes.length, 1, 're-pushed ' + pushes.length + ' times with no change');
    });

    // someone saves the workbook
    const t0 = Date.now();
    fs.writeFileSync(copy, fs.readFileSync(WB));
    await waitFor(2, 30000);
    t('a save reaches the bot on its own, in seconds', () => {
      assert.strictEqual(pushes.length, 2, log);
      assert.ok(Date.now() - t0 < 30000, 'took ' + (Date.now() - t0) + 'ms');
      assert.strictEqual(pushes[1].units.length, pushes[0].units.length);
    });

    // a file still being written must not be parsed — write it in pieces and
    // check nothing is pushed from the middle of that
    const full = fs.readFileSync(WB);
    const before = pushes.length;
    const fd = fs.openSync(copy, 'w');
    for (let i = 0; i < full.length; i += Math.ceil(full.length / 6)) {
      fs.writeSync(fd, full.subarray(i, i + Math.ceil(full.length / 6)));
      await new Promise(r => setTimeout(r, 900));
    }
    fs.closeSync(fd);
    await waitFor(before + 1, 30000);
    t('a workbook still being saved is left alone until it settles', () => {
      assert.ok(pushes.length >= before + 1, 'never picked up the finished file: ' + log);
      // every push is a whole season, never a fragment of one
      for (const p of pushes) assert.ok(p.units.length > 500, 'a truncated push: ' + p.units.length);
      assert.ok(/מחכה שיסיים/.test(log), 'it did not wait: ' + log);
    });

    t('nothing it sends carries a customer name', () => {
      const gate = require('../data/pii-gate.js');
      for (const p of pushes) assert.deepStrictEqual(gate.check(p), []);
    });
    w.kill();

    /* ── pointed at a FOLDER ──────────────────────────────────────────────
       Which is how it should be pointed: the workbook is named in Hebrew and
       gets renamed between seasons, and a path typed once into a setting is a
       path that goes stale without anyone noticing. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-folder-'));
    const hebrew = path.join(dir, 'התחייבויות חורף 2027.xlsm');
    fs.copyFileSync(WB, hebrew);
    // Excel's lock file, which appears the moment somebody opens the workbook
    // and is always the newest thing in the folder
    fs.writeFileSync(path.join(dir, '~$התחייבויות חורף 2027.xlsm'), 'lock');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a workbook');

    const n0 = pushes.length;
    const w2 = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'watch-inventory.js'), dir], {
      env: { ...process.env, PINGWIN_BOT_URL: `http://127.0.0.1:${PORT}`, PINGWIN_WATCH_SECONDS: '2' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = '';
    w2.stdout.on('data', d => { log2 += d; });
    w2.stderr.on('data', d => { log2 += d; });

    try {
      await waitFor(n0 + 1, 25000);
      t('given a folder it finds the workbook, whatever it is called', () => {
        assert.ok(pushes.length > n0, log2);
        assert.ok(/התחייבויות חורף 2027\.xlsm/.test(log2), 'did not name the file it chose: ' + log2);
        assert.ok(pushes[pushes.length - 1].units.length > 500);
      });
      t('and ignores the lock file Excel leaves beside it', () => {
        // it is newer than the workbook and four bytes long — picking it would
        // mean the bot stops updating the moment a person opens the file
        assert.ok(!/~\$/.test(log2), log2);
      });

      // next season's file arrives under a different name
      const n1 = pushes.length;
      const renamed = path.join(dir, 'התחייבויות חורף 2028.xlsm');
      fs.copyFileSync(WB, renamed);
      fs.utimesSync(renamed, new Date(), new Date());
      await waitFor(n1 + 1, 25000);
      t('a renamed or replaced workbook is picked up without touching a setting', () => {
        assert.ok(pushes.length > n1, log2);
        assert.ok(/הקובץ התחלף/.test(log2), 'switched in silence: ' + log2);
        assert.ok(/2028/.test(log2), log2);
      });
    } finally {
      w2.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    w.kill(); srv.close();
    try { fs.unlinkSync(copy); } catch (e) { /* gone already */ }
  }
  console.log(`watch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
