import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { statusCommand } from '../../src/commands/status.js';
import { CatalogResolutionError } from '../../src/utils/plugin-catalog.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import { createInstallStateFixtureEnv } from '../helpers/install-state-projection-fixtures.js';
import { writeMinimalPluginInstallStateFixture } from '../helpers/minimal-plugin-install-state-fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('status command P8', () => {
  it('keeps verbose status on local evidence when current catalog resolution fails closed', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-command-')),
      scenario: 'installed',
    });
    tempDirs.push(fixture.paths.rootDir);

    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(new CatalogResolutionError({
      selector: {
        kind: 'default',
        cliVersion: '1.0.0',
        defaultChannel: 'latest',
      },
      channel: 'latest',
      catalogVersion: '2.0.0',
      minAwVersion: '9.0.0',
      latestCatalogBlocked: {
        channel: 'latest',
        catalogVersion: '2.0.0',
        minAwVersion: '9.0.0',
      },
      reason: 'latest catalog 需要更高的 aw 版本',
      reasonCode: 'awVersionTooLow',
    }));

    const result = await statusCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
        verbose: true,
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
      } as never,
    );

    const payload = JSON.parse(result.output) as {
      catalog: {
        reasonCode?: string;
        latestCatalogBlocked?: {
          catalogVersion: string;
          minAwVersion: string;
        };
      };
      cells: Array<{
        installState?: {
          currentCatalogAvailable: boolean;
          upgradeAvailable: boolean;
        };
      }>;
    };

    expect(payload.catalog.reasonCode).toBe('awVersionTooLow');
    expect(payload.catalog.latestCatalogBlocked).toMatchObject({
      catalogVersion: '2.0.0',
      minAwVersion: '9.0.0',
    });
    expect(payload.cells[0]?.installState).toMatchObject({
      currentCatalogAvailable: false,
      upgradeAvailable: false,
    });
    expect(result.currentPluginByName).toEqual({});
  });
});
