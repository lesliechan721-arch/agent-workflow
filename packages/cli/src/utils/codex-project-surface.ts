import path from 'node:path';

import fs from 'fs-extra';

import type {
  CodexCapabilitySnapshot,
  CodexProjectManagedKind,
  GeneratedArtifact,
  PluginArtifactTargetDefinition,
  PluginMeta,
  Scope,
  TrackingPluginRecord,
} from '../types.js';
import { readRenderedCodexMcpServersFile } from './codex-config.js';
import { resolvePlatformHookDefinitions } from './hooks-contract.js';
import { resolvePlatformEntries } from './platform-entries.js';

export interface NormalizedCodexCapabilitySnapshot {
  requiresNativePlugin: boolean;
  hasRepoManagedArtifacts: boolean;
  projectManagedKinds: CodexProjectManagedKind[];
  hasManagedKindDetails: boolean;
}

export type CodexProjectRepoArtifact =
  | {
    kind: 'skill';
    artifactKey: string;
    path: string;
  }
  | {
    kind: 'mcpServer';
    artifactKey: string;
    path: string;
  };

export const CODEX_PROJECT_MANAGED_KIND_ORDER: CodexProjectManagedKind[] = [
  'skill',
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
];

const CODEX_PROJECT_MANAGED_KIND_SET = new Set<CodexProjectManagedKind>(
  CODEX_PROJECT_MANAGED_KIND_ORDER,
);

function trimDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

export function normalizeCodexProjectManagedKinds(
  values: CodexCapabilitySnapshot['projectManagedKinds'] | CodexCapabilitySnapshot['managedKinds'],
): CodexProjectManagedKind[] {
  const selected = new Set<CodexProjectManagedKind>();
  for (const value of values ?? []) {
    if (CODEX_PROJECT_MANAGED_KIND_SET.has(value)) {
      selected.add(value);
    }
  }
  return CODEX_PROJECT_MANAGED_KIND_ORDER.filter((kind) => selected.has(kind));
}

export function normalizeCodexCapabilitySnapshot(
  snapshot: CodexCapabilitySnapshot | undefined,
): NormalizedCodexCapabilitySnapshot {
  const rawManagedKinds = snapshot?.projectManagedKinds ?? snapshot?.managedKinds;
  const projectManagedKinds = normalizeCodexProjectManagedKinds(rawManagedKinds);
  const hasManagedKindDetails = Array.isArray(rawManagedKinds);
  return {
    requiresNativePlugin: snapshot?.requiresNativePlugin === true,
    hasRepoManagedArtifacts: hasManagedKindDetails
      ? projectManagedKinds.length > 0
      : snapshot?.hasRepoManagedArtifacts === true,
    projectManagedKinds,
    hasManagedKindDetails,
  };
}

export function codexCapabilitySnapshotsEqual(
  installedSnapshot: CodexCapabilitySnapshot | undefined,
  currentSnapshot: CodexCapabilitySnapshot | undefined,
): boolean {
  const installed = normalizeCodexCapabilitySnapshot(installedSnapshot);
  const current = normalizeCodexCapabilitySnapshot(currentSnapshot);
  if (installed.requiresNativePlugin !== current.requiresNativePlugin) {
    return false;
  }

  if (installed.hasManagedKindDetails && current.hasManagedKindDetails) {
    return JSON.stringify(installed.projectManagedKinds) === JSON.stringify(current.projectManagedKinds);
  }

  return installed.hasRepoManagedArtifacts === current.hasRepoManagedArtifacts;
}

export function codexCapabilitySnapshotHasRepoManagedArtifacts(
  snapshot: CodexCapabilitySnapshot | undefined,
): boolean {
  return normalizeCodexCapabilitySnapshot(snapshot).hasRepoManagedArtifacts;
}

export function requiresCodexNativePlugin(plugin: PluginMeta, scope: Scope): boolean {
  if (scope === 'project') {
    return false;
  }

  return Boolean(
    plugin.manifest.skills ||
      plugin.manifest.slashCommands ||
      plugin.manifest.mcpServers ||
      plugin.manifest.apps,
  );
}

export function getCodexDynamicArtifactTargets(
  plugin: PluginMeta,
  options: { scope?: Scope; requiresCodexProjectConfig?: boolean } = {},
): PluginArtifactTargetDefinition[] {
  return (plugin.manifest.artifacts?.targets ?? []).filter((target) => {
    if (target.platform !== 'codex') {
      return false;
    }
    if (options.scope && !target.scopes.includes(options.scope)) {
      return false;
    }
    if (
      options.requiresCodexProjectConfig !== undefined &&
      target.requiresCodexProjectConfig !== options.requiresCodexProjectConfig
    ) {
      return false;
    }
    return true;
  });
}

function addCodexDynamicProjectManagedKinds(
  plugin: PluginMeta,
  kinds: Set<CodexProjectManagedKind>,
): void {
  for (const target of getCodexDynamicArtifactTargets(plugin, { scope: 'project' })) {
    if (target.projectManagedKind) {
      kinds.add(target.projectManagedKind);
    }
  }
}

export function getCodexProjectManagedKinds(plugin: PluginMeta): CodexProjectManagedKind[] {
  const kinds = new Set<CodexProjectManagedKind>();
  if (plugin.manifest.skills || plugin.manifest.slashCommands) {
    kinds.add('skill');
  }
  if (plugin.manifest.mcpServers) {
    kinds.add('mcpServer');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex').length > 0) {
    kinds.add('instruction');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex').length > 0) {
    kinds.add('permission');
  }
  if (resolvePlatformHookDefinitions(plugin.manifest, 'codex').length > 0) {
    kinds.add('hook');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex').length > 0) {
    kinds.add('agent');
  }
  addCodexDynamicProjectManagedKinds(plugin, kinds);

  return CODEX_PROJECT_MANAGED_KIND_ORDER.filter((kind) => kinds.has(kind));
}

export function hasCodexProjectManagedArtifacts(plugin: PluginMeta): boolean {
  return getCodexProjectManagedKinds(plugin).length > 0;
}

export function hasRepoManagedArtifacts(plugin: PluginMeta): boolean {
  return hasCodexProjectManagedArtifacts(plugin);
}

export function pluginDeclaresCodexProjectConfigBackedArtifacts(
  plugin: PluginMeta,
): boolean {
  return Boolean(
    plugin.manifest.mcpServers ||
      resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex').length > 0 ||
      getCodexDynamicArtifactTargets(plugin, {
        scope: 'project',
        requiresCodexProjectConfig: true,
      }).length > 0,
  );
}

export function trackingRecordTouchesCodexProjectConfig(
  trackingRecord: TrackingPluginRecord | undefined,
): boolean {
  return Boolean(
    trackingRecord?.artifacts.some((artifact) =>
      artifact.kind === 'instruction' || artifact.kind === 'mcpServer',
    ),
  );
}

export function needsCodexProjectConfigAccess(
  plugin: PluginMeta,
  trackingRecord: TrackingPluginRecord | undefined,
): boolean {
  return pluginDeclaresCodexProjectConfigBackedArtifacts(plugin) ||
    trackingRecordTouchesCodexProjectConfig(trackingRecord);
}

export async function collectDeclaredCodexProjectSkillKeys(plugin: PluginMeta): Promise<string[]> {
  const skillRoot = plugin.manifest.skills
    ? path.resolve(plugin.rootDir, trimDotSlash(plugin.manifest.skills))
    : undefined;
  const codexSkillRoot = path.join(plugin.rootDir, 'codex', 'skills');
  const slashCommandRoot = plugin.manifest.slashCommands
    ? path.resolve(plugin.rootDir, trimDotSlash(plugin.manifest.slashCommands))
    : undefined;
  const keys = new Set<string>();

  for (const root of [skillRoot, codexSkillRoot]) {
    if (!root || !(await fs.pathExists(root))) {
      continue;
    }

    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (await fs.pathExists(path.join(root, entry.name, 'SKILL.md'))) {
        keys.add(entry.name);
      }
    }
  }

  if (slashCommandRoot && await fs.pathExists(slashCommandRoot)) {
    const entries = await fs.readdir(slashCommandRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        keys.add(path.basename(entry.name, '.md'));
      }
    }
  }

  return [...keys].sort();
}

export async function collectDeclaredCodexProjectMcpServerKeys(plugin: PluginMeta): Promise<string[]> {
  if (!plugin.manifest.mcpServers) {
    return [];
  }

  const mcpPath = path.resolve(plugin.rootDir, trimDotSlash(plugin.manifest.mcpServers));
  if (!(await fs.pathExists(mcpPath))) {
    return [];
  }

  return Object.keys(await readRenderedCodexMcpServersFile(mcpPath)).sort();
}

export async function collectDesiredCodexProjectRepoArtifacts(
  plugin: PluginMeta,
  repoRoot: string,
): Promise<CodexProjectRepoArtifact[]> {
  const [skillKeys, mcpServerKeys] = await Promise.all([
    collectDeclaredCodexProjectSkillKeys(plugin),
    collectDeclaredCodexProjectMcpServerKeys(plugin),
  ]);
  const artifacts: CodexProjectRepoArtifact[] = [];

  for (const skillKey of skillKeys) {
    artifacts.push({
      kind: 'skill',
      artifactKey: skillKey,
      path: path.join(repoRoot, '.agents', 'skills', skillKey),
    });
  }

  for (const serverKey of mcpServerKeys) {
    artifacts.push({
      kind: 'mcpServer',
      artifactKey: serverKey,
      path: path.join(repoRoot, '.codex', 'config.toml'),
    });
  }

  return artifacts;
}

export const CODEX_REPO_MANAGED_ITEM_KIND_ORDER: GeneratedArtifact['kind'][] = [
  'skill',
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
];
