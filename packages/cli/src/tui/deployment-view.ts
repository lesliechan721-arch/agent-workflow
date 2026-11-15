import type { FrozenDeploymentPlan, DeploymentExclusion } from '../platforms/contracts.js';
import type { PublicDeploymentResult, PublicDeploymentObservation, PublicDeploymentExclusion, PublicComponentGap } from '../commands/public-lifecycle-result.js';
import type { ComponentUnmet } from '@lesliechan721/aw-plugin-core/manifest';
import { agentLabel, scopeLabel } from './glossary.js';

const stateLabels: Record<string, string> = { present: '存在', absent: '缺失', unknown: '未知', 'not-applicable': '不适用',
  enabled: '已启用', disabled: '未启用', blocked: '受阻', trusted: '已信任', required: '需要信任',
  observed: '已观察到加载', 'not-observed': '尚未观察到加载', available: '可用', missing: '未安装', unsupported: '不支持', notApplicable: '无需客户端',
  applied: '已完成', unchanged: '未改变', failed: '失败', skipped: '已跳过', confirmed: '已确认变更', possible: '可能已变更', none: '无变更' };
const stateLabel = (state: string): string => stateLabels[state] ?? state;
const effectLabels: Record<string, string> = { 'publish-package': '发布包', register: '登记', refresh: '刷新', activate: '启用',
  deactivate: '停用', unregister: '撤销登记', 'write-supplement': '写入附加内容', 'remove-owned': '移除专属内容' };
const reloadLabels: Record<string, string> = { none: '无需重载', 'new-session': '需要新会话', 'workspace-reload': '需要重载工作区',
  'host-restart': '需要重启客户端', unknown: '重载条件未知' };

export function componentGapText(gap: ComponentUnmet): string {
  return `${gap.componentId ?? gap.id} · ${gap.kind} · ${gap.reasonCode}${gap.requiredFeatures.length
    ? ` · ${gap.requiredFeatures.map((requirement) => `${requirement.feature}${requirement.values ? `: ${requirement.values.join(', ')}` : ''}`).join('；')}` : ''}`;
}

export function componentGapLines(gaps: readonly PublicComponentGap[]): string[] {
  return gaps.map((gap) => `  ! ${gap.providerPluginId} · ${scopeLabel(gap.renderScope)} · 缺失 ${componentGapText(gap)}`);
}

export function deploymentExclusionLines(exclusions: readonly (DeploymentExclusion | PublicDeploymentExclusion)[]): string[] {
  return exclusions.flatMap((entry) => [
    `  → ${agentLabel(entry.platform)} ${entry.product?.product === 'app' ? 'App' : entry.product?.product === 'cli' ? 'CLI' : '产品面'} · ${entry.product?.version ?? '版本未取得'} · 未执行 · ${entry.reasonCode}`,
    ...entry.recoveryActions.map((action) => `    恢复：${action}`),
  ]);
}

function nativeSourceLines(after: PublicDeploymentResult['after']): string[] {
  const evidence = after.prerequisites?.nativeSources;
  return evidence ? [
    `  原生来源观测：${evidence.observation === 'complete' ? '完整' : '未知'}`,
    ...evidence.sources.map((source) => `    ${source.name} · ${source.version ?? '版本未知'} · ${source.scope} · ${source.origin} · ${source.enabled === null ? '启用未知' : source.enabled ? '已启用' : '未启用'} · ${source.effectiveComponents.join(', ') || '无生效组件'}`),
    ...(evidence.overlaps.length ? [`    同名来源：${evidence.overlaps.join(', ')}`] : []),
  ] : [];
}

/** Text is derived from frozen plans. It does not inspect or render again. */
export function deploymentPlanLines(plans: readonly FrozenDeploymentPlan[], technical = false): string[] {
  const groups = new Map<string, FrozenDeploymentPlan[]>();
  const seenEffects = new Set<string>();
  for (const plan of plans) groups.set(plan.binding.platform, [...(groups.get(plan.binding.platform) ?? []), plan]);
  return [...groups].flatMap(([platform, entries]) => [
    `${agentLabel(platform)} · 原生部署`,
    ...entries.flatMap((plan) => [
      `  ${plan.binding.plugin.pluginId} · ${scopeLabel(plan.binding.scope.kind)}`,
      ...plan.binding.consumers.map((product) => `  → ${product.product === 'app' ? 'App' : product.product === 'cli' ? 'CLI' : '通用输出'} · ${product.version ?? '版本未取得'} · ${stateLabel(product.availability)}`),
      ...(plan.binding.consumers.length > 1 ? ['  CLI / App 共用此物理包；物理动作只执行一次。'] : []),
      ...plan.expected.components.map((component) => `    组件 ${component.id} · ${component.kind}`),
      ...plan.expected.unmet.map((gap) => `    ! 缺失 ${componentGapText(gap)}`),
      ...plan.expected.omitted.map((component) => `    ${component.id} · ${component.reason === 'config-disabled' ? '配置已关闭' : '本平台有意不提供'}`),
      ...plan.effects.flatMap((effect) => {
        const key = `${effect.physicalKey}\0${effect.id}`;
        if (seenEffects.has(key)) return [];
        seenEffects.add(key);
        return [`    ${effect.destructive ? '−' : '+'} ${effectLabels[effect.kind] ?? effect.kind}${effect.componentIds.length ? ` · ${effect.componentIds.join(', ')}` : ''}${technical ? ` · ${effect.destination}` : ''}`];
      }),
      ...(plan.evidence.sharedReferences !== 'none' ? [`    ! ${plan.evidence.sharedReferences === 'present' ? '有其他共享引用' : '共享引用尚未确认'}；保留其他使用位置。`] : []),
      ...(technical ? [`    物理位置 ${plan.evidence.layout.packageRoot}`, `    冻结依据 ${plan.evidence.fingerprint}`] : []),
    ]),
  ]);
}

export function deploymentResultLines(receipts: readonly PublicDeploymentResult[], technical = false): string[] {
  return receipts.flatMap((receipt) => [
    ...receipt.products.flatMap((product) => {
      const observation = receipt.after.consumers.find((consumer) => consumer.productId === product.id);
      return [
        `  → ${product.product === 'app' ? 'App' : product.product === 'cli' ? 'CLI' : '通用输出'} · ${product.version ?? '版本未取得'} · ${stateLabel(product.availability)}`,
        `    启用 ${observation ? stateLabel(observation.activation) : '未知'} · ${observation ? stateLabel(observation.load) : '加载未知'} · 信任 ${observation ? stateLabel(observation.trust) : '未知'}`,
        ...receipt.after.components.map((component) => `    组件 ${component.id} · 物理内容${stateLabel(component.presence)}`),
        ...receipt.unmet.filter((gap) => !gap.productIds.length || gap.productIds.includes(product.id)).map((gap) => `    ! 缺失 ${componentGapText(gap)}`),
        ...(technical && product.entry ? [`    安装入口 ${product.entry.kind === 'cli' ? product.entry.executable : product.entry.kind === 'directory' ? product.entry.configRoot : product.entry.root}`] : []),
      ];
    }),
    ...(receipt.products.length ? [] : ['  产品面未能关联；加载状态保持未知。', ...receipt.unmet.map((gap) => `  ! 缺失 ${componentGapText(gap)}`)]),
    ...receipt.effects.map((effect) => `  动作 ${effect.id} · ${stateLabel(effect.status)} · ${stateLabel(effect.mutation)}`),
    `  包${stateLabel(receipt.after.package)} · 登记${stateLabel(receipt.after.registration)} · ${reloadLabels[receipt.reload] ?? receipt.reload}`,
    ...nativeSourceLines(receipt.after),
    ...receipt.diagnostics.map((entry) => `  ! ${technical ? `${entry.code} · ` : ''}${entry.message}`),
  ]);
}

export function deploymentObservationLines(observations: readonly PublicDeploymentObservation[], technical = false): string[] {
  return observations.flatMap((observation) => [
    ...observation.products.flatMap((product) => {
      const consumer = observation.after.consumers.find((item) => item.productId === product.id);
      return [`  → ${product.product === 'app' ? 'App' : product.product === 'cli' ? 'CLI' : '通用输出'} · ${product.version ?? '版本未取得'}`,
        `    启用 ${consumer ? stateLabel(consumer.activation) : '未知'} · ${consumer ? stateLabel(consumer.load) : '加载未知'} · 信任 ${consumer ? stateLabel(consumer.trust) : '未知'}`,
        ...observation.after.components.map((component) => `    组件 ${component.id} · 物理内容${stateLabel(component.presence)}`),
        ...(technical ? [`    物理身份 ${observation.after.physicalKey}`] : [])];
    }),
    `  包${stateLabel(observation.after.package)} · 登记${stateLabel(observation.after.registration)}`,
    ...nativeSourceLines(observation.after),
  ]);
}
