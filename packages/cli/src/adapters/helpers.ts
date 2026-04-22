import path from 'node:path';

import fs from 'fs-extra';

import { readJsonFileIfExists, writeJsonFile } from '../utils/json.js';

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
