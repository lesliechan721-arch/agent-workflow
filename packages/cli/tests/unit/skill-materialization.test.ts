import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedSkillEnv, prepareSkillPluginBundle } from '../../src/review/skill-materialization.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { preparePlatformComponents, resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { finalizePlatformSkillProducers } from '../../src/utils/component-command-preparation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type { PluginManifestSource, PluginMeta, PlatformName } from '../../src/types.js';
const tempRoots: string[] = [];
const placementKey = `sha256:${'b'.repeat(64)}`;
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root))); });
async function finalize(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  root: string;
  env: NodeJS.ProcessEnv;
}) {
  // The preparation boundary consumes qualified facts; this fixture does not qualify a local client.
  const capabilities = getAuthoringPlatformCapabilities(options.platform, 'user');
  capabilities.kinds.skill = {
    status: 'supported', reasonCodes: [], delivery: ['native-package']
  };
  const config = await resolveArtifactRenderConfig({
    pluginName: options.plugin.manifest.name, manifest: options.plugin.manifest,
    platform: options.platform, scope: 'user', cwd: options.root, env: options.env
  });
  const prepared = await preparePlatformComponents({
    plugin: options.plugin, platform: options.platform, renderScope: 'user',
    kinds: ['skill'], capabilities, config, cwd: options.root, commandEnv: options.env,
    staticResourceRoot: path.join(options.plugin.rootDir, options.platform)
  });
  return finalizePlatformSkillProducers({
    ...options, prepared, cwd: options.root,
    skillWorkRoot: path.join(options.root, 'candidates'), renderUnit: {
      physicalKey: placementKey, renderScope: { kind: 'user' }, kinds: ['skill']
    }
  });
}
describe('Skill materialization', () => {
  it.each([
    ['static', 'static'],
    ['static', 'dynamic'],
    ['dynamic', 'static'],
    ['dynamic', 'dynamic'],
  ] as const)('expands %s Skill references to a %s package during isolated preparation', async (skillMode, commandMode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-command-reference-'));
    tempRoots.push(root);
    const pluginRoot = path.join(root, 'source');
    const launch = { name: 'check', runner: 'node', entry: 'tool.mjs' } as const;
    const manifest: PluginManifestSource = {
      schemaVersion: 4, name: 'review-commands', version: '0.1.0',
      description: 'Review command candidate fixture.', platforms: ['codex'],
      requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      ...(skillMode === 'static' ? { skills: './skills' } : { artifacts: { configKeys: [] } }),
      ...(skillMode === 'dynamic' || commandMode === 'dynamic' ? {
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      } : {}),
      command: commandMode === 'static'
        ? { sourceDir: './tools', mode: 'static', routes: { subcommands: [launch] } }
        : { sourceDir: './tools', mode: 'dynamic', refreshKeys: [] },
    };
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), manifest);
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), 'export {};\n');
    const files = {
      'SKILL.md': '---\nname: consumer\ndescription: Review fixture.\n---\nUse {{aw.command}} check.\n',
      'README.md': '# Consumer\n',
      'references/usage.md': '```sh\n{{aw.command}} check\n```\n',
      'scripts/literal.json': '{"template":"{{aw.command}}"}\n',
    };
    if (skillMode === 'static') {
      for (const [file, contents] of Object.entries(files)) {
        await fs.outputFile(path.join(pluginRoot, 'skills/consumer', file), contents);
      }
    }
    if (manifest.scripts) {
      const renderedFiles = Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text }]));
      const components = [{ id: 'consumer', kind: 'skill', name: 'consumer', content: { files: renderedFiles } }];
      const artifacts = [{ id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes',
        refreshKeys: [], routes: { subcommands: [launch] } }];
      await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
        "import fs from 'node:fs';",
        "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
        "if (context.surface === 'agent-plugin') {",
        `  console.log(JSON.stringify(${JSON.stringify({ version: 3, components, omitted: [], unmet: [] })}));`,
        "} else {",
        `  console.log(JSON.stringify(${JSON.stringify({ version: 2, artifacts })}));`,
        "}",
      ].join('\n'));
    }
    const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
    const source = await readPluginManifest(pluginRoot);
    const prepared = await prepareSkillPluginBundle({ plugin: source, plugins: [source], workRoot: path.join(root, 'work'), env });
    try {
      const plugin = { ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`,
        pluginId: 'fixture/review-commands' };
      const result = await finalize({ plugin, platform: 'codex', root, env });
      const tree = result.skills.find((skill) => skill.tree.skillKey === 'consumer')!.tree;
      expect(tree.files['SKILL.md']!.toString()).toContain('aw command run fixture/review-commands -- check');
      expect(tree.files['references/usage.md']!.toString()).toContain('aw command run fixture/review-commands -- check');
      expect(tree.files['scripts/literal.json']!.toString()).toBe(files['scripts/literal.json']);
      expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands'))).toBe(false);
    } finally {
      await prepared.cleanup();
    }
  });

  it.each(['undeclared', 'other-platform', 'missing-capability', 'legacy-placeholder', 'empty-routes'] as const)(
    'handles %s without publishing a package', async (scenario) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-unavailable-'));
      tempRoots.push(root);
      const pluginRoot = path.join(root, 'source');
      const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
      const manifest: PluginManifestSource = {
        schemaVersion: 4, name: 'unavailable-review', version: '0.1.0',
        description: 'Unavailable command fixture.', platforms: ['codex', 'claude'], skills: './skills',
        requires: { aw: { capabilities: ['aw.managed-commands.v2'] } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
        ...(scenario !== 'undeclared' ? {
          command: { sourceDir: './tools', platforms: [scenario === 'other-platform' ? 'claude' : 'codex'],
            mode: 'static', routes: scenario === 'empty-routes' ? {} : {
              subcommands: [{ name: 'check', runner: 'node', entry: 'run.mjs' }],
            } },
        } : {}),
      };
      await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), manifest);
      const reference = scenario === 'legacy-placeholder' ? '{{aw.command:tools/run}}' : '{{aw.command}}';
      await fs.outputFile(path.join(pluginRoot, 'skills/consumer/SKILL.md'),
        `---\nname: consumer\ndescription: Command consumer.\n---\n${reference} check\n`);
      await fs.outputFile(path.join(pluginRoot, 'skills/consumer/README.md'), '# Consumer\n');
      await fs.outputFile(path.join(pluginRoot, 'skills/independent/SKILL.md'),
        '---\nname: independent\ndescription: Standalone Skill.\n---\nNo command dependencies.\n');
      await fs.outputFile(path.join(pluginRoot, 'skills/independent/README.md'), '# Independent\n');
      if (manifest.command) await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'export {};\n');
      const source = await readPluginManifest(pluginRoot);
      const bundle = prepareSkillPluginBundle({ plugin: source, plugins: [source], workRoot: path.join(root, 'work'), env });
      if (scenario === 'undeclared' || scenario === 'legacy-placeholder') {
        await expect(bundle).rejects.toThrow(scenario === 'undeclared'
          ? '{{aw.command}} requires a command declaration' : 'commandReferenceInvalid');
        expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands'))).toBe(false);
        return;
      }
      const prepared = await bundle;
      try {
        const plugin = { ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
        if (scenario === 'missing-capability') {
          plugin.manifest.requires = { aw: { capabilities: [] } };
          await fs.remove(path.join(prepared.bundleRoot, 'codex/skills/consumer/aw-plugin-requirements.json'));
          await fs.remove(path.join(prepared.bundleRoot, 'codex/skills/independent/aw-plugin-requirements.json'));
        }
        const result = finalize({ plugin, platform: 'codex', root, env });
        if (scenario === 'empty-routes') {
          const materialized = await result;
          expect(materialized.skills.map((skill) => skill.tree.skillKey)).toEqual(['independent']);
          expect(materialized.prepared.expected.unmet).toContainEqual(
            expect.objectContaining({ name: 'consumer', reasonCode: 'command-route-unreachable' }),
          );
        } else {
          await expect(result).rejects.toThrow(scenario === 'missing-capability'
            ? 'require aw.managed-commands.v2' : 'codex is outside command.platforms');
        }
        expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands'))).toBe(false);
      } finally {
        await prepared.cleanup();
      }
    },
  );
  it('creates all state and temporary paths under the isolated root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-materialization-env-'));
    tempRoots.push(root);
    const env = await createIsolatedSkillEnv({
      ...process.env,
      HOME: '/unexpected/home',
      AW_HOME: '/unexpected/aw-home',
      AW_CODEX_HOME: '/unexpected/codex-home',
      AW_CLAUDE_HOME: '/unexpected/claude-home',
      CODEX_HOME: '/unexpected/official-codex',
      CLAUDE_CONFIG_DIR: '/unexpected/official-claude',
      XDG_DATA_HOME: '/unexpected/xdg-data',
      XDG_RUNTIME_DIR: '/unexpected/xdg-runtime',
      TMPDIR: '/unexpected/tmp',
    }, root);
    expect(env).toMatchObject({
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      AW_HOME: path.join(root, 'aw-home'),
      CODEX_HOME: path.join(root, 'codex-home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'),
      XDG_DATA_HOME: path.join(root, 'xdg-data'),
      XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
      TMPDIR: path.join(root, 'tmp'),
      TEMP: path.join(root, 'tmp'),
      TMP: path.join(root, 'tmp'),
      NODE_PATH: '',
    });
    expect(env).not.toHaveProperty('AW_CODEX_HOME');
    expect(env).not.toHaveProperty('AW_CLAUDE_HOME');
    for (const key of [
      'HOME',
      'AW_HOME',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
    ] as const) {
      expect((await fs.stat(env[key]!)).isDirectory()).toBe(true);
    }
  });
  it('runs the plugin build with the isolated environment and returns a removable bundle', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-materialization-bundle-'));
    tempRoots.push(root);
    const pluginRoot = path.join(root, 'plugin');
    const providerRoot = path.join(root, 'provider');
    const workRoot = path.join(root, 'work');
    await fs.ensureDir(path.join(providerRoot, '.agents-plugin'));
    await fs.writeJson(path.join(providerRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4,
      name: 'runtime-provider',
      platforms: ['codex'],
      version: '0.1.0',
      description: 'Runtime import provider for materialization.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      buildConfig: {
        runtimeExports: [{
          name: 'registry',
          source: './registry.json',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }, { spaces: 2 });
    await fs.writeJson(path.join(providerRoot, 'registry.json'), { source: 'provider' });
    await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
    await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4,
      name: 'isolated-build',
      platforms: ['codex'],
      version: '0.1.0',
      description: 'Plugin used to verify isolated Skill materialization.',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      scripts: {
        node: {
          build: {
            runner: 'node', path: './build.mjs'
          }
        },
      },
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/environment.json',
        }],
        skillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/registry.json',
          import: {
            plugin: 'runtime-provider', export: 'registry'
          },
        }],
      },
    }, { spaces: 2 });
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Verify materialization.\n---\n'
      + '[environment](references/environment.json)\n'
      + '[registry](references/registry.json)\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'agents', 'openai.yaml'), 'interface:\n  display_name: Demo\n');
    await fs.writeFile(path.join(pluginRoot, 'build.mjs'), [
      "import fs from 'node:fs/promises';",
      "await fs.mkdir('skills/demo/references', { recursive: true });",
      "const keys = ['HOME', 'AW_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TMPDIR'];",
      'const values = Object.fromEntries(keys.map((key) => [key, process.env[key]]));',
      "await fs.writeFile('skills/demo/references/environment.json', JSON.stringify(values));",
    ].join('\n'));
    const plugin = await readPluginManifest(pluginRoot);
    const provider = await readPluginManifest(providerRoot);
    const env = await createIsolatedSkillEnv(process.env, path.join(root, 'environment'));
    const prepared = await prepareSkillPluginBundle({
      plugin,
      plugins: [provider, plugin],
      workRoot,
      env,
    });
    expect(prepared.bundlePlugin.rootDir).toBe(prepared.bundleRoot);
    await expect(fs.readJson(path.join(prepared.bundleRoot, 'codex', 'skills', 'demo', 'references', 'environment.json'))).resolves.toEqual({
      HOME: env.HOME,
      AW_HOME: env.AW_HOME,
      CODEX_HOME: env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
      TMPDIR: env.TMPDIR,
    });
    await expect(fs.readJson(path.join(prepared.bundleRoot, 'codex', 'skills', 'demo', 'references', 'registry.json'))).resolves.toEqual({ source: 'provider' });
    await prepared.cleanup();
    await expect(fs.pathExists(prepared.bundleRoot)).resolves.toBe(false);
  });
});
