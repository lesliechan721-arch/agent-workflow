import crypto from 'node:crypto';
import { resolveWorkContext } from '../intent/work-context.js';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';

import fs from 'fs-extra';
import {
  canonicalizePluginConfigValues,
  selectPluginConfigProfile,
  PLATFORM_TARGETS,
  type PlatformTarget,
  type PluginConfigCompiledDefinition,
  formatPluginConfigIssue,
  getPluginConfigDependencyKeys,
  getPluginConfigDependencyFields,
  matchPluginConfigPreset,
  redactPluginConfigValue,
  stablePluginConfigStringify,
  validatePluginConfigCandidate,
  validatePluginConfigDocument,
  validatePluginConfigValue as validateCorePluginConfigValue,
  type PluginConfigReferenceContext,
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
  canonicalizePathThroughExistingAncestor,
  resolveAwHome,
  resolveRepoRootSync,
} from './paths.js';
import {
  assertRealFileParentWithinRoot,
  assertSafeFileMutationPath,
  atomicReplaceSafeFile,
} from './safe-fs.js';
import {
  pluginConfigHasExternalReferences,
  resolvePluginConfigReferenceContext,
  type PluginConfigReferenceEvidence,
} from './plugin-config-references.js';

export { resolvePluginConfigReferenceContext } from './plugin-config-references.js';

export type PluginConfigValue = CorePluginConfigValue;
export type RedactedPluginConfigValue = ReturnType<typeof redactPluginConfigValue>;
export type PluginConfigSource = 'default' | 'common' | 'platform' | 'missing';
export type PluginConfigIssueType =
  | 'missing-required'
  | 'invalid-config';
type PluginConfigStorePathAccess = 'read' | 'write';


export interface PluginConfigIssue {
  type: PluginConfigIssueType;
  code?: string;
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
  common?: Record<string, PluginConfigValue>;
  platforms?: Partial<Record<PlatformTarget, Record<string, PluginConfigValue>>>;
  platform?: PlatformTarget;
  rawDigest?: string;
  invalidCode?: PluginConfigStoreInvalidCode;
  issues: string[];
}

export interface PluginConfigEnvelopeV6 {
  schemaVersion: 6;
  sourceId: string;
  pluginName: string;
  binding: { kind: 'source'; sourceIdentity: string };
  common: Record<string, PluginConfigValue>;
  platforms: Partial<Record<PlatformTarget, Record<string, PluginConfigValue>>>;
}

function readPluginConfigBinding(value: unknown): PluginConfigEnvelopeV6['binding'] | null {
  return isRecord(value) && value.kind === 'source'
    && typeof value.sourceIdentity === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(value.sourceIdentity)
    && Object.keys(value).every((key) => ['kind', 'sourceIdentity'].includes(key))
    ? { kind: 'source', sourceIdentity: value.sourceIdentity } : null;
}

function readPluginConfigEnvelopeV6(value: unknown, _scope?: Scope): PluginConfigEnvelopeV6 | null {
  if (!isRecord(value) || value.schemaVersion !== 6
    || typeof value.sourceId !== 'string' || typeof value.pluginName !== 'string'
    || !isRecord(value.common) || !isRecord(value.platforms)
    || Object.keys(value).some((key) => !['schemaVersion', 'sourceId', 'pluginName', 'binding', 'common', 'platforms'].includes(key))
    || Object.keys(value.platforms).some((key) => !PLATFORM_TARGETS.includes(key as PlatformTarget))) return null;
  const binding = readPluginConfigBinding(value.binding);
  return binding ? { schemaVersion: 6, sourceId: value.sourceId, pluginName: value.pluginName,
    binding, common: value.common as PluginConfigEnvelopeV6['common'],
    platforms: value.platforms as PluginConfigEnvelopeV6['platforms'] } : null;
}

export type PluginConfigStoreInvalidCode =
  | 'invalidJson'
  | 'schemaVersionUnsupported'
  | 'identityMismatch'
  | 'invalidValues';

export type PluginConfigResetTargetKind =
  | 'absent'
  | 'regularFile'
  | 'symbolicLink'
  | 'directory'
  | 'special';

export interface PluginConfigResetTargetInspection {
  exists: boolean;
  kind: PluginConfigResetTargetKind;
  resettable: boolean;
  fingerprint: string;
}

export interface ResolvedEffectivePluginConfig {
  context?: Scope;
  platform?: PlatformTarget;
  definition: PluginConfigCompiledDefinition;
  pluginName: string;
  projectRoot: string;
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, RedactedPluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  fieldStates: Record<string, PluginConfigFieldState>;
  issues: PluginConfigIssue[];
  unsupportedLayerOverrides: UnsupportedPluginConfigLayerOverride[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  schema: PluginConfigSchema['fields'];
  stores: Partial<Record<Scope, PluginConfigStore>>;
  referenceContext?: PluginConfigReferenceContext;
  referenceEvidence?: PluginConfigReferenceEvidence[];
}

export interface UnsupportedPluginConfigLayerOverride {
  type: 'configLayerUnsupported';
  key: string;
  scope: 'project';
  source: 'platform';
}

export interface PluginConfigResolvedValue {
  value: PluginConfigValue;
  redactedValue: RedactedPluginConfigValue;
  source: Exclude<PluginConfigSource, 'missing'>;
}

export interface PluginConfigFieldState {
  effective?: PluginConfigResolvedValue;
  invalidOverride?: {
    source: Exclude<PluginConfigSource, 'missing'>;
    issues: PluginConfigIssue[];
  };
  fallback?: PluginConfigResolvedValue;
}

export interface ResolvedProjectArtifactRenderConfig {
  pluginName: string;
  projectRoot: string;
  values: Record<string, PluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  issues: PluginConfigIssue[];
  unsupportedLayerOverrides: UnsupportedPluginConfigLayerOverride[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
  schema: PluginConfigSchema['fields'];
  stores: {
    user: PluginConfigStore;
    project?: PluginConfigStore;
  };
}

export interface PluginConfigStoreReceipt {
  platform?: PlatformTarget;
  pluginName: string;
  scope: Scope;
  path: string;
}

export interface ResetPluginConfigStoreReceipt extends PluginConfigStoreReceipt {
  storeKind: 'user' | 'project';
  existed: boolean;
  deleted: boolean;
  resetDisposition: 'absent' | 'clearedLayer' | 'deletedFile' | 'unlinkedSymlink' | 'quarantinedDirectory';
  quarantineBasename?: string;
}

export class PluginConfigResetError extends Error {
  readonly code: 'configResetFailed' | 'configResetTargetUnsupported';
  readonly osCode?: string;

  constructor(
    code: 'configResetFailed' | 'configResetTargetUnsupported',
    message: string,
    osCode?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'PluginConfigResetError';
    this.code = code;
    this.osCode = osCode;
  }
}

export interface PluginConfigStoreTarget {
  storeKind: 'user' | 'project';
  path: string;
}

export interface RequiredPluginConfigPreflightTarget {
  platform?: PlatformTarget;
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
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
  type: Exclude<PluginConfigSchemaField['type'], 'object' | 'array'>;
  label: string;
  description?: string;
  required: boolean;
  sensitive: boolean;
  defaultValue?: string | number | boolean;
  enumValues?: Array<string | number | boolean>;
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
  context?: Scope;
  platform?: PlatformTarget;
  pluginName: string;
  scope: Scope | 'effective';
  schema?: ConfigSchemaEvidence;
  fieldDefinitions?: PluginConfigSchema['fields'];
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
  await atomicReplaceSafeFile({
    ...options,
    label: 'Config path',
    temporaryTag: 'tmp',
    beforeRename: atomicConfigBeforeRenameHookForTests,
    afterRename: async (targetPath) => {
      await atomicConfigAfterRenameHookForTests?.(targetPath).catch(() => undefined);
    },
  });
}

export async function atomicRemoveConfigFile(options: {
  filePath: string;
  allowedRoot: string;
}): Promise<boolean> {
  await prepareConfigFileParent(options.filePath, options.allowedRoot);
  await assertSafeFileMutationPath({
    filePath: options.filePath,
    allowedRoot: options.allowedRoot,
    label: 'Config path',
  });
  await assertRealFileParentWithinRoot({
    filePath: options.filePath,
    allowedRoot: options.allowedRoot,
    label: 'Config path',
  });
  const currentTarget = await lstatIfExists(options.filePath);
  if (!currentTarget) return false;
  if (!currentTarget.isFile() || currentTarget.isSymbolicLink()) {
    throw new Error(`Config target must be a regular file: ${options.filePath}`);
  }

  await atomicConfigBeforeRenameHookForTests?.(options.filePath, options.filePath);
  await assertSafeFileMutationPath({
    filePath: options.filePath,
    allowedRoot: options.allowedRoot,
    label: 'Config path',
  });
  await assertRealFileParentWithinRoot({
    filePath: options.filePath,
    allowedRoot: options.allowedRoot,
    label: 'Config path',
  });
  const targetBeforeRemove = await lstatIfExists(options.filePath);
  if (!targetBeforeRemove) return false;
  if (!targetBeforeRemove.isFile() || targetBeforeRemove.isSymbolicLink()) {
    throw new Error(`Config target must be a regular file: ${options.filePath}`);
  }

  await nodeFs.unlink(options.filePath);
  await atomicConfigAfterRenameHookForTests?.(options.filePath).catch(() => undefined);
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
  if (isRecord(value) || Array.isArray(value)) {
    return stablePluginConfigStringify(value as PluginConfigValue);
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
  platform?: PlatformTarget,
): ConfigSchemaEvidence {
  return {
    source: 'currentCatalog',
    identity: createPluginConfigSchemaIdentity(plugin.manifest, platform),
    platform,
    pluginVersion: plugin.manifest.version,
    manifestDigest,
  };
}

function getStoreEntries(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values));
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

function resolvePluginConfigAllowedRoot(options: { scope: Scope; cwd: string; env?: NodeJS.ProcessEnv }): string {
  return resolveAwHome(options.env);
}

/** Scope selects source context. All config values belong to the user document. */
export function resolvePluginConfigStorePath(options: {
  sourceId?: string; pluginName: string; scope: Scope; cwd: string;
  env?: NodeJS.ProcessEnv; access?: PluginConfigStorePathAccess;
}): string {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const sourceId = options.sourceId === undefined ? undefined : assertSafePluginConfigSegment(options.sourceId);
  return path.join(resolveAwHome(options.env), CONFIG_DIR, ...(sourceId ? [sourceId] : []), pluginName, CONFIG_FILE);
}

export function resolvePluginConfigStoreTargets(options: {
  sourceId?: string; pluginName: string; scope: Scope; cwd: string;
  env?: NodeJS.ProcessEnv; access?: PluginConfigStorePathAccess;
}): PluginConfigStoreTarget[] {
  return [{ storeKind: 'user', path: resolvePluginConfigStorePath(options) }];
}

function isPluginConfigScalar(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

function isPluginConfigObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((property) => {
    if (isPluginConfigScalar(property)) return true;
    if (Array.isArray(property)) {
      const elementType = typeof property[0];
      return Object.keys(property).length === property.length
        && property.every((item, index) => Object.hasOwn(property, index)
          && typeof item === elementType
          && isPluginConfigScalar(item));
    }
    return isRecord(property) && Object.values(property).every(isPluginConfigScalar);
  });
}

function isPluginConfigValue(value: unknown): value is PluginConfigValue {
  if (isPluginConfigScalar(value)) return true;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    const first = value[0];
    const elementType = isRecord(first) ? 'object' : typeof first;
    return value.every((item, index) => Object.hasOwn(value, index)
      && (isRecord(item) ? 'object' : typeof item) === elementType
      && (isPluginConfigScalar(item) || isPluginConfigObject(item)));
  }
  return isPluginConfigObject(value);
}

function invalidStore(
  filePath: string,
  code: PluginConfigStoreInvalidCode,
  message: string,
  rawDigest?: string,
): PluginConfigStore {
  return {
    path: filePath,
    exists: true,
    state: 'invalid',
    values: {},
    ...(rawDigest ? { rawDigest } : {}),
    invalidCode: code,
    issues: [message],
  };
}

function readyStore(
  filePath: string,
  values: Record<string, PluginConfigValue>,
  rawDigest?: string,
): PluginConfigStore {
  return {
    path: filePath,
    exists: true,
    state: 'ready',
    values: canonicalizePluginConfigValues(values),
    ...(rawDigest ? { rawDigest } : {}),
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
  | { state: 'parsed'; value: unknown; rawDigest: string }
  | { state: 'invalidJson'; store: PluginConfigStore };

async function parseStoreJson(filePath: string): Promise<ParsedStoreJson> {
  const content = await fs.readFile(filePath);
  const rawDigest = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  try {
    return {
      state: 'parsed',
      value: JSON.parse(content.toString('utf8')) as unknown,
      rawDigest,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        state: 'invalidJson',
        store: invalidStore(filePath, 'invalidJson', 'The store is not valid JSON.', rawDigest),
      };
    }
    throw error;
  }
}

function validateStoreValues(options: {
  filePath: string;
  values: unknown;
  rawDigest?: string;
}): PluginConfigStore {
  if (!isRecord(options.values)) {
    return invalidStore(
      options.filePath,
      'invalidValues',
      'The values field must be an object.',
      options.rawDigest,
    );
  }
  const values = Object.create(null) as Record<string, PluginConfigValue>;
  const issues: string[] = [];
  for (const [key, value] of Object.entries(options.values)) {
    if (!isPluginConfigValue(value)) {
      issues.push(`Config "${key}" is not a supported config value.`);
      continue;
    }
    values[key] = value;
  }
  return issues.length > 0
    ? invalidStore(options.filePath, 'invalidValues', issues.join(' '), options.rawDigest)
    : readyStore(options.filePath, values, options.rawDigest);
}

function documentStore(options: {
  filePath: string; common: unknown; platforms: unknown; rawDigest?: string; platform?: PlatformTarget;
}): PluginConfigStore {
  const common = validateStoreValues({ filePath: options.filePath, values: options.common, rawDigest: options.rawDigest });
  if (common.state === 'invalid') return common;
  if (!isRecord(options.platforms) || Object.keys(options.platforms).some((key) => !PLATFORM_TARGETS.includes(key as PlatformTarget))) {
    return invalidStore(options.filePath, 'invalidValues', 'The platforms field must contain known platform objects.', options.rawDigest);
  }
  const platforms: NonNullable<PluginConfigStore['platforms']> = {};
  for (const [platform, values] of Object.entries(options.platforms)) {
    const store = validateStoreValues({ filePath: options.filePath, values, rawDigest: options.rawDigest });
    if (store.state === 'invalid') return store;
    platforms[platform as PlatformTarget] = store.values;
  }
  return { ...common, common: common.values, platforms, ...(options.platform ? { platform: options.platform } : {}),
    values: options.platform ? platforms[options.platform] ?? {} : common.values };
}

export function pluginConfigStoreForProfile(store: PluginConfigStore, platform?: PlatformTarget): PluginConfigStore {
  return { ...store, platform, values: platform ? store.platforms?.[platform] ?? {} : store.common ?? store.values };
}

/** Replace one layer in memory without changing any other profile. */
export function replacePluginConfigStoreLayer(store: PluginConfigStore, values: Record<string, PluginConfigValue>, platform?: PlatformTarget): PluginConfigStore {
  const common = platform ? store.common ?? store.values : canonicalizePluginConfigValues(values);
  const platforms = { ...store.platforms };
  if (platform) {
    if (Object.keys(values).length) platforms[platform] = canonicalizePluginConfigValues(values);
    else delete platforms[platform];
  }
  const exists = Object.keys(common).length > 0 || Object.keys(platforms).length > 0;
  return { ...store, common, platforms, platform, values: platform ? platforms[platform] ?? {} : common,
    exists, state: exists ? 'ready' : 'missing', issues: [], rawDigest: undefined };
}

async function readStoreFile(filePath: string, platform?: PlatformTarget): Promise<PluginConfigStore> {
  const parsed = await parseStoreJson(filePath);
  if (parsed.state === 'invalidJson') return parsed.store;
  const raw = parsed.value;
  if (!isRecord(raw) || raw.schemaVersion !== 6
    || Object.keys(raw).some((key) => !['schemaVersion', 'common', 'platforms'].includes(key))) {
    return invalidStore(filePath, 'schemaVersionUnsupported', 'Only plugin config store schemaVersion 6 is supported. Reset the old document, then save the required values.', parsed.rawDigest);
  }
  return documentStore({ filePath, common: raw.common, platforms: raw.platforms, rawDigest: parsed.rawDigest, platform });
}

async function readNamespacedStoreFile(options: {
  filePath: string; sourceId: string; scope: Scope; sourceIdentity?: string; logicalIdentity?: string;
  pluginName: string; platform?: PlatformTarget;
}): Promise<PluginConfigStore> {
  const parsed = await parseStoreJson(options.filePath);
  if (parsed.state === 'invalidJson') return parsed.store;
  const envelope = readPluginConfigEnvelopeV6(parsed.value);
  if (!envelope) return invalidStore(options.filePath, 'schemaVersionUnsupported',
    'Only a valid plugin config store schemaVersion 6 is supported. Reset the old document, then save the required values.', parsed.rawDigest);
  if (envelope.sourceId !== options.sourceId || envelope.pluginName !== options.pluginName
    || !options.sourceIdentity || envelope.binding.sourceIdentity !== options.sourceIdentity) {
    return invalidStore(options.filePath, 'identityMismatch', 'The user store is not bound to the requested source and plugin identity.', parsed.rawDigest);
  }
  return documentStore({ filePath: options.filePath, common: envelope.common, platforms: envelope.platforms,
    rawDigest: parsed.rawDigest, platform: options.platform });
}

function namespacedConfigContent(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; scope: Scope; pluginName: string;
  common: Record<string, PluginConfigValue>; platforms: NonNullable<PluginConfigStore['platforms']>;
}): string {
  const document = { schemaVersion: 6 as const, common: canonicalizePluginConfigValues(options.common),
    platforms: Object.fromEntries(Object.entries(options.platforms).sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([platform, values]) => [platform, canonicalizePluginConfigValues(values!)])) };
  if (!options.sourceId) return `${JSON.stringify(document, null, 2)}\n`;
  if (!options.sourceIdentity) throw new Error('sourceChanged: user plugin config requires a source identity.');
  return `${JSON.stringify({ ...document, sourceId: options.sourceId, pluginName: options.pluginName,
    binding: { kind: 'source', sourceIdentity: options.sourceIdentity } }, null, 2)}\n`;
}

export async function readPluginConfigStore(options: {
  platform?: PlatformTarget;
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
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
        scope: options.scope,
        sourceIdentity: options.sourceIdentity,
        logicalIdentity: options.logicalIdentity,
        pluginName: options.pluginName,
        platform: options.platform,
      })
    : readStoreFile(filePath, options.platform);
}

export async function readNamespacedPluginConfigStoreIdentity(options: {
  platform?: PlatformTarget;
  sourceId: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  binding: PluginConfigEnvelopeV6['binding'];
  store: PluginConfigStore;
} | null> {
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'read' as const } : {}),
  });
  if (!await inspectConfigReadTarget(resolvePluginConfigAllowedRoot(options), filePath)) return null;
  const parsed = await parseStoreJson(filePath);
  if (parsed.state === 'invalidJson') {
    throw new Error(`${parsed.store.invalidCode}: invalid namespaced plugin config store.`);
  }
  const envelope = readPluginConfigEnvelopeV6(parsed.value, options.scope);
  if (!envelope
    || envelope.sourceId !== options.sourceId
    || envelope.pluginName !== options.pluginName) {
    throw new Error('schemaVersionUnsupported: invalid namespaced plugin config store.');
  }
  const store = documentStore({ filePath, common: envelope.common, platforms: envelope.platforms, platform: options.platform });
  assertReadyPluginConfigStore(store);
  return {
    binding: envelope.binding,
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
  const storeRoots = [path.join(resolveAwHome(options.env), CONFIG_DIR)];
  const pluginNames = (await Promise.all(
    storeRoots.map((storeRoot) => listConfigStoreDirectoryPluginNames(storeRoot)),
  )).flat();
  return [...new Set(pluginNames)].sort((left, right) =>
    left.localeCompare(right),
  );
}

export interface NamespacedPluginConfigStoreInventoryEntry {
  sourceId: string;
  binding: PluginConfigEnvelopeV6['binding'];
  pluginName: string;
  pluginId: string;
  values: Record<string, PluginConfigValue>;
}

export interface NamespacedPluginConfigStoreIdentity {
  sourceId: string;
  pluginName: string;
  pluginId: string;
}

export async function listNamespacedPluginConfigStoreIdentities(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope: Scope;
}): Promise<NamespacedPluginConfigStoreIdentity[]> {
  const boundaryRoot = resolveAwHome(options.env);
  if (options.scope === 'user') {
    await canonicalizePathThroughExistingAncestor(boundaryRoot);
  } else {
    await fs.realpath(boundaryRoot);
  }
  const storeRoot = path.join(
    boundaryRoot,
    CONFIG_DIR,
  );
  if (!await inspectConfigInventoryStoreRoot(boundaryRoot, storeRoot)) return [];
  const output: NamespacedPluginConfigStoreIdentity[] = [];
  for (const sourceEntry of await fs.readdir(storeRoot, { withFileTypes: true })) {
    if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) continue;
    let sourceId: string;
    try {
      sourceId = assertSafePluginConfigSegment(sourceEntry.name);
    } catch {
      continue;
    }
    const sourceRoot = path.join(storeRoot, sourceId);
    let pluginEntries: fs.Dirent[];
    try {
      await assertNoConfigSymlink(boundaryRoot, sourceRoot);
      pluginEntries = await fs.readdir(sourceRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pluginEntry of pluginEntries) {
      if (!pluginEntry.isDirectory() || pluginEntry.isSymbolicLink()) continue;
      let pluginName: string;
      try {
        pluginName = assertSafePluginConfigSegment(pluginEntry.name);
        await assertNoConfigSymlink(boundaryRoot, path.join(sourceRoot, pluginName));
      } catch {
        continue;
      }
      let target: fs.Stats | null;
      try {
        target = await lstatIfExists(path.join(sourceRoot, pluginName, CONFIG_FILE));
      } catch {
        continue;
      }
      if (!target) continue;
      output.push({ sourceId, pluginName, pluginId: `${sourceId}/${pluginName}` });
    }
  }
  return output.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export async function listNamespacedPluginConfigStores(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope: Scope;
}): Promise<NamespacedPluginConfigStoreInventoryEntry[]> {
  const boundaryRoot = resolveAwHome(options.env);
  if (options.scope === 'user') {
    await canonicalizePathThroughExistingAncestor(boundaryRoot);
  } else {
    await fs.realpath(boundaryRoot);
  }
  const storeRoot = path.join(
    boundaryRoot,
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
      const envelope = readPluginConfigEnvelopeV6(parsed.value, options.scope);
      if (!envelope
        || envelope.sourceId !== sourceId
        || envelope.pluginName !== pluginName) {
        throw new Error(`schemaVersionUnsupported: invalid namespaced plugin config store "${filePath}".`);
      }
      const store = documentStore({ filePath, common: envelope.common, platforms: envelope.platforms });
      assertReadyPluginConfigStore(store);
      output.push({
        sourceId,
        binding: envelope.binding,
        pluginName,
        pluginId: `${sourceId}/${pluginName}`,
        values: store.values,
      });
    }
  }
  return output.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export async function writePluginConfigStore(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; pluginName: string;
  scope: Scope; platform?: PlatformTarget; cwd: string; values: Record<string, unknown>; env?: NodeJS.ProcessEnv;
}): Promise<PluginConfigStoreReceipt & { warnings: string[] }> {
  const current = await readPluginConfigStore(options);
  assertReadyPluginConfigStore(current);
  const validated = validateStoreValues({ filePath: current.path, values: options.values });
  assertReadyPluginConfigStore(validated);
  return commitPluginConfigLayer(options, current, validated.values);
}

async function commitPluginConfigLayer(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; pluginName: string;
  scope: Scope; platform?: PlatformTarget; cwd: string; env?: NodeJS.ProcessEnv;
}, current: PluginConfigStore, values: Record<string, PluginConfigValue>): Promise<PluginConfigStoreReceipt & { warnings: string[] }> {
  const next = replacePluginConfigStoreLayer(current, values, options.platform);
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  await withConfigFileMutation({ filePath: current.path, allowedRoot, action: async () => {
    if (!next.exists) await atomicRemoveConfigFile({ filePath: current.path, allowedRoot });
    else await atomicReplaceConfigFile({ filePath: current.path, allowedRoot,
      content: namespacedConfigContent({ ...options, common: next.common!, platforms: next.platforms! }), mode: 0o600 });
  } });
  return { pluginName: options.pluginName, scope: 'user', platform: options.platform, path: current.path, warnings: [] };
}

export async function patchPluginConfigStore(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; pluginName: string;
  scope: Scope; platform?: PlatformTarget; cwd: string; updates: Record<string, PluginConfigValue>;
  removeKeys?: string[]; requireExistingRemoveKeys?: boolean; env?: NodeJS.ProcessEnv;
  schema?: PluginConfigSchema['fields']; reviewPreflight?: () => Promise<void> | void;
}): Promise<PluginConfigStoreReceipt & { updatedKeys: string[]; removedKeys: string[]; warnings: string[] }> {
  await options.reviewPreflight?.();
  const current = await readPluginConfigStore(options);
  assertReadyPluginConfigStore(current);
  const removedKeys = options.removeKeys ?? [];
  if (options.requireExistingRemoveKeys) {
    const missing = removedKeys.find((key) => !Object.hasOwn(current.values, key));
    if (missing) throw new Error(`Unknown config key "${missing}".`);
  }
  const next = Object.assign(Object.create(null) as Record<string, PluginConfigValue>, current.values);
  for (const key of removedKeys) delete next[key];
  for (const [key, value] of Object.entries(options.updates)) next[key] = value;
  const validated = validateStoreValues({ filePath: current.path, values: next });
  assertReadyPluginConfigStore(validated);
  return { ...await commitPluginConfigLayer(options, current, validated.values), updatedKeys: Object.keys(options.updates), removedKeys };
}

interface ResetPluginConfigStoreOptions {
  platform?: PlatformTarget;
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  reviewPreflight?: () => Promise<void> | void;
}

export async function resetPluginConfigStore(options: ResetPluginConfigStoreOptions): Promise<ResetPluginConfigStoreReceipt> {
  return resetPluginConfigStoreTarget(options, false);
}

/** Delete the plugin's complete user document, including every platform profile. */
export async function deletePluginConfigStore(options: Omit<ResetPluginConfigStoreOptions, 'platform'>): Promise<ResetPluginConfigStoreReceipt> {
  return resetPluginConfigStoreTarget(options, true);
}

async function resetPluginConfigStoreTarget(options: ResetPluginConfigStoreOptions, wholeDocument: boolean): Promise<ResetPluginConfigStoreReceipt> {
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const publicTarget = `${options.scope}/plugin-config/${[
    options.sourceId,
    options.pluginName,
    CONFIG_FILE,
  ].filter(Boolean).join('/')}`;
  const { root, candidate } = assertConfigPathBoundary(allowedRoot, filePath);
  let current = root;
  try {
    for (const segment of path.relative(root, path.dirname(candidate)).split(path.sep).filter(Boolean)) {
      const stats = await lstatIfExists(current);
      if (!stats) {
        return {
          pluginName: options.pluginName,
          scope: 'user',
          storeKind: 'user',
          path: filePath,
          existed: false,
          deleted: false,
          resetDisposition: 'absent',
        };
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new PluginConfigResetError(
          'configResetTargetUnsupported',
          `${publicTarget} has an unsafe ancestor. Repair it manually, then retry config reset.`,
        );
      }
      current = path.join(current, segment);
    }
    const parentStats = await lstatIfExists(current);
    if (!parentStats) {
      return {
        pluginName: options.pluginName,
        scope: 'user',
        storeKind: 'user',
        path: filePath,
        existed: false,
        deleted: false,
        resetDisposition: 'absent',
      };
    }
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new PluginConfigResetError(
        'configResetTargetUnsupported',
        `${publicTarget} has an unsafe ancestor. Repair it manually, then retry config reset.`,
      );
    }
    await options.reviewPreflight?.();
    const target = await lstatIfExists(filePath);
    if (!target) {
      return {
        pluginName: options.pluginName,
        scope: 'user',
        storeKind: 'user',
        path: filePath,
        existed: false,
        deleted: false,
        resetDisposition: 'absent',
      };
    }
    let store: PluginConfigStore | undefined;
    if (target.isFile()) {
      try {
        store = await readPluginConfigStore(options);
      } catch {
        // A broken document still has the schema-independent reset recovery below.
      }
    }
    if (!wholeDocument && store && store.state !== 'invalid' && replacePluginConfigStoreLayer(store, {}, options.platform).exists) {
      await commitPluginConfigLayer(options, store, {});
      return { pluginName: options.pluginName, scope: 'user', platform: options.platform, storeKind: 'user',
        path: filePath, existed: true, deleted: false, resetDisposition: 'clearedLayer' };
    }
    if (target.isFile() || target.isSymbolicLink()) {
      await assertNoConfigSymlink(allowedRoot, path.dirname(filePath));
      await nodeFs.unlink(filePath);
      return {
        pluginName: options.pluginName,
        scope: 'user',
        storeKind: 'user',
        path: filePath,
        existed: true,
        deleted: true,
        resetDisposition: target.isSymbolicLink() ? 'unlinkedSymlink' : 'deletedFile',
      };
    }
    if (target.isDirectory()) {
      const timestamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '');
      const quarantineBasename = `config.broken-${timestamp}-${crypto.randomUUID()}.json`;
      await assertNoConfigSymlink(allowedRoot, path.dirname(filePath));
      await nodeFs.rename(filePath, path.join(path.dirname(filePath), quarantineBasename));
      return {
        pluginName: options.pluginName,
        scope: 'user',
        storeKind: 'user',
        path: filePath,
        existed: true,
        deleted: true,
        resetDisposition: 'quarantinedDirectory',
        quarantineBasename,
      };
    }
    throw new PluginConfigResetError(
      'configResetTargetUnsupported',
      `${publicTarget} is a special filesystem node. Move it manually, then retry config reset.`,
    );
  } catch (error) {
    if (error instanceof PluginConfigResetError) throw error;
    const osCode = (error as NodeJS.ErrnoException).code;
    throw new PluginConfigResetError(
      'configResetFailed',
      `Cannot reset ${publicTarget}${osCode ? ` (${osCode})` : ''}. Fix filesystem access, then retry config reset.`,
      osCode,
    );
  }
}

export async function inspectPluginConfigResetTarget(options: {
  sourceId?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginConfigResetTargetInspection> {
  const filePath = resolvePluginConfigStorePath({
    ...options,
    ...(options.scope === 'project' ? { access: 'write' as const } : {}),
  });
  const allowedRoot = resolvePluginConfigAllowedRoot(options);
  const publicTarget = `${options.scope}/plugin-config/${[
    options.sourceId,
    options.pluginName,
    CONFIG_FILE,
  ].filter(Boolean).join('/')}`;
  const { root, candidate } = assertConfigPathBoundary(allowedRoot, filePath);
  let current = root;
  for (const segment of path.relative(root, path.dirname(candidate)).split(path.sep).filter(Boolean)) {
    const stats = await lstatIfExists(current);
    if (!stats) return resetTargetInspection('absent');
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new PluginConfigResetError(
        'configResetTargetUnsupported',
        `${publicTarget} has an unsafe ancestor. Repair it manually, then retry config reset.`,
      );
    }
    current = path.join(current, segment);
  }
  const parentStats = await lstatIfExists(current);
  if (!parentStats) return resetTargetInspection('absent');
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new PluginConfigResetError(
      'configResetTargetUnsupported',
      `${publicTarget} has an unsafe ancestor. Repair it manually, then retry config reset.`,
    );
  }
  const target = await lstatIfExists(filePath);
  if (!target) return resetTargetInspection('absent');
  const kind = target.isSymbolicLink() ? 'symbolicLink'
    : target.isFile() ? 'regularFile'
    : target.isDirectory() ? 'directory'
    : 'special';
  return resetTargetInspection(kind, target);
}

function resetTargetInspection(
  kind: PluginConfigResetTargetKind,
  stats?: fs.Stats,
): PluginConfigResetTargetInspection {
  const fingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    kind,
    ...(stats ? {
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    } : {}),
  })).digest('hex')}`;
  return {
    exists: kind !== 'absent',
    kind,
    resettable: kind !== 'special',
    fingerprint,
  };
}

export async function resetPluginConfigStores(options: {
  platform?: PlatformTarget;
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResetPluginConfigStoreReceipt[]> {
  return [await resetPluginConfigStore(options)];
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
async function applyConfigLayer(options: {
  values: Record<string, PluginConfigValue>;
  redactedValues: Record<string, RedactedPluginConfigValue>;
  sources: Record<string, PluginConfigSource>;
  fieldStates: Record<string, PluginConfigFieldState>;
  schema: PluginConfigSchema['fields'];
  entries: Record<string, unknown>;
  source: Exclude<PluginConfigSource, 'missing'>;
}): Promise<void> {
  for (const [key, field] of Object.entries(options.schema)) {
    if (!Object.hasOwn(options.entries, key)) {
      continue;
    }

    const value = options.entries[key] as PluginConfigValue;
    const validationIssues = validateCorePluginConfigValue(field, value, key);
    if (validationIssues.length === 0) {
      const redactedValue = redactValue(field, value);
      options.values[key] = value;
      options.redactedValues[key] = redactedValue;
      options.sources[key] = options.source;
      options.fieldStates[key] = {
        effective: { value, redactedValue, source: options.source },
      };
    } else {
      const fallback = options.fieldStates[key]?.effective;
      delete options.values[key];
      delete options.redactedValues[key];
      options.sources[key] = options.source;
      const issues = validationIssues.map((issue): PluginConfigIssue => ({
        type: 'invalid-config',
        key,
        source: options.source,
        message: formatPluginConfigIssue(issue),
      }));
      options.fieldStates[key] = {
        invalidOverride: { source: options.source, issues },
        ...(fallback ? { fallback } : {}),
      };
    }
  }
}

export async function resolveEffectivePluginConfig(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; pluginName?: string;
  manifest: NormalizedPluginManifest; platform?: PlatformTarget; targetScope?: Scope; context?: Scope;
  cwd: string; env?: NodeJS.ProcessEnv; referencePlugins?: readonly PluginMeta[];
  referenceContext?: PluginConfigReferenceContext;
}): Promise<ResolvedEffectivePluginConfig> {
  const workContext = options.context ? await resolveWorkContext({ cwd: options.cwd, context: options.context }) : undefined;
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
  const user = await readPluginConfigStore({ ...options, pluginName, scope: 'user' });
  assertReadyPluginConfigStore(user);
  const references = !options.referenceContext && pluginConfigHasExternalReferences(options.manifest)
    ? await resolvePluginConfigReferenceContext({ ...options, scope: options.context ?? options.targetScope ?? 'user', plugins: options.referencePlugins }) : undefined;
  return resolveEffectivePluginConfigFromStores({ ...options, pluginName, projectRoot: workContext?.projectRoot ?? ((options.context ?? options.targetScope) === 'project' ? resolveAwProjectRoot(options.cwd) : ''),
    referenceContext: options.referenceContext ?? references?.context, referenceEvidence: references?.evidence,
    stores: { user } });
}

export async function resolveEffectivePluginConfigFromStores(options: {
  platform?: PlatformTarget;
  context?: Scope;
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  targetScope?: Scope;
  projectRoot: string;
  referenceContext?: PluginConfigReferenceContext;
  referenceEvidence?: PluginConfigReferenceEvidence[];
  stores: {
    user: PluginConfigStore;
    project?: PluginConfigStore;
  };
}): Promise<ResolvedEffectivePluginConfig> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
  const definition = options.manifest.config ? selectPluginConfigProfile(options.manifest.config, options.platform) : undefined;
  const schema = definition?.fields;
  if (!schema) {
    throw new PluginConfigSchemaResolutionError('configSchemaUnavailable', `Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  const userStore = options.stores.user;
  assertReadyPluginConfigStore(userStore);

  const values: Record<string, PluginConfigValue> = {};
  const redactedValues: Record<string, RedactedPluginConfigValue> = {};
  const sources: Record<string, PluginConfigSource> = {};
  const fieldStates: Record<string, PluginConfigFieldState> = {};
  const ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[] = [];
  const unsupportedLayerOverrides: UnsupportedPluginConfigLayerOverride[] = [];
  const dangerousKeyIssues: PluginConfigIssue[] = [];
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
      fieldStates,
      schema: { [key]: field },
      entries: { [key]: field.default },
      source: 'default',
    });
  }

  const layers: Array<{ entries: Record<string, PluginConfigValue>; source: 'common' | 'platform' }> = [
    { entries: userStore.common ?? userStore.values, source: 'common' },
    ...(options.platform ? [{ entries: userStore.platforms?.[options.platform] ?? {}, source: 'platform' as const }] : []),
  ];
  for (const { entries, source } of layers) {
    const plainEntries = getStoreEntries(entries);
    const dangerousIssues = new Map(validatePluginConfigDocument(definition!, plainEntries)
      .filter((issue) => issue.code === 'dangerousKey').map((issue) => [issue.path.field, issue] as const));
    for (const key of Object.keys(plainEntries)) {
      if (schemaKeys.has(key)) continue;
      const dangerousIssue = dangerousIssues.get(key);
      if (dangerousIssue) dangerousKeyIssues.push({ type: 'invalid-config', code: dangerousIssue.code,
        key, source, message: formatPluginConfigIssue(dangerousIssue) });
      else ignoredUnknownKeys.push({ scope: 'user', source, key });
    }
    await applyConfigLayer({
      values,
      redactedValues,
      sources,
      fieldStates,
      schema,
      entries: plainEntries,
      source,
    });
  }

  const candidateValues: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const source = sources[key];
    if (source === 'default') candidateValues[key] = field.default;
    if (source === 'common') candidateValues[key] = ownStoreValue(userStore.common ?? userStore.values, key);
    if (source === 'platform' && options.platform) candidateValues[key] = ownStoreValue(userStore.platforms?.[options.platform] ?? {}, key);
  }
  const candidateIssues = validatePluginConfigCandidate(
    definition!, candidateValues, undefined, options.referenceContext,
  );
  const referenceIssues = candidateIssues.filter((issue) => issue.code.startsWith('valueRef')
    && (!issue.path.plugin || issue.path.plugin === pluginName));
  const missingReferenceIssues: PluginConfigIssue[] = [];
  for (const issue of referenceIssues) {
    const key = issue.path.field;
    const source = sources[key]!;
    const state = fieldStates[key];
    const configIssue: PluginConfigIssue = {
      type: 'invalid-config', code: issue.code, key, source,
      message: formatPluginConfigIssue(issue),
    };
    if (source === 'missing') {
      missingReferenceIssues.push(configIssue);
      continue;
    }
    delete values[key];
    delete redactedValues[key];
    fieldStates[key] = {
      invalidOverride: { source, issues: [...(state?.invalidOverride?.issues ?? []), configIssue] },
      ...(state?.fallback ? { fallback: state.fallback } : {}),
    };
  }

  // Provider errors stay private, while each field that reads them remains unusable.
  if (options.referenceContext) {
    for (const foreign of candidateIssues.filter((issue) => issue.code.startsWith('valueRef')
      && issue.path.plugin && issue.path.plugin !== pluginName)) {
      for (const key of schemaKeys) {
        let dependencies;
        try {
          dependencies = getPluginConfigDependencyFields(definition!, [key], options.referenceContext);
        } catch {
          continue; // The local association issue already reports the invalid schema.
        }
        if (!dependencies.some((entry) => entry.plugin === foreign.path.plugin && entry.field === foreign.path.field)) continue;
        const source = sources[key]!;
        const state = fieldStates[key];
        const configIssue: PluginConfigIssue = { type: 'invalid-config', code: 'valueRefSource', key, source,
          message: `Config "${key}" depends on invalid config "${foreign.path.plugin}/${foreign.path.field}". Fix the dependency before using this field.` };
        if (state?.invalidOverride?.issues.some((issue) => issue.code === configIssue.code && issue.message === configIssue.message)) continue;
        delete values[key];
        delete redactedValues[key];
        if (source === 'missing') missingReferenceIssues.push(configIssue);
        else fieldStates[key] = { invalidOverride: { source, issues: [...(state?.invalidOverride?.issues ?? []), configIssue] },
          ...(state?.fallback ? { fallback: state.fallback } : {}) };
      }
    }
  }

  // Consumers must retain dependency failures after invalid source values are omitted.
  const invalidKeys = new Set([
    ...Object.entries(fieldStates).filter(([, state]) => state.invalidOverride !== undefined).map(([key]) => key),
    ...missingReferenceIssues.map((issue) => issue.key),
  ]);
  for (const key of schemaKeys) {
    if (invalidKeys.has(key)) continue;
    const dependency = getPluginConfigDependencyKeys(definition!, [key])
      .find((dependencyKey) => dependencyKey !== key && invalidKeys.has(dependencyKey));
    if (dependency === undefined) continue;
    const source = sources[key]!;
    const configIssue: PluginConfigIssue = {
      type: 'invalid-config', code: 'valueRefSource', key, source,
      message: `Config "${key}" depends on invalid config "${dependency}". Fix the dependency before using this field.`,
    };
    delete values[key];
    delete redactedValues[key];
    if (source === 'missing') {
      missingReferenceIssues.push(configIssue);
    } else {
      const state = fieldStates[key];
      fieldStates[key] = {
        invalidOverride: { source, issues: [configIssue] },
        ...(state?.fallback ? { fallback: state.fallback } : {}),
      };
    }
  }

  const issues = [
    ...Object.values(fieldStates).flatMap((state) => state.invalidOverride?.issues ?? []),
    ...dangerousKeyIssues,
    ...missingReferenceIssues,
  ];
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && values[key] === undefined && !fieldStates[key]?.invalidOverride) {
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
    platform: options.platform,
    context: options.context ?? options.targetScope ?? 'user',
    definition: definition!,
    projectRoot: options.projectRoot,
    values,
    redactedValues,
    sources,
    fieldStates,
    issues,
    unsupportedLayerOverrides,
    ignoredUnknownKeys,
    schema,
    stores: {
      user: userStore,
    },
    ...(options.referenceContext ? { referenceContext: options.referenceContext } : {}),
    ...(options.referenceEvidence ? { referenceEvidence: options.referenceEvidence } : {}),
  };
}

function ownStoreValue(values: Record<string, PluginConfigValue>, key: string): unknown {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/** Check cross-field relations before saving one complete layer candidate. */
export async function assertPluginConfigMutationCandidate(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; pluginName: string;
  manifest: NormalizedPluginManifest; scope: Scope; platform?: PlatformTarget;
  cwd: string; env?: NodeJS.ProcessEnv; updates: Record<string, PluginConfigValue>; removeKeys: readonly string[];
  referencePlugins?: readonly PluginMeta[];
}): Promise<void> {
  const user = await readPluginConfigStore({ ...options, scope: 'user' });
  assertReadyPluginConfigStore(user);
  const values = { ...user.values };
  for (const key of options.removeKeys) delete values[key];
  for (const [key, value] of Object.entries(options.updates)) values[key] = value;
  const candidate = replacePluginConfigStoreLayer(user, values, options.platform);
  const profiles: Array<PlatformTarget | undefined> = options.platform ? [options.platform] : [undefined, ...PLATFORM_TARGETS];
  for (const platform of profiles) {
    const references = pluginConfigHasExternalReferences(options.manifest)
      ? await resolvePluginConfigReferenceContext({ ...options, platform, plugins: options.referencePlugins }) : undefined;
    const resolve = (store: PluginConfigStore) => resolveEffectivePluginConfigFromStores({ ...options, platform,
      targetScope: options.scope, projectRoot: options.scope === 'project' ? resolveAwProjectRoot(options.cwd) : '', stores: { user: store }, referenceContext: references?.context });
    const [before, after] = await Promise.all([resolve(user), resolve(candidate)]);
    const existing = new Set(before.issues.map((issue) => `${issue.key}\0${issue.code}\0${issue.message}`));
    const editedKeys = new Set([...Object.keys(options.updates), ...options.removeKeys]);
    const issues = after.issues.filter((issue) => (editedKeys.has(issue.key) && Object.hasOwn(options.updates, issue.key))
      || !existing.has(`${issue.key}\0${issue.code}\0${issue.message}`));
    if (issues.length) throw Object.assign(new Error(`configReferenceInvalid: ${platform ?? 'common'}: ${issues.map((issue) => issue.message).join(' ')}`), { code: 'configReferenceInvalid' });
  }
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
    const coerced = await coercePluginConfigValue({
      key,
      field,
      value,
    });
    output[key] = coerced;
  }

  return output;
}

export async function resolveProjectArtifactRenderConfig(options: {
  platform?: PlatformTarget;
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  pluginName?: string;
  manifest: NormalizedPluginManifest;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedProjectArtifactRenderConfig> {
  if (!options.manifest.config?.fields) {
    const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.manifest.name);
    const [userStore] = await Promise.all([
      readPluginConfigStore({
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        logicalIdentity: options.logicalIdentity,
        pluginName,
        scope: 'user',
        cwd: options.cwd,
        env: options.env,
      }),
    ]);
    assertReadyPluginConfigStore(userStore);
    return {
      pluginName,
      projectRoot: resolveAwProjectRoot(options.cwd),
      values: {},
      sources: {},
      issues: [],
      unsupportedLayerOverrides: [],
      ignoredUnknownKeys: [],
      schema: {},
      stores: { user: userStore },
    };
  }
  const effective = await resolveEffectivePluginConfig({
    ...options,
    targetScope: 'project',
  });
  return {
    pluginName: effective.pluginName,
    projectRoot: effective.projectRoot,
    values: effective.values,
    sources: effective.sources,
    issues: effective.issues,
    unsupportedLayerOverrides: effective.unsupportedLayerOverrides,
    ignoredUnknownKeys: effective.ignoredUnknownKeys,
    schema: effective.schema,
    stores: {
      user: effective.stores.user!,
    },
  };
}

function toConfigSourceLayer(source: PluginConfigSource | undefined): ConfigFieldEntry['sourceLayer'] {
  return source === undefined || source === 'missing' ? null : source;
}

function configFieldProjection(options: {
  field: PluginConfigSchemaField;
  value?: PluginConfigValue;
  source?: PluginConfigSource;
  issues?: PluginConfigIssue[];
}): Pick<ConfigFieldEntry, 'value' | 'source' | 'matchedPreset' | 'valid' | 'issues'> {
  const source = options.source ?? 'missing';
  const issues = options.issues ?? [];
  const presetSensitive = options.field.sensitive === true
    || (options.field.type === 'object'
      && (Object.values(options.field.properties ?? {}).some((child) => child.sensitive === true)
        || (options.field.additionalProperties !== false
          && options.field.additionalProperties?.sensitive === true)));
  return {
    value: options.value === undefined ? null : redactValue(options.field, options.value),
    source,
    matchedPreset: options.value === undefined || presetSensitive
      ? null
      : matchPluginConfigPreset(options.field, options.value)?.id ?? null,
    valid: issues.length === 0,
    issues,
  };
}

async function buildManifestFieldEntries(options: {
  context?: Scope;
  plugin: PluginMeta;
  scope: Scope | 'effective';
  platform?: PlatformTarget;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntry[]> {
  const effective = await resolveEffectivePluginConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity,
    manifest: options.plugin.manifest,
    platform: options.platform,
    targetScope: options.context ?? (options.scope === 'project' ? 'project' : 'user'),
    cwd: options.cwd,
    env: options.env,
  });
  const stored = pluginConfigStoreForProfile(effective.stores.user!, options.platform).values;
  const fields = await Promise.all(Object.entries(effective.schema).map(async ([key, field]): Promise<ConfigFieldEntry> => {
    const state = effective.fieldStates[key];
    const source = effective.sources[key] ?? 'missing';
    const issues = effective.issues.filter((issue) => issue.key === key);
    const hasStored = Object.hasOwn(stored, key);
    const storedSourceLayer = options.platform ? 'platform' as const : 'common' as const;
    let fallback: ConfigFieldEntry['fallback'];
    if (hasStored) {
      const inherited = { ...stored };
      delete inherited[key];
      const withoutOverride = await resolveEffectivePluginConfigFromStores({
        manifest: options.plugin.manifest,
        platform: options.platform,
        projectRoot: effective.projectRoot,
        stores: { user: replacePluginConfigStoreLayer(effective.stores.user!, inherited, options.platform) },
        referenceContext: effective.referenceContext,
      });
      const fallbackIssues = withoutOverride.issues.filter((issue) => issue.key === key);
      const fallbackSource = withoutOverride.sources[key];
      fallback = fallbackSource === 'missing' || fallbackSource === undefined
        ? { state: 'missing' }
        : fallbackIssues.length
          ? { state: 'invalid', sourceLayer: fallbackSource, issues: fallbackIssues }
          : { state: 'valid', sourceLayer: fallbackSource, effectiveValue: withoutOverride.redactedValues[key] };
    }
    return {
      key,
      title: field.title ?? key,
      kind: 'manifest',
      reserved: false,
      writable: true,
      canSet: true,
      canUnset: hasStored,
      valueState: issues.length ? 'invalid' : source === 'default' || source === 'missing' ? 'default' : 'configured',
      effectiveValue: effective.redactedValues[key] ?? null,
      sourceLayer: toConfigSourceLayer(source),
      ...(hasStored ? { storedSourceLayer, ...(validateCorePluginConfigValue(field, stored[key], key).length
        ? {} : { storedValue: redactValue(field, stored[key]!) }) } : {}),
      ...(state?.invalidOverride ? { invalidOverride: { sourceLayer: state.invalidOverride.source, issues: state.invalidOverride.issues } } : {}),
      ...(fallback ? { fallback } : {}),
      ...configFieldProjection({ field, value: effective.values[key], source, issues }),
    };
  }));
  for (const key of Object.keys(stored).filter((key) => !Object.hasOwn(effective.schema, key)).sort()) {
    const source = options.platform ? 'platform' as const : 'common' as const;
    fields.push({ key, title: key, kind: 'manifest', reserved: false, writable: false, canSet: false, canUnset: true,
      valueState: 'configured', effectiveValue: '[redacted]', sourceLayer: source, storedSourceLayer: source,
      value: '[redacted]', source, matchedPreset: null, valid: false, issues: [] });
  }
  return fields;
}

async function buildLegacyStoreFieldEntries(options: {
  sourceId?: string; sourceIdentity?: string; logicalIdentity?: string; pluginName: string;
  scope: Scope | 'effective'; platform?: PlatformTarget; cwd: string; env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntry[]> {
  const store = await readPluginConfigStore({ ...options, scope: 'user' });
  const source = options.platform ? 'platform' as const : 'common' as const;
  return Object.keys(store.values).sort().map((key) => ({ key, title: key, kind: 'manifest', reserved: false,
    writable: false, canSet: false, canUnset: true, valueState: 'configured', effectiveValue: '[redacted]',
    sourceLayer: source, value: '[redacted]', source, matchedPreset: null, valid: true, issues: [] }));
}

export async function resolvePluginConfigSchemaAccess(options: {
  platform?: PlatformTarget;
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
      options.platform,
    ),
  };
}

export async function resolveConfigRead(options: {
  context?: Scope;
  platform?: PlatformTarget;
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  pluginName: string;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  scope: Scope | 'effective';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedConfigRead> {
  if (options.context) await resolveWorkContext({ cwd: options.cwd, context: options.context });
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    currentPluginError: options.pluginError,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });


  const manifestFields = schemaAccess.plugin
    ? await buildManifestFieldEntries({
        plugin: schemaAccess.plugin,
        context: options.context,
        platform: options.platform,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      })
    : await buildLegacyStoreFieldEntries({
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        logicalIdentity: options.logicalIdentity,
        pluginName,
        scope: options.scope,
        platform: options.platform,
        cwd: options.cwd,
        env: options.env,
      });

  return {
    pluginName,
    platform: options.platform,
    context: options.context ?? 'user',
    scope: options.scope,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    ...(schemaAccess.plugin?.manifest.config?.fields
      ? { fieldDefinitions: selectPluginConfigProfile(schemaAccess.plugin.manifest.config, options.platform).fields }
      : {}),
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
  fieldStates: Record<string, {
    effective?: { value: RedactedPluginConfigValue; source: Exclude<PluginConfigSource, 'missing'> };
    invalidOverride?: PluginConfigFieldState['invalidOverride'];
    fallback?: { value: RedactedPluginConfigValue; source: Exclude<PluginConfigSource, 'missing'> };
  }>;
  issues: PluginConfigIssue[];
  ignoredUnknownKeys: IgnoredUnknownPluginConfigKey[];
} {
  return {
    values: config.redactedValues,
    sources: config.sources,
    fieldStates: Object.fromEntries(Object.entries(config.fieldStates).map(([key, state]) => [key, {
      ...(state.effective ? {
        effective: { value: state.effective.redactedValue, source: state.effective.source },
      } : {}),
      ...(state.invalidOverride ? { invalidOverride: state.invalidOverride } : {}),
      ...(state.fallback ? {
        fallback: { value: state.fallback.redactedValue, source: state.fallback.source },
      } : {}),
    }])),
    issues: config.issues,
    ignoredUnknownKeys: config.ignoredUnknownKeys,
  };
}

export function createPluginConfigSchemaIdentity(
  manifest: NormalizedPluginManifest,
  platform?: PlatformTarget,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      platform: platform ?? null,
      config: manifest.config ? selectPluginConfigProfile(manifest.config, platform) : null,
    }))
    .digest('hex');
  return `${manifest.name}:${hash}`;
}

function cliConfigPromptEnumValues(
  field: Exclude<PluginConfigSchemaField, { type: 'object' | 'array' }>,
): Array<string | number | boolean> | undefined {
  if (!field.choices) return undefined;
  const values: Array<string | number | boolean> = field.choices.presets
    .map((preset) => preset.value);
  if (field.type !== 'boolean') {
    return field.choices.allowCustom ? undefined : values;
  }
  if (field.choices.allowCustom) {
    for (const value of [true, false]) {
      if (!values.includes(value)) values.push(value);
    }
  }
  return values;
}

export function toCliConfigPromptSchema(schema: PluginConfigSchema['fields']): CliConfigPromptSchema {
  const promptSchema: CliConfigPromptSchema = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.type === 'object' || field.type === 'array') continue;
    promptSchema[key] = {
      type: field.type,
      label: field.title ?? key,
      description: field.description,
      required: field.required,
      sensitive: field.sensitive,
      default: field.default,
      enum: cliConfigPromptEnumValues(field),
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
  const schema = options.effective.schema;
  if (!schema) {
    throw new PluginConfigSchemaResolutionError('configSchemaUnavailable', `Plugin "${options.pluginName ?? options.manifest.name}" does not declare an AW config schema.`);
  }

  const requiredKeys = [...new Set(
    options.effective.issues
      .filter((issue) => issue.type === 'missing-required' || issue.type === 'invalid-config')
      .map((issue) => issue.key),
  )];
  const fields: PluginConfigFormFieldModel[] = Object.entries(schema).flatMap(([key, field]) => {
    if (field.type === 'object' || field.type === 'array') return [];
    return [{
      key,
      type: field.type,
      label: field.title ?? key,
      description: field.description,
      required: field.required === true,
      sensitive: field.sensitive === true,
      defaultValue: field.default,
      enumValues: cliConfigPromptEnumValues(field),
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
    allowedScopes: ['user'],
    initialScope: 'user',
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

export function formatPluginConfigSetRecoveryCommand(
  pluginName: string,
  key: string,
  field: PluginConfigSchemaField,
  context: Scope,
  platform?: PlatformTarget,
): string {
  const command = `aw plugin config set ${pluginName} ${key} --context ${context}`
    + (platform ? ` --platform ${platform}` : '');
  return field.sensitive === true ? `${command} --value-stdin` : `${command} --value-json '<json>'`;
}

function formatRequiredConfigSetCommands(
  pluginName: string,
  issues: PluginConfigIssue[],
  context: Scope,
  schema: PluginConfigSchema['fields'],
  platform?: PlatformTarget,
): string {
  const commands = new Set<string>();
  for (const issue of issues) {
    const field = schema[issue.key];
    if (field) commands.add(formatPluginConfigSetRecoveryCommand(pluginName, issue.key, field, context, platform));
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
    const identity = target.schemaSourceIdentity ?? createPluginConfigSchemaIdentity(target.manifest, target.platform);
    const dedupeKey = `${pluginName}\0${target.platform ?? 'common'}\0${identity}`;
    if (visited.has(dedupeKey)) {
      continue;
    }
    visited.add(dedupeKey);
    result.checked += 1;

    if (!target.manifest.config?.fields) {
      continue;
    }

    const effective = await resolveEffectivePluginConfig({
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      logicalIdentity: target.logicalIdentity,
      pluginName,
      manifest: target.manifest,
      platform: target.platform,
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
      target.sourceId ? `${target.sourceId}/${pluginName}` : pluginName,
      blockingIssues,
      options.defaultScope,
      effective.schema,
      target.platform,
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
