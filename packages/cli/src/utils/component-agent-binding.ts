import {
  evaluateStaticAgentRegistry,
  isSkillAgentReferenceMarkdown,
  mergeSkillAgentUnmet,
  nativeComponentName,
  registerAgentReferenceTarget,
  replaceAgentNamePlaceholders,
  resolveAgentInvocationName,
  resolvePlatformAgentNaming,
  scanSkillAgentReferences,
  type AgentReferenceTarget,
  type ExpectedComponentSet,
  type PlatformCapabilitiesV3,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { RenderUnit } from '../platforms/contracts.js';
import type { PlatformTarget, PluginMeta } from '../types.js';
import { artifactValueDigest } from './artifact-plan.js';
import { preparePlatformComponents, type PreparedPlatformComponents } from './artifact-renderer.js';
import { retainComponentResources } from './component-resources.js';

export interface RawPlatformUnit {
  unit: RenderUnit;
  request: Parameters<typeof preparePlatformComponents>[0];
  prepared: PreparedPlatformComponents;
}

export interface SkillAgentBinding {
  capabilities: PlatformCapabilitiesV3;
  hasApplicableRenderer: boolean;
  dynamicAgents(): Promise<ExpectedComponentSet[]>;
}

/** Resolve roles only when a deliverable Skill actually references one. */
export function skillAgentBinding(raw: RawPlatformUnit, deploymentUnits: readonly RawPlatformUnit[],
  prepareExtraAgents = () => preparePlatformComponents({ ...raw.request, kinds: ['agent'] })): SkillAgentBinding {
  const { capabilities, plugin, platform, renderScope } = raw.request;
  const { artifacts, platforms } = plugin.manifest;
  const hasApplicableRenderer = !!artifacts && (!artifacts.scopes || artifacts.scopes.includes(renderScope))
    && (!platforms?.length || platforms.includes(platform));
  return {
    capabilities, hasApplicableRenderer,
    async dynamicAgents() {
      if (!hasApplicableRenderer) return [];
      const agentUnits = deploymentUnits.filter(({ unit, request }) => request.kinds.includes('agent')
        && artifactValueDigest(unit.renderScope) === artifactValueDigest(raw.unit.renderScope));
      if (agentUnits.length) return agentUnits.map(({ prepared }) => prepared.expected);
      if (capabilities.kinds.agent.status === 'unsupported') return [];
      // Codex Project-only and Skill-only exports need this view in memory. It is never projected.
      return [(await prepareExtraAgents()).expected];
    },
  };
}

function registerDynamicAgents(registry: Map<string, AgentReferenceTarget>, expected: ExpectedComponentSet): void {
  for (const component of expected.components) {
    if (component.kind === 'agent' && expected.sources[component.id] === 'dynamic') {
      registerAgentReferenceTarget(registry, component.name, { kind: 'deliverable', role: nativeComponentName(component.name) });
    }
  }
  for (const entry of [...expected.omitted, ...expected.unmet]) {
    if (entry.kind !== 'agent' || expected.sources[entry.id] !== 'dynamic') continue;
    const name = entry.name ?? entry.id.replace(/^agent:/u, '');
    registerAgentReferenceTarget(registry, name, 'requiredFeatures' in entry
      ? { kind: 'unmet', requiredFeatures: entry.requiredFeatures, reasonCode: entry.reasonCode }
      : { kind: 'omitted' });
  }
}

export async function bindPlatformSkillAgents(plugin: PluginMeta, platform: PlatformTarget,
  prepared: PreparedPlatformComponents, binding?: SkillAgentBinding): Promise<PreparedPlatformComponents> {
  const references = prepared.resources.files.flatMap((file) => {
    if (!isSkillAgentReferenceMarkdown(file.path)) return [];
    const text = file.bytes.toString('utf8');
    const names = scanSkillAgentReferences(file.path, text).map(({ normalizedName }) => normalizedName);
    return names.length ? [{ file, text, names }] : [];
  });
  if (!references.length) return prepared;
  if (!binding) throw new Error('agentReferenceInvalid: a Skill references an Agent without a prepared platform view.');
  const naming = resolvePlatformAgentNaming(platform, {
    pluginId: plugin.pluginId ?? `${plugin.sourceId ?? 'authoring'}/${plugin.manifest.name}`,
    sourceId: plugin.sourceId, name: plugin.manifest.name,
  });
  const registry = evaluateStaticAgentRegistry(plugin.manifest, platform, binding.capabilities);
  for (const set of await binding.dynamicAgents()) registerDynamicAgents(registry, set);

  let expected = prepared.expected;
  const replacements = new Map<typeof prepared.resources.files[number], string>();
  for (const skill of prepared.expected.components) {
    if (skill.kind !== 'skill') continue;
    const markdown = references.filter(({ file }) => file.componentId === skill.id);
    if (!markdown.length) continue;
    const gaps: Extract<AgentReferenceTarget, { kind: 'unmet' }>[] = [];
    const invocations = new Map<string, string>();
    for (const { file, names } of markdown) {
      for (const name of names) {
        const target = registry.get(name);
        if (target?.kind === 'deliverable') invocations.set(name, resolveAgentInvocationName(naming, target.role));
        else if (target?.kind === 'unmet') gaps.push(target);
        else if (!target && binding.hasApplicableRenderer && binding.capabilities.kinds.agent.status === 'unsupported') {
          gaps.push({ kind: 'unmet', reasonCode: 'interface-unsupported', requiredFeatures: [{ feature: 'component.kind.agent' }] });
        } else throw new Error('agentReferenceInvalid: unavailable Agent ' + name + ' in ' + skill.name + '/' + file.path);
      }
    }
    if (gaps.length) expected = mergeSkillAgentUnmet(expected, skill, gaps);
    else for (const { file, text } of markdown) {
      replacements.set(file, replaceAgentNamePlaceholders(text, (name) => invocations.get(name)!));
    }
  }
  const delivered = new Set(expected.components.map(({ id }) => id));
  const resources = retainComponentResources(prepared.resources, delivered);
  resources.files = resources.files.map((file) => {
    const text = replacements.get(file);
    if (text === undefined) return file;
    const { source: _, ...original } = file;
    return { ...original, bytes: Buffer.from(text) };
  });
  expected = { ...expected, components: expected.components.map((component) => {
    if (component.kind !== 'skill') return component;
    const files = { ...component.content.files };
    for (const [file, text] of replacements) if (file.componentId === component.id) files[file.path] = { text };
    return { ...component, content: { files } };
  }) };
  const agents = [...registry.entries()].sort(([left], [right]) => left.localeCompare(right));
  const renderInputDigest = artifactValueDigest({ components: prepared.evidence.renderInputDigest, naming, agents });
  return {
    ...prepared, expected, resources,
    runtimeConfigSnapshots: Object.fromEntries(Object.entries(prepared.runtimeConfigSnapshots).filter(([id]) => delivered.has(id))),
    evidence: { ...prepared.evidence, renderInputDigest },
    empty: expected.components.length ? null : expected.unmet.length ? 'unmet' : 'intentional',
  };
}
