import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../../src/commands/write-commands.js';
import type { CatalogResolution } from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('five write commands', () => {
  it('executes install, upgrade, reinstall, uninstall, and cleanup through rebuild', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.rootDir, 'five-write-source');
    const catalogRoot = path.join(isolation.layout.rootDir, 'five-write-catalog');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'five-write-plugin');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'marketplace-source.json'), {
      owner: { name: 'AW test', url: 'https://example.test/aw' },
      interface: { displayName: 'AW test catalog' },
    });
    await fs.outputJson(manifestPath, {
      name: 'five-write-plugin',
      version: '1.0.0',
      description: 'five write command fixture',
      compatibility: { aw: { minVersion: '0.1.0' } },
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
      extensions: {
        instructions: [{ name: 'rule', title: 'Rule', content: 'Keep writes deterministic.' }],
      },
    });
    await bundlePlugins({ repoRoot: sourceRoot, outputRoot: catalogRoot });
    const runner: NativeCliRunner = async (invocation) => {
      if (invocation.command === 'codex' && invocation.args[0] === '--version') {
        return { exitCode: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
      }
      throw new Error(`Unexpected native call: ${invocation.command} ${invocation.args.join(' ')}`);
    };
    const runtime = {
      env: isolation.env,
      nativeCliRunner: runner,
      catalogResolution: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
    };
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    } as const;

    const results = [
      await installWriteCommand(['five-write-plugin'], options, runtime),
      await upgradeWriteCommand(['five-write-plugin'], options, runtime),
      await reinstallWriteCommand(['five-write-plugin'], options, runtime),
      await uninstallWriteCommand(['five-write-plugin'], options, runtime),
      await cleanupWriteCommand(['five-write-plugin'], options, runtime),
    ];

    expect(results.map((result) => result.overallState), JSON.stringify(results)).toEqual([
      'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded',
    ]);
    expect(results.map((result) => result.rebuildResults[0]?.command)).toEqual([
      'install', 'upgrade', 'reinstall', 'uninstall', 'cleanup',
    ]);
  });
});
