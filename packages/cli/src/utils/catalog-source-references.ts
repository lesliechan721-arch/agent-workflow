import crypto from 'node:crypto';
import { isCanonicalCodexMarketplaceRegistration } from './codex-shared-native.js';
import { readIntentReferences } from '../recovery/demand.js';
import { resolveIntentPath } from '../intent/intent-store.js';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import fs from 'fs-extra';
import { computeCanonicalDirectoryDigest } from '@lesliechan721/agent-skill-eval';
import { NATIVE_PLATFORM_TARGETS, isPlatformTarget } from '@lesliechan721/aw-plugin-core/manifest';

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
  inspectOwnedComponents,
  parseSharedOwnerToken,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  SKILL_OWNER_MARKER,
  type OwnedComponent,
} from './ownership.js';
import { sanitizeCatalogSourceErrorMessage } from './catalog-public-error.js';
import { canonicalMarketplaceRegistrationPath, readStrictNamespacedMarketplaceRoot } from './local-marketplace.js';
import { getDeploymentLayout, getManagedPlatformRoot, getInvocationPolicyPhysicalKey, isAntigravityProjectDirectory } from '../platforms/layout.js';
import { deploymentPackageComponent } from '../platforms/inspection.js';
import { canonicalNamespaceRoot, getPhysicalKey, identityDigest } from '../platforms/identity.js';
import { offlinePermissionComponents } from '../platforms/permission-ownership.js';
import { resolvePlatformConfigRoot } from '../platforms/discovery.js';
import { readPlatformPackageContentDigest } from './platform-empty-state.js';
import type { DeploymentBinding, InstallRoute, RecoveryCandidate } from '../platforms/contracts.js';
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
  ownedComponent?: OwnedComponent;
  pathEvidence?: string;
  recoveryCandidate?: RecoveryCandidate;
  /** Strict root identity (or a verified package in the current canonical namespace). */
  marketplaceRoot?: string;
  /** Observed host registration; null denotes a non-local or unconfirmed location. */
  marketplaceRegistrationPath?: string | null;
  /** A manifest entry records residue, not an activation or package-owner proof. */
  marketplaceManifestEntry?: true;
  /** Host policy registration, never an AW activation/removal grant. */
  managedNativeRegistration?: true;
  /** Claude retains false settings after uninstall. A preference alone is not a deployment. */
  disabledNativeActivation?: true;
}

export function legacyCanonicalMarketplaceRegistrationNames(
  references: readonly CatalogSourceReference[],
  sourceId: string,
): string[] {
  return [...new Set(references.flatMap((reference) =>
    reference.kind === 'namespacedMarketplace'
    && reference.sourceId === sourceId
    && reference.pluginName === undefined
    && reference.platform === undefined
    && reference.marketplaceRoot
    && reference.marketplaceName
      ? [reference.marketplaceName]
      : []))];
}

function isNativeMarketplaceConsumer(reference: CatalogSourceReference): boolean {
  return !reference.disabledNativeActivation && !reference.marketplaceManifestEntry;
}

/** Raw host consumers and their canonical inventory copies can describe the
 * same registration. Ignore that duplicate only when its binding is resolved. */
export function scopedCleanupMarketplaceEvidence(options: {
  references: readonly CatalogSourceReference[];
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
}): { registrations: CatalogSourceReference[]; consumers: CatalogSourceReference[]; unboundConsumers: CatalogSourceReference[] } {
  const { references, pluginName, platform, scope } = options;
  const registrations = references.filter((reference) => reference.kind === 'namespacedMarketplace'
    && reference.platform === platform && reference.pluginName === undefined
    && reference.marketplaceRegistrationPath !== undefined
    && (reference.scope === undefined || reference.scope === 'user' || reference.scope === scope));
  const consumers = references.filter((reference) => reference.kind === 'namespacedMarketplace'
    && reference.pluginName === pluginName && reference.platform === platform
    && reference.scope === scope && reference.marketplaceName);
  const nativeConsumers = consumers.filter(isNativeMarketplaceConsumer);
  const unboundConsumers = nativeConsumers.filter((consumer) => {
    if (consumer.sourceId !== undefined) return false;
    const boundRoots = new Set(nativeConsumers.flatMap((bound) => bound.sourceId && bound.sourceIdentity && bound.marketplaceRoot
      && bound.marketplaceName === consumer.marketplaceName && bound.projectKey === consumer.projectKey
      ? [bound.marketplaceRoot] : []));
    const observedPaths = new Set(registrations.filter((entry) => entry.marketplaceName === consumer.marketplaceName)
      .map((entry) => entry.marketplaceRegistrationPath));
    return observedPaths.size === 0 ? boundRoots.size !== 1
      : observedPaths.size !== 1 || [...observedPaths].some((location) => !location || !boundRoots.has(location));
  });
  return { registrations, consumers, unboundConsumers };
}

/** Resolve the same scope-local identity for offline preview and execution. A root
 * identifies a marketplace, not a package or permission to remove that package. */
export function resolveCleanupMarketplaceIdentity(options: {
  references: readonly CatalogSourceReference[];
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
}): { marketplaceName?: string; nativeRegistration?: true; marketplaceIdentityUnresolved?: true } {
  const { references, sourceId, sourceIdentity, pluginName, platform, scope } = options;
  if (platform !== 'codex' && platform !== 'claude' && platform !== 'copilot') return {};
  const { registrations, consumers, unboundConsumers } = scopedCleanupMarketplaceEvidence(options);
  const roots = references.filter((reference) => reference.kind === 'namespacedMarketplace'
    && reference.pluginName === undefined && reference.marketplaceRoot && reference.marketplaceName
    && (reference.platform === platform || platform !== 'copilot' && reference.platform === undefined));
  const matchedConsumers = consumers.filter((reference) => reference.sourceId === sourceId);
  const candidates = references.filter((reference) => reference.sourceId === sourceId
    && reference.sourceIdentity === sourceIdentity && reference.pluginName === pluginName
    && reference.platform === platform && reference.scope === scope
    && reference.recoveryCandidate?.evidence === 'verified' && reference.marketplaceRoot);
  const liveNames = new Set(matchedConsumers.map((reference) => reference.marketplaceName!));
  const provenNames = new Map<string, Set<string>>();
  const addName = (name: string, root: string): void => {
    const paths = provenNames.get(name) ?? new Set<string>();
    paths.add(root);
    provenNames.set(name, paths);
  };
  for (const reference of candidates) {
    const candidate = reference.recoveryCandidate!;
    const id = candidate.nativeIdentity?.registrationId;
    const separator = id?.lastIndexOf('@') ?? -1;
    if (id && separator > 0 && candidate.binding.platform === platform && candidate.binding.scope.kind === scope
      && candidate.binding.plugin.sourceId === sourceId && candidate.binding.plugin.sourceIdentity === sourceIdentity
      && id.slice(0, separator) === pluginName && id.slice(separator + 1)
      && candidate.nativeIdentity?.sourceLocation === path.join(reference.marketplaceRoot!, 'plugins', pluginName)) {
      const name = id.slice(separator + 1);
      liveNames.add(name);
      addName(name, reference.marketplaceRoot!);
    }
  }
  const hasVerifiedCandidate = provenNames.size > 0;
  for (const root of roots) {
    if (root.sourceId !== sourceId || root.sourceIdentity !== sourceIdentity) continue;
    if (liveNames.size === 0 || liveNames.has(root.marketplaceName!)) addName(root.marketplaceName!, root.marketplaceRoot!);
  }
  const unresolved = (): { marketplaceIdentityUnresolved: true } => ({ marketplaceIdentityUnresolved: true });
  if (liveNames.size > 1 || provenNames.size > 1) return unresolved();
  if (provenNames.size === 0) return unboundConsumers.length > 0 || matchedConsumers.some(isNativeMarketplaceConsumer)
    || references.some((reference) => reference.sourceId === sourceId
    && reference.sourceIdentity === sourceIdentity && reference.pluginName === pluginName
    && reference.platform === platform && reference.scope === scope && reference.recoveryCandidate?.evidence === 'verified')
    ? unresolved() : {};
  const [marketplaceName, paths] = [...provenNames][0]!;
  if (liveNames.size === 1 && !liveNames.has(marketplaceName)) return unresolved();
  const observed = registrations.filter((registration) => registration.marketplaceName === marketplaceName);
  // An empty canonical root alone does not resolve some other, unbound
  // marketplace's same-name activation. Preserve it and report the ambiguity.
  if (!observed.length && !hasVerifiedCandidate && unboundConsumers.some((consumer) =>
    consumer.marketplaceName !== marketplaceName)) return unresolved();
  // Multiple physical markets sharing a name cannot be disambiguated by the name alone.
  // An actual host registration can conclusively select one of those roots.
  if (observed.some((registration) => !registration.marketplaceRegistrationPath
    || !paths.has(registration.marketplaceRegistrationPath))) return unresolved();
  const selectedPaths = observed.length ? new Set(observed.map((registration) => registration.marketplaceRegistrationPath!)) : paths;
  if (selectedPaths.size !== 1) return unresolved();
  const selectedRoot = [...selectedPaths][0]!;
  if (candidates.some((candidate) => candidate.marketplaceRoot !== selectedRoot)) return unresolved();
  if (!observed.length && roots.some((root) => root.marketplaceName === marketplaceName
    && root.marketplaceRoot !== selectedRoot)) return unresolved();
  if (roots.some((root) => root.marketplaceRoot === selectedRoot
    && (root.sourceId !== sourceId || root.sourceIdentity !== sourceIdentity || root.marketplaceName !== marketplaceName))) return unresolved();
  const matchingActivation = consumers.some((consumer) => isNativeMarketplaceConsumer(consumer) && !consumer.managedNativeRegistration
    && consumer.marketplaceName === marketplaceName
    && (consumer.sourceId === undefined || consumer.sourceId === sourceId && consumer.sourceIdentity === sourceIdentity));
  return { marketplaceName, ...(matchingActivation ? { nativeRegistration: true as const } : {}) };
}

interface NativeMarketplaceConsumer {
  pluginName: string;
  platform: 'codex' | 'claude' | 'copilot';
  scope: 'user' | 'project';
  projectKey?: string | null;
  managedNativeRegistration?: true;
  disabledNativeActivation?: true;
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
  for (const [pluginId, enabled] of Object.entries(isRecord(value.enabledPlugins) ? value.enabledPlugins : {})) {
    const pluginName = pluginNameFromMarketplaceId(pluginId, marketplaceName);
    if (pluginName) output.push({ pluginName, platform: 'claude', scope,
      ...(enabled === false ? { disabledNativeActivation: true as const } : {}) });
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
  includeManaged = false,
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
        && item.scope !== 'local'
        && item.scope !== 'managed') {
        throw new Error(`Claude installed_plugins record ${key} has an invalid scope.`);
      }
      if (item.projectPath !== undefined && typeof item.projectPath !== 'string') {
        throw new Error(`Claude installed_plugins record ${key} has an invalid projectPath.`);
      }
      // Managed policy is a host-global residual clue, but is never an AW
      // user registration or an independent project reference.
      if (item.scope === 'managed' && !includeManaged) continue;
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
      output.push({ pluginName, platform: 'claude', scope, ...(scope === 'project' ? { projectKey } : {}),
        ...(item.scope === 'managed' ? { managedNativeRegistration: true as const } : {}) });
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
  /** Scanner-owned location for recovery; never an ownership or deletion proof. */
  recoveryPath?: string;
  configKey?: string;
  relevance:
    | { global: true }
    | {
        global: false;
        sourceId?: string;
        pluginName?: string;
        platform?: PlatformName;
        scope?: Scope;
        projectLocationKey?: string;
        componentName?: string;
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
    [path.join(repoRoot, '.github', 'copilot'), 'copilot'],
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
  const copilotRoot = resolvePlatformConfigRoot('copilot', { env, cwd });
  if (pathSegmentsWithin(copilotRoot, location) !== null) {
    return { global: false, platform: 'copilot', scope: 'user' };
  }
  for (const root of new Set([awHome, canonicalAwHome])) {
    const platformPath = pathSegmentsWithin(path.join(root, 'platforms'), location);
    if (platformPath && (platformPath.length <= 2 || platformPath[2] === 'marketplaces')
      && (platformPath[0] === 'codex' || platformPath[0] === 'claude' || platformPath[0] === 'copilot')) {
      return { global: false, platform: platformPath[0], ...(platformPath[3] ? { sourceId: platformPath[3] } : {}) };
    }
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
  const sensitiveRoots = [getCodexHome(env), getClaudeHome(env), resolvePlatformConfigRoot('copilot', { env, cwd }), resolveRepoRootSync(cwd)];
  return {
    code: 'stateInventoryFailed',
    kind,
    location: sanitizeCatalogSourceErrorMessage(location, env, sensitiveRoots),
    recoveryPath: path.resolve(location),
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
  scope?: Scope;
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

  return roots;
}

export async function inventoryLegacyOwnerReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope?: Scope;
  includeProjectAgentSkills?: boolean;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const repoRoot = resolveRepoRootSync(options.cwd);
  const references: CatalogSourceReference[] = [];
  const errors: CatalogSourceInventoryError[] = [];
  const skillRoots = new Set([
    path.join(getCodexHome(env), 'skills'),
    path.join(getClaudeHome(env), 'skills'),
    ...(options.scope !== 'user' && (options.includeProjectAgentSkills ?? options.scope === undefined)
      ? [path.join(repoRoot, '.agents', 'skills')] : []),
    ...(options.scope === 'user' ? [] : [
      path.join(repoRoot, '.claude', 'skills'),
    ]),
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
  scope?: Scope;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const references: CatalogSourceReference[] = [];
  const errors: CatalogSourceInventoryError[] = [];
  for (const configRoot of await inventoryPluginConfigRoots({ errors, env, cwd: options.cwd,
    scope: options.scope })) {
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
  if (raw?.schemaVersion === 1 && raw.owner === 'agent-workflows') {
    return {
      kind: 'legacyOwner',
      location: entryPath,
      ...(typeof raw.plugin === 'string' ? { pluginName: raw.plugin } : {}),
      ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}),
      ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    };
  }
  if (raw?.schemaVersion === 3 && raw.owner === 'agent-workflows'
    && typeof raw.sourceId === 'string'
    && raw.pluginId === `${raw.sourceId}/${raw.plugin}`) {
    return {
      kind: 'namespacedOwner',
      location: entryPath,
      sourceId: raw.sourceId,
      ...(typeof raw.sourceIdentity === 'string' ? { sourceIdentity: raw.sourceIdentity } : {}),
      ...(typeof raw.plugin === 'string' ? { pluginName: raw.plugin } : {}),
      ...(typeof raw.platform === 'string' ? { platform: raw.platform } : {}),
      ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    };
  }
  return null;
}

function legacyOwnedHeaderReference(
  filePath: string,
  content: string,
): CatalogSourceReference | null {
  const normalized = content.replace(/\r\n/gu, '\n');
  const frontmatterEnd = normalized.startsWith('---\n')
    ? normalized.indexOf('\n---\n', 4)
    : -1;
  const headerIndex = frontmatterEnd === -1 ? 0 : frontmatterEnd + '\n---\n'.length;
  const lineEnd = normalized.indexOf('\n', headerIndex);
  const line = normalized.slice(headerIndex, lineEnd === -1 ? normalized.length : lineEnd);
  if (!line.startsWith(OWNED_TEXT_HEADER_PREFIX)) return null;
  const raw = (() => {
    try {
      return JSON.parse(line.slice(OWNED_TEXT_HEADER_PREFIX.length)) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const reference = ownerReferenceFromRaw(filePath, raw);
  return reference?.kind === 'legacyOwner' ? reference : null;
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
  const legacyReference = legacyOwnedHeaderReference(filePath, content);
  if (legacyReference) {
    if (requireGeneratedName
      && legacyReference.pluginName
      && !path.basename(filePath).startsWith(`aw-${legacyReference.pluginName}-`)) {
      errors.push(inventoryError(
        new Error('Owned text header path does not match its plugin identity.'),
        filePath,
        'ownerHeaderPathValidation',
        env,
        cwd,
      ));
      return null;
    }
    return legacyReference;
  }
  let parsed: ReturnType<typeof parseOwnedTextHeader>;
  try {
    parsed = parseOwnedTextHeader(content);
  } catch (error) {
    errors.push(inventoryError(error, filePath, 'ownerHeaderParse', env, cwd));
    return null;
  }
  if (!parsed) return null;
  if (requireGeneratedName
    && !path.basename(filePath).startsWith(parsed.identity.sourceId
      ? `aw-${parsed.identity.sourceId}-${parsed.identity.plugin}-` : `aw-${parsed.identity.plugin}-`)) {
    const physical = inventoryErrorRelevance(filePath, env, cwd);
    let configKey: string | undefined;
    if (!physical.global && physical.platform === 'codex' && path.extname(filePath) === '.toml') {
      try {
        const configPath = physical.scope === 'project' ? path.join(resolveRepoRootSync(cwd), '.codex/config.toml') : path.join(getCodexHome(env), 'config.toml');
        const config = await readCodexConfigFile(configPath);
        const keys: string[] = [];
        for (const [name, value] of Object.entries(config.snapshot.agents)) {
          if (typeof value.configFile === 'string'
            && path.resolve(path.dirname(configPath), value.configFile) === path.resolve(filePath)) keys.push(`agents.${name}.config_file`);
        }
        configKey = keys.length === 1 ? keys[0] : keys.length > 1 ? 'agents' : undefined;
      } catch { /* Unknown references require manual inspection. */ }
    }
    const issue = inventoryError(
      new Error('Owned text header path does not match its plugin identity.'),
      filePath,
      'ownerHeaderPathValidation',
      env,
      cwd,
      !physical.global && configKey && configKey !== 'agents' ? { ...physical,
        componentName: configKey.slice('agents.'.length, -'.config_file'.length) } : physical,
    );
    if (configKey) issue.configKey = configKey;
    errors.push(issue);
    return null;
  }
  const reference = ownerReferenceFromRaw(filePath, { schemaVersion: 3, ...parsed.identity });
  return reference ? { ...reference, ownedComponent: { kind: 'owned-text-file', path: filePath,
    allowedRoot: path.dirname(filePath), identity: parsed.identity },
    pathEvidence: await offlineOwnedPathEvidence(filePath) } : null;
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
      const legacy = await fs.readJson(markerPath).catch(() => null) as Record<string, unknown> | null;
      const legacyReference = ownerReferenceFromRaw(markerPath, legacy);
      if (legacyReference?.kind === 'legacyOwner') {
        output.push(legacyReference);
        continue;
      }
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
      ...(identity.sourceIdentity ? { sourceIdentity: identity.sourceIdentity } : {}),
      pluginName: identity.plugin,
      platform: identity.platform,
      scope: identity.scope,
      ...(identity.platform === 'claude' ? { ownedComponent: { kind: 'shared-config' as const, identity, label: filePath,
        locator: { kind: 'claude-permissions' as const, settingsPath: filePath, ownerKey: token } } } : {}),
    });
  }
  return output;
}

async function codexSharedOwnerReferences(
  filePath: string,
  scope: 'user' | 'project',
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
  if (scope === 'user') {
    for (const { value, location } of ownerValues) {
      if (value.startsWith(SHARED_OWNER_TOKEN_PREFIX)
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) continue;
      references.push({
        kind: 'legacyOwner',
        location,
        pluginName: value,
        platform: 'codex',
        scope,
      });
    }
  }
  return references;
}

async function claudeSharedOwnerReferences(
  filePath: string,
  scope: 'user' | 'project',
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
  if (scope === 'user') {
    for (const key of keys) {
      if (key.startsWith(SHARED_OWNER_TOKEN_PREFIX)
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key)) continue;
      references.push({
        kind: 'legacyOwner',
        location: filePath,
        pluginName: key,
        platform: 'claude',
        scope,
      });
    }
  }
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
  schemaVersion: 6;
  sourceId: string;
  pluginName: string;
  binding: { kind: 'source'; sourceIdentity: string };
  common: Record<string, unknown>;
  platforms: Record<string, Record<string, unknown>>;
} {
  if (!isRecord(value)
    || value.schemaVersion !== 6
    || typeof value.sourceId !== 'string'
    || typeof value.pluginName !== 'string'
    || !isRecord(value.binding)
    || !isRecord(value.common)
    || !isRecord(value.platforms)
    || Object.entries(value.platforms).some(([platform, values]) => !isPlatformTarget(platform) || !isRecord(values))
    || Object.keys(value).some((key) => ![
      'schemaVersion', 'sourceId', 'pluginName', 'binding', 'common', 'platforms',
    ].includes(key))) {
    throw new Error('Namespaced plugin config is not a valid schema 6 envelope.');
  }
  const binding = value.binding;
  const validBinding = binding.kind === 'source'
      && typeof binding.sourceIdentity === 'string'
      && /^sha256:[0-9a-f]{64}$/u.test(binding.sourceIdentity)
      && Object.keys(binding).every((key) => ['kind', 'sourceIdentity'].includes(key));
  if (!validBinding) {
    throw new Error('Namespaced user plugin config has an invalid binding.');
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
  const canonicalLegacyRoot = path.join(await canonicalNamespaceRoot(resolveAwHome(env)), 'marketplaces');
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
      namespacedPrimaryRoots.add(path.join(canonicalLegacyRoot, entry.name));
    }
  }

  const codex = await inventoryRead({
    operation: () => readCodexConfigFile(codexPath), absent: null, errors,
    location: codexPath, kind: 'nativeStateRead', env, cwd,
  });
  const codexAw = codex?.snapshot.marketplaces.aw;
  const codexAwIsNamespaced = [...namespacedPrimaryRoots].some((root) => isCanonicalCodexMarketplaceRegistration(codexAw, root));
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
    || Object.entries(settings.enabledPlugins ?? {}).some(([key, enabled]) => isAwPluginConsumerKey(key) && enabled !== false)
    || hasAwPluginConsumerKeys(settings.plugins?.installed)
    || hasClaudeMarketplaceConsumer(settings.plugins?.installed))
  ) && !claudeAwIsNamespaced) {
    output.push({ kind: 'legacyMarketplace', location: claudeSettingsPath });
    for (const consumer of claudeConsumersFromSettings(settings as unknown as Record<string, unknown>, 'aw', 'user')) {
      if (consumer.disabledNativeActivation) continue;
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
      if (consumer.disabledNativeActivation) continue;
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

const MARKETPLACE_PLATFORMS = ['codex', 'claude', 'copilot'] as const;
type MarketplacePlatform = typeof MARKETPLACE_PLATFORMS[number];

async function managedMarketplaceDirectories(awRoot: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Map<MarketplacePlatform, string>> {
  const directories = new Map<MarketplacePlatform, string>();
  for (const platform of MARKETPLACE_PLATFORMS) {
    const configRoot = await canonicalNamespaceRoot(resolvePlatformConfigRoot(platform, { cwd, env }));
    directories.set(platform, path.join(getManagedPlatformRoot(awRoot, platform, `${platform}-marketplace`, configRoot), 'marketplaces'));
  }
  return directories;
}

function pluginMarketplaceName(pluginId: string): string | undefined {
  const separator = pluginId.lastIndexOf('@');
  return separator > 0 && separator < pluginId.length - 1 ? pluginId.slice(separator + 1) : undefined;
}

/** A missing package container is valid after removal; a foreign container is not. */
async function assertMarketplacePluginsContainer(root: string): Promise<void> {
  const pluginsRoot = path.join(root, 'plugins');
  const stat = await fs.lstat(pluginsRoot).catch((error: unknown) => {
    if (isAbsentState(error)) return null;
    throw error;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Marketplace plugins container must be a canonical directory.');
}

async function readEnabledPluginsInventory(location: string): Promise<Record<string, unknown>> {
  const value: unknown = await readJsonFileIfExists(location);
  if (value === null || value === undefined) return {};
  if (!isRecord(value) || value.enabledPlugins !== undefined && !isRecord(value.enabledPlugins)) {
    throw new Error('Native settings enabledPlugins must be a JSON object.');
  }
  if (isRecord(value.enabledPlugins) && Object.values(value.enabledPlugins).some((enabled) => typeof enabled !== 'boolean')) {
    throw new Error('Native settings enabledPlugins entries must be boolean.');
  }
  return isRecord(value.enabledPlugins) ? value.enabledPlugins : {};
}

/** Operation-local fingerprints bind reviewed output bytes; they do not confer ownership. */
export async function offlineOwnedPathEvidence(location: string): Promise<string> {
  const stat = await fs.lstat(location);
  if (stat.isSymbolicLink()) throw new Error('offlineCleanupPathUnsafe');
  if (stat.isDirectory()) return computeCanonicalDirectoryDigest(location);
  if (!stat.isFile()) throw new Error('offlineCleanupPathUnsafe');
  return `sha256:${crypto.createHash('sha256').update(await fs.readFile(location)).digest('hex')}`;
}

async function observedProjectReference(options: {
  binding: DeploymentBinding;
  layout: Awaited<ReturnType<typeof getDeploymentLayout>>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  errors: CatalogSourceInventoryError[];
}): Promise<boolean> {
  const { binding, layout, errors, env, cwd } = options;
  if (binding.scope.kind !== 'project') return false;
  const projectRoot = binding.scope.projectRoot;
  const nativeId = layout.nativeIdentity.registrationId ?? layout.nativeIdentity.packageId;
  const settingsPath = binding.platform === 'codex' ? path.join(projectRoot, '.codex/config.toml')
    : binding.platform === 'claude' ? path.join(projectRoot, '.claude/settings.local.json')
      : binding.platform === 'copilot' ? path.join(projectRoot, '.github/copilot/settings.local.json') : undefined;
  if (settingsPath) {
    const recorded = await inventoryRead({ errors, env, cwd, location: settingsPath, kind: 'nativeProjectActivationRead', absent: false,
      operation: async () => {
        if (binding.platform === 'codex') return Object.hasOwn((await readCodexConfigFile(settingsPath)).snapshot.plugins, nativeId);
        const value: unknown = await readJsonFileIfExists(settingsPath);
        if (value == null) return false;
        if (!isRecord(value) || value.enabledPlugins !== undefined && !isRecord(value.enabledPlugins)) throw new Error('nativeProjectActivationInvalid');
        return isRecord(value.enabledPlugins) && Object.hasOwn(value.enabledPlugins, nativeId);
      } });
    if (recorded) return true;
  }
  if (binding.platform !== 'codex' && binding.platform !== 'claude') return false;
  const policyKey = await getInvocationPolicyPhysicalKey({ cwd, env }, binding);
  const supplementKeys = new Set([policyKey, ...layout.renderUnits.filter((unit) => unit.output === 'supplement').map((unit) => unit.physicalKey)]);
  const references = binding.platform === 'codex'
    ? [...await findOwnedHeadersInDirectory(path.join(projectRoot, '.codex/agents'), new Set(['.toml']), false, errors, env, cwd),
      ...await findOwnedHeadersInDirectory(path.join(projectRoot, '.codex/rules'), new Set(['.rules']), false, errors, env, cwd)]
    : await claudeSharedOwnerReferences(path.join(projectRoot, '.claude/settings.local.json'), 'project', errors, env, cwd);
  if (references.some((reference) => {
    const identity = reference.ownedComponent?.identity;
    return identity?.pluginId === binding.plugin.pluginId && identity.sourceIdentity === binding.plugin.sourceIdentity
      && identity.platform === binding.platform && identity.scope === 'project' && identity.physicalKey !== undefined
      && supplementKeys.has(identity.physicalKey);
  })) return true;
  if (binding.platform !== 'claude' || !layout.marketplaceName) return false;
  const installedPath = path.join(resolvePlatformConfigRoot('claude', { cwd, env }), 'plugins/installed_plugins.json');
  return inventoryRead({ errors, env, cwd, location: installedPath, kind: 'nativeProjectRegistrationRead', absent: false,
    operation: async () => {
      const value = await readJsonFileIfExists<Record<string, unknown>>(installedPath) ?? null;
      return claudeConsumersFromInstalled(value, layout.marketplaceName!, projectRoot).some((consumer) =>
        consumer.scope === 'project' && consumer.pluginName === binding.plugin.pluginId.split('/').at(-1));
    } });
}

async function nativeOwnedReferences(options: { cwd: string; env: NodeJS.ProcessEnv; scope?: Scope;
  collectPathEvidence?: boolean; observationPlugins?: ReadonlySet<string> },
  errors: CatalogSourceInventoryError[]): Promise<CatalogSourceReference[]> {
  const references: CatalogSourceReference[] = [];
  const ctx = { cwd: options.cwd, env: options.env };
  const projectRoot = canonicalizePathThroughExistingAncestorSync(resolveRepoRootSync(options.cwd));
  const roots = new Map<string, { platform: PlatformName; scope: Scope; route: InstallRoute; hostRoot: string; managed: boolean; sourceId?: string }>();
  const add = (root: string, platform: PlatformName, scope: Scope, route: InstallRoute, hostRoot: string, managed = false, sourceId?: string) =>
    roots.set(root, { platform, scope, route, hostRoot, managed, sourceId });
  for (const platform of NATIVE_PLATFORM_TARGETS) {
    const hostRoot = resolvePlatformConfigRoot(platform, ctx);
    if (platform === 'cursor') add(path.join(hostRoot, 'aw-plugins'), platform, 'user', 'cursor-workspace-hook', hostRoot);
    if (platform === 'opencode' || platform === 'antigravity') add(path.join(hostRoot, 'plugins'), platform, 'user', `${platform}-directory`, hostRoot);
    if (platform === 'pi') add(path.join(hostRoot, 'aw-packages'), platform, 'user', 'pi-package', hostRoot);
    if (options.scope !== 'user') {
      if (platform === 'cursor') add(path.join(projectRoot, '.cursor/aw-plugins'), platform, 'project', 'cursor-workspace-hook', hostRoot);
      if (platform === 'opencode') add(path.join(projectRoot, '.opencode/plugins'), platform, 'project', 'opencode-directory', hostRoot);
      if (platform === 'antigravity') add(path.join(projectRoot, '.agents/plugins'), platform, 'project', 'antigravity-directory', hostRoot);
      if (platform === 'pi') add(path.join(projectRoot, '.pi/aw-packages'), platform, 'project', 'pi-package', hostRoot);
      if (platform === 'grok') add(path.join(projectRoot, '.grok/plugins'), platform, 'project', 'grok-directory', hostRoot);
    }
  }
  const awRoot = await canonicalNamespaceRoot(resolveAwHome(options.env));
  const managed = path.join(awRoot, 'platforms');
  for (const platform of NATIVE_PLATFORM_TARGETS) {
    const namespaces = await inventoryCanonicalDirectoryEntries({ location: path.join(managed, platform),
      kind: 'nativeNamespaceRead', errors, env: options.env, cwd: options.cwd });
    const route: Partial<Record<PlatformName, InstallRoute>> = { codex: 'codex-marketplace', claude: 'claude-marketplace',
      copilot: 'copilot-marketplace', antigravity: 'antigravity-cli', grok: 'grok-cli' };
    if (!route[platform]) continue;
    for (const namespace of namespaces) {
      if (!namespace.isDirectory() || namespace.isSymbolicLink()) continue;
      const base = path.join(managed, platform, namespace.name);
      const sourcesRoot = path.join(base, ['codex', 'claude', 'copilot'].includes(platform) ? 'marketplaces' : 'packages');
      const sources = await inventoryCanonicalDirectoryEntries({ location: sourcesRoot, kind: 'nativeSourceRead', errors, env: options.env, cwd: options.cwd });
      for (const source of sources) if (source.isDirectory() && !source.isSymbolicLink()) {
        add(path.join(sourcesRoot, source.name, ...(['codex', 'claude', 'copilot'].includes(platform) ? ['plugins'] : [])),
          platform, 'user', route[platform]!, resolvePlatformConfigRoot(platform, ctx), true, source.name);
      }
    }
  }
  for (const [root, descriptor] of roots) {
    if (canonicalizePathThroughExistingAncestorSync(root) !== path.resolve(root)) {
      errors.push(inventoryError(new Error('Native namespace path contains a symbolic link.'), root, 'nativeNamespaceUnsafe',
        options.env, options.cwd, { global: false, platform: descriptor.platform, scope: descriptor.scope,
          ...(descriptor.sourceId ? { sourceId: descriptor.sourceId } : {}) }));
      continue;
    }
    const entries = await inventoryCanonicalDirectoryEntries({ location: root, kind: 'nativePackageRead', errors, env: options.env, cwd: options.cwd });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const packageRoot = path.join(root, entry.name);
      const markerPath = path.join(packageRoot, SKILL_OWNER_MARKER);
      try {
        const marker = await readSkillOwnerMarker({ skillRoot: packageRoot, allowedRoot: root });
        if (!marker) continue;
        if (!marker.sourceId || !marker.sourceIdentity || !marker.physicalKey || !marker.pluginId
          || marker.platform !== descriptor.platform || marker.scope !== descriptor.scope) continue;
        const { schemaVersion: _schema, nativeProjection: projection, ...identity } = marker;
        let configRoot = descriptor.hostRoot;
        const physical = projection?.physicalIdentity;
        const antigravityCopy = !descriptor.managed && descriptor.platform === 'antigravity' && descriptor.scope === 'user'
          && physical?.route === 'antigravity-cli';
        const route = antigravityCopy ? 'antigravity-cli' : descriptor.route;
        if (descriptor.managed && physical && physical.platform === descriptor.platform && physical.route === descriptor.route
          && physical.sourceIdentity === marker.sourceIdentity && physical.pluginId === marker.pluginId
          && getPhysicalKey(physical) === marker.physicalKey) configRoot = physical.namespaceRoot;
        const binding: DeploymentBinding = { id: '', plugin: { sourceId: marker.sourceId, sourceIdentity: marker.sourceIdentity,
          pluginId: marker.pluginId, version: '0.0.0' }, platform: descriptor.platform,
          scope: descriptor.scope === 'user' ? { kind: 'user' } : { kind: 'project', projectRoot }, route,
          consumers: [{ id: identityDigest({ platform: descriptor.platform, route, configRoot }),
            product: 'cli', version: null, availability: 'missing', reasonCodes: ['client-missing'],
            entry: { kind: 'directory', configRoot } }], physicalKey: marker.physicalKey,
          activationKey: '', renderUnitIds: [] };
        const layout = await getDeploymentLayout(ctx, binding);
        const expectedPackageRoot = antigravityCopy
          ? path.join(layout.physicalIdentity.namespaceRoot, 'plugins', layout.nativeIdentity.packageId) : layout.packageRoot;
        if (canonicalizePathThroughExistingAncestorSync(expectedPackageRoot) !== canonicalizePathThroughExistingAncestorSync(packageRoot)
          || getPhysicalKey(layout.physicalIdentity) !== marker.physicalKey) throw new Error('nativeOwnerPlacementMismatch');
        const projectComponent = isAntigravityProjectDirectory(binding) ? deploymentPackageComponent(binding, layout) : undefined;
        if (projectComponent) {
          const owned = await inspectOwnedComponents({ components: [projectComponent] });
          if (owned.components[0]?.state !== 'present') {
            errors.push(inventoryError(new Error('The Antigravity project package has unconfirmed content.'), packageRoot,
              'nativeOwnerContentUnconfirmed', options.env, options.cwd, { global: false, platform: descriptor.platform,
                scope: descriptor.scope, sourceId: marker.sourceId, pluginName: marker.plugin }));
            continue;
          }
        }
        const inspectCopy = !options.observationPlugins || options.observationPlugins.has(marker.pluginId)
          || options.observationPlugins.has(marker.pluginId.slice(marker.pluginId.indexOf('/') + 1));
        if (antigravityCopy && inspectCopy) {
          await readSkillOwnerMarker({ skillRoot: packageRoot, allowedRoot: root,
            expectedIdentity: deploymentPackageComponent(binding, layout).identity });
          if (!projection || getPhysicalKey(projection.physicalIdentity) !== marker.physicalKey
            || await readPlatformPackageContentDigest(packageRoot) !== projection.contentDigest) throw new Error('nativeCopyContentUnconfirmed');
        }
        const component: OwnedComponent = projectComponent ?? { kind: 'owned-directory', path: packageRoot, allowedRoot: root, identity };
        const scopes: Scope[] = descriptor.scope === 'user' && options.scope !== 'user'
          && ['codex', 'claude', 'copilot'].includes(descriptor.platform) ? ['user', 'project'] : [descriptor.scope];
        const pathEvidence = options.collectPathEvidence === false ? undefined : await offlineOwnedPathEvidence(packageRoot);
        for (const scope of scopes) {
          const scopedBinding = { ...binding, scope: scope === 'user' ? { kind: 'user' as const }
            : { kind: 'project' as const, projectRoot }, consumers: binding.consumers.map((consumer) => ({ ...consumer })) };
          const scopedLayout = await getDeploymentLayout(ctx, scopedBinding);
          if (scope === 'project' && descriptor.scope === 'user'
            && !await observedProjectReference({ binding: scopedBinding, layout: scopedLayout, cwd: options.cwd, env: options.env, errors })) continue;
          scopedBinding.activationKey = identityDigest({ physicalKey: scopedBinding.physicalKey, scope: scopedBinding.scope,
            activationPath: scopedLayout.activationPath });
          scopedBinding.id = identityDigest({ sourceIdentity: marker.sourceIdentity, pluginId: marker.pluginId,
            platform: scopedBinding.platform, scope: scopedBinding.scope, route: scopedBinding.route, physicalKey: scopedBinding.physicalKey });
          scopedBinding.renderUnitIds = scopedLayout.renderUnits.map((unit) => unit.id);
          const recoveryCandidate: RecoveryCandidate = { binding: scopedBinding, physicalIdentity: scopedLayout.physicalIdentity,
            nativeIdentity: scopedLayout.nativeIdentity, evidence: antigravityCopy && !inspectCopy ? 'unknown' : 'verified' };
          // A copied marker is a native recovery clue, never direct filesystem
          // removal authority for the cache or ownership of the AW source path.
          const currentMarketplaceRoot = scopedLayout.marketplaceRoot && descriptor.managed
            ? path.join(getManagedPlatformRoot(awRoot, descriptor.platform, descriptor.route,
              await canonicalNamespaceRoot(descriptor.hostRoot)), 'marketplaces', marker.sourceId) : null;
          references.push({ kind: antigravityCopy ? 'namespacedMarketplace' : 'namespacedOwner', location: markerPath, sourceId: marker.sourceId,
            sourceIdentity: marker.sourceIdentity, pluginName: marker.plugin, platform: descriptor.platform, scope,
            ...(!antigravityCopy ? { ownedComponent: component } : {}), recoveryCandidate, pathEvidence,
            ...(currentMarketplaceRoot && scopedLayout.marketplaceRoot === currentMarketplaceRoot
              ? { marketplaceRoot: currentMarketplaceRoot } : {}) });
        }
      } catch (error) {
        errors.push(inventoryError(error, markerPath, 'nativeOwnerRead', options.env, options.cwd,
          { global: false, platform: descriptor.platform, scope: descriptor.scope }));
      }
    }
  }
  // Grok rules are scope-local supplements. Codex supplements and Claude permission tokens use their existing exact readers.
  for (const scope of options.scope === 'user' ? ['user'] as const : ['user', 'project'] as const) {
    for (const platform of ['opencode', 'antigravity', 'grok'] as const) {
      const permissions = await inventoryRead({ operation: () => offlinePermissionComponents(ctx, scope === 'project' ? projectRoot : undefined, platform),
        absent: [], errors, cwd: options.cwd, env: options.env, location: path.join(resolveAwHome(options.env), 'platforms', platform, 'permission-ownership'),
        kind: 'permissionOwnershipRead' });
      for (const component of permissions) references.push({ kind: 'namespacedOwner', location: component.locator.settingsPath,
        sourceId: component.identity.sourceId, sourceIdentity: component.identity.sourceIdentity, pluginName: component.identity.plugin,
        platform, scope, ownedComponent: component });
    }
    const root = scope === 'user' ? path.join(resolvePlatformConfigRoot('grok', ctx), 'rules') : path.join(projectRoot, '.grok/rules');
    references.push(...await findOwnedHeadersInDirectory(root, new Set(['.md', '.rules']), false, errors, options.env, options.cwd));
  }
  return references;
}

export async function inventoryCatalogSourceReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  scope?: Scope;
  includeProjectAgentSkills?: boolean;
  includePlatformHistoricalProjects?: boolean;
  /** Names from a verified Catalog graph, independent of damaged owner headers. */
  knownPluginNames?: readonly string[];
  collectPathEvidence?: boolean;
  observationPlugins?: ReadonlySet<string>;
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
  for (const scope of options.scope === 'user' ? ['user'] as const : ['user', 'project'] as const) {
    let location: string;
    try { location = await resolveIntentPath({ scope, cwd: options.cwd, env }); }
    catch (error) {
      if (scope === 'project' && error instanceof Error && error.message.startsWith('projectRootUnavailable')) continue;
      throw error;
    }
    const state = await inventoryRead({
      operation: async () => {
        const ids = await readIntentReferences({ scope, cwd: options.cwd, env });
        return { roots: ids.map((pluginId) => ({ pluginId })) };
      },
      absent: null,
      errors,
      location,
      kind: 'lifecycleIntentRead',
      env,
      cwd: options.cwd,
    });
    if (!state) continue;
    for (const pluginId of new Set(state.roots.map((root) => root.pluginId))) {
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
  for (const configInventory of await inventoryPluginConfigRoots({ errors, env, cwd: options.cwd,
    scope: options.scope })) {
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
          assertNamespacedConfigEnvelope(
            value,
            sourceEntry.name,
            pluginEntry.name,
          );
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
  references.push(...await nativeOwnedReferences({ ...options, env }, errors));
  const ownerInventory = await inventoryLegacyOwnerReferences(options);
  references.push(...ownerInventory.references);
  errors.push(...ownerInventory.errors);
  for (const [location, kind, operation] of [
    [path.join(getCodexHome(env), 'config.toml'), 'nativeStateRead', () => codexSharedOwnerReferences(path.join(getCodexHome(env), 'config.toml'), 'user', errors, env, options.cwd)],
    [path.join(getClaudeHome(env), 'settings.json'), 'nativeStateRead', () => claudeSharedOwnerReferences(path.join(getClaudeHome(env), 'settings.json'), 'user', errors, env, options.cwd)],
    [path.join(resolveRepoRootSync(options.cwd), '.codex', 'config.toml'), 'nativeStateRead', () => codexSharedOwnerReferences(path.join(resolveRepoRootSync(options.cwd), '.codex', 'config.toml'), 'project', errors, env, options.cwd)],
    [path.join(resolveRepoRootSync(options.cwd), '.claude', 'settings.local.json'), 'nativeStateRead', () => claudeSharedOwnerReferences(path.join(resolveRepoRootSync(options.cwd), '.claude', 'settings.local.json'), 'project', errors, env, options.cwd)],
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
  const canonicalAwRoot = await canonicalNamespaceRoot(awHome);
  const managedDirectories = await managedMarketplaceDirectories(canonicalAwRoot, options.cwd, env);
  const canonicalLegacyRoot = path.join(canonicalAwRoot, 'marketplaces');
  const projectClaudeLocalSettingsPath = path.join(resolveRepoRootSync(options.cwd), '.claude', 'settings.local.json');
  const projectClaudeLocalSettings = await inventoryRead({
    operation: () => readJsonFileIfExists<Record<string, unknown>>(projectClaudeLocalSettingsPath), absent: null, errors,
    location: projectClaudeLocalSettingsPath, kind: 'nativeStateRead', env, cwd: options.cwd,
  });
  const nativeConsumers: CatalogSourceReference[] = [];
  const addConsumer = (location: string, marketplaceName: string, consumer: NativeMarketplaceConsumer): void => {
    nativeConsumers.push({ kind: 'namespacedMarketplace', location, marketplaceName, ...consumer });
  };
  for (const [location, plugins, platform, scope] of [
    [codexConfigPath, codexConfig?.snapshot.plugins ?? {}, 'codex', 'user'],
    [projectCodexConfigPath, projectCodexConfig?.snapshot.plugins ?? {}, 'codex', 'project'],
    ...await Promise.all((['user', 'project'] as const).map(async (scope) => {
      const location = scope === 'user'
        ? path.join(resolvePlatformConfigRoot('copilot', { cwd: options.cwd, env }), 'settings.json')
        : path.join(resolveRepoRootSync(options.cwd), '.github', 'copilot', 'settings.local.json');
      const plugins = await inventoryRead({ operation: () => readEnabledPluginsInventory(location), absent: {}, errors,
        location, kind: 'nativeStateRead', env, cwd: options.cwd });
      return [location, plugins, 'copilot', scope] as const;
    })),
  ] as const) {
    for (const pluginId of Object.keys(plugins)) {
      const marketplaceName = pluginMarketplaceName(pluginId);
      if (marketplaceName) addConsumer(location, marketplaceName, {
        pluginName: pluginNameFromMarketplaceId(pluginId, marketplaceName)!, platform, scope,
      });
    }
  }
  for (const [location, settings, scope] of [
    [userClaudeSettingsPath, userClaudeSettings, 'user'],
    [projectClaudeSettingsPath, projectClaudeSettings, 'project'],
    [projectClaudeLocalSettingsPath, projectClaudeLocalSettings, 'project'],
  ] as const) {
    if (!settings) continue;
    const installed = isRecord(settings.plugins) && isRecord(settings.plugins.installed) ? settings.plugins.installed : {};
    const names = new Set([
      ...Object.keys(isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {}).map(pluginMarketplaceName),
      ...Object.values(installed).flatMap((entry) => isRecord(entry) && typeof entry.marketplace === 'string' ? [entry.marketplace] : []),
    ].filter((name): name is string => !!name));
    for (const name of names) for (const consumer of claudeConsumersFromSettings(settings, name, scope)) addConsumer(location, name, consumer);
  }
  const installedClaudeNames = new Set<string>();
  if (isRecord(claudeInstalled?.plugins)) for (const [id, raw] of Object.entries(claudeInstalled.plugins)) {
    const name = pluginMarketplaceName(id);
    if (name) installedClaudeNames.add(name);
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      if (isRecord(entry) && typeof entry.marketplace === 'string') installedClaudeNames.add(entry.marketplace);
    }
  }
  try {
    if (installedClaudeNames.size === 0) claudeConsumersFromInstalled(claudeInstalled, '', path.normalize(canonicalProjectRoot));
    for (const name of installedClaudeNames) for (const consumer of claudeConsumersFromInstalled(claudeInstalled, name,
      path.normalize(canonicalProjectRoot), options.includePlatformHistoricalProjects === true, true)) addConsumer(claudeInstalledPath, name, consumer);
  } catch (error) {
    errors.push(inventoryError(error, claudeInstalledPath, 'nativeStateRead', env, options.cwd));
  }
  references.push(...nativeConsumers);

  // Host paths are matched lexically against only the legacy root and the current
  // platform/route namespace. Never adopt a host's foreign directory or another namespace.
  const registrations: CatalogSourceReference[] = [];
  const appendRegistration = (platform: MarketplacePlatform, location: string, marketplaceName: string,
    registrationPath: string | null, scope?: Scope): void => {
    const sourceId = registrationPath
      ? (sourceIdFromCanonicalMarketplacePath(registrationPath, canonicalLegacyRoot)
        ?? sourceIdFromCanonicalMarketplacePath(registrationPath, managedDirectories.get(platform)!))
      : null;
    registrations.push({ kind: 'namespacedMarketplace', location, platform, marketplaceName,
      ...(sourceId ? { sourceId } : {}), ...(scope ? { scope } : {}), marketplaceRegistrationPath: registrationPath });
  };
  for (const [location, config, scope] of [
    [codexConfigPath, codexConfig, 'user'], [projectCodexConfigPath, projectCodexConfig, 'project'],
  ] as const) {
    for (const [name, marketplace] of Object.entries(config?.snapshot.marketplaces ?? {})) {
      const source = marketplace.sourceType === 'local' && !marketplace.sourcePointsToManifest ? marketplace.source : undefined;
      appendRegistration('codex', location, name, canonicalMarketplaceRegistrationPath(source, awHome, canonicalAwRoot), scope);
    }
  }
  for (const [location, declarations, scope] of [
    [userClaudeSettingsPath, userClaudeSettings?.extraKnownMarketplaces, 'user'],
    [projectClaudeSettingsPath, projectClaudeSettings?.extraKnownMarketplaces, 'project'],
    [projectClaudeLocalSettingsPath, projectClaudeLocalSettings?.extraKnownMarketplaces, 'project'],
    [claudeKnownPath, claudeKnown, undefined], [claudeKnownPath, claudeKnown?.marketplaces, undefined],
  ] as const) {
    if (!isRecord(declarations)) continue;
    for (const [name, declaration] of Object.entries(declarations)) {
      if (name === 'marketplaces' && location === claudeKnownPath) continue;
      const declaredSource = isRecord(declaration) ? declaration.source : undefined;
      const foreignSource = typeof declaredSource === 'string' && declaredSource !== 'directory' && !path.isAbsolute(declaredSource)
        || isRecord(declaredSource) && declaredSource.source !== undefined && declaredSource.source !== 'directory';
      const paths = [...new Set(collectMarketplaceDeclarationPaths(declaration)
        .map((candidate) => canonicalMarketplaceRegistrationPath(candidate, awHome, canonicalAwRoot)))];
      appendRegistration('claude', location, name, !foreignSource && paths.length === 1 ? paths[0] ?? null : null, scope);
    }
  }
  references.push(...registrations);

  for (const [platform, directory] of managedDirectories) {
    const root = await inventoryCanonicalDescendantDirectory({ root: canonicalAwRoot,
      segments: path.relative(canonicalAwRoot, directory).split(path.sep), errors,
      kind: 'marketplaceDirectoryRead', env, cwd: options.cwd });
    const entries = root ? await inventoryCanonicalDirectoryEntries({ errors, location: root,
      kind: 'marketplaceDirectoryRead', env, cwd: options.cwd }) : [];
    const registeredIds = registrations.filter((registration) => registration.platform === platform && registration.marketplaceRegistrationPath
      && sourceIdFromCanonicalMarketplacePath(registration.marketplaceRegistrationPath, directory) !== null)
      .flatMap((registration) => registration.sourceId ? [registration.sourceId] : []);
    for (const sourceId of new Set([...entries.map((entry) => entry.name), ...registeredIds])) {
      const marketplaceRoot = path.join(directory, sourceId);
      const configPath = path.join(marketplaceRoot, 'config.json');
      const strictRoot = root ? await inventoryRead({ operation: async () => {
        if (!await inventoryCanonicalDirectory({ errors, location: marketplaceRoot, kind: 'marketplaceRootValidation', env, cwd: options.cwd })) return null;
        await assertMarketplacePluginsContainer(marketplaceRoot);
        const manifestPath = path.join(marketplaceRoot, platform === 'codex' ? '.agents/plugins/marketplace.json'
          : platform === 'claude' ? '.claude-plugin/marketplace.json' : '.github/plugin/marketplace.json');
        for (const location of [configPath, manifestPath]) {
          if (await canonicalNamespaceRoot(location) !== location) throw new Error('Marketplace path contains a symbolic link.');
        }
        return readStrictNamespacedMarketplaceRoot({ rootDir: marketplaceRoot, sourceId, platform, trustedMarketplaceRoot: directory });
      }, absent: null, reportAbsent: true, errors, location: marketplaceRoot, kind: 'marketplaceRootValidation', env, cwd: options.cwd }) : null;
      const names = new Set(registrations.filter((registration) => registration.platform === platform
        && registration.marketplaceRegistrationPath === marketplaceRoot).flatMap((registration) => registration.marketplaceName ? [registration.marketplaceName] : []));
      if (strictRoot) {
        const { marketplaceName, sourceIdentity } = strictRoot.config;
        names.add(marketplaceName);
        references.push({ kind: 'namespacedMarketplace', sourceId, sourceIdentity, marketplaceName, marketplaceRoot, platform, location: configPath });
        for (const entry of strictRoot.manifest.plugins as unknown[]) {
          if (!isRecord(entry) || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)
            || entry.source !== `./plugins/${entry.name}`) continue;
          references.push({ kind: 'namespacedMarketplace', sourceId, sourceIdentity, marketplaceName, marketplaceRoot, platform,
            location: configPath, pluginName: entry.name, scope: 'user', marketplaceManifestEntry: true });
        }
      }
      for (const consumer of nativeConsumers) {
        if (consumer.platform !== platform || consumer.disabledNativeActivation
          || !consumer.marketplaceName || !names.has(consumer.marketplaceName)) continue;
        const exact = strictRoot?.config.marketplaceName === consumer.marketplaceName;
        references.push({ ...consumer, location: configPath, sourceId,
          ...(exact ? { sourceIdentity: strictRoot.config.sourceIdentity, marketplaceRoot } : {}) });
      }
    }
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
          operation: async () => {
            await assertMarketplacePluginsContainer(marketplaceRoot);
            const expectedRoot = path.join(canonicalLegacyRoot, sourceEntry.name);
            for (const location of [marketplaceRoot, configPath, agentsManifestPath, path.join(marketplaceRoot, '.claude-plugin/marketplace.json')]) {
              const expected = path.join(expectedRoot, path.relative(marketplaceRoot, location));
              if (await canonicalNamespaceRoot(location) !== expected) throw new Error('Marketplace path contains a symbolic link.');
            }
            return readStrictNamespacedMarketplaceRoot({ rootDir: marketplaceRoot, sourceId: sourceEntry.name });
          },
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
      if (isCanonicalCodexMarketplaceRegistration(marketplace, marketplaceRoot)) {
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
    const codexMarketplaceIsCanonical = isCanonicalCodexMarketplaceRegistration(codexMarketplace, marketplaceRoot);
    const consumers = nativeConsumers.filter((consumer) => consumer.platform !== 'copilot'
      && !consumer.disabledNativeActivation
      && consumer.marketplaceName === marketplaceName
      && (consumer.platform !== 'codex' || strictRoot !== null || codexMarketplaceIsCanonical));
    if (marketplaceName !== null && strictRoot !== null) {
      references.push({
        kind: 'namespacedMarketplace',
        location: configPath,
        sourceId: sourceEntry.name,
        ...(sourceIdentity ? { sourceIdentity } : {}),
        marketplaceName,
        marketplaceRoot: path.join(canonicalLegacyRoot, sourceEntry.name),
      });
    }
    if (marketplaceName !== null) {
      for (const consumer of consumers) references.push({
        ...consumer,
        kind: 'namespacedMarketplace',
        location: configPath,
        sourceId: sourceEntry.name,
        ...(sourceIdentity ? { sourceIdentity } : {}),
        marketplaceName,
        ...(strictRoot ? { marketplaceRoot: path.join(canonicalLegacyRoot, sourceEntry.name) } : {}),
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
    reference.marketplaceRoot ?? '',
    reference.marketplaceRegistrationPath ?? '',
    reference.marketplaceManifestEntry ? 'manifest' : '',
    reference.managedNativeRegistration ? 'managed' : '',
    reference.disabledNativeActivation ? 'disabled' : '',
  ].join('\0'), reference])).values()];
  unique.sort((left, right) => left.location.localeCompare(right.location));
  const knownNames = [...new Set([...(options.knownPluginNames ?? []), ...unique.flatMap((reference) =>
    reference.kind.startsWith('namespaced') && reference.pluginName ? [reference.pluginName] : [])])];
  for (const error of errors) {
    if (error.kind !== 'ownerHeaderPathValidation' || error.relevance.global || !error.recoveryPath || error.configKey === 'agents') continue;
    const basename = path.basename(error.recoveryPath);
    const candidates = knownNames.filter((name) => basename.startsWith(`aw-${name}-`));
    if (candidates.length === 1) error.relevance = { ...error.relevance, pluginName: candidates[0] };
  }
  return { inventorySchemaVersion: 1, references: options.scope === 'user'
    ? unique.filter((reference) => reference.scope !== 'project') : unique, errors };
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
