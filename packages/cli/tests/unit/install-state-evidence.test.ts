import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { collectInstallEvidence } from '../../src/install-state/evidence.js';
import type {
  CurrentCatalogEvidenceInput,
  CurrentCatalogSource,
} from '../../src/install-state/evidence.js';
import {
  createCurrentCatalogForTarget,
  createInstallStateFixtureEnv,
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
  sanitizeInstallRecordForP2,
} from '../helpers/install-state-projection-fixtures.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('collectInstallEvidence', () => {
  it('collects record, identity, dynamic cache, dependency coverage, and lifecycle evidence without generating human copy', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-evidence-installed-'),
      scenario: 'installed',
    });
    const env = createInstallStateFixtureEnv(fixture.paths);
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    const currentCatalog = createCurrentCatalogForTarget(fixture.target);

    const evidence = await collectInstallEvidence({
      cwd: fixture.paths.repoRoot,
      location: fixture.target.location,
      env,
      currentCatalog,
    });

    expect(evidence.installRecord.read.status).toBe('ok');
    expect(evidence.installRecord.present).toBe(true);
    expect(evidence.installRecord.sourceDrift).toBe(false);
    expect(evidence.projectSharedIdentity.read?.status).toBe('ok');
    expect(evidence.dynamicDiagnostic.available).toBe(true);
    expect(evidence.dynamicDiagnostic.dynamicDiagnosticUnavailable).toBe(false);
    expect(evidence.historicalLifecycle.healthy).toBe(true);
    expect(evidence.dependencyIndex.projection.coverage.trusted).toBe(true);
    expect(evidence.dependencyIndex.projection.coverage.coverageTrusted).toBe(true);
    expect(evidence.adoptable.possible).toBe(false);
  });

  it('treats missing, corrupted, and detached dynamic cache as unavailable evidence instead of inventing drift', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-evidence-dynamic-'),
    );
    const target = builder.createTarget({ platform: 'codex', scope: 'project' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = sanitizeInstallRecordForP2(await builder.writeInstallRecord(target, lifecycle));
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`),
      record,
      { spaces: 2 },
    );
    await builder.writeProjectIdentity(target);
    await builder.writeDependencyIndex([{ target, record }]);
    const env = createInstallStateFixtureEnv(builder.paths);

    const missingEvidence = await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    });
    expect(missingEvidence.dynamicDiagnostic.dynamicDiagnosticUnavailable).toBe(true);
    expect(missingEvidence.dynamicDiagnostic.unavailableReason).toBe('missing');

    await builder.writeDiagnosticCache(target);
    await fs.writeFile(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'diagnostics', `${target.recordId}.json`),
      '{"version": 1,',
      'utf8',
    );
    const brokenEvidence = await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    });
    expect(brokenEvidence.dynamicDiagnostic.dynamicDiagnosticUnavailable).toBe(true);
    expect(brokenEvidence.dynamicDiagnostic.unavailableReason).toBe('invalidJson');

    await builder.writeDiagnosticCache(target, {
      version: 1,
      recordId: target.recordId,
      location: target.location,
      updatedAt: target.timestamps.updatedAt,
      artifacts: [{
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: 'wrong-artifact-key',
      }],
    });
    const detachedEvidence = await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    });
    expect(detachedEvidence.dynamicDiagnostic.dynamicDiagnosticUnavailable).toBe(true);
    expect(detachedEvidence.dynamicDiagnostic.unavailableReason).toBe('artifactMismatch');
    expect(detachedEvidence.dynamicDiagnostic.entries).toHaveLength(0);
  });

  it('captures dependency coverage reasons, revisit locations, and recovery suggestion when the index is not trustworthy', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-evidence-index-'),
    );
    const target = builder.createTarget({ platform: 'codex', scope: 'project' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = sanitizeInstallRecordForP2(await builder.writeInstallRecord(target, lifecycle));
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`),
      record,
      { spaces: 2 },
    );
    await builder.writeProjectIdentity(target);
    await builder.writeDependencyIndex([{ target, record }]);

    const indexPath = path.join(builder.paths.awHome, 'dependency-index', 'index.json');
    const staleRecordPath = path.join(builder.paths.awHome, 'orphan-project', 'missing-record.json');
    const index = await fs.readJson(indexPath) as {
      version: number;
      updatedAt: string;
      records: Array<Record<string, unknown>>;
    };
    index.records.push({
      location: {
        plugin: 'old-project-plugin',
        platform: 'codex',
        scope: 'project',
        projectKey: '/missing/repo',
      },
      recordPath: staleRecordPath,
      recordDigest: 'stale-digest',
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      dependencyEdges: [],
      lastSeenAt: target.timestamps.updatedAt,
    });
    await fs.writeJson(indexPath, index, { spaces: 2 });

    const env = createInstallStateFixtureEnv(builder.paths);
    const evidence = await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    });

    expect(evidence.dependencyIndex.projection.coverage.trusted).toBe(false);
    expect(evidence.dependencyIndex.projection.coverage.coverageTrusted).toBe(false);
    expect(evidence.dependencyIndex.projection.coverage.reasons).toContain('staleReference');
    expect(evidence.dependencyIndex.projection.coverage.revisitProjectLocations).toContainEqual(
      {
        plugin: 'old-project-plugin',
        platform: 'codex',
        scope: 'project',
        projectKey: '/missing/repo',
      },
    );
    expect(evidence.dependencyIndex.projection.coverage.verifiedLocations).toContainEqual(
      target.location,
    );

    const missingIndexFixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-evidence-index-missing-'),
      scenario: 'notInstalled',
    });
    const missingIndexEvidence = await collectInstallEvidence({
      cwd: missingIndexFixture.paths.repoRoot,
      location: missingIndexFixture.target.location,
      env: createInstallStateFixtureEnv(missingIndexFixture.paths),
      currentCatalog: createCurrentCatalogForTarget(missingIndexFixture.target),
    });
    expect(missingIndexEvidence.dependencyIndex.projection.coverage.reasons).toContain('indexMissing');
    expect(missingIndexEvidence.dependencyIndex.projection.coverage.recoverySuggestion).toBe('revisitRelatedProjects');
  });

  it('distinguishes marker-only and record-plus-marker native transaction states', async () => {
    const markerOnly = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-evidence-marker-only-'),
      scenario: 'nativeMarkerOnly',
    });
    const markerOnlyEvidence = await collectInstallEvidence({
      cwd: markerOnly.paths.repoRoot,
      location: markerOnly.target.location,
      env: createInstallStateFixtureEnv(markerOnly.paths),
      currentCatalog: createCurrentCatalogForTarget(markerOnly.target),
    });
    expect(markerOnlyEvidence.nativeTransaction.present).toBe(true);
    expect(markerOnlyEvidence.nativeTransaction.classification).toBe('markerOnlyInstall');

    const recordAndMarker = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-evidence-record-marker-'),
      scenario: 'recordAndInstallMarkerResidual',
    });
    await rewriteSanitizedInstallRecordForP2(recordAndMarker.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(recordAndMarker.files.dependencyIndexPath);
    const recordAndMarkerEvidence = await collectInstallEvidence({
      cwd: recordAndMarker.paths.repoRoot,
      location: recordAndMarker.target.location,
      env: createInstallStateFixtureEnv(recordAndMarker.paths),
      currentCatalog: createCurrentCatalogForTarget(recordAndMarker.target),
    });
    expect(recordAndMarkerEvidence.installRecord.present).toBe(true);
    expect(recordAndMarkerEvidence.nativeTransaction.classification).toBe('recordInstallResidual');
  });

  it('treats fresh clone project artifacts as adoptable through identity even when the current catalog has drifted', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-evidence-adoptable-'),
      scenario: 'adoptable',
    });
    const env = createInstallStateFixtureEnv(fixture.paths);
    const driftedSource: CurrentCatalogSource = {
      pluginVersion: '9.9.9',
      manifestDigest: 'drift-manifest',
      bundleFingerprint: 'drift-bundle',
    };
    const currentCatalog: CurrentCatalogEvidenceInput = {
      ...createCurrentCatalogForTarget(fixture.target),
      source: driftedSource,
    };

    const evidence = await collectInstallEvidence({
      cwd: fixture.paths.repoRoot,
      location: fixture.target.location,
      env,
      currentCatalog,
    });

    expect(evidence.installRecord.present).toBe(false);
    expect(evidence.projectSharedIdentity.present).toBe(true);
    expect(evidence.projectSharedIdentity.sourceDrift).toBe(true);
    expect(evidence.adoptable.possible).toBe(true);
    expect(evidence.adoptable.source).toBe('identity');
  });

  it('does not treat path-only current-catalog matches as adoptable when project identity is missing', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-evidence-path-only-'),
      scenario: 'freshCloneProject',
    });
    await fs.remove(fixture.files.projectIdentityPath);

    const evidence = await collectInstallEvidence({
      cwd: fixture.paths.repoRoot,
      location: fixture.target.location,
      env: createInstallStateFixtureEnv(fixture.paths),
      currentCatalog: createCurrentCatalogForTarget(fixture.target),
    });

    expect(evidence.projectSharedIdentity.read?.status).toBe('missing');
    expect(evidence.adoptable.possible).toBe(false);
    expect(evidence.adoptable.source).toBe('none');
    expect(evidence.adoptable.blockers).toContain('artifactIdentityUnverifiable');
  });
});
