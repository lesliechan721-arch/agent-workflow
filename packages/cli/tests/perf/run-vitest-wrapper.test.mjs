import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const wrapperPath = path.join(repositoryRoot, 'scripts/test/run-vitest.mjs');
const roots = [];
const observedPids = [];
const observedProcessGroups = [];
const itOnPosix = process.platform === 'win32' ? it.skip : it;
const hostProcessInspectionAvailable = process.platform !== 'win32' &&
  spawnSync('ps', ['-Ao', 'pid=,ppid=,lstart='], { stdio: 'ignore' }).status === 0;
const itWithPosixInspection = hostProcessInspectionAvailable ? it : it.skip;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonEventually(filePath, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = performance.now() + timeoutMs;
  while (isProcessAlive(pid) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createFixture(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-vitest-wrapper-'));
  roots.push(root);
  const packageRoot = path.join(root, 'node_modules/vitest');
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"private":true}\n');
  await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: 'vitest',
    version: '0.0.0-test',
    exports: { './package.json': './package.json' },
  }));
  await fs.writeFile(path.join(packageRoot, 'vitest.mjs'), source);
  return root;
}

async function createRealVitestFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-real-vitest-wrapper-'));
  roots.push(root);
  const packageRoot = path.join(root, 'node_modules/vitest');
  const realPackageRoot = await fs.realpath(
    path.join(repositoryRoot, 'packages/cli/node_modules/vitest'),
  );
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.symlink(realPackageRoot, packageRoot, 'dir');
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: {
      test: `node ${JSON.stringify(wrapperPath)} run tests/hang.test.mjs`,
    },
  }));
  await fs.writeFile(path.join(root, 'tests/hang.test.mjs'), [
    "import fs from 'node:fs';",
    "import { test } from 'vitest';",
    "test('hangs in a real worker', async () => {",
    "  fs.writeFileSync(process.env.WORKER_PID_FILE, JSON.stringify({ worker: process.pid }));",
    "  await new Promise(() => {});",
    "});",
  ].join('\n'));
  return root;
}

async function createPsShim(root, failFile) {
  const binDir = path.join(root, 'bin');
  const realPs = spawnSync('which', ['ps'], { encoding: 'utf8' }).stdout.trim();
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'ps'), [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    `if (fs.existsSync(${JSON.stringify(failFile)})) process.exit(1);`,
    `const result = spawnSync(${JSON.stringify(realPs)}, process.argv.slice(2), { stdio: 'inherit' });`,
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  await fs.chmod(path.join(binDir, 'ps'), 0o755);
  return binDir;
}

function spawnWrapper(cwd, args, env) {
  const child = spawn(process.execPath, [wrapperPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
}

afterEach(async () => {
  for (const pid of observedProcessGroups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The process group already exited.
    }
  }
  for (const pid of observedPids.splice(0)) {
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process exited between the check and the signal.
      }
    }
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Vitest process-tree wrapper', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('returns %s convention for an interrupted Vitest process', async (signal, expectedCode) => {
    const fixture = await createFixture([
      "import fs from 'node:fs';",
      "fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ root: process.pid }));",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGINT', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const pidFile = path.join(fixture, 'pid.json');
    const run = spawnWrapper(fixture, ['run'], { PID_FILE: pidFile });
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.root);
    run.child.kill(signal);

    await expect(run.closed).resolves.toMatchObject({ code: expectedCode, signal: null });
  });

  itWithPosixInspection('forwards arguments, output, and exit code while cleaning inherited-output descendants', async () => {
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    foreign.unref();
    observedPids.push(foreign.pid);
    const fixture = await createFixture([
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ root: process.pid, descendant: descendant.pid, args: process.argv.slice(2) }));",
      "process.stdout.write('fixture stdout\\n');",
      "process.stderr.write('fixture stderr\\n');",
      'setTimeout(() => process.exit(7), 500);',
    ].join('\n'));
    const pidFile = path.join(fixture, 'pids.json');
    const run = spawnWrapper(fixture, ['run', '--config', 'fixture.config.ts'], { PID_FILE: pidFile });
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.root, pids.descendant);
    const result = await run.closed;
    await waitForExit(pids.descendant);

    expect(result).toMatchObject({ code: 7, signal: null });
    expect(result.stdout).toContain('fixture stdout');
    expect(result.stderr).toContain('fixture stderr');
    expect(pids.args).toEqual(['run', '--config', 'fixture.config.ts']);
    expect(isProcessAlive(pids.descendant)).toBe(false);
    expect(isProcessAlive(foreign.pid)).toBe(true);
  });

  itWithPosixInspection.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('keeps handling repeated %s while it cleans its tree', async (signal, expectedCode) => {
    const fixture = await createFixture([
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' });",
      "fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ root: process.pid, descendant: descendant.pid }));",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGINT', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const pidFile = path.join(fixture, 'pids.json');
    const run = spawnWrapper(fixture, ['run'], { PID_FILE: pidFile });
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.root, pids.descendant);
    const interruptedAt = performance.now();
    run.child.kill(signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    run.child.kill(signal);
    const result = await run.closed;
    await Promise.all([waitForExit(pids.root), waitForExit(pids.descendant)]);

    expect(result).toMatchObject({ code: expectedCode, signal: null });
    expect(performance.now() - interruptedAt).toBeLessThan(1_400);
    expect(isProcessAlive(pids.root)).toBe(false);
    expect(isProcessAlive(pids.descendant)).toBe(false);
  });

  itWithPosixInspection('cleans a real Vitest worker after repeated SIGINT through pnpm', async () => {
    const fixture = await createRealVitestFixture();
    const workerPidFile = path.join(fixture, 'worker.pid');
    const pnpmExecPath = process.env.npm_execpath;
    const command = pnpmExecPath ? process.execPath : 'pnpm';
    const args = pnpmExecPath ? [pnpmExecPath, 'test'] : ['test'];
    const run = spawn(command, args, {
      cwd: fixture,
      env: { ...process.env, WORKER_PID_FILE: workerPidFile },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    observedProcessGroups.push(run.pid);
    observedPids.push(run.pid);
    const closed = new Promise((resolve, reject) => {
      run.once('error', reject);
      run.once('close', (code, signal) => resolve({ code, signal }));
    });
    const { worker: workerPid } = await readJsonEventually(workerPidFile);
    observedPids.push(workerPid);

    process.kill(-run.pid, 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      process.kill(-run.pid, 'SIGINT');
    } catch {
      // The pnpm foreground process group can already have exited.
    }
    await closed;
    await waitForExit(workerPid, 3_000);

    expect(isProcessAlive(workerPid)).toBe(false);
  });

  itWithPosixInspection('reports cleanup verification failure instead of hiding it as SIGINT', async () => {
    const fixture = await createFixture([
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
      "fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ root: process.pid, descendant: descendant.pid }));",
      "process.on('SIGINT', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const binDir = path.join(fixture, 'bin');
    const failFile = path.join(fixture, 'fail-ps');
    const pidFile = path.join(fixture, 'pids.json');
    await createPsShim(fixture, failFile);
    const run = spawnWrapper(fixture, ['run'], {
      PID_FILE: pidFile,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    });
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.root, pids.descendant);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.writeFile(failFile, '1');
    run.child.kill('SIGINT');
    const result = await run.closed;

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cleanup could not verify descendant termination');
  });

  itOnPosix('fails cleanup without leaking a worker when snapshots never establish ownership', async () => {
    const fixture = await createFixture([
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const worker = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ root: process.pid, worker: worker.pid }));",
      "process.on('SIGINT', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const failFile = path.join(fixture, 'fail-ps');
    const pidFile = path.join(fixture, 'pids.json');
    const binDir = await createPsShim(fixture, failFile);
    await fs.writeFile(failFile, '1');
    const run = spawnWrapper(fixture, ['run'], {
      PID_FILE: pidFile,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    });
    const pids = await readJsonEventually(pidFile);
    observedPids.push(pids.root, pids.worker);
    run.child.kill('SIGINT');
    const result = await run.closed;
    await waitForExit(pids.worker);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cleanup could not verify process-tree ownership');
    expect(isProcessAlive(pids.worker)).toBe(false);
  });
});
