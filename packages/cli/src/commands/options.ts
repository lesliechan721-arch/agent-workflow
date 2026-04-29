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

function resolveCwd(rawCwd: string | undefined, defaultCwd: string | undefined): string {
  return rawCwd ?? defaultCwd ?? process.cwd();
}

export function normalizeCommandOptions(
  raw: RawCommandOptions = {},
  defaults: NormalizeCommandOptionsDefaults = {},
): CommandOptions {
  return {
    cwd: resolveCwd(raw.cwd, defaults.cwd),
    scope: parseScopeValue(raw.scope ?? defaults.defaultScope ?? 'user'),
    platform: parsePlatformValue(raw.platform ?? defaults.defaultPlatform ?? 'auto'),
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
