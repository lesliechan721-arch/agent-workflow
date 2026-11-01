import type {
  CatalogActivationMode,
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateComparison,
  CatalogGenerationCandidateEvidence,
  CatalogGenerationLastSyncV1,
  CatalogGenerationSyncResult,
  CatalogManifestV7,
  CatalogSourceImpact,
  CatalogSource,
  CatalogSourceResolution,
} from '../types.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import { CatalogGenerationError, catalogGenerationErrorCode } from './catalog-generation-error.js';
import {
  createCatalogStoreKey,
  prepareCatalogStoreEntryRepair,
  publishCatalogStoreEntry,
  readCatalogSnapshotLogicalIdentity,
  readCatalogStoreEntry,
  type CatalogStoreEntry,
} from './catalog-generation-store.js';
import {
  readCatalogGenerationState,
  replaceInvalidCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from './catalog-generation-state.js';
export { removeCatalogSourceGenerationState } from './catalog-generation-state.js';
import { validateCatalogSnapshotTransport } from './catalog-snapshot.js';
import { calculateCatalogSourceConfigFingerprint, calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import { readCatalogSourcesConfigSnapshot } from './catalog-sources.js';
import { catalogGitProviderInternal } from './git-catalog-provider.js';
import { catalogPathProviderInternal } from './path-catalog-provider.js';
import {
  readValidatedCatalogGenerationStoreEntry,
  resolveValidatedActiveCatalogGeneration,
} from './catalog-generation-resolver.js';
import { compareStrictSemVer } from './manifest.js';
import {
  projectCatalogCapabilityCompatibility,
  type CatalogCapabilityCompatibility,
} from './catalog-capability-projection.js';
import {
  calculateCatalogSourceImpactDigest,
  catalogSourceImpactRequiresConfirmation,
  inspectCatalogSourceImpact,
} from './catalog-source-impact.js';

export interface CatalogGenerationProviderSet {
  git: typeof catalogGitProviderInternal.resolve;
  path: typeof catalogPathProviderInternal.resolve;
}

export interface CatalogGenerationServiceRuntime {
  providers?: CatalogGenerationProviderSet;
  probeGitRef?: typeof catalogGitProviderInternal.probeRef;
  now?: () => Date;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
  afterCandidateResolved?: () => Promise<void>;
  afterRecoveryStorePublished?: () => Promise<void>;
  afterInactiveStoreRepairPrepared?: () => Promise<void>;
  inspectSourceImpact?: typeof inspectCatalogSourceImpact;
}

export interface CatalogGenerationProbeResult {
  sourceId: string;
  candidate: CatalogGenerationCandidateEvidence;
  manifest: CatalogManifestV7;
}

export type CatalogGenerationFreshnessState =
  | 'current'
  | 'updateAvailable'
  | 'localChangesAvailable'
  | 'versionConflict'
  | 'rollbackDetected'
  | 'incompatible'
  | 'fixed';

export interface CatalogGenerationFreshnessResult {
  sourceId: string;
  state: CatalogGenerationFreshnessState;
  activeVersion?: string;
  activeResolvedCommit?: string;
  candidate?: CatalogGenerationCandidateEvidence;
  errorCode?: 'catalogLogicalIdentityChanged';
  reusableCandidate?: CatalogGenerationReusableCandidate;
}

export interface CatalogGenerationReusableCandidate {
  probe: CatalogGenerationProbeResult;
  sourceConfigFingerprint: string;
  activeStoreKey: string | null;
}

export interface CatalogGenerationStatusEntry {
  sourceId: string;
  configuredSourceIdentity: string;
  active?: CatalogGenerationActiveV1;
  activeReady: boolean;
  configMatchesActive: boolean;
  catalogVersion?: string;
  channel?: 'latest' | 'beta';
  storeKey?: string;
  lastSync?: CatalogGenerationLastSyncV1;
  compatibility: CatalogCapabilityCompatibility | null;
  errorCode?: string;
}

export interface CatalogGenerationStatusPayload {
  catalogGenerationStatusSchemaVersion: 2;
  sources: CatalogGenerationStatusEntry[];
}

type ResolvedCandidate = {
  source: CatalogSource;
  resolution: CatalogSourceResolution;
  candidate: CatalogGenerationCandidateEvidence;
};

type CandidateContinuity = Pick<
  CatalogGenerationCandidateEvidence,
  'sourceConfigFingerprint' | 'sourceIdentity'
> & { resolvedCommit?: string };

const CANDIDATE_FIELDS: ReadonlyArray<keyof CatalogGenerationCandidateEvidence> = [
  'sourceConfigFingerprint', 'sourceIdentity', 'logicalIdentity', 'requestedRef',
  'resolvedCommit', 'catalogVersion', 'channel', 'manifestDigest', 'snapshotDigest',
];

function now(runtime?: CatalogGenerationServiceRuntime): string {
  return (runtime?.now?.() ?? new Date()).toISOString();
}

function warnCleanupFailure(sourceId: string): void {
  try {
    process.emitWarning(`Catalog provider staging cleanup failed for source "${sourceId}".`, {
      code: 'AW_CATALOG_PROVIDER_CLEANUP_FAILED',
    });
  } catch {
    // Cleanup diagnostics cannot replace the operation result.
  }
}

async function resolveProvider(options: {
  source: CatalogSource;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogSourceResolution> {
  const providers = options.runtime?.providers ?? {
    git: catalogGitProviderInternal.resolve,
    path: catalogPathProviderInternal.resolve,
  };
  return providers[options.source.type](options.source as never, {
    cliVersion: options.cliVersion,
    env: options.env,
    signal: options.signal,
  });
}

async function resolveCandidate(options: {
  sourceId: string;
  source?: CatalogSource;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<ResolvedCandidate> {
  const source = options.source ?? (await readCatalogSourcesConfigSnapshot(options.env)).config.sources
    .find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  const resolution = await resolveProvider({ source, ...options });
  try {
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    if (resolution.sourceId !== source.id || resolution.sourceIdentity !== sourceIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch', sourceId: source.id,
        message: `Catalog provider returned mismatched identity for source "${source.id}".`,
      });
    }
    const validation = await validateCatalogSnapshotTransport(resolution.rootDir);
    if (
      validation.manifestDigest !== resolution.manifestDigest
      || validation.snapshotDigest !== resolution.snapshotDigest
    ) throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch', sourceId: source.id,
      message: `Catalog provider returned mismatched snapshot evidence for source "${source.id}".`,
    });
    return {
      source,
      resolution,
      candidate: {
        sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
        sourceIdentity: resolution.sourceIdentity,
        logicalIdentity: await readCatalogSnapshotLogicalIdentity(resolution.rootDir),
        catalogVersion: validation.manifest.catalogVersion,
        channel: validation.manifest.channel,
        requestedRef: resolution.requestedRef,
        resolvedCommit: resolution.resolvedCommit,
        manifestDigest: resolution.manifestDigest,
        snapshotDigest: resolution.snapshotDigest,
      },
    };
  } catch (error) {
    await resolution.cleanup().catch(() => warnCleanupFailure(source.id));
    throw error;
  }
}

export function compareCatalogGenerationCandidates(
  expected: CatalogGenerationCandidateEvidence,
  actual: CatalogGenerationCandidateEvidence,
): CatalogGenerationCandidateComparison {
  const changedFields = CANDIDATE_FIELDS.filter((field) => expected[field] !== actual[field]);
  return { matches: changedFields.length === 0, changedFields };
}

export function compareCatalogGenerationFreshness(options: {
  sourceType: CatalogSource['type'];
  active?: {
    logicalIdentity: string;
    catalogVersion: string;
    snapshotDigest: string;
    resolvedCommit: string;
  };
  candidate: CatalogGenerationCandidateEvidence;
}): Omit<CatalogGenerationFreshnessResult, 'sourceId'> {
  const active = options.active;
  if (!active) {
    return {
      state: options.sourceType === 'path' ? 'localChangesAvailable' : 'updateAvailable',
      candidate: options.candidate,
    };
  }
  const base = {
    activeVersion: active.catalogVersion,
    activeResolvedCommit: active.resolvedCommit,
    candidate: options.candidate,
  };
  if (active.logicalIdentity !== options.candidate.logicalIdentity) {
    return { ...base, state: 'incompatible', errorCode: 'catalogLogicalIdentityChanged' };
  }
  if (active.snapshotDigest === options.candidate.snapshotDigest) {
    return { ...base, state: 'current' };
  }
  if (options.sourceType === 'path') {
    return { ...base, state: 'localChangesAvailable' };
  }
  const relation = compareStrictSemVer(options.candidate.catalogVersion, active.catalogVersion);
  if (relation > 0) return { ...base, state: 'updateAvailable' };
  if (relation < 0) return { ...base, state: 'rollbackDetected' };
  return { ...base, state: 'versionConflict' };
}

function publicEvidence(candidate: CatalogGenerationCandidateEvidence) {
  const { sourceConfigFingerprint: _fingerprint, ...evidence } = candidate;
  return evidence;
}

function sameActive(
  active: CatalogGenerationActiveV1 | undefined,
  next: Omit<CatalogGenerationActiveV1, 'activatedAt'>,
): active is CatalogGenerationActiveV1 {
  return Boolean(active)
    && active!.sourceConfigFingerprint === next.sourceConfigFingerprint
    && active!.sourceIdentity === next.sourceIdentity
    && active!.requestedRef === next.requestedRef
    && active!.resolvedCommit === next.resolvedCommit
    && active!.logicalIdentity === next.logicalIdentity
    && active!.manifestDigest === next.manifestDigest
    && active!.snapshotDigest === next.snapshotDigest;
}

const ACTIVE_FIELDS: ReadonlyArray<keyof CatalogGenerationActiveV1> = [
  'sourceConfigFingerprint', 'sourceIdentity', 'requestedRef', 'resolvedCommit',
  'logicalIdentity', 'manifestDigest', 'snapshotDigest', 'activatedAt',
];

function assertExpectedActive(
  sourceId: string,
  current: CatalogGenerationActiveV1 | undefined,
  expected: CatalogGenerationActiveV1 | null | undefined,
): void {
  if (expected === undefined) return;
  const matches = expected === null
    ? current === undefined
    : current !== undefined && ACTIVE_FIELDS.every((field) => current[field] === expected[field]);
  if (!matches) throw new CatalogGenerationError({
    code: 'catalogGenerationReviewStale',
    sourceId,
    message: `Active Catalog for source "${sourceId}" changed after review. Review it again.`,
  });
}

async function assertCurrentSource(options: {
  sourceId: string;
  candidate: CandidateContinuity;
  env: NodeJS.ProcessEnv;
  expectedConfigDigest?: string;
}): Promise<CatalogSource> {
  const config = await readCatalogSourcesConfigSnapshot(options.env);
  if (options.expectedConfigDigest && config.digest !== options.expectedConfigDigest) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" configuration changed after review. Review it again.`,
    });
  }
  const source = config.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" was removed during sync.`,
  });
  if (
    calculateCatalogSourceConfigFingerprint(source) !== options.candidate.sourceConfigFingerprint
    || await calculateCatalogSourceIdentity(source) !== options.candidate.sourceIdentity
  ) throw new CatalogGenerationError({
    code: 'catalogGenerationIdentityMismatch', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" changed during sync. Run sync again.`,
  });
  return source;
}

async function enforceCatalogActivationCandidatePolicy(options: {
  sourceId: string;
  source: CatalogSource;
  active: CatalogGenerationActiveV1 | undefined;
  candidate: CatalogGenerationCandidateEvidence;
  mode: CatalogActivationMode;
  env: NodeJS.ProcessEnv;
}): Promise<{ preserveActive: boolean }> {
  const configuredChanged = Boolean(options.active)
    && (options.active!.sourceConfigFingerprint !== options.candidate.sourceConfigFingerprint
      || options.active!.sourceIdentity !== options.candidate.sourceIdentity);
  if (options.mode === 'explicitSourceChange' && options.active && !configuredChanged) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" no longer has a verified source configuration change.`,
    });
  }
  if (options.mode === 'exactRepair') {
    if (!options.active
      || options.active.logicalIdentity !== options.candidate.logicalIdentity
      || options.active.snapshotDigest !== options.candidate.snapshotDigest
      || options.active.manifestDigest !== options.candidate.manifestDigest
      || options.active.resolvedCommit !== options.candidate.resolvedCommit) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" no longer matches the exact repair target.`,
      });
    }
    await readCatalogStoreEntry({
      logicalIdentity: options.active.logicalIdentity,
      snapshotDigest: options.active.snapshotDigest,
      env: options.env,
    }).then(() => {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" Active entry is no longer damaged. Review it again.`,
      });
    }).catch((error) => {
      if (error instanceof CatalogGenerationError
        && error.code === 'catalogGenerationReviewStale') throw error;
    });
    return { preserveActive: true };
  }
  if (!options.active) return { preserveActive: false };
  if (options.mode === 'normal'
    && options.active.logicalIdentity !== options.candidate.logicalIdentity) {
    throw new CatalogGenerationError({
      code: 'catalogLogicalIdentityChanged', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" changed logical identity without a verified source configuration change.`,
    });
  }
  if (options.mode === 'replaceDamaged') {
    if (options.active.logicalIdentity !== options.candidate.logicalIdentity && !configuredChanged) {
      throw new CatalogGenerationError({
        code: 'catalogLogicalIdentityChanged', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" changed logical identity without a verified source configuration change.`,
      });
    }
    await readCatalogStoreEntry({
      logicalIdentity: options.active.logicalIdentity,
      snapshotDigest: options.active.snapshotDigest,
      env: options.env,
    }).then(() => {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" Active entry is no longer damaged. Review it again.`,
      });
    }).catch((error) => {
      if (error instanceof CatalogGenerationError
        && error.code === 'catalogGenerationReviewStale') throw error;
    });
    return { preserveActive: false };
  }
  let previous;
  try {
    previous = await readCatalogStoreEntry({
      logicalIdentity: options.active.logicalIdentity,
      snapshotDigest: options.active.snapshotDigest,
      env: options.env,
    });
  } catch (error) {
    throw new CatalogGenerationError({
      code: 'catalogReplaceDamagedRequired', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" Active entry is damaged. Repair it or use --replace-damaged --yes.`,
      cause: error,
    });
  }
  if (options.source.type === 'git'
    && options.active.logicalIdentity === options.candidate.logicalIdentity
    && options.active.snapshotDigest === options.candidate.snapshotDigest) {
    return { preserveActive: true };
  }
  if (options.mode === 'explicitSourceChange') return { preserveActive: false };
  if (options.source.type === 'path') {
    return { preserveActive: options.active.snapshotDigest === options.candidate.snapshotDigest };
  }
  if (options.active.snapshotDigest === options.candidate.snapshotDigest) {
    return { preserveActive: true };
  }
  const relation = compareStrictSemVer(
    options.candidate.catalogVersion,
    previous.metadata.catalogVersion,
  );
  if (relation === 0) throw new CatalogGenerationError({
    code: 'catalogVersionConflict', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" candidate has the same version with different content.`,
  });
  if (relation < 0) throw new CatalogGenerationError({
    code: 'catalogRollbackDetected', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" candidate version is lower than the Active version.`,
  });
  return { preserveActive: false };
}

function enforceCatalogActivationImpactPolicy(options: {
  sourceId: string;
  impact: CatalogSourceImpact;
  impactConfirmed: boolean;
}): void {
  if (catalogSourceImpactRequiresConfirmation(options.impact) && !options.impactConfirmed) {
    throw new CatalogGenerationError({
      code: 'catalogImpactConfirmationRequired', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" has affected or unknown references. Use --yes after reviewing the impact.`,
      impact: options.impact,
    });
  }
}

function assertExpectedImpact(options: {
  sourceId: string;
  impact: CatalogSourceImpact;
  expectedImpactDigest?: string;
}): void {
  if (options.expectedImpactDigest
    && calculateCatalogSourceImpactDigest(options.impact) !== options.expectedImpactDigest) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationReviewStale',
      sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" impact changed after review. Review it again.`,
      impact: options.impact,
    });
  }
}

async function inspectActivationImpact(options: {
  sourceId: string;
  source: CatalogSource;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mode: 'generation' | 'identityChange';
  candidateManifest: CatalogManifestV7;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogSourceImpact> {
  return (options.runtime?.inspectSourceImpact ?? inspectCatalogSourceImpact)({
    sourceId: options.sourceId,
    cwd: options.cwd,
    env: options.env,
    sourcePrimary: options.source.primary,
    mode: options.mode,
    ...(options.mode === 'generation' ? { candidateManifest: options.candidateManifest } : {}),
  });
}

function assertStoreMatchesCandidate(
  sourceId: string,
  store: CatalogStoreEntry,
  candidate: CatalogGenerationCandidateEvidence,
): void {
  if (
    store.metadata.logicalIdentity !== candidate.logicalIdentity
    || store.metadata.manifestDigest !== candidate.manifestDigest
    || store.metadata.snapshotDigest !== candidate.snapshotDigest
  ) throw new CatalogGenerationError({
    code: 'catalogGenerationPublishFailed', sourceId,
    message: `Catalog store evidence does not match the validated candidate for source "${sourceId}".`,
  });
}

async function writeLastSync(options: {
  sourceId: string;
  candidate: CandidateContinuity;
  mode: 'check' | 'sync';
  state: 'succeeded' | 'failed';
  errorCode?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationLastSyncV1> {
  return withAwHomeMutationLock({
    env: options.env,
    signal: options.signal,
    action: async () => {
      await assertCurrentSource(options);
      const lastSync: CatalogGenerationLastSyncV1 = {
        syncedAt: now(options.runtime), mode: options.mode, state: options.state,
        ...(options.state === 'succeeded'
          ? { resolvedCommit: options.candidate.resolvedCommit! }
          : { errorCode: options.errorCode! }),
      };
      await withCatalogGenerationStateTransaction({
        env: options.env,
        beforeReplace: async () => { await assertCurrentSource(options); },
        action: async (current) => ({
          state: {
            schemaVersion: 1,
            sources: {
              ...current.sources,
              [options.sourceId]: { ...current.sources[options.sourceId], lastSync },
            },
          },
          result: undefined,
        }),
      });
      return lastSync;
    },
  });
}

async function recordFailure(options: {
  sourceId: string;
  candidate?: CandidateContinuity;
  mode: 'check' | 'sync';
  errorCode: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<void> {
  if (!options.candidate) return;
  await writeLastSync({ ...options, candidate: options.candidate, state: 'failed' })
    .catch(() => undefined);
}

async function readCandidateContinuity(
  sourceId: string,
  env: NodeJS.ProcessEnv,
): Promise<CandidateContinuity | undefined> {
  const source = (await readCatalogSourcesConfigSnapshot(env)).config.sources
    .find((entry) => entry.id === sourceId);
  if (!source) return undefined;
  return {
    sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
    sourceIdentity: await calculateCatalogSourceIdentity(source),
  };
}

export async function probeCatalogSourceGeneration(options: {
  sourceId: string;
  source?: CatalogSource;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationProbeResult> {
  const env = options.env ?? process.env;
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    return {
      sourceId: options.sourceId,
      candidate: resolved.candidate,
      manifest: resolved.resolution.manifest,
    };
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function probeCatalogSourceRepairGeneration(options: {
  sourceId: string;
  cliVersion: string;
  expectedActive?: CatalogGenerationActiveV1;
  expectedConfigDigest?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationProbeResult> {
  const env = options.env ?? process.env;
  const config = await readCatalogSourcesConfigSnapshot(env);
  if (options.expectedConfigDigest && config.digest !== options.expectedConfigDigest) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" configuration changed after review.`,
    });
  }
  const source = config.config.sources.find((entry) => entry.id === options.sourceId);
  const active = options.expectedActive
    ?? (await readCatalogGenerationState(env)).sources[options.sourceId]?.active;
  if (!source || !active) throw new CatalogGenerationError({
    code: 'catalogGenerationUnavailable', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" has no Active snapshot to repair.`,
  });
  const exactSource: CatalogSource = source.type === 'git'
    ? { ...source, refPolicy: { type: 'explicit', ref: active.resolvedCommit } }
    : source;
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, source: exactSource, env });
    const candidate: CatalogGenerationCandidateEvidence = {
      ...resolved.candidate,
      sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      requestedRef: active.requestedRef,
    };
    if (candidate.logicalIdentity !== active.logicalIdentity
      || candidate.snapshotDigest !== active.snapshotDigest
      || candidate.manifestDigest !== active.manifestDigest
      || candidate.resolvedCommit !== active.resolvedCommit) {
      throw new CatalogGenerationError({
        code: 'catalogReplaceDamagedRequired', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" cannot reproduce the damaged Active entry. Use the current candidate replacement Review.`,
      });
    }
    return { sourceId: options.sourceId, candidate, manifest: resolved.resolution.manifest };
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogReplaceDamagedRequired', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" cannot reproduce the damaged Active entry. Use the current candidate replacement Review.`,
      cause: error,
    });
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function probeCatalogSourceFreshness(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  fullValidation?: boolean;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationFreshnessResult> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const source = (await readCatalogSourcesConfigSnapshot(env)).config.sources
    .find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing',
    sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  const active = await resolveValidatedActiveCatalogGeneration({
    sourceId: source.id,
    env,
    validatedStoreEntries: options.runtime?.validatedStoreEntries,
    validatingStoreEntries: options.runtime?.validatingStoreEntries,
  }).catch(() => undefined);
  const activeEvidence = active ? {
    logicalIdentity: active.logicalIdentity,
    catalogVersion: active.catalogVersion,
    snapshotDigest: active.snapshotDigest,
    resolvedCommit: active.resolvedCommit,
  } : undefined;

  if (source.type === 'git' && active && options.fullValidation !== true) {
    const remote = await (options.runtime?.probeGitRef ?? catalogGitProviderInternal.probeRef)(source, {
      cliVersion: options.cliVersion,
      env,
      signal: options.signal,
    });
    if (remote.sourceId !== source.id || remote.sourceIdentity !== active.sourceIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: source.id,
        message: `Catalog provider returned mismatched identity for source "${source.id}".`,
      });
    }
    if (remote.fixed) {
      return {
        sourceId: source.id,
        state: 'fixed',
        activeVersion: active.catalogVersion,
        activeResolvedCommit: active.resolvedCommit,
      };
    }
    if (remote.resolvedCommit === active.resolvedCommit) {
      return {
        sourceId: source.id,
        state: 'current',
        activeVersion: active.catalogVersion,
        activeResolvedCommit: remote.resolvedCommit,
      };
    }
  }

  const probe = await probeCatalogSourceGeneration({
    sourceId: source.id,
    source,
    cliVersion: options.cliVersion,
    env,
    signal: options.signal,
    runtime: options.runtime,
  });
  return {
    ...compareCatalogGenerationFreshness({
      sourceType: source.type,
      ...(activeEvidence ? { active: activeEvidence } : {}),
      candidate: probe.candidate,
    }),
    sourceId: source.id,
    reusableCandidate: {
      probe,
      sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
      activeStoreKey: active?.storeKey ?? null,
    },
  };
}

export async function recordCatalogGenerationCheck(options: {
  probe: CatalogGenerationProbeResult;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  const lastSync = await writeLastSync({
    sourceId: options.probe.sourceId, candidate: options.probe.candidate,
    mode: 'check', state: 'succeeded', env,
    signal: options.signal, runtime: options.runtime,
  });
  const active = (await readCatalogGenerationState(env)).sources[options.probe.sourceId]?.active;
  return {
    catalogGenerationSchemaVersion: 1, sourceId: options.probe.sourceId,
    mode: 'check', outcome: 'checked', activeChanged: false,
    resolution: publicEvidence(options.probe.candidate),
    ...(active ? { active } : {}), lastSync,
  };
}

async function activateResolvedCandidate(options: {
  sourceId: string;
  resolved: ResolvedCandidate;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  store?: CatalogStoreEntry;
  expectedActive?: CatalogGenerationActiveV1 | null;
  expectedConfigDigest?: string;
  activationMode: CatalogActivationMode;
  impactMode?: 'generation' | 'identityChange';
  expectedImpactDigest?: string;
  impactConfirmed: boolean;
  token?: AwHomeMutationToken;
}): Promise<CatalogGenerationSyncResult> {
  const candidate = options.resolved.candidate;
  const store = options.store ?? await publishCatalogStoreEntry({
    resolution: options.resolved.resolution, env: options.env, signal: options.signal,
    afterInactiveRepairPrepared: options.runtime?.afterInactiveStoreRepairPrepared,
  });
  assertStoreMatchesCandidate(options.sourceId, store, candidate);
  return withAwHomeMutationLock({
    env: options.env,
    token: options.token,
    signal: options.signal,
    action: async () => {
      const lockedStore = await readCatalogStoreEntry({
        logicalIdentity: store.metadata.logicalIdentity,
        snapshotDigest: store.metadata.snapshotDigest,
        env: options.env,
      });
      assertStoreMatchesCandidate(options.sourceId, lockedStore, candidate);
      const source = await assertCurrentSource({
        sourceId: options.sourceId,
        candidate,
        env: options.env,
        expectedConfigDigest: options.expectedConfigDigest,
      });
      const syncedAt = now(options.runtime);
      return withCatalogGenerationStateTransaction({
        env: options.env,
        beforeReplace: async () => { await assertCurrentSource({
          sourceId: options.sourceId,
          candidate,
          env: options.env,
          expectedConfigDigest: options.expectedConfigDigest,
        }); },
        action: async (current) => {
          const previous = current.sources[options.sourceId]?.active;
          assertExpectedActive(options.sourceId, previous, options.expectedActive);
          const policy = await enforceCatalogActivationCandidatePolicy({
            sourceId: options.sourceId,
            source,
            active: previous,
            candidate,
            mode: options.activationMode,
            env: options.env,
          });
          const impact = await inspectActivationImpact({
            sourceId: options.sourceId,
            source,
            cwd: options.cwd ?? process.cwd(),
            env: options.env,
            mode: options.impactMode ?? 'generation',
            candidateManifest: options.resolved.resolution.manifest,
            runtime: options.runtime,
          });
          assertExpectedImpact({
            sourceId: options.sourceId,
            impact,
            expectedImpactDigest: options.expectedImpactDigest,
          });
          enforceCatalogActivationImpactPolicy({
            sourceId: options.sourceId,
            impact,
            impactConfirmed: options.impactConfirmed,
          });
          const activeInput = {
            sourceConfigFingerprint: candidate.sourceConfigFingerprint,
            sourceIdentity: candidate.sourceIdentity,
            requestedRef: candidate.requestedRef,
            resolvedCommit: candidate.resolvedCommit,
            logicalIdentity: store.metadata.logicalIdentity,
            manifestDigest: store.metadata.manifestDigest,
            snapshotDigest: store.metadata.snapshotDigest,
          };
          const unchanged = policy.preserveActive || sameActive(previous, activeInput);
          const active: CatalogGenerationActiveV1 = unchanged
            ? policy.preserveActive && source.type === 'git'
              ? { ...activeInput, activatedAt: previous!.activatedAt }
              : previous!
            : { ...activeInput, activatedAt: syncedAt };
          const lastSync: CatalogGenerationLastSyncV1 = {
            syncedAt, mode: 'sync', state: 'succeeded', resolvedCommit: candidate.resolvedCommit,
          };
          return {
            state: {
              schemaVersion: 1,
              sources: { ...current.sources, [options.sourceId]: { active, lastSync } },
            },
            result: {
              catalogGenerationSchemaVersion: 1 as const, sourceId: options.sourceId,
              mode: 'sync' as const, outcome: unchanged ? 'unchanged' as const : 'activated' as const,
              activeChanged: !unchanged, resolution: publicEvidence(candidate), active, lastSync,
              impact,
            },
          };
        },
      });
    },
  });
}

export async function activateCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  cwd?: string;
  activationMode?: CatalogActivationMode;
  impactConfirmed?: boolean;
  impactMode?: 'generation' | 'identityChange';
  expectedImpactDigest?: string;
  expectedCandidate?: CatalogGenerationCandidateEvidence;
  expectedActive?: CatalogGenerationActiveV1 | null;
  expectedConfigDigest?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  const initialCandidate = await readCandidateContinuity(options.sourceId, env);
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    if (options.expectedCandidate
      && !compareCatalogGenerationCandidates(options.expectedCandidate, resolved.candidate).matches) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" changed after review. Review it again.`,
      });
    }
    const activationMode = options.activationMode ?? 'normal';
    const active = (await readCatalogGenerationState(env)).sources[options.sourceId]?.active;
    assertExpectedActive(options.sourceId, active, options.expectedActive);
    await enforceCatalogActivationCandidatePolicy({
      sourceId: options.sourceId,
      source: resolved.source,
      active,
      candidate: resolved.candidate,
      mode: activationMode,
      env,
    });
    const impact = await inspectActivationImpact({
      sourceId: options.sourceId,
      cwd: options.cwd ?? process.cwd(),
      env,
      source: resolved.source,
      mode: options.impactMode ?? 'generation',
      candidateManifest: resolved.resolution.manifest,
      runtime: options.runtime,
    });
    assertExpectedImpact({
      sourceId: options.sourceId,
      impact,
      expectedImpactDigest: options.expectedImpactDigest,
    });
    await options.runtime?.afterCandidateResolved?.();
    return await activateResolvedCandidate({
      ...options,
      env,
      resolved,
      activationMode,
      impactConfirmed: options.impactConfirmed === true,
    });
  } catch (error) {
    if (!(error instanceof CatalogGenerationError
      && error.code === 'catalogGenerationReviewStale')) {
      await recordFailure({
        sourceId: options.sourceId, candidate: resolved?.candidate ?? initialCandidate, mode: 'sync',
        errorCode: error instanceof CatalogGenerationError
          ? error.code : 'catalogGenerationRefreshFailed',
        env, signal: options.signal, runtime: options.runtime,
      });
    }
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationRefreshFailed', sourceId: options.sourceId,
      message: `Cannot sync Catalog source "${options.sourceId}". The previous Active snapshot is unchanged.`,
      cause: error,
    });
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function recoverCatalogGenerationStateAndActivate(options: {
  sourceId: string;
  cliVersion: string;
  cwd?: string;
  impactConfirmed?: boolean;
  expectedImpactDigest?: string;
  expectedCandidate: CatalogGenerationCandidateEvidence;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    if (!compareCatalogGenerationCandidates(options.expectedCandidate, resolved.candidate).matches) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" changed after review. Review it again.`,
      });
    }
    const impact = await inspectCatalogSourceImpact({
      sourceId: options.sourceId,
      cwd: options.cwd ?? process.cwd(),
      env,
      sourcePrimary: resolved.source.primary,
      mode: 'generation',
      candidateManifest: resolved.resolution.manifest,
    });
    assertExpectedImpact({
      sourceId: options.sourceId,
      impact,
      expectedImpactDigest: options.expectedImpactDigest,
    });
    await options.runtime?.afterCandidateResolved?.();
    const store = await publishCatalogStoreEntry({
      resolution: resolved.resolution, env, signal: options.signal,
      afterInactiveRepairPrepared: options.runtime?.afterInactiveStoreRepairPrepared,
    });
    assertStoreMatchesCandidate(options.sourceId, store, resolved.candidate);
    await options.runtime?.afterRecoveryStorePublished?.();
    return await withAwHomeMutationLock({
      env,
      signal: options.signal,
      action: async () => {
        const lockedStore = await readCatalogStoreEntry({
          logicalIdentity: store.metadata.logicalIdentity,
          snapshotDigest: store.metadata.snapshotDigest,
          env,
        });
        assertStoreMatchesCandidate(options.sourceId, lockedStore, resolved!.candidate);
        const source = await assertCurrentSource({
          sourceId: options.sourceId,
          candidate: resolved!.candidate,
          env,
        });
        await enforceCatalogActivationCandidatePolicy({
          sourceId: options.sourceId,
          source,
          active: undefined,
          candidate: resolved!.candidate,
          mode: 'normal',
          env,
        });
        const lockedImpact = await inspectActivationImpact({
          sourceId: options.sourceId,
          source,
          cwd: options.cwd ?? process.cwd(),
          env,
          mode: 'generation',
          candidateManifest: resolved!.resolution.manifest,
          runtime: options.runtime,
        });
        assertExpectedImpact({
          sourceId: options.sourceId,
          impact: lockedImpact,
          expectedImpactDigest: options.expectedImpactDigest,
        });
        enforceCatalogActivationImpactPolicy({
          sourceId: options.sourceId,
          impact: lockedImpact,
          impactConfirmed: options.impactConfirmed === true,
        });
        const syncedAt = now(options.runtime);
        const candidate = resolved!.candidate;
        const active: CatalogGenerationActiveV1 = {
          sourceConfigFingerprint: candidate.sourceConfigFingerprint,
          sourceIdentity: candidate.sourceIdentity,
          requestedRef: candidate.requestedRef,
          resolvedCommit: candidate.resolvedCommit,
          logicalIdentity: store.metadata.logicalIdentity,
          manifestDigest: store.metadata.manifestDigest,
          snapshotDigest: store.metadata.snapshotDigest,
          activatedAt: syncedAt,
        };
        const lastSync: CatalogGenerationLastSyncV1 = {
          syncedAt, mode: 'sync', state: 'succeeded', resolvedCommit: candidate.resolvedCommit,
        };
        await replaceInvalidCatalogGenerationState({
          env,
          state: { schemaVersion: 1, sources: { [options.sourceId]: { active, lastSync } } },
          beforeReplace: async () => { await assertCurrentSource({
            sourceId: options.sourceId, candidate, env,
          }); },
        });
        return {
          catalogGenerationSchemaVersion: 1,
          sourceId: options.sourceId,
          mode: 'sync',
          outcome: 'activated',
          activeChanged: true,
          resolution: publicEvidence(candidate),
          active,
          lastSync,
          impact: lockedImpact,
        };
      },
    });
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function repairCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  cwd?: string;
  expectedCandidate?: CatalogGenerationCandidateEvidence;
  expectedActive?: CatalogGenerationActiveV1 | null;
  expectedConfigDigest?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  const target = options.expectedActive === undefined
    ? (await readCatalogGenerationState(env)).sources[options.sourceId]?.active
    : options.expectedActive ?? undefined;
  if (!target) throw new CatalogGenerationError({
    code: 'catalogGenerationUnavailable', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" has no Active snapshot to repair.`,
  });
  let resolved: ResolvedCandidate | undefined;
  let preparedRepair: Awaited<ReturnType<typeof prepareCatalogStoreEntryRepair>> | undefined;
  try {
    const config = await readCatalogSourcesConfigSnapshot(env);
    if (options.expectedConfigDigest && config.digest !== options.expectedConfigDigest) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" configuration changed after review.`,
      });
    }
    const source = config.config.sources.find((entry) => entry.id === options.sourceId);
    if (!source) throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" is not configured.`,
    });
    const exactSource: CatalogSource = source.type === 'git'
      ? { ...source, refPolicy: { type: 'explicit', ref: target.resolvedCommit } }
      : source;
    const exact = await resolveCandidate({ ...options, source: exactSource, env });
    resolved = {
      ...exact,
      source,
      candidate: {
        ...exact.candidate,
        sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
        sourceIdentity: await calculateCatalogSourceIdentity(source),
        requestedRef: target.requestedRef,
      },
    };
    if (options.expectedCandidate
      && !compareCatalogGenerationCandidates(options.expectedCandidate, resolved.candidate).matches) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" changed after review. Review it again.`,
      });
    }
    await options.runtime?.afterCandidateResolved?.();
    if (resolved.candidate.logicalIdentity !== target.logicalIdentity
      || resolved.candidate.snapshotDigest !== target.snapshotDigest
      || resolved.candidate.manifestDigest !== target.manifestDigest
      || resolved.candidate.resolvedCommit !== target.resolvedCommit) {
      throw new CatalogGenerationError({
        code: 'catalogReplaceDamagedRequired', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" cannot reproduce the damaged Active entry. Use the current candidate replacement Review.`,
      });
    }
    preparedRepair = await prepareCatalogStoreEntryRepair({
      resolution: resolved.resolution,
      logicalIdentity: target.logicalIdentity,
      snapshotDigest: target.snapshotDigest,
      env,
      signal: options.signal,
    });
    return await withAwHomeMutationLock({
      env,
      signal: options.signal,
      action: async () => {
        const currentSource = await assertCurrentSource({
          sourceId: options.sourceId,
          candidate: resolved!.candidate,
          env,
          expectedConfigDigest: options.expectedConfigDigest,
        });
        const currentState = await readCatalogGenerationState(env);
        const current = currentState.sources[options.sourceId]?.active;
        assertExpectedActive(options.sourceId, current, options.expectedActive);
        if (options.expectedActive === undefined) assertExpectedActive(options.sourceId, current, target);
        await enforceCatalogActivationCandidatePolicy({
          sourceId: options.sourceId,
          source: currentSource,
          active: current,
          candidate: resolved!.candidate,
          mode: 'exactRepair',
          env,
        });
        const store = await preparedRepair!.commit();
        assertStoreMatchesCandidate(options.sourceId, store, resolved!.candidate);
        const syncedAt = now(options.runtime);
        const lastSync: CatalogGenerationLastSyncV1 = {
          syncedAt,
          mode: 'sync',
          state: 'succeeded',
          resolvedCommit: target.resolvedCommit,
        };
        await withCatalogGenerationStateTransaction({
          env,
          beforeReplace: async () => {
            await assertCurrentSource({
              sourceId: options.sourceId,
              candidate: resolved!.candidate,
              env,
              expectedConfigDigest: options.expectedConfigDigest,
            });
            const active = (await readCatalogGenerationState(env)).sources[options.sourceId]?.active;
            assertExpectedActive(options.sourceId, active, options.expectedActive ?? target);
          },
          action: async (latest) => ({
            state: {
              schemaVersion: 1,
              sources: {
                ...latest.sources,
                [options.sourceId]: { active: target, lastSync },
              },
            },
            result: undefined,
          }),
        });
        return {
          catalogGenerationSchemaVersion: 1,
          sourceId: options.sourceId,
          mode: 'sync',
          outcome: 'unchanged',
          activeChanged: false,
          resolution: publicEvidence(resolved!.candidate),
          active: target,
          lastSync,
        };
      },
    });
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogReplaceDamagedRequired', sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" cannot reproduce the damaged Active entry. Use --replace-damaged --yes to use the current candidate.`,
      cause: error,
    });
  } finally {
    if (preparedRepair) await preparedRepair.cleanup();
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function replaceDamagedCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  cwd?: string;
  expectedCandidate?: CatalogGenerationCandidateEvidence;
  expectedActive: CatalogGenerationActiveV1;
  expectedConfigDigest: string;
  impactConfirmed?: boolean;
  expectedImpactDigest?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  let resolved: ResolvedCandidate | undefined;
  let preparedRepair: Awaited<ReturnType<typeof prepareCatalogStoreEntryRepair>> | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    if (options.expectedCandidate
      && !compareCatalogGenerationCandidates(options.expectedCandidate, resolved.candidate).matches) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" changed after review. Review it again.`,
      });
    }
    const targetKey = createCatalogStoreKey(
      options.expectedActive.logicalIdentity,
      options.expectedActive.snapshotDigest,
    );
    const candidateKey = createCatalogStoreKey(
      resolved.candidate.logicalIdentity,
      resolved.candidate.snapshotDigest,
    );
    const impact = await inspectCatalogSourceImpact({
      sourceId: options.sourceId,
      cwd: options.cwd ?? process.cwd(),
      env,
      sourcePrimary: resolved.source.primary,
      mode: 'generation',
      candidateManifest: resolved.resolution.manifest,
    });
    assertExpectedImpact({
      sourceId: options.sourceId,
      impact,
      expectedImpactDigest: options.expectedImpactDigest,
    });
    await options.runtime?.afterCandidateResolved?.();
    if (targetKey === candidateKey) {
      preparedRepair = await prepareCatalogStoreEntryRepair({
        resolution: resolved.resolution,
        logicalIdentity: resolved.candidate.logicalIdentity,
        snapshotDigest: resolved.candidate.snapshotDigest,
        env,
        signal: options.signal,
      });
      return await withAwHomeMutationLock({
        env,
        signal: options.signal,
        action: async () => {
          const source = await assertCurrentSource({
            sourceId: options.sourceId,
            candidate: resolved!.candidate,
            env,
            expectedConfigDigest: options.expectedConfigDigest,
          });
          const syncedAt = now(options.runtime);
          return withCatalogGenerationStateTransaction({
            env,
            beforeReplace: async () => { await assertCurrentSource({
              sourceId: options.sourceId,
              candidate: resolved!.candidate,
              env,
              expectedConfigDigest: options.expectedConfigDigest,
            }); },
            action: async (current) => {
              const previous = current.sources[options.sourceId]?.active;
              assertExpectedActive(options.sourceId, previous, options.expectedActive);
              await enforceCatalogActivationCandidatePolicy({
                sourceId: options.sourceId,
                source,
                active: previous,
                candidate: resolved!.candidate,
                mode: 'replaceDamaged',
                env,
              });
              const lockedImpact = await inspectActivationImpact({
                sourceId: options.sourceId,
                source,
                cwd: options.cwd ?? process.cwd(),
                env,
                mode: 'generation',
                candidateManifest: resolved!.resolution.manifest,
                runtime: options.runtime,
              });
              assertExpectedImpact({
                sourceId: options.sourceId,
                impact: lockedImpact,
                expectedImpactDigest: options.expectedImpactDigest,
              });
              enforceCatalogActivationImpactPolicy({
                sourceId: options.sourceId,
                impact: lockedImpact,
                impactConfirmed: options.impactConfirmed === true,
              });
              const store = await preparedRepair!.commit();
              assertStoreMatchesCandidate(options.sourceId, store, resolved!.candidate);
              const activeInput = {
                sourceConfigFingerprint: resolved!.candidate.sourceConfigFingerprint,
                sourceIdentity: resolved!.candidate.sourceIdentity,
                requestedRef: resolved!.candidate.requestedRef,
                resolvedCommit: resolved!.candidate.resolvedCommit,
                logicalIdentity: store.metadata.logicalIdentity,
                manifestDigest: store.metadata.manifestDigest,
                snapshotDigest: store.metadata.snapshotDigest,
              };
              const unchanged = sameActive(previous, activeInput);
              const active: CatalogGenerationActiveV1 = unchanged
                ? previous!
                : { ...activeInput, activatedAt: syncedAt };
              const lastSync: CatalogGenerationLastSyncV1 = {
                syncedAt,
                mode: 'sync',
                state: 'succeeded',
                resolvedCommit: resolved!.candidate.resolvedCommit,
              };
              return {
                state: {
                  schemaVersion: 1,
                  sources: { ...current.sources, [options.sourceId]: { active, lastSync } },
                },
                result: {
                  catalogGenerationSchemaVersion: 1 as const,
                  sourceId: options.sourceId,
                  mode: 'sync' as const,
                  outcome: unchanged ? 'unchanged' as const : 'activated' as const,
                  activeChanged: !unchanged,
                  resolution: publicEvidence(resolved!.candidate),
                  active,
                  lastSync,
                  impact: lockedImpact,
                },
              };
            },
          });
        },
      });
    }
    return await activateResolvedCandidate({
      ...options,
      env,
      resolved,
      expectedActive: options.expectedActive,
      activationMode: 'replaceDamaged',
      impactConfirmed: options.impactConfirmed === true,
    });
  } finally {
    if (preparedRepair) await preparedRepair.cleanup();
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

async function inferredActivationMode(options: {
  sourceId: string;
  active: CatalogGenerationActiveV1 | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogActivationMode> {
  if (!options.active) return 'normal';
  const source = (await readCatalogSourcesConfigSnapshot(options.env)).config.sources
    .find((entry) => entry.id === options.sourceId);
  if (!source) return 'normal';
  return options.active.sourceConfigFingerprint !== calculateCatalogSourceConfigFingerprint(source)
    || options.active.sourceIdentity !== await calculateCatalogSourceIdentity(source)
    ? 'explicitSourceChange'
    : 'normal';
}

export async function syncCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  cwd?: string;
  check?: boolean;
  impactConfirmed?: boolean;
  replaceDamaged?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  expectedCandidate?: CatalogGenerationCandidateEvidence;
  expectedActive?: CatalogGenerationActiveV1 | null;
  expectedConfigDigest?: string;
  expectedImpactDigest?: string;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  if (!options.check) {
    const config = await readCatalogSourcesConfigSnapshot(env);
    const active = (await readCatalogGenerationState(env)).sources[options.sourceId]?.active;
    if (options.replaceDamaged === true && options.impactConfirmed !== true) {
      throw new CatalogGenerationError({
        code: 'catalogImpactConfirmationRequired', sourceId: options.sourceId,
        message: '--replace-damaged requires --yes.',
      });
    }
    if (active) {
      const damaged = await readCatalogStoreEntry({
        logicalIdentity: active.logicalIdentity,
        snapshotDigest: active.snapshotDigest,
        env,
      }).then(() => false).catch(() => true);
      if (damaged) {
        try {
          await repairCatalogSourceGeneration({
            ...options,
            env,
            expectedActive: active,
            expectedConfigDigest: config.digest,
          });
        } catch (error) {
          if (!(error instanceof CatalogGenerationError)
            || error.code !== 'catalogReplaceDamagedRequired'
            || options.replaceDamaged !== true) throw error;
          return replaceDamagedCatalogSourceGeneration({
            ...options,
            env,
            expectedActive: active,
            expectedConfigDigest: config.digest,
            impactConfirmed: true,
          });
        }
      } else if (options.replaceDamaged === true) {
        throw new CatalogGenerationError({
          code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
          message: `Catalog source "${options.sourceId}" Active entry is not damaged.`,
        });
      }
    }
    return activateCatalogSourceGeneration({
      ...options,
      env,
      expectedActive: active ?? null,
      activationMode: await inferredActivationMode({ sourceId: options.sourceId, active, env }),
    });
  }
  const initialCandidate = await readCandidateContinuity(options.sourceId, env);
  let probe: CatalogGenerationProbeResult | undefined;
  try {
    probe = await probeCatalogSourceGeneration({ ...options, env });
    const source = (await readCatalogSourcesConfigSnapshot(env)).config.sources
      .find((entry) => entry.id === options.sourceId);
    const impact = await inspectCatalogSourceImpact({
      sourceId: options.sourceId,
      cwd: options.cwd ?? process.cwd(),
      env,
      sourcePrimary: source?.primary === true,
      mode: 'generation',
      candidateManifest: probe.manifest,
    });
    const result = await recordCatalogGenerationCheck({
      probe,
      env,
      signal: options.signal,
      runtime: options.runtime,
    });
    return { ...result, impact };
  } catch (error) {
    await recordFailure({
      sourceId: options.sourceId, candidate: probe?.candidate ?? initialCandidate, mode: 'check',
      errorCode: error instanceof CatalogGenerationError
        ? error.code : 'catalogGenerationRefreshFailed',
      env, signal: options.signal, runtime: options.runtime,
    });
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationRefreshFailed', sourceId: options.sourceId,
      message: `Cannot check Catalog source "${options.sourceId}".`, cause: error,
    });
  }
}

export async function readCatalogGenerationStatus(options: {
  sourceId?: string;
  env?: NodeJS.ProcessEnv;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
} = {}): Promise<CatalogGenerationStatusPayload> {
  const env = options.env ?? process.env;
  const config = await readCatalogSourcesConfigSnapshot(env);
  const state = await readCatalogGenerationState(env);
  const selected = options.sourceId
    ? config.config.sources.filter((source) => source.id === options.sourceId)
    : config.config.sources;
  if (options.sourceId && selected.length === 0) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  const sources = await Promise.all(selected.map(async (source): Promise<CatalogGenerationStatusEntry> => {
    const configuredSourceIdentity = await calculateCatalogSourceIdentity(source);
    const sourceState = state.sources[source.id];
    const active = sourceState?.active;
    const configMatchesActive = Boolean(active)
      && active!.sourceIdentity === configuredSourceIdentity
      && active!.sourceConfigFingerprint === calculateCatalogSourceConfigFingerprint(source);
    if (!active) return {
      sourceId: source.id, configuredSourceIdentity, activeReady: false,
      configMatchesActive: false, lastSync: sourceState?.lastSync,
      compatibility: null,
    };
    try {
      const entry = await readValidatedCatalogGenerationStoreEntry({
        logicalIdentity: active.logicalIdentity,
        snapshotDigest: active.snapshotDigest,
        env,
        validatedStoreEntries: options.validatedStoreEntries,
        validatingStoreEntries: options.validatingStoreEntries,
      });
      if (entry.metadata.manifestDigest !== active.manifestDigest) throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch', message: 'Active does not match store metadata.',
      });
      const compatibility = projectCatalogCapabilityCompatibility(
        entry.metadata.requiredAwCapabilities,
      );
      return {
        sourceId: source.id, configuredSourceIdentity, active,
        activeReady: configMatchesActive && compatibility.state === 'supported',
        configMatchesActive,
        catalogVersion: entry.metadata.catalogVersion, channel: entry.metadata.channel,
        storeKey: createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
        lastSync: sourceState?.lastSync, compatibility,
      };
    } catch (error) {
      return {
        sourceId: source.id, configuredSourceIdentity, active, activeReady: false,
        configMatchesActive, lastSync: sourceState?.lastSync,
        compatibility: null,
        errorCode: catalogGenerationErrorCode(error),
      };
    }
  }));
  return { catalogGenerationStatusSchemaVersion: 2, sources };
}
