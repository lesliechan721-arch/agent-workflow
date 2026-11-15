import crypto from 'node:crypto';
import {
  assertPlatformComponentPlan,
  normalizeCommandDefinitions,
  normalizeCommandRelativeFile,
  type ExpectedComponentSet,
  type PlatformCapabilitiesV1,
  type PlatformComponentPlanV3,
  type ComponentKind,
  type PlatformTarget,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { ArtifactPlanArtifact, ArtifactRenderSurfaceName, NormalizedPluginManifest, Scope } from '../types.js';
import { resolveArtifactRequest, type ArtifactRequestDeclaration } from './artifact-request.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';

export type { ExpectedComponentSet } from '@lesliechan721/aw-plugin-core/manifest';

export type ValidatedArtifactPlanArtifact = ArtifactPlanArtifact & {
  declaration: ArtifactRequestDeclaration; logicalIdentity: string; configDigest: string;
};
export interface ValidatedArtifactPlan { version: 2; artifacts: ValidatedArtifactPlanArtifact[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Invalid ${field}: unexpected field "${key}".`);
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
export function createArtifactConfigDigest(options: {
  artifact: { id: string; platform?: string; distribution?: string; target: string; refreshKeys: readonly string[] };
  renderConfig: Pick<ResolvedArtifactRenderConfig, 'values' | 'sources' | 'issues'>; digestSalt: string;
}): string {
  return artifactValueDigest({ digestSalt: options.digestSalt, platform: options.artifact.platform,
    distribution: options.artifact.distribution, target: options.artifact.target, id: options.artifact.id,
    refreshInputs: options.artifact.refreshKeys.map((key) => ({ key,
      present: Object.hasOwn(options.renderConfig.values, key), value: options.renderConfig.values[key],
      source: options.renderConfig.sources[key], issues: options.renderConfig.issues.filter((issue) => issue.key === key) })) });
}

/** v2 is reserved for exact command requests. Five component kinds use v3 below. */
export function validateArtifactPlan(options: {
  pluginName?: string; manifest: NormalizedPluginManifest; plan: unknown; platform: ArtifactRenderSurfaceName;
  scope: Scope; requestedArtifactIds: readonly string[];
  renderConfig: Pick<ResolvedArtifactRenderConfig, 'values' | 'sources' | 'issues'>;
  rendererDigest?: string; manifestDigest?: string;
}): ValidatedArtifactPlan {
  const request = resolveArtifactRequest(options);
  const plan = options.plan;
  if (!isRecord(plan)) throw new Error('Invalid command artifact plan: expected a JSON object.');
  keys(plan, ['version', 'artifacts'], 'command artifact plan');
  if (plan.version !== 2 || !Array.isArray(plan.artifacts)) throw new Error('Invalid command artifact plan: expected version 2 and artifacts array.');
  const seen = new Set<string>();
  const artifacts = plan.artifacts.map((value: unknown, index: number): ValidatedArtifactPlanArtifact => {
    const field = `artifacts[${index}]`;
    if (!isRecord(value)) throw new Error(`Invalid ${field}: expected an object.`);
    const declaration = request.declarations.find((entry) => entry.id === value.id);
    if (!declaration || seen.has(declaration.id)) throw new Error(`Invalid ${field}: unexpected or duplicate command artifact ID.`);
    seen.add(declaration.id);
    const commandSet = declaration.target === 'aw.command-set';
    keys(value, commandSet ? ['id', 'target', 'kind', 'platform', 'state', 'refreshKeys', 'entries', 'disabledReason']
      : ['id', 'target', 'kind', 'state', 'refreshKeys', 'files'], field);
    if (value.target !== declaration.target || value.kind !== declaration.kind) throw new Error(`Invalid ${field}: target and kind must match the command request.`);
    if (declaration.platform ? value.platform !== declaration.platform : Object.hasOwn(value, 'platform')) throw new Error(`Invalid ${field}.platform: must match the command request.`);
    if (!Array.isArray(value.refreshKeys) || value.refreshKeys.length !== declaration.refreshKeys.length
      || new Set(value.refreshKeys).size !== value.refreshKeys.length
      || declaration.refreshKeys.some((key) => !(value.refreshKeys as unknown[]).includes(key))) throw new Error(`Invalid ${field}.refreshKeys: must preserve declared keys.`);
    if ((value.state !== 'present' && value.state !== 'disabled') || !declaration.states.includes(value.state)) throw new Error(`Invalid ${field}.state: state is not declared.`);
    let artifact: ArtifactPlanArtifact;
    if (commandSet) {
      const entries = normalizeCommandDefinitions(value.entries, `${field}.entries`);
      if (value.state === 'disabled' && entries.length) throw new Error(`Invalid ${field}.entries: disabled sets must be empty.`);
      if (Object.hasOwn(value, 'disabledReason') && (value.state !== 'disabled' || typeof value.disabledReason !== 'string' || !value.disabledReason.trim())) throw new Error(`Invalid ${field}.disabledReason.`);
      artifact = { id: declaration.id, target: 'aw.command-set', kind: 'commandSet',
        ...(declaration.platform ? { platform: declaration.platform } : {}), state: value.state,
        refreshKeys: [...declaration.refreshKeys], entries,
        ...(typeof value.disabledReason === 'string' ? { disabledReason: value.disabledReason } : {}) };
    } else {
      if (value.state !== 'present' || !isRecord(value.files)) throw new Error(`Invalid ${field}: command packages require present state and files.`);
      const files: Record<string, string> = Object.create(null);
      for (const [file, text] of Object.entries(value.files)) {
        normalizeCommandRelativeFile(file, `${field}.files`);
        if (typeof text !== 'string' || text.includes('\0') || Buffer.from(text).toString('utf8') !== text) throw new Error(`Invalid ${field}.files: expected Unicode text without NUL.`);
        files[file] = text;
      }
      artifact = { id: declaration.id, target: 'aw.command-package', kind: 'commandPackage', state: 'present', refreshKeys: [...declaration.refreshKeys], files };
    }
    return { ...artifact, declaration, logicalIdentity: `${options.pluginName ?? options.manifest.name}:${declaration.id}:${declaration.target}`,
      configDigest: createArtifactConfigDigest({ artifact, renderConfig: options.renderConfig,
        digestSalt: options.rendererDigest ?? options.manifestDigest ?? artifactValueDigest(options.manifest) }) };
  });
  for (const id of request.requestedArtifactIds) if (!seen.has(id)) throw new Error(`Invalid command artifact plan: missing requested artifact "${id}".`);
  return { version: 2, artifacts };
}

export function validatePlatformComponentPlan(options: {
  plan: unknown; platform: PlatformTarget; scope: Scope; allowedOutputKinds: readonly ComponentKind[];
  platformCapabilities: PlatformCapabilitiesV1; configKeys?: readonly string[]; nonSensitiveConfigKeys?: readonly string[];
  resources?: import('@lesliechan721/aw-plugin-core/manifest').PlatformRenderContextV1['resources']; sourceDirs?: readonly string[];
  requiredAwCapabilities?: readonly string[];
}): PlatformComponentPlanV3 {
  assertPlatformComponentPlan(options.plan, options);
  return options.plan;
}

export function mergeExpectedComponentSets(sets: readonly ExpectedComponentSet[]): ExpectedComponentSet {
  const expected: ExpectedComponentSet = { components: [], omitted: [], unmet: [], sources: Object.create(null) as ExpectedComponentSet['sources'] };
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const set of sets) {
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
  for (const gap of expected.unmet) {
    if (gap.componentId && !expected.components.some((component) => component.id === gap.componentId && component.kind === 'instruction')) {
      throw new Error(`componentGapInvalid: "${gap.id}" references an unavailable component.`);
    }
  }
  return expected;
}
