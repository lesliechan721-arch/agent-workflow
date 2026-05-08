import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { collectInstallEvidence } from '../../src/install-state/evidence.js';
import type { CurrentCatalogEvidenceInput } from '../../src/install-state/evidence.js';
import { projectInstallState } from '../../src/install-state/status-projection.js';
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

async function projectStateForScenario(
  scenario: Parameters<typeof writeMinimalPluginInstallStateFixture>[0]['scenario'],
) {
  const fixture = await writeMinimalPluginInstallStateFixture({
    rootDir: await makeTempDir(`aw-install-state-${scenario}-`),
    scenario,
  });
  await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath).catch(() => undefined);
  await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
  const evidence = await collectInstallEvidence({
    cwd: fixture.paths.repoRoot,
    location: fixture.target.location,
    env: createInstallStateFixtureEnv(fixture.paths),
    currentCatalog: createCurrentCatalogForTarget(fixture.target),
  });
  return {
    fixture,
    evidence,
    projection: projectInstallState(evidence),
  };
}

describe('projectInstallState', () => {
  it('covers the six default status classes', async () => {
    await expect(projectStateForScenario('installed')).resolves.toMatchObject({
      projection: { kind: 'installed' },
    });
    await expect(projectStateForScenario('needsRepair')).resolves.toMatchObject({
      projection: { kind: 'needsRepair' },
    });
    await expect(projectStateForScenario('adoptable')).resolves.toMatchObject({
      projection: { kind: 'adoptable' },
    });
    await expect(projectStateForScenario('residual')).resolves.toMatchObject({
      projection: { kind: 'residual' },
    });
    await expect(projectStateForScenario('externallyManaged')).resolves.toMatchObject({
      projection: { kind: 'externallyManaged' },
    });
    await expect(projectStateForScenario('notInstalled')).resolves.toMatchObject({
      projection: { kind: 'notInstalled' },
    });
  });

  it('keeps healthy installs in installed when only the current catalog has drifted', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-state-catalog-drift-'),
      scenario: 'installed',
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    const driftedCatalog: CurrentCatalogEvidenceInput = {
      ...createCurrentCatalogForTarget(fixture.target),
      source: {
        pluginVersion: '0.2.0',
        manifestDigest: 'drift-manifest',
        bundleFingerprint: 'drift-bundle',
      },
    };

    const projection = projectInstallState(await collectInstallEvidence({
      cwd: fixture.paths.repoRoot,
      location: fixture.target.location,
      env: createInstallStateFixtureEnv(fixture.paths),
      currentCatalog: driftedCatalog,
    }));

    expect(projection.kind).toBe('installed');
    expect(projection.catalogDrift).toBe(true);
    expect(projection.upgradeAvailable).toBe(true);
    expect(projection.issues).toEqual([]);
  });

  it('keeps dynamic cache missing, broken, or detached as installed with dynamicDiagnosticUnavailable', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-state-dynamic-unavailable-'),
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

    let projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.kind).toBe('installed');
    expect(projection.dynamicDiagnosticUnavailable).toBe(true);

    await builder.writeDiagnosticCache(target);
    await fs.writeFile(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'diagnostics', `${target.recordId}.json`),
      '{"version": 1,',
      'utf8',
    );
    projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.kind).toBe('installed');
    expect(projection.dynamicDiagnosticUnavailable).toBe(true);

    await builder.writeDiagnosticCache(target, {
      version: 1,
      recordId: target.recordId,
      location: target.location,
      updatedAt: target.timestamps.updatedAt,
      artifacts: [{
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: 'detached-key',
      }],
    });
    projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.kind).toBe('installed');
    expect(projection.dynamicDiagnosticUnavailable).toBe(true);
  });

  it('projects dynamic content drift, config stale, refresh failure, and disabled state without running a renderer', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-state-dynamic-projection-'),
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

    await builder.writeDiagnosticCache(target, {
      version: 1,
      recordId: target.recordId,
      location: target.location,
      updatedAt: target.timestamps.updatedAt,
      artifacts: [{
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: `${target.pluginSlug}.skill`,
        configDigest: 'config:old',
        contentDigest: 'mismatch-digest',
        lastRefresh: {
          status: 'failed',
          at: target.timestamps.updatedAt,
          event: 'config',
          error: 'boom',
        },
      }],
    });
    let projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.kind).toBe('needsRepair');
    expect(projection.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['dynamicContentDrift', 'dynamicConfigStale', 'dynamicRefreshFailed']),
    );

    await fs.remove(target.repoArtifactPath);
    await builder.writeDiagnosticCache(target, {
      version: 1,
      recordId: target.recordId,
      location: target.location,
      updatedAt: target.timestamps.updatedAt,
      artifacts: [{
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        state: 'disabled',
        disabledReason: 'projectSharedConfigOff',
        artifactKey: `${target.pluginSlug}.skill`,
      }],
    });
    projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: {
        ...createCurrentCatalogForTarget(target),
        dynamicArtifacts: [{
          id: `${target.pluginSlug}-instruction`,
          target: 'codex.developerInstructionsBlock',
          state: 'disabled',
          disabledReason: 'projectSharedConfigOff',
          artifactKey: `${target.pluginSlug}.skill`,
          configDigest: `config:${target.pluginSlug}`,
        }],
      },
    }));
    expect(projection.kind).toBe('installed');
    expect(projection.issues.map((issue) => issue.code)).not.toContain('artifactMissing');
  });

  it('projects fresh clone without identity and with current-catalog drift as residual instead of adoptable', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-install-state-fresh-clone-drift-'),
      scenario: 'freshCloneProject',
    });
    await fs.remove(fixture.files.projectIdentityPath);
    await fs.writeFile(fixture.target.repoArtifactPath, `${fixture.target.repoArtifactContent}drift\n`, 'utf8');

    const projection = projectInstallState(await collectInstallEvidence({
      cwd: fixture.paths.repoRoot,
      location: fixture.target.location,
      env: createInstallStateFixtureEnv(fixture.paths),
      currentCatalog: createCurrentCatalogForTarget(fixture.target),
    }));

    expect(projection.kind).toBe('residual');
    expect(projection.adoptExistingAvailable).toBe(false);
  });

  it('does not show unused dependency hints when the index is untrusted and suppresses the hint for explicitly retained dependencies', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-state-unused-dependency-'),
    );
    const target = builder.createTarget({ pluginName: 'dependent-only', platform: 'codex', scope: 'project' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = sanitizeInstallRecordForP2(await builder.writeInstallRecord(target, lifecycle));
    record.record.installSource = {
      kind: 'dependency',
      explicitlyRequested: false,
    };
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`),
      record,
      { spaces: 2 },
    );
    await builder.writeProjectIdentity(target);
    await builder.writeDiagnosticCache(target, {
      version: 1,
      recordId: target.recordId,
      location: target.location,
      updatedAt: target.timestamps.updatedAt,
      artifacts: [{
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: `${target.pluginSlug}.skill`,
        contentDigest: target.repoArtifactDigest,
        configDigest: `config:${target.pluginSlug}`,
      }],
    });
    await builder.writeDependencyIndex([{ target, record }]);
    const env = createInstallStateFixtureEnv(builder.paths);

    let projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.autoInstalled).toBe(true);
    expect(projection.unusedDependencyHint).toBe(true);

    await fs.remove(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.dependencyIndexTrusted).toBe(false);
    expect(projection.unusedDependencyHint).toBe(false);

    record.record.installSource = {
      kind: 'dependency',
      explicitlyRequested: true,
    };
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`),
      record,
      { spaces: 2 },
    );
    await builder.writeDependencyIndex([{ target, record }]);
    projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env,
      currentCatalog: createCurrentCatalogForTarget(target),
    }));
    expect(projection.autoInstalled).toBe(true);
    expect(projection.unusedDependencyHint).toBe(false);
  });

  it('moves record-plus-install-marker residual into needsRepair while keeping both repair and cleanup available', async () => {
    const { projection } = await projectStateForScenario('recordAndInstallMarkerResidual');
    expect(projection.kind).toBe('needsRepair');
    expect(projection.nativeTransactionPresent).toBe(true);
    expect(projection.nativeTransactionKind).toBe('recordInstallResidual');
    expect(projection.repairAvailable).toBe(true);
    expect(projection.cleanupAvailable).toBe(true);
  });

  it('marks broken dependency edges as needsRepair instead of catalog drift or unused hints', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-state-dependency-health-'),
    );
    const dependency = builder.createTarget({ pluginName: 'helper-plugin', platform: 'codex', scope: 'project' });
    const target = builder.createTarget({ pluginName: 'parent-plugin', platform: 'codex', scope: 'project' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = sanitizeInstallRecordForP2(await builder.writeInstallRecord(target, lifecycle));
    record.record.dependencyEdges = [{
      dependency: dependency.location,
      declaration: {
        name: dependency.location.plugin,
      },
    }];
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`),
      record,
      { spaces: 2 },
    );
    await builder.writeProjectIdentity(target);
    await builder.writeDiagnosticCache(target, {
      version: 1,
      recordId: target.recordId,
      location: target.location,
      updatedAt: target.timestamps.updatedAt,
      artifacts: [{
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        state: 'present',
        artifactKey: `${target.pluginSlug}.skill`,
        contentDigest: target.repoArtifactDigest,
        configDigest: `config:${target.pluginSlug}`,
      }],
    });
    await builder.writeDependencyIndex([{ target, record }]);

    const projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env: createInstallStateFixtureEnv(builder.paths),
      currentCatalog: createCurrentCatalogForTarget(target),
    }));

    expect(projection.kind).toBe('needsRepair');
    expect(projection.issues.some((issue) => issue.code === 'dependencyMissing')).toBe(true);
    expect(projection.unusedDependencyHint).toBe(false);
  });
});
