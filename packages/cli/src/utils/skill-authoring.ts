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
