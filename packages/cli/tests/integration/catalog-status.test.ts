import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-status-'));
  roots.push(root);
  return root;
}

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function createWorkspace(root: string, pluginName: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: root });
  await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
  await runCli([
    'plugin', 'init', pluginName, '--description', `${pluginName} status fixture.`,
    '--no-skills', '--workspace-root', root,
  ], { cwd: root, io: capture().io });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial',
  ], { cwd: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

describe('Catalog static status CLI', () => {
  it('reports Workspace, inventory, dependency, snapshot, and Git facts without output writes', async () => {
    const root = await createRoot();
    await createWorkspace(root, 'static-demo');
    const output = capture();

    expect(await runCli(['catalog', 'status', '--workspace-root', root, '--json'], {
      cwd: root,
      io: output.io,
    })).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 2,
      command: 'catalog:status',
      ok: true,
      workspace: { valid: true, identity: expect.any(String) },
      catalog: { valid: true, version: '0.1.0', channel: 'latest' },
      plugins: [{ name: 'static-demo', version: '0.1.0', dependencies: [], sourceValid: true }],
      dependencyGraph: { valid: true, order: ['static-demo'] },
      git: { checked: true, sourceHead: expect.any(String), clean: true },
      snapshot: { state: 'absent', valid: false },
      issues: [],
    });
    expect(JSON.parse(output.stdout())).not.toHaveProperty('publication');
    expect(output.stderr()).toBe('');
    await expect(fs.pathExists(path.join(root, '.aw'))).resolves.toBe(false);

    const human = capture();
    expect(await runCli(['catalog', 'status', '--workspace-root', root], {
      cwd: root,
      io: human.io,
    })).toBe(0);
    expect(human.stdout()).toContain('Snapshot: absent');
    expect(human.stdout()).not.toContain('Publication');
  });

  it('reports a dirty worktree as a non-blocking fact', async () => {
    const root = await createRoot();
    await createWorkspace(root, 'dirty-demo');
    await fs.outputFile(path.join(root, 'working.txt'), 'uncommitted\n');
    const output = capture();

    expect(await runCli(['catalog', 'status', '--workspace-root', root, '--json'], {
      cwd: root,
      io: output.io,
    })).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      ok: true,
      git: { checked: true, clean: false },
      issues: [],
    });
  });

  it('does not require Git for a valid static Workspace status', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    const output = capture();

    expect(await runCli(['catalog', 'status', '--workspace-root', root, '--json'], {
      cwd: root,
      io: output.io,
    })).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      ok: true,
      workspace: { valid: true },
      git: { checked: false, sourceHead: null, clean: null },
      issues: [],
    });
  });

  it('rejects removed publication options before status execution', async () => {
    const output = capture();

    expect(await runCli(['catalog', 'status', '--preflight', '--json'], { io: output.io })).toBe(1);
    expect(output.stderr()).toContain("unknown option '--preflight'");
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: 'catalog:status',
      ok: false,
      errors: [{ code: 'invalidArguments', message: expect.stringContaining('--preflight') }],
    });
  });
});
