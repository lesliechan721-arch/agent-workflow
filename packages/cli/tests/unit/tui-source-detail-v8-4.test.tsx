import fs from 'fs-extra';
import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';

afterEach(cleanup);

function sourceData(): TuiStatusLoadResult {
  return {
    pluginSummaries: [],
    payload: {
      schemaVersion: 8,
      catalog: { primarySourceId: 'team', configDigest: 'config', compositeDigest: 'catalog',
        sources: [{ id: 'team', identity: 'identity:team', type: 'git', primary: true,
          requestedRef: 'catalog/stable', catalogVersion: '2.4.0', freshness: 'active' }] },
      filters: { plugins: [], platform: 'both', cwd: '/tmp/source-card-project' },
      targets: [], errors: [],
    },
    configuredSources: [{ id: 'team', type: 'git', primary: true, autoCheck: false,
      url: 'https://example.test/team.git', refPolicy: { type: 'explicit', ref: 'catalog/stable' } }],
    sourceDetails: [{ id: 'team', type: 'git', primary: true, autoCheck: false,
      locationSummary: `https://example.test/${'长名称目录'.repeat(12)}-ADDRESS-END.git`,
      refPolicy: 'explicit', explicitRef: 'catalog/stable', requestedRef: 'catalog/stable',
      sourceIdentity: 'identity:team', configDigest: 'config', catalogVersion: '2.4.0' }],
    catalogGenerations: [{ sourceId: 'team', sourceType: 'git', state: 'ready',
      active: { catalogVersion: '2.4.0', channel: 'latest', requestedRef: 'catalog/stable',
        resolvedCommit: 'abc123', storeKey: 'team-active', digestShort: 'abc123' } }],
  };
}

async function tick(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 15));
}

describe('structured source detail', () => {
  // Risk: a long identity card can hide facts or actions, and candidate/check state can replace Active.
  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps every source fact and safe action reachable at $columns x $rows', async (size) => {
      const executeIntent = vi.fn();
      const captureEvidence = vi.fn();
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(sourceData()),
        executeIntent, captureEvidence,
        probeCatalogFreshness: vi.fn(async () => ({ sourceId: 'team', state: 'updateAvailable' as const,
          activeVersion: '2.4.0', candidate: {
            sourceIdentity: 'identity:team', logicalIdentity: 'workspace:team',
            sourceConfigFingerprint: 'config', catalogVersion: '2.5.0', channel: 'latest' as const,
            requestedRef: 'catalog/stable', resolvedCommit: 'def456',
            manifestDigest: 'manifest-next', snapshotDigest: 'snapshot-next',
          } })),
      });
      await controller.load();
      await controller.recheckCatalogSource('team');
      controller.push({ name: 'sourceDetail', sourceId: 'team' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      const frames: string[] = [];
      const capture = (): string => {
        const frame = instance.lastFrame() ?? '';
        expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
        expect(frame.split('\n').every((line) => stringWidth(line) <= size.columns)).toBe(true);
        expect(frame.match(/›/gu)).toHaveLength(1);
        frames.push(frame);
        return frame;
      };
      capture();
      // The information anchor and actions share one focus sequence.
      instance.stdin.write('a'); await tick(); capture();
      instance.stdin.write('\u001b[A'); await tick(); capture();
      for (let index = 0; index < 30; index += 1) {
        instance.stdin.write('\u001b[B'); await tick(); capture();
      }
      const text = frames.join('\n');
      for (const fact of ['地址', 'ADDRESS-END.git', '下载', '版本策略', '当前目录', '2.4.0',
        '候选目录', '2.5.0', '本次检查', '检查时间', '来源可用', '移除来源', '至少保留一个来源']) {
        expect(text).toContain(fact);
      }
      expect(text).not.toContain('2.4.0 → 2.5.0');
      expect(executeIntent).not.toHaveBeenCalled();
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(controller.getCatalogGeneration('team')?.active?.catalogVersion).toBe('2.4.0');
      instance.stdin.write('a'); await tick(); capture();
      expect(controller.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team' });
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `source-detail-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: [...new Set(frames)] }, { spaces: 2 });
      instance.unmount();
    },
  );
});
