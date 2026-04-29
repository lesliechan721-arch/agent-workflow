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
  };
}

export function normalizeUpgradeCommandOptions(
  raw: RawUpgradeCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): UpgradeCommandOptions {
  return {
    ...normalizeCommandOptions(raw, {
      defaultScope: 'user',
      defaultPlatform: 'auto',
      ...defaults,
    }),
    all: raw.all,
    requestedSkillTrigger: normalizeRequestedSkillTrigger(raw),
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
