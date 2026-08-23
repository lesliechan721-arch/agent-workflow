import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';

import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  prepareSmokeSnapshotParent,
  runSmokeNodeJson,
  type SmokeOwnedPath,
  type SmokeParentBinding,
} from '../support/smoke-node-runner.js';

const execFileAsync = promisify(execFile);
let temporaryRoot: string | null = null;

interface BootstrapSmokeResult {
  beta: { commit: string };
  latest: { commit: string };
}

function isBootstrapEntry(value: unknown): value is BootstrapSmokeResult['beta'] {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).commit === 'string';
}

function isBootstrapSmokeResult(value: unknown): value is BootstrapSmokeResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isBootstrapEntry(candidate.beta)
    && isBootstrapEntry(candidate.latest);
}

function ownedChild(parent: string | SmokeParentBinding, basename: string): SmokeOwnedPath {
  const parentBinding = typeof parent === 'string' ? undefined : parent;
  const canonicalParentRoot = parentBinding?.canonicalPath ?? realpathSync.native(parent);
  return {
    absolutePath: path.join(canonicalParentRoot, basename),
    ...(parentBinding ? { parentBinding } : { parentRoot: canonicalParentRoot }),
    basename,
  };
}

afterEach(async () => {
  if (temporaryRoot) await fs.remove(temporaryRoot);
  temporaryRoot = null;
});

it('creates a missing snapshot parent before binding an owned bootstrap token', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-bootstrap-missing-snapshot-parent-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const canonicalTemporaryRoot = realpathSync.native(temporaryRoot);
  const snapshotParent = path.join(canonicalTemporaryRoot, '.release', 'build-snapshots');
  const snapshotParentBinding = await prepareSmokeSnapshotParent(snapshotParent);
  const canonicalParentRoot = snapshotParentBinding.canonicalPath;
  const snapshotBasename = `build-${crypto.randomUUID()}`;
  const stageTempRoot = path.join(canonicalTemporaryRoot, 'stage-temp');
  const configPath = path.join(canonicalTemporaryRoot, 'failure-config.json');
  await fs.writeJson(configPath, {
    snapshotRoot: path.join(canonicalParentRoot, snapshotBasename),
    stageTempRoot,
    evidencePath: path.join(canonicalTemporaryRoot, 'pids.json'),
    resultMode: 'invalid-json',
  });

  await expect(runSmokeNodeJson({
    scriptPath: path.join(
      root,
      'packages',
      'cli',
      'tests',
      'fixtures',
      'smoke-node-runner-child.mjs',
    ),
    args: [configPath],
    cwd: root,
    timeoutMs: 90_000,
    cleanupOnFailure: [
      ownedChild(snapshotParentBinding, snapshotBasename),
      ownedChild(canonicalTemporaryRoot, path.basename(stageTempRoot)),
    ],
  }, (_value): _value is { ok: true } => false)).rejects.toThrow(/JSON/u);

  await expect(fs.pathExists(snapshotParent)).resolves.toBe(true);
  await expect(fs.pathExists(path.join(canonicalParentRoot, snapshotBasename)))
    .resolves.toBe(false);
  await expect(fs.pathExists(stageTempRoot)).resolves.toBe(false);
});

it('publishes both first orphan channels and fetches each through the Git provider', async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-bootstrap-smoke-'));
  const remoteUrl = path.join(temporaryRoot, 'catalog.git');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const npmExecPath = process.env.npm_execpath?.trim();
  if (!npmExecPath) throw new Error('Catalog smoke requires npm_execpath from pnpm.');
  const snapshotParentBinding = await prepareSmokeSnapshotParent(
    path.join(root, '.release', 'build-snapshots'),
  );
  const snapshotParentRoot = snapshotParentBinding.canonicalPath;
  const snapshotTokens = Array.from({ length: 2 }, () => crypto.randomUUID());
  const stageRoot = path.join(
    temporaryRoot,
    '.release',
    'catalog-staging',
    'catalog',
  );
  const configPath = path.join(temporaryRoot, 'bootstrap-smoke-config.json');
  await fs.writeJson(configPath, {
    mode: 'bootstrap',
    repoRoot: root,
    npmExecPath,
    remoteUrl,
    stageRoot,
    snapshotTokens,
  });
  const { beta, latest } = await runSmokeNodeJson({
    scriptPath: path.join(root, 'packages', 'cli', 'tests', 'support', 'catalog-smoke-child.mjs'),
    args: [configPath],
    cwd: root,
    timeoutMs: 90_000,
    cleanupOnFailure: [
      ...snapshotTokens.map((token) => ownedChild(
        snapshotParentBinding,
        `build-${token}`,
      )),
      ownedChild(os.tmpdir(), path.basename(temporaryRoot)),
    ],
  }, isBootstrapSmokeResult);
  for (const token of snapshotTokens) {
    await expect(fs.pathExists(path.join(
      snapshotParentRoot,
      `build-${token}`,
    ))).resolves.toBe(false);
  }
  expect((await fs.readdir(path.dirname(stageRoot)))
    .filter((entry) => entry.startsWith('.catalog-stage-'))).toEqual([]);

  for (const [ref, expected] of [
    ['refs/heads/catalog/beta', beta.commit],
    ['refs/heads/catalog/latest', latest.commit],
  ] as const) {
    const resolved = await catalogGitProviderInternal.resolve({
      id: ref.endsWith('beta') ? 'beta-smoke' : 'latest-smoke',
      type: 'git',
      primary: true,
      url: remoteUrl,
      refPolicy: { type: 'explicit', ref },
    }, {
      cliVersion: '99.0.0',
      freshnessPolicy: 'forceRemote',
      env: getCurrentSourceTestIsolation().env,
    });
    expect(resolved.resolvedCommit).toBe(expected);
  }

  for (const version of ['92.0.0-beta.1', '92.0.0']) {
    const result = await execFileAsync('git', [
      '--git-dir', remoteUrl, 'cat-file', '-t', `refs/tags/catalog-v${version}`,
    ]);
    expect(String(result.stdout).trim()).toBe('tag');
  }
});
