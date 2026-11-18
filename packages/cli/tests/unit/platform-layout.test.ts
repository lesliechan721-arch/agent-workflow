import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { getPlatformCapabilities, getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import type { DeploymentObservation, ResolveRequest } from '../../src/platforms/contracts.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
async function fixture(platform: 'codex' | 'cursor' | 'pi' | 'grok' | 'copilot' | 'gemini' | 'claude' | 'opencode' | 'antigravity') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-layout-')); roots.push(root);
  const ctx = { cwd: root, env: { HOME: root, USERPROFILE: root, AW_HOME: path.join(root, 'aw') } };
  const request: ResolveRequest = { plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'test/example', version: '1.0.0' },
    scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [], discovery: { platform, availability: 'available', diagnostics: [],
      installations: ['cli', 'app'].map((product) => ({ id: product, product: product as 'cli' | 'app', version: '1.0.0', availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: path.join(root, product), configRoot: path.join(root, `.${platform}`) } })) } };
  return { root, ctx, request };
}
// Test Value Gate: discovered clients share the interface minimum; one valid
// CLI path can serve ordinary Skills without extending App or component support.
it.each([
  ['codex', '0.155.0', '0.154.9'], ['claude', '2.1.292', '2.1.291'],
  ['copilot', '1.0.95', '1.0.94'], ['gemini', '0.63.0', '0.62.9'],
  ['pi', '1.0.0', '0.9.9'], ['opencode', '2.0.0', '1.9.9'],
  ['antigravity', '1.3.4', '1.3.3'],
] as const)('uses the %s interface minimum with any complete CLI path', async (platform, minimum, below) => {
  const { ctx, request } = await fixture(platform);
  request.discovery.installations = [{ ...request.discovery.installations[0]!, version: minimum }];
  const resolved = await resolveDeployments(ctx, request);
  const binding = resolved.bindings[0]!;
  const renderUnit = resolved.renderUnits.find((unit) => unit.output === 'package')!;
  const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent',
    consumers: [], components: [], nativeIdentity: null, diagnostics: [], prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } } };
  const input = { binding, renderUnit, observation, profile: getQualifiedPlatformProfile(platform, { platform: 'linux', arch: 'x64' }) };
  for (const version of [minimum, '99.0.0', '99.0.0-alpha.1']) {
    binding.consumers[0]!.version = version;
    const capabilities = getPlatformCapabilities(input);
    expect(capabilities.kinds.skill.status).toBe('supported');
    if (platform === 'codex') {
      expect(capabilities.kinds.agent.status).toBe('supported');
      expect(capabilities.features['skill.runtime-config']).toMatchObject({
        status: 'supported', values: ['aw.installed-runtime-config.v2'],
      });
    }
  }
  for (const version of [below, `${minimum}-alpha.1`, 'invalid', null]) {
    binding.consumers[0]!.version = version;
    expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
  }
  binding.consumers[0]!.version = minimum;
  binding.consumers.push({ ...binding.consumers[0]!, id: 'old-cli', version: below, availability: 'unsupported' },
    { ...binding.consumers[0]!, id: 'app', product: 'app', version: '99.0.0' },
    { ...binding.consumers[0]!, id: 'failed-cli', availability: 'unknown' });
  expect(getPlatformCapabilities(input).kinds.skill.status).toBe('supported');
  binding.consumers.shift();
  const withoutCli = getPlatformCapabilities(input);
  expect(withoutCli.kinds.skill.status).not.toBe('supported');
  if (platform === 'codex') {
    expect(withoutCli.kinds.agent.status).not.toBe('supported');
    expect(withoutCli.features['skill.runtime-config']?.status).not.toBe('supported');
  }
});

it('shares Codex products and user rendering while keeping project roles and activation separate', async () => {
  const { root, ctx, request } = await fixture('codex');
  const user = await resolveDeployments(ctx, request);
  const project = await resolveDeployments(ctx, { ...request, scope: { kind: 'project', projectRoot: path.join(root, 'project') } });
  expect(project.bindings).toHaveLength(1);
  expect(project.bindings[0]!.consumers).toHaveLength(2);
  expect(project.bindings[0]!.physicalKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(project.bindings[0]!.physicalKey).toBe(user.bindings[0]!.physicalKey);
  expect(project.bindings[0]!.activationKey).not.toBe(user.bindings[0]!.activationKey);
  expect(project.renderUnits.find((unit) => unit.output === 'package')!.renderScope).toEqual({ kind: 'user' });
  expect(project.renderUnits.find((unit) => unit.output === 'supplement')!.renderScope.kind).toBe('project');
});

// Test Value Gate: ordinary Skills retain the recorded host, product, scope
// and component limits when their runtime version satisfies the interface.
it('keeps Antigravity ordinary Skills limited to six CLI hosts at User scope', async () => {
  const { root, ctx, request } = await fixture('antigravity');
  request.discovery.installations = [{ ...request.discovery.installations[0]!, version: '1.3.4' }];
  const resolved = await resolveDeployments(ctx, request);
  const binding = resolved.bindings[0]!;
  const renderUnit = resolved.renderUnits[0]!;
  const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent',
    consumers: [], components: [], nativeIdentity: null, diagnostics: [],
    prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } } };
  const profile = getQualifiedPlatformProfile('antigravity', { platform: 'linux', arch: 'x64' });
  expect(profile.qualificationEvidence).toEqual([expect.objectContaining({
    reference: 'scripts/qualification/evidence/native-antigravity-user-skills-six-hosts-2026-11-14.json',
    product: 'cli', version: '1.3.4', platform: 'linux', arch: 'x64', scopes: ['user'], kinds: ['skill'], features: [],
  })]);
  const input = { binding, renderUnit, observation, profile };
  const capabilities = getPlatformCapabilities(input);
  expect(capabilities.kinds.skill.status).toBe('supported');
  for (const kind of ['agent', 'mcp', 'hook', 'instruction'] as const) expect(capabilities.kinds[kind].status).toBe('unverified');
  for (const feature of Object.values(capabilities.features)) expect(feature.status).toBe('unverified');
  const project = await resolveDeployments(ctx, { ...request, scope: { kind: 'project', projectRoot: path.join(root, 'project') } });
  expect(getPlatformCapabilities({ ...input, binding: project.bindings[0]!, renderUnit: project.renderUnits[0]! }).kinds.skill.status).toBe('unverified');
  binding.consumers[0]!.version = '1.3.4';
  binding.consumers[0]!.product = 'app';
  expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
  binding.consumers[0]!.product = 'cli';
  for (const host of [{ platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' }] as const) {
    const recorded = getQualifiedPlatformProfile('antigravity', host);
    expect(getPlatformCapabilities({ ...input, profile: recorded }).kinds.skill.status).toBe('supported');
    expect(getPlatformCapabilities({ ...input, binding: project.bindings[0]!, renderUnit: project.renderUnits[0]!, profile: recorded }).kinds.skill.status).toBe('unverified');
    expect(recorded.qualificationEvidence?.[0]).toEqual(expect.objectContaining({ ...host, scopes: ['user'], kinds: ['skill'], features: [] }));
  }
  expect(getQualifiedPlatformProfile('antigravity', { platform: 'freebsd', arch: 'x64' }).kinds.skill.status).toBe('unverified');
  expect(getQualifiedPlatformProfile('antigravity', { platform: 'linux', arch: 'ia32' }).kinds.skill.status).toBe('unverified');
  expect(getAuthoringPlatformCapabilities('antigravity', 'user').kinds.skill.status).toBe(['linux', 'darwin', 'win32'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch) ? 'supported' : 'unverified');
  expect(getAuthoringPlatformCapabilities('antigravity', 'project').kinds.skill.status).toBe('unverified');
});
it('separates Cursor scope packages without changing physical identity on upgrades', async () => {
  const { root, ctx, request } = await fixture('cursor');
  const user = await resolveDeployments(ctx, request);
  const update = await resolveDeployments(ctx, { ...request, plugin: { ...request.plugin, version: '2.0.0' } });
  const project = await resolveDeployments(ctx, { ...request, scope: { kind: 'project', projectRoot: path.join(root, 'project') } });
  expect(user.bindings[0]!.physicalKey).toBe(update.bindings[0]!.physicalKey);
  expect(user.bindings[0]!.physicalKey).not.toBe(project.bindings[0]!.physicalKey);
});
it('keeps missing Pi consumers distinct from unknown observation and hides product paths', async () => {
  const { root, ctx, request } = await fixture('pi');
  const resolved = await resolveDeployments(ctx, request);
  const binding = resolved.bindings[0]!;
  const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent', consumers: [], components: [], nativeIdentity: null,
    prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
  const input = { binding, renderUnit: resolved.renderUnits[0]!, observation, profile: getQualifiedPlatformProfile('pi') };
  expect(getPlatformCapabilities(input).kinds.agent).toMatchObject({ status: 'unsupported', reasonCodes: ['consumer-missing'] });
  expect(getPlatformCapabilities(input).kinds.skill.status).toBe('supported');
  expect(JSON.stringify(getPlatformCapabilities(input))).not.toContain(root);
  observation.prerequisites.agentConsumers.observation = 'unknown';
  expect(getPlatformCapabilities(input).kinds.agent.status).toBe('unverified');
});

it('uses separate immutable source roots when one AW home serves different native namespaces', async () => {
  const { root, ctx, request } = await fixture('codex');
  const first = await resolveDeployments(ctx, request);
  const secondRequest: ResolveRequest = { ...request, discovery: { ...request.discovery, installations: request.discovery.installations.map((item) => ({
    ...item, entry: { kind: 'cli', executable: path.join(root, 'other-client'), configRoot: path.join(root, 'other-home') },
  })) } };
  const second = await resolveDeployments({ ...ctx, env: { ...ctx.env, CODEX_HOME: path.join(root, 'other-home') } }, secondRequest);
  const firstLayout = await getDeploymentLayout(ctx, first.bindings[0]!);
  const secondLayout = await getDeploymentLayout(ctx, second.bindings[0]!);
  expect(first.bindings[0]!.physicalKey).not.toBe(second.bindings[0]!.physicalKey);
  expect(firstLayout.packageRoot).not.toBe(secondLayout.packageRoot);
  expect(firstLayout.marketplaceName).not.toBe(secondLayout.marketplaceName);
});
// Test Value Gate: ordinary Skill delivery keeps its host/product limits,
// exact historical evidence and independent feature qualification.
it.each(['codex', 'pi'] as const)('keeps the %s Skill profile host and product limits', async (platform) => {
  const { ctx, request } = await fixture(platform);
  const version = platform === 'codex' ? '0.167.0' : '1.5.0';
  request.discovery.installations = [{ ...request.discovery.installations[0]!, version }];
  const resolved = await resolveDeployments(ctx, request);
  const binding = resolved.bindings[0]!;
  const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent', ownership: 'absent', consumers: [], components: [], nativeIdentity: null,
    prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
  const input = { binding, renderUnit: resolved.renderUnits[0]!, observation };
  const hosts: Array<{ platform: NodeJS.Platform; arch: NodeJS.Architecture }> = [
    { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' },
  ];
  for (const host of hosts) {
    const profile = getQualifiedPlatformProfile(platform, host);
    const capabilities = getPlatformCapabilities({ ...input, profile });
    expect(capabilities.kinds.skill.status).toBe('supported');
    for (const kind of ['hook', 'mcp', 'instruction'] as const) expect(capabilities.kinds[kind].status).toBe('unverified');
    if (platform === 'codex') {
      expect(capabilities.kinds.agent.status).toBe('supported');
      expect(capabilities.features['skill.invocation.manual']).toMatchObject({ status: 'supported', values: ['true'] });
      expect(capabilities.features['skill.visibility']).toMatchObject({ status: 'supported', values: ['visible'] });
      expect(capabilities.features['skill.invocation.model']).toMatchObject({ status: 'supported', values: ['true', 'false'] });
    } else {
      expect(capabilities.kinds.agent.status).not.toBe('supported');
      expect(capabilities.features['skill.invocation.manual']!.status).toBe('unverified');
    }
    expect(profile.qualificationEvidence?.[0]).toMatchObject({ platform: host.platform, arch: host.arch,
      product: 'cli', version, kinds: ['skill'], features: [], scopes: ['user', 'project'] });
    binding.consumers[0]!.product = 'app';
    const appOnly = getPlatformCapabilities({ ...input, profile });
    expect(appOnly.kinds.skill.status).toBe('unverified');
    expect(appOnly.features['skill.invocation.manual']!.status).toBe('unverified');
    binding.consumers[0]!.product = 'cli'; binding.consumers[0]!.version = platform === 'codex' ? '0.168.0' : '1.5.1';
    expect(getPlatformCapabilities({ ...input, profile }).kinds.skill.status).toBe('supported');
    binding.consumers[0]!.version = version;
  }
  for (const host of [{ platform: 'freebsd', arch: 'x64' }, { platform: 'linux', arch: 's390x' }] as const) {
    expect(getPlatformCapabilities({ ...input, profile: getQualifiedPlatformProfile(platform, host) }).kinds.skill.status).toBe('unverified');
  }
});

it('blocks project writes that alias Codex user configuration but retains cleanup resolution', async () => {
  const { root, ctx, request } = await fixture('codex');
  request.scope = { kind: 'project', projectRoot: root };
  const writing = await resolveDeployments(ctx, request);
  expect(writing.bindings).toHaveLength(0);
  expect(writing.exclusions.every((exclusion) => exclusion.reasonCode === 'codexScopePathAlias')).toBe(true);
  const cleanup = await resolveDeployments(ctx, { ...request, operation: 'cleanup' });
  expect(cleanup.bindings).toHaveLength(1);
});

// Test Value Gate: ordinary Skills keep both scopes, six CLI host limits and
// exact historical evidence, without authorizing other products or features.
it.each([
  { platform: 'copilot', exactVersion: '1.0.95', previousVersion: '1.0.94', nextVersion: '1.0.96', evidenceDate: '2026-11-12' },
  { platform: 'claude', exactVersion: '2.1.317', previousVersion: '2.1.316', nextVersion: '2.1.318', evidenceDate: '2026-11-12' },
  { platform: 'opencode', exactVersion: '2.0.0', previousVersion: '1.9.9', nextVersion: '2.0.1', evidenceDate: '2026-11-13' },
] as const)('keeps $platform ordinary Skill product, host and scope limits', async ({ platform, exactVersion, nextVersion, evidenceDate }) => {
  const { root, ctx, request } = await fixture(platform);
  request.discovery.installations = [{ ...request.discovery.installations[0]!, version: exactVersion }];
  const hosts: Array<{ platform: NodeJS.Platform; arch: NodeJS.Architecture }> = [
    { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' },
  ];
  for (const scope of ['user', 'project'] as const) {
    const resolved = await resolveDeployments(ctx, { ...request,
      scope: scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: path.join(root, 'project') } });
    const binding = resolved.bindings[0]!;
    const renderUnit = resolved.renderUnits.find((unit) => unit.output === 'package')!;
    const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent',
      ownership: 'absent', consumers: [], components: [], nativeIdentity: null,
      prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
    for (const host of hosts) {
      const profile = getQualifiedPlatformProfile(platform, host);
      const input = { binding, renderUnit, observation, profile };
      const capabilities = getPlatformCapabilities(input);
      expect(capabilities.kinds.skill.status).toBe('supported');
      for (const kind of ['hook', 'mcp', 'instruction', 'agent'] as const) expect(capabilities.kinds[kind].status).toBe('unverified');
      for (const feature of Object.values(capabilities.features)) expect(feature.status).toBe('unverified');
      expect(profile.qualificationEvidence?.[0]).toMatchObject({
        reference: `scripts/qualification/evidence/native-${platform}-skills-${evidenceDate}.json`,
        product: 'cli', version: exactVersion, platform: host.platform, arch: host.arch,
        scopes: ['user', 'project'], kinds: ['skill'], features: [],
      });
      binding.consumers[0]!.version = exactVersion;
      binding.consumers[0]!.product = 'app';
      expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
      binding.consumers[0]!.product = 'cli';
      binding.consumers.push({ ...binding.consumers[0]!, id: 'other-consumer', version: nextVersion });
      expect(getPlatformCapabilities(input).kinds.skill.status).toBe('supported');
      binding.consumers.pop();
    }
    for (const host of [{ platform: 'freebsd', arch: 'x64' }, { platform: 'linux', arch: 's390x' }] as const) {
      expect(getPlatformCapabilities({ binding, renderUnit, observation,
        profile: getQualifiedPlatformProfile(platform, host) }).kinds.skill.status).toBe('unverified');
    }
    const hostQualified = hosts.some((host) => host.platform === process.platform && host.arch === process.arch);
    const authoring = getAuthoringPlatformCapabilities(platform, scope);
    expect(authoring.kinds.skill.status).toBe(hostQualified ? 'supported' : 'unverified');
    for (const kind of ['hook', 'mcp', 'instruction', 'agent'] as const) expect(authoring.kinds[kind].status).toBe('unverified');
    for (const feature of Object.values(authoring.features)) expect(feature.status).toBe('unverified');
  }
});

// Test Value Gate: runtime and author views keep scope-specific product and
// host limits, while qualification evidence retains its exact tested versions.
it('limits Grok ordinary Skills to the four recorded CLI User/Project environments', async () => {
  const { root, ctx, request } = await fixture('grok');
  request.discovery.installations = [{ ...request.discovery.installations[0]!, version: '1.0.77' }];
  const user = await resolveDeployments(ctx, request);
  const project = await resolveDeployments(ctx, { ...request, scope: { kind: 'project', projectRoot: path.join(root, 'project') } });
  const binding = user.bindings[0]!;
  const renderUnit = user.renderUnits.find((unit) => unit.output === 'package')!;
  const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent',
    ownership: 'absent', consumers: [], components: [], nativeIdentity: null,
    prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
  const hosts: Array<{ platform: NodeJS.Platform; arch: NodeJS.Architecture }> = [
    { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'arm64' }, { platform: 'win32', arch: 'x64' },
  ];
  for (const host of hosts) {
    const profile = getQualifiedPlatformProfile('grok', host);
    const input = { binding, renderUnit, observation, profile };
    const capability = getPlatformCapabilities(input);
    expect(capability.kinds.skill.status).toBe('supported');
    for (const kind of ['hook', 'mcp', 'instruction', 'agent'] as const) expect(capability.kinds[kind].status).toBe('unverified');
    expect(capability.features['skill.invocation.manual']!.status).toBe('unverified');
    expect(profile.qualificationEvidence?.[0]).toMatchObject({ product: 'cli', version: '1.0.77',
      platform: host.platform, arch: host.arch, scopes: ['user'], kinds: ['skill'], features: [] });
    const projectBinding = project.bindings[0]!;
    const projectUnit = project.renderUnits.find((unit) => unit.output === 'package')!;
    expect(getPlatformCapabilities({ binding: projectBinding, renderUnit: projectUnit,
      observation: { ...observation, physicalKey: projectBinding.physicalKey }, profile }).kinds.skill.status).toBe('supported');
    expect(profile.qualificationEvidence?.[1]).toMatchObject({ product: 'cli', version: '1.0.77',
      platform: host.platform, arch: host.arch, scopes: ['project'], kinds: ['skill'], features: [] });
    for (const version of ['1.0.76', '1.0.78', '1.0.82', null]) {
      binding.consumers[0]!.version = version;
      expect(getPlatformCapabilities(input).kinds.skill.status).toBe('supported');
    }
    binding.consumers[0]!.version = 'invalid';
    expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
    binding.consumers[0]!.version = '1.0.77';
    binding.consumers[0]!.product = 'app';
    expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
    binding.consumers[0]!.product = 'cli';
  }
  for (const host of [{ platform: 'darwin', arch: 'x64' }, { platform: 'win32', arch: 'arm64' },
    { platform: 'freebsd', arch: 'x64' }, { platform: 'linux', arch: 's390x' }] as const) {
    expect(getPlatformCapabilities({ binding, renderUnit, observation,
      profile: getQualifiedPlatformProfile('grok', host) }).kinds.skill.status).toBe('unverified');
  }
  const hostQualified = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'].includes(`${process.platform}-${process.arch}`);
  expect(getAuthoringPlatformCapabilities('grok', 'project').kinds.skill.status).toBe(hostQualified ? 'supported' : 'unverified');
  expect(getAuthoringPlatformCapabilities('grok', 'user').kinds.skill.status).toBe(hostQualified ? 'supported' : 'unverified');
});

// Test Value Gate: runtime and author views keep scope-specific product and
// host limits, while qualification evidence retains its exact tested versions.
it('limits Gemini ordinary Skills to the six recorded CLI User/Project environments', async () => {
  const { root, ctx, request } = await fixture('gemini');
  request.discovery.installations = [{ ...request.discovery.installations[0]!, version: '0.67.0' }];
  const user = await resolveDeployments(ctx, request);
  const project = await resolveDeployments(ctx, { ...request, scope: { kind: 'project', projectRoot: path.join(root, 'project') } });
  const binding = user.bindings[0]!;
  const renderUnit = user.renderUnits.find((unit) => unit.output === 'package')!;
  const projectBinding = project.bindings[0]!;
  const projectUnit = project.renderUnits.find((unit) => unit.output === 'package')!;
  expect(projectUnit.renderScope.kind).toBe('user');
  const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'absent', registration: 'absent',
    ownership: 'absent', consumers: [], components: [], nativeIdentity: null,
    prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
  const hosts: Array<{ platform: NodeJS.Platform; arch: NodeJS.Architecture }> = [
    { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'arm64' },
  ];
  for (const host of hosts) {
    const profile = getQualifiedPlatformProfile('gemini', host);
    expect(profile.qualificationEvidence?.[0]).toMatchObject({ product: 'cli', version: '0.67.0',
      reference: 'scripts/qualification/evidence/native-gemini-skills-2026-11-12.json',
      platform: host.platform, arch: host.arch, scopes: ['user'], kinds: ['skill'], features: [] });
    expect(profile.qualificationEvidence?.[1]).toMatchObject({ product: 'cli', version: '0.67.0',
      reference: 'scripts/qualification/evidence/native-gemini-project-skills-2026-11-13.json',
      platform: host.platform, arch: host.arch, scopes: ['project'], kinds: ['skill'], features: [] });
    for (const input of [{ binding, renderUnit, observation, profile }, { binding: projectBinding, renderUnit: projectUnit,
      observation: { ...observation, physicalKey: projectBinding.physicalKey }, profile }]) {
      const capability = getPlatformCapabilities(input);
      expect(capability.kinds.skill.status).toBe('supported');
      for (const kind of ['hook', 'mcp', 'instruction', 'agent'] as const) expect(capability.kinds[kind].status).toBe('unverified');
      for (const feature of Object.values(capability.features)) expect(feature.status).toBe('unverified');
      input.binding.consumers[0]!.version = '0.67.0';
      input.binding.consumers[0]!.product = 'app';
      expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
      input.binding.consumers[0]!.product = 'cli';
      input.binding.consumers.push({ ...input.binding.consumers[0]!, id: 'other-consumer', version: '0.67.1' });
      expect(getPlatformCapabilities(input).kinds.skill.status).toBe('supported');
      input.binding.consumers.pop();
    }
  }
  for (const host of [{ platform: 'freebsd', arch: 'x64' }, { platform: 'linux', arch: 's390x' }] as const) {
    const profile = getQualifiedPlatformProfile('gemini', host);
    for (const input of [{ binding, renderUnit, observation, profile }, { binding: projectBinding, renderUnit: projectUnit,
      observation: { ...observation, physicalKey: projectBinding.physicalKey }, profile }]) {
      expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
    }
  }
  const hostQualified = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'].includes(`${process.platform}-${process.arch}`);
  const authoringUser = getAuthoringPlatformCapabilities('gemini', 'user');
  const authoringProject = getAuthoringPlatformCapabilities('gemini', 'project');
  for (const capabilities of [authoringUser, authoringProject]) {
    expect(capabilities.kinds.skill.status).toBe(hostQualified ? 'supported' : 'unverified');
    for (const kind of ['hook', 'mcp', 'instruction', 'agent'] as const) expect(capabilities.kinds[kind].status).toBe('unverified');
    for (const feature of Object.values(capabilities.features)) expect(feature.status).toBe('unverified');
  }
});
