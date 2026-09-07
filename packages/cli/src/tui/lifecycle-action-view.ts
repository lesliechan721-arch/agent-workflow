import type { AllowedLifecycleAction } from '../commands/operation-planner.js';

export interface LifecycleActionViewModel {
  label: string;
  description: string;
}

export function projectLifecycleActionView(
  action: AllowedLifecycleAction,
): LifecycleActionViewModel {
  if (action.id === 'install') return {
    label: '添加插件',
    description: '添加所选平台和使用位置。',
  };
  if (action.id === 'sync') return {
    label: '同步已保存使用设置',
    description: '按已保存使用设置修复当前使用位置。',
  };
  if (action.id === 'refreshAndSync') return {
    label: action.availableVersion ? `更新到 ${action.availableVersion}` : '刷新并同步',
    description: action.availableVersion
      ? `使用当前启用目录中已确认的 ${action.availableVersion} 同步。`
      : '刷新相关来源后，使用新的当前启用版本同步。',
  };
  if (action.id === 'reinstall') return {
    label: '重新安装',
    description: '保留设置并重新生成 AW 管理内容。',
  };
  if (action.id === 'cleanup') return {
    label: '清理 AW 管理内容',
    description: action.reason === 'orphanedManagedContent'
      ? '只清理这个插件目标的 AW 管理内容。'
      : '只清理可证明属于 AW 的内容。',
  };
  return {
    label: '移除插件',
    description: '移除 AW 管理的安装内容并保留设置。',
  };
}
