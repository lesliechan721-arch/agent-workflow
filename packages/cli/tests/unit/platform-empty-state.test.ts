import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizeCommandRoutes } from '@lesliechan721/aw-plugin-core/manifest';

import { createPlatformEmptyState, createPlatformInputEvidence, matchesPlatformEmptyState, platformPackageInputDigest, readPlatformDeliveryState, writePlatformEmptyState, type PlatformInputEvidence } from '../../src/utils/platform-empty-state.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import type { PluginMeta } from '../../src/types.js';
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

  // Test Value Gate: a different discovery entry or profile identity must not invalidate a package when the actual renderer inputs agree.
  it('keeps discovery and profile metadata from invalidating a dynamic package', async () => {
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
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'input', sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'grok', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
    })));
    const profile = getQualifiedPlatformProfile('grok');
    const digest = async () => platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding,
      units: units.map((unit) => ({ ...unit, capabilities: adapter.capabilities({ binding, renderUnit: unit.renderUnit, profile }) })) }));
    const before = await digest();
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
    expect(await digest()).toBe(before);
    for (const unit of units) unit.config.values.enabled = true;
    expect(await digest()).not.toBe(before);
    for (const unit of units) unit.config.values.enabled = false;
    profile.kinds.skill = { ...profile.kinds.skill, status: 'unsupported', reasonCodes: ['interface-unsupported'] };
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
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('codex') }),
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
      capabilities: adapter.capabilities({ binding: projectBinding, renderUnit, profile: getQualifiedPlatformProfile('codex') }),
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
    changedCapabilities[0]!.capabilities.kinds.skill = { status: 'unsupported', delivery: [], reasonCodes: ['delivery-unavailable'] };
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

  // Codex user-rendered Skills depend on the complete User Agent view even though roles live in a supplement.
  it('keeps the shared package digest independent of Project supplements while tracking Agent delivery inputs', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'agent-input');
    const manifestPath = path.join(rootDir, '.agents-plugin/plugin.json');
    const plugin: PluginMeta = { rootDir, manifestPath, pluginId: 'local/agent-input', sourceId: 'local',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      manifest: { schemaVersion: 4, name: 'agent-input', version: '1.0.0', description: 'Agent input', platforms: ['codex'],
        skills: './skills', requires: { aw: { capabilities: ['aw.skill-agent-placeholder.v1'] } },
        extensions: { agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review the changes.',
          agentOverrides: { codex: { name: 'renamed-reviewer' } } }] },
        config: { schemaVersion: 5, fields: { agentMode: { type: 'string', sensitive: true } }, platforms: {} },
        marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    await fs.outputFile(path.join(rootDir, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nSee the reference.\n');
    const reference = path.join(rootDir, 'skills/demo/references/usage.md');
    await fs.outputFile(reference, 'Use {{aw.agent:reviewer}}.\n', { mode: 0o755 });
    const adapter = getAgentPluginAdapter('codex');
    const ctx = { cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const discovery = { platform: 'codex' as const, availability: 'available' as const, diagnostics: [], installations: [
      { id: 'fixture-codex', product: 'cli' as const, availability: 'available' as const, version: '0.167.0', reasonCodes: [],
        entry: { kind: 'cli' as const, executable: '/fixture/codex', configRoot: isolation.env.CODEX_HOME! } },
    ] };
    const resolve = async (scope: 'user' | 'project') => {
      const resolution = await adapter.resolve(ctx, { plugin: { sourceId: 'local', sourceIdentity: plugin.sourceIdentity!,
        pluginId: plugin.pluginId!, version: '1.0.0' }, scope: scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: ctx.cwd },
        operation: 'ensure', recoveryCandidates: [], discovery });
      const binding = resolution.bindings[0]!;
      const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({
        renderUnit, capabilities: adapter.capabilities({ binding, renderUnit, profile: getQualifiedPlatformProfile('codex') }),
        config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, pluginName: 'agent-input', sourceId: 'local',
          sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
      })));
      return { plugin, binding, units };
    };
    const user = await resolve('user');
    const project = await resolve('project');
    const evidence = () => Promise.all([user, project].map((input) => createPlatformInputEvidence(input)));
    const [userStatic, projectStatic] = await evidence();
    const staticDigest = platformPackageInputDigest(userStatic!);
    expect(platformPackageInputDigest(projectStatic!)).toBe(staticDigest);
    const agent = plugin.manifest.extensions!.agents![0]!;
    agent.agentOverrides!.codex!.name = 'another-reviewer';
    const renamed = platformPackageInputDigest(await createPlatformInputEvidence(user));
    expect(renamed).not.toBe(staticDigest);
    agent.tools = [];
    const unmet = platformPackageInputDigest(await createPlatformInputEvidence(user));
    expect(unmet).not.toBe(renamed);
    // The Skill is now a complete gap, but changed Agent delivery inputs must still invalidate its evidence.
    agent.agentOverrides!.codex!.name = 'unavailable-reviewer';
    expect(platformPackageInputDigest(await createPlatformInputEvidence(user))).not.toBe(unmet);
    delete agent.tools;
    await fs.writeFile(reference, 'Use {{aw.agent:missing}}.\n');
    await expect(createPlatformInputEvidence(user)).rejects.toThrow('agentReferenceInvalid');
    await fs.writeFile(reference, 'Use {{aw.agent:reviewer}}.\n');

    // The reference namespace is only a concern when a Skill actually uses it.
    const originalAgents = plugin.manifest.extensions!.agents!;
    plugin.manifest.extensions!.agents = [...originalAgents,
      { name: '审阅员', description: 'Review.', prompt: 'Read.', agentOverrides: { codex: { name: 'extra-reviewer' } } },
    ];
    const [userWithIndependent, projectWithIndependent] = await evidence();
    expect(platformPackageInputDigest(projectWithIndependent!)).toBe(platformPackageInputDigest(userWithIndependent!));
    plugin.manifest.extensions!.agents = [
      { name: '审阅员', description: 'Review.', prompt: 'Read.', agentOverrides: { codex: { name: 'reviewer' } } },
      { name: 'audit.role', description: 'Review.', prompt: 'Read.', agentOverrides: { codex: { name: 'audit-one' } } },
      { name: 'audit-role', description: 'Review.', prompt: 'Read.', agentOverrides: { codex: { name: 'audit-two' } } },
    ];
    await fs.writeFile(reference, 'Independent Skill.\n');
    await expect(createPlatformInputEvidence(user)).resolves.toMatchObject({ kind: 'aw-platform-input' });
    plugin.manifest.extensions!.agents = plugin.manifest.extensions!.agents.slice(1);
    await fs.writeFile(reference, 'Use {{aw.agent:audit-role}}.\n');
    await expect(createPlatformInputEvidence(user)).rejects.toThrow(/agentReferenceInvalid: ambiguous Agent/u);
    plugin.manifest.extensions!.agents = originalAgents;
    await fs.writeFile(reference, 'Use {{aw.agent:reviewer}}.\n');

    // Dynamic User Agent configuration participates in the shared package whether or not a User supplement exists.
    plugin.manifest.artifacts = { configKeys: ['agentMode'] };
    plugin.manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    await fs.outputFile(path.join(rootDir, 'render.mjs'), 'throw new Error("must not execute");\n');
    const dynamicUser = await resolve('user');
    const dynamicProject = await resolve('project');
    for (const { units } of [dynamicUser, dynamicProject]) {
      for (const unit of units) unit.config.values.agentMode = unit.renderUnit.renderScope.kind === 'user' ? 'user-agent' : 'project-agent';
    }
    const userOnly = await createPlatformInputEvidence(dynamicUser);
    const projectOnly = await createPlatformInputEvidence(dynamicProject);
    const packageDigest = platformPackageInputDigest(userOnly);
    expect(platformPackageInputDigest(projectOnly)).toBe(packageDigest);
    // Combine the shared physical unit with both activation-local supplements, as a joint preparation does.
    const allUnits = [...new Map([...dynamicUser.units, ...dynamicProject.units].map((unit) => [unit.renderUnit.id, unit])).values()];
    expect(allUnits).toHaveLength(3);
    const both = async () => Promise.all([dynamicUser, dynamicProject].map((input) => createPlatformInputEvidence({
      ...input, units: allUnits.filter(({ renderUnit }) => input.binding.renderUnitIds.includes(renderUnit.id)),
    })));
    for (const input of await both()) expect(platformPackageInputDigest(input)).toBe(packageDigest);
    const projectSupplement = allUnits.find(({ renderUnit }) => renderUnit.renderScope.kind === 'project')!;
    projectSupplement.config.values.agentMode = 'changed-project-agent';
    projectSupplement.capabilities.kinds.agent = { status: 'unsupported', delivery: [], reasonCodes: ['interface-unsupported'] };
    const [jointUser, jointProject] = await both();
    expect(platformPackageInputDigest(jointUser!)).toBe(packageDigest);
    expect(platformPackageInputDigest(jointProject!)).toBe(packageDigest);
    expect(jointUser).toEqual(userOnly);
    expect(jointProject!.units.find(({ output }) => output === 'supplement')!.inputDigest)
      .not.toBe(projectOnly.units.find(({ output }) => output === 'supplement')!.inputDigest);
    const sharedPackage = allUnits.find(({ renderUnit }) => renderUnit.output === 'package')!;
    sharedPackage.config.values.agentMode = 'changed-user-agent';
    for (const input of await both()) expect(platformPackageInputDigest(input)).not.toBe(packageDigest);
  });

  // Test Value Gate: only capability facts that affect static delivery mark its inputs stale.
  it('tracks static resource bytes, command invocation, writer support and explicit cross-kind prerequisites', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const rootDir = path.join(isolation.layout.fixtureCwd, 'static-platform');
    const manifestPath = path.join(rootDir, '.agents-plugin/plugin.json');
    const commandRoutes = normalizeCommandRoutes({ subcommands: [{ name: 'read', runner: 'node', entry: 'read.mjs' }] });
    const plugin: PluginMeta = { rootDir, manifestPath, pluginId: 'local/static', sourceId: 'local', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      manifest: { schemaVersion: 4, name: 'static', version: '1.0.0', description: 'Static', platforms: ['codex'], skills: './skills',
        command: { sourceDir: './commands', platforms: ['codex'], mode: 'static', routes: commandRoutes },
        config: { schemaVersion: 5, fields: { mode: { type: 'string' } }, platforms: {} },
        requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
        marketplace: { category: 'development', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } } };
    await fs.outputJson(manifestPath, plugin.manifest);
    const skill = path.join(rootDir, 'skills/demo/SKILL.md');
    await fs.outputFile(skill, '---\nname: demo\ndescription: Demo\ndisable-model-invocation: true\n---\nRun `{{aw.command}} read`.\n');
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
    const profile = getQualifiedPlatformProfile('codex');
    const units = await Promise.all(resolution.renderUnits.map(async (renderUnit) => ({ renderUnit,
      config: await resolveArtifactRenderConfig({ manifest: plugin.manifest, sourceId: 'local',
        sourceIdentity: plugin.sourceIdentity, platform: 'codex', scope: renderUnit.renderScope.kind, cwd: ctx.cwd, env: ctx.env }),
    })));
    const digest = async () => platformPackageInputDigest(await createPlatformInputEvidence({ plugin, binding, commandRoutes,
      units: units.map((unit) => ({ ...unit, capabilities: adapter.capabilities({ binding, renderUnit: unit.renderUnit, profile }) })) }));
    const before = await digest();
    // Runtime configuration changes the command in the delivered Skill even at the same version.
    plugin.manifest.command!.runtimeConfig = { keys: ['mode'] };
    expect(await digest()).not.toBe(before);
    delete plugin.manifest.command!.runtimeConfig;
    await fs.outputFile(path.join(rootDir, 'unrelated.txt'), 'surplus bundle data');
    const modelInvocation = profile.features['skill.invocation.model']!;
    modelInvocation.values = ['false'];
    profile.kinds.agent = { status: 'unsupported', reasonCodes: ['interface-unsupported'], delivery: [] };
    expect(await digest()).toBe(before);
    await fs.appendFile(skill, 'Changed Skill instructions.\n');
    const afterBody = await digest();
    expect(afterBody).not.toBe(before);
    await fs.writeFile(attachment, Buffer.from([0xff, 0x02]));
    const afterAttachment = await digest();
    expect(afterAttachment).not.toBe(afterBody);
    modelInvocation.values = ['true'];
    profile.kinds.skill = { ...profile.kinds.skill, status: 'unsupported', reasonCodes: ['interface-unsupported'] };
    expect(await digest()).not.toBe(afterAttachment);
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
