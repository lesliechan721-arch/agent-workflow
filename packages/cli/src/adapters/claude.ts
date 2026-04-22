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
import { readJsonFile, writeJsonFile } from '../utils/json.js';
import { getMarketplaceManifestPath, resolveClaudePaths } from '../utils/paths.js';
import {
  readTrackingManifest,
  removeTrackingRecord,
  upsertTrackingRecord,
} from '../utils/tracking.js';
import {
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
    const marketplacePath = getMarketplaceManifestPath(this.cwd);
    const marketplace = await readJsonFile<{
      name: string;
      plugins: Array<{ name: string }>;
    }>(marketplacePath);

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
    const marketplacePath = getMarketplaceManifestPath(this.cwd);
    const marketplace = await readJsonFile<{ name: string }>(marketplacePath);

    if (settings.plugins?.installed) {
      delete settings.plugins.installed[plugin.manifest.name];
    }

    const hasInstalledPlugins = Boolean(
      settings.plugins?.installed && Object.keys(settings.plugins.installed).length > 0,
    );
    if (!hasInstalledPlugins) {
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
    settings.awGenerated ??= {};

    if ((extensions.permissions ?? []).length > 0) {
      settings.awGenerated.permissions ??= {};
      settings.awGenerated.permissions[plugin.manifest.name] = mergeClaudePermissions(
        extensions.permissions ?? [],
      );
      settings.permissions = aggregateClaudePermissions(settings as Record<string, unknown>);
      artifacts.push({ path: paths.settingsPath, kind: 'permission', platform: 'claude' });
    }

    const hooksArtifact = renderHooksArtifact(extensions.hooks ?? [], 'claude');
    if (hooksArtifact) {
      settings.awGenerated.hooks ??= {};
      settings.awGenerated.hooks[plugin.manifest.name] = (
        hooksArtifact.content.hooks as Array<Record<string, unknown>>
      ) ?? [];
      settings.hooks = aggregateClaudeHooks(settings as Record<string, unknown>);
      artifacts.push({ path: paths.settingsPath, kind: 'hook', platform: 'claude' });
    }

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
    if (settings.awGenerated?.permissions) {
      delete settings.awGenerated.permissions[plugin.manifest.name];
      settings.permissions = aggregateClaudePermissions(settings as Record<string, unknown>);
    }
    if (settings.awGenerated?.hooks) {
      delete settings.awGenerated.hooks[plugin.manifest.name];
      settings.hooks = aggregateClaudeHooks(settings as Record<string, unknown>);
    }
    await writeClaudeSettings(paths.settingsPath, settings);

    await removeTrackingRecord(paths.trackingDir, plugin.manifest.name);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin, scope);
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

    const marketplacePath = getMarketplaceManifestPath(this.cwd);
    const marketplace = await readJsonFile<{ name: string }>(marketplacePath);
    const installedRecord = settings.plugins?.installed?.[plugin.manifest.name];
    const materializedMarketplace = marketplaceState.marketplaces[marketplace.name];

    const driftWarnings: string[] = [];
    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
      driftWarnings.push('存在记录在 tracking manifest 中但已经缺失的生成产物。');
    }
    if (installedRecord && !settings.extraKnownMarketplaces?.[marketplace.name]) {
      driftWarnings.push('插件已记录为安装状态，但 extraKnownMarketplaces 缺失。');
    }

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered: Boolean(settings.extraKnownMarketplaces?.[marketplace.name]),
        pluginAvailable: Boolean(
          materializedMarketplace?.plugins.includes(plugin.manifest.name),
        ),
        pluginInstalled: Boolean(installedRecord),
        version: installedRecord?.version,
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

