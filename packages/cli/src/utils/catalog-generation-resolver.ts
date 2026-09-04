import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogGenerationActiveV1,
  CatalogGenerationSet,
  CatalogGenerationSetSource,
  CatalogSource,
  PluginMeta,
  SourceIdentity,
} from '../types.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { projectCatalogCapabilityCompatibility } from './catalog-capability-projection.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import {
  readCatalogGenerationControlSnapshot,
  type CatalogGenerationControlSnapshot,
} from './catalog-generation-control-snapshot.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import {
  createCatalogStoreKey,
  readCatalogSnapshotLogicalIdentity,
  readCatalogStoreMetadata,
  readCatalogStoreEntry,
  resolveCatalogStoreLocation,
  type CatalogStoreEntry,
} from './catalog-generation-store.js';
import { calculateCatalogSourceConfigFingerprint } from './catalog-source-identity.js';
import { validatePluginManifest } from './manifest.js';
import { validateCatalogManifestV7 } from './catalog-manifest-v7.js';
import { calculateFileDigest } from './bundle-integrity.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
} from './catalog-digests.js';
import { CURRENT_CATALOG_MANIFEST_FILE } from '../constants.js';

export interface ResolvedActiveCatalogGeneration extends CatalogGenerationSetSource {
  active: CatalogGenerationActiveV1;
}

export interface ResolvedActiveCatalogPluginShallow {
  sourceId: string;
  sourceIdentity: string;
  logicalIdentity: string;
  catalogVersion: string;
  snapshotPath: string;
  plugin: PluginMeta;
}

export async function readValidatedCatalogGenerationStoreEntry(options: {
  logicalIdentity: string;
  snapshotDigest: string;
  env: NodeJS.ProcessEnv;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
}): Promise<CatalogStoreEntry> {
  const storeKey = createCatalogStoreKey(options.logicalIdentity, options.snapshotDigest);
  const cached = options.validatedStoreEntries?.get(storeKey);
  if (cached) return cached;
  let pending = options.validatingStoreEntries?.get(storeKey);
  if (!pending) {
    pending = readCatalogStoreEntry({
      logicalIdentity: options.logicalIdentity,
      snapshotDigest: options.snapshotDigest,
      env: options.env,
    });
    options.validatingStoreEntries?.set(storeKey, pending);
  }
  try {
    const entry = await pending;
    options.validatedStoreEntries?.set(storeKey, entry);
    return entry;
  } finally {
    if (options.validatingStoreEntries?.get(storeKey) === pending) {
      options.validatingStoreEntries.delete(storeKey);
    }
  }
}

async function assertRegularDirectory(value: string, label: string): Promise<void> {
  const stats = await fs.lstat(value);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory.`);
  }
}

async function assertRegularFile(value: string, label: string): Promise<void> {
  const stats = await fs.lstat(value);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

async function resolveFromState(options: {
  source: CatalogSource;
  sourceIdentity: SourceIdentity;
  active?: CatalogGenerationActiveV1;
  env: NodeJS.ProcessEnv;
  requireCompatibility: boolean;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
}): Promise<ResolvedActiveCatalogGeneration> {
  if (!options.active) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationUnavailable',
      sourceId: options.source.id,
      message: `Catalog source "${options.source.id}" has no Active snapshot. Run aw catalog source sync ${options.source.id}.`,
    });
  }
  const fingerprint = calculateCatalogSourceConfigFingerprint(options.source);
  if (
    options.active.sourceIdentity !== options.sourceIdentity
    || options.active.sourceConfigFingerprint !== fingerprint
  ) throw new CatalogGenerationError({
    code: 'catalogGenerationIdentityMismatch',
    sourceId: options.source.id,
    message: `Active Catalog snapshot for source "${options.source.id}" does not match the current source configuration. Run aw catalog source sync ${options.source.id}.`,
  });
  const storeKey = createCatalogStoreKey(options.active.logicalIdentity, options.active.snapshotDigest);
  const entry = await readValidatedCatalogGenerationStoreEntry({
    logicalIdentity: options.active.logicalIdentity,
    snapshotDigest: options.active.snapshotDigest,
    env: options.env,
    validatedStoreEntries: options.validatedStoreEntries,
    validatingStoreEntries: options.validatingStoreEntries,
  });
  if (entry.metadata.manifestDigest !== options.active.manifestDigest) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      sourceId: options.source.id,
      message: `Active Catalog snapshot for source "${options.source.id}" does not match store metadata. Run aw catalog source sync ${options.source.id}.`,
    });
  }
  const compatibility = projectCatalogCapabilityCompatibility(
    entry.metadata.requiredAwCapabilities,
  );
  if (options.requireCompatibility && compatibility.state === 'unsupported') {
    throw new CatalogProviderCompatibilityError({
      sourceId: options.source.id,
      requiredCapabilities: compatibility.requiredCapabilities,
      missingCapabilities: compatibility.missingCapabilities,
      availableCapabilities: IMPLEMENTED_AW_CAPABILITIES,
    });
  }
  return {
    sourceId: options.source.id,
    sourceConfigFingerprint: options.active.sourceConfigFingerprint,
    sourceIdentity: options.active.sourceIdentity,
    logicalIdentity: options.active.logicalIdentity,
    catalogVersion: entry.metadata.catalogVersion,
    resolvedCommit: options.active.resolvedCommit,
    manifestDigest: options.active.manifestDigest,
    snapshotDigest: options.active.snapshotDigest,
    storeKey,
    snapshotPath: entry.snapshotRoot,
    manifest: entry.manifest,
    active: options.active,
  };
}

interface ResolveActiveCatalogGenerationOptions {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
}

async function resolveActiveCatalogGenerationWithPolicy(
  options: ResolveActiveCatalogGenerationOptions,
  requireCompatibility: boolean,
): Promise<ResolvedActiveCatalogGeneration> {
  const env = options.env ?? process.env;
  const control = await readCatalogGenerationControlSnapshot({ env });
  const source = control.configSnapshot.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing',
    sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  return resolveFromState({
    source,
    sourceIdentity: control.sourceIdentities[source.id]!,
    active: control.generationState.sources[source.id]?.active,
    env,
    requireCompatibility,
    validatedStoreEntries: options.validatedStoreEntries,
    validatingStoreEntries: options.validatingStoreEntries,
  });
}

export async function resolveActiveCatalogGeneration(
  options: ResolveActiveCatalogGenerationOptions,
): Promise<ResolvedActiveCatalogGeneration> {
  return resolveActiveCatalogGenerationWithPolicy(options, true);
}

/** @internal Complete Active evidence for freshness checks before consumer compatibility gating. */
export async function resolveValidatedActiveCatalogGeneration(
  options: ResolveActiveCatalogGenerationOptions,
): Promise<ResolvedActiveCatalogGeneration> {
  return resolveActiveCatalogGenerationWithPolicy(options, false);
}

export async function resolveActiveCatalogPluginShallow(options: {
  sourceId: string;
  pluginName: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedActiveCatalogPluginShallow> {
  const env = options.env ?? process.env;
  const control = await readCatalogGenerationControlSnapshot({ env });
  const source = control.configSnapshot.config.sources.find((entry) => entry.id === options.sourceId);
  const active = control.generationState.sources[options.sourceId]?.active;
  if (!source || !active) throw new Error('Selected Catalog source has no Active snapshot.');
  const sourceIdentity = control.sourceIdentities[source.id]!;
  if (active.sourceIdentity !== sourceIdentity
    || active.sourceConfigFingerprint !== calculateCatalogSourceConfigFingerprint(source)) {
    throw new Error('Active Catalog snapshot does not match the selected source configuration.');
  }

  const location = resolveCatalogStoreLocation({
    logicalIdentity: active.logicalIdentity,
    snapshotDigest: active.snapshotDigest,
    env,
  });
  const metadata = await readCatalogStoreMetadata({
    logicalIdentity: active.logicalIdentity,
    snapshotDigest: active.snapshotDigest,
    env,
  });
  if (metadata.manifestDigest !== active.manifestDigest
    || metadata.logicalIdentity !== active.logicalIdentity
    || metadata.snapshotDigest !== active.snapshotDigest) {
    throw new Error('Active Catalog snapshot does not match its content-addressed store metadata.');
  }
  await assertRegularDirectory(location.storeRootDir, 'Catalog store root');
  await assertRegularDirectory(location.logicalIdentityDirectory, 'Catalog logical identity store');
  await assertRegularDirectory(location.entryDir, 'Catalog store entry');
  await assertRegularDirectory(location.snapshotRoot, 'Catalog snapshot');
  if (await readCatalogSnapshotLogicalIdentity(location.snapshotRoot) !== active.logicalIdentity) {
    throw new Error('Catalog snapshot logical identity does not match Active state.');
  }
  const manifestPath = path.join(location.snapshotRoot, CURRENT_CATALOG_MANIFEST_FILE);
  await assertRegularFile(manifestPath, 'Catalog manifest');
  if (await calculateFileDigest(manifestPath) !== active.manifestDigest) {
    throw new Error('Catalog manifest does not match Active state.');
  }
  const rawManifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  const rawEntries = Array.isArray(rawManifest.entries) ? rawManifest.entries : [];
  const rawEntry = rawEntries.find((entry) => entry !== null
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as Record<string, unknown>).name === options.pluginName);
  if (!rawEntry) throw new Error('Selected plugin is absent from the local Active snapshot.');
  const manifest = validateCatalogManifestV7({ ...rawManifest, entries: [rawEntry] });
  if (manifest.catalogVersion !== metadata.catalogVersion
    || manifest.channel !== metadata.channel
    || JSON.stringify(manifest.requires.aw.capabilities ?? [])
      !== JSON.stringify(metadata.requiredAwCapabilities)) {
    throw new Error('Catalog manifest does not match store metadata.');
  }
  const entry = manifest.entries[0]!;
  const pluginsRoot = path.join(location.snapshotRoot, 'plugins');
  const pluginRoot = path.resolve(pluginsRoot, entry.name);
  if (path.dirname(pluginRoot) !== path.resolve(pluginsRoot)) {
    throw new Error('Selected plugin path escapes the Catalog snapshot.');
  }
  await assertRegularDirectory(pluginsRoot, 'Catalog plugins root');
  await assertRegularDirectory(pluginRoot, 'Selected plugin bundle');
  const pluginManifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  await assertRegularFile(pluginManifestPath, 'Selected plugin manifest');
  const rawPluginManifest = await fs.readJson(pluginManifestPath) as Record<string, unknown>;
  const shallowManifestInput = { ...rawPluginManifest };
  delete shallowManifestInput.dependencies;
  const normalizedPluginManifest = validatePluginManifest(pluginRoot, shallowManifestInput);
  const plugin: PluginMeta = {
    rootDir: pluginRoot,
    manifestPath: pluginManifestPath,
    manifest: normalizedPluginManifest,
  };
  if (plugin.manifest.name !== options.pluginName || plugin.manifest.version !== entry.version) {
    throw new Error('Selected plugin bundle identity does not match its Catalog entry.');
  }
  const artifactDigest = await calculateCatalogEntryArtifactDigest(pluginRoot);
  const contentDigest = await calculateCatalogEntryContentDigest(pluginRoot);
  if (artifactDigest !== entry.artifactDigest
    || contentDigest !== entry.contentDigest) {
    throw new Error('Selected plugin bundle does not match its Catalog entry.');
  }
  return {
    sourceId: source.id,
    sourceIdentity,
    logicalIdentity: active.logicalIdentity,
    catalogVersion: metadata.catalogVersion,
    snapshotPath: location.snapshotRoot,
    plugin,
  };
}

export function calculateCatalogGenerationSetDigest(
  configDigest: string,
  primarySourceId: string,
  sources: CatalogGenerationSetSource[],
): string {
  const identity = sources.map((source) => ({
    sourceId: source.sourceId,
    sourceConfigFingerprint: source.sourceConfigFingerprint,
    logicalIdentity: source.logicalIdentity,
    snapshotDigest: source.snapshotDigest,
    storeKey: source.storeKey,
  }));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    configDigest,
    primarySourceId,
    sources: identity,
  })).digest('hex')}`;
}

export async function resolveCatalogGenerationSet(options: {
  sourceIds?: string[];
  env?: NodeJS.ProcessEnv;
  controlSnapshot?: CatalogGenerationControlSnapshot;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
} = {}): Promise<CatalogGenerationSet> {
  const env = options.env ?? process.env;
  const control = options.controlSnapshot ?? await readCatalogGenerationControlSnapshot({ env });
  const requested = options.sourceIds ? new Set(options.sourceIds) : undefined;
  if (requested) {
    const configured = new Set(control.configSnapshot.config.sources.map((source) => source.id));
    const missing = options.sourceIds!.find((sourceId) => !configured.has(sourceId));
    if (missing) throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing',
      sourceId: missing,
      message: `Catalog source "${missing}" is not configured.`,
    });
  }
  const selected = control.configSnapshot.config.sources.filter(
    (source) => !requested || requested.has(source.id),
  );
  const resolved = await Promise.all(selected.map((source) => resolveFromState({
    source,
    sourceIdentity: control.sourceIdentities[source.id]!,
    active: control.generationState.sources[source.id]?.active,
    env,
    requireCompatibility: true,
    validatedStoreEntries: options.validatedStoreEntries,
    validatingStoreEntries: options.validatingStoreEntries,
  })));
  const sources = resolved.map(({ active: _active, ...source }) => source);
  const primarySourceId = control.configSnapshot.config.sources.find((source) => source.primary)!.id;
  return {
    configDigest: control.configSnapshot.digest,
    primarySourceId,
    sources,
    generationSetDigest: calculateCatalogGenerationSetDigest(
      control.configSnapshot.digest,
      primarySourceId,
      sources,
    ),
  };
}
