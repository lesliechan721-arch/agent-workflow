import path from 'node:path';

function escapeRegexSegment(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileGlob(pattern: string): RegExp {
  const normalized = pattern.split(path.sep).join('/');
  let source = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    if (char === '?') {
      source += '.';
      continue;
    }

    source += escapeRegexSegment(char);
  }

  source += '$';
  return new RegExp(source);
}

function normalizeRelativePath(filePath: string): string {
  return path.posix.normalize(filePath.split(path.sep).join('/'));
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  return compileGlob(pattern).test(normalizeRelativePath(filePath));
}

export function applyFileRules(
  filePaths: string[],
  include: string[],
  exclude: string[] = [],
): string[] {
  return filePaths
    .map((filePath) => normalizeRelativePath(filePath))
    .filter(
      (filePath) =>
        include.some((pattern) => matchesGlob(filePath, pattern)) &&
        !exclude.some((pattern) => matchesGlob(filePath, pattern)),
    )
    .sort();
}
