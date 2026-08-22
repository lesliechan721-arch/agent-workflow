import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CliConfigPromptOptions,
  CliConfigPromptSchema,
  CommandExecutionContext,
} from '../commands/runtime.js';
import type {
  ConfigSchemaEvidence,
  ConfigFieldEntry,
  PluginConfigSchema,
  PluginConfigSchemaField,
  PluginManifestSource,
  PluginMeta,
  Scope,
} from '../types.js';
import {
  assertTestReadablePath,
  assertTestWritablePath,
} from './test-path-fence.js';
import {
  markActiveMarketplaceDurableCommit,
  withActiveMarketplaceRuntimeLease,
} from './active-marketplace-runtime-lock.js';
import {
  canonicalizePathThroughExistingAncestor,
  resolveAwHome,
  resolveRepoRootSync,
} from './paths.js';
import { acquireProcessLock, type ProcessLockLease } from './process-lock.js';

export type PluginConfigValue = string | number | boolean;
export type PluginConfigSource = 'default' | 'user' | 'project' | 'projectLocal' | 'missing';
export type PluginConfigIssueType = 'missing-required' | 'invalid-config';
export type ProjectConfigStoreLayer = 'shared' | 'local';
type PluginConfigStorePathAccess = 'read' | 'write';

interface ConfigCommitContext {
  parent?: ConfigCommitContext;
  durableCommit: boolean;
}

const configCommitStorage = new AsyncLocalStorage<ConfigCommitContext>();

function markConfigDurableCommit(): void {
  let context = configCommitStorage.getStore();
  while (context) {
    context.durableCommit = true;
    context = context.parent;
  }
  markActiveMarketplaceDurableCommit();
}

export interface PluginConfigIssue {
  type: PluginConfigIssueType;
  key: string;
  source?: PluginConfigSource;
  message: string;
}

export interface IgnoredUnknownPluginConfigKey {
  scope: Scope;
  projectLayer?: ProjectConfigStoreLayer;
  source: Exclude<PluginConfigSource, 'default' | 'missing'>;
  key: string;
}

export interface PluginConfigStore {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
}

interface NamespacedPluginConfigEnvelope {
  schemaVersion: 2;
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  values: Record<string, unknown>;
}

export interface ResolvedEffectivePluginConfig {
  pluginName: string;
  projectRoot: string;
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, PluginConfigValue | '[redacted]'>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  schema: PluginConfigSchema['schema'];
  stores: {
    user: PluginConfigStore;
    project: PluginConfigStore;
    projectLocal: PluginConfigStore;
  };
}

export interface ProjectArtifactConfigBoundaryIssue {
  key: string;
  source: PluginConfigSource;
  reason:
    | 'pathTypeDefault'
    | 'pathTypeRequired'
    | 'sharedPathValue'
    | 'pathTypeRefreshKey';
  message: string;
}

export interface ResolvedProjectArtifactRenderConfig {
  pluginName: string;
  projectRoot: string;
  values: Record<string, PluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  boundaryIssues: ProjectArtifactConfigBoundaryIssue[];
  schema: PluginConfigSchema['schema'];
  stores: {
    user: PluginConfigStore;
    project: PluginConfigStore;
    projectLocal: PluginConfigStore;
  };
}

export interface ProjectScopedPluginConfigEntryView {
  key: string;
  defaultValue?: PluginConfigValue | '[redacted]';
  userValue?: PluginConfigValue | '[redacted]';
  projectSharedValue?: PluginConfigValue | '[redacted]';
  projectLocalValue?: PluginConfigValue | '[redacted]';
  effectiveValue?: PluginConfigValue | '[redacted]';
  effectiveSource: PluginConfigSource;
  repoVisibleArtifactValue?: PluginConfigValue | '[redacted]';
  repoVisibleArtifactSource: PluginConfigSource;
  repoVisibleArtifactUsesSharedTruth: boolean;
}

export interface ResolvedProjectScopedPluginConfigView {
  pluginName: string;
  projectRoot: string;
  schema: PluginConfigSchema['schema'];
  stores: {
    user: PluginConfigStore;
    project: PluginConfigStore;
    projectLocal: PluginConfigStore;
  };
  redactedValues: Record<string, PluginConfigValue | '[redacted]'>;
  sources: Record<string, PluginConfigSource>;
  entries: Record<string, ProjectScopedPluginConfigEntryView>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  repoVisibleArtifactConfig: Pick<ResolvedProjectArtifactRenderConfig, 'values' | 'sources' | 'issues' | 'boundaryIssues'>;
}

export interface PluginConfigStoreReceipt {
  pluginName: string;
  scope: Scope;
  path: string;
}

export interface ResetPluginConfigStoreReceipt extends PluginConfigStoreReceipt {
  storeKind: 'user' | 'projectShared' | 'projectLocal';
  existed: boolean;
  deleted: boolean;
}

export interface PluginConfigStoreTarget {
  storeKind: 'user' | 'projectShared' | 'projectLocal';
  path: string;
  projectLayer?: ProjectConfigStoreLayer;
}

export interface RequiredPluginConfigPreflightTarget {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName?: string;
  manifest: PluginManifestSource;
  schemaSourceIdentity?: string;
}

export interface RequiredPluginConfigPreflightResult {
  checked: number;
  prompted: number;
  written: Array<{ pluginName: string; scope: Scope; updatedKeys: string[] }>;
}

export interface PluginConfigFormFieldModel {
  key: string;
  type: PluginConfigSchemaField['type'];
  label: string;
  description?: string;
  required: boolean;
  sensitive: boolean;
  defaultValue?: PluginConfigValue;
  enumValues?: PluginConfigValue[];
  min?: number;
  max?: number;
  configured: boolean;
  currentValue?: PluginConfigValue;
}

export interface PluginConfigFormModel {
  pluginName: string;
  allowedScopes: Scope[];
  initialScope: Scope;
  requiredKeys: string[];
  fields: PluginConfigFormFieldModel[];
}

export interface ResolvedConfigRead {
  pluginName: string;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidence;
  fields: ConfigFieldEntry[];
}

export type ConfigSchemaResolutionCode =
  | 'catalogUnavailable'
  | 'configSchemaUnavailable';

export class PluginConfigSchemaResolutionError extends Error {
  readonly code: ConfigSchemaResolutionCode;
  readonly details?: unknown;

  constructor(code: ConfigSchemaResolutionCode, message: string, details?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'PluginConfigSchemaResolutionError';
    this.code = code;
    this.details = details;
  }
}

export function isPluginConfigSchemaResolutionError(
  error: unknown,
): error is PluginConfigSchemaResolutionError {
  return error instanceof PluginConfigSchemaResolutionError;
}

export class PluginConfigStoreInventoryError extends Error {
  readonly code = 'invalidPluginConfigStore';

  constructor(message: string) {
    super(`invalidPluginConfigStore: ${message}`);
    this.name = 'PluginConfigStoreInventoryError';
  }
}

export interface ResolvedPluginConfigSchemaAccess {
  pluginName: string;
  plugin: PluginMeta | null;
  schema?: ConfigSchemaEvidence;
}

const CONFIG_DIR = 'plugin-config';
const CONFIG_FILE = 'config.json';

interface ConfigDirectoryIdentity {
  dev: number;
  ino: number;
  realPath: string;
}

let atomicConfigBeforeRenameHookForTests:
  | ((targetPath: string, temporaryPath: string) => Promise<void>)
  | undefined;
let atomicConfigAfterRenameHookForTests:
  | ((targetPath: string) => Promise<void>)
  | undefined;
let configFileLockBeforeReleaseHookForTests:
  | ((lockPath: string, attempt: number) => Promise<void>)
  | undefined;

export function setAtomicConfigBeforeRenameHookForTests(
  hook: ((targetPath: string, temporaryPath: string) => Promise<void>) | undefined,
): void {
  atomicConfigBeforeRenameHookForTests = hook;
}

export function setAtomicConfigAfterRenameHookForTests(
  hook: ((targetPath: string) => Promise<void>) | undefined,
): void {
  atomicConfigAfterRenameHookForTests = hook;
}

export function setConfigFileLockBeforeReleaseHookForTests(
  hook: ((lockPath: string, attempt: number) => Promise<void>) | undefined,
): void {
  configFileLockBeforeReleaseHookForTests = hook;
}

function assertConfigPathBoundary(allowedRoot: string, candidatePath: string): {
  root: string;
  candidate: string;
} {
  const root = path.resolve(allowedRoot);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(root, candidate);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Config path escapes its allowed root: ${candidate}`);
  }
  return { root, candidate };
}

async function lstatIfExists(targetPath: string): Promise<fs.Stats | null> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoConfigSymlink(
  allowedRoot: string,
  candidatePath: string,
): Promise<void> {
  const { root, candidate } = assertConfigPathBoundary(allowedRoot, candidatePath);
  const paths = [root];
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  for (const currentPath of paths) {
    const stats = await lstatIfExists(currentPath);
    if (stats?.isSymbolicLink()) {
      throw new Error(`Config path cannot contain a symbolic link: ${currentPath}`);
    }
  }
}

async function inspectConfigReadTarget(
  allowedRoot: string,
  filePath: string,
): Promise<fs.Stats | null> {
  await assertNoConfigSymlink(allowedRoot, filePath);
  const stats = await lstatIfExists(filePath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Config read target must be a regular file: ${filePath}`);
  }
  return stats;
}

async function inspectConfigInventoryStoreRoot(
  boundaryRoot: string,
  storeRoot: string,
): Promise<boolean> {
  const { root, candidate } = assertConfigPathBoundary(
    boundaryRoot,
    path.join(storeRoot, CONFIG_FILE),
  );
  let current = root;
  for (const segment of path.relative(root, path.dirname(candidate)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await lstatIfExists(current);
    if (!stats) return false;
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PluginConfigStoreInventoryError(
        stats.isSymbolicLink()
          ? `Config path cannot contain a symbolic link: ${current}`
          : `Config inventory boundary must be a directory: ${current}`,
      );
    }
  }
  return true;
}

async function readConfigDirectoryIdentity(
  directoryPath: string,
): Promise<ConfigDirectoryIdentity> {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Config parent must be a real directory: ${directoryPath}`);
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    realPath: await fs.realpath(directoryPath),
  };
}

function assertConfigDirectoryStable(
  label: string,
  before: ConfigDirectoryIdentity,
  after: ConfigDirectoryIdentity,
): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.realPath !== after.realPath) {
    throw new Error(`${label} identity changed before atomic config replacement.`);
  }
}

function assertRealConfigBoundary(
  root: ConfigDirectoryIdentity,
  parent: ConfigDirectoryIdentity,
): void {
  const relative = path.relative(root.realPath, parent.realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Config parent realpath escapes its allowed root.');
  }
}

async function prepareConfigFileParent(filePath: string, allowedRoot: string): Promise<void> {
  assertConfigPathBoundary(allowedRoot, filePath);
  await assertNoConfigSymlink(allowedRoot, filePath);
  await fs.ensureDir(path.dirname(filePath));
  await assertNoConfigSymlink(allowedRoot, filePath);
}

export function resolveConfigFileLockPath(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.aw.lock`);
}

async function releaseConfigFileLock(
  lease: ProcessLockLease,
): Promise<unknown | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await configFileLockBeforeReleaseHookForTests?.(lease.lockPath, attempt);
      await lease.release();
      return null;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  }
  try {
    await lease.release();
  } catch {
    // Preserve the first release diagnostic. A final direct retry avoids a hook-created self-lock.
  }
  return lastError;
}

function emitConfigReleaseWarning(message: string): void {
  try {
    process.emitWarning(message, { code: 'AW_CONFIG_LOCK_RELEASE_FAILED' });
  } catch {
    // Diagnostics cannot replace the primary action result or error.
  }
}

export async function withConfigFileLock<T>(options: {
  filePath: string;
  allowedRoot: string;
  action: () => Promise<T>;
}): Promise<T> {
  await prepareConfigFileParent(options.filePath, options.allowedRoot);
  const lockPath = resolveConfigFileLockPath(options.filePath);
  await assertNoConfigSymlink(options.allowedRoot, lockPath);
  const lease = await acquireProcessLock({ lockPath });
  let result: T | undefined;
  let actionError: unknown;
  let actionSucceeded = false;
  const commitContext: ConfigCommitContext = {
    parent: configCommitStorage.getStore(),
    durableCommit: false,
  };
  try {
    await assertNoConfigSymlink(options.allowedRoot, options.filePath);
    result = await configCommitStorage.run(commitContext, options.action);
    actionSucceeded = true;
  } catch (error) {
    actionError = error;
  }

  const releaseError = await releaseConfigFileLock(lease);
  if (!actionSucceeded) {
    if (releaseError) {
      emitConfigReleaseWarning(
        'Config action failed, and its process lock release also failed.',
      );
    }
    throw actionError;
  }
  if (releaseError) {
    if (commitContext.durableCommit) {
      emitConfigReleaseWarning(
        'Config action completed successfully, but its process lock could not be released after 3 attempts. The committed result remains successful; the lock can require process exit or manual recovery before another update.',
      );
    } else {
      throw releaseError;
    }
  }
  return result as T;
}

export async function withPluginConfigTransactionLease<T>(options: {
  sourceId?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
  action: () => Promise<T>;
}): Promise<T> {
  const storePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  return withConfigFileLock({
    filePath: `${storePath}.transaction`,
    allowedRoot,
    action: options.action,
  });
}

export async function atomicReplaceConfigFile(options: {
  filePath: string;
  allowedRoot: string;
  content: string;
  mode?: number;
}): Promise<void> {
  await prepareConfigFileParent(options.filePath, options.allowedRoot);
  const rootPath = path.resolve(options.allowedRoot);
  const parentPath = path.dirname(path.resolve(options.filePath));
  const rootIdentity = await readConfigDirectoryIdentity(rootPath);
  const parentIdentity = await readConfigDirectoryIdentity(parentPath);
  assertRealConfigBoundary(rootIdentity, parentIdentity);

  const currentTarget = await lstatIfExists(options.filePath);
  if (currentTarget && (!currentTarget.isFile() || currentTarget.isSymbolicLink())) {
    throw new Error(`Config target must be a regular file: ${options.filePath}`);
  }
  const temporaryPath = path.join(
    parentPath,
    `.${path.basename(options.filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`,
  );
  assertConfigPathBoundary(options.allowedRoot, temporaryPath);
  let handle: nodeFs.FileHandle | undefined;
  try {
    handle = await nodeFs.open(
      temporaryPath,
      'wx',
      options.mode ?? (currentTarget ? currentTarget.mode & 0o777 : 0o600),
    );
    await handle.writeFile(options.content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    await atomicConfigBeforeRenameHookForTests?.(options.filePath, temporaryPath);
    await assertNoConfigSymlink(options.allowedRoot, options.filePath);
    const currentRootIdentity = await readConfigDirectoryIdentity(rootPath);
    const currentParentIdentity = await readConfigDirectoryIdentity(parentPath);
    assertRealConfigBoundary(currentRootIdentity, currentParentIdentity);
    assertConfigDirectoryStable('Config allowed root', rootIdentity, currentRootIdentity);
    assertConfigDirectoryStable('Config parent', parentIdentity, currentParentIdentity);
    const targetBeforeRename = await lstatIfExists(options.filePath);
    if (targetBeforeRename && (!targetBeforeRename.isFile() || targetBeforeRename.isSymbolicLink())) {
      throw new Error(`Config target must be a regular file: ${options.filePath}`);
    }

    await nodeFs.rename(temporaryPath, options.filePath);
    markConfigDurableCommit();
    // rename is the commit point. Diagnostics and durability work after it are best effort,
    // because reporting failure here would leave the new generation on disk without giving
    // the caller a safe way to restore the old generation.
    await atomicConfigAfterRenameHookForTests?.(options.filePath).catch(() => undefined);
    await (async () => {
      const finalTarget = await fs.lstat(options.filePath);
      if (!finalTarget.isFile() || finalTarget.isSymbolicLink()) {
        throw new Error('Atomic config replacement produced an invalid target.');
      }
      if (await fs.readFile(options.filePath, 'utf8') !== options.content) {
        throw new Error('Atomic config replacement content differs from the committed content.');
      }
    })().catch(() => undefined);
    const directoryHandle = await nodeFs.open(parentPath, 'r').catch(() => null);
    await directoryHandle?.sync().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await nodeFs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicRemoveConfigFile(options: {
  filePath: string;
  allowedRoot: string;
}): Promise<boolean> {
  await prepareConfigFileParent(options.filePath, options.allowedRoot);
  const rootPath = path.resolve(options.allowedRoot);
  const parentPath = path.dirname(path.resolve(options.filePath));
  const rootIdentity = await readConfigDirectoryIdentity(rootPath);
  const parentIdentity = await readConfigDirectoryIdentity(parentPath);
  assertRealConfigBoundary(rootIdentity, parentIdentity);
  const currentTarget = await lstatIfExists(options.filePath);
  if (!currentTarget) return false;
  if (!currentTarget.isFile() || currentTarget.isSymbolicLink()) {
    throw new Error(`Config target must be a regular file: ${options.filePath}`);
  }

  await atomicConfigBeforeRenameHookForTests?.(options.filePath, options.filePath);
  await assertNoConfigSymlink(options.allowedRoot, options.filePath);
  const currentRootIdentity = await readConfigDirectoryIdentity(rootPath);
  const currentParentIdentity = await readConfigDirectoryIdentity(parentPath);
  assertRealConfigBoundary(currentRootIdentity, currentParentIdentity);
  assertConfigDirectoryStable('Config allowed root', rootIdentity, currentRootIdentity);
  assertConfigDirectoryStable('Config parent', parentIdentity, currentParentIdentity);
  const targetBeforeRemove = await lstatIfExists(options.filePath);
  if (!targetBeforeRemove) return false;
  if (!targetBeforeRemove.isFile() || targetBeforeRemove.isSymbolicLink()) {
    throw new Error(`Config target must be a regular file: ${options.filePath}`);
  }

  await nodeFs.unlink(options.filePath);
  markConfigDurableCommit();
  await atomicConfigAfterRenameHookForTests?.(options.filePath).catch(() => undefined);
  const directoryHandle = await nodeFs.open(parentPath, 'r').catch(() => null);
  await directoryHandle?.sync().catch(() => undefined);
  await directoryHandle?.close().catch(() => undefined);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function calculateConfigManifestDigest(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}

async function calculateConfigSchemaManifestDigestForPlugin(
  plugin: PluginMeta,
): Promise<string> {
  if (await lstatIfExists(plugin.manifestPath)) {
    return calculateConfigManifestDigest(plugin.manifestPath);
  }
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(plugin.manifest));
  return `sha256:${hash.digest('hex')}`;
}

function createConfigSchemaEvidenceFromCurrentCatalog(
  plugin: PluginMeta,
  manifestDigest: string,
): ConfigSchemaEvidence {
  return {
    source: 'currentCatalog',
    identity: createPluginConfigSchemaIdentity(plugin.manifest),
    pluginVersion: plugin.manifest.version,
    manifestDigest,
  };
}

function getStoreEntries(values: Record<string, unknown>): Record<string, unknown> {
  return { ...values };
}

export function assertSafePluginConfigSegment(pluginName: string): string {
  if (typeof pluginName !== 'string' || pluginName.trim() === '') {
    throw new Error('Invalid plugin config segment: expected a non-empty plugin name.');
  }

  if (
    pluginName !== pluginName.trim() ||
    pluginName === '.' ||
    pluginName === '..' ||
    pluginName.includes('/') ||
    pluginName.includes('\\') ||
    path.posix.isAbsolute(pluginName) ||
    path.win32.isAbsolute(pluginName) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(pluginName)
  ) {
    throw new Error(`Invalid plugin config segment "${pluginName}".`);
  }

  return pluginName;
}

export function resolveAwProjectRoot(cwd: string): string {
  return path.resolve(resolveRepoRootSync(cwd));
}

function resolvePluginConfigAllowedRoot(options: {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return options.scope === 'user'
    ? resolveAwHome(options.env)
    : path.join(resolveAwProjectRoot(options.cwd), '.agent-workflows');
}

export function resolvePluginConfigStorePath(options: {
  sourceId?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
  access?: PluginConfigStorePathAccess;
}): string {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const sourceId = options.sourceId === undefined
    ? undefined
    : assertSafePluginConfigSegment(options.sourceId);
  const root = options.scope === 'user'
    ? resolveAwHome(options.env)
    : path.join(resolveAwProjectRoot(options.cwd), '.agent-workflows');
  const configDir = options.scope === 'project' && options.projectLayer === 'local'
    ? 'plugin-config.local'
    : CONFIG_DIR;
  const filePath = path.join(root, configDir, ...(sourceId ? [sourceId] : []), pluginName, CONFIG_FILE);

  if (options.scope !== 'project') {
    return filePath;
  }

  if (options.access === 'read') {
    return assertTestReadablePath(
      filePath,
      options.projectLayer === 'local'
        ? 'project local plugin config store (.agent-workflows/plugin-config.local)'
        : 'project shared plugin config store (.agent-workflows/plugin-config)',
      '用 registerReadonlyFixtureRoot() 或 runWithRepositoryCwdAsReadOnly() 登记只读 project fixture 根；需要写入时改用 withSafeTestCwd() 或 registerWritableStateRoot()。',
    );
  }

  if (options.access === 'write') {
    return assertTestWritablePath(
      filePath,
      options.projectLayer === 'local'
        ? 'project local plugin config store (.agent-workflows/plugin-config.local)'
        : 'project shared plugin config store (.agent-workflows/plugin-config)',
      '用 withSafeTestCwd() 切到测试可写 cwd，或通过 registerWritableStateRoot() 登记 project fixture 根。',
    );
  }

  return filePath;
}

export function resolvePluginConfigStoreTargets(options: {
  sourceId?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  access?: PluginConfigStorePathAccess;
}): PluginConfigStoreTarget[] {
  if (options.scope === 'user') {
    return [{
      storeKind: 'user',
      path: resolvePluginConfigStorePath(options),
    }];
  }

  return [
    {
      storeKind: 'projectShared',
      path: resolvePluginConfigStorePath({
        ...options,
        projectLayer: 'shared',
      }),
      projectLayer: 'shared',
    },
    {
      storeKind: 'projectLocal',
      path: resolvePluginConfigStorePath({
        ...options,
        projectLayer: 'local',
      }),
      projectLayer: 'local',
    },
  ];
}

async function readStoreFile(filePath: string): Promise<Record<string, unknown>> {
  const value = await fs.readJson(filePath);
  if (!isRecord(value)) {
    throw new Error(`Invalid plugin config store "${filePath}": expected a JSON object.`);
  }
  return value;
}

async function readNamespacedStoreFile(options: {
  filePath: string;
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
}): Promise<Record<string, unknown>> {
  const raw = await fs.readJson(options.filePath) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 2 || !isRecord(raw.values)) {
    throw new Error(`legacyStateUnsupported: invalid or legacy plugin config store "${options.filePath}".`);
  }
  if (raw.sourceId !== options.sourceId || raw.pluginName !== options.pluginName) {
    throw new Error('Plugin config target identity does not match its namespaced path.');
  }
  if (raw.sourceIdentity !== options.sourceIdentity) {
    throw new Error('sourceChanged: plugin config source identity does not match the configured source.');
  }
  return raw.values;
}

function namespacedConfigContent(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  values: Record<string, unknown>;
}): string {
  if (!options.sourceId) return `${JSON.stringify(options.values, null, 2)}\n`;
  if (!options.sourceIdentity) throw new Error('sourceIdentity is required for namespaced plugin config.');
  const envelope: NamespacedPluginConfigEnvelope = {
    schemaVersion: 2,
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    pluginName: options.pluginName,
    values: options.values,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

async function assertNoLegacyConfigCoexistence(options: {
  sourceId?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<void> {
  if (!options.sourceId) return;
  const legacyPath = resolvePluginConfigStorePath({
    pluginName: options.pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    projectLayer: options.projectLayer,
    ...(options.scope === 'project' ? { access: 'read' as const } : {}),
  });
  if (await lstatIfExists(legacyPath)) {
    throw new Error('legacyStateUnsupported: legacy and namespaced plugin config stores cannot coexist.');
  }
}

async function withUserPluginConfigRuntimeLease<T>(options: {
  sourceId?: string;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
}, action: () => Promise<T>): Promise<T> {
  return options.scope === 'user' || options.sourceId !== undefined
    ? withActiveMarketplaceRuntimeLease(options.env, action)
    : action();
}

export async function readPluginConfigStore(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<PluginConfigStore> {
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'read' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  if (options.sourceId) {
    if (!options.sourceIdentity) throw new Error('sourceIdentity is required for namespaced plugin config.');
    const legacyPath = resolvePluginConfigStorePath({
      pluginName: options.pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      projectLayer: options.projectLayer,
      ...(options.scope === 'project' ? { access: 'read' as const } : {}),
    });
    if (await inspectConfigReadTarget(allowedRoot, legacyPath)) {
      throw new Error('legacyStateUnsupported: legacy and namespaced plugin config stores cannot coexist.');
    }
  }
  if (!await inspectConfigReadTarget(allowedRoot, filePath)) {
    return {
      path: filePath,
      exists: false,
      values: {},
    };
  }

  return {
    path: filePath,
    exists: true,
    values: options.sourceId
      ? await readNamespacedStoreFile({
          filePath,
          sourceId: options.sourceId,
          sourceIdentity: options.sourceIdentity!,
          pluginName: options.pluginName,
        })
      : await readStoreFile(filePath),
  };
}

export async function readNamespacedPluginConfigStoreIdentity(options: {
  sourceId: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<{ sourceIdentity: string; store: PluginConfigStore } | null> {
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'read' as const } : {}),
  });
  if (!await inspectConfigReadTarget(resolvePluginConfigAllowedRoot(options), filePath)) return null;
  const raw = await fs.readJson(filePath) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 2 || !isRecord(raw.values)
    || raw.sourceId !== options.sourceId || raw.pluginName !== options.pluginName
    || typeof raw.sourceIdentity !== 'string') {
    throw new Error('legacyStateUnsupported: invalid namespaced plugin config store.');
  }
  return {
    sourceIdentity: raw.sourceIdentity,
    store: { path: filePath, exists: true, values: raw.values },
  };
}

async function listConfigStoreDirectoryPluginNames(storeRoot: string): Promise<string[]> {
  if (!await lstatIfExists(storeRoot)) {
    return [];
  }

  const entries = await fs.readdir(storeRoot, { withFileTypes: true });
  const pluginNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      throw new PluginConfigStoreInventoryError(
        `Config plugin namespace must be a directory: ${path.join(storeRoot, entry.name)}`,
      );
    }
    let pluginName: string;
    try {
      pluginName = assertSafePluginConfigSegment(entry.name);
    } catch {
      continue;
    }
    if (await lstatIfExists(path.join(storeRoot, pluginName, CONFIG_FILE))) {
      pluginNames.push(pluginName);
    }
  }
  return pluginNames;
}

export async function listPluginConfigStorePluginNames(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope?: Scope;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<string[]> {
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const storeRoots = options.scope === 'user'
    ? [path.join(resolveAwHome(options.env), CONFIG_DIR)]
    : options.scope === 'project'
      ? [path.join(
          projectRoot,
          '.agent-workflows',
          options.projectLayer === 'local' ? 'plugin-config.local' : CONFIG_DIR,
        )]
      : [
          path.join(resolveAwHome(options.env), CONFIG_DIR),
          path.join(projectRoot, '.agent-workflows', CONFIG_DIR),
          path.join(projectRoot, '.agent-workflows', 'plugin-config.local'),
        ];
  const pluginNames = (await Promise.all(
    storeRoots.map((storeRoot) => listConfigStoreDirectoryPluginNames(storeRoot)),
  )).flat();
  return [...new Set(pluginNames)].sort((left, right) =>
    left.localeCompare(right),
  );
}

export interface NamespacedPluginConfigStoreInventoryEntry {
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  pluginId: string;
  values: Record<string, unknown>;
}

export async function listNamespacedPluginConfigStores(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope: Scope;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<NamespacedPluginConfigStoreInventoryEntry[]> {
  const boundaryRoot = options.scope === 'user'
    ? resolveAwHome(options.env)
    : resolveAwProjectRoot(options.cwd);
  if (options.scope === 'user') {
    await canonicalizePathThroughExistingAncestor(boundaryRoot);
  } else {
    await fs.realpath(boundaryRoot);
  }
  const storeRoot = path.join(
    boundaryRoot,
    ...(options.scope === 'project' ? ['.agent-workflows'] : []),
    options.scope === 'project' && options.projectLayer === 'local'
      ? 'plugin-config.local'
      : CONFIG_DIR,
  );
  const output: NamespacedPluginConfigStoreInventoryEntry[] = [];
  if (!await inspectConfigInventoryStoreRoot(boundaryRoot, storeRoot)) return output;
  for (const sourceEntry of await fs.readdir(storeRoot, { withFileTypes: true })) {
    if (!sourceEntry.isDirectory()) {
      throw new PluginConfigStoreInventoryError(sourceEntry.isSymbolicLink()
        ? `Config path cannot contain a symbolic link: ${path.join(storeRoot, sourceEntry.name)}`
        : `Config source namespace must be a directory: ${path.join(storeRoot, sourceEntry.name)}`);
    }
    const sourceId = assertSafePluginConfigSegment(sourceEntry.name);
    const sourceRoot = path.join(storeRoot, sourceId);
    for (const pluginEntry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
      if (!pluginEntry.isDirectory()) {
        throw new PluginConfigStoreInventoryError(pluginEntry.isSymbolicLink()
          ? `Config path cannot contain a symbolic link: ${path.join(sourceRoot, pluginEntry.name)}`
          : `Config plugin namespace must be a directory: ${path.join(sourceRoot, pluginEntry.name)}`);
      }
      const pluginName = assertSafePluginConfigSegment(pluginEntry.name);
      const filePath = path.join(storeRoot, sourceId, pluginName, CONFIG_FILE);
      if (!await inspectConfigReadTarget(storeRoot, filePath)) continue;
      const raw = await fs.readJson(filePath) as unknown;
      if (!isRecord(raw) || raw.schemaVersion !== 2 || !isRecord(raw.values)
        || raw.sourceId !== sourceId || raw.pluginName !== pluginName
        || typeof raw.sourceIdentity !== 'string') {
        throw new Error(`legacyStateUnsupported: invalid namespaced plugin config store "${filePath}".`);
      }
      output.push({
        sourceId,
        sourceIdentity: raw.sourceIdentity,
        pluginName,
        pluginId: `${sourceId}/${pluginName}`,
        values: raw.values,
      });
    }
  }
  return output.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export async function writePluginConfigStore(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  values: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<PluginConfigStoreReceipt> {
  await assertNoLegacyConfigCoexistence(options);
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  await withUserPluginConfigRuntimeLease(options, async () => {
    await withConfigFileLock({
      filePath,
      allowedRoot,
      action: async () => atomicReplaceConfigFile({
        filePath,
        allowedRoot,
        content: namespacedConfigContent(options),
        mode: 0o600,
      }),
    });
  });

  return {
    pluginName: options.pluginName,
    scope: options.scope,
    path: filePath,
  };
}

export async function patchPluginConfigStore(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  updates: Record<string, unknown>;
  removeKeys?: string[];
  requireExistingRemoveKeys?: boolean;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
  reviewPreflight?: () => Promise<void> | void;
}): Promise<PluginConfigStoreReceipt & { updatedKeys: string[]; removedKeys: string[] }> {
  await assertNoLegacyConfigCoexistence(options);
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const removedKeys = options.removeKeys ?? [];
  await withUserPluginConfigRuntimeLease(options, async () => {
    await withConfigFileLock({
      filePath,
      allowedRoot,
      action: async () => {
        await options.reviewPreflight?.();
        const current = (await lstatIfExists(filePath))
          ? options.sourceId
            ? await readNamespacedStoreFile({
                filePath,
                sourceId: options.sourceId,
                sourceIdentity: options.sourceIdentity!,
                pluginName: options.pluginName,
              })
            : await readStoreFile(filePath)
          : {};
        if (options.requireExistingRemoveKeys) {
          const missingKey = removedKeys.find((key) => !Object.hasOwn(current, key));
          if (missingKey) throw new Error(`Unknown config key "${missingKey}".`);
        }
        const next = { ...current };
        for (const key of removedKeys) {
          delete next[key];
        }
        for (const [key, value] of Object.entries(options.updates)) {
          next[key] = value;
        }
        await atomicReplaceConfigFile({
          filePath,
          allowedRoot,
          content: namespacedConfigContent({ ...options, values: next }),
          mode: 0o600,
        });
      },
    });
  });

  return {
    pluginName: options.pluginName,
    scope: options.scope,
    path: filePath,
    updatedKeys: Object.keys(options.updates),
    removedKeys,
  };
}

export async function resetPluginConfigStore(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
  reviewPreflight?: () => Promise<void> | void;
}): Promise<ResetPluginConfigStoreReceipt> {
  await assertNoLegacyConfigCoexistence(options);
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const existed = await withUserPluginConfigRuntimeLease(options, async () => {
    return withConfigFileLock({
      filePath,
      allowedRoot,
      action: async () => {
        await options.reviewPreflight?.();
        const target = await lstatIfExists(filePath);
        if (!target) return false;
        if (!target.isFile() || target.isSymbolicLink()) {
          throw new Error(`Config target must be a regular file: ${filePath}`);
        }
        if (options.sourceId) {
          if (!options.sourceIdentity) {
            throw new Error('sourceIdentity is required for namespaced plugin config.');
          }
          await readNamespacedStoreFile({
            filePath,
            sourceId: options.sourceId,
            sourceIdentity: options.sourceIdentity,
            pluginName: options.pluginName,
          });
        } else {
          await readStoreFile(filePath);
        }
        return atomicRemoveConfigFile({ filePath, allowedRoot });
      },
    });
  });

  return {
    pluginName: options.pluginName,
    scope: options.scope,
    storeKind: options.scope === 'user'
      ? 'user'
      : options.projectLayer === 'local'
        ? 'projectLocal'
        : 'projectShared',
    path: filePath,
    existed,
    deleted: existed,
  };
}

export async function resetPluginConfigStores(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResetPluginConfigStoreReceipt[]> {
  await assertNoLegacyConfigCoexistence(options);
  const targets = resolvePluginConfigStoreTargets({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const receipts: ResetPluginConfigStoreReceipt[] = [];
  await withUserPluginConfigRuntimeLease(options, async () => {
    const withTargetLocks = async (index: number, action: () => Promise<void>): Promise<void> => {
      const target = targets[index];
      if (!target) return action();
      return withConfigFileLock({
        filePath: target.path,
        allowedRoot,
        action: () => withTargetLocks(index + 1, action),
      });
    };
    await withTargetLocks(0, async () => {
      const existing: boolean[] = [];
      for (const target of targets) {
        const stats = await lstatIfExists(target.path);
        existing.push(stats !== null);
        if (!stats) continue;
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`Config target must be a regular file: ${target.path}`);
        }
        if (options.sourceId) {
          if (!options.sourceIdentity) {
            throw new Error('sourceIdentity is required for namespaced plugin config.');
          }
          await readNamespacedStoreFile({
            filePath: target.path,
            sourceId: options.sourceId,
            sourceIdentity: options.sourceIdentity,
            pluginName: options.pluginName,
          });
        } else {
          await readStoreFile(target.path);
        }
      }
      for (const [index, target] of targets.entries()) {
        const deleted = await atomicRemoveConfigFile({
          filePath: target.path,
          allowedRoot,
        });
        receipts.push({
          pluginName: options.pluginName,
          scope: options.scope,
          storeKind: target.storeKind,
          path: target.path,
          existed: existing[index]!,
          deleted,
        });
      }
    });
  });
  return receipts;
}

function coercePrimitiveValue(
  key: string,
  field: PluginConfigSchemaField,
  value: unknown,
): PluginConfigValue {
  if (field.type === 'string') {
    if (typeof value !== 'string') {
      throw new Error(`Config "${key}" must be a string.`);
    }
    return value;
  }

  if (field.type === 'number') {
    const numberValue = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numberValue)) {
      throw new Error(`Config "${key}" must be a number.`);
    }
    if (field.min !== undefined && numberValue < field.min) {
      throw new Error(`Config "${key}" must be greater than or equal to ${field.min}.`);
    }
    if (field.max !== undefined && numberValue > field.max) {
      throw new Error(`Config "${key}" must be less than or equal to ${field.max}.`);
    }
    return numberValue;
  }

  if (field.type === 'boolean') {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'no', 'n'].includes(normalized)) {
        return false;
      }
    }
    throw new Error(`Config "${key}" must be a boolean.`);
  }

  if (field.type === 'enum') {
    if (typeof value !== 'string') {
      throw new Error(`Config "${key}" must be an enum string.`);
    }
    if (!field.values?.includes(value)) {
      throw new Error(`Config "${key}" must be one of: ${(field.values ?? []).join(', ')}.`);
    }
    return value;
  }

  if (field.type === 'file' || field.type === 'directory') {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Config "${key}" must be a path string.`);
    }
    return value;
  }

  throw new Error(`Config "${key}" has unsupported type "${field.type}".`);
}

async function resolvePathConfigValue(options: {
  key: string;
  field: PluginConfigSchemaField;
  value: PluginConfigValue;
  projectRoot: string;
}): Promise<string> {
  if (options.field.type !== 'file' && options.field.type !== 'directory') {
    return String(options.value);
  }

  const rawPath = String(options.value);
  const resolvedPath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(options.projectRoot, rawPath);
  const realPath = await fs.realpath(resolvedPath);
  const stats = await fs.stat(realPath);
  if (options.field.type === 'file' && !stats.isFile()) {
    throw new Error(`Config "${options.key}" must point to an existing file.`);
  }
  if (options.field.type === 'directory' && !stats.isDirectory()) {
    throw new Error(`Config "${options.key}" must point to an existing directory.`);
  }

  return realPath;
}

export async function coercePluginConfigValue(options: {
  key: string;
  field: PluginConfigSchemaField;
  value: unknown;
  projectRoot: string;
}): Promise<PluginConfigValue> {
  const primitive = coercePrimitiveValue(options.key, options.field, options.value);
  if (options.field.type === 'file' || options.field.type === 'directory') {
    return resolvePathConfigValue({
      key: options.key,
      field: options.field,
      value: primitive,
      projectRoot: options.projectRoot,
    });
  }

  return primitive;
}

function redactValue(
  field: PluginConfigSchemaField,
  value: PluginConfigValue,
): PluginConfigValue | '[redacted]' {
  return field.sensitive ? '[redacted]' : value;
}

function sourceForStoreLayer(
  scope: Scope,
  projectLayer: ProjectConfigStoreLayer = 'shared',
): Exclude<PluginConfigSource, 'default' | 'missing'> {
  if (scope === 'user') {
    return 'user';
  }
  return projectLayer === 'local' ? 'projectLocal' : 'project';
}

function isPathTypeField(field: PluginConfigSchemaField): boolean {
  return field.type === 'file' || field.type === 'directory';
}

async function applyConfigLayer(options: {
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, PluginConfigValue | '[redacted]'>;
  sources: Record<string, PluginConfigSource>;
  invalidIssues: Map<string, PluginConfigIssue>;
  schema: PluginConfigSchema['schema'];
  entries: Record<string, unknown>;
  source: PluginConfigSource;
  projectRoot: string;
}): Promise<void> {
  for (const [key, field] of Object.entries(options.schema)) {
    if (!Object.hasOwn(options.entries, key)) {
      continue;
    }

    try {
      const coerced = await coercePluginConfigValue({
        key,
        field,
        value: options.entries[key],
        projectRoot: options.projectRoot,
      });
      options.values[key] = coerced;
      options.redactedValues[key] = redactValue(field, coerced);
      options.sources[key] = options.source;
      options.invalidIssues.delete(key);
    } catch (error) {
      delete options.values[key];
      delete options.redactedValues[key];
      options.sources[key] = options.source;
      options.invalidIssues.set(key, {
        type: 'invalid-config',
        key,
        source: options.source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function resolveEffectivePluginConfig(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName?: string;
  manifest: PluginManifestSource;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedEffectivePluginConfig> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
  const schema = options.manifest.config?.schema;
  if (!schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }

  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [userStore, projectStore, projectLocalStore] = await Promise.all([
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
      projectLayer: 'local',
    }),
  ]);

  const values: Record<string, PluginConfigValue> = {};
  const redactedValues: Record<string, PluginConfigValue | '[redacted]'> = {};
  const sources: Record<string, PluginConfigSource> = {};
  const invalidIssues = new Map<string, PluginConfigIssue>();
  const ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[] = [];
  const schemaKeys = new Set(Object.keys(schema));

  for (const key of schemaKeys) {
    sources[key] = 'missing';
  }

  for (const [key, field] of Object.entries(schema)) {
    if (field.default === undefined) {
      continue;
    }
    await applyConfigLayer({
      values,
      redactedValues,
      sources,
      invalidIssues,
      schema: { [key]: field },
      entries: { [key]: field.default },
      source: 'default',
      projectRoot,
    });
  }

  for (const [scope, store, projectLayer] of [
    ['user', userStore, 'shared'],
    ['project', projectStore, 'shared'],
    ['project', projectLocalStore, 'local'],
  ] as const) {
    const plainEntries = getStoreEntries(store.values);
    for (const key of Object.keys(plainEntries)) {
      if (!schemaKeys.has(key)) {
        ignoredUnknownKeys.push({
          scope,
          projectLayer,
          source: sourceForStoreLayer(scope, projectLayer),
          key,
        });
      }
    }
    await applyConfigLayer({
      values,
      redactedValues,
      sources,
      invalidIssues,
      schema,
      entries: plainEntries,
      source: sourceForStoreLayer(scope, projectLayer),
      projectRoot,
    });
  }

  const issues = [...invalidIssues.values()];
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && values[key] === undefined) {
      issues.push({
        type: 'missing-required',
        key,
        source: sources[key],
        message: `Config "${key}" is required.`,
      });
    }
  }

  return {
    pluginName,
    projectRoot,
    values,
    redactedValues,
    sources,
    issues,
    ignoredUnknownKeys,
    schema,
    stores: {
      user: userStore,
      project: projectStore,
      projectLocal: projectLocalStore,
    },
  };
}

export async function coercePluginConfigUpdates(options: {
  schema: PluginConfigSchema['schema'];
  updates: Record<string, unknown>;
  cwd: string;
}): Promise<Record<string, PluginConfigValue>> {
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const output: Record<string, PluginConfigValue> = {};

  for (const [key, value] of Object.entries(options.updates)) {
    const field = options.schema[key];
    if (!field) {
      throw new Error(`Unknown config key "${key}".`);
    }
    output[key] = await coercePluginConfigValue({
      key,
      field,
      value,
      projectRoot,
    });
  }

  return output;
}

function createProjectArtifactBoundaryIssue(options: {
  key: string;
  source: PluginConfigSource;
  reason: ProjectArtifactConfigBoundaryIssue['reason'];
}): ProjectArtifactConfigBoundaryIssue {
  if (options.reason === 'pathTypeDefault') {
    return {
      key: options.key,
      source: options.source,
      reason: options.reason,
      message:
        `Config "${options.key}" uses file/directory default value, ` +
        'which cannot participate in repo-visible project artifact truth.',
    };
  }
  if (options.reason === 'pathTypeRequired') {
    return {
      key: options.key,
      source: options.source,
      reason: options.reason,
      message:
        `Config "${options.key}" is a required file/directory key, ` +
        'which is not portable enough for repo-visible project artifacts.',
    };
  }
  if (options.reason === 'sharedPathValue') {
    return {
      key: options.key,
      source: options.source,
      reason: options.reason,
      message:
        `Config "${options.key}" is stored in project shared config as a file/directory path. ` +
        'Use user or project local config for machine-local paths.',
    };
  }
  return {
    key: options.key,
    source: options.source,
    reason: options.reason,
    message:
      `Config "${options.key}" is declared as a refresh key for repo-visible project artifacts, ` +
      'but file/directory config is machine-local and cannot drive shared artifact refresh.',
  };
}

export function collectProjectArtifactConfigBoundaryIssues(options: {
  schema: PluginConfigSchema['schema'];
  sharedEntries?: Record<string, unknown>;
  refreshKeys?: readonly string[];
}): ProjectArtifactConfigBoundaryIssue[] {
  const issues: ProjectArtifactConfigBoundaryIssue[] = [];
  const refreshKeySet = new Set(options.refreshKeys ?? []);

  for (const [key, field] of Object.entries(options.schema)) {
    if (!isPathTypeField(field)) {
      continue;
    }
    if (field.default !== undefined) {
      issues.push(createProjectArtifactBoundaryIssue({
        key,
        source: 'default',
        reason: 'pathTypeDefault',
      }));
    }
    if (field.required) {
      issues.push(createProjectArtifactBoundaryIssue({
        key,
        source: 'missing',
        reason: 'pathTypeRequired',
      }));
    }
    if (options.sharedEntries && Object.hasOwn(options.sharedEntries, key)) {
      issues.push(createProjectArtifactBoundaryIssue({
        key,
        source: 'project',
        reason: 'sharedPathValue',
      }));
    }
    if (refreshKeySet.has(key)) {
      issues.push(createProjectArtifactBoundaryIssue({
        key,
        source: 'project',
        reason: 'pathTypeRefreshKey',
      }));
    }
  }

  return issues;
}

export async function resolveProjectArtifactRenderConfig(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName?: string;
  manifest: PluginManifestSource;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  refreshKeys?: readonly string[];
}): Promise<ResolvedProjectArtifactRenderConfig> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
  const schema = options.manifest.config?.schema;
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [userStore, projectStore, projectLocalStore] = await Promise.all([
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
      projectLayer: 'local',
    }),
  ]);

  if (!schema) {
    return {
      pluginName,
      projectRoot,
      values: {},
      sources: {},
      issues: [],
      ignoredUnknownKeys: [],
      boundaryIssues: [],
      schema: {},
      stores: {
        user: userStore,
        project: projectStore,
        projectLocal: projectLocalStore,
      },
    };
  }

  const values: Record<string, PluginConfigValue> = {};
  const sources: Record<string, PluginConfigSource> = {};
  const invalidIssues = new Map<string, PluginConfigIssue>();
  const ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[] = [];
  const schemaKeys = new Set(Object.keys(schema));
  const boundaryIssues = collectProjectArtifactConfigBoundaryIssues({
    schema,
    sharedEntries: projectStore.values,
    refreshKeys: options.refreshKeys,
  });

  for (const key of Object.keys(schema)) {
    sources[key] = 'missing';
  }

  const projectPlainEntries = getStoreEntries(projectStore.values);
  const userPlainEntries = getStoreEntries(userStore.values);
  const projectLocalPlainEntries = getStoreEntries(projectLocalStore.values);

  for (const key of Object.keys(projectPlainEntries)) {
    if (!schemaKeys.has(key)) {
      ignoredUnknownKeys.push({ scope: 'project', projectLayer: 'shared', source: 'project', key });
    }
  }
  for (const key of Object.keys(userPlainEntries)) {
    if (!schemaKeys.has(key)) {
      ignoredUnknownKeys.push({ scope: 'user', projectLayer: 'shared', source: 'user', key });
    }
  }
  for (const key of Object.keys(projectLocalPlainEntries)) {
    if (!schemaKeys.has(key)) {
      ignoredUnknownKeys.push({ scope: 'project', projectLayer: 'local', source: 'projectLocal', key });
    }
  }

  for (const [key, field] of Object.entries(schema)) {
    if (!isPathTypeField(field) && field.default !== undefined) {
      await applyConfigLayer({
        values,
        redactedValues: {},
        sources,
        invalidIssues,
        schema: { [key]: field },
        entries: { [key]: field.default },
        source: 'default',
        projectRoot,
      });
    }
  }

  const sharedSchema = Object.fromEntries(
    Object.entries(schema).filter(([, field]) => !isPathTypeField(field)),
  );
  await applyConfigLayer({
    values,
    redactedValues: {},
    sources,
    invalidIssues,
    schema: sharedSchema,
    entries: projectPlainEntries,
    source: 'project',
    projectRoot,
  });

  const issues = [
    ...invalidIssues.values(),
    ...boundaryIssues.map((issue) => ({
      type: 'invalid-config' as const,
      key: issue.key,
      source: issue.source,
      message: issue.message,
    })),
  ];
  for (const [key, field] of Object.entries(schema)) {
    if (isPathTypeField(field)) {
      continue;
    }
    if (field.required && values[key] === undefined) {
      issues.push({
        type: 'missing-required',
        key,
        source: sources[key],
        message: `Config "${key}" is required.`,
      });
    }
  }

  return {
    pluginName,
    projectRoot,
    values,
    sources,
    issues,
    ignoredUnknownKeys,
    boundaryIssues,
    schema,
    stores: {
      user: userStore,
      project: projectStore,
      projectLocal: projectLocalStore,
    },
  };
}

export async function resolveProjectLocalPluginConfigView(options: {
  pluginName?: string;
  manifest: PluginManifestSource;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  pluginName: string;
  projectRoot: string;
  schema: PluginConfigSchema['schema'];
  localStore: PluginConfigStore;
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, PluginConfigValue | '[redacted]'>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  repoVisibleArtifactConfig: Pick<ResolvedProjectArtifactRenderConfig, 'values' | 'sources' | 'issues' | 'boundaryIssues'>;
}> {
  const effective = await resolveEffectivePluginConfig(options);
  const artifactConfig = await resolveProjectArtifactRenderConfig(options);
  const values: Record<string, PluginConfigValue> = {};
  const redactedValues: Record<string, PluginConfigValue | '[redacted]'> = {};
  const sources: Record<string, PluginConfigSource> = {};
  const issues: PluginConfigIssue[] = [];

  for (const [key, field] of Object.entries(effective.schema)) {
    sources[key] = 'missing';
    const localPlainEntries = getStoreEntries(effective.stores.projectLocal.values);
    if (!Object.hasOwn(localPlainEntries, key)) {
      continue;
    }
    sources[key] = 'projectLocal';
    try {
      const coerced = await coercePluginConfigValue({
        key,
        field,
        value: localPlainEntries[key],
        projectRoot: effective.projectRoot,
      });
      values[key] = coerced;
      redactedValues[key] = redactValue(field, coerced);
    } catch (error) {
      issues.push({
        type: 'invalid-config',
        key,
        source: 'projectLocal',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    pluginName: effective.pluginName,
    projectRoot: effective.projectRoot,
    schema: effective.schema,
    localStore: effective.stores.projectLocal,
    values,
    redactedValues,
    sources,
    issues,
    ignoredUnknownKeys: effective.ignoredUnknownKeys.filter((entry) => entry.source === 'projectLocal'),
    repoVisibleArtifactConfig: {
      values: artifactConfig.values,
      sources: artifactConfig.sources,
      issues: artifactConfig.issues,
      boundaryIssues: artifactConfig.boundaryIssues,
    },
  };
}

async function resolveRedactedLayerValue(options: {
  key: string;
  field: PluginConfigSchemaField;
  projectRoot: string;
  source: PluginConfigSource;
  value: unknown;
}): Promise<{
  value?: PluginConfigValue | '[redacted]';
  issue?: PluginConfigIssue;
}> {
  try {
    const coerced = await coercePluginConfigValue({
      key: options.key,
      field: options.field,
      value: options.value,
      projectRoot: options.projectRoot,
    });
    return {
      value: redactValue(options.field, coerced),
    };
  } catch (error) {
    return {
      issue: {
        type: 'invalid-config',
        key: options.key,
        source: options.source,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function resolveProjectScopedPluginConfigView(options: {
  pluginName?: string;
  manifest: PluginManifestSource;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedProjectScopedPluginConfigView> {
  const effective = await resolveEffectivePluginConfig(options);
  const artifactConfig = await resolveProjectArtifactRenderConfig(options);
  const entries: Record<string, ProjectScopedPluginConfigEntryView> = {};

  for (const [key, field] of Object.entries(effective.schema)) {
    const entry: ProjectScopedPluginConfigEntryView = {
      key,
      effectiveValue: effective.redactedValues[key],
      effectiveSource: effective.sources[key] ?? 'missing',
      repoVisibleArtifactValue: artifactConfig.values[key] === undefined
        ? undefined
        : redactValue(field, artifactConfig.values[key]!),
      repoVisibleArtifactSource: artifactConfig.sources[key] ?? 'missing',
      repoVisibleArtifactUsesSharedTruth: true,
    };

    if (field.default !== undefined) {
      const resolvedDefault = await resolveRedactedLayerValue({
        key,
        field,
        projectRoot: effective.projectRoot,
        source: 'default',
        value: field.default,
      });
      if (resolvedDefault.value !== undefined) {
        entry.defaultValue = resolvedDefault.value;
      }
    }

    const userPlainEntries = getStoreEntries(effective.stores.user.values);
    if (Object.hasOwn(userPlainEntries, key)) {
      const resolvedUser = await resolveRedactedLayerValue({
        key,
        field,
        projectRoot: effective.projectRoot,
        source: 'user',
        value: userPlainEntries[key],
      });
      if (resolvedUser.value !== undefined) {
        entry.userValue = resolvedUser.value;
      }
    }

    const projectPlainEntries = getStoreEntries(effective.stores.project.values);
    if (Object.hasOwn(projectPlainEntries, key)) {
      const resolvedProject = await resolveRedactedLayerValue({
        key,
        field,
        projectRoot: effective.projectRoot,
        source: 'project',
        value: projectPlainEntries[key],
      });
      if (resolvedProject.value !== undefined) {
        entry.projectSharedValue = resolvedProject.value;
      }
    }

    const localPlainEntries = getStoreEntries(effective.stores.projectLocal.values);
    if (Object.hasOwn(localPlainEntries, key)) {
      const resolvedLocal = await resolveRedactedLayerValue({
        key,
        field,
        projectRoot: effective.projectRoot,
        source: 'projectLocal',
        value: localPlainEntries[key],
      });
      if (resolvedLocal.value !== undefined) {
        entry.projectLocalValue = resolvedLocal.value;
      }
    }

    entries[key] = entry;
  }

  return {
    pluginName: effective.pluginName,
    projectRoot: effective.projectRoot,
    schema: effective.schema,
    stores: effective.stores,
    redactedValues: effective.redactedValues,
    sources: effective.sources,
    entries,
    issues: effective.issues,
    ignoredUnknownKeys: effective.ignoredUnknownKeys,
    repoVisibleArtifactConfig: {
      values: artifactConfig.values,
      sources: artifactConfig.sources,
      issues: artifactConfig.issues,
      boundaryIssues: artifactConfig.boundaryIssues,
    },
  };
}

function toConfigSourceLayer(
  source: PluginConfigSource | undefined,
): ConfigFieldEntry['sourceLayer'] {
  if (source === 'default') {
    return 'default';
  }
  if (source === 'user') {
    return 'user';
  }
  if (source === 'project') {
    return 'project';
  }
  if (source === 'projectLocal') {
    return 'local';
  }
  return null;
}

async function buildManifestFieldEntries(options: {
  plugin: PluginMeta;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntry[]> {
  const schema = options.plugin.manifest.config?.schema;
  if (!schema) {
    return [];
  }

  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [userStore, projectStore, projectLocalStore] = await Promise.all([
    readPluginConfigStore({
      sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity,
      pluginName: options.plugin.manifest.name,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity,
      pluginName: options.plugin.manifest.name,
      scope: 'project',
      projectLayer: 'shared',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity,
      pluginName: options.plugin.manifest.name,
      scope: 'project',
      projectLayer: 'local',
      cwd: options.cwd,
      env: options.env,
    }),
  ]);
  const userPlainEntries = getStoreEntries(userStore.values);
  const projectPlainEntries = getStoreEntries(projectStore.values);
  const localPlainEntries = getStoreEntries(projectLocalStore.values);
  const effective = await resolveEffectivePluginConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });

  const fields: ConfigFieldEntry[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const base: ConfigFieldEntry = {
      key,
      title: field.title ?? key,
      kind: 'manifest',
      reserved: false,
      writable: true,
      valueState: 'default',
      effectiveValue: null,
      sourceLayer: null,
    };

    if (options.scope === 'user') {
      if (Object.hasOwn(userPlainEntries, key)) {
        try {
          const value = await coercePluginConfigValue({
            key,
            field,
            value: userPlainEntries[key],
            projectRoot,
          });
          fields.push({
            ...base,
            valueState: 'configured',
            effectiveValue: redactValue(field, value),
            sourceLayer: 'user',
            storedValue: redactValue(field, value),
            storedSourceLayer: 'user',
          });
        } catch {
          fields.push({
            ...base,
            valueState: 'invalid',
            sourceLayer: 'user',
          });
        }
        continue;
      }
      if (field.default !== undefined) {
        try {
          const value = await coercePluginConfigValue({
            key,
            field,
            value: field.default,
            projectRoot,
          });
          fields.push({
            ...base,
            effectiveValue: redactValue(field, value),
            sourceLayer: 'default',
          });
        } catch {
          fields.push({
            ...base,
            valueState: 'invalid',
            sourceLayer: 'default',
          });
        }
        continue;
      }
      fields.push(base);
      continue;
    }

    if (options.projectLayer === 'local') {
      if (Object.hasOwn(localPlainEntries, key)) {
        try {
          const value = await coercePluginConfigValue({
            key,
            field,
            value: localPlainEntries[key],
            projectRoot,
          });
          fields.push({
            ...base,
            valueState: 'configured',
            effectiveValue: redactValue(field, value),
            sourceLayer: 'local',
            storedValue: redactValue(field, value),
            storedSourceLayer: 'local',
          });
        } catch {
          fields.push({
            ...base,
            valueState: 'invalid',
            sourceLayer: 'local',
          });
        }
      } else {
        fields.push(base);
      }
      continue;
    }

    let storedProjectValue: {
      storedValue: PluginConfigValue | '[redacted]';
      storedSourceLayer: 'project';
    } | undefined;
    if (options.scope === 'project' && Object.hasOwn(projectPlainEntries, key)) {
      try {
        const value = await coercePluginConfigValue({
          key,
          field,
          value: projectPlainEntries[key],
          projectRoot,
        });
        storedProjectValue = {
          storedValue: redactValue(field, value),
          storedSourceLayer: 'project',
        };
      } catch {
        storedProjectValue = undefined;
      }
    }

    const source = effective.sources[key];
    const layer = toConfigSourceLayer(source);
    if (source === 'default') {
      fields.push({
        ...base,
        effectiveValue: effective.redactedValues[key] ?? null,
        sourceLayer: 'default',
        ...storedProjectValue,
      });
      continue;
    }
    if (source === 'user' || source === 'project' || source === 'projectLocal') {
      const issue = effective.issues.find((entry) => entry.key === key && entry.source === source);
      fields.push({
        ...base,
        valueState: issue ? 'invalid' : 'configured',
        effectiveValue: issue ? null : effective.redactedValues[key] ?? null,
        sourceLayer: layer,
        ...storedProjectValue,
      });
      continue;
    }
    fields.push({ ...base, ...storedProjectValue });
  }

  return fields;
}

async function buildLegacyStoreFieldEntries(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntry[]> {
  const locations = options.scope === 'effective'
    ? [
        { scope: 'user' as const, projectLayer: 'shared' as const, sourceLayer: 'user' as const },
        { scope: 'project' as const, projectLayer: 'shared' as const, sourceLayer: 'project' as const },
        { scope: 'project' as const, projectLayer: 'local' as const, sourceLayer: 'local' as const },
      ]
    : [{
        scope: options.scope,
        projectLayer: options.projectLayer,
        sourceLayer: options.scope === 'user'
          ? 'user' as const
          : options.projectLayer === 'local' ? 'local' as const : 'project' as const,
      }];
  const fields = new Map<string, ConfigFieldEntry>();
  for (const location of locations) {
    const store = await readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName: options.pluginName,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectLayer: location.projectLayer } : {}),
      cwd: options.cwd,
      env: options.env,
    });
    for (const key of Object.keys(store.values)) {
      fields.set(key, {
        key,
        title: key,
        kind: 'manifest',
        reserved: false,
        writable: false,
        valueState: 'configured',
        effectiveValue: '[redacted]',
        sourceLayer: location.sourceLayer,
      });
    }
  }
  return [...fields.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export async function resolvePluginConfigSchemaAccess(options: {
  pluginName: string;
  currentPlugin?: PluginMeta | null;
  currentPluginError?: Error | null;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedPluginConfigSchemaAccess> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  if (options.currentPluginError) {
    throw options.currentPluginError;
  }

  if (!options.currentPlugin) {
    return {
      pluginName,
      plugin: null,
    };
  }

  return {
    pluginName,
    plugin: options.currentPlugin,
    schema: createConfigSchemaEvidenceFromCurrentCatalog(
      options.currentPlugin,
      await calculateConfigSchemaManifestDigestForPlugin(options.currentPlugin),
    ),
  };
}

export async function resolveConfigRead(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedConfigRead> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    currentPluginError: options.pluginError,
    scope: options.scope,
    projectLayer: options.projectLayer,
    cwd: options.cwd,
    env: options.env,
  });


  const manifestFields = schemaAccess.plugin
    ? await buildManifestFieldEntries({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        projectLayer: options.projectLayer,
        cwd: options.cwd,
        env: options.env,
      })
    : await buildLegacyStoreFieldEntries({
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        pluginName,
        scope: options.scope,
        projectLayer: options.projectLayer,
        cwd: options.cwd,
        env: options.env,
      });

  return {
    pluginName,
    scope: options.scope,
    projectLayer: options.projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    fields: manifestFields,
  };
}

export function findConfigFieldEntry(
  fields: ConfigFieldEntry[],
  key: string,
): ConfigFieldEntry | null {
  return fields.find((field) => field.key === key) ?? null;
}

export function hasConfigReadContent(result: ResolvedConfigRead): boolean {
  return result.fields.length > 0;
}

export function summarizeEffectivePluginConfig(
  config: ResolvedEffectivePluginConfig,
): {
  values: Record<string, PluginConfigValue | '[redacted]'>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
} {
  return {
    values: config.redactedValues,
    sources: config.sources,
    issues: config.issues,
    ignoredUnknownKeys: config.ignoredUnknownKeys,
  };
}

export function createPluginConfigSchemaIdentity(
  manifest: PluginManifestSource,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      config: manifest.config ?? null,
    }))
    .digest('hex');
  return `${manifest.name}:${hash}`;
}

export function toCliConfigPromptSchema(schema: PluginConfigSchema['schema']): CliConfigPromptSchema {
  const promptSchema: CliConfigPromptSchema = {};
  for (const [key, field] of Object.entries(schema)) {
    promptSchema[key] = {
      type: field.type === 'enum' ? 'string' : field.type,
      label: field.title ?? key,
      description: field.description,
      required: field.required,
      sensitive: field.sensitive,
      default: field.default,
      enum: field.type === 'enum' ? field.values : undefined,
      min: field.min,
      max: field.max,
    };
  }
  return promptSchema;
}

export function createPluginConfigFormModel(options: {
  pluginName?: string;
  manifest: PluginManifestSource;
  effective: ResolvedEffectivePluginConfig;
  initialScope: Scope;
  allowedScopes?: Scope[];
}): PluginConfigFormModel {
  const schema = options.manifest.config?.schema;
  if (!schema) {
    throw new Error(`Plugin "${options.pluginName ?? options.manifest.name}" does not declare an AW config schema.`);
  }

  const requiredKeys = [...new Set(
    options.effective.issues
      .filter((issue) => issue.type === 'missing-required' || issue.type === 'invalid-config')
      .map((issue) => issue.key),
  )];

  return {
    pluginName: options.pluginName ?? options.manifest.name,
    allowedScopes: options.allowedScopes ?? ['user', 'project'],
    initialScope: options.initialScope,
    requiredKeys,
    fields: Object.entries(schema).map(([key, field]) => ({
      key,
      type: field.type,
      label: field.title ?? key,
      description: field.description,
      required: field.required === true,
      sensitive: field.sensitive === true,
      defaultValue: field.default as PluginConfigValue | undefined,
      enumValues: field.type === 'enum' ? field.values : undefined,
      min: field.min,
      max: field.max,
      configured: options.effective.values[key] !== undefined,
      currentValue: field.sensitive || isPathTypeField(field)
        ? undefined
        : options.effective.values[key],
    })),
  };
}

export function toCliConfigPromptOptions(model: PluginConfigFormModel): CliConfigPromptOptions {
  const currentValues: Record<string, PluginConfigValue | undefined> = {};
  const configuredKeys: string[] = [];

  for (const field of model.fields) {
    if (field.configured) {
      configuredKeys.push(field.key);
    }
    if (field.currentValue !== undefined) {
      currentValues[field.key] = field.currentValue;
    }
  }

  return {
    pluginName: model.pluginName,
    schema: Object.fromEntries(model.fields.map((field) => [
      field.key,
      {
        type: field.type === 'enum' ? 'string' : field.type,
        label: field.label,
        description: field.description,
        required: field.required,
        sensitive: field.sensitive,
        default: field.defaultValue,
        enum: field.enumValues,
        min: field.min,
        max: field.max,
      },
    ])) satisfies CliConfigPromptSchema,
    initialScope: model.initialScope,
    allowedScopes: [...model.allowedScopes],
    currentValues,
    configuredKeys,
    requiredKeys: [...model.requiredKeys],
  };
}

function formatRequiredConfigSetCommands(
  pluginName: string,
  issues: PluginConfigIssue[],
  defaultScope: Scope,
): string {
  const commands = new Set<string>();
  for (const issue of issues) {
    const scope = issue.source === 'user' || issue.source === 'project'
      ? issue.source
      : defaultScope;
    commands.add(`aw config set ${pluginName} ${issue.key} <value> -s ${scope}`);
  }

  return [...commands].map((command) => `\`${command}\``).join(' 或 ');
}

export async function preflightRequiredPluginConfigs(options: {
  targets: RequiredPluginConfigPreflightTarget[];
  cwd: string;
  defaultScope: Scope;
  context: CommandExecutionContext;
  interactive?: boolean;
}): Promise<RequiredPluginConfigPreflightResult> {
  const visited = new Set<string>();
  const result: RequiredPluginConfigPreflightResult = {
    checked: 0,
    prompted: 0,
    written: [],
  };

  for (const target of options.targets) {
    const pluginName = target.pluginName ?? target.manifest.name;
    const identity = target.schemaSourceIdentity ?? createPluginConfigSchemaIdentity(target.manifest);
    const dedupeKey = `${pluginName}\0${identity}`;
    if (visited.has(dedupeKey)) {
      continue;
    }
    visited.add(dedupeKey);
    result.checked += 1;

    if (!target.manifest.config?.schema) {
      continue;
    }

    let effective = await resolveEffectivePluginConfig({
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      pluginName,
      manifest: target.manifest,
      cwd: options.cwd,
      env: options.context.env,
    });
    const blockingIssues = effective.issues.filter((issue) =>
      issue.type === 'missing-required' || issue.type === 'invalid-config',
    );
    if (blockingIssues.length === 0) {
      continue;
    }

    const details = blockingIssues.map((issue) => issue.key).join(', ');
    const setCommands = formatRequiredConfigSetCommands(
      pluginName,
      blockingIssues,
      options.defaultScope,
    );
    throw new Error(
      `${pluginName} requires valid AW config before install/upgrade: ${details}. ` +
        `Run ${setCommands}, or open \`aw\` to complete setup.`,
    );
  }

  return result;
}

export function renderPluginConfigValueForDisplay(value: unknown): string {
  return formatValue(value);
}
