import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CliConfigPromptOptions,
  CliConfigPromptSchema,
  CommandExecutionContext,
} from '../commands/runtime.js';
import type {
  ConfigFieldEntryV2,
  LegacyConfigStoreEntryV2,
  PluginConfigSchema,
  PluginConfigSchemaField,
  PluginManifestSource,
  PluginMeta,
  Scope,
  SkillTriggerPreference,
} from '../types.js';
import { resolveSkillTriggerConfigEntries } from './skill-trigger-preferences.js';
import { resolveAwHome, resolveRepoRootSync } from './paths.js';

export type PluginConfigValue = string | number | boolean;
export type PluginConfigSource = 'default' | 'user' | 'project' | 'projectLocal' | 'missing';
export type PluginConfigIssueType = 'missing-required' | 'invalid-config';
export type ProjectConfigStoreLayer = 'shared' | 'local';

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
  existed: boolean;
  deleted: boolean;
}

export interface RequiredPluginConfigPreflightTarget {
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

export interface ResolvedConfigReadV2 {
  pluginName: string;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  fields: ConfigFieldEntryV2[];
  legacyConfigStores: LegacyConfigStoreEntryV2[];
}

const CONFIG_DIR = 'plugin-config';
const CONFIG_FILE = 'config.json';
const RESERVED_AW_NAMESPACE = '$aw';
const BUILT_IN_SKILL_TRIGGER_PREFIX = 'aw.skillTriggers.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function isBuiltInConfigKey(key: string): boolean {
  return parseBuiltInSkillTriggerKey(key) !== null;
}

export function parseBuiltInSkillTriggerKey(
  key: string,
): { skillName: string } | null {
  if (!key.startsWith(BUILT_IN_SKILL_TRIGGER_PREFIX) || !key.endsWith('.trigger')) {
    return null;
  }
  const skillName = key.slice(
    BUILT_IN_SKILL_TRIGGER_PREFIX.length,
    key.length - '.trigger'.length,
  ).trim();
  return skillName === '' ? null : { skillName };
}

export function toBuiltInSkillTriggerLogicalKey(skillName: string): string {
  return `${BUILT_IN_SKILL_TRIGGER_PREFIX}${skillName}.trigger`;
}

function getNonReservedStoreEntries(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== RESERVED_AW_NAMESPACE),
  );
}

interface StoredSkillTriggerValue {
  skillName: string;
  trigger: Exclude<SkillTriggerPreference, 'default'>;
}

function readStoredSkillTriggers(values: Record<string, unknown>): StoredSkillTriggerValue[] {
  const awNamespace = values[RESERVED_AW_NAMESPACE];
  if (!isRecord(awNamespace)) {
    return [];
  }
  const skillTriggers = awNamespace.skillTriggers;
  if (!isRecord(skillTriggers)) {
    return [];
  }

  const stored: StoredSkillTriggerValue[] = [];
  for (const [skillName, entry] of Object.entries(skillTriggers)) {
    if (!isRecord(entry)) {
      continue;
    }
    const trigger = entry.trigger;
    if (trigger !== 'manual' && trigger !== 'auto') {
      continue;
    }
    stored.push({
      skillName,
      trigger,
    });
  }
  return stored.sort((left, right) => left.skillName.localeCompare(right.skillName));
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

export function resolvePluginConfigStorePath(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): string {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const root = options.scope === 'user'
    ? resolveAwHome(options.env)
    : path.join(resolveAwProjectRoot(options.cwd), '.agent-workflows');
  const configDir = options.scope === 'project' && options.projectLayer === 'local'
    ? 'plugin-config.local'
    : CONFIG_DIR;

  return path.join(root, configDir, pluginName, CONFIG_FILE);
}

async function readStoreFile(filePath: string): Promise<Record<string, unknown>> {
  const value = await fs.readJson(filePath);
  if (!isRecord(value)) {
    throw new Error(`Invalid plugin config store "${filePath}": expected a JSON object.`);
  }
  return value;
}

export async function readPluginConfigStore(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<PluginConfigStore> {
  const filePath = resolvePluginConfigStorePath(options);
  if (!(await fs.pathExists(filePath))) {
    return {
      path: filePath,
      exists: false,
      values: {},
    };
  }

  return {
    path: filePath,
    exists: true,
    values: await readStoreFile(filePath),
  };
}

async function listConfigStoreDirectoryPluginNames(storeRoot: string): Promise<string[]> {
  if (!(await fs.pathExists(storeRoot))) {
    return [];
  }

  const entries = await fs.readdir(storeRoot, { withFileTypes: true });
  const pluginNames: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const pluginName = assertSafePluginConfigSegment(entry.name);
      if (await fs.pathExists(path.join(storeRoot, pluginName, CONFIG_FILE))) {
        pluginNames.push(pluginName);
      }
    } catch {
      continue;
    }
  }
  return pluginNames;
}

export async function listPluginConfigStorePluginNames(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [user, projectShared, projectLocal] = await Promise.all([
    listConfigStoreDirectoryPluginNames(path.join(resolveAwHome(options.env), CONFIG_DIR)),
    listConfigStoreDirectoryPluginNames(path.join(projectRoot, '.agent-workflows', CONFIG_DIR)),
    listConfigStoreDirectoryPluginNames(path.join(projectRoot, '.agent-workflows', 'plugin-config.local')),
  ]);
  return [...new Set([...user, ...projectShared, ...projectLocal])].sort((left, right) =>
    left.localeCompare(right),
  );
}

export async function writePluginConfigStore(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  values: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<PluginConfigStoreReceipt> {
  const filePath = resolvePluginConfigStorePath(options);
  await fs.ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.writeJson(tempPath, options.values, { spaces: 2 });
  try {
    await fs.chmod(tempPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  await fs.move(tempPath, filePath, { overwrite: true });
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }

  return {
    pluginName: options.pluginName,
    scope: options.scope,
    path: filePath,
  };
}

export async function patchPluginConfigStore(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  updates: Record<string, unknown>;
  removeKeys?: string[];
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<PluginConfigStoreReceipt & { updatedKeys: string[]; removedKeys: string[] }> {
  const current = await readPluginConfigStore(options);
  const next = { ...current.values };
  const removedKeys = options.removeKeys ?? [];
  for (const key of removedKeys) {
    delete next[key];
  }
  for (const [key, value] of Object.entries(options.updates)) {
    next[key] = value;
  }

  const receipt = await writePluginConfigStore({
    pluginName: options.pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    values: next,
    projectLayer: options.projectLayer,
  });

  return {
    ...receipt,
    updatedKeys: Object.keys(options.updates),
    removedKeys,
  };
}

export async function resetPluginConfigStore(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectLayer?: ProjectConfigStoreLayer;
}): Promise<ResetPluginConfigStoreReceipt> {
  const filePath = resolvePluginConfigStorePath(options);
  const existed = await fs.pathExists(filePath);
  if (existed) {
    await fs.remove(filePath);
  }

  return {
    pluginName: options.pluginName,
    scope: options.scope,
    path: filePath,
    existed,
    deleted: existed,
  };
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

function sourceForScope(scope: Scope): PluginConfigSource {
  return scope;
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
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
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
    const plainEntries = getNonReservedStoreEntries(store.values);
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
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
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

  const projectPlainEntries = getNonReservedStoreEntries(projectStore.values);
  const userPlainEntries = getNonReservedStoreEntries(userStore.values);
  const projectLocalPlainEntries = getNonReservedStoreEntries(projectLocalStore.values);

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
    const localPlainEntries = getNonReservedStoreEntries(effective.stores.projectLocal.values);
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

    const userPlainEntries = getNonReservedStoreEntries(effective.stores.user.values);
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

    const projectPlainEntries = getNonReservedStoreEntries(effective.stores.project.values);
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

    const localPlainEntries = getNonReservedStoreEntries(effective.stores.projectLocal.values);
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
): ConfigFieldEntryV2['sourceLayer'] {
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

function buildLegacyConfigStoreEntries(options: {
  pluginName: string;
  pluginAvailable: boolean;
  schema: PluginConfigSchema['schema'] | undefined;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  projectRoot: string;
  stores: ResolvedEffectivePluginConfig['stores'];
}): LegacyConfigStoreEntryV2[] {
  const schemaKeys = new Set(Object.keys(options.schema ?? {}));
  const entries: LegacyConfigStoreEntryV2[] = [];
  for (const [storeKind, store] of [
    ['user', options.stores.user],
    ['projectShared', options.stores.project],
    ['projectLocal', options.stores.projectLocal],
  ] as const) {
    if (options.scope === 'user' && storeKind !== 'user') {
      continue;
    }
    if (options.scope === 'project' && options.projectLayer === 'shared' && storeKind === 'projectLocal') {
      continue;
    }
    if (options.scope === 'project' && options.projectLayer === 'local' && storeKind !== 'projectLocal') {
      continue;
    }
    const plainEntries = getNonReservedStoreEntries(store.values);
    const hasLegacyPlainKeys = Object.keys(plainEntries).some((key) => !schemaKeys.has(key));
    if (!hasLegacyPlainKeys) {
      continue;
    }
    entries.push({
      plugin: options.pluginName,
      storeKind,
      ...(storeKind === 'user' ? {} : { projectRoot: options.projectRoot }),
      reason: options.pluginAvailable ? 'schemaUnavailable' : 'pluginRemoved',
      fieldVisibility: 'storeOnly',
      cleanupOnly: true,
    });
  }
  return entries;
}

async function buildManifestFieldEntries(options: {
  plugin: PluginMeta;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigFieldEntryV2[]> {
  const schema = options.plugin.manifest.config?.schema;
  if (!schema) {
    return [];
  }

  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [userStore, projectStore, projectLocalStore] = await Promise.all([
    readPluginConfigStore({
      pluginName: options.plugin.manifest.name,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      pluginName: options.plugin.manifest.name,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      pluginName: options.plugin.manifest.name,
      scope: 'project',
      projectLayer: 'local',
      cwd: options.cwd,
      env: options.env,
    }),
  ]);
  const userPlainEntries = getNonReservedStoreEntries(userStore.values);
  const projectPlainEntries = getNonReservedStoreEntries(projectStore.values);
  const localPlainEntries = getNonReservedStoreEntries(projectLocalStore.values);
  const effective = await resolveEffectivePluginConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });

  const fields: ConfigFieldEntryV2[] = [];
  for (const [key, field] of Object.entries(schema)) {
    const base: ConfigFieldEntryV2 = {
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

    const source = effective.sources[key];
    const layer = toConfigSourceLayer(source);
    if (source === 'default') {
      fields.push({
        ...base,
        effectiveValue: effective.redactedValues[key] ?? null,
        sourceLayer: 'default',
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
      });
      continue;
    }
    fields.push(base);
  }

  return fields;
}

function createBuiltInFieldTitle(skillName: string): string {
  return `${skillName} 触发方式`;
}

export async function resolveConfigReadV2(options: {
  pluginName: string;
  plugin?: PluginMeta | null;
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedConfigReadV2> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const [userStore, projectStore, projectLocalStore] = await Promise.all([
    readPluginConfigStore({
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    readPluginConfigStore({
      pluginName,
      scope: 'project',
      projectLayer: 'local',
      cwd: options.cwd,
      env: options.env,
    }),
  ]);
  const stores = {
    user: userStore,
    project: projectStore,
    projectLocal: projectLocalStore,
  };
  const legacyConfigStores = buildLegacyConfigStoreEntries({
    pluginName,
    pluginAvailable: Boolean(options.plugin),
    schema: options.plugin?.manifest.config?.schema,
    scope: options.scope,
    projectLayer: options.projectLayer,
    projectRoot,
    stores,
  });

  const manifestFields = options.plugin
    ? await buildManifestFieldEntries({
        plugin: options.plugin,
        scope: options.scope,
        projectLayer: options.projectLayer,
        cwd: options.cwd,
        env: options.env,
      })
    : [];

  const knownSkillEntries = options.plugin
    ? await resolveSkillTriggerConfigEntries(options.plugin)
    : [];
  const knownSkillMap = new Map(knownSkillEntries.map((entry) => [entry.skillName, entry]));
  const userStored = new Map(readStoredSkillTriggers(userStore.values).map((entry) => [entry.skillName, entry.trigger]));
  const projectStored = new Map(readStoredSkillTriggers(projectStore.values).map((entry) => [entry.skillName, entry.trigger]));
  const localStored = new Map(readStoredSkillTriggers(projectLocalStore.values).map((entry) => [entry.skillName, entry.trigger]));
  const builtInFields: ConfigFieldEntryV2[] = [];

  for (const entry of knownSkillEntries) {
    const base = {
      key: toBuiltInSkillTriggerLogicalKey(entry.skillName),
      title: createBuiltInFieldTitle(entry.skillName),
      kind: 'builtIn' as const,
      reserved: true,
    };

    if (options.projectLayer === 'local') {
      const storedLocalValue = localStored.get(entry.skillName);
      if (storedLocalValue) {
        builtInFields.push({
          ...base,
          writable: false,
          valueState: 'invalid',
          effectiveValue: entry.defaultTrigger,
          sourceLayer: 'default',
          storedValue: storedLocalValue,
          storedSourceLayer: 'local',
          invalidReason: 'unsupportedProjectLocalLayer',
        });
      }
      continue;
    }

    if (options.scope === 'user') {
      const storedValue = userStored.get(entry.skillName);
      if (!entry.allowDynamicTrigger) {
        builtInFields.push({
          ...base,
          writable: false,
          valueState: storedValue ? 'ignored' : 'fixed',
          effectiveValue: entry.defaultTrigger,
          sourceLayer: 'default',
          ...(storedValue
            ? {
                storedValue,
                storedSourceLayer: 'user' as const,
                ignoredReason: 'fixedSkillTrigger' as const,
              }
            : {}),
        });
        continue;
      }
      builtInFields.push({
        ...base,
        writable: true,
        valueState: storedValue ? 'configured' : 'default',
        effectiveValue: storedValue ?? entry.defaultTrigger,
        sourceLayer: storedValue ? 'user' : 'default',
      });
      continue;
    }

    if (options.scope === 'project') {
      const storedProjectValue = projectStored.get(entry.skillName);
      const storedLocalValue = localStored.get(entry.skillName);
      if (storedLocalValue) {
        builtInFields.push({
          ...base,
          writable: false,
          valueState: 'invalid',
          effectiveValue: storedProjectValue ?? entry.defaultTrigger,
          sourceLayer: storedProjectValue ? 'project' : 'default',
          storedValue: storedLocalValue,
          storedSourceLayer: 'local',
          invalidReason: 'unsupportedProjectLocalLayer',
        });
        continue;
      }
      if (!entry.allowDynamicTrigger) {
        builtInFields.push({
          ...base,
          writable: false,
          valueState: storedProjectValue ? 'ignored' : 'fixed',
          effectiveValue: entry.defaultTrigger,
          sourceLayer: 'default',
          ...(storedProjectValue
            ? {
                storedValue: storedProjectValue,
                storedSourceLayer: 'project' as const,
                ignoredReason: 'fixedSkillTrigger' as const,
              }
            : {}),
        });
        continue;
      }
      builtInFields.push({
        ...base,
        writable: true,
        valueState: storedProjectValue ? 'configured' : 'default',
        effectiveValue: storedProjectValue ?? entry.defaultTrigger,
        sourceLayer: storedProjectValue ? 'project' : 'default',
      });
      continue;
    }

    const storedProjectValue = projectStored.get(entry.skillName);
    const storedUserValue = userStored.get(entry.skillName);
    if (!entry.allowDynamicTrigger) {
      const storedValue = storedProjectValue ?? storedUserValue;
      const storedSourceLayer = storedProjectValue ? 'project' : storedUserValue ? 'user' : undefined;
      builtInFields.push({
        ...base,
        writable: false,
        valueState: storedValue ? 'ignored' : 'fixed',
        effectiveValue: entry.defaultTrigger,
        sourceLayer: 'default',
        ...(storedValue && storedSourceLayer
          ? {
              storedValue,
              storedSourceLayer,
              ignoredReason: 'fixedSkillTrigger' as const,
            }
          : {}),
      });
      continue;
    }
    builtInFields.push({
      ...base,
      writable: true,
      valueState: storedProjectValue || storedUserValue ? 'configured' : 'default',
      effectiveValue: storedProjectValue ?? storedUserValue ?? entry.defaultTrigger,
      sourceLayer: storedProjectValue ? 'project' : storedUserValue ? 'user' : 'default',
    });
  }

  for (const [storeKind, storedMap] of [
    ['user', userStored],
    ['project', projectStored],
    ['local', localStored],
  ] as const) {
    for (const [skillName, storedValue] of storedMap.entries()) {
      if (knownSkillMap.has(skillName)) {
        continue;
      }
      builtInFields.push({
        key: toBuiltInSkillTriggerLogicalKey(skillName),
        title: createBuiltInFieldTitle(skillName),
        kind: 'builtIn',
        reserved: true,
        writable: false,
        valueState: storeKind === 'local' ? 'invalid' : 'orphaned',
        effectiveValue: storeKind === 'local' ? null : null,
        sourceLayer: null,
        storedValue,
        storedSourceLayer: storeKind,
        ...(storeKind === 'local'
          ? { invalidReason: 'unsupportedProjectLocalLayer' as const }
          : { orphanedReason: options.plugin ? 'skillRemoved' as const : 'pluginRemoved' as const }),
      });
    }
  }

  const dedupedBuiltInFields = [...new Map(
    builtInFields.map((field) => [field.key, field]),
  ).values()].sort((left, right) => left.key.localeCompare(right.key));

  return {
    pluginName,
    scope: options.scope,
    projectLayer: options.projectLayer,
    fields: [...manifestFields, ...dedupedBuiltInFields],
    legacyConfigStores,
  };
}

export function findConfigFieldEntry(
  fields: ConfigFieldEntryV2[],
  key: string,
): ConfigFieldEntryV2 | null {
  return fields.find((field) => field.key === key) ?? null;
}

export function hasConfigReadV2Content(result: ResolvedConfigReadV2): boolean {
  return result.fields.length > 0 || result.legacyConfigStores.length > 0;
}

export async function resolveUniformSkillTriggerPreference(options: {
  plugin: PluginMeta;
  platform: 'codex' | 'claude';
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillTriggerPreference> {
  const entries = (await resolveSkillTriggerConfigEntries(options.plugin))
    .filter((entry) => entry.platforms.includes(options.platform));
  if (entries.length === 0) {
    return 'default';
  }

  const store = await readPluginConfigStore({
    pluginName: options.plugin.manifest.name,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer: 'shared' as const } : {}),
  });
  const stored = new Map(
    readStoredSkillTriggers(store.values).map((entry) => [entry.skillName, entry.trigger]),
  );
  const effectivePreferences = new Set<Exclude<SkillTriggerPreference, 'default'>>();
  for (const entry of entries) {
    effectivePreferences.add(
      entry.allowDynamicTrigger
        ? (stored.get(entry.skillName) ?? entry.defaultTrigger)
        : entry.defaultTrigger,
    );
  }

  if (effectivePreferences.size === 1) {
    return [...effectivePreferences][0]!;
  }
  if (effectivePreferences.size === 0) {
    return 'default';
  }
  throw new Error(
    `${options.plugin.manifest.name} 在 ${options.platform}/${options.scope} 下包含多个不同的 SkillTrigger effective 值，当前 apply pipeline 还不能把它们合并成单一偏好。`,
  );
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
      currentValue: field.sensitive ? undefined : options.effective.values[key],
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
