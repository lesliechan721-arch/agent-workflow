import crypto from 'node:crypto';
import path from 'node:path';

import {
  DEFAULT_CATALOG_OUTPUT_PATH,
  readCatalogWorkspace,
  validateCatalogSnapshotComplete,
} from '@lesliechan721/aw-plugin-core';

import { runCatalogBuildCommand } from '../authoring/workspace-commands.js';
import type { CatalogSource, PathCatalogSource } from '../types.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import { catalogSourceCacheInternal } from '../utils/catalog-source-cache.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';
import {
  CATALOG_SOURCE_ID_PATTERN,
  isDefaultOfficialCatalogSource,
  readCatalogSourcesConfigSnapshot,
} from '../utils/catalog-sources.js';
import {
  addCatalogSourceCommand,
  refreshCatalogSourceCommand,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
  type CatalogSourceCommandRuntime,
} from './catalog-source.js';
import { getCatalogStatus } from './catalog-status.js';
import { resolveCatalogWorkspaceRoot } from './catalog-workspace-resolution.js';

type Issue = { code: string; message: string; blocking: boolean };

export interface CatalogDevActivateReceipt {
  receiptSchemaVersion: 1;
  command: 'catalog:dev:activate';
  ok: boolean;
  state: 'completed' | 'partial';
  workspaceIdentity: string | null;
  snapshot: { path: string; action: 'reused' | 'built'; digest: string | null };
  source: { id: string; action: 'added' | 'updated' | 'reused'; primary: boolean };
  recovery: string[];
  errors: Array<{ code: string; message: string }>;
}

export interface CatalogDevStatusReceipt {
  receiptSchemaVersion: 1;
  command: 'catalog:dev:status';
  ok: boolean;
  workspaceIdentity: string | null;
  workspaceRoot: string;
  snapshot: {
    path: string;
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
  cache: {
    state: 'not-applicable' | 'absent' | 'current' | 'last-good';
    validatedAt: string | null;
    snapshotDigest: string | null;
  };
  issues: Issue[];
}

export interface CatalogDevDeactivateReceipt {
  receiptSchemaVersion: 1;
  command: 'catalog:dev:deactivate';
  ok: boolean;
  state: 'completed' | 'partial';
  workspaceIdentity: string | null;
  snapshotPath: string;
  source: { id: string | null; action: 'removed' | 'absent' | 'retained'; previousPrimary: boolean };
  replacementPrimarySourceId: string | null;
  recovery: string[];
  errors: Array<{ code: string; message: string }>;
}

export type CatalogDevSourceRuntime = {
  sourceRuntime?: CatalogSourceCommandRuntime;
};

function managedSources(sources: CatalogSource[], workspaceIdentity: string): PathCatalogSource[] {
  return sources.filter((source): source is PathCatalogSource => source.type === 'path'
    && source.managedBy?.kind === 'catalog-workspace'
    && source.managedBy.workspaceIdentity === workspaceIdentity);
}

function normalizeSuggestedSourceId(workspaceRoot: string): string {
  const stem = path.basename(workspaceRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
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

function assertExplicitSourceId(sourceId: string): void {
  if (!CATALOG_SOURCE_ID_PATTERN.test(sourceId)) {
    throw new CatalogDevSourceError('invalidSourceId', `Invalid catalog development source ID: expected ${CATALOG_SOURCE_ID_PATTERN}.`);
  }
}

class CatalogDevSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CatalogDevSourceError';
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
  const snapshotPath = path.join(workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH);
  if (options.command === 'activate') {
    return {
      receiptSchemaVersion: 1,
      command: 'catalog:dev:activate',
      ok: false,
      state: 'completed',
      workspaceIdentity: null,
      snapshot: { path: snapshotPath, action: 'reused', digest: null },
      source: {
        id: options.sourceId ?? suggestedCatalogDevSourceId(workspaceRoot),
        action: 'reused',
        primary: false,
      },
      recovery: ['Fix the reported problem, then rerun catalog dev activate.'],
      errors: [{ code: options.code, message: options.message }],
    };
  }
  if (options.command === 'status') {
    return {
      receiptSchemaVersion: 1,
      command: 'catalog:dev:status',
      ok: false,
      workspaceIdentity: null,
      workspaceRoot,
      snapshot: { path: snapshotPath, state: 'absent', valid: false, digest: null },
      source: { exists: false, id: null, pathMatches: null, primary: null },
      cache: { state: 'not-applicable', validatedAt: null, snapshotDigest: null },
      issues: [{ code: options.code, message: options.message, blocking: true }],
    };
  }
  return {
    receiptSchemaVersion: 1,
    command: 'catalog:dev:deactivate',
    ok: false,
    state: 'completed',
    workspaceIdentity: null,
    snapshotPath,
    source: { id: null, action: 'absent', previousPrimary: false },
    replacementPrimarySourceId: null,
    recovery: ['Fix the reported problem, then rerun catalog dev deactivate.'],
    errors: [{ code: options.code, message: options.message }],
  };
}

function codedFailure(error: unknown, fallbackCode: string): { code: string; message: string } {
  return {
    code: error instanceof CatalogDevSourceError ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
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
  } catch (error) {
    throw new CatalogDevSourceError(
      'workspaceInvalid',
      error instanceof Error ? error.message : String(error),
    );
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
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogDevSourceRuntime;
}): Promise<CatalogDevActivateReceipt> {
  const { resolved, workspace } = await resolveWorkspace(options.cwd, options.workspaceRoot);
  const snapshotPath = path.join(workspace.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH);
  const staticStatus = await getCatalogStatus({
    cwd: options.cwd,
    workspaceRoot: workspace.workspaceRoot,
    env: options.env,
  });
  let snapshotAction: 'reused' | 'built' = 'reused';
  let snapshotDigest = staticStatus.snapshot.snapshotDigest;
  const shouldBuild = options.forceBuild === true || staticStatus.snapshot.state !== 'current';
  if (shouldBuild) {
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
        receiptSchemaVersion: 1,
        command: 'catalog:dev:activate',
        ok: false,
        state: 'completed',
        workspaceIdentity: workspace.workspaceIdentity,
        snapshot: { path: snapshotPath, action: 'built', digest: null },
        source: { id: options.sourceId ?? normalizeSuggestedSourceId(workspace.workspaceRoot), action: 'reused', primary: false },
        recovery: ['Fix the Catalog Workspace or snapshot output, then rerun catalog dev activate.'],
        errors: [codedFailure(error, 'snapshotBuildFailed')],
      };
    }
  }

  let selectedId = options.sourceId ?? normalizeSuggestedSourceId(workspace.workspaceRoot);
  let sourceAction: 'added' | 'updated' | 'reused' = 'reused';
  try {
    const result = await withAwHomeMutationLock({
      env: options.env,
      action: async (awHomeMutationToken) => {
        const configSnapshot = await readCatalogSourcesConfigSnapshot(options.env);
        const owned = managedSources(configSnapshot.config.sources, workspace.workspaceIdentity);
        if (owned.length > 1) {
          throw new CatalogDevSourceError('multipleManagedSources', `Catalog Workspace identity ${workspace.workspaceIdentity} owns multiple development sources: ${owned.map((source) => source.id).join(', ')}.`);
        }
        const existing = owned[0];
        selectedId = options.sourceId ?? normalizeSuggestedSourceId(workspace.workspaceRoot);
        if (options.sourceId !== undefined) {
          assertExplicitSourceId(options.sourceId);
          if (existing && existing.id !== options.sourceId) {
            throw new CatalogDevSourceError('sourceIdConflict', `Catalog Workspace already owns development source "${existing.id}"; it cannot also own "${options.sourceId}".`);
          }
          const collision = configSnapshot.config.sources.find((source) => source.id === options.sourceId);
          if (collision && collision !== existing) {
            throw new CatalogDevSourceError('sourceIdConflict', `Catalog source "${options.sourceId}" is owned by another Workspace or is foreign.`);
          }
        } else if (!existing && configSnapshot.config.sources.some((source) => source.id === selectedId)) {
          selectedId = suffixedSourceId(selectedId, workspace.workspaceIdentity);
          if (configSnapshot.config.sources.some((source) => source.id === selectedId)) {
            throw new CatalogDevSourceError('sourceIdConflict', `Deterministic Catalog development source ID "${selectedId}" is already in use.`);
          }
        }
        if (existing) selectedId = existing.id;
        const runtime = { ...options.runtime?.sourceRuntime, awHomeMutationToken };
        if (!existing) {
          sourceAction = 'added';
          return addCatalogSourceCommand({
            source: {
              id: selectedId,
              type: 'path',
              path: snapshotPath,
              primary: options.primary === true,
              managedBy: { kind: 'catalog-workspace', workspaceIdentity: workspace.workspaceIdentity },
            },
            cliVersion: options.cliVersion,
            cwd: workspace.workspaceRoot,
            env: options.env,
            runtime,
            managedByWorkspaceIdentity: workspace.workspaceIdentity,
          });
        }
        if (existing.path !== snapshotPath || (options.primary === true && !existing.primary)) {
          sourceAction = 'updated';
          const updated = existing.path === snapshotPath
            ? { errors: [] }
            : await updateCatalogSourceCommand({
                sourceId: existing.id,
                update: { type: 'path', path: snapshotPath },
                cliVersion: options.cliVersion,
                cwd: workspace.workspaceRoot,
                env: options.env,
                runtime,
                managedByWorkspaceIdentity: workspace.workspaceIdentity,
              });
          if (options.primary === true && !existing.primary) {
            await setPrimaryCatalogSourceCommand({
              sourceId: existing.id,
              cwd: workspace.workspaceRoot,
              env: options.env,
              runtime,
            });
          }
          if (existing.path !== snapshotPath) return updated;
          const refreshed = await refreshCatalogSourceCommand({
            sourceId: existing.id,
            cliVersion: options.cliVersion,
            env: options.env,
            runtime,
          });
          return { errors: refreshed.errors };
        }
        const refreshed = await refreshCatalogSourceCommand({
          sourceId: existing.id,
          cliVersion: options.cliVersion,
          env: options.env,
          runtime,
        });
        return { errors: refreshed.errors };
      },
    });
    const configured = (await readCatalogSourcesConfigSnapshot(options.env)).config.sources
      .find((source) => source.id === selectedId)!;
    const refreshErrors = result.errors.length === 0 ? [] : [{
      code: 'sourceRefreshFailed',
      message: result.errors.map((error) => error.message).join('; '),
    }];
    return {
      receiptSchemaVersion: 1,
      command: 'catalog:dev:activate',
      ok: refreshErrors.length === 0,
      state: refreshErrors.length === 0 ? 'completed' : 'partial',
      workspaceIdentity: workspace.workspaceIdentity,
      snapshot: { path: snapshotPath, action: snapshotAction, digest: snapshotDigest },
      source: { id: selectedId, action: sourceAction, primary: configured.primary },
      recovery: refreshErrors.length === 0 ? [] : [
        'Fix the Catalog snapshot, then rerun catalog dev activate or refresh the source.',
      ],
      errors: refreshErrors,
    };
  } catch (error) {
    return {
      receiptSchemaVersion: 1,
      command: 'catalog:dev:activate',
      ok: false,
      state: 'completed',
      workspaceIdentity: workspace.workspaceIdentity,
      snapshot: { path: snapshotPath, action: snapshotAction, digest: snapshotDigest },
      source: { id: selectedId, action: sourceAction, primary: false },
      recovery: ['The snapshot was kept. Fix the source configuration, then rerun catalog dev activate.'],
      errors: [codedFailure(error, 'sourceConfigFailed')],
    };
  }
}

export async function getCatalogDevSourceStatus(options: {
  cwd: string;
  workspaceRoot?: string;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogDevStatusReceipt> {
  const requestedRoot = path.resolve(options.cwd, options.workspaceRoot ?? '.');
  const empty: CatalogDevStatusReceipt = {
    receiptSchemaVersion: 1,
    command: 'catalog:dev:status',
    ok: false,
    workspaceIdentity: null,
    workspaceRoot: requestedRoot,
    snapshot: { path: path.join(requestedRoot, DEFAULT_CATALOG_OUTPUT_PATH), state: 'absent', valid: false, digest: null },
    source: { exists: false, id: null, pathMatches: null, primary: null },
    cache: { state: 'not-applicable', validatedAt: null, snapshotDigest: null },
    issues: [],
  };
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    workspace = await resolveWorkspace(options.cwd, options.workspaceRoot);
  } catch (error) {
    empty.issues.push({ code: 'workspaceInvalid', message: codedFailure(error, 'workspaceInvalid').message, blocking: true });
    return empty;
  }
  const staticStatus = await getCatalogStatus({
    cwd: options.cwd,
    workspaceRoot: workspace.workspace.workspaceRoot,
    env: options.env,
  });
  const receipt: CatalogDevStatusReceipt = {
    ...empty,
    workspaceIdentity: workspace.workspace.workspaceIdentity,
    workspaceRoot: workspace.workspace.workspaceRoot,
    snapshot: {
      path: staticStatus.snapshot.path,
      state: staticStatus.snapshot.state,
      valid: staticStatus.snapshot.valid,
      digest: staticStatus.snapshot.snapshotDigest,
    },
  };
  if (staticStatus.snapshot.state !== 'current') {
    receipt.issues.push({
      code: `snapshot${staticStatus.snapshot.state[0]!.toUpperCase()}${staticStatus.snapshot.state.slice(1)}`,
      message: `Catalog development snapshot is ${staticStatus.snapshot.state}.`,
      blocking: true,
    });
  }
  try {
    const config = await readCatalogSourcesConfigSnapshot(options.env);
    const owned = managedSources(config.config.sources, workspace.workspace.workspaceIdentity);
    if (owned.length > 1) {
      receipt.issues.push({
        code: 'multipleManagedSources',
        message: `Workspace owns multiple development sources: ${owned.map((source) => source.id).join(', ')}.`,
        blocking: true,
      });
    }
    const source = owned.length === 1 ? owned[0]! : null;
    if (!source) {
      receipt.issues.push({ code: 'sourceInactive', message: 'Workspace has no active development source.', blocking: false });
      const suggested = normalizeSuggestedSourceId(workspace.workspace.workspaceRoot);
      const collision = config.config.sources.find((entry) => entry.id === suggested);
      if (collision) {
        receipt.issues.push({
          code: 'suggestedSourceIdCollision',
          message: `Suggested source ID "${suggested}" is owned by another Workspace or is foreign.`,
          blocking: false,
        });
      }
    } else {
      const pathMatches = source.path === receipt.snapshot.path;
      receipt.source = { exists: true, id: source.id, pathMatches, primary: source.primary };
      if (!pathMatches) {
        receipt.issues.push({
          code: 'sourcePathMismatch',
          message: 'Managed development source path does not match the current Workspace snapshot.',
          blocking: true,
        });
      }
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const location = catalogSourceCacheInternal.resolveCatalogSourceCacheLocation({
        sourceId: source.id,
        sourceIdentity,
        env: options.env,
      });
      const entry = await catalogSourceCacheInternal.readCatalogSourceCache({
        location,
        sourceId: source.id,
        sourceIdentity,
        requestedRef: 'path',
        cliVersion: options.cliVersion,
      });
      receipt.cache = entry ? {
        state: entry.entryDir === location.currentDir ? 'current' : 'last-good',
        validatedAt: entry.metadata.validatedAt,
        snapshotDigest: entry.metadata.snapshotDigest,
      } : { state: 'absent', validatedAt: null, snapshotDigest: null };
    }
  } catch (error) {
    receipt.issues.push({ code: 'sourceConfigInvalid', message: codedFailure(error, 'sourceConfigInvalid').message, blocking: true });
  }
  receipt.ok = !receipt.issues.some((issue) => issue.blocking);
  return receipt;
}

export async function deactivateCatalogDevSource(options: {
  cwd: string;
  workspaceRoot?: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogDevSourceRuntime;
}): Promise<CatalogDevDeactivateReceipt> {
  const { workspace } = await resolveWorkspace(options.cwd, options.workspaceRoot);
  const snapshotPath = path.join(workspace.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH);
  const config = await readCatalogSourcesConfigSnapshot(options.env).catch((error: unknown) => {
    throw new CatalogDevSourceError('sourceConfigInvalid', error instanceof Error ? error.message : String(error));
  });
  const owned = managedSources(config.config.sources, workspace.workspaceIdentity);
  const base = {
    receiptSchemaVersion: 1 as const,
    command: 'catalog:dev:deactivate' as const,
    workspaceIdentity: workspace.workspaceIdentity,
    snapshotPath,
  };
  if (owned.length > 1) {
    return {
      ...base, ok: false, state: 'completed',
      source: { id: null, action: 'retained', previousPrimary: false },
      replacementPrimarySourceId: null,
      recovery: ['Resolve the duplicate managed source configuration, then rerun catalog dev deactivate.'],
      errors: [{ code: 'multipleManagedSources', message: `Workspace owns multiple development sources: ${owned.map((source) => source.id).join(', ')}.` }],
    };
  }
  const source = owned[0];
  if (!source) {
    return {
      ...base, ok: true, state: 'completed',
      source: { id: null, action: 'absent', previousPrimary: false },
      replacementPrimarySourceId: null,
      recovery: [], errors: [],
    };
  }
  let replacementPrimarySourceId: string | null = null;
  if (source.primary) {
    const otherSources = config.config.sources.filter((entry) => entry.id !== source.id);
    const official = otherSources.find(isDefaultOfficialCatalogSource);
    if (official) replacementPrimarySourceId = official.id;
    else if (otherSources.length === 1) replacementPrimarySourceId = otherSources[0]!.id;
    else {
      return {
        ...base, ok: false, state: 'completed',
        source: { id: source.id, action: 'retained', previousPrimary: true },
        replacementPrimarySourceId: null,
        recovery: ['Select a replacement primary source, then rerun catalog dev deactivate.'],
        errors: [{
          code: otherSources.length === 0 ? 'replacementPrimaryUnavailable' : 'replacementPrimaryAmbiguous',
          message: otherSources.length === 0
            ? 'No replacement primary Catalog source is available.'
            : `Replacement primary Catalog source is ambiguous: ${otherSources.map((entry) => entry.id).join(', ')}.`,
        }],
      };
    }
  }
  try {
    await withAwHomeMutationLock({
      env: options.env,
      action: async (awHomeMutationToken) => {
        const lockedConfig = await readCatalogSourcesConfigSnapshot(options.env);
        if (lockedConfig.digest !== config.digest) {
          throw new CatalogDevSourceError('sourceConfigChanged', 'Catalog sources config changed before development source deactivation. Rerun the command.');
        }
        const runtime = { ...options.runtime?.sourceRuntime, awHomeMutationToken };
        if (replacementPrimarySourceId) {
          await setPrimaryCatalogSourceCommand({
            sourceId: replacementPrimarySourceId,
            cwd: workspace.workspaceRoot,
            env: options.env,
            runtime,
          });
        }
        await removeCatalogSourceCommand({
          sourceId: source.id,
          cwd: workspace.workspaceRoot,
          env: options.env,
          runtime,
          managedByWorkspaceIdentity: workspace.workspaceIdentity,
        });
      },
    });
    return {
      ...base, ok: true, state: 'completed',
      source: { id: source.id, action: 'removed', previousPrimary: source.primary },
      replacementPrimarySourceId,
      recovery: [], errors: [],
    };
  } catch (error) {
    const after = await readCatalogSourcesConfigSnapshot(options.env).catch(() => null);
    const sourceStillExists = after?.config.sources.some((entry) => entry.id === source.id) ?? true;
    const configChanged = after !== null && after.digest !== config.digest;
    return {
      ...base, ok: false, state: configChanged ? 'partial' : 'completed',
      source: { id: source.id, action: sourceStillExists ? 'retained' : 'removed', previousPrimary: source.primary },
      replacementPrimarySourceId,
      recovery: ['The snapshot was kept. Fix the source configuration or cache, then rerun catalog dev deactivate.'],
      errors: [codedFailure(error, 'sourceConfigFailed')],
    };
  }
}
