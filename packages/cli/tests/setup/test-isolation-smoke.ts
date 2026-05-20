import path from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import {
  getCurrentSourceTestRootRegistry,
  getSourceTestRepositoryCwd,
  registerCurrentTestReadonlyFixtureRoot,
} from './test-isolation.js';
import {
  installDistStateForTests,
  resetDistStateForTests,
} from './reset-dist-state.js';

function registerSmokeReadonlyFixtureRoots(): void {
  const cliPackageRoot = path.join(getSourceTestRepositoryCwd(), 'packages', 'cli');

  registerCurrentTestReadonlyFixtureRoot(
    path.join(cliPackageRoot, 'dist'),
    'smoke compiled dist root',
  );
  registerCurrentTestReadonlyFixtureRoot(
    path.join(cliPackageRoot, 'plugins-dist'),
    'smoke compiled plugins-dist root',
  );
}

export async function installCurrentSmokeDistIsolationBridge(): Promise<void> {
  await installDistStateForTests(getCurrentSourceTestRootRegistry());
}

beforeEach(async () => {
  registerSmokeReadonlyFixtureRoots();
});

afterEach(async () => {
  await resetDistStateForTests();
});
