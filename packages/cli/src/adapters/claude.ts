import path from 'node:path';

import fs from 'fs-extra';

import { generateInstructionArtifacts } from '../generators/instructions.js';
import { mergeClaudePermissions } from '../generators/permissions.js';
import type {
  CatalogCompatibility,
  ClaudeCapabilitySnapshot,
  GeneratedArtifact,
  GeneratedArtifactStatus,
  InstalledLedger,
  PlatformAdapter,
  PluginMeta,
  PluginStatusReport,
  Scope,
  ScopeInitializedState,
  StatusReport,
} from '../types.js';
import { detectEnvironment } from '../utils/detect.js';
import {
  ensureLocalMarketplace,
  readInstalledLedger,
  resolveScopeInitialized,
} from '../utils/local-marketplace.js';
import { readMarketplaceManifest } from '../utils/marketplace.js';
import { runNativeCli, type NativeCliRunner } from '../utils/native-cli.js';
import { resolveCurrentCatalog } from '../utils/plugin-catalog.js';
import { resolveAwHome, resolveClaudePaths, resolveClaudeProjectKey } from '../utils/paths.js';
import {
  attachGeneratedArtifactsToError,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import {
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import {
  type ClaudeSettings,
  detectClaudeExternalOwnership,
  getClaudeMarketplaceSource,
  isClaudePluginEnabledForScope,
  readClaudeInstalledPluginsState,
  readClaudeSettings,
  readKnownMarketplaceState,
  resolveClaudeActiveLocalBundle,
  resolveClaudeInstalledRecordForScope,
  resolveClaudeKnownMarketplaceInstallLocation,
  resolveClaudePlatformNativeFallbackEvidence,
  resolveClaudePlatformRuntimeEvidence,
  writeClaudeSettings,
} from './helpers.js';

const MARKETPLACE_NAME = 'aw';

type ClaudePermissionState = {
  allow: string[];
  ask: string[];
  deny: string[];
};

function normalizeComparableArray(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeManagedExtensions(
  snapshot: ClaudeCapabilitySnapshot | undefined,
): string[] {
  return normalizeComparableArray(snapshot?.managedExtensions);
}

function getClaudeManagedExtensions(plugin: PluginMeta): string[] {
  const managedExtensions: string[] = [];
  if (resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'claude').length > 0) {
    managedExtensions.push('instructions');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'claude').length > 0) {
    managedExtensions.push('permissions');
  }
  return managedExtensions;
}

export function resolveClaudeCatalogCompatibility(options: {
  currentManifestPresent: boolean;
  currentManagedExtensions: string[];
  currentScopeManagedEvidence: boolean;
  platformRuntimeEvidence: boolean;
  platformNativeFallbackEvidence: boolean;
  installedCapabilitySnapshot?: ClaudeCapabilitySnapshot;
}): CatalogCompatibility | undefined {
  if (!options.currentManifestPresent) {
    return (
      options.currentScopeManagedEvidence ||
      options.platformRuntimeEvidence ||
      options.platformNativeFallbackEvidence
    )
      ? 'missing'
      : undefined;
  }

  if (!options.currentScopeManagedEvidence || !options.installedCapabilitySnapshot) {
    return undefined;
  }

  const installedExtensions = normalizeManagedExtensions(options.installedCapabilitySnapshot);
  const currentExtensions = normalizeComparableArray(options.currentManagedExtensions);
  return JSON.stringify(installedExtensions) === JSON.stringify(currentExtensions)
    ? 'current'
    : 'capabilityChanged';
}

function normalizeClaudePermissions(
  permissions: ClaudeSettings['permissions'] | ClaudePermissionState | undefined,
): ClaudePermissionState {
  return {
    allow: normalizeComparableArray(permissions?.allow),
    ask: normalizeComparableArray(permissions?.ask),
    deny: normalizeComparableArray(permissions?.deny),
  };
}

function hasClaudePermissions(
  permissions: ClaudePermissionState | ClaudeSettings['permissions'] | undefined,
): boolean {
  const normalized = normalizeClaudePermissions(permissions);
  return normalized.allow.length > 0 || normalized.ask.length > 0 || normalized.deny.length > 0;
}

function mergeClaudePermissionStates(
  ...permissionsList: Array<ClaudeSettings['permissions'] | ClaudePermissionState | undefined>
): ClaudePermissionState {
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();

  for (const permissions of permissionsList) {
    const normalized = normalizeClaudePermissions(permissions);
    normalized.allow.forEach((value) => allow.add(value));
    normalized.ask.forEach((value) => ask.add(value));
    normalized.deny.forEach((value) => deny.add(value));
  }

  return {
    allow: [...allow].sort(),
    ask: [...ask].sort(),
    deny: [...deny].sort(),
  };
}

function subtractClaudePermissions(
  currentPermissions: ClaudeSettings['permissions'] | undefined,
  generatedPermissions: ClaudePermissionState,
): ClaudePermissionState {
  const current = normalizeClaudePermissions(currentPermissions);
  const generated = {
    allow: new Set(generatedPermissions.allow),
    ask: new Set(generatedPermissions.ask),
    deny: new Set(generatedPermissions.deny),
  };

  return {
    allow: current.allow.filter((value) => !generated.allow.has(value)),
    ask: current.ask.filter((value) => !generated.ask.has(value)),
    deny: current.deny.filter((value) => !generated.deny.has(value)),
  };
}

function aggregateGeneratedClaudePermissions(settings: ClaudeSettings): ClaudePermissionState {
  const generated = settings.awGenerated?.permissions ?? {};
  return mergeClaudePermissionStates(...Object.values(generated));
}

function cleanupClaudeGeneratedState(settings: ClaudeSettings): void {
  if (settings.awGenerated?.permissions && Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }

  if (!hasClaudePermissions(settings.awGenerated?.manualPermissions)) {
    if (settings.awGenerated) {
      delete settings.awGenerated.manualPermissions;
    }
  }

  if (
    settings.awGenerated &&
    settings.awGenerated.permissions === undefined &&
    settings.awGenerated.manualPermissions === undefined &&
    settings.awGenerated.hooks === undefined &&
    settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

function rebuildClaudePermissionState(
  settings: ClaudeSettings,
  manualPermissions: ClaudePermissionState,
): void {
  settings.awGenerated ??= {};
  if (hasClaudePermissions(manualPermissions)) {
    settings.awGenerated.manualPermissions = manualPermissions;
  } else {
    delete settings.awGenerated.manualPermissions;
  }

  const mergedPermissions = mergeClaudePermissionStates(
    manualPermissions,
    aggregateGeneratedClaudePermissions(settings),
  );
  if (hasClaudePermissions(mergedPermissions)) {
    settings.permissions = mergedPermissions;
  } else {
    delete settings.permissions;
  }

  cleanupClaudeGeneratedState(settings);
}

function normalizeLocalPath(input: string | undefined): string | undefined {
  return input ? path.resolve(input) : undefined;
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

function upsertClaudeScopeLedger(
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
  pluginRecord.platforms.claude ??= {
    projectScopes: {},
  };
  pluginRecord.platforms.claude.lastRequestedScope = scope;
  pluginRecord.platforms.claude.lastRequestedAt = timestamp;

  const scopeRecord = {
    managed: true,
    updatedAt: timestamp,
    resolvedVersion: plugin.manifest.version,
    capabilitySnapshot: {
      managedExtensions: getClaudeManagedExtensions(plugin),
    } satisfies ClaudeCapabilitySnapshot,
  };

  if (scope === 'user') {
    pluginRecord.platforms.claude.userScope = scopeRecord;
  } else if (projectKey) {
    pluginRecord.platforms.claude.projectScopes ??= {};
    pluginRecord.platforms.claude.projectScopes[projectKey] = scopeRecord;
  }

  nextLedger.plugins[plugin.manifest.name] = pluginRecord;
  return nextLedger;
}

export async function applyClaudeInstallLedger(
  ledger: InstalledLedger,
  plugin: PluginMeta,
  scope: Scope,
  cwd: string,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveClaudeProjectKey(cwd) : undefined;
  return upsertClaudeScopeLedger(ledger, plugin, scope, projectKey);
}

function removeClaudeScopeLedger(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  projectKey: string | undefined,
): InstalledLedger {
  const nextLedger = readMutableLedger(ledger);
  const pluginRecord = nextLedger.plugins[pluginName];
  if (!pluginRecord?.platforms.claude) {
    return nextLedger;
  }

  if (scope === 'user') {
    delete pluginRecord.platforms.claude.userScope;
  } else if (projectKey) {
    delete pluginRecord.platforms.claude.projectScopes?.[projectKey];
    if (
      pluginRecord.platforms.claude.projectScopes &&
      Object.keys(pluginRecord.platforms.claude.projectScopes).length === 0
    ) {
      delete pluginRecord.platforms.claude.projectScopes;
    }
  }

  const claudePlatform = pluginRecord.platforms.claude;
  const hasProjectScopes = Object.keys(claudePlatform.projectScopes ?? {}).length > 0;
  if (!claudePlatform.userScope && !hasProjectScopes) {
    delete pluginRecord.platforms.claude;
  }

  if (Object.keys(pluginRecord.platforms).length === 0) {
    delete nextLedger.plugins[pluginName];
  }

  return nextLedger;
}

export async function applyClaudeUninstallLedger(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  cwd: string,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveClaudeProjectKey(cwd) : undefined;
  return removeClaudeScopeLedger(ledger, pluginName, scope, projectKey);
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

export class ClaudeAdapter implements PlatformAdapter {
  readonly name = 'claude' as const;

  constructor(
    private readonly cwd: string,
    private readonly nativeCliRunner?: NativeCliRunner,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd, this.env);
    return detection.claude.available;
  }

  async installPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const paths = resolveClaudePaths(this.cwd, scope, this.env);
    const settings = await readClaudeSettings(paths.settingsPath);
    const installedPlugins = await readClaudeInstalledPluginsState(paths.installedPluginsPath);
    const externalOwnership = detectClaudeExternalOwnership(
      settings,
      installedPlugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
      scope,
      scope === 'project' ? await resolveClaudeProjectKey(this.cwd) : undefined,
    );
    if (externalOwnership?.present) {
      throw new Error(externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
    }

    await ensureLocalMarketplace(this.env);
    const awHome = resolveAwHome(this.env);
    const knownMarketplaces = await readKnownMarketplaceState(paths.knownMarketplacesPath);
    const declaredSource = normalizeLocalPath(getClaudeMarketplaceSource(settings, MARKETPLACE_NAME));
    const materializedInstallLocation = normalizeLocalPath(
      resolveClaudeKnownMarketplaceInstallLocation(knownMarketplaces.marketplaces[MARKETPLACE_NAME]),
    );
    const activeBundle = await resolveClaudeActiveLocalBundle(
      plugin.manifest.name,
      MARKETPLACE_NAME,
      materializedInstallLocation,
    );
    const shouldAddMarketplace =
      declaredSource !== normalizeLocalPath(awHome) ||
      materializedInstallLocation !== normalizeLocalPath(awHome) ||
      !activeBundle.activeLocalBundle;

    if (shouldAddMarketplace) {
      await runNativeCli(
        {
          command: 'claude',
          args: ['plugin', 'marketplace', 'add', awHome, '--scope', scope],
          cwd: this.cwd,
          env: this.env,
        },
        this.nativeCliRunner,
      );
    }

    await runNativeCli(
      {
        command: 'claude',
        args: ['plugin', 'install', `${plugin.manifest.name}@${MARKETPLACE_NAME}`, '--scope', scope],
        cwd: this.cwd,
        env: this.env,
      },
      this.nativeCliRunner,
    );
  }

  async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await runNativeCli(
      {
        command: 'claude',
        args: ['plugin', 'uninstall', `${plugin.manifest.name}@${MARKETPLACE_NAME}`, '--scope', scope],
        cwd: this.cwd,
        env: this.env,
      },
      this.nativeCliRunner,
    );
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const paths = resolveClaudePaths(this.cwd, scope, this.env);
    const artifacts: GeneratedArtifact[] = [];

    try {
      for (const artifact of generateInstructionArtifacts(
        plugin.manifest.name,
        resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'claude'),
        'claude',
      )) {
        const artifactPath = path.join(paths.configDir, artifact.relativePath);
        await fs.ensureDir(path.dirname(artifactPath));
        await fs.writeFile(artifactPath, artifact.content, 'utf8');
        artifacts.push({ path: artifactPath, kind: 'instruction', platform: 'claude' });
      }

      const settings = await readClaudeSettings(paths.settingsPath);
      const manualPermissions = subtractClaudePermissions(
        settings.permissions,
        aggregateGeneratedClaudePermissions(settings),
      );
      settings.awGenerated ??= {};

      const permissions = resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'claude');
      if (permissions.length > 0) {
        settings.awGenerated.permissions ??= {};
        settings.awGenerated.permissions[plugin.manifest.name] = mergeClaudePermissions(
          permissions,
        );
      } else if (settings.awGenerated.permissions) {
        delete settings.awGenerated.permissions[plugin.manifest.name];
      }

      rebuildClaudePermissionState(settings, manualPermissions);
      await writeClaudeSettings(paths.settingsPath, settings);

      if (permissions.length > 0) {
        artifacts.push({ path: paths.settingsPath, kind: 'permission', platform: 'claude' });
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
    const paths = resolveClaudePaths(this.cwd, scope, this.env);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
    const artifacts = mergeGeneratedArtifacts(trackingRecord?.artifacts, generatedArtifacts);

    for (const artifact of artifacts) {
      if (artifact.kind === 'instruction') {
        await fs.remove(artifact.path);
      }
    }

    const settings = await readClaudeSettings(paths.settingsPath);
    const manualPermissions = subtractClaudePermissions(
      settings.permissions,
      aggregateGeneratedClaudePermissions(settings),
    );

    if (settings.awGenerated?.permissions) {
      delete settings.awGenerated.permissions[plugin.manifest.name];
    }

    rebuildClaudePermissionState(settings, manualPermissions);
    await writeClaudeSettings(paths.settingsPath, settings);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const status = await this.status(plugin, scope);
    const pluginStatus = status.plugins[0];
    if (pluginStatus?.catalogCompatibility === 'missing') {
      throw new Error(`${plugin.manifest.name} 当前 catalog 已缺失，请先执行 uninstall。`);
    }

    if (pluginStatus?.catalogCompatibility === 'capabilityChanged') {
      await this.uninstallExtensions(plugin, scope);
    }

    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const paths = resolveClaudePaths(this.cwd, scope, this.env);
    const projectKey = scope === 'project' ? await resolveClaudeProjectKey(this.cwd) : undefined;
    const [settings, knownMarketplaces, installedPlugins, ledger, generatedArtifacts, currentCatalog] =
      await Promise.all([
        readClaudeSettings(paths.settingsPath),
        readKnownMarketplaceState(paths.knownMarketplacesPath),
        readClaudeInstalledPluginsState(paths.installedPluginsPath),
        readInstalledLedger(this.env),
        collectGeneratedArtifacts(plugin.manifest.name, paths.trackingDir),
        resolveCurrentCatalog(this.env),
      ]);

    const currentMarketplace = await readMarketplaceManifest(this.cwd, 'claude', this.env);
    const currentCatalogAvailable = currentMarketplace.manifest.plugins.some(
      (entry) => entry.name === plugin.manifest.name,
    );
    const declaredSource = getClaudeMarketplaceSource(settings, MARKETPLACE_NAME);
    const knownMarketplace = knownMarketplaces.marketplaces[MARKETPLACE_NAME];
    const materializedInstallLocation =
      resolveClaudeKnownMarketplaceInstallLocation(knownMarketplace);
    const installedRecord = resolveClaudeInstalledRecordForScope(
      installedPlugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
      scope,
      projectKey,
    );
    const runtimeEvidence = await resolveClaudePlatformRuntimeEvidence(
      settings,
      installedPlugins,
      knownMarketplace,
      plugin.manifest.name,
      MARKETPLACE_NAME,
      scope,
      projectKey,
    );
    const nativeFallbackEvidence = resolveClaudePlatformNativeFallbackEvidence(
      settings,
      installedPlugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
      scope,
      projectKey,
    );
    const externalOwnership = detectClaudeExternalOwnership(
      settings,
      installedPlugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
      scope,
      projectKey,
    );
    const scopeInitialized = resolveScopeInitialized(
      ledger,
      plugin.manifest.name,
      'claude',
      scope,
      projectKey,
    );
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
    const hasScopeManagedEvidence = Boolean(
      (scopeInitialized === 'yes') ||
      trackingRecord,
    );
    const catalogCompatibility = resolveClaudeCatalogCompatibility({
      currentManifestPresent: currentCatalogAvailable,
      currentManagedExtensions: getClaudeManagedExtensions(plugin),
      currentScopeManagedEvidence: hasScopeManagedEvidence,
      platformRuntimeEvidence: runtimeEvidence.present,
      platformNativeFallbackEvidence: nativeFallbackEvidence.present,
      installedCapabilitySnapshot:
        scope === 'user'
          ? ledger.plugins[plugin.manifest.name]?.platforms.claude?.userScope?.capabilitySnapshot
          : projectKey
            ? ledger.plugins[plugin.manifest.name]?.platforms.claude?.projectScopes?.[projectKey]?.capabilitySnapshot
            : undefined,
    });

    const permissionManaged = Boolean(
      settings.awGenerated?.permissions?.[plugin.manifest.name],
    );
    const artifactsInitialized = generatedArtifacts.every((artifact) => artifact.exists) &&
      (
        !trackingRecord?.artifacts.some((artifact) => artifact.kind === 'permission') ||
        permissionManaged
      );

    const driftWarnings: string[] = [];
    const expectedAwHome = normalizeLocalPath(resolveAwHome(this.env));
    const normalizedDeclaredSource = normalizeLocalPath(declaredSource);
    const normalizedMaterializedInstallLocation = normalizeLocalPath(materializedInstallLocation);

    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
      driftWarnings.push('tracking manifest 记录的 Claude 受管产物存在缺失。');
    }
    if (declaredSource && normalizedDeclaredSource !== expectedAwHome) {
      driftWarnings.push('marketplace 已声明，但 declared source 已漂移。');
    }
    if (materializedInstallLocation && normalizedMaterializedInstallLocation !== expectedAwHome) {
      driftWarnings.push('known_marketplaces.json 中的 installLocation 已漂移。');
    }
    if (declaredSource && !materializedInstallLocation) {
      driftWarnings.push('settings.json 已声明 marketplace，但物化层缺失。');
    }
    if (runtimeEvidence.details && !runtimeEvidence.present) {
      driftWarnings.push(`runtime evidence 不完整：${runtimeEvidence.details}`);
    }
    if (nativeFallbackEvidence.details && !nativeFallbackEvidence.present) {
      driftWarnings.push(`native fallback evidence 不完整：${nativeFallbackEvidence.details}`);
    }
    if (externalOwnership?.present) {
      driftWarnings.push(externalOwnership.details ?? '同名插件由外部 marketplace 管理。');
    }
    if (
      runtimeEvidence.activeLocalBundle &&
      normalizeLocalPath(runtimeEvidence.activeLocalBundle) !==
        normalizeLocalPath(path.join(currentCatalog.rootDir, 'plugins', plugin.manifest.name))
    ) {
      driftWarnings.push('currentCatalog 与 activeLocalBundle 指向的 bundle 不一致。');
    }

    const pluginInstalled = isClaudePluginEnabledForScope(
      settings,
      plugin.manifest.name,
      MARKETPLACE_NAME,
      scope,
      projectKey,
    ) && Boolean(installedRecord);

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered: Boolean(declaredSource),
        pluginAvailable: currentCatalogAvailable,
        pluginInstalled,
        version: installedRecord?.version ?? plugin.manifest.version,
        details: declaredSource ? `declaredSource=${declaredSource}` : undefined,
        declaredSource,
        materializedInstallLocation,
        activeLocalBundlePath: runtimeEvidence.activeLocalBundle,
      },
      generatedArtifacts,
      driftWarnings,
      ledgerStateStatus: ledger.ledgerState.status,
      ledgerStateReason: ledger.ledgerState.reason,
      scopeInitialized,
      catalogCompatibility,
      externalOwnership,
      platformRuntimeEvidence: {
        present: !hasScopeManagedEvidence && runtimeEvidence.present,
        details: runtimeEvidence.details,
      },
      platformNativeFallbackEvidence: {
        present: !hasScopeManagedEvidence && nativeFallbackEvidence.present,
        details: nativeFallbackEvidence.details,
      },
      scopeManagedEvidence: {
        ledger: scopeInitialized === 'yes',
        tracking: Boolean(trackingRecord),
        sharedNativeRef: false,
      },
      currentCatalog: {
        rootDir: currentCatalog.rootDir,
        source: currentCatalog.source,
        available: currentCatalogAvailable,
        reason: currentCatalog.reason,
      },
      activeLocalBundle: runtimeEvidence.activeLocalBundle,
      artifactsInitialized,
      repoManagedSessionState: {
        instructions: resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'claude').length > 0
          ? (trackingRecord ? 'visible' : 'absent')
          : 'not_applicable',
        rules: resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'claude').length > 0
          ? (permissionManaged ? 'visible' : 'absent')
          : 'not_applicable',
        hooks: 'not_applicable',
        agents: 'not_applicable',
        diagnostics: [],
      },
    };

    return {
      platform: 'claude',
      scope,
      initialized:
        scopeInitialized === 'yes' ||
        pluginInstalled ||
        generatedArtifacts.length > 0 ||
        runtimeEvidence.present ||
        nativeFallbackEvidence.present,
      scopeInitialized: scopeInitialized as ScopeInitializedState,
      plugins: [pluginStatus],
    };
  }
}
