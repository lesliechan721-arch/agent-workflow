import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { assertProjectSharedConfigPathVisible } from '../../src/utils/project-boundary.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('project config Git visibility', () => {
  it('checks the namespaced shared store and does not reinterpret a legacy bare-name ignore', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    await git(cwd, ['init', '--quiet']);
    const targetPath = path.join(
      cwd,
      '.agent-workflows',
      'plugin-config',
      'team',
      'demo',
      'config.json',
    );
    await fs.outputJson(targetPath, { schemaVersion: 2 });
    await fs.outputFile(
      path.join(cwd, '.gitignore'),
      '.agent-workflows/plugin-config/team/\n',
    );
    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .rejects.toThrow('.agent-workflows/plugin-config/team/demo/config.json');

    await fs.outputFile(
      path.join(cwd, '.gitignore'),
      '.agent-workflows/plugin-config/demo/\n',
    );
    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath })).resolves.toBeUndefined();
  });
});
