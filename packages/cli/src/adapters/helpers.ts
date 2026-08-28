import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { Scope } from '../types.js';
import {
  atomicReplaceConfigFile,
  withConfigFileMutation,
} from '../utils/plugin-config.js';
import { readJsonFileIfExists } from '../utils/json.js';

export interface ClaudeSettings {
  extraKnownMarketplaces?: Record<string, string | {
    source: string | { source: string; path: string };
  }>;
  enabledPlugins?: Record<string, boolean | string[]>;
  plugins?: {
    installed?: Record<string, ClaudeSettingsInstalledRecord>;
  };
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  };
  hooks?: Array<Record<string, unknown>>;
  awGenerated?: {
    permissions?: Record<string, { allow: string[]; ask: string[]; deny: string[] }>;
    hooks?: Record<string, Array<Record<string, unknown>>>;
    manualPermissions?: {
      allow?: string[];
      ask?: string[];
      deny?: string[];
    };
    manualHooks?: Array<Record<string, unknown>>;
  };
}

export interface ClaudeSettingsInstalledRecord {
  marketplace: string;
  version: string;
  installedAt: string;
  scope?: Scope;
  projectPath?: string;
  enabled?: boolean;
  owner?: string;
}

const claudeSettingsBaselines = new WeakMap<ClaudeSettings, ClaudeSettings>();
const DELETE_MERGED_VALUE = Symbol('delete-merged-value');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayIncludes(values: unknown[], candidate: unknown): boolean {
  return values.some((value) => isDeepStrictEqual(value, candidate));
}

function removeBaselineValue(
  baseline: unknown,
  latest: unknown,
): unknown | typeof DELETE_MERGED_VALUE {
  if (latest === undefined) return DELETE_MERGED_VALUE;
  if (!isRecord(baseline) || !isRecord(latest)) {
    return isDeepStrictEqual(baseline, latest)
      ? DELETE_MERGED_VALUE
      : structuredClone(latest);
  }

  const retained = structuredClone(latest);
  for (const [key, baselineValue] of Object.entries(baseline)) {
    if (!Object.hasOwn(retained, key)) continue;
    const next = removeBaselineValue(baselineValue, retained[key]);
    if (next === DELETE_MERGED_VALUE) delete retained[key];
    else retained[key] = next;
  }
  return Object.keys(retained).length === 0 ? DELETE_MERGED_VALUE : retained;
}

function mergeClaudeSettingsChanges(
  baseline: unknown,
  desired: unknown,
  latest: unknown,
): unknown {
  if (isDeepStrictEqual(baseline, desired)) {
    return structuredClone(latest);
  }
  if (Array.isArray(baseline) && Array.isArray(desired) && Array.isArray(latest)) {
    const removed = baseline.filter((entry) => !arrayIncludes(desired, entry));
    const added = desired.filter((entry) => !arrayIncludes(baseline, entry));
    const merged = latest.filter((entry) => !arrayIncludes(removed, entry));
    for (const entry of added) {
      if (!arrayIncludes(merged, entry)) merged.push(structuredClone(entry));
    }
    return merged;
  }
  if (!isRecord(desired) || (!isRecord(baseline) && baseline !== undefined)) {
    return structuredClone(desired);
  }

  const baselineRecord = isRecord(baseline) ? baseline : {};
  const merged: Record<string, unknown> = isRecord(latest)
    ? structuredClone(latest)
    : {};
  for (const key of new Set([...Object.keys(baselineRecord), ...Object.keys(desired)])) {
    if (!Object.hasOwn(desired, key)) {
      const next = removeBaselineValue(baselineRecord[key], merged[key]);
      if (next === DELETE_MERGED_VALUE) delete merged[key];
      else merged[key] = next;
      continue;
    }
    if (!Object.hasOwn(baselineRecord, key)) {
      merged[key] = mergeClaudeSettingsChanges(undefined, desired[key], merged[key]);
      continue;
    }
    merged[key] = mergeClaudeSettingsChanges(
      baselineRecord[key],
      desired[key],
      isRecord(latest) ? latest[key] : undefined,
    );
  }
  return merged;
}

export async function readClaudeSettings(settingsPath: string): Promise<ClaudeSettings> {
  const settings = await readJsonFileIfExists<ClaudeSettings>(settingsPath) ?? {};
  claudeSettingsBaselines.set(settings, structuredClone(settings));
  return settings;
}

export async function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): Promise<void> {
  const baseline = claudeSettingsBaselines.get(settings);
  await withConfigFileMutation({
    filePath: settingsPath,
    allowedRoot: path.dirname(settingsPath),
    action: async () => {
      const latest = await readJsonFileIfExists<ClaudeSettings>(settingsPath) ?? {};
      const next = baseline
        ? mergeClaudeSettingsChanges(baseline, settings, latest) as ClaudeSettings
        : settings;
      await atomicReplaceConfigFile({
        filePath: settingsPath,
        allowedRoot: path.dirname(settingsPath),
        content: `${JSON.stringify(next, null, 2)}\n`,
      });
    },
  });
  claudeSettingsBaselines.set(settings, structuredClone(settings));
}
