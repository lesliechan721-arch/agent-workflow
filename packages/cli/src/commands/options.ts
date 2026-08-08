import type {
  CatalogChannel,
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  PlatformSelection,
  Scope,
  StatusCommandOptions,
  UpgradeCommandOptions,
} from '../types.js';

export interface NormalizeCommandOptionsDefaults {
  cwd?: string;
  defaultScope?: Scope;
  defaultPlatform?: PlatformSelection;
  requirePlatform?: boolean;
  missingPlatformMessage?: string;
}

export type RawCommandOptions = {
  cwd?: string;
  scope?: string;
  platform?: string;
  catalogChannel?: string;
  catalogVersion?: string;
  scriptTimeout?: string | number;
  scriptTimeoutMs?: string | number;
};

export type RawInstallCommandOptions = RawCommandOptions & {
  adoptExisting?: boolean;
};

export type RawUpgradeCommandOptions = RawCommandOptions & {
  all?: boolean;
};

export type RawStatusCommandOptions = {
  cwd?: string;
  scope?: string;
  platform?: string;
  catalogChannel?: string;
  catalogVersion?: string;
  verbose?: boolean;
  json?: boolean;
};

export type RawDiagnoseCommandOptions = RawStatusCommandOptions & {
  deep?: boolean;
};

export interface DiagnoseCommandOptions extends StatusCommandOptions {
  deep?: boolean;
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
  removeConfig: boolean;
  json?: boolean;
}

export type RawReinstallCommandOptions = RawCommandOptions & {
  json?: boolean;
};

export interface ReinstallCommandOptions extends InstallCommandOptions {
  json?: boolean;
}

export interface RawConfigProjectLayerOptions {
  scope?: string;
  local?: boolean;
}

export interface RawCatalogSelectorOptions {
  catalogChannel?: string;
  catalogVersion?: string;
  channel?: string;
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
  if (platform === 'codex' || platform === 'claude' || platform === 'both') {
    return platform;
  }

  throw new Error(
    `Unsupported platform "${renderUnsupportedValue(platform)}". Expected one of: codex, claude, both.`,
  );
}

export function parseCatalogChannelValue(
  channel: unknown,
): CatalogChannel {
  if (channel === 'latest' || channel === 'beta') {
    return channel;
  }

  throw new Error(
    `Unsupported catalog channel "${renderUnsupportedValue(channel)}". Expected one of: latest, beta.`,
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

export function normalizeCatalogSelectorOptions(
  raw: RawCatalogSelectorOptions = {},
  options: { allowChannelAlias?: boolean } = {},
): Pick<CommandOptions, 'catalogChannel' | 'catalogVersion'> {
  const aliasChannel = options.allowChannelAlias ? raw.channel : undefined;
  if (
    raw.catalogChannel !== undefined &&
    aliasChannel !== undefined &&
    raw.catalogChannel !== aliasChannel
  ) {
    throw new Error('`--channel` 与 `--catalog-channel` 不能指定不同的值。');
  }

  const catalogChannelInput = raw.catalogChannel ?? aliasChannel;
  if (catalogChannelInput !== undefined && raw.catalogVersion !== undefined) {
    throw new Error('`--catalog-channel` 与 `--catalog-version` 互斥，不能同时指定。');
  }

  return {
    ...(catalogChannelInput === undefined
      ? {}
      : { catalogChannel: parseCatalogChannelValue(catalogChannelInput) }),
    ...(raw.catalogVersion === undefined
      ? {}
      : { catalogVersion: String(raw.catalogVersion) }),
  };
}

export function applyCatalogSelectorEnv<
  T extends Pick<CommandOptions, 'catalogChannel' | 'catalogVersion'>,
>(
  env: NodeJS.ProcessEnv,
  options: T,
): NodeJS.ProcessEnv {
  const nextEnv = {
    ...env,
  };

  if (options.catalogChannel === undefined) {
    delete nextEnv.AW_CATALOG_CHANNEL;
  } else {
    nextEnv.AW_CATALOG_CHANNEL = options.catalogChannel;
  }

  if (options.catalogVersion === undefined) {
    delete nextEnv.AW_CATALOG_VERSION;
  } else {
    nextEnv.AW_CATALOG_VERSION = options.catalogVersion;
  }

  return nextEnv;
}

export function normalizeCommandOptions(
  raw: RawCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): CommandOptions {
  const scriptTimeoutMs = resolveScriptTimeoutMs(raw);
  const platformInput = raw.platform ?? defaults.defaultPlatform;
  if (platformInput === undefined && defaults.requirePlatform) {
    throw new Error(
      defaults.missingPlatformMessage ?? '命令需要显式指定 `--platform codex|claude|both`。',
    );
  }
  return {
    cwd: resolveCwd(raw.cwd, defaults.cwd),
    scope: parseScopeValue(raw.scope ?? defaults.defaultScope ?? 'user'),
    platform: parsePlatformValue(platformInput ?? 'both'),
    ...normalizeCatalogSelectorOptions(raw),
    ...(scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs }),
  };
}

export function normalizeInstallCommandOptions(
  raw: RawInstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): InstallCommandOptions {
  if (raw.adoptExisting === true && raw.scope !== 'project') {
    throw new Error('`install --adopt-existing` 只允许 `--scope project`。');
  }
  const normalized = {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      requirePlatform: true,
      missingPlatformMessage: 'install 命令需要显式指定 `--platform codex|claude|both`。',
      ...defaults,
    }),
    adoptExisting: raw.adoptExisting === true,
  };
  if (normalized.adoptExisting && normalized.scope !== 'project') {
    throw new Error('`install --adopt-existing` 只允许 `--scope project`。');
  }
  return normalized;
}

export function normalizeUpgradeCommandOptions(
  raw: RawUpgradeCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): UpgradeCommandOptions {
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      requirePlatform: true,
      missingPlatformMessage: 'upgrade 命令需要显式指定 `--platform codex|claude|both`。',
      ...defaults,
    }),
    all: raw.all,
  };
}

function parseStatusPlatformFilter(platform: unknown): PlatformName | 'both' {
  if (platform === undefined) {
    return 'both';
  }

  return parsePlatformValue(platform);
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
    ...normalizeCatalogSelectorOptions(raw),
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

export function normalizeUninstallCommandOptions(
  raw: RawUninstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): UninstallCommandOptions {
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      requirePlatform: true,
      missingPlatformMessage: 'uninstall 命令需要显式指定 `--platform codex|claude|both`。',
      ...defaults,
    }),
    removeConfig: raw.removeConfig === true,
  };
}

export function normalizeCleanupCommandOptions(
  raw: RawCleanupCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): CleanupCommandOptions {
  if (raw.plan === true) {
    throw new Error('`cleanup --plan` 已移除；请直接运行 `aw cleanup`，或先用 `aw status --verbose` 查看当前状态。');
  }
  if (raw.dependencyIndex && raw.scope !== undefined) {
    throw new Error('cleanup --dependency-index 不接受 `--scope`。');
  }
  if (raw.dependencyIndex && raw.platform !== undefined) {
    throw new Error('cleanup --dependency-index 不接受 `--platform`。');
  }
  const normalized = {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      requirePlatform: raw.dependencyIndex !== true,
      missingPlatformMessage: 'cleanup 命令需要显式指定 `--platform codex|claude|both`。',
      ...(raw.dependencyIndex ? { defaultPlatform: 'both' as const } : {}),
      ...defaults,
    }),
    force: raw.force === true,
    dependencyIndex: raw.dependencyIndex === true,
    pruneStale: raw.pruneStale,
    yes: raw.yes === true,
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
    if (normalized.removeConfig) {
      throw new Error('cleanup --dependency-index --prune-stale 不支持 --remove-config。');
    }
  } else if (normalized.yes) {
    throw new Error('cleanup --yes 只用于 --dependency-index --prune-stale。');
  }

  return normalized;
}

export function normalizeReinstallCommandOptions(
  raw: RawReinstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): ReinstallCommandOptions {
  return {
    ...normalizeInstallCommandOptions(raw, {
      defaultScope: 'user',
      requirePlatform: true,
      missingPlatformMessage: 'reinstall 命令需要显式指定 `--platform codex|claude|both`。',
      ...defaults,
    }),
    json: raw.json === true,
  } satisfies ReinstallCommandOptions;
}
