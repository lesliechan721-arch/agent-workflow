import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizeCommandDefinition, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { verifyManagedCommandArtifactEvidence } from '../../src/utils/managed-command-evidence.js';
import {
  createCodexNativeRenderReceipt,
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
} from '../../src/utils/codex-native-render-receipt.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { publishManagedCommandBindings, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { resolveClaudeNativeSkillRoot } from '../../src/utils/claude-skills-root.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';

const sourceIdentity = `sha256:${'a'.repeat(64)}`;

async function createInstalledNativeProducer(kind: 'artifact' | 'static-skill'): Promise<{
  producer: ProducerIdentity; pluginRoot: string; resourceRoot: string; wrongRoot: string;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const marketplaceRoot = path.join(isolation.layout.awHomeDir, 'marketplaces', 'official');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'toolkit');
  const skillKey = 'native-guide';
  const resourceRoot = path.join(pluginRoot, 'native', 'skills', skillKey);
  const wrongRoot = path.join(pluginRoot, 'unrelated', skillKey);
  await Promise.all([
    fs.outputJson(path.join(marketplaceRoot, 'config.json'), { schemaVersion: 2, sourceId: 'official', sourceIdentity, marketplaceName: 'aw' }),
    fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'aw', plugins: [] }),
    fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { name: 'toolkit', version: '1.0.0', skills: './source/skills' }),
    fs.outputJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), { name: 'toolkit', version: '1.0.0', skills: './native/skills' }),
    fs.outputFile(path.join(resourceRoot, 'SKILL.md'), '# Native Guide\n'),
    fs.outputFile(path.join(wrongRoot, 'SKILL.md'), '# Same basename outside the declared root\n'),
  ]);
  const producer: ProducerIdentity = { sourceId: 'official', sourceIdentity, pluginName: 'toolkit', kind, key: kind === 'artifact' ? 'guide-target' : skillKey, platform: 'codex', scope: 'user', projectRoot: null };
  if (kind === 'artifact') await fs.outputJson(path.join(pluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), createCodexNativeRenderReceipt({
    logicalPluginId: 'official/toolkit', sourceIdentity, pluginVersion: '1.0.0', rendererDigest: `sha256:${'b'.repeat(64)}`,
    targets: [{ id: 'guide-target', skillKey, configDigest: `sha256:${'c'.repeat(64)}`, artifactDigest: `sha256:${'d'.repeat(64)}` }], payloadDigest: `sha256:${'e'.repeat(64)}`,
  }));
  return { producer, pluginRoot, resourceRoot, wrongRoot };
}

async function createClaudeNativeProducer(): Promise<{
  producer: ProducerIdentity; resourceRoot: string; pluginRoot: string; marketplaceRoot: string; commandId: string; env: NodeJS.ProcessEnv;
}> {
  const { layout, env } = getCurrentSourceTestIsolation();
  const marketplaceRoot = path.join(layout.awHomeDir, 'marketplaces', 'official');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'toolkit');
  const resourceRoot = path.join(pluginRoot, 'claude', 'skills', 'native-guide');
  const entry = { name: 'toolkit', source: './plugins/toolkit' };
  await Promise.all([
    fs.outputJson(path.join(marketplaceRoot, 'config.json'), { schemaVersion: 2, sourceId: 'official', sourceIdentity, marketplaceName: 'custom-source-marketplace' }),
    fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), { name: 'custom-source-marketplace', plugins: [entry] }),
    fs.outputJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), { name: 'custom-source-marketplace', plugins: [entry] }),
    fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), { name: 'toolkit', version: '1.0.0', skills: './skills' }),
    fs.outputJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), { name: 'toolkit', version: '1.0.0', skills: './claude/skills' }),
    fs.outputFile(path.join(resourceRoot, 'SKILL.md'), '# Shared Claude native Guide\n'),
    fs.outputFile(path.join(resourceRoot, 'scripts', 'tool.mjs'), 'process.exitCode = 0;\n'),
  ]);
  const producer: ProducerIdentity = { sourceId: 'official', sourceIdentity, pluginName: 'toolkit', kind: 'static-skill', key: 'native-guide', platform: 'claude', scope: 'user', projectRoot: null };
  const commandIds = await publishManagedCommandBindings({ producer, resourceRoot, env, sets: [{ set: 'tools', state: 'present', entries: [normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'scripts/tool.mjs' })] }] });
  return { producer, resourceRoot, pluginRoot, marketplaceRoot, commandId: commandIds[0]!, env };
}

describe('managed command native producer evidence', () => {
  // Protects actual installed platform projection: matching names and receipts cannot authorize another tree.
  it.each(['artifact', 'static-skill'] as const)('accepts the exact %s Skill path and rejects the same basename outside its platform root', async (kind) => {
    const fixture = await createInstalledNativeProducer(kind);
    await expect(verifyManagedCommandArtifactEvidence(fixture)).resolves.toBeUndefined();
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: fixture.wrongRoot })).rejects.toThrow('commandOwnerMismatch');
    const sourceRoot = path.join(fixture.pluginRoot, 'source', 'skills', path.basename(fixture.resourceRoot));
    await fs.ensureDir(sourceRoot);
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: sourceRoot })).rejects.toThrow('commandOwnerMismatch');
  });

  // Protects source ownership while using only the installed marketplace, independently of current Catalog state.
  it('retains source identity verification for a correct native path', async () => {
    const fixture = await createInstalledNativeProducer('artifact');
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, producer: { ...fixture.producer, sourceIdentity: `sha256:${'f'.repeat(64)}` } })).rejects.toThrow('sourceChanged');
  });

  // Protects read-only run and inspection failures: absent producers must not be created by evidence checks.
  it('does not create missing native producer directories', async () => {
    const fixture = await createInstalledNativeProducer('static-skill');
    const missing = path.join(fixture.pluginRoot, 'missing', fixture.producer.key);
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: missing })).rejects.toBeDefined();
    expect(await fs.pathExists(path.dirname(missing))).toBe(false);
  });
});

describe('shared Claude static native producer evidence', () => {
  // Protects offline runtime resolution from AW's controlled relative-source payload, without guessing a marketplace name.
  it('resolves a shared producer from the canonical mirror without user or project host installation records', async () => {
    const fixture = await createClaudeNativeProducer();
    await expect(verifyManagedCommandArtifactEvidence(fixture)).resolves.toBeUndefined();
    expect(await resolveClaudeNativeSkillRoot(fixture)).toBe(fixture.resourceRoot);
    expect((await resolveManagedCommand(fixture.commandId, fixture.env)).view).toMatchObject({ availability: 'ready', resourceRoot: fixture.resourceRoot, owner: { kind: 'plugin', producer: { platform: 'claude', scope: 'user', projectRoot: null } } });
  });

  // Protects producer routing against same-name caches and owned directories that Claude does not load for AW's relative source.
  it('rejects matching cache copies, alternate Skill roots, and project identities', async () => {
    const fixture = await createClaudeNativeProducer();
    const { layout } = getCurrentSourceTestIsolation();
    const cacheRoot = path.join(layout.claudeHomeDir, 'plugins', 'cache', 'custom-source-marketplace', 'toolkit', '1.0.0', 'native-guide');
    await fs.copy(fixture.resourceRoot, cacheRoot);
    await writeSkillOwnerMarker({ skillRoot: cacheRoot, allowedRoot: path.dirname(cacheRoot), identity: { owner: 'agent-workflows', sourceId: 'official', pluginId: 'official/toolkit', plugin: 'toolkit', platform: 'claude', scope: 'user', artifactKey: 'native-guide' } });
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: cacheRoot })).rejects.toThrow('commandOwnerMismatch');
    const wrongRoot = path.join(fixture.pluginRoot, 'other', 'native-guide');
    await fs.copy(fixture.resourceRoot, wrongRoot);
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, resourceRoot: wrongRoot })).rejects.toThrow('commandOwnerMismatch');
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, producer: { ...fixture.producer, scope: 'project', projectRoot: layout.fixtureCwd } })).rejects.toThrow('commandOwnerMismatch');
  });

  // Protects the relative-source contract; an external entry or source identity change cannot reuse the old producer.
  it('rejects external marketplace entries and changed source identities', async () => {
    const fixture = await createClaudeNativeProducer();
    await expect(verifyManagedCommandArtifactEvidence({ ...fixture, producer: { ...fixture.producer, sourceIdentity: `sha256:${'f'.repeat(64)}` } })).rejects.toThrow('sourceChanged');
    const marketplacePath = path.join(fixture.marketplaceRoot, '.claude-plugin', 'marketplace.json');
    const manifest = await fs.readJson(marketplacePath);
    manifest.plugins[0].source = { source: 'github', repo: 'elsewhere/toolkit' };
    await fs.writeJson(marketplacePath, manifest);
    await expect(verifyManagedCommandArtifactEvidence(fixture)).rejects.toThrow('commandOwnerMismatch');
  });

  // Protects installed launch truth and read-only failures independently of the binding index.
  it('refuses a conflicting producer record and does not create missing mirror content', async () => {
    const fixture = await createClaudeNativeProducer();
    const recordPath = path.join(fixture.resourceRoot, '.aw-command-producer.json');
    const record = await fs.readJson(recordPath);
    record.producer.sourceIdentity = `sha256:${'b'.repeat(64)}`;
    await fs.writeJson(recordPath, record);
    await expect(resolveManagedCommand(fixture.commandId, fixture.env)).rejects.toMatchObject({ code: 'commandIdentityConflict' });
    await fs.remove(path.join(fixture.resourceRoot, 'SKILL.md'));
    await expect(verifyManagedCommandArtifactEvidence(fixture)).rejects.toBeDefined();
    await fs.remove(fixture.pluginRoot);
    await expect(resolveClaudeNativeSkillRoot(fixture)).rejects.toBeDefined();
    expect(await fs.pathExists(fixture.pluginRoot)).toBe(false);
  });

  // Protects the existing scoped ownership path for dynamic Claude Skills while static native producers become shared.
  it('keeps AW-owned dynamic Claude producers on their project ownership evidence', async () => {
    const { layout, env } = getCurrentSourceTestIsolation();
    const projectRoot = await fs.realpath(layout.fixtureCwd);
    const resourceRoot = path.join(projectRoot, '.claude', 'skills', 'dynamic-guide');
    await fs.ensureDir(resourceRoot);
    await writeSkillOwnerMarker({ skillRoot: resourceRoot, allowedRoot: path.dirname(resourceRoot), identity: { owner: 'agent-workflows', sourceId: 'official', pluginId: 'official/toolkit', plugin: 'toolkit', platform: 'claude', scope: 'project', artifactKey: 'dynamic-guide' } });
    const producer: ProducerIdentity = { sourceId: 'official', sourceIdentity, pluginName: 'toolkit', kind: 'artifact', key: 'dynamic-target', platform: 'claude', scope: 'project', projectRoot };
    await expect(verifyManagedCommandArtifactEvidence({ producer, resourceRoot, env })).resolves.toBeUndefined();
  });
});
