import type { Mock } from 'vitest';
import { afterEach, beforeEach, vi } from 'vitest';

import {
  createIsolatedTestEnv,
  assertPathWithinReadableRoots,
  assertPathWithinWritableRoots,
  registerReadonlyFixtureRoot,
  registerWritableStateRoot,
  runWithRepositoryCwdAsReadOnly,
  withSafeTestCwd,
  type IsolatedTestEnvironment,
} from '../helpers/test-isolation.js';
import { installSourceTestNativeGuards } from '../helpers/native-guard.js';
import type { TestRootRegistry } from '../helpers/path-fence.js';
import { setTestPathFenceHookForTests } from '../../src/utils/test-path-fence.js';
import { resetSourceStateForTests } from './reset-source-state.js';

export interface ActiveSourceTestIsolation extends IsolatedTestEnvironment {
  repositoryCwd: string;
}

interface ActiveSourceTestContext {
  isolation: ActiveSourceTestIsolation;
  previousCwd: string;
  previousEnv: NodeJS.ProcessEnv;
}

const repositoryCwd = process.cwd();
const workerBaseEnv = cloneProcessEnv(process.env);
const workerBaseFetch = globalThis.fetch;

let activeContext: ActiveSourceTestContext | null = null;

function cloneProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env };
}

function replaceProcessEnv(nextEnv: NodeJS.ProcessEnv): void {
  const nextKeys = new Set(Object.keys(nextEnv));

  for (const key of Object.keys(process.env)) {
    if (!nextKeys.has(key)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(nextEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreWorkerBaseFetch(): void {
  if (workerBaseFetch === undefined) {
    delete (globalThis as { fetch?: typeof fetch }).fetch;
    return;
  }

  globalThis.fetch = workerBaseFetch;
}

function installNoNetworkFetchGuard(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Network access is disabled in tests. Stub fetch or setCatalogPackageSourceForTests for ${String(input)}.`);
  }) as Mock);
}

function installSourceTestPathFence(
  rootRegistry: TestRootRegistry,
): void {
  setTestPathFenceHookForTests((check) => {
    if (check.access === 'read') {
      assertPathWithinReadableRoots(rootRegistry, check);
      return;
    }

    assertPathWithinWritableRoots(rootRegistry, check);
  });
}

function requireActiveContext(): ActiveSourceTestContext {
  if (!activeContext) {
    throw new Error('Source test isolation is only available during a running test case or hook.');
  }

  return activeContext;
}

export function getSourceTestRepositoryCwd(): string {
  return repositoryCwd;
}

export function getCurrentSourceTestIsolation(): ActiveSourceTestIsolation {
  return requireActiveContext().isolation;
}

export function getCurrentSourceTestRootRegistry(): TestRootRegistry {
  return getCurrentSourceTestIsolation().rootRegistry;
}

export function registerCurrentTestReadonlyFixtureRoot(
  rootPath: string,
  source = 'registerCurrentTestReadonlyFixtureRoot()',
): string {
  return registerReadonlyFixtureRoot(getCurrentSourceTestRootRegistry(), rootPath, source);
}

export function registerCurrentTestWritableStateRoot(
  rootPath: string,
  source = 'registerCurrentTestWritableStateRoot()',
): string {
  return registerWritableStateRoot(getCurrentSourceTestRootRegistry(), rootPath, source);
}

export async function withCurrentTestSafeCwd<T>(
  cwd: string,
  callback: () => Promise<T> | T,
  source = 'withCurrentTestSafeCwd()',
): Promise<T> {
  return withSafeTestCwd(getCurrentSourceTestRootRegistry(), cwd, callback, source);
}

export async function runWithCurrentRepositoryCwdAsReadOnly<T>(
  callback: () => Promise<T> | T,
  options: {
    repositoryCwd?: string;
    source?: string;
  } = {},
): Promise<T> {
  return runWithRepositoryCwdAsReadOnly(
    getCurrentSourceTestRootRegistry(),
    callback,
    {
      repositoryCwd: options.repositoryCwd ?? repositoryCwd,
      source: options.source,
    },
  );
}

async function teardownActiveContext(): Promise<void> {
  const context = activeContext;
  activeContext = null;

  resetSourceStateForTests();
  restoreWorkerBaseFetch();

  if (!context) {
    replaceProcessEnv(workerBaseEnv);
    process.chdir(repositoryCwd);
    return;
  }

  replaceProcessEnv(context.previousEnv);
  process.chdir(context.previousCwd);
  await context.isolation.cleanup();
}

beforeEach(async () => {
  await teardownActiveContext();

  const previousEnv = cloneProcessEnv(process.env);
  const previousCwd = process.cwd();
  const isolated = await createIsolatedTestEnv({
    baseEnv: workerBaseEnv,
  });

  activeContext = {
    isolation: {
      ...isolated,
      repositoryCwd,
    },
    previousCwd,
    previousEnv,
  };

  replaceProcessEnv(isolated.env);
  process.chdir(isolated.layout.fixtureCwd);
  installNoNetworkFetchGuard();
  installSourceTestPathFence(isolated.rootRegistry);
  installSourceTestNativeGuards();
});

afterEach(async () => {
  await teardownActiveContext();
});
