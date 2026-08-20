import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogProviderRuntimeOptions,
  CatalogSourceResolution,
  GitCatalogSource,
} from '../types.js';
import {
  calculateCatalogSourceIdentity,
  canonicalizeCatalogGitUrl,
} from './catalog-source-identity.js';
import {
  catalogSourceCacheInternal,
  type CatalogSourceCacheLocation,
} from './catalog-source-cache.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import { validateCatalogSnapshot } from './catalog-snapshot.js';
import { resolveCatalogSourceRef } from './catalog-sources.js';
import { compareStrictSemVer } from './manifest.js';
import { NativeCliError, runNativeCli } from './native-cli.js';

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_REMOTE_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_LOCK_TIMEOUT_MS = 10_000;
const {
  assertCatalogSourceObjectCacheHealthy,
  observeAndReserveCatalogSourceObservation,
  persistCatalogSourceObjectFault,
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  resolveCatalogSourceCacheLocation,
  withCatalogSourceCacheLease,
  withCatalogSourceCacheLock,
} = catalogSourceCacheInternal;

class CatalogGitDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Catalog Git resolution exceeded AW_CATALOG_REMOTE_TIMEOUT_MS=${timeoutMs}.`);
    this.name = 'CatalogGitDeadlineError';
  }
}

class CatalogGitRemoteUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CatalogGitRemoteUnavailableError';
  }
}

class CatalogGitPolicyError extends Error {
  readonly sensitiveTransports: string[];

  constructor(message: string, cause?: unknown, sensitiveTransports: string[] = []) {
    super(message, { cause });
    this.name = 'CatalogGitPolicyError';
    this.sensitiveTransports = sensitiveTransports;
  }
}

class CatalogGitFatalCleanupError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CatalogGitFatalCleanupError';
  }
}

export interface CatalogGitProviderTestHooks {
  beforeObservationLock?: (observation: {
    sourceId: string;
  }) => Promise<void>;
  afterRemoteObservationBeforeReservation?: (observation: {
    sourceId: string;
    commit: string;
  }) => Promise<void>;
  afterObservation?: (observation: {
    sourceId: string;
    commit: string;
    observationOrder: number;
  }) => Promise<void>;
}

let catalogGitProviderTestHooks: CatalogGitProviderTestHooks | undefined;

export function setCatalogGitProviderTestHooksForTests(
  hooks: CatalogGitProviderTestHooks | undefined,
): void {
  catalogGitProviderTestHooks = hooks;
}

interface CatalogGitDeadline {
  timeoutMs: number;
  signal?: AbortSignal;
  remainingMs(maximum?: number): number | undefined;
  dispose(): void;
}

function readRemoteTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.AW_CATALOG_REMOTE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_REMOTE_TIMEOUT_MS;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new Error('Invalid AW_CATALOG_REMOTE_TIMEOUT_MS: expected 0 or an integer in range 100..60000.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (value !== 0 && (value < 100 || value > 60_000))) {
    throw new Error('Invalid AW_CATALOG_REMOTE_TIMEOUT_MS: expected 0 or an integer in range 100..60000.');
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Catalog Git resolution aborted.');
  error.name = 'AbortError';
  throw error;
}

function createDeadlineSignal(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): CatalogGitDeadline {
  if (timeoutMs === 0) {
    return {
      timeoutMs,
      signal: outerSignal,
      remainingMs: (maximum) => maximum,
      dispose() {},
    };
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timeout = setTimeout(() => {
    controller.abort(new CatalogGitDeadlineError(timeoutMs));
  }, timeoutMs);
  const abort = () => controller.abort(outerSignal?.reason);
  outerSignal?.addEventListener('abort', abort, { once: true });
  if (outerSignal?.aborted) abort();
  return {
    timeoutMs,
    signal: controller.signal,
    remainingMs(maximum) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        controller.abort(new CatalogGitDeadlineError(timeoutMs));
        throwIfAborted(controller.signal);
      }
      return maximum === undefined ? remaining : Math.min(maximum, remaining);
    },
    dispose() {
      clearTimeout(timeout);
      outerSignal?.removeEventListener('abort', abort);
    },
  };
}

async function withCatalogGitLockDeadline<T>(options: {
  deadline: CatalogGitDeadline;
  maximumMs: number;
  action: (timeoutMs: number) => Promise<T>;
}): Promise<T> {
  const remaining = options.deadline.timeoutMs === 0
    ? undefined
    : options.deadline.remainingMs();
  const deadlineLimited = remaining !== undefined && remaining <= options.maximumMs;
  const timeoutMs = remaining === undefined
    ? options.maximumMs
    : Math.min(options.maximumMs, remaining);
  try {
    return await options.action(timeoutMs);
  } catch (error) {
    if (options.deadline.signal?.aborted) throwIfAborted(options.deadline.signal);
    if (
      deadlineLimited
      && error instanceof Error
      && error.message.startsWith('Timed out waiting for process lock:')
    ) {
      throw new CatalogGitDeadlineError(options.deadline.timeoutMs);
    }
    throw error;
  }
}

function resolveSafeSshCommand(): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    return `"${executable}" -F NUL -oBatchMode=yes -oPermitLocalCommand=no -oProxyCommand=none`;
  }
  return '/usr/bin/ssh -F /dev/null -oBatchMode=yes -oPermitLocalCommand=no -oProxyCommand=none';
}

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith('GIT_')) output[key] = value;
  }
  const sshCommand = resolveSafeSshCommand();
  return {
    ...output,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: '',
    GIT_SSH_COMMAND: sshCommand,
    GIT_SSH_VARIANT: 'ssh',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
  };
}

function gitSafetyConfig(): string[] {
  return [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    '-c', 'protocol.file.allow=always',
    '-c', `core.sshCommand=${resolveSafeSshCommand()}`,
  ];
}

function tarEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output = { ...env };
  delete output.TAR_OPTIONS;
  delete output.TAPE;
  return output;
}

async function runCatalogProcess(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(options.signal);
  try {
    return await runNativeCli({
      command: options.command,
      args: options.args,
      env: options.env,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    if (error instanceof NativeCliError && error.cleanupError) {
      throw new CatalogGitFatalCleanupError(
        'Catalog Git process cleanup could not be confirmed.',
        error,
      );
    }
    throwIfAborted(options.signal);
    throw error;
  }
}

async function runGit(options: {
  gitDir?: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<{ stdout: string; stderr: string }> {
  return runCatalogProcess({
    command: 'git',
    args: [
      ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
      ...gitSafetyConfig(),
      ...options.args,
    ],
    env: gitEnvironment(options.env),
    signal: options.deadline.signal,
    timeoutMs: options.deadline.remainingMs(),
  });
}

function sanitizeGitText(value: string, transports: string[]): string {
  let output = value;
  for (const transport of transports.filter(Boolean)) {
    output = output.split(transport).join('<catalog-git-source>');
  }
  output = output.replace(/https:\/\/[^\s/@]+@/gi, 'https://<redacted>@');
  output = output.replace(/([?&](?:token|access_token|password|key)=)[^&#\s]+/gi, '$1<redacted>');
  return output.slice(0, 4_000);
}

function sanitizeErrorTree(error: unknown, transports: string[], depth = 0): Error {
  const message = sanitizeGitText(error instanceof Error ? error.message : String(error), transports);
  if (depth >= 5 || !(error instanceof Error) || error.cause === undefined) {
    return new Error(message);
  }
  return new Error(message, { cause: sanitizeErrorTree(error.cause, transports, depth + 1) });
}

function createPublicGitError(
  sourceId: string,
  error: unknown,
  transports: string[],
): Error {
  const cause = sanitizeErrorTree(error, transports);
  const message = `Cannot resolve catalog Git source "${sourceId}": ${cause.message}`;
  return error instanceof CatalogGitFatalCleanupError
    ? new CatalogGitFatalCleanupError(message, cause)
    : new Error(message, { cause });
}

async function assertGitUrlIdentity(options: {
  gitDir?: string;
  configuredTransport: string;
  configuredIdentityUrl: string;
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<void> {
  let actualTransport: string;
  try {
    actualTransport = (await runGit({
      gitDir: options.gitDir,
      args: ['ls-remote', '--get-url', '--', options.configuredTransport],
      env: options.env,
      deadline: options.deadline,
    })).stdout.trim();
  } catch (error) {
    if (error instanceof CatalogGitFatalCleanupError) throw error;
    throw new CatalogGitPolicyError('Cannot verify the effective catalog Git URL.', error);
  }
  let actualIdentityUrl: string;
  try {
    actualIdentityUrl = canonicalizeCatalogGitUrl(actualTransport);
  } catch (error) {
    throw new CatalogGitPolicyError(
      'Git URL rewrite selected a disallowed catalog transport.',
      error,
      [actualTransport],
    );
  }
  if (actualIdentityUrl !== options.configuredIdentityUrl) {
    throw new CatalogGitPolicyError(
      'Git URL rewrite changed the catalog source identity; remove the matching insteadOf rule.',
      undefined,
      [actualTransport],
    );
  }
}

interface RemoteRef {
  sha: string;
  ref: string;
}

function parseLsRemote(stdout: string): RemoteRef[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    return match ? [{ sha: match[1]!, ref: match[2]! }] : [];
  });
}

function resolveAdvertisedRef(requestedRef: string, refs: RemoteRef[]): RemoteRef {
  if (requestedRef.startsWith('refs/')) {
    const exact = refs.find((entry) => entry.ref === requestedRef);
    if (!exact) throw new CatalogGitPolicyError(`Catalog Git ref "${requestedRef}" does not exist.`);
    return refs.find((entry) => entry.ref === `${requestedRef}^{}`) ?? exact;
  }
  const branch = refs.find((entry) => entry.ref === `refs/heads/${requestedRef}`);
  const tag = refs.find((entry) => entry.ref === `refs/tags/${requestedRef}`);
  if (branch && tag) {
    throw new CatalogGitPolicyError(
      `Catalog Git ref "${requestedRef}" is ambiguous between a branch and tag.`,
    );
  }
  const selected = branch ?? tag;
  if (!selected) throw new CatalogGitPolicyError(`Catalog Git ref "${requestedRef}" does not exist.`);
  return tag
    ? refs.find((entry) => entry.ref === `${tag.ref}^{}`) ?? tag
    : selected;
}

interface GitFetchTarget {
  fetchSpec: string;
  observedCommit: string;
  objectFormat: 'sha1' | 'sha256';
}

async function resolveFetchTarget(options: {
  transport: string;
  requestedRef: string;
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<GitFetchTarget> {
  if (COMMIT_PATTERN.test(options.requestedRef)) {
    return {
      fetchSpec: options.requestedRef,
      observedCommit: options.requestedRef,
      objectFormat: options.requestedRef.length === 64 ? 'sha256' : 'sha1',
    };
  }
  let advertised: RemoteRef[];
  try {
    advertised = parseLsRemote((await runGit({
      args: ['ls-remote', '--', options.transport],
      env: options.env,
      deadline: options.deadline,
    })).stdout);
  } catch (error) {
    if (error instanceof CatalogGitFatalCleanupError) throw error;
    throw new CatalogGitRemoteUnavailableError('Catalog Git remote ref listing failed.', error);
  }
  const selected = resolveAdvertisedRef(options.requestedRef, advertised);
  return {
    fetchSpec: selected.sha,
    observedCommit: selected.sha,
    objectFormat: selected.sha.length === 64 ? 'sha256' : 'sha1',
  };
}

async function validateBareRepository(options: {
  objectsDir: string;
  objectFormat: 'sha1' | 'sha256';
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<boolean> {
  const stat = await lstatIfExists(options.objectsDir);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  try {
    await assertManagedBareTreeSafe(options.objectsDir);
    const bare = await runGit({
      gitDir: options.objectsDir,
      args: ['rev-parse', '--is-bare-repository'],
      env: options.env,
      deadline: options.deadline,
    });
    const objectFormat = await runGit({
      gitDir: options.objectsDir,
      args: ['rev-parse', '--show-object-format'],
      env: options.env,
      deadline: options.deadline,
    });
    if (bare.stdout.trim() !== 'true' || objectFormat.stdout.trim() !== options.objectFormat) {
      return false;
    }
    const localConfig = await runGit({
      gitDir: options.objectsDir,
      args: ['config', '--local', '--name-only', '--null', '--list'],
      env: options.env,
      deadline: options.deadline,
    });
    const allowedKeys = new Set([
      'core.repositoryformatversion',
      'core.filemode',
      'core.bare',
      'core.logallrefupdates',
      'core.ignorecase',
      'core.precomposeunicode',
      'extensions.objectformat',
      'extensions.compatobjectformat',
    ]);
    const keys = localConfig.stdout
      .split('\0')
      .filter(Boolean)
      .map((key) => key.toLowerCase());
    return keys.every((key) => allowedKeys.has(key));
  } catch (error) {
    if (error instanceof CatalogGitFatalCleanupError) throw error;
    throwIfAborted(options.deadline.signal);
    return false;
  }
}

async function lstatIfExists(filePath: string): Promise<Stats | null> {
  return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertManagedBareTreeSafe(objectsDir: string): Promise<void> {
  const pending = [objectsDir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory);
    const inspected = await Promise.all(entries.map(async (name) => {
      const absolutePath = path.join(directory, name);
      return { absolutePath, stat: await fs.lstat(absolutePath) };
    }));
    for (const { absolutePath, stat } of inspected) {
      const relativePath = path.relative(objectsDir, absolutePath).split(path.sep).join('/');
      const normalized = relativePath.toLowerCase();
      if (
        normalized === 'objects/info/alternates'
        || normalized === 'objects/info/http-alternates'
      ) {
        throw new Error(`Managed catalog Git object cache contains forbidden alternates: ${relativePath}`);
      }
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Managed catalog Git object cache contains an unsafe entry: ${relativePath}`);
      }
      if (stat.isDirectory()) pending.push(absolutePath);
    }
  }
}

async function quarantineObjectDirectory(
  location: CatalogSourceCacheLocation,
  directory: string,
): Promise<void> {
  if (!await lstatIfExists(directory)) return;
  await fs.ensureDir(location.quarantineDir);
  await fs.rename(directory, path.join(
    location.quarantineDir,
    `objects-${crypto.randomUUID()}`,
  ));
}

async function ensureBareRepository(options: {
  location: CatalogSourceCacheLocation;
  objectFormat: 'sha1' | 'sha256';
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<void> {
  if (await lstatIfExists(options.location.objectsDir)) {
    if (await validateBareRepository({
      objectsDir: options.location.objectsDir,
      objectFormat: options.objectFormat,
      env: options.env,
      deadline: options.deadline,
    })) return;
    await quarantineObjectDirectory(options.location, options.location.objectsDir);
  }

  const staging = path.join(
    options.location.rootDir,
    `.objects-${crypto.randomUUID()}.tmp`,
  );
  try {
    await runGit({
      args: [
        '-c',
        'init.defaultRefFormat=files',
        'init',
        '--bare',
        `--object-format=${options.objectFormat}`,
        staging,
      ],
      env: options.env,
      deadline: options.deadline,
    });
    if (!await validateBareRepository({
      objectsDir: staging,
      objectFormat: options.objectFormat,
      env: options.env,
      deadline: options.deadline,
    })) {
      throw new Error('New catalog Git object cache did not validate as a bare repository.');
    }
    throwIfAborted(options.deadline.signal);
    await fs.rename(staging, options.location.objectsDir);
  } catch (error) {
    if (!(error instanceof CatalogGitFatalCleanupError)) {
      await quarantineObjectDirectory(options.location, staging);
    }
    throw error;
  }
}

async function fetchCommit(options: {
  objectsDir: string;
  transport: string;
  fetchSpec: string;
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<string> {
  const temporaryRef = `refs/aw/catalog/${crypto.randomUUID()}`;
  let cleanupConfirmed = true;
  try {
    try {
      await runGit({
        gitDir: options.objectsDir,
        args: [
          '-c',
          'fetch.fsckObjects=true',
          'fetch',
          '--force',
          '--no-tags',
          '--',
          options.transport,
          `${options.fetchSpec}:${temporaryRef}`,
        ],
        env: options.env,
        deadline: options.deadline,
      });
    } catch (error) {
      if (error instanceof CatalogGitFatalCleanupError) {
        cleanupConfirmed = false;
        throw error;
      }
      throw new CatalogGitRemoteUnavailableError('Catalog Git fetch failed.', error);
    }
    const commit = (await runGit({
      gitDir: options.objectsDir,
      args: ['rev-parse', '--verify', `${temporaryRef}^{commit}`],
      env: options.env,
      deadline: options.deadline,
    })).stdout.trim();
    if (!COMMIT_PATTERN.test(commit)) {
      throw new CatalogGitPolicyError('Catalog Git ref did not resolve to a complete commit SHA.');
    }
    return commit;
  } catch (error) {
    if (error instanceof CatalogGitFatalCleanupError) cleanupConfirmed = false;
    throw error;
  } finally {
    if (cleanupConfirmed && !options.deadline.signal?.aborted) {
      await runGit({
        gitDir: options.objectsDir,
        args: ['update-ref', '-d', temporaryRef],
        env: options.env,
        deadline: options.deadline,
      }).catch((error: unknown) => {
        if (error instanceof CatalogGitFatalCleanupError) throw error;
      });
    }
  }
}

async function materializeCommit(options: {
  objectsDir: string;
  commit: string;
  subdir?: string;
  destination: string;
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<void> {
  throwIfAborted(options.deadline.signal);
  await fs.ensureDir(options.destination);
  const archivePath = path.join(
    path.dirname(options.destination),
    `.archive-${crypto.randomUUID()}.tar`,
  );
  const treeish = options.subdir ? `${options.commit}:${options.subdir}` : options.commit;
  let retainArchive = false;
  try {
    await runGit({
      gitDir: options.objectsDir,
      args: ['archive', '--format=tar', `--output=${archivePath}`, treeish],
      env: options.env,
      deadline: options.deadline,
    });
    await runCatalogProcess({
      command: 'tar',
      args: ['-xf', archivePath, '-C', options.destination],
      env: tarEnvironment(options.env),
      signal: options.deadline.signal,
      timeoutMs: options.deadline.remainingMs(),
    });
  } catch (error) {
    if (error instanceof CatalogGitFatalCleanupError) {
      retainArchive = true;
      throw error;
    }
    throwIfAborted(options.deadline.signal);
    throw new CatalogGitPolicyError('Catalog Git commit materialization failed.', error);
  } finally {
    if (!retainArchive) await fs.remove(archivePath);
  }
}

function fromCacheEntry(
  entry: Awaited<ReturnType<typeof readCatalogSourceCache>> & {},
  source: 'remote' | 'cache',
  cacheFallback: boolean,
  remoteFailure?: string,
): CatalogSourceResolution {
  return {
    sourceId: entry.metadata.sourceId,
    sourceIdentity: entry.metadata.sourceIdentity,
    requestedRef: entry.metadata.requestedRef,
    resolvedCommit: entry.metadata.resolvedCommit,
    rootDir: entry.snapshotRoot,
    manifest: entry.validation.manifest,
    manifestDigest: entry.validation.manifestDigest,
    snapshotDigest: entry.validation.snapshotDigest,
    cacheEntryKey: entry.metadata.entryKey,
    source,
    cacheFallback,
    ...(remoteFailure ? { remoteFailure } : {}),
  };
}

function canUseRemoteFallback(
  failure: unknown,
  policy: CatalogProviderRuntimeOptions['freshnessPolicy'],
  callerSignal?: AbortSignal,
): boolean {
  if (policy !== 'requireRemote' || callerSignal?.aborted) return false;
  return failure instanceof CatalogGitRemoteUnavailableError
    || failure instanceof CatalogGitDeadlineError;
}

async function resolveGitCatalogSource(
  source: GitCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  return withCatalogSourceCacheLease({
    env: options.env,
    signal: options.signal,
    action: () => resolveGitCatalogSourceWithLease(source, options),
  });
}

/** @internal Provider bridge for the lease-scoped multi-source resolver and provider tests. */
export const catalogGitProviderInternal = {
  resolve: resolveGitCatalogSource,
};

async function resolveGitCatalogSourceWithLease(
  source: GitCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  const env = options.env ?? process.env;
  if (options.signal?.aborted) {
    throw createPublicGitError(
      source.id,
      options.signal.reason ?? new Error('Catalog Git resolution aborted.'),
      [source.url],
    );
  }
  const configuredIdentityUrl = canonicalizeCatalogGitUrl(source.url);
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const requestedRef = resolveCatalogSourceRef(source.refPolicy, options.cliVersion);
  const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
  try {
    await assertCatalogSourceObjectCacheHealthy(location);
  } catch (error) {
    throw createPublicGitError(source.id, error, [source.url]);
  }
  if (options.freshnessPolicy === 'cacheFirst') {
    const cached = await readCatalogSourceCache({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: options.cliVersion,
      signal: options.signal,
    });
    if (cached) return fromCacheEntry(cached, 'cache', false);
  }

  const deadline = createDeadlineSignal(options.signal, readRemoteTimeout(env));
  try {
    await assertGitUrlIdentity({
      configuredTransport: source.url,
      configuredIdentityUrl,
      env,
      deadline,
    });
    await catalogGitProviderTestHooks?.beforeObservationLock?.({ sourceId: source.id });
    const observed = await withCatalogGitLockDeadline({
      deadline,
      maximumMs: DEFAULT_CACHE_LOCK_TIMEOUT_MS,
      action: (lockTimeoutMs) => observeAndReserveCatalogSourceObservation({
        location,
        signal: deadline.signal,
        lockTimeoutMs,
        observe: async () => {
          const target = await resolveFetchTarget({
            transport: source.url,
            requestedRef,
            env,
            deadline,
          });
          await catalogGitProviderTestHooks?.afterRemoteObservationBeforeReservation?.({
            sourceId: source.id,
            commit: target.observedCommit,
          });
          return target;
        },
      }),
    });
    const target = observed.observation;
    const observationOrder = observed.observationOrder;
    await catalogGitProviderTestHooks?.afterObservation?.({
      sourceId: source.id,
      commit: target.observedCommit,
      observationOrder,
    });
    const entry = await withCatalogGitLockDeadline({
      deadline,
      maximumMs: DEFAULT_CACHE_LOCK_TIMEOUT_MS,
      action: (timeoutMs) => withCatalogSourceCacheLock({
        location,
        name: 'objects',
        signal: deadline.signal,
        timeoutMs,
        retainLockOnError: (error) => error instanceof CatalogGitFatalCleanupError,
        action: async () => {
        await ensureBareRepository({ location, objectFormat: target.objectFormat, env, deadline });
        await assertGitUrlIdentity({
          gitDir: location.objectsDir,
          configuredTransport: source.url,
          configuredIdentityUrl,
          env,
          deadline,
        });
        const commit = await fetchCommit({
          objectsDir: location.objectsDir,
          transport: source.url,
          fetchSpec: target.fetchSpec,
          env,
          deadline,
        });
        const stagingRoot = path.join(location.rootDir, `.materialize-${crypto.randomUUID()}.tmp`);
        let retainStaging = false;
        let published = false;
        try {
          await materializeCommit({
            objectsDir: location.objectsDir,
            commit,
            subdir: source.subdir,
            destination: stagingRoot,
            env,
            deadline,
          });
          const validation = await validateCatalogSnapshot(stagingRoot);
          throwIfAborted(deadline.signal);
          if (compareStrictSemVer(
            options.cliVersion,
            validation.manifest.compatibility.aw.minVersion,
          ) < 0) {
            throw new CatalogProviderCompatibilityError({
              sourceId: source.id,
              minAwVersion: validation.manifest.compatibility.aw.minVersion,
              selection: source.refPolicy.type,
            });
          }
          const publishedEntry = await withCatalogGitLockDeadline({
            deadline,
            maximumMs: DEFAULT_CACHE_LOCK_TIMEOUT_MS,
            action: (lockTimeoutMs) => publishCatalogSourceCacheEntry({
              location,
              sourceId: source.id,
              sourceIdentity,
              requestedRef,
              resolvedCommit: commit,
              snapshotRoot: stagingRoot,
              validation,
              observationOrder,
              signal: deadline.signal,
              lockTimeoutMs,
            }),
          });
          published = true;
          return publishedEntry;
        } catch (error) {
          retainStaging = error instanceof CatalogGitFatalCleanupError;
          throw error;
        } finally {
          if (!retainStaging) {
            try {
              await fs.remove(stagingRoot);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code ?? '';
              if (!published || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
              try {
                process.emitWarning(
                  `Catalog Git source was published, but materialization cleanup failed with ${code}.`,
                  { code: 'AW_CATALOG_PROVIDER_CLEANUP_FAILED' },
                );
              } catch {
                // Diagnostics cannot replace a published cache result.
              }
            }
          }
        }
        },
      }),
    });
    return fromCacheEntry(entry, 'remote', false);
  } catch (error) {
    let failure: unknown = error instanceof CatalogGitFatalCleanupError
      ? error
      : deadline.signal?.aborted && deadline.signal.reason instanceof Error
      ? deadline.signal.reason
      : error;
    if (failure instanceof CatalogGitFatalCleanupError) {
      try {
        await persistCatalogSourceObjectFault({
          location,
          reason: 'Catalog Git process cleanup could not be confirmed.',
        });
      } catch (faultError) {
        failure = new CatalogGitFatalCleanupError(
          'Catalog Git process cleanup could not be confirmed and its persistent fault marker could not be recorded.',
          faultError,
        );
      }
    }
    if (failure instanceof CatalogProviderCompatibilityError) throw failure;
    const sensitiveTransports = [
      source.url,
      ...(failure instanceof CatalogGitPolicyError ? failure.sensitiveTransports : []),
    ];
    const publicFailure = sanitizeErrorTree(failure, sensitiveTransports);
    if (canUseRemoteFallback(failure, options.freshnessPolicy, options.signal)) {
      const cached = await readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef,
        cliVersion: options.cliVersion,
        signal: options.signal,
      });
      if (cached) return fromCacheEntry(cached, 'cache', true, publicFailure.message);
    }
    throw createPublicGitError(source.id, failure, sensitiveTransports);
  } finally {
    deadline.dispose();
  }
}
