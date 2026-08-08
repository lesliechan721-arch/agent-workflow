import path from 'node:path';

import fs from 'fs-extra';

import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../utils/plugin-scripts.js';
import { readPluginManifest } from '../utils/manifest.js';
import type { PluginMeta } from '../types.js';

function isPathInside(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export type VerifiedHistoricalBundlePluginResult =
  | {
    status: 'ok';
    plugin: PluginMeta;
    bundleRoot: string;
    manifestPath: string;
  }
  | {
    status: 'invalid';
    reason: string;
  };

export async function loadVerifiedHistoricalBundlePlugin(options: {
  pluginName: string;
  pluginVersion: string;
  runtimeRoot: string;
  bundleRoot: string;
  manifestPath: string;
  sourceManifestDigest: string;
  bundleFingerprint: string;
}): Promise<VerifiedHistoricalBundlePluginResult> {
  let runtimeRoot: string;
  let bundleRoot: string;
  let manifestPath: string;
  try {
    runtimeRoot = await fs.realpath(options.runtimeRoot);
    bundleRoot = await fs.realpath(options.bundleRoot);
    manifestPath = await fs.realpath(options.manifestPath);
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical bundle 路径不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isPathInside(bundleRoot, runtimeRoot)) {
    return {
      status: 'invalid',
      reason: 'historical bundle root 不在 runtime root 内',
    };
  }
  if (!isPathInside(manifestPath, bundleRoot)) {
    return {
      status: 'invalid',
      reason: 'historical manifest path 不在 bundle root 内',
    };
  }

  try {
    const [manifestDigest, bundleFingerprint, plugin] = await Promise.all([
      calculateFileDigest(manifestPath),
      calculatePluginBundleFingerprint(bundleRoot),
      readPluginManifest(bundleRoot, { mode: 'bundle' }),
    ]);
    if (bundleFingerprint !== options.bundleFingerprint) {
      return {
        status: 'invalid',
        reason: 'historical bundle fingerprint 与记录不一致',
      };
    }
    if (
      plugin.manifest.name !== options.pluginName ||
      plugin.manifest.version !== options.pluginVersion ||
      path.resolve(plugin.manifestPath) !== path.resolve(manifestPath)
    ) {
      return {
        status: 'invalid',
        reason: 'historical manifest identity 与记录不一致',
      };
    }
    if (manifestDigest !== options.sourceManifestDigest) {
      return {
        status: 'invalid',
        reason: 'historical manifest digest 与记录不一致',
      };
    }
    return {
      status: 'ok',
      plugin,
      bundleRoot,
      manifestPath,
    };
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical bundle 内容不可验证：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
