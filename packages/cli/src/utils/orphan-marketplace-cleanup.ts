import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  assertCatalogSourceInventoryComplete,
  inventoryCatalogSourceReferences,
} from './catalog-source-references.js';
import { readStrictNamespacedMarketplaceRoot } from './local-marketplace.js';
import { resolveAwHome } from './state-paths.js';

const QUARANTINE_DIRECTORY = 'marketplace-quarantine';
const QUARANTINE_MARKER = '.aw-owner.json';
const QUARANTINE_OWNER = {
  schemaVersion: 1,
  owner: 'agent-workflows',
  kind: 'marketplace-quarantine',
} as const;

function isQuarantineOwner(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === QUARANTINE_OWNER.schemaVersion
    && (value as Record<string, unknown>).owner === QUARANTINE_OWNER.owner
    && (value as Record<string, unknown>).kind === QUARANTINE_OWNER.kind
    && Object.keys(value as Record<string, unknown>).length === 3);
}

async function ensureOwnedQuarantineDirectory(directory: string): Promise<boolean> {
  const existing = await fs.lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) {
    await fs.mkdir(directory);
    await fs.writeJson(path.join(directory, QUARANTINE_MARKER), QUARANTINE_OWNER);
  } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    return false;
  }
  const marker = await fs.readJson(path.join(directory, QUARANTINE_MARKER)).catch(() => null);
  return isQuarantineOwner(marker);
}

async function cleanupPriorQuarantines(options: {
  quarantineRoot: string;
  sourceId: string;
  sourceIdentity: string;
  marketplaceName?: string;
}): Promise<void> {
  for (const entry of await fs.readdir(options.quarantineRoot, { withFileTypes: true })) {
    if (entry.name === QUARANTINE_MARKER || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const container = path.join(options.quarantineRoot, entry.name);
    if (!await ensureOwnedQuarantineDirectory(container)) continue;
    const quarantinedRoot = path.join(container, options.sourceId);
    let strict;
    try {
      strict = await readStrictNamespacedMarketplaceRoot({
        trustedMarketplaceRoot: options.quarantineRoot,
        rootDir: quarantinedRoot,
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        ...(options.marketplaceName ? { marketplaceName: options.marketplaceName } : {}),
      });
    } catch {
      continue;
    }
    if (!strict) continue;
    try {
      await fs.remove(strict.rootDir);
      await fs.remove(container);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      throw new Error(`orphanMarketplaceQuarantined: ${code} at ${QUARANTINE_DIRECTORY}/${entry.name}/${options.sourceId}`);
    }
  }
}

export class MarketplaceGenerationCleanupPendingError extends Error {
  readonly durableMaterializeCommit = true;

  constructor(code: string, location: string, cause: unknown) {
    super(`marketplaceGenerationCleanupPending: ${code} at ${location}`, { cause });
    this.name = 'MarketplaceGenerationCleanupPendingError';
  }
}

export async function commitMarketplaceGenerationBackup(options: {
  backupRoot: string;
  sourceId: string;
  sourceIdentity: string;
  marketplaceName?: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const backup = await fs.lstat(options.backupRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (backup === null) {
    return;
  }
  const quarantineRoot = path.join(resolveAwHome(options.env), QUARANTINE_DIRECTORY);
  if (!await ensureOwnedQuarantineDirectory(quarantineRoot)) {
    throw new Error('marketplaceQuarantineInvalid: quarantine root is not AW-owned.');
  }
  const quarantineContainer = path.join(
    quarantineRoot,
    `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
  );
  await fs.mkdir(quarantineContainer);
  await fs.writeJson(path.join(quarantineContainer, QUARANTINE_MARKER), QUARANTINE_OWNER);
  const quarantinedRoot = path.join(quarantineContainer, options.sourceId);
  try {
    await fs.rename(options.backupRoot, quarantinedRoot);
  } catch (error) {
    await fs.remove(quarantineContainer).catch(() => undefined);
    throw error;
  }
  try {
    await fs.remove(quarantinedRoot);
    await fs.remove(quarantineContainer);
    await cleanupPriorQuarantines({
      quarantineRoot,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      ...(options.marketplaceName ? { marketplaceName: options.marketplaceName } : {}),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new MarketplaceGenerationCleanupPendingError(
      code,
      `${QUARANTINE_DIRECTORY}/${path.basename(quarantineContainer)}/${options.sourceId}`,
      error,
    );
  }
}

export async function cleanupOrphanNamespacedMarketplaceRoot(options: {
  sourceId: string;
  sourceIdentity: string;
  marketplaceName?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const awHome = resolveAwHome(options.env);
  const rootDir = path.join(awHome, 'marketplaces', options.sourceId);
  const marketplacesRoot = path.join(awHome, 'marketplaces');
  const quarantineRoot = path.join(awHome, QUARANTINE_DIRECTORY);
  const quarantineExists = await fs.pathExists(quarantineRoot);
  if (quarantineExists) {
    if (!await ensureOwnedQuarantineDirectory(quarantineRoot)) return false;
    await cleanupPriorQuarantines({
      quarantineRoot,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      ...(options.marketplaceName ? { marketplaceName: options.marketplaceName } : {}),
    });
  }
  let root;
  try {
    root = await readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: marketplacesRoot,
      rootDir,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      ...(options.marketplaceName ? { marketplaceName: options.marketplaceName } : {}),
    });
  } catch {
    return false;
  }
  if (!root) return false;
  const inventory = await inventoryCatalogSourceReferences({
    cwd: options.cwd,
    env: options.env,
    includeHistoricalProjects: true,
    includeOrphanedCodexNativeResidue: true,
  });
  try {
    assertCatalogSourceInventoryComplete(inventory);
  } catch {
    return false;
  }
  const blockingReference = inventory.references.some((reference) =>
    reference.sourceId === options.sourceId
    && !(reference.kind === 'namespacedMarketplace' && reference.pluginName === undefined));
  if (blockingReference) return false;
  try {
    root = await readStrictNamespacedMarketplaceRoot({
      trustedMarketplaceRoot: marketplacesRoot,
      rootDir,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      ...(options.marketplaceName ? { marketplaceName: options.marketplaceName } : {}),
    });
  } catch {
    return false;
  }
  if (!root) return false;
  if (!quarantineExists && !await ensureOwnedQuarantineDirectory(quarantineRoot)) return false;
  const quarantineContainer = path.join(
    quarantineRoot,
    `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`,
  );
  await fs.mkdir(quarantineContainer);
  await fs.writeJson(path.join(quarantineContainer, QUARANTINE_MARKER), QUARANTINE_OWNER);
  const quarantinedRoot = path.join(quarantineContainer, options.sourceId);
  try {
    await fs.rename(root.rootDir, quarantinedRoot);
  } catch (error) {
    await fs.remove(quarantineContainer).catch(() => undefined);
    throw error;
  }
  try {
    await fs.remove(quarantinedRoot);
    await fs.remove(quarantineContainer);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new Error(
      `orphanMarketplaceQuarantined: ${code} at ${QUARANTINE_DIRECTORY}/${path.basename(quarantineContainer)}/${options.sourceId}`,
    );
  }
  return true;
}
