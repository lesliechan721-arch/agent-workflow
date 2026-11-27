import crypto from 'node:crypto';
import {
  assertPlatformComponentPlan,
  normalizeCommandRoutesArtifact,
  type CommandRoutesArtifact,
  type ExpectedComponentSet,
  type PlatformCapabilitiesV3,
  type PlatformComponentPlanV3,
  type ComponentKind,
  type PlatformTarget,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { Scope } from '../types.js';

export type { ExpectedComponentSet } from '@lesliechan721/aw-plugin-core/manifest';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function stableArtifactStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableArtifactStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stableArtifactStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function artifactValueDigest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableArtifactStringify(value)).digest('hex')}`;
}
export function validateCommandRoutesPlan(plan: unknown, refreshKeys: readonly string[]): CommandRoutesArtifact {
  if (!isRecord(plan) || Object.keys(plan).some((key) => key !== 'version' && key !== 'artifacts')
    || plan.version !== 2 || !Array.isArray(plan.artifacts) || plan.artifacts.length !== 1) {
    throw new Error('Invalid command artifact plan: expected version 2 with exactly one command-routes artifact.');
  }
  const artifact = normalizeCommandRoutesArtifact(plan.artifacts[0]);
  if (artifact.refreshKeys.length !== refreshKeys.length || refreshKeys.some((key) => !artifact.refreshKeys.includes(key))) {
    throw new Error('Invalid command routes artifact.refreshKeys: must match the declared refreshKeys.');
  }
  return artifact;
}

export function validatePlatformComponentPlan(options: {
  plan: unknown; platform: PlatformTarget; scope: Scope; allowedOutputKinds: readonly ComponentKind[];
  platformCapabilities: PlatformCapabilitiesV3; configKeys?: readonly string[]; nonSensitiveConfigKeys?: readonly string[];
  resources?: import('@lesliechan721/aw-plugin-core/manifest').PlatformRenderContextV3['resources']; sourceDirs?: readonly string[];
  requiredAwCapabilities?: readonly string[];
  hasInstructionAgentRecipients?: boolean;
}): PlatformComponentPlanV3 {
  assertPlatformComponentPlan(options.plan, options);
  return options.plan;
}

export function mergeExpectedComponentSets(sets: readonly ExpectedComponentSet[]): ExpectedComponentSet {
  const expected: ExpectedComponentSet = { components: [], omitted: [], unmet: [], sources: Object.create(null) as ExpectedComponentSet['sources'] };
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const set of sets) {
    if (set.declaredComponentIds?.length) (expected.declaredComponentIds ??= []).push(...set.declaredComponentIds);
    for (const entry of [...set.components, ...set.omitted, ...set.unmet]) {
      if (ids.has(entry.id)) throw new Error(`componentIdentityConflict: duplicate component ID "${entry.id}".`);
      ids.add(entry.id);
      const source = set.sources[entry.id];
      if (source !== 'static' && source !== 'dynamic') throw new Error(`componentSourceInvalid: missing source for "${entry.id}".`);
      expected.sources[entry.id] = source;
    }
    for (const component of set.components) {
      const key = `${component.kind}:${component.name}`;
      if (names.has(key)) throw new Error(`componentNameConflict: duplicate ${component.kind} name "${component.name}".`);
      names.add(key);
    }
    expected.components.push(...set.components);
    expected.omitted.push(...set.omitted);
    expected.unmet.push(...set.unmet);
  }
  if (expected.declaredComponentIds) expected.declaredComponentIds = [...new Set(expected.declaredComponentIds)];
  for (const gap of expected.unmet) {
    if (gap.componentId && !expected.components.some((component) => component.id === gap.componentId && (component.kind === 'instruction' || component.kind === 'skill'))) {
      throw new Error(`componentGapInvalid: "${gap.id}" references an unavailable component.`);
    }
  }
  return expected;
}
