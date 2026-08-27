import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import {
  assertStrictSemVer,
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
const LEGACY_ATTEMPTED_MARKER = path.join('.aw', 'publish', 'attempted.json');
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

export interface CatalogPublishIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CatalogPublishReceipt {
  command: 'catalog:publish';
  ok: true;
  catalogVersion: string;
  channel: 'latest' | 'beta';
  remote: string;
  remoteUrl: string;
  fetchUrl: string;
  pushUrl: string;
  branch: string;
  tag: string;
  commit: string;
  sourceHead: string;
  pluginCount: number;
  snapshotDigest: string;
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

function attemptPath(catalogWorkspaceRoot: string, catalogVersion: string): string {
  return path.join(catalogWorkspaceRoot, '.aw', 'publish', 'attempts', `${catalogVersion}.json`);
}

async function migrateLegacyAttempt(catalogWorkspaceRoot: string, catalogVersion: string): Promise<void> {
  const legacyPath = path.join(catalogWorkspaceRoot, LEGACY_ATTEMPTED_MARKER);
  if (!(await fs.pathExists(legacyPath))) return;
  let recordedVersion = catalogVersion;
  try {
    const legacy = await fs.readJson(legacyPath) as Record<string, unknown>;
    if (legacy.schemaVersion === 1 && typeof legacy.catalogVersion === 'string') {
      recordedVersion = assertStrictSemVer(legacy.catalogVersion, 'legacy attempted Catalog version');
    }
  } catch {
    // Bind an unreadable legacy marker to the current version. A later version uses a new file.
  }
  const destination = attemptPath(catalogWorkspaceRoot, recordedVersion);
  await fs.ensureDir(path.dirname(destination));
  if (await fs.pathExists(destination)) return;
  await fs.rename(legacyPath, destination);
}

async function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
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
    throw new Error(label, { cause: error });
  }
}

async function gitExit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd, env, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function parseRemoteRefs(output: string): Map<string, string> {
  return new Map(output.split('\n').filter(Boolean).map((line) => {
    const [objectId, ref] = line.split(/\s+/u);
    return [ref!, objectId!];
  }));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.remove(temporary);
    throw error;
  }
}

async function clearWorktree(repositoryRoot: string): Promise<void> {
  for (const name of await fs.readdir(repositoryRoot)) {
    if (name !== '.git') await fs.remove(path.join(repositoryRoot, name));
  }
}

async function materializeSourceHead(options: {
  repoRoot: string;
  sourceHead: string;
  outputRoot: string;
  temporaryRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const archivePath = path.join(options.temporaryRoot, 'source-head.tar');
  await fs.ensureDir(options.outputRoot);
  await git(options.repoRoot, [
    'archive', '--format=tar', `--output=${archivePath}`, options.sourceHead,
  ], options.env, 'Could not archive the committed source HEAD.');
  const tarEnv = { ...options.env };
  delete tarEnv.TAR_OPTIONS;
  try {
    await execFileAsync('tar', ['-xf', archivePath, '-C', options.outputRoot], {
      env: tarEnv,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error('Could not materialize the committed source HEAD.', { cause: error });
  } finally {
    await fs.remove(archivePath);
  }
}

async function validatePublishedCatalogWorkspace(
  catalogWorkspace: CatalogWorkspace,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const validator = path.join(
    resolveCliPackageRoot(),
    'dist',
    'authoring',
    'scripts',
    'validate-plugin.mjs',
  );
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
      throw new Error(
        `Plugin ${plugin.manifest.name} failed public source validation before Catalog publication${details ? `: ${details}` : '.'}`,
      );
    }
  }
}

const publishBuildAdapter: CatalogWorkspaceBuildAdapter = {
  async build(options) {
    await bundleLocalPlugin(options.plugin, options.outputRoot, {
      buildMode: 'staging',
      runtimeResolver: createCatalogRuntimeImportResolver(options.plugins),
    });
  },
};

export async function runCatalogPublishCommand(options: {
  workspaceRoot: string;
  remote?: string;
  branch?: string;
  yes?: boolean;
  json?: boolean;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  confirm?: (message: string) => Promise<boolean>;
  io: CatalogPublishIo;
}): Promise<CatalogPublishReceipt | null> {
  if (options.json && !options.yes) throw new Error('Catalog publish with --json requires --yes.');
  if (!options.interactive && !options.yes) throw new Error('Non-interactive Catalog publish requires --yes.');
  const remote = options.remote ?? 'origin';
  const branch = options.branch ?? 'catalog';
  const env = sanitizedGitEnvironment(options.env);
  const catalogWorkspaceRoot = await fs.realpath(path.resolve(options.workspaceRoot));
  const repoRoot = await git(catalogWorkspaceRoot, ['rev-parse', '--show-toplevel'], env, 'Catalog Workspace must be inside a real Git worktree.');
  const sourceHead = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], env, 'Catalog Workspace Git HEAD must be committed and not unborn.');
  const status = await git(repoRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
  ], env, 'Could not inspect the source worktree.');
  if (status !== '') throw new Error('Catalog publish requires the complete source Git worktree to be clean.');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-public-catalog-'));
  let fetchUrl = '';
  let pushUrl = '';
  let safeFetchUrl = '';
  let safePushUrl = '';
  try {
    const sourceRoot = path.join(temporaryRoot, 'source');
    await materializeSourceHead({ repoRoot, sourceHead, outputRoot: sourceRoot, temporaryRoot, env });
    const catalogWorkspaceRelative = path.relative(repoRoot, catalogWorkspaceRoot);
    if (catalogWorkspaceRelative === '..' || catalogWorkspaceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(catalogWorkspaceRelative)) {
      throw new Error('Catalog Workspace must stay inside its Git worktree root.');
    }
    const archivedCatalogWorkspaceRoot = path.join(sourceRoot, catalogWorkspaceRelative);
    await git(repoRoot, ['check-ref-format', '--branch', branch], env, 'Invalid Catalog publication branch name.');
    const catalogWorkspace = await readCatalogWorkspace(archivedCatalogWorkspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    await validatePublishedCatalogWorkspace(catalogWorkspace, env);
    const catalogVersion = catalogWorkspace.metadata.catalog.version;
    const tag = `catalog-v${catalogVersion}`;
    await git(repoRoot, ['check-ref-format', `refs/tags/${tag}`], env, 'Invalid Catalog publication tag.');
    const markerPath = attemptPath(catalogWorkspaceRoot, catalogVersion);
    if (!(await gitExit(repoRoot, ['check-ignore', '-q', markerPath], env))) {
      throw new Error('Catalog publish state under .aw/publish must be ignored by Git. Add .aw/ to .gitignore.');
    }
    await migrateLegacyAttempt(catalogWorkspaceRoot, catalogVersion);
    if (await fs.pathExists(markerPath)) {
      throw new Error(
        `Catalog ${catalogVersion} already has an attempted publication record. `
        + 'Run aw catalog version <higher> before publishing again.',
      );
    }
    fetchUrl = await git(repoRoot, ['remote', 'get-url', remote], env, `Git remote ${JSON.stringify(remote)} is not configured.`);
    pushUrl = await git(repoRoot, ['remote', 'get-url', '--push', remote], env, `Git remote ${JSON.stringify(remote)} has no push URL.`);
    safeFetchUrl = safeRemoteIdentity(fetchUrl);
    safePushUrl = safeRemoteIdentity(pushUrl);
    const remoteIdentityDigest = digest(JSON.stringify({ fetchUrl, pushUrl }));
    const branchRef = `refs/heads/${branch}`;
    const tagRef = `refs/tags/${tag}`;
    const repositoryRoot = path.join(temporaryRoot, 'repository');
    await fs.ensureDir(repositoryRoot);
    await git(repositoryRoot, ['init', '--quiet'], env, 'Could not create the isolated publication repository.');
    await git(repositoryRoot, ['config', 'core.hooksPath', path.join(temporaryRoot, 'disabled-hooks')], env, 'Could not disable publication hooks.');
    await git(repositoryRoot, ['config', 'core.symlinks', 'true'], env, 'Could not configure the isolated publication repository.');
    await git(repositoryRoot, ['remote', 'add', 'publish', pushUrl], env, 'Could not configure the publication remote.');
    const initialRefs = parseRemoteRefs(await git(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'Could not inspect the Catalog publication remote.'));
    if (initialRefs.has(tagRef) || initialRefs.has(`${tagRef}^{}`)) {
      throw new Error(`Remote Catalog tag ${tag} already exists. Increase the Catalog version.`);
    }
    const parent = initialRefs.get(branchRef) ?? null;
    let previousSnapshotRoot: string | undefined;
    if (parent) {
      await git(repositoryRoot, ['fetch', '--quiet', '--no-tags', 'publish', `${branchRef}:refs/remotes/publish/catalog`], env, 'Could not fetch the published Catalog branch.');
      previousSnapshotRoot = path.join(temporaryRoot, 'previous');
      await fs.ensureDir(previousSnapshotRoot);
      await git(repositoryRoot, ['--work-tree', previousSnapshotRoot, 'checkout', '--quiet', 'refs/remotes/publish/catalog', '--', '.'], env, 'Could not read the published Catalog snapshot.');
      await validatePublishedCatalogSnapshot(previousSnapshotRoot);
    }
    const prepared = await preparePublishedCatalogWorkspace({
      workspaceRoot: archivedCatalogWorkspaceRoot,
      sourceHead,
      previousSnapshotRoot,
      adapter: publishBuildAdapter,
      reservedImports: CLI_RESERVED_IMPORTS,
    });
    const preparedHead = await git(repoRoot, ['rev-parse', '--verify', 'HEAD'], env, 'Could not recheck the source Git HEAD.');
    const preparedStatus = await git(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
    ], env, 'Could not recheck the source worktree.');
    if (preparedHead !== sourceHead || preparedStatus !== '') {
      throw new Error('Source HEAD or worktree changed during Catalog preparation. Commit or clean it before publishing.');
    }
    if (!options.yes) {
      options.io.stderr([
        `Source HEAD: ${sourceHead}`,
        `Catalog: ${prepared.catalogVersion} (${prepared.channel})`,
        `Push remote: ${remote} (${safePushUrl})`,
        `Branch: ${branchRef}`,
        `Tag: ${tagRef}`,
        `Plugins: ${prepared.pluginNames.length}`,
        'One atomic push will publish the branch and annotated tag.',
      ].join('\n') + '\n');
      if (!options.confirm || !(await options.confirm('Publish this Catalog snapshot?'))) {
        options.io.stderr('Catalog publication cancelled.\n');
        return null;
      }
    }
    if (parent) await git(repositoryRoot, ['checkout', '--quiet', '--detach', 'refs/remotes/publish/catalog'], env, 'Could not select the publication parent.');
    else await git(repositoryRoot, ['checkout', '--quiet', '--orphan', 'catalog-publication'], env, 'Could not create the initial Catalog publication.');
    await clearWorktree(repositoryRoot);
    await fs.copy(prepared.outputRoot, repositoryRoot, { dereference: false });
    await git(repositoryRoot, ['add', '--force', '--all'], env, 'Could not stage the Catalog publication tree.');
    await git(repositoryRoot, [
      '-c', 'user.name=AW Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'commit', '--quiet', '-m', `Catalog ${catalogVersion}`,
    ], env, 'Could not create the Catalog publication commit.');
    const commit = await git(repositoryRoot, ['rev-parse', 'HEAD'], env, 'Could not resolve the Catalog publication commit.');
    const parents = (await git(repositoryRoot, ['show', '-s', '--format=%P', commit], env, 'Could not verify the Catalog publication parent.')).split(/\s+/u).filter(Boolean);
    if ((parent && (parents.length !== 1 || parents[0] !== parent)) || (!parent && parents.length !== 0)) {
      throw new Error('Catalog publication commit has an invalid parent.');
    }
    const verificationRoot = path.join(temporaryRoot, 'verification');
    await fs.ensureDir(verificationRoot);
    await git(repositoryRoot, ['--work-tree', verificationRoot, 'checkout', '--quiet', commit, '--', '.'], env, 'Could not verify the Catalog publication commit tree.');
    const committed = await validatePublishedCatalogSnapshot(verificationRoot);
    if (committed.snapshotDigest !== prepared.snapshotDigest) throw new Error('Catalog publication commit tree differs from the prepared snapshot.');
    await git(repositoryRoot, [
      '-c', 'user.name=AW Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'tag', '--annotate', tag, '--message', `Catalog ${catalogVersion}`,
    ], env, 'Could not create the annotated Catalog tag.');
    const attemptedAt = new Date().toISOString();
    const attempted = {
      schemaVersion: 1,
      state: 'attempted',
      workspaceIdentity: digest(JSON.stringify({
        repoRoot,
        workspaceRelative: path.relative(repoRoot, catalogWorkspaceRoot),
      })),
      catalogVersion,
      sourceHead,
      remote: { name: remote, identityDigest: remoteIdentityDigest },
      branch,
      tag,
      preparedSnapshotDigest: prepared.snapshotDigest,
      attemptedAt,
    };
    await writeJsonAtomic(markerPath, attempted);
    const liveRefs = parseRemoteRefs(await git(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'Could not recheck the Catalog publication remote.'));
    if ((liveRefs.get(branchRef) ?? null) !== parent || liveRefs.has(tagRef) || liveRefs.has(`${tagRef}^{}`)) {
      throw new Error('Catalog remote changed during preparation. Increase the Catalog version before publishing again.');
    }
    try {
      await git(repositoryRoot, [
        'push', '--atomic', 'publish', `${commit}:${branchRef}`, `${tagRef}:${tagRef}`,
      ], env, `Catalog atomic push failed or its result is uncertain. Do not retry ${catalogVersion}; increase the Catalog version.`);
    } catch {
      throw new Error(`Catalog atomic push failed or its result is uncertain. Do not retry ${catalogVersion}; run aw catalog version <higher>.`);
    }
    const publishedRefs = parseRemoteRefs(await git(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, `Catalog publication result is uncertain. Do not retry ${catalogVersion}; increase the Catalog version.`));
    if (publishedRefs.get(branchRef) !== commit || publishedRefs.get(`${tagRef}^{}`) !== commit) {
      throw new Error(`Catalog publication result is uncertain. Do not retry ${catalogVersion}; run aw catalog version <higher>.`);
    }
    await writeJsonAtomic(markerPath, { ...attempted, state: 'published', commit, publishedAt: new Date().toISOString() });
    return {
      command: 'catalog:publish',
      ok: true,
      catalogVersion,
      channel: prepared.channel,
      remote,
      remoteUrl: safeFetchUrl,
      fetchUrl: safeFetchUrl,
      pushUrl: safePushUrl,
      branch,
      tag,
      commit,
      sourceHead,
      pluginCount: prepared.pluginNames.length,
      snapshotDigest: prepared.snapshotDigest,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message
      .replaceAll(temporaryRoot, '<temporary Catalog state>')
      .replaceAll(fetchUrl, safeFetchUrl)
      .replaceAll(pushUrl, safePushUrl));
  } finally {
    await fs.remove(temporaryRoot);
  }
}
