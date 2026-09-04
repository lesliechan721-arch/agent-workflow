import fs from 'fs-extra';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createBuildSnapshot } from '../../../../scripts/build/build-cache.mjs';
import {
  buildDevWithCache,
} from '../../../../scripts/build/dev-build-cache.mjs';

import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { runWithCurrentRepositoryCwdAsReadOnly } from '../setup/test-isolation.js';

export interface SmokeBuildSnapshot {
  root: string;
  generationId: string;
  outputDigest: string;
  mode: 'release' | 'development';
  persistent?: boolean;
  cliPackageRoot: string;
  cliDistRoot: string;
  catalogOutputRoot: string;
  cleanup: () => Promise<void>;
}

export async function importSmokeSnapshotModule<T>(modulePath: string): Promise<T> {
  return runWithCurrentRepositoryCwdAsReadOnly(
    () => import(pathToFileURL(modulePath).href) as Promise<T>,
    { source: 'smoke snapshot module import repository cwd' },
  );
}

export async function createSmokeBuildSnapshot(
  repoRoot: string,
): Promise<SmokeBuildSnapshot> {
  if (process.env.AW_DIST_BUILD_MODE === 'development') {
    const result = await buildDevWithCache(repoRoot);
    return {
      root: repoRoot,
      generationId: 'development',
      outputDigest: result.targets.map((target) => target.outputDigest).join(':'),
      mode: 'development',
      persistent: true,
      cliPackageRoot: path.join(repoRoot, 'packages', 'cli'),
      cliDistRoot: path.join(repoRoot, 'packages', 'cli', 'dist'),
      catalogOutputRoot: path.join(repoRoot, 'packages', 'cli', 'plugins-dist'),
      cleanup: async () => {},
    };
  }
  const snapshot = await createBuildSnapshot(repoRoot) as SmokeBuildSnapshot;
  snapshot.mode = 'release';
  return snapshot;
}

export async function activateSmokeBuildSnapshot(
  snapshot: SmokeBuildSnapshot,
): Promise<SmokeBuildSnapshot> {
  await installCurrentSmokeDistIsolationBridge(snapshot.cliPackageRoot);
  return snapshot;
}

export async function cleanupSmokeBuildSnapshot(
  snapshot: SmokeBuildSnapshot | null,
): Promise<void> {
  if (!snapshot) {
    return;
  }
  await snapshot.cleanup();
  if (snapshot.persistent) {
    return;
  }
  if (await fs.pathExists(snapshot.root)) {
    throw new Error(`Smoke build snapshot cleanup left a residual path: ${snapshot.root}`);
  }
}
