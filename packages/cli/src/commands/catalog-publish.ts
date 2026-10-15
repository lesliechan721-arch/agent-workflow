import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import {
  GENERATED_OUTPUT_MARKER_FILENAME,
  validatePublishedCatalogSnapshot,
  type CatalogManifestV7Entry,
} from '@lesliechan721/aw-plugin-core';

import {
  disposeCatalogPublicationInspection,
  inspectCatalogPublicationApplyContext,
  inspectCatalogPublicationLiveContext,
  parseRemoteRefs,
  prepareCatalogPublicationInspection,
  publicationGit,
  publicationGitExit,
  readCatalogPublicationBranchState,
  type CatalogPublicationApplyContext,
  type CatalogPublicationLiveContext,
  type CatalogPublicationPreparation,
} from './catalog-publication-inspection.js';
import {
  catalogPublicationDirectoryPath,
  catalogPublicationJournalPath,
  catalogPublicationPlanDigest,
  catalogPublicationRepositoryName,
  catalogPublicationRepositoryPath,
  findCatalogPublicationJournalByPlanDigest,
  readCatalogPublicationJournal,
  writeCatalogPublicationJournalAtomic,
  type CatalogPublicationDescriptor,
  type CatalogPublicationDisplayMetadata,
  type CatalogPublicationJournal,
} from './catalog-publication-journal.js';
import {
  resolveCatalogPublicationTarget,
  type CatalogBranchResolvedFrom,
  type CatalogRemoteResolvedFrom,
} from './catalog-publication-target.js';
import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolvedFrom,
} from './catalog-workspace-resolution.js';

export {
  catalogPublicationPlanDigest,
  parseCatalogPublicationJournal,
} from './catalog-publication-journal.js';
export type {
  CatalogPublicationDescriptor,
  CatalogPublicationJournal,
} from './catalog-publication-journal.js';
export { safeRemoteIdentity, sanitizedGitEnvironment } from './catalog-publication-inspection.js';

export interface CatalogPublishIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

interface CatalogPublishReceiptBase {
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
  expectedCommit: string;
  sourceHead: string;
  pluginCount: number;
  snapshotDigest: string;
  planDigest: string;
  descriptor: CatalogPublicationDescriptor;
  journalPath: string;
  repositoryPath: string | null;
}

export interface CatalogPublishPlanReceipt extends CatalogPublishReceiptBase {
  command: 'catalog:publish:plan';
  state: CatalogPublicationJournal['state'];
}

export interface CatalogPublishApplyReceipt extends CatalogPublishReceiptBase {
  command: 'catalog:publish:apply';
  state: 'published';
  commit: string;
  reconciliation: 'already-published' | 'already-remote' | 'atomic' | 'tag' | 'branch';
  warnings: string[];
}

export const CATALOG_PUBLICATION_CLEANUP_WARNING =
  'Catalog publication succeeded, but local repository cleanup did not complete. Retry apply with the same plan digest.';

interface ReceiptResolution {
  workspaceRootResolvedFrom?: CatalogWorkspaceResolvedFrom;
  remoteResolvedFrom?: CatalogRemoteResolvedFrom;
  branchResolvedFrom?: CatalogBranchResolvedFrom;
}

interface RemoteRefState {
  branchCommit: string | null;
  tagCommit: string | null;
  tagPresent: boolean;
  tagAnnotated: boolean;
}

interface PublicationTargetOptions {
  workspaceRoot: string;
  remote?: string;
  remoteUrl?: string;
  branch?: string;
  env: NodeJS.ProcessEnv;
}

interface PersistPlanHooks {
  beforeFinalRename?: (paths: {
    temporaryStateRoot: string;
    finalStateRoot: string;
  }) => Promise<void>;
}

interface ApplyPlanHooks {
  beforeRemoteWrite?: () => Promise<void>;
  removeRepository?: (repositoryPath: string) => Promise<void>;
}

type CatalogPublicationReceiptContext = CatalogPublicationLiveContext | CatalogPublicationApplyContext;

async function assertPublicationStatePathSafe(workspaceRoot: string): Promise<void> {
  for (const candidate of [
    path.join(workspaceRoot, '.aw'),
    path.join(workspaceRoot, '.aw', 'publish'),
  ]) {
    if (!(await fs.pathExists(candidate))) continue;
    const stats = await fs.lstat(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Catalog publication state path must contain only regular local directories.');
    }
  }
}

async function assertPublicationDirectorySafe(directoryPath: string, catalogVersion: string): Promise<boolean> {
  let stats;
  try {
    stats = await fs.lstat(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Catalog ${catalogVersion} publication state directory is damaged. Increase the Catalog version.`);
  }
  return true;
}

function sameDescriptor(left: CatalogPublicationDescriptor, right: CatalogPublicationDescriptor): boolean {
  const comparisonCommit = '0'.repeat(40);
  return catalogPublicationPlanDigest(left, comparisonCommit)
    === catalogPublicationPlanDigest(right, comparisonCommit);
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
  display: CatalogPublicationDisplayMetadata,
): Promise<void> {
  const markerPath = path.join(snapshotRoot, GENERATED_OUTPUT_MARKER_FILENAME);
  const [stats, markerStats] = await Promise.all([
    fs.lstat(snapshotRoot),
    fs.lstat(markerPath),
  ]);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Prepared Catalog snapshot must be a regular local directory.');
  }
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
    throw new Error('Prepared Catalog snapshot marker must be a regular local file.');
  }
  const [marker, validation] = await Promise.all([
    fs.readJson(markerPath) as Promise<Record<string, unknown>>,
    validatePublishedCatalogSnapshot(snapshotRoot),
  ]);
  const release = validation.manifest.release;
  if (
    marker.workspaceIdentity !== descriptor.workspaceIdentity
    || validation.manifest.catalogVersion !== display.catalogVersion
    || validation.manifest.channel !== display.channel
    || validation.manifest.entries.length !== display.pluginCount
    || validation.snapshotDigest !== descriptor.snapshotDigest
    || release.state !== 'published'
    || release.sourceHead !== descriptor.sourceHead
  ) {
    throw new Error('Prepared Catalog descriptor, snapshot, or plan identity changed.');
  }
  await assertNoGitAttributes(snapshotRoot);
}

function displayFromPreparation(preparation: CatalogPublicationPreparation): CatalogPublicationDisplayMetadata {
  return {
    catalogVersion: preparation.prepared.catalogVersion,
    channel: preparation.prepared.channel,
    pluginCount: preparation.prepared.pluginNames.length,
  };
}

function assertLiveContextMatchesDescriptor(
  context: CatalogPublicationLiveContext,
  descriptor: CatalogPublicationDescriptor,
): void {
  if (
    context.workspaceIdentity !== descriptor.workspaceIdentity
    || context.sourceHead !== descriptor.sourceHead
    || context.remoteName !== descriptor.remote.name
    || context.remoteIdentityDigest !== descriptor.remote.identityDigest
    || context.branch !== descriptor.branch
    || context.tag !== descriptor.tag
  ) {
    throw new Error('Catalog publication identity changed. Increase the Catalog version and create a new plan.');
  }
}

function assertApplyContextMatchesDescriptor(
  context: CatalogPublicationApplyContext,
  descriptor: CatalogPublicationDescriptor,
): void {
  if (
    context.workspaceIdentity !== descriptor.workspaceIdentity
    || context.remoteIdentityDigest !== descriptor.remote.identityDigest
    || context.branch !== descriptor.branch
  ) {
    throw new Error('Catalog publication identity changed. Increase the Catalog version and create a new plan.');
  }
}

async function createPublicationCommit(
  preparation: CatalogPublicationPreparation,
  descriptor: CatalogPublicationDescriptor,
  snapshotRoot: string,
  display: CatalogPublicationDisplayMetadata,
): Promise<string> {
  const { repositoryRoot, parent, tag, env } = preparation;
  await assertSnapshotBinding(snapshotRoot, descriptor, display);
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
  await publicationGit(repositoryRoot, [
    'add', '--force', '--all',
  ], env, 'publicationCommitFailed', 'Could not stage the Catalog publication tree.');
  await publicationGit(repositoryRoot, [
    '-c', 'user.name=AW Catalog Publisher',
    '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
    'commit', '--quiet', '-m', `Catalog ${display.catalogVersion}`,
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
  const verificationRoot = path.join(preparation.temporaryRoot, 'verification');
  await fs.ensureDir(verificationRoot);
  await publicationGit(repositoryRoot, [
    '--work-tree', verificationRoot, 'checkout', '--quiet', commit, '--', '.',
  ], env, 'publicationCommitFailed', 'Could not verify the Catalog publication commit tree.');
  await assertSnapshotBinding(verificationRoot, descriptor, display);
  await publicationGit(repositoryRoot, [
    '-c', 'user.name=AW Catalog Publisher',
    '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
    'tag', '--annotate', tag, '--message', `Catalog ${display.catalogVersion}`,
  ], env, 'publicationCommitFailed', 'Could not create the annotated Catalog tag.');
  return commit;
}

async function remoteRefState(
  cwd: string,
  remote: string,
  branchRef: string,
  tagRef: string,
  env: NodeJS.ProcessEnv,
): Promise<RemoteRefState> {
  const refs = parseRemoteRefs(await publicationGit(cwd, [
    'ls-remote', remote, branchRef, tagRef, `${tagRef}^{}`,
  ], env, 'remoteReadFailed', 'Could not inspect the Catalog publication remote.'));
  const tagPresent = refs.has(tagRef) || refs.has(`${tagRef}^{}`);
  return {
    branchCommit: refs.get(branchRef) ?? null,
    tagCommit: refs.get(`${tagRef}^{}`) ?? null,
    tagPresent,
    tagAnnotated: refs.has(tagRef) && refs.has(`${tagRef}^{}`),
  };
}

function assertReconciliableRemoteState(state: RemoteRefState, journal: CatalogPublicationJournal): void {
  const branchAtExpected = state.branchCommit === journal.expectedCommit;
  const branchAtParent = state.branchCommit === journal.descriptor.parent;
  const tagAtExpected = state.tagAnnotated && state.tagCommit === journal.expectedCommit;
  const tagAbsent = !state.tagPresent;
  if (
    (branchAtExpected && tagAtExpected)
    || (branchAtParent && tagAbsent)
    || (branchAtExpected && tagAbsent)
    || (branchAtParent && tagAtExpected)
  ) return;
  throw new Error(
    `Catalog ${journal.display.catalogVersion} remote refs conflict with the prepared plan. Increase the Catalog version.`,
  );
}

const PERSISTED_REPOSITORY_CONFIG = new Map<string, ReadonlySet<string>>([
  ['core.repositoryformatversion', new Set(['0'])],
  ['core.filemode', new Set(['true', 'false'])],
  ['core.bare', new Set(['false'])],
  ['core.logallrefupdates', new Set(['true'])],
  ['core.ignorecase', new Set(['true'])],
  ['core.precomposeunicode', new Set(['true'])],
  ['core.hookspath', new Set([os.devNull])],
  ['core.symlinks', new Set(['true'])],
]);

const REQUIRED_PERSISTED_REPOSITORY_CONFIG = [
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.logallrefupdates',
  'core.hookspath',
  'core.symlinks',
] as const;

async function assertRegularGitDirectory(root: string): Promise<void> {
  const stats = await fs.lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Pending Catalog publication Git directory is unsafe.');
  }
}

async function assertRegularGitFile(filePath: string): Promise<void> {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Pending Catalog publication Git control file is unsafe.');
  }
}

async function assertGitTreeContainsOnlyLocalFiles(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    const stats = await fs.lstat(child);
    if (stats.isSymbolicLink()) {
      throw new Error('Pending Catalog publication Git data must not contain symbolic links.');
    }
    if (stats.isDirectory()) {
      await assertGitTreeContainsOnlyLocalFiles(child);
    } else if (!stats.isFile()) {
      throw new Error('Pending Catalog publication Git data must contain only regular local files.');
    }
  }
}

async function assertPathMissing(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Pending Catalog publication repository must not use alternate object stores.');
}

async function validatePersistentRepositoryControlState(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const gitRoot = path.join(repositoryRoot, '.git');
  const configPath = path.join(gitRoot, 'config');
  await assertRegularGitDirectory(gitRoot);
  await assertRegularGitFile(configPath);
  await assertRegularGitFile(path.join(gitRoot, 'HEAD'));
  await assertRegularGitFile(path.join(gitRoot, 'index'));
  await assertRegularGitDirectory(path.join(gitRoot, 'objects'));
  await assertRegularGitDirectory(path.join(gitRoot, 'refs'));
  await assertPathMissing(path.join(gitRoot, 'objects', 'info', 'alternates'));
  await assertPathMissing(path.join(gitRoot, 'objects', 'info', 'http-alternates'));
  await assertGitTreeContainsOnlyLocalFiles(gitRoot);

  const entries = (await publicationGit(repositoryRoot, [
    'config', '--file', configPath, '--no-includes', '--null', '--list',
  ], env, 'pendingRepositoryInvalid', 'Pending Catalog publication config is damaged.'))
    .split('\0')
    .filter(Boolean);
  const seen = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf('\n');
    if (separator <= 0) throw new Error('Pending Catalog publication config is damaged.');
    const key = entry.slice(0, separator).toLowerCase();
    const value = entry.slice(separator + 1);
    if (seen.has(key) || !PERSISTED_REPOSITORY_CONFIG.get(key)?.has(value)) {
      throw new Error('Pending Catalog publication config contains unsafe local settings.');
    }
    seen.add(key);
  }
  if (REQUIRED_PERSISTED_REPOSITORY_CONFIG.some((key) => !seen.has(key))) {
    throw new Error('Pending Catalog publication config is incomplete.');
  }
}

async function validatePersistentRepository(
  repositoryRoot: string,
  journal: CatalogPublicationJournal,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const version = journal.display.catalogVersion;
  let stats;
  try {
    stats = await fs.lstat(repositoryRoot);
  } catch (error) {
    throw new Error(
      `Catalog ${version} pending publication repository is missing or damaged. Increase the Catalog version.`,
      { cause: error },
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Catalog ${version} pending publication repository is missing or damaged. Increase the Catalog version.`);
  }
  try {
    await validatePersistentRepositoryControlState(repositoryRoot, env);
    const [head, tagCommit, tagType, remotes, parents] = await Promise.all([
      publicationGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], env, 'pendingRepositoryInvalid', 'Pending Catalog publication repository is damaged.'),
      publicationGit(repositoryRoot, ['rev-parse', `${journal.descriptor.tag}^{commit}`], env, 'pendingRepositoryInvalid', 'Pending Catalog publication tag is damaged.'),
      publicationGit(repositoryRoot, ['cat-file', '-t', `refs/tags/${journal.descriptor.tag}`], env, 'pendingRepositoryInvalid', 'Pending Catalog publication tag is damaged.'),
      publicationGit(repositoryRoot, ['remote'], env, 'pendingRepositoryInvalid', 'Pending Catalog publication repository is damaged.'),
      publicationGit(repositoryRoot, ['show', '-s', '--format=%P', journal.expectedCommit], env, 'pendingRepositoryInvalid', 'Pending Catalog publication commit is damaged.'),
    ]);
    const parentList = parents.split(/\s+/u).filter(Boolean);
    if (
      head !== journal.expectedCommit
      || tagCommit !== journal.expectedCommit
      || tagType !== 'tag'
      || remotes !== ''
      || (journal.descriptor.parent === null
        ? parentList.length !== 0
        : parentList.length !== 1 || parentList[0] !== journal.descriptor.parent)
    ) throw new Error('Pending Catalog publication repository identity changed.');
    const verificationRoot = path.join(
      path.dirname(repositoryRoot),
      `.${path.basename(repositoryRoot)}.${crypto.randomUUID()}.verify`,
    );
    try {
      await fs.ensureDir(verificationRoot);
      await publicationGit(repositoryRoot, [
        '--work-tree', verificationRoot, 'checkout', '--quiet', journal.expectedCommit, '--', '.',
      ], env, 'pendingRepositoryInvalid', 'Pending Catalog publication commit tree is damaged.');
      await assertSnapshotBinding(verificationRoot, journal.descriptor, journal.display);
    } finally {
      await fs.remove(verificationRoot);
    }
  } catch (error) {
    throw new Error(
      `Catalog ${version} pending publication repository is missing or damaged. Increase the Catalog version.`,
      { cause: error },
    );
  }
}

async function persistPublicationState(
  preparation: CatalogPublicationPreparation,
  finalStateRoot: string,
  journal: CatalogPublicationJournal,
  hooks: PersistPlanHooks,
): Promise<CatalogPublicationJournal> {
  const parent = path.dirname(finalStateRoot);
  await fs.ensureDir(parent);
  const staging = path.join(parent, `.${path.basename(finalStateRoot)}.${crypto.randomUUID()}.tmp`);
  const repositoryPath = path.join(staging, catalogPublicationRepositoryName());
  const journalPath = path.join(staging, 'journal.json');
  try {
    await publicationGit(preparation.repositoryRoot, [
      'remote', 'remove', 'publish',
    ], preparation.env, 'temporaryRepositoryFailed', 'Could not seal the publication repository.');
    await fs.ensureDir(staging);
    await fs.copy(preparation.repositoryRoot, repositoryPath, { dereference: false, errorOnExist: true });
    await writeCatalogPublicationJournalAtomic(journalPath, journal);
    const persisted = await readCatalogPublicationJournal(journalPath, journal.display.catalogVersion);
    if (!persisted || persisted.planDigest !== journal.planDigest) {
      throw new Error(`Catalog ${journal.display.catalogVersion} publication state could not be verified.`);
    }
    await validatePersistentRepository(repositoryPath, persisted, preparation.env);
    await hooks.beforeFinalRename?.({
      temporaryStateRoot: staging,
      finalStateRoot,
    });
    try {
      await fs.rename(staging, finalStateRoot);
      return persisted;
    } catch (error) {
      if (!(await fs.pathExists(finalStateRoot))) throw error;
      if (!(await assertPublicationDirectorySafe(finalStateRoot, journal.display.catalogVersion))) throw error;
      const existing = await readCatalogPublicationJournal(
        path.join(finalStateRoot, 'journal.json'),
        journal.display.catalogVersion,
      );
      if (!existing) {
        throw new Error(
          `Catalog ${journal.display.catalogVersion} publication state is incomplete. Increase the Catalog version.`,
        );
      }
      if (existing.planDigest !== journal.planDigest) {
        throw new Error(
          `Catalog ${journal.display.catalogVersion} already has a different publication plan. Increase the Catalog version.`,
        );
      }
      if (existing.state !== 'published') {
        await validatePersistentRepository(
          path.join(finalStateRoot, catalogPublicationRepositoryName()),
          existing,
          preparation.env,
        );
      }
      return existing;
    }
  } finally {
    await fs.remove(staging);
  }
}

function receiptBase(
  context: CatalogPublicationReceiptContext,
  journal: CatalogPublicationJournal,
  resolution: ReceiptResolution,
): CatalogPublishReceiptBase {
  const repositoryPath = journal.repository === null
    ? null
    : catalogPublicationRepositoryPath(context.catalogWorkspaceRoot, journal.display.catalogVersion);
  return {
    ok: true,
    workspaceRoot: context.catalogWorkspaceRoot,
    workspaceRootResolvedFrom: resolution.workspaceRootResolvedFrom ?? 'explicit',
    workspaceIdentity: journal.descriptor.workspaceIdentity,
    catalogVersion: journal.display.catalogVersion,
    channel: journal.display.channel,
    remote: context.remote,
    remoteResolvedFrom: resolution.remoteResolvedFrom ?? 'explicit',
    remoteUrl: context.safeFetchUrl,
    fetchUrl: context.safeFetchUrl,
    pushUrl: context.safePushUrl,
    branch: journal.descriptor.branch,
    branchResolvedFrom: resolution.branchResolvedFrom ?? 'explicit',
    parent: journal.descriptor.parent,
    tag: journal.descriptor.tag,
    expectedCommit: journal.expectedCommit,
    sourceHead: journal.descriptor.sourceHead,
    pluginCount: journal.display.pluginCount,
    snapshotDigest: journal.descriptor.snapshotDigest,
    planDigest: journal.planDigest,
    descriptor: journal.descriptor,
    journalPath: catalogPublicationJournalPath(
      context.catalogWorkspaceRoot,
      journal.display.catalogVersion,
    ),
    repositoryPath,
  };
}

async function readExistingPlan(
  context: CatalogPublicationLiveContext,
  resolution: ReceiptResolution,
): Promise<CatalogPublishPlanReceipt | null> {
  await assertPublicationStatePathSafe(context.catalogWorkspaceRoot);
  const stateRoot = catalogPublicationDirectoryPath(context.catalogWorkspaceRoot, context.catalogVersion);
  const journalPath = catalogPublicationJournalPath(context.catalogWorkspaceRoot, context.catalogVersion);
  const repositoryPath = catalogPublicationRepositoryPath(context.catalogWorkspaceRoot, context.catalogVersion);
  const stateRootExists = await assertPublicationDirectorySafe(stateRoot, context.catalogVersion);
  const journal = await readCatalogPublicationJournal(journalPath, context.catalogVersion);
  if (!journal) {
    if (stateRootExists) {
      throw new Error(`Catalog ${context.catalogVersion} pending publication journal is missing. Increase the Catalog version.`);
    }
    return null;
  }
  assertLiveContextMatchesDescriptor(context, journal.descriptor);
  if (journal.state !== 'published') {
    await validatePersistentRepository(repositoryPath, journal, context.env);
  }
  const state = await remoteRefState(
    context.repoRoot,
    context.pushUrl,
    context.branchRef,
    context.tagRef,
    context.env,
  );
  if (journal.state === 'published'
    && (state.branchCommit !== journal.expectedCommit
      || !state.tagAnnotated
      || state.tagCommit !== journal.expectedCommit)) {
    throw new Error(
      `Catalog ${journal.display.catalogVersion} published journal conflicts with remote refs. Increase the Catalog version.`,
    );
  }
  assertReconciliableRemoteState(state, journal);
  return {
    command: 'catalog:publish:plan',
    state: journal.state,
    ...receiptBase(context, journal, resolution),
  };
}

async function persistNewPlan(options: {
  preparation: CatalogPublicationPreparation;
  descriptor: CatalogPublicationDescriptor;
  snapshotRoot: string;
  resolution: ReceiptResolution;
} & PersistPlanHooks): Promise<CatalogPublishPlanReceipt> {
  const { preparation, descriptor, snapshotRoot, resolution } = options;
  await assertPublicationStatePathSafe(preparation.catalogWorkspaceRoot);
  if (!sameDescriptor(preparation.descriptor, descriptor)) {
    throw new Error('Catalog publication descriptor changed during preparation.');
  }
  const display = displayFromPreparation(preparation);
  const stateRoot = catalogPublicationDirectoryPath(preparation.catalogWorkspaceRoot, display.catalogVersion);
  const journalPath = catalogPublicationJournalPath(preparation.catalogWorkspaceRoot, display.catalogVersion);
  if (!(await publicationGitExit(preparation.repoRoot, ['check-ignore', '-q', journalPath], preparation.env))) {
    throw new Error('Catalog publish state under .aw/publish must be ignored by Git. Add .aw/ to .gitignore.');
  }
  if (await fs.pathExists(stateRoot)) {
    throw new Error(
      `Catalog ${display.catalogVersion} already has publication state. Use its existing plan or increase the Catalog version.`,
    );
  }
  if (!preparation.tagAvailable) {
    throw new Error(`Remote Catalog tag ${descriptor.tag} already exists. Increase the Catalog version.`);
  }
  const expectedCommit = await createPublicationCommit(preparation, descriptor, snapshotRoot, display);
  let context = await inspectCatalogPublicationLiveContext({
    workspaceRoot: preparation.catalogWorkspaceRoot,
    ...(descriptor.remote.name === null ? { remoteUrl: preparation.pushUrl } : { remote: descriptor.remote.name }),
    branch: descriptor.branch,
    env: preparation.env,
  });
  assertLiveContextMatchesDescriptor(context, descriptor);
  const liveRefs = await remoteRefState(
    preparation.repositoryRoot,
    'publish',
    preparation.branchRef,
    preparation.tagRef,
    preparation.env,
  );
  if (liveRefs.branchCommit !== descriptor.parent || liveRefs.tagPresent) {
    throw new Error(`Catalog ${display.catalogVersion} remote changed during plan creation. Increase the Catalog version.`);
  }
  const journal: CatalogPublicationJournal = {
    schemaVersion: 2,
    state: 'prepared',
    planDigest: catalogPublicationPlanDigest(descriptor, expectedCommit),
    descriptor,
    expectedCommit,
    repository: catalogPublicationRepositoryName(),
    display,
    preparedAt: new Date().toISOString(),
  };
  const persisted = await persistPublicationState(preparation, stateRoot, journal, {
    beforeFinalRename: async (paths) => {
      await options.beforeFinalRename?.(paths);
      context = await inspectCatalogPublicationLiveContext({
        workspaceRoot: preparation.catalogWorkspaceRoot,
        ...(descriptor.remote.name === null
          ? { remoteUrl: preparation.pushUrl }
          : { remote: descriptor.remote.name }),
        branch: descriptor.branch,
        env: preparation.env,
      });
      assertLiveContextMatchesDescriptor(context, descriptor);
      const finalRefs = await remoteRefState(
        context.repoRoot,
        context.pushUrl,
        context.branchRef,
        context.tagRef,
        context.env,
      );
      if (finalRefs.branchCommit !== descriptor.parent || finalRefs.tagPresent) {
        throw new Error(
          `Catalog ${display.catalogVersion} remote changed during plan creation. Increase the Catalog version.`,
        );
      }
    },
  });
  return {
    command: 'catalog:publish:plan',
    state: persisted.state,
    ...receiptBase(context, persisted, resolution),
  };
}

export async function persistCatalogPublicationPlan(options: {
  preparation: CatalogPublicationPreparation;
  descriptor?: CatalogPublicationDescriptor;
  snapshotRoot?: string;
  workspaceRootResolvedFrom?: CatalogWorkspaceResolvedFrom;
  remoteResolvedFrom?: CatalogRemoteResolvedFrom;
  branchResolvedFrom?: CatalogBranchResolvedFrom;
} & PersistPlanHooks): Promise<CatalogPublishPlanReceipt> {
  return persistNewPlan({
    preparation: options.preparation,
    descriptor: options.descriptor ?? options.preparation.descriptor,
    snapshotRoot: options.snapshotRoot ?? options.preparation.prepared.outputRoot,
    resolution: options,
    beforeFinalRename: options.beforeFinalRename,
  });
}

export async function prepareCatalogPublicationPlan(
  options: PublicationTargetOptions & ReceiptResolution & PersistPlanHooks & {
    officialPluginHistory?: readonly CatalogManifestV7Entry[];
    sourcePluginVersionsAtBaseline?: Readonly<Record<string, string>>;
  },
): Promise<CatalogPublishPlanReceipt> {
  const context = await inspectCatalogPublicationLiveContext(options);
  const existing = await readExistingPlan(context, options);
  if (existing) return existing;
  const initialState = await remoteRefState(
    context.repoRoot,
    context.pushUrl,
    context.branchRef,
    context.tagRef,
    context.env,
  );
  if (initialState.tagPresent) {
    throw new Error(`Remote Catalog tag ${context.tag} already exists. Increase the Catalog version.`);
  }
  if (initialState.branchCommit !== null) {
    const branchState = await readCatalogPublicationBranchState({
      workspaceRoot: context.catalogWorkspaceRoot,
      ...(options.remoteUrl === undefined ? { remote: options.remote } : { remoteUrl: options.remoteUrl }),
      branch: context.branch,
      env: options.env,
    });
    if (branchState?.version === context.catalogVersion) {
      throw new Error(
        `Remote Catalog branch already contains version ${context.catalogVersion} without its journal. Increase the Catalog version.`,
      );
    }
  }
  const preparation = await prepareCatalogPublicationInspection(options);
  try {
    return await persistNewPlan({
      preparation,
      descriptor: preparation.descriptor,
      snapshotRoot: preparation.prepared.outputRoot,
      resolution: options,
      beforeFinalRename: options.beforeFinalRename,
    });
  } finally {
    await disposeCatalogPublicationInspection(preparation);
  }
}

async function markUncertain(
  journalPath: string,
  journal: Exclude<CatalogPublicationJournal, { state: 'published' }>,
): Promise<CatalogPublicationJournal> {
  const uncertain: CatalogPublicationJournal = {
    schemaVersion: 2,
    state: 'uncertain',
    planDigest: journal.planDigest,
    descriptor: journal.descriptor,
    expectedCommit: journal.expectedCommit,
    repository: journal.repository,
    display: journal.display,
    preparedAt: journal.preparedAt,
    uncertainAt: new Date().toISOString(),
  };
  await writeCatalogPublicationJournalAtomic(journalPath, uncertain);
  return uncertain;
}

interface AuthorizedPublicationPlan {
  context: CatalogPublicationApplyContext;
  journalPath: string;
  repositoryPath: string;
  tagRef: string;
  journal: CatalogPublicationJournal;
}

async function readAuthorizedPublicationPlan(
  options: PublicationTargetOptions & { expectedPlanDigest: string },
): Promise<AuthorizedPublicationPlan> {
  await assertPublicationStatePathSafe(options.workspaceRoot);
  const located = await findCatalogPublicationJournalByPlanDigest(
    options.workspaceRoot,
    options.expectedPlanDigest,
  );
  const context = await inspectCatalogPublicationApplyContext(options);
  assertApplyContextMatchesDescriptor(context, located.journal.descriptor);
  return {
    context,
    journalPath: located.journalPath,
    repositoryPath: catalogPublicationRepositoryPath(
      context.catalogWorkspaceRoot,
      located.catalogVersion,
    ),
    tagRef: `refs/tags/${located.journal.descriptor.tag}`,
    journal: located.journal,
  };
}

async function cleanupPublishedRepository(
  repositoryPath: string,
  journal: Extract<CatalogPublicationJournal, { state: 'published' }>,
  env: NodeJS.ProcessEnv,
  removeRepository: (repositoryPath: string) => Promise<void>,
): Promise<string[]> {
  try {
    await fs.lstat(repositoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [CATALOG_PUBLICATION_CLEANUP_WARNING];
  }
  const pendingJournal: CatalogPublicationJournal = {
    schemaVersion: 2,
    state: 'prepared',
    planDigest: journal.planDigest,
    descriptor: journal.descriptor,
    expectedCommit: journal.expectedCommit,
    repository: catalogPublicationRepositoryName(),
    display: journal.display,
    preparedAt: journal.preparedAt,
  };
  try {
    await validatePersistentRepository(repositoryPath, pendingJournal, env);
    await removeRepository(repositoryPath);
    return [];
  } catch {
    return [CATALOG_PUBLICATION_CLEANUP_WARNING];
  }
}

async function inspectCatalogPublicationPlanForApply(
  options: PublicationTargetOptions & { expectedPlanDigest: string } & ReceiptResolution,
): Promise<CatalogPublishPlanReceipt> {
  const authorized = await readAuthorizedPublicationPlan(options);
  const { context, journal, repositoryPath, tagRef } = authorized;
  if (journal.state !== 'published') {
    await validatePersistentRepository(repositoryPath, journal, context.env);
  }
  const state = await remoteRefState(
    journal.state === 'published' ? context.repoRoot : repositoryPath,
    context.pushUrl,
    context.branchRef,
    tagRef,
    context.env,
  );
  if (journal.state === 'published'
    && (state.branchCommit !== journal.expectedCommit
      || !state.tagAnnotated
      || state.tagCommit !== journal.expectedCommit)) {
    throw new Error(
      `Catalog ${journal.display.catalogVersion} published journal conflicts with remote refs. Increase the Catalog version.`,
    );
  }
  assertReconciliableRemoteState(state, journal);
  return {
    command: 'catalog:publish:plan',
    state: journal.state,
    ...receiptBase(context, journal, options),
  };
}

export async function applyCatalogPublicationPlan(options: PublicationTargetOptions & {
  expectedPlanDigest: string;
} & ReceiptResolution & ApplyPlanHooks): Promise<CatalogPublishApplyReceipt> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.expectedPlanDigest)) {
    throw new Error('Catalog publish apply requires --expected-plan-digest from catalog publish plan.');
  }
  const authorized = await readAuthorizedPublicationPlan(options);
  const { context, journalPath, repositoryPath, tagRef } = authorized;
  let { journal } = authorized;
  if (journal.state === 'published') {
    const state = await remoteRefState(
      context.repoRoot,
      context.pushUrl,
      context.branchRef,
      tagRef,
      context.env,
    );
    if (state.branchCommit !== journal.expectedCommit || !state.tagAnnotated || state.tagCommit !== journal.expectedCommit) {
      throw new Error(
        `Catalog ${journal.display.catalogVersion} published journal conflicts with remote refs. Increase the Catalog version.`,
      );
    }
    const warnings = await cleanupPublishedRepository(
      repositoryPath,
      journal,
      context.env,
      options.removeRepository ?? fs.remove,
    );
    return {
      command: 'catalog:publish:apply',
      state: 'published',
      commit: journal.expectedCommit,
      reconciliation: 'already-published',
      warnings,
      ...receiptBase(context, journal, options),
    };
  }
  await validatePersistentRepository(repositoryPath, journal, context.env);
  let state = await remoteRefState(
    repositoryPath,
    context.pushUrl,
    context.branchRef,
    tagRef,
    context.env,
  );
  assertReconciliableRemoteState(state, journal);
  let reconciliation: CatalogPublishApplyReceipt['reconciliation'];
  const branchAtExpected = state.branchCommit === journal.expectedCommit;
  const tagAtExpected = state.tagAnnotated && state.tagCommit === journal.expectedCommit;
  if (branchAtExpected && tagAtExpected) {
    reconciliation = 'already-remote';
  } else {
    await options.beforeRemoteWrite?.();
    const writeContext = await inspectCatalogPublicationApplyContext(options);
    assertApplyContextMatchesDescriptor(writeContext, journal.descriptor);
    await validatePersistentRepository(repositoryPath, journal, writeContext.env);
    state = await remoteRefState(
      repositoryPath,
      writeContext.pushUrl,
      writeContext.branchRef,
      tagRef,
      writeContext.env,
    );
    assertReconciliableRemoteState(state, journal);
    try {
      if (state.branchCommit === journal.expectedCommit
        && state.tagAnnotated
        && state.tagCommit === journal.expectedCommit) {
        reconciliation = 'already-remote';
      } else if (state.branchCommit === journal.descriptor.parent && !state.tagPresent) {
        reconciliation = 'atomic';
        await publicationGit(repositoryPath, [
          'push', '--atomic',
          `--force-with-lease=${writeContext.branchRef}:${journal.descriptor.parent ?? ''}`,
          writeContext.pushUrl,
          `${journal.expectedCommit}:${writeContext.branchRef}`,
          `${tagRef}:${tagRef}`,
        ], writeContext.env, 'publicationUncertain', 'Catalog atomic push failed or its result is uncertain.');
      } else if (state.branchCommit === journal.expectedCommit && !state.tagPresent) {
        reconciliation = 'tag';
        await publicationGit(repositoryPath, [
          'push', writeContext.pushUrl, `${tagRef}:${tagRef}`,
        ], writeContext.env, 'publicationUncertain', 'Catalog tag push failed or its result is uncertain.');
      } else {
        reconciliation = 'branch';
        await publicationGit(repositoryPath, [
          'push', `--force-with-lease=${writeContext.branchRef}:${journal.descriptor.parent ?? ''}`,
          writeContext.pushUrl, `${journal.expectedCommit}:${writeContext.branchRef}`,
        ], writeContext.env, 'publicationUncertain', 'Catalog branch push failed or its result is uncertain.');
      }
    } catch (error) {
      journal = await markUncertain(journalPath, journal);
      throw new Error(
        `Catalog ${journal.display.catalogVersion} publication result is uncertain. Retry apply with the same plan digest.`,
        { cause: error },
      );
    }
    try {
      state = await remoteRefState(
        repositoryPath,
        writeContext.pushUrl,
        writeContext.branchRef,
        tagRef,
        writeContext.env,
      );
    } catch (error) {
      journal = await markUncertain(journalPath, journal);
      throw new Error(
        `Catalog ${journal.display.catalogVersion} publication result is uncertain. Retry apply with the same plan digest.`,
        { cause: error },
      );
    }
    if (state.branchCommit !== journal.expectedCommit || !state.tagAnnotated || state.tagCommit !== journal.expectedCommit) {
      journal = await markUncertain(journalPath, journal);
      throw new Error(
        `Catalog ${journal.display.catalogVersion} publication result is uncertain. Retry apply with the same plan digest.`,
      );
    }
  }
  const published: CatalogPublicationJournal = {
    schemaVersion: 2,
    state: 'published',
    planDigest: journal.planDigest,
    descriptor: journal.descriptor,
    expectedCommit: journal.expectedCommit,
    repository: null,
    display: journal.display,
    preparedAt: journal.preparedAt,
    publishedAt: new Date().toISOString(),
  };
  await writeCatalogPublicationJournalAtomic(journalPath, published);
  const warnings = await cleanupPublishedRepository(
    repositoryPath,
    published,
    context.env,
    options.removeRepository ?? fs.remove,
  );
  return {
    command: 'catalog:publish:apply',
    state: 'published',
    commit: published.expectedCommit,
    reconciliation,
    warnings,
    ...receiptBase(context, published, options),
  };
}

export async function runCatalogPublishPlanCommand(options: {
  cwd: string;
  workspaceRoot?: string;
  remote?: string;
  branch?: string;
  env: NodeJS.ProcessEnv;
  io: CatalogPublishIo;
}): Promise<CatalogPublishPlanReceipt> {
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
  return prepareCatalogPublicationPlan({
    workspaceRoot: workspace.workspaceRoot,
    remote: target.remote!,
    branch: target.branch,
    env: options.env,
    workspaceRootResolvedFrom: workspace.workspaceRootResolvedFrom,
    remoteResolvedFrom: target.remoteResolvedFrom,
    branchResolvedFrom: target.branchResolvedFrom,
  });
}

export async function runCatalogPublishApplyCommand(options: {
  cwd: string;
  workspaceRoot?: string;
  remote?: string;
  branch?: string;
  expectedPlanDigest?: string;
  yes?: boolean;
  json?: boolean;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  confirm?: (message: string) => Promise<boolean>;
  io: CatalogPublishIo;
}): Promise<CatalogPublishApplyReceipt | null> {
  if (options.json && !options.yes) throw new Error('Catalog publish apply with --json requires --yes.');
  if (!options.interactive && !options.yes) throw new Error('Non-interactive Catalog publish apply requires --yes.');
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.expectedPlanDigest ?? '')) {
    throw new Error('Catalog publish apply requires --expected-plan-digest from catalog publish plan.');
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
  if (!options.yes) {
    const plan = await inspectCatalogPublicationPlanForApply({
      workspaceRoot: workspace.workspaceRoot,
      remote: target.remote!,
      branch: target.branch,
      expectedPlanDigest: options.expectedPlanDigest!,
      env: options.env,
      workspaceRootResolvedFrom: workspace.workspaceRootResolvedFrom,
      remoteResolvedFrom: target.remoteResolvedFrom,
      branchResolvedFrom: target.branchResolvedFrom,
    });
    options.io.stderr([
      `Workspace identity: ${plan.workspaceIdentity}`,
      `Source HEAD: ${plan.sourceHead}`,
      `Remote: ${plan.remote}`,
      `Fetch URL: ${plan.fetchUrl}`,
      `Push URL: ${plan.pushUrl}`,
      `Branch: refs/heads/${plan.branch}`,
      `Parent: ${plan.parent ?? '<root>'}`,
      `Tag: refs/tags/${plan.tag}`,
      `Snapshot digest: ${plan.snapshotDigest}`,
      `Expected commit: ${plan.expectedCommit}`,
      `Plan digest: ${plan.planDigest}`,
    ].join('\n') + '\n');
    if (!options.confirm || !(await options.confirm('Apply this Catalog publication plan?'))) {
      options.io.stderr('Catalog publication cancelled.\n');
      return null;
    }
  }
  const result = await applyCatalogPublicationPlan({
    workspaceRoot: workspace.workspaceRoot,
    remote: target.remote!,
    branch: target.branch,
    expectedPlanDigest: options.expectedPlanDigest!,
    env: options.env,
    workspaceRootResolvedFrom: workspace.workspaceRootResolvedFrom,
    remoteResolvedFrom: target.remoteResolvedFrom,
    branchResolvedFrom: target.branchResolvedFrom,
  });
  for (const warning of result.warnings) options.io.stderr(`${warning}\n`);
  return result;
}
