import path from 'node:path';
import fs from 'fs-extra';

const SKILL_AUTHOR_ONLY_DIRECTORIES = new Set(['evals', 'reports']);

function pathSegments(relativePath: string): string[] {
  return relativePath.split(/[\\/]/u).filter(Boolean);
}

export function isSkillAuthorOnlyPath(relativePath: string): boolean {
  const [topLevel] = pathSegments(relativePath);
  return topLevel !== undefined && SKILL_AUTHOR_ONLY_DIRECTORIES.has(topLevel);
}

export function isSkillCollectionAuthorOnlyPath(relativePath: string): boolean {
  const [, skillTopLevel] = pathSegments(relativePath);
  return skillTopLevel !== undefined && SKILL_AUTHOR_ONLY_DIRECTORIES.has(skillTopLevel);
}

/** Author-only evaluation inputs do not declare or publish a static Skill. */
export async function isAuthorOnlySkillDirectory(rootDir: string): Promise<boolean> {
  const root = await fs.lstat(rootDir).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  const children = await fs.readdir(rootDir, { withFileTypes: true });
  if (children.length === 0 || children.some((entry) => !entry.isDirectory() || !SKILL_AUTHOR_ONLY_DIRECTORIES.has(entry.name))) return false;
  const regularTree = async (directory: string): Promise<boolean> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return false;
      if (entry.isDirectory() && !await regularTree(path.join(directory, entry.name))) return false;
    }
    return true;
  };
  return regularTree(rootDir);
}

export async function isAuthorOnlySkillCollection(rootDir: string): Promise<boolean> {
  const root = await fs.lstat(rootDir).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink()) return false;
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !await isAuthorOnlySkillDirectory(path.join(rootDir, entry.name))) return false;
  }
  return true;
}
