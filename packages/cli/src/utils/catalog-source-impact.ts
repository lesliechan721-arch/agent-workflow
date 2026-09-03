import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogManifestV7,
  CatalogManifestV7Entry,
  CatalogSourceImpact,
  CatalogSourceImpactCategory,
  CatalogSourceImpactError,
  CatalogSourceImpactReference,
  CatalogSourcePluginChanges,
} from '../types.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import {
  inventoryCatalogSourceReferences,
  type CatalogSourceReference,
  type CatalogSourceReferenceInventory,
} from './catalog-source-references.js';
import { readCatalogGenerationState } from './catalog-generation-state.js';
import { readCatalogStoreEntry } from './catalog-generation-store.js';
import { checkAwCapabilitySupport } from './manifest.js';
import { resolveRepoRootSync } from './state-paths.js';

export type {
  CatalogSourceImpact,
  CatalogSourceImpactCategory,
  CatalogSourceImpactError,
  CatalogSourceImpactReference,
  CatalogSourcePluginChanges,
} from '../types.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyChanges(): CatalogSourcePluginChanges {
  return { added: [], removed: [], changed: [], newlyIncompatible: [], dependencyChanged: [] };
}

function pluginId(sourceId: string, pluginName: string): string {
  return `${sourceId}/${pluginName}`;
}

function category(reference: CatalogSourceReference): CatalogSourceImpactCategory {
  if (reference.kind === 'legacyConfig' || reference.kind === 'namespacedConfig') return 'config';
  if (reference.kind === 'namespacedLifecycle') return 'lifecycle';
  if ((reference.kind === 'legacyMarketplace' || reference.kind === 'namespacedMarketplace')
    && reference.pluginName === undefined) return 'marketplace';
  return 'installation';
}

function publicReference(options: {
  sourceId: string;
  currentProjectKey?: string;
  reference: CatalogSourceReference;
}): CatalogSourceImpactReference {
  const reference = options.reference;
  const projectRecord = reference.scope !== 'project' ? undefined
    : reference.projectKey === undefined || reference.projectKey === null ? 'unknown' as const
      : reference.projectKey === options.currentProjectKey ? 'current' as const : 'historical' as const;
  return {
    category: category(reference),
    sourceId: reference.sourceId ?? options.sourceId,
    ...(reference.pluginName ? { pluginId: pluginId(options.sourceId, reference.pluginName) } : {}),
    ...(reference.platform === 'codex' || reference.platform === 'claude'
      ? { platform: reference.platform } : {}),
    ...(reference.scope === 'user' || reference.scope === 'project' ? { scope: reference.scope } : {}),
    ...(projectRecord ? { projectRecord } : {}),
    ...(reference.marketplaceName ? { marketplaceName: reference.marketplaceName } : {}),
  };
}

function referenceKey(reference: CatalogSourceImpactReference): string {
  return [
    reference.category,
    reference.sourceId,
    reference.pluginId ?? '',
    reference.platform ?? '',
    reference.scope ?? '',
    reference.projectRecord ?? '',
    reference.marketplaceName ?? '',
  ].join('\0');
}

function uniqueReferences(references: readonly CatalogSourceImpactReference[]): CatalogSourceImpactReference[] {
  return [...new Map(references.map((reference) => [referenceKey(reference), reference])).values()]
    .sort((left, right) => compareText(referenceKey(left), referenceKey(right)));
}

function supported(entry: CatalogManifestV7Entry): boolean {
  return checkAwCapabilitySupport(
    entry.requires.aw.capabilities ?? [],
    IMPLEMENTED_AW_CAPABILITIES,
  ).supported;
}

function sameDependencies(
  left: CatalogManifestV7Entry,
  right: CatalogManifestV7Entry,
): boolean {
  return JSON.stringify(left.dependencies) === JSON.stringify(right.dependencies);
}

export function compareCatalogSourcePluginChanges(options: {
  sourceId: string;
  currentManifest: CatalogManifestV7;
  candidateManifest: CatalogManifestV7;
}): CatalogSourcePluginChanges {
  const current = new Map(options.currentManifest.entries.map((entry) => [entry.name, entry]));
  const candidate = new Map(options.candidateManifest.entries.map((entry) => [entry.name, entry]));
  const added = [...candidate.keys()].filter((name) => !current.has(name));
  const removed = [...current.keys()].filter((name) => !candidate.has(name));
  const shared = [...current.keys()].filter((name) => candidate.has(name));
  const qualify = (names: readonly string[]) => names.map((name) => pluginId(options.sourceId, name))
    .sort(compareText);
  return {
    added: qualify(added),
    removed: qualify(removed),
    changed: qualify(shared.filter((name) =>
      current.get(name)!.contentDigest !== candidate.get(name)!.contentDigest)),
    newlyIncompatible: qualify(shared.filter((name) =>
      supported(current.get(name)!) && !supported(candidate.get(name)!))),
    dependencyChanged: qualify(shared.filter((name) =>
      !sameDependencies(current.get(name)!, candidate.get(name)!))),
  };
}

function affectedPluginIds(options: {
  sourceId: string;
  currentManifest: CatalogManifestV7;
  candidateManifest: CatalogManifestV7;
  changes: CatalogSourcePluginChanges;
}): Set<string> {
  const affected = new Set([
    ...options.changes.removed,
    ...options.changes.newlyIncompatible,
    ...options.changes.dependencyChanged,
  ]);
  const reverse = new Map<string, Set<string>>();
  for (const manifest of [options.currentManifest, options.candidateManifest]) {
    for (const entry of manifest.entries) {
      const consumer = pluginId(options.sourceId, entry.name);
      for (const dependencyName of entry.dependencies) {
        const dependency = pluginId(options.sourceId, dependencyName);
        const consumers = reverse.get(dependency) ?? new Set<string>();
        consumers.add(consumer);
        reverse.set(dependency, consumers);
      }
    }
  }
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    for (const consumer of reverse.get(queue[index]!) ?? []) {
      if (affected.has(consumer)) continue;
      affected.add(consumer);
      queue.push(consumer);
    }
  }
  return affected;
}

function sourceReferences(options: {
  sourceId: string;
  sourcePrimary: boolean;
  inventory: CatalogSourceReferenceInventory;
}): CatalogSourceReference[] {
  return options.inventory.references.filter((reference) =>
    reference.sourceId === options.sourceId
    || (options.sourcePrimary && reference.sourceId === undefined
      && reference.kind.startsWith('legacy')));
}

export async function inspectCatalogSourceImpact(options: {
  sourceId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  sourcePrimary?: boolean;
  mode: 'none' | 'remove' | 'identityChange' | 'generation';
  currentManifest?: CatalogManifestV7;
  candidateManifest?: CatalogManifestV7;
  inventory?: CatalogSourceReferenceInventory;
}): Promise<CatalogSourceImpact> {
  const env = options.env ?? process.env;
  const inventory = options.inventory ?? await inventoryCatalogSourceReferences({
    cwd: options.cwd,
    env,
    includePlatformHistoricalProjects: true,
  });
  const internalReferences = sourceReferences({
    sourceId: options.sourceId,
    sourcePrimary: options.sourcePrimary === true,
    inventory,
  });
  const projectRoot = resolveRepoRootSync(options.cwd);
  const currentProjectKey = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const references = uniqueReferences(internalReferences.map((reference) => publicReference({
    sourceId: options.sourceId,
    currentProjectKey,
    reference,
  })));
  const errors: CatalogSourceImpactError[] = inventory.errors
    .filter((error) => error.relevance.global
      || error.relevance.sourceId === undefined
      || error.relevance.sourceId === options.sourceId)
    .map((error) => ({
    code: 'stateInventoryFailed',
    kind: error.kind,
    relevance: error.relevance.global
      ? { global: true }
      : {
          global: false,
          ...(error.relevance.sourceId ? { sourceId: error.relevance.sourceId } : {}),
          ...(error.relevance.pluginName ? { pluginName: error.relevance.pluginName } : {}),
          ...(error.relevance.platform ? { platform: error.relevance.platform } : {}),
          ...(error.relevance.scope ? { scope: error.relevance.scope } : {}),
        },
    }));
  let currentManifest = options.currentManifest;
  let currentManifestUnavailable = false;
  if (options.mode === 'generation' && !currentManifest) {
    try {
      const active = (await readCatalogGenerationState(env)).sources[options.sourceId]?.active;
      if (active) {
        try {
          currentManifest = (await readCatalogStoreEntry({
            logicalIdentity: active.logicalIdentity,
            snapshotDigest: active.snapshotDigest,
            env,
          })).manifest;
        } catch {
          currentManifestUnavailable = true;
        }
      }
    } catch {
      currentManifestUnavailable = true;
    }
  }
  let changes = emptyChanges();
  let affectedReferences: CatalogSourceImpactReference[] = [];
  if (options.mode === 'remove' || options.mode === 'identityChange') {
    affectedReferences = references;
  } else if (options.mode === 'generation') {
    if (!options.candidateManifest) {
      errors.push({ code: 'catalogManifestUnavailable', kind: 'candidateManifestRead' });
    } else if (currentManifest) {
      changes = compareCatalogSourcePluginChanges({
        sourceId: options.sourceId,
        currentManifest,
        candidateManifest: options.candidateManifest,
      });
      const affected = affectedPluginIds({
        sourceId: options.sourceId,
        currentManifest,
        candidateManifest: options.candidateManifest,
        changes,
      });
      affectedReferences = references.filter((reference) =>
        reference.pluginId !== undefined && affected.has(reference.pluginId));
    } else if (currentManifestUnavailable
      || references.some((reference) => reference.pluginId !== undefined)) {
      errors.push({ code: 'catalogManifestUnavailable', kind: 'currentManifestRead' });
    }
  }
  const uniqueErrors = [...new Map(errors.map((error) => [
    `${error.code}\0${error.kind}\0${JSON.stringify(error.relevance ?? null)}`,
    error,
  ])).values()];
  return {
    impactSchemaVersion: 1,
    sourceId: options.sourceId,
    inventoryComplete: uniqueErrors.length === 0,
    references,
    affectedReferences: uniqueReferences(affectedReferences),
    changes,
    errors: uniqueErrors,
  };
}

export function catalogSourceImpactRequiresConfirmation(impact: CatalogSourceImpact): boolean {
  return !impact.inventoryComplete || impact.affectedReferences.length > 0;
}

export function calculateCatalogSourceImpactDigest(impact: CatalogSourceImpact): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(impact)).digest('hex')}`;
}
