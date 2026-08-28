import { describe, expect, it, vi } from 'vitest';

import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../../src/commands/write-commands.js';
import {
  runRebuildCommand,
  setRebuildCommandTestHooksForTests,
} from '../../src/commands/rebuild-command.js';
import {
  setStatusDependencyInspectionHookForTests,
  statusCommandV5,
} from '../../src/commands/status-v5.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  createTuiControllerDependencies,
  setTuiControllerRuntimeTestHooksForTests,
} from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { userIssueKey } from '../../src/tui/controller.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
  git,
} from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { CatalogSource, PluginMeta } from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  prepareLifecycleActiveSnapshot,
  promoteLifecycleActiveSnapshot,
  resolveLifecycleActiveTarget,
} from '../../src/utils/lifecycle-active-store.js';
import {
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import {
  activateCatalogSourceCandidate,
  refreshCatalogSourceGeneration,
} from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';

async function configureCatalog(): Promise<ReturnType<typeof getCurrentSourceTestIsolation>> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'write-source');
  await createCatalogSnapshotFixture(root);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: root }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  return isolation;
}

async function configureCodexAliasCatalog(options: {
  cwd: string;
  userConfig: string;
  sourceName: string;
}) {
  const isolation = getCurrentSourceTestIsolation();
  const env = { ...isolation.env, AW_CODEX_HOME: options.userConfig };
  const sourceRoot = path.join(isolation.layout.fixtureCwd, options.sourceName);
  await fs.ensureDir(options.cwd);
  await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
    manifest.marketplace.policy.products = ['CODEX'];
    manifest.extensions = {
      instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.' }],
    };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 1,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
    },
    expectedDigest: snapshot.digest,
    env,
  });
  return {
    env,
    nativeCliRunner: vi.fn(async (_invocation: NativeCliInvocation) => ({
      exitCode: 0,
      stdout: 'codex-cli 99.0.0',
      stderr: '',
    })),
  };
}

async function writeDynamicSkillRenderer(options: {
  pluginRoot: string;
  skillKey: string;
  fail?: boolean;
}): Promise<void> {
  await fs.outputFile(path.join(options.pluginRoot, 'scripts', 'render.mjs'), [
    'import { readFile, writeFile } from "node:fs/promises";',
    'const counter = `${process.env.AW_HOME}/render-count-${process.env.AW_PLUGIN_NAME}.txt`;',
    'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
    'await writeFile(counter, String(previous + 1));',
    ...(options.fail ? ['throw new Error("renderer failed");'] : []),
    'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'console.log(JSON.stringify({ version: 2, artifacts: [{',
    '  id: "dynamic-skill", kind: "skill", platform: context.platform,',
    '  target: "codex.skill", state: "present", refreshKeys: [],',
    `  skillKey: ${JSON.stringify(options.skillKey)}, content: { files: {`,
    `    "SKILL.md": ${JSON.stringify(`---\nname: ${options.skillKey}\ndescription: Dynamic skill.\n---\n`)},`,
    '    "README.md": "Dynamic skill.\\n",',
    '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
    '  } }',
    '}] }));',
  ].join('\n'));
}

describe('five namespaced write commands', () => {
  it('keeps warm write, config, status, and TUI operations provider-free', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'warm-active-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'warm\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'warm', title: 'Warm', content: 'Warm.' }],
      };
      manifest.config = { schema: { mode: { type: 'string', title: 'Mode' } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    let providerCalls = 0;
    const catalogGenerationRuntime = {
      providers: {
        path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
          providerCalls += 1;
          return catalogPathProviderInternal.resolve(...args);
        },
        git: async () => {
          providerCalls += 1;
          throw new Error('warm Active must not invoke the Git provider');
        },
      },
    };
    const nativeCliRunner = async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    });
    const writeRuntime = {
      env: isolation.env,
      nativeCliRunner,
      catalogGenerationRuntime,
    };

    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(upgradeWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(statusCommandV5({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      catalogGenerationRuntime,
    })).resolves.toMatchObject({ hasErrors: false });

    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    });
    const controller = new TuiController(createTuiControllerDependencies(
      context,
      undefined,
      { catalogGenerationRuntime },
    ));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'project',
      projectLayer: 'shared',
      updates: { mode: 'strict' },
    });
    expect(review.technicalDetails).toContainEqual(
      expect.stringMatching(/^Catalog generation：[0-9a-f]{8}$/u),
    );
    const pinnedGeneration = review.technicalDetails!.find((detail) =>
      detail.startsWith('Catalog generation：'))!;
    await expect(controller.executeOperation(review.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'changed\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'warm', title: 'Warm', content: 'Changed.' }],
      };
      manifest.config = { schema: { mode: { type: 'string', title: 'Mode' } } };
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const staleReview = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'project',
      projectLayer: 'shared',
      updates: { mode: 'new' },
    });
    expect(staleReview.technicalDetails).toContain(pinnedGeneration);
    await expect(controller.executeOperation(staleReview.reviewToken))
      .resolves.toMatchObject({ state: 'stale' });
    controller.dispose();
    expect(providerCalls).toBe(0);
  });

  it('pins successful TUI source generations when another source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-session-good');
    const writeGoodSource = (version: string, field: string, content: string) =>
      createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', `${content}\n`, (manifest) => {
        manifest.version = version;
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'session', title: 'Session', content }],
        };
        manifest.config = {
          schema: {
            oldMode: { type: 'string', title: 'oldMode' },
            ...(field === 'oldMode' ? {} : { [field]: { type: 'string', title: field } }),
          },
        };
      });
    await writeGoodSource('1.0.0', 'oldMode', 'old generation');
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'good', type: 'path', primary: true, path: sourceRoot },
          {
            id: 'missing', type: 'git', primary: false,
            url: 'https://example.invalid/missing-session.git',
            refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
          },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await refreshCatalogSourceGeneration({
      sourceId: 'good', cliVersion: '1.0.0', env: isolation.env,
    });
    let goodProviderCalls = 0;
    let missingProviderCalls = 0;
    const catalogGenerationRuntime = {
      providers: {
        path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
          goodProviderCalls += 1;
          return catalogPathProviderInternal.resolve(...args);
        },
        git: async () => {
          missingProviderCalls += 1;
          throw new Error('missing source is offline');
        },
      },
    };
    const controller = new TuiController(createTuiControllerDependencies(
      createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        interactive: false,
      }),
      undefined,
      { catalogGenerationRuntime },
    ));
    await controller.load();
    expect(controller.getPluginOverview('good/demo')).toMatchObject({ version: '1.0.0' });
    await vi.waitFor(() => {
      expect(controller.snapshot.sourceHealth).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: 'good', state: 'path' }),
        expect.objectContaining({ sourceId: 'missing', state: 'unavailable' }),
      ]));
    });
    expect(goodProviderCalls).toBe(0);
    expect(missingProviderCalls).toBeGreaterThanOrEqual(1);

    await writeGoodSource('2.0.0', 'newMode', 'new generation');
    await refreshCatalogSourceGeneration({
      sourceId: 'good', cliVersion: '1.0.0', env: isolation.env,
    });
    expect(controller.getPluginOverview('good/demo')).toMatchObject({ version: '1.0.0' });
    const page = await controller.getConfigPage(
      'good/demo',
      { scope: 'project', projectLayer: 'shared' },
    );
    expect(page.groups.flatMap((group) => group.fields.map((field) => field.key)))
      .toContain('oldMode');
    expect(page.groups.flatMap((group) => group.fields.map((field) => field.key)))
      .not.toContain('newMode');
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'good/demo',
      scope: 'project',
      projectLayer: 'shared',
      updates: { oldMode: 'strict' },
    });
    const executeResult = await controller.executeOperation(review.reviewToken);
    expect(executeResult, JSON.stringify(executeResult)).toMatchObject({ state: 'stale' });
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'good', type: 'path', primary: true, path: sourceRoot,
    });
    await expect(readPluginConfigStore({
      sourceId: 'good',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'project',
      projectLayer: 'shared',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: false });
    await expect(controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'missing/demo',
      platform: 'codex',
      scope: 'project',
    })).rejects.toMatchObject({
      code: 'catalogGenerationUnavailable',
      message: expect.stringContaining('重新加载'),
    });
    expect(goodProviderCalls).toBe(0);
    await vi.waitFor(() => {
      expect(missingProviderCalls).toBe(2);
    });
    controller.dispose();
  });

  it('keeps a Codex user install healthy when the project config aliases the user home', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'codex-scope-alias-home');
    const { env, nativeCliRunner } = await configureCodexAliasCatalog({
      cwd,
      userConfig: path.join(cwd, '.codex'),
      sourceName: 'codex-scope-alias-source',
    });

    const installed = await installWriteCommand(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'user',
    }, { env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const status = await statusCommandV5({
      plugins: ['team/demo'],
      cwd,
      env,
      cliVersion: '1.0.0',
      platform: 'codex',
      json: true,
      verbose: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', scope: 'user', state: 'present' }),
    ]);
    await expect(statusCommandV5({
      plugins: ['team/demo'],
      cwd,
      env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    })).resolves.toMatchObject({
      payload: {
        targets: [expect.objectContaining({
          scope: 'project',
          state: 'error',
          errors: [expect.objectContaining({ code: 'codexScopePathAlias' })],
        })],
      },
    });

    const reinstalled = await reinstallWriteCommand(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'user',
    }, { env, nativeCliRunner });
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');
  });

  it.each(['direct', 'symlink'] as const)(
    'blocks Codex project writes when its config has a %s alias to the user home',
    async (alias) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = path.join(isolation.layout.fixtureCwd, `codex-project-${alias}-alias`);
      const projectConfig = path.join(cwd, '.codex');
      await fs.ensureDir(projectConfig);
      const userConfig = alias === 'direct'
        ? projectConfig
        : path.join(isolation.layout.fixtureCwd, 'codex-user-home-link');
      if (alias === 'symlink') await fs.symlink(projectConfig, userConfig);
      const { env, nativeCliRunner } = await configureCodexAliasCatalog({
        cwd,
        userConfig,
        sourceName: `codex-project-${alias}-source`,
      });

      const result = await installWriteCommand(['team/demo'], {
        cwd,
        platform: 'codex',
        scope: 'project',
      }, { env, nativeCliRunner });

      expect(result.overallState).toBe('failed');
      expect(result.targetResults).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/demo', scope: 'project' }),
          errorCode: 'codexScopePathAlias',
        }),
      ]);
      expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args.join(' ')).join('\n'))
        .not.toMatch(/(?:marketplace|plugin) add/u);
    },
  );

  it('keeps cleanup available for a project owner after Codex config paths become aliases', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'codex-project-alias-cleanup');
    const { env: initialEnv, nativeCliRunner } = await configureCodexAliasCatalog({
      cwd,
      userConfig: path.join(isolation.layout.fixtureCwd, 'separate-codex-user-home'),
      sourceName: 'codex-project-alias-cleanup-source',
    });
    const installed = await installWriteCommand(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'project',
    }, { env: initialEnv, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const aliasEnv = { ...initialEnv, AW_CODEX_HOME: path.join(cwd, '.codex') };
    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'project',
    }, { env: aliasEnv, nativeCliRunner });

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(cleaned.receiptTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', scope: 'project' }),
    ]);
  });

  it('rejects a symlinked marketplace parent before first install writes external or native state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'symlinked-marketplace-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const victim = path.join(isolation.layout.rootDir, 'external-marketplace-victim');
    await fs.outputFile(path.join(victim, 'sentinel.txt'), 'unchanged\n');
    const marketplaces = path.join(isolation.env.AW_HOME!, 'marketplaces');
    await fs.symlink(victim, marketplaces);
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));

    const result = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('failed');
    expect(result.rebuildResults[0]?.failures[0]?.phase).toBe('preflight');
    await expect(fs.readFile(path.join(victim, 'sentinel.txt'), 'utf8')).resolves.toBe('unchanged\n');
    await expect(fs.readdir(victim)).resolves.toEqual(['sentinel.txt']);
    expect((await fs.lstat(marketplaces)).isSymbolicLink()).toBe(true);
    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args.join(' ')).join('\n'))
      .not.toMatch(/(?:marketplace|plugin) add/u);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex'))).resolves.toBe(false);
  });

  it('installs a dependency closure in dependency-first order and keeps present dependencies', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual([
      'team/leaf',
      'team/middle',
      'team/root',
    ]);
    expect(result.rebuildResults.map((entry) => entry.target.pluginName)).toEqual([
      'leaf',
      'middle',
      'root',
    ]);
    const repeated = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });
    expect(repeated.overallState, JSON.stringify(repeated.rebuildResults)).toBe('succeeded');
    expect(repeated.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/middle', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/root', relation: 'requested' }),
    ]));
  });

  it('reuses ordinary inventory across write discovery and keeps historical consumer scans separate', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'inventory-reuse-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'inventory-reuse-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const inventoryReads: Array<boolean> = [];
    const readInventory: typeof inventoryCatalogSourceReferences = async (options) => {
      inventoryReads.push(options.includeHistoricalProjects === true);
      return inventoryCatalogSourceReferences(options);
    };
    const runtime = {
      env: isolation.env,
      inventoryCatalogSourceReferences: readInventory,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };

    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.resolvedPluginIds).toEqual(['team/leaf', 'team/root']);
    expect(inventoryReads).toEqual([false]);

    inventoryReads.length = 0;
    const cleaned = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(inventoryReads).toEqual([false, true]);

    const reinstalled = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');
    inventoryReads.length = 0;
    const upgraded = await upgradeWriteCommand([], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', all: true,
    }, runtime);
    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(inventoryReads).toEqual([false]);

    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    inventoryReads.length = 0;
    const offline = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(offline.overallState, JSON.stringify(offline.rebuildResults)).toBe('succeeded');
    expect(inventoryReads).toEqual([false, true]);
  });

  it('keeps a present user dependency when installing its project consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-dependency-keep-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        lifecycle: { install: { default: { runner: 'node', path: './scripts/install.mjs' } } },
      };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.marketplace.policy.products = ['CODEX'];
      } },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'leaf', 'scripts', 'install.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/lifecycle-count-leaf.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const leafInstall = await installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(leafInstall.overallState, JSON.stringify(leafInstall.rebuildResults)).toBe('succeeded');
    const leafStatus = await statusCommandV5({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    const leafUserTarget = leafStatus.payload.targets[0];
    expect(leafUserTarget?.state, JSON.stringify(leafUserTarget)).toBe('present');

    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(installed.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user', action: 'keep' }),
    ]));
    expect(installed.rebuildResults.find((result) => result.target.pluginId === 'team/leaf')?.actions)
      .toEqual([]);
    expect(installed.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
        action: 'keep', state: 'completed',
      }),
    ]));
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'lifecycle-count-leaf.txt'), 'utf8'))
      .resolves.toBe('1');
  });

  it('reapplies a root config change through the normal dependency closure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-config-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest) => {
          manifest.config = {
            schema: { mode: { type: 'enum', values: ['safe', 'fast'], default: 'safe' } },
          };
        },
      },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));
    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const captured = createCapturedCliIo();
    const exitCode = await runCli([
      'config', 'set', 'team/root', 'mode', 'fast', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    });
    const receipt = JSON.parse(captured.readStdout()) as Record<string, unknown>;

    expect(exitCode).toBe(0);
    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/leaf' }),
          action: 'reinstall',
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/root' }),
          action: 'reinstall',
          state: 'completed',
        }),
      ],
    });
  });

  it('keeps a dual-platform dependency on the platform required by a Codex-only root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'platform-closure-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest) => {
          manifest.marketplace.policy.products = ['CODEX'];
        },
      },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.receiptTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/leaf', platform: 'codex' }),
      expect.objectContaining({ pluginId: 'team/root', platform: 'codex' }),
    ]);
    expect(result.dependencyPlan?.targets.find((target) => target.pluginId === 'team/leaf'))
      .toMatchObject({ platform: 'codex', requiredBy: ['team/root'] });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.claude'))).resolves.toBe(false);
  });

  it('reuses one successful renderer result per target during execution', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'prepared-renderer-source');
    const configure = (skillKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', states: ['present'], refreshKeys: [], skillKey,
        }],
      };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configure('leaf-skill') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-skill') },
    ]);
    await Promise.all([
      writeDynamicSkillRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), skillKey: 'leaf-skill' }),
      writeDynamicSkillRenderer({ pluginRoot: path.join(sourceRoot, 'plugins', 'root'), skillKey: 'root-skill' }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configure('leaf-skill') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-skill') },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'render-count-leaf.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'render-count-root.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(upgradeWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    })).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    })).resolves.toMatchObject({ overallState: 'succeeded' });
    for (const pluginName of ['leaf', 'root']) {
      await expect(fs.readFile(path.join(isolation.env.AW_HOME!, `render-count-${pluginName}.txt`), 'utf8'))
        .resolves.toBe('3');
    }
  });

  it('detects collisions from real renderer output before the first platform write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', states: ['present', 'disabled'], refreshKeys: [],
          skillKey: 'shared-skill',
        }],
      };
    };
    const plugins = [
      { name: 'first', configureManifest: configure },
      { name: 'second', configureManifest: configure },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all(plugins.map((plugin) => writeDynamicSkillRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', plugin.name),
      skillKey: 'shared-skill',
    })));
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(
      isolation.layout.fixtureCwd, '.agents', 'skills', 'shared-skill',
    ))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
    for (const plugin of plugins) {
      await expect(fs.readFile(path.join(isolation.env.AW_HOME!, `render-count-${plugin.name}.txt`), 'utf8'))
        .resolves.toBe('1');
    }
  });

  it('fails a dependency renderer and skips its consumer without platform writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'renderer-failure-source');
    const configure = (skillKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', states: ['present'], refreshKeys: [], skillKey,
        }],
      };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configure('leaf-skill') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-skill') },
      { name: 'independent', configureManifest: configure('independent-skill') },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all([
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), skillKey: 'leaf-skill', fail: true,
      }),
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'root'), skillKey: 'root-skill',
      }),
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'independent'), skillKey: 'independent-skill',
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['team/root', 'team/independent'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'skipped',
        errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        state: 'completed',
      }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'root-skill')))
      .resolves.toBe(false);
  });

  it('allows cleanup and uninstall when required plugin config is invalid', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-removal-config-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.config = { schema: { mode: { type: 'string', required: true } } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'cleanup-target', configureManifest: configure },
      { name: 'uninstall-target', configureManifest: configure },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    for (const pluginName of ['cleanup-target', 'uninstall-target']) {
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'valid' },
      });
    }
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['team/cleanup-target', 'team/uninstall-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    for (const pluginName of ['cleanup-target', 'uninstall-target']) {
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: {},
      });
    }

    const cleaned = await cleanupWriteCommand(['team/cleanup-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const uninstalled = await uninstallWriteCommand(['team/uninstall-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    for (const pluginName of ['cleanup-target', 'uninstall-target']) {
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ exists: true, values: {} });
    }
  });

  it('adds a missing dependency when upgrade --all starts from live requested roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'upgrade-all-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root' },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const projectInstall = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(projectInstall.overallState, JSON.stringify(projectInstall.rebuildResults)).toBe('succeeded');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await refreshCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const upgraded = await upgradeWriteCommand([], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', all: true,
    }, runtime);

    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(upgraded.dependencyPlan?.requestedPluginIds).toEqual(['team/root']);
    expect(upgraded.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['leaf', 'root']);
    expect(upgraded.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', relation: 'dependency', action: 'upgrade' }),
    ]));
  });

  it('executes dependency installation through the reviewed TUI backend', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite', action: 'install', pluginId: 'team/root', platform: 'codex', scope: 'project',
    } as const;
    const evidence = await dependencies.captureEvidence(intent);
    const result = await dependencies.executeIntent(intent, evidence) as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['leaf', 'root']);
    expect(result.dependencyPlan?.dependencyEdges).toEqual([{ from: 'team/root', to: 'team/leaf' }]);
  });

  it('executes force cleanup through the reviewed TUI runtime', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-force-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    });
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, context)).resolves.toMatchObject({ overallState: 'succeeded' });
    const dependencies = createTuiControllerDependencies(context);
    const intent = {
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team/leaf',
      platform: 'codex', scope: 'project', force: true,
    } as const;
    const evidence = await dependencies.captureEvidence(intent);

    const result = await dependencies.executeIntent(intent, evidence) as Awaited<ReturnType<typeof cleanupWriteCommand>>;

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(statusCommandV5({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'partial' })] },
    });
  });

  it.each(['path', 'git'] as const)(
    'blocks a reviewed %s source update at locked evidence capture without writes',
    async (provider) => {
      const isolation = getCurrentSourceTestIsolation();
      const workRoot = path.join(isolation.layout.fixtureCwd, `tui-${provider}-review-work`);
      const sourceRoot = provider === 'git' ? path.join(workRoot, 'catalog') : workRoot;
      await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'review A\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
      });
      let source: CatalogSource;
      if (provider === 'git') {
        const remote = path.join(isolation.layout.fixtureCwd, 'tui-review-remote.git');
        await git(workRoot, ['init', '--initial-branch=main']);
        await git(workRoot, ['config', 'user.email', 'test@example.test']);
        await git(workRoot, ['config', 'user.name', 'AW Test']);
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review A']);
        await git(isolation.layout.fixtureCwd, ['clone', '--bare', workRoot, remote]);
        source = {
          id: 'team', type: 'git', primary: true, url: remote, subdir: 'catalog',
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        };
      } else {
        source = { id: 'team', type: 'path', primary: true, path: sourceRoot };
      }
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 1, sources: [source] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const dependencies = createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        interactive: false,
      }));
      const intent = {
        kind: 'pluginWrite', action: 'install', pluginId: 'team/demo', platform: 'codex', scope: 'project',
      } as const;
      const evidence = await dependencies.captureEvidence(intent);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'review B\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
      });
      if (provider === 'git') {
        const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
        const manifest = await fs.readJson(manifestPath);
        manifest.catalogVersion = '2.0.0';
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review B']);
        await git(workRoot, ['push', source.url, 'HEAD:refs/heads/main']);
      }
      await refreshCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      if (provider === 'git') {
        await activateCatalogSourceCandidate({ sourceId: 'team', env: isolation.env });
      }
      const dispatched = vi.fn();
      setTuiControllerRuntimeTestHooksForTests({ afterMutationEvidenceCapture: async () => dispatched() });
      try {
        await expect(dependencies.executeIntent(intent, evidence)).rejects.toMatchObject({
          code: 'operationReviewStale',
        });
      } finally {
        setTuiControllerRuntimeTestHooksForTests(undefined);
      }
      expect(dispatched).not.toHaveBeenCalled();
      await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
        .resolves.toBe(false);
    },
  );

  it('returns a new Review before plugin or config writes when actual source evidence advances', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-actual-source-review');
    const writeSource = async (content: string): Promise<void> => createCatalogSnapshotFixture(
      sourceRoot,
      'demo',
      '0.0.0',
      `${content}\n`,
      (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'review', title: 'Review', content }],
        };
        manifest.config = { schema: { mode: { type: 'string', title: 'Mode' } } };
      },
    );
    await writeSource('review B');
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    });
    const executeWithSourceAdvance = async (
      intent: Parameters<TuiController['buildOperationReview']>[0],
    ) => {
      await writeSource('review B');
      await refreshCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const controller = new TuiController(createTuiControllerDependencies(context));
      await controller.load();
      const review = await controller.buildOperationReview(intent);
      await writeSource('actual C');
      await refreshCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      try {
        return await controller.executeOperation(review.reviewToken);
      } finally {
        controller.dispose();
      }
    };

    const pluginResult = await executeWithSourceAdvance({
      kind: 'pluginWrite', action: 'install', pluginId: 'team/demo', platform: 'codex', scope: 'project',
    });
    expect(pluginResult).toMatchObject({ state: 'stale', review: { title: '添加插件' } });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);

    const saveResult = await executeWithSourceAdvance({
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared',
      updates: { mode: 'strict' },
    });
    expect(saveResult).toMatchObject({ state: 'stale', review: { title: '保存插件设置' } });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'project', projectLayer: 'shared',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: false });

    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'project', projectLayer: 'shared',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'preserved' },
    });
    const resetResult = await executeWithSourceAdvance({
      kind: 'configReset', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared',
    });
    expect(resetResult).toMatchObject({ state: 'stale', review: { title: '重置插件设置' } });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'project', projectLayer: 'shared',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'preserved' } });
  });

  it('blocks removal of a dependency with a known live consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'dependencyStillRequired' })],
    });

    const removedRoot = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(removedRoot.overallState, JSON.stringify(removedRoot.rebuildResults)).toBe('succeeded');
  });

  it('force-cleans a required dependency and reinstall restores the consumer closure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime);
    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');

    const partial = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(partial.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      state: 'partial',
      dependency: { issueCount: 1 },
    });

    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    const healthy = await statusCommandV5({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(healthy.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      state: 'present',
      dependency: { issueCount: 0 },
    });
  });

  it('executes a complete batch uninstall in consumer-first reverse topology', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await uninstallWriteCommand(['team/leaf', 'team/root', 'team/middle'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    expect(removed.rebuildResults.map((entry) => entry.target.pluginName)).toEqual([
      'root', 'middle', 'leaf',
    ]);
  });

  it('allows removal when a catalog consumer is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-replacement');
    await createDependencyCatalogSnapshotFixture(replacementRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { path: replacementRoot }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true });
  });

  it.each(['partial', 'error'] as const)(
    'fails closed when a dependency consumer inspection is %s',
    async (consumerState) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `consumer-${consumerState}-source`);
      const agent = (name: string) => ({
        name,
        configureManifest: (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
          manifest.extensions = {
            agents: [
              { name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` },
              ...(name === 'root' ? [{
                name: `${name}-extra`, description: `${name} extra.`, prompt: `${name} extra.`,
              }] : []),
            ],
          };
        },
      });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        agent('leaf'),
        { ...agent('root'), dependencies: ['leaf'] },
      ]);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installWriteCommand(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const rootAgent = path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        'aw-root-root-role.toml',
      );
      await fs.remove(rootAgent);
      if (consumerState === 'error') await fs.ensureDir(rootAgent);

      const blocked = await cleanupWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);

      expect(blocked.targetResults).toEqual([
        expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
      ]);
    },
  );

  it('keeps a dependency while multiple live consumers reference it', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'multiple-consumer-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);
  });

  it('uses current manifest edges for live consumer removal protection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'missing-consumer-contract-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);

    const batch = await uninstallWriteCommand(['team/leaf', 'team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(batch.overallState, JSON.stringify(batch.rebuildResults)).toBe('succeeded');
    expect(batch.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['root', 'leaf']);
  });

  it('uses the historical project key when a live project consumer contract is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'dependency-project-b');
    const sourceRoot = path.join(projectA, 'historical-consumer-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const marketplaceRoots = new Map<string, string>();
    const runtime = { env: isolation.env, nativeCliRunner: async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const scopeIndex = invocation.args.indexOf('--scope');
        const scope = scopeIndex === -1 ? 'user' : invocation.args[scopeIndex + 1]!;
        const projectPath = await fs.realpath(invocation.cwd ?? projectA);
        const settingsPath = scope === 'project'
          ? path.join(projectPath, '.claude', 'settings.json')
          : path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
        const pluginsDir = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins');
        const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
        const installedPath = path.join(pluginsDir, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            extraKnownMarketplaces: {
              ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
              [config.marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
            },
          });
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(knownPath, {
            ...known,
            [config.marketplaceName]: {
              source: { source: 'directory', path: marketplaceRoot },
              installLocation: marketplaceRoot,
            },
          });
        }
        if (invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            enabledPlugins: {
              ...((settings.enabledPlugins ?? {}) as Record<string, unknown>),
              [pluginId]: true,
            },
          });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginName];
          await fs.outputJson(installedPath, { plugins: {
            ...plugins,
            [pluginId]: [{
              name: pluginName, scope,
              ...(scope === 'project' ? { projectPath } : {}), version: '1.0.0',
            }],
          } });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
      }
      return { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' };
    } };
    const userLeaf = await installWriteCommand(['team/leaf'], {
      cwd: projectA, platform: 'claude', scope: 'user',
    }, runtime);
    expect(userLeaf.overallState, JSON.stringify(userLeaf.rebuildResults)).toBe('succeeded');
    const projectRoot = await installWriteCommand(['team/root'], {
      cwd: projectA, platform: 'claude', scope: 'project',
    }, runtime);
    expect(projectRoot.overallState, JSON.stringify(projectRoot.rebuildResults)).toBe('succeeded');

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'claude', scope: 'user',
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);
  });

  it('cleans live ownership after source config deletion while uninstall remains catalog dependent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-removal-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'remaining-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    }));
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    nativeCliRunner.mockClear();

    const missing = await statusCommandV5({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missing.payload.targets).toEqual([
      expect.objectContaining({ errors: [expect.objectContaining({ code: 'sourceMissing' })] }),
    ]);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.load();
    const issue = controller.listUserIssues().find((entry) => entry.category === 'sourceMissing'
      && entry.pluginId === 'team/demo' && entry.platform === 'codex' && entry.scope === 'project');
    expect(issue?.actions.map((action) => action.id)).toEqual(['cleanup', 'reAddSource', 'viewTechnical']);
    const cleanupIntent = {
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team/demo', platform: 'codex', scope: 'project',
      originIssue: {
        issueId: issue!.issueId,
        issueKey: userIssueKey(issue!),
        category: 'sourceMissing',
        actionId: 'cleanup',
      },
    } as const;
    const review = await controller.buildOperationReview(cleanupIntent);
    expect(review.technicalDetails).toEqual(expect.arrayContaining(['离线清理原因：sourceMissing']));
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(controller.listUserIssues().some((entry) => entry.category === 'sourceMissing'
      && entry.pluginId === 'team/demo')).toBe(false);
    controller.dispose();
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toBe(before);
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ values: { retained: true } });

    const uninstall = await uninstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(uninstall.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'catalogSourceUnavailable' }),
    ]);
  }, 30_000);

  it('returns a new Review when offline cleanup ownership evidence drifts under the mutation lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner, interactive: false,
    })));
    await controller.load();
    const issue = controller.listUserIssues().find((entry) => entry.category === 'sourceMissing'
      && entry.pluginId === 'team/demo' && entry.platform === 'codex' && entry.scope === 'project')!;
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team/demo', platform: 'codex', scope: 'project',
      originIssue: {
        issueId: issue.issueId, issueKey: userIssueKey(issue), category: 'sourceMissing', actionId: 'cleanup',
      },
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const driftRoot = path.join(skillsRoot, 'drift-owner');
    setTuiControllerRuntimeTestHooksForTests({
      afterMutationEvidenceCapture: async () => {
        await fs.ensureDir(driftRoot);
        await writeSkillOwnerMarker({
          skillRoot: driftRoot,
          allowedRoot: skillsRoot,
          identity: {
            owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
            pluginId: 'team/demo', plugin: 'demo', artifactKey: 'drift-owner',
            platform: 'codex', scope: 'project',
          },
        });
      },
    });
    try {
      await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
        state: 'stale', review: { pluginAction: 'cleanup' },
      });
    } finally {
      setTuiControllerRuntimeTestHooksForTests(undefined);
      controller.dispose();
    }
    await expect(fs.pathExists(driftRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('aw-owner-v2:');
  }, 30_000);

  it('cleans only the source identity bound by the offline Review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-identity-remaining');
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { identity: `sha256:${'1'.repeat(64)}`, root: path.join(skillsRoot, 'identity-one') },
      { identity: `sha256:${'2'.repeat(64)}`, root: path.join(skillsRoot, 'identity-two') },
    ];
    for (const entry of identities) {
      await fs.ensureDir(entry.root);
      await writeSkillOwnerMarker({
        skillRoot: entry.root,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows', sourceId: 'removed', sourceIdentity: entry.identity,
          pluginId: 'removed/demo', plugin: 'demo', artifactKey: path.basename(entry.root),
          platform: 'codex', scope: 'project',
        },
      });
    }
    const baseDependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    let executionResult: unknown;
    const dependencies = {
      ...baseDependencies,
      executeIntent: async (...args: Parameters<typeof baseDependencies.executeIntent>) => {
        executionResult = await baseDependencies.executeIntent(...args);
        return executionResult;
      },
    };
    const controller = new TuiController(dependencies);
    await controller.load();
    const issue = controller.listUserIssues().find((entry) => entry.category === 'sourceMissing'
      && entry.pluginId === 'removed/demo' && entry.platform === 'codex' && entry.scope === 'project')!;
    const reviewed = identities.find((entry) => entry.identity === issue.sourceIdentity)!;
    const retained = identities.find((entry) => entry.identity !== issue.sourceIdentity)!;
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'removed/demo', platform: 'codex', scope: 'project',
      originIssue: {
        issueId: issue.issueId, issueKey: userIssueKey(issue), category: 'sourceMissing', actionId: 'cleanup',
      },
    });
    expect(review.technicalDetails).toContain(`来源身份：${reviewed.identity.slice('sha256:'.length, 'sha256:'.length + 8)}`);

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(executionResult, JSON.stringify(executionResult)).toMatchObject({ overallState: 'succeeded' });
    expect(JSON.stringify(executionResult)).not.toContain(retained.identity);
    await expect(fs.pathExists(reviewed.root)).resolves.toBe(false);
    await expect(fs.pathExists(retained.root)).resolves.toBe(true);
    await controller.load();
    expect(controller.listUserIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'sourceMissing', pluginId: 'removed/demo', sourceIdentity: retained.identity,
      }),
    ]));
    controller.dispose();
  });

  it('cleans a valid live owner when the configured path source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await fs.move(sourceRoot, `${sourceRoot}-unavailable`);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await fs.remove(active.snapshotPath);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
  });

  it('cleans a Codex project target when unrelated Codex user config inventory is damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'damaged-user-inventory-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'cleanup-test', title: 'Cleanup test', content: 'owned content' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const projectConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(projectConfig, 'utf8')).resolves.toContain('aw-owner-v2:');
    const damagedUserConfig = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await fs.outputFile(damagedUserConfig, 'invalid = [\n');

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(damagedUserConfig, 'utf8')).resolves.toBe('invalid = [\n');
    await expect(fs.readFile(projectConfig, 'utf8')).resolves.not.toContain('aw-owner-v2:');
  });

  it('recovers the primary Codex marketplace name from its native path when the weak root is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-missing-marketplace-root');
    const otherRoot = path.join(isolation.layout.fixtureCwd, 'new-primary-marketplace-source');
    await createDependencyCatalogSnapshotFixture(otherRoot, [{ name: 'other' }]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.scripts = {
          lifecycle: {
            install: { default: { runner: 'node', path: './scripts/install.mjs' } },
            uninstall: { default: { runner: 'node', path: './scripts/install.mjs' } },
          },
        };
      },
    }]);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'install.mjs'),
      'await Promise.resolve();\n',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.scripts = {
          lifecycle: {
            install: { default: { runner: 'node', path: './scripts/install.mjs' } },
            uninstall: { default: { runner: 'node', path: './scripts/install.mjs' } },
          },
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'team', type: 'path', primary: true, path: sourceRoot },
          { id: 'other', type: 'path', primary: false, path: otherRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const codexConfigPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args.includes('remove')) await fs.remove(codexConfigPath);
      return { exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' };
    });
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const lifecycleTarget = await resolveLifecycleActiveTarget({
      sourceId: 'team',
      sourceIdentity: installed.rebuildResults[0]!.target.sourceIdentity,
      pluginName: 'demo',
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const ownedConfig = await fs.readFile(codexConfigPath, 'utf8');
    await fs.outputFile(codexConfigPath, [ownedConfig,
      '[marketplaces.first]',
      'source_type = "local"',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      '',
      '[marketplaces.second]',
      'source_type = "local"',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      '',
      '[plugins."demo@first"]',
      'enabled = true',
      '',
    ].join('\n'));
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(false);
    expect(ownedConfig).toContain('aw-owner-v2:');
    await expect(fs.pathExists(lifecycleTarget.activeRoot)).resolves.toBe(true);
    await setPrimaryCatalogSourceCommand({
      sourceId: 'other',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const ambiguousStatus = await statusCommandV5({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    expect(ambiguousStatus.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/demo',
        state: 'error',
        errors: [expect.objectContaining({ message: expect.stringContaining('marketplaceIdentityUnavailable') })],
      }),
    ]);
    nativeCliRunner.mockClear();

    const blocked = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, { env: isolation.env, nativeCliRunner });
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'marketplaceIdentityUnavailable' }),
    ]);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    await expect(fs.readFile(codexConfigPath, 'utf8')).resolves.toContain('aw-owner-v2:');
    await expect(fs.pathExists(lifecycleTarget.activeRoot)).resolves.toBe(true);

    await fs.outputFile(codexConfigPath, [ownedConfig,
      '[marketplaces.aw]',
      'source_type = "local"',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      '',
      '[plugins."demo@aw"]',
      'enabled = true',
      '',
    ].join('\n'));
    nativeCliRunner.mockClear();

    const recoveredStatus = await statusCommandV5({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    expect(recoveredStatus.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', state: 'partial', errors: [] }),
    ]);
    await fs.move(sourceRoot, `${sourceRoot}-unavailable`);
    const damagedActive = await resolveActiveCatalogGeneration({
      sourceId: 'team', env: isolation.env,
    });
    await fs.remove(damagedActive.snapshotPath);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, { env: isolation.env, nativeCliRunner });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args.join(' ')))
      .toEqual(expect.arrayContaining([
        expect.stringContaining('plugin remove demo@aw'),
      ]));
    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args.join(' ')).join('\n'))
      .not.toContain('aw-team');
    await expect(fs.pathExists(codexConfigPath)).resolves.toBe(false);
    await expect(fs.pathExists(lifecycleTarget.activeRoot)).resolves.toBe(false);
  });

  it.each([false, true])(
    'cleans the old live identity after a real source A to B update with force=%s',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceA = path.join(isolation.layout.fixtureCwd, `identity-a-${force}`);
      const sourceB = path.join(isolation.layout.fixtureCwd, `identity-b-${force}`);
      await Promise.all([
        createDependencyCatalogSnapshotFixture(sourceA, [{ name: 'demo' }]),
        createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'demo' }]),
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 1,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const installedConfig = await fs.readFile(configPath, 'utf8');
      expect(installedConfig).toContain('demo.');
      await expect(updateCatalogSourceCommand({
        sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ ok: true, changed: true });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force,
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('demo.');
    },
  );

  it('keeps a source-changed dependency when an old live consumer can be confirmed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceA = path.join(isolation.layout.fixtureCwd, 'dependent-identity-a');
    const sourceB = path.join(isolation.layout.fixtureCwd, 'dependent-identity-b');
    await Promise.all([
      createDependencyCatalogSnapshotFixture(sourceA, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]),
      createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'leaf' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await updateCatalogSourceCommand({
      sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.copy(
      path.join(sourceA, 'plugins'),
      path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins'),
    );
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'root', '.agents-plugin', 'plugin.json',
    ))).resolves.toBe(true);

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('leaf.');
  });

  it('resolves a unique bare live cleanup target and rejects ambiguous live sources', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { sourceId: 'first', artifactKey: 'first-demo', fill: '1' },
      { sourceId: 'second', artifactKey: 'second-demo', fill: '2' },
    ];
    for (const entry of identities) {
      const skillRoot = path.join(skillsRoot, entry.artifactKey);
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({
        skillRoot,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: entry.sourceId,
          sourceIdentity: `sha256:${entry.fill.repeat(64)}`,
          pluginId: `${entry.sourceId}/demo`,
          plugin: 'demo',
          artifactKey: entry.artifactKey,
          platform: 'codex',
          scope: 'project',
        },
      });
    }
    const runtime = { env: isolation.env };
    const ambiguous = await cleanupWriteCommand(['demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(ambiguous.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'pluginSelectorAmbiguous' }),
    ]);
    await fs.remove(path.join(skillsRoot, 'second-demo'));

    const unique = await cleanupWriteCommand(['demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unique.overallState, JSON.stringify(unique.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(path.join(skillsRoot, 'first-demo'))).resolves.toBe(false);
  });

  it('force cleanup quarantines an exclusive directory with damaged owner identity', async () => {
    const isolation = await configureCatalog();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'damaged-demo');
    const otherSkillsRoot = path.join(isolation.env.AW_CLAUDE_HOME!, 'skills');
    const otherSkillRoot = path.join(otherSkillsRoot, 'damaged-demo');
    const invalidSkillRoot = path.join(skillsRoot, 'invalid-json');
    const linkedSkillRoot = path.join(skillsRoot, 'linked-marker');
    const externalMarker = path.join(isolation.layout.rootDir, 'foreign-owner-marker.json');
    await fs.ensureDir(skillRoot);
    const damagedOwner = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'local',
      sourceIdentity: 'damaged',
      pluginId: 'local/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    };
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), damagedOwner);
    await fs.outputJson(path.join(otherSkillRoot, '.agent-workflows-owner.json'), {
      ...damagedOwner,
      platform: 'claude',
      scope: 'user',
    });
    await fs.outputFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), '{invalid\n');
    await fs.outputJson(externalMarker, {
      ...damagedOwner,
      artifactKey: 'linked-marker',
    });
    await fs.ensureDir(linkedSkillRoot);
    await fs.symlink(externalMarker, path.join(linkedSkillRoot, '.agent-workflows-owner.json'));

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
  });

  it('force-cleans normal lifecycle state and a damaged Skill marker in one command', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'combined-force-cleanup-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        lifecycle: {
          install: { default: { runner: 'node', path: './scripts/lifecycle.mjs' } },
          uninstall: { default: { runner: 'node', path: './scripts/lifecycle.mjs' } },
        },
      };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'lifecycle.mjs'),
      'await Promise.resolve();\n',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const installedTarget = installed.rebuildResults[0]!.target;
    const activeTarget = await resolveLifecycleActiveTarget({
      sourceId: 'team',
      sourceIdentity: installedTarget.sourceIdentity,
      pluginName: 'demo',
      platform: 'codex',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(sharedConfig, 'utf8')).resolves.toContain('aw-owner-v2:');
    const skillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'combined-skill');
    const markerPath = path.join(skillRoot, '.agent-workflows-owner.json');
    await fs.outputJson(markerPath, {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'team',
      sourceIdentity: 'damaged',
      pluginId: 'team/demo',
      plugin: 'demo',
      artifactKey: 'combined-skill',
      platform: 'codex',
      scope: 'project',
    });
    await expect(fs.pathExists(activeTarget.activeRoot)).resolves.toBe(true);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults).toHaveLength(1);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(activeTarget.activeRoot)).resolves.toBe(false);
    await expect(fs.readFile(sharedConfig, 'utf8')).resolves.not.toContain('aw-owner-v2:');
  });

  it.each(['rename', 'remove'] as const)(
    'reports exclusive directory %s failure and continues force cleanup for another target',
    async (failurePhase) => {
      const isolation = await configureCatalog();
      const codexSkillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
      const codexSkillRoot = path.join(codexSkillsRoot, 'damaged-demo');
      const claudeSkillsRoot = path.join(isolation.layout.fixtureCwd, '.claude', 'skills');
      const claudeSkillRoot = path.join(claudeSkillsRoot, 'damaged-demo');
      const damagedOwner = {
        schemaVersion: 2,
        owner: 'agent-workflows',
        sourceId: 'local',
        sourceIdentity: 'damaged',
        pluginId: 'local/demo',
        plugin: 'demo',
        artifactKey: 'damaged-demo',
        scope: 'project',
      };
      await Promise.all([
        fs.outputJson(path.join(codexSkillRoot, '.agent-workflows-owner.json'), {
          ...damagedOwner, platform: 'codex',
        }),
        fs.outputJson(path.join(claudeSkillRoot, '.agent-workflows-owner.json'), {
          ...damagedOwner, platform: 'claude',
        }),
      ]);

      const result = await cleanupWriteCommand(['local/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'both', scope: 'project', force: true,
      }, {
        env: isolation.env,
        corruptExclusiveDirectoryOperations: {
          rename: async (source, destination) => {
            if (failurePhase === 'rename' && source === codexSkillRoot) {
              throw new Error('injected rename denial');
            }
            await fs.move(source, destination);
          },
          remove: async (target) => {
            if (failurePhase === 'remove' && target.startsWith(`${codexSkillsRoot}${path.sep}`)) {
              throw new Error('injected remove denial');
            }
            await fs.remove(target);
          },
        },
      });

      expect(result.overallState).toBe('failed');
      const codexResult = result.rebuildResults.find((entry) => entry.target.platform === 'codex')!;
      const claudeResult = result.rebuildResults.find((entry) => entry.target.platform === 'claude')!;
      expect(codexResult.status).toBe('failed');
      expect(codexResult.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: 'cleanup.owned',
          label: codexSkillRoot,
          message: expect.stringContaining(`${failurePhase === 'rename' ? 'mutation' : 'remove'} ${codexSkillRoot}`),
        }),
      ]));
      expect(codexResult.residual).toHaveLength(1);
      if (failurePhase === 'rename') {
        await expect(fs.pathExists(codexSkillRoot)).resolves.toBe(true);
      } else {
        const quarantines = (await fs.readdir(codexSkillsRoot))
          .filter((entry) => entry.startsWith('.agent-workflows-quarantine-'));
        expect(quarantines).toHaveLength(1);
        await expect(fs.pathExists(path.join(codexSkillsRoot, quarantines[0]!))).resolves.toBe(true);
      }
      expect(claudeResult.status, JSON.stringify(claudeResult)).toBe('succeeded');
      await expect(fs.pathExists(claudeSkillRoot)).resolves.toBe(false);
    },
  );

  it('force cleanup reports invalid shared config after recovering a damaged exclusive marker', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'owned-demo');
    await fs.ensureDir(skillRoot);
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: 'damaged',
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'owned-demo',
      platform: 'codex', scope: 'project',
    });
    const sharedPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignShared = 'invalid = [\n# agent-workflows demo without owner token\n';
    await fs.outputFile(sharedPath, foreignShared);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    expect(result.rebuildResults[0]).toMatchObject({
      residual: [expect.any(String)],
      failures: [expect.objectContaining({ phase: 'cleanup.owned' })],
    });
    await expect(fs.readFile(sharedPath, 'utf8')).resolves.toBe(foreignShared);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
  });

  it('does not block force cleanup when obsolete contract directory removal fails', async () => {
    const isolation = await configureCatalog();
    const baseRuntime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, baseRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const obsolete = path.join(isolation.env.AW_HOME!, 'installation-contracts');
    await fs.outputFile(path.join(obsolete, 'old.json'), '{}');

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, {
      ...baseRuntime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error('injected obsolete cleanup failure');
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([
      expect.stringContaining('obsoleteContractsCleanupFailed'),
    ]);
    await expect(fs.pathExists(obsolete)).resolves.toBe(true);
  });

  it('marks a dependency skipped when its batch consumer removal fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'skipped-dependency-source');
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'root', 'scripts', 'uninstall.mjs'),
      'throw new Error("injected consumer removal failure");\n',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'], configureManifest: (manifest) => {
        manifest.scripts = {
          lifecycle: {
            uninstall: { default: { runner: 'node', path: './scripts/uninstall.mjs' } },
          },
        };
      } },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const result = await uninstallWriteCommand(['team/root', 'team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('uninstall', result);
    expect(receipt.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/root', dependencyState: 'failed' }),
      expect.objectContaining({ pluginId: 'team/leaf', dependencyState: 'skipped' }),
    ]));
  });

  it('rebuilds a partial user dependency required by a project consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cross-scope-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const partialUserDependency = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(partialUserDependency.overallState).toBe('succeeded');
    const errorUserDependency = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async (invocation) => {
        if (invocation.args[1] === 'list') throw new Error('injected user dependency probe error');
        return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      },
    });
    expect(errorUserDependency.overallState).toBe('succeeded');
  });

  it.each(['uninstall', 'cleanup'] as const)(
    'blocks cross-scope %s when the user removal does not match the live project consumer',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `cross-scope-batch-${command}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 1,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      };
      await expect(installWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(installWriteCommand(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      if (command === 'uninstall') {
        const result = await uninstallWriteCommand(['team/root', 'team/leaf'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
        }, runtime);
        expect(result.targetResults).toEqual(expect.arrayContaining([
          expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
        ]));
      } else {
        await expect(withAwHomeMutationLock({
          env: isolation.env,
          action: (token) => runRebuildCommand({
            command: 'cleanup',
            pluginNames: ['team/root', 'team/leaf'],
            commandOptions: {
              cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
            },
            runtime: { ...runtime, awHomeMutationToken: token },
          }),
        })).rejects.toThrow('dependencyStillRequired');
      }
      await expect(uninstallWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime)).resolves.toMatchObject({
        targetResults: [expect.objectContaining({ errorCode: 'dependencyStillRequired' })],
      });
    },
  );

  it('marks a consumer partial when its live dependency is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-status-source');
    const agentPlugin = (name: string) => ({
      name,
      configureManifest: (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
        manifest.extensions = {
          agents: [{ name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` }],
        };
      },
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      agentPlugin('leaf'),
      { ...agentPlugin('root'), dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const status = () => statusCommandV5({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    const leafAgent = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    await fs.remove(leafAgent);
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        state: 'partial',
        dependencyReadiness: [{
          dependencyPluginId: 'team/leaf',
          state: 'absent',
          rootIssueCode: 'dependencyMissing',
          rootIssueId: 'dependencyMissing:team/leaf:codex:project',
        }],
        errors: expect.arrayContaining([
          expect.objectContaining({
            code: 'dependencyMissing',
            dependencyPluginId: 'team/leaf',
            rootIssueCode: 'dependencyMissing',
            rootIssueId: 'dependencyMissing:team/leaf:codex:project',
          }),
        ]),
      })] },
    });
    const createController = () => new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    const missingController = createController();
    await missingController.load();
    const missingIssue = missingController.listUserIssues().find((issue) =>
      issue.category === 'dependencyMissing'
      && issue.pluginId === 'team/root'
      && issue.platform === 'codex'
      && issue.scope === 'project');
    expect(missingIssue?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'installDependency', pluginId: 'team/leaf', platform: 'codex',
        scope: 'project', project: 'current',
      }),
    ]));
    missingController.dispose();

    await expect(reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await fs.remove(leafAgent);
    await fs.ensureDir(leafAgent);
    const notReadyController = createController();
    await notReadyController.load();
    const collisionIssue = notReadyController.listUserIssues().find((issue) =>
      issue.category === 'artifactCollision'
      && issue.pluginId === 'team/root'
      && issue.platform === 'codex'
      && issue.scope === 'project');
    expect(collisionIssue).toMatchObject({
      group: 'artifactCollision',
      dependencyPluginId: 'team/leaf',
      technicalDetails: expect.arrayContaining([expect.objectContaining({ code: 'dependencyNotReady' })]),
    });
    const collisionStatus = await status();
    expect(collisionStatus.payload.targets[0]).toMatchObject({
      state: 'partial',
      dependencyReadiness: [expect.objectContaining({
        dependencyPluginId: 'team/leaf',
        state: 'blockedByCollision',
        rootIssueCode: 'artifactCollision',
        rootIssueId: expect.stringContaining('artifactCollision:team/leaf:codex:project:'),
      })],
      errors: expect.arrayContaining([expect.objectContaining({
        code: 'dependencyNotReady',
        dependencyPluginId: 'team/leaf',
        rootIssueCode: 'artifactCollision',
      })]),
    });
    notReadyController.dispose();
  });

  it('projects a dependency target blocker through a real controller load', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const targetRoot = path.join(isolation.layout.fixtureCwd, 'dependency-target-issue-source');
    await createDependencyCatalogSnapshotFixture(targetRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.marketplace.policy.products = ['CODEX'];
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'target', type: 'path', primary: true, path: targetRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    })));
    await controller.load();

    expect(controller.listUserIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'dependencyTargetUnsupported',
        group: 'dependency',
        pluginId: 'target/root',
      }),
    ]));
    expect(controller.getPluginOverview('target/root')?.primaryAttention?.code)
      .toBe('dependencyTargetUnsupported');
    controller.dispose();
  });

  it('deduplicates status inspection for one dependency placement shared by consumers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-dedup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    let dependencyInspections = 0;
    setStatusDependencyInspectionHookForTests(() => { dependencyInspections += 1; });
    try {
      await statusCommandV5({
        plugins: ['team/first', 'team/second'], cwd: isolation.layout.fixtureCwd,
        env: isolation.env, cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setStatusDependencyInspectionHookForTests(undefined);
    }
    expect(dependencyInspections).toBe(1);
  });

  it('uses current manifest edges for status dependency checks', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-contract-drift-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const status = () => statusCommandV5({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'present', errors: [] })], errors: [] },
    });

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: [] },
    ]);
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'present', errors: [] })] },
    });
  });

  it('checks every requested target for foreign ownership before the first root writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-foreign-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first' },
      {
        name: 'second',
        configureManifest: (manifest) => {
          manifest.extensions!.agents = [{
            name: 'second-role', description: 'Second role.', prompt: 'Second.',
          }];
        },
      },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const foreignRole = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-second-second-role.toml');
    await fs.outputFile(foreignRole, 'foreign');

    const result = await installWriteCommand(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults.length).toBeGreaterThan(0);
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');
  });

  it('projects dynamic config and saves or resets it only through the real Controller review bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.config = {
        schema: {
          level: { type: 'enum', values: ['fast', 'strict'], title: '审查级别' },
          count: { type: 'number', min: 1, max: 10, title: '重试次数' },
          token: { type: 'string', sensitive: true, title: '令牌' },
          rules: { type: 'file', title: '规则文件' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level', 'count', 'token', 'rules'] }],
          fields: { level: { valueLabels: { fast: '快速', strict: '严格' }, recommendedValue: 'strict' } },
          presets: [{ id: 'strict', title: '严格方案', values: { level: 'strict', count: 7 } }],
        },
      };
    });
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const debugLog = vi.fn();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
      debugLogger: { log: debugLog },
    }));
    const page = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'user', projectLayer: 'shared' },
      new AbortController().signal,
    );
    expect(page.groups).toEqual([
      expect.objectContaining({
        title: '基本设置',
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'level', valueLabels: { fast: '快速', strict: '严格' }, recommendedValue: 'strict' }),
          expect.objectContaining({ key: 'count', min: 1, max: 10 }),
          expect.objectContaining({ key: 'token', sensitive: true }),
        ]),
      }),
    ]);
    expect(page.presets).toEqual([{ id: 'strict', title: '严格方案', values: { level: 'strict', count: 7 } }]);

    const controller = new TuiController(dependencies);
    await controller.load();
    const privatePath = path.join(isolation.layout.fixtureCwd, 'private-secret-rules.json');
    await expect(controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { rules: privatePath },
      privateKeys: ['rules'],
    })).rejects.toThrow('操作未建立。请检查当前设置后重试。');
    expect(JSON.stringify(debugLog.mock.calls)).not.toContain(privatePath);
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({
      message: 'TUI config operation failed.',
      data: expect.objectContaining({ code: expect.any(String) }),
    }));

    const save = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { level: 'strict', count: '7', token: 'sk-private' },
      sensitiveKeys: ['token'],
    });
    expect(JSON.stringify(save)).not.toContain('sk-private');
    await expect(controller.executeOperation(save.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });

    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { level: 'strict', count: 7, token: 'sk-private' } });

    await expect(controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { count: 99 },
    })).rejects.toThrow('操作未建立。请检查当前设置后重试。');

    const unavailableRoot = `${sourceRoot}-unavailable`;
    await fs.move(sourceRoot, unavailableRoot);
    const availability = await controller.getConfigResetAvailability(
      'team/demo',
      { scope: 'user', projectLayer: 'shared' },
    );
    expect(availability).toMatchObject({ exists: true, sourceIdentityPresent: true, sourceIdentity });
    expect(JSON.stringify(availability)).not.toContain('sk-private');
    expect(JSON.stringify(availability)).not.toContain(sourceRoot);

    await expect(controller.buildOperationReview({
      kind: 'configReset',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
    })).resolves.toMatchObject({ title: '重置插件设置' });
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      exists: true,
      values: { level: 'strict', count: 7, token: 'sk-private' },
    });

    await fs.move(unavailableRoot, sourceRoot);
    const restoredSave = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', updates: { level: 'fast' },
    });
    await expect(controller.executeOperation(restoredSave.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    const onlineReset = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
    });
    await expect(controller.executeOperation(onlineReset.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    controller.dispose();
  });

  it('executes a real dual-platform TUI write under one complete locked review', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-both-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const files = { "SKILL.md": "---\\nname: review\\ndescription: Review.\\n---\\n", "README.md": "Review.\\n" };',
      'if (context.platform === "codex") files["agents/openai.yaml"] = "policy:\\n  allow_implicit_invocation: true\\n";',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: `${context.platform}-review`, kind: "skill", platform: context.platform,',
      '  target: `${context.platform}.skill`, state: "present", refreshKeys: [],',
      '  skillKey: "review", content: { files }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: (['codex', 'claude'] as const).map((platform) => ({
          id: `${platform}-review`,
          platform,
          scopes: ['project'],
          target: `${platform}.skill`,
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
        })),
      };
      manifest.config = { schema: { mode: { type: 'string', title: '模式' } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.command === 'claude' ? 'claude 99.0.0' : 'codex-cli 99.0.0',
        stderr: '',
      }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'team/demo',
      platform: 'both',
      scope: 'project',
    } as const;
    await dependencies.validateIntent!(intent, new AbortController().signal);
    const evidence = await dependencies.captureEvidence(intent);

    const result = await dependencies.executeIntent(intent, evidence) as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ platform: 'codex', scope: 'project' }) }),
      expect.objectContaining({ target: expect.objectContaining({ platform: 'claude', scope: 'project' }) }),
    ]));
    expect(result.targetResults.map((target) => target.errorCode)).not.toContain('operationReviewStale');

    const reinstallIntent = {
      kind: 'pluginWrite', action: 'reinstall', pluginId: 'team/demo', platform: 'both', scope: 'project',
    } as const;
    const allFailedEvidence = await dependencies.captureEvidence(reinstallIntent);
    setRebuildCommandTestHooksForTests({
      async afterTargetBuilt() {
        throw new Error('durableCleanupFailed: retained backup cleanup failed');
      },
    });
    try {
      await expect(dependencies.executeIntent(reinstallIntent, allFailedEvidence)).resolves.toMatchObject({
        overallState: 'failed',
        targetResults: [
          expect.objectContaining({ state: 'failed' }),
          expect.objectContaining({ state: 'failed' }),
        ],
      });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }
    const configIntent = {
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared', updates: { mode: 'strict' },
    } as const;
    const [reinstallEvidence, configEvidence] = await Promise.all([
      dependencies.captureEvidence(reinstallIntent),
      dependencies.captureEvidence(configIntent),
    ]);
    const concurrentResults = await Promise.race([
      Promise.allSettled([
        dependencies.executeIntent(reinstallIntent, reinstallEvidence),
        dependencies.executeIntent(configIntent, configEvidence),
      ]),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ABBA operation lock timeout')), 5_000)),
    ]);
    if (concurrentResults[0].status === 'rejected') {
      expect(concurrentResults[0].reason).toMatchObject({ code: 'operationReviewStale' });
    } else {
      expect(concurrentResults[0].value).toMatchObject({
        overallState: 'failed',
        targetResults: [
          expect.objectContaining({ target: expect.objectContaining({ platform: 'codex' }), state: 'completed' }),
          expect.objectContaining({ target: expect.objectContaining({ platform: 'claude' }), state: 'failed' }),
        ],
      });
    }
    expect(JSON.stringify(concurrentResults[0])).not.toContain('operation.lock timeout');
    if (concurrentResults[1].status === 'rejected') {
      expect(concurrentResults[1].reason).toMatchObject({ code: 'operationReviewStale' });
    } else {
      expect(concurrentResults[1].value).toMatchObject({ configWrite: 'succeeded' });
      await expect(readPluginConfigStore({
        sourceId: 'team',
        sourceIdentity: (await calculateCatalogSourceIdentity({ id: 'team', type: 'path', primary: true, path: sourceRoot })),
        pluginName: 'demo',
        scope: 'project',
        projectLayer: 'shared',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      })).resolves.toMatchObject({ values: { mode: 'strict' } });
    }
  });

  it('blocks a reviewed install when the other scope is installed concurrently', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-scope-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'scope evidence' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    })));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'user',
    });
    const concurrent = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(concurrent.overallState).toBe('succeeded');

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({ state: 'blocked', code: 'scopeConflict' });
    expect(controller.snapshot.router.current.route).toEqual({ name: 'result', operationId: review.operationId });
    controller.dispose();
  });

  it('reviews and executes I03 partial removal through the real TUI write bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-partial-remove-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "codex-review", kind: "skill", platform: "codex",',
      '  target: "codex.skill", state: "present", refreshKeys: [], skillKey: "review",',
      '  content: { files: { "SKILL.md": "---\\nname: review\\ndescription: Review.\\n---\\n", "README.md": "Review.\\n", "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n" } }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { targets: [{
        id: 'codex-review',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'review',
      }] };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const installedSkill = (await fs.readdir(skillsRoot, { recursive: true }))
      .map(String)
      .find((entry) => entry.endsWith('SKILL.md'));
    expect(installedSkill).toBeDefined();
    await fs.remove(path.join(skillsRoot, installedSkill!));
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    const issue = controller.listUserIssues().find((entry) =>
      entry.category === 'incompleteInstallation'
      && entry.pluginId === 'team/demo'
      && entry.platform === 'codex'
      && entry.scope === 'project');
    expect(issue, JSON.stringify(controller.snapshot.viewModel?.issues)).toBeDefined();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'project',
      originIssue: {
        issueId: issue!.issueId,
        issueKey: userIssueKey(issue!),
        category: issue!.category,
        actionId: 'remove',
      },
    });
    expect(review).toMatchObject({ pluginAction: 'uninstall', originIssue: { actionId: 'remove' } });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(controller.listUserIssues().some((entry) => entry.issueId === issue!.issueId)).toBe(false);
    await expect(fs.pathExists(path.dirname(path.join(skillsRoot, installedSkill!)))).resolves.toBe(false);
    controller.dispose();
  });

  it('returns a new Review when source evidence changes before dispatch', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-stale-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'must not be written' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    })));
    try {
      const review = await controller.buildOperationReview({
        kind: 'pluginWrite',
        action: 'install',
        pluginId: 'team/demo',
        platform: 'codex',
        scope: 'project',
      });
      await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'changed\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'review', title: 'Review', content: 'changed content' }],
        };
      });
      await refreshCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const result = await controller.executeOperation(review.reviewToken);

      expect(result, JSON.stringify(result)).toMatchObject({
        state: 'stale',
        review: { title: '添加插件' },
      });
      await expect(fs.pathExists(path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'config.toml',
      ))).resolves.toBe(false);
    } finally {
      controller.dispose();
    }
  });

  it('removes the generated marketplace root only after the last platform consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.' }],
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async (invocation: NativeCliInvocation) => ({
      exitCode: 0,
      stdout: invocation.command === 'claude' ? 'claude 99.0.0' : 'codex-cli 99.0.0',
      stderr: '',
    });
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
        name: 'aw',
      }),
    ]);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const otherConsumer = path.join(skillsRoot, 'other-consumer');
    await fs.ensureDir(otherConsumer);
    await writeSkillOwnerMarker({
      skillRoot: otherConsumer,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/other',
        plugin: 'other',
        artifactKey: 'other-consumer',
        platform: 'codex',
        scope: 'project',
      },
    });
    const historicalProject = path.join(isolation.layout.rootDir, 'historical-project-b');
    const installedPluginsPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    await fs.outputJson(installedPluginsPath, {
      plugins: {
        'other-claude@aw': [{
          name: 'other-claude',
          marketplace: 'aw',
          scope: 'project',
          projectPath: historicalProject,
          version: '1.0.0',
        }],
      },
    });

    expect((await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).overallState).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);

    await fs.remove(otherConsumer);
    expect((await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).overallState).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
    await expect(fs.pathExists(historicalProject)).resolves.toBe(false);

    await fs.outputJson(installedPluginsPath, { plugins: {} });
    expect((await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).overallState).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(false);

    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-replacement');
    await createCatalogSnapshotFixture(replacementRoot, 'demo');
    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { path: replacementRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true, sourceId: 'team' });
  });

  it('runs every command through the same namespaced runtime', async () => {
    const isolation = await configureCatalog();
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }));
    const report = vi.fn();
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
      reporter: { event: report, notice: vi.fn() },
      debugLogger: { log: vi.fn() },
    };
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    } as const;

    const results = [
      await installWriteCommand(['demo'], options, runtime),
      await upgradeWriteCommand(['demo'], options, runtime),
      await reinstallWriteCommand(['demo'], options, runtime),
      await uninstallWriteCommand(['demo'], options, runtime),
      await cleanupWriteCommand(['demo'], options, runtime),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        overallState: 'succeeded',
        warnings: [],
        receiptTargets: [{
          pluginName: 'demo',
          pluginId: 'local/demo',
          sourceId: 'local',
          platform: 'codex',
          scope: 'user',
        }],
      });
    }
    expect(nativeCliRunner).toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
  });

  it.each([
    ['secondary installation after becoming primary', false, 'cleanup'],
    ['primary installation after another source becomes primary', true, 'uninstall'],
  ] as const)('keeps the live Codex marketplace for %s', async (_label, teamInitiallyPrimary, command) => {
    const isolation = getCurrentSourceTestIsolation();
    const teamRoot = path.join(isolation.layout.fixtureCwd, `marketplace-team-${command}`);
    const otherRoot = path.join(isolation.layout.fixtureCwd, `marketplace-other-${command}`);
    await Promise.all([
      createDependencyCatalogSnapshotFixture(teamRoot, [{ name: 'demo' }]),
      createDependencyCatalogSnapshotFixture(otherRoot, [{ name: 'other' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'team', type: 'path', primary: teamInitiallyPrimary, path: teamRoot },
          { id: 'other', type: 'path', primary: !teamInitiallyPrimary, path: otherRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const installedMarketplaceName = teamInitiallyPrimary ? 'aw' : 'aw-team';
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await fs.copy(teamRoot, marketplaceRoot);
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: await calculateCatalogSourceIdentity({
          id: 'team', type: 'path', primary: teamInitiallyPrimary, path: teamRoot,
        }),
        marketplaceName: installedMarketplaceName,
      }),
      ...[
        path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      ].map(async (manifestPath) => {
        const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
        await fs.outputJson(manifestPath, { ...manifest, name: installedMarketplaceName });
      }),
    ]);
    await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
      marketplaceName: installedMarketplaceName,
    });
    await setPrimaryCatalogSourceCommand({
      sourceId: teamInitiallyPrimary ? 'other' : 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });

    const status = await statusCommandV5({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', state: 'present' }),
    ]);
    const result = command === 'cleanup'
      ? await cleanupWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)
      : await uninstallWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(false);
  });

  it('blocks same-name unbound Claude records and preserves different-name records', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const codexRoot = path.join(isolation.layout.fixtureCwd, 'codex-source');
    const claudeRoot = path.join(isolation.layout.fixtureCwd, 'claude-source');
    const dualRoot = path.join(isolation.layout.fixtureCwd, 'dual-source');
    const dualPluginRoot = path.join(dualRoot, 'plugins', 'config-dual');
    await fs.outputFile(path.join(dualPluginRoot, 'scripts', 'render.mjs'), [
        'import { readFile } from "node:fs/promises";',
        'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'const mode = context.config.values.mode ?? "safe";',
        'if (context.platform === "claude" && mode === "fast") throw new Error("claude render failed");',
        'const files = { "SKILL.md": "---\\nname: mode-skill\\ndescription: Mode skill.\\n---\\n", "README.md": "Mode skill.\\n",',
        '  "references/runtime.md": `mode=${mode}\\n` };',
        'if (context.platform === "codex") files["agents/openai.yaml"] = "policy:\\n  allow_implicit_invocation: true\\n";',
        'console.log(JSON.stringify({ version: 2, artifacts: [{',
        '  id: `${context.platform}-mode`, kind: "skill", platform: context.platform,',
        '  target: `${context.platform}.skill`, state: "present", refreshKeys: ["mode"],',
        '  skillKey: "mode-skill", content: { files }',
        '}] }));',
      ].join('\n'));
    await Promise.all([
      createCatalogSnapshotFixture(codexRoot, 'codex-only', '0.0.0', 'codex\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
      }),
      createCatalogSnapshotFixture(claudeRoot, 'claude-only', '0.0.0', 'claude\n', (manifest) => {
        manifest.marketplace.policy.products = ['CLAUDE'];
      }),
      createCatalogSnapshotFixture(dualRoot, 'config-dual', '0.0.0', 'dual\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
        manifest.config = {
          schema: { mode: { type: 'enum', values: ['safe', 'fast'], default: 'safe' } },
        };
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = {
          targets: (['codex', 'claude'] as const).map((platform) => ({
            id: `${platform}-mode`,
            platform,
            scopes: ['project'],
            target: `${platform}.skill`,
            states: ['present'],
            refreshKeys: ['mode'],
            skillKey: 'mode-skill',
          })),
        };
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'codex', type: 'path', primary: true, path: codexRoot },
          { id: 'claude', type: 'path', primary: false, path: claudeRoot },
          { id: 'dual', type: 'path', primary: false, path: dualRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoots = new Map<string, string>();
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const pluginsDir = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins');
        const scopeIndex = invocation.args.indexOf('--scope');
        const scope = scopeIndex === -1 ? 'user' : invocation.args[scopeIndex + 1]!;
        const projectPath = await fs.realpath(invocation.cwd ?? isolation.layout.fixtureCwd);
        const settingsPath = scope === 'project'
          ? path.join(projectPath, '.claude', 'settings.json')
          : path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
        const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
        const installedPath = path.join(pluginsDir, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const extraKnownMarketplaces = (settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>;
          extraKnownMarketplaces[config.marketplaceName] = {
            source: { source: 'directory', path: marketplaceRoot },
          };
          await fs.outputJson(settingsPath, { ...settings, extraKnownMarketplaces });
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          known[config.marketplaceName] = {
            source: { source: 'directory', path: marketplaceRoot },
            installLocation: marketplaceRoot,
          };
          await fs.outputJson(knownPath, known);
        }
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'remove') {
          const marketplaceName = invocation.args[3]!;
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const extraKnownMarketplaces = {
            ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
          };
          delete extraKnownMarketplaces[marketplaceName];
          await fs.outputJson(settingsPath, { ...settings, extraKnownMarketplaces });
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          delete known[marketplaceName];
          await fs.outputJson(knownPath, known);
        }
        if (invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
          enabledPlugins[pluginId] = true;
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginName];
          await fs.outputJson(installedPath, {
            plugins: {
              ...plugins,
              [pluginId]: [{
                name: pluginName,
                scope,
                ...(scope === 'project' ? { projectPath } : {}),
                version: '1.0.0',
              }],
            },
          });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
        if (invocation.args[1] === 'uninstall') {
          const pluginId = invocation.args[2]!;
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
          delete enabledPlugins[pluginId];
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = installed.plugins ?? {};
          delete plugins[pluginId];
          await fs.outputJson(installedPath, { plugins });
        }
      }
      return { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' };
    });
    const runtime = { env: isolation.env, nativeCliRunner };
    const installedPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    const sameNameUnboundRecord = {
      name: 'claude-only',
      scope: 'user',
      version: '1.0.0',
      installPath: path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'cache', 'claude-only'),
    };
    const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    const settingsBytes = Buffer.from('{ "sentinel": true }\n');
    const installedBytes = Buffer.from(`${JSON.stringify({
      plugins: { 'claude-only': [sameNameUnboundRecord] },
    }, null, 4)}\n`);
    await Promise.all([
      fs.outputFile(settingsPath, settingsBytes),
      fs.outputFile(installedPath, installedBytes),
    ]);
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
    } as const;
    const selectors = ['codex/codex-only', 'claude/claude-only'];

    for (const [command, commandSelectors] of [
      [installWriteCommand, selectors],
      [upgradeWriteCommand, selectors],
      [reinstallWriteCommand, ['claude/claude-only']],
    ] as const) {
      nativeCliRunner.mockClear();
      const result = await command([...commandSelectors], options, runtime);
      expect(result).toMatchObject({
        overallState: 'failed',
        targetResults: expect.arrayContaining([
          expect.objectContaining({ errorCode: 'externalOwnershipPresent' }),
        ]),
      });
      expect(nativeCliRunner).not.toHaveBeenCalled();
      await expect(fs.readFile(settingsPath)).resolves.toEqual(settingsBytes);
      await expect(fs.readFile(installedPath)).resolves.toEqual(installedBytes);
    }

    const unboundInstalledRecord = {
      name: 'default-plugin',
      scope: 'project',
      projectPath: await fs.realpath(isolation.layout.fixtureCwd),
      version: '1.0.0',
      installPath: path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'cache', 'default-plugin'),
    };
    await fs.outputJson(installedPath, {
      plugins: { 'default-plugin': [unboundInstalledRecord] },
    });
    for (const command of [installWriteCommand, upgradeWriteCommand]) {
      const result = await command(selectors, options, runtime);
      expect(result).toMatchObject({
        overallState: 'succeeded',
        receiptTargets: expect.arrayContaining([
          expect.objectContaining({ pluginId: 'codex/codex-only', platform: 'codex' }),
          expect.objectContaining({ pluginId: 'claude/claude-only', platform: 'claude' }),
        ]),
      });
      expect(result.receiptTargets).toHaveLength(2);
      await expect(fs.readJson(installedPath)).resolves.toMatchObject({
        plugins: { 'default-plugin': [unboundInstalledRecord] },
      });
    }

    for (const [selector, platform] of [
      ['codex/codex-only', 'codex'],
      ['claude/claude-only', 'claude'],
    ] as const) {
      const result = await reinstallWriteCommand([selector], options, runtime);
      expect(result).toMatchObject({
        overallState: 'succeeded',
        receiptTargets: [expect.objectContaining({ pluginId: selector, platform })],
      });
      await expect(fs.readJson(installedPath)).resolves.toMatchObject({
        plugins: { 'default-plugin': [unboundInstalledRecord] },
      });
    }

    const uninstalled = await uninstallWriteCommand(['claude/claude-only'], options, runtime);
    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    const cleaned = await cleanupWriteCommand(['claude/claude-only'], options, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.readJson(installedPath)).resolves.toMatchObject({
      plugins: { 'default-plugin': [unboundInstalledRecord] },
    });

    const unsupported = await installWriteCommand(['codex/codex-only'], {
      ...options,
      platform: 'claude',
    }, runtime);
    expect(unsupported).toMatchObject({
      overallState: 'failed',
      receiptTargets: [expect.objectContaining({
        pluginId: 'codex/codex-only',
        platform: 'claude',
      })],
    });

    const dualInstalled = await installWriteCommand(['dual/config-dual'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, runtime);
    expect(dualInstalled.overallState, JSON.stringify(dualInstalled.rebuildResults)).toBe('succeeded');
    const codexRuntime = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'mode-skill',
      'references',
      'runtime.md',
    );
    const claudeRuntime = path.join(
      isolation.layout.fixtureCwd,
      '.claude',
      'skills',
      'mode-skill',
      'references',
      'runtime.md',
    );
    expect(await fs.readFile(codexRuntime, 'utf8')).toBe('mode=safe\n');
    expect(await fs.readFile(claudeRuntime, 'utf8')).toBe('mode=safe\n');

    const captured = createCapturedCliIo();
    expect(await runCli([
      'config', 'set', 'dual/config-dual', 'mode', 'fast', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'failed',
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ platform: 'codex' }),
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({ platform: 'claude' }),
          state: 'failed',
        }),
      ]),
    });
    const dualSourceIdentity = await calculateCatalogSourceIdentity({
      id: 'dual', type: 'path', primary: false, path: dualRoot,
    });
    expect((await readPluginConfigStore({
      sourceId: 'dual',
      sourceIdentity: dualSourceIdentity,
      pluginName: 'config-dual',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).values).toEqual({ mode: 'fast' });
    expect(await fs.readFile(codexRuntime, 'utf8')).toBe('mode=fast\n');
    expect(await fs.readFile(claudeRuntime, 'utf8')).toBe('mode=safe\n');
  });

  it('blocks a config reapply that would overwrite a same-name unbound Claude record', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'claude-config-collision-source');
    await createCatalogSnapshotFixture(sourceRoot, 'config-native', '0.0.0', 'config\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
      manifest.config = {
        schema: { mode: { type: 'enum', values: ['safe', 'fast'], default: 'safe' } },
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await fs.copy(sourceRoot, marketplaceRoot);
    await fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity,
      marketplaceName: 'aw',
    });
    for (const manifestPath of [
      path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    ]) {
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, { ...manifest, name: 'aw' });
    }
    const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    const installedPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'installed_plugins.json',
    );
    const knownPath = path.join(
      isolation.env.AW_CLAUDE_HOME!,
      'plugins',
      'known_marketplaces.json',
    );
    const settingsBytes = Buffer.from(`${JSON.stringify({
      extraKnownMarketplaces: {
        aw: { source: { source: 'directory', path: marketplaceRoot } },
      },
      enabledPlugins: { 'config-native@aw': true },
    }, null, 2)}\n`);
    const installedBytes = Buffer.from(`${JSON.stringify({
      plugins: {
        'config-native@aw': [{ name: 'config-native', scope: 'user', version: '1.0.0' }],
        'config-native': [{ name: 'config-native', scope: 'project', version: '9.9.9' }],
      },
    }, null, 2)}\n`);
    await Promise.all([
      fs.outputFile(settingsPath, settingsBytes),
      fs.outputFile(installedPath, installedBytes),
      fs.outputJson(knownPath, {
        aw: {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
        },
      }),
    ]);
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'claude-cli 99.0.0',
      stderr: '',
    }));
    const captured = createCapturedCliIo();

    expect(await runCli([
      'config', 'set', 'team/config-native', 'mode', 'fast', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'failed',
      targetResults: expect.arrayContaining([
        expect.objectContaining({ errorCode: 'externalOwnershipPresent' }),
      ]),
    });
    expect(nativeCliRunner).not.toHaveBeenCalled();
    await expect(fs.readFile(settingsPath)).resolves.toEqual(settingsBytes);
    await expect(fs.readFile(installedPath)).resolves.toEqual(installedBytes);
  });

  it('deduplicates bare, qualified, and repeated selectors by canonical target identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dedupe-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'dedupe', title: 'Dedupe', content: 'One write.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['demo', 'team/demo', 'team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.receiptTargets).toEqual([expect.objectContaining({
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'project',
    })]);
    expect(result.rebuildResults).toHaveLength(1);
  });

  it('accepts upgrade --all when no live namespaced targets exist', async () => {
    const isolation = await configureCatalog();
    const result = await upgradeWriteCommand([], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
      all: true,
    });
    expect(result.overallState).toBe('succeeded');
    expect(result.warnings).toEqual([]);
    expect(result.receiptTargets).toEqual([]);
  });

  it('public uninstall rejects an orphan lifecycle snapshot when only an empty marketplace is live', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-lifecycle-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'uninstall.mjs'),
      'await import("node:fs/promises").then((fs) => fs.writeFile("uninstall-ran", "ran"));\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        lifecycle: {
          uninstall: { default: { runner: 'node', path: './scripts/uninstall.mjs' } },
        },
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: await fs.realpath(sourceRoot) } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    plugin.sourceId = 'team';
    plugin.sourceIdentity = sourceIdentity;
    plugin.pluginId = 'team/demo';
    const prepared = await prepareLifecycleActiveSnapshot({
      sourceId: 'team',
      sourceIdentity,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      artifacts: [],
      env: isolation.env,
      loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
    });
    expect(prepared.status).toBe('staged');
    await promoteLifecycleActiveSnapshot(prepared);
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2, sourceId: 'team', sourceIdentity, marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw-team',
      }),
      fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw-team]',
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ].join('\n')),
    ]);
    const captured = createCapturedCliIo();

    expect(await runCli([
      'uninstall', 'team/demo', '--platform', 'codex', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    })).toBe(1);
    const payload = JSON.parse(captured.readStdout());
    expect(payload.errors).toEqual([]);
    expect(payload).toMatchObject({
      overallState: 'failed',
      targets: [expect.objectContaining({ errorCode: 'liveOwnershipRequired' })],
    });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, 'uninstall-ran'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!, 'lifecycle-active', 'team', 'codex', 'user', 'user', 'demo', 'active',
    ))).resolves.toBe(true);
  });

  it('keeps safely separable same-name project instruction owners namespaced', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'second-source');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', '0.0.0', 'first\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'first-policy', title: 'First', content: 'First.' }],
        };
      }),
      createCatalogSnapshotFixture(secondRoot, 'demo', '0.0.0', 'second\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'second-policy', title: 'Second', content: 'Second.' }],
        };
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'first', type: 'path', primary: true, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));

    const installed = await installWriteCommand(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const config = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('First.');
    expect(config).toContain('Second.');
    expect(nativeCliRunner).toHaveBeenCalledTimes(1);
  });

  it('replays public namespaced config writes and keeps the store when rendering fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-replay-source');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const mode = context.config.values.mode ?? "safe";',
      'if (mode === "fail") throw new Error("renderer requested failure");',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "instruction", kind: "instruction", platform: "codex",',
      '  target: "codex.developerInstructionsBlock", state: "present",',
      '  refreshKeys: ["mode"], content: `mode=${mode}`',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.config = {
        schema: {
          mode: { type: 'enum', values: ['safe', 'fast', 'fail'], default: 'safe' },
        },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'instruction',
          platform: 'codex',
          scopes: ['project'],
          target: 'codex.developerInstructionsBlock',
          states: ['present'],
          refreshKeys: ['mode'],
          requiresCodexProjectConfig: true,
        }],
      };
      manifest.marketplace.policy.products = ['CODEX'];
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner,
      });
      return {
        exitCode,
        payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
        stderr: captured.readStderr(),
      };
    };
    const readStore = () => readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');

    expect(await runPublic([
      'install', 'team/demo', '--platform', 'codex', '--scope', 'project',
    ])).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    const set = await runPublic([
      'config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'project',
    ]);
    expect(set).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({ mode: 'fast' });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

    const unset = await runPublic([
      'config', 'unset', 'team/demo', 'mode', '--scope', 'project',
    ]);
    expect(unset).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({});
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    await runPublic(['config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'project']);
    const reset = await runPublic([
      'config', 'reset', 'team/demo', '--scope', 'project', '--yes',
    ]);
    expect(reset).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded', deleted: true },
    });
    expect((await readStore()).exists).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    await runPublic(['config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'project']);
    const failed = await runPublic([
      'config', 'set', 'team/demo', 'mode', 'fail', '--scope', 'project',
    ]);
    expect(failed).toMatchObject({
      exitCode: 1,
      payload: { configWrite: 'succeeded', overallState: 'failed' },
    });
    expect((await readStore()).values).toEqual({ mode: 'fail' });
    const configAfterFailure = await fs.readFile(configPath, 'utf8');
    expect(configAfterFailure).toContain('mode=fast');
    expect(configAfterFailure).not.toContain('mode=fail');
  });
});
