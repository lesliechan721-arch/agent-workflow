import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { addRoot, removeRoot } from '../../src/intent/intent-store.js';
import { writePreferences } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSnapshotLogicalIdentity } from '../../src/utils/catalog-generation-store.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getQualifiedPlatformProfile, getPlatformCapabilities } from '../../src/platforms/capabilities.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { readDemand } from '../../src/recovery/demand.js';
import { createPlatformEmptyState, createPlatformInputEvidence, platformPackageInputDigest, readPlatformPackageContentDigest, writePlatformEmptyState } from '../../src/utils/platform-empty-state.js';
import { resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { NativeCliError, type NativeCliRunner } from '../../src/utils/native-cli.js';
import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import * as platformCapabilities from '../../src/platforms/capabilities.js';
import { isolateCodexAppDiscoveryQueries } from '../helpers/native-execution-fixture.js';
import { configReadResponse } from '../helpers/codex-config-observation-fixture.js';

afterEach(() => vi.restoreAllMocks());

const nativeProfiles = [
  ['codex', 'codex', 'codex-cli 0.167.0'], ['claude', 'claude', '2.1.317 (Claude Code)'],
  ['cursor', 'cursor-agent', 'Cursor Agent 2026.11.05-86047df'], ['antigravity', 'agy', 'Antigravity 1.3.4'],
  ['opencode', 'opencode', 'opencode 2.2.6'], ['pi', 'pi', 'pi coding agent 1.5.0'],
  ['gemini', 'gemini', 'Gemini CLI 0.67.0'], ['copilot', 'copilot', 'GitHub Copilot 1.0.95'],
  ['grok', 'grok', 'Grok 1.0.77'],
] as const;

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string) {
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return;
    const relative = path.relative(root, current) || '.';
    if (stat.isSymbolicLink()) result[relative] = `link:${await fs.readlink(current)}`;
    else if (stat.isDirectory()) {
      result[relative] = 'directory';
      for (const entry of (await fs.readdir(current)).sort()) await visit(path.join(current, entry));
    } else result[relative] = (await fs.readFile(current)).toString('base64');
  }
  await visit(root);
  return result;
}
async function client(platform: PlatformTarget, env: NodeJS.ProcessEnv, version?: string) {
  const isolation = getCurrentSourceTestIsolation();
  const profile = nativeProfiles.find(([id]) => id === platform)!;
  const binRoot = path.join(isolation.layout.fixtureCwd, 'bin');
  if (platform === 'codex') {
    const packageRoot = process.platform === 'win32' ? path.join(binRoot, 'node_modules/@openai/codex')
      : path.join(isolation.layout.fixtureCwd, 'lib/node_modules/@openai/codex');
    await fs.outputJson(path.join(packageRoot, 'package.json'), { name: '@openai/codex', version: version?.match(/\d+\.\d+\.\d+/u)?.[0] ?? '0.167.0', bin: { codex: 'bin/codex.js' } });
    const launcher = path.join(packageRoot, 'bin/codex.js');
    await fs.outputFile(launcher, '#!/usr/bin/env node\nthrow new Error("The fixture executable must never run");\n', { mode: 0o755 });
    await fs.ensureDir(binRoot);
    if (process.platform === 'win32') await fs.outputFile(path.join(binRoot, 'codex.cmd'), '@echo off\r\n');
    else await fs.symlink(launcher, path.join(binRoot, 'codex'));
  } else await fs.outputFile(path.join(binRoot, profile[1]), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  env.PATH = binRoot;
  const runner = vi.fn<NativeCliRunner>(async (invocation) => ({ exitCode: 0, stderr: '',
    stdout: invocation.args.includes('--version') ? version ?? profile[2]
      : invocation.args.includes('--help') && platform === 'grok' ? 'plugin install list enable disable uninstall update --json' : platform === 'codex' ? JSON.stringify({ installed: [], available: [] }) : '[]' }));
  return runner;
}
async function fixture(platform: PlatformTarget = 'opencode', options: { dynamic?: boolean; mixed?: boolean; version?: string; empty?: boolean; scope?: 'user' | 'project'; available?: boolean } = {}) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'project');
  const source = path.join(isolation.layout.fixtureCwd, 'catalog');
  const env: NodeJS.ProcessEnv = { ...isolation.env, PATH: '' };
  const scope = options.scope ?? 'user';
  await fs.ensureDir(path.join(cwd, '.git'));
  const sentinel = path.join(isolation.layout.fixtureCwd, 'renderer-ran');
  if (!options.empty && !options.dynamic) await fs.outputFile(path.join(source, 'plugins/demo/skills/example/SKILL.md'),
    '---\nname: example\ndescription: Example.\n---\nExample.\n');
  if (options.dynamic) await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'),
    `import fs from 'node:fs';fs.writeFileSync(process.env.AW_RENDER_SENTINEL,'ran');console.log(JSON.stringify({version:3,components:[],omitted:[],unmet:[]}));\n`);
  await createCatalogSnapshotFixture(source, 'demo', [], 'Demo', (manifest) => {
    manifest.platforms = [platform];
    if (options.mixed) manifest.extensions = { instructions: [{ name: 'context', title: 'Context', content: 'Use this context.', coverage: ['main'] }] };
    if (!options.empty && !options.dynamic) manifest.skills = './skills';
    if (options.dynamic) {
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    }
  });
  const configuredSource = { id: 'local', type: 'path' as const, primary: true, path: source };
  await replaceCatalogSourcesConfig({ env, expectedDigest: (await readCatalogSourcesConfigSnapshot(env)).digest,
    config: { schemaVersion: 2, sources: [configuredSource] } });
  await syncCatalogSourceGeneration({ sourceId: 'local', env, cliVersion: '1.0.0' });
  const logicalIdentity = await readCatalogSnapshotLogicalIdentity(source);
  const sourceIdentity = await calculateCatalogSourceIdentity(configuredSource);
  await addRoot({ cwd, env, scope }, 'local/demo', logicalIdentity);
  await writePreferences({ scope: 'user', cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [platform], exclusions: [] });
  env.AW_RENDER_SENTINEL = sentinel;
  const runner = options.available && platform !== 'generic' ? await client(platform, env, options.version) : vi.fn<NativeCliRunner>(async () => { throw new Error('Unexpected native invocation'); });
  return { isolation, cwd, source, env, scope, sentinel, sourceIdentity, logicalIdentity, runner,
    read: () => readRecoveryStatus({ context: scope, cwd, env, cliVersion: '1.0.0', nativeCliRunner: runner }) };
}
async function placement(value: Awaited<ReturnType<typeof fixture>>, platform: PlatformTarget = 'opencode') {
  const adapter = getAgentPluginAdapter(platform);
  const ctx = { cwd: value.cwd, env: value.env, runner: value.runner };
  const resolved = await adapter.resolve(ctx, { plugin: { sourceId: 'local', sourceIdentity: value.sourceIdentity,
    pluginId: 'local/demo', version: '1.0.0' }, scope: value.scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: value.cwd },
    operation: 'ensure', discovery: await adapter.discover(ctx), recoveryCandidates: [] });
  expect(resolved.bindings.length).toBeGreaterThan(0);
  const binding = resolved.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  return { binding, layout, renderUnits: resolved.renderUnits, component: deploymentPackageComponent(binding, layout) };
}
function target(status: Awaited<ReturnType<typeof readRecoveryStatus>>) {
  const result = status.inventory?.find((entry) => entry.pluginId === 'local/demo')?.targetResults[0];
  expect(result, JSON.stringify(status)).toBeDefined();
  return result!;
}
function qualifySkill(platform: PlatformTarget) {
  vi.spyOn(getAgentPluginAdapter(platform), 'capabilities').mockImplementation((input) => {
    const capabilities = getPlatformCapabilities(input);
    capabilities.kinds.skill = { ...capabilities.kinds.skill, status: 'supported', reasonCodes: [] };
    return capabilities;
  });
}

async function materializeCodexSkill(value: Awaited<ReturnType<typeof fixture>>) {
  const { binding, layout, renderUnits, component } = await placement(value, 'codex');
  if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
  const id = layout.nativeIdentity.registrationId!;
  const probe = value.runner.getMockImplementation()!;
  value.runner.mockImplementation(async (invocation) => invocation.args.includes('list')
    ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ installed: [{ pluginId: id, installed: true,
      enabled: value.scope === 'user' || invocation.cwd === value.cwd, version: '1.0.0' }], available: [] }) }
    : probe(invocation));
  await fs.outputFile(path.join(value.env.CODEX_HOME!, 'config.toml'),
    `[marketplaces.${JSON.stringify(layout.marketplaceName!)}]\nsource_type = "local"\nsource = ${JSON.stringify(layout.marketplaceRoot!)}\n`);
  if (value.scope === 'project') await fs.outputFile(path.join(value.cwd, '.codex/config.toml'),
    `[plugins.${JSON.stringify(id)}]\nenabled = true\n`);
  await fs.outputJson(path.join(layout.packageRoot, '.codex-plugin/plugin.json'), { name: layout.nativeIdentity.packageId, version: '1.0.0' });
  const skill = path.join(layout.packageRoot, 'skills/example/SKILL.md');
  await fs.outputFile(skill, '---\nname: example\ndescription: Example.\n---\nExample.\n');
  const adapter = getAgentPluginAdapter('codex');
  const ctx = { cwd: value.cwd, env: value.env, runner: value.runner };
  const demand = await readDemand({ scope: value.scope, cwd: value.cwd, env: value.env });
  const plugin = demand.roots![0]!.plugin!;
  const observation = await adapter.inspect(ctx, binding);
  const input = await createPlatformInputEvidence({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
    renderUnit, prerequisites: observation.prerequisites,
    capabilities: adapter.capabilities({ binding, renderUnit, observation, profile: getQualifiedPlatformProfile('codex') }),
    config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
      sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'codex',
      scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
  }))) });
  await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
    nativeProjection: { physicalIdentity: layout.physicalIdentity, preparation: 'complete',
      components: [{ id: 'skill:example', nativeName: 'example', relativeOutputs: ['skills/example/SKILL.md'] }],
      inputDigest: platformPackageInputDigest(input), contentDigest: (await readPlatformPackageContentDigest(layout.packageRoot))! } });
  return { binding, layout, skill };
}

describe('public status through platform adapters', () => {
  // Test Value Gate: a current AW source is insufficient when Grok still has
  // an old or unreadable installation; only matching native bytes are current.
  it.each(['current', 'old', 'missing'] as const)('checks Grok native copy bytes with a %s installation', async (state) => {
    const value = await fixture('grok', { available: true });
    qualifySkill('grok');
    const { binding, layout, renderUnits, component } = await placement(value, 'grok');
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    const entry = binding.consumers[0]!.entry;
    if (entry?.kind !== 'cli') throw new Error('Expected CLI entry.');
    const name = layout.nativeIdentity.packageId;
    const nativeRoot = path.join(entry.configRoot, 'installed-plugins', 'native-demo');
    const config = path.join(entry.configRoot, 'config.toml');
    const skill = 'skills/example/SKILL.md';
    await fs.outputJson(path.join(layout.packageRoot, '.grok-plugin/plugin.json'), { name, version: '1.0.0' });
    await fs.outputFile(path.join(layout.packageRoot, skill), '---\nname: example\ndescription: Example.\n---\nLatest.\n');
    await fs.copy(layout.packageRoot, nativeRoot);
    await fs.outputFile(config, `[plugins]\nenabled=[${JSON.stringify(name)}]\n`);
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => invocation.args[0] === 'inspect'
      ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ grokVersion: '1.0.77', cwd: invocation.cwd,
        projectRoot: invocation.cwd, projectTrusted: true, configSources: { layers: [{ role: 'user', path: config }] },
        plugins: [{ name, scope: 'user', path: nativeRoot, enabled: true }],
        skills: [{ name: 'example', source: { type: 'plugin', plugin_name: name, path: path.join(nativeRoot, skill) } }],
        agents: [], mcpServers: [], hooks: [] }) }
      : invocation.args[0] === 'plugin' && invocation.args.includes('list') && invocation.args.includes('--json')
        ? { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name, status: 'installed', repo_key: 'native-demo',
          version: '1.0.0', path: nativeRoot, source: layout.packageRoot }]) } : probe(invocation));
    const contentDigest = (await readPlatformPackageContentDigest(layout.packageRoot))!;
    const projection = { physicalIdentity: layout.physicalIdentity, preparation: 'complete' as const,
      components: [{ id: 'skill:example', nativeName: 'example', relativeOutputs: [skill] }],
      inputDigest: `sha256:${'0'.repeat(64)}`, contentDigest };
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: projection });
    const adapter = getAgentPluginAdapter('grok');
    const observation = await adapter.inspect({ cwd: value.cwd, env: value.env, runner: value.runner }, binding);
    const demand = await readDemand({ scope: value.scope, cwd: value.cwd, env: value.env });
    const plugin = demand.roots![0]!.plugin!;
    const input = await createPlatformInputEvidence({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit, prerequisites: observation.prerequisites,
      capabilities: adapter.capabilities({ binding, renderUnit, observation, profile: getQualifiedPlatformProfile('grok') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
        sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'grok',
        scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
    }))) });
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: { ...projection, inputDigest: platformPackageInputDigest(input) } });
    if (state === 'old') await fs.outputFile(path.join(nativeRoot, skill), 'Old installed content.\n');
    if (state === 'missing') await fs.remove(nativeRoot);
    const result = target(await value.read());
    expect(result.content).toBe(state === 'current' ? 'satisfied' : state === 'old' ? 'drifted' : 'unknown');
    if (state !== 'current') expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: state === 'old' ? 'nativePackageContentDrift' : 'nativePackageContentUnconfirmed' }),
    ]));
  });

  // Test Value Gate: the public flag must affect only project trust and preserve package, activation, and ownership checks.
  it.each([
    { mode: 'ordinary', enabled: false, trust: 'trusted' as const, expected: 'unknown', exit: 3 },
    { mode: 'trusted', enabled: true, trust: 'trusted' as const, expected: 'satisfied', exit: 0 },
    { mode: 'denied', enabled: true, trust: 'untrusted' as const, expected: 'drifted', exit: 3 },
    { mode: 'parent-only', enabled: true, trust: 'trusted' as const, expected: 'unknown', exit: 3 },
  ])('projects $mode native trust through the real CLI status path', async ({ mode, enabled, trust, expected, exit }) => {
    vi.spyOn(platformCapabilities, 'getQualifiedPlatformProfile').mockReturnValue(
      getQualifiedPlatformProfile('codex', { platform: 'darwin', arch: 'arm64' }));
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true, scope: 'project' });
    await materializeCodexSkill(value);
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => {
      if (!invocation.args.includes('app-server')) return probe(invocation);
      const cwd = invocation.cwd!;
      const initialized = `${JSON.stringify({ id: 1, result: { userAgent: 'aw/0.167.0' } })}\n`;
      const response = `${JSON.stringify({ id: 2, result: configReadResponse(cwd, value.env.CODEX_HOME!, trust,
        mode === 'parent-only' ? path.dirname(cwd) : cwd) })}\n`;
      invocation.input!.onStdout(initialized);
      invocation.input!.onStdout(response);
      return { exitCode: 0, stdout: initialized + response, stderr: '' };
    });
    const before = await snapshot(value.isolation.layout.rootDir);
    const captured = createCapturedCliIo();
    const code = await runCli(['plugin', 'status', 'local/demo', '--context', 'project', ...(enabled ? ['--observe-native'] : []), '--json'], {
      cwd: value.cwd, env: value.env, io: captured.io, nativeCliRunner: value.runner,
    });
    const result = JSON.parse(captured.readStdout());
    expect(code, JSON.stringify(result)).toBe(exit);
    const observed = result.data.inventory[0].targetResults[0];
    expect(observed.content).toBe(expected);
    expect(observed.deploymentObservations[0].after.consumers[0]).toMatchObject({
      activation: 'enabled', trust: mode === 'trusted' ? 'trusted' : mode === 'denied' ? 'blocked' : 'unknown', load: 'unknown',
    });
    expect(value.runner.mock.calls.filter(([invocation]) => invocation.args.includes('app-server'))).toHaveLength(enabled ? 1 : 0);
    expect(result.diagnostics.some((entry: { code: string }) => entry.code === 'nativeObservationSideEffects')).toBe(enabled);
    expect(result.diagnostics.some((entry: { code: string }) => entry.code === 'nativeTrustRequired')).toBe(mode === 'denied');
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  // Test Value Gate: qualified static user Skills need no independent Hook/project trust;
  // status must verify materialization without claiming a host session loaded it or writing state.
  it('confirms qualified static Codex user Skills without claiming project trust or host load', async () => {
    const profile = getQualifiedPlatformProfile('codex', { platform: 'darwin', arch: 'arm64' });
    vi.spyOn(platformCapabilities, 'getQualifiedPlatformProfile').mockReturnValue(profile);
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true });
    await materializeCodexSkill(value);
    const before = await snapshot(value.isolation.layout.rootDir);
    const captured = createCapturedCliIo();
    const exit = await runCli(['plugin', 'status', 'local/demo', '--context', 'user', '--json'], {
      cwd: value.cwd, env: value.env, io: captured.io, nativeCliRunner: value.runner,
    });
    const result = JSON.parse(captured.readStdout());
    expect(exit, JSON.stringify(result)).toBe(0);
    expect(result).toMatchObject({ status: 'success', diagnostics: [], data: { allSatisfied: true,
      counts: { blocked: 0, unconfirmed: 0, ready: 1 }, inventory: [{ targetResults: [{ content: 'satisfied', observation: 'verified',
        deploymentObservations: [{ after: { consumers: [{ trust: 'not-applicable', load: 'unknown' }] } }] }] }] } });
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  // Test Value Gate: a component-specific trust applicability fact must not hide
  // project trust, incomplete expectations, stale bytes, rejected trust, or another consumer.
  it.each([
    { name: 'project scope', scope: 'project' as const },
    { name: 'dynamic expectations', dynamic: true },
    { name: 'mixed components', mixed: true },
    { name: 'another client version', version: 'codex-cli 0.168.0' },
    { name: 'no exact qualification', unqualified: true },
    { name: 'content drift', drift: true },
    { name: 'failed native observation', unreadable: true },
    { name: 'an additional App consumer', app: true },
    { name: 'blocked trust', blocked: true },
  ])('keeps Codex trust evidence conservative for $name', async (options) => {
    const profile = getQualifiedPlatformProfile('codex', { platform: 'darwin', arch: 'arm64' });
    if ('unqualified' in options) delete profile.qualifiedConsumers;
    vi.spyOn(platformCapabilities, 'getQualifiedPlatformProfile').mockReturnValue(profile);
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true, ...options });
    const adapter = getAgentPluginAdapter('codex');
    if ('app' in options) {
      const discover = adapter.discover;
      vi.spyOn(adapter, 'discover').mockImplementation(async (ctx) => {
        const result = await discover(ctx);
        const cli = result.installations[0]!;
        return { ...result, installations: [...result.installations, { ...cli, id: `${cli.id}:app`, product: 'app' }] };
      });
    }
    const { skill } = await materializeCodexSkill(value);
    if ('drift' in options) await fs.appendFile(skill, 'Changed bytes.\n');
    if ('unreadable' in options) {
      const probe = value.runner.getMockImplementation()!;
      value.runner.mockImplementation(async (invocation) => invocation.args.includes('list')
        ? { exitCode: 1, stdout: '', stderr: 'Controlled unavailable observation.' } : probe(invocation));
    }
    if ('blocked' in options) {
      const inspect = adapter.inspect;
      vi.spyOn(adapter, 'inspect').mockImplementation(async (ctx, binding) => {
        const observation = await inspect(ctx, binding);
        for (const consumer of observation.consumers) consumer.trust = 'blocked';
        return observation;
      });
    }
    const before = await snapshot(value.isolation.layout.rootDir);
    if ('scope' in options) {
      const captured = createCapturedCliIo();
      expect(await runCli(['plugin', 'status', 'local/demo', '--context', 'project', '--json'], {
        cwd: value.cwd, env: value.env, io: captured.io, nativeCliRunner: value.runner,
      })).toBe(3);
      const result = JSON.parse(captured.readStdout());
      expect(result).toMatchObject({ status: 'blocked', diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'nativeTrustUnconfirmed', severity: 'warning', subject: { pluginId: 'local/demo', target: 'codex', scope: 'project' } }),
      ]), data: { allSatisfied: null, counts: { blocked: 0, unconfirmed: 1, ready: 0 } } });
      const observed = result.data.inventory[0].targetResults[0];
      expect(observed).toMatchObject({ content: 'unknown', satisfaction: 'unknown', deploymentObservations: [{
        after: { consumers: [{ activation: 'enabled', trust: 'unknown', load: 'unknown' }] },
      }] });
    } else {
      const status = await value.read();
      expect(status.allSatisfied).not.toBe(true);
      expect(target(status).content).not.toBe('satisfied');
      const observations = target(status).deploymentObservations!;
      expect(observations.length).toBeGreaterThan(0);
      expect(observations.flatMap((entry) => entry.after.consumers).every((consumer) => consumer.trust !== 'not-applicable')).toBe(true);
    }
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  // Test Value Gate: status must keep all platform choices and truthful unknowns without writing or rendering.
  it.each(PLATFORM_TARGETS)('keeps %s demand visible with no local client and preserves filesystem bytes', async (platform) => {
    const value = await fixture(platform);
    const before = await snapshot(value.isolation.layout.rootDir);
    const status = await value.read();
    expect(status.selection.agents).toEqual([platform]);
    expect(target(status)).toMatchObject({ agent: platform, scope: 'user', execution: 'not-run' });
    if (platform !== 'generic') {
      expect(target(status).observation).toBe('unknown');
      expect(target(status).blockers.length).toBeGreaterThan(0);
      expect(status.allSatisfied).not.toBe(true);
    }
    expect(value.runner).not.toHaveBeenCalled();
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  it.each(nativeProfiles)('preserves actual %s CLI product facts without claiming host load', async (platform, _executable, version) => {
    const value = await fixture(platform, { available: true });
    const status = await value.read();
    const deployments = target(status).deploymentObservations;
    expect(deployments, JSON.stringify(status)).toEqual(expect.arrayContaining([expect.objectContaining({
      products: expect.arrayContaining([expect.objectContaining({ product: 'cli', availability: 'available', version: expect.any(String) })]),
      after: expect.objectContaining({ package: 'absent' }),
    })]));
    expect(deployments!.flatMap((entry) => entry.products).filter((product) => product.product === 'cli')
      .every((product) => version.includes(product.version!))).toBe(true);
    expect(deployments!.flatMap((entry) => entry.after.consumers).every((consumer) => consumer.load !== 'observed')).toBe(true);
    expect(target(status).observation).not.toBe('verified');
  });

  it('reports an unsupported Codex version as a product fact rather than a usable package', async () => {
    const value = await fixture('codex');
    value.runner = await client('codex', value.env, 'codex-cli 0.150.0');
    const status = await readRecoveryStatus({ context: 'user', cwd: value.cwd, env: value.env, nativeCliRunner: value.runner });
    expect(target(status).blockers.map((item) => item.code)).toContain('clientVersionUnsupported');
    expect(status.allSatisfied).not.toBe(true);
  });

  it('keeps native Skill absence distinct from an intentional static empty collection', async () => {
    qualifySkill('opencode');
    const value = await fixture('opencode', { available: true });
    const status = await value.read();
    expect(target(status), JSON.stringify(status)).toMatchObject({ content: 'absent', observation: 'missing' });
  });

  it('accepts a complete static empty Native collection without materializing a package', async () => {
    const value = await fixture('opencode', { available: true, empty: true });
    const before = await snapshot(value.isolation.layout.rootDir);
    expect(target(await value.read())).toMatchObject({ content: 'satisfied', observation: 'verified' });
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  it('keeps the full dynamic expectation unknown without running the renderer', async () => {
    const value = await fixture('opencode', { available: true, dynamic: true });
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: 'unknown', observation: 'unknown', blockers: expect.arrayContaining([
      expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
    ]) });
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  // A prior complete empty result is reusable only for exactly matching frozen inputs.
  it('recognizes complete dynamic empty evidence and invalidates it after source changes without rendering', async () => {
    const value = await fixture('opencode', { available: true, dynamic: true });
    const { binding, renderUnits } = await placement(value);
    const adapter = getAgentPluginAdapter('opencode');
    const demand = await readDemand({ scope: 'user', cwd: value.cwd, env: value.env });
    const plugin = demand.roots![0]!.plugin!;
    const observation = await adapter.inspect({ cwd: value.cwd, env: value.env, runner: value.runner }, binding);
    const state = await createPlatformEmptyState({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit, prerequisites: observation.prerequisites,
      capabilities: adapter.capabilities({ binding, renderUnit, observation, profile: getQualifiedPlatformProfile('opencode') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
        sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'opencode',
        scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
    }))) });
    await writePlatformEmptyState({ state, env: value.env });
    const before = await snapshot(value.isolation.layout.rootDir);
    expect(target(await value.read())).toMatchObject({ content: 'satisfied', observation: 'verified' });
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
    await fs.appendFile(path.join(value.source, 'plugins/demo/render.mjs'), '// changed input\n');
    await createCatalogSnapshotFixture(value.source, 'demo', [], 'Demo', (manifest) => {
      manifest.platforms = ['opencode']; manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    expect(target(await value.read())).toMatchObject({ content: 'unknown', observation: 'unknown', blockers: expect.arrayContaining([
      expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
    ]) });
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  it('does not interpret a foreign Native package as installed or remove its files', async () => {
    qualifySkill('opencode');
    const value = await fixture('opencode', { available: true });
    const { layout } = await placement(value);
    await fs.outputFile(path.join(layout.packageRoot, 'foreign.txt'), 'foreign bytes');
    const before = await snapshot(layout.packageRoot);
    const status = await value.read();
    expect(target(status).content).toBe('conflict');
    expect(target(status).deploymentObservations?.[0]?.after.ownership).toBe('foreign');
    expect(await snapshot(layout.packageRoot)).toEqual(before);
  });

  it('keeps owned Native materialization separate from unknown host activation and load', async () => {
    qualifySkill('opencode');
    const value = await fixture('opencode', { available: true });
    const { layout, component } = await placement(value);
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    await fs.outputFile(path.join(layout.packageRoot, 'index.ts'), 'export default {};');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const before = await snapshot(layout.packageRoot);
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: 'unknown', observation: 'unknown' });
    expect(target(status).deploymentObservations?.[0]?.after).toMatchObject({ package: 'present', ownership: 'aw',
      consumers: [expect.objectContaining({ activation: 'unknown', load: 'not-observed' })] });
    expect(await snapshot(layout.packageRoot)).toEqual(before);
  });

  it('reports a read failure in one JSON response without leaking raw error details', async () => {
    const value = await fixture('opencode', { available: true });
    vi.spyOn(getAgentPluginAdapter('opencode'), 'inspect').mockRejectedValue(new Error('secret-native-state-detail'));
    const captured = createCapturedCliIo();
    const exit = await runCli(['plugin', 'status', '--context', 'user', '--json'], {
      cwd: value.cwd, env: value.env, interactive: false, io: captured.io, nativeCliRunner: value.runner,
    });
    const output = captured.readStdout();
    expect(exit).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ command: 'plugin.status', status: 'blocked',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'nativeObservationFailed' })]) });
    expect(output + captured.readStderr()).not.toContain('secret-native-state-detail');
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  it('keeps user inspection independent of invalid project Intent', async () => {
    const value = await fixture('opencode', { available: true });
    await fs.outputFile(path.join(value.cwd, '.agent-workflows/plugin-intents.json'), '{ invalid');
    const status = await value.read();
    expect(status.intent.state).toBe('valid');
    expect(status.inventory?.map((entry) => entry.pluginId)).toEqual(['local/demo']);
    expect(status.errors.map((entry) => entry.code)).not.toContain('pluginIntentStateInvalid');
    expect(status.coverage.scopes).toEqual(['user']);
  });

  it('preserves separate user and project requirements in project inspection', async () => {
    const value = await fixture('opencode', { available: true });
    await addRoot({ cwd: value.cwd, env: value.env, scope: 'project' }, 'local/demo', value.logicalIdentity);
    const status = await readRecoveryStatus({ context: 'project', cwd: value.cwd, env: value.env, nativeCliRunner: value.runner });
    expect(status.inventory?.flatMap((entry) => entry.targetResults).map((entry) => entry.scope).sort()).toEqual(['project', 'user']);
    expect(status.coverage.scopes).toEqual(['user', 'project']);
  });

  it('keeps invalid Intent structured and does not repair it during inspection', async () => {
    const value = await fixture();
    // Use the authoritative Intent path returned by the store, not an invented state location.
    const { resolveIntentPath } = await import('../../src/intent/intent-store.js');
    const intentPath = await resolveIntentPath({ scope: 'user', cwd: value.cwd, env: value.env });
    await fs.outputFile(intentPath, '{ damaged');
    const status = await value.read();
    expect(status.intent.state).toBe('invalid');
    expect(status.allSatisfied).not.toBe(true);
    expect(await fs.readFile(intentPath, 'utf8')).toBe('{ damaged');
  });

  it('does not invent a project or create missing state paths outside a repository', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'outside');
    await fs.ensureDir(cwd);
    const before = await snapshot(isolation.layout.rootDir);
    const status = await readRecoveryStatus({ context: 'user', cwd, env: { ...isolation.env, PATH: '' } });
    expect(status.coverage.scopes).toEqual(['user']);
    expect(status.coverage.projectRoot).toBeUndefined();
    expect(await snapshot(isolation.layout.rootDir)).toEqual(before);
  });

  it('does not treat private Codex cache or configuration alone as owned residue', async () => {
    const value = await fixture('codex');
    await removeRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, 'local/demo');
    await fs.outputJson(path.join(value.env.CODEX_HOME!, 'plugins/cache/aw-local/demo/1.0.0/plugin.json'), { name: 'demo', version: '1.0.0' });
    const before = await snapshot(value.isolation.layout.rootDir);
    const status = await value.read();
    expect(status.inventory).toEqual([]);
    expect(status.extraObserved).toEqual([]);
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });
});

describe('status safety and recovery evidence', () => {
  // Test Value Gate: cancellation must preserve the process cleanup error and release temporary scope directories.
  it.each(['version', 'list'] as const)('cancels an in-flight Native %s read and removes neutral temporary directories', async (stage) => {
    const value = await fixture('codex', { available: true });
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const observedCwds = new Set<string>();
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.cwd) observedCwds.add(invocation.cwd);
      if (stage === 'list' && invocation.args.includes('--version')) return { exitCode: 0, stdout: 'codex-cli 0.167.0', stderr: '' };
      started();
      return new Promise((_resolve, reject) => invocation.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
    };
    const read = readRecoveryStatus({ context: 'user', cwd: value.cwd, env: value.env, nativeCliRunner: runner, signal: abort.signal });
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    abort.abort();
    await rejected;
    for (const cwd of observedCwds) if (cwd !== value.cwd) expect(await fs.pathExists(cwd)).toBe(false);
    expect((await fs.readdir(value.env.TMPDIR!)).filter((entry) => entry.startsWith('aw-user-neutral-'))).toEqual([]);
  });

  it.each(['version', 'list'] as const)('preserves an unconfirmed Native process cleanup failure during %s cancellation', async (stage) => {
    const value = await fixture('codex', { available: true });
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const cleanupError = new Error('Process cleanup could not be confirmed');
    let failure!: NativeCliError;
    const read = readRecoveryStatus({ context: 'user', cwd: value.cwd, env: value.env, signal: abort.signal,
      nativeCliRunner: async (invocation) => {
        if (stage === 'list' && invocation.args.includes('--version')) return { exitCode: 0, stdout: 'codex-cli 0.167.0', stderr: '' };
        started();
        return new Promise((_resolve, reject) => invocation.signal?.addEventListener('abort', () => {
          failure = new NativeCliError({ invocation, exitCode: 1, stdout: '', stderr: '', reason: 'aborted', cause: abort.signal.reason, cleanupError });
          reject(failure);
        }, { once: true }));
      } });
    const outcome = read.catch((error: unknown) => error);
    await ready;
    abort.abort();
    expect(await outcome).toBe(failure);
    expect(failure.cleanupError).toBe(cleanupError);
  });

  it('keeps render-input drift recoverable without executing the dynamic renderer', async () => {
    const value = await fixture('opencode', { available: true, dynamic: true });
    const { layout, component } = await placement(value);
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    await fs.outputFile(path.join(layout.packageRoot, 'skills/old/SKILL.md'), 'old');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: { physicalIdentity: layout.physicalIdentity, preparation: 'complete',
        components: [{ id: 'old', nativeName: 'old', relativeOutputs: ['skills/old/SKILL.md'] }],
        inputDigest: `sha256:${'a'.repeat(64)}`, contentDigest: `sha256:${'b'.repeat(64)}` } });
    const before = await snapshot(layout.packageRoot);
    expect(target(await value.read())).toMatchObject({ content: 'drifted', observation: 'unknown' });
    expect(await fs.pathExists(value.sentinel)).toBe(false);
    expect(await snapshot(layout.packageRoot)).toEqual(before);
  });

  it('keeps a foreign package conflicting even when dynamic expectations are unconfirmed', async () => {
    const value = await fixture('opencode', { available: true, dynamic: true });
    const { layout } = await placement(value);
    await fs.outputFile(path.join(layout.packageRoot, 'foreign.txt'), 'foreign');
    expect(target(await value.read())).toMatchObject({ content: 'conflict', blockers: expect.arrayContaining([
      expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
    ]) });
    expect(await fs.readFile(path.join(layout.packageRoot, 'foreign.txt'), 'utf8')).toBe('foreign');
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  it('does not grant ownership when another source owns the same native directory', async () => {
    const value = await fixture('opencode', { available: true });
    const { layout, component } = await placement(value);
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    await fs.outputFile(path.join(layout.packageRoot, 'index.ts'), 'foreign source');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot,
      identity: { ...component.identity, sourceId: 'other', pluginId: 'other/demo' } });
    expect(target(await value.read()).content).toBe('conflict');
    expect(await fs.readFile(path.join(layout.packageRoot, 'index.ts'), 'utf8')).toBe('foreign source');
  });

  it('retains a proven owned orphan Native directory in recovery inventory', async () => {
    const value = await fixture('opencode', { available: true });
    const { layout, component } = await placement(value);
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    await fs.outputFile(path.join(layout.packageRoot, 'index.ts'), 'owned orphan');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    await removeRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, 'local/demo');
    const status = await value.read();
    expect(status.inventory).toEqual([]);
    expect(status.extraObserved).toContainEqual(expect.objectContaining({ pluginId: 'local/demo', agent: 'opencode', scope: 'user' }));
    expect(status.inSync).toBe(false);
    expect(await fs.readFile(path.join(layout.packageRoot, 'index.ts'), 'utf8')).toBe('owned orphan');
  });

  it('does not invent target demand when preferences have no selected platform', async () => {
    const value = await fixture();
    await writePreferences({ scope: 'user', cwd: value.cwd, env: value.env }, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: [], exclusions: [] });
    const status = await value.read();
    expect(status.selection.agents).toEqual([]);
    expect(status.inventory?.[0]?.targetResults).toEqual([]);
    expect(status.errors.map((entry) => entry.code)).toContain('targetsNotConfigured');
    expect(status.allSatisfied).toBe(false);
  });

  it('keeps unavailable root declarations visible when the active source changes identity', async () => {
    const value = await fixture();
    const { resolveIntentPath } = await import('../../src/intent/intent-store.js');
    const file = await resolveIntentPath({ cwd: value.cwd, env: value.env, scope: 'user' });
    const intent = await fs.readJson(file);
    intent.sources.local.logicalIdentity = 'different-source';
    await fs.writeJson(file, intent);
    const status = await value.read();
    expect(status.inventory?.[0]).toMatchObject({ pluginId: 'local/demo', sourceState: 'identity-mismatch',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'sourceIdentityMismatch' })]) });
    expect(status.allSatisfied).not.toBe(true);
  });

  it('propagates a transitive dependency capability blocker without rendering any source', async () => {
    const value = await fixture('opencode', { available: true });
    await createDependencyCatalogSnapshotFixture(value.source, [
      { name: 'leaf', requiredCapabilities: ['aw.future-status-capability.v1'], configureManifest: (manifest) => { delete manifest.extensions; manifest.platforms = ['opencode']; } },
      { name: 'middle', dependencies: ['leaf'], configureManifest: (manifest) => { delete manifest.extensions; manifest.platforms = ['opencode']; } },
      { name: 'demo', dependencies: ['middle'], configureManifest: (manifest) => { delete manifest.extensions; manifest.platforms = ['opencode']; } },
    ]);
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    const status = await value.read();
    expect(status.inventory?.map((entry) => entry.pluginId)).toEqual(['local/demo']);
    expect([...target(status).blockers, ...status.errors].map((entry) => entry.code), JSON.stringify(status))
      .toContain('awCapabilityUnsupported');
    expect(status.allSatisfied).not.toBe(true);
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  // The public inventory must share one immutable native marketplace observation across sibling plugins.
  it('uses one Codex marketplace snapshot for twenty Native roots', async () => {
    const value = await fixture('codex', { available: true });
    const names = Array.from({ length: 20 }, (_, index) => index === 0 ? 'demo' : `plugin-${index}`);
    await createDependencyCatalogSnapshotFixture(value.source, names.map((name) => ({ name,
      configureManifest: (manifest) => { delete manifest.extensions; manifest.platforms = ['codex']; },
    })));
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    for (const name of names.slice(1)) await addRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, `local/${name}`, value.logicalIdentity);
    const before = await snapshot(value.isolation.layout.rootDir);
    const status = await value.read();
    expect(status.inventory).toHaveLength(20);
    const reads = value.runner.mock.calls.map(([invocation]) => invocation).filter((invocation) => invocation.args.includes('list'));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.args).toEqual(expect.arrayContaining(['plugin', 'list', '--marketplace', '--json']));
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  it('does not repair invalid configuration during status', async () => {
    const value = await fixture('opencode', { available: true, dynamic: true });
    await createCatalogSnapshotFixture(value.source, 'demo', [], 'Demo', (manifest) => {
      manifest.platforms = ['opencode'];
      manifest.artifacts = { configKeys: ['mode'] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.config = { fields: { mode: { type: 'string', default: 'normal' } } };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    const { writePluginConfigStore } = await import('../../src/utils/plugin-config.js');
    await writePluginConfigStore({ sourceId: 'local', sourceIdentity: value.sourceIdentity, pluginName: 'demo',
      scope: 'user', cwd: value.cwd, env: value.env, values: { mode: 42 } });
    const before = await snapshot(value.isolation.layout.rootDir);
    const status = await value.read();
    expect(target(status).observation).toBe('unknown');
    expect(target(status).blockers).toContainEqual(expect.objectContaining({ code: 'nativeObservationFailed' }));
    expect(status.allSatisfied).not.toBe(true);
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });
});
