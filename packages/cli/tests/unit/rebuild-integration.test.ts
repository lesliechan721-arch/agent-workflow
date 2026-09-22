import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  createRebuildIntegration,
  discoverRebuildTargetNames,
  inspectCodexSharedNativeLive,
  inspectRebuildTarget,
} from '../../src/commands/rebuild-integration.js';
import { projectTargetRevision, statusCommandV8 } from '../../src/commands/status-v6.js';
import {
  executeRebuildOperation,
} from '../../src/commands/rebuild-operations.js';
import { taskWriteCommand } from '../../src/commands/write-commands.js';
import { createCommandExecutionContext as createBaseCommandExecutionContext } from '../../src/commands/runtime.js';
import type { CatalogResolution, PluginMeta } from '../../src/types.js';
import {
  SYSTEM_CODEX_MANAGER,
  type NativeCliInvocation,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  OWNED_TEXT_HEADER_PREFIX,
  createSharedOwnerToken,
  inspectOwnedComponents,
  parseSharedOwnerToken,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  renderOwnedTextFile,
  SKILL_OWNER_MARKER,
  writeOwnedTextFile,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { preflightDesiredArtifactCollisions } from '../../src/utils/multi-source-catalog.js';
import {
  createAwPluginRequirementsReceipt,
  readPluginManifest as readRawPluginManifest,
} from '../../src/utils/manifest.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
} from '../../src/utils/paths.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
} from '../../src/utils/codex-config.js';
import { renderTrackedHookGroupIdentity } from '../../src/utils/hooks-contract.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import {
  calculateCodexNativeRenderPayloadDigest,
  calculateCodexSharedNativePayloadDigest,
} from '../../src/utils/catalog-digests.js';
import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  createCodexNativeRenderReceipt,
  parseCodexNativeRenderReceipt,
} from '../../src/utils/codex-native-render-receipt.js';
import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { createCodexSkillStagingTreeContentDigest } from '../../src/utils/codex-skill-staging.js';
import {
  AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH,
  readDynamicSkillTree,
} from '../../src/utils/dynamic-skill-tree.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEST_SOURCE_IDENTITY = `sha256:${'1'.repeat(64)}`;

async function readPluginManifest(
  ...args: Parameters<typeof readRawPluginManifest>
): Promise<PluginMeta> {
  const plugin = await readRawPluginManifest(...args);
  plugin.sourceId = 'team';
  plugin.sourceIdentity = TEST_SOURCE_IDENTITY;
  plugin.pluginId = `team/${plugin.manifest.name}`;
  return plugin;
}

function createCommandExecutionContext(
  options: Parameters<typeof createBaseCommandExecutionContext>[0],
) {
  return {
    ...createBaseCommandExecutionContext(options),
    codexManager: SYSTEM_CODEX_MANAGER,
  };
}

async function prewarmActiveMarketplace(catalogRoot: string, awHome: string): Promise<void> {
  await fs.ensureDir(path.dirname(awHome));
  await fs.copy(catalogRoot, awHome, { overwrite: true });
}

async function snapshotRegularTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        await visit(absolute);
      } else {
        snapshot[relative] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function createSyntheticCatalog(options: {
  root: string;
  pluginRoots: string[];
}): Promise<string> {
  const sourceRoot = path.join(options.root, `catalog-source-${crypto.randomUUID()}`);
  await fs.ensureDir(path.join(sourceRoot, 'plugins'));
  await fs.copy(
    path.join(repositoryRoot, 'plugins', 'marketplace-source.json'),
    path.join(sourceRoot, 'plugins', 'marketplace-source.json'),
  );
  for (const pluginRoot of options.pluginRoots) {
    await fs.copy(pluginRoot, path.join(sourceRoot, 'plugins', path.basename(pluginRoot)));
  }
  return createSyntheticEmbeddedRoot(sourceRoot);
}

async function writeClaudeNativeState(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  pluginVersion: string;
  scope: 'user' | 'project';
  installed: boolean;
  canonical?: boolean;
  declaredMarketplace?: boolean;
  materializedMarketplace?: boolean;
  includeEnabled?: boolean;
  enabledValue?: boolean | readonly string[];
}): Promise<void> {
  const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
  const awHome = options.env.AW_HOME!;
  const source = options.canonical === false ? path.join(path.dirname(awHome), 'foreign') : awHome;
  const sourceDescriptor = { source: 'directory', path: source };
  const projectPath = options.scope === 'project'
    ? await resolveClaudeProjectKey(options.cwd)
    : undefined;
  if (options.installed) {
    await fs.ensureDir(path.join(awHome, 'plugins', options.pluginName));
  }
  const includeEnabled = options.includeEnabled ?? options.installed;
  await fs.outputJson(paths.settingsPath, {
    ...(options.declaredMarketplace === false
      ? {}
      : { extraKnownMarketplaces: { aw: { source: sourceDescriptor } } }),
    ...(includeEnabled
      ? {
          enabledPlugins: {
            [`${options.pluginName}@aw`]: options.enabledValue ?? true,
          },
        }
      : {}),
  });
  await fs.outputJson(paths.knownMarketplacesPath, options.materializedMarketplace === false
    ? {}
    : {
        aw: {
          source: sourceDescriptor,
          installLocation: source,
          lastUpdated: new Date(0).toISOString(),
        },
      });
  await fs.outputJson(paths.installedPluginsPath, {
    plugins: options.installed ? {
      [`${options.pluginName}@aw`]: [{
        scope: options.scope,
        ...(projectPath ? { projectPath } : {}),
        version: options.pluginVersion,
      }],
    } : {},
  });
}

function createClaudeCleanupPlugin(root: string, name: string): PluginMeta {
  return {
    sourceId: 'team',
    sourceIdentity: TEST_SOURCE_IDENTITY,
    pluginId: `team/${name}`,
    rootDir: path.join(root, name),
    manifestPath: path.join(root, name, '.agents-plugin', 'plugin.json'),
    manifest: {
      name,
      version: '0.0.0',
      description: 'Claude cleanup fixture',
      schemaVersion: 3,
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    },
  };
}

async function createCodexSharedConfigPlugin(options: {
  root: string;
  name: string;
  hookCommand?: string;
  mcpServerKey?: string;
  roleKey?: string;
  roleInstructions?: string;
}): Promise<PluginMeta> {
  const pluginRoot = path.join(options.root, options.name);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const plugin = createClaudeCleanupPlugin(options.root, options.name);
  plugin.rootDir = pluginRoot;
  plugin.manifestPath = manifestPath;
  if (options.hookCommand) {
    plugin.manifest.extensions = {
      hooks: [{ event: 'session_start', command: options.hookCommand }],
    };
  }
  if (options.mcpServerKey) {
    plugin.manifest.mcpServers = './.mcp.json';
    await fs.outputJson(path.join(pluginRoot, '.mcp.json'), {
      mcpServers: {
        [options.mcpServerKey]: {
          command: 'node',
          args: [`${options.name}.mjs`],
        },
      },
    });
  }
  if (options.roleKey) {
    plugin.manifest.scripts = {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    };
    plugin.manifest.artifacts = {
      targets: [{
        id: 'shared-role',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.agentRole',
        states: ['present'],
        refreshKeys: [],
        roleKey: options.roleKey,
        requiresCodexProjectConfig: true,
      }],
    };
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "shared-role", kind: "codexRole", platform: "codex",',
      `  target: "codex.agentRole", state: "present", refreshKeys: [], roleKey: ${JSON.stringify(options.roleKey)},`,
      `  content: { registration: { description: ${JSON.stringify(options.name)} }, roleFile: {`,
      `    name: ${JSON.stringify(options.roleKey)}, description: ${JSON.stringify(options.name)},`,
      `    developer_instructions: ${JSON.stringify(options.roleInstructions ?? `Instructions for ${options.name}.`)}`,
      '  } }',
      '}] }));',
    ].join('\n'));
  }
  await fs.outputJson(manifestPath, plugin.manifest);
  return plugin;
}

async function writeClaudeGlobalConsumerState(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugins: Record<string, Array<{
    name: string;
    marketplace: string;
    scope: 'user' | 'project' | 'local';
    projectPath?: string;
    version: string;
  }>>;
}): Promise<void> {
  const paths = resolveClaudePaths(options.cwd, 'user', options.env);
  const sourceDescriptor = { source: 'directory', path: options.env.AW_HOME };
  await fs.outputJson(paths.settingsPath, {
    extraKnownMarketplaces: { aw: { source: sourceDescriptor } },
  });
  await fs.outputJson(paths.knownMarketplacesPath, {
    aw: {
      source: sourceDescriptor,
      installLocation: options.env.AW_HOME,
      lastUpdated: new Date(0).toISOString(),
    },
  });
  await fs.outputJson(paths.installedPluginsPath, { plugins: options.plugins });
}

describe('rebuild adapter integration', () => {
  it('uses official exact and neutral Codex list evidence for shared registration', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginName = 'list-evidence';
    const cacheRoot = path.join(
      isolation.layout.codexHomeDir, 'plugins', 'cache', 'aw', pluginName, '1.0.0',
    );
    await fs.outputJson(path.join(cacheRoot, 'plugin.json'), {
      name: pluginName, version: '1.0.0',
    });
    const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'official');
    const sourceRoot = path.join(marketplaceRoot, 'plugins', pluginName);
    await fs.outputJson(path.join(sourceRoot, 'plugin.json'), {
      name: pluginName, version: '1.0.0',
    });
    await fs.ensureDir(isolation.layout.awHomeDir);
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const calls: NativeCliInvocation[] = [];
    const inspected = await inspectCodexSharedNativeLive({
      pluginName,
      sourceId: 'official',
      desiredVersion: '1.0.0',
      expectedPayloadDigest: await calculateCodexSharedNativePayloadDigest(sourceRoot),
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      marketplaceRoot,
      nativeCliRunner: async (invocation) => {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: invocation.cwd === isolation.layout.fixtureCwd ? [{
              pluginId: `${pluginName}@aw`, installed: true,
              enabled: true,
              version: '1.0.0',
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      },
    });

    expect(inspected).toMatchObject({
      sharedNative: { state: 'usable', version: '1.0.0' },
    });
    expect(calls.map((call) => call.cwd)).toEqual(expect.arrayContaining([
      isolation.layout.fixtureCwd,
      expect.stringMatching(/aw-codex-observation-/u),
    ]));
    expect(calls.every((call) =>
      call.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
    await expect(fs.pathExists(calls.find((call) =>
      call.cwd !== isolation.layout.fixtureCwd)!.cwd!)).resolves.toBe(false);
  });

  it('blocks shared native inspection when exact and neutral Codex lists are unreadable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(isolation.layout.awHomeDir);
    const calls: NativeCliInvocation[] = [];
    const inspected = await inspectCodexSharedNativeLive({
      pluginName: 'unreadable-list',
      sourceId: 'official',
      desiredVersion: '1.0.0',
      expectedPayloadDigest: `sha256:${'1'.repeat(64)}`,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', 'official'),
      nativeCliRunner: async (invocation) => {
        calls.push(invocation);
        return { exitCode: 0, stdout: '{invalid', stderr: '' };
      },
    });

    expect(inspected).toMatchObject({
      sharedNative: {
        state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable',
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) =>
      call.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
  });

  it('fails closed when one Codex list succeeds and the other fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(isolation.layout.awHomeDir);
    const inspected = await inspectCodexSharedNativeLive({
      pluginName: 'degraded-list',
      sourceId: 'official',
      desiredVersion: '1.0.0',
      expectedPayloadDigest: `sha256:${'1'.repeat(64)}`,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', 'official'),
      nativeCliRunner: async (invocation) => invocation.cwd === isolation.layout.fixtureCwd
        ? { exitCode: 1, stdout: '', stderr: 'project unavailable' }
        : {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [{
                pluginId: 'degraded-list@aw', installed: true, enabled: true, version: '1.0.0',
              }],
              available: [],
            }),
            stderr: '',
          },
    });

    expect(inspected).toMatchObject({
      sharedNative: {
        state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable',
      },
    });
  });

  it.each([
    { observation: 'absent', officialEnabled: false, configEnabled: false, generic: 'absent', health: 'absent' },
    { observation: 'unobserved', officialEnabled: false, configEnabled: false, generic: 'partial', health: 'partial' },
    { observation: 'failed', officialEnabled: false, configEnabled: false, generic: 'error', health: 'error' },
    {
      observation: 'installed-user-enabled', officialEnabled: true, configEnabled: false,
      generic: 'present', health: 'partial',
    },
    {
      observation: 'installed-user-disabled', officialEnabled: false, configEnabled: true,
      generic: 'present', health: 'present',
    },
    {
      observation: 'exact-installed-neutral-absent', officialEnabled: true, configEnabled: false,
      generic: 'absent', health: 'absent',
    },
  ] as const)(
    'uses official $observation only for generic presence and public config for health',
    async ({ observation, officialEnabled, configEnabled, generic, health }) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(
          repositoryRoot,
          'packages/cli/tests/fixtures/codex-project-repo-managed/plugins/apps-only',
        )],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'apps-only'), {
        mode: 'bundle',
      });
      const pluginId = 'apps-only@aw';
      await applyCodexConfigTransactionFile(
        resolveCodexPaths(
          isolation.layout.fixtureCwd,
          'user',
          isolation.env,
        ).configTomlPath,
        { upsertPluginActivations: { [pluginId]: configEnabled } },
      );
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async (invocation) => {
            if (observation === 'unobserved') {
              throw Object.assign(new Error('missing Codex'), { code: 'ENOENT' });
            }
            if (observation === 'failed') {
              return { exitCode: 1, stdout: '', stderr: 'list failed' };
            }
            const exact = invocation.cwd === isolation.layout.fixtureCwd;
            const installed = observation.startsWith('installed')
              || observation === 'exact-installed-neutral-absent';
            const entries = installed
              && (observation !== 'exact-installed-neutral-absent' || exact)
              ? [{
                  pluginId,
                  installed: true,
                  enabled: officialEnabled,
                  version: plugin.manifest.version,
                }]
              : [];
            return {
              exitCode: 0,
              stdout: JSON.stringify({ installed: entries, available: [] }),
              stderr: '',
            };
          },
        }),
      });
      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
        readOnlyInspectionPlan: true,
      });
      const nativeComponent = target.ownedComponents.find((component) =>
        component.kind === 'native-plugin');
      expect(nativeComponent).toBeDefined();
      const genericInspection = await inspectOwnedComponents({
        components: [nativeComponent!],
        nativeProbe: integration.driver.probeNative,
      });
      const healthInspection = await inspectOwnedComponents({
        components: [nativeComponent!],
        nativeProbe: integration.driver.probeNativeHealth,
      });

      expect(genericInspection.state).toBe(generic);
      expect(healthInspection.state).toBe(health);
      if (observation === 'failed') {
        expect(genericInspection.errors[0]?.message).toContain('codexNativeObservationFailed');
        expect(healthInspection.errors[0]?.message).toContain('codexNativeObservationFailed');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'blocks an installed Codex plugin when its marketplace root is a symlink',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const pluginName = 'unsafe-marketplace';
      const marketplacesRoot = path.join(isolation.layout.awHomeDir, 'marketplaces');
      const marketplaceRoot = path.join(marketplacesRoot, 'official');
      const foreignRoot = path.join(isolation.layout.fixtureCwd, 'foreign-marketplace');
      await fs.ensureDir(foreignRoot);
      await fs.ensureDir(marketplacesRoot);
      await fs.symlink(foreignRoot, marketplaceRoot, 'dir');
      await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ].join('\n'));

      const inspected = await inspectCodexSharedNativeLive({
        pluginName,
        sourceId: 'official',
        desiredVersion: '1.0.0',
        inspectionMode: 'shallow',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        marketplaceRoot,
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{
              pluginId: `${pluginName}@aw`, installed: true, enabled: true, version: '1.0.0',
            }],
            available: [],
          }),
          stderr: '',
        }),
      });

      expect(inspected.sharedNative).toMatchObject({
        state: 'blocked', reason: 'foreign', diagnostic: 'marketplacePathUnsafe',
      });
    },
  );
  it.skipIf(process.platform === 'win32')(
    'blocks a Codex marketplace below a symlinked marketplaces ancestor',
    async () => {
      const isolation = getCurrentSourceTestIsolation();
      const pluginName = 'unsafe-marketplaces-ancestor';
      const marketplacesRoot = path.join(isolation.layout.awHomeDir, 'marketplaces');
      const foreignRoot = path.join(isolation.layout.fixtureCwd, 'foreign-marketplaces');
      const marketplaceRoot = path.join(marketplacesRoot, 'official');
      await fs.ensureDir(path.join(foreignRoot, 'official'));
      await fs.ensureDir(isolation.layout.awHomeDir);
      await fs.symlink(foreignRoot, marketplacesRoot, 'dir');

      const inspected = await inspectCodexSharedNativeLive({
        pluginName,
        sourceId: 'official',
        desiredVersion: '1.0.0',
        inspectionMode: 'shallow',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        marketplaceRoot,
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
          stderr: '',
        }),
      });

      expect(inspected.sharedNative).toEqual({
        state: 'blocked', reason: 'foreign', diagnostic: 'marketplacePathUnsafe',
      });
    },
  );
  it.each(['codex', 'claude'] as const)(
    'does not make an uninstalled %s target partial because the shared marketplace exists',
    async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      if (platform === 'codex') {
        await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
      } else {
        await fs.outputJson(path.join(
          isolation.layout.claudeHomeDir,
          'plugins',
          'known_marketplaces.json',
        ), { marketplaces: { aw: { installLocation: isolation.layout.awHomeDir } } });
      }
      const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'marketplace-only');
      plugin.manifest.marketplace.policy.products = [platform === 'codex' ? 'CODEX' : 'CLAUDE'];
      if (platform === 'codex') plugin.manifest.apps = './apps';
      const inspected = await inspectRebuildTarget({
        plugin,
        platform,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => ({
            exitCode: 0,
            stdout: JSON.stringify({ installed: [], available: [] }),
            stderr: '',
          }),
        }),
      });
      expect(inspected.inspection.state).toBe('absent');
    },
  );

  it('treats the same Claude plugin name in another marketplace as an independent consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'same-name');
    const paths = resolveClaudePaths(isolation.layout.fixtureCwd, 'user', isolation.env);
    const descriptor = { source: 'directory', path: isolation.layout.awHomeDir };
    await Promise.all([
      fs.outputJson(paths.settingsPath, {
        extraKnownMarketplaces: { aw: { source: descriptor } },
      }),
      fs.outputJson(paths.knownMarketplacesPath, {
        aw: { source: descriptor, installLocation: isolation.layout.awHomeDir },
      }),
      fs.outputJson(paths.installedPluginsPath, {
        plugins: {
          'same-name@other': [{
            name: 'same-name', marketplace: 'other', scope: 'user', version: '9.0.0',
          }],
        },
      }),
    ]);
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ installed: [], available: [] }),
          stderr: '',
        }),
      }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
    });
    const inspected = await inspectOwnedComponents({
      components: target.ownedComponents,
      nativeProbe: integration.driver.probeNative,
    });
    expect(inspected.components.find((entry) => entry.component.kind === 'native-plugin'))
      .toMatchObject({ state: 'absent' });
  });

  it('installs and rebuilds Codex static native Skills without exclusive owner markers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
    });
    const catalog = { rootDir: catalogRoot, source: 'local' } as CatalogResolution;
    await prewarmActiveMarketplace(catalog.rootDir, isolation.layout.awHomeDir);
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), {
      mode: 'bundle',
    });
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const cacheRoot = path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      plugin.manifest.name,
      plugin.manifest.version,
    );
    let marketplace = false;
    let installed = false;
    const writeConfig = async (): Promise<void> => {
      await fs.outputFile(configPath, [
        ...(marketplace ? [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
        ] : []),
        ...(installed ? [
          `[plugins."${plugin.manifest.name}@aw"]`,
          'enabled = true',
          '',
        ] : []),
      ].join('\n'));
    };
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
        marketplace = true;
        await writeConfig();
      } else if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
        marketplace = false;
        await writeConfig();
      } else if (invocation.args[1] === 'add') {
        installed = true;
        await fs.copy(
          path.join(isolation.layout.awHomeDir, 'plugins', plugin.manifest.name),
          cacheRoot,
          { overwrite: true },
        );
        await writeConfig();
      } else if (invocation.args[1] === 'remove') {
        installed = false;
        await fs.remove(path.dirname(cacheRoot));
        await writeConfig();
      }
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: `${plugin.manifest.name}@aw`, installed: true,
              enabled: true, version: plugin.manifest.version,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: `${plugin.manifest.name}@aw`, installed: true,
              enabled: true, version: plugin.manifest.version,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: invocation.args[1] === 'list' && installed
          ? `${plugin.manifest.name}@aw\n`
          : '',
        stderr: '',
      };
    };
    const context = createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner });
    const before = await inspectRebuildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      catalog,
      context,
    });
    expect(before.inspection.state).toBe('absent');

    const integration = createRebuildIntegration({ context });
    const build = (command: 'install' | 'reinstall' | 'cleanup') => integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command,
      catalog,
    });
    const installTarget = await build('install');
    const installedResult = await executeRebuildOperation({
      command: 'install',
      target: installTarget,
      driver: integration.driver,
    });
    expect(installedResult.status, JSON.stringify(installedResult.failures)).toBe('succeeded');

    const skillRoot = path.join(isolation.layout.awHomeDir, 'plugins', plugin.manifest.name,
      'codex', 'skills', 'decision-grill');
    const skillFile = path.join(skillRoot, 'SKILL.md');
    const original = await fs.readFile(skillFile, 'utf8');
    expect(original).not.toBe('');
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
    await fs.appendFile(skillFile, '\nlocal edit to rebuildable native content\n');

    const reinstallTarget = await build('reinstall');
    const reinstalledResult = await executeRebuildOperation({
      command: 'reinstall',
      target: reinstallTarget,
      driver: integration.driver,
    });
    expect(reinstalledResult.status, JSON.stringify(reinstalledResult.failures)).toBe('succeeded');
    await expect(fs.readFile(skillFile, 'utf8')).resolves.toBe(original);
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
  });

  it.each([
    ['codex', 'install'],
    ['codex', 'reinstall'],
    ['claude', 'install'],
    ['claude', 'reinstall'],
  ] as const)(
    'reports an absent %s target but fails %s on a foreign marketplace collision',
    async (platform, command) => {
      const isolation = getCurrentSourceTestIsolation();
      const foreignRoot = path.join(isolation.layout.rootDir, 'foreign-marketplace');
      if (platform === 'codex') {
        await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(foreignRoot)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
      } else {
        await fs.outputJson(path.join(
          isolation.layout.claudeHomeDir,
          'plugins',
          'known_marketplaces.json',
        ), { marketplaces: { aw: { installLocation: foreignRoot } } });
      }
      const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'foreign-marketplace-only');
      plugin.manifest.marketplace.policy.products = [platform === 'codex' ? 'CODEX' : 'CLAUDE'];
      if (platform === 'codex') plugin.manifest.apps = './apps';
      const calls: string[] = [];
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async (invocation) => {
            calls.push([invocation.command, ...invocation.args].join(' '));
            return {
              exitCode: 0,
              stdout: invocation.args.includes('--json')
                ? JSON.stringify({ installed: [], available: [] })
                : '',
              stderr: '',
            };
          },
        }),
      });
      const target = await integration.buildTarget({
        plugin,
        platform,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command,
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
      });
      const inspected = await inspectOwnedComponents({
        components: target.ownedComponents,
        executor: integration.driver.ownership,
        nativeProbe: integration.driver.probeNative,
      });
      expect(inspected.state).toBe('absent');
      const result = await executeRebuildOperation({
        command, target, driver: integration.driver,
      });
      expect(result.status).toBe('failed');
      expect(result.failures.some((failure) => failure.message.includes('foreign source'))).toBe(true);
      expect(calls.some((call) => call.includes('plugin marketplace add'))).toBe(false);
    },
  );

  it.each([
    { label: 'boolean true', includeEnabled: true, enabledValue: true, expected: 'present' },
    { label: 'boolean false', includeEnabled: true, enabledValue: false, expected: 'partial' },
    { label: 'string array', includeEnabled: true, enabledValue: ['^1.0.0'], expected: 'present' },
    { label: 'missing entry', includeEnabled: false, expected: 'partial' },
  ] as const)(
    'uses Claude enabledPlugins $label as native health truth',
    async ({ includeEnabled, enabledValue, expected }) => {
      const isolation = getCurrentSourceTestIsolation();
      const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'claude-enabled-health');
      plugin.manifest.version = '1.0.0';
      await writeClaudeNativeState({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        pluginName: plugin.manifest.name,
        pluginVersion: plugin.manifest.version,
        scope: 'user',
        installed: true,
        includeEnabled,
        ...(enabledValue === undefined ? {} : { enabledValue }),
      });
      const inspected = await inspectRebuildTarget({
        plugin,
        platform: 'claude',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }),
      });
      expect(inspected.inspection.state).toBe(expected);
    },
  );

  it.each([
    { label: 'declaration', declaredMarketplace: false },
    { label: 'materialized record', materializedMarketplace: false },
  ] as const)(
    'reports Claude native state as partial when the marketplace $label is missing',
    async ({ declaredMarketplace, materializedMarketplace }) => {
      const isolation = getCurrentSourceTestIsolation();
      const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'claude-marketplace-layers');
      plugin.manifest.version = '1.0.0';
      await writeClaudeNativeState({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        pluginName: plugin.manifest.name,
        pluginVersion: plugin.manifest.version,
        scope: 'user',
        installed: true,
        ...(declaredMarketplace === undefined ? {} : { declaredMarketplace }),
        ...(materializedMarketplace === undefined ? {} : { materializedMarketplace }),
      });
      const inspected = await inspectRebuildTarget({
        plugin,
        platform: 'claude',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }),
      });
      expect(inspected.inspection.state).toBe('partial');
    },
  );

  it.each(['codex', 'claude'] as const)(
    'keeps a validated stale %s native version healthy and reports revision evidence separately',
    async (platform) => {
      const isolation = getCurrentSourceTestIsolation();
      const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'stale-native-version');
      plugin.manifest.version = '2.0.0';
      plugin.manifest.marketplace.policy.products = [platform === 'codex' ? 'CODEX' : 'CLAUDE'];
      if (platform === 'codex') {
        plugin.manifest.apps = './apps';
        await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
          '[plugins."stale-native-version@aw"]',
          'enabled = true',
          '',
        ].join('\n'));
        await fs.outputJson(path.join(
          isolation.layout.codexHomeDir,
          'plugins',
          'cache',
          'aw',
          'stale-native-version',
          '1.0.0',
          '.codex-plugin',
          'plugin.json',
        ), { name: 'stale-native-version', version: '1.0.0' });
      } else {
        await writeClaudeNativeState({
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          pluginName: 'stale-native-version',
          pluginVersion: '1.0.0',
          scope: 'user',
          installed: true,
        });
      }
      const inspected = await inspectRebuildTarget({
        plugin,
        platform,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => ({
            exitCode: 0,
            stdout: platform === 'codex'
              ? JSON.stringify({
                  installed: [{
                    pluginId: 'stale-native-version@aw', installed: true,
                    enabled: true, version: '1.0.0',
                  }],
                  available: [],
                })
              : '',
            stderr: '',
          }),
        }),
      });
      expect(inspected.inspection.state).toBe('present');
      expect(inspected.installedVersion).toBe('1.0.0');
    },
  );

  it('uses the official Codex version and ignores private revision evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'revision-evidence');
    plugin.manifest.version = '2.0.0';
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.apps = './apps';
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      '[plugins."revision-evidence@aw"]',
      'enabled = true',
      '',
    ].join('\n'));
    const writeManifest = (version: string) => fs.outputJson(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      'revision-evidence',
      version,
      '.codex-plugin',
      'plugin.json',
    ), { name: 'revision-evidence', version });
    await Promise.all([writeManifest('1.0.0'), writeManifest('3.0.0')]);
    const inspect = () => inspectRebuildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{
              pluginId: 'revision-evidence@aw', installed: true,
              enabled: true, version: '2.0.0',
            }],
            available: [],
          }),
          stderr: '',
        }),
      }),
    });

    const ambiguous = await inspect();
    expect(ambiguous.inspection.state).toBe('present');
    expect(ambiguous.installedVersion).toBe('2.0.0');
    expect(projectTargetRevision(plugin.manifest.version, ambiguous.installedVersion))
      .toEqual({
        state: 'current',
        installedVersion: '2.0.0',
        availableVersion: '2.0.0',
      });

    await fs.outputJson(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'revision-evidence@aw',
      'manifest.json',
    ), { name: 'revision-evidence', version: '2.0.0' });
    const installed = await inspect();
    expect(installed.installedVersion).toBe('2.0.0');
    expect(projectTargetRevision(plugin.manifest.version, installed.installedVersion)).toEqual({
      state: 'current',
      availableVersion: '2.0.0',
      installedVersion: '2.0.0',
    });
  });

  it('rejects ambiguous Claude installed revision evidence for the matching scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'claude-revision-evidence');
    plugin.manifest.version = '2.0.0';
    await writeClaudeNativeState({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      pluginName: plugin.manifest.name,
      pluginVersion: '1.0.0',
      scope: 'user',
      installed: true,
    });
    const paths = resolveClaudePaths(isolation.layout.fixtureCwd, 'user', isolation.env);
    const installed = await fs.readJson(paths.installedPluginsPath) as {
      plugins: Record<string, Array<Record<string, unknown>>>;
    };
    installed.plugins[`${plugin.manifest.name}@aw`]!.push({
      scope: 'user',
      version: '3.0.0',
    });
    await fs.outputJson(paths.installedPluginsPath, installed);

    const inspected = await inspectRebuildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });

    expect(inspected.inspection.state).toBe('present');
    expect(inspected.installedVersion).toBeUndefined();
    expect(projectTargetRevision(plugin.manifest.version, inspected.installedVersion)).toEqual({
      state: 'unknown', availableVersion: '2.0.0',
    });
  });

  it('projects only lower strict SemVer evidence as an available upgrade', () => {
    expect(projectTargetRevision('2.0.0', '1.0.0')).toEqual({
      state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0',
    });
    expect(projectTargetRevision('2.0.0', '3.0.0')).toEqual({
      state: 'unknown', availableVersion: '2.0.0', installedVersion: '3.0.0',
    });
    expect(projectTargetRevision('2.0.0', 'not-semver')).toEqual({
      state: 'unknown', availableVersion: '2.0.0', installedVersion: 'not-semver',
    });
  });

  it('does not infer a revision for a non-native placement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'project-only-revision');
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    const inspected = await inspectRebuildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    expect(inspected.target.requiresNative).toBe(false);
    expect(inspected.installedVersion).toBeUndefined();
    expect(projectTargetRevision(plugin.manifest.version, inspected.installedVersion)).toEqual({
      state: 'unknown', availableVersion: plugin.manifest.version,
    });
  });

  it.each([
    { label: 'disabled', configEntry: 'enabled = false', discovered: true },
    { label: 'missing', configEntry: null, discovered: false },
  ])('does not promote Codex native residue with a $label config entry to installed', async ({
    configEntry,
    discovered,
  }) => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'disabled-native');
    plugin.manifest.version = '1.0.0';
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.apps = './apps';
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      ...(configEntry ? ['[plugins."disabled-native@aw"]', configEntry, ''] : []),
    ].join('\n'));
    await fs.outputJson(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      'disabled-native',
      '1.0.0',
      '.codex-plugin',
      'plugin.json',
    ), { name: 'disabled-native', version: '1.0.0' });
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ installed: [], available: [] }),
        stderr: '',
      }),
    });

    const inspected = await inspectRebuildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
      context,
    });
    expect(inspected.inspection.state).toBe('absent');
    const discoveredNames = await discoverRebuildTargetNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      nativeCliRunner: context.nativeCliRunner,
    });
    expect(discoveredNames.includes('disabled-native')).toBe(discovered);
  });
  it('plans Claude artifacts before writes and uses native marketplace/install/list ownership', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(isolation.layout.rootDir, 'simple-plugin');
    const pluginRoot = sourceRoot;
    await fs.ensureDir(pluginRoot);
    const plugin: PluginMeta = {
      sourceId: 'team',
      sourceIdentity: TEST_SOURCE_IDENTITY,
      pluginId: 'team/removed-plugin',
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'simple-plugin',
        version: '1.2.3',
        description: 'rebuild integration fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
            products: ['CLAUDE'],
          },
        },
        extensions: {
          instructions: [{
            name: 'rule',
            title: 'Rule',
            content: 'Use the rule.',
          }],
        },
      },
    };
    await fs.outputJson(plugin.manifestPath, plugin.manifest);
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [sourceRoot],
    });
    const bundledPlugin = await readPluginManifest(
      path.join(catalogRoot, 'plugins', plugin.manifest.name),
      { mode: 'bundle' },
    );
    let installed = false;
    const calls: string[] = [];
    const runner: NativeCliRunner = async (invocation) => {
      calls.push([invocation.command, ...invocation.args].join(' '));
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'install') {
        installed = true;
        await writeClaudeNativeState({
          cwd,
          env: isolation.env,
          pluginName: bundledPlugin.manifest.name,
          pluginVersion: bundledPlugin.manifest.version,
          scope: 'user',
          installed: true,
        });
      }
      return {
        exitCode: 0,
        stdout: invocation.args[1] === 'list' && installed ? 'simple-plugin@aw\n' : '',
        stderr: '',
      };
    };
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: runner,
    });
    const integration = createRebuildIntegration({ context });
    const catalog = { rootDir: catalogRoot, source: 'local' } as CatalogResolution;
    const target = await integration.buildTarget({
      plugin: bundledPlugin,
      platform: 'claude',
      scope: 'user',
      cwd,
      command: 'install',
      catalog,
    });
    expect(target.artifacts).toHaveLength(1);
    expect(await fs.pathExists(target.artifacts[0]!.path)).toBe(false);

    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
    });

    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain('claude plugin marketplace add ' + isolation.layout.awHomeDir + ' --scope user');
    expect(calls).toContain('claude plugin install simple-plugin@aw --scope user');
    expect(calls.filter((call) => call === 'claude plugin list')).toHaveLength(1);
    expect(await fs.readFile(target.artifacts[0]!.path, 'utf8')).toContain(OWNED_TEXT_HEADER_PREFIX);
  });

  it('cleans a removed-catalog Codex artifact by owner header and preserves foreign files', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const configDir = path.join(cwd, '.codex');
    const rulesDir = path.join(configDir, 'rules');
    const ownedPath = path.join(rulesDir, 'owned.rules');
    const foreignPath = path.join(rulesDir, 'foreign.rules');
    await fs.ensureDir(rulesDir);
    await writeOwnedTextFile({
      path: ownedPath,
      allowedRoot: rulesDir,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        pluginId: 'team/removed-plugin',
        plugin: 'removed-plugin',
        artifactKey: 'owned-rule',
        platform: 'codex',
        scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });
    await fs.writeFile(foreignPath, 'foreign\n');
    const plugin: PluginMeta = {
      sourceId: 'team',
      sourceIdentity: TEST_SOURCE_IDENTITY,
      pluginId: 'team/removed-plugin',
      rootDir: '.',
      manifestPath: '.agents-plugin/plugin.json',
      manifest: {
        name: 'removed-plugin',
        version: '0.0.0',
        description: 'cleanup-only target',
        schemaVersion: 3,
        marketplace: {
          category: 'cleanup',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    };
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => { throw new Error('project discovery must not call native CLI'); },
    });
    const integration = createRebuildIntegration({ context });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'cleanup',
      catalog: { rootDir: cwd, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup',
      target,
      driver: integration.driver,
    });

    expect(result).toMatchObject({ status: 'succeeded' });
    expect(await fs.pathExists(ownedPath)).toBe(false);
    expect(await fs.readFile(foreignPath, 'utf8')).toBe('foreign\n');
  });

  it('inspects absent, partial, and present ownership without writing target files', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const plugin: PluginMeta = {
      sourceId: 'team',
      sourceIdentity: TEST_SOURCE_IDENTITY,
      pluginId: 'team/read-only-plugin',
      rootDir: path.join(isolation.layout.rootDir, 'read-only-plugin'),
      manifestPath: path.join(isolation.layout.rootDir, 'read-only-plugin', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'read-only-plugin',
        version: '1.0.0',
        description: 'read-only inspection fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
            products: ['CLAUDE'],
          },
        },
        extensions: {
          instructions: [{ name: 'rule', title: 'Rule', content: 'Read only.' }],
        },
      },
    };
    let installed = false;
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.args[1] === 'list' && installed ? 'read-only-plugin@aw\n' : '',
        stderr: '',
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const configDir = isolation.layout.claudeHomeDir;
    const rulePath = path.join(configDir, 'rules', 'aw-read-only-plugin-rule.md');

    const absent = await inspectRebuildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd,
      catalog,
      context,
    });
    expect(absent.inspection.state).toBe('absent');
    expect(await fs.pathExists(configDir)).toBe(false);

    await fs.ensureDir(configDir);
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: configDir,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        pluginId: 'team/read-only-plugin',
        plugin: 'read-only-plugin',
        artifactKey: 'aw-read-only-plugin-rule',
        platform: 'claude',
        scope: 'user',
      },
      content: '# Rule\n\nRead only.\n',
    });
    const partial = await inspectRebuildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd,
      catalog,
      context,
    });
    expect(partial.inspection.state).toBe('partial');

    installed = true;
    await writeClaudeNativeState({
      cwd,
      env: isolation.env,
      pluginName: plugin.manifest.name,
      pluginVersion: plugin.manifest.version,
      scope: 'user',
      installed: true,
    });
    const before = await fs.readFile(rulePath, 'utf8');
    const beforeMtime = (await fs.stat(rulePath)).mtimeMs;
    const present = await inspectRebuildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd,
      catalog,
      context,
    });
    expect(present.inspection.state).toBe('present');
    expect(await fs.readFile(rulePath, 'utf8')).toBe(before);
    expect((await fs.stat(rulePath)).mtimeMs).toBe(beforeMtime);
  });

  it('uses a manifest-only inspection plan and never invokes the renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginRoot = path.join(isolation.layout.rootDir, 'renderer-read-only');
    const markerPath = path.join(cwd, 'renderer-was-called');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { writeFile } from "node:fs/promises";',
      `await writeFile(${JSON.stringify(markerPath)}, "called");`,
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));',
    ].join('\n'));
    const plugin = {
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'renderer-read-only',
        version: '1.0.0',
        description: 'renderer read-only fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        scripts: {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        },
        artifacts: {
          targets: [{
            id: 'dynamic-skill',
            platform: 'claude',
            scopes: ['user'],
            target: 'claude.skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'dynamic-skill',
          }],
        },
      },
    } as PluginMeta;
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    const before = await fs.readdir(cwd);
    const result = await inspectRebuildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      context,
    });

    expect(result.inspection.state).toBe('absent');
    expect(await fs.pathExists(markerPath)).toBe(false);
    expect(await fs.readdir(cwd)).toEqual(before);
  });

  it('inspects namespaced Codex native registration without exclusive Skill ownership', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
    const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('inspection must not call native CLI'); },
      }),
    });
    const target = await integration.buildTarget({
      sourceId: 'team',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginId: 'team/ask-me',
      marketplaceName: 'aw-team',
      marketplaceRoot,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' },
      readOnlyInspectionPlan: true,
    });
    expect(target.ownedComponents.some((component) => component.kind === 'skill-directory'))
      .toBe(false);
    expect(target.ownedComponents).toContainEqual(expect.objectContaining({
      kind: 'native-plugin', pluginId: 'ask-me@aw-team',
    }));
  });

  it('writes platform-specific product enums to namespaced marketplace manifests', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
    const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
    await fs.ensureDir(isolation.layout.awHomeDir);
    let installed = false;
    let listCalls = 0;
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        listCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: 'ask-me@aw-team', installed: true, enabled: true,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      expect(invocation).toMatchObject({
        command: 'codex',
        args: ['plugin', 'marketplace', 'add', marketplaceRoot],
      });
      const codexManifest = await fs.readJson(
        path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      ) as { plugins: Array<{ policy: { products?: string[] } }> };
      const claudeManifest = await fs.readJson(
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      ) as { plugins: Array<{ policy: { products?: string[] } }> };
      expect(codexManifest.plugins.map((entry) => entry.policy.products)).toEqual([['CODEX']]);
      expect(claudeManifest.plugins.map((entry) => entry.policy.products)).toEqual([['CLAUDE']]);
      installed = true;
      throw new Error('projection observed');
    };
    const observationSession = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: nativeCliRunner,
      manager: SYSTEM_CODEX_MANAGER,
    });
    const integration = createRebuildIntegration({
      context: {
        ...createCommandExecutionContext({ env: isolation.env, nativeCliRunner }),
        codexObservationSession: observationSession,
      },
    });
    const target = await integration.buildTarget({
      sourceId: 'team',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginId: 'team/ask-me',
      marketplaceName: 'aw-team',
      marketplaceRoot,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' },
    });

    try {
      await expect(integration.driver.writeNative(target)).rejects.toThrow('projection observed');
      await expect(observationSession.inspectPlugin({ pluginId: 'ask-me@aw-team' }))
        .resolves.toMatchObject({ observation: { state: 'observed', value: 'installed' } });
      expect(listCalls).toBe(3);
      await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
    } finally {
      await observationSession.dispose();
    }
  });

  it.each([
    ['failed', 'codexNativeObservationFailed'],
    ['unobserved', 'codexNativeObservationUnavailable'],
  ] as const)(
    'fails a Codex native write before Skill, mirror, or native mutations when the recheck is %s',
    async (observation, errorCode) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), {
        mode: 'bundle',
      });
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
      const calls: NativeCliInvocation[] = [];
      let drifted = false;
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async (invocation) => {
            calls.push(invocation);
            if (!drifted) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ installed: [], available: [] }),
                stderr: '',
              };
            }
            if (observation === 'unobserved') {
              throw Object.assign(new Error('Codex disappeared'), { code: 'ENOENT' });
            }
            return { exitCode: 1, stdout: '', stderr: 'list failed' };
          },
        }),
      });
      const target = await integration.buildTarget({
        sourceId: 'team',
        sourceIdentity: TEST_SOURCE_IDENTITY,
        pluginId: 'team/ask-me',
        marketplaceName: 'aw-team',
        marketplaceRoot,
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
      });
      const skillPaths = target.operationActions?.flatMap((action) =>
        action.kind === 'writeOwnedArtifact' && action.artifactKind === 'skill-directory'
          ? [action.path]
          : []) ?? [];
      const nativeComponent = target.ownedComponents.find((component) =>
        component.kind === 'native-plugin');
      expect(await inspectOwnedComponents({
        components: [nativeComponent!],
        nativeProbe: integration.driver.probeNative,
      })).toMatchObject({ state: 'absent' });
      drifted = true;

      await expect(integration.driver.writeNative(target)).rejects.toThrow(errorCode);
      expect(calls).toHaveLength(3);
      expect(calls.every((invocation) =>
        invocation.args.slice(-5).join(' ') === 'plugin list --marketplace aw-team --json')).toBe(true);
      await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(false);
      for (const skillPath of skillPaths) {
        await expect(fs.pathExists(skillPath)).resolves.toBe(false);
      }
    },
  );

  it.each(['EACCES', 'EIO'] as const)(
    'fails a namespaced marketplace mirror on destination %s before replacing the old root',
    async (errorCode) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
      const sourceIdentity = `sha256:${'1'.repeat(64)}`;
      const sentinelPath = path.join(marketplaceRoot, 'plugins', 'retained', 'sentinel.txt');
      await Promise.all([
        fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
          schemaVersion: 2,
          sourceId: 'team',
          sourceIdentity,
          marketplaceName: 'aw-team',
        }),
        fs.outputFile(sentinelPath, 'retained\n'),
      ]);
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ installed: [], available: [] }),
            stderr: '',
          };
        }
        throw new Error('native mutation must not run');
      });
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner }),
      });
      const target = await integration.buildTarget({
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/ask-me',
        marketplaceName: 'aw-team',
        marketplaceRoot,
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
      });
      const realLstat = fs.lstat.bind(fs);
      const lstat = vi.spyOn(fs, 'lstat').mockImplementation((async (location) => {
        if (path.resolve(String(location)) === path.resolve(marketplaceRoot)) {
          throw Object.assign(new Error(`${errorCode} destination read failed`), { code: errorCode });
        }
        return realLstat(location);
      }) as typeof fs.lstat);
      try {
        await expect(integration.driver.writeNative(target))
          .rejects.toThrow(`${errorCode} destination read failed`);
      } finally {
        lstat.mockRestore();
      }
      expect(nativeCliRunner).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe('retained\n');
    },
  );

  it('keeps the committed marketplace generation when the native mutation fails', async () => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
      const sourceIdentity = `sha256:${'1'.repeat(64)}`;
      await fs.copy(catalogRoot, marketplaceRoot);
      await Promise.all([
        fs.writeJson(path.join(marketplaceRoot, 'config.json'), {
          schemaVersion: 2,
          sourceId: 'team',
          sourceIdentity,
          marketplaceName: 'aw-team',
        }),
        ...[
          path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
          path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        ].map(async (manifestPath) => {
          const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
          await fs.writeJson(manifestPath, { ...manifest, name: 'aw-team' });
        }),
        fs.outputFile(path.join(marketplaceRoot, 'old-generation.txt'), 'old\n'),
      ]);
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async (invocation) => {
            if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ installed: [], available: [] }),
                stderr: '',
              };
            }
            throw new Error('native install failed');
          },
        }),
      });
      const target = await integration.buildTarget({
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/ask-me',
        marketplaceName: 'aw-team',
        marketplaceRoot,
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
      });
      await expect(integration.driver.writeNative(target)).rejects.toThrow('native install failed');
      await expect(fs.lstat(marketplaceRoot)).resolves.toMatchObject({});
      await expect(fs.pathExists(path.join(marketplaceRoot, 'old-generation.txt'))).resolves.toBe(false);
      expect((await fs.readdir(path.dirname(marketplaceRoot))).filter((entry) =>
        entry.startsWith('team.backup-'))).toEqual([]);
  });

  it.each(['EPERM', 'EBUSY'] as const)(
    'restores the old marketplace after staging move failure without a pathExists %s probe',
    async (errorCode) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
      const sourceIdentity = `sha256:${'2'.repeat(64)}`;
      await fs.copy(catalogRoot, marketplaceRoot);
      await Promise.all([
        fs.writeJson(path.join(marketplaceRoot, 'config.json'), {
          schemaVersion: 2,
          sourceId: 'team',
          sourceIdentity,
          marketplaceName: 'aw-team',
        }),
        ...[
          path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
          path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
        ].map(async (manifestPath) => {
          const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
          await fs.writeJson(manifestPath, { ...manifest, name: 'aw-team' });
        }),
        fs.outputFile(path.join(marketplaceRoot, 'old-generation.txt'), 'old\n'),
      ]);
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async (invocation) => {
            if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({ installed: [], available: [] }),
                stderr: '',
              };
            }
            throw new Error('native runner must not run');
          },
        }),
      });
      const target = await integration.buildTarget({
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/ask-me',
        marketplaceName: 'aw-team',
        marketplaceRoot,
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
      });
      const realMove = fs.move.bind(fs);
      const move = vi.spyOn(fs, 'move').mockImplementation(async (source, destination, options) => {
        if (path.basename(String(source)).startsWith('.team-staging-')
          && path.resolve(String(destination)) === path.resolve(marketplaceRoot)) {
          throw Object.assign(new Error('staging move failed'), { code: 'EIO' });
        }
        return realMove(source, destination, options);
      });
      const realPathExists = fs.pathExists.bind(fs);
      const pathExists = vi.spyOn(fs, 'pathExists').mockImplementation(async (candidate) => {
        if (path.resolve(String(candidate)) === path.resolve(marketplaceRoot)
          || path.basename(String(candidate)).startsWith('team.backup-')) {
          throw Object.assign(new Error(`${errorCode} pathExists probe`), { code: errorCode });
        }
        return realPathExists(candidate);
      });
      await expect(integration.driver.writeNative(target)).rejects.toMatchObject({ code: 'EIO' });
      move.mockRestore();
      pathExists.mockRestore();

      await expect(fs.readFile(path.join(marketplaceRoot, 'old-generation.txt'), 'utf8'))
        .resolves.toBe('old\n');
      expect((await fs.readdir(path.dirname(marketplaceRoot))).filter((entry) =>
        entry.startsWith('team.backup-'))).toEqual([]);
    },
  );

  it.each([
    ['EACCES', 'plugins'],
    ['EIO', 'skills'],
  ] as const)(
    'fails closed when the namespaced marketplace %s %s directory cannot be read',
    async (errorCode, directoryKind) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
      const marketplaceParent = path.dirname(marketplaceRoot);
      const sourceIdentity = `sha256:${'1'.repeat(64)}`;
      await Promise.all([
        ...['.agents', '.claude-plugin', 'plugins'].map((entry) =>
          fs.copy(path.join(catalogRoot, entry), path.join(marketplaceRoot, entry))),
        fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
          schemaVersion: 2,
          sourceId: 'team',
          sourceIdentity,
          marketplaceName: 'aw-team',
        }),
      ]);
      for (const manifestPath of [
        path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      ]) {
        const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
        await fs.writeJson(manifestPath, { ...manifest, name: 'aw-team' }, { spaces: 2 });
      }
      const sentinelPath = path.join(marketplaceRoot, 'generation.txt');
      await fs.outputFile(sentinelPath, 'old-generation\n');
      const platformManifest = await fs.readJson(
        path.join(marketplaceRoot, 'plugins', 'ask-me', '.codex-plugin', 'plugin.json'),
      ) as { skills: string };
      const skillsRoot = path.resolve(
        path.join(marketplaceRoot, 'plugins', 'ask-me'),
        platformManifest.skills,
      );
      const skillKey = (await fs.readdir(skillsRoot))[0]!;
      const overlayRoot = path.join(skillsRoot, skillKey);
      await fs.outputFile(path.join(overlayRoot, 'SKILL.md'), 'owned-overlay\n');
      await writeSkillOwnerMarker({
        skillRoot: overlayRoot,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: 'team',
          sourceIdentity,
          pluginId: 'team/ask-me',
          plugin: 'ask-me',
          artifactKey: skillKey,
          platform: 'codex',
          scope: 'user',
        },
      });
      const oldRootSnapshot = await snapshotRegularTree(marketplaceRoot);

      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ installed: [], available: [] }),
            stderr: '',
          };
        }
        throw new Error('native mutation must not run');
      });
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner }),
      });
      const target = await integration.buildTarget({
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/ask-me',
        marketplaceName: 'aw-team',
        marketplaceRoot,
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
      });
      const unreadableRoot = directoryKind === 'plugins'
        ? path.join(marketplaceRoot, 'plugins')
        : path.join(marketplaceRoot, 'plugins', 'ask-me', 'codex', 'skills');
      const realReaddir = fs.readdir.bind(fs);
      const readdir = vi.spyOn(fs, 'readdir').mockImplementation((async (location, options) => {
        if (path.resolve(String(location)) === path.resolve(unreadableRoot)) {
          throw Object.assign(
            new Error(`${errorCode}: cannot read ${marketplaceRoot}`),
            { code: errorCode },
          );
        }
        return realReaddir(location, options as never);
      }) as typeof fs.readdir);
      let failure: Error | undefined;
      try {
        await integration.driver.writeNative(target);
      } catch (error) {
        failure = error as Error;
      } finally {
        readdir.mockRestore();
      }

      expect(failure?.message).toContain('marketplaceOverlayReadFailed');
      expect(failure?.message).toContain(errorCode);
      expect(failure?.message).not.toContain(isolation.layout.awHomeDir);
      expect(failure?.message).not.toContain(marketplaceRoot);
      expect(nativeCliRunner).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe('old-generation\n');
      expect(await snapshotRegularTree(marketplaceRoot)).toEqual(oldRootSnapshot);
      await expect(readSkillOwnerMarker({
        skillRoot: overlayRoot,
        allowedRoot: skillsRoot,
      })).resolves.toMatchObject({ sourceId: 'team', pluginId: 'team/ask-me' });
      expect((await fs.readdir(marketplaceParent)).filter((entry) => entry.startsWith('.team-'))).toEqual([]);
      expect((await fs.readdir(marketplaceParent)).filter((entry) => entry.startsWith('team.backup-'))).toEqual([]);
    },
  );

  it('classifies present-or-disabled artifacts as optional without invoking the renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = {
      rootDir: path.join(isolation.layout.rootDir, 'optional-plan'),
      manifestPath: path.join(isolation.layout.rootDir, 'optional-plan', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'optional-plan',
        version: '1.0.0',
        description: 'optional planner fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        artifacts: {
          targets: [
            {
              id: 'optional-skill',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.skill',
              delivery: { mode: 'aw-extension' },
              states: ['present', 'disabled'],
              refreshKeys: [],
              skillKey: 'optional-skill',
            },
            {
              id: 'optional-role',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.agentRole',
              states: ['present', 'disabled'],
              refreshKeys: [],
              roleKey: 'optional-role',
              requiresCodexProjectConfig: true,
            },
            {
              id: 'optional-instruction',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.developerInstructionsBlock',
              states: ['present', 'disabled'],
              refreshKeys: [],
              requiresCodexProjectConfig: true,
            },
            {
              id: 'disabled-only',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.skill',
              delivery: { mode: 'aw-extension' },
              states: ['disabled'],
              refreshKeys: [],
              skillKey: 'disabled-only',
            },
            {
              id: 'disabled-instruction',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.developerInstructionsBlock',
              states: ['disabled'],
              refreshKeys: [],
              requiresCodexProjectConfig: true,
            },
          ],
        },
      },
    } as PluginMeta;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('inspection must not call native CLI'); },
      }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      readOnlyInspectionPlan: true,
    });
    expect(target.desiredOwnedComponents).toEqual([]);
    expect(target.optionalOwnedComponents?.map((component) => component.identity.artifactKey))
      .toEqual(expect.arrayContaining(['optional-skill', 'optional-role', 'developer-instructions']));
    expect(target.optionalOwnedComponents?.map((component) => component.identity.artifactKey))
      .not.toContain('disabled-only');
  });

  it.each(['project', 'user'] as const)(
    'keeps native dynamic Skill materialization out of %s AW direct planning',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const pluginRoot = path.join(isolation.layout.rootDir, `native-dynamic-${scope}`);
      const rendererMarker = path.join(pluginRoot, 'renderer-ran');
      const plugin = {
        sourceId: 'team',
        sourceIdentity: TEST_SOURCE_IDENTITY,
        pluginId: `team/native-dynamic-${scope}`,
        rootDir: pluginRoot,
        manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
        manifest: {
          name: `native-dynamic-${scope}`,
          version: '1.0.0',
          description: 'Native dynamic materialization fixture.',
          schemaVersion: 3,
          marketplace: {
            category: 'test',
            strict: true,
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          },
          config: {
            fields: { mode: { type: 'string' } },
          },
          scripts: {
            artifacts: { render: { runner: 'node', path: './render.mjs' } },
          },
          artifacts: {
            targets: [{
              id: 'native-skill',
              platform: 'codex',
              target: 'codex.skill',
              delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
              scopes: [scope],
              states: ['present'],
              refreshKeys: ['mode'],
              skillKey: 'native-skill',
            }],
          },
        },
      } as PluginMeta;
      await fs.outputFile(plugin.manifestPath, `${JSON.stringify(plugin.manifest)}\n`);
      await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(rendererMarker)}, 'ran');`,
        "console.log(JSON.stringify({ version: 2, artifacts: [] }));",
      ].join('\n'));
      if (scope === 'project') {
        await fs.outputFile(path.join(
          isolation.layout.fixtureCwd,
          '.agent-workflows',
          'plugin-config',
          'team',
          plugin.manifest.name,
          'config.json',
        ), '{invalid project config');
      }
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => ({
        exitCode: 0,
        stdout: invocation.args.includes('--version')
          ? 'codex-cli 0.200.0'
          : invocation.args.includes('--json') ? '{"installed":[],"available":[]}' : '',
        stderr: '',
      }));
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner,
        }),
      });

      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope,
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      });
      expect(target.requiresNative).toBe(true);
      expect(target.artifacts.some((artifact) =>
        artifact.target === 'codex.skill' && artifact.artifactKey === 'native-skill')).toBe(false);
      expect(target.desiredOwnedComponents?.some((component) =>
        component.kind === 'skill-directory'
        && component.identity.artifactKey === 'native-skill')).toBe(false);
      expect(await fs.pathExists(rendererMarker)).toBe(false);
      expect(await fs.pathExists(scope === 'project'
        ? path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'native-skill')
        : path.join(isolation.layout.codexHomeDir, 'skills', 'native-skill'))).toBe(false);

      const userSkillsRoot = path.join(isolation.layout.codexHomeDir, 'skills');
      const projectSkillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
      const oppositeScope = scope === 'project' ? 'user' : 'project';
      const oppositeSkillsRoot = oppositeScope === 'user' ? userSkillsRoot : projectSkillsRoot;
      const oppositeLegacySkillRoot = path.join(oppositeSkillsRoot, 'native-skill');
      await fs.outputFile(path.join(oppositeLegacySkillRoot, 'SKILL.md'), 'legacy owned\n');
      await writeSkillOwnerMarker({
        skillRoot: oppositeLegacySkillRoot,
        allowedRoot: oppositeSkillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: 'team',
          pluginId: plugin.pluginId!,
          plugin: plugin.manifest.name,
          artifactKey: 'native-skill',
          platform: 'codex',
          scope: oppositeScope,
        },
      });
      const failedBeforeCleanup = await executeRebuildOperation({
        command: 'install',
        target,
        driver: integration.driver,
      });
      expect(failedBeforeCleanup.status).toBe('failed');
      await expect(fs.pathExists(oppositeLegacySkillRoot)).resolves.toBe(true);

      const userLegacySkillRoot = path.join(userSkillsRoot, 'native-skill');
      const projectLegacySkillRoot = path.join(projectSkillsRoot, 'native-skill');
      const userForeignPath = path.join(userLegacySkillRoot, 'user-foreign.txt');
      const projectForeignPath = path.join(projectLegacySkillRoot, 'project-foreign.txt');
      await fs.outputFile(userForeignPath, 'user foreign\n');
      await fs.outputFile(projectForeignPath, 'project foreign\n');
      nativeCliRunner.mockClear();
      const blocked = await executeRebuildOperation({
        command: 'install',
        target,
        driver: integration.driver,
      });
      expect(blocked).toMatchObject({
        status: 'failed',
        error: { phase: 'preflight.inspect' },
      });
      await expect(fs.readFile(userForeignPath, 'utf8')).resolves.toBe('user foreign\n');
      await expect(fs.readFile(projectForeignPath, 'utf8')).resolves.toBe('project foreign\n');
      expect(nativeCliRunner.mock.calls.some(([invocation]) =>
        invocation.args.includes('add') || invocation.args.includes('remove'))).toBe(false);

      const inspection = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope,
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
        readOnlyInspectionPlan: true,
      });
      expect(inspection.artifacts.some((artifact) =>
        artifact.target === 'codex.skill' && artifact.artifactKey === 'native-skill')).toBe(false);
      expect(inspection.desiredOwnedComponents?.some((component) =>
        component.kind === 'skill-directory'
        && component.identity.artifactKey === 'native-skill')).toBe(false);
    },
  );

  it('renders mixed Skill and sensitive non-Skill targets in exact isolated batches', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginRoot = path.join(isolation.layout.rootDir, 'mixed-sensitive-batches');
    const callsPath = path.join(pluginRoot, 'renderer-calls.jsonl');
    const plugin = {
      sourceId: 'team',
      sourceIdentity: TEST_SOURCE_IDENTITY,
      pluginId: 'team/mixed-sensitive-batches',
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'mixed-sensitive-batches',
        version: '1.0.0',
        description: 'Mixed sensitive request fixture.',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        config: { fields: { token: { type: 'string', sensitive: true } } },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
        artifacts: { targets: [
          {
            id: 'safe-skill', platform: 'codex', target: 'codex.skill',
            delivery: { mode: 'aw-extension' }, scopes: ['user'], states: ['present'],
            refreshKeys: [], skillKey: 'safe-skill',
          },
          {
            id: 'sensitive-role', platform: 'codex', target: 'codex.agentRole',
            scopes: ['user'], states: ['present'], refreshKeys: ['token'], roleKey: 'sensitive-role',
          },
        ] },
      },
    } as PluginMeta;
    await fs.outputJson(plugin.manifestPath, plugin.manifest);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ ids: context.requestedArtifactIds, config: context.config.values, previousArtifacts: context.previousArtifacts }) + "\\n");`,
      'const artifacts = context.requestedArtifactIds.map((id) => id === "safe-skill" ? {',
      '  id, kind: "skill", platform: "codex", target: "codex.skill", state: "present",',
      '  skillKey: "safe-skill", refreshKeys: [], content: { files: {',
      '    "SKILL.md": "---\\nname: safe-skill\\ndescription: Safe Skill.\\n---\\nBody.\\n",',
      '    "README.md": "# Safe Skill\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } }',
      '} : {',
      '  id, kind: "codexRole", platform: "codex", target: "codex.agentRole", state: "present",',
      '  roleKey: "sensitive-role", refreshKeys: ["token"], content: { roleFile: {',
      '    name: "sensitive-role", developer_instructions: "Use a derived credential reference."',
      '  }, registration: { description: "Sensitive role." } }',
      '});',
      'console.log(JSON.stringify({ version: 2, artifacts }));',
    ].join('\n'));
    await writePluginConfigStore({
      sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity,
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { token: 'mixed-sensitive-secret' },
    });
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('AW-delivered artifacts must not call native CLI'); },
      }),
    });

    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const calls = (await fs.readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

    expect(calls).toEqual([
      { ids: ['safe-skill'], config: {}, previousArtifacts: [] },
      {
        ids: ['sensitive-role'],
        config: { token: 'mixed-sensitive-secret' },
        previousArtifacts: [],
      },
    ]);
    expect(target.artifacts.map((artifact) => artifact.target))
      .toEqual(expect.arrayContaining(['codex.skill', 'codex.agentRole']));
  });

  it.each([
    { platform: 'claude' as const, delivery: 'direct' as const, leak: 'path' as const },
    { platform: 'claude' as const, delivery: 'direct' as const, leak: 'content' as const },
    { platform: 'codex' as const, delivery: 'direct' as const, leak: 'path' as const },
    { platform: 'codex' as const, delivery: 'direct' as const, leak: 'content' as const },
  ])(
    'rejects sensitive config in $platform $delivery dynamic Skill sourceDirs $leak before writing',
    async ({ platform, delivery, leak }) => {
      const isolation = getCurrentSourceTestIsolation();
      const name = `sensitive-${platform}-${delivery}-${leak}`;
      const secret = `${name}-secret`;
      const sourcePluginRoot = path.join(isolation.layout.rootDir, `${name}-source`);
      const targetName = `${platform}.skill`;
      const manifest = {
        name,
        version: '1.0.0',
        description: 'Sensitive final Skill tree fixture.',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
            ...(delivery === 'native' ? { products: ['CODEX'] } : {}),
          },
        },
        config: { fields: { token: { type: 'string', sensitive: true } } },
        scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
        artifacts: { targets: [{
          id: 'dynamic-skill',
          platform,
          target: targetName,
          ...(delivery === 'native'
            ? { delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' } }
            : platform === 'codex' ? { delivery: { mode: 'aw-extension' } } : {}),
          scopes: ['user'],
          states: ['present'],
          refreshKeys: [],
          skillKey: 'dynamic-skill',
          sourceDirs: ['./skills/dynamic-skill'],
        }] },
      } as const;
      await fs.outputJson(path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'), manifest);
      await fs.outputFile(
        path.join(sourcePluginRoot, 'skills', 'dynamic-skill', 'SKILL.md'),
        '---\nname: dynamic-skill\ndescription: Test.\n---\n',
      );
      await fs.outputFile(
        path.join(sourcePluginRoot, 'skills', 'dynamic-skill', 'README.md'),
        '# Dynamic Skill\n',
      );
      await fs.outputFile(
        path.join(sourcePluginRoot, 'skills', 'dynamic-skill', 'agents', 'openai.yaml'),
        [
          'interface:',
          '  display_name: "Dynamic Skill"',
          '  short_description: "Test dynamic Skill"',
          '  default_prompt: "Use $dynamic-skill."',
          'policy:',
          '  allow_implicit_invocation: true',
        ].join('\n'),
      );
      const leakedRelativePath = leak === 'path'
        ? `references/${secret}.txt`
        : 'references/leak.txt';
      await fs.outputFile(
        path.join(sourcePluginRoot, 'skills', 'dynamic-skill', leakedRelativePath),
        leak === 'content' ? secret : 'Safe content.',
      );
      await fs.outputFile(path.join(sourcePluginRoot, 'scripts', 'render.mjs'), [
        'console.log(JSON.stringify({ version: 2, artifacts: [{',
        `  id: 'dynamic-skill', kind: 'skill', platform: ${JSON.stringify(platform)},`,
        `  target: ${JSON.stringify(targetName)}, state: 'present', skillKey: 'dynamic-skill',`,
        '  refreshKeys: [], content: { files: {} },',
        '}] }));',
      ].join('\n'));
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [sourcePluginRoot],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', name), {
        mode: 'bundle',
      });
      await writePluginConfigStore({
        sourceId: plugin.sourceId,
        sourceIdentity: plugin.sourceIdentity,
        logicalIdentity: plugin.catalogLogicalIdentity,
        pluginName: name,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        values: { token: secret },
      });
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => ({
        exitCode: 0,
        stdout: invocation.args.includes('--version')
          ? 'codex-cli 0.151.0'
          : invocation.args.includes('--json') ? '{"installed":[],"available":[]}' : '',
        stderr: '',
      }));
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner }),
      });
      const build = () => integration.buildTarget({
        plugin,
        platform,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });

      let failure: unknown;
      if (delivery === 'native') {
        const target = await build();
        const result = await executeRebuildOperation({
          command: 'install', target, driver: integration.driver,
        });
        expect(result.status).toBe('failed');
        failure = result.failures[0]?.message;
      } else {
        failure = await build().then(() => undefined, (error: unknown) => error);
      }
      expect(String(failure)).toContain('artifactRendererSensitiveConfigExposed');
      expect(String(failure)).not.toContain(secret);
      expect(String(failure)).not.toContain(leakedRelativePath);
      const outputRoot = platform === 'claude'
        ? path.join(isolation.layout.claudeHomeDir, 'skills', 'dynamic-skill')
        : delivery === 'native'
          ? path.join(
              isolation.layout.awHomeDir,
              'plugins',
              name,
              'codex',
              'skills',
              'dynamic-skill',
              leakedRelativePath,
            )
          : path.join(isolation.layout.codexHomeDir, 'skills', 'dynamic-skill');
      await expect(fs.pathExists(outputRoot)).resolves.toBe(false);
    },
  );

  it('does not call native list during Claude owner discovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rulePath = path.join(isolation.layout.claudeHomeDir, 'rules', 'owned.md');
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: isolation.layout.claudeHomeDir,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        pluginId: 'team/owner-only',
        plugin: 'owner-only',
        artifactKey: 'owned',
        platform: 'claude',
        scope: 'user',
      },
      content: 'owned\n',
    });
    const failingRunner: NativeCliRunner = async () => {
      throw new Error('claude missing');
    };
    await expect(discoverRebuildTargetNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'claude',
      scope: 'user',
      nativeCliRunner: failingRunner,
      nativeFailureMode: 'ignore',
    })).resolves.toContain('owner-only');
    await expect(discoverRebuildTargetNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'claude',
      scope: 'user',
      nativeCliRunner: failingRunner,
      nativeFailureMode: 'error',
    })).resolves.toContain('owner-only');
  });

  it('uses validated Claude project native records and ignores list ghosts', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const calls: string[] = [];
    await writeClaudeNativeState({
      cwd,
      env: isolation.env,
      pluginName: 'project-native',
      pluginVersion: '1.0.0',
      scope: 'project',
      installed: true,
    });
    await expect(discoverRebuildTargetNames({
      cwd,
      env: isolation.env,
      platform: 'claude',
      scope: 'project',
      nativeCliRunner: async (invocation) => {
        calls.push([invocation.command, ...invocation.args].join(' '));
        return { exitCode: 0, stdout: 'ghost-native@aw\n', stderr: 'warning-native@aw' };
      },
      nativeFailureMode: 'error',
    })).resolves.toContain('project-native');
    expect(calls).toEqual([]);
    await fs.outputJson(
      resolveClaudePaths(cwd, 'project', isolation.env).installedPluginsPath,
      { plugins: {} },
    );
    await expect(discoverRebuildTargetNames({
      cwd,
      env: isolation.env,
      platform: 'claude',
      scope: 'project',
      nativeCliRunner: async () => ({
        exitCode: 0, stdout: 'settings-only-ghost@aw\n', stderr: 'warning-ghost@aw',
      }),
      nativeFailureMode: 'error',
    })).resolves.toContain('project-native');

    const rulePath = path.join(cwd, '.claude', 'rules', 'owner.md');
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: path.join(cwd, '.claude'),
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        pluginId: 'team/project-owner',
        plugin: 'project-owner',
        artifactKey: 'owner-rule',
        platform: 'claude',
        scope: 'project',
      },
      content: 'owner\n',
    });
    await expect(discoverRebuildTargetNames({
      cwd,
      env: isolation.env,
      platform: 'claude',
      scope: 'project',
      nativeCliRunner: async () => { throw new Error('claude unavailable'); },
      nativeFailureMode: 'ignore',
    })).resolves.toContain('project-owner');
  });

  it.each([
    ['codex', '.agents'],
    ['codex', '.codex'],
    ['claude', '.claude'],
  ] as const)('rejects project %s managed root symlink %s', async (platform, rootName) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const outside = path.join(isolation.layout.rootDir, `outside-${rootName.slice(1)}`);
    await fs.ensureDir(outside);
    await fs.symlink(outside, path.join(cwd, rootName), 'dir');
    const plugin = {
      rootDir: cwd,
      manifestPath: path.join(cwd, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'symlink-boundary',
        version: '1.0.0',
        description: 'symlink boundary fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    await expect(integration.buildTarget({
      plugin,
      platform,
      scope: 'project',
      cwd,
      command: 'cleanup',
      catalog: { rootDir: cwd, source: 'local' } as CatalogResolution,
    })).rejects.toThrow('符号链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each([
    ['codex', '.codex/config.toml'],
    ['claude', '.claude/settings.json'],
  ] as const)('rejects project %s managed file symlink %s', async (platform, relativePath) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const outside = path.join(isolation.layout.rootDir, `outside-${path.basename(relativePath)}`);
    await fs.outputFile(outside, 'foreign\n');
    const targetPath = path.join(cwd, relativePath);
    await fs.ensureDir(path.dirname(targetPath));
    await fs.symlink(outside, targetPath, 'file');
    const plugin = {
      rootDir: cwd,
      manifestPath: path.join(cwd, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'file-symlink-boundary',
        version: '1.0.0',
        description: 'file symlink boundary fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    await expect(integration.buildTarget({
      plugin,
      platform,
      scope: 'project',
      cwd,
      command: 'cleanup',
      catalog: { rootDir: cwd, source: 'local' } as CatalogResolution,
    })).rejects.toThrow('符号链接');
    expect(await fs.readFile(outside, 'utf8')).toBe('foreign\n');
  });

  it('routes static Codex project skills and apps through shared native only', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginRoot = path.join(isolation.layout.rootDir, 'project-skill-plugin');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'repo-check', 'SKILL.md'), '# Repo check\n');
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'repo-check', 'agents', 'openai.yaml'),
      [
        'interface:',
        '  display_name: "Repo Check"',
        '  short_description: "Check the repository"',
        '  default_prompt: "Use $repo-check to check the repository."',
        '',
        'policy:',
        '  allow_implicit_invocation: true',
        '',
      ].join('\n'),
    );
    const baseManifest = {
      name: 'project-skill-plugin',
      version: '1.0.0',
      description: 'project skill fixture',
      schemaVersion: 3,
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      skills: './skills',
    } as const;
    const plugin = {
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: baseManifest,
    } as unknown as PluginMeta;
    await fs.outputJson(plugin.manifestPath, plugin.manifest);
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const skillRoot = path.join(cwd, '.agents', 'skills', 'repo-check');
    expect(target.requiresNative).toBe(true);
    expect(target.writeNativeRequired).toBe(true);
    expect(target.artifacts.some((artifact) => artifact.kind === 'skill')).toBe(false);
    expect(await fs.pathExists(skillRoot)).toBe(false);

    await expect(integration.buildTarget({
      plugin: {
        ...plugin,
        manifest: { ...baseManifest, apps: './apps.json' },
      } as unknown as PluginMeta,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    })).resolves.toMatchObject({ requiresNative: true, writeNativeRequired: true });
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('postchecks Codex project activation from public config when official enabled is %s', async (_label, exactEnabled) => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginName = 'project-native-postcheck';
    const pluginRoot = path.join(isolation.layout.rootDir, pluginName);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'check', 'SKILL.md'), '# Check\n');
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, pluginName);
    plugin.rootDir = pluginRoot;
    plugin.manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    plugin.manifest.version = '1.0.0';
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.skills = './skills';
    await fs.outputJson(plugin.manifestPath, plugin.manifest);
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      `[plugins."${pluginName}@aw"]`,
      'enabled = true',
      '',
    ].join('\n'));
    await fs.copy(plugin.rootDir, path.join(
      isolation.layout.awHomeDir,
      'plugins',
      pluginName,
    ));
    await fs.outputJson(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      pluginName,
      plugin.manifest.version,
      '.codex-plugin',
      'plugin.json',
    ), { name: pluginName, version: plugin.manifest.version, skills: './skills' });
    const calls: NativeCliInvocation[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push(invocation);
          const exact = await fs.realpath(invocation.cwd!)
            === await fs.realpath(isolation.layout.fixtureCwd);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              installed: [{
                pluginId: `${pluginName}@aw`,
                installed: true,
                enabled: exact ? exactEnabled : false,
                version: plugin.manifest.version,
              }],
              available: [],
            }),
            stderr: '',
          };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
    });
    expect(target).toMatchObject({ requiresNative: true, writeNativeRequired: false });
    const result = await executeRebuildOperation({
      command: 'install', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toHaveLength(6);
    expect(calls.every((call) =>
      call.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
  });

  it.each([
    { extraPayload: false, rootManifest: false },
    { extraPayload: false, rootManifest: true },
    { extraPayload: true, rootManifest: false },
  ])(
    'ignores Codex private cache layout ($extraPayload, root manifest: $rootManifest)',
    async ({ extraPayload, rootManifest }) => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'git-toolkit')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-toolkit'), {
      mode: 'bundle',
    });
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const cacheManifestPath = path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      plugin.manifest.name,
      plugin.manifest.version,
      '.codex-plugin',
      'plugin.json',
    );
    let installed = false;
    const calls: string[] = [];
    const runner: NativeCliRunner = async (invocation) => {
      calls.push([invocation.command, ...invocation.args].join(' '));
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
        await fs.outputFile(configPath, [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
      }
      if (invocation.args[1] === 'add') {
        installed = true;
        await fs.appendFile(configPath, [
          `[plugins."${plugin.manifest.name}@aw"]`,
          'enabled = true',
          '',
        ].join('\n'));
        await fs.copy(
          path.join(isolation.layout.awHomeDir, 'plugins', plugin.manifest.name),
          path.dirname(path.dirname(cacheManifestPath)),
          { overwrite: true },
        );
        const cacheRoot = path.dirname(path.dirname(cacheManifestPath));
        if (rootManifest) {
          await fs.copyFile(cacheManifestPath, path.join(cacheRoot, 'plugin.json'));
          await fs.remove(cacheManifestPath);
        }
        await fs.outputJson(path.join(cacheRoot, 'metadata.json'), { installedBy: 'codex' });
        if (extraPayload) {
          await fs.outputFile(path.join(cacheRoot, 'skills', 'rogue', 'SKILL.md'), '# Rogue\n');
        }
      }
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: `${plugin.manifest.name}@aw`, installed: true,
              enabled: true, version: plugin.manifest.version,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: invocation.args[1] === 'list' && installed ? `${plugin.manifest.name}@aw\n` : '',
        stderr: '',
      };
    };
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(calls).toContain(`codex plugin marketplace add ${isolation.layout.awHomeDir}`);
    expect(calls).toContain(`codex plugin add ${plugin.manifest.name}@aw`);
    expect(await fs.pathExists(rootManifest
      ? path.join(path.dirname(path.dirname(cacheManifestPath)), 'plugin.json')
      : cacheManifestPath)).toBe(true);
    if (extraPayload) {
      await expect(fs.pathExists(path.join(
        path.dirname(path.dirname(cacheManifestPath)),
        'skills',
        'rogue',
        'SKILL.md',
      ))).resolves.toBe(true);
    }
  });

  it.each(['codex-enhance'])(
    'installs %s Skills in one shared native plugin while roles remain AW-owned',
    async (pluginName) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', pluginName)],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', pluginName), {
        mode: 'bundle',
      });
      plugin.manifest.config = { fields: { token: { type: 'string', sensitive: true } } };
      await writePluginConfigStore({
        sourceId: plugin.sourceId,
        sourceIdentity: plugin.sourceIdentity,
        logicalIdentity: plugin.catalogLogicalIdentity,
        pluginName,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        values: { token: `team/${pluginName}` },
      });
      const dynamicTarget = plugin.manifest.artifacts?.targets.find((target) =>
        target.platform === 'codex'
        && target.target === 'codex.skill'
        && (target.sourceDirs?.length ?? 0) > 0);
      expect(dynamicTarget).toBeDefined();
      await fs.outputJson(path.join(
        plugin.rootDir,
        '.agents-plugin',
        'artifact-sources',
        'codex',
        dynamicTarget!.id,
        '0',
        'aw-plugin-requirements.json',
      ), createAwPluginRequirementsReceipt(
        { name: plugin.manifest.name, version: plugin.manifest.version },
        plugin.manifest.requires?.aw.capabilities ?? [],
      ));
      const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
      const marketplaceName = 'aw-team';
      const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
      let installed = false;
      const runner: NativeCliRunner = async (invocation) => {
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          await fs.outputFile(configPath, [
            `[marketplaces.${marketplaceName}]`,
            `source = ${JSON.stringify(marketplaceRoot)}`,
            'source_type = "local"',
            '',
          ].join('\n'));
        }
        if (invocation.args[1] === 'add') {
          installed = true;
          await fs.appendFile(configPath, [
            `[plugins."${pluginName}@${marketplaceName}"]`,
            'enabled = true',
            '',
          ].join('\n'));
          await fs.copy(
            path.join(marketplaceRoot, 'plugins', pluginName),
            path.join(
              isolation.layout.codexHomeDir,
              'plugins',
              'cache',
              marketplaceName,
              pluginName,
              plugin.manifest.version,
            ),
            { overwrite: true },
          );
        }
        return {
          exitCode: 0,
          stdout: invocation.args[1] === 'list' && invocation.args.includes('--json')
            ? JSON.stringify({
                installed: installed ? [{
                  pluginId: `${pluginName}@${marketplaceName}`,
                  installed: true,
                  enabled: true,
                  version: plugin.manifest.version,
                }] : [],
                available: [],
              })
            : '',
          stderr: '',
        };
      };
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
        scriptTimeoutMs: 30_000,
      });
      const legacySkills = [
        {
          root: path.join(isolation.layout.codexHomeDir, 'skills'),
          skillKey: 'codex-explore',
          scope: 'user' as const,
        },
        {
          root: path.join(isolation.layout.fixtureCwd, '.agents', 'skills'),
          skillKey: 'codex-subagent-guide',
          scope: 'project' as const,
        },
      ];
      for (const legacy of legacySkills) {
        const skillRoot = path.join(legacy.root, legacy.skillKey);
        await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# Legacy AW delivery\n');
        await writeSkillOwnerMarker({
          skillRoot,
          allowedRoot: legacy.root,
          identity: {
            owner: 'agent-workflows',
            sourceId: 'team',
            sourceIdentity: TEST_SOURCE_IDENTITY,
            pluginId: `team/${pluginName}`,
            plugin: pluginName,
            artifactKey: legacy.skillKey,
            platform: 'codex',
            scope: legacy.scope,
          },
        });
      }
      const target = await integration.buildTarget({
        sourceId: 'team',
        sourceIdentity: TEST_SOURCE_IDENTITY,
        pluginId: `team/${pluginName}`,
        marketplaceName,
        marketplaceRoot,
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });
      const result = await executeRebuildOperation({
        command: 'install', target, driver: integration.driver,
      });
      expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
      for (const legacy of legacySkills) {
        await expect(fs.pathExists(path.join(legacy.root, legacy.skillKey))).resolves.toBe(false);
      }
      expect(target.artifacts.some((artifact) => artifact.target === 'codex.skill')).toBe(false);
      expect(target.artifacts.filter((artifact) => artifact.target === 'codex.agentRole'))
        .toHaveLength(8);
      const cacheRoot = path.join(
        isolation.layout.codexHomeDir,
        'plugins',
        'cache',
        marketplaceName,
        pluginName,
        plugin.manifest.version,
      );
      for (const skillKey of ['codex-explore', 'codex-subagent-guide']) {
        expect(await fs.pathExists(path.join(
          cacheRoot,
          'codex',
          'skills',
          skillKey,
          'SKILL.md',
        ))).toBe(true);
        expect(await fs.pathExists(path.join(
          isolation.layout.codexHomeDir,
          'skills',
          skillKey,
        ))).toBe(false);
      }
      await expect(fs.readJson(path.join(cacheRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH)))
        .resolves.toMatchObject({
          targets: [
            { id: 'codex-explore-skill', skillKey: 'codex-explore' },
            { id: 'codex-subagent-guide-skill', skillKey: 'codex-subagent-guide' },
          ],
        });
      const activationTarget = {
        ...target,
        codexNativeObservationExpectation: undefined,
        codexNativeSensitivePreflightRequired: true,
      };
      await expect(integration.driver.preflightMutation!(activationTarget)).resolves.toBeUndefined();
      const canonicalPayloadRoot = path.join(
        target.identity.marketplaceRoot!,
        'plugins',
        pluginName,
      );
      const canonicalReceiptPath = path.join(
        canonicalPayloadRoot,
        CODEX_NATIVE_RENDER_RECEIPT_PATH,
      );
      const currentSecret = 'current-sensitive-value';
      await writePluginConfigStore({
        sourceId: plugin.sourceId,
        sourceIdentity: plugin.sourceIdentity,
        logicalIdentity: plugin.catalogLogicalIdentity,
        pluginName,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        values: { token: currentSecret },
      });
      const oldVersion = '0.0.1';
      const currentReceipt = await fs.readJson(canonicalReceiptPath);
      const sourceManifestPath = path.join(canonicalPayloadRoot, '.agents-plugin', 'plugin.json');
      const sourceManifest = await fs.readJson(sourceManifestPath);
      sourceManifest.version = oldVersion;
      await fs.outputJson(sourceManifestPath, sourceManifest);
      for (const targetReceipt of currentReceipt.targets) {
        const skillRoot = path.join(canonicalPayloadRoot, 'codex', 'skills', targetReceipt.skillKey);
        const requirementsPath = path.join(skillRoot, AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH);
        const requirements = await fs.readJson(requirementsPath);
        requirements.plugin.version = oldVersion;
        await fs.outputJson(requirementsPath, requirements);
        const tree = await readDynamicSkillTree(skillRoot, 'codex.skill');
        expect(tree).not.toBeNull();
        targetReceipt.artifactDigest = createCodexSkillStagingTreeContentDigest(tree!);
      }
      const oldReceipt = createCodexNativeRenderReceipt({
        logicalPluginId: currentReceipt.logicalPluginId,
        sourceIdentity: currentReceipt.sourceIdentity,
        pluginVersion: oldVersion,
        rendererDigest: currentReceipt.rendererDigest,
        targets: currentReceipt.targets,
        payloadDigest: await calculateCodexNativeRenderPayloadDigest(canonicalPayloadRoot),
      });
      expect(parseCodexNativeRenderReceipt(oldReceipt)).toEqual(oldReceipt);
      await fs.outputJson(canonicalReceiptPath, oldReceipt);
      await expect(integration.driver.preflightMutation!(activationTarget)).resolves.toBeUndefined();

      const forgedReceipt = { ...oldReceipt, payloadDigest: `sha256:${'0'.repeat(64)}` };
      await fs.outputJson(canonicalReceiptPath, forgedReceipt);
      await expect(integration.driver.preflightMutation!(activationTarget)).resolves.toBeUndefined();

      await fs.outputFile(canonicalReceiptPath, 'invalid receipt');
      await expect(integration.driver.preflightMutation!(activationTarget)).resolves.toBeUndefined();

      await fs.outputFile(canonicalReceiptPath, `invalid receipt ${currentSecret}`);
      const exposed = await integration.driver.preflightMutation!(activationTarget)
        .catch((error: unknown) => error as Error);
      expect(exposed.message).toContain('codexNativeRenderSensitiveValue');
      expect(exposed.message).not.toContain(currentSecret);

      if (process.platform !== 'win32') {
        const foreignPayload = path.join(isolation.layout.fixtureCwd, 'foreign-native-payload');
        const foreignReceiptPath = path.join(foreignPayload, CODEX_NATIVE_RENDER_RECEIPT_PATH);
        await fs.outputFile(foreignReceiptPath, `external receipt ${currentSecret}`);
        await fs.remove(canonicalPayloadRoot);
        await fs.symlink(foreignPayload, canonicalPayloadRoot, 'dir');
        const readFile = vi.spyOn(fs, 'readFile');
        try {
          const unsafe = await integration.driver.preflightMutation!(activationTarget)
            .catch((error: unknown) => error as Error);

          expect(unsafe.message).toContain('Codex native sensitive scan payload path is unsafe');
          expect(readFile.mock.calls.some(([filePath]) =>
            path.resolve(String(filePath)) === path.resolve(canonicalReceiptPath))).toBe(false);
        } finally {
          readFile.mockRestore();
        }
      }
    },
  );

  it('does not inspect old project static Skills and preserves foreign role registrations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginRoot = path.join(isolation.layout.rootDir, 'foreign-collision-plugin');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'repo-check', 'SKILL.md'), '# Desired\n');
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'repo-check', 'agents', 'openai.yaml'),
      [
        'interface:',
        '  display_name: "Repo Check"',
        '  short_description: "Check the repository"',
        '  default_prompt: "Use $repo-check."',
        'policy:',
        '  allow_implicit_invocation: true',
      ].join('\n'),
    );
    const foreignSkill = path.join(cwd, '.agents', 'skills', 'repo-check', 'SKILL.md');
    await fs.outputFile(foreignSkill, '# Foreign\n');
    const plugin = {
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'foreign-collision-plugin',
        version: '1.0.0',
        description: 'foreign collision fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        skills: './skills',
      },
    } as PluginMeta;
    await fs.outputJson(plugin.manifestPath, plugin.manifest);
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
    });
    const integration = createRebuildIntegration({ context });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    expect(target.artifacts.some((artifact) => artifact.kind === 'skill')).toBe(false);
    expect(target.ownedComponents.some((component) =>
      'path' in component && path.resolve(component.path) === path.resolve(path.dirname(foreignSkill))))
      .toBe(false);
    await integration.driver.writeArtifacts(target);
    expect(await fs.readFile(foreignSkill, 'utf8')).toBe('# Foreign\n');

    const foreignRolePath = path.join(cwd, '.codex', 'agents', 'foreign.toml');
    await fs.outputFile(foreignRolePath, 'name = "external-alias"\n');
    await fs.outputFile(path.join(cwd, '.codex', 'config.toml'), [
      '[agents.repo-check]',
      'config_file = "agents/foreign.toml"',
      '',
    ].join('\n'));
    await expect(integration.buildTarget({
      plugin: {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          skills: undefined,
          artifacts: {
            targets: [{
              id: 'repo-role',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.agentRole',
              states: ['present', 'disabled'],
              refreshKeys: [],
              roleKey: 'repo-check',
              requiresCodexProjectConfig: true,
            }],
          },
        },
      } as PluginMeta,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    })).rejects.toThrow('roleNameConflict');
    expect(await fs.readFile(foreignRolePath, 'utf8')).toBe('name = "external-alias"\n');

    await fs.outputFile(path.join(cwd, '.codex', 'config.toml'), '');
    await fs.outputFile(
      path.join(cwd, '.codex', 'agents', 'unreferenced.toml'),
      'name = "repo-check"\n',
    );
    await expect(integration.buildTarget({
      plugin: {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          skills: undefined,
          artifacts: {
            targets: [{
              id: 'repo-role',
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.agentRole',
              states: ['present'],
              refreshKeys: [],
              roleKey: 'repo-check',
              requiresCodexProjectConfig: true,
            }],
          },
        },
      } as PluginMeta,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    })).rejects.toThrow('roleNameConflict');
  });

  it('limits Codex project user-config preflight to shared native surfaces', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const plugin = {
      rootDir: isolation.layout.rootDir,
      manifestPath: path.join(isolation.layout.rootDir, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'safety-plugin',
        version: '1.0.0',
        description: 'project safety fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const build = () => integration.buildTarget({
      plugin,
      platform: 'codex' as const,
      scope: 'project' as const,
      cwd,
      command: 'install' as const,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), '[broken');
    await expect(build()).resolves.toMatchObject({ requiresNative: false });

    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[plugins."safety-plugin@external"]',
      'enabled = true',
      '',
    ].join('\n'));
    await expect(build()).resolves.toMatchObject({ requiresNative: false });

    plugin.manifest.apps = './apps.json';
    plugin.marketplaceName = 'aw-team';
    plugin.sourceId = 'team';
    plugin.sourceIdentity = `sha256:${'1'.repeat(64)}`;
    plugin.pluginId = 'team/safety-plugin';
    const canonicalMarketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw-team]',
      `source = ${JSON.stringify(path.join(isolation.env.AW_HOME!, 'foreign-team'))}`,
      'source_type = "local"',
      '[plugins."safety-plugin@aw-team"]',
      'enabled = true',
      '',
    ].join('\n'));
    const foreignConfigPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const foreignConfigBefore = await fs.readFile(foreignConfigPath, 'utf8');
    const foreignTarget = await integration.buildTarget({
      plugin,
      sourceId: 'team',
      sourceIdentity: plugin.sourceIdentity,
      pluginId: plugin.pluginId,
      marketplaceName: 'aw-team',
      marketplaceRoot: canonicalMarketplaceRoot,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    await expect(executeRebuildOperation({
      command: 'install',
      target: foreignTarget,
      driver: integration.driver,
    })).resolves.toMatchObject({
      status: 'failed',
      error: { phase: 'preflight.inspect', message: expect.stringContaining('externalOwnershipPresent') },
    });
    expect(await fs.readFile(foreignConfigPath, 'utf8')).toBe(foreignConfigBefore);
    delete plugin.marketplaceName;
    delete plugin.sourceId;
    delete plugin.sourceIdentity;
    delete plugin.pluginId;

    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), '');
    await fs.outputFile(path.join(cwd, '.codex', 'config.toml'), '[broken');
    plugin.manifest.extensions = {
      instructions: [{ name: 'policy', title: 'Policy', content: 'Use policy.' }],
    };
    await expect(build()).rejects.toThrow('projectConfigUnreadable');

    plugin.manifest.apps = './apps.json';
    await expect(integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    })).resolves.toMatchObject({ requiresNative: false });

    delete plugin.manifest.apps;
    delete plugin.manifest.extensions;
    plugin.manifest.skills = './skills';
    await expect(inspectRebuildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    })).resolves.toMatchObject({ inspection: { state: 'error' } });

    const userRolePath = path.join(isolation.layout.codexHomeDir, 'agents', 'foreign.toml');
    await fs.outputFile(userRolePath, 'name = "user-role"\n');
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[agents.user-role]',
      'config_file = "agents/foreign.toml"',
      '',
    ].join('\n'));
    plugin.manifest.skills = undefined;
    plugin.manifest.artifacts = {
      targets: [{
        id: 'user-role',
        platform: 'codex',
        scopes: ['user'],
        target: 'codex.agentRole',
        states: ['present'],
        refreshKeys: [],
        roleKey: 'user-role',
        requiresCodexProjectConfig: true,
      }],
    };
    await expect(integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    })).rejects.toThrow('roleNameConflict');
  });

  it('checks a derived Codex marketplace before removing a stale schema 2 project rule', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const plugin: PluginMeta = {
      ...createClaudeCleanupPlugin(isolation.layout.rootDir, 'stale-rule'),
      sourceId: 'team',
      sourceIdentity: `sha256:${'3'.repeat(64)}`,
      pluginId: 'team/stale-rule',
      marketplaceName: 'aw-team',
    };
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.version = '1.0.0';
    plugin.manifest.extensions = {
      permissions: [{ name: 'stale-rule', allow: ['git status'] }],
    };
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const common = {
      sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity,
      pluginId: plugin.pluginId,
      marketplaceName: plugin.marketplaceName,
      marketplaceRoot,
      platform: 'codex' as const,
      scope: 'project' as const,
      cwd,
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    };
    const v1 = await integration.buildTarget({ ...common, plugin, command: 'install' });
    await integration.driver.writeArtifacts(v1);
    const staleArtifact = v1.artifacts.find((artifact) => artifact.kind === 'permission')!;
    const staleComponents = v1.ownedComponents.filter((component) =>
      'path' in component && path.resolve(component.path) === path.resolve(staleArtifact.path));
    expect(staleComponents.length).toBeGreaterThan(0);
    expect(parseOwnedTextHeader(await fs.readFile(staleArtifact.path, 'utf8'))?.identity)
      .toMatchObject({ sourceId: 'team', pluginId: 'team/stale-rule' });

    const v2Plugin: PluginMeta = {
      ...plugin,
      manifest: { ...plugin.manifest, version: '2.0.0', extensions: undefined },
    };
    const v2 = await integration.buildTarget({ ...common, plugin: v2Plugin, command: 'sync' });
    const staleIdentity = staleComponents[0]!.identity;
    const sameIdentity = (component: (typeof v2.ownedComponents)[number]) =>
      component.identity.plugin === staleIdentity.plugin
      && component.identity.artifactKey === staleIdentity.artifactKey
      && component.identity.platform === staleIdentity.platform
      && component.identity.scope === staleIdentity.scope;
    const ownedComponents = v2.ownedComponents.some(sameIdentity)
      ? [...v2.ownedComponents]
      : [...v2.ownedComponents, staleComponents[0]!];
    const target = {
      ...v2,
      ownedComponents,
      desiredOwnedComponents: (v2.desiredOwnedComponents ?? v2.ownedComponents)
        .filter((component) => !sameIdentity(component)),
    };
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw-team]',
      `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-team'))}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    const before = await fs.readFile(staleArtifact.path, 'utf8');
    const result = await executeRebuildOperation({
      command: 'sync',
      target,
      driver: integration.driver,
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { phase: 'preflight.inspect', message: expect.stringContaining('externalOwnershipPresent') },
    });
    expect(await fs.readFile(staleArtifact.path, 'utf8')).toBe(before);
  });

  it('keeps current Claude permission overlaps without restoring later removals', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const settingsPath = path.join(isolation.layout.claudeHomeDir, 'settings.json');
    const stalePermissionOwner = createSharedOwnerToken({
      owner: 'agent-workflows', sourceId: 'team', pluginId: 'team/stale-permission',
      plugin: 'stale-permission', artifactKey: 'permissions', platform: 'claude', scope: 'user',
    });
    await fs.outputJson(settingsPath, {
      permissions: {
        allow: ['Manual', 'AddedLater', 'OldGenerated', 'RetainedOverlap', 'OtherGenerated'],
      },
      awGenerated: {
        permissions: {
          [stalePermissionOwner]: {
            allow: ['OldGenerated', 'RetainedOverlap', 'RemovedOverlap'], ask: [], deny: [],
          },
          other: { allow: ['OtherGenerated'], ask: [], deny: [] },
        },
        manualPermissions: {
          allow: ['Manual', 'RemovedLater', 'RetainedOverlap', 'RemovedOverlap'], ask: [], deny: [],
        },
      },
    });
    const plugin = {
      sourceId: 'team',
      sourceIdentity: TEST_SOURCE_IDENTITY,
      pluginId: 'team/stale-permission',
      rootDir: isolation.layout.rootDir,
      manifestPath: path.join(isolation.layout.rootDir, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'stale-permission',
        version: '0.0.0',
        description: 'stale permission cleanup fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'claude',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup',
      target,
      driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    const settings = await fs.readJson(settingsPath);
    expect(settings.awGenerated.permissions).toEqual({
      other: { allow: ['OtherGenerated'], ask: [], deny: [] },
    });
    expect(settings.awGenerated.manualPermissions.allow).toHaveLength(3);
    expect(settings.awGenerated.manualPermissions.allow).toEqual(expect.arrayContaining([
      'Manual', 'AddedLater', 'RetainedOverlap',
    ]));
    expect(settings.permissions.allow).toHaveLength(4);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([
      'Manual', 'AddedLater', 'RetainedOverlap', 'OtherGenerated',
    ]));
  });

  it.each(['user', 'project'] as const)(
    'uses canonical Claude %s native ownership and preserves foreign aw collisions',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = await fs.realpath(isolation.layout.fixtureCwd);
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), {
        mode: 'bundle',
      });
      const calls: string[] = [];
      let installed = false;
      const runner: NativeCliRunner = async (invocation) => {
        calls.push([invocation.command, ...invocation.args].join(' '));
        if (invocation.args[1] === 'install') installed = true;
        if (invocation.args[1] === 'uninstall') installed = false;
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
          const paths = resolveClaudePaths(cwd, scope, isolation.env);
          await fs.outputJson(paths.settingsPath, {
            extraKnownMarketplaces: {},
            enabledPlugins: {},
          });
          await fs.outputJson(paths.knownMarketplacesPath, {});
          await fs.outputJson(paths.installedPluginsPath, { plugins: {} });
        } else if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          await writeClaudeNativeState({
            cwd,
            env: isolation.env,
            pluginName: plugin.manifest.name,
            pluginVersion: plugin.manifest.version,
            scope,
            installed: false,
          });
        } else if (invocation.args[1] === 'install' || invocation.args[1] === 'uninstall') {
          await writeClaudeNativeState({
            cwd,
            env: isolation.env,
            pluginName: plugin.manifest.name,
            pluginVersion: plugin.manifest.version,
            scope,
            installed,
          });
        }
        return {
          exitCode: 0,
          stdout: invocation.args[1] === 'list' && installed ? `${plugin.manifest.name}@aw\n` : '',
          stderr: '',
        };
      };
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
      });
      const installTarget = await integration.buildTarget({
        plugin,
        platform: 'claude',
        scope,
        cwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });
      const installedResult = await executeRebuildOperation({
        command: 'install', target: installTarget, driver: integration.driver,
      });
      expect(installedResult.status, JSON.stringify(installedResult.failures)).toBe('succeeded');

      const uninstallTarget = await integration.buildTarget({
        plugin,
        platform: 'claude',
        scope,
        cwd,
        command: 'uninstall',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });
      const uninstalledResult = await executeRebuildOperation({
        command: 'uninstall', target: uninstallTarget, driver: integration.driver,
      });
      expect(uninstalledResult.status, JSON.stringify(uninstalledResult.failures)).toBe('succeeded');
      expect(calls).toContain(`claude plugin uninstall ${plugin.manifest.name}@aw --scope ${scope}`);

      await writeClaudeNativeState({
        cwd,
        env: isolation.env,
        pluginName: plugin.manifest.name,
        pluginVersion: plugin.manifest.version,
        scope,
        installed: true,
        canonical: false,
      });
      const foreignTarget = await integration.buildTarget({
        plugin,
        platform: 'claude',
        scope,
        cwd,
        command: 'cleanup',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });
      const beforeForeignCalls = calls.length;
      const foreignResult = await executeRebuildOperation({
        command: 'cleanup', target: foreignTarget, driver: integration.driver,
      });
      expect(foreignResult.status).toBe('failed');
      expect(calls.slice(beforeForeignCalls)).not.toContain(
        `claude plugin uninstall ${plugin.manifest.name}@aw --scope ${scope}`,
      );
    },
  );

  it('succeeds for an official Codex install without private cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'git-toolkit')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-toolkit'), {
      mode: 'bundle',
    });
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    let installed = false;
    let marketplace = false;
    const calls: string[] = [];
    const writeConfig = async () => {
      const lines: string[] = [];
      if (marketplace) lines.push(
        '[marketplaces.aw]',
        `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
        'source_type = "local"',
        '',
      );
      if (installed) lines.push(
        `[plugins."${plugin.manifest.name}@aw"]`,
        'enabled = true',
        '',
      );
      await fs.outputFile(configPath, lines.join('\n'));
    };
    const runner: NativeCliRunner = async (invocation) => {
      calls.push([invocation.command, ...invocation.args].join(' '));
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') marketplace = true;
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') marketplace = false;
      if (invocation.args[1] === 'add') installed = true;
      if (invocation.args[1] === 'remove') installed = false;
      await writeConfig();
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: `${plugin.manifest.name}@aw`, installed: true,
              enabled: true, version: plugin.manifest.version,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: invocation.args[1] === 'list' && installed ? `${plugin.manifest.name}@aw\n` : '',
        stderr: '',
      };
    };
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(result.cleanupAttempted).toBe(false);
    expect(calls.filter((call) => call === `codex plugin remove ${plugin.manifest.name}@aw`)).toHaveLength(0);
    expect(calls.filter((call) => call === 'codex plugin marketplace remove aw')).toHaveLength(0);
    expect(installed).toBe(true);
    expect(marketplace).toBe(true);
  });

  it('cleans an officially absent Codex plugin without deleting private cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginName = 'residue-plugin';
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const cacheRoot = path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      pluginName,
      '1.0.0',
    );
    await fs.outputFile(configPath, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      `[plugins."${pluginName}@aw"]`,
      'enabled = true',
      '',
    ].join('\n'));
    await fs.outputJson(path.join(cacheRoot, '.codex-plugin', 'plugin.json'), {
      name: pluginName,
      version: '1.0.0',
      skills: './codex/skills',
    });
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
            await fs.outputFile(configPath, '');
          }
          return {
            exitCode: 0,
            stdout: invocation.args.includes('--json')
              ? JSON.stringify({ installed: [], available: [] })
              : '',
            stderr: '',
          };
        },
      }),
    });
    const plugin = {
      rootDir: '.',
      manifestPath: '.agents-plugin/plugin.json',
      manifest: {
        name: pluginName,
        version: '0.0.0',
        description: 'native residue fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.apps = './apps';
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(result.residual).toEqual([]);
    expect(calls).not.toContain(`codex plugin remove ${pluginName}@aw`);
    expect(calls).toContain('codex plugin marketplace remove aw');
    expect(await fs.pathExists(cacheRoot)).toBe(true);
  });

  it.each([
    ['installed', 'codexNativeRemoveIncomplete'],
    ['duplicate', 'codexNativeObservationFailed'],
  ] as const)('fails Codex remove when the official postcheck is %s', async (postcheck, error) => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, 'remove-postcheck');
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.apps = './apps';
    const pluginId = 'remove-postcheck@aw';
    let removed = false;
    const runner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args.join(' ') === `plugin remove ${pluginId}`) removed = true;
      const entry = {
        pluginId, installed: true, enabled: true, version: plugin.manifest.version,
      };
      const installedEntries = removed && postcheck === 'duplicate' ? [entry, entry] : [entry];
      return {
        exitCode: 0,
        stdout: invocation.args.includes('--json')
          ? JSON.stringify({
              installed: installedEntries,
              available: [],
            })
          : '',
        stderr: '',
      };
    });
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
    });
    const component = target.ownedComponents.find((candidate) =>
      candidate.kind === 'native-plugin');
    if (!component || component.kind !== 'native-plugin') {
      throw new Error('Expected a native plugin component.');
    }

    await expect(integration.driver.removeNative!(component))
      .rejects.toThrow(error);
    expect(runner.mock.calls.some(([invocation]) =>
      invocation.args.join(' ') === `plugin remove ${pluginId}`)).toBe(true);
  });

  it('never removes a Codex plugin through a foreign aw marketplace owner', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginName = 'foreign-native';
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(path.join(isolation.layout.rootDir, 'foreign-aw'))}`,
      'source_type = "local"',
      '',
      `[plugins."${pluginName}@aw"]`,
      'enabled = true',
      '',
    ].join('\n'));
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, pluginName);
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    const target = await integration.buildTarget({
      plugin, platform: 'codex', scope: 'user', cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' },
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(result.residual).toEqual([]);
    expect(calls).not.toContain(`codex plugin remove ${pluginName}@aw`);
  });

  it('removes an orphan Codex marketplace only when no other AW plugin remains', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    let otherInstalled = true;
    const writeMarketplace = () => fs.outputFile(configPath, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      ...(otherInstalled ? [
        '[plugins."other-plugin@aw"]',
        'enabled = true',
        '',
      ] : []),
    ].join('\n'));
    await writeMarketplace();
    const calls: string[] = [];
    const runner: NativeCliRunner = async (invocation) => {
      calls.push([invocation.command, ...invocation.args].join(' '));
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
        await fs.outputFile(configPath, '');
      }
      return {
        exitCode: 0,
        stdout: invocation.args.includes('--json')
          ? JSON.stringify({
              installed: otherInstalled ? [{
                pluginId: 'other-plugin@aw', installed: true, enabled: true, version: '1.0.0',
              }] : [],
              available: [],
            })
          : '',
        stderr: '',
      };
    };
    const plugin = {
      rootDir: isolation.layout.rootDir,
      manifestPath: path.join(isolation.layout.rootDir, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'orphan-plugin',
        version: '0.0.0',
        description: 'orphan marketplace fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.apps = './apps';
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const first = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(first.status).toBe('succeeded');
    expect(calls).not.toContain('codex plugin marketplace remove aw');

    otherInstalled = false;
    await writeMarketplace();
    const second = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(second.status, JSON.stringify(second.failures)).toBe('succeeded');
    expect(calls).toContain('codex plugin marketplace remove aw');
  });

  it('reinstalls Codex plugin A while same-scope plugin B keeps the marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'git-toolkit')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-toolkit'), {
      mode: 'bundle',
    });
    const pluginA = plugin.manifest.name;
    const pluginB = 'same-scope-consumer';
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const cacheBase = path.join(isolation.layout.codexHomeDir, 'plugins', 'cache', 'aw');
    let installedA = true;
    const writeConfig = () => fs.outputFile(configPath, [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
      ...(installedA ? [`[plugins."${pluginA}@aw"]`, 'enabled = true', ''] : []),
      `[plugins."${pluginB}@aw"]`,
      'enabled = true',
      '',
    ].join('\n'));
    await writeConfig();
    await fs.outputJson(path.join(
      cacheBase, pluginA, plugin.manifest.version, '.codex-plugin', 'plugin.json',
    ), { name: pluginA, version: plugin.manifest.version, skills: './skills' });
    await fs.outputJson(path.join(
      cacheBase, pluginB, '1.0.0', '.codex-plugin', 'plugin.json',
    ), { name: pluginB, version: '1.0.0' });
    const calls: string[] = [];
    const runner: NativeCliRunner = async (invocation) => {
      calls.push([invocation.command, ...invocation.args].join(' '));
      if (invocation.args[1] === 'remove') {
        installedA = false;
        await fs.remove(path.join(cacheBase, pluginA));
        await writeConfig();
      }
      if (invocation.args[1] === 'add') {
        installedA = true;
        await fs.copy(
          path.join(isolation.layout.awHomeDir, 'plugins', pluginA),
          path.join(cacheBase, pluginA, plugin.manifest.version),
          { overwrite: true },
        );
        await writeConfig();
      }
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              ...(installedA ? [{
                pluginId: `${pluginA}@aw`, installed: true,
                enabled: true, version: plugin.manifest.version,
              }] : []),
              { pluginId: `${pluginB}@aw`, installed: true, enabled: true, version: '1.0.0' },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'codex', scope: 'user', cwd: isolation.layout.fixtureCwd,
      command: 'reinstall',
      catalog: { rootDir: catalogRoot, source: 'local' },
    });
    const result = await executeRebuildOperation({
      command: 'reinstall', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('codex plugin marketplace remove aw');
    expect(await fs.readFile(configPath, 'utf8')).toContain(`${pluginB}@aw`);
  });

  it('keeps plugin A native dynamic projection when Codex rebuilds plugin B', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [
        path.join(repositoryRoot, 'plugins', 'codex-enhance'),
        path.join(repositoryRoot, 'plugins', 'git-toolkit'),
        path.join(repositoryRoot, 'plugins', 'ask-me'),
      ],
    });
    const pluginA = await readPluginManifest(path.join(catalogRoot, 'plugins', 'codex-enhance'), {
      mode: 'bundle',
    });
    const pluginB = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-toolkit'), {
      mode: 'bundle',
    });
    const pluginC = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), {
      mode: 'bundle',
    });
    await fs.outputJson(path.join(catalogRoot, '.aw-generated.json'), {
      schemaVersion: 1,
      kind: 'catalog',
      workspaceIdentity: `fixture:${crypto.createHash('sha256').update(catalogRoot).digest('hex')}`,
      sourceIdentity: TEST_SOURCE_IDENTITY,
    });
    const sourceConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: catalogRoot }],
      },
      expectedDigest: sourceConfig.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', impactConfirmed: true, env: isolation.env,
    });
    const activeSource = (await readCatalogGenerationState(isolation.env)).sources.team!.active!;
    for (const plugin of [pluginA, pluginB, pluginC]) {
      plugin.sourceIdentity = activeSource.sourceIdentity;
      plugin.catalogLogicalIdentity = activeSource.logicalIdentity;
    }
    const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'team');
    await fs.ensureDir(path.dirname(marketplaceRoot));
    const installed = new Map<string, string>();
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.args.includes('--version')) {
        return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      }
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'add') {
        const pluginId = invocation.args[2]!;
        installed.set(pluginId, pluginId.startsWith('codex-enhance@')
          ? pluginA.manifest.version
          : pluginB.manifest.version);
        const config = await fs.readFile(configPath, 'utf8').catch(() => '');
        if (!config.includes(`[plugins.${JSON.stringify(pluginId)}]`)) {
          await fs.outputFile(configPath, `${config}[plugins.${JSON.stringify(pluginId)}]\nenabled = true\n`);
        }
      }
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'marketplace'
        && invocation.args[2] === 'add') {
        await fs.outputFile(configPath, [
          '[marketplaces.aw-team]',
          `source = ${JSON.stringify(marketplaceRoot)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
      }
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'remove') {
        installed.delete(invocation.args[2]!);
      }
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [...installed].map(([pluginId, version]) => ({
              pluginId, version, installed: true, enabled: true,
            })),
            available: [],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const install = async (plugin: PluginMeta) => {
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
      });
      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' },
        marketplaceName: 'aw-team',
        marketplaceRoot,
      });
      return executeRebuildOperation({ command: 'install', target, driver: integration.driver });
    };

    const first = await install(pluginA);
    expect(first.status, JSON.stringify(first.failures)).toBe('succeeded');
    const receiptPath = path.join(
      marketplaceRoot, 'plugins', 'codex-enhance', CODEX_NATIVE_RENDER_RECEIPT_PATH,
    );
    const receiptContent = await fs.readFile(receiptPath, 'utf8');
    const receipt = parseCodexNativeRenderReceipt(receiptContent);
    const retainedSkillPath = path.join(
      marketplaceRoot, 'plugins', 'codex-enhance', 'codex', 'skills',
      receipt.targets.find((entry) => entry.artifactDigest
        !== createCodexSkillStagingTreeContentDigest({ skillKey: 'empty', files: {} }))!.skillKey,
      'SKILL.md',
    );
    const retainedSkillContent = await fs.readFile(retainedSkillPath, 'utf8');

    const second = await install(pluginB);
    expect(second.status, JSON.stringify(second.failures)).toBe('succeeded');
    await expect(fs.readFile(receiptPath, 'utf8')).resolves.toBe(receiptContent);
    await expect(fs.readFile(retainedSkillPath, 'utf8')).resolves.toBe(retainedSkillContent);

    const taskResult = await taskWriteCommand([{
      pluginId: pluginB.pluginId!, platform: 'codex', scope: 'user', method: 'reinstall',
    }], {
      cwd: isolation.layout.fixtureCwd, allowManagedCodexInstall: true,
    }, { env: isolation.env, nativeCliRunner: runner });
    expect(taskResult.targetResults, JSON.stringify(taskResult.targetResults)).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: pluginB.pluginId, scope: 'user' }),
        state: 'completed',
      }),
    ]);
    await expect(fs.readFile(receiptPath, 'utf8')).resolves.toBe(receiptContent);
    await expect(fs.readFile(retainedSkillPath, 'utf8')).resolves.toBe(retainedSkillContent);

    const claudePaths = resolveClaudePaths(isolation.layout.fixtureCwd, 'user', isolation.env);
    const claudeRunner: NativeCliRunner = async (invocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'install') {
        const sourceDescriptor = { source: 'directory', path: marketplaceRoot };
        await fs.outputJson(claudePaths.settingsPath, {
          extraKnownMarketplaces: { 'aw-team': { source: sourceDescriptor } },
          enabledPlugins: { 'ask-me@aw-team': true },
        });
        await fs.outputJson(claudePaths.knownMarketplacesPath, {
          'aw-team': { source: sourceDescriptor, installLocation: marketplaceRoot },
        });
        await fs.outputJson(claudePaths.installedPluginsPath, {
          plugins: {
            'ask-me@aw-team': [{
              name: 'ask-me', marketplace: 'aw-team', scope: 'user',
              version: pluginC.manifest.version,
            }],
          },
        });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const claudeIntegration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: claudeRunner }),
    });
    const claudeTarget = await claudeIntegration.buildTarget({
      plugin: pluginC,
      platform: 'claude',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' },
      marketplaceName: 'aw-team',
      marketplaceRoot,
    });
    const third = await executeRebuildOperation({
      command: 'install', target: claudeTarget, driver: claudeIntegration.driver,
    });
    expect(third.status, JSON.stringify(third.failures)).toBe('succeeded');
    await expect(fs.readFile(receiptPath, 'utf8')).resolves.toBe(receiptContent);
    await expect(fs.readFile(retainedSkillPath, 'utf8')).resolves.toBe(retainedSkillContent);
  });

  it('preserves the custom Codex user payload root from the platform manifest during cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginRoot = path.join(isolation.layout.rootDir, 'custom-root-plugin');
    const plugin = {
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'custom-root-plugin',
        version: '1.0.0',
        description: 'custom root fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        skills: './skills',
      },
    } as PluginMeta;
    await fs.outputJson(plugin.manifestPath, plugin.manifest);
    await fs.outputJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      skills: './custom/skills',
    });
    await fs.outputJson(path.join(
      isolation.layout.awHomeDir,
      'plugins',
      plugin.manifest.name,
      '.codex-plugin',
      'plugin.json',
    ), {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      skills: './custom/skills',
    });
    const skillRoot = path.join(
      isolation.layout.awHomeDir,
      'plugins',
      plugin.manifest.name,
      'custom',
      'skills',
      'custom-skill',
    );
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# Custom\n');
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: plugin.manifest.name,
      artifactKey: 'custom-skill',
      platform: 'codex',
      scope: 'user',
    });
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    const target = await integration.buildTarget({
      plugin: {
        rootDir: '.',
        manifestPath: '.agents-plugin/plugin.json',
        manifest: { ...plugin.manifest, version: '0.0.0', skills: undefined },
      } as PluginMeta,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# Custom\n');
    await expect(fs.readJson(path.join(skillRoot, '.agent-workflows-owner.json'))).resolves.toMatchObject({
      owner: 'agent-workflows',
      plugin: plugin.manifest.name,
    });
  });

  it('does not materialize unsupported slash commands into a Codex project', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const fixtureRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../fixtures/codex-project-repo-managed/plugins/slashCommands-only',
    );
    const source = await readPluginManifest(fixtureRoot);
    const bundled = await bundleLocalPlugin(
      source,
      path.join(isolation.layout.rootDir, 'slash-command-bundle'),
    );
    const bundledPlugin = await readPluginManifest(bundled.outputRoot, { mode: 'bundle' });
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const target = await integration.buildTarget({
      plugin: bundledPlugin,
      platform: 'codex',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
    });
    const generatedSkill = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'review',
      'SKILL.md',
    );
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(target.requiresNative).toBe(false);
    expect(target.artifacts.some((artifact) => artifact.kind === 'skill')).toBe(false);
    expect(await fs.pathExists(generatedSkill)).toBe(false);
  });

  it('writes AW-only Codex project extensions without native MCP or hook payloads', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const fixturesRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../fixtures/codex-project-repo-managed/plugins',
    );
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
    });
    const integration = createRebuildIntegration({ context });
    const plugins = await Promise.all(['extensions-only', 'instructions-mcp'].map((name) =>
      readPluginManifest(path.join(fixturesRoot, name))));
    for (const plugin of plugins) {
      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope: 'project',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: fixturesRoot, source: 'local' } as CatalogResolution,
      });
      expect(target.artifacts.some((artifact) => artifact.kind === 'mcpServer')).toBe(false);
      expect(target.artifacts.some((artifact) => artifact.kind === 'hook')).toBe(false);
      await integration.driver.writeArtifacts(target);
    }
    const config = await fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      'utf8',
    );
    expect(config).toContain('extensions-only');
    expect(config).not.toContain('mcp_servers');
    expect(await fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'hooks.json'))).toBe(false);
    expect((await fs.readdir(path.join(isolation.layout.fixtureCwd, '.codex', 'rules'))).length).toBeGreaterThan(0);
    expect((await fs.readdir(path.join(isolation.layout.fixtureCwd, '.codex', 'agents'))).length).toBeGreaterThan(0);
  });

  it('does not create a project hook write plan for native Codex hooks', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const plugin = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'hook-symlink-race',
      hookCommand: 'echo blocked-hook',
    });
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'codex', scope: 'project', cwd,
      command: 'install',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    expect(target.requiresNative).toBe(true);
    expect(target.artifacts.some((artifact) => artifact.kind === 'hook')).toBe(false);
    await expect(fs.pathExists(path.join(cwd, '.codex', 'hooks.json')))
      .resolves.toBe(false);
  });

  it('keeps same-name shared native owners isolated by marketplace identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    const sourceIdentity = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
    const plugins = await Promise.all(['first', 'second'].map(async (sourceId, index) => {
      const plugin = await createCodexSharedConfigPlugin({
        root: path.join(isolation.layout.rootDir, sourceId),
        name: 'same-shared',
        mcpServerKey: 'shared-server',
      });
      plugin.sourceId = sourceId;
      plugin.sourceIdentity = sourceIdentity[index];
      plugin.pluginId = `${sourceId}/same-shared`;
      plugin.manifest.marketplace.policy.products = ['CODEX'];
      plugin.manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: sourceId }],
      };
      return plugin;
    }));
    const targets = await Promise.all(plugins.map((plugin) => integration.buildTarget({
      sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity,
      pluginId: plugin.pluginId,
      marketplaceName: `aw-${plugin.sourceId}`,
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', plugin.sourceId!),
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: plugin.rootDir, source: 'local' },
    })));
    expect(targets.every((target) =>
      target.artifacts.every((artifact) => artifact.kind !== 'mcpServer'))).toBe(true);
    const collisions = preflightDesiredArtifactCollisions(targets.map((target) => ({
      pluginId: target.identity.pluginId!,
      targetKey: 'codex/project',
      artifactKeys: target.ownedComponents.map((component) =>
        'path' in component
          ? path.resolve(component.path)
          : component.kind === 'native-plugin'
            ? `native:${component.pluginId}`
            : `shared:${component.label}`),
    })));
    expect(collisions).toEqual([]);
    for (const plugin of plugins) delete plugin.manifest.mcpServers;
    const instructionTargets = await Promise.all(plugins.map((plugin) => integration.buildTarget({
      sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity,
      pluginId: plugin.pluginId,
      marketplaceName: `aw-${plugin.sourceId}`,
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', plugin.sourceId!),
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: plugin.rootDir, source: 'local' },
    })));
    for (const target of instructionTargets) await integration.driver.writeArtifacts(target);

    const configPath = resolveCodexPaths(cwd, 'project', isolation.env).configTomlPath;
    const config = await readCodexConfigFile(configPath);
    const instructionOwners = Object.keys(config.snapshot.developerInstructions.managedBlocks)
      .map((key) => parseSharedOwnerToken(key)?.pluginId)
      .filter(Boolean);
    expect(instructionOwners.sort()).toEqual(['first/same-shared', 'second/same-shared']);
    const inventory = await inventoryCatalogSourceReferences({ cwd, env: isolation.env });
    expect(inventory.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'namespacedOwner',
        pluginName: 'same-shared',
        sourceId: expect.stringMatching(/^(first|second)$/u),
      }),
    ]));
    const cleanupFirst = await integration.buildTarget({
      sourceId: plugins[0]!.sourceId,
      sourceIdentity: plugins[0]!.sourceIdentity,
      pluginId: plugins[0]!.pluginId,
      marketplaceName: 'aw-first',
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', 'first'),
      plugin: plugins[0]!,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'cleanup',
      catalog: { rootDir: plugins[0]!.rootDir, source: 'local' },
    });
    await expect(executeRebuildOperation({
      command: 'cleanup',
      target: cleanupFirst,
      driver: integration.driver,
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(Object.keys((await readCodexConfigFile(configPath)).snapshot.developerInstructions.managedBlocks)
      .map((key) => parseSharedOwnerToken(key)?.pluginId)).toEqual(['second/same-shared']);

    const claudePlugins = plugins.map((plugin) => ({
      ...plugin,
      manifest: {
        ...plugin.manifest,
        extensions: {
          permissions: [{ name: 'source-command', allow: [`${plugin.sourceId} status`] }],
        },
      },
    }));
    const claudeTargets = await Promise.all(claudePlugins.map((plugin) => integration.buildTarget({
      sourceId: plugin.sourceId,
      sourceIdentity: plugin.sourceIdentity,
      pluginId: plugin.pluginId,
      marketplaceName: `aw-${plugin.sourceId}`,
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', plugin.sourceId!),
      plugin,
      platform: 'claude',
      scope: 'project',
      cwd,
      command: 'install',
      catalog: { rootDir: plugin.rootDir, source: 'local' },
    })));
    for (const target of claudeTargets) await integration.driver.writeArtifacts(target);
    const claudePaths = resolveClaudePaths(cwd, 'project', isolation.env);
    const settings = await fs.readJson(claudePaths.settingsPath) as {
      awGenerated: { permissions: Record<string, unknown> };
    };
    expect(Object.keys(settings.awGenerated.permissions).map((key) => parseSharedOwnerToken(key)?.pluginId).sort())
      .toEqual(['first/same-shared', 'second/same-shared']);
    const claudeCleanup = await integration.buildTarget({
      sourceId: claudePlugins[0]!.sourceId,
      sourceIdentity: claudePlugins[0]!.sourceIdentity,
      pluginId: claudePlugins[0]!.pluginId,
      marketplaceName: 'aw-first',
      marketplaceRoot: path.join(isolation.layout.awHomeDir, 'marketplaces', 'first'),
      plugin: claudePlugins[0]!,
      platform: 'claude',
      scope: 'project',
      cwd,
      command: 'cleanup',
      catalog: { rootDir: claudePlugins[0]!.rootDir, source: 'local' },
    });
    await expect(executeRebuildOperation({
      command: 'cleanup',
      target: claudeCleanup,
      driver: integration.driver,
    })).resolves.toMatchObject({ status: 'succeeded' });
    const afterClaudeCleanup = await fs.readJson(claudePaths.settingsPath) as {
      awGenerated: { permissions: Record<string, unknown> };
    };
    expect(Object.keys(afterClaudeCleanup.awGenerated.permissions)
      .map((key) => parseSharedOwnerToken(key)?.pluginId)).toEqual(['second/same-shared']);
  });

  it('reinstalls a dynamic project role by removing registration before its owner file', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const v1 = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'role-reinstall',
      roleKey: 'reinstall-role',
      roleInstructions: 'Version one instructions.',
    });
    const installTarget = await integration.buildTarget({
      plugin: v1, platform: 'codex', scope: 'project', cwd,
      command: 'install', catalog,
    });
    const installed = await executeRebuildOperation({
      command: 'install', target: installTarget, driver: integration.driver,
    });
    expect(installed.status, JSON.stringify(installed.failures)).toBe('succeeded');

    const v2 = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'role-reinstall',
      roleKey: 'reinstall-role',
      roleInstructions: 'Version two instructions.',
    });
    const reinstallTarget = await integration.buildTarget({
      plugin: v2, platform: 'codex', scope: 'project', cwd,
      command: 'reinstall', catalog,
    });
    const reinstalled = await executeRebuildOperation({
      command: 'reinstall', target: reinstallTarget, driver: integration.driver,
    });
    expect(reinstalled.status, JSON.stringify(reinstalled.failures)).toBe('succeeded');
    const configPath = resolveCodexPaths(cwd, 'project', isolation.env).configTomlPath;
    const registration = (await readCodexConfigFile(configPath)).snapshot.agents['reinstall-role'];
    expect(registration?.configFile).toBeTruthy();
    const rolePath = path.resolve(path.dirname(configPath), registration!.configFile!);
    const roleContent = await fs.readFile(rolePath, 'utf8');
    expect(roleContent).toContain('Version two instructions.');
    expect(parseOwnedTextHeader(roleContent)?.identity.plugin).toBe('role-reinstall');

    const protectedTarget = await integration.buildTarget({
      plugin: v2, platform: 'codex', scope: 'project', cwd,
      command: 'reinstall', catalog,
    });
    const foreignRolePath = path.join(path.dirname(rolePath), 'foreign-reinstall-role.toml');
    await fs.outputFile(foreignRolePath, 'description = "foreign role"\n');
    await applyCodexConfigTransactionFile(configPath, {
      upsertAgentRegistrations: {
        'reinstall-role': { configFile: 'agents/foreign-reinstall-role.toml' },
      },
    });
    const protectedResult = await executeRebuildOperation({
      command: 'reinstall', target: protectedTarget, driver: integration.driver,
    });
    expect(protectedResult.status).toBe('failed');
    expect((await readCodexConfigFile(configPath)).snapshot.agents['reinstall-role']?.configFile)
      .toBe('agents/foreign-reinstall-role.toml');
    await expect(fs.readFile(foreignRolePath, 'utf8')).resolves.toBe('description = "foreign role"\n');
  });

  it('does not touch foreign MCP while conditionally removing role registrations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const rolePlugin = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'conditional-remove-role',
      roleKey: 'conditional-role',
    });
    const target = await integration.buildTarget({
      plugin: rolePlugin, platform: 'codex', scope: 'project', cwd,
      command: 'install', catalog,
    });
    await integration.driver.writeArtifacts(target);
    const cleanupTarget = await integration.buildTarget({
      plugin: {
        ...rolePlugin,
        manifest: { ...rolePlugin.manifest, scripts: undefined, artifacts: undefined },
      },
      platform: 'codex', scope: 'project', cwd,
      command: 'cleanup', catalog,
    });
    const configPath = resolveCodexPaths(cwd, 'project', isolation.env).configTomlPath;
    const foreignRolePath = path.join(path.dirname(configPath), 'agents', 'foreign-role.toml');
    await fs.outputFile(foreignRolePath, 'description = "foreign"\n');
    await applyCodexConfigTransactionFile(configPath, {
      upsertMcpServers: {
        'conditional-server': {
          command: 'foreign',
          env: { AW_AGENT_WORKFLOWS_OWNER: 'foreign-mcp' },
        },
      },
      upsertAgentRegistrations: {
        'conditional-role': { configFile: 'agents/foreign-role.toml' },
      },
    });
    const conditionalComponents = cleanupTarget.ownedComponents
      .filter((component) => component.kind === 'shared-config');
    for (const component of conditionalComponents) {
      await integration.driver.ownership.removeShared(component);
    }

    const config = await readCodexConfigFile(configPath);
    const env = config.snapshot.mcpServers['conditional-server']?.value?.env as Record<string, unknown>;
    expect(env.AW_AGENT_WORKFLOWS_OWNER).toBe('foreign-mcp');
    expect(config.snapshot.agents['conditional-role']?.configFile).toBe('agents/foreign-role.toml');
    expect((await fs.readdir(path.dirname(configPath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it.each(['upgrade', 'reinstall'] as const)(
    'does not project native MCP and hook capability during %s planning',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = await fs.realpath(isolation.layout.fixtureCwd);
      const pluginRoot = path.join(isolation.layout.rootDir, `removed-capability-${command}`);
      await fs.outputJson(path.join(pluginRoot, '.mcp.json'), {
        mcpServers: { legacy: { command: 'node', args: ['legacy.js'] } },
      });
      const base = createClaudeCleanupPlugin(isolation.layout.rootDir, `removed-capability-${command}`);
      base.rootDir = pluginRoot;
      base.manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
      base.manifest.version = '1.0.0';
      base.manifest.mcpServers = './.mcp.json';
      base.manifest.extensions = {
        hooks: [{ event: 'session_start', command: 'node legacy-hook.js' }],
      };
      await fs.outputJson(base.manifestPath, base.manifest);
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
        }),
      });
      const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
      const v1 = await integration.buildTarget({
        plugin: base, platform: 'codex', scope: 'project', cwd,
        command, catalog,
      });
      const codexPaths = resolveCodexPaths(cwd, 'project', isolation.env);
      expect(v1.requiresNative).toBe(true);
      expect(v1.artifacts.some((artifact) => artifact.kind === 'mcpServer')).toBe(false);
      expect(v1.artifacts.some((artifact) => artifact.kind === 'hook')).toBe(false);
      await integration.driver.writeArtifacts(v1);
      const config = await fs.readFile(codexPaths.configTomlPath, 'utf8');
      expect(config).not.toContain('mcp_servers');
      await expect(fs.pathExists(path.join(codexPaths.configDir, 'hooks.json'))).resolves.toBe(false);
    },
  );

  it('closes representative Codex project writes for three first-party plugins', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstPartyNames = ['git-toolkit', 'ask-me', 'codex-enhance'];
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: firstPartyNames.map((name) => path.join(repositoryRoot, 'plugins', name)),
    });
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
      scriptTimeoutMs: 30_000,
    });
    for (const name of firstPartyNames) {
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', name), {
        mode: 'bundle',
      });
      plugin.sourceId = 'official';
      plugin.sourceIdentity = `sha256:${'2'.repeat(64)}`;
      plugin.pluginId = `official/${name}`;
      const target = await integration.buildTarget({
        ...(plugin.sourceId ? {
          sourceId: plugin.sourceId,
          sourceIdentity: plugin.sourceIdentity,
          pluginId: plugin.pluginId,
        } : {}),
        plugin,
        platform: 'codex',
        scope: 'project',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });
      expect(target.artifacts.some((artifact) =>
        artifact.kind === 'mcpServer' || artifact.kind === 'hook')).toBe(false);
      await integration.driver.writeArtifacts(target);
      if (name === 'codex-enhance') {
        const repeatTarget = await integration.buildTarget({
          sourceId: plugin.sourceId,
          sourceIdentity: plugin.sourceIdentity,
          pluginId: plugin.pluginId,
          plugin,
          platform: 'codex',
          scope: 'project',
          cwd: isolation.layout.fixtureCwd,
          command: 'sync',
          catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
        });
        await integration.driver.writeArtifacts(repeatTarget);
      }
    }

    const cwd = isolation.layout.fixtureCwd;
    const skillsRoot = path.join(cwd, '.agents', 'skills');
    await expect(fs.pathExists(path.join(skillsRoot, 'git-commit', 'SKILL.md')))
      .resolves.toBe(false);
    const codexPaths = resolveCodexPaths(cwd, 'project', isolation.env);
    await expect(fs.pathExists(path.join(skillsRoot, 'codex-subagent-guide', 'SKILL.md')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillsRoot, 'codex-clarifier')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillsRoot, 'requirements-clarifier')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillsRoot, 'decision-grill', 'SKILL.md')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      codexPaths.agentsDir,
      'aw-codex-enhance-codex-subagent.toml',
    ))).resolves.toBe(true);
    const codexConfig = await fs.readFile(codexPaths.configTomlPath, 'utf8');
    expect(codexConfig).not.toContain('实施前需求检查');
    expect(codexConfig).toContain('[agents.codex-subagent]');
  });

  it('does not discover a Codex plugin from a private installed manifest', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    await fs.outputJson(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'manifest-only@aw',
      'manifest.json',
    ), { id: 'manifest-only@aw', version: '2.0.0' });
    await expect(discoverRebuildTargetNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      nativeCliRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ installed: [], available: [] }),
        stderr: '',
      }),
      nativeFailureMode: 'error',
    })).resolves.not.toContain('manifest-only');
  });

  it.each(['EACCES', 'EBUSY', 'EIO'])(
    'does not read Codex private cache during discovery when readdir returns %s',
    async (code) => {
      const isolation = getCurrentSourceTestIsolation();
      await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
        'source_type = "local"',
        '',
      ].join('\n'));
      const cacheRoot = path.join(isolation.layout.codexHomeDir, 'plugins', 'cache', 'aw');
      await fs.ensureDir(cacheRoot);
      const originalReaddir = fs.readdir.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        if (path.resolve(String(args[0])) === path.resolve(cacheRoot)) {
          throw Object.assign(new Error(`injected ${code}`), { code });
        }
        return originalReaddir(...args);
      });

      await expect(discoverRebuildTargetNames({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        platform: 'codex',
        scope: 'user',
        nativeCliRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{
              pluginId: 'official-only@aw', installed: true, enabled: true, version: '1.0.0',
            }],
            available: [],
          }),
          stderr: '',
        }),
        nativeFailureMode: 'error',
      })).resolves.toContain('official-only');
    },
  );

  it('ignores an invalid Codex private installed manifest during discovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[marketplaces.aw]',
      `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
      'source_type = "local"',
      '',
    ].join('\n'));
    await fs.outputFile(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'broken@aw',
      'manifest.json',
    ), '{');

    await expect(discoverRebuildTargetNames({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      nativeCliRunner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ installed: [], available: [] }),
        stderr: '',
      }),
      nativeFailureMode: 'error',
    })).resolves.not.toContain('broken');
    await expect(fs.pathExists(path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'broken@aw',
      'manifest.json',
    ))).resolves.toBe(true);
  });

  it.each(['apps-only', 'mcp-only'] as const)(
    'installs a Codex user %s bundle without declaring a missing skills root',
    async (fixtureName) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(
          repositoryRoot,
          'packages/cli/tests/fixtures/codex-project-repo-managed/plugins',
          fixtureName,
        )],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', fixtureName), {
        mode: 'bundle',
      });
      const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
      const cacheRoot = path.join(
        isolation.layout.codexHomeDir,
        'plugins',
        'cache',
        'aw',
        fixtureName,
        plugin.manifest.version,
      );
      let installed = false;
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async (invocation) => {
            if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
              await fs.outputFile(configPath, [
                '[marketplaces.aw]',
                `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
                'source_type = "local"',
                '',
              ].join('\n'));
            }
            if (invocation.args[1] === 'add') {
              installed = true;
              await fs.appendFile(configPath, [
                `[plugins."${fixtureName}@aw"]`,
                'enabled = true',
                '',
              ].join('\n'));
              await fs.copy(
                path.join(isolation.layout.awHomeDir, 'plugins', fixtureName),
                cacheRoot,
                { overwrite: true },
              );
            }
            if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  installed: installed ? [{
                    pluginId: `${fixtureName}@aw`, installed: true,
                    enabled: true, version: plugin.manifest.version,
                  }] : [],
                  available: [],
                }),
                stderr: '',
              };
            }
            return {
              exitCode: 0,
              stdout: invocation.args[1] === 'list' && installed ? `${fixtureName}@aw\n` : '',
              stderr: '',
            };
          },
        }),
      });
      const target = await integration.buildTarget({
        plugin, platform: 'codex', scope: 'user', cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      });
      const result = await executeRebuildOperation({
        command: 'install', target, driver: integration.driver,
      });
      expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
      await expect(fs.readJson(path.join(
        isolation.layout.awHomeDir,
        'plugins',
        fixtureName,
        '.codex-plugin',
        'plugin.json',
      ))).resolves.not.toHaveProperty('skills');
      const cacheManifest = await fs.readJson(path.join(cacheRoot, '.codex-plugin', 'plugin.json'));
      expect(cacheManifest).not.toHaveProperty('skills');
      const declaredSurface = cacheManifest[fixtureName === 'apps-only' ? 'apps' : 'mcpServers'];
      expect(typeof declaredSurface).toBe('string');
      expect(await fs.pathExists(path.resolve(
        cacheRoot,
        declaredSurface,
      ))).toBe(true);
    },
  );

  it.each([
    ['EPERM', Object.assign(new Error('permission denied'), { code: 'EPERM' })],
    ['EBUSY', Object.assign(new Error('resource busy'), { code: 'EBUSY' })],
    ['EIO', Object.assign(new Error('I/O error'), { code: 'EIO' })],
    ['invalid JSON', null],
  ] as const)('preserves a Codex active manifest when reading it fails with %s', async (_label, readError) => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginName = 'apps-only';
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(
        repositoryRoot,
        'packages/cli/tests/fixtures/codex-project-repo-managed/plugins',
        pluginName,
      )],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', pluginName), {
      mode: 'bundle',
    });
    const sourceManifestPath = path.join(
      catalogRoot,
      'plugins',
      pluginName,
      '.codex-plugin',
      'plugin.json',
    );
    const originalBytes = readError === null
      ? Buffer.from('{ invalid JSON\n')
      : await fs.readFile(sourceManifestPath);
    if (readError === null) await fs.writeFile(sourceManifestPath, originalBytes);
    const destinationManifestPath = path.join(
      isolation.layout.awHomeDir,
      'plugins',
      pluginName,
      '.codex-plugin',
      'plugin.json',
    );
    const originalReadJson = fs.readJson.bind(fs);
    const readJson = readError === null ? null : vi.spyOn(fs, 'readJson').mockImplementation(
      async (...args: Parameters<typeof fs.readJson>) => {
        if (path.normalize(String(args[0])).endsWith(path.join(
          'plugins', pluginName, '.codex-plugin', 'plugin.json',
        ))) throw readError;
        return originalReadJson(...args);
      },
    );
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ installed: [], available: [] }),
              stderr: '',
            };
          }
          throw new Error('native runner must not run after manifest read failure');
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    });

    const write = integration.driver.writeNative(target);
    if (readError === null) await expect(write).rejects.toThrow();
    else await expect(write).rejects.toMatchObject({ code: readError.code });
    readJson?.mockRestore();
    await expect(fs.readFile(destinationManifestPath)).resolves.toEqual(originalBytes);
  });

  it.each([
    ['static', path.join(repositoryRoot, 'plugins', 'git-toolkit')],
    ['slash', path.join(
      repositoryRoot,
      'packages/cli/tests/fixtures/codex-project-repo-managed/plugins/slashCommands-only',
    )],
  ] as const)('reinstalls Codex user %s Skills before native cache creation', async (_kind, pluginRoot) => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [pluginRoot],
    });
    const pluginName = (await fs.readJson(path.join(
      pluginRoot,
      '.agents-plugin',
      'plugin.json',
    ))).name as string;
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', pluginName), {
      mode: 'bundle',
    });
    const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
    const cacheRoot = path.join(
      isolation.layout.codexHomeDir,
      'plugins',
      'cache',
      'aw',
      pluginName,
      plugin.manifest.version,
    );
    let installed = false;
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
        await fs.outputFile(configPath, [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
      } else if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
        await fs.outputFile(configPath, '');
      } else if (invocation.args[1] === 'add') {
        installed = true;
        await fs.appendFile(configPath, [
          `[plugins."${pluginName}@aw"]`,
          'enabled = true',
          '',
        ].join('\n'));
        await fs.copy(
          path.join(isolation.layout.awHomeDir, 'plugins', pluginName),
          cacheRoot,
          { overwrite: true },
        );
      } else if (invocation.args[1] === 'remove') {
        installed = false;
        await fs.outputFile(configPath, [
          '[marketplaces.aw]',
          `source = ${JSON.stringify(isolation.layout.awHomeDir)}`,
          'source_type = "local"',
          '',
        ].join('\n'));
        await fs.remove(path.join(isolation.layout.codexHomeDir, 'plugins', 'cache', 'aw', pluginName));
      }
      if (invocation.args[1] === 'list' && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: `${pluginName}@aw`, installed: true,
              enabled: true, version: plugin.manifest.version,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: invocation.args[1] === 'list' && installed ? `${pluginName}@aw\n` : '',
        stderr: '',
      };
    };
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const build = (command: 'install' | 'reinstall') => integration.buildTarget({
      plugin, platform: 'codex' as const, scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd, command,
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    });
    const installedTarget = await build('install');
    expect((await executeRebuildOperation({
      command: 'install', target: installedTarget, driver: integration.driver,
    })).status).toBe('succeeded');
    const reinstallTarget = await build('reinstall');
    const result = await executeRebuildOperation({
      command: 'reinstall', target: reinstallTarget, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    if (_kind === 'slash') {
      expect(installedTarget.requiresNative).toBe(false);
      expect(reinstallTarget.requiresNative).toBe(false);
      expect(await fs.pathExists(cacheRoot)).toBe(false);
      return;
    }
    const cacheManifest = await fs.readJson(path.join(cacheRoot, '.codex-plugin', 'plugin.json'));
    const skillsRoot = cacheManifest.skills.replace(/^\.\//u, '');
    const sourceSkills = path.join(plugin.rootDir, ...skillsRoot.split('/'));
    const skillKeys = await fs.readdir(sourceSkills);
    expect(skillKeys.length).toBeGreaterThan(0);
    for (const key of skillKeys) {
      const cachedSkillRoot = path.join(cacheRoot, ...skillsRoot.split('/'), key);
      await expect(fs.readFile(path.join(cachedSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toBe(await fs.readFile(path.join(sourceSkills, key, 'SKILL.md'), 'utf8'));
      await expect(fs.pathExists(path.join(cachedSkillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
    }
  });

  it('fails project cleanup when malformed Codex config contains target AW ownership evidence', async () => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = await fs.realpath(isolation.layout.fixtureCwd);
      const plugin: PluginMeta = {
        rootDir: path.join(isolation.layout.rootDir, 'corrupted-owned'),
        manifestPath: path.join(isolation.layout.rootDir, 'corrupted-owned', '.agents-plugin', 'plugin.json'),
        manifest: {
          name: 'corrupted-owned',
          version: '1.0.0',
          description: 'corrupted owned fixture',
          schemaVersion: 3,
          marketplace: {
            category: 'test', strict: true,
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          },
        },
      };
      const codexPaths = resolveCodexPaths(cwd, 'project', isolation.env);
      const targetPath = codexPaths.configTomlPath;
      await fs.outputFile(
        targetPath,
        'developer_instructions = "[[aw-managed:start plugin=\\"corrupted-owned\\" kind=\\"developer_instructions\\"]]"\n[bad\n',
      );
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => { throw new Error('project cleanup must not call native'); },
        }),
      });
      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope: 'project',
        cwd,
        command: 'cleanup',
        catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      });
      const result = await executeRebuildOperation({
        command: 'cleanup', target, driver: integration.driver,
      });
      expect(result.status).toBe('failed');
      expect(result.residual).toContain(targetPath);
      expect(await fs.pathExists(targetPath)).toBe(true);
  });

  it('does not read the legacy Codex project hook surface during cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const hooksPath = path.join(cwd, '.codex', 'hooks.json');
    const legacyHooks = `{"hooks":[{"command":"${OWNED_TEXT_HEADER_PREFIX}{\\"schemaVersion\\":1,\\"owner\\":\\"agent-workflows\\",\\"plugin\\":\\"legacy-hook\\"}`;
    await fs.outputFile(hooksPath, legacyHooks);
    await expect(discoverRebuildTargetNames({
      cwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      nativeCliRunner: async () => { throw new Error('legacy hooks must not call native'); },
    })).resolves.toEqual([]);
    await expect(fs.readFile(hooksPath, 'utf8')).resolves.toBe(legacyHooks);
  });

  it('cleans a removed-catalog Claude project from its canonical scoped installed record', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const paths = resolveClaudePaths(cwd, 'project', isolation.env);
    const projectPath = await resolveClaudeProjectKey(cwd);
    await fs.outputJson(paths.knownMarketplacesPath, {
      marketplaces: { aw: { installLocation: isolation.layout.awHomeDir } },
    });
    await fs.outputJson(paths.installedPluginsPath, {
      plugins: {
        'removed-claude@aw': [{
          name: 'removed-claude', marketplace: 'aw', scope: 'project', projectPath, version: '4.2.0',
        }],
        'other-project@aw': [{
          name: 'other-project', marketplace: 'aw', scope: 'project',
          projectPath: path.join(path.dirname(projectPath), 'other'), version: '1.0.0',
        }],
      },
    });
    const plugin: PluginMeta = {
      rootDir: path.join(isolation.layout.rootDir, 'removed-claude'),
      manifestPath: path.join(isolation.layout.rootDir, 'removed-claude', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'removed-claude', version: '0.0.0', description: 'removed catalog fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test', strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    };
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'uninstall') {
            const state = await fs.readJson(paths.installedPluginsPath);
            delete state.plugins['removed-claude@aw'];
            await fs.writeJson(paths.installedPluginsPath, state);
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'project', cwd, command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain('claude plugin uninstall removed-claude@aw --scope project');
    expect(await fs.pathExists(path.join(isolation.layout.awHomeDir, 'plugins', 'removed-claude'))).toBe(false);
  });

  it.each([
    {
      label: 'different plugins in user and project scopes',
      remainingName: 'other-claude',
      remainingScope: 'project' as const,
    },
    {
      label: 'the same plugin in user and project scopes',
      remainingName: 'shared-claude',
      remainingScope: 'project' as const,
    },
    {
      label: 'a plugin in local scope',
      remainingName: 'local-claude',
      remainingScope: 'local' as const,
    },
  ])('keeps the Claude marketplace for $label', async ({ remainingName, remainingScope }) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginName = remainingName === 'shared-claude' ? remainingName : 'removed-claude';
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, pluginName);
    const paths = resolveClaudePaths(cwd, 'user', isolation.env);
    const targetRecord = {
      name: pluginName, marketplace: 'aw', scope: 'user' as const, version: '1.0.0',
    };
    const remainingRecord = {
      name: remainingName,
      marketplace: 'aw',
      scope: remainingScope,
      projectPath: path.join(path.dirname(cwd), 'other-project'),
      version: '1.0.0',
    };
    await writeClaudeGlobalConsumerState({
      cwd,
      env: isolation.env,
      plugins: pluginName === remainingName
        ? { [`${pluginName}@aw`]: [targetRecord, remainingRecord] }
        : {
            [`${pluginName}@aw`]: [targetRecord],
            [`${remainingName}@aw`]: [remainingRecord],
          },
    });
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'uninstall') {
            const state = await fs.readJson(paths.installedPluginsPath);
            const records = state.plugins[`${pluginName}@aw`] as Array<Record<string, unknown>>;
            const remaining = records.filter((record) => record.scope !== 'user');
            if (remaining.length > 0) state.plugins[`${pluginName}@aw`] = remaining;
            else delete state.plugins[`${pluginName}@aw`];
            await fs.writeJson(paths.installedPluginsPath, state);
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain(`claude plugin uninstall ${pluginName}@aw --scope user`);
    expect(calls).not.toContain('claude plugin marketplace remove aw');
    expect((await fs.readJson(paths.installedPluginsPath)).plugins[`${remainingName}@aw`])
      .toEqual(expect.arrayContaining([expect.objectContaining({ scope: remainingScope })]));
  });

  it('recognizes an explicit Claude marketplace key and re-reads consumers after uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginName = 'removed-claude';
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, pluginName);
    const paths = resolveClaudePaths(cwd, 'user', isolation.env);
    await writeClaudeGlobalConsumerState({
      cwd,
      env: isolation.env,
      plugins: {
        [`${pluginName}@aw`]: [{
          name: pluginName, scope: 'user', version: '1.0.0',
        }],
      },
    });
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'uninstall') {
            const state = await fs.readJson(paths.installedPluginsPath);
            delete state.plugins[`${pluginName}@aw`];
            state.plugins['late-consumer@aw'] = [{
              name: 'late-consumer',
              marketplace: 'aw',
              scope: 'project',
              projectPath: path.join(path.dirname(cwd), 'late-project'),
              version: '1.0.0',
            }];
            await fs.writeJson(paths.installedPluginsPath, state);
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('claude plugin marketplace remove aw');
    expect((await fs.readJson(paths.installedPluginsPath)).plugins['late-consumer@aw']).toHaveLength(1);
  });

  it.each([
    ['enabledPlugins', { enabledPlugins: { 'late-consumer@aw': true } }],
    ['settings.plugins.installed', {
      plugins: {
        installed: {
          'late-consumer': {
            version: '1.0.0',
            marketplace: 'aw',
            scope: 'user',
          },
        },
      },
    }],
  ])('keeps the Claude marketplace for a late %s residue', async (_label, residue) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginName = 'removed-claude';
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, pluginName);
    const paths = resolveClaudePaths(cwd, 'user', isolation.env);
    await writeClaudeGlobalConsumerState({
      cwd,
      env: isolation.env,
      plugins: {
        [`${pluginName}@aw`]: [{
          name: pluginName, marketplace: 'aw', scope: 'user', version: '1.0.0',
        }],
      },
    });
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'uninstall') {
            const installed = await fs.readJson(paths.installedPluginsPath);
            delete installed.plugins[`${pluginName}@aw`];
            await fs.writeJson(paths.installedPluginsPath, installed);
            const settings = await fs.readJson(paths.settingsPath);
            await fs.writeJson(paths.settingsPath, { ...settings, ...residue });
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });

    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });

    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('claude plugin marketplace remove aw');
  });

  it('reinstalls Claude plugin A while same-scope plugin B keeps the marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), {
      mode: 'bundle',
    });
    const paths = resolveClaudePaths(cwd, 'user', isolation.env);
    const pluginA = plugin.manifest.name;
    const pluginB = 'same-scope-claude-consumer';
    let installedA = true;
    const writeState = async () => {
      const sourceDescriptor = {
        source: 'directory',
        path: isolation.layout.awHomeDir,
      };
      await fs.outputJson(paths.settingsPath, {
        extraKnownMarketplaces: { aw: { source: sourceDescriptor } },
        enabledPlugins: {
          ...(installedA ? { [`${pluginA}@aw`]: true } : {}),
          [`${pluginB}@aw`]: true,
        },
      });
      await fs.outputJson(paths.knownMarketplacesPath, {
        aw: {
          source: sourceDescriptor,
          installLocation: isolation.layout.awHomeDir,
        },
      });
      await fs.outputJson(paths.installedPluginsPath, {
        plugins: {
          ...(installedA ? {
            [`${pluginA}@aw`]: [{
              name: pluginA, marketplace: 'aw', scope: 'user', version: plugin.manifest.version,
            }],
          } : {}),
          [`${pluginB}@aw`]: [{
            name: pluginB, marketplace: 'aw', scope: 'user', version: '1.0.0',
          }],
        },
      });
    };
    await writeState();
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'uninstall') {
            installedA = false;
            await writeState();
          }
          if (invocation.args[1] === 'install') {
            installedA = true;
            await writeState();
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'reinstall',
      catalog: { rootDir: catalogRoot, source: 'local' },
    });
    const result = await executeRebuildOperation({
      command: 'reinstall', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('claude plugin marketplace remove aw');
    expect((await fs.readJson(paths.installedPluginsPath)).plugins[`${pluginB}@aw`]).toHaveLength(1);
  });

  it('preserves the shared Claude marketplace after the last current consumer is uninstalled', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginName = 'last-claude';
    const plugin = createClaudeCleanupPlugin(isolation.layout.rootDir, pluginName);
    const paths = resolveClaudePaths(cwd, 'user', isolation.env);
    await writeClaudeGlobalConsumerState({
      cwd,
      env: isolation.env,
      plugins: {
        [`${pluginName}@aw`]: [{
          name: pluginName, marketplace: 'aw', scope: 'user', version: '1.0.0',
        }],
        'foreign-plugin@foreign': [{
          name: 'foreign-plugin', marketplace: 'foreign', scope: 'project',
          projectPath: path.join(path.dirname(cwd), 'foreign-project'), version: '1.0.0',
        }],
      },
    });
    const calls: string[] = [];
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          calls.push([invocation.command, ...invocation.args].join(' '));
          if (invocation.args[1] === 'uninstall') {
            const state = await fs.readJson(paths.installedPluginsPath);
            delete state.plugins[`${pluginName}@aw`];
            await fs.writeJson(paths.installedPluginsPath, state);
          }
          if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
            await fs.outputJson(paths.settingsPath, { extraKnownMarketplaces: {} });
            await fs.outputJson(paths.knownMarketplacesPath, { marketplaces: {} });
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain('claude plugin uninstall last-claude@aw --scope user');
    expect(calls).not.toContain('claude plugin marketplace remove aw');
  });

  it('reports malformed Claude native JSON and rejects an installed version mismatch', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'ask-me')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'ask-me'), { mode: 'bundle' });
    const paths = resolveClaudePaths(cwd, 'user', isolation.env);
    await fs.outputFile(paths.installedPluginsPath, '{bad');
    const noCalls: string[] = [];
    let integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          noCalls.push(invocation.command);
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    let target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'cleanup',
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    });
    const malformed = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver,
    });
    expect(malformed.status).toBe('failed');
    expect(malformed.failures.some((failure) => failure.message.includes('installed_plugins'))).toBe(true);
    expect(noCalls).toEqual([]);

    await fs.remove(paths.installedPluginsPath);
    integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async (invocation) => {
          if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
            await writeClaudeNativeState({
              cwd, env: isolation.env, pluginName: plugin.manifest.name,
              pluginVersion: '9.9.9', scope: 'user', installed: false,
            });
          }
          if (invocation.args[1] === 'install') {
            await writeClaudeNativeState({
              cwd, env: isolation.env, pluginName: plugin.manifest.name,
              pluginVersion: '9.9.9', scope: 'user', installed: true,
            });
          }
          if (invocation.args[1] === 'uninstall') {
            await writeClaudeNativeState({
              cwd, env: isolation.env, pluginName: plugin.manifest.name,
              pluginVersion: '9.9.9', scope: 'user', installed: false,
            });
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    target = await integration.buildTarget({
      plugin, platform: 'claude', scope: 'user', cwd, command: 'install',
      catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    });
    const mismatch = await executeRebuildOperation({
      command: 'install', target, driver: integration.driver,
    });
    expect(mismatch.status).toBe('failed');
    expect(mismatch.failures.some((failure) => failure.message.includes('versions=9.9.9'))).toBe(true);
  });
});
