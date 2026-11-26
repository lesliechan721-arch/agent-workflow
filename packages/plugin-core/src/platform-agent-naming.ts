import type { PlatformId } from './types.js';

export type PlatformAgentNamingMode = 'host-plugin' | 'aw-prefix' | 'unsupported';

export interface PlatformAgentNaming {
  mode: PlatformAgentNamingMode;
  /** Prefix in the projected filename and name field. */
  filePrefix: string;
  /** Prefix in the actual host invocation name, including the separator. */
  invocationPrefix: string;
}

const AGENT_NAMING_MODES: Readonly<Record<PlatformId, PlatformAgentNamingMode>> = {
  codex: 'aw-prefix',
  claude: 'host-plugin',
  antigravity: 'aw-prefix',
  cursor: 'aw-prefix',
  opencode: 'unsupported',
  pi: 'aw-prefix',
  copilot: 'aw-prefix',
  grok: 'aw-prefix',
  generic: 'unsupported',
};
const PLUGIN_IDENTITY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Internal lookup normalization; not every logical name is a valid reference key. */
export function tryNativeComponentName(value: string): string | undefined {
  const name = value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return name && name.length <= 128 ? name : undefined;
}

export function nativeComponentName(value: string): string {
  const name = tryNativeComponentName(value);
  if (name === undefined) throw new Error('platformProjectionNameInvalid');
  return name;
}

export function resolvePlatformAgentNamingMode(platform: PlatformId): PlatformAgentNamingMode {
  return AGENT_NAMING_MODES[platform];
}

export function resolvePlatformAgentNaming(platform: PlatformId,
  plugin: { sourceId: string; name: string } | { pluginId: string; name?: string; sourceId?: string }): PlatformAgentNaming {
  let sourceId: string;
  let name: string;
  if ('pluginId' in plugin) {
    if (typeof plugin.pluginId !== 'string') throw new Error('platformPluginIdentityInvalid');
    const parts = plugin.pluginId.split('/');
    if (parts.length !== 2) throw new Error('platformPluginIdentityInvalid');
    [sourceId, name] = parts as [string, string];
    if ((plugin.name !== undefined && plugin.name !== name) || (plugin.sourceId !== undefined && plugin.sourceId !== sourceId)) {
      throw new Error('platformPluginIdentityInvalid');
    }
  } else {
    ({ sourceId, name } = plugin);
  }
  if (typeof sourceId !== 'string' || typeof name !== 'string' || !PLUGIN_IDENTITY_SEGMENT.test(sourceId) || !PLUGIN_IDENTITY_SEGMENT.test(name)) {
    throw new Error('platformPluginIdentityInvalid');
  }
  const mode = resolvePlatformAgentNamingMode(platform);
  if (mode === 'host-plugin') return { mode, filePrefix: '', invocationPrefix: `${name}:` };
  if (mode === 'aw-prefix') {
    const prefix = `aw-${sourceId}-${name}-`;
    return { mode, filePrefix: prefix, invocationPrefix: prefix };
  }
  return { mode, filePrefix: '', invocationPrefix: '' };
}

export function resolveProjectedAgentName(agentNaming: PlatformAgentNaming, role: string): string {
  const name = `${agentNaming.filePrefix}${nativeComponentName(role)}`;
  if (agentNaming.mode === 'unsupported' || !/^[A-Za-z0-9._-]+$/u.test(name) || name.length > 128) {
    throw new Error('platformProjectionNameInvalid');
  }
  return name;
}

export function resolveAgentInvocationName(agentNaming: PlatformAgentNaming, role: string): string {
  const projectedName = resolveProjectedAgentName(agentNaming, role);
  return `${agentNaming.invocationPrefix}${projectedName.slice(agentNaming.filePrefix.length)}`;
}
