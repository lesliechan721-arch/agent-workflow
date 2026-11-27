import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { parse as parseYaml } from 'yaml';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { writeNodeScriptFixture } from '../support/plugin-scripts-node-fixture.js';
import {
  activateSmokeBuildSnapshot,
  cleanupSmokeBuildSnapshot,
  createSmokeBuildSnapshot,
  importSmokeSnapshotModule,
  type SmokeBuildSnapshot,
} from '../support/smoke-build-snapshot.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
let buildSnapshot: SmokeBuildSnapshot | null = null;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function makeTempRepo(): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-scripts-smoke-'));
  tempDirs.push(tempRoot);
  registerSmokeWritableRoot(tempRoot, 'plugin scripts smoke temp root');
  const tempRepo = path.join(tempRoot, 'repo');
  registerSmokeWritableRoot(tempRepo, 'plugin scripts smoke repo root');
  await fs.copy(fixturePath('repo-template'), tempRepo);
  return tempRepo;
}

async function requireBuildSnapshot(): Promise<SmokeBuildSnapshot> {
  if (!buildSnapshot) {
    throw new Error('Plugin scripts smoke snapshot is not initialized.');
  }
  return activateSmokeBuildSnapshot(buildSnapshot);
}

async function workspacePnpmStoreDir(root: string): Promise<string> {
  const modulesManifest = parseYaml(
    await fs.readFile(path.join(root, 'node_modules', '.modules.yaml'), 'utf8'),
  ) as { storeDir?: unknown };
  if (typeof modulesManifest.storeDir !== 'string' || !path.isAbsolute(modulesManifest.storeDir)) {
    throw new Error('Workspace pnpm install does not declare an absolute storeDir.');
  }
  if (!await fs.pathExists(modulesManifest.storeDir)) {
    throw new Error(`Workspace pnpm store does not exist: ${modulesManifest.storeDir}`);
  }
  return modulesManifest.storeDir;
}

async function createPnpmStoreView(
  sourceStoreDir: string,
  targetStoreDir: string,
  packageIds: readonly string[],
): Promise<void> {
  const sourceFilesDir = path.join(sourceStoreDir, 'files');
  const sourceIndexDir = path.join(sourceStoreDir, 'index');
  if (!await fs.pathExists(sourceFilesDir) || !await fs.pathExists(sourceIndexDir)) {
    throw new Error('Workspace pnpm store is missing files or index.');
  }

  const indexPrefixes = await fs.readdir(sourceIndexDir);
  for (const packageId of packageIds) {
    let sourceIndexPath: string | undefined;
    for (const prefix of indexPrefixes) {
      const prefixDir = path.join(sourceIndexDir, prefix);
      const indexName = (await fs.readdir(prefixDir)).find((name) =>
        name.endsWith(`-${packageId}.json`));
      if (indexName) {
        sourceIndexPath = path.join(prefixDir, indexName);
        break;
      }
    }
    if (!sourceIndexPath) {
      throw new Error(`Workspace pnpm store is missing ${packageId}.`);
    }

    const index = await fs.readJson(sourceIndexPath) as {
      files: Record<string, { integrity: string; mode: number }>;
    };
    const targetIndexPath = path.join(
      targetStoreDir,
      'index',
      path.relative(sourceIndexDir, sourceIndexPath),
    );
    await fs.ensureDir(path.dirname(targetIndexPath));
    await fs.copyFile(sourceIndexPath, targetIndexPath);
    for (const file of Object.values(index.files)) {
      const digest = Buffer.from(file.integrity.slice('sha512-'.length), 'base64').toString('hex');
      const relativePath = path.join(
        digest.slice(0, 2),
        `${digest.slice(2)}${(file.mode & 0o111) === 0 ? '' : '-exec'}`,
      );
      const targetPath = path.join(targetStoreDir, 'files', relativePath);
      if (!await fs.pathExists(targetPath)) {
        await fs.ensureDir(path.dirname(targetPath));
        await fs.copyFile(path.join(sourceFilesDir, relativePath), targetPath);
      }
    }
  }
}

async function pathWithoutPackageManagerBins(runtimeBinDir: string): Promise<string> {
  await fs.ensureDir(runtimeBinDir);
  const nodeEntry = path.join(runtimeBinDir, path.basename(process.execPath));
  await fs.copyFile(process.execPath, nodeEntry);
  if (process.platform !== 'win32') {
    await fs.chmod(nodeEntry, 0o755);
  }
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const safeEntries: string[] = [runtimeBinDir];
  for (const entry of entries) {
    const containsPackageManager = await Promise.all(
      ['corepack', 'corepack.cmd', 'pnpm', 'pnpm.cmd'].map((name) =>
        fs.pathExists(path.join(entry, name))),
    );
    if (!containsPackageManager.some(Boolean)) {
      safeEntries.push(entry);
    }
  }
  return safeEntries.join(path.delimiter);
}

beforeAll(async () => {
  buildSnapshot = await createSmokeBuildSnapshot(repoRoot());
});

afterAll(async () => {
  await cleanupSmokeBuildSnapshot(buildSnapshot);
  buildSnapshot = null;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin scripts staging smoke', () => {
  // Test Value Gate: a detached renderer and installed command package must preserve
  // the native text closure without restoring PE files to the Skill.
  it('preserves Windows tool protocols and readers without PE through the real Guide renderer and installed command', async () => {
    const snapshot = await requireBuildSnapshot();
    const temporary = await makeTempRepo();
    const bundle = path.join(temporary, 'detached-plugin');
    await fs.copy(path.join(snapshot.catalogOutputRoot, 'plugins', 'agent-subagent'), bundle);
    const bridge = await fs.readFile(path.join(bundle, 'commands/scripts/runtime/windows-native.mjs'), 'utf8');
    expect(bridge.includes('aw-plugin-staging-'), 'the delivered bridge embeds a temporary build directory').toBe(false);
    const manifests = await importSmokeSnapshotModule<typeof import('../../src/utils/manifest.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'manifest.js'));
    const renderer = await importSmokeSnapshotModule<typeof import('../../src/utils/artifact-renderer.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'artifact-renderer.js'));
    const finalization = await importSmokeSnapshotModule<typeof import('../../src/utils/component-command-preparation.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'component-command-preparation.js'));
    const commands = await importSmokeSnapshotModule<typeof import('../../src/utils/managed-command-store.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'managed-command-store.js'));
    const materialization = await importSmokeSnapshotModule<typeof import('../../src/utils/managed-command-materialization.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'managed-command-materialization.js'));
    const profiles = await importSmokeSnapshotModule<typeof import('../../src/review/platform-profile.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'review', 'platform-profile.js'));
    const authoring = await importSmokeSnapshotModule<typeof import('../../src/review/skill-materialization.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'review', 'skill-materialization.js'));
    const layouts = await importSmokeSnapshotModule<typeof import('../../src/platforms/layout.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'platforms', 'layout.js'));
    const projection = await importSmokeSnapshotModule<typeof import('../../src/platforms/projection.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'platforms', 'projection.js'));
    const digests = await importSmokeSnapshotModule<typeof import('../../src/utils/catalog-digests.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'catalog-digests.js'));
    const env = await authoring.createIsolatedSkillEnv(process.env, path.join(temporary, 'state'));
    const plugin = { ...await manifests.readPluginManifest(bundle, { mode: 'bundle' }),
      sourceId: 'fixture', sourceIdentity: await digests.calculateCatalogEntryArtifactDigest(bundle),
      pluginId: 'fixture/agent-subagent' };
    const ctx = { cwd: temporary, env };
    const resolution = await layouts.resolveDeployments(ctx, {
      plugin: { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
        pluginId: plugin.pluginId, version: plugin.manifest.version },
      scope: { kind: 'user' }, operation: 'ensure', recoveryCandidates: [],
      discovery: { platform: 'codex', availability: 'notApplicable', diagnostics: [], installations: [{
        id: 'smoke-fixture:codex', product: 'cli', version: null, availability: 'notApplicable', reasonCodes: [],
        entry: { kind: 'directory', configRoot: env.CODEX_HOME! },
      }] },
    });
    const binding = resolution.bindings[0]!;
    const renderUnit = resolution.renderUnits.find((unit) => unit.kinds.includes('skill'))!;
    expect(binding).toBeDefined();
    expect(renderUnit).toBeDefined();
    const capabilities = profiles.getAuthoringPlatformCapabilities('codex', 'user');
    const configStore = await importSmokeSnapshotModule<typeof import('../../src/utils/plugin-config.js')>(
      path.join(snapshot.cliDistRoot, 'src', 'utils', 'plugin-config.js'));
    const configOptions = { pluginName: plugin.manifest.name, manifest: plugin.manifest,
      sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
      platform: 'codex', scope: 'user', cwd: temporary, env } as const;
    const prepare = (config: Awaited<ReturnType<typeof renderer.resolveArtifactRenderConfig>>) =>
      renderer.preparePlatformComponents({ plugin, platform: 'codex', renderScope: 'user',
        kinds: renderUnit.kinds, capabilities, config, cwd: temporary, commandEnv: env });
    const generalTaskProfile = { executor: 'native' };
    await configStore.writePluginConfigStore({ ...configOptions, values: { generalTaskProfile } });
    const baseline = await prepare(await renderer.resolveArtifactRenderConfig(configOptions));
    expect(baseline.resources.files.some((file) => file.path.startsWith('references/'))).toBe(false);
    const subagentCommands = [{ key: 'local-codex', adapter: 'codex' }];
    await configStore.writePluginConfigStore({ ...configOptions, values: { generalTaskProfile, subagentCommands } });
    const prepared = await prepare(await renderer.resolveArtifactRenderConfig(configOptions));
    expect(prepared.expected.unmet).toEqual([]);
    expect(prepared.expected.components.map(({ id }) => id)).toEqual(['spawn-subagent-skill']);
    expect(prepared.resources.files.some((file) => file.source?.kind === 'bundle')).toBe(true);
    const candidate = await materialization.prepareManagedCommandPackage({
      ...ctx, plugin, operation: { kind: 'platform-sync', platforms: ['codex'] },
    });
    try {
      const finalized = await finalization.finalizePlatformSkillProducers({ plugin, platform: 'codex',
        renderUnit, prepared, skillWorkRoot: path.join(temporary, 'prepared-skills'),
        commandRecord: candidate.record, ...ctx });
      expect(finalized.prepared.expected.unmet).toEqual([]);
      const projected = await projection.projectPlatform({ ...ctx,
        stagingRoot: path.join(temporary, 'native-projection') }, {
        binding, renderUnit, capabilities, components: finalized.prepared.expected.components,
        resources: finalized.prepared.resources, policy: finalized.invocationPolicy.policy,
      });
      expect(projected.bundle).not.toBeNull();
      const component = projected.components.find((item) => item.id === 'spawn-subagent-skill')!;
      const skill = path.join(projected.bundle!.stagingRoot, 'skills', component.nativeName);
      expect(await fs.readFile(path.join(skill, 'references/external-execution.md'), 'utf8'))
        .toContain('aw command run fixture/agent-subagent/codex -- start --executor');
      expect(await fs.readFile(path.join(skill, 'references/executor-selection.md'), 'utf8'))
        .toContain('aw command run fixture/agent-subagent/codex -- inspect --executor');
      await expect(fs.pathExists(path.join(skill, 'scripts/subagent.mjs'))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(skill, '.aw-runtime-config.json'))).resolves.toBe(false);
      const installed = await materialization.publishPreparedManagedCommandPackage({ ...ctx, plugin, candidate });
      const command = await commands.readManagedCommandPackageView(installed.id, env);
      expect(command).toMatchObject({
        selector: 'fixture/agent-subagent', availability: 'ready', runtimeConfigPlatforms: ['codex'],
      });
      const resourceRoot = command.resourceRoot!;
      await expect(fs.pathExists(path.join(resourceRoot, 'scripts', 'introspection', 'inspect.mjs'))).resolves.toBe(true);
      await expect(fs.pathExists(path.join(bundle, 'scripts', 'config-suggestions.mjs'))).resolves.toBe(true);
      expect(await fs.readFile(path.join(resourceRoot, 'assets', 'task-instructions.md'), 'utf8'))
        .toBe(await fs.readFile(path.join(skill, 'assets', 'task-instructions.md'), 'utf8'));
      const nativeTools = (await commands.readInstalledCommandProducer(resourceRoot)).nativeTools;
      expect(nativeTools?.consumers).toEqual([{
        kind: 'plugin-command',
        tools: [{ key: 'windows-job', platforms: ['win32'], policy: 'required' }],
      }]);
      expect(nativeTools?.definitions).toEqual([{ key: 'windows-job', protocol: 'aw.windows-job.v1' }]);
      await expect(fs.pathExists(path.join(resourceRoot, '.aw', 'native-tools'))).resolves.toBe(false);
      const reader = await importSmokeSnapshotModule<{
        readNativeTool(key: string, protocol: string, environment: Record<string, string>): unknown;
      }>(path.join(resourceRoot, '.aw', 'native-tool-reader.mjs'));
      const unavailable = { state: 'unavailable', protocol: 'aw.windows-job.v1', code: 'nativeToolDependencyMissing' };
      expect(reader.readNativeTool('windows-job', unavailable.protocol, {
        AW_NATIVE_TOOL_CONTEXT: JSON.stringify({ schemaVersion: 1, tools: { 'windows-job': unavailable } }),
      })).toEqual(unavailable);
      const runtimeReader = await importSmokeSnapshotModule<typeof reader>(
        path.join(resourceRoot, 'scripts', 'runtime', 'native-tool-reader.mjs'));
      expect(() => runtimeReader.readNativeTool('windows-job', unavailable.protocol, {})).toThrow('nativeContextInvalid');
      const physicalRoot = await fs.realpath(resourceRoot);
      const readerUrl = pathToFileURL(path.join(physicalRoot, '.aw', 'command-runtime-config.mjs')).href;
      const options = {
        from: pathToFileURL(path.join(physicalRoot, 'scripts/subagent.mjs')).href,
        keys: ['subagentCommands', 'subagentRetentionHours'],
      };
      const installedConfig = await execFileAsync(process.execPath, ['--input-type=module', '--eval',
        `import { readCommandRuntimeConfig } from ${JSON.stringify(readerUrl)}; console.log(JSON.stringify(await readCommandRuntimeConfig(${JSON.stringify(options)})));`,
      ], { env: { ...env, AW_COMMAND_RUNTIME_CONFIG: JSON.stringify({
        schemaVersion: 1, packageId: command.packageId, revision: path.basename(resourceRoot), platform: 'codex',
      }) } });
      expect(JSON.parse(installedConfig.stdout)).toMatchObject({ platform: 'codex', values: { subagentCommands, subagentRetentionHours: 24 } });
      async function assertNoPe(directory: string): Promise<void> {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) await assertNoPe(target);
          else if (entry.isFile()) {
            const bytes = await fs.readFile(target);
            const offset = bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ' ? bytes.readUInt32LE(0x3c) : -1;
            expect(offset >= 0 && offset <= bytes.length - 4 && bytes.toString('ascii', offset, offset + 4) === 'PE\0\0', target).toBe(false);
          }
        }
      }
      await assertNoPe(bundle);
      await assertNoPe(resourceRoot);
    } finally { await candidate.cleanup(); }
  }, 120_000);

  it('runs real scripts.node staging through the snapshot compiled entry', async () => {
    const root = repoRoot();
    const snapshot = await requireBuildSnapshot();
    const tempRepo = await makeTempRepo();
    const pnpmStoreDir = path.join(path.dirname(tempRepo), 'pnpm-store', 'v10');
    await createPnpmStoreView(await workspacePnpmStoreDir(root), pnpmStoreDir, [
      'fs-extra@11.3.4',
      'graceful-fs@4.2.11',
      'jsonfile@6.2.1',
      'universalify@2.0.1',
      'yaml@2.8.3',
    ]);
    const childPath = await pathWithoutPackageManagerBins(
      path.join(path.dirname(tempRepo), 'runtime-bin'),
    );
    await writeNodeScriptFixture(tempRepo);

    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'),
    );

    await execFileAsync(
      process.execPath,
      [
        path.join(snapshot.cliDistRoot, 'scripts', 'test-plugin-scripts.js'),
        'git-commit',
        '--test-name',
        'staged smoke generated test',
      ],
      {
        cwd: root,
        env: {
          ...childEnv,
          AW_PLUGIN_TEST_REPO_ROOT: tempRepo,
          COREPACK_ENABLE_NETWORK: '0',
          NO_COLOR: '1',
          PATH: childPath,
          npm_execpath: '',
          npm_config_offline: 'true',
          npm_config_store_dir: pnpmStoreDir,
        },
        maxBuffer: 30 * 1024 * 1024,
        timeout: 120_000,
      },
    );

    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'git-commit', 'scripts', 'generated.test.mjs')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      description: expect.not.stringContaining('Built smoke description'),
      platforms: ['claude'],
      scripts: {
        tests: {
          node: ['./scripts/source-only.test.mjs'],
        },
      },
    });
  }, 120_000);

});
