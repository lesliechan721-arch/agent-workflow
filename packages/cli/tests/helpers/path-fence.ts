import fs from 'node:fs';
import path from 'node:path';

export type TestRootAccess = 'read' | 'write';
export type TestRootKind = 'readonlyFixture' | 'writableState';

export interface RegisteredTestRoot {
  path: string;
  sources: string[];
}

export interface RegisteredTestRootsSnapshot {
  readonlyFixtureRoots: RegisteredTestRoot[];
  writableStateRoots: RegisteredTestRoot[];
}

export interface TestRootRegistry {
  readonlyFixtureRoots: Map<string, Set<string>>;
  writableStateRoots: Map<string, Set<string>>;
}

export interface TestPathFenceCheck {
  path: string;
  source: string;
  access: TestRootAccess;
  recommendedFix?: string;
}

export interface TestPathFenceErrorDetails {
  access: TestRootAccess;
  source: string;
  unsafePath: string;
  normalizedUnsafePath: string;
  reason: 'outsideRegisteredRoots' | 'writeToReadOnlyRoot';
  conflictingRoot?: RegisteredTestRoot;
  registeredRoots: RegisteredTestRootsSnapshot;
  recommendedFix: string;
}

function sanitizeSource(source: string): string {
  const trimmed = source.trim();
  return trimmed === '' ? 'unknown' : trimmed;
}

function formatSources(sources: readonly string[]): string {
  if (sources.length === 0) {
    return '';
  }

  return ` (sources: ${sources.join(', ')})`;
}

function formatRootList(roots: readonly RegisteredTestRoot[]): string {
  if (roots.length === 0) {
    return '- <none>';
  }

  return roots
    .map((root) => `- ${root.path}${formatSources(root.sources)}`)
    .join('\n');
}

function defaultRecommendedFix(access: TestRootAccess): string {
  if (access === 'read') {
    return '用 registerReadonlyFixtureRoot() 或 runWithRepositoryCwdAsReadOnly() 登记只读输入根。';
  }

  return '用 createIsolatedTestEnv()、registerWritableStateRoot() 或 withSafeTestCwd() 把写入目标放进测试安全根。';
}

function findExistingAncestor(resolvedPath: string): {
  ancestor: string;
  trailingSegments: string[];
} {
  const trailingSegments: string[] = [];
  let currentPath = resolvedPath;

  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return {
        ancestor: resolvedPath,
        trailingSegments: [],
      };
    }

    trailingSegments.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }

  return {
    ancestor: currentPath,
    trailingSegments,
  };
}

export function normalizeAbsolutePath(inputPath: string): string {
  const resolvedPath = path.resolve(inputPath);
  const { ancestor, trailingSegments } = findExistingAncestor(resolvedPath);

  let normalizedAncestor = path.resolve(ancestor);
  try {
    normalizedAncestor = fs.realpathSync.native(ancestor);
  } catch {
    normalizedAncestor = path.resolve(ancestor);
  }

  return path.normalize(path.join(normalizedAncestor, ...trailingSegments));
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function addRoot(
  rootMap: Map<string, Set<string>>,
  rootPath: string,
  source?: string,
): string {
  const normalizedPath = normalizeAbsolutePath(rootPath);
  const currentSources = rootMap.get(normalizedPath) ?? new Set<string>();
  if (source) {
    currentSources.add(sanitizeSource(source));
  }
  rootMap.set(normalizedPath, currentSources);
  return normalizedPath;
}

function snapshotRootMap(rootMap: Map<string, Set<string>>): RegisteredTestRoot[] {
  return [...rootMap.entries()]
    .map(([registeredPath, sources]) => ({
      path: registeredPath,
      sources: [...sources].sort(),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function findBestMatchingRoot(
  rootMap: Map<string, Set<string>>,
  candidatePath: string,
): RegisteredTestRoot | undefined {
  let bestMatch: RegisteredTestRoot | undefined;

  for (const [registeredPath, sources] of rootMap.entries()) {
    if (!isPathInsideRoot(registeredPath, candidatePath)) {
      continue;
    }

    if (!bestMatch || registeredPath.length > bestMatch.path.length) {
      bestMatch = {
        path: registeredPath,
        sources: [...sources].sort(),
      };
    }
  }

  return bestMatch;
}

function formatReason(details: TestPathFenceErrorDetails): string {
  if (details.reason === 'writeToReadOnlyRoot' && details.conflictingRoot) {
    return `path is only registered as a read-only fixture root: ${details.conflictingRoot.path}${formatSources(details.conflictingRoot.sources)}`;
  }

  return 'path is outside every registered test root';
}

function buildErrorMessage(details: TestPathFenceErrorDetails): string {
  return [
    `Unsafe test ${details.access} path: ${details.normalizedUnsafePath}`,
    `source: ${details.source}`,
    `reason: ${formatReason(details)}`,
    'registered writable state roots:',
    formatRootList(details.registeredRoots.writableStateRoots),
    'registered read-only fixture roots:',
    formatRootList(details.registeredRoots.readonlyFixtureRoots),
    `recommended fix: ${details.recommendedFix}`,
  ].join('\n');
}

export class TestPathFenceError extends Error {
  readonly details: TestPathFenceErrorDetails;

  constructor(details: TestPathFenceErrorDetails) {
    super(buildErrorMessage(details));
    this.name = 'TestPathFenceError';
    this.details = details;
  }
}

export function createPathFenceRegistry(): TestRootRegistry {
  return {
    readonlyFixtureRoots: new Map<string, Set<string>>(),
    writableStateRoots: new Map<string, Set<string>>(),
  };
}

export function registerReadonlyFixtureRoot(
  registry: TestRootRegistry,
  rootPath: string,
  source = 'registerReadonlyFixtureRoot()',
): string {
  return addRoot(registry.readonlyFixtureRoots, rootPath, source);
}

export function registerWritableStateRoot(
  registry: TestRootRegistry,
  rootPath: string,
  source = 'registerWritableStateRoot()',
): string {
  return addRoot(registry.writableStateRoots, rootPath, source);
}

export function listRegisteredRoots(
  registry: TestRootRegistry,
): RegisteredTestRootsSnapshot {
  return {
    readonlyFixtureRoots: snapshotRootMap(registry.readonlyFixtureRoots),
    writableStateRoots: snapshotRootMap(registry.writableStateRoots),
  };
}

function assertPathWithinRoots(
  registry: TestRootRegistry,
  check: TestPathFenceCheck,
): string {
  const normalizedPath = normalizeAbsolutePath(check.path);
  const writableMatch = findBestMatchingRoot(registry.writableStateRoots, normalizedPath);
  const readonlyMatch = findBestMatchingRoot(registry.readonlyFixtureRoots, normalizedPath);

  if (check.access === 'read') {
    if (writableMatch || readonlyMatch) {
      return normalizedPath;
    }
  } else if (writableMatch) {
    return normalizedPath;
  } else if (readonlyMatch) {
    throw new TestPathFenceError({
      access: check.access,
      source: sanitizeSource(check.source),
      unsafePath: check.path,
      normalizedUnsafePath: normalizedPath,
      reason: 'writeToReadOnlyRoot',
      conflictingRoot: readonlyMatch,
      registeredRoots: listRegisteredRoots(registry),
      recommendedFix: check.recommendedFix ?? defaultRecommendedFix(check.access),
    });
  }

  throw new TestPathFenceError({
    access: check.access,
    source: sanitizeSource(check.source),
    unsafePath: check.path,
    normalizedUnsafePath: normalizedPath,
    reason: 'outsideRegisteredRoots',
    registeredRoots: listRegisteredRoots(registry),
    recommendedFix: check.recommendedFix ?? defaultRecommendedFix(check.access),
  });
}

export function assertPathWithinReadableRoots(
  registry: TestRootRegistry,
  check: Omit<TestPathFenceCheck, 'access'>,
): string {
  return assertPathWithinRoots(registry, {
    ...check,
    access: 'read',
  });
}

export function assertPathWithinWritableRoots(
  registry: TestRootRegistry,
  check: Omit<TestPathFenceCheck, 'access'>,
): string {
  return assertPathWithinRoots(registry, {
    ...check,
    access: 'write',
  });
}
