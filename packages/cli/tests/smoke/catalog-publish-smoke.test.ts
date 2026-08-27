import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

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

  const preflight = await runAw(cliEntry, workspaceRoot, [
    'catalog', 'status', '--workspace-root', workspaceRoot,
    '--preflight', '--remote', 'origin', '--branch', 'catalog/smoke', '--json',
  ]);
  const descriptorDigest = JSON.parse(preflight.stdout).publication.descriptorDigest;
  const result = await runAw(cliEntry, workspaceRoot, [
    'catalog', 'publish', '--workspace-root', workspaceRoot,
    '--remote', 'origin', '--branch', 'catalog/smoke',
    '--expected-descriptor-digest', descriptorDigest, '--yes', '--json',
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
    'attempts',
    '91.0.0.json',
  ))).resolves.toMatchObject({
    state: 'published',
    branch: 'catalog/smoke',
    snapshotDigest: receipt.snapshotDigest,
  });
});
