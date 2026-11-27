import type { FrozenDeploymentPlan, DeploymentExclusion } from '../platforms/contracts.js';
import { hasSharedNativeRetirementEffect } from '../platforms/lifecycle.js';
import type { PublicDeploymentResult, PublicDeploymentObservation, PublicDeploymentExclusion } from '../commands/public-lifecycle-result.js';
import type { ComponentUnmet } from '@lesliechan721/aw-plugin-core/manifest';
import type { Diagnostic } from '../output/public-result.js';
import { SKILL_INVOCATION_NOTICE } from '../utils/skill-invocation-warning.js';
import { componentGapDescription, componentGapOutcome, GROK_ARGUMENT_BOUNDARIES_UNAVAILABLE, GROK_WRAPPER_TARGET_NOT_COVERED, HOST_PERMISSION_ADDITIONAL_IMPACT,
  isDeliveryNoticeCode, INVOCATION_POLICY_NOT_APPLIED,
  PI_AGENT_CONSUMER_NOTICE, safeComponentIdentity, safeSkippedPermissionActions, type ComponentDelivery } from '../output/component-delivery.js';
import { agentLabel, scopeLabel } from './glossary.js';

const stateLabels: Record<string, string> = { present: '存在', absent: '缺失', unknown: '未知', 'not-applicable': '不适用',
  enabled: '已启用', disabled: '已停用', blocked: '受阻',
  observed: '已观察到加载', 'not-observed': '尚未观察到加载', available: '可用', missing: '未安装', unsupported: '不支持', notApplicable: '无需客户端',
  applied: '已完成', unchanged: '未改变', failed: '失败', skipped: '已跳过', confirmed: '已确认变更', possible: '可能已变更', none: '无变更' };
const stateLabel = (state: string): string => stateLabels[state] ?? state;
const effectLabels: Record<string, string> = { 'publish-package': '发布包', register: '登记', refresh: '刷新', activate: '启用',
  deactivate: '停用', unregister: '撤销登记', 'write-supplement': '写入附加内容', 'remove-owned': '移除专属内容',
  'remove-marketplace-entry': '移除市场插件条目' };
const reloadLabels: Record<string, string> = { none: '无需重载', 'new-session': '需要新会话', 'workspace-reload': '需要重载工作区',
  'host-restart': '需要重启客户端', unknown: '重载条件未知' };

export function componentGapText(gap: ComponentUnmet): string {
  return componentGapDescription(gap, ': ');
}

const gapLabels = { skipped: '已跳过', limited: '部分生效', unmet: '未完成' };

export function componentDeliveryLines(delivery: ComponentDelivery): string[] {
  return [
    ...(delivery.installedComponentCount === undefined ? [] : [`  已安装 ${delivery.installedComponentCount} 项`]),
    ...(delivery.installedComponentIds?.length ? [`  已安装组件 ${delivery.installedComponentIds.map(safeComponentIdentity).join('、')}`] : []),
    ...(delivery.componentGaps ?? []).map((gap) => `  ! ${gap.providerPluginId} · ${agentLabel(gap.agent)} · ${scopeLabel(gap.renderScope)} · ${gapLabels[componentGapOutcome(gap, delivery.installedComponentIds)]} ${componentGapText(gap)}`),
  ];
}

export function deliveryNoticeText(code: string, detail?: Diagnostic['detail'], field?: string, message?: string): string {
  if (code === HOST_PERMISSION_ADDITIONAL_IMPACT) return message ? `权限的额外影响 · ${message}` : '此权限也可能影响其他命令。';
  if (code === INVOCATION_POLICY_NOT_APPLIED) {
    const actions = safeSkippedPermissionActions(detail?.skippedPermissionActions);
    const position = field ? ` ${safeComponentIdentity(field)}` : '';
    if (detail?.reasonCode === GROK_WRAPPER_TARGET_NOT_COVERED) {
      return `部分施加调用权限${position}中的动作（${actions.join(', ')}）。附加参数若指定了内部命令，Grok 会单独审核该命令。`;
    }
    const message = actions.length ? `已跳过调用权限${position}中的动作（${actions.join(', ')}）。` : `已跳过部分调用权限${position}。`;
    if (detail?.reasonCode === 'grok-project-trust-required') return `${message}在 Grok 中确认此项目的信任设置后重试。`;
    if (detail?.reasonCode === 'grok-shell-pattern-unrepresentable') return `${message}前缀包含 Grok 无法用于 Shell 规则的字符。`;
    if (detail?.reasonCode === 'grok-shell-prefix-normalized') return `${message}Grok 无法确定要放行的内部命令。`;
    return detail?.reasonCode === GROK_ARGUMENT_BOUNDARIES_UNAVAILABLE
      ? `${message}Grok Build 将命令参数拼成一段文本，无法区分参数内的空格和参数之间的空格。` : message;
  }
  if (code !== PI_AGENT_CONSUMER_NOTICE) return '旧输出仍保留，可能仍在生效。请先检查该位置再重试。';
  const reason = detail?.reasonCode;
  if (reason === 'piConfigurationUnconfirmed') return 'Pi 角色已安装。无法读取角色扩展设置，尚不能确定执行器是否可用。请检查设置并重载 Pi。';
  if (reason === 'piAgentConsumerDisabled') return 'Pi 角色已安装。请启用兼容的角色扩展并重载 Pi。';
  if (reason === 'piAgentPackageAccessDenied') return 'Pi 角色已安装。请检查角色扩展能否访问此包并重载 Pi。';
  if (reason === 'piAgentPackageSourceUnsupported') return 'Pi 角色已安装。检测到的 pi-subagents 版本无法读取此包来源。请启用兼容的扩展，例如 @tintinweb/pi-subagents，然后重载 Pi。';
  if (reason === 'piProjectTrustRequired') return 'Pi 角色已安装。请在 Pi 中检查此项目的信任设置。';
  const finding = reason === 'piAgentConsumerMissing' ? '未检测到兼容的角色扩展。' : '当前包尚无已确认可用的角色执行扩展。';
  return `Pi 角色已安装。${finding}可启用 pi-subagents 或 @tintinweb/pi-subagents，然后重载 Pi。`;
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

function configurationLines(after: PublicDeploymentResult['after']): string[] {
  const config = after.configuration;
  const scope = [
    ...(after.scopeRegistration ? [`  当前范围独立登记：${stateLabel(after.scopeRegistration)}`] : []),
    ...(after.scopeActivation ? [`  当前范围独立启用：${stateLabel(after.scopeActivation)}`] : []),
    ...(after.nativePackage ? [`  原生消费副本：${stateLabel(after.nativePackage)}`] : []),
    ...(after.workspaceOpen ? [`  当前范围 workspaceOpen：${stateLabel(after.workspaceOpen)}`] : []),
  ];
  if (!config) return scope;
  const activation = config.activation === 'absent' ? '无显式启用条目' : config.activation === 'unknown'
    ? '启用条目未知' : config.activation === 'enabled' ? '显式启用' : '显式停用';
  return [...scope, `  本地配置补充 · ${scopeLabel(config.scope)} · ${activation}（不代表原生有效状态）`,
    ...(config.reasonCodes.length ? [`    配置诊断：${config.reasonCodes.join(', ')}`] : [])];
}

/** Text is derived from frozen plans. It does not inspect or render again. */
export function sharedNativeRetirementImpact(plan: FrozenDeploymentPlan): string | undefined {
  if (!hasSharedNativeRetirementEffect(plan)) return undefined;
  const unregister = plan.effects.some((effect) => effect.kind === 'unregister'
    && (plan.binding.platform !== 'claude' || effect.nativeScope === 'user'));
  const removePackage = plan.effects.some((effect) => effect.kind === 'remove-owned'
    && effect.destination === plan.evidence.layout.packageRoot);
  const actions = [unregister ? '撤销共享原生登记' : undefined, removePackage ? '删除共享插件包' : undefined]
    .filter(Boolean).join('并') || '清理共享原生市场中的插件条目';
  return `将${actions}，${unregister || removePackage ? '其他项目的该插件将一并失效；' : ''}其他项目的需求声明保留，待进入对应项目时再处理。`;
}

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
      ...plan.expected.unmet.map((gap) => {
        const labels = { skipped: '将跳过', limited: '将部分交付', unmet: '缺少必要条件' };
        return `    ! ${labels[componentGapOutcome(gap, plan.expected.components.map(({ id }) => id))]} ${componentGapText(gap)}`;
      }),
      ...plan.expected.omitted.map((component) => `    ${component.id} · ${component.reason === 'config-disabled' ? '配置已关闭' : '本平台有意不提供'}`),
      ...plan.effects.flatMap((effect) => {
        const key = `${effect.physicalKey}\0${effect.id}`;
        if (seenEffects.has(key)) return [];
        seenEffects.add(key);
        const label = plan.evidence.confirmedCatalogRetirement && effect.kind === 'remove-owned'
          && effect.destination === plan.evidence.layout.packageRoot ? '删除共享插件包' : effectLabels[effect.kind] ?? effect.kind;
        return [`    ${effect.destructive ? '−' : '+'} ${label}${effect.componentIds.length ? ` · ${effect.componentIds.join(', ')}` : ''}${technical ? ` · ${effect.destination}` : ''}`];
      }),
      ...(plan.evidence.confirmedCatalogRetirement
        ? [sharedNativeRetirementImpact(plan)].flatMap((impact) => impact ? [`    ! ${impact}`] : [])
        : plan.evidence.sharedReferences !== 'none'
          ? [`    ! ${plan.evidence.sharedReferences === 'present' ? '有其他共享引用' : '共享引用尚未确认'}；保留其他使用位置。`] : []),
      ...(technical ? [`    物理位置 ${plan.evidence.layout.packageRoot}`, `    冻结依据 ${plan.evidence.fingerprint}`] : []),
    ]),
  ]);
}

export function deploymentResultLines(receipts: readonly PublicDeploymentResult[], technical = false, installedIds?: readonly string[]): string[] {
  const gapLine = (gap: ComponentUnmet): string => `! ${gapLabels[componentGapOutcome(gap, installedIds)]} ${componentGapText(gap)}`;
  return receipts.flatMap((receipt) => [
    ...receipt.products.flatMap((product) => {
      const observation = receipt.after.consumers.find((consumer) => consumer.productId === product.id);
      return [
        `  → ${product.product === 'app' ? 'App' : product.product === 'cli' ? 'CLI' : '通用输出'} · ${product.version ?? '版本未取得'} · ${stateLabel(product.availability)}`,
        `    启用 ${observation ? stateLabel(observation.activation) : '未知'} · ${observation ? stateLabel(observation.load) : '加载未知'}`,
        ...receipt.after.components.map((component) => `    组件 ${component.id} · 物理内容${stateLabel(component.presence)}`),
        ...receipt.unmet.filter((gap) => !gap.productIds.length || gap.productIds.includes(product.id)).map((gap) => `    ${gapLine(gap)}`),
        ...(technical && product.entry ? [`    安装入口 ${product.entry.kind === 'cli' ? product.entry.executable : product.entry.kind === 'directory' ? product.entry.configRoot : product.entry.root}`] : []),
      ];
    }),
    ...(receipt.products.length ? [] : ['  产品面未能关联；加载状态保持未知。', ...receipt.unmet.map((gap) => `  ${gapLine(gap)}`)]),
    ...receipt.effects.map((effect) => `  动作 ${effect.id} · ${stateLabel(effect.status)} · ${stateLabel(effect.mutation)}`),
    `  包${stateLabel(receipt.after.package)} · 登记${stateLabel(receipt.after.registration)} · ${reloadLabels[receipt.reload] ?? receipt.reload}`,
    ...nativeSourceLines(receipt.after),
    ...configurationLines(receipt.after),
    ...new Set([...receipt.diagnostics, ...receipt.effects.flatMap((effect) => effect.diagnostics
      .filter((entry) => entry.subject?.field === 'nativeSource'))]
      // The result shows advisories once per actual component or location.
      .filter(({ code }) => code !== SKILL_INVOCATION_NOTICE && !isDeliveryNoticeCode(code))
      .map((entry) => `  ! ${technical ? `${entry.code} · ` : ''}${entry.message}`)),
  ]);
}

export function deploymentObservationLines(observations: readonly PublicDeploymentObservation[], technical = false): string[] {
  return observations.flatMap((observation) => [
    ...observation.products.flatMap((product) => {
      const consumer = observation.after.consumers.find((item) => item.productId === product.id);
      return [`  → ${product.product === 'app' ? 'App' : product.product === 'cli' ? 'CLI' : '通用输出'} · ${product.version ?? '版本未取得'}`,
        `    启用 ${consumer ? stateLabel(consumer.activation) : '未知'} · ${consumer ? stateLabel(consumer.load) : '加载未知'}`,
        ...observation.after.components.map((component) => `    组件 ${component.id} · 物理内容${stateLabel(component.presence)}`),
        ...(technical ? [`    物理身份 ${observation.after.physicalKey}`] : [])];
    }),
    `  包${stateLabel(observation.after.package)} · 登记${stateLabel(observation.after.registration)}`,
    ...nativeSourceLines(observation.after),
    ...configurationLines(observation.after),
  ]);
}
