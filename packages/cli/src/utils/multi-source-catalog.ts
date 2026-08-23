import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import type {
  CatalogFreshnessPolicy,
  CatalogSource,
  CatalogSourceId,
  CatalogSourceResolution,
  PluginId,
  PluginMeta,
} from '../types.js';
import {
  CATALOG_SOURCE_ID_PATTERN,
  readCatalogSourcesConfigSnapshot,
  type CatalogSourcesConfigSnapshot,
} from './catalog-sources.js';
import { catalogGitProviderInternal } from './git-catalog-provider.js';
import { ensurePluginName, readPluginManifest } from './manifest.js';
import { catalogPathProviderInternal } from './path-catalog-provider.js';
import { sanitizeCatalogSourceError } from './catalog-public-error.js';
import { canonicalizePathThroughExistingAncestor } from './state-paths.js';
import { validateCatalogSnapshot } from './catalog-snapshot.js';

export interface ParsedPluginId {
  sourceId?: CatalogSourceId;
  pluginName: string;
}

export interface MultiSourceResolutionItem {
  sourceId: CatalogSourceId;
  resolution?: CatalogSourceResolution;
  error?: Error;
}

export interface MultiSourceCatalogResolution {
  sources: MultiSourceResolutionItem[];
  primarySourceId: CatalogSourceId;
  configDigest: string;
  compositeDigest: string;
}

export interface CatalogSourceProviderSet {
  git: typeof catalogGitProviderInternal.resolve;
  path: typeof catalogPathProviderInternal.resolve;
}

export interface ResolveMultiSourceCatalogOptions {
  cliVersion: string;
  freshnessPolicy: CatalogFreshnessPolicy;
  sourceIds?: CatalogSourceId[];
  configSnapshot?: CatalogSourcesConfigSnapshot;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  providers?: CatalogSourceProviderSet;
}

export type ResolveCatalogPluginOptions = Omit<ResolveMultiSourceCatalogOptions, 'sourceIds'> & {
  selector: PluginId;
};

export type WithResolvedMultiSourceCatalogOptions<T> = ResolveMultiSourceCatalogOptions & {
  consume: (resolution: MultiSourceCatalogResolution) => Promise<T> | T;
};

export type WithResolvedCatalogPluginOptions<T> = ResolveCatalogPluginOptions & {
  consume: (resolution: ResolvedCatalogPlugin) => Promise<T> | T;
};

export interface ResolvedCatalogPlugin {
  pluginId: PluginId;
  source: CatalogSourceResolution;
  plugin: PluginMeta;
}

export class CatalogLeaseEscapeError extends Error {
  constructor(message = 'Catalog lease callback returned protected path evidence.') {
    super(message);
    this.name = 'CatalogLeaseEscapeError';
  }
}

type ProtectedLeaseResultKey = 'rootDir' | 'bundleRoot' | 'manifestPath';

export type LeaseSafeResult<T> =
  T extends CatalogSourceResolution | PluginMeta ? never
  : T extends string | number | boolean | null | undefined ? T
  : T extends URL ? URL
  : T extends readonly unknown[] ? { [K in keyof T]: LeaseSafeResult<T[K]> }
  : T extends object ? {
      [K in keyof T]: K extends ProtectedLeaseResultKey ? never : LeaseSafeResult<T[K]>
    }
  : never;

export interface DesiredArtifactSelection {
  pluginId: PluginId;
  targetKey: string;
  artifactKeys: string[];
}

export interface DesiredArtifactCollision {
  targetKey: string;
  artifactKey: string;
  pluginIds: PluginId[];
}

function createDigest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

interface ProtectedCatalogPath {
  absolutePath: string;
  directory: boolean;
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const comparableRoot = process.platform === 'darwin' || process.platform === 'win32'
    ? rootDir.toLowerCase()
    : rootDir;
  const comparableCandidate = process.platform === 'darwin' || process.platform === 'win32'
    ? candidate.toLowerCase()
    : candidate;
  const relative = path.relative(comparableRoot, comparableCandidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function assertLeaseSafeString(
  value: string,
  protectedPaths: ProtectedCatalogPath[],
): Promise<void> {
  let candidate = value;
  if (value.startsWith('file:')) {
    try {
      candidate = fileURLToPath(value);
    } catch {
      return;
    }
  }
  if (!path.isAbsolute(candidate)) return;
  const logical = path.resolve(candidate);
  const canonical = await canonicalizePathThroughExistingAncestor(logical);
  if ([logical, canonical].some((pathEvidence) => protectedPaths.some((entry) => entry.directory
    ? isPathInside(entry.absolutePath, pathEvidence)
    : isPathInside(entry.absolutePath, pathEvidence)))) {
    throw new CatalogLeaseEscapeError();
  }
}

async function projectLeaseSafeResult(
  value: unknown,
  protectedPaths: ProtectedCatalogPath[],
  ancestors = new Set<object>(),
): Promise<unknown> {
  if (
    value === null
    || value === undefined
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) return value;
  if (typeof value === 'string') {
    await assertLeaseSafeString(value, protectedPaths);
    return value;
  }
  if (value instanceof URL) {
    if (value.protocol === 'file:') await assertLeaseSafeString(value.href, protectedPaths);
    return new URL(value.href);
  }
  if (typeof value !== 'object') {
    throw new CatalogLeaseEscapeError('Catalog lease callback must return plain data.');
  }
  if (ancestors.has(value)) {
    throw new CatalogLeaseEscapeError('Catalog lease callback must return acyclic plain data.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new CatalogLeaseEscapeError('Catalog lease callback must return plain data.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output = [];
      for (const entry of value) {
        output.push(await projectLeaseSafeResult(entry, protectedPaths, ancestors));
      }
      return output;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CatalogLeaseEscapeError('Catalog lease callback must return plain data.');
    }
    const output: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) {
        throw new CatalogLeaseEscapeError('Catalog lease callback must return plain data.');
      }
      output[key] = await projectLeaseSafeResult(descriptor.value, protectedPaths, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

async function createProtectedCatalogDirectory(directory: string): Promise<ProtectedCatalogPath[]> {
  const logical = path.resolve(directory);
  const canonical = await canonicalizePathThroughExistingAncestor(logical);
  return [...new Set([logical, canonical])].map((absolutePath) => ({
    absolutePath,
    directory: true,
  }));
}

async function catalogResolutionProtectedPaths(
  resolution: MultiSourceCatalogResolution,
): Promise<ProtectedCatalogPath[]> {
  const output: ProtectedCatalogPath[] = [];
  for (const item of resolution.sources) {
    if (item.resolution) {
      output.push(...await createProtectedCatalogDirectory(item.resolution.rootDir));
    }
  }
  return output;
}

async function materializeCallbackGeneration(
  resolution: MultiSourceCatalogResolution,
  signal?: AbortSignal,
): Promise<{ resolution: MultiSourceCatalogResolution; generationRoot: string }> {
  const generationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-generation-'));
  try {
    const sources: MultiSourceResolutionItem[] = [];
    for (const item of resolution.sources) {
      throwIfAborted(signal);
      if (!item.resolution) {
        sources.push(item);
        continue;
      }
      const rootDir = path.join(generationRoot, item.sourceId);
      await fs.copy(item.resolution.rootDir, rootDir, {
        dereference: false,
        preserveTimestamps: true,
      });
      const validation = await validateCatalogSnapshot(rootDir);
      if (
        validation.manifestDigest !== item.resolution.manifestDigest
        || validation.snapshotDigest !== item.resolution.snapshotDigest
      ) {
        throw new Error(`Catalog source "${item.sourceId}" changed before callback materialization.`);
      }
      sources.push({
        sourceId: item.sourceId,
        resolution: {
          ...item.resolution,
          rootDir,
          manifest: validation.manifest,
        },
      });
    }
    throwIfAborted(signal);
    return { resolution: { ...resolution, sources }, generationRoot };
  } catch (error) {
    await fs.remove(generationRoot).catch(() => undefined);
    throw error;
  }
}

export function parsePluginId(value: string): ParsedPluginId {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new Error('Invalid plugin selector: expected a non-empty canonical plugin ID.');
  }
  const separator = value.indexOf('/');
  if (separator < 0) {
    return { pluginName: ensurePluginName(value, 'plugin selector') };
  }
  if (separator === 0 || separator !== value.lastIndexOf('/')) {
    throw new Error('Invalid plugin selector: expected "plugin" or "source/plugin".');
  }
  const sourceId = value.slice(0, separator);
  if (!CATALOG_SOURCE_ID_PATTERN.test(sourceId)) {
    throw new Error('Invalid plugin selector source ID.');
  }
  return {
    sourceId,
    pluginName: ensurePluginName(value.slice(separator + 1), 'plugin selector name'),
  };
}

export function formatPluginId(value: ParsedPluginId): PluginId {
  const pluginName = ensurePluginName(value.pluginName, 'plugin ID name');
  if (value.sourceId === undefined) return pluginName;
  if (!CATALOG_SOURCE_ID_PATTERN.test(value.sourceId)) {
    throw new Error('Invalid plugin ID source ID.');
  }
  return `${value.sourceId}/${pluginName}`;
}

export function planPluginSelectorSourceIds(
  selectors: readonly ParsedPluginId[],
): CatalogSourceId[] | undefined {
  if (selectors.some((selector) => selector.sourceId === undefined)) return undefined;
  return [...new Set(selectors.map((selector) => selector.sourceId!))];
}

async function mapWithFourWorkers<T, R>(
  inputs: T[],
  mapper: (input: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const output = new Array<R>(inputs.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed) {
      try {
        throwIfAborted(signal);
        const index = next++;
        if (index >= inputs.length) return;
        output[index] = await mapper(inputs[index]!);
        throwIfAborted(signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, () => worker()));
  if (failed) throw failure;
  throwIfAborted(signal);
  return output;
}

async function resolveOneSource(options: {
  source: CatalogSource;
  cliVersion: string;
  freshnessPolicy: CatalogFreshnessPolicy;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  providers: CatalogSourceProviderSet;
}): Promise<MultiSourceResolutionItem> {
  try {
    throwIfAborted(options.signal);
    const resolution = options.source.type === 'git'
      ? await options.providers.git(options.source, options)
      : await options.providers.path(options.source, options);
    throwIfAborted(options.signal);
    return { sourceId: options.source.id, resolution };
  } catch (error) {
    if (options.signal?.aborted) throwIfAborted(options.signal);
    if (isAbortFailure(error, options.signal)) throw error;
    const sensitiveRoots = options.source.type === 'path'
      ? [
          options.source.path,
          path.resolve(options.source.path),
          ...await fs.realpath(options.source.path).then((value) => [value]).catch(() => []),
        ]
      : [];
    return {
      sourceId: options.source.id,
      error: sanitizeCatalogSourceError(error, options.env, sensitiveRoots),
    };
  }
}

async function resolveMultiSourceCatalog(
  options: ResolveMultiSourceCatalogOptions,
): Promise<MultiSourceCatalogResolution> {
  throwIfAborted(options.signal);
  const env = options.env ?? process.env;
  const snapshot = options.configSnapshot ?? await readCatalogSourcesConfigSnapshot(env);
  throwIfAborted(options.signal);
  const configuredById = new Map(snapshot.config.sources.map((source) => [source.id, source]));
  const requestedIds = options.sourceIds
    ? [...new Set(options.sourceIds)]
    : snapshot.config.sources.map((source) => source.id);
  const unknown = requestedIds.find((sourceId) => !configuredById.has(sourceId));
  if (unknown) throw new Error(`Catalog source "${unknown}" does not exist.`);
  const sources = requestedIds
    .map((sourceId) => configuredById.get(sourceId)!)
    .sort((left, right) => compareText(left.id, right.id));
  const providers = options.providers ?? {
    git: catalogGitProviderInternal.resolve,
    path: catalogPathProviderInternal.resolve,
  };
  const resolved = await mapWithFourWorkers(
    sources,
    (source) => resolveOneSource({
      source,
      cliVersion: options.cliVersion,
      freshnessPolicy: options.freshnessPolicy,
      env,
      signal: options.signal,
      providers,
    }),
    options.signal,
  );
  throwIfAborted(options.signal);
  const compositeDigest = createDigest(resolved.map((item) => item.resolution
    ? {
        sourceId: item.sourceId,
        resolvedCommit: item.resolution.resolvedCommit,
        manifestDigest: item.resolution.manifestDigest,
        snapshotDigest: item.resolution.snapshotDigest,
      }
    : { sourceId: item.sourceId, error: true }));
  return {
    sources: resolved,
    primarySourceId: snapshot.config.sources.find((source) => source.primary)!.id,
    configDigest: snapshot.digest,
    compositeDigest,
  };
}

export async function withResolvedMultiSourceCatalog<T>(
  options: WithResolvedMultiSourceCatalogOptions<T>,
): Promise<LeaseSafeResult<T>> {
  const resolved = await resolveMultiSourceCatalog(options);
  const generation = await materializeCallbackGeneration(resolved, options.signal);
  try {
    const protectedPaths = await catalogResolutionProtectedPaths(generation.resolution);
    throwIfAborted(options.signal);
    const result = await options.consume(generation.resolution);
    throwIfAborted(options.signal);
    const projected = await projectLeaseSafeResult(result, protectedPaths) as LeaseSafeResult<T>;
    throwIfAborted(options.signal);
    return projected;
  } finally {
    await fs.remove(generation.generationRoot).catch(() => undefined);
  }
}

function throwSourceErrors(resolution: MultiSourceCatalogResolution): void {
  const failures = resolution.sources.filter((item) => item.error);
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((item) => item.error!),
      `Cannot resolve required catalog sources: ${failures.map((item) => item.sourceId).join(', ')}.`,
    );
  }
}

export async function withResolvedCatalogPlugin<T>(
  options: WithResolvedCatalogPluginOptions<T>,
): Promise<LeaseSafeResult<T>> {
  const selector = parsePluginId(options.selector);
  const sourceIds = planPluginSelectorSourceIds([selector]);
  const resolutionOptions: ResolveMultiSourceCatalogOptions = {
    cliVersion: options.cliVersion,
    freshnessPolicy: options.freshnessPolicy,
    ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.providers ? { providers: options.providers } : {}),
  };
  const resolvedCatalog = await resolveMultiSourceCatalog({
    ...resolutionOptions,
    ...(sourceIds ? { sourceIds } : {}),
  });
  throwSourceErrors(resolvedCatalog);
  const generation = await materializeCallbackGeneration(resolvedCatalog, options.signal);
  try {
    const catalog = generation.resolution;
    const matches = catalog.sources.flatMap((item) => {
      const source = item.resolution!;
      return source.manifest.entries.some((entry) => entry.name === selector.pluginName)
        ? [source]
        : [];
    });
    if (matches.length === 0) {
      throw new Error(`Plugin "${options.selector}" does not exist in the required catalog source set.`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Plugin "${selector.pluginName}" is ambiguous across sources: ${matches.map((match) => match.sourceId).join(', ')}.`,
      );
    }
    const source = matches[0]!;
    const plugin = await readPluginManifest(
      path.join(source.rootDir, 'plugins', selector.pluginName),
      { mode: 'bundle' },
    );
    plugin.sourceId = source.sourceId;
    plugin.sourceIdentity = source.sourceIdentity;
    plugin.pluginId = formatPluginId({ sourceId: source.sourceId, pluginName: selector.pluginName });
    plugin.marketplaceName = source.sourceId === catalog.primarySourceId ? 'aw' : `aw-${source.sourceId}`;
    const resolvedPlugin = { pluginId: plugin.pluginId, source, plugin };
    const protectedPaths = [
      ...await catalogResolutionProtectedPaths(catalog),
      ...await createProtectedCatalogDirectory(plugin.rootDir),
      ...await createProtectedCatalogDirectory(path.dirname(plugin.manifestPath)),
    ];
    throwIfAborted(options.signal);
    const result = await options.consume(resolvedPlugin);
    throwIfAborted(options.signal);
    const projected = await projectLeaseSafeResult(result, protectedPaths) as LeaseSafeResult<T>;
    throwIfAborted(options.signal);
    return projected;
  } finally {
    await fs.remove(generation.generationRoot).catch(() => undefined);
  }
}

export function preflightDesiredArtifactCollisions(
  selections: DesiredArtifactSelection[],
): DesiredArtifactCollision[] {
  const owners = new Map<string, Set<PluginId>>();
  for (const selection of selections) {
    for (const artifactKey of new Set(selection.artifactKeys)) {
      const key = JSON.stringify([selection.targetKey, artifactKey]);
      const plugins = owners.get(key) ?? new Set<PluginId>();
      plugins.add(selection.pluginId);
      owners.set(key, plugins);
    }
  }
  return [...owners.entries()].flatMap(([key, pluginIds]) => {
    if (pluginIds.size < 2) return [];
    const [targetKey, artifactKey] = JSON.parse(key) as [string, string];
    return [{
      targetKey,
      artifactKey,
      pluginIds: [...pluginIds].sort(compareText),
    }];
  }).sort((left, right) =>
    compareText(left.targetKey, right.targetKey)
    || compareText(left.artifactKey, right.artifactKey));
}
