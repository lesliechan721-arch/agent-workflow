import type { Dirent } from 'node:fs';
import path from 'node:path';

import fs from 'fs-extra';

import { readClaudeSettings } from '../adapters/helpers.js';
import { readCodexConfigFile } from './codex-config.js';
import { readJsonFileIfExists } from './json.js';
import {
  getClaudeHome,
  getCodexHome,
  canonicalizePathThroughExistingAncestorSync,
  resolveAwHome,
  resolveAwHomeCanonical,
  resolveRepoRootSync,
} from './state-paths.js';
import {
  OWNED_TEXT_HEADER_PREFIX,
  SHARED_OWNER_TOKEN_PREFIX,
  parseSharedOwnerToken,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  SKILL_OWNER_MARKER,
} from './ownership.js';
import { sanitizeCatalogSourceErrorMessage } from './catalog-public-error.js';
import { readStrictNamespacedMarketplaceRoot } from './local-marketplace.js';
import {
  readPluginIntentState,
  resolvePluginIntentStatePath,
} from './plugin-intent-state.js';
import type { PlatformName, Scope } from '../types.js';

export type CatalogSourceReferenceKind =
  | 'legacyOwner'
  | 'namespacedOwner'
  | 'legacyConfig'
  | 'namespacedConfig'
  | 'namespacedLifecycle'
  | 'legacyMarketplace'
  | 'namespacedMarketplace';

export interface CatalogSourceReference {
  kind: CatalogSourceReferenceKind;
  location: string;
  pluginName?: string;
  sourceId?: string;
  sourceIdentity?: string;
  marketplaceName?: string;
  platform?: string;
  scope?: string;
  projectKey?: string | null;
  pluginVersion?: string;
}

export function canonicalMarketplaceRegistrationNames(
  references: readonly CatalogSourceReference[],
  sourceId: string,
): string[] {
  return [...new Set(references.flatMap((reference) =>
    reference.kind === 'namespacedMarketplace'
    && reference.sourceId === sourceId
    && reference.pluginName === undefined
    && reference.marketplaceName
      ? [reference.marketplaceName]
      : []))];
}

interface NativeMarketplaceConsumer {
  pluginName: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  projectKey?: string | null;
}

function pluginNameFromMarketplaceId(pluginId: string, marketplaceName: string): string | null {
  const suffix = `@${marketplaceName}`;
  return pluginId.endsWith(suffix) && pluginId.length > suffix.length
    ? pluginId.slice(0, -suffix.length)
    : null;
}

function claudeConsumersFromSettings(
  value: Record<string, unknown> | null,
  marketplaceName: string,
  scope: 'user' | 'project',
): NativeMarketplaceConsumer[] {
  if (!value) return [];
  const output: NativeMarketplaceConsumer[] = [];
  for (const pluginId of Object.keys(isRecord(value.enabledPlugins) ? value.enabledPlugins : {})) {
    const pluginName = pluginNameFromMarketplaceId(pluginId, marketplaceName);
    if (pluginName) output.push({ pluginName, platform: 'claude', scope });
  }
  const plugins = isRecord(value.plugins) && isRecord(value.plugins.installed)
    ? value.plugins.installed
    : {};
  for (const [key, raw] of Object.entries(plugins)) {
    if (!isRecord(raw) || raw.marketplace !== marketplaceName) continue;
    const pluginName = typeof raw.name === 'string'
      ? raw.name
      : pluginNameFromMarketplaceId(key, marketplaceName) ?? key;
    output.push({ pluginName, platform: 'claude', scope });
  }
  return output;
}

function claudeConsumersFromInstalled(
  value: Record<string, unknown> | null,
  marketplaceName: string,
  currentProject: string,
  includeHistoricalProjects = false,
): NativeMarketplaceConsumer[] {
  const output: NativeMarketplaceConsumer[] = [];
  if (value !== null && !isRecord(value)) {
    throw new Error('Claude installed_plugins must be a JSON object.');
  }
  if (value?.plugins !== undefined && !isRecord(value.plugins)) {
    throw new Error('Claude installed_plugins.plugins must be a JSON object.');
  }
  const plugins = value?.plugins ?? {};
  for (const [key, raw] of Object.entries(plugins)) {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (!isRecord(item)) {
        throw new Error(`Claude installed_plugins record ${key} must be a JSON object.`);
      }
      if (item.marketplace !== undefined
        && (typeof item.marketplace !== 'string' || item.marketplace.length === 0)) {
        throw new Error(`Claude installed_plugins record ${key} has an invalid marketplace identity.`);
      }
      if (item.name !== undefined && (typeof item.name !== 'string' || item.name.length === 0)) {
        throw new Error(`Claude installed_plugins record ${key} has an invalid plugin identity.`);
      }
      if (item.scope !== undefined
        && item.scope !== 'user'
        && item.scope !== 'project'
        && item.scope !== 'local') {
        throw new Error(`Claude installed_plugins record ${key} has an invalid scope.`);
      }
      if (item.projectPath !== undefined && typeof item.projectPath !== 'string') {
        throw new Error(`Claude installed_plugins record ${key} has an invalid projectPath.`);
      }
      const itemMarketplace = typeof item.marketplace === 'string'
        ? item.marketplace
        : pluginNameFromMarketplaceId(key, marketplaceName) ? marketplaceName : undefined;
      if (!itemMarketplace) continue;
      if (itemMarketplace !== marketplaceName) continue;
      const scope = item.scope === 'project' || item.scope === 'local' ? 'project' : 'user';
      const projectKey = scope === 'project'
        ? typeof item.projectPath === 'string' && path.isAbsolute(item.projectPath)
          ? canonicalizePathThroughExistingAncestorSync(item.projectPath)
          : null
        : undefined;
      if (scope === 'project' && !includeHistoricalProjects && projectKey !== currentProject) continue;
      const pluginName = typeof item.name === 'string'
        ? item.name
        : pluginNameFromMarketplaceId(key, marketplaceName) ?? key;
      output.push({ pluginName, platform: 'claude', scope, ...(scope === 'project' ? { projectKey } : {}) });
    }
  }
  return output;
}

export interface CatalogSourceReferenceInventory {
  inventorySchemaVersion: 1;
  references: CatalogSourceReference[];
  errors: CatalogSourceInventoryError[];
}

export interface CatalogSourceInventoryError {
  code: 'stateInventoryFailed';
  kind: string;
  location: string;
  message: string;
  relevance:
    | { global: true }
    | {
        global: false;
        sourceId?: string;
        pluginName?: string;
        platform?: PlatformName;
        scope?: Scope;
        projectLocationKey?: string;
      };
}

function pathSegmentsWithin(root: string, location: string): string[] | null {
  const relative = path.relative(path.resolve(root), path.resolve(location));
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    return relative === '' ? [] : relative.split(path.sep);
  }
  return null;
}

function inventoryErrorRelevance(
  location: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): CatalogSourceInventoryError['relevance'] {
  const repoRoot = resolveRepoRootSync(cwd);
  const awHome = resolveAwHome(env);
  const canonicalRepoRoot = (() => {
    try {
      return fs.realpathSync(repoRoot);
    } catch {
      return path.resolve(repoRoot);
    }
  })();
  const canonicalAwHome = (() => {
    try {
      return canonicalizePathThroughExistingAncestorSync(awHome);
    } catch {
      return path.resolve(awHome);
    }
  })();
  const projectRoots: Array<[string, PlatformName]> = [
    [path.join(repoRoot, '.codex'), 'codex'],
    [path.join(repoRoot, '.agents'), 'codex'],
    [path.join(repoRoot, '.claude'), 'claude'],
  ];
  for (const [root, platform] of projectRoots) {
    if (pathSegmentsWithin(root, location) !== null) {
      return { global: false, platform, scope: 'project' };
    }
  }
  for (const fileName of ['installed_plugins.json', 'known_marketplaces.json']) {
    if (pathSegmentsWithin(path.join(getClaudeHome(env), 'plugins', fileName), location) !== null) {
      return { global: false, platform: 'claude' };
    }
  }
  if (pathSegmentsWithin(getCodexHome(env), location) !== null) {
    return { global: false, platform: 'codex', scope: 'user' };
  }
  if (pathSegmentsWithin(getClaudeHome(env), location) !== null) {
    return { global: false, platform: 'claude', scope: 'user' };
  }
  for (const root of new Set([awHome, canonicalAwHome])) {
    const marketplace = pathSegmentsWithin(path.join(root, 'marketplaces'), location);
    if (marketplace?.[0]) return { global: false, sourceId: marketplace[0] };
  }
  for (const [root, scope] of [
    [path.join(awHome, 'plugin-config'), 'user'],
    [path.join(canonicalAwHome, 'plugin-config'), 'user'],
    [path.join(repoRoot, '.agent-workflows', 'plugin-config'), 'project'],
    [path.join(canonicalRepoRoot, '.agent-workflows', 'plugin-config'), 'project'],
  ] as const) {
    const segments = pathSegmentsWithin(root, location);
    if (segments !== null) {
      return {
        global: false,
        ...(segments[0] ? { sourceId: segments[0] } : {}),
        ...(segments[1] ? { pluginName: segments[1] } : {}),
        scope,
      };
    }
  }
  for (const root of new Set([repoRoot, canonicalRepoRoot])) {
    if (pathSegmentsWithin(path.join(root, '.agent-workflows'), location) !== null) {
      return { global: false, scope: 'project' };
    }
  }
  return { global: true };
}

function isAbsentState(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}

function inventoryError(
  error: unknown,
  location: string,
  kind: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  relevance?: CatalogSourceInventoryError['relevance'],
): CatalogSourceInventoryError {
  const message = error instanceof Error ? error.message : String(error);
  const sensitiveRoots = [getCodexHome(env), getClaudeHome(env), resolveRepoRootSync(cwd)];
  return {
    code: 'stateInventoryFailed',
    kind,
    location: sanitizeCatalogSourceErrorMessage(location, env, sensitiveRoots),
    message: sanitizeCatalogSourceErrorMessage(message, env, sensitiveRoots),
    relevance: relevance ?? inventoryErrorRelevance(location, env, cwd),
  };
}

async function inventoryRead<T>(options: {
  operation: () => Promise<T>;
  absent: T;
  reportAbsent?: boolean;
  errors: CatalogSourceInventoryError[];
  location: string;
  kind: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<T> {
  try {
    return await options.operation();
  } catch (error) {
    if (options.reportAbsent || !isAbsentState(error)) {
      options.errors.push(inventoryError(error, options.location, options.kind, options.env, options.cwd));
    }
    return options.absent;
  }
}

async function inventoryCanonicalDirectory(options: {
  errors: CatalogSourceInventoryError[];
  location: string;
  kind: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<boolean> {
  const stats = await inventoryRead({
    operation: () => fs.lstat(options.location),
    absent: null,
    errors: options.errors,
    location: options.location,
    kind: options.kind,
    env: options.env,
    cwd: options.cwd,
  });
  if (stats === null) return false;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    options.errors.push(inventoryError(
      new Error('State namespace root must be a canonical directory.'),
      options.location,
      options.kind,
      options.env,
      options.cwd,
    ));
    return false;
  }
  return true;
}

async function inventoryCanonicalDirectoryEntries(options: {
  errors: CatalogSourceInventoryError[];
  location: string;
  kind: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<Dirent[]> {
  if (!await inventoryCanonicalDirectory(options)) return [];
  return inventoryRead({
    operation: () => fs.readdir(options.location, { withFileTypes: true }),
    absent: [],
    errors: options.errors,
    location: options.location,
    kind: options.kind,
    env: options.env,
    cwd: options.cwd,
  });
}

async function inventoryCanonicalDescendantDirectory(options: {
  root: string;
  segments: string[];
  errors: CatalogSourceInventoryError[];
  kind: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<string | null> {
  let location = options.root;
  for (const segment of options.segments) {
    location = path.join(location, segment);
    if (!await inventoryCanonicalDirectory({
      errors: options.errors,
      location,
      kind: options.kind,
      env: options.env,
      cwd: options.cwd,
    })) return null;
  }
  return location;
}

async function inventoryPluginConfigRoots(options: {
  errors: CatalogSourceInventoryError[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<Array<{
  root: string;
  scope: 'user' | 'project';
  projectKey?: string;
}>> {
  const roots: Array<{
    root: string;
    scope: 'user' | 'project';
    projectKey?: string;
  }> = [];
  const rawAwHome = resolveAwHome(options.env);
  const awHome = await inventoryRead({
    operation: () => resolveAwHomeCanonical(options.env),
    absent: null,
    errors: options.errors,
    location: rawAwHome,
    kind: 'configDirectoryRead',
    env: options.env,
    cwd: options.cwd,
  });
  if (awHome && await inventoryCanonicalDirectory({
    errors: options.errors,
    location: awHome,
    kind: 'configDirectoryRead',
    env: options.env,
    cwd: options.cwd,
  })) {
    const userRoot = await inventoryCanonicalDescendantDirectory({
      root: rawAwHome,
      segments: ['plugin-config'],
      errors: options.errors,
      kind: 'configDirectoryRead',
      env: options.env,
      cwd: options.cwd,
    });
    if (userRoot) roots.push({ root: userRoot, scope: 'user' });
  }

  const rawRepoRoot = resolveRepoRootSync(options.cwd);
  const repoRoot = await inventoryRead({
    operation: () => fs.realpath(rawRepoRoot),
    absent: null,
    reportAbsent: true,
    errors: options.errors,
    location: rawRepoRoot,
    kind: 'projectRootRead',
    env: options.env,
    cwd: options.cwd,
  });
  if (repoRoot && await inventoryCanonicalDirectory({
    errors: options.errors,
    location: repoRoot,
    kind: 'projectRootRead',
    env: options.env,
    cwd: options.cwd,
  })) {
    const projectRoot = await inventoryCanonicalDescendantDirectory({
      root: rawRepoRoot,
      segments: ['.agent-workflows', 'plugin-config'],
      errors: options.errors,
      kind: 'configDirectoryRead',
      env: options.env,
      cwd: options.cwd,
    });
    if (projectRoot) roots.push({ root: projectRoot, scope: 'project', projectKey: repoRoot });
  }
  return roots;
}

export async function inventoryLegacyOwnerReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const repoRoot = resolveRepoRootSync(options.cwd);
  const references: CatalogSourceReference[] = [];
  const errors: CatalogSourceInventoryError[] = [];
  const skillRoots = new Set([
    path.join(getCodexHome(env), 'skills'),
    path.join(getClaudeHome(env), 'skills'),
    path.join(repoRoot, '.claude', 'skills'),
  ]);
  const legacyPluginsRoot = path.join(awHome, 'plugins');
  const legacyPlugins = await inventoryRead({
    operation: () => fs.readdir(legacyPluginsRoot, { withFileTypes: true }),
    absent: [], errors, location: legacyPluginsRoot, kind: 'pluginDirectoryRead', env, cwd: options.cwd,
  });
  for (const plugin of legacyPlugins) {
    if (!plugin.isDirectory() || plugin.isSymbolicLink()) continue;
    for (const root of await resolveCanonicalPluginSkillRoots(
      path.join(legacyPluginsRoot, plugin.name),
      true,
      errors,
      env,
      options.cwd,
    )) skillRoots.add(root);
  }
  for (const root of skillRoots) {
    references.push(...await findDirectSkillOwnerMarkers(root, errors, env, options.cwd));
  }
  for (const configRoot of [
    getCodexHome(env),
    getClaudeHome(env),
    path.join(repoRoot, '.claude'),
  ]) {
    references.push(
      ...await findOwnedHeadersInDirectory(path.join(configRoot, 'rules'), new Set(['.md', '.rules']), true, errors, env, options.cwd),
      ...await findOwnedHeadersInDirectory(path.join(configRoot, 'agents'), new Set(['.md', '.toml']), true, errors, env, options.cwd),
    );
  }
  for (const [directory, extensions] of [
    [path.join(repoRoot, '.codex', 'rules'), new Set(['.md', '.rules'])],
    [path.join(repoRoot, '.codex', 'agents'), new Set(['.md', '.toml'])],
  ] as const) {
    references.push(...(await findOwnedHeadersInDirectory(
      directory,
      extensions,
      true,
      errors,
      env,
      options.cwd,
    )).filter((reference) => reference.kind === 'namespacedOwner'));
  }
  for (const filePath of [path.join(getCodexHome(env), 'AGENTS.md')]) {
    const reference = await readOwnedHeaderReference(filePath, false, errors, env, options.cwd);
    if (reference) references.push(reference);
  }
  const unique = [...new Map(references.map((reference) => [[
    reference.kind,
    reference.location,
    reference.sourceId ?? '',
    reference.sourceIdentity ?? '',
    reference.pluginName ?? '',
    reference.platform ?? '',
    reference.scope ?? '',
    reference.marketplaceName ?? '',
  ].join('\0'), reference])).values()];
  unique.sort((left, right) => left.location.localeCompare(right.location));
  return { inventorySchemaVersion: 1, references: unique, errors };
}

export async function inventoryLegacyConfigReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const references: CatalogSourceReference[] = [];
  const errors: CatalogSourceInventoryError[] = [];
  for (const configRoot of await inventoryPluginConfigRoots({ errors, env, cwd: options.cwd })) {
    const directory = configRoot.root;
    const entries = await inventoryRead({
      operation: () => fs.readdir(directory, { withFileTypes: true }),
      absent: [], errors, location: directory, kind: 'configDirectoryRead', env, cwd: options.cwd,
    });
    for (const entry of entries) {
      const entryRoot = path.join(directory, entry.name);
      if (!await inventoryCanonicalDirectory({
        errors, location: entryRoot, kind: 'configNamespaceValidation', env, cwd: options.cwd,
      })) continue;
      const legacyFile = path.join(directory, entry.name, 'config.json');
      const stat = await inventoryRead({
        operation: () => fs.stat(legacyFile),
        absent: null, errors, location: legacyFile, kind: 'configFileStat', env, cwd: options.cwd,
      });
      if (stat?.isFile()) {
        references.push({
          kind: 'legacyConfig',
          location: legacyFile,
          pluginName: entry.name,
          scope: configRoot.scope,
          ...(configRoot.projectKey ? { projectKey: configRoot.projectKey } : {}),
        });
      }
    }
  }
  references.sort((left, right) => left.location.localeCompare(right.location));
  return { inventorySchemaVersion: 1, references, errors };
}

function ownerReferenceFromRaw(
  entryPath: string,
  raw: Record<string, unknown> | null,
): CatalogSourceReference | null {
  if (raw?.schemaVersion === 3 && raw.owner === 'agent-workflows'
    && typeof raw.sourceId === 'string'
    && raw.pluginId === `${raw.sourceId}/${raw.plugin}`) {
    return {
      kind: 'namespacedOwner',
      location: entryPath,
      sourceId: raw.sourceId,
      ...(typeof raw.plugin === 'string' ? { pluginName: raw.plugin } : {}),
      ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}),
      ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    };
  }
  return null;
}

async function readOwnedHeaderReference(
  filePath: string,
  requireGeneratedName: boolean,
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CatalogSourceReference | null> {
  const stats = await inventoryRead({
    operation: () => fs.stat(filePath),
    absent: null,
    errors,
    location: filePath,
    kind: 'ownerHeaderStat',
    env,
    cwd,
  });
  if (!stats?.isFile() || stats.size > 1024 * 1024) return null;
  const content = await inventoryRead({
    operation: () => fs.readFile(filePath, 'utf8'),
    absent: null,
    errors,
    location: filePath,
    kind: 'ownerHeaderRead',
    env,
    cwd,
  });
  if (content === null) return null;
  if (!content.includes(OWNED_TEXT_HEADER_PREFIX)) return null;
  let parsed: ReturnType<typeof parseOwnedTextHeader>;
  try {
    parsed = parseOwnedTextHeader(content);
  } catch (error) {
    errors.push(inventoryError(error, filePath, 'ownerHeaderParse', env, cwd));
    return null;
  }
  if (!parsed) return null;
  if (requireGeneratedName
    && !path.basename(filePath).startsWith(`aw-${parsed.identity.plugin}-`)) {
    errors.push(inventoryError(
      new Error('Owned text header path does not match its plugin identity.'),
      filePath,
      'ownerHeaderPathValidation',
      env,
      cwd,
      {
        global: false,
        ...(parsed.identity.sourceId ? { sourceId: parsed.identity.sourceId } : {}),
        pluginName: parsed.identity.plugin,
        platform: parsed.identity.platform,
        scope: parsed.identity.scope,
      },
    ));
    return null;
  }
  return ownerReferenceFromRaw(filePath, {
    schemaVersion: 3,
    ...parsed.identity,
  });
}

async function findOwnedHeadersInDirectory(
  directory: string,
  extensions: ReadonlySet<string>,
  requireGeneratedName: boolean,
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CatalogSourceReference[]> {
  const output: CatalogSourceReference[] = [];
  const entries = await inventoryRead({
    operation: () => fs.readdir(directory, { withFileTypes: true }),
    absent: [],
    errors,
    location: directory,
    kind: 'ownerDirectoryRead',
    env,
    cwd,
  });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !extensions.has(path.extname(entry.name))) continue;
    const reference = await readOwnedHeaderReference(
      path.join(directory, entry.name),
      requireGeneratedName,
      errors,
      env,
      cwd,
    );
    if (reference) output.push(reference);
  }
  return output;
}

function safeRelativeSkillRoot(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = path.posix.normalize(value.replace(/^\.\//u, ''));
  return normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)
    ? null
    : normalized;
}

async function resolveCanonicalPluginSkillRoots(
  pluginRoot: string,
  includeLegacyFallbacks: boolean,
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string[]> {
  const [platformManifest, sourceManifest] = await Promise.all([
    inventoryRead({
      operation: () => fs.readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json')),
      absent: null,
      errors,
      location: path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
      kind: 'pluginManifestRead',
      env,
      cwd,
    }),
    inventoryRead({
      operation: () => fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json')),
      absent: null,
      errors,
      location: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
      kind: 'pluginManifestRead',
      env,
      cwd,
    }),
  ]) as [Record<string, unknown> | null, Record<string, unknown> | null];
  const declared = safeRelativeSkillRoot(platformManifest?.skills ?? sourceManifest?.skills)
    ?? 'codex/skills';
  return [...new Set([
    path.join(pluginRoot, ...declared.split('/')),
    ...(includeLegacyFallbacks ? [
      path.join(pluginRoot, 'skills'),
      path.join(pluginRoot, 'codex', 'skills'),
    ] : []),
  ])];
}

async function findDirectSkillOwnerMarkers(
  root: string,
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CatalogSourceReference[]> {
  const output: CatalogSourceReference[] = [];
  const entries = await inventoryRead({
    operation: () => fs.readdir(root, { withFileTypes: true }),
    absent: [],
    errors,
    location: root,
    kind: 'skillRootRead',
    env,
    cwd,
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillRoot = path.join(root, entry.name);
    const markerPath = path.join(root, entry.name, SKILL_OWNER_MARKER);
    const markerStats = await inventoryRead({
      operation: () => fs.lstat(markerPath),
      absent: null,
      errors,
      location: markerPath,
      kind: 'ownerMarkerRead',
      env,
      cwd,
    });
    if (!markerStats) continue;
    let marker: Awaited<ReturnType<typeof readSkillOwnerMarker>>;
    try {
      marker = await readSkillOwnerMarker({ skillRoot, allowedRoot: root });
    } catch (error) {
      if (!isAbsentState(error)) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = error instanceof Error ? error.message : String(error);
        errors.push(inventoryError(
          error,
          markerPath,
          code !== undefined || message.includes('JSON') ? 'ownerMarkerRead' : 'ownerMarkerValidation',
          env,
          cwd,
        ));
      }
      continue;
    }
    if (!marker) continue;
    const reference = ownerReferenceFromRaw(markerPath, { ...marker });
    if (reference) output.push(reference);
  }
  return output;
}

function sharedOwnerTokenReferences(
  filePath: string,
  tokens: Iterable<string>,
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): CatalogSourceReference[] {
  const output: CatalogSourceReference[] = [];
  for (const token of new Set(tokens)) {
    let identity: ReturnType<typeof parseSharedOwnerToken>;
    try {
      identity = parseSharedOwnerToken(token);
    } catch (error) {
      errors.push(inventoryError(error, filePath, 'sharedOwnerTokenParse', env, cwd));
      continue;
    }
    if (!identity?.sourceId) continue;
    output.push({
      kind: 'namespacedOwner',
      location: filePath,
      sourceId: identity.sourceId,
      pluginName: identity.plugin,
      platform: identity.platform,
      scope: identity.scope,
    });
  }
  return output;
}

async function codexSharedOwnerReferences(
  filePath: string,
  _scope: 'user' | 'project',
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CatalogSourceReference[]> {
  const config = await readCodexConfigFile(filePath);
  const ownerValues = [
    ...Object.keys(config.snapshot.developerInstructions.managedBlocks).map((value) => ({
      value,
      location: filePath,
    })),
  ];
  const references = sharedOwnerTokenReferences(
    filePath,
    ownerValues.map((entry) => entry.value).filter((value) => value.startsWith(SHARED_OWNER_TOKEN_PREFIX)),
    errors,
    env,
    cwd,
  );
  return references;
}

async function claudeSharedOwnerReferences(
  filePath: string,
  _scope: 'user' | 'project',
  errors: CatalogSourceInventoryError[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<CatalogSourceReference[]> {
  const settings = await readJsonFileIfExists<Record<string, unknown>>(filePath);
  const generated = settings && isRecord(settings.awGenerated) ? settings.awGenerated : null;
  const permissions = generated && isRecord(generated.permissions) ? generated.permissions : {};
  const keys = Object.keys(permissions);
  const references = sharedOwnerTokenReferences(
    filePath,
    keys.filter((token) => token.startsWith(SHARED_OWNER_TOKEN_PREFIX)),
    errors,
    env,
    cwd,
  );
  return references;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNamespacedConfigEnvelope(
  value: unknown,
  sourceId: string,
  pluginName: string,
): asserts value is {
  schemaVersion: 3;
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  values: Record<string, unknown>;
} {
  if (!isRecord(value)
    || value.schemaVersion !== 3
    || typeof value.sourceId !== 'string'
    || typeof value.sourceIdentity !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(value.sourceIdentity)
    || typeof value.pluginName !== 'string'
    || !isRecord(value.values)
    || Object.keys(value).some((key) => ![
      'schemaVersion', 'sourceId', 'sourceIdentity', 'pluginName', 'values',
    ].includes(key))) {
    throw new Error('Namespaced plugin config is not a valid schema 3 envelope.');
  }
  if (value.sourceId !== sourceId || value.pluginName !== pluginName) {
    throw new Error('Namespaced plugin config identity does not match its directory path.');
  }
}

function hasClaudeMarketplaceConsumer(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasClaudeMarketplaceConsumer);
  if (!isRecord(value)) return false;
  if (value.marketplace === 'aw') return true;
  return Object.values(value).some(hasClaudeMarketplaceConsumer);
}

function isAwPluginConsumerKey(value: string): boolean {
  return value.length > '@aw'.length && value.endsWith('@aw');
}

function hasAwPluginConsumerKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some(isAwPluginConsumerKey);
}

async function oldMarketplaceReferences(
  env: NodeJS.ProcessEnv,
  cwd: string,
  errors: CatalogSourceInventoryError[],
  includePlatformHistoricalProjects: boolean,
): Promise<CatalogSourceReference[]> {
  const codexPath = path.join(getCodexHome(env), 'config.toml');
  const claudeSettingsPath = path.join(getClaudeHome(env), 'settings.json');
  const claudeKnownPath = path.join(getClaudeHome(env), 'plugins', 'known_marketplaces.json');
  const claudeInstalledPath = path.join(getClaudeHome(env), 'plugins', 'installed_plugins.json');
  const output: CatalogSourceReference[] = [];
  const marketplacesRoot = path.join(resolveAwHome(env), 'marketplaces');
  const namespacedPrimaryRoots = new Set<string>();
  const marketplaceEntries = await inventoryCanonicalDirectoryEntries({
    errors, location: marketplacesRoot, kind: 'marketplaceDirectoryRead', env, cwd,
  });
  for (const entry of marketplaceEntries) {
    const marketplaceRoot = path.join(marketplacesRoot, entry.name);
    if (!await inventoryCanonicalDirectory({
      errors, location: marketplaceRoot, kind: 'marketplaceRootValidation', env, cwd,
    })) continue;
    const manifestPath = path.join(marketplacesRoot, entry.name, '.agents', 'plugins', 'marketplace.json');
    const configPath = path.join(marketplacesRoot, entry.name, 'config.json');
    const manifest = await inventoryRead({
      operation: () => fs.readJson(manifestPath), absent: null, errors,
      location: manifestPath, kind: 'marketplaceManifestRead', env, cwd,
    }) as Record<string, unknown> | null;
    const config = await inventoryRead({
      operation: () => fs.readJson(configPath), absent: null, errors,
      location: configPath, kind: 'marketplaceConfigRead', env, cwd,
    }) as Record<string, unknown> | null;
    if (manifest?.name === 'aw' && config?.schemaVersion === 2 && config.sourceId === entry.name) {
      namespacedPrimaryRoots.add(path.normalize(path.join(marketplacesRoot, entry.name)));
    }
  }

  const codex = await inventoryRead({
    operation: () => readCodexConfigFile(codexPath), absent: null, errors,
    location: codexPath, kind: 'nativeStateRead', env, cwd,
  });
  const codexAw = codex?.snapshot.marketplaces.aw;
  const codexAwIsNamespaced = codexAw?.sourceType === 'local'
    && !codexAw.sourcePointsToManifest
    && namespacedPrimaryRoots.has(path.normalize(codexAw.source ?? ''));
  if (codex && (Object.hasOwn(codex.snapshot.marketplaces, 'aw') || Object.keys(codex.snapshot.plugins).some(isAwPluginConsumerKey))
    && !codexAwIsNamespaced) {
    output.push({ kind: 'legacyMarketplace', location: codexPath });
    for (const pluginId of Object.keys(codex.snapshot.plugins)) {
      const pluginName = pluginNameFromMarketplaceId(pluginId, 'aw');
      if (pluginName) output.push({
        kind: 'legacyMarketplace',
        location: codexPath,
        pluginName,
        platform: 'codex',
        scope: 'user',
      });
    }
  }

  const settings = await inventoryRead({
    operation: () => readClaudeSettings(claudeSettingsPath), absent: null, errors,
    location: claudeSettingsPath, kind: 'nativeStateRead', env, cwd,
  });
  const known = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(claudeKnownPath), absent: null, errors,
    location: claudeKnownPath, kind: 'nativeStateRead', env, cwd,
  });
  const declarationPaths = [
    (settings?.extraKnownMarketplaces as Record<string, unknown> | undefined)?.aw,
    known?.aw,
    isRecord(known?.marketplaces) ? known.marketplaces.aw : undefined,
  ].flatMap((value) => collectMarketplaceDeclarationPaths(value));
  const claudeAwIsNamespaced = declarationPaths.length > 0
    && declarationPaths.every((entry) => namespacedPrimaryRoots.has(path.normalize(entry)));
  if ((
    settings && (Object.hasOwn(settings.extraKnownMarketplaces ?? {}, 'aw')
    || hasAwPluginConsumerKeys(settings.enabledPlugins)
    || hasAwPluginConsumerKeys(settings.plugins?.installed)
    || hasClaudeMarketplaceConsumer(settings.plugins?.installed))
  ) && !claudeAwIsNamespaced) {
    output.push({ kind: 'legacyMarketplace', location: claudeSettingsPath });
    for (const consumer of claudeConsumersFromSettings(settings as unknown as Record<string, unknown>, 'aw', 'user')) {
      output.push({ kind: 'legacyMarketplace', location: claudeSettingsPath, ...consumer });
    }
  }

  if (known && (
    Object.hasOwn(known, 'aw')
    || (isRecord(known.marketplaces) && Object.hasOwn(known.marketplaces, 'aw'))
    || hasClaudeMarketplaceConsumer(known)
  ) && !claudeAwIsNamespaced) {
    output.push({ kind: 'legacyMarketplace', location: claudeKnownPath });
  }
  const installed = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(claudeInstalledPath), absent: null, errors,
    location: claudeInstalledPath, kind: 'nativeStateRead', env, cwd,
  });
  if (installed && (
    hasAwPluginConsumerKeys(installed.plugins)
    || hasClaudeMarketplaceConsumer(installed.plugins)
  ) && !claudeAwIsNamespaced) {
    output.push({ kind: 'legacyMarketplace', location: claudeInstalledPath });
    const canonicalProjectRoot = await inventoryRead({
      operation: () => fs.realpath(resolveRepoRootSync(cwd)),
      absent: path.resolve(resolveRepoRootSync(cwd)), errors,
      location: resolveRepoRootSync(cwd), kind: 'projectRootRead', env, cwd,
    });
    try {
      for (const consumer of claudeConsumersFromInstalled(
        installed,
        'aw',
        path.normalize(canonicalProjectRoot),
        includePlatformHistoricalProjects,
      )) {
        output.push({ kind: 'legacyMarketplace', location: claudeInstalledPath, ...consumer });
      }
    } catch (error) {
      errors.push(inventoryError(error, claudeInstalledPath, 'nativeStateRead', env, cwd));
    }
  }
  const projectSettingsPath = path.join(resolveRepoRootSync(cwd), '.claude', 'settings.json');
  const projectSettings = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(projectSettingsPath), absent: null, errors,
    location: projectSettingsPath, kind: 'nativeStateRead', env, cwd,
  });
  if (!claudeAwIsNamespaced) {
    for (const consumer of claudeConsumersFromSettings(projectSettings, 'aw', 'project')) {
      output.push({ kind: 'legacyMarketplace', location: projectSettingsPath, ...consumer });
    }
  }
  return output;
}

function collectMarketplaceDeclarationPaths(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const output: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'path' || key === 'installLocation') && typeof entry === 'string') {
      output.push(entry);
    } else if (key === 'source' && typeof entry === 'string' && path.isAbsolute(entry)) {
      output.push(entry);
    } else if (isRecord(entry)) {
      output.push(...collectMarketplaceDeclarationPaths(entry));
    }
  }
  return output;
}

function marketplaceNamesRegisteredAtRoot(
  value: unknown,
  marketplaceRoot: string,
): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, declaration]) =>
    collectMarketplaceDeclarationPaths(declaration).some((candidate) =>
      path.normalize(candidate) === path.normalize(marketplaceRoot))
      ? [name]
      : []);
}

function sourceIdFromCanonicalMarketplacePath(
  candidate: string,
  marketplacesRoot: string,
): string | null {
  if (!path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(candidate);
  const root = path.resolve(marketplacesRoot);
  if (path.dirname(resolved) !== root) return null;
  const sourceId = path.basename(resolved);
  return sourceId !== '' && sourceId !== '.' && sourceId !== '..' ? sourceId : null;
}

function registeredMarketplaceRoots(
  value: unknown,
  marketplacesRoot: string,
): Array<{ marketplaceName: string; sourceId: string }> {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([marketplaceName, declaration]) =>
    collectMarketplaceDeclarationPaths(declaration).flatMap((candidate) => {
      const sourceId = sourceIdFromCanonicalMarketplacePath(candidate, marketplacesRoot);
      return sourceId ? [{ marketplaceName, sourceId }] : [];
    }));
}

export async function inventoryCatalogSourceReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  includePlatformHistoricalProjects?: boolean;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const references: CatalogSourceReference[] = [];
  const errors: CatalogSourceInventoryError[] = [];
  const canonicalProjectRoot = await inventoryRead({
    operation: () => fs.realpath(resolveRepoRootSync(options.cwd)),
    absent: path.resolve(resolveRepoRootSync(options.cwd)),
    errors,
    location: resolveRepoRootSync(options.cwd),
    kind: 'projectRootRead',
    env,
    cwd: options.cwd,
  });
  const legacyConfig = await inventoryLegacyConfigReferences(options);
  references.push(...legacyConfig.references);
  errors.push(...legacyConfig.errors);
  for (const scope of ['user', 'project'] as const) {
    const location = resolvePluginIntentStatePath({ scope, cwd: options.cwd, env });
    const state = await inventoryRead({
      operation: () => readPluginIntentState({ scope, cwd: options.cwd, env }),
      absent: null,
      errors,
      location,
      kind: 'lifecycleIntentRead',
      env,
      cwd: options.cwd,
    });
    if (!state) continue;
    for (const pluginId of new Set([
      ...state.roots.map((root) => root.pluginId),
      ...state.dependencyScopeOverrides.map((override) => override.pluginId),
    ])) {
      const separator = pluginId.indexOf('/');
      if (separator <= 0 || separator === pluginId.length - 1) continue;
      references.push({
        kind: 'namespacedLifecycle',
        location,
        sourceId: pluginId.slice(0, separator),
        pluginName: pluginId.slice(separator + 1),
        scope,
      });
    }
  }
  for (const configInventory of await inventoryPluginConfigRoots({ errors, env, cwd: options.cwd })) {
    const configRoot = configInventory.root;
    const sourceEntries = await inventoryRead({
      operation: () => fs.readdir(configRoot, { withFileTypes: true }),
      absent: [], errors, location: configRoot, kind: 'configDirectoryRead', env, cwd: options.cwd,
    });
    for (const sourceEntry of sourceEntries) {
      const sourceConfigRoot = path.join(configRoot, sourceEntry.name);
      const pluginEntries = await inventoryCanonicalDirectoryEntries({
        errors, location: sourceConfigRoot, kind: 'configNamespaceValidation', env, cwd: options.cwd,
      });
      for (const pluginEntry of pluginEntries) {
        if (pluginEntry.name === 'config.json') continue;
        const pluginConfigRoot = path.join(sourceConfigRoot, pluginEntry.name);
        if (!await inventoryCanonicalDirectory({
          errors,
          location: pluginConfigRoot,
          kind: 'configPluginRootValidation',
          env,
          cwd: options.cwd,
        })) continue;
        const configPath = path.join(configRoot, sourceEntry.name, pluginEntry.name, 'config.json');
        const configStats = await inventoryRead({
          operation: () => fs.lstat(configPath), absent: null, errors,
          location: configPath, kind: 'configFileRead', env, cwd: options.cwd,
        });
        if (configStats === null) continue;
        if (!configStats.isFile() || configStats.isSymbolicLink()) {
          errors.push(inventoryError(
            new Error('Config inventory target must be a regular file.'),
            configPath,
            'configFileValidation',
            env,
            options.cwd,
          ));
          continue;
        }
        const value = await inventoryRead({
          operation: () => fs.readJson(configPath), absent: null, errors,
          location: configPath, kind: 'configFileRead', env, cwd: options.cwd,
        }) as unknown;
        if (value === null) continue;
        try {
          assertNamespacedConfigEnvelope(value, sourceEntry.name, pluginEntry.name);
        } catch (error) {
          errors.push(inventoryError(
            error,
            configPath,
            'configFileValidation',
            env,
            options.cwd,
          ));
          continue;
        }
        references.push({
          kind: 'namespacedConfig',
          location: configPath,
          sourceId: sourceEntry.name,
          pluginName: pluginEntry.name,
          scope: configInventory.scope,
          ...(configInventory.projectKey ? { projectKey: configInventory.projectKey } : {}),
        });
      }
    }
  }
  const ownerInventory = await inventoryLegacyOwnerReferences(options);
  references.push(...ownerInventory.references);
  errors.push(...ownerInventory.errors);
  for (const [location, kind, operation] of [
    [path.join(getCodexHome(env), 'config.toml'), 'nativeStateRead', () => codexSharedOwnerReferences(path.join(getCodexHome(env), 'config.toml'), 'user', errors, env, options.cwd)],
    [path.join(getClaudeHome(env), 'settings.json'), 'nativeStateRead', () => claudeSharedOwnerReferences(path.join(getClaudeHome(env), 'settings.json'), 'user', errors, env, options.cwd)],
    [path.join(resolveRepoRootSync(options.cwd), '.codex', 'config.toml'), 'nativeStateRead', () => codexSharedOwnerReferences(path.join(resolveRepoRootSync(options.cwd), '.codex', 'config.toml'), 'project', errors, env, options.cwd)],
    [path.join(resolveRepoRootSync(options.cwd), '.claude', 'settings.json'), 'nativeStateRead', () => claudeSharedOwnerReferences(path.join(resolveRepoRootSync(options.cwd), '.claude', 'settings.json'), 'project', errors, env, options.cwd)],
  ] as const) {
    references.push(...await inventoryRead({
      operation, absent: [], errors, location, kind, env, cwd: options.cwd,
    }));
  }
  references.push(...await oldMarketplaceReferences(
    env,
    options.cwd,
    errors,
    options.includePlatformHistoricalProjects === true,
  ));
  const marketplacesRoot = path.join(awHome, 'marketplaces');
  const codexConfigPath = path.join(getCodexHome(env), 'config.toml');
  const codexConfig = await inventoryRead({
    operation: () => readCodexConfigFile(codexConfigPath), absent: null, errors,
    location: codexConfigPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const projectCodexConfigPath = path.join(resolveRepoRootSync(options.cwd), '.codex', 'config.toml');
  const projectCodexConfig = await inventoryRead({
    operation: () => readCodexConfigFile(projectCodexConfigPath), absent: null, errors,
    location: projectCodexConfigPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const userClaudeSettingsPath = path.join(getClaudeHome(env), 'settings.json');
  const userClaudeSettings = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(userClaudeSettingsPath), absent: null, errors,
    location: userClaudeSettingsPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const projectClaudeSettingsPath = path.join(resolveRepoRootSync(options.cwd), '.claude', 'settings.json');
  const projectClaudeSettings = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(projectClaudeSettingsPath), absent: null, errors,
    location: projectClaudeSettingsPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const claudeKnownPath = path.join(getClaudeHome(env), 'plugins', 'known_marketplaces.json');
  const claudeKnown = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(claudeKnownPath), absent: null, errors,
    location: claudeKnownPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const claudeInstalledPath = path.join(getClaudeHome(env), 'plugins', 'installed_plugins.json');
  const claudeInstalled = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(claudeInstalledPath), absent: null, errors,
    location: claudeInstalledPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const marketplaceEntries = await inventoryCanonicalDirectoryEntries({
    errors, location: marketplacesRoot, kind: 'marketplaceDirectoryRead', env, cwd: options.cwd,
  });
  for (const pluginId of Object.keys(codexConfig?.snapshot.plugins ?? {})) {
    const separator = pluginId.lastIndexOf('@');
    if (separator <= 0 || separator === pluginId.length - 1) continue;
    references.push({
      kind: 'namespacedMarketplace',
      location: codexConfigPath,
      pluginName: pluginId.slice(0, separator),
      marketplaceName: pluginId.slice(separator + 1),
      platform: 'codex',
      scope: 'user',
    });
  }
  for (const pluginId of Object.keys(projectCodexConfig?.snapshot.plugins ?? {})) {
    const separator = pluginId.lastIndexOf('@');
    if (separator <= 0 || separator === pluginId.length - 1) continue;
    references.push({
      kind: 'namespacedMarketplace',
      location: projectCodexConfigPath,
      pluginName: pluginId.slice(0, separator),
      marketplaceName: pluginId.slice(separator + 1),
      platform: 'codex',
      scope: 'project',
    });
  }
  for (const [location, registrations] of [
    [codexConfigPath, Object.entries(codexConfig?.snapshot.marketplaces ?? {}).flatMap(([marketplaceName, marketplace]) => {
      const sourceId = marketplace.sourceType === 'local' && !marketplace.sourcePointsToManifest
        && marketplace.source
        ? sourceIdFromCanonicalMarketplacePath(marketplace.source, marketplacesRoot)
        : null;
      return sourceId ? [{ marketplaceName, sourceId }] : [];
    })],
    [userClaudeSettingsPath, registeredMarketplaceRoots(userClaudeSettings?.extraKnownMarketplaces, marketplacesRoot)],
    [projectClaudeSettingsPath, registeredMarketplaceRoots(projectClaudeSettings?.extraKnownMarketplaces, marketplacesRoot)],
    [claudeKnownPath, [
      ...registeredMarketplaceRoots(claudeKnown, marketplacesRoot),
      ...registeredMarketplaceRoots(claudeKnown?.marketplaces, marketplacesRoot),
    ]],
  ] as const) {
    for (const registration of registrations) references.push({
      kind: 'namespacedMarketplace',
      location,
      sourceId: registration.sourceId,
      marketplaceName: registration.marketplaceName,
    });
  }
  for (const sourceEntry of marketplaceEntries) {
    const marketplaceRoot = path.join(marketplacesRoot, sourceEntry.name);
    const configPath = path.join(marketplaceRoot, 'config.json');
    const agentsManifestPath = path.join(
      marketplaceRoot, '.agents', 'plugins', 'marketplace.json',
    );
    const canonicalRoot = await inventoryCanonicalDirectory({
      errors,
      location: marketplaceRoot,
      kind: 'marketplaceRootValidation',
      env,
      cwd: options.cwd,
    });
    const strictRoot = canonicalRoot
      ? await inventoryRead({
          operation: () => readStrictNamespacedMarketplaceRoot({
            rootDir: marketplaceRoot,
            sourceId: sourceEntry.name,
          }),
          absent: null,
          reportAbsent: true,
          errors,
          location: marketplaceRoot,
          kind: 'marketplaceRootValidation',
          env,
          cwd: options.cwd,
        })
      : null;
    const [rawConfig, rawAgentsManifest, rawClaudeManifest] = strictRoot
      ? [strictRoot.config, strictRoot.agentsManifest, strictRoot.claudeManifest]
      : canonicalRoot ? await Promise.all([
          fs.readJson(configPath).catch(() => null) as Promise<Record<string, unknown> | null>,
          fs.readJson(agentsManifestPath).catch(() => null) as Promise<Record<string, unknown> | null>,
          fs.readJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'))
            .catch(() => null) as Promise<Record<string, unknown> | null>,
        ]) : [null, null, null];
    const candidateMarketplaceNames = new Set<string>();
    for (const candidate of [
      rawConfig?.marketplaceName,
      rawAgentsManifest?.name,
      rawClaudeManifest?.name,
    ]) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        candidateMarketplaceNames.add(candidate);
      }
    }
    for (const [name, marketplace] of Object.entries(codexConfig?.snapshot.marketplaces ?? {})) {
      if (marketplace.sourceType === 'local'
        && !marketplace.sourcePointsToManifest
        && path.normalize(marketplace.source ?? '') === path.normalize(marketplaceRoot)) {
        candidateMarketplaceNames.add(name);
      }
    }
    for (const name of [
      ...marketplaceNamesRegisteredAtRoot(userClaudeSettings?.extraKnownMarketplaces, marketplaceRoot),
      ...marketplaceNamesRegisteredAtRoot(projectClaudeSettings?.extraKnownMarketplaces, marketplaceRoot),
      ...marketplaceNamesRegisteredAtRoot(claudeKnown, marketplaceRoot),
      ...marketplaceNamesRegisteredAtRoot(claudeKnown?.marketplaces, marketplaceRoot),
    ]) candidateMarketplaceNames.add(name);
    const marketplaceName = strictRoot?.config.marketplaceName
      ?? (candidateMarketplaceNames.size === 1 ? [...candidateMarketplaceNames][0]! : null);
    const sourceIdentity = typeof rawConfig?.sourceIdentity === 'string'
      && /^sha256:[0-9a-f]{64}$/.test(rawConfig.sourceIdentity)
      ? rawConfig.sourceIdentity
      : undefined;
    const codexMarketplace = marketplaceName
      ? codexConfig?.snapshot.marketplaces[marketplaceName]
      : undefined;
    const codexMarketplaceIsCanonical = codexMarketplace?.sourceType === 'local'
      && !codexMarketplace.sourcePointsToManifest
      && path.normalize(codexMarketplace.source ?? '') === path.normalize(marketplaceRoot);
    const consumers: NativeMarketplaceConsumer[] = [];
    if (marketplaceName !== null && (strictRoot !== null || codexMarketplaceIsCanonical)) {
      for (const pluginId of Object.keys(codexConfig?.snapshot.plugins ?? {})) {
        const pluginName = pluginNameFromMarketplaceId(pluginId, marketplaceName);
        if (pluginName) consumers.push({ pluginName, platform: 'codex', scope: 'user' });
      }
      for (const pluginId of Object.keys(projectCodexConfig?.snapshot.plugins ?? {})) {
        const pluginName = pluginNameFromMarketplaceId(pluginId, marketplaceName);
        if (pluginName) consumers.push({ pluginName, platform: 'codex', scope: 'project' });
      }
    }
    if (marketplaceName !== null) {
      consumers.push(
        ...claudeConsumersFromSettings(userClaudeSettings, marketplaceName, 'user'),
        ...claudeConsumersFromSettings(projectClaudeSettings, marketplaceName, 'project'),
      );
      try {
        consumers.push(...claudeConsumersFromInstalled(
          claudeInstalled,
          marketplaceName,
          path.normalize(canonicalProjectRoot),
          options.includePlatformHistoricalProjects === true,
        ));
      } catch (error) {
        errors.push(inventoryError(
          error,
          claudeInstalledPath,
          'nativeStateRead',
          env,
          options.cwd,
        ));
      }
    }
    if (marketplaceName !== null && strictRoot !== null) {
      references.push({
        kind: 'namespacedMarketplace',
        location: configPath,
        sourceId: sourceEntry.name,
        ...(sourceIdentity ? { sourceIdentity } : {}),
        marketplaceName,
      });
    }
    if (marketplaceName !== null) {
      for (const consumer of consumers) references.push({
        kind: 'namespacedMarketplace',
        location: configPath,
        sourceId: sourceEntry.name,
        ...(sourceIdentity ? { sourceIdentity } : {}),
        marketplaceName,
        ...consumer,
      });
    }
  }
  for (const reference of references) {
    if (reference.scope === 'project' && reference.projectKey === undefined) {
      reference.projectKey = canonicalProjectRoot;
    }
  }
  const unique = [...new Map(references.map((reference) => [[
    reference.kind,
    reference.location,
    reference.sourceId ?? '',
    reference.sourceIdentity ?? '',
    reference.pluginName ?? '',
    reference.platform ?? '',
    reference.scope ?? '',
    reference.marketplaceName ?? '',
    reference.projectKey ?? '',
  ].join('\0'), reference])).values()];
  unique.sort((left, right) => left.location.localeCompare(right.location));
  return { inventorySchemaVersion: 1, references: unique, errors };
}

export class LegacyCatalogStateUnsupportedError extends Error {
  readonly code = 'legacyStateUnsupported';
  readonly inventory: CatalogSourceReferenceInventory;

  constructor(inventory: CatalogSourceReferenceInventory) {
    super('legacyStateUnsupported: legacy owner or config state is unsupported. Use a new AW_HOME, or cleanup with the old CLI first.');
    this.name = 'LegacyCatalogStateUnsupportedError';
    this.inventory = inventory;
  }
}

export class CatalogSourceReferencedError extends Error {
  readonly code = 'catalogSourceInUse';
  readonly inventory: CatalogSourceReferenceInventory;

  constructor(inventory: CatalogSourceReferenceInventory) {
    super(`catalogSourceInUse: catalog source has active references: ${inventory.references.map((reference) => reference.location).join(', ')}`);
    this.name = 'CatalogSourceReferencedError';
    this.inventory = inventory;
  }
}

export class CatalogSourceInventoryIncompleteError extends Error {
  readonly code = 'stateInventoryFailed';
  readonly inventory: CatalogSourceReferenceInventory;

  constructor(inventory: CatalogSourceReferenceInventory) {
    super(`stateInventoryFailed: catalog source state inventory is incomplete: ${(inventory.errors ?? []).map((error) =>
      `${error.kind}@${error.location}: ${error.message}`).join('; ')}`);
    this.name = 'CatalogSourceInventoryIncompleteError';
    this.inventory = inventory;
  }
}

export function assertCatalogSourceInventoryComplete(
  inventory: CatalogSourceReferenceInventory,
): void {
  if ((inventory.errors ?? []).length > 0) throw new CatalogSourceInventoryIncompleteError(inventory);
}

export function assertCatalogSourceReferencesSupported(
  inventory: CatalogSourceReferenceInventory,
): void {
  assertCatalogSourceInventoryComplete(inventory);
  if (inventory.references.length > 0) {
    if (inventory.references.some((reference) => reference.kind.startsWith('legacy'))) {
      throw new LegacyCatalogStateUnsupportedError(inventory);
    }
    throw new CatalogSourceReferencedError(inventory);
  }
}
