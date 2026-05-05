import { CodexAdapter } from '../adapters/codex.js';
import { preflightCodexProjectWriteSafety } from '../commands/codex-project-safety.js';
import type { ResolvedPluginTarget } from '../commands/common.js';
import type {
  ArtifactLastRefresh,
  ArtifactRefreshReach,
  ArtifactState,
  ArtifactTarget,
  GeneratedArtifact,
  PluginMeta,
  Scope,
  TrackingManifest,
  TrackingPluginRecord,
} from '../types.js';
import { mergeGeneratedArtifacts } from './generated-artifacts.js';
import { readInstalledLedger } from './local-marketplace.js';
import { resolveCodexPaths, resolveCodexProjectKey } from './paths.js';
import {
  getTrackingRecord,
  readTrackingManifest,
  upsertTrackingRecordInManifest,
  writeTrackingManifest,
} from './tracking.js';

export interface ArtifactRefreshReceiptArtifact {
  platform: 'codex';
  scope: Scope;
  id: string;
  target: ArtifactTarget;
  state: ArtifactState;
}

export interface ArtifactRefreshReceipt {
  attempted: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  triggerKeys: string[];
  artifacts: ArtifactRefreshReceiptArtifact[];
  error?: string;
  reason?: 'no-tracked-dynamic-artifact' | 'no-trigger-keys';
}

interface RefreshUnit {
  scope: Scope;
  triggerKeys: string[];
  trackingDir: string;
  trackingManifest: TrackingManifest;
  trackingRecord: TrackingPluginRecord;
  dynamicArtifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
  staticArtifacts: GeneratedArtifact[];
}

interface ExecutedRefreshUnit extends RefreshUnit {
  status: 'succeeded' | 'failed';
  refreshedArtifacts?: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
  error?: string;
}

function isTrackedCodexDynamicArtifact(
  artifact: GeneratedArtifact,
): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } {
  return (
    artifact.platform === 'codex' &&
    typeof artifact.id === 'string' &&
    (
      artifact.target === 'codex.developerInstructionsBlock' ||
      artifact.target === 'codex.agentRole'
    ) &&
    (artifact.state === 'present' || artifact.state === 'disabled')
  );
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function summarizeArtifacts(
  scope: Scope,
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>,
): ArtifactRefreshReceiptArtifact[] {
  return artifacts.map((artifact) => ({
    platform: 'codex',
    scope,
    id: artifact.id,
    target: artifact.target,
    state: artifact.state,
  }));
}

function buildLastRefresh(options: {
  status: ArtifactLastRefresh['status'];
  triggerKeys: string[];
  error?: string;
}): ArtifactLastRefresh {
  return {
    status: options.status,
    updatedAt: new Date().toISOString(),
    triggerKeys: [...options.triggerKeys],
    event: 'refresh',
    ...(options.error ? { error: options.error } : {}),
  };
}

function withRefreshMetadata(
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>,
  lastRefresh: ArtifactLastRefresh,
  refreshReach: ArtifactRefreshReach,
): Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }> {
  return artifacts.map((artifact) => ({
    ...artifact,
    lastRefresh,
    refreshReach,
  }));
}

function createResolvedTarget(plugin: PluginMeta): ResolvedPluginTarget {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    source: 'currentCatalog',
  };
}

async function collectRefreshUnits(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  changedKeys: string[];
  resetAllTrackedKeys: boolean;
}): Promise<RefreshUnit[]> {
  const candidateScopes: Scope[] = options.commandScope === 'user'
    ? ['user', 'project']
    : ['project'];
  const units: RefreshUnit[] = [];

  for (const scope of candidateScopes) {
    const trackingDir = resolveCodexPaths(options.cwd, scope, options.env).trackingDir;
    const trackingManifest = await readTrackingManifest(trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
    if (!trackingRecord) {
      continue;
    }

    const dynamicArtifacts = trackingRecord.artifacts.filter(isTrackedCodexDynamicArtifact);
    if (dynamicArtifacts.length === 0) {
      continue;
    }

    const trackedRefreshKeys = uniqueSorted(
      dynamicArtifacts.flatMap((artifact) => artifact.refreshKeys ?? []),
    );
    const triggerKeys = options.resetAllTrackedKeys
      ? trackedRefreshKeys
      : options.changedKeys.filter((key) => trackedRefreshKeys.includes(key));
    if (triggerKeys.length === 0) {
      continue;
    }

    units.push({
      scope,
      triggerKeys: uniqueSorted(triggerKeys),
      trackingDir,
      trackingManifest,
      trackingRecord,
      dynamicArtifacts,
      staticArtifacts: trackingRecord.artifacts.filter((artifact) => !isTrackedCodexDynamicArtifact(artifact)),
    });
  }

  return units;
}

async function collectRefreshUnitsForReapply(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  units: RefreshUnit[];
  reason?: ArtifactRefreshReceipt['reason'];
}> {
  const candidateScopes: Scope[] = options.commandScope === 'user'
    ? ['user', 'project']
    : ['project'];
  const units: RefreshUnit[] = [];
  let sawTrackedDynamicArtifact = false;

  for (const scope of candidateScopes) {
    const trackingDir = resolveCodexPaths(options.cwd, scope, options.env).trackingDir;
    const trackingManifest = await readTrackingManifest(trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
    if (!trackingRecord) {
      continue;
    }

    const dynamicArtifacts = trackingRecord.artifacts.filter(isTrackedCodexDynamicArtifact);
    if (dynamicArtifacts.length === 0) {
      continue;
    }
    sawTrackedDynamicArtifact = true;

    const failedRefreshKeys = uniqueSorted(
      dynamicArtifacts.flatMap((artifact) =>
        artifact.lastRefresh?.status === 'failed' ? artifact.lastRefresh.triggerKeys ?? [] : []),
    );
    const trackedRefreshKeys = uniqueSorted(
      dynamicArtifacts.flatMap((artifact) => artifact.refreshKeys ?? []),
    );
    const triggerKeys = failedRefreshKeys.length > 0 ? failedRefreshKeys : trackedRefreshKeys;
    if (triggerKeys.length === 0) {
      continue;
    }

    units.push({
      scope,
      triggerKeys,
      trackingDir,
      trackingManifest,
      trackingRecord,
      dynamicArtifacts,
      staticArtifacts: trackingRecord.artifacts.filter((artifact) => !isTrackedCodexDynamicArtifact(artifact)),
    });
  }

  if (units.length > 0) {
    return { units };
  }

  return {
    units,
    reason: sawTrackedDynamicArtifact ? 'no-trigger-keys' : 'no-tracked-dynamic-artifact',
  };
}

async function preflightDynamicArtifactRefresh(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const adapter = new CodexAdapter(options.cwd, undefined, options.env);
  const status = await adapter.status(options.plugin, options.scope);
  const managedArtifacts = status.plugins[0]?.managedArtifacts ?? [];
  const blockers = managedArtifacts.filter((artifact) =>
    artifact.health === 'registrationDrift' || artifact.health === 'contentDrift',
  );
  if (blockers.length === 0) {
    return;
  }

  throw new Error(blockers.map((artifact) => artifact.diagnostics[0] ?? `${artifact.id} 已漂移。`).join('；'));
}

async function executeRefreshUnit(options: {
  unit: RefreshUnit;
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutedRefreshUnit> {
  try {
    if (options.unit.scope === 'project') {
      await preflightCodexProjectWriteSafety({
        targets: [createResolvedTarget(options.plugin)],
        platforms: ['codex'],
        cwd: options.cwd,
        scope: 'project',
        env: options.env,
        operation: 'refresh',
      });
    }

    await preflightDynamicArtifactRefresh({
      plugin: options.plugin,
      scope: options.unit.scope,
      cwd: options.cwd,
      env: options.env,
    });

    const adapter = new CodexAdapter(options.cwd, undefined, options.env);
    const refreshedArtifacts = (await adapter.installExtensions(options.plugin, options.unit.scope, {
      event: 'refresh',
      changedConfigKeys: options.unit.triggerKeys,
      dynamicOnly: true,
    })).filter(isTrackedCodexDynamicArtifact);

    return {
      ...options.unit,
      status: 'succeeded',
      refreshedArtifacts,
    };
  } catch (error) {
    return {
      ...options.unit,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function createRefreshReach(options: {
  pluginName: string;
  commandScope: Scope;
  refreshedScopes: Scope[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ArtifactRefreshReach> {
  let knownProjectTargetsOutsideReach: string[] = [];
  try {
    const projectKey = await resolveCodexProjectKey(options.cwd);
    const ledger = await readInstalledLedger(options.env);
    knownProjectTargetsOutsideReach = uniqueSorted(
      Object.keys(ledger.plugins[options.pluginName]?.platforms.codex?.projectScopes ?? {})
        .filter((key) => key !== projectKey)
        .map((key) => `project:${key}`),
    );
  } catch {
    knownProjectTargetsOutsideReach = [];
  }

  return {
    commandScope: options.commandScope,
    refreshedUserTarget: options.refreshedScopes.includes('user'),
    refreshedCurrentProjectTarget: options.refreshedScopes.includes('project'),
    scannedHistoricalProjects: false,
    historicalProjectTargetsMayBeStale: knownProjectTargetsOutsideReach.length > 0,
    knownProjectTargetsOutsideReach,
  };
}

async function writeRefreshTrackingResult(options: {
  unit: ExecutedRefreshUnit;
  refreshReach: ArtifactRefreshReach;
}): Promise<{
  status: ExecutedRefreshUnit['status'];
  error?: string;
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
}> {
  const artifactsWithRefresh = options.unit.status === 'succeeded'
    ? withRefreshMetadata(
        options.unit.refreshedArtifacts ?? [],
        buildLastRefresh({
          status: 'succeeded',
          triggerKeys: options.unit.triggerKeys,
        }),
        options.refreshReach,
      )
    : withRefreshMetadata(
        options.unit.dynamicArtifacts,
        buildLastRefresh({
          status: 'failed',
          triggerKeys: options.unit.triggerKeys,
          error: options.unit.error,
        }),
        options.refreshReach,
      );

  try {
    await writeTrackingManifest(
      options.unit.trackingDir,
      upsertTrackingRecordInManifest(
        options.unit.trackingManifest,
        options.unit.trackingRecord.name,
        mergeGeneratedArtifacts(options.unit.staticArtifacts, artifactsWithRefresh),
      ),
    );
    return {
      status: options.unit.status,
      ...(options.unit.error ? { error: options.unit.error } : {}),
      artifacts: artifactsWithRefresh,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      error: options.unit.error ? `${options.unit.error}；tracking 写入失败：${message}` : `tracking 写入失败：${message}`,
      artifacts: artifactsWithRefresh,
    };
  }
}

export async function refreshArtifactsAfterConfigWrite(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  changedKeys?: string[];
  resetAllTrackedKeys?: boolean;
}): Promise<ArtifactRefreshReceipt> {
  const env = options.env ?? process.env;
  const changedKeys = uniqueSorted(options.changedKeys ?? []);
  try {
    const units = await collectRefreshUnits({
      plugin: options.plugin,
      commandScope: options.commandScope,
      cwd: options.cwd,
      env,
      changedKeys,
      resetAllTrackedKeys: options.resetAllTrackedKeys === true,
    });

    if (units.length === 0) {
      return {
        attempted: false,
        status: 'skipped',
        triggerKeys: changedKeys,
        artifacts: [],
      };
    }

    const executedUnits: ExecutedRefreshUnit[] = [];
    for (const unit of units) {
      executedUnits.push(await executeRefreshUnit({
        unit,
        plugin: options.plugin,
        cwd: options.cwd,
        env,
      }));
    }

    const refreshedScopes = executedUnits
      .filter((unit) => unit.status === 'succeeded')
      .map((unit) => unit.scope);
    const refreshReach = await createRefreshReach({
      pluginName: options.plugin.manifest.name,
      commandScope: options.commandScope,
      refreshedScopes,
      cwd: options.cwd,
      env,
    });

    const writtenResults = [];
    for (const unit of executedUnits) {
      writtenResults.push(await writeRefreshTrackingResult({
        unit,
        refreshReach,
      }));
    }

    const artifacts = writtenResults.flatMap((result, index) =>
      summarizeArtifacts(executedUnits[index].scope, result.artifacts),
    );
    const errors = writtenResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));

    return {
      attempted: true,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      triggerKeys: uniqueSorted(units.flatMap((unit) => unit.triggerKeys)),
      artifacts,
      ...(errors.length > 0 ? { error: errors.join('；') } : {}),
    };
  } catch (error) {
    return {
      attempted: changedKeys.length > 0 || options.resetAllTrackedKeys === true,
      status: 'failed',
      triggerKeys: changedKeys,
      artifacts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function reapplyConfigRefresh(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRefreshReceipt> {
  const env = options.env ?? process.env;
  try {
    const collected = await collectRefreshUnitsForReapply({
      plugin: options.plugin,
      commandScope: options.commandScope,
      cwd: options.cwd,
      env,
    });
    const units = collected.units;

    if (units.length === 0) {
      return {
        attempted: false,
        status: 'skipped',
        triggerKeys: [],
        artifacts: [],
        ...(collected.reason ? { reason: collected.reason } : {}),
      };
    }

    const executedUnits: ExecutedRefreshUnit[] = [];
    for (const unit of units) {
      executedUnits.push(await executeRefreshUnit({
        unit,
        plugin: options.plugin,
        cwd: options.cwd,
        env,
      }));
    }

    const refreshedScopes = executedUnits
      .filter((unit) => unit.status === 'succeeded')
      .map((unit) => unit.scope);
    const refreshReach = await createRefreshReach({
      pluginName: options.plugin.manifest.name,
      commandScope: options.commandScope,
      refreshedScopes,
      cwd: options.cwd,
      env,
    });

    const writtenResults = [];
    for (const unit of executedUnits) {
      writtenResults.push(await writeRefreshTrackingResult({
        unit,
        refreshReach,
      }));
    }

    const artifacts = writtenResults.flatMap((result, index) =>
      summarizeArtifacts(executedUnits[index].scope, result.artifacts),
    );
    const errors = writtenResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));

    return {
      attempted: true,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      triggerKeys: uniqueSorted(units.flatMap((unit) => unit.triggerKeys)),
      artifacts,
      ...(errors.length > 0 ? { error: errors.join('；') } : {}),
    };
  } catch (error) {
    return {
      attempted: true,
      status: 'failed',
      triggerKeys: [],
      artifacts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
