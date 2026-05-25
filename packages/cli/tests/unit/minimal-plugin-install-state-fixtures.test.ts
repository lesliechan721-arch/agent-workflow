import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createMinimalPluginInstallStateFixtureBuilder,
  DEFAULT_FORBIDDEN_STDOUT_TERMS,
  findForbiddenStdoutTerms,
  LEGACY_FIELD_DISPOSITIONS,
  LEGACY_STATE_BOUNDARIES,
  LEGACY_STATE_SURFACES,
  readInstallRecordFileSafe,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import { runWithCurrentRepositoryCwdAsReadOnly } from '../setup/test-isolation.js';

const tempDirs: string[] = [];

async function makeRootDir(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-minimal-install-state-'));
  tempDirs.push(rootDir);
  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('minimal plugin install state fixtures', () => {
  it('maps legacy baseline scenarios onto the four public install states in isolated temp roots', async () => {
    const cases = [
      {
        scenario: 'installed' as const,
        state: 'installed',
        hasRecord: true,
        hasDiagnostic: true,
        hasIdentity: true,
        hasDependencyIndex: true,
        hasLifecycle: true,
        hasNativeMarker: false,
        hasExternalNative: false,
      },
      {
        scenario: 'needsRepair' as const,
        state: 'installed',
        hasRecord: true,
        hasDiagnostic: true,
        hasIdentity: true,
        hasDependencyIndex: true,
        hasLifecycle: true,
        hasNativeMarker: false,
        hasExternalNative: false,
      },
      {
        scenario: 'adoptable' as const,
        state: 'external',
        hasRecord: false,
        hasDiagnostic: false,
        hasIdentity: true,
        hasDependencyIndex: false,
        hasLifecycle: false,
        hasNativeMarker: false,
        hasExternalNative: false,
      },
      {
        scenario: 'residual' as const,
        state: 'cleanupRequired',
        hasRecord: false,
        hasDiagnostic: true,
        hasIdentity: false,
        hasDependencyIndex: false,
        hasLifecycle: false,
        hasNativeMarker: false,
        hasExternalNative: false,
      },
      {
        scenario: 'externallyManaged' as const,
        state: 'external',
        hasRecord: false,
        hasDiagnostic: false,
        hasIdentity: false,
        hasDependencyIndex: false,
        hasLifecycle: false,
        hasNativeMarker: false,
        hasExternalNative: true,
      },
      {
        scenario: 'notInstalled' as const,
        state: 'notInstalled',
        hasRecord: false,
        hasDiagnostic: false,
        hasIdentity: false,
        hasDependencyIndex: false,
        hasLifecycle: false,
        hasNativeMarker: false,
        hasExternalNative: false,
      },
    ];

    for (const testCase of cases) {
      const rootDir = await makeRootDir();
      const fixture = await writeMinimalPluginInstallStateFixture({
        rootDir,
        scenario: testCase.scenario,
      });

      expect(fixture.state).toBe(testCase.state);
      expect(fixture.paths.rootDir).toBe(rootDir);
      expect(fixture.paths.repoRoot.startsWith(rootDir)).toBe(true);
      expect(fixture.paths.awHome.startsWith(rootDir)).toBe(true);
      expect(fixture.paths.codexHome.startsWith(rootDir)).toBe(true);
      expect(fixture.paths.claudeHome.startsWith(rootDir)).toBe(true);

      await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(testCase.hasRecord);
      await expect(fs.pathExists(fixture.files.diagnosticCachePath)).resolves.toBe(testCase.hasDiagnostic);
      await expect(fs.pathExists(fixture.files.projectIdentityPath)).resolves.toBe(testCase.hasIdentity);
      await expect(fs.pathExists(fixture.files.dependencyIndexPath)).resolves.toBe(testCase.hasDependencyIndex);
      await expect(fs.pathExists(fixture.files.lifecycleRuntimeRoot)).resolves.toBe(testCase.hasLifecycle);
      await expect(fs.pathExists(fixture.files.nativeMarkerPath)).resolves.toBe(testCase.hasNativeMarker);
      await expect(fs.pathExists(fixture.files.externalNativeConfigPath)).resolves.toBe(testCase.hasExternalNative);
      await expect(fs.pathExists(fixture.files.externalNativeCachePath)).resolves.toBe(testCase.hasExternalNative);
    }
  });

  it('can express per-plugin record, diagnostic cache, shared identity, dependency index, lifecycle, marker, and shared owner without real user directories', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(await makeRootDir());
    const projectTarget = builder.createTarget({ pluginName: 'git-commit', scope: 'project', platform: 'codex' });
    const userTarget = builder.createTarget({ pluginName: 'git-commit', scope: 'user', platform: 'codex' });

    await builder.writeRepoArtifact(projectTarget);
    const projectLifecycle = await builder.writeHistoricalLifecycleRuntime(projectTarget);
    const projectRecord = await builder.writeInstallRecord(projectTarget, projectLifecycle);
    const projectRecordPath = path.join(
      builder.paths.repoRoot,
      '.codex',
      '.agent-workflows',
      'records',
      `${projectTarget.recordId}.json`,
    );
    await builder.writeDiagnosticCache(projectTarget);
    await builder.writeProjectIdentity(projectTarget);

    await builder.writeRepoArtifact(userTarget);
    const userLifecycle = await builder.writeHistoricalLifecycleRuntime(userTarget);
    const userRecord = await builder.writeInstallRecord(userTarget, userLifecycle);
    const userRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${userTarget.recordId}.json`,
    );
    await builder.writeNativeMarker(userTarget, 'install');
    await builder.writeSharedRuntimeOwner(userTarget, userRecordPath);
    await builder.writeDependencyIndex([
      { target: projectTarget, record: projectRecord },
      { target: userTarget, record: userRecord },
    ]);

    await expect(fs.pathExists(projectRecordPath)).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'diagnostics', `${projectTarget.recordId}.json`))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.repoRoot, '.agent-workflows', 'project-artifacts', 'codex', `${projectTarget.sharedIdentityId}.json`))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'dependency-index', 'index.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'lifecycle-runtimes', 'codex', 'project'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'native-recovery', 'codex', 'user', `${userTarget.pluginId}.json`))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'shared-runtime-owners', 'codex', `${userTarget.pluginSlug}.${userTarget.pluginHash}.json`))).resolves.toBe(true);
  });

  it('creates the fresh-clone project fixture as external claimable shared artifacts without a local record', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeRootDir(),
      scenario: 'freshCloneProject',
    });

    expect(fixture.state).toBe('external');
    expect(fixture.target.location.scope).toBe('project');
    await expect(fs.pathExists(fixture.target.repoArtifactPath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.projectIdentityPath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
  });

  it('creates damage fixtures for record, diagnostics, identity, dependency index, lifecycle, and marker edge cases', async () => {
    const cases = [
      { scenario: 'corruptedRecord' as const, state: 'cleanupRequired' },
      { scenario: 'corruptedDiagnosticCache' as const, state: 'installed' },
      { scenario: 'corruptedIdentityMetadata' as const, state: 'installed' },
      { scenario: 'staleDependencyIndex' as const, state: 'cleanupRequired' },
      { scenario: 'unreadableDependencyIndex' as const, state: 'cleanupRequired' },
      { scenario: 'missingHistoricalLifecycle' as const, state: 'installed' },
      { scenario: 'nativeMarkerOnly' as const, state: 'cleanupRequired' },
      { scenario: 'recordAndInstallMarkerResidual' as const, state: 'installed' },
    ] as const;

    for (const { scenario, state } of cases) {
      const fixture = await writeMinimalPluginInstallStateFixture({
        rootDir: await makeRootDir(),
        scenario,
      });

      expect(fixture.state).toBe(state);

      switch (scenario) {
        case 'corruptedRecord': {
          const result = await readInstallRecordFileSafe(fixture.files.installRecordPath);
          expect(result.ok).toBe(false);
          break;
        }
        case 'corruptedDiagnosticCache': {
          await expect(fs.readJson(fixture.files.diagnosticCachePath)).rejects.toThrow();
          break;
        }
        case 'corruptedIdentityMetadata': {
          await expect(fs.readJson(fixture.files.projectIdentityPath)).resolves.toMatchObject({
            artifacts: [{ path: '../outside-repo.txt' }],
          });
          break;
        }
        case 'staleDependencyIndex': {
          await expect(fs.pathExists(fixture.files.dependencyIndexPath)).resolves.toBe(true);
          await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
          break;
        }
        case 'unreadableDependencyIndex': {
          const index = await fs.readJson(fixture.files.dependencyIndexPath);
          expect(index.records[0].recordPath).toBe(fixture.files.installRecordPath);
          await expect(fs.readJson(fixture.files.installRecordPath)).rejects.toThrow();
          break;
        }
        case 'missingHistoricalLifecycle': {
          await expect(fs.pathExists(fixture.files.lifecycleRuntimeRoot)).resolves.toBe(false);
          break;
        }
        case 'nativeMarkerOnly': {
          await expect(fs.pathExists(fixture.files.nativeMarkerPath)).resolves.toBe(true);
          await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
          break;
        }
        case 'recordAndInstallMarkerResidual': {
          await expect(fs.pathExists(fixture.files.nativeMarkerPath)).resolves.toBe(true);
          await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(true);
          break;
        }
      }
    }
  });

  it('reads sibling records independently when one record is corrupted', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(await makeRootDir());
    const healthy = builder.createTarget({ pluginName: 'git-commit', scope: 'project', platform: 'codex' });
    const broken = builder.createTarget({ pluginName: 'openai-docs', scope: 'project', platform: 'codex' });

    await builder.writeRepoArtifact(healthy);
    await builder.writeInstallRecord(healthy);

    await builder.writeRepoArtifact(broken);
    await builder.writeInstallRecord(broken);
    const brokenPath = path.join(
      builder.paths.repoRoot,
      '.codex',
      '.agent-workflows',
      'records',
      `${broken.recordId}.json`,
    );
    await fs.writeFile(brokenPath, '{"version": 2,', 'utf8');

    const read = await builder.readScopedInstallRecordDirectory({
      platform: 'codex',
      scope: 'project',
    });

    expect(read.successes).toHaveLength(1);
    expect(read.successes[0]?.value.record.pluginName).toBe('git-commit');
    expect(read.failures).toHaveLength(1);
    expect(read.failures[0]?.path).toBe(brokenPath);
  });

  it('locks the default stdout forbidden vocabulary guard', () => {
    expect([...DEFAULT_FORBIDDEN_STDOUT_TERMS]).toEqual([
      'ledger',
      'tracking',
      'breadcrumb',
      'snapshot',
      'degraded',
    ]);
    expect(findForbiddenStdoutTerms('Installed without leaking internal terms.')).toEqual([]);
    expect(findForbiddenStdoutTerms('ledger tracking breadcrumb snapshot degraded')).toEqual([
      'ledger',
      'tracking',
      'breadcrumb',
      'snapshot',
      'degraded',
    ]);
  });

  it('tracks the old-state boundaries, file surfaces, and field remap tables as structured fixture data', () => {
    expect(LEGACY_STATE_BOUNDARIES.map((entry) => entry.boundary)).toEqual([
      'install',
      'upgrade',
      'uninstall',
      'status',
      'discovery',
      'console',
      'config refresh',
      'adapter tracking',
      'local marketplace refresh',
    ]);
    expect(LEGACY_STATE_SURFACES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'installed.json',
        writePath: '~/.aw/installed.json',
      }),
      expect.objectContaining({
        id: 'tracking manifest',
        writePath: '<scope-root>/.agent-workflows-manifest.json',
      }),
      expect.objectContaining({
        id: 'install snapshot',
      }),
      expect.objectContaining({
        id: 'capability snapshot',
      }),
      expect.objectContaining({
        id: 'Codex breadcrumb',
      }),
    ]));

    const deleted = LEGACY_FIELD_DISPOSITIONS
      .filter((entry) => entry.disposition === 'deleted')
      .map((entry) => entry.legacyField);
    const installRecord = LEGACY_FIELD_DISPOSITIONS
      .filter((entry) => entry.disposition === 'installRecord')
      .map((entry) => [entry.legacyField, entry.targetField]);
    const diagnosticCache = LEGACY_FIELD_DISPOSITIONS
      .filter((entry) => entry.disposition === 'diagnosticCache')
      .map((entry) => [entry.legacyField, entry.targetField]);
    const derived = LEGACY_FIELD_DISPOSITIONS
      .filter((entry) => entry.disposition === 'derived')
      .map((entry) => entry.legacyField);

    expect(deleted).toEqual(expect.arrayContaining([
      'ledgerState',
      'degradedAt',
      'degradedReason',
      'scopeInitialized',
      'capabilitySnapshot',
    ]));
    expect(installRecord).toEqual(expect.arrayContaining([
      ['lastResolvedVersion', 'record.source.pluginVersion'],
      ['generatedArtifacts', 'record.artifacts'],
      ['dependencyInstallSource', 'record.installSource'],
      ['outgoingDependencyEdges', 'record.dependencyEdges'],
    ]));
    expect(diagnosticCache).toEqual(expect.arrayContaining([
      ['lastRefresh', 'cache.artifacts[].lastRefresh'],
      ['refreshReach', 'cache.artifacts[].refreshReach'],
      ['configDigest', 'cache.artifacts[].configDigest'],
      ['contentDigest', 'cache.artifacts[].contentDigest'],
    ]));
    expect(derived).toEqual(expect.arrayContaining([
      'dependents',
      'refCount',
      'autoRemovable',
      'unusedDependencyHint',
      'dependencies.satisfied',
      'dependencies.missing',
      'dependencies.catalogDrift',
    ]));
  });

  it('keeps lightweight regression coverage for config set/unset/reset and the removed config configure entry', async () => {
    await runWithCurrentRepositoryCwdAsReadOnly(async () => {
      const cliIndexSource = await fs.readFile(
        path.join(process.cwd(), 'src/index.ts'),
        'utf8',
      );
      const cliEntryTestSource = await fs.readFile(
        path.join(process.cwd(), 'tests/integration/cli-entry.test.ts'),
        'utf8',
      );

      expect(cliIndexSource).toContain(".command('set')");
      expect(cliIndexSource).toContain(".command('unset')");
      expect(cliIndexSource).toContain(".command('reset')");
      expect(cliIndexSource).not.toContain(".command('configure')");

      expect(cliEntryTestSource).toContain('supports aw config set/get/reset without leaking schema-less raw values');
      expect(cliEntryTestSource).toContain('rejects removed config configure subcommand');
      expect(cliEntryTestSource).toContain("['config', 'configure', 'git-commit']");
    });
  });
});
