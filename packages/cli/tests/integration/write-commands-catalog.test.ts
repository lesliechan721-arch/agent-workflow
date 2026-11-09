import { describe, beforeEach, expect, it, vi } from 'vitest';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { OFFICIAL_CATALOG_SOURCE_SSH_URL, OFFICIAL_CATALOG_SOURCE_URL } from '../../src/constants.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
  resolveCatalogSourceRef,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { readPluginConfigStore, resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import type { CatalogSource, CatalogSourceResolution, PluginMeta } from '../../src/types.js';
import { updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';

import {
  syncWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  createCodexNativeTestRuntime,
  configureCodexAliasCatalog,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it.each(['sourceConfig', 'state', 'store'] as const)(
    'keeps cleanup recovery ownership-safe when Catalog %s is damaged',
    async (damagedControl) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `damaged-${damagedControl}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'normal' },
        { name: 'forced' },
      ]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/normal', 'team/forced'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const intentLocation = {
        scope: 'project' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      const foreignRole = path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        `foreign-${damagedControl}.toml`,
      );
      await fs.outputFile(foreignRole, 'foreign = true\n');
      const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(sharedConfig, {
        upsertMcpServers: { foreign: { command: 'foreign' } },
      });

      if (damagedControl === 'sourceConfig') {
        await fs.outputFile(path.join(isolation.env.AW_HOME!, 'catalog-sources.json'), '{private-data');
      } else if (damagedControl === 'state') {
        await fs.outputFile(path.join(isolation.env.AW_HOME!, 'catalog-state.json'), '{private-data');
      } else {
        const state = await fs.readJson(path.join(isolation.env.AW_HOME!, 'catalog-state.json')) as {
          sources: { team: { active: { logicalIdentity: string; snapshotDigest: string } } };
        };
        const store = resolveCatalogStoreLocation({ ...state.sources.team.active, env: isolation.env });
        await fs.outputFile(store.metadataPath, '{private-data');
      }

      if (damagedControl === 'sourceConfig') {
        const uninstall = await uninstallWriteCommand(['team/normal'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime);
        expect(uninstall.targetResults).toEqual([
          expect.objectContaining({ errorCode: 'catalogSourceUnavailable' }),
        ]);
      }
      const normal = await cleanupWriteCommand(['team/normal'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      const forced = await cleanupWriteCommand(['team/forced'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
      }, runtime);

      expect(normal.overallState, JSON.stringify(normal.rebuildResults)).toBe('succeeded');
      expect(forced.overallState, JSON.stringify(forced.rebuildResults)).toBe('succeeded');
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/normal' }), expect.objectContaining({ pluginId: 'team/forced' })]) });
      await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign = true\n');
      await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
        snapshot: { mcpServers: { foreign: { value: { command: 'foreign' } } } },
      });
    },
    30_000,
  );

  it('keeps warm write, config, and status provider-free after the TUI background check', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'warm-active-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'warm\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'warm', title: 'Warm', content: 'Warm.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
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

    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(statusCommandV8({
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
    await vi.waitFor(() => expect(providerCalls).toBe(1));
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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'changed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'warm', title: 'Warm', content: 'Changed.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    await syncCatalogSourceGeneration({
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
    expect(providerCalls).toBe(1);
  });

  it('keeps owner and config identity after the official HTTPS transport changes to SSH', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const httpsRoot = path.join(isolation.layout.fixtureCwd, 'official-https-generation');
    const sshRoot = path.join(isolation.layout.fixtureCwd, 'official-ssh-generation');
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'transport', title: 'Transport', content: 'Transport.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    };
    await Promise.all([
      createCatalogSnapshotFixture(httpsRoot, 'demo', [], 'https\n', configureManifest),
      createCatalogSnapshotFixture(sshRoot, 'demo', [], 'ssh\n', configureManifest),
    ]);
    const sshManifestPath = path.join(sshRoot, 'catalog-manifest.json');
    const sshManifest = await fs.readJson(sshManifestPath) as Record<string, unknown>;
    sshManifest.catalogVersion = '2.0.0';
    await Promise.all([
      fs.writeJson(sshManifestPath, sshManifest, { spaces: 2 }),
      ...[httpsRoot, sshRoot].map((root) => fs.writeJson(path.join(root, '.aw-generated.json'), {
        schemaVersion: 1,
        kind: 'catalog',
        workspaceIdentity: 'workspace:official-transport',
        sourceIdentity: 'sha256:'.concat('1'.repeat(64)),
      }, { spaces: 2 })),
    ]);
    const httpsSource = {
      id: 'official', type: 'git', primary: true, url: OFFICIAL_CATALOG_SOURCE_URL,
      refPolicy: { type: 'cliChannel' },
    } as const;
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [httpsSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    let currentRoot = httpsRoot;
    let commit = '1'.repeat(40);
    const resolvedTransports: string[] = [];
    const gitProvider = async (source: CatalogSource): Promise<CatalogSourceResolution> => {
      if (source.type === 'git') resolvedTransports.push(source.url);
      const validation = await validateCatalogSnapshotTransport(currentRoot);
      return {
        sourceId: source.id,
        sourceIdentity: await calculateCatalogSourceIdentity(source),
        requestedRef: source.type === 'git'
          ? resolveCatalogSourceRef(source.refPolicy, '1.0.0')
          : 'path',
        resolvedCommit: commit,
        rootDir: currentRoot,
        manifest: validation.manifest,
        manifestDigest: validation.manifestDigest,
        snapshotDigest: validation.snapshotDigest,
        cacheEntryKey: commit,
        source: 'remote',
        cacheFallback: false,
        cleanup: async () => undefined,
      };
    };
    const catalogGenerationRuntime = {
      providers: {
        git: gitProvider,
        path: catalogPathProviderInternal.resolve,
      },
    };
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env,
      runtime: catalogGenerationRuntime,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(httpsSource);
    const nativeCliRunner = async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    });
    await expect(installFixturePlugin(['official/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity, logicalIdentity: 'workspace:official-transport',
      pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'https' },
    });

    currentRoot = sshRoot;
    commit = '2'.repeat(40);
    await expect(updateCatalogSourceCommand({
      sourceId: 'official', update: { url: OFFICIAL_CATALOG_SOURCE_SSH_URL },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      runtime: { generation: catalogGenerationRuntime },
    })).resolves.toMatchObject({ ok: true, changed: true, errors: [] });
    expect(resolvedTransports).toEqual([
      OFFICIAL_CATALOG_SOURCE_URL,
    ]);
    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
      config: { sources: [{ url: OFFICIAL_CATALOG_SOURCE_SSH_URL }] },
    });
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env,
      runtime: catalogGenerationRuntime,
    });
    expect(resolvedTransports).toEqual([
      OFFICIAL_CATALOG_SOURCE_URL,
      OFFICIAL_CATALOG_SOURCE_SSH_URL,
    ]);

    const status = await statusCommandV8({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'official/demo', state: 'ready', reasons: [] }),
    ]);
    const captured = createCapturedCliIo();
    await expect(runCli([
      'plugin', 'config', 'set', 'official/demo', 'mode', '--value-json', '"ssh"', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).resolves.toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.set', status: 'success',
      data: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'notRequested', targetResults: [] } },
      diagnostics: expect.any(Array), nextActions: expect.any(Array),
    });
    await expect(readPluginConfigStore({
      sourceId: 'official', sourceIdentity, logicalIdentity: 'workspace:official-transport',
      pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'ssh' } });
    await expect(reinstallWriteCommand(['official/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
  });

  it('preserves a saved user profile and requires reset after a path source identity changes', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'project-config-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'project-config-second-source');
    const otherRoot = path.join(isolation.layout.fixtureCwd, 'project-config-other-source');
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'configured', title: 'Configured', content: 'Configured.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    };
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', [], 'first\n', configureManifest),
      createCatalogSnapshotFixture(secondRoot, 'demo', [], 'second\n', configureManifest),
      createCatalogSnapshotFixture(otherRoot, 'demo', [], 'other\n', configureManifest),
    ]);
    const logicalIdentity = 'workspace:portable-project-config';
    for (const root of [firstRoot, secondRoot]) {
      const markerPath = path.join(root, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      await fs.writeJson(markerPath, { ...marker, workspaceIdentity: logicalIdentity });
    }
    const otherMarkerPath = path.join(otherRoot, '.aw-generated.json');
    const otherMarker = await fs.readJson(otherMarkerPath) as Record<string, unknown>;
    await fs.writeJson(otherMarkerPath, {
      ...otherMarker,
      workspaceIdentity: 'workspace:different-project-config',
    });

    const firstSource = { id: 'team', type: 'path', primary: true, path: firstRoot } as const;
    const secondSource = { ...firstSource, path: secondRoot };
    const otherSource = { ...firstSource, path: otherRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeRuntime = await createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner: nativeRuntime.nativeCliRunner,
      });
      return {
        exitCode,
        stdout: captured.readStdout(),
        stderr: captured.readStderr(),
      };
    };
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'project', '--value-json', '"first"',
    ])).toMatchObject({ exitCode: 0 });

    const savedConfigPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const firstSavedBytes = await fs.readFile(savedConfigPath);
    const firstIdentity = await calculateCatalogSourceIdentity(firstSource);
    const secondIdentity = await calculateCatalogSourceIdentity(secondSource);
    expect(secondIdentity).not.toBe(firstIdentity);
    const beforeSecond = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: { schemaVersion: 2, sources: [secondSource] },
      expectedDigest: beforeSecond.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity: secondIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ state: 'invalid', invalidCode: 'identityMismatch', values: {} });
    await expect(fs.readFile(savedConfigPath)).resolves.toEqual(firstSavedBytes);
    expect(await runPublic(['plugin', 'config', 'reset', 'team/demo', '--context', 'project', '--yes']))
      .toMatchObject({ exitCode: 0 });
    expect(await runPublic([
      'plugin', 'install', 'team/demo', '--scope', 'project',
    ])).toMatchObject({ exitCode: 0 });
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'project', '--value-json', '"second"',
      '--apply', '--yes',
    ])).toMatchObject({ exitCode: 0 });

    const beforeOther = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: { schemaVersion: 2, sources: [otherSource] },
      expectedDigest: beforeOther.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const rejected = await runPublic([
      'plugin', 'config', 'get', 'team/demo', '--context', 'project',
    ]);
    expect(rejected.exitCode, rejected.stdout).toBe(3);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.get', status: 'blocked',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'identityMismatch' })]),
      nextActions: expect.any(Array),
    });
  });

  it('pins successful TUI source generations when another source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-session-good');
    const writeGoodSource = (version: string, field: string, content: string) =>
      createCatalogSnapshotFixture(sourceRoot, 'demo', [], `${content}\n`, (manifest) => {
        manifest.version = version;
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'session', title: 'Session', content }],
        };
        manifest.config = { schemaVersion: 5,
          fields: {
            oldMode: { type: 'string', title: 'oldMode' },
            ...(field === 'oldMode' ? {} : { [field]: { type: 'string', title: field } }),
          },
        };
      });
    await writeGoodSource('1.0.0', 'oldMode', 'old generation');
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
        expect.objectContaining({ sourceId: 'good', state: 'ready' }),
        expect.objectContaining({ sourceId: 'missing', state: 'unavailable' }),
      ]));
    });
    await vi.waitFor(() => {
      expect(goodProviderCalls).toBe(1);
      expect(missingProviderCalls).toBe(1);
    });

    await writeGoodSource('2.0.0', 'newMode', 'new generation');
    await syncCatalogSourceGeneration({
      sourceId: 'good', cliVersion: '1.0.0', env: isolation.env,
    });
    expect(controller.getPluginOverview('good/demo')).toMatchObject({ version: '1.0.0' });
    const page = await controller.getConfigPage(
      'good/demo',
      { context: 'project' },
    );
    expect(page.groups.flatMap((group) => group.fields.map((field) => field.key)))
      .toContain('oldMode');
    expect(page.groups.flatMap((group) => group.fields.map((field) => field.key)))
      .not.toContain('newMode');
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'good/demo',
      scope: 'user',
      context: 'project',
      updates: { oldMode: 'strict' },
    });
    const executeResult = await controller.executeOperation(review.reviewToken);
    expect(executeResult, JSON.stringify(executeResult)).toMatchObject({ state: 'stale' });
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'good', type: 'path', primary: true, path: sourceRoot,
    });
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    await expect(readPluginConfigStore({
      sourceId: 'good',
      sourceIdentity,
      logicalIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: false });
    const missingPlan = await controller.prepareScopedTask({
      kind: 'recovery', command: 'install', scope: 'project',
      selectors: ['missing/demo'],
    });
    expect(missingPlan).toMatchObject({ kind: 'recovery', scope: 'project' });
    if (missingPlan.kind !== 'recovery') throw new Error('Expected recovery plan.');
    expect(missingPlan.plan.receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sourceActiveUnavailable' }),
    ]));
    expect(goodProviderCalls).toBe(1);
    await vi.waitFor(() => {
      expect(missingProviderCalls).toBe(1);
    });
    controller.dispose();
  });

  it('keeps a Codex user install healthy when the project config aliases the user home', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'codex-scope-alias-home');
    await fs.ensureDir(path.join(cwd, '.git'));
    const { env, nativeCliRunner } = await configureCodexAliasCatalog({
      cwd,
      userConfig: path.join(cwd, '.codex'),
      sourceName: 'codex-scope-alias-source',
    });

    const installed = await installFixturePlugin(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'user',
    }, { env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const status = await statusCommandV8({
      plugins: ['team/demo'],
      cwd,
      env,
      cliVersion: '1.0.0',
      platform: 'codex',
      json: true,
      verbose: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/demo',
        state: 'ready',
        placements: expect.arrayContaining([expect.objectContaining({ scope: 'user', state: 'ready' })]),
      }),
    ]);
    await expect(statusCommandV8({
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
          state: 'blocked',
          placements: [expect.objectContaining({
            scope: 'project',
            reasons: expect.arrayContaining([
              expect.objectContaining({ code: 'codexScopePathAlias' }),
            ]),
          })],
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

  it('isolates user lifecycle planning from obsolete project config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'target-scoped-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'target-scoped', [], 'config\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'target-scoped', title: 'Target scoped', content: 'Target scoped.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', default: 'default' } } };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      logicalIdentity,
      pluginName: 'target-scoped',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'user' },
    });
    const legacyProjectPath = path.join(isolation.layout.fixtureCwd,
      '.agent-workflows/plugin-config/team/target-scoped/config.json');
    await fs.outputFile(legacyProjectPath, '{invalid');
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };

    await expect(installFixturePlugin(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readPluginConfigStore({ sourceId: source.id, sourceIdentity, pluginName: 'target-scoped',
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ state: 'ready', values: { mode: 'user' } });
    await expect(fs.readFile(legacyProjectPath, 'utf8')).resolves.toBe('{invalid');
    const reviewed = await reinstallWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, previewOperationPlan: true });
    expect(reviewed.operationPlan, JSON.stringify(reviewed)).toBeDefined();
    await fs.writeFile(legacyProjectPath, '{different invalid project config');
    await expect(reinstallWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
    })).resolves.toMatchObject({ overallState: 'succeeded' });
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

      const result = await installFixturePlugin(['team/demo'], {
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
    const installed = await installFixturePlugin(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'project',
    }, { env: initialEnv, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const aliasEnv = { ...initialEnv, CODEX_HOME: path.join(cwd, '.codex') };
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
        schemaVersion: 2,
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

    const result = await installFixturePlugin(['team/demo'], {
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
});
