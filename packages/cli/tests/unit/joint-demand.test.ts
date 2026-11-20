import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import { deriveJointDemand, deriveSharedReferenceView, type JointDemandSnapshot } from '../../src/recovery/joint-demand.js';
import { aggregateConvergence, readRecoveryStatus, type RecoveryStatus } from '../../src/recovery/status.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createEmptyPreferences, parsePreferences, type AgentId } from '../../src/intent/deployment-preferences.js';
import { demandNativeProjection, resolveDelivery, type DemandSnapshot } from '../../src/recovery/demand.js';
import type { DeploymentObservation } from '../../src/platforms/contracts.js';
import type { PluginMeta, Scope } from '../../src/types.js';
function snapshot(user: string[], project: string[], targets: AgentId[] = ['cursor']): JointDemandSnapshot {
  const plugins = [plugin('a', ['d']), plugin('b', ['d']), plugin('d')];
  const demand = (scope: Scope, roots: string[]): DemandSnapshot => ({ scope,
    intent: { state: 'absent' }, preferences: { state: 'absent' }, plugins, errors: [],
    roots: roots.map((name) => ({ pluginId: `local/${name}`, sourceId: 'local', sourceState: 'ready', blockers: [],
      plugin: plugins.find((entry) => entry.manifest.name === name)! })) });
  return { context: { context: 'project', cwd: '/project', projectRoot: '/project', scopes: ['user', 'project'] },
    user: demand('user', user), project: demand('project', project), preferences: { ...createEmptyPreferences(), targets } };
}
function plugin(name: string, dependencies: string[] = []): PluginMeta {
  return { pluginId: `local/${name}`, sourceId: 'local', sourceIdentity: 'path:local', catalogLogicalIdentity: 'catalog:local',
    manifest: { schemaVersion: 4, name, version: '1.0.0', description: name, dependencies, skills: './skills', platforms: ['cursor'] },
  } as PluginMeta;
}
describe('joint requirements', () => {
  it.each(['unknown', 'blocked'] as const)('keeps a selected dependency incomplete when its own dependency is %s', async (state) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const input = snapshot(['a'], []);
    input.context = { context: 'user', cwd: layout.fixtureCwd, scopes: ['user'] };
    input.project = undefined;
    input.user.plugins.find((entry) => entry.manifest.name === 'd')!.manifest.dependencies = ['e'];
    input.user.plugins.push(plugin('e'));
    input.user.preferences = { state: 'valid', value: input.preferences!, digest: 'test', rawDigest: 'test', rawBytes: Buffer.from('{}') };
    const result = await readRecoveryStatus({ cwd: layout.fixtureCwd, env, plugins: ['local/d'], targets: ['cursor'],
      nativeObservations: ['a', 'd', 'e'].map((name) => ({ pluginId: `local/${name}`, platform: 'cursor',
        content: name === 'e' && state === 'unknown' ? 'unknown' : 'satisfied',
        blockers: name === 'e' && state === 'blocked' ? [{ code: 'nativeActivationUnconfirmed', message: 'Activation unknown.' }] : [] })) }, input);
    expect(result.inventory?.map((entry) => entry.pluginId)).toEqual(['local/d']);
    expect(result.inventory![0]!.targetResults[0]!.content).toBe('satisfied');
    expect(result.coverage.requestComplete).toBe(false);
    expect(result.counts.ready).toBe(1);
  });

  it('does not let an unrelated Generic root failure change a Native-only query', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const input = snapshot(['d'], []);
    input.context = { context: 'user', cwd: layout.fixtureCwd, scopes: ['user'] };
    input.project = undefined;
    input.user.preferences = { state: 'valid', value: input.preferences!, digest: 'test', rawDigest: 'test', rawBytes: Buffer.from('{}') };
    await fs.outputFile(path.join(env.HOME!, '.agents', 'skills'), 'unrelated invalid Generic root');
    const result = await readRecoveryStatus({ cwd: layout.fixtureCwd, env, plugins: ['local/d'], targets: ['cursor'],
      nativeObservations: [{ pluginId: 'local/d', platform: 'cursor', content: 'satisfied', blockers: [] }] }, input);
    expect(result.coverage.requestComplete).toBe(true);
    expect(result.inventory![0]!.targetResults[0]!.content).toBe('satisfied');
  });

  it('projects a selected dependency while retaining unobserved global demand as unknown', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const input = snapshot(['a', 'b'], []);
    input.context = { context: 'user', cwd: layout.fixtureCwd, scopes: ['user'] };
    input.project = undefined;
    input.user.preferences = { state: 'valid', value: input.preferences!, digest: 'test', rawDigest: 'test', rawBytes: Buffer.from('{}') };
    const observations = ['a', 'b', 'd'].map((name) => ({ pluginId: `local/${name}`, platform: 'cursor' as const,
      content: 'satisfied' as const, blockers: [] }));
    const selected = await readRecoveryStatus({ cwd: layout.fixtureCwd, env, plugins: ['local/d'], nativeObservations: observations }, input);
    expect(selected.inventory).toHaveLength(1);
    expect(selected.inventory![0]!.targetResults).toEqual([expect.objectContaining({ pluginId: 'local/d',
      relation: 'dependency', requiredBy: ['local/a', 'local/b'], providerScope: 'user', content: 'satisfied' })]);
    expect(selected.allSatisfied).toBeNull();
    expect(selected.inSync).toBeNull();
    expect(selected.coverage).toMatchObject({ requestComplete: true, native: false });
    const full = await readRecoveryStatus({ cwd: layout.fixtureCwd, env, nativeObservations: observations }, input);
    expect(full.allSatisfied).toBe(true);
    expect(full.observedTargets?.find((target) => target.pluginId === 'local/d')?.content)
      .toBe(selected.inventory![0]!.targetResults[0]!.content);
  });

  // Test Value Gate: both root paths must survive while a shared dependency has one provider.
  it('expands both closures and assigns the shared dependency to user', () => {
    const input = snapshot(['a'], ['b'], ['generic']);
    for (const plugin of input.user.plugins) plugin.manifest.platforms = ['generic'];
    const plan = deriveJointDemand(input);
    expect(plan.errors).toEqual([]);
    expect(plan.placements.map((item) => [item.pluginId, item.scope])).toEqual([
      ['local/d', 'user'], ['local/a', 'user'], ['local/b', 'project'],
    ]);
    expect(plan.placements[0]!.contributions).toEqual([
      { root: 'local/a', scope: 'user', path: ['local/a', 'local/d'] },
      { root: 'local/b', scope: 'project', path: ['local/b', 'local/d'] },
    ]);
  });
  it('rejects an excluded dependency even when user requests that provider directly', () => {
    const input = snapshot(['d'], ['b']);
    input.preferences!.exclusions = [{ plugin: 'local/d', target: 'cursor' }];
    const plan = deriveJointDemand(input);
    expect(plan.roots.map((entry) => entry.state)).toEqual(['excluded', 'blocked']);
    expect(plan.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dependencyExcluded', message: expect.stringContaining('local/b → local/d') })]));
    expect(plan.placements).toEqual([]);
  });
  // Test Value Gate: explicit roots retain both scopes; separate native directories also require their own dependency closure.
  it.each(['cursor', 'opencode', 'pi', 'codex', 'generic'] as const)('keeps an explicit %s root and its required dependency placements', (target) => {
    const input = snapshot(['a'], ['a'], [target]);
    for (const plugin of input.user.plugins) plugin.manifest.platforms = [target];
    const plan = deriveJointDemand(input);
    expect(plan.placements.map((item) => [item.pluginId, item.scope])).toEqual(
      target === 'codex' || target === 'generic'
        ? [['local/d', 'user'], ['local/a', 'user'], ['local/a', 'project']]
        : [['local/d', 'user'], ['local/d', 'project'], ['local/a', 'user'], ['local/a', 'project']],
    );
    expect(plan.placements.find((item) => item.pluginId === 'local/a' && item.scope === 'project')!.contributions)
      .toEqual([{ root: 'local/a', scope: 'project', path: ['local/a'] }]);
  });
  // Test Value Gate: every concrete Agent remains a native requirement, including dynamic-only or intentionally empty plugins.
  it('routes all concrete Agents to native and preserves their provider protection', () => {
    const targets: AgentId[] = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok'];
    const input = snapshot(['a'], [], [...targets, 'generic']);
    const root = input.user.roots![0]!;
    root.plugin!.manifest.platforms = [...targets, 'generic'];
    delete root.plugin!.manifest.skills;
    root.plugin!.manifest.artifacts = { configKeys: [] };
    input.user.preferences = { state: 'valid', value: input.preferences!, digest: 'sha256:test', rawDigest: 'sha256:test', rawBytes: Buffer.from('{}') };
    expect(targets.map((target) => resolveDelivery(root.plugin!.manifest, target, 'user')))
      .toEqual(targets.map((platform) => ({ kind: 'native', platform })));
    expect(resolveDelivery(root.plugin!.manifest, 'generic', 'user'))
      .toEqual({ kind: 'agent-skills', provider: 'aw', agentId: 'generic' });
    expect(demandNativeProjection(input.user).roots).toEqual([{ pluginId: 'local/a', platforms: targets }]);
  });
  it('retains a dependency contributed by an unexcluded project root', () => {
    const input = snapshot(['a'], ['b']);
    input.preferences!.exclusions = [{ plugin: 'local/a', target: 'cursor' }];
    expect(deriveJointDemand(input).placements.map((item) => [item.pluginId, item.scope])).toEqual([
      ['local/d', 'project'], ['local/b', 'project'],
    ]);
  });
  it.each(['intent', 'manifest'] as const)('marks only reusable Project providers uncertain when User %s is unreadable', (failure) => {
    const input = snapshot(['a'], ['b'], ['cursor', 'codex']);
    input.user.plugins.forEach((item) => { item.manifest.platforms = ['cursor', 'codex']; });
    if (failure === 'intent') input.user.roots = null;
    else {
      input.user.roots![0]!.plugin = undefined;
      input.user.roots![0]!.blockers = ['pluginManifestUnavailable'];
    }
    const plan = deriveJointDemand(input);
    expect(plan.complete).toBe(false);
    expect(plan.roots.filter((entry) => entry.scope === 'project').map((entry) => [entry.target, entry.state]))
      .toEqual([['cursor', 'required'], ['codex', 'unknown']]);
    expect(plan.placements.map((item) => [item.pluginId, item.target, item.scope]))
      .toEqual([['local/d', 'cursor', 'project'], ['local/b', 'cursor', 'project']]);
  });
  // Test Value Gate: renderer scopes select dynamic render units and must not remove native demand before preparation.
  it('retains both native requirements when dynamic output is restricted to project rendering', () => {
    const input = snapshot(['a'], ['b']);
    const dependency = input.user.plugins.find((entry) => entry.pluginId === 'local/d')!;
    delete dependency.manifest.skills;
    dependency.manifest.artifacts = { configKeys: [], scopes: ['project'] };
    const plan = deriveJointDemand(input);
    expect(plan.complete).toBe(true);
    expect(plan.errors).toEqual([]);
    expect(plan.roots).toEqual([
      expect.objectContaining({ pluginId: 'local/a', scope: 'user', target: 'cursor', state: 'required', blockers: [] }),
      expect.objectContaining({ pluginId: 'local/b', scope: 'project', target: 'cursor', state: 'required', blockers: [] }),
    ]);
    expect(plan.placements.map((entry) => [entry.pluginId, entry.scope])).toEqual([
      ['local/d', 'user'], ['local/d', 'project'], ['local/a', 'user'], ['local/b', 'project'],
    ]);
  });
  it('keeps invalid dependency platform declarations blocked instead of unsupported', () => {
    const input = snapshot(['a'], ['b']);
    input.user.plugins.find((entry) => entry.pluginId === 'local/d')!.manifest.platforms = ['pi'];
    const plan = deriveJointDemand(input);
    expect(plan.roots.map((entry) => entry.state)).toEqual(['blocked', 'blocked']);
    expect(plan.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dependencyContractInvalid' }),
    ]));
    expect(plan.roots.every((entry) => entry.reasons === undefined)).toBe(true);
    expect(plan.placements).toEqual([]);
  });
  it('rejects old scoped preferences and legacy target IDs', () => {
    expect(() => parsePreferences({ schemaVersion: 1, kind: 'aw-deployment-preferences', agents: ['codex'], dependencyScopeOverrides: [] })).toThrow();
    expect(() => parsePreferences({ ...createEmptyPreferences(), targets: ['claude-code'] })).toThrow();
    expect(parsePreferences({ ...createEmptyPreferences(), targets: ['claude', 'antigravity', 'generic'] }).targets).toEqual(['antigravity', 'claude', 'generic']);
  });
});
describe('native placement and convergence', () => {
  // Test Value Gate: generic Skills and native packages use separate layouts; target IDs cannot establish a path collision.
  it('retains native and generic placements across both requirement scopes', () => {
    const input = snapshot(['a'], ['b'], ['antigravity', 'cursor', 'generic']);
    for (const plugin of input.user.plugins) plugin.manifest.platforms = ['antigravity', 'cursor', 'generic'];
    const plan = deriveJointDemand(input);
    expect(plan.errors).toEqual([]);
    expect(plan.placements).toHaveLength(11);
    expect(plan.roots.every((root) => root.state === 'required')).toBe(true);
  });
  it.each([[false, 'absent', false], [null, 'absent', null], [true, 'unknown', null],
    [null, 'present', false], [true, 'absent', true]] as const)('keeps known failure before unknown: %s, %s', (satisfied, residue, expected) => {
    expect(aggregateConvergence(satisfied, residue)).toBe(expected);
  });
});

// Test Value Gate: shared removal uses desired demand after revocation and keeps the scope and completeness of actual observations.
describe('operation-local shared reference coverage', () => {
  it('keeps remaining user demand separate from a revoked project activation', () => {
    const input = snapshot(['d'], [], ['codex']);
    for (const plugin of input.user.plugins) plugin.manifest.platforms = ['codex'];
    const after: DeploymentObservation = { physicalKey: 'shared-codex-package', package: 'present', registration: 'present',
      configuration: { scope: 'project', activation: 'enabled', reasonCodes: [] },
      ownership: 'aw', consumers: [{ productId: 'codex-cli', activationKey: 'project-activation', activation: 'enabled',
        load: 'not-observed' }], components: [], nativeIdentity: null,
      prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } }, diagnostics: [] };
    const current: RecoveryStatus = { schemaVersion: 1, kind: 'aw-recovery-status', scope: 'project', ok: true,
      intent: { state: 'valid' }, selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
      inventory: null, extraObserved: [{ pluginId: 'local/d', agent: 'codex', scope: 'project',
        delivery: { kind: 'native', platform: 'codex' }, observation: 'verified', content: 'satisfied',
        deploymentObservations: [{ bindingId: 'project-binding', products: [], after }] }],
      coverage: { native: true, portable: true }, inSync: null, counts: { blocked: 0, unconfirmed: 0, pending: 0, ready: 0 },
      allSatisfied: null, errors: [] };
    const view = deriveSharedReferenceView(input, deriveJointDemand(input), current);
    expect(view).toMatchObject({ scopes: ['user', 'project'], projectRoot: '/project', desiredComplete: true,
      desired: [{ pluginId: 'local/d', platform: 'codex', scope: 'user', projectRoot: null }],
      observed: [{ pluginId: 'local/d', platform: 'codex', scope: 'project', projectRoot: '/project', physicalKey: 'shared-codex-package' }],
      observations: [{ complete: true }] });

    after.configuration!.activation = 'absent';
    const inherited = deriveSharedReferenceView(input, deriveJointDemand(input), current);
    expect(inherited.observed).toEqual([]);
    expect(inherited.observations[0]?.complete).toBe(true);
    expect(after.consumers[0]?.activation).toBe('enabled');
    after.configuration!.activation = 'unknown';
    expect(deriveSharedReferenceView(input, deriveJointDemand(input), current).observations[0]?.complete).toBe(false);

    // Neutral User activation is independent; local declarations cannot remove
    // a real native consumer from the shared-package deletion guard.
    const observed = current.extraObserved![0]!;
    observed.scope = 'user';
    after.configuration!.scope = 'user';
    for (const platform of ['codex', 'copilot'] as const) {
      observed.agent = platform;
      for (const activation of ['absent', 'disabled', 'unknown'] as const) {
        after.configuration!.activation = activation;
        const neutral = deriveSharedReferenceView(input, deriveJointDemand(input), current);
        expect(neutral.observed).toContainEqual(expect.objectContaining({ platform, scope: 'user' }));
        expect(neutral.observations[0]?.complete).toBe(true);
      }
    }
    observed.agent = 'codex';
    observed.scope = 'project';
    after.configuration!.scope = 'project';

    after.registration = 'unknown';
    expect(deriveSharedReferenceView(input, deriveJointDemand(input), current).observations[0]?.complete).toBe(false);
    input.context = { context: 'user', cwd: '/neutral', scopes: ['user'] };
    input.project = undefined;
    current.extraObserved = [];
    const userOnly = deriveSharedReferenceView(input, deriveJointDemand(input), current);
    expect(userOnly.scopes).toEqual(['user']);
    expect(userOnly.projectRoot).toBeNull();
    expect(userOnly.observations).toEqual([]);
  });
});
