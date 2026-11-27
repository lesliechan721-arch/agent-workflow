import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TARGETS, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { portableRecoveryLayout } from '../../src/portable/recovery-layout.js';
import { observePortableSkill, portableOwnedTreeDigest, publishPortableSkill } from '../../src/portable/writer.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import { addRoot, removeRoot } from '../../src/intent/intent-store.js';
import { writePreferences } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSnapshotLogicalIdentity } from '../../src/utils/catalog-generation-store.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { cursorWorkspaceOpenCommand } from '../../src/platforms/projection.js';
import { writePlatformSupplementState } from '../../src/platforms/supplement-state.js';
import { ownedSupplementFile, supplementRelativePath } from '../../src/platforms/supplement-layout.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { readDemand } from '../../src/recovery/demand.js';
import { createPlatformEmptyState, createPlatformInputEvidence, platformPackageInputDigest, readPlatformPackageContentDigest, writePlatformEmptyState } from '../../src/utils/platform-empty-state.js';
import { resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { SKILL_OWNER_MARKER, writeOwnedTextFile, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { NativeCliError, type NativeCliRunner } from '../../src/utils/native-cli.js';
import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import * as platformCapabilities from '../../src/platforms/capabilities.js';
import { isolateCodexAppDiscoveryQueries } from '../helpers/native-execution-fixture.js';

afterEach(() => vi.restoreAllMocks());

const nativeProfiles = [
  ['codex', 'codex', 'codex-cli 0.167.0'], ['claude', 'claude', '2.1.317 (Claude Code)'],
  ['cursor', 'cursor-agent', 'Cursor Agent 2026.11.05-86047df'], ['antigravity', 'agy', 'Antigravity 1.3.4'],
  ['opencode', 'opencode', 'opencode 2.2.6'], ['pi', 'pi', 'pi coding agent 1.5.0'],
  ['copilot', 'copilot', 'GitHub Copilot 1.0.95'],
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
async function fixture(platform: PlatformTarget = 'opencode', options: { dynamic?: boolean; artifactScopes?: Array<'user' | 'project'>; mixed?: boolean; version?: string; empty?: boolean; scope?: 'user' | 'project'; available?: boolean; requiredConfig?: boolean; platforms?: PlatformTarget[] } = {}) {
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
    manifest.platforms = options.platforms ?? [platform];
    if (options.requiredConfig) manifest.config = { schemaVersion: 5, fields: { profile: { type: 'string', required: true } } };
    if (options.mixed) manifest.extensions = { instructions: [{ name: 'context', title: 'Context', content: 'Use this context.', coverage: ['main'] }] };
    if (!options.empty && !options.dynamic) manifest.skills = './skills';
    if (options.dynamic) {
      manifest.artifacts = { configKeys: [], ...(options.artifactScopes ? { scopes: options.artifactScopes } : {}) };
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
  await writePreferences({ scope: 'user', cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: options.platforms ?? [platform], exclusions: [] });
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
  await fs.outputJson(path.join(layout.marketplaceRoot!, 'config.json'), { schemaVersion: 2,
    sourceId: 'local', sourceIdentity: value.sourceIdentity, marketplaceName: layout.marketplaceName });
  await fs.outputJson(path.join(layout.marketplaceRoot!, '.agents/plugins/marketplace.json'), {
    name: layout.marketplaceName, plugins: [{ name: 'demo', source: './plugins/demo' }],
  });
  if (value.scope === 'project') await fs.outputFile(path.join(value.cwd, '.codex/config.toml'),
    `[plugins.${JSON.stringify(id)}]\nenabled = true\n`);
  return materializeStatusSkill(value, 'codex', { binding, layout, renderUnits, component });
}

async function materializeStatusSkill(value: Awaited<ReturnType<typeof fixture>>, platform: PlatformTarget,
  placed: Awaited<ReturnType<typeof placement>>) {
  const { binding, layout, renderUnits, component } = placed;
  if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
  const manifestFile = ['opencode', 'pi'].includes(platform) ? 'package.json' : `.${platform}-plugin/plugin.json`;
  await fs.outputJson(path.join(layout.packageRoot, manifestFile), { name: layout.nativeIdentity.packageId, version: '1.0.0' });
  const skill = path.join(layout.packageRoot, 'skills/example/SKILL.md');
  await fs.outputFile(skill, '---\nname: example\ndescription: Example.\n---\nExample.\n');
  const adapter = getAgentPluginAdapter(platform);
  const demand = await readDemand({ scope: value.scope, cwd: value.cwd, env: value.env });
  const plugin = demand.roots![0]!.plugin!;
  const input = await createPlatformInputEvidence({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
    renderUnit,
    capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile(platform) }),
    config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
      sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform,
      scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
  }))) });
  const components = [{ id: 'skill:example', nativeName: 'example', relativeOutputs: ['skills/example/SKILL.md'] }];
  await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
    nativeProjection: { physicalIdentity: layout.physicalIdentity, preparation: 'complete',
      components, inputDigest: platformPackageInputDigest(input, components),
      contentDigest: (await readPlatformPackageContentDigest(layout.packageRoot))! } });
  return { binding, layout, skill, input };
}

describe('public status through platform adapters', () => {
  // Test Value Gate: a valid old copied owner must expose actual Antigravity
  // byte drift through public status without asserting unknown model adoption.
  it.each(['current', 'old'] as const)('checks Antigravity actual copy freshness with %s bytes', async (state) => {
    const value = await fixture('antigravity', { available: true });
    const { binding, layout, renderUnits, component } = await placement(value, 'antigravity');
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    const nativeRoot = path.join(layout.physicalIdentity.namespaceRoot, 'plugins', layout.nativeIdentity.packageId);
    const relative = 'skills/example/SKILL.md';
    await fs.outputJson(path.join(layout.packageRoot, '.antigravity-plugin/plugin.json'), { name: layout.nativeIdentity.packageId, version: '1.0.0' });
    await fs.outputFile(path.join(layout.packageRoot, relative), 'Latest installed content.\n');
    const contentDigest = (await readPlatformPackageContentDigest(layout.packageRoot))!;
    const projection = { physicalIdentity: layout.physicalIdentity, preparation: 'complete' as const,
      components: [{ id: 'skill:example', nativeName: 'example', relativeOutputs: [relative] }],
      inputDigest: `sha256:${'0'.repeat(64)}`, contentDigest };
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity, nativeProjection: projection });
    await fs.copy(component.path, nativeRoot);
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
      ? { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: layout.nativeIdentity.packageId, version: '1.0.0',
        source: 'antigravity', path: nativeRoot, enabled: true }]) } : probe(invocation));
    const adapter = getAgentPluginAdapter('antigravity');
    const demand = await readDemand({ scope: value.scope, cwd: value.cwd, env: value.env });
    const plugin = demand.roots![0]!.plugin!;
    const input = await createPlatformInputEvidence({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('antigravity') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
        sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'antigravity',
        scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
    }))) });
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: { ...projection, inputDigest: platformPackageInputDigest(input) } });
    if (state === 'old') {
      await fs.outputFile(path.join(nativeRoot, relative), 'Old copied content.\n');
      await writeSkillOwnerMarker({ skillRoot: nativeRoot, allowedRoot: layout.physicalIdentity.namespaceRoot, identity: component.identity,
        nativeProjection: { ...projection, contentDigest: (await readPlatformPackageContentDigest(nativeRoot))! } });
    }
    const result = target(await value.read());
    expect(result.content).toBe(state === 'old' ? 'drifted' : 'satisfied');
    if (state === 'old') expect(result.reasons).toContainEqual(expect.objectContaining({ code: 'nativePackageContentDrift' }));
    else expect(result.reasons ?? []).not.toContainEqual(expect.objectContaining({ code: 'nativePackageContentDrift' }));
  });

  // Test Value Gate: a current AW source is insufficient when Grok still has
  // an old or unreadable installation; only matching native bytes are current.
  it.each(['current', 'old', 'missing', 'inspect failed'] as const)('checks Grok native copy bytes with a %s installation', async (state) => {
    const value = await fixture('grok', { available: true });
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
    const demand = await readDemand({ scope: value.scope, cwd: value.cwd, env: value.env });
    const plugin = demand.roots![0]!.plugin!;
    const input = await createPlatformInputEvidence({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('grok') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
        sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'grok',
        scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
    }))) });
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: { ...projection, inputDigest: platformPackageInputDigest(input) } });
    if (state === 'old') await fs.outputFile(path.join(nativeRoot, skill), 'Old installed content.\n');
    if (state === 'missing') await fs.remove(nativeRoot);
    if (state === 'inspect failed') {
      const installedProbe = value.runner.getMockImplementation()!;
      value.runner.mockImplementation(async (invocation) => invocation.args[0] === 'inspect'
        ? { exitCode: 1, stderr: 'Grok inspect failed.', stdout: '' } : installedProbe(invocation));
    }
    const result = target(await value.read());
    expect(result.content).toBe(state === 'current' ? 'satisfied' : state === 'old' ? 'drifted' : state === 'missing' ? 'absent' : 'unknown');
    if (state === 'old' || state === 'missing') expect(result.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: state === 'old' ? 'nativePackageContentDrift' : 'nativePackageMissing' }),
    ]));
    if (state === 'inspect failed') expect(result).toMatchObject({
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'nativeObservationFailed' })]),
      deploymentObservations: [{ after: { package: 'present', registration: 'present', nativePackage: 'present',
        nativeIdentity: { registrationId: 'native-demo' }, consumers: [{ activation: 'unknown' }] } }],
    });
  });

  // A scoped list can independently confirm Project enablement, prove it disabled,
  // or leave it unknown even though the neutral inventory confirms registration.
  it.each([
    { mode: 'no local entry', neutral: true, exact: true, activation: 'enabled', content: 'unknown', exit: 3 },
    { mode: 'independent', neutral: false, exact: true, activation: 'enabled', content: 'satisfied', exit: 0 },
    { mode: 'ambiguous', neutral: true, exact: true, activation: 'enabled', content: 'unknown', exit: 3 },
    { mode: 'not applied', neutral: false, exact: false, activation: 'disabled', content: 'drifted', exit: 0 },
    { mode: 'no scoped evidence', neutral: true, exact: undefined, activation: 'unknown', content: 'unknown', exit: 3 },
  ])('projects Codex $mode activation through CLI status without starting app-server', async ({ mode, neutral, exact, activation, content, exit }) => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true, scope: 'project' });
    const { layout } = await materializeCodexSkill(value);
    if (mode === 'no local entry') await fs.remove(path.join(value.cwd, '.codex', 'config.toml'));
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => {
      if (!invocation.args.includes('list')) return probe(invocation);
      const enabled = invocation.cwd === value.cwd ? exact : neutral;
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({
        installed: enabled === undefined ? [] : [{ pluginId: layout.nativeIdentity.registrationId, installed: true, enabled }], available: [],
      }) };
    });
    const before = await snapshot(value.isolation.layout.rootDir);
    const captured = createCapturedCliIo();
    const code = await runCli(['plugin', 'status', '--context', 'project', '--observe-native', '--json'], {
      cwd: value.cwd, env: value.env, io: captured.io, nativeCliRunner: value.runner,
    });
    const result = JSON.parse(captured.readStdout());
    expect(code, JSON.stringify(result)).toBe(exit);
    expect(result).toMatchObject({ schemaVersion: 2,
      status: exit === 0 ? 'success' : 'blocked',
      data: { allSatisfied: content === 'unknown' ? null : content === 'satisfied',
        inSync: neutral ? false : content === 'unknown' ? null : content === 'satisfied',
        counts: { blocked: 0, pending: content === 'drifted' ? 1 : 0, unconfirmed: content === 'unknown' ? 1 : 0, ready: content === 'satisfied' ? 1 : 0 } } });
    const observed = result.data.inventory[0].targetResults[0];
    expect(observed.content).toBe(content);
    const after = observed.deploymentObservations[0].after;
    expect(after).toMatchObject({ package: 'present', registration: 'present', consumers: [{ activation, load: 'unknown' }] });
    if (mode === 'no scoped evidence') expect(after).not.toHaveProperty('scopeActivation');
    else expect(after.scopeActivation).toBe(content === 'unknown' ? 'unknown' : activation);
    expect(after.consumers[0]).not.toHaveProperty('trust');
    expect(after.configuration).not.toHaveProperty('trust');
    expect(value.runner.mock.calls.some(([invocation]) => invocation.args.includes('app-server'))).toBe(false);
    expect(result.diagnostics.some((entry: { code: string }) => entry.code === 'nativeObservationSideEffects')).toBe(false);
    if (mode === 'not applied') {
      expect(result.nextActions).toContainEqual(expect.objectContaining({
        argv: ['aw', 'plugin', 'sync', 'local/demo', '--context', 'project', '--target', 'codex'],
      }));
      const text = createCapturedCliIo();
      expect(await runCli(['plugin', 'status', '--context', 'project'], {
        cwd: value.cwd, env: value.env, io: text.io, nativeCliRunner: value.runner,
      })).toBe(0);
      expect(text.readStdout()).toContain('Disabled');
    }
    if (content === 'unknown') {
      const explicit = createCapturedCliIo();
      expect(await runCli(['plugin', 'status', 'local/demo', '--context', 'project', '--json'], {
        cwd: value.cwd, env: value.env, io: explicit.io, nativeCliRunner: value.runner,
      })).toBe(3);
      expect(JSON.parse(explicit.readStdout()).data.coverage.requestComplete).toBe(false);
    }
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  it('uses inherited Codex activation for a User-provided Project dependency without blocking its consumer', async () => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true });
    await createDependencyCatalogSnapshotFixture(value.source, [
      { name: 'demo', configureManifest: (manifest) => { manifest.platforms = ['codex']; manifest.skills = './skills'; delete manifest.extensions; } },
      { name: 'consumer', dependencies: ['demo'], configureManifest: (manifest) => { manifest.platforms = ['codex']; delete manifest.extensions; } },
    ]);
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    await addRoot({ cwd: value.cwd, env: value.env, scope: 'project' }, 'local/consumer', value.logicalIdentity);
    await materializeCodexSkill(value);
    const status = await readRecoveryStatus({ cwd: value.cwd, env: value.env, context: 'project', nativeCliRunner: value.runner });
    expect(status.allSatisfied, JSON.stringify(status)).toBe(true);
    const project = status.inventory?.find((entry) => entry.pluginId === 'local/consumer')?.targetResults[0];
    expect(project).toMatchObject({ scope: 'project', content: 'satisfied', blockers: [] });
    expect(project?.deploymentObservations).toContainEqual(expect.objectContaining({
      after: expect.objectContaining({ scopeActivation: 'unknown', registration: 'present',
        consumers: [expect.objectContaining({ activation: 'enabled' })] }),
    }));
    expect(project?.reasons ?? []).not.toContainEqual(expect.objectContaining({ code: 'codexProjectActivationUnconfirmed' }));
  });

  it.each(['codex-cli 0.167.0', 'codex-cli 0.168.0'])('confirms a current Codex User package through %s without host load', async (version) => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true, version });
    await materializeCodexSkill(value);
    const status = await value.read();
    expect(status).toMatchObject({ allSatisfied: true, inSync: true, counts: { blocked: 0, ready: 1 } });
    expect(target(status)).toMatchObject({ content: 'satisfied', observation: 'verified', deploymentObservations: [
      { after: { consumers: [{ activation: 'enabled', load: 'unknown' }] } },
    ] });
  });

  it('reports a changed Codex package as pending while retaining registration and activation', async () => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true });
    const { skill } = await materializeCodexSkill(value);
    await fs.appendFile(skill, 'Changed bytes.\n');
    const status = await value.read();
    expect(status).toMatchObject({ allSatisfied: false, inSync: false, counts: { blocked: 0, pending: 1 } });
    expect(target(status)).toMatchObject({ content: 'drifted', blockers: [],
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'platformContentDrift' })]),
      deploymentObservations: [{ after: { package: 'present', registration: 'present', consumers: [{ activation: 'enabled' }] } }],
    });
  });

  it('reports known Codex package drift when a new renderer also needs initial supplement evidence', async () => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true });
    await materializeCodexSkill(value);
    await fs.outputFile(path.join(value.source, 'plugins/demo/render.mjs'), 'throw new Error("Must not render in status");');
    await createCatalogSnapshotFixture(value.source, 'demo', [], 'Demo', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    const output = createCapturedCliIo();
    expect(await runCli(['plugin', 'status', 'local/demo', '--context', 'user', '--json'], {
      cwd: value.cwd, env: value.env, nativeCliRunner: value.runner, io: output.io,
    }), output.readStdout()).toBe(0);
    const result = JSON.parse(output.readStdout());
    expect(result).toMatchObject({ status: 'success', data: { coverage: { requestComplete: true },
      counts: { pending: 1, blocked: 0, unconfirmed: 0 }, inventory: [{ targetResults: [{ content: 'drifted', blockerCodes: [],
        deploymentObservations: [{ after: { registration: 'present', consumers: [{ activation: 'enabled' }] } }],
      }] }] },
      diagnostics: expect.arrayContaining(['platformInputDrift', 'dynamicExpectationUnconfirmed']
        .map((code) => expect.objectContaining({ code, severity: 'warning' }))),
    });
  });

  // A complete role-only projection does not require a shared package slot.
  // Older matching owner evidence remains useful when only the role input digest changed.
  it.each([
    { mode: 'project only', scopes: ['project'] as const, expected: 'satisfied' },
    { mode: 'package deliberately empty', scopes: undefined, expected: 'satisfied' },
    { mode: 'old role inputs', scopes: ['project'] as const, expected: 'drifted' },
    { mode: 'damaged role receipt', scopes: ['project'] as const, expected: 'unknown' },
    { mode: 'unproved package', scopes: undefined, expected: 'unknown' },
  ])('inspects Codex dynamic role evidence for $mode without a package', async ({ mode, scopes, expected }) => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true, dynamic: true, scope: 'project', artifactScopes: scopes ? [...scopes] : undefined });
    const { binding, layout, renderUnits } = await placement(value, 'codex');
    const ctx = { cwd: value.cwd, env: value.env, runner: value.runner };
    const adapter = getAgentPluginAdapter('codex');
    const demand = await readDemand({ ...ctx, scope: 'project' });
    const plugin = demand.roots![0]!.plugin!;
    const inputs = await createPlatformInputEvidence({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('codex') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
        sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'codex',
        scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
    }))) });
    const unit = inputs.units.find((entry) => entry.output === 'supplement')!;
    const fileName = supplementRelativePath(binding, { kind: 'agent', name: 'reviewer' });
    const content = 'name = "aw-local-demo-reviewer"\ndescription = "Reviews changes"\ndeveloper_instructions = "Check the diff"\n';
    const file = ownedSupplementFile(binding, unit.physicalKey, path.join(layout.supplementRoot!, fileName));
    await writeOwnedTextFile({ ...file, content });
    const inputDigest = mode === 'old role inputs' ? `sha256:${'a'.repeat(64)}` : unit.inputDigest;
    await writePlatformSupplementState(ctx, binding, mode === 'damaged role receipt' ? 'broken' : inputDigest,
      [{ id: 'role', fileName, contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}` }]);
    if (mode === 'package deliberately empty') await writePlatformEmptyState({ state: { ...inputs, kind: 'aw-platform-empty-state',
      result: 'intentional-empty', units: inputs.units.filter((entry) => entry.output === 'package') }, env: value.env });
    const captured = createCapturedCliIo();
    expect(await runCli(['plugin', 'status', 'local/demo', '--context', 'project', '--json'], {
      ...ctx, nativeCliRunner: value.runner, io: captured.io,
    })).toBe(expected === 'unknown' ? 3 : 0);
    const result = JSON.parse(captured.readStdout());
    expect(result.data.inventory[0].targetResults[0]).toMatchObject({
      content: expected, blockerCodes: [], deploymentObservations: [{ after: { registration: 'absent', package: 'absent' } }],
    });
    if (mode === 'old role inputs') {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'platformInputDrift', severity: 'warning' }));
      expect(result.nextActions).toContainEqual(expect.objectContaining({
        argv: ['aw', 'plugin', 'sync', 'local/demo', '--context', 'project', '--target', 'codex'],
      }));
    }
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
    expect(target(status)).toMatchObject({ content: 'unknown', observation: 'unknown', reasons: expect.arrayContaining([
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
    const state = await createPlatformEmptyState({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('opencode') }),
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
    expect(target(await value.read())).toMatchObject({ content: 'unknown', observation: 'unknown', reasons: expect.arrayContaining([
      expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
    ]) });
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  // Test Value Gate: an empty receipt must not hide an enabled User native
  // registration. A Project with no explicit entry can retain User inheritance.
  it.each(['user', 'project'] as const)('checks dynamic empty Codex %s scope against native enabled with no local entry', async (scope) => {
    const value = await fixture('codex', { available: true, dynamic: true, scope });
    const { binding, layout, renderUnits } = await placement(value, 'codex');
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => invocation.args.includes('list')
      ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ installed: [{ pluginId: layout.nativeIdentity.registrationId,
        installed: true, enabled: true, version: '1.0.0' }], available: [] }) } : probe(invocation));
    const adapter = getAgentPluginAdapter('codex');
    const demand = await readDemand({ scope, cwd: value.cwd, env: value.env });
    const plugin = demand.roots![0]!.plugin!;
    const observation = await adapter.inspect({ cwd: value.cwd, env: value.env, runner: value.runner }, binding);
    expect(observation.configuration).toMatchObject({ scope, activation: 'absent' });
    expect(observation.consumers).toEqual([expect.objectContaining({ activation: 'enabled' })]);
    const state = await createPlatformEmptyState({ plugin, binding, units: await Promise.all(renderUnits.map(async (renderUnit) => ({
      renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('codex') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
        sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'codex',
        scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
    }))) });
    await writePlatformEmptyState({ state, env: value.env });
    const status = await value.read();
    if (scope === 'user') {
      expect(target(status).content).not.toBe('satisfied');
      expect(status.allSatisfied).not.toBe(true);
    } else {
      expect(target(status)).toMatchObject({ content: 'satisfied', observation: 'verified' });
      expect(status.allSatisfied).toBe(true);
    }
    expect(target(status).deploymentObservations?.[0]?.after.consumers).toEqual([expect.objectContaining({ activation: 'enabled' })]);
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  it('does not interpret a foreign Native package as installed or remove its files', async () => {
    const value = await fixture('opencode', { available: true });
    const { layout } = await placement(value);
    await fs.outputFile(path.join(layout.packageRoot, 'foreign.txt'), 'foreign bytes');
    const before = await snapshot(layout.packageRoot);
    const status = await value.read();
    expect(target(status).content).toBe('conflict');
    expect(target(status).deploymentObservations?.[0]?.after.ownership).toBe('foreign');
    expect(await snapshot(layout.packageRoot)).toEqual(before);
  });

  it.each(['static', 'dynamic'] as const)('reports an installed OpenCode %s Skill from before the registration format update as drifted', async (kind) => {
    const value = await fixture('opencode', { available: true, dynamic: kind === 'dynamic' });
    const { input, layout } = await materializeStatusSkill(value, 'opencode', await placement(value));
    const markerPath = path.join(layout.packageRoot, SKILL_OWNER_MARKER);
    const legacyMarker = await fs.readJson(markerPath);
    legacyMarker.nativeProjection.inputDigest = platformPackageInputDigest(input);
    await fs.writeJson(markerPath, legacyMarker);
    const before = await snapshot(layout.packageRoot);

    const status = await value.read();
    expect(status).toMatchObject({ allSatisfied: false, inSync: false });
    expect(target(status)).toMatchObject({ content: 'drifted', reasons: expect.arrayContaining([
      expect.objectContaining({ code: 'platformInputDrift' }),
    ]) });
    expect(await snapshot(layout.packageRoot)).toEqual(before);
    expect(await fs.pathExists(value.sentinel)).toBe(false);
  });

  // An absent weak receipt must not turn a statically unavailable Agent or its referring Skill into missing native output.
  it('reports a static Agent gap and its referring Skill through public status without requiring a renderer or receipt', async () => {
    const value = await fixture('opencode', { available: true });
    await fs.outputFile(path.join(value.source, 'plugins/demo/skills/example/references/usage.md'),
      'Use {{aw.agent:reviewer}}.\n', { mode: 0o755 });
    await createCatalogSnapshotFixture(value.source, 'demo', ['aw.skill-agent-placeholder.v1'], 'References', (manifest) => {
      manifest.platforms = ['opencode'];
      manifest.skills = './skills';
      manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review the changes.',
        agentOverrides: { opencode: { name: 'renamed-reviewer' } } }] };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0' });
    expect(await fs.pathExists(path.join(value.env.AW_HOME!, 'platforms/opencode/empty-state'))).toBe(false);
    const before = await snapshot(value.isolation.layout.rootDir);
    const output = createCapturedCliIo();
    const exit = await runCli(['plugin', 'status', 'local/demo', '--context', 'user', '--json'], {
      cwd: value.cwd, env: value.env, io: output.io, nativeCliRunner: value.runner,
    });
    const result = JSON.parse(output.readStdout());
    expect(result).toMatchObject({ schemaVersion: 2, command: 'plugin.status' });
    expect(output.readStderr()).toContain('platformExpectationUnconfirmed:');
    expect(exit, JSON.stringify(result)).toBe(3);
    const observed = result.data.inventory[0].targetResults[0];
    expect(observed.content).toBe('unknown');
    expect(observed.blockerCodes).toEqual([]);
    expect(observed.componentGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent:reviewer', kind: 'agent', name: 'renamed-reviewer', reasonCode: 'interface-unsupported',
        requiredFeatures: expect.arrayContaining([{ feature: 'component.kind.agent' }]) }),
      expect.objectContaining({ id: 'skill:example', kind: 'skill', reasonCode: 'interface-unsupported',
        requiredFeatures: expect.arrayContaining([{ feature: 'component.kind.agent' }]) }),
    ]));
    expect(observed.componentGaps).toHaveLength(2);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'platformExpectationUnconfirmed' })]));
    expect(result.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'platformPackageMissing' })]));
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });

  // Only current delivery evidence can resolve an otherwise unknown dynamic Agent; status must never execute the renderer.
  it('defers a mixed static Skill Agent reference until current recorded delivery is available', async () => {
    const value = await fixture('opencode', { available: true, dynamic: true });
    await fs.outputFile(path.join(value.source, 'plugins/demo/skills/example/SKILL.md'),
      '---\nname: example\ndescription: Example.\n---\nUse {{aw.agent:reviewer}}.\n');
    await fs.outputFile(path.join(value.source, 'plugins/demo/render.mjs'), [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(value.sentinel)}, "ran");`,
      'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const unmet = context.allowedOutputKinds.includes("agent") ? [{ id: "agent:reviewer", name: "reviewer", kind: "agent",',
      'reasonCode: "interface-unsupported", requiredFeatures: [{ feature: "component.kind.agent" }] }] : [];',
      'console.log(JSON.stringify({ version: 3, components: [], omitted: [], unmet }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(value.source, 'demo', ['aw.skill-agent-placeholder.v1'], 'Mixed', (manifest) => {
      manifest.platforms = ['opencode'];
      manifest.skills = './skills';
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0' });
    const read = async () => {
      const before = await snapshot(value.isolation.layout.rootDir);
      const output = createCapturedCliIo();
      const exit = await runCli(['plugin', 'status', 'local/demo', '--context', 'user', '--json'], {
        cwd: value.cwd, env: value.env, io: output.io, nativeCliRunner: value.runner,
      });
      expect(await fs.pathExists(value.sentinel)).toBe(false);
      expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
      const result = JSON.parse(output.readStdout());
      expect(result).toMatchObject({ schemaVersion: 2, command: 'plugin.status' });
      return { exit, stderr: output.readStderr(), observed: result.data.inventory[0].targetResults[0], diagnostics: result.diagnostics };
    };
    const unknown = await read();
    expect(unknown.exit, JSON.stringify(unknown.observed)).toBe(0);
    expect(unknown.observed).toMatchObject({ content: 'absent', blockerCodes: [] });
    expect(unknown.stderr).toContain('platformPackageMissing:');
    expect(unknown.diagnostics).toContainEqual(expect.objectContaining({ code: 'platformPackageMissing' }));
    expect(unknown.observed.componentGaps ?? []).toEqual([]);

    const { binding, renderUnits } = await placement(value);
    const adapter = getAgentPluginAdapter('opencode');
    const demand = await readDemand({ scope: value.scope, cwd: value.cwd, env: value.env });
    const plugin = demand.roots![0]!.plugin!;
    const input = await createPlatformInputEvidence({ plugin, binding,
      units: await Promise.all(renderUnits.map(async (renderUnit) => ({
        renderUnit,
        capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('opencode') }),
        config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'demo', sourceId: 'local',
          sourceIdentity: value.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity, platform: 'opencode',
          scope: renderUnit.renderScope.kind, cwd: value.cwd, env: value.env, referencePlugins: demand.plugins }),
      }))) });
    const gap = { id: 'skill:example', name: 'example', kind: 'skill' as const,
      reasonCode: 'interface-unsupported', requiredFeatures: [{ feature: 'component.kind.agent' }] };
    const agentGap = { ...gap, id: 'agent:reviewer', name: 'reviewer', kind: 'agent' as const };
    await writePlatformEmptyState({ env: value.env, state: { ...input, kind: 'aw-platform-empty-state', result: 'capability-gaps',
      gaps: [gap, agentGap], installedComponentIds: [] } });
    const confirmed = await read();
    expect(confirmed.exit, JSON.stringify(confirmed.observed)).toBe(0);
    expect(confirmed.observed).toMatchObject({ content: 'satisfied', blockerCodes: [],
      componentGaps: expect.arrayContaining([expect.objectContaining(gap), expect.objectContaining(agentGap)]) });
    expect(confirmed.observed.componentGaps).toHaveLength(2);
    expect(confirmed.stderr).not.toContain('platformPackageMissing:');
    expect(confirmed.diagnostics).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'platformPackageMissing' })]));
  });

  it('retains a static Skill expectation when gap evidence omits its component ID', async () => {
    const value = await fixture('cursor', { available: true, scope: 'project' });
    await createCatalogSnapshotFixture(value.source, 'demo', [], 'Mixed static components', (manifest) => {
      manifest.platforms = ['cursor'];
      manifest.skills = './skills';
      manifest.extensions = { hooks: [{ id: 'check', event: 'before_tool', feedback: 'notify', command: 'echo check' }] };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0' });
    const { input, layout } = await materializeStatusSkill(value, 'cursor', await placement(value, 'cursor'));
    await writePlatformEmptyState({ env: value.env, state: { ...input, kind: 'aw-platform-empty-state', result: 'capability-gaps',
      gaps: [{ id: 'hook:check', kind: 'hook', name: 'check', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['notify'] }],
        reasonCode: 'interface-unsupported' }], installedComponentIds: [] } });
    await fs.remove(layout.packageRoot);
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: 'absent', satisfaction: 'pending' });
    expect(status).toMatchObject({ allSatisfied: false, inSync: false, counts: { pending: 1 } });
  });

  it('keeps an unowned Codex role visible when its required tool restriction prevents projection', async () => {
    isolateCodexAppDiscoveryQueries();
    const value = await fixture('codex', { available: true, empty: true, scope: 'project' });
    await createCatalogSnapshotFixture(value.source, 'demo', [], 'Restricted role', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review the changes.', tools: [] }] };
    });
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0' });
    const { binding, layout } = await placement(value, 'codex');
    const file = path.join(layout.supplementRoot!, supplementRelativePath(binding, { kind: 'agent', name: 'reviewer' }));
    const previous = 'name = "reviewer"\ndescription = "User-edited role"\n';
    await fs.outputFile(file, previous);
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: 'conflict', componentGaps: [expect.objectContaining({ kind: 'agent' })],
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'previousDeploymentRetained', detail: expect.objectContaining({ path: file }) })]) });
    expect(status.allSatisfied).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(previous);
  });

  // Hook output belongs to an exact scope and is required for Cursor discovery.
  it.each(['present', 'absent', 'wrong-scope', 'unreadable'] as const)('checks Cursor workspaceOpen %s against a current Project package', async (entry) => {
    const value = await fixture('cursor', { available: true, scope: 'project' });
    const placed = await placement(value, 'cursor');
    const { binding, layout } = await materializeStatusSkill(value, 'cursor', placed);
    if (entry === 'unreadable') await fs.outputFile(layout.activationPath, '{ malformed');
    else if (entry !== 'absent') {
      const command = cursorWorkspaceOpenCommand(entry === 'wrong-scope' ? { ...binding, scope: { kind: 'user' } } : binding);
      await fs.outputJson(layout.activationPath, { version: 1, hooks: { workspaceOpen: [{ command }] } });
    }
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: entry === 'present' ? 'satisfied' : entry === 'unreadable' ? 'unknown' : 'drifted',
      blockers: [], deploymentObservations: [{ after: { package: 'present', registration: 'not-applicable',
        workspaceOpen: entry === 'wrong-scope' ? 'absent' : entry === 'unreadable' ? 'unknown' : entry } }] });
  });

  it.each([true, false])('keeps ordinary Pi Project readiness tied to native list visibility (%s)', async (listed) => {
    const value = await fixture('pi', { available: true, scope: 'project' });
    const placed = await placement(value, 'pi');
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => invocation.args.includes('list')
      ? { exitCode: 0, stderr: '', stdout: listed
        ? `Project packages:\n  ${placed.layout.packageRoot}\n    ${placed.layout.packageRoot}\n` : 'No packages installed.' }
      : probe(invocation));
    await materializeStatusSkill(value, 'pi', placed);
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: listed ? 'satisfied' : 'unknown', blockers: [], deploymentObservations: [
      { after: { package: 'present', registration: listed ? 'present' : 'unknown', consumers: [{ activation: 'unknown' }] } },
    ] });
    if (!listed) expect(target(status).reasons).toContainEqual(expect.objectContaining({ code: 'piProjectRegistrationNotVisible' }));
  });

  // Runtime service failure remains visible without changing directory delivery or coverage.
  it.each([false, true])('keeps OpenCode ready with an optional failed load (observeNative=%s)', async (observeNative) => {
    const value = await fixture('opencode', { available: true });
    const placed = await placement(value, 'opencode');
    const { layout } = await materializeStatusSkill(value, 'opencode', placed);
    const probe = value.runner.getMockImplementation()!;
    value.runner.mockImplementation(async (invocation) => {
      if (!invocation.args.includes('api')) return probe(invocation);
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({
        location: { directory: invocation.cwd }, data: [{ source: { type: 'local', path: layout.packageRoot },
          features: { server: true }, state: { status: 'failed', error: 'fixture load failure' } }],
      }) };
    });
    const before = await snapshot(value.isolation.layout.rootDir);
    const io = createCapturedCliIo();
    expect(await runCli(['plugin', 'status', '--context', 'user', '--json', ...(observeNative ? ['--observe-native'] : [])], {
      cwd: value.cwd, env: value.env, io: io.io, nativeCliRunner: value.runner,
    })).toBe(0);
    expect(JSON.parse(io.readStdout())).toMatchObject({ schemaVersion: 2, status: 'success', data: { allSatisfied: true, inSync: true,
      counts: { blocked: 0, pending: 0, unconfirmed: 0, ready: 1 }, inventory: [{ targetResults: [{ content: 'satisfied',
        deploymentObservations: [{ after: { consumers: [{ load: observeNative ? 'not-observed' : 'unknown' }] } }] }] }] },
      diagnostics: expect.arrayContaining((observeNative ? ['nativeObservationSideEffects', 'opencodePluginLoadFailed']
        : ['opencodeNativeObservationRequired']).map((code) => expect.objectContaining({ code, severity: 'warning',
          subject: { pluginId: 'local/demo', target: 'opencode', scope: 'user' } }))) });
    expect(value.runner.mock.calls.filter(([invocation]) => invocation.args.includes('api'))).toHaveLength(observeNative ? 1 : 0);
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
    if (observeNative) {
      await removeRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, 'local/demo');
      const residue = createCapturedCliIo();
      expect(await runCli(['plugin', 'status', 'local/demo', '--context', 'user', '--json', '--observe-native'], {
        cwd: value.cwd, env: value.env, io: residue.io, nativeCliRunner: value.runner,
      })).toBe(0);
      expect(JSON.parse(residue.readStdout())).toMatchObject({ data: { inventory: [], extraObserved: [{
        pluginId: 'local/demo', target: 'opencode', deploymentObservations: [{ after: { consumers: [{ load: 'not-observed' }] } }],
      }] }, diagnostics: expect.arrayContaining(['nativeObservationSideEffects', 'opencodePluginLoadFailed'].map((code) =>
        expect.objectContaining({ code, severity: 'warning', subject: { pluginId: 'local/demo', target: 'opencode', scope: 'user' } }))) });
    }
  });

  it('keeps owned Native materialization separate from unknown host activation and load', async () => {
    const value = await fixture('opencode', { available: true });
    const { layout, component } = await placement(value);
    if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
    await fs.outputFile(path.join(layout.packageRoot, 'index.ts'), 'export default {};');
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const before = await snapshot(layout.packageRoot);
    const status = await value.read();
    expect(target(status)).toMatchObject({ content: 'unknown', observation: 'unknown' });
    expect(target(status).deploymentObservations?.[0]?.after).toMatchObject({ package: 'present', ownership: 'aw',
      consumers: [expect.objectContaining({ activation: 'unknown', load: 'unknown' })] });
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
      expect.objectContaining({ code: 'deploymentOwnershipConflict' }),
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

  // Test Value Gate: a retained output from another Catalog identity must stay discoverable for cleanup without requiring the new plugin's configuration.
  it.each(['generic', 'opencode'] as const)('distinguishes old and current Catalog identity in %s residual configuration status', async (platform) => {
    const platforms: PlatformTarget[] = ['generic', 'opencode'];
    const value = await fixture(platform, { available: true, requiredConfig: true, platforms });
    await removeRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, 'local/demo');
    const installResidue = async (current: boolean) => {
      if (platform === 'generic') {
        const context = await createScopeContext({ scope: 'user', cwd: value.cwd, env: value.env, readOnly: true });
        try {
          const destinationRoot = portableRecoveryLayout(context).targetRoot(platform);
          // The old output deliberately sorts after the current one, so cached config checks cannot leak between identities.
          const skill = current ? 'current-example' : 'old-example';
          const identity = { pluginId: 'local/demo', logicalIdentity: current ? value.logicalIdentity : 'previous-catalog',
            platform, scope: 'user' as const, skill };
          const sourceDir = path.join(value.isolation.layout.fixtureCwd, skill);
          await fs.outputFile(path.join(sourceDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: Example.\n---\nExample.\n`);
          await fs.outputFile(path.join(sourceDir, 'README.md'), 'Example.\n');
          const expectedDigest = await portableOwnedTreeDigest(sourceDir);
          await publishPortableSkill({ sourceDir, destinationRoot, identity, expectedDigest, configDigest: portableJsonDigest({}),
            observed: await observePortableSkill({ destinationRoot, skill, identity }) });
        } finally { await context.dispose(); }
      } else {
        const { layout, component } = await placement({ ...value, sourceIdentity: current ? value.sourceIdentity : `sha256:${'b'.repeat(64)}` }, platform);
        if (component.kind !== 'owned-directory') throw new Error('Expected native package.');
        await fs.outputFile(path.join(layout.packageRoot, 'index.ts'), 'retained content');
        await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
      }
    };
    await installResidue(false);
    const read = async () => {
      const before = await snapshot(value.isolation.layout.rootDir);
      const recovery = await value.read();
      const summary = await statusCommandV8({ scope: 'user', cwd: value.cwd, env: value.env, cliVersion: '1.0.0', nativeCliRunner: value.runner });
      expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
      expect(recovery.extraObserved).toContainEqual(expect.objectContaining({ pluginId: 'local/demo', agent: platform, scope: 'user' }));
      expect(recovery.ownedTargets).toContainEqual({ pluginId: 'local/demo', agent: platform, scope: 'user' });
      return { recovery, summary: summary.pluginSummaries.find((entry) => entry.pluginId === 'local/demo') };
    };
    const previous = await read();
    expect(previous.recovery.extraObserved.flatMap((entry) => entry.blockers ?? [])).not.toContainEqual(expect.objectContaining({ code: 'requiredConfigMissing' }));
    expect(previous.summary?.configIssues).toBeUndefined();
    expect(previous.recovery.existingTargets).not.toContainEqual({ pluginId: 'local/demo', agent: platform, scope: 'user' });

    await installResidue(true);
    const current = await read();
    expect(current.recovery.extraObserved.flatMap((entry) => entry.blockers ?? [])).toContainEqual(expect.objectContaining({ code: 'requiredConfigMissing' }));
    expect(current.summary?.configIssues).toEqual([expect.objectContaining({ key: 'profile', platform, scope: 'user', type: 'missing-required' })]);
    if (platform === 'generic') {
      const previousOutput = current.recovery.extraObserved.find((entry) => (entry.backend as { logicalIdentity?: string })?.logicalIdentity === 'previous-catalog');
      expect(previousOutput).toBeDefined();
      expect(previousOutput?.blockers ?? []).not.toContainEqual(expect.objectContaining({ code: 'requiredConfigMissing' }));
    }

    await addRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, 'local/demo', value.logicalIdentity);
    const demanded = await statusCommandV8({ scope: 'user', cwd: value.cwd, env: value.env, cliVersion: '1.0.0', nativeCliRunner: value.runner });
    expect(demanded.pluginSummaries.find((entry) => entry.pluginId === 'local/demo')?.configIssues).toEqual(
      expect.arrayContaining(platforms.map((platform) => expect.objectContaining({ key: 'profile', platform, scope: 'user', type: 'missing-required' }))));
  });

  // Test Value Gate: an excluded root contributes no target demand to its dependency, but another valid root still needs it.
  it('only checks undeployed dependency configuration for actual target requirements', async () => {
    const value = await fixture('cursor');
    await createDependencyCatalogSnapshotFixture(value.source, [
      { name: 'provider', configureManifest: (manifest) => {
        manifest.platforms = ['cursor'];
        manifest.config = { schemaVersion: 5, fields: { profile: { type: 'string', required: true } } };
      } },
      { name: 'demo', dependencies: ['provider'], configureManifest: (manifest) => { manifest.platforms = ['cursor']; } },
      { name: 'consumer', dependencies: ['provider'], configureManifest: (manifest) => { manifest.platforms = ['cursor']; } },
    ]);
    await syncCatalogSourceGeneration({ sourceId: 'local', env: value.env, cliVersion: '1.0.0', impactConfirmed: true });
    await writePreferences({ scope: 'user', cwd: value.cwd, env: value.env }, { schemaVersion: 2, kind: 'aw-deployment-preferences',
      targets: ['cursor'], exclusions: [{ plugin: 'local/demo', target: 'cursor' }] });
    const read = async () => (await statusCommandV8({ scope: 'user', cwd: value.cwd, env: value.env, cliVersion: '1.0.0', nativeCliRunner: value.runner }))
      .pluginSummaries.find((entry) => entry.pluginId === 'local/provider');
    const excluded = await read();
    expect(excluded).toBeDefined();
    expect(excluded?.configIssues).toBeUndefined();
    await addRoot({ cwd: value.cwd, env: value.env, scope: 'user' }, 'local/consumer', value.logicalIdentity);
    expect((await read())?.configIssues).toContainEqual(expect.objectContaining({ key: 'profile', platform: 'cursor', scope: 'user', type: 'missing-required' }));
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
    expect(target(status).blockers).toContainEqual(expect.objectContaining({ code: 'configInvalid', detail: { reasonCode: 'invalidConfig', fieldKeys: ['mode'] } }));
    expect(target(status).blockers).not.toContainEqual(expect.objectContaining({ code: 'nativeObservationFailed' }));
    expect(status.allSatisfied).not.toBe(true);
    expect(await snapshot(value.isolation.layout.rootDir)).toEqual(before);
  });
});
