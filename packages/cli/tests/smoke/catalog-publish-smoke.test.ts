import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import {
  prepareCatalogRelease,
  publishCatalogRelease,
  resolveCatalogPluginBaseVersions,
} from '../../../../scripts/release/catalog-publication.mjs';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

async function runAw(cliEntry: string, workspaceRoot: string, args: string[]) {
  return execFileAsync(process.execPath, [cliEntry, ...args], {
    cwd: workspaceRoot,
    env: getCurrentSourceTestIsolation().env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

it('publishes the built public CLI Catalog through an arbitrary branch and Git provider', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-catalog-smoke-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  await Promise.all([
    fs.ensureDir(workspaceRoot),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runAw(cliEntry, workspaceRoot, [
    'catalog', 'init', '--workspace-root', workspaceRoot, '--catalog-version', '91.0.0',
    '--owner-url', 'https://catalog.example.com/smoke-demo',
  ]);
  await runAw(cliEntry, workspaceRoot, [
    'plugin', 'init', 'smoke-demo', '--description', 'Smoke demo.', '--no-skills',
    '--workspace-root', workspaceRoot,
  ]);
  await execFileAsync('git', ['add', '.'], { cwd: workspaceRoot });
  await execFileAsync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--quiet', '-m', 'source',
  ], { cwd: workspaceRoot });
  await execFileAsync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: workspaceRoot });

  const plan = await runAw(cliEntry, workspaceRoot, [
    'catalog', 'publish', 'plan', '--workspace-root', workspaceRoot,
    '--remote', 'origin', '--branch', 'catalog/smoke', '--json',
  ]);
  const planDigest = JSON.parse(plan.stdout).planDigest;
  const result = await runAw(cliEntry, workspaceRoot, [
    'catalog', 'publish', 'apply', '--workspace-root', workspaceRoot,
    '--remote', 'origin', '--branch', 'catalog/smoke',
    '--expected-plan-digest', planDigest, '--yes', '--json',
  ]);
  const receipt = JSON.parse(result.stdout) as { commit: string; snapshotDigest: string };
  expect((await execFileAsync('git', [
    '--git-dir', remoteUrl, 'rev-parse', 'refs/heads/catalog/smoke',
  ])).stdout.trim()).toBe(receipt.commit);
  expect((await execFileAsync('git', [
    '--git-dir', remoteUrl, 'cat-file', '-t', 'refs/tags/catalog-v91.0.0',
  ])).stdout.trim()).toBe('tag');

  const resolved = await catalogGitProviderInternal.resolve({
    id: 'smoke',
    type: 'git',
    primary: true,
    url: remoteUrl,
    refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/smoke' },
  }, {
    cliVersion: '99.0.0',
    freshnessPolicy: 'forceRemote',
    env: getCurrentSourceTestIsolation().env,
  });
  expect(resolved.resolvedCommit).toBe(receipt.commit);
  expect(resolved.manifest.catalogVersion).toBe('91.0.0');
  await expect(fs.readJson(path.join(
    workspaceRoot,
    '.aw',
    'publish',
    '91.0.0',
    'journal.json',
  ))).resolves.toMatchObject({
    schemaVersion: 2,
    state: 'published',
    repository: null,
    descriptor: {
      branch: 'catalog/smoke',
      snapshotDigest: receipt.snapshotDigest,
    },
  });
});

it('uses the compiled Core version owner to prepare only changed official Plugin bases', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-official-catalog-base-smoke-'));
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const cliDistRoot = path.join(repoRoot, 'packages', 'cli', 'dist');
  const cliEntry = path.join(cliDistRoot, 'index.js');
  const env = getCurrentSourceTestIsolation().env;
  await Promise.all([
    fs.ensureDir(workspaceRoot),
    execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: workspaceRoot });
  await runAw(cliEntry, workspaceRoot, [
    'catalog', 'init', '--workspace-root', workspaceRoot, '--catalog-version', '1.0.0',
    '--owner-url', 'https://catalog.example.com/base-smoke',
  ]);
  for (const name of ['unchanged-plugin', 'changed-plugin']) {
    await runAw(cliEntry, workspaceRoot, [
      'plugin', 'init', name, '--description', 'Base smoke.', '--no-skills',
      '--workspace-root', workspaceRoot,
    ]);
  }
  async function commitSource() {
    await execFileAsync('git', ['add', '--all'], { cwd: workspaceRoot });
    await execFileAsync('git', [
      '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', 'source',
    ], { cwd: workspaceRoot });
  }
  await commitSource();
  const plan = await prepareCatalogRelease('latest', { repoRoot: workspaceRoot, remoteUrl, env });
  await publishCatalogRelease({
    channel: 'stable', expectedPlanDigest: plan.planDigest,
  }, { repoRoot: workspaceRoot, remoteUrl, env });

  const manifestPath = path.join(workspaceRoot, 'plugins', 'changed-plugin', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  await fs.writeJson(manifestPath, { ...manifest, description: 'Changed production content.' }, { spaces: 2 });
  await runAw(cliEntry, workspaceRoot, [
    'catalog', 'version', '1.0.1-beta.1', '--workspace-root', workspaceRoot,
  ]);
  await commitSource();
  await runAw(cliEntry, workspaceRoot, ['catalog', 'build', '--workspace-root', workspaceRoot]);
  const sourceHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })).stdout.trim();
  await expect(resolveCatalogPluginBaseVersions({
    channel: 'stable', repoRoot: workspaceRoot, remoteUrl, sourceHead, env,
    withSnapshot: async (callback: (snapshot: Record<string, string>) => Promise<unknown>) => callback({
      catalogOutputRoot: path.join(workspaceRoot, '.aw', 'catalog'),
      corePackageRoot: path.join(repoRoot, 'packages', 'plugin-core'),
      cliDistRoot,
    }),
  })).resolves.toEqual({ 'changed-plugin': '0.1.1' });
});
