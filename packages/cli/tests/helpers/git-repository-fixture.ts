import path from 'node:path';
import fs from 'fs-extra';
import { afterAll, beforeAll } from 'vitest';

import { git } from './catalog-source-fixture.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from './test-isolation.js';
import { registerCurrentTestReadonlyFixtureRoot } from '../setup/test-isolation.js';

// Only for cases that require a valid, empty Git repository. History, refs,
// hooks and Git configuration behavior must use their own real Git commands.
export function useEmptyGitRepositoryFixture(): (cwd: string) => Promise<void> {
  let template: IsolatedTestEnvironment;
  beforeAll(async () => {
    template = await createIsolatedTestEnv();
    // Omit sample hooks: these fixtures only need the initialized repository.
    await git(template.layout.fixtureCwd, ['init', '--quiet', '--template='], template.env);
  });
  afterAll(async () => {
    await template?.cleanup();
  });

  return async (cwd) => {
    const templateRoot = registerCurrentTestReadonlyFixtureRoot(
      template.layout.fixtureCwd, 'empty Git repository fixture');
    await fs.copy(path.join(templateRoot, '.git'), path.join(cwd, '.git'), {
      overwrite: false,
      errorOnExist: true,
    });
  };
}
