import { realpath } from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import {
  CATALOG_MANIFEST_FILENAME,
  GENERATED_OUTPUT_MARKER_FILENAME,
  preparePublishedCatalogWorkspace,
  readCatalogWorkspaceMarker,
  readCatalogWorkspace,
  validatePublishedCatalogSnapshot,
  validatePublishedCatalogSnapshotMetadata,
  type CatalogManifestV7Entry,
  type CatalogWorkspace,
  type CatalogWorkspaceBuildAdapter,
} from '@lesliechan721/aw-plugin-core';

import { bundleLocalPlugin, createCatalogRuntimeImportResolver } from '../../scripts/plugin-staging.js';
import { redactString } from '../output/redact.js';
import { sanitizeCatalogSourceErrorMessage } from '../utils/catalog-public-error.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import type { CatalogPublicationDescriptor } from './catalog-publication-journal.js';

export type { CatalogPublicationDescriptor } from './catalog-publication-journal.js';

const execFileAsync = promisify(execFile);
const INHERITED_GIT_AUTH_ENV = new Set([
  'GIT_ASKPASS',
  'GIT_HTTP_USER_AGENT',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_SSL_CAINFO',
  'GIT_SSL_NO_VERIFY',
  'GIT_TERMINAL_PROMPT',
]);

export interface CatalogPublicationIssue {
  code: string;
  message: string;
  blocking: boolean;
}

export class CatalogPublicationInspectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CatalogPublicationInspectionError';
    this.code = code;
  }
}

export interface CatalogPublicationPreparation {
  temporaryRoot: string;
  repositoryRoot: string;
  archivedCatalogWorkspaceRoot: string;
  catalogWorkspaceRoot: string;
  repoRoot: string;
  sourceHead: string;
  remote: string;
  branch: string;
  branchRef: string;
  tag: string;
  tagRef: string;
  fetchUrl: string;
  pushUrl: string;
  safeFetchUrl: string;
  safePushUrl: string;
  remoteIdentityDigest: string;
  parent: string | null;
  tagAvailable: boolean;
  catalogWorkspace: CatalogWorkspace;
  prepared: {
    outputRoot: string;
    catalogVersion: string;
    channel: 'latest' | 'beta';
    pluginNames: string[];
    snapshotDigest: string;
  };
  descriptor: CatalogPublicationDescriptor;
  env: NodeJS.ProcessEnv;
}

function digest(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function sanitizedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('GIT_') || INHERITED_GIT_AUTH_ENV.has(key)));
}

function directRemoteGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...sanitizedGitEnvironment(source),
    GIT_CONFIG_NOSYSTEM: '1',
    // Git for Windows maps /dev/null itself; Node's device path is not a Git path.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function safeRemoteIdentity(value: string): string {
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // Fall through to conservative display sanitization for malformed URLs.
    }
  }
  const withoutQuery = value.split(/[?#]/u, 1)[0]!;
  return withoutQuery
    .replace(/^([^/@\s:]+):([^/@\s]+)@/u, '')
    .replace(/^[^@\s]+@(?=[^:/\s]+[/:])/u, '');
}

export interface CatalogPublicationFailure {
  ok: false;
  code: string;
  message: string;
}

function sanitizeCatalogPublicationMessage(
  message: string,
  env?: NodeJS.ProcessEnv,
  sensitiveRoots?: readonly string[],
  sensitiveValues: readonly string[] = [],
): string {
  const normalized = redactString(message.replace(/[\p{Cc}\p{Cf}]+/gu, ' '));
  const withoutSensitiveValues = [...sensitiveValues]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length)
    .reduce((output, value) => output.replaceAll(value, '[remote]'), normalized);
  const withoutRemotes = withoutSensitiveValues
    .replace(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/giu, '[remote]')
    .replace(/[^\s"'<>@]+@[^\s"'<>:/]+[:/][^\s"'<>]+/gu, '[remote]');
  const withoutKnownRoots = sanitizeCatalogSourceErrorMessage(
    withoutRemotes,
    env,
    sensitiveRoots,
  );
  return redactString(withoutKnownRoots).replace(
    /(?<![A-Za-z0-9._-])(?:[A-Za-z]:[\\/]|\/)(?:[^\s"'<>:]+[\\/])*[^\s"'<>:]*/gu,
    '[private-path]',
  );
}

function remoteSensitiveValues(value: string): string[] {
  const values = new Set([value]);
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      for (const part of [url.username, url.password, url.hostname, url.pathname, url.pathname.slice(1)]) {
        if (part.length >= 4) values.add(part);
      }
    } catch {
      // The remote value is validated separately.
    }
  } else {
    const match = /^(?:([^@:/]+)@)?([^:/]+)[:/](.+)$/u.exec(value);
    for (const part of match?.slice(1) ?? []) {
      if (part && part.length >= 4) values.add(part);
    }
  }
  return [...values];
}

export function catalogPublicationFailure(options: {
  error: unknown;
  env?: NodeJS.ProcessEnv;
  sensitiveRoots?: readonly string[];
}): CatalogPublicationFailure {
  const original = options.error instanceof Error
    ? options.error.message
    : String(options.error);
  const message = sanitizeCatalogPublicationMessage(
    original,
    options.env,
    options.sensitiveRoots,
  );
  return {
    ok: false,
    code: options.error instanceof CatalogPublicationInspectionError
      ? options.error.code
      : 'catalogPublicationFailed',
    message,
  };
}

function assertSafeRemoteUrl(value: string, options: { allowCredentials?: boolean } = {}): string {
  if (value.trim() === '' || value !== value.trim() || /[\s\p{Cc}]/u.test(value) || value.startsWith('-')) {
    throw new CatalogPublicationInspectionError('remoteInvalid', 'Catalog remote URL is unsafe.');
  }
  if (!options.allowCredentials && /^[a-z][a-z\d+.-]*:\/\/[^/\s?#]*@/iu.test(value)) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog remote URL must not contain embedded credentials.',
    );
  }
  return value;
}

function assertSafeRemoteName(value: string): string {
  if (value === '' || value !== value.trim() || value.startsWith('-') || /[\s\p{Cc}]/u.test(value)) {
    throw new CatalogPublicationInspectionError('remoteInvalid', 'Catalog remote name is unsafe.');
  }
  return value;
}

function assertSafeBranchValue(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)) {
    throw new CatalogPublicationInspectionError('branchInvalid', 'Invalid Catalog publication branch name.');
  }
  return value;
}

export async function publicationGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  code: string,
  label: string,
  sensitiveValues: readonly string[] = [],
): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown; stderr?: unknown };
    const status = typeof failure.code === 'number' && Number.isSafeInteger(failure.code)
      ? `exited with code ${failure.code}`
      : typeof failure.code === 'string' && /^[A-Z0-9_]+$/u.test(failure.code)
        ? `failed with code ${failure.code}`
        : 'failed';
    const rawDetails = typeof failure.stderr === 'string' && failure.stderr.trim() !== ''
      ? failure.stderr
      : typeof failure.message === 'string'
        ? failure.message
        : '';
    const details = sanitizeCatalogPublicationMessage(rawDetails, env, [cwd], sensitiveValues)
      .replace(/\s+/gu, ' ')
      .trim();
    throw new CatalogPublicationInspectionError(
      code,
      `${label} Git ${status}${details ? `: ${details.slice(0, 2_000)}` : '.'}`,
      { cause: error },
    );
  }
}

export async function publicationGitExit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

export function parseRemoteRefs(output: string): Map<string, string> {
  return new Map(output.split('\n').filter(Boolean).map((line) => {
    const [objectId, ref] = line.split(/\s+/u);
    return [ref!, objectId!];
  }));
}

export async function materializeSourceHead(options: {
  repoRoot: string;
  sourceHead: string;
  outputRoot: string;
  temporaryRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const archivePath = path.join(options.temporaryRoot, 'source-head.tar');
  await fs.ensureDir(options.outputRoot);
  await publicationGit(options.repoRoot, [
    'archive', '--format=tar', `--output=${archivePath}`, options.sourceHead,
  ], options.env, 'sourceArchiveFailed', 'Could not archive the committed source HEAD.');
  const tarEnv = { ...options.env };
  delete tarEnv.TAR_OPTIONS;
  try {
    await execFileAsync('tar', [
      '-xf', path.relative(options.temporaryRoot, archivePath),
      '-C', path.relative(options.temporaryRoot, options.outputRoot),
    ], {
      cwd: options.temporaryRoot,
      env: tarEnv,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new CatalogPublicationInspectionError(
      'sourceArchiveFailed',
      'Could not materialize the committed source HEAD.',
      { cause: error },
    );
  } finally {
    await fs.remove(archivePath);
  }
}

export async function validateCatalogPublicationPlugins(
  catalogWorkspace: CatalogWorkspace,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const validator = path.join(resolveCliPackageRoot(), 'dist', 'authoring', 'scripts', 'validate-plugin.mjs');
  for (const plugin of catalogWorkspace.plugins) {
    try {
      await execFileAsync(process.execPath, [
        validator,
        plugin.rootDir,
        '--workspace-root', catalogWorkspace.workspaceRoot,
        '--json',
      ], {
        cwd: catalogWorkspace.workspaceRoot,
        env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      let details = '';
      if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
        try {
          const result = JSON.parse(error.stdout) as { errors?: Array<{ message?: unknown }> };
          details = (result.errors ?? [])
            .map((entry) => typeof entry.message === 'string' ? entry.message : '')
            .filter(Boolean)
            .join('; ');
        } catch {
          // Keep the public validator failure bounded to its plugin identity.
        }
      }
      throw new CatalogPublicationInspectionError(
        'pluginValidationFailed',
        `Plugin ${plugin.manifest.name} failed public source validation before Catalog publication${details ? `: ${details}` : '.'}`,
      );
    }
  }
}

const publicationBuildAdapter: CatalogWorkspaceBuildAdapter = {
  async build(options) {
    await bundleLocalPlugin(options.plugin, options.outputRoot, {
      buildMode: 'staging',
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
  },
};

function inspectionError(code: string, error: unknown): CatalogPublicationInspectionError {
  if (error instanceof CatalogPublicationInspectionError) return error;
  return new CatalogPublicationInspectionError(code, error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

async function validatePublishedCatalogSnapshotForWorkspace(
  snapshotRoot: string,
  workspaceIdentity: string,
): Promise<Awaited<ReturnType<typeof validatePublishedCatalogSnapshot>>> {
  try {
    const validation = await validatePublishedCatalogSnapshot(snapshotRoot);
    const markerPath = path.join(snapshotRoot, GENERATED_OUTPUT_MARKER_FILENAME);
    const markerStats = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!markerStats?.isFile() || markerStats.isSymbolicLink()) {
      throw new Error('Published Catalog snapshot marker must be a regular local file.');
    }
    const marker = await fs.readJson(markerPath) as Record<string, unknown>;
    if (marker.workspaceIdentity !== workspaceIdentity) {
      throw new Error('Published Catalog snapshot belongs to a different Workspace identity.');
    }
    return validation;
  } catch (error) {
    throw inspectionError('remoteSnapshotInvalid', error);
  }
}

async function materializePublishedCatalogMetadata(options: {
  repositoryRoot: string;
  commit: string;
  outputRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await fs.remove(options.outputRoot);
  await fs.ensureDir(options.outputRoot);
  for (const relative of [GENERATED_OUTPUT_MARKER_FILENAME, CATALOG_MANIFEST_FILENAME]) {
    const record = await publicationGit(options.repositoryRoot, [
      'ls-tree', options.commit, '--', relative,
    ], options.env, 'remoteBranchInvalid', 'Could not inspect published Catalog history.');
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/u.exec(record);
    if (!match || match[3] !== relative) {
      throw new CatalogPublicationInspectionError(
        'remoteSnapshotInvalid',
        'Published Catalog history metadata must contain regular files.',
      );
    }
    const content = await publicationGit(options.repositoryRoot, [
      'cat-file', 'blob', match[2]!,
    ], options.env, 'remoteBranchInvalid', 'Could not read published Catalog history.');
    await fs.writeFile(path.join(options.outputRoot, relative), `${content}\n`);
  }
}

async function findPreviousPluginEntriesInFirstParentHistory(options: {
  repositoryRoot: string;
  tipCommit: string;
  pluginNames: readonly string[];
  workspaceIdentity: string;
  temporaryRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogManifestV7Entry[]> {
  const missing = new Set(options.pluginNames);
  const found = new Map<string, CatalogManifestV7Entry>();
  const historyRoot = path.join(options.temporaryRoot, 'history-metadata');
  let commit = options.tipCommit;
  while (missing.size > 0) {
    const parents = (await publicationGit(options.repositoryRoot, [
      'show', '-s', '--format=%P', commit,
    ], options.env, 'remoteBranchInvalid', 'Could not inspect published Catalog history.'))
      .split(/\s+/u)
      .filter(Boolean);
    const firstParent = parents[0];
    if (!firstParent) break;
    commit = firstParent;
    await materializePublishedCatalogMetadata({
      repositoryRoot: options.repositoryRoot,
      commit,
      outputRoot: historyRoot,
      env: options.env,
    });
    let metadata: Awaited<ReturnType<typeof validatePublishedCatalogSnapshotMetadata>>;
    try {
      metadata = await validatePublishedCatalogSnapshotMetadata(historyRoot);
      if (metadata.workspaceIdentity !== options.workspaceIdentity) {
        throw new Error('Published Catalog snapshot belongs to a different Workspace identity.');
      }
    } catch (error) {
      throw inspectionError('remoteSnapshotInvalid', error);
    }
    for (const entry of metadata.manifest.entries) {
      if (!missing.delete(entry.name)) continue;
      found.set(entry.name, entry);
    }
  }
  return options.pluginNames.flatMap((name) => {
    const entry = found.get(name);
    return entry ? [entry] : [];
  });
}

export async function prepareCatalogPublicationInspection(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch?: string;
  officialPluginHistory?: readonly CatalogManifestV7Entry[];
  sourcePluginVersionsAtBaseline?: Readonly<Record<string, string>>;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogPublicationPreparation> {
  if (options.remote !== undefined && options.remoteUrl !== undefined) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog publication accepts a configured remote name or a direct remote URL, not both.',
    );
  }
  const remote = options.remoteUrl === undefined
    ? assertSafeRemoteName(options.remote ?? 'origin')
    : 'direct';
  const branch = assertSafeBranchValue(options.branch ?? 'catalog');
  const env = options.remoteUrl === undefined
    ? sanitizedGitEnvironment(options.env)
    : directRemoteGitEnvironment(options.env);
  let temporaryRoot = '';
  let fetchUrl = '';
  let pushUrl = '';
  let safeFetchUrl = '';
  let safePushUrl = '';
  try {
    const catalogWorkspaceRoot = await realpath(path.resolve(options.workspaceRoot));
    const repoRoot = await realpath(await publicationGit(
      catalogWorkspaceRoot,
      ['rev-parse', '--show-toplevel'],
      env,
      'gitWorkspaceInvalid',
      'Catalog Workspace must be inside a real Git worktree.',
    ));
    await publicationGit(
      repoRoot,
      ['check-ref-format', '--branch', branch],
      env,
      'branchInvalid',
      'Invalid Catalog publication branch name.',
    );
    if (options.remoteUrl !== undefined) {
      fetchUrl = assertSafeRemoteUrl(options.remoteUrl);
      pushUrl = fetchUrl;
    } else {
      const configuredRemotes = (await publicationGit(
        repoRoot,
        ['remote'],
        env,
        'remoteMissing',
        'Could not inspect configured Git remotes.',
      )).split('\n').filter(Boolean);
      if (!configuredRemotes.includes(remote)) {
        throw new CatalogPublicationInspectionError(
          'remoteInvalid',
          `Git remote ${JSON.stringify(remote)} is not configured.`,
        );
      }
      fetchUrl = assertSafeRemoteUrl(await publicationGit(
        repoRoot,
        ['remote', 'get-url', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} is not configured.`,
      ), { allowCredentials: true });
      pushUrl = assertSafeRemoteUrl(await publicationGit(
        repoRoot,
        ['remote', 'get-url', '--push', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} has no push URL.`,
      ), { allowCredentials: true });
    }
    safeFetchUrl = safeRemoteIdentity(fetchUrl);
    safePushUrl = safeRemoteIdentity(pushUrl);
    const sourceHead = await publicationGit(
      repoRoot,
      ['rev-parse', '--verify', 'HEAD'],
      env,
      'sourceHeadMissing',
      'Catalog Workspace Git HEAD must be committed and not unborn.',
    );
    const status = await publicationGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
    ], env, 'sourceStatusFailed', 'Could not inspect the source worktree.');
    if (status !== '') {
      throw new CatalogPublicationInspectionError(
        'sourceDirty',
        'Catalog publish requires the complete source Git worktree to be clean.',
      );
    }
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-catalog-'));
    const sourceRoot = path.join(temporaryRoot, 'source');
    await materializeSourceHead({ repoRoot, sourceHead, outputRoot: sourceRoot, temporaryRoot, env });
    const catalogWorkspaceRelative = path.relative(repoRoot, catalogWorkspaceRoot);
    if (
      catalogWorkspaceRelative === '..'
      || catalogWorkspaceRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(catalogWorkspaceRelative)
    ) {
      throw new CatalogPublicationInspectionError(
        'workspaceOutsideRepository',
        'Catalog Workspace must stay inside its Git worktree root.',
      );
    }
    const archivedCatalogWorkspaceRoot = path.join(sourceRoot, catalogWorkspaceRelative);
    let catalogWorkspace: CatalogWorkspace;
    try {
      catalogWorkspace = await readCatalogWorkspace(archivedCatalogWorkspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    } catch (error) {
      throw inspectionError('workspaceInvalid', error);
    }
    const ownerUrl = catalogWorkspace.metadata.owner.url;
    if (URL.canParse(ownerUrl) && new URL(ownerUrl).hostname === 'example.invalid') {
      throw new CatalogPublicationInspectionError(
        'catalogMetadataIncomplete',
        'Catalog owner URL still uses the example.invalid placeholder. Set plugins/marketplace-source.json owner.url before publication.',
      );
    }
    await validateCatalogPublicationPlugins(catalogWorkspace, env);
    const catalogVersion = catalogWorkspace.metadata.catalog.version;
    const tag = `catalog-v${catalogVersion}`;
    await publicationGit(
      repoRoot,
      ['check-ref-format', `refs/tags/${tag}`],
      env,
      'tagInvalid',
      'Invalid Catalog publication tag.',
    );
    const remoteIdentityDigest = digest(JSON.stringify({ fetchUrl, pushUrl }));
    const branchRef = `refs/heads/${branch}`;
    const tagRef = `refs/tags/${tag}`;
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    await fs.ensureDir(repositoryRoot);
    await publicationGit(repositoryRoot, ['init', '--quiet'], env, 'temporaryRepositoryFailed', 'Could not create the isolated publication repository.');
    await publicationGit(repositoryRoot, ['config', 'core.hooksPath', '/dev/null'], env, 'temporaryRepositoryFailed', 'Could not disable publication hooks.');
    await publicationGit(repositoryRoot, ['config', 'core.symlinks', 'true'], env, 'temporaryRepositoryFailed', 'Could not configure the isolated publication repository.');
    await publicationGit(repositoryRoot, ['remote', 'add', 'publish', pushUrl], env, 'temporaryRepositoryFailed', 'Could not configure the publication remote.');
    const initialRefs = parseRemoteRefs(await publicationGit(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'remoteReadFailed', 'Could not inspect the Catalog publication remote.'));
    const tagAvailable = !initialRefs.has(tagRef) && !initialRefs.has(`${tagRef}^{}`);
    const parent = initialRefs.get(branchRef) ?? null;
    let previousSnapshotRoot: string | undefined;
    let historicalPluginEntries: CatalogManifestV7Entry[] = [];
    if (parent) {
      await publicationGit(repositoryRoot, [
        'fetch', '--quiet', '--no-tags', 'publish', `${branchRef}:refs/aw/catalog-parent`,
      ], env, 'remoteBranchInvalid', 'Could not fetch the published Catalog branch.');
      previousSnapshotRoot = path.join(temporaryRoot, 'previous');
      await fs.ensureDir(previousSnapshotRoot);
      await publicationGit(repositoryRoot, [
        '--work-tree', previousSnapshotRoot, 'checkout', '--quiet', 'refs/aw/catalog-parent', '--', '.',
      ], env, 'remoteBranchInvalid', 'Could not read the published Catalog snapshot.');
      const previous = await validatePublishedCatalogSnapshotForWorkspace(
        previousSnapshotRoot,
        catalogWorkspace.workspaceIdentity,
      );
      const previousPluginNames = new Set(previous.manifest.entries.map((entry) => entry.name));
      const missingPluginNames = catalogWorkspace.plugins
        .map((plugin) => plugin.manifest.name)
        .filter((name) => !previousPluginNames.has(name));
      if (missingPluginNames.length > 0) {
        historicalPluginEntries = await findPreviousPluginEntriesInFirstParentHistory({
          repositoryRoot,
          tipCommit: parent,
          pluginNames: missingPluginNames,
          workspaceIdentity: catalogWorkspace.workspaceIdentity,
          temporaryRoot,
          env,
        });
      }
    }
    let prepared: CatalogPublicationPreparation['prepared'];
    try {
      prepared = await preparePublishedCatalogWorkspace({
        workspaceRoot: archivedCatalogWorkspaceRoot,
        sourceHead,
        previousSnapshotRoot,
        historicalPluginEntries,
        officialPluginHistory: options.officialPluginHistory,
        sourcePluginVersionsAtBaseline: options.sourcePluginVersionsAtBaseline,
        adapter: publicationBuildAdapter,
        reservedImports: CLI_RESERVED_IMPORTS,
      });
    } catch (error) {
      throw inspectionError('catalogPreparationFailed', error);
    }
    const preparedHead = await publicationGit(repoRoot, ['rev-parse', '--verify', 'HEAD'], env, 'sourceDrift', 'Could not recheck the source Git HEAD.');
    const preparedStatus = await publicationGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
    ], env, 'sourceDrift', 'Could not recheck the source worktree.');
    if (preparedHead !== sourceHead || preparedStatus !== '') {
      throw new CatalogPublicationInspectionError(
        'sourceDrift',
        'Source HEAD or worktree changed during Catalog preparation. Commit or clean it before publishing.',
      );
    }
    const finalRefs = parseRemoteRefs(await publicationGit(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'remoteDrift', 'Could not recheck the Catalog publication remote.'));
    if (
      (finalRefs.get(branchRef) ?? null) !== parent
      || finalRefs.has(tagRef) !== initialRefs.has(tagRef)
      || finalRefs.has(`${tagRef}^{}`) !== initialRefs.has(`${tagRef}^{}`)
    ) {
      throw new CatalogPublicationInspectionError(
        'remoteDrift',
        'Catalog remote changed during preparation. Increase the Catalog version before publishing again.',
      );
    }
    await validatePublishedCatalogSnapshot(prepared.outputRoot);
    const descriptor: CatalogPublicationDescriptor = {
      schemaVersion: 1,
      workspaceIdentity: catalogWorkspace.workspaceIdentity,
      sourceHead,
      remote: {
        name: options.remoteUrl === undefined ? remote : null,
        identityDigest: remoteIdentityDigest,
      },
      branch,
      parent,
      tag,
      snapshotDigest: prepared.snapshotDigest,
    };
    return {
      temporaryRoot,
      repositoryRoot,
      archivedCatalogWorkspaceRoot,
      catalogWorkspaceRoot,
      repoRoot,
      sourceHead,
      remote,
      branch,
      branchRef,
      tag,
      tagRef,
      fetchUrl,
      pushUrl,
      safeFetchUrl,
      safePushUrl,
      remoteIdentityDigest,
      parent,
      tagAvailable,
      catalogWorkspace,
      prepared,
      descriptor,
      env,
    };
  } catch (error) {
    if (temporaryRoot) await fs.remove(temporaryRoot);
    let safeMessage = error instanceof Error ? error.message : String(error);
    if (temporaryRoot) safeMessage = safeMessage.replaceAll(temporaryRoot, '<temporary Catalog state>');
    if (fetchUrl) safeMessage = safeMessage.replaceAll(fetchUrl, safeFetchUrl);
    if (pushUrl) safeMessage = safeMessage.replaceAll(pushUrl, safePushUrl);
    if (error instanceof CatalogPublicationInspectionError) {
      throw new CatalogPublicationInspectionError(error.code, safeMessage, { cause: error.cause });
    }
    throw new CatalogPublicationInspectionError('catalogPreflightFailed', safeMessage, { cause: error });
  }
}

export interface CatalogPublicationLiveContext {
  catalogWorkspaceRoot: string;
  repoRoot: string;
  workspaceIdentity: string;
  catalogVersion: string;
  sourceHead: string;
  remote: string;
  remoteName: string | null;
  branch: string;
  branchRef: string;
  tag: string;
  tagRef: string;
  fetchUrl: string;
  pushUrl: string;
  safeFetchUrl: string;
  safePushUrl: string;
  remoteIdentityDigest: string;
  env: NodeJS.ProcessEnv;
}

export interface CatalogPublicationApplyContext {
  catalogWorkspaceRoot: string;
  repoRoot: string;
  workspaceIdentity: string;
  remote: string;
  branch: string;
  branchRef: string;
  fetchUrl: string;
  pushUrl: string;
  safeFetchUrl: string;
  safePushUrl: string;
  remoteIdentityDigest: string;
  env: NodeJS.ProcessEnv;
}

export async function inspectCatalogPublicationLiveContext(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch?: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogPublicationLiveContext> {
  if (options.remote !== undefined && options.remoteUrl !== undefined) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog publication accepts a configured remote name or a direct remote URL, not both.',
    );
  }
  const remote = options.remoteUrl === undefined
    ? assertSafeRemoteName(options.remote ?? 'origin')
    : 'direct';
  const remoteName = options.remoteUrl === undefined ? remote : null;
  const branch = assertSafeBranchValue(options.branch ?? 'catalog');
  const env = options.remoteUrl === undefined
    ? sanitizedGitEnvironment(options.env)
    : directRemoteGitEnvironment(options.env);
  let fetchUrl = '';
  let pushUrl = '';
  let safeFetchUrl = '';
  let safePushUrl = '';
  try {
    const catalogWorkspaceRoot = await realpath(path.resolve(options.workspaceRoot));
    const repoRoot = await realpath(await publicationGit(
      catalogWorkspaceRoot,
      ['rev-parse', '--show-toplevel'],
      env,
      'gitWorkspaceInvalid',
      'Catalog Workspace must be inside a real Git worktree.',
    ));
    await publicationGit(
      repoRoot,
      ['check-ref-format', '--branch', branch],
      env,
      'branchInvalid',
      'Invalid Catalog publication branch name.',
    );
    const sourceHead = await publicationGit(
      repoRoot,
      ['rev-parse', '--verify', 'HEAD'],
      env,
      'sourceHeadMissing',
      'Catalog Workspace Git HEAD must be committed and not unborn.',
    );
    const status = await publicationGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
    ], env, 'sourceStatusFailed', 'Could not inspect the source worktree.');
    if (status !== '') {
      throw new CatalogPublicationInspectionError(
        'sourceDirty',
        'Catalog publish requires the complete source Git worktree to be clean.',
      );
    }
    const catalogWorkspaceRelative = path.relative(repoRoot, catalogWorkspaceRoot);
    if (
      catalogWorkspaceRelative === '..'
      || catalogWorkspaceRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(catalogWorkspaceRelative)
    ) {
      throw new CatalogPublicationInspectionError(
        'workspaceOutsideRepository',
        'Catalog Workspace must stay inside its Git worktree root.',
      );
    }
    const catalogWorkspace = await readCatalogWorkspace(catalogWorkspaceRoot, {
      reservedImports: CLI_RESERVED_IMPORTS,
    });
    const ownerUrl = catalogWorkspace.metadata.owner.url;
    if (URL.canParse(ownerUrl) && new URL(ownerUrl).hostname === 'example.invalid') {
      throw new CatalogPublicationInspectionError(
        'catalogMetadataIncomplete',
        'Catalog owner URL still uses the example.invalid placeholder. Set plugins/marketplace-source.json owner.url before publication.',
      );
    }
    if (options.remoteUrl !== undefined) {
      fetchUrl = assertSafeRemoteUrl(options.remoteUrl);
      pushUrl = fetchUrl;
    } else {
      const configuredRemotes = (await publicationGit(
        repoRoot,
        ['remote'],
        env,
        'remoteMissing',
        'Could not inspect configured Git remotes.',
      )).split('\n').filter(Boolean);
      if (!configuredRemotes.includes(remote)) {
        throw new CatalogPublicationInspectionError(
          'remoteInvalid',
          `Git remote ${JSON.stringify(remote)} is not configured.`,
        );
      }
      fetchUrl = assertSafeRemoteUrl(await publicationGit(
        repoRoot,
        ['remote', 'get-url', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} is not configured.`,
      ), { allowCredentials: true });
      pushUrl = assertSafeRemoteUrl(await publicationGit(
        repoRoot,
        ['remote', 'get-url', '--push', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} has no push URL.`,
      ), { allowCredentials: true });
    }
    safeFetchUrl = safeRemoteIdentity(fetchUrl);
    safePushUrl = safeRemoteIdentity(pushUrl);
    const catalogVersion = catalogWorkspace.metadata.catalog.version;
    const tag = `catalog-v${catalogVersion}`;
    await publicationGit(
      repoRoot,
      ['check-ref-format', `refs/tags/${tag}`],
      env,
      'tagInvalid',
      'Invalid Catalog publication tag.',
    );
    return {
      catalogWorkspaceRoot,
      repoRoot,
      workspaceIdentity: catalogWorkspace.workspaceIdentity,
      catalogVersion,
      sourceHead,
      remote,
      remoteName,
      branch,
      branchRef: `refs/heads/${branch}`,
      tag,
      tagRef: `refs/tags/${tag}`,
      fetchUrl,
      pushUrl,
      safeFetchUrl,
      safePushUrl,
      remoteIdentityDigest: digest(JSON.stringify({ fetchUrl, pushUrl })),
      env,
    };
  } catch (error) {
    let safeMessage = error instanceof Error ? error.message : String(error);
    if (fetchUrl) safeMessage = safeMessage.replaceAll(fetchUrl, safeFetchUrl);
    if (pushUrl) safeMessage = safeMessage.replaceAll(pushUrl, safePushUrl);
    if (error instanceof CatalogPublicationInspectionError) {
      throw new CatalogPublicationInspectionError(error.code, safeMessage, { cause: error.cause });
    }
    throw new CatalogPublicationInspectionError('catalogInspectionFailed', safeMessage, { cause: error });
  }
}

export async function inspectCatalogPublicationApplyContext(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch?: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogPublicationApplyContext> {
  if (options.remote !== undefined && options.remoteUrl !== undefined) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog publication accepts a configured remote name or a direct remote URL, not both.',
    );
  }
  const remote = options.remoteUrl === undefined
    ? assertSafeRemoteName(options.remote ?? 'origin')
    : 'direct';
  const branch = assertSafeBranchValue(options.branch ?? 'catalog');
  const env = options.remoteUrl === undefined
    ? sanitizedGitEnvironment(options.env)
    : directRemoteGitEnvironment(options.env);
  let fetchUrl = '';
  let pushUrl = '';
  let safeFetchUrl = '';
  let safePushUrl = '';
  try {
    const catalogWorkspaceRoot = await realpath(path.resolve(options.workspaceRoot));
    const marker = await readCatalogWorkspaceMarker(catalogWorkspaceRoot);
    const repoRoot = await realpath(await publicationGit(
      catalogWorkspaceRoot,
      ['rev-parse', '--show-toplevel'],
      env,
      'gitWorkspaceInvalid',
      'Catalog Workspace must be inside a real Git worktree.',
    ));
    const catalogWorkspaceRelative = path.relative(repoRoot, catalogWorkspaceRoot);
    if (
      catalogWorkspaceRelative === '..'
      || catalogWorkspaceRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(catalogWorkspaceRelative)
    ) {
      throw new CatalogPublicationInspectionError(
        'workspaceOutsideRepository',
        'Catalog Workspace must stay inside its Git worktree root.',
      );
    }
    await publicationGit(
      repoRoot,
      ['check-ref-format', '--branch', branch],
      env,
      'branchInvalid',
      'Invalid Catalog publication branch name.',
    );
    if (options.remoteUrl !== undefined) {
      fetchUrl = assertSafeRemoteUrl(options.remoteUrl);
      pushUrl = fetchUrl;
    } else {
      const configuredRemotes = (await publicationGit(
        repoRoot,
        ['remote'],
        env,
        'remoteMissing',
        'Could not inspect configured Git remotes.',
      )).split('\n').filter(Boolean);
      if (!configuredRemotes.includes(remote)) {
        throw new CatalogPublicationInspectionError(
          'remoteInvalid',
          `Git remote ${JSON.stringify(remote)} is not configured.`,
        );
      }
      fetchUrl = assertSafeRemoteUrl(await publicationGit(
        repoRoot,
        ['remote', 'get-url', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} is not configured.`,
      ), { allowCredentials: true });
      pushUrl = assertSafeRemoteUrl(await publicationGit(
        repoRoot,
        ['remote', 'get-url', '--push', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} has no push URL.`,
      ), { allowCredentials: true });
    }
    safeFetchUrl = safeRemoteIdentity(fetchUrl);
    safePushUrl = safeRemoteIdentity(pushUrl);
    return {
      catalogWorkspaceRoot,
      repoRoot,
      workspaceIdentity: marker.workspaceIdentity,
      remote,
      branch,
      branchRef: `refs/heads/${branch}`,
      fetchUrl,
      pushUrl,
      safeFetchUrl,
      safePushUrl,
      remoteIdentityDigest: digest(JSON.stringify({ fetchUrl, pushUrl })),
      env,
    };
  } catch (error) {
    let safeMessage = error instanceof Error ? error.message : String(error);
    if (fetchUrl) safeMessage = safeMessage.replaceAll(fetchUrl, safeFetchUrl);
    if (pushUrl) safeMessage = safeMessage.replaceAll(pushUrl, safePushUrl);
    if (error instanceof CatalogPublicationInspectionError) {
      throw new CatalogPublicationInspectionError(error.code, safeMessage, { cause: error.cause });
    }
    throw new CatalogPublicationInspectionError('catalogInspectionFailed', safeMessage, { cause: error });
  }
}

async function resolveRemoteUrlForInspection(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ remoteUrl: string; env: NodeJS.ProcessEnv }> {
  if (options.remote !== undefined && options.remoteUrl !== undefined) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog publication accepts a configured remote name or a direct remote URL, not both.',
    );
  }
  const env = options.remoteUrl === undefined
    ? sanitizedGitEnvironment(options.env)
    : directRemoteGitEnvironment(options.env);
  if (options.remoteUrl !== undefined) {
    return { remoteUrl: assertSafeRemoteUrl(options.remoteUrl), env };
  }
  const remote = assertSafeRemoteName(options.remote ?? 'origin');
  return {
    remoteUrl: assertSafeRemoteUrl(await publicationGit(
      options.workspaceRoot,
      ['remote', 'get-url', '--push', remote],
      env,
      'remoteMissing',
      `Git remote ${JSON.stringify(remote)} has no push URL.`,
    ), { allowCredentials: true }),
    env,
  };
}

export async function listCatalogPublicationVersions(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const resolved = await resolveRemoteUrlForInspection(options);
  const sensitiveValues = remoteSensitiveValues(resolved.remoteUrl);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-remote-read-'));
  try {
    await publicationGit(temporaryRoot, ['init', '--quiet'], resolved.env, 'temporaryRepositoryFailed', 'Could not create the Catalog inspection repository.');
    await publicationGit(temporaryRoot, ['remote', 'add', 'publish', resolved.remoteUrl], resolved.env, 'temporaryRepositoryFailed', 'Could not configure the Catalog inspection remote.');
    const refs = parseRemoteRefs(await publicationGit(temporaryRoot, [
      'ls-remote', '--refs', 'publish', 'refs/tags/catalog-v*',
    ], resolved.env, 'remoteReadFailed', 'Could not inspect Catalog publication versions.', sensitiveValues));
    return [...refs.keys()]
      .filter((ref) => ref.startsWith('refs/tags/catalog-v'))
      .map((ref) => ref.slice('refs/tags/catalog-v'.length));
  } finally {
    await fs.remove(temporaryRoot);
  }
}

export async function readCatalogPublicationPluginHistory(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branches: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<CatalogManifestV7Entry[]> {
  const marker = await readCatalogWorkspaceMarker(options.workspaceRoot);
  const resolved = await resolveRemoteUrlForInspection(options);
  const branchRefs = [...new Set(options.branches.map((branch) =>
    `refs/heads/${assertSafeBranchValue(branch)}`))];
  if (branchRefs.length === 0) throw new Error('Catalog Plugin history requires at least one branch.');
  const sensitiveValues = remoteSensitiveValues(resolved.remoteUrl);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-plugin-history-'));
  try {
    await publicationGit(temporaryRoot, ['init', '--quiet'], resolved.env, 'temporaryRepositoryFailed', 'Could not create the Catalog history repository.');
    await publicationGit(temporaryRoot, ['remote', 'add', 'publish', resolved.remoteUrl], resolved.env, 'temporaryRepositoryFailed', 'Could not configure the Catalog history remote.');
    const refs = parseRemoteRefs(await publicationGit(temporaryRoot, [
      'ls-remote', 'publish', ...branchRefs,
    ], resolved.env, 'remoteReadFailed', 'Could not inspect published Catalog history.', sensitiveValues));
    const visited = new Set<string>();
    const entries: CatalogManifestV7Entry[] = [];
    const metadataRoot = path.join(temporaryRoot, 'history-metadata');
    for (const [index, branchRef] of branchRefs.entries()) {
      const tip = refs.get(branchRef);
      if (!tip) continue;
      const localRef = `refs/aw/catalog-history-${index}`;
      await publicationGit(temporaryRoot, [
        'fetch', '--quiet', '--no-tags', 'publish', `${branchRef}:${localRef}`,
      ], resolved.env, 'remoteBranchInvalid', 'Could not fetch published Catalog history.', sensitiveValues);
      const fetchedTip = await publicationGit(temporaryRoot, ['rev-parse', localRef], resolved.env, 'remoteBranchInvalid', 'Could not inspect published Catalog history.');
      if (fetchedTip !== tip) {
        throw new CatalogPublicationInspectionError('remoteDrift', 'Catalog history changed during inspection. Retry preparation.');
      }
      const commits = (await publicationGit(temporaryRoot, [
        'rev-list', '--first-parent', tip,
      ], resolved.env, 'remoteBranchInvalid', 'Could not inspect published Catalog history.')).split('\n').filter(Boolean);
      for (const commit of commits) {
        if (visited.has(commit)) continue;
        visited.add(commit);
        await materializePublishedCatalogMetadata({
          repositoryRoot: temporaryRoot,
          commit,
          outputRoot: metadataRoot,
          env: resolved.env,
        });
        try {
          const metadata = await validatePublishedCatalogSnapshotMetadata(metadataRoot);
          if (metadata.workspaceIdentity !== marker.workspaceIdentity) {
            throw new Error('Published Catalog snapshot belongs to a different Workspace identity.');
          }
          entries.push(...metadata.manifest.entries);
        } catch (error) {
          throw inspectionError('remoteSnapshotInvalid', error);
        }
      }
    }
    const finalRefs = parseRemoteRefs(await publicationGit(temporaryRoot, [
      'ls-remote', 'publish', ...branchRefs,
    ], resolved.env, 'remoteReadFailed', 'Could not recheck published Catalog history.', sensitiveValues));
    if (branchRefs.some((ref) => refs.get(ref) !== finalRefs.get(ref))) {
      throw new CatalogPublicationInspectionError('remoteDrift', 'Catalog history changed during inspection. Retry preparation.');
    }
    return entries;
  } finally {
    await fs.remove(temporaryRoot);
  }
}

export async function readCatalogPublicationBranchState(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  commit: string;
  version: string;
  manifest: Awaited<ReturnType<typeof validatePublishedCatalogSnapshot>>['manifest'];
  snapshotDigest: string;
} | null> {
  assertSafeBranchValue(options.branch);
  const marker = await readCatalogWorkspaceMarker(options.workspaceRoot);
  const resolved = await resolveRemoteUrlForInspection(options);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-remote-read-'));
  try {
    await publicationGit(options.workspaceRoot, [
      'check-ref-format', '--branch', options.branch,
    ], resolved.env, 'branchInvalid', 'Invalid Catalog publication branch name.');
    const branchRef = `refs/heads/${options.branch}`;
    await publicationGit(temporaryRoot, ['init', '--quiet'], resolved.env, 'temporaryRepositoryFailed', 'Could not create the Catalog inspection repository.');
    await publicationGit(temporaryRoot, ['config', 'core.symlinks', 'true'], resolved.env, 'temporaryRepositoryFailed', 'Could not configure the Catalog inspection repository.');
    await publicationGit(temporaryRoot, ['remote', 'add', 'publish', resolved.remoteUrl], resolved.env, 'temporaryRepositoryFailed', 'Could not configure the Catalog inspection remote.');
    const refs = parseRemoteRefs(await publicationGit(temporaryRoot, [
      'ls-remote', 'publish', branchRef,
    ], resolved.env, 'remoteReadFailed', 'Could not inspect the Catalog publication branch.'));
    const commit = refs.get(branchRef);
    if (!commit) return null;
    await publicationGit(temporaryRoot, [
      'fetch', '--quiet', '--no-tags', 'publish', `${branchRef}:refs/aw/catalog-parent`,
    ], resolved.env, 'remoteBranchInvalid', 'Could not fetch the published Catalog branch.');
    const snapshotRoot = path.join(temporaryRoot, 'snapshot');
    await fs.ensureDir(snapshotRoot);
    await publicationGit(temporaryRoot, [
      '--work-tree', snapshotRoot, 'checkout', '--quiet', 'refs/aw/catalog-parent', '--', '.',
    ], resolved.env, 'remoteBranchInvalid', 'Could not read the published Catalog snapshot.');
    const validation = await validatePublishedCatalogSnapshotForWorkspace(
      snapshotRoot,
      marker.workspaceIdentity,
    );
    return {
      commit,
      version: validation.manifest.catalogVersion,
      manifest: validation.manifest,
      snapshotDigest: validation.snapshotDigest,
    };
  } finally {
    await fs.remove(temporaryRoot);
  }
}

export async function disposeCatalogPublicationInspection(
  preparation: Pick<CatalogPublicationPreparation, 'temporaryRoot'>,
): Promise<void> {
  await fs.remove(preparation.temporaryRoot);
}
