import type {
  ArtifactRenderSurfaceName,
  NormalizedPluginManifest,
  ManagedCommandArtifactTargetDefinition,
  PluginArtifactTargetDefinition,
  Scope,
} from '../types.js';
import { getManagedCommandArtifactTargets } from '@lesliechan721/aw-plugin-core/manifest';

export type ArtifactRequestDeclaration = PluginArtifactTargetDefinition | (ManagedCommandArtifactTargetDefinition & {
  distribution?: undefined;
  runtimeImports?: undefined;
  requiresCodexProjectConfig?: undefined;
  roleKey?: undefined;
  skillKey?: undefined;
  sourceDirs?: undefined;
});

export function artifactRequestDeclarations(manifest: NormalizedPluginManifest): ArtifactRequestDeclaration[] {
  return [...(manifest.artifacts?.targets ?? []).map((target) => target.delivery?.mode === 'codex-native' && manifest.managedCommands?.sets.some((set) => set.producer.kind === 'artifact' && set.producer.artifactId === target.id) ? { ...target, scopes: ['user'] as Scope[] } : target), ...getManagedCommandArtifactTargets(manifest)];
}

export function artifactDeclarationSurface(target: ArtifactRequestDeclaration): ArtifactRenderSurfaceName | undefined {
  return 'surface' in target && target.surface.kind === 'aw'
    ? target.surface.name
    : target.platform ?? target.distribution;
}

export interface ResolvedArtifactRequest {
  requestedArtifactIds: string[];
  declarations: ArtifactRequestDeclaration[];
}

export function requiresNonSensitiveArtifactInput(target: Pick<ArtifactRequestDeclaration, 'target'>): boolean {
  return target.target === 'codex.skill'
    || target.target === 'claude.skill'
    || target.target === 'agent-skills.skill'
    || target.target === 'aw.command-set'
    || target.target === 'aw.command-package';
}

function sensitiveConfigKeys(manifest: NormalizedPluginManifest): Set<string> {
  return new Set(Object.entries(manifest.config?.fields ?? {})
    .filter(([, field]) => field.sensitive === true)
    .map(([key]) => key));
}

function usesSensitiveConfig(
  target: ArtifactRequestDeclaration,
  sensitiveKeys: ReadonlySet<string>,
): boolean {
  return target.refreshKeys.some((key) => sensitiveKeys.has(key));
}

function assertSafeArtifactRequestMix(
  manifest: NormalizedPluginManifest,
  declarations: readonly ArtifactRequestDeclaration[],
): void {
  const sensitiveKeys = sensitiveConfigKeys(manifest);
  if (declarations.some(requiresNonSensitiveArtifactInput)
    && declarations.some((target) => !requiresNonSensitiveArtifactInput(target) && usesSensitiveConfig(target, sensitiveKeys))) {
    throw new Error(
      'artifactRendererSensitiveRequestMixed: Skill and command artifacts cannot share a renderer request with artifacts that require sensitive config.',
    );
  }
}

export function resolveAwDeliveredArtifactIds(options: {
  manifest: NormalizedPluginManifest;
  platform: ArtifactRenderSurfaceName;
  scope: Scope;
}): string[] {
  return artifactRequestDeclarations(options.manifest)
    .filter((target) =>
      artifactDeclarationSurface(target) === options.platform
      && target.scopes.includes(options.scope)
      && !('producer' in target && target.producer.kind === 'static-skill')
      && target.delivery?.mode !== 'codex-native')
    .map((target) => target.id);
}

export function resolveAwDeliveredArtifactRequestBatches(options: {
  manifest: NormalizedPluginManifest;
  platform: ArtifactRenderSurfaceName;
  scope: Scope;
}): string[][] {
  const requestedArtifactIds = resolveAwDeliveredArtifactIds(options);
  const requested = new Set(requestedArtifactIds);
  const declarations = artifactRequestDeclarations(options.manifest).filter((target) =>
    requested.has(target.id)
    && artifactDeclarationSurface(target) === options.platform
    && target.scopes.includes(options.scope));
  const sensitiveKeys = sensitiveConfigKeys(options.manifest);
  const nonSensitiveIds = declarations.filter(requiresNonSensitiveArtifactInput).map((target) => target.id);
  const otherTargets = declarations.filter((target) => !requiresNonSensitiveArtifactInput(target));
  if (nonSensitiveIds.length === 0
    || !otherTargets.some((target) => usesSensitiveConfig(target, sensitiveKeys))) {
    return requestedArtifactIds.length === 0 ? [] : [requestedArtifactIds];
  }
  return [nonSensitiveIds, otherTargets.map((target) => target.id)];
}

export function resolveArtifactRequest(options: {
  manifest: NormalizedPluginManifest;
  platform: ArtifactRenderSurfaceName;
  scope: Scope;
  requestedArtifactIds: readonly string[];
}): ResolvedArtifactRequest {
  if (options.requestedArtifactIds.length === 0) {
    throw new Error('Artifact renderer requires at least one requested artifact ID.');
  }

  const requested = new Set<string>();
  for (const [index, value] of options.requestedArtifactIds.entries()) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Invalid requestedArtifactIds[${index}]: expected a non-empty artifact ID.`);
    }
    if (requested.has(value)) {
      throw new Error(`Invalid requestedArtifactIds[${index}]: duplicate artifact ID "${value}".`);
    }
    requested.add(value);
  }

  const allowedDeclarations = artifactRequestDeclarations(options.manifest).filter((target) =>
    artifactDeclarationSurface(target) === options.platform
    && target.scopes.includes(options.scope));
  const allowedById = new Map<string, ArtifactRequestDeclaration>();
  for (const declaration of allowedDeclarations) {
    if (allowedById.has(declaration.id)) {
      throw new Error(
        `Artifact renderer request is ambiguous because artifact ID "${declaration.id}" is declared more than once for ${options.platform}/${options.scope}.`,
      );
    }
    allowedById.set(declaration.id, declaration);
  }
  for (const id of requested) {
    if (!allowedById.has(id)) {
      throw new Error(
        `Requested artifact ID "${id}" is not declared for ${options.platform}/${options.scope}.`,
      );
    }
  }

  const declarations = allowedDeclarations.filter((target) => requested.has(target.id));
  assertSafeArtifactRequestMix(options.manifest, declarations);
  return {
    requestedArtifactIds: declarations.map((target) => target.id),
    declarations,
  };
}
