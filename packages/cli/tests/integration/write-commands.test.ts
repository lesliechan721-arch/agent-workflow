import { describe, expect, it, vi } from 'vitest';

import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../../src/commands/write-commands.js';
import { setRebuildCommandTestHooksForTests } from '../../src/commands/rebuild-command.js';
import {
  setStatusDependencyInspectionHookForTests,
  statusCommandV4,
} from '../../src/commands/status-v4.js';
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
import { updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import {
  readInstallationContract,
  promoteInstallationContract,
  removeInstallationContract,
  resolveInstallationContractTarget,
  stageInstallationContract,
} from '../../src/utils/installation-contract-store.js';

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
  it('installs a dependency closure in dependency-first order and promotes placement contracts', async () => {
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);

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
    const rootContract = await readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(rootContract?.metadata.dependencies).toEqual([
      expect.objectContaining({ pluginId: 'team/middle', scope: 'project' }),
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
          action: 'keep',
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
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all([
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), skillKey: 'leaf-skill', fail: true,
      }),
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'root'), skillKey: 'root-skill',
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

    const result = await installWriteCommand(['team/root'], {
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

    const upgraded = await upgradeWriteCommand([], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', all: true,
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
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review B']);
        await git(workRoot, ['push', source.url, 'HEAD:refs/heads/main']);
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
      const controller = new TuiController(createTuiControllerDependencies(context));
      const review = await controller.buildOperationReview(intent);
      setTuiControllerRuntimeTestHooksForTests({
        afterMutationEvidenceCapture: async () => writeSource('actual C'),
      });
      try {
        return await controller.executeOperation(review.reviewToken);
      } finally {
        setTuiControllerRuntimeTestHooksForTests(undefined);
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

  it('revalidates a dependency issue before dispatch and performs zero platform writes when its consumer contract changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-issue-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: (manifest) => {
        manifest.extensions!.agents = [{ name: 'leaf-role', description: 'Leaf role.', prompt: 'Leaf.' }];
      } },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }));
    const runtime = { env: isolation.env, nativeCliRunner };
    const leafInstall = await installWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(leafInstall.overallState, JSON.stringify(leafInstall.rebuildResults)).toBe('succeeded');
    await expect(installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const leafArtifactPath = path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-leaf-role.toml',
    );
    await expect(fs.pathExists(leafArtifactPath)).resolves.toBe(true);
    await fs.remove(leafArtifactPath);

    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    }));
    const controller = new TuiController(dependencies);
    await controller.load();
    const issue = controller.listUserIssues().find((candidate) =>
      candidate.category === 'dependencyNotReady'
      && candidate.pluginId === 'team/root'
      && candidate.platform === 'codex' && candidate.scope === 'project')!;
    expect(issue, JSON.stringify(controller.listUserIssues())).toBeDefined();
    const action = issue.actions.find((candidate) => candidate.id === 'reinstallDependency')!;
    expect(action).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'project', project: 'current',
    });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'reinstall', pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      originIssue: {
        issueId: issue.issueId, issueKey: userIssueKey(issue), category: issue.category, actionId: action.id,
        consumerPluginId: issue.pluginId, consumerSourceIdentity: issue.sourceIdentity,
        consumerPlatform: issue.platform, consumerScope: issue.scope,
        dependencyPluginId: issue.dependencyPluginId, dependencyPlatform: issue.dependencyPlatform,
        dependencyScope: issue.dependencyScope, dependencyProject: issue.dependencyProject,
      },
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const rootContract = await resolveInstallationContractTarget({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.remove(rootContract.activeRoot);
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'operationReviewStale',
    });
    await expect(fs.pathExists(leafArtifactPath)).resolves.toBe(false);
  });

  it('blocks a corrupt absent installation-contract namespace before platform writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'corrupt-contract-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'root' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const contractTarget = await resolveInstallationContractTarget({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.outputFile(contractTarget.activeRoot, 'foreign');

    const result = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(false);
  });

  it('blocks a required dependency with zero writes and removes only the successful root contract', async () => {
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const leafBefore = await readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'leaf', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'dependencyStillRequired' })],
    });
    await expect(readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'leaf', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(leafBefore);

    const removedRoot = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(removedRoot.overallState, JSON.stringify(removedRoot.rebuildResults)).toBe('succeeded');
    await expect(readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toBeNull();
    await expect(readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'leaf', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.not.toBeNull();
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    for (const pluginName of ['root', 'middle', 'leaf']) {
      await expect(readInstallationContract({
        sourceId: 'team', sourceIdentity, pluginName, platform: 'codex', scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toBeNull();
    }
  });

  it('allows an absent orphan consumer but retains its contract', async () => {
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const leafTarget = await resolveInstallationContractTarget({
      sourceId: 'team', sourceIdentity, pluginName: 'leaf', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const ghostEntry = (await fs.readJson(path.join(sourceRoot, 'catalog-manifest.json')) as {
      entries: Array<{ name: string; contentDigest: string }>;
    }).entries.find((entry) => entry.name === 'ghost')!;
    const staged = await stageInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'ghost', pluginVersion: '1.0.0',
      contentDigest: ghostEntry.contentDigest, platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      dependencies: [{
        pluginId: 'team/leaf', sourceId: 'team', sourceIdentity, platform: 'codex',
        scope: 'project', projectKey: leafTarget.projectKey,
      }],
    });
    await promoteInstallationContract(staged);

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    await expect(readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'ghost', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.not.toBeNull();
    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-replacement');
    await createDependencyCatalogSnapshotFixture(replacementRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { path: replacementRoot }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).rejects.toMatchObject({ code: 'catalogSourceInUse' });
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
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      await expect(readInstallationContract({
        sourceId: 'team', sourceIdentity, pluginName: 'leaf', platform: 'codex', scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.not.toBeNull();
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    for (const pluginName of ['first', 'second', 'leaf']) {
      await expect(readInstallationContract({
        sourceId: 'team', sourceIdentity, pluginName, platform: 'codex', scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.not.toBeNull();
    }
  });

  it('uses current manifest edges when a live consumer contract is missing', async () => {
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await removeInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });

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
          await fs.outputJson(installedPath, { plugins: {
            ...(installed.plugins ?? {}),
            [pluginId]: [{
              name: pluginName, marketplace: marketplaceName, scope,
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await removeInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'claude', scope: 'project',
      cwd: projectA, env: isolation.env,
    });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'claude', scope: 'user',
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);
    await expect(readInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'leaf', platform: 'claude', scope: 'user',
      cwd: projectB, env: isolation.env,
    })).resolves.not.toBeNull();
  });

  it('keeps outputs and contracts unchanged when cleanup or uninstall cannot resolve the source', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    }));
    await expect(installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const contract = await resolveInstallationContractTarget({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = {
      config: await fs.readFile(configPath, 'utf8'),
      contract: await fs.readFile(path.join(contract.activeRoot, 'metadata.json'), 'utf8'),
    };
    await fs.move(sourceRoot, `${sourceRoot}-offline`);
    nativeCliRunner.mockClear();

    for (const result of [
      await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, { env: isolation.env, nativeCliRunner }),
      await uninstallWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, { env: isolation.env, nativeCliRunner }),
    ]) {
      expect(result.targetResults).toEqual([
        expect.objectContaining({ errorCode: 'catalogSourceUnavailable' }),
      ]);
    }
    expect(nativeCliRunner).not.toHaveBeenCalled();
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before.config);
    await expect(fs.readFile(path.join(contract.activeRoot, 'metadata.json'), 'utf8'))
      .resolves.toBe(before.contract);
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

  it('blocks a user dependency required by a project consumer', async () => {
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
    expect(partialUserDependency.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'dependencyNotReady' }),
    ]));
    const errorUserDependency = await installWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async (invocation) => {
        if (invocation.args[1] === 'list') throw new Error('injected user dependency probe error');
        return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      },
    });
    expect(errorUserDependency.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'dependencyNotReady' }),
    ]));
  });

  it('diagnoses missing, not-ready, and corrupt dependency contracts through public status', async () => {
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const status = () => statusCommandV4({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    await removeInstallationContract({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        state: 'partial',
        errors: [expect.objectContaining({ code: 'dependencyContractMissing' })],
      })] },
    });

    await expect(reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
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
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'dependencyContractInvalid' }),
        ]),
      })] },
    });
    await expect(reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await fs.outputFile(leafAgent, 'foreign');
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        state: 'partial',
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'dependencyNotReady' }),
        ]),
      })] },
    });

    const rootContract = await resolveInstallationContractTarget({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.writeJson(path.join(rootContract.activeRoot, 'metadata.json'), { corrupt: true });
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        state: 'partial',
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'dependencyContractInvalid' }),
        ]),
      })] },
    });
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
      await statusCommandV4({
        plugins: ['team/first', 'team/second'], cwd: isolation.layout.fixtureCwd,
        env: isolation.env, cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setStatusDependencyInspectionHookForTests(undefined);
    }
    expect(dependencyInspections).toBe(1);
  });

  it('reports removed manifest edges and ignores corrupt contracts from another project', async () => {
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const otherProject = path.join(isolation.layout.rootDir, 'other-status-project');
    await fs.ensureDir(otherProject);
    const otherContract = await resolveInstallationContractTarget({
      sourceId: 'team', sourceIdentity, pluginName: 'root', platform: 'codex', scope: 'project',
      cwd: otherProject, env: isolation.env,
    });
    await fs.outputJson(path.join(otherContract.activeRoot, 'metadata.json'), { corrupt: true });
    const status = () => statusCommandV4({
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
      payload: { targets: [expect.objectContaining({
        state: 'partial',
        errors: expect.arrayContaining([expect.objectContaining({ code: 'dependencyContractInvalid' })]),
      })] },
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
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(false);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');
  });

  it('uses the config state observed after target locks are acquired', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-provenance-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'root',
      configureManifest: (manifest) => {
        manifest.config = { schema: { mode: { type: 'string', required: true } } };
      },
    }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'root', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'same' },
    });
    let moved = false;
    setRebuildCommandTestHooksForTests({
      beforeOperationLockAcquire: async () => {
        if (moved) return;
        moved = true;
        await writePluginConfigStore({
          sourceId: 'team', sourceIdentity, pluginName: 'root', scope: 'project', projectLayer: 'local',
          cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'same' },
        });
      },
    });
    try {
      const result = await installWriteCommand(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      });
      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(true);
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }
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
    })).rejects.toThrow('操作未建立。请检查当前设置后重试。');
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
    expect(concurrentResults[1]).toMatchObject({
      status: 'fulfilled',
      value: expect.objectContaining({ configWrite: 'succeeded' }),
    });
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: (await calculateCatalogSourceIdentity({ id: 'team', type: 'path', primary: true, path: sourceRoot })),
      pluginName: 'demo',
      scope: 'project',
      projectLayer: 'shared',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ values: { mode: 'strict' } });
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

  it('treats platform both as every platform supported by each selected plugin', async () => {
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
          await fs.outputJson(installedPath, {
            plugins: {
              ...(installed.plugins ?? {}),
              [pluginId]: [{
                name: pluginName,
                marketplace: marketplaceName,
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
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
    } as const;
    const selectors = ['codex/codex-only', 'claude/claude-only'];

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
    }

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
