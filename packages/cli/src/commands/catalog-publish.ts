import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { assertStrictSemVer, validatePublishedCatalogSnapshot } from '@lesliechan721/aw-plugin-core';

import {
  catalogAttemptPath,
  disposeCatalogPublicationInspection,
  parseRemoteRefs,
  prepareCatalogPublicationInspection,
  publicationGit,
  publicationGitExit,
  sanitizedGitEnvironment,
} from './catalog-publication-inspection.js';

export { safeRemoteIdentity, sanitizedGitEnvironment } from './catalog-publication-inspection.js';

const LEGACY_ATTEMPTED_MARKER = path.join('.aw', 'publish', 'attempted.json');

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
  const destination = catalogAttemptPath(catalogWorkspaceRoot, recordedVersion);
  await fs.ensureDir(path.dirname(destination));
  if (await fs.pathExists(destination)) return;
  await fs.rename(legacyPath, destination);
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
  const inspection = await prepareCatalogPublicationInspection({
    ...options,
    failOnUnavailable: true,
    migrateLegacyAttempt: async (workspaceRoot, catalogVersion) => {
      const markerPath = catalogAttemptPath(workspaceRoot, catalogVersion);
      if (!(await publicationGitExit(workspaceRoot, [
        'check-ignore', '-q', markerPath,
      ], sanitizedGitEnvironment(options.env)))) {
        throw new Error('Catalog publish state under .aw/publish must be ignored by Git. Add .aw/ to .gitignore.');
      }
      await migrateLegacyAttempt(workspaceRoot, catalogVersion);
    },
  });
  const {
    temporaryRoot,
    repositoryRoot,
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
    attemptPath,
    prepared,
    env,
  } = inspection;
  try {
    if (!inspection.tagAvailable) {
      throw new Error(`Remote Catalog tag ${tag} already exists. Increase the Catalog version.`);
    }
    if (!inspection.attemptAvailable) {
      throw new Error(
        `Catalog ${prepared.catalogVersion} already has an attempted publication record. `
        + 'Run aw catalog version <higher> before publishing again.',
      );
    }
    if (!(await publicationGitExit(repoRoot, ['check-ignore', '-q', attemptPath], env))) {
      throw new Error('Catalog publish state under .aw/publish must be ignored by Git. Add .aw/ to .gitignore.');
    }
    await migrateLegacyAttempt(catalogWorkspaceRoot, prepared.catalogVersion);
    if (await fs.pathExists(attemptPath)) {
      throw new Error(
        `Catalog ${prepared.catalogVersion} already has an attempted publication record. `
        + 'Run aw catalog version <higher> before publishing again.',
      );
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
    if (parent) {
      await publicationGit(repositoryRoot, [
        'checkout', '--quiet', '--detach', 'refs/remotes/publish/catalog',
      ], env, 'publicationCommitFailed', 'Could not select the publication parent.');
    } else {
      await publicationGit(repositoryRoot, [
        'checkout', '--quiet', '--orphan', 'catalog-publication',
      ], env, 'publicationCommitFailed', 'Could not create the initial Catalog publication.');
    }
    await clearWorktree(repositoryRoot);
    await fs.copy(prepared.outputRoot, repositoryRoot, { dereference: false });
    await publicationGit(repositoryRoot, ['add', '--force', '--all'], env, 'publicationCommitFailed', 'Could not stage the Catalog publication tree.');
    await publicationGit(repositoryRoot, [
      '-c', 'user.name=AW Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'commit', '--quiet', '-m', `Catalog ${prepared.catalogVersion}`,
    ], env, 'publicationCommitFailed', 'Could not create the Catalog publication commit.');
    const commit = await publicationGit(repositoryRoot, [
      'rev-parse', 'HEAD',
    ], env, 'publicationCommitFailed', 'Could not resolve the Catalog publication commit.');
    const parents = (await publicationGit(repositoryRoot, [
      'show', '-s', '--format=%P', commit,
    ], env, 'publicationCommitFailed', 'Could not verify the Catalog publication parent.'))
      .split(/\s+/u)
      .filter(Boolean);
    if ((parent && (parents.length !== 1 || parents[0] !== parent)) || (!parent && parents.length !== 0)) {
      throw new Error('Catalog publication commit has an invalid parent.');
    }
    const verificationRoot = path.join(temporaryRoot, 'verification');
    await fs.ensureDir(verificationRoot);
    await publicationGit(repositoryRoot, [
      '--work-tree', verificationRoot, 'checkout', '--quiet', commit, '--', '.',
    ], env, 'publicationCommitFailed', 'Could not verify the Catalog publication commit tree.');
    const committed = await validatePublishedCatalogSnapshot(verificationRoot);
    if (committed.snapshotDigest !== prepared.snapshotDigest) {
      throw new Error('Catalog publication commit tree differs from the prepared snapshot.');
    }
    await publicationGit(repositoryRoot, [
      '-c', 'user.name=AW Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'tag', '--annotate', tag, '--message', `Catalog ${prepared.catalogVersion}`,
    ], env, 'publicationCommitFailed', 'Could not create the annotated Catalog tag.');

    const liveHead = await publicationGit(repoRoot, [
      'rev-parse', '--verify', 'HEAD',
    ], env, 'sourceDrift', 'Could not recheck the source Git HEAD.');
    const liveStatus = await publicationGit(repoRoot, [
      'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
    ], env, 'sourceDrift', 'Could not recheck the source worktree.');
    const livePrepared = await validatePublishedCatalogSnapshot(prepared.outputRoot);
    if (
      liveHead !== sourceHead
      || liveStatus !== ''
      || livePrepared.snapshotDigest !== prepared.snapshotDigest
      || livePrepared.manifest.release.state !== 'published'
      || livePrepared.manifest.release.planId !== prepared.planId
    ) {
      throw new Error('Source or Catalog plan identity changed before publication.');
    }
    const [liveFetchUrl, livePushUrl] = await Promise.all([
      publicationGit(
        repoRoot,
        ['remote', 'get-url', remote],
        env,
        'remoteDrift',
        'Could not recheck the Catalog publication remote configuration.',
      ),
      publicationGit(
        repoRoot,
        ['remote', 'get-url', '--push', remote],
        env,
        'remoteDrift',
        'Could not recheck the Catalog publication remote configuration.',
      ),
    ]);
    if (digest(JSON.stringify({ fetchUrl: liveFetchUrl, pushUrl: livePushUrl })) !== remoteIdentityDigest) {
      throw new Error('Catalog remote configuration changed during preparation.');
    }
    const liveRefs = parseRemoteRefs(await publicationGit(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'remoteDrift', 'Could not recheck the Catalog publication remote.'));
    if ((liveRefs.get(branchRef) ?? null) !== parent || liveRefs.has(tagRef) || liveRefs.has(`${tagRef}^{}`)) {
      throw new Error('Catalog remote changed during preparation. Increase the Catalog version before publishing again.');
    }
    if (await fs.pathExists(attemptPath)) {
      throw new Error(
        `Catalog ${prepared.catalogVersion} already has an attempted publication record. `
        + 'Run aw catalog version <higher> before publishing again.',
      );
    }
    const attempted = {
      schemaVersion: 1,
      state: 'attempted',
      workspaceIdentity: digest(JSON.stringify({
        repoRoot,
        workspaceRelative: path.relative(repoRoot, catalogWorkspaceRoot),
      })),
      catalogVersion: prepared.catalogVersion,
      sourceHead,
      remote: { name: remote, identityDigest: remoteIdentityDigest },
      branch,
      tag,
      preparedSnapshotDigest: prepared.snapshotDigest,
      attemptedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(attemptPath, attempted);
    try {
      await publicationGit(repositoryRoot, [
        'push', '--atomic', 'publish', `${commit}:${branchRef}`, `${tagRef}:${tagRef}`,
      ], env, 'publicationUncertain', `Catalog atomic push failed or its result is uncertain. Do not retry ${prepared.catalogVersion}; increase the Catalog version.`);
    } catch {
      throw new Error(`Catalog atomic push failed or its result is uncertain. Do not retry ${prepared.catalogVersion}; run aw catalog version <higher>.`);
    }
    const publishedRefs = parseRemoteRefs(await publicationGit(repositoryRoot, [
      'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
    ], env, 'publicationUncertain', `Catalog publication result is uncertain. Do not retry ${prepared.catalogVersion}; increase the Catalog version.`));
    if (publishedRefs.get(branchRef) !== commit || publishedRefs.get(`${tagRef}^{}`) !== commit) {
      throw new Error(`Catalog publication result is uncertain. Do not retry ${prepared.catalogVersion}; run aw catalog version <higher>.`);
    }
    await writeJsonAtomic(attemptPath, {
      ...attempted,
      state: 'published',
      commit,
      publishedAt: new Date().toISOString(),
    });
    return {
      command: 'catalog:publish',
      ok: true,
      catalogVersion: prepared.catalogVersion,
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
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(temporaryRoot, '<temporary Catalog state>')
      .replaceAll(fetchUrl, safeFetchUrl)
      .replaceAll(pushUrl, safePushUrl);
    throw new Error(message);
  } finally {
    await disposeCatalogPublicationInspection(inspection);
  }
}
