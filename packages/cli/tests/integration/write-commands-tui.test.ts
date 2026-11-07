import { describe, beforeEach, expect, it } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { render } from 'ink-testing-library';
import {
  observePreferences,
  resolvePreferencesPath,
  writePreferences,
  createEmptyPreferences,
} from '../../src/intent/deployment-preferences.js';
import { observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { setRebuildCommandTestHooksForTests } from '../../src/commands/rebuild-command.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { sanitizeTestDiagnostic } from '../helpers/test-command-diagnostics.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  setAtomicConfigBeforeRenameHookForTests,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import type { CatalogSource } from '../../src/types.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';

import {
  installFixturePlugin,
  syncFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  createCodexNativeTestRuntime,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('adds a missing dependency when sync --all starts from intent roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'upgrade-all-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root' },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const projectInstall = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(projectInstall.overallState, JSON.stringify(projectInstall.rebuildResults)).toBe('succeeded');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    const upgraded = await syncFixturePlugin([], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', all: true, interactive: false,
    }, runtime);

    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(upgraded.dependencyPlan?.requestedPluginIds).toEqual(['team/root']);
    expect(upgraded.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['leaf', 'root']);
    expect(upgraded.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', relation: 'dependency', action: 'install' }),
    ]));
  });

  it('keeps the blocked dependency identity and reason in TUI preparation diagnostics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-blocked-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: (manifest) => {
        manifest.extensions = { agents: [{
          name: 'leaf-role', description: 'Leaf role.', prompt: 'Use leaf.',
        }] };
      } },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const foreignPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-leaf-role.toml');
    await fs.outputFile(foreignPath, 'developer_instructions = "foreign"\n');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    }));
    const controller = new TuiController(dependencies);
    const plan = await controller.prepareScopedTask({
      kind: 'recovery', command: 'install', selectors: ['team/root'],
      scope: 'project',
    });
    expect(plan.kind).toBe('recovery');
    expect(plan.plan.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/root', blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'artifactCollision' }),
      ]) }),
    ]));
    expect(plan.plan.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'artifactCollision' }),
      ]) }),
    ]));
    await controller.discardScopedPlan(plan);
    controller.dispose();
    await expect(fs.readFile(foreignPath, 'utf8')).resolves.toBe('developer_instructions = "foreign"\n');
  });

  it.each([['user', ['codex']], ['project', ['codex']], ['project', ['codex', 'claude']]] as const)('previews the complete dependency closure for saved machine targets in %s %s', async (scope, platforms) => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: [...platforms],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: isolation.env });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    }));
    const controller = new TuiController(dependencies);
    const originalPreferences = await observePreferences({ scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const plan = await controller.prepareScopedTask({ kind: 'recovery', command: 'install',
      selectors: ['team/root'], scope });
    if (plan.kind !== 'recovery') throw new Error('Expected recovery plan');
    expect(plan.plan.receipt.selection).toMatchObject({ agents: [...platforms].sort(), origin: 'preference' });
    expect(plan.plan.receipt.requestedTargets.map(({ pluginId, agent, scope }) =>
      `${pluginId}#${agent}#${scope}`).sort()).toEqual(platforms.flatMap((platform) =>
      ['team/leaf', 'team/root'].map((pluginId) => `${pluginId}#${platform}#${scope}`)).sort());
    expect(await observeIntent({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .toMatchObject({ state: 'absent' });
    expect(await observePreferences({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .toEqual(originalPreferences);
    await controller.discardScopedPlan(plan);
    controller.dispose();
  });

  it.each(['save', 'cancel', 'stale', 'write-failure'] as const)(
    'preserves machine preferences across a reviewed TUI install %s', async (outcome) => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const sourceRoot = path.join(location.cwd, 'tui-save-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: location.env });
    const retainedExclusion = { plugin: 'other/retained', target: 'claude' as const };
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['codex'],
      exclusions: [retainedExclusion] });
    const prefsPath = await resolvePreferencesPath(location);
    expect(await resolvePreferencesPath({ ...location, scope: 'user' })).toBe(prefsPath);
    const original = await fs.readFile(prefsPath);
    const intentPath = await resolveIntentPath(location);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      ...location, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    }));
    const controller = new TuiController(dependencies);
    const plan = await controller.prepareScopedTask({ kind: 'recovery', command: 'install',
      selectors: ['team/root'], scope: 'project' });
    if (plan.kind !== 'recovery') throw new Error('Expected recovery plan');
    expect(plan.plan.plannedImpact.preferences).toBe(false);
    expect(plan.plan.receipt.selection).toMatchObject({ agents: ['codex'], origin: 'preference' });
    expect(await fs.readFile(prefsPath)).toEqual(original);
    expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
    if (outcome === 'cancel') {
      await controller.discardScopedPlan(plan);
      expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
    } else {
      if (outcome === 'stale') await fs.appendFile(prefsPath, '\n');
      if (outcome === 'write-failure') setAtomicConfigBeforeRenameHookForTests(async (filePath) => {
        if (filePath === intentPath) throw new Error('fixtureIntentWriteFailure');
      });
      if (outcome === 'write-failure') {
        try {
          await expect(controller.executeScopedTask(plan)).rejects.toThrow('fixtureIntentWriteFailure');
        } finally {
          setAtomicConfigBeforeRenameHookForTests(undefined);
        }
        expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
      } else {
        const result = await controller.executeScopedTask(plan);
        if (result.kind !== 'recovery') throw new Error('Expected recovery receipt');
        if (outcome === 'stale') {
          expect(result.receipt).toMatchObject({ declarationChanged: false, preferencesChanged: false,
            outputsMayHaveChanged: false, blockers: [expect.objectContaining({ code: 'operationReviewStale' })] });
          expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
        } else {
          expect(result.receipt).toMatchObject({ ok: true, declarationChanged: true, preferencesChanged: false });
          expect(await observeIntent(location)).toMatchObject({ state: 'valid', value: {
            roots: [{ pluginId: 'team/root' }],
          } });
          expect(await observePreferences(location)).toMatchObject({ state: 'valid', value: {
            schemaVersion: 2, targets: ['codex'], exclusions: [retainedExclusion],
          } });
        }
      }
    }
    expect(await fs.readFile(prefsPath)).toEqual(outcome === 'stale'
      ? Buffer.from(original.toString() + '\n') : original);
    if (outcome !== 'save') expect(await fs.pathExists(path.join(location.cwd, '.codex'))).toBe(false);
    controller.dispose();
  });

  it('executes dependency installation through the reviewed TUI backend', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }));
    const plan = await dependencies.prepareScopedTask({
      kind: 'recovery', command: 'install', selectors: ['team/root'],
      scope: 'project',
    }, new AbortController().signal);
    expect(plan.kind).toBe('recovery');
    const result = await dependencies.executeScopedTask(plan);
    expect(result).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(result.receipt.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/leaf', agent: 'codex', scope: 'project', execution: 'applied',
      requiredBy: ['team/root'], blockers: [],
    }), expect.objectContaining({
      pluginId: 'team/root', execution: 'applied',
      backend: expect.objectContaining({
        resolvedPluginIds: ['team/leaf', 'team/root'],
        dependencyEdges: [{ from: 'team/root', to: 'team/leaf', platform: 'codex' }],
      }),
    })]);
  });

  it('fails closed before a dependency write when the operation plan no longer matches', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-plan-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const preview = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const stalePlan = {
      ...preview.dependencyPlan!,
      resolvedPluginIds: ['team/root'],
    };

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedPlanFingerprint: 'sha256:stale' });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
    ]);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
  });

  it('runs TUI project install and cleanup while retaining the declared root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-inventory-owner-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }));
    const installPlan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
    }, new AbortController().signal);
    const installed = await dependencies.executeScopedTask!(installPlan);
    expect(installed).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    const cleanupPlan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'cleanup', selectors: ['team/demo'],
    }, new AbortController().signal);
    const cleaned = await dependencies.executeScopedTask!(cleanupPlan);
    expect(cleaned).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    await expect(readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ roots: [{ pluginId: 'team/demo' }] });
  });

  it('rejects a stale TUI recovery plan before changing an already advanced target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-inventory-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    });
    const dependencies = createTuiControllerDependencies(context);
    const plan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
    }, new AbortController().signal);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, context)).resolves.toMatchObject({ overallState: 'succeeded' });
    const targetPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(targetPath, 'utf8');
    const beforeMtime = (await fs.stat(targetPath)).mtimeMs;
    await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
      kind: 'recovery', receipt: {
        ok: false, outputsMayHaveChanged: false,
        blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
      },
    });
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(before);
    await expect(fs.stat(targetPath)).resolves.toMatchObject({ mtimeMs: beforeMtime });
  });

  it('reviews exact force cleanup through the real controller and rejects changed output evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const sourceRoot = path.join(location.cwd, 'tui-force-owned-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: (manifest) => {
      manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review changes.' }] };
    } }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: location.env });
    const context = createCliExecutionContext({ ...location, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }) });
    const dependencies = createTuiControllerDependencies(context);
    const controller = new TuiController(dependencies);
    const agentPath = path.join(location.cwd, '.codex', 'agents', 'aw-demo-reviewer.toml');
    const foreignPath = path.join(location.cwd, '.codex', 'agents', 'foreign.toml');
    await fs.outputFile(agentPath, '# agent-workflows-owner: {invalid\nowned damaged output\n');
    await fs.outputFile(foreignPath, 'foreign bytes\n');
    const original = await fs.readFile(agentPath);
    const candidate = await controller.getForceCleanupCandidate('team/demo', 'codex', 'project');
    expect(candidate).toMatchObject({ pluginId: 'team/demo', platform: 'codex', scope: 'project', actionCount: 1 });
    const cancelled = await controller.startForceCleanupReview(candidate!);
    expect(cancelled.kind).toBe('recovery');
    await controller.discardScopedPlan(cancelled);
    expect(await fs.readFile(agentPath)).toEqual(original);
    const stale = await controller.startForceCleanupReview(candidate!);
    await fs.appendFile(agentPath, 'changed\n');
    expect(await controller.executeScopedTask(stale)).toMatchObject({ kind: 'recovery', receipt: {
      ok: false, outputsMayHaveChanged: false, blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
    } });
    expect(await fs.readFile(agentPath, 'utf8')).toBe(original.toString() + 'changed\n');
    const reviewed = await controller.startForceCleanupReview(candidate!);
    if (reviewed.kind !== 'recovery') throw new Error('Expected recovery plan');
    expect(reviewed.plan.receipt.requestedTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', agent: 'codex', scope: 'project' }),
    ]);
    const result = await controller.executeScopedTask(reviewed);
    expect(result).toMatchObject({ kind: 'recovery', receipt: { declarationChanged: false, preferencesChanged: false } });
    expect(await fs.pathExists(agentPath)).toBe(false);
    expect(await fs.readFile(foreignPath, 'utf8')).toBe('foreign bytes\n');
    expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
    controller.dispose();
  });

  it('does not offer shared-only force cleanup without an Intent change or exact path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-force-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    });
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, context)).resolves.toMatchObject({ overallState: 'succeeded' });
    const dependencies = createTuiControllerDependencies(context);
    const controller = new TuiController(dependencies);
    await controller.load();
    await expect(controller.getForceCleanupCandidate('team/leaf', 'codex', 'project'))
      .resolves.toBeUndefined();
    controller.dispose();
    await expect(statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready' })] },
    });
  });

  it.each(['path', 'git'] as const)(
    'blocks a reviewed %s source update at locked evidence capture without writes',
    async (provider) => {
      const isolation = getCurrentSourceTestIsolation();
      await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
        ...createEmptyPreferences(), targets: ['codex'],
      });
      const workRoot = path.join(isolation.layout.fixtureCwd, `tui-${provider}-review-work`);
      const sourceRoot = provider === 'git' ? path.join(workRoot, 'catalog') : workRoot;
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'review A\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.extensions = { instructions: [{ name: 'review', title: 'Review',
          content: 'Review source content.' }] };
      });
      let source: CatalogSource;
      if (provider === 'git') {
        const remote = path.join(isolation.layout.fixtureCwd, 'tui-review-remote.git');
        await git(workRoot, ['init', '--initial-branch=main']);
        await git(workRoot, ['config', 'user.email', 'test@example.test']);
        await git(workRoot, ['config', 'user.name', 'AW Test']);
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review A']);
        await git(isolation.layout.fixtureCwd, ['clone', '--bare', workRoot, remote]);
        source = {
          id: 'team', type: 'git', primary: true, url: remote, subdir: 'catalog',
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        };
      } else {
        source = { id: 'team', type: 'path', primary: true, path: sourceRoot };
      }
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const dependencies = createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        interactive: false,
      }));
      const plan = await dependencies.prepareScopedTask!({
        kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
        }, new AbortController().signal);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'review B\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.extensions = { instructions: [{ name: 'review', title: 'Review',
          content: 'Review source content.' }] };
      });
      if (provider === 'git') {
        const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
        const manifest = await fs.readJson(manifestPath);
        manifest.catalogVersion = '2.0.0';
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review B']);
        await git(workRoot, ['push', source.url, 'HEAD:refs/heads/main']);
      }
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
        kind: 'recovery', receipt: {
          ok: false, outputsMayHaveChanged: false,
          blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
        },
      });
      await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
        .resolves.toBe(false);
    },
  );

  it('returns a new Review before plugin or config writes when actual source evidence advances', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-actual-source-review');
    const writeSource = async (content: string): Promise<void> => createCatalogSnapshotFixture(
      sourceRoot,
      'demo',
      [],
      `${content}\n`,
      (manifest) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'review', title: 'Review', content }],
        };
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', title: 'Mode' } } };
      },
    );
    await writeSource('review B');
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    });
    const executeWithSourceAdvance = async (
      intent: Parameters<TuiController['buildOperationReview']>[0],
    ) => {
      await writeSource('review B');
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const controller = new TuiController(createTuiControllerDependencies(context));
      await controller.load();
      const review = await controller.buildOperationReview(intent);
      await writeSource('actual C');
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      try {
        return await controller.executeOperation(review.reviewToken);
      } finally {
        controller.dispose();
      }
    };

    await writeSource('review B');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const dependencies = createTuiControllerDependencies(context);
    const plan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
    }, new AbortController().signal);
    await writeSource('actual C');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
      kind: 'recovery', receipt: {
        ok: false, outputsMayHaveChanged: false,
        blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
      },
    });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);

    const saveResult = await executeWithSourceAdvance({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', context: 'project',
      updates: { mode: 'strict' },
    });
    expect(saveResult).toMatchObject({ state: 'stale', review: { title: '保存插件设置' } });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: false });

    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'preserved' },
    });
    const resetResult = await executeWithSourceAdvance({
      kind: 'configReset', pluginId: 'team/demo', scope: 'user', context: 'project',
    });
    expect(resetResult).toMatchObject({ state: 'stale', review: { title: '重置插件设置' } });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'preserved' } });
  });

  it('projects dynamic config and saves or resets it only through the real Controller review bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          level: {
            type: 'string',
            title: '审查级别',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'fast', title: '快速', value: 'fast' },
                { id: 'strict', title: '严格', value: 'strict', recommended: true },
              ],
            },
          },
          count: { type: 'number', validation: { minimum: 1, maximum: 10 }, title: '重试次数' },
          token: { type: 'string', sensitive: true, title: '令牌' },
          rules: { type: 'string', title: '规则文件' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level', 'count', 'token', 'rules'] }],
        },
      };
    });
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const page = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'user', projectLayer: 'shared' },
      new AbortController().signal,
    );
    expect(page.groups).toEqual([
      expect.objectContaining({
        title: '基本设置',
        fields: expect.arrayContaining([
          expect.objectContaining({
            key: 'level',
            choices: expect.arrayContaining([
              expect.objectContaining({ id: 'fast', title: '快速', value: 'fast' }),
              expect.objectContaining({ id: 'strict', title: '严格', value: 'strict', recommended: true }),
            ]),
          }),
          expect.objectContaining({ key: 'count', min: 1, max: 10 }),
          expect.objectContaining({ key: 'token', sensitive: true }),
        ]),
      }),
    ]);
    expect(page.presets).toEqual([]);

    const controller = new TuiController(dependencies);
    await controller.load();
    const save = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { level: 'strict', count: '7', token: 'sk-private' },
      sensitiveKeys: ['token'],
    });
    expect(JSON.stringify(save)).not.toContain('sk-private');
    await expect(controller.executeOperation(save.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });

    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { level: 'strict', count: 7, token: 'sk-private' } });

    await expect(controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { count: 99 },
    })).rejects.toThrow('操作未建立。请检查当前设置后重试。');

    const unavailableRoot = `${sourceRoot}-unavailable`;
    await fs.move(sourceRoot, unavailableRoot);
    const availability = await controller.getConfigResetAvailability(
      'team/demo',
      { scope: 'user', projectLayer: 'shared' },
    );
    expect(availability).toMatchObject({
      exists: true,
      sourceIdentityPresent: true,
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(availability)).not.toContain('sk-private');
    expect(JSON.stringify(availability)).not.toContain(sourceRoot);

    await expect(controller.buildOperationReview({
      kind: 'configReset',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
    })).resolves.toMatchObject({ title: '重置插件设置' });
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      exists: true,
      values: { level: 'strict', count: 7, token: 'sk-private' },
    });

    await fs.move(unavailableRoot, sourceRoot);
    const restoredSave = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', updates: { level: 'fast' },
    });
    await expect(controller.executeOperation(restoredSave.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    const onlineReset = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
    });
    await expect(controller.executeOperation(onlineReset.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    controller.dispose();
  });

  it('executes a real dual-platform TUI write under one complete locked review', async (test) => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex', 'claude'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-both-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const files = { "SKILL.md": "---\\nname: review\\ndescription: Review.\\n---\\n", "README.md": "Review.\\n" };',
      'if (context.platform === "codex") files["agents/openai.yaml"] = "policy:\\n  allow_implicit_invocation: true\\n";',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: `${context.platform}-review`, kind: "skill", platform: context.platform,',
      '  target: `${context.platform}.skill`, state: "present", refreshKeys: [],',
      '  skillKey: "review", content: { files }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex', 'claude'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: (['codex', 'claude'] as const).map((platform) => ({
          id: `${platform}-review`,
          platform,
          scopes: ['user', 'project'],
          target: `${platform}.skill`,
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
        })),
      };
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', title: '模式' } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codex = await createCodexNativeTestRuntime(isolation);
    const claude = await createClaudeNativeTestRuntime(isolation);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: (invocation) => invocation.command === 'claude'
        ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation),
      interactive: false,
    }));

    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const request = { kind: 'recovery' as const, command: 'install' as const,
      scope: 'project' as const, selectors: ['team/demo'] };
    const installPlan = await dependencies.prepareScopedTask!(request, new AbortController().signal);
    expect(installPlan).toMatchObject({ kind: 'recovery', scope: 'project' });
    if (installPlan.kind !== 'recovery') throw new Error('Expected recovery plan.');
    expect(installPlan.plan.receipt.requestedTargets.map((target) => target.agent))
      .toEqual(['claude', 'codex']);
    const installed = await dependencies.executeScopedTask!(installPlan);
    expect(installed).toMatchObject({ kind: 'recovery',
      receipt: { scope: 'project', command: 'install' } });
    if (installed.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(installed.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/demo', agent: 'codex', scope: 'project' }),
      expect.objectContaining({ pluginId: 'team/demo', agent: 'claude', scope: 'project' }),
    ]));
    expect(installed.receipt.targetResults.flatMap((target) =>
      target.blockers.map((blocker) => blocker.code))).not.toContain('operationReviewStale');

    const reinstallRequest = { ...request, command: 'reinstall' as const };
    const failedPlan = await dependencies.prepareScopedTask!(
      reinstallRequest, new AbortController().signal);
    setRebuildCommandTestHooksForTests({
      async afterTargetBuilt() {
        throw new Error('durableCleanupFailed: retained backup cleanup failed');
      },
    });
    try {
      const outcome = await dependencies.executeScopedTask!(failedPlan);
      expect(outcome).toMatchObject({ kind: 'recovery',
        receipt: { scope: 'project', command: 'reinstall', ok: false } });
      if (outcome.kind !== 'recovery') throw new Error('Expected recovery receipt.');
      expect(outcome.receipt.targetResults.map((target) => target.agent))
        .toEqual(expect.arrayContaining(['codex', 'claude']));
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }
    const configIntent = {
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', context: 'project',
      updates: { mode: 'strict' },
    } as const;
    const reinstallPlan = await dependencies.prepareScopedTask!(
      reinstallRequest, new AbortController().signal);
    const configController = new TuiController(dependencies);
    await configController.load();
    const configReview = await configController.buildOperationReview(configIntent);
    const concurrentResults = await Promise.race([
      Promise.allSettled([
        dependencies.executeScopedTask!(reinstallPlan),
        configController.executeOperation(configReview.reviewToken),
      ]),
      new Promise<never>((_resolve, reject) => setTimeout(() =>
        reject(new Error('ABBA operation lock timeout')), 5_000)),
    ]);
    const safeMessage = (message: string) => sanitizeTestDiagnostic(message, isolation.env).slice(0, 1000);
    const rejection = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' ? {
      code: typeof result.reason?.code === 'string' ? safeMessage(result.reason.code) : undefined,
      message: safeMessage(result.reason instanceof Error ? result.reason.message : String(result.reason)),
    } : undefined;
    const reinstallReceipt = concurrentResults[0].status === 'fulfilled'
      && concurrentResults[0].value.kind === 'recovery' ? concurrentResults[0].value.receipt : undefined;
    const configResult = concurrentResults[1].status === 'fulfilled' ? concurrentResults[1].value : undefined;
    const configDiagnostics = configResult?.operationRecordId
      ? configController.getOperationDiagnostic(configResult.operationRecordId)?.diagnostics : undefined;
    console.log('AW_TEST_RESULT', JSON.stringify({
      test: test.task.name,
      reinstall: {
        status: concurrentResults[0].status,
        ok: reinstallReceipt?.ok,
        blockers: reinstallReceipt?.blockers.map(({ code }) => code),
        errors: reinstallReceipt?.errors.map(({ code, message }) => ({ code, message: safeMessage(message) })),
        rejection: rejection(concurrentResults[0]),
      },
      configSave: {
        status: concurrentResults[1].status,
        state: configResult?.state,
        code: configResult && 'code' in configResult ? configResult.code : undefined,
        message: configResult && 'message' in configResult ? safeMessage(configResult.message) : undefined,
        summaryCode: configResult && 'summary' in configResult ? configResult.summary?.code : undefined,
        effects: configResult?.effects,
        diagnostics: configDiagnostics?.map(({ code, stage, safeMessage: message }) => ({ code, stage, message: safeMessage(message) })),
        rejection: rejection(concurrentResults[1]),
      },
    }));
    if (concurrentResults[0].status === 'rejected') {
      expect(concurrentResults[0].reason).toMatchObject({ code: 'operationReviewStale' });
    } else {
      expect(concurrentResults[0].value).toMatchObject({ kind: 'recovery',
        receipt: { scope: 'project', command: 'reinstall' } });
    }
    if (concurrentResults[1].status === 'rejected') {
      expect(concurrentResults[1].reason).toMatchObject({ code: 'operationReviewStale' });
    } else {
      expect(concurrentResults[1].value.state).toMatch(/succeeded|stale/);
      if (concurrentResults[1].value.state === 'succeeded') {
        const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
        await expect(readPluginConfigStore({
          sourceId: 'team',
          sourceIdentity: (await calculateCatalogSourceIdentity({
            id: 'team', type: 'path', primary: true, path: sourceRoot,
          })),
          logicalIdentity, pluginName: 'demo', scope: 'user',
          cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({ values: { mode: 'strict' } });
      }
    }
    configController.dispose();
  });

  it('rejects a reviewed User install after concurrent Project demand changes without touching output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-scope-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'scope evidence' }],
        agents: [{ name: 'reviewer', description: 'Review.', prompt: 'scope evidence' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));

    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner, interactive: false,
    }));
    const request = { kind: 'recovery' as const, command: 'install' as const,
      scope: 'user' as const, selectors: ['team/demo'] };
    const review = await dependencies.prepareScopedTask!(request, new AbortController().signal);
    expect(review).toMatchObject({ kind: 'recovery', scope: 'user' });
    const concurrent = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(concurrent.overallState).toBe('succeeded');
    const projectIntent = await readFixtureRequirements({ scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const projectAgentPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml');
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const projectAgent = await fs.readFile(projectAgentPath);
    const projectConfig = await fs.readFile(projectConfigPath);

    const result = await dependencies.executeScopedTask!(review);
    expect(result).toMatchObject({ kind: 'recovery', receipt: {
      scope: 'user', ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
    } });
    await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml')))
      .resolves.toBe(false);
    await expect(observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ state: 'absent' });
    await expect(readFixtureRequirements({ scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env })).resolves.toEqual(projectIntent);
    await expect(fs.readFile(projectAgentPath)).resolves.toEqual(projectAgent);
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfig);
  });

  it('reviews and executes I03 partial removal through the real TUI write bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-partial-remove-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'Review changes.' }],
        agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review changes.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    const agentPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml');
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    await fs.remove(agentPath);
    const foreignPath = path.join(path.dirname(agentPath), 'foreign.toml');
    await fs.outputFile(foreignPath, 'foreign bytes\n');
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner, interactive: false,
    })));
    await controller.load();
    const issue = controller.listUserIssues().find((entry) =>
      entry.category === 'incompleteInstallation'
      && entry.pluginId === 'team/demo'
      && entry.platform === 'codex'
      && entry.scope === 'project');
    expect(issue, JSON.stringify(controller.snapshot.viewModel?.issues)).toBeDefined();
    const review = await controller.prepareScopedTask({ kind: 'recovery', command: 'uninstall',
      scope: 'project', selectors: ['team/demo'] });
    expect(review).toMatchObject({ kind: 'recovery', scope: 'project' });

    const removal = await controller.executeScopedTask(review);
    expect(removal, JSON.stringify(removal)).toMatchObject({ kind: 'recovery', receipt: {
      scope: 'project', command: 'uninstall', declarationChanged: true,
      preferencesChanged: false, configChanged: false,
    } });
    await expect(readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).resolves.toMatchObject({
        roots: [],
      });
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    await expect(fs.readFile(foreignPath, 'utf8')).resolves.toBe('foreign bytes\n');
    controller.dispose();
  });

  it('returns a new Review when source evidence changes before dispatch', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-stale-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'must not be written' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const request = { kind: 'recovery' as const, command: 'install' as const,
      scope: 'project' as const, selectors: ['team/demo'] };
    const review = await dependencies.prepareScopedTask!(request, new AbortController().signal);
    expect(review).toMatchObject({ kind: 'recovery', scope: 'project' });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'changed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'changed content' }],
      };
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const result = await dependencies.executeScopedTask!(review);
    expect(result).toMatchObject({ kind: 'recovery', receipt: { scope: 'project', ok: false } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(result.receipt.blockers.concat(result.receipt.errors).map((entry) => entry.code))
      .toContain('operationReviewStale');
    await expect(readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).resolves.toMatchObject({ roots: [] });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
  });
});
