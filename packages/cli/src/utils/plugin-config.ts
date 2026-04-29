import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CliConfigPromptSchema,
  CommandExecutionContext,
} from '../commands/runtime.js';
import { validateCliConfigPromptResult } from '../commands/runtime.js';
import type {
  PluginConfigSchema,
  PluginConfigSchemaField,
  PluginManifestSource,
  Scope,
} from '../types.js';
import { resolveAwHome, resolveRepoRootSync } from './paths.js';

export type PluginConfigValue = string | number | boolean;
export type PluginConfigSource = 'default' | 'user' | 'project' | 'missing';
export type PluginConfigIssueType = 'missing-required' | 'invalid-config';

export interface PluginConfigIssue {
  type: PluginConfigIssueType;
  key: string;
  source?: PluginConfigSource;
  message: string;
}

export interface IgnoredUnknownPluginConfigKey {
  scope: Scope;
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
  stores: Record<Scope, PluginConfigStore>;
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

const CONFIG_DIR = 'plugin-config';
const CONFIG_FILE = 'config.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
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
}): string {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const root = options.scope === 'user'
    ? resolveAwHome(options.env)
    : path.join(resolveAwProjectRoot(options.cwd), '.agent-workflows');

  return path.join(root, CONFIG_DIR, pluginName, CONFIG_FILE);
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

export async function writePluginConfigStore(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  values: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
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
  const [userStore, projectStore] = await Promise.all([
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

  for (const [scope, store] of [
    ['user', userStore],
    ['project', projectStore],
  ] as const) {
    for (const key of Object.keys(store.values)) {
      if (!schemaKeys.has(key)) {
        ignoredUnknownKeys.push({ scope, key });
      }
    }
    await applyConfigLayer({
      values,
      redactedValues,
      sources,
      invalidIssues,
      schema,
      entries: store.values,
      source: sourceForScope(scope),
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

function toPromptSchema(schema: PluginConfigSchema['schema']): CliConfigPromptSchema {
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

    if (!options.interactive || !options.context.interactive || !options.context.prompt.configurePlugin) {
      const details = blockingIssues.map((issue) => issue.key).join(', ');
      throw new Error(
        `${pluginName} requires valid AW config before install/upgrade: ${details}. Run \`aw config configure ${pluginName}\` or \`aw config set ${pluginName} <key> <value>\`.`,
      );
    }

    const requiredKeys = [...new Set(blockingIssues.map((issue) => issue.key))];
    const promptResult = validateCliConfigPromptResult(
      {
        allowedScopes: ['user', 'project'],
        schema: toPromptSchema(target.manifest.config.schema),
      },
      await options.context.prompt.configurePlugin({
        pluginName,
        schema: toPromptSchema(target.manifest.config.schema),
        initialScope: options.defaultScope,
        allowedScopes: ['user', 'project'],
        currentValues: effective.values,
        requiredKeys,
      }),
    );
    if (promptResult.cancelled) {
      throw new Error(`Config setup for ${pluginName} was cancelled.`);
    }

    const updates = await coercePluginConfigUpdates({
      schema: target.manifest.config.schema,
      updates: promptResult.updates,
      cwd: options.cwd,
    });
    await patchPluginConfigStore({
      pluginName,
      scope: promptResult.selectedScope,
      cwd: options.cwd,
      env: options.context.env,
      updates,
    });
    result.prompted += 1;
    result.written.push({
      pluginName,
      scope: promptResult.selectedScope,
      updatedKeys: promptResult.updatedKeys,
    });

    effective = await resolveEffectivePluginConfig({
      pluginName,
      manifest: target.manifest,
      cwd: options.cwd,
      env: options.context.env,
    });
    if (effective.issues.some((issue) => issue.type === 'missing-required' || issue.type === 'invalid-config')) {
      throw new Error(
        `${pluginName} still has invalid AW config after configuration: ${effective.issues.map((issue) => `${issue.key} (${issue.type})`).join(', ')}.`,
      );
    }
  }

  return result;
}

export function renderPluginConfigValueForDisplay(value: unknown): string {
  return formatValue(value);
}
