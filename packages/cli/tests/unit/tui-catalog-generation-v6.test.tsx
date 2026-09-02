import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV6Payload } from '../../src/commands/status-v6.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiControllerDependencies } from '../../src/tui/controller.js';

afterEach(() => cleanup());

const payload: StatusV6Payload = {
  schemaVersion: 6,
  catalog: {
    primarySourceId: 'official',
    configDigest: `sha256:${'a'.repeat(64)}`,
    compositeDigest: `sha256:${'b'.repeat(64)}`,
    sources: [{
      id: 'official',
      identity: 'identity:official',
      type: 'git',
      primary: true,
      requestedRef: 'refs/heads/catalog/latest',
      error: 'No Active snapshot.',
      errorCode: 'catalogGenerationUnavailable',
    }],
  },
  filters: { plugins: [], platform: 'both', cwd: '/workspace' },
  targets: [],
  errors: [],
};

function dependencies(
  loadStatus: TuiControllerDependencies['loadStatus'],
  overrides: Partial<TuiControllerDependencies> = {},
): TuiControllerDependencies {
  return {
    loadStatus,
    captureEvidence: async () => ({
      catalog: {
        configDigest: payload.catalog.configDigest,
        compositeDigest: payload.catalog.compositeDigest,
      },
    }),
    executeIntent: async () => undefined,
    ...overrides,
  };
}

describe('TUI Active Catalog session', () => {
  it('shows the in-TUI activation action when a source has no Active snapshot', async () => {
    const controller = new TuiController(dependencies(async () => ({
      payload,
      pluginSummaries: [],
      catalogGenerations: [{
        sourceId: 'official',
        sourceType: 'git',
        errorCode: 'catalogGenerationUnavailable',
      }],
      sourceDetails: [{
        id: 'official',
        type: 'git',
        primary: true,
        locationSummary: 'https://example.invalid/catalog.git',
        refPolicy: 'channel',
        pluginCount: 0,
        sourceIdentity: 'identity:official',
        requestedRef: 'refs/heads/catalog/latest',
        errorCode: 'catalogGenerationUnavailable',
        configDigest: payload.catalog.configDigest,
      }],
    })));
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await controller.load();
    controller.push({ name: 'sourceDetail', sourceId: 'official' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(instance.lastFrame()).toContain('获取并启用');
    expect(instance.lastFrame()).not.toContain('aw catalog source sync official');
  });

  it('reloads the TUI explicitly without any refresh dependency', async () => {
    const loadStatus = vi.fn(async () => ({ payload, pluginSummaries: [] }));
    const controller = new TuiController(dependencies(loadStatus));
    await controller.load();
    await controller.reloadCatalog({ sourceId: 'official' });
    expect(loadStatus).toHaveBeenCalledTimes(2);
  });

  it('shows a checked candidate update without replacing the current Active', async () => {
    const readyPayload: StatusV6Payload = {
      ...payload,
      catalog: {
        ...payload.catalog,
        sources: [{
          id: 'official',
          identity: 'identity:official',
          type: 'git',
          primary: true,
          requestedRef: 'refs/heads/catalog/latest',
          resolvedCommit: 'a'.repeat(40),
          catalogVersion: '1.0.0',
          channel: 'latest',
          freshness: 'active',
        }],
      },
    };
    const controller = new TuiController(dependencies(async () => ({
      payload: readyPayload,
      pluginSummaries: [],
      catalogGenerations: [{
        sourceId: 'official',
        sourceType: 'git',
        state: 'ready',
        active: {
          catalogVersion: '1.0.0',
          channel: 'latest',
          requestedRef: 'refs/heads/catalog/latest',
          resolvedCommit: 'a'.repeat(40),
          storeKey: 'identity/current',
          digestShort: 'aaaaaaaa',
        },
      }],
      sourceDetails: [{
        id: 'official',
        type: 'git',
        primary: true,
        locationSummary: 'https://example.invalid/catalog.git',
        refPolicy: 'explicit',
        explicitRef: 'refs/heads/catalog/latest',
        pluginCount: 0,
        sourceIdentity: 'identity:official',
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'a'.repeat(40),
        catalogVersion: '1.0.0',
        channel: 'latest',
        configDigest: readyPayload.catalog.configDigest,
      }],
    }), {
      probeCatalogFreshness: async () => ({
        sourceId: 'official',
        state: 'updateAvailable',
        activeVersion: '1.0.0',
        candidate: {
          sourceConfigFingerprint: `sha256:${'1'.repeat(64)}`,
          sourceIdentity: `sha256:${'2'.repeat(64)}`,
          logicalIdentity: 'official',
          requestedRef: 'refs/heads/catalog/latest',
          resolvedCommit: 'b'.repeat(40),
          catalogVersion: '2.0.0',
          channel: 'latest',
          manifestDigest: `sha256:${'3'.repeat(64)}`,
          snapshotDigest: `sha256:${'4'.repeat(64)}`,
        },
      }),
    }));
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    controller.push({ name: 'sourceDetail', sourceId: 'official' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(instance.lastFrame()).toContain('当前使用 1.0.0；候选版本 2.0.0 可更新');
    expect(instance.lastFrame()).toContain('更新到 2.0.0');
    expect(controller.getCatalogGeneration('official')?.active?.catalogVersion).toBe('1.0.0');
    controller.dispose();
  });
});
