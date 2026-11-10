import { describe, expect, it } from 'vitest';
import type { NormalizedPluginManifest } from '../../src/types.js';
import { validateArtifactPlan, createArtifactConfigDigest } from '../../src/utils/artifact-plan.js';

// Test Value Gate: command v2 responses must exactly match their independent request.
const manifest: NormalizedPluginManifest = { schemaVersion: 4, name: 'commands-test', version: '1.0.0', description: 'Commands',
  marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
  managedCommands: { packages: [{ key: 'tools', scope: 'user', platforms: ['codex'], sourceDir: './tools', render: true, refreshKeys: [] }],
    sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'dynamic', refreshKeys: [] }] } };
const artifacts = [
  { id: 'command-package.tools', target: 'aw.command-package', kind: 'commandPackage', state: 'present', refreshKeys: [], files: { 'settings.json': '{}' } },
  { id: 'command-set.tools', target: 'aw.command-set', kind: 'commandSet', state: 'present', refreshKeys: [], entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] },
];
function validate(plan: unknown) {
  return validateArtifactPlan({ manifest, plan, platform: 'managed-commands', scope: 'user',
    requestedArtifactIds: ['command-package.tools', 'command-set.tools'], renderConfig: { values: {}, sources: {}, issues: [] } });
}
describe('independent v2 command artifact plan', () => {
  it('accepts exact IDs and preserves command declarations', () => {
    const result = validate({ version: 2, artifacts });
    expect(result.artifacts.map((entry) => entry.id)).toEqual(['command-package.tools', 'command-set.tools']);
    expect(result.artifacts[1]).toMatchObject({ entries: [{ key: 'run', variant: 'default' }] });
  });
  it('rejects missing, duplicate, extra, platform and unknown fields', () => {
    for (const values of [artifacts.slice(1), [...artifacts, artifacts[0]], [...artifacts, { ...artifacts[0], id: 'extra' }],
      [{ ...artifacts[0], platform: 'codex' }, artifacts[1]], [{ ...artifacts[0], owner: 'author' }, artifacts[1]]]) {
      expect(() => validate({ version: 2, artifacts: values })).toThrow();
    }
    expect(() => validate({ version: 3, components: [], omitted: [], unmet: [] })).toThrow();
  });
  it('rejects component targets and disabled command sets with entries', () => {
    expect(() => validate({ version: 2, artifacts: [{ ...artifacts[0], target: 'codex.skill' }, artifacts[1]] })).toThrow();
    expect(() => validate({ version: 2, artifacts: [artifacts[0], { ...artifacts[1], state: 'disabled' }] })).toThrow();
  });
  it('limits command config evidence to selected refresh inputs and renderer identity', () => {
    const options = { artifact: { id: 'command-set.tools', target: 'aw.command-set', refreshKeys: ['enabled'] },
      digestSalt: 'renderer', renderConfig: { values: { enabled: false, unrelated: 'a' }, sources: { enabled: 'common' as const }, issues: [] } };
    const digest = createArtifactConfigDigest(options);
    expect(createArtifactConfigDigest({ ...options, renderConfig: { ...options.renderConfig, values: { enabled: false, unrelated: 'b' } } })).toBe(digest);
    expect(createArtifactConfigDigest({ ...options, renderConfig: { ...options.renderConfig, values: { enabled: true, unrelated: 'a' } } })).not.toBe(digest);
    expect(createArtifactConfigDigest({ ...options, digestSalt: 'other-renderer' })).not.toBe(digest);
  });
});
