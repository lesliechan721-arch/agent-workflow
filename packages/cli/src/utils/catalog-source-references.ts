import path from 'node:path';

import fs from 'fs-extra';

import { readClaudeSettings } from '../adapters/helpers.js';
import { readCodexConfigFile } from './codex-config.js';
import { readJsonFileIfExists } from './json.js';
import {
  getClaudeHome,
  getCodexHome,
  resolveAwHome,
  resolveRepoRootSync,
} from './state-paths.js';
import {
  OWNED_TEXT_HEADER_PREFIX,
  parseOwnedTextHeader,
  SKILL_OWNER_MARKER,
} from './ownership.js';

export type CatalogSourceReferenceKind =
  | 'legacyOwner'
  | 'legacyConfig'
  | 'legacyLifecycle'
  | 'legacyMarketplace';

export interface CatalogSourceReference {
  kind: CatalogSourceReferenceKind;
  location: string;
  pluginName?: string;
}

export interface CatalogSourceReferenceInventory {
  inventorySchemaVersion: 1;
  references: CatalogSourceReference[];
}

export interface CatalogSourceReferenceCleanupHook {
  cleanup(reference: CatalogSourceReference): Promise<void>;
}

export async function inventoryLegacyOwnerReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const repoRoot = resolveRepoRootSync(options.cwd);
  const references: CatalogSourceReference[] = [];
  for (const root of [
    getCodexHome(env),
    getClaudeHome(env),
    path.join(awHome, 'plugins'),
    path.join(repoRoot, '.agents'),
    path.join(repoRoot, '.codex'),
    path.join(repoRoot, '.claude'),
  ]) {
    references.push(...await findOwnerMarkers(root));
  }
  references.sort((left, right) => left.location.localeCompare(right.location));
  return { inventorySchemaVersion: 1, references };
}

export async function inventoryLegacyConfigReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const repoRoot = resolveRepoRootSync(options.cwd);
  const references: CatalogSourceReference[] = [];
  for (const directory of new Set([
    path.join(awHome, 'plugin-config'),
    path.join(repoRoot, '.agent-workflows', 'plugin-config'),
    path.join(repoRoot, '.agent-workflows', 'plugin-config.local'),
  ])) {
    if (await directoryHasEntries(directory)) {
      references.push({ kind: 'legacyConfig', location: directory });
    }
  }
  references.sort((left, right) => left.location.localeCompare(right.location));
  return { inventorySchemaVersion: 1, references };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function directoryHasEntries(directory: string): Promise<boolean> {
  try {
    return (await fs.readdir(directory)).length > 0;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function findOwnerMarkers(root: string): Promise<CatalogSourceReference[]> {
  if (!await fs.pathExists(root)) return [];
  const output: CatalogSourceReference[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let raw: Record<string, unknown> | null = null;
      if (entry.name === SKILL_OWNER_MARKER) {
        raw = await fs.readJson(entryPath).catch(() => null) as Record<string, unknown> | null;
      } else {
        const stats = await fs.stat(entryPath);
        if (stats.size <= 1024 * 1024) {
          const content = await fs.readFile(entryPath, 'utf8');
          if (content.includes(OWNED_TEXT_HEADER_PREFIX)) {
            const parsed = parseOwnedTextHeader(content);
            raw = parsed ? { schemaVersion: 1, ...parsed.identity } : null;
          }
        }
      }
      if (raw?.schemaVersion === 1 && raw.owner === 'agent-workflows') {
        output.push({
          kind: 'legacyOwner',
          location: entryPath,
          ...(typeof raw.plugin === 'string' ? { pluginName: raw.plugin } : {}),
        });
      }
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasClaudeMarketplaceConsumer(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasClaudeMarketplaceConsumer);
  if (!isRecord(value)) return false;
  if (value.marketplace === 'aw') return true;
  return Object.values(value).some(hasClaudeMarketplaceConsumer);
}

function isAwPluginConsumerKey(value: string): boolean {
  return value.length > '@aw'.length && value.endsWith('@aw');
}

function hasAwPluginConsumerKeys(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some(isAwPluginConsumerKey);
}

async function oldMarketplaceReferences(env: NodeJS.ProcessEnv): Promise<CatalogSourceReference[]> {
  const codexPath = path.join(getCodexHome(env), 'config.toml');
  const claudeSettingsPath = path.join(getClaudeHome(env), 'settings.json');
  const claudeKnownPath = path.join(getClaudeHome(env), 'plugins', 'known_marketplaces.json');
  const claudeInstalledPath = path.join(getClaudeHome(env), 'plugins', 'installed_plugins.json');
  const output: CatalogSourceReference[] = [];

  const codex = await readCodexConfigFile(codexPath);
  if (
    Object.hasOwn(codex.snapshot.marketplaces, 'aw')
    || Object.keys(codex.snapshot.plugins).some(isAwPluginConsumerKey)
  ) {
    output.push({ kind: 'legacyMarketplace', location: codexPath });
  }

  const settings = await readClaudeSettings(claudeSettingsPath);
  if (
    Object.hasOwn(settings.extraKnownMarketplaces ?? {}, 'aw')
    || hasAwPluginConsumerKeys(settings.enabledPlugins)
    || hasAwPluginConsumerKeys(settings.plugins?.installed)
    || hasClaudeMarketplaceConsumer(settings.plugins?.installed)
  ) {
    output.push({ kind: 'legacyMarketplace', location: claudeSettingsPath });
  }

  const known = await readJsonFileIfExists<Record<string, unknown>>(claudeKnownPath);
  if (known && (
    Object.hasOwn(known, 'aw')
    || (isRecord(known.marketplaces) && Object.hasOwn(known.marketplaces, 'aw'))
    || hasClaudeMarketplaceConsumer(known)
  )) {
    output.push({ kind: 'legacyMarketplace', location: claudeKnownPath });
  }
  const installed = await readJsonFileIfExists<Record<string, unknown>>(claudeInstalledPath);
  if (installed && (
    hasAwPluginConsumerKeys(installed.plugins)
    || hasClaudeMarketplaceConsumer(installed.plugins)
  )) {
    output.push({ kind: 'legacyMarketplace', location: claudeInstalledPath });
  }
  return output;
}

export async function inventoryCatalogSourceReferences(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogSourceReferenceInventory> {
  const env = options.env ?? process.env;
  const awHome = resolveAwHome(env);
  const references: CatalogSourceReference[] = [];
  references.push(...(await inventoryLegacyConfigReferences(options)).references);
  const lifecycleRoot = path.join(awHome, 'lifecycle-active');
  if (await directoryHasEntries(lifecycleRoot)) {
    references.push({ kind: 'legacyLifecycle', location: lifecycleRoot });
  }
  references.push(...(await inventoryLegacyOwnerReferences(options)).references);
  references.push(...await oldMarketplaceReferences(env));
  references.sort((left, right) => left.location.localeCompare(right.location));
  return { inventorySchemaVersion: 1, references };
}

export class LegacyCatalogStateUnsupportedError extends Error {
  readonly code = 'legacyStateUnsupported';
  readonly inventory: CatalogSourceReferenceInventory;

  constructor(inventory: CatalogSourceReferenceInventory) {
    super('legacyStateUnsupported: legacy owner, config, lifecycle, or marketplace state must be migrated before catalog source identity changes.');
    this.name = 'LegacyCatalogStateUnsupportedError';
    this.inventory = inventory;
  }
}

export function assertCatalogSourceReferencesSupported(
  inventory: CatalogSourceReferenceInventory,
): void {
  if (inventory.references.length > 0) {
    throw new LegacyCatalogStateUnsupportedError(inventory);
  }
}
