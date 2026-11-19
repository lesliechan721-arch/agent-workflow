import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
import { NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: repeated native inventory startup can exhaust the public
// install deadline. Measure external requests through real discovery and CLI,
// while preserving the completed package, descriptor and project activation.
describe('public Copilot discovery budget', () => {
  it.each([
    ['healthy', null], ['marketplace timeout', 'nativeMarketplaceUnconfirmed'],
    ['marketplace exit', 'nativeMarketplaceUnconfirmed'], ['invalid marketplace JSON', 'nativeMarketplaceUnconfirmed'],
    ['timeout with unconfirmed cleanup', 'nativeCliTimedOut'], ['unknown source format', null],
    ['configuration read failure', 'nativeConfigurationUnreadable'],
  ] as const)('installs a project with bounded requests when the final read reports %s', async (scenario, failure) => {
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
    let finalRead = false;
    const runner = async (invocation: NativeCliInvocation) => {
      const args = invocation.args[0] === actualEntry ? invocation.args.slice(1) : invocation.args;
      calls.push(args);
      let stdout = '';
      if (args.join(' ') === '--version') stdout = 'GitHub Copilot CLI 1.0.95';
      else if (args.join(' ') === 'plugin marketplace list --json') {
        if (finalRead && (scenario === 'marketplace timeout' || scenario === 'timeout with unconfirmed cleanup')) {
          throw new NativeCliError({ invocation, exitCode: 124, reason: 'timeout', stdout: '', stderr: 'controlled timeout',
            ...(scenario === 'timeout with unconfirmed cleanup' ? { cleanupError: new Error('controlled cleanup failure') } : {}) });
        }
        if (finalRead && scenario === 'marketplace exit') return { exitCode: 1, stdout: '', stderr: 'controlled failure' };
        if (finalRead && scenario === 'invalid marketplace JSON') return { exitCode: 0, stdout: '{', stderr: '' };
        stdout = JSON.stringify(marketplaceRoot ? [{ name: marketplaceName,
          source: finalRead && scenario === 'unknown source format' ? {} : marketplaceRoot }] : []);
      } else if (args.join(' ') === 'plugin list --json') {
        const settingsPath = path.join(invocation.cwd, '.github/copilot/settings.local.json');
        const settings = await fs.pathExists(settingsPath) ? await fs.readJson(settingsPath) : {};
        stdout = JSON.stringify(installed ? [{ name: 'demo', marketplace: marketplaceName, source: marketplaceRoot,
          enabled: settings.enabledPlugins?.[`demo@${marketplaceName}`] === true }] : []);
      } else if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
        marketplaceRoot = args[3]!;
        marketplaceName = (await fs.readJson(path.join(marketplaceRoot, '.github/plugin/marketplace.json'))).name;
      } else if (args.slice(0, 2).join(' ') === 'plugin install') {
        expect(args[2]).toBe(`demo@${marketplaceName}`);
        installed = true;
      } else throw new Error(`Unexpected controlled native request: ${args.join(' ')}`);
      return { exitCode: 0, stdout, stderr: '' };
    };
    const settingsPath = path.join(cwd, '.github/copilot/settings.local.json');
    const readFile = fs.readFile.bind(fs);
    let restoreRead: (() => void) | undefined;
    const result = await runCliEntry(['plugin', 'install', 'team/demo', '--scope', 'project', '--target', 'copilot', '--yes', '--json'],
      { cwd, env, nativeCliRunner: runner, debugLogger: { log(event) {
        if (event.data?.name !== 'recovery.status' || event.data.phase !== 'start') return;
        finalRead = true;
        if (scenario === 'configuration read failure') {
          const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
            if (String(args[0]) === settingsPath) throw Object.assign(new Error('controlled read failure'), { code: 'EIO' });
            return readFile(...args);
          });
          restoreRead = () => spy.mockRestore();
        }
      } } }).finally(() => restoreRead?.());
    expect(finalRead).toBe(true);
    expect(result.exitCode, result.stdout + result.stderr).toBe(failure ? 4 : 0);
    expect(result.parseJsonStdout()).toMatchObject({ status: failure ? 'partial' : 'success', data: {
      changes: { requirements: 'changed', outputs: 'changed' }, remainingTargets: [],
      allSatisfied: scenario === 'healthy' ? true : null,
      targetResults: [expect.objectContaining({ pluginId: 'team/demo', target: 'copilot', scope: 'project',
        execution: 'applied', observation: 'verified' })] },
      ...(failure ? { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
        ...(scenario === 'timeout with unconfirmed cleanup' ? {} : { subject: { pluginId: 'team/demo', target: 'copilot', scope: 'project' } }),
        detail: { reasonCode: failure } })]),
        nextActions: [expect.objectContaining({ argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'], requiresConfirmation: false })] }
        : { nextActions: [] }) });
    expect(installed).toBe(true);
    expect(await fs.readFile(path.join(marketplaceRoot!, 'plugins/demo/skills/demo/SKILL.md'), 'utf8')).toBe(content);
    const settings = await fs.readJson(settingsPath);
    expect(settings.enabledPlugins[`demo@${marketplaceName}`]).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(85);
  });
});
