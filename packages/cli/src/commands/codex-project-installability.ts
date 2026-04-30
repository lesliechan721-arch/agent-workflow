import {
  getCodexProjectManagedKinds,
  hasCodexProjectManagedArtifacts,
} from '../adapters/codex.js';
import type {
  CodexProjectManagedKind,
  PlatformName,
  PluginMeta,
  Scope,
} from '../types.js';
import type { ResolvedPluginTarget } from './common.js';

export interface CodexProjectInstallability {
  installable: boolean;
  hasApps: boolean;
  managedKinds: CodexProjectManagedKind[];
  reason?: string;
}

function pluginName(plugin: PluginMeta): string {
  return plugin.manifest.name;
}

function createAppsUnsupportedReason(plugin: PluginMeta): string {
  return `${pluginName(plugin)} 声明了 apps，Codex project scope 暂不支持 apps；请改用 --scope user 或拆分插件。`;
}

function createNoManagedKindsReason(plugin: PluginMeta): string {
  return `${pluginName(plugin)} 没有任何 Codex project-managed kind，Codex project scope 不支持安装。`;
}

export function getCodexProjectInstallability(plugin: PluginMeta): CodexProjectInstallability {
  const managedKinds = getCodexProjectManagedKinds(plugin);
  if (plugin.manifest.apps) {
    return {
      installable: false,
      hasApps: true,
      managedKinds,
      reason: createAppsUnsupportedReason(plugin),
    };
  }

  if (!hasCodexProjectManagedArtifacts(plugin)) {
    return {
      installable: false,
      hasApps: false,
      managedKinds,
      reason: createNoManagedKindsReason(plugin),
    };
  }

  return {
    installable: true,
    hasApps: false,
    managedKinds,
  };
}

export function collectCodexProjectInstallabilityErrors(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  scope: Scope,
): string[] {
  if (scope !== 'project' || !platforms.includes('codex')) {
    return [];
  }

  return targets
    .map((target) => getCodexProjectInstallability(target.currentPlugin ?? target.plugin).reason)
    .filter((reason): reason is string => Boolean(reason));
}

export function assertCodexProjectInstallableTargets(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  scope: Scope,
): void {
  const errors = collectCodexProjectInstallabilityErrors(targets, platforms, scope);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

export function shouldOmitCodexProjectInstallCandidate(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  hasExplicitPluginSelection: boolean;
}): boolean {
  if (options.platform !== 'codex' || options.scope !== 'project' || options.hasExplicitPluginSelection) {
    return false;
  }

  const installability = getCodexProjectInstallability(options.plugin);
  return installability.hasApps && installability.managedKinds.length === 0;
}
