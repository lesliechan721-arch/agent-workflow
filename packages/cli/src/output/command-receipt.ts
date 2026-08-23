import type { PlatformName, ReceiptOverallState, Scope } from '../types.js';
import type { InitCommandResult } from '../commands/init.js';
import type { RebuildResult } from '../commands/rebuild-operations.js';
import type { DependencyOperationPlan } from '../commands/dependency-operation-plan.js';

export interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  rebuildResults?: RebuildResult[];
  receiptTargets?: Array<{
    pluginName: string;
    pluginId?: string;
    sourceId?: string;
    platform: PlatformName;
    scope: Scope;
  }>;
  overallState?: ReceiptOverallState;
  dependencyPlan?: DependencyOperationPlan;
  targetResults?: Array<{
    target: { pluginId?: string; platform: PlatformName; scope: Scope };
    action: string;
  }>;
}

export interface RebuildReceiptJson {
  ok: boolean;
  command: 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup';
  receiptSchemaVersion: 4;
  dependencyPlanSchemaVersion?: number;
  requestedPluginIds?: string[];
  resolvedPluginIds?: string[];
  dependencyEdges?: Array<{ from: string; to: string }>;
  overallState: ReceiptOverallState;
  warnings: string[];
  errors: Array<{ code: string; message: string }>;
  targets: Array<{
    pluginName: string;
    pluginId?: string;
    sourceId?: string;
    sourceIdentity?: string;
    version?: string;
    platform: RebuildResult['target']['platform'];
    scope: RebuildResult['target']['scope'];
    status: RebuildResult['status'];
    cleanupAttempted: boolean;
    actions: RebuildResult['actions'];
    removed: string[];
    absent: string[];
    residual: string[];
    quarantined: string[];
    failures: RebuildResult['failures'];
    errorCode?: string;
    relation?: 'requested' | 'dependency';
    requiredBy?: string[];
    dependencyState?: 'completed' | 'kept' | 'failed' | 'skipped';
  }>;
}

function rebuildErrorCode(message: string): string {
  for (const code of [
    'legacyStateUnsupported',
    'sourceChanged',
    'sourceMissing',
    'artifactCollision',
    'dependencyNotReady',
    'dependencyScopeTooNarrow',
    'dependencyScopeConflict',
    'dependencyTargetUnsupported',
    'dependencyInstallFailed',
    'dependencyPlanStale',
    'dependencyContractMissing',
    'dependencyContractInvalid',
    'dependencyStillRequired',
  ]) {
    if (message.includes(code)) return code;
  }
  if (message.startsWith('Cannot resolve required catalog sources:')) {
    return 'catalogSourceUnavailable';
  }
  const prefix = message.split(':', 1)[0];
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) ? prefix : 'writeFailed';
}

export function buildRebuildReceiptJson(
  command: RebuildReceiptJson['command'],
  result: CliCommandResult,
): RebuildReceiptJson {
  const rebuildResults = result.rebuildResults ?? [];
  const overallState = result.overallState
    ?? (rebuildResults.every((entry) => entry.status === 'succeeded') ? 'succeeded' : 'failed');
  return {
    ok: overallState === 'succeeded',
    command,
    receiptSchemaVersion: 4,
    ...(result.dependencyPlan ? {
      dependencyPlanSchemaVersion: result.dependencyPlan.dependencyPlanSchemaVersion,
      requestedPluginIds: result.dependencyPlan.requestedPluginIds,
      resolvedPluginIds: result.dependencyPlan.resolvedPluginIds,
      dependencyEdges: result.dependencyPlan.dependencyEdges,
    } : {}),
    overallState,
    warnings: result.warnings,
    errors: overallState === 'failed' && rebuildResults.length === 0
      ? [{
          code: result.warnings[0]?.split(':', 1)[0] || 'writeCommandFailed',
          message: result.warnings[0] ?? 'The write command did not run.',
        }]
      : [],
    targets: rebuildResults.length > 0 ? rebuildResults.map((entry) => {
      const identity = entry.target as typeof entry.target & {
        pluginId?: string;
        sourceId?: string;
        sourceIdentity?: string;
      };
      const planned = result.dependencyPlan?.targets.find((target) =>
        target.pluginId === identity.pluginId
        && target.platform === entry.target.platform
        && target.resolvedScope === entry.target.scope);
      const targetResult = result.targetResults?.find((candidate) =>
        candidate.target.pluginId === identity.pluginId
        && candidate.target.platform === entry.target.platform
        && candidate.target.scope === entry.target.scope);
      return {
        pluginName: identity.pluginName,
        ...(identity.pluginId ? { pluginId: identity.pluginId } : {}),
        ...(identity.sourceId ? { sourceId: identity.sourceId } : {}),
        ...(identity.sourceIdentity ? { sourceIdentity: identity.sourceIdentity } : {}),
        version: entry.target.pluginVersion,
        platform: entry.target.platform,
        scope: entry.target.scope,
        status: entry.status,
        cleanupAttempted: entry.cleanupAttempted,
        actions: entry.actions,
        removed: entry.removed,
        absent: entry.absent,
        residual: entry.residual,
        quarantined: entry.quarantined,
        failures: entry.failures,
        ...(planned ? {
          relation: planned.relation,
          requiredBy: planned.requiredBy,
          dependencyState: planned.action === 'keep'
            ? 'kept' as const
            : targetResult?.action === 'skipped'
              ? 'skipped' as const
            : entry.status === 'succeeded'
              ? 'completed' as const
              : entry.error.message.includes('dependencyInstallFailed')
                ? 'skipped' as const
                : 'failed' as const,
        } : {}),
        ...(entry.status === 'failed'
          ? { errorCode: rebuildErrorCode(entry.error.message) }
          : {}),
      };
    }) : (result.receiptTargets ?? []).map((target) => ({
      pluginName: target.pluginName,
      ...(target.pluginId ? { pluginId: target.pluginId } : {}),
      ...(target.sourceId ? { sourceId: target.sourceId } : {}),
      platform: target.platform,
      scope: target.scope,
      status: overallState === 'succeeded' ? 'succeeded' : 'failed',
      cleanupAttempted: false,
      actions: [],
      removed: [],
      absent: [],
      residual: [],
      quarantined: [],
      failures: [],
    })),
  };
}

export function renderRebuildReceipt(
  command: RebuildReceiptJson['command'],
  result: CliCommandResult,
): string[] {
  const receipt = buildRebuildReceiptJson(command, result);
  return [
    `${command} ${receipt.overallState === 'succeeded' ? '完成' : '失败'}：${receipt.targets.length} 个目标。`,
    ...receipt.errors.map((error) => error.message),
    ...receipt.targets.flatMap((target) => [
      `- ${target.pluginName} / ${target.platform} / ${target.scope}: ${target.status}`,
      ...target.failures.map((failure) => `  ${failure.phase}: ${failure.message}`),
    ]),
  ];
}

export interface CliInitReceipt {
  ok: boolean;
  changed: boolean;
  warnings: string[];
  primarySourceId: string;
  configDigest: string;
  compositeDigest: string;
  sources: InitCommandResult['sources'];
}

export function buildInitReceiptJson(result: CliInitReceipt) {
  return {
    command: 'init' as const,
    receiptSchemaVersion: 4 as const,
    receiptKind: 'catalogCacheWarmup' as const,
    ...result,
  };
}

export function renderInitReceipt(result: CliInitReceipt): string[] {
  return [
    `Catalog sources ${result.ok ? result.changed ? 'updated' : 'ready' : 'partially failed'}.`,
    ...result.sources.map((source) => `- ${source.id}: ${source.ok ? source.freshness : source.error}`),
    ...result.warnings,
  ];
}
