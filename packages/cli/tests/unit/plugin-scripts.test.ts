import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import type { InstalledScopeRecord, PluginManifestSource, PluginMeta } from '../../src/types.js';
import {
  buildLifecycleScriptInvocation,
  buildLifecycleSpawnEnv,
  createLifecycleConfigSnapshot,
  garbageCollectLifecycleConfigSnapshots,
  quoteCmdArgument,
  resolveLifecycleScriptTarget,
  resolveLifecycleScriptTimeoutMs,
  runLifecycleScript,
  writeLifecycleScriptContext,
} from '../../src/utils/plugin-scripts.js';
import {
  PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS,
} from '../../src/utils/plugin-script-contract.js';
import {
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createManifest(name = 'script-plugin'): PluginManifestSource {
  return {
    name,
    version: '0.1.0',
    description: 'Lifecycle test plugin',
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
    scripts: {
      timeoutMs: 2500,
      lifecycle: {
        install: {
          default: {
            runner: 'node',
            path: './scripts/install.mjs',
            args: ['--flag'],
          },
        },
      },
    },
    config: {
      schema: {
        token: {
          type: 'string',
          required: true,
          sensitive: true,
        },
      },
    },
  };
}

async function writePlugin(root: string, manifest = createManifest()): Promise<PluginMeta> {
  const pluginRoot = path.join(root, 'plugins', manifest.name);
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, { spaces: 2 });
  await fs.outputFile(
    path.join(pluginRoot, 'scripts', 'install.mjs'),
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'const context = JSON.parse(readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'writeFileSync(path.join(context.cwd, "marker.txt"), `${context.plugin.name}:${context.config.values.token}`);',
    ].join('\n'),
  );
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'uninstall.cmd'), '@echo off\n');
  return {
    rootDir: pluginRoot,
    manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin lifecycle scripts', () => {
  it('writes AW_PLUGIN_CONTEXT as 0600 best effort and cleans it up', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const awHome = path.join(root, 'aw-home');
    const cwd = path.join(root, 'repo');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'secret-token' },
    });
    const target = await resolveLifecycleScriptTarget({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      currentPlugin: plugin,
      cwd,
      runtimeOs: 'linux',
      env,
    });

    const written = await writeLifecycleScriptContext({
      target,
      event: 'install',
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
    });

    const pluginRoot = await fs.realpath(plugin.rootDir);
    await expect(fs.readJson(written.contextPath)).resolves.toMatchObject({
      event: 'install',
      plugin: {
        name: 'script-plugin',
        rootDir: pluginRoot,
      },
      config: {
        values: {
          token: 'secret-token',
        },
      },
      script: {
        args: ['--flag'],
      },
      paths: {
        configStores: {
          user: resolvePluginConfigStorePath({
            pluginName: plugin.manifest.name,
            scope: 'user',
            cwd,
            env,
          }),
          project: resolvePluginConfigStorePath({
            pluginName: plugin.manifest.name,
            scope: 'project',
            cwd,
            env,
          }),
        },
      },
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(written.contextPath)).mode & 0o777).toBe(0o600);
    }

    await written.cleanup();
    await expect(fs.pathExists(written.contextPath)).resolves.toBe(false);
  });

  it('runs a node lifecycle script with isolated env and cleans context on success', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const awHome = path.join(root, 'aw-home');
    const cwd = path.join(root, 'repo');
    const markerPath = path.join(cwd, 'marker.txt');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = {
      AW_HOME: awHome,
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      PATH: process.env.PATH,
    } as NodeJS.ProcessEnv;
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'secret-token' },
    });

    const result = await runLifecycleScript({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scope: 'user',
      cwd,
      currentPlugin: plugin,
      context: createCommandExecutionContext({ env }),
      runtimeOs: 'linux',
    });

    expect(result.executed).toBe(true);
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('script-plugin:secret-token');
    await expect(fs.readdir(path.join(awHome, 'tmp'))).resolves.toHaveLength(0);
  });

  it('redacts sensitive stderr summaries and removes context on exit code failure', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const awHome = path.join(root, 'aw-home');
    const cwd = path.join(root, 'repo');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome, PATH: process.env.PATH } as NodeJS.ProcessEnv;
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'secret-token' },
    });
    let contextPath = '';
    const events: unknown[] = [];
    const context = createCommandExecutionContext({
      env,
      reporter: {
        event: (event) => events.push(event),
        notice: () => {},
      },
      debugLogger: {
        log: (event) => events.push(event),
      },
    });

    await expect(runLifecycleScript({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scope: 'user',
      cwd,
      currentPlugin: plugin,
      context,
      runtimeOs: 'linux',
      runner: {
        async run(invocation) {
          contextPath = invocation.env.AW_PLUGIN_CONTEXT!;
          return {
            exitCode: 7,
            signal: null,
            stdout: 'token=secret-token\n',
            stderr: 'failed with secret-token\n',
            timedOut: false,
          };
        },
      },
    })).rejects.toThrow('failed with [REDACTED]');

    await expect(fs.pathExists(contextPath)).resolves.toBe(false);
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('reports timeouts with redacted stderr summaries', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const awHome = path.join(root, 'aw-home');
    const cwd = path.join(root, 'repo');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome, PATH: process.env.PATH } as NodeJS.ProcessEnv;
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'secret-token' },
    });

    await expect(runLifecycleScript({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scope: 'user',
      cwd,
      currentPlugin: plugin,
      context: createCommandExecutionContext({ env }),
      scriptTimeoutMs: 1000,
      runtimeOs: 'linux',
      runner: {
        async run() {
          return {
            exitCode: null,
            signal: 'SIGTERM',
            stdout: '',
            stderr: 'timeout secret-token',
            timedOut: true,
          };
        },
      },
    })).rejects.toThrow('timeout [REDACTED]');
  });

  it('builds runner argv without shell:true, including cmd quoting', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(buildLifecycleScriptInvocation({
      entry: { runner: 'node', path: './x.mjs', args: ['a'] },
      entryPath: '/tmp/x.mjs',
      cwd: '/tmp',
      env,
    })).toMatchObject({
      command: process.execPath,
      args: ['/tmp/x.mjs', 'a'],
    });
    expect(buildLifecycleScriptInvocation({
      entry: { runner: 'bash', path: './x.sh', args: ['a'] },
      entryPath: '/tmp/x.sh',
      cwd: '/tmp',
      env,
    })).toMatchObject({ command: 'bash', args: ['/tmp/x.sh', 'a'] });
    expect(buildLifecycleScriptInvocation({
      entry: { runner: 'powershell', path: './x.ps1', args: ['a'] },
      entryPath: 'C:\\tmp\\x.ps1',
      cwd: 'C:\\tmp',
      env,
    })).toMatchObject({
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tmp\\x.ps1', 'a'],
    });
    const cmd = buildLifecycleScriptInvocation({
      entry: { runner: 'cmd', path: './x.cmd', args: ['has space', 'has"quote'] },
      entryPath: 'C:\\Program Files\\x.cmd',
      cwd: 'C:\\tmp',
      env,
    });
    expect(cmd.command).toBe('cmd');
    expect(cmd.args.at(-1)).toContain('"C:\\Program Files\\x.cmd"');
    expect(cmd.args.at(-1)).toContain('"has space"');
    expect(quoteCmdArgument('has"quote')).toBe('"has\\"quote"');
  });

  it('enforces timeout priority and bounds', () => {
    expect(resolveLifecycleScriptTimeoutMs({
      cliTimeoutMs: 1234,
      manifest: createManifest(),
    })).toBe(1234);
    expect(resolveLifecycleScriptTimeoutMs({ manifest: createManifest() })).toBe(2500);
    const manifest = createManifest();
    delete manifest.scripts!.timeoutMs;
    expect(resolveLifecycleScriptTimeoutMs({ manifest })).toBe(PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS);
    expect(() => resolveLifecycleScriptTimeoutMs({ cliTimeoutMs: 999 })).toThrow('between 1000 and 300000');
    manifest.scripts!.timeoutMs = 300001;
    expect(() => resolveLifecycleScriptTimeoutMs({ manifest })).toThrow('between 1000 and 300000');
  });

  it('builds an isolated spawn env from the command env whitelist', () => {
    const env = buildLifecycleSpawnEnv({
      commandEnv: {
        AW_HOME: '/aw',
        AW_CODEX_HOME: '/codex',
        AW_CLAUDE_HOME: '/claude',
        HOME: '/real-home',
        TMPDIR: '/real-tmp',
        PATH: '/bin',
        SECRET_TOKEN: 'do-not-copy',
      } as NodeJS.ProcessEnv,
      contextPath: '/ctx.json',
      tempDir: '/isolated',
      plugin: { name: 'p', version: '1.0.0' },
      event: 'install',
      platform: 'codex',
      scope: 'user',
      bundleRoot: '/bundle',
      runtimeOs: 'linux',
    });

    expect(env).toMatchObject({
      AW_HOME: '/aw',
      AW_CODEX_HOME: '/codex',
      AW_CLAUDE_HOME: '/claude',
      PATH: '/bin',
      HOME: '/isolated/home',
      TMPDIR: '/isolated/tmp',
      AW_PLUGIN_CONTEXT: '/ctx.json',
      AW_PLUGIN_ROOT: '/bundle',
    });
    expect(env.SECRET_TOKEN).toBeUndefined();

    const defaults = buildLifecycleSpawnEnv({
      commandEnv: {
        AW_HOME: '/aw',
        PATH: '/bin',
      } as NodeJS.ProcessEnv,
      contextPath: '/ctx.json',
      tempDir: '/isolated',
      plugin: { name: 'p', version: '1.0.0' },
      event: 'install',
      platform: 'codex',
      scope: 'user',
      bundleRoot: '/bundle',
      runtimeOs: 'linux',
    });
    expect(defaults.AW_CODEX_HOME).toBe('/aw/isolated-codex-home');
    expect(defaults.AW_CLAUDE_HOME).toBe('/aw/isolated-claude-home');
  });

  it('fails before execution when no lifecycle entry resolves on the current OS', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const cwd = path.join(root, 'repo');
    await fs.ensureDir(cwd);
    const manifest = createManifest();
    manifest.scripts!.lifecycle!.install = {
      win32: {
        runner: 'cmd',
        path: './scripts/install.cmd',
      },
    };
    const plugin = await writePlugin(root, manifest);
    await fs.outputFile(path.join(plugin.rootDir, 'scripts', 'install.cmd'), '@echo off\n');

    await expect(resolveLifecycleScriptTarget({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      currentPlugin: plugin,
      cwd,
      runtimeOs: 'linux',
      env: { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv,
    })).rejects.toThrow('none support linux');
  });

  it('uses install snapshots before current catalog and preserves old schema truth', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    const snapshot = await createLifecycleConfigSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      env,
    });
    const currentManifest = createManifest();
    currentManifest.scripts!.lifecycle!.install!.default!.path = './scripts/current.mjs';
    currentManifest.config!.schema.token.required = false;
    currentManifest.config!.schema.mode = { type: 'string', default: 'new' };
    const current = await writePlugin(root, currentManifest);
    await fs.outputFile(path.join(current.rootDir, 'scripts', 'current.mjs'), 'console.log("current")\n');

    const target = await resolveLifecycleScriptTarget({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scopeRecord: {
        managed: true,
        updatedAt: '2026-04-29T00:00:00.000Z',
        resolvedVersion: '0.1.0',
        capabilitySnapshot: {},
        lifecycleConfigSnapshot: snapshot,
      } as InstalledScopeRecord<Record<string, unknown>>,
      currentPlugin: current,
      cwd,
      env,
      runtimeOs: 'linux',
    });

    expect(target.source).toBe('installSnapshot');
    expect(target.entry?.path).toBe('./scripts/install.mjs');
    expect(target.sourceManifest?.config?.schema).toEqual(plugin.manifest.config?.schema);
  });

  it('falls back to current catalog when a snapshot digest is damaged', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    const snapshot = await createLifecycleConfigSnapshot({
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      env,
    });
    await fs.outputJson(path.join(snapshot.bundleRoot, '.agents-plugin', 'plugin.json'), {
      ...plugin.manifest,
      version: '9.9.9',
    }, { spaces: 2 });

    const target = await resolveLifecycleScriptTarget({
      event: 'install',
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scopeRecord: {
        managed: true,
        updatedAt: '2026-04-29T00:00:00.000Z',
        resolvedVersion: '0.1.0',
        capabilitySnapshot: {},
        lifecycleConfigSnapshot: snapshot,
      } as InstalledScopeRecord<Record<string, unknown>>,
      currentPlugin: plugin,
      cwd,
      env,
      runtimeOs: 'linux',
    });

    expect(target.source).toBe('currentCatalog');
    expect(target.warnings.join('\n')).toContain('falling back to current catalog');
  });

  it('falls back to current catalog when the readable snapshot has no requested lifecycle', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const installedPlugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    const snapshot = await createLifecycleConfigSnapshot({
      plugin: installedPlugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      env,
    });

    const currentManifest = createManifest();
    currentManifest.scripts!.lifecycle!.uninstall = {
      default: {
        runner: 'node',
        path: './scripts/install.mjs',
      },
    };
    const currentPlugin = await writePlugin(root, currentManifest);

    const target = await resolveLifecycleScriptTarget({
      event: 'uninstall',
      pluginName: installedPlugin.manifest.name,
      platform: 'codex',
      scopeRecord: {
        managed: true,
        updatedAt: '2026-04-29T00:00:00.000Z',
        resolvedVersion: '0.1.0',
        capabilitySnapshot: {},
        lifecycleConfigSnapshot: snapshot,
      } as InstalledScopeRecord<Record<string, unknown>>,
      currentPlugin,
      cwd,
      env,
      runtimeOs: 'linux',
    });

    expect(target.source).toBe('currentCatalog');
    expect(target.noOp).toBe(false);
    expect(target.entry?.path).toBe('./scripts/install.mjs');
    expect(target.warnings.join('\n')).toContain('does not declare "uninstall" lifecycle script');
  });

  it('warns and continues when historical uninstall has no executable lifecycle source', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    const notices: unknown[] = [];
    const events: unknown[] = [];
    const context = createCommandExecutionContext({
      env,
      reporter: {
        event: (event) => events.push(event),
        notice: (notice) => notices.push(notice),
      },
      debugLogger: {
        log: (event) => events.push(event),
      },
    });

    const result = await runLifecycleScript({
      event: 'uninstall',
      pluginName: 'removed-script-plugin',
      platform: 'codex',
      scope: 'user',
      cwd,
      context,
      runtimeOs: 'linux',
    });

    expect(result.executed).toBe(false);
    expect(result.target.source).toBe('none');
    expect(notices).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: expect.stringContaining('No executable uninstall lifecycle script was found'),
      }),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'lifecycle.noop',
      }),
    ]));
  });

  it('garbage collects only unreferenced exact snapshot roots', async () => {
    const root = await makeTempRoot('aw-plugin-scripts-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;
    const kept = await createLifecycleConfigSnapshot({ plugin, platform: 'codex', scope: 'user', cwd, env });
    const orphan = await createLifecycleConfigSnapshot({ plugin, platform: 'codex', scope: 'project', cwd, env });
    const ledger = {
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        [plugin.manifest.name]: {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-04-29T00:00:00.000Z',
                resolvedVersion: '0.1.0',
                capabilitySnapshot: {},
                lifecycleConfigSnapshot: kept,
              },
            },
          },
        },
      },
    } as const;

    const result = await garbageCollectLifecycleConfigSnapshots({ ledger, env });

    expect(result.preserved).toContain(kept.snapshotRoot);
    expect(result.deleted).toContain(orphan.snapshotRoot);
    await expect(fs.pathExists(kept.bundleRoot)).resolves.toBe(true);
    await expect(fs.pathExists(orphan.bundleRoot)).resolves.toBe(false);
  });
});
