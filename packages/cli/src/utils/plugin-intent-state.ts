import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { DependencyScopeOverride, PlatformName, Scope } from '../types.js';
import { parsePluginId } from './multi-source-catalog.js';
import {
  atomicReplaceConfigFile,
  resolveAwProjectRoot,
} from './plugin-config.js';
import {
  assertCanonicalProjectManagedRoots,
  assertProjectSharedConfigPathVisible,
} from './project-boundary.js';
import { resolveAwHome } from './state-paths.js';
import {
  assertTestReadablePath,
  assertTestWritablePath,
} from './test-path-fence.js';

export const PLUGIN_INTENT_SCHEMA_VERSION = 2;
export const PLUGIN_INTENT_KIND = 'aw-plugin-intents';

export interface PluginIntentRoot {
  pluginId: string;
  platforms: PlatformName[];
}

export type PluginIntentDependencyScopeOverride = DependencyScopeOverride;

export interface PluginIntentState {
  schemaVersion: 2;
  kind: 'aw-plugin-intents';
  roots: PluginIntentRoot[];
  dependencyScopeOverrides: PluginIntentDependencyScopeOverride[];
}

export interface PluginIntentStateLocation {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type PluginIntentStateObservation =
  | { state: 'ready'; value: PluginIntentState }
  | { state: 'absent' }
  | { state: 'invalid'; code: 'pluginIntentStateInvalid'; message: string }
  | { state: 'unavailable'; code: 'pluginIntentStateUnavailable'; message: string };

type PluginIntentPathAccess = 'read' | 'write';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  fieldName: string,
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Invalid ${fieldName}: expected exactly ${expected.join(', ')}.`
      + `${unknown.length > 0 ? ` Unknown: ${unknown.sort(compareText).join(', ')}.` : ''}`
      + `${missing.length > 0 ? ` Missing: ${missing.join(', ')}.` : ''}`,
    );
  }
}

function parseCanonicalPluginId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected a source-qualified plugin ID.`);
  }
  const parsed = parsePluginId(value);
  if (!parsed.sourceId) {
    throw new Error(`Invalid ${fieldName}: expected a source-qualified plugin ID.`);
  }
  return `${parsed.sourceId}/${parsed.pluginName}`;
}

function parsePlatform(value: unknown, fieldName: string): PlatformName {
  if (value !== 'codex' && value !== 'claude') {
    throw new Error(`Invalid ${fieldName}: expected codex or claude.`);
  }
  return value;
}

function parseScope(value: unknown, fieldName: string): Scope {
  if (value !== 'project' && value !== 'user') {
    throw new Error(`Invalid ${fieldName}: expected project or user.`);
  }
  return value;
}

function canonicalPlatforms(platforms: readonly PlatformName[]): PlatformName[] {
  return [...new Set(platforms)].sort(compareText);
}

export function createEmptyPluginIntentState(): PluginIntentState {
  return {
    schemaVersion: PLUGIN_INTENT_SCHEMA_VERSION,
    kind: PLUGIN_INTENT_KIND,
    roots: [],
    dependencyScopeOverrides: [],
  };
}

export function canonicalizePluginIntentState(state: PluginIntentState): PluginIntentState {
  const roots = state.roots.map((root) => ({
    pluginId: parseCanonicalPluginId(root.pluginId, 'roots[].pluginId'),
    platforms: canonicalPlatforms(root.platforms.map((platform) =>
      parsePlatform(platform, 'roots[].platforms[]'))),
  }));
  if (roots.some((root) => root.platforms.length === 0)) {
    throw new Error('Invalid roots[].platforms: expected at least one platform.');
  }
  if (new Set(roots.map((root) => root.pluginId)).size !== roots.length) {
    throw new Error('Invalid roots: duplicate pluginId.');
  }

  const dependencyScopeOverrides = state.dependencyScopeOverrides.map((override) => ({
    pluginId: parseCanonicalPluginId(
      override.pluginId,
      'dependencyScopeOverrides[].pluginId',
    ),
    platform: parsePlatform(override.platform, 'dependencyScopeOverrides[].platform'),
    scope: parseScope(override.scope, 'dependencyScopeOverrides[].scope'),
  }));
  const overrideKeys = dependencyScopeOverrides.map((override) =>
    `${override.pluginId}\0${override.platform}`);
  if (new Set(overrideKeys).size !== overrideKeys.length) {
    throw new Error('Invalid dependencyScopeOverrides: duplicate pluginId/platform target.');
  }

  return {
    schemaVersion: PLUGIN_INTENT_SCHEMA_VERSION,
    kind: PLUGIN_INTENT_KIND,
    roots: roots.sort((left, right) => compareText(left.pluginId, right.pluginId)),
    dependencyScopeOverrides: dependencyScopeOverrides.sort((left, right) => compareText(
      `${left.pluginId}\0${left.platform}`,
      `${right.pluginId}\0${right.platform}`,
    )),
  };
}

export function parsePluginIntentState(value: unknown): PluginIntentState {
  if (!isRecord(value)) throw new Error('Invalid plugin intent state: expected an object.');
  assertExactKeys(
    value,
    ['schemaVersion', 'kind', 'roots', 'dependencyScopeOverrides'],
    'plugin intent state',
  );
  if (value.schemaVersion !== PLUGIN_INTENT_SCHEMA_VERSION) {
    throw new Error('Invalid plugin intent state schemaVersion: expected 2.');
  }
  if (value.kind !== PLUGIN_INTENT_KIND) {
    throw new Error(`Invalid plugin intent state kind: expected ${PLUGIN_INTENT_KIND}.`);
  }
  if (!Array.isArray(value.roots)) throw new Error('Invalid roots: expected an array.');
  if (!Array.isArray(value.dependencyScopeOverrides)) {
    throw new Error('Invalid dependencyScopeOverrides: expected an array.');
  }

  const roots = value.roots.map((entry, index): PluginIntentRoot => {
    if (!isRecord(entry)) throw new Error(`Invalid roots[${index}]: expected an object.`);
    assertExactKeys(entry, ['pluginId', 'platforms'], `roots[${index}]`);
    if (!Array.isArray(entry.platforms)) {
      throw new Error(`Invalid roots[${index}].platforms: expected an array.`);
    }
    return {
      pluginId: parseCanonicalPluginId(entry.pluginId, `roots[${index}].pluginId`),
      platforms: entry.platforms.map((platform, platformIndex) =>
        parsePlatform(platform, `roots[${index}].platforms[${platformIndex}]`)),
    };
  });
  const dependencyScopeOverrides = value.dependencyScopeOverrides.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid dependencyScopeOverrides[${index}]: expected an object.`);
    }
    assertExactKeys(
      entry,
      ['pluginId', 'platform', 'scope'],
      `dependencyScopeOverrides[${index}]`,
    );
    return {
      pluginId: parseCanonicalPluginId(
        entry.pluginId,
        `dependencyScopeOverrides[${index}].pluginId`,
      ),
      platform: parsePlatform(entry.platform, `dependencyScopeOverrides[${index}].platform`),
      scope: parseScope(entry.scope, `dependencyScopeOverrides[${index}].scope`),
    };
  });

  return canonicalizePluginIntentState({
    schemaVersion: PLUGIN_INTENT_SCHEMA_VERSION,
    kind: PLUGIN_INTENT_KIND,
    roots,
    dependencyScopeOverrides,
  });
}

export function serializePluginIntentState(state: PluginIntentState): string {
  return `${JSON.stringify(canonicalizePluginIntentState(state), null, 2)}\n`;
}

export function calculatePluginIntentDigest(state: PluginIntentState): string {
  const canonical = canonicalizePluginIntentState(state);
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return `sha256:${digest}`;
}

export function upsertPluginIntentRoot(
  state: PluginIntentState,
  root: PluginIntentRoot,
): PluginIntentState {
  const pluginId = parseCanonicalPluginId(root.pluginId, 'root.pluginId');
  return canonicalizePluginIntentState({
    ...state,
    roots: [
      ...state.roots.filter((entry) => entry.pluginId !== pluginId),
      { pluginId, platforms: [...root.platforms] },
    ],
  });
}

export function mergePluginIntentRootPlatforms(
  state: PluginIntentState,
  root: PluginIntentRoot,
): PluginIntentState {
  const pluginId = parseCanonicalPluginId(root.pluginId, 'root.pluginId');
  const current = state.roots.find((entry) => entry.pluginId === pluginId);
  return upsertPluginIntentRoot(state, {
    pluginId,
    platforms: [...(current?.platforms ?? []), ...root.platforms],
  });
}

export function addPluginIntentRoot(
  state: PluginIntentState,
  root: PluginIntentRoot,
): PluginIntentState {
  const pluginId = parseCanonicalPluginId(root.pluginId, 'root.pluginId');
  if (state.roots.some((entry) => entry.pluginId === pluginId)) {
    throw new Error(`Plugin intent root already exists: ${pluginId}`);
  }
  return upsertPluginIntentRoot(state, { ...root, pluginId });
}

export function removePluginIntentRoot(
  state: PluginIntentState,
  pluginId: string,
): PluginIntentState {
  const canonicalPluginId = parseCanonicalPluginId(pluginId, 'pluginId');
  return canonicalizePluginIntentState({
    ...state,
    roots: state.roots.filter((entry) => entry.pluginId !== canonicalPluginId),
  });
}

export function removePluginIntentRootPlatforms(
  state: PluginIntentState,
  root: PluginIntentRoot,
): PluginIntentState {
  const pluginId = parseCanonicalPluginId(root.pluginId, 'root.pluginId');
  const removed = new Set(root.platforms.map((platform) =>
    parsePlatform(platform, 'root.platforms[]')));
  const current = state.roots.find((entry) => entry.pluginId === pluginId);
  if (!current) return state;
  const platforms = current.platforms.filter((platform) => !removed.has(platform));
  return platforms.length === 0
    ? removePluginIntentRoot(state, pluginId)
    : upsertPluginIntentRoot(state, { pluginId, platforms });
}

export function resolvePluginIntentStatePath(
  location: PluginIntentStateLocation,
  access?: PluginIntentPathAccess,
): string {
  const filePath = location.scope === 'user'
    ? path.join(resolveAwHome(location.env), 'plugin-intents.json')
    : path.join(resolveAwProjectRoot(location.cwd), '.agent-workflows', 'plugin-intents.json');
  if (access === 'read') {
    return assertTestReadablePath(
      filePath,
      `${location.scope} plugin intent state`,
      '用测试隔离环境登记可读 project 或 AW_HOME 根。',
    );
  }
  if (access === 'write') {
    return assertTestWritablePath(
      filePath,
      `${location.scope} plugin intent state`,
      '用 createIsolatedTestEnv() 或 withSafeTestCwd() 登记可写根。',
    );
  }
  return filePath;
}

function assertPathInsideRoot(allowedRoot: string, filePath: string): void {
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(filePath));
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('Plugin intent path escapes its allowed root.');
  }
}

async function assertReadableIntentPath(allowedRoot: string, filePath: string): Promise<boolean> {
  assertPathInsideRoot(allowedRoot, filePath);
  const root = path.resolve(allowedRoot);
  const rootStats = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStats) return false;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Plugin intent root must be a regular directory: ${root}`);
  }
  let current = root;
  for (const segment of path.relative(root, path.resolve(filePath)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) return false;
    if (stats.isSymbolicLink()) {
      throw new Error(`Plugin intent path cannot contain a symbolic link: ${current}`);
    }
    if (current === path.resolve(filePath) && !stats.isFile()) {
      throw new Error(`Plugin intent target must be a regular file: ${filePath}`);
    }
    if (current !== path.resolve(filePath) && !stats.isDirectory()) {
      throw new Error(`Plugin intent path parent must be a directory: ${current}`);
    }
  }
  return true;
}

async function resolveIntentLocation(location: PluginIntentStateLocation): Promise<{
  allowedRoot: string;
  filePath: string;
}> {
  if (location.scope === 'user') {
    const allowedRoot = resolveAwHome(location.env);
    return {
      allowedRoot,
      filePath: resolvePluginIntentStatePath(location),
    };
  }
  const allowedRoot = await assertCanonicalProjectManagedRoots({
    cwd: location.cwd,
    rootNames: [],
    managedPaths: ['.agent-workflows'],
  });
  return {
    allowedRoot,
    filePath: path.join(allowedRoot, '.agent-workflows', 'plugin-intents.json'),
  };
}

async function readPluginIntentStateObservationUnsafe(
  location: PluginIntentStateLocation,
): Promise<Extract<PluginIntentStateObservation, { state: 'ready' | 'absent' }>> {
  resolvePluginIntentStatePath(location, 'read');
  const { allowedRoot, filePath } = await resolveIntentLocation(location);
  if (!await assertReadableIntentPath(allowedRoot, filePath)) {
    return { state: 'absent' };
  }
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid plugin intent state JSON.');
    }
    throw error;
  }
  return { state: 'ready', value: parsePluginIntentState(value) };
}

function invalidIntentPathError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:symbolic link|regular (?:directory|file)|escapes its allowed root|符号链接|realpath 越界|必须位于 repo 内)/iu
    .test(error.message);
}

export async function observePluginIntentState(
  location: PluginIntentStateLocation,
): Promise<PluginIntentStateObservation> {
  try {
    return await readPluginIntentStateObservationUnsafe(location);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    const invalid = invalidIntentPathError(error)
      || error instanceof SyntaxError
      || error instanceof Error && /^Invalid (?:plugin intent|roots|dependencyScopeOverrides)/u.test(error.message);
    return invalid ? {
      state: 'invalid',
      code: 'pluginIntentStateInvalid',
      message: '插件声明格式无效或路径不安全。',
    } : {
      state: 'unavailable',
      code: 'pluginIntentStateUnavailable',
      message: '无法读取插件声明。',
    };
  }
}

export async function readPluginIntentState(
  location: PluginIntentStateLocation,
): Promise<PluginIntentState> {
  const observation = await readPluginIntentStateObservationUnsafe(location);
  return observation.state === 'ready' ? observation.value : createEmptyPluginIntentState();
}

export async function writePluginIntentState(
  location: PluginIntentStateLocation,
  state: PluginIntentState,
): Promise<PluginIntentState> {
  const requestedPath = resolvePluginIntentStatePath(location, 'write');
  if (location.scope === 'project') {
    await assertProjectSharedConfigPathVisible({ cwd: location.cwd, targetPath: requestedPath });
  }
  const { allowedRoot, filePath } = await resolveIntentLocation(location);
  const canonical = canonicalizePluginIntentState(state);
  await atomicReplaceConfigFile({
    filePath,
    allowedRoot,
    content: serializePluginIntentState(canonical),
  });
  return canonical;
}
