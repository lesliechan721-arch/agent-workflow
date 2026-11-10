import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { getPlatformFeatureRegistry } from '@lesliechan721/aw-plugin-core/manifest';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { createNoopReporter } from '../../src/output/reporter.js';
import { createNoopDebugLogger } from '../../src/output/debug-log.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import type { ProductInstallation } from '../../src/platforms/contracts.js';

async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'empty-platform-plugin');
  const bin = path.join(isolation.layout.fixtureCwd, 'bin');
  await fs.outputFile(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.outputJson(path.join(root, '.agents-plugin', 'plugin.json'), {
    schemaVersion: 4, name: 'empty-plugin', version: '1.0.0', description: 'Intentional empty deployment.',
    platforms: ['opencode'], marketplace: { category: 'development', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  });
  const plugin = await readPluginManifest(root, { mode: 'bundle' });
  plugin.sourceId = 'team'; plugin.pluginId = 'team/empty-plugin'; plugin.sourceIdentity = `sha256:${'a'.repeat(64)}`;
  const env = { ...isolation.env, PATH: `${bin}${path.delimiter}${isolation.env.PATH ?? ''}` };
  const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' }));
  const context: RebuildExecutionContext = { env, nativeCliRunner: runner, reporter: createNoopReporter(),
    debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
  const ctx = { cwd: isolation.layout.fixtureCwd, env, runner };
  const adapter = getAgentPluginAdapter('opencode');
  const resolution = await adapter.resolve(ctx, { plugin: { sourceId: plugin.sourceId, pluginId: plugin.pluginId,
    sourceIdentity: plugin.sourceIdentity, version: plugin.manifest.version }, scope: { kind: 'user' }, operation: 'ensure',
    discovery: await adapter.discover(ctx), recoveryCandidates: [] });
  const binding = resolution.bindings[0]!;
  expect(binding).toBeDefined();
  const layout = await getDeploymentLayout(ctx, binding);
  const component = deploymentPackageComponent(binding, layout);
  if (component.kind !== 'owned-directory') throw new Error('Expected a native package owner.');
  await fs.outputFile(path.join(component.path, 'old.js'), 'export default {};\n');
  await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
  const integration = createRebuildIntegration({ context });
  const target = await integration.buildTarget({ plugin, platform: 'opencode', scope: 'user', cwd: ctx.cwd, command: 'sync',
    catalog: { rootDir: root, source: 'local', catalogVersion: '1.0.0', channel: 'latest' } });
  return { root, context, integration, target, packageRoot: component.path };
}

describe('frozen platform rebuild integration', () => {
  // Test Value Gate: a complete intentional empty set revokes only proven owned output through the real adapter pipeline.
  it('removes an owned directory for a successful intentional empty collection', async () => {
    const item = await fixture();
    try {
      expect(item.target.platformDeployment?.plans[0]?.expected).toMatchObject({ components: [], unmet: [] });
      expect(item.target.platformDeployment?.plans[0]?.effects.some((effect) => effect.kind === 'remove-owned')).toBe(true);
      const result = await executeRebuildOperation({ command: 'sync', target: item.target, driver: item.integration.driver });
      expect(result.status).toBe('succeeded');
      expect(result.deploymentReceipts?.flatMap((receipt) => receipt.effects)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'applied', mutation: 'confirmed' }),
      ]));
      expect(await fs.pathExists(item.packageRoot)).toBe(false);
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: source changes after Review cannot turn a frozen empty plan into destructive execution.
  it('rejects changed source evidence before deleting an existing package', async () => {
    const item = await fixture();
    try {
      await fs.outputFile(path.join(item.root, 'changed.txt'), 'changed after preparation');
      const result = await executeRebuildOperation({ command: 'sync', target: item.target, driver: item.integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(await fs.pathExists(path.join(item.packageRoot, 'old.js'))).toBe(true);
      expect(result.deploymentReceipts).toBeUndefined();
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });
});

async function marketplaceFixture(extras = false) {
  const isolated = getCurrentSourceTestIsolation();
  const bin = path.join(isolated.layout.fixtureCwd, 'marketplace-bin');
  for (const command of ['claude', 'opencode']) await fs.outputFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...isolated.env, PATH: bin };
  async function nativeRunner(invocation: Parameters<NonNullable<RebuildExecutionContext['nativeCliRunner']>>[0]) {
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: /claude/iu.test(invocation.command) ? '2.1.292 (Claude Code)' : 'opencode 2.0.0', stderr: '' };
    const args = invocation.args;
    if (args[0] !== 'plugin') throw new Error('Unexpected fixture native mutation.');
    const home = isolated.env.AW_CLAUDE_HOME!;
    const knownPath = path.join(home, 'plugins/known_marketplaces.json');
    const known = await fs.readJson(knownPath).catch(() => ({}));
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      await fs.outputJson(knownPath, { ...known, [marketplaceName]: { source: { source: 'directory', path: root }, installLocation: root } });
    } else {
      const id = args[2]!;
      const scope = args[args.indexOf('--scope') + 1];
      const settingsPath = scope === 'local' ? path.join(invocation.cwd, '.claude/settings.local.json') : path.join(home, 'settings.json');
      const settings = await fs.readJson(settingsPath).catch(() => ({}));
      const installedPath = path.join(home, 'plugins/installed_plugins.json');
      const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} }));
      const records = (installed.plugins[id] ?? []).filter((record: { scope: string; projectPath?: string }) => record.scope !== scope || scope === 'local' && record.projectPath !== invocation.cwd);
      if (['install', 'update', 'uninstall'].includes(args[1]!)) {
        if (args[1] !== 'uninstall') {
          const marketplace = known[id.slice(id.lastIndexOf('@') + 1)];
          const root = path.join(marketplace.installLocation, 'plugins', id.slice(0, id.lastIndexOf('@')));
          const manifest = await fs.readJson(path.join(root, '.claude-plugin/plugin.json'));
          records.push({ scope, ...(scope === 'local' ? { projectPath: invocation.cwd } : {}), version: manifest.version, installPath: root });
        }
        const plugins = { ...installed.plugins };
        if (records.length) plugins[id] = records;
        else delete plugins[id];
        await fs.outputJson(installedPath, { plugins });
      }
      if (['install', 'enable', 'disable', 'uninstall'].includes(args[1]!)) await fs.outputJson(settingsPath, { ...settings, enabledPlugins: { ...settings.enabledPlugins, [id]: !['disable', 'uninstall'].includes(args[1]!) } });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  const context: RebuildExecutionContext = { env, nativeCliRunner: nativeRunner, reporter: createNoopReporter(),
    debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
  const adapterFor = (platform: Parameters<typeof getAgentPluginAdapter>[0]) => {
    const adapter = getAgentPluginAdapter(platform);
    return { ...adapter, capabilities(input) {
      const capabilities = adapter.capabilities(input);
      capabilities.kinds.skill = { ...capabilities.kinds.skill, status: 'supported', reasonCodes: [] };
      if (extras && platform === 'claude') for (const kind of ['mcp', 'hook'] as const) capabilities.kinds[kind] = { ...capabilities.kinds[kind], status: 'supported', reasonCodes: [] };
      for (const [id, feature] of Object.entries(getPlatformFeatureRegistry())) if (!feature.derivedFromKind && (id.startsWith('skill.') || extras && platform === 'claude' && (id.startsWith('mcp.') || id === 'hook.common.before_tool'))) {
        capabilities.features[id] = { status: 'supported', reasonCodes: [], ...(feature.values ? { values: id === 'hook.common.before_tool' ? ['notify'] : [...feature.values] } : {}) };
      }
      return capabilities;
    } };
  };
  context.platformRebuildSession = new PlatformRebuildSession(context, adapterFor);
  const integration = createRebuildIntegration({ context });
  const targets = [];
  for (const name of ['first', 'second']) {
    const root = path.join(isolated.layout.fixtureCwd, `market-${name}`);
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 4, name, version: '1.0.0', description: 'Frozen marketplace fixture.',
      platforms: ['claude', 'opencode'], marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      artifacts: { configKeys: [] }, scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } });
    await fs.outputFile(path.join(root, 'render.mjs'), `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:'skill:check',kind:'skill',name:'check',content:{files:{'SKILL.md':{text:'---\\nname: check\\ndescription: Check.\\n---\\nCheck.'}}}}]:[],omitted:[],unmet:[]}));`);
    if (extras && name === 'first') {
      const components = [
        { id: 'skill:check', kind: 'skill', name: 'check', content: { files: { 'SKILL.md': { text: '---\nname: check\ndescription: Check.\n---\nOld skill.' } } } },
        { id: 'mcp:docs', kind: 'mcp', name: 'docs', content: { type: 'http', url: 'https://example.test/mcp' } },
        { id: 'hook:guard', kind: 'hook', name: 'guard', content: { dialect: 'common', event: 'before_tool', feedback: 'notify', command: 'echo guard' } },
      ];
      await fs.writeFile(path.join(root, 'render.mjs'), `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));console.log(JSON.stringify({version:3,components:${JSON.stringify(components)}.filter(x=>c.allowedOutputKinds.includes(x.kind)),omitted:[],unmet:[]}));`);
    }
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    plugin.sourceId = 'team'; plugin.sourceIdentity = `sha256:${'a'.repeat(64)}`; plugin.pluginId = `team/${name}`;
    targets.push(await integration.buildTarget({ plugin, platform: 'claude', scope: 'user', cwd: isolated.layout.fixtureCwd, command: 'install',
      catalog: { rootDir: root, source: 'local', catalogVersion: '1.0.0', channel: 'latest' } }));
  }
  await integration.sealMarketplaceGenerations(targets);
  return { context, integration, targets, adapterFor };
}

describe('shared marketplace generation', () => {
  // Test Value Gate: unmet components cannot erase old shared MCP/Hook output, while another platform still progresses.
  it('retains the complete old package on unmet components and continues an independent platform', async () => {
    const item = await marketplaceFixture(true);
    try {
      for (const target of item.targets) expect((await executeRebuildOperation({ command: 'install', target, driver: item.integration.driver })).status).toBe('succeeded');
      const previous = item.targets[0]!;
      const packageRoot = previous.platformDeployment!.plans[0]!.evidence.layout.packageRoot;
      const preservedFiles = ['.mcp.json', 'hooks/hooks.json', 'skills/check/SKILL.md'];
      const before = await Promise.all(preservedFiles.map((file) => fs.readFile(path.join(packageRoot, file), 'utf8')));
      await item.context.platformRebuildSession!.dispose();
      const renderer = `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:'skill:check',kind:'skill',name:'check',content:{files:{'SKILL.md':{text:'---\\nname: check\\ndescription: Check.\\n---\\nNew skill.'}}}}]:[],omitted:[],unmet:['mcp','hook'].filter(kind=>c.allowedOutputKinds.includes(kind)).map(kind=>({id:kind==='mcp'?'mcp:docs':'hook:guard',kind,reasonCode:'dependency-unmet',requiredFeatures:[]}))}));`;
      await fs.writeFile(path.join(previous.plugin.rootDir, 'render.mjs'), renderer);
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, item.adapterFor);
      const integration = createRebuildIntegration({ context: item.context });
      const targets = [];
      for (const [old, platform] of [[previous, 'claude'], [item.targets[1]!, 'opencode']] as const) targets.push(await integration.buildTarget({
        plugin: old.plugin, platform, scope: 'user', cwd: old.identity.cwd!, command: 'sync',
        catalog: { rootDir: old.plugin.rootDir, source: 'local', catalogVersion: '1.0.0', channel: 'latest' },
      }));
      await integration.sealMarketplaceGenerations(targets);
      expect(targets[0]!.platformDeployment!.plans[0]!.evidence.retainPackage).toBe(true);
      const retained = await executeRebuildOperation({ command: 'sync', target: targets[0]!, driver: integration.driver });
      expect(retained.status).toBe('failed');
      expect(retained.deploymentReceipts!.flatMap((receipt) => receipt.unmet).some((gap) => gap.reasonCode === 'packageUpdateBlockedByUnmet')).toBe(true);
      expect(await Promise.all(preservedFiles.map((file) => fs.readFile(path.join(packageRoot, file), 'utf8')))).toEqual(before);
      const independent = await executeRebuildOperation({ command: 'sync', target: targets[1]!, driver: integration.driver });
      expect(independent.status, JSON.stringify(independent)).toBe('succeeded');
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: independently prepared sibling packages must publish one immutable complete descriptor.
  it('freezes both plugins before publication and preserves the sibling during sequential execution', async () => {
    const item = await marketplaceFixture();
    try {
      const plans = item.targets.map((target) => target.platformDeployment!.plans[0]!);
      expect(plans[0]!.evidence.layout.marketplaceRoot).toBe(plans[1]!.evidence.layout.marketplaceRoot);
      expect(plans[0]!.evidence.marketplace).toEqual(plans[1]!.evidence.marketplace);
      const descriptor = plans[0]!.evidence.marketplace!.files.find((file) => file.relativePath.endsWith('marketplace.json'))!;
      const frozen = Buffer.from(descriptor.contentBase64, 'base64').toString('utf8');
      expect(JSON.parse(frozen).plugins.map((plugin: {name:string}) => plugin.name).sort()).toEqual(['first', 'second']);
      expect(await fs.pathExists(plans[0]!.evidence.layout.marketplaceRoot!)).toBe(false);
      for (const target of item.targets) {
        const result = await executeRebuildOperation({ command: 'install', target, driver: item.integration.driver });
        expect(result.status, JSON.stringify(result)).toBe('succeeded');
      }
      expect(await fs.readFile(path.join(plans[0]!.evidence.layout.marketplaceRoot!, descriptor.relativePath), 'utf8')).toBe(frozen);
      for (const plan of plans) expect(await fs.pathExists(path.join(plan.evidence.layout.packageRoot, 'skills/check/SKILL.md'))).toBe(true);
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });

  it('rejects a changed marketplace descriptor before publishing a prepared package', async () => {
    const item = await marketplaceFixture();
    try {
      const plan = item.targets[0]!.platformDeployment!.plans[0]!;
      const descriptor = plan.evidence.marketplace!.files.find((file) => file.relativePath.endsWith('marketplace.json'))!;
      await fs.outputFile(path.join(plan.evidence.layout.marketplaceRoot!, descriptor.relativePath), 'external change');
      const result = await executeRebuildOperation({ command: 'install', target: item.targets[0]!, driver: item.integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(await fs.pathExists(plan.evidence.layout.packageRoot)).toBe(false);
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });

  it('rejects new marketplace candidates after the prepared generation is finalized', async () => {
    const item = await marketplaceFixture();
    try {
      const reviewed = item.targets[0]!.platformDeployment!.plans[0]!;
      item.context.platformRebuildSession!.freezeMarketplaceCandidates();
      const source = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'market-third');
      await fs.copy(item.targets[0]!.plugin.rootDir, source);
      const manifestFile = path.join(source, '.agents-plugin/plugin.json');
      await fs.writeJson(manifestFile, { ...await fs.readJson(manifestFile), name: 'third' });
      const plugin = await readPluginManifest(source, { mode: 'bundle' });
      plugin.sourceId = 'team'; plugin.sourceIdentity = item.targets[0]!.plugin.sourceIdentity; plugin.pluginId = 'team/third';
      const target = await item.integration.buildTarget({ plugin, platform: 'claude', scope: 'user',
        cwd: getCurrentSourceTestIsolation().layout.fixtureCwd, command: 'install',
        catalog: { rootDir: source, source: 'local', catalogVersion: '1.0.0', channel: 'latest' } });
      await expect(item.integration.sealMarketplaceGenerations([target])).rejects.toThrow('operationPlanStale');
      expect(item.targets[0]!.platformDeployment!.plans[0]).toEqual(reviewed);
      expect(await fs.pathExists(reviewed.evidence.layout.marketplaceRoot!)).toBe(false);
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });
});

async function registrationFixture(options: { platform?: 'codex' | 'claude'; failAfterRegister?: boolean;
  availableProduct?: 'cli' | 'app'; excludedProduct?: ProductInstallation } = {}) {
  const isolation = getCurrentSourceTestIsolation();
  const platform = options.platform ?? 'codex';
  const root = path.join(isolation.layout.fixtureCwd, 'registration-source');
  const executable = path.join(isolation.layout.fixtureCwd, `${platform}-registration-client`);
  await fs.outputFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), {
    schemaVersion: 4, name: 'registration-demo', version: '1.0.0', description: 'Registration boundary.',
    platforms: [platform], skills: './skills', marketplace: { category: 'development', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  });
  await fs.outputFile(path.join(root, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check.\n---\nCheck.');
  const plugin = await readPluginManifest(root, { mode: 'bundle' });
  Object.assign(plugin, { sourceId: 'team', pluginId: 'team/registration-demo', sourceIdentity: `sha256:${'c'.repeat(64)}` });
  const product: ProductInstallation = { id: `${platform}-available`, product: options.availableProduct ?? 'cli', availability: 'available',
    version: platform === 'codex' ? '0.167.0' : '2.1.292', reasonCodes: [],
    entry: { kind: 'cli', executable, configRoot: path.join(isolation.layout.fixtureCwd, `${platform}-registration-home`) } };
  const installed = new Set<string>();
  const enabled = new Set<string>();
  const calls: string[][] = [];
  const context: RebuildExecutionContext = { env: isolation.env, reporter: createNoopReporter(),
    debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map(), nativeCliRunner: async (request) => {
      const args = [...request.args]; calls.push(args);
      const scope = platform === 'claude' ? args[args.indexOf('--scope') + 1]! : 'global';
      if (args[0] === 'plugin' && ['add', 'install', 'update'].includes(args[1]!)) {
        if (installed.has(scope) && args[1] !== 'update') return { exitCode: 1, stdout: '', stderr: 'already installed' };
        installed.add(scope);
        if (options.failAfterRegister) return { exitCode: 1, stdout: '', stderr: 'interrupted after registration' };
      }
      if (args[1] === 'remove') installed.delete(scope);
      if (args[1] === 'enable') enabled.add(scope);
      return { exitCode: 0, stdout: '', stderr: '' };
    } };
  const original = getAgentPluginAdapter(platform);
  const adapter: typeof original = { ...original,
    discover: async () => ({ platform, availability: 'available', installations: [product, ...options.excludedProduct ? [options.excludedProduct] : []], diagnostics: [] }),
    capabilities(input) { const value = original.capabilities(input); value.kinds.skill = { ...value.kinds.skill, status: 'supported', reasonCodes: [] }; return value; },
    async inspect(ctx, binding) {
      const layout = await getDeploymentLayout(ctx, binding);
      const present = await fs.pathExists(layout.packageRoot);
      const scope = platform === 'claude' ? binding.scope.kind === 'project' ? 'local' : 'user' : 'global';
      const active = platform === 'claude' ? enabled.has(scope) : (await readCodexConfigFile(path.join(binding.scope.kind === 'project'
        ? path.join(binding.scope.projectRoot, '.codex') : product.entry!.kind === 'cli' ? product.entry!.configRoot : '', 'config.toml'))).snapshot.plugins[layout.nativeIdentity.registrationId!]?.enabled === true;
      return { physicalKey: binding.physicalKey, package: present ? 'present' : 'absent', ownership: present ? 'aw' : 'absent',
        registration: installed.has(scope) ? 'present' : 'absent', nativeIdentity: layout.nativeIdentity,
        consumers: binding.consumers.map((consumer) => ({ productId: consumer.id, activationKey: binding.activationKey,
          activation: active ? 'enabled' : 'disabled', trust: 'trusted', load: 'not-observed' })), components: [],
        prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
    },
  };
  context.platformRebuildSession = new PlatformRebuildSession(context, () => adapter);
  const integration = createRebuildIntegration({ context });
  const inputs = (['user', 'project'] as const).map((scope) => ({ plugin, platform, scope, cwd: isolation.layout.fixtureCwd,
    command: 'install' as const, catalog: { rootDir: root, source: 'local' as const, catalogVersion: '1.0.0', channel: 'latest' as const } }));
  await integration.resolvePlatformTargets(inputs);
  const targets = [];
  for (const input of inputs) targets.push(await integration.buildTarget(input));
  await integration.sealMarketplaceGenerations(targets);
  return { context, integration, targets, calls, installed, inputs };
}

describe('required native actions and product exclusions', () => {
  it('rejects an external registration change before any reviewed native action', async () => {
    const item = await registrationFixture();
    try {
      const plan = item.targets[0]!.platformDeployment!.plans[0]!;
      item.installed.add('global');
      const result = await executeRebuildOperation({ command: 'install', target: item.targets[0]!, driver: item.integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { phase: 'preflight', message: expect.stringContaining('operationPlanStale') } });
      expect(item.calls).toEqual([]);
      expect(await fs.pathExists(plan.evidence.layout.packageRoot)).toBe(false);
      expect(await fs.pathExists(plan.evidence.layout.marketplaceRoot!)).toBe(false);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: a confirmed registration cannot hide a skipped required activation.
  it('keeps a partial registration failed when its activation did not execute', async () => {
    const item = await registrationFixture({ failAfterRegister: true });
    try {
      const result = await executeRebuildOperation({ command: 'install', target: item.targets[0]!, driver: item.integration.driver });
      expect(result.status).toBe('failed');
      const receipt = result.deploymentReceipts![0]!;
      expect(receipt.after).toMatchObject({ package: 'present', registration: 'present', consumers: [expect.objectContaining({ activation: 'disabled' })] });
      expect(receipt.effects.map((effect) => effect.status)).toEqual(['applied', 'applied', 'skipped']);
      expect(receipt.unmet).toEqual(expect.arrayContaining([expect.objectContaining({ reasonCode: 'deploymentDependencyFailed' })]));
      await item.context.platformRebuildSession!.dispose();
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget({ ...item.inputs[0]!, command: 'sync' });
      await integration.sealMarketplaceGenerations([target]);
      expect(target.platformDeployment!.plans[0]!.effects.map((effect) => effect.kind)).toEqual(['activate']);
      expect((await executeRebuildOperation({ command: 'sync', target, driver: integration.driver })).status).toBe('succeeded');
      expect(item.calls.filter((args) => args[0] === 'plugin' && args[1] === 'add')).toHaveLength(1);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  it.each(['codex', 'claude'] as const)('respects the real shared registration scope for %s', async (platform) => {
    const item = await registrationFixture({ platform });
    try {
      for (const target of item.targets) {
        const result = await executeRebuildOperation({ command: 'install', target, driver: item.integration.driver });
        expect(result.status, JSON.stringify(result)).toBe('succeeded');
        expect(result.deploymentReceipts![0]!.after.consumers.every((consumer) => consumer.activation === 'enabled')).toBe(true);
      }
      const registrations = item.calls.filter((args) => args[0] === 'plugin' && ['add', 'install'].includes(args[1]!));
      expect(registrations).toHaveLength(platform === 'codex' ? 1 : 2);
      if (platform === 'claude') expect(registrations.map((args) => args.at(-1)).sort()).toEqual(['local', 'user']);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  it('refreshes a shared native package once while activating both scopes', async () => {
    const item = await registrationFixture();
    try {
      for (const target of item.targets) expect((await executeRebuildOperation({ command: 'install', target, driver: item.integration.driver })).status).toBe('succeeded');
      await item.context.platformRebuildSession!.dispose();
      await fs.appendFile(path.join(item.inputs[0]!.plugin.rootDir, 'skills/check/SKILL.md'), '\nChanged source.');
      item.context.preparedArtifactRenderResults = new Map();
      const integration = createRebuildIntegration({ context: item.context });
      const inputs = item.inputs.map((input) => ({ ...input, command: 'sync' as const }));
      await integration.resolvePlatformTargets(inputs);
      const targets = [];
      for (const input of inputs) targets.push(await integration.buildTarget(input));
      await integration.sealMarketplaceGenerations(targets);
      for (const target of targets) {
        expect(target.platformDeployment!.plans[0]!.effects.some((effect) => effect.kind === 'refresh')).toBe(true);
        const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
        expect(result.status, JSON.stringify(result)).toBe('succeeded');
      }
      expect(item.calls.filter((args) => args[0] === 'plugin' && args[1] === 'add')).toHaveLength(2);
      expect(item.calls.filter((args) => args[0] === 'plugin' && args[1] === 'remove')).toHaveLength(1);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  it.each([
    { available: 'cli', excluded: 'app', version: '0.151.0', availability: 'unsupported', reason: 'clientVersionUnsupported' },
    { available: 'app', excluded: 'cli', version: null, availability: 'unknown', reason: 'clientProbeFailed' },
  ] as const)('freezes an identified $excluded exclusion beside the available $available', async (value) => {
    const product: ProductInstallation = { id: 'excluded-product', product: value.excluded, version: value.version,
      availability: value.availability, entry: null, reasonCodes: [value.reason] };
    const item = await registrationFixture({ availableProduct: value.available, excludedProduct: product });
    try {
      expect(item.targets[0]!.deploymentExclusions).toEqual([expect.objectContaining({ productId: product.id, product,
        reasonCode: value.reason, execution: 'not-run' })]);
      const result = await executeRebuildOperation({ command: 'install', target: item.targets[0]!, driver: item.integration.driver });
      expect(result.status).toBe('succeeded');
      expect(result.deploymentExclusions).toEqual(item.targets[0]!.deploymentExclusions);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });
});
