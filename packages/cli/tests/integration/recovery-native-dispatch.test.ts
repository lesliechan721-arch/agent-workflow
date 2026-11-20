import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runRecovery } from '../../src/recovery/coordinator.js';
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
  return { cwd, env, aw, projectScript, trustAndRetry };
}

describe('native recovery dispatch', () => {
  // Confirm both a completed empty rules projection and a real scoped Markdown rule
  // through the write path, then read status without running the renderer.
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
    const rendered = await fs.readFile(trace, 'utf8');
    const read = () => readRecoveryStatus({ context: scope, cwd, env, nativeCliRunner });
    const status = await read();
    expect(status, JSON.stringify(status)).toMatchObject({ allSatisfied: true, inSync: true, counts: {
      blocked: 0, unconfirmed: 0, pending: 0, ready: 1,
    } });
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
