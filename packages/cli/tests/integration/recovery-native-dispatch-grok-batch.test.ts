import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';

describe('Grok native recovery batch evidence', () => {
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
      const unchangedNames = independentUpgrade ? names.filter((name) => name !== 'base') : ['bundle'];
      const readUnchangedRoles = () => Promise.all(unchangedNames.map(async (name) => {
        const file = path.join(projectPlugins, 'aw-local-' + name, 'agents', `${name}-reviewer.md`);
        const [text, { mtimeMs }] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
        return { name, text, mtimeMs };
      }));
      const before = await readUnchangedRoles();
      for (const { name, text } of before) expect(text).toContain(`Check the ${name} output.`);
      const statusOptions = { cwd, env, cliVersion: options.cliVersion, context: options.context };
      const status = await runPublicPluginStatus([], statusOptions, { nativeCliRunner });
      expect(status.data).toMatchObject({ counts: { ready: names.length, pending: 0 }, inSync: true, allSatisfied: true });
      // The smaller batches cover standalone no-op syncs. The seven-package case checks the sync that actually upgrades base.
      if (!independentUpgrade) {
        const sync = await runPublicLifecycle('sync', requested, options, { nativeCliRunner });
        expect(sync, JSON.stringify(sync)).toMatchObject({ status: 'success', data: { remainingTargets: [], changes: { outputs: 'none' } } });
        expect(await readUnchangedRoles()).toEqual(before);
      }
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
          if (!independentUpgrade) {
            expect((await runPublicLifecycle('sync', [], options, { nativeCliRunner })).data.changes.outputs).toBe('none');
          }
          expect(await readUnchangedRoles()).toEqual(before);
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

  it.each(['unchanged', 'external edit'] as const)('revalidates Grok User rules after a partial install with %s', async (scenario) => {
    installNativeTestQualification({ platforms: ['grok'], discovery: true, executable: process.execPath });
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const catalog = path.join(cwd, 'catalog');
    const host = resolvePlatformConfigRoot('grok', { cwd, env });
    const rules = path.join(host, 'rules');
    const firstRule = path.join(rules, 'aw-local-advisor-guide.md');
    const secondRule = path.join(rules, 'aw-local-explore-guide.md');
    const names = ['advisor', 'explore'];
    for (const name of names) {
      const skill = path.join(catalog, 'plugins', name, 'skills', name);
      await fs.outputFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name}.\n---\nUse ${name}.\n`);
      await fs.outputFile(path.join(skill, 'README.md'), `Use ${name}.\n`);
    }
    await createDependencyCatalogSnapshotFixture(catalog, names.map((name) => ({ name, configureManifest(manifest) {
      manifest.platforms = ['grok'];
      manifest.skills = './skills';
      manifest.extensions = { instructions: [{ name: 'guide', title: 'Guide', content: `Use ${name}.`, coverage: ['main'] }] };
    } })));
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] }, expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await setTargets({ cwd, env, scope: 'user' }, ['grok']);
    let firstCompleted = false;
    let edited = false;
    const nativeCliRunner = async ({ args }: NativeCliInvocation) => {
      let stdout: string;
      if (args.includes('--version')) stdout = 'grok 1.0.77';
      else if (args[0] === 'plugin' && args[1] === 'list') stdout = '[]';
      else if (args[0] === 'inspect') {
        if (scenario === 'external edit' && firstCompleted && !edited) {
          const content = await fs.readFile(firstRule, 'utf8');
          await fs.writeFile(firstRule, content.replace('Use advisor.', 'Use altered.'));
          edited = true;
        }
        const files = await fs.pathExists(rules) ? await fs.readdir(rules) : [];
        const projectInstructions = await Promise.all(files.map(async (file) => {
          const rule = path.join(rules, file);
          const sizeBytes = (await fs.stat(rule)).size;
          return { path: rule, scope: 'global', fileType: 'rules', sizeBytes, approxTokens: Math.floor(sizeBytes / 4) };
        }));
        stdout = JSON.stringify({ grokVersion: '1.0.77', projectTrusted: true, plugins: [], skills: [],
          agents: [], hooks: [], mcpServers: [], projectInstructions });
      } else throw new Error('Unexpected automatic Grok mutation: ' + JSON.stringify(args));
      return { exitCode: 0, stdout, stderr: '' };
    };
    const result = await runRecovery('install', names.map((name) => 'local/' + name),
      { cwd, env, cliVersion: '1.0.0', scope: 'user', context: 'user', targets: ['grok'], yes: true },
      { nativeCliRunner, onInstallProgress: ({ completed }) => { if (completed === 1) firstCompleted = true; } });
    const advisor = result.targetResults.find(({ pluginId }) => pluginId === 'local/advisor');
    const explore = result.targetResults.find(({ pluginId }) => pluginId === 'local/explore');
    expect(advisor?.execution).toBe('partial');
    expect(advisor?.blockers.map(({ code }) => code)).toContain('nativeTrustRequired');
    if (scenario === 'external edit') {
      expect(edited).toBe(true);
      expect(explore?.blockers.map(({ code }) => code)).toContain('operationPlanStale');
      expect(await fs.readFile(firstRule, 'utf8')).toContain('Use altered.');
      expect(await fs.pathExists(secondRule)).toBe(false);
    } else {
      expect(await fs.readFile(firstRule, 'utf8')).toContain('Use advisor.');
      expect(explore?.execution).toBe('partial');
      expect(explore?.blockers.map(({ code }) => code)).toContain('nativeTrustRequired');
      expect(await fs.readFile(secondRule, 'utf8')).toContain('Use explore.');
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

});
