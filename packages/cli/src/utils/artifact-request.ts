import type {
  DistributionName,
  NormalizedPluginManifest,
  PlatformName,
  PluginArtifactTargetDefinition,
  Scope,
} from '../types.js';

export interface ResolvedArtifactRequest {
  requestedArtifactIds: string[];
  declarations: PluginArtifactTargetDefinition[];
}

export function resolveAwDeliveredArtifactIds(options: {
  manifest: NormalizedPluginManifest;
  platform: PlatformName | DistributionName;
  scope: Scope;
}): string[] {
  return (options.manifest.artifacts?.targets ?? [])
    .filter((target) =>
      (target.platform ?? target.distribution) === options.platform
      && target.scopes.includes(options.scope)
      && target.delivery?.mode !== 'codex-native')
    .map((target) => target.id);
}

export function resolveArtifactRequest(options: {
  manifest: NormalizedPluginManifest;
  platform: PlatformName | DistributionName;
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

  const allowedDeclarations = (options.manifest.artifacts?.targets ?? []).filter((target) =>
    (target.platform ?? target.distribution) === options.platform
    && target.scopes.includes(options.scope));
  const allowedById = new Map<string, PluginArtifactTargetDefinition>();
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
  return {
    requestedArtifactIds: declarations.map((target) => target.id),
    declarations,
  };
}
