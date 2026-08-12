const SKILL_AUTHOR_ONLY_DIRECTORIES = new Set(['evals', 'reports']);

function pathSegments(relativePath: string): string[] {
  return relativePath.split(/[\\/]/u).filter(Boolean);
}

export function isSkillAuthorOnlyPath(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) =>
    SKILL_AUTHOR_ONLY_DIRECTORIES.has(segment));
}

export function isSkillCollectionAuthorOnlyPath(relativePath: string): boolean {
  return pathSegments(relativePath).slice(1).some((segment) =>
    SKILL_AUTHOR_ONLY_DIRECTORIES.has(segment));
}
