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
import type { CommandEvent } from '../../src/output/model.js';
import type { CatalogResolution } from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('five write commands', () => {
  it('expands both only to a current plugin supported platforms before version probes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.rootDir, 'both-source');
    const catalogRoot = path.join(isolation.layout.rootDir, 'both-catalog');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'marketplace-source.json'), {
      owner: { name: 'AW test', url: 'https://example.test/aw' },
      interface: { displayName: 'AW test catalog' },
    });
    await fs.outputJson(
      path.join(sourceRoot, 'plugins', 'codex-only', '.agents-plugin', 'plugin.json'),
      {
        name: 'codex-only',
        version: '1.0.0',
        description: 'both expansion fixture',
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
          instructions: [{ name: 'rule', title: 'Rule', content: 'Codex only.' }],
        },
      },
    );
    await bundlePlugins({ repoRoot: sourceRoot, outputRoot: catalogRoot });
    const calls: string[] = [];
    const result = await installWriteCommand(['codex-only'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, {
      env: isolation.env,
      catalogResolution: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      nativeCliRunner: async (invocation) => {
        calls.push([invocation.command, ...invocation.args].join(' '));
        if (invocation.command === 'codex' && invocation.args[0] === '--version') {
          return { exitCode: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
        }
        throw new Error(`Unexpected native call: ${invocation.command} ${invocation.args.join(' ')}`);
      },
    });

    expect(result.overallState, JSON.stringify(result)).toBe('succeeded');
    expect(result.platforms).toEqual(['codex']);
    expect(result.targetResults).toHaveLength(1);
    expect(calls).toEqual(['codex --version']);
  });

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
    const reported: CommandEvent[] = [];
    const debugged: CommandEvent[] = [];
    const runtime = {
      env: isolation.env,
      nativeCliRunner: runner,
      catalogResolution: { rootDir: catalogRoot, source: 'local' } as CatalogResolution,
      reporter: {
        event: (event: CommandEvent) => { reported.push(event); },
        notice: () => {},
      },
      debugLogger: {
        log: (event: CommandEvent) => { debugged.push(event); },
      },
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
    const actionEvents = reported.filter((event) => event.type === 'rebuild:action');
    expect(actionEvents.length).toBeGreaterThan(0);
    expect(debugged.filter((event) => event.type === 'rebuild:action')).toEqual(actionEvents);
    for (let index = 0; index < actionEvents.length; index += 2) {
      const start = actionEvents[index]!;
      const terminal = actionEvents[index + 1]!;
      expect(start.data).toMatchObject({ phase: 'start' });
      expect(terminal.data).toMatchObject({
        name: (start.data as { name: string }).name,
        phase: expect.stringMatching(/^(?:success|failure)$/),
        durationMs: expect.any(Number),
      });
      expect(terminal.source).toEqual(start.source);
    }
  });
});
