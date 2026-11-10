import type { PlatformName, Scope } from '../types.js';
import type { StatusSharedNativeProjection } from '../commands/status-v6.js';
import { TARGET_DISPLAY_NAMES } from '../platforms/discovery.js';
import { isPlatformTarget } from '@lesliechan721/aw-plugin-core';

export const productTerms = {
  catalog: '插件目录',
  active: '当前启用版本',
  candidate: '待检查版本',
  desired: '已保存使用设置',
  desiredPlacement: '计划使用位置',
  actualPlacement: '当前使用位置',
  sharedNative: '由平台共用的内容',
  activation: '启用位置',
  awOnly: 'AW 管理附加能力',
  awOwned: 'AW 管理内容',
  fixedPoint: '根据依赖自动扩大范围',
  provider: '来源或依赖插件',
  rootProvider: '当前插件',
  capability: '功能支持',
  manifest: '插件定义',
  generation: '目录版本副本',
} as const;

export function platformLabel(platform: PlatformName): string {
  return TARGET_DISPLAY_NAMES[platform];
}

export function agentLabel(agent: string): string {
  return isPlatformTarget(agent) ? TARGET_DISPLAY_NAMES[agent] : agent;
}

export function scopeLabel(scope: Scope): string {
  return scope === 'user' ? '所有项目' : '当前项目';
}

export function sharedNativeStateLabel(
  sharedNative: StatusSharedNativeProjection,
): string {
  if (sharedNative.state === 'usable') return '可用';
  if (sharedNative.state === 'missing') return '缺失';
  if (sharedNative.state === 'unobserved') return '未检查';
  if (sharedNative.state === 'blocked') return '冲突';
  return ({
    renderDrift: '待同步',
    damaged: '损坏',
    outdated: '待更新',
    foreign: '由其他内容占用',
    unreadable: '无法读取',
  } as const)[sharedNative.reason ?? 'unreadable'];
}

export function recoveryReason(code: string): string {
  const labels: Record<string, string> = {
    targetPlacementConflict: 'Agent 目录冲突', agentDirectoryConflict: 'Agent 目录冲突',
    permissionDenied: '没有写入权限', preApplyFailed: '安装检查未通过',
    preApplyAuthorizationRequired: '需要确认安装检查', nativeToolAuthorizationRequired: '需要确认原生工具变更',
    dependencyApplyFailed: '所需插件未完成更新', dependencyExcluded: '所需插件已关闭此 Agent',
    providerSwitchCleanupFailed: '旧安装位置尚未清理', sourceUnavailable: '插件来源不可用',
    targetsNotConfigured: '请先选择 Agent', localTargetsRequired: '请先选择 Agent',
    pluginUnavailable: '来源中已没有此插件', dependencyMissing: '所需插件尚未安装',
    deliveryUnsupported: '此 Agent 或位置不受支持', sourceIdentityMismatch: '插件来源身份已变化',
    evidenceUnavailable: '暂时无法核实现场，请重新检查', operationReviewStale: '状态已变化，请重新准备',
    configInvalid: '插件设置需要修正', invalidConfig: '插件设置需要修正',
  };
  return labels[code] ?? '当前无法完成，请查看详情';
}
