import {
  COMPONENT_KINDS, getPlatformFeatureRegistry, getPlatformHookHandlerRegistry, resolvePlatformAgentNamingMode,
  type PlatformCapabilitiesV3, type PlatformId, type Scope,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { CapabilityInput, QualifiedPlatformProfile } from './contracts.js';

const PROFILE_BASELINES: Record<PlatformId, string> = {
  codex: '0.155.0', claude: '2.1.292', cursor: 'desktop-3.29_cli-2026.11.05-86047df',
  antigravity: 'cli-1.3.4', opencode: '2.0.0', pi: '1.0.0',
  copilot: '1.0.95', grok: 'native-plugin-interface', generic: 'skills-v1',
};
const HOOK_HANDLERS = getPlatformHookHandlerRegistry();

/** Standard writer mappings and confirmed interface limits, independent of historical host sessions. */
export function getQualifiedPlatformProfile(platform: PlatformId): QualifiedPlatformProfile {
  const kinds = Object.fromEntries(COMPONENT_KINDS.map((kind) => {
    const supported = platform === 'generic' ? kind === 'skill' : platform !== 'opencode' || kind !== 'agent';
    const supplement = platform === 'codex' && kind === 'agent' || platform === 'grok' && kind === 'instruction';
    return [kind, {
      status: supported ? 'supported' : 'unsupported',
      reasonCodes: supported ? [] : ['interface-unsupported'],
      delivery: !supported ? [] : platform === 'generic' ? ['generic-files'] : [supplement ? 'managed-host-resource'
        : platform === 'pi' || platform === 'opencode' ? 'native-extension' : 'native-package'],
    }];
  })) as PlatformCapabilitiesV3['kinds'];
  const registry = getPlatformFeatureRegistry();
  const features: PlatformCapabilitiesV3['features'] = Object.fromEntries(
    Object.entries(registry).filter(([, definition]) => !definition.derivedFromKind).map(([id, definition]) => [id, {
      status: 'unsupported', reasonCodes: ['interface-unsupported'], ...(definition.values ? { values: [] } : {}),
    }]),
  );
  const profile = { id: `${platform}:${PROFILE_BASELINES[platform]}`, platform, kinds, features };
  if (platform === 'generic') return profile;

  const support = (id: string, values?: string[]): void => {
    features[id] = { status: 'supported', reasonCodes: [], ...(values === undefined ? {} : { values }) };
  };
  if (kinds.agent.status === 'supported') {
    support('agent.execution', ['isolated-context']);
    support('agent.prompt-mode', platform === 'claude' ? ['host-default', 'replace'] : ['host-default']);
    if (platform !== 'grok') support('agent.model', platform === 'antigravity' ? ['inherit', 'flash_lite', 'flash', 'pro'] : undefined);
    if (platform === 'claude') support('agent.tools', ['allowlist']);
    if (platform === 'copilot') support('agent.tools', ['none', 'allowlist']);
    if (platform === 'pi') support('agent.declaration-protocol', ['aw.pi.agents.v1']);
  }
  if (platform === 'claude') {
    for (const feature of ['skill.model', 'skill.agent', 'skill.hooks', 'skill.paths', 'skill.invocation.hint', 'skill.arguments']) support(feature);
    support('skill.execution', ['isolated-context']);
    support('skill.shell', ['bash', 'powershell']);
    support('skill.background', ['true', 'false']);
    support('skill.effort', [...registry['skill.effort']!.values!]);
  }
  if (platform === 'codex') support('skill.runtime-config', ['aw.installed-runtime-config.v2']);
  const supportsHiddenSkills = ['claude', 'copilot', 'grok'].includes(platform);
  support('skill.invocation.manual', supportsHiddenSkills ? ['true', 'false'] : ['true']);
  support('skill.invocation.model', ['true', 'false']);
  support('skill.visibility', supportsHiddenSkills ? ['visible', 'hidden'] : ['visible']);

  support('mcp.transport', ['stdio', 'http', ...(['claude', 'copilot', 'cursor', 'grok'].includes(platform) ? ['sse'] : [])]);
  const coverage = ['main'];
  if (['codex', 'claude', 'copilot', 'grok', 'antigravity'].includes(platform)) coverage.push('plugin-agents');
  if (['codex', 'claude'].includes(platform)) coverage.push('other-agents');
  support('instruction.coverage', coverage);
  if (platform === 'cursor' || platform === 'antigravity') support('instruction.paths');
  const handlers = HOOK_HANDLERS[platform];
  const matchers: string[] = [];
  for (const dialect of ['common', 'native'] as const) {
    for (const [event, handler] of Object.entries(handlers[dialect])) {
      if (handler.nativeEvent === null) continue;
      const key = `${dialect}.${event}`;
      // A command can observe an event without a response protocol. Active feedback requires its wire contract.
      support(`hook.${key}`, handler.protocol ? Object.keys(handler.protocol.responses).sort() : ['notify']);
      if (handler.matcherAllowed === true) matchers.push(key);
    }
  }
  if (matchers.length) support('hook.matcher', matchers);
  return profile;
}

/** Local and authoring preparation start from the same platform-only interface. */
export function capabilitiesFromProfile(profile: QualifiedPlatformProfile, scope: Scope, basis: PlatformCapabilitiesV3['basis']): PlatformCapabilitiesV3 {
  return {
    schemaVersion: 3, platform: profile.platform, scope, basis,
    agentNamingMode: resolvePlatformAgentNamingMode(profile.platform),
    kinds: structuredClone(profile.kinds), features: structuredClone(profile.features),
  };
}

/** The renderer and persistent input evidence consume the same capability facts. */
export function toPlatformCapabilitiesView(input: PlatformCapabilitiesV3): PlatformCapabilitiesV3 {
  const sorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();
  const kinds = Object.fromEntries(COMPONENT_KINDS.map((kind) => {
    const { status, reasonCodes, delivery } = input.kinds[kind];
    return [kind, { status, reasonCodes: sorted(reasonCodes), delivery: sorted(delivery) }];
  })) as PlatformCapabilitiesV3['kinds'];
  const features = Object.fromEntries(Object.keys(input.features).sort().map((id) => {
    const { status, reasonCodes, values, maxBytes } = input.features[id]!;
    return [id, { status, reasonCodes: sorted(reasonCodes),
      ...(values === undefined ? {} : { values: sorted(values) }), ...(maxBytes === undefined ? {} : { maxBytes }) }];
  }));
  return { schemaVersion: 3, platform: input.platform, scope: input.scope, basis: input.basis,
    agentNamingMode: input.agentNamingMode, kinds, features };
}

export function getPlatformCapabilities(input: CapabilityInput): PlatformCapabilitiesV3 {
  const { binding, renderUnit, profile } = input;
  if (profile.platform !== binding.platform) throw new Error('platformProfileMismatch');
  const capabilities = capabilitiesFromProfile(profile, renderUnit.renderScope.kind, 'local');
  const consumers = renderUnit.consumers;
  // Excluded entries remain facts. They do not revoke another complete path.
  const available = consumers.some((consumer) => consumer.availability === 'available' || consumer.availability === 'notApplicable');
  if (!available && consumers.length) {
    const reasons = consumers.map(({ availability }) => availability === 'missing' ? 'client-missing'
      : availability === 'unsupported' ? 'version-unsupported' : 'client-unknown');
    for (const fact of [...Object.values(capabilities.kinds), ...Object.values(capabilities.features)]) {
      fact.status = 'unsupported';
      fact.reasonCodes = reasons;
      if ('values' in fact) fact.values = [];
    }
  }
  return toPlatformCapabilitiesView(capabilities);
}
