import type {
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  PlatformSelection,
  Scope,
  SkillTriggerPreference,
  StatusCommandOptions,
  UpgradeCommandOptions,
} from '../types.js';

export interface NormalizeCommandOptionsDefaults {
  cwd?: string;
  defaultScope?: Scope;
  defaultPlatform?: PlatformSelection;
}

export type RawCommandOptions = {
  cwd?: string;
  scope?: string;
  platform?: string;
  scriptTimeout?: string | number;
  scriptTimeoutMs?: string | number;
};

export type RawInstallCommandOptions = RawCommandOptions & {
  requestedSkillTrigger?: SkillTriggerPreference | string;
  skillTrigger?: SkillTriggerPreference | string;
  takeoverSharedRuntime?: boolean;
};

export type RawUpgradeCommandOptions = RawInstallCommandOptions & {
  all?: boolean;
};

export type RawStatusCommandOptions = {
  cwd?: string;
  scope?: string;
  platform?: string;
  verbose?: boolean;
  json?: boolean;
};

export type RawDiagnoseCommandOptions = RawStatusCommandOptions & {
  deep?: boolean;
};

export interface DiagnoseCommandOptions extends StatusCommandOptions {
  deep?: boolean;
}

export type RawRepairCommandOptions = RawCommandOptions & {
  adoptExisting?: boolean;
  dependencyIndex?: boolean;
  json?: boolean;
  requestedSkillTrigger?: SkillTriggerPreference | string;
  skillTrigger?: SkillTriggerPreference | string;
  takeoverSharedRuntime?: boolean;
};

export interface RepairCommandOptions extends CommandOptions {
  adoptExisting: boolean;
  dependencyIndex: boolean;
  json?: boolean;
  requestedSkillTrigger?: SkillTriggerPreference;
  takeoverSharedRuntime?: boolean;
}

export type RawUninstallCommandOptions = RawCommandOptions & {
  removeConfig?: boolean;
};

export interface UninstallCommandOptions extends CommandOptions {
  removeConfig: boolean;
}

export type RawCleanupCommandOptions = RawCommandOptions & {
  force?: boolean;
  dependencyIndex?: boolean;
  pruneStale?: string;
  yes?: boolean;
  plan?: boolean;
  removeConfig?: boolean;
  json?: boolean;
};

export interface CleanupCommandOptions extends CommandOptions {
  force: boolean;
  dependencyIndex: boolean;
  pruneStale?: string;
  yes: boolean;
  plan: boolean;
  removeConfig: boolean;
  json?: boolean;
}

export type RawReinstallCommandOptions = RawInstallCommandOptions & {
  json?: boolean;
};

export interface ReinstallCommandOptions extends InstallCommandOptions {
  json?: boolean;
}

export interface RawConfigProjectLayerOptions {
  scope?: string;
  local?: boolean;
}

export const SCRIPT_TIMEOUT_MIN_MS = 1000;
export const SCRIPT_TIMEOUT_MAX_MS = 300000;
export const SCRIPT_TIMEOUT_DEFAULT_MS = 30000;
export const CONFIG_WRITE_DEFAULT_SCOPE: Scope = 'user';
export type ConfigReadResolution = Scope | 'effective';
export const CONFIG_READ_DEFAULT_RESOLUTION: ConfigReadResolution = 'effective';

function renderUnsupportedValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

export function parseScopeValue(scope: unknown): Scope {
  if (scope === 'project' || scope === 'user') {
    return scope;
  }

  throw new Error(`Unsupported scope "${renderUnsupportedValue(scope)}".`);
}

export function parsePlatformValue(platform: unknown): PlatformSelection {
  if (
    platform === 'codex' ||
    platform === 'claude' ||
    platform === 'both' ||
    platform === 'auto'
  ) {
    return platform;
  }

  throw new Error(`Unsupported platform "${renderUnsupportedValue(platform)}".`);
}

export function parseSkillTriggerPreference(
  preference: unknown,
): SkillTriggerPreference {
  if (preference === 'default' || preference === 'manual' || preference === 'auto') {
    return preference;
  }

  throw new Error(
    `Unsupported skill trigger preference "${renderUnsupportedValue(preference)}". Expected one of: default, manual, auto.`,
  );
}

export function parseScriptTimeoutMs(value: unknown): number {
  const rendered = renderUnsupportedValue(value);
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;

  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Unsupported script timeout "${rendered}". Expected an integer between ${SCRIPT_TIMEOUT_MIN_MS} and ${SCRIPT_TIMEOUT_MAX_MS} milliseconds.`,
    );
  }
  if (parsed < SCRIPT_TIMEOUT_MIN_MS || parsed > SCRIPT_TIMEOUT_MAX_MS) {
    throw new Error(
      `Unsupported script timeout "${rendered}". Expected a value between ${SCRIPT_TIMEOUT_MIN_MS} and ${SCRIPT_TIMEOUT_MAX_MS} milliseconds.`,
    );
  }

  return parsed;
}

export function resolveScriptTimeoutMs(
  raw: Pick<RawCommandOptions, 'scriptTimeout' | 'scriptTimeoutMs'>,
): number | undefined {
  const value = raw.scriptTimeoutMs ?? raw.scriptTimeout;
  return value === undefined ? undefined : parseScriptTimeoutMs(value);
}

export function resolveConfigWriteScope(scope: unknown): Scope {
  return scope === undefined ? CONFIG_WRITE_DEFAULT_SCOPE : parseScopeValue(scope);
}

export function resolveConfigReadResolution(scope: unknown): ConfigReadResolution {
  return scope === undefined ? CONFIG_READ_DEFAULT_RESOLUTION : parseScopeValue(scope);
}

export function resolveConfigProjectLayer(
  raw: RawConfigProjectLayerOptions = {},
): 'shared' | 'local' {
  if (!raw.local) {
    return 'shared';
  }
  if (raw.scope !== 'project') {
    throw new Error('`--local` 只能与 `--scope project` 一起使用。');
  }
  return 'local';
}

function resolveCwd(rawCwd: string | undefined, defaultCwd: string | undefined): string {
  return rawCwd ?? defaultCwd ?? process.cwd();
}

export function normalizeCommandOptions(
  raw: RawCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): CommandOptions {
  const scriptTimeoutMs = resolveScriptTimeoutMs(raw);
  return {
    cwd: resolveCwd(raw.cwd, defaults.cwd),
    scope: parseScopeValue(raw.scope ?? defaults.defaultScope ?? 'user'),
    platform: parsePlatformValue(raw.platform ?? defaults.defaultPlatform ?? 'auto'),
    ...(scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs }),
  };
}

function normalizeRequestedSkillTrigger(
  raw: RawInstallCommandOptions,
): SkillTriggerPreference | undefined {
  const value = raw.requestedSkillTrigger ?? raw.skillTrigger;
  return value === undefined ? undefined : parseSkillTriggerPreference(value);
}

export function normalizeInstallCommandOptions(
  raw: RawInstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): InstallCommandOptions {
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    requestedSkillTrigger: normalizeRequestedSkillTrigger(raw),
    takeoverSharedRuntime: raw.takeoverSharedRuntime,
  };
}

export function normalizeUpgradeCommandOptions(
  raw: RawUpgradeCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): UpgradeCommandOptions {
  if (raw.all && raw.takeoverSharedRuntime) {
    throw new Error('`upgrade --all` 不支持 `--takeover-shared-runtime`；请改用单目标 upgrade。');
  }
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    all: raw.all,
    requestedSkillTrigger: normalizeRequestedSkillTrigger(raw),
    takeoverSharedRuntime: raw.takeoverSharedRuntime,
  };
}

function parseStatusPlatformFilter(platform: unknown): PlatformName | 'both' | undefined {
  if (platform === undefined || platform === 'auto') {
    return undefined;
  }

  const parsed = parsePlatformValue(platform);
  return parsed === 'auto' ? undefined : parsed;
}

export function normalizeStatusCommandOptions(
  raw: RawStatusCommandOptions = {},
  defaults: { cwd?: string } = {},
): StatusCommandOptions {
  const scope = raw.scope === undefined ? undefined : parseScopeValue(raw.scope);
  const platform = parseStatusPlatformFilter(raw.platform);
  return {
    cwd: resolveCwd(raw.cwd, defaults.cwd),
    ...(scope === undefined ? {} : { scope }),
    ...(platform === undefined ? {} : { platform }),
    verbose: raw.verbose,
    json: raw.json,
  };
}

export function normalizeDiagnoseCommandOptions(
  raw: RawDiagnoseCommandOptions = {},
  defaults: { cwd?: string } = {},
): DiagnoseCommandOptions {
  return {
    ...normalizeStatusCommandOptions(raw, defaults),
    deep: raw.deep === true,
  };
}

export function normalizeRepairCommandOptions(
  raw: RawRepairCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): RepairCommandOptions {
  if (raw.dependencyIndex && raw.adoptExisting) {
    throw new Error('--dependency-index 不能与 --adopt-existing 一起使用。');
  }
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    adoptExisting: raw.adoptExisting === true,
    dependencyIndex: raw.dependencyIndex === true,
    json: raw.json === true,
    requestedSkillTrigger: normalizeRequestedSkillTrigger(raw),
    takeoverSharedRuntime: raw.takeoverSharedRuntime,
  };
}

export function normalizeUninstallCommandOptions(
  raw: RawUninstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): UninstallCommandOptions {
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    removeConfig: raw.removeConfig === true,
  };
}

export function normalizeCleanupCommandOptions(
  raw: RawCleanupCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): CleanupCommandOptions {
  const normalized = {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    force: raw.force === true,
    dependencyIndex: raw.dependencyIndex === true,
    pruneStale: raw.pruneStale,
    yes: raw.yes === true,
    plan: raw.plan === true,
    removeConfig: raw.removeConfig === true,
    json: raw.json === true,
  } satisfies CleanupCommandOptions;

  if (normalized.dependencyIndex) {
    if (!normalized.pruneStale) {
      throw new Error('cleanup --dependency-index 目前只支持 --prune-stale <token>。');
    }
    if (!normalized.yes) {
      throw new Error('cleanup --dependency-index --prune-stale 需要显式传入 --yes。');
    }
    if (normalized.plan) {
      throw new Error('cleanup --dependency-index --prune-stale 不支持 --plan。');
    }
    if (normalized.removeConfig) {
      throw new Error('cleanup --dependency-index --prune-stale 不支持 --remove-config。');
    }
  } else if (normalized.yes) {
    throw new Error('cleanup --yes 只用于 --dependency-index --prune-stale。');
  }

  if (!normalized.dependencyIndex && (normalized.platform === 'auto' || normalized.platform === 'both')) {
    throw new Error('cleanup 命令需要显式指定单一平台。');
  }

  return normalized;
}

export function normalizeReinstallCommandOptions(
  raw: RawReinstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): ReinstallCommandOptions {
  const normalized = {
    ...normalizeInstallCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    json: raw.json === true,
  } satisfies ReinstallCommandOptions;

  if (normalized.platform === 'auto' || normalized.platform === 'both') {
    throw new Error('reinstall 命令需要显式指定单一平台。');
  }

  return normalized;
}
