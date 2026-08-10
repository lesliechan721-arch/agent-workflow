import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import { extractCodexHookGroups } from '../generators/hooks.js';
import {
  generateInstructionArtifacts,
  renderCodexManagedInstructionBlock,
} from '../generators/instructions.js';
import {
  generateCodexPermissionArtifacts,
  mergeClaudePermissions,
  type ClaudePermissions,
} from '../generators/permissions.js';
import { buildGeneratedName } from '../generators/shared.js';
import type {
  CatalogResolution,
  CodexSharedHookGroup,
  GeneratedArtifact,
  PlatformName,
  PluginMeta,
  Scope,
  TrackedHookGroupIdentity,
} from '../types.js';
import type { CommandReporter, DebugLogger } from '../output/model.js';
import {
  applyCodexConfigTransactionFile,
  composeManagedDeveloperInstructionsBlock,
  readCodexConfigFile,
  readRenderedCodexMcpServersFile,
  type CodexMcpServerConfig,
  type CodexAgentRegistrationConfig,
} from '../utils/codex-config.js';
import {
  createCodexSkillExpectedTree,
  createCodexSkillStagingTreeContentDigest,
} from '../utils/codex-skill-staging.js';
import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  writeDynamicSkillTree,
  type DynamicSkillTree,
} from '../utils/dynamic-skill-tree.js';
import {
  parseCodexSharedHooksFile,
  renderTrackedHookGroupIdentity,
  resolvePlatformHookDefinitions,
  serializeTrackedHookGroupIdentity,
} from '../utils/hooks-contract.js';
import {
  buildCodexMarketplaceAddInvocation,
  buildCodexMarketplaceListInvocation,
  buildCodexMarketplaceRemoveInvocation,
  buildCodexPluginAddInvocation,
  buildCodexPluginListInvocation,
  buildCodexPluginRemoveInvocation,
  runNativeCliChecked,
  type NativeCliRunner,
} from '../utils/native-cli.js';
import {
  OWNED_TEXT_HEADER_PREFIX,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  inspectOwnedComponents,
  writeOwnedTextFile,
  type OwnedComponent,
  type OwnerIdentity,
  type OwnershipInspection,
} from '../utils/ownership.js';
import { resolveArtifactRenderConfig, runArtifactRenderer } from '../utils/artifact-renderer.js';
import { validateArtifactPlan, type ValidatedArtifactPlanArtifact } from '../utils/artifact-plan.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveRepoRoot,
  getCodexHome,
} from '../utils/paths.js';
import { runLifecycleScript } from '../utils/plugin-scripts.js';
import { ensureLocalMarketplace } from '../utils/local-marketplace.js';
import { readClaudeSettings, writeClaudeSettings, type ClaudeSettings } from '../adapters/helpers.js';
import { requiresCodexNativePlugin } from '../utils/codex-project-surface.js';
import { assertCanonicalProjectManagedRoots } from '../utils/project-boundary.js';
import {
  findCodexRoleNameConflict,
  resolveCodexRoleNamespace,
} from '../utils/codex-roles.js';
import type {
  DesiredTarget,
  RebuildLifecycleInvocation,
  RebuildTargetDriver,
} from './rebuild-operations.js';

const MARKETPLACE_NAME = 'aw';
const MCP_OWNER_ENV = 'AW_AGENT_WORKFLOWS_OWNER';

interface PlannedWrite {
  artifact: GeneratedArtifact;
  component?: OwnedComponent;
  additionalComponents?: OwnedComponent[];
  optional?: boolean;
  write(): Promise<void>;
}

interface RebuildIntegrationPlan {
  catalog: CatalogResolution;
  event: 'install' | 'upgrade';
  writes: PlannedWrite[];
}

export interface RebuildIntegration {
  driver: RebuildTargetDriver;
  buildTarget(options: {
    plugin: PluginMeta;
    platform: PlatformName;
    scope: Scope;
    cwd: string;
    command: 'install' | 'upgrade' | 'reinstall' | 'cleanup' | 'uninstall';
    catalog: CatalogResolution;
    includeHistoricalLifecycleArtifacts: boolean;
    readOnlyInspectionPlan?: boolean;
  }): Promise<DesiredTarget>;
}

export interface RebuildExecutionContext {
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
  reporter: CommandReporter;
  debugLogger: DebugLogger;
}

function ownerIdentity(
  plugin: string,
  artifactKey: string,
  platform: PlatformName,
  scope: Scope,
): OwnerIdentity {
  return { owner: 'agent-workflows', plugin, artifactKey, platform, scope };
}

function internalArtifactKey(kind: string, value: string): string {
  return `${kind}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function pathComponent(options: {
  kind: 'owned-text-file' | 'skill-directory';
  path: string;
  allowedRoot: string;
  identity: OwnerIdentity;
}): OwnedComponent {
  return options;
}

function generatedTextWrite(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  configDir: string;
  relativePath: string;
  artifactKey: string;
  content: string;
  kind: GeneratedArtifact['kind'];
}): PlannedWrite {
  const artifactPath = path.join(options.configDir, options.relativePath);
  const identity = ownerIdentity(
    options.plugin.manifest.name,
    options.artifactKey,
    options.platform,
    options.scope,
  );
  const component = pathComponent({
    kind: 'owned-text-file',
    path: artifactPath,
    allowedRoot: options.configDir,
    identity,
  });
  return {
    artifact: {
      path: artifactPath,
      kind: options.kind,
      platform: options.platform,
      artifactKey: options.artifactKey,
    },
    component,
    write: async () => {
      await fs.ensureDir(options.configDir);
      await writeOwnedTextFile({
        path: artifactPath,
        allowedRoot: options.configDir,
        identity,
        content: options.content,
      });
    },
  };
}

function normalizePermissionState(value: Partial<ClaudePermissions> | undefined): ClaudePermissions {
  return {
    allow: [...new Set(value?.allow ?? [])],
    ask: [...new Set(value?.ask ?? [])],
    deny: [...new Set(value?.deny ?? [])],
  };
}

function mergePermissionStates(values: Array<Partial<ClaudePermissions> | undefined>): ClaudePermissions {
  return {
    allow: [...new Set(values.flatMap((value) => value?.allow ?? []))],
    ask: [...new Set(values.flatMap((value) => value?.ask ?? []))],
    deny: [...new Set(values.flatMap((value) => value?.deny ?? []))],
  };
}

function subtractPermissionState(
  value: Partial<ClaudePermissions> | undefined,
  generated: ClaudePermissions,
): ClaudePermissions {
  const remove = {
    allow: new Set(generated.allow),
    ask: new Set(generated.ask),
    deny: new Set(generated.deny),
  };
  return {
    allow: (value?.allow ?? []).filter((entry) => !remove.allow.has(entry)),
    ask: (value?.ask ?? []).filter((entry) => !remove.ask.has(entry)),
    deny: (value?.deny ?? []).filter((entry) => !remove.deny.has(entry)),
  };
}

function rebuildClaudePermissions(settings: ClaudeSettings, pluginName: string, desired?: ClaudePermissions): void {
  const previousGenerated = mergePermissionStates(
    Object.values(settings.awGenerated?.permissions ?? {}),
  );
  const manual = settings.awGenerated?.manualPermissions
    ? normalizePermissionState(settings.awGenerated.manualPermissions)
    : subtractPermissionState(settings.permissions, previousGenerated);
  settings.awGenerated ??= {};
  settings.awGenerated.permissions ??= {};
  if (desired) settings.awGenerated.permissions[pluginName] = desired;
  else delete settings.awGenerated.permissions[pluginName];
  if (Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }
  if (manual.allow.length || manual.ask.length || manual.deny.length) {
    settings.awGenerated.manualPermissions = manual;
  } else {
    delete settings.awGenerated.manualPermissions;
  }
  settings.permissions = mergePermissionStates([
    manual,
    ...Object.values(settings.awGenerated.permissions ?? {}),
  ]);
  if (
    settings.awGenerated.permissions === undefined
    && settings.awGenerated.manualPermissions === undefined
    && settings.awGenerated.hooks === undefined
    && settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

function createClaudePermissionsComponent(options: {
  pluginName: string;
  scope: Scope;
  settingsPath: string;
}): OwnedComponent {
  return {
    kind: 'shared-config',
    identity: ownerIdentity(options.pluginName, 'permissions', 'claude', options.scope),
    label: `${options.settingsPath}#awGenerated.permissions.${options.pluginName}`,
    inspect: async () => {
      const settings = await readClaudeSettings(options.settingsPath);
      return settings.awGenerated?.permissions?.[options.pluginName] ? 'present' : 'absent';
    },
    remove: async () => {
      const settings = await readClaudeSettings(options.settingsPath);
      rebuildClaudePermissions(settings, options.pluginName);
      await writeClaudeSettings(options.settingsPath, settings);
    },
  };
}

function createCodexInstructionComponent(options: {
  pluginName: string;
  scope: Scope;
  configPath: string;
}): OwnedComponent {
  return {
    kind: 'managed-block',
    identity: ownerIdentity(options.pluginName, 'developer-instructions', 'codex', options.scope),
    label: `${options.configPath}#developer_instructions:${options.pluginName}`,
    inspect: async () => {
      const config = await readCodexConfigFile(options.configPath);
      return config.snapshot.developerInstructions.managedBlocks[options.pluginName]
        ? 'present'
        : 'absent';
    },
    remove: async () => {
      await applyCodexConfigTransactionFile(options.configPath, {
        removeManagedInstructionPluginName: options.pluginName,
      });
    },
  };
}

function createCodexMcpComponent(options: {
  pluginName: string;
  scope: Scope;
  configPath: string;
  serverKey: string;
  owned: boolean;
}): OwnedComponent & { authorize(): void } {
  let authorized = options.owned;
  return {
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('mcp', options.serverKey),
      'codex',
      options.scope,
    ),
    label: `${options.configPath}#mcp_servers.${options.serverKey}`,
    inspect: async () => {
      const config = await readCodexConfigFile(options.configPath);
      const actual = config.snapshot.mcpServers[options.serverKey];
      if (!actual) return 'absent';
      const envValue = actual.value?.env;
      const intrinsicOwner = envValue
        && typeof envValue === 'object'
        && !Array.isArray(envValue)
        && envValue[MCP_OWNER_ENV] === options.pluginName;
      return authorized || intrinsicOwner ? 'present' : 'foreign';
    },
    remove: async () => {
      await applyCodexConfigTransactionFile(options.configPath, {
        removeMcpServers: [options.serverKey],
      });
    },
    authorize: () => { authorized = true; },
  };
}

function createCodexRoleRegistrationComponent(options: {
  pluginName: string;
  scope: Scope;
  configPath: string;
  roleKey: string;
  rolePath: string;
}): OwnedComponent {
  const expected = path.normalize(path.relative(path.dirname(options.configPath), options.rolePath));
  const roleIdentity = ownerIdentity(options.pluginName, options.roleKey, 'codex', options.scope);
  const inspect = async (): Promise<'present' | 'absent' | 'foreign'> => {
    const config = await readCodexConfigFile(options.configPath);
    const registration = config.snapshot.agents[options.roleKey];
    if (!registration) return 'absent';
    const actual = registration.configFile
      ? path.normalize(path.relative(
          path.dirname(options.configPath),
          path.resolve(path.dirname(options.configPath), registration.configFile),
        ))
      : '';
    if (actual !== expected) return 'foreign';
    const raw = await fs.readFile(options.rolePath, 'utf8').catch(() => '');
    try {
      return parseOwnedTextHeader(raw, roleIdentity) ? 'present' : 'foreign';
    } catch {
      return 'foreign';
    }
  };
  return {
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('role', options.roleKey),
      'codex',
      options.scope,
    ),
    label: `${options.configPath}#agents.${options.roleKey}`,
    inspect,
    remove: async () => {
      if (await inspect() !== 'present') return;
      await applyCodexConfigTransactionFile(options.configPath, {
        removeAgentRegistrations: [options.roleKey],
      });
    },
  };
}

async function readCodexHooks(hooksPath: string) {
  if (!await fs.pathExists(hooksPath)) return parseCodexSharedHooksFile({ hooks: {} });
  return parseCodexSharedHooksFile(await fs.readJson(hooksPath));
}

async function writeCodexHookGroups(
  hooksPath: string,
  groups: CodexSharedHookGroup[],
): Promise<void> {
  const hooks: Record<string, Record<string, unknown>[]> = {};
  for (const group of groups) {
    hooks[group.event] ??= [];
    hooks[group.event]!.push(group.rawGroup);
  }
  if (Object.keys(hooks).length === 0) {
    await fs.remove(hooksPath);
    return;
  }
  await fs.outputJson(hooksPath, { hooks }, { spaces: 2 });
}

function renderCodexSharedHookGroup(identity: TrackedHookGroupIdentity): CodexSharedHookGroup {
  const rendered = renderTrackedHookGroupIdentity(identity);
  const rawGroup = {
    ...(rendered.matcher === undefined ? {} : { matcher: rendered.matcher }),
    hooks: rendered.hooks as unknown as Record<string, unknown>[],
  };
  return {
    event: rendered.event,
    matcher: rendered.matcher,
    hooks: rendered.hooks as unknown as Record<string, unknown>[],
    rawGroup,
  };
}

function createCodexHookComponent(options: {
  pluginName: string;
  scope: Scope;
  hooksPath: string;
  identity: TrackedHookGroupIdentity;
}): OwnedComponent {
  const serialized = serializeTrackedHookGroupIdentity(options.identity);
  return {
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('hook', serialized),
      'codex',
      options.scope,
    ),
    label: `${options.hooksPath}#${serialized}`,
    inspect: async () => {
      const parsed = await readCodexHooks(options.hooksPath);
      return parsed.managedIdentities.some((entry) =>
        serializeTrackedHookGroupIdentity(entry) === serialized)
        ? 'present'
        : 'absent';
    },
    remove: async () => {
      const parsed = await readCodexHooks(options.hooksPath);
      let removed = false;
      const remaining = parsed.groups.flatMap((entry) => {
        if (
          !removed
          && entry.managedIdentity
          && serializeTrackedHookGroupIdentity(entry.managedIdentity) === serialized
        ) {
          removed = true;
          return [];
        }
        return [entry.rawGroup];
      });
      await writeCodexHookGroups(options.hooksPath, remaining);
    },
  };
}

function ownedCodexHookIdentity(options: {
  pluginName: string;
  scope: Scope;
  identity: TrackedHookGroupIdentity;
}): TrackedHookGroupIdentity {
  const artifactKey = internalArtifactKey(
    'hook',
    serializeTrackedHookGroupIdentity(options.identity),
  );
  const identity = ownerIdentity(options.pluginName, artifactKey, 'codex', options.scope);
  return {
    ...options.identity,
    command: `${OWNED_TEXT_HEADER_PREFIX}${JSON.stringify({ schemaVersion: 1, ...identity })}\n${options.identity.command}`,
  };
}

function readOwnedHookPlugin(
  identity: TrackedHookGroupIdentity,
  scope: Scope,
): string | null {
  try {
    const parsed = parseOwnedTextHeader(identity.command);
    return parsed?.identity.platform === 'codex' && parsed.identity.scope === scope
      ? parsed.identity.plugin
      : null;
  } catch {
    return null;
  }
}

async function scanCodexSharedComponents(options: {
  pluginName: string;
  scope: Scope;
  paths: ReturnType<typeof resolveCodexPaths>;
  scanConfig: boolean;
  scanHooks: boolean;
  ignoreReadErrors?: boolean;
}): Promise<OwnedComponent[]> {
  const output: OwnedComponent[] = [];
  const corruptedComponent = (filePath: string, error: unknown): OwnedComponent => ({
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('corrupted-shared-config', filePath),
      'codex',
      options.scope,
    ),
    label: filePath,
    inspect: async () => {
      throw new Error(
        `包含 ${options.pluginName} 的 AW ownership 证据，但共享配置无法解析：${error instanceof Error ? error.message : String(error)}`,
      );
    },
    remove: async () => undefined,
  });
  const containsOwnedEvidence = (raw: string): boolean => raw.includes(options.pluginName) && (
    raw.includes('[[aw-managed:start plugin=')
    || raw.includes(MCP_OWNER_ENV)
    || raw.includes(OWNED_TEXT_HEADER_PREFIX)
    || raw.includes('agent-workflows')
  );
  if (options.scanConfig) {
    const config = await readCodexConfigFile(options.paths.configTomlPath).catch(async (error) => {
      if (!options.ignoreReadErrors) throw error;
      const raw = await fs.readFile(options.paths.configTomlPath, 'utf8').catch(() => '');
      if (containsOwnedEvidence(raw)) {
        output.push(corruptedComponent(options.paths.configTomlPath, error));
      }
      return null;
    });
    if (config?.snapshot.developerInstructions.managedBlocks[options.pluginName]) {
      output.push(createCodexInstructionComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        configPath: options.paths.configTomlPath,
      }));
    }
    for (const [serverKey, server] of Object.entries(config?.snapshot.mcpServers ?? {})) {
      const envValue = server.value?.env;
      if (
        envValue
        && typeof envValue === 'object'
        && !Array.isArray(envValue)
        && envValue[MCP_OWNER_ENV] === options.pluginName
      ) {
        output.push(createCodexMcpComponent({
          pluginName: options.pluginName,
          scope: options.scope,
          configPath: options.paths.configTomlPath,
          serverKey,
          owned: true,
        }));
      }
    }
    for (const [roleKey, registration] of Object.entries(config?.snapshot.agents ?? {})) {
      if (!registration.configFile) continue;
      const rolePath = path.resolve(path.dirname(options.paths.configTomlPath), registration.configFile);
      const raw = await fs.readFile(rolePath, 'utf8').catch(() => '');
      const parsed = (() => {
        try { return parseOwnedTextHeader(raw); } catch { return null; }
      })();
      if (parsed?.identity.plugin !== options.pluginName) continue;
      output.push(createCodexRoleRegistrationComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        configPath: options.paths.configTomlPath,
        roleKey,
        rolePath,
      }));
    }
  }
  if (options.scope === 'project' && options.scanHooks) {
    const hooks = await readCodexHooks(options.paths.hooksPath).catch(async (error) => {
      if (!options.ignoreReadErrors) throw error;
      const raw = await fs.readFile(options.paths.hooksPath, 'utf8').catch(() => '');
      if (containsOwnedEvidence(raw)) {
        output.push(corruptedComponent(options.paths.hooksPath, error));
      }
      return null;
    });
    for (const identity of hooks?.managedIdentities ?? []) {
      if (readOwnedHookPlugin(identity, options.scope) !== options.pluginName) continue;
      output.push(createCodexHookComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        hooksPath: options.paths.hooksPath,
        identity,
      }));
    }
  }
  return output;
}

async function scanClaudeSharedComponents(options: {
  pluginName: string;
  scope: Scope;
  settingsPath: string;
}): Promise<OwnedComponent[]> {
  const settings = await readClaudeSettings(options.settingsPath);
  return settings.awGenerated?.permissions?.[options.pluginName]
    ? [createClaudePermissionsComponent(options)]
    : [];
}

function hasCodexSharedConfigCapability(plugin: PluginMeta, scope: Scope): boolean {
  return Boolean(
    plugin.manifest.mcpServers
    || resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex').length > 0
    || (plugin.manifest.artifacts?.targets ?? []).some((target) =>
      target.platform === 'codex'
      && target.scopes.includes(scope)
      && (
        target.target === 'codex.agentRole'
        || target.target === 'codex.developerInstructionsBlock'
      )),
  );
}

function hasCodexHookCapability(plugin: PluginMeta, scope: Scope): boolean {
  return scope === 'project'
    && resolvePlatformHookDefinitions(plugin.manifest, 'codex').length > 0;
}

async function scanOwnedTextFiles(options: {
  root: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
}): Promise<OwnedComponent[]> {
  if (!await fs.pathExists(options.root)) return [];
  const output: OwnedComponent[] = [];
  const pending = [options.root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const raw = await fs.readFile(entryPath, 'utf8').catch(() => '');
      if (!raw.includes(OWNED_TEXT_HEADER_PREFIX)) continue;
      let parsed: ReturnType<typeof parseOwnedTextHeader>;
      try {
        parsed = parseOwnedTextHeader(raw);
      } catch {
        continue;
      }
      if (
        parsed?.identity.plugin !== options.pluginName
        || parsed.identity.platform !== options.platform
        || parsed.identity.scope !== options.scope
      ) continue;
      output.push(pathComponent({
        kind: 'owned-text-file',
        path: entryPath,
        allowedRoot: options.root,
        identity: parsed.identity,
      }));
    }
  }
  return output;
}

async function scanOwnedSkills(options: {
  root: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
}): Promise<OwnedComponent[]> {
  if (!await fs.pathExists(options.root)) return [];
  const output: OwnedComponent[] = [];
  for (const entry of await fs.readdir(options.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillRoot = path.join(options.root, entry.name);
    const marker = await readSkillOwnerMarker({
      skillRoot,
      allowedRoot: options.root,
    }).catch(() => null);
    if (
      marker?.plugin !== options.pluginName
      || marker.platform !== options.platform
      || marker.scope !== options.scope
    ) continue;
    output.push(pathComponent({
      kind: 'skill-directory',
      path: skillRoot,
      allowedRoot: options.root,
      identity: marker,
    }));
  }
  return output;
}

function componentIdentityKey(component: OwnedComponent): string {
  return [
    component.kind,
    component.identity.artifactKey,
    'path' in component ? path.resolve(component.path) : 'label' in component ? component.label : component.pluginId,
  ].join('\0');
}

function dedupeComponents(components: OwnedComponent[]): OwnedComponent[] {
  const seen = new Set<string>();
  return components.filter((component) => {
    const key = componentIdentityKey(component);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function preflightCodexWriteSafety(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const pluginName = options.plugin.manifest.name;
  const userConfigPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const projectConfigPath = resolveCodexPaths(options.cwd, 'project', options.env).configTomlPath;
  let userConfig: Awaited<ReturnType<typeof readCodexConfigFile>>;
  try {
    userConfig = await readCodexConfigFile(userConfigPath);
  } catch (error) {
    throw new Error(
      `codexProjectUserConfigUnreadable: 无法解析用户级 Codex 配置 ${userConfigPath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (options.scope === 'project') {
    for (const [key, plugin] of Object.entries(userConfig.snapshot.plugins)) {
      if (
        key !== `${pluginName}@${MARKETPLACE_NAME}`
        && (key === pluginName || key.startsWith(`${pluginName}@`) || plugin.name === pluginName)
      ) {
        throw new Error(`externalOwnershipPresent: 用户级 Codex 已存在同名外部插件 ${key}。`);
      }
    }
  }

  const roleKeys = new Set(
    (options.plugin.manifest.artifacts?.targets ?? [])
      .filter((target) =>
        target.platform === 'codex'
        && target.scopes.includes(options.scope)
        && target.target === 'codex.agentRole'
        && target.roleKey)
      .map((target) => target.roleKey!),
  );
  const needsProjectConfig = options.scope === 'project' && Boolean(
    options.plugin.manifest.mcpServers
    || resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'codex').length > 0
    || (options.plugin.manifest.artifacts?.targets ?? []).some((target) =>
      target.platform === 'codex'
      && target.scopes.includes('project')
      && (
        target.target === 'codex.agentRole'
        || target.target === 'codex.developerInstructionsBlock'
      )),
  );
  if (needsProjectConfig) {
    try {
      await readCodexConfigFile(projectConfigPath);
    } catch (error) {
      throw new Error(
        `projectConfigUnreadable: 无法解析项目级 Codex 配置 ${projectConfigPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (roleKeys.size === 0) return;

  for (const configPath of options.scope === 'project'
    ? [userConfigPath, projectConfigPath]
    : [userConfigPath]) {
    const configScope: Scope = configPath === userConfigPath ? 'user' : 'project';
    const ownedRolePaths: string[] = [];
    const ownedRoleKeys: string[] = [];
    for (const roleKey of roleKeys) {
      const rolePath = path.join(
        path.dirname(configPath),
        'agents',
        `${buildGeneratedName(pluginName, roleKey)}.toml`,
      );
      const raw = await fs.readFile(rolePath, 'utf8').catch(() => '');
      try {
        if (parseOwnedTextHeader(raw, ownerIdentity(pluginName, roleKey, 'codex', configScope))) {
          ownedRolePaths.push(rolePath);
          ownedRoleKeys.push(roleKey);
        }
      } catch {
        // A foreign file remains external below.
      }
    }
    let namespace: Awaited<ReturnType<typeof resolveCodexRoleNamespace>>;
    try {
      namespace = await resolveCodexRoleNamespace(configPath, {
        strict: true,
        awManagedTableKeys: ownedRoleKeys,
        awManagedRoleLayerPaths: ownedRolePaths,
      });
    } catch (error) {
      throw new Error(
        `projectConfigUnreadable: 无法读取 Codex role namespace ${configPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const roleKey of roleKeys) {
      const tableCollision = namespace.roles.find((role) =>
        role.source === 'registration' && role.tableKey === roleKey && !role.awManaged);
      const nameConflict = findCodexRoleNameConflict(namespace, roleKey);
      if (tableCollision || nameConflict?.conflict) {
        throw new Error(`roleNameConflict: Codex role "${roleKey}" 已由外部配置占用（${configPath}）。`);
      }
    }
  }
}

function renderCodexRole(options: {
  roleKey: string;
  description: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: string;
}): string {
  const stringValue = (value: string): string => JSON.stringify(value.trim());
  return [
    `name = ${stringValue(options.roleKey)}`,
    `description = ${stringValue(options.description)}`,
    `developer_instructions = ${stringValue(options.developerInstructions)}`,
    ...(options.model ? [`model = ${stringValue(options.model)}`] : []),
    ...(options.modelReasoningEffort
      ? [`model_reasoning_effort = ${stringValue(options.modelReasoningEffort)}`]
      : []),
    '',
  ].join('\n');
}

async function resolveCodexMcpServers(plugin: PluginMeta): Promise<Record<string, CodexMcpServerConfig>> {
  if (!plugin.manifest.mcpServers) return {};
  const relative = plugin.manifest.mcpServers.replace(/^\.\//u, '');
  const direct = path.resolve(plugin.rootDir, relative);
  const mcpPath = await fs.pathExists(direct)
    ? direct
    : path.resolve(plugin.rootDir, 'codex', relative);
  const servers = await readRenderedCodexMcpServersFile(mcpPath);
  return Object.fromEntries(Object.entries(servers).map(([key, server]) => {
    const existingEnv = server.env;
    if (existingEnv !== undefined && (typeof existingEnv !== 'object' || Array.isArray(existingEnv))) {
      throw new Error(`MCP server ${key} 的 env 必须是 object。`);
    }
    const env = (existingEnv ?? {}) as Record<string, string | boolean | number>;
    if (env[MCP_OWNER_ENV] !== undefined && env[MCP_OWNER_ENV] !== plugin.manifest.name) {
      throw new Error(`MCP server ${key} 不能覆盖保留的 ${MCP_OWNER_ENV} owner marker。`);
    }
    return [key, {
      ...server,
      env: { ...env, [MCP_OWNER_ENV]: plugin.manifest.name },
    }];
  }));
}

async function resolveDynamicArtifacts(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  event: 'install' | 'upgrade';
  previousArtifacts: readonly GeneratedArtifact[];
  scriptTimeoutMs?: number;
}): Promise<{
  artifacts: ValidatedArtifactPlanArtifact[];
  sourceDirs(artifact: ValidatedArtifactPlanArtifact): string[];
}> {
  const declarations = (options.plugin.manifest.artifacts?.targets ?? []).filter(
    (target) => target.platform === options.platform && target.scopes.includes(options.scope),
  );
  if (declarations.length === 0) return { artifacts: [], sourceDirs: () => [] };
  const render = await runArtifactRenderer({
    event: options.event,
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    commandEnv: options.env,
    previousArtifacts: [...options.previousArtifacts],
    scriptTimeoutMs: options.scriptTimeoutMs,
  });
  const config = await resolveArtifactRenderConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const artifacts = validateArtifactPlan({
    manifest: options.plugin.manifest,
    plan: render.plan,
    platform: options.platform,
    scope: options.scope,
    renderConfig: config,
    rendererDigest: render.target.rendererDigest!,
    manifestDigest: render.target.manifestDigest!,
  }).artifacts;
  return {
    artifacts,
    sourceDirs: (artifact) => render.context.artifactSources.find((entry) =>
      entry.id === artifact.id && entry.target === artifact.target)?.sourceDirs ?? [],
  };
}

function dynamicSkillWrite(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  artifact: ValidatedArtifactPlanArtifact;
  skillPath: string;
  allowedRoot: string;
  tree: DynamicSkillTree;
}): PlannedWrite {
  const skillKey = 'skillKey' in options.artifact ? options.artifact.skillKey! : '';
  const identity = ownerIdentity(
    options.plugin.manifest.name,
    skillKey,
    options.platform,
    options.scope,
  );
  const component = pathComponent({
    kind: 'skill-directory',
    path: options.skillPath,
    allowedRoot: options.allowedRoot,
    identity,
  });
  return {
    artifact: {
      path: options.skillPath,
      paths: Object.keys(options.tree.files).map((relativePath) =>
        path.join(options.skillPath, relativePath.split('/').join(path.sep))),
      kind: 'skill',
      platform: options.platform,
      artifactKey: skillKey,
      id: options.artifact.id,
      target: options.artifact.target,
      state: options.artifact.state,
      ...(options.artifact.disabledReason
        ? { disabledReason: options.artifact.disabledReason }
        : {}),
      refreshKeys: [...options.artifact.refreshKeys],
      configDigest: options.artifact.configDigest,
      contentDigest: options.platform === 'codex'
        ? createCodexSkillStagingTreeContentDigest(options.tree)
        : createDynamicSkillTreeContentDigest(options.tree),
    },
    ...(options.artifact.state === 'present' ? { component } : {}),
    write: async () => {
      if (options.artifact.state === 'disabled') {
        return;
      }
      await writeDynamicSkillTree(options.skillPath, options.tree, {
        allowedRoot: options.allowedRoot,
        identity,
      });
    },
  };
}

async function resolveCodexSkillsRelativeRoot(
  plugin: PluginMeta,
  marketplaceFallbackRoot?: string,
): Promise<string> {
  const manifestPaths = [
    path.join(plugin.rootDir, '.codex-plugin', 'plugin.json'),
    ...(marketplaceFallbackRoot
      ? [path.join(marketplaceFallbackRoot, '.codex-plugin', 'plugin.json')]
      : []),
  ];
  let manifest: Record<string, unknown> | null = null;
  for (const manifestPath of manifestPaths) {
    manifest = await fs.readJson(manifestPath).catch(() => null) as Record<string, unknown> | null;
    if (manifest) break;
  }
  const raw = typeof manifest?.skills === 'string' && manifest.skills.trim() !== ''
    ? manifest.skills
    : plugin.manifest.skills ?? './codex/skills';
  const normalized = path.posix.normalize(raw.replace(/^\.\//u, ''));
  if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error(`Codex plugin skills root 越界：${raw}`);
  }
  return normalized;
}

async function buildBundledCodexSkillWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<PlannedWrite[]> {
  const relativeRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const sourceRoot = path.join(options.plugin.rootDir, ...relativeRoot.split('/'));
  if (!await fs.pathExists(sourceRoot)) return [];
  const dynamicKeys = new Set(
    (options.plugin.manifest.artifacts?.targets ?? [])
      .filter((target) => target.target === 'codex.skill' && target.skillKey)
      .map((target) => target.skillKey!),
  );
  const targetRoot = options.scope === 'project'
    ? path.join(options.repoRoot, '.agents', 'skills')
    : path.join(resolveAwHome(options.env), 'plugins', options.plugin.manifest.name, ...relativeRoot.split('/'));
  const writes: PlannedWrite[] = [];
  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Codex skills source 不能包含符号链接：${entry.name}`);
    }
    if (!entry.isDirectory() || dynamicKeys.has(entry.name)) continue;
    const skillSource = path.join(sourceRoot, entry.name);
    if (!await fs.pathExists(path.join(skillSource, 'SKILL.md'))) continue;
    const tree = await createCodexSkillExpectedTree({
      artifact: {
        target: 'codex.skill',
        skillKey: entry.name,
        state: 'present',
        content: { files: {} },
      },
      sourceDirs: [skillSource],
    });
    const skillPath = path.join(targetRoot, entry.name);
    const identity = ownerIdentity(
      options.plugin.manifest.name,
      entry.name,
      'codex',
      options.scope,
    );
    const component = pathComponent({
      kind: 'skill-directory',
      path: skillPath,
      allowedRoot: targetRoot,
      identity,
    });
    writes.push({
      artifact: {
        path: skillPath,
        paths: Object.keys(tree.files).map((relativePath) => path.join(skillPath, relativePath)),
        kind: 'skill',
        platform: 'codex',
        artifactKey: entry.name,
      },
      component,
      write: async () => {
        await writeDynamicSkillTree(skillPath, tree, { allowedRoot: targetRoot, identity });
      },
    });
  }
  return writes;
}

async function buildClaudeWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  event: 'install' | 'upgrade';
  historicalArtifacts: readonly GeneratedArtifact[];
  scriptTimeoutMs?: number;
}): Promise<PlannedWrite[]> {
  const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
  const writes: PlannedWrite[] = [];
  const dynamic = await resolveDynamicArtifacts({
    ...options,
    platform: 'claude',
    previousArtifacts: options.historicalArtifacts,
  });
  for (const artifact of dynamic.artifacts.filter((entry) => entry.target === 'claude.skill')) {
    const skillKey = artifact.skillKey!;
    const tree = await createDynamicSkillExpectedTree({
      artifact,
      sourceDirs: dynamic.sourceDirs(artifact),
    });
    writes.push(dynamicSkillWrite({
      ...options,
      platform: 'claude',
      artifact,
      skillPath: path.join(paths.configDir, 'skills', skillKey),
      allowedRoot: path.join(paths.configDir, 'skills'),
      tree,
    }));
  }
  for (const artifact of generateInstructionArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'claude'),
    'claude',
  )) {
    writes.push(generatedTextWrite({
      ...options,
      platform: 'claude',
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'instruction',
    }));
  }
  const permissions = resolvePlatformEntries(
    options.plugin.manifest.extensions?.permissions,
    'claude',
  );
  if (permissions.length > 0) {
    const component = createClaudePermissionsComponent({
      pluginName: options.plugin.manifest.name,
      scope: options.scope,
      settingsPath: paths.settingsPath,
    });
    writes.push({
      artifact: { path: paths.settingsPath, kind: 'permission', platform: 'claude' },
      component,
      write: async () => {
        const settings = await readClaudeSettings(paths.settingsPath);
        rebuildClaudePermissions(
          settings,
          options.plugin.manifest.name,
          mergeClaudePermissions(permissions),
        );
        await writeClaudeSettings(paths.settingsPath, settings);
      },
    });
  }
  return writes;
}

async function buildCodexWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  event: 'install' | 'upgrade';
  historicalArtifacts: readonly GeneratedArtifact[];
  scriptTimeoutMs?: number;
}): Promise<PlannedWrite[]> {
  const paths = resolveCodexPaths(options.cwd, options.scope, options.env);
  const writes: PlannedWrite[] = [];
  const dynamic = await resolveDynamicArtifacts({
    ...options,
    platform: 'codex',
    previousArtifacts: options.historicalArtifacts,
  });
  const dynamicInstructions = dynamic.artifacts.filter(
    (entry) => entry.target === 'codex.developerInstructionsBlock',
  );
  const dynamicRoles = dynamic.artifacts.filter((entry) => entry.target === 'codex.agentRole');
  const dynamicSkills = dynamic.artifacts.filter((entry) => entry.target === 'codex.skill');
  const repoRoot = await resolveRepoRoot(options.cwd);
  writes.push(...await buildBundledCodexSkillWrites({
    plugin: options.plugin,
    scope: options.scope,
    repoRoot,
    env: options.env,
  }));
  const relativeSkillsRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const skillRoot = options.scope === 'user'
    ? path.join(
        resolveAwHome(options.env),
        'plugins',
        options.plugin.manifest.name,
        ...relativeSkillsRoot.split('/'),
      )
    : path.join(repoRoot, '.agents', 'skills');
  for (const artifact of dynamicSkills) {
    const tree = await createCodexSkillExpectedTree({
      artifact,
      sourceDirs: dynamic.sourceDirs(artifact),
    });
    writes.push(dynamicSkillWrite({
      ...options,
      platform: 'codex',
      artifact,
      skillPath: path.join(skillRoot, artifact.skillKey!),
      allowedRoot: skillRoot,
      tree,
    }));
  }

  const staticInstructions = dynamicInstructions.length > 0
    ? []
    : resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'codex');
  const mcpServers = await resolveCodexMcpServers(options.plugin);
  const hasInstructionOutput = dynamicInstructions.length > 0 || staticInstructions.length > 0;
  if (hasInstructionOutput) {
    const component = createCodexInstructionComponent({
      pluginName: options.plugin.manifest.name,
      scope: options.scope,
      configPath: paths.configTomlPath,
    });
    const dynamicBlock = dynamicInstructions.length > 0
      ? composeManagedDeveloperInstructionsBlock(
          options.plugin.manifest.name,
          dynamicInstructions
            .filter((entry) => entry.state === 'present')
            .map((entry) => ({ artifactId: entry.id, value: entry.content! })),
        )
      : undefined;
    const block = dynamicBlock?.value
      ? dynamicBlock
      : staticInstructions.length > 0
        ? {
            pluginName: options.plugin.manifest.name,
            value: renderCodexManagedInstructionBlock(
              options.plugin.manifest.name,
              staticInstructions,
            ),
          }
        : undefined;
    for (const artifact of dynamicInstructions.length > 0 ? dynamicInstructions : [{
      id: undefined,
      target: undefined,
      state: 'present' as const,
      refreshKeys: [] as string[],
      configDigest: undefined,
      disabledReason: undefined,
    }]) {
      writes.push({
        artifact: {
          path: paths.configTomlPath,
          kind: 'instruction',
          platform: 'codex',
          ...(artifact.id ? { id: artifact.id } : {}),
          ...(artifact.target ? { target: artifact.target } : {}),
          state: artifact.state,
          refreshKeys: [...artifact.refreshKeys],
          ...(artifact.configDigest ? { configDigest: artifact.configDigest } : {}),
          ...(artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
        },
        ...(block ? { component } : {}),
        write: async () => {
          await applyCodexConfigTransactionFile(paths.configTomlPath, block
            ? { upsertManagedInstructionBlock: block }
            : { removeManagedInstructionPluginName: options.plugin.manifest.name });
        },
      });
    }
  }

  for (const [serverKey, server] of Object.entries(mcpServers)) {
    const component = createCodexMcpComponent({
      pluginName: options.plugin.manifest.name,
      scope: options.scope,
      configPath: paths.configTomlPath,
      serverKey,
      owned: false,
    });
    writes.push({
      artifact: {
        path: paths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: serverKey,
      },
      component,
      write: async () => {
        await applyCodexConfigTransactionFile(paths.configTomlPath, {
          upsertMcpServers: { [serverKey]: server },
        });
        component.authorize();
      },
    });
  }

  for (const artifact of dynamicRoles) {
    const roleKey = artifact.roleKey!;
    const rolePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(options.plugin.manifest.name, roleKey)}.toml`,
    );
    const roleComponent = pathComponent({
      kind: 'owned-text-file',
      path: rolePath,
      allowedRoot: paths.configDir,
      identity: ownerIdentity(options.plugin.manifest.name, roleKey, 'codex', options.scope),
    });
    const registrationComponent = createCodexRoleRegistrationComponent({
      pluginName: options.plugin.manifest.name,
      scope: options.scope,
      configPath: paths.configTomlPath,
      roleKey,
      rolePath,
    });
    const roleFile = artifact.content?.roleFile;
    const description = artifact.content?.registration?.description
      ?? roleFile?.description;
    const present = artifact.state === 'present';
    if (present && (!description || !roleFile?.developer_instructions)) {
      throw new Error(`Artifact "${artifact.id}" 的 codex.agentRole 缺少 description 或 developer_instructions。`);
    }
    writes.push({
      artifact: {
        path: rolePath,
        paths: [paths.configTomlPath, rolePath],
        kind: 'agent',
        platform: 'codex',
        artifactKey: roleKey,
        roleKey,
        id: artifact.id,
        target: artifact.target,
        state: artifact.state,
        refreshKeys: [...artifact.refreshKeys],
        configDigest: artifact.configDigest,
        ...(artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
      },
      ...(present ? { component: roleComponent } : {}),
      ...(present ? { additionalComponents: [registrationComponent] } : {}),
      write: async () => {
        if (!present) {
          return;
        }
        await fs.ensureDir(paths.configDir);
        await writeOwnedTextFile({
          path: rolePath,
          allowedRoot: paths.configDir,
          identity: roleComponent.identity,
          content: renderCodexRole({
            roleKey,
            description: description!,
            developerInstructions: roleFile!.developer_instructions!,
            model: roleFile!.model,
            modelReasoningEffort: roleFile!.model_reasoning_effort,
          }),
        });
        const registration: CodexAgentRegistrationConfig = {
          description,
          configFile: path.relative(path.dirname(paths.configTomlPath), rolePath).split(path.sep).join('/'),
        };
        await applyCodexConfigTransactionFile(paths.configTomlPath, {
          upsertAgentRegistrations: { [roleKey]: registration },
        });
      },
    });
  }

  for (const artifact of generateCodexPermissionArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.permissions, 'codex'),
  )) {
    writes.push(generatedTextWrite({
      ...options,
      platform: 'codex',
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'permission',
    }));
  }
  for (const artifact of generateAgentArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.agents, 'codex'),
    'codex',
  )) {
    writes.push(generatedTextWrite({
      ...options,
      platform: 'codex',
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'agent',
    }));
  }

  if (options.scope === 'project') {
    const hooks = resolvePlatformHookDefinitions(options.plugin.manifest, 'codex');
    for (const rawIdentity of extractCodexHookGroups(hooks)) {
      const identity = ownedCodexHookIdentity({
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        identity: rawIdentity,
      });
      const component = createCodexHookComponent({
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        hooksPath: paths.hooksPath,
        identity,
      });
      writes.push({
        artifact: {
          path: paths.hooksPath,
          kind: 'hook',
          platform: 'codex',
          hookGroups: [identity],
        },
        component,
        write: async () => {
          const parsed = await readCodexHooks(paths.hooksPath);
          const serialized = serializeTrackedHookGroupIdentity(identity);
          const exists = parsed.managedIdentities.some((entry) =>
            serializeTrackedHookGroupIdentity(entry) === serialized);
          const groups = parsed.rawGroups;
          if (!exists) groups.push(renderCodexSharedHookGroup(identity));
          await writeCodexHookGroups(paths.hooksPath, groups);
        },
      });
    }
  }
  return writes;
}

async function buildInspectionWrites(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<PlannedWrite[]> {
  const writes: PlannedWrite[] = [];
  if (options.platform === 'claude') {
    const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
    for (const artifact of generateInstructionArtifacts(
      options.plugin.manifest.name,
      resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'claude'),
      'claude',
    )) {
      writes.push(generatedTextWrite({
        ...options,
        configDir: paths.configDir,
        relativePath: artifact.relativePath,
        artifactKey: artifact.artifactKey!,
        content: artifact.content,
        kind: 'instruction',
      }));
    }
    if (resolvePlatformEntries(options.plugin.manifest.extensions?.permissions, 'claude').length > 0) {
      writes.push({
        artifact: { path: paths.settingsPath, kind: 'permission', platform: 'claude' },
        component: createClaudePermissionsComponent({
          pluginName: options.plugin.manifest.name,
          scope: options.scope,
          settingsPath: paths.settingsPath,
        }),
        write: async () => undefined,
      });
    }
    for (const target of options.plugin.manifest.artifacts?.targets ?? []) {
      if (
        target.platform !== 'claude'
        || !target.scopes.includes(options.scope)
        || target.target !== 'claude.skill'
        || !target.skillKey
      ) continue;
      const state = target.states.includes('present') ? 'present' : 'disabled';
      const skillPath = path.join(paths.configDir, 'skills', target.skillKey);
      const component = pathComponent({
        kind: 'skill-directory',
        path: skillPath,
        allowedRoot: path.dirname(skillPath),
        identity: ownerIdentity(
          options.plugin.manifest.name,
          target.skillKey,
          'claude',
          options.scope,
        ),
      });
      writes.push({
        artifact: {
          path: skillPath,
          kind: 'skill',
          platform: 'claude',
          artifactKey: target.skillKey,
          id: target.id,
          target: target.target,
          state,
        },
        ...(state === 'present' ? { component } : {}),
        ...(target.states.includes('present') && target.states.includes('disabled')
          ? { optional: true }
          : {}),
        write: async () => undefined,
      });
    }
    return writes;
  }

  const paths = resolveCodexPaths(options.cwd, options.scope, options.env);
  const repoRoot = await resolveRepoRoot(options.cwd);
  writes.push(...await buildBundledCodexSkillWrites({
    plugin: options.plugin,
    scope: options.scope,
    repoRoot,
    env: options.env,
  }));
  const instructions = resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'codex');
  const targets = (options.plugin.manifest.artifacts?.targets ?? []).filter((target) =>
    target.platform === 'codex' && target.scopes.includes(options.scope));
  const instructionTargets = targets.filter((target) =>
    target.target === 'codex.developerInstructionsBlock');
  const presentCapableInstructionTargets = instructionTargets.filter((target) =>
    target.states.includes('present'));
  const instructionDesired = presentCapableInstructionTargets.length > 0;
  const instructionOptional = presentCapableInstructionTargets.length > 0
    && presentCapableInstructionTargets.every((target) => target.states.includes('disabled'));
  if (instructions.length > 0 || instructionDesired) {
    writes.push({
      artifact: { path: paths.configTomlPath, kind: 'instruction', platform: 'codex' },
      component: createCodexInstructionComponent({
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        configPath: paths.configTomlPath,
      }),
      ...(instructions.length === 0 && instructionOptional ? { optional: true } : {}),
      write: async () => undefined,
    });
  }
  const mcpServers = await resolveCodexMcpServers(options.plugin);
  for (const serverKey of Object.keys(mcpServers)) {
    writes.push({
      artifact: {
        path: paths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: serverKey,
      },
      component: createCodexMcpComponent({
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        configPath: paths.configTomlPath,
        serverKey,
        owned: false,
      }),
      write: async () => undefined,
    });
  }
  const relativeSkillsRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const dynamicSkillRoot = options.scope === 'user'
    ? path.join(resolveAwHome(options.env), 'plugins', options.plugin.manifest.name, ...relativeSkillsRoot.split('/'))
    : path.join(repoRoot, '.agents', 'skills');
  for (const target of targets) {
    const state = target.states.includes('present') ? 'present' : 'disabled';
    if (target.target === 'codex.skill' && target.skillKey) {
      const skillPath = path.join(dynamicSkillRoot, target.skillKey);
      const component = pathComponent({
        kind: 'skill-directory',
        path: skillPath,
        allowedRoot: dynamicSkillRoot,
        identity: ownerIdentity(options.plugin.manifest.name, target.skillKey, 'codex', options.scope),
      });
      writes.push({
        artifact: {
          path: skillPath,
          kind: 'skill',
          platform: 'codex',
          artifactKey: target.skillKey,
          id: target.id,
          target: target.target,
          state,
        },
        ...(state === 'present' ? { component } : {}),
        ...(target.states.includes('present') && target.states.includes('disabled')
          ? { optional: true }
          : {}),
        write: async () => undefined,
      });
    }
    if (target.target === 'codex.agentRole' && target.roleKey) {
      const rolePath = path.join(
        paths.configDir,
        'agents',
        `${buildGeneratedName(options.plugin.manifest.name, target.roleKey)}.toml`,
      );
      const roleComponent = pathComponent({
        kind: 'owned-text-file',
        path: rolePath,
        allowedRoot: paths.configDir,
        identity: ownerIdentity(options.plugin.manifest.name, target.roleKey, 'codex', options.scope),
      });
      const registrationComponent = createCodexRoleRegistrationComponent({
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        configPath: paths.configTomlPath,
        roleKey: target.roleKey,
        rolePath,
      });
      writes.push({
        artifact: {
          path: rolePath,
          kind: 'agent',
          platform: 'codex',
          artifactKey: target.roleKey,
          roleKey: target.roleKey,
          id: target.id,
          target: target.target,
          state,
        },
        ...(state === 'present'
          ? { component: roleComponent, additionalComponents: [registrationComponent] }
          : {}),
        ...(target.states.includes('present') && target.states.includes('disabled')
          ? { optional: true }
          : {}),
        write: async () => undefined,
      });
    }
  }
  for (const artifact of generateCodexPermissionArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.permissions, 'codex'),
  )) {
    writes.push(generatedTextWrite({
      ...options,
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'permission',
    }));
  }
  for (const artifact of generateAgentArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.agents, 'codex'),
    'codex',
  )) {
    writes.push(generatedTextWrite({
      ...options,
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'agent',
    }));
  }
  if (options.scope === 'project') {
    for (const rawIdentity of extractCodexHookGroups(
      resolvePlatformHookDefinitions(options.plugin.manifest, 'codex'),
    )) {
      const identity = ownedCodexHookIdentity({
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        identity: rawIdentity,
      });
      writes.push({
        artifact: {
          path: paths.hooksPath,
          kind: 'hook',
          platform: 'codex',
          hookGroups: [identity],
        },
        component: createCodexHookComponent({
          pluginName: options.plugin.manifest.name,
          scope: options.scope,
          hooksPath: paths.hooksPath,
          identity,
        }),
        write: async () => undefined,
      });
    }
  }
  return writes;
}

async function buildHistoricalComponents(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifacts: readonly GeneratedArtifact[];
}): Promise<OwnedComponent[]> {
  const components: OwnedComponent[] = [];
  const paths = options.platform === 'codex'
    ? resolveCodexPaths(options.cwd, options.scope, options.env)
    : resolveClaudePaths(options.cwd, options.scope, options.env);
  for (const artifact of options.artifacts) {
    if (artifact.platform !== options.platform) continue;
    if (artifact.state === 'disabled') continue;
    if (artifact.kind === 'hook' && options.platform === 'codex') {
      for (const identity of artifact.hookGroups ?? []) {
        components.push(createCodexHookComponent({
          pluginName: options.pluginName,
          scope: options.scope,
          hooksPath: resolveCodexPaths(options.cwd, options.scope, options.env).hooksPath,
          identity,
        }));
      }
      continue;
    }
    if (artifact.kind === 'mcpServer' && options.platform === 'codex' && artifact.artifactKey) {
      components.push(createCodexMcpComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        configPath: resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
        serverKey: artifact.artifactKey,
        owned: false,
      }));
      continue;
    }
    if (artifact.kind === 'instruction' && options.platform === 'codex' && !artifact.artifactKey) {
      components.push(createCodexInstructionComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        configPath: resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
      }));
      continue;
    }
    if (artifact.kind === 'permission' && options.platform === 'claude') {
      components.push(createClaudePermissionsComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        settingsPath: resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath,
      }));
      continue;
    }
    if (
      artifact.target === 'codex.agentRole'
      && options.platform === 'codex'
      && (artifact.roleKey || artifact.artifactKey)
    ) {
      const roleKey = artifact.roleKey ?? artifact.artifactKey!;
      components.push(createCodexRoleRegistrationComponent({
        pluginName: options.pluginName,
        scope: options.scope,
        configPath: resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
        roleKey,
        rolePath: artifact.path,
      }));
    }
    if (!artifact.artifactKey) continue;
    const identity = ownerIdentity(
      options.pluginName,
      artifact.artifactKey,
      options.platform,
      options.scope,
    );
    components.push(pathComponent({
      kind: artifact.kind === 'skill' ? 'skill-directory' : 'owned-text-file',
      path: artifact.path,
      allowedRoot: artifact.kind === 'skill' ? path.dirname(artifact.path) : paths.configDir,
      identity,
    }));
  }
  return components;
}

function outputContainsPluginId(output: string, pluginId: string): boolean {
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?=$|[^A-Za-z0-9_.-])`, 'mu').test(output);
}

async function inspectCodexNativeResidue(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ present: boolean; labels: string[] }> {
  const pluginId = `${options.pluginName}@${MARKETPLACE_NAME}`;
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const config = await readCodexConfigFile(configPath);
  const cacheRoot = path.join(
    getCodexHome(options.env),
    'plugins',
    'cache',
    MARKETPLACE_NAME,
    options.pluginName,
  );
  const installedManifest = path.join(
    getCodexHome(options.env),
    'plugins',
    pluginId,
    'manifest.json',
  );
  const labels = [
    ...(config.snapshot.plugins[pluginId] ? [`${configPath}#plugins.${pluginId}`] : []),
    ...(await fs.lstat(cacheRoot).then(() => true).catch(() => false) ? [cacheRoot] : []),
    ...(await fs.lstat(installedManifest).then(() => true).catch(() => false)
      ? [installedManifest]
      : []),
  ];
  return { present: labels.length > 0, labels };
}

async function discoverCodexNativeResidueNames(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const names = new Set<string>();
  const config = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  for (const pluginId of Object.keys(config.snapshot.plugins)) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)@aw$/u.exec(pluginId);
    if (match) names.add(match[1]!);
  }
  const cacheRoot = path.join(getCodexHome(options.env), 'plugins', 'cache', MARKETPLACE_NAME);
  for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name)) names.add(entry.name);
  }
  const pluginsRoot = path.join(getCodexHome(options.env), 'plugins');
  for (const entry of await fs.readdir(pluginsRoot, { withFileTypes: true }).catch(() => [])) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)@aw$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, 'manifest.json');
    const stats = await fs.lstat(manifestPath).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) continue;
    const manifest = await fs.readJson(manifestPath).catch(() => null) as Record<string, unknown> | null;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const identity = manifest.id ?? manifest.name;
    if (
      (identity === match[1] || identity === entry.name)
      && typeof manifest.version === 'string'
      && manifest.version.trim() !== ''
    ) names.add(match[1]!);
  }
  return [...names];
}

async function ensureCodexActiveSkillsManifest(options: {
  plugin: PluginMeta;
  marketplaceRoot: string;
  hasRequiredSkills: boolean;
}): Promise<string | null> {
  const relativeSkillsRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const skillsRoot = path.join(
    options.marketplaceRoot,
    'plugins',
    options.plugin.manifest.name,
    ...relativeSkillsRoot.split('/'),
  );
  if (options.hasRequiredSkills && !await fs.pathExists(skillsRoot)) {
    throw new Error(`Codex required Skills root 不存在：${skillsRoot}`);
  }
  const manifestPath = path.join(
    options.marketplaceRoot,
    'plugins',
    options.plugin.manifest.name,
    '.codex-plugin',
    'plugin.json',
  );
  const manifest = await fs.readJson(manifestPath).catch(() => ({})) as Record<string, unknown>;
  const updated: Record<string, unknown> = {
    ...manifest,
    name: options.plugin.manifest.name,
    version: options.plugin.manifest.version,
  };
  if (options.hasRequiredSkills) updated.skills = `./${relativeSkillsRoot}`;
  else delete updated.skills;
  await fs.outputJson(manifestPath, updated, { spaces: 2 });
  return options.hasRequiredSkills ? relativeSkillsRoot : null;
}

function createCodexMarketplaceComponent(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: NativeCliRunner;
  marketplaceRoot: string;
  desired: boolean;
}): OwnedComponent {
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const inspectCanonicalMarketplace = async (): Promise<'present' | 'absent' | 'foreign'> => {
    const config = await readCodexConfigFile(configPath);
    const marketplace = config.snapshot.marketplaces[MARKETPLACE_NAME];
    if (!marketplace) return 'absent';
    if (
      marketplace.sourceType !== 'local'
      || marketplace.sourcePointsToManifest
      || path.normalize(marketplace.source ?? '') !== path.normalize(options.marketplaceRoot)
    ) return 'foreign';
    return 'present';
  };
  const hasRemainingPlugins = async (): Promise<boolean> => {
    const listed = await runNativeCliChecked(
      buildCodexPluginListInvocation(options.cwd, options.env),
      options.runner,
    );
    const currentId = `${options.pluginName}@${MARKETPLACE_NAME}`;
    const listedRemaining = [...`${listed.stdout}\n${listed.stderr}`.matchAll(
      /\b([a-z0-9]+(?:-[a-z0-9]+)*)@aw\b/gu,
    )].some((match) => `${match[1]}@aw` !== currentId);
    if (listedRemaining) return true;
    return (await discoverCodexNativeResidueNames({
      cwd: options.cwd,
      env: options.env,
    })).some((name) => name !== options.pluginName);
  };
  const inspect = async (): Promise<'present' | 'absent' | 'foreign'> => {
    const canonical = await inspectCanonicalMarketplace();
    if (canonical !== 'present' || options.desired) return canonical;
    return await hasRemainingPlugins() ? 'absent' : 'present';
  };
  return {
    kind: 'shared-config',
    identity: ownerIdentity(options.pluginName, 'marketplace-aw', 'codex', 'user'),
    label: `${configPath}#marketplaces.${MARKETPLACE_NAME}`,
    inspect,
    remove: async () => {
      const currentResidue = await inspectCodexNativeResidue({
        pluginName: options.pluginName,
        cwd: options.cwd,
        env: options.env,
      });
      if (
        await inspectCanonicalMarketplace() !== 'present'
        || currentResidue.present
        || await hasRemainingPlugins()
      ) return;
      await runNativeCliChecked(
        buildCodexMarketplaceRemoveInvocation(MARKETPLACE_NAME, options.cwd, options.env),
        options.runner,
      );
      await runNativeCliChecked(
        buildCodexMarketplaceListInvocation(options.cwd, options.env),
        options.runner,
      );
    },
  };
}

async function assertCodexNativeInstallState(options: {
  pluginName: string;
  pluginVersion: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceRoot: string;
  skillsRelativeRoot: string | null;
  requiredSkillKeys: readonly string[];
}): Promise<void> {
  const pluginId = `${options.pluginName}@${MARKETPLACE_NAME}`;
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const config = await readCodexConfigFile(configPath);
  const marketplace = config.snapshot.marketplaces[MARKETPLACE_NAME];
  if (
    marketplace?.sourceType !== 'local'
    || marketplace.sourcePointsToManifest
    || path.normalize(marketplace.source ?? '') !== path.normalize(options.marketplaceRoot)
  ) {
    throw new Error(`Codex marketplace aw 未指向当前 AW_HOME：${options.marketplaceRoot}`);
  }
  if (config.snapshot.plugins[pluginId]?.enabled !== true) {
    throw new Error(`Codex enabled config 缺少 ${pluginId}。`);
  }
  const cacheRoot = path.join(
    getCodexHome(options.env),
    'plugins',
    'cache',
    MARKETPLACE_NAME,
    options.pluginName,
    options.pluginVersion,
  );
  const candidates = [
    path.join(cacheRoot, 'plugin.json'),
    path.join(cacheRoot, '.codex-plugin', 'plugin.json'),
  ];
  for (const candidate of candidates) {
    const manifest = await fs.readJson(candidate).catch(() => null) as Record<string, unknown> | null;
    if (!manifest) continue;
    const identity = manifest.id ?? manifest.name;
    if (
      (identity === options.pluginName || identity === pluginId)
      && manifest.version === options.pluginVersion
      && (
        options.skillsRelativeRoot === null
          ? typeof manifest.skills !== 'string'
          : typeof manifest.skills === 'string'
            && path.posix.normalize(manifest.skills.replace(/^\.\//u, '')) === options.skillsRelativeRoot
      )
    ) {
      for (const skillKey of options.requiredSkillKeys) {
        const skillPath = path.join(
          cacheRoot,
          ...options.skillsRelativeRoot!.split('/'),
          skillKey,
          'SKILL.md',
        );
        if (!await fs.pathExists(skillPath)) {
          throw new Error(`Codex native cache 缺少 required Skill：${skillPath}`);
        }
      }
      return;
    }
  }
  throw new Error(
    `Codex native cache 缺少匹配 ${pluginId}@${options.pluginVersion} 的 manifest：${cacheRoot}`,
  );
}

interface ClaudeNativeRecord {
  name: string;
  marketplace: string;
  scope: Scope;
  projectPath?: string;
  version: string;
}

async function readJsonObjectIfExists(filePath: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await fs.readJson(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON object。`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function readClaudeNativeState(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  paths: ReturnType<typeof resolveClaudePaths>;
  marketplaceState: 'absent' | 'canonical' | 'foreign';
  pluginState: 'absent' | 'present' | 'foreign';
  records: ClaudeNativeRecord[];
  pluginVersions: string[];
}> {
  const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
  const awHome = path.normalize(resolveAwHome(options.env));
  const settings = await readJsonObjectIfExists(paths.settingsPath, 'Claude settings');
  const known = await readJsonObjectIfExists(paths.knownMarketplacesPath, 'Claude known_marketplaces');
  const installed = await readJsonObjectIfExists(paths.installedPluginsPath, 'Claude installed_plugins');
  if (settings.extraKnownMarketplaces !== undefined && (
    !settings.extraKnownMarketplaces
    || typeof settings.extraKnownMarketplaces !== 'object'
    || Array.isArray(settings.extraKnownMarketplaces)
  )) throw new Error('Claude settings.extraKnownMarketplaces 必须是 object。');
  if (settings.plugins !== undefined && (
    !settings.plugins || typeof settings.plugins !== 'object' || Array.isArray(settings.plugins)
  )) throw new Error('Claude settings.plugins 必须是 object。');
  const settingsPlugins = settings.plugins as Record<string, unknown> | undefined;
  if (settingsPlugins?.installed !== undefined && (
    !settingsPlugins.installed
    || typeof settingsPlugins.installed !== 'object'
    || Array.isArray(settingsPlugins.installed)
  )) throw new Error('Claude settings.plugins.installed 必须是 object。');
  if (known.marketplaces !== undefined && (
    !known.marketplaces || typeof known.marketplaces !== 'object' || Array.isArray(known.marketplaces)
  )) throw new Error('Claude known_marketplaces.marketplaces 必须是 object。');
  if (installed.plugins !== undefined && (
    !installed.plugins || typeof installed.plugins !== 'object' || Array.isArray(installed.plugins)
  )) throw new Error('Claude installed_plugins.plugins 必须是 object。');
  const extraKnown = settings.extraKnownMarketplaces as Record<string, unknown> | undefined;
  const settingsSourceValue = extraKnown?.[MARKETPLACE_NAME];
  if (
    settingsSourceValue !== undefined
    && typeof settingsSourceValue !== 'string'
    && (!settingsSourceValue || typeof settingsSourceValue !== 'object' || Array.isArray(settingsSourceValue))
  ) throw new Error('Claude settings marketplace aw 声明无效。');
  const settingsSource = typeof settingsSourceValue === 'string'
    ? settingsSourceValue
    : nonEmptyString((settingsSourceValue as Record<string, unknown> | undefined)?.source);
  const knownRecord = (known.marketplaces as Record<string, unknown> | undefined)?.[MARKETPLACE_NAME];
  if (knownRecord !== undefined && (
    !knownRecord || typeof knownRecord !== 'object' || Array.isArray(knownRecord)
  )) throw new Error('Claude known marketplace aw 记录无效。');
  const knownObject = knownRecord as Record<string, unknown> | undefined;
  const knownSource = nonEmptyString(knownObject?.installLocation) ?? nonEmptyString(knownObject?.source);
  const normalizedSettingsSource = nonEmptyString(settingsSource);
  const foreignMarketplace = [normalizedSettingsSource, knownSource].some((source) =>
    source !== undefined && path.normalize(source) !== awHome);
  const marketplaceState = foreignMarketplace
    ? 'foreign'
    : normalizedSettingsSource === undefined
      ? 'absent'
      : 'canonical';
  const records: ClaudeNativeRecord[] = [];
  for (const [pluginKey, raw] of Object.entries(
    (installed.plugins as Record<string, unknown> | undefined) ?? {},
  )) {
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Claude installed_plugins 记录 ${pluginKey} 必须是 object。`);
      }
      const record = entry as Record<string, unknown>;
      const version = nonEmptyString(record.version);
      if (!version) throw new Error(`Claude installed_plugins 记录 ${pluginKey} 缺少 version。`);
      if (record.scope !== undefined && record.scope !== 'user' && record.scope !== 'project') {
        throw new Error(`Claude installed_plugins 记录 ${pluginKey} 的 scope 无效。`);
      }
      if (record.projectPath !== undefined && typeof record.projectPath !== 'string') {
        throw new Error(`Claude installed_plugins 记录 ${pluginKey} 的 projectPath 无效。`);
      }
      records.push({
        name: typeof record.name === 'string'
          ? record.name
          : pluginKey.includes('@') ? pluginKey.slice(0, pluginKey.indexOf('@')) : pluginKey,
        marketplace: typeof record.marketplace === 'string'
          ? record.marketplace
          : pluginKey.includes('@') ? pluginKey.slice(pluginKey.indexOf('@') + 1) : MARKETPLACE_NAME,
        scope: record.scope === 'project' ? 'project' : 'user',
        ...(typeof record.projectPath === 'string' ? { projectPath: record.projectPath } : {}),
        version,
      });
    }
  }
  const projectPath = options.scope === 'project' ? path.normalize(await resolveRepoRoot(options.cwd)) : undefined;
  const matchingRecords = records.filter((record) =>
    record.name === options.pluginName
    && record.scope === options.scope
    && (options.scope === 'user' || path.normalize(record.projectPath ?? '') === projectPath));
  const settingsInstalled = settingsPlugins?.installed as Record<string, unknown> | undefined;
  const rawSettingsRecord = settingsInstalled?.[options.pluginName];
  if (rawSettingsRecord !== undefined && (
    !rawSettingsRecord || typeof rawSettingsRecord !== 'object' || Array.isArray(rawSettingsRecord)
  )) throw new Error(`Claude settings plugin 记录 ${options.pluginName} 必须是 object。`);
  const settingsRecord = rawSettingsRecord as Record<string, unknown> | undefined;
  if (settingsRecord && !nonEmptyString(settingsRecord.version)) {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 缺少 version。`);
  }
  if (settingsRecord && !nonEmptyString(settingsRecord.marketplace)) {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 缺少 marketplace。`);
  }
  if (settingsRecord?.scope !== undefined
    && settingsRecord.scope !== 'user'
    && settingsRecord.scope !== 'project') {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 的 scope 无效。`);
  }
  if (settingsRecord?.projectPath !== undefined && typeof settingsRecord.projectPath !== 'string') {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 的 projectPath 无效。`);
  }
  const settingsMatchesScope = settingsRecord
    && (options.scope === 'user'
      ? settingsRecord.scope !== 'project'
      : settingsRecord.scope === 'project'
        && path.normalize((settingsRecord.projectPath as string | undefined) ?? '') === projectPath);
  const foreign = marketplaceState === 'foreign'
    || matchingRecords.some((record) => record.marketplace !== MARKETPLACE_NAME)
    || Boolean(settingsMatchesScope && settingsRecord?.marketplace !== MARKETPLACE_NAME);
  const canonicalRecords = matchingRecords.filter((record) => record.marketplace === MARKETPLACE_NAME);
  const canonicalSettingsRecord = settingsMatchesScope
    && settingsRecord?.marketplace === MARKETPLACE_NAME;
  const pluginState = foreign
    ? 'foreign'
    : canonicalRecords.length > 0 || canonicalSettingsRecord
      ? 'present'
      : 'absent';
  const pluginVersions = [
    ...canonicalRecords.map((record) => record.version),
    ...(canonicalSettingsRecord ? [nonEmptyString(settingsRecord.version)!] : []),
  ];
  return { paths, marketplaceState, pluginState, records, pluginVersions };
}

function createClaudeMarketplaceComponent(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: NativeCliRunner;
  desired: boolean;
}): OwnedComponent {
  const inspect = async (): Promise<'present' | 'absent' | 'foreign'> => {
    const state = await readClaudeNativeState(options);
    if (state.marketplaceState !== 'canonical') return state.marketplaceState;
    if (options.desired) return 'present';
    const projectPath = options.scope === 'project'
      ? path.normalize(await resolveRepoRoot(options.cwd))
      : undefined;
    return state.records.some((record) =>
      record.marketplace === MARKETPLACE_NAME
      && !(
        record.name === options.pluginName
        && record.scope === options.scope
        && (options.scope === 'user' || path.normalize(record.projectPath ?? '') === projectPath)
      ))
      ? 'absent'
      : 'present';
  };
  return {
    kind: 'shared-config',
    identity: ownerIdentity(options.pluginName, 'marketplace-aw', 'claude', options.scope),
    label: `${resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath}#marketplaces.aw`,
    inspect,
    remove: async () => {
      if (await inspect() !== 'present') return;
      const before = await readClaudeNativeState(options);
      if (before.pluginState !== 'absent') return;
      if (before.records.some((record) => record.marketplace === MARKETPLACE_NAME)) return;
      await runNativeCliChecked({
        command: 'claude',
        args: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--scope', options.scope],
        cwd: options.cwd,
        env: options.env,
      }, options.runner);
      const after = await readClaudeNativeState(options);
      if (after.marketplaceState !== 'absent') {
        throw new Error('Claude marketplace remove 后 canonical aw source 仍存在。');
      }
    },
  };
}

async function mirrorCatalog(catalog: CatalogResolution, env: NodeJS.ProcessEnv): Promise<string> {
  return (await ensureLocalMarketplace(env, undefined, catalog)).rootDir;
}

function createNativeDriver(options: {
  plans: WeakMap<DesiredTarget, RebuildIntegrationPlan>;
  context: RebuildExecutionContext;
  scriptTimeoutMs?: number;
}): RebuildTargetDriver {
  const runner = options.context.nativeCliRunner;
  const nativeList = async (target: DesiredTarget): Promise<string> => {
    const invocation = target.identity.platform === 'codex'
      ? buildCodexPluginListInvocation(target.identity.cwd, options.context.env)
      : {
          command: 'claude',
          args: ['plugin', 'list', '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        };
    const result = await runNativeCliChecked(invocation, runner);
    return `${result.stdout}\n${result.stderr}`;
  };
  return {
    probeNative: async (component) => {
      const target = [...plansTargetEntries(options.plans)].find((entry) =>
        entry.target.identity.pluginName === component.identity.plugin
        && entry.target.identity.platform === component.identity.platform
        && entry.target.identity.scope === component.identity.scope)?.target;
      if (!target) throw new Error('Native ownership probe cannot resolve its desired target.');
      if (target.identity.platform === 'claude') {
        return (await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
        })).pluginState;
      }
      if (outputContainsPluginId(await nativeList(target), component.pluginId)) return 'present';
      if (target.identity.platform === 'codex' && target.identity.scope === 'user') {
        return (await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        })).present ? 'present' : 'absent';
      }
      return 'absent';
    },
    removeNative: async (component) => {
      const target = [...plansTargetEntries(options.plans)].find((entry) =>
        entry.target.identity.pluginName === component.identity.plugin
        && entry.target.identity.platform === component.identity.platform
        && entry.target.identity.scope === component.identity.scope)?.target;
      if (!target) throw new Error('Native ownership removal cannot resolve its desired target.');
      if (target.identity.platform === 'codex') {
        await runNativeCliChecked(
          buildCodexPluginRemoveInvocation(component.pluginId, target.identity.cwd, options.context.env),
          runner,
        );
        const residue = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (residue.present) {
          throw new Error(`Codex native remove 后仍有残留：${residue.labels.join('，')}`);
        }
      } else {
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'uninstall', component.pluginId, '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'list', '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        const after = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (after.pluginState !== 'absent') {
          throw new Error(`Claude native uninstall 后仍有 ${after.pluginState} plugin evidence。`);
        }
      }
    },
    writeNative: async (target) => {
      const plan = options.plans.get(target);
      if (!plan) throw new Error('Missing rebuild integration plan.');
      const marketplaceRoot = await mirrorCatalog(plan.catalog, options.context.env);
      const pluginId = `${target.identity.pluginName}@${MARKETPLACE_NAME}`;
      if (target.identity.platform === 'codex') {
        const requiredSkillWrites = plan.writes.filter((entry) =>
          !entry.optional
          && entry.component?.kind === 'skill-directory'
          && entry.artifact.kind === 'skill'
          && entry.artifact.state !== 'disabled'
          && target.identity.scope === 'user');
        for (const write of requiredSkillWrites) {
          await write.write();
        }
        const skillsRelativeRoot = await ensureCodexActiveSkillsManifest({
          plugin: target.plugin,
          marketplaceRoot,
          hasRequiredSkills: requiredSkillWrites.length > 0,
        });
        const config = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const marketplace = config.snapshot.marketplaces[MARKETPLACE_NAME];
        if (path.normalize(marketplace?.source ?? '') !== path.normalize(marketplaceRoot)) {
          await runNativeCliChecked(
            buildCodexMarketplaceAddInvocation(marketplaceRoot, target.identity.cwd, options.context.env),
            runner,
          );
        }
        await runNativeCliChecked(
          buildCodexMarketplaceListInvocation(target.identity.cwd, options.context.env),
          runner,
        );
        await runNativeCliChecked(
          buildCodexPluginAddInvocation(pluginId, target.identity.cwd, options.context.env),
          runner,
        );
        await runNativeCliChecked(
          buildCodexPluginListInvocation(target.identity.cwd, options.context.env),
          runner,
        );
        await assertCodexNativeInstallState({
          pluginName: target.identity.pluginName,
          pluginVersion: target.identity.pluginVersion,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceRoot,
          skillsRelativeRoot,
          requiredSkillKeys: requiredSkillWrites.flatMap((write) =>
            write.artifact.artifactKey ? [write.artifact.artifactKey] : []),
        });
      } else {
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'marketplace', 'add', marketplaceRoot, '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'install', pluginId, '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'list', '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        const after = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (
          after.marketplaceState !== 'canonical'
          || after.pluginState !== 'present'
          || !after.pluginVersions.includes(target.identity.pluginVersion)
        ) {
          throw new Error(
            `Claude native install postcheck 失败：marketplace=${after.marketplaceState}，plugin=${after.pluginState}，versions=${after.pluginVersions.join(',')}。`,
          );
        }
      }
    },
    writeArtifacts: async (target) => {
      const plan = options.plans.get(target);
      if (!plan) throw new Error('Missing rebuild integration plan.');
      for (const write of plan.writes) await write.write();
      return plan.writes.map((write) => write.artifact);
    },
    runLifecycle: async (invocation: RebuildLifecycleInvocation) => {
      await runLifecycleScript({
        event: invocation.event,
        pluginName: invocation.plugin.manifest.name,
        platform: invocation.target.identity.platform,
        scope: invocation.target.identity.scope,
        cwd: invocation.target.identity.cwd,
        context: options.context as never,
        currentPlugin: invocation.plugin,
        artifacts: [...invocation.artifacts],
        scriptTimeoutMs: options.scriptTimeoutMs,
      });
    },
  };
}

const planTargets = new WeakMap<WeakMap<DesiredTarget, RebuildIntegrationPlan>, DesiredTarget[]>();

function plansTargetEntries(plans: WeakMap<DesiredTarget, RebuildIntegrationPlan>): Array<{
  target: DesiredTarget;
  plan: RebuildIntegrationPlan;
}> {
  return (planTargets.get(plans) ?? []).flatMap((target) => {
    const plan = plans.get(target);
    return plan ? [{ target, plan }] : [];
  });
}

export function createRebuildIntegration(options: {
  context: RebuildExecutionContext;
  scriptTimeoutMs?: number;
}): RebuildIntegration {
  const plans = new WeakMap<DesiredTarget, RebuildIntegrationPlan>();
  planTargets.set(plans, []);
  const driver = createNativeDriver({ plans, ...options });
  return {
    driver,
    buildTarget: async (input) => {
      const materializing = input.command !== 'cleanup'
        && input.command !== 'uninstall'
        && input.readOnlyInspectionPlan !== true;
      if (input.scope === 'project') {
        await assertCanonicalProjectManagedRoots({
          cwd: input.cwd,
          rootNames: input.platform === 'codex' ? ['.agents', '.codex'] : ['.claude'],
          managedPaths: input.platform === 'codex'
            ? ['.codex/config.toml', '.codex/hooks.json']
            : ['.claude/settings.json'],
        });
        if (materializing && input.platform === 'codex' && input.plugin.manifest.apps) {
          throw new Error(`Codex project scope 不支持 apps：${input.plugin.manifest.name}`);
        }
      }
      if (materializing && input.platform === 'codex') {
        await preflightCodexWriteSafety({
          plugin: input.plugin,
          scope: input.scope,
          cwd: input.cwd,
          env: options.context.env,
        });
      }
      const event = input.command === 'upgrade' ? 'upgrade' : 'install';
      let historicalArtifacts: GeneratedArtifact[] = [];
      if (input.includeHistoricalLifecycleArtifacts) {
        const loadPlugin = (bundleRoot: string) => readPluginManifest(bundleRoot, { mode: 'bundle' });
        const { readLifecycleActiveSnapshot } = await import('../utils/lifecycle-active-store.js');
        const active = await readLifecycleActiveSnapshot({
          pluginName: input.plugin.manifest.name,
          platform: input.platform,
          scope: input.scope,
          cwd: input.cwd,
          env: options.context.env,
          loadPlugin,
        }).catch(() => null);
        historicalArtifacts = active?.artifacts ?? [];
      }
      let writes: PlannedWrite[] = [];
      if (input.command !== 'cleanup' && input.command !== 'uninstall') {
        if (input.readOnlyInspectionPlan) {
          writes = await buildInspectionWrites({
            plugin: input.plugin,
            platform: input.platform,
            scope: input.scope,
            cwd: input.cwd,
            env: options.context.env,
          });
        } else if (input.platform === 'codex') {
          writes = await buildCodexWrites({
            ...input,
            env: options.context.env,
            event,
            historicalArtifacts,
            scriptTimeoutMs: options.scriptTimeoutMs,
          });
        } else {
          writes = await buildClaudeWrites({
            ...input,
            env: options.context.env,
            event,
            historicalArtifacts,
            scriptTimeoutMs: options.scriptTimeoutMs,
          });
        }
      }
      const desiredComponents = writes.filter((write) => !write.optional).flatMap((write) => [
        ...(write.component ? [write.component] : []),
        ...(write.additionalComponents ?? []),
      ]);
      const optionalComponents = writes
        .filter((write) => write.optional)
        .flatMap((write) => [
          ...(write.component ? [write.component] : []),
          ...(write.additionalComponents ?? []),
        ]);
      const optionalComponentKeys = new Set(optionalComponents.map(componentIdentityKey));
      const configDir = input.platform === 'codex'
        ? resolveCodexPaths(input.cwd, input.scope, options.context.env).configDir
        : resolveClaudePaths(input.cwd, input.scope, options.context.env).configDir;
      const textRoots = input.platform === 'codex'
        ? [path.join(configDir, 'rules'), path.join(configDir, 'agents')]
        : [path.join(configDir, 'rules'), path.join(configDir, 'agents')];
      const scannedText = (await Promise.all(textRoots.map((root) => scanOwnedTextFiles({
        root,
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
      })))).flat();
      const skillRoots = input.platform === 'codex'
        ? input.scope === 'project'
          ? [path.join(await resolveRepoRoot(input.cwd), '.agents', 'skills')]
          : [path.join(
              resolveAwHome(options.context.env),
              'plugins',
              input.plugin.manifest.name,
              ...(await resolveCodexSkillsRelativeRoot(
                input.plugin,
                input.plugin.manifest.version === '0.0.0'
                  ? path.join(
                      resolveAwHome(options.context.env),
                      'plugins',
                      input.plugin.manifest.name,
                    )
                  : undefined,
              )).split('/'),
            )]
        : [path.join(configDir, 'skills')];
      const scannedSkills = (await Promise.all(skillRoots.map((root) => scanOwnedSkills({
        root,
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
      })))).flat();
      const historicalComponents = await buildHistoricalComponents({
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
        cwd: input.cwd,
        env: options.context.env,
        artifacts: historicalArtifacts,
      });
      const sharedComponents = input.platform === 'codex'
        ? await scanCodexSharedComponents({
            pluginName: input.plugin.manifest.name,
            scope: input.scope,
            paths: resolveCodexPaths(input.cwd, input.scope, options.context.env),
            scanConfig: input.command === 'cleanup' || input.command === 'uninstall'
              || hasCodexSharedConfigCapability(input.plugin, input.scope),
            scanHooks: input.command === 'cleanup' || input.command === 'uninstall'
              || hasCodexHookCapability(input.plugin, input.scope),
            ignoreReadErrors: input.command === 'cleanup' || input.command === 'uninstall',
          })
        : await scanClaudeSharedComponents({
            pluginName: input.plugin.manifest.name,
            scope: input.scope,
            settingsPath: resolveClaudePaths(
              input.cwd,
              input.scope,
              options.context.env,
            ).settingsPath,
          });
      const nativeRequired = input.platform === 'claude'
        || (input.scope === 'user' && requiresCodexNativePlugin(input.plugin, input.scope));
      const nativeCleanupCandidate = input.platform === 'claude' || input.scope === 'user';
      const nativePlugin = (nativeRequired || (
        nativeCleanupCandidate
        && (input.command === 'cleanup' || input.command === 'uninstall')
      ))
        ? [{
            kind: 'native-plugin' as const,
            identity: ownerIdentity(input.plugin.manifest.name, 'native', input.platform, input.scope),
            pluginId: `${input.plugin.manifest.name}@aw`,
          } satisfies OwnedComponent]
        : [];
      const marketplaceDesired = nativeRequired
        && input.command !== 'cleanup'
        && input.command !== 'uninstall';
      const marketplace = input.platform === 'codex' && input.scope === 'user'
        ? [createCodexMarketplaceComponent({
            pluginName: input.plugin.manifest.name,
            cwd: input.cwd,
            env: options.context.env,
            runner: options.context.nativeCliRunner,
            marketplaceRoot: resolveAwHome(options.context.env),
            desired: marketplaceDesired,
          })]
        : input.platform === 'claude'
          ? [createClaudeMarketplaceComponent({
              pluginName: input.plugin.manifest.name,
              scope: input.scope,
              cwd: input.cwd,
              env: options.context.env,
              runner: options.context.nativeCliRunner,
              desired: marketplaceDesired,
            })]
          : [];
      if (
        nativeRequired
        && input.command !== 'cleanup'
        && input.command !== 'uninstall'
      ) desiredComponents.push(...nativePlugin, ...marketplace);
      const allComponents = dedupeComponents([
        ...desiredComponents,
        ...optionalComponents,
        ...scannedText,
        ...scannedSkills,
        ...historicalComponents,
        ...sharedComponents,
        ...nativePlugin,
        ...marketplace,
      ]);
      const desiredKeys = new Set(desiredComponents.map(componentIdentityKey));
      const target: DesiredTarget = {
        plugin: input.plugin,
        identity: {
          pluginName: input.plugin.manifest.name,
          pluginVersion: input.plugin.manifest.version,
          platform: input.platform,
          scope: input.scope,
          cwd: input.cwd,
        },
        ownedComponents: allComponents,
        desiredOwnedComponents: allComponents.filter((component) =>
          desiredKeys.has(componentIdentityKey(component))),
        optionalOwnedComponents: allComponents.filter((component) =>
          optionalComponentKeys.has(componentIdentityKey(component))),
        requiresNative: nativeRequired
          && input.command !== 'cleanup'
          && input.command !== 'uninstall',
        artifacts: writes.map((write) => write.artifact),
        lifecycleSource: input.plugin,
      };
      plans.set(target, {
        catalog: input.catalog,
        event,
        writes,
      });
      planTargets.get(plans)!.push(target);
      return target;
    },
  };
}

export async function inspectRebuildTarget(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  catalog: CatalogResolution;
  context: RebuildExecutionContext;
}): Promise<{
  target: DesiredTarget;
  inspection: OwnershipInspection;
}> {
  const integration = createRebuildIntegration({ context: options.context });
  const target = await integration.buildTarget({
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    command: 'install',
    catalog: options.catalog,
    includeHistoricalLifecycleArtifacts: false,
    readOnlyInspectionPlan: true,
  });
  const inspection = await inspectOwnedComponents({
    components: target.ownedComponents,
    nativeProbe: integration.driver.probeNative,
  });
  return { target, inspection };
}

async function discoverOwnerNamesInTextRoot(
  root: string,
  platform: PlatformName,
  scope: Scope,
): Promise<string[]> {
  if (!await fs.pathExists(root)) return [];
  const names = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const raw = await fs.readFile(entryPath, 'utf8').catch(() => '');
      if (!raw.includes(OWNED_TEXT_HEADER_PREFIX)) continue;
      const parsed = (() => {
        try { return parseOwnedTextHeader(raw); } catch { return null; }
      })();
      if (parsed?.identity.platform === platform && parsed.identity.scope === scope) {
        names.add(parsed.identity.plugin);
      }
    }
  }
  return [...names];
}

async function discoverOwnerNamesInSkillRoot(
  root: string,
  platform: PlatformName,
  scope: Scope,
): Promise<string[]> {
  if (!await fs.pathExists(root)) return [];
  const names = new Set<string>();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = await readSkillOwnerMarker({
      skillRoot: path.join(root, entry.name),
      allowedRoot: root,
    }).catch(() => null);
    if (marker?.platform === platform && marker.scope === scope) names.add(marker.plugin);
  }
  return [...names];
}

export async function discoverRebuildTargetNames(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformName;
  scope: Scope;
  nativeCliRunner: NativeCliRunner;
  nativeFailureMode?: 'error' | 'ignore';
}): Promise<string[]> {
  if (options.scope === 'project') {
    await assertCanonicalProjectManagedRoots({
      cwd: options.cwd,
      rootNames: options.platform === 'codex' ? ['.agents', '.codex'] : ['.claude'],
      managedPaths: options.platform === 'codex'
        ? ['.codex/config.toml', '.codex/hooks.json']
        : ['.claude/settings.json'],
    });
  }
  const names = new Set<string>();
  const paths = options.platform === 'codex'
    ? resolveCodexPaths(options.cwd, options.scope, options.env)
    : resolveClaudePaths(options.cwd, options.scope, options.env);
  const textRoots = [path.join(paths.configDir, 'rules'), path.join(paths.configDir, 'agents')];
  for (const name of (await Promise.all(textRoots.map((root) =>
    discoverOwnerNamesInTextRoot(root, options.platform, options.scope)))).flat()) names.add(name);
  const skillRoots = options.platform === 'codex'
    ? options.scope === 'project'
      ? [path.join(await resolveRepoRoot(options.cwd), '.agents', 'skills')]
      : [path.join(resolveAwHome(options.env), 'plugins')]
    : [path.join(paths.configDir, 'skills')];
  if (options.platform === 'codex' && options.scope === 'user') {
    const pluginsRoot = skillRoots[0]!;
    if (await fs.pathExists(pluginsRoot)) {
      for (const pluginEntry of await fs.readdir(pluginsRoot, { withFileTypes: true })) {
        if (!pluginEntry.isDirectory()) continue;
        const pluginRoot = path.join(pluginsRoot, pluginEntry.name);
        const platformManifest = await fs.readJson(
          path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
        ).catch(() => null) as Record<string, unknown> | null;
        const relativeSkillsRoot = typeof platformManifest?.skills === 'string'
          ? path.posix.normalize(platformManifest.skills.replace(/^\.\//u, ''))
          : 'codex/skills';
        if (
          relativeSkillsRoot === '..'
          || relativeSkillsRoot.startsWith('../')
          || path.isAbsolute(relativeSkillsRoot)
        ) continue;
        for (const name of await discoverOwnerNamesInSkillRoot(
          path.join(pluginRoot, ...relativeSkillsRoot.split('/')),
          options.platform,
          options.scope,
        )) names.add(name);
      }
    }
  } else {
    for (const root of skillRoots) {
      for (const name of await discoverOwnerNamesInSkillRoot(root, options.platform, options.scope)) {
        names.add(name);
      }
    }
  }
  if (options.platform === 'codex') {
    const config = await readCodexConfigFile(
      resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
    );
    for (const name of Object.keys(config.snapshot.developerInstructions.managedBlocks)) names.add(name);
    for (const server of Object.values(config.snapshot.mcpServers)) {
      const envValue = server.value?.env;
      const owner = envValue
        && typeof envValue === 'object'
        && !Array.isArray(envValue)
        && typeof envValue[MCP_OWNER_ENV] === 'string'
        ? envValue[MCP_OWNER_ENV]
        : null;
      if (owner) names.add(owner);
    }
    if (options.scope === 'project') {
      const hooksPath = resolveCodexPaths(options.cwd, options.scope, options.env).hooksPath;
      const hooks = await readCodexHooks(hooksPath).catch(() => null);
      for (const identity of hooks?.managedIdentities ?? []) {
        const owner = readOwnedHookPlugin(identity, options.scope);
        if (owner) names.add(owner);
      }
    } else {
      for (const name of await discoverCodexNativeResidueNames({
        cwd: options.cwd,
        env: options.env,
      })) names.add(name);
    }
  } else {
    const settings = await readClaudeSettings(
      resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath,
    );
    for (const name of Object.keys(settings.awGenerated?.permissions ?? {})) names.add(name);
  }
  if (options.platform === 'codex' && options.scope === 'project') {
    return [...names].sort();
  }
  const listInvocation = options.platform === 'codex'
    ? buildCodexPluginListInvocation(options.cwd, options.env)
    : {
        command: 'claude',
        args: ['plugin', 'list', '--scope', options.scope],
        cwd: options.cwd,
        env: options.env,
      };
  const listed = await runNativeCliChecked(listInvocation, options.nativeCliRunner).catch((error) => {
    if (options.nativeFailureMode === 'ignore') return null;
    throw error;
  });
  if (!listed) return [...names].sort();
  for (const match of `${listed.stdout}\n${listed.stderr}`.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)*)@aw\b/gu)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}
