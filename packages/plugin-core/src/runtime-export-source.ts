import path from 'node:path';

import fs from 'fs-extra';

const FORBIDDEN_EXPORT_ROOTS = new Set([
  '.release', '.tmp', 'build', 'dist', 'evals', 'node_modules', 'reports', 'skills', 'tmp',
]);
const AUTHORING_TREE_IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

export function isIgnoredPluginInputDirectory(name: string): boolean {
  return AUTHORING_TREE_IGNORED_DIRECTORIES.has(name);
}

export async function assertPluginInputTree(rootDir: string): Promise<string> {
  const rootPath = path.resolve(rootDir);
  const rootStats = await fs.lstat(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Invalid plugin input tree: plugin root must be a regular directory.');
  }
  const rootRealPath = await fs.realpath(rootPath);
  const walk = async (directory: string, relativeRoot = ''): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeRoot
        ? path.posix.join(relativeRoot, entry.name)
        : entry.name;
      if (entry.isDirectory() && isIgnoredPluginInputDirectory(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`Invalid plugin input tree: symbolic links are not supported (${relativePath}).`);
      }
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relativePath);
      } else if (!entry.isFile()) {
        throw new Error(`Invalid plugin input tree: only regular files and directories are supported (${relativePath}).`);
      }
    }
  };
  await walk(rootRealPath);
  return rootRealPath;
}

export interface CanonicalRuntimeSourceIdentity {
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  sourceRealPath: string;
}

export async function resolveCanonicalRuntimeSourceIdentity(
  rootDir: string,
  relativePath: string,
  fieldName: string,
): Promise<CanonicalRuntimeSourceIdentity> {
  const rootPath = path.resolve(rootDir);
  const rootStats = await fs.lstat(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Invalid ${fieldName}: source root must be a regular directory.`);
  }
  const rootRealPath = await fs.realpath(rootPath);
  const segments = relativePath.replace(/^\.\//u, '').split('/');
  let current = rootRealPath;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current).catch(() => undefined);
    if (!stats) throw new Error(`Invalid ${fieldName}: missing file "${relativePath}".`);
    if (stats.isSymbolicLink()) {
      throw new Error(`Invalid ${fieldName}: symbolic links are not supported (${relativePath}).`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`Invalid ${fieldName}: path parent is not a directory (${relativePath}).`);
    }
    if (index === segments.length - 1 && !stats.isFile()) {
      throw new Error(`Invalid ${fieldName}: expected a regular file (${relativePath}).`);
    }
  }
  return { rootPath, rootRealPath, relativePath, sourceRealPath: await fs.realpath(current) };
}

export async function validateRuntimeExportSource(options: {
  pluginRoot: string;
  name: string;
  source: string;
}): Promise<CanonicalRuntimeSourceIdentity> {
  const normalizedSource = options.source.replace(/^\.\//u, '');
  const forbiddenSegment = normalizedSource.split('/').find((segment) =>
    FORBIDDEN_EXPORT_ROOTS.has(segment));
  if (forbiddenSegment) {
    throw new Error(
      `Invalid buildConfig.runtimeExports export "${options.name}": source must not be below ${forbiddenSegment}/.`,
    );
  }

  const fieldName = `buildConfig.runtimeExports export "${options.name}"`;
  return resolveCanonicalRuntimeSourceIdentity(options.pluginRoot, options.source, fieldName);
}
