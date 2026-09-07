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
    w.kill();
    try { fs.unlinkSync(copy); } catch (e) { /* gone already */ }
  }
  /* ── pointed at the ROOT of a share ──────────────────────────────────────
     Which is what actually gets typed. The workbook sits in a Hebrew-named
     folder inside it, and a Hebrew path typed into a Windows console does not
     survive the code page — so being told the root and finding the rest is the
     difference between this working and not. */
  {
    const share = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
    const deep = path.join(share, 'מלאי', 'חורף 2027');
    fs.mkdirSync(deep, { recursive: true });
    fs.mkdirSync(path.join(share, 'חשבונות'));
    fs.mkdirSync(path.join(share, 'תמונות', '2026'), { recursive: true });
    fs.copyFileSync(WB, path.join(deep, 'טבלת התחייבויות חדרים חורף 2027.xlsm'));
    fs.writeFileSync(path.join(deep, '~$טבלת התחייבויות חדרים חורף 2027.xlsm'), 'lock');
    fs.writeFileSync(path.join(share, 'חשבונות', 'קטן.xlsx'), 'x');   // too small to be a season

    const n0 = pushes.length;
    const w3 = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'watch-inventory.js'), share], {
      env: { ...process.env, PINGWIN_BOT_URL: `http://127.0.0.1:${PORT}`, PINGWIN_WATCH_SECONDS: '2' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let log3 = '';
    w3.stdout.on('data', d => { log3 += d; }); w3.stderr.on('data', d => { log3 += d; });
    try {
      await waitFor(n0 + 1, 25000);
      t('given only the share it finds the workbook, folders down and in Hebrew', () => {
        assert.ok(pushes.length > n0, log3);
        assert.ok(/נמצא בתוך/.test(log3), 'did not say where it found it: ' + log3);
        assert.ok(/טבלת התחייבויות חדרים חורף 2027\.xlsm/.test(log3), log3);
        assert.ok(pushes[pushes.length - 1].units.length > 500);
      });
      t('and does not mistake a 1-byte xlsx for the season', () => {
        assert.ok(!/קטן\.xlsx/.test(log3), log3);
      });
    } finally {
      w3.kill();
      fs.rmSync(share, { recursive: true, force: true });
    }
  }

  // ── the two failures that look identical and are not ──
  {
    const run = target => new Promise(ok => {
      const c = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'watch-inventory.js'), target],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; });
      c.on('exit', code => ok({ code, out }));
    });
    const missing = await run(path.join(os.tmpdir(), 'no-such-folder-' + Date.now()));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-empty-'));
    const noBook = await run(empty);
    fs.rmSync(empty, { recursive: true, force: true });

    t('a wrong path and a folder with no workbook say different things', () => {
      // over a network share these have different fixes — one is a typo, the
      // other is "you are looking in the right place, the file is not there"
      assert.strictEqual(missing.code, 1);
      assert.ok(/הנתיב לא קיים/.test(missing.out), missing.out);
      assert.strictEqual(noBook.code, 1);
      assert.ok(/לא נמצא קובץ אקסל/.test(noBook.out), noBook.out);
      assert.ok(!/הנתיב לא קיים/.test(noBook.out), 'told him the path was wrong when it was not');
    });
    t('and both say what to type instead', () => {
      for (const r of [missing, noBook]) assert.ok(/npm run watch --/.test(r.out), r.out);
    });
  }

  srv.close();
  console.log(`watch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
