import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import {
  validatePublishedCatalogSnapshot,
} from '@lesliechan721/aw-plugin-core';

import {
  disposeCatalogPublicationInspection,
  parseRemoteRefs,
  prepareCatalogPublicationInspection,
  publicationGit,
  publicationGitExit,
  type CatalogPublicationDescriptor,
  type CatalogPublicationPreparation,
} from './catalog-publication-inspection.js';
import {
  resolveCatalogPublicationTarget,
  type CatalogBranchResolvedFrom,
  type CatalogRemoteResolvedFrom,
} from './catalog-publication-target.js';
import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolvedFrom,
} from './catalog-workspace-resolution.js';

export { safeRemoteIdentity, sanitizedGitEnvironment } from './catalog-publication-inspection.js';

export interface CatalogPublishIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CatalogPublishReceipt {
  command: 'catalog:publish';
  ok: true;
  workspaceRoot: string;
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom;
  workspaceIdentity: string;
  catalogVersion: string;
  channel: 'latest' | 'beta';
  remote: string;
  remoteResolvedFrom: CatalogRemoteResolvedFrom;
  remoteUrl: string;
  fetchUrl: string;
  pushUrl: string;
  branch: string;
  branchResolvedFrom: CatalogBranchResolvedFrom;
  parent: string | null;
  tag: string;
  commit: string;
  sourceHead: string;
  pluginCount: number;
  snapshotDigest: string;
  planId: string;
  descriptorDigest: string;
}

function digest(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function catalogPublicationDescriptorDigest(descriptor: CatalogPublicationDescriptor): string {
  return digest(canonicalJson(descriptor));
}

async function writeJsonAtomic(filePath: string, value: unknown, exclusive: boolean): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    if (exclusive) {
      await fs.link(temporary, filePath);
      await fs.remove(temporary);
    } else {
      await fs.rename(temporary, filePath);
    }
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

async function assertNoGitAttributes(root: string, relative = ''): Promise<void> {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.name === '.gitattributes') {
      throw new Error(`Catalog publication snapshot must not contain .gitattributes (${child}).`);
    }
    if (entry.isDirectory()) await assertNoGitAttributes(root, child);
  }
}

async function assertSnapshotBinding(
  snapshotRoot: string,
  descriptor: CatalogPublicationDescriptor,
): Promise<void> {
  const [stats, validation, ledgerBytes] = await Promise.all([
    fs.lstat(snapshotRoot),
    validatePublishedCatalogSnapshot(snapshotRoot),
    fs.readFile(path.join(snapshotRoot, 'plugin-release-ledger.json')),
  ]);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Prepared Catalog snapshot must be a regular local directory.');
  }
  const release = validation.manifest.release;
  if (
    validation.manifest.catalogVersion !== descriptor.catalogVersion
    || validation.manifest.channel !== descriptor.channel
    || validation.snapshotDigest !== descriptor.snapshotDigest
    || release.state !== 'published'
    || release.sourceHead !== descriptor.sourceHead
    || release.contentDigest !== descriptor.contentDigest
    || release.planId !== descriptor.planId
    || digest(ledgerBytes) !== descriptor.ledgerDigest
  ) {
    throw new Error('Prepared Catalog descriptor, snapshot, ledger, or plan identity changed.');
  }
  await assertNoGitAttributes(snapshotRoot);
}

async function publishCatalogPublicationPreparation(options: {
  preparation: CatalogPublicationPreparation;
  descriptor: CatalogPublicationDescriptor;
  snapshotRoot: string;
  beforeRemoteWrite?: () => Promise<void>;
  workspaceRootResolvedFrom?: CatalogWorkspaceResolvedFrom;
  remoteResolvedFrom?: CatalogRemoteResolvedFrom;
  branchResolvedFrom?: CatalogBranchResolvedFrom;
}): Promise<CatalogPublishReceipt> {
  const { preparation: inspection, descriptor, snapshotRoot } = options;
  const {
    temporaryRoot,
    repositoryRoot,
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
    env,
  } = inspection;
  if (
    catalogPublicationDescriptorDigest(inspection.descriptor)
    !== catalogPublicationDescriptorDigest(descriptor)
  ) {
    throw new Error('Catalog publication descriptor changed after preparation.');
  }
  if (!inspection.tagAvailable) {
    throw new Error(`Remote Catalog tag ${tag} already exists. Increase the Catalog version.`);
  }
  if (!inspection.attemptAvailable || await fs.pathExists(attemptPath)) {
    throw new Error(
      `Catalog ${descriptor.catalogVersion} already has an attempted publication record. `
      + 'Run aw catalog version <higher> before publishing again.',
    );
  }
  if (!(await publicationGitExit(repoRoot, ['check-ignore', '-q', attemptPath], env))) {
    throw new Error('Catalog publish state under .aw/publish must be ignored by Git. Add .aw/ to .gitignore.');
  }
  await assertSnapshotBinding(snapshotRoot, descriptor);

  if (parent) {
    await publicationGit(repositoryRoot, [
      'checkout', '--quiet', '--detach', 'refs/aw/catalog-parent',
    ], env, 'publicationCommitFailed', 'Could not select the publication parent.');
  } else {
    await publicationGit(repositoryRoot, [
      'checkout', '--quiet', '--orphan', 'catalog-publication',
    ], env, 'publicationCommitFailed', 'Could not create the initial Catalog publication.');
  }
  await clearWorktree(repositoryRoot);
  await fs.copy(snapshotRoot, repositoryRoot, { dereference: false });
  await publicationGit(repositoryRoot, ['add', '--force', '--all'], env, 'publicationCommitFailed', 'Could not stage the Catalog publication tree.');
  await publicationGit(repositoryRoot, [
    '-c', 'user.name=AW Catalog Publisher',
    '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
    'commit', '--quiet', '-m', `Catalog ${descriptor.catalogVersion}`,
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
  await assertSnapshotBinding(verificationRoot, descriptor);
  await publicationGit(repositoryRoot, [
    '-c', 'user.name=AW Catalog Publisher',
    '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
    'tag', '--annotate', tag, '--message', `Catalog ${descriptor.catalogVersion}`,
  ], env, 'publicationCommitFailed', 'Could not create the annotated Catalog tag.');

  const liveHead = await publicationGit(repoRoot, [
    'rev-parse', '--verify', 'HEAD',
  ], env, 'sourceDrift', 'Could not recheck the source Git HEAD.');
  const liveStatus = await publicationGit(repoRoot, [
    'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none',
  ], env, 'sourceDrift', 'Could not recheck the source worktree.');
  if (liveHead !== sourceHead || liveStatus !== '') {
    throw new Error('Source HEAD or worktree changed before Catalog publication.');
  }
  let liveFetchUrl: string;
  let livePushUrl: string;
  if (descriptor.remote.name === null) {
    liveFetchUrl = fetchUrl;
    livePushUrl = pushUrl;
  } else {
    [liveFetchUrl, livePushUrl] = await Promise.all([
      publicationGit(
        repoRoot,
        ['remote', 'get-url', descriptor.remote.name],
        env,
        'remoteDrift',
        'Could not recheck the Catalog publication remote configuration.',
      ),
      publicationGit(
        repoRoot,
        ['remote', 'get-url', '--push', descriptor.remote.name],
        env,
        'remoteDrift',
        'Could not recheck the Catalog publication remote configuration.',
      ),
    ]);
  }
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
      `Catalog ${descriptor.catalogVersion} already has an attempted publication record. `
      + 'Run aw catalog version <higher> before publishing again.',
    );
  }
  await options.beforeRemoteWrite?.();
  const attempted = {
    schemaVersion: 1,
    state: 'attempted',
    workspaceIdentity: descriptor.workspaceIdentity,
    catalogVersion: descriptor.catalogVersion,
    sourceHead,
    remote: { name: descriptor.remote.name, identityDigest: remoteIdentityDigest },
    branch,
    parent,
    tag,
    snapshotDigest: descriptor.snapshotDigest,
    contentDigest: descriptor.contentDigest,
    planId: descriptor.planId,
    descriptorDigest: catalogPublicationDescriptorDigest(descriptor),
    attemptedAt: new Date().toISOString(),
  };
  try {
    await writeJsonAtomic(attemptPath, attempted, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Catalog ${descriptor.catalogVersion} already has an attempted publication record. `
        + 'Run aw catalog version <higher> before publishing again.',
      );
    }
    throw error;
  }
  try {
    await publicationGit(repositoryRoot, [
      'push', '--atomic', `--force-with-lease=${branchRef}:${parent ?? ''}`,
      'publish', `${commit}:${branchRef}`, `${tagRef}:${tagRef}`,
    ], env, 'publicationUncertain', `Catalog atomic push failed or its result is uncertain. Do not retry ${descriptor.catalogVersion}; increase the Catalog version.`);
  } catch {
    throw new Error(`Catalog atomic push failed or its result is uncertain. Do not retry ${descriptor.catalogVersion}; run aw catalog version <higher>.`);
  }
  const publishedRefs = parseRemoteRefs(await publicationGit(repositoryRoot, [
    'ls-remote', 'publish', branchRef, tagRef, `${tagRef}^{}`,
  ], env, 'publicationUncertain', `Catalog publication result is uncertain. Do not retry ${descriptor.catalogVersion}; increase the Catalog version.`));
  if (publishedRefs.get(branchRef) !== commit || publishedRefs.get(`${tagRef}^{}`) !== commit) {
    throw new Error(`Catalog publication result is uncertain. Do not retry ${descriptor.catalogVersion}; run aw catalog version <higher>.`);
  }
  await writeJsonAtomic(attemptPath, {
    ...attempted,
    state: 'published',
    commit,
    publishedAt: new Date().toISOString(),
  }, false);
  return {
    command: 'catalog:publish',
    ok: true,
    workspaceRoot: inspection.catalogWorkspaceRoot,
    workspaceRootResolvedFrom: options.workspaceRootResolvedFrom ?? 'explicit',
    workspaceIdentity: descriptor.workspaceIdentity,
    catalogVersion: descriptor.catalogVersion,
    channel: descriptor.channel,
    remote,
    remoteResolvedFrom: options.remoteResolvedFrom ?? 'explicit',
    remoteUrl: safeFetchUrl,
    fetchUrl: safeFetchUrl,
    pushUrl: safePushUrl,
    branch,
    branchResolvedFrom: options.branchResolvedFrom ?? 'explicit',
    parent,
    tag,
    commit,
    sourceHead,
    pluginCount: descriptor.pluginNames.length,
    snapshotDigest: descriptor.snapshotDigest,
    planId: descriptor.planId,
    descriptorDigest: catalogPublicationDescriptorDigest(descriptor),
  };
}

export async function publishPreparedCatalogPublication(options: {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch?: string;
  descriptor: CatalogPublicationDescriptor;
  snapshotRoot: string;
  env: NodeJS.ProcessEnv;
  beforeRemoteWrite?: () => Promise<void>;
}): Promise<CatalogPublishReceipt> {
  const inspection = await prepareCatalogPublicationInspection({
    workspaceRoot: options.workspaceRoot,
    remote: options.remote,
    remoteUrl: options.remoteUrl,
    branch: options.branch,
    env: options.env,
    failOnUnavailable: true,
  });
  try {
    return await publishCatalogPublicationPreparation({
      preparation: inspection,
      descriptor: options.descriptor,
      snapshotRoot: options.snapshotRoot,
      beforeRemoteWrite: options.beforeRemoteWrite,
    });
  } finally {
    await disposeCatalogPublicationInspection(inspection);
  }
}

export async function runCatalogPublishCommand(options: {
  cwd: string;
  workspaceRoot?: string;
  remote?: string;
  branch?: string;
  expectedDescriptorDigest?: string;
  yes?: boolean;
  json?: boolean;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  confirm?: (message: string) => Promise<boolean>;
  io: CatalogPublishIo;
}): Promise<CatalogPublishReceipt | null> {
  if (options.json && !options.yes) throw new Error('Catalog publish with --json requires --yes.');
  if (!options.interactive && !options.yes) throw new Error('Non-interactive Catalog publish requires --yes.');
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.expectedDescriptorDigest ?? '')) {
    throw new Error(
      'Catalog publish requires --expected-descriptor-digest from a successful publication preflight.',
    );
  }
  const workspace = await resolveCatalogWorkspaceRoot({
    cwd: options.cwd,
    ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
    mode: 'existing',
  });
  const target = await resolveCatalogPublicationTarget({
    workspaceRoot: workspace.workspaceRoot,
    remote: options.remote,
    branch: options.branch,
    env: options.env,
    requireRemote: true,
  });
  const inspection = await prepareCatalogPublicationInspection({
    workspaceRoot: workspace.workspaceRoot,
    remote: target.remote!,
    branch: target.branch,
    env: options.env,
    failOnUnavailable: true,
  });
  try {
    const preparedDescriptorDigest = catalogPublicationDescriptorDigest(inspection.descriptor);
    if (options.expectedDescriptorDigest !== preparedDescriptorDigest) {
      throw new Error(
        'Catalog publication descriptor does not match the authorized preflight. Run preflight and authorize the current exact identity.',
      );
    }
    if (!(await publicationGitExit(inspection.repoRoot, ['check-ignore', '-q', inspection.attemptPath], inspection.env))) {
      throw new Error('Catalog publish state under .aw/publish must be ignored by Git. Add .aw/ to .gitignore.');
    }
    if (!options.yes) {
      options.io.stderr([
        `Workspace identity: ${inspection.descriptor.workspaceIdentity}`,
        `Source HEAD: ${inspection.sourceHead}`,
        `Catalog: ${inspection.descriptor.catalogVersion} (${inspection.descriptor.channel})`,
        `Remote: ${inspection.remote}`,
        `Fetch URL: ${inspection.safeFetchUrl}`,
        `Push URL: ${inspection.safePushUrl}`,
        `Branch: ${inspection.branchRef}`,
        `Parent: ${inspection.parent ?? '<root>'}`,
        `Tag: ${inspection.tagRef}`,
        `Snapshot digest: ${inspection.descriptor.snapshotDigest}`,
        `Plan ID: ${inspection.descriptor.planId}`,
        `Descriptor digest: ${preparedDescriptorDigest}`,
        `Plugins: ${inspection.descriptor.pluginNames.length}`,
        'One atomic push will publish the branch and annotated tag.',
      ].join('\n') + '\n');
      if (!options.confirm || !(await options.confirm('Publish this Catalog snapshot?'))) {
        options.io.stderr('Catalog publication cancelled.\n');
        return null;
      }
    }
    return await publishCatalogPublicationPreparation({
      preparation: inspection,
      descriptor: inspection.descriptor,
      snapshotRoot: inspection.prepared.outputRoot,
      workspaceRootResolvedFrom: workspace.workspaceRootResolvedFrom,
      remoteResolvedFrom: target.remoteResolvedFrom,
      branchResolvedFrom: target.branchResolvedFrom,
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(inspection.temporaryRoot, '<temporary Catalog state>')
      .replaceAll(inspection.fetchUrl, inspection.safeFetchUrl)
      .replaceAll(inspection.pushUrl, inspection.safePushUrl);
    throw new Error(message);
  } finally {
    await disposeCatalogPublicationInspection(inspection);
  }
}
