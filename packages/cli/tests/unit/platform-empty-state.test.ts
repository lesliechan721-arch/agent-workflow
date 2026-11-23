import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizeCommandRoutes } from '@lesliechan721/aw-plugin-core/manifest';

import { createPlatformEmptyState, createPlatformInputEvidence, matchesPlatformEmptyState, platformPackageInputDigest, readPlatformDeliveryState, writePlatformEmptyState, type PlatformInputEvidence } from '../../src/utils/platform-empty-state.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import type { PluginMeta } from '../../src/types.js';
import type { DeploymentObservation } from '../../src/platforms/contracts.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('native intentional empty currentness', () => {
  it('keeps older OpenCode package evidence current when the package only contains an MCP server', () => {
    const id = `sha256:${'a'.repeat(64)}`;
    const scope = { kind: 'user' } as const;
    const evidence: PlatformInputEvidence = {
      schemaVersion: 1, kind: 'aw-platform-input', platform: 'opencode',
      plugin: { sourceId: 'local', sourceIdentity: id, pluginId: 'local/mcp', version: '1.0.0' },
      binding: { id, physicalKey: id, scope },
      units: [{ id, physicalKey: id, renderScope: scope, output: 'package', kinds: ['skill', 'mcp'], inputDigest: id }],
    };
    const storedDigest = platformPackageInputDigest(evidence);
    expect(platformPackageInputDigest(evidence, [{ id: 'mcp:service', nativeName: 'service', relativeOutputs: ['index.mjs'] }]))
      .toBe(storedDigest);
  });

  it('rejects a damaged capability receipt that changes one installed Skill into zero', async () => {
    const { env } = getCurrentSourceTestIsolation();
    const id = `sha256:${'a'.repeat(64)}`;
    const input: PlatformInputEvidence = { schemaVersion: 1, kind: 'aw-platform-input', platform: 'cursor', units: [],
      plugin: { sourceId: 'local', sourceIdentity: id, pluginId: 'local/mixed', version: '1.0.0' },
      binding: { id, physicalKey: id, scope: { kind: 'user' } } };
    const gaps = [{ id: 'hook:miss', kind: 'hook' as const, reasonCode: 'delivery-unavailable',
      requiredFeatures: [{ feature: 'component.kind.hook' }] }];
    const state = { ...input, kind: 'aw-platform-empty-state' as const, result: 'capability-gaps' as const,
      gaps, installedComponentIds: ['skill:demo'] };
    await writePlatformEmptyState({ state, env });
    expect(await readPlatformDeliveryState({ input, env })).toEqual({ result: 'capability-gaps', gaps, installedComponentIds: ['skill:demo'] });
    const file = path.join(env.AW_HOME!, 'platforms', 'cursor', 'empty-state', `${id.slice(7)}.json`);
    const record = await fs.readJson(file);
    await fs.writeJson(file, { ...record, installedComponentIds: [] });
    expect(await readPlatformDeliveryState({ input, env })).toBeUndefined();
    delete record.deliveryDigest;
    await fs.writeJson(file, record);
    expect(await readPlatformDeliveryState({ input, env })).toBeUndefined();
  });

  // Test Value Gate: a different entry or native inventory must not invalidate a package when the actual renderer inputs agree.
  it('keeps observation and discovery metadata from invalidating a dynamic package', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'grok-input');
    const manifestPath = path.join(rootDir, '.agents-plugin/plugin.json');
    const plugin: PluginMeta = { rootDir, manifestPath, pluginId: 'local/input', sourceId: 'local', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      manifest: { schemaVersion: 4, name: 'input', version: '1.0.0', description: 'Input', platforms: ['grok'],
        marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        artifacts: { configKeys: ['enabled'], scopes: ['user'] },
        config: { schemaVersion: 5, fields: { enabled: { type: 'boolean', default: false } }, platforms: {} },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    await fs.outputFile(path.join(rootDir, 'render.mjs'), 'throw new Error("must not execute");\n');
    const adapter = getAgentPluginAdapter('grok');
    const ctx = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const resolution = await adapter.resolve(ctx, { plugin: { sourceId: 'local', sourceIdentity: plugin.sourceIdentity!,
      pluginId: plugin.pluginId!, version: '1.0.0' }, scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
      discovery: { platform: 'grok', availability: 'available', diagnostics: [], installations: [{ id: 'grok', product: 'cli',
        availability: 'available', version: '1.0.77', reasonCodes: [], entry: { kind: 'cli', executable: path.join(ctx.cwd, 'grok'),
          configRoot: path.join(isolation.env.HOME!, '.grok') } }] } });
    const binding = resolution.bindings[0]!;
    const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent',
      consumers: [], components: [], nativeIdentity: null, diagnostics: [], prerequisites: {
        agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] },
        nativeSources: { observation: 'complete', sources: [], overlaps: [], configurationEvidence: 'before-install' },
      } };
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'input', sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'grok', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
    })));
    const profile = getQualifiedPlatformProfile('grok', { platform: 'linux', arch: 'x64' });
    const digest = async () => platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding,
      units: units.map((unit) => ({ ...unit, capabilities: adapter.capabilities({ binding, renderUnit: unit.renderUnit, observation, profile }) })) }));
    const before = await digest();
    observation.prerequisites.nativeSources = { observation: 'complete', overlaps: [], configurationEvidence: 'new-native-copy-and-cwd',
      sources: [{ name: 'input', version: '1.0.1', path: path.join(ctx.cwd, 'native'), scope: 'user', origin: 'native', enabled: true,
        effectiveComponents: ['skills:input'] }] };
    const fullObservation = structuredClone(observation);
    expect(await digest()).toBe(before);
    expect(observation).toEqual(fullObservation);
    profile.id = 'different-qualification-baseline';
    for (const { renderUnit } of units) {
      const first = renderUnit.consumers[0]!;
      renderUnit.consumers = [
        { ...first, id: 'grok-wrapper', version: '1.0.82', entry: { kind: 'cli', executable: path.join(ctx.cwd, 'wrapper'), configRoot: first.entry!.configRoot } },
        { ...first, id: 'different-entry', version: '1.0.83' },
      ];
    }
    expect(await digest()).toBe(before);
    for (const { renderUnit } of units) renderUnit.consumers.reverse();
    observation.prerequisites.agentConsumers.configurationEvidence = 'different-local-observation';
    expect(await digest()).toBe(before);
    for (const unit of units) unit.config.values.enabled = true;
    expect(await digest()).not.toBe(before);
    for (const unit of units) unit.config.values.enabled = false;
    profile.kinds.skill = { ...profile.kinds.skill, status: 'unverified', reasonCodes: ['capability-unverified'] };
    expect(await digest()).not.toBe(before);
  });

  // Test Value Gate: empty state is reusable only for the complete current source/config/capability/scope inputs, including multiple render units.
  it('matches only the exact binding and input bytes, without running a renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'plugin');
    const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json');
    await fs.outputFile(path.join(rootDir, 'render.mjs'), 'throw new Error("must not execute");\n');
    const plugin: PluginMeta = { rootDir, manifestPath, pluginId: 'local/empty', sourceId: 'local', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      manifest: { schemaVersion: 4, name: 'empty', version: '1.0.0', description: 'Empty', platforms: ['codex'],
        marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        artifacts: { configKeys: ['enabled'], scopes: ['user'] },
        command: { sourceDir: './commands', platforms: ['codex'], mode: 'dynamic', refreshKeys: ['commandMode'] },
        extensions: { permissions: [{ name: 'exports', allow: [{ argsPrefix: ['export'] }] }] },
        config: { schemaVersion: 5, fields: { enabled: { type: 'boolean', default: false },
          commandMode: { type: 'string', default: 'old' }, otherMode: { type: 'string', default: 'other' } }, platforms: {} },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    const adapter = getAgentPluginAdapter('codex');
    const ctx = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const resolution = await adapter.resolve(ctx, { plugin: { sourceId: 'local', sourceIdentity: plugin.sourceIdentity!,
      pluginId: plugin.pluginId!, version: '1.0.0' }, scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
      discovery: { platform: 'codex', availability: 'available', diagnostics: [], installations: [{ id: 'fixture-codex', product: 'cli',
        availability: 'available', version: '0.155.0', reasonCodes: [], entry: { kind: 'cli', executable: '/fixture/codex', configRoot: isolation.env.CODEX_HOME! } }] } });
    const binding = resolution.bindings[0]!;
    const live: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent', consumers: [], components: [],
      nativeIdentity: null, diagnostics: [], prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } } };
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, observation: live, profile: getQualifiedPlatformProfile('codex') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'empty', sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
    })));
    const state = await createPlatformEmptyState({ plugin, binding, units });
    expect(state.units).toHaveLength(2);
    const packageDigest = platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding, units }));
    const project = await adapter.resolve(ctx, { plugin: binding.plugin, scope: { kind: 'project', projectRoot: ctx.cwd }, operation: 'ensure',
      recoveryCandidates: [], discovery: { platform: 'codex', availability: 'available', diagnostics: [], installations: binding.consumers } });
    const projectBinding = project.bindings[0]!;
    const projectUnits = await Promise.all(project.renderUnits.map(async (renderUnit) => ({ renderUnit,
      capabilities: adapter.capabilities({ binding: projectBinding, renderUnit, observation: live, profile: getQualifiedPlatformProfile('codex') }),
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'empty', sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
    })));
    const projectEvidence = await createPlatformInputEvidence({ plugin, binding: projectBinding, units: projectUnits });
    expect(projectEvidence.binding.id).not.toBe(state.binding.id);
    expect(platformPackageInputDigest(projectEvidence)).toBe(packageDigest);
    expect(await matchesPlatformEmptyState({ state, env: ctx.env })).toBe(false);
    await writePlatformEmptyState({ state, env: ctx.env });
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units }), env: ctx.env })).toBe(true);
    await expect(createPlatformEmptyState({ plugin, binding, units: units.slice(0, 1) })).rejects.toThrow('platformEmptyStateIdentityInvalid');
    const changedScope = { ...state, binding: { ...state.binding, scope: { kind: 'project' as const, projectRoot: ctx.cwd } } };
    expect(await matchesPlatformEmptyState({ state: changedScope, env: ctx.env })).toBe(false);
    const changedCapabilities = structuredClone(units);
    changedCapabilities[0]!.capabilities.kinds.skill = { status: 'unsupported', delivery: [], reasonCodes: ['policy-blocked'] };
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units: changedCapabilities }), env: ctx.env })).toBe(false);
    const changedConfig = structuredClone(units);
    changedConfig[0]!.config.values.enabled = true;
    expect(platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding, units: changedConfig }))).not.toBe(packageDigest);
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units: changedConfig }), env: ctx.env })).toBe(false);
    const commandConfig = structuredClone(units);
    for (const unit of commandConfig) unit.config.values.commandMode = 'saved';
    const commandState = await createPlatformEmptyState({ plugin, binding, units: commandConfig });
    expect(await matchesPlatformEmptyState({ state: commandState, env: ctx.env })).toBe(true);
    const routes = normalizeCommandRoutes({ subcommands: [{ name: 'message', runner: 'node', entry: 'message.mjs' }] });
    const skillState = await createPlatformEmptyState({ plugin, binding, units, commandRoutes: routes });
    for (const unit of units) {
      expect(skillState.units.find((entry) => entry.id === unit.renderUnit.id)!.inputDigest === state.units.find((entry) => entry.id === unit.renderUnit.id)!.inputDigest)
        .toBe(!unit.renderUnit.kinds.includes('skill'));
    }
    const allowRoutes = normalizeCommandRoutes({ subcommands: [{ name: 'export', runner: 'node', entry: 'export.mjs' }] });
    const allowState = await createPlatformEmptyState({ plugin, binding, units, commandRoutes: allowRoutes });
    for (const unit of units) {
      expect(allowState.units.find((entry) => entry.id === unit.renderUnit.id)!.inputDigest === skillState.units.find((entry) => entry.id === unit.renderUnit.id)!.inputDigest)
        .toBe(unit.renderUnit.output !== 'package');
    }
    const otherConfig = structuredClone(units);
    for (const unit of otherConfig) unit.config.values.otherMode = 'saved';
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units: otherConfig }), env: ctx.env })).toBe(true);
    await fs.writeFile(path.join(rootDir, 'render.mjs'), 'throw new Error("different source bytes");\n');
    expect(await matchesPlatformEmptyState({ state: await createPlatformEmptyState({ plugin, binding, units }), env: ctx.env })).toBe(false);
  });

  // Test Value Gate: only capability facts that affect static delivery mark its inputs stale.
  it('tracks static resource bytes, writer support and explicit cross-kind prerequisites', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'static-platform');
    const manifestPath = path.join(rootDir, '.agents-plugin/plugin.json');
    const plugin: PluginMeta = { rootDir, manifestPath, pluginId: 'local/static', sourceId: 'local', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      manifest: { schemaVersion: 4, name: 'static', version: '1.0.0', description: 'Static', platforms: ['codex'], skills: './skills',
        marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    const skill = path.join(rootDir, 'skills/demo/SKILL.md');
    await fs.outputFile(skill, '---\nname: demo\ndescription: Demo\ndisable-model-invocation: true\n---\nRead me.\n');
    const attachment = path.join(rootDir, 'skills/demo/attachment.bin');
    await fs.outputFile(attachment, Buffer.from([0xff, 0x01]));
    const adapter = getAgentPluginAdapter('codex');
    const ctx = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const resolution = await adapter.resolve(ctx, { plugin: { sourceId: 'local', sourceIdentity: plugin.sourceIdentity!,
      pluginId: plugin.pluginId!, version: '1.0.0' }, scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
      discovery: { platform: 'codex', availability: 'available', diagnostics: [], installations: [{ id: 'codex', product: 'cli',
        availability: 'available', version: '0.167.0', reasonCodes: [], entry: { kind: 'cli', executable: '/fixture/codex',
          configRoot: isolation.env.CODEX_HOME! } }] } });
    const binding = resolution.bindings[0]!;
    const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent',
      consumers: [], components: [], nativeIdentity: null, diagnostics: [], prerequisites: {
        agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] },
      } };
    const profile = getQualifiedPlatformProfile('codex', { platform: 'linux', arch: 'x64' });
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
    })));
    const digest = async () => platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding,
      units: units.map((unit) => ({ ...unit, capabilities: adapter.capabilities({ binding, renderUnit: unit.renderUnit, observation, profile }) })) }));
    const before = await digest();
    await fs.outputFile(path.join(rootDir, 'unrelated.txt'), 'surplus bundle data');
    const modelInvocation = profile.skillInvocation!.features.find(({ feature }) => feature === 'skill.invocation.model')!;
    modelInvocation.values = ['false'];
    profile.kinds.agent = { status: 'unverified', reasonCodes: ['capability-unverified'], delivery: [] };
    expect(await digest()).toBe(before);
    await fs.appendFile(skill, 'Changed Skill instructions.\n');
    const afterBody = await digest();
    expect(afterBody).not.toBe(before);
    await fs.writeFile(attachment, Buffer.from([0xff, 0x02]));
    const afterAttachment = await digest();
    expect(afterAttachment).not.toBe(afterBody);
    modelInvocation.values = ['true'];
    profile.kinds.skill = { ...profile.kinds.skill, status: 'unverified', reasonCodes: ['capability-unverified'] };
    expect(await digest()).toBe(afterAttachment);
    profile.kinds.skill.delivery = [];
    expect(await digest()).not.toBe(afterAttachment);

    plugin.manifest.extensions = { hooks: [{ id: 'announce', event: 'session_start', feedback: 'notify', command: 'echo ready',
      requires: [{ feature: 'component.kind.agent' }] }] };
    const withoutAgent = await digest();
    // The Hook writer has no Agent output. The host still must satisfy its explicit prerequisite.
    profile.kinds.agent = { status: 'supported', reasonCodes: [], delivery: [] };
    expect(await digest()).not.toBe(withoutAgent);
  });
});
