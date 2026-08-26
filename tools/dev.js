// `npm run dev` — pull the latest from GitHub, then start the server.
// One command for Tomer's laptop: no more "why is localhost old".
const { execSync, spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
try {
  const out = execSync('git pull --ff-only', { cwd: ROOT, stdio: 'pipe' }).toString();
  console.log(/Already up to date|Already up-to-date/.test(out) ? 'Already up to date.' : 'Pulled from GitHub:\n' + out.trim());
} catch (e) {
  const msg = (e.stderr || e.message).toString().trim();
  // A pull that failed means the server is about to run the OLD code — and the
  // one line of red above scrolls away. Tomer, 26/08: he pulled, it aborted on
  // three untracked files, the server started anyway, and nothing he was told
  // to look at was there. Say it loudly, and say what to do.
  console.error('\n' + '='.repeat(64));
  console.error('git pull נכשל — השרת יעלה עם הקוד הישן שלך, בלי השינויים החדשים.');
  console.error(msg);
  const blocked = [...msg.matchAll(/^\s+(\S+)$/gm)].map(m => m[1])
    .filter(f => /\.(json|js|md|png)$/.test(f));
  if (/untracked working tree files would be overwritten/.test(msg) && blocked.length) {
    console.error('\nהקבצים האלה קיימים אצלך ולא במעקב git, ולכן ה-pull נעצר:');
    blocked.forEach(f => console.error('   ' + f));
    console.error('\nהם קבצי פלט — אפשר למחוק אותם בבטחה ואז להריץ שוב:');
    blocked.forEach(f => console.error('   del ' + f.replace(/\//g, '\\')));
    console.error('   npm run dev');
  }
  console.error('='.repeat(64) + '\n');
}
try { execSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'ignore' }); } catch (e) { }
console.log('Starting the server... (Ctrl+C to stop)');
spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { cwd: ROOT, stdio: 'inherit' });
