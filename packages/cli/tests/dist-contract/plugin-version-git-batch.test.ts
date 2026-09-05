import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function validatePluginScriptPath(): string {
  return path.join(
    repoRoot(),
    'packages',
    'cli',
    'dist',
    'authoring',
    'scripts',
    'validate-plugin.mjs',
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('built Git cat-file batch validation', () => {
  const stubbornValidateTest = process.platform === 'win32' ? it.skip : it;
  stubbornValidateTest('force-kills a malformed batch child that ignores SIGTERM during validate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-stubborn-git-test-'));
    tempDirs.push(root);
    const binRoot = path.join(root, 'bin');
    const pidPath = path.join(root, 'pid');
    const signalLogPath = path.join(root, 'signals.log');
    const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
    await fs.ensureDir(binRoot);
    await fs.writeFile(path.join(binRoot, 'git'), [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "const args = process.argv.slice(2);",
      "if (args[0] !== 'cat-file' || args[1] !== '--batch') {",
      "  const child = spawn(process.env.AW_REAL_GIT, args, { stdio: 'inherit' });",
      "  child.on('error', (error) => { console.error(error.message); process.exit(127); });",
      "  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });",
      "} else {",
      "  fs.writeFileSync(process.env.AW_FAKE_GIT_PID, String(process.pid));",
      "  process.on('SIGTERM', () => fs.appendFileSync(process.env.AW_FAKE_GIT_SIGNAL_LOG, 'TERM\\n'));",
      "  for await (const _chunk of process.stdin) {}",
      "  process.stdout.write('malformed header\\n');",
      "  setInterval(() => {}, 1000);",
      "}",
    ].join('\n'), 'utf8');
    await fs.chmod(path.join(binRoot, 'git'), 0o755);

    const startedAt = Date.now();
    const validation = execFileAsync(process.execPath, [
      validatePluginScriptPath(),
      path.join(repoRoot(), 'plugins', 'aw-plugin-development'),
      '--workspace-root',
      repoRoot(),
      '--json',
    ], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        AW_FAKE_GIT_PID: pidPath,
        AW_FAKE_GIT_SIGNAL_LOG: signalLogPath,
        AW_REAL_GIT: realGit,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    await expect(validation).rejects.toMatchObject({ code: 1 });
    try {
      await validation;
    } catch (error) {
      expect(JSON.parse((error as { stdout: string }).stdout).errors)
        .toEqual([expect.stringContaining('malformed header')]);
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await fs.readFile(signalLogPath, 'utf8')).toBe('TERM\n');
    const pid = Number(await fs.readFile(pidPath, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);

  it('uses one cat-file process and at most five Git processes for full-source validation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-git-count-test-'));
    tempDirs.push(root);
    const binRoot = path.join(root, 'bin');
    const logPath = path.join(root, 'git-calls.jsonl');
    const batchInputPath = path.join(root, 'cat-file-input.txt');
    await fs.ensureDir(binRoot);
    const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
    await fs.writeFile(path.join(binRoot, 'git'), [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "appendFileSync(process.env.AW_GIT_CALL_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
      "const args = process.argv.slice(2);",
      "const child = spawn(process.env.AW_REAL_GIT, args, { stdio: ['pipe', 'inherit', 'inherit'] });",
      "if (args[0] === 'cat-file' && args[1] === '--batch') process.stdin.on('data', (chunk) => appendFileSync(process.env.AW_GIT_BATCH_INPUT, chunk));",
      "process.stdin.pipe(child.stdin);",
      "child.on('error', (error) => { console.error(error.message); process.exit(127); });",
      "child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });",
    ].join('\n'), 'utf8');
    await fs.chmod(path.join(binRoot, 'git'), 0o755);

    await execFileAsync(process.execPath, [
      validatePluginScriptPath(),
      path.join(repoRoot(), 'plugins', 'aw-plugin-development'),
      '--workspace-root',
      repoRoot(),
      '--json',
    ], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        AW_GIT_CALL_LOG: logPath,
        AW_GIT_BATCH_INPUT: batchInputPath,
        AW_REAL_GIT: realGit,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    const calls = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === 'cat-file')).toEqual([['cat-file', '--batch']]);
    expect(calls.length).toBeLessThanOrEqual(5);
    const requestedObjectIds = (await fs.readFile(batchInputPath, 'ascii')).trim().split('\n');
    expect(new Set(requestedObjectIds).size).toBe(requestedObjectIds.length);
    const tree = await execFileAsync(realGit, ['ls-tree', '-r', '-z', 'HEAD', '--', 'plugins'], {
      cwd: repoRoot(),
      encoding: null,
      maxBuffer: 20 * 1024 * 1024,
    });
    const treeObjectIds = tree.stdout.toString('utf8').split('\0').filter(Boolean).map((record) => (
      record.slice(0, record.indexOf('\t')).split(' ')[2]
    ));
    expect(new Set(treeObjectIds).size).toBeLessThan(treeObjectIds.length);
    expect(requestedObjectIds).toEqual([...new Set(treeObjectIds)]);
  }, 30_000);
});
