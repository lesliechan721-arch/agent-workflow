import path from 'node:path';

import fs from 'fs-extra';

import { isSkillAgentReferenceMarkdown, scanSkillAgentReferences } from './agent-placeholders.js';
import { tryNativeComponentName } from './platform-agent-naming.js';
import { isAuthorOnlySkillDirectory, isSkillAuthorOnlyPath } from './skill-authoring.js';
import type { NormalizedPluginManifest, PlatformId } from './types.js';

/** Read runtime Markdown from the ordinary skills/ directory of a source or materialized platform. */
export async function scanSkillCollectionAgentReferences(root: string,
  onSkillMain?: (relativePath: string, text: string) => void): Promise<Set<string>> {
  const references = new Set<string>();
  const skillsRoot = path.join(root, 'skills');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory()) throw new Error('Invalid Skill source root: expected an ordinary directory.');
  const collectionStat = await fs.lstat(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!collectionStat) return references;
  if (!collectionStat.isDirectory()) throw new Error('Invalid Skills collection: expected an ordinary directory.');

  async function visit(skillRoot: string, relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(skillRoot, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (isSkillAuthorOnlyPath(file)) continue;
      if (entry.isDirectory()) await visit(skillRoot, file);
      else if (!entry.isFile()) throw new Error('Invalid Skill source: expected ordinary files and directories at ' + file);
      else if (isSkillAgentReferenceMarkdown(file)) {
        const absoluteFile = path.join(skillRoot, file);
        const text = await fs.readFile(absoluteFile, 'utf8');
        for (const reference of scanSkillAgentReferences(file, text)) references.add(reference.normalizedName);
        if (file === 'SKILL.md') onSkillMain?.(path.relative(root, absoluteFile).split(path.sep).join('/'), text);
      }
    }
  }

  for (const skill of await fs.readdir(skillsRoot, { withFileTypes: true })) {
    if (!skill.isDirectory()) {
      if (skill.isFile()) continue;
      throw new Error('Invalid Skills collection: expected ordinary entries at ' + skill.name);
    }
    const skillRoot = path.join(skillsRoot, skill.name);
    if (!await isAuthorOnlySkillDirectory(skillRoot)) await visit(skillRoot, '');
  }
  return references;
}

export function validateStaticSkillAgentReferences(references: ReadonlySet<string>, manifest: NormalizedPluginManifest,
  platforms: Iterable<PlatformId>): void {
  if (!references.size) return;
  const agents = manifest.extensions?.agents ?? [];
  const supportedPlatforms = [...platforms];
  for (const name of references) {
    const matches = agents.filter((agent) => tryNativeComponentName(agent.name) === name);
    if (matches.length > 1) throw new Error('agentReferenceInvalid: ambiguous static Agent ' + name);
    const [agent] = matches;
    if (!agent && !manifest.artifacts) throw new Error('agentReferenceInvalid: unknown static Agent ' + name);
    for (const platform of supportedPlatforms) {
      if (agent?.agentOverrides?.[platform] === null) {
        throw new Error('agentReferenceInvalid: Agent ' + name + ' is omitted on ' + platform);
      }
    }
  }
}
