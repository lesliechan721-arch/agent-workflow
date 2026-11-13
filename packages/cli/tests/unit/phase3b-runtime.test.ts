import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { removeCatalogSourceCommand, updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import {
  runRebuildCommand as runNativeRebuildCommand,
  setRebuildCommandTestHooksForTests,
} from '../../src/commands/rebuild-command.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { cursorWorkspaceOpenCommand } from '../../src/platforms/projection.js';
import { getPhysicalKey } from '../../src/platforms/identity.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import type { DeploymentBinding } from '../../src/platforms/contracts.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { prepareRetire, executeRetire } from '../../src/recovery/retirement.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { geminiExtensionPaths, geminiScopePattern } from '../../src/platforms/gemini-activation.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { applyCodexConfigTransactionFile } from '../../src/utils/codex-config.js';
import { disposePreparedPlatformRebuildSession, inspectNativeMarketplaceRegistrations } from '../../src/commands/rebuild-integration.js';
import {
  cleanupWriteCommand as cleanupNativeWriteCommand,
  installWriteCommand as installNativeWriteCommand,
  reinstallWriteCommand as reinstallNativeWriteCommand,
  uninstallWriteCommand as uninstallNativeWriteCommand,
} from '../../src/commands/write-commands.js';
import { createNativeTestExecution, getNativeTestLayout } from '../helpers/native-execution-fixture.js';
import { readIntentReferences } from '../../src/recovery/demand.js';
import {
  createSkillOwnerMarkerContent,
  createSharedOwnerToken,
  readSkillOwnerMarker,
  renderOwnedTextFile,
  writeSkillOwnerMarker,
  writeOwnedTextFile,
  SKILL_OWNER_MARKER,
  type OwnerIdentity,
} from '../../src/utils/ownership.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import { offlineCleanupEvidenceFromInventory } from '../../src/commands/offline-cleanup-evidence.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  listNamespacedPluginConfigStores,
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import {
  resetPluginConfigWithHelper,
} from '../../src/utils/plugin-config-write.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

const SOURCE_IDENTITY = `sha256:${'1'.repeat(64)}`;

// Synthetic owner fixtures use one stable namespace; real Native layout identity is exercised below.
function ownerPhysicalKey(namespaceRoot: string): string {
  return getPhysicalKey({ sourceIdentity: SOURCE_IDENTITY, pluginId: 'team/demo', platform: 'codex',
    route: 'codex-marketplace', namespaceRoot, resourceKey: 'aw-team-demo:owner-fixture' });
}

async function directoryCatalog(root: string, platform: 'opencode' | 'codex' | 'claude') {
  const pluginRoot = path.join(root, 'plugins/demo');
  const skillRoot = path.join(pluginRoot, 'skills/demo-skill');
  await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '---\nname: demo-skill\ndescription: Fixture.\n---\n');
  await fs.outputFile(path.join(skillRoot, 'README.md'), '# Demo\nUse the fixture.\n');
  await fs.outputFile(path.join(skillRoot, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  const configure = (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
    manifest.platforms = [platform]; manifest.skills = './skills'; manifest.extensions = undefined;
  };
  await createCatalogSnapshotFixture(root, 'demo', [], 'demo\n', configure);
  const plugin = await readPluginManifest(pluginRoot);
  const staged = path.join(root, 'prepared-plugin');
  await bundleLocalPlugin(plugin, staged, { commandEnv: getCurrentSourceTestIsolation().env });
  await fs.remove(pluginRoot);
  await fs.move(staged, pluginRoot);
  const meta = await readPluginManifest(pluginRoot, { mode: 'bundle' });
  const catalogPath = path.join(root, 'catalog-manifest.json');
  const catalog = await fs.readJson(catalogPath);
  await fs.writeJson(catalogPath, { ...catalog, entries: [await createCatalogManifestV7Entry(meta, pluginRoot)] });
}

function qualifiedSession(runtime: RebuildCommandRuntime): PlatformRebuildSession {
  const context = createCommandExecutionContext({ env: runtime.env, nativeCliRunner: runtime.nativeCliRunner });
  // Only qualification facts are synthetic. Layout, preparation, publication and ownership use production code.
  return new PlatformRebuildSession(context, (platform) => {
    const adapter = getAgentPluginAdapter(platform);
    return { ...adapter, capabilities: (input) => {
      const facts = adapter.capabilities(input);
      facts.kinds.skill = { ...facts.kinds.skill, status: 'supported', reasonCodes: [] };
      return facts;
    } };
  });
}

async function nativeFixtureRuntime(): Promise<RebuildCommandRuntime> {
  const isolation = getCurrentSourceTestIsolation();
  const env = { ...isolation.env };
  const bin = path.join(isolation.layout.fixtureCwd, 'phase-native-bin');
  for (const executable of ['codex', 'claude', 'opencode']) await fs.outputFile(path.join(bin, `${executable}${process.platform === 'win32' ? '.exe' : ''}`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  env.PATH = [bin, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const installed = new Map<string, string>();
  const marketplaces = new Map<string, string>();
  const nativeCliRunner = async (invocation: NativeCliInvocation) => {
    const platform = path.basename(invocation.command).replace(/\.(?:exe|cmd)$/iu, '');
    const args = invocation.args;
    const result = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (args.includes('--version')) return result(platform === 'claude' ? '2.1.317 (Claude Code)' : platform === 'opencode' ? 'opencode 2.0.0' : 'codex-cli 0.167.0');
    if (platform === 'opencode') throw new Error('Directory loading must not execute native mutations.');
    const configPath = path.join(env.AW_CODEX_HOME!, 'config.toml');
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      marketplaces.set(marketplaceName, root);
      if (platform === 'codex') await fs.appendFile(configPath,
        `\n[marketplaces.${JSON.stringify(marketplaceName)}]\nsource = ${JSON.stringify(root)}\nsource_type = "local"\n`).catch(async () => {
          await fs.outputFile(configPath, `[marketplaces.${JSON.stringify(marketplaceName)}]\nsource = ${JSON.stringify(root)}\nsource_type = "local"\n`);
        });
      else {
        const known = path.join(env.AW_CLAUDE_HOME!, 'plugins/known_marketplaces.json');
        await fs.outputJson(known, { ...await fs.readJson(known).catch(() => ({})), [marketplaceName]: {
          source: { source: 'directory', path: root }, installLocation: root } });
      }
      return result();
    }
    const id = args[2]!;
    if (platform === 'codex') {
      if (args[1] === 'add') {
        const split = id.lastIndexOf('@'); const root = marketplaces.get(id.slice(split + 1))!;
        const manifest = await fs.readJson(path.join(root, 'plugins', id.slice(0, split), '.codex-plugin/plugin.json'));
        installed.set(id, manifest.version);
        await applyCodexConfigTransactionFile(configPath, { upsertPluginActivations: { [id]: true } });
      }
      if (args[1] === 'remove') { installed.delete(id); await applyCodexConfigTransactionFile(configPath, { removePluginActivations: [id] }); }
      if (args[1] === 'list') {
        const user = await readCodexConfigFile(configPath);
        const project = await readCodexConfigFile(path.join(invocation.cwd, '.codex/config.toml'));
        return result(JSON.stringify({ installed: [...installed].map(([pluginId, version]) => {
          const split = pluginId.lastIndexOf('@'); const name = pluginId.slice(0, split);
          const marketplaceName = pluginId.slice(split + 1); const root = marketplaces.get(marketplaceName)!;
          return { pluginId, name, marketplaceName, version, installed: true,
            source: { source: 'local', path: path.join(root, 'plugins', name) },
            marketplaceSource: { sourceType: 'local', source: root },
            enabled: project.snapshot.plugins[pluginId]?.enabled ?? user.snapshot.plugins[pluginId]?.enabled === true };
        }), available: [] }));
      }
      return result();
    }
    const scope = args[args.indexOf('--scope') + 1] ?? 'user';
    const settingsPath = scope === 'local' ? path.join(invocation.cwd, '.claude/settings.local.json') : path.join(env.AW_CLAUDE_HOME!, 'settings.json');
    const settings = await fs.readJson(settingsPath).catch(() => ({}));
    const installedPath = path.join(env.AW_CLAUDE_HOME!, 'plugins/installed_plugins.json');
    const state = await fs.readJson(installedPath).catch(() => ({ plugins: {} }));
    if (['install', 'update', 'uninstall'].includes(args[1]!)) {
      const split = id.lastIndexOf('@'); const root = marketplaces.get(id.slice(split + 1))!;
      const records = (state.plugins[id] ?? []).filter((record: { scope: string }) => record.scope !== scope);
      if (args[1] !== 'uninstall') {
        const packageRoot = path.join(root, 'plugins', id.slice(0, split));
        const manifest = await fs.readJson(path.join(packageRoot, '.claude-plugin/plugin.json'));
        records.push({ scope, version: manifest.version, installPath: packageRoot,
          ...(scope === 'local' ? { projectPath: invocation.cwd } : {}) });
      }
      const plugins = { ...state.plugins }; if (records.length) plugins[id] = records; else delete plugins[id];
      await fs.outputJson(installedPath, { plugins });
    }
    if (['install', 'enable', 'disable', 'uninstall'].includes(args[1]!)) await fs.outputJson(settingsPath, {
      ...settings, enabledPlugins: { ...settings.enabledPlugins, [id]: !['disable', 'uninstall'].includes(args[1]!) },
    });
    return result();
  };
  return { env, nativeCliRunner };
}

type NativeWriter = typeof installNativeWriteCommand;
async function invokeNativeWriter(
  writer: NativeWriter,
  pluginNames: Parameters<NativeWriter>[0],
  options: Parameters<NativeWriter>[1],
  runtime: Parameters<NativeWriter>[2] = {},
) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = options.cwd ?? isolation.layout.fixtureCwd;
  const scope = options.scope === 'project' ? 'project' : 'user';
  const platforms = options.platform === 'both' ? ['codex', 'claude'] as const : [options.platform ?? 'codex'] as const;
  const env = runtime?.env ?? isolation.env;
  const ids = pluginNames.length ? pluginNames : await readIntentReferences({ scope, cwd, env });
  const native = await createNativeTestExecution({ scope, cwd, env,
    selectedTargets: ids.flatMap((pluginId) => platforms.map((platform) => ({ pluginId, platform }))),
    includeSelectedInDemand: writer === installNativeWriteCommand,
  });
  const qualified = writer !== cleanupNativeWriteCommand && runtime?.nativeCliRunner ? qualifiedSession(runtime) : undefined;
  try {
    return await writer(pluginNames, options, { ...runtime, ...(qualified ? { platformRebuildSession: qualified } : {}), executionInput: native.executionInput });
  } finally {
    await qualified?.dispose();
    await native.dispose();
  }
}

const installWriteCommand = (...args: Parameters<typeof installNativeWriteCommand>) =>
  invokeNativeWriter(installNativeWriteCommand, ...args);
const reinstallWriteCommand = (...args: Parameters<typeof reinstallNativeWriteCommand>) =>
  invokeNativeWriter(reinstallNativeWriteCommand, ...args);
const cleanupWriteCommand = (...args: Parameters<typeof cleanupNativeWriteCommand>) =>
  invokeNativeWriter(cleanupNativeWriteCommand, ...args);
const uninstallWriteCommand = (...args: Parameters<typeof uninstallNativeWriteCommand>) =>
  invokeNativeWriter(uninstallNativeWriteCommand, ...args);

async function runRebuildCommand(...args: Parameters<typeof runNativeRebuildCommand>) {
  const [invocation] = args;
  const isolation = getCurrentSourceTestIsolation();
  const { commandOptions, runtime } = invocation;
  const scope = commandOptions.scope;
  const cwd = commandOptions.cwd;
  const env = runtime?.env ?? isolation.env;
  const ids = invocation.pluginNames.length ? invocation.pluginNames
    : await readIntentReferences({ scope, cwd, env });
  const platforms = commandOptions.platform === 'both' ? ['codex', 'claude'] as const
    : [commandOptions.platform] as const;
  const native = await createNativeTestExecution({ scope, cwd, env,
    selectedTargets: ids.flatMap((pluginId) => platforms.map((platform) => ({ pluginId, platform }))),
  });
  try {
    return await runNativeRebuildCommand({ ...invocation,
      runtime: { ...runtime, executionInput: native.executionInput } });
  } finally {
    await native.dispose();
  }
}

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const replaced = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources.filter((entry) => entry.type === 'path')) {
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: options.env,
    }).catch(() => undefined);
  }
  return replaced;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('phase 3B namespaced runtime stores', () => {
  it('previews and executes offline cleanup without changing declaration or reading Catalog', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex', 'claude'] }],
    });

    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, {
      env: isolation.env,
      previewOperationPlan: true,
      catalogBootstrapError: new Error('cleanup must not read Catalog'),
    });

    expect(preview.offlineCleanupPlans).toEqual([
      expect.objectContaining({
        pluginId: 'team/demo', platform: 'codex', scope: 'user',
        plan: expect.objectContaining({ actions: [] }),
      }),
    ]);
    expect(preview.operationPlan).toMatchObject({
      intentChanges: [],
      evidence: { intentDigests: [expect.objectContaining({ scope: 'user' })] },
    });
    await expect(readIntentFixture(location)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['claude', 'codex'] }],
    });

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, {
      env: isolation.env,
      expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
      catalogBootstrapError: new Error('cleanup must not read Catalog'),
    });

    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [{
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex' }),
        action: 'cleanup',
        state: 'completed',
      }],
    });
    await expect(readIntentFixture(location)).resolves.toMatchObject({
      schemaVersion: 3,
      roots: [{ pluginId: 'team/demo', platforms: ['claude', 'codex'] }],
    });
  });

  it('treats force cleanup without output as a no-op and retains declaration', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const options = {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    };
    const preview = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env, previewOperationPlan: true,
    });
    const result = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env,
      expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
      expectedOfflineCleanupEvidence: preview.offlineCleanupPlans![0],
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(result.offlineCleanupPlans).toEqual([
      expect.objectContaining({ plan: expect.objectContaining({ actions: [] }) }),
    ]);
    await expect(readIntentFixture(location)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
  });

  it('treats unrelated inventory damage as irrelevant to an empty cleanup target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const result = await cleanupWriteCommand(['team/missing'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, {
      env: isolation.env,
      inventoryCatalogSourceReferences: async () => ({
        inventorySchemaVersion: 1,
        references: [],
        errors: [{
          code: 'stateInventoryFailed',
          kind: 'configFileRead',
          location: '[aw-state]/plugin-config/other/bad/config.json',
          message: 'unrelated config is damaged',
          relevance: {
            global: false, sourceId: 'other', pluginName: 'bad', scope: 'user',
          },
        }],
      }),
    });

    expect(result).toMatchObject({ overallState: 'succeeded', warnings: [] });
  });

  it('does not report a sanitized owned-text inventory error after force removes its exact path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const filePath = path.join(isolation.env.AW_CODEX_HOME!, 'agents', 'aw-team-demo-recovered.toml');
    const identity: OwnerIdentity = {
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'aw-team-demo-recovered.toml',
      platform: 'codex', scope: 'user',
    };
    await fs.outputFile(filePath, renderOwnedTextFile('recovered output\n', identity));
    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, {
      env: isolation.env,
      inventoryCatalogSourceReferences: async () => ({
        inventorySchemaVersion: 1,
        references: [{
          kind: 'namespacedOwner', location: filePath, sourceId: 'team',
          sourceIdentity: SOURCE_IDENTITY, pluginName: 'demo', platform: 'codex', scope: 'user',
        }],
        errors: [{
          code: 'stateInventoryFailed',
          kind: 'ownerHeaderParse',
          location: '[catalog-source]/agents/aw-team-demo-recovered.toml',
          message: 'the original owner header was damaged',
          relevance: {
            global: false, sourceId: 'team', pluginName: 'demo', platform: 'codex', scope: 'user',
          },
        }],
      }),
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(result.rebuildResults[0]?.residual).toEqual([]);
    await expect(fs.pathExists(filePath)).resolves.toBe(false);
  });

  it('force cleanup removes safe live output but keeps unknown damaged residue as partial', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const skillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    const safeRoot = path.join(skillsRoot, 'safe-demo');
    const damagedRoot = path.join(skillsRoot, 'damaged-demo');
    await fs.outputJson(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      marketplaceName: 'aw-team',
    });
    const owner: OwnerIdentity = {
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'safe-demo',
      platform: 'codex', scope: 'user',
    };
    await fs.outputFile(path.join(safeRoot, 'SKILL.md'), 'safe output\n');
    await writeSkillOwnerMarker({ skillRoot: safeRoot, allowedRoot: skillsRoot, identity: owner });
    await fs.outputJson(path.join(damagedRoot, '.agent-workflows-owner.json'), {
      ...JSON.parse(createSkillOwnerMarkerContent({ ...owner, artifactKey: 'damaged-demo' })),
      sourceIdentity: SOURCE_IDENTITY, physicalKey: 'damaged-key',
    });

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, {
      env: isolation.env,
      inventoryCatalogSourceReferences: async (options) => {
        const inventory = await inventoryCatalogSourceReferences(options);
        return {
          ...inventory,
          references: inventory.references.map((reference) =>
            reference.location.includes('safe-demo')
              ? { ...reference, sourceIdentity: SOURCE_IDENTITY }
              : reference),
        };
      },
    });

    expect(result.overallState).toBe('partial');
    expect(result.offlineCleanupPlans).toEqual([
      expect.objectContaining({ sourceIdentity: SOURCE_IDENTITY }),
    ]);
    await expect(fs.pathExists(safeRoot)).resolves.toBe(false);
    await expect(fs.pathExists(damagedRoot)).resolves.toBe(true);
    await expect(readIntentFixture(location)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    expect(result.rebuildResults[0]).toMatchObject({
      status: 'failed',
      actions: expect.arrayContaining([expect.objectContaining({ status: 'succeeded' })]),
    });
  });

  it('previews cleanup all from the Intent and live union without Catalog', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writeIntentFixture({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      roots: [
        { pluginId: 'team/alpha', platforms: ['codex'] },
        { pluginId: 'team/beta', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });

    const preview = await runRebuildCommand({
      command: 'cleanup',
      pluginNames: [],
      all: true,
      commandOptions: {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', json: false,
      },
      runtime: {
        env: isolation.env,
        previewOperationPlan: true,
        catalogBootstrapError: new Error('cleanup all must not read Catalog'),
      },
    });

    expect(preview.offlineCleanupPlans?.map((target) => target.pluginId).sort())
      .toEqual(['team/alpha', 'team/beta']);
    expect(preview.offlineCleanupPlans?.every((target) => target.plan.actions.length === 0))
      .toBe(true);
    expect(preview.operationPlan?.intentChanges).toEqual([]);
  });

  it('stops before output cleanup when reviewed Intent evidence drifts', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const skillRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'reviewed-demo');
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), 'kept on stale review\n');
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: path.dirname(skillRoot),
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'reviewed-demo',
        platform: 'codex', scope: 'user',
      },
    });
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    const preview = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env, previewOperationPlan: true,
    });
    await writeIntentFixture(location, {
      roots: [], dependencyScopeOverrides: [],
    });

    const result = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env, expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
    });

    expect(result.overallState).toBe('failed');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('stops before Intent mutation when inventory damage appears after Review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    const preview = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env, previewOperationPlan: true,
    });
    const damagedRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'damaged-after-review');
    await fs.outputFile(
      path.join(damagedRoot, '.agent-workflows-owner.json'),
      '{invalid owner marker\n',
    );

    const result = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env, expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
    });

    expect(result.overallState).toBe('failed');
    await expect(readIntentFixture(location)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    await expect(fs.pathExists(damagedRoot)).resolves.toBe(true);
  });

  it('preserves owned output added after cleanup evidence capture', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
    const reviewedRoot = path.join(skillsRoot, 'aw-team-demo-reviewed-output.toml');
    const addedRoot = path.join(skillsRoot, 'aw-team-demo-added-after-review.toml');
    const owner: OwnerIdentity = {
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'aw-team-demo-reviewed-output.toml',
      platform: 'codex', scope: 'project',
    };
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    await writeOwnedTextFile({
      path: reviewedRoot, allowedRoot: skillsRoot, identity: owner, content: 'reviewed output\n',
    });
    const capturedInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      inventoryCatalogSourceReferences: async () => capturedInventory,
    };
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'project' as const };
    const preview = await cleanupWriteCommand(['team/demo'], options, {
      ...runtime, previewOperationPlan: true,
    });

    await writeOwnedTextFile({
      path: addedRoot, content: 'added after Review\n',
      allowedRoot: skillsRoot,
      identity: { ...owner, artifactKey: 'aw-team-demo-added-after-review.toml' },
    });
    const addedBytes = await fs.readFile(addedRoot);

    const result = await cleanupWriteCommand(['team/demo'], options, {
      ...runtime,
      expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
    });

    expect(result.overallState).toBe('partial');
    await expect(fs.pathExists(reviewedRoot)).resolves.toBe(false);
    await expect(fs.pathExists(addedRoot)).resolves.toBe(true);
    await expect(fs.readFile(addedRoot)).resolves.toEqual(addedBytes);
    await expect(readIntentFixture(location)).resolves.toMatchObject({ roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] });
    expect(result.rebuildResults[0]).toMatchObject({
      status: 'failed',
      removed: expect.arrayContaining([path.basename(reviewedRoot)]),
      residual: expect.arrayContaining([addedRoot]),
      error: { phase: 'cleanup.owned', message: expect.stringContaining('operationPlanResidual') },
    });
  });

  it('includes an exact project supplement owner in force cleanup Review evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
    const skillRoot = path.join(skillsRoot, 'aw-team-demo-project-force-output.toml');
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    await writeOwnedTextFile({
      path: skillRoot, content: 'force output\n',
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'aw-team-demo-project-force-output.toml',
        platform: 'codex', scope: 'project',
      },
    });
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex' as const,
      scope: 'project' as const,
      force: true,
    };
    const preview = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env, previewOperationPlan: true,
    });

    expect(preview.operationPlan?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'removeOwnedArtifact',
        path: path.join(await fs.realpath(isolation.layout.fixtureCwd),
          '.codex', 'agents', 'aw-team-demo-project-force-output.toml') }),
    ]));
    const result = await cleanupWriteCommand(['team/demo'], options, {
      env: isolation.env,
      expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
      expectedOfflineCleanupEvidence: preview.offlineCleanupPlans![0],
    });

    expect(result.overallState).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(readIntentFixture(location)).resolves.toMatchObject({ roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] });
  });

  it('reports failed output cleanup and retains the declaration', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const skillRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'cleanup-failure-demo');
    await writeIntentFixture(location, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), 'cleanup fails\n');
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: path.dirname(skillRoot),
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'cleanup-failure-demo',
        platform: 'codex', scope: 'user',
      },
    });

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, {
      env: isolation.env,
      executeCleanupOperation: async ({ target }) => ({
        status: 'failed', command: 'cleanup', target: target.identity,
        actions: [{ name: 'cleanup.owned', status: 'failed' }], cleanupAttempted: true,
        removed: [], absent: [], residual: [skillRoot], quarantined: [],
        failures: [{ phase: 'cleanup.owned', message: 'injected cleanup failure' }],
        error: { phase: 'cleanup.owned', message: 'injected cleanup failure' },
      }),
    });
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('cleanup', result);

    expect(result.overallState).toBe('failed');
    expect(receipt).toMatchObject({ overallState: 'failed' });
    expect(receipt.changes.join('\n')).not.toContain('removeIntent');
    expect(receipt.changes.join('\n')).not.toContain('removeOwnedOutput');
    await expect(readIntentFixture(location)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  // Test Value Gate: a valid package owner remains sufficient for directory cleanup after the source and client are gone.
  it('keeps offline cleanup evidence separate for two physical source identities of one plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const identities = [SOURCE_IDENTITY, `sha256:${'2'.repeat(64)}`];
    const root = path.join(isolation.env.AW_CODEX_HOME!, 'agents');
    const files = [];
    for (const [index, sourceIdentity] of identities.entries()) {
      const file = path.join(root, `aw-team-demo-generation-${index}.toml`);
      files.push(file);
      await writeOwnedTextFile({ path: file, allowedRoot: root, content: `Generation ${index}.\n`, identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity, pluginId: 'team/demo', plugin: 'demo',
        artifactKey: path.basename(file), platform: 'codex', scope: 'user',
        physicalKey: getPhysicalKey({ sourceIdentity, pluginId: 'team/demo', platform: 'codex', route: 'codex-marketplace',
          namespaceRoot: isolation.env.AW_CODEX_HOME!, resourceKey: `aw-team-demo:generation-${index}` }),
      } });
    }
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    const preview = await cleanupWriteCommand(['team/demo'], options, { env: isolation.env, previewOperationPlan: true });
    expect(new Set(preview.offlineCleanupPlans!.map((entry) => entry.sourceIdentity))).toEqual(new Set(identities));
    for (const entry of preview.offlineCleanupPlans!) {
      expect(entry.plan.actions).toHaveLength(1);
      expect(entry.plan.actions[0]!.component?.identity.sourceIdentity).toBe(entry.sourceIdentity);
    }
    const result = await cleanupWriteCommand(['team/demo'], options, { env: isolation.env,
      expectedPlanFingerprint: preview.operationPlan!.planFingerprint });
    expect(result.overallState, JSON.stringify(result)).toBe('succeeded');
    expect(await Promise.all(files.map((file) => fs.pathExists(file)))).toEqual([false, false]);
  });

  it('cleans an exact native directory offline despite damaged projection metadata', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const ctx = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const binding: DeploymentBinding = { id: 'fixture', plugin: { sourceId: 'team', sourceIdentity: SOURCE_IDENTITY,
      pluginId: 'team/demo', version: '1.0.0' }, platform: 'opencode', scope: { kind: 'user' }, route: 'opencode-directory',
      consumers: [{ id: 'fixture', product: 'cli', version: null, availability: 'missing', reasonCodes: ['client-missing'],
        entry: { kind: 'directory', configRoot: resolvePlatformConfigRoot('opencode', ctx) } }],
      physicalKey: '', activationKey: 'fixture', renderUnitIds: [] };
    const layout = await getDeploymentLayout(ctx, binding);
    const identity: OwnerIdentity = { owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY,
      pluginId: 'team/demo', plugin: 'demo', artifactKey: path.basename(layout.packageRoot),
      physicalKey: getPhysicalKey(layout.physicalIdentity), platform: 'opencode', scope: 'user' };
    await fs.outputFile(path.join(layout.packageRoot, 'plugin.js'), 'export default {};\n');
    await fs.outputJson(path.join(layout.packageRoot, '.agent-workflows-owner.json'), {
      ...JSON.parse(createSkillOwnerMarkerContent(identity)), nativeProjection: { damaged: true },
    });
    const nativeCliRunner = vi.fn(async () => { throw new Error('Offline cleanup cannot call a missing client.'); });
    const options = { cwd: ctx.cwd, platform: 'opencode' as const, scope: 'user' as const };
    const preview = await cleanupWriteCommand(['team/demo'], options, { env: isolation.env,
      nativeCliRunner, previewOperationPlan: true, catalogBootstrapError: new Error('Source removed') });
    expect(preview.offlineCleanupPlans?.[0]?.plan.actions).toContainEqual(expect.objectContaining({
      action: 'removeOwnedOutput', target: layout.packageRoot, component: expect.objectContaining({ kind: 'owned-directory', identity }),
    }));
    const result = await cleanupWriteCommand(['team/demo'], options, { env: isolation.env, nativeCliRunner,
      expectedPlanFingerprint: preview.operationPlan!.planFingerprint, catalogBootstrapError: new Error('Source removed') });
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(await fs.pathExists(layout.packageRoot)).toBe(false);
    expect(nativeCliRunner).not.toHaveBeenCalled();
  });

  it('cleans a lost-source Cursor package and only its exact workspace hook without a client', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const env = { ...isolation.env, PATH: path.dirname(process.execPath) };
    const ctx = { cwd, env };
    const binding: DeploymentBinding = { id: 'fixture', plugin: { sourceId: 'team', sourceIdentity: SOURCE_IDENTITY,
      pluginId: 'team/demo', version: '1.0.0' }, platform: 'cursor', scope: { kind: 'project', projectRoot: cwd },
      route: 'cursor-workspace-hook', consumers: [{ id: 'fixture', product: 'cli', version: null,
        availability: 'missing', reasonCodes: ['client-missing'], entry: { kind: 'directory', configRoot: resolvePlatformConfigRoot('cursor', ctx) } }],
      physicalKey: '', activationKey: 'fixture', renderUnitIds: [] };
    const layout = await getDeploymentLayout(ctx, binding);
    await fs.outputFile(path.join(layout.packageRoot, '.cursor/workspace.mdc'), 'Owned workspace rules.\n');
    await writeSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot), identity: {
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, pluginId: 'team/demo', plugin: 'demo',
      artifactKey: path.basename(layout.packageRoot), platform: 'cursor', scope: 'project', physicalKey: getPhysicalKey(layout.physicalIdentity),
    } });
    const command = cursorWorkspaceOpenCommand(binding);
    await fs.outputJson(layout.activationPath, { version: 1, hooks: { workspaceOpen: [{ command }, { command: 'manual-hook' }] } });
    const preparedArtifactRenderResults = new Map();
    const runtime: RebuildCommandRuntime = { env, preparedArtifactRenderResults,
      nativeCliRunner: async () => { throw new Error('No native client is available.'); } };
    const options = { cwd, platform: 'cursor' as const, scope: 'project' as const };
    try {
      const preview = await cleanupWriteCommand(['team/demo'], options, { ...runtime, previewOperationPlan: true });
      expect(preview.operationPlan!.deploymentPlans).toHaveLength(1);
      const result = await cleanupWriteCommand(['team/demo'], options, { ...runtime,
        expectedPlanFingerprint: preview.operationPlan!.planFingerprint, expectedOfflineCleanupEvidence: preview.offlineCleanupPlans![0] });
      expect(result.overallState, JSON.stringify(result)).toBe('succeeded');
      expect(await fs.pathExists(layout.packageRoot)).toBe(false);
      expect((await fs.readJson(layout.activationPath)).hooks.workspaceOpen).toEqual([{ command: 'manual-hook' }]);
    } finally { await disposePreparedPlatformRebuildSession(preparedArtifactRenderResults); }
  });

  it('roundtrips owner schema 3 with stable plugin identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.env.AW_HOME!, 'owner-schema2');
    const skillRoot = path.join(skillsRoot, 'review');
    await fs.ensureDir(skillRoot);
    const identity: OwnerIdentity = {
      owner: 'agent-workflows',
      sourceId: 'team',
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'review',
      platform: 'codex',
      scope: 'user',
    };

    expect(JSON.parse(createSkillOwnerMarkerContent(identity))).toMatchObject({
      schemaVersion: 3,
      sourceId: 'team',
      pluginId: 'team/demo',
    });
    await writeSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, identity });
    await expect(readSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, expectedIdentity: identity }))
      .resolves.toMatchObject(identity);

    const backupPath = path.join(isolation.layout.fixtureCwd, '.codex', 'backup.txt');
    await fs.outputFile(backupPath, createSharedOwnerToken(identity));
    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: backupPath }));
  });

  it('inventories direct Project Skill owners but ignores nested and marketplace markers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const identity: OwnerIdentity = {
      owner: 'agent-workflows',
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'role',
      platform: 'codex',
      scope: 'project',
    };
    const backup = path.join(isolation.layout.fixtureCwd, '.codex', 'backup.toml');
    const exampleMarker = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'examples',
      'copied-skill',
      '.agent-workflows-owner.json',
    );
    const role = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-demo-role.toml');
    const projectSkillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'review');
    const nestedSkillMarker = path.join(
      projectSkillRoot,
      'examples',
      'copied',
      '.agent-workflows-owner.json',
    );
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const bundleSkillRoot = path.join(
      marketplaceRoot,
      'plugins',
      'demo',
      'codex',
      'skills',
      'bundle-review',
    );
    await Promise.all([
      fs.outputFile(backup, renderOwnedTextFile('backup\n', identity)),
      fs.outputJson(exampleMarker, {
        schemaVersion: 2,
        ...identity,
        artifactKey: 'copied-skill',
      }),
      fs.outputFile(role, renderOwnedTextFile('role\n', identity)),
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        marketplaceName: 'aw-team',
      }),
      fs.ensureDir(projectSkillRoot),
      fs.ensureDir(bundleSkillRoot),
      fs.outputJson(nestedSkillMarker, {
        schemaVersion: 2,
        ...identity,
        artifactKey: 'copied',
      }),
    ]);
    await Promise.all([
      writeSkillOwnerMarker({
        skillRoot: projectSkillRoot,
        allowedRoot: path.dirname(projectSkillRoot),
        identity: { ...identity, artifactKey: 'review' },
      }),
      writeSkillOwnerMarker({
        skillRoot: bundleSkillRoot,
        allowedRoot: path.dirname(bundleSkillRoot),
        identity: {
          ...identity,
          artifactKey: 'bundle-review',
          scope: 'user',
        },
      }),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'namespacedOwner', location: role, sourceId: 'team' }),
      expect.objectContaining({
        kind: 'namespacedOwner',
        location: path.join(projectSkillRoot, '.agent-workflows-owner.json'),
        sourceId: 'team',
        scope: 'project',
      }),
    ]));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: backup }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: exampleMarker }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({ location: nestedSkillMarker }));
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      location: path.join(bundleSkillRoot, '.agent-workflows-owner.json'),
      sourceId: 'team',
    }));
    const nativeProjectInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      scope: 'project',
    });
    expect(nativeProjectInventory.references).not.toContainEqual(expect.objectContaining({
      location: path.join(projectSkillRoot, '.agent-workflows-owner.json'),
    }));
    expect(nativeProjectInventory.references).toContainEqual(expect.objectContaining({ location: role }));
  });

  it('does not turn Codex cache residue into ordinary or orphan cleanup consumers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplacesRoot = path.join(isolation.env.AW_HOME!, 'marketplaces');
    const roots = {
      team: path.join(marketplacesRoot, 'team'),
      unrelated: path.join(marketplacesRoot, 'unrelated'),
    };
    await Promise.all(Object.entries(roots).flatMap(([sourceId, root]) => {
      const marketplaceName = `aw-${sourceId}`;
      return [
        fs.outputJson(path.join(root, 'config.json'), {
          schemaVersion: 2,
          sourceId,
          sourceIdentity: SOURCE_IDENTITY,
          marketplaceName,
        }),
        fs.outputJson(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
          name: marketplaceName,
          plugins: [],
        }),
        fs.outputJson(path.join(root, '.claude-plugin', 'marketplace.json'), {
          name: marketplaceName,
          plugins: [],
        }),
      ];
    }));
    await fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
      '[marketplaces.aw-team]',
      `source = ${JSON.stringify(roots.team)}`,
      'source_type = "local"',
      '[marketplaces.aw-unrelated]',
      `source = ${JSON.stringify(roots.unrelated)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    await fs.outputJson(path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins',
      'cache',
      'aw-team',
      'demo',
      '1.0.0',
      'plugin.json',
    ), { name: 'demo', version: '1.0.0' });
    const outside = path.join(isolation.layout.rootDir, 'unrelated-cache-outside');
    await fs.ensureDir(outside);
    await fs.ensureDir(path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache'));
    await fs.symlink(
      outside,
      path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw-unrelated'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const ordinary = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(ordinary.errors).toEqual([]);
    expect(ordinary.references).not.toContainEqual(expect.objectContaining({
      pluginName: 'demo', platform: 'codex',
    }));

    const orphanCleanup = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(orphanCleanup.errors).toEqual([]);
    expect(orphanCleanup.references).not.toContainEqual(expect.objectContaining({
      pluginName: 'demo', platform: 'codex',
    }));
  });

  it('stores config below separate source/plugin segments with stable plugin identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const options = {
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      pluginName: 'demo',
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writePluginConfigStore({ ...options, values: { mode: 'fast' } });

    const storePath = resolvePluginConfigStorePath(options);
    expect(storePath).toBe(path.join(isolation.env.AW_HOME!, 'plugin-config', 'team', 'demo', 'config.json'));
    expect(await fs.readJson(storePath)).toMatchObject({
      schemaVersion: 6,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: SOURCE_IDENTITY },
      pluginName: 'demo',
      common: { mode: 'fast' },
      platforms: {},
    });
    await expect(readPluginConfigStore(options)).resolves.toMatchObject({ values: { mode: 'fast' } });
    await expect(listNamespacedPluginConfigStores({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      scope: 'user',
    })).resolves.toContainEqual(expect.objectContaining({
      pluginId: 'team/demo',
      pluginName: 'demo',
      sourceId: 'team',
    }));
    await expect(readPluginConfigStore({
      ...options,
      sourceIdentity: `sha256:${'2'.repeat(64)}`,
    })).resolves.toMatchObject({
      state: 'invalid',
      invalidCode: 'identityMismatch',
      values: {},
    });
    await fs.outputJson(path.join(isolation.env.AW_HOME!, 'plugin-config', 'demo', 'config.json'), {
      mode: 'legacy',
    });
    await expect(readPluginConfigStore(options)).rejects.toThrow('legacyStateUnsupported');
    expect(() => resolvePluginConfigStorePath({ ...options, sourceId: 'team/demo' }))
      .toThrow('Invalid plugin config segment');
  });

  it('resets source-missing config by namespaced selector, rejects a bare ambiguity, and preserves another source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = path.join(isolation.layout.fixtureCwd, 'primary-config-source');
    const teamRoot = path.join(isolation.layout.fixtureCwd, 'team-config-source');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
      }),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [
        { id: 'primary', type: 'path', primary: true, path: primaryRoot },
        { id: 'team', type: 'path', primary: false, path: teamRoot },
      ] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const setOutput = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: setOutput.io, interactive: false,
    })).toBe(0);
    await writePluginConfigStore({
      sourceId: 'other', sourceIdentity: `sha256:${'c'.repeat(64)}`, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
    });
    const ambiguous = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'reset', 'demo', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: ambiguous.io, interactive: false,
    })).toBe(1);
    expect(JSON.parse(ambiguous.readStdout())).toMatchObject({
      command: 'plugin.config.reset', status: 'failed', diagnostics: [expect.objectContaining({ code: 'configTargetAmbiguous' })],
    });

    await fs.outputFile(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), '{invalid');
    await expect(removeCatalogSourceCommand({
      sourceId: 'team', cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true });

    const reset = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'reset', 'team/demo', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: reset.io, interactive: false,
    })).toBe(0);
    expect(JSON.parse(reset.readStdout()).data).toMatchObject({
      pluginId: 'team/demo',
      deleted: true,
      removedKeys: [],
      resetDisposition: 'deletedFile',
    });
    await expect(readPluginConfigStore({
      sourceId: 'other', sourceIdentity: `sha256:${'c'.repeat(64)}`, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ values: { retained: true } });
  });

  it.each(['source', 'plugin', 'config'] as const)(
    'rejects a namespaced config inventory symlink in the %s path segment',
    async (segment) => {
      const isolation = getCurrentSourceTestIsolation();
      const storeRoot = path.join(isolation.env.AW_HOME!, 'plugin-config');
      const sourceRoot = path.join(storeRoot, 'team');
      const pluginRoot = path.join(sourceRoot, 'demo');
      const externalRoot = path.join(isolation.layout.rootDir, `external-config-${segment}`);
      const externalFile = path.join(externalRoot, 'config.json');
      await fs.outputJson(externalFile, {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        pluginName: 'demo',
        values: { secret: 'outside-store' },
      });
      if (segment === 'source') {
        await fs.ensureDir(storeRoot);
        await fs.symlink(externalRoot, sourceRoot);
      } else if (segment === 'plugin') {
        await fs.ensureDir(sourceRoot);
        await fs.symlink(externalRoot, pluginRoot);
      } else {
        await fs.ensureDir(pluginRoot);
        await fs.symlink(externalFile, path.join(pluginRoot, 'config.json'));
      }

      const inventory = listNamespacedPluginConfigStores({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        scope: 'user',
      });
      await expect(inventory).rejects.toThrow('Config path cannot contain a symbolic link');
      if (segment !== 'config') {
        await expect(listNamespacedPluginConfigStores({
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          scope: 'user',
        })).rejects.toMatchObject({ code: 'invalidPluginConfigStore' });
      }
    },
  );

  it('rejects a namespaced config inventory symlink at the user store root boundary', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const externalRoot = path.join(isolation.layout.rootDir, 'external-config-boundary');
    await fs.outputJson(path.join(externalRoot, 'team', 'demo', 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY,
      pluginName: 'demo',
      values: { secret: 'outside-boundary' },
    });
    await fs.ensureDir(isolation.env.AW_HOME!);
    await fs.symlink(externalRoot, path.join(isolation.env.AW_HOME!, 'plugin-config'));

    await expect(listNamespacedPluginConfigStores({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      scope: 'user',
    })).rejects.toMatchObject({ code: 'invalidPluginConfigStore' });

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).not.toContainEqual(expect.objectContaining({
      kind: 'namespacedConfig',
      sourceId: 'team',
      pluginName: 'demo',
    }));
    expect(inventory.errors).toContainEqual(expect.objectContaining({
      kind: expect.stringContaining('config'),
      relevance: expect.objectContaining({ global: false, scope: 'user' }),
    }));
  });

  it('emits a config result and keeps a namespaced store after its source is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = path.join(isolation.layout.fixtureCwd, 'primary-source');
    const teamRoot = path.join(isolation.layout.fixtureCwd, 'team-source');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.config = {
          fields: {
            mode: {
              type: 'string',
              title: 'Mode',
              choices: {
                allowCustom: false,
                presets: [{ id: 'fast', title: 'Fast', value: 'fast' }],
              },
            },
            enabled: {
              type: 'boolean',
              choices: {
                allowCustom: false,
                presets: [{ id: 'off', title: 'Off', value: false }],
              },
            },
          },
        };
      }),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'primary', type: 'path', primary: true, path: primaryRoot },
          { id: 'team', type: 'path', primary: false, path: teamRoot },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    for (const args of [
      ['--context', 'user'],
      ['--context', 'user', '--value-json', '"fast"', '--preset', 'fast'],
    ]) {
      const invalidOutput = createCapturedCliIo();
      expect(await runCli(['plugin', 'config', 'set', 'team/demo', 'mode', ...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: invalidOutput.io,
        interactive: false,
      })).toBe(2);
      expect(JSON.parse(invalidOutput.readStdout())).toMatchObject({
        command: 'plugin.config.set', status: 'failed', data: {},
      });
    }
    const setOutput = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'fast', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: setOutput.io,
      interactive: false,
    })).toBe(0);
    const setResult = JSON.parse(setOutput.readStdout());
    expect(setResult).toMatchObject({ schemaVersion: 1, command: 'plugin.config.set', status: 'success' });
    const setReceipt = setResult.data as { sourceIdentity: string };
    expect(setReceipt).toMatchObject({
      pluginName: 'demo',
      pluginId: 'team/demo',
      sourceId: 'team',
      sourceIdentity: expect.stringMatching(/^sha256:/),
    });
    const stored = await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: setReceipt.sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(stored.values).toEqual({ mode: 'fast' });
    expect(JSON.stringify(stored.values)).not.toContain('preset');
    const booleanPresetOutput = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'config', 'set', 'team/demo', 'enabled', '--preset', 'off', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: booleanPresetOutput.io,
      interactive: false,
    })).toBe(0);
    expect(await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: setReceipt.sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).toMatchObject({ values: { mode: 'fast', enabled: false } });
    const getOutput = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'get', 'team/demo', 'mode', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: getOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(getOutput.readStdout()).data).toMatchObject({
      fields: [{
        key: 'mode', effectiveValue: 'fast', sourceLayer: 'common', matchedPreset: 'fast', valid: true, issues: [],
      }],
    });
    await fs.outputFile(stored.path, '{ invalid json');
    const unconfirmedReset = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'reset', 'team/demo', '--context', 'user', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: unconfirmedReset.io,
      interactive: false,
    })).toBe(3);
    await expect(fs.pathExists(stored.path)).resolves.toBe(true);
    const confirmedReset = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'reset', 'team/demo', '--context', 'user', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: confirmedReset.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(confirmedReset.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.reset', status: 'success',
      data: { configWrite: 'succeeded', deleted: true },
    });
    await expect(fs.pathExists(stored.path)).resolves.toBe(false);
    const remainingNames = await fs.readdir(path.dirname(stored.path)).catch(() => []);
    expect(remainingNames.some((name) => /backup|journal/iu.test(name))).toBe(false);
    const restoreOutput = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'fast', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: restoreOutput.io,
      interactive: false,
    })).toBe(0);
    await expect(removeCatalogSourceCommand({
      sourceId: 'team',
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      references: [{
        category: 'config',
        pluginId: 'team/demo',
        scope: 'user',
        sourceId: 'team',
      }],
    });
    const skillsRoot = path.join(
      isolation.env.AW_HOME!,
      'marketplaces',
      'team',
      'plugins',
      'demo',
      'codex',
      'skills',
    );
    const skillRoot = path.join(skillsRoot, 'review');
    await Promise.all([
      fs.ensureDir(skillRoot),
      fs.outputJson(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: setReceipt.sourceIdentity,
        marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(
        isolation.env.AW_HOME!, 'marketplaces', 'team', '.agents', 'plugins', 'marketplace.json',
      ), { name: 'aw-team' }),
    ]);
    const { getPhysicalKey, canonicalNamespaceRoot } = await import('../../src/platforms/identity.js');
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: setReceipt.sourceIdentity,
        physicalKey: getPhysicalKey({ sourceIdentity: setReceipt.sourceIdentity, pluginId: 'team/demo', platform: 'codex', route: 'codex-marketplace', namespaceRoot: await canonicalNamespaceRoot(isolation.env.CODEX_HOME!), resourceKey: 'aw-team-demo' }),
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'review',
        platform: 'codex',
        scope: 'user',
      },
    });
    const offlineResetOutput = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'reset', 'team/demo', '--yes', '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: offlineResetOutput.io,
      interactive: false,
    })).toBe(0);
    expect(JSON.parse(offlineResetOutput.readStdout())).toMatchObject({
      command: 'plugin.config.reset', status: 'success', data: { deleted: true },
    });
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'team',
      sourceIdentity: setReceipt.sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }))).toBe(false);
  });

  it('preserves a lost-source shared native consumer for explicit reconciliation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw',
        plugins: [],
      }),
      fs.outputJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
        name: 'aw',
        plugins: [],
      }),
    ]);
    const codexConfig = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await fs.outputFile(codexConfig, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const cacheRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0');
    const installedRoot = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'demo@aw');
    await Promise.all([
      fs.outputJson(path.join(cacheRoot, 'plugin.json'), { name: 'demo', version: '1.0.0' }),
      fs.outputJson(path.join(installedRoot, 'manifest.json'), { id: 'demo@aw', version: '1.0.0' }),
    ]);
    const calls: string[] = [];
    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, {
      env: isolation.env,
      nativeCliRunner: async (invocation) => {
        const command = invocation.agentKind
          ?? path.basename(invocation.command).replace(/\.(?:cmd|exe)$/iu, '');
        calls.push([command, ...invocation.args].join(' '));
        if (invocation.args[1] === 'remove') {
          await Promise.all([fs.remove(cacheRoot), fs.remove(installedRoot)]);
          await fs.outputFile(codexConfig, [
            '[marketplaces.aw]',
            `source = ${JSON.stringify(marketplaceRoot)}`,
            'source_type = "local"',
            '',
          ].join('\n'));
        }
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
          await fs.outputFile(codexConfig, '');
        }
        return { exitCode: 0, stdout: 'codex-cli 0.167.0', stderr: '' };
      },
    });
    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [],
    });
    expect(calls).not.toContain('codex plugin remove demo@aw');
    await expect(fs.pathExists(cacheRoot)).resolves.toBe(true);
    await expect(fs.pathExists(installedRoot)).resolves.toBe(true);
  });

  it('keeps an existing marketplace root when its strict identity is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const primaryRoot = path.join(isolation.layout.fixtureCwd, 'rollback-primary');
    const teamRoot = path.join(isolation.layout.fixtureCwd, 'rollback-team');
    await Promise.all([
      createCatalogSnapshotFixture(primaryRoot, 'primary-demo'),
      createCatalogSnapshotFixture(teamRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.platforms = ['claude'];
      }),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'primary', type: 'path', primary: true, path: primaryRoot },
          { id: 'team', type: 'path', primary: false, path: teamRoot },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await fs.outputFile(path.join(marketplaceRoot, 'sentinel'), 'previous generation\n');
    const result = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'claude',
      scope: 'user',
    }, {
      env: isolation.env,
      nativeCliRunner: async (invocation) => {
        if (invocation.args[0] === '--version') {
          return { exitCode: 0, stdout: 'claude 2.1.32', stderr: '' };
        }
        throw new Error('native install failed');
      },
    });
    expect(result.overallState).toBe('failed');
    expect(result.rebuildResults).toEqual([expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('stateInventoryFailed') }),
    })]);
    expect(await fs.readFile(path.join(marketplaceRoot, 'sentinel'), 'utf8'))
      .toBe('previous generation\n');
    expect(await fs.pathExists(path.join(marketplaceRoot, 'config.json'))).toBe(false);
    expect((await fs.readdir(path.dirname(marketplaceRoot))).filter((entry) =>
      entry.startsWith('team.backup-'))).toEqual([]);
  });

  it('reports damaged direct Project Skill owners without scanning them in ordinary Native inventory', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const validRoot = path.join(skillsRoot, 'valid');
    await fs.ensureDir(validRoot);
    await writeSkillOwnerMarker({
      skillRoot: validRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'valid',
        platform: 'codex',
        scope: 'project',
      },
    });
    await Promise.all([
      fs.outputFile(
        path.join(isolation.layout.fixtureCwd, '.agents', 'rules', 'bad-header.md'),
        '# agent-workflows-owner: {invalid}\ncontent\n',
      ),
      fs.outputFile(path.join(skillsRoot, 'bad-json', '.agent-workflows-owner.json'), '{invalid'),
      fs.outputJson(path.join(skillsRoot, 'bad-schema', '.agent-workflows-owner.json'), {
        schemaVersion: 3,
        owner: 'agent-workflows',
      }),
      fs.outputJson(path.join(skillsRoot, 'wrong-key', '.agent-workflows-owner.json'), {
        schemaVersion: 2,
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'different-parent',
        platform: 'codex',
        scope: 'project',
      }),
    ]);

    const inventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(inventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      location: path.join(validRoot, '.agent-workflows-owner.json'),
      sourceId: 'team',
      scope: 'project',
    }));
    for (const name of ['bad-json', 'bad-schema', 'wrong-key']) {
      expect(inventory.errors).toContainEqual(expect.objectContaining({
        code: 'stateInventoryFailed',
        location: `[catalog-source]/.agents/skills/${name}/.agent-workflows-owner.json`,
      }));
    }
    expect(JSON.stringify(inventory.errors)).not.toContain(isolation.layout.fixtureCwd);
    const nativeProjectInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      scope: 'project',
    });
    expect(nativeProjectInventory.references).not.toContainEqual(expect.objectContaining({
      location: path.join(validRoot, '.agent-workflows-owner.json'),
    }));
    expect(nativeProjectInventory.errors).toEqual([]);
  });

  it('ignores marker-free system Skill directories but validates owner markers in them', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    const systemRoot = path.join(skillsRoot, '.system');
    const validRoot = path.join(skillsRoot, 'valid');
    await Promise.all([fs.ensureDir(systemRoot), fs.ensureDir(validRoot)]);
    await writeSkillOwnerMarker({
      skillRoot: validRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
        pluginId: 'team/demo',
        plugin: 'demo',
        artifactKey: 'valid',
        platform: 'codex',
        scope: 'user',
      },
    });

    const foreignInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(foreignInventory.errors).toEqual([]);
    expect(foreignInventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      sourceId: 'team',
      pluginName: 'demo',
      location: path.join(validRoot, '.agent-workflows-owner.json'),
    }));

    await fs.outputJson(path.join(systemRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'team',
      sourceIdentity: SOURCE_IDENTITY, physicalKey: ownerPhysicalKey(path.join(isolation.layout.fixtureCwd, '.codex')),
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'system',
      platform: 'codex',
      scope: 'user',
    });
    const ownedInventory = await inventoryCatalogSourceReferences({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(ownedInventory.errors).toContainEqual(expect.objectContaining({
      code: 'stateInventoryFailed',
      kind: 'ownerMarkerValidation',
    }));
    expect(ownedInventory.references).toContainEqual(expect.objectContaining({
      kind: 'namespacedOwner',
      sourceId: 'team',
      pluginName: 'demo',
      location: path.join(validRoot, '.agent-workflows-owner.json'),
    }));
  });

  it('keeps unrelated legacy state while installing a Native directory package', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'legacy-install-source');
    await directoryCatalog(sourceRoot, 'opencode');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    const legacyMarker = path.join(isolation.layout.fixtureCwd, '.agents/skills/legacy-owner/.agent-workflows-owner.json');
    const bytes = JSON.stringify({ schemaVersion: 1, owner: 'agent-workflows', plugin: 'legacy-owner',
      artifactKey: 'legacy-owner', platform: 'codex', scope: 'project' });
    await fs.outputFile(legacyMarker, bytes);
    const runtime = await nativeFixtureRuntime();
    const result = await installWriteCommand(['team/demo'], { cwd: isolation.layout.fixtureCwd, platform: 'opencode', scope: 'project' }, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(await fs.pathExists(path.join(isolation.layout.fixtureCwd, '.opencode/plugins/aw-team-demo/.agent-workflows-owner.json'))).toBe(true);
    expect(await fs.readFile(legacyMarker, 'utf8')).toBe(bytes);
  });

  it.each([
    ['codex', 'foreign-registration'], ['claude', 'foreign-registration'],
    ['codex', 'orphan-consumer'], ['claude', 'orphan-consumer'],
  ] as const)('uses its verified %s namespace and retains an independent %s', async (platform, collision) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'primary-collision-source');
    await directoryCatalog(sourceRoot, platform);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    const foreignRoot = path.join(isolation.layout.fixtureCwd, 'foreign-marketplace');
    const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    if (platform === 'codex') await fs.outputFile(configPath, [
      ...(collision === 'foreign-registration' ? ['[marketplaces.aw]', 'source = '+JSON.stringify(foreignRoot), 'source_type = "local"'] : []),
      '[plugins."legacy-owner@aw"]', 'enabled = true', '',
    ].join('\n'));
    else await fs.outputJson(settingsPath, {
      ...(collision === 'foreign-registration' ? { extraKnownMarketplaces: { aw: { source: { source: 'directory', path: foreignRoot } } } } : {}),
      enabledPlugins: { 'legacy-owner@aw': true },
    });
    const runtime = await nativeFixtureRuntime();
    const installed = await installWriteCommand(['team/demo'], { cwd: isolation.layout.fixtureCwd, platform, scope: 'user' }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const deployment = installed.operationPlan?.deploymentPlans?.[0];
    expect(deployment?.binding.route).toBe(platform+'-marketplace');
    const layout = deployment!.evidence.layout;
    expect(layout.marketplaceName).not.toBe('aw');
    expect(await fs.pathExists(path.join(layout.packageRoot, '.'+platform+'-plugin/plugin.json'))).toBe(true);
    if (platform === 'codex') {
      const state = await readCodexConfigFile(configPath);
      expect(state.snapshot.plugins['legacy-owner@aw']?.enabled).toBe(true);
      expect(state.snapshot.plugins[layout.nativeIdentity.registrationId!]?.enabled).toBe(true);
      if (collision === 'foreign-registration') expect(state.snapshot.marketplaces.aw?.source).toBe(foreignRoot);
    } else {
      const settings = await fs.readJson(settingsPath);
      expect(settings.enabledPlugins['legacy-owner@aw']).toBe(true);
      expect(settings.enabledPlugins[layout.nativeIdentity.registrationId!]).toBe(true);
      if (collision === 'foreign-registration') expect(settings.extraKnownMarketplaces.aw.source.path).toBe(foreignRoot);
    }
  });

  it.each(['foreign-registration', 'orphan-consumer', 'claude-orphan-consumer'] as const)(
    'rejects a source-bound marketplace with a retained %s when primary aw is also foreign',
    async (namespacedCollision) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'double-marketplace-collision-source');
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.platforms = ['codex'];
      });
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
      const original = [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-aw'))}`,
        'source_type = "local"',
        ...(namespacedCollision === 'foreign-registration' ? [
          '[marketplaces.aw-team]',
          `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-aw-team'))}`,
          'source_type = "local"',
        ] : namespacedCollision === 'orphan-consumer' ? [
          '[plugins."foreign-owner@aw-team"]',
          'enabled = true',
        ] : []),
        '',
      ].join('\n');
      await fs.outputFile(configPath, original);
      if (namespacedCollision === 'claude-orphan-consumer') {
        await fs.outputJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json'), {
          enabledPlugins: { 'foreign-owner@aw-team': true },
        });
      }
      const nativeCliRunner = vi.fn(async () => ({
        exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
      }));

      const result = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { env: isolation.env, nativeCliRunner });
      expect(result).toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'externalOwnershipPresent' })],
      });
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(original);
      if (namespacedCollision === 'claude-orphan-consumer') {
        await expect(fs.readJson(path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json')))
          .resolves.toMatchObject({ enabledPlugins: { 'foreign-owner@aw-team': true } });
      }
      await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team')))
        .resolves.toBe(false);
      expect(nativeCliRunner).not.toHaveBeenCalled();
    },
  );

  it.each(['cleanup', 'uninstall'] as const)('%s keeps a live platform after the current bundle revokes support', async (command) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'revoked-source');
    await directoryCatalog(sourceRoot, 'opencode');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    const runtime = await nativeFixtureRuntime();
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'opencode' as const, scope: 'project' as const };
    expect((await installWriteCommand(['team/demo'], options, runtime)).overallState).toBe('succeeded');
    const output = path.join(isolation.layout.fixtureCwd, '.opencode/plugins/aw-team-demo');
    expect(await fs.pathExists(output)).toBe(true);
    await directoryCatalog(sourceRoot, 'claude');
    const result = command === 'cleanup' ? await cleanupWriteCommand(['team/demo'], options, runtime)
      : await uninstallWriteCommand(['team/demo'], options, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.receiptTargets).toContainEqual(expect.objectContaining({ pluginId: 'team/demo', platform: 'opencode', scope: 'project' }));
    expect(await fs.pathExists(output)).toBe(false);
  });

  // Test Value Gate: Antigravity's copied CLI marker is not an App directory
  // placement or direct cache deletion grant. It must survive loss of its source.
  it.each([false, true])('records an exact Antigravity native recovery clue with missing source=%s', async (missingSource) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const native = await getNativeTestLayout({ platform: 'antigravity', sourceId: 'team', pluginId: 'team/demo',
      sourceIdentity: SOURCE_IDENTITY, cwd, env, scope: 'user' });
    const component = deploymentPackageComponent(native.binding, native);
    if (component.kind !== 'owned-directory') throw new Error('Expected an Antigravity source package.');
    await fs.outputFile(path.join(component.path, 'skills/check/SKILL.md'), 'Native recovery content.\n');
    const contentDigest = (await readPlatformPackageContentDigest(component.path))!;
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: { physicalIdentity: native.physicalIdentity, contentDigest, inputDigest: `sha256:${'c'.repeat(64)}`,
        preparation: 'complete', components: [{ id: 'skill:check', nativeName: 'check', relativeOutputs: ['skills/check/SKILL.md'] }] } });
    const copy = path.join(resolvePlatformConfigRoot('antigravity', { cwd, env }), 'plugins/demo');
    await fs.copy(component.path, copy);
    const foreign = path.join(path.dirname(copy), 'foreign/keep.txt');
    await fs.outputFile(foreign, 'Foreign content.\n');
    if (missingSource) await fs.remove(component.path);
    const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(inventory.errors).toEqual([]);
    const reference = inventory.references.find((entry) => entry.location === path.join(copy, SKILL_OWNER_MARKER));
    expect(reference).toMatchObject({ kind: 'namespacedMarketplace', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY,
      pluginName: 'demo', platform: 'antigravity', scope: 'user', pathEvidence: expect.stringMatching(/^sha256:/u),
      recoveryCandidate: { evidence: 'verified', physicalIdentity: native.physicalIdentity,
        binding: { route: 'antigravity-cli', physicalKey: native.binding.physicalKey, scope: { kind: 'user' } },
        nativeIdentity: { sourceLocation: component.path, packageId: 'demo' } } });
    expect(reference!.ownedComponent).toBeUndefined();
    const evidence = offlineCleanupEvidenceFromInventory({ inventory, reason: 'bundleUnavailable', pluginId: 'team/demo',
      pluginName: 'demo', sourceId: 'team', sourceIdentity: SOURCE_IDENTITY, platform: 'antigravity', scope: 'user' });
    const copyAction = evidence!.plan.actions.find((action) => action.target === reference!.location)!;
    expect(copyAction.action).toBe('removeNativeRegistration');
    expect(copyAction.component).toBeUndefined();
    expect(copyAction.recoveryCandidate?.binding.route).toBe('antigravity-cli');
    expect(inventory.references.filter((entry) => entry.ownedComponent && 'path' in entry.ownedComponent
      && entry.ownedComponent.path === component.path)).toHaveLength(missingSource ? 0 : 1);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign content.\n');
    await fs.outputFile(path.join(copy, 'local-data.txt'), 'Keep local data.\n');
    const changed = await inventoryCatalogSourceReferences({ cwd, env, scope: 'user' });
    expect(changed.references.some((entry) => entry.location === reference!.location)).toBe(false);
    expect(changed.errors).toContainEqual(expect.objectContaining({ kind: 'nativeOwnerRead', message: expect.stringContaining('nativeCopyContentUnconfirmed') }));
    expect(await fs.readFile(path.join(copy, 'local-data.txt'), 'utf8')).toBe('Keep local data.\n');
  });

  it.each(['codex', 'claude'] as const)('records a %s project reference only after exact project activation exists', async (platform) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    await fs.ensureDir(path.join(cwd, '.git'));
    const sourceRoot = path.join(cwd, 'shared-user-reference-source');
    await directoryCatalog(sourceRoot, platform);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    const runtime = await nativeFixtureRuntime();
    const installed = await installWriteCommand(['team/demo'], { cwd, platform, scope: 'user' }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const installedPlan = installed.operationPlan!.deploymentPlans![0]!;
    const ownCandidates = (inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>) => inventory.references.filter((reference) =>
      reference.sourceId === 'team' && reference.pluginName === 'demo' && reference.platform === platform && reference.recoveryCandidate);
    const before = await inventoryCatalogSourceReferences({ cwd, env: runtime.env, scope: 'project' });
    expect(ownCandidates(before).map((reference) => reference.scope)).toEqual(['user']);
    const nativeId = installedPlan.evidence.layout.nativeIdentity.registrationId!;
    if (platform === 'codex') await applyCodexConfigTransactionFile(path.join(cwd, '.codex/config.toml'), { upsertPluginActivations: { [nativeId]: true } });
    else await fs.outputJson(path.join(cwd, '.claude/settings.local.json'), { enabledPlugins: { [nativeId]: true } });
    const after = await inventoryCatalogSourceReferences({ cwd, env: runtime.env, scope: 'project' });
    expect(ownCandidates(after).map((reference) => reference.scope)).toEqual(['user', 'project']);
    expect(ownCandidates(after).every((reference) => reference.recoveryCandidate!.binding.physicalKey === installedPlan.binding.physicalKey)).toBe(true);
  });

  // Test Value Gate: canonical User bytes authorize only the exact observed
  // Project entry. Inheritance and unrelated or malformed rules grant no scope.
  it('records Gemini Project recovery only for its exact explicit activation rule', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    await fs.ensureDir(path.join(cwd, '.git'));
    const otherProject = path.join(cwd, 'other-project');
    await fs.ensureDir(otherProject);
    const native = await getNativeTestLayout({ platform: 'gemini', sourceId: 'team', pluginId: 'team/demo',
      sourceIdentity: SOURCE_IDENTITY, cwd, env, scope: 'user' });
    const component = deploymentPackageComponent(native.binding, native);
    if (component.kind !== 'owned-directory') throw new Error('Expected a Gemini source package.');
    await fs.ensureDir(component.path);
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const { home, file } = geminiExtensionPaths({ cwd, env });
    const target = geminiScopePattern(cwd);
    for (const [rules, expected] of [
      [[], false], [['*'], false], [[geminiScopePattern(home)], false], [[geminiScopePattern(otherProject)], false],
      [[target], true], [[`!${target}`], true],
    ] as const) {
      await fs.outputJson(file, { demo: { overrides: rules } });
      const inventory = await inventoryCatalogSourceReferences({ cwd, env, scope: 'project' });
      expect(inventory.errors).toEqual([]);
      const references = inventory.references.filter((reference) => reference.sourceId === 'team'
        && reference.pluginName === 'demo' && reference.platform === 'gemini' && reference.recoveryCandidate);
      expect(references.map((reference) => reference.scope), JSON.stringify(rules)).toEqual(expected ? ['user', 'project'] : ['user']);
      expect(references.every((reference) => reference.recoveryCandidate!.binding.physicalKey === native.binding.physicalKey)).toBe(true);
    }
    await fs.outputFile(file, '{invalid');
    const malformed = await inventoryCatalogSourceReferences({ cwd, env, scope: 'project' });
    expect(malformed.references.some((reference) => reference.platform === 'gemini' && reference.scope === 'project' && reference.recoveryCandidate)).toBe(false);
    expect(malformed.errors).toContainEqual(expect.objectContaining({ kind: 'nativeProjectActivationRead' }));
  });

  it('repairs a damaged native package through reinstall while retaining its foreign sibling', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-repair-source');
    await directoryCatalog(sourceRoot, 'opencode');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    const runtime = await nativeFixtureRuntime();
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'opencode' as const, scope: 'user' as const };
    const installed = await installWriteCommand(['team/demo'], options, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const output = installed.operationPlan!.deploymentPlans![0]!.evidence.layout.packageRoot;
    const foreign = path.join(path.dirname(output), 'foreign-plugin/keep.txt');
    await fs.outputFile(foreign, 'Foreign sibling.\n');
    const markerPath = path.join(output, '.agent-workflows-owner.json');
    await fs.writeJson(markerPath, { ...await fs.readJson(markerPath), nativeProjection: { damaged: true } });
    await fs.writeFile(path.join(output, 'skills/demo-skill/SKILL.md'), 'Damaged payload.\n');
    const repaired = await reinstallWriteCommand(['team/demo'], options, runtime);
    expect(repaired.overallState, JSON.stringify(repaired)).toBe('succeeded');
    expect(await fs.readFile(path.join(output, 'skills/demo-skill/SKILL.md'), 'utf8')).toContain('description: Fixture.');
    const marker = await readSkillOwnerMarker({ skillRoot: output, allowedRoot: path.dirname(output) });
    expect(marker?.nativeProjection).toMatchObject({ preparation: 'complete', components: expect.arrayContaining([
      expect.objectContaining({ id: 'skill:demo-skill' }),
    ]) });
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign sibling.\n');
  });

  it.each([['codex', false], ['claude', false], ['claude', true]] as const)('freezes %s unregistration after source loss and rejects drift=%s', async (platform, drift) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'lost-native-source');
    await directoryCatalog(sourceRoot, platform);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    const runtime = await nativeFixtureRuntime();
    const nativeCalls = vi.fn(runtime.nativeCliRunner!);
    runtime.nativeCliRunner = nativeCalls;
    const options = { cwd: isolation.layout.fixtureCwd, platform, scope: 'user' as const };
    const installed = await installWriteCommand(['team/demo'], options, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const installedPlan = installed.operationPlan!.deploymentPlans![0]!;
    const output = installedPlan.evidence.layout.packageRoot;
    await fs.remove(sourceRoot);
    const preparedArtifactRenderResults = new Map();
    const cleanupRuntime: RebuildCommandRuntime = { ...runtime, preparedArtifactRenderResults,
      catalogBootstrapError: new Error('Source cannot be read during cleanup.'),
      sharedReferenceView: { scopes: ['user', 'project'], projectRoot: options.cwd, desiredComplete: true,
        desired: [], observed: [{ pluginId: 'team/demo', sourceIdentity: installedPlan.binding.plugin.sourceIdentity,
          platform, scope: 'user', projectRoot: null, physicalKey: installedPlan.binding.physicalKey }],
        observations: (['user', 'project'] as const).map((scope) => ({ pluginId: 'team/demo',
          sourceIdentity: installedPlan.binding.plugin.sourceIdentity, platform, scope,
          projectRoot: scope === 'project' ? options.cwd : null, physicalKey: installedPlan.binding.physicalKey, complete: true })) } };
    try {
      const preview = await cleanupWriteCommand(['team/demo'], options, { ...cleanupRuntime, previewOperationPlan: true });
      expect(preview.operationPlan!.deploymentPlans, JSON.stringify(preview)).toHaveLength(1);
      expect(preview.operationPlan!.deploymentPlans![0]!.effects.map((effect) => effect.kind)).toContain('unregister');
      expect(await fs.pathExists(output)).toBe(true);
      const mutations = () => nativeCalls.mock.calls.filter(([call]) => call.args[0] === 'plugin' && call.args[1] !== 'list').length;
      const beforeMutations = mutations();
      if (drift) await fs.appendFile(path.join(output, 'skills/demo-skill/SKILL.md'), '\nChanged after Review.\n');
      const result = await cleanupWriteCommand(['team/demo'], options, { ...cleanupRuntime,
        expectedPlanFingerprint: preview.operationPlan!.planFingerprint, expectedOfflineCleanupEvidence: preview.offlineCleanupPlans![0] });
      if (drift) {
        expect(result.overallState, JSON.stringify(result)).toBe('failed');
        expect(await fs.pathExists(output)).toBe(true);
        expect(mutations()).toBe(beforeMutations);
      } else {
        expect(result.overallState, JSON.stringify(result)).toBe('succeeded');
        expect(await fs.pathExists(output)).toBe(false);
        expect(result.rebuildResults[0]!.deploymentReceipts?.some((receipt) => receipt.effects.some((effect) => effect.status === 'applied'))).toBe(true);
      }
    } finally { await disposePreparedPlatformRebuildSession(preparedArtifactRenderResults); }
  });

  it.each([['opencode', 'project', false], ['claude', 'user', false], ['opencode', 'project', true]] as const)(
    'retires removed Catalog entry through its real %s output at %s with drift=%s', async (platform, scope, drift) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = isolation.layout.fixtureCwd;
      const sourceRoot = path.join(cwd, 'retired-native-source');
      await directoryCatalog(sourceRoot, platform);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
      const runtime = await nativeFixtureRuntime();
      const installed = await installWriteCommand(['team/demo'], { cwd, platform, scope }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const output = installed.operationPlan!.deploymentPlans![0]!.evidence.layout.packageRoot;
      const location = { cwd, scope, env: runtime.env };
      await writeIntentFixture(location, { roots: [{ pluginId: 'team/demo', platforms: [platform] }] });
      const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
      await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [] });
      await fs.remove(path.join(sourceRoot, 'plugins/demo'));
      for (const relativePath of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
        const manifestPath = path.join(sourceRoot, relativePath);
        await fs.writeJson(manifestPath, { ...await fs.readJson(manifestPath), plugins: [] });
      }
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', impactConfirmed: true, cwd, env: runtime.env });
      const plan = await prepareRetire({ ...location, selector: 'team/demo', targets: [platform], yes: true }, runtime);
      expect(plan.evidence?.evidence.some((entry) => entry.platform === platform), JSON.stringify(plan.receipt)).toBe(true);
      expect(plan.plannedImpact.outputs).toBe(true);
      if (platform === 'claude') expect(plan.operationPlan!.deploymentPlans![0]!.effects.map((effect) => effect.kind)).toContain('unregister');
      if (drift) await fs.appendFile(path.join(output, 'skills/demo-skill/SKILL.md'), '\nChanged after Review.\n');
      const result = await executeRetire(plan, { yes: true });
      if (drift) {
        expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'operationReviewStale' }));
        expect((await readIntentFixture(location)).roots).toHaveLength(1);
        expect(await fs.pathExists(output)).toBe(true);
      } else {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect((await readIntentFixture(location)).roots).toEqual([]);
        expect(await fs.pathExists(output)).toBe(false);
      }
    },
  );

  it('serializes source identity mutation with first Native owner publication', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'race-source');
    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'race-replacement');
    await Promise.all([directoryCatalog(sourceRoot, 'opencode'), directoryCatalog(replacementRoot, 'opencode')]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const configured = await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    await writeIntentFixture({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, { roots: [{ pluginId: 'team/demo', platforms: ['opencode'] }] });
    const built = deferred(); const resume = deferred();
    setRebuildCommandTestHooksForTests({ afterTargetBuilt: async () => { built.resolve(); await resume.promise; } });
    let installing: ReturnType<typeof installWriteCommand> | undefined;
    let mutation: ReturnType<typeof updateCatalogSourceCommand> | undefined;
    try {
      installing = installWriteCommand(['team/demo'], { cwd: isolation.layout.fixtureCwd, platform: 'opencode', scope: 'project' }, await nativeFixtureRuntime());
      await Promise.race([built.promise, installing.then((value) => { throw new Error('Install ended before publication: '+JSON.stringify(value)); })]);
      let complete = false;
      mutation = updateCatalogSourceCommand({ sourceId: 'team', update: { type: 'path', path: replacementRoot }, cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env });
      void mutation.finally(() => { complete = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(complete).toBe(false);
      resume.resolve();
      await expect(installing).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(mutation).resolves.toMatchObject({ ok: true, changed: true, references: expect.arrayContaining([
        expect.objectContaining({ category: 'installation', pluginId: 'team/demo', scope: 'project' }),
      ]) });
      expect((await readCatalogSourcesConfigSnapshot(isolation.env)).digest).not.toBe(configured.digest);
    } finally {
      resume.resolve(); await Promise.allSettled([installing, mutation].filter((value) => value !== undefined));
      setRebuildCommandTestHooksForTests(undefined);
    }
  });
});
