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

function isSkillTarget(target: PluginArtifactTargetDefinition): boolean {
  return target.target === 'codex.skill'
    || target.target === 'claude.skill'
    || target.target === 'agent-skills.skill';
}

function sensitiveConfigKeys(manifest: NormalizedPluginManifest): Set<string> {
  return new Set(Object.entries(manifest.config?.fields ?? {})
    .filter(([, field]) => field.sensitive === true)
    .map(([key]) => key));
}

function usesSensitiveConfig(
  target: PluginArtifactTargetDefinition,
  sensitiveKeys: ReadonlySet<string>,
): boolean {
  return target.refreshKeys.some((key) => sensitiveKeys.has(key));
}

function assertSafeArtifactRequestMix(
  manifest: NormalizedPluginManifest,
  declarations: readonly PluginArtifactTargetDefinition[],
): void {
  const sensitiveKeys = sensitiveConfigKeys(manifest);
  if (declarations.some(isSkillTarget)
    && declarations.some((target) => !isSkillTarget(target) && usesSensitiveConfig(target, sensitiveKeys))) {
    throw new Error(
      'artifactRendererSensitiveRequestMixed: Skill artifacts cannot share a renderer request with non-Skill artifacts that require sensitive config.',
    );
  }
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

export function resolveAwDeliveredArtifactRequestBatches(options: {
  manifest: NormalizedPluginManifest;
  platform: PlatformName | DistributionName;
  scope: Scope;
}): string[][] {
  const requestedArtifactIds = resolveAwDeliveredArtifactIds(options);
  const requested = new Set(requestedArtifactIds);
  const declarations = (options.manifest.artifacts?.targets ?? []).filter((target) =>
    requested.has(target.id)
    && (target.platform ?? target.distribution) === options.platform
    && target.scopes.includes(options.scope));
  const sensitiveKeys = sensitiveConfigKeys(options.manifest);
  const skillIds = declarations.filter(isSkillTarget).map((target) => target.id);
  const nonSkillTargets = declarations.filter((target) => !isSkillTarget(target));
  if (skillIds.length === 0
    || !nonSkillTargets.some((target) => usesSensitiveConfig(target, sensitiveKeys))) {
    return requestedArtifactIds.length === 0 ? [] : [requestedArtifactIds];
  }
  return [skillIds, nonSkillTargets.map((target) => target.id)];
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
  assertSafeArtifactRequestMix(options.manifest, declarations);
  return {
    requestedArtifactIds: declarations.map((target) => target.id),
    declarations,
  };
}
