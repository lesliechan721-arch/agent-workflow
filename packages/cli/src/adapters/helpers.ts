import path from 'node:path';

import fs from 'fs-extra';

import type { Scope } from '../types.js';
import { readJsonFileIfExists, writeJsonFile } from '../utils/json.js';

export interface ClaudeSettings {
  extraKnownMarketplaces?: Record<string, string | { source: string }>;
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

export async function readClaudeSettings(settingsPath: string): Promise<ClaudeSettings> {
  return await readJsonFileIfExists<ClaudeSettings>(settingsPath) ?? {};
}

export async function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): Promise<void> {
  await fs.ensureDir(path.dirname(settingsPath));
  await writeJsonFile(settingsPath, settings);
}
