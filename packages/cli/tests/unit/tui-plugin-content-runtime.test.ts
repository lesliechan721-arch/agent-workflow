import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import type { PluginContentOverview } from '../../src/tui/plugin-content.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mocks = vi.hoisted(() => ({
  statusCommandV8: vi.fn(),
  projectPluginContentOverview: vi.fn(),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV8: async (...args: unknown[]) => ({
    projectIntentObservation: { state: 'absent' as const },
    ...await mocks.statusCommandV8(...args),
  }),
}));

vi.mock('../../src/tui/plugin-content.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/tui/plugin-content.js')>(),
  projectPluginContentOverview: mocks.projectPluginContentOverview,
}));

describe('TUI on-demand plugin content runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not project content during status load and projects only the requested plugin', async () => {
    // Risk: startup and H reload used to scan every plugin content tree before the page was opened.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'content-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first' },
      { name: 'second' },
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    const configured = await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    mocks.statusCommandV8.mockResolvedValue({
      payload: {
        schemaVersion: 8,
        catalog: {
          primarySourceId: 'team',
          configDigest: configured.digest,
          compositeDigest: 'sha256:catalog',
          sources: [{
            id: 'team', identity: 'fixture', type: 'path', primary: true,
            requestedRef: 'path', catalogVersion: '1.0.0', freshness: 'active',
          }],
        },
        filters: { plugins: [], platform: 'both', cwd: isolation.layout.fixtureCwd },
        targets: [],
        errors: [],
      },
      pluginSummaries: [
        { pluginName: 'first', pluginId: 'team/first', description: 'first', version: '1.0.0' },
        { pluginName: 'second', pluginId: 'team/second', description: 'second', version: '1.0.0' },
      ],
      targetRevisions: [],
    });
    mocks.projectPluginContentOverview.mockImplementation(async (options): Promise<PluginContentOverview> => ({
      pluginId: options.pluginId,
      pluginVersion: options.plugin.manifest.version,
      catalogVersion: options.catalogVersion,
      evidence: 'catalogBundle',
      items: [],
      notices: [],
    }));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const signal = new AbortController().signal;

    const status = await dependencies.loadStatus(signal);

    expect(status.contentOverviews).toBeUndefined();
    expect(mocks.projectPluginContentOverview).not.toHaveBeenCalled();

    await dependencies.loadPluginContent?.('team/first', signal);

    expect(mocks.projectPluginContentOverview).toHaveBeenCalledOnce();
    expect(mocks.projectPluginContentOverview).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'team/first',
      plugin: expect.objectContaining({
        manifest: expect.objectContaining({ name: 'first' }),
      }),
    }));
  });
});
