import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const syntheticProcessPath = fileURLToPath(
  new URL('../../../../scripts/test/synthetic-process.mjs', import.meta.url),
);

const descendant = spawn(
  process.execPath,
  [syntheticProcessPath],
  {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
descendant.unref();
process.stdout.write(`${descendant.pid}\n`);
process.exit(0);
