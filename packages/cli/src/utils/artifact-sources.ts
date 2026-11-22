import path from 'node:path';
import fs from 'fs-extra';

export async function resolveCommandSourceDirectory(options: {
  bundleRoot: string;
  pluginRelativePath: string;
}): Promise<string> {
  const root = await fs.realpath(options.bundleRoot);
  const relative = options.pluginRelativePath.replace(/^\.\//u, '');
  const segments = relative.split('/');
  if (!relative || segments.some((segment) => !segment || segment === '.' || segment === '..') || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error('commandResourceInvalid: command source must be inside the plugin bundle.');
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('commandResourceInvalid: command source paths must contain only regular directories.');
  }
  return current;
}
