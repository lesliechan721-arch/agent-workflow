import { spawnSync } from 'node:child_process';

const result = spawnSync('agent-browser', ['--version'], { stdio: 'ignore', timeout: 5000 });
if (result.error || result.status !== 0) {
  console.error('agent-browser is unavailable on PATH. Install it first, then retry browser-use installation.');
  process.exitCode = 1;
}
