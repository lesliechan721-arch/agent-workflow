import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { statusCommand } from '../../src/commands/status.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  discoverRebuildTargetNames,
  inspectRebuildTarget,
} from '../../src/commands/rebuild-integration.js';
import type { CatalogResolution, PlatformName, PluginMeta, Scope } from '../../src/types.js';
import type { OwnedComponent, OwnershipInspectionState } from '../../src/utils/ownership.js';
import { OWNED_TEXT_HEADER_PREFIX, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { resolveClaudePaths } from '../../src/utils/paths.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function plugin(name: string, products: Array<'CODEX' | 'CLAUDE'> = ['CODEX', 'CLAUDE']): PluginMeta {
  return {
    rootDir: `/catalog/plugins/${name}`,
    manifestPath: `/catalog/plugins/${name}/.agents-plugin/plugin.json`,
    manifest: {
      name,
      version: '1.2.3',
      description: `${name} fixture`,
      compatibility: { aw: { minVersion: '0.1.0' } },
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products },
      },
      extensions: {
        instructions: [{ name: 'rule', title: 'Rule', content: 'Use the rule.' }],
      },
    },
  };
}

function catalog(): CatalogResolution {
  return {
    rootDir: '/catalog',
    source: 'local',
    channel: 'latest',
    catalogVersion: '3.0.0',
    selector: {
      kind: 'default',
      cliVersion: '1.0.0',
      defaultChannel: 'latest',
    },
  };
}

function inspectionRuntime(states: Record<string, OwnershipInspectionState>) {
  return vi.fn(async (options: {
    plugin: PluginMeta;
    platform: PlatformName;
    scope: Scope;
    cwd: string;
  }) => {
    const state = states[options.plugin.manifest.name] ?? 'absent';
    const component = {
      kind: 'managed-block' as const,
      identity: {
        owner: 'agent-workflows' as const,
        plugin: options.plugin.manifest.name,
        artifactKey: 'config',
        platform: options.platform,
        scope: options.scope,
      },
      label: 'config',
      inspect: async () => 'absent' as const,
      remove: async () => undefined,
    };
    return {
      target: {
        plugin: options.plugin,
        identity: {
          pluginName: options.plugin.manifest.name,
          pluginVersion: options.plugin.manifest.version,
          platform: options.platform,
          scope: options.scope,
          cwd: options.cwd,
        },
        ownedComponents: [component],
        desiredOwnedComponents: [component],
        requiresNative: false,
        artifacts: [],
        lifecycleSource: options.plugin,
      },
      inspection: {
        state,
        components: [{
          component,
          state,
          ...(state === 'error'
            ? { diagnostic: 'native list unavailable' }
            : state === 'partial'
              ? { diagnostic: 'foreign collision' }
              : {}),
        }],
        errors: state === 'error'
          ? [{ label: 'config', message: 'native list unavailable' }]
          : [],
      },
    };
  });
}

function fakeComponent(
  pluginName: string,
  artifactKey: string,
  platform: PlatformName = 'codex',
  scope: Scope = 'project',
): OwnedComponent {
  return {
    kind: 'managed-block',
    identity: {
      owner: 'agent-workflows',
      plugin: pluginName,
      artifactKey,
      platform,
      scope,
    },
    label: artifactKey,
    inspect: async () => 'absent',
    remove: async () => undefined,
  };
}

async function filesystemSnapshot(root: string): Promise<Array<{
  path: string;
  type: 'directory' | 'file';
  content?: string;
}>> {
  if (!await fs.pathExists(root)) return [];
  const output: Array<{ path: string; type: 'directory' | 'file'; content?: string }> = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      if (entry.isDirectory()) {
        output.push({ path: relative, type: 'directory' });
        pending.push(entryPath);
      } else if (entry.isFile()) {
        output.push({ path: relative, type: 'file', content: await fs.readFile(entryPath, 'utf8') });
      }
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

async function dynamicRendererPlugin(
  root: string,
  options: {
    name?: string;
    states?: Array<'present' | 'disabled'>;
  } = {},
): Promise<PluginMeta> {
  const name = options.name ?? 'dynamic-renderer-plugin';
  const pluginRoot = path.join(root, name);
  const manifest: PluginMeta['manifest'] = {
    name,
    version: '1.0.0',
    description: 'Renderer must not run during status.',
    compatibility: { aw: { minVersion: '0.1.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    },
    scripts: {
      artifacts: {
        render: { runner: 'node', path: './scripts/render.mjs' },
      },
    },
    artifacts: {
      targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: options.states ?? ['present'],
        skillKey: 'dynamic-renderer-skill',
      }],
    },
  };
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  await fs.outputJson(manifestPath, manifest);
  await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'fs.writeFileSync(process.env.AW_RENDER_SENTINEL, "renderer ran\\n");',
    'fs.writeFileSync(path.join(process.env.AW_HOME, "renderer-ran"), "renderer ran\\n");',
    'console.log(JSON.stringify({ version: 2, artifacts: [] }));',
  ].join('\n'));
  return { rootDir: pluginRoot, manifestPath, manifest };
}

describe('live status command', () => {
  it('uses the write capability gate for Codex project apps', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = plugin('apps-project-gate', ['CODEX']);
    current.manifest.apps = './apps';
    current.manifest.extensions = {
      instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.' }],
    };
    const inspectTarget = vi.fn();
    const result = await statusCommand(['apps-project-gate'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      inspectTarget: inspectTarget as never,
    });

    expect(result.payload.targets[0]).toMatchObject({ state: 'error' });
    expect(inspectTarget).not.toHaveBeenCalled();
  });

  it('emits schemaVersion 3 with only live target state and the three deterministic states', async () => {
    const plugins = [plugin('present-plugin'), plugin('absent-plugin'), plugin('partial-plugin')];
    const result = await statusCommand(
      plugins.map((entry) => entry.manifest.name),
      { cwd: '/workspace', platform: 'codex', scope: 'project', json: true },
      {
        catalogResolution: catalog(),
        catalogPlugins: plugins,
        inspectTarget: inspectionRuntime({
          'present-plugin': 'present',
          'absent-plugin': 'absent',
          'partial-plugin': 'partial',
        }) as never,
      },
    );
    const payload = JSON.parse(result.output);

    expect(payload.schemaVersion).toBe(3);
    expect(payload.targets.map((entry: { state: string }) => entry.state).sort()).toEqual([
      'absent', 'partial', 'present',
    ]);
    const partial = payload.targets.find((entry: { state: string }) => entry.state === 'partial');
    expect(partial.recommendation.command).toBe('aw reinstall partial-plugin -p codex -s project');
    const serialized = JSON.stringify(payload);
    for (const removed of [
      'record', 'evidence', 'dependency', 'drift', 'diagnostic', 'history',
      'cleanupRequired', 'degraded', 'external', 'nativeMarker',
    ]) expect(serialized).not.toContain(`"${removed}"`);
    expect(result.hasErrors).toBe(false);

    const human = await statusCommand(['partial-plugin'], {
      cwd: '/workspace', platform: 'codex', scope: 'project',
    }, {
      catalogResolution: catalog(),
      catalogPlugins: plugins,
      inspectTarget: inspectionRuntime({ 'partial-plugin': 'partial' }) as never,
    });
    expect(human.output).toContain('aw reinstall partial-plugin -p codex -s project');
    expect(human.output).not.toMatch(/cleanup|uninstall|repair/iu);
    expect(human.output).not.toContain('managed-block config partial');

    const verbose = await statusCommand(['partial-plugin'], {
      cwd: '/workspace', platform: 'codex', scope: 'project', verbose: true,
    }, {
      catalogResolution: catalog(),
      catalogPlugins: plugins,
      inspectTarget: inspectionRuntime({ 'partial-plugin': 'partial' }) as never,
    });
    expect(verbose.output).toContain('组件：managed-block config partial · foreign collision');
  });

  it('keeps an inspection error distinct and continues with other targets', async () => {
    const plugins = [plugin('native-plugin', ['CLAUDE']), plugin('other-plugin', ['CLAUDE'])];
    const result = await statusCommand(
      plugins.map((entry) => entry.manifest.name),
      { cwd: '/workspace', platform: 'claude', scope: 'user', json: true },
      {
        catalogResolution: catalog(),
        catalogPlugins: plugins,
        inspectTarget: inspectionRuntime({
          'native-plugin': 'error',
          'other-plugin': 'absent',
        }) as never,
      },
    );

    expect(result.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ plugin: 'native-plugin' }), state: 'error' }),
      expect.objectContaining({ target: expect.objectContaining({ plugin: 'other-plugin' }), state: 'absent' }),
    ]));
    expect(result.payload.targets.find((entry) => entry.target.plugin === 'native-plugin')?.errors[0])
      .toMatchObject({ code: 'inspectionFailed', message: 'native list unavailable' });
    expect(result.hasErrors).toBe(true);
  });

  it('reports present stale non-desired ownership as partial with reinstall guidance', async () => {
    const current = plugin('stale-plugin');
    const required = fakeComponent('stale-plugin', 'required');
    const stale = fakeComponent('stale-plugin', 'stale');
    const result = await statusCommand(['stale-plugin'], {
      cwd: '/workspace', platform: 'codex', scope: 'project', json: true,
    }, {
      catalogResolution: catalog(),
      catalogPlugins: [current],
      inspectTarget: (async () => ({
        target: {
          plugin: current,
          identity: {
            pluginName: 'stale-plugin', pluginVersion: '1.2.3',
            platform: 'codex', scope: 'project', cwd: '/workspace',
          },
          ownedComponents: [required, stale],
          desiredOwnedComponents: [required],
          optionalOwnedComponents: [],
          requiresNative: false,
          artifacts: [],
          lifecycleSource: current,
        },
        inspection: {
          state: 'present',
          components: [required, stale].map((component) => ({ component, state: 'present' as const })),
          errors: [],
        },
      })) as never,
    });

    expect(result.payload.targets[0]).toMatchObject({
      state: 'partial',
      recommendation: {
        command: 'aw reinstall stale-plugin -p codex -s project',
        reason: 'partial',
      },
    });
  });

  it('does not make a present required component partial when an optional component is absent', async () => {
    const current = plugin('optional-plugin');
    const required = fakeComponent('optional-plugin', 'required');
    const optional = fakeComponent('optional-plugin', 'optional');
    const result = await statusCommand(['optional-plugin'], {
      cwd: '/workspace', platform: 'codex', scope: 'project', json: true,
    }, {
      catalogResolution: catalog(),
      catalogPlugins: [current],
      inspectTarget: (async () => ({
        target: {
          plugin: current,
          identity: {
            pluginName: 'optional-plugin', pluginVersion: '1.2.3',
            platform: 'codex', scope: 'project', cwd: '/workspace',
          },
          ownedComponents: [required, optional],
          desiredOwnedComponents: [required],
          optionalOwnedComponents: [optional],
          requiresNative: false,
          artifacts: [],
          lifecycleSource: current,
        },
        inspection: {
          state: 'partial',
          components: [
            { component: required, state: 'present' as const },
            { component: optional, state: 'absent' as const },
          ],
          errors: [],
        },
      })) as never,
    });

    expect(result.payload.targets[0]).toMatchObject({ state: 'present' });
    expect(result.payload.targets[0]?.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactKey: 'optional', state: 'absent' }),
    ]));
  });

  it('does not use an unavailable Codex native list as ownership evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = plugin('native-unavailable', ['CODEX']);
    current.manifest.apps = './apps';
    const result = await statusCommand(['native-unavailable'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      nativeCliRunner: async () => {
        throw new Error('native list unavailable');
      },
    });

    expect(result.payload.targets[0]).toMatchObject({ state: 'absent', errors: [] });
    expect(result.output).not.toContain('native list unavailable');
  });

  it('reports a missing current bundle separately from catalog selector metadata', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const result = await statusCommand(['missing-bundle'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      json: true,
    }, {
      env: isolation.env,
      catalogResolution: {
        ...catalog(),
        rootDir: path.join(isolation.layout.rootDir, 'missing-catalog-bundle'),
      },
    });

    expect(result.payload.catalog).toMatchObject({ catalogVersion: '3.0.0' });
    expect(result.payload.catalog.error).toBeUndefined();
    expect(result.payload.targets[0]).toMatchObject({
      state: 'error',
      errors: [{ code: 'bundleUnavailable' }],
    });
  });

  it('uses catalog and discovered owner residue as the no-argument union and applies filters', async () => {
    const current = plugin('current-plugin', ['CODEX']);
    const inspectTarget = inspectionRuntime({ 'current-plugin': 'absent' });
    const discoverTargets = vi.fn(async () => ['removed-plugin']);
    const result = await statusCommand([], {
      cwd: '/workspace', platform: 'codex', scope: 'project', json: true,
    }, {
      catalogResolution: catalog(),
      catalogPlugins: [current],
      inspectTarget: inspectTarget as never,
      discoverTargets,
    });

    expect(result.payload.errors).toEqual([]);
    expect(result.payload.targets.map((entry) => entry.target.plugin)).toEqual([
      'current-plugin', 'removed-plugin',
    ]);
    expect(result.payload.targets[1]).toMatchObject({ state: 'error' });
    expect(discoverTargets).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'codex', scope: 'project', cwd: '/workspace',
    }));
    expect(inspectTarget).toHaveBeenCalledTimes(1);
  });

  it('discovers MCP env ownership and hook owner headers in the current project only', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const codexDir = path.join(cwd, '.codex');
    await fs.ensureDir(codexDir);
    await fs.writeFile(path.join(codexDir, 'config.toml'), [
      '[mcp_servers.demo]',
      'command = "demo"',
      '[mcp_servers.demo.env]',
      'AW_AGENT_WORKFLOWS_OWNER = "mcp-owner"',
      '',
    ].join('\n'));
    const identity = {
      schemaVersion: 1,
      owner: 'agent-workflows',
      plugin: 'hook-owner',
      artifactKey: 'hook-key',
      platform: 'codex',
      scope: 'project',
    };
    await fs.outputJson(path.join(codexDir, 'hooks.json'), {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: `${OWNED_TEXT_HEADER_PREFIX}${JSON.stringify(identity)}\necho ready`,
          }],
        }],
      },
    });

    const result = await statusCommand([], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [],
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    expect(result.payload.targets.map((entry) => entry.target.plugin)).toEqual([
      'hook-owner', 'mcp-owner',
    ]);
    expect(result.payload.targets.every((entry) => entry.state === 'error')).toBe(true);
  });

  it('does not include user native plugins in no-argument project status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'user-only@aw\n',
      stderr: '',
    }));

    const result = await statusCommand([], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [],
      nativeCliRunner,
    });

    expect(result.payload.targets).toEqual([]);
    expect(nativeCliRunner).not.toHaveBeenCalled();
  });

  it('discovers a Claude project native-only target for no-argument status and console actions', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const current = plugin('claude-project-native', ['CLAUDE']);
    current.manifest.extensions = undefined;
    const nativeCliRunner = vi.fn(async (invocation: { args: string[] }) => ({
      exitCode: 0,
      stdout: invocation.args.includes('--scope') && invocation.args.includes('project')
        ? 'claude-project-native@aw\n'
        : '',
      stderr: '',
    }));
    const runtime = {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      nativeCliRunner,
    };
    const claudePaths = resolveClaudePaths(cwd, 'project', isolation.env);
    const sourceDescriptor = {
      source: 'directory',
      path: isolation.layout.awHomeDir,
    };
    await fs.ensureDir(path.join(isolation.layout.awHomeDir, 'plugins', 'claude-project-native'));
    await fs.outputJson(claudePaths.settingsPath, {
      extraKnownMarketplaces: { aw: { source: sourceDescriptor } },
      enabledPlugins: { 'claude-project-native@aw': true },
    });
    await fs.outputJson(claudePaths.knownMarketplacesPath, {
      aw: {
        installLocation: isolation.layout.awHomeDir,
        source: sourceDescriptor,
      },
    });
    await fs.outputJson(claudePaths.installedPluginsPath, {
      plugins: {
        'claude-project-native@aw': [{
          version: '1.2.3', scope: 'project', projectPath: cwd,
        }],
      },
    });

    await expect(discoverRebuildTargetNames({
      cwd,
      env: isolation.env,
      platform: 'claude',
      scope: 'project',
      nativeCliRunner,
      nativeFailureMode: 'error',
    })).resolves.toContain('claude-project-native');

    const result = await statusCommand([], {
      cwd, platform: 'claude', scope: 'project', json: true,
    }, runtime);
    expect(result.payload.targets).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          plugin: 'claude-project-native', platform: 'claude', scope: 'project',
        }),
        state: 'present',
      }),
    ]);

    const context = createCliExecutionContext({
      cwd, env: isolation.env, interactive: true, nativeCliRunner,
    });
    Object.assign(context, {
      catalogResolution: runtime.catalogResolution,
      catalogPlugins: runtime.catalogPlugins,
    });
    const { createDashboardController, dashboardActions } = await import('../../src/commands/console.js');
    const loaded = await createDashboardController(context).load();
    expect(dashboardActions(loaded.items[0]!, loaded.items[0]!.targets[0]!)).toContain('upgrade');
  });

  it('never runs an uninstalled dynamic renderer for explicit status, no-argument status, or the bare console', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const current = await dynamicRendererPlugin(isolation.layout.rootDir);
    const env = {
      ...isolation.env,
      AW_RENDER_SENTINEL: path.join(cwd, 'renderer-ran'),
    };
    const runtime = {
      env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    };
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    const explicit = await statusCommand(['dynamic-renderer-plugin'], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, runtime);
    expect(explicit.payload.targets[0]?.state).toBe('absent');
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);

    const discovered = await statusCommand([], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, runtime);
    expect(discovered.payload.targets[0]?.target.plugin).toBe('dynamic-renderer-plugin');
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);

    const context = createCliExecutionContext({
      cwd,
      env,
      interactive: true,
      nativeCliRunner: runtime.nativeCliRunner,
    });
    Object.assign(context, {
      catalogResolution: runtime.catalogResolution,
      catalogPlugins: runtime.catalogPlugins,
    });
    const { createDashboardController } = await import('../../src/commands/console.js');
    await expect(createDashboardController(context).load()).resolves.toMatchObject({
      status: { schemaVersion: 3 },
    });
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
    expect(await fs.pathExists(env.AW_RENDER_SENTINEL)).toBe(false);
    expect(await fs.pathExists(path.join(isolation.layout.awHomeDir, 'renderer-ran'))).toBe(false);
  });

  it('treats a disabled-capable dynamic component as optional and reports its live owner when present', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const current = await dynamicRendererPlugin(isolation.layout.rootDir, {
      name: 'optional-dynamic-plugin',
      states: ['present', 'disabled'],
    });
    const env = {
      ...isolation.env,
      AW_RENDER_SENTINEL: path.join(cwd, 'optional-renderer-ran'),
    };
    const inspectTarget = vi.fn(inspectRebuildTarget);
    const runtime = {
      env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      inspectTarget,
    };

    const absent = await statusCommand(['optional-dynamic-plugin'], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, runtime);
    expect(absent.payload.targets[0]?.state).toBe('absent');
    const planned = await inspectTarget.mock.results[0]!.value;
    expect(planned.target.desiredOwnedComponents).toEqual([]);
    expect(planned.target.optionalOwnedComponents).toHaveLength(1);

    const skillsRoot = path.join(cwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'dynamic-renderer-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# Dynamic renderer Skill\n');
    await fs.outputFile(path.join(skillRoot, 'agents', 'openai.yaml'), [
      'interface:',
      '  display_name: "Dynamic renderer Skill"',
      '  short_description: "Status fixture"',
      '  default_prompt: "Use the dynamic renderer Skill."',
      'policy:',
      '  allow_implicit_invocation: true',
      '',
    ].join('\n'));
    await writeSkillOwnerMarker({
      skillRoot,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        plugin: 'optional-dynamic-plugin',
        artifactKey: 'dynamic-renderer-skill',
        platform: 'codex',
        scope: 'project',
      },
    });

    const present = await statusCommand(['optional-dynamic-plugin'], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, runtime);
    expect(present.payload.targets[0]).toMatchObject({
      state: 'present',
      components: [expect.objectContaining({
        kind: 'skill-directory', artifactKey: 'dynamic-renderer-skill', state: 'present',
      })],
    });
    expect(await fs.pathExists(env.AW_RENDER_SENTINEL)).toBe(false);
    expect(await fs.pathExists(path.join(isolation.layout.awHomeDir, 'renderer-ran'))).toBe(false);
  });

  it('keeps a shared developer instructions block optional when every present-capable target allows disabled', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const current = await dynamicRendererPlugin(isolation.layout.rootDir, {
      name: 'optional-instructions-plugin',
    });
    current.manifest.artifacts = {
      targets: [
        {
          id: 'optional-present', platform: 'codex', scopes: ['project'],
          target: 'codex.developerInstructionsBlock', states: ['present', 'disabled'],
          projectManagedKind: 'instruction',
          refreshKeys: [], requiresCodexProjectConfig: true,
        },
        {
          id: 'disabled-only', platform: 'codex', scopes: ['project'],
          target: 'codex.developerInstructionsBlock', states: ['disabled'],
          projectManagedKind: 'instruction',
          refreshKeys: [], requiresCodexProjectConfig: true,
        },
      ],
    };
    const inspectTarget = vi.fn(inspectRebuildTarget);
    const result = await statusCommand([current.manifest.name], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      inspectTarget,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    expect(result.payload.targets[0]?.errors).toEqual([]);
    expect(result.payload.targets[0]?.state).toBe('absent');
    const planned = await inspectTarget.mock.results[0]!.value;
    expect(planned.target.desiredOwnedComponents).toEqual([]);
    expect(planned.target.optionalOwnedComponents).toHaveLength(1);
  });

  it('requires a shared developer instructions block when a present-capable target cannot be disabled', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await fs.realpath(isolation.layout.fixtureCwd);
    const current = await dynamicRendererPlugin(isolation.layout.rootDir, {
      name: 'required-instructions-plugin',
    });
    current.manifest.artifacts = {
      targets: [
        {
          id: 'required-present', platform: 'codex', scopes: ['project'],
          target: 'codex.developerInstructionsBlock', states: ['present'],
          projectManagedKind: 'instruction',
          refreshKeys: [], requiresCodexProjectConfig: true,
        },
        {
          id: 'disabled-only', platform: 'codex', scopes: ['project'],
          target: 'codex.developerInstructionsBlock', states: ['disabled'],
          projectManagedKind: 'instruction',
          refreshKeys: [], requiresCodexProjectConfig: true,
        },
      ],
    };
    const inspectTarget = vi.fn(inspectRebuildTarget);
    await statusCommand([current.manifest.name], {
      cwd, platform: 'codex', scope: 'project', json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      inspectTarget,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    const planned = await inspectTarget.mock.results[0]!.value;
    expect(planned.target.desiredOwnedComponents).toHaveLength(1);
    expect(planned.target.optionalOwnedComponents).toEqual([]);
  });

  it('does not create or change files during a real status inspection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const current = plugin('read-only-plugin', ['CLAUDE']);
    const before = await filesystemSnapshot(isolation.layout.rootDir);

    const result = await statusCommand(['read-only-plugin'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'claude',
      scope: 'user',
      json: true,
    }, {
      env: isolation.env,
      catalogResolution: catalog(),
      catalogPlugins: [current],
      nativeCliRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    expect(result.payload.targets[0]?.state).toBe('absent');
    expect(await filesystemSnapshot(isolation.layout.rootDir)).toEqual(before);
  });
});
