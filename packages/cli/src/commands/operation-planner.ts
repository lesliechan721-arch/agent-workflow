import type {
  StatusTargetRevision,
  StatusV8RecoveryAction,
  StatusV8State,
} from './status-v6.js';
import type { RebuildReceiptJson } from '../output/command-receipt.js';
import type { PlatformName, Scope } from '../types.js';

export type LifecycleActionId =
  | 'install'
  | 'sync'
  | 'refreshAndSync'
  | 'reinstall'
  | 'uninstall'
  | 'cleanup';

export type LifecycleActionReason =
  | 'targetAbsent'
  | 'statusRecovery'
  | 'orphanedManagedContent'
  | 'savedSettingsNotApplied'
  | 'newActiveVersion'
  | 'rebuildManagedContent'
  | 'removeManagedContent';

export interface AllowedLifecycleAction {
  id: LifecycleActionId;
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  reason: LifecycleActionReason;
  availableVersion?: string;
  refreshBeforeReview?: true;
}

export interface LifecycleTargetFacts {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  state: StatusV8State;
  recoveryActions: StatusV8RecoveryAction[];
  revision?: StatusTargetRevision['revision'];
  installable?: boolean;
  uninstallable?: boolean;
}

function recoveryAction(options: {
  target: LifecycleTargetFacts;
  recovery: StatusV8RecoveryAction;
}): AllowedLifecycleAction | undefined {
  const scope = options.recovery.scope ?? options.target.scope;
  const common = {
    pluginId: options.target.pluginId,
    platform: options.target.platform,
    scope,
    reason: 'statusRecovery' as const,
  };
  if (options.recovery.command === 'sync') {
    return { ...common, id: 'sync' };
  }
  if (options.recovery.command === 'reinstall') {
    return { ...common, id: 'reinstall' };
  }
  if (options.recovery.command === 'cleanup') {
    return { ...common, id: 'cleanup' };
  }
  if (options.recovery.command === 'uninstall') {
    return { ...common, id: 'uninstall' };
  }
  return undefined;
}

function uniqueActions(actions: AllowedLifecycleAction[]): AllowedLifecycleAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.id}\0${action.pluginId}\0${action.platform}\0${action.scope}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildAllowedLifecycleActions(
  target: LifecycleTargetFacts,
): AllowedLifecycleAction[] {
  if (target.state === 'absent') {
    return target.installable === false ? [] : [{
      id: 'install',
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      reason: 'targetAbsent',
    }];
  }
  if (target.state === 'orphaned') {
    const cleanup = target.recoveryActions.find((action) => action.command === 'cleanup');
    return cleanup ? [recoveryAction({ target, recovery: cleanup })!]
      : [{
          id: 'cleanup',
          pluginId: target.pluginId,
          platform: target.platform,
          scope: target.scope,
          reason: 'orphanedManagedContent',
        }];
  }
  const recovery = uniqueActions(target.recoveryActions.flatMap((action) =>
    recoveryAction({ target, recovery: action }) ?? []));
  if (target.state === 'blocked') {
    return recovery.filter((action) => action.id === 'cleanup' || action.id === 'uninstall');
  }
  if (target.state === 'needsSync') {
    if (target.recoveryActions.some((action) => action.command === 'manual')) {
      return target.uninstallable === false ? [] : [{
        id: 'uninstall',
        pluginId: target.pluginId,
        platform: target.platform,
        scope: target.scope,
        reason: 'removeManagedContent',
      }];
    }
    return recovery.length > 0 ? recovery : [{
      id: target.platform === 'codex' ? 'sync' : 'reinstall',
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      reason: 'savedSettingsNotApplied',
    }];
  }
  const actions: AllowedLifecycleAction[] = [];
  if (target.revision?.state === 'upgradeAvailable') {
    actions.push({
      id: 'refreshAndSync',
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      reason: 'newActiveVersion',
      availableVersion: target.revision.availableVersion,
      refreshBeforeReview: true,
    });
  }
  actions.push({
    id: 'reinstall',
    pluginId: target.pluginId,
    platform: target.platform,
    scope: target.scope,
    reason: 'rebuildManagedContent',
  });
  if (target.uninstallable !== false) {
    actions.push({
      id: 'uninstall',
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      reason: 'removeManagedContent',
    });
  }
  return actions;
}

export function selectLifecycleRetryAction(options: {
  operationKind: 'pluginWrite' | 'configSave' | 'configReset'
    | 'portableInstall' | 'sourceMutation' | 'catalogGeneration' | undefined;
  originalAction?: LifecycleActionId;
  target: LifecycleTargetFacts;
}): AllowedLifecycleAction | undefined {
  if (options.operationKind !== 'pluginWrite'
    && options.operationKind !== 'configSave'
    && options.operationKind !== 'configReset') return undefined;
  const actions = buildAllowedLifecycleActions(options.target);
  const select = (...ids: LifecycleActionId[]): AllowedLifecycleAction | undefined =>
    ids.flatMap((id) => actions.filter((action) => action.id === id))[0];
  if (options.operationKind === 'configSave' || options.operationKind === 'configReset') {
    return select('reinstall', 'sync');
  }
  if (options.originalAction === 'uninstall') return select('uninstall');
  if (options.originalAction === 'cleanup') return select('cleanup');
  if (options.target.state === 'absent') return select('install');
  return select('reinstall', 'sync');
}

export interface AllowedConfigAction {
  id: 'configSave' | 'configSaveAndApply';
  label: string;
  apply: boolean;
}

export function buildAllowedConfigActions(hasChanges: boolean): AllowedConfigAction[] {
  return hasChanges ? [
    { id: 'configSave', label: '保存', apply: false },
    { id: 'configSaveAndApply', label: '保存并应用', apply: true },
  ] : [];
}

export interface OperationResultModel {
  state: RebuildReceiptJson['overallState'];
  changes: string[];
  warnings: string[];
  targetResults: RebuildReceiptJson['targetResults'];
  commandResults?: RebuildReceiptJson['commandResults'];
  recoveryActions: string[];
  planFingerprint?: string;
  errors: RebuildReceiptJson['errors'];
}

export function buildOperationResultModel(receipt: RebuildReceiptJson): OperationResultModel {
  return {
    state: receipt.overallState,
    changes: [...receipt.changes],
    warnings: [...receipt.warnings],
    targetResults: structuredClone(receipt.targetResults),
    ...(receipt.commandResults ? { commandResults: structuredClone(receipt.commandResults) } : {}),
    recoveryActions: [...receipt.recoveryActions],
    ...(receipt.planFingerprint ? { planFingerprint: receipt.planFingerprint } : {}),
    errors: structuredClone(receipt.errors),
  };
}
