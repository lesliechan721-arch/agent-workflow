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
};

function primarySourceId(config: CatalogSourcesConfig): string {
  return config.sources.find((source) => source.primary)!.id;
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
    beforeReplace: options.referencePreflight
      ? async () => {
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
            return;
          }
          const relevant = inventory.references.filter((reference) =>
            reference.sourceId === undefined
            || reference.sourceId === options.sourceId
            || options.command === 'catalog:source:set-primary'
            || options.allSourceReferences === true);
          references = relevant;
          assertCatalogSourceReferencesSupported({ ...inventory, references: relevant });
        }
      : undefined,
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
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const candidate = await addCatalogSource(snapshot.config, options.source, options.cwd);
  const evidence = await validateCandidate({
    config: candidate,
    sourceId: options.source.id,
    cliVersion: options.cliVersion,
    env,
  });
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
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const before = snapshot.config.sources.find((source) => source.id === options.sourceId);
  const candidate = await updateCatalogSource(snapshot.config, options.sourceId, options.update, options.cwd);
  const after = candidate.sources.find((source) => source.id === options.sourceId)!;
  const evidence = await validateCandidate({
    config: candidate,
    sourceId: options.sourceId,
    cliVersion: options.cliVersion,
    env,
  });
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
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const candidate = setPrimaryCatalogSource(snapshot.config, options.sourceId);
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
}): Promise<CatalogSourceMutationReceipt> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const candidate = removeCatalogSource(snapshot.config, options.sourceId);
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
