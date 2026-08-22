import type {
  CatalogGitRefPolicy,
  CatalogSource,
  CatalogSourceResolution,
  CatalogSourcesConfig,
} from '../types.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import {
  addCatalogSource,
  calculateCatalogSourcesConfigDigest,
  CatalogSourcesConfigConflictError,
  readCatalogSourcesConfigSnapshot,
  removeCatalogSource,
  replaceCatalogSourcesConfig,
  setPrimaryCatalogSource,
  updateCatalogSource,
  type CatalogSourceUpdate,
} from '../utils/catalog-sources.js';
import {
  assertCatalogSourceInventoryComplete,
  assertCatalogSourceReferencesSupported,
  inventoryCatalogSourceReferences,
  type CatalogSourceReferenceInventory,
  type CatalogSourceReference,
  type CatalogSourceInventoryError,
} from '../utils/catalog-source-references.js';
import { withResolvedMultiSourceCatalog } from '../utils/multi-source-catalog.js';

export interface CatalogSourceEvidence {
  sourceId: string;
  sourceIdentity: string;
  requestedRef: string;
  resolvedCommit: string;
  catalogVersion: string;
  channel: string;
  freshness: 'remote' | 'cache' | 'path';
}

export interface CatalogSourceMutationReceipt {
  receiptSchemaVersion: 4;
  command: 'catalog:source:add' | 'catalog:source:update' | 'catalog:source:set-primary' | 'catalog:source:remove';
  ok: boolean;
  changed: boolean;
  sourceId: string;
  primarySourceId?: string;
  source?: CatalogSourceEvidence;
  configDigest?: string;
  references: CatalogSourceReferenceInventory['references'];
  errors: Array<{ code: string; message: string }>;
}

export interface CatalogSourceListPayload {
  catalogSourcesSchemaVersion: 1;
  primarySourceId: string;
  configDigest: string;
  sources: Array<CatalogSource & { sourceIdentity: string }>;
}

export type CatalogSourceCommandRuntime = {
  inventoryReferences?: typeof inventoryCatalogSourceReferences;
  afterValidation?: () => Promise<void> | void;
  onProgress?: (event: CatalogSourceMutationProgress) => Promise<void> | void;
};

export type CatalogSourceMutationProgressStage =
  | 'validatingCandidate'
  | 'catalogReady'
  | 'scanningReferences'
  | 'savingConfig';

export interface CatalogSourceMutationProgress {
  action: CatalogSourceMutationRequest['action'];
  stage: CatalogSourceMutationProgressStage;
}

export type CatalogSourceMutationRequest =
  | { action: 'add'; source: CatalogSource }
  | { action: 'update'; sourceId: string; update: CatalogSourceUpdate }
  | { action: 'setPrimary' | 'remove'; sourceId: string };

export interface CatalogSourceMutationPreflight {
  sourceId: string;
  configDigest: string;
  candidateDigest: string;
  sourceIdentity?: string;
  identityChanged: boolean;
  references: CatalogSourcePreflightInventory;
}

export interface CatalogSourcePreflightInventory {
  inventorySchemaVersion: 1;
  references: Array<Omit<CatalogSourceReference, 'location'>>;
  errors: Array<Pick<CatalogSourceInventoryError, 'code' | 'kind' | 'relevance'>>;
}

async function reportMutationProgress(
  runtime: CatalogSourceCommandRuntime | undefined,
  event: CatalogSourceMutationProgress,
): Promise<void> {
  try {
    await runtime?.onProgress?.(event);
  } catch {
    // Progress observers must not change the source transaction result.
  }
}

function stableIdentity(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry !== 'object' || entry === null) return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
}

function projectPreflightInventory(
  inventory: CatalogSourceReferenceInventory,
  references: CatalogSourceReference[],
): CatalogSourcePreflightInventory {
  return {
    inventorySchemaVersion: 1,
    references: references.map(({ location: _location, ...reference }) => reference)
      .sort((left, right) => stableIdentity(left).localeCompare(stableIdentity(right), 'en')),
    errors: inventory.errors.map(({ code, kind, relevance }) => ({ code, kind, relevance }))
      .sort((left, right) => stableIdentity(left).localeCompare(stableIdentity(right), 'en')),
  };
}

function primarySourceId(config: CatalogSourcesConfig): string {
  return config.sources.find((source) => source.primary)!.id;
}

function mutationAction(
  command: CatalogSourceMutationReceipt['command'],
): CatalogSourceMutationRequest['action'] {
  if (command === 'catalog:source:set-primary') return 'setPrimary';
  if (command === 'catalog:source:add') return 'add';
  if (command === 'catalog:source:update') return 'update';
  return 'remove';
}

function unchangedReceipt(options: {
  command: CatalogSourceMutationReceipt['command'];
  sourceId: string;
  snapshot: Awaited<ReturnType<typeof readCatalogSourcesConfigSnapshot>>;
}): CatalogSourceMutationReceipt {
  return {
    receiptSchemaVersion: 4,
    command: options.command,
    ok: true,
    changed: false,
    sourceId: options.sourceId,
    primarySourceId: primarySourceId(options.snapshot.config),
    configDigest: options.snapshot.digest,
    references: [],
    errors: [],
  };
}

function projectEvidence(resolution: CatalogSourceResolution): CatalogSourceEvidence {
  return {
    sourceId: resolution.sourceId,
    sourceIdentity: resolution.sourceIdentity,
    requestedRef: resolution.requestedRef,
    resolvedCommit: resolution.resolvedCommit,
    catalogVersion: resolution.manifest.catalogVersion,
    channel: resolution.manifest.channel,
    freshness: resolution.source,
  };
}

async function validateCandidate(options: {
  config: CatalogSourcesConfig;
  sourceId: string;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogSourceEvidence> {
  const configSnapshot = {
    config: options.config,
    digest: calculateCatalogSourcesConfigDigest(options.config),
    materialized: true,
  };
  return withResolvedMultiSourceCatalog({
    cliVersion: options.cliVersion,
    freshnessPolicy: 'forceRemote',
    sourceIds: [options.sourceId],
    configSnapshot,
    env: options.env,
    consume: (catalog) => {
      const item = catalog.sources[0]!;
      if (item.error) throw item.error;
      return projectEvidence(item.resolution!);
    },
  });
}

async function identityChanged(
  before: CatalogSource,
  after: CatalogSource,
): Promise<boolean> {
  return await calculateCatalogSourceIdentity(before) !== await calculateCatalogSourceIdentity(after);
}

export async function preflightCatalogSourceMutation(options: {
  request: CatalogSourceMutationRequest;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
}): Promise<CatalogSourceMutationPreflight> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const request = options.request;
  const sourceId = request.action === 'add' ? request.source.id : request.sourceId;
  const before = snapshot.config.sources.find((source) => source.id === sourceId);
  const candidate = request.action === 'add'
    ? await addCatalogSource(snapshot.config, request.source, options.cwd)
    : request.action === 'update'
      ? await updateCatalogSource(snapshot.config, sourceId, request.update, options.cwd)
      : request.action === 'setPrimary'
        ? setPrimaryCatalogSource(snapshot.config, sourceId)
        : removeCatalogSource(snapshot.config, sourceId);
  const after = candidate.sources.find((source) => source.id === sourceId);
  const changedIdentity = Boolean(before && after && await identityChanged(before, after));
  const inventory = await (options.runtime?.inventoryReferences
    ?? inventoryCatalogSourceReferences)({
      cwd: options.cwd,
      env,
      includeHistoricalProjects: true,
    });
  assertCatalogSourceInventoryComplete(inventory);
  const relevant = inventory.references.filter((reference) =>
    reference.sourceId === undefined
    || reference.sourceId === sourceId
    || request.action === 'setPrimary'
    || (request.action === 'add' && request.source.primary));
  if (request.action === 'remove' || changedIdentity || request.action === 'setPrimary') {
    assertCatalogSourceReferencesSupported({ ...inventory, references: relevant });
  }
  const sourceIdentity = after ? await calculateCatalogSourceIdentity(after) : undefined;
  return {
    sourceId,
    configDigest: snapshot.digest,
    candidateDigest: calculateCatalogSourcesConfigDigest(candidate),
    ...(sourceIdentity ? { sourceIdentity } : {}),
    identityChanged: changedIdentity,
    references: projectPreflightInventory(inventory, relevant),
  };
}

async function commitCandidate(options: {
  command: CatalogSourceMutationReceipt['command'];
  sourceId: string;
  candidate: CatalogSourcesConfig;
  expectedDigest: string;
  evidence?: CatalogSourceEvidence;
  referencePreflight: boolean;
  allSourceReferences?: boolean;
  matchingSourceIdentity?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
}): Promise<CatalogSourceMutationReceipt> {
  let references: CatalogSourceReferenceInventory['references'] = [];
  const written = await replaceCatalogSourcesConfig({
    config: options.candidate,
    expectedDigest: options.expectedDigest,
    env: options.env,
    beforeReplace: async () => {
      if (options.referencePreflight) {
        await reportMutationProgress(options.runtime, {
          action: mutationAction(options.command),
          stage: 'scanningReferences',
        });
        const inventory = await (options.runtime?.inventoryReferences
          ?? inventoryCatalogSourceReferences)({
            cwd: options.cwd,
            env: options.env,
            includeHistoricalProjects: true,
          });
        assertCatalogSourceInventoryComplete(inventory);
        if (options.matchingSourceIdentity) {
          const matchingSourceReferences = inventory.references.filter((reference) =>
            reference.sourceId === options.sourceId);
          references = matchingSourceReferences;
          if (matchingSourceReferences.some((reference) =>
            reference.sourceIdentity !== options.matchingSourceIdentity)) {
            throw Object.assign(
              new Error(`sourceChanged: ${options.sourceId} live state has a different source identity.`),
              { code: 'sourceChanged' },
            );
          }
        } else {
          const relevant = inventory.references.filter((reference) =>
            reference.sourceId === undefined
            || reference.sourceId === options.sourceId
            || options.command === 'catalog:source:set-primary'
            || options.allSourceReferences === true);
          references = relevant;
          assertCatalogSourceReferencesSupported({ ...inventory, references: relevant });
        }
      }
      await reportMutationProgress(options.runtime, {
        action: mutationAction(options.command),
        stage: 'savingConfig',
      });
    },
  });
  return {
    receiptSchemaVersion: 4,
    command: options.command,
    ok: true,
    changed: true,
    sourceId: options.sourceId,
    primarySourceId: primarySourceId(written.config),
    ...(options.evidence ? { source: options.evidence } : {}),
    configDigest: written.digest,
    references,
    errors: [],
  };
}

export async function listCatalogSources(options: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogSourceListPayload> {
  const snapshot = await readCatalogSourcesConfigSnapshot(options.env);
  return {
    catalogSourcesSchemaVersion: 1,
    primarySourceId: primarySourceId(snapshot.config),
    configDigest: snapshot.digest,
    sources: await Promise.all(snapshot.config.sources.map(async (source) => ({
      ...source,
      sourceIdentity: await calculateCatalogSourceIdentity(source),
    }))),
  };
}

export async function addCatalogSourceCommand(options: {
  source: CatalogSource;
  cliVersion: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
    throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
  }
  const candidate = await addCatalogSource(snapshot.config, options.source, options.cwd);
  if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
    return unchangedReceipt({ command: 'catalog:source:add', sourceId: options.source.id, snapshot });
  }
  await reportMutationProgress(options.runtime, { action: 'add', stage: 'validatingCandidate' });
  const evidence = await validateCandidate({
    config: candidate,
    sourceId: options.source.id,
    cliVersion: options.cliVersion,
    env,
  });
  await reportMutationProgress(options.runtime, { action: 'add', stage: 'catalogReady' });
  await options.runtime?.afterValidation?.();
  return commitCandidate({
    command: 'catalog:source:add',
    sourceId: options.source.id,
    candidate,
    expectedDigest: snapshot.digest,
    evidence,
    referencePreflight: true,
    allSourceReferences: options.source.primary,
    ...(options.source.primary ? {} : { matchingSourceIdentity: evidence.sourceIdentity }),
    cwd: options.cwd,
    env,
    runtime: options.runtime,
  });
}

export async function updateCatalogSourceCommand(options: {
  sourceId: string;
  update: CatalogSourceUpdate;
  cliVersion: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
    throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
  }
  const before = snapshot.config.sources.find((source) => source.id === options.sourceId);
  const candidate = await updateCatalogSource(snapshot.config, options.sourceId, options.update, options.cwd);
  if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
    return unchangedReceipt({ command: 'catalog:source:update', sourceId: options.sourceId, snapshot });
  }
  const after = candidate.sources.find((source) => source.id === options.sourceId)!;
  await reportMutationProgress(options.runtime, { action: 'update', stage: 'validatingCandidate' });
  const evidence = await validateCandidate({
    config: candidate,
    sourceId: options.sourceId,
    cliVersion: options.cliVersion,
    env,
  });
  await reportMutationProgress(options.runtime, { action: 'update', stage: 'catalogReady' });
  await options.runtime?.afterValidation?.();
  return commitCandidate({
    command: 'catalog:source:update',
    sourceId: options.sourceId,
    candidate,
    expectedDigest: snapshot.digest,
    evidence,
    referencePreflight: before ? await identityChanged(before, after) : false,
    cwd: options.cwd,
    env,
    runtime: options.runtime,
  });
}

export async function setPrimaryCatalogSourceCommand(options: {
  sourceId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
    throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
  }
  const candidate = setPrimaryCatalogSource(snapshot.config, options.sourceId);
  if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
    return unchangedReceipt({ command: 'catalog:source:set-primary', sourceId: options.sourceId, snapshot });
  }
  return commitCandidate({
    command: 'catalog:source:set-primary',
    sourceId: options.sourceId,
    candidate,
    expectedDigest: snapshot.digest,
    referencePreflight: true,
    cwd: options.cwd,
    env,
    runtime: options.runtime,
  });
}

export async function removeCatalogSourceCommand(options: {
  sourceId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
    throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
  }
  const candidate = removeCatalogSource(snapshot.config, options.sourceId);
  if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
    return unchangedReceipt({ command: 'catalog:source:remove', sourceId: options.sourceId, snapshot });
  }
  return commitCandidate({
    command: 'catalog:source:remove',
    sourceId: options.sourceId,
    candidate,
    expectedDigest: snapshot.digest,
    referencePreflight: true,
    cwd: options.cwd,
    env,
    runtime: options.runtime,
  });
}

export function explicitRefPolicy(ref: string | undefined, defaultRef: boolean): CatalogGitRefPolicy {
  return defaultRef ? { type: 'cliChannel' } : { type: 'explicit', ref: ref! };
}
