import path from 'node:path';

import type { DistributionName, PlatformName } from '../types.js';

export const ARTIFACT_SOURCES_ROOT = path.posix.join('.agents-plugin', 'artifact-sources');

export function getArtifactSourceBundleRelativePath(options: {
  platform?: PlatformName;
  distribution?: DistributionName;
  artifactId: string;
  index: number;
}): string {
  const surface = options.platform ?? options.distribution;
  if (!surface) {
    throw new Error('Artifact source surface is required.');
  }
  return path.posix.join(
    ARTIFACT_SOURCES_ROOT,
    surface,
    options.artifactId,
    String(options.index),
  );
}
