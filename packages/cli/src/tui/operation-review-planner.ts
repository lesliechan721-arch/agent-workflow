import { requestedIntentAction } from '../output/command-receipt.js';
import type { PortableRetryReview } from '../portable/commands.js';
import type { PlatformName } from '../types.js';
import type {
  OperationEvidence,
  OperationIntent,
  OperationReviewChange,
  PluginWriteBatchEvidence,
  PluginWriteBatchGroupEvidence,
  PluginWriteOperation,
  PluginWriteTaskEvidence,
  PluginWriteTaskSourceEvidence,
} from './controller.js';
import type { PluginDependencyOverviewViewModel } from './model.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import type { OfflineCleanupTargetEvidence } from '../commands/offline-cleanup-evidence.js';
import { catalogSourceAutoCheckOnlyValue } from './catalog-sources/review.js';
import {
  parseScriptTimeoutMs,
  SCRIPT_TIMEOUT_DEFAULT_MS,
} from '../commands/options.js';
import { MANAGED_CODEX_VERSION } from '../utils/codex-manager.js';
import { platformLabel, scopeLabel } from './glossary.js';

function plannerError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function pluginNameFromId(pluginId: string): string {
  const separator = pluginId.indexOf('/');
  return separator < 0 ? pluginId : pluginId.slice(separator + 1);
}

function scriptTimeoutChanges(intent: OperationIntent): OperationReviewChange[] {
  let configuredTimeoutMs: number | undefined;
  if (intent.kind === 'pluginWriteTask') {
    configuredTimeoutMs = intent.scriptTimeoutMs;
  } else if ((intent.kind === 'pluginWrite' || intent.kind === 'pluginWriteBatch')
    && (intent.action === 'install' || intent.action === 'refreshAndSync'
      || intent.action === 'reinstall' || intent.action === 'sync')) {
    configuredTimeoutMs = intent.scriptTimeoutMs;
  } else if (intent.kind === 'configSave' && intent.apply) {
    configuredTimeoutMs = intent.scriptTimeoutMs;
  } else {
    return [];
  }
  const timeoutMs = parseScriptTimeoutMs(configuredTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS);
  return [{
    kind: 'keep',
    group: 'runtime',
    title: 'preApply 脚本超时',
    description: `${timeoutMs} ms`,
  }];
}

function preApplyScopeChanges(
  targets: ReadonlyArray<{
    pluginId: string;
    platform: PlatformName;
    scope: 'project' | 'user';
    relation?: 'requested' | 'direct' | 'transitive';
  }>,
): OperationReviewChange[] {
  return [...new Map(targets.map((target) => [[
    target.pluginId,
    target.platform,
    target.scope,
  ].join('\0'), target] as const)).values()].map((target) => ({
    kind: 'change',
    group: 'runtime',
    pluginId: target.pluginId,
    ...(target.relation ? { relation: target.relation } : {}),
    title: `运行 ${target.pluginId} preApply`,
    description: `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
  }));
}

function operationPreApplyTargets(evidence?: OperationEvidence) {
  return (evidence?.operationPlan?.actions ?? []).flatMap((action) =>
    action.kind === 'runPreApply'
      ? [{
          ...action,
          ...(evidence?.dependencyPlan
            ? { relation: dependencyRelation(evidence.dependencyPlan, action.pluginId) }
            : {}),
        }]
      : []);
}

function offlineCleanupPlans(evidence: OperationEvidence | undefined): OfflineCleanupTargetEvidence[] {
  if (!evidence) return [];
  return evidence.offlineCleanupPlans
    ?? (evidence.offlineCleanup ? [evidence.offlineCleanup] : []);
}

function removesOfflineCleanupIntent(
  plan: NonNullable<OperationEvidence['operationPlan']>,
  target: OfflineCleanupTargetEvidence,
): boolean {
  return plan.changes.includes(
    `${target.pluginId}:${target.platform}:${target.scope}:removeIntent`,
  );
}

function offlineCleanupReviewChanges(evidence: OperationEvidence): OperationReviewChange[] {
  const operationPlan = evidence.operationPlan;
  return offlineCleanupPlans(evidence).flatMap((target): OperationReviewChange[] => {
    const targetDescription = `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`;
    const removesIntent = operationPlan !== undefined && removesOfflineCleanupIntent(operationPlan, target);
    const actions = target.plan.actions.length;
    return [
      {
        kind: 'change' as const,
        group: 'requested' as const,
        pluginId: target.pluginId,
        relation: 'requested' as const,
        title: '核验当前 AW 管理现场',
        description: targetDescription,
      },
      ...(removesIntent ? [{
        kind: 'remove' as const,
        group: 'requested' as const,
        pluginId: target.pluginId,
        relation: 'requested' as const,
        title: '取消已保存的使用设置',
        description: targetDescription,
      }] : []),
      actions > 0 ? {
        kind: 'remove' as const,
        group: 'requested' as const,
        pluginId: target.pluginId,
        relation: 'requested' as const,
        title: '移除可验证的 AW 输出',
        description: `${targetDescription} · ${actions} 项`,
      } : {
        kind: 'keep' as const,
        group: 'preserved' as const,
        pluginId: target.pluginId,
        relation: 'requested' as const,
        title: '没有可验证的 AW 输出',
        description: removesIntent
          ? `${targetDescription} · 仍会取消此位置的使用设置`
          : `${targetDescription} · 不会删除现场内容`,
      },
    ];
  });
}

function offlineCleanupPreservedChanges(evidence: OperationEvidence): OperationReviewChange[] {
  const plans = offlineCleanupPlans(evidence);
  if (plans.length === 0) return [];
  const warnings = evidence.operationPlan?.warnings ?? [];
  return [
    ...(warnings.length > 0 ? [{
      kind: 'warning' as const,
      group: 'preserved' as const,
      title: '部分现场残留无法完整核验',
      description: '这些残留会保留；可在之后重新清理。',
    }] : []),
    {
      kind: 'keep' as const,
      group: 'preserved' as const,
      title: '保留不属于插件或被共用的内容、插件设置、依赖使用范围和其他平台或位置',
    },
    {
      kind: 'keep' as const,
      group: 'preserved' as const,
      title: '其他根插件仍可按自己的设置使用或安装此依赖',
    },
  ];
}

function sourceMutationReviewChanges(
  mutation: NonNullable<Extract<OperationIntent, { kind: 'catalogGeneration' }>['sourceMutation']>,
): OperationReviewChange[] {
  if (mutation.action === 'add') {
    const source = mutation.source;
    return [
      { kind: 'add', title: '保存来源配置' },
      { kind: 'add', title: source.type === 'git' ? 'Git URL' : '本地目录', description: '已设置' },
      ...(source.type === 'git' ? [{
        kind: 'add' as const,
        title: 'Git ref policy',
        description: source.refPolicy.type === 'cliChannel'
          ? '跟随 CLI channel'
          : `固定 ref · ${source.refPolicy.ref}`,
      }, {
        kind: 'add' as const,
        title: '插件目录子目录',
        description: source.subdir ?? '根目录',
      }] : []),
      {
        kind: 'add',
        title: '自动检查',
        description: source.autoCheck === false ? '关闭' : '开启',
      },
    ];
  }
  const update = mutation.update;
  const changes: OperationReviewChange[] = [];
  if ('url' in update && update.url !== undefined) {
    changes.push({ kind: 'change', title: 'Git URL', description: '将更新' });
  }
  if ('path' in update && update.path !== undefined) {
    changes.push({ kind: 'change', title: '本地目录', description: '将更新' });
  }
  if ('refPolicy' in update && update.refPolicy) changes.push({
    kind: 'change',
    title: 'Git ref policy',
    description: update.refPolicy.type === 'cliChannel'
      ? '跟随 CLI channel'
      : `固定 ref · ${update.refPolicy.ref}`,
  });
  if ('subdir' in update && update.subdir !== undefined) changes.push({
    kind: 'change',
    title: '插件目录子目录',
    description: update.subdir ?? '根目录',
  });
  if ('autoCheck' in update && update.autoCheck !== undefined) changes.push({
    kind: 'change',
    title: '自动检查',
    description: update.autoCheck ? '开启' : '关闭',
  });
  return changes.length > 0 ? changes : [{ kind: 'change', title: '更新来源配置' }];
}

function operationLabels(intent: OperationIntent, evidence?: OperationEvidence): {
  title: string;
  description: string;
  primaryLabel: string;
  destructive: boolean;
} {
  if (intent.kind === 'catalogSourcesRecovery') {
    return {
      title: '恢复插件目录来源配置',
      description: '备份损坏配置，并恢复唯一的主来源 official。',
      primaryLabel: '备份并恢复官方默认来源',
      destructive: false,
    };
  }
  if (intent.kind === 'portableInstall') {
    return {
      title: '确认安装通用 Skills',
      description: '只安装已选择的 Skills；不会修改原生插件安装。',
      primaryLabel: `开始安装 ${intent.selectedSkills.length} 个 Skills`,
      destructive: false,
    };
  }
  if (intent.kind === 'pluginWriteBatch') {
    const labels = {
      install: ['批量添加插件', '添加所选插件及其必需依赖。'],
      sync: ['批量同步插件', '按已保存的设置同步所选插件。'],
      reinstall: ['批量重新安装插件', '清理 AW 管理的内容后完整重建所选插件。'],
      uninstall: ['批量移除插件', '移除所选插件的 AW 管理安装内容。配置保持不变。'],
      cleanup: ['批量清理插件', '先核验所选位置，再取消其使用设置，并尽力清理可验证的 AW 输出。'],
    } as const;
    const [title, description] = labels[intent.action];
    return {
      title,
      description,
      primaryLabel: title,
      destructive: intent.action === 'reinstall' || intent.action === 'uninstall'
        || intent.action === 'cleanup',
    };
  }
  if (intent.kind === 'pluginWriteTask') {
    const targetVersions = [...new Set(intent.targets.flatMap((target) =>
      target.expectedUpdate ? [target.expectedUpdate.activeVersion] : []))];
    const updateVersion = targetVersions.length === 1 ? `到 ${targetVersions[0]}` : '';
    return {
      title: intent.goal === 'update' ? `确认更新${updateVersion}` : '确认恢复所选插件',
      description: intent.goal === 'update'
        ? '使用当前已启用目录中的已确认版本更新所选安装位置。'
        : '按已确认根因恢复所选安装位置，并保持已安装版本。',
      primaryLabel: intent.goal === 'update' ? '开始更新' : '开始恢复',
      destructive: false,
    };
  }
  if (intent.kind === 'pluginWrite') {
    if (intent.originIssue) {
      if (intent.action === 'cleanup') {
        return {
          title: '清理已安装内容',
          description: '先核验所选位置，再取消其使用设置，并尽力清理可验证的 AW 输出。',
          primaryLabel: '开始清理',
          destructive: true,
        };
      }
      return {
        title: '处理问题',
        description: '只执行所选问题处理动作；插件设置保持不变。',
        primaryLabel: '开始处理',
        destructive: intent.action !== 'reinstall',
      };
    }
    if (intent.action === 'cleanup' && intent.force === true) {
      return {
        title: '强制清理插件',
        description: '先核验专属 AW 输出，再取消所选位置的使用设置并尽力清理；插件设置保持不变，依赖者会变为不完整。',
        primaryLabel: '确认强制清理',
        destructive: true,
      };
    }
    const labels: Record<PluginWriteOperation, [string, string, boolean]> = {
      install: ['添加插件', '添加所选平台和使用位置。', false],
      refreshAndSync: ['刷新并同步', '刷新相关来源后，使用新的当前启用版本同步所选安装。', false],
      reinstall: ['重新安装插件', '清理 AW 管理的内容后完整重建。', true],
      uninstall: ['移除插件', '移除 AW 管理的安装内容。配置保持不变。', true],
      cleanup: ['清理插件', '先核验所选位置，再取消其使用设置，并尽力清理可验证的 AW 输出。', true],
      sync: ['同步插件', '按已保存使用设置修复当前使用位置。', false],
    };
    if (intent.expectedUpdate) return {
      title: `更新到 ${intent.expectedUpdate.activeVersion}`,
      description: `使用当前启用目录中已确认的 ${intent.expectedUpdate.activeVersion} 同步所选安装。`,
      primaryLabel: `更新到 ${intent.expectedUpdate.activeVersion}`,
      destructive: false,
    };
    const [title, description, destructive] = labels[intent.action];
    return { title, description, primaryLabel: title, destructive };
  }
  if (intent.kind === 'configSave') {
    if (intent.retryApply) {
      return {
        title: '重试应用插件设置',
        description: '重新读取当前设置和安装证据；不会恢复或重写历史值。',
        primaryLabel: '重试应用',
        destructive: false,
      };
    }
    return {
      title: intent.apply ? '保存并应用插件设置' : '保存插件设置',
      description: intent.apply
        ? '保存所选设置层，并重新应用可见安装。'
        : '只保存所选设置层；当前安装保持不变。',
      primaryLabel: intent.apply ? '保存并应用' : '保存',
      destructive: false,
    };
  }
  if (intent.kind === 'configReset') {
    return {
      title: '重置插件设置',
      description: '删除所选设置层的值，恢复继承。',
      primaryLabel: '重置设置',
      destructive: true,
    };
  }
  if (intent.kind === 'sourceMutation') {
    const autoCheck = intent.action === 'update'
      ? catalogSourceAutoCheckOnlyValue(intent.update) : undefined;
    if (autoCheck !== undefined) {
      return {
        title: '保存自动检查设置',
        description: '只保存自动检查设置；当前启用版本和本地目录副本保持不变。',
        primaryLabel: '保存设置',
        destructive: false,
      };
    }
    const labels = {
      add: ['添加来源', '只保存来源配置。保存后请在终端运行 source sync。', '保存来源', false],
      update: ['修改来源', '只保存来源配置。保存后请在终端运行 source sync。', '保存来源', false],
      setPrimary: ['设为主来源', '只改变默认 marketplace，不迁移安装。', '设为主来源', false],
      remove: ['移除来源', '移除来源配置；不会删除其它来源。', '移除来源', true],
    } as const;
    const [title, description, primaryLabel, destructive] = labels[intent.action];
    return { title, description, primaryLabel, destructive };
  }
  if (intent.kind === 'catalogGeneration') {
    if (intent.action === 'update' && evidence?.catalogGeneration?.exactRepair) {
      return {
        title: '验证并精确修复插件目录',
        description: '待检查版本与当前启用版本的技术标识相同。精确替换损坏内容，并保留当前启用版本。',
        primaryLabel: '验证并精确修复',
        destructive: false,
      };
    }
    const labels = {
      activate: ['获取并启用插件目录', '检查待检查版本后启用。不会升级已安装插件，也不会修改其他来源。', '获取并启用'],
      update: ['检查并切换插件目录', '检查待检查版本后切换当前启用版本。失败时保留原当前启用版本。', '检查并切换'],
      repair: ['重新下载并修复插件目录', '只修复这个来源的当前启用版本，不删除其他目录版本副本。', '重新下载并修复'],
      replaceDamaged: ['替换损坏的当前启用版本', '使用待检查版本替换无法精确修复的当前启用版本。失败时保留原版本。', '确认并替换'],
      recoverState: ['恢复插件目录状态并启用', '重建无效的目录版本状态，并只启用已确认的目标来源。来源配置和本地目录副本保持不变。', '恢复状态并启用'],
    } as const;
    const [title, description, primaryLabel] = labels[intent.action];
    return { title, description, primaryLabel, destructive: false };
  }
  throw plannerError(
    'operationNotImplemented',
    '问题修复操作尚未接入。',
  );
}

function dependencyRelation(
  plan: ReconcileOperationPlan,
  pluginId: string,
): 'requested' | 'direct' | 'transitive' {
  if (plan.requestedPluginIds.includes(pluginId)) return 'requested';
  return plan.dependencyEdges.some((edge) =>
    plan.requestedPluginIds.includes(edge.from) && edge.to === pluginId)
    ? 'direct'
    : 'transitive';
}

function reviewChanges(
  intent: OperationIntent,
  evidence?: OperationEvidence,
  dependencyOverview?: PluginDependencyOverviewViewModel,
): OperationReviewChange[] {
  if (intent.kind === 'catalogSourcesRecovery') {
    return [
      { kind: 'add', title: '备份损坏的 catalog-sources.json' },
      { kind: 'change', title: '恢复唯一的主来源 official' },
      { kind: 'keep', title: '保留 catalog-state.json 和 catalog-store' },
      {
        kind: 'warning',
        title: '自定义来源需要之后重新添加',
        description: '无法从损坏配置中安全恢复自定义来源。',
      },
    ];
  }
  if (intent.kind === 'portableInstall') {
    const review = evidence?.portable;
    if (!review) throw plannerError('portablePrepareFailed', '缺少通用 Skills Review 证据。');
    const retry = 'targetGroups' in review ? review as PortableRetryReview : undefined;
    return [
      ...review.selected.map((skill): OperationReviewChange => ({
        kind: 'add',
        group: skill.relation === 'requested' ? 'requested' : 'dependencies',
        pluginId: skill.providerPluginId,
        relation: skill.relation,
        title: skill.name,
        description: `${skill.description} · ${skill.providerDisplayName}${skill.dynamic ? ' · 按设置生成' : ''}`,
      })),
      ...(retry ? retry.targetGroups.map((group): OperationReviewChange => ({
        kind: 'change',
        group: 'portableTarget',
        title: `精确重试 · ${group.agent}`,
        description: group.skills.join('、'),
      })) : [{ kind: 'change' as const, group: 'portableTarget' as const, title: 'Agent', description: review.agentMode === 'automatic'
        ? '自动选择检测到的 Agent；实际目标由 Skills CLI 决定，不表示安装到所有 Agent'
        : review.requestedAgents.join('、') }]),
      { kind: 'change', group: 'portableTarget', title: '范围', description: review.scope === 'project' ? '当前项目' : '所有项目' },
      { kind: review.dependencies.length > 0 ? 'keep' : 'change', group: 'portableInputs', title: '插件依赖', description: review.dependencies.length > 0
        ? `${review.dependencies.length} 个依赖用于生成，不能取消` : '无需插件依赖' },
      ...(review.collisions.length > 0 ? [{ kind: 'warning' as const, group: 'portableWarnings' as const, title: '同名覆盖',
        description: review.collisions.map((collision) => collision.name).join('、') }] : []),
    ];
  }
  if (intent.kind === 'pluginWrite') {
    const desiredIntentKind = requestedIntentAction(
      intent.action === 'refreshAndSync' ? 'sync' : intent.action,
    );
    const runtimeChanges: OperationReviewChange[] = [
      ...scriptTimeoutChanges(intent),
      ...preApplyScopeChanges(operationPreApplyTargets(evidence)),
      ...(evidence?.codexManager
      ? [{
          kind: evidence.codexManager.state === 'requires-install' ? 'add' : 'keep',
          group: 'runtime',
          title: evidence.codexManager.state === 'requires-install'
            ? '获取 Codex 运行组件'
            : 'Codex 运行组件',
          description: evidence.codexManager.state === 'requires-install'
            ? `${evidence.codexManager.packageName}@${evidence.codexManager.version} · AW 管理缓存`
            : evidence.codexManager.state === 'cached'
              ? `${evidence.codexManager.packageName}@${evidence.codexManager.version} · 复用 AW 管理缓存`
              : `使用兼容的系统 Codex ${evidence.codexManager.version}`,
        } satisfies OperationReviewChange]
      : []),
    ];
    const codexChanges = (evidence?.codexReconcilePlans ?? []).flatMap((codexPlan) => [
      ...codexPlan.sharedNativeActions.map((action): OperationReviewChange => ({
        kind: action.action === 'reuse' || action.action === 'none' ? 'keep'
          : action.action === 'install' ? 'add' : 'change',
        group: 'sharedCodexNative',
        pluginId: action.pluginId,
        title: action.codexPluginId,
        description: action.action === 'reuse'
          ? '复用完全相同的由平台共用内容'
          : `${({
              install: '添加',
              update: '更新',
              repair: '修复',
              replace: '替换',
              remove: '移除',
              none: '保持不变',
            } as const)[action.action]}由平台共用的内容${action.affectsOtherScopes ? ' · 可能影响其他项目' : ''}`,
      })),
      ...codexPlan.activationActions.user.map((action): OperationReviewChange => ({
        kind: action.action === 'none' ? 'keep' : action.desired ? 'change' : 'remove',
        group: 'userActivation',
        pluginId: action.pluginId,
        title: action.codexPluginId,
        description: `${action.desired ? '启用' : '停用'}所有项目位置 · ${action.action === 'none' ? '保持不变' : '将更新'}`,
      })),
      ...codexPlan.activationActions.project.map((action): OperationReviewChange => ({
        kind: action.action === 'none' ? 'keep' : action.desired ? 'change' : 'remove',
        group: 'projectActivation',
        pluginId: action.pluginId,
        title: action.codexPluginId,
        description: `${action.desired ? '启用' : '停用'}当前项目位置 · ${action.action === 'none' ? '保持不变' : '将更新'}`,
      })),
      ...[...codexPlan.extensionWrites, ...codexPlan.extensionRemovals]
        .map((action): OperationReviewChange => ({
          kind: action.action === 'write' ? 'change' : 'remove',
          group: 'awExtensions',
          pluginId: action.pluginId,
          title: action.componentKey,
          description: `${scopeLabel(action.scope)} · ${action.action === 'write' ? '写入' : '移除'}`,
        })),
    ]);
    const plan = evidence?.dependencyPlan;
    if (plan && (intent.action === 'install' || intent.action === 'refreshAndSync'
      || intent.action === 'reinstall' || intent.action === 'sync')) {
      const changes = plan.targets.map((target): OperationReviewChange => {
        const relation = dependencyRelation(plan, target.pluginId);
        return {
          kind: desiredIntentKind,
          group: relation === 'requested' ? 'requested' : 'dependencies',
          pluginId: target.pluginId,
          relation,
          title: pluginNameFromId(target.pluginId),
          description: `${platformLabel(target.platform)} · ${scopeLabel(target.resolvedScope)}${target.action === 'keep' ? ' · 已可用' : ''}${target.assignmentSource === 'existingWiderTarget' ? ' · 复用健康的所有项目安装' : target.assignmentSource === 'consumerPromotion' ? ' · 根据依赖自动扩大范围' : ''}`,
        };
      });
      changes.push({
        kind: 'keep',
        group: 'preserved',
        title: '插件设置和已有依赖保持不变',
        description: '移除根插件时不会自动清理依赖。',
      });
      return [...changes, ...codexChanges, ...runtimeChanges];
    }
    if (intent.action === 'cleanup' && evidence) {
      const cleanupChanges = offlineCleanupReviewChanges(evidence);
      if (cleanupChanges.length > 0) {
        const changes: OperationReviewChange[] = [
          ...cleanupChanges,
          ...offlineCleanupPreservedChanges(evidence),
        ];
        if (intent.force === true) changes.push({
          kind: 'warning',
          title: '跳过依赖保护',
          description: '依赖此插件的插件会变为不完整，需重新安装后恢复。',
        });
        return [...changes, ...codexChanges, ...runtimeChanges];
      }
    }
    const platforms: PlatformName[] = intent.platform === 'both'
      ? ['codex', 'claude']
      : [intent.platform];
    const changes = platforms.map((platform): OperationReviewChange => ({
      kind: intent.action === 'uninstall' || intent.action === 'cleanup' ? 'remove' : intent.action === 'install' ? 'add' : 'change',
      group: 'requested',
      pluginId: intent.pluginId,
      relation: 'requested',
      title: `${platformLabel(platform)} · ${scopeLabel(intent.scope)}`,
      description: intent.action === 'uninstall' || intent.action === 'cleanup'
        ? '插件设置不会删除。'
        : '执行前会再次检查当前安装状态。',
    }));
    if (intent.action === 'uninstall' || intent.action === 'cleanup') {
      changes.push(...(dependencyOverview?.dependencies ?? []).map((dependency) => ({
        kind: 'keep' as const,
        group: 'preserved' as const,
        pluginId: dependency.pluginId,
        relation: dependency.relation === 'direct' ? 'direct' as const : 'transitive' as const,
        title: dependency.displayName,
        description: '依赖保持安装。',
      })));
    }
    if (intent.action === 'cleanup' && intent.force === true) {
      changes.push({
        kind: 'warning',
        title: '跳过依赖保护',
        description: '依赖此插件的插件会变为不完整，需重新安装后恢复。',
      });
    }
    if (intent.originIssue) {
      changes.push(
        { kind: 'keep', title: '插件设置保持不变' },
        { kind: 'warning', title: '执行前重新检查完整目标和来源证据' },
      );
    }
    if (intent.recoveryDescription) {
      changes.push({
        kind: 'warning',
        group: 'preserved',
        title: `后续：同步${intent.scope === 'user' ? '当前项目' : '所有项目'}位置`,
        description: '完成此操作后，同步要保留的使用位置。',
      });
    }
    return [...changes, ...codexChanges, ...runtimeChanges];
  }
  if (intent.kind === 'configReset') {
    const layerLabel = intent.scope === 'user'
      ? '个人默认'
      : '当前项目';
    const impact = evidence?.config;
    const impactChanges: OperationReviewChange[] = impact?.impactState === 'unknown'
      ? [{
          kind: 'warning', group: 'configImpact', title: '设置重置后的应用影响未知',
          description: '当前无法解析来源或设置；重置仍会删除所选设置层。',
        }]
      : impact?.noEffectiveChange
        ? [{ kind: 'keep', group: 'configImpact', title: '有效设置输入不变；无需同步当前安装' }]
        : (impact?.affectedTargets ?? []).length > 0
          ? impact!.affectedTargets.map((target): OperationReviewChange => ({
              kind: 'warning', group: 'configImpact',
              title: `重置后需同步 ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.scope === 'user' ? '所有项目' : '当前项目'}`,
            }))
          : [{ kind: 'keep', group: 'configImpact', title: '只删除设置层；当前安装保持不变' }];
    return [
      ...(intent.changes?.map((change): OperationReviewChange => ({
        kind: 'remove', group: 'configChanges', title: `${layerLabel} · ${change.title}`,
        description: change.children && change.children.length > 0
          ? `${change.before} → ${change.after}；${change.children.length} 个子项变化；${change.children.map((child) =>
              `${child.property}: ${child.private ? '已设置 → 将更新' : `${child.before} → ${child.after}`}`,
            ).join('；')}`
          : `${change.before} → ${change.after}`,
      })) ?? [{ kind: 'remove' as const, group: 'configChanges' as const, title: `删除${layerLabel}中的已存值`, description: '删除整个设置层且不创建备份；有效值将恢复为继承值或默认值。' }]),
      ...impactChanges,
      { kind: 'keep', group: 'preserved', title: intent.scope === 'user' ? '当前项目设置保持不变' : '个人默认保持不变' },
    ];
  }
  if (intent.kind === 'sourceMutation') {
    const changes = (intent.changes ?? []).map((change): OperationReviewChange => ({
      kind: intent.action === 'remove' ? 'remove' : intent.action === 'add' ? 'add' : 'change',
      title: change.title,
      ...(change.private
        ? { description: change.before ? '已设置 → 将更新' : '已选择' }
        : change.before || change.after
          ? { description: `${change.before ?? '未设置'} → ${change.after ?? '未设置'}` }
          : {}),
    }));
    if (intent.action === 'add') changes.push({ kind: 'keep', title: '保留现有主来源' });
    if (intent.action === 'setPrimary') changes.push(
      { kind: 'keep', title: '同名插件选择保持不变' },
      { kind: 'keep', title: '现有安装和设置不会迁移' },
    );
    if (intent.action === 'remove') changes.push({ kind: 'keep', title: '保留其他来源' });
    const impact = evidence?.sourceWrite?.impact;
    if (impact) {
      for (const category of ['installation', 'config', 'lifecycle', 'marketplace'] as const) {
        const count = impact.affectedReferences.filter((reference) => reference.category === category).length;
        if (count > 0) changes.push({
          kind: 'warning',
          title: `${category === 'installation' ? '安装' : category === 'config' ? '设置' : category === 'lifecycle' ? '生命周期意图' : 'Marketplace'}引用受影响`,
          description: `${count} 项`,
        });
      }
      if (!impact.inventoryComplete) changes.push({
        kind: 'warning',
        title: '来源影响未知',
        description: '部分状态无法读取；不能把影响视为零。',
      });
    }
    return changes;
  }
  if (intent.kind === 'catalogGeneration') {
    const generation = evidence?.catalogGeneration;
    if (!generation) {
      throw plannerError('catalogGenerationUnavailable', '缺少插件目录待检查版本证据。');
    }
    return [
      ...(generation.previousActive ? [{
        kind: 'keep' as const,
        title: generation.previousActiveVersion
          ? `当前启用版本 ${generation.previousActiveVersion}` : '当前启用版本',
        description: `${generation.previousActive.resolvedCommit.slice(0, 8)} · ${generation.previousActive.snapshotDigest.slice(0, 15)}`,
      }] : []),
      {
        kind: intent.action === 'activate' ? 'add' as const : 'change' as const,
        title: generation.exactRepair
          ? `精确修复待检查版本 ${generation.candidate.catalogVersion}`
          : `待检查版本 ${generation.candidate.catalogVersion}`,
        description: `${generation.candidate.resolvedCommit.slice(0, 8)} · ${generation.candidate.snapshotDigest.slice(0, 15)}`,
      },
      ...(generation.exactRepair ? [{
        kind: 'change' as const,
        title: '精确替换损坏的当前启用版本',
        description: '版本和内容的技术标识保持不变。',
      }] : []),
      ...(intent.action === 'replaceDamaged' ? [{
        kind: 'warning' as const,
        title: '使用待检查版本替换损坏的当前启用版本',
        description: '旧版本无法安全比较；确认后只切换到本次已检查的版本。',
      }] : []),
      ...(generation.sourceMutation ? sourceMutationReviewChanges(generation.sourceMutation) : []),
      ...(generation.explicitSourceChange && generation.candidateRelation === 'rollbackDetected' ? [{
        kind: 'warning' as const,
        title: '来源切换将降低插件目录版本',
        description: `${generation.previousActiveVersion ?? '当前版本'} → ${generation.candidate.catalogVersion}`,
      }] : generation.explicitSourceChange && generation.candidateRelation === 'versionConflict' ? [{
        kind: 'warning' as const,
        title: '来源切换包含同版本不同内容',
        description: `${generation.candidate.catalogVersion} · ${generation.candidate.snapshotDigest.slice(0, 15)}`,
      }] : generation.explicitSourceChange && generation.candidateRelation === 'incompatible' ? [{
        kind: 'warning' as const,
        title: '来源切换将改变插件目录身份',
        description: '确认前请核对新来源身份和待检查版本摘要。',
      }] : []),
      ...((generation.impact?.affectedReferences ?? []).length > 0 ? [{
        kind: 'warning' as const,
        title: '现有引用受待检查版本影响',
        description: `${generation.impact!.affectedReferences.length} 项；已安装插件不会自动修改。`,
      }] : []),
      ...(generation.impact && !generation.impact.inventoryComplete ? [{
        kind: 'warning' as const,
        title: '待检查版本的影响未知',
        description: '部分状态或旧插件定义无法读取；不能把影响视为零。',
      }] : []),
      ...((generation.primaryImpact?.affectedReferences ?? []).length > 0 ? [{
        kind: 'warning' as const,
        title: '切换主来源会影响现有引用',
        description: `${generation.primaryImpact!.affectedReferences.length} 项；切换将在插件目录启用后执行。`,
      }] : []),
      ...(generation.primaryImpact && !generation.primaryImpact.inventoryComplete ? [{
        kind: 'warning' as const,
        title: '主来源切换影响未知',
        description: '部分状态无法读取；不能把影响视为零。',
      }] : []),
      { kind: 'keep', title: '不会升级已安装插件' },
      { kind: 'keep', title: intent.action === 'recoverState'
        ? '不会修改其他来源配置或本地目录副本' : '不会修改其他来源' },
      { kind: 'keep', title: '失败时保留原当前启用版本' },
      ...(intent.action === 'recoverState' ? [{
        kind: 'warning' as const,
        title: '无效状态中的其他当前启用版本记录不会保留',
        description: '其他来源配置和本地目录副本不会删除；可分别重新启用。',
      }] : []),
    ];
  }
  if (intent.kind !== 'configSave') {
    throw plannerError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
  }
  const privateKeys = new Set([...(intent.sensitiveKeys ?? []), ...(intent.privateKeys ?? [])]);
  const removeKeys = new Set(intent.removeKeys ?? []);
  const layerLabel = intent.scope === 'user' ? '个人默认' : '当前项目';
  if (intent.retryApply) {
    return [
      ...scriptTimeoutChanges(intent),
      ...preApplyScopeChanges(evidence?.config?.preApplyAuthorization ?? []),
      ...(evidence?.config?.affectedTargets.map((target): OperationReviewChange => ({
        kind: 'change',
        group: 'configImpact',
        title: `重新应用 ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.scope === 'user' ? '所有项目' : '当前项目'}`,
      })) ?? []),
      { kind: 'keep', group: 'preserved', title: `${layerLabel}中的当前值保持不变` },
      { kind: 'keep', group: 'preserved', title: '不会恢复历史设置值' },
    ];
  }
  if (intent.changes) {
    const noEffectiveChange = evidence?.config?.noEffectiveChange === true;
    const hasAffectedCodexTarget = evidence?.config?.affectedTargets.some(
      (target) => target.platform === 'codex',
    ) ?? false;
    const sharedNativeTargets = hasAffectedCodexTarget
      ? evidence?.config?.sharedNativeRenderTargets ?? []
      : [];
    const sharedNativeImpact: OperationReviewChange[] = noEffectiveChange || sharedNativeTargets.length === 0
      ? []
      : intent.apply
        ? [
            {
              kind: 'change', group: 'configImpact',
              title: `重新生成 ${sharedNativeTargets.map((target) => target.skillKey).join('、')} 动态 Skill`,
              description: '配置来源为个人默认；更新 Codex 由平台共用的内容会影响所有启用项目。',
            },
            { kind: 'keep', group: 'preserved', title: '保留所有项目和当前项目的启用位置' },
            { kind: 'keep', group: 'preserved', title: '当前项目 Agent role 继续使用当前项目配置' },
          ]
        : [
            {
              kind: 'warning', group: 'configImpact',
              title: 'Codex 由平台共用的内容待同步',
              description: '个人默认已保存；动态 Skill 尚未重新生成。',
            },
            { kind: 'keep', group: 'preserved', title: '当前由平台共用的内容和启用位置保持不变' },
            { kind: 'keep', group: 'preserved', title: '当前项目 Agent role 继续使用当前项目配置' },
          ];
    return [
      ...scriptTimeoutChanges(intent),
      ...preApplyScopeChanges(evidence?.config?.preApplyAuthorization ?? []),
      ...(evidence?.config?.shareability === 'unverified' ? [{
        kind: 'warning' as const,
        group: 'configImpact' as const,
        title: 'Git 无法验证 project config 可共享',
        description: '可以继续写入，但不要将该路径视为已验证可提交。',
      }] : []),
      ...intent.changes.map((change): OperationReviewChange => ({
        kind: removeKeys.has(change.key) ? 'remove' : 'change',
        group: 'configChanges',
        title: removeKeys.has(change.key)
          ? `${layerLabel} · 删除 ${change.title} 中的值`
          : `${layerLabel} · ${change.title}`,
        description: change.children && change.children.length > 0
          ? `${change.before} → ${change.after}；${change.children.length} 个子项变化；${change.children.map((child) =>
              `${child.property}: ${child.private ? '已设置 → 将更新' : `${child.before} → ${child.after}`}`,
            ).join('；')}`
          : removeKeys.has(change.key)
          ? privateKeys.has(change.key) ? `已设置 → ${change.after}` : `${change.before} → ${change.after}`
          : privateKeys.has(change.key) ? '已设置 → 将更新'
          : `${change.before} → ${change.after}`,
      })),
      ...(evidence?.config?.impactState === 'unknown' ? [{
        kind: 'warning' as const, group: 'configImpact' as const,
        title: '设置的应用影响未知',
        description: '当前无法比较保存前后的有效设置输入。',
      }] : noEffectiveChange ? [{
        kind: 'keep' as const, group: 'configImpact' as const,
        title: '有效设置输入不变；无需重新应用',
      }] : []),
      ...sharedNativeImpact,
      ...(evidence?.config?.impactState === 'unknown' || noEffectiveChange || sharedNativeTargets.length > 0
        ? []
        : intent.apply && (evidence?.config?.affectedTargets.length ?? 0) > 0
        ? evidence!.config!.affectedTargets.map((target): OperationReviewChange => ({
            kind: 'change', group: 'configImpact', title: `重新应用 ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.scope === 'user' ? '所有项目' : '当前项目'}`,
          }))
        : !intent.apply && (evidence?.config?.affectedTargets.length ?? 0) > 0
        ? evidence!.config!.affectedTargets.map((target): OperationReviewChange => ({
            kind: 'warning', group: 'configImpact', title: `保存后需同步 ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.scope === 'user' ? '所有项目' : '当前项目'}`,
          }))
        : [{ kind: 'keep' as const, group: 'configImpact' as const, title: '当前没有可见安装；只保存设置' }]),
      { kind: 'keep', group: 'preserved', title: '其他项目不会被自动扫描' },
    ];
  }
  const updateKeys = Object.keys(intent.updates ?? {});
  return [
    ...scriptTimeoutChanges(intent),
    ...preApplyScopeChanges(evidence?.config?.preApplyAuthorization ?? []),
    ...updateKeys.map((key): OperationReviewChange => ({
      kind: 'change',
      title: key,
      description: privateKeys.has(key) ? '已设置 → 将更新' : '将更新',
    })),
    ...(intent.removeKeys ?? []).map((key): OperationReviewChange => ({
      kind: 'remove',
      title: key,
      description: privateKeys.has(key) ? '已设置 → 未设置' : '恢复继承',
    })),
  ];
}

function batchGroupEvidence(
  evidence: PluginWriteBatchEvidence,
  group: PluginWriteBatchGroupEvidence,
): OperationEvidence {
  const manager = group.preview.codexManagerPreview;
  return {
    catalog: evidence.catalog,
    ...(group.preview.offlineCleanupPlans
      ? { offlineCleanupPlans: group.preview.offlineCleanupPlans }
      : {}),
    ...(group.preview.dependencyPlan ? { dependencyPlan: group.preview.dependencyPlan } : {}),
    ...(group.preview.codexReconcilePlans ? { codexReconcilePlans: group.preview.codexReconcilePlans } : {}),
    ...(group.preview.operationPlan ? { operationPlan: group.preview.operationPlan } : {}),
    ...(manager && manager.state !== 'blocked' ? {
      codexManager: {
        state: manager.state,
        packageName: '@openai/codex',
        version: manager.state === 'requires-install'
          ? MANAGED_CODEX_VERSION
          : manager.manager.version,
      },
    } : {}),
  };
}

function taskSourceEvidence(
  evidence: PluginWriteTaskEvidence,
  source: PluginWriteTaskSourceEvidence,
): OperationEvidence {
  return {
    catalog: evidence.catalog,
    ...(source.preview.dependencyPlan ? { dependencyPlan: source.preview.dependencyPlan } : {}),
    ...(source.preview.codexReconcilePlans
      ? { codexReconcilePlans: source.preview.codexReconcilePlans } : {}),
    ...(source.preview.operationPlan ? { operationPlan: source.preview.operationPlan } : {}),
  };
}

function taskReviewChanges(
  intent: Extract<OperationIntent, { kind: 'pluginWriteTask' }>,
  evidence: PluginWriteTaskEvidence,
): OperationReviewChange[] {
  const requested = evidence.taskPlan.executableTargets.map((target): OperationReviewChange => ({
    kind: 'change',
    group: 'requested',
    pluginId: target.pluginId,
    sourceId: target.pluginId.slice(0, target.pluginId.indexOf('/')),
    relation: 'requested',
    title: pluginNameFromId(target.pluginId),
    description: `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`
      + (target.expectedUpdate
        ? ` · ${target.expectedUpdate.installedVersion} → ${target.expectedUpdate.activeVersion}`
        : ' · 保持已安装版本'),
  }));
  const causes = evidence.taskPlan.causes.map((cause): OperationReviewChange => ({
    kind: 'change',
    group: 'dependencies',
    pluginId: cause.repairTarget.pluginId,
    sourceId: cause.sourceId,
    relation: cause.consumers.some((consumer) =>
      consumer.pluginId === cause.repairTarget.pluginId
      && consumer.platform === cause.repairTarget.platform
      && consumer.scope === cause.repairTarget.scope) ? 'requested' : 'direct',
    title: pluginNameFromId(cause.repairTarget.pluginId),
    description: `${cause.method === 'reinstall' ? '重新安装' : '同步'} · `
      + `${platformLabel(cause.repairTarget.platform)} · ${scopeLabel(cause.repairTarget.scope)}`
      + (cause.restoreVersionEvidence?.state === 'preserved'
        ? ` · 保持 ${cause.restoreVersionEvidence.installedVersion}`
        : cause.restoreVersionEvidence?.state === 'absent'
          ? ` · 补齐 ${cause.restoreVersionEvidence.activeVersion}` : '')
      + ` · 影响 ${cause.consumers.length} 个所选安装位置`,
  }));
  const runtime = evidence.taskPlan.sources.flatMap((source) =>
    preApplyScopeChanges(operationPreApplyTargets(taskSourceEvidence(evidence, source))));
  const blocked = evidence.taskPlan.blockedTargets.map((target): OperationReviewChange => ({
    kind: 'warning',
    group: 'portableWarnings',
    pluginId: target.target.pluginId,
    relation: 'requested',
    title: `${pluginNameFromId(target.target.pluginId)} 不在本次执行中`,
    description: `${platformLabel(target.target.platform)} · ${scopeLabel(target.target.scope)}`
      + (target.errorCodes?.length ? ` · ${target.errorCodes.join('、')}` : ''),
  }));
  return [
    ...scriptTimeoutChanges(intent),
    ...requested,
    ...causes,
    ...runtime,
    ...blocked,
    ...(evidence.taskPlan.blockedTargets.length > 0 ? [{
      kind: 'warning' as const,
      group: 'portableWarnings' as const,
      title: `${evidence.taskPlan.blockedTargets.length} 个目标不在本次执行中`,
      description: '用户已明确选择先处理可执行子集；阻止项保持不变。',
    }] : []),
    ...(evidence.taskPlan.executableTargets.some((target) => target.scope === 'user') ? [{
      kind: 'warning' as const,
      group: 'requested' as const,
      title: '包含所有项目安装位置',
      description: '这些写入可能影响当前项目之外的使用位置。',
    }] : []),
    { kind: 'keep', group: 'preserved', title: '插件设置保持不变' },
  ];
}

function batchReviewChanges(
  intent: Extract<OperationIntent, { kind: 'pluginWriteBatch' }>,
  evidence: PluginWriteBatchEvidence,
): OperationReviewChange[] {
  const changes = evidence.groups.flatMap((group): OperationReviewChange[] => {
    const representative = group.requestedPluginIds[0]!;
    const groupEvidence = batchGroupEvidence(evidence, group);
    const projected = reviewChanges({
      kind: 'pluginWrite',
      action: intent.action,
      pluginId: representative,
      platform: group.platform,
      scope: group.scope,
      ...(intent.scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs: intent.scriptTimeoutMs }),
    }, groupEvidence);
    const targetChanges = group.preview.targetResults.map((target): OperationReviewChange => {
      const pluginId = target.target.pluginId ?? `${group.sourceId}/${target.target.pluginName}`;
      const requested = group.requestedPluginIds.includes(pluginId);
      return {
        kind: intent.action === 'uninstall' || intent.action === 'cleanup' ? 'remove'
          : intent.action === 'install' ? 'add' : 'change',
        group: requested ? 'requested' : 'dependencies',
        pluginId,
        relation: requested ? 'requested'
          : (target.requiredBy ?? []).some((plugin) => group.requestedPluginIds.includes(plugin))
            ? 'direct' : 'transitive',
        title: pluginNameFromId(pluginId),
        description: `${group.sourceId} · ${target.target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.target.scope === 'user' ? '所有项目' : '当前项目'}${target.state === 'failed' || target.action === 'skipped' ? ` · 无法执行${target.errorCode ? ` (${target.errorCode})` : ''}` : ''}`,
      };
    });
    const effective = intent.action === 'cleanup' || group.preview.dependencyPlan
      ? projected
      : [
          ...targetChanges,
          ...projected.filter((change) => change.group !== 'requested'
            && change.group !== 'dependencies'),
        ];
    const withVersionEvidence = effective.map((change): OperationReviewChange => {
      if (change.group !== 'requested' || !change.pluginId) return change;
      const version = evidence.targetVersions?.find((target) =>
        target.pluginId === change.pluginId && target.platform === group.platform
        && target.scope === group.scope);
      if (!version) return change;
      const summary = version.presence === 'installed'
        ? version.installedVersion
          ? `已有安装 ${version.installedVersion}`
          : '已有安装，版本待确认'
        : version.presence === 'new'
          ? `新增${version.scope === 'user' ? '所有项目' : '当前项目'}安装`
          : '现场状态待确认';
      const available = version.availableVersion
        ? ` · 目录版本 ${version.availableVersion}` : '';
      return {
        ...change,
        description: `${change.description ? `${change.description} · ` : ''}${summary}${available}`,
      };
    });
    return [
      ...withVersionEvidence.filter((change) => change.title !== 'preApply 脚本超时')
        .map((change) => ({
          ...change,
          batchGroupId: group.groupId,
          sourceId: group.sourceId,
        })),
      ...(!group.executable ? [{
        kind: 'warning' as const,
        group: 'portableWarnings' as const,
        batchGroupId: group.groupId,
        sourceId: group.sourceId,
        title: `${group.sourceId} 组无法执行`,
        description: '确认后保留本次预览失败；不会重新求值或开始写入。',
      }] : []),
    ];
  });
  return [
    ...scriptTimeoutChanges(intent),
    ...changes,
    { kind: 'keep', group: 'preserved', title: '插件设置保持不变' },
  ];
}

function technicalDetails(evidence: OperationEvidence): string[] {
  const short = (value: string): string => {
    const normalized = value.startsWith('sha256:') ? value.slice(7) : value;
    return normalized.slice(0, 8);
  };
  const details = [
    `Catalog 配置：${short(evidence.catalog.configDigest)}`,
    `Catalog 组合：${short(evidence.catalog.compositeDigest)}`,
  ];
  if ('groups' in evidence && Array.isArray(evidence.groups)) {
    const batch = evidence as PluginWriteBatchEvidence;
    details.push(`批量根插件：${batch.requestedPluginIds.length} 个`);
    for (const group of batch.groups) {
      details.push(
        `批量分组：${group.sourceId} · ${group.platform} · ${group.requestedPluginIds.length} 个根插件 · ${group.executable ? `计划 ${short(group.preview.operationPlan!.planFingerprint)}` : '预览失败'}`,
      );
    }
  }
  if ('taskPlan' in evidence) {
    const task = evidence as PluginWriteTaskEvidence;
    details.push(`任务目标：${task.taskPlan.requestedTargets.length} 个`);
    details.push(`可执行目标：${task.taskPlan.executableTargets.length} 个`);
    details.push(`共同原因：${task.taskPlan.causes.length} 个`);
    for (const source of task.taskPlan.sources) {
      details.push(`任务来源：${source.sourceId} · ${source.requestedTargets.length} 个目标 · 计划 ${short(source.preview.operationPlan!.planFingerprint)}`);
    }
  }
  if (evidence.catalog.generationSetDigest) {
    details.push(`Catalog generation：${short(evidence.catalog.generationSetDigest)}`);
  }
  if (evidence.source) {
    details.push(`来源：${evidence.source.sourceId}`);
    if (evidence.source.sourceIdentity) details.push(`来源身份：${short(evidence.source.sourceIdentity)}`);
    if (evidence.source.resolvedCommit) details.push(`Snapshot commit：${short(evidence.source.resolvedCommit)}`);
    if (evidence.source.snapshotDigest) details.push(`Snapshot digest：${short(evidence.source.snapshotDigest)}`);
    if (evidence.source.contentDigest) details.push(`Content digest：${short(evidence.source.contentDigest)}`);
  }
  if (evidence.targetFingerprint) details.push(`目标状态：${short(evidence.targetFingerprint)}`);
  details.push(...(evidence.preparationWarnings ?? []).map((warning) => `刷新警告：${warning}`));
  for (const target of offlineCleanupPlans(evidence)) {
    details.push(`离线清理目标：${target.pluginId} · ${target.platform}/${target.scope}`);
    details.push(`离线清理计划：${target.plan.actions.length} 个动作 · ${short(target.planDigest)}`);
  }
  if (evidence.dependencyPlan) details.push(`安装计划：${evidence.dependencyPlan.resolvedPluginIds.length} 个插件`);
  if (evidence.config) details.push(`设置层：${evidence.config.scope} · ${short(evidence.config.storeDigest)}`);
  if (evidence.sourceWrite) {
    details.push(`新配置：${short(evidence.sourceWrite.proposedConfigDigest)}`);
    details.push(`引用清单：${short(evidence.sourceWrite.inventoryDigest)} · ${evidence.sourceWrite.referenceCount} 项`);
  }
  if (evidence.catalogGeneration) {
    const generation = evidence.catalogGeneration;
    details.push(`候选版本：${generation.candidate.catalogVersion}`);
    details.push(`候选 commit：${short(generation.candidate.resolvedCommit)}`);
    details.push(`候选 digest：${short(generation.candidate.snapshotDigest)}`);
  }
  if (evidence.portable) {
    details.push(`Portable 候选：${evidence.portable.selected.length} 个`);
    details.push(`Materialization：${short(evidence.portable.materializationDigest)}`);
    details.push(`Skills CLI：${evidence.portable.skillsCliVersion}`);
  }
  return details;
}

export interface OperationReviewProjection {
  title: string;
  description: string;
  changes: OperationReviewChange[];
  technicalDetails: string[];
  equivalentCommand?: string;
  primaryLabel: string;
  destructive?: true;
  requiresConfirmation: boolean;
  sharedImpact: {
    pluginIds: string[];
    warning?: string;
  };
}

export function buildOperationReviewProjection(options: {
  intent: OperationIntent;
  evidence: OperationEvidence;
  dependencyOverview?: PluginDependencyOverviewViewModel;
}): OperationReviewProjection {
  const { intent, evidence } = options;
  const batchEvidence = intent.kind === 'pluginWriteBatch'
    ? evidence as PluginWriteBatchEvidence
    : undefined;
  const taskEvidence = intent.kind === 'pluginWriteTask'
    ? evidence as PluginWriteTaskEvidence
    : undefined;
  const labels = operationLabels(intent, evidence);
  const hasPreApply = intent.kind === 'pluginWriteBatch'
    ? Boolean(batchEvidence?.groups.some((group) =>
        operationPreApplyTargets(batchGroupEvidence(batchEvidence, group)).length > 0))
    : intent.kind === 'pluginWriteTask'
      ? Boolean(taskEvidence?.taskPlan.sources.some((source) =>
          operationPreApplyTargets(taskSourceEvidence(taskEvidence, source)).length > 0))
    : operationPreApplyTargets(evidence).length > 0
      || (evidence.config?.preApplyAuthorization?.length ?? 0) > 0;
  const sharedNativeConfigApply = intent.kind === 'configSave'
    && intent.apply
    && (evidence.config?.sharedNativeRenderTargets?.length ?? 0) > 0
    && (evidence.config?.affectedTargets.some((target) => target.platform === 'codex') ?? false);
  const requiresConfirmation = sharedNativeConfigApply
    || Boolean(batchEvidence?.groups.some((group) =>
      (group.preview.codexReconcilePlans ?? []).some((plan) => plan.review.requiresConfirmation)))
    || Boolean(taskEvidence?.taskPlan.sources.some((source) =>
      (source.preview.codexReconcilePlans ?? []).some((plan) => plan.review.requiresConfirmation)))
    || (evidence.codexReconcilePlans ?? []).some((plan) => plan.review.requiresConfirmation)
    || Boolean(evidence.sourceWrite
      && (!evidence.sourceWrite.inventoryComplete || evidence.sourceWrite.referenceCount > 0))
    || Boolean(evidence.catalogGeneration?.impact
      && (!evidence.catalogGeneration.impact.inventoryComplete
        || evidence.catalogGeneration.impact.affectedReferences.length > 0))
    || Boolean(evidence.catalogGeneration?.primaryImpact
      && (!evidence.catalogGeneration.primaryImpact.inventoryComplete
        || evidence.catalogGeneration.primaryImpact.affectedReferences.length > 0));
  const warning = (evidence.codexReconcilePlans ?? []).find((plan) =>
    plan.review.sharedImpact.warning)?.review.sharedImpact.warning
    ?? batchEvidence?.groups.flatMap((group) => group.preview.codexReconcilePlans ?? [])
      .find((plan) => plan.review.sharedImpact.warning)?.review.sharedImpact.warning
    ?? taskEvidence?.taskPlan.sources.flatMap((source) => source.preview.codexReconcilePlans ?? [])
      .find((plan) => plan.review.sharedImpact.warning)?.review.sharedImpact.warning;
  const preparationWarnings = (evidence.preparationWarnings ?? []).map((): OperationReviewChange => ({
    kind: 'warning',
    group: 'portableWarnings',
    title: '来源刷新失败；本次使用旧 Active',
    description: '同步可以继续。再次刷新并同步时会重试来源刷新。',
  }));
  return {
    title: labels.title,
    description: labels.description,
    changes: [
      ...preparationWarnings,
      ...(intent.kind === 'pluginWriteBatch'
        ? batchReviewChanges(intent, batchEvidence!)
        : intent.kind === 'pluginWriteTask'
          ? taskReviewChanges(intent, taskEvidence!)
        : reviewChanges(intent, evidence, options.dependencyOverview)),
    ],
    technicalDetails: technicalDetails(evidence),
    ...(intent.kind === 'pluginWrite'
      ? { equivalentCommand: `aw ${intent.action === 'refreshAndSync' ? 'sync' : intent.action} ${intent.pluginId} --platform ${intent.platform} --scope ${intent.scope}${intent.action === 'refreshAndSync' ? ' --refresh' : ''}${scriptTimeoutChanges(intent).length > 0 ? ` --script-timeout ${parseScriptTimeoutMs(intent.scriptTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS)}` : ''}${(intent.dependencyScopeOverrides ?? []).map((override) => ` --dependency-scope ${override.pluginId}#${override.platform}=${override.scope}`).join('')}${intent.action === 'cleanup' && intent.force === true ? ' --force' : ''}${evidence.codexManager?.state === 'requires-install' ? ' --allow-managed-codex-install' : ''}${requiresConfirmation || hasPreApply ? ' --yes' : ''}` }
      : {}),
    primaryLabel: intent.kind === 'pluginWriteBatch'
      ? `${labels.primaryLabel} ${batchEvidence!.requestedPluginIds.length} 个插件`
      : intent.kind === 'pluginWriteTask'
        ? `${labels.primaryLabel} ${taskEvidence!.taskPlan.executableTargets.length} 个安装位置`
      : intent.kind === 'pluginWrite' && evidence.dependencyPlan
      ? `${labels.primaryLabel} ${evidence.dependencyPlan.resolvedPluginIds.length} 个插件`
      : labels.primaryLabel,
    ...(labels.destructive ? { destructive: true as const } : {}),
    requiresConfirmation,
    sharedImpact: {
      pluginIds: [...new Set([
        ...(evidence.codexReconcilePlans ?? []).flatMap((plan) =>
          plan.review.sharedImpact.pluginIds),
        ...(batchEvidence?.groups.flatMap((group) =>
          (group.preview.codexReconcilePlans ?? []).flatMap((plan) =>
            plan.review.sharedImpact.pluginIds)) ?? []),
        ...(taskEvidence?.taskPlan.sources.flatMap((source) =>
          (source.preview.codexReconcilePlans ?? []).flatMap((plan) =>
            plan.review.sharedImpact.pluginIds)) ?? []),
        ...(evidence.sourceWrite?.impact?.affectedReferences ?? []).flatMap((reference) =>
          reference.pluginId ? [reference.pluginId] : []),
        ...(evidence.catalogGeneration?.impact?.affectedReferences ?? []).flatMap((reference) =>
          reference.pluginId ? [reference.pluginId] : []),
        ...(evidence.catalogGeneration?.primaryImpact?.affectedReferences ?? []).flatMap((reference) =>
          reference.pluginId ? [reference.pluginId] : []),
        ...(sharedNativeConfigApply && 'pluginId' in intent ? [intent.pluginId] : []),
      ])],
      ...(warning ? { warning }
        : sharedNativeConfigApply
          ? { warning: '更新被共用的 Codex native 动态 Skill 会影响所有启用项目。' }
        : requiresConfirmation && (evidence.sourceWrite
          || evidence.catalogGeneration?.impact
          || evidence.catalogGeneration?.primaryImpact)
          ? { warning: '确认来源影响后才会继续。未知影响不会按零处理。' }
          : {}),
    },
  };
}
