import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedSkillEnv,
  prepareIsolatedSkillCommandReferences,
  prepareSkillPluginBundle,
} from '../../src/review/skill-materialization.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { materializeReviewNativeSkills } from '../../src/commands/rebuild-integration.js';
import { getPluginCommandId } from '@lesliechan721/aw-plugin-core/manifest';
import type { PluginManifestSource } from '../../src/types.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});

describe('Skill materialization', () => {
  it.each([
    { kind: 'static-skill', consumer: 'static' },
    { kind: 'artifact', consumer: 'static' },
    { kind: 'package', consumer: 'static' },
    { kind: 'package', consumer: 'aw-extension' },
    { kind: 'static-skill', consumer: 'codex-native' },
    { kind: 'artifact', consumer: 'codex-native' },
  ] as const)(
    'resolves $consumer references to an unselected $kind producer using isolated candidates only',
    async ({ kind, consumer }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-command-reference-'));
      tempRoots.push(root);
      const pluginRoot = path.join(root, 'source');
      const producer = kind === 'static-skill'
        ? { kind, platform: 'codex' as const, skillKey: 'provider' }
        : kind === 'artifact' ? { kind, artifactId: 'provider' } : { kind, packageKey: 'provider' };
      const manifest: PluginManifestSource = {
        schemaVersion: 3, name: 'review-commands', version: '0.1.0',
        description: 'Review command candidate fixture.', skills: './skills',
        requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
        marketplace: { category: 'test', strict: true, policy: {
          installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'],
        } },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
        managedCommands: {
          packages: kind === 'package' ? [{
            key: 'provider', scope: 'user', platforms: ['codex'], sourceDir: './tools', render: true,
          }] : [],
          sets: [{ set: 'tools', producer, mode: 'dynamic', refreshKeys: [] }],
        },
        ...(kind === 'artifact' ? { artifacts: { targets: [{
          id: 'provider', platform: 'codex', target: 'codex.skill', kind: 'skill',
          delivery: { mode: 'aw-extension' }, scopes: ['user'], states: ['present'],
          refreshKeys: [], skillKey: 'provider',
        }] } } : {}),
      };
      if (consumer !== 'static') {
        manifest.artifacts ??= { targets: [] };
        manifest.artifacts.targets!.push({
          id: 'consumer', platform: 'codex', target: 'codex.skill', kind: 'skill',
          delivery: consumer === 'codex-native'
            ? { mode: 'codex-native', identity: 'shared', renderProfile: 'user' }
            : { mode: 'aw-extension' },
          scopes: consumer === 'codex-native' ? ['user', 'project'] : ['user'],
          states: ['present'], refreshKeys: [], skillKey: 'consumer',
        });
      }
      await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest);
      const writeStaticSkill = async (skill: string, body: string): Promise<void> => {
        await fs.outputFile(path.join(pluginRoot, 'skills', skill, 'SKILL.md'),
          `---\nname: ${skill}\ndescription: Review fixture.\n---\n${body}\n`);
        await fs.outputFile(path.join(pluginRoot, 'skills', skill, 'README.md'), `# ${skill}\n`);
        await fs.outputFile(path.join(pluginRoot, 'skills', skill, 'agents', 'openai.yaml'),
          'policy:\n  allow_implicit_invocation: true\n');
      };
      await fs.ensureDir(path.join(pluginRoot, 'skills'));
      if (consumer === 'static') {
        await writeStaticSkill('consumer', 'Use {{aw.command:tools/run}} check.');
        await fs.outputFile(path.join(pluginRoot, 'skills', 'consumer', 'references', 'usage.md'),
          '```sh\n{{aw.command:tools/run/default}} check\n```\n');
        await fs.outputFile(path.join(pluginRoot, 'skills', 'consumer', 'scripts', 'literal.json'),
          '{"template":"{{aw.command:tools/run}}"}\n');
      }
      if (kind === 'static-skill') {
        await writeStaticSkill('provider', '[Command](scripts/tool.mjs).');
        await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', 'scripts', 'tool.mjs'), 'export {};\n');
      }
      if (kind === 'package') await fs.outputFile(path.join(pluginRoot, 'tools', 'scripts', 'tool.mjs'), 'export {};\n');
      await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
        "import fs from 'node:fs';",
        "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
        'const artifacts = context.requestedArtifactIds.map((id) => {',
        "  if (id === 'command-set.tools') return { id, target: 'aw.command-set', kind: 'commandSet',",
        `    ${kind === 'package' ? '' : "platform: 'codex',"} state: 'present', refreshKeys: [],`,
        "    entries: [{ key: 'run', runner: 'node', entry: 'scripts/tool.mjs' }] };",
        "  if (id === 'command-package.provider') return { id, target: 'aw.command-package', kind: 'commandPackage',",
        "    state: 'present', refreshKeys: [], files: { 'settings.json': '{\"mode\":\"prepared\"}' } };",
        "  const skillKey = id === 'consumer' ? 'consumer' : 'provider';",
        "  const body = id === 'consumer' ? 'Use {{aw.command:tools/run}} check.' : '[Command](scripts/tool.mjs).';",
        "  return { id, platform: 'codex', target: 'codex.skill', kind: 'skill', state: 'present',",
        "    skillKey, refreshKeys: [], content: { files: {",
        "      'SKILL.md': `---\\nname: ${skillKey}\\ndescription: Provider fixture.\\n---\\n${body}\\n`,",
        "      'README.md': '# Provider\\n', 'scripts/tool.mjs': 'export {};\\n',",
        "      'references/usage.md': '```sh\\n{{aw.command:tools/run/default}} check\\n```\\n',",
        "      'scripts/literal.json': '{\"template\":\"{{aw.command:tools/run}}\"}\\n',",
        "      'agents/openai.yaml': 'policy:\\n  allow_implicit_invocation: true\\n',",
        '    } } };',
        '});',
        'console.log(JSON.stringify({ version: 2, artifacts }));',
      ].join('\n'));
      const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
      const plugin = await readPluginManifest(pluginRoot);
      const prepared = await prepareSkillPluginBundle({
        plugin, plugins: [plugin], workRoot: path.join(root, 'work'), env,
      });
      const sourceIdentity = `sha256:${'a'.repeat(64)}`;
      const bundlePlugin = {
        ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity,
        pluginId: 'fixture/review-commands',
      };
      const outputRoot = path.join(root, 'review');
      try {
        const result = await materializeReviewNativeSkills({
          plugin: bundlePlugin, platform: 'codex', scope: 'user', cwd: root, env,
          outputRoot, skills: [{ skill: 'consumer', targetId: consumer === 'static' ? null : 'consumer' }],
        });
        const id = getPluginCommandId({ schemaVersion: 1, producer: {
          sourceId: 'fixture', sourceIdentity, pluginName: 'review-commands', kind,
          key: 'provider', platform: kind === 'package' ? null : 'codex', scope: 'user', projectRoot: null,
        }, set: 'tools', key: 'run', variant: 'default' });
        expect(result.skills.map((skill) => skill.skill)).toEqual(['consumer']);
        await expect(fs.readFile(path.join(outputRoot, 'skills', 'consumer', 'SKILL.md'), 'utf8'))
          .resolves.toContain(`aw command run ${id} -- check`);
        await expect(fs.readFile(path.join(outputRoot, 'skills', 'consumer', 'references', 'usage.md'), 'utf8'))
          .resolves.toContain(`aw command run ${id} -- check`);
        await expect(fs.readFile(path.join(outputRoot, 'skills', 'consumer', 'scripts', 'literal.json'), 'utf8'))
          .resolves.toContain('{{aw.command:tools/run}}');
        await expect(fs.pathExists(path.join(outputRoot, 'skills', 'provider'))).resolves.toBe(false);
        await expect(fs.pathExists(path.join(env.AW_HOME!, 'commands'))).resolves.toBe(false);
        expect(await fs.readdir(env.TMPDIR!)).not.toContain(expect.stringMatching(/^aw-review-command-/u));
      } finally {
        await prepared.cleanup();
      }
    },
  );

  it('uses shared user references for Claude static Skills selected from a project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-claude-shared-'));
    tempRoots.push(root);
    const pluginRoot = path.join(root, 'source');
    const tracePath = path.join(root, 'render-contexts.jsonl');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'shared-claude', version: '0.1.0', description: 'Shared Claude Review fixture.',
      skills: './skills', requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      marketplace: { category: 'test', strict: true, policy: {
        installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CLAUDE'],
      } },
      config: { schemaVersion: 4, fields: { mode: { type: 'string', default: 'default' } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: {
        packages: [{ key: 'project-tools', scope: 'project', platforms: ['claude'], sourceDir: './tools' }],
        sets: [
          { set: 'tools', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'provider' },
            mode: 'dynamic', refreshKeys: ['mode'] },
          { set: 'project-tools', producer: { kind: 'package', packageKey: 'project-tools' },
            mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'tool.mjs' }] },
        ],
      },
    });
    for (const skill of ['consumer', 'provider']) {
      await fs.outputFile(path.join(pluginRoot, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: Shared Claude fixture.\n---\n`
          + (skill === 'consumer' ? '{{aw.command:tools/run/from-user}} check\n' : '[Command](tool.mjs).\n'));
      await fs.outputFile(path.join(pluginRoot, 'skills', skill, 'README.md'), `# ${skill}\n`);
    }
    await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', 'tool.mjs'), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'tools', 'tool.mjs'), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs';",
      "const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      `fs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ scope: c.scope, configScope: c.config.targetScope, values: c.config.values }) + '\\n');`,
      "console.log(JSON.stringify({ version: 2, artifacts: c.requestedArtifactIds.map(id => ({",
      "  id, target: 'aw.command-set', kind: 'commandSet', platform: 'claude', state: 'present',",
      "  refreshKeys: ['mode'], entries: [{ key: 'run', variant: c.config.values.mode, runner: 'node', entry: 'tool.mjs' }],",
      '})) }));',
    ].join('\n'));
    const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const plugin = await readPluginManifest(pluginRoot);
    const prepared = await prepareSkillPluginBundle({
      plugin, plugins: [plugin], workRoot: path.join(root, 'work'), env,
    });
    try {
      const logicalIdentity = 'fixture/shared-claude';
      const bundlePlugin = {
        ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity, catalogLogicalIdentity: logicalIdentity,
      };
      for (const scope of ['user', 'project'] as const) {
        await writePluginConfigStore({
          sourceId: 'fixture', sourceIdentity, logicalIdentity, pluginName: plugin.manifest.name,
          scope, cwd: root, env, values: { mode: `from-${scope}` },
        });
      }
      const materialize = (output: string) => materializeReviewNativeSkills({
        plugin: bundlePlugin, platform: 'claude', scope: 'project', cwd: root, env,
        outputRoot: path.join(root, output), skills: [{ skill: 'consumer', targetId: null }],
      });
      const result = await materialize('valid');
      const id = getPluginCommandId({ schemaVersion: 1, producer: {
        sourceId: 'fixture', sourceIdentity, pluginName: plugin.manifest.name,
        kind: 'static-skill', key: 'provider', platform: 'claude', scope: 'user', projectRoot: null,
      }, set: 'tools', key: 'run', variant: 'from-user' });
      await expect(fs.readFile(path.join(result.skills[0]!.path, 'SKILL.md'), 'utf8'))
        .resolves.toContain(`aw command run ${id} -- check`);
      expect((await fs.readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual([{ scope: 'user', configScope: 'user', values: { mode: 'from-user' } }]);

      await fs.appendFile(path.join(prepared.bundleRoot, 'claude', 'skills', 'consumer', 'SKILL.md'),
        '{{aw.command:project-tools/run}}\n');
      await expect(materialize('invalid-project-package')).rejects.toThrow('commandReferenceInvalid');
      await expect(fs.pathExists(path.join(env.AW_HOME!, 'commands'))).resolves.toBe(false);
    } finally {
      await prepared.cleanup();
    }
  });

  it.each(['undeclared', 'project-package', 'other-platform', 'missing-capability', 'malformed'] as const)(
    'rejects %s command references without registering commands',
    async (failure) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-command-invalid-'));
      tempRoots.push(root);
      const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
      const manifest: PluginManifestSource = {
        schemaVersion: 3, name: 'invalid-review', version: '0.1.0', description: 'Invalid reference fixture.',
        extensions: { instructions: [{ name: 'anchor', title: 'Anchor', content: 'Anchor.' }] },
        requires: { aw: { capabilities: failure === 'missing-capability' ? [] : ['aw.managed-commands.v1'] } },
        marketplace: { category: 'test', strict: true, policy: {
          installation: 'AVAILABLE', authentication: 'ON_INSTALL',
        } },
        ...(failure === 'project-package' || failure === 'other-platform' ? { managedCommands: {
          packages: [{ key: 'provider', scope: failure === 'project-package' ? 'project' : 'user',
            platforms: [failure === 'other-platform' ? 'claude' : 'codex'], sourceDir: './tools' }],
          sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'provider' }, mode: 'static',
            entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }],
        } } : {}),
      };
      await fs.outputJson(path.join(root, '.agents-plugin', 'plugin.json'), manifest);
      if (manifest.managedCommands) await fs.outputFile(path.join(root, 'tools', 'run.mjs'), 'export {};\n');
      const plugin = {
        ...await readPluginManifest(root), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      };
      const tree = { skillKey: 'consumer', files: {
        'SKILL.md': Buffer.from(failure === 'malformed' ? '{{aw.command:tools}}' : '{{aw.command:tools/run}}'),
      } };
      await expect(prepareIsolatedSkillCommandReferences({
        plugin, platform: 'codex', scope: 'user', cwd: root, env, trees: [tree],
      })).rejects.toThrow(failure === 'missing-capability' ? 'require aw.managed-commands.v1' : 'commandReferenceInvalid');
      await expect(fs.pathExists(path.join(env.AW_HOME!, 'commands'))).resolves.toBe(false);
      expect(tree.files['SKILL.md'].toString()).toContain('{{aw.command:');
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
      TMPDIR: '/unexpected/tmp',
    }, root);

    expect(env).toMatchObject({
      HOME: path.join(root, 'home'),
      USERPROFILE: path.join(root, 'home'),
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      CODEX_HOME: path.join(root, 'codex-home'),
      TMPDIR: path.join(root, 'tmp'),
      TEMP: path.join(root, 'tmp'),
      TMP: path.join(root, 'tmp'),
      NODE_PATH: '',
    });
    for (const key of [
      'HOME',
      'AW_HOME',
      'AW_CODEX_HOME',
      'AW_CLAUDE_HOME',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
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
      schemaVersion: 3,
      name: 'runtime-provider',
      version: '0.1.0',
      description: 'Runtime import provider for materialization.',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
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
      schemaVersion: 3,
      name: 'isolated-build',
      version: '0.1.0',
      description: 'Plugin used to verify isolated Skill materialization.',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
      scripts: {
        node: { build: { runner: 'node', path: './build.mjs' } },
      },
      buildConfig: {
        generatedSkillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/environment.json',
        }],
        skillRuntimeFiles: [{
          skill: 'demo',
          target: 'references/registry.json',
          import: { plugin: 'runtime-provider', export: 'registry' },
        }],
      },
    }, { spaces: 2 });
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Verify materialization.\n---\n'
      + '[environment](references/environment.json)\n'
      + '[registry](references/registry.json)\n',
    );
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'demo', 'agents', 'openai.yaml'),
      'interface:\n  display_name: Demo\n',
    );
    await fs.writeFile(path.join(pluginRoot, 'build.mjs'), [
      "import fs from 'node:fs/promises';",
      "await fs.mkdir('skills/demo/references', { recursive: true });",
      "const keys = ['HOME', 'AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME', 'TMPDIR'];",
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
    await expect(fs.readJson(path.join(
      prepared.bundleRoot,
      'codex',
      'skills',
      'demo',
      'references',
      'environment.json',
    ))).resolves.toEqual({
      HOME: env.HOME,
      AW_HOME: env.AW_HOME,
      AW_CODEX_HOME: env.AW_CODEX_HOME,
      AW_CLAUDE_HOME: env.AW_CLAUDE_HOME,
      TMPDIR: env.TMPDIR,
    });
    await expect(fs.readJson(path.join(
      prepared.bundleRoot,
      'codex',
      'skills',
      'demo',
      'references',
      'registry.json',
    ))).resolves.toEqual({ source: 'provider' });

    await prepared.cleanup();
    await expect(fs.pathExists(prepared.bundleRoot)).resolves.toBe(false);
  });
});
