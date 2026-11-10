import { describe, expect, it } from 'vitest';
import { deriveJointDemand, deriveSharedReferenceView, type JointDemandSnapshot } from '../../src/recovery/joint-demand.js';
import { aggregateConvergence, type RecoveryStatus } from '../../src/recovery/status.js';
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
    const targets: AgentId[] = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok'];
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
  it('does not approve project fallback when user demand is unknown', () => {
    const input = snapshot([], ['b']); input.user.roots = null;
    const plan = deriveJointDemand(input);
    expect(plan.complete).toBe(false); expect(plan.roots[0]!.state).toBe('unknown');
  });
  it('blocks a known project closure when its user source provider cannot be read', () => {
    const input = snapshot(['a'], ['b']);
    input.user.roots![0]!.plugin = undefined;
    input.user.roots![0]!.blockers = ['pluginManifestUnavailable'];
    const plan = deriveJointDemand(input);
    expect(plan.roots.map((entry) => entry.state)).toEqual(['unknown', 'unknown']);
    expect(plan.placements).toEqual([]);
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
      ownership: 'aw', consumers: [{ productId: 'codex-cli', activationKey: 'project-activation', activation: 'enabled',
        trust: 'trusted', load: 'not-observed' }], components: [], nativeIdentity: null,
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
