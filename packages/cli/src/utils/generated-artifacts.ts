import crypto from 'node:crypto';

import type { GeneratedArtifact } from '../types.js';
import { serializeTrackedHookGroupIdentity } from './hooks-contract.js';

type GeneratedArtifactsCarrier = {
  generatedArtifacts?: unknown;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isArtifactLastRefresh(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.status === 'succeeded' ||
      candidate.status === 'failed' ||
      candidate.status === 'skipped') &&
    typeof candidate.updatedAt === 'string' &&
    (candidate.event === 'install' ||
      candidate.event === 'upgrade' ||
      candidate.event === 'refresh') &&
    (candidate.triggerKeys === undefined || isStringArray(candidate.triggerKeys)) &&
    (candidate.error === undefined || typeof candidate.error === 'string')
  );
}

function isArtifactRefreshReach(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.commandScope === 'user' || candidate.commandScope === 'project') &&
    (candidate.refreshedUserTarget === undefined || typeof candidate.refreshedUserTarget === 'boolean') &&
    (
      candidate.refreshedCurrentProjectTarget === undefined ||
      typeof candidate.refreshedCurrentProjectTarget === 'boolean'
    ) &&
    (
      candidate.scannedHistoricalProjects === undefined ||
      typeof candidate.scannedHistoricalProjects === 'boolean'
    ) &&
    (
      candidate.historicalProjectTargetsMayBeStale === undefined ||
      typeof candidate.historicalProjectTargetsMayBeStale === 'boolean'
    ) &&
    (
      candidate.knownProjectTargetsOutsideReach === undefined ||
      isStringArray(candidate.knownProjectTargetsOutsideReach)
    )
  );
}

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
    (
      candidate.paths === undefined ||
      (
        Array.isArray(candidate.paths) &&
        candidate.paths.every((entry) => typeof entry === 'string')
      )
    ) &&
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
    ) &&
    (
      candidate.id === undefined ||
      typeof candidate.id === 'string'
    ) &&
    (
      candidate.target === undefined ||
      candidate.target === 'codex.developerInstructionsBlock' ||
      candidate.target === 'codex.agentRole'
    ) &&
    (
      candidate.state === undefined ||
      candidate.state === 'present' ||
      candidate.state === 'disabled'
    ) &&
    (
      candidate.disabledReason === undefined ||
      typeof candidate.disabledReason === 'string'
    ) &&
    (
      candidate.refreshKeys === undefined ||
      (
        isStringArray(candidate.refreshKeys)
      )
    ) &&
    (
      candidate.configDigest === undefined ||
      typeof candidate.configDigest === 'string'
    ) &&
    (
      candidate.contentDigest === undefined ||
      typeof candidate.contentDigest === 'string'
    ) &&
    (
      candidate.roleKey === undefined ||
      typeof candidate.roleKey === 'string'
    ) &&
    (
      candidate.lastRefresh === undefined ||
      isArtifactLastRefresh(candidate.lastRefresh)
    ) &&
    (
      candidate.refreshReach === undefined ||
      isArtifactRefreshReach(candidate.refreshReach)
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
    artifact.id ?? null,
    artifact.target ?? null,
    artifact.roleKey ?? null,
    artifact.artifactKey ?? null,
    artifact.hookGroups
      ?.map((group) => serializeTrackedHookGroupIdentity(group))
      .sort() ?? null,
  ]);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createGeneratedArtifactContentDigest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
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
