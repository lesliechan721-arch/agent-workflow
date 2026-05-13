import type { PluginLocation, PluginMeta } from '../types.js';
import { collectInstallEvidence } from '../install-state/evidence.js';
import { projectInstallState } from '../install-state/status-projection.js';
import {
  normalizePluginLocation,
  serializePluginLocation,
} from '../utils/plugin-dependency-location.js';
import {
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
} from '../utils/paths.js';

function isCodexConfigParseError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Unable to parse Codex config TOML:');
}

export class DuplicateInstallPreflightError extends Error {
  readonly code = 'duplicateInstall';
  readonly location: PluginLocation;
  readonly conflictingLocation: PluginLocation;
  readonly nextSteps: string[];

  constructor(options: {
    location: PluginLocation;
    conflictingLocation: PluginLocation;
    nextSteps: string[];
    message: string;
  }) {
    super(options.message);
    this.name = 'DuplicateInstallPreflightError';
    this.location = options.location;
    this.conflictingLocation = options.conflictingLocation;
    this.nextSteps = [...options.nextSteps];
  }
}

function createCounterpartLocation(
  location: PluginLocation,
  projectKey: string,
): PluginLocation {
  return normalizePluginLocation({
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope === 'project' ? 'user' : 'project',
    projectKey: location.scope === 'project' ? null : projectKey,
  });
}

async function resolveProjectKeyForPlatform(
  platform: PluginLocation['platform'],
  cwd: string,
): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

function renderLocationForMessage(location: PluginLocation): string {
  return location.scope === 'project'
    ? `${location.platform}/project`
    : `${location.platform}/user`;
}

function renderScopedCommand(command: 'uninstall' | 'cleanup', location: PluginLocation): string {
  return `aw ${command} ${location.plugin} --platform ${location.platform} --scope ${location.scope}`;
}

function createDuplicateInstallMessage(
  location: PluginLocation,
  conflictingLocation: PluginLocation,
): string {
  const nextSteps = [
    renderScopedCommand('uninstall', conflictingLocation),
    renderScopedCommand('cleanup', conflictingLocation),
  ];
  return [
    `duplicateInstall: ${location.plugin} 在 ${renderLocationForMessage(conflictingLocation)} 已有健康安装，普通写入命令不会同时保留同一平台的 user/project 双份正常安装。`,
    `请先运行 \`${nextSteps[0]}\` 或 \`${nextSteps[1]}\`，确认保留哪一侧后再重试。`,
  ].join(' ');
}

export async function findDuplicateInstallConflict(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<DuplicateInstallPreflightError | null> {
  const location = normalizePluginLocation(options.location);
  const counterpart = createCounterpartLocation(
    location,
    await resolveProjectKeyForPlatform(location.platform, options.cwd),
  );
  let evidence;
  try {
    evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location: counterpart,
      env: options.env,
    });
  } catch (error) {
    if (
      location.platform === 'codex' &&
      location.scope === 'project' &&
      counterpart.scope === 'user' &&
      isCodexConfigParseError(error)
    ) {
      return null;
    }
    throw error;
  }
  const projection = projectInstallState(evidence);
  if (projection.kind !== 'installed') {
    return null;
  }

  const nextSteps = [
    renderScopedCommand('uninstall', counterpart),
    renderScopedCommand('cleanup', counterpart),
  ];
  return new DuplicateInstallPreflightError({
    location,
    conflictingLocation: counterpart,
    nextSteps,
    message: createDuplicateInstallMessage(location, counterpart),
  });
}

export async function assertNoDuplicateInstall(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const conflict = await findDuplicateInstallConflict(options);
  if (conflict) {
    throw conflict;
  }
}

export async function assertNoDuplicateInstalls(options: {
  cwd: string;
  locations: readonly PluginLocation[];
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const seen = new Set<string>();
  for (const rawLocation of options.locations) {
    const location = normalizePluginLocation(rawLocation);
    const key = serializePluginLocation(location);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    await assertNoDuplicateInstall({
      cwd: options.cwd,
      location,
      env: options.env,
    });
  }
}

export function shouldEnforceDuplicateInstallPreflight(options: {
  location: PluginLocation;
  plugin: PluginMeta | null | undefined;
}): boolean {
  void options;
  return true;
}
