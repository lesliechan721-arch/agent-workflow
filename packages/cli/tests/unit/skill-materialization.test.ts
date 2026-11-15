import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { getPluginCommandId } from '@lesliechan721/aw-plugin-core/manifest';
import { createIsolatedSkillEnv, prepareSkillPluginBundle } from '../../src/review/skill-materialization.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { preparePlatformComponents, resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { finalizePlatformSkillProducers } from '../../src/utils/component-command-preparation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import type { PluginManifestSource, PluginMeta, PlatformName } from '../../src/types.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
const tempRoots: string[] = [];
const placementKey = `sha256:${'b'.repeat(64)}`;
afterEach(async () => { await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root))); });
async function finalize(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  root: string;
  env: NodeJS.ProcessEnv;
  output?: string;
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
    skillWorkRoot: path.join(options.root, options.output ?? 'candidates'), renderUnit: {
      physicalKey: placementKey, renderScope: { kind: 'user' }, kinds: ['skill']
    }
  });
}
describe('Skill materialization', () => {
  it.each([
    {
      kind: 'static-skill', consumer: 'static'
    }, {
      kind: 'artifact', consumer: 'static'
    }, {
      kind: 'package', consumer: 'static'
    },
    {
      kind: 'package', consumer: 'dynamic'
    }, {
      kind: 'static-skill', consumer: 'dynamic'
    }, {
      kind: 'artifact', consumer: 'dynamic'
    },
  ] as const)('resolves $consumer references to a $kind from the complete isolated candidate set', async ({ kind, consumer }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-command-reference-'));
    tempRoots.push(root);
    const pluginRoot = path.join(root, 'source');
    const producer = kind === 'static-skill' ? {
      kind, platform: 'codex', skillKey: 'provider'
    }
      : kind === 'artifact' ? {
        kind, platform: 'codex', artifactId: 'provider'
      } : {
        kind, packageKey: 'provider'
      };
    const manifest = {
      schemaVersion: 4, name: 'review-commands', version: '0.1.0', description: 'Review command candidate fixture.', platforms: ['codex'], ...(consumer === 'static' || kind === 'static-skill' ? { skills: './skills' } : {}),
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } }, marketplace: {
        category: 'test', strict: true, policy: {
          installation: 'AVAILABLE', authentication: 'ON_INSTALL'
        }
      },
      scripts: {
        artifacts: {
          render: {
            runner: 'node', path: './render.mjs'
          }
        }
      },
      ...(kind === 'artifact' || consumer === 'dynamic' ? { artifacts: { configKeys: [] } } : {}),
      managedCommands: {
        packages: kind === 'package' ? [{
          key: 'provider', scope: 'user', platforms: ['codex'], sourceDir: './tools', render: true
        }] : [],
        sets: [{
          set: 'tools', producer, mode: 'dynamic', refreshKeys: []
        }]
      }
    };
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), manifest);
    const files = (skill: string, body: string) => ({
      'SKILL.md': `---\nname: ${skill}\ndescription: Review fixture.\n---\n${body}\n`,
      'README.md': `# ${skill}\n`, 'scripts/tool.mjs': 'export {};\n',
      'references/usage.md': '```sh\n{{aw.command:tools/run/default}} check\n```\n',
      'scripts/literal.json': '{"template":"{{aw.command:tools/run}}"}\n'
    });
    if (consumer === 'static' || kind === 'static-skill') {
      await fs.ensureDir(path.join(pluginRoot, 'skills'));
    }
    if (consumer === 'static') {
      for (const [file, bytes] of Object.entries(files('consumer', 'Use {{aw.command:tools/run}} check.'))) {
        await fs.outputFile(path.join(pluginRoot, 'skills/consumer', file), bytes);
      }
    }
    if (kind === 'static-skill') {
      for (const [file, bytes] of Object.entries(files('provider', '[Command](scripts/tool.mjs).'))) {
        await fs.outputFile(path.join(pluginRoot, 'skills/provider', file), bytes);
      }
    }
    if (kind === 'package') {
      await fs.outputFile(path.join(pluginRoot, 'tools/scripts/tool.mjs'), 'export {};\n');
    }
    const dynamicNames = [...(kind === 'artifact' ? ['provider'] : []), ...(consumer === 'dynamic' ? ['consumer'] : [])];
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `
import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));
if(c.surface==='agent-plugin'){
const values=${JSON.stringify(Object.fromEntries(dynamicNames.map(name => [name, files(name, name === 'consumer' ? 'Use {{aw.command:tools/run}} check.' : '[Command](scripts/tool.mjs).')])))};
console.log(JSON.stringify({version:3,components:Object.entries(values).map(([name,files])=>({id:name,kind:'skill',name,content:{files:Object.fromEntries(Object.entries(files).map(([file,text])=>[file,{text}]))}})),omitted:[],unmet:[]}));
}else console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>id==='command-set.tools'?{id,target:'aw.command-set',kind:'commandSet',${kind === 'package' ? '' : "platform:'codex',"}state:'present',refreshKeys:[],entries:[{key:'run',runner:'node',entry:'scripts/tool.mjs'}]}:{id,target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:[],files:{'settings.json':'{"mode":"prepared"}'}})}));
`);
    const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
    const plugin = await readPluginManifest(pluginRoot);
    const prepared = await prepareSkillPluginBundle({
      plugin, plugins: [plugin], workRoot: path.join(root, 'work'), env
    });
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const bundlePlugin = {
      ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity, pluginId: 'fixture/review-commands'
    };
    try {
      const result = await finalize({
        plugin: bundlePlugin, platform: 'codex', root, env
      });
      try {
        const id = getPluginCommandId({
          schemaVersion: 2, producer: {
            sourceId: 'fixture', sourceIdentity, pluginName: 'review-commands', kind, key: 'provider',
            platform: kind === 'package' ? null : 'codex', scope: 'user', projectRoot: null, placementKey: kind === 'package' ? null : placementKey
          }, set: 'tools', key: 'run', variant: 'default'
        });
        const tree = result.skills.find(skill => skill.tree.skillKey === 'consumer')!.tree;
        expect(tree.files['SKILL.md']!.toString()).toContain(`aw command run ${id} -- check`);
        expect(tree.files['references/usage.md']!.toString()).toContain(`aw command run ${id} -- check`);
        expect(tree.files['scripts/literal.json']!.toString()).toContain('{{aw.command:tools/run}}');
        expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands'))).toBe(false);
      }
      finally {
        await result.cleanup();
      }
    }
    finally {
      await prepared.cleanup();
    }
  });
  it('uses shared user config for native Skill commands and rejects project-only packages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-shared-'));
    tempRoots.push(root);
    const pluginRoot = path.join(root, 'source');
    const trace = path.join(root, 'trace.jsonl');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), {
      schemaVersion: 4, name: 'shared-native', version: '0.1.0', description: 'Shared user command fixture.', platforms: ['claude'], skills: './skills',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } }, marketplace: {
        category: 'test', strict: true, policy: {
          installation: 'AVAILABLE', authentication: 'ON_INSTALL'
        }
      },
      config: {
        schemaVersion: 5, fields: {
          mode: {
            type: 'string', default: 'default'
          }
        }
      }, scripts: {
        artifacts: {
          render: {
            runner: 'node', path: './render.mjs'
          }
        }
      },
      managedCommands: {
        packages: [{
          key: 'project-tools', scope: 'project', platforms: ['claude'], sourceDir: './tools'
        }], sets: [
          {
            set: 'tools', producer: {
              kind: 'static-skill', platform: 'claude', skillKey: 'provider'
            }, mode: 'dynamic', refreshKeys: ['mode']
          },
          {
            set: 'project-tools', producer: {
              kind: 'package', packageKey: 'project-tools'
            }, mode: 'static', entries: [{
              key: 'run', runner: 'node', entry: 'tool.mjs'
            }]
          }
        ]
      }
    });
    for (const name of ['consumer', 'provider']) {
      await fs.outputFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Shared fixture.\n---\n${name === 'consumer' ? '{{aw.command:tools/run/from-user}} check' : '[Command](tool.mjs).'}\n`);
      await fs.outputFile(path.join(pluginRoot, 'skills', name, 'README.md'), `# ${name}\n`);
    }
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/tool.mjs'), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), 'export {};\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs';const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({scope:c.scope,values:c.config.values})+'\\n');console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',platform:'claude',state:'present',refreshKeys:['mode'],entries:[{key:'run',variant:c.config.values.mode,runner:'node',entry:'tool.mjs'}]}))}));`);
    const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
    const plugin = await readPluginManifest(pluginRoot);
    const prepared = await prepareSkillPluginBundle({
      plugin, plugins: [plugin], workRoot: path.join(root, 'work'), env
    });
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const logicalIdentity = 'fixture/shared-native';
    const bundlePlugin = {
      ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity, catalogLogicalIdentity: logicalIdentity
    };
    try {
      await writePluginConfigStore({
        sourceId: 'fixture', sourceIdentity, logicalIdentity, pluginName: plugin.manifest.name, scope: 'user', platform: 'claude', cwd: root, env, values: { mode: 'from-user' }
      });
      const result = await finalize({
        plugin: bundlePlugin, platform: 'claude', root, env, output: 'valid'
      });
      try {
        expect(result.skills.find(skill => skill.tree.skillKey === 'consumer')!.tree.files['SKILL.md']!.toString()).toMatch(/aw command run cmdp_[a-f0-9]{16} -- check/);
        expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([{
          scope: 'user', values: { mode: 'from-user' }
        }]);
      }
      finally {
        await result.cleanup();
      }
      await fs.appendFile(path.join(prepared.bundleRoot, 'claude/skills/consumer/SKILL.md'), '{{aw.command:project-tools/run}}\n');
      await expect(finalize({
        plugin: bundlePlugin, platform: 'claude', root, env, output: 'invalid'
      })).rejects.toThrow('commandReferenceInvalid');
      expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands'))).toBe(false);
    }
    finally {
      await prepared.cleanup();
    }
  });
  it.each(['undeclared', 'project-package', 'other-platform', 'missing-capability', 'malformed'] as const)('rejects %s references without publishing commands', async (failure) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-invalid-'));
    tempRoots.push(root);
    const pluginRoot = path.join(root, 'source');
    const env = await createIsolatedSkillEnv(process.env, path.join(root, 'isolated'));
    const manifest: PluginManifestSource = {
      schemaVersion: 4, name: 'invalid-review', version: '0.1.0', description: 'Invalid reference fixture.', platforms: ['codex'], skills: './skills',
      requires: { aw: { capabilities: failure === 'missing-capability' ? [] : ['aw.managed-commands.v1'] } }, marketplace: {
        category: 'test', strict: true, policy: {
          installation: 'AVAILABLE', authentication: 'ON_INSTALL'
        }
      },
      ...(failure === 'project-package' || failure === 'other-platform' ? {
        managedCommands: {
          packages: [{
            key: 'provider', scope: failure === 'project-package' ? 'project' : 'user', platforms: [failure === 'other-platform' ? 'claude' : 'codex'], sourceDir: './tools'
          }], sets: [{
            set: 'tools', producer: {
              kind: 'package', packageKey: 'provider'
            }, mode: 'static', entries: [{
              key: 'run', runner: 'node', entry: 'run.mjs'
            }]
          }]
        }
      } : {})
    };
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin/plugin.json'), manifest);
    await fs.outputFile(path.join(pluginRoot, 'skills/consumer/SKILL.md'), `---\nname: consumer\ndescription: Invalid reference.\n---\n${failure === 'malformed' ? '{{aw.command:tools}}' : '{{aw.command:tools/run}}'}\n`);
    await fs.outputFile(path.join(pluginRoot, 'skills/consumer/README.md'), '# Consumer\n');
    if (manifest.managedCommands) {
      await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'export {};\n');
    }
    const source = await readPluginManifest(pluginRoot);
    const prepared = await prepareSkillPluginBundle({
      plugin: source, plugins: [source], workRoot: path.join(root, 'work'), env
    });
    try {
      const plugin = {
        ...prepared.bundlePlugin, sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}`
      };
      if (failure === 'missing-capability') {
        plugin.manifest.requires = { aw: { capabilities: [] } };
        await fs.remove(path.join(prepared.bundleRoot, 'codex/skills/consumer/aw-plugin-requirements.json'));
      }
      await expect(finalize({
        plugin, platform: 'codex', root, env
      })).rejects.toThrow(failure === 'missing-capability' ? 'require aw.managed-commands.v1' : 'commandReferenceInvalid');
      expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands'))).toBe(false);
    }
    finally {
      await prepared.cleanup();
    }
  });
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
