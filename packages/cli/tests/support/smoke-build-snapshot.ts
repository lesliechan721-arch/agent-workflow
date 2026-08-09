import fs from 'fs-extra';
import { pathToFileURL } from 'node:url';

import { createBuildSnapshot } from '../../../../scripts/build/build-cache.mjs';

import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { runWithCurrentRepositoryCwdAsReadOnly } from '../setup/test-isolation.js';

export interface SmokeBuildSnapshot {
  root: string;
  generationId: string;
  outputDigest: string;
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
  return createBuildSnapshot(repoRoot) as Promise<SmokeBuildSnapshot>;
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
  if (await fs.pathExists(snapshot.root)) {
    throw new Error(`Smoke build snapshot cleanup left a residual path: ${snapshot.root}`);
  }
}
