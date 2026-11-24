import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommandPackageId, getPlatformFeatureRegistry } from '@lesliechan721/aw-plugin-core/manifest';

import { createRebuildIntegration, disposePreparedPlatformRebuildSession, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import type { PlatformName, PluginMeta, RebuildCommand, Scope } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { readManagedCommandPackageView, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { runManagedCommand } from '../../src/utils/managed-command-runtime.js';
import { managedCommandProducerIdentity } from '../../src/utils/managed-command-materialization.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { createDefaultCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';

describe('managed command plugin lifecycle', () => {
  let isolated: IsolatedTestEnvironment;
  let pluginRoot: string;
  let capturePath: string;
  let claude: Awaited<ReturnType<typeof createClaudeNativeTestRuntime>>;
  const contexts: RebuildExecutionContext[] = [];
  const source = createDefaultCatalogSourcesConfig().sources[0]!;
  let sourceIdentity: string;
  const baseManifest = {
    schemaVersion: 4, name: 'managed-lifecycle', version: '1.0.0', description: 'Lifecycle fixture.',
    platforms: ['opencode', 'claude'], requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
  };
  const tool = 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n';

  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    sourceIdentity = await calculateCatalogSourceIdentity(source);
    pluginRoot = path.join(isolated.layout.fixtureCwd, 'plugin');
    capturePath = path.join(isolated.layout.fixtureCwd, 'capture.json');
    isolated.env.CAPTURE_FILE = capturePath;
    const bin = path.join(isolated.layout.fixtureCwd, 'native-bin');
    for (const name of ['opencode']) await fs.outputFile(path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    isolated.env.PATH = bin;
    claude = await createClaudeNativeTestRuntime(isolated);
  });
  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => disposePreparedPlatformRebuildSession(context.preparedArtifactRenderResults!)));
    await isolated.cleanup();
  });

  async function readFixture(): Promise<PluginMeta> {
    const descriptor = { ...await readPluginManifest(pluginRoot), sourceId: source.id, sourceIdentity, pluginId: `${source.id}/managed-lifecycle` };
    const root = path.join(isolated.layout.fixtureCwd, `bundle-${crypto.randomUUID()}`);
    await bundleLocalPlugin(descriptor, root, { commandEnv: isolated.env });
    return { ...await readPluginManifest(root, { mode: 'bundle' }), sourceId: source.id, sourceIdentity, pluginId: descriptor.pluginId };
  }
  async function nativeRunner(invocation: Parameters<NonNullable<RebuildExecutionContext['nativeCliRunner']>>[0]) {
    if (claude.isClaudeInvocation(invocation)) return claude.nativeCliRunner(invocation);
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' };
    throw new Error('Unexpected fixture native mutation.');
  }
  function integrationFor(env = isolated.env) {
    const context: RebuildExecutionContext = createCommandExecutionContext({ env, nativeCliRunner: nativeRunner });
    // Replace qualification facts only. Discovery, layout, renderer, projection, ownership and execution remain real.
    context.platformRebuildSession = new PlatformRebuildSession(context, (platform) => {
      const adapter = getAgentPluginAdapter(platform);
      return { ...adapter, capabilities: (input) => {
        const facts = adapter.capabilities(input);
        facts.kinds.skill = { ...facts.kinds.skill, status: 'supported', reasonCodes: [] };
        for (const [id, feature] of Object.entries(getPlatformFeatureRegistry())) if (id.startsWith('skill.')) facts.features[id] = { status: 'supported', reasonCodes: [], ...(feature.values ? { values: [...feature.values] } : {}) };
        return facts;
      } };
    });
    contexts.push(context);
    return { integration: createRebuildIntegration({ context }), context };
  }
  function input(plugin: PluginMeta, command: RebuildCommand, platform: PlatformName, scope: Scope = 'user') {
    return { plugin, command, platform, scope, cwd: isolated.layout.fixtureCwd, sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginId: plugin.pluginId,
      catalog: { rootDir: plugin.rootDir, source: 'local' as const, catalogVersion: '1.0.0', channel: 'stable' as const } };
  }
  async function execute(plugin: PluginMeta, command: RebuildCommand, options: { platform?: PlatformName; scope?: Scope; env?: NodeJS.ProcessEnv } = {}) {
    const { integration, context } = integrationFor(options.env);
    const target = await integration.buildTarget(input(plugin, command, options.platform ?? 'opencode', options.scope));
    await integration.sealMarketplaceGenerations?.([target]);
    const result = await executeRebuildOperation({ command, target, driver: integration.driver });
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    return { target, context, result };
  }
  async function fixture(platforms: PlatformName[] | null = ['opencode', 'claude']) {
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), tool);
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/README.md'), 'Lifecycle fixture.\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Lifecycle fixture.\n---\nProvider.\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), {
      ...baseManifest, version: platforms ? '1.0.0' : '2.0.0', scripts: undefined, skills: './skills',
      config: { schemaVersion: 5, fields: { mode: { type: 'string', default: 'shared' } } },
      ...(platforms ? { command: { mode: 'static', sourceDir: './tools', platforms, runtimeConfig: { keys: ['mode'] },
        routes: { subcommands: [{ name: 'check', runner: 'node', entry: 'tool.mjs', args: ['fixed'] }] } } } : {}),
    });
    return readFixture();
  }

  it('publishes one reviewed package for both selected platforms and retains both applied snapshots after uninstall', async () => {
    const plugin = await fixture();
    const id = getCommandPackageId(managedCommandProducerIdentity({ plugin }));
    const selector = plugin.pluginId!;
    for (const platform of ['opencode', 'claude'] as const) await writePluginConfigStore({
      sourceId: source.id, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', platform,
      env: isolated.env, cwd: isolated.layout.fixtureCwd, values: { mode: platform },
    });
    const { integration, context } = integrationFor();
    const inputs = (['opencode', 'claude'] as const).map((platform) => input(plugin, 'install', platform));
    await integration.resolvePlatformTargets(inputs);
    const targets = await Promise.all(inputs.map((entry) => integration.buildTarget(entry)));
    await integration.sealMarketplaceGenerations(targets);
    for (const target of targets) {
      expect(target.operationActions).toContainEqual(expect.objectContaining({ kind: 'syncManagedCommandPackage',
        routeReview: expect.objectContaining({ routeChanges: expect.arrayContaining(
          ['opencode', 'claude'].map((platform) => expect.objectContaining({
            argv: ['aw', 'command', 'run', `${selector}/${platform}`, '--', 'check'],
          })),
        ) }),
        runtimeConfigChanges: expect.arrayContaining([{ platform: 'opencode', after: { mode: 'opencode' } }, { platform: 'claude', after: { mode: 'claude' } }]),
      }));
      const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
      expect(result.status, JSON.stringify(result)).toBe('succeeded');
    }
    expect(context.commandResults).toMatchObject([{ packageId: id, selector, action: 'created', availability: 'ready', subcommands: ['check'], hasFallback: false, state: 'completed' }]);
    const before = await readManagedCommandPackageView(id, isolated.env);
    for (const platform of ['opencode', 'claude'] as const) {
      const removed = await execute(plugin, 'uninstall', { platform });
      expect(removed.context.commandResults).toMatchObject([{ action: 'unchanged', recoveryActions: [`aw command package remove ${id} --yes`] }]);
    }
    const retained = await readManagedCommandPackageView(id, isolated.env);
    expect(retained.resourceRoot).toBe(before.resourceRoot);
    expect(retained.runtimeConfigPlatforms.sort()).toEqual(['claude','opencode']);
    expect(await runManagedCommand({ id: `${selector}/opencode`, args: ['check','after'], cwd: isolated.layout.fixtureCwd,
      cliEntry: import.meta.filename, env: isolated.env })).toBe(0);
    expect(await fs.readJson(capturePath)).toMatchObject({ args: ['fixed', 'after'] });
  });

  it('excludes unsupported platforms and withdraws the owned package when the new declaration disappears', async () => {
    const plugin = await fixture(['claude']);
    const selector = plugin.pluginId!;
    await execute(plugin, 'install', { platform: 'opencode' });
    await expect(resolveManagedCommand(selector, isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
    await execute(plugin, 'install', { platform: 'claude' });
    const updated = await fixture(null);
    const { integration, context } = integrationFor();
    const target = await integration.buildTarget(input(updated, 'sync', 'claude'));
    const action = target.operationActions?.find((entry) => entry.kind === 'removeManagedCommandPackage');
    expect(action).toMatchObject({ selector, availability: 'ready', routeReview: { routeChanges: [{ before: { entry: 'tool.mjs' }, after: null }] } });
    expect((await resolveManagedCommand(`${selector}/claude`, isolated.env, { args: ['check'] })).launch.args).toEqual(['fixed']);
    await integration.sealMarketplaceGenerations([target]);
    const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
    expect(result.status, JSON.stringify(result)).toBe('succeeded');
    expect(context.commandResults).toMatchObject([{ selector, action: 'removed', availability: 'removed' }]);
    await expect(resolveManagedCommand(selector, isolated.env)).rejects.toMatchObject({ code: 'commandNotFound' });
  });

  it('rejects configuration changed after Review before publishing a command revision', async () => {
    const plugin = await fixture();
    await execute(plugin, 'install');
    const id = getCommandPackageId(managedCommandProducerIdentity({ plugin }));
    const { resourceRoot } = await readManagedCommandPackageView(id, isolated.env);
    const { integration } = integrationFor();
    const target = await integration.buildTarget(input(plugin, 'reinstall', 'opencode'));
    await writePluginConfigStore({ sourceId: source.id, sourceIdentity, pluginName: plugin.manifest.name, scope: 'user', platform: 'opencode',
      env: isolated.env, cwd: isolated.layout.fixtureCwd, values: { mode: 'unreviewed' } });
    await expect(integration.driver.applyManagedCommands!(target)).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readManagedCommandPackageView(id, isolated.env)).resourceRoot).toBe(resourceRoot);
  });
});
