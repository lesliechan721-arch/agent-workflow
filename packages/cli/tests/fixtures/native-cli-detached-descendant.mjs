import { spawn } from 'node:child_process';

const descendant = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 10_000);'],
  {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
descendant.unref();
process.stdout.write(`${descendant.pid}\n`);
process.exit(0);
