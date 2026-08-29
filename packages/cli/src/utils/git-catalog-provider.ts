import crypto from 'node:crypto';
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
} from './catalog-source-cache.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import { validateCatalogSnapshotTransport } from './catalog-snapshot.js';
import { resolveCatalogSourceRef } from './catalog-sources.js';
import { checkAwCapabilitySupport } from './manifest.js';
import { NativeCliError, runNativeCli } from './native-cli.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_REMOTE_TIMEOUT_MS = 180_000;
const {
  ensureCatalogSourceCacheLocation,
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  resolveCatalogSourceCacheLocation,
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

function resolveSafeSshCommand(): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    return `"${executable}" -oBatchMode=yes -oPermitLocalCommand=no -oProxyCommand=none`;
  }
  return '/usr/bin/ssh -oBatchMode=yes -oPermitLocalCommand=no -oProxyCommand=none';
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
    objectFormat: selected.sha.length === 64 ? 'sha256' : 'sha1',
  };
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

async function resolveGitCatalogSource(
  source: GitCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  return resolveGitCatalogSourceDirect(source, options);
}

/** @internal Provider bridge for the multi-source resolver. */
export const catalogGitProviderInternal = {
  resolve: resolveGitCatalogSource,
  gitEnvironment,
};

async function resolveGitCatalogSourceDirect(
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
  const refreshRoot = path.join(location.rootDir, `.refresh-${crypto.randomUUID()}.tmp`);
  const objectsDir = path.join(refreshRoot, 'objects.git');
  const stagingRoot = path.join(refreshRoot, 'snapshot');
  try {
    await ensureCatalogSourceCacheLocation(location);
    await assertGitUrlIdentity({
      configuredTransport: source.url,
      configuredIdentityUrl,
      env,
      deadline,
    });
    const target = await resolveFetchTarget({
      transport: source.url,
      requestedRef,
      env,
      deadline,
    });
    await fs.mkdir(refreshRoot);
    await runGit({
      args: ['-c', 'init.defaultRefFormat=files', 'init', '--bare', `--object-format=${target.objectFormat}`, objectsDir],
      env,
      deadline,
    });
    await assertGitUrlIdentity({
      gitDir: objectsDir,
      configuredTransport: source.url,
      configuredIdentityUrl,
      env,
      deadline,
    });
    const commit = await fetchCommit({
      objectsDir,
      transport: source.url,
      fetchSpec: target.fetchSpec,
      env,
      deadline,
    });
    await materializeCommit({
      objectsDir,
      commit,
      subdir: source.subdir,
      destination: stagingRoot,
      env,
      deadline,
    });
    const validation = await validateCatalogSnapshotTransport(stagingRoot);
    throwIfAborted(deadline.signal);
    const requiredCapabilities = validation.manifest.requires.aw.capabilities ?? [];
    const support = checkAwCapabilitySupport(requiredCapabilities, IMPLEMENTED_AW_CAPABILITIES);
    if (!support.supported) {
      throw new CatalogProviderCompatibilityError({
        sourceId: source.id,
        requiredCapabilities,
        missingCapabilities: support.missing,
        availableCapabilities: IMPLEMENTED_AW_CAPABILITIES,
      });
    }
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      cliVersion: options.cliVersion,
      resolvedCommit: commit,
      snapshotRoot: stagingRoot,
      validation,
      signal: deadline.signal,
    });
    return fromCacheEntry(entry, 'remote', false);
  } catch (error) {
    const failure: unknown = deadline.signal?.aborted && deadline.signal.reason instanceof Error
      ? deadline.signal.reason
      : error;
    if (failure instanceof CatalogProviderCompatibilityError) throw failure;
    const sensitiveTransports = [
      source.url,
      ...(failure instanceof CatalogGitPolicyError ? failure.sensitiveTransports : []),
    ];
    throw createPublicGitError(source.id, failure, sensitiveTransports);
  } finally {
    deadline.dispose();
    await fs.remove(refreshRoot).catch(() => undefined);
  }
}
