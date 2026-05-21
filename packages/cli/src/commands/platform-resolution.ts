import type {
  CommandAction,
  PlatformName,
  PluginMeta,
  Scope,
} from '../types.js';
import { getCodexProjectInstallability } from './codex-project-installability.js';

const PLATFORM_ORDER: PlatformName[] = ['codex', 'claude'];

export function canExecuteCodexProjectWithoutNative(options: {
  action: CommandAction;
  scope: Scope;
  plugins: PluginMeta[];
}): boolean {
  if (options.scope !== 'project') {
    return false;
  }

  if (options.action === 'uninstall') {
    return true;
  }

  if (options.action !== 'install' && options.action !== 'upgrade') {
    return false;
  }

  return options.plugins.length > 0 &&
    options.plugins.every((plugin) => getCodexProjectInstallability(plugin).installable);
}

export function listExecutablePlatformsForNativeAndCodexProject(options: {
  nativeAvailablePlatforms: Iterable<PlatformName>;
  codexProjectExecutableWithoutNative: boolean;
}): PlatformName[] {
  const nativeAvailable = new Set(options.nativeAvailablePlatforms);
  return PLATFORM_ORDER.filter((platform) =>
    nativeAvailable.has(platform) ||
      (platform === 'codex' && options.codexProjectExecutableWithoutNative),
  );
}

export function listExecutablePlatformsForTargets(options: {
  nativeAvailablePlatforms: Iterable<PlatformName>;
  action: CommandAction;
  scope: Scope;
  plugins: PluginMeta[];
}): PlatformName[] {
  void options.action;
  void options.scope;
  void options.plugins;
  return listExecutablePlatformsForNativeAndCodexProject({
    nativeAvailablePlatforms: options.nativeAvailablePlatforms,
    codexProjectExecutableWithoutNative: false,
  });
}
