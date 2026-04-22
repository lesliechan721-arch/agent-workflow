import path from 'node:path';

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

export async function writeTrackingManifest(
  targetDir: string,
  manifest: TrackingManifest,
): Promise<void> {
  await writeJsonFile(getTrackingManifestPath(targetDir), manifest);
}

export async function upsertTrackingRecord(
  targetDir: string,
  pluginName: string,
  artifacts: GeneratedArtifact[],
): Promise<void> {
  const manifest = await readTrackingManifest(targetDir);
  const record: TrackingPluginRecord = {
    name: pluginName,
    generatedAt: new Date().toISOString(),
    artifacts,
  };
  manifest.plugins[pluginName] = record;
  await writeTrackingManifest(targetDir, manifest);
}

export async function removeTrackingRecord(targetDir: string, pluginName: string): Promise<void> {
  const manifest = await readTrackingManifest(targetDir);
  delete manifest.plugins[pluginName];
  await writeTrackingManifest(targetDir, manifest);
}
