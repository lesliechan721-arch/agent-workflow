import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyStaticSkillAgentUnmet, evaluateStaticAgentRegistry, assertPlatformCapabilities, assertPlatformComponentPlan, assertPlatformRenderContext,
  CAPABILITY_REASON_CODES, COMPONENT_KINDS, getHookHandlerContract, getComponentFeatureRequirements, getMissingDeliveryRequirements, getUnmetFeatureRequirements, normalizeStaticPluginComponents,
  partitionStaticPluginComponents, PLATFORM_FEATURE_REGISTRY, validatePluginManifest,
  type PlatformCapabilitiesV3, type PlatformComponentPlanV3, type PlatformRenderContextV3, type PluginComponent,
} from '../../src/manifest.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
function capabilities(): PlatformCapabilitiesV3 {
  return { schemaVersion: 3, platform: 'codex', scope: 'user', basis: 'profile', agentNamingMode: 'aw-prefix',
    kinds: Object.fromEntries(COMPONENT_KINDS.map((kind) => [kind, { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])) as PlatformCapabilitiesV3['kinds'],
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
  it('requires the explicit capability for inline renderer Markdown before partition', () => {
    const role = '{{aw.agent:auditor}}';
    const component = { ...skill, content: { files: { ...skill.content.files, 'references/ex.md': { text: role } } } };
    const value = { ...plan([component]), omitted: [{ id: 'dynamic-id', name: 'auditor', kind: 'agent', reason: 'not-offered' }] };
    const options = { platform: 'codex' as const, allowedOutputKinds: COMPONENT_KINDS, platformCapabilities: capabilities() };
    expect(() => assertPlatformComponentPlan(value, options)).toThrow(/agentReferenceInvalid.*aw.skill-agent-placeholder.v1/u);
    expect(() => assertPlatformComponentPlan(value, { ...options, requiredAwCapabilities: ['aw.skill-agent-placeholder.v1'] })).not.toThrow();
    expect(() => assertPlan(plan([{ ...skill, content: { files: { 'SKILL.md': { text: skillText.replace('name: check', 'name: ' + role) } } } }]))).toThrow(/^agentReferenceInvalid/u);
    const unquotedMetadata = { ...skill, content: { files: { 'SKILL.md': {
      text: skillText.replace('description: Check files.', 'description: Check files.\nmetadata:\n  reviewer: ' + role),
    } } } };
    expect(() => assertPlatformComponentPlan(plan([unquotedMetadata]),
      { ...options, requiredAwCapabilities: ['aw.skill-agent-placeholder.v1'] })).toThrow(/^agentReferenceInvalid/u);
  });
  it('evaluates all static Agents for a skills-only batch and merges gaps read from executable Markdown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-agent-gap-'));
    roots.push(root);
    const manifest = validatePluginManifest(root, { schemaVersion: 4, name: 'demo', version: '1.0.0', description: 'Demo',
      skills: './skills', platforms: ['codex', 'generic'], marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      extensions: { agents: [
        { name: 'auditor', description: 'Audit.', prompt: 'Check.', tools: [], agentOverrides: { codex: { name: 'reviewer' } } },
        { name: 'writer', description: 'Write.', prompt: 'Write.', model: 'special' },
      ] } });
    const file = path.join(root, 'skills/check/references/run.md');
    await fs.outputFile(path.join(root, 'skills/check/SKILL.md'), skillText);
    await fs.outputFile(file, '{{aw.agent:AUDITOR}} {{aw.agent:writer}} {{aw.agent:writer}}', { mode: 0o755 });
    const profile = capabilities();
    expect(evaluateStaticAgentRegistry(manifest, 'codex', profile).get('auditor')).toEqual({ kind: 'deliverable', role: 'reviewer' });
    const aliases = { ...manifest, extensions: { agents: [
      manifest.extensions!.agents![0]!, { ...manifest.extensions!.agents![1]!, name: 'AUDITOR' },
    ] } };
    expect(() => evaluateStaticAgentRegistry(aliases, 'codex', profile)).toThrow(/^agentReferenceInvalid/u);
    profile.features['agent.tools'] = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
    profile.features['agent.model'] = { status: 'supported', reasonCodes: [], values: ['other'] };
    const result = await normalizeStaticPluginComponents({ pluginRoot: root, manifest, platform: 'codex', capabilities: profile, allowedOutputKinds: ['skill'] });
    expect(result.components).toEqual([]);
    expect(result.unmet).toEqual([{ id: 'skill:check', name: 'check', kind: 'skill', requiredFeatures: [{ feature: 'agent.tools', values: ['none'] }, { feature: 'agent.model' }], reasonCode: 'interface-unsupported' }]);
    Object.assign(profile, { platform: 'generic', agentNamingMode: 'unsupported', features: {} });
    for (const kind of COMPONENT_KINDS) profile.kinds[kind] = kind === 'skill' ? { delivery: ['generic-files'], status: 'supported', reasonCodes: [] }
      : { delivery: [], status: 'unsupported', reasonCodes: ['interface-unsupported'] };
    await fs.appendFile(path.join(root, 'skills/check/SKILL.md'), '{{aw.command}}');
    const command = { mode: 'static' as const, platforms: ['codex' as const], sourceDir: './command',
      routes: { subcommands: [], fallback: { runner: 'node' as const, entry: 'run.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' as const } } };
    const options = { pluginRoot: root, manifest: { ...manifest, command }, platform: 'generic' as const, capabilities: profile, allowedOutputKinds: ['skill' as const] };
    await expect(normalizeStaticPluginComponents(options)).resolves.toMatchObject({ components: [], unmet: [{ id: 'skill:check' }] });
    await expect(normalizeStaticPluginComponents({ ...options, manifest })).rejects.toThrow(/requires a command declaration/u);
    await fs.writeFile(file, 'Independent Skill.');
    await expect(normalizeStaticPluginComponents(options)).rejects.toThrow(/outside command.platforms/u);
    const body = { ...skill, content: { files: { 'SKILL.md': { text: skillText }, 'README.md': { text: '{{aw.agent:auditor}}' } } }, requires: [{ feature: 'component.kind.mcp' }] };
    const independent = { ...body, id: 'independent', name: 'ordinary', content: { files: { 'SKILL.md': { text: skillText.replace('name: check', 'name: ordinary') } } } };
    const partial = partitionStaticPluginComponents([body, independent], profile);
    const cascaded = await applyStaticSkillAgentUnmet({ expected: partial, manifest, capabilities: profile, platform: 'generic', readSource: async () => '' });
    expect(cascaded.components.map(({ id }) => id)).toEqual(['independent']);
    expect(cascaded.unmet.map(({ id }) => id)).toEqual(['independent:runtime-gap', body.id]);
    expect(cascaded.unmet[1]!.requiredFeatures).toEqual([{ feature: 'component.kind.agent' }, { feature: 'component.kind.mcp' }]);
    expect(cascaded.sources[body.id + ':runtime-gap']).toBeUndefined();
  });
  it('accepts dynamic IDs and all five categories without manifest targets', () => {
    assertPlan(plan([skill, hook, instruction, { id: 'transport', kind: 'mcp', name: 'transport', content: { type: 'http', url: 'https://example.test/mcp' } }, { id: 'role', kind: 'agent', name: 'reviewer', content: { description: 'Review files.', prompt: 'Read the change.', tools: [] } }]));
    assertPlan(plan([]));
  });
  it('accepts the Hook declaration and retains its missing blocking feedback', () => {
    const profile = capabilities(); profile.features['hook.common.before_tool'] = { status: 'supported', reasonCodes: [], values: ['notify'] };
    expect(getUnmetFeatureRequirements(getComponentFeatureRequirements(hook), profile)).toEqual([{ feature: 'hook.common.before_tool', values: ['block'] }]);
    assertPlan(plan([hook]), profile);
    const unmet = { id: 'guard', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }], reasonCode: 'interface-unsupported' };
    assertPlan({ ...plan([]), unmet: [unmet] }, profile);
    assertPlan({ ...plan([]), unmet: [{ ...unmet, requiredFeatures: [{ values: ['block'], feature: 'hook.common.before_tool' }] }] }, profile);
    expect(() => assertPlan({ ...plan([]), unmet: [{ ...unmet, requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['notify', 'block'] }] }] }, profile)).toThrow(/supported values/u);
  });
  it('binds renderer reason codes to the missing facts, including mixed local client observations', () => {
    const profile = capabilities();
    profile.basis = 'local';
    const requirement = { feature: 'component.kind.agent' };
    const gap = (reasonCode: string, requiredFeatures = [requirement]) =>
      ({ ...plan([]), unmet: [{ id: 'role', kind: 'agent', requiredFeatures, reasonCode }] });
    for (const [reasonCodes, expected] of [
      [['client-unknown'], 'client-unknown'],
      [['client-missing'], 'client-missing'],
      [['client-unknown', 'version-unsupported'], 'client-unknown'],
      [['interface-unsupported'], 'interface-unsupported'],
    ] as const) {
      profile.kinds.agent = { status: 'unsupported', delivery: [], reasonCodes: [...reasonCodes] };
      assertPlan(gap(expected), profile);
      for (const reason of ['client-unknown', 'client-missing', 'interface-unsupported', 'version-unsupported', 'config-invalid']) {
        if (reason !== expected) expect(() => assertPlan(gap(reason), profile)).toThrow(/reason/u);
      }
    }
    for (const reason of ['dependency-missing', 'dependency-unmet', 'config-missing', 'config-invalid']) {
      assertPlan(gap(reason, []), profile);
    }
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
    expect(() => assertPlan(plan([{ ...skill, id: 'command-routes' }]))).toThrow(/component ID/u);
    for (const requires of [[{ feature: 'future.unknown' }], [{ feature: 'hook.common.before_tool', values: ['invented'] }]]) expect(() => assertPlan(plan([{ ...hook, requires }]))).toThrow();
    const unmet = { id: 'role', kind: 'agent', requiredFeatures: [], reasonCode: 'dependency-unmet' };
    assertPlan({ ...plan([]), unmet: [unmet] });
    expect(() => assertPlan({ ...plan([]), unmet: [{ ...unmet, reasonCode: 'invented' }] })).toThrow(/unknown unmet reason/u);
    expect(() => assertPlan({ ...plan([]), unmet: [{ ...unmet, reasonCode: 'client-missing' }] })).toThrow(/concrete features/u);
  });
  it('checks source permissions, reserved runtime files and path escapes', () => {
    const sourceSkill: PluginComponent = { ...skill, content: { files: { 'SKILL.md': { source: { kind: 'bundle', path: './templates/SKILL.md' } } } } };
    assertPlatformComponentPlan(plan([sourceSkill]), { platform: 'codex', allowedOutputKinds: ['skill'], platformCapabilities: capabilities(), sourceDirs: ['./templates'] });
    expect(() => assertPlan(plan([sourceSkill]))).toThrow(/outside declared inputs/u);
    for (const file of ['../escape', '/host/file', 'scripts/aw-runtime-config.mjs', '.aw-runtime-config.json']) expect(() => assertPlan(plan([{ ...skill, content: { files: { ...skill.content.files, [file]: { text: 'bad' } } } }]))).toThrow();
  });
  it('rejects an inline Skill name that differs from its component name', () => {
    expect(() => assertPlan(plan([{ ...skill, name: 'renamed' }]))).toThrow(
      /SKILL\.md frontmatter\.name "check".*component "new-skill".*"renamed"/u,
    );
  });
  it('checks registered values and treats missing features as unsupported', () => {
    const profile = capabilities(); delete profile.features['mcp.transport'];
    expect(getUnmetFeatureRequirements([{ feature: 'mcp.transport', values: ['sse'] }], profile)).toEqual([{ feature: 'mcp.transport', values: ['sse'] }]);
    for (const features of [{ future: { status: 'supported', reasonCodes: [] } }, { 'mcp.transport': { status: 'supported', reasonCodes: [], values: ['invented'] } }]) expect(() => assertPlatformCapabilities({ ...profile, features })).toThrow();
  });
  it('keeps local discovery evidence outside the public capability schema', () => {
    const local = { ...capabilities(), platform: 'pi', basis: 'local', features: {} };
    assertPlatformCapabilities(local);
    expect(() => assertPlatformCapabilities({ ...local, profileId: 'qualification-baseline' })).toThrow(/additional properties/u);
    expect(() => assertPlatformCapabilities({ ...local, consumers: [{ id: 'pi-cli', product: 'cli', version: '1.5.0' }] })).toThrow(/additional properties/u);
  });
  it('requires both kind support and a delivery route, including for cross-kind requirements', () => {
    for (const fact of [
      { status: 'supported', reasonCodes: [], delivery: ['native-package'] },
      { status: 'supported', reasonCodes: [], delivery: [] },
      { status: 'unsupported', reasonCodes: ['client-unknown'], delivery: ['native-package'] },
    ] as const) {
      const profile = capabilities();
      profile.kinds.skill = { ...fact, reasonCodes: [...fact.reasonCodes], delivery: [...fact.delivery] };
      profile.kinds.agent = { ...profile.kinds.skill };
      const supported = fact.status === 'supported' && fact.delivery.length > 0;
      const result = partitionStaticPluginComponents([skill], profile);
      expect(result.components.length).toBe(supported ? 1 : 0);
      expect(result.unmet).toEqual(supported ? [] : [{ id: skill.id, kind: 'skill', name: skill.name, requiredFeatures: [{ feature: 'component.kind.skill' }], reasonCode: fact.reasonCodes[0] ?? 'interface-unsupported' }]);
      expect(getUnmetFeatureRequirements([{ feature: 'component.kind.agent' }], profile)).toEqual(supported ? [] : [{ feature: 'component.kind.agent' }]);
      assertPlan(plan([skill]), profile);
    }
    const generic = capabilities(); generic.platform = 'generic'; generic.agentNamingMode = 'unsupported'; generic.features = Object.fromEntries(Object.entries(generic.features).filter(([id]) => !id.startsWith('hook.'))); generic.kinds.agent = { status: 'unsupported', reasonCodes: ['interface-unsupported'], delivery: [] };
    expect(partitionStaticPluginComponents([{ id: 'role', name: 'role', kind: 'agent', content: { description: 'Role', prompt: 'Read.' } }], generic).unmet[0]?.requiredFeatures).toEqual([{ feature: 'component.kind.agent' }]);
    expect(() => assertPlatformCapabilities({ ...generic, features: { ...generic.features, 'component.kind.agent': { status: 'supported', reasonCodes: [] } } })).toThrow();
  });
  it('rejects obsolete V2 capability shapes, inconsistent naming modes, and unregistered reasons', () => {
    expect(CAPABILITY_REASON_CODES).toEqual(['client-missing', 'client-unknown', 'version-unsupported', 'interface-unsupported', 'scope-unsupported', 'delivery-unavailable']);
    const profile = capabilities();
    const { agentNamingMode: _, ...withoutMode } = profile;
    for (const invalid of [withoutMode, { ...profile, schemaVersion: 2 },
      { ...profile, agentNamingMode: 'host-plugin' }, { ...profile, deliveryFeatures: [] },
      { ...profile, kinds: { ...profile.kinds, skill: { status: 'unverified', reasonCodes: [], delivery: [] } } },
      { ...profile, features: { 'agent.model': { status: 'unverified', reasonCodes: [] } } },
      { ...profile, features: { 'agent.model': { status: 'unsupported', reasonCodes: ['consumer-missing'] } } },
    ]) expect(() => assertPlatformCapabilities(invalid)).toThrow();
  });
  it('uses the same feature fact for an Agent field and a Skill requirement', () => {
    const profile = capabilities();
    const agent: PluginComponent = { id: 'role', kind: 'agent', name: 'role', content: { description: 'Review', prompt: 'Read.', model: 'model' } };
    const dependent: PluginComponent = { ...skill, requires: [{ feature: 'agent.model' }] };
    profile.features['agent.model'] = { status: 'supported', reasonCodes: [] };
    expect(getMissingDeliveryRequirements(agent, profile)).toEqual([]);
    expect(getMissingDeliveryRequirements(dependent, profile)).toEqual([]);
    profile.features['agent.model'] = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
    expect(getMissingDeliveryRequirements(agent, profile)).toEqual([{ feature: 'agent.model' }]);
    expect(getMissingDeliveryRequirements(dependent, profile)).toEqual([{ feature: 'agent.model' }]);
  });
  it.each(['antigravity', 'codex'] as const)('enforces model values declaratively on %s', (platform) => {
    const profile: PlatformCapabilitiesV3 = { ...capabilities(), platform, features: {
      'agent.execution': { status: 'supported', reasonCodes: [], values: ['isolated-context'] },
      'agent.prompt-mode': { status: 'supported', reasonCodes: [], values: ['host-default'] },
      'agent.model': { status: 'supported', reasonCodes: [], values: ['inherit', 'flash_lite', 'flash', 'pro'] },
    } };
    assertPlatformCapabilities(profile);
    const agent: PluginComponent = { id: 'role', kind: 'agent', name: 'role', content: { description: 'Review', prompt: 'Read.', model: 'pro' } };
    expect(partitionStaticPluginComponents([agent], profile).components).toEqual([agent]);
    const exactModel = { ...agent, content: { ...agent.content, model: 'specific/model-v3' } };
    expect(partitionStaticPluginComponents([exactModel], profile)).toMatchObject({ components: [], unmet: [{ id: 'role', requiredFeatures: [{ feature: 'agent.model' }], reasonCode: 'interface-unsupported' }] });
    const options = { platform, allowedOutputKinds: ['agent' as const], platformCapabilities: profile };
    const unmet = { id: 'role', kind: 'agent', requiredFeatures: [{ feature: 'agent.model' }], reasonCode: 'interface-unsupported' };
    assertPlatformComponentPlan({ ...plan([]), unmet: [unmet] }, options);
    const dependent: PluginComponent = { ...skill, requires: [{ feature: 'agent.model' }] };
    expect(partitionStaticPluginComponents([dependent], profile).components).toEqual([dependent]);
    expect(() => assertPlatformComponentPlan({ ...plan([]), unmet: [{ ...unmet, id: dependent.id, kind: 'skill' }] },
      { ...options, allowedOutputKinds: ['skill'] })).toThrow(/supported values/u);
    for (const values of [[''], ['pro', 'pro'], [7]]) expect(() => assertPlatformCapabilities({ ...profile, features: { ...profile.features, 'agent.model': { status: 'supported', reasonCodes: [], values } } })).toThrow();
    profile.features['agent.model'] = { status: 'supported', reasonCodes: [] };
    expect(partitionStaticPluginComponents([exactModel], profile).components).toEqual([exactModel]);
    expect(() => assertPlatformComponentPlan({ ...plan([]), unmet: [unmet] }, options)).toThrow(/supported values/u);
  });
  it('preserves asymmetric Instruction coverage restrictions by host', () => {
    const profile = capabilities();
    const allCoverage: PluginComponent = { ...instruction, content: { ...instruction.content, coverage: ['main', 'plugin-agents', 'other-agents'] } };
    expect(getMissingDeliveryRequirements(allCoverage, profile)).toEqual([]);
    expect(getMissingDeliveryRequirements(instruction, profile)).toEqual([{ feature: 'instruction.coverage', values: ['plugin-agents'] }]);
    const copilot: PlatformCapabilitiesV3 = { ...profile, platform: 'copilot' };
    expect(getMissingDeliveryRequirements(instruction, copilot)).toEqual([{ feature: 'instruction.coverage', values: ['plugin-agents'] }]);
    expect(getMissingDeliveryRequirements(instruction, copilot, undefined, true)).toEqual([]);
    const agentsOnly: PluginComponent = { ...instruction, content: { ...instruction.content, coverage: ['plugin-agents'] } };
    const antigravity: PlatformCapabilitiesV3 = { ...profile, platform: 'antigravity' };
    expect(getMissingDeliveryRequirements(agentsOnly, antigravity)).toEqual([{ feature: 'instruction.coverage', values: ['plugin-agents'] }]);
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
    assertPlan(plan([restricted]), profile);
    expect(partitionStaticPluginComponents([restricted], profile).unmet[0]?.requiredFeatures).toEqual(requirements.filter((entry) => !entry.feature.startsWith('component.kind.')));
    assertPlan(plan([restricted]));
  });
  it('delivers static and rendered Skills when only invocation preferences are unavailable', () => {
    const profile = capabilities();
    profile.features = {};
    const controlled: PluginComponent = { ...skill, requires: [{ feature: 'skill.invocation.model', values: ['false'] }],
      content: { files: { 'SKILL.md': { text: skillText.replace('description:', 'user-invocable: false\ndescription:') } } } };
    expect(getUnmetFeatureRequirements(getComponentFeatureRequirements(controlled), profile)).toEqual([
      { feature: 'skill.invocation.model', values: ['false'] }, { feature: 'skill.invocation.manual', values: ['false'] },
      { feature: 'skill.visibility', values: ['hidden'] },
    ]);
    assertPlan(plan([controlled]), profile);
    expect(partitionStaticPluginComponents([controlled], profile)).toMatchObject({ components: [controlled], unmet: [] });
    const restricted: PluginComponent = { ...controlled, requires: [...controlled.requires!, { feature: 'skill.tools', values: ['none'] }] };
    assertPlan(plan([restricted]), profile);
    expect(partitionStaticPluginComponents([restricted], profile).unmet[0]?.requiredFeatures).toEqual([{ feature: 'skill.tools', values: ['none'] }]);
  });
  it.each([
    ['true', 'false', 'true', 'true', 'visible'],
    ['"  TRUE  "', '"  Off  "', 'true', 'true', 'visible'],
    ['"  No  "', '"  on  "', 'false', 'false', 'hidden'],
    ['0', '1', 'false', 'false', 'hidden'],
  ])('interprets explicit Skill invocation controls %s and %s', (manualValue, disableModelValue, manual, model, visibility) => {
    const text = skillText.replace('description:', `user-invocable: ${manualValue}\ndisable-model-invocation: ${disableModelValue}\ndescription:`);
    expect(getComponentFeatureRequirements(skill, { skillText: text })).toEqual([
      { feature: 'component.kind.skill' },
      { feature: 'skill.invocation.manual', values: [manual] },
      { feature: 'skill.visibility', values: [visibility] },
      { feature: 'skill.invocation.model', values: [model] },
    ]);
  });
  it('rejects invalid Skill invocation controls before interpreting them', () => {
    const text = skillText.replace('description:', 'user-invocable: "  enabled  "\ndisable-model-invocation: 2\ndescription:');
    expect(() => getComponentFeatureRequirements(skill, { skillText: text }))
      .toThrow(/Invalid Skill frontmatter:.*user-invocable.*disable-model-invocation/u);
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
    await fs.unlink(path.join(root, 'skills/check/escape'));
    await fs.writeFile(path.join(root, 'skills/check/SKILL.md'), skillText.replace('name: check', 'name: renamed'));
    await expect(normalizeStaticPluginComponents({ pluginRoot: root, manifest, platform: 'codex', capabilities: profile })).rejects.toThrow(
      /SKILL\.md frontmatter\.name "renamed".*component "skill:check".*"check"/u,
    );
  });
});
function context(): PlatformRenderContextV3 {
  return { schemaVersion: 3, surface: 'agent-plugin', platform: 'codex', scope: 'user', plugin: { pluginId: 'test/example', name: 'example', version: '1.0.0' }, config: { schema: { schemaVersion: 5, fields: { optional: { type: 'string' } } }, values: {}, sources: { optional: 'missing' }, issues: [] }, changedConfigKeys: ['optional'], allowedOutputKinds: ['skill'], platformCapabilities: capabilities(), agentNaming: { mode: 'aw-prefix', filePrefix: 'aw-test-example-', invocationPrefix: 'aw-test-example-' }, resources: [], previousComponents: [] };
}
describe('renderer input contract', () => {
  it('preserves missing config facts and enforces batch, whitelist and scope boundaries', () => {
    const input = context(); assertPlatformRenderContext(input);
    expect(() => assertPlatformRenderContext({ ...input, schemaVersion: 1 })).toThrow(/render context/u);
    expect(() => assertPlatformRenderContext({ ...input, requestedArtifactIds: [] })).toThrow();
    expect(() => assertPlatformRenderContext({ ...input, platform: 'claude' })).toThrow(/mismatch/u);
    expect(() => assertPlatformRenderContext({ ...input, allowedOutputKinds: ['skill', 'agent'] })).toThrow(/separate/u);
    expect(() => assertPlatformRenderContext({ ...input, config: { ...input.config, values: { optional: 'secret' } } })).toThrow(/missing/u);
    expect(() => assertPlatformRenderContext({ ...input, previousComponents: [{ id: 'role', kind: 'agent', name: 'role' }] })).toThrow(/outside batch/u);
  });

  it('binds the naming strategy to the exact plugin identity and capability platform', () => {
    const input = context();
    const { agentNaming: _, ...withoutNaming } = input;
    for (const invalid of [withoutNaming, { ...input, schemaVersion: 2 },
      { ...input, agentNaming: { ...input.agentNaming, filePrefix: 'aw-other-example-' } },
      { ...input, agentNaming: { ...input.agentNaming, mode: 'host-plugin' } },
      { ...input, plugin: { ...input.plugin, name: 'other' } },
      { ...input, plugin: { ...input.plugin, pluginId: 'invalid/example/extra' } },
      { ...input, platformCapabilities: { ...input.platformCapabilities, agentNamingMode: 'unsupported' } },
    ]) expect(() => assertPlatformRenderContext(invalid)).toThrow();
  });

  it('accepts v5 values with nested fixed object arrays and rejects a third object array level', () => {
    const command = { type: 'object' as const, properties: {
      models: { type: 'array' as const, items: { type: 'object' as const, properties: {
        id: { type: 'string' as const },
        efforts: { type: 'array' as const, items: { type: 'string' as const } },
      } } },
    } };
    const models = [{ id: 'example', efforts: ['low', 'high'] }];
    const input: PlatformRenderContextV3 = { ...context(), changedConfigKeys: [], config: {
      schema: { schemaVersion: 5, fields: { command, commands: { type: 'array', items: command } } },
      values: { command: { models }, commands: [{ models }] },
      sources: { command: 'common', commands: 'platform' },
      issues: [],
    } };
    expect(() => assertPlatformRenderContext(input)).not.toThrow();
    expect(() => assertPlatformRenderContext({ ...input, config: { ...input.config, values: {
      ...input.config.values, commands: [{ models: [{ id: 'example', thirdLevel: [{ key: 'too deep' }] }] }],
    } } })).toThrow(/config\/values\/commands\/0\/models\/0\/thirdLevel/u);
  });
});
