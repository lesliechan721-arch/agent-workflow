import path from 'node:path';
import fs from 'fs-extra';
import type { ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';
import { readSkillOwnerMarker } from './ownership.js';
import { CODEX_NATIVE_RENDER_RECEIPT_PATH, parseCodexNativeRenderReceipt } from './codex-native-render-receipt.js';
import { readStrictNamespacedMarketplaceRoot } from './local-marketplace.js';
import { resolveCodexSkillsRelativeRoot } from './codex-skills-root.js';
import { resolveClaudeNativeSkillRoot } from './claude-skills-root.js';

async function ensureRegularFilePath(filePath: string, label: string): Promise<void> {
  await assertDirectory(path.dirname(filePath));
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`commandOwnerMismatch: ${label} must be a regular file.`);
}

async function assertDirectory(directory: string): Promise<void> {
  const canonical = await fs.realpath(directory);
  if (path.normalize(canonical) !== path.normalize(directory)) throw new Error('commandOwnerMismatch: producer paths cannot contain symbolic links.');
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('commandOwnerMismatch: producer paths must contain only regular directories.');
  }
}

/** Verify the existing producer's live ownership, independently of its binding index. */
export async function verifyManagedCommandArtifactEvidence(options: {
  producer: ProducerIdentity; resourceRoot: string; env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { producer } = options;
  if (producer.kind === 'package') throw new Error('commandOwnerMismatch: package evidence must use its external owner marker.');
  const resourceRoot = path.resolve(options.resourceRoot);
  await assertDirectory(resourceRoot);
  if (producer.kind === 'static-skill' && producer.platform === 'claude') {
    if (resourceRoot !== await resolveClaudeNativeSkillRoot({ producer, env: options.env })) throw new Error('commandOwnerMismatch: the command resource is outside its exact shared Claude native Skill path.');
    return;
  }
  const marker = await readSkillOwnerMarker({ skillRoot: resourceRoot, allowedRoot: path.dirname(resourceRoot) });
  if (marker) {
    if (marker.sourceId !== producer.sourceId || marker.pluginId !== `${producer.sourceId}/${producer.pluginName}` || marker.plugin !== producer.pluginName || marker.platform !== producer.platform || marker.scope !== producer.scope || (producer.kind === 'static-skill' && marker.artifactKey !== producer.key)) throw new Error('commandOwnerMismatch: the command producer Skill owner does not match its identity.');
    if (producer.scope === 'project' && (!producer.projectRoot || !resourceRoot.startsWith(`${producer.projectRoot}${path.sep}`))) throw new Error('commandOwnerMismatch: the command producer is outside its project.');
    return;
  }
  if (producer.platform !== 'codex' || producer.scope !== 'user') throw new Error('commandOwnerMismatch: the command producer has no live Skill ownership evidence.');
  let pluginRoot = resourceRoot;
  while (path.dirname(pluginRoot) !== pluginRoot) {
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    if (await fs.pathExists(manifestPath)) {
      await ensureRegularFilePath(manifestPath, 'Managed command producer manifest');
      const manifest = await fs.readJson(manifestPath) as { name?: unknown; skills?: unknown; artifacts?: { targets?: Array<{ id?: unknown; skillKey?: unknown }> } };
      if (manifest.name !== producer.pluginName || path.basename(pluginRoot) !== producer.pluginName) throw new Error('commandOwnerMismatch: the native producer manifest identifies another plugin.');
      const marketplaceRoot = path.dirname(path.dirname(pluginRoot));
      const marketplace = await readStrictNamespacedMarketplaceRoot({ rootDir: marketplaceRoot, sourceId: producer.sourceId, sourceIdentity: producer.sourceIdentity });
      if (!marketplace || path.basename(path.dirname(pluginRoot)) !== 'plugins') throw new Error('commandOwnerMismatch: the native command producer is outside its namespaced marketplace.');
      const codexManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
      await ensureRegularFilePath(codexManifestPath, 'Managed command Codex manifest');
      const codexManifest = await fs.readJson(codexManifestPath) as { name?: unknown; skills?: unknown };
      if (codexManifest.name !== producer.pluginName || typeof codexManifest.skills !== 'string' || !codexManifest.skills.trim()) throw new Error('commandOwnerMismatch: the native producer has no declared Codex Skill root.');
      const skillsRelativeRoot = await resolveCodexSkillsRelativeRoot({ rootDir: pluginRoot, manifest: { skills: typeof manifest.skills === 'string' ? manifest.skills : undefined } });
      let skillKey: string;
      if (producer.kind === 'artifact') {
        const receiptPath = path.join(pluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH);
        await ensureRegularFilePath(receiptPath, 'Managed command native receipt');
        const receipt = parseCodexNativeRenderReceipt(await fs.readFile(receiptPath, 'utf8'));
        const target = receipt.targets.find((entry) => entry.id === producer.key);
        if (receipt.logicalPluginId !== `${producer.sourceId}/${producer.pluginName}` || receipt.sourceIdentity !== producer.sourceIdentity || !target) throw new Error('commandOwnerMismatch: native command producer receipt does not match its identity.');
        skillKey = target.skillKey;
      } else skillKey = producer.key;
      if (resourceRoot !== path.join(pluginRoot, ...skillsRelativeRoot.split('/'), skillKey)) throw new Error('commandOwnerMismatch: the command resource is outside its exact materialized Codex Skill path.');
      return;
    }
    pluginRoot = path.dirname(pluginRoot);
  }
  throw new Error('commandOwnerMismatch: the native command producer has no verified materialization evidence.');
}
