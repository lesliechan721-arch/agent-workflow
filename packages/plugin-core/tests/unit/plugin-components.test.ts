import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAgentCommandContext, assertPlatformCapabilities, assertPlatformComponentPlan, assertPlatformRenderContext,
  COMPONENT_KINDS, getHookHandlerContract, getComponentFeatureRequirements, getUnmetFeatureRequirements, normalizeStaticPluginComponents,
  partitionStaticPluginComponents, PLATFORM_FEATURE_REGISTRY, validatePluginManifest,
  type PlatformCapabilitiesV1, type PlatformComponentPlanV3, type PlatformRenderContextV1, type PluginComponent,
} from '../../src/manifest.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
function capabilities(): PlatformCapabilitiesV1 {
  return { schemaVersion: 1, platform: 'codex', scope: 'user', basis: 'profile', profileId: 'test-qualified', consumers: [],
    kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV1['kinds'],
    features: Object.fromEntries(Object.values(PLATFORM_FEATURE_REGISTRY).filter((entry) => !entry.id.startsWith('hook.native.') && entry.id !== 'hook.matcher' && !entry.derivedFromKind).map((entry) => [entry.id, { status: 'supported', reasonCodes: [], ...(entry.values ? { values: entry.id.startsWith('hook.common.') ? entry.values.filter((feedback) => Object.hasOwn(getHookHandlerContract('codex', 'common', entry.id.slice('hook.common.'.length)).protocol!.responses, feedback)) : [...entry.values] } : {}) }])),
  };
}
function plan(components: PluginComponent[]): PlatformComponentPlanV3 { return { version: 3, components, omitted: [], unmet: [] }; }
function assertPlan(value: unknown, profile = capabilities()): void {
  assertPlatformComponentPlan(value, { platform: 'codex', scope: 'user', allowedOutputKinds: COMPONENT_KINDS, platformCapabilities: profile });
}
const hook: PluginComponent = { id: 'guard', kind: 'hook', name: 'guard', content: { dialect: 'common', event: 'before_tool', feedback: 'block', command: 'node guard.mjs' } };
const instruction: PluginComponent = { id: 'rules', kind: 'instruction', name: 'rules', content: { title: 'Rules', content: 'Check the result.', coverage: ['main', 'plugin-agents'] } };
const skillText = '---\nname: check\ndescription: Check files.\n---\nCheck the files.\n';
const skill: Extract<PluginComponent, { kind: 'skill' }> = { id: 'new-skill', kind: 'skill', name: 'check', content: { files: { 'SKILL.md': { text: skillText } } } };

describe('platform component contract', () => {
  it('accepts dynamic IDs and all five categories without manifest targets', () => {
    assertPlan(plan([skill, hook, instruction, { id: 'transport', kind: 'mcp', name: 'transport', content: { type: 'http', url: 'https://example.test/mcp' } }, { id: 'role', kind: 'agent', name: 'reviewer', content: { description: 'Review files.', prompt: 'Read the change.', tools: [] } }]));
    assertPlan(plan([]));
  });
  it('retains missing Hook feedback and rejects an actual component that cannot block', () => {
    const profile = capabilities(); profile.features['hook.common.before_tool'] = { status: 'supported', reasonCodes: [], values: ['notify'] };
    expect(getUnmetFeatureRequirements(getComponentFeatureRequirements(hook), profile)).toEqual([{ feature: 'hook.common.before_tool', values: ['block'] }]);
    expect(() => assertPlan(plan([hook]), profile)).toThrow(/unsupported required features/u);
    const unmet = { id: 'guard', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }], reasonCode: 'interface-unsupported' };
    assertPlan({ ...plan([]), unmet: [unmet] }, profile);
    assertPlan({ ...plan([]), unmet: [{ ...unmet, requiredFeatures: [{ values: ['block'], feature: 'hook.common.before_tool' }] }] }, profile);
    expect(() => assertPlan({ ...plan([]), unmet: [{ ...unmet, requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['notify', 'block'] }] }] }, profile)).toThrow(/supported values/u);
  });
  it('splits only Instruction coverage and keeps the exact missing audience and link', () => {
    const profile = capabilities(); profile.features['instruction.coverage'] = { status: 'supported', reasonCodes: [], values: ['main'] };
    const result = partitionStaticPluginComponents([instruction], profile);
    expect(result.components).toMatchObject([{ id: 'rules', content: { coverage: ['main'] } }]);
    expect(result.unmet).toEqual([{ id: 'rules:coverage-gap', kind: 'instruction', name: 'rules', componentId: 'rules', requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }], reasonCode: 'interface-unsupported' }]);
    assertPlan({ ...plan(result.components), unmet: result.unmet }, profile);
    profile.features['agent.tools'] = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
    expect(partitionStaticPluginComponents([{ id: 'restricted', kind: 'agent', name: 'restricted', content: { description: 'Role', prompt: 'Read.', tools: [] } }], profile)).toMatchObject({ components: [], unmet: [{ id: 'restricted', requiredFeatures: [{ feature: 'agent.tools', values: ['none'] }] }] });
  });
  it('derives Agent model, no-tools and prompt combination requirements from content', () => {
    expect(getComponentFeatureRequirements({ id: 'role', kind: 'agent', name: 'role', content: { description: 'Role', prompt: 'Read.', model: 'chosen-model', tools: [], promptMode: 'replace' } })).toEqual([{ feature: 'component.kind.agent' }, { feature: 'agent.execution', values: ['isolated-context'] }, { feature: 'agent.prompt-mode', values: ['replace'] }, { feature: 'agent.model' }, { feature: 'agent.tools', values: ['none'] }]);
  });
  it('rejects removed fields, repeated identities, unregistered requirements and out-of-batch output', () => {
    for (const extra of [{ target: 'codex.skill' }, { platform: 'claude' }, { state: 'disabled' }, { destination: '/tmp/host' }]) expect(() => assertPlan(plan([{ ...skill, ...extra }]))).toThrow();
    expect(() => assertPlan({ ...plan([skill]), omitted: [{ id: skill.id, kind: 'skill', reason: 'not-offered' }] })).toThrow(/duplicate component ID/u);
    expect(() => assertPlatformComponentPlan(plan([hook]), { platform: 'codex', allowedOutputKinds: ['skill'], platformCapabilities: capabilities() })).toThrow(/outside allowedOutputKinds/u);
    expect(() => assertPlan(plan([{ ...skill, id: 'command-set.check' }]))).toThrow(/component ID/u);
    for (const requires of [[{ feature: 'future.unknown' }], [{ feature: 'hook.common.before_tool', values: ['invented'] }]]) expect(() => assertPlan(plan([{ ...hook, requires }]))).toThrow();
    const unmet = { id: 'role', kind: 'agent', requiredFeatures: [], reasonCode: 'dependency-unmet' };
    assertPlan({ ...plan([]), unmet: [unmet] });
    expect(() => assertPlan({ ...plan([]), unmet: [{ ...unmet, reasonCode: 'invented' }] })).toThrow(/unknown unmet reason/u);
    expect(() => assertPlan({ ...plan([]), unmet: [{ ...unmet, reasonCode: 'consumer-missing' }] })).toThrow(/concrete features/u);
  });
  it('checks source permissions, reserved runtime files and path escapes', () => {
    const sourceSkill: PluginComponent = { ...skill, content: { files: { 'SKILL.md': { source: { kind: 'bundle', path: './templates/SKILL.md' } } } } };
    assertPlatformComponentPlan(plan([sourceSkill]), { platform: 'codex', allowedOutputKinds: ['skill'], platformCapabilities: capabilities(), sourceDirs: ['./templates'] });
    expect(() => assertPlan(plan([sourceSkill]))).toThrow(/outside declared inputs/u);
    for (const file of ['../escape', '/host/file', 'scripts/aw-runtime-config.mjs', '.aw-runtime-config.json']) expect(() => assertPlan(plan([{ ...skill, content: { files: { ...skill.content.files, [file]: { text: 'bad' } } } }]))).toThrow();
  });
  it('checks registered values and treats missing features as unsupported', () => {
    const profile = capabilities(); delete profile.features['mcp.transport'];
    expect(getUnmetFeatureRequirements([{ feature: 'mcp.transport', values: ['sse'] }], profile)).toEqual([{ feature: 'mcp.transport', values: ['sse'] }]);
    for (const features of [{ future: { status: 'supported', reasonCodes: [] } }, { 'mcp.transport': { status: 'supported', reasonCodes: [], values: ['invented'] } }]) expect(() => assertPlatformCapabilities({ ...profile, features })).toThrow();
  });
  it('retains observed consumer scope, unknown settings and evidence without adding qualification defaults', () => {
    const profile = capabilities();
    profile.consumers = [{ id: 'pi-cli', product: 'cli', version: '1.5.0', agentConsumers: [{
      id: 'pi-subagents', version: null, enabled: 'unknown', packageAccess: 'unknown', scope: 'project', trust: 'unknown',
      settings: { promptMode: 'unknown', loadExtensions: 'host-default' }, configurationEvidence: `sha256:${'a'.repeat(64)}`,
    }] }];
    const original = structuredClone(profile);
    assertPlatformCapabilities(profile);
    expect(profile).toEqual(original);
    profile.consumers[0]!.agentConsumers![0]!.configurationEvidence = '/host/private/settings.json';
    expect(() => assertPlatformCapabilities(profile)).toThrow();
  });
  it('derives kind gaps from the three-state kind fact, including generic, without independent overrides', () => {
    for (const status of ['supported', 'unsupported', 'unverified'] as const) {
      const profile = capabilities(); profile.kinds.skill = { status, reasonCodes: status === 'unverified' ? ['capability-unverified'] : status === 'unsupported' ? ['interface-unsupported'] : [], delivery: [] };
      const result = partitionStaticPluginComponents([skill], profile);
      expect(result.components.length).toBe(status === 'supported' ? 1 : 0);
      expect(result.unmet).toEqual(status === 'supported' ? [] : [{ id: skill.id, kind: 'skill', name: skill.name, requiredFeatures: [{ feature: 'component.kind.skill' }], reasonCode: status === 'unverified' ? 'capability-unverified' : 'interface-unsupported' }]);
      if (status !== 'supported') expect(() => assertPlan(plan([skill]), profile)).toThrow();
    }
    const generic = capabilities(); generic.platform = 'generic'; generic.features = Object.fromEntries(Object.entries(generic.features).filter(([id]) => !id.startsWith('hook.'))); generic.kinds.agent = { status: 'unsupported', reasonCodes: ['interface-unsupported'], delivery: [] };
    expect(partitionStaticPluginComponents([{ id: 'role', name: 'role', kind: 'agent', content: { description: 'Role', prompt: 'Read.' } }], generic).unmet[0]?.requiredFeatures).toEqual([{ feature: 'component.kind.agent' }]);
    expect(() => assertPlatformCapabilities({ ...generic, features: { ...generic.features, 'component.kind.agent': { status: 'supported', reasonCodes: [] } } })).toThrow();
  });
  it('gates every declared Skill behavior field and keeps static deficits concrete', () => {
    const text = '---\nname: check\ndescription: Check files.\nallowed-tools: [Read]\ndisallowed-tools: [Bash]\ncontext: fork\nagent: reviewer\nmodel: chosen-model\neffort: high\nbackground: true\nhooks: {PreToolUse: []}\npaths: [src/**]\nshell: bash\nwhen_to_use: review changes\narguments: file\n---\nCheck files.\n';
    const restricted: PluginComponent = { ...skill, content: { files: { 'SKILL.md': { text } } } };
    const profile = capabilities(); profile.features = {};
    const requirements = getComponentFeatureRequirements(restricted);
    expect(requirements).toEqual(expect.arrayContaining([
      { feature: 'skill.tools', values: ['allowlist', 'denylist'] }, { feature: 'skill.execution', values: ['isolated-context'] },
      { feature: 'skill.agent' }, { feature: 'skill.model' }, { feature: 'skill.effort', values: ['high'] },
      { feature: 'skill.background', values: ['true'] }, { feature: 'skill.hooks' }, { feature: 'skill.paths' },
      { feature: 'skill.shell', values: ['bash'] }, { feature: 'skill.invocation.hint' }, { feature: 'skill.arguments' },
    ]));
    expect(() => assertPlan(plan([restricted]), profile)).toThrow(/unsupported required features/u);
    expect(partitionStaticPluginComponents([restricted], profile).unmet[0]?.requiredFeatures).toEqual(requirements.filter((entry) => !entry.feature.startsWith('component.kind.')));
    assertPlan(plan([restricted]));
  });
  it('normalizes five static kinds, preserves overridden IDs, records gaps and rejects links', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-core-components-')); roots.push(root);
    await fs.ensureDir(path.join(root, 'skills/check')); await fs.writeFile(path.join(root, 'skills/check/SKILL.md'), skillText);
    await fs.writeJson(path.join(root, '.mcp.json'), { mcpServers: { remote: { type: 'http', url: 'https://example.test/mcp' } } });
    const manifest = validatePluginManifest(root, { schemaVersion: 4, name: 'example', version: '1.0.0', description: 'Example', platforms: ['codex'], skills: './skills', mcpServers: './.mcp.json', marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, extensions: {
      agents: [{ name: 'reviewer', description: 'Review', prompt: 'Read.', agentOverrides: { codex: { name: 'renamed' } } }, { name: 'disabled', description: 'Role', prompt: 'Read.', agentOverrides: { codex: null } }], hooks: [{ id: 'guard', event: 'before_tool', feedback: 'block', command: 'node guard.mjs' }], instructions: [{ name: 'rules', title: 'Rules', content: 'Check.', coverage: ['main', 'plugin-agents'] }],
    } });
    const profile = capabilities(); profile.features['instruction.coverage']!.values = ['main'];
    const result = await normalizeStaticPluginComponents({ pluginRoot: root, manifest, platform: 'codex', capabilities: profile });
    expect(result.components.map((entry) => [entry.id, entry.kind, entry.name])).toEqual([['skill:check', 'skill', 'check'], ['mcp:remote', 'mcp', 'remote'], ['agent:reviewer', 'agent', 'renamed'], ['instruction:rules', 'instruction', 'rules'], ['hook:guard', 'hook', 'guard']]);
    expect(result.omitted).toEqual([{ id: 'agent:disabled', kind: 'agent', reason: 'not-offered' }]);
    expect(result.unmet).toMatchObject([{ id: 'instruction:rules:coverage-gap', componentId: 'instruction:rules', requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }] }]);
    expect(Object.keys(result.sources)).toHaveLength(7);
    expect(() => assertPlatformComponentPlan(plan([skill]), { platform: 'codex', allowedOutputKinds: ['skill'], platformCapabilities: profile, staticComponents: result.components })).toThrow(/duplicate component name/u);
    await fs.symlink('/tmp', path.join(root, 'skills/check/escape'));
    await expect(normalizeStaticPluginComponents({ pluginRoot: root, manifest, platform: 'codex', capabilities: profile })).rejects.toThrow(/ordinary/u);
  });
});
function context(): PlatformRenderContextV1 {
  return { schemaVersion: 1, surface: 'agent-plugin', platform: 'codex', scope: 'user', plugin: { pluginId: 'test/example', name: 'example', version: '1.0.0' }, config: { schema: { schemaVersion: 5, fields: { optional: { type: 'string' } } }, values: {}, sources: { optional: 'missing' }, issues: [] }, changedConfigKeys: ['optional'], allowedOutputKinds: ['skill'], platformCapabilities: capabilities(), resources: [], previousComponents: [] };
}
describe('renderer input contract', () => {
  it('preserves missing config facts and enforces batch, whitelist and scope boundaries', () => {
    const input = context(); assertPlatformRenderContext(input);
    expect(() => assertPlatformRenderContext({ ...input, requestedArtifactIds: [] })).toThrow();
    expect(() => assertPlatformRenderContext({ ...input, platform: 'claude' })).toThrow(/mismatch/u);
    expect(() => assertPlatformRenderContext({ ...input, allowedOutputKinds: ['skill', 'agent'] })).toThrow(/separate/u);
    expect(() => assertPlatformRenderContext({ ...input, config: { ...input.config, values: { optional: 'secret' } } })).toThrow(/missing/u);
    expect(() => assertPlatformRenderContext({ ...input, previousComponents: [{ id: 'role', kind: 'agent', name: 'role' }] })).toThrow(/outside batch/u);
  });
  it('validates command-only context and requires every requested producer', () => {
    const input = context(); const command = { schemaVersion: 1, surface: 'agent-commands', platform: 'codex', scope: 'user', plugin: input.plugin, config: input.config, changedConfigKeys: [], requestedArtifactIds: ['command-set.check'], previousArtifacts: [], producers: [{ set: 'check', componentId: 'skill:check', resourceRoot: '/tmp/check' }] };
    assertAgentCommandContext(command);
    expect(() => assertAgentCommandContext({ ...command, platform: 'generic' })).toThrow();
    expect(() => assertAgentCommandContext({ ...command, platformCapabilities: input.platformCapabilities })).toThrow();
    expect(() => assertAgentCommandContext({ ...command, producers: [] })).toThrow(/one producer/u);
  });
});
