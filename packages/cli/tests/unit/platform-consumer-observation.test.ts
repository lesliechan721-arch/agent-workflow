import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { getPlatformCapabilities, getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { inspectDeployment } from '../../src/platforms/inspection.js';
import type { ReadContext, ScopeRef } from '../../src/platforms/contracts.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createRebuildIntegration, type RebuildExecutionContext } from '../../src/commands/rebuild-integration.js';
import { executeRebuildOperation } from '../../src/commands/rebuild-operations.js';
import { createNoopReporter } from '../../src/output/reporter.js';
import { createNoopDebugLogger } from '../../src/output/debug-log.js';

async function fixture(platform: 'pi' | 'grok', project = false) {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = isolated.layout.fixtureCwd;
  const env: NodeJS.ProcessEnv = { ...isolated.env, GROK_HOME: path.join(cwd, 'grok-home') };
  const ctx: ReadContext = { cwd, env };
  const host = platform === 'pi' ? path.join(env.HOME!, '.pi', 'agent') : env.GROK_HOME!;
  const scope: ScopeRef = project ? { kind: 'project', projectRoot: cwd } : { kind: 'user' };
  const resolved = await resolveDeployments(ctx, { plugin: { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`,
    pluginId: 'team/example', version: '1.0.0' }, operation: 'ensure', scope, recoveryCandidates: [], discovery: {
    platform, availability: 'available', diagnostics: [], installations: [{ id: 'client', product: 'cli', availability: 'available',
      version: platform === 'pi' ? '1.5.0' : '1.0.77', reasonCodes: [], entry: { kind: 'cli', executable: path.join(cwd, platform), configRoot: host } }],
  } });
  const binding = resolved.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const caps = async () => getPlatformCapabilities({ binding, renderUnit: resolved.renderUnits[0]!,
    observation: await inspectDeployment(ctx, binding), profile: getQualifiedPlatformProfile(platform) });
  return { ctx, host, binding, layout, caps };
}

async function consumer(root: string, version = '0.22.0') {
  await fs.outputJson(path.join(root, 'package.json'), { name: '@tintinweb/pi-subagents', version, pi: { extensions: ['./index.ts'] } });
  await fs.outputFile(path.join(root, 'index.ts'), 'export default function () {}');
}

describe('public native consumer observation', () => {
  // Test Value Gate: Pi's persisted relative AW source must remain registered in
  // both scopes and must not change the prepared Agent consumer inputs.
  it.each([false, true])('recognizes Pi relative AW registration with project=%s', async (project) => {
    const item = await fixture('pi', project);
    const before = await inspectDeployment(item.ctx, item.binding);
    await fs.outputJson(path.join(item.layout.packageRoot, 'package.json'), {
      name: item.layout.nativeIdentity.packageId, version: '1.0.0', pi: { skills: ['./skills'] },
    });
    const source = path.relative(path.dirname(item.layout.activationPath), item.layout.packageRoot);
    await fs.outputJson(item.layout.activationPath, { packages: [source] });
    const installed = await inspectDeployment(item.ctx, item.binding);
    expect(installed.registration).toBe('present');
    expect(installed.prerequisites).toEqual(before.prerequisites);
    await fs.outputJson(item.layout.activationPath, { packages: [`npm:${source}`] });
    expect((await inspectDeployment(item.ctx, item.binding)).registration).toBe('absent');
  });

  // Test Value Gate: publishing/registering AW output must not change prepared
  // consumer inputs; real consumer registration and filter changes still do.
  it('keeps Pi consumer inputs stable across AW package publication and registration', async () => {
    const item = await fixture('pi');
    const before = await inspectDeployment(item.ctx, item.binding);
    await fs.outputJson(path.join(item.layout.packageRoot, 'package.json'), { name: item.layout.nativeIdentity.packageId, version: '1.0.0', pi: { skills: ['./skills'] } });
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot] });
    const installed = await inspectDeployment(item.ctx, item.binding);
    expect(installed.registration).toBe('present');
    expect(installed.prerequisites).toEqual(before.prerequisites);
    const root = path.join(item.host, 'npm/node_modules/@tintinweb/pi-subagents');
    await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot, 'npm:@tintinweb/pi-subagents@0.22.0'] });
    const consumerInstalled = await inspectDeployment(item.ctx, item.binding);
    expect(consumerInstalled.prerequisites.agentConsumers.configurationEvidence).not.toBe(installed.prerequisites.agentConsumers.configurationEvidence);
    await fs.outputJson(item.layout.activationPath, { packages: [item.layout.packageRoot, { source: 'npm:@tintinweb/pi-subagents@0.22.0', extensions: [] }] });
    const filtered = await inspectDeployment(item.ctx, item.binding);
    expect(filtered.prerequisites.agentConsumers.candidates[0]?.enabled).toBe('no');
    expect(filtered.prerequisites.agentConsumers.configurationEvidence).not.toBe(consumerInstalled.prerequisites.agentConsumers.configurationEvidence);
  });

  // Test Value Gate: actual config and manifests distinguish absence, filtering,
  // trust and package access without granting unqualified invocation semantics.
  it('reports complete Pi absence and actual installed version/filter/allowlist facts through capabilities', async () => {
    const item = await fixture('pi');
    expect((await inspectDeployment(item.ctx, item.binding)).prerequisites.agentConsumers).toMatchObject({ observation: 'complete', candidates: [] });
    expect((await item.caps()).kinds.agent.reasonCodes).toEqual(['consumer-missing']);
    const root = path.join(item.host, 'npm/node_modules/@tintinweb/pi-subagents');
    await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: [{ source: 'npm:@tintinweb/pi-subagents@0.22.0', extensions: [] }] });
    expect((await item.caps()).kinds.agent.reasonCodes).toEqual(['consumer-disabled']);
    await fs.outputJson(item.layout.activationPath, { packages: ['npm:@tintinweb/pi-subagents@0.22.0'] });
    await fs.outputJson(path.join(item.layout.packageRoot, 'package.json'), { name: '@team/example' });
    await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: ['different-package'] });
    const denied = await inspectDeployment(item.ctx, item.binding);
    expect(denied.prerequisites.agentConsumers.candidates[0]).toMatchObject({ id: '@tintinweb/pi-subagents', version: '0.22.0',
      enabled: 'yes', trust: 'trusted', packageAccess: 'denied', settings: { promptMode: 'unknown', loadExtensions: 'unknown' } });
    expect((await item.caps()).kinds.agent.reasonCodes).toEqual(['policy-blocked']);
    await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: ['example'] });
    const allowed = await item.caps();
    expect(allowed.consumers[0]?.agentConsumers?.[0]).toMatchObject({ scope: 'user', packageAccess: 'allowed', trust: 'trusted',
      settings: { promptMode: 'unknown', loadExtensions: 'unknown' } });
    expect(allowed.kinds.agent.status).toBe('unverified');
    await consumer(root, '99.0.0');
    expect((await inspectDeployment(item.ctx, item.binding)).prerequisites.agentConsumers.candidates[0]).toMatchObject({ version: '99.0.0', packageAccess: 'unknown' });
  });

  it('observes project trust independently and does not fabricate a consumer from a source string', async () => {
    const item = await fixture('pi', true);
    const root = path.join(item.ctx.cwd, 'consumer'); await consumer(root);
    await fs.outputJson(item.layout.activationPath, { packages: ['../consumer'] });
    const untrusted = await inspectDeployment(item.ctx, item.binding);
    expect(untrusted.prerequisites.agentConsumers.candidates[0]).toMatchObject({ scope: item.binding.scope, enabled: 'yes', trust: 'required' });
    await fs.outputJson(path.join(item.host, 'trust.json'), { [item.ctx.cwd]: true });
    const trusted = await inspectDeployment(item.ctx, item.binding);
    expect(trusted.prerequisites.agentConsumers.candidates[0]?.trust).toBe('trusted');
    expect(trusted.prerequisites.agentConsumers.configurationEvidence).not.toBe(untrusted.prerequisites.agentConsumers.configurationEvidence);
    await fs.outputJson(item.layout.activationPath, { packages: ['git:https://token@example.invalid/pi-subagents'] });
    const unknown = await inspectDeployment(item.ctx, item.binding);
    expect(unknown.prerequisites.agentConsumers).toMatchObject({ observation: 'unknown', candidates: [] });
    expect(JSON.stringify(unknown)).not.toContain('token');
  });

  // Test Value Gate: the actual 1.0.77 report keeps inspect.enabled true after
  // disable. Configuration and effective component sources must remain separate.
  it('keeps Grok registration, disable, load and Claude overlap independent', async () => {
    const item = await fixture('grok');
    const name = item.layout.nativeIdentity.packageId;
    const installed = path.join(item.host, 'installed-plugins', 'local-123');
    const compatible = path.join(item.ctx.env!.HOME!, '.claude', 'plugins', 'cache', name);
    await fs.outputJson(path.join(compatible, '.claude-plugin/plugin.json'), { name, version: '2.0.0' });
    const extraNative = path.join(item.ctx.cwd, 'extra-native');
    await fs.outputJson(path.join(extraNative, '.grok-plugin/plugin.json'), { name: 'extra-native', version: '3.0.0' });
    const config = path.join(item.host, 'config.toml');
    await fs.outputFile(config, `[plugins]\nenabled=[]\ndisabled=["${name}"]\n`);
    let active = false;
    const list = [{ status: 'installed', name, repo_key: 'local-123', version: '1.0.0', path: installed, source: item.layout.packageRoot }];
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin' ? list : {
      grokVersion: '1.0.77', projectTrusted: false, configSources: { layers: [{ role: 'user', path: config }] },
      plugins: [{ name, scope: 'user', path: installed, enabled: true }, { name, scope: 'user', path: compatible, enabled: true },
        { name: 'extra-native', scope: 'user', path: extraNative, enabled: true },
        { name: 'unknown-extra', scope: 'user', path: path.join(item.ctx.cwd, 'unknown-extra'), enabled: true }],
      skills: [{ name: 'compat-skill', source: { type: 'plugin', plugin_name: name, path: path.join(compatible, 'skills/x/SKILL.md') } },
        ...(active ? [{ name: 'native-skill', source: { type: 'plugin', plugin_name: name, path: path.join(installed, 'skills/y/SKILL.md') } }] : [])],
      agents: [], mcpServers: [], hooks: [{ source: { path: installed } }],
    }) });
    const disabled = await inspectDeployment(item.ctx, item.binding);
    expect(disabled.registration).toBe('present');
    expect(disabled.ownership).toBe('absent');
    expect(disabled.consumers[0]).toMatchObject({ activation: 'disabled', trust: 'unknown', load: 'not-observed' });
    expect(disabled.prerequisites.nativeSources).toMatchObject({ overlaps: [name], sources: [
      { version: '1.0.0', origin: 'native', effectiveComponents: [] },
      { version: '2.0.0', origin: 'compatibility', effectiveComponents: ['skills:compat-skill'] },
      { version: '3.0.0', origin: 'native', effectiveComponents: [] },
      { version: null, origin: 'unknown', effectiveComponents: [] },
    ] });
    active = true; await fs.outputFile(config, `[plugins]\nenabled=["${name}"]\ndisabled=[]\n`);
    const enabled = await inspectDeployment(item.ctx, item.binding);
    expect(enabled.consumers[0]).toMatchObject({ activation: 'enabled', trust: 'trusted', load: 'observed' });
    expect(enabled.ownership).toBe('absent');
    expect(enabled.prerequisites.nativeSources?.configurationEvidence).not.toBe(disabled.prerequisites.nativeSources?.configurationEvidence);
  });

  it('keeps a discovered but untrusted Grok project package distinct from registration', async () => {
    const item = await fixture('grok', true);
    await fs.ensureDir(item.layout.packageRoot);
    const config = path.join(item.host, 'config.toml'); await fs.outputFile(config, '[plugins]\nenabled=[]');
    item.ctx.runner = async ({ args }) => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(args[0] === 'plugin' ? [] : {
      grokVersion: '1.0.77', projectTrusted: false, configSources: { layers: [{ role: 'user', path: config }] },
      plugins: [{ name: item.layout.nativeIdentity.packageId, scope: 'project', path: item.layout.packageRoot, enabled: false }], skills: [], agents: [], mcpServers: [],
    }) });
    const observation = await inspectDeployment(item.ctx, item.binding);
    expect(observation).toMatchObject({ registration: 'not-applicable', package: 'present', ownership: 'foreign' });
    expect(observation.consumers[0]).toMatchObject({ activation: 'unknown', trust: 'required', load: 'not-observed' });
  });

  // Test Value Gate: consumer settings changed after preparation must invalidate
  // the real rebuild execution before it can mutate any native package.
  it('rejects a prepared Pi operation when actual consumer settings change', async () => {
    const item = await fixture('pi');
    const bin = path.join(item.ctx.cwd, 'bin'); await fs.outputFile(path.join(bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...item.ctx.env, PATH: bin };
    const root = path.join(item.ctx.cwd, 'empty-pi');
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Empty Pi package.',
      platforms: ['pi'], marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } });
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    Object.assign(plugin, { sourceId: 'team', pluginId: 'team/example', sourceIdentity: item.binding.plugin.sourceIdentity });
    const context: RebuildExecutionContext = { env, nativeCliRunner: async ({ args }) => ({ exitCode: 0, stdout: args.includes('--help') ? 'Pi coding agent' : '1.5.0', stderr: '' }),
      reporter: createNoopReporter(), debugLogger: createNoopDebugLogger(), preparedArtifactRenderResults: new Map() };
    const integration = createRebuildIntegration({ context });
    try {
      const target = await integration.buildTarget({ plugin, platform: 'pi', scope: 'user', cwd: item.ctx.cwd, command: 'sync',
        catalog: { rootDir: root, source: 'local', catalogVersion: '1.0.0' } });
      expect(target.platformDeployment?.plans).toHaveLength(1);
      await fs.outputJson(path.join(item.host, 'subagents.json'), { packageAgents: false });
      const result = await executeRebuildOperation({ command: 'sync', target, driver: integration.driver });
      expect(result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining('operationPlanStale') } });
      expect(await fs.pathExists(item.layout.packageRoot)).toBe(false);
    } finally { await context.platformRebuildSession?.dispose(); }
  });
});
