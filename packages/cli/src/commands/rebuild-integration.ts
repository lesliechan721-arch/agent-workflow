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
  applyConditionalCodexConfigTransactionFile,
  applyCodexConfigTransactionFile,
  composeManagedDeveloperInstructionsBlock,
  readCodexConfigFile,
  readRenderedCodexMcpServersFile,
  type CodexMcpServerConfig,
  type CodexAgentRegistrationConfig,
  type CodexAgentRegistrationSnapshot,
  type CodexMcpServerSnapshot,
} from '../utils/codex-config.js';
import {
  createCodexSkillExpectedTree,
  createCodexSkillStagingTreeContentDigest,
} from '../utils/codex-skill-staging.js';
import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  skillDirectoryMatchesExpectedTree,
  validateSkillDirectory,
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
import {
  atomicRemoveConfigFile,
  atomicReplaceConfigFile,
  withConfigFileLock,
} from '../utils/plugin-config.js';
import { withActiveMarketplaceRuntimeLease } from '../utils/active-marketplace-runtime-lock.js';
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
  unownedIsPristine?: (actualPath: string) => Promise<boolean>;
}): OwnedComponent {
  if (options.kind !== 'skill-directory') return options;
  return {
    ...options,
    validateHealth: async () => {
      await validateSkillDirectory(
        options.path,
        options.identity.platform === 'codex' ? 'codex.skill' : 'claude.skill',
        { ownerMarkerPolicy: 'ignore' },
      );
    },
  };
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

function intersectPermissionState(
  value: Partial<ClaudePermissions> | undefined,
  generated: ClaudePermissions,
): ClaudePermissions {
  const keep = {
    allow: new Set(generated.allow),
    ask: new Set(generated.ask),
    deny: new Set(generated.deny),
  };
  return {
    allow: (value?.allow ?? []).filter((entry) => keep.allow.has(entry)),
    ask: (value?.ask ?? []).filter((entry) => keep.ask.has(entry)),
    deny: (value?.deny ?? []).filter((entry) => keep.deny.has(entry)),
  };
}

function rebuildClaudePermissions(settings: ClaudeSettings, pluginName: string, desired?: ClaudePermissions): void {
  const previousGenerated = mergePermissionStates(
    Object.values(settings.awGenerated?.permissions ?? {}),
  );
  const currentPermissions = mergePermissionStates([settings.permissions]);
  const manual = mergePermissionStates([
    subtractPermissionState(currentPermissions, previousGenerated),
    intersectPermissionState(
      intersectPermissionState(settings.awGenerated?.manualPermissions, previousGenerated),
      currentPermissions,
    ),
  ]);
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

function codexMcpOwner(
  actual: CodexMcpServerSnapshot | undefined,
): string | null {
  const envValue = actual?.value?.env;
  return envValue
    && typeof envValue === 'object'
    && !Array.isArray(envValue)
    && typeof envValue[MCP_OWNER_ENV] === 'string'
    ? envValue[MCP_OWNER_ENV]
    : null;
}

function createCodexMcpComponent(options: {
  pluginName: string;
  scope: Scope;
  configPath: string;
  serverKey: string;
  owned: boolean;
}): OwnedComponent {
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
      return codexMcpOwner(actual) === options.pluginName ? 'present' : 'foreign';
    },
    remove: async () => {
      await applyConditionalCodexConfigTransactionFile(options.configPath, (snapshot) => {
        const actual = snapshot.mcpServers[options.serverKey];
        return codexMcpOwner(actual) === options.pluginName
          ? { removeMcpServers: [options.serverKey] }
          : null;
      });
    },
  };
}

async function codexRoleRegistrationOwned(options: {
  pluginName: string;
  scope: Scope;
  configPath: string;
  roleKey: string;
  rolePath: string;
  registration: CodexAgentRegistrationSnapshot | undefined;
}): Promise<boolean> {
  if (!options.registration?.configFile) return false;
  const expected = path.normalize(
    path.relative(path.dirname(options.configPath), options.rolePath),
  );
  const actual = path.normalize(path.relative(
    path.dirname(options.configPath),
    path.resolve(path.dirname(options.configPath), options.registration.configFile),
  ));
  if (actual !== expected) return false;
  const raw = await fs.readFile(options.rolePath, 'utf8').catch(() => '');
  try {
    return Boolean(parseOwnedTextHeader(
      raw,
      ownerIdentity(options.pluginName, options.roleKey, 'codex', options.scope),
    ));
  } catch {
    return false;
  }
}

function createCodexRoleRegistrationComponent(options: {
  pluginName: string;
  scope: Scope;
  configPath: string;
  roleKey: string;
  rolePath: string;
}): OwnedComponent {
  const inspect = async (): Promise<'present' | 'absent' | 'foreign'> => {
    const config = await readCodexConfigFile(options.configPath);
    const registration = config.snapshot.agents[options.roleKey];
    if (!registration) return 'absent';
    return await codexRoleRegistrationOwned({ ...options, registration })
      ? 'present'
      : 'foreign';
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
      await applyConditionalCodexConfigTransactionFile(options.configPath, async (snapshot) => {
        const registration = snapshot.agents[options.roleKey];
        return await codexRoleRegistrationOwned({ ...options, registration })
          ? { removeAgentRegistrations: [options.roleKey] }
          : null;
      });
    },
  };
}

async function readCodexHooks(hooksPath: string) {
  if (!await fs.pathExists(hooksPath)) return parseCodexSharedHooksFile({ hooks: {} });
  return parseCodexSharedHooksFile(await fs.readJson(hooksPath));
}

function renderCodexHookGroups(
  groups: CodexSharedHookGroup[],
): string {
  const hooks: Record<string, Record<string, unknown>[]> = {};
  for (const group of groups) {
    hooks[group.event] ??= [];
    hooks[group.event]!.push(group.rawGroup);
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

export async function applyCodexHookGroupsTransactionFile(
  hooksPath: string,
  update: (
    parsed: ReturnType<typeof parseCodexSharedHooksFile>,
  ) => CodexSharedHookGroup[] | null,
  testHooks?: { beforeCommit?: () => Promise<void> },
): Promise<boolean> {
  return withConfigFileLock({
    filePath: hooksPath,
    allowedRoot: path.dirname(hooksPath),
    action: async () => {
      const parsed = await readCodexHooks(hooksPath);
      const groups = update(parsed);
      if (!groups) return false;
      await testHooks?.beforeCommit?.();
      if (groups.length === 0) {
        await atomicRemoveConfigFile({
          filePath: hooksPath,
          allowedRoot: path.dirname(hooksPath),
        });
      } else {
        await atomicReplaceConfigFile({
          filePath: hooksPath,
          allowedRoot: path.dirname(hooksPath),
          content: renderCodexHookGroups(groups),
        });
      }
      return true;
    },
  });
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
      await applyCodexHookGroupsTransactionFile(options.hooksPath, (parsed) => {
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
        return removed ? remaining : null;
      });
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
  const pending = [options.root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillRoot = path.join(current, entry.name);
      const marker = await readSkillOwnerMarker({
        skillRoot,
        allowedRoot: current,
      }).catch(() => null);
      if (
        marker?.plugin === options.pluginName
        && marker.platform === options.platform
        && marker.scope === options.scope
      ) {
        output.push(pathComponent({
          kind: 'skill-directory',
          path: skillRoot,
          allowedRoot: current,
          identity: marker,
        }));
        continue;
      }
      pending.push(skillRoot);
    }
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
    ...(options.platform === 'codex' && options.scope === 'user'
      ? {
          unownedIsPristine: (actualPath: string) =>
            skillDirectoryMatchesExpectedTree(actualPath, options.tree),
        }
      : {}),
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
        allowPristineUnowned: options.platform === 'codex' && options.scope === 'user',
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
    const canRecoverPristine = options.scope === 'user'
      && path.resolve(skillSource) !== path.resolve(skillPath);
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
      ...(canRecoverPristine
        ? {
            unownedIsPristine: (actualPath: string) =>
              skillDirectoryMatchesExpectedTree(actualPath, tree),
          }
        : {}),
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
        await writeDynamicSkillTree(skillPath, tree, {
          allowedRoot: targetRoot,
          identity,
          allowPristineUnowned: canRecoverPristine,
        });
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
      requireReadme: true,
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
      requireReadme: true,
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
        await applyConditionalCodexConfigTransactionFile(paths.configTomlPath, (snapshot) => {
          const actual = snapshot.mcpServers[serverKey];
          const actualOwner = codexMcpOwner(actual);
          if (actual && actualOwner !== options.plugin.manifest.name) {
            throw new Error(
              `Codex MCP server "${serverKey}" is foreign and cannot be overwritten by plugin "${options.plugin.manifest.name}".`,
            );
          }
          return { upsertMcpServers: { [serverKey]: server } };
        });
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
        await applyConditionalCodexConfigTransactionFile(paths.configTomlPath, async (snapshot) => {
          const actual = snapshot.agents[roleKey];
          if (actual && !await codexRoleRegistrationOwned({
            pluginName: options.plugin.manifest.name,
            scope: options.scope,
            configPath: paths.configTomlPath,
            roleKey,
            rolePath,
            registration: actual,
          })) {
            throw new Error(
              `Codex agent registration "${roleKey}" is foreign and cannot be overwritten by plugin "${options.plugin.manifest.name}".`,
            );
          }
          return { upsertAgentRegistrations: { [roleKey]: registration } };
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
          await applyCodexHookGroupsTransactionFile(paths.hooksPath, (parsed) => {
            const serialized = serializeTrackedHookGroupIdentity(identity);
            const exists = parsed.managedIdentities.some((entry) =>
              serializeTrackedHookGroupIdentity(entry) === serialized);
            return exists
              ? null
              : [...parsed.rawGroups, renderCodexSharedHookGroup(identity)];
          });
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

async function inspectCodexNativeResidue(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  state: 'present' | 'absent' | 'foreign';
  labels: string[];
  versions: string[];
  enabled: boolean;
}> {
  const pluginId = `${options.pluginName}@${MARKETPLACE_NAME}`;
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const config = await readCodexConfigFile(configPath);
  const marketplace = config.snapshot.marketplaces[MARKETPLACE_NAME];
  const canonicalMarketplace = marketplace?.sourceType === 'local'
    && !marketplace.sourcePointsToManifest
    && path.normalize(marketplace.source ?? '') === path.normalize(resolveAwHome(options.env));
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
  const labels: string[] = [];
  const foreignLabels: string[] = [];
  const versions = new Set<string>();
  const configEntry = config.snapshot.plugins[pluginId];
  if (configEntry) {
    (canonicalMarketplace ? labels : foreignLabels).push(`${configPath}#plugins.${pluginId}`);
  }
  const inspectManifest = async (manifestPath: string, directoryVersion?: string): Promise<void> => {
    const stats = await fs.lstat(manifestPath).catch(() => null);
    if (!stats) return;
    if (!stats.isFile() || stats.isSymbolicLink()) {
      foreignLabels.push(manifestPath);
      return;
    }
    const manifest = await fs.readJson(manifestPath).catch(() => null) as Record<string, unknown> | null;
    const identity = manifest?.id ?? manifest?.name;
    const version = typeof manifest?.version === 'string' ? manifest.version : null;
    if (
      !canonicalMarketplace
      || (identity !== options.pluginName && identity !== pluginId)
      || !version
      || (directoryVersion !== undefined && version !== directoryVersion)
    ) {
      foreignLabels.push(manifestPath);
      return;
    }
    labels.push(manifestPath);
    versions.add(version);
  };
  for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      foreignLabels.push(path.join(cacheRoot, entry.name));
      continue;
    }
    const versionRoot = path.join(cacheRoot, entry.name);
    const candidates = [
      path.join(versionRoot, 'plugin.json'),
      path.join(versionRoot, '.codex-plugin', 'plugin.json'),
    ];
    const existing = [];
    for (const candidate of candidates) {
      if (await fs.pathExists(candidate)) existing.push(candidate);
    }
    if (existing.length === 0) foreignLabels.push(versionRoot);
    for (const candidate of existing) await inspectManifest(candidate, entry.name);
  }
  await inspectManifest(installedManifest);
  return foreignLabels.length > 0
    ? {
        state: 'foreign', labels: [...labels, ...foreignLabels], versions: [...versions],
        enabled: configEntry?.enabled === true,
      }
    : labels.length > 0
      ? { state: 'present', labels, versions: [...versions], enabled: configEntry?.enabled === true }
      : { state: 'absent', labels: [], versions: [], enabled: false };
}

async function discoverCodexNativeResidueNames(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const names = new Set<string>();
  const config = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  const marketplace = config.snapshot.marketplaces[MARKETPLACE_NAME];
  const canonicalMarketplace = marketplace?.sourceType === 'local'
    && !marketplace.sourcePointsToManifest
    && path.normalize(marketplace.source ?? '') === path.normalize(resolveAwHome(options.env));
  for (const pluginId of canonicalMarketplace ? Object.keys(config.snapshot.plugins) : []) {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)@aw$/u.exec(pluginId);
    if (match) names.add(match[1]!);
  }
  const cacheRoot = path.join(getCodexHome(options.env), 'plugins', 'cache', MARKETPLACE_NAME);
  for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name)) continue;
    const residue = await inspectCodexNativeResidue({ ...options, pluginName: entry.name });
    if (residue.state === 'present') names.add(entry.name);
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
    if (canonicalMarketplace && (
      (identity === match[1] || identity === entry.name)
      && typeof manifest.version === 'string'
      && manifest.version.trim() !== ''
    )) names.add(match[1]!);
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
    return (await discoverCodexNativeResidueNames({
      cwd: options.cwd,
      env: options.env,
    })).some((name) => name !== options.pluginName);
  };
  const inspect = async (): Promise<'present' | 'absent' | 'foreign'> => {
    const canonical = await inspectCanonicalMarketplace();
    const plugin = await inspectCodexNativeResidue({
      pluginName: options.pluginName,
      cwd: options.cwd,
      env: options.env,
    });
    if (plugin.state === 'foreign') return 'foreign';
    if (options.desired) {
      return canonical === 'present' && plugin.state === 'present' && plugin.enabled
        ? 'present'
        : 'absent';
    }
    if (canonical !== 'present') return canonical;
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
      if (currentResidue.state === 'foreign') {
        throw new Error(`Codex native owner 为 foreign，拒绝移除 marketplace：${currentResidue.labels.join('，')}`);
      }
      if (await inspectCanonicalMarketplace() !== 'present'
        || currentResidue.state === 'present'
        || await hasRemainingPlugins()) return;
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
  const expectedRoot = path.join(
    options.marketplaceRoot,
    'plugins',
    options.pluginName,
  );
  const assertExpectedPayload = async (): Promise<void> => {
    const collectFiles = async (root: string): Promise<string[]> => {
      const output: string[] = [];
      const pending = [''];
      while (pending.length > 0) {
        const relativeRoot = pending.pop()!;
        for (const entry of await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true })) {
          const relativePath = path.join(relativeRoot, entry.name);
          if (entry.isSymbolicLink()) {
            throw new Error(`Codex native payload 不能包含符号链接：${path.join(root, relativePath)}`);
          }
          if (entry.isDirectory()) pending.push(relativePath);
          else if (entry.isFile()) output.push(relativePath);
          else throw new Error(`Codex native payload 包含不支持的节点：${path.join(root, relativePath)}`);
        }
      }
      return output;
    };
    const manifestPaths = new Set(['plugin.json', path.join('.codex-plugin', 'plugin.json')]);
    const allowedMetadata = new Set(['metadata.json', '.metadata.json']);
    const [expectedFiles, actualFiles] = await Promise.all([
      collectFiles(expectedRoot),
      collectFiles(cacheRoot),
    ]);
    const expectedSet = new Set(expectedFiles);
    for (const relativePath of expectedFiles) {
      if (manifestPaths.has(relativePath)) continue;
      const expectedPath = path.join(expectedRoot, relativePath);
      const actualPath = path.join(cacheRoot, relativePath);
      const actualStats = await fs.lstat(actualPath).catch(() => null);
      if (!actualStats?.isFile() || actualStats.isSymbolicLink()) {
        throw new Error(`Codex native cache 缺少 expected payload：${actualPath}`);
      }
      const [expectedContent, actualContent] = await Promise.all([
        fs.readFile(expectedPath),
        fs.readFile(actualPath),
      ]);
      if (!expectedContent.equals(actualContent)) {
        throw new Error(`Codex native cache expected payload digest 不匹配：${actualPath}`);
      }
    }
    for (const relativePath of actualFiles) {
      if (
        expectedSet.has(relativePath)
        || manifestPaths.has(relativePath)
        || allowedMetadata.has(relativePath)
      ) continue;
      throw new Error(`Codex native cache 包含 unexpected loadable payload：${path.join(cacheRoot, relativePath)}`);
    }
  };
  let matchedManifest = false;
  for (const candidate of candidates) {
    if (!await fs.pathExists(candidate)) continue;
    const manifest = await fs.readJson(candidate).catch(() => null) as Record<string, unknown> | null;
    if (!manifest) {
      throw new Error(`Codex native cache manifest 无法解析：${candidate}`);
    }
    const identity = manifest.id ?? manifest.name;
    const matches = (
      (identity === options.pluginName || identity === pluginId)
      && manifest.version === options.pluginVersion
      && (
        options.skillsRelativeRoot === null
          ? typeof manifest.skills !== 'string'
          : typeof manifest.skills === 'string'
            && path.posix.normalize(manifest.skills.replace(/^\.\//u, '')) === options.skillsRelativeRoot
      )
    );
    if (!matches) {
      throw new Error(`Codex native cache manifest 不匹配：${candidate}`);
    }
    matchedManifest = true;
  }
  if (!matchedManifest) {
    throw new Error(
      `Codex native cache 缺少匹配 ${pluginId}@${options.pluginVersion} 的 manifest：${cacheRoot}`,
    );
  }
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
  await assertExpectedPayload();
}

type ClaudeNativeScope = Scope | 'local';

interface ClaudeNativeRecord {
  name: string;
  marketplace: string;
  scope: ClaudeNativeScope;
  projectPath?: string;
  version: string;
}

interface ClaudeMarketplaceConsumer {
  name: string;
  scope: ClaudeNativeScope;
  projectPath?: string;
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

function readClaudeMarketplaceSourcePath(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const source = nonEmptyString(value);
    if (!source) throw new Error(`${label} 必须是非空 string。`);
    return source;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 string 或 object。`);
  }
  const record = value as Record<string, unknown>;
  if (record.source && typeof record.source === 'object' && !Array.isArray(record.source)) {
    return readClaudeMarketplaceSourcePath(record.source, `${label}.source`);
  }
  const source = nonEmptyString(record.source);
  if (!source) throw new Error(`${label}.source 必须是非空 string 或 object。`);
  if (record.path === undefined) return source;
  const sourcePath = nonEmptyString(record.path);
  if (!sourcePath) throw new Error(`${label}.path 必须是非空 string。`);
  return source === 'directory' ? sourcePath : null;
}

type ClaudeMarketplaceState = 'absent' | 'canonical' | 'foreign';

function classifyClaudeMarketplaceSources(
  sources: Array<string | null | undefined>,
  awHome: string,
): ClaudeMarketplaceState {
  if (sources.some((source) =>
    source === null || (source !== undefined && path.normalize(source) !== awHome))) {
    return 'foreign';
  }
  return sources.some((source) => source !== undefined) ? 'canonical' : 'absent';
}

function readClaudeKnownMarketplaceSources(value: unknown, label: string): Array<string | null | undefined> {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 记录无效。`);
  }
  const record = value as Record<string, unknown>;
  const sources: Array<string | null | undefined> = [];
  if (record.installLocation !== undefined) {
    const installLocation = nonEmptyString(record.installLocation);
    if (!installLocation) throw new Error(`${label}.installLocation 必须是非空 string。`);
    sources.push(installLocation);
  }
  sources.push(readClaudeMarketplaceSourcePath(record.source, `${label}.source`));
  return sources;
}

async function readClaudeNativeState(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  paths: ReturnType<typeof resolveClaudePaths>;
  marketplaceState: ClaudeMarketplaceState;
  marketplaceDeclaredState: ClaudeMarketplaceState;
  marketplaceMaterializedState: ClaudeMarketplaceState;
  legacyMarketplaceState: ClaudeMarketplaceState;
  pluginState: 'absent' | 'present' | 'foreign';
  pluginEnabled: boolean;
  records: ClaudeNativeRecord[];
  marketplaceConsumers: ClaudeMarketplaceConsumer[];
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
  if (settings.enabledPlugins !== undefined && (
    !settings.enabledPlugins
    || typeof settings.enabledPlugins !== 'object'
    || Array.isArray(settings.enabledPlugins)
  )) throw new Error('Claude settings.enabledPlugins 必须是 object。');
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
  const settingsSource = readClaudeMarketplaceSourcePath(
    settingsSourceValue,
    'Claude settings marketplace aw',
  );
  const legacyKnown = known.marketplaces as Record<string, unknown> | undefined;
  const marketplaceDeclaredState = classifyClaudeMarketplaceSources([settingsSource], awHome);
  const marketplaceMaterializedState = classifyClaudeMarketplaceSources(
    readClaudeKnownMarketplaceSources(
      known[MARKETPLACE_NAME],
      'Claude known marketplace aw',
    ),
    awHome,
  );
  const legacyMarketplaceState = classifyClaudeMarketplaceSources(
    readClaudeKnownMarketplaceSources(
      legacyKnown?.[MARKETPLACE_NAME],
      'Claude known marketplace aw legacy',
    ),
    awHome,
  );
  const marketplaceStates = [
    marketplaceDeclaredState,
    marketplaceMaterializedState,
    legacyMarketplaceState,
  ];
  const marketplaceState = marketplaceStates.includes('foreign')
    ? 'foreign'
    : marketplaceStates.includes('canonical')
      ? 'canonical'
      : 'absent';
  const pluginId = `${options.pluginName}@${MARKETPLACE_NAME}`;
  const enabledPlugins = settings.enabledPlugins as Record<string, unknown> | undefined;
  const rawEnabled = enabledPlugins?.[pluginId];
  if (
    rawEnabled !== undefined
    && typeof rawEnabled !== 'boolean'
    && (!Array.isArray(rawEnabled) || !rawEnabled.every((entry) => typeof entry === 'string'))
  ) {
    throw new Error(`Claude settings.enabledPlugins 记录 ${pluginId} 必须是 boolean 或 string array。`);
  }
  const pluginEnabled = rawEnabled === true || Array.isArray(rawEnabled);
  const enabledPluginEvidence = rawEnabled !== undefined;
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
      if (
        record.scope !== undefined
        && record.scope !== 'user'
        && record.scope !== 'project'
        && record.scope !== 'local'
      ) {
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
        scope: record.scope === 'project' || record.scope === 'local' ? record.scope : 'user',
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
    && settingsRecord.scope !== 'project'
    && settingsRecord.scope !== 'local') {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 的 scope 无效。`);
  }
  if (settingsRecord?.projectPath !== undefined && typeof settingsRecord.projectPath !== 'string') {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 的 projectPath 无效。`);
  }
  const settingsMatchesScope = settingsRecord
    && (settingsRecord.scope ?? 'user') === options.scope
    && (options.scope === 'user'
      || path.normalize((settingsRecord.projectPath as string | undefined) ?? '') === projectPath);
  const canonicalEvidence = matchingRecords.some((record) => record.marketplace === MARKETPLACE_NAME)
    || Boolean(settingsMatchesScope && settingsRecord?.marketplace === MARKETPLACE_NAME)
    || enabledPluginEvidence;
  const foreign = matchingRecords.some((record) => record.marketplace !== MARKETPLACE_NAME)
    || Boolean(settingsMatchesScope && settingsRecord?.marketplace !== MARKETPLACE_NAME)
    || (canonicalEvidence && marketplaceState === 'foreign');
  const canonicalRecords = matchingRecords.filter((record) => record.marketplace === MARKETPLACE_NAME);
  const canonicalSettingsRecord = settingsMatchesScope
    && settingsRecord?.marketplace === MARKETPLACE_NAME;
  const marketplaceConsumers: ClaudeMarketplaceConsumer[] = records
    .filter((record) => record.marketplace === MARKETPLACE_NAME)
    .map((record) => ({
      name: record.name,
      scope: record.scope,
      ...(record.projectPath ? { projectPath: record.projectPath } : {}),
    }));
  for (const pluginKey of Object.keys(enabledPlugins ?? {})) {
    const suffix = `@${MARKETPLACE_NAME}`;
    if (!pluginKey.endsWith(suffix)) continue;
    marketplaceConsumers.push({
      name: pluginKey.slice(0, -suffix.length),
      scope: options.scope,
      ...(projectPath ? { projectPath } : {}),
    });
  }
  for (const [pluginKey, rawRecord] of Object.entries(settingsInstalled ?? {})) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) continue;
    const record = rawRecord as Record<string, unknown>;
    if (record.marketplace !== MARKETPLACE_NAME) continue;
    const name = nonEmptyString(record.name)
      ?? (pluginKey.endsWith(`@${MARKETPLACE_NAME}`)
        ? pluginKey.slice(0, -`@${MARKETPLACE_NAME}`.length)
        : pluginKey);
    const scope = record.scope === 'project' || record.scope === 'local' ? record.scope : 'user';
    marketplaceConsumers.push({
      name,
      scope,
      ...(typeof record.projectPath === 'string' ? { projectPath: record.projectPath } : {}),
    });
  }
  const pluginState = foreign
    ? 'foreign'
    : canonicalEvidence
      ? 'present'
      : 'absent';
  const pluginVersions = [
    ...canonicalRecords.map((record) => record.version),
    ...(canonicalSettingsRecord ? [nonEmptyString(settingsRecord.version)!] : []),
  ];
  return {
    paths,
    marketplaceState,
    marketplaceDeclaredState,
    marketplaceMaterializedState,
    legacyMarketplaceState,
    pluginState,
    pluginEnabled,
    records,
    marketplaceConsumers,
    pluginVersions,
  };
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
    if (state.pluginState === 'foreign') return 'foreign';
    if (options.desired) {
      return state.marketplaceDeclaredState === 'canonical'
        && state.marketplaceMaterializedState === 'canonical'
        && state.pluginState === 'present'
        && state.pluginEnabled
        ? 'present'
        : 'absent';
    }
    if (state.marketplaceState !== 'canonical') return state.marketplaceState;
    const projectPath = options.scope === 'project'
      ? path.normalize(await resolveRepoRoot(options.cwd))
      : undefined;
    return state.marketplaceConsumers.some((consumer) => !(
      consumer.name === options.pluginName
      && consumer.scope === options.scope
      && (options.scope === 'user' || path.normalize(consumer.projectPath ?? '') === projectPath)
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
      if (before.marketplaceConsumers.length > 0) return;
      await runNativeCliChecked({
        command: 'claude',
        args: ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
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

function createNativeVersionComponent(options: {
  pluginName: string;
  pluginVersion: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): OwnedComponent {
  return {
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('native-version', options.pluginVersion),
      options.platform,
      options.scope,
    ),
    label: `${options.pluginName}@aw#version=${options.pluginVersion}`,
    inspect: async () => {
      let versions: string[];
      if (options.platform === 'codex') {
        const residue = await inspectCodexNativeResidue({
          pluginName: options.pluginName,
          cwd: options.cwd,
          env: options.env,
        });
        versions = residue.enabled && residue.state === 'present' ? residue.versions : [];
      } else {
        const state = await readClaudeNativeState({
          pluginName: options.pluginName,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env,
        });
        versions = state.pluginEnabled && state.pluginState === 'present'
          ? state.pluginVersions
          : [];
      }
      return versions.includes(options.pluginVersion) ? 'present' : 'absent';
    },
    remove: async () => undefined,
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
  return {
    withOwnershipLease: (target, operation) => (
      target.identity.platform === 'codex' && target.identity.scope === 'user'
        ? withActiveMarketplaceRuntimeLease(options.context.env, operation)
        : operation()
    ),
    probeNative: async (component) => {
      const target = [...plansTargetEntries(options.plans)].find((entry) =>
        entry.target.identity.pluginName === component.identity.plugin
        && entry.target.identity.platform === component.identity.platform
        && entry.target.identity.scope === component.identity.scope)?.target;
      if (!target) throw new Error('Native ownership probe cannot resolve its desired target.');
      if (target.identity.platform === 'claude') {
        const state = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        return state.pluginState;
      }
      if (target.identity.platform === 'codex' && target.identity.scope === 'user') {
        const residue = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        return residue.state;
      }
      return 'absent';
    },
    probeNativeHealth: async (component) => {
      const target = [...plansTargetEntries(options.plans)].find((entry) =>
        entry.target.identity.pluginName === component.identity.plugin
        && entry.target.identity.platform === component.identity.platform
        && entry.target.identity.scope === component.identity.scope)?.target;
      if (!target) throw new Error('Native health probe cannot resolve its desired target.');
      if (target.identity.platform === 'claude') {
        const state = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (state.pluginState !== 'present') return state.pluginState;
        return state.pluginEnabled ? 'present' : 'partial';
      }
      if (target.identity.platform === 'codex' && target.identity.scope === 'user') {
        const residue = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (residue.state !== 'present') return residue.state;
        return residue.enabled ? 'present' : 'partial';
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
        const before = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (before.state === 'foreign') {
          throw new Error(`Codex native owner 为 foreign，拒绝调用 plugin remove：${before.labels.join('，')}`);
        }
        if (before.state === 'absent') return;
        await runNativeCliChecked(
          buildCodexPluginRemoveInvocation(component.pluginId, target.identity.cwd, options.context.env),
          runner,
        );
        const residue = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (residue.state !== 'absent') {
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
          args: ['plugin', 'list'],
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
      if (target.identity.platform === 'codex') {
        const config = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const marketplace = config.snapshot.marketplaces[MARKETPLACE_NAME];
        if (marketplace && (
          marketplace.sourceType !== 'local'
          || marketplace.sourcePointsToManifest
          || path.normalize(marketplace.source ?? '') !== path.normalize(resolveAwHome(options.context.env))
        )) {
          throw new Error('Codex marketplace aw 已由 foreign source 占用，拒绝覆盖。');
        }
      } else {
        const state = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        if (state.marketplaceState === 'foreign') {
          throw new Error('Claude marketplace aw 已由 foreign source 占用，拒绝覆盖。');
        }
      }
      const marketplaceRoot = await mirrorCatalog(plan.catalog, options.context.env);
      const pluginId = `${target.identity.pluginName}@${MARKETPLACE_NAME}`;
      await withActiveMarketplaceRuntimeLease(options.context.env, async () => {
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
            args: ['plugin', 'list'],
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
            after.marketplaceDeclaredState !== 'canonical'
            || after.marketplaceMaterializedState !== 'canonical'
            || after.pluginState !== 'present'
            || !after.pluginEnabled
            || !after.pluginVersions.includes(target.identity.pluginVersion)
          ) {
            throw new Error(
              `Claude native install postcheck 失败：declaredMarketplace=${after.marketplaceDeclaredState}，materializedMarketplace=${after.marketplaceMaterializedState}，plugin=${after.pluginState}，enabled=${after.pluginEnabled}，versions=${after.pluginVersions.join(',')}。`,
            );
          }
        }
      });
    },
    writeArtifacts: async (target) => {
      const plan = options.plans.get(target);
      if (!plan) throw new Error('Missing rebuild integration plan.');
      const writeAll = async (): Promise<readonly GeneratedArtifact[]> => {
        for (const write of plan.writes) await write.write();
        return plan.writes.map((write) => write.artifact);
      };
      return target.identity.platform === 'codex' && target.identity.scope === 'user'
        ? withActiveMarketplaceRuntimeLease(options.context.env, writeAll)
        : writeAll();
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
        const canonicalRepoRoot = await assertCanonicalProjectManagedRoots({
          cwd: input.cwd,
          rootNames: input.platform === 'codex' ? ['.agents', '.codex'] : ['.claude'],
          managedPaths: input.platform === 'codex'
            ? ['.codex/config.toml', '.codex/hooks.json']
            : ['.claude/settings.json'],
        });
        input = { ...input, cwd: canonicalRepoRoot };
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
        ...(write.additionalComponents ?? []),
        ...(write.component ? [write.component] : []),
      ]);
      const optionalComponents = writes
        .filter((write) => write.optional)
        .flatMap((write) => [
          ...(write.additionalComponents ?? []),
          ...(write.component ? [write.component] : []),
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
            )]
        : [path.join(configDir, 'skills')];
      const scanSkills = () => Promise.all(skillRoots.map((root) => scanOwnedSkills({
        root,
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
      })));
      const scannedSkills = (await (
        input.platform === 'codex'
          && input.scope === 'user'
          && input.readOnlyInspectionPlan !== true
          ? withActiveMarketplaceRuntimeLease(options.context.env, scanSkills)
          : scanSkills()
      )).flat();
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
            scanConfig: true,
            scanHooks: true,
            ignoreReadErrors: true,
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
      const nativePlugin = (nativeRequired || nativeCleanupCandidate)
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
      const nativeVersion = nativeRequired
        && input.command !== 'cleanup'
        && input.command !== 'uninstall'
        ? [createNativeVersionComponent({
            pluginName: input.plugin.manifest.name,
            pluginVersion: input.plugin.manifest.version,
            platform: input.platform,
            scope: input.scope,
            cwd: input.cwd,
            env: options.context.env,
          })]
        : [];
      if (
        nativeRequired
        && input.command !== 'cleanup'
        && input.command !== 'uninstall'
      ) desiredComponents.push(...nativePlugin, ...marketplace, ...nativeVersion);
      const allComponents = dedupeComponents([
        ...desiredComponents,
        ...optionalComponents,
        ...(input.platform === 'codex' ? sharedComponents : []),
        ...scannedText,
        ...scannedSkills,
        ...historicalComponents,
        ...(input.platform === 'claude' ? sharedComponents : []),
        ...nativePlugin,
        ...marketplace,
        ...nativeVersion,
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
    nativeProbe: integration.driver.probeNativeHealth ?? integration.driver.probeNative,
    verifyHealth: true,
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
    const canonicalRepoRoot = await assertCanonicalProjectManagedRoots({
      cwd: options.cwd,
      rootNames: options.platform === 'codex' ? ['.agents', '.codex'] : ['.claude'],
      managedPaths: options.platform === 'codex'
        ? ['.codex/config.toml', '.codex/hooks.json']
        : ['.claude/settings.json'],
    });
    options = { ...options, cwd: canonicalRepoRoot };
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
    const installed = await readJsonObjectIfExists(
      resolveClaudePaths(options.cwd, options.scope, options.env).installedPluginsPath,
      'Claude installed_plugins',
    );
    const installedPlugins = installed.plugins;
    if (installedPlugins !== undefined && (
      !installedPlugins || typeof installedPlugins !== 'object' || Array.isArray(installedPlugins)
    )) throw new Error('Claude installed_plugins.plugins 必须是 object。');
    const candidates = new Set<string>();
    for (const [pluginKey, raw] of Object.entries(
      (installedPlugins as Record<string, unknown> | undefined) ?? {},
    )) {
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        const record = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : null;
        const name = typeof record?.name === 'string'
          ? record.name
          : pluginKey.includes('@') ? pluginKey.slice(0, pluginKey.indexOf('@')) : pluginKey;
        if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) candidates.add(name);
      }
    }
    const rawSettings = await readJsonObjectIfExists(
      resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath,
      'Claude settings',
    );
    const settingsPlugins = rawSettings.plugins;
    const settingsInstalled = settingsPlugins
      && typeof settingsPlugins === 'object'
      && !Array.isArray(settingsPlugins)
      ? (settingsPlugins as Record<string, unknown>).installed
      : undefined;
    if (settingsInstalled !== undefined && (
      !settingsInstalled || typeof settingsInstalled !== 'object' || Array.isArray(settingsInstalled)
    )) throw new Error('Claude settings.plugins.installed 必须是 object。');
    for (const name of Object.keys(
      (settingsInstalled as Record<string, unknown> | undefined) ?? {},
    )) {
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) candidates.add(name);
    }
    const enabledPlugins = rawSettings.enabledPlugins;
    if (enabledPlugins !== undefined && (
      !enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)
    )) throw new Error('Claude settings.enabledPlugins 必须是 object。');
    for (const pluginId of Object.keys(
      (enabledPlugins as Record<string, unknown> | undefined) ?? {},
    )) {
      const suffix = `@${MARKETPLACE_NAME}`;
      if (!pluginId.endsWith(suffix)) continue;
      const name = pluginId.slice(0, -suffix.length);
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) candidates.add(name);
    }
    for (const name of candidates) {
      const state = await readClaudeNativeState({
        pluginName: name,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      });
      if (state.pluginState === 'present') names.add(name);
    }
  }
  return [...names].sort();
}
