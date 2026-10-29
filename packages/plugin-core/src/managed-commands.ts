import { createHash } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { getPluginConfigDependencyKeys } from './plugin-config.js';
import { formatMarketplaceProductsForError, supportsPlatform } from './platform-support.js';
import { isSkillAuthorOnlyPath } from './skill-authoring.js';
import type {
  ArtifactState, CodexSkillDelivery, NormalizedPluginManifest, PlatformName, Scope,
} from './types.js';

export interface CommandLaunch {
  runner: 'node' | 'executable';
  entry: string;
  args: string[];
  env: Record<string, string>;
  envFrom: Record<string, string>;
  cwd: 'caller' | 'resource';
}
export interface CommandDefinition extends CommandLaunch { key: string; variant: string }
export interface ManagedCommandReference { set: string; key: string; variant: string }
export interface ManagedCommandPermission { command: ManagedCommandReference; argsPrefix: string[] }
export type PermissionCommand = string | ManagedCommandPermission;
export type ManagedCommandProducerRef =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'static-skill'; platform: PlatformName; skillKey: string }
  | { kind: 'package'; packageKey: string };
export interface ManagedCommandPackage {
  key: string; scope: Scope; platforms: [PlatformName, ...PlatformName[]]; sourceDir: string;
  render?: true; refreshKeys: string[];
}
export type ManagedCommandSet =
  | { set: string; producer: ManagedCommandProducerRef; mode: 'static'; entries: CommandDefinition[] }
  | { set: string; producer: ManagedCommandProducerRef; mode: 'dynamic'; refreshKeys: string[] };
export interface ManagedCommands { packages: ManagedCommandPackage[]; sets: ManagedCommandSet[] }
export interface ProducerIdentity {
  sourceId: string; sourceIdentity: string; pluginName: string;
  kind: 'artifact' | 'static-skill' | 'package'; key: string;
  platform: PlatformName | null; scope: Scope; projectRoot: string | null;
}
export interface CommandIdentity {
  schemaVersion: 1; producer: ProducerIdentity; set: string; key: string; variant: string;
}
export interface InstalledCommandProducer {
  schemaVersion: 1;
  producer: ProducerIdentity;
  sets: Array<{ set: string; state: ArtifactState; entries: CommandDefinition[] }>;
}
export interface UserCommandDefinition {
  schemaVersion: 1; id: string; name: string; packageRevision: string; launch: CommandLaunch;
}
export type ManagedCommandArtifactSurface =
  | { kind: 'platform'; platform: PlatformName }
  | { kind: 'aw'; name: 'managed-commands' };
export interface ManagedCommandArtifactTargetDefinition {
  id: string; target: 'aw.command-set' | 'aw.command-package'; kind: 'commandSet' | 'commandPackage';
  surface: ManagedCommandArtifactSurface; platform?: PlatformName; scopes: Scope[];
  states: ArtifactState[]; refreshKeys: string[]; producer: ManagedCommandProducerRef;
  set?: string; packageKey?: string; delivery?: CodexSkillDelivery;
}
export interface CommandSetArtifact {
  id: string; target: 'aw.command-set'; kind: 'commandSet'; platform?: PlatformName; distribution?: never;
  state: ArtifactState; refreshKeys: string[]; entries: CommandDefinition[]; disabledReason?: string;
}
export interface CommandPackageArtifact {
  id: string; target: 'aw.command-package'; kind: 'commandPackage'; platform?: never; distribution?: never; state: 'present';
  refreshKeys: string[]; files: Record<string, string>;
}
export const COMMAND_PRODUCER_RECORD_FILE = '.aw-command-producer.json';
export const MANAGED_COMMAND_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_PERMISSION_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/u;
const PLUGIN_COMMAND_ID = /^cmdp_[0-9a-f]{16}$/u;
const USER_COMMAND_ID = /^cmdu_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PACKAGE_ID = /^pkg_[0-9a-f]{64}$/u;
const PACKAGE_PROTECTED_NAMES = new Set(['.git', 'node_modules', '.agents-plugin', '.codex-plugin', '.claude-plugin', '.release', '.tmp', 'evals', 'reports', COMMAND_PRODUCER_RECORD_FILE, '.agent-workflows-owner.json', '.aw-runtime-config.json', 'aw-plugin-requirements.json']);
const PACKAGE_OUTPUT_ROOTS = new Set(['codex', 'claude', 'agent-skills']);

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
  return /^(?:AW_PLUGIN_|AW_SUBAGENT_|AW_COMMAND_)/u.test(value.toUpperCase())
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
  const input = object(value, field, ['runner', 'entry', 'args', 'env', 'envFrom', 'cwd']);
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
export function normalizeCommandDefinition(value: unknown, field = 'command'): CommandDefinition {
  const input = object(value, field, ['key', 'variant', 'runner', 'entry', 'args', 'env', 'envFrom', 'cwd']);
  const { key, variant, ...launch } = input;
  return { key: name(key, `${field}.key`), variant: variant === undefined ? 'default' : name(variant, `${field}.variant`), ...normalizeCommandLaunch(launch, field) };
}
export function normalizeCommandDefinitions(value: unknown, field = 'entries'): CommandDefinition[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}: expected an array.`);
  const entries = value.map((entry, index) => normalizeCommandDefinition(entry, `${field}[${index}]`));
  const keys = entries.map((entry) => `${entry.key}/${entry.variant}`);
  if (new Set(keys).size !== keys.length) throw new Error(`Invalid ${field}: duplicate command key/variant.`);
  return entries;
}
export function normalizeManagedCommandReference(value: unknown, field = 'command reference'): ManagedCommandReference {
  const input = object(value, field, ['set', 'key', 'variant']);
  return { set: name(input.set, `${field}.set`), key: name(input.key, `${field}.key`), variant: input.variant === undefined ? 'default' : name(input.variant, `${field}.variant`) };
}
export function normalizeManagedCommandPermission(value: unknown, field = 'command permission'): ManagedCommandPermission {
  const input = object(value, field, ['command', 'argsPrefix']);
  const argsPrefix = input.argsPrefix === undefined ? [] : strings(input.argsPrefix, `${field}.argsPrefix`);
  if (argsPrefix.some((token) => !SAFE_PERMISSION_TOKEN.test(token))) throw new Error(`Invalid ${field}.argsPrefix: expected safe non-empty tokens.`);
  return { command: normalizeManagedCommandReference(input.command, `${field}.command`), argsPrefix };
}
function normalizeProducerRef(value: unknown, field: string): ManagedCommandProducerRef {
  const input = object(value, field, ['kind', 'artifactId', 'platform', 'skillKey', 'packageKey']);
  if (input.kind === 'artifact') {
    object(value, field, ['kind', 'artifactId']);
    return { kind: 'artifact', artifactId: nonempty(input.artifactId, `${field}.artifactId`) };
  }
  if (input.kind === 'static-skill') {
    object(value, field, ['kind', 'platform', 'skillKey']);
    const skillKey = normalizeCommandRelativeFile(input.skillKey, `${field}.skillKey`);
    if (skillKey.includes('/')) throw new Error(`Invalid ${field}.skillKey: expected a declared Skill key.`);
    return { kind: 'static-skill', platform: enumeration(input.platform, `${field}.platform`, ['codex', 'claude']), skillKey };
  }
  object(value, field, ['kind', 'packageKey']);
  if (input.kind !== 'package') throw new Error(`Invalid ${field}.kind.`);
  return { kind: 'package', packageKey: name(input.packageKey, `${field}.packageKey`) };
}
export function normalizeManagedCommands(value: unknown, field = 'managedCommands'): ManagedCommands {
  const input = object(value, field, ['packages', 'sets']);
  const packages = input.packages === undefined ? [] : (() => {
    if (!Array.isArray(input.packages)) throw new Error(`Invalid ${field}.packages: expected an array.`);
    return input.packages.map((entry, index): ManagedCommandPackage => {
      const label = `${field}.packages[${index}]`;
      const item = object(entry, label, ['key', 'scope', 'platforms', 'sourceDir', 'render', 'refreshKeys']);
      const platforms = strings(item.platforms, `${label}.platforms`, true).map((platform) => enumeration<PlatformName>(platform, `${label}.platforms`, ['codex', 'claude']));
      if (platforms.length === 0) throw new Error(`Invalid ${label}.platforms: expected a non-empty array.`);
      if (item.render !== undefined && item.render !== true) throw new Error(`Invalid ${label}.render: expected true.`);
      const refreshKeys = item.refreshKeys === undefined ? [] : strings(item.refreshKeys, `${label}.refreshKeys`, true);
      if (item.render !== true && refreshKeys.length > 0) throw new Error(`Invalid ${label}.refreshKeys: requires render: true.`);
      const sourceDir = nonempty(item.sourceDir, `${label}.sourceDir`);
      if (!sourceDir.startsWith('./')) throw new Error(`Invalid ${label}.sourceDir: expected ./ plugin-relative directory.`);
      normalizeCommandRelativeFile(sourceDir.slice(2), `${label}.sourceDir`);
      const parts = sourceDir.slice(2).split('/');
      if (PACKAGE_OUTPUT_ROOTS.has(parts[0]!) || parts.some((part) => PACKAGE_PROTECTED_NAMES.has(part)) || isSkillAuthorOnlyPath(sourceDir.slice(2))) {
        throw new Error(`Invalid ${label}.sourceDir: protected or author-only directory.`);
      }
      return { key: name(item.key, `${label}.key`), scope: enumeration(item.scope, `${label}.scope`, ['user', 'project']), platforms: platforms as [PlatformName, ...PlatformName[]], sourceDir, ...(item.render === true ? { render: true } : {}), refreshKeys };
    });
  })();
  const sets = input.sets === undefined ? [] : (() => {
    if (!Array.isArray(input.sets)) throw new Error(`Invalid ${field}.sets: expected an array.`);
    return input.sets.map((entry, index): ManagedCommandSet => {
      const label = `${field}.sets[${index}]`;
      const item = object(entry, label, ['set', 'producer', 'mode', 'entries', 'refreshKeys']);
      const set = name(item.set, `${label}.set`);
      const producer = normalizeProducerRef(item.producer, `${label}.producer`);
      if (item.mode === 'static') {
        object(entry, label, ['set', 'producer', 'mode', 'entries']);
        return { set, producer, mode: 'static', entries: normalizeCommandDefinitions(item.entries, `${label}.entries`) };
      }
      object(entry, label, ['set', 'producer', 'mode', 'refreshKeys']);
      if (item.mode !== 'dynamic') throw new Error(`Invalid ${label}.mode.`);
      return { set, producer, mode: 'dynamic', refreshKeys: strings(item.refreshKeys, `${label}.refreshKeys`, true) };
    });
  })();
  if (new Set(packages.map((item) => item.key)).size !== packages.length) throw new Error(`Invalid ${field}.packages: duplicate package key.`);
  if (new Set(sets.map((item) => item.set)).size !== sets.length) throw new Error(`Invalid ${field}.sets: duplicate set.`);
  return { packages, sets };
}

export function normalizeProducerIdentity(value: unknown, field = 'producer identity'): ProducerIdentity {
  const input = object(value, field, ['sourceId', 'sourceIdentity', 'pluginName', 'kind', 'key', 'platform', 'scope', 'projectRoot']);
  const sourceId = nonempty(input.sourceId, `${field}.sourceId`);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(sourceId)) throw new Error(`Invalid ${field}.sourceId.`);
  const sourceIdentity = nonempty(input.sourceIdentity, `${field}.sourceIdentity`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(sourceIdentity)) throw new Error(`Invalid ${field}.sourceIdentity.`);
  const pluginName = nonempty(input.pluginName, `${field}.pluginName`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pluginName)) throw new Error(`Invalid ${field}.pluginName.`);
  const kind = enumeration(input.kind, `${field}.kind`, ['artifact', 'static-skill', 'package']);
  const key = nonempty(input.key, `${field}.key`);
  if (kind === 'package') name(key, `${field}.key`);
  const platform = kind === 'package'
    ? (input.platform === null ? null : (() => { throw new Error(`Invalid ${field}.platform: package requires null.`); })())
    : enumeration(input.platform, `${field}.platform`, ['codex', 'claude']);
  const scope = enumeration(input.scope, `${field}.scope`, ['user', 'project']);
  let projectRoot: string | null = null;
  if (scope === 'user') {
    if (input.projectRoot !== null) throw new Error(`Invalid ${field}.projectRoot: user requires null.`);
  } else {
    projectRoot = nonempty(input.projectRoot, `${field}.projectRoot`);
    if (!path.isAbsolute(projectRoot)) throw new Error(`Invalid ${field}.projectRoot: expected a canonical absolute path.`);
    const normalized = path.normalize(projectRoot);
    const canonical = normalized === path.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/u, '');
    const driveCanonical = process.platform === 'win32' ? canonical.replace(/^[a-z]:/u, (drive) => drive.toUpperCase()) : canonical;
    if (driveCanonical !== projectRoot) throw new Error(`Invalid ${field}.projectRoot: expected a canonical absolute path.`);
  }
  return { sourceId, sourceIdentity, pluginName, kind, key, platform, scope, projectRoot };
}
export function normalizeCommandIdentity(value: unknown, field = 'command identity'): CommandIdentity {
  const input = object(value, field, ['schemaVersion', 'producer', 'set', 'key', 'variant']);
  if (input.schemaVersion !== 1) throw new Error(`Invalid ${field}.schemaVersion: expected 1.`);
  // Identity records have no defaults: every identity field is part of the hash contract.
  if (input.variant === undefined) throw new Error(`Invalid ${field}.variant: required.`);
  return { schemaVersion: 1, producer: normalizeProducerIdentity(input.producer, `${field}.producer`), set: name(input.set, `${field}.set`), key: name(input.key, `${field}.key`), variant: name(input.variant, `${field}.variant`) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function canonicalizeCommandIdentity(value: CommandIdentity): string { return canonical(normalizeCommandIdentity(value)); }
export function getPluginCommandId(identity: CommandIdentity): string {
  return `cmdp_${createHash('sha256').update(canonicalizeCommandIdentity(identity), 'utf8').digest('hex').slice(0, 16)}`;
}
export function getCommandPackageId(producer: ProducerIdentity): string {
  return `pkg_${createHash('sha256').update(canonical(normalizeProducerIdentity(producer)), 'utf8').digest('hex')}`;
}
export function isManagedCommandId(value: unknown): value is string { return typeof value === 'string' && (PLUGIN_COMMAND_ID.test(value) || USER_COMMAND_ID.test(value)); }
export function isUserCommandId(value: unknown): value is string { return typeof value === 'string' && USER_COMMAND_ID.test(value); }
export function isCommandPackageId(value: unknown): value is string { return typeof value === 'string' && PACKAGE_ID.test(value); }

export function normalizeInstalledCommandProducer(value: unknown): InstalledCommandProducer {
  const input = object(value, 'command producer record', ['schemaVersion', 'producer', 'sets']);
  if (input.schemaVersion !== 1 || !Array.isArray(input.sets)) throw new Error('Invalid command producer record.');
  const sets = input.sets.map((value, index) => {
    const field = `command producer record.sets[${index}]`;
    const item = object(value, field, ['set', 'state', 'entries']);
    if (Array.isArray(item.entries)) {
      for (const entry of item.entries) {
        const definition = object(entry, `${field}.entries`, ['key', 'variant', 'runner', 'entry', 'args', 'env', 'envFrom', 'cwd']);
        if (['variant', 'args', 'env', 'envFrom', 'cwd'].some((key) => definition[key] === undefined)) throw new Error(`Invalid ${field}.entries: installed definitions must include defaults.`);
      }
    }
    const entries = normalizeCommandDefinitions(item.entries, `${field}.entries`);
    const state = enumeration(item.state, `${field}.state`, ['present', 'disabled']);
    if (state === 'disabled' && entries.length !== 0) throw new Error(`Invalid ${field}: disabled set must have no entries.`);
    return { set: name(item.set, `${field}.set`), state, entries };
  });
  if (new Set(sets.map((item) => item.set)).size !== sets.length) throw new Error('Invalid command producer record: duplicate set.');
  return { schemaVersion: 1, producer: normalizeProducerIdentity(input.producer), sets };
}
export function normalizeUserCommandDefinition(value: unknown): UserCommandDefinition {
  const input = object(value, 'user command definition', ['schemaVersion', 'id', 'name', 'packageRevision', 'launch']);
  if (input.schemaVersion !== 1 || !isUserCommandId(input.id)) throw new Error('Invalid user command definition identity.');
  const displayName = text(input.name, 'user command definition.name', 128);
  if (displayName.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(displayName)) throw new Error('Invalid user command definition.name.');
  const packageRevision = text(input.packageRevision, 'user command definition.packageRevision');
  if (!USER_COMMAND_ID.test(`cmdu_${packageRevision}`)) throw new Error('Invalid user command definition.packageRevision.');
  const launch = object(input.launch, 'user command definition.launch', ['runner', 'entry', 'args', 'env', 'envFrom', 'cwd']);
  if (['args', 'env', 'envFrom', 'cwd'].some((key) => launch[key] === undefined)) throw new Error('Invalid user command definition.launch: installed launch must include defaults.');
  return { schemaVersion: 1, id: input.id, name: displayName, packageRevision, launch: normalizeCommandLaunch(input.launch) };
}

export interface ManagedCommandPlaceholder { start: number; end: number; reference: ManagedCommandReference }
export function parseManagedCommandPlaceholders(value: string): ManagedCommandPlaceholder[] {
  text(value, 'Skill Markdown');
  const result: ManagedCommandPlaceholder[] = [];
  const expression = /\{\{aw\.command:([^}]*)(\}\})?/gu;
  for (const match of value.matchAll(expression)) {
    const parts = match[1]!.split('/');
    if (match[2] !== '}}' || (parts.length !== 2 && parts.length !== 3)) throw new Error('commandReferenceInvalid: malformed managed command placeholder.');
    try {
      result.push({ start: match.index, end: match.index + match[0].length, reference: normalizeManagedCommandReference({ set: parts[0], key: parts[1], ...(parts.length === 3 ? { variant: parts[2] } : {}) }) });
    } catch { throw new Error('commandReferenceInvalid: malformed managed command placeholder.'); }
  }
  return result;
}
export function replaceManagedCommandPlaceholders(value: string, resolve: (reference: ManagedCommandReference) => string): string {
  let cursor = 0;
  let result = '';
  for (const placeholder of parseManagedCommandPlaceholders(value)) {
    const id = resolve(placeholder.reference);
    if (!isManagedCommandId(id)) throw new Error('commandReferenceInvalid: resolver returned an invalid command ID.');
    result += value.slice(cursor, placeholder.start) + `aw command run ${id} --`;
    cursor = placeholder.end;
  }
  return result + value.slice(cursor);
}

export function validateManagedCommandManifest(manifest: NormalizedPluginManifest): void {
  const managed = manifest.managedCommands;
  if (!managed) return;
  const validateKeys = (keys: string[], field: string): void => {
    if (keys.length === 0) return;
    if (!manifest.config || manifest.config.schemaVersion !== 4) throw new Error(`Invalid ${field}: requires Config v4.`);
    for (const key of getPluginConfigDependencyKeys(manifest.config, keys)) {
      if (manifest.config.fields[key]?.sensitive === true) throw new Error(`Invalid ${field}: sensitive config dependency is not permitted.`);
    }
  };
  for (const item of managed.packages) validateKeys(item.refreshKeys, `managedCommands.packages.${item.key}.refreshKeys`);
  for (const item of managed.sets) {
    if (item.mode === 'dynamic') validateKeys(item.refreshKeys, `managedCommands.sets.${item.set}.refreshKeys`);
    const producer = item.producer;
    if (producer.kind === 'package') {
      if (!managed.packages.some((pkg) => pkg.key === producer.packageKey)) throw new Error(`Invalid managedCommands set ${item.set}: unknown package producer.`);
    } else if (producer.kind === 'artifact') {
      const targets = (manifest.artifacts?.targets ?? []).filter((target) => target.id === producer.artifactId);
      if (targets.length !== 1 || !['codex.skill', 'claude.skill'].includes(targets[0]!.target)) throw new Error(`Invalid managedCommands set ${item.set}: artifact producer must uniquely identify a platform Skill.`);
    } else {
      if (!supportsPlatform(manifest, producer.platform)) throw new Error(`Invalid managedCommands set ${item.set}: static Skill producer requires ${producer.platform.toUpperCase()} support, but ${formatMarketplaceProductsForError(manifest)}.`);
      if (!manifest.skills || (manifest.artifacts?.targets ?? []).some((target) => target.platform === producer.platform && target.skillKey === producer.skillKey)) throw new Error(`Invalid managedCommands set ${item.set}: expected a static Skill producer.`);
    }
  }
  if ((managed.packages.some((item) => item.render) || managed.sets.some((item) => item.mode === 'dynamic')) && !manifest.scripts?.artifacts?.render) {
    throw new Error('Invalid managedCommands: dynamic command targets require scripts.artifacts.render.');
  }
}
export function getManagedCommandArtifactTargets(manifest: NormalizedPluginManifest): ManagedCommandArtifactTargetDefinition[] {
  validateManagedCommandManifest(manifest);
  const managed = manifest.managedCommands;
  if (!managed) return [];
  const result: ManagedCommandArtifactTargetDefinition[] = managed.packages.filter((pkg) => pkg.render).map((pkg) => ({
    id: `command-package.${pkg.key}`, target: 'aw.command-package', kind: 'commandPackage',
    surface: { kind: 'aw', name: 'managed-commands' }, scopes: [pkg.scope], states: ['present'],
    refreshKeys: [...pkg.refreshKeys], producer: { kind: 'package', packageKey: pkg.key }, packageKey: pkg.key,
  }));
  for (const set of managed.sets) {
    if (set.mode !== 'dynamic') continue;
    const base = { id: `command-set.${set.set}`, target: 'aw.command-set' as const, kind: 'commandSet' as const, states: ['present', 'disabled'] as ArtifactState[], refreshKeys: [...set.refreshKeys], producer: set.producer, set: set.set };
    const producer = set.producer;
    if (producer.kind === 'package') {
      const pkg = managed.packages.find((item) => item.key === producer.packageKey)!;
      result.push({ ...base, surface: { kind: 'aw', name: 'managed-commands' }, scopes: [pkg.scope], packageKey: pkg.key });
    } else if (set.producer.kind === 'static-skill') {
      result.push({ ...base, platform: set.producer.platform, surface: { kind: 'platform', platform: set.producer.platform }, scopes: ['user'] });
    } else {
      const target = manifest.artifacts!.targets!.find((item) => item.id === (producer as Extract<ManagedCommandProducerRef, { kind: 'artifact' }>).artifactId)!;
      result.push({ ...base, platform: target.platform!, surface: { kind: 'platform', platform: target.platform! }, scopes: target.delivery?.mode === 'codex-native' ? ['user'] : [...target.scopes], ...(target.delivery ? { delivery: target.delivery } : {}) });
    }
  }
  return result;
}

/** Checks entry path chains after a producer candidate is complete. */
export async function validateCommandEntryFiles(resourceRoot: string, entries: readonly CommandDefinition[]): Promise<void> {
  const root = await fs.lstat(resourceRoot);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Invalid command resource root: expected a regular directory.');
  for (const entry of entries) {
    normalizeCommandDefinition(entry);
    let current = resourceRoot;
    const segments = entry.entry.split('/');
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch(() => undefined);
      if (!stat || stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Invalid command entry: expected a producer-owned regular file without links.');
    }
  }
}

/** Validates the package input closure without following dependency or author-only trees. */
export async function validateManagedCommandSources(pluginRoot: string, manifest: NormalizedPluginManifest): Promise<void> {
  for (const set of manifest.managedCommands?.sets ?? []) {
    if (set.producer.kind !== 'static-skill') continue;
    const producer = set.producer;
    const sourceRoot = path.join(pluginRoot, manifest.skills!.slice(2), producer.skillKey);
    const bundleRoot = path.join(pluginRoot, producer.platform, manifest.skills!.slice(2), producer.skillKey);
    const root = await fs.pathExists(sourceRoot) ? sourceRoot : bundleRoot;
    const stat = await fs.lstat(path.join(root, 'SKILL.md')).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid managed command set ${set.set}: static Skill declaration key does not exist.`);
  }
  for (const pkg of manifest.managedCommands?.packages ?? []) {
    let current = pluginRoot;
    for (const segment of pkg.sourceDir.slice(2).split('/')) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current).catch(() => undefined);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid managed command package ${pkg.key}: sourceDir must be an ordinary directory without links.`);
    }
    const walk = async (directory: string, relative = ''): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
        if (PACKAGE_PROTECTED_NAMES.has(entry.name) || isSkillAuthorOnlyPath(relativePath)) {
          throw new Error(`Invalid managed command package ${pkg.key}: protected or author-only content.`);
        }
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error(`Invalid managed command package ${pkg.key}: only ordinary files and directories are supported.`);
        if (entry.isDirectory()) await walk(path.join(directory, entry.name), relativePath);
      }
    };
    await walk(current);
    const entries = (manifest.managedCommands?.sets ?? []).flatMap((set) =>
      set.producer.kind === 'package' && set.producer.packageKey === pkg.key && set.mode === 'static' ? set.entries : []);
    await validateCommandEntryFiles(current, entries);
  }
}
