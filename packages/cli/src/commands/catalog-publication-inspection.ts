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
  env: NodeJS.ProcessEnv;
}

function digest(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function sanitizedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('GIT_') || INHERITED_GIT_AUTH_ENV.has(key)));
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
  branch?: string;
  env: NodeJS.ProcessEnv;
  failOnUnavailable?: boolean;
  migrateLegacyAttempt?: (workspaceRoot: string, catalogVersion: string) => Promise<void>;
}): Promise<CatalogPublicationPreparation> {
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'catalog';
  const env = sanitizedGitEnvironment(options.env);
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
    const legacyAttemptPath = path.join(catalogWorkspaceRoot, '.aw', 'publish', 'attempted.json');
    if (await fs.pathExists(legacyAttemptPath)) {
      await options.migrateLegacyAttempt?.(catalogWorkspaceRoot, catalogVersion);
    }
    const attemptAvailable = !(await fs.pathExists(attemptPath)) && !(await fs.pathExists(legacyAttemptPath));
    if (!attemptAvailable && options.failOnUnavailable) {
      throw new CatalogPublicationInspectionError(
        'attemptUnavailable',
        `Catalog ${catalogVersion} already has an attempted publication record. Run aw catalog version <higher> before publishing again.`,
      );
    }
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
    if (!tagAvailable) {
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
        'fetch', '--quiet', '--no-tags', 'publish', `${branchRef}:refs/remotes/publish/catalog`,
      ], env, 'remoteBranchInvalid', 'Could not fetch the published Catalog branch.');
      previousSnapshotRoot = path.join(temporaryRoot, 'previous');
      await fs.ensureDir(previousSnapshotRoot);
      await publicationGit(repositoryRoot, [
        '--work-tree', previousSnapshotRoot, 'checkout', '--quiet', 'refs/remotes/publish/catalog', '--', '.',
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

export async function disposeCatalogPublicationInspection(
  preparation: Pick<CatalogPublicationPreparation, 'temporaryRoot'>,
): Promise<void> {
  await fs.remove(preparation.temporaryRoot);
}
