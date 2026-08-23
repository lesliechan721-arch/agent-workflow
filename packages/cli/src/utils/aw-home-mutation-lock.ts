import path from 'node:path';

import {
  releaseActiveMarketplaceCoordinationLease,
  resolveActiveMarketplaceRuntimeCoordinationRoot,
} from './active-marketplace-runtime-lock.js';
import { acquireProcessLock } from './process-lock.js';
import { ensureRegularDirectoryPath } from './state-paths.js';

const AW_HOME_MUTATION_LOCK_TIMEOUT_MS = 600_000;
const tokenRoots = new WeakMap<object, string>();

declare const awHomeMutationTokenBrand: unique symbol;

export type AwHomeMutationToken = Readonly<{
  [awHomeMutationTokenBrand]: true;
}>;

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
  action: (token: AwHomeMutationToken) => Promise<T>;
}): Promise<T> {
  const coordinationRoot = resolveActiveMarketplaceRuntimeCoordinationRoot(options.env);
  if (options.token !== undefined) {
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
    await releaseActiveMarketplaceCoordinationLease(lease);
  } catch {
    releaseWarning();
  }
  if (!succeeded) throw actionError;
  return result as T;
}
