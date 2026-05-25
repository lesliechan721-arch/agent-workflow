import fs from 'node:fs';
import path from 'node:path';

import {
  resolveAwHome,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveRepoRootSync,
} from '../utils/paths.js';
import { getCodexNativeRecoveryBreadcrumbPath } from '../utils/codex-native-recovery.js';
import {
  assertTestReadablePath,
  assertTestWritablePath,
} from '../utils/test-path-fence.js';
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

type InstallStatePathAccess = 'read' | 'write';

function assertProjectScopePathForTests(
  targetPath: string,
  access: InstallStatePathAccess,
  source: string,
): string {
  const recommendedFix = access === 'write'
    ? '用 withSafeTestCwd() 切到测试可写 cwd，或通过 registerWritableStateRoot() 登记 project fixture 根。'
    : '用 registerReadonlyFixtureRoot() 或 runWithRepositoryCwdAsReadOnly() 登记只读 project fixture 根。';
  return access === 'write'
    ? assertTestWritablePath(targetPath, source, recommendedFix)
    : assertTestReadablePath(targetPath, source, recommendedFix);
}

function assertAwHomeStatePathForTests(
  targetPath: string,
  source: string,
): string {
  return assertTestWritablePath(
    targetPath,
    source,
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或通过 registerWritableStateRoot() 登记 AW_HOME 根。',
  );
}

export function getInstallStatePrivateRoot(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv = process.env,
  access: InstallStatePathAccess = 'read',
): string {
  const configDir = location.platform === 'claude'
    ? resolveClaudePaths(cwd, location.scope, env).configDir
    : resolveCodexPaths(cwd, location.scope, env).configDir;
  const privateRoot = path.join(configDir, '.agent-workflows');
  if (location.scope !== 'project') {
    return privateRoot;
  }
  return assertProjectScopePathForTests(
    privateRoot,
    access,
    `${location.platform} project install-state private root`,
  );
}

export function getInstallRecordPath(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv = process.env,
  access: InstallStatePathAccess = 'read',
): string {
  const filePath = path.join(
    getInstallStatePrivateRoot(cwd, location, env, access),
    'records',
    `${createRecordId(location)}.json`,
  );
  if (location.scope !== 'project') {
    return filePath;
  }
  return assertProjectScopePathForTests(
    filePath,
    access,
    `${location.platform} project install record`,
  );
}

export function getDiagnosticCachePath(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv = process.env,
  access: InstallStatePathAccess = 'read',
): string {
  const filePath = path.join(
    getInstallStatePrivateRoot(cwd, location, env, access),
    'diagnostics',
    `${createRecordId(location)}.json`,
  );
  if (location.scope !== 'project') {
    return filePath;
  }
  return assertProjectScopePathForTests(
    filePath,
    access,
    `${location.platform} project dynamic artifact diagnostic cache`,
  );
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
  access?: InstallStatePathAccess;
}): string {
  const sharedIdentityId = createSharedIdentityId(options.locator);
  const filePath = path.join(
    options.repoRoot,
    '.agent-workflows',
    'project-artifacts',
    options.locator.platform,
    `${sharedIdentityId}.json`,
  );
  return assertProjectScopePathForTests(
    filePath,
    options.access ?? 'read',
    'project artifact shared identity',
  );
}

export function getGlobalDependencyIndexPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return assertAwHomeStatePathForTests(
    path.join(resolveAwHome(env), 'dependency-index', 'index.json'),
    'global dependency index',
  );
}

export function getNativeTransactionMarkerPath(
  pluginNameOrId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return assertAwHomeStatePathForTests(
    getCodexNativeRecoveryBreadcrumbPath(pluginNameOrId, env),
    'native transaction marker',
  );
}

export function getSharedSkillTriggerRuntimeOwnerPath(options: {
  pluginName: string;
  platform: PluginLocation['platform'];
  env?: NodeJS.ProcessEnv;
}): string {
  return assertAwHomeStatePathForTests(
    path.join(
      resolveAwHome(options.env),
      'shared-runtime-owners',
      options.platform,
      getSharedRuntimeOwnerFileName(options.pluginName),
    ),
    'shared runtime owner',
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
  const runtimeBaseRoot = assertAwHomeStatePathForTests(
    path.join(
      resolveAwHome(options.env),
      'lifecycle-runtimes',
      options.location.platform,
      options.location.scope,
    ),
    `${options.location.platform} ${options.location.scope} historical lifecycle runtime root`,
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
