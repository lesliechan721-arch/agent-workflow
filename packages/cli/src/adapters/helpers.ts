import path from 'node:path';

import fs from 'fs-extra';

import { readJsonFileIfExists, writeJsonFile } from '../utils/json.js';

interface CodexRegistry {
  marketplaces: Record<string, Record<string, string>>;
  plugins: Record<string, Record<string, string>>;
}

export interface ClaudeSettings {
  extraKnownMarketplaces?: Record<string, string>;
  plugins?: {
    installed?: Record<string, { marketplace: string; version: string; installedAt: string }>;
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
  };
}

interface KnownMarketplaceState {
  marketplaces: Record<
    string,
    {
      source: string;
      materializedAt: string;
      plugins: string[];
    }
  >;
}

function createEmptyCodexRegistry(): CodexRegistry {
  return {
    marketplaces: {},
    plugins: {},
  };
}

function parseKeyValueLine(line: string): [string, string] | null {
  const match = line.match(/^([a-zA-Z0-9_]+)\s*=\s*"([^"]*)"$/);
  if (!match) {
    return null;
  }
  return [match[1], match[2]];
}

export async function readCodexRegistry(configPath: string): Promise<CodexRegistry> {
  if (!(await fs.pathExists(configPath))) {
    return createEmptyCodexRegistry();
  }

  const content = await fs.readFile(configPath, 'utf8');
  const registry = createEmptyCodexRegistry();
  let sectionType: 'marketplaces' | 'plugins' | null = null;
  let sectionName: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const sectionMatch = line.match(/^\[(marketplaces|plugins)\.([^\]]+)\]$/);
    if (sectionMatch) {
      sectionType = sectionMatch[1] as 'marketplaces' | 'plugins';
      sectionName = sectionMatch[2];
      registry[sectionType][sectionName] ??= {};
      continue;
    }

    if (!sectionType || !sectionName) {
      continue;
    }

    const keyValue = parseKeyValueLine(line);
    if (!keyValue) {
      continue;
    }

    const [key, value] = keyValue;
    registry[sectionType][sectionName][key] = value;
  }

  return registry;
}

export async function writeCodexRegistry(
  configPath: string,
  registry: CodexRegistry,
): Promise<void> {
  const lines: string[] = [];

  const marketplaceNames = Object.keys(registry.marketplaces).sort();
  for (const marketplaceName of marketplaceNames) {
    lines.push(`[marketplaces.${marketplaceName}]`);
    for (const [key, value] of Object.entries(registry.marketplaces[marketplaceName])) {
      lines.push(`${key} = "${value}"`);
    }
    lines.push('');
  }

  const pluginNames = Object.keys(registry.plugins).sort();
  for (const pluginName of pluginNames) {
    lines.push(`[plugins.${pluginName}]`);
    for (const [key, value] of Object.entries(registry.plugins[pluginName])) {
      lines.push(`${key} = "${value}"`);
    }
    lines.push('');
  }

  await fs.ensureDir(path.dirname(configPath));
  await fs.writeFile(configPath, `${lines.join('\n').trim()}\n`, 'utf8');
}

export async function readClaudeSettings(settingsPath: string): Promise<ClaudeSettings> {
  const settings = await readJsonFileIfExists<ClaudeSettings>(settingsPath);
  return settings ?? {};
}

export async function writeClaudeSettings(
  settingsPath: string,
  settings: ClaudeSettings,
): Promise<void> {
  await writeJsonFile(settingsPath, settings);
}

export async function readKnownMarketplaceState(
  knownMarketplacesPath: string,
): Promise<KnownMarketplaceState> {
  const state = await readJsonFileIfExists<KnownMarketplaceState>(knownMarketplacesPath);
  return state ?? { marketplaces: {} };
}

export async function writeKnownMarketplaceState(
  knownMarketplacesPath: string,
  state: KnownMarketplaceState,
): Promise<void> {
  await writeJsonFile(knownMarketplacesPath, state);
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}

export async function removeFiles(pathsToRemove: string[]): Promise<void> {
  for (const filePath of pathsToRemove) {
    await removeFileIfExists(filePath);
  }
}

