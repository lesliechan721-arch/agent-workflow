import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { PlatformName, Scope } from '../types.js';
import { resolveActiveMarketplaceRuntimeCoordinationRoot } from './active-marketplace-runtime-lock.js';
import { CATALOG_SOURCE_ID_PATTERN } from './catalog-sources.js';
import { tryParseStrictSemVer } from './manifest.js';
import {
  acquireProcessLock,
  type ProcessLockFileSystem,
  type ProcessLockLease,
} from './process-lock.js';
import {
  canonicalizePathThroughExistingAncestor,
  createProjectLocationKey,
  resolveAwHomeCanonical,
  resolveCanonicalRepoProjectKey,
} from './state-paths.js';
import { assertTestWritablePath } from './test-path-fence.js';

export const INSTALLATION_CONTRACT_DIR = 'installation-contracts';
export const INSTALLATION_CONTRACT_SCHEMA_VERSION = 1;
export const INSTALLATION_CONTRACT_METADATA_FILE = 'metadata.json';

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STAGE_PATTERN = /^stage-[0-9a-f]{24}$/;
const BACKUP_PATTERN = /^backup-[0-9a-f]{24}$/;
let processLockFileSystemForTests: ProcessLockFileSystem | undefined;

export function setInstallationContractLockFileSystemForTests(
  fileSystem: ProcessLockFileSystem | undefined,
): void {
  processLockFileSystemForTests = fileSystem;
}

export interface InstallationDependencyPlacement {
  pluginId: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
}

interface InstallationContractMetadataPayload {
  schemaVersion: 1;
  sourceId: string;
  sourceIdentity: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  contentDigest: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
  dependencies: InstallationDependencyPlacement[];
}

export interface InstallationContractMetadata extends InstallationContractMetadataPayload {
  metadataIntegrityDigest: string;
}

export interface InstallationContractTarget {
  sourceId: string;
  sourceIdentity: string;
  pluginId: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey: string | null;
  locationKey: string;
  awHome: string;
  coordinationRoot: string;
  storeRoot: string;
  targetRoot: string;
  activeRoot: string;
  stagingRoot: string;
  lockPath: string;
}

export interface StagedInstallationContract {
  target: InstallationContractTarget;
  stageId: string;
  stageRoot: string;
  metadata: InstallationContractMetadata;
}

export interface ReadInstallationContract {
  target: InstallationContractTarget;
  activeRoot: string;
  metadata: InstallationContractMetadata;
}

export interface InstallationContractInventoryError {
  code: 'invalidInstallationContract';
  path: string;
  message: string;
}

export interface InstallationContractInventory {
  contracts: ReadInstallationContract[];
  errors: InstallationContractInventoryError[];
}

export class InstallationContractError extends Error {
  readonly code = 'invalidInstallationContract';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstallationContractError';
  }
}

function fail(message: string): never {
  throw new InstallationContractError(message);
}

function emitHousekeepingWarning(message: string, error: unknown): void {
  process.emitWarning(`${message}: ${error instanceof Error ? error.message : String(error)}`, {
    code: 'AW_INSTALLATION_CONTRACT_HOUSEKEEPING_FAILED',
  });
}

function emitLockReleaseWarning(message: string, error: unknown): void {
  process.emitWarning(`${message}: ${error instanceof Error ? error.message : String(error)}`, {
    code: 'AW_INSTALLATION_CONTRACT_LOCK_RELEASE_FAILED',
  });
}

function isRetryableReleaseError(error: unknown): boolean {
  return new Set(['EACCES', 'EBUSY', 'EINTR', 'EIO', 'ENOTEMPTY', 'EPERM']).has(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

async function releaseLeaseWithRetry(lock: ProcessLockLease): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await lock.release();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableReleaseError(error)) throw error;
    }
  }
  await lock.release().catch(() => undefined);
  throw lastError;
}

function writable(targetPath: string): string {
  return assertTestWritablePath(
    targetPath,
    'installation contract store',
    'Use an isolated AW_HOME or register the installation contract root as writable.',
  );
}

function isInsidePath(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInsidePath(candidatePath: string, rootPath: string, label: string): void {
  if (!isInsidePath(candidatePath, rootPath)) {
    fail(`${label} is outside the installation contract store.`);
  }
}

async function lstatIfExists(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertName(value: string, label: string): void {
  if (!NAME_PATTERN.test(value)) fail(`${label} is invalid.`);
}

function assertSourceId(value: string, label: string): void {
  if (!CATALOG_SOURCE_ID_PATTERN.test(value)) fail(`${label} is invalid.`);
}

function assertSourceIdentity(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) fail(`${label} must be a SHA-256 digest.`);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains unknown field "${key}".`);
  }
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

function expectPlatform(value: unknown, label: string): PlatformName {
  if (value !== 'codex' && value !== 'claude') fail(`${label} is invalid.`);
  return value;
}

function expectScope(value: unknown, label: string): Scope {
  if (value !== 'user' && value !== 'project') fail(`${label} is invalid.`);
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function calculateMetadataIntegrityDigest(payload: InstallationContractMetadataPayload): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(payload)).digest('hex')}`;
}

function assertCanonicalProjectKey(projectKey: string, label: string): void {
  if (!path.isAbsolute(projectKey) || path.normalize(projectKey) !== projectKey) {
    fail(`${label} must be an absolute normalized path.`);
  }
}

function parseProjectKey(value: unknown, scope: Scope, label: string): string | null {
  if (scope === 'user') {
    if (value !== null) fail(`${label} must be null for user scope.`);
    return null;
  }
  const projectKey = expectString(value, label);
  assertCanonicalProjectKey(projectKey, label);
  return projectKey;
}

function parsePluginId(value: unknown, sourceId: string, label: string): string {
  const pluginId = expectString(value, label);
  const prefix = `${sourceId}/`;
  if (!pluginId.startsWith(prefix)) fail(`${label} does not match sourceId.`);
  assertName(pluginId.slice(prefix.length), label);
  return pluginId;
}

function dependencyIdentity(dependency: InstallationDependencyPlacement): string {
  return [
    dependency.pluginId,
    dependency.sourceId,
    dependency.sourceIdentity,
    dependency.platform,
    dependency.scope,
    dependency.projectKey ?? '',
  ].join('\0');
}

function compareDependencies(
  left: InstallationDependencyPlacement,
  right: InstallationDependencyPlacement,
): number {
  return dependencyIdentity(left).localeCompare(dependencyIdentity(right), 'en');
}

function parseDependencies(value: unknown): InstallationDependencyPlacement[] {
  if (!Array.isArray(value)) fail('metadata.dependencies must be an array.');
  const identities = new Set<string>();
  const dependencies = value.map((entry, index) => {
    const label = `metadata.dependencies[${index}]`;
    const record = expectRecord(entry, label);
    assertAllowedKeys(record, [
      'pluginId', 'sourceId', 'sourceIdentity', 'platform', 'scope', 'projectKey',
    ], label);
    const sourceId = expectString(record.sourceId, `${label}.sourceId`);
    assertSourceId(sourceId, `${label}.sourceId`);
    const scope = expectScope(record.scope, `${label}.scope`);
    const parsed: InstallationDependencyPlacement = {
      pluginId: parsePluginId(record.pluginId, sourceId, `${label}.pluginId`),
      sourceId,
      sourceIdentity: expectString(record.sourceIdentity, `${label}.sourceIdentity`),
      platform: expectPlatform(record.platform, `${label}.platform`),
      scope,
      projectKey: parseProjectKey(record.projectKey, scope, `${label}.projectKey`),
    };
    assertSourceIdentity(parsed.sourceIdentity, `${label}.sourceIdentity`);
    const identity = dependencyIdentity(parsed);
    if (identities.has(identity)) fail('metadata.dependencies contains duplicate placements.');
    identities.add(identity);
    return parsed;
  });
  if (dependencies.some((dependency, index) =>
    index > 0 && compareDependencies(dependencies[index - 1]!, dependency) > 0)) {
    fail('metadata.dependencies must use canonical order.');
  }
  return dependencies;
}

function validateDependencyPlacements(
  dependencies: readonly InstallationDependencyPlacement[],
  target: InstallationContractTarget,
): void {
  for (const [index, dependency] of dependencies.entries()) {
    if (dependency.sourceId !== target.sourceId
      || dependency.sourceIdentity !== target.sourceIdentity) {
      fail(`metadata.dependencies[${index}] must use the installation target source identity.`);
    }
    if (dependency.platform !== target.platform) {
      fail(`metadata.dependencies[${index}].platform does not match the installation target.`);
    }
    if (dependency.pluginId === target.pluginId
      && dependency.scope === target.scope
      && dependency.projectKey === target.projectKey) {
      fail(`metadata.dependencies[${index}] cannot reference its own placement.`);
    }
    if (target.scope === 'user' && dependency.scope !== 'user') {
      fail(`metadata.dependencies[${index}].scope cannot exceed user scope.`);
    }
    if (dependency.scope === 'project' && dependency.projectKey !== target.projectKey) {
      fail(`metadata.dependencies[${index}].projectKey does not match the installation target.`);
    }
  }
}

function parseMetadata(
  raw: unknown,
  target: InstallationContractTarget,
): InstallationContractMetadata {
  const value = expectRecord(raw, 'metadata');
  assertAllowedKeys(value, [
    'schemaVersion', 'sourceId', 'sourceIdentity', 'pluginId', 'pluginName', 'pluginVersion',
    'contentDigest', 'platform', 'scope', 'projectKey', 'dependencies',
    'metadataIntegrityDigest',
  ], 'metadata');
  if (value.schemaVersion !== INSTALLATION_CONTRACT_SCHEMA_VERSION) {
    fail('metadata.schemaVersion is unsupported.');
  }
  const sourceId = expectString(value.sourceId, 'metadata.sourceId');
  assertSourceId(sourceId, 'metadata.sourceId');
  const sourceIdentity = expectString(value.sourceIdentity, 'metadata.sourceIdentity');
  assertSourceIdentity(sourceIdentity, 'metadata.sourceIdentity');
  const pluginId = parsePluginId(value.pluginId, sourceId, 'metadata.pluginId');
  const pluginName = expectString(value.pluginName, 'metadata.pluginName');
  assertName(pluginName, 'metadata.pluginName');
  const pluginVersion = expectString(value.pluginVersion, 'metadata.pluginVersion');
  if (!tryParseStrictSemVer(pluginVersion)) fail('metadata.pluginVersion must be strict SemVer.');
  const contentDigest = expectString(value.contentDigest, 'metadata.contentDigest');
  const platform = expectPlatform(value.platform, 'metadata.platform');
  const scope = expectScope(value.scope, 'metadata.scope');
  const projectKey = parseProjectKey(value.projectKey, scope, 'metadata.projectKey');
  const dependencies = parseDependencies(value.dependencies);
  validateDependencyPlacements(dependencies, target);
  const metadataIntegrityDigest = expectString(
    value.metadataIntegrityDigest,
    'metadata.metadataIntegrityDigest',
  );
  if (!DIGEST_PATTERN.test(contentDigest) || !DIGEST_PATTERN.test(metadataIntegrityDigest)) {
    fail('metadata digest fields must be SHA-256 digests.');
  }
  if (pluginId !== `${sourceId}/${pluginName}`) fail('metadata.pluginId does not match pluginName.');
  if (
    sourceId !== target.sourceId
    || sourceIdentity !== target.sourceIdentity
    || pluginId !== target.pluginId
    || pluginName !== target.pluginName
    || platform !== target.platform
    || scope !== target.scope
    || projectKey !== target.projectKey
  ) {
    fail('Installation contract target identity does not match its store path.');
  }
  const payload: InstallationContractMetadataPayload = {
    schemaVersion: 1,
    sourceId,
    sourceIdentity,
    pluginId,
    pluginName,
    pluginVersion,
    contentDigest,
    platform,
    scope,
    projectKey,
    dependencies,
  };
  if (calculateMetadataIntegrityDigest(payload) !== metadataIntegrityDigest) {
    fail('Installation contract metadata integrity digest does not match metadata.');
  }
  return { ...payload, metadataIntegrityDigest };
}

async function assertPathChain(
  rootPath: string,
  targetPath: string,
  options: { finalType?: 'directory' | 'file' } = {},
): Promise<boolean> {
  assertInsidePath(targetPath, rootPath, 'store path');
  let current = rootPath;
  const segments = path.relative(rootPath, targetPath).split(path.sep).filter(Boolean);
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = path.join(current, segments[index - 1]!);
    const stat = await lstatIfExists(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) fail(`Installation contract path contains a symbolic link: ${current}`);
    const isFinal = index === segments.length;
    if (isFinal && options.finalType === 'file') {
      if (!stat.isFile()) fail(`Installation contract path is not a regular file: ${current}`);
    } else if (!stat.isDirectory()) {
      fail(`Installation contract path is not a regular directory: ${current}`);
    }
  }
  return true;
}

async function ensureDirectory(
  target: InstallationContractTarget,
  directory: string,
  boundaryRoot = target.storeRoot,
): Promise<void> {
  await assertPathChain(target.awHome, directory);
  await fs.ensureDir(directory);
  await assertPathChain(target.awHome, directory, { finalType: 'directory' });
  const [realBoundaryRoot, realDirectory] = await Promise.all([
    fs.realpath(boundaryRoot),
    fs.realpath(directory),
  ]);
  if (realDirectory !== path.resolve(directory) || !isInsidePath(realDirectory, realBoundaryRoot)) {
    fail('Installation contract directory escapes its canonical store root.');
  }
}

async function validateSnapshot(
  snapshotRoot: string,
  target: InstallationContractTarget,
): Promise<InstallationContractMetadata> {
  assertInsidePath(snapshotRoot, target.targetRoot, 'snapshot root');
  if (!await assertPathChain(target.awHome, snapshotRoot, { finalType: 'directory' })) {
    fail('Installation contract snapshot is missing.');
  }
  const entries = (await fs.readdir(snapshotRoot)).sort();
  if (entries.length !== 1 || entries[0] !== INSTALLATION_CONTRACT_METADATA_FILE) {
    fail('Installation contract snapshot must contain only metadata.json.');
  }
  const metadataPath = path.join(snapshotRoot, INSTALLATION_CONTRACT_METADATA_FILE);
  await assertPathChain(target.awHome, metadataPath, { finalType: 'file' });
  const [realSnapshot, realMetadata] = await Promise.all([
    fs.realpath(snapshotRoot),
    fs.realpath(metadataPath),
  ]);
  if (realSnapshot !== path.resolve(snapshotRoot)
    || realMetadata !== path.join(realSnapshot, INSTALLATION_CONTRACT_METADATA_FILE)) {
    fail('Installation contract snapshot escapes its expected path boundary.');
  }
  let raw: unknown;
  try {
    raw = await fs.readJson(realMetadata);
  } catch (error) {
    throw new InstallationContractError('Installation contract metadata is not valid JSON.', {
      cause: error,
    });
  }
  return parseMetadata(raw, target);
}

async function acquireTargetLock(target: InstallationContractTarget) {
  const lockParent = path.dirname(target.lockPath);
  await assertPathChain(target.coordinationRoot, lockParent);
  await fs.ensureDir(lockParent);
  await assertPathChain(target.coordinationRoot, lockParent, { finalType: 'directory' });
  return acquireProcessLock({
    lockPath: target.lockPath,
    fileSystem: processLockFileSystemForTests,
  });
}

export async function resolveInstallationContractTarget(options: {
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<InstallationContractTarget> {
  assertSourceId(options.sourceId, 'sourceId');
  assertName(options.pluginName, 'pluginName');
  assertSourceIdentity(options.sourceIdentity, 'sourceIdentity');
  const platform = expectPlatform(options.platform, 'platform');
  const scope = expectScope(options.scope, 'scope');
  const env = options.env ?? process.env;
  const awHome = await canonicalizePathThroughExistingAncestor(await resolveAwHomeCanonical(env));
  const projectKey = scope === 'project'
    ? await resolveCanonicalRepoProjectKey(options.cwd)
    : null;
  const locationKey = projectKey ? createProjectLocationKey(projectKey) : 'user';
  const coordinationRoot = resolveActiveMarketplaceRuntimeCoordinationRoot(env);
  const storeRoot = writable(path.join(awHome, INSTALLATION_CONTRACT_DIR));
  const targetRoot = writable(path.join(
    storeRoot,
    options.sourceId,
    platform,
    scope,
    locationKey,
    options.pluginName,
  ));
  const lockPath = writable(path.join(
    coordinationRoot,
    'installation-contract-locks',
    platform,
    scope,
    locationKey,
    `.${options.sourceId}.${options.pluginName}.lock`,
  ));
  return {
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    pluginId: `${options.sourceId}/${options.pluginName}`,
    pluginName: options.pluginName,
    platform,
    scope,
    projectKey,
    locationKey,
    awHome,
    coordinationRoot,
    storeRoot,
    targetRoot,
    activeRoot: path.join(targetRoot, 'active'),
    stagingRoot: path.join(targetRoot, 'staging'),
    lockPath,
  };
}

export async function stageInstallationContract(options: {
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  pluginVersion: string;
  contentDigest: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  dependencies?: readonly InstallationDependencyPlacement[];
  env?: NodeJS.ProcessEnv;
}): Promise<StagedInstallationContract> {
  const target = await resolveInstallationContractTarget(options);
  if (!tryParseStrictSemVer(options.pluginVersion)) fail('pluginVersion must be strict SemVer.');
  if (!DIGEST_PATTERN.test(options.contentDigest)) fail('contentDigest must be a SHA-256 digest.');
  const dependencies = parseDependencies(
    [...(options.dependencies ?? [])].sort(compareDependencies),
  );
  const payload: InstallationContractMetadataPayload = {
    schemaVersion: 1,
    sourceId: target.sourceId,
    sourceIdentity: target.sourceIdentity,
    pluginId: target.pluginId,
    pluginName: target.pluginName,
    pluginVersion: options.pluginVersion,
    contentDigest: options.contentDigest,
    platform: target.platform,
    scope: target.scope,
    projectKey: target.projectKey,
    dependencies,
  };
  const metadata: InstallationContractMetadata = {
    ...payload,
    metadataIntegrityDigest: calculateMetadataIntegrityDigest(payload),
  };
  const lock = await acquireTargetLock(target);
  let transientRoot: string | null = null;
  let stageRoot: string | null = null;
  try {
    await recoverInterruptedTargetBeforeStage(target);
    await ensureDirectory(target, target.stagingRoot);
    const stageId = `stage-${crypto.randomBytes(12).toString('hex')}`;
    stageRoot = path.join(target.stagingRoot, stageId);
    const transientParent = writable(path.join(
      target.awHome,
      `${INSTALLATION_CONTRACT_DIR}-transient`,
    ));
    await ensureDirectory(target, transientParent, target.awHome);
    transientRoot = path.join(transientParent, stageId);
    await fs.mkdir(transientRoot);
    await fs.writeJson(path.join(transientRoot, INSTALLATION_CONTRACT_METADATA_FILE), metadata, {
      spaces: 2,
    });
    await validateOwnedTargetContents(target);
    await fs.rename(transientRoot, stageRoot);
    transientRoot = null;
    const validated = await validateSnapshot(stageRoot, target);
    if (stableStringify(validated) !== stableStringify(metadata)) {
      fail('Staged installation contract changed during validation.');
    }
    return { target, stageId, stageRoot, metadata };
  } catch (error) {
    if (stageRoot) await fs.remove(stageRoot).catch(() => undefined);
    if (transientRoot) await fs.remove(transientRoot).catch(() => undefined);
    throw error;
  } finally {
    await releaseLeaseWithRetry(lock);
  }
}

export async function discardInstallationContract(
  staged: StagedInstallationContract,
): Promise<void> {
  const expected = path.join(staged.target.stagingRoot, staged.stageId);
  if (!STAGE_PATTERN.test(staged.stageId)
    || path.resolve(staged.stageRoot) !== path.resolve(expected)) {
    fail('Installation contract stage identity is invalid.');
  }
  const lock = await acquireTargetLock(staged.target);
  try {
    if (await lstatIfExists(staged.stageRoot)) {
      await validateSnapshot(staged.stageRoot, staged.target);
      await fs.remove(staged.stageRoot);
    }
  } finally {
    await releaseLeaseWithRetry(lock);
  }
}

export async function promoteInstallationContract(
  staged: StagedInstallationContract,
): Promise<ReadInstallationContract> {
  const expectedStageRoot = path.join(staged.target.stagingRoot, staged.stageId);
  if (!STAGE_PATTERN.test(staged.stageId)
    || path.resolve(staged.stageRoot) !== path.resolve(expectedStageRoot)) {
    fail('Installation contract stage identity is invalid.');
  }
  const lock = await acquireTargetLock(staged.target);
  let backupRoot: string | null = null;
  let installedNewActive = false;
  let durableCommit = false;
  let primaryError: unknown;
  try {
    const namespace = await validateOwnedTargetContents(staged.target);
    await cleanupRetryableBackupBeforeWrite(staged.target, namespace);
    const stagedMetadata = await validateSnapshot(staged.stageRoot, staged.target);
    if (stableStringify(stagedMetadata) !== stableStringify(staged.metadata)) {
      fail('Installation contract stage no longer matches its prepared metadata.');
    }
    if (await lstatIfExists(staged.target.activeRoot)) {
      await validateSnapshot(staged.target.activeRoot, staged.target);
      backupRoot = path.join(
        staged.target.targetRoot,
        `backup-${crypto.randomBytes(12).toString('hex')}`,
      );
      await fs.rename(staged.target.activeRoot, backupRoot);
    }
    await fs.rename(staged.stageRoot, staged.target.activeRoot);
    installedNewActive = true;
    const metadata = await validateSnapshot(staged.target.activeRoot, staged.target);
    if (stableStringify(metadata) !== stableStringify(staged.metadata)) {
      fail('Promoted installation contract changed during promotion.');
    }
    durableCommit = true;
    if (backupRoot) {
      try {
        await fs.remove(backupRoot);
        backupRoot = null;
      } catch (error) {
        emitHousekeepingWarning('Committed installation contract retained a retryable backup', error);
      }
    }
    try {
      await fs.rmdir(staged.target.stagingRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        emitHousekeepingWarning('Committed installation contract retained staging residue', error);
      }
    }
    return { target: staged.target, activeRoot: staged.target.activeRoot, metadata };
  } catch (error) {
    primaryError = error;
    if (durableCommit) {
      emitHousekeepingWarning('Installation contract post-commit housekeeping failed', error);
      return {
        target: staged.target,
        activeRoot: staged.target.activeRoot,
        metadata: staged.metadata,
      };
    }
    try {
      if (installedNewActive && await lstatIfExists(staged.target.activeRoot)) {
        await validateSnapshot(staged.target.activeRoot, staged.target);
        await fs.remove(staged.target.activeRoot);
      }
      if (backupRoot && await lstatIfExists(backupRoot)) {
        if (await lstatIfExists(staged.target.activeRoot)) {
          fail('Cannot restore installation contract over a foreign active node.');
        }
        await fs.rename(backupRoot, staged.target.activeRoot);
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Installation contract promotion failed and its previous generation could not be restored.',
        { cause: error },
      );
    }
    throw error;
  } finally {
    try {
      await releaseLeaseWithRetry(lock);
    } catch (error) {
      if (durableCommit) {
        emitLockReleaseWarning('Installation contract committed but its lock release failed', error);
      } else if (primaryError !== undefined) {
        emitLockReleaseWarning('Installation contract failed and its lock release also failed', error);
      } else {
        throw error;
      }
    }
  }
}

export async function readInstallationContract(options: {
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadInstallationContract | null> {
  const target = await resolveInstallationContractTarget(options);
  try {
    const namespace = await readStableTargetNamespace(target);
    const readableRoot = namespace.activeRoot ?? namespace.backupRoot;
    const metadata = namespace.activeMetadata ?? namespace.backupMetadata;
    if (!readableRoot || !metadata) return null;
    return { target, activeRoot: readableRoot, metadata };
  } catch (error) {
    if (error instanceof InstallationContractError) throw error;
    throw new InstallationContractError('Installation contract is corrupt.', { cause: error });
  }
}

interface ValidatedTargetNamespace {
  activeRoot: string | null;
  backupRoot: string | null;
  activeMetadata: InstallationContractMetadata | null;
  backupMetadata: InstallationContractMetadata | null;
}

async function cleanupRetryableBackupBeforeWrite(
  target: InstallationContractTarget,
  namespace: ValidatedTargetNamespace,
): Promise<void> {
  if (!namespace.backupRoot) return;
  if (!namespace.activeRoot) {
    fail('Installation contract backup cleanup requires a valid active generation.');
  }
  await fs.remove(namespace.backupRoot);
  await validateOwnedTargetContents(target);
}

async function removeValidatedStaging(target: InstallationContractTarget): Promise<void> {
  const stagingStat = await lstatIfExists(target.stagingRoot);
  if (!stagingStat) return;
  await assertPathChain(target.awHome, target.stagingRoot, { finalType: 'directory' });
  for (const stageId of await fs.readdir(target.stagingRoot)) {
    if (!STAGE_PATTERN.test(stageId)) {
      fail('Installation contract staging contains a foreign node.');
    }
    const stageRoot = path.join(target.stagingRoot, stageId);
    await validateSnapshot(stageRoot, target);
    await fs.remove(stageRoot);
  }
  await fs.rmdir(target.stagingRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function recoverInterruptedTargetBeforeStage(
  target: InstallationContractTarget,
): Promise<void> {
  const namespace = await validateOwnedTargetContents(target, {
    allowTransitionBackup: true,
  });
  if (namespace.backupRoot && !namespace.activeRoot) {
    await fs.rename(namespace.backupRoot, target.activeRoot);
  } else if (namespace.backupRoot) {
    await fs.remove(namespace.backupRoot);
  }
  await removeValidatedStaging(target);
  await validateOwnedTargetContents(target);
}

async function readStableTargetNamespace(
  target: InstallationContractTarget,
): Promise<ValidatedTargetNamespace> {
  let lastError: unknown;
  let previousAbsent = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const namespace = await validateOwnedTargetContents(target, {
        allowTransitionBackup: true,
      });
      const absent = !namespace.activeRoot && !namespace.backupRoot;
      if (!absent || previousAbsent) return namespace;
      previousAbsent = true;
    } catch (error) {
      lastError = error;
      previousAbsent = false;
    }
  }
  if (lastError !== undefined) throw lastError;
  return {
    activeRoot: null,
    backupRoot: null,
    activeMetadata: null,
    backupMetadata: null,
  };
}

async function validateOwnedTargetContents(
  target: InstallationContractTarget,
  options: { allowTransitionBackup?: boolean } = {},
): Promise<ValidatedTargetNamespace> {
  if (!await assertPathChain(target.awHome, target.targetRoot, { finalType: 'directory' })) {
    return {
      activeRoot: null,
      backupRoot: null,
      activeMetadata: null,
      backupMetadata: null,
    };
  }
  let activeRoot: string | null = null;
  let activeMetadata: InstallationContractMetadata | null = null;
  const backups: Array<{
    root: string;
    metadata: InstallationContractMetadata;
  }> = [];
  for (const entry of await fs.readdir(target.targetRoot)) {
    const entryPath = path.join(target.targetRoot, entry);
    if (entry === 'active') {
      activeMetadata = await validateSnapshot(entryPath, target);
      activeRoot = entryPath;
      continue;
    }
    if (BACKUP_PATTERN.test(entry)) {
      backups.push({
        root: entryPath,
        metadata: await validateSnapshot(entryPath, target),
      });
      continue;
    }
    if (entry === 'staging') {
      await assertPathChain(target.awHome, entryPath, { finalType: 'directory' });
      for (const stageId of await fs.readdir(entryPath)) {
        if (!STAGE_PATTERN.test(stageId)) fail('Installation contract staging contains a foreign node.');
        await validateSnapshot(path.join(entryPath, stageId), target);
      }
      continue;
    }
    fail(`Installation contract target contains foreign node "${entry}".`);
  }
  if (backups.length > 1) {
    fail('Installation contract target contains multiple backup generations.');
  }
  if (backups.length === 1 && !activeRoot && !options.allowTransitionBackup) {
    fail('Installation contract target contains a backup without an active generation.');
  }
  return {
    activeRoot,
    backupRoot: backups[0]?.root ?? null,
    activeMetadata,
    backupMetadata: backups[0]?.metadata ?? null,
  };
}

export async function removeInstallationContract(options: {
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  expectedMetadataIntegrityDigest?: string;
}): Promise<void> {
  const target = await resolveInstallationContractTarget(options);
  const lock = await acquireTargetLock(target);
  let durableCommit = false;
  let primaryError: unknown;
  try {
    if (!await lstatIfExists(target.targetRoot)) return;
    await validateOwnedTargetContents(target);
    if (options.expectedMetadataIntegrityDigest !== undefined) {
      const active = await validateSnapshot(target.activeRoot, target);
      if (active.metadataIntegrityDigest !== options.expectedMetadataIntegrityDigest) {
        fail('Installation contract generation changed before removal.');
      }
    }
    const quarantineRoot = writable(path.join(
      target.awHome,
      `${INSTALLATION_CONTRACT_DIR}-quarantine`,
    ));
    await ensureDirectory(target, quarantineRoot, target.awHome);
    const quarantinedTarget = path.join(
      quarantineRoot,
      `removed-${crypto.randomBytes(12).toString('hex')}`,
    );
    await fs.rename(target.targetRoot, quarantinedTarget);
    durableCommit = true;
    try {
      await fs.remove(quarantinedTarget);
    } catch (error) {
      emitHousekeepingWarning('Removed installation contract retained retryable quarantine', error);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseLeaseWithRetry(lock);
    } catch (error) {
      if (durableCommit) {
        emitLockReleaseWarning('Installation contract removal committed but lock release failed', error);
      } else if (primaryError !== undefined) {
        emitLockReleaseWarning('Installation contract removal failed and lock release also failed', error);
      } else {
        throw error;
      }
    }
  }
}

function inventoryError(targetPath: string, error: unknown): InstallationContractInventoryError {
  return {
    code: 'invalidInstallationContract',
    path: targetPath,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function readInventoryTarget(options: {
  awHome: string;
  storeRoot: string;
  sourceId: string;
  platform: PlatformName;
  scope: Scope;
  locationKey: string;
  pluginName: string;
  targetRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<ReadInstallationContract | null> {
  const activeRoot = path.join(options.targetRoot, 'active');
  const activeExists = await assertPathChain(
    options.awHome,
    activeRoot,
    { finalType: 'directory' },
  );
  let identitySnapshotRoot = activeRoot;
  if (!activeExists) {
    const entries = await fs.readdir(options.targetRoot);
    if (entries.length === 0) return null;
    const backupEntries = entries.filter((entry) => BACKUP_PATTERN.test(entry));
    if (backupEntries.length > 1) {
      fail('Installation contract target contains multiple backup generations.');
    }
    if (backupEntries.length === 1) {
      identitySnapshotRoot = path.join(options.targetRoot, backupEntries[0]!);
    } else {
      if (entries.length !== 1 || entries[0] !== 'staging') {
        fail('Installation contract target without active metadata contains a foreign node.');
      }
      const stagingRoot = path.join(options.targetRoot, 'staging');
      await assertPathChain(options.awHome, stagingRoot, { finalType: 'directory' });
      const stageIds = (await fs.readdir(stagingRoot)).sort();
      if (stageIds.length === 0) return null;
      if (stageIds.some((stageId) => !STAGE_PATTERN.test(stageId))) {
        fail('Installation contract staging contains a foreign node.');
      }
      identitySnapshotRoot = path.join(stagingRoot, stageIds[0]!);
    }
  }
  const metadataPath = path.join(identitySnapshotRoot, INSTALLATION_CONTRACT_METADATA_FILE);
  await assertPathChain(options.awHome, metadataPath, { finalType: 'file' });
  const raw = expectRecord(await fs.readJson(metadataPath), 'metadata');
  const sourceIdentity = expectString(raw.sourceIdentity, 'metadata.sourceIdentity');
  const projectKey = raw.projectKey === null ? null : expectString(raw.projectKey, 'metadata.projectKey');
  const target: InstallationContractTarget = {
    sourceId: options.sourceId,
    sourceIdentity,
    pluginId: `${options.sourceId}/${options.pluginName}`,
    pluginName: options.pluginName,
    platform: options.platform,
    scope: options.scope,
    projectKey,
    locationKey: options.locationKey,
    awHome: options.awHome,
    coordinationRoot: resolveActiveMarketplaceRuntimeCoordinationRoot(options.env),
    storeRoot: options.storeRoot,
    targetRoot: options.targetRoot,
    activeRoot,
    stagingRoot: path.join(options.targetRoot, 'staging'),
    lockPath: writable(path.join(
      resolveActiveMarketplaceRuntimeCoordinationRoot(options.env),
      'installation-contract-locks',
      options.platform,
      options.scope,
      options.locationKey,
      `.${options.sourceId}.${options.pluginName}.lock`,
    )),
  };
  if ((options.scope === 'user' && options.locationKey !== 'user')
    || (options.scope === 'project'
      && (projectKey === null || createProjectLocationKey(projectKey) !== options.locationKey))) {
    fail('Installation contract location key does not match metadata.projectKey.');
  }
  const namespace = await validateOwnedTargetContents(target, {
    allowTransitionBackup: true,
  });
  const readableRoot = namespace.activeRoot ?? namespace.backupRoot;
  const metadata = namespace.activeMetadata ?? namespace.backupMetadata;
  return readableRoot && metadata ? { target, activeRoot: readableRoot, metadata } : null;
}

async function readStableInventoryTarget(
  options: Parameters<typeof readInventoryTarget>[0],
): Promise<ReadInstallationContract | null> {
  let lastError: unknown;
  let previousAbsent = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const contract = await readInventoryTarget(options);
      if (contract || previousAbsent) return contract;
      previousAbsent = true;
    } catch (error) {
      lastError = error;
      previousAbsent = false;
    }
  }
  if (lastError !== undefined) throw lastError;
  return null;
}

export async function inventoryInstallationContracts(options: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<InstallationContractInventory> {
  const env = options.env ?? process.env;
  const awHome = await canonicalizePathThroughExistingAncestor(await resolveAwHomeCanonical(env));
  const storeRoot = writable(path.join(awHome, INSTALLATION_CONTRACT_DIR));
  const contracts: ReadInstallationContract[] = [];
  const errors: InstallationContractInventoryError[] = [];
  try {
    if (!await assertPathChain(awHome, storeRoot, { finalType: 'directory' })) {
      return { contracts, errors };
    }
  } catch (error) {
    return { contracts, errors: [inventoryError(storeRoot, error)] };
  }
  const visitDirectories = async (
    parent: string,
    validateName: (name: string) => void,
    visit: (name: string, entryPath: string) => Promise<void>,
  ): Promise<void> => {
    for (const name of await fs.readdir(parent)) {
      const entryPath = path.join(parent, name);
      try {
        validateName(name);
        await assertPathChain(awHome, entryPath, { finalType: 'directory' });
        await visit(name, entryPath);
      } catch (error) {
        errors.push(inventoryError(entryPath, error));
      }
    }
  };
  await visitDirectories(storeRoot, (sourceId) => assertSourceId(sourceId, 'sourceId'),
    async (sourceId, sourceRoot) => {
      await visitDirectories(sourceRoot, (platform) => expectPlatform(platform, 'platform'),
        async (platformName, platformRoot) => {
          const platform = expectPlatform(platformName, 'platform');
          await visitDirectories(platformRoot, (scope) => expectScope(scope, 'scope'),
            async (scopeName, scopeRoot) => {
              const scope = expectScope(scopeName, 'scope');
              await visitDirectories(scopeRoot, (locationKey) => {
                if (scope === 'user' ? locationKey !== 'user' : !locationKey.startsWith('project-')) {
                  fail('locationKey is invalid.');
                }
              }, async (locationKey, locationRoot) => {
                await visitDirectories(locationRoot, (pluginName) => assertName(pluginName, 'pluginName'),
                  async (pluginName, targetRoot) => {
                    try {
                      const contract = await readStableInventoryTarget({
                        awHome,
                        storeRoot,
                        sourceId,
                        platform,
                        scope,
                        locationKey,
                        pluginName,
                        targetRoot,
                        env,
                      });
                      if (contract) contracts.push(contract);
                    } catch (error) {
                      errors.push(inventoryError(targetRoot, error));
                    }
                  });
              });
            });
        });
    });
  contracts.sort((left, right) => left.activeRoot.localeCompare(right.activeRoot, 'en'));
  errors.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { contracts, errors };
}
