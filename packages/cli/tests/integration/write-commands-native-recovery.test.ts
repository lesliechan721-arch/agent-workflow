import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { render } from 'ink-testing-library';
import { readRecoveryStatus, type RecoveryStatus } from '../../src/recovery/status.js';
import * as platformRegistry from '../../src/platforms/registry.js';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { setRebuildCommandTestHooksForTests, type RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import type { FrozenDeploymentPlan } from '../../src/platforms/contracts.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { setNativeCliRunnerOverrideForTests, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';
import { parseOwnedTextHeader, readSkillOwnerMarker } from '../../src/utils/ownership.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';

import {
  installWriteCommand,
  syncWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  syncFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  writeStatusSystemCodexPackage,
  createNativeDependencyCatalog,
  writeDynamicSkillRenderer,
} from '../helpers/write-command-fixture.js';

function observedTarget(status: RecoveryStatus, pluginId: string, scope: 'user' | 'project', agent: 'codex' | 'claude' = 'codex') {
  const target = status.observedTargets?.find((entry) => entry.pluginId === pluginId && entry.scope === scope && entry.agent === agent);
  expect(target, JSON.stringify(status)).toBeDefined();
  return target!;
}

let codexLayout: Awaited<ReturnType<typeof getNativeTestLayout>>;
let nativeQualification: ReturnType<typeof installNativeTestQualification>;
const nativeId = (name: string) => `${name}@${codexLayout.marketplaceName}`;

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    nativeQualification = installNativeTestQualification({ discovery: true, trust: true });
    const isolation = getCurrentSourceTestIsolation();
    // Use only namespace positions from this synthetic identity. Ownership fixtures use their actual source identity.
    codexLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/namespace-fixture',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('installs a dependency closure in dependency-first order and keeps present dependencies', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const runtime = await createCodexNativeTestRuntime(isolation);
    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual([
      'team/leaf',
      'team/middle',
      'team/root',
    ]);
    expect(result.rebuildResults.map((entry) => entry.target.pluginName)).toEqual([
      'leaf',
      'middle',
      'root',
    ]);
    const repeated = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(repeated.overallState, JSON.stringify(repeated.rebuildResults)).toBe('succeeded');
    expect(repeated.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/middle', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/root', relation: 'requested' }),
    ]));
  });

  it('repairs one shared Native dependency for two reviewed project roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'two-root-shared-dependency');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner, interactive: false,
    }));
    const plan = await dependencies.prepareScopedTask({
      kind: 'recovery', command: 'install', scope: 'project',
      selectors: ['team/first', 'team/second'],
    }, new AbortController().signal);
    expect(plan.kind).toBe('recovery');
    const result = await dependencies.executeScopedTask(plan);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'recovery', receipt: { kind: 'aw-recovery', ok: true } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(result.receipt.requestedRoots).toEqual(['team/first', 'team/second']);
    const backend = result.receipt.targetResults.find((target) => target.pluginId === 'team/first')
      ?.backend as { targetResults?: Array<{ target: { pluginId: string }; action: string }> } | undefined;
    expect(backend?.targetResults?.filter((target) => target.target.pluginId === 'team/leaf'))
      .toHaveLength(1);
    expect(runtime.installed).toEqual(new Set([nativeId('leaf'), nativeId('first'), nativeId('second')]));
    expect((await readIntentFixture({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).roots.map((root) => root.pluginId)).toEqual(['team/first', 'team/second']);
    expect((await readIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).roots).toEqual([]);
  }, 30_000);

  it('updates only selected native plugins and dependencies that require materialization', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'selected-native-update-source');
    const writeCatalog = async (version: string) => createNativeDependencyCatalog(sourceRoot, [
      ...['changed-dependency', 'unrelated'].map((name) => ({
        name,
        configureManifest: (manifest: PluginMeta['manifest']) => { manifest.version = version; },
      })),
      { name: 'kept-dependency' },
      {
        name: 'root',
        dependencies: ['changed-dependency', 'kept-dependency'],
        configureManifest: (manifest: PluginMeta['manifest']) => { manifest.version = version; },
      },
    ]);
    await writeCatalog('1.0.0');
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeRuntime = await createCodexNativeTestRuntime(isolation);
    const runtime = { env: isolation.env, nativeCliRunner: nativeRuntime.nativeCliRunner };
    const commandOptions = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const, yes: true };
    const installed = await installFixturePlugin(['team/root', 'team/unrelated'], commandOptions, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceRoot = codexLayout.marketplaceRoot!;
    for (const name of ['unrelated', 'kept-dependency']) {
      await fs.outputFile(path.join(marketplaceRoot, 'plugins', name, 'local.txt'), `${name} retained\n`);
    }
    const before = await snapshotRegularTree(path.join(marketplaceRoot, 'plugins', 'unrelated'));

    await writeCatalog('2.0.0');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const callsBeforeSync = nativeRuntime.nativeCliRunner.mock.calls.length;
    const updated = await syncWriteCommand(['team/root'], commandOptions, runtime);

    expect(updated.overallState, JSON.stringify(updated.rebuildResults)).toBe('succeeded');
    expect(updated.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/kept-dependency', action: 'keep' }),
    ]));
    for (const name of ['root', 'changed-dependency']) {
      await expect(fs.readJson(path.join(marketplaceRoot, 'plugins', name, '.codex-plugin', 'plugin.json')))
        .resolves.toMatchObject({ version: '2.0.0' });
    }
    // The installed Native versions must advance; copying candidate manifests alone is insufficient.
    const nativeAdds = nativeRuntime.nativeCliRunner.mock.calls.slice(callsBeforeSync).flatMap(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      return pluginIndex >= 0 && invocation.args[pluginIndex + 1] === 'add'
        ? [invocation.args[pluginIndex + 2]] : [];
    });
    expect(nativeAdds).toEqual([nativeId('changed-dependency'), nativeId('root')]);
    const observed = JSON.parse((await nativeRuntime.nativeCliRunner({ command: 'codex',
      args: ['plugin', 'list', '--marketplace', codexLayout.marketplaceName!, '--json'], cwd: commandOptions.cwd, env: isolation.env,
    })).stdout) as { installed: Array<{ pluginId: string; version: string }> };
    for (const name of ['root', 'changed-dependency']) {
      expect(observed.installed).toContainEqual(expect.objectContaining({ pluginId: nativeId(name), version: '2.0.0' }));
    }
    expect(await snapshotRegularTree(path.join(marketplaceRoot, 'plugins', 'unrelated'))).toEqual(before);
    await expect(fs.readFile(path.join(marketplaceRoot, 'plugins', 'kept-dependency', 'local.txt'), 'utf8'))
      .resolves.toBe('kept-dependency retained\n');
  });

  it('prepares a Native dependency group once and publishes each reviewed package once', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'native-group-counters');
    await fs.ensureDir(counterRoot);
    const dependencyNames = ['leaf-a', 'leaf-b', 'leaf-c', 'leaf-d', 'leaf-e'];
    const pluginNames = [...dependencyNames, 'root'];
    const definitions = [
      ...dependencyNames.map((name) => ({ name })), { name: 'root', dependencies: dependencyNames },
    ];
    const writeGeneration = async (version: string) => {
      await createNativeDependencyCatalog(sourceRoot, definitions.map((definition) => ({ ...definition,
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.version = version;
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
          manifest.artifacts = { scopes: ['user'], configKeys: [] };
        },
      })));
    };
    await writeGeneration('1.0.0');
    for (const name of pluginNames) await writeDynamicSkillRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', name), skillKey: 'dynamic-skill', counterRoot });
    await writeGeneration('1.0.0');
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const initial = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime);
    expect(initial.overallState, JSON.stringify(initial)).toBe('succeeded');
    const marketplaceRoot = codexLayout.marketplaceRoot!;
    for (const name of pluginNames) await expect(fs.readJson(path.join(marketplaceRoot, 'plugins', name, '.agent-workflows-owner.json')))
      .resolves.toMatchObject({ pluginId: `team/${name}`, sourceIdentity, nativeProjection: { preparation: 'complete' } });
    const foreign = path.join(marketplaceRoot, 'foreign.txt');
    await fs.outputFile(foreign, 'foreign marketplace bytes\n');
    await writeGeneration('2.0.0');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    for (const name of pluginNames) await fs.writeFile(path.join(counterRoot, `render-count-${name}.txt`), '0');
    const callStart = runtime.nativeCliRunner.mock.calls.length;
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd: isolation.layout.fixtureCwd,
      env: isolation.env, nativeCliRunner: runtime.nativeCliRunner, interactive: false }));
    const plan = await dependencies.prepareScopedTask({ kind: 'recovery', command: 'sync', selectors: ['team/root'], scope: 'project' }, new AbortController().signal);
    expect(plan.kind).toBe('recovery');
    if (plan.kind !== 'recovery') throw new Error('Expected recovery plan.');
    const children = plan.plan.joint?.children ?? [plan.plan];
    const reviewed = new Map(children.flatMap((child) => child.nativeGroups.flatMap((group) => group.preview.operationPlan?.deploymentPlans ?? []))
      .flatMap((deployment) => deployment.effects.map((effect) => [effect.id, effect] as const)));
    expect([...reviewed.values()].filter((effect) => effect.kind === 'publish-package')).toHaveLength(pluginNames.length);
    const result = await dependencies.executeScopedTask(plan);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'recovery', receipt: { kind: 'aw-recovery', ok: true } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    const confirmed = result.receipt.targetResults.flatMap((target) => target.deploymentReceipts ?? []).flatMap((receipt) => receipt.effects)
      .filter((effect) => effect.status === 'applied' && effect.mutation === 'confirmed' && reviewed.get(effect.id)?.kind === 'publish-package');
    expect(new Set(confirmed.map((effect) => effect.id)).size).toBe(pluginNames.length);
    const calls = runtime.nativeCliRunner.mock.calls.slice(callStart).map(([call]) => call);
    const lists = calls.filter((call) => call.args.includes('list'));
    expect(lists.every((call) => call.args.includes('--json'))).toBe(true);
    // Registration and activation each permit one exact/neutral pair per package, plus preview/lock pairs.
    expect(lists.length).toBeLessThanOrEqual(4 * pluginNames.length + 8);
    expect(calls.filter((call) => call.args[0] === 'plugin' && call.args[1] === 'add').map((call) => call.args[2]).sort())
      .toEqual(pluginNames.map(nativeId).sort());
    expect(runtime.installed).toEqual(new Set(pluginNames.map(nativeId)));
    for (const name of pluginNames) {
      await expect(fs.readFile(path.join(counterRoot, `render-count-${name}.txt`), 'utf8')).resolves.toBe('1');
      await expect(fs.readJson(path.join(marketplaceRoot, 'plugins', name, '.codex-plugin/plugin.json'))).resolves.toMatchObject({ version: '2.0.0' });
      await expect(fs.readFile(path.join(marketplaceRoot, 'plugins', name, 'skills/dynamic-skill/SKILL.md'), 'utf8'))
        .resolves.toContain('name: dynamic-skill');
    }
    await expect(fs.readFile(foreign, 'utf8')).resolves.toBe('foreign marketplace bytes\n');
  }, 30_000);

  it.each(['beforeRename', 'afterQuarantine'] as const)(
    'reports exact owned Native package cleanup failure at %s and supports retry recovery',
    async (failurePoint) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = isolation.layout.fixtureCwd;
      const sourceRoot = path.join(cwd, `native-package-cleanup-${failurePoint}`);
      const definitions = [
        { name: 'demo' }, { name: 'consumer', dependencies: ['demo'] }, { name: 'independent' },
      ].map((definition) => ({ ...definition, configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['opencode'];
      } }));
      await createNativeDependencyCatalog(sourceRoot, definitions);
      for (const name of ['demo', 'consumer', 'independent']) await fs.outputFile(
        path.join(sourceRoot, 'plugins', name, 'skills', `${name}-skill`, 'README.md'), `${name} Native cleanup fixture.\n`);
      await createNativeDependencyCatalog(sourceRoot, definitions);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const initialInstall = await installFixturePlugin(['team/consumer', 'team/independent'], {
        cwd, platform: 'opencode', scope: 'project',
      }, runtime);
      expect(initialInstall.overallState, JSON.stringify(initialInstall.rebuildResults)).toBe('succeeded');
      // A project directory route gives this test an actual exclusive Native package.
      // The installed marker, not a hand-written legacy owner, authorizes cleanup.
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const layout = await getNativeTestLayout({ platform: 'opencode', pluginId: 'team/demo', sourceIdentity,
        cwd, env: isolation.env, scope: 'project' });
      const independent = await getNativeTestLayout({ platform: 'opencode', pluginId: 'team/independent', sourceIdentity,
        cwd, env: isolation.env, scope: 'project' });
      const packageRoot = layout.packageRoot;
      const owner = await readSkillOwnerMarker({ skillRoot: packageRoot, allowedRoot: path.dirname(packageRoot) });
      expect(owner).toMatchObject({ sourceIdentity, physicalKey: layout.binding.physicalKey,
        pluginId: 'team/demo', platform: 'opencode', scope: 'project', nativeProjection: { preparation: 'complete' } });
      const packageBefore = await snapshotRegularTree(packageRoot);
      const intentPath = path.join(cwd, '.agent-workflows', 'plugin-intents.json');
      const intentBefore = await fs.readFile(intentPath);
      const foreignFile = path.join(path.dirname(packageRoot), 'foreign-package', 'keep.txt');
      await fs.outputFile(foreignFile, 'foreign Native package bytes\n');
      let injectedFailures = 0;
      let quarantinedPath: string | undefined;
      const rename = nodeFs.rename.bind(nodeFs);
      const remove = fs.remove.bind(fs);
      const fault = failurePoint === 'beforeRename'
        ? vi.spyOn(nodeFs, 'rename').mockImplementation(async (from, to) => {
            if (String(from) === packageRoot && path.basename(String(to)).startsWith('.agent-workflows-quarantine-')) {
              injectedFailures += 1;
              throw new Error('injected Native cleanup rename failure');
            }
            return rename(from, to);
          })
        : vi.spyOn(fs, 'remove').mockImplementation((async (entry: string) => {
            if (path.dirname(entry) === path.dirname(packageRoot)
              && path.basename(entry).startsWith('.agent-workflows-quarantine-')) {
              // Quarantine keeps the original artifactKey. This read identifies
              // the injected fault only; the real cleanup verifies ownership.
              const candidate = await fs.readJson(path.join(entry, '.agent-workflows-owner.json')) as Record<string, unknown>;
              if (candidate.pluginId === 'team/demo' && candidate.sourceIdentity === sourceIdentity
                && candidate.physicalKey === layout.binding.physicalKey) {
                quarantinedPath = entry;
                injectedFailures += 1;
                throw new Error('injected Native quarantined removal failure');
              }
            }
            return remove(entry);
          }) as typeof fs.remove);
      let failed;
      try {
        failed = await cleanupWriteCommand(['team/demo', 'team/independent'], {
          cwd, platform: 'opencode', scope: 'project',
        }, runtime);
      } finally {
        fault.mockRestore();
      }
      expect(injectedFailures).toBe(1);
      expect(failed.overallState, JSON.stringify(failed.rebuildResults)).toBe('partial');
      const demoFailure = failed.rebuildResults.find((entry) => entry.target.pluginName === 'demo')!;
      expect(demoFailure, JSON.stringify(failed)).toMatchObject({
        status: 'failed', cleanupAttempted: true, residual: [packageRoot],
        failures: expect.arrayContaining([expect.objectContaining({ phase: 'cleanup.owned', label: packageRoot,
          message: failurePoint === 'beforeRename' ? 'injected Native cleanup rename failure' : 'injected Native quarantined removal failure' })]),
        actions: expect.arrayContaining([expect.objectContaining({ name: 'cleanup.owned', status: 'failed' })]),
      });
      expect(failed.targetResults).toContainEqual(expect.objectContaining({
        target: expect.objectContaining({ pluginName: 'independent' }), state: 'completed',
      }));
      await expect(fs.pathExists(independent.packageRoot)).resolves.toBe(false);
      await expect(fs.readFile(foreignFile, 'utf8')).resolves.toBe('foreign Native package bytes\n');
      await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
      if (failurePoint === 'beforeRename') {
        expect(demoFailure.quarantined).toEqual([]);
        await expect(snapshotRegularTree(packageRoot)).resolves.toEqual(packageBefore);
      } else {
        expect(quarantinedPath).toBeDefined();
        expect(demoFailure.quarantined).toEqual([quarantinedPath]);
        await expect(fs.pathExists(packageRoot)).resolves.toBe(false);
        await expect(fs.pathExists(quarantinedPath!)).resolves.toBe(true);
        await expect(snapshotRegularTree(quarantinedPath!)).resolves.toEqual(packageBefore);
        const missingDependency = await readRecoveryStatus({ cwd, env: isolation.env, cliVersion: '1.0.0',
          targets: ['opencode'], nativeCliRunner: runtime.nativeCliRunner });
        const consumer = missingDependency.inventory?.filter((entry) => entry.pluginId === 'team/consumer')
          .flatMap((entry) => entry.targetResults).find((target) => target.agent === 'opencode' && target.scope === 'project');
        expect(consumer, JSON.stringify(missingDependency)).toBeDefined();
        expect(consumer!.content).not.toBe('satisfied');
        await fs.move(quarantinedPath!, packageRoot);
      }
      const recovered = await cleanupWriteCommand(['team/demo', 'team/independent'], {
        cwd, platform: 'opencode', scope: 'project',
      }, runtime);
      expect(recovered.overallState, JSON.stringify(recovered.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(packageRoot)).resolves.toBe(false);
      await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
      const repaired = await syncWriteCommand(['team/consumer', 'team/independent'], {
        cwd, platform: 'opencode', scope: 'project',
      }, runtime);
      expect(repaired.overallState, JSON.stringify(repaired.rebuildResults)).toBe('succeeded');
      await expect(snapshotRegularTree(packageRoot)).resolves.toEqual(packageBefore);
      await expect(fs.readFile(foreignFile, 'utf8')).resolves.toBe('foreign Native package bytes\n');
      await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    },
    30_000,
  );

  it('preflights native render once and excludes a preApply failure from its marketplace group', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-pre-apply-group-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'native-pre-apply-group-counts');
    await fs.ensureDir(counterRoot);
    const configureDynamicNative = (manifest: PluginMeta['manifest']) => {
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        preApply: { path: './scripts/preApply.mjs' },
      };
      manifest.artifacts = { scopes: ['user'], configKeys: [] };
    };
    const definitions = ['alpha', 'beta'].map((name) => ({
      name,
      configureManifest: configureDynamicNative,
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all(definitions.flatMap(({ name }) => [
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', name),
        skillKey: 'dynamic-skill',
        counterRoot,
      }),
      fs.outputFile(path.join(sourceRoot, 'plugins', name, 'scripts', 'preApply.mjs'), [
        'import { readFile, writeFile } from "node:fs/promises";',
        `const renderCount = await readFile(${JSON.stringify(path.join(
          counterRoot,
          `render-count-${name}.txt`,
        ))}, "utf8");`,
        'if (renderCount !== "1") throw new Error("native renderer was not preflighted once");',
        `await writeFile(${JSON.stringify(path.join(counterRoot, `pre-apply-${name}.txt`))}, "1");`,
        ...(name === 'alpha' ? ['throw new Error("alpha preApply failed");'] : []),
      ].join('\n')),
    ]));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const unauthorized = await installFixturePlugin(['team/alpha', 'team/beta'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
    });
    expect(unauthorized.overallState).toBe('failed');
    expect(unauthorized.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'preApplyAuthorizationRequired' }),
    ]));
    expect(runtime.installed).toEqual(new Set());
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin')
      && !invocation.args.includes('list'))).toEqual([]);
    await expect(fs.pathExists(path.join(counterRoot, 'render-count-alpha.txt')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(counterRoot, 'pre-apply-alpha.txt')))
      .resolves.toBe(false);

    const result = await installFixturePlugin(['team/alpha', 'team/beta'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      yes: true,
    }, {
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
    });

    expect(result.overallState, JSON.stringify(result, null, 2)).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        state: 'failed',
        errorCode: 'preApplyFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/beta' }),
        state: 'completed',
      }),
    ]));
    expect(runtime.nativeCliRunner.mock.calls.filter(([call]) => call.args[0] === 'plugin' && call.args[1] === 'add')
      .map(([call]) => call.args[2])).toEqual([nativeId('beta')]);
    expect(runtime.installed).toEqual(new Set([nativeId('beta')]));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/alpha', platforms: ['codex'] }, { pluginId: 'team/beta', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    for (const name of ['alpha', 'beta']) {
      await expect(fs.readFile(path.join(counterRoot, `render-count-${name}.txt`), 'utf8'))
        .resolves.toBe('1');
      await expect(fs.readFile(path.join(counterRoot, `pre-apply-${name}.txt`), 'utf8'))
        .resolves.toBe('1');
    }
    const marketplaceRoot = codexLayout.marketplaceRoot!;
    await expect(fs.pathExists(path.join(
      marketplaceRoot,
      'plugins',
      'alpha',
      'skills',
      'dynamic-skill',
    ))).resolves.toBe(false);
    await expect(fs.readFile(path.join(
      marketplaceRoot,
      'plugins',
      'beta',
      'skills',
      'dynamic-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toContain('name: dynamic-skill');
  }, 30_000);

  it('keeps an immediate preApply failure with large context isolated from another target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'large-pre-apply-input-source');
    const largeConfigFields = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
      `value${index}`,
      { type: 'string' as const, default: 'x'.repeat(4_096), validation: { maxLength: 4_096 } },
    ]));
    const definitions = ['immediate-failure', 'independent'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ coverage: ['main'], name: 'policy', title: 'Policy', content: `${name} policy.` }],
        };
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
        if (name === 'immediate-failure') manifest.config = { schemaVersion: 5, fields: largeConfigFields };
      },
    }));
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const independentMarker = path.join(isolation.env.AW_HOME!, 'independent-pre-apply.txt');
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'immediate-failure', 'scripts', 'preApply.mjs'),
        'process.exit(7);\n',
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'independent', 'scripts', 'preApply.mjs'),
        [
          'let input = "";',
          'for await (const chunk of process.stdin) input += chunk;',
          'const context = JSON.parse(input);',
          `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(independentMarker)}, context.plugin.name));`,
        ].join('\n'),
      ),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin([
      'team/immediate-failure',
      'team/independent',
    ], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      yes: true,
    }, await createCodexNativeTestRuntime(isolation));

    expect(result.overallState, JSON.stringify(result, null, 2)).toBe('partial');
    expect(result.rebuildResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/immediate-failure' }),
        status: 'failed',
        error: expect.objectContaining({
          phase: 'preApply',
          operationDiagnostic: expect.objectContaining({ code: 'preApplyExited', exitCode: 7 }),
        }),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        status: 'succeeded',
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain('preApplyStartFailed');
    await expect(fs.readFile(independentMarker, 'utf8')).resolves.toBe('independent');
  }, 30_000);

  it('stops before preApply and native mutations when native render preflight fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-render-preflight-failure-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'native-render-preflight-failure-counts');
    await fs.ensureDir(counterRoot);
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
          preApply: { path: './scripts/preApply.mjs' },
        };
        manifest.artifacts = { scopes: ['user'], configKeys: [] };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all([
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
        skillKey: 'dynamic-skill',
        counterRoot,
        fail: true,
      }),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
        `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(
          path.join(counterRoot, 'pre-apply.txt'),
        )}, "1"));\n`,
      ),
    ]);
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      yes: true,
    }, {
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/demo' }),
        state: 'failed',
      }),
    ]);
    await expect(fs.readFile(path.join(counterRoot, 'render-count-demo.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.pathExists(path.join(counterRoot, 'pre-apply.txt'))).resolves.toBe(false);
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin')
      && !invocation.args.includes('list'))).toEqual([]);
    expect(runtime.installed).toEqual(new Set());
  }, 30_000);

  it('uses only one neutral Codex list per generation for public user-only writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-observation-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const listCalls = (calls: readonly [NativeCliInvocation, ...unknown[]][]) => calls.filter(
      ([invocation]) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        return args.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`;
      },
    );
    const assertUserOnlyGenerations = (
      calls: readonly [NativeCliInvocation, ...unknown[]][],
      maximumLists: number,
    ) => {
      const lists = listCalls(calls);
      expect(lists.length, JSON.stringify(calls.map(([invocation]) => ({
        args: invocation.args,
        cwd: invocation.cwd,
      })))).toBeLessThanOrEqual(maximumLists);
      expect(lists.every(([invocation]) =>
        path.resolve(invocation.cwd ?? '.') !== path.resolve(isolation.layout.fixtureCwd))).toBe(true);
      let generationLists = 0;
      for (const [invocation] of calls) {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        const generationBoundary = invocation.args.includes('--version')
          || args[1] === 'add' || args[1] === 'remove'
          || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        if (generationBoundary) {
          expect(generationLists).toBeLessThanOrEqual(1);
          generationLists = 0;
        } else if (args.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`) {
          generationLists += 1;
        }
      }
      expect(generationLists).toBeLessThanOrEqual(1);
    };

    const success = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(success.overallState, JSON.stringify(success)).toBe('succeeded');
    assertUserOnlyGenerations(runtime.nativeCliRunner.mock.calls, 2);

    runtime.nativeCliRunner.mockClear();
    const noOp = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(noOp.overallState, JSON.stringify(noOp)).toBe('succeeded');
    assertUserOnlyGenerations(runtime.nativeCliRunner.mock.calls, 2);

    const uncertainRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const result = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' && args[2] === nativeId('demo')
        ? { ...result, exitCode: 1, stderr: 'synthetic uncertain add' }
        : result;
    });
    const uncertain = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner: uncertainRunner });
    expect(uncertain.overallState, JSON.stringify({
      uncertain,
      calls: uncertainRunner.mock.calls.map(([invocation]) => invocation.args),
    })).not.toBe('succeeded');
    assertUserOnlyGenerations(uncertainRunner.mock.calls, 2);
  }, 30_000);

  it('keeps an earlier native success and the shared marketplace after a later group target fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-partial-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf-a' },
      { name: 'leaf-b' },
      { name: 'root', dependencies: ['leaf-a', 'leaf-b'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    let failLeafB = true;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (failLeafB && args[1] === 'add' && args[2] === nativeId('leaf-b')) {
        return { exitCode: 1, stdout: '', stderr: 'leaf-b failed' };
      }
      return runtime.nativeCliRunner(invocation);
    });

    const partial = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(partial.overallState).toBe('partial');
    expect(partial.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf-a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf-b' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        state: 'failed',
        action: 'skipped',
      }),
    ]));
    expect(runtime.installed).toContain(nativeId('leaf-a'));
    const marketplaceRoot = codexLayout.marketplaceRoot!;
    await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
      sourceId: 'team',
      marketplaceName: codexLayout.marketplaceName!,
    });
    await expect(fs.readFile(path.join(
      marketplaceRoot,
      'plugins',
      'leaf-b',
      'skills',
      'leaf-b-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toContain('name: leaf-b-skill');

    failLeafB = false;
    await expect(syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    expect(runtime.installed).toEqual(new Set([nativeId('leaf-a'), nativeId('leaf-b'), nativeId('root')]));
  }, 30_000);

  it('does not start native mutations when grouped marketplace staging fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-stage-failure-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const realWrite = fs.writeFile.bind(fs);
    let rejectedProjections = 0;
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      const target = String(file);
      if (target.includes(`${path.sep}projection${path.sep}`) && target.endsWith(path.join('.codex-plugin', 'plugin.json'))
        && JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).name === 'leaf') {
        rejectedProjections += 1;
        throw new Error('group staging failed');
      }
      return realWrite(file, data, options);
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
      }, runtime);
    } finally {
      write.mockRestore();
    }

    expect(rejectedProjections).toBeGreaterThan(0);
    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
        message: expect.stringContaining('group staging failed'),
      }),
    ]));
    const nativeMutations = runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add'
        || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    });
    expect(nativeMutations).toEqual([]);
    expect(runtime.installed).toEqual(new Set());
  }, 30_000);

  it('keeps an independent project activation while a new sibling package fails staging', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-reuse-failure-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'a' },
      { name: 'b' },
      { name: 'root', dependencies: ['a', 'b'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/a'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const packageRoot = runtime.packageRoots.get(nativeId('a'))!;
    const marketplaceRoot = runtime.marketplaceRoots.get(codexLayout.marketplaceName!)!;
    const packageBefore = await snapshotRegularTree(packageRoot);
    const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const userConfigBefore = await fs.readFile(userConfigPath);
    const foreignPath = path.join(isolation.layout.fixtureCwd, '.codex', 'foreign-policy.md');
    await fs.outputFile(foreignPath, 'Keep foreign project policy.\n');
    const callsBeforeProjectInstall = runtime.nativeCliRunner.mock.calls.length;
    const activationPlans: Array<Pick<FrozenDeploymentPlan, 'binding' | 'effects'> & { dependencies: string[] }> = [];
    const realBuild = PlatformRebuildSession.prototype.buildTarget;
    const buildSpy = vi.spyOn(PlatformRebuildSession.prototype, 'buildTarget').mockImplementation(async function (input) {
      const target = await realBuild.call(this, input);
      if (input.pluginId === 'team/a' && input.scope === 'project') {
        activationPlans.push(...(target.platformDeployment?.plans ?? []).map((plan) => ({
          binding: plan.binding, effects: plan.effects,
          dependencies: [...(input.plugin.manifest.dependencies ?? [])],
        })));
      }
      return target;
    });
    const realWrite = fs.writeFile.bind(fs);
    let rejectedProjections = 0;
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      const target = String(file);
      if (target.includes(`${path.sep}projection${path.sep}`) && target.endsWith(path.join('.codex-plugin', 'plugin.json'))
        && JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)).name === 'b') {
        rejectedProjections += 1;
        throw new Error('reuse group staging failed');
      }
      return realWrite(file, data, options);
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
        dependencyScopeOverrides: [{
          pluginId: 'team/a', platform: 'codex', scope: 'project',
        }],
      }, runtime);
    } finally {
      write.mockRestore();
      buildSpy.mockRestore();
    }

    expect(rejectedProjections).toBeGreaterThan(0);
    expect(runtime.installed.has(nativeId('a'))).toBe(true);
    // A separate activation can proceed without publishing a package or changing the shared source generation.
    expect(activationPlans.length).toBeGreaterThan(0);
    for (const plan of activationPlans) {
      expect(plan.dependencies).toEqual([]);
      expect(plan.binding.plugin.pluginId).toBe('team/a');
      expect(plan.binding.scope).toEqual({ kind: 'project', projectRoot: await fs.realpath(isolation.layout.fixtureCwd) });
      expect(plan.effects).toEqual([expect.objectContaining({
        kind: 'activate', physicalKey: plan.binding.physicalKey,
        destination: path.join(await fs.realpath(isolation.layout.fixtureCwd), '.codex'), destructive: false,
      })]);
    }
    expect(result.overallState, JSON.stringify(result)).toBe('partial');
    expect(result.targetResults, JSON.stringify(result)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b' }),
        state: 'failed',
        message: expect.stringContaining('reuse group staging failed'),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }), state: 'failed',
        errorCode: 'dependencyInstallFailed',
      }),
    ]));
    const failedBResults = result.rebuildResults.filter((entry) => entry.target.pluginId === 'team/b');
    expect(failedBResults.length).toBeGreaterThan(0);
    expect(failedBResults.flatMap((entry) => entry.deploymentReceipts ?? [])
      .flatMap((receipt) => receipt.effects).filter((effect) => effect.status === 'applied' || effect.mutation !== 'none')).toEqual([]);
    expect(runtime.installed.has(nativeId('b'))).toBe(false);
    await expect(snapshotRegularTree(packageRoot)).resolves.toEqual(packageBefore);
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(userConfigPath)).resolves.toEqual(userConfigBefore);
    await expect(fs.readFile(foreignPath, 'utf8')).resolves.toBe('Keep foreign project policy.\n');
    const projectConfig = await readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    );
    expect(projectConfig.snapshot.plugins[nativeId('a')]?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins[nativeId('b')]).toBeUndefined();
    const projectMutations = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeProjectInstall)
      .filter(([invocation]) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        return args[1] === 'add'
          || args[1] === 'remove'
          || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
      });
    expect(projectMutations).toEqual([]);
  }, 30_000);

  it('attributes a shared activation post snapshot failure only to the missing plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-post-attribution-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'a' }, { name: 'b' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (args[1] !== 'list' || !args.includes('--json')) return response;
      const projectConfig = await readCodexConfigFile(
        path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      );
      if (projectConfig.snapshot.plugins[nativeId('b')]?.enabled !== true) return response;
      const payload = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string }> };
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          installed: payload.installed.filter((entry) => entry.pluginId !== nativeId('b')),
        }),
      };
    });

    const callsBeforeProject = runtime.nativeCliRunner.mock.calls.length;
    const preview = await installFixturePlugin(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, nativeCliRunner, previewOperationPlan: true });
    expect(preview.operationPlan?.deploymentPlans?.flatMap((plan) => plan.effects)
      .some((effect) => ['publish-package', 'register', 'refresh'].includes(effect.kind))).toBe(false);
    const result = await installFixturePlugin(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe('partial');
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBeforeProject).filter(([call]) => {
      const args = call.args.slice(call.args.indexOf('plugin'));
      return args[1] === 'add' || args[1] === 'remove';
    })).toEqual([]);
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b' }),
        state: 'failed',
        errorCode: 'nativeMutationPostcheckFailed',
      }),
    ]));
  }, 30_000);

  it('keeps the executed consumer action when its dependency fails the grouped postcheck', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'late-dependency-postcheck-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    let hiddenDependencyReads = 0;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (args[1] !== 'list' || !args.includes('--json') || !runtime.installed.has(nativeId('root'))) {
        return response;
      }
      const payload = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string }> };
      hiddenDependencyReads += 1;
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          installed: payload.installed.filter((entry) => entry.pluginId !== nativeId('leaf')),
        }),
      };
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState, JSON.stringify({ result, hiddenDependencyReads,
      calls: nativeCliRunner.mock.calls.map(([call]) => ({ command: call.command, args: call.args })) })).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'install',
        state: 'failed',
        errorCode: 'dependencyInstallFailed',
        recoveryActions: expect.arrayContaining([
          'run aw plugin sync team/root --target codex --context project',
        ]),
      }),
    ]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', result);
    expect(receipt.overallState).toBe('partial');
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'install',
        state: 'failed',
        errorCode: 'dependencyInstallFailed',
        recoveryActions: expect.arrayContaining([
          'run aw plugin sync team/root --target codex --context project',
        ]),
      }),
    ]));
    for (const target of receipt.targetResults.filter((entry) =>
      entry.target.pluginId === 'team/leaf' || entry.target.pluginId === 'team/root')) {
      expect(target.actions.map((action) => action.name)).not.toContain('postApply');
    }
    const recoveryAction = receipt.targetResults.find((entry) => entry.target.pluginId === 'team/root')!
      .recoveryActions.find((action) => action.startsWith('run aw plugin sync '))!;
    const captured = createCapturedCliIo();
    expect(await runCli([...recoveryAction.slice('run aw '.length).split(' '), '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: captured.io, interactive: false,
      nativeCliRunner: runtime.nativeCliRunner, codexManagerResolver: runtime.codexManagerResolver,
    }), captured.readStdout()).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'success',
      data: { request: { plugins: ['team/root'], context: 'project', targets: ['codex'] } },
    });
  }, 30_000);

  it('preserves project output and one-shot placement when the user scope installs separately', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'protected-project-placement');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ].map((definition) => ({ ...definition, configureManifest: (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = { agents: [{ name: 'role', description: 'Scoped role.', prompt: `${definition.name}.` }] };
    } })));
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const requirements = await readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-root-role.toml');
    const config = await fs.readFile(configPath);
    const user = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(user.overallState, JSON.stringify(user)).toBe('succeeded');
    await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-team-root-role.toml')))
      .resolves.toBe(true);
    expect(await readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(requirements);
    expect(await fs.readFile(configPath)).toEqual(config);
    expect(requirements.dependencyScopeOverrides).toEqual([]);
  });

  it('repairs missing project output through public sync without changing desired roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'public-sync-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = { agents: [{ name: 'role', description: 'Scoped role.', prompt: 'demo.' }] };
    } }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intentBefore = await readFixtureRequirements(intentLocation);
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-demo-role.toml');
    await fs.remove(configPath);

    await expect(syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    await expect(readFixtureRequirements(intentLocation)).resolves.toEqual(intentBefore);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');

    await fs.remove(configPath);
    const publicOutput = createCapturedCliIo();
    await expect(runCli([
      'plugin', 'sync', '--target', 'codex', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: publicOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
    })).resolves.toBe(0);
    expect(JSON.parse(publicOutput.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'success',
    });
    await expect(readFixtureRequirements(intentLocation)).resolves.toEqual(intentBefore);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');
  });

  it('restores a fresh clone from committed project intent through public sync --all', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.rootDir, 'clone-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const nativeSkill = path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-native');
    await Promise.all([
      fs.outputFile(
        path.join(nativeSkill, 'SKILL.md'),
        '---\nname: demo-native\ndescription: Demo native Skill.\n---\n',
      ),
      fs.outputFile(
        path.join(nativeSkill, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);

    const seedRoot = path.join(isolation.layout.fixtureCwd, 'clone-recovery-seed');
    const cloneRoot = path.join(isolation.layout.fixtureCwd, 'clone-recovery-checkout');
    await fs.ensureDir(seedRoot);
    await git(seedRoot, ['init']);
    await git(seedRoot, ['config', 'user.name', 'AW Test']);
    await git(seedRoot, ['config', 'user.email', 'aw-test@example.invalid']);
    const intent = {
      schemaVersion: 1 as const,
      kind: 'aw-plugin-intents' as const,
      roots: [{ pluginId: 'team/demo', platforms: ['codex' as const] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: [nativeId('demo')] },
    };
    await writeIntentFixture({
      scope: 'project', cwd: seedRoot, env: isolation.env,
    }, intent);
    await git(seedRoot, ['add', '.agent-workflows/plugin-intents.json']);
    await git(seedRoot, ['commit', '-m', 'Add shared project intent']);
    await git(isolation.layout.fixtureCwd, ['-c', 'core.autocrlf=false', 'clone', seedRoot, cloneRoot]);
    expect(await git(cloneRoot, ['ls-files'])).toBe('.agent-workflows/plugin-intents.json');

    const cloneEnv = {
      ...isolation.env,
      AW_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-aw-home'),
      CODEX_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-codex-home'),
      CLAUDE_CONFIG_DIR: path.join(isolation.layout.fixtureCwd, 'clone-recovery-claude-home'),
    };
    codexLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/demo',
      cwd: cloneRoot, env: cloneEnv });
    for (const home of [cloneEnv.AW_HOME, cloneEnv.CODEX_HOME, cloneEnv.CLAUDE_CONFIG_DIR]) {
      await expect(fs.pathExists(home)).resolves.toBe(false);
    }
    const sourceConfig = await readCatalogSourcesConfigSnapshot(cloneEnv);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceConfig.digest,
      env: cloneEnv,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: cloneEnv,
    });
    const intentPath = path.join(cloneRoot, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    const runtime = await createCodexNativeTestRuntime({
      env: cloneEnv,
      layout: { fixtureCwd: cloneRoot },
    }, '0.151.0');

    const result = await syncFixturePlugin([], {
      cwd: cloneRoot,
      env: cloneEnv,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
      yes: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(runtime.installed.has(nativeId('demo'))).toBe(true);
    await expect(fs.readFile(path.join(
      cloneEnv.CODEX_HOME,
      'plugins', 'cache', codexLayout.marketplaceName!, 'demo', '1.0.0', 'skills', 'demo-native', 'SKILL.md',
    ), 'utf8')).resolves.toContain('name: demo-native');
    const projectConfigPath = path.join(cloneRoot, '.codex', 'config.toml');
    const projectConfig = await readCodexConfigFile(projectConfigPath);
    expect(projectConfig.snapshot.plugins[nativeId('demo')]?.enabled).toBe(true);
    expect(Object.keys(projectConfig.snapshot.developerInstructions.managedBlocks)).toHaveLength(0);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(path.join(cloneRoot, '.agents', 'skills'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex', 'hooks.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex', 'apps'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex-plugin'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.mcp.json'))).resolves.toBe(false);
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.not.toContain('mcp_servers');
  }, 30_000);

  it('previews an isolated schema 2 self-hosting project Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const fixtureIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const fixtureIntentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(fixtureIntentLocation, {
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'official/aw-plugin-development', platforms: ['codex'] },
        { pluginId: 'official/aw-skill-eval-runner', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    const intentBytes = await fs.readFile(fixtureIntentPath);
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'self-hosting-intent-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'aw-plugin-development' },
      { name: 'aw-skill-eval-runner' },
    ]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'official',
      cliVersion: '1.0.0',
      env: isolation.env,
      impactConfirmed: true,
    });

    const runtime = await createCodexNativeTestRuntime(isolation);
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], context: 'project', nativeCliRunner: runtime.nativeCliRunner });
    expect(status.inventory).toContainEqual(expect.objectContaining({ pluginId: 'official/aw-plugin-development',
      targetResults: expect.arrayContaining([expect.objectContaining({ agent: 'codex', scope: 'project', relation: 'root' })]),
    }));

    const preview = await syncFixturePlugin([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
    }, {
      ...runtime,
      previewOperationPlan: true,
    });

    expect(preview.overallState, JSON.stringify(preview)).toBe('succeeded');
    expect(preview.operationPlan).toBeDefined();
    await expect(fs.readFile(fixtureIntentPath)).resolves.toEqual(intentBytes);
    await expect(fs.pathExists(path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'config.toml',
    ))).resolves.toBe(false);
  });

  it('keeps project native activation when user uninstall disables its overlapping root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-activation-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const projectInstalled = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);
    expect(projectInstalled.overallState, JSON.stringify(projectInstalled.rebuildResults))
      .toBe('succeeded');
    const userInstalled = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(userInstalled.overallState, JSON.stringify(userInstalled.rebuildResults))
      .toBe('succeeded');
    expect((await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ))).snapshot.plugins[nativeId('leaf')]?.enabled, JSON.stringify(userInstalled.targetResults)).toBe(true);

    const stalePostcheckRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args.includes('list') && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [...runtime.installed].map((pluginId) => ({
              pluginId, installed: true, enabled: true, version: '1.0.0',
            })),
            available: [],
          }),
          stderr: '',
        };
      }
      return runtime.nativeCliRunner(invocation);
    });
    const failedUninstall = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner: stalePostcheckRunner });
    expect(failedUninstall.overallState).toBe('failed');
    await applyCodexConfigTransactionFile(
      path.join(isolation.env.CODEX_HOME!, 'config.toml'),
      { upsertPluginActivations: { [nativeId('leaf')]: true } },
    );
    const activationPaths = [path.join(isolation.env.CODEX_HOME!, 'config.toml'),
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')];
    const activationBytes = await Promise.all(activationPaths.map((file) => fs.readFile(file)));
    const callsBeforeSync = runtime.nativeCliRunner.mock.calls.length;
    const uninstalled = await syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime);
    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    expect(await Promise.all(activationPaths.map((file) => fs.readFile(file)))).toEqual(activationBytes);
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBeforeSync).filter(([call]) => {
      const args = call.args.slice(call.args.indexOf('plugin'));
      return args[1] === 'add' || args[1] === 'remove' || args[1] === 'marketplace' && ['add', 'remove'].includes(args[2]!);
    })).toEqual([]);
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(runtime.installed.has(nativeId('leaf'))).toBe(true);

    const removedProject = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(removedProject.overallState, JSON.stringify(removedProject.rebuildResults)).toBe('succeeded');
    expect(removedProject.rebuildResults.map((result) => result.target.pluginName))
      .toEqual(['root']);
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [expect.objectContaining({ pluginId: 'team/root' })] });
    const [userAfter, projectAfter] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userAfter.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(projectAfter.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(runtime.installed.has(nativeId('leaf'))).toBe(true);

    const movedToUser = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(movedToUser.overallState, JSON.stringify(movedToUser.rebuildResults)).toBe('succeeded');
    const beforeProjectRepeat = await Promise.all(activationPaths.map((file) => fs.readFile(file)));
    const beforeProjectRepeatCalls = runtime.nativeCliRunner.mock.calls.length;
    const movedToProject = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(movedToProject.overallState, JSON.stringify(movedToProject.rebuildResults)).toBe('succeeded');
    expect(movedToProject.dependencyPlan?.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/leaf', action: 'install', state: 'present', resolvedScope: 'project',
      }),
    ]);
    await expect(Promise.all(activationPaths.map((file) => fs.readFile(file)))).resolves.toEqual(beforeProjectRepeat);
    expect(runtime.nativeCliRunner.mock.calls.slice(beforeProjectRepeatCalls).filter(([call]) => {
      const args = call.args.slice(call.args.indexOf('plugin'));
      return ['add', 'remove', 'enable', 'disable'].includes(args[1] ?? '');
    })).toEqual([]);
    const [userMovedProject, projectMovedProject] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userMovedProject.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(projectMovedProject.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);

    const movedBackToUser = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(movedBackToUser.overallState, JSON.stringify(movedBackToUser.rebuildResults)).toBe('succeeded');
    expect(movedBackToUser.dependencyPlan?.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user' }),
    ]);
    const [userMovedBack, projectMovedBack] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userMovedBack.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(projectMovedBack.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(runtime.installed.has(nativeId('leaf'))).toBe(true);
  });

  it('blocks install and status when both Codex registration lists are unreadable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unreadable-registration-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0
        ? invocation.args.slice(pluginIndex)
        : invocation.args;
      if (pluginArgs.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`) {
        return { exitCode: 0, stdout: '{invalid', stderr: '' };
      }
      return runtime.nativeCliRunner(invocation);
    });

    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner });

    expect(installed.overallState).toBe('failed');
    expect(installed.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'platformComponentsUnmet' }),
    ]);
    const mutationCalls = nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    });
    expect(mutationCalls).toEqual([]);

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'unreadable-registration-prefix'),
      runtime.codexVersion,
    );
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: binRoot }, nativeCliRunner, cliVersion: '1.0.0', targets: ['codex'], context: 'user' });
    const target = observedTarget(status, 'team/demo', 'user');
    expect(target.content).toBe('unknown');
    expect(target.deploymentObservations).toContainEqual(expect.objectContaining({ after: expect.objectContaining({
      registration: 'unknown', consumers: expect.arrayContaining([expect.objectContaining({ activation: 'unknown' })]),
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'nativeObservationFailed' })]),
    }) }));
    expect(status.allSatisfied).not.toBe(true);
  }, 30_000);

  it.each([
    ['reuse', 'ENOENT'],
    ['reuse', 'absent'],
    ['none', 'invalid output'],
  ] as const)(
    'blocks a mixed Codex %s extension write when the late observation has %s',
    async (sharedAction, failure) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `late-${sharedAction}-observation-source`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            instructions: [{ coverage: ['main'],
              name: 'late-gate', title: 'Late gate', content: 'Late observation gate.',
            }],
          };
        },
      }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: sharedAction === 'reuse' ? 'project' : 'user',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const targetConfigPath = sharedAction === 'none'
        ? path.join(isolation.env.CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      if (sharedAction === 'reuse') await fs.remove(targetConfigPath);
      const marketplaceRoot = codexLayout.marketplaceRoot!;
      const installedPluginId = [...runtime.installed][0]!;
      const marketplaceName = installedPluginId.slice(installedPluginId.lastIndexOf('@') + 1);
      const nativePayloadRoot = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo', '1.0.0',
      );
      const [marketplaceBefore, nativePayloadBefore] = await Promise.all([
        snapshotRegularTree(marketplaceRoot),
        snapshotRegularTree(nativePayloadRoot),
      ]);
      const targetConfigBefore = await fs.readFile(targetConfigPath, 'utf8').catch(() => undefined);
      let rejectObservation = false;
      let rejectedLists = 0;
      let callsAtTargetBuild = 0;
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const pluginArgs = pluginIndex >= 0
          ? invocation.args.slice(pluginIndex)
          : invocation.args;
        if (rejectObservation && pluginArgs.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`) {
          rejectedLists += 1;
          if (failure === 'ENOENT') {
            throw Object.assign(new Error('Codex unavailable'), { code: 'ENOENT' });
          }
          if (failure === 'absent') {
            return { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' };
          }
          return { exitCode: 0, stdout: '{invalid', stderr: '' };
        }
        return runtime.nativeCliRunner(invocation);
      });
      const observationSession = await createCodexNativeObservationSession({
        exactCwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        runner: nativeCliRunner,
      });
      setRebuildCommandTestHooksForTests({
        afterTargetBuilt: async ({ identity }) => {
          if (identity.pluginId !== 'team/demo') return;
          callsAtTargetBuild = nativeCliRunner.mock.calls.length;
          rejectObservation = true;
          observationSession.invalidate(codexLayout.marketplaceName!);
        },
      });
      let result: Awaited<ReturnType<typeof syncWriteCommand>>;
      try {
        result = sharedAction === 'reuse'
          ? await installFixturePlugin(['team/demo'], {
            cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
            }, { ...runtime, nativeCliRunner, codexObservationSession: observationSession })
          : await uninstallWriteCommand(['team/demo'], {
              cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
            }, { ...runtime, nativeCliRunner, codexObservationSession: observationSession });
      } finally {
        setRebuildCommandTestHooksForTests(undefined);
        await observationSession.dispose();
      }

      expect(rejectedLists).toBeGreaterThan(0);
      expect(result.targetResults, JSON.stringify(result.targetResults)).toContainEqual(expect.objectContaining({
        state: 'failed', errorCode: expect.stringMatching(/^(?:operationPlanStale|platformComponentsUnmet)$/u),
      }));
      expect(await fs.readFile(targetConfigPath, 'utf8').catch(() => undefined))
        .toBe(targetConfigBefore);
      await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
      await expect(snapshotRegularTree(nativePayloadRoot)).resolves.toEqual(nativePayloadBefore);
      expect(runtime.installed).toEqual(new Set([installedPluginId]));
      if (failure === 'absent') {
        await expect(readFixtureRequirements({
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
        });
      }
      const mutationCalls = nativeCliRunner.mock.calls.slice(callsAtTargetBuild)
        .filter(([invocation]) => {
          const pluginIndex = invocation.args.indexOf('plugin');
          const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
          return args[1] === 'add' || args[1] === 'remove'
            || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        });
      expect(mutationCalls).toEqual([]);
    },
    30_000,
  );

  it('reports a late activation observation failure after the mutation and preserves shared native', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-only-late-gate-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/activation-late-pre-apply-count.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const preApplyCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-late-pre-apply-count.txt',
    );
    await expect(fs.readFile(preApplyCounter, 'utf8')).resolves.toBe('1');
    const marketplaceRoot = codexLayout.marketplaceRoot!;
    const installedPluginId = [...runtime.installed][0]!;
    const marketplaceName = installedPluginId.slice(installedPluginId.lastIndexOf('@') + 1);
    const nativePayloadRoot = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo', '1.0.0',
    );
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const [marketplaceBefore, payloadBefore, userConfigBefore, projectConfigBefore] = await Promise.all([
      snapshotRegularTree(marketplaceRoot),
      snapshotRegularTree(nativePayloadRoot),
      fs.readFile(userConfigPath, 'utf8'),
      fs.readFile(projectConfigPath, 'utf8').catch(() => undefined),
    ]);
    let rejectObservation = false;
    const preApplyEvents: string[] = [];
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (rejectObservation && pluginArgs.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`) {
        throw Object.assign(new Error('private native failure'), { code: 'ENOENT' });
      }
      return runtime.nativeCliRunner(invocation);
    });
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.pluginId === 'team/demo' && identity.scope === 'project') {
          rejectObservation = true;
        }
      },
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
      }, {
        ...runtime,
        nativeCliRunner,
        reporter: {
          event: (event) => {
            if (event.type === 'rebuild:action' && event.data?.name === 'preApply') {
              preApplyEvents.push(event.data.phase);
            }
          },
          notice: () => {},
        },
      });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }

    expect(result.targetResults).toContainEqual(expect.objectContaining({
      state: 'failed', errorCode: 'nativeMutationPostcheckFailed',
    }));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    await expect(fs.readFile(userConfigPath, 'utf8')).resolves.toBe(userConfigBefore);
    expect(projectConfigBefore).toBeUndefined();
    await expect(fs.readFile(projectConfigPath, 'utf8'))
      .resolves.toContain('enabled = true');
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(snapshotRegularTree(nativePayloadRoot)).resolves.toEqual(payloadBefore);
    expect(runtime.installed).toEqual(new Set([installedPluginId]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', result);
    expect(receipt).toMatchObject({
      overallState: 'partial',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'nativeMutationPostcheckFailed',
        recoveryActions: expect.arrayContaining(['run aw plugin sync team/demo --target codex --context project']),
      })],
    });
    expect(receipt.targetResults[0]?.actions.map((action) => action.name))
      .toContain('preApply');
    expect(result.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? [])).toContainEqual(
      expect.objectContaining({
        after: expect.objectContaining({ registration: 'unknown', consumers: expect.arrayContaining([
          expect.objectContaining({ activation: 'unknown' }),
        ]) }),
        effects: expect.arrayContaining([expect.objectContaining({ status: 'unknown', mutation: 'confirmed' })]),
      }),
    );
    await expect(fs.readFile(preApplyCounter, 'utf8')).resolves.toBe('2');
    expect(preApplyEvents).toEqual(['start', 'success']);
  }, 30_000);

  it('allows an observed mixed Codex reuse target to write its project extension', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'observed-reuse-extension-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          agents: [{ name: 'late-gate', description: 'Late gate', prompt: 'Observed reuse.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(runtime.installed.has(nativeId('demo'))).toBe(true);
    await expect(fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-demo-late-gate.toml'),
      'utf8',
    )).resolves.toContain('Observed reuse.');
  }, 30_000);

  it.each(['aw-only', 'mixed'] as const)(
    'preserves User output while a Project %s Codex root owns its separate Agent supplement',
    async (kind) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `cross-scope-${kind}-extension-source`);
      const definition = {
        name: 'demo',
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
          manifest.extensions = { agents: [{ name: 'shared-role', description: 'Shared.',
            prompt: 'Keep User role.' }] };
        },
      };
      if (kind === 'mixed') await createNativeDependencyCatalog(sourceRoot, [definition]);
      else await createDependencyCatalogSnapshotFixture(sourceRoot, [definition]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [
          { id: 'team', type: 'path', primary: true, path: sourceRoot },
        ] }, expectedDigest: snapshot.digest, env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const user = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime);
      expect(user.overallState, JSON.stringify(user.targetResults)).toBe('succeeded');
      const userRolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-team-demo-shared-role.toml');
      const userRoleBefore = await fs.readFile(userRolePath);
      const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
      const userConfigBefore = await fs.readFile(userConfigPath).catch(() => undefined);
      const projectRolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents',
        'aw-team-demo-shared-role.toml');
      const projectInstalled = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(projectInstalled.overallState, JSON.stringify(projectInstalled.targetResults)).toBe('succeeded');
      const projectSynced = await syncFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
        platform: 'codex', scope: 'project', interactive: false,
      }, runtime);
      expect(projectSynced.overallState, JSON.stringify(projectSynced.targetResults)).toBe('succeeded');
      await expect(fs.readFile(userRolePath)).resolves.toEqual(userRoleBefore);
      await expect(fs.readFile(userConfigPath).catch(() => undefined))
        .resolves.toEqual(userConfigBefore);
      await expect(fs.readFile(projectRolePath, 'utf8')).resolves.toContain('Keep User role.');
      const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
      const projectIntentBefore = await fs.readFile(projectIntentPath);
      const foreignBytes = 'developer_instructions = "foreign project role"\n';
      await fs.writeFile(projectRolePath, foreignBytes);
      const collided = await syncFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
        platform: 'codex', scope: 'project', interactive: false,
      }, runtime);
      expect(collided.overallState, JSON.stringify(collided)).toBe('failed');
      expect(collided.targetResults).toContainEqual(expect.objectContaining({ state: 'failed', errorCode: 'artifactCollision' }));
      await expect(fs.readFile(projectRolePath, 'utf8')).resolves.toBe(foreignBytes);
      await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
      await expect(fs.readFile(userRolePath)).resolves.toEqual(userRoleBefore);
      await expect(fs.readFile(userConfigPath).catch(() => undefined)).resolves.toEqual(userConfigBefore);
    },
  );

  it.each([
    ['absent', 'partial', 'nativeMutationPostcheckFailed'],
    ['duplicate', 'partial', 'nativeMutationPostcheckFailed'],
    ['installed-disabled', 'partial', 'deploymentPostcheckFailed'],
    ['exact-installed-neutral-absent', 'partial', 'nativeMutationPostcheckFailed'],
  ] as const)('handles Codex install when the official postcheck is %s', async (
    postcheck,
    expectedState,
    error,
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-postcheck-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    let addObserved = false;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      const result = await runtime.nativeCliRunner(invocation);
      if (pluginArgs[1] === 'add') addObserved = true;
      if (addObserved && pluginArgs.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`) {
        const entry = {
          pluginId: nativeId('demo'), installed: true, enabled: true, version: '1.0.0',
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: postcheck === 'exact-installed-neutral-absent'
              ? invocation.cwd === isolation.layout.fixtureCwd ? [entry] : []
              : postcheck === 'duplicate' ? [entry, entry]
                : postcheck === 'installed-disabled' ? [{ ...entry, enabled: false }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return result;
    });

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe(expectedState);
    if (error) {
      expect(result.targetResults).toEqual([
        expect.objectContaining({
          state: 'failed',
          message: expect.stringContaining(error),
        }),
      ]);
    }
    if (postcheck === 'installed-disabled') {
      expect(result.rebuildResults.flatMap((entry) => entry.actions))
        .not.toContainEqual(expect.objectContaining({ name: 'preApply' }));
      expect(result.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? [])).toContainEqual(
        expect.objectContaining({ after: expect.objectContaining({ registration: 'present', consumers: expect.arrayContaining([
          expect.objectContaining({ activation: 'disabled' }),
        ]) }) }),
      );
    }
    expect(addObserved).toBe(true);
    expect(runtime.installed.has(nativeId('demo'))).toBe(true);
    expect(result.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? [])
      .flatMap((receipt) => receipt.effects).some((effect) => effect.mutation === 'confirmed')).toBe(true);
  }, 30_000);

  it.each([
    ['unobserved', 'partial', 'reinstall'],
    ['failed', 'error', 'install'],
  ] as const)(
    'keeps a %s Codex dependency observation distinct in planner readiness',
    async (observation, state, action) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `dependency-${observation}-source`);
      await createNativeDependencyCatalog(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const pluginArgs = pluginIndex >= 0
          ? invocation.args.slice(pluginIndex)
          : invocation.args;
        if (pluginArgs.join(' ') === `plugin list --marketplace ${codexLayout.marketplaceName} --json`) {
          if (observation === 'unobserved') {
            throw Object.assign(new Error('Codex unavailable'), { code: 'ENOENT' });
          }
          return { exitCode: 1, stdout: '', stderr: 'list failed' };
        }
        return runtime.nativeCliRunner(invocation);
      });

      const result = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { ...runtime, nativeCliRunner, previewOperationPlan: true });
      const dependency = result.dependencyPlan?.targets.find((target) =>
        target.pluginId === 'team/leaf');

      if (observation === 'failed') {
        expect(result).toMatchObject({
          overallState: 'failed',
          targetResults: expect.arrayContaining([expect.objectContaining({
            state: 'failed',
            errorCode: 'nativeObservationUnknown',
          })]),
        });
        expect(dependency).toMatchObject({ relation: 'dependency', state, action });
        expect(result.operationPlan?.deploymentPlans?.flatMap((plan) => plan.effects)).toEqual([]);
      } else {
        expect(dependency).toMatchObject({ relation: 'dependency', state, action });
      }
      for (const [invocation] of nativeCliRunner.mock.calls) {
        if (invocation.args.includes('--version')) continue;
        const pluginIndex = invocation.args.indexOf('plugin');
        expect(pluginIndex).toBeGreaterThanOrEqual(0);
        expect(invocation.args.slice(pluginIndex)).toEqual([
          'plugin', 'list', '--marketplace', codexLayout.marketplaceName, '--json',
        ]);
      }
    },
  );

  it('ignores private Codex payload drift during status and sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    nativeQualification.restore();
    installNativeTestQualification({ trust: true });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-payload-drift-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const payloadReadme = path.join(
      isolation.env.CODEX_HOME!,
      'plugins', 'cache', codexLayout.marketplaceName!, 'demo', '1.0.0', 'README.md',
    );
    const reviewed = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, { ...runtime, previewOperationPlan: true });
    const nativeCallsBeforeStaleCheck = runtime.nativeCliRunner.mock.calls.length;
    const stale = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
      reviewPreflight: async () => fs.outputFile(payloadReadme, 'tampered payload\n'),
    });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ state: 'completed' }),
    ]);
    const staleInspectionCalls = runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeStaleCheck);
    expect(staleInspectionCalls).not.toEqual([]);
    expect(staleInspectionCalls.some(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === `plugin list --marketplace ${codexLayout.marketplaceName} --json`)).toBe(true);
    expect(staleInspectionCalls.some(([invocation]) => {
      const args = invocation.args.slice(invocation.args.indexOf('plugin'));
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toBe(false);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    const callsBeforeStatus = runtime.nativeCliRunner.mock.calls.length;
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' }, nativeCliRunner: runtime.nativeCliRunner,
      cliVersion: '1.0.0', targets: ['codex'], context: 'user' });
    expect(observedTarget(status, 'team/demo', 'user').content).toBe('unknown');
    expect(status.allSatisfied).not.toBe(true);
    expect(runtime.nativeCliRunner).toHaveBeenCalledTimes(callsBeforeStatus);

    const blockedOutput = createCapturedCliIo();
    const nativeCallsBeforeBlocked = runtime.nativeCliRunner.mock.calls.length;
    expect(await runCli([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: blockedOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    })).toBe(0);
    expect(JSON.parse(blockedOutput.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'success',
      data: { request: { context: 'user' }, targetResults: [expect.objectContaining({
        pluginId: 'team/demo', target: 'codex', scope: 'user',
      })] },
      nextActions: [],
    });
    expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeBlocked)
      .some(([invocation]) => invocation.args.includes('remove'))).toBe(false);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    const repairedOutput = createCapturedCliIo();
    const nativeCallsBeforeRepair = runtime.nativeCliRunner.mock.calls.length;
    const repairedExit = await runCli([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: repairedOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    });
    expect(repairedExit, repairedOutput.readStdout()).toBe(0);
    expect(JSON.parse(repairedOutput.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'success',
      data: { request: { context: 'user' }, targetResults: [expect.objectContaining({
        pluginId: 'team/demo', target: 'codex', scope: 'user',
      })] },
      nextActions: [],
    });
    const repairNativeActions = runtime.nativeCliRunner.mock.calls
      .slice(nativeCallsBeforeRepair)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(repairNativeActions).not.toContain(`plugin remove ${nativeId('demo')}`);
    expect(repairNativeActions).not.toContain(`plugin add ${nativeId('demo')}`);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    await fs.remove(payloadReadme);
    const deletedStatus = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' }, nativeCliRunner: runtime.nativeCliRunner,
      cliVersion: '1.0.0', targets: ['codex'], context: 'user' });
    expect(observedTarget(deletedStatus, 'team/demo', 'user').content).toBe('unknown');
    const deletedRepairPlan = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, { ...runtime, previewOperationPlan: true });
    expect(deletedRepairPlan.operationPlan?.deploymentPlans).toEqual(expect.arrayContaining([
      expect.objectContaining({ effects: [] }),
    ]));
    expect(deletedRepairPlan.operationPlan?.deploymentPlans?.flatMap((plan) => plan.effects)).toEqual([]);
    await expect(fs.pathExists(payloadReadme)).resolves.toBe(false);

    const externalPayload = path.join(isolation.layout.fixtureCwd, 'foreign-payload.txt');
    const payloadLink = path.join(
      isolation.env.CODEX_HOME!,
      'plugins', 'cache', codexLayout.marketplaceName!, 'demo', '1.0.0', 'foreign-link',
    );
    await fs.outputFile(externalPayload, 'foreign\n');
    await fs.symlink(externalPayload, payloadLink);
    const foreignStatus = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' }, nativeCliRunner: runtime.nativeCliRunner,
      cliVersion: '1.0.0', targets: ['codex'], context: 'user' });
    expect(observedTarget(foreignStatus, 'team/demo', 'user').content).toBe('unknown');
    expect(foreignStatus.allSatisfied).not.toBe(true);
    const foreignOutput = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: foreignOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    })).toBe(0);
    expect(JSON.parse(foreignOutput.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'success',
      data: { request: { context: 'user' }, targetResults: [expect.objectContaining({
        pluginId: 'team/demo', target: 'codex', scope: 'user',
      })] },
    });
    await expect(fs.readFile(externalPayload, 'utf8')).resolves.toBe('foreign\n');
    await expect(fs.lstat(payloadLink)).resolves.toMatchObject({});
  });

  it('updates a markerless static native plugin after another plugin rebuilds the marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'static-upgrade-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'alpha' }, { name: 'beta' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    for (const name of ['alpha', 'beta']) {
      const installed = await installFixturePlugin([`team/${name}`], options, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    }
    const skillRoot = path.join(codexLayout.marketplaceRoot!, 'plugins', 'alpha', 'skills', 'alpha-skill');
    await expect(fs.pathExists(path.join(skillRoot, '.agent-workflows-owner.json'))).resolves.toBe(false);
    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nlocal edit in rebuildable native copy\n');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'alpha', configureManifest: (manifest) => { manifest.version = '2.0.0'; } },
      { name: 'beta' },
    ]);
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const preview = await syncWriteCommand(['team/alpha'], options, { ...runtime, previewOperationPlan: true });
    expect(preview.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/alpha', action: expect.not.stringMatching('block'),
    }));
    const result = await syncWriteCommand(['team/alpha'], { ...options, yes: true }, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const expectedSkill = await fs.readFile(path.join(sourceRoot, 'plugins', 'alpha', 'skills',
      'alpha-skill', 'SKILL.md'), 'utf8');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe(expectedSkill);
    await expect(fs.readFile(path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache',
      codexLayout.marketplaceName!, 'alpha', '2.0.0', 'skills', 'alpha-skill', 'SKILL.md'), 'utf8')).resolves.toBe(expectedSkill);
    expect(runtime.installed.has(nativeId('beta'))).toBe(true);
  });

  it('installs over cache-only Codex residue with add and no remove or cache deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-install-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cacheRoot = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', codexLayout.marketplaceName!, 'demo', '1.0.0',
    );
    const runtime = await createCodexNativeTestRuntime(isolation);
    const first = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(first.overallState, JSON.stringify(first.rebuildResults)).toBe('succeeded');
    runtime.installed.clear();
    const sentinel = path.join(cacheRoot, 'metadata.json');
    await fs.outputFile(sentinel, '{"cacheOnly":true}\n');
    const callsBeforeCacheOnlyInstall = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const calls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeCacheOnlyInstall)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(calls).toContain(`plugin add ${nativeId('demo')}`);
    expect(calls).not.toContain(`plugin remove ${nativeId('demo')}`);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{"cacheOnly":true}\n');
  });

  it('adds a cache-only user dependency for a project consumer without removing its cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    runtime.installed.delete(nativeId('leaf'));
    const sentinel = path.join(
      isolation.env.CODEX_HOME!,
      'plugins', 'cache', codexLayout.marketplaceName!, 'leaf', '1.0.0', 'metadata.json',
    );
    await fs.outputFile(sentinel, '{"cacheOnly":true}\n');
    const callsBeforeInstall = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf',
        resolvedScope: 'project',
        assignmentSource: 'default',
        state: 'absent',
        action: 'install',
      }),
    ]));
    const calls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeInstall)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(calls).toContain(`plugin add ${nativeId('leaf')}`);
    expect(calls).not.toContain(`plugin remove ${nativeId('leaf')}`);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{"cacheOnly":true}\n');
  });

  it('projects automatic user dependency providers per platform in joint status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    await writeIntentFixture({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, { roots: [{ pluginId: 'team/middle', platforms: ['claude', 'codex'] }] });
    await writeIntentFixture({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, { roots: [{ pluginId: 'team/root', platforms: ['claude', 'codex'] }] });
    const runtime = await createClaudeNativeTestRuntime(isolation);
    const status = await readRecoveryStatus({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0',
      nativeCliRunner: runtime.nativeCliRunner,
    });
    expect(status.inventory?.map((entry) => entry.pluginId).sort()).toEqual(['team/middle', 'team/root']);
    for (const agent of ['codex', 'claude'] as const) {
      for (const [pluginId, scope] of [
        ['team/root', 'project'],
        ['team/middle', 'user'],
        ['team/leaf', 'user'],
      ] as const) {
        const target = status.observedTargets?.find((entry) => entry.pluginId === pluginId
          && entry.agent === agent && entry.scope === scope);
        expect(target, JSON.stringify(status)).toBeDefined();
        expect(target).toMatchObject({ pluginId, agent, scope, execution: 'not-run' });
      }
      expect(status.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults)
        .toContainEqual(expect.objectContaining({ agent, scope: 'project', providerScope: 'project' }));
    }
  });

  it('keeps a project-only pure-native dependency in project scope after install', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-native-dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'install',
    }));

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'project-native-dependency-prefix'),
      runtime.codexVersion,
    );
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: binRoot }, nativeCliRunner: runtime.nativeCliRunner,
      cliVersion: '1.0.0', targets: ['codex'], context: 'project' });
    expect(observedTarget(status, 'team/root', 'project').content).toBe('satisfied');
    expect(observedTarget(status, 'team/leaf', 'project').content).toBe('satisfied');
    expect(status.inventory).toContainEqual(expect.objectContaining({ pluginId: 'team/root',
      targetResults: expect.arrayContaining([expect.objectContaining({ agent: 'codex', scope: 'project', providerScope: 'project' })]),
    }));
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins[nativeId('leaf')]?.enabled).not.toBe(true);

    const synced = await syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'keep',
    }));
  }, 30_000);

  it('preserves user actual when a project dependency is reassigned to project scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-user-to-project-source');
    await createNativeDependencyCatalog(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{
              name: 'preserved-role',
              description: 'Preserved role.',
              prompt: 'Keep this role in both scopes until explicit cleanup.',
            }],
          };
        },
      },
      { name: 'bridge', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['bridge'] },
      { name: 'other', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'user',
      }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['team/other'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'user',
      }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userAgentPath = path.join(
      isolation.env.CODEX_HOME!,
      'agents',
      'aw-team-leaf-preserved-role.toml',
    );
    const userAgentBeforeReassignment = await fs.readFile(userAgentPath, 'utf8');
    expect(parseOwnedTextHeader(userAgentBeforeReassignment)?.identity).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'user',
    });
    const callsBeforeReassignment = runtime.nativeCliRunner.mock.calls.length;

    const reassigned = await installFixturePlugin(['team/root', 'team/other'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);

    expect(reassigned.overallState, JSON.stringify(reassigned.rebuildResults)).toBe('succeeded');
    expect(reassigned.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'reinstall',
    }));
    expect(reassigned.rebuildResults).not.toContainEqual(expect.objectContaining({
      command: 'cleanup',
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
    }));
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins[nativeId('leaf')]?.enabled).toBe(true);
    const nativeCalls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeReassignment)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(nativeCalls).not.toContain(`plugin remove ${nativeId('leaf')}`);
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-team-leaf-preserved-role.toml',
    );
    await expect(fs.readFile(userAgentPath, 'utf8')).resolves.toBe(userAgentBeforeReassignment);
    expect(parseOwnedTextHeader(await fs.readFile(userAgentPath, 'utf8'))?.identity)
      .toMatchObject({ pluginId: 'team/leaf', platform: 'codex', scope: 'user' });
    const projectAgent = await fs.readFile(projectAgentPath, 'utf8');
    expect(projectAgent).toContain('Keep this role in both scopes until explicit cleanup.');
    expect(parseOwnedTextHeader(projectAgent)?.identity).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'project',
    });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [
        { pluginId: 'team/other', platforms: ['codex'] },
        { pluginId: 'team/root', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });

    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const status = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      const root = status.observedTargets?.find((entry) => entry.pluginId === 'team/root'
        && entry.scope === 'project' && entry.agent === 'codex');
      expect(root?.content).toBe('satisfied');
      expect(observedTarget(status, 'team/bridge', 'project').content).toBe('satisfied');
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }

    const projectAgentBeforeUserCleanup = await fs.readFile(projectAgentPath, 'utf8');
    const projectConfigBeforeUserCleanup = await fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8',
    );
    const removedLeaf = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(removedLeaf.overallState, JSON.stringify(removedLeaf.targetResults)).toBe('succeeded');
    await expect(fs.pathExists(userAgentPath)).resolves.toBe(false);
    await expect(fs.readFile(projectAgentPath, 'utf8')).resolves.toBe(projectAgentBeforeUserCleanup);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toBe(projectConfigBeforeUserCleanup);
    expect(runtime.installed.has(nativeId('leaf'))).toBe(true);
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [
        { pluginId: 'team/other', platforms: ['codex'] },
        { pluginId: 'team/root', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const finalStatus = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      for (const pluginId of ['team/root', 'team/other']) {
        const target = finalStatus.observedTargets?.find((entry) => entry.pluginId === pluginId
          && entry.scope === 'project' && entry.agent === 'codex');
        expect(target?.content).toBe('satisfied');
      }
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }
  }, 60_000);

  it('adds a second pure-native Codex scope without removing the first scope intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'pure-native-second-scope-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const secondScope = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(secondScope.overallState, JSON.stringify(secondScope.rebuildResults)).toBe('succeeded');
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins[nativeId('demo')]?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins[nativeId('demo')]?.enabled).toBe(true);
    expect(secondScope.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? [])).toContainEqual(expect.objectContaining({
      after: expect.objectContaining({ package: 'present', registration: 'present',
        nativeIdentity: expect.objectContaining({ registrationId: nativeId('demo') }),
        consumers: expect.arrayContaining([expect.objectContaining({ activation: 'enabled' })]),
      }),
    }));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', secondScope);
    expect(receipt.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({
        pluginId: 'team/demo', platform: 'codex', scope: 'project',
      }),
      state: 'completed',
    }));
    for (const scope of ['user', 'project'] as const) {
      await expect(readFixtureRequirements({
        scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({
        roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      });
    }
    const nativeCalls = runtime.nativeCliRunner.mock.calls.map(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(nativeCalls.filter((call) => call === `plugin add ${nativeId('demo')}`)).toHaveLength(1);
    expect(nativeCalls).not.toContain(`plugin remove ${nativeId('demo')}`);
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'pure-native-second-scope-prefix'), '0.200.0',
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      for (const scope of ['user', 'project'] as const) {
        const status = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
          scope, cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, PATH: binRoot },
          cliVersion: '1.0.0', targets: ['codex'],
        });
        const target = status.observedTargets?.find((entry) => entry.pluginId === 'team/demo'
          && entry.scope === scope && entry.agent === 'codex');
        expect(target?.content).toBe('satisfied');
      }
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }
  });

  it('keeps pure-native intent visible when status only observes cache residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    nativeQualification.restore();
    installNativeTestQualification({ trust: true });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dual-native-status-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writeIntentFixture({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      schemaVersion: 1,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: [nativeId('demo')] },
    });
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { upsertPluginActivations: { [nativeId('demo')]: true } },
    );

    const callsBeforeStatus = runtime.nativeCliRunner.mock.calls.length;
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, PATH: '' },
      nativeCliRunner: runtime.nativeCliRunner, cliVersion: '1.0.0', targets: ['codex'], context: 'project' });
    const declared = status.inventory?.filter((entry) => entry.pluginId === 'team/demo').flatMap((entry) => entry.targetResults) ?? [];
    expect(new Set(declared.map((entry) => entry.scope))).toEqual(new Set(['project', 'user']));
    for (const target of declared) {
      expect(target.content).toBe('unknown');
      expect(target.blockers.length).toBeGreaterThan(0);
    }
    expect(status.allSatisfied).not.toBe(true);
    expect(runtime.nativeCliRunner.mock.calls).toHaveLength(callsBeforeStatus);
    for (const root of [isolation.env.CODEX_HOME!, path.join(isolation.layout.fixtureCwd, '.codex')]) {
      expect((await readCodexConfigFile(path.join(root, 'config.toml'))).snapshot.plugins[nativeId('demo')]?.enabled).toBe(true);
    }
  });

  it('requires a local CLI before refreshing a project activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-cli-gate-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      removePluginActivations: [nativeId('demo')],
    });
    const originalRunner = installedRuntime.nativeCliRunner.getMockImplementation()!;
    const observationRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (!invocation.args.includes('list')) {
        throw new Error('An unavailable CLI must not perform native mutations');
      }
      return originalRunner(invocation);
    });
    nativeQualification.restore();
    installNativeTestQualification({ trust: true });
    const synced = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, {
      env: { ...isolation.env, PATH: '' },
      nativeCliRunner: observationRunner,
    });

    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('failed');
    expect(synced.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'platformUnavailable', message: expect.stringContaining('client-missing') }),
    ]);
    await expect(readCodexConfigFile(projectConfigPath)).resolves.toMatchObject({
      snapshot: { plugins: {} },
    });
    expect(installedRuntime.installed.has(nativeId('demo'))).toBe(true);
    expect(observationRunner.mock.calls.every(([invocation]) => invocation.args.includes('list'))).toBe(true);
  }, 30_000);

  it.each(['absent', 'failed'] as const)(
    'rejects a reviewed App CLI activation before writing when its list becomes %s', async (selectedObservation) => {
      // A changed native observation cannot expand reviewed activation into an unapproved install.
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-selected-cli-source');
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: sourceRoot },
      ] }, expectedDigest: snapshot.digest, env: isolation.env });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const appCommand = path.join(isolation.layout.fixtureCwd, 'Codex.app', 'Contents/Resources/codex');
      const adapterFor = vi.mocked(platformRegistry.getAgentPluginAdapter).getMockImplementation()!;
      const adapter = adapterFor('codex');
      vi.mocked(platformRegistry.getAgentPluginAdapter).mockImplementation((platform) => platform !== 'codex' ? adapterFor(platform) : {
        ...adapter, discover: async () => ({ platform: 'codex', availability: 'available', diagnostics: [], installations: [{
          id: 'controlled:codex-app', product: 'app', version: '0.200.0', availability: 'available', reasonCodes: [],
          entry: { kind: 'cli', executable: appCommand, configRoot: isolation.env.CODEX_HOME! },
        }] }),
      });
      let rejectList = false;
      let rejectedLists = 0;
      const nativeCliRunner = vi.fn(async (call: NativeCliInvocation) => {
        if (rejectList && call.command === appCommand && call.args.includes('list')) {
          rejectedLists += 1;
          return selectedObservation === 'absent'
            ? { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'selected CLI cannot list plugins' };
        }
        return runtime.nativeCliRunner(call);
      });
      const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project' } as const;
      await expect(installFixturePlugin(['team/demo'], options, { ...runtime, nativeCliRunner }))
        .resolves.toMatchObject({ overallState: 'succeeded' });
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(projectConfigPath, { removePluginActivations: [nativeId('demo')] });
      const configBefore = await fs.readFile(projectConfigPath);
      const preview = await syncFixturePlugin(['team/demo'], options, { ...runtime, nativeCliRunner, previewOperationPlan: true });
      const plans = preview.operationPlan?.deploymentPlans ?? [];
      expect(plans).toContainEqual(expect.objectContaining({ binding: expect.objectContaining({
        consumers: expect.arrayContaining([expect.objectContaining({ product: 'app', entry: expect.objectContaining({ executable: appCommand }) })]),
      }), effects: expect.arrayContaining([expect.objectContaining({ kind: 'activate' })]) }));
      expect(plans.flatMap((plan) => plan.effects).some((effect) => ['publish-package', 'register', 'refresh'].includes(effect.kind))).toBe(false);
      nativeCliRunner.mockClear();
      rejectList = true;
      const result = await syncFixturePlugin(['team/demo'], options, { ...runtime, nativeCliRunner,
        expectedPlanFingerprint: preview.operationPlan!.planFingerprint });
      expect(rejectedLists).toBeGreaterThan(0);
      expect(result.overallState, JSON.stringify(result)).toBe('failed');
      await expect(fs.readFile(projectConfigPath)).resolves.toEqual(configBefore);
      expect(nativeCliRunner.mock.calls.filter(([call]) => {
        const args = call.args.slice(call.args.indexOf('plugin'));
        return args[1] === 'add' || args[1] === 'remove' || args[1] === 'marketplace' && ['add', 'remove'].includes(args[2]!);
      })).toEqual([]);
      expect(runtime.installed.has(nativeId('demo'))).toBe(true);
    }, 30_000);

  it('keeps activation unconfirmed after repair when the effective host stays disabled', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-pre-apply-failure-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/activation-pre-apply-count.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const counterPath = path.join(isolation.env.AW_HOME!, 'activation-pre-apply-count.txt');
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('1');
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { removePluginActivations: [nativeId('demo')] },
    );
    const contradictoryOfficialList = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
        && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{ pluginId: nativeId('demo'), installed: true, enabled: false, version: '1.0.0' }],
            available: [],
          }),
          stderr: '',
        };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });
    const preApplyEvents: string[] = [];
    const reporter: NonNullable<RebuildCommandRuntime['reporter']> = {
      event: (event) => {
        if (event.type === 'rebuild:action'
          && event.data?.name === 'preApply') preApplyEvents.push(event.data.phase);
      },
      notice: () => {},
    };
    const synced = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false, yes: true,
    }, { ...installedRuntime, nativeCliRunner: contradictoryOfficialList, reporter });
    expect(synced.overallState, JSON.stringify(synced, null, 2)).toBe('partial');
    expect(synced.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
        state: 'failed', errorCode: 'nativeMutationPostcheckFailed',
      }),
    ]);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('sync', synced);
    expect(receipt).toMatchObject({
      ok: false,
      overallState: 'partial',
      targetResults: [{
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
        state: 'failed', errorCode: 'nativeMutationPostcheckFailed',
        actions: expect.any(Array),
      }],
    });
    expect(synced.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? [])).toContainEqual(
      expect.objectContaining({
        after: expect.objectContaining({ registration: 'present', consumers: expect.arrayContaining([
          expect.objectContaining({ activation: 'unknown' }),
        ]) }),
        effects: expect.arrayContaining([expect.objectContaining({ status: 'unknown', mutation: 'confirmed' })]),
      }),
    );
    expect(receipt.targetResults[0]?.actions.map((action) => action.name))
      .toContain('preApply');
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('2');
    expect(preApplyEvents).toEqual(['start', 'success']);
  }, 30_000);

  it('isolates an unconfirmed host activation while the other plugin completes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-isolation-source');
    const definitions = ['alpha', 'beta'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all(definitions.map(({ name }) => fs.outputFile(
      path.join(sourceRoot, 'plugins', name, 'scripts', 'preApply.mjs'),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        `const counter = \`${'${process.env.AW_HOME}'}/activation-isolation-${name}.txt\`;`,
        'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
        'await writeFile(counter, String(previous + 1));',
      ].join('\n'),
    )));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    const selectors = ['team/alpha', 'team/beta'];
    await expect(installFixturePlugin(selectors, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const alphaCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-isolation-alpha.txt',
    );
    const betaCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-isolation-beta.txt',
    );
    await expect(fs.readFile(alphaCounter, 'utf8')).resolves.toBe('1');
    await expect(fs.readFile(betaCounter, 'utf8')).resolves.toBe('1');
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { removePluginActivations: [nativeId('alpha')] },
    );
    const contradictoryOfficialList = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
        && invocation.args.includes('--json')) {
        const exactProject = invocation.cwd === isolation.layout.fixtureCwd;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: nativeId('alpha'), installed: true,
                enabled: false, version: '1.0.0',
              },
              {
                pluginId: nativeId('beta'), installed: true,
                enabled: exactProject, version: '1.0.0',
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });

    const synced = await syncFixturePlugin(selectors, {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false, yes: true,
    }, { ...installedRuntime, nativeCliRunner: contradictoryOfficialList });

    expect(synced.overallState, JSON.stringify(synced, null, 2)).toBe('partial');
    expect(synced.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        state: 'failed', errorCode: 'nativeMutationPostcheckFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/beta' }),
        state: 'completed',
      }),
    ]));
    expect(synced.rebuildResults.find((entry) => entry.target.pluginId === 'team/alpha')
      ?.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
    expect(synced.rebuildResults.find((entry) => entry.target.pluginId === 'team/beta')
      ?.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
    await expect(fs.readFile(alphaCounter, 'utf8')).resolves.toBe('2');
    await expect(fs.readFile(betaCounter, 'utf8')).resolves.toBe('2');
  }, 30_000);

  it('completes Codex activation and preApply when an unrelated Claude target fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-platform-pre-apply-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex', 'claude'];
        manifest.skills = './skills';
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill.\n---\n',
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
      fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
        'import { writeFile } from "node:fs/promises";',
        'let input = "";',
        'for await (const chunk of process.stdin) input += chunk;',
        'const context = JSON.parse(input);',
        'await writeFile(`${process.env.AW_HOME}/pre-apply-${context.target.platform}.txt`, "1");',
      ].join('\n')),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codexRuntime = await createCodexNativeTestRuntime(isolation);
    const preApplyPath = path.join(isolation.env.AW_HOME!, 'pre-apply-codex.txt');
    const preApplyEvents: Array<{ phase: string; outputExists: boolean }> = [];
    const reporter: NonNullable<RebuildCommandRuntime['reporter']> = {
      event: async (event) => {
        if (event.type !== 'rebuild:action'
          || event.source.platform !== 'codex'
          || event.data?.name !== 'preApply') return;
        preApplyEvents.push({
          phase: event.data.phase,
          outputExists: await fs.pathExists(preApplyPath),
        });
      },
      notice: () => {},
    };
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) =>
      invocation.command === 'claude' && invocation.args.includes('--version')
        ? { exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }
        : codexRuntime.nativeCliRunner(invocation));
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.platform === 'claude') throw new Error('injected Claude target failure');
      },
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'both', scope: 'project',
      }, { ...codexRuntime, nativeCliRunner, reporter, preApplyConfirmed: true });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }

    expect(result.overallState, JSON.stringify(result)).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ platform: 'codex' }), state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ platform: 'claude' }), state: 'failed',
      }),
    ]));
    const codexResult = result.rebuildResults.find((entry) => entry.target.platform === 'codex');
    expect(codexResult?.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
    await expect(readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    )).resolves.toMatchObject({ snapshot: { plugins: { [nativeId('demo')]: { enabled: true } } } });
    await expect(fs.readFile(preApplyPath, 'utf8')).resolves.toBe('1');
    expect(preApplyEvents).toEqual([
      { phase: 'start', outputExists: false },
      { phase: 'success', outputExists: true },
    ]);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'pre-apply-claude.txt'),
    )).resolves.toBe(false);
    await expect(readFixtureRequirements({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: expect.arrayContaining(['claude', 'codex']) }],
    });
  }, 30_000);

  it('reports observed registration through one read-only system Codex discovery per scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    nativeQualification.restore();
    installNativeTestQualification({ trust: true });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-trust-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    const binRoot = isolation.env.PATH!.split(path.delimiter)[0]!;
    const fixedEnv = { ...isolation.env, PATH: binRoot };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...installedRuntime, env: fixedEnv })).resolves.toMatchObject({ overallState: 'succeeded' });
    const statusRunner = vi.fn(installedRuntime.nativeCliRunner);
    const status = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd,
      env: fixedEnv, nativeCliRunner: statusRunner,
      cliVersion: '1.0.0', targets: ['codex'], context: 'project' });
    const projectTarget = observedTarget(status, 'team/demo', 'project');
    expect(projectTarget.content, JSON.stringify(projectTarget)).toBe('satisfied');
    expect(projectTarget.deploymentObservations).toContainEqual(expect.objectContaining({
      products: expect.arrayContaining([expect.objectContaining({ product: 'cli', version: '0.200.0', availability: 'available' })]),
      after: expect.objectContaining({ package: 'present', registration: 'present',
        nativeIdentity: expect.objectContaining({ registrationId: nativeId('demo') }),
        consumers: expect.arrayContaining([expect.objectContaining({ activation: 'enabled' })]),
      }),
    }));
    const versionCalls = statusRunner.mock.calls.filter(([invocation]) =>
      invocation.args.at(-1) === '--version');
    const invocationSummary = versionCalls.map(([{ command, args, cwd }]) => ({ command, args, cwd }));
    expect(versionCalls, JSON.stringify(invocationSummary)).toHaveLength(2);
    const versionInvocation = versionCalls[0]![0];
    const selectedPrefix = versionInvocation.args.slice(0, -1);
    const expectedLauncher = await fs.realpath(process.platform === 'win32'
      ? path.join(binRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : path.join(path.dirname(binRoot), 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    expect(versionInvocation.command).toBe(process.execPath);
    expect(selectedPrefix).toEqual([expectedLauncher]);
    const projectCwd = await fs.realpath(isolation.layout.fixtureCwd);
    const projectVersionCalls = versionCalls.filter(([invocation]) => invocation.cwd === projectCwd);
    const userVersionCalls = versionCalls.filter(([invocation]) => invocation.cwd !== projectCwd);
    expect(projectVersionCalls, JSON.stringify(invocationSummary)).toHaveLength(1);
    expect(userVersionCalls, JSON.stringify(invocationSummary)).toHaveLength(1);
    expect(path.basename(userVersionCalls[0]![0].cwd)).toMatch(/^aw-user-neutral-/u);
    expect(versionCalls.every(([invocation]) => invocation.command === versionInvocation.command
      && invocation.args.join(' ') === versionInvocation.args.join(' '))).toBe(true);
    const listCalls = statusRunner.mock.calls.filter(([invocation]) =>
      invocation.args.at(-1) !== '--version');
    const listSummary = listCalls.map(([{ command, args, cwd }]) => ({ command, args, cwd }));
    expect(listCalls, JSON.stringify(listSummary)).toHaveLength(2);
    expect(listCalls.filter(([invocation]) => invocation.cwd === projectCwd)).toHaveLength(1);
    const neutralListCalls = listCalls.filter(([invocation]) => invocation.cwd !== projectCwd);
    expect(neutralListCalls, JSON.stringify(listSummary)).toHaveLength(1);
    expect(path.basename(neutralListCalls[0]![0].cwd)).toMatch(/^aw-user-neutral-/u);
    expect(listCalls.every(([invocation]) =>
      invocation.command === versionInvocation.command
      && invocation.args.join(' ') === [...selectedPrefix,
        'plugin', 'list', '--marketplace', codexLayout.marketplaceName!, '--json'].join(' '))).toBe(true);
  }, 30_000);
});
