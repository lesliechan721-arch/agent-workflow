import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
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
  it.each([false, true])('preserves native consent and bounded fresh discovery with initial grant=%s', async (initialGrant) => {
    const { env: isolatedEnv, layout } = getCurrentSourceTestIsolation();
    const bin = path.join(layout.fixtureCwd, 'gemini-bin');
    const env = { ...isolatedEnv, PATH: bin };
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
    if (!initialGrant) await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['gemini']);
    installNativeTestQualification({ platforms: ['gemini'] });
    const packageRoot = path.join(bin, 'node_modules/@google/gemini-cli');
    const entry = path.join(packageRoot, 'bundle/gemini.js');
    await fs.outputFile(entry, '#!/usr/bin/env node\n', { mode: 0o755 });
    await fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@google/gemini-cli', version: '0.67.0', bin: { gemini: 'bundle/gemini.js' },
    });
    if (process.platform === 'win32') await fs.outputFile(path.join(bin, 'gemini.cmd'),
      renderNpmCmdShim('node_modules\\@google\\gemini-cli\\bundle\\gemini.js'));
    else await fs.symlink(entry, path.join(bin, 'gemini'));
    let versionProbes = 0;
    let probesBeforeInstall = 0;
    const nativeInstalls: NativeCliInvocation[] = [];
    const runner = async (invocation: NativeCliInvocation) => {
      const args = invocation.args[0] === await fs.realpath(entry) ? invocation.args.slice(1) : invocation.args;
      if (args.length === 1 && args[0] === '--version') {
        versionProbes++;
        return { exitCode: 0, stdout: '0.67.0', stderr: '' };
      }
      if (args.join(' ') === 'extensions list') return { exitCode: 0, stdout: '', stderr: '' };
      expect(args.slice(0, 2)).toEqual(['extensions', 'install']);
      expect(args.slice(3)).toEqual(['--consent', '--skip-settings']);
      nativeInstalls.push(invocation);
      probesBeforeInstall = versionProbes;
      const packageRoot = args[2]!;
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
    const first = await runCliEntry(['plugin', 'install', 'team/demo', '--scope', 'user', '--context', 'user', '--yes', ...(initialGrant ? ['--native-consent'] : []), '--json'], { cwd, env, nativeCliRunner: runner });
    if (initialGrant) {
      expect(first.exitCode, first.stdout + first.stderr).toBe(0);
      expect(first.parseJsonStdout()).toMatchObject({ status: 'success', data: { request: { nativeConsent: true } } });
      expect(nativeInstalls).toHaveLength(1);
      const installed = path.join(resolvePlatformConfigRoot('gemini', { cwd, env }), 'extensions/demo/skills/demo/SKILL.md');
      expect(await fs.readFile(installed, 'utf8')).toBe('---\nname: demo\ndescription: Consent fixture\n---\nUse demo.\n');
      // Keep expensive client startup bounded before a native mutation.
      // Bound process requests through the public path, rather than private previews.
      expect(probesBeforeInstall).toBeLessThanOrEqual(11);
      expect(versionProbes).toBeLessThanOrEqual(14);
      return;
    }
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
