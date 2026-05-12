import path from 'node:path';

import fs from 'fs-extra';

import { detectCodexExternalOwnership } from '../adapters/helpers.js';
import { buildGeneratedName } from '../generators/shared.js';
import type {
  GeneratedArtifact,
  PlatformName,
  PluginMeta,
  Scope,
  TrackingPluginRecord,
} from '../types.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import {
  collectDesiredCodexProjectRepoArtifacts,
  getCodexDynamicArtifactTargets,
  needsCodexProjectConfigAccess,
  type CodexProjectRepoArtifact,
} from '../utils/codex-project-surface.js';
import {
  findCodexRoleNameConflict,
  resolveCodexRoleNamespace,
  type CodexResolvedRole,
} from '../utils/codex-roles.js';
import { resolveCodexPaths, resolveRepoRoot } from '../utils/paths.js';
import {
  getTrackingArtifactIntegrityErrors,
  readTrackingManifest,
  getTrackingRecord,
} from '../utils/tracking.js';
import type { ResolvedPluginTarget } from './common.js';

export {
  needsCodexProjectConfigAccess,
  pluginDeclaresCodexProjectConfigBackedArtifacts,
  trackingRecordTouchesCodexProjectConfig,
} from '../utils/codex-project-surface.js';

const AW_MARKETPLACE_NAME = 'aw';

export class CodexProjectWriteSafetyError extends Error {
  readonly code:
    | 'codexProjectUserConfigUnreadable'
    | 'externalOwnershipPresent'
    | 'projectConfigUnreadable'
    | 'roleNameConflict'
    | 'trackingIntegrityError'
    | 'unmanagedRepoArtifactConflict'
    | 'catalogNotCurrent';

  constructor(
    code: CodexProjectWriteSafetyError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'CodexProjectWriteSafetyError';
    this.code = code;
  }
}

export class CodexProjectStatusFatalError extends Error {
  readonly code = 'projectConfigUnreadable';

  constructor(message: string) {
    super(message);
    this.name = 'CodexProjectStatusFatalError';
  }
}

function relativeRepoPath(repoRoot: string, targetPath: string): string {
  const relative = path.relative(repoRoot, targetPath);
  return relative && !relative.startsWith('..') ? relative : targetPath;
}

function codexProjectPlatformsSelected(
  platforms: PlatformName[],
  scope: Scope,
): boolean {
  return scope === 'project' && platforms.includes('codex');
}

function codexPlatformsSelected(platforms: PlatformName[]): boolean {
  return platforms.includes('codex');
}

export function isCodexProjectWriteSafetyError(
  error: unknown,
): error is CodexProjectWriteSafetyError {
  return error instanceof CodexProjectWriteSafetyError;
}

export function isCodexProjectStatusFatalError(
  error: unknown,
): error is CodexProjectStatusFatalError {
  return error instanceof CodexProjectStatusFatalError;
}

function findTrackedArtifactOwner(
  trackingRecord: TrackingPluginRecord | undefined,
  desiredArtifact: CodexProjectRepoArtifact,
): GeneratedArtifact | undefined {
  return trackingRecord?.artifacts.find((artifact) =>
    artifact.kind === desiredArtifact.kind &&
      artifact.artifactKey === desiredArtifact.artifactKey,
  );
}

function findConflictingPluginOwner(
  manifest: Awaited<ReturnType<typeof readTrackingManifest>>,
  pluginName: string,
  desiredArtifact: CodexProjectRepoArtifact,
): string | undefined {
  for (const [ownerPluginName, record] of Object.entries(manifest.plugins)) {
    if (ownerPluginName === pluginName) {
      continue;
    }

    const conflict = record.artifacts.some((artifact) =>
      artifact.kind === desiredArtifact.kind &&
        artifact.artifactKey === desiredArtifact.artifactKey,
    );
    if (conflict) {
      return ownerPluginName;
    }
  }

  return undefined;
}

function createTrackingIntegrityError(
  pluginName: string,
  trackingDir: string,
  errors: ReturnType<typeof getTrackingArtifactIntegrityErrors>,
): CodexProjectWriteSafetyError {
  return new CodexProjectWriteSafetyError(
    'trackingIntegrityError',
    `${pluginName} 的 Codex project tracking identity 已损坏（${trackingDir}）：${errors.map((error) => error.message).join('；')}。`,
  );
}

function createUserConfigUnreadableError(
  configPath: string,
  error: unknown,
): CodexProjectWriteSafetyError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CodexProjectWriteSafetyError(
    'codexProjectUserConfigUnreadable',
    `无法完成 Codex project 写入前安全预检：用户级 Codex 配置 ${configPath} 无法解析，无法可靠检查 external ownership。${detail}`,
  );
}

function createProjectConfigUnreadableError(
  configPath: string,
  pluginName: string,
  error: unknown,
): CodexProjectWriteSafetyError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CodexProjectWriteSafetyError(
    'projectConfigUnreadable',
    `无法完成 Codex project 写入前安全预检：项目级 Codex 配置 ${configPath} 无法解析，而 ${pluginName} 需要读取或改写该文件。${detail}`,
  );
}

function createRoleNamespaceUnreadableError(
  configPath: string,
  scope: Scope,
  pluginName: string,
  error: unknown,
): CodexProjectWriteSafetyError {
  const detail = error instanceof Error ? error.message : String(error);
  const scopeLabel = scope === 'user' ? '用户级' : '项目级';
  return new CodexProjectWriteSafetyError(
    'projectConfigUnreadable',
    `无法完成 Codex role 冲突预检：${scopeLabel} Codex 配置 ${configPath} 无法解析，而 ${pluginName} 需要读取该 layer 的 role namespace。${detail}`,
  );
}

function createStatusProjectConfigUnreadableError(
  configPath: string,
  pluginName: string,
  error: unknown,
): CodexProjectStatusFatalError {
  const detail = error instanceof Error ? error.message : String(error);
  return new CodexProjectStatusFatalError(
    `无法读取 ${pluginName} 的 Codex project 状态：项目级 Codex 配置 ${configPath} 无法解析，而当前目标需要读取该文件。${detail}`,
  );
}

function createExternalOwnershipPresentError(
  detail: string,
): CodexProjectWriteSafetyError {
  return new CodexProjectWriteSafetyError(
    'externalOwnershipPresent',
    detail,
  );
}

function describeCodexRoleConflictSource(
  layerRoot: string,
  role: CodexResolvedRole,
): string {
  if (role.source === 'registration') {
    const parts = [`[agents.${role.tableKey ?? role.finalName}]`];
    if (role.roleLayerPath) {
      parts.push(
        `config_file=${JSON.stringify(path.relative(layerRoot, role.roleLayerPath) || path.basename(role.roleLayerPath))}`,
      );
    }
    return parts.join(' ');
  }

  if (role.roleLayerPath) {
    return path.relative(layerRoot, role.roleLayerPath) || path.basename(role.roleLayerPath);
  }

  return role.finalName;
}

function createRoleNameConflictError(options: {
  pluginName: string;
  scope: Scope;
  roleName: string;
  configPath: string;
  matches: CodexResolvedRole[];
}): CodexProjectWriteSafetyError {
  const scopeLabel = options.scope === 'user' ? '用户级' : '项目级';
  const layerRoot = path.dirname(options.configPath);
  const conflictSources = options.matches
    .map((match) => describeCodexRoleConflictSource(layerRoot, match))
    .join('；');

  return new CodexProjectWriteSafetyError(
    'roleNameConflict',
    `无法完成 Codex role 冲突预检：${scopeLabel} Codex 配置层里已经存在最终 role 名为 "${options.roleName}" 的非 AW 受管角色（${conflictSources}），${options.pluginName} 不能继续写入同名 role。`,
  );
}

function createRepoArtifactConflictError(
  repoRoot: string,
  pluginName: string,
  desiredArtifact: CodexProjectRepoArtifact,
  ownerPluginName?: string,
): CodexProjectWriteSafetyError {
  const subject = desiredArtifact.kind === 'skill'
    ? `repo skill "${desiredArtifact.artifactKey}"`
    : `MCP server "${desiredArtifact.artifactKey}"`;
  const location = desiredArtifact.kind === 'skill'
    ? relativeRepoPath(repoRoot, desiredArtifact.path)
    : '.codex/config.toml';
  const ownerDetail = ownerPluginName
    ? `它已由 ${ownerPluginName} 的 tracking 记录为受管产物。`
    : '它当前存在，但没有 AW tracking 能证明归属。';

  return new CodexProjectWriteSafetyError(
    'unmanagedRepoArtifactConflict',
    `无法完成 Codex project 写入前安全预检：${subject} 在 ${location} 上存在冲突。${ownerDetail}`,
  );
}

async function readProjectTrackingManifest(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<typeof readTrackingManifest>>> {
  const trackingDir = resolveCodexPaths(cwd, 'project', env).trackingDir;
  try {
    return await readTrackingManifest(trackingDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CodexProjectWriteSafetyError(
      'trackingIntegrityError',
      `无法读取 Codex project tracking manifest（${trackingDir}）：${detail}`,
    );
  }
}

function resolvePreflightPlugin(
  target: ResolvedPluginTarget,
  operation: 'install' | 'upgrade' | 'refresh',
): PluginMeta {
  if (operation === 'refresh' && target.source === 'historical') {
    return target.plugin;
  }

  if (operation !== 'install' && !target.currentPlugin) {
    throw new CodexProjectWriteSafetyError(
      'catalogNotCurrent',
      `${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`,
    );
  }

  return target.currentPlugin ?? target.plugin;
}

function collectStaticCodexRoleKeys(
  plugin: PluginMeta,
  scope: Scope,
): string[] {
  const roleKeys = new Set<string>();
  for (const target of getCodexDynamicArtifactTargets(plugin, { scope })) {
    if (target.target !== 'codex.agentRole' || !target.roleKey) {
      continue;
    }
    roleKeys.add(target.roleKey);
  }

  return [...roleKeys].sort();
}

function resolveManagedRoleLayerPath(
  configPath: string,
  pluginName: string,
  roleKey: string,
): string {
  return path.join(
    path.dirname(configPath),
    'agents',
    `${buildGeneratedName(pluginName, roleKey)}.toml`,
  );
}

async function preflightCodexRoleWriteSafety(options: {
  targets: ResolvedPluginTarget[];
  platforms: PlatformName[];
  cwd: string;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
  operation: 'install' | 'upgrade' | 'refresh';
}): Promise<void> {
  if (!codexPlatformsSelected(options.platforms)) {
    return;
  }

  const env = options.env ?? process.env;
  const configPath = resolveCodexPaths(options.cwd, options.scope, env).configTomlPath;

  for (const target of options.targets) {
    const plugin = resolvePreflightPlugin(target, options.operation);
    const roleKeys = collectStaticCodexRoleKeys(plugin, options.scope);
    if (roleKeys.length === 0) {
      continue;
    }

    let namespace: Awaited<ReturnType<typeof resolveCodexRoleNamespace>>;
    try {
      namespace = await resolveCodexRoleNamespace(configPath, {
        strict: true,
        awManagedTableKeys: roleKeys,
        awManagedRoleLayerPaths: roleKeys.map((roleKey) =>
          resolveManagedRoleLayerPath(configPath, plugin.manifest.name, roleKey)
        ),
      });
    } catch (error) {
      throw createRoleNamespaceUnreadableError(
        configPath,
        options.scope,
        target.pluginName,
        error,
      );
    }

    for (const roleKey of roleKeys) {
      const conflict = findCodexRoleNameConflict(namespace, roleKey);
      if (!conflict?.conflict) {
        continue;
      }

      throw createRoleNameConflictError({
        pluginName: target.pluginName,
        scope: options.scope,
        roleName: roleKey,
        configPath,
        matches: conflict.externalMatches,
      });
    }
  }
}

async function ensureProjectConfigReadable(
  cwd: string,
  env: NodeJS.ProcessEnv,
  pluginName: string,
  mode: 'write' | 'status',
): Promise<Awaited<ReturnType<typeof readCodexConfigFile>>> {
  const configTomlPath = resolveCodexPaths(cwd, 'project', env).configTomlPath;

  try {
    return await readCodexConfigFile(configTomlPath);
  } catch (error) {
    if (mode === 'status') {
      throw createStatusProjectConfigUnreadableError(configTomlPath, pluginName, error);
    }
    throw createProjectConfigUnreadableError(configTomlPath, pluginName, error);
  }
}

async function assertNoCodexProjectRepoArtifactConflicts(options: {
  repoRoot: string;
  pluginName: string;
  desiredArtifacts: CodexProjectRepoArtifact[];
  trackingManifest: Awaited<ReturnType<typeof readTrackingManifest>>;
  trackingRecord: TrackingPluginRecord | undefined;
  projectConfigSnapshot?: Awaited<ReturnType<typeof readCodexConfigFile>>['snapshot'];
}): Promise<void> {
  const projectMcpServerKeys = options.projectConfigSnapshot === undefined
    ? new Set<string>()
    : new Set(Object.keys(options.projectConfigSnapshot.mcpServers));

  for (const desiredArtifact of options.desiredArtifacts) {
    const conflictingPlugin = findConflictingPluginOwner(
      options.trackingManifest,
      options.pluginName,
      desiredArtifact,
    );
    if (conflictingPlugin) {
      throw createRepoArtifactConflictError(
        options.repoRoot,
        options.pluginName,
        desiredArtifact,
        conflictingPlugin,
      );
    }

    if (findTrackedArtifactOwner(options.trackingRecord, desiredArtifact)) {
      continue;
    }

    if (desiredArtifact.kind === 'skill') {
      if (await fs.pathExists(desiredArtifact.path)) {
        throw createRepoArtifactConflictError(
          options.repoRoot,
          options.pluginName,
          desiredArtifact,
        );
      }
      continue;
    }

    if (projectMcpServerKeys.has(desiredArtifact.artifactKey)) {
      throw createRepoArtifactConflictError(
        options.repoRoot,
        options.pluginName,
        desiredArtifact,
      );
    }
  }
}

export async function preflightCodexProjectWriteSafety(options: {
  targets: ResolvedPluginTarget[];
  platforms: PlatformName[];
  cwd: string;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
  operation: 'install' | 'upgrade' | 'refresh';
}): Promise<void> {
  await preflightCodexRoleWriteSafety(options);

  if (!codexProjectPlatformsSelected(options.platforms, options.scope)) {
    return;
  }

  const env = options.env ?? process.env;
  const repoRoot = await resolveRepoRoot(options.cwd);
  const userConfigPath = resolveCodexPaths(options.cwd, 'user', env).configTomlPath;
  const trackingManifest = await readProjectTrackingManifest(options.cwd, env);

  let userConfig: Awaited<ReturnType<typeof readCodexConfigFile>>;
  try {
    userConfig = await readCodexConfigFile(userConfigPath);
  } catch (error) {
    throw createUserConfigUnreadableError(userConfigPath, error);
  }

  let projectConfigSnapshot: Awaited<ReturnType<typeof readCodexConfigFile>>['snapshot'] | undefined;

  for (const target of options.targets) {
    const plugin = resolvePreflightPlugin(target, options.operation);

    const externalOwnership = detectCodexExternalOwnership(
      userConfig.snapshot.plugins,
      plugin.manifest.name,
      AW_MARKETPLACE_NAME,
    );
    if (externalOwnership?.present) {
      throw createExternalOwnershipPresentError(
        externalOwnership.details ?? '同名插件已由外部 marketplace 管理。',
      );
    }

    const trackingRecord = getTrackingRecord(trackingManifest, target.pluginName);
    const trackingIntegrityErrors = getTrackingArtifactIntegrityErrors(
      trackingRecord?.artifacts ?? [],
    );
    if (trackingIntegrityErrors.length > 0) {
      throw createTrackingIntegrityError(
        target.pluginName,
        resolveCodexPaths(options.cwd, 'project', env).trackingDir,
        trackingIntegrityErrors,
      );
    }

    const needsProjectConfig = needsCodexProjectConfigAccess(plugin, trackingRecord);
    if (needsProjectConfig && projectConfigSnapshot === undefined) {
      projectConfigSnapshot = (
        await ensureProjectConfigReadable(
          options.cwd,
          env,
          target.pluginName,
          'write',
        )
      ).snapshot;
    }

    const desiredArtifacts = await collectDesiredCodexProjectRepoArtifacts(plugin, repoRoot);
    await assertNoCodexProjectRepoArtifactConflicts({
      repoRoot,
      pluginName: target.pluginName,
      desiredArtifacts,
      trackingManifest,
      trackingRecord,
      projectConfigSnapshot,
    });
  }
}

export async function preflightCodexProjectStatusProjectConfig(options: {
  plugin: PluginMeta;
  trackingRecord: TrackingPluginRecord | undefined;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!needsCodexProjectConfigAccess(options.plugin, options.trackingRecord)) {
    return;
  }

  await ensureProjectConfigReadable(
    options.cwd,
    options.env ?? process.env,
    options.plugin.manifest.name,
    'status',
  );
}
