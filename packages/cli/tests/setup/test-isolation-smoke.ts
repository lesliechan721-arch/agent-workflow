import path from 'node:path';

import { afterEach } from 'vitest';

import {
  getCurrentSourceTestRootRegistry,
  registerCurrentTestReadonlyFixtureRoot,
  runWithCurrentRepositoryCwdAsReadOnly,
} from './test-isolation.js';
import {
  installDistStateForTests,
  resetDistStateForTests,
} from './reset-dist-state.js';

export async function installCurrentSmokeDistIsolationBridge(
  cliPackageRoot: string,
): Promise<void> {
  registerCurrentTestReadonlyFixtureRoot(
    path.join(cliPackageRoot, 'dist'),
    'smoke consumer compiled dist root',
  );
  registerCurrentTestReadonlyFixtureRoot(
    path.join(cliPackageRoot, 'plugins-dist'),
    'smoke consumer compiled plugins-dist root',
  );
  await runWithCurrentRepositoryCwdAsReadOnly(
    () => installDistStateForTests(getCurrentSourceTestRootRegistry(), cliPackageRoot),
    { source: 'smoke dist isolation bridge repository cwd' },
  );
}

afterEach(async () => {
  await resetDistStateForTests();
});
