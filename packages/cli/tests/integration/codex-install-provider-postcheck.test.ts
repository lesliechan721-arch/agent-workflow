import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { runCli } from '../../src/index.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import type { PluginMeta } from '../../src/types.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createCodexNativeTestRuntime, createNativeDependencyCatalog, replaceCatalogSourcesConfig } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

it.each(['supported', 'partly qualified', 'write failed', 'hard gap'] as const)(
  'reports invocation limitations only for delivered Skills with a %s native target', async (native) => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const source = path.join(cwd, 'source');
    const names = ['commit', 'merge', 'worktree'];
    for (const name of names) {
      const directory = path.join(source, 'plugins', 'git-tools', 'skills', name);
      const controls = name === 'commit' ? `user-invocable: ${native === 'supported'}\ndisable-model-invocation: true\n` : '';
      await fs.outputFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name}.\n${controls}---\n`);
      await fs.outputFile(path.join(directory, 'README.md'), `Use ${name}.\n`);
    }
    if (native === 'hard gap') {
      const unavailable = path.join(source, 'plugins/git-tools/skills/isolated');
      await fs.outputFile(path.join(unavailable, 'SKILL.md'),
        '---\nname: isolated\ndescription: Requires isolated execution.\ncontext: fork\ndisable-model-invocation: true\n---\n');
      await fs.outputFile(path.join(unavailable, 'README.md'), 'Run in isolation.\n');
    }
    await createCatalogSnapshotFixture(source, 'git-tools', [], undefined, (manifest) => {
      manifest.platforms = ['codex', 'generic'];
      manifest.skills = './skills';
    });
    const cfg = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ env, expectedDigest: cfg.digest,
      config: { schemaVersion: 2, sources: [{ type: 'path', id: 'team', path: source, primary: true }] } });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['codex', 'generic'] });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const capture = createCapturedCliIo();
    const code = await runCli(['plugin', 'install', 'team/git-tools', '--scope', 'user', '--target', 'codex', '--target', 'generic', '--yes', '--json'], {
      cwd, env, io: capture.io, interactive: false,
      nativeCliRunner: (call) => native === 'write failed' && call.args.includes('add') && !call.args.includes('marketplace')
        ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Install failed.' }) : runtime.nativeCliRunner(call),
    });
    const receipt = JSON.parse(capture.readStdout());
    const partial = native === 'write failed' || native === 'hard gap';
    expect(code, capture.readStdout()).toBe(partial ? 4 : 0);
    expect(receipt.status).toBe(partial ? 'partial' : 'success');
    const warnings = receipt.diagnostics.filter((item: { code: string }) => item.code === 'skillInvocationPolicyNotGuaranteed');
    expect(warnings).toHaveLength(native === 'partly qualified' || native === 'hard gap' ? 2 : 1);
    expect(warnings).toContainEqual(expect.objectContaining({ severity: 'warning', detail: { reasonCode: 'noBoundExecutor' },
      subject: { pluginId: 'team/git-tools', scope: 'user', target: 'generic', field: 'skill.commit' } }));
    if (native === 'partly qualified' || native === 'hard gap') {
      const warning = warnings.find((item: { subject: { target: string } }) => item.subject.target === 'codex');
      expect(warning).toMatchObject({ severity: 'warning', subject: { field: 'skill.commit' } });
      expect(warning.message).toContain('skill.visibility=hidden');
      expect(warning.message).not.toContain('skill.invocation.model');
    }
    const skillRoots = [path.join(env.HOME!, '.agents', 'skills')];
    if (native !== 'write failed') {
      const [plugin, marketplace] = [...runtime.installed][0]!.split('@');
      skillRoots.push(path.join(env.CODEX_HOME!, 'plugins/cache', marketplace!, plugin!, '1.0.0', 'skills'));
    }
    for (const root of skillRoots) {
      for (const name of names) expect(await fs.pathExists(path.join(root, name, 'SKILL.md'))).toBe(true);
      if (native === 'hard gap') expect(await fs.pathExists(path.join(root, 'isolated', 'SKILL.md'))).toBe(false);
    }
  }, 30_000,
);

it.each(['wrong version', 'missing registration'] as const)(
  'blocks consumer writes when the installed Codex provider reports %s', async (fault) => {
    installNativeTestQualification({ discovery: true });
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const root = path.join(cwd, 'catalog');
    const marker = path.join(cwd, 'consumer-preapply');
    await fs.outputFile(path.join(root, 'plugins/consumer/preapply.mjs'), [
      "import fs from 'node:fs';",
      "const { target } = JSON.parse(fs.readFileSync(0, 'utf8'));",
      `fs.appendFileSync(${JSON.stringify(marker)} + '.' + target.platform, 'ran');`,
    ].join('\n'));
    const names = ['provider', 'consumer', 'sibling'];
    for (const name of names) await fs.outputFile(path.join(root, 'plugins', name, 'skills', `${name}-skill`, 'README.md'), `Use ${name}.\n`);
    await createNativeDependencyCatalog(root, names.map((name) => ({
      name,
      ...(name === 'consumer' ? { dependencies: ['provider'] } : {}),
      configureManifest(manifest: PluginMeta['manifest']) {
        manifest.platforms = ['codex', 'generic'];
        if (name === 'consumer') manifest.scripts = { preApply: { path: './preapply.mjs' } };
      },
    })));
    const initial = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ env, expectedDigest: initial.digest, config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', path: root, primary: true }] } });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['codex', 'generic'] });
    const runtime = await createCodexNativeTestRuntime(isolation);
    let providerReads = 0;
    const runner = async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      if (!invocation.args.includes('list') || !invocation.args.includes('--json')) return response;
      const list = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string; version: string }> };
      const provider = list.installed.find((plugin) => plugin.pluginId.startsWith('provider@'));
      if (!provider) return response;
      providerReads++;
      if (providerReads === 1) return response;
      if (fault === 'wrong version') provider.version = '999.0.0';
      else list.installed = list.installed.filter((entry) => entry !== provider);
      return { ...response, stdout: JSON.stringify(list) };
    };
    const capture = createCapturedCliIo();
    const code = await runCli(['plugin', 'install', 'team/consumer', 'team/sibling',
      '--target', 'codex', '--target', 'generic', '--scope', 'user', '--yes', '--json'], {
      cwd, env, io: capture.io, interactive: false, nativeCliRunner: runner,
    });
    expect(providerReads, capture.readStdout()).toBeGreaterThan(1);
    const adds = runtime.nativeCliRunner.mock.calls.flatMap(([call]) => {
      const args = call.args.slice(call.args.indexOf('plugin'));
      return args[1] === 'add' ? [args[2]!.split('@')[0]] : [];
    });
    expect(adds.sort(), capture.readStdout()).toEqual(['provider', 'sibling']);
    expect(await fs.pathExists(`${marker}.codex`)).toBe(false);
    expect(await fs.readFile(`${marker}.generic`, 'utf8')).toBe('ran');
    const result = JSON.parse(capture.readStdout());
    expect(code).toBe(4);
    expect(result).toMatchObject({ status: 'partial', data: {
      targetResults: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'team/provider', execution: 'partial',
          blockerCodes: expect.arrayContaining([fault === 'wrong version' ? 'codexNativeInstallIncomplete' : 'deploymentPostcheckFailed']) }),
        expect.objectContaining({ pluginId: 'team/consumer', execution: 'not-run',
          blockerCodes: expect.arrayContaining(['dependencyInstallFailed']) }),
        expect.objectContaining({ pluginId: 'team/consumer', target: 'generic', observation: 'verified' }),
        expect.objectContaining({ pluginId: 'team/sibling', target: 'codex', execution: 'applied', observation: 'verified' }),
      ]),
    }, nextActions: expect.arrayContaining([expect.objectContaining({
      argv: ['aw', 'plugin', 'sync', 'team/consumer', '--context', 'user', '--target', 'codex'],
    })]) });
    const retry = createCapturedCliIo();
    expect(await runCli(['plugin', 'sync', 'team/consumer', '--context', 'user', '--target', 'codex', '--yes', '--json'],
      { cwd, env, io: retry.io, interactive: false, nativeCliRunner: runtime.nativeCliRunner }), retry.readStdout()).toBe(0);
    expect(await fs.readFile(`${marker}.codex`, 'utf8')).toBe('ran');
  }, 30_000,
);
