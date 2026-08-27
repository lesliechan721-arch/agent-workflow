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

async function createCommittedWorkspace(root: string, pluginName: string): Promise<void> {
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

describe('Catalog publication status CLI', () => {
  it('reports static workspace, plugin, dependency, and Git facts without creating output', async () => {
    const root = await createRoot();
    await createCommittedWorkspace(root, 'static-demo');
    const output = capture();

    expect(await runCli(['catalog', 'status', '--workspace-root', root, '--json'], {
      cwd: root,
      io: output.io,
    })).toBe(0);
    const receipt = JSON.parse(output.stdout());
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      command: 'catalog:status',
      ok: true,
      workspace: { valid: true, identity: expect.any(String) },
      catalog: { valid: true, version: '0.1.0', channel: 'latest' },
      plugins: [{ name: 'static-demo', version: '0.1.0', dependencies: [], sourceValid: true }],
      dependencyGraph: { valid: true, order: ['static-demo'] },
      git: { checked: true, sourceHead: expect.any(String), clean: true },
      publication: { checked: false, publishable: null },
      issues: [],
    });
    expect(output.stderr()).toBe('');
    await expect(fs.pathExists(path.join(root, '.aw'))).resolves.toBe(false);
    const human = capture();
    expect(await runCli(['catalog', 'status', '--workspace-root', root], {
      cwd: root,
      io: human.io,
    })).toBe(0);
    expect(human.stdout()).toContain('Publication preflight: not checked');
  });

  it('returns a stable JSON issue and exit code for an invalid workspace marker', async () => {
    const root = await createRoot();
    await fs.writeJson(path.join(root, '.aw-workspace.json'), { schemaVersion: 99 });
    const output = capture();

    expect(await runCli(['catalog', 'status', '--workspace-root', root, '--json'], {
      cwd: root,
      io: output.io,
    })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: 'catalog:status',
      ok: false,
      workspace: { valid: false },
      publication: { checked: false, publishable: null },
      issues: [{ code: 'workspaceInvalid', message: expect.any(String) }],
    });
    expect(output.stderr()).toBe('');
  });

  it('reports why publication preflight cannot run without a committed Git HEAD', async () => {
    const root = await createRoot();
    await runCli(['catalog', 'init', '--workspace-root', root], { cwd: root, io: capture().io });
    await runCli([
      'plugin', 'init', 'no-git-demo', '--description', 'No Git demo.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    const output = capture();

    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--preflight', '--json',
    ], { cwd: root, io: output.io })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      publication: { checked: true, publishable: false },
      issues: [{
        code: 'gitUnavailable',
        message: expect.stringContaining('committed Git HEAD'),
      }],
    });
    expect(output.stderr()).toBe('');
  });

  it('reports a missing same-source dependency from static source data', async () => {
    const root = await createRoot();
    await createCommittedWorkspace(root, 'dependency-demo');
    const manifestPath = path.join(root, 'plugins', 'dependency-demo', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.dependencies = ['missing-demo'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await execFileAsync('git', ['add', manifestPath], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'invalid dependency',
    ], { cwd: root });
    const output = capture();

    expect(await runCli(['catalog', 'status', '--workspace-root', root, '--json'], {
      cwd: root,
      io: output.io,
    })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      dependencyGraph: { valid: false },
      issues: [{
        code: 'dependencyGraphInvalid',
        message: expect.stringContaining('missing-demo'),
      }],
    });
  });

  it('prepares from committed HEAD without an attempt, persistent build output, or remote write', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createCommittedWorkspace(root, 'preflight-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const output = capture();

    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--preflight', '--json',
    ], { cwd: root, io: output.io })).toBe(0);
    expect(JSON.parse(output.stdout())).toMatchObject({
      command: 'catalog:status',
      ok: true,
      publication: {
        checked: true,
        remote: 'origin',
        remoteUrl: remote,
        branch: 'catalog',
        publishedVersion: null,
        parent: null,
        tag: 'catalog-v0.1.0',
        tagAvailable: true,
        attemptAvailable: true,
        snapshotDigest: expect.stringMatching(/^sha256:/u),
        planId: expect.stringMatching(/^sha256:/u),
        publishable: true,
      },
      issues: [],
    });
    const human = capture();
    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--preflight',
    ], { cwd: root, io: human.io })).toBe(0);
    expect(human.stdout()).toContain('Publication preflight: checked');
    expect(human.stdout()).toContain('Publishable: yes');
    await expect(fs.pathExists(path.join(root, '.aw'))).resolves.toBe(false);
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
  });

  it('reports committed-HEAD inventory when ignored live plugins are present', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createCommittedWorkspace(root, 'committed-demo');
    await fs.appendFile(path.join(root, '.gitignore'), '\nplugins/ignored-demo/\n');
    await execFileAsync('git', ['add', '.gitignore'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'ignore live-only plugin',
    ], { cwd: root });
    await runCli([
      'plugin', 'init', 'ignored-demo', '--description', 'Ignored live demo.',
      '--no-skills', '--workspace-root', root,
    ], { cwd: root, io: capture().io });
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    expect((await execFileAsync('git', [
      'status', '--porcelain=v1', '--untracked-files=all',
    ], { cwd: root })).stdout).toBe('');

    const staticOutput = capture();
    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--json',
    ], { cwd: root, io: staticOutput.io })).toBe(0);
    expect(JSON.parse(staticOutput.stdout()).plugins.map((plugin: { name: string }) => plugin.name))
      .toEqual(['committed-demo', 'ignored-demo']);

    const preflightOutput = capture();
    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--preflight', '--json',
    ], { cwd: root, io: preflightOutput.io })).toBe(0);
    expect(JSON.parse(preflightOutput.stdout()).plugins.map((plugin: { name: string }) => plugin.name))
      .toEqual(['committed-demo']);
  });

  it('uses the same prepared snapshot identity for status and publish on unchanged inputs', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createCommittedWorkspace(root, 'identity-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const statusOutput = capture();
    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--preflight', '--json',
    ], { cwd: root, io: statusOutput.io })).toBe(0);
    const publishOutput = capture();
    expect(await runCli([
      'catalog', 'publish', '--workspace-root', root, '--yes', '--json',
    ], { cwd: root, interactive: false, io: publishOutput.io })).toBe(0);

    const status = JSON.parse(statusOutput.stdout());
    expect(JSON.parse(publishOutput.stdout())).toMatchObject({
      workspaceIdentity: status.workspace.identity,
      catalogVersion: status.catalog.version,
      sourceHead: status.git.sourceHead,
      remote: status.publication.remote,
      branch: status.publication.branch,
      parent: status.publication.parent,
      tag: status.publication.tag,
      snapshotDigest: status.publication.snapshotDigest,
      planId: status.publication.planId,
    });
  });

  it('rejects a selected remote identity change before writing an attempt or pushing', async () => {
    const root = await createRoot();
    const initialRemote = await createRoot();
    const replacementRemote = await createRoot();
    await Promise.all([
      execFileAsync('git', ['init', '--bare', initialRemote]),
      execFileAsync('git', ['init', '--bare', replacementRemote]),
    ]);
    await createCommittedWorkspace(root, 'remote-drift-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', initialRemote], { cwd: root });
    const output = capture();

    expect(await runCli([
      'catalog', 'publish', '--workspace-root', root,
    ], {
      cwd: root,
      interactive: true,
      prompt: {
        confirm: async () => {
          await execFileAsync('git', ['remote', 'set-url', '--push', 'origin', replacementRemote], { cwd: root });
          return { cancelled: false, value: true };
        },
      },
      io: output.io,
    })).toBe(1);
    expect(output.stderr()).toContain('remote configuration changed');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toBe(false);
    expect((await execFileAsync('git', ['ls-remote', initialRemote])).stdout).toBe('');
    expect((await execFileAsync('git', ['ls-remote', replacementRemote])).stdout).toBe('');
  });

  it('rejects branch drift after preparation before writing an attempt', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    const contender = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createCommittedWorkspace(root, 'branch-drift-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await execFileAsync('git', ['init', '--quiet'], { cwd: contender });
    await fs.outputFile(path.join(contender, 'contender.txt'), 'contender\n');
    await execFileAsync('git', ['add', '.'], { cwd: contender });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'contender',
    ], { cwd: contender });
    const output = capture();

    expect(await runCli(['catalog', 'publish', '--workspace-root', root], {
      cwd: root,
      interactive: true,
      prompt: {
        confirm: async () => {
          await execFileAsync('git', ['push', '--quiet', remote, 'HEAD:refs/heads/catalog'], {
            cwd: contender,
          });
          return { cancelled: false, value: true };
        },
      },
      io: output.io,
    })).toBe(1);
    expect(output.stderr()).toContain('remote changed during preparation');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toBe(false);
  });

  it('rejects an immutable tag collision before writing an attempt or branch', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createCommittedWorkspace(root, 'tag-collision-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'tag', '--annotate', 'catalog-v0.1.0', '--message', 'collision',
    ], { cwd: root });
    await execFileAsync('git', ['push', '--quiet', 'origin', 'refs/tags/catalog-v0.1.0'], { cwd: root });
    const output = capture();

    expect(await runCli([
      'catalog', 'publish', '--workspace-root', root, '--yes', '--json',
    ], { cwd: root, interactive: false, io: output.io })).toBe(1);
    expect(output.stderr()).toContain('already exists');
    await expect(fs.pathExists(path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json')))
      .resolves.toBe(false);
    await expect(execFileAsync('git', [
      '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/catalog',
    ])).rejects.toBeDefined();
  });

  it('fails preflight closed for an existing version attempt without modifying it or the remote', async () => {
    const root = await createRoot();
    const remote = await createRoot();
    await execFileAsync('git', ['init', '--bare', remote]);
    await createCommittedWorkspace(root, 'attempt-demo');
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: root });
    const attemptPath = path.join(root, '.aw', 'publish', 'attempts', '0.1.0.json');
    await fs.outputFile(attemptPath, '{ corrupt attempt');
    const output = capture();

    expect(await runCli([
      'catalog', 'status', '--workspace-root', root, '--preflight', '--json',
    ], { cwd: root, io: output.io })).toBe(1);
    expect(JSON.parse(output.stdout())).toMatchObject({
      publication: {
        checked: true,
        attemptAvailable: false,
        publishable: false,
        snapshotDigest: expect.stringMatching(/^sha256:/u),
      },
      issues: [{ code: 'attemptUnavailable', message: expect.any(String) }],
    });
    await expect(fs.readFile(attemptPath, 'utf8')).resolves.toBe('{ corrupt attempt');
    expect((await execFileAsync('git', ['ls-remote', remote])).stdout).toBe('');
  });
});
