import path from 'node:path';

import fs from 'fs-extra';
import { normalizeProducerIdentity, type ProducerIdentity } from '@lesliechan721/aw-plugin-core/manifest';

import { readStrictNamespacedMarketplaceRoot } from './local-marketplace.js';
import { resolveAwHomeCanonical } from './state-paths.js';

function invalid(message: string): never {
  throw new Error(`commandOwnerMismatch: ${message}`);
}

async function readManifest(filePath: string): Promise<Record<string, unknown>> {
  const root = path.parse(filePath).root;
  let current = root;
  const segments = path.relative(root, filePath).split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      invalid('Claude native evidence must use ordinary files and directories.');
    }
  }
  const value: unknown = await fs.readJson(filePath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('The Claude native manifest must be an object.');
  return value as Record<string, unknown>;
}

/** AW projects one explicit Skill collection into its Claude plugin manifest. */
export async function resolveClaudeSkillsRelativeRoot(pluginRoot: string): Promise<string> {
  const manifest = await readManifest(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  const raw = manifest.skills;
  if (typeof raw !== 'string' || !raw.startsWith('./') || raw.includes('\\') || raw.includes('\0')) invalid('The Claude native plugin must declare one relative Skill root.');
  const relative = path.posix.normalize(raw.slice(2));
  if (relative === '.' || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    invalid('The Claude native Skill root escapes its plugin.');
  }
  return relative;
}

/** Resolve only the relative-source payload emitted in AW's canonical namespaced mirror. */
export async function resolveClaudeNativeSkillRoot(options: {
  producer: ProducerIdentity;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const producer = normalizeProducerIdentity(options.producer);
  if (producer.kind !== 'static-skill' || producer.platform !== 'claude' || producer.scope !== 'user' || producer.projectRoot !== null) {
    invalid('Claude native static commands require a shared user producer.');
  }
  const awHome = await resolveAwHomeCanonical(options.env);
  const marketplacesRoot = path.join(awHome, 'marketplaces');
  const marketplaceRoot = path.join(marketplacesRoot, producer.sourceId);
  // Read the controlled path before interpreting metadata. No host registry or Catalog lookup is needed.
  await readManifest(path.join(marketplaceRoot, 'config.json'));
  const marketplace = await readStrictNamespacedMarketplaceRoot({ trustedMarketplaceRoot: marketplacesRoot, rootDir: marketplaceRoot, sourceId: producer.sourceId, sourceIdentity: producer.sourceIdentity });
  if (!marketplace?.claudeManifest || !Array.isArray(marketplace.claudeManifest.plugins)) invalid('The namespaced mirror has no Claude marketplace entries.');
  const entries = marketplace.claudeManifest.plugins.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).name === producer.pluginName);
  if (entries.length !== 1 || entries[0]!.source !== `./plugins/${producer.pluginName}`) {
    invalid('The Claude marketplace entry does not identify AW\'s relative plugin payload.');
  }
  const pluginRoot = path.join(marketplaceRoot, 'plugins', producer.pluginName);
  const sourceManifest = await readManifest(path.join(pluginRoot, '.agents-plugin', 'plugin.json'));
  const platformManifest = await readManifest(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  if (sourceManifest.name !== producer.pluginName || platformManifest.name !== producer.pluginName) invalid('The Claude native manifests identify another plugin.');
  const relativeRoot = await resolveClaudeSkillsRelativeRoot(pluginRoot);
  const skillRoot = path.join(pluginRoot, ...relativeRoot.split('/'), producer.key);
  await assertSkillDirectory(skillRoot);
  return skillRoot;
}

async function assertSkillDirectory(directory: string): Promise<void> {
  const canonical = await fs.realpath(directory);
  if (path.normalize(canonical) !== path.normalize(directory)) invalid('The Claude native Skill path contains a symbolic link.');
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid('The Claude native Skill root is not a regular directory.');
  const skill = await fs.lstat(path.join(directory, 'SKILL.md'));
  if (!skill.isFile() || skill.isSymbolicLink()) invalid('The Claude native Skill must contain a regular SKILL.md file.');
}
