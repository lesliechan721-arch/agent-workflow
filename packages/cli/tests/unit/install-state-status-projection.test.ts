import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { collectInstallEvidence } from '../../src/install-state/evidence.js';
import type { CurrentCatalogEvidenceInput } from '../../src/install-state/evidence.js';
import {
  createProjectArtifactSharedLocator,
  createSharedIdentityId,
  getProjectArtifactSharedIdentityPath,
} from '../../src/install-state/index.js';
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

async function projectConfigOnlyCodexUserResidue(options: {
  dependencyIndexState: 'missing' | 'corrupted' | 'staleReference' | 'unreadableReference';
  localDependent?: boolean;
  nativeEvidence?: 'configOnly' | 'configAndCache';
}) {
  const builder = await createMinimalPluginInstallStateFixtureBuilder(
    await makeTempDir(`aw-install-state-config-only-native-${options.dependencyIndexState}-`),
  );
  const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
  await fs.outputFile(
    path.join(builder.paths.codexHome, 'config.toml'),
    `[plugins."${target.pluginId}"]\nenabled = true\n`,
    'utf8',
  );
  if ((options.nativeEvidence ?? 'configOnly') === 'configAndCache') {
    await fs.outputJson(
      path.join(builder.paths.codexHome, 'plugins', 'cache', 'aw', target.location.plugin, target.source.pluginVersion, 'plugin.json'),
      {
        id: target.pluginId,
        version: target.source.pluginVersion,
      },
      { spaces: 2 },
    );
  }

  if (options.dependencyIndexState === 'corrupted') {
    await fs.outputFile(
      path.join(builder.paths.awHome, 'dependency-index', 'index.json'),
      '{"version": 1,',
      'utf8',
    );
  } else if (
    options.dependencyIndexState === 'staleReference'
    || options.dependencyIndexState === 'unreadableReference'
  ) {
    const referencedTarget = builder.createTarget({
      pluginName: `helper-${options.dependencyIndexState}`,
      platform: 'codex',
      scope: 'user',
    });
    const referencedRecord = await builder.writeInstallRecord(referencedTarget);
    await builder.writeDependencyIndex([{ target: referencedTarget, record: referencedRecord }]);
    const scopedRecords = await builder.readScopedInstallRecordDirectory({
      platform: 'codex',
      scope: 'user',
    });
    const referencedRecordPath = scopedRecords.successes.find((entry) =>
      entry.recordId === referencedTarget.recordId)?.path;
    if (!referencedRecordPath) {
      throw new Error(`missing fixture record for ${referencedTarget.recordId}`);
    }
    if (options.dependencyIndexState === 'staleReference') {
      await fs.remove(referencedRecordPath);
    } else {
      await fs.writeFile(referencedRecordPath, '{"version": 2,', 'utf8');
    }
  }

  if (options.localDependent) {
    const dependentTarget = builder.createTarget({
      pluginName: 'helper-local-dependent',
      platform: 'codex',
      scope: 'user',
    });
    const dependentRecord = await builder.writeInstallRecord(dependentTarget);
    dependentRecord.record.dependencyEdges = [{
      dependency: target.location,
      declaration: {
        name: target.location.plugin,
      },
    }];
    const scopedRecords = await builder.readScopedInstallRecordDirectory({
      platform: 'codex',
      scope: 'user',
    });
    const dependentRecordPath = scopedRecords.successes.find((entry) =>
      entry.recordId === dependentTarget.recordId)?.path;
    if (!dependentRecordPath) {
      throw new Error(`missing fixture record for ${dependentTarget.recordId}`);
    }
    await fs.writeJson(dependentRecordPath, dependentRecord, { spaces: 2 });
  }

  const evidence = await collectInstallEvidence({
    cwd: builder.paths.repoRoot,
    location: target.location,
    env: createInstallStateFixtureEnv(builder.paths),
    currentCatalog: createCurrentCatalogForTarget(target),
  });
  return {
    evidence,
    projection: projectInstallState(evidence),
  };
}

async function projectStateWithUnindexedLocalDependent(
  kind: 'needsRepair' | 'residual',
) {
  const builder = await createMinimalPluginInstallStateFixtureBuilder(
    await makeTempDir(`aw-install-state-${kind}-local-dependent-`),
  );
  const target = builder.createTarget({
    pluginName: `target-${kind}`,
    platform: 'codex',
    scope: 'project',
    projectKey: builder.paths.repoRoot,
  });
  const dependentTarget = builder.createTarget({
    pluginName: `dependent-${kind}`,
    platform: 'codex',
    scope: 'project',
    projectKey: builder.paths.repoRoot,
  });

  if (kind === 'needsRepair') {
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const targetRecord = sanitizeInstallRecordForP2(await builder.writeInstallRecord(target, lifecycle));
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`),
      targetRecord,
      { spaces: 2 },
    );
    await builder.writeProjectIdentity(target);
    await builder.writeDiagnosticCache(target);
    await builder.writeDependencyIndex([{ target, record: targetRecord }]);
    await fs.writeFile(target.repoArtifactPath, `${target.repoArtifactContent}mutated\n`, 'utf8');
  } else {
    await builder.writeRepoArtifact(target);
    await builder.writeDiagnosticCache(target);
  }

  const dependentRecord = sanitizeInstallRecordForP2(await builder.writeInstallRecord(dependentTarget));
  dependentRecord.record.dependencyEdges = [{
    dependency: target.location,
    declaration: {
      name: target.location.plugin,
    },
  }];
  await fs.writeJson(
    path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${dependentTarget.recordId}.json`),
    dependentRecord,
    { spaces: 2 },
  );

  const evidence = await collectInstallEvidence({
    cwd: builder.paths.repoRoot,
    location: target.location,
    env: createInstallStateFixtureEnv(builder.paths),
    currentCatalog: createCurrentCatalogForTarget(target),
  });
  return {
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

  it('uses the Claude project subdirectory when reading project artifact shared identity', async () => {
    const root = await makeTempDir('aw-install-state-claude-project-locator-');
    const repoRoot = path.join(root, 'repo');
    const projectA = path.join(repoRoot, 'packages', 'a');
    const projectB = path.join(repoRoot, 'packages', 'b');
    await fs.ensureDir(path.join(repoRoot, '.git'));
    await fs.ensureDir(projectA);
    await fs.ensureDir(projectB);

    async function writeIdentity(projectRoot: string) {
      const locator = createProjectArtifactSharedLocator({
        plugin: 'git-commit',
        platform: 'claude',
        repoRoot,
        projectRoot,
      });
      const identity = {
        version: 1,
        sharedIdentityId: createSharedIdentityId(locator),
        locator,
        source: {
          pluginVersion: '0.1.0',
          manifestDigest: 'sha256:manifest',
          bundleFingerprint: 'sha256:bundle',
        },
        generatedAt: '2026-05-07T00:00:00.000Z',
        artifacts: [],
      };
      const identityPath = getProjectArtifactSharedIdentityPath({ repoRoot, locator });
      await fs.outputJson(identityPath, identity, { spaces: 2 });
      return { identityPath, locator };
    }

    const identityA = await writeIdentity(projectA);
    const identityB = await writeIdentity(projectB);

    const evidence = await collectInstallEvidence({
      cwd: projectA,
      location: {
        plugin: 'git-commit',
        platform: 'claude',
        scope: 'project',
        projectKey: projectA,
      },
      env: {
        ...process.env,
        AW_HOME: path.join(root, '.aw'),
        AW_CLAUDE_HOME: path.join(root, '.claude'),
        HOME: root,
      },
    });

    expect(identityA.identityPath).not.toBe(identityB.identityPath);
    expect(evidence.projectSharedIdentity.read?.path).toBe(identityA.identityPath);
    expect(evidence.projectSharedIdentity.read?.status).toBe('ok');
    if (evidence.projectSharedIdentity.read?.status === 'ok') {
      expect(evidence.projectSharedIdentity.read.value.locator.repoRelativeProjectRoot).toBe('packages/a');
    }
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

  it('exposes Codex user native residue cleanup whenever there are no known dependents', async () => {
    const missing = await projectConfigOnlyCodexUserResidue({ dependencyIndexState: 'missing' });
    expect(missing.projection.kind).toBe('externallyManaged');
    expect(missing.projection.cleanupAvailable).toBe(true);

    const missingWithCache = await projectConfigOnlyCodexUserResidue({
      dependencyIndexState: 'missing',
      nativeEvidence: 'configAndCache',
    });
    expect(missingWithCache.projection.kind).toBe('externallyManaged');
    expect(missingWithCache.projection.cleanupAvailable).toBe(true);

    const corrupted = await projectConfigOnlyCodexUserResidue({ dependencyIndexState: 'corrupted' });
    expect(corrupted.projection.kind).toBe('externallyManaged');
    expect(corrupted.projection.dependencyIndexCoverageReasons).toContain('indexCorrupted');
    expect(corrupted.projection.cleanupAvailable).toBe(true);

    const stale = await projectConfigOnlyCodexUserResidue({ dependencyIndexState: 'staleReference' });
    expect(stale.projection.kind).toBe('externallyManaged');
    expect(stale.projection.dependencyIndexCoverageTrusted).toBe(false);
    expect(stale.projection.dependencyIndexCoverageReasons).toContain('staleReference');
    expect(stale.projection.cleanupAvailable).toBe(true);

    const unreadable = await projectConfigOnlyCodexUserResidue({ dependencyIndexState: 'unreadableReference' });
    expect(unreadable.projection.kind).toBe('externallyManaged');
    expect(unreadable.projection.dependencyIndexCoverageTrusted).toBe(false);
    expect(unreadable.projection.dependencyIndexCoverageReasons).toContain('unreadableReference');
    expect(unreadable.projection.cleanupAvailable).toBe(true);
  });

  it('does not expose config-only Codex cleanup when a readable local scoped record depends on it', async () => {
    const missingWithLocalDependent = await projectConfigOnlyCodexUserResidue({
      dependencyIndexState: 'missing',
      localDependent: true,
    });

    expect(missingWithLocalDependent.projection.kind).toBe('externallyManaged');
    expect(missingWithLocalDependent.projection.cleanupAvailable).toBe(false);
  });

  it.each(['needsRepair', 'residual'] as const)(
    'does not expose cleanup for %s when a readable same-scope record still depends on it',
    async (kind) => {
      const blocked = await projectStateWithUnindexedLocalDependent(kind);

      expect(blocked.projection.kind).toBe(kind);
      expect(blocked.projection.dependents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            plugin: `dependent-${kind}`,
          }),
        ]),
      );
      expect(blocked.projection.cleanupAvailable).toBe(false);
    },
  );

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

  it('treats missing secondary dependency artifact paths as broken dependency health', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-install-state-dependency-secondary-path-'),
    );
    const dependency = builder.createTarget({
      pluginName: 'helper-plugin',
      platform: 'codex',
      scope: 'project',
      projectKey: builder.paths.repoRoot,
    });
    const target = builder.createTarget({
      pluginName: 'parent-plugin',
      platform: 'codex',
      scope: 'project',
      projectKey: builder.paths.repoRoot,
    });

    await builder.writeRepoArtifact(dependency);
    const dependencyRecord = sanitizeInstallRecordForP2(await builder.writeInstallRecord(dependency));
    dependencyRecord.record.artifacts[0].paths = [
      path.join(builder.paths.repoRoot, '.agents', 'skills', dependency.pluginSlug, 'missing-secondary.md'),
    ];
    await fs.writeJson(
      path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${dependency.recordId}.json`),
      dependencyRecord,
      { spaces: 2 },
    );

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
    await builder.writeDiagnosticCache(target);
    await builder.writeDependencyIndex([
      { target: dependency, record: dependencyRecord },
      { target, record },
    ]);

    const projection = projectInstallState(await collectInstallEvidence({
      cwd: builder.paths.repoRoot,
      location: target.location,
      env: createInstallStateFixtureEnv(builder.paths),
      currentCatalog: createCurrentCatalogForTarget(target),
    }));

    expect(projection.kind).toBe('needsRepair');
    expect(projection.issues).toContainEqual(expect.objectContaining({
      code: 'dependencyMissing',
      detail: 'missingArtifact',
    }));
  });
});
