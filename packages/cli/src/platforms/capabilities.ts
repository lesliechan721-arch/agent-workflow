import { COMPONENT_KINDS, getPlatformFeatureRegistry, type PlatformCapabilitiesV1, type PlatformId, type Scope } from '@lesliechan721/aw-plugin-core/manifest';
import { compareStrictSemVer } from '../utils/manifest.js';
import { identityDigest } from './identity.js';
import type { CapabilityInput, QualifiedPlatformProfile } from './contracts.js';

const PROFILE_BASELINES: Record<PlatformId, string> = {
  codex: '0.155.0', claude: '2.1.292', cursor: 'desktop-3.29_cli-2026.11.05-86047df',
  antigravity: 'cli-1.3.4', opencode: '2.0.0', pi: '1.0.0', gemini: '0.63.0',
  copilot: '1.0.95', grok: 'native-plugin-interface', generic: 'skills-v1',
};
/** Fixed qualification evidence, not a promise inferred from the installed version. */
export function getQualifiedPlatformProfile(platform: PlatformId, host: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {}): QualifiedPlatformProfile {
  const kinds = Object.fromEntries(COMPONENT_KINDS.map((kind) => {
    const generic = platform === 'generic';
    const supported = generic && kind === 'skill';
    const supplement = platform === 'codex' && kind === 'agent' || platform === 'grok' && kind === 'instruction';
    return [kind, { status: supported ? 'supported' : generic ? 'unsupported' : 'unverified',
      reasonCodes: supported ? [] : [generic ? 'interface-unsupported' : 'capability-unverified'],
      delivery: generic ? supported ? ['generic-files'] : [] : [supplement ? 'managed-host-resource'
        : platform === 'pi' || platform === 'opencode' || platform === 'gemini' ? 'native-extension' : 'native-package'] }];
  })) as PlatformCapabilitiesV1['kinds'];
  const features: PlatformCapabilitiesV1['features'] = Object.fromEntries(Object.entries(getPlatformFeatureRegistry()).filter(([, definition]) => !definition.derivedFromKind).map(([id, definition]) => [id, {
    status: platform === 'generic' ? 'unsupported' : 'unverified', reasonCodes: [platform === 'generic' ? 'interface-unsupported' : 'capability-unverified'],
    ...(definition.values ? { values: [] } : {}),
  }]));
  if (platform === 'codex') features['instruction.after-compaction'] = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
  const profile: QualifiedPlatformProfile = { id: `${platform}:${PROFILE_BASELINES[platform]}`, platform, kinds, features, agentConsumers: [] };
  // Finite native qualification: exact CLI versions in the recorded host cells.
  // It does not qualify invocation metadata, Hooks, MCP execution, or model behavior.
  const skillVersion = platform === 'codex' ? '0.167.0' : platform === 'pi' ? '1.5.0' : platform === 'copilot' ? '1.0.95' : platform === 'claude' ? '2.1.317'
    : platform === 'gemini' ? '0.67.0' : platform === 'grok' ? '1.0.77' : platform === 'opencode' ? '2.0.0' : platform === 'antigravity' ? '1.3.4' : null;
  const hostPlatform = host.platform ?? process.platform;
  const hostArch = host.arch ?? process.arch;
  const qualifiedSkillHosts = platform === 'grok'
    ? ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64']
    : ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
  const qualifiedSkillHost = qualifiedSkillHosts.includes(`${hostPlatform}-${hostArch}`);
  if (skillVersion && qualifiedSkillHost) {
    profile.id += `:${hostPlatform}-${hostArch}-cli-${skillVersion}-skills`;
    kinds.skill = { ...kinds.skill, status: 'supported', reasonCodes: [] };
    profile.qualifiedConsumers = { skill: [{ product: 'cli', version: skillVersion }] };
    profile.qualificationEvidence = [{ reference: platform === 'antigravity' ? 'scripts/qualification/evidence/native-antigravity-user-skills-six-hosts-2026-11-14.json'
      : platform === 'grok' ? 'scripts/qualification/evidence/native-grok-skills-2026-11-12.json'
      : platform === 'copilot' ? 'scripts/qualification/evidence/native-copilot-skills-2026-11-12.json'
      : platform === 'gemini' ? 'scripts/qualification/evidence/native-gemini-skills-2026-11-12.json'
      : platform === 'claude' ? 'scripts/qualification/evidence/native-claude-skills-2026-11-12.json'
      : platform === 'opencode' ? 'scripts/qualification/evidence/native-opencode-skills-2026-11-13.json'
      : 'scripts/qualification/evidence/native-skills-2026-11-12.json',
      product: 'cli', version: skillVersion, platform: hostPlatform, arch: hostArch, scopes: platform === 'grok' || platform === 'gemini' || platform === 'antigravity' ? ['user'] : ['user', 'project'], kinds: ['skill'], features: [],
      limitations: [...(platform === 'claude' ? ['native-management-and-effective-activation-only', 'skill-discovery-unverified', 'skill-loading-unverified']
        : platform === 'antigravity' ? ['native-management-effective-scope-and-consumer-bytes-only', 'project-unverified', 'skill-loading-unverified']
        : platform === 'opencode' ? ['native-management-effective-scope-and-consumer-bytes-only', 'process-receipts-do-not-qualify-provider-or-os']
        : ['host-discovery-and-lifecycle-only']), 'model-behavior-unverified', 'invocation-controls-unverified', 'adapter-end-to-end-not-qualified-by-this-record'] }];
    if (platform === 'grok') profile.qualificationEvidence.push({
      reference: 'scripts/qualification/evidence/native-grok-project-skills-2026-11-13.json',
      product: 'cli', version: skillVersion, platform: hostPlatform, arch: hostArch, scopes: ['project'], kinds: ['skill'], features: [],
      limitations: ['native-management-and-effective-activation-only', 'fixture-project-trust-required', 'skill-discovery-unverified',
        'skill-loading-unverified', 'model-behavior-unverified', 'invocation-controls-unverified', 'adapter-end-to-end-not-qualified-by-this-record'],
    });
    if (platform === 'gemini') profile.qualificationEvidence.push({
      reference: 'scripts/qualification/evidence/native-gemini-project-skills-2026-11-13.json',
      product: 'cli', version: skillVersion, platform: hostPlatform, arch: hostArch, scopes: ['project'], kinds: ['skill'], features: [],
      limitations: ['native-management-and-effective-activation-only', 'fixture-project-default-disable-rule-required',
        'skill-loading-unverified', 'model-behavior-unverified', 'invocation-controls-unverified', 'adapter-end-to-end-not-qualified-by-this-record'],
    });
  }
  return profile;
}
/** Apply recorded scope limits to both local and authoring capability views. */
export function getQualifiedKindsForScope(profile: QualifiedPlatformProfile, scope: Scope): PlatformCapabilitiesV1['kinds'] {
  const kinds = structuredClone(profile.kinds);
  for (const kind of COMPONENT_KINDS) {
    const records = profile.qualificationEvidence?.filter((record) => record.kinds.includes(kind));
    if (records?.length && !records.some((record) => record.scopes.includes(scope))) {
      kinds[kind] = { ...kinds[kind], status: 'unverified', reasonCodes: ['capability-unverified'] };
    }
  }
  return kinds;
}
export function getPlatformCapabilities(input: CapabilityInput, basis: 'local' | 'profile' = 'local'): PlatformCapabilitiesV1 {
  const { binding, renderUnit, profile, observation } = input;
  if (profile.platform !== binding.platform) throw new Error('platformProfileMismatch');
  // A shared user package does not extend a user-only record to project activation.
  const kinds = getQualifiedKindsForScope(profile, binding.scope.kind);
  const features = structuredClone(profile.features);
  const consumers = renderUnit.consumers;
  for (const kind of COMPONENT_KINDS) {
    const qualified = profile.qualifiedConsumers?.[kind];
    if (qualified && consumers.some((consumer) => !qualified.some((entry) => entry.product === consumer.product && entry.version === consumer.version))) {
      kinds[kind] = { ...kinds[kind], status: 'unverified', reasonCodes: ['capability-unverified'] };
    }
  }
  for (const consumer of consumers) {
    if (consumer.availability === 'available' || consumer.availability === 'notApplicable') continue;
    const reason = consumer.availability === 'missing' ? 'client-missing' : consumer.availability === 'unsupported' ? 'version-unsupported' : 'capability-unverified';
    for (const fact of [...Object.values(kinds), ...Object.values(features)]) {
      fact.status = consumer.availability === 'unknown' ? 'unverified' : 'unsupported';
      fact.reasonCodes = [...new Set([...fact.reasonCodes, reason])];
      if ('values' in fact) fact.values = [];
    }
  }
  if (binding.platform === 'pi') {
    const prerequisite = observation.prerequisites.agentConsumers;
    const candidates = prerequisite.candidates.filter((candidate) => consumers.some((consumer) => consumer.id === candidate.productId)
      && (candidate.scope.kind === 'user' || candidate.scope.kind === renderUnit.renderScope.kind) && (candidate.scope.kind !== 'project'
        || renderUnit.renderScope.kind === 'project' && candidate.scope.projectRoot === renderUnit.renderScope.projectRoot));
    let reason: string | null = null;
    let status: 'unsupported' | 'unverified' = 'unverified';
    if (prerequisite.observation === 'unknown') reason = 'capability-unverified';
    else if (candidates.length === 0) { reason = 'consumer-missing'; status = 'unsupported'; }
    else if (candidates.every((candidate) => candidate.enabled === 'no')) { reason = 'consumer-disabled'; status = 'unsupported'; }
    else if (candidates.some((candidate) => candidate.trust === 'blocked' || candidate.trust === 'required' || candidate.packageAccess === 'denied')) { reason = 'policy-blocked'; status = 'unsupported'; }
    else if (candidates.length !== 1) reason = 'capability-unverified';
    else {
      const candidate = candidates[0]!;
      const qualified = profile.agentConsumers.find((entry) => entry.id === candidate.id && entry.qualified && candidate.version
        && compareStrictSemVer(candidate.version, entry.minimumVersion) >= 0 && candidate.settings.promptMode !== 'unknown'
        && entry.promptModes.includes(candidate.settings.promptMode));
      if (!qualified || candidate.enabled !== 'yes' || candidate.trust !== 'trusted' || candidate.packageAccess !== 'allowed'
        || candidate.settings.loadExtensions === 'unknown') reason = 'capability-unverified';
      else {
        kinds.agent = { ...kinds.agent, status: 'supported', reasonCodes: [] };
        for (const [id, fact] of Object.entries(qualified.features)) features[id] = structuredClone(fact);
      }
    }
    if (reason) {
      kinds.agent = { ...kinds.agent, status, reasonCodes: [reason] };
      for (const id of Object.keys(features)) if (id.startsWith('agent.')) features[id] = { ...features[id]!, status, reasonCodes: [reason], ...('values' in features[id]! ? { values: [] } : {}) };
      const coverage = features['instruction.coverage'];
      if (coverage?.values) coverage.values = coverage.values.filter((value) => value === 'main');
    }
  }
  return { schemaVersion: 1, platform: binding.platform, scope: renderUnit.renderScope.kind, basis, profileId: profile.id,
    consumers: consumers.map((consumer) => ({ id: identityDigest({ productId: consumer.id }), product: consumer.product, version: consumer.version,
      ...(binding.platform === 'pi' ? { agentConsumers: observation.prerequisites.agentConsumers.candidates.filter((candidate) => candidate.productId === consumer.id)
        .map(({ id, version, scope, enabled, trust, packageAccess, settings, configurationEvidence }) => ({ id, version, scope: scope.kind, enabled, trust, packageAccess, settings, configurationEvidence })) } : {}) })), kinds, features };
}
