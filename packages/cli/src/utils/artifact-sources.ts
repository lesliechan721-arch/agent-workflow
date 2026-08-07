import path from 'node:path';

import type { PlatformName } from '../types.js';

export const ARTIFACT_SOURCES_ROOT = path.posix.join('.agents-plugin', 'artifact-sources');

export function getArtifactSourceBundleRelativePath(options: {
  platform: PlatformName;
  artifactId: string;
  index: number;
}): string {
  return path.posix.join(
    ARTIFACT_SOURCES_ROOT,
    options.platform,
    options.artifactId,
    String(options.index),
  );
}
