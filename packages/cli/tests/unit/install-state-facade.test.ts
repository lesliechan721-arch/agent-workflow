import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectLegacyInstalledLedger,
  inspectGlobalDependencyIndex,
  readDynamicArtifactDiagnosticCacheAt,
  readInstallRecordFileAt,
  readNativeTransactionMarker,
} from '../../src/install-state/index.js';
import { createRecordId } from '../../src/install-state/index.js';
import type {
  DynamicArtifactDiagnosticCache,
  GlobalDependencyIndex,
  InstallRecordFile,
  NativeTransactionMarker,
  PluginLocation,
} from '../../src/install-state/index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

function makeLocation(): PluginLocation {
  return {
    plugin: 'git-commit',
    platform: 'codex',
    scope: 'user',
  };
}

function makeRecord(location: PluginLocation = makeLocation()): InstallRecordFile {
  return {
    version: 2,
    recordId: createRecordId(location),
    record: {
      pluginName: location.plugin,
      platform: location.platform,
      scope: location.scope,
      installedAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
      source: {
        pluginVersion: '1.2.3',
        manifestDigest: 'sha256:manifest',
        bundleFingerprint: 'sha256:bundle',
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      artifacts: [{
        kind: 'instruction',
        platform: 'codex',
        path: '/tmp/instruction.md',
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
      }],
      dependencyEdges: [],
    },
  };
}

describe('install-state facade', () => {
  it('returns explicit legacy evidence for old installed.json instead of treating it as a record', async () => {
    const awHome = await makeTempDir('aw-install-state-legacy-');
    await fs.writeJson(path.join(awHome, 'installed.json'), {
      version: 1,
      plugins: {
        'git-commit': {
          platforms: {
            codex: {
              userScope: {
                degradedReason: 'legacy',
              },
            },
          },
        },
      },
    }, { spaces: 2 });

    const evidence = await detectLegacyInstalledLedger({ AW_HOME: awHome });
    expect(evidence).toMatchObject({
      kind: 'installedLedger',
      path: path.join(awHome, 'installed.json'),
    });
  });

  it('treats cache absence, corruption, and identity mismatches as unavailable without pretending install success changed', async () => {
    const root = await makeTempDir('aw-install-state-cache-');
    const recordPath = path.join(root, 'record.json');
    const cachePath = path.join(root, 'cache.json');
    const record = makeRecord();
    await fs.writeJson(recordPath, record, { spaces: 2 });

    const missingResult = await readDynamicArtifactDiagnosticCacheAt(cachePath, { currentRecord: record });
    expect(missingResult.status).toBe('unavailable');

    await fs.writeFile(cachePath, '{broken', 'utf8');
    const brokenResult = await readDynamicArtifactDiagnosticCacheAt(cachePath, { currentRecord: record });
    expect(brokenResult.status).toBe('unavailable');

    const cache: DynamicArtifactDiagnosticCache = {
      version: 1,
      recordId: record.recordId,
      location: {
        plugin: record.record.pluginName,
        platform: record.record.platform,
        scope: record.record.scope,
      },
      updatedAt: '2026-05-07T00:00:01.000Z',
      artifacts: [{
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: 'wrong-artifact-key',
      }],
    };
    await fs.writeJson(cachePath, cache, { spaces: 2 });
    const mismatchResult = await readDynamicArtifactDiagnosticCacheAt(cachePath, { currentRecord: record });
    expect(mismatchResult.status).toBe('unavailable');
    if (mismatchResult.status !== 'ok') {
      expect(mismatchResult.code).toBe('artifactMismatch');
    }
  });

  it('normalizes legacy repair refresh events when reading dynamic caches', async () => {
    const root = await makeTempDir('aw-install-state-cache-legacy-refresh-');
    const cachePath = path.join(root, 'cache.json');
    const record = makeRecord();
    await fs.writeJson(cachePath, {
      version: 1,
      recordId: record.recordId,
      location: {
        plugin: record.record.pluginName,
        platform: record.record.platform,
        scope: record.record.scope,
      },
      updatedAt: '2026-05-07T00:00:01.000Z',
      artifacts: [{
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        lastRefresh: {
          status: 'failed',
          at: '2026-05-07T00:00:01.000Z',
          event: 'repair',
          error: 'legacy refresh failed',
        },
      }],
    }, { spaces: 2 });

    const result = await readDynamicArtifactDiagnosticCacheAt(cachePath, { currentRecord: record });

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.artifacts[0]?.lastRefresh).toMatchObject({
        status: 'failed',
        event: 'config',
        error: 'legacy refresh failed',
      });
      expect(JSON.stringify(result.value)).not.toContain('"repair"');
    }
  });

  it('reads native markers independently from install records and rejects legacy breadcrumbs as unsupported', async () => {
    const awHome = await makeTempDir('aw-install-state-marker-');
    const markerDir = path.join(awHome, 'native-recovery', 'codex', 'user');
    await fs.ensureDir(markerDir);
    const marker: NativeTransactionMarker = {
      version: 1,
      pluginName: 'git-commit',
      pluginId: 'git-commit@aw',
      platform: 'codex',
      scope: 'user',
      operation: 'install',
      nativeWriteSucceeded: true,
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
    };
    await fs.writeJson(path.join(markerDir, 'git-commit@aw.json'), marker, { spaces: 2 });
    await expect(readNativeTransactionMarker('git-commit', { AW_HOME: awHome })).resolves.toMatchObject({
      status: 'ok',
      value: marker,
    });

    const brokenRecordPath = path.join(awHome, 'broken-record.json');
    await fs.writeFile(brokenRecordPath, '{broken', 'utf8');
    await expect(readInstallRecordFileAt(brokenRecordPath)).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(readNativeTransactionMarker('git-commit', { AW_HOME: awHome })).resolves.toMatchObject({
      status: 'ok',
      value: marker,
    });

    await fs.writeJson(path.join(markerDir, 'legacy@aw.json'), {
      version: 1,
      platform: 'codex',
      scope: 'user',
      marketplaceName: 'aw',
      pluginName: 'legacy',
      pluginId: 'legacy@aw',
      state: 'pending_after_native_write',
      reason: 'legacy',
      nativeWrittenAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
    }, { spaces: 2 });
    const legacyResult = await readNativeTransactionMarker('legacy', { AW_HOME: awHome });
    expect(legacyResult.status).toBe('unsupported');
  });

  it('classifies dependency index as missing, corrupted, stale candidate, or unreadable reference', async () => {
    const awHome = await makeTempDir('aw-install-state-index-');
    const missing = await inspectGlobalDependencyIndex({ AW_HOME: awHome });
    expect(missing.status).toBe('missing');

    const indexPath = path.join(awHome, 'dependency-index', 'index.json');
    await fs.ensureDir(path.dirname(indexPath));
    await fs.writeFile(indexPath, '{broken', 'utf8');
    const corrupted = await inspectGlobalDependencyIndex({ AW_HOME: awHome });
    expect(corrupted.status).toBe('corrupted');

    const staleLocation = makeLocation();
    const staleRecordPath = path.join(awHome, 'records', 'missing.json');
    const staleIndex: GlobalDependencyIndex = {
      version: 1,
      updatedAt: '2026-05-07T00:00:01.000Z',
      records: [{
        location: staleLocation,
        recordPath: staleRecordPath,
        recordDigest: 'sha256:stale',
        installSource: { kind: 'explicit', explicitlyRequested: true },
        dependencyEdges: [],
        lastSeenAt: '2026-05-07T00:00:01.000Z',
      }],
    };
    await fs.writeJson(indexPath, staleIndex, { spaces: 2 });
    const stale = await inspectGlobalDependencyIndex({ AW_HOME: awHome });
    expect(stale.status).toBe('ok');
    if (stale.status === 'ok') {
      expect(stale.references[0]?.status).toBe('staleCandidate');
    }

    const unreadableLocation = makeLocation();
    const unreadableRecordPath = path.join(awHome, 'records', 'broken.json');
    await fs.ensureDir(path.dirname(unreadableRecordPath));
    await fs.writeFile(unreadableRecordPath, '{broken', 'utf8');
    await fs.writeJson(indexPath, {
      version: 1,
      updatedAt: '2026-05-07T00:00:01.000Z',
      records: [{
        location: unreadableLocation,
        recordPath: unreadableRecordPath,
        recordDigest: 'sha256:wrong',
        installSource: { kind: 'explicit', explicitlyRequested: true },
        dependencyEdges: [],
        lastSeenAt: '2026-05-07T00:00:01.000Z',
      }],
    } satisfies GlobalDependencyIndex, { spaces: 2 });
    const unreadable = await inspectGlobalDependencyIndex({ AW_HOME: awHome });
    expect(unreadable.status).toBe('ok');
    if (unreadable.status === 'ok') {
      expect(unreadable.references[0]?.status).toBe('unreadableReference');
    }
  });
});
