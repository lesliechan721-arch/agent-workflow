import path from 'node:path';
import { spawn } from 'node:child_process';

const npmExecPath = process.env.npm_execpath?.trim();
if (!npmExecPath) {
  throw new Error('Cannot run dist tests because npm_execpath is missing. Run them through pnpm.');
}
const development = process.argv.slice(2).includes('--dev');

async function runPnpm(args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(npmExecPath), ...args], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(signal
        ? `Dist tests terminated by signal ${signal}.`
        : `Dist tests exited with code ${code}.`));
    });
  });
}

try {
  await runPnpm(['run', development ? 'build:dev' : 'build']);
  await runPnpm(['run', 'test:dist:contracts'], {
    ...process.env,
    AW_DIST_BUILD_MODE: development ? 'development' : 'release',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
