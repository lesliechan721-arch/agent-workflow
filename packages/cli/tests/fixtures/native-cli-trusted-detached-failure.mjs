import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startSyntheticProcessWatchdog } from '../../../../scripts/test/synthetic-process.mjs';

const mode = process.argv[2];
if (!['abort', 'exit', 'timeout'].includes(mode)) {
  throw new Error(`Unknown failure mode: ${mode}`);
}

startSyntheticProcessWatchdog({ ttlMs: 10_000 });
const syntheticProcessPath = fileURLToPath(
  new URL('../../../../scripts/test/synthetic-process.mjs', import.meta.url),
);
const descendant = spawn(process.execPath, [syntheticProcessPath, '--ttl-ms', '10000'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit'],
});
descendant.unref();
process.stdout.write(`${descendant.pid}\n`);

if (mode === 'exit') process.exit(7);
setInterval(() => {}, 1_000);
