import { isSkillAgentReferenceMarkdown, scanSkillAgentReferences } from './agent-placeholders.js';
import { nativeComponentName, tryNativeComponentName } from './platform-agent-naming.js';
import { applyPlatformOverride } from './platform-entries.js';
import {
  COMPONENT_DEPENDENCY_REASON_CODES, getMissingDeliveryRequirements, mergeFeatureRequirements, reasonForMissing, selectMissingReasonCode,
  type ComponentUnmet, type ExpectedComponentSet, type PlatformCapabilitiesV3,
  type PluginComponent, type ResourceFile, type SourceRef,
} from './plugin-components.js';
import type { NormalizedPluginManifest, PlatformId } from './types.js';

type AgentGap = Pick<ComponentUnmet, 'requiredFeatures' | 'reasonCode'>;
export type AgentReferenceTarget =
  | { kind: 'deliverable'; role: string }
  | ({ kind: 'unmet' } & AgentGap)
  | { kind: 'omitted' };

export function registerAgentReferenceTarget(registry: Map<string, AgentReferenceTarget>,
  publicName: string, target: AgentReferenceTarget): void {
  const referenceKey = tryNativeComponentName(publicName);
  if (referenceKey === undefined && target.kind !== 'deliverable') return;
  // An unreferenceable public name may have a valid overridden role. Keep it
  // under its raw name for projection collision checks, not placeholder lookup:
  // a raw name that fails normalization cannot equal a successful normalized key.
  const name = referenceKey ?? publicName;
  if (registry.has(name)) throw new Error('agentReferenceInvalid: ambiguous Agent ' + name);
  if (target.kind === 'deliverable' && [...registry.values()].some((other) =>
    other.kind === 'deliverable' && other.role === target.role)) {
    throw new Error('agentReferenceInvalid: multiple Agents project to ' + target.role);
  }
  registry.set(name, target);
}

/** Public names always come from the declaration. Platform overrides affect only the delivered role. */
export function evaluateStaticAgentRegistry(manifest: NormalizedPluginManifest, platform: PlatformId,
  capabilities: PlatformCapabilitiesV3): Map<string, AgentReferenceTarget> {
  const registry = new Map<string, AgentReferenceTarget>();
  for (const agent of manifest.extensions?.agents ?? []) {
    const resolved = applyPlatformOverride(agent, platform);
    if (!resolved) {
      registerAgentReferenceTarget(registry, agent.name, { kind: 'omitted' });
      continue;
    }
    const { name, agentOverrides: _, ...content } = resolved;
    const component: PluginComponent = { kind: 'agent', id: 'agent:' + agent.name, name, content };
    const missing = getMissingDeliveryRequirements(component, capabilities);
    registerAgentReferenceTarget(registry, agent.name, missing.length
      ? { kind: 'unmet', requiredFeatures: missing, reasonCode: reasonForMissing(missing, capabilities) }
      : { kind: 'deliverable', role: nativeComponentName(name) });
  }
  return registry;
}

export function mergeSkillAgentUnmet(expected: ExpectedComponentSet, skill: Extract<PluginComponent, { kind: 'skill' }>,
  gaps: readonly AgentGap[]): ExpectedComponentSet {
  if (!gaps.length) return expected;
  const partial = expected.unmet.filter((gap) => gap.componentId === skill.id);
  const allGaps = [...gaps, ...partial];
  const requiredFeatures = mergeFeatureRequirements(allGaps.flatMap((gap) => gap.requiredFeatures));
  const sources = { ...expected.sources };
  for (const gap of partial) delete sources[gap.id];
  const codes = allGaps.map((gap) => gap.reasonCode);
  // A configuration or dependency failure must not turn into a normal capability skip.
  const reasonCode = codes.find((code) => COMPONENT_DEPENDENCY_REASON_CODES.some((reason) => reason === code))
    ?? selectMissingReasonCode(codes);
  return {
    ...expected,
    components: expected.components.filter((component) => component.id !== skill.id),
    sources,
    unmet: [...expected.unmet.filter((gap) => gap.componentId !== skill.id && gap.id !== skill.id),
      { id: skill.id, name: skill.name, kind: 'skill', reasonCode, requiredFeatures }],
  };
}

export async function readSkillAgentReferenceNames(files: Readonly<Record<string, ResourceFile>>,
  readSource: (source: SourceRef) => Promise<string>): Promise<Set<string>> {
  const names = new Set<string>();
  for (const [file, resource] of Object.entries(files)) {
    if (!isSkillAgentReferenceMarkdown(file)) continue;
    const text = 'text' in resource ? resource.text : await readSource(resource.source);
    for (const reference of scanSkillAgentReferences(file, text)) names.add(reference.normalizedName);
  }
  return names;
}

export async function applyStaticSkillAgentUnmet(options: {
  expected: ExpectedComponentSet;
  manifest: NormalizedPluginManifest;
  platform: PlatformId;
  capabilities: PlatformCapabilitiesV3;
  readSource: (source: SourceRef) => Promise<string>;
  allowDynamicAgentDeferral?: boolean;
}): Promise<ExpectedComponentSet> {
  let expected = options.expected;
  let registry: Map<string, AgentReferenceTarget> | undefined;
  for (const skill of options.expected.components) {
    if (skill.kind !== 'skill' || expected.sources[skill.id] !== 'static') continue;
    const gaps: AgentGap[] = [];
    for (const name of await readSkillAgentReferenceNames(skill.content.files, options.readSource)) {
      registry ??= evaluateStaticAgentRegistry(options.manifest, options.platform, options.capabilities);
      const target = registry.get(name);
      if (!target && options.allowDynamicAgentDeferral) continue;
      if (!target || target.kind === 'omitted') throw new Error('agentReferenceInvalid: unavailable Agent ' + name + ' in ' + skill.name);
      if (target.kind === 'unmet') gaps.push(target);
    }
    expected = mergeSkillAgentUnmet(expected, skill, gaps);
  }
  return expected;
}
