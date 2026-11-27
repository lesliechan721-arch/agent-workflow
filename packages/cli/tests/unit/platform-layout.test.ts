import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, expect, it } from 'vitest';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { getPlatformCapabilities, getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import type { ResolveRequest } from '../../src/platforms/contracts.js';
import { assertPlatformCapabilities, type FeatureRequirement } from '@lesliechan721/aw-plugin-core/manifest';
import { skillInvocationWarning } from '../../src/utils/skill-invocation-warning.js';
import { isDeliveryCapabilityGapReason } from '../../src/utils/component-gap.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.remove(root))); });
async function fixture(platform: ResolveRequest['discovery']['platform']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-layout-')); roots.push(root);
  const ctx = { cwd: root, env: { HOME: root, USERPROFILE: root, AW_HOME: path.join(root, 'aw') } };
  const request: ResolveRequest = { plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'test/example', version: '1.0.0' },
    scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [], discovery: { platform, availability: 'available', diagnostics: [],
      installations: ['cli', 'app'].map((product) => ({ id: product, product: product as 'cli' | 'app', version: '1.0.0', availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: path.join(root, product), configRoot: path.join(root, `.${platform}`) } })) } };
  return { root, ctx, request };
}
it('shares Codex products and user rendering while keeping project roles and activation separate', async () => {
  const { root, ctx, request } = await fixture('codex');
  request.discovery.installations = request.discovery.installations.map((entry) => ({ ...entry, version: '0.167.0' }));
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

it('keeps Antigravity scope paths separate while co-readers share each placement', async () => {
  const { root, ctx, request } = await fixture('antigravity');
  const configRoot = path.join(await fs.realpath(root), '.gemini', 'config');
  const cli = { ...request.discovery.installations[0]!, version: '1.5.13', entry: { kind: 'cli' as const,
    executable: path.join(root, 'agy'), configRoot } };
  const app = { ...request.discovery.installations[1]!, entry: { kind: 'directory' as const, configRoot } };
  request.discovery.installations = [app, cli];
  const physical = async (resolution: Awaited<ReturnType<typeof resolveDeployments>>) => {
    expect(resolution.bindings).toHaveLength(1);
    return getDeploymentLayout(ctx, resolution.bindings[0]!);
  };
  const a = path.join(await fs.realpath(root), 'project-a');
  const b = path.join(await fs.realpath(root), 'project-b');
  await fs.ensureDir(a);
  await fs.ensureDir(b);
  const scopeA = { kind: 'project' as const, projectRoot: a };
  const scopeB = { kind: 'project' as const, projectRoot: b };
  const user = await resolveDeployments(ctx, request);
  const project = await resolveDeployments(ctx, { ...request, scope: scopeA });
  const secondProject = await resolveDeployments(ctx, { ...request, scope: scopeB });
  expect(user.bindings[0]?.route).toBe('antigravity-cli');
  expect(user.bindings[0]?.consumers).toHaveLength(2);
  expect(project.bindings[0]?.route).toBe('antigravity-directory');
  expect(project.bindings[0]?.consumers).toHaveLength(2);
  expect((await physical(project)).packageRoot).toBe(path.join(a, '.agents', 'plugins', 'example'));
  expect((await physical(secondProject)).packageRoot).toBe(path.join(b, '.agents', 'plugins', 'example'));
  expect(new Set([user, project, secondProject].map((resolved) => resolved.bindings[0]?.physicalKey)).size).toBe(3);

  const appOnly = { ...request, discovery: { ...request.discovery, installations: [app] } };
  expect((await physical(await resolveDeployments(ctx, appOnly))).packageRoot)
    .toBe(path.join(configRoot, 'plugins', 'aw-test-example'));
  expect((await physical(await resolveDeployments(ctx, { ...appOnly, scope: scopeA }))).packageRoot)
    .toBe((await physical(project)).packageRoot);

  await fs.ensureDir(path.join(b, '.agents'));
  await fs.symlink(path.join(b, '.agents'), path.join(a, '.agents'), 'junction');
  const conflicting = await resolveDeployments(ctx, { ...request, scope: scopeA });
  expect(conflicting.bindings).toEqual([]);
  expect(conflicting.exclusions).toEqual([expect.objectContaining({ reasonCode: 'deploymentLayoutUnconfirmed' }),
    expect.objectContaining({ reasonCode: 'deploymentLayoutUnconfirmed' })]);
});
it('separates Cursor scope packages without changing physical identity on upgrades', async () => {
  const { root, ctx, request } = await fixture('cursor');
  const user = await resolveDeployments(ctx, request);
  const update = await resolveDeployments(ctx, { ...request, plugin: { ...request.plugin, version: '2.0.0' } });
  const project = await resolveDeployments(ctx, { ...request, scope: { kind: 'project', projectRoot: path.join(root, 'project') } });
  expect(user.bindings[0]!.physicalKey).toBe(update.bindings[0]!.physicalKey);
  expect(user.bindings[0]!.physicalKey).not.toBe(project.bindings[0]!.physicalKey);
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
  expect(firstLayout.marketplaceName).toBe(secondLayout.marketplaceName);
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

it.each([
  ['codex', '0.155.0', 'aw-prefix', 'native-package', 'managed-host-resource', false],
  ['claude', '2.1.292', 'host-plugin', 'native-package', 'native-package', true],
  ['cursor', 'desktop-3.29_cli-2026.11.05-86047df', 'aw-prefix', 'native-package', 'native-package', false],
  ['antigravity', 'cli-1.3.4', 'aw-prefix', 'native-package', 'native-package', false],
  ['opencode', '2.0.0', 'unsupported', 'native-extension', null, false],
  ['pi', '1.0.0', 'aw-prefix', 'native-extension', 'native-extension', false],
  ['copilot', '1.0.95', 'aw-prefix', 'native-package', 'native-package', true],
  ['grok', 'native-plugin-interface', 'aw-prefix', 'native-package', 'native-package', true],
  ['generic', 'skills-v1', 'unsupported', 'generic-files', null, false],
] as const)('uses the %s delivery interface for local and authoring in both scopes', async (platform, version, mode, delivery, agentDelivery, hidden) => {
  const { ctx, request } = await fixture(platform);
  const profile = getQualifiedPlatformProfile(platform);
  expect(profile.id).toBe(`${platform}:${version}`);
  for (const scope of ['user', 'project'] as const) {
    const resolved = await resolveDeployments(ctx, { ...request,
      scope: scope === 'user' ? { kind: scope } : { kind: scope, projectRoot: path.join(ctx.cwd, 'project') } });
    const binding = resolved.bindings[0]!;
    const renderUnit = { ...resolved.renderUnits[0]!, renderScope: binding.scope };
    const local = getPlatformCapabilities({ binding, renderUnit, profile });
    const author = getAuthoringPlatformCapabilities(platform, scope);
    assertPlatformCapabilities(local);
    expect(local).toEqual({ ...author, basis: 'local' });
    expect(local).toMatchObject({ schemaVersion: 3, agentNamingMode: mode });
    for (const kind of ['skill', 'hook', 'mcp', 'instruction', 'agent'] as const) {
      const expected = kind === 'agent' ? agentDelivery : platform === 'generic' && kind !== 'skill' ? null
        : platform === 'grok' && kind === 'instruction' ? 'managed-host-resource' : delivery;
      expect(local.kinds[kind]).toEqual(expected ? { status: 'supported', delivery: [expected], reasonCodes: [] }
        : { status: 'unsupported', delivery: [], reasonCodes: ['interface-unsupported'] });
    }
    const portable = getAuthoringPlatformCapabilities(platform, scope, { portable: true });
    for (const feature of ['skill.invocation.manual', 'skill.invocation.model', 'skill.visibility']) {
      expect(portable.features[feature]).toEqual(platform === 'codex' || platform === 'opencode' ? author.features[feature]
        : { status: 'unsupported', reasonCodes: ['interface-unsupported'], values: [] });
    }
    if (platform === 'generic') {
      expect(Object.values(local.features).every(({ status }) => status === 'unsupported')).toBe(true);
    } else {
      const mcpTransports = ['claude', 'copilot', 'cursor', 'grok'].includes(platform) ? ['http', 'sse', 'stdio'] : ['http', 'stdio'];
      expect(local.features['mcp.transport']?.values).toEqual(mcpTransports);
      const coverage = ['codex', 'claude'].includes(platform) ? ['main', 'other-agents', 'plugin-agents']
        : ['antigravity', 'grok', 'copilot'].includes(platform) ? ['main', 'plugin-agents'] : ['main'];
      expect(local.features['instruction.coverage']?.values).toEqual(coverage);
      expect(local.features['instruction.paths']?.status).toBe(['antigravity', 'cursor'].includes(platform) ? 'supported' : 'unsupported');
      if (platform === 'opencode') {
        expect(Object.entries(local.features).filter(([id]) => id.startsWith('agent.')).every(([, fact]) => fact.status === 'unsupported')).toBe(true);
      } else {
        expect(local.features['agent.execution']?.values).toEqual(['isolated-context']);
        expect(local.features['agent.prompt-mode']?.values).toEqual(platform === 'claude' ? ['host-default', 'replace'] : ['host-default']);
        expect(local.features['agent.model']?.status).toBe(platform === 'grok' ? 'unsupported' : 'supported');
        expect(local.features['agent.model']?.values).toEqual(platform === 'antigravity' ? ['flash', 'flash_lite', 'inherit', 'pro'] : undefined);
        expect(local.features['agent.tools']?.values).toEqual(platform === 'claude' ? ['allowlist'] : platform === 'copilot' ? ['allowlist', 'none'] : []);
      }
    }
    const controls = (manual: boolean): FeatureRequirement[] => [
      { feature: 'skill.invocation.manual', values: [String(manual)] }, { feature: 'skill.invocation.model', values: ['false'] },
      { feature: 'skill.visibility', values: [manual ? 'visible' : 'hidden'] },
    ];
    const warn = (manual: boolean) => skillInvocationWarning('demo', controls(manual), { pluginId: 'test/demo', target: platform, scope },
      platform === 'generic' ? undefined : local, [{ product: 'cli' }, { product: 'app' }]);
    if (platform === 'generic') {
      expect(warn(true)?.detail?.reasonCode).toBe('noBoundExecutor');
    } else {
      expect(warn(true)).toBeUndefined();
      if (hidden) expect(warn(false)).toBeUndefined();
      else {
        const expected = controls(false).filter(({ feature }) => feature !== 'skill.invocation.model');
        expect(warn(false)?.detail?.skillInvocationControls).toEqual(platform === 'antigravity'
          ? ['cli', 'app'].flatMap((product) => expected.map((control) => ({ ...control, product, reasonCode: 'invocationControlUnsupported' })))
          : expected.map((control) => ({ ...control, reasonCode: 'invocationControlUnsupported' })));
      }
    }
  }
});

it('keeps unavailable client diagnoses distinct from a delivery gap', async () => {
  const { ctx, request } = await fixture('codex');
  const resolved = await resolveDeployments(ctx, request);
  const binding = resolved.bindings[0]!;
  const renderUnit = resolved.renderUnits[0]!;
  for (const [availability, reason] of [['unknown', 'client-unknown'], ['missing', 'client-missing'], ['unsupported', 'version-unsupported']] as const) {
    const capabilities = getPlatformCapabilities({ binding, profile: getQualifiedPlatformProfile('codex'),
      renderUnit: { ...renderUnit, consumers: [{ ...binding.consumers[0]!, availability }] } });
    expect(capabilities.kinds.agent).toEqual({ status: 'unsupported', reasonCodes: [reason], delivery: ['managed-host-resource'] });
    expect(capabilities.features['skill.visibility']).toEqual({ status: 'unsupported', reasonCodes: [reason], values: [] });
    expect(isDeliveryCapabilityGapReason(reason)).toBe(availability === 'unsupported');
  }
});
