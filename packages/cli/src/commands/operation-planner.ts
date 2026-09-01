import type {
  StatusTargetRevision,
  StatusV7RecoveryAction,
  StatusV7State,
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

export interface AllowedLifecycleAction {
  id: LifecycleActionId;
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  label: string;
  description: string;
  availableVersion?: string;
  refreshBeforeReview?: true;
}

export interface LifecycleTargetFacts {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  state: StatusV7State;
  recoveryActions: StatusV7RecoveryAction[];
  revision?: StatusTargetRevision['revision'];
  installable?: boolean;
  uninstallable?: boolean;
}

function recoveryAction(options: {
  target: LifecycleTargetFacts;
  recovery: StatusV7RecoveryAction;
}): AllowedLifecycleAction | undefined {
  const scope = options.recovery.scope ?? options.target.scope;
  const common = {
    pluginId: options.target.pluginId,
    platform: options.target.platform,
    scope,
    description: options.recovery.description,
  };
  if (options.recovery.command === 'sync') {
    return { ...common, id: 'sync', label: '同步 desired intent' };
  }
  if (options.recovery.command === 'reinstall') {
    return { ...common, id: 'reinstall', label: '重新安装' };
  }
  if (options.recovery.command === 'cleanup') {
    return { ...common, id: 'cleanup', label: '清理 AW-owned 内容' };
  }
  if (options.recovery.command === 'uninstall') {
    return { ...common, id: 'uninstall', label: '移除插件' };
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
      label: '添加插件',
      description: '添加所选平台和使用位置。',
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
          label: '清理 AW-owned 内容',
          description: '只清理这个插件目标的 AW-owned 内容。',
        }];
  }
  const recovery = uniqueActions(target.recoveryActions.flatMap((action) =>
    recoveryAction({ target, recovery: action }) ?? []));
  if (target.state === 'blocked') {
    return recovery.filter((action) => action.id === 'cleanup' || action.id === 'uninstall');
  }
  if (target.state === 'needsSync') return recovery.length > 0 ? recovery : [{
    id: target.platform === 'codex' ? 'sync' : 'reinstall',
    pluginId: target.pluginId,
    platform: target.platform,
    scope: target.scope,
    label: target.platform === 'codex' ? '同步 desired intent' : '重新安装',
    description: target.platform === 'codex'
      ? '按已保存的 desired intent 修复当前现场。'
      : '保留设置并重新生成 AW-owned 内容。',
  }];
  const actions: AllowedLifecycleAction[] = [];
  if (target.revision?.state === 'upgradeAvailable') {
    actions.push({
      id: 'refreshAndSync',
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      label: '刷新并同步',
      description: '刷新相关来源后，使用新的 Active 内容同步。',
      availableVersion: target.revision.availableVersion,
      refreshBeforeReview: true,
    });
  }
  actions.push({
    id: 'reinstall',
    pluginId: target.pluginId,
    platform: target.platform,
    scope: target.scope,
    label: '重新安装',
    description: '保留设置并重新生成 AW-owned 内容。',
  });
  if (target.uninstallable !== false) {
    actions.push({
      id: 'uninstall',
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      label: '移除插件',
      description: '移除安装内容并保留设置。',
    });
  }
  return actions;
}

export function selectLifecycleRetryAction(options: {
  operationKind: 'pluginWrite' | 'configSave' | 'configReset'
    | 'portableInstall' | 'sourceMutation' | undefined;
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
    recoveryActions: [...receipt.recoveryActions],
    ...(receipt.planFingerprint ? { planFingerprint: receipt.planFingerprint } : {}),
    errors: structuredClone(receipt.errors),
  };
}
