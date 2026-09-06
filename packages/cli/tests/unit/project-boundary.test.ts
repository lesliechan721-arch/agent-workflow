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
      .rejects.toMatchObject({ code: 'projectConfigIgnored' });

    await fs.outputFile(
      path.join(cwd, '.gitignore'),
      '.agent-workflows/plugin-config/demo/\n',
    );
    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .resolves.toEqual({ state: 'visible' });
  });

  it('keeps a file visible when a later negated rule re-includes it', async () => {
    const cwd = getCurrentSourceTestIsolation().layout.fixtureCwd;
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
    await fs.outputFile(path.join(cwd, '.gitignore'), [
      '.agent-workflows/plugin-config/team/demo/config.json',
      '!.agent-workflows/plugin-config/team/demo/config.json',
      '',
    ].join('\n'));

    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .resolves.toEqual({ state: 'visible' });
  });

  it('keeps a file visible when each ignored parent directory is re-included', async () => {
    const cwd = getCurrentSourceTestIsolation().layout.fixtureCwd;
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
    await fs.outputFile(path.join(cwd, '.gitignore'), [
      '.agent-workflows/',
      '!.agent-workflows/',
      '.agent-workflows/*',
      '!.agent-workflows/plugin-config/',
      '.agent-workflows/plugin-config/*',
      '!.agent-workflows/plugin-config/team/',
      '.agent-workflows/plugin-config/team/*',
      '!.agent-workflows/plugin-config/team/demo/',
      '.agent-workflows/plugin-config/team/demo/*',
      '!.agent-workflows/plugin-config/team/demo/config.json',
      '',
    ].join('\n'));

    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .resolves.toEqual({ state: 'visible' });
  });

  it('keeps a tracked config path visible even when it matches an ignore rule', async () => {
    const cwd = getCurrentSourceTestIsolation().layout.fixtureCwd;
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
      '.agent-workflows/plugin-config/team/demo/config.json\n',
    );
    await git(cwd, ['add', '--force', targetPath]);

    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .resolves.toEqual({ state: 'visible' });
  });

  it('rejects a positive rule from the isolated core excludes file', async () => {
    const cwd = getCurrentSourceTestIsolation().layout.fixtureCwd;
    await git(cwd, ['init', '--quiet']);
    const targetPath = path.join(
      cwd,
      '.agent-workflows',
      'plugin-config',
      'team',
      'demo',
      'config.json',
    );
    const excludesPath = path.join(cwd, 'isolated-excludes');
    await fs.outputJson(targetPath, { schemaVersion: 2 });
    await fs.outputFile(excludesPath, '.agent-workflows/plugin-config/team/\n');
    await git(cwd, ['config', 'core.excludesFile', excludesPath]);

    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .rejects.toMatchObject({ code: 'projectConfigIgnored' });
  });

  it('reports unverified when the project is not a Git worktree', async () => {
    const cwd = getCurrentSourceTestIsolation().layout.fixtureCwd;
    const targetPath = path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json');
    await expect(assertProjectSharedConfigPathVisible({ cwd, targetPath }))
      .resolves.toEqual({ state: 'unverified' });
  });
});
