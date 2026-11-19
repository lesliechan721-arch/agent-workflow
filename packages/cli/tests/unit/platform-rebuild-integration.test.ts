import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { getPlatformFeatureRegistry } from '@lesliechan721/aw-plugin-core/manifest';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation, prepareRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { readSkillOwnerMarker, SKILL_OWNER_MARKER, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { createNoopReporter } from '../../src/output/reporter.js';
import { createNoopDebugLogger } from '../../src/output/debug-log.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import type { ProductInstallation } from '../../src/platforms/contracts.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { withNativeObservationBatch } from '../../src/platforms/inspection-query.js';
import { geminiExtensionPaths, geminiScopePattern } from '../../src/platforms/gemini-activation.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { resolveAbsoluteAwHome } from '../../src/utils/state-paths.js';

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
  const runner = vi.fn(async (_request: Parameters<RebuildExecutionContext['nativeCliRunner']>[0]) => ({ exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' }));
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
  return { root, context, integration, target, packageRoot: component.path, runner };
}

describe('frozen platform rebuild integration', () => {
  // Test Value Gate: a complete intentional empty set revokes only proven owned output through the real adapter pipeline.
  it('removes an owned directory for a successful intentional empty collection', async () => {
    const item = await fixture();
    try {
      expect(item.target.platformDeployment?.plans[0]?.expected).toMatchObject({ components: [], unmet: [] });
      expect(item.target.platformDeployment?.plans[0]?.effects.some((effect) => effect.kind === 'remove-owned')).toBe(true);
      item.runner.mockClear();
      const preparation = await prepareRebuildOperation({ command: 'sync', target: item.target, driver: item.integration.driver });
      expect(item.runner.mock.calls.filter(([request]) => request.args.includes('--version')).length).toBeGreaterThan(0);
      if (preparation.status !== 'ready') throw new Error('Expected ready owned cleanup.');
      const result = await executeRebuildOperation({ command: 'sync', target: item.target, driver: item.integration.driver, preparation: preparation.preparation });
      expect(result.status).toBe('succeeded');
      expect(result.deploymentReceipts?.flatMap((receipt) => receipt.effects)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'applied', mutation: 'confirmed' }),
      ]));
      expect(await fs.pathExists(item.packageRoot)).toBe(false);
      expect(result.deploymentReceipts?.[0]?.after).toMatchObject({ package: 'absent', registration: 'not-applicable',
        consumers: expect.arrayContaining([expect.objectContaining({ activation: 'unknown' })]) });
      const binding = item.target.platformDeployment!.plans[0]!.binding;
      expect(await fs.readJson(path.join(resolveAbsoluteAwHome(item.context.env), 'platforms', binding.platform,
        'empty-state', `${binding.id.slice(7)}.json`))).toMatchObject({ kind: 'aw-platform-empty-state', result: 'intentional-empty',
        binding: { id: binding.id, scope: binding.scope } });
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

function evidenceReadGate() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const gate = { started: false, release, async read() { gate.started = true; await pending; } };
  return gate;
}

async function nativeEvidenceFixture(platform: 'gemini' | 'copilot' | 'antigravity' | 'pi', options: { state?: 'foreign' | 'unknown'; multiple?: boolean; scope?: 'user' | 'project' } = {}) {
  if (platform === 'antigravity') installNativeTestQualification({ platforms: ['antigravity'] });
  const isolated = getCurrentSourceTestIsolation();
  const root = path.join(isolated.layout.fixtureCwd, `${platform}-evidence-source`);
  const executable = path.join(isolated.layout.fixtureCwd, `${platform}-evidence-client`);
  await fs.outputFile(executable, 'controlled native entry');
  await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), {
    schemaVersion: 4, name: 'evidence-demo', version: '1.0.0', description: 'Native evidence boundary.',
    skills: './skills',
    platforms: [platform], marketplace: { category: 'development', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  });
  await fs.outputFile(path.join(root, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check evidence.\n---\nCheck.\n');
  const plugin = await readPluginManifest(root, { mode: 'bundle' });
  Object.assign(plugin, { sourceId: 'team', pluginId: 'team/evidence-demo', sourceIdentity: `sha256:${'d'.repeat(64)}` });
  const reads: { discovery?: () => Promise<void>; inspection?: () => Promise<void>; mutation?: () => void | Promise<void>;
    geminiInstallSource?: () => string; antigravityInstallSource?: () => string; copilotActivation?: () => boolean } = {};
  const inventories = platform === 'pi' ? ['list'] : platform === 'gemini' ? ['extensions list --output-format json'] : platform === 'antigravity' ? ['plugin list --json'] : ['plugin marketplace list --json', 'plugin list --json'];
  let layout: Awaited<ReturnType<typeof getDeploymentLayout>> | undefined;
  let marketplaceAdded = false;
  let installed = false;
  let enabled = false;
  let clientVersion = platform === 'pi' ? '1.5.0' : platform === 'gemini' ? '0.67.0' : platform === 'antigravity' ? '1.3.4' : '1.0.95';
  const runner = vi.fn(async (invocation: Parameters<RebuildExecutionContext['nativeCliRunner']>[0]) => {
    const args = invocation.args;
    if (inventories.includes(args.join(' '))) {
      if (platform === 'pi') return { exitCode: 0, stderr: '', stdout: options.state === 'unknown' ? 'invalid inventory' : installed
        ? `${options.scope === 'project' ? 'Project' : 'User'} packages:\n  ${layout!.packageRoot}\n    ${layout!.packageRoot}\n` : 'No packages installed.\n' };
      if (platform === 'antigravity') return { exitCode: 0, stderr: '', stdout: JSON.stringify(installed ? [{
        name: layout!.nativeIdentity.packageId, source: 'antigravity', enabled,
        path: path.join(layout!.physicalIdentity.namespaceRoot, 'plugins', layout!.nativeIdentity.packageId), version: '1.0.0',
      }] : []) };
      if (platform === 'gemini') {
        if (!installed) return { exitCode: 0, stdout: '', stderr: '[]' };
        const { root, file } = geminiExtensionPaths({ cwd: invocation.cwd, env: isolated.env });
        const config = await fs.readJson(file).catch(() => ({}));
        let isActive = true;
        for (const rule of config[layout!.nativeIdentity.packageId]?.overrides ?? []) {
          const pattern = rule.startsWith('!') ? rule.slice(1) : rule;
          const location = pattern.slice(0, -2);
          if (pattern === '*' || invocation.cwd === location || invocation.cwd.startsWith(`${location}${path.sep}`)) isActive = !rule.startsWith('!');
        }
        return { exitCode: 0, stdout: '', stderr: JSON.stringify([{
          name: layout!.nativeIdentity.packageId, path: path.join(root, layout!.nativeIdentity.packageId), isActive,
          installMetadata: { type: 'local', source: layout!.packageRoot },
        }]) };
      }
      if (options.state === 'unknown' && args[1] === 'marketplace') return { exitCode: 0, stdout: '{}', stderr: '' };
      const user = await fs.readJson(path.join(layout?.activationPath ?? resolvePlatformConfigRoot(platform,
        { cwd: invocation.cwd, env: isolated.env }), 'settings.json')).catch(() => ({}));
      const project = await fs.readJson(path.join(invocation.cwd, '.github/copilot/settings.json')).catch(() => ({}));
      const local = await fs.readJson(path.join(invocation.cwd, '.github/copilot/settings.local.json')).catch(() => ({}));
      const enabledPlugins = { ...user.enabledPlugins, ...project.enabledPlugins, ...local.enabledPlugins };
      const rows = args[1] === 'marketplace' ? marketplaceAdded ? [{ name: layout!.marketplaceName, source: layout!.marketplaceRoot }] : []
        : installed ? [{ name: layout!.nativeIdentity.packageId, marketplace: layout!.marketplaceName,
          source: layout!.marketplaceRoot, enabled: reads.copilotActivation?.() ?? enabledPlugins[layout!.nativeIdentity.registrationId!] !== false }] : [];
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    await reads.mutation?.();
    if (platform === 'pi') {
      if (args[0] !== 'install' && args[0] !== 'remove') throw new Error('Unexpected fixture Pi mutation.');
      installed = args[0] === 'install';
    } else if (platform === 'antigravity') {
      const directory = path.join(layout!.physicalIdentity.namespaceRoot, 'plugins', layout!.nativeIdentity.packageId);
      if (args[1] === 'install') {
        await fs.remove(directory);
        await fs.copy(reads.antigravityInstallSource?.() ?? args[2]!, directory);
        installed = true; enabled = true;
      } else if (args[1] === 'uninstall') { await fs.remove(directory); installed = false; enabled = false; }
      else if (args[1] === 'enable' || args[1] === 'disable') enabled = args[1] === 'enable';
      else throw new Error('Unexpected fixture native mutation.');
    } else if (platform === 'copilot' && args[1] === 'marketplace' && args[2] === 'add') marketplaceAdded = true;
    else if (platform === 'copilot' && args[1] === 'install') installed = true;
    else if (platform === 'gemini' && args[0] === 'extensions' && ['install', 'uninstall'].includes(args[1]!)) {
      const { home, root, file } = geminiExtensionPaths({ cwd: isolated.layout.fixtureCwd, env: isolated.env });
      const installedRoot = path.join(root, layout!.nativeIdentity.packageId);
      const config: Record<string, { overrides: string[] }> = await fs.pathExists(file) ? await fs.readJson(file) : {};
      if (args[1] === 'uninstall') {
        await fs.remove(installedRoot);
        delete config[layout!.nativeIdentity.packageId];
        installed = false;
      } else {
        await fs.copy(reads.geminiInstallSource?.() ?? args[2]!, installedRoot);
        await fs.outputJson(path.join(installedRoot, '.gemini-extension-install.json'), { type: 'local', source: args[2] });
        // This fixture has only the global rule. Fixed 0.67.0 appends HOME
        // and writes the enablement map without a trailing newline.
        config[layout!.nativeIdentity.packageId] = { overrides: [...(config[layout!.nativeIdentity.packageId]?.overrides ?? []), geminiScopePattern(home)] };
        installed = true;
      }
      await fs.outputFile(file, JSON.stringify(config, null, 2));
    } else throw new Error('Unexpected fixture native mutation.');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const context: RebuildExecutionContext = { env: isolated.env, nativeCliRunner: runner,
    nativeConsent: true, reporter: createNoopReporter(), debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
  const original = getAgentPluginAdapter(platform);
  const adapter: typeof original = { ...original,
    discover: vi.fn<typeof original.discover>(async (ctx) => {
      await reads.discovery?.();
      const configRoot = resolvePlatformConfigRoot(platform, ctx);
      return { platform, availability: 'available', diagnostics: [], installations: (options.multiple ? [configRoot, `${configRoot}-second`] : [configRoot])
        .map((root, index) => ({ id: `${platform}-evidence-client-${index}`, product: 'cli' as const,
          version: clientVersion, availability: 'available' as const, reasonCodes: [],
          entry: { kind: 'cli' as const, executable, configRoot: root } })) };
    }),
    inspect: vi.fn<typeof original.inspect>(async (ctx, binding) => { await reads.inspection?.(); return original.inspect(ctx, binding); }),
  };
  if (options.state === 'foreign') {
    const ctx = { cwd: isolated.layout.fixtureCwd, env: isolated.env, runner };
    const resolved = await adapter.resolve(ctx, { plugin: { sourceId: plugin.sourceId!, sourceIdentity: plugin.sourceIdentity!,
      pluginId: plugin.pluginId!, version: plugin.manifest.version }, scope: options.scope === 'project' ? { kind: 'project', projectRoot: isolated.layout.fixtureCwd } : { kind: 'user' }, operation: 'ensure',
      discovery: await adapter.discover(ctx), recoveryCandidates: [] });
    const foreignLayout = await getDeploymentLayout(ctx, resolved.bindings[0]!);
    await fs.outputFile(path.join(foreignLayout.packageRoot, 'foreign.txt'), 'Keep foreign content.');
  }
  context.platformRebuildSession = new PlatformRebuildSession(context, () => adapter);
  const integration = createRebuildIntegration({ context });
  const input = { plugin, platform, scope: options.scope ?? 'user', cwd: isolated.layout.fixtureCwd,
    command: 'install' as const, catalog: { rootDir: root, source: 'local' as const, catalogVersion: '1.0.0', channel: 'latest' as const } };
  const target = await integration.buildTarget(input);
  expect(target.platformDeployment?.plans).toHaveLength(options.multiple ? 2 : 1);
  layout = await getDeploymentLayout({ cwd: input.cwd, env: isolated.env }, target.platformDeployment!.plans[0]!.binding);
  await integration.sealMarketplaceGenerations([target]);
  return { root, context, integration, target, reads, runner, inventories, adapter, input, layout,
    changeRegistration: () => { installed = true; }, changeClient: () => { clientVersion = '1.0.96'; } };
}

describe('native evidence checks', () => {
  // Test Value Gate: a shared ordinary read must not hide native registration
  // changing between the post-render baseline and the final verification.
  it('shares ordinary Pi inventories and rereads registration before returning a target', async () => {
    const item = await nativeEvidenceFixture('pi');
    await item.context.platformRebuildSession!.dispose();
    const adapter: typeof item.adapter = { ...item.adapter, lifecycle: { ...item.adapter.lifecycle,
      prepare(input) {
        const result = item.adapter.lifecycle.prepare(input);
        item.changeRegistration();
        return result;
      },
    } };
    item.runner.mockClear();
    const inventoryCwds = () => item.runner.mock.calls.flatMap(([request]) =>
      request.args.join(' ') === 'list' ? [request.cwd] : []);
    await withNativeObservationBatch({ runner: item.runner }, async (nativeObservationBatch) => {
      const context = { ...item.context, preparedArtifactRenderResults: new Map(), nativeObservationBatch };
      const session = new PlatformRebuildSession(context, () => adapter);
      try {
        const integration = createRebuildIntegration({ context: { ...context, platformRebuildSession: session } });
        const inspected = await integration.buildTarget({ ...item.input, readOnlyInspectionPlan: true });
        expect(inspected.platformObservations?.[0]?.observation.registration).toBe('absent');
        expect(inventoryCwds()).toHaveLength(1);

        await expect(integration.buildTarget(item.input)).rejects.toThrow('operationPlanStale');
        expect(inventoryCwds()).toHaveLength(3);
        expect(new Set(inventoryCwds()).size).toBe(3);

        await expect(integration.buildTarget(item.input)).rejects.toThrow('operationPlanStale');
        expect(inventoryCwds()).toHaveLength(4);
        const refreshed = await integration.buildTarget({ ...item.input, readOnlyInspectionPlan: true });
        expect(refreshed.platformObservations?.[0]?.observation.registration).toBe('present');
        expect(inventoryCwds()).toHaveLength(5);
      } finally { await session.dispose(); }
    });
    expect(await Promise.all(inventoryCwds().map((cwd) => fs.pathExists(cwd)))).toEqual([false, false, false, false, false]);
    expect(await fs.pathExists(item.layout.packageRoot)).toBe(false);
  });

  // Test Value Gate: code-cache writes must not stale package evidence or survive
  // the session that owns the existing private staging root.
  it('shares a private Gemini code-cache directory and removes it with staging', async () => {
    const item = await nativeEvidenceFixture('gemini');
    try {
      const contexts = vi.mocked(item.adapter.discover).mock.calls.map(([ctx]) => ctx);
      const first = contexts[0]!.nativeNodeCompileCacheDir;
      const second = contexts[1]!.nativeNodeCompileCacheDir;
      if (!first || !second) throw new Error('Expected private lazy cache providers.');
      const [one, two] = await Promise.all([first(), second()]);
      expect(one === two).toBe(true);
      await fs.outputFile(path.join(one, 'compiled-code'), 'Temporary compiled code.');
      const inspections = vi.mocked(item.adapter.inspect).mock.calls.length;
      await item.target.platformDeployment!.verify();
      expect(vi.mocked(item.adapter.inspect).mock.calls.length).toBe(inspections + 1);
      await item.context.platformRebuildSession!.dispose();
      expect(await fs.pathExists(one)).toBe(false);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: an optional optimization cannot retain a rejected promise
  // that prevents the later mandatory staging allocation from recovering.
  it('recovers staging after an optional Gemini cache allocation fails', async () => {
    const item = await nativeEvidenceFixture('gemini');
    let first = true;
    const adapter: typeof item.adapter = { ...item.adapter, async discover(ctx) {
      if (first) {
        first = false;
        const failure = new Error('Controlled optional cache allocation failure.');
        const allocate = vi.spyOn(fs, 'mkdtemp').mockRejectedValueOnce(failure);
        try {
          if (!ctx.nativeNodeCompileCacheDir) throw new Error('Expected a cache provider.');
          await expect(ctx.nativeNodeCompileCacheDir()).rejects.toBe(failure);
        } finally { allocate.mockRestore(); }
      }
      return item.adapter.discover(ctx);
    } };
    try {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => adapter);
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget(item.input);
      expect(target.platformDeployment?.plans.length).toBe(1);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: accepting a newer mutable baseline must not preserve an
  // absent plan that overwrites a foreign native copy created during preparation.
  it('protects a foreign Antigravity copy appearing during preparation', async () => {
    const item = await nativeEvidenceFixture('antigravity');
    const directory = path.join(item.layout.physicalIdentity.namespaceRoot, 'plugins', item.layout.nativeIdentity.packageId);
    const foreign = path.join(directory, 'keep.txt');
    try {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => item.adapter);
      let inspections = 0;
      item.reads.inspection = async () => {
        if (++inspections === 2) { await fs.outputFile(foreign, 'Keep foreign content.'); item.changeRegistration(); }
      };
      item.runner.mockClear();
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget({ ...item.input, command: 'install' });
      await integration.sealMarketplaceGenerations([target]);
      const result = await executeRebuildOperation({ command: 'install', target, driver: integration.driver });
      expect(result.status).toBe('failed');
      expect(item.runner.mock.calls.filter(([invocation]) => invocation.args[1] === 'install')).toEqual([]);
      expect(await fs.readFile(foreign, 'utf8')).toBe('Keep foreign content.');
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: retry planning and the final grouped check must read the
  // actual Antigravity copy, including an old copy with a valid old owner.
  it('repairs Antigravity copy drift and rejects stale native and grouped postchecks', async () => {
    const item = await nativeEvidenceFixture('antigravity');
    const installed = path.join(item.layout.physicalIdentity.namespaceRoot, 'plugins', item.layout.nativeIdentity.packageId);
    const oldCopy = path.join(item.input.cwd, 'old-antigravity-copy');
    const run = async (integration: typeof item.integration, target: typeof item.target, command: 'install' | 'sync') => {
      const preparation = await prepareRebuildOperation({ command, target, driver: integration.driver });
      expect(preparation.status, JSON.stringify(preparation)).toBe('ready');
      if (preparation.status !== 'ready') throw new Error('Expected a ready native deployment.');
      return executeRebuildOperation({ command, target, driver: integration.driver, preparation: preparation.preparation });
    };
    const prepareSync = async () => {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => item.adapter);
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget({ ...item.input, command: 'sync' });
      await integration.sealMarketplaceGenerations([target]);
      return { integration, target };
    };
    try {
      expect((await run(item.integration, item.target, 'install')).status).toBe('succeeded');
      await fs.copy(installed, oldCopy);
      await fs.outputFile(path.join(item.root, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check evidence.\n---\nRevision 2.\n');
      const changed = await prepareSync();
      item.reads.antigravityInstallSource = () => oldCopy;
      const stale = await run(changed.integration, changed.target, 'sync');
      expect(stale.status, JSON.stringify(stale)).toBe('failed');
      expect(await fs.readFile(path.join(item.layout.packageRoot, 'skills/check/SKILL.md'), 'utf8')).toContain('Revision 2.');
      item.reads.antigravityInstallSource = undefined;
      const retry = await prepareSync();
      const plan = retry.target.platformDeployment!.plans[0]!;
      expect(plan.evidence.contentMatches).toBe(true);
      expect(plan.effects.map((effect) => effect.kind)).toEqual(['refresh', 'activate']);
      item.runner.mockClear();
      const recovered = await run(retry.integration, retry.target, 'sync');
      expect(recovered.status, JSON.stringify(recovered)).toBe('succeeded');
      expect(item.runner.mock.calls.filter(([invocation]) => invocation.args[1] === 'uninstall')).toEqual([]);
      expect(await fs.readFile(path.join(installed, 'skills/check/SKILL.md'), 'utf8')).toContain('Revision 2.');
      await retry.target.platformDeployment!.postcheck(recovered.deploymentReceipts!, { refresh: true });
      await fs.remove(installed);
      await fs.copy(oldCopy, installed);
      await expect(retry.target.platformDeployment!.postcheck(recovered.deploymentReceipts!, { refresh: true })).rejects.toThrow('deploymentPostcheckFailed');
      expect(recovered.deploymentReceipts?.[0]?.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeInstallContentPostcheckFailed' }));
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: an already-published AW package cannot hide an old or
  // unconfirmed native copy on the next ordinary prepare/execute cycle.
  it.each(['legacy copy', 'data guard', 'native postcheck'] as const)('retries Gemini sync from %s using fresh installed bytes', async (scenario) => {
    const item = await nativeEvidenceFixture('gemini');
    const installed = path.join(geminiExtensionPaths({ cwd: item.input.cwd, env: item.context.env }).root, item.layout.nativeIdentity.packageId);
    const previousCopy = path.join(item.input.cwd, 'previous-gemini-copy');
    const run = async (integration: typeof item.integration, target: typeof item.target, command: 'install' | 'sync') => {
      const preparation = await prepareRebuildOperation({ command, target, driver: integration.driver });
      expect(preparation.status, JSON.stringify(preparation)).toBe('ready');
      if (preparation.status !== 'ready') throw new Error('Expected a ready native deployment.');
      return executeRebuildOperation({ command, target, driver: integration.driver, preparation: preparation.preparation });
    };
    const prepareSync = async () => {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => item.adapter);
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget({ ...item.input, command: 'sync' });
      await integration.sealMarketplaceGenerations([target]);
      return { integration, target };
    };
    try {
      const initial = await run(item.integration, item.target, 'install');
      expect(initial.status, JSON.stringify(initial)).toBe('succeeded');
      await fs.copy(installed, previousCopy);
      await fs.outputFile(path.join(item.root, 'skills/check/SKILL.md'), '---\nname: check\ndescription: Check evidence.\n---\nRevision 3.\n');
      if (scenario === 'data guard') await fs.outputFile(path.join(installed, '.env'), 'PRIVATE_SETTING=retain\n');
      if (scenario === 'native postcheck') item.reads.geminiInstallSource = () => previousCopy;
      const changed = await prepareSync();
      const changedResult = await run(changed.integration, changed.target, 'sync');
      if (scenario === 'legacy copy') {
        expect(changedResult.status, JSON.stringify(changedResult)).toBe('succeeded');
        await fs.remove(installed);
        await fs.copy(previousCopy, installed);
      } else {
        expect(changedResult.status, JSON.stringify(changedResult)).toBe('failed');
        expect(changedResult.deploymentReceipts?.flatMap((receipt) => receipt.diagnostics)).toContainEqual(expect.objectContaining({
          code: scenario === 'data guard' ? 'nativeRefreshDataUnconfirmed' : 'nativeInstallContentPostcheckFailed',
        }));
        if (scenario === 'data guard') {
          const unchangedSource = await prepareSync();
          expect(unchangedSource.target.platformDeployment!.plans[0]!.evidence.contentMatches).toBe(true);
          expect(unchangedSource.target.platformDeployment!.deployments[0]!.driverState.before.nativePackageContentDigest).toBeUndefined();
          expect(unchangedSource.target.platformDeployment!.plans[0]!.effects.map((effect) => effect.kind)).toEqual(['refresh', 'activate']);
          item.runner.mockClear();
          const blocked = await run(unchangedSource.integration, unchangedSource.target, 'sync');
          expect(blocked.status, JSON.stringify(blocked)).toBe('failed');
          expect(blocked.deploymentReceipts?.flatMap((receipt) => receipt.diagnostics)).toContainEqual(expect.objectContaining({ code: 'nativeRefreshDataUnconfirmed' }));
          expect(item.runner.mock.calls.filter(([invocation]) => !item.inventories.includes(invocation.args.join(' ')))).toEqual([]);
          expect(await fs.readFile(path.join(installed, '.env'), 'utf8')).toBe('PRIVATE_SETTING=retain\n');
          await fs.remove(path.join(installed, '.env'));
        }
        item.reads.geminiInstallSource = undefined;
      }
      const retry = await prepareSync();
      const plan = retry.target.platformDeployment!.plans[0]!;
      expect(plan.evidence.contentMatches).toBe(true);
      expect(plan.effects.map((effect) => effect.kind)).toEqual(['refresh', 'activate']);
      item.runner.mockClear();
      const recovered = await run(retry.integration, retry.target, 'sync');
      expect(recovered.status, JSON.stringify(recovered)).toBe('succeeded');
      expect(item.runner.mock.calls.filter(([invocation]) => !item.inventories.includes(invocation.args.join(' '))).map(([invocation]) => invocation.args)).toEqual([
        ['extensions', 'uninstall', item.layout.nativeIdentity.packageId],
        ['extensions', 'install', item.layout.packageRoot, '--consent', '--skip-settings'],
      ]);
      const bundle = plan.projections.find((projection) => projection.bundle)!.bundle!;
      expect(recovered.deploymentReceipts?.[0]?.after.nativePackageContentDigest).toBe(bundle.contentDigest);
      const relativeOutput = plan.projections.flatMap((projection) => projection.components)[0]!.relativeOutputs[0]!;
      expect(await fs.readFile(path.join(installed, relativeOutput), 'utf8')).toContain('Revision 3.');
      await retry.target.platformDeployment!.postcheck(recovered.deploymentReceipts!, { refresh: true });
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: only the creator may reuse its just-read client discovery.
  // Every local/native observation and every cached call stays fresh.
  it.each(['gemini', 'pi'] as const)('keeps first-build %s observations fresh while reusing only discovery', async (platform) => {
    const item = await nativeEvidenceFixture(platform);
    try {
      expect(vi.mocked(item.adapter.discover).mock.calls.length).toBe(2);
      expect(vi.mocked(item.adapter.inspect).mock.calls.length).toBe(3);
      const cached = await item.integration.buildTarget(item.input);
      expect(cached.platformDeployment).toBe(item.target.platformDeployment);
      expect(vi.mocked(item.adapter.discover).mock.calls.length).toBe(3);
      expect(vi.mocked(item.adapter.inspect).mock.calls.length).toBe(4);
      item.changeClient();
      await expect(item.integration.buildTarget(item.input)).rejects.toThrow('operationPlanStale');
      expect(vi.mocked(item.adapter.discover).mock.calls.length).toBe(4);
      expect(vi.mocked(item.adapter.inspect).mock.calls.length).toBe(5);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: one target can contain distinct physical namespaces.
  it('keeps complete discovery checks for multiple Pi bindings', async () => {
    const item = await nativeEvidenceFixture('pi', { multiple: true });
    try {
      expect(item.target.platformDeployment?.plans).toHaveLength(2);
      expect(vi.mocked(item.adapter.discover).mock.calls.length).toBe(5);
      expect(vi.mocked(item.adapter.inspect).mock.calls.length).toBe(6);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: a failed creator check must not poison the cached raw build.
  it('rechecks the cached target after an initial source change is restored', async () => {
    const item = await nativeEvidenceFixture('pi');
    const changed = path.join(item.root, 'changed-during-preparation');
    let prepared = 0;
    const adapter: typeof item.adapter = { ...item.adapter, lifecycle: { ...item.adapter.lifecycle,
      prepare(input) {
        const result = item.adapter.lifecycle.prepare(input);
        if (++prepared === 1) fs.outputFileSync(changed, 'Changed after the baseline.');
        return result;
      },
    } };
    try {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => adapter);
      vi.mocked(adapter.discover).mockClear(); vi.mocked(adapter.inspect).mockClear();
      const integration = createRebuildIntegration({ context: item.context });
      await expect(integration.buildTarget(item.input)).rejects.toThrow('operationPlanStale');
      expect(vi.mocked(adapter.discover).mock.calls.length).toBe(2);
      await fs.remove(changed);
      const restored = await integration.buildTarget(item.input);
      expect(restored.platformDeployment?.plans).toHaveLength(1);
      expect(prepared).toBe(1);
      expect(vi.mocked(adapter.discover).mock.calls.length).toBe(3);
      expect(vi.mocked(adapter.inspect).mock.calls.length).toBe(4);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: actual native-copy bytes are outside the AW source paths.
  it('rereads Gemini native-copy bytes in the initial return check', async () => {
    const item = await nativeEvidenceFixture('gemini');
    try {
      const installed = await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(installed.status).toBe('succeeded');
      const relative = item.target.platformDeployment!.plans[0]!.projections.flatMap((projection) => projection.components)[0]!.relativeOutputs[0]!;
      const copy = path.join(geminiExtensionPaths({ cwd: item.input.cwd, env: item.context.env }).root,
        item.layout.nativeIdentity.packageId, relative);
      const original = await fs.readFile(copy, 'utf8');
      let prepared = 0;
      const adapter: typeof item.adapter = { ...item.adapter, lifecycle: { ...item.adapter.lifecycle,
        prepare(input) {
          const result = item.adapter.lifecycle.prepare(input);
          if (++prepared === 1) fs.writeFileSync(copy, `${original}\nChanged native copy.`);
          return result;
        },
      } };
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => adapter);
      item.runner.mockClear();
      const integration = createRebuildIntegration({ context: item.context });
      await expect(integration.buildTarget({ ...item.input, command: 'sync' })).rejects.toThrow('operationPlanStale');
      expect(item.runner.mock.calls.every(([request]) => item.inventories.includes(request.args.join(' ')))).toBe(true);
      expect(await fs.readFile(copy, 'utf8')).toContain('Changed native copy.');
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: waiting on the creator does not consume its private checker.
  it('keeps a concurrent cache hit independently fresh', async () => {
    const item = await nativeEvidenceFixture('pi');
    const gate = evidenceReadGate();
    let first: ReturnType<typeof item.integration.buildTarget> | undefined;
    let second: typeof first;
    try {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => item.adapter);
      vi.mocked(item.adapter.discover).mockClear(); vi.mocked(item.adapter.inspect).mockClear();
      let inspections = 0;
      item.reads.inspection = async () => { if (++inspections === 1) await gate.read(); };
      const integration = createRebuildIntegration({ context: item.context });
      const build = vi.spyOn(item.context.platformRebuildSession, 'buildTarget');
      first = integration.buildTarget(item.input);
      await vi.waitFor(() => expect(gate.started).toBe(true));
      second = integration.buildTarget(item.input);
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(2));
      gate.release();
      const [created, cached] = await Promise.all([first, second]);
      expect(created.platformDeployment).toBe(cached.platformDeployment);
      expect(vi.mocked(item.adapter.discover).mock.calls.length).toBe(3);
      expect(vi.mocked(item.adapter.inspect).mock.calls.length).toBe(4);
    } finally {
      gate.release();
      await Promise.allSettled([first, second].filter((value) => value !== undefined));
      await item.context.platformRebuildSession!.dispose();
    }
  });

  // Test Value Gate: first installs and installed syncs need one fresh execution
  // check, while receipt observation, mutation rebase and postcheck stay fresh.
  it.each(['gemini', 'copilot', 'pi'] as const)('checks fresh %s evidence once before first install and installed sync', async (platform) => {
    const item = await nativeEvidenceFixture(platform);
    let discovery = 0;
    let inspection = 0;
    item.reads.discovery = async () => { discovery++; };
    item.reads.inspection = async () => { inspection++; };
    const mutationReads: number[] = [];
    item.reads.mutation = () => { mutationReads.push(discovery); };
    try {
      expect(item.target.platformObservations?.[0]?.observation).toMatchObject({ package: 'absent', registration: 'absent', ownership: 'absent' });
      expect(item.target.platformDeployment!.plans[0]!.expected.components).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skill' })]));
      const preparation = await prepareRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(preparation.status).toBe('ready');
      if (preparation.status !== 'ready') throw new Error('Expected ready first install.');
      expect([discovery, inspection]).toEqual([0, 0]);
      const installed = await executeRebuildOperation({ command: 'install', target: item.target,
        driver: item.integration.driver, preparation: preparation.preparation });
      expect(installed.status, JSON.stringify(installed)).toBe('succeeded');
      expect(mutationReads.length).toBeGreaterThan(0);
      expect(mutationReads.every((count) => count === 1)).toBe(true);
      expect([discovery, inspection]).toEqual([2, 3]);
      expect(installed.deploymentReceipts?.[0]?.after).toMatchObject({ package: 'present', registration: 'present', ownership: 'aw' });
      await item.target.platformDeployment!.postcheck(installed.deploymentReceipts!, { refresh: true });
      expect([discovery, inspection]).toEqual([2, 4]);
      const changed = path.join(item.root, 'changed-after-execution');
      await fs.outputFile(changed, 'Changed.');
      const repeated = await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(repeated).toMatchObject({ status: 'failed', error: { phase: 'preflight', message: expect.stringContaining('operationPlanStale') } });
      expect(repeated.deploymentReceipts).toBeUndefined();
      expect(discovery).toBe(3);
      expect(mutationReads.every((count) => count === 1)).toBe(true);
      await fs.remove(changed);
      await item.context.platformRebuildSession!.dispose();

      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, () => item.adapter);
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget({ ...item.input, command: 'sync' });
      await integration.sealMarketplaceGenerations([target]);
      discovery = 0; inspection = 0; mutationReads.length = 0;
      const syncPreparation = await prepareRebuildOperation({ command: 'sync', target, driver: integration.driver });
      expect(syncPreparation.status).toBe('ready');
      if (syncPreparation.status !== 'ready') throw new Error('Expected ready installed sync.');
      expect([discovery, inspection]).toEqual([0, 0]);
      const synced = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver, preparation: syncPreparation.preparation });
      expect(synced.status, JSON.stringify(synced)).toBe('succeeded');
      expect(mutationReads).toEqual([]);
      expect([discovery, inspection]).toEqual([1, 2]);
      expect(synced.deploymentReceipts?.[0]?.after).toMatchObject({ package: 'present', registration: 'present', ownership: 'aw' });
      await target.platformDeployment!.postcheck(synced.deploymentReceipts!, { refresh: true });
      expect([discovery, inspection]).toEqual([1, 3]);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: only a valid hidden Project inventory and an empty owned
  // slot qualify; query failures retain the full preflight path and no writes.
  it.each(['hidden', 'unknown'] as const)('checks fresh Pi Project evidence for %s inventory', async (state) => {
    const item = await nativeEvidenceFixture('pi', { scope: 'project', ...(state === 'unknown' ? { state } : {}) });
    let discovery = 0;
    item.reads.discovery = async () => { discovery++; };
    try {
      expect(item.target.platformObservations?.[0]?.observation.registration).toBe('unknown');
      expect(item.target.platformDeployment!.canVerifyAtExecution()).toBe(state === 'hidden');
      const preparation = await prepareRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(preparation.status).toBe('ready');
      expect(discovery).toBe(state === 'hidden' ? 0 : 1);
      if (state === 'hidden') {
        await fs.outputFile(path.join(item.root, 'changed-after-review'), 'Changed.');
        const result = await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
        expect(result).toMatchObject({ status: 'failed', error: { phase: 'preflight', message: expect.stringContaining('operationPlanStale') } });
        expect(discovery).toBe(1);
      }
      expect(item.runner.mock.calls.every(([request]) => item.inventories.includes(request.args.join(' ')))).toBe(true);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: multiple physical deployments and unsafe observations keep
  // their full preparation checks instead of entering the single-plan path.
  it.each(['multiple', 'foreign', 'unknown'] as const)('keeps preparation verification for %s Copilot deployments', async (boundary) => {
    const item = await nativeEvidenceFixture('copilot', boundary === 'multiple' ? { multiple: true } : { state: boundary });
    let discovery = 0;
    item.reads.discovery = async () => { discovery++; };
    try {
      if (boundary === 'multiple') expect(item.target.platformDeployment!.deployments).toHaveLength(2);
      else expect(item.target.platformDeployment!.blockedReceipts).toHaveLength(1);
      const preparation = await prepareRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(discovery).toBe(boundary === 'multiple' ? 2 : 1);
      if (boundary === 'foreign') expect(preparation.status).toBe('failed');
      else expect(preparation.status).toBe('ready');
      expect(item.runner.mock.calls.every(([request]) => item.inventories.includes(request.args.join(' ')))).toBe(true);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: the execution-entry check must still block changed source,
  // client, owner, native registration and activation before any planned write.
  it.each(['source', 'client', 'owner', 'registration', 'activation'] as const)('blocks changed %s evidence at the native execution entry', async (changed) => {
    const item = await nativeEvidenceFixture('copilot');
    const mutations: string[] = [];
    item.reads.mutation = () => { mutations.push('native'); };
    try {
      const preparation = await prepareRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      if (preparation.status !== 'ready') throw new Error('Expected ready first install.');
      if (changed === 'source') await fs.outputFile(path.join(item.root, 'changed'), 'Changed.');
      else if (changed === 'client') item.changeClient();
      else if (changed === 'owner') await fs.outputFile(path.join(item.layout.packageRoot, 'foreign'), 'Keep.');
      else if (changed === 'registration') item.changeRegistration();
      else await fs.outputJson(path.join(item.layout.activationPath, 'settings.json'), {
        enabledPlugins: { [item.layout.nativeIdentity.registrationId!]: true },
      });
      const result = await executeRebuildOperation({ command: 'install', target: item.target,
        driver: item.integration.driver, preparation: preparation.preparation });
      expect(result).toMatchObject({ status: 'failed', error: { phase: 'preflight', message: expect.stringContaining('operationPlanStale') } });
      expect(result.deploymentReceipts).toBeUndefined();
      expect(mutations).toEqual([]);
      expect(await fs.pathExists(path.join(item.layout.packageRoot, 'plugin.json'))).toBe(false);
      if (changed === 'owner') expect(await fs.readFile(path.join(item.layout.packageRoot, 'foreign'), 'utf8')).toBe('Keep.');
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: a preApply source change must be detected after the script,
  // before the native client or package writer can mutate the deployment.
  it('retains fresh checks before and after a planned preApply', async () => {
    const item = await nativeEvidenceFixture('copilot');
    let discovery = 0;
    item.reads.discovery = async () => { discovery++; };
    item.target.preApplySource.manifest.scripts = { preApply: { path: './prepare.mjs' } };
    item.target.operationActions = [{ kind: 'runPreApply', pluginId: 'team/evidence-demo', platform: 'copilot', scope: 'user',
      script: './prepare.mjs', scriptDigest: 'sha256:script' }];
    const driver = { ...item.integration.driver, runPreApply: async () => {
      expect(discovery).toBe(1);
      await fs.outputFile(path.join(item.root, 'changed-by-script'), 'Changed.');
    } };
    try {
      const preparation = await prepareRebuildOperation({ command: 'install', target: item.target, driver });
      expect(preparation.status).toBe('ready');
      if (preparation.status !== 'ready') throw new Error('Expected prepared script.');
      const result = await executeRebuildOperation({ command: 'install', target: item.target, driver, preparation: preparation.preparation });
      expect(result).toMatchObject({ status: 'failed', error: { phase: 'preflight', message: expect.stringContaining('operationPlanStale') } });
      expect(discovery).toBe(2);
      expect(result.deploymentReceipts).toBeUndefined();
      expect(item.runner.mock.calls.every(([request]) => item.inventories.includes(request.args.join(' ')))).toBe(true);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: managed writes and missing action evidence cannot reuse a
  // pre-write success after the managed boundary changes a frozen input.
  it.each(['managed write', 'missing actions'] as const)('keeps full checks across %s', async (boundary) => {
    const item = await nativeEvidenceFixture('copilot');
    let discovery = 0;
    item.reads.discovery = async () => { discovery++; };
    item.target.operationActions = boundary === 'missing actions' ? undefined : [{ kind: 'syncManagedCommandPackage',
      pluginId: 'team/evidence-demo', scope: 'user', producer: { sourceId: 'team', sourceIdentity: item.input.plugin.sourceIdentity!,
        pluginName: 'evidence-demo', kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null, placementKey: null },
      sets: [], files: [], contentDigest: 'sha256:commands' }];
    const driver = { ...item.integration.driver, applyManagedCommands: async () => {
      expect(discovery).toBe(2);
      await fs.outputFile(path.join(item.root, 'changed-by-command'), 'Changed.');
    } };
    try {
      const preparation = await prepareRebuildOperation({ command: 'install', target: item.target, driver });
      expect(preparation.status).toBe('ready');
      if (preparation.status !== 'ready') throw new Error('Expected ready managed boundary.');
      const result = await executeRebuildOperation({ command: 'install', target: item.target, driver, preparation: preparation.preparation });
      expect(result).toMatchObject({ status: 'failed', error: { phase: 'native.write' },
        deploymentReceipts: [expect.objectContaining({ diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'operationPlanStale' })]) })] });
      expect(discovery).toBe(3);
      expect(item.runner.mock.calls.every(([request]) => item.inventories.includes(request.args.join(' ')))).toBe(true);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: a local no-op can disagree with effective native activation.
  it('fails the final check when an unchanged Copilot entry is disabled in native inventory', async () => {
    const item = await nativeEvidenceFixture('copilot', { scope: 'project' });
    try {
      const installed = await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(installed.status, JSON.stringify(installed)).toBe('succeeded');
      await item.context.platformRebuildSession!.dispose();
      item.reads.copilotActivation = () => false;
      const integration = createRebuildIntegration({ context: item.context });
      const target = await integration.buildTarget({ ...item.input, command: 'sync' });
      await integration.sealMarketplaceGenerations([target]);
      const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { phase: 'postcheck.inspect' }, deploymentReceipts: [
        { effects: [expect.objectContaining({ status: 'unchanged' })], after: { package: 'present', registration: 'present',
          consumers: [expect.objectContaining({ activation: 'disabled' })] },
        diagnostics: [expect.objectContaining({ code: 'deploymentPostcheckFailed' })] },
      ] });
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: an owned package with all paths present can have the wrong bytes.
  it('checks the package bytes after successful registration and activation', async () => {
    const item = await nativeEvidenceFixture('copilot');
    try {
      const [component] = item.target.platformDeployment!.plans[0]!.projections.flatMap((projection) => projection.components);
      const skillPath = path.join(item.layout.packageRoot, component!.relativeOutputs[0]!);
      item.reads.mutation = async () => { await fs.appendFile(skillPath, '\nChanged during native activation.\n'); };
      const result = await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { phase: 'postcheck.inspect' }, deploymentReceipts: [
        { after: { package: 'present', registration: 'present', ownership: 'aw',
          consumers: [expect.objectContaining({ activation: 'enabled' })] },
        unmet: [expect.objectContaining({ componentId: component!.id })] },
      ] });
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: same-byte refresh may repair metadata only while ownership is established.
  it('repairs an owned projection without touching the package and preserves a marker removed after review', async () => {
    const item = await nativeEvidenceFixture('copilot');
    try {
      expect((await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver })).status).toBe('succeeded');
      const root = item.layout.packageRoot;
      const markerPath = path.join(root, SKILL_OWNER_MARKER);
      const installedMarker = await fs.readJson(markerPath);
      const skillPath = path.join(root, installedMarker.nativeProjection.components[0].relativeOutputs[0]);
      const originalSkill = await fs.stat(skillPath);
      for (const removeAfterReview of [false, true]) {
        await item.context.platformRebuildSession!.dispose();
        await fs.outputJson(markerPath, { ...installedMarker, nativeProjection: { ...installedMarker.nativeProjection, inputDigest: 'invalid' } });
        const integration = createRebuildIntegration({ context: item.context });
        const target = await integration.buildTarget({ ...item.input, command: 'sync' });
        await integration.sealMarketplaceGenerations([target]);
        expect(target.platformDeployment!.plans[0]!.effects).toEqual([]);
        if (removeAfterReview) target.operationActions = undefined;
        const driver = removeAfterReview ? { ...integration.driver, applyManagedCommands: () => fs.remove(markerPath) } : integration.driver;
        const result = await executeRebuildOperation({ command: 'sync', target, driver });
        if (removeAfterReview) {
          expect(result).toMatchObject({ status: 'failed', deploymentReceipts: [{ effects: [],
            diagnostics: [expect.objectContaining({ code: 'operationPlanStale' })] }] });
          expect(await fs.pathExists(markerPath)).toBe(false);
        } else {
          expect(result.status, JSON.stringify(result)).toBe('succeeded');
          expect(await fs.readJson(markerPath)).toEqual(installedMarker);
        }
        expect(await fs.stat(skillPath)).toMatchObject({ ino: originalSkill.ino, mtimeMs: originalSkill.mtimeMs });
      }
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: slow CLI identity and inventory reads may overlap only
  // within one check. Each verification must finish both fresh reads.
  it.each(['gemini', 'copilot', 'pi'] as const)('overlaps fresh discovery and inspection at each %s verification boundary', async (platform) => {
    const item = await nativeEvidenceFixture(platform);
    const gates: ReturnType<typeof evidenceReadGate>[] = [];
    let pending: Promise<void> | undefined;
    try {
      for (let check = 0; check < 2; check++) {
        const discovery = evidenceReadGate();
        const inspection = evidenceReadGate();
        gates.push(discovery, inspection);
        item.reads.discovery = discovery.read;
        item.reads.inspection = inspection.read;
        let settled = false;
        pending = item.target.platformDeployment!.verify();
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await vi.waitFor(() => expect([discovery.started, inspection.started]).toEqual([true, true]));
        discovery.release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        inspection.release();
        await pending;
      }
    } finally {
      for (const gate of gates) gate.release();
      await pending?.catch(() => undefined);
      await item.context.platformRebuildSession!.dispose();
    }
  });

  // Test Value Gate: concurrent failures must not hide immutable staleness or
  // return before the other native read has completed.
  it.each(['gemini', 'copilot', 'pi'] as const)('waits for both %s reads and preserves stale and immutable error priority', async (platform) => {
    const item = await nativeEvidenceFixture(platform);
    const discovery = evidenceReadGate();
    const inspection = evidenceReadGate();
    let pending: Promise<void> | undefined;
    try {
      const changed = path.join(item.root, 'changed.txt');
      await fs.outputFile(changed, 'Changed after preparation.');
      const mutableError = new Error('Mutable evidence read failed.');
      let inspectionStarted = false;
      item.reads.discovery = discovery.read;
      item.reads.inspection = async () => { inspectionStarted = true; throw mutableError; };
      let settled = false;
      pending = item.target.platformDeployment!.verify();
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect([discovery.started, inspectionStarted]).toEqual([true, true]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      discovery.release();
      await expect(pending).rejects.toThrow('operationPlanStale');
      item.reads.discovery = undefined;
      item.reads.inspection = undefined;
      const result = await executeRebuildOperation({ command: 'sync', target: item.target, driver: item.integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(result.deploymentReceipts).toBeUndefined();
      expect(item.runner.mock.calls.every(([invocation]) => item.inventories.includes(invocation.args.join(' ')))).toBe(true);
      await fs.remove(changed);

      const immutableError = new Error('Immutable evidence read failed.');
      let immutableFailed = false;
      item.reads.discovery = async () => { immutableFailed = true; throw immutableError; };
      item.reads.inspection = async () => { await inspection.read(); throw mutableError; };
      settled = false;
      pending = item.target.platformDeployment!.verify();
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect([inspection.started, immutableFailed]).toEqual([true, true]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      inspection.release();
      await expect(pending).rejects.toBe(immutableError);
      const failedExecution = await executeRebuildOperation({ command: 'install', target: item.target, driver: item.integration.driver });
      expect(failedExecution).toMatchObject({ status: 'failed', error: { phase: 'preflight', message: immutableError.message } });
      expect(failedExecution.deploymentReceipts).toBeUndefined();
      expect(item.runner.mock.calls.every(([request]) => item.inventories.includes(request.args.join(' ')))).toBe(true);
    } finally {
      discovery.release(); inspection.release();
      await pending?.catch(() => undefined);
      await item.context.platformRebuildSession!.dispose();
    }
  });
});

async function marketplaceFixture(extras = false, names: readonly string[] = ['first', 'second']) {
  const isolated = getCurrentSourceTestIsolation();
  const claude = await createClaudeNativeTestRuntime(isolated);
  const bin = path.join(isolated.layout.fixtureCwd, 'marketplace-bin');
  await fs.outputFile(path.join(bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { ...isolated.env, PATH: `${bin}${path.delimiter}${isolated.env.PATH ?? ''}` };
  async function nativeRunner(invocation: Parameters<NonNullable<RebuildExecutionContext['nativeCliRunner']>>[0]) {
    if (invocation.args.includes('--version') && /opencode/iu.test(invocation.command)) {
      return { exitCode: 0, stdout: 'opencode 2.0.0', stderr: '' };
    }
    return claude.nativeCliRunner(invocation);
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
  for (const name of names) {
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
  return { context, integration, targets, adapterFor, claude };
}

describe('shared marketplace generation', () => {
  // Test Value Gate: retracting an inherited project requirement must not create
  // a false local override. An existing local installation still uses disable.
  it.each([
    { local: false, command: 'uninstall' },
    { local: false, command: 'sync' },
    { local: true, command: 'uninstall' },
  ] as const)('retracts Claude project with local=$local through $command without changing User', async ({ local, command }) => {
    const item = await marketplaceFixture(false, ['first']);
    const user = item.targets[0]!;
    const input = { plugin: user.plugin, platform: 'claude' as const, cwd: item.claude.projectRoot,
      catalog: { rootDir: user.plugin.rootDir, source: 'local' as const, catalogVersion: '1.0.0', channel: 'latest' as const } };
    const freshIntegration = async () => {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, item.adapterFor);
      return createRebuildIntegration({ context: item.context });
    };
    try {
      const installedUser = await executeRebuildOperation({ command: 'install', target: user, driver: item.integration.driver });
      expect(installedUser.status, JSON.stringify(installedUser)).toBe('succeeded');
      if (local) {
        const integration = await freshIntegration();
        const project = await integration.buildTarget({ ...input, scope: 'project', command: 'install' });
        await integration.sealMarketplaceGenerations([project]);
        const installed = await executeRebuildOperation({ command: 'install', target: project, driver: integration.driver });
        expect(installed.status, JSON.stringify(installed)).toBe('succeeded');
      }
      const packageRoot = user.platformDeployment!.plans[0]!.evidence.layout.packageRoot;
      const skill = path.join(packageRoot, 'skills/check/SKILL.md');
      const content = await fs.readFile(skill, 'utf8');
      if (command === 'sync') await fs.writeFile(path.join(input.plugin.rootDir, 'render.mjs'),
        'console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));');
      const integration = await freshIntegration();
      const target = await integration.buildTarget({ ...input, scope: 'project', command });
      await integration.sealMarketplaceGenerations([target]);
      const plan = target.platformDeployment!.plans[0]!;
      expect(target.platformDeployment!.deployments[0]!.driverState.before).toMatchObject({ registration: 'present',
        scopeRegistration: local ? 'present' : 'absent', configuration: { activation: local ? 'enabled' : 'absent' },
        consumers: [expect.objectContaining({ activation: 'enabled' })] });
      expect(plan.effects.map((effect) => effect.kind)).toEqual(local ? ['deactivate'] : []);
      item.claude.nativeCliRunner.mockClear();
      const removed = await executeRebuildOperation({ command, target, driver: integration.driver });
      expect(removed.status, JSON.stringify(removed)).toBe('succeeded');
      if (command === 'sync') {
        expect(await fs.readJson(path.join(resolveAbsoluteAwHome(item.context.env), 'platforms', plan.binding.platform,
          'empty-state', `${plan.binding.id.slice(7)}.json`))).toMatchObject({ kind: 'aw-platform-empty-state', result: 'intentional-empty',
          binding: { id: plan.binding.id, scope: plan.binding.scope } });
      }
      const nativeId = plan.evidence.layout.nativeIdentity.registrationId!;
      const settingsPath = path.join(input.cwd, '.claude/settings.local.json');
      if (local) expect((await fs.readJson(settingsPath)).enabledPlugins[nativeId]).toBe(false);
      else expect(await fs.pathExists(settingsPath)).toBe(false);
      const mutations = item.claude.nativeCliRunner.mock.calls.map(([call]) => call.args.slice(call.args.indexOf('plugin')))
        .filter((args) => args[0] === 'plugin' && args[1] !== 'list' && args[2] !== 'list');
      expect(mutations).toEqual(local ? [['plugin', 'disable', nativeId, '--scope', 'local']] : []);
      const records = (await fs.readJson(item.claude.installedPath)).plugins[nativeId] as Array<{ scope: string }>;
      expect(records.map((record) => record.scope).sort()).toEqual(local ? ['local', 'user'] : ['user']);
      expect(await fs.readFile(skill, 'utf8')).toBe(content);
      const ctx = { cwd: input.cwd, env: item.context.env, runner: item.context.nativeCliRunner };
      const adapter = getAgentPluginAdapter('claude');
      expect((await adapter.inspect(ctx, user.platformDeployment!.plans[0]!.binding)).consumers)
        .toContainEqual(expect.objectContaining({ activation: 'enabled' }));
      const project = await adapter.inspect(ctx, plan.binding);
      expect(project).toMatchObject({ package: 'present', ownership: 'aw', registration: 'present',
        scopeRegistration: local ? 'present' : 'absent',
        consumers: [expect.objectContaining({ activation: local ? 'disabled' : 'enabled' })] });
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });

  // Test Value Gate: inherited native enablement must still install the exact
  // project scope, which must survive removal of the User activation.
  it('registers Claude local scope beside User and retains it when User is revoked', async () => {
    const item = await marketplaceFixture(false, ['first']);
    const user = item.targets[0]!;
    const input = { plugin: user.plugin, platform: 'claude' as const, cwd: item.claude.projectRoot,
      catalog: { rootDir: user.plugin.rootDir, source: 'local' as const, catalogVersion: '1.0.0', channel: 'latest' as const } };
    const freshIntegration = async () => {
      await item.context.platformRebuildSession!.dispose();
      item.context.preparedArtifactRenderResults = new Map();
      item.context.platformRebuildSession = new PlatformRebuildSession(item.context, item.adapterFor);
      return createRebuildIntegration({ context: item.context });
    };
    try {
      const installedUser = await executeRebuildOperation({ command: 'install', target: user, driver: item.integration.driver });
      expect(installedUser.status, JSON.stringify(installedUser)).toBe('succeeded');

      const projectIntegration = await freshIntegration();
      const project = await projectIntegration.buildTarget({ ...input, scope: 'project', command: 'install' });
      await projectIntegration.sealMarketplaceGenerations([project]);
      const before = project.platformDeployment!.deployments[0]!.driverState.before;
      expect(before).toMatchObject({ registration: 'present', scopeRegistration: 'absent',
        consumers: [expect.objectContaining({ activation: 'enabled' })] });
      const plan = project.platformDeployment!.plans[0]!;
      expect(plan.effects).toContainEqual(expect.objectContaining({ kind: 'register' }));
      item.claude.nativeCliRunner.mockClear();
      const installedProject = await executeRebuildOperation({ command: 'install', target: project, driver: projectIntegration.driver });
      expect(installedProject.status, JSON.stringify(installedProject)).toBe('succeeded');
      const nativeId = plan.evidence.layout.nativeIdentity.registrationId!;
      expect(item.claude.nativeCliRunner.mock.calls.some(([call]) => call.args.slice(call.args.indexOf('plugin')).join(' ')
        === `plugin install ${nativeId} --scope local`)).toBe(true);
      const records = (await fs.readJson(item.claude.installedPath)).plugins[nativeId] as Array<{ scope: string; projectPath?: string }>;
      expect(records.map((record) => record.scope).sort()).toEqual(['local', 'user']);
      expect(records.find((record) => record.scope === 'local')?.projectPath).toBe(item.claude.projectRoot);
      const skill = path.join(plan.evidence.layout.packageRoot, 'skills/check/SKILL.md');
      const content = await fs.readFile(skill, 'utf8');

      const removeIntegration = await freshIntegration();
      const removeUser = await removeIntegration.buildTarget({ ...input, scope: 'user', command: 'uninstall' });
      await removeIntegration.sealMarketplaceGenerations([removeUser]);
      const removed = await executeRebuildOperation({ command: 'uninstall', target: removeUser, driver: removeIntegration.driver });
      expect(removed.status, JSON.stringify(removed)).toBe('succeeded');
      const userSettings = await fs.readJson(path.join(item.claude.claudeHome, 'settings.json'));
      expect(userSettings.enabledPlugins[nativeId]).toBe(false);
      expect((await fs.readJson(item.claude.installedPath)).plugins[nativeId]).toContainEqual(expect.objectContaining({
        scope: 'local', projectPath: item.claude.projectRoot,
      }));
      expect(await fs.readFile(skill, 'utf8')).toBe(content);
      const currentProject = await getAgentPluginAdapter('claude').inspect({ cwd: input.cwd, env: item.context.env,
        runner: item.context.nativeCliRunner }, plan.binding);
      expect(currentProject).toMatchObject({ package: 'present', ownership: 'aw', registration: 'present', scopeRegistration: 'present',
        consumers: [expect.objectContaining({ activation: 'enabled' })] });
    } finally { await item.context.platformRebuildSession?.dispose(); }
  });

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
  let marketplace: { name: string; root: string } | undefined;
  const calls: string[][] = [];
  const context: RebuildExecutionContext = { env: isolation.env, reporter: createNoopReporter(),
    debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map(), nativeCliRunner: async (request) => {
      const args = [...request.args]; calls.push(args);
      if (args[1] === 'marketplace' && args[2] === 'list') return { exitCode: 0, stderr: '',
        stdout: JSON.stringify(marketplace ? [{ name: marketplace.name, source: 'directory', path: marketplace.root,
          installLocation: marketplace.root }] : []) };
      if (args[1] === 'marketplace' && args[2] === 'add') {
        const root = args[3]!;
        marketplace = { name: (await fs.readJson(path.join(root, 'config.json'))).marketplaceName, root };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
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
      // This orchestration fixture reports explicit scope receipts. Native
      // shared inheritance is checked through inspectDeployment in its own suite.
      const layout = await getDeploymentLayout(ctx, binding);
      const present = await fs.pathExists(layout.packageRoot);
      const scope = platform === 'claude' ? binding.scope.kind === 'project' ? 'local' : 'user' : 'global';
      const active = platform === 'claude' ? enabled.has(scope) : (await readCodexConfigFile(path.join(binding.scope.kind === 'project'
        ? path.join(binding.scope.projectRoot, '.codex') : product.entry!.kind === 'cli' ? product.entry!.configRoot : '', 'config.toml'))).snapshot.plugins[layout.nativeIdentity.registrationId!]?.enabled === true;
      const marker = present && await readSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot) });
      const components = await Promise.all((marker && marker.nativeProjection?.components || []).map(async ({ id, relativeOutputs }) => ({
        id, presence: (await Promise.all(relativeOutputs.map((file) => fs.pathExists(path.join(layout.packageRoot, file))))).every(Boolean)
          ? 'present' as const : 'absent' as const, reasonCodes: [],
      })));
      return { physicalKey: binding.physicalKey, package: present ? 'present' : 'absent', ownership: present ? 'aw' : 'absent',
        registration: installed.has(scope) ? 'present' : 'absent', nativeIdentity: layout.nativeIdentity,
        consumers: binding.consumers.map((consumer) => ({ productId: consumer.id, activationKey: binding.activationKey,
          activation: active ? 'enabled' : 'disabled', load: 'not-observed' })), components,
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
