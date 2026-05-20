export type TestPathFenceAccess = 'read' | 'write';

export interface TestPathFenceCheck {
  path: string;
  source: string;
  access: TestPathFenceAccess;
  recommendedFix?: string;
}

export type TestPathFenceHook = (check: TestPathFenceCheck) => void;

const testPathFenceHookKey = Symbol.for('aw.testPathFenceHookForTests');

type TestPathFenceGlobalState = typeof globalThis & {
  [testPathFenceHookKey]?: TestPathFenceHook | null;
};

function getTestPathFenceGlobalState(): TestPathFenceGlobalState {
  return globalThis as TestPathFenceGlobalState;
}

export function setTestPathFenceHookForTests(
  hook: TestPathFenceHook | null,
): void {
  getTestPathFenceGlobalState()[testPathFenceHookKey] = hook;
}

function getTestPathFenceHookForTests(): TestPathFenceHook | null {
  return getTestPathFenceGlobalState()[testPathFenceHookKey] ?? null;
}

export function assertTestPathAccess(
  check: TestPathFenceCheck,
): string {
  getTestPathFenceHookForTests()?.(check);
  return check.path;
}

export function assertTestReadablePath(
  path: string,
  source: string,
  recommendedFix?: string,
): string {
  return assertTestPathAccess({
    path,
    source,
    access: 'read',
    recommendedFix,
  });
}

export function assertTestWritablePath(
  path: string,
  source: string,
  recommendedFix?: string,
): string {
  return assertTestPathAccess({
    path,
    source,
    access: 'write',
    recommendedFix,
  });
}
