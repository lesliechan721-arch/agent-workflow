import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizeCommandDefinition, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { verifyManagedCommandArtifactEvidence } from '../../src/utils/managed-command-evidence.js';
import { getDeploymentLayout, resolveDeployments } from '../../src/platforms/layout.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { publishManagedCommandBindings, resolveManagedCommand, revokeManagedCommandBindings } from '../../src/utils/managed-command-store.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';

const sourceIdentity = `sha256:${'a'.repeat(64)}`;
const entry = normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'run.mjs' });
const sets = [{ set: 'tools', state: 'present' as const, entries: [entry] }];

async function createInstalledProducer(options: { platform: 'codex' | 'claude' | 'opencode'; kind?: 'artifact' | 'static-skill'; env?: NodeJS.ProcessEnv }) {
  const isolation = getCurrentSourceTestIsolation();
  const env = options.env ?? isolation.env;
  const ctx = { env, cwd: isolation.layout.fixtureCwd };
  const configRoot = resolvePlatformConfigRoot(options.platform, ctx);
  const resolution = await resolveDeployments(ctx, {
    plugin: { sourceId: 'official', sourceIdentity, pluginId: 'official/toolkit', version: '1.0.0' },
    scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
    discovery: { platform: options.platform, availability: 'available', diagnostics: [], installations: [{ id: 'test-client', product: 'cli', version: null, availability: 'available', reasonCodes: [], entry: { kind: 'cli', executable: '', configRoot } }] },
  });
  const binding = resolution.bindings[0]!;
  const layout = await getDeploymentLayout(ctx, binding);
  const resourceRoot = path.join(layout.packageRoot, 'skills', 'provider');
  await fs.outputFile(path.join(resourceRoot, 'SKILL.md'), '---\nname: provider\ndescription: Installed command fixture.\n---\n');
  await fs.outputFile(path.join(resourceRoot, 'run.mjs'), 'process.exitCode = 0;\n');
  if (layout.marketplaceRoot) {
    await fs.outputJson(path.join(layout.marketplaceRoot, 'config.json'), { schemaVersion: 2, sourceId: 'official', sourceIdentity, marketplaceName: layout.marketplaceName });
    const descriptor = options.platform === 'claude' ? '.claude-plugin/marketplace.json' : '.agents/plugins/marketplace.json';
    await fs.outputJson(path.join(layout.marketplaceRoot, descriptor), { name: layout.marketplaceName, plugins: [{ name: 'toolkit', source: './plugins/toolkit' }] });
  }
  await writeSkillOwnerMarker({ skillRoot: layout.packageRoot, allowedRoot: path.dirname(layout.packageRoot),
    identity: { owner: 'agent-workflows', sourceId: 'official', sourceIdentity, physicalKey: binding.physicalKey, pluginId: 'official/toolkit', plugin: 'toolkit', platform: options.platform, scope: 'user', artifactKey: path.basename(layout.packageRoot) },
    nativeProjection: { physicalIdentity: layout.physicalIdentity, components: [{ id: options.kind === 'artifact' ? 'dynamic-provider' : 'skill:provider', nativeName: 'provider', relativeOutputs: ['skills/provider/SKILL.md', 'skills/provider/run.mjs'] }], inputDigest: `sha256:${'b'.repeat(64)}`, contentDigest: `sha256:${'c'.repeat(64)}` } });
  const producer: ProducerIdentity = { sourceId: 'official', sourceIdentity, pluginName: 'toolkit', kind: options.kind ?? 'static-skill', key: options.kind === 'artifact' ? 'dynamic-provider' : 'provider', platform: options.platform, scope: 'user', projectRoot: null, placementKey: binding.physicalKey };
  return { producer, resourceRoot, env, layout };
}

describe('managed command live physical producer evidence', () => {
  // Protects exact platform projection and source ownership without consulting mutable Catalog state or a binding index.
  it.each(['codex', 'claude', 'opencode'] as const)('accepts the final %s Skill and rejects copied resources and another placement identity', async (platform) => {
    const fixture = await createInstalledProducer({ platform });
    await expect(verifyManagedCommandArtifactEvidence(fixture)).resolves.toBeUndefined();
    const wrongRoot = path.join(fixture.layout.packageRoot, 'other', 'provider');
    await fs.copy(fixture.resourceRoot, wrongRoot);
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: wrongRoot })).rejects.toThrow('commandOwnerMismatch');
    const siblingSkillRoot = path.join(fixture.layout.packageRoot, 'skills', 'another-provider');
    await fs.copy(fixture.resourceRoot, siblingSkillRoot);
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: siblingSkillRoot })).rejects.toThrow('commandOwnerMismatch');
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, producer: { ...fixture.producer, placementKey: `sha256:${'f'.repeat(64)}` } })).rejects.toThrow('commandOwnerMismatch');
    const missing = path.join(fixture.layout.packageRoot, 'missing', 'provider');
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: missing })).rejects.toBeDefined();
    expect(await fs.pathExists(path.dirname(missing))).toBe(false);
  });

  // Protects the existing live source identity check independently of valid command identity and final Skill paths.
  it('rejects changed namespaced source evidence', async () => {
    const fixture = await createInstalledProducer({ platform: 'codex', kind: 'artifact' });
    const configPath = path.join(fixture.layout.marketplaceRoot!, 'config.json');
    const config = await fs.readJson(configPath);
    await fs.writeJson(configPath, { ...config, sourceIdentity: `sha256:${'f'.repeat(64)}` });
    await expect(verifyManagedCommandArtifactEvidence(fixture)).rejects.toThrow('sourceChanged');
  });

  // An explicit command ID binds its frozen namespace even when the current host default changes.
  it('resolves the existing Codex placement across CODEX_HOME changes and rejects copied or changed namespace evidence', async () => {
    const fixture = await createInstalledProducer({ platform: 'codex' });
    const [id] = await publishManagedCommandBindings({ ...fixture, sets });
    const alternate = path.join(path.dirname(fixture.layout.physicalIdentity.namespaceRoot), 'other-codex-home');
    const env = { ...fixture.env, CODEX_HOME: alternate, AW_CODEX_HOME: alternate };
    expect((await resolveManagedCommand(id!, env)).resourceRoot).toBe(fixture.resourceRoot);
    const copiedPackage = `${fixture.layout.packageRoot}-copy`;
    await fs.copy(fixture.layout.packageRoot, copiedPackage);
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, env, resourceRoot: path.join(copiedPackage, 'skills/provider') })).rejects.toThrow();
    const markerPath = path.join(fixture.layout.packageRoot, '.agent-workflows-owner.json');
    const marker = await fs.readJson(markerPath);
    for (const changed of [{ ...marker.nativeProjection.physicalIdentity, namespaceRoot: alternate }, { ...marker.nativeProjection.physicalIdentity, sourceIdentity: `sha256:${'f'.repeat(64)}` }]) {
      await fs.writeJson(markerPath, { ...marker, nativeProjection: { ...marker.nativeProjection, physicalIdentity: changed } });
      await expect(verifyManagedCommandArtifactEvidence({ ...fixture, env })).rejects.toThrow('commandOwnerMismatch');
    }
  });

  // Protects stable component identity when a dynamic Skill changes its final native directory name.
  it('keeps the command ID while rebinding a renamed Skill to its current projection', async () => {
    const fixture = await createInstalledProducer({ platform: 'codex', kind: 'artifact' });
    const [id] = await publishManagedCommandBindings({ ...fixture, sets });
    const renamed = path.join(fixture.layout.packageRoot, 'skills', 'renamed-provider');
    await fs.copy(fixture.resourceRoot, renamed);
    await writeSkillOwnerMarker({ skillRoot: fixture.layout.packageRoot, allowedRoot: path.dirname(fixture.layout.packageRoot),
      identity: { owner: 'agent-workflows', sourceId: 'official', sourceIdentity, physicalKey: fixture.producer.placementKey!, pluginId: 'official/toolkit', plugin: 'toolkit', platform: 'codex', scope: 'user', artifactKey: path.basename(fixture.layout.packageRoot) },
      nativeProjection: { physicalIdentity: fixture.layout.physicalIdentity, components: [{ id: 'dynamic-provider', nativeName: 'renamed-provider', relativeOutputs: ['skills/renamed-provider/SKILL.md', 'skills/renamed-provider/run.mjs'] }], inputDigest: `sha256:${'b'.repeat(64)}`, contentDigest: `sha256:${'d'.repeat(64)}` } });
    expect(await publishManagedCommandBindings({ ...fixture, resourceRoot: renamed, sets })).toEqual([id]);
    expect((await resolveManagedCommand(id!, fixture.env)).resourceRoot).toBe(renamed);
    await expect(verifyManagedCommandArtifactEvidence(fixture)).rejects.toThrow('commandOwnerMismatch');
  });

  // Protects publication, update, lookup and revoke when all logical fields match except verified physical placement.
  it('keeps two real physical producers independent and refuses a producer record from another placement', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const first = await createInstalledProducer({ platform: 'opencode', env: { ...env, XDG_CONFIG_HOME: path.join(layout.fixtureCwd, 'config-a') } });
    const second = await createInstalledProducer({ platform: 'opencode', env: { ...env, XDG_CONFIG_HOME: path.join(layout.fixtureCwd, 'config-b') } });
    expect(first.producer.placementKey).not.toBe(second.producer.placementKey);
    expect(first.resourceRoot).not.toBe(second.resourceRoot);
    const [firstId] = await publishManagedCommandBindings({ ...first, sets });
    const [secondId] = await publishManagedCommandBindings({ ...second, sets });
    expect(firstId).not.toBe(secondId);
    await publishManagedCommandBindings({ ...first, sets: [{ ...sets[0]!, entries: [{ ...entry, args: ['updated'] }] }] });
    expect((await resolveManagedCommand(firstId!, first.env)).launch.args).toEqual(['updated']);
    expect((await resolveManagedCommand(secondId!, second.env)).launch.args).toEqual([]);
    expect((await resolveManagedCommand(secondId!, first.env)).view.availability).toBe('ready');
    const recordPath = path.join(first.resourceRoot, '.aw-command-producer.json');
    await fs.copyFile(path.join(second.resourceRoot, '.aw-command-producer.json'), recordPath);
    await expect(publishManagedCommandBindings({ ...first, sets })).rejects.toMatchObject({ code: 'commandIdentityConflict' });
    expect((await fs.readJson(recordPath)).producer).toEqual(second.producer);
    expect(await revokeManagedCommandBindings(first.producer, first.env)).toEqual([firstId]);
    await expect(resolveManagedCommand(firstId!, first.env)).rejects.toMatchObject({ code: 'commandNotFound' });
    expect((await resolveManagedCommand(secondId!, second.env)).view.availability).toBe('ready');
  });
});
