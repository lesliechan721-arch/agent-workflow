import { describe, expect, it, vi } from 'vitest';

import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../../src/commands/write-commands.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('five write command transition gate', () => {
  it('fails every command before catalog, native, reporter, or filesystem work', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const nativeCliRunner = vi.fn();
    const report = vi.fn();
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
      reporter: { event: report, notice: vi.fn() },
      debugLogger: { log: vi.fn() },
    };
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    } as const;

    const results = [
      await installWriteCommand(['demo'], options, runtime),
      await upgradeWriteCommand(['demo'], options, runtime),
      await reinstallWriteCommand(['demo'], options, runtime),
      await uninstallWriteCommand(['demo'], options, runtime),
      await cleanupWriteCommand(['demo'], options, runtime),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        overallState: 'failed',
        rebuildResults: [],
        targetResults: [],
        warnings: [expect.stringContaining('runtimeTransitionIncomplete')],
        receiptTargets: [{
          pluginName: 'demo',
          platform: 'codex',
          scope: 'project',
        }],
      });
    }
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('also gates upgrade --all without target discovery', async () => {
    const result = await upgradeWriteCommand([], {
      cwd: getCurrentSourceTestIsolation().layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
      all: true,
    });
    expect(result.overallState).toBe('failed');
    expect(result.warnings).toEqual([expect.stringContaining('runtimeTransitionIncomplete')]);
    expect(result.receiptTargets).toEqual([]);
  });
});
