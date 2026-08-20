import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

const execFileAsync = promisify(execFile);
const PROCESS_INSTANCE_TOKEN = crypto.randomUUID();
let currentProcessStartIdentity: Promise<string> | null = null;

export interface ProcessLockOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  processStartIdentity: string;
  acquiredAt: string;
}

export interface ProcessLockLease {
  lockPath: string;
  owner: ProcessLockOwner;
  release(): Promise<void>;
}

export interface ProcessLockFileSystem {
  mkdir(targetPath: string): Promise<unknown>;
  writeFile(targetPath: string, contents: string, options: { flag: 'wx' }): Promise<unknown>;
  readFile(targetPath: string, encoding: 'utf8'): Promise<string>;
  readdir(targetPath: string): Promise<string[]>;
  stat(targetPath: string): Promise<fs.Stats>;
  lstat(targetPath: string): Promise<fs.Stats>;
  rename(sourcePath: string, targetPath: string): Promise<unknown>;
  link(existingPath: string, newPath: string): Promise<unknown>;
  copyFile(sourcePath: string, targetPath: string, flags: number): Promise<unknown>;
  unlink(targetPath: string): Promise<unknown>;
  rmdir(targetPath: string): Promise<unknown>;
}

export interface ProcessLockTestHooks {
  afterMkdir?: () => Promise<void>;
  afterOwnerTempWritten?: (tempPath: string) => Promise<void>;
  afterStaleObserve?: () => Promise<void>;
  afterOwnerClaim?: (claimPath: string) => Promise<void>;
  afterReleaseClaim?: (claimPath: string) => Promise<void>;
}

const defaultFileSystem: ProcessLockFileSystem = {
  mkdir: (targetPath) => fs.mkdir(targetPath),
  writeFile: (targetPath, contents, options) => fs.writeFile(targetPath, contents, options),
  readFile: (targetPath, encoding) => fs.readFile(targetPath, encoding),
  readdir: (targetPath) => fs.readdir(targetPath),
  stat: (targetPath) => fs.stat(targetPath),
  lstat: (targetPath) => fs.lstat(targetPath),
  rename: (sourcePath, targetPath) => fs.rename(sourcePath, targetPath),
  link: (existingPath, newPath) => fs.link(existingPath, newPath),
  copyFile: (sourcePath, targetPath, flags) => fs.copyFile(sourcePath, targetPath, flags),
  unlink: (targetPath) => fs.unlink(targetPath),
  rmdir: (targetPath) => fs.rmdir(targetPath),
};

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isNotEmpty(error: unknown): boolean {
  return errorCode(error) === 'ENOTEMPTY' || errorCode(error) === 'EEXIST';
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  if (process.platform === 'linux') {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (!stat) return null;
    const closeParen = stat.lastIndexOf(')');
    const fields = closeParen === -1 ? [] : stat.slice(closeParen + 2).split(' ');
    return fields[19] ? `linux:${fields[19]}` : null;
  }
  if (process.platform === 'darwin') {
    // lstart has second-level precision. Equality is fail-closed; ambiguity only delays recovery.
    try {
      const result = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 1_000 });
      const value = String(result.stdout).trim();
      return value ? `darwin:${value}` : null;
    } catch { return null; }
  }
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const result = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`], { timeout: 1_000 });
      const value = String(result.stdout).trim();
      return /^\d+$/.test(value) ? `win32:${value}` : null;
    } catch { return null; }
  }
  return null;
}

async function currentStartIdentity(
  reader: (pid: number) => Promise<string | null>,
): Promise<string> {
  if (reader !== readProcessStartIdentity) {
    return await reader(process.pid) ?? `instance:${PROCESS_INSTANCE_TOKEN}`;
  }
  currentProcessStartIdentity ??= reader(process.pid).then((value) =>
    value ?? `instance:${PROCESS_INSTANCE_TOKEN}`);
  return currentProcessStartIdentity;
}

function isOwner(value: unknown): value is ProcessLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.schemaVersion === 1
    && typeof owner.token === 'string'
    && /^[0-9a-f-]{24,36}$/.test(owner.token)
    && typeof owner.pid === 'number'
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.processStartIdentity === 'string' && owner.processStartIdentity.length > 0
    && typeof owner.acquiredAt === 'string' && !Number.isNaN(Date.parse(owner.acquiredAt));
}

interface OwnerFileRead {
  raw: string;
  owner: ProcessLockOwner | null;
}

async function readOwnerFile(
  fileSystem: ProcessLockFileSystem,
  ownerPath: string,
): Promise<OwnerFileRead> {
  const raw = await fileSystem.readFile(ownerPath, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  return { raw, owner: isOwner(parsed) ? parsed : null };
}

async function ownerIsRecoverable(
  owner: ProcessLockOwner,
  identityReader: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  if (!processIsAlive(owner.pid)) return true;
  const current = await identityReader(owner.pid);
  return current !== null && current !== owner.processStartIdentity;
}

async function releaseClaimWasCompleted(
  fileSystem: ProcessLockFileSystem,
  lockPath: string,
  releasingOwner: ProcessLockOwner,
): Promise<boolean> {
  let lockStat: fs.Stats;
  try {
    lockStat = await fileSystem.lstat(lockPath);
  } catch (error) {
    return isMissing(error);
  }
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) return false;
  let entries: string[];
  try {
    entries = await fileSystem.readdir(lockPath);
  } catch (error) {
    return isMissing(error);
  }
  if (entries.length === 0) return true;
  if (entries.length !== 1 || entries[0] !== 'owner.json') return false;
  let current: OwnerFileRead;
  try {
    current = await readOwnerFile(fileSystem, path.join(lockPath, 'owner.json'));
  } catch (error) {
    if (!isMissing(error)) return false;
    try {
      await fileSystem.lstat(lockPath);
      return false;
    } catch (lockError) {
      return isMissing(lockError);
    }
  }
  return current.owner !== null && current.owner.token !== releasingOwner.token;
}

async function restoreClaimNoReplace(
  fileSystem: ProcessLockFileSystem,
  claimPath: string,
  ownerPath: string,
): Promise<boolean> {
  try {
    await fileSystem.link(claimPath, ownerPath);
  } catch (error) {
    if (isExists(error)) return false;
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(errorCode(error) ?? '')) throw error;
    try {
      await fileSystem.copyFile(claimPath, ownerPath, fsConstants.COPYFILE_EXCL);
    } catch (copyError) {
      if (isExists(copyError)) return false;
      throw copyError;
    }
  }
  await fileSystem.unlink(claimPath);
  return true;
}

async function tryRecoverLock(options: {
  lockPath: string;
  graceMs: number;
  fileSystem: ProcessLockFileSystem;
  identityReader: (pid: number) => Promise<string | null>;
  persistentFaultPath?: string;
  hooks?: ProcessLockTestHooks;
}): Promise<boolean> {
  if (options.persistentFaultPath) {
    try {
      await options.fileSystem.lstat(options.persistentFaultPath);
      throw new Error(`Process lock has a persistent fault marker: ${options.persistentFaultPath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const ownerPath = path.join(options.lockPath, 'owner.json');
  const lockStat = await options.fileSystem.lstat(options.lockPath);
  if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
    throw new Error(`Process lock path is not a regular directory: ${options.lockPath}`);
  }
  const entries = await options.fileSystem.readdir(options.lockPath);
  const claims = entries.filter((entry) => /^(?:stale|release)-[0-9a-f-]+\.json$/.test(entry));
  if (!entries.includes('owner.json')) {
    if (claims.length > 0) {
      if (Date.now() - lockStat.mtimeMs < options.graceMs) return false;
      const claimPath = path.join(options.lockPath, claims.sort()[0]!);
      if (claims.length === 1 && claims[0]!.startsWith('release-')) {
        const claimed = await readOwnerFile(options.fileSystem, claimPath);
        const filenameToken = claims[0]!.slice('release-'.length, -'.json'.length);
        if (claimed.owner?.token !== filenameToken) return false;
        await options.fileSystem.unlink(claimPath);
        try {
          await options.fileSystem.rmdir(options.lockPath);
          return true;
        } catch (error) {
          if (isMissing(error)) return true;
          if (isNotEmpty(error)) return false;
          throw error;
        }
      }
      await restoreClaimNoReplace(options.fileSystem, claimPath, ownerPath).catch(() => false);
      return false;
    }
    if (entries.length !== 0 || Date.now() - lockStat.mtimeMs < options.graceMs) return false;
    try {
      await options.fileSystem.rmdir(options.lockPath);
      return true;
    } catch (error) {
      if (isMissing(error)) return true;
      if (isNotEmpty(error)) return false;
      throw error;
    }
  }

  const observed = await readOwnerFile(options.fileSystem, ownerPath);
  if (Date.now() - lockStat.mtimeMs < options.graceMs) return false;
  if (observed.owner && !await ownerIsRecoverable(observed.owner, options.identityReader)) return false;
  await options.hooks?.afterStaleObserve?.();
  const claimPath = path.join(options.lockPath, `stale-${crypto.randomUUID()}.json`);
  try {
    await options.fileSystem.rename(ownerPath, claimPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  await options.hooks?.afterOwnerClaim?.(claimPath);
  let claimed: OwnerFileRead;
  try {
    claimed = await readOwnerFile(options.fileSystem, claimPath);
  } catch (error) {
    const restored = await restoreClaimNoReplace(options.fileSystem, claimPath, ownerPath).catch(() => false);
    if (!restored) throw new AggregateError([error], 'Cannot read or safely restore stale lock claim.');
    throw error;
  }
  const sameObservation = claimed.raw === observed.raw;
  const stillRecoverable = claimed.owner
    ? await ownerIsRecoverable(claimed.owner, options.identityReader)
    : true;
  if (!sameObservation || !stillRecoverable) {
    await restoreClaimNoReplace(options.fileSystem, claimPath, ownerPath);
    return false;
  }
  await options.fileSystem.unlink(claimPath);
  try {
    await options.fileSystem.rmdir(options.lockPath);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    if (isNotEmpty(error)) return false;
    throw error;
  }
}

export async function acquireProcessLock(options: {
  lockPath: string;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  persistentFaultPath?: string;
  malformedOwnerGraceMs?: number;
  fileSystem?: ProcessLockFileSystem;
  processStartIdentityReader?: (pid: number) => Promise<string | null>;
  testHooks?: ProcessLockTestHooks;
}): Promise<ProcessLockLease> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const identityReader = options.processStartIdentityReader ?? readProcessStartIdentity;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 10;
  const graceMs = options.malformedOwnerGraceMs ?? 250;
  const startedAt = Date.now();

  if (
    options.persistentFaultPath
    && path.dirname(options.persistentFaultPath) !== path.dirname(options.lockPath)
  ) {
    throw new Error('Process lock persistent fault marker must be a sibling of the lock path.');
  }

  const throwIfAborted = (): void => {
    if (!options.signal?.aborted) return;
    if (options.signal.reason instanceof Error) throw options.signal.reason;
    const error = new Error(`Process lock acquisition aborted: ${options.lockPath}`);
    error.name = 'AbortError';
    throw error;
  };
  const waitForPoll = async (): Promise<void> => {
    throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(finish, pollMs);
      const abort = (): void => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        try { throwIfAborted(); } catch (error) { reject(error); }
      };
      function finish(): void {
        options.signal?.removeEventListener('abort', abort);
        resolve();
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  };
  const throwIfPersistentlyFaulted = async (): Promise<void> => {
    if (!options.persistentFaultPath) return;
    try {
      await fileSystem.lstat(options.persistentFaultPath);
      throw new Error(`Process lock has a persistent fault marker: ${options.persistentFaultPath}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };

  while (true) {
    throwIfAborted();
    await throwIfPersistentlyFaulted();
    const owner: ProcessLockOwner = {
      schemaVersion: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      processStartIdentity: await currentStartIdentity(identityReader),
      acquiredAt: new Date().toISOString(),
    };
    let created = false;
    let ownerTempPath: string | null = null;
    try {
      await fileSystem.mkdir(options.lockPath);
      created = true;
      await options.testHooks?.afterMkdir?.();
      throwIfAborted();
      const ownerContents = `${JSON.stringify(owner, null, 2)}\n`;
      ownerTempPath = `${options.lockPath}.owner-${crypto.randomUUID()}.tmp`;
      await fileSystem.writeFile(
        ownerTempPath,
        ownerContents,
        { flag: 'wx' },
      );
      await options.testHooks?.afterOwnerTempWritten?.(ownerTempPath);
      throwIfAborted();
      const ownerPath = path.join(options.lockPath, 'owner.json');
      await fileSystem.link(ownerTempPath, ownerPath);
      const published = await readOwnerFile(fileSystem, ownerPath);
      if (
        published.raw !== ownerContents
        || published.owner?.token !== owner.token
        || published.owner.processStartIdentity !== owner.processStartIdentity
      ) {
        throw new Error('Published process lock owner does not match its creator identity.');
      }
      try {
        await fileSystem.unlink(ownerTempPath);
        ownerTempPath = null;
      } catch {
        // Keep the path attached to the lease so release can retry visible cleanup.
      }
      let released = false;
      let releaseClaimPath: string | null = null;
      let claimVerified = false;
      let claimRemoved = false;
      let unsafeClaim = false;
      return {
        lockPath: options.lockPath,
        owner,
        async release() {
          if (released) return;
          if (unsafeClaim) throw new Error('Process lock release claim is unsafe and requires manual recovery.');
          if (ownerTempPath) {
            try {
              await fileSystem.unlink(ownerTempPath);
              ownerTempPath = null;
            } catch (error) {
              if (isMissing(error)) {
                ownerTempPath = null;
              } else {
                throw error;
              }
            }
          }
          const ownerPath = path.join(options.lockPath, 'owner.json');
          if (!releaseClaimPath) {
            const candidateClaimPath = path.join(options.lockPath, `release-${owner.token}.json`);
            await fileSystem.rename(ownerPath, candidateClaimPath);
            releaseClaimPath = candidateClaimPath;
            await options.testHooks?.afterReleaseClaim?.(releaseClaimPath);
            let claimed: OwnerFileRead;
            try {
              claimed = await readOwnerFile(fileSystem, releaseClaimPath);
            } catch (error) {
              if (isMissing(error)) {
                if (await releaseClaimWasCompleted(fileSystem, options.lockPath, owner)) {
                  released = true;
                  return;
                }
                throw new Error('Process lock release claim disappeared before verified cleanup.', {
                  cause: error,
                });
              }
              const restored = await restoreClaimNoReplace(fileSystem, releaseClaimPath, ownerPath)
                .catch(() => false);
              if (!restored) unsafeClaim = true;
              releaseClaimPath = restored ? null : releaseClaimPath;
              throw error;
            }
            if (claimed.owner?.token !== owner.token
              || claimed.owner.processStartIdentity !== owner.processStartIdentity) {
              const restored = await restoreClaimNoReplace(fileSystem, releaseClaimPath, ownerPath)
                .catch(() => false);
              if (!restored) unsafeClaim = true;
              releaseClaimPath = restored ? null : releaseClaimPath;
              throw new Error('Process lock release claim does not match its owner token and identity.');
            }
            claimVerified = true;
          }
          if (!claimVerified) {
            try {
              await fileSystem.lstat(releaseClaimPath!);
            } catch (error) {
              if (isMissing(error)) {
                if (await releaseClaimWasCompleted(fileSystem, options.lockPath, owner)) {
                  released = true;
                  return;
                }
                throw new Error('Process lock release claim disappeared before verified cleanup.', {
                  cause: error,
                });
              }
              throw error;
            }
            throw new Error('Process lock release claim was not verified.');
          }
          if (!claimRemoved) {
            try {
              await fileSystem.unlink(releaseClaimPath!);
            } catch (error) {
              if (isMissing(error)) {
                if (await releaseClaimWasCompleted(fileSystem, options.lockPath, owner)) {
                  released = true;
                  return;
                }
                throw new Error('Process lock release claim disappeared before verified cleanup.', {
                  cause: error,
                });
              }
              throw error;
            }
            claimRemoved = true;
          }
          try {
            await fileSystem.rmdir(options.lockPath);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
          released = true;
        },
      };
    } catch (error) {
      if (created) {
        if (ownerTempPath) {
          await fileSystem.unlink(ownerTempPath).catch(() => undefined);
        }
        try {
          await fileSystem.rmdir(options.lockPath);
        } catch (cleanupError) {
          if (!isNotEmpty(cleanupError) && !isMissing(cleanupError)) {
            throw new AggregateError([error, cleanupError], 'Process lock owner publication and empty-directory cleanup failed.');
          }
        }
        throw error;
      }
      if (!isExists(error)) throw error;
    }
    try {
      await throwIfPersistentlyFaulted();
      if (await tryRecoverLock({
        lockPath: options.lockPath,
        graceMs,
        fileSystem,
        identityReader,
        persistentFaultPath: options.persistentFaultPath,
        hooks: options.testHooks,
      })) continue;
    } catch (error) {
      // The observed owner can complete release between mkdir(EEXIST) and recovery.
      // A missing lock path is normal contention progress, so retry acquisition.
      if (isMissing(error)) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Timed out waiting for process lock: ${options.lockPath}`);
        }
        await waitForPoll();
        continue;
      }
      throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for process lock: ${options.lockPath}`);
    }
    await waitForPoll();
  }
}
