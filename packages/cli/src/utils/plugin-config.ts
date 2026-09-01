import crypto from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import fs from 'fs-extra';
import {
  formatPluginConfigIssue,
  matchPluginConfigPreset,
  redactPluginConfigValue,
  stablePluginConfigStringify,
  validatePluginConfigValue as validateCorePluginConfigValue,
} from '@lesliechan721/aw-plugin-core/manifest';

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
  PluginConfigValue as CorePluginConfigValue,
  NormalizedPluginManifest,
  PluginMeta,
  Scope,
} from '../types.js';
import {
  assertTestReadablePath,
  assertTestWritablePath,
} from './test-path-fence.js';
import {
  canonicalizePathThroughExistingAncestor,
  resolveAwHome,
  resolveRepoRootSync,
} from './paths.js';

export type PluginConfigValue = CorePluginConfigValue;
export type RedactedPluginConfigValue = ReturnType<typeof redactPluginConfigValue>;
export type PluginConfigSource = 'default' | 'user' | 'project' | 'missing';
export type PluginConfigIssueType = 'missing-required' | 'invalid-config';
type PluginConfigStorePathAccess = 'read' | 'write';

export interface PluginConfigIssue {
  type: PluginConfigIssueType;
  key: string;
  source?: PluginConfigSource;
  message: string;
}

export interface IgnoredUnknownPluginConfigKey {
  scope: Scope;
  source: Exclude<PluginConfigSource, 'default' | 'missing'>;
  key: string;
}

export interface PluginConfigStore {
  path: string;
  exists: boolean;
  state: 'missing' | 'ready' | 'invalid';
  values: Record<string, PluginConfigValue>;
  invalidCode?: PluginConfigStoreInvalidCode;
  issues: string[];
}

interface NamespacedPluginConfigEnvelope {
  schemaVersion: 3;
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  values: Record<string, PluginConfigValue>;
}

export type PluginConfigStoreInvalidCode =
  | 'invalidJson'
  | 'schemaVersionUnsupported'
  | 'identityMismatch'
  | 'invalidValues';

export interface ResolvedEffectivePluginConfig {
  pluginName: string;
  projectRoot: string;
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, RedactedPluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  schema: PluginConfigSchema['fields'];
  stores: {
    user: PluginConfigStore;
    project: PluginConfigStore;
  };
}

export interface ResolvedProjectArtifactRenderConfig {
  pluginName: string;
  projectRoot: string;
  values: Record<string, PluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  schema: PluginConfigSchema['fields'];
  stores: {
    user: PluginConfigStore;
    project: PluginConfigStore;
  };
}

export interface ProjectScopedPluginConfigEntryView {
  key: string;
  defaultValue?: RedactedPluginConfigValue;
  userValue?: RedactedPluginConfigValue;
  projectValue?: RedactedPluginConfigValue;
  effectiveValue?: RedactedPluginConfigValue;
  effectiveSource: PluginConfigSource;
}

export interface ResolvedProjectScopedPluginConfigView {
  pluginName: string;
  projectRoot: string;
  schema: PluginConfigSchema['fields'];
  stores: {
    user: PluginConfigStore;
    project: PluginConfigStore;
  };
  redactedValues: Record<string, RedactedPluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  entries: Record<string, ProjectScopedPluginConfigEntryView>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
}

export interface PluginConfigStoreReceipt {
  pluginName: string;
  scope: Scope;
  path: string;
}

export interface ResetPluginConfigStoreReceipt extends PluginConfigStoreReceipt {
  storeKind: 'user' | 'project';
  existed: boolean;
  deleted: boolean;
}

export interface PluginConfigStoreTarget {
  storeKind: 'user' | 'project';
  path: string;
}

export interface RequiredPluginConfigPreflightTarget {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  schemaSourceIdentity?: string;
}

export interface RequiredPluginConfigPreflightResult {
  checked: number;
  prompted: number;
  written: Array<{ pluginName: string; scope: Scope; updatedKeys: string[] }>;
}

export interface PluginConfigFormFieldModel {
  key: string;
  type: Exclude<PluginConfigSchemaField['type'], 'object'>;
  label: string;
  description?: string;
  required: boolean;
  sensitive: boolean;
  defaultValue?: string | number | boolean;
  enumValues?: Array<string | number>;
  min?: number;
  max?: number;
  configured: boolean;
  currentValue?: string | number | boolean;
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

export async function withConfigFileMutation<T>(options: {
  filePath: string;
  allowedRoot: string;
  action: () => Promise<T>;
}): Promise<T> {
  await prepareConfigFileParent(options.filePath, options.allowedRoot);
  await assertNoConfigSymlink(options.allowedRoot, options.filePath);
  return options.action();
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
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return stablePluginConfigStringify(value);
  }
  if (isRecord(value)) {
    return stablePluginConfigStringify(value as Record<string, string | number | boolean>);
  }
  return JSON.stringify(value);
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
  access?: PluginConfigStorePathAccess;
}): string {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const sourceId = options.sourceId === undefined
    ? undefined
    : assertSafePluginConfigSegment(options.sourceId);
  const root = options.scope === 'user'
    ? resolveAwHome(options.env)
    : path.join(resolveAwProjectRoot(options.cwd), '.agent-workflows');
  const filePath = path.join(root, CONFIG_DIR, ...(sourceId ? [sourceId] : []), pluginName, CONFIG_FILE);

  if (options.scope !== 'project') {
    return filePath;
  }

  if (options.access === 'read') {
    return assertTestReadablePath(
      filePath,
      'project plugin config store (.agent-workflows/plugin-config)',
      '用 registerReadonlyFixtureRoot() 或 runWithRepositoryCwdAsReadOnly() 登记只读 project fixture 根；需要写入时改用 withSafeTestCwd() 或 registerWritableStateRoot()。',
    );
  }

  if (options.access === 'write') {
    return assertTestWritablePath(
      filePath,
      'project plugin config store (.agent-workflows/plugin-config)',
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

  return [{
    storeKind: 'project',
    path: resolvePluginConfigStorePath(options),
  }];
}

function isPluginConfigValue(value: unknown): value is PluginConfigValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!isRecord(value)) return false;
  return Object.values(value).every((child) =>
    typeof child === 'string'
    || typeof child === 'boolean'
    || (typeof child === 'number' && Number.isFinite(child)));
}

function invalidStore(
  filePath: string,
  code: PluginConfigStoreInvalidCode,
  message: string,
): PluginConfigStore {
  return {
    path: filePath,
    exists: true,
    state: 'invalid',
    values: {},
    invalidCode: code,
    issues: [message],
  };
}

function readyStore(
  filePath: string,
  values: Record<string, PluginConfigValue>,
): PluginConfigStore {
  return {
    path: filePath,
    exists: true,
    state: 'ready',
    values,
    issues: [],
  };
}

export function assertReadyPluginConfigStore(store: PluginConfigStore): void {
  if (store.state !== 'invalid') return;
  throw new Error(
    `${store.invalidCode}: Invalid plugin config store "${store.path}". ${store.issues.join(' ')}`,
  );
}

type ParsedStoreJson =
  | { state: 'parsed'; value: unknown }
  | { state: 'invalidJson'; store: PluginConfigStore };

async function parseStoreJson(filePath: string): Promise<ParsedStoreJson> {
  try {
    return {
      state: 'parsed',
      value: JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        state: 'invalidJson',
        store: invalidStore(filePath, 'invalidJson', 'The store is not valid JSON.'),
      };
    }
    throw error;
  }
}

function validateStoreValues(options: {
  filePath: string;
  values: unknown;
  schema?: PluginConfigSchema['fields'];
}): PluginConfigStore {
  if (!isRecord(options.values)) {
    return invalidStore(options.filePath, 'invalidValues', 'The values field must be an object.');
  }
  const values: Record<string, PluginConfigValue> = {};
  const issues: string[] = [];
  for (const [key, value] of Object.entries(options.values)) {
    if (!isPluginConfigValue(value)) {
      issues.push(`Config "${key}" is not a supported config value.`);
      continue;
    }
    const field = options.schema?.[key];
    if (field) {
      const fieldIssues = validateCorePluginConfigValue(field, value, key);
      issues.push(...fieldIssues.map(formatPluginConfigIssue));
    }
    values[key] = value;
  }
  return issues.length > 0
    ? invalidStore(options.filePath, 'invalidValues', issues.join(' '))
    : readyStore(options.filePath, values);
}

async function readStoreFile(
  filePath: string,
  schema?: PluginConfigSchema['fields'],
): Promise<PluginConfigStore> {
  const parsed = await parseStoreJson(filePath);
  if (parsed.state === 'invalidJson') return parsed.store;
  return validateStoreValues({ filePath, values: parsed.value, schema });
}

async function readNamespacedStoreFile(options: {
  filePath: string;
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  schema?: PluginConfigSchema['fields'];
}): Promise<PluginConfigStore> {
  const parsed = await parseStoreJson(options.filePath);
  if (parsed.state === 'invalidJson') return parsed.store;
  const raw = parsed.value;
  if (!isRecord(raw) || raw.schemaVersion !== 3) {
    return invalidStore(
      options.filePath,
      'schemaVersionUnsupported',
      'Only plugin config store schemaVersion 3 is supported.',
    );
  }
  if (
    raw.sourceId !== options.sourceId
    || raw.pluginName !== options.pluginName
    || raw.sourceIdentity !== options.sourceIdentity
  ) {
    return invalidStore(
      options.filePath,
      'identityMismatch',
      'The store identity does not match its source and namespaced path.',
    );
  }
  return validateStoreValues({
    filePath: options.filePath,
    values: raw.values,
    schema: options.schema,
  });
}

function namespacedConfigContent(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  values: Record<string, PluginConfigValue>;
}): string {
  if (!options.sourceId) return `${JSON.stringify(options.values, null, 2)}\n`;
  if (!options.sourceIdentity) throw new Error('sourceIdentity is required for namespaced plugin config.');
  const envelope: NamespacedPluginConfigEnvelope = {
    schemaVersion: 3,
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
}): Promise<void> {
  if (!options.sourceId) return;
  const legacyPath = resolvePluginConfigStorePath({
    pluginName: options.pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { access: 'read' as const } : {}),
  });
  if (await lstatIfExists(legacyPath)) {
    throw new Error('legacyStateUnsupported: legacy and namespaced plugin config stores cannot coexist.');
  }
}

export async function readPluginConfigStore(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  schema?: PluginConfigSchema['fields'];
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
      state: 'missing',
      values: {},
      issues: [],
    };
  }

  return options.sourceId
    ? readNamespacedStoreFile({
        filePath,
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity!,
        pluginName: options.pluginName,
        schema: options.schema,
      })
    : readStoreFile(filePath, options.schema);
}

export async function readNamespacedPluginConfigStoreIdentity(options: {
  sourceId: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ sourceIdentity: string; store: PluginConfigStore } | null> {
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'read' as const } : {}),
  });
  if (!await inspectConfigReadTarget(resolvePluginConfigAllowedRoot(options), filePath)) return null;
  const parsed = await parseStoreJson(filePath);
  if (parsed.state === 'invalidJson') {
    throw new Error(`${parsed.store.invalidCode}: invalid namespaced plugin config store.`);
  }
  const raw = parsed.value;
  if (!isRecord(raw) || raw.schemaVersion !== 3 || !isRecord(raw.values)
    || raw.sourceId !== options.sourceId || raw.pluginName !== options.pluginName
    || typeof raw.sourceIdentity !== 'string') {
    throw new Error('schemaVersionUnsupported: invalid namespaced plugin config store.');
  }
  const store = validateStoreValues({ filePath, values: raw.values });
  assertReadyPluginConfigStore(store);
  return {
    sourceIdentity: raw.sourceIdentity,
    store,
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
}): Promise<string[]> {
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const storeRoots = options.scope === 'user'
    ? [path.join(resolveAwHome(options.env), CONFIG_DIR)]
    : options.scope === 'project'
      ? [path.join(projectRoot, '.agent-workflows', CONFIG_DIR)]
      : [
          path.join(resolveAwHome(options.env), CONFIG_DIR),
          path.join(projectRoot, '.agent-workflows', CONFIG_DIR),
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
  values: Record<string, PluginConfigValue>;
}

export async function listNamespacedPluginConfigStores(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope: Scope;
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
    CONFIG_DIR,
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
      const parsed = await parseStoreJson(filePath);
      if (parsed.state === 'invalidJson') {
        throw new Error(`${parsed.store.invalidCode}: invalid namespaced plugin config store "${filePath}".`);
      }
      const raw = parsed.value;
      if (!isRecord(raw) || raw.schemaVersion !== 3 || !isRecord(raw.values)
        || raw.sourceId !== sourceId || raw.pluginName !== pluginName
        || typeof raw.sourceIdentity !== 'string') {
        throw new Error(`schemaVersionUnsupported: invalid namespaced plugin config store "${filePath}".`);
      }
      const store = validateStoreValues({ filePath, values: raw.values });
      assertReadyPluginConfigStore(store);
      output.push({
        sourceId,
        sourceIdentity: raw.sourceIdentity,
        pluginName,
        pluginId: `${sourceId}/${pluginName}`,
        values: store.values,
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
}): Promise<PluginConfigStoreReceipt> {
  await assertNoLegacyConfigCoexistence(options);
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const validated = validateStoreValues({ filePath, values: options.values });
  assertReadyPluginConfigStore(validated);
  await withConfigFileMutation({
    filePath,
    allowedRoot,
    action: async () => Object.keys(validated.values).length === 0
      ? atomicRemoveConfigFile({ filePath, allowedRoot })
      : atomicReplaceConfigFile({
          filePath,
          allowedRoot,
          content: namespacedConfigContent({ ...options, values: validated.values }),
          mode: 0o600,
        }),
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
  updates: Record<string, PluginConfigValue>;
  removeKeys?: string[];
  requireExistingRemoveKeys?: boolean;
  env?: NodeJS.ProcessEnv;
  schema?: PluginConfigSchema['fields'];
  reviewPreflight?: () => Promise<void> | void;
}): Promise<PluginConfigStoreReceipt & { updatedKeys: string[]; removedKeys: string[] }> {
  await assertNoLegacyConfigCoexistence(options);
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const removedKeys = options.removeKeys ?? [];
  await withConfigFileMutation({
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
              schema: options.schema,
            })
          : await readStoreFile(filePath, options.schema)
        : readyStore(filePath, {});
      assertReadyPluginConfigStore(current);
      if (options.requireExistingRemoveKeys) {
        const missingKey = removedKeys.find((key) => !Object.hasOwn(current.values, key));
        if (missingKey) throw new Error(`Unknown config key "${missingKey}".`);
      }
      const next = { ...current.values };
      for (const key of removedKeys) {
        delete next[key];
      }
      for (const [key, value] of Object.entries(options.updates)) {
        next[key] = value;
      }
      if (Object.keys(next).length === 0) {
        await atomicRemoveConfigFile({ filePath, allowedRoot });
      } else {
        await atomicReplaceConfigFile({
          filePath,
          allowedRoot,
          content: namespacedConfigContent({ ...options, values: next }),
          mode: 0o600,
        });
      }
    },
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
  reviewPreflight?: () => Promise<void> | void;
}): Promise<ResetPluginConfigStoreReceipt> {
  await assertNoLegacyConfigCoexistence(options);
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const existed = await withConfigFileMutation({
    filePath,
    allowedRoot,
    action: async () => {
      await options.reviewPreflight?.();
      const target = await lstatIfExists(filePath);
      if (!target) return false;
      if (!target.isFile() || target.isSymbolicLink()) {
        throw new Error(`Config target must be a regular file: ${filePath}`);
      }
      return atomicRemoveConfigFile({ filePath, allowedRoot });
    },
  });

  return {
    pluginName: options.pluginName,
    scope: options.scope,
    storeKind: options.scope === 'user'
      ? 'user'
      : 'project',
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
  const existing: boolean[] = [];
  for (const target of targets) {
    await prepareConfigFileParent(target.path, allowedRoot);
    await assertNoConfigSymlink(allowedRoot, target.path);
    const stats = await lstatIfExists(target.path);
    existing.push(stats !== null);
    if (!stats) continue;
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Config target must be a regular file: ${target.path}`);
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
  return receipts;
}

function coerceConfigValue(
  key: string,
  field: PluginConfigSchemaField,
  value: unknown,
): PluginConfigValue {
  let coerced = value;
  if (field.type === 'number' && typeof value === 'string' && value.trim() !== '') {
    coerced = Number(value);
  } else if (field.type === 'boolean' && typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) coerced = true;
    if (['false', '0', 'no', 'n'].includes(normalized)) coerced = false;
  }
  const issues = validateCorePluginConfigValue(field, coerced, key);
  if (issues.length > 0) {
    throw new Error(formatPluginConfigIssue(issues[0]!));
  }
  return coerced as PluginConfigValue;
}

export async function coercePluginConfigValue(options: {
  key: string;
  field: PluginConfigSchemaField;
  value: unknown;
}): Promise<PluginConfigValue> {
  return coerceConfigValue(options.key, options.field, options.value);
}

function redactValue(
  field: PluginConfigSchemaField,
  value: PluginConfigValue,
): RedactedPluginConfigValue {
  return redactPluginConfigValue(field, value);
}
function sourceForStoreLayer(
  scope: Scope,
): Exclude<PluginConfigSource, 'default' | 'missing'> {
  return scope === 'user' ? 'user' : 'project';
}

async function applyConfigLayer(options: {
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, RedactedPluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  invalidIssues: Map<string, PluginConfigIssue>;
  schema: PluginConfigSchema['fields'];
  entries: Record<string, unknown>;
  source: PluginConfigSource;
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
  manifest: NormalizedPluginManifest;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedEffectivePluginConfig> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
  const schema = options.manifest.config?.fields;
  if (!schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }

  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [userStore, projectStore] = await Promise.all([
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
      schema,
    }),
    readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
      schema,
    }),
  ]);
  assertReadyPluginConfigStore(userStore);
  assertReadyPluginConfigStore(projectStore);

  const values: Record<string, PluginConfigValue> = {};
  const redactedValues: Record<string, RedactedPluginConfigValue> = {};
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
    });
  }

  for (const [scope, store] of [
    ['user', userStore],
    ['project', projectStore],
  ] as const) {
    const plainEntries = getStoreEntries(store.values);
    for (const key of Object.keys(plainEntries)) {
      if (!schemaKeys.has(key)) {
        ignoredUnknownKeys.push({
          scope,
          source: sourceForStoreLayer(scope),
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
      source: sourceForStoreLayer(scope),
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
    },
  };
}

export async function coercePluginConfigUpdates(options: {
  schema: PluginConfigSchema['fields'];
  updates: Record<string, unknown>;
  cwd: string;
}): Promise<Record<string, PluginConfigValue>> {
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
    });
  }

  return output;
}

export async function resolveProjectArtifactRenderConfig(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  refreshKeys?: readonly string[];
}): Promise<ResolvedProjectArtifactRenderConfig> {
  if (!options.manifest.config?.fields) {
    const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
    const [userStore, projectStore] = await Promise.all([
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
    ]);
    assertReadyPluginConfigStore(userStore);
    assertReadyPluginConfigStore(projectStore);
    return {
      pluginName,
      projectRoot: resolveAwProjectRoot(options.cwd),
      values: {},
      sources: {},
      issues: [],
      ignoredUnknownKeys: [],
      schema: {},
      stores: { user: userStore, project: projectStore },
    };
  }
  const effective = await resolveEffectivePluginConfig(options);
  return {
    pluginName: effective.pluginName,
    projectRoot: effective.projectRoot,
    values: effective.values,
    sources: effective.sources,
    issues: effective.issues,
    ignoredUnknownKeys: effective.ignoredUnknownKeys,
    schema: effective.schema,
    stores: effective.stores,
  };
}

async function resolveRedactedLayerValue(options: {
  key: string;
  field: PluginConfigSchemaField;
  source: PluginConfigSource;
  value: unknown;
}): Promise<{
  value?: RedactedPluginConfigValue;
  issue?: PluginConfigIssue;
}> {
  try {
    const coerced = await coercePluginConfigValue({
      key: options.key,
      field: options.field,
      value: options.value,
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
  manifest: NormalizedPluginManifest;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedProjectScopedPluginConfigView> {
  const effective = await resolveEffectivePluginConfig(options);
  const entries: Record<string, ProjectScopedPluginConfigEntryView> = {};

  for (const [key, field] of Object.entries(effective.schema)) {
    const entry: ProjectScopedPluginConfigEntryView = {
      key,
      effectiveValue: effective.redactedValues[key],
      effectiveSource: effective.sources[key] ?? 'missing',
    };

    if (field.default !== undefined) {
      const resolvedDefault = await resolveRedactedLayerValue({
        key,
        field,
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
        source: 'project',
        value: projectPlainEntries[key],
      });
      if (resolvedProject.value !== undefined) {
        entry.projectValue = resolvedProject.value;
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
  return null;
}

function configFieldProjection(options: {
  field: PluginConfigSchemaField;
  value?: PluginConfigValue;
  source?: PluginConfigSource;
  issues?: PluginConfigIssue[];
}): Pick<ConfigFieldEntry, 'value' | 'source' | 'matchedPreset' | 'valid' | 'issues'> {
  const source = options.source ?? 'missing';
  const issues = options.issues ?? [];
  return {
    value: options.value === undefined ? null : redactValue(options.field, options.value),
    source,
    matchedPreset: options.value === undefined
      ? null
      : matchPluginConfigPreset(options.field, options.value)?.id ?? null,
    valid: issues.length === 0,
    issues,
  };
}

async function buildManifestFieldEntries(options: {
  plugin: PluginMeta;
  scope: Scope | 'effective';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntry[]> {
  const schema = options.plugin.manifest.config?.fields;
  if (!schema) {
    return [];
  }

  const [userStore, projectStore] = await Promise.all([
    readPluginConfigStore({
      sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity,
      pluginName: options.plugin.manifest.name,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
      schema,
    }),
    readPluginConfigStore({
      sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity,
      pluginName: options.plugin.manifest.name,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
      schema,
    }),
  ]);
  assertReadyPluginConfigStore(userStore);
  assertReadyPluginConfigStore(projectStore);
  const userPlainEntries = getStoreEntries(userStore.values);
  const projectPlainEntries = getStoreEntries(projectStore.values);
  const effective = await resolveEffectivePluginConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });
  const effectiveFieldState = (key: string): Pick<ConfigFieldEntry,
    'valueState' | 'effectiveValue' | 'sourceLayer'
    | 'value' | 'source' | 'matchedPreset' | 'valid' | 'issues'> => {
    const source = effective.sources[key];
    const sourceLayer = toConfigSourceLayer(source);
    const field = schema[key]!;
    const fieldIssues = effective.issues.filter((entry) => entry.key === key);
    if (source === undefined || source === 'missing') {
      return {
        valueState: fieldIssues.length > 0 ? 'invalid' : 'default',
        effectiveValue: null,
        sourceLayer: null,
        ...configFieldProjection({ field, source: 'missing', issues: fieldIssues }),
      };
    }
    const issue = fieldIssues.find((entry) => entry.source === source);
    return {
      valueState: issue ? 'invalid' : source === 'default' ? 'default' : 'configured',
      effectiveValue: issue ? null : effective.redactedValues[key] ?? null,
      sourceLayer,
      ...configFieldProjection({
        field,
        value: issue ? undefined : effective.values[key],
        source,
        issues: fieldIssues,
      }),
    };
  };

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
      ...configFieldProjection({ field }),
    };

    if (options.scope === 'user') {
      if (Object.hasOwn(userPlainEntries, key)) {
        try {
          const value = await coercePluginConfigValue({
            key,
            field,
            value: userPlainEntries[key],
          });
          fields.push({
            ...base,
            valueState: 'configured',
            effectiveValue: redactValue(field, value),
            sourceLayer: 'user',
            storedValue: redactValue(field, value),
            storedSourceLayer: 'user',
            ...configFieldProjection({ field, value, source: 'user' }),
          });
        } catch {
          fields.push({
            ...base,
            valueState: 'invalid',
            sourceLayer: 'user',
            storedSourceLayer: 'user',
            valid: false,
            issues: [{ type: 'invalid-config', key, source: 'user' }],
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
          });
          fields.push({
            ...base,
            effectiveValue: redactValue(field, value),
            sourceLayer: 'default',
            ...configFieldProjection({ field, value, source: 'default' }),
          });
        } catch {
          fields.push({
            ...base,
            valueState: 'invalid',
            sourceLayer: 'default',
            source: 'default',
            valid: false,
            issues: [{ type: 'invalid-config', key, source: 'default' }],
          });
        }
        continue;
      }
      fields.push(base);
      continue;
    }

    let storedProjectValue: {
      storedValue?: RedactedPluginConfigValue;
      storedSourceLayer: 'project';
    } | undefined;
    if (options.scope === 'project' && Object.hasOwn(projectPlainEntries, key)) {
      try {
        const value = await coercePluginConfigValue({
          key,
          field,
          value: projectPlainEntries[key],
        });
        storedProjectValue = {
          storedValue: redactValue(field, value),
          storedSourceLayer: 'project',
        };
      } catch {
        storedProjectValue = { storedSourceLayer: 'project' };
      }
    }

    fields.push({ ...base, ...effectiveFieldState(key), ...storedProjectValue });
  }

  return fields;
}

async function buildLegacyStoreFieldEntries(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope | 'effective';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntry[]> {
  const locations = options.scope === 'effective'
    ? [
        { scope: 'user' as const, sourceLayer: 'user' as const },
        { scope: 'project' as const, sourceLayer: 'project' as const },
      ]
    : [{
        scope: options.scope,
        sourceLayer: options.scope === 'user' ? 'user' as const : 'project' as const,
      }];
  const fields = new Map<string, ConfigFieldEntry>();
  for (const location of locations) {
    const store = await readPluginConfigStore({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName: options.pluginName,
      scope: location.scope,
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
        value: '[redacted]',
        source: location.sourceLayer,
        matchedPreset: null,
        valid: true,
        issues: [],
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
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedConfigRead> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    currentPluginError: options.pluginError,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });


  const manifestFields = schemaAccess.plugin
    ? await buildManifestFieldEntries({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      })
    : await buildLegacyStoreFieldEntries({
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        pluginName,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      });

  return {
    pluginName,
    scope: options.scope,
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
  values: Record<string, RedactedPluginConfigValue>;
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
  manifest: NormalizedPluginManifest,
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

export function toCliConfigPromptSchema(schema: PluginConfigSchema['fields']): CliConfigPromptSchema {
  const promptSchema: CliConfigPromptSchema = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.type === 'object') continue;
    promptSchema[key] = {
      type: field.type,
      label: field.title ?? key,
      description: field.description,
      required: field.required,
      sensitive: field.sensitive,
      default: field.default,
      enum: field.type !== 'boolean' && field.choices?.allowCustom === false
        ? field.choices.presets.map((preset) => preset.value)
        : undefined,
      min: field.type === 'number' ? field.validation?.minimum : undefined,
      max: field.type === 'number' ? field.validation?.maximum : undefined,
    };
  }
  return promptSchema;
}

export function createPluginConfigFormModel(options: {
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  effective: ResolvedEffectivePluginConfig;
  initialScope: Scope;
  allowedScopes?: Scope[];
}): PluginConfigFormModel {
  const schema = options.manifest.config?.fields;
  if (!schema) {
    throw new Error(`Plugin "${options.pluginName ?? options.manifest.name}" does not declare an AW config schema.`);
  }

  const requiredKeys = [...new Set(
    options.effective.issues
      .filter((issue) => issue.type === 'missing-required' || issue.type === 'invalid-config')
      .map((issue) => issue.key),
  )];
  const fields: PluginConfigFormFieldModel[] = Object.entries(schema).flatMap(([key, field]) => {
    if (field.type === 'object') return [];
    return [{
      key,
      type: field.type,
      label: field.title ?? key,
      description: field.description,
      required: field.required === true,
      sensitive: field.sensitive === true,
      defaultValue: field.default,
      enumValues: field.type !== 'boolean' && field.choices?.allowCustom === false
        ? field.choices.presets.map((preset) => preset.value)
        : undefined,
      min: field.type === 'number' ? field.validation?.minimum : undefined,
      max: field.type === 'number' ? field.validation?.maximum : undefined,
      configured: options.effective.values[key] !== undefined,
      currentValue: field.sensitive
        ? undefined
        : options.effective.values[key] as string | number | boolean | undefined,
    }];
  });

  return {
    pluginName: options.pluginName ?? options.manifest.name,
    allowedScopes: options.allowedScopes ?? ['user', 'project'],
    initialScope: options.initialScope,
    requiredKeys,
    fields,
  };
}

export function toCliConfigPromptOptions(model: PluginConfigFormModel): CliConfigPromptOptions {
  const currentValues: Record<string, string | number | boolean | undefined> = {};
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
        type: field.type,
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
    commands.add(`aw config set ${pluginName} ${issue.key} --scope ${scope} --value-json '<json>'`);
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

    if (!target.manifest.config?.fields) {
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
