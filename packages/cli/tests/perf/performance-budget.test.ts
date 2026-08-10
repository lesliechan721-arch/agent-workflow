import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import fs from 'fs-extra';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  loadConsoleItemsResult,
  statusCommand,
  type StatusCommandRuntime,
} from '../../src/commands/status.js';
import { initializeLocalMarketplace } from '../../src/utils/local-marketplace.js';
import type { CatalogPackageSource } from '../../src/utils/marketplace.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import {
  inspectOwnedComponents,
  writeOwnedTextFile,
  type OwnedComponent,
} from '../../src/utils/ownership.js';
import {
  clearCurrentCatalogResolutionMemoForTests,
  resolveCurrentCatalog,
} from '../../src/utils/plugin-catalog.js';
import {
  createFixtureCatalogPackageSource,
  createPerfCatalogFixture,
  createUnexpectedRemoteCatalogSource,
  type PerfCatalogFixture,
} from './catalog-fixture.js';
import { createPerfSummary, printPerfSummary } from './perf-metrics.js';

const CACHE_WARMUPS = 5;
const CACHE_SAMPLES = 25;
const CACHE_P95_BUDGET_MS = 150;
const POST_REBUILD_BUDGET_MS = 500;
const LIVE_WARMUPS = 3;
const LIVE_SAMPLES = 15;
const LIVE_P95_BUDGET_MS = 500;
const REMOTE_DEADLINE_BUDGET_MS = 500;

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AW_CATALOG_CHANNEL;
  delete env.AW_CATALOG_VERSION;
  delete env.AW_NPM_REGISTRY_URL;
  delete env.npm_config_registry;
  delete env.NPM_CONFIG_REGISTRY;
  delete env.npm_config_userconfig;
  delete env.NPM_CONFIG_USERCONFIG;
  return {
    ...env,
    HOME: path.join(root, 'home'),
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'claude-home'),
  };
}

async function runSamples(options: {
  warmups: number;
  samples: number;
  beforeEach: () => void;
  operation: () => Promise<void>;
}): Promise<number[]> {
  for (let index = 0; index < options.warmups; index += 1) {
    options.beforeEach();
    await options.operation();
  }
  const durations: number[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    options.beforeEach();
    const startedAt = performance.now();
    await options.operation();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

async function createLiveOwnerRuntime(options: {
  workspace: string;
  pluginNames: readonly string[];
}): Promise<StatusCommandRuntime> {
  const components = new Map<string, OwnedComponent>();
  const ownerRoot = path.join(options.workspace, 'live-owners');
  for (const pluginName of options.pluginNames) {
    const filePath = path.join(ownerRoot, `${pluginName}.txt`);
    const identity = {
      owner: 'agent-workflows' as const,
      plugin: pluginName,
      artifactKey: 'perf-live-owner',
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    await writeOwnedTextFile({
      path: filePath,
      allowedRoot: ownerRoot,
      identity,
      content: `${pluginName}\n`,
    });
    components.set(pluginName, {
      kind: 'owned-text-file',
      path: filePath,
      allowedRoot: ownerRoot,
      identity,
    });
  }
  return {
    discoverTargets: async () => [],
    inspectTarget: async ({ plugin, platform, scope, cwd }) => {
      const component = components.get(plugin.manifest.name)!;
      const inspection = await inspectOwnedComponents({ components: [component] });
      return {
        target: {
          plugin,
          identity: {
            pluginName: plugin.manifest.name,
            pluginVersion: plugin.manifest.version,
            platform,
            scope,
            cwd,
          },
          ownedComponents: [component],
          desiredOwnedComponents: [component],
          requiresNative: false,
          artifacts: [],
          lifecycleSource: plugin,
        },
        inspection,
      };
    },
    nativeCliRunner: async (invocation) => {
      throw new Error(
        `Unexpected native call in live performance fixture: ${invocation.command} ${invocation.args.join(' ')}`,
      );
    },
  };
}

describe('performance budgets', () => {
  let suiteRoot: string;
  let caseRoot: string;
  let fixture: PerfCatalogFixture;
  let env: NodeJS.ProcessEnv;
  let workspace: string;
  let liveRuntime: StatusCommandRuntime;
  let unexpectedRemoteCalls = 0;
  let caseIndex = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-budget-'));
    fixture = await createPerfCatalogFixture(suiteRoot);
  }, 120_000);

  beforeEach(async () => {
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(null);
    unexpectedRemoteCalls = 0;
    caseRoot = path.join(suiteRoot, `case-${caseIndex}`);
    caseIndex += 1;
    workspace = path.join(caseRoot, 'workspace');
    await fs.ensureDir(workspace);
    env = {
      ...isolatedEnv(path.join(caseRoot, 'runtime')),
      AW_CLI_VERSION: fixture.cliVersion,
    };
    liveRuntime = {
      ...(await createLiveOwnerRuntime({ workspace, pluginNames: fixture.pluginNames })),
      env,
    };

    setCatalogPackageSourceForTests(createFixtureCatalogPackageSource(fixture));
    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: fixture.catalogVersion,
    });
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(createUnexpectedRemoteCatalogSource(() => {
      unexpectedRemoteCalls += 1;
    }));
  });

  afterEach(async () => {
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(null);
    await fs.remove(caseRoot);
  });

  afterAll(async () => {
    await fs.remove(suiteRoot);
  });

  it('keeps validated disk catalog cache-first resolution within its P95 budget', async () => {
    const durations = await runSamples({
      warmups: CACHE_WARMUPS,
      samples: CACHE_SAMPLES,
      beforeEach: clearCurrentCatalogResolutionMemoForTests,
      operation: async () => {
        await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' }))
          .resolves.toMatchObject({
            source: 'cache',
            catalogVersion: fixture.catalogVersion,
            cacheState: { state: 'fresh' },
          });
      },
    });
    const summary = createPerfSummary(
      'catalog-cache-first-warm',
      durations,
      CACHE_P95_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(unexpectedRemoteCalls).toBe(0);
    expect(summary.p95Ms).toBeLessThanOrEqual(summary.budgetMs);
  });

  it('keeps the first cache read after an active marketplace rebuild within budget', async () => {
    const cached = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    await initializeLocalMarketplace({ force: true, env, catalogResolution: cached });
    clearCurrentCatalogResolutionMemoForTests();

    const startedAt = performance.now();
    const resolved = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    const summary = createPerfSummary(
      'catalog-cache-first-after-marketplace-rebuild',
      [performance.now() - startedAt],
      POST_REBUILD_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(resolved).toMatchObject({
      source: 'cache',
      catalogVersion: fixture.catalogVersion,
      cacheState: { state: 'fresh' },
    });
    expect(unexpectedRemoteCalls).toBe(0);
    expect(summary.maxMs).toBeLessThanOrEqual(summary.budgetMs);
  });

  it('keeps the live status and console warm chain within its P95 budget', async () => {
    const durations = await runSamples({
      warmups: LIVE_WARMUPS,
      samples: LIVE_SAMPLES,
      beforeEach: clearCurrentCatalogResolutionMemoForTests,
      operation: async () => {
        const catalogResolution = await resolveCurrentCatalog(env, {
          freshnessPolicy: 'cacheFirst',
        });
        const runtime = { ...liveRuntime, catalogResolution };
        const status = await statusCommand([], {
          cwd: workspace,
          platform: 'codex',
          scope: 'user',
          json: true,
        }, runtime);
        const consoleResult = await loadConsoleItemsResult({
          cwd: workspace,
          platform: 'codex',
          scope: 'user',
          includeCatalogOnly: true,
        }, runtime);
        expect(status.payload.schemaVersion).toBe(3);
        expect(status.payload.targets.length).toBeGreaterThan(0);
        expect(
          [...new Set(status.payload.targets.map((target) => target.state))],
          JSON.stringify(status.payload.targets),
        ).toEqual(['present']);
        expect(consoleResult.status.schemaVersion).toBe(3);
        expect(consoleResult.items.length).toBe(status.payload.targets.length);
      },
    });
    const summary = createPerfSummary(
      'live-status-console-warm',
      durations,
      LIVE_P95_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(unexpectedRemoteCalls).toBe(0);
    expect(summary.p95Ms).toBeLessThanOrEqual(summary.budgetMs);
  });

  it('applies one bounded deadline to a pending remote source', async () => {
    const deadlineEnv = { ...env, AW_CATALOG_REMOTE_TIMEOUT_MS: '100' };
    let identityCalls = 0;
    const pendingSource: CatalogPackageSource = {
      resolveIdentityByDistTag: async () => {
        identityCalls += 1;
        return new Promise(() => {});
      },
      resolveIdentityByVersion: async () => {
        throw new Error('Unexpected exact version call.');
      },
      downloadArchive: async () => {
        throw new Error('Unexpected archive call.');
      },
    };
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(pendingSource);

    const startedAt = performance.now();
    const resolved = await resolveCurrentCatalog(deadlineEnv);
    const summary = createPerfSummary(
      'catalog-remote-deadline',
      [performance.now() - startedAt],
      REMOTE_DEADLINE_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(resolved).toMatchObject({
      source: 'cache',
      cacheFallback: { used: true },
      cacheState: { state: 'refreshFailed' },
      remoteFailure: { stage: 'deadline' },
    });
    expect(identityCalls).toBe(1);
    expect(summary.maxMs).toBeLessThanOrEqual(summary.budgetMs);
  });
});
