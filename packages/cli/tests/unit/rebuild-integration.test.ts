import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  applyCodexHookGroupsTransactionFile,
  createRebuildIntegration,
  discoverRebuildTargetNames,
  inspectRebuildTarget,
} from '../../src/commands/rebuild-integration.js';
import { statusCommand } from '../../src/commands/status.js';
import {
  executeRebuildOperation,
  type RebuildActiveStore,
} from '../../src/commands/rebuild-operations.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { CatalogResolution, CodexSharedHookGroup, PluginMeta } from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import {
  OWNED_TEXT_HEADER_PREFIX,
  inspectOwnedComponents,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  writeOwnedTextFile,
} from '../../src/utils/ownership.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import {
  prepareLifecycleActiveSnapshot,
  promoteLifecycleActiveSnapshot,
} from '../../src/utils/lifecycle-active-store.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
} from '../../src/utils/paths.js';
import { requiresCodexNativePlugin } from '../../src/utils/codex-project-surface.js';
import {
  resolveConfigFileLockPath,
} from '../../src/utils/plugin-config.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
} from '../../src/utils/codex-config.js';
import { renderTrackedHookGroupIdentity } from '../../src/utils/hooks-contract.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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
}): Promise<void> {
  const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
  const awHome = options.env.AW_HOME!;
  const source = options.canonical === false ? path.join(path.dirname(awHome), 'foreign') : awHome;
  const projectPath = options.scope === 'project'
    ? await resolveClaudeProjectKey(options.cwd)
    : undefined;
  if (options.installed) {
    await fs.ensureDir(path.join(awHome, 'plugins', options.pluginName));
  }
  await fs.outputJson(paths.settingsPath, {
    extraKnownMarketplaces: { aw: { source } },
    plugins: {
      installed: options.installed ? {
        [options.pluginName]: {
          marketplace: 'aw',
          version: options.pluginVersion,
          installedAt: new Date(0).toISOString(),
          scope: options.scope,
          ...(projectPath ? { projectPath } : {}),
          enabled: true,
        },
      } : {},
    },
  });
  await fs.outputJson(paths.knownMarketplacesPath, {
    marketplaces: { aw: { installLocation: source, source } },
  });
  await fs.outputJson(paths.installedPluginsPath, {
    plugins: options.installed ? {
      [`${options.pluginName}@aw`]: [{
        name: options.pluginName,
        marketplace: 'aw',
        scope: options.scope,
        ...(projectPath ? { projectPath } : {}),
        version: options.pluginVersion,
      }],
    } : {},
  });
}

function createClaudeCleanupPlugin(root: string, name: string): PluginMeta {
  return {
    rootDir: path.join(root, name),
    manifestPath: path.join(root, name, '.agents-plugin', 'plugin.json'),
    manifest: {
      name,
      version: '0.0.0',
      description: 'Claude cleanup fixture',
      compatibility: { aw: { minVersion: '0.1.0' } },
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
    scope: 'user' | 'project';
    projectPath?: string;
    version: string;
  }>>;
}): Promise<void> {
  const paths = resolveClaudePaths(options.cwd, 'user', options.env);
  await fs.outputJson(paths.settingsPath, {
    extraKnownMarketplaces: { aw: { source: options.env.AW_HOME } },
  });
  await fs.outputJson(paths.knownMarketplacesPath, {
    marketplaces: { aw: { installLocation: options.env.AW_HOME } },
  });
  await fs.outputJson(paths.installedPluginsPath, { plugins: options.plugins });
}

describe('rebuild adapter integration', () => {
  it.each([
    { hooks: [{ event: 'session_start' as const, command: 'node hook.js' }] },
    { nativeHooks: { codex: [{ event: 'Stop', command: 'node hook.js' }] } },
  ])('requires Codex native installation for user hook surfaces', (extensions) => {
    const plugin = createClaudeCleanupPlugin('/tmp', 'hook-native');
    plugin.manifest.marketplace.policy.products = ['CODEX'];
    plugin.manifest.extensions = extensions;
    expect(requiresCodexNativePlugin(plugin, 'user')).toBe(true);
  });

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
          nativeCliRunner: async () => { throw new Error('native list must not authorize ownership'); },
        }),
      });
      expect(inspected.inspection.state).toBe('absent');
    },
  );

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
            return { exitCode: 0, stdout: '', stderr: '' };
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
        includeHistoricalLifecycleArtifacts: false,
      });
      const inspected = await inspectOwnedComponents({
        components: target.ownedComponents,
        nativeProbe: integration.driver.probeNative,
      });
      expect(inspected.state).toBe('absent');
      const result = await executeRebuildOperation({
        command, target, driver: integration.driver, activeStore,
      });
      expect(result.status).toBe('failed');
      expect(result.failures.some((failure) => failure.message.includes('foreign source'))).toBe(true);
      expect(calls.some((call) => call.includes('plugin marketplace add'))).toBe(false);
    },
  );

  it.each(['codex', 'claude'] as const)(
    'reports a validated stale %s native version as partial',
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
          nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        }),
      });
      expect(inspected.inspection.state).toBe('partial');
    },
  );

  const activeStore = {
    prepare: async () => ({ status: 'not-required' }),
    discard: async () => undefined,
    promote: async () => null,
    read: async () => null,
    remove: async () => undefined,
  } as unknown as RebuildActiveStore;

  it('plans Claude artifacts before writes and uses native marketplace/install/list ownership', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(isolation.layout.rootDir, 'simple-plugin');
    const pluginRoot = sourceRoot;
    await fs.ensureDir(pluginRoot);
    const plugin: PluginMeta = {
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'simple-plugin',
        version: '1.2.3',
        description: 'rebuild integration fixture',
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: true,
    });
    expect(target.artifacts).toHaveLength(1);
    expect(await fs.pathExists(target.artifacts[0]!.path)).toBe(false);

    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
      activeStore,
    });

    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain('claude plugin marketplace add ' + isolation.layout.awHomeDir + ' --scope user');
    expect(calls).toContain('claude plugin install simple-plugin@aw --scope user');
    expect(calls.filter((call) => call === 'claude plugin list --scope user')).toHaveLength(1);
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
        plugin: 'removed-plugin',
        artifactKey: 'owned-rule',
        platform: 'codex',
        scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });
    await fs.writeFile(foreignPath, 'foreign\n');
    const plugin: PluginMeta = {
      rootDir: '.',
      manifestPath: '.agents-plugin/plugin.json',
      manifest: {
        name: 'removed-plugin',
        version: '0.0.0',
        description: 'cleanup-only target',
        compatibility: { aw: { minVersion: '0.0.0' } },
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
      includeHistoricalLifecycleArtifacts: true,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup',
      target,
      driver: integration.driver,
      activeStore,
    });

    expect(result).toMatchObject({ status: 'succeeded' });
    expect(await fs.pathExists(ownedPath)).toBe(false);
    expect(await fs.readFile(foreignPath, 'utf8')).toBe('foreign\n');
  });

  it('inspects absent, partial, and present ownership without writing target files', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const plugin: PluginMeta = {
      rootDir: path.join(isolation.layout.rootDir, 'read-only-plugin'),
      manifestPath: path.join(isolation.layout.rootDir, 'read-only-plugin', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'read-only-plugin',
        version: '1.0.0',
        description: 'read-only inspection fixture',
        compatibility: { aw: { minVersion: '0.1.0' } },
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

  it('does not discover or inspect active-only lifecycle state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const activeMetadataPath = path.join(
      isolation.layout.awHomeDir,
      'lifecycle-active',
      'codex',
      'project',
      'active-only-location',
      'active-only-plugin',
      'active',
      'metadata.json',
    );
    await fs.outputJson(activeMetadataPath, {
      platform: 'codex',
      scope: 'project',
      pluginName: 'active-only-plugin',
      projectKey: cwd,
    });
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => { throw new Error('project discovery must not call native CLI'); },
    });
    await expect(discoverRebuildTargetNames({
      cwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      nativeCliRunner: context.nativeCliRunner,
    })).resolves.not.toContain('active-only-plugin');

    const plugin: PluginMeta = {
      rootDir: '.',
      manifestPath: '.agents-plugin/plugin.json',
      manifest: {
        name: 'active-only-plugin',
        version: '1.0.0',
        description: 'active-only inspection fixture',
        compatibility: { aw: { minVersion: '0.1.0' } },
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    };
    const inspected = await inspectRebuildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      catalog: { rootDir: cwd, source: 'local' } as CatalogResolution,
      context,
    });
    expect(inspected.inspection.state).toBe('absent');
    expect(inspected.target.ownedComponents).toHaveLength(0);
    expect(await fs.pathExists(activeMetadataPath)).toBe(true);
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
        compatibility: { aw: { minVersion: '0.1.0' } },
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

  it('classifies present-or-disabled artifacts as optional without invoking the renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const plugin = {
      rootDir: path.join(isolation.layout.rootDir, 'optional-plan'),
      manifestPath: path.join(isolation.layout.rootDir, 'optional-plan', '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'optional-plan',
        version: '1.0.0',
        description: 'optional planner fixture',
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
      readOnlyInspectionPlan: true,
    });
    expect(target.desiredOwnedComponents).toEqual([]);
    expect(target.optionalOwnedComponents?.map((component) => component.identity.artifactKey))
      .toEqual(expect.arrayContaining(['optional-skill', 'optional-role', 'developer-instructions']));
    expect(target.optionalOwnedComponents?.map((component) => component.identity.artifactKey))
      .not.toContain('disabled-only');
  });

  it('does not call native list during Claude owner discovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rulePath = path.join(isolation.layout.claudeHomeDir, 'rules', 'owned.md');
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: isolation.layout.claudeHomeDir,
      identity: {
        owner: 'agent-workflows',
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
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    })).rejects.toThrow('符号链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each([
    ['codex', '.codex/config.toml'],
    ['codex', '.codex/hooks.json'],
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
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    })).rejects.toThrow('符号链接');
    expect(await fs.readFile(outside, 'utf8')).toBe('foreign\n');
  });

  it('materializes static Codex project skills with owner markers and rejects apps', async () => {
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
      compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
      activeStore,
    });
    const skillRoot = path.join(cwd, '.agents', 'skills', 'repo-check');
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).toContain('Repo check');
    expect(await readSkillOwnerMarker({
      skillRoot,
      allowedRoot: path.dirname(skillRoot),
    })).toMatchObject({ plugin: 'project-skill-plugin', artifactKey: 'repo-check' });

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
      includeHistoricalLifecycleArtifacts: false,
    })).rejects.toThrow('不支持 apps');
  });

  it.each([
    { extraPayload: false, rootManifest: false },
    { extraPayload: false, rootManifest: true },
    { extraPayload: true, rootManifest: false },
  ])(
    'validates exact Codex native cache payload ($extraPayload, root manifest: $rootManifest)',
    async ({ extraPayload, rootManifest }) => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'git-commit')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-commit'), {
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
      activeStore,
    });
    if (extraPayload) {
      expect(result.status).toBe('failed');
      expect(result.failures.some((failure) =>
        failure.message.includes('unexpected loadable payload'))).toBe(true);
      return;
    }
    expect(result.status).toBe('succeeded');
    expect(calls).toContain(`codex plugin marketplace add ${isolation.layout.awHomeDir}`);
    expect(calls).toContain(`codex plugin add ${plugin.manifest.name}@aw`);
    expect(await fs.pathExists(rootManifest
      ? path.join(path.dirname(path.dirname(cacheManifestPath)), 'plugin.json')
      : cacheManifestPath)).toBe(true);
  });

  it.each(['codex-explore', 'codex-subagent-guide'])(
    'installs %s dynamic user Skills through the active manifest and real cache copy',
    async (pluginName) => {
      const isolation = getCurrentSourceTestIsolation();
      const catalogRoot = await createSyntheticCatalog({
        root: isolation.layout.rootDir,
        pluginRoots: [path.join(repositoryRoot, 'plugins', pluginName)],
      });
      const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', pluginName), {
        mode: 'bundle',
      });
      const configPath = path.join(isolation.layout.codexHomeDir, 'config.toml');
      let installed = false;
      const runner: NativeCliRunner = async (invocation) => {
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
            `[plugins."${pluginName}@aw"]`,
            'enabled = true',
            '',
          ].join('\n'));
          await fs.copy(
            path.join(isolation.layout.awHomeDir, 'plugins', pluginName),
            path.join(
              isolation.layout.codexHomeDir,
              'plugins',
              'cache',
              'aw',
              pluginName,
              plugin.manifest.version,
            ),
            { overwrite: true },
          );
        }
        return {
          exitCode: 0,
          stdout: invocation.args[1] === 'list' && installed ? `${pluginName}@aw\n` : '',
          stderr: '',
        };
      };
      const integration = createRebuildIntegration({
        context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
        scriptTimeoutMs: 30_000,
      });
      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
        includeHistoricalLifecycleArtifacts: false,
      });
      const result = await executeRebuildOperation({
        command: 'install', target, driver: integration.driver, activeStore,
      });
      expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
      const skillArtifact = target.artifacts.find((artifact) =>
        artifact.target === 'codex.skill' && artifact.state !== 'disabled');
      expect(skillArtifact?.artifactKey).toBeTruthy();
      expect(await fs.pathExists(path.join(
        isolation.layout.codexHomeDir,
        'plugins',
        'cache',
        'aw',
        pluginName,
        plugin.manifest.version,
        'codex',
        'skills',
        skillArtifact!.artifactKey!,
        'SKILL.md',
      ))).toBe(true);
    },
  );

  it('preserves foreign same-name Codex project skills and role registrations', async () => {
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
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
      activeStore,
    });
    expect(result.status).toBe('failed');
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
      includeHistoricalLifecycleArtifacts: false,
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
      includeHistoricalLifecycleArtifacts: false,
    })).rejects.toThrow('roleNameConflict');
  });

  it('fails Codex project preflight on unreadable config and external user ownership', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const plugin = {
      rootDir: isolation.layout.rootDir,
      manifestPath: path.join(isolation.layout.rootDir, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'safety-plugin',
        version: '1.0.0',
        description: 'project safety fixture',
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), '[broken');
    await expect(build()).rejects.toThrow('codexProjectUserConfigUnreadable');

    await fs.outputFile(path.join(isolation.layout.codexHomeDir, 'config.toml'), [
      '[plugins."safety-plugin@external"]',
      'enabled = true',
      '',
    ].join('\n'));
    await expect(build()).rejects.toThrow('externalOwnershipPresent');

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
      includeHistoricalLifecycleArtifacts: false,
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
    })).resolves.toMatchObject({ inspection: { state: 'absent' } });

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
      includeHistoricalLifecycleArtifacts: false,
    })).rejects.toThrow('roleNameConflict');
  });

  it('cleans stale Claude awGenerated permissions and preserves manual permissions', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const settingsPath = path.join(isolation.layout.claudeHomeDir, 'settings.json');
    await fs.outputJson(settingsPath, {
      permissions: { allow: ['Manual', 'OldGenerated', 'OtherGenerated'] },
      awGenerated: {
        permissions: {
          'stale-permission': { allow: ['OldGenerated'], ask: [], deny: [] },
          other: { allow: ['OtherGenerated'], ask: [], deny: [] },
        },
        manualPermissions: { allow: ['Manual'], ask: [], deny: [] },
      },
    });
    const plugin = {
      rootDir: isolation.layout.rootDir,
      manifestPath: path.join(isolation.layout.rootDir, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'stale-permission',
        version: '0.0.0',
        description: 'stale permission cleanup fixture',
        compatibility: { aw: { minVersion: '0.0.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup',
      target,
      driver: integration.driver,
      activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    const settings = await fs.readJson(settingsPath);
    expect(settings.awGenerated.permissions).toEqual({
      other: { allow: ['OtherGenerated'], ask: [], deny: [] },
    });
    expect(settings.permissions.allow).toEqual(['Manual', 'OtherGenerated']);
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
          await fs.outputJson(paths.settingsPath, { plugins: { installed: {} } });
          await fs.outputJson(paths.knownMarketplacesPath, { marketplaces: {} });
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
        includeHistoricalLifecycleArtifacts: false,
      });
      const installedResult = await executeRebuildOperation({
        command: 'install', target: installTarget, driver: integration.driver, activeStore,
      });
      expect(installedResult.status, JSON.stringify(installedResult.failures)).toBe('succeeded');

      const uninstallTarget = await integration.buildTarget({
        plugin,
        platform: 'claude',
        scope,
        cwd,
        command: 'uninstall',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
        includeHistoricalLifecycleArtifacts: false,
      });
      const uninstalledResult = await executeRebuildOperation({
        command: 'uninstall', target: uninstallTarget, driver: integration.driver, activeStore,
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
        includeHistoricalLifecycleArtifacts: false,
      });
      const beforeForeignCalls = calls.length;
      const foreignResult = await executeRebuildOperation({
        command: 'cleanup', target: foreignTarget, driver: integration.driver, activeStore,
      });
      expect(foreignResult.status).toBe('failed');
      expect(calls.slice(beforeForeignCalls)).not.toContain(
        `claude plugin uninstall ${plugin.manifest.name}@aw --scope ${scope}`,
      );
    },
  );

  it('fails a Codex native install without cache and performs one cleanup pass', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'git-commit')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-commit'), {
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
      activeStore,
    });
    expect(result.status).toBe('failed');
    expect(result.cleanupAttempted).toBe(true);
    expect(calls.filter((call) => call === `codex plugin remove ${plugin.manifest.name}@aw`)).toHaveLength(1);
    expect(calls.filter((call) => call === 'codex plugin marketplace remove aw')).toHaveLength(1);
    expect(installed).toBe(false);
    expect(marketplace).toBe(false);
  });

  it('reports Codex native residue when list is empty and preserves the marketplace', async () => {
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
          return { exitCode: 0, stdout: '', stderr: '' };
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
        compatibility: { aw: { minVersion: '0.0.0' } },
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      command: 'cleanup',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status).toBe('failed');
    expect(result.residual).toEqual(expect.arrayContaining([`${pluginName}@aw`]));
    expect(calls).toContain(`codex plugin remove ${pluginName}@aw`);
    expect(calls).not.toContain('codex plugin marketplace remove aw');
    expect(await fs.pathExists(cacheRoot)).toBe(true);
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status).toBe('failed');
    expect(result.residual).toContain(`${pluginName}@aw`);
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
        stdout: '',
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
        compatibility: { aw: { minVersion: '0.0.0' } },
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    } as PluginMeta;
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const first = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(first.status).toBe('succeeded');
    expect(calls).not.toContain('codex plugin marketplace remove aw');

    otherInstalled = false;
    await writeMarketplace();
    const second = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(second.status, JSON.stringify(second.failures)).toBe('succeeded');
    expect(calls).toContain('codex plugin marketplace remove aw');
  });

  it('reinstalls Codex plugin A while same-scope plugin B keeps the marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const catalogRoot = await createSyntheticCatalog({
      root: isolation.layout.rootDir,
      pluginRoots: [path.join(repositoryRoot, 'plugins', 'git-commit')],
    });
    const plugin = await readPluginManifest(path.join(catalogRoot, 'plugins', 'git-commit'), {
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
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({ env: isolation.env, nativeCliRunner: runner }),
    });
    const target = await integration.buildTarget({
      plugin, platform: 'codex', scope: 'user', cwd: isolation.layout.fixtureCwd,
      command: 'reinstall',
      catalog: { rootDir: catalogRoot, source: 'local' },
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'reinstall', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('codex plugin marketplace remove aw');
    expect(await fs.readFile(configPath, 'utf8')).toContain(`${pluginB}@aw`);
  });

  it('scans and cleans the custom Codex user skills root from the platform manifest', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const pluginRoot = path.join(isolation.layout.rootDir, 'custom-root-plugin');
    const plugin = {
      rootDir: pluginRoot,
      manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      manifest: {
        name: 'custom-root-plugin',
        version: '1.0.0',
        description: 'custom root fixture',
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(await fs.pathExists(skillRoot)).toBe(false);
  });

  it('materializes a generated slash command as a Codex project skill', async () => {
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'install',
      target,
      driver: integration.driver,
      activeStore,
    });
    const generatedSkill = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'review',
      'SKILL.md',
    );
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(await fs.readFile(generatedSkill, 'utf8')).toContain('# Review');
    expect(await readSkillOwnerMarker({
      skillRoot: path.dirname(generatedSkill),
      allowedRoot: path.dirname(path.dirname(generatedSkill)),
    })).toMatchObject({ plugin: 'slash-commands-only' });
  });

  it('writes the Codex project instruction, MCP, hook, permission, and agent surfaces', async () => {
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
        includeHistoricalLifecycleArtifacts: false,
      });
      const result = await executeRebuildOperation({
        command: 'install',
        target,
        driver: integration.driver,
        activeStore,
      });
      expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    }
    const config = await fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      'utf8',
    );
    expect(config).toContain('extensions-only');
    expect(config).toContain('mcp_servers');
    expect(await fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'hooks.json'))).toBe(true);
    expect((await fs.readdir(path.join(isolation.layout.fixtureCwd, '.codex', 'rules'))).length).toBeGreaterThan(0);
    expect((await fs.readdir(path.join(isolation.layout.fixtureCwd, '.codex', 'agents'))).length).toBeGreaterThan(0);
  });

  it('serializes a hook removal with another plugin hook addition', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const pluginA = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'hook-atomic-a',
      hookCommand: 'echo hook-a',
    });
    const pluginB = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'hook-atomic-b',
      hookCommand: 'echo hook-b',
    });
    const installedA = await integration.buildTarget({
      plugin: pluginA, platform: 'codex', scope: 'project', cwd,
      command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    await integration.driver.writeArtifacts(installedA);
    const cleanupA = await integration.buildTarget({
      plugin: { ...pluginA, manifest: { ...pluginA.manifest, extensions: undefined } },
      platform: 'codex', scope: 'project', cwd,
      command: 'cleanup', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    const installingB = await integration.buildTarget({
      plugin: pluginB, platform: 'codex', scope: 'project', cwd,
      command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    const hookComponent = cleanupA.ownedComponents.find((component) =>
      component.kind === 'shared-config' && component.label.includes('hooks.json#'));
    if (!hookComponent || hookComponent.kind !== 'shared-config') {
      throw new Error('Expected the installed hook component.');
    }
    const hooksPath = resolveCodexPaths(cwd, 'project', isolation.env).hooksPath;
    const bIdentity = installingB.artifacts.find((artifact) => artifact.kind === 'hook')
      ?.hookGroups?.[0];
    if (!bIdentity) throw new Error('Expected plugin B hook identity.');
    const renderedB = renderTrackedHookGroupIdentity(bIdentity);
    const bGroup: CodexSharedHookGroup = {
      event: renderedB.event,
      ...(renderedB.matcher === undefined ? {} : { matcher: renderedB.matcher }),
      hooks: renderedB.hooks as unknown as Record<string, unknown>[],
      rawGroup: {
        ...(renderedB.matcher === undefined ? {} : { matcher: renderedB.matcher }),
        hooks: renderedB.hooks as unknown as Record<string, unknown>[],
      },
    };
    let releaseAddition!: () => void;
    const additionCanFinish = new Promise<void>((resolve) => { releaseAddition = resolve; });
    let additionReachedCommit!: () => void;
    const additionAtCommit = new Promise<void>((resolve) => { additionReachedCommit = resolve; });
    const adding = applyCodexHookGroupsTransactionFile(
      hooksPath,
      (parsed) => [...parsed.rawGroups, bGroup],
      { beforeCommit: async () => {
        additionReachedCommit();
        await additionCanFinish;
      } },
    );
    await additionAtCommit;
    const removing = hookComponent.remove();
    releaseAddition();
    await Promise.all([removing, adding]);

    const raw = await fs.readFile(hooksPath, 'utf8');
    expect(raw).toContain('hook-atomic-b');
    expect(raw).not.toContain('hook-atomic-a');
    expect(await fs.pathExists(resolveConfigFileLockPath(hooksPath))).toBe(false);
    expect((await fs.readdir(path.dirname(hooksPath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('rejects a hooks target symlink swap without writing the external file', async () => {
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const hooksPath = resolveCodexPaths(cwd, 'project', isolation.env).hooksPath;
    const externalPath = path.join(isolation.layout.rootDir, 'external-hooks.json');
    await fs.outputJson(hooksPath, { hooks: {} });
    await fs.outputFile(externalPath, '{"external":true}\n');
    const identity = target.artifacts.find((artifact) => artifact.kind === 'hook')?.hookGroups?.[0];
    if (!identity) throw new Error('Expected hook identity.');
    const rendered = renderTrackedHookGroupIdentity(identity);
    const group: CodexSharedHookGroup = {
      event: rendered.event,
      ...(rendered.matcher === undefined ? {} : { matcher: rendered.matcher }),
      hooks: rendered.hooks as unknown as Record<string, unknown>[],
      rawGroup: {
        ...(rendered.matcher === undefined ? {} : { matcher: rendered.matcher }),
        hooks: rendered.hooks as unknown as Record<string, unknown>[],
      },
    };

    await expect(applyCodexHookGroupsTransactionFile(
      hooksPath,
      (parsed) => [...parsed.rawGroups, group],
      { beforeCommit: async () => {
        await fs.unlink(hooksPath);
        await fs.symlink(externalPath, hooksPath);
      } },
    )).rejects.toThrow('symbolic link');
    await expect(fs.readFile(externalPath, 'utf8')).resolves.toBe('{"external":true}\n');
    expect(await fs.pathExists(resolveConfigFileLockPath(hooksPath))).toBe(false);
    expect((await fs.readdir(path.dirname(hooksPath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('allows only one concurrent plugin to claim the same MCP server key', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const plugins = await Promise.all(['mcp-owner-a', 'mcp-owner-b'].map((name) =>
      createCodexSharedConfigPlugin({
        root: isolation.layout.rootDir,
        name,
        mcpServerKey: 'shared-server',
      })));
    const targets = await Promise.all(plugins.map((plugin) => integration.buildTarget({
      plugin, platform: 'codex', scope: 'project', cwd,
      command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
    })));

    const outcomes = await Promise.allSettled(
      targets.map((target) => integration.driver.writeArtifacts(target)),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String(outcomes.find((outcome) => outcome.status === 'rejected')?.reason))
      .toContain('is foreign and cannot be overwritten');
    const configPath = resolveCodexPaths(cwd, 'project', isolation.env).configTomlPath;
    const config = await readCodexConfigFile(configPath);
    const env = config.snapshot.mcpServers['shared-server']?.value?.env as Record<string, unknown>;
    expect(['mcp-owner-a', 'mcp-owner-b']).toContain(env.AW_AGENT_WORKFLOWS_OWNER);
    expect(await fs.pathExists(resolveConfigFileLockPath(configPath))).toBe(false);
    expect((await fs.readdir(path.dirname(configPath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it('allows only one concurrent plugin to claim the same agent role key', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const plugins = await Promise.all(['role-owner-a', 'role-owner-b'].map((name) =>
      createCodexSharedConfigPlugin({
        root: isolation.layout.rootDir,
        name,
        roleKey: 'shared-role',
      })));
    const targets = await Promise.all(plugins.map((plugin) => integration.buildTarget({
      plugin, platform: 'codex', scope: 'project', cwd,
      command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
    })));

    const outcomes = await Promise.allSettled(
      targets.map((target) => integration.driver.writeArtifacts(target)),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(String(outcomes.find((outcome) => outcome.status === 'rejected')?.reason))
      .toContain('is foreign and cannot be overwritten');
    const configPath = resolveCodexPaths(cwd, 'project', isolation.env).configTomlPath;
    const config = await readCodexConfigFile(configPath);
    const registeredPath = config.snapshot.agents['shared-role']?.configFile;
    expect(registeredPath).toBeTruthy();
    const roleFile = await fs.readFile(path.resolve(path.dirname(configPath), registeredPath!), 'utf8');
    const owner = parseOwnedTextHeader(roleFile)?.identity.plugin;
    expect(['role-owner-a', 'role-owner-b']).toContain(owner);
    expect(await fs.pathExists(resolveConfigFileLockPath(configPath))).toBe(false);

    const winner = plugins.find((plugin) => plugin.manifest.name === owner)!;
    const cleanupTarget = await integration.buildTarget({
      plugin: {
        ...winner,
        manifest: { ...winner.manifest, scripts: undefined, artifacts: undefined },
      },
      platform: 'codex', scope: 'project', cwd,
      command: 'cleanup', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    const cleanup = await executeRebuildOperation({
      command: 'cleanup', target: cleanupTarget, driver: integration.driver, activeStore,
    });
    expect(cleanup.status, JSON.stringify(cleanup.failures)).toBe('succeeded');
    expect((await readCodexConfigFile(configPath)).snapshot.agents['shared-role']).toBeUndefined();
    expect((await fs.readdir(path.dirname(configPath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
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
      command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    const installed = await executeRebuildOperation({
      command: 'install', target: installTarget, driver: integration.driver, activeStore,
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
      command: 'reinstall', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    const reinstalled = await executeRebuildOperation({
      command: 'reinstall', target: reinstallTarget, driver: integration.driver, activeStore,
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
      command: 'reinstall', catalog, includeHistoricalLifecycleArtifacts: false,
    });
    const foreignRolePath = path.join(path.dirname(rolePath), 'foreign-reinstall-role.toml');
    await fs.outputFile(foreignRolePath, 'description = "foreign role"\n');
    await applyCodexConfigTransactionFile(configPath, {
      upsertAgentRegistrations: {
        'reinstall-role': { configFile: 'agents/foreign-reinstall-role.toml' },
      },
    });
    const protectedResult = await executeRebuildOperation({
      command: 'reinstall', target: protectedTarget, driver: integration.driver, activeStore,
    });
    expect(protectedResult.status).toBe('failed');
    expect((await readCodexConfigFile(configPath)).snapshot.agents['reinstall-role']?.configFile)
      .toBe('agents/foreign-reinstall-role.toml');
    await expect(fs.readFile(foreignRolePath, 'utf8')).resolves.toBe('description = "foreign role"\n');
  });

  it('does not conditionally remove foreign MCP or role registrations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env: isolation.env,
        nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
      }),
    });
    const catalog = { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution;
    const mcpPlugin = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'conditional-remove-mcp',
      mcpServerKey: 'conditional-server',
    });
    const rolePlugin = await createCodexSharedConfigPlugin({
      root: isolation.layout.rootDir,
      name: 'conditional-remove-role',
      roleKey: 'conditional-role',
    });
    for (const plugin of [mcpPlugin, rolePlugin]) {
      const target = await integration.buildTarget({
        plugin, platform: 'codex', scope: 'project', cwd,
        command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
      });
      await integration.driver.writeArtifacts(target);
    }
    const cleanupTargets = await Promise.all([mcpPlugin, rolePlugin].map((plugin) =>
      integration.buildTarget({
        plugin: {
          ...plugin,
          manifest: {
            ...plugin.manifest,
            mcpServers: undefined,
            scripts: undefined,
            artifacts: undefined,
          },
        },
        platform: 'codex', scope: 'project', cwd,
        command: 'cleanup', catalog, includeHistoricalLifecycleArtifacts: false,
      })));
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
    const conditionalComponents = cleanupTargets.flatMap((target) => target.ownedComponents)
      .filter((component) => component.kind === 'shared-config');
    for (const component of conditionalComponents) await component.remove();

    const config = await readCodexConfigFile(configPath);
    const env = config.snapshot.mcpServers['conditional-server']?.value?.env as Record<string, unknown>;
    expect(env.AW_AGENT_WORKFLOWS_OWNER).toBe('foreign-mcp');
    expect(config.snapshot.agents['conditional-role']?.configFile).toBe('agents/foreign-role.toml');
    expect(await fs.pathExists(resolveConfigFileLockPath(configPath))).toBe(false);
    expect((await fs.readdir(path.dirname(configPath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });

  it.each(['upgrade', 'reinstall'] as const)(
    'cleans the last v1 MCP and hook capability when v2 removes the class during %s',
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
        command: 'install', catalog, includeHistoricalLifecycleArtifacts: false,
      });
      const installed = await executeRebuildOperation({
        command: 'install', target: v1, driver: integration.driver, activeStore,
      });
      expect(installed.status, JSON.stringify(installed.failures)).toBe('succeeded');

      const v2: PluginMeta = {
        ...base,
        manifest: {
          ...base.manifest,
          version: '2.0.0',
          mcpServers: undefined,
          extensions: undefined,
        },
      };
      const beforeStatus = await statusCommand([], {
        cwd, platform: 'codex', scope: 'project', json: true,
      }, {
        env: isolation.env,
        catalogResolution: catalog,
        catalogPlugins: [v2],
        nativeCliRunner: async () => { throw new Error('project status must not call native CLI'); },
      });
      expect(beforeStatus.payload.targets).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ plugin: v2.manifest.name }),
          state: 'partial',
        }),
      ]);
      const next = await integration.buildTarget({
        plugin: v2, platform: 'codex', scope: 'project', cwd,
        command, catalog, includeHistoricalLifecycleArtifacts: false,
      });
      const result = await executeRebuildOperation({
        command, target: next, driver: integration.driver, activeStore,
      });
      expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
      const codexPaths = resolveCodexPaths(cwd, 'project', isolation.env);
      const config = await fs.readFile(codexPaths.configTomlPath, 'utf8').catch(() => '');
      expect(config).not.toContain('legacy');
      await expect(fs.pathExists(codexPaths.hooksPath)).resolves.toBe(false);
      const status = await inspectRebuildTarget({
        plugin: v2, platform: 'codex', scope: 'project', cwd, catalog,
        context: createCommandExecutionContext({
          env: isolation.env,
          nativeCliRunner: async () => { throw new Error('status must not call native CLI'); },
        }),
      });
      expect(status.inspection.state).toBe('absent');
      const afterStatus = await statusCommand([], {
        cwd, platform: 'codex', scope: 'project', json: true,
      }, {
        env: isolation.env,
        catalogResolution: catalog,
        catalogPlugins: [v2],
        nativeCliRunner: async () => { throw new Error('project status must not call native CLI'); },
      });
      expect(afterStatus.payload.targets).toEqual([]);
    },
  );

  it('closes representative Codex project writes for four first-party plugins', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstPartyNames = ['git-commit', 'ask-me', 'codex-explore', 'codex-subagent-guide'];
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
      const target = await integration.buildTarget({
        plugin,
        platform: 'codex',
        scope: 'project',
        cwd: isolation.layout.fixtureCwd,
        command: 'install',
        catalog: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
        includeHistoricalLifecycleArtifacts: false,
      });
      const result = await executeRebuildOperation({
        command: 'install',
        target,
        driver: integration.driver,
        activeStore,
      });
      expect(result.status, `${name}: ${JSON.stringify(result.failures)}`).toBe('succeeded');
    }
  });

  it('passes historical artifacts and the CLI timeout to the renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const pluginRoot = path.join(isolation.layout.rootDir, 'renderer-contract');
    const manifest = {
      name: 'renderer-contract',
      version: '1.0.0',
      description: 'renderer contract fixture',
      compatibility: { aw: { minVersion: '0.1.0' } },
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      scripts: {
        timeoutMs: 10_000,
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        lifecycle: {
          upgrade: { default: { runner: 'node', path: './scripts/upgrade.mjs' } },
          uninstall: { default: { runner: 'node', path: './scripts/uninstall.mjs' } },
        },
      },
      artifacts: {
        targets: [{
          id: 'instruction',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.developerInstructionsBlock',
          states: ['present', 'disabled'],
          refreshKeys: [],
          requiresCodexProjectConfig: true,
        }],
      },
    };
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const present = context.previousArtifacts.length > 0;',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "instruction", kind: "instruction", platform: "codex",',
      '  target: "codex.developerInstructionsBlock", state: present ? "present" : "disabled",',
      '  refreshKeys: [], ...(present ? { content: "Previous artifacts were passed." } : {})',
      '}] }));',
    ].join('\n'));
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'upgrade.mjs'), 'export default true;\n');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'uninstall.mjs'), 'export default true;\n');
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const loadPlugin = (bundleRoot: string) => readPluginManifest(bundleRoot, { mode: 'bundle' });
    const prepared = await prepareLifecycleActiveSnapshot({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      artifacts: [{
        path: path.join(cwd, '.codex', 'config.toml'),
        kind: 'instruction',
        platform: 'codex',
        id: 'instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'present',
      }],
      env: isolation.env,
      loadPlugin,
    });
    expect(prepared.status).toBe('staged');
    if (prepared.status !== 'staged') throw new Error('Expected staged active snapshot.');
    await promoteLifecycleActiveSnapshot(prepared);
    const context = createCommandExecutionContext({
      env: isolation.env,
      nativeCliRunner: async () => { throw new Error('project must not call native CLI'); },
    });
    const integration = createRebuildIntegration({ context, scriptTimeoutMs: 5_000 });
    const target = await integration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'upgrade',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      includeHistoricalLifecycleArtifacts: true,
    });
    expect(target.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'instruction', state: 'present' }),
    ]));

    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'await new Promise((resolve) => setTimeout(resolve, 100));',
      'console.log(JSON.stringify({ version: 2, artifacts: [] }));',
    ].join('\n'));
    const timeoutIntegration = createRebuildIntegration({ context, scriptTimeoutMs: 1 });
    await expect(timeoutIntegration.buildTarget({
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      command: 'upgrade',
      catalog: { rootDir: isolation.layout.rootDir, source: 'local' } as CatalogResolution,
      includeHistoricalLifecycleArtifacts: true,
    })).rejects.toThrow(/timeout|超时/iu);
  });

  it('discovers a safe Codex manifest-only native residue', async () => {
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
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      nativeFailureMode: 'error',
    })).resolves.toContain('manifest-only');
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
        includeHistoricalLifecycleArtifacts: false,
      });
      const result = await executeRebuildOperation({
        command: 'install', target, driver: integration.driver, activeStore,
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
    ['static', path.join(repositoryRoot, 'plugins', 'git-commit')],
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const installedTarget = await build('install');
    expect((await executeRebuildOperation({
      command: 'install', target: installedTarget, driver: integration.driver, activeStore,
    })).status).toBe('succeeded');
    const reinstallTarget = await build('reinstall');
    const result = await executeRebuildOperation({
      command: 'reinstall', target: reinstallTarget, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    const requiredSkills = reinstallTarget.artifacts.filter((artifact) =>
      artifact.kind === 'skill' && artifact.state !== 'disabled' && artifact.artifactKey);
    expect(requiredSkills.length).toBeGreaterThan(0);
    const cacheManifest = await fs.readJson(path.join(cacheRoot, '.codex-plugin', 'plugin.json'));
    const skillsRoot = cacheManifest.skills.replace(/^\.\//u, '');
    for (const artifact of requiredSkills) {
      expect(await fs.pathExists(path.join(
        cacheRoot,
        ...skillsRoot.split('/'),
        artifact.artifactKey!,
        'SKILL.md',
      ))).toBe(true);
    }
  });

  it.each(['config', 'hooks'] as const)(
    'fails project cleanup when malformed Codex %s contains target AW ownership evidence',
    async (surface) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = await fs.realpath(isolation.layout.fixtureCwd);
      const plugin: PluginMeta = {
        rootDir: path.join(isolation.layout.rootDir, 'corrupted-owned'),
        manifestPath: path.join(isolation.layout.rootDir, 'corrupted-owned', '.agents-plugin', 'plugin.json'),
        manifest: {
          name: 'corrupted-owned',
          version: '1.0.0',
          description: 'corrupted owned fixture',
          compatibility: { aw: { minVersion: '0.1.0' } },
          marketplace: {
            category: 'test', strict: true,
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          },
        },
      };
      const codexPaths = resolveCodexPaths(cwd, 'project', isolation.env);
      const targetPath = surface === 'config' ? codexPaths.configTomlPath : codexPaths.hooksPath;
      await fs.outputFile(targetPath, surface === 'config'
        ? 'developer_instructions = "[[aw-managed:start plugin=\\"corrupted-owned\\" kind=\\"developer_instructions\\"]]"\n[bad\n'
        : `{"hooks":[{"command":"${OWNED_TEXT_HEADER_PREFIX}{\\"schemaVersion\\":1,\\"owner\\":\\"agent-workflows\\",\\"plugin\\":\\"corrupted-owned\\"}`);
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
        includeHistoricalLifecycleArtifacts: false,
      });
      const result = await executeRebuildOperation({
        command: 'cleanup', target, driver: integration.driver, activeStore,
      });
      expect(result.status).toBe('failed');
      expect(result.residual).toContain(targetPath);
      expect(await fs.pathExists(targetPath)).toBe(true);
    },
  );

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
        compatibility: { aw: { minVersion: '0.1.0' } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain('claude plugin uninstall removed-claude@aw --scope project');
    expect(await fs.pathExists(path.join(isolation.layout.awHomeDir, 'plugins', 'removed-claude'))).toBe(false);
  });

  it.each([
    {
      label: 'different plugins in user and project scopes',
      remainingName: 'other-claude',
    },
    {
      label: 'the same plugin in user and project scopes',
      remainingName: 'shared-claude',
    },
  ])('keeps the Claude marketplace for $label', async ({ remainingName }) => {
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
      scope: 'project' as const,
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain(`claude plugin uninstall ${pluginName}@aw --scope user`);
    expect(calls).not.toContain('claude plugin marketplace remove aw --scope user');
  });

  it('re-reads global Claude consumers after native uninstall', async () => {
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('claude plugin marketplace remove aw --scope user');
    expect((await fs.readJson(paths.installedPluginsPath)).plugins['late-consumer@aw']).toHaveLength(1);
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
      await fs.outputJson(paths.knownMarketplacesPath, {
        marketplaces: { aw: { installLocation: isolation.layout.awHomeDir } },
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'reinstall', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).not.toContain('claude plugin marketplace remove aw --scope user');
    expect((await fs.readJson(paths.installedPluginsPath)).plugins[`${pluginB}@aw`]).toHaveLength(1);
  });

  it('removes the Claude marketplace only after the last canonical consumer is uninstalled', async () => {
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const result = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
    });
    expect(result.status, JSON.stringify(result.failures)).toBe('succeeded');
    expect(calls).toContain('claude plugin marketplace remove aw --scope user');
    expect(calls.indexOf('claude plugin uninstall last-claude@aw --scope user')).toBeLessThan(
      calls.indexOf('claude plugin marketplace remove aw --scope user'),
    );
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const malformed = await executeRebuildOperation({
      command: 'cleanup', target, driver: integration.driver, activeStore,
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
      includeHistoricalLifecycleArtifacts: false,
    });
    const mismatch = await executeRebuildOperation({
      command: 'install', target, driver: integration.driver, activeStore,
    });
    expect(mismatch.status).toBe('failed');
    expect(mismatch.failures.some((failure) => failure.message.includes('versions=9.9.9'))).toBe(true);
  });
});
