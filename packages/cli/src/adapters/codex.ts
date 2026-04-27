import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import {
  extractCodexHookGroups,
} from '../generators/hooks.js';
import { renderCodexManagedInstructionBlock } from '../generators/instructions.js';
import { generateCodexPermissionArtifacts } from '../generators/permissions.js';
import { buildGeneratedName } from '../generators/shared.js';
import type {
  CatalogCompatibility,
  CodexCapabilitySnapshot,
  CodexSharedHookGroup,
  CodexSharedNativeRefs,
  GeneratedArtifact,
  GeneratedArtifactStatus,
  InstalledLedger,
  PlatformAdapter,
  PluginMeta,
  PluginStatusReport,
  Scope,
  ScopeInitializedState,
  StatusReport,
  TrackedHookGroupIdentity,
  TrackingManifest,
  TrackingPluginRecord,
} from '../types.js';
import {
  detectCodexProjectLayerEvidence,
  detectCodexSessionState,
  detectEnvironment,
  resolveCodexProjectTrust,
} from '../utils/detect.js';
import {
  type CodexConfigSnapshot,
  readCodexConfigFile,
  removeCodexMarketplaceFile,
  removeCodexPluginEnabledFile,
  removeManagedDeveloperInstructionsFile,
  upsertCodexMarketplaceFile,
  upsertCodexPluginEnabledFile,
  upsertManagedDeveloperInstructionsFile,
} from '../utils/codex-config.js';
import {
  ensureLocalMarketplace,
  readInstalledLedger,
  resolveScopeInitialized,
} from '../utils/local-marketplace.js';
import { writeJsonFile } from '../utils/json.js';
import { readPluginManifest } from '../utils/manifest.js';
import { readMarketplaceManifest } from '../utils/marketplace.js';
import {
  resolveActiveLocalBundle,
  resolveCatalogPlugins,
  resolveCurrentCatalog,
} from '../utils/plugin-catalog.js';
import {
  resolveAwHomeCanonical,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveRepoRoot,
} from '../utils/paths.js';
import {
  validateRenderedCodexRules,
  validateCodexSharedHooksContent,
} from '../utils/rendered-contract.js';
import {
  attachGeneratedArtifactsToError,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import {
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import {
  parseCodexSharedHooksFile,
  planCodexSharedHooksUpdate,
  renderTrackedHookGroupIdentity,
  resolvePlatformHookDefinitions,
  trackedHookGroupsContainAll,
} from '../utils/hooks-contract.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import { detectCodexExternalOwnership } from './helpers.js';

const MARKETPLACE_NAME = 'aw';

function normalizeCodexCapabilitySnapshot(
  snapshot: CodexCapabilitySnapshot | undefined,
): Required<CodexCapabilitySnapshot> {
  return {
    requiresNativePlugin: snapshot?.requiresNativePlugin === true,
    hasRepoManagedArtifacts: snapshot?.hasRepoManagedArtifacts === true,
  };
}

export function requiresNativePlugin(plugin: PluginMeta): boolean {
  return Boolean(plugin.manifest.skills || plugin.manifest.mcpServers || plugin.manifest.apps);
}

export function hasRepoManagedArtifacts(plugin: PluginMeta): boolean {
  return Boolean(
    resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex').length > 0 ||
      resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex').length > 0 ||
      resolvePlatformHookDefinitions(plugin.manifest, 'codex').length > 0 ||
      resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex').length > 0,
  );
}

export function resolveCodexCatalogCompatibility(options: {
  currentManifestPresent: boolean;
  currentScopeManagedEvidence: boolean;
  platformNativeFallbackEvidence: boolean;
  currentCapabilities: CodexCapabilitySnapshot;
  installedCapabilitySnapshot?: CodexCapabilitySnapshot;
}): CatalogCompatibility | undefined {
  if (!options.currentManifestPresent) {
    return options.currentScopeManagedEvidence || options.platformNativeFallbackEvidence
      ? 'missing'
      : undefined;
  }

  if (!options.currentScopeManagedEvidence || !options.installedCapabilitySnapshot) {
    return undefined;
  }

  const installed = normalizeCodexCapabilitySnapshot(options.installedCapabilitySnapshot);
  const current = normalizeCodexCapabilitySnapshot(options.currentCapabilities);
  return JSON.stringify(installed) === JSON.stringify(current)
    ? 'current'
    : 'capabilityChanged';
}

async function writeTextArtifact(
  baseDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const targetPath = path.join(baseDir, relativePath);
  await fs.ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, 'utf8');
  return targetPath;
}

function readMutableLedger(ledger: InstalledLedger): InstalledLedger {
  if (ledger.ledgerState.status === 'available') {
    return ledger;
  }

  return {
    ...ledger,
    ledgerState: {
      status: 'available',
      degradedAt: null,
      reason: null,
    },
  };
}

function normalizeSharedNativeRefs(
  sharedNativeRefs: CodexSharedNativeRefs | undefined,
): CodexSharedNativeRefs {
  return {
    user: sharedNativeRefs?.user === true,
    projects: [...new Set(sharedNativeRefs?.projects ?? [])].sort(),
  };
}

function upsertCodexScopeLedger(
  ledger: InstalledLedger,
  plugin: PluginMeta,
  scope: Scope,
  projectKey: string | undefined,
): InstalledLedger {
  const nextLedger = readMutableLedger(ledger);
  const timestamp = new Date().toISOString();
  const pluginRecord = nextLedger.plugins[plugin.manifest.name] ?? {
    lastResolvedVersion: plugin.manifest.version,
    platforms: {},
  };
  pluginRecord.lastResolvedVersion = plugin.manifest.version;
  pluginRecord.platforms.codex ??= {
    projectScopes: {},
    sharedNativeRefs: {
      user: false,
      projects: [],
    },
  };
  pluginRecord.platforms.codex.lastRequestedScope = scope;
  pluginRecord.platforms.codex.lastRequestedAt = timestamp;

  const capabilitySnapshot: CodexCapabilitySnapshot = {
    requiresNativePlugin: requiresNativePlugin(plugin),
    hasRepoManagedArtifacts: hasRepoManagedArtifacts(plugin),
  };

  const scopeRecord = {
    managed: true,
    updatedAt: timestamp,
    resolvedVersion: plugin.manifest.version,
    capabilitySnapshot,
  };

  if (scope === 'user') {
    pluginRecord.platforms.codex.userScope = scopeRecord;
  } else if (projectKey) {
    pluginRecord.platforms.codex.projectScopes ??= {};
    pluginRecord.platforms.codex.projectScopes[projectKey] = scopeRecord;
  }

  const sharedNativeRefs = normalizeSharedNativeRefs(pluginRecord.platforms.codex.sharedNativeRefs);
  if (capabilitySnapshot.requiresNativePlugin) {
    if (scope === 'user') {
      sharedNativeRefs.user = true;
    } else if (projectKey) {
      sharedNativeRefs.projects = [...new Set([...sharedNativeRefs.projects, projectKey])].sort();
    }
  }
  pluginRecord.platforms.codex.sharedNativeRefs = sharedNativeRefs;

  nextLedger.plugins[plugin.manifest.name] = pluginRecord;
  return nextLedger;
}

export async function applyCodexInstallLedger(
  ledger: InstalledLedger,
  plugin: PluginMeta,
  scope: Scope,
  cwd: string,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveCodexProjectKey(cwd) : undefined;
  return upsertCodexScopeLedger(ledger, plugin, scope, projectKey);
}

function removeCodexScopeLedger(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  projectKey: string | undefined,
): InstalledLedger {
  const nextLedger = readMutableLedger(ledger);
  const pluginRecord = nextLedger.plugins[pluginName];
  if (!pluginRecord?.platforms.codex) {
    return nextLedger;
  }

  if (scope === 'user') {
    delete pluginRecord.platforms.codex.userScope;
  } else if (projectKey) {
    delete pluginRecord.platforms.codex.projectScopes?.[projectKey];
    if (
      pluginRecord.platforms.codex.projectScopes &&
      Object.keys(pluginRecord.platforms.codex.projectScopes).length === 0
    ) {
      delete pluginRecord.platforms.codex.projectScopes;
    }
  }

  const sharedNativeRefs = normalizeSharedNativeRefs(pluginRecord.platforms.codex.sharedNativeRefs);
  if (scope === 'user') {
    sharedNativeRefs.user = false;
  } else if (projectKey) {
    sharedNativeRefs.projects = sharedNativeRefs.projects.filter((value) => value !== projectKey);
  }
  pluginRecord.platforms.codex.sharedNativeRefs = sharedNativeRefs;

  const hasProjectScopes = Object.keys(pluginRecord.platforms.codex.projectScopes ?? {}).length > 0;
  const hasSharedRefs = sharedNativeRefs.user || sharedNativeRefs.projects.length > 0;
  if (!pluginRecord.platforms.codex.userScope && !hasProjectScopes && !hasSharedRefs) {
    delete pluginRecord.platforms.codex;
  }

  if (Object.keys(pluginRecord.platforms).length === 0) {
    delete nextLedger.plugins[pluginName];
  }

  return nextLedger;
}

export async function applyCodexUninstallLedger(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  cwd: string,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveCodexProjectKey(cwd) : undefined;
  return removeCodexScopeLedger(ledger, pluginName, scope, projectKey);
}

function getInstalledScopeSnapshot(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  projectKey: string | undefined,
): CodexCapabilitySnapshot | undefined {
  if (scope === 'user') {
    return ledger.plugins[pluginName]?.platforms.codex?.userScope?.capabilitySnapshot;
  }

  return projectKey
    ? ledger.plugins[pluginName]?.platforms.codex?.projectScopes?.[projectKey]?.capabilitySnapshot
    : undefined;
}

function readTrackedCodexHookGroups(
  record: TrackingPluginRecord | undefined,
): TrackedHookGroupIdentity[] | null {
  if (!record) {
    return [];
  }

  const groups: TrackedHookGroupIdentity[] = [];
  for (const artifact of record.artifacts) {
    if (artifact.kind !== 'hook') {
      continue;
    }

    if (artifact.hookGroups === undefined) {
      return null;
    }

    const trackedGroups = Array.isArray(artifact.hookGroups) ? artifact.hookGroups : null;
    if (!trackedGroups) {
      return null;
    }

    groups.push(...trackedGroups);
  }

  return groups;
}

function createTrackingRecordFromArtifacts(
  pluginName: string,
  trackingRecord: TrackingPluginRecord | undefined,
  generatedArtifacts: GeneratedArtifact[],
): TrackingPluginRecord | undefined {
  const artifacts = mergeGeneratedArtifacts(trackingRecord?.artifacts, generatedArtifacts);
  if (artifacts.length === 0) {
    return undefined;
  }

  return {
    name: trackingRecord?.name ?? pluginName,
    generatedAt: trackingRecord?.generatedAt ?? new Date(0).toISOString(),
    artifacts,
  };
}

function hasTrackedCodexHookArtifact(
  record: TrackingPluginRecord | undefined,
): boolean {
  return Boolean(record?.artifacts.some((artifact) => artifact.kind === 'hook'));
}

function createEmptyParsedCodexSharedHooksFile() {
  return parseCodexSharedHooksFile({ hooks: {} }, 'codex.hooks');
}

async function readCodexHookGroups(hooksPath: string): Promise<TrackedHookGroupIdentity[]> {
  const parsed = await readParsedCodexSharedHooksFile(hooksPath);
  return parsed.managedIdentities;
}

async function readParsedCodexSharedHooksFile(hooksPath: string) {
  if (!(await fs.pathExists(hooksPath))) {
    return createEmptyParsedCodexSharedHooksFile();
  }

  const raw = await fs.readJson(hooksPath) as { hooks?: unknown };
  return parseCodexSharedHooksFile(raw, 'codex.hooks');
}

function renderTrackedCodexSharedHookGroup(
  identity: TrackedHookGroupIdentity,
): CodexSharedHookGroup {
  const rendered = renderTrackedHookGroupIdentity(identity);
  const rawGroup: Record<string, unknown> = {
    hooks: rendered.hooks.map((handler) => ({ ...handler })),
  };
  if (rendered.matcher !== undefined) {
    rawGroup.matcher = rendered.matcher;
  }

  return {
    event: rendered.event,
    ...(rendered.matcher === undefined ? {} : { matcher: rendered.matcher }),
    hooks: rawGroup.hooks as Record<string, unknown>[],
    rawGroup,
  };
}

function buildCodexSharedHooksContent(
  groups: CodexSharedHookGroup[],
): Record<string, unknown> {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const group of groups) {
    hooks[group.event] ??= [];
    hooks[group.event].push(group.rawGroup);
  }

  return { hooks };
}

async function writeCodexSharedHookGroups(
  hooksPath: string,
  groups: CodexSharedHookGroup[],
): Promise<string | undefined> {
  if (groups.length === 0) {
    await fs.remove(hooksPath);
    return undefined;
  }

  const content = buildCodexSharedHooksContent(groups);
  validateCodexSharedHooksContent(content, 'codex.hooks');
  await writeJsonFile(hooksPath, content);
  return hooksPath;
}

async function resolveTrackedPlugin(
  pluginName: string,
  env: NodeJS.ProcessEnv,
): Promise<PluginMeta> {
  try {
    const { plugins } = await resolveCatalogPlugins([pluginName], env);
    return plugins[0];
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `Unknown plugin "${pluginName}".`) {
      throw error;
    }

    const bundleRoot = await resolveActiveLocalBundle(pluginName, env);
    if (bundleRoot) {
      return readPluginManifest(bundleRoot, { mode: 'bundle' });
    }

    throw error;
  }
}

type ResolvedTrackedCodexHookRewrite = {
  previousTrackedIdentities: TrackedHookGroupIdentity[];
  nextHookIdentities: TrackedHookGroupIdentity[];
  historicalTrackedIdentities: TrackedHookGroupIdentity[];
};

async function resolveTrackedCodexHookRewrite(
  plugin: PluginMeta,
  trackingManifest: TrackingManifest,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedTrackedCodexHookRewrite> {
  const currentTrackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
  const currentTrackedIdentities = readTrackedCodexHookGroups(currentTrackingRecord) ?? [];
  const currentHookIdentities = extractCodexHookGroups(
    resolvePlatformHookDefinitions(plugin.manifest, 'codex'),
  );

  const previousTrackedIdentities = [...currentTrackedIdentities];
  const nextHookIdentities = [...currentHookIdentities];
  const historicalTrackedIdentities: TrackedHookGroupIdentity[] = [];

  const otherTrackedPluginNames = Object.keys(trackingManifest.plugins)
    .filter((pluginName) => pluginName !== plugin.manifest.name)
    .sort();

  for (const trackedPluginName of otherTrackedPluginNames) {
    const trackingRecord = trackingManifest.plugins[trackedPluginName];
    const trackedHookGroups = readTrackedCodexHookGroups(trackingRecord);
    if (trackedHookGroups !== null && trackedHookGroups.length === 0) {
      continue;
    }

    try {
      const trackedPlugin = await resolveTrackedPlugin(trackedPluginName, env);
      previousTrackedIdentities.push(...(trackedHookGroups ?? []));
      nextHookIdentities.push(
        ...extractCodexHookGroups(
          resolvePlatformHookDefinitions(trackedPlugin.manifest, 'codex'),
        ),
      );
    } catch {
      if (trackedHookGroups && trackedHookGroups.length > 0) {
        historicalTrackedIdentities.push(...trackedHookGroups);
      }
    }
  }

  return {
    previousTrackedIdentities,
    nextHookIdentities,
    historicalTrackedIdentities,
  };
}

async function syncCodexHooks(
  hooksPath: string,
  plugin: PluginMeta,
  trackingManifest: TrackingManifest,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const parsedHooks = await readParsedCodexSharedHooksFile(hooksPath);
  const rewritePlan = await resolveTrackedCodexHookRewrite(plugin, trackingManifest, env);
  const updatePlan = planCodexSharedHooksUpdate(parsedHooks, {
    rerenderedIdentities: rewritePlan.previousTrackedIdentities,
    historicalIdentities: rewritePlan.historicalTrackedIdentities,
  });

  const preservedHistorical = new Set(updatePlan.preservedHistoricalAwRawGroups);
  const preservedForeign = new Set(updatePlan.preservedForeignRawGroups);
  const preservedRawGroups = parsedHooks.rawGroups.filter((group) =>
    preservedHistorical.has(group) || preservedForeign.has(group),
  );
  const nextManagedRawGroups = rewritePlan.nextHookIdentities.map(renderTrackedCodexSharedHookGroup);

  return writeCodexSharedHookGroups(hooksPath, [
    ...preservedRawGroups,
    ...nextManagedRawGroups,
  ]);
}

type ResolvedCodexStatusHookExpectation = {
  declared: boolean;
  expectedGroups: TrackedHookGroupIdentity[] | null;
  diagnostics: string[];
};

async function resolveCodexStatusHookExpectation(
  plugin: PluginMeta,
  trackingRecord: TrackingPluginRecord | undefined,
  currentCatalogAvailable: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCodexStatusHookExpectation> {
  if (currentCatalogAvailable) {
    const currentHooks = resolvePlatformHookDefinitions(plugin.manifest, 'codex');
    return {
      declared: currentHooks.length > 0,
      expectedGroups: extractCodexHookGroups(currentHooks),
      diagnostics: [],
    };
  }

  const diagnostics: string[] = [];
  const activeLocalBundle = await resolveActiveLocalBundle(plugin.manifest.name, env);
  if (activeLocalBundle) {
    try {
      const activePlugin = await readPluginManifest(activeLocalBundle, { mode: 'bundle' });
      const activeHooks = resolvePlatformHookDefinitions(activePlugin.manifest, 'codex');
      return {
        declared: activeHooks.length > 0,
        expectedGroups: extractCodexHookGroups(activeHooks),
        diagnostics,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Codex activeLocalBundle 无法解析，已回退到 tracking hook identities：${message}`);
    }
  }

  const trackedHookGroups = readTrackedCodexHookGroups(trackingRecord);
  if (trackedHookGroups === null) {
    diagnostics.push('历史 tracking manifest 只有 Codex hook kind，缺少可比较的 hook identities。');
    return {
      declared: hasTrackedCodexHookArtifact(trackingRecord),
      expectedGroups: null,
      diagnostics,
    };
  }

  return {
    declared: trackedHookGroups.length > 0,
    expectedGroups: trackedHookGroups,
    diagnostics,
  };
}

async function collectGeneratedArtifacts(
  pluginName: string,
  trackingDir: string,
): Promise<GeneratedArtifactStatus[]> {
  const trackingManifest = await readTrackingManifest(trackingDir);
  const trackingRecord = getTrackingRecord(trackingManifest, pluginName);
  if (!trackingRecord) {
    return [];
  }

  return Promise.all(
    trackingRecord.artifacts.map(async (artifact) => ({
      path: artifact.path,
      exists: await fs.pathExists(artifact.path),
      kind: artifact.kind,
    })),
  );
}

export class CodexAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd, this.env);
    return detection.codex.available;
  }

  async installPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    if (scope === 'project' && !hasRepoManagedArtifacts(plugin)) {
      throw new Error(
        `${plugin.manifest.name} 不包含任何 repo-managed artifacts，Codex project scope 不支持纯 native-only 安装。`,
      );
    }

    if (!requiresNativePlugin(plugin)) {
      return;
    }

    await ensureLocalMarketplace(this.env);
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const userConfig = await readCodexConfigFile(userPaths.configTomlPath);
    const externalOwnership = detectCodexExternalOwnership(
      userConfig.snapshot.plugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
    );
    if (externalOwnership?.present) {
      throw new Error(externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
    }

    await upsertCodexMarketplaceFile(userPaths.configTomlPath, MARKETPLACE_NAME, {
      source: await resolveAwHomeCanonical(this.env),
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(userPaths.configTomlPath, `${plugin.manifest.name}@${MARKETPLACE_NAME}`, {
      enabled: true,
    });
  }

  async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const ledger = await readInstalledLedger(this.env);
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const projectKey = await resolveCodexProjectKey(this.cwd);
    const installedSnapshot = getInstalledScopeSnapshot(ledger, plugin.manifest.name, scope, projectKey);
    if (!normalizeCodexCapabilitySnapshot(installedSnapshot).requiresNativePlugin) {
      return;
    }

    // Codex project uninstall only removes repo-managed artifacts; shared user native state stays in place.
    if (scope === 'project') {
      return;
    }

    const currentRefs = normalizeSharedNativeRefs(
      ledger.plugins[plugin.manifest.name]?.platforms.codex?.sharedNativeRefs,
    );
    const nextRefs = normalizeSharedNativeRefs(currentRefs);
    nextRefs.user = false;

    if (!nextRefs.user && nextRefs.projects.length === 0) {
      await removeCodexPluginEnabledFile(userPaths.configTomlPath, `${plugin.manifest.name}@${MARKETPLACE_NAME}`);
    }

    const hasRemainingNativeRefs = Object.entries(ledger.plugins).some(([name, record]) => {
      if (name === plugin.manifest.name) {
        return nextRefs.user || nextRefs.projects.length > 0;
      }

      const snapshot = normalizeCodexCapabilitySnapshot(record.platforms.codex?.userScope?.capabilitySnapshot);
      const refs = normalizeSharedNativeRefs(record.platforms.codex?.sharedNativeRefs);
      return snapshot.requiresNativePlugin && (refs.user || refs.projects.length > 0);
    });
    if (!hasRemainingNativeRefs) {
      await removeCodexMarketplaceFile(userPaths.configTomlPath, MARKETPLACE_NAME);
    }
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const paths = resolveCodexPaths(this.cwd, scope, this.env);
    const artifacts: GeneratedArtifact[] = [];

    try {
      const trackingManifest = await readTrackingManifest(paths.trackingDir);
      const instructions = resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex');
      if (instructions.length > 0) {
        await upsertManagedDeveloperInstructionsFile(paths.configTomlPath, {
          pluginName: plugin.manifest.name,
          value: renderCodexManagedInstructionBlock(
            plugin.manifest.name,
            instructions,
          ),
        });
        artifacts.push({ path: paths.configTomlPath, kind: 'instruction', platform: 'codex' });
      }

      for (const artifact of generateCodexPermissionArtifacts(
        plugin.manifest.name,
        resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex'),
      )) {
        validateRenderedCodexRules(artifact.content);
        const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
        artifacts.push({ path: artifactPath, kind: 'permission', platform: 'codex' });
      }

      const hooks = resolvePlatformHookDefinitions(plugin.manifest, 'codex');
      const hooksPath = await syncCodexHooks(
        paths.hooksPath,
        plugin,
        trackingManifest,
        this.env,
      );
      if (hooks.length > 0 && hooksPath) {
        artifacts.push({
          path: hooksPath,
          kind: 'hook',
          platform: 'codex',
          hookGroups: extractCodexHookGroups(hooks),
        });
      }

      for (const artifact of generateAgentArtifacts(
        plugin.manifest.name,
        resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex'),
        'codex',
      )) {
        const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
        artifacts.push({ path: artifactPath, kind: 'agent', platform: 'codex' });
      }

      return artifacts;
    } catch (error) {
      throw attachGeneratedArtifactsToError(error, artifacts);
    }
  }

  async uninstallExtensions(
    plugin: PluginMeta,
    scope: Scope,
    generatedArtifacts: GeneratedArtifact[] = [],
  ): Promise<void> {
    const paths = resolveCodexPaths(this.cwd, scope, this.env);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = createTrackingRecordFromArtifacts(
      plugin.manifest.name,
      getTrackingRecord(trackingManifest, plugin.manifest.name),
      generatedArtifacts,
    );
    if (trackingRecord) {
      for (const artifact of trackingRecord.artifacts) {
        if (artifact.kind === 'permission' || artifact.kind === 'agent') {
          await fs.remove(artifact.path);
        }
      }
    }

    await removeManagedDeveloperInstructionsFile(paths.configTomlPath, plugin.manifest.name);

    const trackedHookGroups = readTrackedCodexHookGroups(trackingRecord);
    if (trackedHookGroups && trackedHookGroups.length > 0) {
      const parsedHooks = await readParsedCodexSharedHooksFile(paths.hooksPath);
      const updatePlan = planCodexSharedHooksUpdate(parsedHooks, {
        rerenderedIdentities: trackedHookGroups,
      });
      const preservedHistorical = new Set(updatePlan.preservedHistoricalAwRawGroups);
      const preservedForeign = new Set(updatePlan.preservedForeignRawGroups);
      const preservedRawGroups = parsedHooks.rawGroups.filter((group) =>
        preservedHistorical.has(group) || preservedForeign.has(group),
      );
      await writeCodexSharedHookGroups(paths.hooksPath, preservedRawGroups);
      return;
    }

    if (trackedHookGroups === null && hasTrackedCodexHookArtifact(trackingRecord)) {
      const parsedHooks = await readParsedCodexSharedHooksFile(paths.hooksPath);
      await writeCodexSharedHookGroups(paths.hooksPath, parsedHooks.rawGroups);
    }
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const status = await this.status(plugin, scope);
    const pluginStatus = status.plugins[0];
    if (pluginStatus?.catalogCompatibility === 'missing') {
      throw new Error(`${plugin.manifest.name} 当前 catalog 已缺失，请先执行 uninstall。`);
    }

    if (pluginStatus?.catalogCompatibility === 'capabilityChanged') {
      await this.uninstallPlugin(plugin, scope);
      await this.uninstallExtensions(plugin, scope);
    }

    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const scopePaths = resolveCodexPaths(this.cwd, scope, this.env);
    const [userConfig, scopeConfig, ledger, generatedArtifacts, currentCatalog, projectKey, repoRoot] =
      await Promise.all([
        readCodexConfigFile(userPaths.configTomlPath),
        readCodexConfigFile(scopePaths.configTomlPath),
        readInstalledLedger(this.env),
        collectGeneratedArtifacts(plugin.manifest.name, scopePaths.trackingDir),
        resolveCurrentCatalog(this.env),
        resolveCodexProjectKey(this.cwd),
        resolveRepoRoot(this.cwd),
      ]);
    const trackingManifest = await readTrackingManifest(scopePaths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
    const currentMarketplace = await readMarketplaceManifest(this.cwd, 'codex', this.env);
    const currentCatalogAvailable = currentMarketplace.manifest.plugins.some(
      (entry) => entry.name === plugin.manifest.name,
    );
    const scopeInitialized = resolveScopeInitialized(
      ledger,
      plugin.manifest.name,
      'codex',
      scope,
      projectKey,
    );
    const sharedNativeRefs = normalizeSharedNativeRefs(
      ledger.plugins[plugin.manifest.name]?.platforms.codex?.sharedNativeRefs,
    );
    const currentScopeManagedEvidence =
      scopeInitialized === 'yes' ||
      Boolean(trackingRecord) ||
      (scope === 'user' ? sharedNativeRefs.user : sharedNativeRefs.projects.includes(projectKey));
    const platformNativeFallbackEvidence =
      scope === 'user' &&
      userConfig.snapshot.plugins[`${plugin.manifest.name}@${MARKETPLACE_NAME}`]?.enabled === true &&
      !currentScopeManagedEvidence;
    const currentCapabilities: CodexCapabilitySnapshot = {
      requiresNativePlugin: requiresNativePlugin(plugin),
      hasRepoManagedArtifacts: hasRepoManagedArtifacts(plugin),
    };
    const catalogCompatibility = resolveCodexCatalogCompatibility({
      currentManifestPresent: currentCatalogAvailable,
      currentScopeManagedEvidence,
      platformNativeFallbackEvidence,
      currentCapabilities,
      installedCapabilitySnapshot: getInstalledScopeSnapshot(
        ledger,
        plugin.manifest.name,
        scope,
        projectKey,
      ),
    });

    const projectLayerEvidence = await detectCodexProjectLayerEvidence(this.cwd, repoRoot);
    const projectLayerArtifactExists =
      scope === 'project' || projectLayerEvidence.hasProjectLayerArtifacts;
    const projectTrust = resolveCodexProjectTrust({
      applicable: scope === 'project' || projectLayerArtifactExists,
      lookupKeys: [
        path.resolve(this.cwd),
        path.resolve(repoRoot),
        projectKey,
      ],
      trustLevels: Object.fromEntries(
        Object.entries(userConfig.snapshot.projects).map(([key, value]) => [key, value.trustLevel]),
      ),
      hasProjectLayerArtifacts: projectLayerArtifactExists,
    });

    const codexInstructions = resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex');
    const codexPermissions = resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex');
    const codexHookExpectation = await resolveCodexStatusHookExpectation(
      plugin,
      trackingRecord,
      currentCatalogAvailable,
      this.env,
    );
    const codexAgents = resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex');
    const trackedAgentIds = codexAgents.map((agent) =>
      buildGeneratedName(plugin.manifest.name, agent.name),
    );

    const instructionManaged = Boolean(
      scopeConfig.snapshot.developerInstructions.managedBlocks[plugin.manifest.name],
    );
    const rulesManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'permission'),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'permission')
      .every((artifact) => artifact.exists);
    let hooksManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'hook'),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'hook')
      .every((artifact) => artifact.exists);
    const agentsManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'agent'),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'agent')
      .every((artifact) => artifact.exists);

    const driftWarnings: string[] = [];
    driftWarnings.push(...codexHookExpectation.diagnostics);
    if (hooksManaged) {
      if (codexHookExpectation.expectedGroups === null) {
        hooksManaged = false;
      } else if (codexHookExpectation.expectedGroups.length > 0) {
        try {
          const actualGroups = await readCodexHookGroups(scopePaths.hooksPath);
          if (!trackedHookGroupsContainAll(actualGroups, codexHookExpectation.expectedGroups)) {
            hooksManaged = false;
            driftWarnings.push('Codex hooks artifact 中缺少当前插件声明的 hook handlers。');
          }
        } catch (error) {
          hooksManaged = false;
          const message = error instanceof Error ? error.message : String(error);
          driftWarnings.push(`Codex hooks artifact 无法解析：${message}`);
        }
      }
    }

    const repoManagedSessionState = detectCodexSessionState({
      scope,
      declarations: {
        instructions: codexInstructions.length > 0,
        permissions: codexPermissions.length > 0,
        hooks: codexHookExpectation.declared,
        agents: codexAgents.length > 0,
      },
      managed: {
        instructions: instructionManaged,
        rules: rulesManaged,
        hooks: hooksManaged,
        agents: agentsManaged,
        agentRoleNames: trackedAgentIds,
      },
      higherPriorityExternal: {
        developerInstructions:
          scope === 'user' &&
          projectTrust === 'trusted' &&
          (
            projectLayerEvidence.currentLayerDeveloperInstructionsDefined ||
            projectLayerEvidence.ancestorDeveloperInstructionsDefined
          ),
        rules:
          scope === 'user' &&
          projectTrust === 'trusted' &&
          projectLayerEvidence.higherPriorityRulesPresent,
        hooks:
          scope === 'user' &&
          projectTrust === 'trusted' &&
          projectLayerEvidence.higherPriorityHooksPresent,
        agentRoleNames:
          scope === 'user' && projectTrust === 'trusted'
            ? projectLayerEvidence.higherPriorityAgentRoleNames
            : [],
      },
      projectLayerDeveloperInstructionsDefined:
        scope === 'user' && projectLayerEvidence.projectLayerDeveloperInstructionsDefined,
      projectTrust,
    });

    const externalOwnership = detectCodexExternalOwnership(
      userConfig.snapshot.plugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
    );
    const artifactsInitialized = generatedArtifacts.every((artifact) => artifact.exists) &&
      (
        !trackingRecord?.artifacts.some((artifact) => artifact.kind === 'instruction') ||
        instructionManaged
      );

    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
      driftWarnings.push('tracking manifest 记录的 Codex 受管产物存在缺失。');
    }
    if (platformNativeFallbackEvidence) {
      driftWarnings.push('平台真值仍在，但 CLI 账本或 tracking manifest 缺失。');
    }
    if (externalOwnership?.present) {
      driftWarnings.push(externalOwnership.details ?? '同名插件由外部 marketplace 管理。');
    }
    if (projectTrust === 'untrusted') {
      driftWarnings.push('当前 repo 处于 untrusted 状态，project scope 产物不会进入会话。');
    }
    if (projectTrust === 'unknown') {
      driftWarnings.push('当前 repo trust 状态未知，project scope 会话可见性无法确定。');
    }
    driftWarnings.push(...repoManagedSessionState.diagnostics);

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered:
          Boolean(userConfig.snapshot.marketplaces[MARKETPLACE_NAME]) &&
          !userConfig.snapshot.marketplaces[MARKETPLACE_NAME]?.sourcePointsToManifest,
        pluginAvailable: currentCatalogAvailable,
        pluginInstalled:
          userConfig.snapshot.plugins[`${plugin.manifest.name}@${MARKETPLACE_NAME}`]?.enabled === true,
        details: userConfig.snapshot.marketplaces[MARKETPLACE_NAME]?.source
          ? `source=${userConfig.snapshot.marketplaces[MARKETPLACE_NAME]?.source}`
          : undefined,
        sharedNativeRefs,
      },
      generatedArtifacts,
      driftWarnings,
      ledgerStateStatus: ledger.ledgerState.status,
      ledgerStateReason: ledger.ledgerState.reason,
      scopeInitialized,
      catalogCompatibility,
      externalOwnership,
      projectTrust,
      platformNativeFallbackEvidence: {
        present: platformNativeFallbackEvidence,
        details: platformNativeFallbackEvidence
          ? 'user scope 的 [plugins."<plugin>@aw"] enabled 仍然存在。'
          : undefined,
      },
      scopeManagedEvidence: {
        ledger: scopeInitialized === 'yes',
        tracking: Boolean(trackingRecord),
        sharedNativeRef:
          scope === 'user' ? sharedNativeRefs.user : sharedNativeRefs.projects.includes(projectKey),
      },
      currentCatalog: {
        rootDir: currentCatalog.rootDir,
        source: currentCatalog.source,
        available: currentCatalogAvailable,
        reason: currentCatalog.reason,
      },
      artifactsInitialized,
      repoManagedSessionState,
    };

    return {
      platform: 'codex',
      scope,
      initialized:
        scopeInitialized === 'yes' ||
        pluginStatus.native.pluginInstalled ||
        generatedArtifacts.length > 0 ||
        platformNativeFallbackEvidence,
      scopeInitialized: scopeInitialized as ScopeInitializedState,
      plugins: [pluginStatus],
    };
  }
}
