import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { publicExitCode, renderPublicResult } from '../../src/output/public-result.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: Public receipts retain the skipped actions across a no-op sync,
// including when all actual output belongs to a separate supplement.
it.each([
  { target: 'claude', producer: 'capability gap', staticRole: false },
  { target: 'claude', producer: 'author omission', staticRole: false },
  { target: 'claude', producer: 'scope exclusion', staticRole: true },
  { target: 'codex', producer: 'author omission', staticRole: false },
  { target: 'codex', producer: 'author omission', staticRole: true },
  { target: 'generic', producer: 'unmapped permissions', staticRole: false },
] as const)('installs independent components on $target with static role=$staticRole despite $producer', async ({ target, producer, staticRole }) => {
  const isolation = getCurrentSourceTestIsolation();
  const { env } = isolation;
  const cwd = isolation.layout.fixtureCwd;
  const catalog = path.join(cwd, 'catalog');
  const root = path.join(catalog, 'plugins/demo');
  const claude = target === 'claude' ? await createClaudeNativeTestRuntime(isolation) : undefined;
  const codex = target === 'codex' ? await createCodexNativeTestRuntime(isolation) : undefined;
  const runtime = claude?.runtime ?? { env, nativeCliRunner: codex?.nativeCliRunner };
  const scope = target === 'codex' ? 'project' : 'user';
  const nativeTarget = target === 'codex' ? 'codex' : 'claude';
  if (scope === 'project') await fs.ensureDir(path.join(cwd, '.git'));
  const tool = { key: 'run', runner: 'node' as const, entry: 'run.mjs' };
  const privateArg = '/private/fixture/permission-argument';
  const policy = (set: string) => ({ command: { set, key: 'run', variant: 'default' }, argsPrefix: [privateArg] });
  await fs.outputFile(path.join(root, 'tools/run.mjs'), 'process.exitCode = 0;\n');
  await fs.outputFile(path.join(root, 'render.mjs'), `
    import fs from 'node:fs';
    const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
    const producer = ${JSON.stringify(producer)};
    const plan = { version: 3, components: [], omitted: [], unmet: [] };
    if (c.platform !== 'generic') {
      if (c.allowedOutputKinds.includes('skill')) {
        if (producer === 'author omission') plan.omitted.push({id:'scheduler',kind:'skill',reason:'not-offered'});
        else plan.unmet.push({id:'scheduler',kind:'skill',name:'scheduler',reasonCode:'capability-unverified',
          requiredFeatures:[{feature:'skill.runtime-config', values:['aw.installed-runtime-config.v2']}]});
      }
      if (c.allowedOutputKinds.includes('agent')) plan.components.push({id:'role',kind:'agent',name:'role',
        content:{description:'Independent role',prompt:'Only perform the requested work.'}});
    } else if (c.allowedOutputKinds.includes('skill')) plan.components.push({id:'portable',kind:'skill',name:'portable',
      content:{files:{'SKILL.md':{text:'---\\nname: portable\\ndescription: Independent portable skill.\\n---\\nRead this.\\n'},'README.md':{text:'Read this.\\n'}}}});
    console.log(JSON.stringify(plan));
  `);
  await createCatalogSnapshotFixture(catalog, 'demo', [], 'Command policy fixture.', (manifest) => {
    manifest.platforms = [nativeTarget, 'generic'];
    manifest.artifacts = { configKeys: [], ...(staticRole ? { scopes: [target === 'codex' ? 'user' : 'project'] } : {}) };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    manifest.managedCommands = { packages: [{ key: 'tools', sourceDir: './tools', scope: 'user', platforms: ['claude'] }], sets: [
      { set: 'scheduler', producer: { kind: 'artifact', platform: nativeTarget, artifactId: 'scheduler' }, mode: 'static', entries: [tool] },
      { set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static', entries: [tool] },
    ] };
    manifest.extensions = { permissions: [
      { name: 'delegate', allow: [...(target === 'codex' ? [] : ['echo hello']), policy('scheduler')],
        ...(target === 'codex' ? {} : { ask: ['echo check'], deny: ['echo forbid'] }),
        ...(target === 'codex' ? {} : { agentOverrides: { claude: { sandbox: { excludedCommands: [policy('scheduler')] } } } }) },
      { name: 'portable-only', allow: [policy('tools')], ask: [`echo ${privateArg}`], deny: ['echo forbid'],
        agentOverrides: { [nativeTarget]: null } },
    ] };
    if (staticRole) manifest.extensions.agents = [
      { name: 'role', description: 'Independent role', prompt: 'Only perform the requested work.' },
    ];
  });
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: catalog }] },
    expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
  const options = { cwd, env, scope, context: scope, cliVersion: '1.0.0', targets: [target], yes: true };
  await setTargets(options, [target]);
  const installed = await runPublicLifecycle('install', ['local/demo'], options, runtime);
  expect(installed.status, JSON.stringify(installed)).toBe('success');
  expect(publicExitCode(installed)).toBe(0);
  const field = target === 'generic' ? 'permissions.portable-only' : 'permissions.delegate.scheduler.run.default';
  const actions = target === 'generic' ? ['allow', 'ask', 'deny'] : target === 'codex' ? ['allow'] : ['allow', 'sandbox'];
  const reasonCode = { 'capability gap': 'capability-unverified', 'author omission': 'not-offered',
    'scope exclusion': 'scope-excluded', 'unmapped permissions': 'delivery-unavailable' }[producer];
  const notice = expect.objectContaining({ code: 'invocationPolicyNotApplied', severity: 'warning',
    subject: { pluginId: 'local/demo', target, scope, field },
    detail: { reasonCode, skippedPermissionActions: actions } });
  expect(installed.diagnostics).toContainEqual(notice);
  expect(JSON.stringify(installed)).not.toContain(privateArg);
  const text = renderPublicResult(installed);
  expect(text).toContain(actions.join(', '));
  expect(text).not.toContain(privateArg);
  if (claude) {
    const settings = await fs.readJson(path.join(claude.claudeHome, 'settings.json'));
    expect(settings.permissions.allow).toEqual(['Bash(echo hello)']);
    expect(settings.permissions.ask).toEqual(['Bash(echo check)']);
    expect(settings.permissions.deny).toEqual(['Bash(echo forbid)']);
    expect(settings.sandbox?.excludedCommands ?? []).toEqual([]);
  }
  const file = claude ? path.join([...claude.packageRoots.values()][0]!, 'agents/role.md')
    : target === 'codex' ? path.join(cwd, '.codex/agents/aw-local-demo-role.toml') : path.join(env.HOME!, '.agents/skills/portable/SKILL.md');
  expect(await fs.readFile(file, 'utf8')).toContain(target === 'generic' ? 'Read this.' : 'Only perform the requested work.');
  const timestamp = (await fs.stat(file)).mtimeMs;
  const status = await runPublicPluginStatus([], { context: scope, cwd, env }, runtime);
  expect(status.data, JSON.stringify(status)).toMatchObject({ inSync: true, allSatisfied: true });
  expect(status.diagnostics).toContainEqual(notice);
  expect(JSON.stringify(status)).not.toContain(privateArg);
  if (producer === 'author omission') expect(status.data.inventory?.[0]?.targetResults[0]?.componentGaps ?? []).toEqual([]);
  codex?.nativeCliRunner.mockClear();
  const sync = await runPublicLifecycle('sync', ['local/demo'], options, runtime);
  expect(sync.status, JSON.stringify(sync)).toBe('success');
  expect(sync.data.remainingTargets).toEqual([]);
  expect(sync.diagnostics).toContainEqual(notice);
  expect(JSON.stringify(sync)).not.toContain(privateArg);
  expect((await fs.stat(file)).mtimeMs).toBe(timestamp);
  if (codex) {
    expect(sync.data.changes).toMatchObject({ outputs: 'none' });
    expect(status.data.inventory?.[0]?.targetResults).toContainEqual(expect.objectContaining({
      content: 'satisfied', satisfaction: 'installed', installedComponentCount: 1, installedComponentIds: [staticRole ? 'agent:role' : 'role'],
    }));
    expect(codex.nativeCliRunner.mock.calls.every(([{ args }]) => args.includes('--version') || args.includes('list'))).toBe(true);
    await fs.remove(file);
    const missing = await runPublicPluginStatus([], { context: scope, cwd, env }, runtime);
    expect(missing.data).toMatchObject({ inSync: false, allSatisfied: false, counts: { pending: 1 } });
    expect(missing.data.inventory?.[0]?.targetResults).toContainEqual(expect.objectContaining({ content: 'absent' }));
  }
});
