import crypto from 'node:crypto';
import path from 'node:path';

import {
  DEFAULT_CATALOG_OUTPUT_PATH,
  readCatalogWorkspace,
  validateCatalogSnapshotComplete,
} from '@lesliechan721/aw-plugin-core';

import { runCatalogBuildCommand } from '../authoring/workspace-commands.js';
import type { CatalogSource, PathCatalogSource } from '../types.js';
import {
  readCatalogGenerationStatus,
  type CatalogGenerationStatusEntry,
} from '../utils/catalog-generation-service.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';
import {
  CATALOG_SOURCE_ID_PATTERN,
  CatalogSourcesConfigConflictError,
  isDefaultOfficialCatalogSource,
  readCatalogSourcesConfigSnapshot,
} from '../utils/catalog-sources.js';
import {
  addCatalogSourceCommand,
  preflightCatalogSourceMutation,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
  type CatalogSourceCommandRuntime,
  type CatalogSourcePreflightInventory,
} from './catalog-source.js';
import { syncCatalogSourceCommand } from './catalog-generation.js';
import { getCatalogStatus } from './catalog-status.js';
import { resolveCatalogWorkspaceRoot } from './catalog-workspace-resolution.js';

type Issue = { code: string; message: string; blocking: boolean };

export interface CatalogDevActivateReceipt {
  receiptSchemaVersion: 2;
  command: 'catalog:dev:activate';
  ok: boolean;
  state: 'completed' | 'partial' | 'failed';
  workspaceIdentity: string | null;
  snapshot: { action: 'reused' | 'built'; digest: string | null };
  source: { id: string; action: 'added' | 'updated' | 'reused'; primary: boolean };
  active: { ready: boolean; snapshotDigest: string | null };
  recovery: string[];
  errors: Array<{ code: string; message: string }>;
}

export interface CatalogDevStatusReceipt {
  receiptSchemaVersion: 4;
  command: 'catalog:dev:status';
  ok: boolean;
  ready: boolean;
  workspaceIdentity: string | null;
  snapshot: {
    state: 'absent' | 'current' | 'stale' | 'invalid';
    valid: boolean;
    digest: string | null;
  };
  source: {
    exists: boolean;
    id: string | null;
    pathMatches: boolean | null;
    primary: boolean | null;
  };
  active: {
    exists: boolean;
    ready: boolean;
    digestMatchesSnapshot: boolean;
    snapshotDigest: string | null;
    compatibility: CatalogGenerationStatusEntry['compatibility'];
  };
  issues: Issue[];
}

export interface CatalogDevDeactivateReceipt {
  receiptSchemaVersion: 3;
  command: 'catalog:dev:deactivate';
  ok: boolean;
  state: 'completed' | 'partial' | 'failed';
  workspaceIdentity: string | null;
  source: { id: string | null; action: 'removed' | 'absent' | 'retained'; previousPrimary: boolean };
  replacementPrimarySourceId: string | null;
  impact: CatalogSourcePreflightInventory | null;
  recovery: string[];
  errors: Array<{ code: string; message: string }>;
}

export type CatalogDevSourceRuntime = {
  sourceRuntime?: CatalogSourceCommandRuntime;
  beforeSync?: () => Promise<void> | void;
  afterSync?: () => Promise<void> | void;
};

function managedSources(sources: CatalogSource[], workspaceIdentity: string): PathCatalogSource[] {
  return sources.filter((source): source is PathCatalogSource => source.type === 'path'
    && source.managedBy?.kind === 'catalog-workspace'
    && source.managedBy.workspaceIdentity === workspaceIdentity);
}

function normalizeSuggestedSourceId(workspaceRoot: string): string {
  const stem = path.basename(workspaceRoot).toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  const prefixed = /^[a-z]/u.test(stem) ? stem : `catalog-${stem}`;
  const basename = (prefixed || 'catalog').slice(0, 28).replace(/-+$/u, '') || 'catalog';
  return `${basename}-dev`;
}

function suffixedSourceId(base: string, workspaceIdentity: string): string {
  const suffix = crypto.createHash('sha256').update(workspaceIdentity).digest('hex').slice(0, 6);
  const prefix = base.slice(0, 32 - suffix.length - 1).replace(/-+$/u, '');
  return `${prefix}-${suffix}`;
}

export function suggestedCatalogDevSourceId(
  workspaceRoot: string,
  workspaceIdentity?: string,
  occupiedSourceIds: readonly string[] = [],
): string {
  const base = normalizeSuggestedSourceId(workspaceRoot);
  return workspaceIdentity && occupiedSourceIds.includes(base)
    ? suffixedSourceId(base, workspaceIdentity)
    : base;
}

class CatalogDevSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CatalogDevSourceError';
  }
}

function assertExplicitSourceId(sourceId: string): void {
  if (!CATALOG_SOURCE_ID_PATTERN.test(sourceId)) {
    throw new CatalogDevSourceError('invalidSourceId', 'Invalid Catalog development source ID.');
  }
}

export type CatalogDevCommand = 'activate' | 'status' | 'deactivate';

export function createCatalogDevFailureReceipt(options: {
  command: CatalogDevCommand;
  cwd: string;
  workspaceRoot?: string;
  sourceId?: string;
  code: string;
  message: string;
}): CatalogDevActivateReceipt | CatalogDevStatusReceipt | CatalogDevDeactivateReceipt {
  const workspaceRoot = path.resolve(options.cwd, options.workspaceRoot ?? '.');
  if (options.command === 'activate') {
    return {
      receiptSchemaVersion: 2, command: 'catalog:dev:activate', ok: false, state: 'failed',
      workspaceIdentity: null,
      snapshot: { action: 'reused', digest: null },
      source: { id: options.sourceId ?? suggestedCatalogDevSourceId(workspaceRoot), action: 'reused', primary: false },
      active: { ready: false, snapshotDigest: null },
      recovery: ['Fix the reported problem, then rerun catalog dev activate.'],
      errors: [{ code: options.code, message: options.message }],
    };
  }
  if (options.command === 'status') {
    return {
      receiptSchemaVersion: 4, command: 'catalog:dev:status', ok: false, ready: false,
      workspaceIdentity: null,
      snapshot: { state: 'absent', valid: false, digest: null },
      source: { exists: false, id: null, pathMatches: null, primary: null },
      active: {
        exists: false, ready: false, digestMatchesSnapshot: false, snapshotDigest: null,
        compatibility: null,
      },
      issues: [{ code: options.code, message: options.message, blocking: true }],
    };
  }
  return {
    receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: false, state: 'failed',
    workspaceIdentity: null,
    source: { id: null, action: 'absent', previousPrimary: false },
    replacementPrimarySourceId: null,
    impact: null,
    recovery: ['Fix the reported problem, then rerun catalog dev deactivate.'],
    errors: [{ code: options.code, message: options.message }],
  };
}

function codedFailure(error: unknown, fallbackCode: string): { code: string; message: string } {
  const candidateCode = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined;
  const typedCode = candidateCode === 'catalogImpactConfirmationRequired'
    || candidateCode === 'catalogSourceImpactConfirmationRequired'
    || candidateCode === 'operationReviewStale'
    ? candidateCode
    : undefined;
  return {
    code: error instanceof CatalogDevSourceError ? error.code : typedCode ?? fallbackCode,
    message: error instanceof CatalogDevSourceError ? error.message : 'The Catalog development operation failed.',
  };
}

function failureImpact(
  error: unknown,
  fallback: CatalogSourcePreflightInventory,
): CatalogSourcePreflightInventory {
  if (typeof error !== 'object' || error === null || !('impact' in error)) return fallback;
  const impact = error.impact;
  return typeof impact === 'object' && impact !== null && 'inventorySchemaVersion' in impact
    && impact.inventorySchemaVersion === 1
    ? impact as CatalogSourcePreflightInventory
    : fallback;
}

async function resolveWorkspace(cwd: string, workspaceRoot?: string) {
  try {
    const resolved = await resolveCatalogWorkspaceRoot({
      cwd,
      ...(workspaceRoot === undefined ? {} : { explicitRoot: workspaceRoot }),
      mode: 'existing',
    });
    const workspace = await readCatalogWorkspace(resolved.workspaceRoot, { reservedImports: CLI_RESERVED_IMPORTS });
    return { resolved, workspace };
  } catch {
    throw new CatalogDevSourceError('workspaceInvalid', 'Catalog Workspace is missing or invalid.');
  }
}

export function catalogDevSourceError(error: unknown, fallbackCode = 'catalogDevSourceFailed') {
  return codedFailure(error, fallbackCode);
}

export async function activateCatalogDevSource(options: {
  cwd: string;
  workspaceRoot?: string;
  sourceId?: string;
  primary?: boolean;
  forceBuild?: boolean;
  yes?: boolean;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogDevSourceRuntime;
}): Promise<CatalogDevActivateReceipt> {
  const { resolved, workspace } = await resolveWorkspace(options.cwd, options.workspaceRoot);
  const snapshotPath = path.join(workspace.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH);
  const staticStatus = await getCatalogStatus({
    cwd: options.cwd, workspaceRoot: workspace.workspaceRoot, env: options.env,
  });
  let snapshotAction: 'reused' | 'built' = 'reused';
  let snapshotDigest = staticStatus.snapshot.snapshotDigest;
  if (options.forceBuild === true || staticStatus.snapshot.state !== 'current') {
    try {
      await runCatalogBuildCommand({
        workspaceRoot: workspace.workspaceRoot,
        workspaceRootResolvedFrom: resolved.workspaceRootResolvedFrom,
        force: options.forceBuild === true || staticStatus.snapshot.state !== 'absent',
        io: { stdout: () => undefined, stderr: () => undefined },
      });
      snapshotDigest = (await validateCatalogSnapshotComplete(snapshotPath)).snapshotDigest;
      snapshotAction = 'built';
    } catch (error) {
      return {
        receiptSchemaVersion: 2, command: 'catalog:dev:activate', ok: false, state: 'failed',
        workspaceIdentity: workspace.workspaceIdentity,
        snapshot: { action: 'built', digest: null },
        source: { id: options.sourceId ?? normalizeSuggestedSourceId(workspace.workspaceRoot), action: 'reused', primary: false },
        active: { ready: false, snapshotDigest: null },
        recovery: ['Fix the Catalog Workspace, then rerun catalog dev activate.'],
        errors: [codedFailure(error, 'snapshotBuildFailed')],
      };
    }
  }

  let selectedId = options.sourceId ?? normalizeSuggestedSourceId(workspace.workspaceRoot);
  let sourceAction: 'added' | 'updated' | 'reused' = 'reused';
  let sourceCommitted = false;
  try {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(options.env);
    const owned = managedSources(configSnapshot.config.sources, workspace.workspaceIdentity);
    if (owned.length > 1) {
      throw new CatalogDevSourceError('multipleManagedSources', 'Workspace owns multiple development sources.');
    }
    const existing = owned[0];
    if (options.sourceId !== undefined) {
      assertExplicitSourceId(options.sourceId);
      if (existing && existing.id !== options.sourceId) {
        throw new CatalogDevSourceError('sourceIdConflict', 'Workspace already owns another development source.');
      }
      const collision = configSnapshot.config.sources.find((source) => source.id === options.sourceId);
      if (collision && collision !== existing) {
        throw new CatalogDevSourceError('sourceIdConflict', 'The selected source ID is already in use.');
      }
    } else if (!existing && configSnapshot.config.sources.some((source) => source.id === selectedId)) {
      selectedId = suffixedSourceId(selectedId, workspace.workspaceIdentity);
      if (configSnapshot.config.sources.some((source) => source.id === selectedId)) {
        throw new CatalogDevSourceError('sourceIdConflict', 'The generated development source ID is already in use.');
      }
    }
    if (existing) selectedId = existing.id;
    if (!existing) {
      sourceAction = 'added';
      await addCatalogSourceCommand({
        source: {
          id: selectedId, type: 'path', path: snapshotPath, primary: false,
          managedBy: { kind: 'catalog-workspace', workspaceIdentity: workspace.workspaceIdentity },
        },
        cliVersion: options.cliVersion, cwd: workspace.workspaceRoot, env: options.env,
        runtime: options.runtime?.sourceRuntime,
        managedByWorkspaceIdentity: workspace.workspaceIdentity,
      });
      sourceCommitted = true;
    } else if (existing.path !== snapshotPath) {
      sourceAction = 'updated';
      await updateCatalogSourceCommand({
        sourceId: existing.id, update: { type: 'path', path: snapshotPath },
        cliVersion: options.cliVersion, cwd: workspace.workspaceRoot, env: options.env,
        runtime: options.runtime?.sourceRuntime,
        managedByWorkspaceIdentity: workspace.workspaceIdentity,
      });
      sourceCommitted = true;
    }
    const current = (await readCatalogSourcesConfigSnapshot(options.env)).config.sources
      .find((source) => source.id === selectedId)!;
    if (options.primary === true && !current.primary) {
      await setPrimaryCatalogSourceCommand({
        sourceId: selectedId, cwd: workspace.workspaceRoot, env: options.env,
        runtime: options.runtime?.sourceRuntime,
      });
      sourceCommitted = true;
    }
    await options.runtime?.beforeSync?.();
    await syncCatalogSourceCommand({
      sourceId: selectedId,
      cliVersion: options.cliVersion,
      cwd: workspace.workspaceRoot,
      impactConfirmed: options.yes === true,
      env: options.env,
    });
    await options.runtime?.afterSync?.();
    const finalStatus = await getCatalogDevSourceStatus({
      cwd: options.cwd,
      workspaceRoot: workspace.workspaceRoot,
      cliVersion: options.cliVersion,
      env: options.env,
    });
    if (
      !finalStatus.ok
      || !finalStatus.ready
      || finalStatus.active.snapshotDigest !== snapshotDigest
    ) throw new CatalogDevSourceError(
      'activeNotReady',
      'Catalog development source sync completed, but final Active status is not ready.',
    );
    const configured = (await readCatalogSourcesConfigSnapshot(options.env)).config.sources
      .find((source) => source.id === selectedId)!;
    return {
      receiptSchemaVersion: 2, command: 'catalog:dev:activate', ok: true, state: 'completed',
      workspaceIdentity: workspace.workspaceIdentity,
      snapshot: { action: snapshotAction, digest: snapshotDigest },
      source: { id: selectedId, action: sourceAction, primary: configured.primary },
      active: { ready: true, snapshotDigest: finalStatus.active.snapshotDigest },
      recovery: [], errors: [],
    };
  } catch (error) {
    return {
      receiptSchemaVersion: 2, command: 'catalog:dev:activate', ok: false,
      state: snapshotAction === 'built' || sourceCommitted ? 'partial' : 'failed',
      workspaceIdentity: workspace.workspaceIdentity,
      snapshot: { action: snapshotAction, digest: snapshotDigest },
      source: { id: selectedId, action: sourceAction, primary: false },
      active: { ready: false, snapshotDigest: null },
      recovery: ['The source configuration and snapshot were kept. Fix the problem, then rerun catalog dev activate.'],
      errors: [codedFailure(error, sourceCommitted ? 'sourceSyncFailed' : 'sourceConfigFailed')],
    };
  }
}

export async function getCatalogDevSourceStatus(options: {
  cwd: string;
  workspaceRoot?: string;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogDevStatusReceipt> {
  const empty: CatalogDevStatusReceipt = {
    receiptSchemaVersion: 4, command: 'catalog:dev:status', ok: false, ready: false,
    workspaceIdentity: null,
    snapshot: { state: 'absent', valid: false, digest: null },
    source: { exists: false, id: null, pathMatches: null, primary: null },
    active: {
      exists: false, ready: false, digestMatchesSnapshot: false, snapshotDigest: null,
      compatibility: null,
    },
    issues: [],
  };
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    workspace = await resolveWorkspace(options.cwd, options.workspaceRoot);
  } catch (error) {
    empty.issues.push({ ...codedFailure(error, 'workspaceInvalid'), blocking: true });
    return empty;
  }
  empty.workspaceIdentity = workspace.workspace.workspaceIdentity;
  const staticStatus = await getCatalogStatus({
    cwd: options.cwd, workspaceRoot: workspace.workspace.workspaceRoot, env: options.env,
  }).catch(() => null);
  if (!staticStatus) {
    empty.issues.push({ code: 'catalogStatusInvalid', message: 'Catalog snapshot status is invalid.', blocking: true });
    return empty;
  }
  empty.snapshot = {
    state: staticStatus.snapshot.state,
    valid: staticStatus.snapshot.valid,
    digest: staticStatus.snapshot.snapshotDigest,
  };
  const workspaceIssues = staticStatus.issues.filter((issue) => issue.blocking);
  empty.issues.push(...workspaceIssues.map((issue) => ({
    code: issue.code,
    message: 'Catalog Workspace status has a blocking issue.',
    blocking: true,
  })));
  if (staticStatus.snapshot.state !== 'current') {
    empty.issues.push({
      code: `snapshot${staticStatus.snapshot.state[0]!.toUpperCase()}${staticStatus.snapshot.state.slice(1)}`,
      message: `Catalog development snapshot is ${staticStatus.snapshot.state}.`, blocking: true,
    });
  }
  const config = await readCatalogSourcesConfigSnapshot(options.env).catch(() => null);
  if (!config) {
    empty.issues.push({ code: 'sourceConfigInvalid', message: 'Catalog source configuration is invalid.', blocking: true });
    return empty;
  }
  const owned = managedSources(config.config.sources, workspace.workspace.workspaceIdentity);
  if (owned.length !== 1) {
    empty.issues.push({
      code: owned.length === 0 ? 'sourceInactive' : 'multipleManagedSources',
      message: owned.length === 0
        ? 'Workspace has no configured development source.'
        : 'Workspace owns multiple development sources.',
      blocking: true,
    });
  }
  const source = owned.length === 1 ? owned[0]! : null;
  if (source) {
    const snapshotPath = path.join(workspace.workspace.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH);
    const pathMatches = source.path === snapshotPath;
    empty.source = { exists: true, id: source.id, pathMatches, primary: source.primary };
    if (!pathMatches) {
      empty.issues.push({ code: 'sourcePathMismatch', message: 'Managed source path does not match this Workspace.', blocking: true });
    }
    const status = await readCatalogGenerationStatus({ sourceId: source.id, env: options.env }).catch(() => null);
    const entry = status?.sources[0];
    const snapshotDigest = entry?.active?.snapshotDigest ?? null;
    const digestMatchesSnapshot = snapshotDigest !== null && snapshotDigest === empty.snapshot.digest;
    empty.active = {
      exists: entry?.active !== undefined,
      ready: entry?.activeReady === true,
      digestMatchesSnapshot,
      snapshotDigest,
      compatibility: entry?.compatibility ?? null,
    };
    if (!entry?.active) {
      empty.issues.push({ code: 'activeAbsent', message: 'Development source has no Active snapshot.', blocking: true });
    } else if (entry.compatibility?.state === 'unsupported') {
      empty.issues.push({
        code: 'awCapabilityUnsupported',
        message: 'Development source Active snapshot is incompatible with this AW.',
        blocking: true,
      });
    } else if (!entry.activeReady) {
      empty.issues.push({ code: entry.errorCode ?? 'activeNotReady', message: 'Development source Active snapshot is not ready.', blocking: true });
    }
    if (entry?.active && !digestMatchesSnapshot) {
      empty.issues.push({ code: 'activeSnapshotDigestMismatch', message: 'Active digest does not match the Workspace snapshot.', blocking: true });
    }
  }
  empty.ok = true;
  empty.ready = empty.snapshot.state === 'current'
    && staticStatus.ok
    && workspaceIssues.length === 0
    && source !== null
    && empty.source.pathMatches === true
    && empty.active.ready
    && empty.active.digestMatchesSnapshot;
  return empty;
}

export async function deactivateCatalogDevSource(options: {
  cwd: string;
  workspaceRoot?: string;
  sourceId?: string;
  replacementPrimary?: string;
  yes?: boolean;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogDevSourceRuntime;
}): Promise<CatalogDevDeactivateReceipt> {
  if (options.workspaceRoot !== undefined && options.sourceId !== undefined) {
    throw new CatalogDevSourceError('invalidArguments', '--workspace-root and --source-id are mutually exclusive.');
  }
  const config = await readCatalogSourcesConfigSnapshot(options.env).catch(() => {
    throw new CatalogDevSourceError('sourceConfigInvalid', 'Catalog source configuration is invalid.');
  });
  let source: PathCatalogSource | undefined;
  let workspaceIdentity: string;
  let workspaceRoot: string;
  if (options.sourceId !== undefined) {
    assertExplicitSourceId(options.sourceId);
    const configuredSource = config.config.sources.find((entry) => entry.id === options.sourceId);
    if (configuredSource?.type !== 'path' || configuredSource.managedBy?.kind !== 'catalog-workspace') {
      throw new CatalogDevSourceError('managedSourceNotFound', 'The source is not a Workspace-managed path source.');
    }
    source = configuredSource;
    workspaceIdentity = configuredSource.managedBy.workspaceIdentity;
    workspaceRoot = options.cwd;
  } else {
    const resolved = await resolveWorkspace(options.cwd, options.workspaceRoot);
    workspaceIdentity = resolved.workspace.workspaceIdentity;
    workspaceRoot = resolved.workspace.workspaceRoot;
    const owned = managedSources(config.config.sources, workspaceIdentity);
    if (owned.length > 1) {
      throw new CatalogDevSourceError('multipleManagedSources', 'Workspace owns multiple development sources.');
    }
    source = owned[0];
  }
  if (!source) {
    return {
      receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: true, state: 'completed',
      workspaceIdentity, source: { id: null, action: 'absent', previousPrimary: false },
      replacementPrimarySourceId: null, impact: null, recovery: [], errors: [],
    };
  }
  let replacementPrimarySourceId: string | null = null;
  if (source.primary) {
    const others = config.config.sources.filter((entry) => entry.id !== source!.id);
    const requested = options.replacementPrimary === undefined
      ? others.find(isDefaultOfficialCatalogSource)
        ?? (others.length === 1 ? others[0] : undefined)
      : others.find((entry) => entry.id === options.replacementPrimary);
    if (!requested) {
      return {
        receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: false, state: 'failed',
        workspaceIdentity, source: { id: source.id, action: 'retained', previousPrimary: true },
        replacementPrimarySourceId: null,
        impact: null,
        recovery: ['Select an existing replacement primary source.'],
        errors: [{ code: 'replacementPrimaryUnavailable', message: 'A replacement primary source is required.' }],
      };
    }
    replacementPrimarySourceId = requested.id;
  } else if (options.replacementPrimary !== undefined) {
    throw new CatalogDevSourceError('replacementPrimaryInvalid', '--replacement-primary requires a primary target source.');
  }
  const preview = await preflightCatalogSourceMutation({
    request: {
      action: 'remove',
      sourceId: source.id,
      ...(replacementPrimarySourceId === null ? {} : { replacementPrimarySourceId }),
    },
    cwd: workspaceRoot,
    env: options.env,
    managedByWorkspaceIdentity: workspaceIdentity,
  });
  const impact = preview.references;
  if (options.sourceId !== undefined && options.yes !== true) {
    return {
      receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: false, state: 'failed',
      workspaceIdentity,
      source: { id: source.id, action: 'retained', previousPrimary: source.primary },
      replacementPrimarySourceId,
      impact,
      recovery: ['Rerun with --source-id and --yes.'],
      errors: [{ code: 'confirmationRequired', message: 'Recovery by source ID requires --yes.' }],
    };
  }
  if ((!impact.inventoryComplete || impact.references.length > 0) && options.yes !== true) {
    return {
      receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: false, state: 'failed',
      workspaceIdentity,
      source: { id: source.id, action: 'retained', previousPrimary: source.primary },
      replacementPrimarySourceId,
      impact,
      recovery: ['Review the source impact, then rerun catalog dev deactivate with --yes.'],
      errors: [{
        code: 'catalogSourceImpactConfirmationRequired',
        message: 'Affected or unknown Catalog source references require --yes.',
      }],
    };
  }
  try {
    await removeCatalogSourceCommand({
      sourceId: source.id, cwd: workspaceRoot, env: options.env,
      runtime: options.runtime?.sourceRuntime,
      managedByWorkspaceIdentity: workspaceIdentity,
      expectedConfigDigest: preview.configDigest,
      expectedImpactDigest: preview.impactDigest,
      requireImpactConfirmation: true,
      confirmImpact: options.yes === true,
      ...(replacementPrimarySourceId === null ? {} : { replacementPrimarySourceId }),
    });
    return {
      receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: true, state: 'completed',
      workspaceIdentity, source: { id: source.id, action: 'removed', previousPrimary: source.primary },
      replacementPrimarySourceId, impact, recovery: [], errors: [],
    };
  } catch (error) {
    const after = await readCatalogSourcesConfigSnapshot(options.env).catch(() => null);
    const stillExists = after?.config.sources.some((entry) => entry.id === source!.id) ?? true;
    const configChanged = after !== null && after.digest !== preview.configDigest;
    const stale = error instanceof CatalogSourcesConfigConflictError || configChanged;
    return {
      receiptSchemaVersion: 3, command: 'catalog:dev:deactivate', ok: false,
      state: stale ? 'failed' : !stillExists ? 'partial' : 'failed', workspaceIdentity,
      source: { id: source.id, action: stillExists ? 'retained' : 'removed', previousPrimary: source.primary },
      replacementPrimarySourceId,
      impact: failureImpact(error, impact),
      recovery: ['Fix the source configuration, then rerun catalog dev deactivate.'],
      errors: [stale
        ? { code: 'operationReviewStale', message: 'Catalog source evidence changed. Review it again.' }
        : codedFailure(error, 'sourceConfigFailed')],
    };
  }
}
