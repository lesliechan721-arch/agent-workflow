import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import * as registry from '../../src/platforms/registry.js';
import type { DiscoveryResult, ReadContext } from '../../src/platforms/contracts.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { geminiScopePattern } from '../../src/platforms/gemini-activation.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { CommandResult } from '../../src/output/public-result.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: the real CLI parser and recovery path must preserve a separate
// per-request native grant, retain saved demand, and recover without reading stdin.
describe('CLI Gemini native consent', () => {
  it('blocks --yes alone and recovers through sync with explicit native consent', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = path.join(layout.fixtureCwd, 'consent-work');
    const source = path.join(layout.fixtureCwd, 'consent-source');
    await fs.ensureDir(cwd);
    await fs.outputFile(path.join(source, 'plugins/demo/skills/demo/SKILL.md'),
      '---\nname: demo\ndescription: Consent fixture\n---\nUse demo.\n');
    await fs.outputFile(path.join(source, 'plugins/demo/skills/demo/README.md'), 'Use demo.\n');
    await createDependencyCatalogSnapshotFixture(source, [{ name: 'demo', configureManifest(manifest) {
      manifest.platforms = ['gemini']; manifest.skills = './skills'; delete manifest.extensions;
    } }]);
    const configured = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: configured.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['gemini']);
    installNativeTestQualification({ platforms: ['gemini'] });
    const getAdapter = registry.getAgentPluginAdapter;
    const adapter = getAdapter('gemini');
    const executable = path.join(cwd, 'controlled-client');
    await fs.outputFile(executable, 'controlled native boundary');
    const discovery = vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => platform === 'gemini' ? {
      ...adapter,
      async discover(ctx: ReadContext): Promise<DiscoveryResult> { return { platform: 'gemini', availability: 'available', diagnostics: [], installations: [{
        id: 'controlled:gemini', product: 'cli', version: '0.67.0', availability: 'available', reasonCodes: [],
        entry: { kind: 'cli', executable, configRoot: resolvePlatformConfigRoot('gemini', ctx) },
      }] }; },
    } : getAdapter(platform));
    onTestFinished(() => discovery.mockRestore());
    const nativeInstalls: NativeCliInvocation[] = [];
    const runner = async (invocation: NativeCliInvocation) => {
      if (invocation.args.join(' ') === 'extensions list') return { exitCode: 0, stdout: '', stderr: '' };
      expect(invocation.args.slice(0, 2)).toEqual(['extensions', 'install']);
      expect(invocation.args.slice(3)).toEqual(['--consent', '--skip-settings']);
      nativeInstalls.push(invocation);
      const packageRoot = invocation.args[2]!;
      expect(invocation.input?.initial).toBe('');
      expect(invocation.input?.onStdout(`Do you trust the files in this folder?\nThe extension source at "${packageRoot}" is not trusted.\nDo you want to trust this folder and continue with the installation? [y/N]: `))
        .toEqual({ write: 'y\n', end: true });
      const manifest = await fs.readJson(path.join(packageRoot, 'gemini-extension.json'));
      expect(manifest).not.toHaveProperty('settings');
      const configRoot = resolvePlatformConfigRoot('gemini', { cwd, env });
      const installed = path.join(configRoot, 'extensions', manifest.name);
      await fs.copy(packageRoot, installed);
      await fs.outputJson(path.join(installed, '.gemini-extension-install.json'), { type: 'local', source: packageRoot });
      // Independent fixed-host sample; the activation helper must restore its
      // reviewed global intent after this native User enable transformation.
      await fs.outputFile(path.join(configRoot, 'extensions/extension-enablement.json'),
        JSON.stringify({ [manifest.name]: { overrides: [geminiScopePattern(path.dirname(configRoot))] } }, null, 2));
      return { exitCode: 0, stdout: 'Installed.', stderr: '' };
    };
    const first = await runCliEntry(['plugin', 'install', 'team/demo', '--scope', 'user', '--context', 'user', '--yes', '--json'], { cwd, env, nativeCliRunner: runner });
    const blocked = first.parseJsonStdout<CommandResult<LifecycleData>>();
    expect(first.exitCode, first.stdout + first.stderr).toBe(4);
    expect(blocked).toMatchObject({ status: 'partial', data: { request: { nativeConsent: false }, changes: { requirements: 'changed' } } });
    expect(blocked.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeConsentRequired' }));
    expect((blocked.data as LifecycleData).targetResults.flatMap((target) => target.deploymentReceipts?.flatMap((receipt) => receipt.diagnostics) ?? []))
      .toContainEqual(expect.objectContaining({ code: 'nativeConsentRequired', message: expect.stringContaining('--target gemini --native-consent') }));
    expect(blocked.nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: ['aw', 'plugin', 'sync', 'team/demo', '--context', 'user', '--target', 'gemini', '--native-consent'] }));
    expect(nativeInstalls).toHaveLength(0);
    expect(await observeIntent({ cwd, env, scope: 'user' })).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/demo' }] } });
    const retried = await runCliEntry(['plugin', 'sync', 'team/demo', '--context', 'user', '--target', 'gemini', '--native-consent', '--yes', '--json'], { cwd, env, nativeCliRunner: runner });
    expect(retried.exitCode, retried.stdout + retried.stderr).toBe(0);
    expect(retried.parseJsonStdout()).toMatchObject({ status: 'success', data: { request: { nativeConsent: true } }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'nativeConsentGranted', severity: 'warning' })]) });
    expect(nativeInstalls).toHaveLength(1);
  });
});
