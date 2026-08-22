import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeBuildOutputDigest,
  inspectBuildCache,
} from '../../../../scripts/build/build-cache.mjs';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import {
  prepareSmokeSnapshotParent,
  runSmokeNodeJson,
  runSmokeNodeProcess,
  setSmokeSnapshotParentTestHooksForTests,
  type SmokeOwnedPath,
  type SmokeParentBinding,
} from '../support/smoke-node-runner.js';
import { waitForProcessExit } from '../support/process-tree.js';

const tempDirs: string[] = [];
const EXPECTED_PLUGINS = [
  'agent-content-toolkit',
  'agent-skill-eval-runner',
  'agent-skill-toolkit',
  'ask-me',
  'aw-plugin-development',
  'codex-enhance',
  'dev-workflow',
  'git',
];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function createSmokeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return registerCurrentTestWritableStateRoot(root, 'catalog stage smoke temporary root');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface StageLedgerRecord {
  plugin: string;
  version: string;
  contentDigest: string | null;
  artifactDigest: string;
  manifestDigest: string;
  channel: string;
  catalogVersion: string;
}

function isStageLedgerRecord(value: unknown): value is StageLedgerRecord {
  return isRecord(value)
    && typeof value.plugin === 'string'
    && typeof value.version === 'string'
    && (typeof value.contentDigest === 'string' || value.contentDigest === null)
    && typeof value.artifactDigest === 'string'
    && typeof value.manifestDigest === 'string'
    && typeof value.channel === 'string'
    && typeof value.catalogVersion === 'string';
}

function isStageSmokeResult(value: unknown): value is {
  buildDigest: string;
  manifest: Record<string, unknown> & { entries: Array<{ name: string; contentDigest: string }> };
  releaseLedger: { schemaVersion: number; records: StageLedgerRecord[] };
} {
  if (!isRecord(value) || typeof value.buildDigest !== 'string') return false;
  if (!isRecord(value.manifest) || !Array.isArray(value.manifest.entries)) return false;
  if (!value.manifest.entries.every((entry) => isRecord(entry)
    && typeof entry.name === 'string'
    && typeof entry.contentDigest === 'string')) return false;
  return isRecord(value.releaseLedger)
    && typeof value.releaseLedger.schemaVersion === 'number'
    && Array.isArray(value.releaseLedger.records)
    && value.releaseLedger.records.every(isStageLedgerRecord);
}

async function snapshotTree(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file' | 'missing' | 'symlink' | 'special';
  value?: string;
}>> {
  const result: Array<{
    path: string;
    type: 'directory' | 'file' | 'missing' | 'symlink' | 'special';
    value?: string;
  }> = [];
  async function visit(candidatePath: string, relativePath: string): Promise<void> {
    let stats;
    try {
      stats = await fs.lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.push({ path: relativePath, type: 'missing' });
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      result.push({
        path: relativePath,
        type: 'symlink',
        value: await fs.readlink(candidatePath),
      });
      return;
    }
    if (stats.isFile()) {
      result.push({
        path: relativePath,
        type: 'file',
        value: (await fs.readFile(candidatePath)).toString('base64'),
      });
      return;
    }
    if (!stats.isDirectory()) {
      result.push({ path: relativePath, type: 'special' });
      return;
    }
    result.push({ path: relativePath, type: 'directory' });
    for (const entry of (await fs.readdir(candidatePath)).sort()) {
      await visit(path.join(candidatePath, entry), path.join(relativePath, entry));
    }
  }
  await visit(root, '.');
  return result;
}

afterEach(async () => {
  setSmokeSnapshotParentTestHooksForTests(undefined);
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('catalog stage smoke', () => {
  it('fails closed when an existing ancestor is replaced after lstat', async () => {
    const caseRoot = realpathSync.native(await createSmokeTempRoot('aw-smoke-prepare-swap-'));
    const trustedRoot = path.join(caseRoot, 'trusted');
    const originalRoot = path.join(caseRoot, 'trusted-original');
    const foreignRoot = path.join(caseRoot, 'foreign');
    await fs.ensureDir(path.join(trustedRoot, 'owned'));
    await fs.writeFile(path.join(trustedRoot, 'owned', 'keep'), 'owned');
    await fs.ensureDir(foreignRoot);
    await fs.writeFile(path.join(foreignRoot, 'keep'), 'foreign');
    let replaced = false;
    setSmokeSnapshotParentTestHooksForTests({
      afterAncestorLstat: async (ancestorPath) => {
        if (replaced || ancestorPath !== trustedRoot) return;
        replaced = true;
        await fs.rename(trustedRoot, originalRoot);
        await fs.symlink(foreignRoot, trustedRoot, 'dir');
      },
    });

    await expect(prepareSmokeSnapshotParent(path.join(trustedRoot, 'snapshot-parent')))
      .rejects.toThrow(/binding changed|identity changed|symbolic link/u);

    await expect(fs.readFile(path.join(originalRoot, 'owned', 'keep'), 'utf8'))
      .resolves.toBe('owned');
    await expect(fs.readFile(path.join(foreignRoot, 'keep'), 'utf8')).resolves.toBe('foreign');
    await expect(fs.pathExists(path.join(foreignRoot, 'snapshot-parent'))).resolves.toBe(false);
  });

  it('does not start a child when a prepared parent binding is replaced', async () => {
    const root = repoRoot();
    const caseRoot = realpathSync.native(await createSmokeTempRoot('aw-smoke-binding-swap-'));
    const snapshotParent = path.join(caseRoot, 'snapshot-parent');
    const originalParent = `${snapshotParent}-original`;
    const foreignRoot = path.join(caseRoot, 'foreign');
    const binding = await prepareSmokeSnapshotParent(snapshotParent);
    await fs.ensureDir(path.join(snapshotParent, 'owned'));
    await fs.writeFile(path.join(snapshotParent, 'owned', 'keep'), 'owned');
    await fs.ensureDir(path.join(foreignRoot, 'owned'));
    await fs.writeFile(path.join(foreignRoot, 'owned', 'keep'), 'foreign');
    await fs.rename(snapshotParent, originalParent);
    await fs.symlink(foreignRoot, snapshotParent, 'dir');
    const evidencePath = path.join(caseRoot, 'pids.json');
    const configPath = path.join(caseRoot, 'failure-config.json');
    await fs.writeJson(configPath, {
      snapshotRoot: path.join(snapshotParent, 'owned'),
      stageTempRoot: path.join(snapshotParent, 'secondary-owned'),
      evidencePath,
    });

    await expect(runSmokeNodeProcess({
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
      cleanupOnFailure: [ownedChild(binding, 'owned')],
    })).rejects.toThrow(/binding changed|identity changed|symbolic link/u);

    await expect(fs.pathExists(evidencePath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(originalParent, 'owned', 'keep'), 'utf8'))
      .resolves.toBe('owned');
    await expect(fs.readFile(path.join(foreignRoot, 'owned', 'keep'), 'utf8'))
      .resolves.toBe('foreign');
    await expect(fs.pathExists(path.join(foreignRoot, 'secondary-owned'))).resolves.toBe(false);
  });

  it('creates a missing snapshot parent before binding an owned stage token', async () => {
    const root = repoRoot();
    const caseRoot = await createSmokeTempRoot('aw-stage-missing-snapshot-parent-');
    const snapshotParent = path.join(caseRoot, '.release', 'build-snapshots');
    const snapshotParentBinding = await prepareSmokeSnapshotParent(snapshotParent);
    const canonicalParentRoot = snapshotParentBinding.canonicalPath;
    const snapshotBasename = `build-${crypto.randomUUID()}`;
    const stageTempRoot = path.join(caseRoot, 'stage-temp');
    const configPath = path.join(caseRoot, 'failure-config.json');
    await fs.writeJson(configPath, {
      snapshotRoot: path.join(canonicalParentRoot, snapshotBasename),
      stageTempRoot,
      evidencePath: path.join(caseRoot, 'pids.json'),
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
        ownedChild(caseRoot, path.basename(stageTempRoot)),
      ],
    }, (_value): _value is { ok: true } => false)).rejects.toThrow(/JSON/u);

    await expect(fs.pathExists(snapshotParent)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(canonicalParentRoot, snapshotBasename)))
      .resolves.toBe(false);
    await expect(fs.pathExists(stageTempRoot)).resolves.toBe(false);
  });

  it('stages an explicit-version snapshot and consumes it through the local path provider', async () => {
    const root = repoRoot();
    const formalStageRoot = path.join(root, '.release', 'catalog-staging', 'catalog');
    const formalStageBefore = await snapshotTree(formalStageRoot);
    const isolatedStageRepo = await createSmokeTempRoot('aw-stage-output-');
    const stageRoot = path.join(
      isolatedStageRepo,
      '.release',
      'catalog-staging',
      'catalog',
    );
    const catalogVersion = '99.0.0-beta.7';
    const snapshotParentBinding = await prepareSmokeSnapshotParent(
      path.join(root, '.release', 'build-snapshots'),
    );
    const snapshotParentRoot = snapshotParentBinding.canonicalPath;

    const snapshotToken = crypto.randomUUID();
    const configPath = path.join(isolatedStageRepo, 'stage-smoke-config.json');
    const npmExecPath = process.env.npm_execpath?.trim();
    if (!npmExecPath) throw new Error('Catalog smoke requires npm_execpath from pnpm.');
    await fs.writeJson(configPath, {
      mode: 'stage',
      repoRoot: root,
      npmExecPath,
      stageRoot,
      catalogVersion,
      snapshotTokens: [snapshotToken],
    });
    const childResult = await runSmokeNodeJson({
      scriptPath: path.join(root, 'packages', 'cli', 'tests', 'support', 'catalog-smoke-child.mjs'),
      args: [configPath],
      cwd: root,
      timeoutMs: 90_000,
      cleanupOnFailure: [
        ownedChild(snapshotParentBinding, `build-${snapshotToken}`),
        ownedChild(os.tmpdir(), path.basename(isolatedStageRepo)),
      ],
    }, isStageSmokeResult);
    await expect(snapshotTree(formalStageRoot)).resolves.toEqual(formalStageBefore);

    const manifest = childResult.manifest;
    const ledger = childResult.releaseLedger;
    expect((await fs.readdir(stageRoot)).sort()).toEqual([
      '.agents',
      '.claude-plugin',
      'catalog-manifest.json',
      'plugin-release-ledger.json',
      'plugins',
    ]);
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      catalogVersion,
      channel: 'beta',
      compatibility: { aw: { minVersion: '0.1.0-beta.2' } },
    });
    expect(manifest).not.toHaveProperty('packages');
    expect(ledger.schemaVersion).toBe(2);
    expect(manifest.entries.map((entry: { name: string }) => entry.name).sort())
      .toEqual(EXPECTED_PLUGINS);
    expect(manifest.entries.every((entry: { contentDigest: string }) =>
      /^sha256:[0-9a-f]{64}$/u.test(entry.contentDigest))).toBe(true);
    const currentRecords = new Map(ledger.records
      .filter((record) => record.catalogVersion === catalogVersion)
      .map((record) => [record.plugin, record]));
    for (const entry of manifest.entries) {
      expect(currentRecords.get(entry.name)).toMatchObject({
        plugin: entry.name,
        version: entry.version,
        artifactDigest: entry.artifactDigest,
        manifestDigest: entry.manifestDigest,
        contentDigest: entry.contentDigest,
        channel: manifest.channel,
        catalogVersion,
      });
    }
    await expect(fs.pathExists(path.join(stageRoot, '.catalog'))).resolves.toBe(false);
    expect((await fs.readdir(path.dirname(stageRoot)))
      .filter((entry) => entry.startsWith('.catalog-stage-'))).toEqual([]);

    await expect(computeBuildOutputDigest(root)).resolves.toBe(childResult.buildDigest);
    await expect(fs.pathExists(path.join(
      snapshotParentRoot,
      `build-${snapshotToken}`,
    ))).resolves.toBe(false);
    await expect(inspectBuildCache(root)).resolves.toMatchObject({ reusable: true });

    const cacheRoot = await createSmokeTempRoot('aw-stage-path-cache-');
    const providerModulePath = path.join(
      root,
      'packages',
      'cli',
      'dist',
      'src',
      'utils',
      'path-catalog-provider.js',
    );
    const { catalogPathProviderInternal } = await import(
      `${pathToFileURL(providerModulePath).href}?smoke=${Date.now()}`
    ) as {
      catalogPathProviderInternal: {
        resolve(source: Record<string, unknown>, options: Record<string, unknown>): Promise<{
          rootDir: string;
          source: string;
          manifest: { catalogVersion: string; entries: Array<{ name: string }> };
        }>;
      };
    };
    const resolved = await catalogPathProviderInternal.resolve(
      { id: 'staged', type: 'path', primary: true, path: stageRoot },
      {
        cliVersion: '99.0.0',
        freshnessPolicy: 'forceRemote',
        env: { ...process.env, AW_HOME: cacheRoot },
      },
    );
    expect(resolved).toMatchObject({
      source: 'path',
      manifest: { catalogVersion },
    });
    expect(resolved.rootDir).not.toBe(stageRoot);
    expect(resolved.manifest.entries.map((entry) => entry.name).sort()).toEqual(EXPECTED_PLUGINS);
    await expect(snapshotTree(formalStageRoot)).resolves.toEqual(formalStageBefore);
  });

  it.each(['timeout', 'abort'] as const)(
    'terminates the real Node process tree and removes only owned artifacts on %s',
    async (termination) => {
      const root = repoRoot();
      const runToken = crypto.randomUUID();
      const snapshotBasename = `build-${runToken}`;
      const snapshotParentBinding = await prepareSmokeSnapshotParent(
        path.join(root, '.release', 'build-snapshots'),
      );
      const snapshotParentRoot = snapshotParentBinding.canonicalPath;
      const snapshotRoot = path.join(snapshotParentRoot, snapshotBasename);
      const ownedRunRoot = await createSmokeTempRoot(`aw-smoke-run-${runToken}-`);
      const evidenceRoot = await createSmokeTempRoot(`aw-smoke-evidence-${runToken}-`);
      const evidencePath = path.join(evidenceRoot, 'pids.json');
      const stageTempRoot = path.join(
        ownedRunRoot,
        '.release',
        'catalog-staging',
        `.catalog-stage-${runToken}`,
      );
      const configPath = path.join(evidenceRoot, 'failure-config.json');
      await fs.writeJson(configPath, {
        snapshotRoot,
        stageTempRoot,
        evidencePath,
      });
      const abortController = new AbortController();
      const abortTimer = termination === 'abort'
        ? setTimeout(() => abortController.abort(new Error('smoke abort')), 300)
        : null;
      try {
        await expect(runSmokeNodeProcess({
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
          timeoutMs: termination === 'timeout' ? 300 : 5_000,
          signal: abortController.signal,
          cleanupOnFailure: [
            ownedChild(snapshotParentBinding, snapshotBasename),
            ownedChild(os.tmpdir(), path.basename(ownedRunRoot)),
          ],
        })).rejects.toMatchObject({ reason: termination === 'timeout' ? 'timeout' : 'aborted' });
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }
      const evidence = await fs.readJson(evidencePath) as {
        childPid: number;
        grandchildPid: number;
      };
      await Promise.all([
        waitForProcessExit(evidence.childPid),
        waitForProcessExit(evidence.grandchildPid),
      ]);
      await expect(fs.pathExists(snapshotRoot)).resolves.toBe(false);
      await expect(fs.pathExists(stageTempRoot)).resolves.toBe(false);
      await expect(fs.pathExists(ownedRunRoot)).resolves.toBe(false);
    },
  );

  it.each([
    ['nonzero', /fixture nonzero failure/u],
    ['invalid-json', /JSON/u],
    ['empty-object', /expected JSON structure/u],
    ['null', /expected JSON structure/u],
  ] as const)(
    'rejects %s output, removes owned paths, and preserves a foreign sibling',
    async (resultMode, expectedError) => {
      const root = repoRoot();
      const caseRoot = await createSmokeTempRoot(`aw-smoke-json-${resultMode}-`);
      const ownedArtifactRoot = path.join(caseRoot, 'owned-artifact');
      const ownedRunRoot = path.join(caseRoot, 'owned-run');
      const foreignRoot = path.join(caseRoot, 'foreign');
      const evidencePath = path.join(caseRoot, 'pids.json');
      const configPath = path.join(caseRoot, 'failure-config.json');
      await fs.ensureDir(foreignRoot);
      await fs.writeFile(path.join(foreignRoot, 'keep'), 'foreign');
      await fs.writeJson(configPath, {
        snapshotRoot: ownedArtifactRoot,
        stageTempRoot: ownedRunRoot,
        evidencePath,
        resultMode,
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
          ownedChild(caseRoot, path.basename(ownedArtifactRoot)),
          ownedChild(caseRoot, path.basename(ownedRunRoot)),
        ],
      }, (_value): _value is { ok: true } => false)).rejects.toThrow(expectedError);

      const evidence = await fs.readJson(evidencePath) as {
        childPid: number;
        grandchildPid: number;
      };
      await Promise.all([
        waitForProcessExit(evidence.childPid),
        waitForProcessExit(evidence.grandchildPid),
      ]);
      await expect(fs.pathExists(ownedArtifactRoot)).resolves.toBe(false);
      await expect(fs.pathExists(ownedRunRoot)).resolves.toBe(false);
      await expect(fs.readFile(path.join(foreignRoot, 'keep'), 'utf8')).resolves.toBe('foreign');
    },
  );

  it.each([
    ['path traversal', (parentRoot: string) => ({
      absolutePath: path.join(parentRoot, '..', 'foreign'),
      parentRoot,
      basename: 'foreign',
    })],
    ['wrong basename', (parentRoot: string) => ({
      absolutePath: path.join(parentRoot, 'owned'),
      parentRoot,
      basename: 'different',
    })],
    ['non-direct child', (parentRoot: string) => ({
      absolutePath: path.join(parentRoot, 'nested', 'owned'),
      parentRoot,
      basename: 'owned',
    })],
  ] as const)(
    'rejects a cleanup descriptor with %s without deleting adjacent paths',
    async (_name, createInvalidDescriptor) => {
      const root = repoRoot();
      const caseRoot = await createSmokeTempRoot('aw-smoke-descriptor-');
      const descriptorParent = path.join(caseRoot, 'cleanup-parent');
      const ownedRoot = path.join(descriptorParent, 'owned');
      const foreignRoot = path.join(caseRoot, 'foreign');
      await fs.ensureDir(ownedRoot);
      await fs.ensureDir(foreignRoot);

      await expect(runSmokeNodeProcess({
        scriptPath: path.join(
          root,
          'packages',
          'cli',
          'tests',
          'fixtures',
          'smoke-node-runner-child.mjs',
        ),
        args: [path.join(caseRoot, 'unused.json')],
        cwd: root,
        timeoutMs: 90_000,
        cleanupOnFailure: [createInvalidDescriptor(descriptorParent)],
      })).rejects.toThrow('Smoke cleanup path is not an exact owned child');
      await expect(fs.pathExists(ownedRoot)).resolves.toBe(true);
      await expect(fs.pathExists(foreignRoot)).resolves.toBe(true);
    },
  );

  it.each(['parent', 'owned child'] as const)(
    'rejects an existing symbolic-link %s without deleting its target',
    async (linkLocation) => {
      const root = repoRoot();
      const caseRoot = realpathSync.native(await createSmokeTempRoot('aw-smoke-symlink-'));
      const descriptorParent = path.join(caseRoot, 'cleanup-parent');
      const foreignRoot = path.join(caseRoot, 'foreign');
      const foreignOwnedRoot = path.join(foreignRoot, 'owned');
      await fs.ensureDir(foreignOwnedRoot);
      await fs.writeFile(path.join(foreignOwnedRoot, 'keep'), 'foreign');
      if (linkLocation === 'parent') {
        await fs.symlink(foreignRoot, descriptorParent, 'dir');
      } else {
        await fs.ensureDir(descriptorParent);
        await fs.symlink(foreignOwnedRoot, path.join(descriptorParent, 'owned'), 'dir');
      }

      await expect(runSmokeNodeProcess({
        scriptPath: path.join(
          root,
          'packages',
          'cli',
          'tests',
          'fixtures',
          'smoke-node-runner-child.mjs',
        ),
        args: [path.join(caseRoot, 'unused.json')],
        cwd: root,
        timeoutMs: 90_000,
        cleanupOnFailure: [{
          absolutePath: path.join(descriptorParent, 'owned'),
          parentRoot: descriptorParent,
          basename: 'owned',
        }],
      })).rejects.toThrow(/refuses a symbolic link/u);
      await expect(fs.readFile(path.join(foreignOwnedRoot, 'keep'), 'utf8'))
        .resolves.toBe('foreign');
    },
  );

  it('fails closed when a validated parent is replaced by a symbolic link', async () => {
    const root = repoRoot();
    const caseRoot = realpathSync.native(await createSmokeTempRoot('aw-smoke-parent-swap-'));
    const descriptorParent = path.join(caseRoot, 'cleanup-parent');
    const replacementRoot = path.join(caseRoot, 'foreign-parent');
    const foreignOwnedRoot = path.join(replacementRoot, 'owned');
    const evidencePath = path.join(caseRoot, 'pids.json');
    const configPath = path.join(caseRoot, 'failure-config.json');
    await fs.ensureDir(descriptorParent);
    await fs.ensureDir(foreignOwnedRoot);
    await fs.writeFile(path.join(foreignOwnedRoot, 'keep'), 'foreign');
    await fs.writeJson(configPath, {
      snapshotRoot: path.join(descriptorParent, 'owned'),
      stageTempRoot: path.join(descriptorParent, 'secondary-owned'),
      evidencePath,
      resultMode: 'invalid-json',
      replaceParentWithSymlink: { parentRoot: descriptorParent, replacementRoot },
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
      cleanupOnFailure: [ownedChild(descriptorParent, 'owned')],
    }, (_value): _value is { ok: true } => false))
      .rejects.toThrow(/(?:symbolic link|parent (?:binding changed|identity changed|chain is not canonical))/u);

    const evidence = await fs.readJson(evidencePath) as {
      childPid: number;
      grandchildPid: number;
    };
    await Promise.all([
      waitForProcessExit(evidence.childPid),
      waitForProcessExit(evidence.grandchildPid),
    ]);
    await expect(fs.readFile(path.join(foreignOwnedRoot, 'keep'), 'utf8'))
      .resolves.toBe('foreign');
    await expect(fs.pathExists(path.join(`${descriptorParent}-original`, 'owned')))
      .resolves.toBe(true);
  });
});
