import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const syntheticProcessPath = fileURLToPath(
  new URL('../../../../scripts/test/synthetic-process.mjs', import.meta.url),
);
const output = process.argv.includes('--ignore-output') ? 'ignore' : 'inherit';

const descendant = spawn(
  process.execPath,
  [syntheticProcessPath],
  {
    detached: true,
    stdio: ['ignore', output, output],
  },
);
descendant.unref();
process.stdout.write(`${descendant.pid}\n`);
process.exit(0);
