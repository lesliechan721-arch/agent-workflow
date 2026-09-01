import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV7Payload } from '../../src/commands/status-v6.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiControllerDependencies } from '../../src/tui/controller.js';

afterEach(() => cleanup());

const payload: StatusV7Payload = {
  schemaVersion: 7,
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

function dependencies(loadStatus: TuiControllerDependencies['loadStatus']): TuiControllerDependencies {
  return {
    loadStatus,
    captureEvidence: async () => ({
      catalog: {
        configDigest: payload.catalog.configDigest,
        compositeDigest: payload.catalog.compositeDigest,
      },
    }),
    executeIntent: async () => undefined,
  };
}

describe('TUI Active Catalog session', () => {
  it('shows the sync recovery command when a source has no Active snapshot', async () => {
    const controller = new TuiController(dependencies(async () => ({
      payload,
      pluginSummaries: [],
      catalogGenerations: [{
        sourceId: 'official',
        sourceType: 'git',
        errorCode: 'catalogGenerationUnavailable',
        syncInstruction: 'aw catalog source sync official',
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
    expect(instance.lastFrame()).toContain('aw catalog source sync official');
  });

  it('reloads the TUI explicitly without any refresh dependency', async () => {
    const loadStatus = vi.fn(async () => ({ payload, pluginSummaries: [] }));
    const controller = new TuiController(dependencies(loadStatus));
    await controller.load();
    await controller.reloadCatalog({ sourceId: 'official' });
    expect(loadStatus).toHaveBeenCalledTimes(2);
  });
});
