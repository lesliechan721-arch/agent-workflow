import type { InitCommandResult } from '../commands/init.js';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';
import type { OperationPlan } from '../commands/operation-plan.js';
import type { RebuildResult } from '../commands/rebuild-operations.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import type {
  CommandProducerResult,
  PlatformName,
  RebuildReceiptOverallState,
  ReceiptTargetIdentity,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import type {
  CodexReconcilePlan,
  CodexSharedNativeAction,
} from '../utils/codex-reconciler.js';

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
  overallState?: RebuildReceiptOverallState;
  dependencyPlan?: ReconcileOperationPlan;
  operationPlan?: OperationPlan;
  targetResults?: ReceiptTargetResult[];
  codexReconcilePlans?: CodexReconcilePlan[];
  commandResults?: CommandProducerResult[];
}

export interface RebuildReceiptTargetResult extends ReceiptTargetResult {
  relation: 'requested' | 'dependency';
  requiredBy: string[];
  changes: string[];
  recoveryActions: string[];
  cleanupAttempted: boolean;
  actions: RebuildResult['actions'];
  removed: string[];
  absent: string[];
  residual: string[];
  quarantined: string[];
  failures: RebuildResult['failures'];
  sharedNative?: {
    codexPluginId: string;
    action: Exclude<CodexSharedNativeAction, 'none'>;
  };
}

export interface RebuildReceiptJson {
  ok: boolean;
  command: 'install' | 'reinstall' | 'uninstall' | 'cleanup' | 'sync';
  receiptSchemaVersion: 6;
  dependencyPlanSchemaVersion?: number;
  requestedPluginIds?: string[];
  resolvedPluginIds?: string[];
  dependencyEdges?: ReconcileOperationPlan['dependencyEdges'];
  overallState: RebuildReceiptOverallState;
  changes: string[];
  targetResults: RebuildReceiptTargetResult[];
  commandResults?: CommandProducerResult[];
  warnings: string[];
  recoveryActions: string[];
  planFingerprint?: string;
  errors: Array<{ code: string; message: string }>;
}

export function requestedIntentAction(
  command: RebuildReceiptJson['command'],
): 'add' | 'remove' | 'keep' {
  if (command === 'install') return 'add';
  if (command === 'uninstall' || command === 'cleanup') return 'remove';
  return 'keep';
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function recoveryForTarget(state: ReceiptTargetResult['state'], errorCode?: string): string[] {
  if (state === 'completed') return [];
  if (errorCode === 'exclusiveOwnerEvidenceInvalid'
    || errorCode === 'forceCleanupPathUnavailable') return [];
  if (errorCode === 'codexSystemCliUnsupported') {
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
  if (errorCode === 'codexSystemCliUnsupported') {
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

function sameTarget(
  left: Pick<ReceiptTargetIdentity, 'pluginName' | 'pluginId' | 'platform' | 'scope'>,
  right: Pick<ReceiptTargetIdentity, 'pluginName' | 'pluginId' | 'platform' | 'scope'>,
): boolean {
  return left.platform === right.platform
    && left.scope === right.scope
    && (left.pluginId !== undefined && right.pluginId !== undefined
      ? left.pluginId === right.pluginId
      : left.pluginName === right.pluginName);
}

function receiptTargetFromRebuild(result: RebuildResult): ReceiptTargetIdentity {
  return {
    pluginName: result.target.pluginName,
    ...(result.target.pluginId ? { pluginId: result.target.pluginId } : {}),
    ...(result.target.marketplaceName ? { marketplaceName: result.target.marketplaceName } : {}),
    ...(result.target.sourceId ? { sourceId: result.target.sourceId } : {}),
    ...(result.target.sourceIdentity ? { sourceIdentity: result.target.sourceIdentity } : {}),
    platform: result.target.platform,
    scope: result.target.scope,
  };
}

function sourceTargetResults(
  command: RebuildReceiptJson['command'],
  result: CliCommandResult,
  errors: RebuildReceiptJson['errors'],
): ReceiptTargetResult[] {
  const targetResults = [...(result.targetResults ?? [])];
  for (const rebuild of result.rebuildResults ?? []) {
    const target = receiptTargetFromRebuild(rebuild);
    if (targetResults.some((candidate) => sameTarget(candidate.target, target))) continue;
    targetResults.push({
      target,
      action: rebuild.command,
      state: rebuild.status === 'succeeded' ? 'completed' : 'failed',
      ...(rebuild.status === 'failed' ? {
        message: rebuild.error.message,
        errorCode: rebuildErrorCode(rebuild.error.message),
      } : {}),
    });
  }
  if (targetResults.length > 0) return targetResults;

  const earlyError = errors[0];
  return (result.receiptTargets ?? []).map((target) => ({
    target,
    action: command,
    state: result.overallState === 'succeeded' ? 'completed' : 'failed',
    ...(result.overallState === 'succeeded' ? {} : {
      message: earlyError?.message ?? 'The write command did not run.',
      errorCode: earlyError?.code ?? 'writeCommandFailed',
    }),
  }));
}

function findRebuildResult(
  target: ReceiptTargetIdentity,
  rebuildResults: readonly RebuildResult[],
): RebuildResult | undefined {
  return rebuildResults.find((candidate) => sameTarget(target, receiptTargetFromRebuild(candidate)));
}

function plannedTargetChanges(
  target: ReceiptTargetIdentity,
  operationPlan?: OperationPlan,
): string[] {
  if (!operationPlan || !target.pluginId) return [];
  const exactPrefix = `${target.pluginId}:${target.platform}:${target.scope}:`;
  const exact = operationPlan.changes.filter((change) => change.startsWith(exactPrefix));
  if (exact.length > 0) return exact;
  const hasTargetAction = operationPlan.actions.some((action) =>
    action.pluginId === target.pluginId
    && action.platform === target.platform
    && action.scope === target.scope);
  return hasTargetAction
    ? operationPlan.changes.filter((change) => change.startsWith(`${target.pluginId}:`))
    : [];
}

const MUTATING_REBUILD_ACTIONS = new Set([
  'stale.cleanup',
  'native.write',
  'artifacts.write',
  'recovery.cleanup',
  'cleanup.owned',
]);

function observableTargetChanges(
  targetResult: ReceiptTargetResult,
  rebuildResult?: RebuildResult,
): string[] {
  const changes: string[] = rebuildResult?.actions
    .filter((action) => action.status === 'succeeded' && MUTATING_REBUILD_ACTIONS.has(action.name))
    .map((action) => action.name) ?? [];
  changes.push(...(rebuildResult?.removed ?? []).map((entry) => `removed:${entry}`));
  if (changes.length === 0
    && targetResult.state === 'completed'
    && targetResult.action !== 'keep'
    && targetResult.action !== 'skipped') {
    changes.push(targetResult.action);
  }
  return unique(changes);
}

function receiptTargetResult(
  targetResult: ReceiptTargetResult,
  result: CliCommandResult,
): RebuildReceiptTargetResult {
  const rebuild = findRebuildResult(targetResult.target, result.rebuildResults ?? []);
  const target = rebuild
    ? { ...receiptTargetFromRebuild(rebuild), ...targetResult.target }
    : targetResult.target;
  const planned = result.dependencyPlan?.targets.find((candidate) =>
    candidate.pluginId === target.pluginId
    && candidate.platform === target.platform
    && candidate.resolvedScope === target.scope);
  const message = targetResult.message
    ?? (rebuild?.status === 'failed' ? rebuild.error.message : undefined);
  const errorCode = targetResult.errorCode
    ?? (message && (targetResult.state === 'failed' || targetResult.action === 'skipped')
      ? rebuildErrorCode(message)
      : undefined);
  const planChanges = plannedTargetChanges(target, result.operationPlan).filter((change) =>
    targetResult.action !== 'cleanup'
    || targetResult.state === 'completed'
    || change.endsWith(':removeIntent'));
  const observableChanges = observableTargetChanges(targetResult, rebuild);
  const changes = targetResult.action === 'cleanup' && targetResult.state !== 'completed'
    ? unique([...planChanges, ...observableChanges])
    : planChanges.length > 0 ? planChanges : observableChanges;
  const recoveryActions = unique([
    ...(targetResult.recoveryActions ?? []),
    ...recoveryForTarget(
      targetResult.action === 'skipped' ? 'failed' : targetResult.state,
      errorCode,
    ),
  ]);
  const sharedNative = target.platform === 'codex' && target.pluginId
    ? result.codexReconcilePlans?.flatMap((plan) =>
        plan.desiredTargets.some((desired) =>
          desired.pluginId === target.pluginId && desired.scopes.includes(target.scope))
          ? plan.sharedNativeActions
          : [])
        .find((action) => action.pluginId === target.pluginId && action.action !== 'none')
    : undefined;
  return {
    target,
    action: targetResult.action,
    state: targetResult.state,
    ...(message ? { message } : {}),
    ...(errorCode ? { errorCode } : {}),
    relation: planned?.relation ?? targetResult.relation ?? 'requested',
    requiredBy: planned?.requiredBy ?? targetResult.requiredBy ?? [],
    changes,
    recoveryActions,
    cleanupAttempted: rebuild?.cleanupAttempted ?? false,
    actions: rebuild?.actions ?? [],
    removed: rebuild?.removed ?? [],
    absent: rebuild?.absent ?? [],
    residual: rebuild?.residual ?? [],
    quarantined: rebuild?.quarantined ?? [],
    failures: rebuild?.failures ?? [],
    ...(sharedNative ? {
      sharedNative: {
        codexPluginId: sharedNative.codexPluginId,
        action: sharedNative.action as Exclude<CodexSharedNativeAction, 'none'>,
      },
    } : {}),
  };
}

function overallState(
  targetResults: readonly RebuildReceiptTargetResult[],
  fallback: RebuildReceiptOverallState | undefined,
  commandResults: readonly CommandProducerResult[] = [],
): RebuildReceiptOverallState {
  if (targetResults.length === 0 && commandResults.length === 0) return fallback ?? 'succeeded';
  const successful = targetResults.filter((target) =>
    target.state === 'completed' && target.action !== 'skipped').length;
  const successfulCommands = commandResults.filter((result) => result.state === 'completed').length;
  if (successful === targetResults.length && successfulCommands === commandResults.length) {
    return 'succeeded';
  }
  const successfulRequested = targetResults.some((target) =>
    target.relation === 'requested'
    && target.state === 'completed'
    && target.action !== 'skipped');
  return successfulRequested || successfulCommands > 0
    || commandResults.some((result) => result.state === 'partial')
    || fallback === 'partial' ? 'partial' : 'failed';
}

export function buildRebuildReceiptJson(
  command: RebuildReceiptJson['command'],
  result: CliCommandResult,
): RebuildReceiptJson {
  const hasCoreEvidence = (result.targetResults?.length ?? 0) > 0
    || (result.rebuildResults?.length ?? 0) > 0
    || (result.receiptTargets?.length ?? 0) > 0
    || (result.commandResults?.length ?? 0) > 0;
  const errors = result.errors ?? (!hasCoreEvidence && result.overallState !== 'succeeded'
    ? [{
        code: result.warnings[0]?.split(':', 1)[0] || 'writeCommandFailed',
        message: result.warnings[0] ?? 'The write command did not run.',
      }]
    : []);
  const targetResults = sourceTargetResults(command, result, errors)
    .map((target) => receiptTargetResult(target, result));
  const commandResults = [...new Map((result.commandResults ?? [])
    .map((producer) => [getCommandPackageId(producer.producer), producer])).values()];
  const state = overallState(targetResults, result.overallState, commandResults);
  const changes = command === 'cleanup' && state !== 'succeeded'
    ? unique(targetResults.flatMap((target) => target.changes))
    : result.operationPlan?.changes ?? unique(targetResults.flatMap((target) => target.changes));
  const recoveryActions = unique([
    ...targetResults.flatMap((target) => target.recoveryActions),
    ...commandResults.flatMap((producer) => producer.recoveryActions),
  ]);
  if (state !== 'succeeded' && targetResults.length === 0 && commandResults.length === 0) {
    recoveryActions.push(...earlyFailureRecovery(command, errors[0]?.code));
  }
  return {
    ok: state === 'succeeded',
    command,
    receiptSchemaVersion: 6,
    ...(result.dependencyPlan ? {
      dependencyPlanSchemaVersion: 2,
      requestedPluginIds: result.dependencyPlan.requestedPluginIds,
      resolvedPluginIds: result.dependencyPlan.resolvedPluginIds,
      dependencyEdges: result.dependencyPlan.dependencyEdges,
    } : {}),
    overallState: state,
    changes,
    targetResults,
    ...(commandResults.length > 0 ? { commandResults } : {}),
    warnings: unique([
      ...result.warnings,
      ...(result.operationPlan?.warnings ?? []),
    ]),
    recoveryActions: unique(recoveryActions),
    ...(result.operationPlan ? { planFingerprint: result.operationPlan.planFingerprint } : {}),
    errors,
  };
}

export function renderRebuildReceipt(
  command: RebuildReceiptJson['command'],
  result: CliCommandResult,
): string[] {
  const receipt = buildRebuildReceiptJson(command, result);
  const stateLabel: Record<RebuildReceiptOverallState, string> = {
    succeeded: '完成',
    partial: '部分完成',
    failed: '失败',
  };
  return [
    `${command} ${stateLabel[receipt.overallState]}：${receipt.targetResults.length} 个目标。${receipt.commandResults?.length ? ` ${receipt.commandResults.length} 个命令生产者。` : ''}`,
    ...receipt.changes.map((change) => `变更：${change}`),
    ...receipt.warnings.map((warning) => `警告：${warning}`),
    ...receipt.errors.map((error) => error.message),
    ...receipt.targetResults.flatMap((target) => {
      const pluginId = target.target.pluginId ?? target.target.pluginName;
      return [
        `- ${pluginId} / ${target.target.platform} / ${target.target.scope}: ${target.state}`,
        ...(target.sharedNative
          ? [`  shared native ${target.sharedNative.codexPluginId}: ${target.sharedNative.action}`]
          : []),
        ...(target.message ? [`  ${target.message}`] : []),
        ...target.failures
          .filter((failure) => failure.message !== target.message)
          .map((failure) => `  ${failure.phase}: ${failure.message}`),
      ];
    }),
    ...(receipt.commandResults ?? []).flatMap((result) => [
      `- ${result.producer.sourceId}/${result.producer.pluginName} / ${result.producer.kind}:${result.producer.key} / ${result.producer.scope}: ${result.state}`,
      ...((command === 'cleanup' || command === 'uninstall') && result.producer.kind === 'package' ? [
        `  保留命令包 ${getCommandPackageId(result.producer)}；${result.producer.scope === 'user' ? '所有项目共用，' : '当前项目内共用，'}其资源与绑定不随平台清理移除。`,
      ] : []),
      ...result.commandIds.map((id) => `  命令：${id}`),
      ...result.removedCommandIds.map((id) => `  已撤销命令：${id}`),
      ...result.errors.map((error) => `  ${error.code}: ${error.message}`),
    ]),
    ...receipt.recoveryActions.map((recovery) => `恢复：${recovery}`),
  ];
}

export interface CliInitReceipt {
  ok: boolean;
  primarySourceId: string;
  configDigest: string;
  compositeDigest: string;
  sources: InitCommandResult['sources'];
  recovery: string[];
}

export function buildInitReceiptJson(result: CliInitReceipt) {
  return {
    command: 'init' as const,
    receiptSchemaVersion: 6 as const,
    receiptKind: 'catalogReadiness' as const,
    ...result,
  };
}

export function renderInitReceipt(result: CliInitReceipt): string[] {
  return [
    `Catalog Active sources ${result.ok ? 'ready' : 'not ready'}.`,
    ...result.sources.map((source) => `- ${source.id}: ${source.activeReady ? 'ready' : source.error}`),
    ...result.recovery.map((recovery) => `Recovery: ${recovery}`),
  ];
}
