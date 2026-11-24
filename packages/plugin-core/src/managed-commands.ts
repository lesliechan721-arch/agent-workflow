import { createHash } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { applyPlatformOverride } from './platform-entries.js';
import { getPluginConfigDependencyKeys, selectPluginConfigProfile } from './plugin-config.js';
import { NATIVE_PLATFORM_TARGETS, resolveSupportedNativePlatforms, resolveSupportedPlatforms } from './platform-support.js';
import { isSkillAuthorOnlyPath } from './skill-authoring.js';
import { DEFAULT_NATIVE_TOOL_READER, normalizeNativeToolClosure, type NativeToolClosure } from './native-tools.js';
import { assertStrictSemVer } from './strict-semver.js';
import type { NormalizedPluginManifest, PlatformName, PlatformTarget } from './types.js';

export interface CommandLaunch {
  runner: 'node' | 'executable';
  entry: string;
  args: string[];
  env: Record<string, string>;
  envFrom: Record<string, string>;
  cwd: 'caller' | 'resource';
}

export interface CommandSubcommand extends CommandLaunch { name: string }
export interface CommandRoutes { subcommands: CommandSubcommand[]; fallback?: CommandLaunch }
export interface ManagedCommandPermission { argsPrefix: string[] }
export type PermissionCommand = string | ManagedCommandPermission;

interface PluginCommandBase {
  sourceDir: string;
  platforms: PlatformName[];
  runtimeConfig?: { keys: string[] };
}

export type PluginCommand = PluginCommandBase & (
  | { mode: 'static'; routes: CommandRoutes }
  | { mode: 'dynamic'; refreshKeys: string[] }
);

export interface ProducerIdentity {
  sourceId: string; sourceIdentity: string; pluginName: string;
}

export interface InstalledCommandProducer {
  schemaVersion: 2;
  producer: ProducerIdentity;
  pluginVersion: string;
  sourceContentDigest: string;
  routes: CommandRoutes;
  dynamicRefreshKeys?: string[];
  routeConfigDigest?: string;
  routeConfigKeyDigests?: Record<string, string>;
  nativeTools?: NativeToolClosure;
  runtimeConfigPlatforms: PlatformName[];
  runtimeConfigKeys?: string[];
  runtimeConfigCommonDigests?: Partial<Record<PlatformName, string>>;
}

export interface UserCommandDefinition {
  schemaVersion: 1; id: string; name: string; packageRevision: string; launch: CommandLaunch;
}

export interface CommandRoutesArtifact {
  id: 'command-routes';
  target: 'aw.command-routes';
  kind: 'commandRoutes';
  refreshKeys: string[];
  routes: CommandRoutes;
}

export interface ManagedCommandArtifactTargetDefinition {
  id: 'command-routes';
  target: 'aw.command-routes';
  kind: 'commandRoutes';
  surface: { kind: 'aw'; name: 'managed-commands' };
  scopes: ['user'];
  refreshKeys: string[];
}

export const COMMAND_PRODUCER_RECORD_FILE = '.aw-command-producer.json';
export const COMMAND_RUNTIME_CONFIG_READER = '.aw/command-runtime-config.mjs';
export const MANAGED_COMMAND_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
export const SAFE_PERMISSION_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const USER_COMMAND_ID = /^cmdu_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_ID = /^pkg_[0-9a-f]{64}$/u;
const PACKAGE_PROTECTED_NAMES = new Set(['.git', 'node_modules', '.agents-plugin', '.codex-plugin', '.claude-plugin', '.release', '.tmp', 'evals', 'reports', COMMAND_PRODUCER_RECORD_FILE, '.agent-workflows-owner.json', '.aw-runtime-config.json', 'aw-plugin-requirements.json']);
const PACKAGE_OUTPUT_ROOTS = new Set(['codex', 'claude', 'agent-skills']);

const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const LAUNCH_FIELDS = ['runner', 'entry', 'args', 'env', 'envFrom', 'cwd'] as const;

export function getCommandPackageInjectedReaders(
  manifest: Pick<NormalizedPluginManifest, 'command' | 'nativeTools'>,
): { sourceDir: string; paths: string[] } | undefined {
  const command = manifest.command;
  if (!command) return undefined;
  const paths: string[] = [];
  if (command.runtimeConfig) paths.push(COMMAND_RUNTIME_CONFIG_READER);
  if (manifest.nativeTools?.consumers.some((consumer) => consumer.kind === 'plugin-command')) {
    paths.push(DEFAULT_NATIVE_TOOL_READER.slice(2));
  }
  return paths.length ? { sourceDir: command.sourceDir.slice(2), paths } : undefined;
}

export function isInjectedCommandReaderImport(
  readers: ReturnType<typeof getCommandPackageInjectedReaders>,
  importer: string,
  requestedPath: string,
): boolean {
  return readers !== undefined
    && importer.startsWith(`${readers.sourceDir}/`)
    && readers.paths.some((file) => requestedPath === path.posix.join(readers.sourceDir, file));
}

function object(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}: expected an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${field}: unknown field ${JSON.stringify(key)}.`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) || value.includes('\0')) {
    throw new Error(`Invalid ${field}: expected a Unicode string without NUL.`);
  }
  if (maxLength !== undefined && [...value].length > maxLength) throw new Error(`Invalid ${field}: string is too long.`);
  return value;
}
function nonempty(value: unknown, field: string): string {
  const result = text(value, field);
  if (result.length === 0) throw new Error(`Invalid ${field}: expected a non-empty string.`);
  return result;
}
function name(value: unknown, field: string): string {
  const result = text(value, field);
  if (!MANAGED_COMMAND_NAME_PATTERN.test(result)) throw new Error(`Invalid ${field}: expected a managed command Name.`);
  return result;
}
function enumeration<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error(`Invalid ${field}: expected ${values.join(' | ')}.`);
  return value as T;
}
function strings(value: unknown, field: string, unique = false): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}: expected an array.`);
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`));
  if (unique && new Set(result).size !== result.length) throw new Error(`Invalid ${field}: duplicate value.`);
  return result;
}
export function normalizeCommandRelativeFile(value: unknown, field = 'entry'): string {
  const result = nonempty(value, field);
  if (result.startsWith('/') || /^[A-Za-z]:/u.test(result) || /[\\\u0000-\u001f\u007f-\u009f]/u.test(result)
    || result.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid ${field}: expected a safe relative file path.`);
  }
  return result;
}
function environmentMap(value: unknown, field: string, source: boolean): Record<string, string> {
  const input = object(value, field, Object.keys((value && typeof value === 'object') ? value : {}));
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!ENVIRONMENT_NAME.test(key)) throw new Error(`Invalid ${field}: invalid environment name.`);
    const normalized = text(entry, `${field}.${key}`, 4096);
    if (source && !ENVIRONMENT_NAME.test(normalized)) throw new Error(`Invalid ${field}.${key}: expected an environment name.`);
    Object.defineProperty(result, key, { value: normalized, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function protectedEnvironmentName(value: string): boolean {
  return /^(?:AW_PLUGIN_|AW_SUBAGENT_|AW_COMMAND_|AW_NATIVE_)/u.test(value.toUpperCase())
    || ['AW_AGENT_SKILL_EVAL_PROCESS_MARKER', 'AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME'].includes(value.toUpperCase());
}
export function validateCommandEnvironment(
  env: Record<string, string>, envFrom: Record<string, string>, platform: NodeJS.Platform = process.platform,
): void {
  const literal = environmentMap(env, 'env', false);
  const inherited = environmentMap(envFrom, 'envFrom', true);
  for (const key of [...Object.keys(literal), ...Object.keys(inherited), ...Object.values(inherited)]) {
    if (protectedEnvironmentName(key)) throw new Error('Invalid command environment: protected environment name.');
  }
  const targetKeys = [...Object.keys(literal), ...Object.keys(inherited)].map((key) => platform === 'win32' ? key.toUpperCase() : key);
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error('Invalid command environment: duplicate target name.');
}
export function normalizeCommandLaunch(value: unknown, field = 'command launch'): CommandLaunch {
  const input = object(value, field, LAUNCH_FIELDS);
  const args = input.args === undefined ? [] : strings(input.args, `${field}.args`);
  if (args.length > 128 || args.some((arg) => [...arg].length > 4096)) throw new Error(`Invalid ${field}.args: argument limit exceeded.`);
  const env = input.env === undefined ? {} : environmentMap(input.env, `${field}.env`, false);
  const envFrom = input.envFrom === undefined ? {} : environmentMap(input.envFrom, `${field}.envFrom`, true);
  validateCommandEnvironment(env, envFrom);
  return {
    runner: enumeration(input.runner, `${field}.runner`, ['node', 'executable']),
    entry: normalizeCommandRelativeFile(input.entry, `${field}.entry`), args, env, envFrom,
    cwd: input.cwd === undefined ? 'caller' : enumeration(input.cwd, `${field}.cwd`, ['caller', 'resource']),
  };
}
export function normalizeCommandRoutes(value: unknown, field = 'command.routes'): CommandRoutes {
  return normalizeRoutes(value, field);
}

function normalizeRoutes(value: unknown, field: string, installed = false): CommandRoutes {
  const input = object(value, field, ['subcommands', 'fallback']);
  const subcommands = input.subcommands === undefined && !installed ? [] : input.subcommands;
  if (!Array.isArray(subcommands)) throw new Error(`Invalid ${field}.subcommands: expected an array.`);
  const entries = subcommands.map((entry, index): CommandSubcommand => {
    const label = `${field}.subcommands[${index}]`;
    const { name: entryName, ...launch } = object(entry, label, ['name', ...LAUNCH_FIELDS]);
    return { name: name(entryName, `${label}.name`), ...normalizeRouteLaunch(launch, label, installed) };
  });
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error(`Invalid ${field}.subcommands: duplicate command name.`);
  }
  if (input.fallback === undefined) return { subcommands: entries };
  return { subcommands: entries, fallback: normalizeRouteLaunch(input.fallback, `${field}.fallback`, installed) };
}

function normalizeRouteLaunch(value: unknown, field: string, installed: boolean): CommandLaunch {
  if (installed) requireLaunchDefaults(object(value, field, LAUNCH_FIELDS), field);
  const launch = normalizeCommandLaunch(value, field);
  if (launch.entry.split('/').some(isProtectedCommandPath) || isSkillAuthorOnlyPath(launch.entry)) {
    throw new Error(`Invalid ${field}.entry: protected or author-only path.`);
  }
  return launch;
}

function requireLaunchDefaults(launch: Record<string, unknown>, field: string): void {
  if (['args', 'env', 'envFrom', 'cwd'].some((key) => !Object.hasOwn(launch, key) || launch[key] === undefined)) {
    throw new Error(`Invalid ${field}: installed launch must include defaults.`);
  }
}

export function normalizeManagedCommandPermission(value: unknown, field = 'command permission'): ManagedCommandPermission {
  const input = object(value, field, ['argsPrefix']);
  const argsPrefix = strings(input.argsPrefix, `${field}.argsPrefix`);
  if (argsPrefix.some((token) => !SAFE_PERMISSION_TOKEN.test(token))) {
    throw new Error(`Invalid ${field}.argsPrefix: expected safe non-empty tokens.`);
  }
  return { argsPrefix };
}

function configKeys(value: unknown, field: string, requireNonempty = false): string[] {
  const keys = strings(value, field, true);
  if ((requireNonempty && keys.length === 0) || keys.some((key) => key.length === 0)) {
    throw new Error(`Invalid ${field}: expected non-empty config keys.`);
  }
  return keys;
}

function nativePlatforms(value: unknown, field: string): PlatformName[] {
  return strings(value, field, true).map((platform) => enumeration(platform, field, NATIVE_PLATFORM_TARGETS));
}

function isProtectedCommandPath(segment: string): boolean {
  // The injected directory must also stay reserved on case-insensitive filesystems.
  return segment.toLowerCase() === '.aw' || PACKAGE_PROTECTED_NAMES.has(segment);
}

export function normalizePluginCommand(value: unknown, manifest: Pick<NormalizedPluginManifest, 'platforms'>): PluginCommand {
  const baseFields = ['sourceDir', 'platforms', 'mode', 'runtimeConfig'];
  const input = object(value, 'command', [...baseFields, 'routes', 'refreshKeys']);
  const mode = enumeration(input.mode, 'command.mode', ['static', 'dynamic']);
  object(value, 'command', [...baseFields, mode === 'static' ? 'routes' : 'refreshKeys']);
  const sourceDir = nonempty(input.sourceDir, 'command.sourceDir');
  if (!sourceDir.startsWith('./')) throw new Error('Invalid command.sourceDir: expected ./ plugin-relative directory.');
  const relativePath = normalizeCommandRelativeFile(sourceDir.slice(2), 'command.sourceDir');
  const parts = relativePath.split('/');
  if (PACKAGE_OUTPUT_ROOTS.has(parts[0]!) || parts.some(isProtectedCommandPath) || isSkillAuthorOnlyPath(relativePath)) {
    throw new Error('Invalid command.sourceDir: protected or author-only directory.');
  }
  const supported = resolveSupportedNativePlatforms(manifest);
  const platforms = input.platforms === undefined ? [...supported] : nativePlatforms(input.platforms, 'command.platforms');
  if (platforms.length === 0 || platforms.some((platform) => !supported.has(platform))) {
    throw new Error('Invalid command.platforms: expected a non-empty subset of supported Native platforms.');
  }
  const runtimeConfig = input.runtimeConfig === undefined ? undefined : {
    keys: configKeys(object(input.runtimeConfig, 'command.runtimeConfig', ['keys']).keys, 'command.runtimeConfig.keys', true),
  };
  const base = { sourceDir, platforms, ...(runtimeConfig ? { runtimeConfig } : {}) };
  return mode === 'static'
    ? { ...base, mode, routes: normalizeCommandRoutes(input.routes) }
    : { ...base, mode, refreshKeys: configKeys(input.refreshKeys, 'command.refreshKeys') };
}

function normalizeDigest(value: unknown, field: string): string {
  const digest = nonempty(value, field);
  if (!DIGEST.test(digest)) throw new Error(`Invalid ${field}: expected a SHA-256 digest.`);
  return digest;
}

function normalizeCommandNameParts(source: unknown, plugin: unknown, field: string): Pick<ProducerIdentity, 'sourceId' | 'pluginName'> {
  const sourceId = nonempty(source, `${field}.sourceId`);
  if (!SOURCE_ID.test(sourceId)) throw new Error(`Invalid ${field}.sourceId.`);
  const pluginName = nonempty(plugin, `${field}.pluginName`);
  if (!PLUGIN_NAME.test(pluginName)) throw new Error(`Invalid ${field}.pluginName.`);
  return { sourceId, pluginName };
}

export function normalizeCommandSelector(value: unknown): Pick<ProducerIdentity, 'sourceId' | 'pluginName'> {
  const parts = text(value, 'command selector').split('/');
  if (parts.length !== 2) throw new Error('Invalid command selector: expected <source/plugin>.');
  return normalizeCommandNameParts(parts[0], parts[1], 'command selector');
}

export function parseCommandInvocationSelector(value: unknown): { packageSelector: string; platform?: PlatformName } {
  const parts = text(value, 'command invocation selector').split('/');
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error('Invalid command invocation selector: expected <source/plugin> or <source/plugin/platform>.');
  }
  const { sourceId, pluginName } = normalizeCommandNameParts(parts[0], parts[1], 'command invocation selector');
  const packageSelector = `${sourceId}/${pluginName}`;
  if (parts.length === 2) return { packageSelector };
  return { packageSelector, platform: enumeration(parts[2], 'command invocation selector platform', NATIVE_PLATFORM_TARGETS) };
}

export function normalizeCommandInvocationSelector(value: unknown): string {
  const { packageSelector, platform } = parseCommandInvocationSelector(value);
  return platform === undefined ? packageSelector : `${packageSelector}/${platform}`;
}

export function getManagedCommandInvocationSelectors(
  packageSelector: string,
  requiresPlatformContext: boolean | null,
  platforms: readonly PlatformName[],
): string[] {
  if (requiresPlatformContext === null) return [];
  return requiresPlatformContext ? platforms.map((platform) => `${packageSelector}/${platform}`) : [packageSelector];
}

export function normalizeProducerIdentity(value: unknown, field = 'producer identity'): ProducerIdentity {
  const input = object(value, field, ['sourceId', 'sourceIdentity', 'pluginName']);
  return {
    ...normalizeCommandNameParts(input.sourceId, input.pluginName, field),
    sourceIdentity: normalizeDigest(input.sourceIdentity, `${field}.sourceIdentity`),
  };
}
export function canonicalizeIdentityValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalizeIdentityValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeIdentityValue(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function getCommandPackageId(producer: ProducerIdentity): string {
  const identity = canonicalizeIdentityValue({ schemaVersion: 2, ...normalizeProducerIdentity(producer) });
  return `pkg_${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export function isUserCommandId(value: unknown): value is string { return typeof value === 'string' && USER_COMMAND_ID.test(value); }
export function isCommandPackageId(value: unknown): value is string { return typeof value === 'string' && PACKAGE_ID.test(value); }

export function normalizeInstalledCommandProducer(value: unknown): InstalledCommandProducer {
  const field = 'command producer record';
  const input = object(value, field, [
    'schemaVersion', 'producer', 'pluginVersion', 'sourceContentDigest', 'routes',
    'dynamicRefreshKeys', 'routeConfigDigest', 'routeConfigKeyDigests', 'nativeTools',
    'runtimeConfigPlatforms', 'runtimeConfigKeys', 'runtimeConfigCommonDigests',
  ]);
  if (input.schemaVersion !== 2) throw new Error(`Invalid ${field}.schemaVersion: expected 2.`);
  const nativeTools = input.nativeTools === undefined ? undefined : normalizeNativeToolClosure(input.nativeTools);
  if (nativeTools?.consumers.some((consumer) => consumer.kind !== 'plugin-command')) {
    throw new Error(`Invalid ${field}: native closure must contain only the plugin command consumer.`);
  }
  const runtimeConfigPlatforms = nativePlatforms(input.runtimeConfigPlatforms, `${field}.runtimeConfigPlatforms`);
  const runtimeConfigKeys = input.runtimeConfigKeys === undefined
    ? undefined : configKeys(input.runtimeConfigKeys, `${field}.runtimeConfigKeys`, true);
  if (runtimeConfigPlatforms.length && runtimeConfigKeys === undefined) {
    throw new Error(`Invalid ${field}: runtime config platforms require allowed keys.`);
  }
  if (input.routeConfigDigest !== undefined && input.dynamicRefreshKeys === undefined) {
    throw new Error(`Invalid ${field}: a route config digest requires dynamic routes.`);
  }
  let routeConfigKeyDigests: InstalledCommandProducer['routeConfigKeyDigests'];
  if (input.routeConfigKeyDigests !== undefined) {
    const digests = input.routeConfigKeyDigests;
    if (input.routeConfigDigest === undefined || !digests || typeof digests !== 'object' || Array.isArray(digests)) {
      throw new Error(`Invalid ${field}.routeConfigKeyDigests: expected an object and a route config digest.`);
    }
    configKeys(Object.keys(digests), `${field}.routeConfigKeyDigests`);
    routeConfigKeyDigests = Object.fromEntries(Object.entries(digests)
      .map(([key, digest]) => [key, normalizeDigest(digest, `${field}.routeConfigKeyDigests.${key}`)]));
  }
  const commonDigests = input.runtimeConfigCommonDigests === undefined ? undefined : Object.fromEntries(
    Object.entries(object(input.runtimeConfigCommonDigests, `${field}.runtimeConfigCommonDigests`, runtimeConfigPlatforms))
      .map(([platform, digest]) => [platform, normalizeDigest(digest, `${field}.runtimeConfigCommonDigests.${platform}`)]),
  );
  return {
    schemaVersion: 2,
    producer: normalizeProducerIdentity(input.producer),
    pluginVersion: assertStrictSemVer(input.pluginVersion, `${field}.pluginVersion`),
    sourceContentDigest: normalizeDigest(input.sourceContentDigest, `${field}.sourceContentDigest`),
    routes: normalizeRoutes(input.routes, `${field}.routes`, true),
    runtimeConfigPlatforms,
    ...(runtimeConfigKeys === undefined ? {} : { runtimeConfigKeys }),
    ...(input.dynamicRefreshKeys === undefined ? {} : {
      dynamicRefreshKeys: configKeys(input.dynamicRefreshKeys, `${field}.dynamicRefreshKeys`),
    }),
    ...(input.routeConfigDigest === undefined ? {} : {
      routeConfigDigest: normalizeDigest(input.routeConfigDigest, `${field}.routeConfigDigest`),
    }),
    ...(routeConfigKeyDigests === undefined ? {} : { routeConfigKeyDigests }),
    ...(commonDigests === undefined ? {} : { runtimeConfigCommonDigests: commonDigests }),
    ...(nativeTools ? { nativeTools } : {}),
  };
}

export function normalizeUserCommandDefinition(value: unknown): UserCommandDefinition {
  const input = object(value, 'user command definition', ['schemaVersion', 'id', 'name', 'packageRevision', 'launch']);
  if (input.schemaVersion !== 1 || !isUserCommandId(input.id)) throw new Error('Invalid user command definition identity.');
  const displayName = text(input.name, 'user command definition.name', 128);
  if (displayName.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(displayName)) throw new Error('Invalid user command definition.name.');
  const packageRevision = text(input.packageRevision, 'user command definition.packageRevision');
  if (!USER_COMMAND_ID.test(`cmdu_${packageRevision}`)) throw new Error('Invalid user command definition.packageRevision.');
  const launch = object(input.launch, 'user command definition.launch', LAUNCH_FIELDS);
  requireLaunchDefaults(launch, 'user command definition.launch');
  return { schemaVersion: 1, id: input.id, name: displayName, packageRevision, launch: normalizeCommandLaunch(input.launch) };
}

export interface ManagedCommandPlaceholder { start: number; end: number }

export function parseManagedCommandPlaceholders(value: string): ManagedCommandPlaceholder[] {
  const placeholders: ManagedCommandPlaceholder[] = [];
  for (const match of value.matchAll(/\{\{aw\.command(?=\b)[^}\r\n]*(?:\}\})?/gu)) {
    if (match[0] !== '{{aw.command}}') {
      throw new Error('commandReferenceInvalid: expected {{aw.command}}.');
    }
    placeholders.push({ start: match.index, end: match.index + match[0].length });
  }
  return placeholders;
}

export function replaceManagedCommandPlaceholders(value: string, invocationSelector: string): string {
  const selector = normalizeCommandInvocationSelector(invocationSelector);
  let cursor = 0;
  let result = '';
  for (const placeholder of parseManagedCommandPlaceholders(value)) {
    result += value.slice(cursor, placeholder.start) + `aw command run ${selector} --`;
    cursor = placeholder.end;
  }
  return result + value.slice(cursor);
}

export function assertManagedCommandPlatform(
  manifest: Pick<NormalizedPluginManifest, 'command'>,
  platform: PlatformTarget,
  field: string,
): void {
  if (!manifest.command) throw new Error(`Invalid ${field}: requires a command declaration.`);
  if (platform === 'generic' || !manifest.command.platforms.includes(platform)) {
    throw new Error(`Invalid ${field}: ${platform} is outside command.platforms.`);
  }
}

export function validateManagedCommandManifest(manifest: NormalizedPluginManifest): void {
  const validateKeys = (keys: string[], field: string, platform?: PlatformName): void => {
    if (keys.length === 0) return;
    if (!manifest.config) throw new Error(`Invalid ${field}: requires a config definition.`);
    const config = selectPluginConfigProfile(manifest.config, platform);
    const fieldLabel = platform === undefined ? field : `${field} for ${platform}`;
    for (const key of keys) {
      if (!Object.hasOwn(config.fields, key)) throw new Error(`Invalid ${fieldLabel}: unknown config key "${key}".`);
    }
    for (const key of getPluginConfigDependencyKeys(config, keys)) {
      if (config.fields[key]?.sensitive === true) {
        throw new Error(`Invalid ${fieldLabel}: sensitive config key or dependency "${key}" is not permitted.`);
      }
    }
  };
  const command = manifest.command;
  if (command?.mode === 'dynamic') {
    if (!manifest.scripts?.artifacts?.render) {
      throw new Error('Invalid command: dynamic routes require scripts.artifacts.render.');
    }
    validateKeys(command.refreshKeys, 'command.refreshKeys');
  }
  if (command?.runtimeConfig) {
    for (const platform of command.platforms) validateKeys(command.runtimeConfig.keys, 'command.runtimeConfig.keys', platform);
  }
  for (const [index, permission] of (manifest.extensions?.permissions ?? []).entries()) {
    for (const platform of resolveSupportedPlatforms(manifest)) {
      if (command && platform === 'generic' && permission.agentOverrides?.generic == null) continue;
      const entry = applyPlatformOverride(permission, platform);
      if (!entry) continue;
      const includesManaged = [entry.allow, entry.ask, entry.deny].some((items) =>
        items?.some((item) => typeof item !== 'string'));
      if (includesManaged || (entry.sandbox?.excludedCommands.length ?? 0) > 0) {
        assertManagedCommandPlatform(manifest, platform, `extensions.permissions[${index}] for ${platform}`);
      }
    }
  }
}

export function getManagedCommandArtifactTargets(manifest: NormalizedPluginManifest): ManagedCommandArtifactTargetDefinition[] {
  if (manifest.command?.mode !== 'dynamic') return [];
  return [{
    id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes',
    surface: { kind: 'aw', name: 'managed-commands' }, scopes: ['user'],
    refreshKeys: [...manifest.command.refreshKeys],
  }];
}

/** Checks entry path chains after a producer candidate is complete. */
export async function validateCommandEntryFiles(resourceRoot: string, entries: readonly CommandLaunch[]): Promise<void> {
  const root = await fs.lstat(resourceRoot);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Invalid command resource root: expected a regular directory.');
  for (const entry of entries) {
    const { entry: relativePath } = normalizeCommandLaunch({
      runner: entry.runner, entry: entry.entry, args: entry.args, env: entry.env, envFrom: entry.envFrom, cwd: entry.cwd,
    });
    let current = resourceRoot;
    const segments = relativePath.split('/');
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch(() => undefined);
      if (!stat || stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Invalid command entry: expected a producer-owned regular file without links.');
    }
  }
}

/** Validates the executable input tree before packaging or renderer execution. */
export async function validateManagedCommandSources(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<void> {
  const command = manifest.command;
  if (!command) return;
  let current = pluginRoot;
  for (const segment of command.sourceDir.slice(2).split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Invalid command.sourceDir: expected an ordinary directory without links.');
    }
  }
  const walk = async (directory: string, relative = ''): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (isProtectedCommandPath(entry.name) || isSkillAuthorOnlyPath(relativePath)) {
        throw new Error(`Invalid command.sourceDir: protected or author-only content "${relativePath}".`);
      }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error('Invalid command.sourceDir: only ordinary files and directories are supported.');
      }
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relativePath);
    }
  };
  await walk(current);
  if (command.mode === 'static') {
    await validateCommandEntryFiles(current, [
      ...command.routes.subcommands, ...(command.routes.fallback ? [command.routes.fallback] : []),
    ]);
  }
}

/** Uses the same route validator as the static manifest and rejects renderer-owned metadata. */
export function normalizeCommandRoutesArtifact(value: unknown, field = 'command routes artifact'): CommandRoutesArtifact {
  const input = object(value, field, ['id', 'target', 'kind', 'refreshKeys', 'routes']);
  if (input.id !== 'command-routes' || input.target !== 'aw.command-routes' || input.kind !== 'commandRoutes') {
    throw new Error(`Invalid ${field}: expected command-routes / aw.command-routes / commandRoutes.`);
  }
  return {
    id: input.id, target: input.target, kind: input.kind,
    refreshKeys: configKeys(input.refreshKeys, `${field}.refreshKeys`),
    routes: normalizeCommandRoutes(input.routes, `${field}.routes`),
  };
}
