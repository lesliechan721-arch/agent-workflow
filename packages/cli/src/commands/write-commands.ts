import type {
  InstallCommandOptions,
  PlatformName,
} from '../types.js';
import {
  withAwHomeMutationLock,
} from '../utils/aw-home-mutation-lock.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import {
  normalizeCleanupCommandOptions,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUninstallCommandOptions,
  type RawCleanupCommandOptions,
  type RawInstallCommandOptions,
  type RawReinstallCommandOptions,
  type RawUninstallCommandOptions,
} from './options.js';
import {
  runRebuildCommand,
  runRebuildTaskCommand,
  type RebuildCommandResult,
  type RebuildCommandRuntime,
  type RebuildTaskCommandOptions,
  type RebuildTaskTarget,
} from './rebuild-command.js';
import { createOperationPlan } from './operation-plan.js';
import type { ReconcileOperationPlan } from './reconcile-operation-plan.js';
import { createRemovedProjectRequirements } from '../project/removed-requirements.js';

type WriteCommand = 'install' | 'sync' | 'reinstall' | 'uninstall' | 'cleanup';

export function mergeWriteCommandResults(
  results: readonly RebuildCommandResult[],
): RebuildCommandResult {
  const operationPlans = results.flatMap((result) => result.operationPlan ? [result.operationPlan] : []);
  const dependencyPlans = results.flatMap((result) => result.dependencyPlan ? [result.dependencyPlan] : []);
  const dependencyPlan: ReconcileOperationPlan | undefined = dependencyPlans.length > 0
    ? {
        requestedPluginIds: [...new Set(dependencyPlans.flatMap((plan) =>
          plan.requestedPluginIds))].sort(),
        resolvedPluginIds: [...new Set(dependencyPlans.flatMap((plan) =>
          plan.resolvedPluginIds))].sort(),
        dependencyEdges: dependencyPlans.flatMap((plan) => plan.dependencyEdges),
        scopeOverrides: dependencyPlans.flatMap((plan) => plan.scopeOverrides),
        targets: dependencyPlans.flatMap((plan) => plan.targets),
      }
    : undefined;
  return {
    platforms: [...new Set(results.flatMap((result) => result.platforms))],
    plugins: [...new Set(results.flatMap((result) => result.plugins))],
    warnings: results.flatMap((result) => result.warnings),
    rebuildResults: results.flatMap((result) => result.rebuildResults),
    targetResults: results.flatMap((result) => result.targetResults),
    overallState: results.every((result) => result.overallState === 'succeeded')
      ? 'succeeded'
      : results.some((result) => result.overallState === 'succeeded'
        || result.overallState === 'partial') ? 'partial' : 'failed',
    receiptTargets: results.flatMap((result) => result.receiptTargets),
    ...(results.some((result) => result.portableCleanupResidues !== undefined)
      ? { portableCleanupResidues: results.flatMap((result) => result.portableCleanupResidues ?? []) }
      : {}),
    ...(results.some((result) => result.nativeFootprints !== undefined)
      ? { nativeFootprints: results.flatMap((result) => result.nativeFootprints ?? []) }
      : {}),
    ...(dependencyPlan ? { dependencyPlan } : {}),
    ...(results.some((result) => result.codexReconcilePlans !== undefined)
      ? { codexReconcilePlans: results.flatMap((result) => result.codexReconcilePlans ?? []) }
      : {}),
    ...(operationPlans.length > 0 ? {
      operationPlan: createOperationPlan({
        intentChanges: operationPlans.flatMap((plan) => plan.intentChanges),
        actions: operationPlans.flatMap((plan) => plan.actions),
        changes: operationPlans.flatMap((plan) => plan.changes),
        warnings: operationPlans.flatMap((plan) => plan.warnings),
        evidence: {
          catalogDigests: operationPlans.flatMap((plan) => plan.evidence.catalogDigests),
          intentDigests: operationPlans.flatMap((plan) => plan.evidence.intentDigests),
          configDigests: operationPlans.flatMap((plan) => plan.evidence.configDigests),
          targetOwnerFingerprints: operationPlans.flatMap((plan) =>
            plan.evidence.targetOwnerFingerprints),
        },
      }),
    } : {}),
    ...(results.some((result) => result.offlineCleanupPlans !== undefined)
      ? { offlineCleanupPlans: results.flatMap((result) => result.offlineCleanupPlans ?? []) }
      : {}),
    ...(results.some((result) => result.removedPluginCleanupIds !== undefined)
      ? { removedPluginCleanupIds: [...new Set(results.flatMap((result) => result.removedPluginCleanupIds ?? []))] }
      : {}),
  };
}

function writeErrorCode(message: string): string {
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
  if (message.includes('Catalog source')
    && (message.includes('is not configured') || message.includes('has no Active generation'))) {
    return 'catalogSourceUnavailable';
  }
  const prefix = message.split(':', 1)[0];
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) ? prefix : 'writeFailed';
}

export function failedWriteCommandResult(
  command: WriteCommand,
  pluginNames: string[],
  options: InstallCommandOptions,
  error: unknown,
): RebuildCommandResult {
  const message = error instanceof Error ? error.message : String(error);
  const codedError = (error as { code?: unknown }).code;
  const errorCode = typeof codedError === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(codedError)
    ? codedError
    : writeErrorCode(message);
  const namespacedTargets = (error as {
    namespacedTargets?: Array<{
      pluginId: string;
      pluginName: string;
      sourceId: string;
      sourceIdentity: string;
      platform?: PlatformName;
      scope?: InstallCommandOptions['scope'];
      pluginVersion?: string;
    }>;
  }).namespacedTargets ?? [];
  const legacyTargets = (error as {
    legacyTargets?: Array<{
      pluginName: string;
      platform: PlatformName;
      scope: InstallCommandOptions['scope'];
    }>;
  }).legacyTargets ?? [];
  const platforms: PlatformName[] = options.platform === 'both'
    ? ['codex', 'claude']
    : [options.platform];
  const requested = pluginNames.length > 0 ? pluginNames : [];
  const explicitFailureTargets = [
    ...namespacedTargets.map((target) => ({ selector: target.pluginId, target })),
    ...legacyTargets.map((target) => ({ selector: target.pluginName, target })),
  ];
  const failedTargets = explicitFailureTargets.length > 0
    ? explicitFailureTargets
    : requested.map((selector) => ({ selector, target: undefined }));
  const rebuildResults = failedTargets.flatMap(({ selector, target: exactTarget }) => {
    let pluginName = selector;
    let sourceId: string | undefined;
    let pluginId: string | undefined;
    try {
      const parsed = parsePluginId(selector);
      pluginName = parsed.pluginName;
      sourceId = parsed.sourceId;
      pluginId = parsed.sourceId ? selector : undefined;
    } catch {
      // Keep the original selector in the failure receipt.
    }
    const resolvedTarget = exactTarget ?? namespacedTargets.find((target) =>
      target.pluginId === selector
      || (sourceId === undefined && target.pluginName === pluginName));
    if (resolvedTarget) {
      pluginName = resolvedTarget.pluginName;
      sourceId = 'sourceId' in resolvedTarget ? resolvedTarget.sourceId : undefined;
      pluginId = 'pluginId' in resolvedTarget ? resolvedTarget.pluginId : undefined;
    }
    const targetPlatforms = resolvedTarget?.platform ? [resolvedTarget.platform] : platforms;
    return targetPlatforms.map((platform) => ({
      status: 'failed' as const,
      command,
      target: {
        pluginName,
        pluginVersion: resolvedTarget && 'pluginVersion' in resolvedTarget
          ? resolvedTarget.pluginVersion ?? 'unavailable'
          : 'unavailable',
        ...(sourceId ? {
          sourceId,
          pluginId,
          ...(resolvedTarget && 'sourceIdentity' in resolvedTarget
            ? { sourceIdentity: resolvedTarget.sourceIdentity }
            : {}),
        } : {}),
        platform,
        scope: resolvedTarget?.scope ?? options.scope,
        cwd: options.cwd,
      },
      actions: [],
      cleanupAttempted: false,
      removed: [],
      absent: [],
      residual: [],
      quarantined: [],
      failures: [{ phase: 'preflight' as const, message }],
      error: { phase: 'preflight' as const, message },
    }));
  });
  return {
    platforms: [...new Set(rebuildResults.map((result) => result.target.platform))],
    plugins: [],
    warnings: [],
    rebuildResults,
    targetResults: rebuildResults.map((result) => ({
      target: result.target,
      action: command,
      state: 'failed',
      message,
      errorCode,
      ...(errorCode === 'exclusiveOwnerEvidenceInvalid' && result.target.pluginId ? {
        recoveryActions: [
          `run aw cleanup ${result.target.pluginId} --platform ${result.target.platform} --scope ${result.target.scope} --force`,
          `then run aw reinstall ${result.target.pluginId} --platform ${result.target.platform} --scope ${result.target.scope}`,
        ],
      } : errorCode === 'forceCleanupPathUnavailable' ? {
        recoveryActions: [
          'restore the local Active bundle and retry cleanup --force',
          'inspect and remove only the exact expected output manually',
        ],
      } : {}),
    })),
    overallState: 'failed',
    receiptTargets: rebuildResults.map((result) => result.target),
  };
}

async function runPublicWriteCommand(options: {
  command: WriteCommand;
  pluginNames: string[];
  commandOptions: InstallCommandOptions;
  runtime: RebuildCommandRuntime;
  all?: boolean;
}): Promise<RebuildCommandResult> {
  const runtime = options.commandOptions.allowManagedCodexInstall === true
    && !options.runtime.managedCodexAuthorizer
    ? { ...options.runtime, managedCodexAuthorizer: async () => true }
    : options.runtime;
  const cleanupRuntime = (active: RebuildCommandRuntime): RebuildCommandRuntime =>
    options.command === 'cleanup' && !active.removedProjectRequirements
      ? { ...active, removedProjectRequirements: createRemovedProjectRequirements({
          cwd: options.commandOptions.cwd, env: active.env, token: active.awHomeMutationToken,
        }) }
      : active;
  const execution = runtime.previewOperationPlan === true
    ? runRebuildCommand({
        command: options.command,
        pluginNames: options.pluginNames,
        commandOptions: options.commandOptions,
        runtime: cleanupRuntime(runtime),
        ...(options.all === undefined ? {} : { all: options.all }),
      })
    : (async () => {
        return withAwHomeMutationLock({
          env: runtime.env,
          token: runtime.awHomeMutationToken,
          action: (token) => runRebuildCommand({
            command: options.command,
            pluginNames: options.pluginNames,
            commandOptions: options.commandOptions,
            runtime: cleanupRuntime({ ...runtime, awHomeMutationToken: token }),
            ...(options.all === undefined ? {} : { all: options.all }),
          }),
        });
      })();
  return execution.catch((error) => failedWriteCommandResult(
    options.command,
    options.pluginNames,
    options.commandOptions,
    error,
  ));
}

function requirePluginNames(command: string, pluginNames: string[], exact = false): void {
  if ((exact && pluginNames.length !== 1) || (!exact && pluginNames.length === 0)) {
    throw new Error(`${command} 命令${exact ? '需要且只接受一个' : '至少需要一个'}插件名。`);
  }
}

export async function installWriteCommand(
  pluginNames: string[],
  rawOptions: RawInstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('install', pluginNames);
  const commandOptions: InstallCommandOptions = normalizeInstallCommandOptions(rawOptions);
  return runPublicWriteCommand({ command: 'install', pluginNames, commandOptions, runtime });
}

export async function syncWriteCommand(
  pluginNames: string[],
  rawOptions: RawInstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('sync', pluginNames);
  const commandOptions: InstallCommandOptions = normalizeInstallCommandOptions(rawOptions);
  return runPublicWriteCommand({
    command: 'sync',
    pluginNames,
    commandOptions,
    runtime,
  });
}

export async function taskWriteCommand(
  targets: readonly RebuildTaskTarget[],
  options: RebuildTaskCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  const commandOptions = { ...options };
  delete commandOptions.repairTargets;
  const taskRuntime = options.allowManagedCodexInstall === true
    && !runtime.managedCodexAuthorizer
    ? { ...runtime, managedCodexAuthorizer: async () => true }
    : runtime;
  const execution = taskRuntime.previewOperationPlan === true
    ? runRebuildTaskCommand(targets, options, taskRuntime)
    : withAwHomeMutationLock({
        env: taskRuntime.env,
        token: taskRuntime.awHomeMutationToken,
        action: (token) => runRebuildTaskCommand(targets, options, {
          ...taskRuntime,
          awHomeMutationToken: token,
        }),
      });
  return execution.catch((error) => mergeWriteCommandResults(targets.map((target) =>
    failedWriteCommandResult(target.method, [target.pluginId], {
      ...commandOptions,
      platform: target.platform,
      scope: target.scope,
    }, error))));
}

export async function reinstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawReinstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('reinstall', pluginNames);
  const commandOptions = normalizeReinstallCommandOptions(rawOptions);
  return runPublicWriteCommand({ command: 'reinstall', pluginNames, commandOptions, runtime });
}

export async function uninstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawUninstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('uninstall', pluginNames);
  const commandOptions = normalizeUninstallCommandOptions(rawOptions);
  return runPublicWriteCommand({ command: 'uninstall', pluginNames, commandOptions, runtime });
}

export async function cleanupWriteCommand(
  pluginNames: string[],
  rawOptions: RawCleanupCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  const commandOptions = normalizeCleanupCommandOptions(rawOptions);
  requirePluginNames('cleanup', pluginNames, commandOptions.force);
  return runPublicWriteCommand({ command: 'cleanup', pluginNames, commandOptions, runtime });
}
