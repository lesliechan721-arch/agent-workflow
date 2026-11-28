import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { promises as nodeFs } from 'node:fs';
import { render } from 'ink-testing-library';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import * as pluginConfig from '../../src/utils/plugin-config.js';
import { prepareRetire, executeRetire, runRetire } from '../../src/recovery/retirement.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { observePreferences, resolvePreferencesPath, writePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import {
  executeRemovedPluginOutputCleanup,
  inspectRemovedPluginCleanup,
  type RemovedPluginCleanupPreparation,
} from '../../src/commands/rebuild-command.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { readPluginConfigStore, resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { type NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';
import { parseOwnedTextHeader, writeOwnedTextFile } from '../../src/utils/ownership.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { CatalogPreparationReadScope } from '../../src/utils/catalog-operation-context.js';
import { validateCatalogSnapshotComplete, validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile, removeCodexMarketplace } from '../../src/utils/codex-config.js';
import {
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  addProjectFixtureRoots,
  replaceCatalogSourcesConfig,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';
import { nativeFixtureLayout, nativeRegistrationId } from '../helpers/write-command-cleanup-fixture.js';

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestDiscovery();
    defaultNativeRuntime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  // Test Value Gate: Active can change even when deployment ownership and
  // absence of the selected plugin are unchanged. Both write entrances must
  // reject the now-stale authorized retirement without removing any output.
  it('rechecks the frozen Active snapshot at both retirement execution entrances', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout } = isolation;
    const cwd = layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'retirement-active-stale');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const scope = 'user' as const;
    await expect(installFixturePlugin(['team/demo'], { cwd, scope, platform: 'codex' }, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env });
    const options = { scope, cwd, env, selector: 'team/demo', targets: ['codex'] };
    const review = await prepareRetire(options, runtime);
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope });
    const outputReview = await inspectRemovedPluginCleanup({
      scope, cwd, env, inventory, pluginId: 'team/demo', nativeCliRunner: runtime.nativeCliRunner,
    });
    expect(outputReview).not.toBeNull();
    expect(outputReview?.snapshotDigest).toBe(active.snapshotDigest);
    const packagePath = (await nativeFixtureLayout('demo', 'team', scope, 'codex')).packageRoot;
    const beforePackage = await snapshotRegularTree(packagePath);
    const beforeIntent = await observeIntent({ cwd, env, scope });
    const configPath = path.join(env.CODEX_HOME!, 'config.toml');
    const beforeConfig = await fs.readFile(configPath);
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }, { name: 'newly-added' }]);
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });
    const next = await resolveActiveCatalogGeneration({ sourceId: 'team', env });
    expect(next.snapshotDigest).not.toBe(active.snapshotDigest);
    expect(next.manifest.entries.map((entry) => entry.name)).not.toContain('demo');
    const stale = await executeRetire(review, { yes: true });
    expect(stale.blockers).toContainEqual(expect.objectContaining({ code: 'operationReviewStale' }));
    const context = await createScopeContext({ cwd, env, scope });
    try {
      await expect(executeRemovedPluginOutputCleanup({
        target: outputReview!, context, selectedTargets: [{ pluginId: 'team/demo', platform: 'codex', scope }],
        runtime,
      })).rejects.toThrow('operationReviewStale');
    } finally {
      await context.dispose();
    }
    expect(await observeIntent({ cwd, env, scope })).toEqual(beforeIntent);
    expect(await fs.readFile(configPath)).toEqual(beforeConfig);
    expect(await snapshotRegularTree(packagePath)).toEqual(beforePackage);
    expect(runtime.installed.has(await nativeRegistrationId('demo'))).toBe(true);
  });

  // Test Value Gate: a valid transport digest is not enough to authorize
  // retirement. The shared inspector must reject incomplete bundle semantics,
  // while both execution entrances preserve the previously reviewed outputs.
  it('rejects retirement when a transport-valid Active disagrees with its bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const sourceRoot = path.join(cwd, 'retirement-incomplete-active');
    const remaining = [{ name: 'leaf' }, { name: 'root', dependencies: ['leaf'] }];
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, ...remaining]);
    const initial = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const scope = 'user' as const;
    await expect(installFixturePlugin(['team/demo'], { cwd, scope, platform: 'codex' }, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, remaining);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });
    const options = { scope, cwd, env, selector: 'team/demo', targets: ['codex'] };
    const inspect = async (preparation?: RemovedPluginCleanupPreparation) => inspectRemovedPluginCleanup({ scope, cwd, env,
      inventory: await inventoryCatalogSourceReferences({ cwd, env, scope }),
      pluginId: 'team/demo', nativeCliRunner: runtime.nativeCliRunner, preparation });
    const review = await prepareRetire(options, runtime);
    expect(review.receipt.blockers).toEqual([]);
    const outputReview = await inspect();
    expect(outputReview?.confirmedCatalogRetirement).toBe(true);
    const catalogReadScope = new CatalogPreparationReadScope({ env });
    const preparation = { catalogReadScope, catalogOperationContext: await catalogReadScope.resolve({}) };
    await expect(inspect(preparation)).resolves.toMatchObject({
      confirmedCatalogRetirement: true, snapshotDigest: outputReview!.snapshotDigest,
    });

    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    catalogManifest.entries.find((entry: { name: string }) => entry.name === 'root').dependencies = [];
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env });
    await expect(validateCatalogSnapshotTransport(active.snapshotPath)).resolves.toMatchObject({ snapshotDigest: active.snapshotDigest });
    await expect(validateCatalogSnapshotComplete(active.snapshotPath)).rejects.toThrow(/dependencies.*does not match its plugin bundle/u);
    expect(active.manifest.entries.map((entry) => entry.name)).not.toContain('demo');
    const deployment = await nativeFixtureLayout('demo', 'team', scope, 'codex');
    const before = {
      intent: await observeIntent({ cwd, env, scope }),
      package: await snapshotRegularTree(deployment.packageRoot),
      manifest: await fs.readFile(path.join(deployment.marketplaceRoot!, '.agents', 'plugins', 'marketplace.json')),
      config: await fs.readFile(path.join(env.CODEX_HOME!, 'config.toml')),
    };
    expect(await inspect()).toBeNull();
    // A changed Active must not inherit the previous generation's Complete evidence.
    expect(await inspect(preparation)).toBeNull();
    // Reusing a current Transport read must still establish Complete semantics.
    const currentReadScope = new CatalogPreparationReadScope({ env });
    expect(await inspect({ catalogReadScope: currentReadScope,
      catalogOperationContext: await currentReadScope.resolve({}) })).toBeNull();
    const blocked = await runRetire({ ...options, yes: true }, runtime);
    expect(blocked).toMatchObject({ ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'removedPluginActiveUnavailable' })]) });
    const stale = await executeRetire(review, { yes: true });
    expect(stale.blockers).toContainEqual(expect.objectContaining({ code: 'operationReviewStale' }));
    const context = await createScopeContext({ cwd, env, scope });
    try {
      await expect(executeRemovedPluginOutputCleanup({ target: outputReview!, context,
        selectedTargets: [{ pluginId: 'team/demo', platform: 'codex', scope }], runtime }))
        .rejects.toThrow('operationReviewStale');
    } finally {
      await context.dispose();
    }
    expect(await observeIntent({ cwd, env, scope })).toEqual(before.intent);
    expect(await snapshotRegularTree(deployment.packageRoot)).toEqual(before.package);
    expect(await fs.readFile(path.join(deployment.marketplaceRoot!, '.agents', 'plugins', 'marketplace.json'))).toEqual(before.manifest);
    expect(await fs.readFile(path.join(env.CODEX_HOME!, 'config.toml'))).toEqual(before.config);
    expect(runtime.installed.has(deployment.nativeIdentity.registrationId!)).toBe(true);
  });

  // Test Value Gate: the lock covers a multi-selector public remove, so each
  // reviewed plugin must survive legitimate changes to sibling entries while
  // changes to its own current deployment still invalidate the Review.
  it('retires two same-source selectors in one public remove but rejects changes to the reviewed target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const sourceRoot = path.join(cwd, 'retirement-same-source-batch');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'second' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const scope = 'user' as const;
    await expect(installFixturePlugin(['team/demo', 'team/second', 'team/other'], { cwd, scope, platform: 'codex' }, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    for (const name of ['demo', 'second']) await fs.remove(path.join(sourceRoot, 'plugins', name));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });
    const demo = await nativeFixtureLayout('demo', 'team', scope, 'codex');
    const second = await nativeFixtureLayout('second', 'team', scope, 'codex');
    const other = await nativeFixtureLayout('other', 'team', scope, 'codex');
    const manifestPath = path.join(demo.marketplaceRoot!, '.agents', 'plugins', 'marketplace.json');
    const manifestBefore = await fs.readFile(manifestPath);
    const sibling = (await fs.readJson(manifestPath)).plugins.find((entry: { name: string }) => entry.name === 'other');
    expect(sibling).toBeDefined();
    const beforeIntent = await observeIntent({ cwd, env, scope });
    const beforeSecond = await snapshotRegularTree(second.packageRoot);
    const beforeOther = await snapshotRegularTree(other.packageRoot);
    const review = await prepareRetire({ scope, cwd, env, selector: 'team/second', targets: ['codex'] }, runtime);
    expect(review.receipt.blockers).toEqual([]);
    const manifest = await fs.readJson(manifestPath);
    const entry = manifest.plugins.find((candidate: { name: string }) => candidate.name === 'second');
    expect(entry).toBeDefined();
    entry.description = 'Changed target marketplace entry after Review.';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    const changedManifest = await fs.readFile(manifestPath);
    const stale = await executeRetire(review, { yes: true });
    expect(stale).toMatchObject({ ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
    expect(await observeIntent({ cwd, env, scope })).toEqual(beforeIntent);
    expect(await fs.readFile(manifestPath)).toEqual(changedManifest);
    expect(await snapshotRegularTree(second.packageRoot)).toEqual(beforeSecond);
    expect(runtime.installed.has(second.nativeIdentity.registrationId!)).toBe(true);
    await fs.outputFile(manifestPath, manifestBefore);

    const result = await runPublicLifecycle('remove', ['team/demo', 'team/second'], {
      cwd, env, cliVersion: '1.0.0', scope, context: 'user', yes: true,
    }, runtime);
    expect(result.status, JSON.stringify(result)).toBe('success');
    expect(result.data).toMatchObject({ remainingTargets: [], targetResults: expect.arrayContaining(
      ['team/demo', 'team/second'].map((pluginId) => expect.objectContaining({ pluginId, scope, target: 'codex',
        deploymentReceipts: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
          package: 'absent', registration: 'absent',
        }) })]),
      })),
    ) });
    expect(await readFixtureRequirements({ cwd, env, scope })).toMatchObject({ roots: [{ pluginId: 'team/other' }] });
    for (const deployment of [demo, second]) {
      expect(await fs.pathExists(deployment.packageRoot)).toBe(false);
      expect(runtime.installed.has(deployment.nativeIdentity.registrationId!)).toBe(false);
    }
    expect((await fs.readJson(manifestPath)).plugins).toEqual([sibling]);
    expect(await snapshotRegularTree(other.packageRoot)).toEqual(beforeOther);
    expect(runtime.installed.has(other.nativeIdentity.registrationId!)).toBe(true);
  });

  it('reviews both scopes and deletes only the removed plugin settings and Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-whole-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'official', env: isolation.env });
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity, logicalIdentity: active.logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env, values: { common: true },
    });
    for (const platform of ['codex', 'claude'] as const) {
      await writePluginConfigStore({
        sourceId: 'official', sourceIdentity: active.sourceIdentity,
        logicalIdentity: active.logicalIdentity, pluginName: 'demo', scope: 'user', platform,
        cwd, env: isolation.env, values: { secret: platform },
      });
    }
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity,
      pluginName: 'other', scope: 'user', cwd, env: isolation.env,
      values: { retained: true },
    });
    for (const scope of ['user', 'project'] as const) {
      const location = { scope, cwd, env: isolation.env };
      await writeIntentFixture(location, {
        schemaVersion: 2, kind: 'aw-plugin-intents',
        roots: [
          { pluginId: 'official/demo', platforms: ['codex', 'claude'] },
          { pluginId: 'official/other', platforms: ['codex'] },
        ],
        dependencyScopeOverrides: [],
      });
    }
    const preferencesPath = await resolvePreferencesPath({ scope: 'user', cwd, env: isolation.env });
    const preferencesBefore = await fs.readFile(preferencesPath);
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { [await nativeRegistrationId("demo", "official")]: false },
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectOptions = { scope: 'project' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'] as const, deleteConfig: false };
    const preview = await prepareRetire(projectOptions, runtime);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.stringContaining('删除 project 声明 official/demo'),
    ]));
    const unauthorized = await executeRetire(preview);
    expect(unauthorized.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewRequired' }),
    ]));
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots)
      .toContainEqual({ pluginId: 'official/demo', platforms: ['claude', 'codex'] });
    const stalePreview = await prepareRetire(projectOptions, runtime);
    const preferenceLocation = { scope: 'project' as const, cwd, env: isolation.env };
    const originalPreferences = await observePreferences(preferenceLocation);
    if (originalPreferences.state !== 'valid') throw new Error('Expected valid project preferences.');
    await writePreferences(preferenceLocation, { ...originalPreferences.value, targets: ['codex'] });
    const stale = await executeRetire(stalePreview, { yes: true });
    expect(stale.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    await writePreferences(preferenceLocation, originalPreferences.value);
    const projectRetired = await runRetire({ ...projectOptions, yes: true }, runtime);
    expect(projectRetired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      scope: 'project', declarationChanged: true, preferencesChanged: false, configChanged: false });
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots)
      .toEqual([{ pluginId: 'official/other', platforms: ['codex'] }]);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toContainEqual({ pluginId: 'official/demo', platforms: ['claude', 'codex'] });
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    }))).toBe(true);
    const userRetired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], deleteConfig: true, yes: true }, runtime);
    expect(userRetired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      scope: 'user', declarationChanged: true, preferencesChanged: false, configChanged: true });
    for (const scope of ['user', 'project'] as const) {
      const state = await readFixtureRequirements({ scope, cwd, env: isolation.env });
      expect(state.roots).toEqual([{ pluginId: 'official/other', platforms: ['codex'] }]);
      expect(state.dependencyScopeOverrides).toEqual([]);
    }
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    }))).toBe(false);
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    }))).toBe(false);
    expect((await readPluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity, pluginName: 'other',
      scope: 'user', cwd, env: isolation.env,
    })).values).toEqual({ retained: true });
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    const repeated = await runRetire({ ...projectOptions, yes: true }, runtime);
    expect(repeated.declarationChanged).toBe(false);
  });

  // Test Value Gate: a config-only failure must not suggest a retry that expands output deletion.
  it('requires a new review for config deletion without expanding the original output targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'removed-config-receipt-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: initial.digest, env: isolation.env });
    const runtime = await createClaudeNativeTestRuntime(isolation);
    const claudeRunner = runtime.nativeCliRunner;
    const mixedRuntime = { ...defaultNativeRuntime, ...runtime.runtime, nativeCliRunner: async (invocation: NativeCliInvocation) => {
      const claude = path.basename(invocation.command).replace(/\.(?:cmd|exe)$/iu, '') === 'claude'
        || invocation.args.some((arg) => arg.includes('@anthropic-ai'));
      return claude ? claudeRunner(invocation) : defaultNativeRuntime.nativeCliRunner(invocation);
    } };
    for (const platform of ['codex', 'claude'] as const) {
      await expect(installFixturePlugin(['team/demo'], { cwd, platform, scope: 'user' }, mixedRuntime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
    }
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env, values: { retained: true } });
    const configPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
      scope: 'user', cwd, env: isolation.env });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0',
      env: isolation.env, impactConfirmed: true });
    const claudeSettingsPath = path.join(runtime.claudeHome, 'settings.json');
    const claudeBefore = await fs.readFile(claudeSettingsPath);
    const reset = vi.spyOn(pluginConfig, 'deletePluginConfigStore').mockRejectedValueOnce(
      Object.assign(new Error('injected config deletion failure'), { code: 'configResetFailed' }));
    const failed = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['codex'], deleteConfig: true, yes: true }, mixedRuntime)
      .finally(() => reset.mockRestore());
    expect(failed).toMatchObject({ ok: false, declarationChanged: true,
      configChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'configResetFailed' })]) });
    expect(await fs.pathExists(configPath)).toBe(true);

    expect(failed.recoveryActions.filter((action) => action.startsWith('aw ')))
      .not.toEqual(expect.arrayContaining([expect.stringContaining('--delete-config')]));
    expect(failed.recoveryActions.some((action) => !action.startsWith('aw ')
      && action.includes('--delete-config'))).toBe(true);
    // A new domain review retains the prior exact target choice; the CLI does not
    // invent a target-filtered normal remove command that its public contract forbids.
    const recovered = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['codex'], deleteConfig: true, yes: true }, mixedRuntime);
    expect(recovered).toMatchObject({ configChanged: true, declarationChanged: false });
    expect(recovered.requestedTargets.map((target) => target.agent)).toEqual(['codex']);
    expect(recovered.recoveryActions.join('\n')).not.toContain('--delete-config');
    expect(await fs.pathExists(configPath)).toBe(false);
    expect(await fs.readFile(claudeSettingsPath)).toEqual(claudeBefore);
  });

  it('keeps shared Codex output when official observation fails, then retries retirement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-retry-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const selected = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], selected, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const workingRunner = runtime.nativeCliRunner.getMockImplementation()!;
    runtime.nativeCliRunner.mockImplementation(async (invocation) =>
      invocation.args.includes('list') && invocation.args.includes('--json')
        ? { exitCode: 1, stdout: '', stderr: 'simulated failure' }
        : workingRunner(invocation));
    const retireOptions = { scope: 'user' as const, cwd: selected.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const failed = await runRetire(retireOptions, runtime);
    expect(failed.ok, JSON.stringify(failed)).toBe(false);
    expect(failed.remainingTargets).toContainEqual(expect.objectContaining({
      pluginId: 'official/demo', agent: 'codex', scope: 'user',
    }));
    expect(failed.recoveryActions).toContain('aw plugin remove official/demo --scope user');
    expect(runtime.installed.has(await nativeRegistrationId("demo", "official"))).toBe(true);
    expect(await fs.pathExists((await nativeFixtureLayout("demo", "official", "project", "codex")).packageRoot))
      .toBe(true);
    runtime.nativeCliRunner.mockImplementation(workingRunner);
    const recovered = await runRetire(retireOptions, runtime);
    expect(recovered).toMatchObject({ command: 'intent:retire', ok: true, remainingTargets: [] });
    expect(runtime.installed.has(await nativeRegistrationId("demo", "official"))).toBe(false);
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins[await nativeRegistrationId("demo", "official")]).toBeUndefined();
    expect(await fs.pathExists((await nativeFixtureLayout("demo", "official", "user", "codex")).packageRoot)).toBe(false);
    expect((await readFixtureRequirements({ scope: 'user', cwd: selected.cwd, env: isolation.env })).roots)
      .toEqual([]);
  });

  it('keeps declarations and the other scope unchanged during mixed ordinary cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-mixed-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    const user = { cwd, platform: 'codex' as const, scope: 'user' as const };
    for (const pluginId of ['official/demo', 'official/other']) {
      await expect(installFixturePlugin([pluginId], user, runtime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
    }
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { [await nativeRegistrationId("demo", "official")]: false, [await nativeRegistrationId("other", "official")]: false },
    });
    await writeIntentFixture({ scope: 'project', cwd, env: isolation.env }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'official/demo', platforms: ['codex'] },
        { pluginId: 'official/other', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const selectors = ['official/demo', 'other'];
    const projectIntentBefore = await observeIntent({
      scope: 'project', cwd, env: isolation.env,
    });
    const userIntentBefore = await observeIntent({
      scope: 'user', cwd, env: isolation.env,
    });
    const projectConfigBefore = await fs.readFile(projectConfigPath);
    const preview = await cleanupWriteCommand(selectors, user, {
      ...runtime, previewOperationPlan: true,
    });
    expect(preview.operationPlan?.actions.some((action) => action.scope === 'project'))
      .toBe(false);
    const cleaned = await cleanupWriteCommand(selectors, { ...user, yes: true }, {
      ...runtime, expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
    });
    expect(cleaned.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'official/other', scope: 'user', platform: 'codex' }) }),
    ]));
    await expect(observeIntent({ scope: 'project', cwd, env: isolation.env }))
      .resolves.toEqual(projectIntentBefore);
    await expect(observeIntent({ scope: 'user', cwd, env: isolation.env }))
      .resolves.toEqual(userIntentBefore);
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfigBefore);
    expect(runtime.installed.has(await nativeRegistrationId("demo", "official"))).toBe(true);
  });

  it('preserves shared Codex projection when official retirement evidence becomes unknown', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-unknown-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const selected = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], selected, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const workingRunner = runtime.nativeCliRunner.getMockImplementation()!;
    let listCalls = 0;
    runtime.nativeCliRunner.mockImplementation(async (invocation) => {
      const args = invocation.args;
      if (args.includes('list') && args.includes('--json') && ++listCalls > 2) {
        return { exitCode: 1, stdout: '', stderr: 'simulated postcheck unavailable' };
      }
      return workingRunner(invocation);
    });
    const retireOptions = { scope: 'user' as const, cwd: selected.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const failed = await runRetire(retireOptions, runtime);
    expect(failed.ok).toBe(false);
    const projection = (await nativeFixtureLayout("demo", "official", "project", "codex")).packageRoot;
    expect(await fs.pathExists(projection)).toBe(true);
    expect(runtime.installed.has(await nativeRegistrationId("demo", "official"))).toBe(true);
    runtime.nativeCliRunner.mockImplementation(workingRunner);
    const recovered = await runRetire(retireOptions, runtime);
    expect(recovered).toMatchObject({ command: 'intent:retire', ok: true, remainingTargets: [] });
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins[await nativeRegistrationId("demo", "official")]).toBeUndefined();
    expect(await fs.pathExists(projection)).toBe(false);
  });

  // Test Value Gate: when the local unregister commits before a failed User
  // unregister, the receipt must retain partial output changes and a retry path.
  it.each([false, true])('retires removed Claude demand across scopes and preserves unrelated plugins (User uninstall initially fails=%s)', async (failUserUninstall) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-claude-source');
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['claude'];
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    const { runtime, nativeCliRunner, installedPath, claudeHome, projectRoot, isClaudeInvocation }
      = await createClaudeNativeTestRuntime(isolation);
    for (const [pluginId, scope] of [
      ['official/demo', 'user'], ['official/demo', 'project'], ['official/other', 'user'],
    ] as const) {
      const installed = await installFixturePlugin([pluginId], { cwd, platform: 'claude', scope }, runtime);
      expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    }
    const before = await fs.readJson(installedPath) as { plugins: Record<string, unknown[]> };
    expect(before.plugins[await nativeRegistrationId("demo", "official", "claude")]).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user' }),
      expect.objectContaining({ scope: 'local', projectPath: projectRoot }),
    ]));
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const selectedNativeId = await nativeRegistrationId('demo', 'official', 'claude');
    const retireOptions = { scope: 'project' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true };
    if (failUserUninstall) {
      const workingRunner = nativeCliRunner.getMockImplementation()!;
      nativeCliRunner.mockImplementation(async (invocation) => {
        const args = invocation.args;
        if (isClaudeInvocation(invocation) && args.includes('uninstall') && args.includes(selectedNativeId)
          && args[args.indexOf('--scope') + 1] === 'user') {
          return { exitCode: 1, stdout: '', stderr: 'Simulated User uninstall failure.' };
        }
        return workingRunner(invocation);
      });
      const failed = await runRetire(retireOptions, runtime);
      const records = (await fs.readJson(installedPath)).plugins[selectedNativeId];
      expect(records).toEqual([expect.objectContaining({ scope: 'user' })]);
      expect(await fs.pathExists((await nativeFixtureLayout('demo', 'official', 'project', 'claude')).packageRoot)).toBe(true);
      expect(failed).toMatchObject({ ok: false, outputsMayHaveChanged: true,
        targetResults: [expect.objectContaining({ agent: 'claude', execution: 'partial' })],
        recoveryActions: expect.arrayContaining(['aw plugin remove official/demo --scope project']),
      });
      nativeCliRunner.mockImplementation(workingRunner);
    }
    const projectRetired = await runRetire(retireOptions, runtime);
    expect(projectRetired).toMatchObject({ declarationChanged: !failUserUninstall, ok: true });
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toContainEqual(expect.objectContaining({ pluginId: 'official/demo' }));
    const userRetired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(userRetired).toMatchObject({ declarationChanged: true, ok: true });
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots).toEqual([]);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toEqual([expect.objectContaining({ pluginId: 'official/other' })]);
    const uninstallScopes = nativeCliRunner.mock.calls.filter(([invocation]) => {
      const args = invocation.args.slice(invocation.args.indexOf('plugin'));
      return isClaudeInvocation(invocation) && args[0] === 'plugin'
        && args[1] === 'uninstall' && args[2] === selectedNativeId;
    })
      .map(([invocation]) => invocation.args[invocation.args.indexOf('--scope') + 1]);
    expect(uninstallScopes).toEqual(failUserUninstall ? ['local', 'user', 'user'] : ['local', 'user']);
    const after = await fs.readJson(installedPath) as { plugins: Record<string, unknown[]> };
    expect(after.plugins[await nativeRegistrationId("demo", "official", "claude")]).toBeUndefined();
    expect(await fs.pathExists((await nativeFixtureLayout("demo", "official", "project", "claude")).packageRoot)).toBe(false);
    expect(after.plugins[await nativeRegistrationId("other", "official", "claude")]).toEqual([expect.objectContaining({ scope: 'user' })]);
    expect((await fs.readJson(path.join(claudeHome, 'settings.json'))).enabledPlugins)
      .toMatchObject({ [await nativeRegistrationId("other", "official", "claude")]: true });
    expect(await fs.pathExists((await nativeFixtureLayout("other", "official", "project", "claude")).packageRoot))
      .toBe(true);
  });

  it.each([
    ['canonical with bare record', 'canonical'],
    ['foreign registration with bare record', 'foreign'],
    ['unreadable marketplace registration', 'unknown'],
  ] as const)('keeps Claude shared native ownership safe during retirement for %s', async (_label, mode) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `removed-claude-${mode}-source`);
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['claude'];
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    const { runtime, nativeCliRunner, installedPath, claudeHome, isClaudeInvocation } = await createClaudeNativeTestRuntime(isolation);
    for (const pluginId of ['official/demo', 'official/other']) {
      const installed = await installFixturePlugin([pluginId], {
        cwd, platform: 'claude', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    }
    if (mode !== 'unknown') {
      const installed = await fs.readJson(installedPath) as {
        plugins: Record<string, Array<Record<string, unknown>>>;
      };
      installed.plugins.demo = [{ name: 'demo', scope: 'user', version: '1.0.0' }];
      await fs.outputJson(installedPath, installed);
    }
    const canonicalRecords = (await fs.readJson(installedPath)).plugins as Record<string, unknown[]>;
    const demoId = await nativeRegistrationId('demo', 'official', 'claude');
    const otherId = await nativeRegistrationId('other', 'official', 'claude');
    const marketplaceName = (await nativeFixtureLayout('demo', 'official', 'user', 'claude')).marketplaceName!;
    const settingsPath = path.join(claudeHome, 'settings.json');
    if (mode === 'foreign') {
      const settings = await fs.readJson(settingsPath) as Record<string, unknown>;
      const extraKnownMarketplaces = { ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>) };
      extraKnownMarketplaces[marketplaceName] = {
        source: { source: 'directory', path: path.join(cwd, 'foreign-marketplace') },
      };
      await fs.outputJson(settingsPath, { ...settings, extraKnownMarketplaces });
    }
    if (mode === 'unknown') {
      await fs.outputFile(path.join(claudeHome, 'plugins', 'known_marketplaces.json'), '{bad json');
      runtime.nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const args = invocation.args.slice(invocation.args.indexOf('plugin'));
        return args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list'
          ? { exitCode: 1, stdout: '', stderr: 'Marketplace inventory unavailable.' }
          : nativeCliRunner(invocation);
      });
    }
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const nativeSettingsBefore = await fs.readFile(settingsPath);
    nativeCliRunner.mockClear();
    const retired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(retired.configChanged).toBe(false);
    const selectedNativeId = await nativeRegistrationId('demo', 'official', 'claude');
    const uninstalls = nativeCliRunner.mock.calls.filter(([invocation]) => {
      const args = invocation.args.slice(invocation.args.indexOf('plugin'));
      return isClaudeInvocation(invocation) && args[0] === 'plugin'
        && args[1] === 'uninstall' && args[2] === selectedNativeId;
    });
    expect(uninstalls).toHaveLength(0);
    const records = (await fs.readJson(installedPath)).plugins as Record<string, unknown[]>;
    if (mode !== 'unknown') {
      expect(records.demo).toEqual([expect.objectContaining({ name: 'demo' })]);
    }
    expect(records[demoId]).toEqual(canonicalRecords[demoId]);
    expect(records[otherId]).toEqual(canonicalRecords[otherId]);
    const projection = (await nativeFixtureLayout("demo", "official", "project", "claude")).packageRoot;
    expect(await fs.pathExists(projection)).toBe(true);
    if (mode === 'foreign') {
      await expect(fs.readFile(settingsPath)).resolves.toEqual(nativeSettingsBefore);
      expect(retired.ok, JSON.stringify(retired)).toBe(false);
      expect(retired.targetResults).toContainEqual(expect.objectContaining({
        pluginId: 'official/demo', agent: 'claude', scope: 'user', observation: 'unknown',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'deploymentOwnershipUnconfirmed' }),
        ]),
        deploymentReceipts: expect.arrayContaining([expect.objectContaining({
          after: expect.objectContaining({ ownership: 'foreign' }),
        })]),
      }));
      expect(retired.remainingTargets).toContainEqual(expect.objectContaining({ pluginId: 'official/demo', agent: 'claude', scope: 'user' }));
    }
    if (mode === 'unknown') {
      expect(retired.ok, JSON.stringify(retired)).toBe(false);
      expect(retired.targetResults).toContainEqual(expect.objectContaining({
        pluginId: 'official/demo', agent: 'claude', scope: 'user', execution: 'failed', observation: 'unknown',
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'nativeRetireFailed' }),
          expect.objectContaining({ code: 'deploymentOwnershipUnconfirmed' }),
          expect.objectContaining({ code: 'nativeObservationUnknown' }),
        ]),
        deploymentReceipts: expect.arrayContaining([expect.objectContaining({
          after: expect.objectContaining({ ownership: 'unknown' }),
        })]),
      }));
      expect(retired.remainingTargets).toContainEqual(expect.objectContaining({ pluginId: 'official/demo', agent: 'claude', scope: 'user' }));
      expect(retired.recoveryActions).toContain('aw plugin remove official/demo --scope user');
      await expect(fs.readFile(path.join(claudeHome, 'plugins', 'known_marketplaces.json'), 'utf8')).resolves.toBe('{bad json');
    }
  });

  it('cleans a proven orphan package and its disabled project activation when native registration is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-unbound-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    runtime.installed.delete(await nativeRegistrationId("demo", "official"));
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    await fs.outputFile(userConfigPath,
      removeCodexMarketplace(await fs.readFile(userConfigPath, 'utf8'),
        (await nativeFixtureLayout('demo', 'official', 'user')).marketplaceName!));
    await applyCodexConfigTransactionFile(userConfigPath, {
      removePluginActivations: [await nativeRegistrationId("demo", "official")],
    });
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { [await nativeRegistrationId("demo", "official")]: false },
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const result = await runRetire({ scope: 'project', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true }, runtime);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'official/demo', agent: 'codex', scope: 'project',
      deploymentReceipts: expect.arrayContaining([expect.objectContaining({
        after: expect.objectContaining({ package: 'absent', registration: 'absent' }),
      })]),
    }));
    expect((await readCodexConfigFile(projectConfigPath)).snapshot.plugins[await nativeRegistrationId("demo", "official")])
      .toBeUndefined();
    expect(await fs.pathExists((await nativeFixtureLayout("demo", "official", "project", "codex")).packageRoot))
      .toBe(false);
  });

  it('retains a shared package and its retirement retry when package deletion fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-projection-retry-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo', 'official/other'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const marketplaceRoot = (await nativeFixtureLayout("demo", "official", "project", "codex")).marketplaceRoot!;
    const projection = path.join(marketplaceRoot, 'plugins', 'demo');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const options = { scope: 'user' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const manifestPath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
    const sibling = (await fs.readJson(manifestPath)).plugins.find((entry: { name: string }) => entry.name === 'other');
    expect(sibling).toBeDefined();
    const siblingRoot = path.join(marketplaceRoot, 'plugins', 'other');
    const siblingBefore = await snapshotRegularTree(siblingRoot);
    const packageBefore = await snapshotRegularTree(projection);
    const renameOriginal = nodeFs.rename.bind(nodeFs);
    let projectionRemoveAttempted = false;
    const rename = vi.spyOn(nodeFs, 'rename').mockImplementation(async (candidate, destination) => {
      if (path.resolve(String(candidate)) === path.resolve(projection)) {
        projectionRemoveAttempted = true;
        throw new Error('simulated projection delete failure');
      }
      return renameOriginal(candidate, destination);
    });
    const first = await runRetire(options, runtime).finally(() => rename.mockRestore());
    expect(projectionRemoveAttempted).toBe(true);
    expect(first.ok).toBe(false);
    expect(first.recoveryActions).toContain('aw plugin remove official/demo --scope user');
    expect(first.declarationChanged).toBe(true);
    expect(await snapshotRegularTree(projection)).toEqual(packageBefore);
    expect((await fs.readJson(manifestPath)).plugins).toContainEqual(sibling);
    expect(await snapshotRegularTree(siblingRoot)).toEqual(siblingBefore);
    // The exact marketplace entry may have been removed before the package
    // deletion failed. Recovery must work through the advertised ordinary
    // remove command, without requiring the old manifest to be restored.
    const second = await runPublicLifecycle('remove', ['official/demo'], {
      cwd, env: isolation.env, cliVersion: '1.0.0', scope: 'user', context: 'user', yes: true,
    }, runtime);
    expect(second.status, JSON.stringify(second)).toBe('success');
    expect(second.data).toMatchObject({ remainingTargets: [] });
    expect((await fs.readJson(manifestPath)).plugins.some((entry: { name: string }) => entry.name === 'demo')).toBe(false);
    expect((await fs.readJson(manifestPath)).plugins).toEqual([sibling]);
    expect(await snapshotRegularTree(siblingRoot)).toEqual(siblingBefore);
    expect(runtime.installed.has(await nativeRegistrationId('other', 'official'))).toBe(true);
    expect(await fs.pathExists(projection)).toBe(false);
  });

  it('preserves a foreign tree behind a symlinked marketplace plugins ancestor', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-symlinked-projection-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const marketplaceRoot = (await nativeFixtureLayout("demo", "official", "project", "codex")).marketplaceRoot!;
    const pluginsRoot = path.join(marketplaceRoot, 'plugins');
    const foreignRoot = path.join(cwd, 'foreign-marketplace-plugins');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    await fs.move(pluginsRoot, foreignRoot);
    await fs.symlink(foreignRoot, pluginsRoot, 'dir');
    const foreignFile = path.join(foreignRoot, 'demo', 'preserve.txt');
    await fs.outputFile(foreignFile, 'foreign content\n');
    const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const configBefore = await fs.readFile(configPath);
    const cleaned = await cleanupWriteCommand(['official/demo'], {
      cwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned)).toBe('failed');
    expect(cleaned.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'official/demo', platform: 'codex', scope: 'user' }),
      errorCode: 'stateInventoryResidual',
    }));
    expect(cleaned.warnings).toContainEqual(expect.stringContaining('Native namespace path contains a symbolic link.'));
    expect(cleaned.recoveryDiagnostics).toContainEqual(expect.objectContaining({
      detail: expect.objectContaining({ reasonCode: 'nativeNamespaceUnsafe', path: pluginsRoot }),
    }));
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    expect((await fs.lstat(pluginsRoot)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign content\n');
    const result = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true }, runtime);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(JSON.stringify(result.blockers)).toContain('removedPluginMarketplaceProjectionUnsafe');
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign content\n');
    expect(runtime.installed.has(await nativeRegistrationId("demo", "official"))).toBe(true);
  });

  it.each([['absent', false], ['unknown', false], ['unknown', true]] as const)('retires User demand without reading caller Project Portable and legacy config state (%s, subdirectory=%s)', async (portableState, fromSubdirectory) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-config-only-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'team', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    if (fromSubdirectory) await git(cwd, ['init']);
    const invocationCwd = fromSubdirectory ? path.join(cwd, 'nested', 'child') : cwd;
    await fs.ensureDir(invocationCwd);
    const userPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    });
    await fs.outputFile(userPath, '{broken-json');
    expect(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    })).toBe(userPath);
    const projectPath = path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json');
    await fs.outputFile(projectPath, '{broken-project-json');
    await addProjectFixtureRoots({ cwd, env: isolation.env, selectors: ['team/demo'] });
    await writeIntentFixture({ cwd, env: isolation.env, scope: 'user' }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });
    const providerRoot = path.join(cwd, '.agent-workflows', '.local', 'portable', portableJsonDigest('team/demo').slice(7));
    const portableSkill = path.join(cwd, '.agents', 'skills', 'unverified-demo', 'SKILL.md');
    if (portableState === 'unknown') {
      await fs.outputFile(path.join(providerRoot, 'evidence.txt'), 'unverified provider evidence');
      await fs.outputFile(portableSkill, 'portable bytes must remain');
    }
    const binRoot = path.join(isolation.layout.rootDir, 'unavailable-skills-bin');
    await fs.outputFile(path.join(binRoot, 'skills'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    const env = { ...isolation.env, PATH: `${binRoot}${path.delimiter}${isolation.env.PATH ?? ''}` };

    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectIntentBefore = await observeIntent({ cwd, env, scope: 'project' });
    const configBefore = await fs.readFile(userPath);
    const projectConfigBefore = await fs.readFile(projectPath);
    const retirement = { cwd: invocationCwd, env, scope: 'user' as const,
      selector: 'team/demo', targets: ['codex'], yes: true };
    const preview = await prepareRetire(retirement, { nativeCliRunner: async () => ({
      exitCode: 0, stdout: '{"installed":[],"available":[]}', stderr: '',
    }) });
    expect(preview.receipt.command).toBe('intent:retire');
    const receipt = await executeRetire(preview, { yes: true });
    expect(receipt).toMatchObject({ kind: 'aw-recovery', scope: 'user',
      declarationChanged: true, configChanged: false });
    if (portableState === 'unknown') {
      await expect(fs.readFile(portableSkill, 'utf8')).resolves.toBe('portable bytes must remain');
      await expect(fs.readFile(path.join(providerRoot, 'evidence.txt'), 'utf8')).resolves.toBe('unverified provider evidence');
    }
    await expect(fs.readFile(userPath)).resolves.toEqual(configBefore);
    await expect(fs.readFile(projectPath)).resolves.toEqual(projectConfigBefore);
    await expect(observeIntent({ cwd, env, scope: 'project' })).resolves.toEqual(projectIntentBefore);
    await expect(readIntentFixture({ cwd, env, scope: 'user' })).resolves.toMatchObject({ roots: [] });
  });

  it('blocks explicit retirement when Active is unavailable and preserves saved config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-config-only-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-config-only-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'team', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    const cwd = isolation.layout.fixtureCwd;
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
      values: { retained: true },
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'remaining', type: 'path', primary: true, path: remainingRoot,
      }] },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const result = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['claude'], yes: true });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'removedPluginActiveUnavailable' }),
    ]));
    expect(result.configChanged).toBe(false);
    expect((await readPluginConfigStore({
      sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    })).values).toEqual({ retained: true });
  });

  it.each(['directory', 'binding', 'binding-user-catalog', 'binding-project-source', 'symlink'] as const)(
    'keeps the exact config reset boundary for a deleted plugin (%s)',
    async (mode) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `removed-config-${mode}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [{
          id: 'team', type: 'path', primary: true, path: sourceRoot,
        }] },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      const cwd = isolation.layout.fixtureCwd;
      const scope = mode === 'directory' || mode === 'binding-project-source' ? 'project' : 'user';
      if (scope === 'project') await fs.ensureDir(path.join(cwd, '.git'));
      const configPath = resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'demo', scope, cwd, env: isolation.env,
      });
      const external = path.join(cwd, 'config-link-target.json');
      if (mode === 'directory') {
        await fs.ensureDir(configPath);
      } else if (mode.startsWith('binding')) {
        await fs.outputJson(configPath, {
          schemaVersion: 5, sourceId: 'team', pluginName: 'demo',
          binding: mode === 'binding-user-catalog'
            ? { kind: 'catalog', logicalIdentity: active.logicalIdentity }
            : mode === 'binding-project-source'
              ? { kind: 'source', sourceIdentity: active.sourceIdentity }
              : { kind: 'source', sourceIdentity: `sha256:${'0'.repeat(64)}` },
          values: { retained: true },
        });
      } else {
        await fs.outputFile(external, 'retained\n');
        await fs.ensureDir(path.dirname(configPath));
        await fs.symlink(external, configPath, 'file');
      }
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
      await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const result = await runRetire({ scope, cwd, env: isolation.env,
        selector: 'team/demo', targets: ['claude'], deleteConfig: true, yes: true });
      if (mode === 'symlink') {
        expect(result.configChanged).toBe(true);
        expect(await fs.pathExists(configPath)).toBe(false);
        expect(await fs.readFile(external, 'utf8')).toBe('retained\n');
      } else {
        expect(result.ok).toBe(false);
        expect(await fs.pathExists(configPath)).toBe(true);
        expect(JSON.stringify(result.blockers)).toContain(mode === 'directory'
          ? 'removedPluginConfigTargetUnsupported'
          : 'removedPluginConfigIdentityConflict');
      }
    },
  );

  it.each([
    { mode: 'owned-normal', force: false, intentOnly: false },
    { mode: 'owned-force', force: true, intentOnly: false },
    { mode: 'intent-only-normal', force: false, intentOnly: true },
  ] as const)(
    'retires through scoped TUI Review after the Active Catalog drops the plugin ($mode)',
    async ({ force, intentOnly }) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `active-entry-removed-${force ? 'force' : 'normal'}-source`,
      );
      const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
      const configure = (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = undefined;
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { configKeys: [], scopes: ['project'] };
      };
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
      await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role' });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
      const projectIntentLocation = {
        scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      const userIntentLocation = {
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      await writeIntentFixture(userIntentLocation, {
        schemaVersion: 2,
        kind: 'aw-plugin-intents',
        roots: [{ pluginId: 'team/other', platforms: ['codex'] }],
        dependencyScopeOverrides: [],
      });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
      });
      const activeBeforeRemoval = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, logicalIdentity: activeBeforeRemoval.logicalIdentity,
        pluginName: 'demo', scope: 'user', platform: 'codex', cwd: isolation.layout.fixtureCwd,
        env: isolation.env, values: { selected: true },
      });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'other', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: 'other' },
      });
      const preferencesPath = await resolvePreferencesPath(userIntentLocation);
      const preferencesBefore = await fs.readFile(preferencesPath);
      const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(sharedConfig, {
        upsertMcpServers: { foreign: { command: 'foreign' } },
      });
      const foreignSkill = path.join(
        isolation.layout.fixtureCwd, '.agents', 'skills', 'foreign-skill', 'SKILL.md',
      );
      await fs.outputFile(foreignSkill, 'foreign\n');
      const ownedRole = path.join(
        isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-demo-demo-role.toml",
      );
      await expect(fs.pathExists(ownedRole)).resolves.toBe(true);
      expect(parseOwnedTextHeader(await fs.readFile(ownedRole, 'utf8'))?.identity).toMatchObject({
        sourceId: 'team', pluginId: 'team/demo', plugin: 'demo',
        artifactKey: path.basename(ownedRole), platform: 'codex', scope: 'project',
      });
      if (intentOnly) {
        expect((await cleanupWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)).overallState).toBe('succeeded');
        await expect(fs.pathExists(ownedRole)).resolves.toBe(false);
      }

      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
      await fs.remove(pluginRoot);
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      expect(active.manifest.entries.map((entry) => entry.name)).toEqual(['other']);

      const status = await statusCommandV8({
        plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
      expect(status.payload.targets).toEqual([
        expect.objectContaining({
          pluginId: 'team/demo',
          reasons: expect.arrayContaining([expect.objectContaining({
            code: 'codexIntentSourceUnavailable',
          })]),
        }),
      ]);
      const dependencies = createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: runtime.nativeCliRunner,
        interactive: false,
      }));
      const review = await dependencies.prepareScopedTask({ kind: 'retire', scope: 'project',
        selector: 'team/demo', targets: ['codex'], deleteConfig: force },
      new AbortController().signal);
      expect(review.kind).toBe('retire');
      const execution = await dependencies.executeScopedTask(review);
      expect(execution).toMatchObject({ kind: 'recovery', receipt: {
        command: 'intent:retire', ok: true, declarationChanged: true, configChanged: force,
      } });

      await expect(readFixtureRequirements(projectIntentLocation)).resolves.toMatchObject({
        schemaVersion: 3,
        kind: 'aw-plugin-intents',
        roots: [],
        dependencyScopeOverrides: [],
      });
      await expect(readFixtureRequirements(userIntentLocation)).resolves.toMatchObject({
        roots: [{ pluginId: 'team/other', platforms: ['codex'] }],
      });
      const refreshed = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      expect(refreshed.intent.state).toBe('valid');
      expect(refreshed.inventory?.some((target) => target.pluginId === 'team/demo')).toBe(false);
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject(force ? { state: 'missing', exists: false, values: {} } : { values: { retained: true } });
      expect(await fs.pathExists(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))).toBe(!force);
      expect(await fs.pathExists(ownedRole), JSON.stringify(execution.receipt)).toBe(false);
      await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'other', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ values: { retained: 'other' } });
      await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
      await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
        snapshot: { mcpServers: { foreign: { value: { command: 'foreign' } } } },
      });
    },
    30_000,
  );

  it('rejects a stale scoped retire Review when owned output appears before the write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeCliRunner = defaultNativeRuntime.nativeCliRunner;
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0',
      env: isolation.env, impactConfirmed: true });
    const review = await prepareRetire({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env, selector: 'team/demo', targets: ['codex'], yes: true },
    { nativeCliRunner });
    const liveLayout = await nativeFixtureLayout('demo', 'team', 'project', 'codex', sourceIdentity);
    const rulesRoot = liveLayout.supplementRoot!;
    const physicalKey = liveLayout.renderUnits.find((unit) => unit.output === 'supplement')!.physicalKey;
    const driftPath = path.join(rulesRoot, 'aw-team-demo-drift-owner.toml');
    await writeOwnedTextFile({
          path: driftPath,
          allowedRoot: rulesRoot,
          identity: {
            owner: 'agent-workflows', sourceId: 'team', sourceIdentity, physicalKey,
            pluginId: 'team/demo', plugin: 'demo', artifactKey: path.basename(driftPath),
            platform: 'codex', scope: 'project',
          },
          content: 'name = "drift-owner"\ndescription = "Added after Review"\ndeveloper_instructions = "Keep this role."\n',
    });
    const execution = await executeRetire(review, { yes: true });
    expect(execution.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(execution.declarationChanged).toBe(false);
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    const nativeId = await nativeRegistrationId('demo');
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).snapshot.plugins[nativeId]?.enabled).toBe(true);
  }, 30_000);
});
