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
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { createNoopReporter } from '../../src/output/reporter.js';
import { createNoopDebugLogger } from '../../src/output/debug-log.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import type { ProductInstallation } from '../../src/platforms/contracts.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { geminiExtensionPaths, geminiScopePattern } from '../../src/platforms/gemini-activation.js';

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

async function nativeEvidenceFixture(platform: 'gemini' | 'copilot', options: { state?: 'foreign' | 'unknown'; multiple?: boolean } = {}) {
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
    geminiInstallSource?: () => string } = {};
  const inventories = platform === 'gemini' ? ['extensions list'] : ['plugin marketplace list --json', 'plugin list --json'];
  let layout: Awaited<ReturnType<typeof getDeploymentLayout>> | undefined;
  let marketplaceAdded = false;
  let installed = false;
  let clientVersion = platform === 'gemini' ? '0.67.0' : '1.0.95';
  const runner = vi.fn(async (invocation: Parameters<RebuildExecutionContext['nativeCliRunner']>[0]) => {
    const args = invocation.args;
    if (inventories.includes(args.join(' '))) {
      if (options.state === 'unknown' && args[1] === 'marketplace') return { exitCode: 0, stdout: '{}', stderr: '' };
      const rows = args[1] === 'marketplace' ? marketplaceAdded ? [{ name: layout!.marketplaceName, source: layout!.marketplaceRoot }] : []
        : installed ? [{ name: layout!.nativeIdentity.packageId, marketplace: layout!.marketplaceName, source: layout!.marketplaceRoot }] : [];
      return { exitCode: 0, stdout: platform === 'copilot' ? JSON.stringify(rows) : '', stderr: '' };
    }
    await reads.mutation?.();
    if (platform === 'copilot' && args[1] === 'marketplace' && args[2] === 'add') marketplaceAdded = true;
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
    async discover(ctx) {
      await reads.discovery?.();
      const configRoot = resolvePlatformConfigRoot(platform, ctx);
      return { platform, availability: 'available', diagnostics: [], installations: (options.multiple ? [configRoot, `${configRoot}-second`] : [configRoot])
        .map((root, index) => ({ id: `${platform}-evidence-client-${index}`, product: 'cli' as const,
          version: clientVersion, availability: 'available' as const, reasonCodes: [],
          entry: { kind: 'cli' as const, executable, configRoot: root } })) };
    },
    async inspect(ctx, binding) { await reads.inspection?.(); return original.inspect(ctx, binding); },
  };
  if (options.state === 'foreign') {
    const ctx = { cwd: isolated.layout.fixtureCwd, env: isolated.env, runner };
    const resolved = await adapter.resolve(ctx, { plugin: { sourceId: plugin.sourceId!, sourceIdentity: plugin.sourceIdentity!,
      pluginId: plugin.pluginId!, version: plugin.manifest.version }, scope: { kind: 'user' }, operation: 'ensure',
      discovery: await adapter.discover(ctx), recoveryCandidates: [] });
    const foreignLayout = await getDeploymentLayout(ctx, resolved.bindings[0]!);
    await fs.outputFile(path.join(foreignLayout.packageRoot, 'foreign.txt'), 'Keep foreign content.');
  }
  context.platformRebuildSession = new PlatformRebuildSession(context, () => adapter);
  const integration = createRebuildIntegration({ context });
  const input = { plugin, platform, scope: 'user' as const, cwd: isolated.layout.fixtureCwd,
    command: 'install' as const, catalog: { rootDir: root, source: 'local' as const, catalogVersion: '1.0.0', channel: 'latest' as const } };
  const target = await integration.buildTarget(input);
  expect(target.platformDeployment?.plans).toHaveLength(options.multiple ? 2 : 1);
  layout = await getDeploymentLayout({ cwd: input.cwd, env: isolated.env }, target.platformDeployment!.plans[0]!.binding);
  await integration.sealMarketplaceGenerations([target]);
  return { root, context, integration, target, reads, runner, inventories, adapter, input, layout,
    changeRegistration: () => { installed = true; }, changeClient: () => { clientVersion = '1.0.96'; } };
}

describe('native evidence checks', () => {
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
          expect(item.runner).not.toHaveBeenCalled();
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
      expect(item.runner.mock.calls.map(([invocation]) => invocation.args)).toEqual([
        ['extensions', 'uninstall', item.layout.nativeIdentity.packageId],
        ['extensions', 'install', item.layout.packageRoot, '--consent', '--skip-settings'],
      ]);
      const bundle = plan.projections.find((projection) => projection.bundle)!.bundle!;
      expect(recovered.deploymentReceipts?.[0]?.after.nativePackageContentDigest).toBe(bundle.contentDigest);
      const relativeOutput = plan.projections.flatMap((projection) => projection.components)[0]!.relativeOutputs[0]!;
      expect(await fs.readFile(path.join(installed, relativeOutput), 'utf8')).toContain('Revision 3.');
      await retry.target.platformDeployment!.postcheck(recovered.deploymentReceipts!);
    } finally { await item.context.platformRebuildSession!.dispose(); }
  });

  // Test Value Gate: first installs and installed syncs need one fresh execution
  // check, while receipt observation, mutation rebase and postcheck stay fresh.
  it.each(['gemini', 'copilot'] as const)('checks fresh %s evidence once before first install and installed sync', async (platform) => {
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
      await item.target.platformDeployment!.postcheck(installed.deploymentReceipts!);
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
      await target.platformDeployment!.postcheck(synced.deploymentReceipts!);
      expect([discovery, inspection]).toEqual([1, 3]);
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

  // Test Value Gate: slow CLI identity and inventory reads may overlap only
  // within one check. Each verification must finish both fresh reads.
  it.each(['gemini', 'copilot'] as const)('overlaps fresh discovery and inspection at each %s verification boundary', async (platform) => {
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
  it.each(['gemini', 'copilot'] as const)('waits for both %s reads and preserves stale and immutable error priority', async (platform) => {
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
