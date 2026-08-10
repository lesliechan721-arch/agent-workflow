import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { acquireProcessLock, type ProcessLockLease } from './process-lock.js';
import { resolveAwHome } from './state-paths.js';
import { assertTestWritablePath } from './test-path-fence.js';

const ACTIVE_MARKETPLACE_RUNTIME_LOCK_TIMEOUT_MS = 600_000;
const ACTIVE_MARKETPLACE_RUNTIME_LOCK_FILE = 'runtime-state.lock';
const RETRYABLE_RELEASE_ERROR_CODES = new Set([
  'EACCES',
  'EBUSY',
  'EINTR',
  'EIO',
  'ENOTEMPTY',
  'EPERM',
]);
let activeMarketplaceLifecycleBeforeAcquireHookForTests:
  | ((coordinationRoot: string) => Promise<void>)
  | undefined;

export function setActiveMarketplaceLifecycleBeforeAcquireHookForTests(
  hook: ((coordinationRoot: string) => Promise<void>) | undefined,
): void {
  activeMarketplaceLifecycleBeforeAcquireHookForTests = hook;
}

export function resolveActiveMarketplaceRuntimeCoordinationRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const awHome = resolveAwHome(env);
  const identity = crypto.createHash('sha256')
    .update(path.resolve(awHome))
    .digest('hex')
    .slice(0, 16);
  return assertTestWritablePath(
    path.join(
      path.dirname(awHome),
      '.aw-local-marketplace-staging',
      `.runtime-state-${identity}`,
    ),
    'active marketplace runtime coordination root',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或登记 AW_HOME 同盘 sibling lock 路径。',
  );
}

export async function acquireActiveMarketplaceRuntimeLease(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessLockLease> {
  const coordinationRoot = resolveActiveMarketplaceRuntimeCoordinationRoot(env);
  return acquireActiveMarketplaceRuntimeLeaseAtRoot(coordinationRoot);
}

export async function acquireActiveMarketplaceRuntimeLeaseAtRoot(
  coordinationRoot: string,
): Promise<ProcessLockLease> {
  await fs.ensureDir(coordinationRoot);
  return acquireProcessLock({
    lockPath: path.join(coordinationRoot, ACTIVE_MARKETPLACE_RUNTIME_LOCK_FILE),
    timeoutMs: ACTIVE_MARKETPLACE_RUNTIME_LOCK_TIMEOUT_MS,
  });
}

export async function acquireActiveMarketplaceLifecycleLease(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessLockLease> {
  const coordinationRoot = resolveActiveMarketplaceRuntimeCoordinationRoot(env);
  return acquireActiveMarketplaceLifecycleLeaseAtRoot(coordinationRoot);
}

export async function acquireActiveMarketplaceLifecycleLeaseAtRoot(
  coordinationRoot: string,
): Promise<ProcessLockLease> {
  await fs.ensureDir(coordinationRoot);
  await activeMarketplaceLifecycleBeforeAcquireHookForTests?.(coordinationRoot);
  return acquireProcessLock({
    lockPath: path.join(coordinationRoot, 'lifecycle-state.lock'),
    timeoutMs: ACTIVE_MARKETPLACE_RUNTIME_LOCK_TIMEOUT_MS,
  });
}

export async function releaseActiveMarketplaceCoordinationLease(
  lease: ProcessLockLease,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await lease.release();
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RETRYABLE_RELEASE_ERROR_CODES.has(code)) throw error;
    }
  }
  throw lastError;
}

async function withCoordinationLease<T>(
  lease: ProcessLockLease,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let actionError: unknown;
  try {
    result = await action();
  } catch (error) {
    actionError = error;
  }
  try {
    await releaseActiveMarketplaceCoordinationLease(lease);
  } catch (releaseError) {
    if (actionError !== undefined) {
      throw new AggregateError(
        [actionError, releaseError],
        `${label} action and lease release both failed.`,
        { cause: actionError },
      );
    }
    throw releaseError;
  }
  if (actionError !== undefined) throw actionError;
  return result as T;
}

export async function withActiveMarketplaceRuntimeLease<T>(
  env: NodeJS.ProcessEnv | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const lease = await acquireActiveMarketplaceRuntimeLease(env);
  return withCoordinationLease(lease, 'Active marketplace runtime', action);
}

export async function withActiveMarketplaceLifecycleLease<T>(
  env: NodeJS.ProcessEnv | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const lease = await acquireActiveMarketplaceLifecycleLease(env);
  return withCoordinationLease(lease, 'Active marketplace lifecycle', action);
}
