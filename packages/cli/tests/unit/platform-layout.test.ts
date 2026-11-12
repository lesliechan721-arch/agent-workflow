import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { getPlatformCapabilities, getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import type { DeploymentObservation, ResolveRequest } from '../../src/platforms/contracts.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
async function fixture(platform: 'codex' | 'cursor' | 'pi') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-layout-')); roots.push(root);
  const ctx = { cwd: root, env: { HOME: root, USERPROFILE: root, AW_HOME: path.join(root, 'aw') } };
  const request: ResolveRequest = { plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'test/example', version: '1.0.0' },
    scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [], discovery: { platform, availability: 'available', diagnostics: [],
      installations: ['cli', 'app'].map((product) => ({ id: product, product: product as 'cli' | 'app', version: '1.0.0', availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: path.join(root, product), configRoot: path.join(root, `.${platform}`) } })) } };
  return { root, ctx, request };
}
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
  expect(getPlatformCapabilities(input).kinds.skill.status).toBe('unverified');
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
// Test Value Gate: only the approved exact CLI/version/host cells gain ordinary
// Skill delivery; neighbouring versions, product surfaces and features stay gated.
it.each(['codex', 'pi'] as const)('limits the finite %s Skill profile to its recorded cells', async (platform) => {
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
    expect(capabilities.kinds.agent.status).not.toBe('supported');
    expect(capabilities.features['skill.invocation.manual']!.status).toBe('unverified');
    expect(profile.qualificationEvidence?.[0]).toMatchObject({ platform: host.platform, arch: host.arch,
      product: 'cli', version, kinds: ['skill'], features: [], scopes: ['user', 'project'] });
    binding.consumers[0]!.product = 'app';
    expect(getPlatformCapabilities({ ...input, profile }).kinds.skill.status).toBe('unverified');
    binding.consumers[0]!.product = 'cli'; binding.consumers[0]!.version = platform === 'codex' ? '0.168.0' : '1.5.1';
    expect(getPlatformCapabilities({ ...input, profile }).kinds.skill.status).toBe('unverified');
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
