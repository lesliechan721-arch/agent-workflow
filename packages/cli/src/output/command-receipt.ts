import type {
  CatalogResolution,
  CatalogResolutionFailure,
  ReceiptOverallState,
} from '../types.js';
import type { RebuildResult } from '../commands/rebuild-operations.js';

export interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  rebuildResults?: RebuildResult[];
  overallState?: ReceiptOverallState;
}

export interface RebuildReceiptJson {
  ok: boolean;
  command: 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup';
  receiptSchemaVersion: 3;
  overallState: ReceiptOverallState;
  warnings: string[];
  targets: Array<{
    plugin: string;
    version: string;
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
    receiptSchemaVersion: 3,
    overallState,
    warnings: result.warnings,
    targets: rebuildResults.map((entry) => ({
      plugin: entry.target.pluginName,
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
    ...receipt.targets.flatMap((target) => [
      `- ${target.plugin} / ${target.platform} / ${target.scope}: ${target.status}`,
      ...target.failures.map((failure) => `  ${failure.phase}: ${failure.message}`),
    ]),
  ];
}

export interface CliInitReceipt {
  rootDir: string;
  changed: boolean;
  warnings: string[];
  catalog: CatalogResolution;
}

export function buildInitReceiptJson(result: CliInitReceipt) {
  return {
    ok: true,
    command: 'init' as const,
    receiptSchemaVersion: 2 as const,
    receiptKind: 'catalogCacheWarmup' as const,
    ...result,
  };
}

export function buildInitFailureReceiptJson(catalog: CatalogResolutionFailure) {
  return {
    ok: false,
    command: 'init' as const,
    receiptSchemaVersion: 2 as const,
    receiptKind: 'catalogCacheWarmup' as const,
    warnings: [] as string[],
    catalog,
  };
}

export function renderInitReceipt(result: CliInitReceipt): string[] {
  return [
    `Catalog cache ${result.changed ? '已更新' : '已就绪'}：${result.rootDir}。`,
    ...result.warnings,
  ];
}
