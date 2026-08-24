import path from 'node:path';

export function legacyReviewScript(repoRoot: string, scriptName: string): string {
  return path.join(
    repoRoot,
    '.agents',
    'legacy',
    'plugin-development-review',
    'scripts',
    scriptName,
  );
}
