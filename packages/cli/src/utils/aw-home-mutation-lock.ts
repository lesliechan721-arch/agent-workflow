import crypto from 'node:crypto';
import path from 'node:path';

import { acquireProcessLock, type ProcessLockLease } from './process-lock.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';
import { assertTestWritablePath } from './test-path-fence.js';

const AW_HOME_MUTATION_LOCK_TIMEOUT_MS = 600_000;
const tokenRoots = new WeakMap<object, string>();

declare const awHomeMutationTokenBrand: unique symbol;

export type AwHomeMutationToken = Readonly<{
  [awHomeMutationTokenBrand]: true;
}>;

function resolveAwHomeMutationCoordinationRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const awHome = canonicalizePathThroughExistingAncestorSync(resolveAwHome(env));
  const identity = crypto.createHash('sha256')
    .update(awHome)
    .digest('hex')
    .slice(0, 16);
  return assertTestWritablePath(
    path.join(
      path.dirname(awHome),
      '.aw-local-marketplace-staging',
      `.runtime-state-${identity}`,
    ),
    'AW_HOME mutation coordination root',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或登记 AW_HOME 同盘 sibling lock 路径。',
  );
}

async function releaseMutationLease(lease: ProcessLockLease): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await lease.release();
      return;
    } catch (error) {
      lastError = error;
      if (!new Set(['EACCES', 'EBUSY', 'EINTR', 'EIO', 'ENOTEMPTY', 'EPERM']).has(
        (error as NodeJS.ErrnoException).code ?? '',
      )) {
        throw error;
      }
    }
  }
  await lease.release().catch(() => undefined);
  throw lastError;
}

function releaseWarning(): void {
  try {
    process.emitWarning(
      'AW_HOME mutation completed, but its lock release failed.',
      { code: 'AW_HOME_MUTATION_LOCK_RELEASE_FAILED' },
    );
  } catch {
    // Diagnostics cannot replace the action result.
  }
}

export async function withAwHomeMutationLock<T>(options: {
  env?: NodeJS.ProcessEnv;
  token?: AwHomeMutationToken;
  signal?: AbortSignal;
  action: (token: AwHomeMutationToken) => Promise<T>;
}): Promise<T> {
  const coordinationRoot = resolveAwHomeMutationCoordinationRoot(options.env);
  if (options.token !== undefined) {
    options.signal?.throwIfAborted();
    const tokenRoot = tokenRoots.get(options.token);
    if (tokenRoot === undefined) {
      throw new Error('Invalid AW_HOME mutation token.');
    }
    if (tokenRoot !== coordinationRoot) {
      throw new Error('AW_HOME mutation token belongs to a different coordination root.');
    }
    return options.action(options.token);
  }

  await ensureRegularDirectoryPath(coordinationRoot, 'AW_HOME mutation coordination root');
  const lease = await acquireProcessLock({
    lockPath: path.join(coordinationRoot, 'aw-home-mutation.lock'),
    timeoutMs: AW_HOME_MUTATION_LOCK_TIMEOUT_MS,
    signal: options.signal,
  });
  const token = Object.freeze({}) as AwHomeMutationToken;
  tokenRoots.set(token, coordinationRoot);

  let result: T | undefined;
  let actionError: unknown;
  let succeeded = false;
  try {
    result = await options.action(token);
    succeeded = true;
  } catch (error) {
    actionError = error;
  }
  tokenRoots.delete(token);
  try {
    await releaseMutationLease(lease);
  } catch {
    releaseWarning();
  }
  if (!succeeded) throw actionError;
  return result as T;
}
