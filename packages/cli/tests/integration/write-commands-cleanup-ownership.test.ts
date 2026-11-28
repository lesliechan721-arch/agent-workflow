import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createNativeTestExecution, installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { render } from 'ink-testing-library';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { prepareRetire, runRetire } from '../../src/recovery/retirement.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { createEmptyPreferences, resolvePreferencesPath, writePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import { observePortableSkill, portableOwnedTreeDigest, publishPortableSkill } from '../../src/portable/writer.js';
import { runRebuildCommand } from '../../src/commands/rebuild-command.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import type { PluginMeta } from '../../src/types.js';
import { updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import {
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  SKILL_OWNER_MARKER,
  writeOwnedTextFile,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import {
  syncWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  configureCatalog,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';
import { nativeFixtureLayout, nativeRegistrationId } from '../helpers/write-command-cleanup-fixture.js';

async function writeGenericOwnedSkill(pluginId: string, skill: string, options: {
  scope?: 'user' | 'project'; logicalIdentity?: string; destinationRoot?: string;
} = {}) {
  const { env, layout } = getCurrentSourceTestIsolation();
  const scope = options.scope ?? 'project';
  const sourceDir = path.join(layout.fixtureCwd, 'owned-skill-source', pluginId.replace('/', '-'), skill);
  await fs.outputFile(path.join(sourceDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Owned fixture.\n---\nUse ${skill}.\n`);
  await fs.outputFile(path.join(sourceDir, 'README.md'), `Use ${skill}.\n`);
  const destinationRoot = options.destinationRoot ?? path.join(scope === 'user' ? env.HOME! : layout.fixtureCwd, '.agents', 'skills');
  const identity = { pluginId, skill, platform: 'generic' as const, scope,
    logicalIdentity: options.logicalIdentity ?? `fixture:${pluginId.split('/')[0]}` };
  const observed = await observePortableSkill({ destinationRoot, skill, identity });
  await publishPortableSkill({ sourceDir, destinationRoot, identity, observed,
    expectedDigest: await portableOwnedTreeDigest(sourceDir), configDigest: portableJsonDigest({ fixture: pluginId }) });
  return path.join(destinationRoot, skill);
}


async function writeEmptyAgentProbeRenderer(options: { pluginRoot: string; counterRoot?: string; fail?: boolean }) {
  await fs.outputFile(path.join(options.pluginRoot, 'scripts', 'render.mjs'), [
    'import { readFile, writeFile } from "node:fs/promises";',
    'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'if (context.allowedOutputKinds.includes("agent")) {',
    ...(options.counterRoot ? [
      `const counter = ${JSON.stringify(path.join(options.counterRoot, 'render-count.txt'))};`,
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ] : []),
    ...(options.fail ? ['throw new Error("renderer must not run during bounded recovery");'] : []),
    '}',
    'console.log(JSON.stringify({ version: 3, components: [], omitted: [], unmet: [] }));',
  ].join('\n'));
}

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestDiscovery();
    defaultNativeRuntime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('previews an exact offline cleanup plan and rejects direct execution after plan drift', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    const projectIntent = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(projectIntent, {
      ...await readFixtureRequirements(projectIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const evidence = preview.offlineCleanupPlans?.[0];

    expect(evidence).toMatchObject({
      reason: 'sourceMissing',
      pluginId: 'team/demo',
      plan: {
        schemaVersion: 1,
        pluginId: 'team/demo',
        sourceIdentity,
        platform: 'codex',
        scope: 'project',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'removeOwnedOutput', kind: 'namespacedOwner' }),
        ]),
      },
      planDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
    const liveLayout = await nativeFixtureLayout('demo', 'team', 'project', 'codex', sourceIdentity);
    const rulesRoot = liveLayout.supplementRoot!;
    const physicalKey = liveLayout.renderUnits.find((unit) => unit.output === 'supplement')!.physicalKey;
    const driftPath = path.join(rulesRoot, 'aw-team-demo-direct-drift.toml');
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

    await expect(cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedOfflineCleanupEvidence: evidence }))
      .resolves.toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'operationReviewStale' })],
      });
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it.each(['user', 'project'] as const)(
    'retires confirmed Codex package and selected scope activation for %s scope while retaining foreign registrations',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `offline-native-${scope}-source`);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
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
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
      if (scope === 'user') {
        const projectIntentLocation = {
          scope: 'project' as const,
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
        };
        await writeIntentFixture(projectIntentLocation, {
          ...await readFixtureRequirements(projectIntentLocation),
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
          managed: { codexPluginIds: [await nativeRegistrationId("demo", "team")] },
        });
        await applyCodexConfigTransactionFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
          { upsertPluginActivations: { [await nativeRegistrationId("demo", "team")]: true } },
        );
      }
      const activationConfigPath = scope === 'user'
        ? path.join(isolation.env.CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(activationConfigPath, {
        upsertPluginActivations: { 'foreign@outside': true, 'demo@outside': true },
      });
      const marketplaceRoot = (await nativeFixtureLayout("demo", "team", "project", "codex")).marketplaceRoot!;
      const payloadSkill = path.join(
        marketplaceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md',
      );
      const cacheSkill = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', (await nativeFixtureLayout("demo", "team")).marketplaceName!, 'demo', '1.0.0',
        'skills', 'demo-skill', 'SKILL.md',
      );
      expect(await fs.pathExists(payloadSkill)).toBe(true);
      expect(await fs.pathExists(cacheSkill)).toBe(true);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
      await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const retired = await runRetire({
        scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
        selector: 'team/demo', targets: ['codex'], yes: true,
      }, runtime);

      expect(retired.command).toBe('intent:retire');
      expect(retired.declarationChanged).toBe(true);
      expect(retired.configChanged).toBe(false);
      const activationConfig = await readCodexConfigFile(activationConfigPath);
      const selectedId = await nativeRegistrationId('demo', 'team');
      expect(retired.ok, JSON.stringify(retired)).toBe(true);
      expect(activationConfig.snapshot.plugins[selectedId]).toBeUndefined();
      expect(activationConfig.snapshot.plugins['foreign@outside']?.enabled).toBe(true);
      expect(activationConfig.snapshot.plugins['demo@outside']?.enabled).toBe(true);
      expect(await fs.pathExists(payloadSkill), JSON.stringify(retired)).toBe(false);
      expect(await fs.pathExists(cacheSkill)).toBe(false);
      await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
      expect(runtime.installed.has(await nativeRegistrationId("demo", "team"))).toBe(false);
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: [] });
      if (scope === 'user') {
        await expect(readCodexConfigFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
        )).resolves.toMatchObject({
          snapshot: { plugins: { [await nativeRegistrationId("demo", "team")]: { enabled: true } } },
        });
      }
    },
    30_000,
  );

  // Test Value Gate: preview / offline cleanup / force must all consume the
  // same canonical identity when a healthy Active no longer lists the plugin,
  // without obtaining retirement's shared package deletion authority.
  it.each(['codex', 'claude'] as const)('recognizes the installed %s marketplace in offline preview and both cleanup modes', async (platform) => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout } = isolation;
    const cwd = layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'canonical-offline-cleanup-source');
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => { manifest.platforms = [platform]; },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const initial = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env });
    const codex = platform === 'codex' ? await createCodexNativeTestRuntime(isolation) : undefined;
    const claude = platform === 'claude' ? await createClaudeNativeTestRuntime(isolation) : undefined;
    const runtime = codex ?? claude!.runtime;
    const options = { cwd, platform, scope: 'user' as const };
    await expect(installFixturePlugin(['team/demo'], options, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const deployment = await nativeFixtureLayout('demo', 'team', 'user', platform);
    const { packageRoot } = deployment;
    const manifestPath = path.join(deployment.marketplaceRoot!, ...(platform === 'codex'
      ? ['.agents', 'plugins', 'marketplace.json'] : ['.claude-plugin', 'marketplace.json']));
    const registrationId = deployment.nativeIdentity.registrationId!;
    const packageBefore = await snapshotRegularTree(packageRoot);
    const manifestBefore = await fs.readFile(manifestPath);
    const registrationBefore = claude ? await fs.readFile(claude.installedPath) : undefined;
    const intentBefore = await observeIntent({ cwd, env, scope: 'user' });
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });

    for (const force of [true, false]) {
      const preview = await cleanupWriteCommand(['team/demo'], { ...options, force }, {
        ...runtime, previewOperationPlan: true,
      });
      expect(preview.overallState, JSON.stringify(preview)).toBe('succeeded');
      expect(preview.warnings).not.toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
      expect(await snapshotRegularTree(packageRoot)).toEqual(packageBefore);
      expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
      const result = await cleanupWriteCommand(['team/demo'], { ...options, force }, runtime);
      expect(result.overallState, JSON.stringify(result)).toBe('succeeded');
      expect(result.warnings).not.toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
      expect(result.rebuildResults.flatMap((entry) => entry.residual)).not.toContain('nativeMarketplaceIdentityUnresolved');
      expect(await snapshotRegularTree(packageRoot)).toEqual(packageBefore);
      expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
      if (claude) expect(await fs.readFile(claude.installedPath)).toEqual(registrationBefore);
      if (codex) expect(codex.installed.has(registrationId)).toBe(true);
      expect(await observeIntent({ cwd, env, scope: 'user' })).toEqual(intentBefore);
    }
    if (claude) expect((await fs.readJson(path.join(claude.claudeHome, 'settings.json'))).enabledPlugins?.[registrationId]).toBe(false);
    if (codex) expect((await readCodexConfigFile(path.join(env.CODEX_HOME!, 'config.toml'))).snapshot.plugins[registrationId]?.enabled).not.toBe(true);
    const retired = await runRetire({ cwd, env, scope: 'user', selector: 'team/demo', targets: [platform], yes: true }, runtime);
    expect(retired.ok, JSON.stringify(retired)).toBe(true);
    expect(await fs.pathExists(packageRoot)).toBe(false);
    expect((await fs.readJson(manifestPath)).plugins.some((entry: { name: string }) => entry.name === 'demo')).toBe(false);
  });

  it.each([false, true])(
    'cleans an exact offline Codex extension without changing Intent when native identity is ambiguous (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-source`,
      );
      const remainingRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-remaining`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
          };
        },
      }]);
      await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
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
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const extensionPath = path.join(
        isolation.env.CODEX_HOME!, 'agents', "aw-team-demo-reviewer.toml",
      );
      await expect(fs.pathExists(extensionPath)).resolves.toBe(true);
      const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
      const ambiguousConfig = [
        '[plugins."demo@outside"]',
        'enabled = true',
        '',
        '[plugins."foreign@outside"]',
        'enabled = true',
        '',
      ].join('\n');
      await fs.outputFile(configPath, ambiguousConfig);
      const cacheRoot = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', (await nativeFixtureLayout("demo", "team")).marketplaceName!, 'demo',
      );
      const cacheBefore = await snapshotRegularTree(cacheRoot);
      const intentLocation = {
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      await fs.remove((await nativeFixtureLayout("demo", "team", "project", "codex")).marketplaceRoot!);
      const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
        },
        expectedDigest: configured.digest,
        env: isolation.env,
      });
      runtime.nativeCliRunner.mockClear();

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force,
      }, runtime);
      const receipt = (await import('../../src/output/command-receipt.js'))
        .buildRebuildReceiptJson('cleanup', result);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('nativeMarketplaceIdentityUnresolved'),
      ]));
      expect(receipt.targetResults).toEqual([
        expect.objectContaining({
          state: 'completed',
          residual: expect.arrayContaining(['nativeMarketplaceIdentityUnresolved']),
        }),
      ]);
      await expect(fs.pathExists(extensionPath)).resolves.toBe(false);
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(ambiguousConfig);
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
        roots: [expect.objectContaining({ pluginId: 'team/demo' })],
      });
      await expect(snapshotRegularTree(cacheRoot)).resolves.toEqual(cacheBefore);
      expect(runtime.installed.has(await nativeRegistrationId("demo", "team"))).toBe(true);
      expect(runtime.nativeCliRunner).not.toHaveBeenCalled();
    },
    30_000,
  );

  // A raw unbound activation is a diagnostic clue even without any owned
  // package or supplement. Neither offline mode can use it as deletion authority.
  it.each([{ declared: false, keepMarketplace: true }, { declared: true, keepMarketplace: false }])(
    'reports a lone unbound activation with declared=$declared and empty marketplace=$keepMarketplace', async ({ declared, keepMarketplace }) => {
      const isolation = getCurrentSourceTestIsolation();
      const { env } = isolation;
      const cwd = isolation.layout.fixtureCwd;
      const runtime = await createCodexNativeTestRuntime(isolation);
      const configPath = path.join(env.CODEX_HOME!, 'config.toml');
      const config = '[plugins."demo@outside"]\nenabled = true\n';
      await fs.outputFile(configPath, config);
      if (declared) await writeIntentFixture({ cwd, env, scope: 'user' }, {
        roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      });
      if (keepMarketplace) {
        const sourceIdentity = `sha256:${'a'.repeat(64)}`;
        const layout = await nativeFixtureLayout('demo', 'team', 'user', 'codex', sourceIdentity);
        await fs.outputJson(path.join(layout.marketplaceRoot!, 'config.json'), {
          schemaVersion: 2, sourceId: 'team', sourceIdentity, marketplaceName: layout.marketplaceName,
        });
        await fs.outputJson(path.join(layout.marketplaceRoot!, '.agents/plugins/marketplace.json'), {
          name: layout.marketplaceName, plugins: [],
        });
      }
      const intent = await observeIntent({ cwd, env, scope: 'user' });
      runtime.nativeCliRunner.mockClear();
      for (const force of [false, true]) {
        const options = { cwd, platform: 'codex' as const, scope: 'user' as const, force };
        const preview = await cleanupWriteCommand(['team/demo'], options, { ...runtime, previewOperationPlan: true });
        expect(preview.warnings).toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
        expect(preview.operationPlan?.warnings).toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
        const result = await cleanupWriteCommand(['team/demo'], options, {
          ...runtime, expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
        });
        expect(result.warnings).toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
        expect(result.rebuildResults.flatMap((entry) => entry.residual)).toContain('nativeMarketplaceIdentityUnresolved');
        expect(await fs.readFile(configPath, 'utf8')).toBe(config);
        expect(await observeIntent({ cwd, env, scope: 'user' })).toEqual(intent);
      }
      expect(runtime.nativeCliRunner).not.toHaveBeenCalled();
    },
  );

  // Test Value Gate: a canonical same-name registration belonging to another
  // source must neither invent a cleanup target nor contaminate an owned cleanup.
  it.each([false, true])('cleans only the selected source when another source has the same native plugin name (force=%s)', async (force) => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout } = isolation;
    const cwd = layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'same-name-source-a');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const initial = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'source-a', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd, platform: 'codex' as const, scope: 'user' as const, force };
    await expect(installFixturePlugin(['source-a/demo'], options, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const sourceA = await nativeFixtureLayout('demo', 'source-a', 'user', 'codex');
    const configPath = path.join(env.CODEX_HOME!, 'config.toml');
    const configBefore = await fs.readFile(configPath);
    const packageBefore = await snapshotRegularTree(sourceA.packageRoot);
    const intentBefore = await observeIntent({ cwd, env, scope: 'user' });
    runtime.nativeCliRunner.mockClear();
    for (const previewOperationPlan of [true, false]) {
      const result = await cleanupWriteCommand(['source-b/demo'], options, { ...runtime, previewOperationPlan });
      expect(result).toMatchObject({ overallState: 'succeeded', targetResults: [], rebuildResults: [] });
      expect(result.warnings).not.toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
    }

    const sourceIdentity = `sha256:${'b'.repeat(64)}`;
    const sourceB = await nativeFixtureLayout('demo', 'source-b', 'user', 'codex', sourceIdentity);
    const rolePath = path.join(sourceB.supplementRoot!, 'aw-source-b-demo-role.toml');
    await writeOwnedTextFile({ path: rolePath, allowedRoot: sourceB.supplementRoot!,
      content: 'name = "role"\ndescription = "Owned role"\ndeveloper_instructions = "Review changes."\n',
      identity: { owner: 'agent-workflows', sourceId: 'source-b', sourceIdentity, pluginId: 'source-b/demo', plugin: 'demo',
        platform: 'codex', scope: 'user', artifactKey: path.basename(rolePath),
        physicalKey: sourceB.renderUnits.find((unit) => unit.output === 'supplement')!.physicalKey } });
    const preview = await cleanupWriteCommand(['source-b/demo'], options, { ...runtime, previewOperationPlan: true });
    expect(preview.warnings).not.toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
    expect(await fs.pathExists(rolePath)).toBe(true);
    const cleaned = await cleanupWriteCommand(['source-b/demo'], options, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(cleaned.warnings).not.toContainEqual(expect.stringContaining('nativeMarketplaceIdentityUnresolved'));
    expect(cleaned.rebuildResults.flatMap((entry) => entry.residual)).not.toContain('nativeMarketplaceIdentityUnresolved');
    expect(await fs.pathExists(rolePath)).toBe(false);
    expect(await fs.readFile(configPath)).toEqual(configBefore);
    expect(await snapshotRegularTree(sourceA.packageRoot)).toEqual(packageBefore);
    expect(await observeIntent({ cwd, env, scope: 'user' })).toEqual(intentBefore);
    expect(runtime.installed.has(sourceA.nativeIdentity.registrationId!)).toBe(true);
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) => invocation.args.includes('remove'))).toBe(false);
  });

  it('returns idempotent success for a source-deleted target with no live match', async () => {
      const isolation = await configureCatalog();

      const result = await cleanupWriteCommand(['removed/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { env: isolation.env });

      expect(result).toMatchObject({
        overallState: 'succeeded',
        targetResults: [],
        rebuildResults: [],
      });
  });

  it('returns idempotent force success with no Intent, live match, or local Active bundle', async () => {
    const isolation = await configureCatalog();
    const result = await cleanupWriteCommand(['removed/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      force: true,
    }, { env: isolation.env });

    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [],
      rebuildResults: [],
    });
  });

  it('cleans stale Codex config while preserving cache payload after official absence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-remaining');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
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
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceSkill = path.join((await nativeFixtureLayout("demo", "team", "project", "codex")).packageRoot, 'skills', 'demo-skill', 'SKILL.md');
    const cacheSkill = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', (await nativeFixtureLayout("demo", "team")).marketplaceName!, 'demo', '1.0.0',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const [marketplaceBefore, cacheBefore] = await Promise.all([
      fs.readFile(marketplaceSkill),
      fs.readFile(cacheSkill),
    ]);
    runtime.installed.delete(await nativeRegistrationId("demo", "team"));
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(readCodexConfigFile(path.join(
      isolation.env.CODEX_HOME!, 'config.toml',
    ))).resolves.toMatchObject({ snapshot: { plugins: {} } });
    await expect(fs.readFile(marketplaceSkill)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
  }, 30_000);

  it('preserves unknown historical Project residue without treating it as a current managed installation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-identity-remaining');
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { identity: `sha256:${'1'.repeat(64)}`, root: path.join(skillsRoot, 'identity-one') },
      { identity: `sha256:${'2'.repeat(64)}`, root: path.join(skillsRoot, 'identity-two') },
    ];
    for (const entry of identities) {
      await fs.ensureDir(entry.root);
      await fs.outputJson(path.join(entry.root, SKILL_OWNER_MARKER), { schemaVersion: 3, ...{
          owner: 'agent-workflows', sourceId: 'removed', sourceIdentity: entry.identity,
          pluginId: 'removed/demo', plugin: 'demo', artifactKey: path.basename(entry.root),
          platform: 'codex', scope: 'project',
        } });
    }
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      interactive: false,
    })));
    try {
      await controller.load();
      expect(controller.snapshot.scopedInventories.project?.declaredRoots)
        .not.toContainEqual(expect.objectContaining({ pluginId: 'removed/demo', state: 'ready' }));
      const current = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: defaultNativeRuntime.nativeCliRunner });
      expect(current.ownedTargets).not.toContainEqual(expect.objectContaining({ pluginId: 'removed/demo' }));
      const historicalBytes = await Promise.all(identities.map((entry) => fs.readFile(path.join(entry.root, SKILL_OWNER_MARKER))));
      const plan = await prepareRetire({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        selector: 'removed/demo', targets: ['codex'],
      }, { env: isolation.env, nativeCliRunner: async () => ({
        exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
      }) });
      try {
        expect(plan.receipt.blockers).toContainEqual(expect.objectContaining({
          code: 'removedPluginActiveUnavailable',
        }));
      } finally {
        await plan.context.dispose();
      }
      for (const [index, entry] of identities.entries()) {
        await expect(fs.readFile(path.join(entry.root, SKILL_OWNER_MARKER))).resolves.toEqual(historicalBytes[index]);
      }
    } finally {
      controller.dispose();
    }
  });

  it('cleans a valid live owner when the configured path source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(defaultNativeRuntime.nativeCliRunner);
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
    };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const configBefore = await fs.readFile(configPath);
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    await fs.move(sourceRoot, `${sourceRoot}-unavailable`);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await fs.remove(active.snapshotPath);

    nativeCliRunner.mockClear();
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'blocked' as const, code: 'codexCliNotFound' as const,
      diagnostic: 'Install or repair the local Codex CLI.',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      previewOperationPlan: true,
      codexManagerPreviewer,
      codexManagerResolver,
      removeObsoleteInstallationContracts,
    });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
    expect(nativeCliRunner.mock.calls.every(([invocation]) => {
      const args = invocation.args;
      const pluginIndex = args.indexOf('plugin');
      return args.includes('--version') || pluginIndex >= 0 && args[pluginIndex + 1] === 'list';
    })).toBe(true);
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error(`private cleanup failure at ${isolation.env.AW_HOME}`);
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([
      'obsoleteContractsCleanupFailed: Obsolete installation contracts could not be removed.',
    ]);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    expect(JSON.stringify(result)).not.toContain('private cleanup failure');
    expect(JSON.stringify(result.warnings)).not.toContain(isolation.env.AW_HOME);
  });

  it('preserves project requirements when unrelated shared Codex user config inventory is damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'damaged-user-inventory-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'cleanup-test', title: 'Cleanup test', content: 'owned content', coverage: ['main'] }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    const installed = await installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const projectConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const nativeId = await nativeRegistrationId('demo', 'local');
    expect((await readCodexConfigFile(projectConfig)).snapshot.plugins[nativeId]?.enabled).toBe(true);
    const damagedUserConfig = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    await fs.outputFile(damagedUserConfig, 'invalid = [\n');
    await fs.remove(projectConfig);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/demo' })]) });
    await expect(fs.readFile(damagedUserConfig, 'utf8')).resolves.toBe('invalid = [\n');
    await expect(fs.pathExists(projectConfig)).resolves.toBe(false);
  });

  it.each([false, true])(
    'cleans the old live identity after a real source A to B update with force=%s',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceA = path.join(isolation.layout.fixtureCwd, `identity-a-${force}`);
      const sourceB = path.join(isolation.layout.fixtureCwd, `identity-b-${force}`);
      await Promise.all([
        createDependencyCatalogSnapshotFixture(sourceA, [{ name: 'demo' }]),
        createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'demo' }]),
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
      };
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const installedConfig = await fs.readFile(configPath, 'utf8');
      const nativeId = await nativeRegistrationId('demo');
      expect((await readCodexConfigFile(configPath)).snapshot.plugins[nativeId]?.enabled).toBe(true);
      const instructionFile = path.join((await nativeFixtureLayout('demo')).packageRoot, 'scripts', 'aw-instructions.mjs');
      const instructionBytes = await fs.readFile(instructionFile);
      expect(instructionBytes.toString('utf8')).toContain('demo.');
      await expect(updateCatalogSourceCommand({
        sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ ok: true, changed: true });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force,
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      if (force) await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(installedConfig);
      else expect((await readCodexConfigFile(configPath)).snapshot.plugins[nativeId]?.enabled).not.toBe(true);
      await expect(fs.readFile(instructionFile)).resolves.toEqual(instructionBytes);
      await expect(readFixtureRequirements({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/demo' })]) });
    },
  );

  it('cleans a source-changed dependency without consulting an old live consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceA = path.join(isolation.layout.fixtureCwd, 'dependent-identity-a');
    const sourceB = path.join(isolation.layout.fixtureCwd, 'dependent-identity-b');
    await Promise.all([
      createDependencyCatalogSnapshotFixture(sourceA, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]),
      createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'leaf' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const generationA = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    const oldRoot = await nativeFixtureLayout('root', 'team', 'project', 'codex', generationA.sourceIdentity);
    const oldLeaf = await nativeFixtureLayout('leaf', 'team', 'project', 'codex', generationA.sourceIdentity);
    const rootOwner = await readSkillOwnerMarker({ skillRoot: oldRoot.packageRoot, allowedRoot: path.dirname(oldRoot.packageRoot) });
    const leafOwner = await readSkillOwnerMarker({ skillRoot: oldLeaf.packageRoot, allowedRoot: path.dirname(oldLeaf.packageRoot) });
    expect(rootOwner).toMatchObject({ pluginId: 'team/root', sourceIdentity: generationA.sourceIdentity,
      physicalKey: oldRoot.binding.physicalKey });
    expect(leafOwner).toMatchObject({ pluginId: 'team/leaf', sourceIdentity: generationA.sourceIdentity,
      physicalKey: oldLeaf.binding.physicalKey });
    const rootBefore = await snapshotRegularTree(oldRoot.packageRoot);
    const rootId = oldRoot.nativeIdentity.registrationId!;
    expect(defaultNativeRuntime.installed.has(rootId)).toBe(true);
    await updateCatalogSourceCommand({
      sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    // Cleanup uses the live owner, without loading the old Catalog consumer.
    await fs.outputFile(path.join(sourceA, 'plugins', 'root', '.agents-plugin', 'plugin.json'), '{unavailable old consumer\n');
    const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const projectIntentBefore = await fs.readFile(projectIntentPath);
    const userIntentBefore = await observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const preferencesPath = await resolvePreferencesPath({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const preferencesBefore = await fs.readFile(preferencesPath);
    const leafId = oldLeaf.nativeIdentity.registrationId!;
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    expect((await readCodexConfigFile(projectConfigPath)).snapshot.plugins[rootId]?.enabled).toBe(true);

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result, JSON.stringify(result)).toMatchObject({ overallState: 'succeeded' });
    expect(result.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? []).flatMap((entry) => entry.effects))
      .toEqual([expect.objectContaining({ status: 'applied', mutation: 'confirmed', id: expect.stringContaining(':deactivate:') })]);
    await expect(snapshotRegularTree(oldRoot.packageRoot)).resolves.toEqual(rootBefore);
    expect(defaultNativeRuntime.installed.has(rootId)).toBe(true);
    const projectConfig = (await readCodexConfigFile(projectConfigPath)).snapshot;
    const userConfig = (await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).snapshot;
    expect(projectConfig.plugins[leafId]?.enabled ?? userConfig.plugins[leafId]?.enabled ?? false).toBe(false);
    expect(projectConfig.plugins[rootId]?.enabled).toBe(true);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
    await expect(observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).resolves.toEqual(userIntentBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
  });

  it('cleans only the selected owned generic project Skill', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const first = await writeGenericOwnedSkill('first/demo', 'first-demo');
    const second = await writeGenericOwnedSkill('second/demo', 'second-demo');
    const retained = await fs.readFile(path.join(second, SKILL_OWNER_MARKER));
    const result = await runRecovery('cleanup', ['first/demo'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'project', context: 'project',
      cliVersion: '1.0.0', targets: ['generic'], yes: true,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true,
      declarationChanged: false, preferencesChanged: false,
      targetResults: [expect.objectContaining({ pluginId: 'first/demo', agent: 'generic', scope: 'project', execution: 'applied' })] });
    await expect(fs.pathExists(first)).resolves.toBe(false);
    await expect(fs.pathExists(second)).resolves.toBe(true);
    await expect(fs.readFile(path.join(second, SKILL_OWNER_MARKER))).resolves.toEqual(retained);
  });

  it('removes a shared Codex Skill when current platform config disables its dynamic target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-disabled-skill-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { enabled: { type: 'boolean', default: true } } } } };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: ['enabled'], scopes: ['user'] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const enabled = context.config.values.enabled;',
      'console.log(JSON.stringify({ version: 3, components: enabled && context.allowedOutputKinds.includes("skill") ? [{',
      '  id: "dynamic-skill", kind: "skill", name: "config-skill", content: { files: {',
      '    "SKILL.md": {text: "---\\nname: config-skill\\ndescription: Config Skill.\\n---\\n"},',
      '    "README.md": {text: "Config Skill.\\n"},',
      '    "agents/openai.yaml": {text: "policy:\\n  allow_implicit_invocation: true\\n"}',
      '  } } } ] : [], omitted: !enabled && context.allowedOutputKinds.includes("skill")',
      '    ? [{id:"dynamic-skill",kind:"skill",reason:"config-disabled"}] : [], unmet: [] }));',
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillRoot = path.join((await nativeFixtureLayout("demo", "team", "project", "codex")).packageRoot, 'skills', 'config-skill');
    const projectSkillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'config-skill');
    await expect(fs.pathExists(path.join(skillRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { enabled: false },
    });

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    expect(runtime.installed.has(await nativeRegistrationId("demo", "team"))).toBe(true);
    await expect(readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toMatchObject({ snapshot: { plugins: { [await nativeRegistrationId("demo", "team")]: { enabled: true } } } });
  }, 30_000);

  it.each(['sync', 'uninstall'] as const)('removes a project Codex role removed by the active manifest through %s', async (command) => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v1-source');
    const configureV1 = (manifest: PluginMeta['manifest']) => {
      manifest.version = '1.0.0';
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
    };
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(firstRoot, 'plugins', 'demo'), roleKey: 'removed-in-v2',
    });
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    const firstSource = { id: 'team', type: 'path' as const, primary: true, path: firstRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const initialInstall = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(initialInstall.overallState, JSON.stringify(initialInstall.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-demo-removed-in-v2.toml");
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await createDependencyCatalogSnapshotFixture(firstRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.version = '2.0.0';
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'current', title: 'Current', content: 'Current instruction.', coverage: ['main'] }],
        };
      },
    }]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const foreignSkillRoot = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'foreign-skill',
    );
    await fs.outputFile(path.join(foreignSkillRoot, 'SKILL.md'), 'foreign\n');
    await writeSkillOwnerMarker({
      skillRoot: foreignSkillRoot,
      allowedRoot: path.dirname(foreignSkillRoot),
      identity: {
        owner: 'agent-workflows',
        sourceId: 'other',
        pluginId: 'other/demo',
        plugin: 'demo',
        artifactKey: 'foreign-skill',
        platform: 'codex',
        scope: 'project',
      },
    });
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    const result = await (command === 'sync' ? syncWriteCommand : uninstallWriteCommand)(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults.some((entry) => entry.removed.some((removed) =>
      removed.includes('removed-in-v2')))).toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(foreignSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toBe('foreign\n');
  }, 30_000);

  it('only removes direct generic project Skills with the current source and scope identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'project-stale-safety-source');
    const definitions = [{ name: 'demo', configureManifest: (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['generic'];
    } }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'README.md'), 'Use demo skill.\n');
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: initial.digest, env: isolation.env });
    await writePreferences({ scope: 'user', cwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['generic'],
    });
    const options = { cwd, env: isolation.env, scope: 'project' as const, context: 'project' as const,
      cliVersion: '1.0.0', targets: ['generic'], yes: true };
    const installed = await runRecovery('install', ['team/demo'], options);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const skillsRoot = path.join(cwd, '.agents', 'skills');
    const removable = await writeGenericOwnedSkill('team/demo', 'stale-owned', { logicalIdentity });
    const retained = [
      await writeGenericOwnedSkill('foreign/demo', 'foreign-source', { logicalIdentity }),
      await writeGenericOwnedSkill('team/demo', 'foreign-logical', { logicalIdentity: 'foreign-catalog' }),
      await writeGenericOwnedSkill('team/demo', 'user-scope', { logicalIdentity, scope: 'user', destinationRoot: skillsRoot }),
    ];
    const malformed = path.join(skillsRoot, 'malformed');
    await fs.outputFile(path.join(malformed, SKILL_OWNER_MARKER), '{invalid\n');
    retained.push(malformed);
    const markerTarget = path.join(isolation.layout.rootDir, 'external-owner-marker.json');
    await fs.outputJson(markerTarget, { foreign: true });
    const markerSymlink = path.join(skillsRoot, 'marker-symlink');
    await fs.ensureDir(markerSymlink);
    await fs.symlink(markerTarget, path.join(markerSymlink, SKILL_OWNER_MARKER));
    retained.push(markerSymlink);
    const externalSkill = path.join(isolation.layout.rootDir, 'external-skill-directory');
    await fs.outputFile(path.join(externalSkill, 'SKILL.md'), 'foreign\n');
    const skillSymlink = path.join(skillsRoot, 'skill-symlink');
    await fs.symlink(externalSkill, skillSymlink, process.platform === 'win32' ? 'junction' : 'dir');
    retained.push(skillSymlink);
    const nested = await writeGenericOwnedSkill('team/demo', 'nested-owned', { logicalIdentity,
      destinationRoot: path.join(skillsRoot, 'container') });
    retained.push(nested);
    const result = await runRecovery('sync', ['team/demo'], options);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    await expect(fs.pathExists(removable)).resolves.toBe(false);
    for (const root of retained) await expect(fs.pathExists(root)).resolves.toBe(true);
    await expect(fs.pathExists(markerTarget)).resolves.toBe(true);
    await expect(fs.readFile(path.join(externalSkill, 'SKILL.md'), 'utf8')).resolves.toBe('foreign\n');
  }, 30_000);

  it('cleans an exact target in an internal multi-selector force request without guessing another path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-multi-selector-source');
    const removable = {
      name: 'removable',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { configKeys: [], scopes: ['project'] };
        (manifest.extensions ??= {}).agents = [{ name: 'removable-role', description: 'Removable role.', prompt: 'Remove this role only.' }];
      },
    };
    const sharedOnly = {
      name: 'shared-only',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'shared-only', title: 'Shared only', content: 'Shared only.', coverage: ['main'] }],
        };
      },
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'removable') });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installed = await installFixturePlugin(['local/removable', 'local/shared-only'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, defaultNativeRuntime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-local-removable-removable-role.toml');
    const originalRole = await fs.readFile(rolePath, 'utf8');
    expect(parseOwnedTextHeader(originalRole)?.identity).toMatchObject({
      pluginId: 'local/removable', platform: 'codex', scope: 'project',
    });
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'removable'), fail: true });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const registration = { description: 'Foreign registration', configFile: 'agents/aw-removable-removable-role.toml' };
    await applyCodexConfigTransactionFile(configPath, { upsertAgentRegistrations: { 'removable-role': registration } });
    const sharedLayout = await nativeFixtureLayout('shared-only', 'local');
    const sharedBefore = await snapshotRegularTree(sharedLayout.packageRoot);
    const sharedActivationBefore = (await readCodexConfigFile(configPath)).snapshot.plugins[sharedLayout.nativeIdentity.registrationId!];
    const execution = await createNativeTestExecution({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      selectedTargets: [
        { pluginId: 'local/removable', platform: 'codex' },
        { pluginId: 'local/shared-only', platform: 'codex' },
      ],
    });
    let result: Awaited<ReturnType<typeof runRebuildCommand>>;
    try {
      result = await withAwHomeMutationLock({
        env: isolation.env,
        action: (token) => runRebuildCommand({
          command: 'cleanup',
          pluginNames: ['local/removable', 'local/shared-only'],
          commandOptions: {
            cwd: isolation.layout.fixtureCwd,
            platform: 'codex',
            scope: 'project',
            json: false,
            force: true,
          },
          runtime: { ...defaultNativeRuntime, env: isolation.env, awHomeMutationToken: token,
            executionInput: execution.executionInput },
        }),
      });
    } finally {
      await execution.dispose();
    }
    expect(result, JSON.stringify(result)).toMatchObject({
      overallState: 'partial',
      targetResults: [
        expect.objectContaining({ target: expect.objectContaining({ pluginId: 'local/removable', platform: 'codex', scope: 'project' }),
          state: 'completed' }),
        expect.objectContaining({ target: expect.objectContaining({ pluginId: 'local/shared-only', platform: 'codex', scope: 'project' }),
          state: 'failed', errorCode: 'forceCleanupPathUnavailable' }),
      ],
    });
    await expect(snapshotRegularTree(sharedLayout.packageRoot)).resolves.toEqual(sharedBefore);
    expect((await readCodexConfigFile(configPath)).snapshot.plugins[sharedLayout.nativeIdentity.registrationId!])
      .toEqual(sharedActivationBefore);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(configPath)).snapshot.agents['removable-role']).toMatchObject(registration);

    await applyCodexConfigTransactionFile(configPath, { upsertAgentRegistrations: { 'removable-role': registration } });
    const missingFile = await cleanupWriteCommand(['local/removable'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, defaultNativeRuntime);
    expect(missingFile.overallState, JSON.stringify(missingFile)).toBe('succeeded');
    expect((await readCodexConfigFile(configPath)).snapshot.agents['removable-role'])
      .toMatchObject(registration);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  });

  it('force cleanup removes only the exact Active-planned damaged Codex project role', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-shallow-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'force-shallow-counts');
    await fs.ensureDir(counterRoot);
    const configureForceManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        preApply: { path: './scripts/pre-apply.mjs' },
      };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
      (manifest.extensions ??= {}).agents = [{ name: 'damaged-demo', description: 'Exact recoverable role.', prompt: 'Keep this role bounded.' }];
    };
    const forcePlugin = {
      name: 'demo',
      configureManifest: configureForceManifest,
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'demo'), counterRoot });
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'pre-apply.mjs'),
      "process.exit(0);\n",
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const initiallyInstalled = await installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime);
    expect(initiallyInstalled.overallState, JSON.stringify(initiallyInstalled)).toBe('succeeded');
    const renderCounter = path.join(counterRoot, 'render-count.txt');
    const renderCountBefore = await fs.readFile(renderCounter);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'demo'), fail: true, counterRoot });
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'pre-apply.mjs'),
      "throw new Error('force cleanup must not run preApply');\n");
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-local-demo-damaged-demo.toml");
    const otherSkillsRoot = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills');
    const otherSkillRoot = path.join(otherSkillsRoot, 'damaged-demo');
    const invalidSkillRoot = path.join(skillsRoot, 'invalid-json');
    const linkedSkillRoot = path.join(skillsRoot, 'linked-marker');
    const externalMarker = path.join(isolation.layout.rootDir, 'foreign-owner-marker.json');
    const originalRole = await fs.readFile(rolePath, 'utf8');
    expect(parseOwnedTextHeader(originalRole)?.identity).toMatchObject({ pluginId: 'local/demo', scope: 'project' });
    const damagedOwner = { schemaVersion: 2, owner: 'agent-workflows', sourceId: 'local', sourceIdentity: 'damaged',
      pluginId: 'local/demo', plugin: 'demo', artifactKey: 'damaged-demo', platform: 'codex', scope: 'project' };
    const damagedRole = `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`;
    await fs.outputFile(rolePath, damagedRole);
    const blockedReinstall = await reinstallWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blockedReinstall.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin remove --only outputs local/demo --target codex --scope project --force',
          'then run aw plugin sync local/demo --target codex --context project --rebuild',
        ],
      }),
    ]);
    const blockedReceipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('reinstall', blockedReinstall);
    expect(blockedReceipt.recoveryActions).toEqual([
      'run aw plugin remove --only outputs local/demo --target codex --scope project --force',
      'then run aw plugin sync local/demo --target codex --context project --rebuild',
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    await fs.ensureDir(otherSkillRoot);
    await fs.outputJson(path.join(otherSkillRoot, SKILL_OWNER_MARKER), { schemaVersion: 3, ...{
        owner: 'agent-workflows',
        sourceId: 'local',
        sourceIdentity: 'damaged',
        pluginId: 'local/demo',
        plugin: 'demo',
        artifactKey: 'damaged-demo',
        platform: 'claude',
        scope: 'user',
      } });
    await fs.outputFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), '{invalid\n');
    await fs.outputJson(externalMarker, {
      ...damagedOwner,
      artifactKey: 'linked-marker',
    });
    await fs.ensureDir(linkedSkillRoot);
    await fs.symlink(externalMarker, path.join(linkedSkillRoot, '.agent-workflows-owner.json'));
    const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignRolePath = path.join(isolation.layout.rootDir, 'foreign-role.toml');
    await fs.outputFile(foreignRolePath, 'description = "Foreign role"\n');
    await applyCodexConfigTransactionFile(sharedConfig, {
      upsertPluginActivations: { [await nativeRegistrationId("demo", "local")]: true },
      upsertAgentRegistrations: { 'damaged-demo': {
        description: 'Foreign role', configFile: path.relative(path.dirname(sharedConfig), foreignRolePath),
      } },
    });


    const activeState = await fs.readJson(path.join(isolation.env.AW_HOME!, 'catalog-state.json')) as {
      sources: { local: { active: { logicalIdentity: string; snapshotDigest: string } } };
    };
    const activeStore = resolveCatalogStoreLocation({
      ...activeState.sources.local.active,
      env: isolation.env,
    });
    await fs.outputFile(
      path.join(activeStore.snapshotRoot, 'plugins', 'unrelated', '.agents-plugin', 'plugin.json'),
      '{damaged unrelated bundle\n',
    );
    const intentLocation = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'blocked' as const, code: 'codexCliNotFound' as const,
      diagnostic: 'Install or repair the local Codex CLI.',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    let providerCalls = 0;
    const forceRuntime = {
      env: isolation.env, nativeCliRunner: runtime.nativeCliRunner,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('force cleanup must not invoke the Catalog provider');
          },
        },
      },
    };
    const preview = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, {
      ...forceRuntime,
      previewOperationPlan: true,
      removeObsoleteInstallationContracts,
      codexManagerPreviewer,
      codexManagerResolver,
    });

    expect(preview.overallState).toBe('succeeded');
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(providerCalls).toBe(0);
    await expect(fs.readFile(renderCounter)).resolves.toEqual(renderCountBefore);
    expect(preview.operationPlan?.actions).toEqual([
      expect.objectContaining({
        kind: 'removeOwnedArtifact',
        path: rolePath,
      }),
    ]);
    await expect(fs.readFile(rolePath, 'utf8')).resolves.toBe(damagedRole);
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
      snapshot: { plugins: { [await nativeRegistrationId("demo", "local")]: { enabled: true } } },
    });

    const reviewedEvidence = preview.offlineCleanupPlans?.[0];
    expect(reviewedEvidence).toBeDefined();
    const foreignOwner = {
      schemaVersion: 3,
      owner: 'agent-workflows',
      sourceId: 'foreign',
      pluginId: 'foreign/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    };
    await fs.outputFile(rolePath, `# agent-workflows-owner: ${JSON.stringify(foreignOwner)}\ndescription = "Foreign role"\n`);
    const stale = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { ...forceRuntime, expectedOfflineCleanupEvidence: reviewedEvidence });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationReviewStale' }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await fs.outputFile(rolePath, damagedRole);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, forceRuntime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({ snapshot: {
      plugins: { [await nativeRegistrationId("demo", "local")]: { enabled: true } },
      agents: { 'damaged-demo': { configFile: path.relative(path.dirname(sharedConfig), foreignRolePath) } },
    } });
    await expect(fs.readFile(foreignRolePath, 'utf8')).resolves.toBe('description = "Foreign role"\n');
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    expect(providerCalls).toBe(0);
    await expect(fs.readFile(renderCounter)).resolves.toEqual(renderCountBefore);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/demo' })]) });
  });

  it('recovers a damaged owned-text header through reinstall, force cleanup, and reinstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
    };
    const definition = [{ name: 'demo', configureManifest: configure }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      roleKey: 'project-role',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
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
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-demo-project-role.toml");
    const agentPath = path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-demo-reviewer.toml",
    );
    const originalAgent = await fs.readFile(agentPath, 'utf8');
    await fs.outputFile(
      agentPath,
      `# agent-workflows-owner: {invalid\n${originalAgent.split('\n').slice(1).join('\n')}`,
    );

    const blocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin remove --only outputs team/demo --target codex --scope project --force',
          'then run aw plugin sync team/demo --target codex --context project --rebuild',
        ],
      }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    const intentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const validIntent = await fs.readFile(intentPath);
    const malformedIntent = Buffer.from('{malformed selected project Intent\n');
    await fs.outputFile(intentPath, malformedIntent);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('partial');
    expect(cleaned.rebuildResults).toEqual([expect.objectContaining({
      status: 'failed',
      removed: expect.arrayContaining(["aw-team-demo-project-role.toml", "aw-team-demo-reviewer.toml"]),
      residual: expect.arrayContaining([path.join('[catalog-source]', '.agent-workflows', 'plugin-intents.json')]),
    })]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    await expect(fs.readFile(intentPath)).resolves.toEqual(malformedIntent);

    await fs.outputFile(intentPath, validIntent);
    const recovered = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(recovered.overallState, JSON.stringify(recovered)).toBe('succeeded');
    expect(recovered.rebuildResults).toEqual([
      expect.objectContaining({ status: 'succeeded', residual: [], failures: [] }),
    ]);
    expect(recovered.targetResults).toEqual([
      expect.objectContaining({
        state: 'completed',
        target: expect.objectContaining({ pluginId: 'team/demo' }),
      }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    const restored = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(agentPath, 'utf8'))?.identity).toMatchObject({
      pluginId: 'team/demo', platform: 'codex', scope: 'project',
    });

    const unrelatedUserAgent = path.join(
      isolation.env.CODEX_HOME!, 'agents', "aw-team-demo-reviewer.toml",
    );
    await fs.outputFile(unrelatedUserAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const unrelatedBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.pathExists(unrelatedUserAgent)).resolves.toBe(true);
  }, 30_000);

  it('matches a damaged reinstall owned-text target by its full normalized path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-exact-path-source');
    const definitions = [{ name: 'demo', configureManifest: (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
      (manifest.extensions ??= {}).agents = [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }];
    } }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'demo') });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env });
    const nativeCliRunner = vi.fn(defaultNativeRuntime.nativeCliRunner);
    const runtime = { ...defaultNativeRuntime, nativeCliRunner };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-demo-reviewer.toml');
    const originalRole = await fs.readFile(rolePath);
    await fs.outputFile(rolePath, '# agent-workflows-owner: {invalid\nowned target\n');

    const exactBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(exactBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);

    await fs.outputFile(rolePath, originalRole);
    const sameBasenameAgent = path.join(isolation.env.CODEX_HOME!, 'agents', path.basename(rolePath));
    await fs.outputFile(sameBasenameAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = {
      role: await fs.readFile(rolePath),
      otherRole: await fs.readFile(sameBasenameAgent),
      intent: await fs.readFile(intentPath),
      config: await fs.readFile(configPath),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };
    const wrongPathBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(wrongPathBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(wrongPathBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(rolePath)).resolves.toEqual(before.role);
    await expect(fs.readFile(sameBasenameAgent)).resolves.toEqual(before.otherRole);
    await expect(fs.readFile(intentPath)).resolves.toEqual(before.intent);
    await expect(fs.readFile(configPath)).resolves.toEqual(before.config);
    const readOnlyCalls = nativeCliRunner.mock.calls.slice(before.nativeCalls).map(([invocation]) => invocation);
    expect(readOnlyCalls.every(({ args }) => {
      const pluginIndex = args.indexOf('plugin');
      return pluginIndex >= 0 ? args[pluginIndex + 1] === 'list' : args.at(-1) === '--version';
    }), JSON.stringify(readOnlyCalls)).toBe(true);
  }, 30_000);

  it('invalid shared config does not authorize marker-only Codex project recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'owned-demo');
    await fs.ensureDir(skillRoot);
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: 'damaged',
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'owned-demo',
      platform: 'codex', scope: 'project',
    });
    const sharedPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignShared = 'invalid = [\n# agent-workflows demo without owner token\n';
    await fs.outputFile(sharedPath, foreignShared);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    await expect(fs.readFile(sharedPath, 'utf8')).resolves.toBe(foreignShared);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('matches a damaged project role header through a symlink cwd by its exact canonical path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-exact-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
      (manifest.extensions ??= {}).agents = [{ name: 'shared-name', description: 'Exact leaf role.', prompt: 'Keep this role bounded.' }];
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'leaf') });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const { nativeCliRunner } = runtime;
    const exactInstalled = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(exactInstalled.overallState, JSON.stringify(exactInstalled)).toBe('succeeded');
    const linkedCwd = path.join(isolation.layout.rootDir, 'linked-project-cwd');
    await fs.symlink(
      isolation.layout.fixtureCwd,
      linkedCwd,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', "aw-team-leaf-shared-name.toml");
    const originalRole = await fs.readFile(rolePath, 'utf8');
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    const distractors = [
      {
        root: path.join(isolation.env.CODEX_HOME!, 'skills', 'shared-name'),
        sourceId: 'other', platform: 'codex' as const, scope: 'user' as const,
      },
      {
        root: path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills', 'shared-name'),
        sourceId: 'team', platform: 'claude' as const, scope: 'user' as const,
      },
    ];
    for (const distractor of distractors) {
      await fs.ensureDir(distractor.root);
      await writeSkillOwnerMarker({
        skillRoot: distractor.root,
        allowedRoot: path.dirname(distractor.root),
        identity: {
          owner: 'agent-workflows',
          sourceId: distractor.sourceId,
          pluginId: `${distractor.sourceId}/leaf`,
          plugin: 'leaf',
          artifactKey: 'shared-name',
          platform: distractor.platform,
          scope: distractor.scope,
        },
      });
    }

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/leaf', platform: 'codex', scope: 'project',
        }),
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin remove --only outputs team/leaf --target codex --scope project --force',
          'then run aw plugin sync team/leaf --target codex --context project --rebuild',
        ],
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        errorCode: 'dependencyInstallFailed',
      }),
    ]));
    expect(result.targetResults.filter((target) => target.recoveryActions)).toHaveLength(1);
    for (const distractor of distractors) {
      await expect(fs.pathExists(distractor.root)).resolves.toBe(true);
    }

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.agents['shared-name']).toBeUndefined();
    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const unrelatedMarker = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-other-unrelated-broken.toml');
    await fs.outputFile(unrelatedMarker, '# agent-workflows-owner: {invalid unrelated owner header\n');
    const selectedRolePath = rolePath;
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const actualBefore = {
      selectedRole: await fs.readFile(selectedRolePath),
      unrelatedMarker: await fs.readFile(unrelatedMarker),
      projectIntent: await fs.readFile(projectIntentPath),
      projectConfig: await fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const unrelatedBlocked = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(selectedRolePath)).resolves.toEqual(actualBefore.selectedRole);
    await expect(fs.readFile(unrelatedMarker)).resolves.toEqual(actualBefore.unrelatedMarker);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(actualBefore.projectIntent);
    await expect(fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(actualBefore.projectConfig);
    const readOnlyCalls = nativeCliRunner.mock.calls.slice(actualBefore.nativeCalls).map(([invocation]) => invocation);
    expect(readOnlyCalls.every(({ args }) => {
      const pluginIndex = args.indexOf('plugin');
      return pluginIndex >= 0 ? args[pluginIndex + 1] === 'list' : args.at(-1) === '--version';
    }), JSON.stringify(readOnlyCalls)).toBe(true);
  });

  it('blocks a project override on damaged user dependency ownership and permits exact user recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-user-owner-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'user-owner-render-counts');
    await fs.ensureDir(counterRoot);
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: [], scopes: ['user'] };
      (manifest.extensions ??= {}).agents = [{ name: 'shared-name', description: 'Exact User leaf role.', prompt: 'Keep the User role bounded.' }];
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeEmptyAgentProbeRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), counterRoot });
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
    const runtime = await createCodexNativeTestRuntime(isolation);
    const userInstalled = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(userInstalled.overallState, JSON.stringify(userInstalled)).toBe('succeeded');
    const installed = await runRecovery('install', ['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'project', cliVersion: '1.0.0', yes: true,
    }, runtime);
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', "aw-team-leaf-shared-name.toml");
    const renderCountBefore = await fs.readFile(path.join(counterRoot, 'render-count.txt'));
    const projectRole = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-leaf-shared-name.toml');
    expect(await fs.pathExists(projectRole)).toBe(false);
    const originalRole = await fs.readFile(rolePath, 'utf8');
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    const damagedRole = await fs.readFile(rolePath);
    const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const projectIntent = await fs.readFile(projectIntentPath);
    const foreignSkill = path.join(isolation.env.CODEX_HOME!, 'skills', 'foreign-skill', 'SKILL.md');
    await fs.outputFile(foreignSkill, 'foreign\n');

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/root', platform: 'codex', scope: 'project',
        }),
        errorCode: 'stateInventoryFailed',
        message: expect.stringContaining(
          `ownerHeaderParse@${path.join('[catalog-source]', 'agents', "aw-team-leaf-shared-name.toml")}`,
        ),
      }),
    ]);
    await expect(fs.readFile(rolePath)).resolves.toEqual(damagedRole);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(counterRoot, 'render-count.txt'))).resolves.toEqual(renderCountBefore);
    await expect(fs.pathExists(projectRole)).resolves.toBe(false);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');

    const restored = await reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(projectRole)).resolves.toBe(false);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(rolePath, 'utf8'))?.identity)
      .toMatchObject({ pluginId: 'team/leaf', artifactKey: path.basename(rolePath), platform: 'codex', scope: 'user' });
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
  });

  it('does not touch obsolete contract state during markerless force recovery', async () => {
    const isolation = await configureCatalog();
    const baseRuntime = {
      env: isolation.env,
      nativeCliRunner: defaultNativeRuntime.nativeCliRunner,
    };
    await expect(installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, baseRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const obsolete = path.join(isolation.env.AW_HOME!, 'installation-contracts');
    await fs.outputFile(path.join(obsolete, 'old.json'), '{}');

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, {
      ...baseRuntime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error('injected obsolete cleanup failure');
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([]);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
    await expect(fs.pathExists(obsolete)).resolves.toBe(true);
  });
});
