import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

it.each(['claude', 'generic'] as const)('installs independent components on %s without publishing unavailable command permissions', async (target) => {
  const isolation = getCurrentSourceTestIsolation();
  const { env } = isolation;
  const cwd = isolation.layout.fixtureCwd;
  const catalog = path.join(cwd, 'catalog');
  const root = path.join(catalog, 'plugins/demo');
  const claude = await createClaudeNativeTestRuntime(isolation);
  const tool = { key: 'run', runner: 'node' as const, entry: 'run.mjs' };
  const policy = (set: string) => ({ command: { set, key: 'run', variant: 'default' }, argsPrefix: ['check'] });
  await fs.outputFile(path.join(root, 'tools/run.mjs'), 'process.exitCode = 0;\n');
  await fs.outputFile(path.join(root, 'render.mjs'), `
    import fs from 'node:fs';
    const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
    const plan = { version: 3, components: [], omitted: [], unmet: [] };
    if (c.platform === 'claude') {
      if (c.allowedOutputKinds.includes('skill')) plan.unmet.push({id:'scheduler',kind:'skill',name:'scheduler',
        reasonCode:'capability-unverified',requiredFeatures:[{feature:'skill.runtime-config', values:['aw.installed-runtime-config.v2']}]});
      if (c.allowedOutputKinds.includes('agent')) plan.components.push({id:'role',kind:'agent',name:'role',
        content:{description:'Independent role',prompt:'Only perform the requested work.'}});
    } else if (c.allowedOutputKinds.includes('skill')) plan.components.push({id:'portable',kind:'skill',name:'portable',
      content:{files:{'SKILL.md':{text:'---\\nname: portable\\ndescription: Independent portable skill.\\n---\\nRead this.\\n'},'README.md':{text:'Read this.\\n'}}}});
    console.log(JSON.stringify(plan));
  `);
  await createCatalogSnapshotFixture(catalog, 'demo', [], 'Command policy fixture.', (manifest) => {
    manifest.platforms = ['claude', 'generic'];
    manifest.artifacts = { configKeys: [] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    manifest.managedCommands = { packages: [{ key: 'tools', sourceDir: './tools', scope: 'user', platforms: ['claude'] }], sets: [
      { set: 'scheduler', producer: { kind: 'artifact', platform: 'claude', artifactId: 'scheduler' }, mode: 'static', entries: [tool] },
      { set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static', entries: [tool] },
    ] };
    manifest.extensions = { permissions: [
      { name: 'delegate', allow: ['echo hello', policy('scheduler')], agentOverrides: { claude: { sandbox: { excludedCommands: [policy('scheduler')] } } } },
      { name: 'portable-only', allow: [policy('tools')], agentOverrides: { claude: null } },
    ] };
  });
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] },
    expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
  const options = { cwd, env, scope: 'user' as const, context: 'user' as const, cliVersion: '1.0.0', targets: [target], yes: true };
  await setTargets(options, [target]);
  const installed = await runPublicLifecycle('install', ['local/demo'], options, claude.runtime);
  expect(installed.status, JSON.stringify(installed)).toBe('success');
  expect(installed.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied', severity: 'warning',
    subject: expect.objectContaining({ field: target === 'generic' ? 'permissions.portable-only' : 'permissions.delegate.scheduler.run.default' }) }));
  if (target === 'claude') {
    const settings = await fs.readJson(path.join(claude.claudeHome, 'settings.json'));
    expect(settings.permissions.allow).toEqual(['Bash(echo hello)']);
    expect(settings.sandbox?.excludedCommands ?? []).toEqual([]);
  }
  const file = target === 'claude' ? path.join([...claude.packageRoots.values()][0]!, 'agents/role.md')
    : path.join(env.HOME!, '.agents/skills/portable/SKILL.md');
  expect(await fs.readFile(file, 'utf8')).toContain(target === 'claude' ? 'Only perform the requested work.' : 'Read this.');
  const timestamp = (await fs.stat(file)).mtimeMs;
  const status = await runPublicPluginStatus([], { context: 'user', cwd, env }, claude.runtime);
  expect(status.data, JSON.stringify(status)).toMatchObject({ inSync: true, allSatisfied: true });
  if (target === 'generic') expect(status.diagnostics).toContainEqual(expect.objectContaining({ code: 'invocationPolicyNotApplied' }));
  const sync = await runPublicLifecycle('sync', ['local/demo'], options, claude.runtime);
  expect(sync.status, JSON.stringify(sync)).toBe('success');
  expect(sync.data.remainingTargets).toEqual([]);
  expect((await fs.stat(file)).mtimeMs).toBe(timestamp);
});
