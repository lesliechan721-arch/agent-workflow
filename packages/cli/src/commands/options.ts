import type {
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  PlatformSelection,
  Scope,
  StatusCommandOptions,
} from '../types.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';

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
  scriptTimeout?: string | number;
  scriptTimeoutMs?: string | number;
  allowManagedCodexInstall?: boolean;
  yes?: boolean;
};

export type RawInstallCommandOptions = RawCommandOptions & {
  dependencyScope?: string | string[];
  dependencyScopeOverrides?: InstallCommandOptions['dependencyScopeOverrides'];
};

export type RawStatusCommandOptions = {
  cwd?: string;
  scope?: string;
  platform?: string;
  verbose?: boolean;
  json?: boolean;
};

export type RawUninstallCommandOptions = RawCommandOptions;
export type UninstallCommandOptions = CommandOptions;

export type RawCleanupCommandOptions = RawCommandOptions & {
  json?: boolean;
  force?: boolean;
};

export interface CleanupCommandOptions extends CommandOptions {
  json?: boolean;
  force: boolean;
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


export const SCRIPT_TIMEOUT_MIN_MS = 1000;
export const SCRIPT_TIMEOUT_MAX_MS = 1800000;
export const SCRIPT_TIMEOUT_DEFAULT_MS = 300000;
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

export function parseDependencyScopeOverrides(
  values: string | readonly string[] | undefined,
): NonNullable<InstallCommandOptions['dependencyScopeOverrides']> {
  const inputs = values === undefined ? [] : typeof values === 'string' ? [values] : [...values];
  const byKey = new Map<string, NonNullable<InstallCommandOptions['dependencyScopeOverrides']>[number]>();
  for (const input of inputs) {
    if (input !== input.trim() || input.trim() === '') {
      throw new Error('Invalid dependency scope override: expected <pluginId>[#platform]=<project|user>.');
    }
    const separator = input.lastIndexOf('=');
    if (separator <= 0 || separator !== input.indexOf('=')) {
      throw new Error(`Invalid dependency scope override "${input}".`);
    }
    const selector = input.slice(0, separator);
    const scope = parseScopeValue(input.slice(separator + 1));
    const platformSeparator = selector.lastIndexOf('#');
    const pluginId = platformSeparator < 0 ? selector : selector.slice(0, platformSeparator);
    const parsed = parsePluginId(pluginId);
    if (!parsed.sourceId) {
      throw new Error(`Invalid dependency scope plugin ID "${pluginId}": expected source/plugin.`);
    }
    const canonicalPluginId = `${parsed.sourceId}/${parsed.pluginName}`;
    const parsedPlatform = platformSeparator < 0
      ? undefined
      : parsePlatformValue(selector.slice(platformSeparator + 1));
    if (parsedPlatform === 'both') {
      throw new Error('Invalid dependency scope platform: expected codex or claude.');
    }
    const key = `${canonicalPluginId}\0${parsedPlatform ?? '*'}`;
    const current = byKey.get(key);
    if (current && current.scope !== scope) {
      throw new Error(
        `dependencyScopeOverrideConflict: ${canonicalPluginId}`
        + `${parsedPlatform ? `#${parsedPlatform}` : ''}`,
      );
    }
    byKey.set(key, {
      pluginId: canonicalPluginId,
      ...(parsedPlatform ? { platform: parsedPlatform } : {}),
      scope,
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = `${left.pluginId}\0${left.platform ?? '*'}`;
    const rightKey = `${right.pluginId}\0${right.platform ?? '*'}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeDependencyScopeOverrides(
  overrides: readonly NonNullable<InstallCommandOptions['dependencyScopeOverrides']>[number][],
): NonNullable<InstallCommandOptions['dependencyScopeOverrides']> {
  return parseDependencyScopeOverrides(
    overrides.map((override) =>
      `${override.pluginId}${override.platform ? `#${override.platform}` : ''}=${override.scope}`),
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
    ...(scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs }),
    ...(raw.allowManagedCodexInstall === true ? { allowManagedCodexInstall: true } : {}),
    ...(raw.yes === true ? { yes: true } : {}),
  };
}

export function normalizeInstallCommandOptions(
  raw: RawInstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): InstallCommandOptions {
  const normalized = normalizeCommandOptions(raw, {
    defaultScope: 'user',
    requirePlatform: true,
    missingPlatformMessage: 'install 命令需要显式指定 `--platform codex|claude|both`。',
    ...defaults,
  });
  const dependencyScopeOverrides = [
    ...parseDependencyScopeOverrides(raw.dependencyScope),
    ...normalizeDependencyScopeOverrides(raw.dependencyScopeOverrides ?? []),
  ];
  const normalizedDependencyScopeOverrides = normalizeDependencyScopeOverrides(
    dependencyScopeOverrides,
  );
  return {
    ...normalized,
    ...(normalizedDependencyScopeOverrides.length > 0
      ? { dependencyScopeOverrides: normalizedDependencyScopeOverrides }
      : {}),
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
    verbose: raw.verbose,
    json: raw.json,
  };
}

export function normalizeUninstallCommandOptions(
  raw: RawUninstallCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): UninstallCommandOptions {
  const supported: RawCommandOptions = {
    cwd: raw.cwd,
    scope: raw.scope,
    platform: raw.platform,
    allowManagedCodexInstall: raw.allowManagedCodexInstall,
    yes: raw.yes,
  };
  return {
    ...normalizeCommandOptions(supported, {
      defaultScope: 'user',
      requirePlatform: true,
      missingPlatformMessage: 'uninstall 命令需要显式指定 `--platform codex|claude|both`。',
      ...defaults,
    }),
  };
}

export function normalizeCleanupCommandOptions(
  raw: RawCleanupCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): CleanupCommandOptions {
  if (raw.scope === undefined) {
    throw new Error('cleanup 命令需要显式指定 `--scope project|user`。');
  }
  const supported: RawCommandOptions = {
    cwd: raw.cwd,
    scope: raw.scope,
    platform: raw.platform,
    allowManagedCodexInstall: raw.allowManagedCodexInstall,
    yes: raw.yes,
  };
  const normalized = {
    ...normalizeCommandOptions(supported, {
      defaultScope: 'user',
      requirePlatform: true,
      missingPlatformMessage: 'cleanup 命令需要显式指定 `--platform codex|claude|both`。',
      ...defaults,
    }),
    json: raw.json === true,
    force: raw.force === true,
  } satisfies CleanupCommandOptions;

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
