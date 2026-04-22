import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import { renderHooksArtifact } from '../generators/hooks.js';
import { generateInstructionArtifacts } from '../generators/instructions.js';
import { mergeClaudePermissions } from '../generators/permissions.js';
import type {
  GeneratedArtifact,
  GeneratedArtifactStatus,
  PlatformAdapter,
  PluginMeta,
  PluginStatusReport,
  Scope,
  StatusReport,
} from '../types.js';
import { detectEnvironment } from '../utils/detect.js';
import { writeJsonFile } from '../utils/json.js';
import { readMarketplaceManifest } from '../utils/marketplace.js';
import { resolveClaudePaths } from '../utils/paths.js';
import {
  readTrackingManifest,
  removeTrackingRecord,
  upsertTrackingRecord,
} from '../utils/tracking.js';
import {
  type ClaudeSettings,
  readClaudeSettings,
  readKnownMarketplaceState,
  removeFileIfExists,
  writeClaudeSettings,
  writeKnownMarketplaceState,
} from './helpers.js';

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

type ClaudePermissionState = {
  allow: string[];
  ask: string[];
  deny: string[];
};

function assertClaudePluginOwnership(
  pluginName: string,
  installedRecord: { marketplace: string; version: string; installedAt: string } | undefined,
  marketplaceName: string,
): void {
  if (!installedRecord || installedRecord.marketplace === marketplaceName) {
    return;
  }

  throw new Error(
    `${pluginName} 已由 marketplace ${JSON.stringify(installedRecord.marketplace)} 安装，agent-workflows 不会覆盖或删除外部同名插件。`,
  );
}

function aggregateClaudePermissions(settings: ClaudeSettings): ClaudePermissionState {
  const generated = settings.awGenerated?.permissions ?? {};
  const allow = new Set<string>();
  const ask = new Set<string>();
  const deny = new Set<string>();

  for (const entry of Object.values(generated)) {
    entry.allow.forEach((value) => allow.add(value));
    entry.ask.forEach((value) => ask.add(value));
    entry.deny.forEach((value) => deny.add(value));
  }

  return {
    allow: [...allow],
    ask: [...ask],
    deny: [...deny],
  };
}

function aggregateClaudeHooks(settings: ClaudeSettings): Array<Record<string, unknown>> {
  const generated = settings.awGenerated?.hooks ?? {};

  return Object.values(generated).flat();
}

function normalizeClaudePermissions(
  permissions: ClaudeSettings['permissions'] | undefined,
): ClaudePermissionState {
  return {
    allow: [...new Set(permissions?.allow ?? [])],
    ask: [...new Set(permissions?.ask ?? [])],
    deny: [...new Set(permissions?.deny ?? [])],
  };
}

function hasClaudePermissions(
  permissions: ClaudePermissionState | ClaudeSettings['permissions'] | undefined,
): boolean {
  const normalized = normalizeClaudePermissions(permissions);
  return normalized.allow.length > 0 || normalized.ask.length > 0 || normalized.deny.length > 0;
}

function subtractClaudePermissions(
  currentPermissions: ClaudeSettings['permissions'] | undefined,
  generatedPermissions: ClaudePermissionState,
): ClaudeSettings['permissions'] | undefined {
  const current = normalizeClaudePermissions(currentPermissions);
  const generated = {
    allow: new Set(generatedPermissions.allow),
    ask: new Set(generatedPermissions.ask),
    deny: new Set(generatedPermissions.deny),
  };

  const preserved = {
    allow: current.allow.filter((value) => !generated.allow.has(value)),
    ask: current.ask.filter((value) => !generated.ask.has(value)),
    deny: current.deny.filter((value) => !generated.deny.has(value)),
  };

  if (preserved.allow.length === 0 && preserved.ask.length === 0 && preserved.deny.length === 0) {
    return undefined;
  }

  return preserved;
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
    allow: [...allow],
    ask: [...ask],
    deny: [...deny],
  };
}

function normalizeComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeComparableValue(entry)]),
    );
  }

  return value;
}

function serializeComparableValue(value: unknown): string {
  return JSON.stringify(normalizeComparableValue(value));
}

function countComparableValues(
  values: Array<Record<string, unknown>>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const key = serializeComparableValue(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function subtractClaudeHooks(
  currentHooks: ClaudeSettings['hooks'] | undefined,
  generatedHooks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const generatedCounts = new Map<string, number>();

  for (const hook of generatedHooks) {
    const key = serializeComparableValue(hook);
    generatedCounts.set(key, (generatedCounts.get(key) ?? 0) + 1);
  }

  const preserved: Array<Record<string, unknown>> = [];
  for (const hook of currentHooks ?? []) {
    const key = serializeComparableValue(hook);
    const remaining = generatedCounts.get(key) ?? 0;

    if (remaining > 0) {
      generatedCounts.set(key, remaining - 1);
      continue;
    }

    preserved.push(hook);
  }

  return preserved;
}

function filterStoredClaudePermissions(
  storedPermissions: ClaudeSettings['permissions'] | undefined,
  currentPermissions: ClaudeSettings['permissions'] | undefined,
  generatedPermissions: ClaudePermissionState,
): ClaudePermissionState {
  const stored = normalizeClaudePermissions(storedPermissions);
  const current = normalizeClaudePermissions(currentPermissions);
  const generated = {
    allow: new Set(generatedPermissions.allow),
    ask: new Set(generatedPermissions.ask),
    deny: new Set(generatedPermissions.deny),
  };
  const currentSets = {
    allow: new Set(current.allow),
    ask: new Set(current.ask),
    deny: new Set(current.deny),
  };

  return {
    allow: stored.allow.filter(
      (value) => currentSets.allow.has(value) || generated.allow.has(value),
    ),
    ask: stored.ask.filter((value) => currentSets.ask.has(value) || generated.ask.has(value)),
    deny: stored.deny.filter(
      (value) => currentSets.deny.has(value) || generated.deny.has(value),
    ),
  };
}

function deriveClaudeManualPermissions(settings: ClaudeSettings): ClaudePermissionState {
  const generatedPermissions = aggregateClaudePermissions(settings);
  const visibleManualPermissions = subtractClaudePermissions(
    settings.permissions,
    generatedPermissions,
  );

  return mergeClaudePermissionStates(
    filterStoredClaudePermissions(
      settings.awGenerated?.manualPermissions,
      settings.permissions,
      generatedPermissions,
    ),
    visibleManualPermissions,
  );
}

function filterStoredClaudeHooks(
  storedHooks: Array<Record<string, unknown>>,
  currentHooks: Array<Record<string, unknown>>,
  generatedHooks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const currentCounts = countComparableValues(currentHooks);
  const generatedCounts = countComparableValues(generatedHooks);
  const emittedCounts = new Map<string, number>();
  const filtered: Array<Record<string, unknown>> = [];

  for (const hook of storedHooks) {
    const key = serializeComparableValue(hook);
    const limit = Math.max(currentCounts.get(key) ?? 0, generatedCounts.get(key) ?? 0);
    const emitted = emittedCounts.get(key) ?? 0;

    if (emitted >= limit) {
      continue;
    }

    filtered.push(hook);
    emittedCounts.set(key, emitted + 1);
  }

  return filtered;
}

function mergeHookListsByMaxCount(
  primary: Array<Record<string, unknown>>,
  secondary: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const primaryCounts = countComparableValues(primary);
  const secondaryCounts = countComparableValues(secondary);
  const limits = new Map<string, number>();

  for (const [key, count] of primaryCounts) {
    limits.set(key, count);
  }

  for (const [key, count] of secondaryCounts) {
    limits.set(key, Math.max(limits.get(key) ?? 0, count));
  }

  const emittedCounts = new Map<string, number>();
  const merged: Array<Record<string, unknown>> = [];

  for (const hook of [...primary, ...secondary]) {
    const key = serializeComparableValue(hook);
    const emitted = emittedCounts.get(key) ?? 0;
    const limit = limits.get(key) ?? 0;

    if (emitted >= limit) {
      continue;
    }

    merged.push(hook);
    emittedCounts.set(key, emitted + 1);
  }

  return merged;
}

function deriveClaudeManualHooks(settings: ClaudeSettings): Array<Record<string, unknown>> {
  const generatedHooks = aggregateClaudeHooks(settings);
  const visibleManualHooks = subtractClaudeHooks(settings.hooks, generatedHooks);
  const storedManualHooks = settings.awGenerated?.manualHooks ?? [];

  return mergeHookListsByMaxCount(
    filterStoredClaudeHooks(storedManualHooks, settings.hooks ?? [], generatedHooks),
    visibleManualHooks,
  );
}

function cleanupClaudeGeneratedState(settings: ClaudeSettings): void {
  if (settings.awGenerated?.permissions && Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }

  if (settings.awGenerated?.hooks && Object.keys(settings.awGenerated.hooks).length === 0) {
    delete settings.awGenerated.hooks;
  }

  if (!hasClaudePermissions(settings.awGenerated?.manualPermissions)) {
    if (settings.awGenerated) {
      delete settings.awGenerated.manualPermissions;
    }
  }

  if (settings.awGenerated?.manualHooks && settings.awGenerated.manualHooks.length === 0) {
    delete settings.awGenerated.manualHooks;
  }

  if (
    settings.awGenerated &&
    settings.awGenerated.permissions === undefined &&
    settings.awGenerated.hooks === undefined &&
    settings.awGenerated.manualPermissions === undefined &&
    settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

function mergeClaudeHooksState(
  manualHooks: Array<Record<string, unknown>>,
  generatedHooks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = [...manualHooks];
  const seen = new Set(merged.map((hook) => serializeComparableValue(hook)));

  for (const hook of generatedHooks) {
    const key = serializeComparableValue(hook);
    if (seen.has(key)) {
      continue;
    }

    merged.push(hook);
    seen.add(key);
  }

  return merged;
}

function rebuildClaudeSettingsState(
  settings: ClaudeSettings,
  manualPermissions: ClaudePermissionState,
  manualHooks: Array<Record<string, unknown>>,
): void {
  settings.awGenerated ??= {};

  if (hasClaudePermissions(manualPermissions)) {
    settings.awGenerated.manualPermissions = manualPermissions;
  } else {
    delete settings.awGenerated.manualPermissions;
  }

  if (manualHooks.length > 0) {
    settings.awGenerated.manualHooks = manualHooks;
  } else {
    delete settings.awGenerated.manualHooks;
  }

  const mergedPermissions = mergeClaudePermissionStates(
    manualPermissions,
    aggregateClaudePermissions(settings),
  );
  if (hasClaudePermissions(mergedPermissions)) {
    settings.permissions = mergedPermissions;
  } else {
    delete settings.permissions;
  }

  const hooks = mergeClaudeHooksState(manualHooks, aggregateClaudeHooks(settings));
  if (hooks.length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }

  cleanupClaudeGeneratedState(settings);
}

async function removeTrackedFileArtifacts(
  trackingDir: string,
  pluginName: string,
): Promise<void> {
  const trackingManifest = await readTrackingManifest(trackingDir);
  const trackingRecord = trackingManifest.plugins[pluginName];
  if (!trackingRecord) {
    return;
  }

  for (const artifact of trackingRecord.artifacts) {
    if (artifact.kind === 'instruction' || artifact.kind === 'agent') {
      await fs.remove(artifact.path);
    }
  }
}

export class ClaudeAdapter implements PlatformAdapter {
  readonly name = 'claude' as const;

  constructor(private readonly cwd: string) {}

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd);
    return detection.claude.available;
  }

  async installPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const paths = resolveClaudePaths(this.cwd, scope);
    const settings = await readClaudeSettings(paths.settingsPath);
    const { path: marketplacePath, manifest: marketplace } = await readMarketplaceManifest(
      this.cwd,
      'claude',
    );
    const installedRecord = settings.plugins?.installed?.[plugin.manifest.name];
    assertClaudePluginOwnership(plugin.manifest.name, installedRecord, marketplace.name);

    settings.extraKnownMarketplaces ??= {};
    settings.extraKnownMarketplaces[marketplace.name] = marketplacePath;
    settings.plugins ??= {};
    settings.plugins.installed ??= {};
    settings.plugins.installed[plugin.manifest.name] = {
      marketplace: marketplace.name,
      version: plugin.manifest.version,
      installedAt:
        installedRecord?.installedAt && installedRecord.version === plugin.manifest.version
          ? installedRecord.installedAt
          : new Date().toISOString(),
    };
    await writeClaudeSettings(paths.settingsPath, settings);

    const knownMarketplaceState = await readKnownMarketplaceState(paths.knownMarketplacesPath);
    knownMarketplaceState.marketplaces[marketplace.name] = {
      source: marketplacePath,
      materializedAt: new Date().toISOString(),
      plugins: marketplace.plugins.map((entry) => entry.name),
    };
    await writeKnownMarketplaceState(paths.knownMarketplacesPath, knownMarketplaceState);
    await writeJsonFile(
      path.join(paths.marketplaceCacheDir, `${marketplace.name}.json`),
      marketplace,
    );
  }

  async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const paths = resolveClaudePaths(this.cwd, scope);
    const settings = await readClaudeSettings(paths.settingsPath);
    const { path: marketplacePath, manifest: marketplace } = await readMarketplaceManifest(
      this.cwd,
      'claude',
    );
    assertClaudePluginOwnership(
      plugin.manifest.name,
      settings.plugins?.installed?.[plugin.manifest.name],
      marketplace.name,
    );

    if (settings.plugins?.installed) {
      delete settings.plugins.installed[plugin.manifest.name];
    }

    const hasMarketplaceReferences = Object.values(settings.plugins?.installed ?? {}).some(
      (entry) => entry.marketplace === marketplace.name,
    );
    if (!hasMarketplaceReferences) {
      if (settings.extraKnownMarketplaces) {
        delete settings.extraKnownMarketplaces[marketplace.name];
      }

      const knownMarketplaceState = await readKnownMarketplaceState(paths.knownMarketplacesPath);
      delete knownMarketplaceState.marketplaces[marketplace.name];
      await writeKnownMarketplaceState(paths.knownMarketplacesPath, knownMarketplaceState);
      await removeFileIfExists(path.join(paths.marketplaceCacheDir, `${marketplace.name}.json`));
    }

    await writeClaudeSettings(paths.settingsPath, settings);
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const paths = resolveClaudePaths(this.cwd, scope);
    const extensions = plugin.manifest.extensions ?? {};
    const artifacts: GeneratedArtifact[] = [];
    await removeTrackedFileArtifacts(paths.trackingDir, plugin.manifest.name);

    for (const artifact of generateInstructionArtifacts(
      plugin.manifest.name,
      extensions.instructions ?? [],
      'claude',
    )) {
      const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
      artifacts.push({ path: artifactPath, kind: 'instruction', platform: 'claude' });
    }

    for (const artifact of generateAgentArtifacts(
      plugin.manifest.name,
      extensions.agents ?? [],
      'claude',
    )) {
      const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
      artifacts.push({ path: artifactPath, kind: 'agent', platform: 'claude' });
    }

    const settings = await readClaudeSettings(paths.settingsPath);
    const manualPermissions = deriveClaudeManualPermissions(settings);
    const manualHooks = deriveClaudeManualHooks(settings);
    settings.awGenerated ??= {};

    if ((extensions.permissions ?? []).length > 0) {
      settings.awGenerated.permissions ??= {};
      settings.awGenerated.permissions[plugin.manifest.name] = mergeClaudePermissions(
        extensions.permissions ?? [],
      );
      artifacts.push({ path: paths.settingsPath, kind: 'permission', platform: 'claude' });
    } else if (settings.awGenerated.permissions) {
      delete settings.awGenerated.permissions[plugin.manifest.name];
    }

    const hooksArtifact = renderHooksArtifact(extensions.hooks ?? [], 'claude');
    if (hooksArtifact) {
      settings.awGenerated.hooks ??= {};
      settings.awGenerated.hooks[plugin.manifest.name] = (
        hooksArtifact.content.hooks as Array<Record<string, unknown>>
      ) ?? [];
      artifacts.push({ path: paths.settingsPath, kind: 'hook', platform: 'claude' });
    } else if (settings.awGenerated.hooks) {
      delete settings.awGenerated.hooks[plugin.manifest.name];
    }

    rebuildClaudeSettingsState(settings, manualPermissions, manualHooks);
    await writeClaudeSettings(paths.settingsPath, settings);

    if (artifacts.length > 0) {
      await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    } else {
      await removeTrackingRecord(paths.trackingDir, plugin.manifest.name);
    }

    return artifacts;
  }

  async uninstallExtensions(plugin: PluginMeta, scope: Scope): Promise<void> {
    const paths = resolveClaudePaths(this.cwd, scope);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = trackingManifest.plugins[plugin.manifest.name];
    if (!trackingRecord) {
      return;
    }

    for (const artifact of trackingRecord.artifacts) {
      if (artifact.kind === 'instruction' || artifact.kind === 'agent') {
        await fs.remove(artifact.path);
      }
    }

    const settings = await readClaudeSettings(paths.settingsPath);
    const manualPermissions = deriveClaudeManualPermissions(settings);
    const manualHooks = deriveClaudeManualHooks(settings);

    if (settings.awGenerated?.permissions) {
      delete settings.awGenerated.permissions[plugin.manifest.name];
    }
    if (settings.awGenerated?.hooks) {
      delete settings.awGenerated.hooks[plugin.manifest.name];
    }

    rebuildClaudeSettingsState(settings, manualPermissions, manualHooks);
    await writeClaudeSettings(paths.settingsPath, settings);

    await removeTrackingRecord(paths.trackingDir, plugin.manifest.name);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const paths = resolveClaudePaths(this.cwd, scope);
    const settings = await readClaudeSettings(paths.settingsPath);
    const { path: marketplacePath, manifest: marketplace } = await readMarketplaceManifest(
      this.cwd,
      'claude',
    );
    const installedRecord = settings.plugins?.installed?.[plugin.manifest.name];
    assertClaudePluginOwnership(plugin.manifest.name, installedRecord, marketplace.name);

    settings.extraKnownMarketplaces ??= {};
    settings.plugins ??= {};
    settings.plugins.installed ??= {};
    settings.extraKnownMarketplaces[marketplace.name] = marketplacePath;

    if (
      !installedRecord ||
      installedRecord.marketplace !== marketplace.name ||
      installedRecord.version !== plugin.manifest.version
    ) {
      settings.plugins.installed[plugin.manifest.name] = {
        marketplace: marketplace.name,
        version: plugin.manifest.version,
        installedAt:
          installedRecord?.installedAt && installedRecord.version === plugin.manifest.version
            ? installedRecord.installedAt
            : new Date().toISOString(),
      };
    }

    await writeClaudeSettings(paths.settingsPath, settings);

    const knownMarketplaceState = await readKnownMarketplaceState(paths.knownMarketplacesPath);
    knownMarketplaceState.marketplaces[marketplace.name] = {
      source: marketplacePath,
      materializedAt: new Date().toISOString(),
      plugins: marketplace.plugins.map((entry) => entry.name),
    };
    await writeKnownMarketplaceState(paths.knownMarketplacesPath, knownMarketplaceState);
    await writeJsonFile(
      path.join(paths.marketplaceCacheDir, `${marketplace.name}.json`),
      marketplace,
    );

    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const paths = resolveClaudePaths(this.cwd, scope);
    const settings = await readClaudeSettings(paths.settingsPath);
    const marketplaceState = await readKnownMarketplaceState(paths.knownMarketplacesPath);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = trackingManifest.plugins[plugin.manifest.name];
    const generatedArtifacts: GeneratedArtifactStatus[] = [];

    if (trackingRecord) {
      for (const artifact of trackingRecord.artifacts) {
        generatedArtifacts.push({
          path: artifact.path,
          exists: await fs.pathExists(artifact.path),
          kind: artifact.kind,
        });
      }
    }

    const { path: marketplacePath, manifest: marketplace } = await readMarketplaceManifest(
      this.cwd,
      'claude',
    );
    const installedRecord = settings.plugins?.installed?.[plugin.manifest.name];
    const materializedMarketplace = marketplaceState.marketplaces[marketplace.name];
    const registeredSource = settings.extraKnownMarketplaces?.[marketplace.name];

    const driftWarnings: string[] = [];
    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
      driftWarnings.push('存在记录在 tracking manifest 中但已经缺失的生成产物。');
    }
    if (installedRecord && !settings.extraKnownMarketplaces?.[marketplace.name]) {
      driftWarnings.push('插件已记录为安装状态，但 extraKnownMarketplaces 缺失。');
    }
    if (registeredSource && registeredSource !== marketplacePath) {
      driftWarnings.push('marketplace 已注册，但 source 与当前仓库不一致。');
    }
    if (installedRecord && installedRecord.marketplace !== marketplace.name) {
      driftWarnings.push('插件已安装，但 marketplace 字段不属于 agent-workflows。');
    }
    if (installedRecord?.version && installedRecord.version !== plugin.manifest.version) {
      driftWarnings.push('原生安装版本与当前插件 manifest version 不一致。');
    }

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered: Boolean(registeredSource),
        pluginAvailable: Boolean(
          materializedMarketplace?.source === marketplacePath &&
            materializedMarketplace.plugins.includes(plugin.manifest.name),
        ),
        pluginInstalled: Boolean(installedRecord),
        version: installedRecord?.version,
        details: registeredSource ? `source=${registeredSource}` : undefined,
      },
      generatedArtifacts,
      driftWarnings,
    };

    return {
      platform: 'claude',
      scope,
      initialized:
        pluginStatus.native.marketplaceRegistered ||
        pluginStatus.native.pluginInstalled ||
        generatedArtifacts.length > 0,
      plugins: [pluginStatus],
    };
  }
}
