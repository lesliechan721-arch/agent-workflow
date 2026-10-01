import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedSkillEnv,
  prepareSkillPluginBundle,
} from '../../src/review/skill-materialization.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)));
});

describe('Skill materialization', () => {
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
      CODEX_HOME: env.CODEX_HOME,
      CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
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
