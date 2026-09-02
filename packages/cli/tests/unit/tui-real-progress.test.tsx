import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeRebuildOperation,
  type DesiredTarget,
  type RebuildActiveStore,
  type RebuildTargetDriver,
} from '../../src/commands/rebuild-operations.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  emitCommandNotice,
  withCommandReporterSession,
} from '../../src/commands/runtime.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationEvidence } from '../../src/tui/controller.js';
import type { PluginMeta } from '../../src/types.js';

afterEach(() => cleanup());

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn();
  }
}

describe('real ConsoleAppV4 progress chain', () => {
  it('renders real rebuild events, reloads status, and restores the reporter session', async () => {
    const plugin: PluginMeta = {
      rootDir: '/fixture/plugin',
      manifestPath: '/fixture/plugin/.agents-plugin/plugin.json',
      manifest: {
        name: 'real-progress',
        version: '1.0.0',
        description: 'real V4 progress fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    };
    const desired: DesiredTarget = {
      plugin,
      postApplySource: plugin,
      identity: {
        pluginName: plugin.manifest.name,
        pluginVersion: plugin.manifest.version,
        platform: 'codex',
        scope: 'user',
        cwd: '/workspace',
      },
      ownedComponents: [{
        kind: 'native-plugin',
        identity: {
          owner: 'agent-workflows',
          plugin: plugin.manifest.name,
          artifactKey: 'native-codex-user',
          platform: 'codex',
          scope: 'user',
        },
        pluginId: 'real-progress@aw',
      }],
      requiresNative: true,
      artifacts: [],
    };
    let live: 'absent' | 'present' = 'absent';
    const driver: RebuildTargetDriver = {
      probeNative: async () => live,
      removeNative: async () => { live = 'absent'; },
      writeNative: async () => { await nextTurn(); live = 'present'; },
      writeArtifacts: async () => undefined,
      runPostApply: async () => undefined,
    };
    const activeStore: RebuildActiveStore = {
      prepare: async () => ({}) as never,
      discard: async () => undefined,
      promote: async () => ({}) as never,
      read: async () => null,
      remove: async () => undefined,
    };
    const progress = createRebuildProgressFeed();
    const stdout = vi.fn();
    const context = createCliExecutionContext({ cwd: '/workspace', io: { stdout } });
    const status = () => ({
      payload: {
        schemaVersion: 7 as const,
        catalog: {
          primarySourceId: 'official',
          configDigest: 'sha256:config',
          compositeDigest: 'sha256:composite',
          sources: [{ id: 'official', identity: 'identity:official', type: 'path' as const, primary: true, requestedRef: 'path', freshness: 'active' as const }],
        },
        filters: { plugins: [], platform: 'both' as const, cwd: '/workspace' },
        targets: [{
          pluginName: 'real-progress',
          pluginId: 'official/real-progress',
          sourceId: 'official',
          sourceIdentity: 'identity:official',
          version: '1.0.0',
          platform: 'codex' as const,
          scope: 'user' as const,
          cwd: '/workspace',
          state: live === 'present' ? 'ready' as const : 'absent' as const,
          components: [{ kind: 'ownership' as const, key: 'fixture', state: live }],
          reasons: [],
          recoveryActions: [],
        }],
        errors: [],
      },
      pluginSummaries: [{
        pluginName: 'real-progress',
        pluginId: 'official/real-progress',
        description: 'real V4 progress fixture',
        supportedTargets: { codex: ['user' as const], claude: [] },
      }],
    });
    const evidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      source: { sourceId: 'official', sourceIdentity: 'identity:official', snapshotDigest: 'sha256:snapshot', contentDigest: 'sha256:content' },
      targetFingerprint: 'sha256:target',
    };
    const controller = new TuiController({
      loadStatus: vi.fn(async () => status()),
      checkSource: vi.fn(),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn(async () => {
        const result = await executeRebuildOperation({
          command: 'install',
          target: desired,
          driver,
          activeStore,
          onActionEvent: (event) => emitCommandEvent(context, event),
        });
        return {
          overallState: result.status,
          targetResults: [{
            target: { platform: 'codex', scope: 'user' },
            state: result.status === 'succeeded' ? 'completed' : 'failed',
          }],
        };
      }),
    }, progress);
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/real-progress',
      platform: 'codex',
      scope: 'user',
    });

    let frames = '';
    await withCommandReporterSession(context.reporter, {
      event: (event) => progress.addEvent(event),
      notice: (notice) => progress.addNotice(notice),
    }, async () => {
      const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
      await nextTurn();
      expect(instance.lastFrame()).toContain(`› ${review.primaryLabel}`);
      await input(instance, '\r');
      await vi.waitUntil(() => controller.snapshot.result?.state === 'succeeded', { timeout: 1_000 });
      await nextTurn();
      frames = instance.frames.join('\n');
      instance.unmount();
    });

    expect(frames).toContain('写入平台插件');
    expect(frames).toContain('插件添加完成');
    expect(live).toBe('present');
    expect(controller.listUserIssues()).toEqual([]);
    await emitCommandNotice(context, { level: 'notice', message: 'reporter restored' });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('reporter restored'));
  });
});
