import type {
  CatalogGitRefPolicy,
  CatalogSource,
  CatalogSourcesConfig,
} from '../types.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import { catalogSourceErrorCode, sanitizeCatalogSourceError } from '../utils/catalog-public-error.js';
import type {
  CatalogSourceInventoryError,
  CatalogSourceReference,
  CatalogSourceReferenceInventory,
} from '../utils/catalog-source-references.js';
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
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from '../utils/aw-home-mutation-lock.js';
import {
  refreshCatalogSourceGeneration,
  removeCatalogSourceGenerationState,
  type CatalogGenerationServiceRuntime,
} from '../utils/catalog-generation-service.js';

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
  receiptSchemaVersion: 5;
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
  catalogSourcesSchemaVersion: 2;
  primarySourceId: string;
  configDigest: string;
  sources: Array<CatalogSource & { sourceIdentity: string }>;
}

export type CatalogSourceCommandRuntime = {
  beforeRefresh?: () => Promise<void> | void;
  onProgress?: (event: CatalogSourceMutationProgress) => Promise<void> | void;
  awHomeMutationToken?: AwHomeMutationToken;
  generation?: CatalogGenerationServiceRuntime;
};

export type CatalogSourceMutationProgressStage =
  | 'refreshingCatalog'
  | 'catalogReady'
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

export class CatalogManagedSourceProtectedError extends Error {
  readonly code = 'managedSourceProtected';

  constructor(sourceId: string) {
    super(`Catalog source "${sourceId}" is managed by a Catalog Workspace. Use catalog dev commands.`);
    this.name = 'CatalogManagedSourceProtectedError';
  }
}

function assertManagedSourceAccess(options: {
  source: CatalogSource | undefined;
  managedByWorkspaceIdentity?: string;
}): void {
  const owner = options.source?.type === 'path' ? options.source.managedBy : undefined;
  if (!owner) return;
  if (owner.workspaceIdentity !== options.managedByWorkspaceIdentity) {
    throw new CatalogManagedSourceProtectedError(options.source!.id);
  }
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

async function withCatalogSourceMutationLock<T>(options: {
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  action: (locked: {
    env: NodeJS.ProcessEnv;
    runtime: CatalogSourceCommandRuntime;
  }) => Promise<T>;
}): Promise<T> {
  const env = options.env ?? process.env;
  return withAwHomeMutationLock({
    env,
    token: options.runtime?.awHomeMutationToken,
    action: (awHomeMutationToken) => options.action({
      env,
      runtime: { ...options.runtime, awHomeMutationToken },
    }),
  });
}

function primarySourceId(config: CatalogSourcesConfig): string {
  return config.sources.find((source) => source.primary)!.id;
}

function unchangedReceipt(options: {
  command: CatalogSourceMutationReceipt['command'];
  sourceId: string;
  snapshot: Awaited<ReturnType<typeof readCatalogSourcesConfigSnapshot>>;
}): CatalogSourceMutationReceipt {
  return {
    receiptSchemaVersion: 5,
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
  managedByWorkspaceIdentity?: string;
}): Promise<CatalogSourceMutationPreflight> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const request = options.request;
  const sourceId = request.action === 'add' ? request.source.id : request.sourceId;
  const before = snapshot.config.sources.find((source) => source.id === sourceId);
  assertManagedSourceAccess({
    source: request.action === 'add' ? request.source
      : request.action === 'update' || request.action === 'remove' ? before : undefined,
    managedByWorkspaceIdentity: options.managedByWorkspaceIdentity,
  });
  const candidate = request.action === 'add'
    ? await addCatalogSource(snapshot.config, request.source, options.cwd)
    : request.action === 'update'
      ? await updateCatalogSource(snapshot.config, sourceId, request.update, options.cwd)
      : request.action === 'setPrimary'
        ? setPrimaryCatalogSource(snapshot.config, sourceId)
        : removeCatalogSource(snapshot.config, sourceId);
  const after = candidate.sources.find((source) => source.id === sourceId);
  const changedIdentity = Boolean(before && after && await identityChanged(before, after));
  const sourceIdentity = after ? await calculateCatalogSourceIdentity(after) : undefined;
  return {
    sourceId,
    configDigest: snapshot.digest,
    candidateDigest: calculateCatalogSourcesConfigDigest(candidate),
    ...(sourceIdentity ? { sourceIdentity } : {}),
    identityChanged: changedIdentity,
    references: { inventorySchemaVersion: 1, references: [], errors: [] },
  };
}

async function commitCandidate(options: {
  command: CatalogSourceMutationReceipt['command'];
  sourceId: string;
  candidate: CatalogSourcesConfig;
  expectedDigest: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
}): Promise<CatalogSourceMutationReceipt> {
  const written = await replaceCatalogSourcesConfig({
    config: options.candidate,
    expectedDigest: options.expectedDigest,
    env: options.env,
    beforeReplace: async () => {
      await reportMutationProgress(options.runtime, {
        action: options.command === 'catalog:source:add' ? 'add'
          : options.command === 'catalog:source:update' ? 'update'
            : options.command === 'catalog:source:set-primary' ? 'setPrimary' : 'remove',
        stage: 'savingConfig',
      });
    },
  });
  return {
    receiptSchemaVersion: 5,
    command: options.command,
    ok: true,
    changed: true,
    sourceId: options.sourceId,
    primarySourceId: primarySourceId(written.config),
    configDigest: written.digest,
    references: [],
    errors: [],
  };
}

async function refreshCommittedSource(options: {
  receipt: CatalogSourceMutationReceipt;
  config: CatalogSourcesConfig;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  runtime: CatalogSourceCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
}): Promise<CatalogSourceMutationReceipt> {
  await reportMutationProgress(options.runtime, {
    action: options.receipt.command === 'catalog:source:add' ? 'add' : 'update',
    stage: 'refreshingCatalog',
  });
  try {
    await options.runtime.beforeRefresh?.();
    const refreshed = await refreshCatalogSourceGeneration({
      sourceId: options.receipt.sourceId,
      cliVersion: options.cliVersion,
      env: options.env,
      runtime: options.runtime.generation,
      ...(options.awHomeMutationToken
        ? { awHomeMutationToken: options.awHomeMutationToken }
        : {}),
    });
    const pointer = refreshed.candidate ?? refreshed.active;
    if (!pointer) throw new Error('Catalog generation refresh returned no selected generation.');
    const configured = options.config.sources.find((source) => source.id === options.receipt.sourceId)!;
    const source: CatalogSourceEvidence = {
      sourceId: refreshed.sourceId,
      sourceIdentity: refreshed.sourceIdentity,
      requestedRef: pointer.requestedRef,
      resolvedCommit: pointer.resolvedCommit,
      catalogVersion: pointer.catalogVersion,
      channel: pointer.channel,
      freshness: configured.type === 'path' ? 'path' : 'remote',
    };
    await reportMutationProgress(options.runtime, {
      action: options.receipt.command === 'catalog:source:add' ? 'add' : 'update',
      stage: 'catalogReady',
    });
    return { ...options.receipt, source };
  } catch (error) {
    const diagnostic = sanitizeCatalogSourceError(error, options.env);
    return {
      ...options.receipt,
      errors: [{ code: catalogSourceErrorCode(diagnostic), message: diagnostic.message }],
    };
  }
}

export async function listCatalogSources(options: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogSourceListPayload> {
  const snapshot = await readCatalogSourcesConfigSnapshot(options.env);
  return {
    catalogSourcesSchemaVersion: 2,
    primarySourceId: primarySourceId(snapshot.config),
    configDigest: snapshot.digest,
    sources: await Promise.all(snapshot.config.sources.map(async (source) => ({
      ...source,
      sourceIdentity: await calculateCatalogSourceIdentity(source),
    }))),
  };
}

export async function refreshCatalogSourceCommand(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
}): Promise<{ source?: CatalogSourceEvidence; errors: Array<{ code: string; message: string }> }> {
  const env = options.env ?? process.env;
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const configured = snapshot.config.sources.find((source) => source.id === options.sourceId);
  if (!configured) throw new Error(`Catalog source "${options.sourceId}" does not exist.`);
  try {
    await options.runtime?.beforeRefresh?.();
    const refreshed = await refreshCatalogSourceGeneration({
      sourceId: options.sourceId,
      cliVersion: options.cliVersion,
      env,
      runtime: options.runtime?.generation,
      ...(options.runtime?.awHomeMutationToken
        ? { awHomeMutationToken: options.runtime.awHomeMutationToken }
        : {}),
    });
    const pointer = refreshed.candidate ?? refreshed.active;
    if (!pointer) throw new Error('Catalog generation refresh returned no selected generation.');
    return {
      source: {
        sourceId: refreshed.sourceId,
        sourceIdentity: refreshed.sourceIdentity,
        requestedRef: pointer.requestedRef,
        resolvedCommit: pointer.resolvedCommit,
        catalogVersion: pointer.catalogVersion,
        channel: pointer.channel,
        freshness: configured.type === 'path' ? 'path' : 'remote',
      },
      errors: [],
    };
  } catch (error) {
    const diagnostic = sanitizeCatalogSourceError(error, env);
    return { errors: [{ code: catalogSourceErrorCode(diagnostic), message: diagnostic.message }] };
  }
}

export async function addCatalogSourceCommand(options: {
  source: CatalogSource;
  cliVersion: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
  managedByWorkspaceIdentity?: string;
}): Promise<CatalogSourceMutationReceipt> {
  const committed = await withCatalogSourceMutationLock({
    env: options.env,
    runtime: options.runtime,
    action: async ({ env, runtime }) => {
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      assertManagedSourceAccess({
        source: options.source,
        managedByWorkspaceIdentity: options.managedByWorkspaceIdentity,
      });
      if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
        throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
      }
      const candidate = await addCatalogSource(snapshot.config, options.source, options.cwd);
      if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:add', sourceId: options.source.id, snapshot });
      }
      const receipt = await commitCandidate({
        command: 'catalog:source:add',
        sourceId: options.source.id,
        candidate,
        expectedDigest: snapshot.digest,
        env,
        runtime,
      });
      await removeCatalogSourceGenerationState({ sourceId: options.source.id, env });
      return { receipt, candidate, env, runtime };
    },
  });
  if ('receiptSchemaVersion' in committed) return committed;
  return refreshCommittedSource({
    receipt: committed.receipt,
    config: committed.candidate,
    cliVersion: options.cliVersion,
    env: committed.env,
    runtime: committed.runtime,
    ...(options.runtime?.awHomeMutationToken
      ? { awHomeMutationToken: options.runtime.awHomeMutationToken }
      : {}),
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
  managedByWorkspaceIdentity?: string;
}): Promise<CatalogSourceMutationReceipt> {
  const committed = await withCatalogSourceMutationLock({
    env: options.env,
    runtime: options.runtime,
    action: async ({ env, runtime }) => {
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      assertManagedSourceAccess({
        source: snapshot.config.sources.find((source) => source.id === options.sourceId),
        managedByWorkspaceIdentity: options.managedByWorkspaceIdentity,
      });
      if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
        throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
      }
      const candidate = await updateCatalogSource(snapshot.config, options.sourceId, options.update, options.cwd);
      if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:update', sourceId: options.sourceId, snapshot });
      }
      const changedIdentity = await identityChanged(
        snapshot.config.sources.find((source) => source.id === options.sourceId)!,
        candidate.sources.find((source) => source.id === options.sourceId)!,
      );
      const receipt = await commitCandidate({
        command: 'catalog:source:update',
        sourceId: options.sourceId,
        candidate,
        expectedDigest: snapshot.digest,
        env,
        runtime,
      });
      if (changedIdentity) {
        await removeCatalogSourceGenerationState({ sourceId: options.sourceId, env });
      }
      return { receipt, candidate, env, runtime };
    },
  });
  if ('receiptSchemaVersion' in committed) return committed;
  return refreshCommittedSource({
    receipt: committed.receipt,
    config: committed.candidate,
    cliVersion: options.cliVersion,
    env: committed.env,
    runtime: committed.runtime,
    ...(options.runtime?.awHomeMutationToken
      ? { awHomeMutationToken: options.runtime.awHomeMutationToken }
      : {}),
  });
}

export async function setPrimaryCatalogSourceCommand(options: {
  sourceId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
}): Promise<CatalogSourceMutationReceipt> {
  return withCatalogSourceMutationLock({
    env: options.env,
    runtime: options.runtime,
    action: async ({ env, runtime }) => {
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
        env,
        runtime,
      });
    },
  });
}

export async function removeCatalogSourceCommand(options: {
  sourceId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
  expectedConfigDigest?: string;
  managedByWorkspaceIdentity?: string;
  generationStateAlreadyRemoved?: boolean;
}): Promise<CatalogSourceMutationReceipt> {
  return withCatalogSourceMutationLock({
    env: options.env,
    runtime: options.runtime,
    action: async ({ env, runtime }) => {
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      assertManagedSourceAccess({
        source: snapshot.config.sources.find((source) => source.id === options.sourceId),
        managedByWorkspaceIdentity: options.managedByWorkspaceIdentity,
      });
      if (options.expectedConfigDigest && snapshot.digest !== options.expectedConfigDigest) {
        throw new CatalogSourcesConfigConflictError(options.expectedConfigDigest, snapshot.digest);
      }
      const candidate = removeCatalogSource(snapshot.config, options.sourceId);
      if (calculateCatalogSourcesConfigDigest(candidate) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:remove', sourceId: options.sourceId, snapshot });
      }
      const receipt = await commitCandidate({
        command: 'catalog:source:remove',
        sourceId: options.sourceId,
        candidate,
        expectedDigest: snapshot.digest,
        env,
        runtime,
      });
      if (options.generationStateAlreadyRemoved !== true) {
        await removeCatalogSourceGenerationState({ sourceId: options.sourceId, env });
      }
      return receipt;
    },
  });
}

export function explicitRefPolicy(ref: string | undefined, defaultRef: boolean): CatalogGitRefPolicy {
  return defaultRef ? { type: 'cliChannel' } : { type: 'explicit', ref: ref! };
}
