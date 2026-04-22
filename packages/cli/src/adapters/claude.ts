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

function aggregateClaudePermissions(settings: Record<string, unknown>): {
  allow: string[];
  ask: string[];
  deny: string[];
} {
  const generated = (settings.awGenerated as {
    permissions?: Record<string, { allow: string[]; ask: string[]; deny: string[] }>;
  } | undefined)?.permissions ?? {};
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

function aggregateClaudeHooks(settings: Record<string, unknown>): Array<Record<string, unknown>> {
  const generated = (settings.awGenerated as {
    hooks?: Record<string, Array<Record<string, unknown>>>;
  } | undefined)?.hooks ?? {};

  return Object.values(generated).flat();
}

function normalizeClaudePermissions(
  permissions: ClaudeSettings['permissions'] | undefined,
): {
  allow: string[];
  ask: string[];
  deny: string[];
} {
  return {
    allow: [...new Set(permissions?.allow ?? [])],
    ask: [...new Set(permissions?.ask ?? [])],
    deny: [...new Set(permissions?.deny ?? [])],
  };
}

function subtractClaudePermissions(
  currentPermissions: ClaudeSettings['permissions'] | undefined,
  generatedPermissions: {
    allow: string[];
    ask: string[];
    deny: string[];
  },
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

function mergeClaudePermissionState(
  preservedPermissions: ClaudeSettings['permissions'] | undefined,
  generatedPermissions: {
    allow: string[];
    ask: string[];
    deny: string[];
  },
): ClaudeSettings['permissions'] | undefined {
  const preserved = normalizeClaudePermissions(preservedPermissions);
  const merged = {
    allow: [...new Set([...preserved.allow, ...generatedPermissions.allow])],
    ask: [...new Set([...preserved.ask, ...generatedPermissions.ask])],
    deny: [...new Set([...preserved.deny, ...generatedPermissions.deny])],
  };

  if (merged.allow.length === 0 && merged.ask.length === 0 && merged.deny.length === 0) {
    return undefined;
  }

  return merged;
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

function cleanupClaudeGeneratedState(settings: ClaudeSettings): void {
  if (settings.awGenerated?.permissions && Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }

  if (settings.awGenerated?.hooks && Object.keys(settings.awGenerated.hooks).length === 0) {
    delete settings.awGenerated.hooks;
  }

  if (
    settings.awGenerated &&
    settings.awGenerated.permissions === undefined &&
    settings.awGenerated.hooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

function rebuildClaudeSettingsState(
  settings: ClaudeSettings,
  preservedPermissions: ClaudeSettings['permissions'] | undefined,
  preservedHooks: Array<Record<string, unknown>>,
): void {
  const mergedPermissions = mergeClaudePermissionState(
    preservedPermissions,
    aggregateClaudePermissions(settings as Record<string, unknown>),
  );
  if (mergedPermissions) {
    settings.permissions = mergedPermissions;
  } else {
    delete settings.permissions;
  }

  const hooks = [...preservedHooks, ...aggregateClaudeHooks(settings as Record<string, unknown>)];
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

    settings.extraKnownMarketplaces ??= {};
    settings.extraKnownMarketplaces[marketplace.name] = marketplacePath;
    settings.plugins ??= {};
    settings.plugins.installed ??= {};
    settings.plugins.installed[plugin.manifest.name] = {
      marketplace: marketplace.name,
      version: plugin.manifest.version,
      installedAt: new Date().toISOString(),
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
    const preservedPermissions = subtractClaudePermissions(
      settings.permissions,
      aggregateClaudePermissions(settings as Record<string, unknown>),
    );
    const preservedHooks = subtractClaudeHooks(
      settings.hooks,
      aggregateClaudeHooks(settings as Record<string, unknown>),
    );
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

    rebuildClaudeSettingsState(settings, preservedPermissions, preservedHooks);
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
    const preservedPermissions = subtractClaudePermissions(
      settings.permissions,
      aggregateClaudePermissions(settings as Record<string, unknown>),
    );
    const preservedHooks = subtractClaudeHooks(
      settings.hooks,
      aggregateClaudeHooks(settings as Record<string, unknown>),
    );

    if (settings.awGenerated?.permissions) {
      delete settings.awGenerated.permissions[plugin.manifest.name];
    }
    if (settings.awGenerated?.hooks) {
      delete settings.awGenerated.hooks[plugin.manifest.name];
    }

    rebuildClaudeSettingsState(settings, preservedPermissions, preservedHooks);
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

    settings.extraKnownMarketplaces ??= {};
    settings.plugins ??= {};
    settings.plugins.installed ??= {};
    settings.extraKnownMarketplaces[marketplace.name] = marketplacePath;

    const installedRecord = settings.plugins.installed[plugin.manifest.name];
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
