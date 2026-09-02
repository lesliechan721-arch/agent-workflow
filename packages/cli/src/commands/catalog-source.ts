import type {
  CatalogGitRefPolicy,
  CatalogSource,
  CatalogSourcesConfig,
} from '../types.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
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
  isCatalogSourceAutoCheckEnabled,
  type CatalogSourceUpdate,
} from '../utils/catalog-sources.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from '../utils/aw-home-mutation-lock.js';
import { removeCatalogSourceGenerationState } from '../utils/catalog-generation-state.js';

export interface CatalogSourceMutationReceipt {
  receiptSchemaVersion: 5;
  command: 'catalog:source:add' | 'catalog:source:update' | 'catalog:source:set-primary' | 'catalog:source:remove';
  ok: boolean;
  changed: boolean;
  sourceId: string;
  primarySourceId?: string;
  configDigest?: string;
  references: CatalogSourceReferenceInventory['references'];
  errors: Array<{ code: string; message: string }>;
}

export interface CatalogSourceListPayload {
  catalogSourcesSchemaVersion: 2;
  primarySourceId: string;
  configDigest: string;
  sources: Array<CatalogSource & { sourceIdentity: string; autoCheck: boolean }>;
}

export type CatalogSourceCommandRuntime = {
  onProgress?: (event: CatalogSourceMutationProgress) => Promise<void> | void;
  awHomeMutationToken?: AwHomeMutationToken;
};

export type CatalogSourceMutationProgressStage = 'savingConfig';

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
  proposedConfigDigest: string;
  sourceIdentity?: string;
  identityChanged: boolean;
  proposedSource?: CatalogSource;
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

function warnStateCleanupFailure(sourceId: string): void {
  try {
    process.emitWarning(
      `Catalog source "${sourceId}" was committed, but its orphan state cleanup failed.`,
      { code: 'AW_CATALOG_SOURCE_STATE_CLEANUP_FAILED' },
    );
  } catch {
    // Cleanup diagnostics cannot replace the config mutation result.
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
  const proposedConfig = request.action === 'add'
    ? await addCatalogSource(snapshot.config, request.source, options.cwd)
    : request.action === 'update'
      ? await updateCatalogSource(snapshot.config, sourceId, request.update, options.cwd)
      : request.action === 'setPrimary'
        ? setPrimaryCatalogSource(snapshot.config, sourceId)
        : removeCatalogSource(snapshot.config, sourceId);
  const after = proposedConfig.sources.find((source) => source.id === sourceId);
  const changedIdentity = Boolean(before && after && await identityChanged(before, after));
  const sourceIdentity = after ? await calculateCatalogSourceIdentity(after) : undefined;
  return {
    sourceId,
    configDigest: snapshot.digest,
    proposedConfigDigest: calculateCatalogSourcesConfigDigest(proposedConfig),
    ...(sourceIdentity ? { sourceIdentity } : {}),
    identityChanged: changedIdentity,
    ...(after ? { proposedSource: after } : {}),
    references: { inventorySchemaVersion: 1, references: [], errors: [] },
  };
}

async function commitConfig(options: {
  command: CatalogSourceMutationReceipt['command'];
  sourceId: string;
  config: CatalogSourcesConfig;
  expectedDigest: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogSourceCommandRuntime;
}): Promise<CatalogSourceMutationReceipt> {
  const written = await replaceCatalogSourcesConfig({
    config: options.config,
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
      autoCheck: isCatalogSourceAutoCheckEnabled(source),
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
  managedByWorkspaceIdentity?: string;
}): Promise<CatalogSourceMutationReceipt> {
  return withCatalogSourceMutationLock({
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
      if (!snapshot.config.sources.some((source) => source.id === options.source.id)) {
        await removeCatalogSourceGenerationState({ sourceId: options.source.id, env });
      }
      const config = await addCatalogSource(snapshot.config, options.source, options.cwd);
      if (calculateCatalogSourcesConfigDigest(config) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:add', sourceId: options.source.id, snapshot });
      }
      const receipt = await commitConfig({
        command: 'catalog:source:add',
        sourceId: options.source.id,
        config,
        expectedDigest: snapshot.digest,
        env,
        runtime,
      });
      return receipt;
    },
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
  requireIdentityChangeConfirmation?: boolean;
  confirmIdentityChange?: boolean;
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
      const config = await updateCatalogSource(snapshot.config, options.sourceId, options.update, options.cwd);
      const before = snapshot.config.sources.find((source) => source.id === options.sourceId)!;
      const after = config.sources.find((source) => source.id === options.sourceId)!;
      const identityChanged = before.type === 'git' && after.type === 'git'
        ? before.url !== after.url || before.subdir !== after.subdir
        : before.type === 'path' && after.type === 'path'
          ? before.path !== after.path
          : true;
      if (options.requireIdentityChangeConfirmation
        && identityChanged
        && options.confirmIdentityChange !== true) {
        throw new Error('catalogSourceIdentityChangeConfirmationRequired: use --yes to confirm the source URL, path, or subdirectory change.');
      }
      if (calculateCatalogSourcesConfigDigest(config) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:update', sourceId: options.sourceId, snapshot });
      }
      const receipt = await commitConfig({
        command: 'catalog:source:update',
        sourceId: options.sourceId,
        config,
        expectedDigest: snapshot.digest,
        env,
        runtime,
      });
      return receipt;
    },
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
      const config = setPrimaryCatalogSource(snapshot.config, options.sourceId);
      if (calculateCatalogSourcesConfigDigest(config) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:set-primary', sourceId: options.sourceId, snapshot });
      }
      return commitConfig({
        command: 'catalog:source:set-primary',
        sourceId: options.sourceId,
        config,
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
      const config = removeCatalogSource(snapshot.config, options.sourceId);
      if (calculateCatalogSourcesConfigDigest(config) === snapshot.digest) {
        return unchangedReceipt({ command: 'catalog:source:remove', sourceId: options.sourceId, snapshot });
      }
      const receipt = await commitConfig({
        command: 'catalog:source:remove',
        sourceId: options.sourceId,
        config,
        expectedDigest: snapshot.digest,
        env,
        runtime,
      });
      await removeCatalogSourceGenerationState({ sourceId: options.sourceId, env })
        .catch(() => warnStateCleanupFailure(options.sourceId));
      return receipt;
    },
  });
}

export function explicitRefPolicy(ref: string | undefined, defaultRef: boolean): CatalogGitRefPolicy {
  return defaultRef ? { type: 'cliChannel' } : { type: 'explicit', ref: ref! };
}
