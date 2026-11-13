import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: repeated native inventory startup can exhaust the public
// install deadline. Measure external requests through real discovery and CLI,
// while preserving the completed package, descriptor and project activation.
describe('public Copilot discovery budget', () => {
  it('installs a project from its first source generation with bounded native requests', async () => {
    const { env: isolatedEnv, layout } = getCurrentSourceTestIsolation();
    const cwd = path.join(layout.fixtureCwd, 'copilot-project');
    const source = path.join(layout.fixtureCwd, 'copilot-source');
    const bin = path.join(layout.fixtureCwd, 'copilot-bin');
    const env = { ...isolatedEnv, PATH: bin };
    await fs.ensureDir(cwd);
    await git(cwd, ['init', '--quiet']);
    const content = '---\nname: demo\ndescription: Copilot budget fixture\n---\nUse demo.\n';
    await fs.outputFile(path.join(source, 'plugins/demo/skills/demo/SKILL.md'), content);
    await fs.outputFile(path.join(source, 'plugins/demo/skills/demo/README.md'), 'Use demo.\n');
    await createDependencyCatalogSnapshotFixture(source, [{ name: 'demo', configureManifest(manifest) {
      manifest.platforms = ['copilot']; manifest.skills = './skills'; delete manifest.extensions;
    } }]);
    const configured = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: configured.digest, env });
    await setTargets({ cwd, env, scope: 'user' }, ['copilot']);
    installNativeTestQualification({ platforms: ['copilot'] });
    const packageRoot = path.join(bin, 'node_modules/@github/copilot');
    const entry = path.join(packageRoot, 'npm-loader.js');
    await fs.outputFile(entry, '#!/usr/bin/env node\n', { mode: 0o755 });
    await fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@github/copilot', version: '1.0.95', bin: { copilot: 'npm-loader.js' },
    });
    if (process.platform === 'win32') await fs.outputFile(path.join(bin, 'copilot.cmd'),
      renderNpmCmdShim('node_modules\\@github\\copilot\\npm-loader.js'));
    else await fs.symlink(entry, path.join(bin, 'copilot'));
    const actualEntry = await fs.realpath(entry);
    const calls: string[][] = [];
    let marketplaceRoot: string | undefined;
    let marketplaceName: string | undefined;
    let installed = false;
    const runner = async (invocation: NativeCliInvocation) => {
      const args = invocation.args[0] === actualEntry ? invocation.args.slice(1) : invocation.args;
      calls.push(args);
      let stdout = '';
      if (args.join(' ') === '--version') stdout = 'GitHub Copilot CLI 1.0.95';
      else if (args.join(' ') === 'plugin marketplace list --json') stdout = JSON.stringify(marketplaceRoot
        ? [{ name: marketplaceName, source: marketplaceRoot }] : []);
      else if (args.join(' ') === 'plugin list --json') stdout = JSON.stringify(installed
        ? [{ name: 'demo', marketplace: marketplaceName, source: marketplaceRoot }] : []);
      else if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
        marketplaceRoot = args[3]!;
        marketplaceName = (await fs.readJson(path.join(marketplaceRoot, '.github/plugin/marketplace.json'))).name;
      } else if (args.slice(0, 2).join(' ') === 'plugin install') {
        expect(args[2]).toBe(`demo@${marketplaceName}`);
        installed = true;
      } else throw new Error(`Unexpected controlled native request: ${args.join(' ')}`);
      return { exitCode: 0, stdout, stderr: '' };
    };
    const result = await runCliEntry(['plugin', 'install', 'team/demo', '--scope', 'project', '--target', 'copilot', '--yes', '--json'],
      { cwd, env, nativeCliRunner: runner });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.parseJsonStdout()).toMatchObject({ status: 'success' });
    expect(installed).toBe(true);
    expect(await fs.readFile(path.join(marketplaceRoot!, 'plugins/demo/skills/demo/SKILL.md'), 'utf8')).toBe(content);
    const settings = await fs.readJson(path.join(cwd, '.github/copilot/settings.local.json'));
    expect(settings.enabledPlugins[`demo@${marketplaceName}`]).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(85);
  });
});
