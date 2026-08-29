import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import {
  preparePublishedCatalogWorkspace,
  readCatalogWorkspace,
  validatePublishedCatalogSnapshot,
  type CatalogWorkspace,
  type CatalogWorkspaceBuildAdapter,
} from '@lesliechan721/aw-plugin-core';

import { bundleLocalPlugin, createCatalogRuntimeImportResolver } from '../../scripts/plugin-staging.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';
import { resolveCliPackageRoot } from '../utils/paths.js';

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
  publishedVersion: string | null;
  attemptPath: string;
  attemptAvailable: boolean;
  tagAvailable: boolean;
  catalogWorkspace: CatalogWorkspace;
  prepared: {
    outputRoot: string;
    catalogVersion: string;
    channel: 'latest' | 'beta';
    pluginNames: string[];
    snapshotDigest: string;
    contentDigest: string;
    planId: string;
  };
  descriptor: CatalogPublicationDescriptor;
  env: NodeJS.ProcessEnv;
}

export interface CatalogPublicationDescriptor {
  schemaVersion: 1;
  workspaceIdentity: string;
  catalogVersion: string;
  channel: 'latest' | 'beta';
  sourceHead: string;
  remote: {
    name: string | null;
    identityDigest: string;
  };
  branch: string;
  parent: string | null;
  tag: string;
  snapshotDigest: string;
  contentDigest: string;
  planId: string;
  ledgerDigest: string;
  pluginNames: string[];
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
    GIT_CONFIG_GLOBAL: os.devNull,
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

function assertSafeRemoteUrl(value: string): string {
  if (value.trim() === '' || value !== value.trim() || /\s/u.test(value) || value.startsWith('-')) {
    throw new CatalogPublicationInspectionError('remoteInvalid', 'Catalog remote URL is unsafe.');
  }
  if (/^[a-z][a-z\d+.-]*:\/\/[^/\s?#]*@/iu.test(value)) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog remote URL must not contain embedded credentials.',
    );
  }
  return value;
}

export function catalogAttemptPath(catalogWorkspaceRoot: string, catalogVersion: string): string {
  return path.join(catalogWorkspaceRoot, '.aw', 'publish', 'attempts', `${catalogVersion}.json`);
}

export async function publicationGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  code: string,
  label: string,
): Promise<string> {
  try {
    const result = await execFileAsync('git', [...args], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new CatalogPublicationInspectionError(code, label, { cause: error });
  }
}

export async function publicationGitExit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd, env, encoding: 'utf8' });
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
    await execFileAsync('tar', ['-xf', archivePath, '-C', options.outputRoot], {
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

export async function prepareCatalogPublicationInspection(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch?: string;
  env: NodeJS.ProcessEnv;
  failOnUnavailable?: boolean;
}): Promise<CatalogPublicationPreparation> {
  if (options.remote !== undefined && options.remoteUrl !== undefined) {
    throw new CatalogPublicationInspectionError(
      'remoteInvalid',
      'Catalog publication accepts a configured remote name or a direct remote URL, not both.',
    );
  }
  const remote = options.remote ?? (options.remoteUrl === undefined ? 'origin' : 'direct');
  const branch = options.branch ?? 'catalog';
  const env = options.remoteUrl === undefined
    ? sanitizedGitEnvironment(options.env)
    : directRemoteGitEnvironment(options.env);
  let temporaryRoot = '';
  let fetchUrl = '';
  let pushUrl = '';
  let safeFetchUrl = '';
  let safePushUrl = '';
  try {
    const catalogWorkspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
    const repoRoot = await publicationGit(
      catalogWorkspaceRoot,
      ['rev-parse', '--show-toplevel'],
      env,
      'gitWorkspaceInvalid',
      'Catalog Workspace must be inside a real Git worktree.',
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
    await publicationGit(
      repoRoot,
      ['check-ref-format', '--branch', branch],
      env,
      'branchInvalid',
      'Invalid Catalog publication branch name.',
    );
    let catalogWorkspace: CatalogWorkspace;
    try {
      catalogWorkspace = await readCatalogWorkspace(archivedCatalogWorkspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    } catch (error) {
      throw inspectionError('workspaceInvalid', error);
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
    const attemptPath = catalogAttemptPath(catalogWorkspaceRoot, catalogVersion);
    const attemptAvailable = !(await fs.pathExists(attemptPath));
    if (!attemptAvailable && options.failOnUnavailable) {
      throw new CatalogPublicationInspectionError(
        'attemptUnavailable',
        `Catalog ${catalogVersion} already has an attempted publication record. Run aw catalog version <higher> before publishing again.`,
      );
    }
    if (options.remoteUrl !== undefined) {
      fetchUrl = assertSafeRemoteUrl(options.remoteUrl);
      pushUrl = fetchUrl;
    } else {
      fetchUrl = await publicationGit(
        repoRoot,
        ['remote', 'get-url', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} is not configured.`,
      );
      pushUrl = await publicationGit(
        repoRoot,
        ['remote', 'get-url', '--push', remote],
        env,
        'remoteMissing',
        `Git remote ${JSON.stringify(remote)} has no push URL.`,
      );
    }
    safeFetchUrl = safeRemoteIdentity(fetchUrl);
    safePushUrl = safeRemoteIdentity(pushUrl);
    const remoteIdentityDigest = digest(JSON.stringify({ fetchUrl, pushUrl }));
    const branchRef = `refs/heads/${branch}`;
    const tagRef = `refs/tags/${tag}`;
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    await fs.ensureDir(repositoryRoot);
    await publicationGit(repositoryRoot, ['init', '--quiet'], env, 'temporaryRepositoryFailed', 'Could not create the isolated publication repository.');
    await publicationGit(repositoryRoot, ['config', 'core.hooksPath', path.join(temporaryRoot, 'disabled-hooks')], env, 'temporaryRepositoryFailed', 'Could not disable publication hooks.');
    await publicationGit(repositoryRoot, ['config', 'core.symlinks', 'true'], env, 'temporaryRepositoryFailed', 'Could not configure the isolated publication repository.');
    await publicationGit(repositoryRoot, ['remote', 'add', 'publish', pushUrl], env, 'temporaryRepositoryFailed', 'Could not configure the publication remote.');
    const initialRefs = parseRemoteRefs(await publicationGit(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'remoteReadFailed', 'Could not inspect the Catalog publication remote.'));
    const tagAvailable = !initialRefs.has(tagRef) && !initialRefs.has(`${tagRef}^{}`);
    if (!tagAvailable && options.failOnUnavailable) {
      throw new CatalogPublicationInspectionError(
        'tagUnavailable',
        `Remote Catalog tag ${tag} already exists. Increase the Catalog version.`,
      );
    }
    const parent = initialRefs.get(branchRef) ?? null;
    let previousSnapshotRoot: string | undefined;
    let publishedVersion: string | null = null;
    if (parent) {
      await publicationGit(repositoryRoot, [
        'fetch', '--quiet', '--no-tags', 'publish', `${branchRef}:refs/aw/catalog-parent`,
      ], env, 'remoteBranchInvalid', 'Could not fetch the published Catalog branch.');
      previousSnapshotRoot = path.join(temporaryRoot, 'previous');
      await fs.ensureDir(previousSnapshotRoot);
      await publicationGit(repositoryRoot, [
        '--work-tree', previousSnapshotRoot, 'checkout', '--quiet', 'refs/aw/catalog-parent', '--', '.',
      ], env, 'remoteBranchInvalid', 'Could not read the published Catalog snapshot.');
      try {
        const previous = await validatePublishedCatalogSnapshot(previousSnapshotRoot);
        publishedVersion = previous.manifest.catalogVersion;
      } catch (error) {
        throw inspectionError('remoteSnapshotInvalid', error);
      }
    }
    let prepared: CatalogPublicationPreparation['prepared'];
    try {
      prepared = await preparePublishedCatalogWorkspace({
        workspaceRoot: archivedCatalogWorkspaceRoot,
        sourceHead,
        previousSnapshotRoot,
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
    const [, ledgerBytes] = await Promise.all([
      validatePublishedCatalogSnapshot(prepared.outputRoot),
      fs.readFile(path.join(prepared.outputRoot, 'plugin-release-ledger.json')),
    ]);
    const ledgerDigest = digest(ledgerBytes);
    const descriptor: CatalogPublicationDescriptor = {
      schemaVersion: 1,
      workspaceIdentity: catalogWorkspace.workspaceIdentity,
      catalogVersion: prepared.catalogVersion,
      channel: prepared.channel,
      sourceHead,
      remote: {
        name: options.remoteUrl === undefined ? remote : null,
        identityDigest: remoteIdentityDigest,
      },
      branch,
      parent,
      tag,
      snapshotDigest: prepared.snapshotDigest,
      contentDigest: prepared.contentDigest,
      planId: prepared.planId,
      ledgerDigest,
      pluginNames: [...prepared.pluginNames],
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
      publishedVersion,
      attemptPath,
      attemptAvailable,
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
  const remote = options.remote ?? 'origin';
  return {
    remoteUrl: await publicationGit(
      options.workspaceRoot,
      ['remote', 'get-url', '--push', remote],
      env,
      'remoteMissing',
      `Git remote ${JSON.stringify(remote)} has no push URL.`,
    ),
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
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-remote-read-'));
  try {
    await publicationGit(temporaryRoot, ['init', '--quiet'], resolved.env, 'temporaryRepositoryFailed', 'Could not create the Catalog inspection repository.');
    await publicationGit(temporaryRoot, ['remote', 'add', 'publish', resolved.remoteUrl], resolved.env, 'temporaryRepositoryFailed', 'Could not configure the Catalog inspection remote.');
    const refs = parseRemoteRefs(await publicationGit(temporaryRoot, [
      'ls-remote', '--refs', 'publish', 'refs/tags/catalog-v*',
    ], resolved.env, 'remoteReadFailed', 'Could not inspect Catalog publication versions.'));
    return [...refs.keys()]
      .filter((ref) => ref.startsWith('refs/tags/catalog-v'))
      .map((ref) => ref.slice('refs/tags/catalog-v'.length));
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
  ledger: Awaited<ReturnType<typeof validatePublishedCatalogSnapshot>>['ledger'];
  snapshotDigest: string;
} | null> {
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
    const validation = await validatePublishedCatalogSnapshot(snapshotRoot);
    return {
      commit,
      version: validation.manifest.catalogVersion,
      manifest: validation.manifest,
      ledger: validation.ledger,
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
