import type { CatalogSourceFreshnessViewModel } from './types.js';

export interface CatalogSourceListPresentation {
  label: string;
  status?: 'success' | 'warning' | 'error';
}

export function catalogSourceListPresentation(options: {
  freshness?: CatalogSourceFreshnessViewModel;
  activeVersion?: string;
  health: 'ready' | 'unavailable' | 'checking' | 'update' | 'recovery' | 'error';
  primary: boolean;
}): CatalogSourceListPresentation {
  const state = options.freshness?.state;
  const activeAvailable = options.activeVersion !== undefined && options.health === 'ready';
  const label = options.health === 'unavailable'
    ? options.activeVersion
      ? state === 'checkFailed' ? '检查失败 · 当前版本不可用' : '当前版本不可用'
      : '无法读取'
    : state === 'checking' ? '检查中'
    : state === 'updateAvailable'
      ? `可更新到 ${options.freshness?.candidate?.catalogVersion ?? '新版本'}`
      : state === 'localChangesAvailable' ? '本地内容有变化'
        : state === 'versionConflict' ? '版本冲突'
          : state === 'rollbackDetected' ? '检测到回退'
            : state === 'checkFailed' ? activeAvailable
              ? '检查失败 · 当前版本可用' : '检查失败 · 当前版本不可用'
              : state === 'incompatible' ? '候选不兼容'
                : options.activeVersion ? `当前版本 ${options.activeVersion}`
                  : options.health === 'ready' ? '当前使用' : '无法读取';
  const status = !options.activeVersion || options.health === 'unavailable' || state === 'incompatible'
    || (state === 'checkFailed' && !activeAvailable)
    ? 'error' as const
    : state === 'checkFailed' ? 'warning' as const
      : state === 'updateAvailable' || state === 'localChangesAvailable'
        || state === 'versionConflict' || state === 'rollbackDetected'
        ? 'warning' as const
        : options.primary ? 'success' as const : undefined;
  return { label, ...(status ? { status } : {}) };
}

export function catalogSourceFreshnessLabel(
  freshness?: CatalogSourceFreshnessViewModel,
): string {
  return freshness?.state === 'checking' ? '检查中'
    : freshness?.state === 'current' ? '当前已是最新'
      : freshness?.state === 'fixed' ? '固定提交'
        : freshness?.state === 'checkFailed' ? '检查失败 · 当前版本仍可用'
          : freshness?.state === 'localChangesAvailable' ? '本地内容有变化'
            : freshness?.state === 'updateAvailable' ? '有可用更新'
              : freshness?.state === 'versionConflict' ? '同版本内容冲突'
                : freshness?.state === 'rollbackDetected' ? '检测到版本回退'
                  : freshness?.state === 'incompatible' ? '候选不兼容' : '尚未检查';
}
