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
  readJsonFileIfExists,
  writeJsonFile,
} from './json.js';

function createEmptyTrackingManifest(): TrackingManifest {
  return {
    version: 1,
    plugins: {},
  };
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
