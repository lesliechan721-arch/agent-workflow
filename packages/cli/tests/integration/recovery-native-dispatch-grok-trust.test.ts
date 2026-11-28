import path from 'node:path';
import fs from 'fs-extra';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { describe, expect, it } from 'vitest';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import type { CommandResult } from '../../src/output/public-result.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { useEmptyGitRepositoryFixture } from '../helpers/git-repository-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';

const createEmptyGitRepository = useEmptyGitRepositoryFixture();

async function grokTrustFixture({ failProject = false, baseHook = false, commandPermissions = false, permissionOnly = false, grokOnly = false } = {}) {
  installNativeTestDiscovery({ platforms: ['grok'], executable: process.execPath });
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  await createEmptyGitRepository(cwd);
  const catalog = path.join(cwd, 'grok-catalog');
  const host = resolvePlatformConfigRoot('grok', { cwd, env });
  const projectScript = path.join(cwd, 'project-preapply');
  const names = ['base', 'bundle'];
  const platforms = grokOnly ? ['grok'] as const : ['grok', 'generic'] as const;
  for (const name of permissionOnly ? [] : names) {
    const skill = path.join(catalog, 'plugins', name, 'skills', name);
    await fs.outputFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name}.\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(skill, 'README.md'), `Use ${name}.\n`);
  }
  if (failProject) await fs.outputFile(path.join(catalog, 'plugins/base/pre-apply.mjs'), [
    "import fs from 'node:fs';",
    "if (JSON.parse(fs.readFileSync(0, 'utf8')).target.scope === 'project') {",
    `  fs.writeFileSync(${JSON.stringify(projectScript)}, 'attempted'); process.exit(6);`,
    "}",
  ].join('\n'));
  await createDependencyCatalogSnapshotFixture(catalog, names.map((name) => ({
    name, dependencies: name === 'bundle' ? ['base'] : [], configureManifest(manifest) {
      manifest.platforms = [...platforms];
      if (!permissionOnly) manifest.skills = './skills';
      delete manifest.extensions;
      if (commandPermissions && name === 'base') manifest.extensions = { permissions: [{
        name: 'report', allow: ['env fixture-report'], ask: ['fixture-report show'], deny: ['fixture-report check'],
      }] };
      if (permissionOnly) manifest.extensions = { permissions: [{ name: 'native', deny: ['report shared', 'report ' + name] }] };
      if (failProject && name === 'base') manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
      if (baseHook && name === 'base') manifest.extensions = { hooks: [{ id: 'start', event: 'session_start', feedback: 'notify', command: 'true' }] };
    },
  })));
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] },
    expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
  await setTargets({ cwd, env, scope: 'user' }, failProject ? ['grok'] : platforms);

  const registered = new Map<string, { name: string; path: string; source: string }>();
  // Only the simulated interactive Grok invocation below may grant new-source trust.
  const runner = async ({ command, args }: NativeCliInvocation) => {
    expect(command).toBe(process.execPath);
    const plugins = [...registered.values()];
    let stdout: string;
    if (args.includes('--version')) stdout = 'grok 1.0.77';
    else if (args[0] === 'plugin' && args[1] === 'list') stdout = JSON.stringify(plugins.map((plugin) =>
      ({ ...plugin, repo_key: 'local-' + plugin.name, version: '1.0.0', status: 'installed' })));
    else if (args[0] === 'inspect') {
      const configPath = path.join(host, 'config.toml');
      const config = permissionOnly && await fs.pathExists(configPath)
        ? getStaticTOMLValue(parseTOML(await fs.readFile(configPath, 'utf8'))) as { permission?: { rules: unknown[] } } : undefined;
      const loaded = config?.permission?.rules.length ?? 0;
      stdout = JSON.stringify({ grokVersion: '1.0.77', projectTrusted: true,
      ...(permissionOnly ? { permissions: { sources: loaded ? [configPath + ' (config)'] : [], loaded },
        configSources: { layers: config ? [{ role: 'user', path: configPath }] : [] } } : {}),
      plugins: plugins.map(({ name, path: installed }) => ({ name, path: installed, scope: 'user', enabled: true })),
      skills: [], agents: [], mcpServers: [] });
    } else throw new Error('Unexpected automatic Grok mutation: ' + JSON.stringify(args));
    return { exitCode: 0, stdout, stderr: '' };
  };
  const aw = async (argv: string[]) => {
    const result = await runCliEntry([...argv.slice(1), '--yes', '--json'], { cwd, env, nativeCliRunner: runner, interactive: false });
    return result.parseJsonStdout<CommandResult<LifecycleData>>();
  };
  const trustAndRetry = async (result: CommandResult<LifecycleData>, plugin: string, expectedRoot: string) => {
    const diagnostic = result.diagnostics.find((item) => item.code === 'grokNativeInstallRecovery'
      && item.subject?.pluginId === 'local/' + plugin && item.subject.scope === 'user');
    const source = diagnostic?.detail?.path;
    expect(source, JSON.stringify(result.diagnostics)).toBeTruthy();
    const manual = result.nextActions.find((action) => action.kind === 'manual'
      && action.message.includes(JSON.stringify(['plugin', 'install', source, '--trust'])));
    if (manual?.kind !== 'manual') throw new Error('Missing manual Grok install for ' + plugin);
    const retryText = 'aw plugin sync local/' + expectedRoot + ' --context user --target grok';
    expect(manual.message).toContain(retryText);
    const provider = result.data.targetResults.find((target) => target.pluginId === 'local/' + plugin && target.target === 'grok');
    const effects = provider?.deploymentReceipts?.flatMap((receipt) => receipt.effects.flatMap((effect) => effect.diagnostics));
    expect(effects).toContainEqual(expect.objectContaining({ code: 'grokNativeInstallRecovery', message: expect.stringContaining(retryText) }));
    if (plugin !== expectedRoot) expect(JSON.stringify(result)).not.toContain('aw plugin sync local/' + plugin + ' ');
    const retries = result.nextActions.flatMap((action) => action.kind === 'command' && action.argv[2] === 'sync' ? [action.argv] : []);
    expect(retries).toEqual([['aw', 'plugin', 'sync', 'local/' + expectedRoot, '--context', 'user', '--target', 'grok']]);
    expect(result.nextActions.indexOf(manual)).toBeLessThan(result.nextActions.findIndex((action) => action.kind === 'command' && action.argv[2] === 'sync'));

    const argv = JSON.parse(manual.message.match(/\["plugin","install",.+?,"--trust"\]/u)![0]) as string[];
    expect(argv).toEqual(['plugin', 'install', source, '--trust']);
    const approvedSource = argv[2]!;
    const manifest = await fs.readJson(path.join(approvedSource, '.grok-plugin/plugin.json'));
    expect(manifest.name).toBe(plugin);
    const installed = path.join(host, 'installed-plugins', 'local-' + plugin);
    await fs.copy(approvedSource, installed);
    registered.set(plugin, { name: plugin, path: installed, source: approvedSource });
    return aw(retries[0]!);
  };
  return { cwd, env, aw, projectScript, trustAndRetry, registered, runner };
}

describe('Grok native recovery and trust', () => {
  it('writes both permission-only Grok dependencies in one User plan and preserves an untrusted Project', async () => {
    const { cwd, env, aw, runner } = await grokTrustFixture({ permissionOnly: true });
    const host = resolvePlatformConfigRoot('grok', { cwd, env });
    const user = path.join(host, 'config.toml');
    const project = path.join(cwd, '.grok/config.toml');
    const manual = '# Project settings\n';
    await fs.outputFile(project, manual);
    const install = ['aw', 'plugin', 'install', 'local/base', 'local/bundle', '--target', 'grok'];
    const result = await aw([...install, '--scope', 'user', '--context', 'user']);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
    const readRules = async () => (getStaticTOMLValue(parseTOML(await fs.readFile(user, 'utf8'))) as
      { permission: { rules: Array<{ action: string; tool: string; pattern: string }> } }).permission.rules;
    const deny = (pattern: string) => ({ action: 'deny', tool: 'bash', pattern });
    expect(await readRules()).toEqual(expect.arrayContaining([deny('report shared'), deny('report bundle'), deny('report base')]));
    expect((await readRules()).filter((rule) => rule.pattern === 'report shared')).toHaveLength(1);
    const remove = ['--scope', 'user', '--context', 'user', '--target', 'grok', '--only', 'outputs'];
    const withdrawn = await aw(['aw', 'plugin', 'remove', 'local/bundle', ...remove]);
    expect(withdrawn.status, JSON.stringify(withdrawn.diagnostics)).toBe('success');
    expect(await readRules()).toEqual(expect.arrayContaining([deny('report shared'), deny('report base')]));
    expect(await readRules()).not.toContainEqual(deny('report bundle'));
    const status = () => runPublicPluginStatus(['local/base'], { cwd, env, context: 'user' }, { nativeCliRunner: runner });
    const target = (content: string) => expect.objectContaining({ inventory: expect.arrayContaining([expect.objectContaining({
      pluginId: 'local/base', targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/base', target: 'grok', scope: 'user', content })]),
    })]) });
    const config = await fs.readFile(user, 'utf8');
    await fs.writeFile(user, '# User note\n' + config);
    expect((await status()).data).toEqual(target('satisfied'));
    const removedRule = config.replace('"report base"', '"personal rule"');
    await fs.writeFile(user, removedRule);
    const drift = await status();
    expect(drift.data).toEqual(target('drifted'));
    expect(drift.diagnostics).toContainEqual(expect.objectContaining({ code: 'componentOutputMissing',
      detail: expect.objectContaining({ path: user }) }));
    expect(drift.nextActions).toContainEqual(expect.objectContaining({ kind: 'command',
      argv: ['aw', 'plugin', 'sync', 'local/base', '--context', 'user', '--target', 'grok'] }));
    expect(await fs.readFile(user, 'utf8')).toBe(removedRule);
    await aw(['aw', 'plugin', 'sync', 'local/base', '--context', 'user', '--target', 'grok']);
    expect((await status()).data).toEqual(target('satisfied'));
    expect(await readRules()).toEqual(expect.arrayContaining([deny('report base'), deny('personal rule')]));
    const ownershipDir = path.join(env.AW_HOME!, 'platforms/grok/permission-ownership');
    const record = path.join(ownershipDir, (await fs.readdir(ownershipDir))[0]!);
    const saved = await fs.readFile(record);
    await fs.writeFile(record, '{');
    const unconfirmed = await status();
    expect(unconfirmed.data).toEqual(target('unknown'));
    expect(unconfirmed.diagnostics).toContainEqual(expect.objectContaining({ code: 'permissionOwnershipDegraded' }));
    expect(await fs.readFile(record, 'utf8')).toBe('{');
    await fs.writeFile(record, saved);
    const untrusted = await aw([...install, '--scope', 'project', '--context', 'project']);
    const projectStatus = await runPublicPluginStatus(['local/base'], { cwd, env, context: 'project' }, { nativeCliRunner: runner });
    expect(projectStatus.diagnostics).not.toContainEqual(expect.objectContaining({
      detail: expect.objectContaining({ reasonCode: 'grok-project-trust-required' }), code: 'componentOutputUnconfirmed',
    }));
    expect(untrusted.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied',
      detail: expect.objectContaining({ reasonCode: 'grok-project-trust-required' }) }));
    expect(await fs.readFile(project, 'utf8')).toBe(manual);
    expect(await fs.pathExists(path.join(host, 'trusted_folders.toml'))).toBe(false);
  });

  it('delivers Grok native command rules with a per-action impact receipt and leaves project trust untouched', async () => {
    const { cwd, env, aw, trustAndRetry } = await grokTrustFixture({ commandPermissions: true });
    const host = resolvePlatformConfigRoot('grok', { cwd, env });
    const file = path.join(host, 'config.toml');
    const project = path.join(cwd, '.grok/config.toml');
    const manual = '# local rules\n[permission]\nrules = [{ action = "ask", tool = "read", pattern = "notes/**" }]\n';
    await fs.outputFile(file, manual);
    await fs.outputFile(project, '# project settings\n');
    const install = await aw(['aw', 'plugin', 'install', 'local/base', '--scope', 'user', '--target', 'grok']);
    expect(await fs.readFile(file, 'utf8')).toBe(manual);
    const result = await trustAndRetry(install, 'base', 'base');
    expect(result.status).toBe('success');
    const written = await fs.readFile(file, 'utf8');
    expect(getStaticTOMLValue(parseTOML(written)).permission).toEqual({ rules: [
      { action: 'ask', tool: 'read', pattern: 'notes/**' },
      { action: 'allow', tool: 'bash', pattern: 'fixture-report' },
      { action: 'ask', tool: 'bash', pattern: 'fixture-report show' },
      { action: 'deny', tool: 'bash', pattern: 'fixture-report check' },
    ] });
    expect(written).toContain('# local rules');
    expect([...install.diagnostics, ...result.diagnostics]).toEqual(expect.arrayContaining(['allow', 'ask', 'deny'].map(
      (permissionAction) => expect.objectContaining({ code: 'hostPermissionAdditionalImpact',
        subject: expect.objectContaining({ pluginId: 'local/base', target: 'grok', field: 'permissions.report' }),
        detail: expect.objectContaining({ reasonCode: 'grok-shell-text-matching', permissionAction }) }),
    )));
    expect([...install.diagnostics, ...result.diagnostics]).toContainEqual(expect.objectContaining({
      code: 'hostPermissionAdditionalImpact', message: expect.stringContaining('Calling the inner command directly can also be allowed'),
    }));
    expect(await fs.readFile(project, 'utf8')).toBe('# project settings\n');
    expect(await fs.pathExists(path.join(host, 'trusted_folders.toml'))).toBe(false);
  });

  it('reviews and reports an unreadable Grok managed layer when existing manual rules satisfy the declarations', async () => {
    const { cwd, env, aw, runner } = await grokTrustFixture({ permissionOnly: true });
    const host = resolvePlatformConfigRoot('grok', { cwd, env });
    const target = path.join(host, 'config.toml');
    const managed = path.join(host, 'managed_config.toml');
    const manual = '[permission]\nrules = [{ action = "deny", tool = "bash", pattern = "report shared" },'
      + ' { action = "deny", tool = "bash", pattern = "report base" }]\n';
    const malformed = '[permission]\nrules = [\n';
    await fs.outputFile(target, manual);
    await fs.outputFile(managed, malformed);
    const install = ['plugin', 'install', 'local/base', '--scope', 'user', '--context', 'user', '--target', 'grok'];
    const preview = async (argv: string[]) => {
      const result = await runCliEntry([...argv, '--json'], { cwd, env, nativeCliRunner: runner, interactive: false });
      return result.parseJsonStdout<CommandResult<LifecycleData>>();
    };
    const warning = expect.objectContaining({ code: 'hostPermissionAdditionalImpact',
      subject: { pluginId: 'local/base', target: 'grok', scope: 'user' },
      detail: { reasonCode: 'grok-additional-rules-unverified', path: managed } });
    const effect = expect.objectContaining({ code: 'hostPermissionAdditionalImpact', message: expect.stringContaining('managed_config.toml') });
    const review = await preview(install);
    expect(review.status).toBe('blocked');
    expect(review.data.confirmation?.required).toBe(true);
    expect(review.data.confirmation?.effects).toContainEqual(effect);
    const installed = await aw(['aw', ...install]);
    expect(installed.status).toBe('success');
    expect(installed.diagnostics).toContainEqual(warning);

    const sync = await preview(['plugin', 'sync', 'local/base', '--context', 'user', '--target', 'grok']);
    expect(sync.status).toBe('success');
    expect(sync.diagnostics).toContainEqual(warning);

    const remove = ['plugin', 'remove', 'local/base', '--scope', 'user', '--context', 'user', '--target', 'grok', '--only', 'outputs'];
    expect((await preview(remove)).data.confirmation?.effects).toContainEqual(effect);
    expect((await aw(['aw', ...remove])).diagnostics).toContainEqual(warning);
    expect(await fs.readFile(target, 'utf8')).toBe(manual);
    expect(await fs.readFile(managed, 'utf8')).toBe(malformed);
  });

  it('does not require confirmation for a Grok Skill-only install when the unrelated managed layer is unreadable', async () => {
    const { cwd, env, runner } = await grokTrustFixture();
    const host = resolvePlatformConfigRoot('grok', { cwd, env });
    await fs.outputFile(path.join(host, 'managed_config.toml'), '[permission]\nrules = [\n');
    const result = await runCliEntry(['plugin', 'install', 'local/base', '--scope', 'user', '--context', 'user', '--target', 'grok', '--json'],
      { cwd, env, nativeCliRunner: runner, interactive: false });
    const receipt = result.parseJsonStdout<CommandResult<LifecycleData>>();
    expect(receipt.diagnostics.map(({ code }) => code)).not.toContain('confirmationRequired');
    expect(receipt.diagnostics.map(({ code }) => code)).not.toContain('hostPermissionAdditionalImpact');
  });

  // Grok reports just the winning package of each name in the project. The
  // first publication can hide its exact User provider while other writes stay observable.
  it.for(['unchanged', 'owned hook', 'foreign hook', 'reordered hooks', 'unmapped User hook', 'foreign registration',
    'edited User source', 'edited User copy', 'edited Project copy', 'reordered sources'] as const)(
    'rechecks a hidden Grok User provider with %s', async (change, test) => {
      // Keep the original deadline. Hosted slow runners need phase evidence
      // to distinguish fixture/trust setup from the guarded Project writes.
      const timing = createCommandTestTiming(test);
      const { cwd, env, aw, trustAndRetry, runner, registered } = await timing.measure('fixture', 'grok-trust', () => grokTrustFixture({
        // These commands only select Grok; the separate recovery test covers the Generic sibling.
        grokOnly: true,
        baseHook: ['owned hook', 'foreign hook', 'reordered hooks'].includes(change),
      }));
      const first = await timing.measure('command', 'user-install', () => aw(['aw', 'plugin', 'install', 'local/bundle', '--scope', 'user', '--target', 'grok']));
      const second = await timing.measure('command', 'trust-base-and-retry', () => trustAndRetry(first, 'base', 'bundle'));
      expect((await timing.measure('command', 'trust-bundle-and-retry', () => trustAndRetry(second, 'bundle', 'bundle'))).status).toBe('success');
      const base = registered.get('base')!;
      const projectRoot = path.join(cwd, '.grok/plugins');
      const firstProject = path.join(projectRoot, 'aw-local-base');
      const secondProject = path.join(projectRoot, 'aw-local-bundle');
      const original = await fs.readFile(path.join(base.path, 'skills/base/SKILL.md'), 'utf8');
      if (change === 'foreign registration') base.source = path.join(cwd, 'third-party-source');
      const editedRoot = change === 'edited User source' ? base.source : change === 'edited User copy' ? base.path : firstProject;
      const edited = path.join(editedRoot, 'skills/base/SKILL.md');
      let firstCompleted = false;
      let injected = false;
      const nativeCliRunner = async (invocation: NativeCliInvocation) => {
        const result = await runner(invocation);
        if (invocation.args[0] !== 'inspect' || invocation.cwd !== cwd) return result;
        const snapshot = JSON.parse(result.stdout);
        for (const plugin of snapshot.plugins) {
          const candidate = path.join(projectRoot, 'aw-local-' + plugin.name);
          if (await fs.pathExists(path.join(candidate, '.grok-plugin/plugin.json'))) {
            plugin.path = candidate;
            plugin.scope = 'project';
          }
          if (plugin.name === 'base') {
            const file = path.join(plugin.path, 'hooks', 'hooks.json');
            const reported = await fs.pathExists(file) || change === 'unmapped User hook' && plugin.scope === 'user';
            snapshot.hooks = reported ? [{ event: '(plugin)', hookType: 'file', target: file, matcher: null,
              source: { type: 'plugin', plugin_name: plugin.name, path: plugin.path } }] : [];
            if (change === 'foreign hook' && plugin.scope === 'user') {
              snapshot.hooks.push({ ...snapshot.hooks[0], target: path.join(cwd, 'manual-hook.json') });
            }
            if (change === 'reordered hooks') {
              snapshot.hooks.push({ event: 'session_start', hookType: 'command', target: 'echo manual', matcher: null,
                source: { type: 'project', path: path.join(cwd, '.grok', 'hooks') } });
              if (firstCompleted) snapshot.hooks.reverse();
            }
          }
        }
        if (firstCompleted && change.startsWith('edited') && !injected) {
          await fs.appendFile(edited, 'External edit.\n');
          injected = true;
        }
        if (firstCompleted && change === 'reordered sources') snapshot.plugins.reverse();
        return { ...result, stdout: JSON.stringify(snapshot) };
      };
      const promoted = await timing.measure('command', 'project-promotion', () => runRecovery('install', ['local/base', 'local/bundle'],
        { cwd, env, cliVersion: '1.0.0', scope: 'project', context: 'project', targets: ['grok'], yes: true },
        { nativeCliRunner, onInstallProgress: ({ completed }) => { if (completed === 1) firstCompleted = true; } }));
      expect(promoted.targetResults.find((target) => target.pluginId === 'local/base' && target.scope === 'project')?.execution).toBe('applied');
      const next = promoted.targetResults.find((target) => target.pluginId === 'local/bundle' && target.scope === 'project');
      if (change === 'unchanged' || change === 'owned hook') {
        expect(next?.execution).toBe('applied');
        expect(await fs.readFile(path.join(base.path, 'skills/base/SKILL.md'), 'utf8')).toBe(original);
      } else {
        expect(next?.blockers.map(({ code }) => code)).toContain('operationPlanStale');
        expect(await fs.pathExists(secondProject)).toBe(false);
        if (change.startsWith('edited')) expect(await fs.readFile(edited, 'utf8')).toContain('External edit.');
      }
    });

  // Test Value Gate: host trust applies to the retained dependency bytes, but only the
  // declared root can be synced. The completed generic location is outside both retries.
  it('trusts the retained Grok dependency source and recovers through the declared root', async () => {
    const { aw, env, trustAndRetry } = await grokTrustFixture();
    const first = await aw(['aw', 'plugin', 'install', 'local/bundle', '--scope', 'user']);
    expect(first.status, JSON.stringify(first.diagnostics)).toBe('partial');
    expect(first.data).toMatchObject({ requirements: { roots: ['local/bundle'] }, targetResults: expect.arrayContaining([
      expect.objectContaining({ pluginId: 'local/bundle', target: 'generic', execution: 'applied', content: 'satisfied' }),
      expect.objectContaining({ pluginId: 'local/base', target: 'grok', blockerCodes: expect.arrayContaining(['nativeTrustRequired']) }),
    ]) });
    const sibling = path.join(env.HOME!, '.agents', 'skills', 'bundle', 'SKILL.md');
    const before = await fs.readFile(sibling);
    const stamp = (await fs.stat(sibling)).mtimeMs;
    const undeclared = await aw(['aw', 'plugin', 'sync', 'local/base', '--context', 'user', '--target', 'grok']);
    expect(undeclared.diagnostics).toContainEqual(expect.objectContaining({ code: 'syncPluginNotDesired' }));
    const root = await trustAndRetry(first, 'base', 'bundle');
    expect(root.status, JSON.stringify(root.diagnostics)).toBe('partial');
    const completed = await trustAndRetry(root, 'bundle', 'bundle');
    expect(completed.status, JSON.stringify(completed.diagnostics)).toBe('success');
    expect(completed.data).toMatchObject({ remainingTargets: [], targetResults: expect.arrayContaining(['base', 'bundle'].map((name) =>
      expect.objectContaining({ pluginId: 'local/' + name, target: 'grok', observation: 'verified', content: 'satisfied' }))) });
    expect(await fs.readFile(sibling)).toEqual(before);
    expect((await fs.stat(sibling)).mtimeMs).toBe(stamp);
  });

  it('keeps Grok User trust and one Project retry after the Project preApply independently fails', async () => {
    const { cwd, env, aw, projectScript } = await grokTrustFixture({ failProject: true });
    for (const scope of ['user', 'project'] as const) await writeIntentFixture({ cwd, env, scope },
      { roots: [{ pluginId: 'local/base' }], targets: ['grok'] });
    const result = await aw(['aw', 'plugin', 'sync', 'local/base', '--context', 'project', '--target', 'grok']);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('partial');
    expect(await fs.readFile(projectScript, 'utf8')).toBe('attempted');
    expect(result.data.targetResults.find((target) => target.scope === 'project')).toMatchObject({
      pluginId: 'local/base', target: 'grok', execution: 'failed', blockerCodes: expect.arrayContaining(['preApplyFailed']),
    });
    expect(result.data.remainingTargets).toEqual(expect.arrayContaining(['user', 'project'].map((scope) =>
      ({ pluginId: 'local/base', target: 'grok', scope }))));
    const source = result.diagnostics.find((item) => item.code === 'grokNativeInstallRecovery'
      && item.subject?.pluginId === 'local/base' && item.subject.scope === 'user')?.detail?.path;
    expect(source).toBeTruthy();
    const trust = result.nextActions.find((action) => action.kind === 'manual'
      && action.message.includes(JSON.stringify(['plugin', 'install', source, '--trust'])));
    expect(trust).toMatchObject({ message: expect.stringContaining('aw plugin sync local/base --context project --target grok') });
    expect(result.nextActions.flatMap((action) => action.kind === 'command' && action.argv[2] === 'sync' ? [action.argv] : []))
      .toEqual([['aw', 'plugin', 'sync', 'local/base', '--context', 'project', '--target', 'grok']]);
  });

});
