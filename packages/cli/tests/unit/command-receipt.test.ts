import { describe, expect, it } from 'vitest';

import {
  buildInitReceiptJson,
  buildRebuildReceiptJson,
} from '../../src/output/command-receipt.js';

describe('command receipt v4', () => {
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
        receiptSchemaVersion: 4,
        targets: [{ pluginName: 'git-commit', status: 'succeeded' }],
      });
    }
  });

  it('projects init multi-source evidence without cache paths', () => {
    expect(buildInitReceiptJson({
      ok: true,
      changed: true,
      warnings: [],
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: [{
        id: 'official',
        ok: true,
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'abc',
        catalogVersion: '1.0.0',
        channel: 'latest',
        freshness: 'cache',
      }],
    })).toMatchObject({ command: 'init', receiptSchemaVersion: 4, ok: true });
  });
});
