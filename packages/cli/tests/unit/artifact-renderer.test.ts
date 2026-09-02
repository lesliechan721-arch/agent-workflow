import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactRenderEvent } from '../../src/utils/artifact-renderer.js';
import type { PluginManifestSource, PluginMeta } from '../../src/types.js';
import {
  resolveArtifactRenderConfig,
  runArtifactRenderer,
  writeArtifactRendererContext,
  resolveArtifactRendererTarget,
} from '../../src/utils/artifact-renderer.js';
import {
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';

const tempDirs: string[] = [];
const descendantPids = new Set<number>();
const SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS = 30_000;

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function createManifest(name = 'dynamic-artifacts'): PluginManifestSource {
  return {
    name,
    version: '0.1.0',
    description: 'Dynamic artifact renderer fixture',
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
    scripts: {
      timeoutMs: 2500,
      artifacts: {
        render: {
          runner: 'node',
          path: './scripts/render-artifacts.mjs',
        },
      },
    },
    config: {
      fields: {
        token: {
          type: 'string',
          sensitive: true,
        },
        credentials: {
          type: 'object',
          properties: {
            accessKey: { type: 'string', sensitive: true },
          },
        },
        enableLightweightInstruction: {
          type: 'boolean',
          default: true,
        },
        explorerModel: {
          type: 'string',
          default: 'gpt-5.4-mini',
        },
        modelReasoningEffort: {
          type: 'string',
          choices: {
            allowCustom: false,
            presets: ['low', 'medium', 'high', 'xhigh'].map((value) => ({
              id: value,
              title: value,
              value,
            })),
          },
          default: 'medium',
        },
      },
    },
    artifacts: {
      targets: [
        {
          id: 'lightweight-instruction',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.developerInstructionsBlock',
          projectManagedKind: 'instruction',
          states: ['present', 'disabled'],
          refreshKeys: [
            'enableLightweightInstruction',
            'explorerModel',
            'modelReasoningEffort',
          ],
          requiresCodexProjectConfig: true,
        },
        {
          id: 'codex-explorer-role',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.agentRole',
          projectManagedKind: 'agent',
          states: ['present'],
          refreshKeys: ['explorerModel', 'modelReasoningEffort'],
          requiresCodexProjectConfig: true,
          roleKey: 'codex-explorer',
        },
      ],
    },
  };
}

function processIsRunning(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return state !== '' && !state.startsWith('Z');
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processIsRunning(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function writePlugin(
  root: string,
  manifest = createManifest(),
  scriptSource?: string,
): Promise<PluginMeta> {
  const pluginRoot = path.join(root, 'plugins', manifest.name);
  await fs.outputJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest,
    { spaces: 2 },
  );
  await fs.outputFile(
    path.join(pluginRoot, 'scripts', 'render-artifacts.mjs'),
    scriptSource ?? [
      'import { readFileSync } from "node:fs";',
      'const context = JSON.parse(readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'console.error(`renderer token=${context.config.values.token ?? ""}`);',
      'console.log(JSON.stringify({',
      '  version: 2,',
      '  artifacts: [',
      '    {',
      '      id: "lightweight-instruction",',
      '      kind: "instruction",',
      '      platform: "codex",',
      '      target: "codex.developerInstructionsBlock",',
      '      state: "present",',
      '      refreshKeys: ["enableLightweightInstruction", "explorerModel", "modelReasoningEffort"],',
      '      content: `scope=${context.config.targetScope};model=${context.config.values.explorerModel}`',
      '    },',
      '    {',
      '      id: "codex-explorer-role",',
      '      kind: "codexRole",',
      '      platform: "codex",',
      '      target: "codex.agentRole",',
      '      state: "present",',
      '      roleKey: "codex-explorer",',
      '      refreshKeys: ["explorerModel", "modelReasoningEffort"],',
      '      content: {',
      '        roleFile: {',
      '          name: "codex-explorer",',
      '          developer_instructions: "Inspect the repository."',
      '        }',
      '      }',
      '    }',
      '  ]',
      '}));',
    ].join('\n'),
    'utf8',
  );

  return {
    rootDir: pluginRoot,
    manifestPath: path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest,
  };
}

afterEach(async () => {
  for (const pid of descendantPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The renderer cleanup can already have terminated the descendant.
    }
  }
  descendantPids.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('artifact renderer runtime', () => {
  it.runIf(process.platform !== 'win32')('terminates an inherited-pipe descendant and preserves the abort reason', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-abort-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    const started = path.join(root, 'started');
    const descendantStarted = path.join(root, 'descendant-started');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root, createManifest(), [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), ${SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });`,
      `writeFileSync(${JSON.stringify(descendantStarted)}, String(descendant.pid));`,
      `writeFileSync(${JSON.stringify(started)}, String(process.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const controller = new AbortController();
    const abortReason = new DOMException('renderer cancelled', 'AbortError');
    const rendering = runArtifactRenderer({
      event: 'materialize', plugin, platform: 'agent-skills', scope: 'project', cwd,
      commandEnv: {
        AW_HOME: awHome,
        PATH: process.env.PATH,
      },
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && (!await fs.pathExists(started) || !await fs.pathExists(descendantStarted)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await fs.pathExists(started)).toBe(true);
    const descendantPid = Number(await fs.readFile(descendantStarted, 'utf8'));
    descendantPids.add(descendantPid);
    controller.abort(abortReason);
    await expect(rendering).rejects.toBe(abortReason);
    await waitForProcessExit(descendantPid);
    expect(processIsRunning(descendantPid)).toBe(false);
    descendantPids.delete(descendantPid);
  });

  it.runIf(process.platform !== 'win32')('times out after terminating an inherited-pipe descendant', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-timeout-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    const descendantStarted = path.join(root, 'descendant-started');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root, createManifest(), [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      `const descendant = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), ${SYNTHETIC_DESCENDANT_MAX_LIFETIME_MS}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true });`,
      `writeFileSync(${JSON.stringify(descendantStarted)}, String(descendant.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const controller = new AbortController();
    const rendering = runArtifactRenderer({
      event: 'materialize', plugin, platform: 'agent-skills', scope: 'project', cwd,
      commandEnv: { AW_HOME: awHome, PATH: process.env.PATH },
      scriptTimeoutMs: 1_000,
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100 && !await fs.pathExists(descendantStarted); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await fs.pathExists(descendantStarted)).toBe(true);
    const descendantPid = Number(await fs.readFile(descendantStarted, 'utf8'));
    descendantPids.add(descendantPid);
    try {
      await expect(rendering).rejects.toThrow('Artifact renderer timed out after 1000 ms');
    } finally {
      controller.abort();
    }
    await waitForProcessExit(descendantPid);
    expect(processIsRunning(descendantPid)).toBe(false);
    descendantPids.delete(descendantPid);
  });

  it('writes target-scoped artifact render config into renderer context', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'secret-token',
        explorerModel: 'gpt-5.4',
      },
    });
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        explorerModel: 'project-model',
        modelReasoningEffort: 'high',
      },
    });

    const target = await resolveArtifactRendererTarget(plugin);
    const userContext = await writeArtifactRendererContext({
      target,
      event: 'refresh',
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
      changedConfigKeys: ['explorerModel'],
      previousArtifacts: [{ id: 'lightweight-instruction', state: 'present' }],
    });
    expect(userContext.context.config).toMatchObject({
      mode: 'artifact-render',
      targetScope: 'user',
      values: {
        token: 'secret-token',
        explorerModel: 'gpt-5.4',
        enableLightweightInstruction: true,
        modelReasoningEffort: 'medium',
      },
      sources: {
        token: 'user',
        explorerModel: 'user',
        enableLightweightInstruction: 'default',
        modelReasoningEffort: 'default',
      },
    });
    expect(userContext.context.changedConfigKeys).toEqual(['explorerModel']);
    expect(userContext.context.previousArtifacts).toEqual([
      { id: 'lightweight-instruction', state: 'present' },
    ]);
    expect(userContext.context.paths.configStores.user).toContain('/plugin-config/');
    expect(userContext.context.paths.configStores.project).toContain('/plugin-config/');
    expect(Object.keys(userContext.context.paths.configStores).sort()).toEqual(['project', 'user']);
    if (process.platform !== 'win32') {
      expect((await fs.stat(userContext.contextPath)).mode & 0o777).toBe(0o600);
    }

    const projectContext = await writeArtifactRendererContext({
      target,
      event: 'install',
      platform: 'codex',
      scope: 'project',
      cwd,
      commandEnv: env,
    });
    expect(projectContext.context.config.values.explorerModel).toBe('project-model');
    expect(projectContext.context.config.values.modelReasoningEffort).toBe('high');
    expect(projectContext.context.config.sources.explorerModel).toBe('project');
    expect(projectContext.context.config.sources.modelReasoningEffort).toBe('project');
    expect(projectContext.context.changedConfigKeys).toEqual([]);

    await fs.outputFile(resolvePluginConfigStorePath({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
    }), '{invalid');
    const userContextWithInvalidProjectStore = await writeArtifactRendererContext({
      target,
      event: 'install',
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
    });
    expect(userContextWithInvalidProjectStore.context.config.values.explorerModel).toBe('gpt-5.4');
    await expect(writeArtifactRendererContext({
      target,
      event: 'install',
      platform: 'codex',
      scope: 'project',
      cwd,
      commandEnv: env,
    })).rejects.toThrow('invalidJson');

    await Promise.all([
      userContext.cleanup(),
      projectContext.cleanup(),
      userContextWithInvalidProjectStore.cleanup(),
    ]);
  });

  it('reports one project artifact boundary issue for an object with filesystem path children', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-boundary-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const manifest = createManifest();
    manifest.config!.fields.sharedFile = {
      type: 'string',
      validation: { format: 'file' },
    };
    manifest.config!.fields.locations = {
      type: 'object',
      properties: {
        certificate: { type: 'string', validation: { format: 'file' } },
        label: { type: 'string' },
      },
      additionalProperties: { type: 'string', validation: { format: 'directory' } },
    };
    const plugin = await writePlugin(root, manifest);
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: { locations: { label: 'shared label' } },
    });

    const clean = await resolveArtifactRenderConfig({
      manifest: plugin.manifest,
      scope: 'project',
      cwd,
      env,
    });
    expect(clean.issues).not.toContainEqual(expect.objectContaining({
      type: 'sharedCompositeContainsLocalPath',
    }));

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: {
        sharedFile: '/machine/certificate.pem',
        locations: { certificate: '/machine/certificate.pem', cache: '/machine/cache' },
      },
    });

    const project = await resolveArtifactRenderConfig({
      manifest: plugin.manifest,
      scope: 'project',
      cwd,
      env,
    });
    const user = await resolveArtifactRenderConfig({
      manifest: plugin.manifest,
      scope: 'user',
      cwd,
      env,
    });

    expect(project.issues).toContainEqual({
      type: 'sharedCompositeContainsLocalPath',
      key: 'locations',
      source: 'project',
      message: expect.any(String),
    });
    expect(project.issues).toContainEqual({
      type: 'sharedCompositeContainsLocalPath',
      key: 'sharedFile',
      source: 'project',
      message: expect.any(String),
    });
    expect(user.issues).not.toContainEqual(expect.objectContaining({
      type: 'sharedCompositeContainsLocalPath',
    }));
  });

  it('does not start the renderer when project config crosses the artifact boundary', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-blocked-');
    const cwd = path.join(root, 'repo');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    await fs.ensureDir(cwd);
    const manifest = createManifest();
    manifest.config!.fields.locations = {
      type: 'object',
      properties: {
        certificate: { type: 'string', validation: { format: 'file' } },
      },
    };
    const plugin = await writePlugin(root, manifest);
    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'project',
      cwd,
      env,
      values: { locations: { certificate: '/machine/certificate.pem' } },
    });
    let runnerCalled = false;

    await expect(runArtifactRenderer({
      event: 'install',
      plugin,
      platform: 'codex',
      scope: 'project',
      cwd,
      commandEnv: env,
      runner: {
        async run() {
          runnerCalled = true;
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ version: 2, artifacts: [] }),
            stderr: '',
            timedOut: false,
          };
        },
      },
    })).rejects.toThrow('sharedCompositeContainsLocalPath');

    expect(runnerCalled).toBe(false);
  });

  it('runs renderer with empty changed keys for install and upgrade, and explicit keys for refresh', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-run-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome, PATH: process.env.PATH } as NodeJS.ProcessEnv;

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: {
        token: 'secret-token',
        explorerModel: 'gpt-5.4',
      },
    });

    const installResult = await runArtifactRenderer({
      event: 'install',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
    });
    expect(installResult.context.changedConfigKeys).toEqual([]);
    expect(installResult.plan.artifacts[0]?.content).toContain('scope=user');

    const refreshResult = await runArtifactRenderer({
      event: 'refresh',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
      changedConfigKeys: ['explorerModel'],
    });
    expect(refreshResult.context.changedConfigKeys).toEqual(['explorerModel']);
    expect(refreshResult.plan.version).toBe(2);

    await expect(runArtifactRenderer({
      event: 'refresh',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
    })).rejects.toThrow('changedConfigKeys');
  });

  it('rejects non-write events at runtime', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-event-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome, PATH: process.env.PATH } as NodeJS.ProcessEnv;

    await expect(runArtifactRenderer({
      event: 'status' as ArtifactRenderEvent,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
    })).rejects.toThrow('only supports install, refresh, and materialize events');
  });

  it('fails when stdout is not JSON and redacts sensitive diagnostics', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-nonjson-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const plugin = await writePlugin(root);
    const env = { AW_HOME: awHome } as NodeJS.ProcessEnv;

    await writePluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env,
      values: { token: 'secret-token', credentials: { accessKey: 'nested-render-secret' } },
    });

    const error = await runArtifactRenderer({
      event: 'install',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
      runner: {
        async run() {
          return {
            exitCode: 0,
            signal: null,
            stdout: 'not-json secret-token nested-render-secret',
            stderr: 'stderr secret-token nested-render-secret',
            timedOut: false,
          };
        },
      },
    }).then(() => undefined, (failure: unknown) => failure);
    expect(String(error)).toContain('[REDACTED]');
    expect(String(error)).not.toContain('secret-token');
    expect(String(error)).not.toContain('nested-render-secret');
  });

  it('fails on unsupported versions, non-zero exit, and timeouts', async () => {
    const root = await makeTempRoot('aw-artifact-renderer-failures-');
    const cwd = path.join(root, 'repo');
    const awHome = path.join(root, 'aw-home');
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

    await expect(runArtifactRenderer({
      event: 'install',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
      runner: {
        async run() {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ version: 1, artifacts: [] }),
            stderr: 'unknown-version secret-token',
            timedOut: false,
          };
        },
      },
    })).rejects.toThrow('unsupported plan version');

    await expect(runArtifactRenderer({
      event: 'install',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
      runner: {
        async run() {
          return {
            exitCode: 9,
            signal: null,
            stdout: '',
            stderr: 'boom secret-token',
            timedOut: false,
          };
        },
      },
    })).rejects.toThrow('[REDACTED]');

    await expect(runArtifactRenderer({
      event: 'install',
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd,
      commandEnv: env,
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
    })).rejects.toThrow('[REDACTED]');
  });
});
