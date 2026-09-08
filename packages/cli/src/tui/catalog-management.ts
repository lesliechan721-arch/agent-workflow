import crypto from 'node:crypto';
import path from 'node:path';

import {
  assertCatalogVersion,
  calculateCatalogWorkspaceSourceIdentity,
  CATALOG_WORKSPACE_MARKER_FILENAME,
  DEFAULT_CATALOG_OUTPUT_PATH,
  readCatalogWorkspace,
  type CatalogVersionBump,
} from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';

import {
  runCatalogBuildCommand,
  runCatalogInitCommand,
  runCatalogValidateCommand,
  runCatalogVersionCommand,
} from '../authoring/workspace-commands.js';
import {
  activateCatalogDevSource,
  deactivateCatalogDevSource,
  getCatalogDevSourceStatus,
  preflightCatalogDevSourceActivation,
  type CatalogDevActivationReviewEvidence,
} from '../commands/catalog-dev-source.js';
import { preflightCatalogSourceMutation } from '../commands/catalog-source.js';
import {
  applyCatalogPublicationPlan,
  prepareCatalogPublicationPlan,
  safeRemoteIdentity,
} from '../commands/catalog-publish.js';
import {
  discoverCatalogPublicationJournals,
  findCatalogPublicationJournalByPlanDigest,
  type CatalogPublicationJournalDiscovery,
} from '../commands/catalog-publication-journal.js';
import { inspectCatalogPublicationApplyContext } from '../commands/catalog-publication-inspection.js';
import {
  catalogStorePrune,
  catalogStoreStatus,
  type CatalogStoreEntryCategory,
  type CatalogStorePruneItemKey,
} from '../commands/catalog-store.js';
import { getCatalogStatus } from '../commands/catalog-status.js';
import { resolveCatalogPublicationTarget } from '../commands/catalog-publication-target.js';
import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolvedFrom,
} from '../commands/catalog-workspace-resolution.js';
import type { CliExecutionContext } from '../commands/runtime.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js';
import {
  CATALOG_SOURCE_ID_PATTERN,
  isDefaultOfficialCatalogSource,
  readCatalogSourcesConfigSnapshot,
} from '../utils/catalog-sources.js';
import { sanitizeDiagnosticText } from './diagnostics.js';

export interface CatalogManagementIssue {
  code: string;
  message: string;
  blocking: boolean;
}

export interface CatalogWorkspaceManagementViewModel {
  state: 'missing' | 'invalid' | 'ready';
  selected: boolean;
  label: string;
  resolvedFrom: CatalogWorkspaceResolvedFrom | null;
  identity: string | null;
  catalog: {
    version: string | null;
    channel: 'latest' | 'beta' | null;
    ownerName: string | null;
    ownerUrl: string | null;
    displayName: string | null;
  };
  plugins: Array<{ name: string; version: string; dependencies: string[] }>;
  dependencyGraphValid: boolean;
  git: {
    checked: boolean;
    clean: boolean | null;
    hasHead: boolean;
  };
  snapshot: {
    state: 'absent' | 'current' | 'stale' | 'invalid';
    valid: boolean;
    catalogVersion: string | null;
    hasDigest: boolean;
    sourceIdentityMatches: boolean | null;
  };
  issues: CatalogManagementIssue[];
}

export interface CatalogValidationViewModel {
  state: 'absent' | 'invalid' | 'valid';
  catalogVersion: string | null;
  channel: 'latest' | 'beta' | null;
  hasSnapshotDigest: boolean;
  issues: CatalogManagementIssue[];
}

export interface CatalogDevManagementViewModel {
  state: 'workspaceUnavailable' | 'inactive' | 'needsAttention' | 'ready';
  ready: boolean;
  workspaceIdentity: string | null;
  snapshot: {
    state: 'absent' | 'current' | 'stale' | 'invalid';
    valid: boolean;
    hasDigest: boolean;
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
    compatibility: 'supported' | 'unsupported' | null;
  };
  issues: CatalogManagementIssue[];
}

export interface CatalogStoreManagementEntryViewModel {
  item: CatalogStorePruneItemKey;
  itemKey: string;
  category: CatalogStoreEntryCategory;
  status: 'active' | 'reclaimable' | 'retained' | 'error';
  generationReference: 'active' | 'orphan' | 'none';
  ageMs: number | null;
  reclaimableBytes: number | null;
  reason: string;
}

export interface CatalogStoreManagementViewModel {
  state: 'ready' | 'needsAttention';
  entries: CatalogStoreManagementEntryViewModel[];
  totals: {
    entries: number;
    reclaimableEntries: number;
    reclaimableBytes: number | null;
    retainedEntries: number;
  };
  issues: CatalogManagementIssue[];
}

export interface CatalogPublicationRecordViewModel {
  catalogVersion: string;
  state: 'prepared' | 'uncertain' | 'published' | 'damaged';
  channel: 'latest' | 'beta' | null;
  pluginCount: number | null;
  planDigest: string | null;
  remote: string | null;
  branch: string | null;
  canApply: boolean;
  requiresRemoteInput: boolean;
  mustIncreaseVersion: boolean;
  localRepositoryState: 'present' | 'absent' | 'notRequired' | 'unexpected';
  issue?: CatalogManagementIssue;
}

export interface CatalogPublicationManagementViewModel {
  state: 'none' | 'pending' | 'published' | 'needsAttention';
  records: CatalogPublicationRecordViewModel[];
  issues: CatalogManagementIssue[];
}

export type CatalogManagementIntent =
  | {
      kind: 'catalogManagement';
      action: 'workspaceInit';
      ownerName?: string;
      ownerUrl?: string;
      displayName?: string;
      catalogVersion?: string;
      force?: boolean;
    }
  | {
      kind: 'catalogManagement';
      action: 'workspaceVersion';
      version?: string;
      bump?: CatalogVersionBump;
    }
  | {
      kind: 'catalogManagement';
      action: 'workspaceBuild';
      force?: boolean;
    }
  | {
      kind: 'catalogManagement';
      action: 'devActivate';
      sourceId?: string;
      primary?: boolean;
      forceBuild?: boolean;
    }
  | {
      kind: 'catalogManagement';
      action: 'devDeactivate';
      replacementPrimary?: string;
    }
  | {
      kind: 'catalogManagement';
      action: 'storePrune';
      items: CatalogStorePruneItemKey[];
    }
  | {
      kind: 'catalogManagement';
      action: 'publishPlan';
      remote?: string;
      remoteUrl?: string;
      branch?: string;
    }
  | {
      kind: 'catalogManagement';
      action: 'publishApply';
      expectedPlanDigest: string;
      remote?: string;
      remoteUrl?: string;
      branch?: string;
    };

export interface CatalogManagementReviewEvidence {
  action: CatalogManagementIntent['action'];
  workspaceBinding: string | null;
  evidenceDigest: string;
  workspace?: CatalogWorkspaceManagementViewModel;
  workspaceStateDigest?: string;
  dev?: CatalogDevManagementViewModel;
  devActivation?: {
    evidenceDigest: string;
    sourceId: string;
    catalogVersion: string;
    inventoryComplete: boolean;
    primaryChange: boolean;
    references: {
      installation: number;
      config: number;
      lifecycle: number;
      marketplace: number;
    };
    changes: {
      added: number;
      removed: number;
      changed: number;
      newlyIncompatible: number;
      dependencyChanged: number;
      platformSupportChanged: number;
    };
  };
  devImpact?: {
    evidenceDigest: string;
    inventoryComplete: boolean;
    primaryChange: boolean;
    references: {
      installation: number;
      config: number;
      lifecycle: number;
      marketplace: number;
    };
  };
  store?: CatalogStoreManagementViewModel;
  authorizedStoreItems?: CatalogStorePruneItemKey[];
  publication?: CatalogPublicationRecordViewModel;
  target?: {
    remote: string | null;
    branch: string;
  };
}

export interface CatalogManagementExecutionResult {
  action: CatalogManagementIntent['action'];
  state: 'succeeded' | 'partial';
  message: string;
  messages: string[];
  catalogVersion?: string;
  planDigest?: string;
  store?: {
    deletedEntries: number;
    deletedBytes: number;
    retainedEntries: number;
  };
  publication?: {
    catalogVersion: string;
    planDigest: string;
    state: 'prepared' | 'uncertain' | 'published';
    remote: string;
    branch: string;
  };
}

export type CatalogManagementProgressStage =
  | 'validate'
  | 'build'
  | 'source'
  | 'sync'
  | 'prune'
  | 'prepare'
  | 'remote'
  | 'verify';

export interface CatalogManagementService {
  selectWorkspace(workspaceRoot?: string): Promise<CatalogWorkspaceManagementViewModel>;
  getWorkspace(): Promise<CatalogWorkspaceManagementViewModel>;
  validateWorkspace(): Promise<CatalogValidationViewModel>;
  getDev(): Promise<CatalogDevManagementViewModel>;
  getStore(): Promise<CatalogStoreManagementViewModel>;
  getPublication(): Promise<CatalogPublicationManagementViewModel>;
  captureEvidence(intent: CatalogManagementIntent): Promise<CatalogManagementReviewEvidence>;
  execute(
    intent: CatalogManagementIntent,
    expected: CatalogManagementReviewEvidence,
    onProgress?: (stage: CatalogManagementProgressStage) => void | Promise<void>,
  ): Promise<CatalogManagementExecutionResult>;
}

export class CatalogManagementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CatalogManagementError';
  }
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function storeItemKey(item: CatalogStorePruneItemKey): string {
  return digest([item.category, item.storeKey]).slice('sha256:'.length, 'sha256:'.length + 16);
}

function safeIssue(
  issue: { code?: unknown; message: string; blocking?: boolean },
  sensitiveRoots: readonly string[],
  sensitiveValues: readonly string[] = [],
): CatalogManagementIssue {
  return {
    code: typeof issue.code === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u.test(issue.code)
      ? issue.code
      : 'catalogManagementFailed',
    message: sanitizeDiagnosticText(issue.message, sensitiveRoots, sensitiveValues),
    blocking: issue.blocking !== false,
  };
}

function thrownIssue(
  error: unknown,
  sensitiveRoots: readonly string[],
  sensitiveValues: readonly string[] = [],
): CatalogManagementIssue {
  const candidate = error as { code?: unknown; message?: unknown };
  return safeIssue({
    code: candidate?.code,
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
  }, sensitiveRoots, sensitiveValues);
}

function safeWorkspaceLabel(workspaceRoot: string): string {
  return path.basename(workspaceRoot) || 'Catalog Workspace';
}

function safeRemoteLabel(remote?: string, remoteUrl?: string): string | null {
  if (remoteUrl !== undefined) return sanitizeDiagnosticText(safeRemoteIdentity(remoteUrl));
  return remote === undefined ? null : sanitizeDiagnosticText(remote);
}

function intentSensitiveValues(intent: CatalogManagementIntent): string[] {
  return [
    'ownerName' in intent ? intent.ownerName : undefined,
    'ownerUrl' in intent ? intent.ownerUrl : undefined,
    'displayName' in intent ? intent.displayName : undefined,
    'remoteUrl' in intent ? intent.remoteUrl : undefined,
  ].filter((value): value is string => value !== undefined && value !== '');
}

function projectPublicationRecord(
  entry: CatalogPublicationJournalDiscovery,
  sensitiveRoot: string,
): CatalogPublicationRecordViewModel {
  if (entry.state === 'damaged') {
    return {
      catalogVersion: entry.catalogVersion,
      state: 'damaged',
      channel: null,
      pluginCount: null,
      planDigest: null,
      remote: null,
      branch: null,
      canApply: false,
      requiresRemoteInput: false,
      mustIncreaseVersion: true,
      localRepositoryState: 'absent',
      issue: safeIssue({
        code: 'catalogPublicationStateDamaged',
        message: `Catalog ${entry.catalogVersion} publication state is damaged. Increase the Catalog version.`,
      }, [sensitiveRoot]),
    };
  }
  return {
    catalogVersion: entry.journal.display.catalogVersion,
    state: entry.journal.state,
    channel: entry.journal.display.channel,
    pluginCount: entry.journal.display.pluginCount,
    planDigest: entry.journal.planDigest,
    remote: entry.journal.descriptor.remote.name === null
      ? null
      : sanitizeDiagnosticText(entry.journal.descriptor.remote.name),
    branch: sanitizeDiagnosticText(entry.journal.descriptor.branch),
    canApply: true,
    requiresRemoteInput: entry.journal.descriptor.remote.name === null,
    mustIncreaseVersion: false,
    localRepositoryState: entry.journal.state === 'published'
      ? entry.localRepositoryState === 'present' ? 'unexpected' : 'notRequired'
      : 'present',
  };
}

class DefaultCatalogManagementService implements CatalogManagementService {
  #selectedWorkspaceRoot: string | undefined;
  #devActivationReviews = new Map<string, CatalogDevActivationReviewEvidence>();

  constructor(private readonly context: CliExecutionContext) {}

  sanitizeError(error: unknown, sensitiveValues: readonly string[] = []): CatalogManagementError {
    const issue = thrownIssue(error, [
      this.context.cwd,
      this.#requestedWorkspaceRoot(),
      ...(this.#selectedWorkspaceRoot ? [this.#selectedWorkspaceRoot] : []),
    ], sensitiveValues);
    return new CatalogManagementError(issue.code, issue.message);
  }

  async #resolveWorkspace(mode: 'existing' | 'initialize') {
    return resolveCatalogWorkspaceRoot({
      cwd: this.context.cwd,
      ...(this.#selectedWorkspaceRoot === undefined
        ? {}
        : { explicitRoot: this.#selectedWorkspaceRoot }),
      mode,
      env: this.context.env,
    });
  }

  #requestedWorkspaceRoot(): string {
    return this.#selectedWorkspaceRoot ?? this.context.cwd;
  }

  #workspaceBinding(): string {
    return digest(path.resolve(this.#requestedWorkspaceRoot()));
  }

  async #scaffoldStateDigest(workspaceRoot: string): Promise<string> {
    const fileState = async (filePath: string): Promise<unknown> => {
      const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return { kind: 'absent' };
      if (stat.isSymbolicLink()) return { kind: 'symlink' };
      if (stat.isFile()) return { kind: 'file', digest: digest(await fs.readFile(filePath)) };
      if (stat.isDirectory()) {
        return { kind: 'directory', entries: (await fs.readdir(filePath)).sort() };
      }
      return { kind: 'special' };
    };
    const rootStat = await fs.lstat(workspaceRoot);
    return digest({
      root: {
        kind: rootStat.isDirectory() && !rootStat.isSymbolicLink() ? 'directory' : 'invalid',
        device: rootStat.dev,
        inode: rootStat.ino,
      },
      marker: await fileState(path.join(workspaceRoot, CATALOG_WORKSPACE_MARKER_FILENAME)),
      metadata: await fileState(path.join(workspaceRoot, 'plugins', 'marketplace-source.json')),
      plugins: await fileState(path.join(workspaceRoot, 'plugins')),
      gitignore: await fileState(path.join(workspaceRoot, '.gitignore')),
    });
  }

  async #workspaceStateDigest(): Promise<string> {
    const status = await getCatalogStatus({
      cwd: this.context.cwd,
      ...(this.#selectedWorkspaceRoot === undefined
        ? {}
        : { workspaceRoot: this.#selectedWorkspaceRoot }),
      env: this.context.env,
    });
    const sourceIdentity = status.workspace.valid
      ? await calculateCatalogWorkspaceSourceIdentity(await readCatalogWorkspace(
          status.workspaceRoot,
          { reservedImports: CLI_RESERVED_IMPORTS },
        ))
      : await this.#scaffoldStateDigest(status.workspaceRoot);
    return digest({
      sourceIdentity,
      workspace: {
        valid: status.workspace.valid,
        identity: status.workspace.identity,
      },
      catalog: status.catalog,
      plugins: status.plugins,
      dependencyGraph: status.dependencyGraph,
      git: status.git,
      snapshot: {
        state: status.snapshot.state,
        valid: status.snapshot.valid,
        catalogVersion: status.snapshot.catalogVersion,
        snapshotDigest: status.snapshot.snapshotDigest,
        sourceIdentityMatches: status.snapshot.sourceIdentityMatches,
      },
      issues: status.issues.map((issue) => ({ code: issue.code, blocking: issue.blocking })),
    });
  }

  async #devDeactivationImpact(
    dev: CatalogDevManagementViewModel,
    replacementPrimary?: string,
  ): Promise<CatalogManagementReviewEvidence['devImpact']> {
    if (!dev.source.exists || dev.source.id === null || dev.workspaceIdentity === null) return undefined;
    const config = await readCatalogSourcesConfigSnapshot(this.context.env);
    const source = config.config.sources.find((entry) => entry.id === dev.source.id);
    if (!source) {
      throw new CatalogManagementError('operationReviewStale', 'Catalog development source changed before Review.');
    }
    let replacementPrimarySourceId: string | undefined;
    if (source.primary) {
      const others = config.config.sources.filter((entry) => entry.id !== source.id);
      const replacement = replacementPrimary === undefined
        ? others.find(isDefaultOfficialCatalogSource) ?? (others.length === 1 ? others[0] : undefined)
        : others.find((entry) => entry.id === replacementPrimary);
      if (!replacement) {
        throw new CatalogManagementError(
          'replacementPrimaryUnavailable',
          'Select an existing replacement primary source.',
        );
      }
      replacementPrimarySourceId = replacement.id;
    } else if (replacementPrimary !== undefined) {
      throw new CatalogManagementError(
        'replacementPrimaryInvalid',
        'A replacement primary source is only valid for a primary development source.',
      );
    }
    const resolved = await this.#resolveWorkspace('existing');
    const preview = await preflightCatalogSourceMutation({
      request: {
        action: 'remove',
        sourceId: source.id,
        ...(replacementPrimarySourceId ? { replacementPrimarySourceId } : {}),
      },
      cwd: resolved.workspaceRoot,
      env: this.context.env,
      managedByWorkspaceIdentity: dev.workspaceIdentity,
    });
    const references = {
      installation: preview.references.references.filter((entry) => entry.category === 'installation').length,
      config: preview.references.references.filter((entry) => entry.category === 'config').length,
      lifecycle: preview.references.references.filter((entry) => entry.category === 'lifecycle').length,
      marketplace: preview.references.references.filter((entry) => entry.category === 'marketplace').length,
    };
    return {
      evidenceDigest: digest({
        configDigest: preview.configDigest,
        proposedConfigDigest: preview.proposedConfigDigest,
        impactDigest: preview.impactDigest,
      }),
      inventoryComplete: preview.references.inventoryComplete,
      primaryChange: preview.references.primaryChange !== null,
      references,
    };
  }

  async #devActivationEvidence(
    intent: Extract<CatalogManagementIntent, { action: 'devActivate' }>,
  ): Promise<NonNullable<CatalogManagementReviewEvidence['devActivation']>> {
    const resolved = await this.#resolveWorkspace('existing');
    const packageInfo = await readCliPackageInfo();
    const preflight = await preflightCatalogDevSourceActivation({
      cwd: this.context.cwd,
      workspaceRoot: resolved.workspaceRoot,
      sourceId: intent.sourceId,
      primary: intent.primary,
      forceBuild: intent.forceBuild,
      cliVersion: packageInfo.version,
      env: this.context.env,
    });
    const evidenceDigest = digest(preflight.review);
    this.#devActivationReviews.set(evidenceDigest, preflight.review);
    const affectedReferences = new Map([
      ...(preflight.sourceImpact?.references ?? []),
      ...preflight.impacts.flatMap((impact) => impact.affectedReferences),
    ].map((reference) => [JSON.stringify(reference), reference]));
    const references = {
      installation: 0,
      config: 0,
      lifecycle: 0,
      marketplace: 0,
    };
    for (const reference of affectedReferences.values()) references[reference.category] += 1;
    const changeNames = {
      added: new Set<string>(),
      removed: new Set<string>(),
      changed: new Set<string>(),
      newlyIncompatible: new Set<string>(),
      dependencyChanged: new Set<string>(),
      platformSupportChanged: new Set<string>(),
    };
    for (const impact of preflight.impacts) {
      for (const key of [
        'added', 'removed', 'changed', 'newlyIncompatible', 'dependencyChanged',
      ] as const) {
        for (const pluginId of impact.changes[key]) changeNames[key].add(pluginId);
      }
      for (const change of impact.changes.platformSupportChanged) {
        changeNames.platformSupportChanged.add(change.pluginId);
      }
    }
    return {
      evidenceDigest,
      sourceId: preflight.review.sourceId,
      catalogVersion: preflight.review.candidate.catalogVersion,
      inventoryComplete: preflight.sourceImpact?.inventoryComplete !== false
        && preflight.impacts.every((impact) => impact.inventoryComplete),
      primaryChange: preflight.impacts.some((impact) => impact.primaryChange !== null),
      references,
      changes: {
        added: changeNames.added.size,
        removed: changeNames.removed.size,
        changed: changeNames.changed.size,
        newlyIncompatible: changeNames.newlyIncompatible.size,
        dependencyChanged: changeNames.dependencyChanged.size,
        platformSupportChanged: changeNames.platformSupportChanged.size,
      },
    };
  }

  async selectWorkspace(workspaceRoot?: string): Promise<CatalogWorkspaceManagementViewModel> {
    this.#selectedWorkspaceRoot = workspaceRoot === undefined
      ? undefined
      : path.resolve(this.context.cwd, workspaceRoot);
    return this.getWorkspace();
  }

  async getWorkspace(): Promise<CatalogWorkspaceManagementViewModel> {
    const requestedRoot = this.#requestedWorkspaceRoot();
    const status = await getCatalogStatus({
      cwd: this.context.cwd,
      ...(this.#selectedWorkspaceRoot === undefined
        ? {}
        : { workspaceRoot: this.#selectedWorkspaceRoot }),
      env: this.context.env,
    });
    const markerExists = await fs.pathExists(path.join(status.workspaceRoot, CATALOG_WORKSPACE_MARKER_FILENAME));
    return {
      state: status.workspace.valid ? 'ready' : markerExists ? 'invalid' : 'missing',
      selected: this.#selectedWorkspaceRoot !== undefined,
      label: safeWorkspaceLabel(status.workspaceRoot),
      resolvedFrom: status.workspace.resolvedFrom,
      identity: status.workspace.identity === null
        ? null
        : sanitizeDiagnosticText(status.workspace.identity, [requestedRoot, status.workspaceRoot]),
      catalog: {
        ...structuredClone(status.catalog),
        ownerName: status.catalog.ownerName === null
          ? null
          : sanitizeDiagnosticText(status.catalog.ownerName, [requestedRoot, status.workspaceRoot]),
        ownerUrl: status.catalog.ownerUrl === null
          ? null
          : sanitizeDiagnosticText(
              safeRemoteIdentity(status.catalog.ownerUrl),
              [requestedRoot, status.workspaceRoot],
            ),
        displayName: status.catalog.displayName === null
          ? null
          : sanitizeDiagnosticText(status.catalog.displayName, [requestedRoot, status.workspaceRoot]),
      },
      plugins: status.plugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        dependencies: [...plugin.dependencies],
      })),
      dependencyGraphValid: status.dependencyGraph.valid,
      git: {
        checked: status.git.checked,
        clean: status.git.clean,
        hasHead: status.git.sourceHead !== null,
      },
      snapshot: {
        state: status.snapshot.state,
        valid: status.snapshot.valid,
        catalogVersion: status.snapshot.catalogVersion,
        hasDigest: status.snapshot.snapshotDigest !== null,
        sourceIdentityMatches: status.snapshot.sourceIdentityMatches,
      },
      issues: status.issues.map((issue) => safeIssue(issue, [requestedRoot, status.workspaceRoot])),
    };
  }

  async validateWorkspace(): Promise<CatalogValidationViewModel> {
    const workspace = await this.getWorkspace();
    if (workspace.state !== 'ready' || workspace.snapshot.state === 'absent') {
      return {
        state: workspace.snapshot.state === 'absent' ? 'absent' : 'invalid',
        catalogVersion: workspace.snapshot.catalogVersion,
        channel: workspace.catalog.channel,
        hasSnapshotDigest: workspace.snapshot.hasDigest,
        issues: workspace.issues,
      };
    }
    const resolved = await this.#resolveWorkspace('existing');
    try {
      await runCatalogValidateCommand({
        snapshotDirectory: path.join(resolved.workspaceRoot, DEFAULT_CATALOG_OUTPUT_PATH),
        io: { stdout: () => undefined, stderr: () => undefined },
      });
      const after = await this.getWorkspace();
      return {
        state: 'valid',
        catalogVersion: after.snapshot.catalogVersion,
        channel: after.catalog.channel,
        hasSnapshotDigest: after.snapshot.hasDigest,
        issues: [],
      };
    } catch (error) {
      return {
        state: 'invalid',
        catalogVersion: workspace.snapshot.catalogVersion,
        channel: workspace.catalog.channel,
        hasSnapshotDigest: workspace.snapshot.hasDigest,
        issues: [thrownIssue(error, [resolved.workspaceRoot])],
      };
    }
  }

  async getDev(): Promise<CatalogDevManagementViewModel> {
    const workspace = await this.getWorkspace();
    if (workspace.state !== 'ready') {
      return {
        state: 'workspaceUnavailable',
        ready: false,
        workspaceIdentity: workspace.identity,
        snapshot: {
          state: workspace.snapshot.state,
          valid: workspace.snapshot.valid,
          hasDigest: workspace.snapshot.hasDigest,
        },
        source: { exists: false, id: null, pathMatches: null, primary: null },
        active: {
          exists: false,
          ready: false,
          digestMatchesSnapshot: false,
          compatibility: null,
        },
        issues: workspace.issues,
      };
    }
    const resolved = await this.#resolveWorkspace('existing');
    const packageInfo = await readCliPackageInfo();
    const status = await getCatalogDevSourceStatus({
      cwd: this.context.cwd,
      workspaceRoot: resolved.workspaceRoot,
      cliVersion: packageInfo.version,
      env: this.context.env,
    });
    return {
      state: status.ready ? 'ready'
        : !status.source.exists ? 'inactive'
          : 'needsAttention',
      ready: status.ready,
      workspaceIdentity: status.workspaceIdentity,
      snapshot: {
        state: status.snapshot.state,
        valid: status.snapshot.valid,
        hasDigest: status.snapshot.digest !== null,
      },
      source: structuredClone(status.source),
      active: {
        exists: status.active.exists,
        ready: status.active.ready,
        digestMatchesSnapshot: status.active.digestMatchesSnapshot,
        compatibility: status.active.compatibility?.state ?? null,
      },
      issues: status.issues.map((issue) => safeIssue(issue, [resolved.workspaceRoot])),
    };
  }

  async getStore(): Promise<CatalogStoreManagementViewModel> {
    const status = await catalogStoreStatus({ env: this.context.env });
    const entries = status.entries.map((entry): CatalogStoreManagementEntryViewModel => ({
      item: { storeKey: entry.storeKey, category: entry.category },
      itemKey: storeItemKey(entry),
      category: entry.category,
      status: entry.status,
      generationReference: entry.generationReference,
      ageMs: entry.ageMs,
      reclaimableBytes: entry.reclaimableBytes,
      reason: entry.reason,
    }));
    return {
      state: status.ok ? 'ready' : 'needsAttention',
      entries,
      totals: {
        ...status.totals,
        retainedEntries: entries.filter((entry) => entry.status !== 'reclaimable').length,
      },
      issues: status.errors.map((error) => safeIssue(error, [])),
    };
  }

  async getPublication(): Promise<CatalogPublicationManagementViewModel> {
    const workspace = await this.getWorkspace();
    if (workspace.state !== 'ready') {
      return { state: 'none', records: [], issues: [] };
    }
    const resolved = await this.#resolveWorkspace('existing');
    const discoveries = await discoverCatalogPublicationJournals(resolved.workspaceRoot);
    const records = discoveries.map((entry) => projectPublicationRecord(entry, resolved.workspaceRoot));
    const issues = records.flatMap((entry) => entry.issue ? [entry.issue] : []);
    return {
      state: issues.length > 0 ? 'needsAttention'
        : records.some((entry) => entry.state === 'prepared' || entry.state === 'uncertain')
          ? 'pending'
          : records.some((entry) => entry.state === 'published') ? 'published' : 'none',
      records,
      issues,
    };
  }

  async captureEvidence(intent: CatalogManagementIntent): Promise<CatalogManagementReviewEvidence> {
    const workspaceBinding = intent.action === 'storePrune' ? null : this.#workspaceBinding();
    let evidence: Omit<CatalogManagementReviewEvidence, 'evidenceDigest'>;
    const requestedVersion = intent.action === 'workspaceInit'
      ? intent.catalogVersion
      : intent.action === 'workspaceVersion' ? intent.version : undefined;
    if (requestedVersion !== undefined) {
      try {
        assertCatalogVersion(requestedVersion, 'Catalog version');
      } catch {
        throw new CatalogManagementError('invalidCatalogVersion', 'Catalog version must be valid strict SemVer.');
      }
    }
    if (intent.action === 'devActivate' && intent.sourceId !== undefined
      && !CATALOG_SOURCE_ID_PATTERN.test(intent.sourceId)) {
      throw new CatalogManagementError('invalidSourceId', 'Catalog development source ID is invalid.');
    }
    if (intent.action === 'devDeactivate' && intent.replacementPrimary !== undefined
      && !CATALOG_SOURCE_ID_PATTERN.test(intent.replacementPrimary)) {
      throw new CatalogManagementError('invalidSourceId', 'Replacement primary source ID is invalid.');
    }
    if (intent.action === 'storePrune') {
      const store = await this.getStore();
      const byKey = new Map(store.entries.map((entry) => [entry.itemKey, entry]));
      const requested = intent.items.map((item) => byKey.get(storeItemKey(item)));
      if (requested.length === 0 || requested.some((entry) => entry?.status !== 'reclaimable')) {
        throw new CatalogManagementError('catalogStoreReviewStale', 'Catalog store items are no longer reclaimable.');
      }
      evidence = {
        action: intent.action,
        workspaceBinding,
        store,
        authorizedStoreItems: intent.items.map((item) => ({ ...item })),
      };
    } else if (intent.action === 'publishApply') {
      const publication = await this.getPublication();
      const record = publication.records.find((entry) =>
        entry.planDigest === intent.expectedPlanDigest);
      if (!record || record.state === 'damaged' || !record.canApply) {
        throw new CatalogManagementError(
          'catalogPublicationPlanUnavailable',
          'The authorized Catalog publication plan is missing or damaged. Increase the Catalog version.',
        );
      }
      if (record.remote === null && intent.remote === undefined && intent.remoteUrl === undefined) {
        throw new CatalogManagementError(
          'catalogPublicationTargetRequired',
          'Re-enter the direct remote URL for this Catalog publication plan.',
        );
      }
      const resolved = await this.#resolveWorkspace('existing');
      const located = await findCatalogPublicationJournalByPlanDigest(
        resolved.workspaceRoot,
        intent.expectedPlanDigest,
      );
      const applyContext = await inspectCatalogPublicationApplyContext({
        workspaceRoot: resolved.workspaceRoot,
        remote: intent.remote ?? record.remote ?? undefined,
        remoteUrl: intent.remoteUrl,
        branch: intent.branch ?? record.branch ?? undefined,
        env: this.context.env,
      });
      if (applyContext.workspaceIdentity !== located.journal.descriptor.workspaceIdentity
        || applyContext.remoteIdentityDigest !== located.journal.descriptor.remote.identityDigest
        || applyContext.branch !== located.journal.descriptor.branch) {
        throw new CatalogManagementError(
          'catalogPublicationTargetMismatch',
          'The selected Workspace, remote, or branch does not match this Catalog publication plan.',
        );
      }
      evidence = {
        action: intent.action,
        workspaceBinding,
        publication: record,
        target: {
          remote: safeRemoteLabel(intent.remote, intent.remoteUrl) ?? record.remote,
          branch: intent.branch ?? record.branch ?? 'catalog',
        },
      };
    } else {
      const workspace = await this.getWorkspace();
      if (intent.action !== 'workspaceInit' && workspace.state !== 'ready') {
        throw new CatalogManagementError('catalogWorkspaceUnavailable', 'Catalog Workspace is not available.');
      }
      const workspaceStateDigest = await this.#workspaceStateDigest();
      const dev = intent.action === 'devActivate' || intent.action === 'devDeactivate'
        ? await this.getDev()
        : undefined;
      const devActivation = intent.action === 'devActivate'
        ? await this.#devActivationEvidence(intent)
        : undefined;
      const devImpact = intent.action === 'devDeactivate' && dev !== undefined
        ? await this.#devDeactivationImpact(dev, intent.replacementPrimary)
        : undefined;
      let target: CatalogManagementReviewEvidence['target'];
      if (intent.action === 'publishPlan') {
        const resolved = await this.#resolveWorkspace('existing');
        const publicationTarget = await resolveCatalogPublicationTarget({
          workspaceRoot: resolved.workspaceRoot,
          remote: intent.remote,
          branch: intent.branch,
          env: this.context.env,
          requireRemote: intent.remoteUrl === undefined,
        });
        if (!publicationTarget.branchValid) {
          throw new CatalogManagementError(
            'catalogPublicationBranchInvalid',
            'Catalog publication branch is not a safe Git branch name.',
          );
        }
        target = {
          remote: safeRemoteLabel(intent.remote, intent.remoteUrl)
            ?? publicationTarget.remote,
          branch: publicationTarget.branch,
        };
      }
      evidence = {
        action: intent.action,
        workspaceBinding,
        workspace,
        workspaceStateDigest,
        ...(dev ? { dev } : {}),
        ...(devActivation ? { devActivation } : {}),
        ...(devImpact ? { devImpact } : {}),
        ...(target ? { target } : {}),
      };
    }
    return { ...evidence, evidenceDigest: digest(evidence) };
  }

  async #assertExpected(
    intent: CatalogManagementIntent,
    expected: CatalogManagementReviewEvidence,
  ): Promise<void> {
    if (expected.action !== intent.action
      || expected.workspaceBinding !== (intent.action === 'storePrune' ? null : this.#workspaceBinding())) {
      throw new CatalogManagementError('operationReviewStale', 'Catalog management selection changed after Review.');
    }
    if (intent.action === 'storePrune') {
      const expectedItems = expected.authorizedStoreItems ?? [];
      if (JSON.stringify(expectedItems) !== JSON.stringify(intent.items)) {
        throw new CatalogManagementError('operationReviewStale', 'Catalog store selection changed after Review.');
      }
      return;
    }
    if (intent.action === 'publishApply') {
      const current = await this.captureEvidence(intent);
      if (current.publication?.planDigest !== expected.publication?.planDigest
        || current.publication?.state !== expected.publication?.state
        || current.target?.remote !== expected.target?.remote
        || current.target?.branch !== expected.target?.branch) {
        throw new CatalogManagementError('operationReviewStale', 'Catalog publication authorization changed after Review.');
      }
      return;
    }
    const current = await this.captureEvidence(intent);
    if (current.evidenceDigest !== expected.evidenceDigest) {
      throw new CatalogManagementError('operationReviewStale', 'Catalog management state changed after Review.');
    }
  }

  async execute(
    intent: CatalogManagementIntent,
    expected: CatalogManagementReviewEvidence,
    onProgress: (stage: CatalogManagementProgressStage) => void | Promise<void> = () => undefined,
  ): Promise<CatalogManagementExecutionResult> {
    await this.#assertExpected(intent, expected);
    if (intent.action === 'storePrune') {
      await onProgress('prune');
      const result = await catalogStorePrune({
        dryRun: false,
        authorizedItems: intent.items,
        env: this.context.env,
      });
      return {
        action: intent.action,
        state: result.overallState === 'partial' ? 'partial' : 'succeeded',
        message: result.overallState === 'partial'
          ? 'Catalog store cleanup completed partially.'
          : 'Catalog store cleanup completed.',
        messages: result.errors.map((error) =>
          sanitizeDiagnosticText(error.message, [], [error.storeKey])),
        store: {
          deletedEntries: result.deleted.length,
          deletedBytes: result.deletedBytes,
          retainedEntries: Math.max(0, intent.items.length - result.deleted.length),
        },
      };
    }

    const mode = intent.action === 'workspaceInit' ? 'initialize' : 'existing';
    const resolved = await this.#resolveWorkspace(mode);
    if (intent.action === 'workspaceInit') {
      await onProgress('validate');
      await runCatalogInitCommand({
        workspaceRoot: resolved.workspaceRoot,
        workspaceRootResolvedFrom: resolved.workspaceRootResolvedFrom,
        ownerName: intent.ownerName,
        ownerUrl: intent.ownerUrl,
        displayName: intent.displayName,
        catalogVersion: intent.catalogVersion,
        force: intent.force,
        io: { stdout: () => undefined, stderr: () => undefined },
      });
      const status = await this.getWorkspace();
      return {
        action: intent.action,
        state: 'succeeded',
        message: 'Catalog Workspace initialized.',
        messages: [],
        ...(status.catalog.version ? { catalogVersion: status.catalog.version } : {}),
      };
    }
    if (intent.action === 'workspaceVersion') {
      await onProgress('validate');
      const result = await runCatalogVersionCommand({
        workspaceRoot: resolved.workspaceRoot,
        workspaceRootResolvedFrom: resolved.workspaceRootResolvedFrom,
        version: intent.version,
        bump: intent.bump,
        io: { stdout: () => undefined, stderr: () => undefined },
      });
      return {
        action: intent.action,
        state: 'succeeded',
        message: result.changed ? 'Catalog version updated.' : 'Catalog version is unchanged.',
        messages: [],
        catalogVersion: result.catalogVersion,
      };
    }
    if (intent.action === 'workspaceBuild') {
      await onProgress('build');
      const result = await runCatalogBuildCommand({
        workspaceRoot: resolved.workspaceRoot,
        workspaceRootResolvedFrom: resolved.workspaceRootResolvedFrom,
        force: intent.force,
        io: { stdout: () => undefined, stderr: () => undefined },
      });
      await onProgress('verify');
      return {
        action: intent.action,
        state: 'succeeded',
        message: 'Catalog snapshot built and validated.',
        messages: [`${result.pluginNames.length} plugins`],
        catalogVersion: result.catalogVersion,
      };
    }
    const packageInfo = await readCliPackageInfo();
    if (intent.action === 'devActivate') {
      const activationEvidence = expected.devActivation;
      const activationReview = activationEvidence
        ? this.#devActivationReviews.get(activationEvidence.evidenceDigest)
        : undefined;
      if (!activationEvidence || !activationReview) {
        throw new CatalogManagementError(
          'operationReviewStale',
          'Catalog development activation evidence is unavailable. Review it again.',
        );
      }
      await onProgress('validate');
      const result = await activateCatalogDevSource({
        cwd: this.context.cwd,
        workspaceRoot: resolved.workspaceRoot,
        sourceId: intent.sourceId,
        primary: intent.primary,
        forceBuild: intent.forceBuild,
        yes: true,
        cliVersion: packageInfo.version,
        env: this.context.env,
        expectedReview: activationReview,
        runtime: {
          sourceRuntime: {
            onProgress: () => onProgress('source'),
          },
          beforeSync: () => onProgress('sync'),
          afterSync: () => onProgress('verify'),
        },
      });
      if (result.state === 'failed') {
        throw new CatalogManagementError(
          result.errors[0]?.code ?? 'catalogDevActivationFailed',
          result.errors[0]?.message ?? 'Catalog development source activation failed.',
        );
      }
      return {
        action: intent.action,
        state: result.state === 'completed' ? 'succeeded' : 'partial',
        message: result.state === 'completed'
          ? 'Catalog development source activated.'
          : 'Catalog development source activation completed partially.',
        messages: [
          ...result.errors.map((error) => sanitizeDiagnosticText(error.message, [resolved.workspaceRoot])),
          ...result.recovery.map((message) => sanitizeDiagnosticText(message, [resolved.workspaceRoot])),
        ],
      };
    }
    if (intent.action === 'devDeactivate') {
      await onProgress('source');
      const result = await deactivateCatalogDevSource({
        cwd: this.context.cwd,
        workspaceRoot: resolved.workspaceRoot,
        replacementPrimary: intent.replacementPrimary,
        yes: true,
        env: this.context.env,
      });
      return {
        action: intent.action,
        state: result.state === 'completed' ? 'succeeded' : 'partial',
        message: result.state === 'completed'
          ? 'Catalog development source deactivated.'
          : 'Catalog development source deactivation completed partially.',
        messages: [
          ...result.errors.map((error) => sanitizeDiagnosticText(error.message, [resolved.workspaceRoot])),
          ...result.recovery.map((message) => sanitizeDiagnosticText(message, [resolved.workspaceRoot])),
        ],
      };
    }
    if (intent.action === 'publishPlan') {
      await onProgress('prepare');
      const result = await prepareCatalogPublicationPlan({
        workspaceRoot: resolved.workspaceRoot,
        workspaceRootResolvedFrom: resolved.workspaceRootResolvedFrom,
        remote: intent.remote,
        remoteUrl: intent.remoteUrl,
        branch: intent.branch,
        env: this.context.env,
      });
      await onProgress('verify');
      return {
        action: intent.action,
        state: 'succeeded',
        message: 'Catalog publication plan prepared.',
        messages: ['Review the prepared plan before publication.'],
        catalogVersion: result.catalogVersion,
        planDigest: result.planDigest,
        publication: {
          catalogVersion: result.catalogVersion,
          planDigest: result.planDigest,
          state: result.state,
          remote: result.remote,
          branch: result.branch,
        },
      };
    }
    await onProgress('remote');
    const result = await applyCatalogPublicationPlan({
      workspaceRoot: resolved.workspaceRoot,
      workspaceRootResolvedFrom: resolved.workspaceRootResolvedFrom,
      remote: intent.remote ?? expected.publication?.remote ?? undefined,
      remoteUrl: intent.remoteUrl,
      branch: intent.branch ?? expected.publication?.branch ?? undefined,
      expectedPlanDigest: intent.expectedPlanDigest,
      env: this.context.env,
    });
    await onProgress('verify');
    return {
      action: intent.action,
      state: 'succeeded',
      message: 'Catalog publication completed.',
      messages: result.warnings.map((warning) => sanitizeDiagnosticText(warning, [resolved.workspaceRoot])),
      catalogVersion: result.catalogVersion,
      planDigest: result.planDigest,
      publication: {
        catalogVersion: result.catalogVersion,
        planDigest: result.planDigest,
        state: result.state,
        remote: result.remote,
        branch: result.branch,
      },
    };
  }
}

export function createCatalogManagementService(
  context: CliExecutionContext,
): CatalogManagementService {
  const service = new DefaultCatalogManagementService(context);
  const protect = async <T>(operation: () => Promise<T>, sensitiveValues: readonly string[] = []): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      throw service.sanitizeError(error, sensitiveValues);
    }
  };
  return {
    selectWorkspace: (workspaceRoot) => protect(
      () => service.selectWorkspace(workspaceRoot),
      workspaceRoot ? [workspaceRoot] : [],
    ),
    getWorkspace: () => protect(() => service.getWorkspace()),
    validateWorkspace: () => protect(() => service.validateWorkspace()),
    getDev: () => protect(() => service.getDev()),
    getStore: () => protect(() => service.getStore()),
    getPublication: () => protect(() => service.getPublication()),
    captureEvidence: (intent) => protect(
      () => service.captureEvidence(intent),
      intentSensitiveValues(intent),
    ),
    execute: (intent, expected, onProgress) => protect(
      () => service.execute(intent, expected, onProgress),
      intentSensitiveValues(intent),
    ),
  };
}
