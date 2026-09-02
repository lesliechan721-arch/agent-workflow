import { requestedIntentAction } from '../output/command-receipt.js';
import type { PlatformName } from '../types.js';
import type {
  OperationEvidence,
  OperationIntent,
  OperationReviewChange,
  PluginWriteOperation,
} from './controller.js';
import type { PluginDependencyOverviewViewModel } from './model.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import type { OfflineCleanupTargetEvidence } from '../commands/offline-cleanup-evidence.js';

function plannerError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`);
}

function pluginNameFromId(pluginId: string): string {
  const separator = pluginId.indexOf('/');
  return separator < 0 ? pluginId : pluginId.slice(separator + 1);
}

function operationLabels(intent: OperationIntent): {
  title: string;
  description: string;
  primaryLabel: string;
  destructive: boolean;
} {
  if (intent.kind === 'portableInstall') {
    return {
      title: '确认安装通用 Skills',
      description: '只安装已选择的 Skills；不会修改原生插件安装。',
      primaryLabel: `开始安装 ${intent.selectedSkills.length} 个 Skills`,
      destructive: false,
    };
  }
  if (intent.kind === 'pluginWrite' && intent.dependencyPlacementAdjustment) {
    return {
      title: '调整依赖位置',
      description: '按最终依赖位置更新 desired intent，并应用非破坏性变更。',
      primaryLabel: '应用依赖位置',
      destructive: false,
    };
  }
  if (intent.kind === 'pluginWrite') {
    if (intent.originIssue) {
      if (intent.action === 'cleanup') {
        return {
          title: '清理已安装内容',
          description: '只清理可证明属于 AW 的现场内容；保留插件设置。',
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
        description: '跳过依赖保护并清理可证明属于 AW 的现场内容。依赖者会变为不完整。配置保持不变。',
        primaryLabel: '确认强制清理',
        destructive: true,
      };
    }
    const labels: Record<PluginWriteOperation, [string, string, boolean]> = {
      install: ['添加插件', '添加所选平台和使用位置。', false],
      refreshAndSync: ['刷新并同步', '刷新相关来源后，使用新的 Active 内容同步所选安装。', false],
      reinstall: ['重新安装插件', '清理 AW 管理的内容后完整重建。', true],
      uninstall: ['移除插件', '移除 AW 管理的安装内容。配置保持不变。', true],
      cleanup: ['清理插件', '只移除可证明属于 AW 的现场内容。配置保持不变。', true],
      sync: ['同步插件', '按已保存的 desired intent 修复当前现场。', false],
    };
    const [title, description, destructive] = labels[intent.action];
    return { title, description, primaryLabel: title, destructive };
  }
  if (intent.kind === 'configSave') {
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
    const labels = {
      add: ['添加来源', '只保存来源配置。保存后请在终端运行 source sync。', '保存来源', false],
      update: ['修改来源', '只保存来源配置。保存后请在终端运行 source sync。', '保存来源', false],
      setPrimary: ['设为主来源', '只改变默认 marketplace，不迁移安装。', '设为主来源', false],
      remove: ['移除来源', '移除来源配置；不会删除其它来源。', '移除来源', true],
    } as const;
    const [title, description, primaryLabel, destructive] = labels[intent.action];
    return { title, description, primaryLabel, destructive };
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
  if (intent.kind === 'portableInstall') {
    const review = evidence?.portable;
    if (!review) throw plannerError('portablePrepareFailed', '缺少通用 Skills Review 证据。');
    return [
      ...review.selected.map((skill): OperationReviewChange => ({
        kind: 'add',
        group: skill.relation === 'requested' ? 'requested' : 'dependencies',
        pluginId: skill.providerPluginId,
        relation: skill.relation,
        title: skill.name,
        description: `${skill.description} · ${skill.providerDisplayName}${skill.dynamic ? ' · 按设置生成' : ''}`,
      })),
      { kind: 'change', group: 'portableTarget', title: 'Agent', description: review.agentMode === 'automatic'
        ? '自动选择检测到的 Agent；未检测到时可能选择全部 Agent'
        : review.requestedAgents.join('、') },
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
    const runtimeChanges: OperationReviewChange[] = evidence?.codexManager
      ? [{
          kind: evidence.codexManager.state === 'requires-install' ? 'add' : 'keep',
          group: 'runtime',
          title: evidence.codexManager.state === 'requires-install'
            ? '获取 Codex runtime'
            : 'Codex runtime',
          description: evidence.codexManager.state === 'requires-install'
            ? `${evidence.codexManager.packageName}@${evidence.codexManager.version} · AW-managed 缓存`
            : evidence.codexManager.state === 'cached'
              ? `${evidence.codexManager.packageName}@${evidence.codexManager.version} · 复用 AW-managed 缓存`
              : `使用兼容的 system Codex ${evidence.codexManager.version}`,
        }]
      : [];
    const codexChanges = (evidence?.codexReconcilePlans ?? []).flatMap((codexPlan) => [
      ...codexPlan.sharedNativeActions.map((action): OperationReviewChange => ({
        kind: action.action === 'reuse' || action.action === 'none' ? 'keep'
          : action.action === 'install' ? 'add' : 'change',
        group: 'sharedCodexNative',
        pluginId: action.pluginId,
        title: action.codexPluginId,
        description: action.action === 'reuse'
          ? '复用已存在的精确 shared native；不建立 ownership ledger'
          : `${action.action} · shared${action.affectsOtherScopes ? ' · 可能影响其他项目' : ''}`,
      })),
      ...codexPlan.activationActions.user.map((action): OperationReviewChange => ({
        kind: action.action === 'none' ? 'keep' : action.desired ? 'change' : 'remove',
        group: 'userActivation',
        pluginId: action.pluginId,
        title: action.codexPluginId,
        description: `desired=${String(action.desired)} · ${action.action}`,
      })),
      ...codexPlan.activationActions.project.map((action): OperationReviewChange => ({
        kind: action.action === 'none' ? 'keep' : action.desired ? 'change' : 'remove',
        group: 'projectActivation',
        pluginId: action.pluginId,
        title: action.codexPluginId,
        description: `desired=${String(action.desired)} · ${action.action}`,
      })),
      ...[...codexPlan.extensionWrites, ...codexPlan.extensionRemovals]
        .map((action): OperationReviewChange => ({
          kind: action.action === 'write' ? 'change' : 'remove',
          group: 'awExtensions',
          pluginId: action.pluginId,
          title: action.componentKey,
          description: `${action.scope} · ${action.action}`,
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
          description: `${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.resolvedScope === 'user' ? '所有项目' : '当前项目'}${target.action === 'keep' ? ' · 已可用' : ''}${target.assignmentSource === 'existingWiderTarget' ? ' · 复用健康的所有项目安装' : target.assignmentSource === 'consumerPromotion' ? ' · 随上游依赖一并调整' : ''}`,
        };
      });
      changes.push({
        kind: 'keep',
        group: 'preserved',
        title: intent.dependencyPlacementAdjustment
          ? '根插件和插件设置保持不变'
          : '插件设置和已有依赖保持不变',
        description: intent.dependencyPlacementAdjustment
          ? '这里只调整所列 dependency placement。'
          : '移除根插件时不会自动清理依赖。',
      });
      return [...changes, ...codexChanges, ...runtimeChanges];
    }
    const platforms: PlatformName[] = intent.platform === 'both'
      ? ['codex', 'claude']
      : [intent.platform];
    const changes = platforms.map((platform): OperationReviewChange => ({
      kind: intent.action === 'uninstall' || intent.action === 'cleanup' ? 'remove' : intent.action === 'install' ? 'add' : 'change',
      group: 'requested',
      pluginId: intent.pluginId,
      relation: 'requested',
      title: `${platform === 'codex' ? 'Codex' : 'Claude Code'} · ${intent.scope === 'user' ? '所有项目' : '当前项目'}`,
      description: intent.action === 'uninstall' || intent.action === 'cleanup'
        ? '插件设置不会删除。'
        : '执行前会再次检查当前安装状态。',
    }));
    if (intent.action === 'cleanup' && evidence?.offlineCleanup) {
      const actionLabels: Record<OfflineCleanupTargetEvidence['plan']['actions'][number]['action'], string> = {
        removeOwnedOutput: '移除 AW-owned 输出',
        removeNativeRegistration: '移除原生插件注册',
      };
      changes.push(...evidence.offlineCleanup.plan.actions.map((action): OperationReviewChange => ({
        kind: 'remove',
        group: 'requested',
        pluginId: evidence.offlineCleanup!.pluginId,
        relation: 'requested',
        title: actionLabels[action.action],
        description: action.target,
      })));
    }
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
        title: `后续：${intent.scope === 'user' ? '当前项目' : '所有项目'} sync`,
        description: intent.recoveryDescription,
      });
    }
    return [...changes, ...codexChanges, ...runtimeChanges];
  }
  if (intent.kind === 'configReset') {
    const layerLabel = intent.scope === 'user'
      ? '个人默认'
      : intent.projectLayer === 'local' ? '当前项目（仅本机）' : '当前项目';
    return [
      ...(intent.changes?.map((change): OperationReviewChange => ({
        kind: 'remove', group: 'configChanges', title: `${layerLabel} · ${change.title}`,
        description: `${change.before} → ${change.after}`,
      })) ?? [{ kind: 'remove' as const, group: 'configChanges' as const, title: `删除${layerLabel}中的已存值`, description: '有效值将恢复为继承值或默认值。' }]),
      { kind: 'keep', group: 'configImpact', title: '只保存设置；当前安装保持不变' },
      { kind: 'keep', group: 'preserved', title: intent.scope === 'user' ? '当前项目和本机设置层保持不变' : '其他设置层保持不变' },
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
    return changes;
  }
  if (intent.kind !== 'configSave') {
    throw plannerError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
  }
  const privateKeys = new Set([...(intent.sensitiveKeys ?? []), ...(intent.privateKeys ?? [])]);
  const removeKeys = new Set(intent.removeKeys ?? []);
  if (intent.changes) {
    return [
      ...intent.changes.map((change): OperationReviewChange => ({
        kind: removeKeys.has(change.key) ? 'remove' : 'change',
        group: 'configChanges',
        title: removeKeys.has(change.key) ? `删除 ${change.title} 中的值` : change.title,
        description: removeKeys.has(change.key)
          ? privateKeys.has(change.key) ? `已设置 → ${change.after}` : `${change.before} → ${change.after}`
          : privateKeys.has(change.key) ? '已设置 → 将更新'
          : `${change.before} → ${change.after}`,
      })),
      ...(intent.apply && (evidence?.config?.affectedTargets.length ?? 0) > 0
        ? evidence!.config!.affectedTargets.map((target): OperationReviewChange => ({
            kind: 'change', group: 'configImpact', title: `重新应用 ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.scope === 'user' ? '所有项目' : '当前项目'}`,
          }))
        : [{ kind: 'keep' as const, group: 'configImpact' as const, title: '当前没有可见安装；只保存设置' }]),
      { kind: 'keep', group: 'preserved', title: '其他项目不会被自动扫描' },
    ];
  }
  const updateKeys = Object.keys(intent.updates ?? {});
  return [
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

function technicalDetails(evidence: OperationEvidence): string[] {
  const short = (value: string): string => {
    const normalized = value.startsWith('sha256:') ? value.slice(7) : value;
    return normalized.slice(0, 8);
  };
  const details = [
    `Catalog 配置：${short(evidence.catalog.configDigest)}`,
    `Catalog 组合：${short(evidence.catalog.compositeDigest)}`,
  ];
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
  if (evidence.offlineCleanup) {
    details.push(`离线清理原因：${evidence.offlineCleanup.reason}`);
    details.push(`离线清理目标：${short(evidence.offlineCleanup.targetFingerprint)}`);
    details.push(`离线清理计划：${evidence.offlineCleanup.plan.actions.length} 个动作 · ${short(evidence.offlineCleanup.planDigest)}`);
    for (const action of evidence.offlineCleanup.plan.actions) {
      details.push(`离线清理动作：${action.action} · ${action.target}`);
    }
  }
  if (evidence.dependencyPlan) details.push(`安装计划：${evidence.dependencyPlan.resolvedPluginIds.length} 个插件`);
  if (evidence.config) details.push(`设置层：${evidence.config.scope}/${evidence.config.projectLayer} · ${short(evidence.config.storeDigest)}`);
  if (evidence.sourceWrite) {
    details.push(`新配置：${short(evidence.sourceWrite.proposedConfigDigest)}`);
    details.push(`引用清单：${short(evidence.sourceWrite.inventoryDigest)} · ${evidence.sourceWrite.referenceCount} 项`);
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
  const labels = operationLabels(intent);
  const requiresConfirmation = (evidence.codexReconcilePlans ?? []).some((plan) =>
    plan.review.requiresConfirmation);
  const warning = (evidence.codexReconcilePlans ?? []).find((plan) =>
    plan.review.sharedImpact.warning)?.review.sharedImpact.warning;
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
      ...reviewChanges(intent, evidence, options.dependencyOverview),
    ],
    technicalDetails: technicalDetails(evidence),
    ...(intent.kind === 'pluginWrite'
      ? { equivalentCommand: `aw ${intent.action === 'refreshAndSync' ? 'sync' : intent.action} ${intent.pluginId} --platform ${intent.platform} --scope ${intent.scope}${intent.action === 'refreshAndSync' ? ' --refresh' : ''}${(intent.dependencyScopeOverrides ?? []).map((override) => ` --dependency-scope ${override.pluginId}#${override.platform}=${override.scope}`).join('')}${intent.action === 'cleanup' && intent.force === true ? ' --force' : ''}${evidence.codexManager?.state === 'requires-install' ? ' --allow-managed-codex-install' : ''}${requiresConfirmation ? ' --yes' : ''}` }
      : {}),
    primaryLabel: intent.kind === 'pluginWrite' && evidence.dependencyPlan
      ? `${labels.primaryLabel} ${evidence.dependencyPlan.resolvedPluginIds.length} 个插件`
      : labels.primaryLabel,
    ...(labels.destructive ? { destructive: true as const } : {}),
    requiresConfirmation,
    sharedImpact: {
      pluginIds: [...new Set((evidence.codexReconcilePlans ?? []).flatMap((plan) =>
        plan.review.sharedImpact.pluginIds))],
      ...(warning ? { warning } : {}),
    },
  };
}
