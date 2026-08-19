import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import fs from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRebuildIntegration } from '../../src/commands/rebuild-integration.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { loadConsoleItemsResult } from '../../src/commands/status.js';
import { statusCommandV4 } from '../../src/commands/status-v4.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { withResolvedMultiSourceCatalog } from '../../src/utils/multi-source-catalog.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createPerfSummary, printPerfSummary } from './perf-metrics.js';

const SAMPLES = 20;
const BUDGET_MS = 500;

async function sample(operation: () => Promise<void>): Promise<number[]> {
  await operation();
  const durations: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

describe('multi-source performance budgets', () => {
  let root: string;
  let sourceRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-multi-source-perf-'));
    sourceRoot = path.join(root, 'catalog');
    await createCatalogSnapshotFixture(sourceRoot);
    env = {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    };
    await fs.outputJson(path.join(env.AW_HOME!, 'catalog-sources.json'), {
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
    });
  });

  afterAll(async () => {
    await fs.remove(root);
  });

  it('keeps warm path source resolution within budget', async () => {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const durations = await sample(async () => {
      await withResolvedMultiSourceCatalog({
        cliVersion: '1.0.0', freshnessPolicy: 'cacheFirst', configSnapshot, env,
        consume: (catalog) => { expect(catalog.sources[0]?.resolution?.source).toBe('path'); },
      });
    });
    const summary = createPerfSummary('path-source-resolution-warm', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps force path validation within budget', async () => {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const durations = await sample(async () => {
      await withResolvedMultiSourceCatalog({
        cliVersion: '1.0.0', freshnessPolicy: 'forceRemote', configSnapshot, env,
        consume: () => undefined,
      });
    });
    const summary = createPerfSummary('path-source-force-validation', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps the first source read after a namespaced marketplace rebuild within budget', async () => {
    const plugin = await readPluginManifest(path.join(sourceRoot, 'plugins', 'demo'), {
      mode: 'bundle',
    });
    const marketplaceRoot = path.join(env.AW_HOME!, 'marketplaces', 'local');
    const marketplaceName = 'aw-local';
    const configPath = path.join(env.AW_CODEX_HOME!, 'config.toml');
    const cacheRoot = path.join(
      env.AW_CODEX_HOME!,
      'plugins',
      'cache',
      marketplaceName,
      plugin.manifest.name,
      plugin.manifest.version,
    );
    let marketplaceAdded = false;
    let pluginAdded = false;
    const writeCodexConfig = async () => fs.outputFile(configPath, [
      ...(marketplaceAdded ? [
        `[marketplaces.${JSON.stringify(marketplaceName)}]`,
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ] : []),
      ...(pluginAdded ? [
        `[plugins.${JSON.stringify(`${plugin.manifest.name}@${marketplaceName}`)}]`,
        'enabled = true',
        '',
      ] : []),
    ].join('\n'));
    const integration = createRebuildIntegration({
      context: createCommandExecutionContext({
        env,
        nativeCliRunner: async (invocation) => {
          if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
            marketplaceAdded = true;
            await writeCodexConfig();
          } else if (invocation.args[1] === 'add') {
            pluginAdded = true;
            await fs.copy(path.join(marketplaceRoot, 'plugins', plugin.manifest.name), cacheRoot);
            await fs.outputJson(path.join(cacheRoot, 'plugin.json'), {
              id: plugin.manifest.name,
              version: plugin.manifest.version,
            });
            await writeCodexConfig();
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      }),
    });
    const target = await integration.buildTarget({
      sourceId: 'local',
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginId: 'local/demo',
      marketplaceName,
      marketplaceRoot,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: root,
      command: 'install',
      catalog: { rootDir: sourceRoot, source: 'local' },
      includeHistoricalLifecycleArtifacts: false,
    });
    await integration.driver.writeNative(target);
    await expect(fs.pathExists(path.join(marketplaceRoot, 'config.json'))).resolves.toBe(true);

    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const startedAt = performance.now();
    await withResolvedMultiSourceCatalog({
      cliVersion: '1.0.0', freshnessPolicy: 'cacheFirst', configSnapshot, env,
      consume: () => undefined,
    });
    const summary = createPerfSummary(
      'path-source-after-marketplace-rebuild',
      [performance.now() - startedAt],
      BUDGET_MS,
    );
    printPerfSummary(summary);
    expect(summary.maxMs).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps warm multi-source status and console loading within budget', async () => {
    const durations = await sample(async () => {
      const result = await statusCommandV4({
        cwd: root, env, cliVersion: '1.0.0', json: true,
      });
      const consoleResult = await loadConsoleItemsResult({ cwd: root }, { env });
      expect(result.payload.catalog.sources[0]?.id).toBe('local');
      expect(consoleResult.items[0]?.pluginName).toBe('local/demo');
    });
    const summary = createPerfSummary('multi-source-status-console-warm', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('keeps source config reads within budget', async () => {
    const durations = await sample(async () => {
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      expect(snapshot.config.sources[0]?.id).toBe('local');
    });
    const summary = createPerfSummary('catalog-source-config-warm', durations, BUDGET_MS);
    printPerfSummary(summary);
    expect(summary.p95Ms).toBeLessThanOrEqual(BUDGET_MS);
  });
});
