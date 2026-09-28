import type { Scope } from '../types.js';

export interface StrongStateDiagnostic { code: string; message: string }

export function describeStrongStateProblem(options: {
  kind: 'intent' | 'preferences';
  scope: Scope;
  state: 'unsupported-version' | 'invalid' | 'unreadable';
  filePath: string;
}): StrongStateDiagnostic {
  const { kind, scope, state, filePath } = options;
  const code = kind === 'intent' ? 'pluginIntentStateInvalid' : 'deploymentPreferencesInvalid';
  const status = state === 'unsupported-version' ? '版本不受支持'
    : state === 'invalid' ? '格式无效' : '无法读取';
  const action = kind === 'intent'
    ? `修复路径或移走旧文件，再用 aw intent add <source/plugin> --scope ${scope} 逐项重建。`
    : `修复路径，再用 aw targets reset --scope ${scope} 显式重建部署偏好。`;
  return {
    code,
    message: `${scope} ${kind === 'intent' ? '插件声明' : '部署偏好'}${status}：${filePath}。先备份此文件的原始内容，再${action}`,
  };
}
