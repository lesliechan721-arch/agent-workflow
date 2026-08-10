import type {
  CodexProjectManagedKind,
  PluginArtifactTargetDefinition,
  PluginMeta,
  Scope,
} from '../types.js';
import { resolvePlatformHookDefinitions } from './hooks-contract.js';
import { resolvePlatformEntries } from './platform-entries.js';
import { supportsPlatform } from './platform-support.js';

const CODEX_PROJECT_MANAGED_KIND_ORDER: CodexProjectManagedKind[] = [
  'skill',
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
];

function codexTargets(plugin: PluginMeta, scope: Scope): PluginArtifactTargetDefinition[] {
  return (plugin.manifest.artifacts?.targets ?? []).filter((target) =>
    target.platform === 'codex' && target.scopes.includes(scope));
}

export function requiresCodexNativePlugin(plugin: PluginMeta, scope: Scope): boolean {
  if (!supportsPlatform(plugin.manifest, 'codex') || scope === 'project') return false;
  return Boolean(
    plugin.manifest.skills
    || plugin.manifest.slashCommands
    || plugin.manifest.mcpServers
    || plugin.manifest.apps
    || codexTargets(plugin, 'user').some((target) => target.target === 'codex.skill'),
  );
}

export function hasCodexProjectManagedArtifacts(plugin: PluginMeta): boolean {
  if (!supportsPlatform(plugin.manifest, 'codex')) return false;
  const kinds = new Set<CodexProjectManagedKind>();
  if (plugin.manifest.skills || plugin.manifest.slashCommands) kinds.add('skill');
  if (plugin.manifest.mcpServers) kinds.add('mcpServer');
  if (resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex').length > 0) {
    kinds.add('instruction');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex').length > 0) {
    kinds.add('permission');
  }
  if (resolvePlatformHookDefinitions(plugin.manifest, 'codex').length > 0) kinds.add('hook');
  if (resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex').length > 0) kinds.add('agent');
  for (const target of codexTargets(plugin, 'project')) {
    if (target.projectManagedKind) kinds.add(target.projectManagedKind);
  }
  return CODEX_PROJECT_MANAGED_KIND_ORDER.some((kind) => kinds.has(kind));
}
