import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import { renderCodexHooks } from '../generators/hooks.js';
import { renderCodexInstructions } from '../generators/instructions.js';
import { generateCodexPermissionArtifacts } from '../generators/permissions.js';
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
import { resolvePlugins } from '../utils/manifest.js';
import { getMarketplaceManifestPath, resolveCodexPaths, type CodexPaths } from '../utils/paths.js';
import {
  readTrackingManifest,
  removeTrackingRecord,
  upsertTrackingRecord,
} from '../utils/tracking.js';
import { readCodexRegistry, writeCodexRegistry } from './helpers.js';

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

async function resolveTrackedPlugins(
  cwd: string,
  trackingDir: string,
  excludedPluginNames: string[] = [],
): Promise<PluginMeta[]> {
  const trackingManifest = await readTrackingManifest(trackingDir);
  const excluded = new Set(excludedPluginNames);
  const pluginNames = Object.keys(trackingManifest.plugins)
    .filter((pluginName) => !excluded.has(pluginName))
    .sort();

  if (pluginNames.length === 0) {
    return [];
  }

  return resolvePlugins(cwd, pluginNames);
}

async function syncSharedCodexArtifacts(
  paths: CodexPaths,
  plugins: PluginMeta[],
): Promise<{
  instructionsPath?: string;
  hooksPath?: string;
}> {
  const instructionsContent = renderCodexInstructions(
    plugins.map((plugin) => ({
      pluginName: plugin.manifest.name,
      instructions: plugin.manifest.extensions?.instructions ?? [],
    })),
  );

  const instructionsPath = instructionsContent
    ? await writeTextArtifact(paths.configDir, 'AGENTS.md', instructionsContent)
    : undefined;
  if (!instructionsContent) {
    await fs.remove(paths.instructionsPath);
  }

  const hooksArtifact = renderCodexHooks(
    plugins.map((plugin) => ({
      pluginName: plugin.manifest.name,
      hooks: plugin.manifest.extensions?.hooks ?? [],
    })),
  );

  const hooksPath = hooksArtifact
    ? path.join(paths.configDir, hooksArtifact.relativePath)
    : undefined;
  if (hooksArtifact && hooksPath) {
    await writeJsonFile(hooksPath, hooksArtifact.content);
  } else {
    await fs.remove(paths.hooksPath);
  }

  return {
    instructionsPath,
    hooksPath,
  };
}

export class CodexAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;

  constructor(private readonly cwd: string) {}

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd);
    return detection.codex.available;
  }

  async installPlugin(plugin: PluginMeta, _scope: Scope): Promise<void> {
    const paths = resolveCodexPaths(this.cwd, 'user');
    const registryFile = await readCodexRegistry(paths.registryConfigPath);
    registryFile.registry.marketplaces['agent-workflows'] = {
      ...(registryFile.registry.marketplaces['agent-workflows'] ?? {}),
      source: getMarketplaceManifestPath(this.cwd),
    };
    registryFile.registry.plugins[plugin.manifest.name] = {
      ...(registryFile.registry.plugins[plugin.manifest.name] ?? {}),
      marketplace: 'agent-workflows',
      version: plugin.manifest.version,
    };
    await writeCodexRegistry(paths.registryConfigPath, registryFile);
  }

  async uninstallPlugin(plugin: PluginMeta, _scope: Scope): Promise<void> {
    const paths = resolveCodexPaths(this.cwd, 'user');
    const registryFile = await readCodexRegistry(paths.registryConfigPath);
    delete registryFile.registry.plugins[plugin.manifest.name];
    const hasMarketplaceReferences = Object.values(registryFile.registry.plugins).some(
      (entry) => entry.marketplace === 'agent-workflows',
    );
    if (!hasMarketplaceReferences) {
      delete registryFile.registry.marketplaces['agent-workflows'];
    }
    await writeCodexRegistry(paths.registryConfigPath, registryFile);
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const paths = resolveCodexPaths(this.cwd, scope);
    const extensions = plugin.manifest.extensions ?? {};
    const artifacts: GeneratedArtifact[] = [];

    const trackedPlugins = await resolveTrackedPlugins(this.cwd, paths.trackingDir, [
      plugin.manifest.name,
    ]);
    const sharedArtifacts = await syncSharedCodexArtifacts(paths, [...trackedPlugins, plugin]);

    if ((extensions.instructions ?? []).length > 0 && sharedArtifacts.instructionsPath) {
      artifacts.push({
        path: sharedArtifacts.instructionsPath,
        kind: 'instruction',
        platform: 'codex',
      });
    }

    for (const artifact of generateCodexPermissionArtifacts(
      plugin.manifest.name,
      extensions.permissions ?? [],
    )) {
      const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
      artifacts.push({ path: artifactPath, kind: 'permission', platform: 'codex' });
    }

    if ((extensions.hooks ?? []).some((hook) => hook.event === 'command') && sharedArtifacts.hooksPath) {
      artifacts.push({ path: sharedArtifacts.hooksPath, kind: 'hook', platform: 'codex' });
    }

    for (const artifact of generateAgentArtifacts(
      plugin.manifest.name,
      extensions.agents ?? [],
      'codex',
    )) {
      const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
      artifacts.push({ path: artifactPath, kind: 'agent', platform: 'codex' });
    }

    if (artifacts.length > 0) {
      await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);
    } else {
      await removeTrackingRecord(paths.trackingDir, plugin.manifest.name);
    }

    return artifacts;
  }

  async uninstallExtensions(plugin: PluginMeta, scope: Scope): Promise<void> {
    const paths = resolveCodexPaths(this.cwd, scope);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = trackingManifest.plugins[plugin.manifest.name];
    if (!trackingRecord) {
      return;
    }

    for (const artifact of trackingRecord.artifacts) {
      if (artifact.kind === 'permission' || artifact.kind === 'agent') {
        await fs.remove(artifact.path);
      }
    }

    await removeTrackingRecord(paths.trackingDir, plugin.manifest.name);
    const remainingPlugins = await resolveTrackedPlugins(this.cwd, paths.trackingDir);
    await syncSharedCodexArtifacts(paths, remainingPlugins);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const registryPaths = resolveCodexPaths(this.cwd, 'user');
    const scopePaths = resolveCodexPaths(this.cwd, scope);
    const { registry } = await readCodexRegistry(registryPaths.registryConfigPath);
    const trackingManifest = await readTrackingManifest(scopePaths.trackingDir);
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

    const marketplace = await readJsonFile<{
      name: string;
      plugins: Array<{ name: string }>;
    }>(getMarketplaceManifestPath(this.cwd));
    const marketplaceRecord = registry.marketplaces['agent-workflows'];
    const installedRecord = registry.plugins[plugin.manifest.name];
    const marketplaceSourceMatches = marketplaceRecord?.source === getMarketplaceManifestPath(this.cwd);

    const driftWarnings: string[] = [];
    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
      driftWarnings.push('存在记录在 tracking manifest 中但已经缺失的生成产物。');
    }

    const nativeInstalled = Boolean(installedRecord);
    const marketplaceRegistered = Boolean(marketplaceRecord);
    if (nativeInstalled && !marketplaceRegistered) {
      driftWarnings.push('插件已记录为安装状态，但 marketplace 注册缺失。');
    }
    if (marketplaceRegistered && !marketplaceSourceMatches) {
      driftWarnings.push('marketplace 已注册，但 source 与当前仓库不一致。');
    }
    if (installedRecord && installedRecord.marketplace !== 'agent-workflows') {
      driftWarnings.push('插件已安装，但 marketplace 字段不属于 agent-workflows。');
    }
    if (installedRecord?.version && installedRecord.version !== plugin.manifest.version) {
      driftWarnings.push('原生安装版本与当前插件 manifest version 不一致。');
    }

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered,
        pluginAvailable: Boolean(
          marketplaceRegistered &&
            marketplaceSourceMatches &&
            marketplace.plugins.some((entry) => entry.name === plugin.manifest.name),
        ),
        pluginInstalled: nativeInstalled,
        version: installedRecord?.version,
        details: marketplaceRecord?.source
          ? `source=${marketplaceRecord.source}`
          : undefined,
      },
      generatedArtifacts,
      driftWarnings,
    };

    return {
      platform: 'codex',
      scope,
      initialized:
        marketplaceRegistered || nativeInstalled || generatedArtifacts.length > 0,
      plugins: [pluginStatus],
    };
  }
}
