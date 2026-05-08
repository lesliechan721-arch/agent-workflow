import fs from 'node:fs';
import path from 'node:path';

import {
  resolveAwHome,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveRepoRootSync,
} from '../utils/paths.js';
import {
  createHistoricalLifecycleScopeKey,
  createHistoricalLifecycleRuntimePathSet,
  createRecordId,
  createSharedIdentityId,
  getSharedRuntimeOwnerFileName,
} from './ids.js';
import {
  isPathInside,
  normalizeRepoRelativePath,
} from './internal.js';
import type {
  HistoricalLifecycleRuntimePathSet,
  PluginLocation,
  ProjectArtifactSharedLocator,
} from './types.js';

export function getInstallStatePrivateRoot(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configDir = location.platform === 'claude'
    ? resolveClaudePaths(cwd, location.scope, env).configDir
    : resolveCodexPaths(cwd, location.scope, env).configDir;
  return path.join(configDir, '.agent-workflows');
}

export function getInstallRecordPath(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getInstallStatePrivateRoot(cwd, location, env), 'records', `${createRecordId(location)}.json`);
}

export function getDiagnosticCachePath(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getInstallStatePrivateRoot(cwd, location, env), 'diagnostics', `${createRecordId(location)}.json`);
}

export function createProjectArtifactSharedLocator(options: {
  plugin: string;
  platform: PluginLocation['platform'];
  repoRoot: string;
  projectRoot: string;
}): ProjectArtifactSharedLocator {
  const relativeRoot = path.relative(options.repoRoot, options.projectRoot);
  const repoRelativeProjectRoot = relativeRoot === ''
    ? '.'
    : relativeRoot.split(path.sep).join('/');
  const normalized = normalizeRepoRelativePath(repoRelativeProjectRoot, { allowDot: true });
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }

  return {
    plugin: options.plugin,
    platform: options.platform,
    scope: 'project',
    repoRelativeProjectRoot: normalized.value,
  };
}

export function getProjectArtifactSharedIdentityPath(options: {
  repoRoot: string;
  locator: ProjectArtifactSharedLocator;
}): string {
  const sharedIdentityId = createSharedIdentityId(options.locator);
  return path.join(
    options.repoRoot,
    '.agent-workflows',
    'project-artifacts',
    options.locator.platform,
    `${sharedIdentityId}.json`,
  );
}

export function getGlobalDependencyIndexPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveAwHome(env), 'dependency-index', 'index.json');
}

export function getNativeTransactionMarkerPath(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pluginId = pluginNameOrId.endsWith('@aw')
    ? pluginNameOrId
    : `${pluginNameOrId}@aw`;
  return path.join(
    resolveAwHome(env),
    'native-recovery',
    'codex',
    'user',
    `${pluginId}.json`,
  );
}

export function getSharedSkillTriggerRuntimeOwnerPath(options: {
  pluginName: string;
  platform: PluginLocation['platform'];
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(
    resolveAwHome(options.env),
    'shared-runtime-owners',
    options.platform,
    getSharedRuntimeOwnerFileName(options.pluginName),
  );
}

export function createHistoricalLifecycleRuntimePaths(options: {
  cwd: string;
  location: PluginLocation;
  recordId?: string;
  manifestDigest: string;
  bundleFingerprint: string;
  nonce: string;
  env?: NodeJS.ProcessEnv;
  manifestRelativePath?: string;
}): HistoricalLifecycleRuntimePathSet {
  const recordId = options.recordId ?? createRecordId(options.location);
  const runtimeBaseRoot = path.join(
    resolveAwHome(options.env),
    'lifecycle-runtimes',
    options.location.platform,
    options.location.scope,
  );
  const scopeKey = createHistoricalLifecycleScopeKey(options.location);
  const runtimeRootBase = path.join(runtimeBaseRoot, scopeKey, recordId);
  const runtimeId = createHistoricalLifecycleRuntimePathSet({
    location: options.location,
    recordId,
    manifestDigest: options.manifestDigest,
    bundleFingerprint: options.bundleFingerprint,
    nonce: options.nonce,
    runtimeRootBase: path.join(runtimeRootBase, 'pending'),
    manifestRelativePath: options.manifestRelativePath,
  }).runtimeId;
  const pathSet = createHistoricalLifecycleRuntimePathSet({
    location: options.location,
    recordId,
    manifestDigest: options.manifestDigest,
    bundleFingerprint: options.bundleFingerprint,
    nonce: options.nonce,
    runtimeRootBase: path.join(runtimeRootBase, runtimeId),
    manifestRelativePath: options.manifestRelativePath,
  });

  if (!isPathInside(runtimeRootBase, pathSet.runtimeRoot)) {
    throw new Error(`Invalid lifecycle runtime root: ${pathSet.runtimeRoot}`);
  }
  if (!isPathInside(pathSet.runtimeRoot, pathSet.bundleRoot)) {
    throw new Error(`Invalid lifecycle bundle root: ${pathSet.bundleRoot}`);
  }
  if (!isPathInside(pathSet.bundleRoot, pathSet.manifestPath)) {
    throw new Error(`Invalid lifecycle manifest path: ${pathSet.manifestPath}`);
  }

  return pathSet;
}

export function resolveProjectScopeRepoRoot(cwd: string): string {
  return resolveRepoRootSync(cwd);
}

function realpathOrResolvedSync(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectArtifactProjectRoot(
  cwd: string,
  location: Pick<PluginLocation, 'scope' | 'platform' | 'projectKey'>,
): string {
  const repoRoot = resolveProjectScopeRepoRoot(cwd);
  if (location.scope !== 'project' || location.platform !== 'claude') {
    return repoRoot;
  }

  const candidate = location.projectKey
    ? path.resolve(location.projectKey)
    : path.resolve(cwd);
  const repoRootReal = realpathOrResolvedSync(repoRoot);
  const candidateReal = realpathOrResolvedSync(candidate);
  const relativeFromRealRepo = path.relative(repoRootReal, candidateReal);
  if (
    relativeFromRealRepo === ''
    || (
      relativeFromRealRepo !== '..'
      && !relativeFromRealRepo.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeFromRealRepo)
    )
  ) {
    return path.join(repoRoot, relativeFromRealRepo);
  }

  return path.resolve(cwd);
}
