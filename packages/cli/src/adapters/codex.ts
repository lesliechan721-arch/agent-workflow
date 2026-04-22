import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import { renderHooksArtifact } from '../generators/hooks.js';
import { generateInstructionArtifacts } from '../generators/instructions.js';
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
import { writeJsonFile } from '../utils/json.js';
import { getMarketplaceManifestPath, resolveCodexPaths } from '../utils/paths.js';
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

export class CodexAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;

  constructor(private readonly cwd: string) {}

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd);
    return detection.codex.available;
  }

  async installPlugin(plugin: PluginMeta, _scope: Scope): Promise<void> {
    const paths = resolveCodexPaths(this.cwd, 'user');
    const registry = await readCodexRegistry(paths.registryConfigPath);
    registry.marketplaces['agent-workflows'] = {
      source: getMarketplaceManifestPath(this.cwd),
    };
    registry.plugins[plugin.manifest.name] = {
      marketplace: 'agent-workflows',
      version: plugin.manifest.version,
    };
    await writeCodexRegistry(paths.registryConfigPath, registry);
  }

  async uninstallPlugin(plugin: PluginMeta, _scope: Scope): Promise<void> {
    const paths = resolveCodexPaths(this.cwd, 'user');
    const registry = await readCodexRegistry(paths.registryConfigPath);
    delete registry.plugins[plugin.manifest.name];
    if (Object.keys(registry.plugins).length === 0) {
      delete registry.marketplaces['agent-workflows'];
    }
    await writeCodexRegistry(paths.registryConfigPath, registry);
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const paths = resolveCodexPaths(this.cwd, scope);
    const extensions = plugin.manifest.extensions ?? {};
    const artifacts: GeneratedArtifact[] = [];

    for (const artifact of generateInstructionArtifacts(
      plugin.manifest.name,
      extensions.instructions ?? [],
      'codex',
    )) {
      const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
      artifacts.push({ path: artifactPath, kind: 'instruction', platform: 'codex' });
    }

    for (const artifact of generateCodexPermissionArtifacts(
      plugin.manifest.name,
      extensions.permissions ?? [],
    )) {
      const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
      artifacts.push({ path: artifactPath, kind: 'permission', platform: 'codex' });
    }

    const hooksArtifact = renderHooksArtifact(extensions.hooks ?? [], 'codex');
    if (hooksArtifact) {
      const artifactPath = path.join(paths.configDir, hooksArtifact.relativePath);
      await writeJsonFile(artifactPath, hooksArtifact.content);
      artifacts.push({ path: artifactPath, kind: 'hook', platform: 'codex' });
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
      await fs.remove(artifact.path);
    }

    await removeTrackingRecord(paths.trackingDir, plugin.manifest.name);
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const registryPaths = resolveCodexPaths(this.cwd, 'user');
    const scopePaths = resolveCodexPaths(this.cwd, scope);
    const registry = await readCodexRegistry(registryPaths.registryConfigPath);
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

    const driftWarnings: string[] = [];
    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
      driftWarnings.push('存在记录在 tracking manifest 中但已经缺失的生成产物。');
    }

    const nativeInstalled = Boolean(registry.plugins[plugin.manifest.name]);
    const marketplaceRegistered = Boolean(registry.marketplaces['agent-workflows']);
    if (nativeInstalled && !marketplaceRegistered) {
      driftWarnings.push('插件已记录为安装状态，但 marketplace 注册缺失。');
    }

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered,
        pluginAvailable: marketplaceRegistered,
        pluginInstalled: nativeInstalled,
        version: registry.plugins[plugin.manifest.name]?.version,
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

