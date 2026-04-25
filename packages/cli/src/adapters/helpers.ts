import path from 'node:path';

import fs from 'fs-extra';

import type {
  ExternalOwnershipStatus,
  PlatformNativeFallbackEvidence,
  PlatformRuntimeEvidence,
  Scope,
} from '../types.js';
import { readJsonFileIfExists, writeJsonFile } from '../utils/json.js';
import { getMarketplaceManifestPath } from '../utils/paths.js';

export interface CodexRegistry {
  marketplaces: Record<string, Record<string, string>>;
  plugins: Record<string, Record<string, string>>;
}

interface TomlRawBlock {
  kind: 'raw';
  lines: string[];
}

interface TomlSectionBlock {
  kind: 'section';
  header: string;
  bodyLines: string[];
  sectionType: 'marketplaces' | 'plugins' | null;
  sectionName: string | null;
}

type TomlBlock = TomlRawBlock | TomlSectionBlock;

export interface CodexRegistryFile {
  blocks: TomlBlock[];
  registry: CodexRegistry;
}

export interface ClaudeSettings {
  extraKnownMarketplaces?: Record<string, string | { source: string }>;
  plugins?: {
    installed?: Record<
      string,
      ClaudeSettingsInstalledRecord
    >;
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

export interface ClaudeKnownMarketplaceRecord {
  installLocation?: string;
  source?: string;
  materializedAt?: string;
  plugins?: string[];
}

export interface ClaudeKnownMarketplaceState {
  marketplaces: Record<
    string,
    ClaudeKnownMarketplaceRecord
  >;
}

export interface ClaudeInstalledPluginRecord {
  name: string;
  marketplace: string;
  scope: Scope;
  projectPath?: string;
  version?: string;
  installedAt?: string;
  installPath?: string;
  owner?: string;
}

export interface ClaudeInstalledPluginsState {
  plugins: Record<string, ClaudeInstalledPluginRecord[]>;
}

function createEmptyCodexRegistry(): CodexRegistry {
  return {
    marketplaces: {},
    plugins: {},
  };
}

function createEmptyCodexRegistryFile(): CodexRegistryFile {
  return {
    blocks: [],
    registry: createEmptyCodexRegistry(),
  };
}

function parseKeyValueLine(line: string): [string, string] | null {
  const match = line.match(/^([a-zA-Z0-9_]+)\s*=\s*"([^"]*)"$/);
  if (!match) {
    return null;
  }
  return [match[1], match[2]];
}

function createSectionBlock(header: string): TomlSectionBlock {
  const headerMatch = header.trim().match(/^\[([^\]]+)\]$/);
  const sectionMatch = headerMatch?.[1].match(/^(marketplaces|plugins)\.([^\]]+)$/);
  return {
    kind: 'section',
    header,
    bodyLines: [],
    sectionType: sectionMatch
      ? (sectionMatch[1] as 'marketplaces' | 'plugins')
      : null,
    sectionName: sectionMatch?.[2] ?? null,
  };
}

function parseTomlBlocks(content: string): TomlBlock[] {
  if (content === '') {
    return [];
  }

  const blocks: TomlBlock[] = [];
  const rawLines: string[] = [];
  let currentSection: TomlSectionBlock | null = null;

  function flushRaw(): void {
    if (rawLines.length === 0) {
      return;
    }
    blocks.push({ kind: 'raw', lines: [...rawLines] });
    rawLines.length = 0;
  }

  function flushSection(): void {
    if (!currentSection) {
      return;
    }
    blocks.push(currentSection);
    currentSection = null;
  }

  for (const line of content.split(/\r?\n/)) {
    if (line.trim().match(/^\[[^\]]+\]$/)) {
      flushSection();
      flushRaw();
      currentSection = createSectionBlock(line);
      continue;
    }

    if (currentSection) {
      currentSection.bodyLines.push(line);
    } else {
      rawLines.push(line);
    }
  }

  flushSection();
  flushRaw();
  return blocks;
}

function parseSectionValues(bodyLines: string[]): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const keyValue = parseKeyValueLine(line);
    if (!keyValue) {
      continue;
    }

    const [key, value] = keyValue;
    values[key] = value;
  }

  return values;
}

function buildCodexRegistry(blocks: TomlBlock[]): CodexRegistry {
  const registry = createEmptyCodexRegistry();

  for (const block of blocks) {
    if (
      block.kind !== 'section' ||
      block.sectionType === null ||
      block.sectionName === null
    ) {
      continue;
    }

    registry[block.sectionType][block.sectionName] = parseSectionValues(block.bodyLines);
  }

  return registry;
}

function hasSameEntries(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([key, value]) => right[key] === value);
}

function renderSectionLine(key: string, value: string): string {
  return `${key} = "${value}"`;
}

function renderNewSectionBlock(
  sectionType: 'marketplaces' | 'plugins',
  sectionName: string,
  values: Record<string, string>,
): string[] {
  const lines = [`[${sectionType}.${sectionName}]`];

  for (const [key, value] of Object.entries(values)) {
    lines.push(renderSectionLine(key, value));
  }

  return lines;
}

function renderUpdatedSectionBlock(
  block: TomlSectionBlock,
  values: Record<string, string>,
): string[] {
  const existingValues = parseSectionValues(block.bodyLines);
  if (hasSameEntries(existingValues, values)) {
    return [block.header, ...block.bodyLines];
  }

  const lines = [block.header];
  const pendingEntries = new Map(Object.entries(values));

  for (const rawLine of block.bodyLines) {
    const line = rawLine.trim();
    const keyValue = parseKeyValueLine(line);
    if (!keyValue) {
      lines.push(rawLine);
      continue;
    }

    const [key, currentValue] = keyValue;
    const nextValue = pendingEntries.get(key);
    if (nextValue === undefined) {
      lines.push(rawLine);
      continue;
    }

    lines.push(currentValue === nextValue ? rawLine : renderSectionLine(key, nextValue));
    pendingEntries.delete(key);
  }

  for (const [key, value] of pendingEntries) {
    lines.push(renderSectionLine(key, value));
  }

  return lines;
}

export async function readCodexRegistry(configPath: string): Promise<CodexRegistryFile> {
  if (!(await fs.pathExists(configPath))) {
    return createEmptyCodexRegistryFile();
  }

  const content = await fs.readFile(configPath, 'utf8');
  const blocks = parseTomlBlocks(content);
  return {
    blocks,
    registry: buildCodexRegistry(blocks),
  };
}

export async function writeCodexRegistry(
  configPath: string,
  registryFile: CodexRegistryFile,
): Promise<void> {
  const lines: string[] = [];
  const emittedMarketplaces = new Set<string>();
  const emittedPlugins = new Set<string>();

  for (const block of registryFile.blocks) {
    if (block.kind === 'raw') {
      lines.push(...block.lines);
      continue;
    }

    if (block.sectionType === 'marketplaces' && block.sectionName) {
      const values = registryFile.registry.marketplaces[block.sectionName];
      if (!values) {
        continue;
      }

      lines.push(...renderUpdatedSectionBlock(block, values));
      emittedMarketplaces.add(block.sectionName);
      continue;
    }

    if (block.sectionType === 'plugins' && block.sectionName) {
      const values = registryFile.registry.plugins[block.sectionName];
      if (!values) {
        continue;
      }

      lines.push(...renderUpdatedSectionBlock(block, values));
      emittedPlugins.add(block.sectionName);
      continue;
    }

    lines.push(block.header, ...block.bodyLines);
  }

  const marketplaceNames = Object.keys(registryFile.registry.marketplaces)
    .filter((name) => !emittedMarketplaces.has(name))
    .sort();
  for (const marketplaceName of marketplaceNames) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(
      ...renderNewSectionBlock(
        'marketplaces',
        marketplaceName,
        registryFile.registry.marketplaces[marketplaceName],
      ),
    );
  }

  const pluginNames = Object.keys(registryFile.registry.plugins)
    .filter((name) => !emittedPlugins.has(name))
    .sort();
  for (const pluginName of pluginNames) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('');
    }
    lines.push(
      ...renderNewSectionBlock('plugins', pluginName, registryFile.registry.plugins[pluginName]),
    );
  }

  await fs.ensureDir(path.dirname(configPath));
  const content = lines.join('\n').replace(/\s+$/, '');
  await fs.writeFile(configPath, content === '' ? '' : `${content}\n`, 'utf8');
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
): Promise<ClaudeKnownMarketplaceState> {
  const state = await readJsonFileIfExists<ClaudeKnownMarketplaceState>(knownMarketplacesPath);
  return state ?? { marketplaces: {} };
}

export async function writeKnownMarketplaceState(
  knownMarketplacesPath: string,
  state: ClaudeKnownMarketplaceState,
): Promise<void> {
  await writeJsonFile(knownMarketplacesPath, state);
}

function normalizeInstalledPluginsState(
  rawState: unknown,
): ClaudeInstalledPluginsState {
  if (!rawState || typeof rawState !== 'object' || !('plugins' in rawState)) {
    return { plugins: {} };
  }

  const plugins: ClaudeInstalledPluginsState['plugins'] = {};
  for (const [pluginKey, value] of Object.entries(
    (rawState as { plugins?: Record<string, unknown> }).plugins ?? {},
  )) {
    const records = Array.isArray(value) ? value : [value];
    const normalizedRecords = records
      .filter((record): record is Record<string, unknown> => typeof record === 'object' && record !== null)
      .map((record): ClaudeInstalledPluginRecord => {
        const scope: Scope = record.scope === 'project' ? 'project' : 'user';
        return {
          name: typeof record.name === 'string'
            ? record.name
            : pluginKey.includes('@')
              ? pluginKey.slice(0, pluginKey.indexOf('@'))
              : pluginKey,
          marketplace:
            typeof record.marketplace === 'string'
              ? record.marketplace
              : pluginKey.includes('@')
                ? pluginKey.slice(pluginKey.indexOf('@') + 1)
                : 'aw',
          scope,
          projectPath:
            typeof record.projectPath === 'string' ? record.projectPath : undefined,
          version: typeof record.version === 'string' ? record.version : undefined,
          installedAt:
            typeof record.installedAt === 'string' ? record.installedAt : undefined,
          installPath:
            typeof record.installPath === 'string' ? record.installPath : undefined,
          owner: typeof record.owner === 'string' ? record.owner : undefined,
        };
      });

    if (normalizedRecords.length > 0) {
      plugins[pluginKey] = normalizedRecords;
    }
  }

  return { plugins };
}

export async function readClaudeInstalledPluginsState(
  installedPluginsPath: string,
): Promise<ClaudeInstalledPluginsState> {
  const rawState = await readJsonFileIfExists<unknown>(installedPluginsPath);
  return normalizeInstalledPluginsState(rawState);
}

export async function writeClaudeInstalledPluginsState(
  installedPluginsPath: string,
  state: ClaudeInstalledPluginsState,
): Promise<void> {
  await writeJsonFile(installedPluginsPath, state);
}

export function getClaudeMarketplaceSource(
  settings: ClaudeSettings,
  marketplaceName: string,
): string | undefined {
  const value = settings.extraKnownMarketplaces?.[marketplaceName];
  if (typeof value === 'string') {
    return value;
  }
  return value?.source;
}

export function getClaudeSettingsInstalledRecord(
  settings: ClaudeSettings,
  pluginName: string,
): ClaudeSettingsInstalledRecord | undefined {
  return settings.plugins?.installed?.[pluginName];
}

export function isClaudePluginEnabledForScope(
  settings: ClaudeSettings,
  pluginName: string,
  marketplaceName: string,
  scope: Scope,
  projectPath?: string,
): boolean {
  const record = getClaudeSettingsInstalledRecord(settings, pluginName);
  if (!record || record.marketplace !== marketplaceName) {
    return false;
  }

  if (scope === 'user') {
    return record.scope !== 'project';
  }

  return record.scope === 'project' && record.projectPath === projectPath;
}

export function resolveClaudeInstalledRecordForScope(
  installedPlugins: ClaudeInstalledPluginsState,
  pluginName: string,
  marketplaceName: string,
  scope: Scope,
  projectPath?: string,
): ClaudeInstalledPluginRecord | undefined {
  const pluginKey = `${pluginName}@${marketplaceName}`;
  const records = installedPlugins.plugins[pluginKey] ?? [];
  return records.find((record) =>
    record.scope === scope &&
    (scope === 'user' || record.projectPath === projectPath),
  );
}

export function resolveClaudeKnownMarketplaceInstallLocation(
  record: ClaudeKnownMarketplaceRecord | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }
  return record.installLocation ?? record.source;
}

export async function resolveClaudeActiveLocalBundle(
  pluginName: string,
  marketplaceName: string,
  installLocation: string | undefined,
): Promise<{
  activeLocalBundle: string | null;
  details?: string;
}> {
  if (!installLocation) {
    return {
      activeLocalBundle: null,
      details: 'known_marketplaces.json 中缺少 installLocation。',
    };
  }

  const manifestPath = getMarketplaceManifestPath(installLocation, 'claude');
  if (!(await fs.pathExists(manifestPath))) {
    return {
      activeLocalBundle: null,
      details: `materialized marketplace manifest 缺失: ${manifestPath}`,
    };
  }

  try {
    const manifest = await fs.readJson(manifestPath) as {
      name?: string;
      plugins?: Array<{ name?: string; source?: string }>;
    };
    if (manifest.name !== marketplaceName) {
      return {
        activeLocalBundle: null,
        details: `materialized marketplace 名称不是 ${marketplaceName}。`,
      };
    }

    const entry = manifest.plugins?.find((item) => item.name === pluginName);
    if (!entry?.source) {
      return {
        activeLocalBundle: null,
        details: `materialized marketplace 缺少 ${pluginName} 的 source。`,
      };
    }

    const bundlePath = path.resolve(installLocation, entry.source);
    return {
      activeLocalBundle: await fs.pathExists(bundlePath) ? bundlePath : null,
      details: await fs.pathExists(bundlePath)
        ? undefined
        : `materialized bundle 不存在: ${bundlePath}`,
    };
  } catch (error) {
    return {
      activeLocalBundle: null,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveClaudePlatformRuntimeEvidence(
  settings: ClaudeSettings,
  installedPlugins: ClaudeInstalledPluginsState,
  knownMarketplace: ClaudeKnownMarketplaceRecord | undefined,
  pluginName: string,
  marketplaceName: string,
  scope: Scope,
  projectPath?: string,
): Promise<PlatformRuntimeEvidence & { activeLocalBundle: string | null }> {
  if (!isClaudePluginEnabledForScope(settings, pluginName, marketplaceName, scope, projectPath)) {
    return {
      present: false,
      activeLocalBundle: null,
      details: '当前 scope 的 settings.json 未启用该插件。',
    };
  }

  const fallbackRecord = resolveClaudeInstalledRecordForScope(
    installedPlugins,
    pluginName,
    marketplaceName,
    scope,
    projectPath,
  );
  const installLocation = resolveClaudeKnownMarketplaceInstallLocation(knownMarketplace);
  const bundle = await resolveClaudeActiveLocalBundle(pluginName, marketplaceName, installLocation);
  return {
    present: Boolean(bundle.activeLocalBundle),
    activeLocalBundle: bundle.activeLocalBundle,
    details: bundle.details ?? (fallbackRecord ? undefined : 'installed_plugins.json 未命中当前 scope 记录。'),
  };
}

export function resolveClaudePlatformNativeFallbackEvidence(
  settings: ClaudeSettings,
  installedPlugins: ClaudeInstalledPluginsState,
  pluginName: string,
  marketplaceName: string,
  scope: Scope,
  projectPath?: string,
): PlatformNativeFallbackEvidence {
  if (!isClaudePluginEnabledForScope(settings, pluginName, marketplaceName, scope, projectPath)) {
    return {
      present: false,
      details: '当前 scope 的 settings.json 未启用该插件。',
    };
  }

  const record = resolveClaudeInstalledRecordForScope(
    installedPlugins,
    pluginName,
    marketplaceName,
    scope,
    projectPath,
  );
  return {
    present: Boolean(record),
    details: record
      ? undefined
      : `installed_plugins.json 未命中 ${scope} scope 的 ${pluginName}@${marketplaceName} 记录。`,
  };
}

export function detectClaudeExternalOwnership(
  settings: ClaudeSettings,
  installedPlugins: ClaudeInstalledPluginsState,
  pluginName: string,
  marketplaceName: string,
  scope: Scope,
  projectPath?: string,
): ExternalOwnershipStatus | undefined {
  const settingsRecord = getClaudeSettingsInstalledRecord(settings, pluginName);
  if (settingsRecord && settingsRecord.marketplace !== marketplaceName) {
    return {
      present: true,
      marketplace: settingsRecord.marketplace,
      owner: settingsRecord.owner,
      details: `settings.json 显示 ${pluginName} 由 ${settingsRecord.marketplace} 管理。`,
    };
  }

  const records = Object.values(installedPlugins.plugins)
    .flat()
    .filter((record) =>
      record.name === pluginName &&
      record.marketplace !== marketplaceName &&
      record.scope === scope &&
      (scope === 'user' || record.projectPath === projectPath),
    );
  const record = records[0];
  if (!record) {
    return undefined;
  }

  return {
    present: true,
    marketplace: record.marketplace,
    owner: record.owner,
    details: `installed_plugins.json 显示 ${pluginName} 由 ${record.marketplace} 管理。`,
  };
}

export function detectCodexExternalOwnership(
  pluginStates: Record<string, { enabled?: boolean }>,
  pluginName: string,
  marketplaceName: string,
): ExternalOwnershipStatus | undefined {
  const prefix = `${pluginName}@`;
  const entry = Object.entries(pluginStates).find(
    ([key, value]) =>
      key.startsWith(prefix) &&
      key !== `${pluginName}@${marketplaceName}` &&
      value.enabled === true,
  );
  if (!entry) {
    return undefined;
  }

  const [pluginRef] = entry;
  return {
    present: true,
    marketplace: pluginRef.slice(prefix.length),
    details: `Codex config.toml 中已启用外部同名插件 ${pluginRef}。`,
  };
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
