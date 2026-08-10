import { describe, expect, it } from 'vitest';

import {
  buildInitReceiptJson,
  buildRebuildReceiptJson,
  renderRebuildReceipt,
} from '../../src/output/command-receipt.js';

describe('command receipt v3', () => {
  it('serializes the five write commands with one receipt schema', () => {
    for (const command of ['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup'] as const) {
      const receipt = buildRebuildReceiptJson(command, {
        platforms: ['codex'],
        plugins: ['git-commit'],
        warnings: [],
        overallState: 'succeeded',
        rebuildResults: [{
          status: 'succeeded',
          command,
          target: {
            pluginName: 'git-commit',
            pluginVersion: '1.0.0',
            platform: 'codex',
            scope: 'user',
            cwd: '/repo',
          },
          actions: [{ name: 'postcheck.inspect', status: 'succeeded' }],
          cleanupAttempted: command === 'cleanup' || command === 'reinstall',
          removed: [],
          absent: [],
          residual: [],
          quarantined: [],
          failures: [],
        }],
      });
      expect(receipt).toMatchObject({
        ok: true,
        command,
        receiptSchemaVersion: 3,
        targets: [{ plugin: 'git-commit', status: 'succeeded' }],
      });
      expect(renderRebuildReceipt(command, {
        platforms: ['codex'], plugins: ['git-commit'], warnings: [], rebuildResults: [],
      })[0]).toContain(command);
    }
  });

  it('keeps init on its catalog cache receipt', () => {
    expect(buildInitReceiptJson({
      rootDir: '/tmp/aw',
      changed: true,
      warnings: [],
      catalog: { rootDir: '/tmp/aw', source: 'cache' },
    })).toMatchObject({ command: 'init', receiptSchemaVersion: 2 });
  });
});
