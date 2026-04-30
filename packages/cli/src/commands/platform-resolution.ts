import type {
  CommandAction,
  PlatformName,
  PluginMeta,
  Scope,
} from '../types.js';
import { getCodexProjectInstallability } from './codex-project-installability.js';

export type PlatformEvidenceState = 'yes' | 'no' | 'unknown';
export type PlatformEvidenceStateByPlatform = Record<PlatformName, PlatformEvidenceState>;

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
  return listExecutablePlatformsForNativeAndCodexProject({
    nativeAvailablePlatforms: options.nativeAvailablePlatforms,
    codexProjectExecutableWithoutNative: canExecuteCodexProjectWithoutNative({
      action: options.action,
      scope: options.scope,
      plugins: options.plugins,
    }),
  });
}

export function resolveEvidenceFirstAutoPlatform(options: {
  evidenceStateByPlatform: PlatformEvidenceStateByPlatform;
  candidatePlatforms?: readonly PlatformName[];
  availablePlatforms?: readonly PlatformName[];
  unknownMessage: string;
  ambiguousMessage: string;
  createUnavailableError?: (platform: PlatformName) => Error;
}): PlatformName | undefined {
  const candidatePlatforms = options.candidatePlatforms ?? PLATFORM_ORDER;
  const availablePlatforms = new Set(options.availablePlatforms ?? candidatePlatforms);
  const unknownPlatforms = candidatePlatforms.filter((platform) =>
    options.evidenceStateByPlatform[platform] === 'unknown',
  );
  if (unknownPlatforms.length > 0) {
    throw new Error(options.unknownMessage);
  }

  const evidencedPlatforms = candidatePlatforms.filter((platform) =>
    options.evidenceStateByPlatform[platform] === 'yes',
  );
  if (evidencedPlatforms.length > 1) {
    throw new Error(options.ambiguousMessage);
  }

  if (evidencedPlatforms.length === 0) {
    return undefined;
  }

  const inferred = evidencedPlatforms[0];
  if (!availablePlatforms.has(inferred)) {
    throw options.createUnavailableError?.(inferred) ??
      new Error(`${inferred} 当前环境不可用。`);
  }

  return inferred;
}
