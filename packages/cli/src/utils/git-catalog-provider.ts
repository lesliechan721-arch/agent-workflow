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
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import { validateCatalogSnapshotTransport } from './catalog-snapshot.js';
import { resolveCatalogSourceRef } from './catalog-sources.js';
import { checkAwCapabilitySupport } from './manifest.js';
import { NativeCliError, runNativeCli } from './native-cli.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_REMOTE_TIMEOUT_MS = 180_000;

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

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output = { ...env };
  const removedKeys = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
    'GIT_TERMINAL_PROMPT',
    'GCM_INTERACTIVE',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'SSH_ASKPASS_REQUIRE',
  ]);
  for (const key of Object.keys(output)) {
    if (removedKeys.has(key.toUpperCase())) delete output[key];
  }
  output.GIT_TERMINAL_PROMPT = '0';
  output.GCM_INTERACTIVE = 'Never';
  return output;
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
  return new Error(message, { cause });
}

async function resolveEffectiveGitUrl(options: {
  gitDir?: string;
  configuredTransport: string;
  env: NodeJS.ProcessEnv;
  deadline: CatalogGitDeadline;
}): Promise<string> {
  let actualTransport: string;
  try {
    actualTransport = (await runGit({
      gitDir: options.gitDir,
      args: ['ls-remote', '--get-url', '--', options.configuredTransport],
      env: options.env,
      deadline: options.deadline,
    })).stdout.trim();
  } catch (error) {
    throw new CatalogGitPolicyError('Cannot verify the effective catalog Git URL.', error);
  }
  try {
    canonicalizeCatalogGitUrl(actualTransport);
  } catch (error) {
    throw new CatalogGitPolicyError(
      'Git URL rewrite selected a disallowed catalog transport.',
      error,
      [actualTransport],
    );
  }
  return actualTransport;
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
      if (error instanceof NativeCliError && error.cleanupError) {
        cleanupConfirmed = false;
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
    if (error instanceof NativeCliError && error.cleanupError) cleanupConfirmed = false;
    throw error;
  } finally {
    if (cleanupConfirmed && !options.deadline.signal?.aborted) {
      await runGit({
        gitDir: options.objectsDir,
        args: ['update-ref', '-d', temporaryRef],
        env: options.env,
        deadline: options.deadline,
      }).catch((error: unknown) => {
        if (error instanceof NativeCliError && error.cleanupError) throw error;
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
    if (error instanceof NativeCliError && error.cleanupError) {
      retainArchive = true;
    }
    throwIfAborted(options.deadline.signal);
    throw new CatalogGitPolicyError('Catalog Git commit materialization failed.', error);
  } finally {
    if (!retainArchive) await fs.remove(archivePath);
  }
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
  canonicalizeCatalogGitUrl(source.url);
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const requestedRef = resolveCatalogSourceRef(source.refPolicy, options.cliVersion);
  const deadline = createDeadlineSignal(options.signal, readRemoteTimeout(env));
  const temporaryRoot = path.join(
    canonicalizePathThroughExistingAncestorSync(resolveAwHome(env)),
    'tmp',
  );
  await ensureRegularDirectoryPath(temporaryRoot, 'Catalog provider temporary directory');
  const refreshRoot = await fs.mkdtemp(path.join(temporaryRoot, 'catalog-git-'));
  const objectsDir = path.join(refreshRoot, 'objects.git');
  const stagingRoot = path.join(refreshRoot, 'snapshot');
  let returned = false;
  let effectiveTransport: string | undefined;
  try {
    effectiveTransport = await resolveEffectiveGitUrl({
      configuredTransport: source.url,
      env,
      deadline,
    });
    const target = await resolveFetchTarget({
      transport: source.url,
      requestedRef,
      env,
      deadline,
    });
    await runGit({
      args: ['-c', 'init.defaultRefFormat=files', 'init', '--bare', `--object-format=${target.objectFormat}`, objectsDir],
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
    returned = true;
    let cleaned = false;
    return {
      sourceId: source.id,
      sourceIdentity,
      requestedRef,
      resolvedCommit: commit,
      rootDir: stagingRoot,
      manifest: validation.manifest,
      manifestDigest: validation.manifestDigest,
      snapshotDigest: validation.snapshotDigest,
      transport: 'git',
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await fs.remove(refreshRoot);
      },
    };
  } catch (error) {
    const failure: unknown = deadline.signal?.aborted && deadline.signal.reason instanceof Error
      ? deadline.signal.reason
      : error;
    if (failure instanceof CatalogProviderCompatibilityError) throw failure;
    const sensitiveTransports = [
      source.url,
      effectiveTransport ?? '',
      ...(failure instanceof CatalogGitPolicyError ? failure.sensitiveTransports : []),
    ];
    throw createPublicGitError(source.id, failure, sensitiveTransports);
  } finally {
    deadline.dispose();
    if (!returned) await fs.remove(refreshRoot).catch(() => undefined);
  }
}
