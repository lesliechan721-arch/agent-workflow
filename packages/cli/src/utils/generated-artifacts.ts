import type { GeneratedArtifact } from '../types.js';
import { serializeTrackedHookGroupIdentity } from './hooks-contract.js';

type GeneratedArtifactsCarrier = {
  generatedArtifacts?: unknown;
};

export function generatedArtifactKindRequiresArtifactKey(
  kind: GeneratedArtifact['kind'],
): kind is 'skill' | 'mcpServer' {
  return kind === 'skill' || kind === 'mcpServer';
}

export function generatedArtifactHasCompleteIdentity(
  artifact: Pick<GeneratedArtifact, 'kind' | 'artifactKey'>,
): boolean {
  return !generatedArtifactKindRequiresArtifactKey(artifact.kind) || Boolean(artifact.artifactKey);
}

export function isGeneratedArtifact(value: unknown): value is GeneratedArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    (candidate.kind === 'instruction' ||
      candidate.kind === 'permission' ||
      candidate.kind === 'hook' ||
      candidate.kind === 'agent' ||
      candidate.kind === 'skill' ||
      candidate.kind === 'mcpServer') &&
    (candidate.platform === 'claude' || candidate.platform === 'codex') &&
    (
      candidate.artifactKey === undefined ||
      typeof candidate.artifactKey === 'string'
    )
  );
}

export function getGeneratedArtifactIdentityKey(
  artifact: GeneratedArtifact,
): string {
  return JSON.stringify([
    artifact.platform,
    artifact.kind,
    artifact.path,
    artifact.artifactKey ?? null,
    artifact.hookGroups
      ?.map((group) => serializeTrackedHookGroupIdentity(group))
      .sort() ?? null,
  ]);
}

export function mergeGeneratedArtifacts(
  ...artifactLists: Array<GeneratedArtifact[] | undefined>
): GeneratedArtifact[] {
  const merged: GeneratedArtifact[] = [];
  const seen = new Set<string>();

  for (const artifactList of artifactLists) {
    for (const artifact of artifactList ?? []) {
      const key = getGeneratedArtifactIdentityKey(artifact);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(artifact);
    }
  }

  return merged;
}

export function getGeneratedArtifactsFromError(error: unknown): GeneratedArtifact[] {
  if (!error || typeof error !== 'object') {
    return [];
  }

  const candidate = (error as GeneratedArtifactsCarrier).generatedArtifacts;
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(isGeneratedArtifact);
}

export function attachGeneratedArtifactsToError(
  error: unknown,
  generatedArtifacts: GeneratedArtifact[],
): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const mergedArtifacts = mergeGeneratedArtifacts(
    getGeneratedArtifactsFromError(normalized),
    generatedArtifacts,
  );

  if (mergedArtifacts.length > 0) {
    Object.defineProperty(normalized, 'generatedArtifacts', {
      value: mergedArtifacts,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }

  return normalized;
}
