import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-workspace-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)));
});

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

async function createPublishWorkspace(root: string, pluginName: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: root });
  await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
  await runCli([
    'plugin', 'init', pluginName, '--description', `${pluginName} publication fixture.`,
    '--no-skills', '--workspace-root', root,
  ], { cwd: root, io: capture().io });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-m', 'initial',
  ], { cwd: root });
}

describe('public workspace authoring commands', () => {
  it('initializes and versions a non-Git workspace with one JSON stdout object', async () => {
    const root = await createRoot();
    const initOutput = capture();
    expect(await runCli(['catalog', 'init', '--workspace-root', root, '--json'], {
      cwd: root,
      io: initOutput.io,
    })).toBe(0);
    expect(JSON.parse(initOutput.stdout())).toMatchObject({
      command: 'catalog:init',
      ok: true,
      catalogVersion: '0.1.0',
    });
    expect(initOutput.stderr()).toBe('');

    const versionOutput = capture();
    expect(await runCli(['catalog', 'version', '1.0.0-beta.1', '--workspace-root', root, '--json'], {
      cwd: root,
      io: versionOutput.io,
    })).toBe(0);
    expect(JSON.parse(versionOutput.stdout())).toMatchObject({
      command: 'catalog:version',
      ok: true,
      catalogVersion: '1.0.0-beta.1',
    });
  });

  it('rejects removed --repo-root and reports JSON failures safely', async () => {
    const root = await createRoot();
    const removed = capture();
    expect(await runCli(['catalog', 'init', '--repo-root', root], { cwd: root, io: removed.io }))
      .toBe(1);
    expect(removed.stderr()).toContain('unknown option');

    const removedJson = capture();
    expect(await runCli(['catalog', 'init', '--repo-root', root, '--json'], {
      cwd: root,
      io: removedJson.io,
    })).toBe(1);
    expect(JSON.parse(removedJson.stdout())).toMatchObject({
      command: 'catalog:init',
      ok: false,
      errors: [{ code: 'invalidArguments' }],
    });

    const invalid = capture();
    expect(await runCli(['catalog', 'version', 'not-semver', '--workspace-root', root, '--json'], {
      cwd: root,
      io: invalid.io,
    })).toBe(1);
    expect(JSON.parse(invalid.stdout())).toMatchObject({ command: 'catalog:version', ok: false });
    expect(invalid.stderr()).not.toBe('');
  });

  it('reports current status without Git and requires Git only for an explicit base', async () => {
    const root = await createRoot();
    await fs.ensureDir(path.join(root, 'plugins', 'demo', '.agents-plugin'));
    await fs.writeJson(path.join(root, 'plugins', 'demo', '.agents-plugin', 'plugin.json'), {
      schemaVersion: 1,
      name: 'demo',
      version: '0.1.0',
      description: 'Demo plugin.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    });
    const current = capture();
    expect(await runCli(['plugin', 'status', 'demo', '--workspace-root', root, '--json'], {
      cwd: root,
      io: current.io,
    })).toBe(0);
    expect(JSON.parse(current.stdout())).toMatchObject({
      ok: true,
      base: null,
      checks: [{ plugin: 'demo', status: 'current', currentVersion: '0.1.0' }],
    });

    const diff = capture();
    expect(await runCli([
      'plugin', 'status', 'demo', '--base', 'HEAD', '--workspace-root', root, '--json',
    ], { cwd: root, io: diff.io })).toBe(1);
    expect(diff.stderr()).toMatch(/Git|git/u);
  });

  it('completes the local author loop in a private non-Git package workspace', async () => {
    const root = await createRoot();
    await fs.writeJson(path.join(root, 'package.json'), { private: true });
    expect(await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'plugin', 'init', 'private-demo',
      '--description', 'Private workspace demo plugin.',
      '--no-skills',
      '--with-mcp',
      '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    expect(await runCli([
      'plugin', 'validate', 'plugins/private-demo', '--workspace-root', root, '--json',
    ], { cwd: root })).toBe(0);

    const testOutput = capture();
    expect(await runCli([
      'plugin', 'test', 'plugins/private-demo', '--workspace-root', root, '--json',
    ], { cwd: root, io: testOutput.io })).toBe(0);
    expect(JSON.parse(testOutput.stdout())).toMatchObject({ ok: true, exitCode: 0 });

    expect(await runCli([
      'plugin', 'build', 'plugins/private-demo', '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    expect(await runCli(['catalog', 'build', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'catalog', 'validate', path.join(root, '.aw', 'catalog'),
    ], { cwd: root })).toBe(0);
    await expect(catalogPathProviderInternal.resolve({
      id: 'private-workspace',
      type: 'path',
      primary: true,
      path: path.join(root, '.aw', 'catalog'),
    }, {
      cliVersion: '99.0.0',
      freshnessPolicy: 'forceRemote',
      env: { ...process.env, AW_HOME: path.join(root, 'aw-home') },
    })).resolves.toMatchObject({
      source: 'path',
      manifest: { catalogVersion: '0.1.0' },
    });
  });

  it('publishes immutable Git Catalog history without changing the source worktree', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: root });
    expect(await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root })).toBe(0);
    expect(await runCli([
      'plugin', 'init', 'published-demo', '--description', 'Published demo.', '--no-skills',
      '--workspace-root', root,
    ], { cwd: root })).toBe(0);
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const sourceBranch = (await execFileAsync('git', ['branch', '--show-current'], { cwd: root })).stdout.trim();

    const firstOutput = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: firstOutput.io,
    })).toBe(0);
    const first = JSON.parse(firstOutput.stdout()) as { commit: string };
    expect(firstOutput.stderr()).toBe('');
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/catalog'])).stdout.trim())
      .toBe(first.commit);
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/tags/catalog-v0.1.0^{}'])).stdout.trim())
      .toBe(first.commit);

    expect(await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root], { cwd: root, io: capture().io })).toBe(0);
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'next'], { cwd: root });
    const cancelled = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root], {
      cwd: root,
      interactive: true,
      prompt: { confirm: async () => ({ cancelled: false, value: false }) },
      io: cancelled.io,
    })).toBe(0);
    expect(cancelled.stderr()).toContain('cancelled');
    expect((await execFileAsync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/catalog'])).stdout.trim())
      .toBe(first.commit);
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json'))).resolves.toBe(true);
    await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toMatchObject({ catalogVersion: '0.1.0', state: 'published' });
    const secondOutput = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: secondOutput.io,
    })).toBe(0);
    const second = JSON.parse(secondOutput.stdout()) as { commit: string };
    expect((await execFileAsync('git', ['--git-dir', remote, 'show', '-s', '--format=%P', second.commit])).stdout.trim())
      .toBe(first.commit);
    expect((await execFileAsync('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe(sourceBranch);
    expect((await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root })).stdout).toBe('');

    const retry = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: retry.io,
    })).toBe(1);
    expect(JSON.parse(retry.stdout())).toMatchObject({
      command: 'catalog:publish',
      ok: false,
      errors: [{ message: expect.stringContaining('version <higher>') }],
    });
  });

  it('requires explicit non-interactive publication confirmation with one JSON failure object', async () => {
    const root = await createRoot();
    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--json'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({ command: 'catalog:publish', ok: false });
    expect(output.stdout().trim().split('\n').filter(Boolean).join('\n')).not.toBe('');
    expect(output.stderr()).toContain('requires --yes');
  });

  it('retains an attempted marker after atomic push failure and recovers only after a version bump', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: root });
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'failure-demo', '--description', 'Failure demo.', '--no-skills',
      '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', '.'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const hook = path.join(remote, 'hooks', 'pre-receive');
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const failed = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: failed.io,
    })).toBe(1);
    expect(JSON.parse(failed.stdout())).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining('result is uncertain') }],
    });
    await expect(fs.readJson(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toMatchObject({ state: 'attempted', catalogVersion: '0.1.0' });
    const retry = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: retry.io,
    })).toBe(1);
    expect(JSON.parse(retry.stdout()).errors[0].message).toContain('version <higher>');

    await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'bump'], { cwd: root });
    await fs.remove(hook);
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: capture().io,
    })).toBe(0);
  });

  it('uses the push endpoint for all publication history and the fetch endpoint for source guidance', async () => {
    const root = await createRoot();
    const fetchRemote = await createRoot();
    const pushRemote = await createRoot();
    await Promise.all([
      execFileAsync('git', ['init', '--bare', fetchRemote]),
      execFileAsync('git', ['init', '--bare', pushRemote]),
    ]);
    await createPublishWorkspace(root, 'split-remote-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', fetchRemote], { cwd: root });
    await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', pushRemote], { cwd: root });

    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(0);
    expect(output.stdout()).toContain(`--git ${fetchRemote} --ref refs/heads/catalog`);
    expect(output.stdout()).toContain(`to origin (${pushRemote})`);
    const pushedCommit = (await execFileAsync('git', [
      '--git-dir', pushRemote, 'rev-parse', 'refs/heads/catalog',
    ])).stdout.trim();
    expect((await execFileAsync('git', [
      '--git-dir', pushRemote, 'rev-parse', 'refs/tags/catalog-v0.1.0^{}',
    ])).stdout.trim()).toBe(pushedCommit);
    await expect(execFileAsync('git', [
      '--git-dir', fetchRemote, 'rev-parse', '--verify', 'refs/heads/catalog',
    ])).rejects.toBeDefined();
  });

  it('redacts fetch credentials, query, and fragment from confirmation, human, and JSON output', async () => {
    const secretTokens = ['user-secret', 'query-secret', 'fragment-secret'];
    for (const json of [false, true]) {
      const root = await createRoot();
      const pushRemote = await createRoot();
      await execFileAsync('git', ['init', '--bare', pushRemote]);
      await createPublishWorkspace(root, `redaction-demo-${json ? 'json' : 'human'}`);
      const unsafeFetch = 'https://author:user-secret@example.invalid/catalog.git?token=query-secret#fragment-secret';
      await execFileAsync('git', ['remote', 'add', 'origin', unsafeFetch], { cwd: root });
      await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', pushRemote], { cwd: root });
      const output = capture();
      if (!json) {
        expect(await runCli(['catalog', 'publish', '--workspace-root', root], {
          cwd: root,
          interactive: true,
          prompt: { confirm: async () => ({ cancelled: false, value: true }) },
          io: output.io,
        })).toBe(0);
      } else {
        expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
          cwd: root,
          interactive: false,
          io: output.io,
        })).toBe(0);
        expect(JSON.parse(output.stdout())).toMatchObject({
          fetchUrl: 'https://example.invalid/catalog.git',
          pushUrl: pushRemote,
        });
      }
      for (const secret of secretTokens) {
        expect(output.stdout()).not.toContain(secret);
        expect(output.stderr()).not.toContain(secret);
      }
      if (!json) expect(output.stdout()).toContain('--git https://example.invalid/catalog.git');
    }
  });

  it('rejects a dirty ignored submodule before preparation or remote writes', async () => {
    const root = await createRoot();
    const submoduleSource = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await execFileAsync('git', ['init'], { cwd: submoduleSource });
    await fs.writeFile(path.join(submoduleSource, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', '.'], { cwd: submoduleSource });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'submodule',
    ], { cwd: submoduleSource });
    await createPublishWorkspace(root, 'submodule-demo');
    await execFileAsync('git', [
      '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/dependency',
    ], { cwd: root });
    await execFileAsync('git', ['config', '-f', '.gitmodules', 'submodule.vendor/dependency.ignore', 'all'], { cwd: root });
    await execFileAsync('git', ['add', '.gitmodules', 'vendor/dependency'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'add ignored submodule',
    ], { cwd: root });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await fs.writeFile(path.join(root, 'vendor', 'dependency', 'tracked.txt'), 'uncommitted secret bytes\n');

    const output = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: output.io,
    })).toBe(1);
    expect(output.stderr()).toContain('worktree to be clean');
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'catalog-v0.1.0'))).resolves.toBe(false);
  });

  it('fails closed for a corrupt current attempt, recovers after bump, and keeps old versions blocked', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createPublishWorkspace(root, 'attempt-history-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const oldAttempt = path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json');
    await fs.outputFile(path.join(root, '.aw', 'publish', 'attempted.json'), '{ corrupt attempt');

    const corrupt = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: corrupt.io,
    })).toBe(1);
    expect(corrupt.stderr()).toContain('version <higher>');
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
    await expect(fs.readFile(oldAttempt, 'utf8')).resolves.toBe('{ corrupt attempt');

    await runCli(['catalog', 'version', '0.2.0', '--workspace-root', root], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'bump',
    ], { cwd: root });
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: capture().io,
    })).toBe(0);
    await expect(fs.readFile(oldAttempt, 'utf8')).resolves.toBe('{ corrupt attempt');

    await runCli(['catalog', 'version', '0.1.0', '--workspace-root', root], { cwd: root, io: capture().io });
    await execFileAsync('git', ['add', 'plugins/marketplace-source.json'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'return old',
    ], { cwd: root });
    const oldRetry = capture();
    expect(await runCli(['catalog', 'publish', '--workspace-root', root, '--yes', '--json'], {
      cwd: root,
      interactive: false,
      io: oldRetry.io,
    })).toBe(1);
    expect(oldRetry.stderr()).toContain('version <higher>');
  });

  it('rejects a linked external plugin before build or test code executes', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const executed = path.join(outside, 'executed.txt');
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root });
    await fs.ensureDir(path.join(outside, '.agents-plugin'));
    await fs.writeJson(path.join(outside, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 1,
      name: 'linked-plugin',
      version: '0.1.0',
      description: 'Linked plugin.',
      compatibility: { aw: { minVersion: '0.0.0' } },
      scripts: { tests: { node: ['scripts/external.test.mjs'] } },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    });
    await fs.outputFile(
      path.join(outside, 'scripts', 'external.test.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(executed)}, 'ran');\n`,
    );
    await fs.symlink(outside, path.join(root, 'plugins', 'linked-plugin'));
    for (const command of ['test', 'build']) {
      const output = capture();
      expect(await runCli([
        'plugin', command, 'plugins/linked-plugin', '--workspace-root', root, '--json',
      ], { cwd: root, io: output.io })).toBe(1);
      expect(JSON.parse(output.stdout())).toMatchObject({ ok: false });
    }
    await expect(fs.pathExists(executed)).resolves.toBe(false);
  });
});
