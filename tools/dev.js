// `npm run dev` — pull the latest from GitHub, then start the server.
// One command for Tomer's laptop: no more "why is localhost old".
const { execSync, spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
try {
  const out = execSync('git pull --ff-only', { cwd: ROOT, stdio: 'pipe' }).toString();
  console.log(/Already up to date|Already up-to-date/.test(out) ? 'Already up to date.' : 'Pulled from GitHub:\n' + out.trim());
} catch (e) {
  console.error('git pull failed (starting the local version anyway):', (e.stderr || e.message).toString().trim());
}
try { execSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'ignore' }); } catch (e) { }
console.log('Starting the server... (Ctrl+C to stop)');
spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { cwd: ROOT, stdio: 'inherit' });
