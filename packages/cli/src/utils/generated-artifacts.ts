import type { GeneratedArtifact } from '../types.js';

type GeneratedArtifactsCarrier = {
  generatedArtifacts?: unknown;
};

function isGeneratedArtifact(value: unknown): value is GeneratedArtifact {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === 'string' &&
    (candidate.kind === 'instruction' ||
      candidate.kind === 'permission' ||
      candidate.kind === 'hook' ||
      candidate.kind === 'agent') &&
    (candidate.platform === 'claude' || candidate.platform === 'codex')
  );
}

export function mergeGeneratedArtifacts(
  ...artifactLists: Array<GeneratedArtifact[] | undefined>
): GeneratedArtifact[] {
  const merged: GeneratedArtifact[] = [];
  const seen = new Set<string>();

  for (const artifactList of artifactLists) {
    for (const artifact of artifactList ?? []) {
      const key = JSON.stringify([
        artifact.path,
        artifact.kind,
        artifact.platform,
        artifact.hookGroups ?? null,
      ]);
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
