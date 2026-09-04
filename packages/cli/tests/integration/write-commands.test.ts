import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';

import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  syncWriteCommand,
  uninstallWriteCommand,
} from '../../src/commands/write-commands.js';
import { syncCommand } from '../../src/commands/sync-command.js';
import {
  runRebuildCommand,
  setRebuildCommandTestHooksForTests,
  type RebuildCommandRuntime,
} from '../../src/commands/rebuild-command.js';
import {
  setStatusDependencyInspectionHookForTests,
  statusCommandV7,
  statusTargetActivation,
  statusTargetExtensions,
  statusTargetIntent,
  statusTargetSharedNative,
} from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type {
  CommandWizardPluginCandidate,
  CommandWizardSelection,
} from '../../src/commands/wizard.js';
import {
  OFFICIAL_CATALOG_SOURCE_SSH_URL,
  OFFICIAL_CATALOG_SOURCE_URL,
} from '../../src/constants.js';
import {
  createTuiControllerDependencies,
  setTuiControllerRuntimeTestHooksForTests,
} from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { userIssueKey } from '../../src/tui/controller.js';
import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { runCli } from '../../src/index.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
  git,
} from '../helpers/catalog-source-fixture.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
  resolveCatalogSourceRef,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import {
  setNativeCliRunnerOverrideForTests,
  type NativeCliInvocation,
} from '../../src/utils/native-cli.js';
import type {
  CatalogSource,
  CatalogSourceResolution,
  GeneratedArtifact,
  PluginMeta,
} from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import {
  createSharedOwnerToken,
  parseOwnedTextHeader,
  renderOwnedTextFile,
  SKILL_OWNER_MARKER,
  writeOwnedTextFile,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
  calculateCodexNativeRenderPayloadDigest,
} from '../../src/utils/catalog-digests.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import { CodexManagerError } from '../../src/utils/codex-manager.js';
import {
  readPluginIntentState,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexMarketplace,
} from '../../src/utils/codex-config.js';
import { renderTrackedHookGroupIdentity } from '../../src/utils/hooks-contract.js';
import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  type CodexNativeRenderReceipt,
} from '../../src/utils/codex-native-render-receipt.js';

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const result = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources.filter((entry) => entry.type === 'path')) {
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: options.env,
    }).catch(() => undefined);
  }
  return result;
}

async function configureCatalog(): Promise<ReturnType<typeof getCurrentSourceTestIsolation>> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'write-source');
  await createCatalogSnapshotFixture(root);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: root }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  return isolation;
}

async function snapshotRegularTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        pending.push(absolute);
      } else {
        snapshot[relative] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  }
  return snapshot;
}

function createCodexNativeTestRuntime(
  isolation: {
    env: NodeJS.ProcessEnv;
    layout: { fixtureCwd: string };
  },
  codexVersion = '0.200.0',
) {
  const installed = new Set<string>();
  const installedVersions = new Map<string, string>();
  const marketplaceRoots = new Map<string, string>();
  const userConfigPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    const args = invocation.args;
    if (args.includes('--version')) {
      return { exitCode: 0, stdout: `codex-cli ${codexVersion}`, stderr: '' };
    }
    const pluginIndex = args.indexOf('plugin');
    const pluginArgs = pluginIndex >= 0 ? args.slice(pluginIndex) : args;
    if (pluginArgs[1] === 'marketplace' && pluginArgs[2] === 'add') {
      const marketplaceRoot = pluginArgs[3]!;
      const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
        marketplaceName: string;
      };
      marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
      const current = await fs.readFile(userConfigPath, 'utf8').catch(() => '');
      if (!(await readCodexConfigFile(userConfigPath)).snapshot.marketplaces[config.marketplaceName]) {
        await fs.outputFile(userConfigPath, [
          current,
          `[marketplaces.${JSON.stringify(config.marketplaceName)}]`,
          `source = ${JSON.stringify(marketplaceRoot)}`,
          'source_type = "local"',
          '',
        ].filter(Boolean).join('\n'));
      }
    } else if (pluginArgs[1] === 'marketplace' && pluginArgs[2] === 'remove') {
      const marketplaceName = pluginArgs[3]!;
      marketplaceRoots.delete(marketplaceName);
      const current = await fs.readFile(userConfigPath, 'utf8').catch(() => '');
      await fs.outputFile(userConfigPath, removeCodexMarketplace(current, marketplaceName));
    } else if (pluginArgs[1] === 'add') {
      const pluginId = pluginArgs[2]!;
      const separator = pluginId.lastIndexOf('@');
      const pluginName = pluginId.slice(0, separator);
      const marketplaceName = pluginId.slice(separator + 1);
      installed.add(pluginId);
      const marketplacePluginRoot = path.join(
        marketplaceRoots.get(marketplaceName)!,
        'plugins',
        pluginName,
      );
      const pluginVersion = String((await fs.readJson(path.join(
        marketplacePluginRoot,
        '.agents-plugin',
        'plugin.json',
      ))).version);
      installedVersions.set(pluginId, pluginVersion);
      const cacheRoot = path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'cache',
        marketplaceName,
        pluginName,
        pluginVersion,
      );
      await fs.copy(
        marketplacePluginRoot,
        cacheRoot,
        { overwrite: true },
      );
      await applyCodexConfigTransactionFile(userConfigPath, {
        upsertPluginActivations: { [pluginId]: true },
      });
    } else if (pluginArgs[1] === 'remove') {
      const pluginId = pluginArgs[2]!;
      const separator = pluginId.lastIndexOf('@');
      installed.delete(pluginId);
      installedVersions.delete(pluginId);
      await fs.remove(path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'cache',
        pluginId.slice(separator + 1),
        pluginId.slice(0, separator),
      ));
      await applyCodexConfigTransactionFile(userConfigPath, {
        removePluginActivations: [pluginId],
      });
    }
    if (pluginArgs[1] === 'list' && pluginArgs.includes('--json')) {
      const [user, project] = await Promise.all([
        readCodexConfigFile(userConfigPath),
        readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
      ]);
      const invocationCwd = path.resolve(invocation.cwd ?? '.');
      const exact = invocationCwd === path.resolve(isolation.layout.fixtureCwd);
      const marketplaceName = pluginArgs[pluginArgs.indexOf('--marketplace') + 1];
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [...installed].filter((pluginId) =>
            pluginId.endsWith(`@${marketplaceName}`)).sort().map((pluginId) => ({
            pluginId,
            installed: true,
            enabled: user.snapshot.plugins[pluginId]?.enabled === true
              || (exact && project.snapshot.plugins[pluginId]?.enabled === true),
            version: installedVersions.get(pluginId) ?? '1.0.0',
          })),
          available: [],
        }),
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: pluginArgs[1] === 'list' ? [...installed].sort().join('\n') : '',
      stderr: '',
    };
  });
  return {
    env: isolation.env,
    nativeCliRunner,
    codexManagerResolver: vi.fn(async () => ({
      kind: 'system' as const,
      version: codexVersion,
      command: 'codex',
      argsPrefix: [] as string[],
    })),
    installed,
  };
}

async function writeStatusSystemCodexPackage(
  root: string,
  version: string,
): Promise<string> {
  const binRoot = process.platform === 'win32' ? root : path.join(root, 'bin');
  const packageRoot = process.platform === 'win32'
    ? path.join(binRoot, 'node_modules', '@openai', 'codex')
    : path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await Promise.all([
    fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex',
      version,
      bin: { codex: 'bin/codex.js' },
    }),
    fs.outputFile(launcher, '#!/usr/bin/env node\n'),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform === 'win32') {
    await fs.outputFile(path.join(binRoot, 'codex.CMD'), '@echo off\r\n');
  } else {
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
  }
  return binRoot;
}

async function writeIntentRoundTripCodexPackage(root: string): Promise<string> {
  const binRoot = process.platform === 'win32' ? root : path.join(root, 'bin');
  const packageRoot = process.platform === 'win32'
    ? path.join(binRoot, 'node_modules', '@openai', 'codex')
    : path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await Promise.all([
    fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex',
      version: '0.200.0',
      bin: { codex: 'bin/codex.js' },
    }),
    fs.outputFile(launcher, [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'if (args.includes("--version")) console.log("codex-cli 0.200.0");',
      'if (args[0] === "plugin" && args[1] === "list") console.log(JSON.stringify({ installed: [], available: [] }));',
    ].join('\n')),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform === 'win32') {
    await fs.outputFile(
      path.join(binRoot, 'codex.CMD'),
      '@node "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
  } else {
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
  }
  return binRoot;
}

async function runIntentRoundTripCliChild(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const packageRoot = getSourceTestRepositoryCwd();
  const child = spawn(process.execPath, [
    path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'vitest.intent-round-trip-child.config.ts',
    '--reporter=dot',
  ], {
    cwd: packageRoot,
    env: {
      ...env,
      AW_INTENT_CHILD_ARGV: JSON.stringify(argv),
      AW_INTENT_CHILD_CWD: cwd,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(code, `aw ${argv.join(' ')} child failed:\n${output}`).toBe(0);
}

async function createNativeDependencyCatalog(
  rootDir: string,
  plugins: Array<{
    name: string;
    dependencies?: string[];
    configureManifest?: (manifest: PluginMeta['manifest']) => void;
  }>,
): Promise<void> {
  const definitions = plugins.map((plugin) => ({
    ...plugin,
    configureManifest: (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
      manifest.extensions = undefined;
      plugin.configureManifest?.(manifest);
    },
  }));
  await createDependencyCatalogSnapshotFixture(rootDir, definitions);
  for (const plugin of plugins) {
    const skillRoot = path.join(rootDir, 'plugins', plugin.name, 'skills', `${plugin.name}-skill`);
    await Promise.all([
      fs.outputFile(
        path.join(skillRoot, 'SKILL.md'),
        `---\nname: ${plugin.name}-skill\ndescription: ${plugin.name} skill.\n---\n`,
      ),
      fs.outputFile(
        path.join(skillRoot, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
  }
  await createDependencyCatalogSnapshotFixture(rootDir, definitions);
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
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
    manifest.marketplace.policy.products = ['CODEX'];
    manifest.extensions = {
      instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.' }],
    };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
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
  counterRoot?: string;
}): Promise<void> {
  await fs.outputFile(path.join(options.pluginRoot, 'scripts', 'render.mjs'), [
    'import { readFile, writeFile } from "node:fs/promises";',
    `const counterRoot = ${options.counterRoot === undefined
      ? 'process.env.AW_HOME'
      : JSON.stringify(options.counterRoot)};`,
    'const counter = `${counterRoot}/render-count-${process.env.AW_PLUGIN_NAME}.txt`;',
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
      await expect(installWriteCommand(['team/normal', 'team/forced'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const intentLocation = {
        scope: 'project' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      await writePluginIntentState(intentLocation, {
        ...await readPluginIntentState(intentLocation),
        roots: [],
      });
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
      expect(forced).toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' })],
      });
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
      manifest.marketplace.policy.products = ['CODEX'];
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
    await syncCatalogSourceGeneration({
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
    await expect(syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(statusCommandV7({
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
      manifest.marketplace.policy.products = ['CODEX'];
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
      manifest.marketplace.policy.products = ['CODEX'];
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
    await expect(installWriteCommand(['official/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity, pluginName: 'demo', scope: 'project',
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

    const status = await statusCommandV7({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'official/demo', state: 'ready', reasons: [] }),
    ]);
    const captured = createCapturedCliIo();
    await expect(runCli([
      'config', 'set', 'official/demo', 'mode', '--value-json', '"ssh"', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).resolves.toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'succeeded', overallState: 'succeeded',
    });
    await expect(readPluginConfigStore({
      sourceId: 'official', sourceIdentity, pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'ssh' } });
    await expect(reinstallWriteCommand(['official/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
  });

  it('pins successful TUI source generations when another source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-session-good');
    const writeGoodSource = (version: string, field: string, content: string) =>
      createCatalogSnapshotFixture(sourceRoot, 'demo', [], `${content}\n`, (manifest) => {
        manifest.version = version;
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'session', title: 'Session', content }],
        };
        manifest.config = {
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
    await syncCatalogSourceGeneration({
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
    expect(goodProviderCalls).toBe(1);
    await vi.waitFor(() => {
      expect(missingProviderCalls).toBe(1);
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

    const status = await statusCommandV7({
      plugins: ['team/demo'],
      cwd,
      env,
      cliVersion: '1.0.0',
      platform: 'codex',
      json: true,
      verbose: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', scope: 'user', state: 'ready' }),
    ]);
    await expect(statusCommandV7({
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
          state: 'blocked',
          reasons: expect.arrayContaining([
            expect.objectContaining({ code: 'codexScopePathAlias' }),
          ]),
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

  it('isolates user lifecycle planning from project config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'target-scoped-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'target-scoped', [], 'config\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
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
    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      pluginName: 'target-scoped',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'user' },
    });
    await fs.outputFile(resolvePluginConfigStorePath({
      sourceId: source.id,
      pluginName: 'target-scoped',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    }), '{invalid');
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };

    await expect(installWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'stateInventoryFailed' })],
    });

    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      pluginName: 'target-scoped',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'project-before' },
    });
    const reviewed = await reinstallWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, previewOperationPlan: true });
    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      pluginName: 'target-scoped',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'project-after' },
    });
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
      config: { schemaVersion: 2, sources: [source] },
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

  it('materializes one native marketplace generation and one Codex post snapshot for a dependency group', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-source');
    const dependencyNames = ['leaf-a', 'leaf-b', 'leaf-c', 'leaf-d', 'leaf-e'];
    const pluginNames = [...dependencyNames, 'root'];
    const configureDynamicNative = (manifest: PluginMeta['manifest']) => {
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        states: ['present'],
        refreshKeys: [],
        skillKey: 'dynamic-skill',
      }] };
    };
    const definitions = [
      ...dependencyNames.map((name) => ({ name })),
      { name: 'root', dependencies: dependencyNames },
    ].map((definition) => ({ ...definition, configureManifest: configureDynamicNative }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    for (const pluginName of pluginNames) {
      await writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', pluginName),
        skillKey: 'dynamic-skill',
      });
    }
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
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
    const runtime = createCodexNativeTestRuntime(isolation);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'team/root',
      platform: 'codex',
      scope: 'project',
    } as const;
    const evidence = await dependencies.captureEvidence(intent);
    const lockedCallsStart = runtime.nativeCliRunner.mock.calls.length;
    const previewLists = runtime.nativeCliRunner.mock.calls.slice(0, lockedCallsStart).filter(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json');
    expect(previewLists).toHaveLength(2);
    const copy = vi.spyOn(fs, 'copy');
    const move = vi.spyOn(fs, 'move');
    const rename = vi.spyOn(fs, 'rename');
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    let catalogCopyGenerationCount = 0;
    let generationSwapCount = 0;
    let committedBackupCount = 0;
    try {
      result = await dependencies.executeIntent(intent, evidence) as Awaited<
        ReturnType<typeof installWriteCommand>
      >;
      catalogCopyGenerationCount = new Set(copy.mock.calls.flatMap(([, destination]) =>
        path.basename(path.dirname(String(destination))).startsWith('.team-staging-')
          ? [path.dirname(String(destination))]
          : [])).size;
      generationSwapCount = move.mock.calls.filter(([sourcePath, destination]) =>
        path.basename(String(sourcePath)).startsWith('.team-staging-')
        && path.resolve(String(destination)) === path.resolve(marketplaceRoot)).length;
      committedBackupCount = rename.mock.calls.filter(([sourcePath]) =>
        path.basename(String(sourcePath)).startsWith('team.backup-')).length;
    } finally {
      copy.mockRestore();
      move.mockRestore();
      rename.mockRestore();
    }

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(catalogCopyGenerationCount).toBe(1);
    expect(generationSwapCount).toBe(1);
    expect(committedBackupCount).toBe(1);
    const lockedCalls = runtime.nativeCliRunner.mock.calls.slice(lockedCallsStart);
    const jsonLists = lockedCalls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'list' && args.includes('--json');
    });
    const nonJsonLists = lockedCalls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'list' && !args.includes('--json');
    });
    expect(jsonLists.length, JSON.stringify(lockedCalls.map(([invocation]) => ({
      args: invocation.args,
      cwd: invocation.cwd,
    }))))
      .toBeLessThanOrEqual(4);
    expect(nonJsonLists).toHaveLength(0);
    expect(previewLists.length + jsonLists.length).toBeLessThanOrEqual(6);
    expect(runtime.installed).toEqual(new Set([
      ...dependencyNames.map((name) => `${name}@aw`),
      'root@aw',
    ]));
    for (const pluginName of pluginNames) {
      await expect(fs.readFile(path.join(
        marketplaceRoot,
        'plugins',
        pluginName,
        'skills',
        'dynamic-skill',
        'SKILL.md',
      ), 'utf8')).resolves.toContain('name: dynamic-skill');
    }
  }, 30_000);

  it('uses only one neutral Codex list per generation for public user-only writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-observation-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const listCalls = (calls: readonly [NativeCliInvocation, ...unknown[]][]) => calls.filter(
      ([invocation]) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        return args.join(' ') === 'plugin list --marketplace aw --json';
      },
    );
    const assertUserOnlyGenerations = (
      calls: readonly [NativeCliInvocation, ...unknown[]][],
      maximumLists: number,
    ) => {
      const lists = listCalls(calls);
      expect(lists.length, JSON.stringify(calls.map(([invocation]) => ({
        args: invocation.args,
        cwd: invocation.cwd,
      })))).toBeLessThanOrEqual(maximumLists);
      expect(lists.every(([invocation]) =>
        path.resolve(invocation.cwd ?? '.') !== path.resolve(isolation.layout.fixtureCwd))).toBe(true);
      let generationLists = 0;
      for (const [invocation] of calls) {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        const generationBoundary = invocation.args.includes('--version')
          || args[1] === 'add' || args[1] === 'remove'
          || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        if (generationBoundary) {
          expect(generationLists).toBeLessThanOrEqual(1);
          generationLists = 0;
        } else if (args.join(' ') === 'plugin list --marketplace aw --json') {
          generationLists += 1;
        }
      }
      expect(generationLists).toBeLessThanOrEqual(1);
    };

    const success = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(success.overallState, JSON.stringify(success)).toBe('succeeded');
    assertUserOnlyGenerations(runtime.nativeCliRunner.mock.calls, 2);

    runtime.nativeCliRunner.mockClear();
    const noOp = await syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(noOp.overallState, JSON.stringify(noOp)).toBe('succeeded');
    assertUserOnlyGenerations(runtime.nativeCliRunner.mock.calls, 2);

    const uncertainRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const result = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' && args[2] === 'demo@aw'
        ? { ...result, exitCode: 1, stderr: 'synthetic uncertain add' }
        : result;
    });
    const uncertain = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner: uncertainRunner });
    expect(uncertain.overallState, JSON.stringify({
      uncertain,
      calls: uncertainRunner.mock.calls.map(([invocation]) => invocation.args),
    })).not.toBe('succeeded');
    assertUserOnlyGenerations(uncertainRunner.mock.calls, 2);
  }, 30_000);

  it('keeps an earlier native success and the shared marketplace after a later group target fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-partial-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf-a' },
      { name: 'leaf-b' },
      { name: 'root', dependencies: ['leaf-a', 'leaf-b'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    let failLeafB = true;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (failLeafB && args[1] === 'add' && args[2] === 'leaf-b@aw') {
        return { exitCode: 1, stdout: '', stderr: 'leaf-b failed' };
      }
      return runtime.nativeCliRunner(invocation);
    });

    const partial = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(partial.overallState).toBe('partial');
    expect(partial.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf-a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf-b' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        state: 'failed',
        action: 'skipped',
      }),
    ]));
    expect(runtime.installed).toContain('leaf-a@aw');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
      sourceId: 'team',
      marketplaceName: 'aw',
    });
    await expect(fs.readFile(path.join(
      marketplaceRoot,
      'plugins',
      'leaf-b',
      'skills',
      'leaf-b-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toContain('name: leaf-b-skill');

    failLeafB = false;
    await expect(syncCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    expect(runtime.installed).toEqual(new Set(['leaf-a@aw', 'leaf-b@aw', 'root@aw']));
  }, 30_000);

  it('does not start native mutations when grouped marketplace staging fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-stage-failure-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const realCopy = fs.copy.bind(fs);
    const copy = vi.spyOn(fs, 'copy').mockImplementation(async (source, destination, options) => {
      if (path.basename(path.dirname(String(destination))).startsWith('.team-staging-')
        && path.basename(String(destination)) === 'plugins') {
        throw new Error('group staging failed');
      }
      return realCopy(source, destination, options);
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installWriteCommand(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
      }, runtime);
    } finally {
      copy.mockRestore();
    }

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
        message: expect.stringContaining('group staging failed'),
      }),
    ]));
    const nativeMutations = runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add'
        || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    });
    expect(nativeMutations).toEqual([]);
    expect(runtime.installed).toEqual(new Set());
  }, 30_000);

  it('blocks a reused project activation when its marketplace group fails staging', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-reuse-failure-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'a' },
      { name: 'b' },
      { name: 'root', dependencies: ['a', 'b'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/a'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const callsBeforeProjectInstall = runtime.nativeCliRunner.mock.calls.length;
    const realCopy = fs.copy.bind(fs);
    const copy = vi.spyOn(fs, 'copy').mockImplementation(async (source, destination, options) => {
      if (path.basename(path.dirname(String(destination))).startsWith('.team-staging-')
        && path.basename(String(destination)) === 'plugins') {
        throw new Error('reuse group staging failed');
      }
      return realCopy(source, destination, options);
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installWriteCommand(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
        dependencyScopeOverrides: [{
          pluginId: 'team/a', platform: 'codex', scope: 'project',
        }],
      }, runtime);
    } finally {
      copy.mockRestore();
    }

    expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/a', action: 'reuse' }),
    ]));
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        state: 'failed',
        message: expect.stringContaining('reuse group staging failed'),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b' }),
        state: 'failed',
      }),
    ]));
    const projectConfig = await readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    );
    expect(projectConfig.snapshot.plugins['a@aw']).toBeUndefined();
    const projectMutations = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeProjectInstall)
      .filter(([invocation]) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        return args[1] === 'add'
          || args[1] === 'remove'
          || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
      });
    expect(projectMutations).toEqual([]);
  }, 30_000);

  it('attributes a shared activation post snapshot failure only to the missing plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-post-attribution-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'a' }, { name: 'b' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (args[1] !== 'list' || !args.includes('--json')) return response;
      const projectConfig = await readCodexConfigFile(
        path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      );
      if (projectConfig.snapshot.plugins['b@aw']?.enabled !== true) return response;
      const payload = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string }> };
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          installed: payload.installed.filter((entry) => entry.pluginId !== 'b@aw'),
        }),
      };
    });

    const result = await installWriteCommand(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe('partial');
    expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/a', action: 'reuse' }),
      expect.objectContaining({ pluginId: 'team/b', action: 'reuse' }),
    ]));
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b' }),
        state: 'failed',
        errorCode: 'codexActivationPostcheckFailed',
      }),
    ]));
  }, 30_000);

  it('keeps the executed consumer action when its dependency fails the grouped postcheck', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'late-dependency-postcheck-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (args[1] !== 'list' || !args.includes('--json') || !runtime.installed.has('root@aw')) {
        return response;
      }
      const payload = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string }> };
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          installed: payload.installed.filter((entry) => entry.pluginId !== 'leaf@aw'),
        }),
      };
    });

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'install',
        state: 'failed',
        errorCode: 'dependencyInstallFailed',
        recoveryActions: expect.arrayContaining([
          'run aw sync --all --platform codex --scope project',
        ]),
      }),
    ]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', result);
    expect(receipt.overallState).toBe('partial');
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'install',
        state: 'failed',
        errorCode: 'dependencyInstallFailed',
        recoveryActions: expect.arrayContaining([
          'run aw sync --all --platform codex --scope project',
        ]),
      }),
    ]));
    for (const target of receipt.targetResults.filter((entry) =>
      entry.target.pluginId === 'team/leaf' || entry.target.pluginId === 'team/root')) {
      expect(target.actions.map((action) => action.name)).not.toContain('postApply');
    }
  }, 30_000);

  it('persists direct dependency placement overrides and upserts root scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-upsert-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const claudeMarketplaceRoots = new Map<string, string>();
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async (invocation: NativeCliInvocation) => {
        if (invocation.command === 'claude'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'marketplace'
          && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          claudeMarketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            extraKnownMarketplaces: {
              ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
              [config.marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
            },
          });
          const knownPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins', 'known_marketplaces.json');
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(knownPath, {
            ...known,
            [config.marketplaceName]: {
              source: { source: 'directory', path: marketplaceRoot },
              installLocation: marketplaceRoot,
            },
          });
        }
        if (invocation.command === 'claude'
          && invocation.args[0] === 'plugin'
          && invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            enabledPlugins: {
              ...((settings.enabledPlugins ?? {}) as Record<string, unknown>),
              [pluginId]: true,
            },
          });
          const installedPath = path.join(
            isolation.env.AW_CLAUDE_HOME!, 'plugins', 'installed_plugins.json',
          );
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          await fs.outputJson(installedPath, {
            plugins: {
              ...(installed.plugins ?? {}),
              [pluginId]: [{ name: pluginName, scope: 'user', version: '1.0.0' }],
            },
          });
          await fs.ensureDir(path.join(claudeMarketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
        return { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' };
      },
    };
    const project = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime);
    expect(project.overallState, JSON.stringify(project.rebuildResults)).toBe('succeeded');
    expect(project.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user' }),
    ]));
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/root', platforms: ['codex'] }],
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    });

    const user = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(user.overallState, JSON.stringify(user.rebuildResults)).toBe('succeeded');
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });
    await expect(readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'team/root', platforms: ['codex'] }] });

    const claude = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'claude',
      scope: 'user',
    }, runtime);
    expect(claude.overallState, JSON.stringify(claude.rebuildResults)).toBe('succeeded');
    expect(claude.codexReconcilePlans).toBeUndefined();
    await expect(readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/root', platforms: ['claude', 'codex'] }],
    });
    await expect(fs.readFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
      'utf8',
    )).resolves.toMatch(/(?:root|leaf)\./u);

    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.pluginId !== 'team/root' || identity.scope !== 'project') return;
        throw new Error('injected requested ensure-new failure');
      },
    });
    const failedRequestedMove = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    setRebuildCommandTestHooksForTests(undefined);
    expect(failedRequestedMove.overallState).toBe('failed');
    await expect(fs.readFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
      'utf8',
    )).resolves.toContain('root.');

    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.pluginId !== 'team/leaf' || identity.scope !== 'project') return;
        await expect(fs.readFile(
          path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
          'utf8',
        )).resolves.toContain('leaf.');
        throw new Error('injected dependency ensure-new failure');
      },
    });
    const failedMove = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);
    setRebuildCommandTestHooksForTests(undefined);
    expect(failedMove.overallState).toBe('failed');
    await expect(fs.readFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
      'utf8',
    )).resolves.toMatch(/root\.[\s\S]*leaf\.|leaf\.[\s\S]*root\./u);
    await expect(readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/root', platforms: ['claude'] }],
    });
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/root', platforms: ['codex'] }],
    });
    const movedCodex = await syncCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime);
    expect(movedCodex.overallState, JSON.stringify(movedCodex.rebuildResults)).toBe('succeeded');
    expect(movedCodex.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', preservedScope: 'user',
    }));
    expect(movedCodex.rebuildResults).not.toContainEqual(expect.objectContaining({
      command: 'cleanup', target: expect.objectContaining({ scope: 'user' }),
    }));
    const movedCodexReceipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('sync', movedCodex);
    expect(movedCodexReceipt.recoveryActions).toEqual(expect.arrayContaining([
      'run aw cleanup team/leaf --platform codex --scope user',
      'then run aw sync --all --platform codex --scope project',
    ]));
    await expect(fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      'utf8',
    )).resolves.toContain('root.');
    await expect(fs.readFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
      'utf8',
    )).resolves.toMatch(/root\.[\s\S]*leaf\.|leaf\.[\s\S]*root\./u);
    const claudeSettings = await fs.readJson(
      path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json'),
    ) as { enabledPlugins?: Record<string, boolean> };
    expect(claudeSettings.enabledPlugins?.['root@aw']).toBe(true);

    await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'claude',
      scope: 'user',
    }, runtime);
    await expect(readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'team/root', platforms: ['codex'] }] });
  });

  it('repairs missing project output through public sync without changing desired roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'public-sync-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intentBefore = await readPluginIntentState(intentLocation);
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await fs.remove(configPath);

    await expect(syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    await expect(readPluginIntentState(intentLocation)).resolves.toEqual(intentBefore);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');

    await fs.remove(configPath);
    const publicOutput = createCapturedCliIo();
    await expect(runCli([
      'sync', '--all', '--platform', 'codex', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: publicOutput.io,
      interactive: false,
    })).resolves.toBe(0);
    expect(JSON.parse(publicOutput.readStdout())).toMatchObject({
      command: 'sync',
      ok: true,
      overallState: 'succeeded',
    });
    await expect(readPluginIntentState(intentLocation)).resolves.toEqual(intentBefore);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');
  });

  it('restores a fresh clone from committed project intent through public sync --all', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.rootDir, 'clone-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const nativeSkill = path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-native');
    await Promise.all([
      fs.outputFile(
        path.join(nativeSkill, 'SKILL.md'),
        '---\nname: demo-native\ndescription: Demo native Skill.\n---\n',
      ),
      fs.outputFile(
        path.join(nativeSkill, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);

    const seedRoot = path.join(isolation.layout.fixtureCwd, 'clone-recovery-seed');
    const cloneRoot = path.join(isolation.layout.fixtureCwd, 'clone-recovery-checkout');
    await fs.ensureDir(seedRoot);
    await git(seedRoot, ['init']);
    await git(seedRoot, ['config', 'user.name', 'AW Test']);
    await git(seedRoot, ['config', 'user.email', 'aw-test@example.invalid']);
    const intent = {
      schemaVersion: 1 as const,
      kind: 'aw-plugin-intents' as const,
      roots: [{ pluginId: 'team/demo', platforms: ['codex' as const] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: ['demo@aw'] },
    };
    await writePluginIntentState({
      scope: 'project', cwd: seedRoot, env: isolation.env,
    }, intent);
    await git(seedRoot, ['add', '.agent-workflows/plugin-intents.json']);
    await git(seedRoot, ['commit', '-m', 'Add shared project intent']);
    await git(isolation.layout.fixtureCwd, ['clone', seedRoot, cloneRoot]);
    expect(await git(cloneRoot, ['ls-files'])).toBe('.agent-workflows/plugin-intents.json');

    const cloneEnv = {
      ...isolation.env,
      AW_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-aw-home'),
      AW_CODEX_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-codex-home'),
      AW_CLAUDE_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-claude-home'),
    };
    for (const home of [cloneEnv.AW_HOME, cloneEnv.AW_CODEX_HOME, cloneEnv.AW_CLAUDE_HOME]) {
      await expect(fs.pathExists(home)).resolves.toBe(false);
    }
    const sourceConfig = await readCatalogSourcesConfigSnapshot(cloneEnv);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceConfig.digest,
      env: cloneEnv,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: cloneEnv,
    });
    const intentPath = path.join(cloneRoot, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    const runtime = createCodexNativeTestRuntime({
      env: cloneEnv,
      layout: { fixtureCwd: cloneRoot },
    }, '0.151.0');

    const result = await syncCommand([], {
      cwd: cloneRoot,
      env: cloneEnv,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
      yes: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(runtime.installed.has('demo@aw')).toBe(true);
    await expect(fs.readFile(path.join(
      cloneEnv.AW_CODEX_HOME,
      'plugins', 'cache', 'aw', 'demo', '1.0.0', 'skills', 'demo-native', 'SKILL.md',
    ), 'utf8')).resolves.toContain('name: demo-native');
    const projectConfigPath = path.join(cloneRoot, '.codex', 'config.toml');
    const projectConfig = await readCodexConfigFile(projectConfigPath);
    expect(projectConfig.snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(Object.keys(projectConfig.snapshot.developerInstructions.managedBlocks)).toHaveLength(1);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(path.join(cloneRoot, '.agents', 'skills'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex', 'hooks.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex', 'apps'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex-plugin'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.mcp.json'))).resolves.toBe(false);
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.not.toContain('mcp_servers');
  }, 30_000);

  it('previews the repository schema 2 project intent from an isolated self-hosting fixture', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const repositoryIntentPath = path.join(
      repositoryRoot,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const fixtureIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const intentBytes = await fs.readFile(repositoryIntentPath);
    await fs.outputFile(fixtureIntentPath, intentBytes);
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'self-hosting-intent-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'aw-plugin-development' }]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'official',
      cliVersion: '1.0.0',
      env: isolation.env,
      impactConfirmed: true,
    });

    const status = await statusCommandV7({
      plugins: ['official/aw-plugin-development'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    });
    const target = status.payload.targets.find((entry) =>
      entry.pluginId === 'official/aw-plugin-development' && entry.platform === 'codex');
    expect(target).toBeDefined();
    expect(statusTargetIntent(target!)).toEqual({
      enabled: true,
      scopes: ['project'],
      relation: 'root',
    });

    const preview = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
    }, {
      env: isolation.env,
      previewOperationPlan: true,
    });

    expect(preview.overallState, JSON.stringify(preview)).toBe('succeeded');
    expect(preview.operationPlan).toBeDefined();
    await expect(fs.readFile(fixtureIntentPath)).resolves.toEqual(intentBytes);
    await expect(fs.pathExists(path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'config.toml',
    ))).resolves.toBe(false);
  });

  it('keeps project native activation when user uninstall disables its overlapping root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-activation-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const projectInstalled = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);
    expect(projectInstalled.overallState, JSON.stringify(projectInstalled.rebuildResults))
      .toBe('succeeded');
    const userInstalled = await installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(userInstalled.overallState, JSON.stringify(userInstalled.rebuildResults))
      .toBe('succeeded');

    const stalePostcheckRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args.includes('list') && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [...runtime.installed].map((pluginId) => ({
              pluginId, installed: true, enabled: true, version: '1.0.0',
            })),
            available: [],
          }),
          stderr: '',
        };
      }
      return runtime.nativeCliRunner(invocation);
    });
    const failedUninstall = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner: stalePostcheckRunner });
    expect(failedUninstall.overallState).toBe('failed');
    await applyCodexConfigTransactionFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
      { upsertPluginActivations: { 'leaf@aw': true } },
    );
    const uninstalled = await syncCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime);
    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    expect(uninstalled.codexReconcilePlans?.[0]).toMatchObject({
      activationActions: {
        user: expect.arrayContaining([
          expect.objectContaining({ codexPluginId: 'leaf@aw', action: 'disable' }),
        ]),
        project: expect.arrayContaining([
          expect.objectContaining({ codexPluginId: 'leaf@aw', action: 'none' }),
        ]),
      },
      staleActivationRemovals: [],
    });
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(false);
    expect(projectConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(runtime.installed.has('leaf@aw')).toBe(true);

    const removedProject = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(removedProject.overallState, JSON.stringify(removedProject.rebuildResults)).toBe('succeeded');
    expect(removedProject.rebuildResults.map((result) => result.target.pluginName))
      .toEqual(['root']);
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });
    const [userAfter, projectAfter] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userAfter.snapshot.plugins['leaf@aw']?.enabled).toBe(false);
    expect(projectAfter.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(runtime.installed.has('leaf@aw')).toBe(true);

    const movedToUser = await installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(movedToUser.overallState, JSON.stringify(movedToUser.rebuildResults)).toBe('succeeded');
    const movedToProject = await installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(movedToProject.overallState, JSON.stringify(movedToProject.rebuildResults)).toBe('succeeded');
    expect(movedToProject.dependencyPlan?.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/leaf', action: 'reinstall', state: 'partial', resolvedScope: 'project',
      }),
    ]);
    const [userMovedProject, projectMovedProject] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userMovedProject.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectMovedProject.snapshot.plugins['leaf@aw']?.enabled).toBe(true);

    const movedBackToUser = await installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(movedBackToUser.overallState, JSON.stringify(movedBackToUser.rebuildResults)).toBe('succeeded');
    expect(movedBackToUser.dependencyPlan?.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user' }),
    ]);
    const [userMovedBack, projectMovedBack] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userMovedBack.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectMovedBack.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(runtime.installed.has('leaf@aw')).toBe(true);
  });

  it('blocks install and status when both Codex registration lists are unreadable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unreadable-registration-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0
        ? invocation.args.slice(pluginIndex)
        : invocation.args;
      if (pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
        return { exitCode: 0, stdout: '{invalid', stderr: '' };
      }
      return runtime.nativeCliRunner(invocation);
    });

    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner });

    expect(installed.overallState).toBe('failed');
    expect(installed.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'codexSharedNativeCorrupt' }),
    ]);
    const mutationCalls = nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    });
    expect(mutationCalls).toEqual([]);

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'unreadable-registration-prefix'),
      '0.151.0',
    );
    setNativeCliRunnerOverrideForTests(nativeCliRunner);
    let status;
    try {
      status = await statusCommandV7({
        plugins: ['team/demo'],
        cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: binRoot },
        cliVersion: '1.0.0',
        platform: 'codex',
        scope: 'user',
        json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ state: 'blocked' }),
    ]);
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toMatchObject({
      state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable',
    });
  }, 30_000);

  it.each([
    ['reuse', 'ENOENT', 'codexNativeObservationUnavailable'],
    ['reuse', 'absent', 'codexNativeExpectedInstalled'],
    ['none', 'invalid output', 'codexNativeObservationFailed'],
  ] as const)(
    'blocks a mixed Codex %s extension write when the late observation has %s',
    async (sharedAction, failure, errorCode) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `late-${sharedAction}-observation-source`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            instructions: [{
              name: 'late-gate', title: 'Late gate', content: 'Late observation gate.',
            }],
          };
        },
      }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = createCodexNativeTestRuntime(isolation);
      await expect(installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const targetConfigPath = sharedAction === 'none'
        ? path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const installedPluginId = [...runtime.installed][0]!;
      const marketplaceName = installedPluginId.slice(installedPluginId.lastIndexOf('@') + 1);
      const nativePayloadRoot = path.join(
        isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo', '1.0.0',
      );
      const [marketplaceBefore, nativePayloadBefore] = await Promise.all([
        snapshotRegularTree(marketplaceRoot),
        snapshotRegularTree(nativePayloadRoot),
      ]);
      const targetConfigBefore = await fs.readFile(targetConfigPath, 'utf8').catch(() => undefined);
      let rejectObservation = false;
      let callsAtTargetBuild = 0;
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const pluginArgs = pluginIndex >= 0
          ? invocation.args.slice(pluginIndex)
          : invocation.args;
        if (rejectObservation && pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
          if (failure === 'ENOENT') {
            throw Object.assign(new Error('Codex unavailable'), { code: 'ENOENT' });
          }
          if (failure === 'absent') {
            return { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' };
          }
          return { exitCode: 0, stdout: '{invalid', stderr: '' };
        }
        return runtime.nativeCliRunner(invocation);
      });
      const observationSession = await createCodexNativeObservationSession({
        exactCwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        runner: nativeCliRunner,
      });
      setRebuildCommandTestHooksForTests({
        afterTargetBuilt: async ({ identity }) => {
          if (identity.pluginId !== 'team/demo') return;
          callsAtTargetBuild = nativeCliRunner.mock.calls.length;
          rejectObservation = true;
          observationSession.invalidate('aw');
        },
      });
      let result: Awaited<ReturnType<typeof syncCommand>>;
      try {
        result = sharedAction === 'reuse'
          ? await installWriteCommand(['team/demo'], {
            cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
            }, { ...runtime, nativeCliRunner, codexObservationSession: observationSession })
          : await uninstallWriteCommand(['team/demo'], {
              cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
            }, { ...runtime, nativeCliRunner, codexObservationSession: observationSession });
      } finally {
        setRebuildCommandTestHooksForTests(undefined);
        await observationSession.dispose();
      }

      expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toContainEqual(
        expect.objectContaining({ action: sharedAction }),
      );
      expect(result.targetResults).toContainEqual(expect.objectContaining({
        state: 'failed', errorCode: sharedAction === 'none' ? 'writeFailed' : errorCode,
      }));
      expect(await fs.readFile(targetConfigPath, 'utf8').catch(() => undefined))
        .toBe(targetConfigBefore);
      await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
      await expect(snapshotRegularTree(nativePayloadRoot)).resolves.toEqual(nativePayloadBefore);
      expect(runtime.installed).toEqual(new Set([installedPluginId]));
      if (failure === 'absent') {
        await expect(readPluginIntentState({
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
        });
      }
      const mutationCalls = nativeCliRunner.mock.calls.slice(callsAtTargetBuild)
        .filter(([invocation]) => {
          const pluginIndex = invocation.args.indexOf('plugin');
          const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
          return args[1] === 'add' || args[1] === 'remove'
            || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        });
      expect(mutationCalls).toEqual([]);
    },
    30_000,
  );

  it('reports a late activation observation failure after the mutation and preserves shared native', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-only-late-gate-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { postApply: { path: './scripts/postApply.mjs' } };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'postApply.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/activation-late-post-apply-count.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const postApplyCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-late-post-apply-count.txt',
    );
    await expect(fs.readFile(postApplyCounter, 'utf8')).resolves.toBe('1');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const installedPluginId = [...runtime.installed][0]!;
    const marketplaceName = installedPluginId.slice(installedPluginId.lastIndexOf('@') + 1);
    const nativePayloadRoot = path.join(
      isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo', '1.0.0',
    );
    const userConfigPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const [marketplaceBefore, payloadBefore, userConfigBefore, projectConfigBefore] = await Promise.all([
      snapshotRegularTree(marketplaceRoot),
      snapshotRegularTree(nativePayloadRoot),
      fs.readFile(userConfigPath, 'utf8'),
      fs.readFile(projectConfigPath, 'utf8').catch(() => undefined),
    ]);
    let rejectObservation = false;
    const postApplyEvents: string[] = [];
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (rejectObservation && pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
        throw Object.assign(new Error('private native failure'), { code: 'ENOENT' });
      }
      return runtime.nativeCliRunner(invocation);
    });
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.pluginId === 'team/demo' && identity.scope === 'project') {
          rejectObservation = true;
        }
      },
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, {
        ...runtime,
        nativeCliRunner,
        reporter: {
          event: (event) => {
            if (event.type === 'rebuild:action' && event.data?.name === 'postApply') {
              postApplyEvents.push(event.data.phase);
            }
          },
          notice: () => {},
        },
      });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }

    expect(result.targetResults).toContainEqual(expect.objectContaining({
      state: 'failed', errorCode: 'codexActivationPostcheckFailed',
    }));
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    await expect(fs.readFile(userConfigPath, 'utf8')).resolves.toBe(userConfigBefore);
    expect(projectConfigBefore).toBeUndefined();
    await expect(fs.readFile(projectConfigPath, 'utf8'))
      .resolves.toContain('enabled = true');
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(snapshotRegularTree(nativePayloadRoot)).resolves.toEqual(payloadBefore);
    expect(runtime.installed).toEqual(new Set([installedPluginId]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', result);
    expect(receipt).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexActivationPostcheckFailed',
        recoveryActions: expect.arrayContaining(['run sync']),
      })],
    });
    expect(receipt.targetResults[0]?.actions.map((action) => action.name))
      .not.toContain('postApply');
    await expect(fs.readFile(postApplyCounter, 'utf8')).resolves.toBe('1');
    expect(postApplyEvents).toEqual([]);
  }, 30_000);

  it('allows an observed mixed Codex reuse target to write its project extension', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'observed-reuse-extension-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'late-gate', title: 'Late gate', content: 'Observed reuse.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const result = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toContainEqual(
      expect.objectContaining({ action: 'reuse' }),
    );
    await expect(fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      'utf8',
    )).resolves.toContain('Observed reuse.');
  }, 30_000);

  it.each([
    ['absent', 'partial', 'codexNativeInstallIncomplete'],
    ['duplicate', 'partial', 'codexNativeObservationFailed'],
    ['installed-disabled', 'succeeded', undefined],
    ['exact-installed-neutral-absent', 'partial', 'codexNativeInstallIncomplete'],
  ] as const)('handles Codex install when the official postcheck is %s', async (
    postcheck,
    expectedState,
    error,
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-postcheck-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    let addObserved = false;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      const result = await runtime.nativeCliRunner(invocation);
      if (pluginArgs[1] === 'add') addObserved = true;
      if (addObserved && pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
        const entry = {
          pluginId: 'demo@aw', installed: true, enabled: true, version: '1.0.0',
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: postcheck === 'exact-installed-neutral-absent'
              ? invocation.cwd === isolation.layout.fixtureCwd ? [entry] : []
              : postcheck === 'duplicate' ? [entry, entry]
                : postcheck === 'installed-disabled' ? [{ ...entry, enabled: false }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return result;
    });

    const result = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe(expectedState);
    if (error) {
      expect(result.targetResults).toEqual([
        expect.objectContaining({
          state: 'failed',
          message: expect.stringContaining(error),
        }),
      ]);
    }
    expect(addObserved).toBe(true);
  }, 30_000);

  it.each([
    ['unobserved', 'partial', 'move'],
    ['failed', 'error', 'block'],
  ] as const)(
    'keeps a %s Codex dependency observation distinct in planner readiness',
    async (observation, state, action) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `dependency-${observation}-source`);
      await createNativeDependencyCatalog(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = createCodexNativeTestRuntime(isolation);
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const pluginArgs = pluginIndex >= 0
          ? invocation.args.slice(pluginIndex)
          : invocation.args;
        if (pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
          if (observation === 'unobserved') {
            throw Object.assign(new Error('Codex unavailable'), { code: 'ENOENT' });
          }
          return { exitCode: 1, stdout: '', stderr: 'list failed' };
        }
        return runtime.nativeCliRunner(invocation);
      });

      const result = await installWriteCommand(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { ...runtime, nativeCliRunner, previewOperationPlan: true });
      const dependency = result.dependencyPlan?.targets.find((target) =>
        target.pluginId === 'team/leaf');

      if (observation === 'failed') {
        expect(result).toMatchObject({
          overallState: 'failed',
          targetResults: [expect.objectContaining({
            state: 'failed',
            errorCode: 'codexSharedNativeCorrupt',
          })],
        });
        expect(dependency).toBeUndefined();
      } else {
        expect(dependency).toMatchObject({ relation: 'dependency', state, action });
      }
      expect(nativeCliRunner.mock.calls.every(([invocation]) =>
        invocation.args.includes('--version')
        || invocation.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
    },
  );

  it('ignores private Codex payload drift during status and sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-payload-drift-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const payloadReadme = path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins', 'cache', 'aw', 'demo', '1.0.0', 'README.md',
    );
    const reviewed = await syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, { ...runtime, previewOperationPlan: true });
    const nativeCallsBeforeStaleCheck = runtime.nativeCliRunner.mock.calls.length;
    const stale = await syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
      reviewPreflight: async () => fs.outputFile(payloadReadme, 'tampered payload\n'),
    });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ state: 'completed' }),
    ]);
    const staleInspectionCalls = runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeStaleCheck);
    expect(staleInspectionCalls).not.toEqual([]);
    expect(staleInspectionCalls.some(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);
    expect(staleInspectionCalls.some(([invocation]) => {
      const args = invocation.args.slice(invocation.args.indexOf('plugin'));
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toBe(false);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    const callsBeforeStatus = runtime.nativeCliRunner.mock.calls.length;
    const status = await statusCommandV7({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    expect(status.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexSharedNativeUnobserved', severity: 'warning' }),
      ]),
    })]);
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toEqual({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    expect(runtime.nativeCliRunner).toHaveBeenCalledTimes(callsBeforeStatus);

    const blockedOutput = createCapturedCliIo();
    const nativeCallsBeforeBlocked = runtime.nativeCliRunner.mock.calls.length;
    expect(await runCli([
      'sync', 'team/demo', '--platform', 'codex', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: blockedOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    })).toBe(0);
    expect(JSON.parse(blockedOutput.readStdout())).toMatchObject({
      receiptSchemaVersion: 6,
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        state: 'completed',
        relation: 'requested',
        target: expect.objectContaining({ scope: 'user' }),
      })],
      recoveryActions: [],
    });
    expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeBlocked)
      .some(([invocation]) => invocation.args.includes('remove'))).toBe(false);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    const repairedOutput = createCapturedCliIo();
    const nativeCallsBeforeRepair = runtime.nativeCliRunner.mock.calls.length;
    const repairedExit = await runCli([
      'sync', 'team/demo', '--platform', 'codex', '--scope', 'user', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: repairedOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    });
    expect(repairedExit, repairedOutput.readStdout()).toBe(0);
    expect(JSON.parse(repairedOutput.readStdout())).toMatchObject({
      receiptSchemaVersion: 6,
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        state: 'completed',
        target: expect.objectContaining({ pluginId: 'team/demo', scope: 'user' }),
      })],
      recoveryActions: [],
    });
    const repairNativeActions = runtime.nativeCliRunner.mock.calls
      .slice(nativeCallsBeforeRepair)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(repairNativeActions).not.toContain('plugin remove demo@aw');
    expect(repairNativeActions).not.toContain('plugin add demo@aw');
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    await fs.remove(payloadReadme);
    await expect(statusCommandV7({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'needsSync' })] },
    });
    const deletedRepairPlan = await syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, { ...runtime, previewOperationPlan: true });
    expect(deletedRepairPlan.codexReconcilePlans).toEqual([
      expect.objectContaining({
        sharedNativeActions: [expect.objectContaining({ action: 'reuse' })],
        review: expect.objectContaining({ requiresConfirmation: false }),
      }),
    ]);
    await expect(fs.pathExists(payloadReadme)).resolves.toBe(false);

    const externalPayload = path.join(isolation.layout.fixtureCwd, 'foreign-payload.txt');
    const payloadLink = path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins', 'cache', 'aw', 'demo', '1.0.0', 'foreign-link',
    );
    await fs.outputFile(externalPayload, 'foreign\n');
    await fs.symlink(externalPayload, payloadLink);
    const foreignStatus = await statusCommandV7({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    expect(foreignStatus.payload.targets).toEqual([
      expect.objectContaining({ state: 'needsSync' }),
    ]);
    expect(statusTargetSharedNative(foreignStatus.payload.targets[0]!)).toEqual({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    const foreignOutput = createCapturedCliIo();
    expect(await runCli([
      'sync', 'team/demo', '--platform', 'codex', '--scope', 'user', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: foreignOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    })).toBe(0);
    expect(JSON.parse(foreignOutput.readStdout())).toMatchObject({
      targetResults: [expect.objectContaining({
        state: 'completed',
      })],
    });
    await expect(fs.readFile(externalPayload, 'utf8')).resolves.toBe('foreign\n');
    await expect(fs.lstat(payloadLink)).resolves.toMatchObject({});
  });

  it('installs over cache-only Codex residue with add and no remove or cache deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-install-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cacheRoot = path.join(
      isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
    );
    const runtime = createCodexNativeTestRuntime(isolation);
    const first = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(first.overallState, JSON.stringify(first.rebuildResults)).toBe('succeeded');
    runtime.installed.clear();
    const sentinel = path.join(cacheRoot, 'metadata.json');
    await fs.outputFile(sentinel, '{"cacheOnly":true}\n');
    const callsBeforeCacheOnlyInstall = runtime.nativeCliRunner.mock.calls.length;

    const result = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const calls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeCacheOnlyInstall)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(calls).toContain('plugin add demo@aw');
    expect(calls).not.toContain('plugin remove demo@aw');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{"cacheOnly":true}\n');
  });

  it('adds a cache-only user dependency for a project consumer without removing its cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    runtime.installed.delete('leaf@aw');
    const sentinel = path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins', 'cache', 'aw', 'leaf', '1.0.0', 'metadata.json',
    );
    await fs.outputFile(sentinel, '{"cacheOnly":true}\n');
    const callsBeforeInstall = runtime.nativeCliRunner.mock.calls.length;

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf',
        resolvedScope: 'user',
        assignmentSource: 'default',
        state: 'absent',
        action: 'install',
      }),
    ]));
    const calls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeInstall)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(calls).toContain('plugin add leaf@aw');
    expect(calls).not.toContain('plugin remove leaf@aw');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{"cacheOnly":true}\n');
  });

  it('projects fixed-point dependency scope overrides per platform in status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      schemaVersion: 1,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/root', platforms: ['claude', 'codex'] }],
      dependencyScopeOverrides: [
        { pluginId: 'team/middle', platform: 'claude', scope: 'user' },
        { pluginId: 'team/middle', platform: 'codex', scope: 'user' },
      ],
      managed: { codexPluginIds: [] },
    });

    const status = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', json: true,
    });
    const enabled = status.payload.targets.filter((target) => statusTargetIntent(target).enabled);
    for (const platform of ['codex', 'claude'] as const) {
      for (const [pluginId, scopes, relation] of [
        ['team/root', ['project'], 'root'],
        ['team/middle', ['user'], 'dependency'],
        ['team/leaf', ['user'], 'dependency'],
      ] as const) {
        const target = enabled.find((entry) => entry.pluginId === pluginId
          && entry.platform === platform);
        expect(target).toBeDefined();
        expect(statusTargetIntent(target!)).toEqual({ enabled: true, scopes, relation });
      }
    }
  });

  it('keeps a project-only pure-native dependency in project scope after install', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-native-dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'install',
    }));

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'project-native-dependency-prefix'),
      '0.151.0',
    );
    const status = await statusCommandV7({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: binRoot }, nativeCliRunner: runtime.nativeCliRunner,
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    const root = status.payload.targets.find((target) => target.pluginId === 'team/root');
    expect(root, JSON.stringify(status.payload.targets)).toMatchObject({
      state: 'ready',
      components: expect.arrayContaining([expect.objectContaining({
        kind: 'dependency', key: 'team/leaf', state: 'ready',
        metadata: expect.objectContaining({ scope: 'project', project: 'current' }),
      })]),
    });
    expect(statusTargetIntent(root!)).toEqual({
      enabled: true, scopes: ['project'], relation: 'root',
    });
    expect(statusTargetActivation(root!)).toMatchObject({ project: true, user: false });

    const synced = await syncCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'keep',
    }));
  }, 30_000);

  it('preserves user actual when a project dependency is reassigned to project scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-user-to-project-source');
    await createNativeDependencyCatalog(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{
              name: 'preserved-role',
              description: 'Preserved role.',
              prompt: 'Keep this role in both scopes until explicit cleanup.',
            }],
          };
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'user',
      }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userAgentPath = path.join(
      isolation.env.AW_CODEX_HOME!,
      'agents',
      'aw-leaf-preserved-role.toml',
    );
    const userAgentBeforeReassignment = await fs.readFile(userAgentPath, 'utf8');
    expect(parseOwnedTextHeader(userAgentBeforeReassignment)?.identity).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'user',
    });
    const callsBeforeReassignment = runtime.nativeCliRunner.mock.calls.length;

    const reassigned = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);

    expect(reassigned.overallState, JSON.stringify(reassigned.rebuildResults)).toBe('succeeded');
    expect(reassigned.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'reinstall',
      preservedScope: 'user',
    }));
    expect(reassigned.rebuildResults).not.toContainEqual(expect.objectContaining({
      command: 'cleanup',
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
    }));
    expect(reassigned.codexReconcilePlans?.[0]).toMatchObject({
      desiredTargets: expect.arrayContaining([
        { pluginId: 'team/leaf', scopes: ['project', 'user'] },
      ]),
      activationActions: {
        user: expect.arrayContaining([expect.objectContaining({
          pluginId: 'team/leaf', action: 'none', desired: true,
        })]),
        project: expect.arrayContaining([expect.objectContaining({
          pluginId: 'team/leaf', desired: true,
        })]),
      },
    });
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    const nativeCalls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeReassignment)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(nativeCalls).not.toContain('plugin remove leaf@aw');
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-preserved-role.toml',
    );
    await expect(fs.readFile(userAgentPath, 'utf8')).resolves.toBe(userAgentBeforeReassignment);
    expect(parseOwnedTextHeader(await fs.readFile(userAgentPath, 'utf8'))?.identity)
      .toMatchObject({ pluginId: 'team/leaf', platform: 'codex', scope: 'user' });
    const projectAgent = await fs.readFile(projectAgentPath, 'utf8');
    expect(projectAgent).toContain('Keep this role in both scopes until explicit cleanup.');
    expect(parseOwnedTextHeader(projectAgent)?.identity).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'project',
    });
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/root', platforms: ['codex'] }],
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    });

    const status = await statusCommandV7({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      nativeCliRunner: runtime.nativeCliRunner,
    });
    const root = status.payload.targets.find((target) => target.pluginId === 'team/root');
    expect(root, JSON.stringify(status.payload.targets)).toMatchObject({
      state: 'needsSync',
      components: expect.arrayContaining([expect.objectContaining({
        kind: 'dependency', key: 'team/leaf', state: 'incomplete',
        metadata: expect.objectContaining({ scope: 'project', project: 'current' }),
      })]),
      recoveryActions: [{
        command: 'cleanup',
        scope: 'user',
        description: '运行 aw cleanup team/leaf --platform codex --scope user，再运行 aw sync --all --platform codex --scope project。',
      }],
    });

    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', reassigned);
    expect(receipt).toMatchObject({
      recoveryActions: [
        'run aw cleanup team/leaf --platform codex --scope user',
        'then run aw sync --all --platform codex --scope project',
      ],
      targetResults: expect.arrayContaining([expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'project' }),
        relation: 'dependency',
        recoveryActions: [
          'run aw cleanup team/leaf --platform codex --scope user',
          'then run aw sync --all --platform codex --scope project',
        ],
      })]),
    });
  }, 30_000);

  it('adds a second pure-native Codex scope without removing the first scope intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'pure-native-second-scope-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const secondScope = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(secondScope.overallState, JSON.stringify(secondScope.rebuildResults)).toBe('succeeded');
    expect(secondScope.codexReconcilePlans?.[0]).toMatchObject({
      desiredTargets: [{ pluginId: 'team/demo', scopes: ['project', 'user'] }],
      sharedNativeActions: [expect.objectContaining({ action: 'reuse' })],
    });
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', secondScope);
    expect(receipt.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({
        pluginId: 'team/demo', platform: 'codex', scope: 'project',
      }),
      sharedNative: { codexPluginId: 'demo@aw', action: 'reuse' },
    }));
    for (const scope of ['user', 'project'] as const) {
      await expect(readPluginIntentState({
        scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({
        roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      });
    }
    const nativeCalls = runtime.nativeCliRunner.mock.calls.map(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(nativeCalls.filter((call) => call === 'plugin add demo@aw')).toHaveLength(1);
    expect(nativeCalls).not.toContain('plugin remove demo@aw');
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'pure-native-second-scope-prefix'),
      '0.151.0',
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    let status;
    try {
      status = await statusCommandV7({
        plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: binRoot },
        cliVersion: '1.0.0', platform: 'codex', json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
    expect(status.payload.targets[0], JSON.stringify(status.payload.targets[0]))
      .toMatchObject({ state: 'ready' });
    expect(statusTargetIntent(status.payload.targets[0]!)).toEqual({
      enabled: true, scopes: ['project', 'user'], relation: 'root',
    });
  });

  it('keeps pure-native intent visible when status only observes cache residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dual-native-status-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      schemaVersion: 1,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: ['demo@aw'] },
    });
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { upsertPluginActivations: { 'demo@aw': true } },
    );

    const status = await statusCommandV7({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', state: 'needsSync' }),
    ]);
    expect(statusTargetIntent(status.payload.targets[0]!)).toEqual({
      enabled: true, scopes: ['project', 'user'], relation: 'root',
    });
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toMatchObject({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    expect(statusTargetSharedNative(status.payload.targets[0]!)).not.toHaveProperty(
      'staleCacheObserved',
    );
    expect(statusTargetActivation(status.payload.targets[0]!)).toMatchObject({
      user: true, project: true,
    });
  });

  it('does not upgrade cache residue to registration when PATH is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-assumed-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      removePluginActivations: ['demo@aw'],
    });
    const forbiddenRunner = vi.fn(async () => {
      throw new Error('assumed activation-only sync must not invoke Codex');
    });

    const synced = await syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, {
      env: { ...isolation.env, PATH: '' },
      nativeCliRunner: forbiddenRunner,
    });

    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('failed');
    expect(synced.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'codexSharedNativeCorrupt' }),
    ]);
    await expect(readCodexConfigFile(projectConfigPath)).resolves.toMatchObject({
      snapshot: { plugins: {} },
    });
    expect(installedRuntime.installed.has('demo@aw')).toBe(true);
  }, 30_000);

  it('repairs public activation and runs postApply when official enabled stays false', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-post-apply-failure-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { postApply: { path: './scripts/postApply.mjs' } };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'postApply.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/activation-post-apply-count.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const counterPath = path.join(isolation.env.AW_HOME!, 'activation-post-apply-count.txt');
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('1');
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { removePluginActivations: ['demo@aw-team'] },
    );
    const contradictoryOfficialList = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
        && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{ pluginId: 'demo@aw', installed: true, enabled: false, version: '1.0.0' }],
            available: [],
          }),
          stderr: '',
        };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });
    const synced = await syncCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, { ...installedRuntime, nativeCliRunner: contradictoryOfficialList });
    expect(synced.overallState, JSON.stringify(synced, null, 2)).toBe('succeeded');
    expect(synced.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
        state: 'completed',
      }),
    ]);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('sync', synced);
    expect(receipt).toMatchObject({
      ok: true,
      overallState: 'succeeded',
      targetResults: [{
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
        state: 'completed',
        actions: expect.any(Array),
      }],
    });
    expect(receipt.targetResults[0]?.actions.map((action) => action.name))
      .toContain('postApply');
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('2');
  }, 30_000);

  it('ignores per-plugin official enabled mismatches after public activation repair', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-isolation-source');
    const definitions = ['alpha', 'beta'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { postApply: { path: './scripts/postApply.mjs' } };
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all(definitions.map(({ name }) => fs.outputFile(
      path.join(sourceRoot, 'plugins', name, 'scripts', 'postApply.mjs'),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        `const counter = \`${'${process.env.AW_HOME}'}/activation-isolation-${name}.txt\`;`,
        'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
        'await writeFile(counter, String(previous + 1));',
      ].join('\n'),
    )));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = createCodexNativeTestRuntime(isolation);
    const selectors = ['team/alpha', 'team/beta'];
    await expect(installWriteCommand(selectors, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const alphaCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-isolation-alpha.txt',
    );
    const betaCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-isolation-beta.txt',
    );
    await expect(fs.readFile(alphaCounter, 'utf8')).resolves.toBe('1');
    await expect(fs.readFile(betaCounter, 'utf8')).resolves.toBe('1');
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { removePluginActivations: ['alpha@aw'] },
    );
    const contradictoryOfficialList = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
        && invocation.args.includes('--json')) {
        const exactProject = invocation.cwd === isolation.layout.fixtureCwd;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'alpha@aw', installed: true,
                enabled: false, version: '1.0.0',
              },
              {
                pluginId: 'beta@aw', installed: true,
                enabled: exactProject, version: '1.0.0',
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });

    const synced = await syncCommand(selectors, {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, { ...installedRuntime, nativeCliRunner: contradictoryOfficialList });

    expect(synced.overallState, JSON.stringify(synced, null, 2)).toBe('succeeded');
    expect(synced.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/beta' }),
        state: 'completed',
      }),
    ]));
    expect(synced.rebuildResults.find((entry) => entry.target.pluginId === 'team/alpha')
      ?.actions).toContainEqual({ name: 'postApply', status: 'succeeded' });
    expect(synced.rebuildResults.find((entry) => entry.target.pluginId === 'team/beta')
      ?.actions).toContainEqual({ name: 'postApply', status: 'succeeded' });
    await expect(fs.readFile(alphaCounter, 'utf8')).resolves.toBe('2');
    await expect(fs.readFile(betaCounter, 'utf8')).resolves.toBe('2');
  }, 30_000);

  it('completes Codex activation and postApply when an unrelated Claude target fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-platform-post-apply-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.skills = './skills';
        manifest.scripts = { postApply: { path: './scripts/postApply.mjs' } };
      },
    }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill.\n---\n',
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
      fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'postApply.mjs'), [
        'import { writeFile } from "node:fs/promises";',
        'let input = "";',
        'for await (const chunk of process.stdin) input += chunk;',
        'const context = JSON.parse(input);',
        'await writeFile(`${process.env.AW_HOME}/post-apply-${context.target.platform}.txt`, "1");',
      ].join('\n')),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codexRuntime = createCodexNativeTestRuntime(isolation);
    const postApplyPath = path.join(isolation.env.AW_HOME!, 'post-apply-codex.txt');
    const postApplyEvents: Array<{ phase: string; outputExists: boolean }> = [];
    const reporter: NonNullable<RebuildCommandRuntime['reporter']> = {
      event: async (event) => {
        if (event.type !== 'rebuild:action'
          || event.source.platform !== 'codex'
          || event.data?.name !== 'postApply') return;
        postApplyEvents.push({
          phase: event.data.phase,
          outputExists: await fs.pathExists(postApplyPath),
        });
      },
      notice: () => {},
    };
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) =>
      invocation.command === 'claude' && invocation.args.includes('--version')
        ? { exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }
        : codexRuntime.nativeCliRunner(invocation));
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.platform === 'claude') throw new Error('injected Claude target failure');
      },
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'both', scope: 'project',
      }, { ...codexRuntime, nativeCliRunner, reporter });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }

    expect(result.overallState, JSON.stringify(result)).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ platform: 'codex' }), state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ platform: 'claude' }), state: 'failed',
      }),
    ]));
    const codexResult = result.rebuildResults.find((entry) => entry.target.platform === 'codex');
    expect(codexResult?.actions).toContainEqual({ name: 'postApply', status: 'succeeded' });
    await expect(readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    )).resolves.toMatchObject({ snapshot: { plugins: { 'demo@aw': { enabled: true } } } });
    await expect(fs.readFile(postApplyPath, 'utf8')).resolves.toBe('1');
    expect(postApplyEvents).toEqual([
      { phase: 'start', outputExists: false },
      { phase: 'success', outputExists: true },
    ]);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'post-apply-claude.txt'),
    )).resolves.toBe(false);
  }, 30_000);

  it('includes a non-deferred postApply failure once in the JSON receipt warnings', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'claude-post-apply-warning-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
      manifest.scripts = { postApply: { path: './scripts/postApply.mjs' } };
    });
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'postApply.mjs'),
      'throw new Error("ordinary postApply failed");\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
      manifest.scripts = { postApply: { path: './scripts/postApply.mjs' } };
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
    const output = createCapturedCliIo();
    const marketplaceRoots = new Map<string, string>();
    const nativeCliRunner = async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const settingsPath = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
        const pluginsRoot = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins');
        const knownPath = path.join(pluginsRoot, 'known_marketplaces.json');
        const installedPath = path.join(pluginsRoot, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          await fs.outputJson(settingsPath, {
            extraKnownMarketplaces: {
              [config.marketplaceName]: {
                source: { source: 'directory', path: marketplaceRoot },
              },
            },
          });
          await fs.outputJson(knownPath, {
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
            enabledPlugins: { [pluginId]: true },
          });
          await fs.outputJson(installedPath, {
            plugins: { [pluginId]: [{ name: pluginName, scope: 'user', version: '1.0.0' }] },
          });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
      }
      return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
    };

    const exitCode = await runCli([
      'install', 'team/demo', '--platform', 'claude', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
      nativeCliRunner,
    });

    expect(exitCode, output.readStdout()).toBe(0);
    const receipt = JSON.parse(output.readStdout()) as {
      overallState: string;
      warnings: string[];
      targetResults: Array<{ state: string }>;
    };
    expect(receipt.overallState).toBe('succeeded');
    expect(receipt.targetResults).toEqual([
      expect.objectContaining({ state: 'completed' }),
    ]);
    expect(receipt.warnings).toHaveLength(1);
    expect(receipt.warnings[0]).toContain('ordinary postApply failed');
  }, 30_000);

  it('reports observed registration through the read-only system Codex list', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-trust-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'status-system-prefix'),
      '0.151.0',
    );
    const statusRunner = vi.fn(installedRuntime.nativeCliRunner);
    setNativeCliRunnerOverrideForTests(statusRunner);
    let status;
    try {
      status = await statusCommandV7({
        plugins: ['team/demo'],
        cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: binRoot },
        cliVersion: '1.0.0',
        platform: 'codex',
        scope: 'project',
        json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(status.payload.targets).toEqual([
      expect.objectContaining({ state: 'ready' }),
    ]);
    expect(statusTargetActivation(status.payload.targets[0]!)).toMatchObject({
      user: false,
      project: true,
      effective: true,
      evidence: 'observed',
      systemConsumer: {
        state: 'compatible',
        detectedVersion: '0.151.0',
        requiredMinVersion: '0.151.0',
      },
    });
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toMatchObject({
      state: 'usable', version: '1.0.0',
    });
    expect(statusRunner).toHaveBeenCalledTimes(2);
    expect(statusRunner.mock.calls.every(([invocation]) =>
      invocation.command === 'codex'
      && invocation.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
  }, 30_000);

  it('installs a supported target without parsing an unrelated future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-install-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'root' },
      { name: 'future', requiredCapabilities: ['aw.future-feature.v3'] },
    ]);
    const futureRoot = path.join(sourceRoot, 'plugins', 'future');
    const futureManifestPath = path.join(futureRoot, '.agents-plugin', 'plugin.json');
    const futureManifest = await fs.readJson(futureManifestPath);
    futureManifest.schemaVersion = 99;
    await fs.writeJson(futureManifestPath, futureManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const futureEntry = catalogManifest.entries.find((entry: { name: string }) =>
      entry.name === 'future');
    futureEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(futureRoot);
    futureEntry.manifestDigest = calculateCatalogEntryManifestDigest(futureManifest);
    futureEntry.contentDigest = await calculateCatalogEntryContentDigest(futureRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
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
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual(['team/root']);
  });

  it('lists supported and future entries in status and TUI without parsing the future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-status-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf', 'future'] },
      { name: 'future', requiredCapabilities: ['aw.future-feature.v3'] },
    ]);
    const futureRoot = path.join(sourceRoot, 'plugins', 'future');
    const futureManifestPath = path.join(futureRoot, '.agents-plugin', 'plugin.json');
    const futureManifest = await fs.readJson(futureManifestPath);
    futureManifest.schemaVersion = 99;
    await fs.writeJson(futureManifestPath, futureManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const futureEntry = catalogManifest.entries.find((entry: { name: string }) =>
      entry.name === 'future');
    futureEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(futureRoot);
    futureEntry.manifestDigest = calculateCatalogEntryManifestDigest(futureManifest);
    futureEntry.contentDigest = await calculateCatalogEntryContentDigest(futureRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const status = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      json: true,
    });
    expect(status.payload.catalog.sources).toEqual([
      expect.not.objectContaining({ error: expect.anything() }),
    ]);
    expect(status.pluginSummaries.map((entry) => entry.pluginId).sort()).toEqual([
      'team/future',
      'team/leaf',
      'team/root',
    ]);
    expect(status.pluginSummaries.find((entry) => entry.pluginId === 'team/future'))
      .toMatchObject({ missingCapabilities: ['aw.future-feature.v3'] });
    expect(status.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/future',
        state: 'blocked',
        reasons: [expect.objectContaining({ code: 'awCapabilityUnsupported' })],
      }),
    ]));

    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    })));
    await controller.load();
    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.viewModel?.plugins.map((entry) => entry.pluginId).sort()).toEqual([
      'team/future',
      'team/leaf',
      'team/root',
    ]);
    expect(controller.snapshot.viewModel?.plugins.find((entry) => entry.pluginId === 'team/future'))
      .toMatchObject({ aggregateStatus: 'unavailable', missingCapabilities: ['aw.future-feature.v3'] });
    expect(controller.snapshot.viewModel?.plugins.find((entry) => entry.pluginId === 'team/root'))
      .toMatchObject({ dependencySummary: { directCount: 2, totalCount: 2 } });
    expect(controller.snapshot.viewModel?.dependencyOverviews.find((entry) =>
      entry.pluginId === 'team/root')?.dependencies.find((entry) =>
        entry.pluginId === 'team/future')).toMatchObject({ aggregateStatus: 'unavailable' });
    for (let attempt = 0; attempt < 100
      && ['notChecked', 'checking'].includes(controller.getCatalogFreshness('team')?.state ?? 'notChecked');
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(controller.getCatalogFreshness('team')?.state).toBe('current');
    controller.dispose();
  });

  it('reports an unsupported direct dependency as a stable dependency root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'future-live-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const leafRoot = path.join(sourceRoot, 'plugins', 'leaf');
    const leafManifestPath = path.join(leafRoot, '.agents-plugin', 'plugin.json');
    const leafManifest = await fs.readJson(leafManifestPath);
    leafManifest.requires.aw.capabilities.push('aw.future-feature.v3');
    await fs.writeJson(leafManifestPath, leafManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const leafEntry = catalogManifest.entries.find((entry: { name: string }) => entry.name === 'leaf');
    leafEntry.requires = leafManifest.requires;
    leafEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(leafRoot);
    leafEntry.manifestDigest = calculateCatalogEntryManifestDigest(leafManifest);
    leafEntry.contentDigest = await calculateCatalogEntryContentDigest(leafRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    await expect(statusCommandV7({
      plugins: ['team/root'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        pluginId: 'team/root',
        components: expect.arrayContaining([expect.objectContaining({
          kind: 'dependency',
          key: 'team/leaf',
          state: 'error',
          metadata: expect.objectContaining({
            rootIssueId: 'awCapabilityUnsupported:team/leaf',
            rootIssueCode: 'awCapabilityUnsupported',
          }),
        })]),
        reasons: [expect.objectContaining({
          code: 'awCapabilityUnsupported',
          dependencyPluginId: 'team/leaf',
          rootIssueId: 'awCapabilityUnsupported:team/leaf',
          rootIssueCode: 'awCapabilityUnsupported',
        })],
      })] },
    });
  });

  it('fails a selected dependency closure with the exact unsupported plugin and capabilities', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unsupported-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', requiredCapabilities: ['aw.future-feature.v3'] },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
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

    expect(result.overallState).toBe('failed');
    expect(JSON.stringify(result)).toContain('team/leaf');
    expect(JSON.stringify(result)).toContain('aw.future-feature.v3');
    expect(JSON.stringify(result)).toContain('awCapabilityUnsupported');
  });

  it('reuses current-project inventory without historical consumer scans', async () => {
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
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const inventoryReads: Array<boolean> = [];
    const readInventory: typeof inventoryCatalogSourceReferences = async (options) => {
      inventoryReads.push(options.cwd === isolation.layout.fixtureCwd);
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
    expect(inventoryReads).toEqual([true]);

    inventoryReads.length = 0;
    const cleaned = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(inventoryReads).toEqual([true]);

    const reinstalled = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');
    inventoryReads.length = 0;
    const upgraded = await syncCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, runtime);
    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(inventoryReads).toEqual([true, true]);

    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    expect(inventoryReads).toEqual([true]);
  });

  it('keeps a present user transitive dependency when installing its project consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-dependency-keep-source');
    const configurePostApply = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        postApply: { path: './scripts/postApply.mjs' },
      };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configurePostApply },
      { name: 'middle', dependencies: ['leaf'], configureManifest: configurePostApply },
      { name: 'root', dependencies: ['middle'], configureManifest: (manifest: PluginMeta['manifest']) => {
        configurePostApply(manifest);
      } },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const postApplyScript = [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const context = JSON.parse(await new Promise((resolve) => { let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => resolve(data)); }));',
      'const counter = `${process.env.AW_HOME}/post-apply-count-${context.plugin.name}.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'leaf', 'scripts', 'postApply.mjs'), postApplyScript);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'middle', 'scripts', 'postApply.mjs'), postApplyScript);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'root', 'scripts', 'postApply.mjs'), postApplyScript);
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
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
    const leafStatus = await statusCommandV7({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    const leafUserTarget = leafStatus.payload.targets[0];
    expect(leafUserTarget?.state, JSON.stringify(leafUserTarget)).toBe('ready');

    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(installed.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/middle', resolvedScope: 'project' }),
    ]));
    expect(installed.rebuildResults.find((result) => result.target.pluginId === 'team/leaf')?.actions)
      .toContainEqual({ name: 'postApply', status: 'succeeded' });
    expect(installed.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
        action: 'keep', state: 'completed',
      }),
    ]));
    const installedStatus = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    const leafTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/leaf');
    const rootTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/root');
    const middleTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/middle');
    expect(leafTarget).toMatchObject({
      scope: 'user',
      state: 'ready',
    });
    expect(statusTargetIntent(leafTarget!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'root',
    });
    expect(leafTarget?.components).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'activation', key: 'project', state: 'enabled' }),
    ]));
    expect(leafTarget?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'codexActivationDrift' }),
    ]));
    expect(rootTarget).toMatchObject({ scope: 'project' });
    expect(middleTarget).toMatchObject({ scope: 'project', state: 'ready' });
    expect(installedStatus.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'dependencyMissing' })]),
    );
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    const issues = controller.listUserIssues();
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'dependencyMissing',
        rootEntity: expect.objectContaining({ pluginId: 'team/leaf', scope: 'project' }),
      }),
    ]));
    expect(issues.flatMap((issue) => issue.actions)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }),
    ]));
    const repeated = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(repeated.overallState, JSON.stringify(repeated.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'post-apply-count-leaf.txt'), 'utf8'))
      .resolves.toBe('3');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'post-apply-count-middle.txt'), 'utf8'))
      .resolves.toBe('2');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'post-apply-count-root.txt'), 'utf8'))
      .resolves.toBe('2');
  });

  it('reuses a user native dependency through a project transitive consumer in status and TUI', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-cross-scope-status-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'agent-content-toolkit' },
      { name: 'aw-plugin-development', dependencies: ['agent-content-toolkit'] },
      { name: 'aw-catalog-development', dependencies: ['aw-plugin-development'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['official/agent-content-toolkit'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const installed = await installWriteCommand(['official/aw-catalog-development'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/agent-content-toolkit', resolvedScope: 'user',
        assignmentSource: 'existingWiderTarget', action: 'keep',
      }),
    ]));
    await expect(readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'official/agent-content-toolkit', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'official/aw-catalog-development', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'native-cross-scope-status-prefix'),
      '0.151.0',
    );
    const statusEnv = { ...isolation.env, PATH: binRoot };
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    let status;
    let issues: ReturnType<TuiController['listUserIssues']>;
    let controller: TuiController | undefined;
    try {
      status = await statusCommandV7({
        cwd: isolation.layout.fixtureCwd, env: statusEnv,
        cliVersion: '1.0.0', platform: 'codex', json: true,
      });
      controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: statusEnv,
        nativeCliRunner: runtime.nativeCliRunner,
        interactive: false,
      })));
      await controller.load();
      issues = controller.listUserIssues();
    } finally {
      controller?.dispose();
      setNativeCliRunnerOverrideForTests(null);
    }
    const toolkit = status.payload.targets.find((target) =>
      target.pluginId === 'official/agent-content-toolkit');
    expect(toolkit, JSON.stringify(toolkit)).toMatchObject({ scope: 'user', state: 'ready' });
    expect(statusTargetIntent(toolkit!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'root',
    });
    expect(status.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'dependencyMissing' }),
        expect.objectContaining({ code: 'codexActivationDrift' }),
      ]),
    );

    expect(issues.flatMap((issue) => issue.actions)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'official/agent-content-toolkit', scope: 'project',
      })]),
    );
  });

  it('repairs a missing user extension in an installed native dependency during project sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-dependency-extension-repair-source');
    await createNativeDependencyCatalog(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'leaf-role', description: 'Leaf role.', prompt: 'Use leaf.' }],
          };
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['official/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installWriteCommand(['official/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const agentPath = path.join(isolation.env.AW_CODEX_HOME!, 'agents', 'aw-leaf-leaf-role.toml');
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    await fs.remove(agentPath);

    const repaired = await syncCommand(['official/root'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime);

    expect(repaired.overallState, JSON.stringify(repaired.rebuildResults)).toBe('succeeded');
    expect(repaired.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/leaf', resolvedScope: 'user', action: 'move', state: 'partial',
      }),
    ]));
    expect(repaired.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'official/leaf', scope: 'user' }),
        action: 'reinstall', state: 'completed',
      }),
    ]));
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
  }, 30_000);

  it('moves an existing project dependency to the user fixed-point placement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-user-promotion-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.toContain('leaf.');

    const promoted = await installWriteCommand(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(promoted.overallState, JSON.stringify(promoted.rebuildResults)).toBe('succeeded');
    expect(promoted.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf', resolvedScope: 'user',
        assignmentSource: 'consumerPromotion', action: 'move',
      }),
    ]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', promoted);
    const leafTargets = receipt.targetResults.filter((target) =>
      target.target.pluginId === 'team/leaf');
    expect(leafTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'user' }),
        relation: 'dependency', requiredBy: ['team/user-root'],
      }),
      expect.objectContaining({
        target: expect.objectContaining({ scope: 'project' }),
        action: 'cleanup', relation: 'dependency', requiredBy: ['team/user-root'],
      }),
    ]));
    expect(leafTargets.find((target) => target.target.scope === 'project'))
      .not.toHaveProperty('sharedNative');
    await expect(fs.readFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
      'utf8',
    )).resolves.toContain('leaf.');
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.not.toContain('leaf.');
    const status = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    const leaf = status.payload.targets.find((target) => target.pluginId === 'team/leaf');
    expect(leaf).toMatchObject({ scope: 'user', state: 'ready' });
    expect(statusTargetIntent(leaf!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'dependency',
    });
    expect(status.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'dependencyScopeConflict' })]),
    );
  });

  it('repairs a partial user dependency before removing its project placement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(
      isolation.layout.fixtureCwd,
      'partial-dependency-user-promotion-source',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            ...manifest.extensions,
            agents: [{
              name: 'leaf-role',
              description: 'Leaf role.',
              prompt: 'Use the leaf role.',
            }],
          };
        },
      },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const projectInstall = await installWriteCommand(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(projectInstall.overallState, JSON.stringify(projectInstall.rebuildResults))
      .toBe('succeeded');
    const sourceIdentity = projectInstall.rebuildResults.find((result) =>
      result.target.pluginId === 'team/leaf')!.target.sourceIdentity!;
    const userAgentPath = path.join(
      isolation.env.AW_CODEX_HOME!,
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    await writeOwnedTextFile({
      path: userAgentPath,
      allowedRoot: isolation.env.AW_CODEX_HOME!,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/leaf',
        plugin: 'leaf',
        artifactKey: 'aw-leaf-leaf-role',
        platform: 'codex',
        scope: 'user',
      },
      content: 'name = "partial leaf role"\n',
    });
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(true);

    const promoted = await installWriteCommand(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(promoted.overallState, JSON.stringify(promoted.rebuildResults)).toBe('succeeded');
    expect(promoted.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf', resolvedScope: 'user', state: 'partial',
        assignmentSource: 'consumerPromotion', action: 'move',
      }),
    ]));
    await expect(fs.readFile(userAgentPath, 'utf8')).resolves.toContain('Leaf role.');
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(false);
    await expect(fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      'utf8',
    )).resolves.not.toContain('leaf.');
    const status = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    expect(status.payload.targets.find((target) => target.pluginId === 'team/leaf'))
      .toMatchObject({ scope: 'user', state: 'ready' });

    const repeated = await syncWriteCommand(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(repeated.overallState, JSON.stringify(repeated.rebuildResults)).toBe('succeeded');
    expect(repeated.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user', action: 'keep' }),
    ]));
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(false);
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
            fields: { mode: { type: 'string', default: 'safe' } },
          };
        },
      },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
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
      'config', 'set', 'team/root', 'mode', '--value-json', '"fast"', '--scope', 'project', '--apply', '--json',
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
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/root' }),
          action: 'reinstall',
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/leaf' }),
          action: 'keep',
          state: 'completed',
        }),
      ]),
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
        schemaVersion: 2,
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
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'prepared-renderer-counts');
    await fs.ensureDir(counterRoot);
    const configure = (skillKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey,
        }],
      };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configure('leaf-skill') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-skill') },
    ]);
    await Promise.all([
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'),
        skillKey: 'leaf-skill',
        counterRoot,
      }),
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'root'),
        skillKey: 'root-skill',
        counterRoot,
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configure('leaf-skill') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-skill') },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    await expect(fs.readFile(path.join(counterRoot, 'render-count-leaf.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.readFile(path.join(counterRoot, 'render-count-root.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(syncWriteCommand(['team/root'], {
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
      await expect(fs.readFile(path.join(counterRoot, `render-count-${pluginName}.txt`), 'utf8'))
        .resolves.toBe('3');
    }
  });

  it('rejects a reviewed postApply target after a save-only effective config change', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reviewed-config-stale-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await Promise.all([
      fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
        'console.log(JSON.stringify({ version: 2, artifacts: [{',
        '  id: "instruction", kind: "instruction", platform: "codex",',
        '  target: "codex.developerInstructionsBlock", state: "present",',
        '  refreshKeys: [], content: "reviewed output"',
        '}] }));',
      ].join('\n')),
      fs.outputFile(path.join(pluginRoot, 'scripts', 'postApply.mjs'), [
        'import { writeFile } from "node:fs/promises";',
        'await writeFile(`${process.env.AW_HOME}/post-apply-ran.txt`, "ran\\n");',
      ].join('\n')),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          mode: { type: 'string', default: 'safe' },
        },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        postApply: { path: './scripts/postApply.mjs' },
      };
      manifest.artifacts = {
        targets: [{
          id: 'instruction', platform: 'codex', scopes: ['project'],
          target: 'codex.developerInstructionsBlock', states: ['present'],
          refreshKeys: [], requiresCodexProjectConfig: true,
        }],
      };
      manifest.marketplace.policy.products = ['CODEX'];
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));
    const runtime = { env: isolation.env, nativeCliRunner };
    const reviewed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, previewOperationPlan: true });

    expect(reviewed.operationPlan?.evidence.configDigests).toEqual([{
      pluginId: 'team/demo',
      scope: 'project',
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    }]);
    const configWrite = createCapturedCliIo();
    expect(await runCli([
      'config', 'set', 'team/demo', 'mode', '--value-json', '"strict"', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: configWrite.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(0);
    expect(JSON.parse(configWrite.readStdout())).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
    });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intentBeforeExecution = await readPluginIntentState(intentLocation);
    const nativeCallsBeforeExecution = nativeCliRunner.mock.calls.length;

    const stale = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
    });

    expect(stale.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
    ]);
    await expect(readPluginIntentState(intentLocation)).resolves.toEqual(intentBeforeExecution);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ values: { mode: 'strict' } });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'post-apply-ran.txt')))
      .resolves.toBe(false);
    const nativeWriteCalls = nativeCliRunner.mock.calls.slice(nativeCallsBeforeExecution)
      .filter(([invocation]) => invocation.args.some((arg) =>
        arg === 'add' || arg === 'remove'));
    expect(nativeWriteCalls).toEqual([]);
  });

  it('previews and cleans selected live ownership without running the current Active renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-offline-renderer-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-offline-renderer-counts');
    await fs.ensureDir(counterRoot);
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['user'],
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'demo-skill',
        }],
      };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await writeDynamicSkillRenderer({ pluginRoot, skillKey: 'demo-skill', counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    await writeDynamicSkillRenderer({ pluginRoot, skillKey: 'demo-skill', fail: true, counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const rendererCount = path.join(counterRoot, 'render-count-demo.txt');
    const skillRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'demo-skill');

    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, { ...runtime, previewOperationPlan: true });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);

    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writePluginIntentState(intentLocation, {
      ...await readPluginIntentState(intentLocation),
      roots: [],
    });
    const alreadyClean = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('cleanup', alreadyClean);

    expect(alreadyClean.overallState, JSON.stringify(alreadyClean.rebuildResults)).toBe('succeeded');
    expect(receipt).toMatchObject({ command: 'cleanup', overallState: 'succeeded' });
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
  }, 30_000);

  it('cleans a user target without reading or changing a damaged project Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-damaged-intent-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['user'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'demo-skill',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await writeDynamicSkillRenderer({ pluginRoot, skillKey: 'demo-skill' });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'demo-skill');
    const userIntentPath = path.join(isolation.env.AW_HOME!, 'plugin-intents.json');
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json',
    );
    const userIntentBefore = await fs.readFile(userIntentPath);
    await fs.outputFile(projectIntentPath, '{invalid project Intent\n');
    const projectIntentBefore = await fs.readFile(projectIntentPath);
    await fs.remove(sourceRoot);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.readFile(userIntentPath)).resolves.toEqual(userIntentBefore);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
  });

  it('cleans a selected dependency without reading installed edges, providers, or renderers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-installed-edge-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-installed-edge-counts');
    await fs.ensureDir(counterRoot);
    const leafRoot = path.join(sourceRoot, 'plugins', 'leaf');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'leaf-skill',
        }],
      };
    };
    const configureRoot = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: configureRoot },
    ]);
    await writeDynamicSkillRenderer({ pluginRoot: leafRoot, skillKey: 'leaf-skill', counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: configureRoot },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: [], configureManifest: configureRoot },
    ]);
    await writeDynamicSkillRenderer({
      pluginRoot: leafRoot,
      skillKey: 'leaf-skill',
      fail: true,
      counterRoot,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: [], configureManifest: configureRoot },
    ]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writePluginIntentState(intentLocation, {
      ...await readPluginIntentState(intentLocation),
      roots: [],
    });
    let providerCalls = 0;
    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('cleanup must not invoke the Catalog provider');
          },
        },
      },
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(providerCalls).toBe(0);
    await expect(fs.readFile(
      path.join(counterRoot, 'render-count-leaf.txt'),
      'utf8',
    )).resolves.toBe('1');
    await expect(fs.pathExists(path.join(
      isolation.env.AW_CODEX_HOME!, 'skills', 'leaf-skill',
    ))).resolves.toBe(false);
  }, 30_000);

  it('preserves incomplete, all-zero, and path-mismatched owner markers during force cleanup', async () => {
    const isolation = await configureCatalog();
    const skillsRoot = path.join(isolation.env.AW_CLAUDE_HOME!, 'skills');
    const marker = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'local',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginId: 'local/demo',
      plugin: 'demo',
      artifactKey: 'owned-skill',
      platform: 'claude',
      scope: 'user',
    };
    const fixtures = [
      ['incomplete', { ...marker, sourceIdentity: undefined, artifactKey: 'incomplete' }],
      ['all-zero', { ...marker, sourceIdentity: `sha256:${'0'.repeat(64)}`, artifactKey: 'all-zero' }],
      ['path-mismatch', { ...marker, artifactKey: 'different-directory' }],
    ] as const;
    for (const [directory, value] of fixtures) {
      await fs.outputJson(path.join(skillsRoot, directory, '.agent-workflows-owner.json'), value);
    }

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'user', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' }),
    ]);
    for (const [directory] of fixtures) {
      await expect(fs.pathExists(path.join(skillsRoot, directory))).resolves.toBe(true);
    }
  });

  it('cleans selected ownership without checking historical dependents after source deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'historical-cleanup-project-b');
    const sourceRoot = path.join(projectA, 'historical-cleanup-source');
    const otherRoot = path.join(projectA, 'historical-cleanup-other-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await createDependencyCatalogSnapshotFixture(otherRoot, [{ name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
      cwd: projectA, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installWriteCommand(['team/root'], {
      cwd: projectA, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userIntent = { scope: 'user' as const, cwd: projectA, env: isolation.env };
    await writePluginIntentState(userIntent, {
      ...await readPluginIntentState(userIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'other', type: 'path', primary: true, path: otherRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'codex', scope: 'user',
    }, runtime);

    expect(result).toMatchObject({ overallState: 'succeeded' });
  }, 30_000);

  it.each([false, true])(
    'ignores obsolete store artifact paths during cleanup (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `obsolete-store-artifact-${force ? 'force' : 'normal'}`,
      );
      const configureV1 = (manifest: PluginMeta['manifest']) => {
        manifest.extensions = {
          agents: [
            { name: 'real-role', description: 'Real role.', prompt: 'Real.' },
            { name: 'obsolete-role', description: 'Obsolete role.', prompt: 'Obsolete.' },
          ],
        };
      };
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configureV1 }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
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
      const agentsRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
      const realRole = path.join(agentsRoot, 'aw-demo-real-role.toml');
      const obsoleteRole = path.join(agentsRoot, 'aw-demo-obsolete-role.toml');
      await fs.outputFile(obsoleteRole, 'foreign = true\n');
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'real-role', description: 'Real role.', prompt: 'Real.' }],
          };
        },
      }]);
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
      const intent = {
        scope: 'project' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      await writePluginIntentState(intent, {
        ...await readPluginIntentState(intent),
        roots: [],
      });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
        ...(force ? { force: true } : {}),
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(realRole)).resolves.toBe(false);
      await expect(fs.readFile(obsoleteRole, 'utf8')).resolves.toBe('foreign = true\n');
    },
  );

  it('detects collisions from real renderer output before the first platform write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-counts');
    await fs.ensureDir(counterRoot);
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present', 'disabled'], refreshKeys: [],
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
      counterRoot,
    })));
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
      await expect(fs.readFile(path.join(counterRoot, `render-count-${plugin.name}.txt`), 'utf8'))
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
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey,
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
        schemaVersion: 2,
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

    expect(result.overallState).toBe('partial');
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

  it('preserves malformed selected config while cleanup and uninstall remove owned artifacts', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-removal-config-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.config = { fields: { mode: { type: 'string', required: true } } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'cleanup-target', configureManifest: configure },
      { name: 'uninstall-target', configureManifest: configure },
      { name: 'guard-target', configureManifest: configure },
      { name: 'unrelated', configureManifest: configure },
      { name: 'config-only', configureManifest: configure },
      { name: 'no-live-other', configureManifest: configure },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    for (const pluginName of ['cleanup-target', 'uninstall-target', 'guard-target']) {
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'valid' },
      });
    }
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installWriteCommand([
      'team/cleanup-target', 'team/uninstall-target', 'team/guard-target',
    ], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    for (const pluginName of ['cleanup-target', 'uninstall-target']) {
      await fs.outputFile(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }), '{malformed');
    }

    const cleaned = await cleanupWriteCommand(['team/cleanup-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const cleanupConfigPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'cleanup-target', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(cleaned.warnings.some((warning) => warning.includes('pluginConfigPreserved')),
      JSON.stringify(cleaned.warnings)).toBe(true);
    expect(cleaned.rebuildResults.some((result) => result.removed.length > 0)).toBe(true);
    await expect(fs.readFile(cleanupConfigPath, 'utf8')).resolves.toBe('{malformed');
    await fs.unlink(cleanupConfigPath);

    const uninstalled = await uninstallWriteCommand(['team/uninstall-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    expect(uninstalled.warnings.some((warning) => warning.includes('pluginConfigPreserved')),
      JSON.stringify(uninstalled.warnings)).toBe(true);
    expect(uninstalled.rebuildResults.some((result) => result.removed.length > 0)).toBe(true);
    const uninstallConfigPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'uninstall-target', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(fs.readFile(uninstallConfigPath, 'utf8')).resolves.toBe('{malformed');
    await fs.unlink(uninstallConfigPath);

    const configOnlyPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'config-only', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.outputFile(configOnlyPath, '{config-only-malformed');
    const configOnlyCleanup = await cleanupWriteCommand(['team/config-only'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(configOnlyCleanup.overallState).toBe('succeeded');
    expect(configOnlyCleanup.rebuildResults).toEqual([]);
    expect(configOnlyCleanup.warnings.some((warning) => warning.includes('pluginConfigPreserved')))
      .toBe(true);
    await expect(fs.readFile(configOnlyPath, 'utf8')).resolves.toBe('{config-only-malformed');

    const unrelatedNoLive = await cleanupWriteCommand(['team/no-live-other'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedNoLive.overallState).toBe('failed');
    expect(unrelatedNoLive.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/no-live-other' }),
      state: 'failed',
      errorCode: 'stateInventoryFailed',
    }));

    await fs.outputFile(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'unrelated', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), '{unrelated-malformed');
    const guarded = await uninstallWriteCommand(['team/guard-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(guarded.overallState).toBe('failed');
    expect(guarded.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/guard-target' }),
      state: 'failed',
      errorCode: 'stateInventoryFailed',
    }));
  });

  it('adds a missing dependency when sync --all starts from intent roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'upgrade-all-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root' },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    const upgraded = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', all: true, interactive: false,
    }, runtime);

    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(upgraded.dependencyPlan?.requestedPluginIds).toEqual(['team/root']);
    expect(upgraded.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['leaf', 'root']);
    expect(upgraded.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', relation: 'dependency', action: 'install' }),
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
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const inventoryReads: Array<boolean> = [];
    const readInventory: typeof inventoryCatalogSourceReferences = async (options) => {
      inventoryReads.push(options.cwd === isolation.layout.fixtureCwd);
      return inventoryCatalogSourceReferences(options);
    };
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }), undefined, { inventoryCatalogSourceReferences: readInventory });
    const intent = {
      kind: 'pluginWrite', action: 'install', pluginId: 'team/root', platform: 'codex', scope: 'project',
    } as const;
    const evidence = await dependencies.captureEvidence(intent);
    expect(inventoryReads).toEqual([true]);
    inventoryReads.length = 0;
    const result = await dependencies.executeIntent(intent, evidence) as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['leaf', 'root']);
    expect(result.dependencyPlan?.dependencyEdges).toEqual([
      { from: 'team/root', to: 'team/leaf', platform: 'codex' },
    ]);
    expect(inventoryReads).toEqual([true]);
  });

  it('fails closed before a dependency write when the operation plan no longer matches', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-plan-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const preview = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const stalePlan = {
      ...preview.dependencyPlan!,
      resolvedPluginIds: ['team/root'],
    };

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedPlanFingerprint: 'sha256:stale' });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
    ]);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
  });

  it('uses one fresh ordinary inventory for reviewed TUI writes without a historical cleanup scan', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-inventory-owner-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const inventoryReads: Array<boolean> = [];
    const readInventory: typeof inventoryCatalogSourceReferences = async (options) => {
      inventoryReads.push(options.cwd === isolation.layout.fixtureCwd);
      return inventoryCatalogSourceReferences(options);
    };
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }), undefined, { inventoryCatalogSourceReferences: readInventory });
    const installIntent = {
      kind: 'pluginWrite', action: 'install', pluginId: 'team/demo', platform: 'codex', scope: 'project',
    } as const;
    const installEvidence = await dependencies.captureEvidence(installIntent);
    expect(inventoryReads).toEqual([true]);
    inventoryReads.length = 0;

    await expect(dependencies.executeIntent(installIntent, installEvidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(inventoryReads).toEqual([true]);

    inventoryReads.length = 0;
    const cleanupIntent = { ...installIntent, action: 'cleanup' as const };
    const cleanupEvidence = await dependencies.captureEvidence(cleanupIntent);
    expect(inventoryReads).toEqual([true]);
    inventoryReads.length = 0;

    await expect(dependencies.executeIntent(cleanupIntent, cleanupEvidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(inventoryReads).toEqual([true]);
  });

  it('rejects stale reviewed TUI inventory before changing an already advanced target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-inventory-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const inventoryReads: Array<boolean> = [];
    const readInventory: typeof inventoryCatalogSourceReferences = async (options) => {
      inventoryReads.push(options.cwd === isolation.layout.fixtureCwd);
      return inventoryCatalogSourceReferences(options);
    };
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    });
    const dependencies = createTuiControllerDependencies(
      context,
      undefined,
      { inventoryCatalogSourceReferences: readInventory },
    );
    const intent = {
      kind: 'pluginWrite', action: 'install', pluginId: 'team/demo', platform: 'codex', scope: 'project',
    } as const;
    const reviewEvidence = await dependencies.captureEvidence(intent);
    expect(inventoryReads).toEqual([true]);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, context)).resolves.toMatchObject({ overallState: 'succeeded' });
    const targetPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(targetPath, 'utf8');
    const beforeMtime = (await fs.stat(targetPath)).mtimeMs;
    inventoryReads.length = 0;

    await expect(dependencies.executeIntent(intent, reviewEvidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
    expect(inventoryReads).toEqual([true]);
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(before);
    await expect(fs.stat(targetPath)).resolves.toMatchObject({ mtimeMs: beforeMtime });
  });

  it('rejects shared-only force cleanup through the reviewed TUI runtime', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-force-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
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

    expect(result).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' })],
    });
    await expect(statusCommandV7({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready' })] },
    });
  });

  it.each(['path', 'git'] as const)(
    'blocks a reviewed %s source update at locked evidence capture without writes',
    async (provider) => {
      const isolation = getCurrentSourceTestIsolation();
      const workRoot = path.join(isolation.layout.fixtureCwd, `tui-${provider}-review-work`);
      const sourceRoot = provider === 'git' ? path.join(workRoot, 'catalog') : workRoot;
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'review A\n', (manifest) => {
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
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
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
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'review B\n', (manifest) => {
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
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
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
      [],
      `${content}\n`,
      (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'review', title: 'Review', content }],
        };
        manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
      },
    );
    await writeSource('review B');
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
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
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const controller = new TuiController(createTuiControllerDependencies(context));
      await controller.load();
      const review = await controller.buildOperationReview(intent);
      await writeSource('actual C');
    await syncCatalogSourceGeneration({
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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

  it('force cleanup preserves a shared-only dependency placement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    expect(removed).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' })],
    });

    const partial = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(partial.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      components: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'dependency', key: 'team/leaf', state: 'absent' }),
      ]),
    });

    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    const healthy = await statusCommandV7({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(healthy.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      components: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'dependency', state: 'absent' }),
      ]),
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
    'cleans the selected dependency without inspecting a %s consumer',
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
        config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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

      expect(blocked.overallState, JSON.stringify(blocked.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        'aw-leaf-leaf-role.toml',
      ))).resolves.toBe(false);
      await expect(fs.pathExists(rootAgent)).resolves.toBe(consumerState === 'error');
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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

  it.each(['uninstall', 'cleanup-all'] as const)(
    'rejects %s before mutation when the Active dependency graph disagrees with a bundle',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `untrusted-removal-graph-${command}-source`,
      );
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
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
      await expect(installWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

      const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
      const catalogManifest = await fs.readJson(catalogManifestPath);
      const rootEntry = catalogManifest.entries.find((entry: { name: string }) => entry.name === 'root');
      rootEntry.dependencies = [];
      await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      await expect(validateCatalogSnapshotTransport(active.snapshotPath)).resolves.toMatchObject({
        snapshotDigest: active.snapshotDigest,
      });

      const intentPath = path.join(
        isolation.layout.fixtureCwd,
        '.agent-workflows',
        'plugin-intents.json',
      );
      const intentBefore = await fs.readFile(intentPath, 'utf8');
      const platformRoot = path.join(isolation.layout.fixtureCwd, '.codex');
      const platformBefore = await snapshotRegularTree(platformRoot);

      if (command === 'uninstall') {
        await expect(uninstallWriteCommand(['team/leaf'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)).resolves.toMatchObject({ overallState: 'failed' });
      } else {
        await expect(withAwHomeMutationLock({
          env: isolation.env,
          action: (token) => runRebuildCommand({
            command: 'cleanup',
            pluginNames: [],
            all: true,
            commandOptions: {
              cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
            },
            runtime: { ...runtime, awHomeMutationToken: token },
          }),
        })).rejects.toThrow(/does not match its plugin bundle/u);
      }

      await expect(fs.readFile(intentPath, 'utf8')).resolves.toBe(intentBefore);
      await expect(snapshotRegularTree(platformRoot)).resolves.toEqual(platformBefore);
    },
  );

  it('does not use another project consumer to block an ordinary uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'dependency-project-b');
    registerCurrentTestWritableStateRoot(projectB, 'secondary current project');
    const sourceRoot = path.join(projectA, 'historical-consumer-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
        if (invocation.args[1] === 'uninstall') {
          const pluginId = invocation.args[2]!;
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = { ...((settings.enabledPlugins ?? {}) as Record<string, unknown>) };
          delete enabledPlugins[pluginId];
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginId];
          await fs.outputJson(installedPath, { plugins });
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

    const removed = await uninstallWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'claude', scope: 'user',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    nativeCliRunner.mockClear();

    const missing = await statusCommandV7({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missing.payload.targets).toEqual([
      expect.objectContaining({
        state: 'blocked',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'sourceMissing' }),
          expect.objectContaining({ code: 'codexIntentSourceUnavailable' }),
        ]),
      }),
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
    await expect(controller.executeOperation(review.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    controller.dispose();
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toBe(before);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('aw-owner-v3:');
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
        schemaVersion: 2,
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
        schemaVersion: 2,
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
    const rulesRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'rules');
    const driftPath = path.join(rulesRoot, 'aw-demo-drift-owner.rules');
    setTuiControllerRuntimeTestHooksForTests({
      beforeMutationEvidenceCapture: async () => {
        await writeOwnedTextFile({
          path: driftPath,
          allowedRoot: rulesRoot,
          identity: {
            owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
            pluginId: 'team/demo', plugin: 'demo', artifactKey: 'drift-owner',
            platform: 'codex', scope: 'project',
          },
          content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
        });
      },
    });
    try {
      const execution = await controller.executeOperation(review.reviewToken);
      expect(execution, JSON.stringify(execution)).toMatchObject({
        state: 'stale', review: { pluginAction: 'cleanup' },
      });
    } finally {
      setTuiControllerRuntimeTestHooksForTests(undefined);
      controller.dispose();
    }
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('aw-owner-v3:');
  }, 30_000);

  it('previews an exact offline cleanup plan and rejects direct execution after plan drift', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
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
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    const projectIntent = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writePluginIntentState(projectIntent, {
      ...await readPluginIntentState(projectIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const evidence = preview.offlineCleanupPlans?.[0];

    expect(evidence).toMatchObject({
      reason: 'sourceMissing',
      pluginId: 'team/demo',
      plan: {
        schemaVersion: 1,
        pluginId: 'team/demo',
        sourceIdentity: 'unavailable',
        platform: 'codex',
        scope: 'project',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'removeOwnedOutput', kind: 'namespacedOwner' }),
        ]),
      },
      planDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
    const rulesRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'rules');
    const driftPath = path.join(rulesRoot, 'aw-demo-direct-drift.rules');
    await writeOwnedTextFile({
      path: driftPath,
      allowedRoot: rulesRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'direct-drift',
        platform: 'codex', scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });

    await expect(cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedOfflineCleanupEvidence: evidence }))
      .resolves.toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'operationReviewStale' })],
      });
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it.each(['user', 'project'] as const)(
    'executes the frozen source-missing Codex activation cleanup for %s scope and retains shared native state',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `offline-native-${scope}-source`);
      const remainingRoot = path.join(isolation.layout.fixtureCwd, `offline-native-${scope}-remaining`);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
      await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = createCodexNativeTestRuntime(isolation);
      const installed = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
      const intent = await readPluginIntentState(intentLocation);
      await writePluginIntentState(intentLocation, { ...intent, roots: [] });
      if (scope === 'user') {
        const projectIntentLocation = {
          scope: 'project' as const,
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
        };
        await writePluginIntentState(projectIntentLocation, {
          ...await readPluginIntentState(projectIntentLocation),
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
          managed: { codexPluginIds: ['demo@aw'] },
        });
        await applyCodexConfigTransactionFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
          { upsertPluginActivations: { 'demo@aw': true } },
        );
      }
      const activationConfigPath = scope === 'user'
        ? path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(activationConfigPath, {
        upsertPluginActivations: { 'foreign@outside': true, 'demo@outside': true },
      });
      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const payloadSkill = path.join(
        marketplaceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md',
      );
      const cacheSkill = path.join(
        isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
        'skills', 'demo-skill', 'SKILL.md',
      );
      const [payloadBefore, cacheBefore] = await Promise.all([
        fs.readFile(payloadSkill),
        fs.readFile(cacheSkill),
      ]);
      const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
        },
        expectedDigest: configured.digest,
        env: isolation.env,
      });

      const preview = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, { ...runtime, previewOperationPlan: true });
      const evidence = preview.offlineCleanupPlans?.[0];
      expect(evidence?.plan.actions, JSON.stringify(preview)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: 'removeNativeRegistration',
          target: 'demo@aw',
          marketplaceName: 'aw',
          activationScope: scope,
        }),
      ]));
      expect(
        evidence?.plan.actions.some((action) => action.target === path.dirname(payloadSkill)),
        JSON.stringify(evidence?.plan.actions),
      ).toBe(false);

      const unavailableNativeRunner = vi.fn(async () => {
        throw Object.assign(new Error('official Codex is unavailable offline'), { code: 'ENOENT' });
      });
      const cleaned = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, {
        ...runtime,
        nativeCliRunner: unavailableNativeRunner,
        expectedOfflineCleanupEvidence: evidence,
      });

      expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
      expect(unavailableNativeRunner).not.toHaveBeenCalled();
      expect(JSON.stringify(cleaned.rebuildResults[0]?.removed)).toContain('demo@aw');
      const activationConfig = await readCodexConfigFile(activationConfigPath);
      expect(activationConfig.snapshot.plugins['demo@aw']?.enabled)
        .toBe(scope === 'user' ? false : undefined);
      expect(activationConfig.snapshot.plugins['foreign@outside']?.enabled).toBe(true);
      expect(activationConfig.snapshot.plugins['demo@outside']?.enabled).toBe(true);
      expect(await fs.pathExists(payloadSkill), JSON.stringify(cleaned)).toBe(true);
      await expect(fs.readFile(payloadSkill)).resolves.toEqual(payloadBefore);
      await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
      await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
      expect(runtime.installed.has('demo@aw')).toBe(true);
      if (scope === 'user') {
        await expect(readCodexConfigFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
        )).resolves.toMatchObject({
          snapshot: { plugins: { 'demo@aw': { enabled: true } } },
        });
      }
    },
    30_000,
  );

  it.each([false, true])(
    'cleans an exact offline Codex extension with ambiguous native identity (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-source`,
      );
      const remainingRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-remaining`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
          };
        },
      }]);
      await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = createCodexNativeTestRuntime(isolation);
      const installed = await installWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const extensionPath = path.join(
        isolation.env.AW_CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml',
      );
      await expect(fs.pathExists(extensionPath)).resolves.toBe(true);
      const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
      const ambiguousConfig = [
        '[plugins."demo@outside"]',
        'enabled = true',
        '',
        '[plugins."foreign@outside"]',
        'enabled = true',
        '',
      ].join('\n');
      await fs.outputFile(configPath, ambiguousConfig);
      const cacheRoot = path.join(
        isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo',
      );
      const cacheBefore = await snapshotRegularTree(cacheRoot);
      const intentPath = path.join(isolation.env.AW_HOME!, 'plugin-intents.json');
      const intentBefore = await fs.readFile(intentPath);
      await fs.remove(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team'));
      const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
        },
        expectedDigest: configured.digest,
        env: isolation.env,
      });
      runtime.nativeCliRunner.mockClear();

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force,
      }, runtime);
      const receipt = (await import('../../src/output/command-receipt.js'))
        .buildRebuildReceiptJson('cleanup', result);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('nativeMarketplaceIdentityUnresolved'),
      ]));
      expect(receipt.targetResults).toEqual([
        expect.objectContaining({
          state: 'completed',
          residual: expect.arrayContaining(['nativeMarketplaceIdentityUnresolved']),
        }),
      ]);
      await expect(fs.pathExists(extensionPath)).resolves.toBe(false);
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(ambiguousConfig);
      await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
      await expect(snapshotRegularTree(cacheRoot)).resolves.toEqual(cacheBefore);
      expect(runtime.installed.has('demo@aw')).toBe(true);
      expect(runtime.nativeCliRunner).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('returns idempotent success for a source-deleted target with no live match', async () => {
      const isolation = await configureCatalog();

      const result = await cleanupWriteCommand(['removed/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { env: isolation.env });

      expect(result).toMatchObject({
        overallState: 'succeeded',
        targetResults: [],
        rebuildResults: [],
      });
  });

  it('returns typed recovery when markerless force cleanup has no local Active bundle', async () => {
    const isolation = await configureCatalog();
    const result = await cleanupWriteCommand(['removed/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      force: true,
    }, { env: isolation.env });

    expect(result.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'forceCleanupPathUnavailable',
        recoveryActions: [
          'restore the local Active bundle and retry cleanup --force',
          'inspect and remove only the exact expected output manually',
        ],
      }),
    ]);
  });

  it('cleans stale Codex config while preserving cache payload after official absence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-remaining');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceSkill = path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const cacheSkill = path.join(
      isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const [marketplaceBefore, cacheBefore] = await Promise.all([
      fs.readFile(marketplaceSkill),
      fs.readFile(cacheSkill),
    ]);
    runtime.installed.delete('demo@aw');
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(readCodexConfigFile(path.join(
      isolation.env.AW_CODEX_HOME!, 'config.toml',
    ))).resolves.toMatchObject({ snapshot: { plugins: {} } });
    await expect(fs.readFile(marketplaceSkill)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
  }, 30_000);

  it('does not create offline Review issues from marker-only Codex project Skills', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-identity-remaining');
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    })));
    await controller.load();
    expect(controller.listUserIssues().some((entry) => entry.category === 'sourceMissing'
      && entry.pluginId === 'removed/demo')).toBe(false);
    for (const entry of identities) {
      await expect(fs.pathExists(entry.root)).resolves.toBe(true);
    }
    controller.dispose();
  });

  it('cleans a valid live owner when the configured path source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '',
    }));
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
    };
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const configBefore = await fs.readFile(configPath);
    await fs.move(sourceRoot, `${sourceRoot}-unavailable`);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await fs.remove(active.snapshotPath);

    nativeCliRunner.mockClear();
    const codexManagerPreviewer = vi.fn(async () => ({ state: 'requires-install' as const }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      previewOperationPlan: true,
      codexManagerPreviewer,
      codexManagerResolver,
      removeObsoleteInstallationContracts,
    });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
  });

  it('fails closed when shared Codex user config inventory is damaged during project repair', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'damaged-user-inventory-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'cleanup-test', title: 'Cleanup test', content: 'owned content' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    await expect(fs.readFile(projectConfig, 'utf8')).resolves.toContain('aw-owner-v3:');
    const damagedUserConfig = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await fs.outputFile(damagedUserConfig, 'invalid = [\n');
    await fs.remove(projectConfig);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('failed');
    expect(JSON.stringify(result)).toContain('Unable to parse Codex config TOML');
    await expect(fs.readFile(damagedUserConfig, 'utf8')).resolves.toBe('invalid = [\n');
    await expect(fs.pathExists(projectConfig)).resolves.toBe(false);
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
          schemaVersion: 2,
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

      if (force) {
        expect(result).toMatchObject({
          overallState: 'failed',
          targetResults: [expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' })],
        });
        await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');
      } else {
        expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
        await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('demo.');
      }
    },
  );

  it('cleans a source-changed dependency without consulting an old live consumer', async () => {
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
        schemaVersion: 2,
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

    expect(result).toMatchObject({ overallState: 'failed' });
    expect(JSON.stringify(result)).toMatch(/cleanup --force|reinstall|sync/u);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.not.toContain('leaf.');
  });

  it('does not discover marker-only Codex project Skills as live cleanup targets', async () => {
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
    const result = await cleanupWriteCommand(['first/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env });
    expect(result).toMatchObject({ overallState: 'succeeded', targetResults: [] });
    await expect(fs.pathExists(path.join(skillsRoot, 'first-demo'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(skillsRoot, 'second-demo'))).resolves.toBe(true);
  });

  it('removes a project Codex Skill when current config disables its dynamic target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-disabled-skill-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.config = { fields: { enabled: { type: 'boolean', default: true } } };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' },
        states: ['present', 'disabled'], refreshKeys: ['enabled'], skillKey: 'config-skill',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const enabled = context.config.values.enabled;',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "dynamic-skill", kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: enabled ? "present" : "disabled", skillKey: "config-skill", refreshKeys: ["enabled"],',
      '  ...(enabled ? { content: { files: {',
      '    "SKILL.md": "---\\nname: config-skill\\ndescription: Config Skill.\\n---\\n",',
      '    "README.md": "Config Skill.\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } } } : { disabledReason: "disabled by config" })',
      '}] }));',
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
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
    const skillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'config-skill');
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(true);
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { enabled: false },
    });

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
  }, 30_000);

  it('removes a project Codex Skill deleted by a new source identity manifest', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v1-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v2-source');
    const configureV1 = (manifest: PluginMeta['manifest']) => {
      manifest.version = '1.0.0';
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' },
        states: ['present'], refreshKeys: [], skillKey: 'removed-in-v2',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await writeDynamicSkillRenderer({
      pluginRoot: path.join(firstRoot, 'plugins', 'demo'), skillKey: 'removed-in-v2',
    });
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await createDependencyCatalogSnapshotFixture(secondRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.version = '2.0.0';
        manifest.marketplace.policy.products = ['CODEX'];
      },
    }]);
    const firstSource = { id: 'team', type: 'path' as const, primary: true, path: firstRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'removed-in-v2');
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(true);
    const changed = await updateCatalogSourceCommand({
      sourceId: 'team',
      update: { path: secondRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(changed).toMatchObject({ ok: true, changed: true });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
  }, 30_000);

  it('only removes direct project Codex Skills with an exact current owner identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-stale-safety-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const writeMarker = async (name: string, identity: Parameters<typeof writeSkillOwnerMarker>[0]['identity']) => {
      const skillRoot = path.join(skillsRoot, name);
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, identity });
      return skillRoot;
    };
    const identity = (artifactKey: string) => ({
      owner: 'agent-workflows' as const,
      sourceId: 'team', pluginId: 'team/demo', plugin: 'demo', artifactKey,
      platform: 'codex' as const, scope: 'project' as const,
    });
    const removable = await writeMarker('stale-owned', identity('stale-owned'));
    const retained = [
      await writeMarker('foreign-source', {
        ...identity('foreign-source'), sourceId: 'foreign', pluginId: 'foreign/demo',
      }),
      await writeMarker('user-scope', { ...identity('user-scope'), scope: 'user' }),
      await writeMarker('claude-skill', { ...identity('claude-skill'), platform: 'claude' }),
    ];
    const malformed = path.join(skillsRoot, 'malformed');
    await fs.outputFile(path.join(malformed, SKILL_OWNER_MARKER), '{invalid\n');
    retained.push(malformed);
    const markerTarget = path.join(isolation.layout.rootDir, 'external-owner-marker.json');
    await fs.outputJson(markerTarget, identity('marker-symlink'));
    const markerSymlink = path.join(skillsRoot, 'marker-symlink');
    await fs.ensureDir(markerSymlink);
    await fs.symlink(markerTarget, path.join(markerSymlink, SKILL_OWNER_MARKER));
    retained.push(markerSymlink);
    const externalSkill = path.join(isolation.layout.rootDir, 'external-skill-directory');
    await fs.outputFile(path.join(externalSkill, 'SKILL.md'), 'foreign\n');
    const skillSymlink = path.join(skillsRoot, 'skill-symlink');
    await fs.symlink(externalSkill, skillSymlink, process.platform === 'win32' ? 'junction' : 'dir');
    retained.push(skillSymlink);
    const nested = path.join(skillsRoot, 'container', 'nested-owned');
    await fs.ensureDir(nested);
    await writeSkillOwnerMarker({
      skillRoot: nested,
      allowedRoot: path.join(skillsRoot, 'container'),
      identity: identity('nested-owned'),
    });
    retained.push(nested);

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(removable)).resolves.toBe(false);
    for (const skillRoot of retained) {
      await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    }
    await expect(fs.pathExists(markerTarget)).resolves.toBe(true);
    await expect(fs.pathExists(externalSkill)).resolves.toBe(true);
  }, 30_000);

  it('rejects a multi-selector force cleanup before mutation when one target has no exact path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-multi-selector-source');
    const removable = {
      name: 'removable',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { targets: [{
          id: 'removable-skill', platform: 'codex', scopes: ['project'],
          target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'removable-skill',
        }] };
      },
    };
    const sharedOnly = {
      name: 'shared-only',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'shared-only', title: 'Shared only', content: 'Shared only.' }],
        };
      },
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    await writeDynamicSkillRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'removable'),
      skillKey: 'removable-skill',
      fail: true,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const skillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'removable-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), 'markerless but exact\n');

    await expect(withAwHomeMutationLock({
      env: isolation.env,
      action: (token) => runRebuildCommand({
        command: 'cleanup',
        pluginNames: ['local/removable', 'local/shared-only'],
        commandOptions: {
          cwd: isolation.layout.fixtureCwd,
          platform: 'codex',
          scope: 'project',
          json: false,
          force: true,
        },
        runtime: { env: isolation.env, awHomeMutationToken: token },
      }),
    })).rejects.toMatchObject({
      message: expect.stringContaining('forceCleanupPathUnavailable'),
      namespacedTargets: [{
        pluginId: 'local/shared-only',
        pluginName: 'shared-only',
        sourceId: 'local',
        sourceIdentity: 'unavailable',
        platform: 'codex',
        scope: 'project',
      }],
    });
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('force cleanup removes only the exact Active-planned markerless Codex project Skill', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-shallow-source');
    const configureForceManifest = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        postApply: { path: './scripts/post-apply.mjs' },
      };
      manifest.artifacts = { targets: [{
        id: 'damaged-demo', platform: 'codex', scopes: ['project'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'damaged-demo',
      }] };
    };
    const forcePlugin = {
      name: 'demo',
      configureManifest: configureForceManifest,
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    await writeDynamicSkillRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      skillKey: 'damaged-demo',
      fail: true,
    });
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'post-apply.mjs'),
      "throw new Error('force cleanup must not run postApply');\n",
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
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
    await fs.ensureDir(otherSkillRoot);
    await writeSkillOwnerMarker({
      skillRoot: otherSkillRoot,
      allowedRoot: otherSkillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'local',
        sourceIdentity: 'damaged',
        pluginId: 'local/demo',
        plugin: 'demo',
        artifactKey: 'damaged-demo',
        platform: 'claude',
        scope: 'user',
      },
    });
    await fs.outputFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), '{invalid\n');
    await fs.outputJson(externalMarker, {
      ...damagedOwner,
      artifactKey: 'linked-marker',
    });
    await fs.ensureDir(linkedSkillRoot);
    await fs.symlink(externalMarker, path.join(linkedSkillRoot, '.agent-workflows-owner.json'));
    const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(sharedConfig, {
      upsertPluginActivations: { 'demo@aw': true },
    });

    const blockedReinstall = await reinstallWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env });
    expect(blockedReinstall.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw cleanup local/demo --platform codex --scope project --force',
          'then run aw reinstall local/demo --platform codex --scope project',
        ],
      }),
    ]);
    const blockedReceipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('reinstall', blockedReinstall);
    expect(blockedReceipt.recoveryActions).toEqual([
      'run aw cleanup local/demo --platform codex --scope project --force',
      'then run aw reinstall local/demo --platform codex --scope project',
    ]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    const activeState = await fs.readJson(path.join(isolation.env.AW_HOME!, 'catalog-state.json')) as {
      sources: { local: { active: { logicalIdentity: string; snapshotDigest: string } } };
    };
    const activeStore = resolveCatalogStoreLocation({
      ...activeState.sources.local.active,
      env: isolation.env,
    });
    await fs.outputFile(
      path.join(activeStore.snapshotRoot, 'plugins', 'unrelated', '.agents-plugin', 'plugin.json'),
      '{damaged unrelated bundle\n',
    );
    const malformedIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const malformedIntent = Buffer.from('{malformed selected project Intent\n');
    await fs.outputFile(malformedIntentPath, malformedIntent);

    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const codexManagerPreviewer = vi.fn(async () => ({ state: 'requires-install' as const }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    let providerCalls = 0;
    const forceRuntime = {
      env: isolation.env,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('force cleanup must not invoke the Catalog provider');
          },
        },
      },
    };
    const preview = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, {
      ...forceRuntime,
      previewOperationPlan: true,
      removeObsoleteInstallationContracts,
      codexManagerPreviewer,
      codexManagerResolver,
    });

    expect(preview.overallState).toBe('succeeded');
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(providerCalls).toBe(0);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'render-count-demo.txt')))
      .resolves.toBe(false);
    expect(preview.operationPlan?.actions).toEqual([
      expect.objectContaining({
        kind: 'removeOwnedArtifact',
        path: expect.stringMatching(/[\\/]\.agents[\\/]skills[\\/]damaged-demo$/u),
      }),
    ]);
    await expect(fs.readJson(path.join(skillRoot, '.agent-workflows-owner.json')))
      .resolves.toEqual(damagedOwner);
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
      snapshot: { plugins: { 'demo@aw': { enabled: true } } },
    });

    const reviewedEvidence = preview.offlineCleanupPlans?.[0];
    expect(reviewedEvidence).toBeDefined();
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 3,
      owner: 'agent-workflows',
      sourceId: 'foreign',
      pluginId: 'foreign/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    });
    const stale = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { ...forceRuntime, expectedOfflineCleanupEvidence: reviewedEvidence });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationReviewStale' }),
    ]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), damagedOwner);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, forceRuntime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    expect(providerCalls).toBe(0);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'render-count-demo.txt')))
      .resolves.toBe(false);
    await expect(fs.readFile(malformedIntentPath)).resolves.toEqual(malformedIntent);
  });

  it('recovers a damaged owned-text header through reinstall, force cleanup, and reinstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'project-skill',
      }] };
    };
    const definition = [{ name: 'demo', configureManifest: configure }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    await writeDynamicSkillRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      skillKey: 'project-skill',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const installed = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const skillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'project-skill');
    const agentPath = path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml',
    );
    const originalAgent = await fs.readFile(agentPath, 'utf8');
    await fs.outputFile(
      agentPath,
      `# agent-workflows-owner: {invalid\n${originalAgent.split('\n').slice(1).join('\n')}`,
    );

    const blocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw cleanup team/demo --platform codex --scope project --force',
          'then run aw reinstall team/demo --platform codex --scope project',
        ],
      }),
    ]);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    const intentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const validIntent = await fs.readFile(intentPath);
    const malformedIntent = Buffer.from('{malformed selected project Intent\n');
    await fs.outputFile(intentPath, malformedIntent);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    await expect(fs.readFile(intentPath)).resolves.toEqual(malformedIntent);

    await fs.outputFile(intentPath, validIntent);
    const restored = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(agentPath, 'utf8'))?.identity).toMatchObject({
      pluginId: 'team/demo', platform: 'codex', scope: 'project',
    });

    const unrelatedUserAgent = path.join(
      isolation.env.AW_CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml',
    );
    await fs.outputFile(unrelatedUserAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const unrelatedBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.pathExists(unrelatedUserAgent)).resolves.toBe(true);
  }, 30_000);

  it('matches a damaged reinstall owned-text target by its full normalized path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-exact-path-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
      manifest.extensions = {
        instructions: [{ name: 'reviewer', title: 'Reviewer', content: 'Review changes.' }],
      };
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
    const nativeCliRunner = vi.fn(async () => (
      { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' }
    ));
    const runtime = { env: isolation.env, nativeCliRunner };
    const rulePath = path.join(
      isolation.layout.fixtureCwd, '.claude', 'rules', 'aw-demo-reviewer.md',
    );
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: path.join(isolation.layout.fixtureCwd, '.claude'),
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'aw-demo-reviewer',
        platform: 'claude', scope: 'project',
      },
      content: '# Reviewer\n\nReview changes.\n',
    });
    const intentLocation = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writePluginIntentState(intentLocation, {
      ...await readPluginIntentState(intentLocation),
      roots: [{ pluginId: 'team/demo', platforms: ['claude'] }],
    });
    const settingsPath = path.join(isolation.layout.fixtureCwd, '.claude', 'settings.json');
    await fs.outputJson(settingsPath, { sentinel: true });
    const originalRule = await fs.readFile(rulePath);
    await fs.outputFile(rulePath, '# agent-workflows-owner: {invalid\nowned target\n');

    const exactBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'project',
    }, runtime);
    expect(exactBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);

    await fs.outputFile(rulePath, originalRule);
    const sameBasenameAgent = path.join(
      isolation.layout.fixtureCwd, '.claude', 'agents', path.basename(rulePath),
    );
    await fs.outputFile(sameBasenameAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const intentPath = path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json',
    );
    const before = {
      rule: await fs.readFile(rulePath),
      agent: await fs.readFile(sameBasenameAgent),
      intent: await fs.readFile(intentPath),
      settings: await fs.readFile(settingsPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const wrongPathBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'project',
    }, runtime);

    expect(wrongPathBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(wrongPathBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(rulePath)).resolves.toEqual(before.rule);
    await expect(fs.readFile(sameBasenameAgent)).resolves.toEqual(before.agent);
    await expect(fs.readFile(intentPath)).resolves.toEqual(before.intent);
    await expect(fs.readFile(settingsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(before.settings);
    expect(nativeCliRunner.mock.calls).toHaveLength(before.nativeCalls);
  }, 30_000);

  it('invalid shared config does not authorize marker-only Codex project recovery', async () => {
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
    await expect(fs.readFile(sharedPath, 'utf8')).resolves.toBe(foreignShared);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('matches a damaged project Skill marker through a symlink cwd by its exact canonical path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-exact-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'shared-name',
      }] };
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.marketplace.policy.products = ['CODEX'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeDynamicSkillRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'),
      skillKey: 'shared-name',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => (
      { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }
    ));
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
    };
    const exactInstalled = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(exactInstalled.overallState, JSON.stringify(exactInstalled)).toBe('succeeded');
    const linkedCwd = path.join(isolation.layout.rootDir, 'linked-project-cwd');
    await fs.symlink(
      isolation.layout.fixtureCwd,
      linkedCwd,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const damagedRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'shared-name');
    await fs.outputJson(path.join(damagedRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'team',
      pluginId: 'team/leaf',
      plugin: 'leaf',
      artifactKey: 'shared-name',
      platform: 'codex',
      scope: 'project',
    });
    const distractors = [
      {
        root: path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'shared-name'),
        sourceId: 'other', platform: 'codex' as const, scope: 'user' as const,
      },
      {
        root: path.join(isolation.env.AW_CLAUDE_HOME!, 'skills', 'shared-name'),
        sourceId: 'team', platform: 'claude' as const, scope: 'user' as const,
      },
    ];
    for (const distractor of distractors) {
      await fs.ensureDir(distractor.root);
      await writeSkillOwnerMarker({
        skillRoot: distractor.root,
        allowedRoot: path.dirname(distractor.root),
        identity: {
          owner: 'agent-workflows',
          sourceId: distractor.sourceId,
          pluginId: `${distractor.sourceId}/leaf`,
          plugin: 'leaf',
          artifactKey: 'shared-name',
          platform: distractor.platform,
          scope: distractor.scope,
        },
      });
    }

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/leaf', platform: 'codex', scope: 'project',
        }),
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw cleanup team/leaf --platform codex --scope project --force',
          'then run aw reinstall team/leaf --platform codex --scope project',
        ],
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        errorCode: 'dependencyInstallFailed',
      }),
    ]));
    expect(result.targetResults.filter((target) => target.recoveryActions)).toHaveLength(1);
    for (const distractor of distractors) {
      await expect(fs.pathExists(distractor.root)).resolves.toBe(true);
    }

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(damagedRoot)).resolves.toBe(false);
    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(damagedRoot)).resolves.toBe(true);

    const unrelatedMarker = path.join(
      distractors[0]!.root,
      '.agent-workflows-owner.json',
    );
    await fs.outputFile(unrelatedMarker, '{invalid unrelated marker\n');
    const selectedMarker = path.join(damagedRoot, '.agent-workflows-owner.json');
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const actualBefore = {
      selectedMarker: await fs.readFile(selectedMarker),
      unrelatedMarker: await fs.readFile(unrelatedMarker),
      projectIntent: await fs.readFile(projectIntentPath),
      projectConfig: await fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const unrelatedBlocked = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(selectedMarker)).resolves.toEqual(actualBefore.selectedMarker);
    await expect(fs.readFile(unrelatedMarker)).resolves.toEqual(actualBefore.unrelatedMarker);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(actualBefore.projectIntent);
    await expect(fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(actualBefore.projectConfig);
    expect(nativeCliRunner.mock.calls).toHaveLength(actualBefore.nativeCalls);
  });

  it('attributes damaged dependency owner evidence after resolving a project override to user scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-user-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['user'],
        target: 'codex.skill', delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: [], skillKey: 'shared-name',
      }] };
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.marketplace.policy.products = ['CODEX'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeDynamicSkillRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), skillKey: 'shared-name',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const damagedRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills', 'shared-name');
    await fs.outputJson(path.join(damagedRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'team',
      pluginId: 'team/leaf',
      plugin: 'leaf',
      artifactKey: 'shared-name',
      platform: 'codex',
      scope: 'user',
    });

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/leaf', platform: 'codex', scope: 'user',
        }),
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw cleanup team/leaf --platform codex --scope user --force',
          'then run aw reinstall team/leaf --platform codex --scope user',
        ],
      }),
    ]));
    await expect(fs.pathExists(damagedRoot)).resolves.toBe(true);
  });

  it('does not touch obsolete contract state during markerless force recovery', async () => {
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

    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' }),
    ]);
    expect(result.warnings).toEqual([]);
    await expect(fs.pathExists(obsolete)).resolves.toBe(true);
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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

  it('reuses persistent user dependency placement for upgrade and reinstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'persistent-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'user',
      }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await fs.remove(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));

    const upgraded = await syncWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(upgraded.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf', resolvedScope: 'user', assignmentSource: 'userOverride',
      }),
    ]));
    await fs.remove(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));

    const reinstalled = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');
    expect(reinstalled.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf', resolvedScope: 'user', assignmentSource: 'userOverride',
      }),
    ]));
  });

  it('round-trips only an explicit dependency override through independent CLI processes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-round-trip-source');
    const dynamicSkill = (skillKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = undefined;
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        states: ['present'],
        refreshKeys: [],
        skillKey,
      }] };
    };
    const definitions = [
      { name: 'c', configureManifest: dynamicSkill('c-skill') },
      { name: 'b', dependencies: ['c'], configureManifest: dynamicSkill('b-skill') },
      {
        name: 'a',
        dependencies: ['b'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.marketplace.policy.products = ['CODEX'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await Promise.all([
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'b'),
        skillKey: 'b-skill',
      }),
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'c'),
        skillKey: 'c-skill',
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const fakeCodexBin = await writeIntentRoundTripCodexPackage(path.join(
      isolation.layout.rootDir,
      'intent-round-trip-codex',
    ));
    const childEnv = {
      ...isolation.env,
      PATH: `${fakeCodexBin}${path.delimiter}${isolation.env.PATH ?? ''}`,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    };
    await runIntentRoundTripCliChild([
      'install',
      'team/a',
      '--scope',
      'project',
      '--platform',
      'codex',
      '--dependency-scope',
      'team/b#codex=user',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readPluginIntentState(intentLocation)).resolves.toEqual({
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [
        { pluginId: 'team/b', platform: 'codex', scope: 'user' },
      ],
    });

    const userSkillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    const projectSkillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    await Promise.all([
      fs.remove(path.join(userSkillsRoot, 'b-skill')),
      fs.remove(path.join(userSkillsRoot, 'c-skill')),
    ]);
    await runIntentRoundTripCliChild([
      'sync',
      'team/a',
      '--scope',
      'project',
      '--platform',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await expect(fs.pathExists(path.join(userSkillsRoot, 'b-skill'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(userSkillsRoot, 'c-skill'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(projectSkillsRoot, 'b-skill'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(projectSkillsRoot, 'c-skill'))).resolves.toBe(false);
    await expect(readPluginIntentState(intentLocation)).resolves.toEqual({
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [
        { pluginId: 'team/b', platform: 'codex', scope: 'user' },
      ],
    });

    await runIntentRoundTripCliChild([
      'uninstall',
      'team/a',
      '--scope',
      'project',
      '--platform',
      'codex',
      '--json',
    ], isolation.layout.fixtureCwd, childEnv);
    await expect(readPluginIntentState(intentLocation)).resolves.toEqual({
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [],
      dependencyScopeOverrides: [],
    });
  }, 60_000);

  it('prunes only dependency scope overrides unreachable from remaining roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-prune-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first-leaf' },
      { name: 'second-leaf' },
      { name: 'shared-leaf' },
      { name: 'first-root', dependencies: ['first-leaf', 'shared-leaf'] },
      { name: 'second-root', dependencies: ['second-leaf', 'shared-leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/first-root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [
        { pluginId: 'team/first-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installWriteCommand(['team/second-root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [
        { pluginId: 'team/second-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    await expect(uninstallWriteCommand(['team/first-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/second-root', platforms: ['codex'] }],
      dependencyScopeOverrides: [
        { pluginId: 'team/second-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    });
    await expect(readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });

    await expect(uninstallWriteCommand(['team/second-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readPluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [], dependencyScopeOverrides: [] });
  });

  it('reconciles Codex AW extensions from component-specific live evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'component-evidence-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'guide', title: 'Guide', content: 'Guide.' }],
          agents: [{ name: 'worker', description: 'Worker.', prompt: 'Work.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    const agentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-demo-worker.toml',
    );
    await fs.remove(agentPath);

    const synced = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.codexReconcilePlans?.[0]?.extensionWrites).toEqual([
      expect.objectContaining({
        componentKey: 'extensions.agents:worker', scope: 'project', action: 'write',
      }),
    ]);
    expect(synced.codexReconcilePlans?.[0]?.extensionWrites).not.toContainEqual(
      expect.objectContaining({ componentKey: 'extensions.instructions:guide' }),
    );
  });

  it.each(['uninstall', 'cleanup'] as const)(
    'applies the command-specific cross-scope policy for %s with a live project consumer',
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
          schemaVersion: 2,
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
        })).resolves.toMatchObject({ overallState: 'succeeded' });
      }
      await expect(uninstallWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime)).resolves.toMatchObject({
        targetResults: [expect.objectContaining({ errorCode: 'dependencyStillRequired' })],
      });
    },
  );

  it('keeps a healthy consumer present when its live dependency is missing', async () => {
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const status = () => statusCommandV7({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    const leafAgent = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    await fs.chmod(leafAgent, 0o000);
    const driftedLeaf = await statusCommandV7({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    }).finally(async () => fs.chmod(leafAgent, 0o644));
    expect(driftedLeaf.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'componentInspectionFailed', severity: 'blocking' }),
        expect.objectContaining({ code: 'codexExtensionDrift' }),
      ]),
      components: expect.arrayContaining([expect.objectContaining({
        key: 'aw-leaf-leaf-role',
        metadata: { errorCode: 'componentInspectionFailed' },
      })]),
    })]);
    expect(statusTargetExtensions(driftedLeaf.payload.targets[0]!)).toMatchObject({ state: 'drifted' });
    await fs.remove(leafAgent);
    const missingLeaf = await statusCommandV7({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missingLeaf.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
    })]);
    expect(statusTargetExtensions(missingLeaf.payload.targets[0]!)).toMatchObject({ state: 'missing' });
    await expect(status()).resolves.toMatchObject({
      hasErrors: false,
      payload: { targets: [expect.objectContaining({
        components: expect.arrayContaining([expect.objectContaining({
          kind: 'dependency',
          key: 'team/leaf',
          state: 'absent',
          metadata: expect.objectContaining({
            rootIssueCode: 'dependencyMissing',
            rootIssueId: 'dependencyMissing:team/leaf:codex:project',
          }),
        })]),
        reasons: expect.arrayContaining([
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
      issue.issueId === 'dependencyMissing:team/leaf:codex:project');
    expect(missingIssue).toMatchObject({
      relationship: 'consumer',
      rootEntity: { pluginId: 'team/leaf', platform: 'codex', scope: 'project' },
      affectedTargets: [expect.objectContaining({
        pluginId: 'team/root', relationship: 'consumer',
      })],
    });
    expect(missingIssue?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'reinstallDependency', pluginId: 'team/leaf', platform: 'codex',
        scope: 'project', project: 'current', writeAction: 'sync',
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
      && issue.pluginId === 'team/leaf'
      && issue.platform === 'codex'
      && issue.scope === 'project');
    expect(collisionIssue).toMatchObject({
      group: 'artifactCollision',
      relationship: 'direct',
      rootEntity: { pluginId: 'team/leaf', platform: 'codex', scope: 'project' },
      affectedTargets: expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/root',
        platform: 'codex',
        scope: 'project',
        relationship: 'consumer',
      })]),
      technicalDetails: expect.arrayContaining([expect.objectContaining({ code: 'dependencyNotReady' })]),
    });
    const collisionStatus = await status();
    expect(collisionStatus).toMatchObject({
      hasErrors: false,
      payload: { targets: [expect.objectContaining({
      components: expect.arrayContaining([expect.objectContaining({
        kind: 'dependency',
        key: 'team/leaf',
        state: 'blockedByCollision',
        metadata: expect.objectContaining({
          rootIssueCode: 'artifactCollision',
          rootIssueId: expect.stringContaining('artifactCollision:team/leaf:codex:project:'),
        }),
      })]),
      reasons: expect.arrayContaining([expect.objectContaining({
        code: 'dependencyNotReady',
        dependencyPluginId: 'team/leaf',
        rootIssueCode: 'artifactCollision',
      })]),
      })] },
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
        schemaVersion: 2,
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
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
      await statusCommandV7({
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
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const status = () => statusCommandV7({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready', reasons: [] })], errors: [] },
    });

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: [] },
    ]);
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready', reasons: [] })] },
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
        schemaVersion: 2,
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

    expect(result.overallState).toBe('partial');
    expect(result.targetResults.length).toBeGreaterThan(0);
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');

    for (const pluginId of ['team/first', 'team/second']) {
      await expect(cleanupWriteCommand([pluginId], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      })).resolves.toMatchObject({
        overallState: 'succeeded',
      });
    }
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');
  });

  it('projects dynamic config and saves or resets it only through the real Controller review bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          level: {
            type: 'string',
            title: '审查级别',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'fast', title: '快速', value: 'fast' },
                { id: 'strict', title: '严格', value: 'strict', recommended: true },
              ],
            },
          },
          count: { type: 'number', validation: { minimum: 1, maximum: 10 }, title: '重试次数' },
          token: { type: 'string', sensitive: true, title: '令牌' },
          rules: { type: 'string', title: '规则文件' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level', 'count', 'token', 'rules'] }],
        },
      };
    });
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
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
          expect.objectContaining({
            key: 'level',
            choices: expect.arrayContaining([
              expect.objectContaining({ id: 'fast', title: '快速', value: 'fast' }),
              expect.objectContaining({ id: 'strict', title: '严格', value: 'strict', recommended: true }),
            ]),
          }),
          expect.objectContaining({ key: 'count', min: 1, max: 10 }),
          expect.objectContaining({ key: 'token', sensitive: true }),
        ]),
      }),
    ]);
    expect(page.presets).toEqual([]);

    const controller = new TuiController(dependencies);
    await controller.load();
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
    expect(availability).toMatchObject({
      exists: true,
      sourceIdentityPresent: true,
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
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
          ...(platform === 'codex' ? { delivery: { mode: 'aw-extension' as const } } : {}),
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
        })),
      };
      manifest.config = { fields: { mode: { type: 'string', title: '模式' } } };
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
        overallState: 'partial',
        targetResults: [
          expect.objectContaining({ target: expect.objectContaining({ platform: 'codex' }), state: 'completed' }),
          expect.objectContaining({ target: expect.objectContaining({ platform: 'claude' }), state: 'failed' }),
        ],
      });
    }
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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'scope evidence' }],
      };
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

    expect(result).toMatchObject({
      state: 'stale',
      review: { pluginAction: 'install' },
    });
    expect(controller.snapshot.router.current.route).toMatchObject({ name: 'review' });
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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { targets: [{
        id: 'codex-review',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        states: ['present'],
        refreshKeys: [],
        skillKey: 'review',
      }] };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
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

    await expect(controller.executeOperation(review.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(controller.listUserIssues().some((entry) => entry.issueId === issue!.issueId)).toBe(false);
    await expect(fs.pathExists(path.dirname(path.join(skillsRoot, installedSkill!)))).resolves.toBe(false);
    controller.dispose();
  });

  it('returns a new Review when source evidence changes before dispatch', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-stale-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'must not be written' }],
      };
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
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'changed\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.extensions = {
          instructions: [{ name: 'review', title: 'Review', content: 'changed content' }],
        };
      });
    await syncCatalogSourceGeneration({
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

  it('preserves the generated shared marketplace root during ordinary cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.' }],
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
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
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);

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

  it('runs every command through the same namespaced runtime without an unrelated Codex probe', async () => {
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
      await syncWriteCommand(['demo'], options, runtime),
      await reinstallWriteCommand(['demo'], options, runtime),
      await uninstallWriteCommand(['demo'], options, runtime),
      await cleanupWriteCommand(['demo'], options, runtime),
    ];

    for (const result of results.slice(0, -1)) {
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
    expect(results.at(-1)).toMatchObject({
      overallState: 'succeeded',
      warnings: [],
      receiptTargets: [],
    });
    expect(nativeCliRunner).not.toHaveBeenCalled();
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
        schemaVersion: 2,
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

    const status = await statusCommandV7({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', state: 'ready' }),
    ]);
    const result = command === 'cleanup'
      ? await cleanupWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)
      : await uninstallWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
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
      createCatalogSnapshotFixture(codexRoot, 'codex-only', [], 'codex\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
      }),
      createCatalogSnapshotFixture(claudeRoot, 'claude-only', [], 'claude\n', (manifest) => {
        manifest.marketplace.policy.products = ['CLAUDE'];
      }),
      createCatalogSnapshotFixture(dualRoot, 'config-dual', [], 'dual\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
        manifest.config = {
          fields: { mode: { type: 'string', default: 'safe' } },
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
            ...(platform === 'codex' ? { delivery: { mode: 'aw-extension' as const } } : {}),
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
        schemaVersion: 2,
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
      [syncWriteCommand, selectors],
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
    for (const command of [installWriteCommand, syncWriteCommand]) {
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
      'config', 'set', 'dual/config-dual', 'mode', '--value-json', '"fast"', '--scope', 'project', '--apply', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      targetResults: expect.arrayContaining([
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

    const lifecycleCaptured = createCapturedCliIo();
    expect(await runCli([
      'sync', 'dual/config-dual', '--platform', 'both', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: lifecycleCaptured.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(1);
    expect(JSON.parse(lifecycleCaptured.readStdout())).toMatchObject({
      ok: false,
      command: 'sync',
      overallState: 'partial',
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
  });

  it('blocks a config reapply that would overwrite a same-name unbound Claude record', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'claude-config-collision-source');
    await createCatalogSnapshotFixture(sourceRoot, 'config-native', [], 'config\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
      manifest.config = {
        fields: { mode: { type: 'string', default: 'safe' } },
      };
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
      'config', 'set', 'team/config-native', 'mode', '--value-json', '"fast"', '--scope', 'user', '--apply', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      applySkippedReason: 'noVisibleTarget',
      targetResults: [],
    });
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'config-native',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).values).toEqual({ mode: 'fast' });
    await expect(fs.readFile(settingsPath)).resolves.toEqual(settingsBytes);
    await expect(fs.readFile(installedPath)).resolves.toEqual(installedBytes);
  });

  it('deduplicates bare, qualified, and repeated selectors by canonical target identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dedupe-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'dedupe', title: 'Dedupe', content: 'One write.' }],
      };
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

  it('rejects sync --all when no intent roots exist', async () => {
    const isolation = await configureCatalog();
    await expect(syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      all: true,
      interactive: false,
    })).rejects.toMatchObject({ code: 'syncSelectionRequired' });
  });

  it('keeps safely separable same-name project instruction owners namespaced', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'second-source');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', [], 'first\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'first-policy', title: 'First', content: 'First.' }],
        };
      }),
      createCatalogSnapshotFixture(secondRoot, 'demo', [], 'second\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'second-policy', title: 'Second', content: 'Second.' }],
        };
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
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
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const,
      version: '0.200.0',
      command: 'codex',
      argsPrefix: [] as string[],
    }));
    const managedCodexAuthorizer = vi.fn(async () => true);

    const installed = await installWriteCommand(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner,
      codexManagerResolver,
      managedCodexAuthorizer,
    });
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const config = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('First.');
    expect(config).toContain('Second.');
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(managedCodexAuthorizer).not.toHaveBeenCalled();
  });

  it('authorizes a managed Codex runtime before the first user native write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'managed-codex-source');
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
    };
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', configureManifest);
    const skillRoot = path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill');
    await Promise.all([
      fs.outputFile(
        path.join(skillRoot, 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill.\n---\n',
      ),
      fs.outputFile(
        path.join(skillRoot, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', configureManifest);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const manager = {
      kind: 'managed' as const,
      version: '0.151.0',
      command: '/managed/node',
      argsPrefix: ['/managed/codex.js'],
    };
    let installed = false;
    let marketplace = false;
    let marketplaceRoot = '';
    const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const writeCodexConfig = async () => fs.outputFile(configPath, [
      ...(marketplace ? [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ] : []),
      ...(installed ? [
        '[plugins."demo@aw"]',
        'enabled = true',
        '',
      ] : []),
    ].join('\n'));
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = invocation.args.slice(pluginIndex);
      if (args[1] === 'marketplace' && args[2] === 'add') {
        marketplace = true;
        marketplaceRoot = args[3]!;
        await writeCodexConfig();
      } else if (args[1] === 'marketplace' && args[2] === 'remove') {
        marketplace = false;
        await writeCodexConfig();
      } else if (args[1] === 'add') {
        installed = true;
        await writeCodexConfig();
        await fs.copy(
          path.join(marketplaceRoot, 'plugins', 'demo'),
          path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0'),
          { overwrite: true },
        );
      } else if (args[1] === 'remove') {
        installed = false;
        await fs.remove(path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo'));
        await writeCodexConfig();
      }
      if (args[1] === 'list' && args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: installed ? [{
              pluginId: 'demo@aw', installed: true, enabled: true, version: '1.0.0',
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return {
        exitCode: 0,
        stdout: args[1] === 'list' && installed ? 'demo@aw\n' : '',
        stderr: '',
      };
    });
    const codexManagerResolver = vi.fn(async (options: {
      authorizer?: () => Promise<boolean>;
    }) => {
      if (!options.authorizer || !await options.authorizer()) {
        throw new CodexManagerError(
          'managedCodexAuthorizationRequired',
          'Explicit authorization is required.',
        );
      }
      return manager;
    });

    const output = createCapturedCliIo();
    const missingSystemRunner = vi.fn(async () => {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    expect(await runCli([
      'install', 'team/demo', '--platform', 'codex', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      io: output.io,
      interactive: false,
      nativeCliRunner: missingSystemRunner,
    })).toBe(1);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'managedCodexAuthorizationRequired' })],
    });
    expect(output.readStderr()).toBe('');
    expect(nativeCliRunner).not.toHaveBeenCalled();
    await expect(fs.pathExists(configPath)).resolves.toBe(false);

    const declined = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user',
    }, {
      env: isolation.env,
      nativeCliRunner,
      codexManagerResolver,
      managedCodexAuthorizer: async () => false,
    });
    expect(declined.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'managedCodexAuthorizationRequired' }),
    ]);
    expect(nativeCliRunner).toHaveBeenCalled();
    expect(nativeCliRunner.mock.calls.every(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);
    await expect(fs.pathExists(configPath)).resolves.toBe(false);

    const installedResult = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user', allowManagedCodexInstall: true,
    }, { env: isolation.env, nativeCliRunner, codexManagerResolver });
    expect(installedResult.overallState, JSON.stringify(installedResult.rebuildResults))
      .toBe('succeeded');
    expect(codexManagerResolver).toHaveBeenCalledTimes(2);
    expect(nativeCliRunner).toHaveBeenCalled();

    const blockedSharedReinstall = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user', allowManagedCodexInstall: true,
    }, { env: isolation.env, nativeCliRunner, codexManagerResolver, directCli: true });
    expect(blockedSharedReinstall.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'sharedNativeImpactAuthorizationRequired' }),
    ]);
    expect(codexManagerResolver).toHaveBeenCalledTimes(3);

    const authorizedSharedReinstall = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user', allowManagedCodexInstall: true, yes: true,
    }, { env: isolation.env, nativeCliRunner, codexManagerResolver, directCli: true });
    expect(authorizedSharedReinstall.overallState, JSON.stringify(authorizedSharedReinstall.rebuildResults))
      .toBe('succeeded');
    expect(codexManagerResolver).toHaveBeenCalledTimes(4);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user', allowManagedCodexInstall: true,
    }, { env: isolation.env, nativeCliRunner, codexManagerResolver });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(codexManagerResolver).toHaveBeenCalledTimes(4);
    const materializationCalls = nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        !== 'plugin list --marketplace aw --json');
    expect(materializationCalls.every(([invocation]) =>
      invocation.command === manager.command && invocation.args[0] === manager.argsPrefix[0]))
      .toBe(true);
    codexManagerResolver.mockClear();
    nativeCliRunner.mockClear();

    const alreadyClean = await uninstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user',
    }, { env: isolation.env, nativeCliRunner, codexManagerResolver });
    expect(alreadyClean.overallState, JSON.stringify(alreadyClean.rebuildResults)).toBe('succeeded');
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(nativeCliRunner).toHaveBeenCalledTimes(2);
    expect(nativeCliRunner.mock.calls.every(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);

    nativeCliRunner.mockClear();
    const noOp = await uninstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex', scope: 'user',
    }, { env: isolation.env, nativeCliRunner, codexManagerResolver });
    expect(noOp.overallState, JSON.stringify(noOp.rebuildResults)).toBe('succeeded');
    expect(nativeCliRunner).toHaveBeenCalledTimes(1);
    expect(nativeCliRunner.mock.calls.every(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);
  });

  it('replans with managed registration before shared replacement writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'managed-replan-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.version = '2.0.0';
      },
    }]);
    await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    });

    const manager = {
      kind: 'aw-managed' as const,
      version: '0.151.0',
      command: '/managed/node',
      argsPrefix: ['/managed/codex.js'],
    };
    let registeredVersion: string | undefined = '1.0.0';
    const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const cacheRoot = path.join(
      isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo',
    );
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = invocation.args.slice(pluginIndex);
      if (invocation.command === 'codex' && args[1] === 'list' && args.includes('--json')) {
        throw Object.assign(new Error('system Codex is unavailable'), { code: 'ENOENT' });
      }
      if (invocation.command === manager.command && args[1] === 'list' && args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: registeredVersion ? [{
              pluginId: 'demo@aw',
              installed: true,
              enabled: true,
              version: registeredVersion,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      if (invocation.command === manager.command && args[1] === 'remove') {
        registeredVersion = undefined;
        installedRuntime.installed.delete('demo@aw');
        await fs.remove(cacheRoot);
        await applyCodexConfigTransactionFile(configPath, {
          removePluginActivations: ['demo@aw'],
        });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.command === manager.command && args[1] === 'add') {
        registeredVersion = '2.0.0';
        installedRuntime.installed.add('demo@aw');
        await fs.copy(
          path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo'),
          path.join(cacheRoot, registeredVersion),
          { overwrite: true },
        );
        await applyCodexConfigTransactionFile(configPath, {
          upsertPluginActivations: { 'demo@aw': true },
        });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });
    const codexManagerResolver = vi.fn(async (options: {
      authorizer?: () => Promise<boolean>;
    }) => {
      if (!options.authorizer || !await options.authorizer()) {
        throw new CodexManagerError(
          'managedCodexAuthorizationRequired',
          'Explicit authorization is required.',
        );
      }
      return manager;
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
      codexManagerResolver,
      directCli: true,
    };
    const configBefore = await fs.readFile(configPath);
    const callsBeforeBlocked = nativeCliRunner.mock.calls.length;

    const blocked = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      allowManagedCodexInstall: true,
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'sharedNativeImpactAuthorizationRequired' }),
    ]);
    const blockedActions = nativeCliRunner.mock.calls.slice(callsBeforeBlocked)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(blockedActions).not.toContain('plugin remove demo@aw');
    expect(blockedActions).not.toContain('plugin add demo@aw');
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
    await expect(fs.pathExists(path.join(cacheRoot, '1.0.0'))).resolves.toBe(true);

    const callsBeforeAuthorized = nativeCliRunner.mock.calls.length;
    const authorized = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      allowManagedCodexInstall: true,
      yes: true,
    }, runtime);

    expect(authorized.overallState, JSON.stringify(authorized.rebuildResults)).toBe('succeeded');
    const authorizedActions = nativeCliRunner.mock.calls.slice(callsBeforeAuthorized)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(authorizedActions.indexOf('plugin remove demo@aw')).toBeGreaterThanOrEqual(0);
    expect(authorizedActions.indexOf('plugin add demo@aw'))
      .toBeGreaterThan(authorizedActions.indexOf('plugin remove demo@aw'));
    expect(nativeCliRunner.mock.calls.slice(callsBeforeAuthorized).some(([invocation]) =>
      invocation.command === manager.command
      && invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);
    expect(registeredVersion).toBe('2.0.0');
  }, 30_000);

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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          mode: { type: 'string', default: 'safe' },
          labels: {
            type: 'object',
            additionalProperties: { type: 'string' },
            validation: { key: { format: 'identifier' } },
          },
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
      config: { schemaVersion: 2, sources: [source] },
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

    await fs.remove(configPath);
    await expect(statusCommandV7({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      platform: 'codex',
      scope: 'project',
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'needsSync' })] },
    });

    const set = await runPublic([
      'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--scope', 'project', '--apply',
    ]);
    expect(set).toMatchObject({
      exitCode: 0,
      payload: {
        receiptSchemaVersion: 6,
        configWrite: 'succeeded',
        overallState: 'succeeded',
        targetResults: [expect.objectContaining({ state: 'completed' })],
      },
    });
    expect(set.payload).not.toHaveProperty('applySkippedReason');
    expect((await readStore()).values).toEqual({ mode: 'fast' });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

    const unset = await runPublic([
      'config', 'unset', 'team/demo', 'mode', '--scope', 'project', '--apply',
    ]);
    expect(unset).toMatchObject({
      exitCode: 0,
      payload: { receiptSchemaVersion: 6, configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({});
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    await runPublic(['config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--scope', 'project', '--apply']);
    const reset = await runPublic([
      'config', 'reset', 'team/demo', '--scope', 'project', '--yes', '--apply',
    ]);
    expect(reset).toMatchObject({
      exitCode: 0,
      payload: {
        receiptSchemaVersion: 6,
        configWrite: 'succeeded',
        overallState: 'succeeded',
        deleted: true,
      },
    });
    expect((await readStore()).exists).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { labels: { 'bad key': 'preserved' } },
    });
    const partial = await runPublic([
      'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--scope', 'project', '--apply',
    ]);
    expect(partial).toMatchObject({
      exitCode: 1,
      payload: {
        receiptSchemaVersion: 6,
        configWrite: 'succeeded',
        overallState: 'partial',
        applySkippedReason: 'invalidConfig',
        targetResults: [],
        effective: {
          fieldStates: {
            labels: { invalidOverride: { source: 'project' } },
            mode: { effective: { source: 'project', value: 'fast' } },
          },
        },
      },
    });
    expect((await readStore()).values).toEqual({
      labels: { 'bad key': 'preserved' },
      mode: 'fast',
    });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    const repaired = await runPublic([
      'config', 'set', 'team/demo', 'labels', '--value-json', '{"good_key":"repaired"}',
      '--scope', 'project', '--apply',
    ]);
    expect(repaired).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({
      labels: { good_key: 'repaired' },
      mode: 'fast',
    });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

    await runPublic(['config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--scope', 'project', '--apply']);
    const failed = await runPublic([
      'config', 'set', 'team/demo', 'mode', '--value-json', '"fail"', '--scope', 'project', '--apply',
    ]);
    expect(failed).toMatchObject({
      exitCode: 1,
      payload: { configWrite: 'succeeded', overallState: 'partial' },
    });
    expect((await readStore()).values).toEqual({
      labels: { good_key: 'repaired' },
      mode: 'fail',
    });
    const configAfterFailure = await fs.readFile(configPath, 'utf8');
    expect(configAfterFailure).toContain('mode=fast');
    expect(configAfterFailure).not.toContain('mode=fail');
  });

  it.each([
    ['SKILL.md', 'native-sensitive-skill'],
    ['references/secret.md', 'native-sensitive-reference'],
  ] as const)(
    'blocks sensitive config in native %s before live Codex mutations',
    async (leakPath, pluginName) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `${pluginName}-source`);
      const rendererPath = path.join(sourceRoot, 'plugins', pluginName, 'scripts', 'render.mjs');
      const secret = `secret-${pluginName}-value`;
      const writeRenderer = async (leak: boolean) => {
        const skill = leak && leakPath === 'SKILL.md' ? `native ${secret}` : 'native safe';
        const reference = leak && leakPath === 'references/secret.md'
          ? `, "references/secret.md": ${JSON.stringify(secret)}`
          : '';
        await fs.outputFile(rendererPath, [
          'import { readFile } from "node:fs/promises";',
          'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          'console.log(JSON.stringify({ version: 2, artifacts: context.requestedArtifactIds.map((id) => ({',
          '  id, kind: "skill", platform: "codex", target: "codex.skill", state: "present",',
          `  skillKey: ${JSON.stringify(pluginName)}, refreshKeys: [], content: { files: {`,
          `    "SKILL.md": ${JSON.stringify(skill)}, "README.md": "native readme",`,
          `    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"${reference}`,
          '  } }',
          '})) }));',
        ].join('\n'));
      };
      const createFixture = () => createCatalogSnapshotFixture(
        sourceRoot,
        pluginName,
        [],
        'native sensitive fixture\n',
        (manifest) => {
          manifest.marketplace.policy.products = ['CODEX'];
          manifest.config = {
            fields: { secret: { type: 'string', sensitive: true, default: secret } },
          };
          manifest.scripts = {
            artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
          };
          manifest.artifacts = {
            targets: [{
              id: pluginName,
              platform: 'codex',
              scopes: ['user', 'project'],
              target: 'codex.skill',
              delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
              states: ['present'],
              refreshKeys: [],
              skillKey: pluginName,
            }],
          };
        },
      );

      await writeRenderer(false);
      await createFixture();
      const before = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: before.digest,
        env: isolation.env,
      });
      const runtime = createCodexNativeTestRuntime(isolation);
      const installed = await installWriteCommand([`team/${pluginName}`], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);
      expect(installed, JSON.stringify(installed, null, 2))
        .toMatchObject({ overallState: 'succeeded' });

      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const pluginId = `${pluginName}@aw`;
      const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
      const installedBefore = new Set(runtime.installed);
      const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
      const configBefore = await fs.readFile(configPath);
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const projectConfigBefore = await fs.readFile(projectConfigPath).catch(() => undefined);

      await writeRenderer(true);
      await createFixture();
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const callsBeforeSync = runtime.nativeCliRunner.mock.calls.length;
      const result = await syncWriteCommand([`team/${pluginName}`], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);

      expect(result, JSON.stringify(result, null, 2)).toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({
          state: 'failed', errorCode: 'codexNativeRenderSensitiveValue',
        })],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
      const mutationCalls = runtime.nativeCliRunner.mock.calls.slice(callsBeforeSync)
        .filter(([invocation]) => {
          const pluginIndex = invocation.args.indexOf('plugin');
          const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
          return args[1] === 'add' || args[1] === 'remove'
            || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        });
      expect(mutationCalls).toEqual([]);
      await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
      expect(await fs.readFile(projectConfigPath).catch(() => undefined)).toEqual(projectConfigBefore);
      expect(runtime.installed).toEqual(installedBefore);
      expect(runtime.installed).toContain(pluginId);
    },
    30_000,
  );

  it('blocks a sensitive user override found only in a static native Skill before Codex mutations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'static-sensitive-source');
    const pluginName = 'static-sensitive';
    const skillKey = 'static-sensitive-skill';
    const secret = 'user-static-sensitive-token';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
      manifest.config = {
        fields: { secret: { type: 'string', sensitive: true, default: 'safe-default' } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'static sensitive\n', configureManifest);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'SKILL.md'),
        `static payload ${secret}\n`,
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'static sensitive\n', configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret },
    });
    const runtime = createCodexNativeTestRuntime(isolation);

    const result = await installWriteCommand([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexNativeRenderSensitiveValue',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team')))
      .resolves.toBe(false);
    expect(runtime.installed).toEqual(new Set());
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
  }, 30_000);

  it('blocks activation-only reuse when current canonical native Skills contain a sensitive user value', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-sensitive-source');
    const pluginName = 'activation-sensitive';
    const skillKey = 'activation-sensitive-skill';
    const secret = 'existing-static-sensitive-token';
    const safeDefault = 'non-skill-sensitive-default';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
      manifest.config = {
        fields: { secret: { type: 'string', sensitive: true, default: safeDefault } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], `${safeDefault}\n`, configureManifest);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'SKILL.md'),
        `static payload ${secret}\n`,
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], `${safeDefault}\n`, configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret },
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
    const userConfigPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    const userConfigBefore = await fs.readFile(userConfigPath);
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const projectConfigBefore = await fs.readFile(projectConfigPath).catch(() => undefined);
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;

    const result = await installWriteCommand([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexNativeRenderSensitiveValue',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(userConfigPath)).resolves.toEqual(userConfigBefore);
    expect(await fs.readFile(projectConfigPath).catch(() => undefined)).toEqual(projectConfigBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
    expect(runtime.installed).toContain(`${pluginName}@aw`);
  }, 30_000);

  it('rejects a Windows-style parent Skills root before activation-only sensitive scanning', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unsafe-native-skills-root-source');
    const pluginName = 'unsafe-native-skills-root';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.skills = './skills';
      manifest.config = {
        fields: { secret: { type: 'string', sensitive: true, default: 'safe-default' } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'safe-default\n', configureManifest);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', pluginName, 'skills', 'safe', 'SKILL.md'),
      '# Safe\n',
    );
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', pluginName, 'skills', 'safe', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'safe-default\n', configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    await expect(installWriteCommand([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret: 'sensitive-value' },
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const codexManifestPath = path.join(
      marketplaceRoot,
      'plugins',
      pluginName,
      '.codex-plugin',
      'plugin.json',
    );
    const codexManifest = await fs.readJson(codexManifestPath);
    await fs.outputJson(codexManifestPath, { ...codexManifest, skills: '..\\outside' });
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;

    const result = await installWriteCommand([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexNativeSkillsRootInvalid',
      })],
    });
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
  }, 30_000);

  it('requires --yes for native-refreshing user config with only a project Codex intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'shared-native-config-source');
    const rendererMarker = path.join(isolation.layout.fixtureCwd, 'native-config-renderer.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'native-config', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const mode = context.config.values.mode;',
      'if (mode === "fail") throw new Error("native renderer requested failure");',
      `await appendFile(${JSON.stringify(rendererMarker)}, JSON.stringify({ cwd: process.cwd(), context }) + "\\n");`,
      'console.log(JSON.stringify({ version: 2, artifacts: context.requestedArtifactIds.map((id) => ({',
      '  id, kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: mode === "off" ? "disabled" : "present",',
      '  skillKey: "native-config", refreshKeys: ["mode"],',
      '  ...(mode === "off" ? { disabledReason: "disabled by user config" } : { content: { files: {',
      '    "SKILL.md": `mode=${context.config.values.mode}\\nrequestScope=${context.scope}\\nconfigScope=${context.config.targetScope}\\n`,',
      '    "README.md": "native readme",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } } })',
      '})) }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'native-config', [], 'native\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.config = {
        fields: {
          mode: { type: 'string', default: 'safe' },
          projectMode: { type: 'string', default: 'project-default' },
        },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'native-config',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          states: ['present', 'disabled'],
          refreshKeys: ['mode'],
          skillKey: 'native-config',
        }],
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      schemaVersion: 1,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/native-config', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: [] },
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner: runtime.nativeCliRunner,
      });
      return {
        exitCode,
        payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
      };
    };
    const readStore = () => readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'native-config',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'native-config',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { projectMode: 'project-only' },
    });
    const legacyProjectSkillsRoot = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
    );
    const legacyProjectSkillRoot = path.join(legacyProjectSkillsRoot, 'native-config');
    await fs.outputFile(path.join(legacyProjectSkillRoot, 'SKILL.md'), 'legacy owned\n');
    await writeSkillOwnerMarker({
      skillRoot: legacyProjectSkillRoot,
      allowedRoot: legacyProjectSkillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/native-config',
        plugin: 'native-config',
        artifactKey: 'native-config',
        platform: 'codex',
        scope: 'project',
      },
    });
    const legacyUserSkillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    const legacyUserSkillRoot = path.join(legacyUserSkillsRoot, 'native-config');
    await fs.outputFile(path.join(legacyUserSkillRoot, 'SKILL.md'), 'legacy user owned\n');
    await writeSkillOwnerMarker({
      skillRoot: legacyUserSkillRoot,
      allowedRoot: legacyUserSkillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/native-config',
        plugin: 'native-config',
        artifactKey: 'native-config',
        platform: 'codex',
        scope: 'user',
      },
    });

    expect(await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"saved"', '--scope', 'user',
    ])).toMatchObject({ exitCode: 0, payload: { applySkippedReason: 'notRequested' } });

    const blocked = await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"blocked"', '--scope', 'user', '--apply',
    ]);
    expect(blocked).toMatchObject({
      exitCode: 1,
      payload: {
        overallState: 'failed',
        errors: [expect.objectContaining({ code: 'sharedNativeConfigApplyConfirmationRequired' })],
      },
    });
    expect((await readStore()).values).toEqual({ mode: 'saved' });

    const authorized = await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"authorized"', '--scope', 'user', '--apply', '--yes',
    ]);
    expect(authorized, JSON.stringify(authorized, null, 2)).toMatchObject({
      exitCode: 0,
      payload: {
        configWrite: 'succeeded',
        overallState: 'succeeded',
      },
    });
    expect((await readStore()).values).toEqual({ mode: 'authorized' });

    const [canonicalPluginId] = [...runtime.installed];
    expect(canonicalPluginId).toBe('native-config@aw');
    const cachePluginRoot = path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins',
      'cache',
      'aw',
      'native-config',
      '1.0.0',
    );
    const marketplacePluginRoot = path.join(
      isolation.env.AW_HOME!,
      'marketplaces',
      'team',
      'plugins',
      'native-config',
    );
    const cacheSkillRoot = path.join(cachePluginRoot, 'codex', 'skills', 'native-config');
    const marketplaceSkillRoot = path.join(
      marketplacePluginRoot,
      'codex',
      'skills',
      'native-config',
    );
    const directUserSkillRoot = legacyUserSkillRoot;
    const directProjectSkillRoot = legacyProjectSkillRoot;
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=authorized\nrequestScope=user\nconfigScope=user\n');
    await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=authorized\nrequestScope=user\nconfigScope=user\n');
    await expect(fs.pathExists(path.join(cacheSkillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(marketplaceSkillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
    await expect(fs.pathExists(directUserSkillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(directProjectSkillRoot)).resolves.toBe(false);
    const firstReceipt = await fs.readJson(
      path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    ) as { configDigest: string; targets: Array<{ configDigest: string }> };
    expect(firstReceipt.targets).toHaveLength(1);
    const firstRenderEvents = (await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as {
        cwd: string;
        context: { plugin: { rootDir: string }; config: { schema: object; values: object } };
      });
    expect(firstRenderEvents).toHaveLength(1);
    expect(firstRenderEvents[0]!.cwd).toBe(firstRenderEvents[0]!.context.plugin.rootDir);
    expect(firstRenderEvents[0]!.cwd).not.toBe(isolation.layout.fixtureCwd);
    expect(firstRenderEvents[0]!.context.config.schema).not.toHaveProperty('projectMode');
    expect(firstRenderEvents[0]!.context.config.values).not.toHaveProperty('projectMode');

    const statusBinRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'native-config-status-prefix'),
      '0.151.0',
    );
    const readNativeStatus = async () => {
      const statusRunner = vi.fn(runtime.nativeCliRunner);
      setNativeCliRunnerOverrideForTests(statusRunner);
      try {
        const status = await statusCommandV7({
          plugins: ['team/native-config'],
          cwd: isolation.layout.fixtureCwd,
          env: { ...isolation.env, PATH: statusBinRoot },
          cliVersion: '1.0.0',
          platform: 'codex',
          scope: 'project',
          json: true,
        });
        return { status, statusRunner };
      } finally {
        setNativeCliRunnerOverrideForTests(null);
      }
    };
    const exactStatus = await readNativeStatus();
    expect(exactStatus.status.payload.targets).toEqual([
      expect.objectContaining({ state: 'ready' }),
    ]);
    expect(statusTargetSharedNative(exactStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'usable', version: '1.0.0' });
    expect(statusTargetActivation(exactStatus.status.payload.targets[0]!))
      .toMatchObject({ user: false, project: true, effective: true });
    expect((await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')).toHaveLength(1);

    expect(await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"drifted"', '--scope', 'user',
    ])).toMatchObject({ exitCode: 0, payload: { applySkippedReason: 'notRequested' } });
    const driftStatus = await readNativeStatus();
    expect(driftStatus.status.payload.targets[0]).toMatchObject({ state: 'needsSync' });
    expect(statusTargetSharedNative(driftStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'replaceable', reason: 'renderDrift' });
    expect(driftStatus.status.payload.targets[0]!.reasons)
      .toContainEqual(expect.objectContaining({ code: 'codexSharedNativeRenderDrift' }));
    expect((await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')).toHaveLength(1);

    await fs.outputFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'stale replay overlay\n');
    const refreshed = await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"refreshed"',
      '--scope', 'user', '--apply', '--yes',
    ]);
    expect(refreshed, JSON.stringify(refreshed, null, 2)).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    const refreshedReceipt = await fs.readJson(
      path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    ) as CodexNativeRenderReceipt;
    expect(refreshedReceipt.configDigest).not.toBe(firstReceipt.configDigest);
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=refreshed\nrequestScope=user\nconfigScope=user\n');
    await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=refreshed\nrequestScope=user\nconfigScope=user\n');
    const refreshedConfig = await readCodexConfigFile(
      path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'),
    );
    const refreshedProjectConfig = await readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    );
    expect(refreshedConfig.snapshot.plugins[canonicalPluginId!]?.enabled).toBe(false);
    expect(refreshedProjectConfig.snapshot.plugins[canonicalPluginId!]?.enabled).toBe(true);

    const canonicalReceiptPath = path.join(
      marketplacePluginRoot,
      CODEX_NATIVE_RENDER_RECEIPT_PATH,
    );
    const canonicalReceipt = await fs.readFile(canonicalReceiptPath);
    const canonicalMarketplaceConfigPath = path.join(
      isolation.env.AW_HOME!,
      'marketplaces',
      'team',
      'config.json',
    );
    const canonicalMarketplaceConfig = await fs.readJson(canonicalMarketplaceConfigPath);
    await fs.outputJson(canonicalMarketplaceConfigPath, {
      ...canonicalMarketplaceConfig,
      sourceIdentity: `sha256:${'f'.repeat(64)}`,
    });
    const mismatchedCanonicalStatus = await readNativeStatus();
    expect(statusTargetSharedNative(mismatchedCanonicalStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'blocked', reason: 'foreign' });
    await fs.outputJson(canonicalMarketplaceConfigPath, canonicalMarketplaceConfig);
    await fs.remove(canonicalReceiptPath);
    const missingCanonicalStatus = await readNativeStatus();
    expect(statusTargetSharedNative(missingCanonicalStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'replaceable', reason: 'renderDrift' });
    await fs.outputFile(canonicalReceiptPath, canonicalReceipt);

    await fs.outputFile(path.join(cacheSkillRoot, 'SKILL.md'), 'tampered\n');
    await fs.outputJson(
      path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      {
        ...refreshedReceipt,
        payloadDigest: await calculateCodexNativeRenderPayloadDigest(cachePluginRoot),
      },
      { spaces: 2 },
    );
    const damagedStatus = await readNativeStatus();
    expect(statusTargetSharedNative(damagedStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'usable', version: '1.0.0' });
    expect(damagedStatus.status.payload.targets[0]).toMatchObject({ state: 'ready' });
    const callsBeforeRepair = runtime.nativeCliRunner.mock.calls.length;
    const repairedTamper = await runPublic([
      'sync', 'team/native-config', '--platform', 'codex', '--scope', 'project', '--yes',
    ]);
    expect(repairedTamper, JSON.stringify(repairedTamper, null, 2))
      .toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    expect(repairedTamper.payload.targetResults).toEqual([
      expect.objectContaining({
        sharedNative: { codexPluginId: canonicalPluginId!, action: 'reuse' },
      }),
    ]);
    const serializedTamperReceipt = JSON.stringify(repairedTamper.payload);
    expect(serializedTamperReceipt).not.toContain('"action":"replace"');
    expect(serializedTamperReceipt).not.toContain('"action":"remove"');
    const repairCalls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeRepair)
      .map(([invocation]) => invocation.args.join(' '));
    expect(repairCalls.some((args) => args.includes('plugin remove native-config@aw'))).toBe(false);
    expect(repairCalls.some((args) => args.includes('plugin add native-config@aw'))).toBe(false);
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toBe('tampered\n');
    await fs.outputFile(path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), '{invalid');
    const unreadableStatus = await readNativeStatus();
    expect(statusTargetSharedNative(unreadableStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'usable', version: '1.0.0' });
    await fs.outputJson(
      path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      refreshedReceipt,
      { spaces: 2 },
    );

    expect(await runPublic([
      'config', 'unset', 'team/native-config', 'mode', '--scope', 'user', '--apply',
    ])).toMatchObject({
      exitCode: 1,
      payload: {
        overallState: 'failed',
        errors: [expect.objectContaining({ code: 'sharedNativeConfigApplyConfirmationRequired' })],
      },
    });
    expect((await readStore()).values).toEqual({ mode: 'refreshed' });

    const authorizedUnset = await runPublic([
      'config', 'unset', 'team/native-config', 'mode', '--scope', 'user', '--apply', '--yes',
    ]);
    expect(authorizedUnset, JSON.stringify(authorizedUnset, null, 2)).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({});
    const finalReceipt = await fs.readJson(
      path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    ) as { configDigest: string };
    expect(finalReceipt.configDigest).not.toBe(refreshedReceipt.configDigest);
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');

    const disabled = await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"',
      '--scope', 'user', '--apply', '--yes',
    ]);
    expect(disabled, JSON.stringify(disabled, null, 2)).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(marketplaceSkillRoot)).resolves.toBe(false);
    await expect(fs.readJson(path.join(cachePluginRoot, '.codex-plugin', 'plugin.json')))
      .resolves.not.toHaveProperty('skills');
    await expect(fs.readJson(path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH)))
      .resolves.toMatchObject({ targets: [{ id: 'native-config', skillKey: 'native-config' }] });
    expect(runtime.installed).toContain(canonicalPluginId!);
    const disabledStatus = await readNativeStatus();
    expect(disabledStatus.status.payload.targets).toEqual([
      expect.objectContaining({ state: 'ready' }),
    ]);
    expect(statusTargetSharedNative(disabledStatus.status.payload.targets[0]!))
      .toMatchObject({ state: 'usable', version: '1.0.0' });

    const marketplaceReceiptBeforeFailure = await fs.readFile(
      path.join(marketplacePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    );
    const failedRender = await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"fail"',
      '--scope', 'user', '--apply', '--yes',
    ]);
    expect(failedRender).toMatchObject({
      exitCode: 1,
      payload: { configWrite: 'succeeded', overallState: 'partial' },
    });
    await expect(fs.pathExists(marketplaceSkillRoot)).resolves.toBe(false);
    await expect(fs.readFile(path.join(marketplacePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH)))
      .resolves.toEqual(marketplaceReceiptBeforeFailure);

    expect(await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"', '--scope', 'user',
    ])).toMatchObject({ exitCode: 0, payload: { applySkippedReason: 'notRequested' } });
    await fs.outputFile(path.join(legacyProjectSkillRoot, 'SKILL.md'), 'legacy project again\n');
    await writeSkillOwnerMarker({
      skillRoot: legacyProjectSkillRoot,
      allowedRoot: legacyProjectSkillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/native-config',
        plugin: 'native-config',
        artifactKey: 'native-config',
        platform: 'codex',
        scope: 'project',
      },
    });
    const userInstalled = await installWriteCommand(['team/native-config'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(userInstalled, JSON.stringify(userInstalled, null, 2))
      .toMatchObject({ overallState: 'succeeded' });
    await expect(fs.pathExists(legacyProjectSkillRoot)).resolves.toBe(false);

    const reset = await runPublic([
      'config', 'reset', 'team/native-config', '--scope', 'user', '--apply', '--yes',
    ]);
    expect(reset, JSON.stringify(reset, null, 2)).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded', deleted: true },
    });
    expect((await readStore()).exists).toBe(false);
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');

    const runInteractiveConfig = async (
      command: 'unset' | 'reset',
      cancelled = false,
    ) => {
      const captured = createCapturedCliIo();
      const launch = vi.fn(async (request: {
        render: (complete: (result: unknown) => void) => {
          props: {
            request: {
              initial: CommandWizardSelection;
              candidates: CommandWizardPluginCandidate[];
              destructive?: boolean;
              execute: (selection: CommandWizardSelection) => Promise<unknown>;
            };
          };
        };
      }) => {
        const wizard = request.render(() => undefined).props.request;
        expect(wizard.destructive).toBe(true);
        if (cancelled) return { cancelled: true };
        const selection: CommandWizardSelection = {
          ...wizard.initial,
          plugins: wizard.initial.plugins.length > 0
            ? wizard.initial.plugins
            : [wizard.candidates[0]!.pluginName],
          scope: 'user',
          ...(command === 'unset' ? { key: 'mode' } : {}),
        };
        return {
          cancelled: false,
          selection,
          value: await wizard.execute(selection),
        };
      });
      const args = command === 'unset'
        ? ['config', 'unset', 'team/native-config', '--scope', 'user', '--apply']
        : ['config', 'reset', 'team/native-config', '--scope', 'user', '--apply'];
      const exitCode = await runCli(args, {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: true,
        tuiRunner: { launch } as never,
        nativeCliRunner: runtime.nativeCliRunner,
        ...createTtyRuntimeStreams(),
      });
      return {
        exitCode,
        launch,
        stdout: captured.readStdout(),
        stderr: captured.readStderr(),
      };
    };

    await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"',
      '--scope', 'user', '--apply', '--yes',
    ]);
    const interactiveUnset = await runInteractiveConfig('unset');
    expect(interactiveUnset, JSON.stringify(interactiveUnset)).toMatchObject({ exitCode: 0 });
    expect((await readStore()).values).toEqual({});
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');

    await runPublic([
      'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"',
      '--scope', 'user', '--apply', '--yes',
    ]);
    await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
    const callsBeforeCancelledReset = runtime.nativeCliRunner.mock.calls.length;
    await expect(runInteractiveConfig('reset', true)).resolves.toMatchObject({ exitCode: 0 });
    expect((await readStore()).values).toEqual({ mode: 'off' });
    expect(runtime.nativeCliRunner).toHaveBeenCalledTimes(callsBeforeCancelledReset);
    await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
    await expect(runInteractiveConfig('reset')).resolves.toMatchObject({ exitCode: 0 });
    expect((await readStore()).exists).toBe(false);
    await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');
  }, 60_000);

  it('separates mixed native Skill and AW role renderer requests', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-native-render-source');
    const rendererMarker = path.join(isolation.layout.fixtureCwd, 'mixed-native-renderer.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'mixed-native', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(rendererMarker)}, JSON.stringify({ ids: context.requestedArtifactIds, scope: context.scope, configScope: context.config.targetScope }) + "\\n");`,
      'const artifacts = context.requestedArtifactIds.map((id) => id === "native-skill" ? ({',
      '  id, kind: "skill", platform: "codex", target: "codex.skill", state: "present",',
      '  skillKey: "native-skill", refreshKeys: [], content: { files: {',
      '    "SKILL.md": "native mixed", "README.md": "native mixed readme",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } }',
      '}) : ({',
      '  id, kind: "codexRole", platform: "codex", target: "codex.agentRole", state: "present",',
      '  roleKey: "helper", refreshKeys: [], content: {',
      '    registration: { description: "Helper role." },',
      '    roleFile: { name: "helper", description: "Helper role.", developer_instructions: "Help." }',
      '  }',
      '}));',
      'console.log(JSON.stringify({ version: 2, artifacts }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'mixed-native', [], 'mixed\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [
          {
            id: 'native-skill',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.skill',
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
            states: ['present'],
            refreshKeys: [],
            skillKey: 'native-skill',
          },
          {
            id: 'aw-role',
            platform: 'codex',
            scopes: ['project'],
            target: 'codex.agentRole',
            states: ['present'],
            refreshKeys: [],
            roleKey: 'helper',
            requiresCodexProjectConfig: true,
          },
        ],
      };
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const installed = await installWriteCommand(['team/mixed-native'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(installed, JSON.stringify(installed, null, 2)).toMatchObject({ overallState: 'succeeded' });

    const events = (await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { ids: string[]; scope: string; configScope: string });
    expect(events).toContainEqual({ ids: ['aw-role'], scope: 'project', configScope: 'project' });
    expect(events).toContainEqual({ ids: ['native-skill'], scope: 'user', configScope: 'user' });
    expect(events.every((event) => event.ids.length === 1)).toBe(true);
    await expect(fs.readFile(path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-mixed-native-helper.toml',
    ), 'utf8')).resolves.toContain('developer_instructions = "Help."');
    await expect(fs.readFile(path.join(
      isolation.env.AW_CODEX_HOME!,
      'plugins',
      'cache',
      'aw',
      'mixed-native',
      '1.0.0',
      'codex',
      'skills',
      'native-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toBe('native mixed');

  });

  it('runs codex-enhance shared Skills and project roles through public commands', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const sourcePluginRoot = path.join(repositoryRoot, 'plugins', 'codex-enhance');
    const authoringRoot = path.join(isolation.layout.fixtureCwd, 'codex-enhance-authoring');
    await fs.copy(
      path.join(repositoryRoot, 'plugins', 'marketplace-source.json'),
      path.join(authoringRoot, 'plugins', 'marketplace-source.json'),
    );
    await fs.copy(sourcePluginRoot, path.join(authoringRoot, 'plugins', 'codex-enhance'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), {
      schemaVersion: 1,
      kind: 'catalog',
      workspaceIdentity: `fixture:${crypto.createHash('sha256').update(sourceRoot).digest('hex')}`,
      sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${sourceRoot}`).digest('hex')}`,
    });
    const manifest = await fs.readJson(path.join(
      sourceRoot, 'plugins', 'codex-enhance', '.agents-plugin', 'plugin.json',
    ));
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const runtime = createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner: runtime.nativeCliRunner,
      });
      return { exitCode, payload: JSON.parse(captured.readStdout()) as Record<string, unknown> };
    };

    expect(await runPublic([
      'config', 'set', 'team/codex-enhance', 'standardProfile', '--scope', 'project',
      '--value-json', '{"model":"project-standard","reasoningEffort":"max"}',
    ])).toMatchObject({ exitCode: 0, payload: { applySkippedReason: 'notRequested' } });
    const projectInstall = await runPublic([
      'install', 'team/codex-enhance', '--platform', 'codex', '--scope', 'project',
    ]);
    expect(projectInstall, JSON.stringify(projectInstall, null, 2))
      .toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    const cacheRoot = path.join(
      isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'codex-enhance', manifest.version,
    );
    const marketplaceRoot = path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'codex-enhance',
    );
    const skillPaths = ['codex-explore', 'codex-subagent-guide'].map((skill) =>
      path.join(cacheRoot, 'codex', 'skills', skill, 'SKILL.md'));
    for (const skillPath of skillPaths) await expect(fs.pathExists(skillPath)).resolves.toBe(true);
    for (const skill of ['codex-explore', 'codex-subagent-guide']) {
      await expect(fs.pathExists(path.join(isolation.env.AW_CODEX_HOME!, 'skills', skill)))
        .resolves.toBe(false);
    }
    const initialSkillBytes = await Promise.all(skillPaths.map((skillPath) => fs.readFile(skillPath)));
    const initialReceipt = await fs.readJson(
      path.join(cacheRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    ) as CodexNativeRenderReceipt;
    expect(initialReceipt.targets.map((target) => target.skillKey)).toEqual([
      'codex-explore', 'codex-subagent-guide',
    ]);
    const projectStore = await readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'codex-enhance', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(projectStore.values.standardProfile).toEqual({
      model: 'project-standard', reasoningEffort: 'max',
    });
    await expect(fs.readFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents',
      'aw-codex-enhance-codex-explore-standard.toml',
    ), 'utf8')).resolves.toContain('model = "project-standard"');
    for (const [index, skillPath] of skillPaths.entries()) {
      await expect(fs.readFile(skillPath)).resolves.toEqual(initialSkillBytes[index]);
    }
    const projectOnlyConfig = await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ));
    const projectOnlyUserConfig = await readCodexConfigFile(path.join(
      isolation.env.AW_CODEX_HOME!, 'config.toml',
    ));
    expect(projectOnlyConfig.snapshot.plugins['codex-enhance@aw']?.enabled).toBe(true);
    expect(projectOnlyUserConfig.snapshot.plugins['codex-enhance@aw']?.enabled).not.toBe(true);

    expect(await runPublic([
      'config', 'set', 'team/codex-enhance', 'exploreMinimumInitialWaitMinutes',
      '--scope', 'project', '--value-json', '15',
    ])).toMatchObject({
      exitCode: 1,
      payload: { errors: [expect.objectContaining({ code: 'sharedNativeConfigUserScopeRequired' })] },
    });
    const projectStoreAfterReject = await readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'codex-enhance', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(projectStoreAfterReject.values).not.toHaveProperty('exploreMinimumInitialWaitMinutes');

    const userInstall = await runPublic([
      'install', 'team/codex-enhance', '--platform', 'codex', '--scope', 'user',
    ]);
    expect(userInstall, JSON.stringify(userInstall, null, 2))
      .toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    await expect(fs.pathExists(path.join(
      isolation.env.AW_CODEX_HOME!, 'agents', 'aw-codex-enhance-codex-explore-standard.toml',
    ))).resolves.toBe(true);
    const userUninstall = await runPublic([
      'uninstall', 'team/codex-enhance', '--platform', 'codex', '--scope', 'user',
    ]);
    expect(userUninstall, JSON.stringify(userUninstall, null, 2))
      .toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    expect(await runPublic([
      'install', 'team/codex-enhance', '--platform', 'codex', '--scope', 'project',
    ])).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });

    const receiptBeforeWaitSave = await fs.readJson(
      path.join(cacheRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    );
    const skillsBeforeWaitSave = await Promise.all(
      skillPaths.map((skillPath) => fs.readFile(skillPath)),
    );
    expect(await runPublic([
      'config', 'set', 'team/codex-enhance', 'exploreMinimumInitialWaitMinutes',
      '--scope', 'user', '--value-json', '15',
    ])).toMatchObject({ exitCode: 0, payload: { applySkippedReason: 'notRequested' } });
    await expect(fs.readJson(path.join(cacheRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH)))
      .resolves.toEqual(receiptBeforeWaitSave);
    for (const [index, skillPath] of skillPaths.entries()) {
      await expect(fs.readFile(skillPath)).resolves.toEqual(skillsBeforeWaitSave[index]);
    }
    const statusBinRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'codex-enhance-status-prefix'),
      '0.200.0',
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    const status = await statusCommandV7({
      plugins: ['team/codex-enhance'], platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, PATH: statusBinRoot },
      cliVersion: '1.0.0', json: true,
    }).finally(() => setNativeCliRunnerOverrideForTests(null));
    expect(status.payload.targets[0], JSON.stringify(status.payload.targets[0], null, 2))
      .toMatchObject({ state: 'needsSync' });
    expect(statusTargetSharedNative(status.payload.targets[0]!))
      .toMatchObject({ state: 'replaceable', reason: 'renderDrift' });
    expect(await runPublic([
      'config', 'set', 'team/codex-enhance', 'exploreMinimumInitialWaitMinutes',
      '--scope', 'user', '--value-json', '20', '--apply',
    ])).toMatchObject({
      exitCode: 1,
      payload: { errors: [expect.objectContaining({ code: 'sharedNativeConfigApplyConfirmationRequired' })] },
    });
    const storeAfterReject = await readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'codex-enhance', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(storeAfterReject.values.exploreMinimumInitialWaitMinutes).toBe(15);

    expect(await runPublic([
      'config', 'set', 'team/codex-enhance', 'exploreMinimumInitialWaitMinutes',
      '--scope', 'user', '--value-json', '20', '--apply', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    const replacedReceipt = await fs.readJson(
      path.join(cacheRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    ) as CodexNativeRenderReceipt;
    expect(replacedReceipt.configDigest).not.toBe(initialReceipt.configDigest);
    await expect(fs.readFile(path.join(
      marketplaceRoot, 'codex', 'skills', 'codex-explore', 'SKILL.md',
    ), 'utf8')).resolves.toContain('至少 `20` 分钟');
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins['codex-enhance@aw']?.enabled).not.toBe(true);
    expect(projectConfig.snapshot.plugins['codex-enhance@aw']?.enabled).toBe(true);
  });
});
