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

async function createPluginRepository(root: string): Promise<string> {
  const workspaceRoot = path.join(root, 'repo');
  for (const name of ['batch-target', 'batch-sibling']) {
    const pluginRoot = path.join(workspaceRoot, 'plugins', name);
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3,
      name,
      version: '0.1.0',
      description: 'Git batch validation fixture.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
    });
    // Identical files exercise blob deduplication across the full source set.
    await fs.outputFile(path.join(pluginRoot, 'README.md'), '# Batch Fixture\n');
  }
  // Exercise both tree and blob output beyond the pipe buffer boundary.
  const dataRoot = path.join(workspaceRoot, 'plugins', 'batch-sibling', 'data');
  await fs.ensureDir(dataRoot);
  for (let index = 0; index < 1024; index += 1) {
    await fs.writeFile(path.join(dataRoot, `file-${index}.txt`), 'Shared fixture content.\n');
  }
  await fs.writeFile(path.join(dataRoot, 'large-blob.txt'), 'x'.repeat(128 * 1024));
  await execFileAsync('git', ['init'], { cwd: workspaceRoot });
  await execFileAsync('git', ['add', 'plugins'], { cwd: workspaceRoot });
  await execFileAsync('git', [
    '-c', 'user.name=AW Test',
    '-c', 'user.email=aw-test@example.invalid',
    'commit', '-m', 'baseline',
  ], { cwd: workspaceRoot });
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('built Git cat-file batch validation', () => {
  const stubbornValidateTest = process.platform === 'win32' ? it.skip : it;
  stubbornValidateTest('force-kills a malformed batch child that ignores SIGTERM during validate', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-stubborn-git-test-'));
    tempDirs.push(root);
    const workspaceRoot = await createPluginRepository(root);
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
      "  const child = spawn(process.env.AW_REAL_GIT, args, { stdio: ['inherit', 'pipe', 'pipe'] });",
      "  child.stdout.pipe(process.stdout);",
      "  child.stderr.pipe(process.stderr);",
      "  child.on('error', (error) => { console.error(error.message); process.exitCode = 127; });",
      "  child.on('close', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });",
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
      path.join(workspaceRoot, 'plugins', 'batch-target'),
      '--workspace-root',
      workspaceRoot,
      '--json',
    ], {
      cwd: workspaceRoot,
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
    const workspaceRoot = await createPluginRepository(root);
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
      "const child = spawn(process.env.AW_REAL_GIT, args, { stdio: ['pipe', 'pipe', 'pipe'] });",
      "child.stdout.pipe(process.stdout);",
      "child.stderr.pipe(process.stderr);",
      "if (args[0] === 'cat-file' && args[1] === '--batch') process.stdin.on('data', (chunk) => appendFileSync(process.env.AW_GIT_BATCH_INPUT, chunk));",
      "process.stdin.pipe(child.stdin);",
      "child.on('error', (error) => { console.error(error.message); process.exitCode = 127; });",
      "child.on('close', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });",
    ].join('\n'), 'utf8');
    await fs.chmod(path.join(binRoot, 'git'), 0o755);

    const validation = await execFileAsync(process.execPath, [
      validatePluginScriptPath(),
      path.join(workspaceRoot, 'plugins', 'batch-target'),
      '--workspace-root',
      workspaceRoot,
      '--json',
    ], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        AW_GIT_CALL_LOG: logPath,
        AW_GIT_BATCH_INPUT: batchInputPath,
        AW_REAL_GIT: realGit,
        PATH: `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      maxBuffer: 20 * 1024 * 1024,
    }).catch((error) => {
      throw new Error(`Plugin validation failed:\n${error.stdout}\n${error.stderr}`, { cause: error });
    });
    expect(validation.stderr).toBe('');
    expect(JSON.parse(validation.stdout)).toMatchObject({
      ok: true,
      errors: [],
      versionCheck: {
        ok: true,
        checkedPlugins: 1,
        checks: [{ plugin: 'batch-target', status: 'unchanged' }],
      },
    });
    const calls = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.filter((args) => args[0] === 'cat-file')).toEqual([['cat-file', '--batch']]);
    expect(calls.length).toBeLessThanOrEqual(5);
    const requestedObjectIds = (await fs.readFile(batchInputPath, 'ascii')).trim().split('\n');
    expect(new Set(requestedObjectIds).size).toBe(requestedObjectIds.length);
    const tree = await execFileAsync(realGit, ['ls-tree', '-r', '-z', 'HEAD', '--', 'plugins'], {
      cwd: workspaceRoot,
      encoding: null,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(tree.stdout.length).toBeGreaterThan(64 * 1024);
    const treeObjectIds = tree.stdout.toString('utf8').split('\0').filter(Boolean).map((record) => (
      record.slice(0, record.indexOf('\t')).split(' ')[2]
    ));
    expect(new Set(treeObjectIds).size).toBeLessThan(treeObjectIds.length);
    expect(requestedObjectIds).toEqual([...new Set(treeObjectIds)]);
  }, 30_000);
});
