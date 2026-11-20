import { COMPONENT_KINDS, getPlatformFeatureRegistry, type PlatformCapabilitiesV2, type PlatformId, type Scope } from '@lesliechan721/aw-plugin-core/manifest';
import { compareStrictSemVer } from '../utils/manifest.js';
import type { CapabilityInput, QualifiedPlatformProfile } from './contracts.js';
import { platformVersionSupported } from './discovery.js';

const PROFILE_BASELINES: Record<PlatformId, string> = {
  codex: '0.155.0', claude: '2.1.292', cursor: 'desktop-3.29_cli-2026.11.05-86047df',
  antigravity: 'cli-1.3.4', opencode: '2.0.0', pi: '1.0.0',
  copilot: '1.0.95', grok: 'native-plugin-interface', generic: 'skills-v1',
};

const CODEX_CLI_FEATURES = {
  'agent.execution': ['isolated-context'],
  'agent.prompt-mode': ['host-default'],
  'skill.runtime-config': ['aw.installed-runtime-config.v2'],
};

const MANUAL_SKILL_EVIDENCE = 'scripts/qualification/evidence/native-manual-skill-invocation-2026-11-20.json';
const CODEX_INVOCATION_CONTRACT = 'https://developers.openai.com/codex/skills';
const SKILL_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
const CURSOR_SKILL_HOSTS = ['linux-x64', 'darwin-arm64'];
const GROK_SKILL_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64'];
const LOCAL_INVOCATION_HOSTS = ['darwin-arm64'];
const PI_USER_INVOCATION_HOSTS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-arm64'];
interface SkillCliProfile {
  version: string;
  evidence: string;
  invocation?: { hosts: Partial<Record<Scope, readonly string[]>>; model: Array<'true' | 'false'>; minimumVersion?: string };
}
const SKILL_CLI_PROFILES: Partial<Record<PlatformId, SkillCliProfile>> = {
  codex: { version: '0.167.0', evidence: 'scripts/qualification/evidence/native-skills-2026-11-12.json',
    invocation: { hosts: { user: SKILL_HOSTS, project: SKILL_HOSTS }, model: ['false', 'true'], minimumVersion: PROFILE_BASELINES.codex } },
  claude: { version: '2.1.317', evidence: 'scripts/qualification/evidence/native-claude-skills-2026-11-12.json',
    invocation: { hosts: { user: SKILL_HOSTS, project: LOCAL_INVOCATION_HOSTS }, model: ['false'] } },
  // Antigravity parses the policy. Its authenticated session menu and automatic candidates are unverified.
  antigravity: { version: '1.3.4', evidence: 'scripts/qualification/evidence/native-antigravity-user-skills-six-hosts-2026-11-14.json' },
  cursor: { version: '2026.11.05-86047df', evidence: MANUAL_SKILL_EVIDENCE,
    invocation: { hosts: { user: CURSOR_SKILL_HOSTS, project: CURSOR_SKILL_HOSTS }, model: ['false'] } },
  // The Copilot ACP probe required an explicit --plugin-dir beyond ordinary AW installation.
  copilot: { version: '1.0.95', evidence: 'scripts/qualification/evidence/native-copilot-skills-2026-11-12.json' },
  pi: { version: '1.5.0', evidence: 'scripts/qualification/evidence/native-skills-2026-11-12.json',
    invocation: { hosts: { user: PI_USER_INVOCATION_HOSTS, project: LOCAL_INVOCATION_HOSTS }, model: ['false', 'true'] } },
  opencode: { version: '2.0.0', evidence: 'scripts/qualification/evidence/native-opencode-skills-2026-11-13.json',
    invocation: { hosts: { user: SKILL_HOSTS, project: LOCAL_INVOCATION_HOSTS }, model: ['false', 'true'] } },
  grok: { version: '1.0.77', evidence: 'scripts/qualification/evidence/native-grok-skills-2026-11-12.json',
    invocation: { hosts: { user: GROK_SKILL_HOSTS }, model: ['false'] } },
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
        : platform === 'pi' || platform === 'opencode' ? 'native-extension' : 'native-package'] }];
  })) as PlatformCapabilitiesV2['kinds'];
  const features: PlatformCapabilitiesV2['features'] = Object.fromEntries(Object.entries(getPlatformFeatureRegistry()).filter(([, definition]) => !definition.derivedFromKind).map(([id, definition]) => [id, {
    status: platform === 'generic' ? 'unsupported' : 'unverified', reasonCodes: [platform === 'generic' ? 'interface-unsupported' : 'capability-unverified'],
    ...(definition.values ? { values: [] } : {}),
  }]));
  if (platform === 'codex') features['instruction.after-compaction'] = { status: 'unsupported', reasonCodes: ['interface-unsupported'] };
  const profile: QualifiedPlatformProfile = { id: `${platform}:${PROFILE_BASELINES[platform]}`, platform, kinds, features, agentConsumers: [] };
  // Qualification records retain the exact tested CLI versions and host cells.
  // Ordinary management uses the discovery interface minimum for these products.
  // It does not qualify invocation metadata, Hooks, MCP execution, or model behavior.
  const skillCli = SKILL_CLI_PROFILES[platform];
  const hostPlatform = host.platform ?? process.platform;
  const hostArch = host.arch ?? process.arch;
  const hostId = `${hostPlatform}-${hostArch}`;
  const qualifiedSkillHosts = platform === 'cursor' ? CURSOR_SKILL_HOSTS : platform === 'grok' ? GROK_SKILL_HOSTS : SKILL_HOSTS;
  const qualifiedSkillHost = qualifiedSkillHosts.includes(hostId);
  if (skillCli && qualifiedSkillHost) {
    const skillVersion = skillCli.version;
    profile.id += `:${hostPlatform}-${hostArch}-cli-${skillVersion}-skills`;
    kinds.skill = { ...kinds.skill, status: 'supported', reasonCodes: [] };
    profile.qualifiedConsumers = { skill: [{ product: 'cli', version: skillVersion }] };
    profile.qualificationEvidence = [{ reference: skillCli.evidence,
      product: 'cli', version: skillVersion, platform: hostPlatform, arch: hostArch, scopes: platform === 'grok' || platform === 'antigravity' ? ['user'] : ['user', 'project'], kinds: ['skill'], features: [],
      limitations: platform === 'cursor' ? ['cli-workspace-open-and-slash-discovery', 'desktop-unverified', 'remote-model-routing-unverified']
        : [...(platform === 'claude' ? ['native-management-and-effective-activation-only', 'skill-discovery-unverified', 'skill-loading-unverified']
        : platform === 'antigravity' ? ['native-management-effective-scope-and-consumer-bytes-only', 'project-unverified', 'skill-loading-unverified']
        : platform === 'opencode' ? ['native-management-effective-scope-and-consumer-bytes-only', 'process-receipts-do-not-qualify-provider-or-os']
        : ['host-discovery-and-lifecycle-only']), 'model-behavior-unverified', 'invocation-controls-unverified', 'adapter-end-to-end-not-qualified-by-this-record'] }];
    if (platform === 'grok') profile.qualificationEvidence.push({
      reference: 'scripts/qualification/evidence/native-grok-project-skills-2026-11-13.json',
      product: 'cli', version: skillVersion, platform: hostPlatform, arch: hostArch, scopes: ['project'], kinds: ['skill'], features: [],
      limitations: ['native-management-and-effective-activation-only', 'fixture-project-trust-required', 'skill-discovery-unverified',
        'skill-loading-unverified', 'model-behavior-unverified', 'invocation-controls-unverified', 'adapter-end-to-end-not-qualified-by-this-record'],
    });
  }
  if (platform === 'codex' && qualifiedSkillHost) {
    // Role TOML and installed config remain available through a qualified CLI.
    profile.id += ':cli-subagents';
    kinds.agent = { ...kinds.agent, status: 'supported', reasonCodes: [] };
    for (const [feature, values] of Object.entries(CODEX_CLI_FEATURES)) {
      features[feature] = { status: 'supported', reasonCodes: [], values: [...values] };
    }
  }
  if (skillCli?.invocation) {
    const invocation = skillCli.invocation;
    const scopes = (['user', 'project'] as const).filter((scope) => invocation.hosts[scope]?.includes(hostId));
    if (scopes.length) {
      profile.id += `:manual-cli-${skillCli.version}`;
      profile.skillInvocation = { reference: platform === 'codex' ? CODEX_INVOCATION_CONTRACT : MANUAL_SKILL_EVIDENCE,
        minimumVersion: invocation.minimumVersion ?? skillCli.version, scopes,
        features: [{ feature: 'skill.invocation.manual', values: ['true'] }, { feature: 'skill.visibility', values: ['visible'] },
          { feature: 'skill.invocation.model', values: invocation.model }] };
    }
  }
  return profile;
}
/** Apply recorded scope limits to both local and authoring capability views. */
export function getQualifiedKindsForScope(profile: QualifiedPlatformProfile, scope: Scope): PlatformCapabilitiesV2['kinds'] {
  const kinds = structuredClone(profile.kinds);
  for (const kind of COMPONENT_KINDS) {
    const records = profile.qualificationEvidence?.filter((record) => record.kinds.includes(kind));
    if (records?.length && !records.some((record) => record.scopes.includes(scope))) {
      kinds[kind] = { ...kinds[kind], status: 'unverified', reasonCodes: ['capability-unverified'] };
    }
  }
  return kinds;
}

/** A local invocation policy must cover every available reader of the same Skill bytes. */
export function getQualifiedFeaturesForScope(profile: QualifiedPlatformProfile, scope: Scope,
  consumers?: CapabilityInput['renderUnit']['consumers']): PlatformCapabilitiesV2['features'] {
  const features = structuredClone(profile.features);
  const invocation = profile.skillInvocation;
  if (!invocation?.scopes.includes(scope)) return features;
  if (consumers) {
    const readers = consumers.filter((consumer) => consumer.availability === 'available');
    if (!readers.length || !readers.every((reader) => reader.product === 'cli' && reader.entry?.kind === 'cli'
      && reader.version && platformVersionSupported(profile.platform, reader.version)
      && (profile.platform === 'cursor' ? reader.version >= invocation.minimumVersion
        : compareStrictSemVer(reader.version, invocation.minimumVersion) >= 0))) return features;
  }
  for (const { feature, values } of invocation.features) {
    features[feature] = { status: 'supported', reasonCodes: [], ...(values ? { values: [...values] } : {}) };
  }
  return features;
}
/** The renderer and persistent input evidence consume the same capability facts. */
export function toPlatformCapabilitiesView(input: PlatformCapabilitiesV2): PlatformCapabilitiesV2 {
  const sorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();
  const kinds = Object.fromEntries(COMPONENT_KINDS.map((kind) => {
    const { status, reasonCodes, delivery } = input.kinds[kind];
    return [kind, { status, reasonCodes: sorted(reasonCodes), delivery: sorted(delivery) }];
  })) as PlatformCapabilitiesV2['kinds'];
  const features = Object.fromEntries(Object.keys(input.features).sort().map((id) => {
    const { status, reasonCodes, values, maxBytes } = input.features[id]!;
    return [id, { status, reasonCodes: sorted(reasonCodes),
      ...(values === undefined ? {} : { values: sorted(values) }), ...(maxBytes === undefined ? {} : { maxBytes }) }];
  }));
  return { schemaVersion: 2, platform: input.platform, scope: input.scope, basis: input.basis, kinds, features };
}

export function getPlatformCapabilities(input: CapabilityInput): PlatformCapabilitiesV2 {
  const { binding, renderUnit, profile, observation } = input;
  if (profile.platform !== binding.platform) throw new Error('platformProfileMismatch');
  // A shared user package does not extend a user-only record to project activation.
  const kinds = getQualifiedKindsForScope(profile, binding.scope.kind);
  const consumers = renderUnit.consumers;
  const features = getQualifiedFeaturesForScope(profile, binding.scope.kind, consumers);
  for (const kind of COMPONENT_KINDS) {
    const qualified = profile.qualifiedConsumers?.[kind];
    if (qualified && !consumers.some((consumer) => consumer.availability === 'available' && consumer.entry?.kind === 'cli'
      && qualified.some((entry) => entry.product === consumer.product) && platformVersionSupported(binding.platform, consumer.version))) {
      kinds[kind] = { ...kinds[kind], status: 'unverified', reasonCodes: ['capability-unverified'] };
    }
  }
  if (binding.platform === 'codex' && (profile.kinds.skill.status === 'supported' || kinds.agent.status === 'supported')) {
    const qualifiedCli = consumers.some((consumer) => consumer.product === 'cli' && consumer.entry?.kind === 'cli'
      && consumer.availability === 'available' && platformVersionSupported('codex', consumer.version));
    if (!qualifiedCli) {
      if (kinds.agent.status === 'supported') {
        kinds.agent = { ...kinds.agent, status: 'unverified', reasonCodes: ['capability-unverified'] };
      }
      for (const feature of Object.keys(CODEX_CLI_FEATURES)) {
        if (features[feature]?.status === 'supported') {
          features[feature] = { status: 'unverified', reasonCodes: ['capability-unverified'], values: [] };
        }
      }
    }
  }
  // Excluded entries remain facts. They do not revoke another complete path.
  const available = consumers.some((consumer) => consumer.availability === 'available' || consumer.availability === 'notApplicable');
  if (!available && consumers.length) {
    const reasons = consumers.map(({ availability }) => availability === 'missing' ? 'client-missing'
      : availability === 'unsupported' ? 'version-unsupported' : 'capability-unverified');
    const status = consumers.some((consumer) => consumer.availability === 'unknown') ? 'unverified' : 'unsupported';
    for (const fact of [...Object.values(kinds), ...Object.values(features)]) {
      fact.status = status;
      fact.reasonCodes.push(...reasons);
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
  return toPlatformCapabilitiesView({
    schemaVersion: 2, platform: binding.platform, scope: renderUnit.renderScope.kind, basis: 'local', kinds, features,
  });
}
