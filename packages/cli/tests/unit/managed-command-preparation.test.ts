import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPluginCommandId, normalizeCommandDefinition, type AgentCommandContextV1, type ExpectedComponentSet } from '@lesliechan721/aw-plugin-core/manifest';

import { createManagedCommandReferenceResolver } from '../../src/utils/managed-command-materialization.js';
import { resolveManagedCommandSkillProducers, validateAgentCommandPlan } from '../../src/utils/managed-command-preparation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';

const physicalKey = `sha256:${'a'.repeat(64)}`;
const alternateKey = `sha256:${'b'.repeat(64)}`;
const entry = normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'run.mjs' });

describe('managed command physical producer preparation', () => {
  let isolated: IsolatedTestEnvironment;
  beforeEach(async () => { isolated = await createIsolatedTestEnv(); });
  afterEach(async () => { await isolated.cleanup(); });

  async function fixture() {
    const root = path.join(isolated.layout.fixtureCwd, 'plugin');
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), {
      schemaVersion: 4, name: 'physical-commands', version: '1.0.0', description: 'Physical command fixture.',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      artifacts: { configKeys: [] },
      managedCommands: { sets: [{ set: 'tools', producer: { kind: 'artifact', platform: 'codex', artifactId: 'provider' }, mode: 'static', entries: [entry] }] },
    });
    const plugin = { ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity: `sha256:${'c'.repeat(64)}` };
    const resourceRoot = path.join(root, 'candidate');
    await fs.outputFile(path.join(resourceRoot, 'SKILL.md'), '---\nname: provider\ndescription: Physical producer.\n---\n');
    await fs.outputFile(path.join(resourceRoot, 'run.mjs'), 'process.exitCode = 0;\n');
    const components: ExpectedComponentSet = {
      components: [{ id: 'provider', kind: 'skill', name: 'renamed-provider', content: { files: { 'SKILL.md': { text: '# Provider\n' } } } }],
      omitted: [], unmet: [], sources: { provider: 'dynamic' },
    };
    return { plugin, platform: 'codex' as const, renderUnit: { physicalKey, renderScope: { kind: 'user' as const } },
      components, skillResources: [{ componentId: 'provider', resourceRoot, physicalKey }], cwd: isolated.layout.fixtureCwd };
  }

  // Protects the complete-set contract: absent, intentionally omitted and unsupported producers have different effects.
  it('distinguishes omitted, scope excluded, unmet, missing and changed-kind producers without consulting old directories', async () => {
    const input = await fixture();
    const resolve = (components: ExpectedComponentSet, extra = {}) => resolveManagedCommandSkillProducers({ ...input, ...extra, components });
    expect((await resolve(input.components))[0]).toMatchObject({ state: 'ready', resourceRoot: input.skillResources[0]!.resourceRoot });
    expect((await resolve({ ...input.components, components: [], omitted: [{ id: 'provider', kind: 'skill', reason: 'config-disabled' }] }))[0]).toMatchObject({ state: 'omitted', reason: 'config-disabled' });
    expect((await resolve(input.components, { dynamicScopeOffered: false }))[0]).toMatchObject({ state: 'omitted', reason: 'scope-excluded' });
    expect((await resolve({ ...input.components, components: [], unmet: [{ id: 'provider', kind: 'skill', requiredFeatures: [], reasonCode: 'capability-unverified' }] }))[0]).toMatchObject({ state: 'unmet' });
    expect((await resolve({ ...input.components, components: [] }))[0]).toMatchObject({ state: 'failed' });
    expect((await resolve({ ...input.components, components: [{ id: 'provider', kind: 'agent', name: 'provider', content: { description: 'Agent', prompt: 'Agent' } }] }))[0]).toMatchObject({ state: 'failed' });
    expect((await resolve({ ...input.components, sources: { provider: 'static' } }))[0]).toMatchObject({ state: 'failed' });
    expect((await resolve(input.components, { skillResources: [{ ...input.skillResources[0]!, physicalKey: alternateKey }] }))[0]).toMatchObject({ state: 'failed' });
  });

  // Protects placement isolation for placeholders and permissions when the source, platform, scope and set are identical.
  it('resolves commands only in the selected placement and rejects conflicting candidates', async () => {
    const input = await fixture();
    const first = (await resolveManagedCommandSkillProducers(input))[0]!;
    const second = (await resolveManagedCommandSkillProducers({ ...input, renderUnit: { ...input.renderUnit, physicalKey: alternateKey }, skillResources: input.skillResources.map((resource) => ({ ...resource, physicalKey: alternateKey })) }))[0]!;
    if (first.state !== 'ready' || second.state !== 'ready') throw new Error('Missing prepared producer.');
    const candidates = [first, second].map((resolved) => ({ producer: resolved.producer, sets: [{ set: 'tools', state: 'present' as const, entries: [entry] }] }));
    const resolver = await createManagedCommandReferenceResolver({ ...input, scope: 'user', env: isolated.env, candidates });
    const alternate = await createManagedCommandReferenceResolver({ ...input, renderUnit: { ...input.renderUnit, physicalKey: alternateKey }, scope: 'user', env: isolated.env, candidates });
    const reference = { set: 'tools', key: 'run', variant: 'default' };
    const id = resolver(reference);
    expect(id).toBe(getPluginCommandId({ schemaVersion: 2, producer: first.producer, ...reference }));
    expect(alternate(reference)).not.toBe(id);
    const disabled = await createManagedCommandReferenceResolver({ ...input, scope: 'user', env: isolated.env, candidates: [{ ...candidates[0]!, sets: [{ set: 'tools', state: 'disabled', entries: [] }] }, candidates[1]!] });
    expect(() => disabled(reference)).toThrow('no verified producer');
    expect(alternate(reference)).not.toBe(id);
    const unavailable = await createManagedCommandReferenceResolver({ ...input, scope: 'user', env: isolated.env, candidates, unavailableProducers: [first.producer] });
    expect(() => unavailable(reference)).toThrow('no verified producer');
    await expect(createManagedCommandReferenceResolver({ ...input, scope: 'user', env: isolated.env, candidates: [candidates[0]!, { ...candidates[0]!, sets: [] }] })).rejects.toThrow('conflicting candidates');
  });
});

describe('agent command output boundary', () => {
  // Protects the separate v2 request: the renderer cannot add, omit, duplicate or reroute a requested set.
  it('requires the exact requested command IDs, platform and refresh keys', () => {
    const context: AgentCommandContextV1 = {
      schemaVersion: 1, surface: 'agent-commands', platform: 'codex', scope: 'user',
      plugin: { pluginId: 'fixture/physical-commands', name: 'physical-commands', version: '1.0.0' },
      config: { schema: { schemaVersion: 5, fields: {} }, values: {}, sources: {}, issues: [] },
      changedConfigKeys: [], requestedArtifactIds: ['command-set.tools'], previousArtifacts: [],
      producers: [{ set: 'tools', componentId: 'provider', resourceRoot: path.resolve('/candidate') }],
    };
    const set = { set: 'tools', producer: { kind: 'artifact' as const, platform: 'codex' as const, artifactId: 'provider' }, mode: 'dynamic' as const, refreshKeys: [] };
    const artifact = { id: 'command-set.tools', target: 'aw.command-set', kind: 'commandSet', platform: 'codex', state: 'present', refreshKeys: [], entries: [entry] };
    const validate = (artifacts: unknown[]) => validateAgentCommandPlan({ plan: { version: 2, artifacts }, context, sets: [set] });
    expect(validate([artifact])).toEqual([artifact]);
    expect(validate([{ ...artifact, state: 'disabled', entries: [], disabledReason: 'Disabled' }])[0]!.state).toBe('disabled');
    for (const artifacts of [[], [artifact, artifact], [{ ...artifact, platform: 'claude' }], [{ ...artifact, refreshKeys: ['extra'] }], [{ ...artifact, id: 'command-set.other' }], [{ ...artifact, placementKey: physicalKey }], [{ ...artifact, state: 'disabled' }]]) expect(() => validate(artifacts)).toThrow();
  });
});
