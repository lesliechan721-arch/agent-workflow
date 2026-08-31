import type { PlatformName, ReceiptOverallState, Scope } from '../types.js';
import type { InitCommandResult } from '../commands/init.js';
import type { RebuildResult } from '../commands/rebuild-operations.js';
import type { DependencyOperationPlan } from '../commands/dependency-operation-plan.js';
import type { CodexReconcilePlan } from '../utils/codex-reconciler.js';

export interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  errors?: Array<{ code: string; message: string }>;
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
  codexReconcilePlans?: CodexReconcilePlan[];
  targetResults?: Array<{
    target: { pluginId?: string; platform: PlatformName; scope: Scope };
    action: string;
  }>;
}

export interface RebuildReceiptJson {
  ok: boolean;
  command: 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup' | 'sync';
  receiptSchemaVersion: 5;
  dependencyPlanSchemaVersion?: number;
  requestedPluginIds?: string[];
  resolvedPluginIds?: string[];
  dependencyEdges?: Array<{ from: string; to: string }>;
  overallState: ReceiptOverallState;
  warnings: string[];
  errors: Array<{ code: string; message: string }>;
  layers: {
    projectIntent: RebuildReceiptIntentEntry[];
    userIntent: RebuildReceiptIntentEntry[];
    sharedCodexNative: RebuildReceiptSharedNativeEntry[];
    userActivation: RebuildReceiptActivationEntry[];
    projectActivation: RebuildReceiptActivationEntry[];
    awExtensions: RebuildReceiptExtensionEntry[];
  };
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
    desired: {
      scope: Scope;
      relation: 'requested' | 'dependency';
    };
    recovery: string[];
  }>;
}

export interface RebuildReceiptIntentEntry {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  relation: 'requested' | 'dependency';
  action: string;
  requiredBy: string[];
}

export interface RebuildReceiptSharedNativeEntry {
  pluginId: string;
  codexPluginId: string;
  action: string;
  desiredVersion: string;
  shared: true;
  sharedImpact: boolean;
  reusedExistingExactNative?: true;
  ownershipLedgerCreated?: false;
  warning?: string;
}

export interface RebuildReceiptActivationEntry {
  pluginId: string;
  codexPluginId: string;
  desired: boolean;
  action: string;
}

export interface RebuildReceiptExtensionEntry {
  pluginId: string;
  componentKey: string;
  kind: string;
  scope: Scope;
  action: 'write' | 'remove';
}

export function requestedIntentAction(
  command: RebuildReceiptJson['command'],
): 'add' | 'remove' | 'keep' {
  if (command === 'install') return 'add';
  if (command === 'uninstall') return 'remove';
  return 'keep';
}

function receiptLayers(
  command: RebuildReceiptJson['command'],
  result: CliCommandResult,
): RebuildReceiptJson['layers'] {
  const planTargets = result.dependencyPlan?.targets ?? [];
  const directTargets = result.receiptTargets ?? (result.rebuildResults ?? []).map((entry) => {
    const identity = entry.target as typeof entry.target & { pluginId?: string };
    return {
      pluginName: identity.pluginName,
      ...(identity.pluginId ? { pluginId: identity.pluginId } : {}),
      platform: identity.platform,
      scope: identity.scope,
    };
  });
  const intentEntries = planTargets.length > 0
    ? planTargets.map((target): RebuildReceiptIntentEntry => ({
        pluginId: target.pluginId,
        platform: target.platform,
        scope: target.resolvedScope,
        relation: target.relation,
        action: requestedIntentAction(command),
        requiredBy: target.requiredBy,
      }))
    : directTargets.map((target): RebuildReceiptIntentEntry => ({
        pluginId: target.pluginId ?? target.pluginName,
        platform: target.platform,
        scope: target.scope,
        relation: 'requested',
        action: requestedIntentAction(command),
        requiredBy: [],
      }));
  const codexPlans = result.codexReconcilePlans ?? [];
  return {
    projectIntent: intentEntries.filter((entry) => entry.scope === 'project'),
    userIntent: intentEntries.filter((entry) => entry.scope === 'user'),
    sharedCodexNative: codexPlans.flatMap((plan) => plan.sharedNativeActions.map((entry) => ({
      pluginId: entry.pluginId,
      codexPluginId: entry.codexPluginId,
      action: entry.action === 'claim' ? 'reuse' : entry.action,
      desiredVersion: entry.desiredVersion,
      shared: true as const,
      sharedImpact: entry.affectsOtherScopes,
      ...(entry.action === 'claim' ? {
        reusedExistingExactNative: true as const,
        ownershipLedgerCreated: false as const,
      } : {}),
      ...(entry.affectsOtherScopes ? {
        warning: plan.review.sharedImpact.warning
          ?? 'This shared Codex native action can affect other projects.',
      } : {}),
    }))),
    userActivation: codexPlans.flatMap((plan) => plan.activationActions.user.map((entry) => ({
      pluginId: entry.pluginId,
      codexPluginId: entry.codexPluginId,
      desired: entry.desired,
      action: entry.action,
    }))),
    projectActivation: codexPlans.flatMap((plan) => plan.activationActions.project.map((entry) => ({
      pluginId: entry.pluginId,
      codexPluginId: entry.codexPluginId,
      desired: entry.desired,
      action: entry.action,
    }))),
    awExtensions: codexPlans.flatMap((plan) => [
      ...plan.extensionWrites,
      ...plan.extensionRemovals,
    ]),
  };
}

function recoveryForTarget(status: RebuildResult['status'], errorCode?: string): string[] {
  if (status === 'succeeded') return [];
  if (errorCode === 'codexProjectPluginVersionTooLow'
    || errorCode === 'codexProjectPluginUnsupported'
    || errorCode === 'codexSystemCliUnsupported') {
    return ['upgrade or repair the official system Codex CLI, then retry the original operation'];
  }
  if (errorCode === 'sourceMissing' || errorCode === 'catalogSourceUnavailable'
    || errorCode === 'codexIntentSourceUnavailable') {
    return ['refresh the Catalog source and run sync', 'run cleanup for AW-owned residue'];
  }
  if (errorCode === 'codexSharedNativeForeign') {
    return [
      'remove or rename the foreign Codex plugin, then run sync; cleanup preserves foreign content and does not delete this collision',
    ];
  }
  return ['run sync', 'run reinstall', 'run cleanup for AW-owned residue'];
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

function earlyFailureRecovery(command: RebuildReceiptJson['command'], errorCode?: string): string[] {
  if (errorCode === 'codexProjectPluginVersionTooLow'
    || errorCode === 'codexProjectPluginUnsupported'
    || errorCode === 'codexSystemCliUnsupported') {
    return ['upgrade or repair the official system Codex CLI, then retry the original operation'];
  }
  if (errorCode === 'syncSelectorConflict') {
    return ['remove either plugin selectors or --all, then rerun sync'];
  }
  if (errorCode === 'syncSelectionRequired') {
    return ['specify desired plugin selectors or --all, then rerun sync'];
  }
  return [`correct the ${command} request and retry`];
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
    receiptSchemaVersion: 5,
    ...(result.dependencyPlan ? {
      dependencyPlanSchemaVersion: result.dependencyPlan.dependencyPlanSchemaVersion,
      requestedPluginIds: result.dependencyPlan.requestedPluginIds,
      resolvedPluginIds: result.dependencyPlan.resolvedPluginIds,
      dependencyEdges: result.dependencyPlan.dependencyEdges,
    } : {}),
    overallState,
    warnings: result.warnings,
    errors: result.errors ?? (overallState === 'failed' && rebuildResults.length === 0
      ? [{
          code: result.warnings[0]?.split(':', 1)[0] || 'writeCommandFailed',
          message: result.warnings[0] ?? 'The write command did not run.',
        }]
      : []),
    layers: receiptLayers(command, result),
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
      const errorCode = entry.status === 'failed'
        ? rebuildErrorCode(entry.error.message)
        : undefined;
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
        desired: {
          scope: planned?.resolvedScope ?? entry.target.scope,
          relation: planned?.relation ?? 'requested',
        },
        recovery: recoveryForTarget(entry.status, errorCode),
        ...(errorCode ? { errorCode } : {}),
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
      desired: { scope: target.scope, relation: 'requested' as const },
      recovery: overallState === 'succeeded'
        ? []
        : earlyFailureRecovery(command, result.errors?.[0]?.code),
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
    `Project intent：${receipt.layers.projectIntent.length} 项。`,
    `User intent：${receipt.layers.userIntent.length} 项。`,
    `Shared Codex native：${receipt.layers.sharedCodexNative.length} 项。`,
    `User activation：${receipt.layers.userActivation.length} 项。`,
    `Project activation：${receipt.layers.projectActivation.length} 项。`,
    `AW extensions：${receipt.layers.awExtensions.length} 项。`,
    ...receipt.layers.sharedCodexNative.flatMap((entry) => entry.reusedExistingExactNative
      ? [`${entry.codexPluginId}：复用已存在的精确 shared native；不建立 ownership ledger。`]
      : []),
    ...receipt.layers.sharedCodexNative.flatMap((entry) => entry.warning
      ? [`警告：${entry.codexPluginId}：${entry.warning}`]
      : []),
    ...receipt.errors.map((error) => error.message),
    ...receipt.targets.flatMap((target) => [
      `- ${target.pluginName} / ${target.platform} / ${target.scope}: ${target.status}`,
      ...target.failures.map((failure) => `  ${failure.phase}: ${failure.message}`),
      ...target.recovery.map((recovery) => `  恢复：${recovery}`),
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
    receiptSchemaVersion: 5 as const,
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
