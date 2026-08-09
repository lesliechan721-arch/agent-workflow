import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import fs from 'fs-extra';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadConsoleItemsResult } from '../../src/commands/status.js';
import { clearAgentVersionProbeCacheForTests } from '../../src/utils/agent-version.js';
import { initializeLocalMarketplace } from '../../src/utils/local-marketplace.js';
import {
  clearCurrentCatalogResolutionMemoForTests,
  resolveCurrentCatalog,
} from '../../src/utils/plugin-catalog.js';
import type { CatalogPackageSource } from '../../src/utils/marketplace.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import {
  createFixtureCatalogPackageSource,
  createPerfCatalogFixture,
  createUnexpectedRemoteCatalogSource,
  writePerfInstalledEvidence,
  type PerfCatalogFixture,
} from './catalog-fixture.js';
import { createPerfSummary, printPerfSummary } from './perf-metrics.js';

const CATALOG_WARMUP_SAMPLES = 5;
const CATALOG_MEASURED_SAMPLES = 25;
const CATALOG_CACHE_FIRST_P95_BUDGET_MS = 150;
const POST_REBUILD_CACHE_FIRST_BUDGET_MS = 500;
const CONSOLE_WARMUP_SAMPLES = 3;
const CONSOLE_MEASURED_SAMPLES = 15;
const CONSOLE_WARM_LOAD_P95_BUDGET_MS = 500;
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

function createFakeNativeRunner(): NativeCliRunner {
  return async (invocation) => {
    if (invocation.args.length !== 1 || invocation.args[0] !== '--version') {
      throw new Error(
        `Unexpected native call in console performance test: ${invocation.command} ${invocation.args.join(' ')}`,
      );
    }
    if (invocation.command === 'codex') {
      return { exitCode: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
    }
    if (invocation.command === 'claude') {
      return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
    }
    throw new Error(`Unexpected native command in console performance test: ${invocation.command}.`);
  };
}

describe('performance budgets', () => {
  let suiteRoot: string;
  let caseRoot: string;
  let fixture: PerfCatalogFixture;
  let env: NodeJS.ProcessEnv;
  let workspace: string;
  let unexpectedRemoteCalls = 0;
  let caseIndex = 0;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-perf-budget-'));
    fixture = await createPerfCatalogFixture(suiteRoot);
  }, 120_000);

  beforeEach(async () => {
    clearAgentVersionProbeCacheForTests();
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(null);
    unexpectedRemoteCalls = 0;
    caseRoot = path.join(suiteRoot, `case-${caseIndex}`);
    caseIndex += 1;
    const installedEvidence = await writePerfInstalledEvidence({
      rootDir: path.join(caseRoot, 'runtime'),
      pluginNames: fixture.pluginNames,
    });
    env = {
      ...isolatedEnv(path.join(caseRoot, 'runtime')),
      AW_HOME: installedEvidence.awHome,
      AW_CODEX_HOME: installedEvidence.codexHome,
      AW_CLAUDE_HOME: installedEvidence.claudeHome,
      AW_CLI_VERSION: fixture.cliVersion,
    };
    workspace = installedEvidence.workspace;

    setCatalogPackageSourceForTests(createFixtureCatalogPackageSource(fixture));
    const seededCatalog = await resolveCurrentCatalog(env);
    expect(seededCatalog).toMatchObject({
      source: 'remote',
      catalogVersion: fixture.catalogVersion,
    });

    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(createUnexpectedRemoteCatalogSource(() => {
      unexpectedRemoteCalls += 1;
    }));
  });

  afterEach(async () => {
    clearAgentVersionProbeCacheForTests();
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(null);
    if (caseRoot) {
      await fs.remove(caseRoot);
    }
  });

  afterAll(async () => {
    await fs.remove(suiteRoot);
  });

  it('keeps validated disk catalog cache-first resolution within its P95 budget', async () => {
    const durations = await runSamples({
      warmups: CATALOG_WARMUP_SAMPLES,
      samples: CATALOG_MEASURED_SAMPLES,
      beforeEach: clearCurrentCatalogResolutionMemoForTests,
      operation: async () => {
        const resolved = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
        expect(resolved).toMatchObject({
          source: 'cache',
          catalogVersion: fixture.catalogVersion,
          cacheState: { state: 'fresh' },
        });
      },
    });
    const summary = createPerfSummary(
      'catalog-cache-first-warm',
      durations,
      CATALOG_CACHE_FIRST_P95_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(unexpectedRemoteCalls, 'warm cache-first samples must not access the remote source').toBe(0);
    expect(
      summary.p95Ms,
      `catalog-cache-first-warm P95 ${summary.p95Ms}ms exceeded ${summary.budgetMs}ms`,
    ).toBeLessThanOrEqual(summary.budgetMs);
  });

  it('keeps the first cache-first read after a marketplace rebuild within its independent budget', async () => {
    const cachedCatalog = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    expect(cachedCatalog.source).toBe('cache');
    await initializeLocalMarketplace({
      force: true,
      env,
      catalogResolution: cachedCatalog,
    });

    clearCurrentCatalogResolutionMemoForTests();
    const startedAt = performance.now();
    const resolved = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    const elapsedMs = performance.now() - startedAt;
    const summary = createPerfSummary(
      'catalog-cache-first-after-marketplace-rebuild',
      [elapsedMs],
      POST_REBUILD_CACHE_FIRST_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(resolved).toMatchObject({
      source: 'cache',
      catalogVersion: fixture.catalogVersion,
      cacheState: { state: 'fresh' },
    });
    expect(unexpectedRemoteCalls, 'post-rebuild cache-first read must not access the remote source').toBe(0);
    expect(
      summary.maxMs,
      `catalog-cache-first-after-marketplace-rebuild ${summary.maxMs}ms exceeded ${summary.budgetMs}ms`,
    ).toBeLessThanOrEqual(summary.budgetMs);
  });

  it('keeps the real warm console/status load chain within its P95 budget', async () => {
    const nativeCliRunner = createFakeNativeRunner();
    const expectedPluginNames = [...fixture.pluginNames].sort();

    const durations = await runSamples({
      warmups: CONSOLE_WARMUP_SAMPLES,
      samples: CONSOLE_MEASURED_SAMPLES,
      beforeEach: () => {
        clearAgentVersionProbeCacheForTests();
        clearCurrentCatalogResolutionMemoForTests();
      },
      operation: async () => {
        const result = await loadConsoleItemsResult({
          cwd: workspace,
          includeCatalogOnly: true,
        }, {
          env,
          nativeCliRunner,
        });
        const actualPluginNames = result.items
          .map((item) => item.summary.pluginName)
          .sort();
        expect(result.catalog.source).toBe('cache');
        expect(result.catalog.catalogVersion).toBe(fixture.catalogVersion);
        expect(result.catalog.cacheState?.state).toBe('fresh');
        expect(result.catalogUnavailable).toBe(false);
        expect(actualPluginNames).toEqual(expectedPluginNames);
        expect(result.items.every((item) => item.summary.status !== 'notInstalled')).toBe(true);
      },
    });
    const summary = createPerfSummary(
      'console-warm-load',
      durations,
      CONSOLE_WARM_LOAD_P95_BUDGET_MS,
    );
    printPerfSummary(summary);

    expect(unexpectedRemoteCalls, 'console warm samples must use the disk cache-first path').toBe(0);
    expect(
      summary.p95Ms,
      `console-warm-load P95 ${summary.p95Ms}ms exceeded ${summary.budgetMs}ms`,
    ).toBeLessThanOrEqual(summary.budgetMs);
  });

  it('applies one bounded deadline to a pending remote source', async () => {
    const deadlineEnv = {
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    };
    let identityCalls = 0;
    const pendingSource: CatalogPackageSource = {
      resolveIdentityByDistTag: async () => {
        identityCalls += 1;
        return await new Promise(() => {});
      },
      resolveIdentityByVersion: async () => {
        throw new Error('Unexpected version identity call in deadline performance test.');
      },
      downloadArchive: async () => {
        throw new Error('Unexpected download call in deadline performance test.');
      },
    };
    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(pendingSource);

    const startedAt = performance.now();
    const resolved = await resolveCurrentCatalog(deadlineEnv);
    const elapsedMs = performance.now() - startedAt;
    const summary = createPerfSummary(
      'catalog-remote-deadline',
      [elapsedMs],
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
    expect(
      summary.maxMs,
      `catalog-remote-deadline ${summary.maxMs}ms exceeded ${summary.budgetMs}ms`,
    ).toBeLessThanOrEqual(summary.budgetMs);
  });
});
