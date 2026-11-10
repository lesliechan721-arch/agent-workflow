import {
  getManagedCommandArtifactTargets,
  getPluginConfigDependencyKeys,
  type ComponentKind,
  type ManagedCommandArtifactTargetDefinition,
  type PlatformRenderContextV1,
  type PlatformTarget,
  type PluginConfigSchemaField,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { ArtifactRenderSurfaceName, NormalizedPluginManifest, Scope } from '../types.js';
import type { ResolvedArtifactRenderConfig } from './artifact-renderer.js';
import { redactPluginScriptOutput } from './plugin-scripts.js';

export type ArtifactRequestDeclaration = ManagedCommandArtifactTargetDefinition;

/** Command requests keep their exact v2 identities; platform components have no fixed targets. */
export function artifactRequestDeclarations(manifest: NormalizedPluginManifest): ArtifactRequestDeclaration[] {
  return getManagedCommandArtifactTargets(manifest);
}

export function artifactDeclarationSurface(target: ArtifactRequestDeclaration): ArtifactRenderSurfaceName | undefined {
  return target.platform ?? ('name' in target.surface ? target.surface.name : undefined);
}

export interface ResolvedArtifactRequest {
  requestedArtifactIds: string[];
  declarations: ArtifactRequestDeclaration[];
}

export function resolveAwDeliveredArtifactIds(options: {
  manifest: NormalizedPluginManifest; platform: ArtifactRenderSurfaceName; scope: Scope;
}): string[] {
  return artifactRequestDeclarations(options.manifest)
    .filter((target) => artifactDeclarationSurface(target) === options.platform && target.scopes.includes(options.scope))
    .map((target) => target.id);
}

export function resolveAwDeliveredArtifactRequestBatches(options: {
  manifest: NormalizedPluginManifest; platform: ArtifactRenderSurfaceName; scope: Scope;
}): string[][] {
  const ids = resolveAwDeliveredArtifactIds(options);
  return ids.length ? [ids] : [];
}

export function resolveArtifactRequest(options: {
  manifest: NormalizedPluginManifest; platform: ArtifactRenderSurfaceName; scope: Scope;
  requestedArtifactIds: readonly string[];
}): ResolvedArtifactRequest {
  if (!options.requestedArtifactIds.length) throw new Error('Artifact renderer requires at least one requested artifact ID.');
  const requested = new Set<string>();
  for (const id of options.requestedArtifactIds) {
    if (typeof id !== 'string' || !id.trim() || requested.has(id)) throw new Error('Invalid requestedArtifactIds: IDs must be non-empty and unique.');
    requested.add(id);
  }
  const allowed = artifactRequestDeclarations(options.manifest).filter((target) =>
    artifactDeclarationSurface(target) === options.platform && target.scopes.includes(options.scope));
  const declarations = allowed.filter((target) => requested.has(target.id));
  if (new Set(declarations.map((target) => target.id)).size !== declarations.length) throw new Error('Artifact request has ambiguous command IDs.');
  for (const id of requested) {
    if (!declarations.some((target) => target.id === id)) throw new Error(`Requested command artifact "${id}" is not declared for ${options.platform}/${options.scope}.`);
  }
  return { requestedArtifactIds: declarations.map((target) => target.id), declarations };
}

export function resolvePlatformComponentBatches(options: {
  manifest: NormalizedPluginManifest; platform: PlatformTarget; renderScope: Scope; kinds: readonly ComponentKind[];
}): ComponentKind[][] {
  if (!options.manifest.artifacts || (options.manifest.platforms?.length && !options.manifest.platforms.includes(options.platform))
    || (options.manifest.artifacts.scopes && !options.manifest.artifacts.scopes.includes(options.renderScope))) return [];
  const kinds = new Set(options.kinds);
  return [(['skill'] as ComponentKind[]).filter((kind) => kinds.has(kind)),
    (['mcp', 'agent', 'hook', 'instruction'] as ComponentKind[]).filter((kind) => kinds.has(kind))]
    .filter((batch) => batch.length > 0);
}

export function selectPlatformRenderConfigKeys(options: {
  resolved: ResolvedArtifactRenderConfig; keys: readonly string[]; nonSensitive: boolean;
}): string[] {
  const fields = options.resolved.schema ?? {};
  const definition = options.resolved.definition ?? { schemaVersion: 5 as const, fields };
  const keys = new Set<string>();
  for (const key of options.keys) {
    const closure = getPluginConfigDependencyKeys(definition, [key], options.resolved.referenceContext);
    if (options.nonSensitive && closure.some((dependency) => fields[dependency]?.sensitive === true)) continue;
    for (const dependency of closure) keys.add(dependency);
  }
  return [...keys];
}

export function selectPlatformRenderConfig(options: {
  resolved: ResolvedArtifactRenderConfig; keys: readonly string[]; nonSensitive: boolean;
}): PlatformRenderContextV1['config'] {
  const keys = new Set(selectPlatformRenderConfigKeys(options));
  const select = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(
    Object.entries(values).filter(([key]) => keys.has(key)));
  const tokens = (value: unknown): string[] => value !== null && typeof value === 'object'
    ? Object.values(value).flatMap(tokens) : value === undefined || value === null || value === '' ? [] : [String(value)];
  const sensitiveValues = Object.entries(options.resolved.schema ?? {}).flatMap(([key, field]) =>
    field.sensitive ? tokens(options.resolved.values[key]) : []);
  return {
    schema: { schemaVersion: 5, fields: select<PluginConfigSchemaField>(options.resolved.schema ?? {}) },
    values: select(options.resolved.values),
    sources: Object.fromEntries([...keys].map((key) => [key, options.resolved.sources[key] ?? 'missing'])),
    issues: options.resolved.issues.filter((issue) => keys.has(issue.key)).map((issue) => ({
      code: issue.code ?? issue.type, path: { field: issue.key },
      message: redactPluginScriptOutput(issue.message, sensitiveValues), recoverable: true,
    })),
  };
}
