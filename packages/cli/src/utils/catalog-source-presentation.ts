import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCP_LOCATION = /^(?:[^@/\s]+@)?([^/:\s]+):(.+)$/u;

function privateLocationLabel(value: string): string {
  const basename = path.basename(value.replace(/[\\/]+$/u, ''));
  return basename && basename !== path.parse(value).root
    ? `已选择本地位置（${basename}）`
    : '已选择本地位置';
}

export function projectCatalogSourceLocation(value: string): string {
  if (path.isAbsolute(value)) return privateLocationLabel(value);
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return privateLocationLabel(fileURLToPath(url));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    if (value.includes('://')) return '已输入远程来源';
    const scp = SCP_LOCATION.exec(value);
    return scp
      ? `ssh://${scp[1]}/${scp[2]!.split(/[?#]/u, 1)[0]!.replace(/^\/+|\/+$/gu, '')}`
      : '已输入来源位置';
  }
}
