import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { executeRecovery, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import type { CommandResult } from '../../src/output/public-result.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';

async function grokTrustFixture(failProject = false) {
  installNativeTestQualification({ platforms: ['grok'], discovery: true, executable: process.execPath });
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  await git(cwd, ['init', '--quiet']);
  const catalog = path.join(cwd, 'grok-catalog');
  const host = resolvePlatformConfigRoot('grok', { cwd, env });
  const projectScript = path.join(cwd, 'project-preapply');
  const names = ['base', 'bundle'];
  for (const name of names) {
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
      manifest.platforms = ['grok', 'generic'];
      manifest.skills = './skills';
      delete manifest.extensions;
      if (failProject && name === 'base') manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    },
  })));
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] },
    expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
  await setTargets({ cwd, env, scope: 'user' }, failProject ? ['grok'] : ['grok', 'generic']);

  const registered = new Map<string, { name: string; path: string; source: string }>();
  // Only the simulated interactive Grok invocation below may grant new-source trust.
  const runner = async ({ command, args }: NativeCliInvocation) => {
    expect(command).toBe(process.execPath);
    const plugins = [...registered.values()];
    let stdout: string;
    if (args.includes('--version')) stdout = 'grok 1.0.77';
    else if (args[0] === 'plugin' && args[1] === 'list') stdout = JSON.stringify(plugins.map((plugin) =>
      ({ ...plugin, repo_key: 'local-' + plugin.name, version: '1.0.0', status: 'installed' })));
    else if (args[0] === 'inspect') stdout = JSON.stringify({ grokVersion: '1.0.77', projectTrusted: true,
      plugins: plugins.map(({ name, path: installed }) => ({ name, path: installed, scope: 'user', enabled: true })),
      skills: [], agents: [], mcpServers: [] });
    else throw new Error('Unexpected automatic Grok mutation: ' + JSON.stringify(args));
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

describe('native recovery dispatch', () => {
  // Grok reports just the winning package of each name in the project. The
  // first publication can hide its exact User provider while other writes stay observable.
  it.each(['unchanged', 'foreign registration', 'edited User source', 'edited User copy', 'edited Project copy', 'reordered sources'] as const)(
    'rechecks a hidden Grok User provider with %s', async (change) => {
      const { cwd, env, aw, trustAndRetry, runner, registered } = await grokTrustFixture();
      const first = await aw(['aw', 'plugin', 'install', 'local/bundle', '--scope', 'user', '--target', 'grok']);
      const second = await trustAndRetry(first, 'base', 'bundle');
      expect((await trustAndRetry(second, 'bundle', 'bundle')).status).toBe('success');
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
        }
        if (firstCompleted && change.startsWith('edited') && !injected) {
          await fs.appendFile(edited, 'External edit.\n');
          injected = true;
        }
        if (firstCompleted && change === 'reordered sources') snapshot.plugins.reverse();
        return { ...result, stdout: JSON.stringify(snapshot) };
      };
      const promoted = await runRecovery('install', ['local/base', 'local/bundle'],
        { cwd, env, cliVersion: '1.0.0', scope: 'project', context: 'project', targets: ['grok'], yes: true },
        { nativeCliRunner, onInstallProgress: ({ completed }) => { if (completed === 1) firstCompleted = true; } });
      expect(promoted.targetResults.find((target) => target.pluginId === 'local/base' && target.scope === 'project')?.execution).toBe('applied');
      const next = promoted.targetResults.find((target) => target.pluginId === 'local/bundle' && target.scope === 'project');
      if (change === 'unchanged') {
        expect(next?.execution).toBe('applied');
        expect(await fs.readFile(path.join(base.path, 'skills/base/SKILL.md'), 'utf8')).toBe(original);
      } else {
        expect(next?.blockers.map(({ code }) => code)).toContain('operationPlanStale');
        expect(await fs.pathExists(secondProject)).toBe(false);
        if (change.startsWith('edited')) expect(await fs.readFile(edited, 'utf8')).toContain('External edit.');
      }
    });

  // The next Project package must recognize its dependencies' confirmed writes
  // while still rejecting changes made by someone else between targets.
  it.each([
    ['agent', 'unchanged'], ['hook', 'unchanged'], ['rule', 'unchanged'], ['agent and rule', 'unchanged'],
    ['upgrade', 'unchanged'], ['upgrade', 'edited package'], ['upgrade', 'deleted rule'], ['upgrade', 'reordered agents'],
    ['add components', 'unchanged'], ['drop components', 'unchanged'], ['add components', 'moved new agent'],
    ['agent', 'project configuration'], ['agent', 'project trust'], ['agent', 'same-name source'], ['hook', 'extra package file'],
    ['hook', 'foreign hook'], ['rule', 'foreign rule'], ['rule', 'edited rule'], ['rule', 'same-name User rule'],
  ] as const)('revalidates Grok Project batch with %s and %s', async (kind, change) => {
      installNativeTestQualification({ platforms: ['grok'], discovery: true, executable: process.execPath });
      const { env, layout } = getCurrentSourceTestIsolation();
      const cwd = await fs.realpath(layout.fixtureCwd);
      await fs.ensureDir(path.join(cwd, '.git'));
      const source = path.join(cwd, 'grok-catalog');
      const upgrade = kind === 'upgrade' || kind === 'add components' || kind === 'drop components';
      const independentUpgrade = kind === 'upgrade' && change === 'unchanged';
      const names = independentUpgrade ? ['base', 'bundle', 'leaf', 'mcp', 'other', 'role', 'skill']
        : upgrade || kind === 'agent and rule' ? ['base', 'bundle', 'leaf'] : ['base', 'bundle'];
      const baseAgent = upgrade || kind === 'agent' || kind === 'agent and rule';
      const baseRule = upgrade || kind === 'rule' || kind === 'agent and rule';
      const writeCatalog = async (revision: number) => {
        if (upgrade) {
          const base = path.join(source, 'plugins', 'base');
          await fs.outputFile(path.join(base, 'skills/base/SKILL.md'), `---\nname: base\ndescription: Use base.\n---\nBase skill ${revision}.\n`);
          await fs.outputFile(path.join(base, 'skills/base/README.md'), 'Base skill.');
          await fs.outputJson(path.join(base, 'grok/servers.json'), { mcpServers: { base: { type: 'http', url: `http://127.0.0.1:1/${revision}` } } });
        }
        await createDependencyCatalogSnapshotFixture(source, names.map((name, index) => ({ name,
          dependencies: index > 0 && !independentUpgrade ? [names[index - 1]!] : [], configureManifest(manifest) {
            manifest.platforms = ['grok'];
            manifest.extensions = {};
            if (name === 'base' && upgrade) {
              manifest.version = `1.0.${revision}`;
              manifest.skills = './skills';
              manifest.mcpServers = './servers.json';
            }
            if (upgrade && change !== 'unchanged' && name === 'bundle') manifest.version = `1.0.${revision}`;
            if (name !== 'base' || baseAgent) manifest.extensions.agents = [
              { name: `${name}-reviewer`, description: `Review ${name}.`, prompt: name === 'base' && revision ? 'Check the new output.' : `Check the ${name} output.` },
            ];
            const withExtraComponents = kind === 'add components' && revision === 1 || kind === 'drop components' && revision === 0;
            if (name === 'base' && withExtraComponents) manifest.extensions.agents!.push(
              { name: 'extra-role', description: 'Review details.', prompt: 'Check the details.' });
            if (name === 'base' && baseRule) manifest.extensions.instructions = [
              { name: 'rule', title: 'Rule', content: revision ? 'Keep the final draft.' : 'Keep the draft.', coverage: ['main'] },
            ];
            if (name === 'base' && (kind === 'hook' || kind === 'upgrade' || withExtraComponents)) manifest.extensions.hooks = [
              { id: 'start', event: 'session_start', feedback: 'notify', command: revision ? 'echo updated' : 'true' },
            ];
          },
        })));
      };
      await writeCatalog(0);
      const config = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
      await setTargets({ cwd, env, scope: 'user' }, ['grok']);

      const projectPlugins = path.join(cwd, '.grok', 'plugins');
      const provider = path.join(projectPlugins, 'aw-local-base');
      const consumer = path.join(projectPlugins, 'aw-local-bundle');
      const foreignManifest = path.join(projectPlugins, 'manual-bundle', '.grok-plugin', 'plugin.json');
      const extraFile = path.join(provider, 'outside-aw.txt');
      const configFile = path.join(cwd, '.grok', 'config.toml');
      const rules = path.join(cwd, '.grok', 'rules');
      const rule = path.join(rules, 'aw-local-base-rule.md');
      const manualRule = path.join(rules, 'manual.md');
      const manualHook = path.join(cwd, '.grok', 'manual-hook.json');
      const userRule = path.join(resolvePlatformConfigRoot('grok', { cwd, env }), 'rules',
        change === 'same-name User rule' ? path.basename(rule) : 'personal.md');
      const otherRule = path.join(layout.tmpDir, 'other-project', '.grok', 'rules', path.basename(rule));
      if (kind === 'rule' && (change === 'unchanged' || change === 'same-name User rule')) {
        await fs.outputFile(userRule, 'User rule.');
        await fs.outputFile(otherRule, 'Other project rule.');
      }
      let providerCompleted = false;
      let delayedUpgradeInspection = false;
      let externalChange = false;
      const nativeCliRunner = async ({ args, cwd: nativeCwd }: NativeCliInvocation) => {
        if (args[0] === 'plugin' && args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
        if (args[0] !== 'inspect') throw new Error(`Unexpected Grok operation ${args.join(' ')}`);
        const project = nativeCwd === cwd;
        if (project && independentUpgrade && !delayedUpgradeInspection
          && (await fs.readJson(path.join(provider, '.grok-plugin/plugin.json')).catch(() => null))?.version === '1.0.1') {
          delayedUpgradeInspection = true;
          await new Promise((resolve) => setTimeout(resolve, 75));
        }
        // The next package's published version marks the point at which the
        // previous package has finished. Modify its live output between targets.
        if (project && upgrade && !providerCompleted && change !== 'unchanged') {
          const next = await fs.readJson(path.join(consumer, '.grok-plugin/plugin.json')).catch(() => null);
          providerCompleted = next?.version === '1.0.1';
        }
        if (project && providerCompleted && !externalChange && change !== 'unchanged') {
          externalChange = true;
          if (change === 'project configuration') await fs.outputFile(configFile, '[plugins]\ndisabled = ["unrelated"]\n');
          if (change === 'same-name source') await fs.outputJson(foreignManifest, { name: 'bundle', version: '9.0.0' });
          if (change === 'foreign hook') await fs.outputFile(manualHook, '{}');
          if (change === 'foreign rule') await fs.outputFile(manualRule, 'Manual rule.');
          if (change === 'edited rule') await fs.writeFile(rule, (await fs.readFile(rule, 'utf8')).replace('Keep the draft.', 'Edit the draft.'));
          if (change === 'edited package') {
            const file = path.join(provider, 'agents/base-reviewer.md');
            await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Check the new output.', 'Check the old output.'));
          }
          if (change === 'deleted rule') await fs.unlink(rule);
          if (change === 'extra package file') await fs.outputFile(extraFile, 'Keep this file.\n');
        }
        const directories = project && await fs.pathExists(projectPlugins) ? await fs.readdir(projectPlugins) : [];
        const plugins = (await Promise.all(directories.map(async (directory) => {
          const root = path.join(projectPlugins, directory);
          const manifest = await fs.readJson(path.join(root, '.grok-plugin', 'plugin.json'), { throws: false }).catch(() => null);
          return manifest ? [{ name: manifest.name, scope: 'project', path: root, enabled: true }] : [];
        }))).flat();
        const agents = (await Promise.all(plugins.map(async (plugin) => {
          const directory = path.join(plugin.path, 'agents');
          const files = await fs.pathExists(directory) ? await fs.readdir(directory) : [];
          return files.map((file) => ({ name: path.basename(file, '.md'), source: { type: 'plugin', plugin_name: plugin.name, path: path.join(directory, file) } }));
        }))).flat();
        if (externalChange && change === 'reordered agents') {
          const providerIndex = agents.findIndex((agent) => agent.name === 'base-reviewer');
          const consumerIndex = agents.findIndex((agent) => agent.name === 'bundle-reviewer');
          [agents[providerIndex], agents[consumerIndex]] = [agents[consumerIndex]!, agents[providerIndex]!];
        }
        if (externalChange && change === 'moved new agent') {
          const added = agents.splice(agents.findIndex((agent) => agent.name === 'extra-role'), 1)[0]!;
          agents.push(added);
        }
        const hooks = (await Promise.all(plugins.map(async (plugin) => {
          const file = path.join(plugin.path, 'hooks', 'hooks.json');
          return await fs.pathExists(file) ? [{ event: '(plugin)', hookType: 'file', target: file,
            source: { type: 'plugin', plugin_name: plugin.name, path: plugin.path }, matcher: null }] : [];
        }))).flat();
        if (project && await fs.pathExists(manualHook)) {
          hooks.push({ event: '(plugin)', hookType: 'file', target: manualHook,
            source: { type: 'plugin', plugin_name: 'base', path: provider }, matcher: null });
        }
        const files = project && await fs.pathExists(rules) ? await fs.readdir(rules) : [];
        const projectInstructions = await Promise.all(files.map(async (name) => {
          const file = path.join(rules, name);
          const sizeBytes = (await fs.stat(file)).size;
          return { path: file, scope: 'project', fileType: 'rules', sizeBytes, approxTokens: Math.floor(sizeBytes / 4) };
        }));
        if (await fs.pathExists(userRule)) projectInstructions.push({ path: userRule, scope: 'user',
          fileType: 'rules', sizeBytes: 10, approxTokens: 2 });
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ grokVersion: '1.0.77', plugins, skills: [], agents, mcpServers: [], hooks, projectInstructions,
          projectTrusted: change !== 'project trust' || !externalChange || !project }) };
      };
      const options = { cwd, env, cliVersion: '1.0.0', scope: 'project' as const, context: 'project' as const, targets: ['grok'], yes: true };
      const requested = names.map((name) => 'local/' + name);
      if (change === 'same-name User rule') {
        const install = await runPublicLifecycle('install', requested, options, { nativeCliRunner });
        expect(install.diagnostics.map((item) => item.code)).toContain('artifactCollision');
        expect(await fs.pathExists(rule)).toBe(false);
        expect(await fs.readFile(userRule, 'utf8')).toBe('User rule.');
        expect(await fs.readFile(otherRule, 'utf8')).toBe('Other project rule.');
        return;
      }
      if (!upgrade && change !== 'unchanged') {
        const install = await runRecovery('install', requested, options, { nativeCliRunner,
          onInstallProgress: ({ completed }) => { if (completed === 1) providerCompleted = true; } });
        expect(externalChange).toBe(true);
        expect(install.targetResults.find(({ pluginId }) => pluginId === 'local/bundle')?.blockers.map(({ code }) => code)).toContain('operationPlanStale');
        expect(await fs.pathExists(consumer)).toBe(false);
        if (change === 'foreign hook') expect(await fs.readFile(manualHook, 'utf8')).toBe('{}');
        if (change === 'foreign rule') expect(await fs.readFile(manualRule, 'utf8')).toBe('Manual rule.');
        if (change === 'edited rule') expect(await fs.readFile(rule, 'utf8')).toContain('Edit the draft.');
        if (change === 'same-name source') expect(await fs.readJson(foreignManifest)).toEqual({ name: 'bundle', version: '9.0.0' });
        if (change === 'extra package file') expect(await fs.readFile(extraFile, 'utf8')).toBe('Keep this file.\n');
        return;
      }
      const install = await runPublicLifecycle('install', requested, options, { nativeCliRunner });
      expect(install, JSON.stringify(install.diagnostics)).toMatchObject({ status: 'success', data: { remainingTargets: [],
        targetResults: requested.map((pluginId) => ({ pluginId, execution: 'applied', content: 'satisfied' })) } });
      if (baseAgent) expect(await fs.readFile(path.join(provider, 'agents', 'base-reviewer.md'), 'utf8')).toContain('Check the base output.');
      if (baseRule) expect(await fs.readFile(rule, 'utf8')).toContain('Keep the draft.');
      if (kind === 'hook') expect(await fs.readJson(path.join(provider, 'hooks', 'hooks.json'))).toHaveProperty('hooks');
      if (kind === 'rule') expect(await fs.pathExists(provider)).toBe(false);
      const role = path.join(consumer, 'agents', 'bundle-reviewer.md');
      expect(await fs.readFile(role, 'utf8')).toContain('Check the bundle output.');
      const before = (await fs.stat(role)).mtimeMs;
      const statusOptions = { cwd, env, cliVersion: options.cliVersion, context: options.context };
      const status = await runPublicPluginStatus([], statusOptions, { nativeCliRunner });
      expect(status.data).toMatchObject({ counts: { ready: names.length, pending: 0 }, inSync: true, allSatisfied: true });
      const sync = await runPublicLifecycle('sync', requested, options, { nativeCliRunner });
      expect(sync, JSON.stringify(sync)).toMatchObject({ status: 'success', data: { remainingTargets: [], changes: { outputs: 'none' } } });
      expect((await fs.stat(role)).mtimeMs).toBe(before);
      if (upgrade) {
        await writeCatalog(1);
        await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: options.cliVersion, env });
        const update = await runPublicLifecycle('sync', [], options, { nativeCliRunner });
        if (change === 'unchanged') {
          if (independentUpgrade) expect(delayedUpgradeInspection).toBe(true);
          expect(update.data.targetResults.map(({ pluginId, execution, blockerCodes }) => ({ pluginId, execution, blockerCodes }))).toEqual(
            names.map((name) => ({ pluginId: 'local/' + name, execution: name === 'base' ? 'applied' : 'no-op', blockerCodes: [] })));
          expect(update.status).toBe('success');
          expect(await fs.readFile(path.join(provider, 'skills/base/SKILL.md'), 'utf8')).toContain('Base skill 1.');
          expect(await fs.readFile(path.join(provider, 'agents/base-reviewer.md'), 'utf8')).toContain('Check the new output.');
          expect(await fs.readFile(path.join(provider, '.mcp.json'), 'utf8')).toContain('http://127.0.0.1:1/1');
          if (kind === 'drop components') expect(await fs.pathExists(path.join(provider, 'hooks/hooks.json'))).toBe(false);
          else expect(await fs.readFile(path.join(provider, 'hooks/hooks.json'), 'utf8')).toContain('echo updated');
          if (kind === 'add components' || kind === 'drop components') {
            expect(await fs.pathExists(path.join(provider, 'agents/extra-role.md'))).toBe(kind === 'add components');
          }
          expect(await fs.readFile(rule, 'utf8')).toContain('Keep the final draft.');
          const updatedStatus = await runPublicPluginStatus([], statusOptions, { nativeCliRunner });
          expect(updatedStatus.data).toMatchObject({ counts: { ready: names.length, pending: 0 }, inSync: true });
          expect((await runPublicLifecycle('sync', [], options, { nativeCliRunner })).data.changes.outputs).toBe('none');
          expect((await fs.stat(role)).mtimeMs).toBe(before);
        } else {
          expect(externalChange).toBe(true);
          expect(update.data.targetResults.map(({ execution, blockerCodes }) => ({ execution, blockerCodes }))).toEqual([
            { execution: 'applied', blockerCodes: [] }, { execution: 'applied', blockerCodes: [] },
            { execution: 'failed', blockerCodes: ['operationPlanStale'] },
          ]);
          if (change === 'edited package') expect(await fs.readFile(path.join(provider, 'agents/base-reviewer.md'), 'utf8')).toContain('Check the old output.');
          if (change === 'deleted rule') expect(await fs.pathExists(rule)).toBe(false);
        }
      }
      if (kind === 'rule') {
        expect(await fs.readFile(userRule, 'utf8')).toBe('User rule.');
        expect(await fs.readFile(otherRule, 'utf8')).toBe('Other project rule.');
      }
    });

  // A Grok User refresh changes the shared list even when a prior trust refusal
  // already published the new AW source. Its untouched neighbor stays a no-op.
  it.each(['trusted', 'retry after refusal', 'foreign registration', 'edited native copy'] as const)(
    'revalidates a Grok User batch refresh with %s', async (scenario) => {
      installNativeTestQualification({ platforms: ['grok'], discovery: true, executable: process.execPath });
      const { env, layout } = getCurrentSourceTestIsolation();
      const cwd = layout.fixtureCwd;
      const catalog = path.join(cwd, 'catalog');
      const host = resolvePlatformConfigRoot('grok', { cwd, env });
      const names = ['mixed', 'other'];
      const writeCatalog = async (revision: number) => {
        await createDependencyCatalogSnapshotFixture(catalog, names.map((name) => ({ name, configureManifest(manifest) {
          manifest.platforms = ['grok'];
          const version = name === 'mixed' ? revision : 1;
          manifest.version = '1.0.' + version;
          manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Check revision ' + version + '.' }],
            instructions: [{ name: 'guide', title: 'Guide', content: 'Keep revision ' + version + '.', coverage: ['main'] }] };
          if (name === 'mixed' && version === (scenario === 'retry after refusal' ? 1 : 2)) {
            manifest.extensions.hooks = [{ id: 'start', event: 'session_start', feedback: 'notify', command: 'true' }];
          }
        } })));
      };
      await writeCatalog(1);
      const config = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] }, expectedDigest: config.digest, env });
      const updateSource = () => syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
      await updateSource();
      await setTargets({ cwd, env, scope: 'user' }, ['grok']);

      const registered = new Map<string, { name: string; repo_key: string; path: string; source: string; status: string; version: string }>();
      if (scenario === 'foreign registration') registered.set('manual', { name: 'manual', version: '1.0.0', status: 'installed',
        repo_key: 'manual', path: path.join(host, 'installed-plugins/manual'), source: path.join(cwd, 'manual-source') });
      const installCopy = async (source: string) => {
        const { name, version } = await fs.readJson(path.join(source, '.grok-plugin/plugin.json'));
        const key = 'local-' + name;
        const installed = path.join(host, 'installed-plugins', key);
        await fs.copy(source, installed);
        registered.set(name, { name, repo_key: key, path: installed, source, status: 'installed', version });
      };
      const mutations: string[][] = [];
      let authorized = true;
      let editAfterRefresh = false;
      let edited = false;
      const mixedCopy = path.join(host, 'installed-plugins/local-mixed/agents/reviewer.md');
      const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
        if (editAfterRefresh && !edited) {
          edited = true;
          const content = await fs.readFile(mixedCopy, 'utf8');
          await fs.writeFile(mixedCopy, content.replace('revision 2.', 'revision X.'));
        }
        const list = [...registered.values()].sort((a, b) => a.name.localeCompare(b.name));
        let stdout = '';
        if (args[0] === 'plugin' && args[1] === 'list') stdout = JSON.stringify(list);
        else if (args[0] === 'inspect') stdout = JSON.stringify({
          grokVersion: '1.0.77', projectTrusted: authorized, projectRoot: null,
          plugins: list.map(({ name, path: installed }) => ({ name, path: installed, enabled: true, scope: 'user' })),
          agents: list.map(({ name, version, path: installed }) => ({ name: 'reviewer', description: name === 'mixed' ? version : 'Review.',
            source: { type: 'plugin', plugin_name: name, path: path.join(installed, 'agents/reviewer.md') } })),
          hooks: (await Promise.all(list.map(async (plugin) => {
            const target = path.join(plugin.path, 'hooks/hooks.json');
            return await fs.pathExists(target) ? [{ event: '(plugin)', hookType: 'file', target, matcher: null,
              source: { type: 'plugin', plugin_name: plugin.name, path: plugin.path } }] : [];
          }))).flat(),
          mcpServers: [], skills: [],
        });
        else if (args.includes('--version')) stdout = 'grok 1.0.77';
        else {
          mutations.push([...args]);
          expect(authorized).toBe(true);
          if (args[1] === 'uninstall') {
            expect(args).toEqual(['plugin', 'uninstall', 'mixed', '--confirm', '--keep-data']);
            await fs.remove(registered.get('mixed')!.path);
            registered.delete('mixed');
          } else if (args[1] === 'install') {
            await installCopy(args[2]!);
            if (scenario === 'foreign registration') registered.get('manual')!.version = '2.0.0';
          } else expect(args).toEqual(['plugin', 'enable', 'mixed']);
        }
        return { exitCode: 0, stdout, stderr: '' };
      };
      const options = { cwd, env, cliVersion: '1.0.0', scope: 'user' as const, context: 'user' as const, targets: ['grok'], yes: true };
      const workspace = path.join(await fs.realpath(env.AW_HOME!), 'runtime', 'user');
      await fs.outputFile(path.join(host, 'trusted_folders.toml'),
        `[folders.${JSON.stringify(workspace)}]\ntrusted = true\ndecided_at = 1\n`);
      for (const name of names) {
        const result = await runPublicLifecycle('install', ['local/' + name], options, { nativeCliRunner });
        const source = result.diagnostics.find(({ code }) => code === 'grokNativeInstallRecovery')?.detail?.path;
        expect(source, JSON.stringify(result.diagnostics)).toBeTruthy();
        await installCopy(source!);
      }
      const sync = () => runPublicLifecycle('sync', [], options, { nativeCliRunner });
      expect((await sync()).status).toBe('success');
      await writeCatalog(2);
      await updateSource();
      const otherRole = path.join(registered.get('other')!.path, 'agents/reviewer.md');
      const otherMtime = (await fs.stat(otherRole)).mtimeMs;
      if (scenario === 'retry after refusal') {
        authorized = false;
        const refusal = await runPublicLifecycle('sync', ['local/mixed'], options, { nativeCliRunner });
        expect(refusal.diagnostics.map(({ code }) => code)).toContain('nativeTrustRequired');
        expect(await fs.readFile(mixedCopy, 'utf8')).toContain('revision 1.');
        expect(mutations).toEqual([]);
        authorized = true;
      }
      if (scenario === 'edited native copy') {
        const update = await runRecovery('sync', [], options, { nativeCliRunner, onInstallProgress: ({ completed }) => {
          if (completed === 1) editAfterRefresh = true;
        } });
        expect(update.targetResults.find(({ pluginId }) => pluginId === 'local/other')?.blockers.map(({ code }) => code)).toContain('operationPlanStale');
        expect(await fs.readFile(mixedCopy, 'utf8')).toContain('revision X.');
      } else {
        const update = await sync();
        const foreign = scenario === 'foreign registration';
        expect(update.data.targetResults.map(({ execution, blockerCodes }) => ({ execution, blockerCodes }))).toEqual([
          { execution: 'applied', blockerCodes: [] }, { execution: foreign ? 'failed' : 'no-op', blockerCodes: foreign ? ['operationPlanStale'] : [] },
        ]);
        if (!foreign) expect(update.data.remainingTargets).toEqual([]);
        expect(await fs.readFile(mixedCopy, 'utf8')).toContain('revision 2.');
      }
      expect((await fs.stat(otherRole)).mtimeMs).toBe(otherMtime);
      expect(mutations.map((args) => args[1])).toEqual(['uninstall', 'install', 'enable']);
    });

  // Read role-only text from both native package routes, and verify the same
  // target's rules projection and quiet follow-up status.
  it.each(['user', 'project'] as const)('reports a complete Grok %s dynamic supplement projection ready', async (scope) => {
    installNativeTestQualification({ platforms: ['grok'], discovery: true, executable: process.execPath });
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    await fs.ensureDir(path.join(cwd, '.git'));
    const source = path.join(cwd, 'grok-dynamic-catalog');
    const host = resolvePlatformConfigRoot('grok', { cwd, env });
    const installed = path.join(host, 'installed-plugins', 'local-demo');
    const projectPackage = path.join(cwd, '.grok', 'plugins', 'aw-local-demo');
    const trace = path.join(cwd, 'grok-renderer-calls');
    const components = [
      { id: 'demo-skill', name: 'demo', kind: 'skill', content: { files: {
        'SKILL.md': { text: '---\nname: demo\ndescription: Grok qualification fixture.\n---\nDemo Skill.\n' },
      } } },
      { id: 'demo-agent', name: 'reviewer', kind: 'agent', content: { description: 'Review input.', prompt: 'Read the input.' } },
      { id: 'demo-role-context', name: 'role-context', kind: 'instruction',
        content: { title: 'Role Context', content: 'Keep this inside the reviewer role.', coverage: ['plugin-agents'] } },
      ...(scope === 'project' ? [{ id: 'demo-rule', name: 'rule', kind: 'instruction',
        content: { title: 'Rule', content: 'Preserve the project rule.\r\n', coverage: ['main'] } }] : []),
    ];
    await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `
      import fs from 'node:fs';
      const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
      const components = ${JSON.stringify(components)};
      fs.appendFileSync(${JSON.stringify(trace)}, 'render\\n');
      console.log(JSON.stringify({ version: 3,
        components: components.filter(component => context.allowedOutputKinds.includes(component.kind)), omitted: [], unmet: [] }));
    `);
    await createCatalogSnapshotFixture(source, 'demo', [], 'Dynamic Grok fixture.', (manifest) => {
      manifest.platforms = ['grok'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'local', type: 'path', primary: true, path: source },
    ] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['grok']);
    const options = { cwd, env, cliVersion: '1.0.0', scope, context: scope, targets: ['grok'], yes: true };
    let userSource: string | undefined;
    const nativeCliRunner = async ({ command, args }: NativeCliInvocation) => {
      expect(command).toBe(process.execPath);
      let stdout: string;
      if (args.includes('--version')) stdout = 'grok 1.0.77';
      else if (args[0] === 'plugin' && args[1] === 'list') stdout = JSON.stringify(userSource ? [{
        status: 'installed', name: 'demo', repo_key: 'local-demo', version: '1.0.0', path: installed, source: userSource,
      }] : []);
      else if (args[0] === 'inspect') {
        const packageRoot = scope === 'user' ? userSource && installed : await fs.pathExists(projectPackage) ? projectPackage : undefined;
        const reportedPath = process.platform === 'win32' && scope === 'project' ? packageRoot?.replace('\\plugins\\', '/plugins\\') : packageRoot;
        stdout = JSON.stringify({ grokVersion: '1.0.77', projectTrusted: true, plugins: packageRoot ? [
          { name: 'demo', scope, path: reportedPath, enabled: true },
        ] : [], skills: [], agents: [], mcpServers: [] });
      } else throw new Error('Unexpected automatic native mutation.');
      return { exitCode: 0, stdout, stderr: '' };
    };
    const result = await runPublicLifecycle('install', ['local/demo'], options, { nativeCliRunner });
    if (scope === 'user') {
      expect(result.status, JSON.stringify(result)).toBe('partial');
      const receipt = (result.data as LifecycleData).targetResults[0]?.deploymentReceipts?.[0];
      expect(receipt, JSON.stringify(result)).toMatchObject({ after: { registration: 'absent' } });
      userSource = receipt!.after.nativeIdentity!.sourceLocation;
      await fs.copy(userSource, installed);
      expect((await runPublicLifecycle('sync', ['local/demo'], options, { nativeCliRunner })).status).toBe('success');
    } else {
      expect(result.status, JSON.stringify(result)).toBe('success');
    }
    const nativePackage = scope === 'user' ? installed : projectPackage;
    expect(await fs.readFile(path.join(nativePackage, 'agents/reviewer.md'), 'utf8')).toContain('Keep this inside the reviewer role.');
    const rules = scope === 'user' ? path.join(host, 'rules') : path.join(cwd, '.grok', 'rules');
    expect(await fs.pathExists(path.join(rules, 'aw-local-demo-role-context.md'))).toBe(false);
    const rendered = await fs.readFile(trace, 'utf8');
    const read = () => readRecoveryStatus({ context: scope, cwd, env, nativeCliRunner });
    const status = await read();
    expect(status, JSON.stringify(status)).toMatchObject({ allSatisfied: true, inSync: true,
      counts: { blocked: 0, unconfirmed: 0, pending: 0, ready: 1 },
      inventory: [{ targetResults: [{ installedComponentIds: expect.arrayContaining(['demo-agent', 'demo-role-context']),
        installedComponentCount: scope === 'user' ? 3 : 4 }] }],
    });
    if (scope === 'project') {
      const rule = path.join(cwd, '.grok', 'rules', 'aw-local-demo-rule.md');
      expect(await fs.readFile(rule, 'utf8')).toContain('Preserve the project rule.');
      await fs.appendFile(rule, 'Changed rule bytes.\n');
      const stale = await read();
      expect(stale).toMatchObject({ counts: { blocked: 0, pending: 1 }, allSatisfied: false,
        inventory: [{ targetResults: [{ content: 'drifted', reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'platformContentDrift' }),
        ]) }] }],
      });
    }
    expect(await fs.readFile(trace, 'utf8')).toBe(rendered);
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
    const { cwd, env, aw, projectScript } = await grokTrustFixture(true);
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

  // Test Value Gate: a concrete Agent failure must not fall back to scattered Skills or block the independent generic writer.
  it('keeps an unavailable Cursor native target separate from a successful generic output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'project');
    const source = path.join(isolation.layout.fixtureCwd, 'catalog');
    const pluginRoot = path.join(source, 'plugins', 'demo');
    const content = '---\nname: demo\ndescription: Fixture skill.\n---\nRun the fixture.\n';
    await fs.ensureDir(cwd);
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'), content);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'README.md'), 'Fixture skill.\n');
    await createCatalogSnapshotFixture(source, 'demo', [], 'Fixture.\n', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['cursor', 'generic'];
      manifest.skills = './skills';
    });
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name: 'demo', version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of ['cursor', 'generic']) {
      await fs.outputJson(path.join(pluginRoot, platform, 'skills', 'demo', 'aw-plugin-requirements.json'), receipt);
    }
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)] });
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] },
    expectedDigest: config.digest, env: isolation.env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env });
    await writeIntentFixture({ scope: 'project', cwd, env: isolation.env }, {
      roots: [{ pluginId: 'local/demo' }], targets: ['cursor', 'generic'],
    });
    await setTargets({ scope: 'user', cwd, env: isolation.env }, ['cursor', 'generic']);
    const result = await runRecovery('sync', [], { scope: 'project', context: 'project', cwd,
      env: isolation.env, cliVersion: '1.0.0', yes: true }, {
      nativeCliRunner: async () => { throw new Error('fixture client unavailable'); },
    });
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'cursor', delivery: { kind: 'native', platform: 'cursor' },
        observation: 'unknown', blockers: expect.any(Array) }),
      expect.objectContaining({ agent: 'generic', delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        execution: 'applied', content: 'satisfied' }),
    ]));
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(content);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'skills'))).toBe(false);
  });

  // A renderer-only gap must survive a fresh public status read, beside zero or one real output.
  it.each([false, true])('converges native and generic renderer gaps with a delivered Skill: %s', async (mixed) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent'), 'fixture entry', { mode: 0o755 });
    const gap = { id: 'before', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['notify'] }],
      reasonCode: 'interface-unsupported' };
    const skill = { id: 'use-guide', kind: 'skill', name: 'guide', content: { files: {
      'SKILL.md': { text: '---\nname: guide\ndescription: Read the guide.\n---\nGuide.\n' },
      'README.md': { text: 'Guide.\n' },
    } } };
    await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `
      import fs from 'node:fs';
      const { allowedOutputKinds } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
      console.log(JSON.stringify({version: 3, components: allowedOutputKinds.includes('skill') ? ${JSON.stringify(mixed ? [skill] : [])} : [],
        omitted: [], unmet: allowedOutputKinds.includes('hook') ? [${JSON.stringify(gap)}] : []}));
    `);
    await createCatalogSnapshotFixture(source, 'demo', [], 'Renderer gaps.', (manifest) => {
      manifest.platforms = ['generic', 'cursor'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['cursor', 'generic']);
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      throw new Error('Unexpected native operation');
    };
    const aw = async (...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--json'], { cwd, env, nativeCliRunner, interactive: false });
      const value = result.parseJsonStdout<CommandResult>();
      expect(result.exitCode, JSON.stringify(value)).toBe(0);
      return value;
    };
    const targets = ['cursor', 'generic'].map((target) => expect.objectContaining({ target,
      satisfaction: mixed ? 'installed' : 'not-applicable', installedComponentCount: mixed ? 1 : 0,
      installedComponentIds: mixed ? ['use-guide'] : [], componentGaps: [expect.objectContaining(gap)] }));
    const install = await aw('install', 'local/demo', '--scope', 'project', '--yes');
    expect(install.data, JSON.stringify(install)).toMatchObject({ remainingTargets: [], targetResults: expect.arrayContaining(targets) });
    const status = await aw('status', '--context', 'project');
    expect(status.data, JSON.stringify(status)).toMatchObject({ counts: { pending: 0 }, inSync: true, allSatisfied: true,
      inventory: [{ targetResults: expect.arrayContaining(targets) }] });
    const selected = await runPublicPluginStatus([], { targets: ['cursor'], context: 'project', cwd, env }, { nativeCliRunner });
    expect(selected.data).toMatchObject({ counts: { pending: 0 }, inSync: null, allSatisfied: null });
    const sync = await aw('sync', 'local/demo', '--context', 'project', '--yes');
    expect(sync.data, JSON.stringify(sync)).toMatchObject({ remainingTargets: [], changes: { outputs: 'none' },
      targetResults: expect.arrayContaining(targets) });
    if (mixed) {
      const packageHome = path.join(cwd, '.cursor', 'aw-plugins');
      const [installed] = await fs.readdir(packageHome);
      await fs.remove(path.join(packageHome, installed!, 'skills', 'guide', 'SKILL.md'));
      await fs.remove(path.join(cwd, '.agents', 'skills', 'guide'));
      const lost = await aw('status', '--context', 'project');
      expect(lost.data, JSON.stringify(lost)).toMatchObject({ counts: { pending: 2 }, allSatisfied: false, inSync: false });
    } else {
      const file = path.join(cwd, '.cursor', 'hooks.json');
      const quote = process.platform === 'win32' ? '"' : "'";
      const unrelated = { command: 'echo keep' };
      const command = `aw internal cursor-workspace-open --scope project --project-root ${quote}${cwd}${quote} --plugin-id ${quote}local/demo${quote}`;
      const hooks = { version: 1, hooks: { workspaceOpen: [unrelated, { command }] } };
      await fs.outputJson(file, hooks);
      const retained = await runPublicPluginStatus([], { cwd, env, context: 'project' }, { nativeCliRunner });
      expect(retained.data).toMatchObject({ allSatisfied: false, inSync: false });
      expect(retained.diagnostics).toContainEqual(expect.objectContaining({ code: 'previousDeploymentRetained' }));
      expect(await fs.readJson(file)).toEqual(hooks);
      await fs.outputJson(file, { version: 1, hooks: { workspaceOpen: [unrelated] } });
      expect((await aw('status', '--context', 'project')).data).toMatchObject({ allSatisfied: true });
    }
  });

  // A generated extension must not stale the next install or hide a missing role consumer. External drift still invalidates Review.
  it.each([
    { scope: 'user', foreignRegistration: false }, { scope: 'project', foreignRegistration: false },
    { scope: 'project', foreignRegistration: true },
  ] as const)('validates Pi $scope batch evidence (external registration: $foreignRegistration)', async ({ scope, foreignRegistration }) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'pi-batch-catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'fixture entry', { mode: 0o755 });
    await createDependencyCatalogSnapshotFixture(source, [
      { name: 'guide', configureManifest: (manifest) => { manifest.platforms = ['pi']; } },
      { name: 'roles', dependencies: ['guide'], configureManifest(manifest) {
        manifest.platforms = ['pi'];
        manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review the work.', prompt: 'Check the work.' }] };
      } },
    ]);
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['pi']);
    const userRoot = resolvePlatformConfigRoot('pi', { cwd, env });
    const root = scope === 'user' ? userRoot : path.join(cwd, '.pi');
    const settings = path.join(root, 'settings.json');
    if (scope === 'project') await fs.outputJson(path.join(userRoot, 'settings.json'), { defaultProjectTrust: 'always' });
    const externalSource = './external-package';
    if (foreignRegistration) await fs.outputJson(path.join(root, externalSource, 'package.json'), { name: 'external-package', pi: { extensions: [] } });
    const nativeCliRunner = async ({ args, cwd: nativeCwd }: NativeCliInvocation) => {
      const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
      if (args.includes('--version')) return reply('1.5.0');
      if (args.includes('--help')) return reply('Pi coding agent');
      const current = await fs.readJson(settings, { throws: false }).catch(() => null) ?? {};
      const packages: string[] = current.packages ?? [];
      if (args[0] === 'list') return reply(packages.length && (scope === 'user' || nativeCwd === cwd) ? [scope === 'user' ? 'User packages:' : 'Project packages:',
        ...packages.flatMap((item) => [`  ${item}`, `    ${path.join(root, item)}`]), ''].join('\n') : 'No packages installed.\n');
      const installedPath = args.at(-1)!;
      if (args[0] !== 'install' || args.includes('--local') !== (scope === 'project') || !path.isAbsolute(installedPath)) {
        throw new Error('Unexpected Pi operation');
      }
      const registration = path.relative(root, installedPath).split(path.sep).join('/');
      const sources = [...packages, registration, ...(foreignRegistration ? [externalSource] : [])];
      await fs.outputJson(settings, { ...current, packages: [...new Set(sources)] });
      return reply(`Installed ${installedPath}`);
    };

    const result = await runCliEntry(['plugin', 'install', 'local/guide', 'local/roles', '--scope', scope, '--context', scope, '--yes', '--json'],
      { cwd, env, nativeCliRunner, interactive: false });
    const install = result.parseJsonStdout<CommandResult<LifecycleData>>();
    const guide = path.join(root, 'aw-packages', 'aw-local-guide');
    const roles = path.join(root, 'aw-packages', 'aw-local-roles');
    expect(await fs.readJson(path.join(guide, 'package.json'))).toMatchObject({ pi: { extensions: ['./index.mjs'] } });
    if (foreignRegistration) {
      expect(result.exitCode, JSON.stringify(install)).toBe(4);
      expect(install.data).toMatchObject({ remainingTargets: [{ pluginId: 'local/roles', target: 'pi', scope }], targetResults: [
        { pluginId: 'local/guide', execution: 'applied' }, { pluginId: 'local/roles', blockerCodes: ['operationPlanStale'] },
      ] });
      expect(await fs.pathExists(roles)).toBe(false);
      expect(await fs.readJson(settings)).toMatchObject({ packages: expect.arrayContaining([externalSource]) });
      return;
    }
    expect(result.exitCode, JSON.stringify(install)).toBe(0);
    expect(install.data).toMatchObject({ remainingTargets: [], targetResults: [
      { pluginId: 'local/guide', execution: 'applied', observation: 'verified' },
      { pluginId: 'local/roles', execution: 'applied', observation: 'verified' },
    ] });
    expect(install.diagnostics).toContainEqual(expect.objectContaining({ code: 'piAgentConsumerUnavailable',
      subject: expect.objectContaining({ pluginId: 'local/roles' }), detail: { reasonCode: 'piAgentConsumerMissing' } }));
    expect(await fs.readdir(path.join(roles, 'agents'))).toHaveLength(1);

    const reviewed = await prepareRecovery('sync', ['local/roles'], { cwd, env, scope, context: scope, yes: true, cliVersion: '1.0.0' }, { nativeCliRunner });
    try {
      expect(reviewed.receipt.blockers).toEqual([]);
      const extension = path.join(guide, 'index.mjs');
      const changed = 'export default function register(pi) { pi.registerTool({ name: "user-tool" }); }\n';
      await fs.writeFile(extension, changed);
      const status = await readRecoveryStatus({ context: scope, cwd, env, nativeCliRunner });
      for (const pluginId of ['local/guide', 'local/roles']) {
        const target = status.inventory?.find((item) => item.pluginId === pluginId)?.targetResults[0];
        expect(target?.deploymentObservations?.[0]?.after.prerequisites.agentConsumers).toMatchObject({
          observation: 'unknown', reasonCodes: ['agentConsumerDiscoveryUnverified'],
        });
      }
      expect(await executeRecovery(reviewed)).toMatchObject({ ok: false, outputsMayHaveChanged: false,
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
      expect(await fs.readFile(extension, 'utf8')).toBe(changed);
    } finally { await reviewed.context.dispose(); }
  });

  it('keeps installed Pi roles current while the execution extension changes', async () => {
    // Test Value Gate: check live notices and no-op sync without masking a lost role file.
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'pi-roles-catalog');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'fixture entry', { mode: 0o755 });
    await createCatalogSnapshotFixture(source, 'roles', [], 'Pi roles.', (manifest) => {
      manifest.platforms = ['pi'];
      manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review the work.', prompt: 'Check the work.' }] };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['pi']);
    const root = resolvePlatformConfigRoot('pi', { cwd, env });
    const settings = path.join(root, 'settings.json');
    const extension = 'npm:@tintinweb/pi-subagents@0.22.0';
    const extensionRoot = path.join(root, 'npm', 'node_modules', '@tintinweb', 'pi-subagents');
    const registration = 'aw-packages/aw-local-roles';
    const packageRoot = path.join(root, registration);
    let installs = 0;
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
      if (args.includes('--version')) return reply('Pi coding agent 1.5.0');
      const packages: Array<string | { source: string }> = (await fs.readJson(settings, { throws: false }).catch(() => null))?.packages ?? [];
      if (args[0] === 'list') return reply(packages.length ? ['User packages:',
        ...packages.flatMap((entry) => {
          const name = typeof entry === 'string' ? entry : entry.source;
          return [`  ${name}`, `    ${name === extension ? extensionRoot : packageRoot}`];
        }), ''].join('\n') : 'No packages installed.\n');
      if (args[0] !== 'install' || args.includes('--local') || args.at(-1) !== packageRoot) throw new Error('Unexpected Pi operation');
      installs++;
      await fs.outputJson(settings, { packages: [registration] });
      return reply(`Installed ${packageRoot}`);
    };
    const aw = async (...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--context', 'user', '--json'], { cwd, env, nativeCliRunner, interactive: false });
      return { exitCode: result.exitCode, value: result.parseJsonStdout<CommandResult>() };
    };
    const role = { target: 'pi', scope: 'user', satisfaction: 'installed', installedComponentCount: 1,
      installedComponentIds: ['agent:reviewer'] };
    const notice = (reasonCode: string) => expect.objectContaining({ code: 'piAgentConsumerUnavailable', severity: 'warning', detail: { reasonCode } });
    const install = await aw('install', 'local/roles', '--scope', 'user', '--yes');
    expect(install, JSON.stringify(install)).toMatchObject({ exitCode: 0, value: { diagnostics: expect.arrayContaining([notice('piAgentConsumerMissing')]),
      data: { remainingTargets: [], targetResults: [role] } } });
    const agentRoot = path.join(packageRoot, 'agents');
    const [agentFile] = await fs.readdir(agentRoot);
    const rolePath = path.join(agentRoot, agentFile!);
    const roleBytes = await fs.readFile(rolePath);
    const untouchedTimestamp = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(rolePath, untouchedTimestamp, untouchedTimestamp);
    const assertStatus = async () => {
      const status = await aw('status');
      expect(status, JSON.stringify(status)).toMatchObject({ exitCode: 0, value: { data: { counts: { pending: 0 }, allSatisfied: true,
        inSync: true, inventory: [{ targetResults: [role] }] } } });
      expect(status.value.diagnostics.map(({ code }) => code)).not.toContain('platformInputDrift');
      expect(status.value.nextActions).toEqual([]);
      return status.value.diagnostics;
    };
    expect(await assertStatus()).toContainEqual(notice('piAgentConsumerMissing'));
    await fs.outputJson(path.join(extensionRoot, 'package.json'), { name: '@tintinweb/pi-subagents', version: '0.22.0', pi: { extensions: ['./index.ts'] } });
    await fs.outputFile(path.join(extensionRoot, 'index.ts'), 'export default function () {}\n');
    await fs.outputJson(settings, { packages: [registration, { source: extension, extensions: [] }] });
    expect(await assertStatus()).toContainEqual(notice('piAgentConsumerDisabled'));
    await fs.outputJson(settings, { packages: [registration, extension] });
    expect((await assertStatus()).map(({ code }) => code)).not.toContain('piAgentConsumerUnavailable');
    const sync = await aw('sync', 'local/roles', '--yes');
    expect(sync, JSON.stringify(sync)).toMatchObject({ exitCode: 0, value: { data: { remainingTargets: [], changes: { outputs: 'none' } } } });
    expect(installs).toBe(1);
    await expect(fs.readFile(rolePath)).resolves.toEqual(roleBytes);
    expect((await fs.stat(rolePath)).mtimeMs).toBe(untouchedTimestamp.getTime());

    await fs.remove(rolePath);
    const missing = await aw('status');
    expect(missing.value.data, JSON.stringify(missing)).toMatchObject({ counts: { pending: 1 }, allSatisfied: false, inSync: false });
    expect(missing.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'componentOutputMissing' }));
  });

  it('verifies a zero-output Pi Project against current registration and the skipped Hook script', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const source = path.join(cwd, 'pi-catalog');
    const pluginRoot = path.join(source, 'plugins/demo');
    const script = path.join(pluginRoot, 'pi/scripts/guard.mjs');
    const bin = path.join(cwd, 'bin');
    const env = { ...isolation.env, PATH: bin };
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'fixture entry', { mode: 0o755 });
    await fs.outputFile(script, 'export {};\n');
    await createCatalogSnapshotFixture(source, 'demo', [], 'Pi Project Hook.', (manifest) => {
      manifest.platforms = ['pi'];
      manifest.extensions = { hooks: [{ id: 'guard', event: 'before_tool', feedback: 'block', command: 'node ./scripts/guard.mjs' }] };
    });
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['pi']);
    let list = 'No packages installed.\n';
    let listReadable = true;
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Pi coding agent 1.5.0', stderr: '' };
      if (args[0] === 'list') return { exitCode: listReadable ? 0 : 1, stdout: listReadable ? list : '', stderr: '' };
      throw new Error('A skipped Hook needs no Pi mutation.');
    };
    const aw = async (...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--json'], { cwd, env, nativeCliRunner, interactive: false });
      return { exitCode: result.exitCode, value: result.parseJsonStdout<CommandResult>() };
    };
    const target = { target: 'pi', scope: 'project', satisfaction: 'not-applicable', installedComponentCount: 0,
      componentGaps: [expect.objectContaining({ kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }] })] };
    const install = await aw('install', 'local/demo', '--scope', 'project', '--yes');
    expect(install, JSON.stringify(install)).toMatchObject({ exitCode: 0, value: { data: { remainingTargets: [], targetResults: [target] } } });
    const status = () => aw('status', '--context', 'project');
    const clean = await status();
    expect(clean, JSON.stringify(clean)).toMatchObject({ exitCode: 0, value: { data: { counts: { pending: 0 }, allSatisfied: true,
      inSync: true, inventory: [{ targetResults: [{ ...target, deploymentObservations: [{ after: { registration: 'unknown' } }] }] }] } } });
    const sync = await aw('sync', 'local/demo', '--context', 'project', '--yes');
    expect(sync, JSON.stringify(sync)).toMatchObject({ exitCode: 0, value: { data: { remainingTargets: [], changes: { outputs: 'none' } } } });

    listReadable = false;
    const unreadable = await status();
    expect(unreadable.exitCode).not.toBe(0);
    expect(unreadable.value.data).toMatchObject({ allSatisfied: null, inSync: null });
    listReadable = true;
    const packageRoot = path.join(cwd, '.pi', 'aw-packages', 'aw-local-demo');
    list = `Project packages:\n  npm:foreign-source\n    ${packageRoot}\n`;
    expect((await status()).value.data).toMatchObject({ allSatisfied: null, inSync: null });
    list = 'No packages installed.\n';
    await fs.outputJson(path.join(cwd, '.pi', 'settings.json'), { packages: ['./aw-packages/aw-local-demo'] });
    expect((await status()).value.data).toMatchObject({ allSatisfied: false, inSync: false });

    await fs.outputJson(path.join(cwd, '.pi', 'settings.json'), {});
    const updateSource = async () => {
      const catalogPath = path.join(source, 'catalog-manifest.json');
      const changed = await readPluginManifest(pluginRoot, { mode: 'bundle' });
      await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(changed, pluginRoot)] });
      await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    };
    await fs.appendFile(script, '// updated input\n');
    await updateSource();
    expect((await status()).value.data).toMatchObject({ allSatisfied: null, inSync: null });
    expect((await aw('sync', 'local/demo', '--context', 'project', '--yes')).exitCode).toBe(0);
    expect((await status()).value.data).toMatchObject({ allSatisfied: true, inSync: true });
    await fs.remove(script);
    await updateSource();
    const damaged = await aw('sync', 'local/demo', '--context', 'project', '--yes');
    expect(damaged.exitCode).not.toBe(0);
    const afterDamage = await status();
    expect(afterDamage.exitCode).not.toBe(0);
    expect(afterDamage.value.data).toMatchObject({ allSatisfied: null, inSync: null,
      inventory: [{ targetResults: [{ content: 'unknown', satisfaction: 'unknown', blockerCodes: expect.arrayContaining(['componentResourceMissing']) }] }] });
  });

  // Test Value Gate: an executed empty set must remain current through read-only status, until its source inputs change.
  it('persists an intentional empty native set without mutations and invalidates changed inputs', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'empty-project');
    const source = path.join(isolation.layout.fixtureCwd, 'empty-catalog');
    const pluginRoot = path.join(source, 'plugins', 'empty');
    const bin = path.join(isolation.layout.fixtureCwd, 'bin');
    const rendererCalls = path.join(isolation.layout.fixtureCwd, 'empty-renderer-calls');
    await fs.ensureDir(cwd);
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(bin, 'cursor-agent'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'),
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(rendererCalls)}, 'render\\n');\nprocess.stdout.write(JSON.stringify({ version: 3, components: [], omitted: [], unmet: [] }));\n`);
    await createCatalogSnapshotFixture(source, 'empty', [], 'Empty fixture.\n', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['cursor'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    const env = { ...isolation.env, PATH: bin };
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] },
    expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await writeIntentFixture({ scope: 'project', cwd, env }, { roots: [{ pluginId: 'local/empty' }], targets: ['cursor'] });
    const nativeCliRunner = async ({ args }: { args: string[] }) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      throw new Error('The empty fixture must not execute native mutations.');
    };
    const result = await runRecovery('sync', [], { scope: 'project', context: 'project', cwd, env,
      cliVersion: '1.0.0', yes: true }, { nativeCliRunner });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const target = result.targetResults.find((entry) => entry.agent === 'cursor')!;
    expect(target).toMatchObject({ execution: 'no-op', content: 'satisfied',
      deploymentReceipts: [expect.objectContaining({ effects: [], unmet: [],
        products: [expect.objectContaining({ product: 'cli', version: '2026.11.05-86047df' })] })],
    });
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'aw-plugins'))).toBe(false);
    const callsAfterExecute = await fs.readFile(rendererCalls, 'utf8');
    const matched = await readRecoveryStatus({ context: 'project', cwd, env, nativeCliRunner, targets: ['cursor'] });
    expect(matched.allSatisfied, JSON.stringify(matched)).toBe(true);
    expect(await fs.readFile(rendererCalls, 'utf8')).toBe(callsAfterExecute);

    await fs.appendFile(path.join(pluginRoot, 'render.mjs'), '// Changed renderer input.\n');
    const changedPlugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(changedPlugin, pluginRoot)] });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const drifted = await readRecoveryStatus({ context: 'project', cwd, env, nativeCliRunner, targets: ['cursor'] });
    expect(drifted.allSatisfied).not.toBe(true);
    expect(drifted.inventory?.flatMap((entry) => entry.targetResults)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'cursor', content: 'unknown', blockers: [], reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
      ]) }),
    ]));
    expect(await fs.readFile(rendererCalls, 'utf8')).toBe(callsAfterExecute);
  });
});
