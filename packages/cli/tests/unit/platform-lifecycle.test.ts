import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { preparePlatformLifecycle, executePlatformLifecycle } from '../../src/platforms/lifecycle.js';
import type { DeploymentBinding, DeploymentObservation, LifecyclePrepareInput, MutationContext, MutationOutcome, PreparedDeployment } from '../../src/platforms/contracts.js';
import type { PlatformDriverState } from '../../src/platforms/lifecycle.js';
import { NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createSkillOwnerMarkerContent, SKILL_OWNER_MARKER, writeOwnedTextFile } from '../../src/utils/ownership.js';
import { deploymentPackageComponent, inspectDeployment, inspectStaticSupplements } from '../../src/platforms/inspection.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { createNativeLifecycleServices } from '../../src/platforms/lifecycle-native-services.js';
import { geminiScopePattern } from '../../src/platforms/gemini-activation.js';
import { readCodexConfigFile, upsertCodexMarketplaceFile } from '../../src/utils/codex-config.js';
import type { OwnedComponent } from '../../src/utils/ownership.js';

const root = path.resolve('/tmp/aw-platform-lifecycle-fixture');
const confirmed: MutationOutcome = { changed: true, mutation: 'confirmed' };
function fixture(route: DeploymentBinding['route'] = 'antigravity-cli'): LifecyclePrepareInput {
  const platform = route === 'generic-skills' ? 'generic' : route === 'cursor-workspace-hook' ? 'cursor' : route === 'pi-package' ? 'pi'
    : route === 'codex-marketplace' ? 'codex' : route === 'claude-marketplace' ? 'claude' : route === 'copilot-marketplace' ? 'copilot'
      : route === 'gemini-extension' ? 'gemini' : route.startsWith('grok-') ? 'grok' : 'antigravity';
  const binding: DeploymentBinding = { id: 'binding', plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'test/demo', version: '1.0.0' },
    platform, scope: { kind: 'user' }, route, physicalKey: 'physical', activationKey: 'activation', renderUnitIds: ['package'],
    consumers: [{ id: 'client', product: 'cli', version: '1.3.4', availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: '/fake/client', configRoot: root } }] };
  const observation: DeploymentObservation = { physicalKey: 'physical', package: 'absent', registration: 'absent', ownership: 'absent', consumers: [{
    productId: 'client', activationKey: 'activation', activation: 'disabled', trust: 'trusted', load: 'not-observed' }], components: [], nativeIdentity: null,
    prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
  return { operation: 'ensure', binding, observation,
    projections: [{ renderUnitId: 'package', bundle: { stagingRoot: path.join(root, 'staging'), contentDigest: 'bundle' }, supplements: [], components: [{ id: 'skill', nativeName: 'demo', relativeOutputs: ['skills/demo/SKILL.md'] }], diagnostics: [] }],
    expected: { components: [{ id: 'skill', name: 'demo', kind: 'skill', content: { files: { 'SKILL.md': { text: 'body' } } } }], omitted: [], unmet: [], sources: { skill: 'static' } },
    evidence: { fingerprint: 'frozen', layout: { packageRoot: path.join(root, 'demo'), activationPath: path.join(root, 'settings.json'), supplementRoot: path.join(root, 'rules'), marketplaceName: null, marketplaceRoot: null },
      ownership: [{ state: 'absent', component: { kind: 'owned-directory', path: path.join(root, 'demo'), allowedRoot: root,
        identity: { owner: 'agent-workflows', plugin: 'demo', sourceId: 'test', pluginId: 'test/demo', artifactKey: 'demo', platform, scope: 'user' } } }],
      sharedReferences: 'none', nativeIdentity: { route, packageId: 'demo', sourceLocation: path.join(root, 'demo') }, contentMatches: false } };
}
function prepared(input: LifecyclePrepareInput): PreparedDeployment<PlatformDriverState> {
  const result = preparePlatformLifecycle(input);
  if (result.status !== 'ready') throw new Error(JSON.stringify(result.diagnostics));
  return result.prepared;
}
function grokRefreshFixture(): LifecyclePrepareInput {
  const input = fixture('grok-cli');
  input.binding.consumers[0]!.version = '1.0.77';
  input.evidence.nativeIdentity!.registrationId = 'local-123';
  input.observation = { ...input.observation, package: 'present', registration: 'present', ownership: 'aw',
    nativeIdentity: { ...input.evidence.nativeIdentity! }, components: [{ id: 'skill', presence: 'present', reasonCodes: [] }] };
  input.evidence.ownership[0]!.state = 'present';
  return input;
}
function grokCurrentObservation(input: LifecyclePrepareInput): DeploymentObservation {
  return { ...input.observation, package: 'present', registration: 'present', ownership: 'aw', nativePackageContentDigest: 'bundle',
    components: [{ id: 'skill', presence: 'present', reasonCodes: [] }],
    consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'enabled' })) };
}
function supplementOnlyFixture(): LifecyclePrepareInput {
  const input = fixture('codex-marketplace');
  const agentsRoot = path.join(root, 'agents');
  input.binding.renderUnitIds = ['package', 'roles'];
  input.binding.consumers = [];
  input.observation.consumers = [];
  input.evidence.nativeIdentity = null;
  input.evidence.retainPackage = false;
  input.evidence.layout.supplementRoot = agentsRoot;
  input.evidence.renderUnits = [{ id: 'roles', physicalKey: 'roles-physical', renderScope: { kind: 'user' }, output: 'supplement', kinds: ['agent'], consumers: [] }];
  input.expected = { components: [{ id: 'role-a', name: 'a', kind: 'agent', content: { description: 'A', prompt: 'A body' } }],
    omitted: [], unmet: [], sources: { 'role-a': 'static', 'role-b': 'static' } };
  input.projections = [{ renderUnitId: 'roles', bundle: null, components: [{ id: 'role-a', nativeName: 'a', relativeOutputs: [] }], diagnostics: [],
    supplements: [{ id: 'role-a', kind: 'owned-file', componentIds: ['role-a'], destination: path.join(agentsRoot, 'a.toml'),
      stagingPath: path.join(root, 'a-staging'), contentDigest: 'a-body' }] }];
  for (const name of ['a', 'b'] as const) input.evidence.ownership.push({ state: name === 'a' ? 'absent' : 'present', physicalKey: 'roles-physical',
    component: { kind: 'owned-text-file', path: path.join(agentsRoot, `${name}.toml`), allowedRoot: agentsRoot,
      identity: { ...input.evidence.ownership[0]!.component.identity, artifactKey: `${name}.toml` } } });
  return input;
}
function context(after: DeploymentObservation): MutationContext {
  return { cwd: root, env: { HOME: root }, runner: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })), inspect: vi.fn(async () => after),
    services: { verifyEvidence: vi.fn(async () => true), publishPackage: vi.fn(async () => confirmed), writeContribution: vi.fn(async () => confirmed),
      removeOwned: vi.fn(async () => confirmed), setActivation: vi.fn(async () => confirmed), registerMarketplace: vi.fn(async () => confirmed) } };
}

describe('native platform lifecycle', () => {
  it('installs frozen bytes and uses the native local source without an invented scope flag', async () => {
    const input = fixture();
    const plan = prepared(input);
    input.projections[0]!.bundle!.stagingRoot = '/changed-after-review';
    const ctx = context({ ...input.observation, package: 'present', registration: 'present', consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'enabled' })) });
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(ctx.services.publishPackage).toHaveBeenCalledWith(plan.plan.binding, { stagingRoot: path.join(root, 'staging'), contentDigest: 'bundle' }, path.join(root, 'demo'), plan.driverState.packageComponent);
    expect(vi.mocked(ctx.runner!).mock.calls.map(([call]) => call.args)).toEqual([
      ['plugin', 'install', path.join(root, 'demo')], ['plugin', 'enable', 'demo'],
    ]);
    expect(receipt.effects.every((effect) => effect.status === 'applied')).toBe(true);
  });

  it.each([
    ['codex-marketplace', [['plugin', 'add', 'demo@marketplace']]],
    ['claude-marketplace', [['plugin', 'install', 'demo@marketplace', '--scope', 'user'], ['plugin', 'enable', 'demo@marketplace', '--scope', 'user']]],
    ['pi-package', [['install', path.join(root, 'demo')]]],
    ['copilot-marketplace', [['plugin', 'install', 'demo@marketplace']]],
    ['grok-cli', [['plugin', 'install', path.join(root, 'demo'), '--trust'], ['plugin', 'enable', 'demo']]],
  ] as const)('uses the fixed native lifecycle contract for %s', async (route, argv) => {
    const input = fixture(route);
    if (route.endsWith('-marketplace')) input.evidence.nativeIdentity!.registrationId = 'demo@marketplace';
    const ctx = context(route === 'grok-cli' ? grokCurrentObservation(input) : input.observation);
    await executePlatformLifecycle(ctx, prepared(input));
    expect(vi.mocked(ctx.runner!).mock.calls.map(([call]) => call.args)).toEqual(argv);
  });

  // Test Value Gate: the real Claude installer enables the selected scope and
  // rejects a repeated enable with exit 1. Reconcile its fresh owned state.
  it.each(['user', 'project'] as const)('accepts Claude installation already enabled at %s scope', async (scope) => {
    const input = fixture('claude-marketplace');
    input.binding.scope = scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot: root };
    input.evidence.nativeIdentity!.registrationId = 'demo@marketplace';
    const ctx = context({ ...input.observation, package: 'present', registration: 'present', ownership: 'aw',
      nativeIdentity: input.evidence.nativeIdentity,
      consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'enabled' })) });
    vi.mocked(ctx.runner!).mockImplementation(async (call) => ({ exitCode: call.args[1] === 'enable' ? 1 : 0,
      stdout: '', stderr: 'already enabled' }));
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(vi.mocked(ctx.runner!).mock.calls.map(([call]) => call.args)).toEqual([
      ['plugin', 'install', 'demo@marketplace', '--scope', scope === 'user' ? 'user' : 'local'],
    ]);
    expect(receipt.effects.map((effect) => effect.status)).toEqual(['applied', 'applied', 'unchanged']);
  });

  it('does not turn an unmet empty set or a foreign package into a deletion', () => {
    const input = fixture();
    input.expected.components = [];
    input.expected.unmet = [{ id: 'missing', componentId: 'skill', kind: 'skill', requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }], reasonCode: 'unsupported' }];
    expect(preparePlatformLifecycle(input).status).toBe('blocked');
    input.expected.components = fixture().expected.components;
    input.observation.ownership = 'foreign';
    expect(preparePlatformLifecycle(input).status).toBe('blocked');
  });

  it('writes a supported supplement while retaining an unmet supplement without a package replacement', async () => {
    const input = supplementOnlyFixture();
    input.expected.unmet = [{ id: 'role-b', name: 'b', kind: 'agent', reasonCode: 'capability-unverified',
      requiredFeatures: [{ feature: 'agent.tools', values: ['allowlist'] }] }];
    const plan = prepared(input);
    const ctx = context(input.observation);
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(plan.plan.effects).toMatchObject([{ kind: 'write-supplement', componentIds: ['role-a'], destination: path.join(root, 'agents/a.toml') }]);
    expect(ctx.services.writeContribution).toHaveBeenCalledTimes(1);
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.services.registerMarketplace).not.toHaveBeenCalled();
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(receipt.unmet).toEqual([{ ...input.expected.unmet[0], productIds: [] }]);
  });

  it('keeps supplement-only output when all requested components are unmet', () => {
    const input = supplementOnlyFixture();
    input.expected.components = [];
    input.expected.unmet = [{ id: 'role-b', name: 'b', kind: 'agent', requiredFeatures: [], reasonCode: 'capability-unverified' }];
    input.projections = [];
    expect(preparePlatformLifecycle(input)).toMatchObject({ status: 'blocked', diagnostics: [expect.objectContaining({ code: 'noSupportedComponents' })] });
  });

  it('cleans an intentionally closed supplement-only set without creating or removing a native package', async () => {
    const input = supplementOnlyFixture();
    input.expected.components = [];
    input.expected.omitted = [{ id: 'role-a', kind: 'agent', reason: 'config-disabled' }, { id: 'role-b', kind: 'agent', reason: 'config-disabled' }];
    input.projections = [];
    const plan = prepared(input);
    const ctx = context(input.observation);
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(plan.plan.effects).toMatchObject([{ kind: 'remove-owned', destination: path.join(root, 'agents/b.toml'), physicalKey: 'roles-physical' }]);
    expect(ctx.services.removeOwned).toHaveBeenCalledTimes(1);
    expect(ctx.services.removeOwned).toHaveBeenCalledWith(input.binding, input.evidence.ownership[2]!.component);
    expect(ctx.services.writeContribution).not.toHaveBeenCalled();
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(receipt.unmet).toEqual([]);
    expect(receipt.effects).toMatchObject([{ status: 'applied', mutation: 'confirmed' }]);
  });

  it('requires frozen global User intent before preparing Gemini project activation', () => {
    const input = fixture('gemini-extension');
    input.binding.scope = { kind: 'project', projectRoot: path.join(root, 'project') };
    const result = preparePlatformLifecycle(input);
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.diagnostics[0]?.code).toBe('nativeActivationEvidenceUnknown');
    input.evidence.userActivationEnabled = false;
    expect(preparePlatformLifecycle(input).status).toBe('ready');
  });

  // Test Value Gate: Grok's update exits zero with an old copy. The reviewed
  // replacement must preserve persistent data and confirm this attempt's bytes.
  it('replaces an exclusive Grok registration while preserving native plugin data', async () => {
    const input = grokRefreshFixture();
    const plan = prepared(input);
    expect(plan.plan.effects).toMatchObject([{ kind: 'publish-package' }, { kind: 'refresh', destructive: true }, { kind: 'activate' }]);
    const ctx = context(grokCurrentObservation(input));
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(vi.mocked(ctx.runner!).mock.calls.map(([call]) => call.args)).toEqual([
      ['plugin', 'uninstall', 'demo', '--confirm', '--keep-data'], ['plugin', 'install', path.join(root, 'demo'), '--trust'], ['plugin', 'enable', 'demo'],
    ]);
    expect(receipt.effects.every((effect) => effect.status === 'applied')).toBe(true);
    expect(receipt.unmet).toEqual([]);
  });

  it('retries a stale Grok copy when the AW source already has the current bytes', async () => {
    const input = grokRefreshFixture();
    input.evidence.contentMatches = true;
    input.observation.components[0] = { id: 'skill', presence: 'unknown', reasonCodes: ['nativePackageContentDrift'] };
    const plan = prepared(input);
    expect(plan.plan.effects.map((effect) => effect.kind)).toEqual(['refresh', 'activate']);
    const ctx = context(grokCurrentObservation(input));
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(receipt.effects.every((effect) => effect.status === 'applied')).toBe(true);
  });

  it.each(['foreign', 'shared', 'shared-reference', 'other-registration'] as const)('protects Grok %s content from native replacement', (boundary) => {
    const input = grokRefreshFixture();
    if (boundary === 'foreign' || boundary === 'shared') input.observation.ownership = boundary;
    if (boundary === 'shared-reference') input.evidence.sharedReferences = 'present';
    if (boundary === 'other-registration') input.observation.nativeIdentity!.registrationId = 'other-local-source';
    expect(preparePlatformLifecycle(input).status).toBe('blocked');
  });

  it('rechecks the exact Grok registration before native uninstall', async () => {
    const input = grokRefreshFixture();
    const ctx = context({ ...grokCurrentObservation(input), ownership: 'foreign' });
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(receipt.effects[0]).toMatchObject({ status: 'applied', mutation: 'confirmed' });
    expect(receipt.effects[1]).toMatchObject({ status: 'blocked', mutation: 'none' });
    expect(receipt.effects[1]!.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'grokNativeInstallRecovery' }));
    expect(receipt.effects[2]?.status).toBe('skipped');
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
  });

  it('keeps the new Grok source and explicit host recovery when install fails after uninstall', async () => {
    const input = grokRefreshFixture();
    const absent: DeploymentObservation = { ...input.observation, registration: 'absent',
      nativeIdentity: { ...input.evidence.nativeIdentity!, registrationId: undefined },
      consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'disabled', trust: 'unknown' })) };
    const ctx = context(absent);
    vi.mocked(ctx.inspect!).mockResolvedValueOnce(input.observation);
    vi.mocked(ctx.runner!).mockImplementation(async (call) => ({ exitCode: call.args[1] === 'install' ? 1 : 0, stdout: '', stderr: '' }));
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(receipt.effects).toMatchObject([{ status: 'applied', mutation: 'confirmed' }, { status: 'unknown', mutation: 'possible' }, { status: 'skipped' }]);
    expect(receipt.after.registration).toBe('absent');
    expect(receipt.unmet).toContainEqual(expect.objectContaining({ componentId: 'skill', reasonCode: 'platformMutationUnknown' }));
    expect(receipt.effects[1]!.diagnostics).toContainEqual(expect.objectContaining({ code: 'grokNativeInstallRecovery',
      message: expect.stringContaining(JSON.stringify(['plugin', 'install', path.join(root, 'demo'), '--trust'])) }));
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    input.evidence.contentMatches = true;
    input.observation = absent;
    const retry = context(absent);
    const retried = await executePlatformLifecycle(retry, prepared(input));
    expect(retry.runner).not.toHaveBeenCalled();
    expect(retried.effects[0]).toMatchObject({ status: 'blocked', mutation: 'none' });
    expect(retried.effects[0]!.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeTrustRequired' }));
  });

  it.each(['old-copy', 'unconfirmed'] as const)('does not activate or confirm a Grok %s after zero exit', async (state) => {
    const input = grokRefreshFixture();
    const after = grokCurrentObservation(input);
    after.nativePackageContentDigest = state === 'old-copy' ? 'old-bytes' : undefined;
    after.components[0] = { id: 'skill', presence: 'unknown', reasonCodes: [state === 'old-copy' ? 'nativePackageContentDrift' : 'nativePackageContentUnconfirmed'] };
    const ctx = context(after);
    vi.mocked(ctx.inspect!).mockResolvedValueOnce(input.observation);
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(vi.mocked(ctx.runner!).mock.calls.map(([call]) => call.args[1])).toEqual(['uninstall', 'install']);
    expect(receipt.effects[1]).toMatchObject({ status: 'unknown', mutation: 'possible' });
    expect(receipt.effects[2]?.status).toBe('skipped');
    expect(receipt.unmet.length).toBeGreaterThan(0);
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
  });

  it('retains registration facts but reports unmet host trust for a Pi Skill package', async () => {
    const input = fixture('pi-package');
    const ctx = context({ ...input.observation, package: 'present', registration: 'present', ownership: 'aw',
      consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'blocked', trust: 'required' })) });
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(receipt.effects.every((effect) => effect.status === 'applied')).toBe(true);
    expect(receipt.after).toMatchObject({ package: 'present', registration: 'present' });
    expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeTrustRequired', severity: 'error' }));
    expect(receipt.unmet).toEqual([expect.objectContaining({ componentId: 'skill', productIds: ['client'], reasonCode: 'nativeTrustRequired' })]);
  });

  it('leaves shared packages registered when removing only the requested activation', () => {
    const input = fixture();
    input.operation = 'remove';
    input.observation = { ...input.observation, package: 'present', registration: 'present', ownership: 'shared', consumers: input.observation.consumers.map((item) => ({ ...item, activation: 'enabled' })) };
    input.evidence.sharedReferences = 'present';
    input.evidence.ownership[0]!.state = 'present';
    const plan = prepared(input);
    expect(plan.plan.effects.map((effect) => effect.kind)).toEqual(['deactivate']);
  });

  it('cleans exclusive supplements when a missing client blocks native removal', async () => {
    const input = fixture();
    input.operation = 'cleanup';
    input.binding.consumers = [];
    input.observation = { ...input.observation, package: 'present', registration: 'present', ownership: 'aw' };
    input.evidence.ownership[0]!.state = 'present';
    input.evidence.ownership.push({ state: 'present', component: { kind: 'owned-text-file', path: path.join(root, 'rules/demo.md'), allowedRoot: path.join(root, 'rules'),
      identity: { ...input.evidence.ownership[0]!.component.identity, artifactKey: 'demo.md' } } });
    const ctx = context(input.observation);
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(ctx.services.removeOwned).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ctx.services.removeOwned).mock.calls[0]![1]).toMatchObject({ path: path.join(root, 'rules/demo.md') });
    expect(receipt.effects.some((effect) => effect.status === 'blocked')).toBe(true);
    expect(receipt.effects.some((effect) => effect.status === 'applied')).toBe(true);
    expect(receipt.effects.at(-1)?.status).toBe('skipped');
  });

  it('retains the recovery source when native uninstall exits zero but absent is not confirmed', async () => {
    const input = fixture();
    input.operation = 'remove';
    input.observation.package = 'present'; input.observation.registration = 'present'; input.observation.ownership = 'aw';
    input.evidence.ownership[0]!.state = 'present';
    const ctx = context(input.observation);
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(ctx.runner).toHaveBeenCalledTimes(1);
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(receipt.effects.find((effect) => effect.id.includes(':unregister:'))).toMatchObject({ status: 'unknown', mutation: 'possible' });
    expect(receipt.effects.at(-1)?.status).toBe('skipped');
  });

  it('preserves successful registration when activation fails', async () => {
    const input = fixture();
    const ctx = context({ ...input.observation, package: 'present', registration: 'present', ownership: 'aw' });
    vi.mocked(ctx.runner!).mockImplementation(async (call) => ({ exitCode: call.args.includes('enable') ? 1 : 0, stdout: '', stderr: '' }));
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(receipt.effects.find((effect) => effect.id.includes(':register:'))).toMatchObject({ status: 'applied', mutation: 'confirmed' });
    expect(receipt.effects.find((effect) => effect.id.includes(':activate:'))).toMatchObject({ status: 'unknown', mutation: 'possible' });
    expect(receipt.after.registration).toBe('present');
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(receipt.unmet[0]).toMatchObject({ componentId: 'skill', requiredFeatures: [] });
  });

  it('retains unknown changes after a timeout and skips dependent activation', async () => {
    const input = fixture();
    const ctx = context({ ...input.observation, registration: 'unknown' });
    vi.mocked(ctx.runner!).mockImplementation(async (invocation) => { throw new NativeCliError({ invocation, exitCode: 124, stdout: '', stderr: '', reason: 'timeout' }); });
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(receipt.effects.find((effect) => effect.id.includes(':register:'))).toMatchObject({ status: 'unknown', mutation: 'possible' });
    expect(receipt.effects.find((effect) => effect.id.includes(':activate:'))?.status).toBe('skipped');
    expect(ctx.runner).toHaveBeenCalledTimes(1);
  });

  it('stops stale plans before any writer or native command', async () => {
    const input = fixture();
    const ctx = context(input.observation);
    vi.mocked(ctx.services.verifyEvidence).mockResolvedValue(false);
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(receipt.diagnostics[0]?.code).toBe('operationPlanStale');
    expect(receipt.effects.every((effect) => effect.mutation === 'none')).toBe(true);
  });

  it('ensures a matching package and activation without writing again', async () => {
    const input = fixture();
    input.observation = { ...input.observation, package: 'present', registration: 'present', ownership: 'aw', consumers: input.observation.consumers.map((item) => ({ ...item, activation: 'enabled' })) };
    input.evidence.contentMatches = true;
    const plan = prepared(input);
    const ctx = context(input.observation);
    expect(plan.plan.effects).toEqual([]);
    expect((await executePlatformLifecycle(ctx, plan)).after.registration).toBe('present');
    expect(ctx.runner).not.toHaveBeenCalled();
  });

  it('keeps host supplements in their own frozen physical render unit', () => {
    const input = fixture();
    input.binding.renderUnitIds.push('rules');
    input.evidence.renderUnits = [
      { id: 'package', physicalKey: 'physical', renderScope: { kind: 'user' }, output: 'package', kinds: ['skill'], consumers: input.binding.consumers },
      { id: 'rules', physicalKey: 'rules-physical', renderScope: { kind: 'user' }, output: 'supplement', kinds: ['instruction'], consumers: input.binding.consumers },
    ];
    const destination = path.join(root, 'rules/demo.md');
    input.projections.push({ renderUnitId: 'rules', bundle: null, components: [], diagnostics: [], supplements: [
      { id: 'rules-body', kind: 'owned-file', componentIds: ['instruction'], destination, stagingPath: path.join(root, 'rules-staging'), contentDigest: 'rules-content' },
    ] });
    input.evidence.ownership.push({ state: 'absent', physicalKey: 'rules-physical', component: {
      kind: 'owned-text-file', path: destination, allowedRoot: path.dirname(destination), identity: { ...input.evidence.ownership[0]!.component.identity, artifactKey: 'demo.md' },
    } });
    expect(prepared(input).plan.effects.find((effect) => effect.kind === 'write-supplement')?.physicalKey).toBe('rules-physical');
    input.evidence.renderUnits = [];
    expect(preparePlatformLifecycle(input).status).toBe('blocked');
  });

  it('keeps existing output when package publication fails', async () => {
    const input = fixture();
    const old = { kind: 'owned-text-file' as const, path: path.join(root, 'rules/old.md'), allowedRoot: path.join(root, 'rules'), identity: {
      ...input.evidence.ownership[0]!.component.identity, artifactKey: 'old.md',
    } };
    input.evidence.ownership.push({ component: old, state: 'present' });
    const ctx = context(input.observation);
    vi.mocked(ctx.services.publishPackage).mockRejectedValue(Object.assign(new Error('write failed'), { mutation: 'none' }));
    const receipt = await executePlatformLifecycle(ctx, prepared(input));
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(receipt.effects.find((effect) => effect.id.includes(':remove-owned:'))?.status).toBe('skipped');
  });

  it.each(['claude-marketplace', 'cursor-workspace-hook'] as const)('matches and retracts the exact shared contribution for %s', async (route) => {
    const input = fixture(route);
    const destination = path.join(root, route === 'claude-marketplace' ? 'settings.json' : 'hooks.json');
    const mergeKey = route === 'claude-marketplace' ? 'permissions:test:demo' : 'workspaceOpen:aw-test-demo';
    const component: OwnedComponent = { kind: 'shared-config', label: 'host contribution',
      identity: { ...input.evidence.ownership[0]!.component.identity, artifactKey: route === 'claude-marketplace' ? 'permissions-test-demo' : 'workspaceOpen-demo' },
      locator: route === 'claude-marketplace' ? { kind: 'claude-permissions', settingsPath: destination, ownerKey: mergeKey }
        : { kind: 'cursor-workspace-hook', hooksPath: destination, ownerKey: mergeKey, command: 'aw internal cursor-workspace-open --scope user --plugin-id test/demo' } };
    const contribution = { id: 'host-entry', kind: 'config-entry' as const, componentIds: ['skill'], destination, mergeKey,
      contentDigest: 'host-entry-content', stagingPath: path.join(root, 'host-entry-staging') };
    input.projections[0]!.supplements = [contribution];
    input.evidence.ownership.push({ component, state: 'absent', physicalKey: 'host-entry-physical' });
    const ctx = context({ ...input.observation, package: 'present', registration: 'present', consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'enabled' })) });
    await executePlatformLifecycle(ctx, prepared(input));
    expect(ctx.services.writeContribution).toHaveBeenCalledWith(input.binding, contribution, component);
    input.evidence.ownership[1]!.component = { kind: 'owned-text-file', path: destination, allowedRoot: root, identity: component.identity };
    expect(preparePlatformLifecycle(input).status).toBe('blocked');
    input.evidence.ownership[1]!.component = component;
    if (component.locator.kind === 'cursor-workspace-hook') {
      component.locator.ownerKey = 'workspaceOpen:another-entry';
      expect(preparePlatformLifecycle(input).status).toBe('blocked');
      component.locator.ownerKey = mergeKey;
    }
    input.projections[0]!.supplements = [];
    input.evidence.ownership[1]!.state = 'present';
    input.evidence.contentMatches = true;
    input.observation = { ...input.observation, package: 'present', registration: 'present', ownership: 'aw',
      consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'enabled' })) };
    const retraction = prepared(input);
    const cleanup = context(input.observation);
    await executePlatformLifecycle(cleanup, retraction);
    expect(cleanup.services.writeContribution).not.toHaveBeenCalled();
    expect(cleanup.services.removeOwned).toHaveBeenCalledTimes(1);
    expect(cleanup.services.removeOwned).toHaveBeenCalledWith(input.binding, component);
    expect(retraction.plan.effects).toMatchObject([{ kind: 'remove-owned', destination, physicalKey: 'host-entry-physical' }]);
  });

  it.each([
    { existing: false, operation: 'ensure' },
    { existing: true, operation: 'ensure' },
    { existing: true, operation: 'reinstall' },
  ] as const)('keeps a previous package with unmet components but publishes fresh supported output ($existing, $operation)', async ({ existing, operation }) => {
    const input = fixture();
    input.operation = operation;
    input.expected.unmet = [{ id: 'hook-gap', componentId: 'blocked-hook', kind: 'hook', reasonCode: 'unsupportedFeedback',
      requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }] }];
    input.evidence.retainPackage = existing;
    if (existing) {
      input.evidence.ownership[0]!.state = operation === 'reinstall' ? 'partial' : 'present';
      input.observation = { ...input.observation, package: 'present', registration: 'present', ownership: 'aw' };
    }
    const plan = prepared(input);
    const ctx = context({ ...input.observation, package: 'present', registration: 'present',
      consumers: input.observation.consumers.map((consumer) => ({ ...consumer, activation: 'enabled' })) });
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(plan.plan.projections[0]?.bundle).toEqual(input.projections[0]?.bundle);
    expect(ctx.services.publishPackage).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(ctx.runner).toHaveBeenCalledTimes(existing ? 0 : 2);
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(receipt.unmet.find((gap) => gap.id === 'hook-gap')?.requiredFeatures).toEqual([{ feature: 'hook.common.before_tool', values: ['block'] }]);
    expect(receipt.unmet.filter((gap) => gap.reasonCode === 'packageUpdateBlockedByUnmet')).toEqual(existing ? [expect.objectContaining({ componentId: 'skill', kind: 'skill', requiredFeatures: [] })] : []);
    expect(plan.plan.expected.unmet.filter((gap) => gap.reasonCode === 'packageUpdateBlockedByUnmet')).toHaveLength(existing ? 1 : 0);
    expect(input.expected.unmet).toHaveLength(1);
    if (existing) expect(plan.plan.effects).toEqual([]);
  });

  it.each([false, true])('updates only independent Codex Agent files while retaining previous output (Agent has unmet: %s)', async (agentUnmet) => {
    const input = fixture('codex-marketplace');
    input.evidence.retainPackage = true;
    input.evidence.ownership[0]!.state = 'present';
    input.observation = { ...input.observation, ownership: 'aw', package: 'present', registration: 'unknown' };
    input.binding.consumers[0]!.availability = 'missing';
    input.evidence.nativeIdentity = null;
    input.binding.renderUnitIds.push('roles');
    input.evidence.layout.supplementRoot = path.join(root, 'agents');
    input.evidence.renderUnits = [{ id: 'roles', physicalKey: 'roles-physical', renderScope: { kind: 'user' }, output: 'supplement', kinds: ['agent'], consumers: input.binding.consumers }];
    input.expected.components.push({ id: 'new-role', name: 'new-role', kind: 'agent', content: { description: 'Role', prompt: 'Role body' } });
    input.expected.sources['new-role'] = 'static';
    input.expected.unmet = [{ id: 'hook-gap', componentId: 'unsupported-hook', kind: 'hook', requiredFeatures: [], reasonCode: 'unsupported' }];
    if (agentUnmet) input.expected.unmet.push({ id: 'role-gap', componentId: 'new-role', kind: 'agent', requiredFeatures: [], reasonCode: 'unsupported' });
    const rolePath = path.join(root, 'agents/new-role.toml');
    const role = { id: 'role-file', componentIds: ['new-role'], kind: 'owned-file' as const, destination: rolePath, contentDigest: 'role-content', stagingPath: path.join(root, 'role-staging') };
    input.projections.push({ renderUnitId: 'roles', bundle: null, components: [{ id: 'new-role', nativeName: 'new-role', relativeOutputs: [] }], supplements: [role], diagnostics: [] });
    const roleOwner = { ...input.evidence.ownership[0]!.component.identity, artifactKey: 'new-role.toml' };
    input.evidence.ownership.push({ state: 'absent', physicalKey: 'roles-physical', component: { kind: 'owned-text-file', path: rolePath, allowedRoot: path.dirname(rolePath), identity: roleOwner } });
    input.evidence.ownership.push({ state: 'present', physicalKey: 'roles-physical', component: { kind: 'owned-text-file', path: path.join(root, 'agents/old-role.toml'), allowedRoot: path.dirname(rolePath), identity: { ...roleOwner, artifactKey: 'old-role.toml' } } });
    const plan = prepared(input);
    const ctx = context(input.observation);
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(ctx.services.writeContribution).toHaveBeenCalledTimes(agentUnmet ? 0 : 1);
    expect(plan.plan.effects).toMatchObject(agentUnmet ? [] : [{ kind: 'write-supplement', componentIds: ['new-role'], physicalKey: 'roles-physical' }]);
    expect(receipt.unmet.filter((gap) => gap.reasonCode === 'packageUpdateBlockedByUnmet').map((gap) => gap.componentId)).toEqual(agentUnmet ? ['skill', 'new-role'] : ['skill']);
  });

  it('retains Grok Agent packages and their related rules together', async () => {
    const input = fixture('grok-cli');
    input.evidence.retainPackage = true;
    input.evidence.ownership[0]!.state = 'present';
    input.observation = { ...input.observation, ownership: 'aw', package: 'present', registration: 'present' };
    input.expected.components = [{ id: 'agent', name: 'agent', kind: 'agent', content: { description: 'Agent', prompt: 'Agent body' } },
      { id: 'instruction', name: 'instruction', kind: 'instruction', content: { title: 'Rules', content: 'New rules', coverage: ['main', 'plugin-agents'] } }];
    input.expected.unmet = [{ id: 'hook-gap', componentId: 'unsupported-hook', kind: 'hook', requiredFeatures: [], reasonCode: 'unsupported' }];
    input.projections[0]!.components = [{ id: 'agent', nativeName: 'agent', relativeOutputs: ['agents/agent.md'] }];
    const destination = path.join(root, 'rules/demo.md');
    input.projections[0]!.supplements.push({ id: 'rules', componentIds: ['instruction'], kind: 'owned-file', destination, contentDigest: 'new-rules', stagingPath: path.join(root, 'rules-staging') });
    input.evidence.ownership.push({ state: 'present', component: { kind: 'owned-text-file', path: destination, allowedRoot: path.dirname(destination),
      identity: { ...input.evidence.ownership[0]!.component.identity, artifactKey: 'demo.md' } } });
    const plan = prepared(input);
    const ctx = context(input.observation);
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(plan.plan.effects).toEqual([]);
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.services.writeContribution).not.toHaveBeenCalled();
    expect(ctx.services.removeOwned).not.toHaveBeenCalled();
    expect(ctx.runner).not.toHaveBeenCalled();
    expect(receipt.unmet.filter((gap) => gap.reasonCode === 'packageUpdateBlockedByUnmet').map((gap) => gap.componentId)).toEqual(['agent', 'instruction']);
  });

  it.each([false, true])('publishes Agent-only supplements without creating an empty native package (previous package: %s)', async (previousPackage) => {
    const input = fixture('codex-marketplace');
    const rolePath = path.join(root, 'agents/demo.toml');
    input.binding.renderUnitIds = ['package', 'roles'];
    input.expected.components = [{ kind: 'agent', id: 'role', name: 'demo', content: { description: 'Role', prompt: 'Role body' } }];
    input.expected.sources = { role: 'static' };
    input.projections = [{ renderUnitId: 'roles', bundle: null, components: [{ id: 'role', nativeName: 'demo', relativeOutputs: [] }], diagnostics: [],
      supplements: [{ id: 'role-file', componentIds: ['role'], kind: 'owned-file', destination: rolePath, stagingPath: path.join(root, 'role-staging'), contentDigest: 'role-body' }] }];
    input.evidence.renderUnits = [{ id: 'roles', physicalKey: 'roles-physical', renderScope: { kind: 'user' }, output: 'supplement', kinds: ['agent'], consumers: input.binding.consumers }];
    input.evidence.ownership.push({ state: 'absent', physicalKey: 'roles-physical', component: { kind: 'owned-text-file', path: rolePath, allowedRoot: path.dirname(rolePath),
      identity: { ...input.evidence.ownership[0]!.component.identity, artifactKey: 'demo.toml' } } });
    if (previousPackage) {
      input.observation.package = 'present'; input.observation.registration = 'present'; input.observation.ownership = 'aw';
      input.observation.consumers[0]!.activation = 'enabled'; input.evidence.ownership[0]!.state = 'present';
      input.evidence.nativeIdentity!.registrationId = 'demo@marketplace';
    } else {
      input.binding.consumers = []; input.observation.consumers = []; input.evidence.nativeIdentity = null;
    }
    const plan = prepared(input);
    const ctx = context(previousPackage ? { ...input.observation, registration: 'absent', nativeIdentity: input.evidence.nativeIdentity } : input.observation);
    const receipt = await executePlatformLifecycle(ctx, plan);
    expect(ctx.services.publishPackage).not.toHaveBeenCalled();
    expect(ctx.services.registerMarketplace).not.toHaveBeenCalled();
    expect(ctx.services.writeContribution).toHaveBeenCalledTimes(1);
    expect(receipt.effects.some((effect) => effect.id.includes(':register:') || effect.id.includes(':publish-package:'))).toBe(false);
    expect(ctx.services.removeOwned).toHaveBeenCalledTimes(previousPackage ? 1 : 0);
    expect(ctx.runner).toHaveBeenCalledTimes(previousPackage ? 1 : 0);
  });
});

describe('platform inspection and native activation', () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.remove(directory))); });
  async function environment(): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-platform-inspection-'));
    temporary.push(cwd);
    return { cwd, env: { HOME: cwd, USERPROFILE: cwd, GEMINI_CLI_HOME: cwd, AW_HOME: path.join(cwd, 'aw'), CODEX_HOME: path.join(cwd, 'codex') } };
  }

  it('observes required static supplements as present, drifted, missing or foreign without modifying them', async () => {
    const ctx = await environment();
    const { binding } = fixture('codex-marketplace');
    binding.scope = { kind: 'project', projectRoot: ctx.cwd };
    const entry = binding.consumers[0]!.entry!;
    if (entry.kind !== 'cli') throw new Error('Expected fixture CLI.');
    entry.configRoot = ctx.env.CODEX_HOME!;
    const layout = await getDeploymentLayout(ctx, binding);
    const destination = path.join(layout.supplementRoot!, 'aw-test-demo-reviewer.toml');
    const component = { id: 'agent:reviewer', kind: 'agent' as const, name: 'reviewer', content: { description: 'Review.', prompt: 'Review.' } };
    const identity = { ...deploymentPackageComponent(binding, layout).identity, scope: 'project' as const,
      physicalKey: layout.renderUnits.find((unit) => unit.output === 'supplement')!.physicalKey, artifactKey: path.basename(destination) };
    await writeOwnedTextFile({ path: destination, allowedRoot: layout.supplementRoot!, identity,
      content: 'name = "aw-test-demo-reviewer"\ndescription = "Review."\ndeveloper_instructions = "Review."\n' });
    expect(await inspectStaticSupplements(ctx, binding, [component])).toMatchObject({ owned: true,
      components: [{ id: component.id, presence: 'present', reasonCodes: [] }] });
    await fs.appendFile(destination, '# changed\n');
    expect((await inspectStaticSupplements(ctx, binding, [component])).components).toEqual([
      { id: component.id, presence: 'present', reasonCodes: ['componentContentDrift'] },
    ]);
    await fs.remove(destination);
    expect((await inspectStaticSupplements(ctx, binding, [component])).components).toEqual([
      { id: component.id, presence: 'absent', reasonCodes: ['componentOutputMissing'] },
    ]);
    await fs.outputFile(destination, 'foreign bytes\n');
    expect(await inspectStaticSupplements(ctx, binding, [component])).toMatchObject({ owned: false,
      components: [{ id: component.id, presence: 'unknown', reasonCodes: ['supplementOwnershipConflict'] }] });
    expect(await fs.readFile(destination, 'utf8')).toBe('foreign bytes\n');
  });

  it('projects only safe Pi consumer identities instead of package source URLs', async () => {
    const ctx = await environment();
    const binding = fixture().binding;
    binding.platform = 'pi'; binding.route = 'pi-package';
    binding.consumers[0]!.entry = { kind: 'cli', executable: path.join(ctx.cwd, 'missing-pi'), configRoot: path.join(ctx.cwd, '.pi/agent') };
    const layout = await getDeploymentLayout(ctx, binding);
    binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    await fs.outputJson(layout.activationPath, { packages: ['git:https://secret-token@example.invalid/pi-subagents'] });
    const observation = await inspectDeployment(ctx, binding);
    expect(observation.prerequisites.agentConsumers.observation).toBe('unknown');
    expect(observation.prerequisites.agentConsumers.candidates).toEqual([]);
    expect(JSON.stringify(observation)).not.toContain('secret-token');
  });

  it('distinguishes owned directory materialization from host activation and loading', async () => {
    const ctx = await environment();
    const binding = fixture().binding;
    binding.route = 'antigravity-directory';
    binding.consumers[0]!.entry = { kind: 'directory', configRoot: path.join(ctx.cwd, '.gemini/config') };
    const layout = await getDeploymentLayout(ctx, binding);
    binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    await fs.ensureDir(layout.packageRoot);
    await fs.writeFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(deploymentPackageComponent(binding, layout).identity, {
      physicalIdentity: layout.physicalIdentity,
      components: [{ id: 'skill', nativeName: 'demo', relativeOutputs: ['skills/demo/SKILL.md'] }], inputDigest: `sha256:${'a'.repeat(64)}`, contentDigest: `sha256:${'b'.repeat(64)}`,
    }));
    await fs.outputFile(path.join(layout.packageRoot, 'skills/demo/SKILL.md'), 'body');
    const observation = await inspectDeployment(ctx, binding);
    expect(observation).toMatchObject({ package: 'present', ownership: 'aw', registration: 'not-applicable' });
    expect(observation.consumers[0]).toMatchObject({ activation: 'unknown', trust: 'unknown', load: 'not-observed' });
    expect(observation.components).toEqual([{ id: 'skill', presence: 'present', reasonCodes: [] }]);
    await fs.remove(path.join(layout.packageRoot, 'skills/demo/SKILL.md'));
    expect((await inspectDeployment(ctx, binding)).components[0]?.presence).toBe('absent');
    await fs.writeJson(path.join(layout.packageRoot, SKILL_OWNER_MARKER), { broken: true });
    expect((await inspectDeployment(ctx, binding)).ownership).not.toBe('aw');
  });

  it('keeps native registration unknown when a read-only probe fails', async () => {
    const ctx = await environment();
    const binding = fixture().binding;
    binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/agy', configRoot: path.join(ctx.cwd, '.gemini/config') };
    binding.physicalKey = (await getDeploymentLayout(ctx, binding)).renderUnits[0]!.physicalKey;
    const runner = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'arbitrary unsafe log' }));
    const observation = await inspectDeployment({ ...ctx, runner }, binding);
    expect(observation.registration).toBe('unknown');
    expect(observation.package).toBe('absent');
    expect(JSON.stringify(observation)).not.toContain('arbitrary unsafe log');
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('restores disabled user activation while enabling only the reviewed Codex project', async () => {
    const ctx = await environment();
    const input = fixture();
    input.binding.platform = 'codex';
    input.binding.route = 'codex-marketplace';
    input.binding.scope = { kind: 'project', projectRoot: path.join(ctx.cwd, 'project') };
    input.binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/codex', configRoot: path.join(ctx.cwd, 'codex') };
    input.evidence.userActivationEnabled = false;
    const identity = { route: 'codex-marketplace' as const, packageId: 'demo', registrationId: 'demo@aw-test', sourceLocation: path.join(ctx.cwd, 'source') };
    const services = createNativeLifecycleServices(ctx, input.evidence);
    expect(await services.setActivation(input.binding, identity, true)).toMatchObject({ mutation: 'confirmed' });
    const user = await readCodexConfigFile(path.join(ctx.cwd, 'codex/config.toml'));
    const project = await readCodexConfigFile(path.join(ctx.cwd, 'project/.codex/config.toml'));
    expect(user.snapshot.plugins['demo@aw-test']?.enabled).toBe(false);
    expect(project.snapshot.plugins['demo@aw-test']?.enabled).toBe(true);
  });

  it('does not authorize offline activation changes through a foreign marketplace mapping', async () => {
    const ctx = await environment();
    const input = fixture('codex-marketplace');
    input.binding.consumers[0]!.entry = { kind: 'directory', configRoot: ctx.env.CODEX_HOME! };
    input.binding.consumers[0]!.availability = 'missing';
    const layout = await getDeploymentLayout(ctx, input.binding);
    input.binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    const component = deploymentPackageComponent(input.binding, layout);
    await fs.outputFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(component.identity));
    await upsertCodexMarketplaceFile(path.join(ctx.env.CODEX_HOME!, 'config.toml'), layout.marketplaceName!, { source: path.join(ctx.cwd, 'foreign'), sourceType: 'local' });
    const observed = await inspectDeployment(ctx, input.binding);
    expect(observed).toMatchObject({ package: 'present', ownership: 'foreign', registration: 'unknown' });
    const candidate = preparePlatformLifecycle({ ...input, operation: 'cleanup', observation: observed, projections: [],
      evidence: { ...input.evidence, layout, nativeIdentity: layout.nativeIdentity, sharedReferences: 'unknown',
        ownership: [{ component, state: 'present' }] } });
    if (candidate.status !== 'ready') throw new Error('Expected a non-destructive frozen cleanup candidate.');
    expect(candidate.prepared.plan.effects).toEqual([]);
  });

  it('requires the canonical marketplace mapping even when Codex lists a cached installation', async () => {
    const ctx = await environment();
    const { binding } = fixture('codex-marketplace');
    binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/codex', configRoot: ctx.env.CODEX_HOME! };
    const layout = await getDeploymentLayout(ctx, binding);
    binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    const owner = deploymentPackageComponent(binding, layout);
    await fs.outputFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(owner.identity));
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({
      installed: [{ pluginId: layout.nativeIdentity.registrationId, installed: true, enabled: true }], available: [],
    }), stderr: '' }));
    expect(await inspectDeployment({ ...ctx, runner }, binding)).toMatchObject({ package: 'present', registration: 'absent', ownership: 'aw' });
    const configPath = path.join(ctx.env.CODEX_HOME!, 'config.toml');
    await expect(fs.pathExists(configPath)).resolves.toBe(false);
    await upsertCodexMarketplaceFile(configPath, layout.marketplaceName!, { source: layout.marketplaceRoot!, sourceType: 'local' });
    expect(await inspectDeployment({ ...ctx, runner }, binding)).toMatchObject({ package: 'present', registration: 'present', ownership: 'aw' });
    // Real Windows Codex persists its canonical directory with a namespace.
    // Exercise parser -> inspect -> register without another registration write.
    await upsertCodexMarketplaceFile(configPath, layout.marketplaceName!, { source: path.toNamespacedPath(layout.marketplaceRoot!), sourceType: 'local' });
    expect(await inspectDeployment({ ...ctx, runner }, binding)).toMatchObject({ package: 'present', registration: 'present', ownership: 'aw' });
    const services = createNativeLifecycleServices({ ...ctx, runner }, fixture('codex-marketplace').evidence);
    const previousCalls = runner.mock.calls.length;
    await expect(services.registerMarketplace(binding, layout.nativeIdentity)).resolves.toMatchObject({ changed: false, mutation: 'none' });
    expect(runner).toHaveBeenCalledTimes(previousCalls);
    const offline = { ...binding, consumers: [{ ...binding.consumers[0]!, availability: 'missing' as const,
      entry: { kind: 'directory' as const, configRoot: ctx.env.CODEX_HOME! } }] };
    expect(await inspectDeployment(ctx, offline)).toMatchObject({ package: 'present', registration: 'unknown', ownership: 'aw' });
    const foreign = path.join(ctx.cwd, 'foreign');
    await upsertCodexMarketplaceFile(configPath, layout.marketplaceName!, { source: foreign, sourceType: 'local' });
    expect(await inspectDeployment({ ...ctx, runner }, binding)).toMatchObject({ ownership: 'foreign' });
    expect((await readCodexConfigFile(configPath)).snapshot.marketplaces[layout.marketplaceName!]?.source).toBe(foreign);
  });

  // Test Value Gate: the real local-source display prefix must not turn an
  // already registered AW marketplace into foreign content during update.
  it.each(['', 'Local: '])('retains the canonical Copilot marketplace with source prefix %j', async (prefix) => {
    const ctx = await environment();
    const input = fixture('copilot-marketplace');
    input.binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/copilot', configRoot: path.join(ctx.cwd, '.copilot') };
    const layout = await getDeploymentLayout(ctx, input.binding);
    const runner = vi.fn(async (_call: NativeCliInvocation) => ({ exitCode: 0,
      stdout: JSON.stringify([{ name: layout.marketplaceName, source: `${prefix}${layout.marketplaceRoot}` }]), stderr: '' }));
    const services = createNativeLifecycleServices({ ...ctx, runner }, input.evidence);
    await expect(services.registerMarketplace(input.binding, layout.nativeIdentity)).resolves.toMatchObject({ changed: false, mutation: 'none' });
    expect(runner.mock.calls.map(([call]) => call.args)).toEqual([['plugin', 'marketplace', 'list', '--json']]);
  });

  it.each([{ source: 'directory', path: '/foreign' }, 'Local: /foreign', 'Local: relative'])('does not repoint a foreign Copilot marketplace: %j', async (source) => {
    const ctx = await environment();
    const input = fixture('copilot-marketplace');
    input.binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/copilot', configRoot: path.join(ctx.cwd, '.copilot') };
    const layout = await getDeploymentLayout(ctx, input.binding);
    const runner = vi.fn(async (_call: NativeCliInvocation) => ({ exitCode: 0, stdout: JSON.stringify([{ name: layout.marketplaceName, source }]), stderr: '' }));
    const services = createNativeLifecycleServices({ ...ctx, runner }, input.evidence);
    await expect(services.registerMarketplace(input.binding, layout.nativeIdentity)).rejects.toMatchObject({ code: 'marketplaceRegistrationForeign', mutation: 'none' });
    expect(runner.mock.calls.map(([call]) => call.args)).toEqual([['plugin', 'marketplace', 'list', '--json']]);
  });

  // Test Value Gate: slow Copilot inventories must overlap without an early
  // return on failure or loss of the source and row safety checks.
  it.each([
    { issue: 'foreign source', marketplace: 'foreign', plugin: 'valid', delayed: 'marketplace', ownership: 'foreign', registration: 'present' },
    { issue: 'unknown source', marketplace: 'unknown', plugin: 'valid', delayed: 'marketplace', ownership: 'unknown', registration: 'present' },
    { issue: 'invalid plugin row', marketplace: 'canonical', plugin: 'invalid', delayed: 'marketplace', ownership: 'aw', registration: 'unknown' },
    { issue: 'failed plugin read', marketplace: 'foreign', plugin: 'failed', delayed: 'marketplace', ownership: 'foreign', registration: 'unknown' },
    { issue: 'failed marketplace read', marketplace: 'failed', plugin: 'valid', delayed: 'plugin', ownership: 'aw', registration: 'unknown' },
  ] as const)('finishes both Copilot inventories and preserves $issue', async (testCase) => {
    const ctx = await environment();
    const { binding } = fixture('copilot-marketplace');
    binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/copilot', configRoot: path.join(ctx.cwd, '.copilot') };
    const layout = await getDeploymentLayout(ctx, binding);
    binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    const owner = deploymentPackageComponent(binding, layout);
    await fs.outputFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(owner.identity));
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const started = new Set<string>();
    const runner = vi.fn(async (call: NativeCliInvocation) => {
      const read = call.args[1] === 'marketplace' ? 'marketplace' : 'plugin';
      started.add(read);
      if (read === testCase.delayed) await readGate;
      if (testCase[read] === 'failed') return { exitCode: 1, stdout: '', stderr: 'inventory unavailable' };
      const source = testCase.marketplace === 'foreign' ? '/foreign'
        : testCase.marketplace === 'unknown' ? {} : layout.marketplaceRoot;
      const rows = read === 'marketplace' ? [{ name: layout.marketplaceName, source }]
        : testCase.plugin === 'invalid' ? [null]
          : [{ name: layout.nativeIdentity.packageId, marketplace: layout.marketplaceName, source: layout.marketplaceRoot }];
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' };
    });
    let settled = false;
    const pending = inspectDeployment({ ...ctx, runner }, binding).then((observation) => {
      settled = true;
      return observation;
    });
    try {
      await vi.waitFor(() => { expect(started).toEqual(new Set(['marketplace', 'plugin'])); });
      expect(settled).toBe(false);
    } finally {
      releaseRead();
      await pending;
    }
    expect(await pending).toMatchObject({ ownership: testCase.ownership, registration: testCase.registration });
  });

  it('uses Gemini local-source metadata and does not treat home-only disable as global disable', async () => {
    const ctx = await environment();
    const input = fixture('gemini-extension');
    input.binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/gemini', configRoot: path.join(ctx.cwd, '.gemini') };
    const layout = await getDeploymentLayout(ctx, input.binding);
    input.binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    await fs.outputFile(path.join(layout.packageRoot, SKILL_OWNER_MARKER), createSkillOwnerMarkerContent(deploymentPackageComponent(input.binding, layout).identity));
    const installed = path.join(ctx.cwd, '.gemini/extensions/demo');
    const metadataPath = path.join(installed, '.gemini-extension-install.json');
    await fs.outputJson(metadataPath, { type: 'local', source: layout.packageRoot });
    await fs.outputJson(path.join(installed, 'gemini-extension.json'), { name: 'demo', version: '1.0.0' });
    await fs.outputJson(path.join(ctx.cwd, '.gemini/extensions/extension-enablement.json'), { demo: { overrides: [`!${geminiScopePattern(ctx.cwd)}`] } });
    const runner = vi.fn(async () => { throw new Error('Gemini metadata inspection must not start a client.'); });
    const observation = await inspectDeployment({ ...ctx, runner }, input.binding);
    expect(observation).toMatchObject({ registration: 'present', ownership: 'aw' });
    expect(observation.consumers[0]?.activation).toBe('unknown');
    expect(observation.diagnostics[0]?.code).toBe('nativeActivationScopeLimited');
    await fs.writeJson(metadataPath, { type: 'local', source: '/foreign' });
    expect((await inspectDeployment({ ...ctx, runner }, input.binding)).ownership).toBe('foreign');
    await fs.writeFile(metadataPath, '{invalid');
    expect((await inspectDeployment({ ...ctx, runner }, input.binding)).registration).toBe('unknown');
    expect(runner).not.toHaveBeenCalled();
  });

  it('observes user Codex activation from a neutral directory instead of the calling project overlay', async () => {
    const ctx = await environment();
    const project = path.join(ctx.cwd, 'project');
    await fs.ensureDir(project);
    const input = fixture('codex-marketplace');
    input.binding.consumers[0]!.entry = { kind: 'cli', executable: '/fake/codex', configRoot: path.join(ctx.cwd, 'codex') };
    const layout = await getDeploymentLayout(ctx, input.binding);
    input.binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    await upsertCodexMarketplaceFile(path.join(ctx.env.CODEX_HOME!, 'config.toml'), layout.marketplaceName!,
      { source: layout.marketplaceRoot!, sourceType: 'local' });
    const runner = vi.fn(async (call: NativeCliInvocation) => ({ exitCode: 0, stdout: JSON.stringify({ installed: [{ pluginId: layout.nativeIdentity.registrationId,
      installed: true, enabled: call.cwd !== project, version: '1.0.0', source: { path: layout.packageRoot } }], available: [] }), stderr: '' }));
    const observation = await inspectDeployment({ ...ctx, cwd: project, runner }, input.binding);
    expect(observation.registration).toBe('present');
    expect(observation.consumers[0]?.activation).toBe('enabled');
    expect(runner.mock.calls).toHaveLength(1);
    expect(runner.mock.calls[0]![0].cwd).not.toBe(project);
  });
});
