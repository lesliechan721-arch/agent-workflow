import type { PlatformName, Scope } from '../types.js';
import type { StatusSharedNativeProjection } from '../commands/status-v6.js';

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
  return platform === 'codex' ? 'Codex' : 'Claude Code';
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
