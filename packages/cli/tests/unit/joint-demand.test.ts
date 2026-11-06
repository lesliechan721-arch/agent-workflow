import { describe, expect, it } from 'vitest';
import { deriveJointDemand, targetsConflict, type JointDemandSnapshot } from '../../src/recovery/joint-demand.js';
import { aggregateConvergence } from '../../src/recovery/status.js';
import { createEmptyPreferences, parsePreferences, type AgentId } from '../../src/intent/deployment-preferences.js';
import type { DemandSnapshot } from '../../src/recovery/demand.js';
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
  return { pluginId: `local/${name}`, sourceId: 'local', catalogLogicalIdentity: 'catalog:local',
    manifest: { schemaVersion: 3, name, version: '1.0.0', description: name, dependencies, skills: './skills', platforms: ['cursor'] },
  } as PluginMeta;
}
describe('joint requirements', () => {
  // Test Value Gate: both root paths must survive while a shared dependency has one provider.
  it('expands both closures and assigns the shared dependency to user', () => {
    const plan = deriveJointDemand(snapshot(['a'], ['b']));
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
  // Scope support must be evaluated for both declarations before operation filtering.
  it('explains an unsupported user dependency while retaining the legal project closure', () => {
    const input = snapshot(['a'], ['b']);
    const dependency = input.user.plugins.find((entry) => entry.pluginId === 'local/d')!;
    delete dependency.manifest.skills;
    dependency.manifest.artifacts = { targets: [{ id: 'project-skill', platform: 'cursor',
      target: 'agent-skills.skill', scopes: ['project'], states: ['present'], refreshKeys: [], skillKey: 'project-skill' }] };
    const plan = deriveJointDemand(input);
    expect(plan.complete).toBe(true);
    expect(plan.errors).toEqual([]);
    expect(plan.roots).toEqual([
      expect.objectContaining({ pluginId: 'local/a', scope: 'user', target: 'cursor', state: 'unsupported', blockers: [],
        reasons: [{ code: 'deliveryUnsupported', pluginId: 'local/d',
          message: 'user: local/a → local/d @ cursor 不支持所需目标或范围。' }] }),
      expect.objectContaining({ pluginId: 'local/b', scope: 'project', target: 'cursor', state: 'required', blockers: [] }),
    ]);
    expect(plan.placements.map((entry) => [entry.pluginId, entry.scope])).toEqual([
      ['local/d', 'project'], ['local/b', 'project'],
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
describe('fixed scope directions', () => {
  it.each([
    ['antigravity', 'user', 'codex', 'project', false], ['codex', 'user', 'antigravity', 'project', true],
    ['antigravity', 'user', 'generic', 'user', false], ['generic', 'user', 'antigravity', 'project', true],
    ['generic', 'user', 'cursor', 'project', true], ['cursor', 'user', 'generic', 'project', true],
    ['antigravity', 'project', 'cursor', 'project', true], ['antigravity', 'user', 'cursor', 'user', false],
    ['claude', 'project', 'generic', 'project', false], ['generic', 'user', 'generic', 'project', false],
  ] as const)('%s@%s / %s@%s conflict=%s', (a, aScope, b, bScope, expected) => {
    expect(targetsConflict({ target: a, scope: aScope }, { target: b, scope: bScope })).toBe(expected);
  });
  it.each([[false, 'absent', false], [null, 'absent', null], [true, 'unknown', null],
    [null, 'present', false], [true, 'absent', true]] as const)('keeps known failure before unknown: %s, %s', (satisfied, residue, expected) => {
    expect(aggregateConvergence(satisfied, residue)).toBe(expected);
  });
});
