import path from 'node:path';

import fs from 'fs-extra';

import {
  TRACKING_MANIFEST_FILE,
} from '../constants.js';
import type {
  GeneratedArtifact,
  TrackingManifest,
  TrackingPluginRecord,
} from '../types.js';
import {
  generatedArtifactKindRequiresArtifactKey,
  getGeneratedArtifactIdentityKey,
  isGeneratedArtifact,
} from './generated-artifacts.js';
import {
  readJsonFileIfExists,
  writeJsonFile,
} from './json.js';

export interface TrackingArtifactIntegrityError {
  code: 'missingArtifactKey';
  kind: Extract<GeneratedArtifact['kind'], 'skill' | 'mcpServer'>;
  platform: GeneratedArtifact['platform'];
  path: string;
  message: string;
}

function createEmptyTrackingManifest(): TrackingManifest {
  return {
    version: 1,
    plugins: {},
  };
}

function assertValidTrackingArtifact(artifact: unknown, context: string): asserts artifact is GeneratedArtifact {
  if (!isGeneratedArtifact(artifact)) {
    throw new Error(`Invalid ${context}: unsupported tracking artifact shape.`);
  }
}

function assertValidTrackingRecord(
  record: unknown,
  pluginName: string,
): asserts record is TrackingPluginRecord {
  if (!record || typeof record !== 'object') {
    throw new Error(`Invalid tracking record for plugin "${pluginName}".`);
  }

  const candidate = record as Record<string, unknown>;
  if (typeof candidate.name !== 'string') {
    throw new Error(`Invalid tracking record for plugin "${pluginName}": "name" must be a string.`);
  }
  if (typeof candidate.generatedAt !== 'string') {
    throw new Error(`Invalid tracking record for plugin "${pluginName}": "generatedAt" must be a string.`);
  }
  if (!Array.isArray(candidate.artifacts)) {
    throw new Error(`Invalid tracking record for plugin "${pluginName}": "artifacts" must be an array.`);
  }

  candidate.artifacts.forEach((artifact, index) =>
    assertValidTrackingArtifact(artifact, `tracking record "${pluginName}".artifacts[${index}]`));
}

function normalizeTrackingManifest(manifest: unknown): TrackingManifest {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Invalid tracking manifest: root must be an object.');
  }

  const candidate = manifest as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new Error('Invalid tracking manifest: unsupported version.');
  }
  if (!candidate.plugins || typeof candidate.plugins !== 'object' || Array.isArray(candidate.plugins)) {
    throw new Error('Invalid tracking manifest: "plugins" must be an object.');
  }

  const plugins = candidate.plugins as Record<string, unknown>;
  for (const [pluginName, record] of Object.entries(plugins)) {
    assertValidTrackingRecord(record, pluginName);
  }

  return candidate as unknown as TrackingManifest;
}

function assertAbsoluteArtifactPath(artifact: GeneratedArtifact): void {
  if (!path.isAbsolute(artifact.path)) {
    throw new Error(`Tracking artifact path must be absolute: ${artifact.path}`);
  }

  for (const extraPath of artifact.paths ?? []) {
    if (!path.isAbsolute(extraPath)) {
      throw new Error(`Tracking artifact path must be absolute: ${extraPath}`);
    }
  }
}

function assertTrackingManifestArtifactPaths(manifest: TrackingManifest): void {
  for (const record of Object.values(manifest.plugins)) {
    for (const artifact of record.artifacts) {
      assertAbsoluteArtifactPath(artifact);
    }
  }
}

export function getTrackingArtifactIntegrityErrors(
  artifacts: GeneratedArtifact[],
): TrackingArtifactIntegrityError[] {
  const errors: TrackingArtifactIntegrityError[] = [];

  for (const artifact of artifacts) {
    if (!generatedArtifactKindRequiresArtifactKey(artifact.kind) || artifact.artifactKey) {
      continue;
    }

    errors.push({
      code: 'missingArtifactKey',
      kind: artifact.kind,
      platform: artifact.platform,
      path: artifact.path,
      message: `Tracking artifact kind "${artifact.kind}" requires artifactKey: ${artifact.path}`,
    });
  }

  return errors;
}

export function getTrackingManifestPath(targetDir: string): string {
  return path.join(targetDir, TRACKING_MANIFEST_FILE);
}

export async function readTrackingManifest(targetDir: string): Promise<TrackingManifest> {
  const manifestPath = getTrackingManifestPath(targetDir);
  const manifest = await readJsonFileIfExists<unknown>(manifestPath);
  const normalizedManifest = manifest === null
    ? createEmptyTrackingManifest()
    : normalizeTrackingManifest(manifest);
  assertTrackingManifestArtifactPaths(normalizedManifest);
  return normalizedManifest;
}

export async function readTrackingRecord(
  targetDir: string,
  pluginName: string,
): Promise<TrackingPluginRecord | undefined> {
  const manifest = await readTrackingManifest(targetDir);
  return manifest.plugins[pluginName];
}

export function getTrackingRecord(
  manifest: TrackingManifest,
  pluginName: string,
): TrackingPluginRecord | undefined {
  return manifest.plugins[pluginName];
}

export function hasTrackingArtifacts(
  record: TrackingPluginRecord | undefined,
  ...kinds: GeneratedArtifact['kind'][]
): boolean {
  if (!record) {
    return false;
  }

  if (kinds.length === 0) {
    return record.artifacts.length > 0;
  }

  const expectedKinds = new Set(kinds);
  return record.artifacts.some((artifact) => expectedKinds.has(artifact.kind));
}

export async function writeTrackingManifest(
  targetDir: string,
  manifest: TrackingManifest,
): Promise<void> {
  normalizeTrackingManifest(manifest);
  assertTrackingManifestArtifactPaths(manifest);
  const manifestPath = getTrackingManifestPath(targetDir);
  await fs.ensureDir(path.dirname(manifestPath));
  const tempPath = path.join(
    path.dirname(manifestPath),
    `${path.basename(manifestPath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await writeJsonFile(tempPath, manifest);
  await fs.move(tempPath, manifestPath, { overwrite: true });
}

export function upsertTrackingRecordInManifest(
  manifest: TrackingManifest,
  pluginName: string,
  artifacts: GeneratedArtifact[],
): TrackingManifest {
  const previousArtifacts = manifest.plugins[pluginName]?.artifacts ?? [];
  for (const artifact of artifacts) {
    assertAbsoluteArtifactPath(artifact);
  }

  const nextArtifacts = artifacts.map((artifact) => {
    const previousArtifact = previousArtifacts.find((candidate) => {
      if (
        artifact.id &&
        artifact.target &&
        candidate.id === artifact.id &&
        candidate.target === artifact.target &&
        candidate.platform === artifact.platform
      ) {
        return true;
      }

      if (
        generatedArtifactKindRequiresArtifactKey(artifact.kind) &&
        artifact.artifactKey &&
        candidate.kind === artifact.kind &&
        candidate.platform === artifact.platform &&
        candidate.artifactKey === artifact.artifactKey
      ) {
        return true;
      }

      return getGeneratedArtifactIdentityKey(candidate) === getGeneratedArtifactIdentityKey(artifact);
    });

    if (!previousArtifact) {
      return artifact;
    }

    return {
      ...artifact,
      ...(artifact.lastRefresh === undefined && previousArtifact.lastRefresh !== undefined
        ? { lastRefresh: structuredClone(previousArtifact.lastRefresh) }
        : {}),
      ...(artifact.refreshReach === undefined && previousArtifact.refreshReach !== undefined
        ? { refreshReach: structuredClone(previousArtifact.refreshReach) }
        : {}),
    };
  });

  return {
    ...manifest,
    plugins: {
      ...manifest.plugins,
      [pluginName]: {
        name: pluginName,
        generatedAt: new Date().toISOString(),
        artifacts: nextArtifacts,
      },
    },
  };
}

export function removeTrackingRecordFromManifest(
  manifest: TrackingManifest,
  pluginName: string,
): TrackingManifest {
  const nextPlugins = { ...manifest.plugins };
  delete nextPlugins[pluginName];
  return {
    ...manifest,
    plugins: nextPlugins,
  };
}

export async function upsertTrackingRecord(
  targetDir: string,
  pluginName: string,
  artifacts: GeneratedArtifact[],
): Promise<void> {
  const manifest = await readTrackingManifest(targetDir);
  await writeTrackingManifest(
    targetDir,
    upsertTrackingRecordInManifest(manifest, pluginName, artifacts),
  );
}

export async function removeTrackingRecord(targetDir: string, pluginName: string): Promise<void> {
  const manifest = await readTrackingManifest(targetDir);
  await writeTrackingManifest(
    targetDir,
    removeTrackingRecordFromManifest(manifest, pluginName),
  );
}
