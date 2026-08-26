import * as fs from 'node:fs';
import * as path from 'node:path';

function pathExistsWithLstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDirectoryNode(filePath, label) {
  const stat = pathExistsWithLstat(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${filePath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${filePath}`);
  }
  return true;
}

export function assertAuthoringPluginPathFence(options) {
  const requestedRepoRoot = options.repoRoot === undefined
    ? null
    : path.resolve(options.repoRoot);
  const requestedPluginRoot = path.resolve(options.pluginRoot);
  if (requestedRepoRoot) {
    if (!assertDirectoryNode(requestedRepoRoot, 'Workspace root')) {
      throw new Error(`Workspace root is not a directory: ${requestedRepoRoot}`);
    }
  }
  const repoRoot = requestedRepoRoot ? fs.realpathSync(requestedRepoRoot) : null;
  if (requestedRepoRoot && !isInsideRoot(requestedRepoRoot, requestedPluginRoot)) {
    throw new Error(`Plugin root must be inside the workspace root: ${requestedPluginRoot}`);
  }
  const pluginRoot = repoRoot
    ? path.join(repoRoot, path.relative(requestedRepoRoot, requestedPluginRoot))
    : requestedPluginRoot;

  const boundary = repoRoot ?? path.dirname(pluginRoot);
  const relativeSegments = path.relative(boundary, pluginRoot).split(path.sep).filter(Boolean);
  let currentPath = boundary;
  let pluginExists = true;
  for (const segment of relativeSegments) {
    currentPath = path.join(currentPath, segment);
    const stat = pathExistsWithLstat(currentPath);
    if (!stat) {
      pluginExists = false;
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Plugin root path must not contain symbolic links: ${currentPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Plugin root path component is not a directory: ${currentPath}`);
    }
  }
  if (options.requirePluginRoot && !pluginExists) {
    throw new Error(`Plugin root is not a directory: ${pluginRoot}`);
  }
  if (!pluginExists || !options.requireManifest) {
    return { repoRoot, pluginRoot };
  }

  const manifestDirectory = path.join(pluginRoot, '.agents-plugin');
  const manifestDirectoryStat = pathExistsWithLstat(manifestDirectory);
  if (
    !manifestDirectoryStat
    || manifestDirectoryStat.isSymbolicLink()
    || !manifestDirectoryStat.isDirectory()
  ) {
    throw new Error(`Plugin manifest directory must be a non-symbolic-link directory: ${manifestDirectory}`);
  }
  const manifestPath = path.join(manifestDirectory, 'plugin.json');
  const manifestStat = pathExistsWithLstat(manifestPath);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`Plugin manifest must be a regular non-symbolic-link file: ${manifestPath}`);
  }
  const canonicalManifest = fs.realpathSync(manifestPath);
  if (!isInsideRoot(fs.realpathSync(pluginRoot), canonicalManifest)) {
    throw new Error(`Plugin manifest must stay inside the plugin root: ${manifestPath}`);
  }
  return { repoRoot, pluginRoot, manifestPath };
}

export function resolveAuthoringPluginRoot(options) {
  const requestedRepoRoot = path.resolve(options.repoRoot ?? '.');
  if (!assertDirectoryNode(requestedRepoRoot, 'Workspace root')) {
    throw new Error(`Workspace root is not a directory: ${requestedRepoRoot}`);
  }
  const repoRoot = fs.realpathSync(requestedRepoRoot);
  const explicit = options.pluginRoot !== undefined;
  const pluginRoot = explicit
    ? path.resolve(repoRoot, options.pluginRoot)
    : path.join(repoRoot, 'plugins', options.pluginName);
  if (!isInsideRoot(repoRoot, pluginRoot)) {
    throw new Error(`--plugin-root must be inside the workspace root: ${pluginRoot}`);
  }
  if (path.basename(pluginRoot) !== options.pluginName) {
    throw new Error(
      `Plugin root directory ${JSON.stringify(path.basename(pluginRoot))} does not match plugin name ${JSON.stringify(options.pluginName)}.`,
    );
  }

  assertAuthoringPluginPathFence({ repoRoot, pluginRoot });

  return {
    explicit,
    repoRoot,
    pluginRoot,
    relativePluginRoot: path.relative(repoRoot, pluginRoot).split(path.sep).join('/'),
  };
}

export function assertCanonicalAuthoringPluginRoot(options) {
  const fenced = assertAuthoringPluginPathFence({
    repoRoot: options.workspaceRoot,
    pluginRoot: options.pluginRoot,
    requirePluginRoot: options.requirePluginRoot ?? true,
    requireManifest: options.requireManifest ?? false,
  });
  const expected = path.join(fenced.repoRoot, 'plugins', options.pluginName);
  if (path.resolve(fenced.pluginRoot) !== path.resolve(expected)) {
    throw new Error(`Plugin root must use the canonical workspace path: ${expected}`);
  }
  return { ...fenced, expectedPluginRoot: expected };
}
