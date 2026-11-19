import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
import { geminiActivationRules, geminiPathEnabled, geminiScopePattern, geminiUserActivation, readGeminiActivationSnapshot } from '../../src/platforms/gemini-activation.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { CommandResult } from '../../src/output/public-result.js';
import { inventoryRecoveryActions, type LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function geminiFixture(graph: Record<string, string[]>, syncSource: boolean, version = '0.67.0') {
  const { env: isolatedEnv, layout } = getCurrentSourceTestIsolation();
  const bin = path.join(layout.fixtureCwd, 'gemini-bin');
  const env = { ...isolatedEnv, PATH: bin, GEMINI_CLI_HOME: path.join(layout.fixtureCwd, 'gemini config home') };
  const cwd = path.join(layout.fixtureCwd, 'consent-work');
  const source = path.join(layout.fixtureCwd, 'consent-source');
  await fs.ensureDir(cwd);
  for (const name of Object.keys(graph)) {
    await fs.outputFile(path.join(source, 'plugins', name, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Consent fixture\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(source, 'plugins', name, 'skills', name, 'README.md'), `Use ${name}.\n`);
  }
  await createDependencyCatalogSnapshotFixture(source, Object.entries(graph).map(([name, dependencies]) => ({
    name, dependencies, configureManifest(manifest) {
      manifest.platforms = ['gemini']; manifest.skills = './skills'; delete manifest.extensions;
    },
  })));
  const configured = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: configured.digest, env });
  if (syncSource) await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  await setTargets({ cwd, env, scope: 'user' }, ['gemini']);
  installNativeTestQualification({ platforms: ['gemini'] });
  const packageRoot = path.join(bin, 'node_modules/@google/gemini-cli');
  const entry = path.join(packageRoot, 'bundle/gemini.js');
  await fs.outputFile(entry, '#!/usr/bin/env node\n', { mode: 0o755 });
  await fs.outputJson(path.join(packageRoot, 'package.json'), {
    name: '@google/gemini-cli', version, bin: { gemini: 'bundle/gemini.js' },
  });
  if (process.platform === 'win32') await fs.outputFile(path.join(bin, 'gemini.cmd'),
    renderNpmCmdShim('node_modules\\@google\\gemini-cli\\bundle\\gemini.js'));
  else await fs.symlink(entry, path.join(bin, 'gemini'));
  let versionProbes = 0;
  let probesBeforeInstall = 0;
  const nativeInstalls: NativeCliInvocation[] = [];
  const installSource = async (packageRoot: string) => {
    const manifest = await fs.readJson(path.join(packageRoot, 'gemini-extension.json'));
    expect(manifest).not.toHaveProperty('settings');
    const configRoot = resolvePlatformConfigRoot('gemini', { cwd, env });
    const installed = path.join(configRoot, 'extensions', manifest.name);
    await fs.copy(packageRoot, installed);
    await fs.outputJson(path.join(installed, '.gemini-extension-install.json'), { type: 'local', source: packageRoot });
    // Independent fixed-host sample; the activation helper must restore its
    // reviewed global intent after this native User enable transformation.
    const activation = path.join(configRoot, 'extensions/extension-enablement.json');
    const existing: Record<string, { overrides: string[] }> = await fs.readJson(activation).catch(() => ({}));
    const next = Object.fromEntries(Object.entries(existing).map(([name, entry]) => [name, { overrides: entry.overrides }]));
    const home = geminiScopePattern(path.dirname(configRoot));
    const outsideHome = (rule: string) => !rule.replace(/^!/u, '').startsWith(home.slice(0, -1));
    next[manifest.name] = { overrides: [...(next[manifest.name]?.overrides ?? []).filter(outsideHome), home] };
    await fs.outputFile(activation, JSON.stringify(next, null, 2));
  };
  const runner = async (invocation: NativeCliInvocation) => {
    const args = invocation.args[0] === await fs.realpath(entry) ? invocation.args.slice(1) : invocation.args;
    if (args.length === 1 && args[0] === '--version') {
      versionProbes++;
      return { exitCode: 0, stdout: version, stderr: '' };
    }
    if (args[0] === 'extensions' && args[1] === 'list') {
      expect(args).toEqual(['extensions', 'list', '--output-format', 'json']);
      const queryCwd = invocation.cwd ?? cwd;
      const extensions = path.join(resolvePlatformConfigRoot('gemini', { cwd, env }), 'extensions');
      const activation = await readGeminiActivationSnapshot({ cwd: queryCwd, env });
      const rows = [];
      for (const name of Object.keys(graph)) {
        const installed = path.join(extensions, name);
        const manifest = await fs.readJson(path.join(installed, 'gemini-extension.json')).catch(() => null);
        if (manifest) rows.push({ name, version: manifest.version, path: installed,
          isActive: geminiPathEnabled(geminiActivationRules(activation, name), queryCwd) });
      }
      return { exitCode: 0, stdout: '', stderr: JSON.stringify(rows) };
    }
    expect(args.slice(0, 2)).toEqual(['extensions', 'install']);
    expect(args.slice(3)).toEqual(['--consent', '--skip-settings']);
    nativeInstalls.push(invocation);
    probesBeforeInstall = versionProbes;
    const packageRoot = args[2]!;
    expect(invocation.input?.initial).toBe('');
    expect(invocation.input?.onStdout(`Do you trust the files in this folder?\nThe extension source at "${packageRoot}" is not trusted.\nDo you want to trust this folder and continue with the installation? [y/N]: `))
      .toEqual({ write: 'y\n', end: true });
    await installSource(packageRoot);
    return { exitCode: 0, stdout: 'Installed.', stderr: '' };
  };
  const cli = (argv: string[]) => runCliEntry([...argv, '--yes', '--json'], { cwd, env, nativeCliRunner: runner });
  return { cwd, env, nativeInstalls, cli, installSource, runner, probesBeforeInstall: () => probesBeforeInstall, versionProbes: () => versionProbes };
}

function reviewedGeminiInstallSource(message: string, expectedSource: string): string {
  const input = message.match(/\["extensions","install","(?:[^"\\]|\\.)*"\]/u)?.[0];
  if (!input) throw new Error('Expected an explicit interactive Gemini install.');
  const args = JSON.parse(input) as string[];
  expect(args).toEqual(['extensions', 'install', expectedSource]);
  return args[2]!;
}

// Test Value Gate: the real CLI parser and recovery path must preserve a separate
// per-request native grant, retain saved demand, and recover without reading stdin.
describe('CLI Gemini native consent', () => {
  it.each([false, true])('preserves native consent and bounded fresh discovery with initial grant=%s', async (initialGrant) => {
    const { cwd, env, nativeInstalls, runner, probesBeforeInstall, versionProbes } = await geminiFixture({ demo: [] }, !initialGrant);
    const first = await runCliEntry(['plugin', 'install', 'team/demo', '--scope', 'user', '--context', 'user', '--yes', ...(initialGrant ? ['--native-consent'] : []), '--json'], { cwd, env, nativeCliRunner: runner });
    if (initialGrant) {
      expect(first.exitCode, first.stdout + first.stderr).toBe(0);
      expect(first.parseJsonStdout()).toMatchObject({ status: 'success', data: { request: { nativeConsent: true } } });
      expect(nativeInstalls).toHaveLength(1);
      const installed = path.join(resolvePlatformConfigRoot('gemini', { cwd, env }), 'extensions/demo/skills/demo/SKILL.md');
      expect(await fs.readFile(installed, 'utf8')).toBe('---\nname: demo\ndescription: Consent fixture\n---\nUse demo.\n');
      // Keep expensive client startup bounded before a native mutation.
      // Bound process requests through the public path, rather than private previews.
      expect(probesBeforeInstall()).toBeLessThanOrEqual(11);
      expect(versionProbes()).toBeLessThanOrEqual(14);
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

  it('uses the frozen provider source and retries its pending declared Gemini roots with consent', async () => {
    const host = await geminiFixture({ b: ['d'], c: ['d'], d: [], other: [] }, true);
    const install = (ids: string[], consent = false) => host.cli(['plugin', 'install', ...ids,
      '--scope', 'user', '--context', 'user', ...(consent ? ['--native-consent'] : [])]);
    expect((await install(['team/other'], true)).exitCode).toBe(0);
    const other = path.join(resolvePlatformConfigRoot('gemini', host), 'extensions/other/skills/other/SKILL.md');
    const original = await fs.stat(other);
    const attempt = await install(['team/b', 'team/c', 'team/other']);
    expect(attempt.exitCode, attempt.stdout + attempt.stderr).toBe(4);
    const result = attempt.parseJsonStdout<CommandResult<LifecycleData>>();
    const targets = result.data!.targetResults;
    const provider = targets.find((target) => target.pluginId === 'team/d')!;
    const diagnostics = provider.deploymentReceipts!.flatMap((receipt) => [
      ...receipt.diagnostics, ...receipt.effects.flatMap((effect) => effect.diagnostics),
    ]).filter((entry) => entry.code === 'nativeConsentRequired');
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.subject).toMatchObject({ pluginId: 'team/d', scope: 'user', target: 'gemini', field: 'nativeSource' });
      expect(diagnostic.message).toContain('aw plugin sync team/b --context user --target gemini --native-consent');
      expect(diagnostic.message).toContain('aw plugin sync team/c --context user --target gemini --native-consent');
      await expect(fs.readJson(path.join(diagnostic.detail!.path!, 'gemini-extension.json'))).resolves.toMatchObject({ name: 'd' });
    }
    expect(targets.find((target) => target.pluginId === 'team/other')).toMatchObject({ execution: 'no-op', observation: 'verified' });
    expect(JSON.stringify(result)).not.toMatch(/aw plugin sync team\/(d|other) /u);
    const actions = result.nextActions.flatMap((action) => action.kind === 'command' ? [action.argv] : []);
    expect(actions).toEqual(['team/b', 'team/c'].map((id) => ['aw', 'plugin', 'sync', id, '--context', 'user', '--target', 'gemini', '--native-consent']));
    expect(host.nativeInstalls).toHaveLength(1);
    const statusOf = async (...plugins: string[]) => (await runCliEntry(['plugin', 'status', ...plugins, '--context', 'user', '--json'],
      { cwd: host.cwd, env: host.env, nativeCliRunner: host.runner })).parseJsonStdout<CommandResult>();
    const syncArgv = (result: CommandResult) => result.nextActions.flatMap((action) => action.kind === 'command' ? [action.argv] : []);
    const observed = await statusOf('team/b');
    const missing = observed.diagnostics.find((entry) => entry.code === 'nativeRegistrationMissing' && entry.subject?.pluginId === 'team/d');
    expect(missing?.subject, JSON.stringify({ diagnostics: observed.diagnostics, nextActions: observed.nextActions })).toMatchObject({ target: 'gemini', scope: 'user' });
    expect(syncArgv(observed))
      .toEqual([['aw', 'plugin', 'sync', 'team/b', '--context', 'user', '--target', 'gemini']]);
    expect(syncArgv(await statusOf('team/d')).map((argv) => argv[3]).sort()).toEqual(['team/b', 'team/c']);
    for (const action of actions) {
      const recovered = await host.cli(action.slice(1));
      expect(recovered.exitCode, recovered.stdout + recovered.stderr).toBe(0);
      if (action[3] === 'team/b') expect(syncArgv(await statusOf('team/b', 'team/c', 'team/other')).map((argv) => argv[3]))
        .toEqual(['team/c']);
    }
    for (const name of ['b', 'c', 'd']) await expect(fs.readJson(path.join(resolvePlatformConfigRoot('gemini', host),
      'extensions', name, 'gemini-extension.json'))).resolves.toMatchObject({ name });
    expect(host.nativeInstalls).toHaveLength(4);
    expect((await fs.stat(other)).mtimeMs).toBe(original.mtimeMs);
  }, 30_000);

  it('recovers an unrecognized Gemini consent protocol manually from the retained dependency source', async () => {
    const host = await geminiFixture({ b: ['d'], d: [] }, true, '0.68.0');
    let attempt = await host.cli(['plugin', 'install', 'team/b', '--scope', 'user', '--context', 'user', '--native-consent']);
    const retry = ['aw', 'plugin', 'sync', 'team/b', '--context', 'user', '--target', 'gemini'];
    for (const name of ['d', 'b']) {
      expect(attempt.exitCode, attempt.stdout + attempt.stderr).toBe(4);
      const result = attempt.parseJsonStdout<CommandResult<LifecycleData>>();
      const source = result.diagnostics.find((entry) => entry.subject?.field === 'nativeSource'
        && entry.subject.pluginId === `team/${name}`)!.detail!.path!;
      const workspace = result.diagnostics.find((entry) => entry.subject?.field === 'workspace'
        && entry.subject.pluginId === `team/${name}`)!.detail!.path!;
      const activation = result.diagnostics.find((entry) => entry.subject?.field === 'activationConfig'
        && entry.subject.pluginId === `team/${name}`)!.detail!.path!;
      expect(result.nextActions[0]).toMatchObject({ kind: 'manual', message: expect.stringContaining(JSON.stringify(source)) });
      if (result.nextActions[0]?.kind !== 'manual') throw new Error('Expected manual Gemini consent.');
      expect(result.nextActions[0].message).toContain(JSON.stringify(workspace));
      expect(result.nextActions[0].message).toContain('Review each host permission yourself');
      expect(result.nextActions[0].message).not.toContain('--consent');
      expect(result.nextActions[0].message).toContain(JSON.stringify(activation));
      expect(result.nextActions[0].message).toContain(retry.join(' '));
      expect(JSON.stringify(result)).not.toContain('aw plugin sync team/d ');
      await expect(fs.readJson(path.join(source, 'gemini-extension.json'))).resolves.toMatchObject({ name });
      const before = await fs.pathExists(activation) ? await fs.readJson(activation) : null;
      await host.installSource(reviewedGeminiInstallSource(result.nextActions[0].message, source));
      const after = await fs.readJson(activation);
      if (before === null) {
        expect(Object.keys(after)).toEqual([name]);
        await fs.remove(activation);
      } else {
        expect(before).not.toHaveProperty(name);
        delete after[name];
        expect(after).toEqual(before);
        await fs.writeJson(activation, after);
      }
      // The next pending extension still needs its own reviewed host permission.
      expect(result.nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: retry }));
      attempt = await host.cli(retry.slice(1));
    }
    expect(attempt.exitCode, attempt.stdout + attempt.stderr).toBe(0);
    const snapshot = await readGeminiActivationSnapshot(host);
    expect(geminiUserActivation(snapshot, 'd', host.env.GEMINI_CLI_HOME)).toBe(true);
    expect(host.nativeInstalls).toHaveLength(0);
  }, 30_000);

  it('keeps a first Project-only Gemini install disabled elsewhere when there was no activation file', async () => {
    const host = await geminiFixture({ b: [] }, true, '0.68.0');
    await git(host.cwd, ['init', '--quiet']);
    const first = await host.cli(['plugin', 'install', 'team/b', '--scope', 'project', '--context', 'project']);
    expect(first.exitCode, first.stdout + first.stderr).toBe(4);
    const result = first.parseJsonStdout<CommandResult<LifecycleData>>();
    const source = result.diagnostics.find((entry) => entry.subject?.field === 'nativeSource')!.detail!.path!;
    const config = result.diagnostics.find((entry) => entry.subject?.field === 'activationConfig')!.detail!;
    expect(config).toMatchObject({ configKey: 'b', reasonCode: 'geminiNativeConsentActivationConfigProjectOnly' });
    const activation = config.path!;
    expect(await fs.pathExists(activation)).toBe(false);
    const manual = result.nextActions.find((action) => action.kind === 'manual');
    if (!manual) throw new Error('Expected manual Gemini consent.');
    expect(manual.message).toContain('"!*"');
    await host.installSource(reviewedGeminiInstallSource(manual.message, source));
    const otherProject = path.join(host.env.GEMINI_CLI_HOME, 'outside reviewed project');
    await fs.ensureDir(otherProject);
    const changed = await readGeminiActivationSnapshot(host);
    expect(geminiPathEnabled(geminiActivationRules(changed, 'b'), otherProject)).toBe(true);
    expect(Object.keys(JSON.parse(changed.content!))).toEqual(['b']);
    // The absent baseline contains no unrelated values. Add the reviewed User default only.
    await fs.writeJson(activation, { b: { overrides: ['!*'] } });
    const retry = result.nextActions.find((action) => action.kind === 'command' && action.argv[2] === 'sync');
    if (!retry || retry.kind !== 'command') throw new Error('Expected Project retry.');
    const completed = await host.cli(retry.argv.slice(1));
    expect(completed.exitCode, completed.stdout + completed.stderr).toBe(0);
    expect(completed.parseJsonStdout<CommandResult<LifecycleData>>().data.targetResults).toEqual([
      expect.objectContaining({ pluginId: 'team/b', scope: 'project', observation: 'verified' }),
    ]);
    const verified = await readGeminiActivationSnapshot(host);
    const rules = geminiActivationRules(verified, 'b');
    expect(geminiPathEnabled(rules, await fs.realpath(host.cwd))).toBe(true);
    expect(geminiPathEnabled(rules, otherProject)).toBe(false);
    expect(geminiUserActivation(verified, 'b', host.env.GEMINI_CLI_HOME)).toBe(false);
    expect(host.nativeInstalls).toHaveLength(0);
  }, 30_000);

  it('keeps a same-version Gemini dependency and its local data when the native copy fails the byte postcheck', async () => {
    const host = await geminiFixture({ b: ['d'], d: [] }, true);
    const installed = path.join(resolvePlatformConfigRoot('gemini', host), 'extensions/d');
    const localFile = path.join(installed, '.env');
    const runner = async (invocation: NativeCliInvocation) => {
      const outcome = await host.runner(invocation);
      const install = invocation.args.indexOf('install');
      if (install >= 0 && path.basename(invocation.args[install + 1]!) === 'd') await fs.writeFile(localFile, 'LOCAL_DATA=retain\n');
      return outcome;
    };
    const first = await runCliEntry(['plugin', 'install', 'team/b', '--scope', 'user', '--context', 'user', '--native-consent', '--yes', '--json'],
      { cwd: host.cwd, env: host.env, nativeCliRunner: runner });
    const retry = ['aw', 'plugin', 'sync', 'team/b', '--context', 'user', '--target', 'gemini', '--native-consent'];
    const check = (attempt: typeof first, code: string) => {
      expect(attempt.exitCode, attempt.stdout + attempt.stderr).toBe(4);
      const result = attempt.parseJsonStdout<CommandResult<LifecycleData>>();
      const deployment = result.data.targetResults.find((target) => target.pluginId === 'team/d')!.deploymentReceipts!;
      expect(deployment.flatMap((item) => item.diagnostics)).toContainEqual(expect.objectContaining({ code,
        subject: expect.objectContaining({ pluginId: 'team/d', field: 'nativeSource' }), message: expect.stringContaining(retry.join(' ')) }));
      expect(result.nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: retry }));
      expect(JSON.stringify(result)).not.toContain('aw plugin sync team/d ');
    };
    check(first, 'nativeInstallContentPostcheckFailed');
    check(await host.cli(retry.slice(1)), 'nativeRefreshDataUnconfirmed');
    await expect(fs.readFile(localFile, 'utf8')).resolves.toBe('LOCAL_DATA=retain\n');
    expect(host.nativeInstalls).toHaveLength(1);
    // The owner has inspected and moved the local data. The recorded native bytes now match.
    await fs.move(localFile, path.join(host.cwd, 'retained-settings'));
    const completed = await host.cli(retry.slice(1));
    expect(completed.exitCode, completed.stdout + completed.stderr).toBe(0);
    await expect(fs.readFile(path.join(host.cwd, 'retained-settings'), 'utf8')).resolves.toBe('LOCAL_DATA=retain\n');
  }, 30_000);

  it.each([false, true])('reviews Gemini permission at the host before retrying only a declared Project location through the TUI with User enabled=%s', async (userEnabled) => {
    const host = await geminiFixture({ b: [] }, true);
    await git(host.cwd, ['init', '--quiet']);
    const otherProject = path.join(host.env.GEMINI_CLI_HOME, 'other project');
    const activation = path.join(resolvePlatformConfigRoot('gemini', host), 'extensions/extension-enablement.json');
    const backup = path.join(host.cwd, 'activation-backup.json');
    const disabledElsewhere = `!${geminiScopePattern(otherProject)}`;
    await fs.ensureDir(otherProject);
    await fs.outputJson(activation, { b: { overrides: [userEnabled ? '*' : '!*', disabledElsewhere], setting: 'keep' },
      sibling: { overrides: ['*'], setting: { preserve: true } } });
    for (const scope of ['user', 'project']) {
      const saved = await host.cli(['plugin', 'install', 'team/b', '--scope', scope, '--only', 'requirements']);
      expect(saved.exitCode, saved.stdout + saved.stderr).toBe(0);
    }
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd: host.cwd, env: host.env,
      nativeCliRunner: host.runner, interactive: false }));
    const apply = async () => {
      const plan = await dependencies.prepareScopedTask!({ kind: 'recovery', command: 'sync', scope: 'project',
        selectors: ['team/b'], targets: ['gemini'], exactTargets: [{ pluginId: 'team/b', agent: 'gemini', scope: 'project' }],
      }, new AbortController().signal);
      const result = await dependencies.executeScopedTask!(plan);
      if (result.kind !== 'recovery') throw new Error('Expected an exact Project recovery receipt.');
      return result.receipt;
    };
    const receipt = await apply();
    expect(receipt.ok).toBe(false);
    const errors = receipt.targetResults.flatMap((target) => [...target.blockers, ...target.reasons ?? []]);
    const source = errors.find((entry) => entry.subject?.field === 'nativeSource')!.detail!.path!;
    const workspace = errors.find((entry) => entry.subject?.field === 'workspace')!.detail!.path!;
    expect(errors.find((entry) => entry.subject?.field === 'activationConfig')?.detail)
      .toEqual({ reasonCode: 'geminiNativeConsentActivationConfig', path: activation, configKey: 'b' });
    const steps = inventoryRecoveryActions(errors, receipt);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'manual', message: expect.stringContaining('review only the Project location for team/b on gemini') });
    if (steps[0]?.kind !== 'manual') throw new Error('Expected host permission before TUI recovery.');
    expect(steps[0].message).toContain(JSON.stringify(source));
    expect(steps[0].message).toContain(JSON.stringify(workspace));
    expect(steps[0].message).toContain(JSON.stringify(activation));
    expect(steps[0].message).not.toContain('--consent');
    expect(steps[0].message).not.toContain('aw plugin sync');
    await expect(fs.readJson(path.join(source, 'gemini-extension.json'))).resolves.toMatchObject({ name: 'b' });
    await fs.copyFile(activation, backup);
    const before = await fs.readJson(backup);
    await host.installSource(reviewedGeminiInstallSource(steps[0].message, source));
    const changed = await fs.readJson(activation);
    expect(geminiPathEnabled(changed.b.overrides, otherProject)).toBe(true);
    expect(changed.sibling).not.toHaveProperty('setting');
    await fs.writeJson(activation, { ...changed, later: { overrides: ['!*'], setting: 'external edit' } });
    // Restore the verified host changes and keep the independent edit before a new Review.
    const current = await fs.readJson(activation);
    current.b = { ...current.b, overrides: before.b.overrides, setting: before.b.setting };
    current.sibling.setting = before.sibling.setting;
    await fs.writeJson(activation, current);
    const recovered = await apply();
    expect(recovered, JSON.stringify(recovered.errors)).toMatchObject({ ok: true, remainingTargets: [] });
    expect(recovered.targetResults).toEqual([expect.objectContaining({ pluginId: 'team/b', agent: 'gemini', scope: 'project', observation: 'verified' })]);
    const snapshot = await readGeminiActivationSnapshot(host);
    const scopes = geminiActivationRules(snapshot, 'b');
    expect(geminiPathEnabled(scopes, await fs.realpath(host.cwd))).toBe(true);
    expect(geminiPathEnabled(scopes, otherProject)).toBe(false);
    expect(scopes).toContain(disabledElsewhere);
    expect(geminiUserActivation(snapshot, 'b', host.env.GEMINI_CLI_HOME)).toBe(userEnabled);
    expect(await fs.readJson(activation)).toEqual({ b: { ...before.b, overrides: scopes }, sibling: before.sibling,
      later: { overrides: ['!*'], setting: 'external edit' } });
    expect(host.nativeInstalls).toHaveLength(0);
  }, 30_000);

});
