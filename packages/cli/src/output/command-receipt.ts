import type { PlatformName, ReceiptOverallState, Scope } from '../types.js';
import type { InitCommandResult } from '../commands/init.js';
import type { RebuildResult } from '../commands/rebuild-operations.js';

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
}

export interface RebuildReceiptJson {
  ok: boolean;
  command: 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup';
  receiptSchemaVersion: 4;
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
  }>;
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
    overallState,
    warnings: result.warnings,
    errors: overallState === 'failed' && rebuildResults.length === 0
      ? [{
          code: result.warnings[0]?.split(':', 1)[0] || 'runtimeTransitionIncomplete',
          message: result.warnings[0] ?? 'The write command did not run.',
        }]
      : [],
    targets: rebuildResults.length > 0 ? rebuildResults.map((entry) => {
      const identity = entry.target as typeof entry.target & {
        pluginId?: string;
        sourceId?: string;
        sourceIdentity?: string;
      };
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
      };
    }) : (result.receiptTargets ?? []).map((target) => ({
      pluginName: target.pluginName,
      ...(target.pluginId ? { pluginId: target.pluginId } : {}),
      ...(target.sourceId ? { sourceId: target.sourceId } : {}),
      platform: target.platform,
      scope: target.scope,
      status: 'failed',
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
