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
    run.child.kill(signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    run.child.kill(signal);
    const result = await run.closed;
    await Promise.all([waitForExit(pids.root), waitForExit(pids.descendant)]);

    expect(result).toMatchObject({ code: expectedCode, signal: null });
    expect(isProcessAlive(pids.root)).toBe(false);
    expect(isProcessAlive(pids.descendant)).toBe(false);
  });
});
