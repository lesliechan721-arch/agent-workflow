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
import { generatedArtifactKindRequiresArtifactKey } from './generated-artifacts.js';
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

function assertAbsoluteArtifactPath(artifact: GeneratedArtifact): void {
  if (!path.isAbsolute(artifact.path)) {
    throw new Error(`Tracking artifact path must be absolute: ${artifact.path}`);
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
  const manifest = await readJsonFileIfExists<TrackingManifest>(manifestPath);
  return manifest ?? createEmptyTrackingManifest();
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
  for (const artifact of artifacts) {
    assertAbsoluteArtifactPath(artifact);
  }

  return {
    ...manifest,
    plugins: {
      ...manifest.plugins,
      [pluginName]: {
        name: pluginName,
        generatedAt: new Date().toISOString(),
        artifacts,
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
