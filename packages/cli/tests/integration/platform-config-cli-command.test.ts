import path from 'node:path';
import { Readable } from 'node:stream';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import type { CommandResult } from '../../src/output/public-result.js';
import * as platformDiscovery from '../../src/platforms/discovery.js';
import { geminiActivationRules, geminiPathEnabled, geminiScopePattern, readGeminiActivationSnapshot } from '../../src/platforms/gemini-activation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { renderNpmCmdShim } from '../../src/utils/windows-npm-shim.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo, runCliEntry } from '../helpers/cli-entry.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const discoverPlatforms = platformDiscovery.discoverPlatforms;

async function fixture(withSkill = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  await git(cwd, ['init', '--quiet']);
  let nativeCliRunner: NativeCliRunner | undefined;
  if (withSkill) {
    const discovery = vi.spyOn(platformDiscovery, 'discoverPlatforms').mockImplementation((ctx) => discoverPlatforms({
      ...ctx, macApplicationsDirectories: [], windowsApplicationsDirectories: [], linuxDesktopDirectories: [],
    }));
    onTestFinished(() => discovery.mockRestore());
    const binRoot = path.join(cwd, 'cursor-bin');
    const executable = path.join(binRoot, 'cursor-agent');
    await fs.outputFile(executable, '', { mode: 0o755 });
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = binRoot;
    nativeCliRunner = async (invocation) => {
      if (invocation.command === executable && invocation.args.length === 1 && invocation.args[0] === '--version') {
        return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      }
      throw new Error('The Cursor configuration fixture only permits a version probe.');
    };
  }
  const sourceRoot = path.join(cwd, 'config-source');
  if (withSkill) await fs.outputFile(path.join(sourceRoot, 'plugins/demo/render.mjs'), [
    'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
    `const files=${JSON.stringify({ 'SKILL.md': '---\nname: config-demo\ndescription: Config apply fixture.\n---\nFixture.\n', 'README.md': '# Config fixture\n' })};`,
    'const allowed=c.allowedOutputKinds.includes("skill");const enabled=c.config.values.enabled;',
    'console.log(JSON.stringify({version:3,components:allowed&&enabled?[{id:"config-demo",kind:"skill",name:"config-demo",content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:allowed&&!enabled?[{id:"config-demo",kind:"skill",reason:"config-disabled"}]:[],unmet:[]}));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], '# Config fixture\n', (manifest) => {
    manifest.platforms = ['cursor', 'generic'];
    if (withSkill) {
      manifest.artifacts = { configKeys: ['enabled'], scopes: ['project'] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    }
    manifest.config = { schemaVersion: 5, fields: {
      mode: { type: 'string', default: 'common-default', choices: { allowCustom: true,
        presets: [{ id: 'fast', title: 'Common fast', value: 'common-fast' }] } },
      enabled: { type: 'boolean', default: true },
      token: { type: 'string', sensitive: true },
    }, platforms: { cursor: { fields: {
      mode: { type: 'string', default: 'cursor-default', choices: { allowCustom: true,
        presets: [{ id: 'fast', title: 'Cursor fast', value: 'cursor-fast' }] } },
      cursorOnly: { type: 'number', default: 1 },
    } } } };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const file = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
  const run = async (args: string[], input?: string | Buffer[]) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], {
      cwd, env, interactive: false, io: captured.io, nativeCliRunner,
      ...(input === undefined ? {} : { stdin: Readable.from(typeof input === 'string' ? [input] : input) })
    });
    return { exitCode, value: JSON.parse(captured.readStdout()), stdout: captured.readStdout(), stderr: captured.readStderr() };
  };
  return { cwd, env, file, run };
}

async function geminiConfigFixture() {
  const { env: isolatedEnv, layout } = getCurrentSourceTestIsolation();
  const cwd = await fs.realpath(layout.fixtureCwd);
  const bin = path.join(cwd, 'gemini-bin');
  const geminiHome = path.join(cwd, 'Gemini config');
  const env = { ...isolatedEnv, PATH: bin, GEMINI_CLI_HOME: geminiHome };
  const packageRoot = path.join(bin, 'node_modules/@google/gemini-cli');
  const executable = path.join(packageRoot, 'bundle/gemini.js');
  let version = '0.67.0';
  const selectVersion = async (selected: string) => {
    version = selected;
    await fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@google/gemini-cli', version, bin: { gemini: 'bundle/gemini.js' },
    });
  };
  await git(cwd, ['init', '--quiet']);
  await fs.outputFile(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
  await selectVersion(version);
  if (process.platform === 'win32') await fs.outputFile(path.join(bin, 'gemini.cmd'),
    renderNpmCmdShim('node_modules\\@google\\gemini-cli\\bundle\\gemini.js'));
  else await fs.symlink(executable, path.join(bin, 'gemini'));
  installNativeTestQualification({ platforms: ['gemini'] });

  const sourceRoot = path.join(cwd, 'gemini-config-source');
  await fs.outputFile(path.join(sourceRoot, 'plugins/demo/render.mjs'), [
    'import fs from "node:fs";',
    'const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
    'const text="---\\nname: configured\\ndescription: Gemini config fixture.\\n---\\nMode: "+c.config.values.mode+"\\n";',
    'console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes("skill")?[{id:"configured",kind:"skill",name:"configured",content:{files:{"SKILL.md":{text},"README.md":{text:"Gemini config fixture.\\n"}}}}]:[],omitted:[],unmet:[]}));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Gemini config fixture\n', (manifest) => {
    manifest.platforms = ['gemini', 'generic'];
    manifest.artifacts = { configKeys: ['mode'], scopes: ['user', 'project'] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'original' } } };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });

  const extensions = path.join(geminiHome, '.gemini', 'extensions');
  const installed = path.join(extensions, 'demo');
  const activation = path.join(extensions, 'extension-enablement.json');
  const nativeChanges: Array<{ verb: string; cwd: string | undefined }> = [];
  const installSource = async (source: string) => {
    await fs.copy(source, installed);
    await fs.outputJson(path.join(installed, '.gemini-extension-install.json'), { type: 'local', source });
  };
  const nativeCliRunner: NativeCliRunner = async (invocation) => {
    const args = invocation.args[0] === await fs.realpath(executable) ? invocation.args.slice(1) : invocation.args;
    if (args[0] === '--version') return { exitCode: 0, stdout: version, stderr: '' };
    expect(args[0]).toBe('extensions');
    if (args[1] === 'list') {
      const manifest = await fs.readJson(path.join(installed, 'gemini-extension.json')).catch(() => null);
      const workspace = invocation.cwd ?? cwd;
      const rules = geminiActivationRules(await readGeminiActivationSnapshot({ cwd: workspace, env }), 'demo');
      return { exitCode: 0, stdout: '', stderr: JSON.stringify(manifest ? [{ name: 'demo', version: manifest.version,
        path: installed, isActive: geminiPathEnabled(rules, workspace) }] : []) };
    }
    nativeChanges.push({ verb: args[1]!, cwd: invocation.cwd });
    expect(version).toBe('0.67.0');
    const rules = await fs.readJson(activation).catch(() => ({})) as Record<string, { overrides: string[] }>;
    if (args[1] === 'uninstall') {
      expect(args).toEqual(['extensions', 'uninstall', 'demo']);
      await fs.remove(installed);
      delete rules.demo;
    } else {
      expect(args.slice(0, 2)).toEqual(['extensions', 'install']);
      expect(args.slice(3)).toEqual(['--consent', '--skip-settings']);
      await installSource(args[2]!);
      const homeRule = geminiScopePattern(geminiHome);
      const outsideHome = (rules.demo?.overrides ?? []).filter((rule) => !rule.replace(/^!/u, '').startsWith(homeRule.slice(0, -1)));
      rules.demo = { overrides: [...outsideHome, homeRule] };
    }
    await fs.outputFile(activation, JSON.stringify(rules, null, 2));
    return { exitCode: 0, stdout: 'Native fixture output.', stderr: '' };
  };
  const run = (args: string[], json = true) => runCliEntry([...args, '--yes', ...(json ? ['--json'] : [])], { cwd, env, nativeCliRunner });
  const config = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
  return { cwd, run, selectVersion, installSource, installed, activation, config, nativeChanges };
}

// Test Value Gate: exercise argv, platform schema selection, the real atomic document, and save/apply receipts.
describe('platform configuration CLI', () => {
  beforeEach(() => { installNativeTestQualification({ platforms: ['cursor'], discovery: true }); });
  it('uses common by default, compiles platform presets, and keeps project context in the user store', async () => {
    const f = await fixture();
    const initial = await f.run(['plugin', 'config', 'get', 'team/demo', 'mode']);
    expect(initial).toMatchObject({
      exitCode: 0, value: {
        schemaVersion: 2,
        data: {
          platform: 'common',
          context: { context: 'user' },
          fields: [{ effectiveValue: 'common-default', sourceLayer: 'default' }]
        }
      }
    });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'fast']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: {
            configWrite: 'succeeded',
            apply: { reason: 'notRequested' }
          }
        }
      });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'cursor', '--context', 'project', '--preset', 'fast']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: {
            context: { context: 'project', projectRoot: f.cwd },
            platform: 'cursor'
          }
        }
      });
    expect(await fs.readJson(f.file)).toMatchObject({ schemaVersion: 6, common: { mode: 'common-fast' }, platforms: { cursor: { mode: 'cursor-fast' } } });
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows', 'plugin-config'))).toBe(false);
    expect(await f.run(['plugin', 'config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { fields: [{ effectiveValue: 'cursor-fast', sourceLayer: 'platform' }] }
        }
      });
    expect(await f.run(['plugin', 'config', 'unset', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { configWrite: 'succeeded' }
        }
      });
    expect(await f.run(['plugin', 'config', 'get', 'team/demo', 'mode', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { fields: [{ effectiveValue: 'common-fast', sourceLayer: 'common' }] }
        }
      });
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'cursorOnly', '--platform', 'cursor', '--value-json', '0']))
      .toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'config', 'schema', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: {
            configSchemaVersion: 5,
            schema: { platform: 'cursor' },
            fields: { mode: { default: 'cursor-default' }, cursorOnly: { default: 1 }, enabled: { default: true } }
          }
        }
      });
    const resetBefore = await fs.readFile(f.file);
    expect(await f.run(['plugin', 'config', 'reset', 'team/demo', '--platform', 'cursor']))
      .toMatchObject({
        exitCode: 3, value: {
          command: 'plugin.config.reset', status: 'blocked',
          data: {
            confirmation: {
              required: true, provided: false, effects: [expect.objectContaining({
                code: 'deletePluginConfig', impact: 'user-wide', subject: { pluginId: 'team/demo', scope: 'user' },
              })]
            }
          },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
        }
      });
    expect(await fs.readFile(f.file)).toEqual(resetBefore);
    expect(await f.run(['plugin', 'config', 'reset', 'team/demo', '--platform', 'cursor', '--yes']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { configWrite: 'succeeded', confirmation: { required: true, provided: true } }
        }
      });
    expect((await fs.readJson(f.file)).common).toEqual({ mode: 'common-fast' });
    expect((await fs.readJson(f.file)).platforms).toEqual({});
  });

  it.each([
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--scope', 'project', '--value-json', '"bad"'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"bad"', '--apply-scope', 'project'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'claude-code', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--platform', 'agent-skills', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'unknown', '--value-json', '"bad"'], code: 'invalidOptionValue' },
    { args: ['plugin', 'config', 'apply', 'team/demo', '--scope', 'user'], code: 'invalidArguments' },
    { args: ['plugin', 'config', 'apply', 'team/demo', '--target', 'unknown'], code: 'invalidArguments' },
  ])('rejects invalid arguments before changing the common document: $args', async ({ args, code }) => {
    const f = await fixture();
    expect(await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"saved"'])).toMatchObject({ exitCode: 0 });
    const before = await fs.readFile(f.file);
    const result = await f.run(args);
    expect(result).toMatchObject({
      exitCode: 2, value: {
        schemaVersion: 2,
        command: `plugin.config.${args[2]}`,
        status: 'failed',
        diagnostics: [{ code }],
        data: {}
      }
    });
    expect(result.value.data).toEqual({});
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it('keeps exact sensitive stdin bytes and rejects sensitive argv from a project context', async () => {
    const f = await fixture();
    const secret = ' \t密钥 café 🔑\r\nline-two\n';
    const bytes = Buffer.from(secret, 'utf8');
    const chunks = [bytes.subarray(0, 3), bytes.subarray(3, 14), bytes.subarray(14)];
    const rejected = await f.run(['plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', '--value-json', JSON.stringify(secret)]);
    expect(rejected).toMatchObject({
      exitCode: 2, value: {
        schemaVersion: 2,
        command: 'plugin.config.set',
        status: 'failed',
        diagnostics: [{ code: 'sensitiveConfigInputUnsupported' }],
        data: {}
      }
    });
    expect(rejected.value.data).toEqual({});
    expect(rejected.stdout + rejected.stderr).not.toContain('密钥');
    expect(rejected.stdout + rejected.stderr).not.toContain('line-two');
    expect(await fs.pathExists(f.file)).toBe(false);
    const saved = await f.run(['plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', '--value-stdin'], chunks);
    expect(saved).toMatchObject({
      exitCode: 0, value: {
        schemaVersion: 2,
        data: { configWrite: 'succeeded' }
      }
    });
    expect(saved.stdout + saved.stderr).not.toContain('密钥');
    expect(saved.stdout + saved.stderr).not.toContain('line-two');
    expect(Buffer.from((await fs.readJson(f.file)).common.token, 'utf8')).toEqual(bytes);
    const read = await f.run(['plugin', 'config', 'get', 'team/demo', 'token']);
    expect(read.stdout + read.stderr).not.toContain('密钥');
    expect(read.stdout + read.stderr).not.toContain('line-two');
  });

  it('reports a committed save separately when joint application is blocked', async () => {
    const f = await fixture(true);
    expect(await f.run(['target', 'set', 'cursor'])).toMatchObject({ exitCode: 0 });
    expect(await f.run(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
      .toMatchObject({
        exitCode: 0, value: {
          schemaVersion: 2,
          data: { targetResults: [expect.objectContaining({ pluginId: 'team/demo', target: 'cursor', scope: 'project', execution: 'applied' })] }
        }
      });
    const packageRoot = path.join(f.cwd, '.cursor', 'aw-plugins', (await fs.readdir(path.join(f.cwd, '.cursor', 'aw-plugins')))[0]!);
    const output = path.join(packageRoot, 'skills', 'config-demo');
    await fs.remove(path.join(packageRoot, SKILL_OWNER_MARKER));
    const existing = await fs.readFile(path.join(output, 'SKILL.md'));
    const result = await f.run(['plugin', 'config', 'set', 'team/demo', 'enabled', '--context', 'project', '--value-json', 'false', '--apply', '--yes']);
    expect(result, JSON.stringify(result)).toMatchObject({
      exitCode: 4, value: {
        schemaVersion: 2,
        status: 'partial',
        data: {
          configWrite: 'succeeded',
          context: { context: 'project', projectRoot: f.cwd }
        }
      }
    });
    expect(result.value.data.apply.state).not.toBe('succeeded');
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
    expect(await fs.readFile(path.join(output, 'SKILL.md'))).toEqual(existing);
    expect(await fs.pathExists(path.join(packageRoot, SKILL_OWNER_MARKER))).toBe(false);
    const applied = await f.run(['plugin', 'config', 'apply', 'team/demo', '--context', 'project', '--target', 'cursor', '--yes']);
    expect(applied.value).toMatchObject({
      schemaVersion: 2,
      command: 'plugin.config.apply',
      data: { configWrite: 'notStarted' }
    });
    expect((await fs.readJson(f.file)).common.enabled).toBe(false);
  });

  it('keeps saved config and Gemini files while separating native consent from manual recovery', async () => {
    const f = await geminiConfigFixture();
    const assertSuccess = async (argv: string[]) => {
      const outcome = await f.run(argv);
      expect(outcome.exitCode, outcome.stdout + outcome.stderr).toBe(0);
    };
    const project = ['--context', 'project'];
    const rendered = path.join(f.installed, 'skills/configured/SKILL.md');
    await assertSuccess(['target', 'set', 'gemini', 'generic']);
    await assertSuccess(['plugin', 'install', 'team/demo', '--scope', 'project', ...project, '--native-consent']);
    expect(f.nativeChanges).toEqual([{ verb: 'install', cwd: f.cwd }]);
    const original = await fs.readFile(rendered, 'utf8');
    const previousRules = await fs.readJson(f.activation);
    await fs.writeJson(f.activation, { ...previousRules, other: { overrides: ['!*'] } });
    const rules = await fs.readFile(f.activation, 'utf8');

    const changed = await f.run(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"changed"', '--apply', ...project]);
    expect(changed.exitCode, changed.stdout + changed.stderr).toBe(4);
    const result = changed.parseJsonStdout<CommandResult>();
    expect(result).toMatchObject({ schemaVersion: 2, command: 'plugin.config.set', status: 'partial', data: {
      configWrite: 'succeeded', apply: { targetResults: expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ platform: 'generic', scope: 'project' }), state: 'completed' }),
        expect.objectContaining({ target: expect.objectContaining({ platform: 'gemini', scope: 'project' }), errorCode: 'nativeConsentRequired' }),
      ]) },
    } });
    await expect(fs.readJson(f.config)).resolves.toMatchObject({ common: { mode: 'changed' } });
    await expect(fs.readFile(rendered, 'utf8')).resolves.toBe(original);
    await expect(fs.readFile(f.activation, 'utf8')).resolves.toBe(rules);
    expect(f.nativeChanges).toHaveLength(1);
    const retry = ['aw', 'plugin', 'sync', 'team/demo', ...project, '--target', 'gemini'];
    expect(result.nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: [...retry, '--native-consent'] }));
    await assertSuccess([...retry.slice(1), '--native-consent']);
    await expect(fs.readFile(rendered, 'utf8')).resolves.toContain('Mode: changed');
    expect(await fs.readJson(f.activation)).toEqual(JSON.parse(rules));

    await assertSuccess(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"manual"', ...project]);
    const saved = await fs.readFile(f.config, 'utf8');
    const active = await fs.readFile(rendered, 'utf8');
    const activeRules = await fs.readFile(f.activation, 'utf8');
    const local = path.join(f.installed, '.env');
    await fs.writeFile(local, 'LOCAL_DATA=private-gemini-data\n');
    await f.selectVersion('0.68.0');
    const argv = ['plugin', 'config', 'apply', 'team/demo', ...project, '--native-consent'];
    const blocked = await f.run(argv);
    expect(blocked.exitCode, blocked.stdout + blocked.stderr).toBe(4);
    const recovery = blocked.parseJsonStdout<CommandResult>();
    expect(recovery).toMatchObject({ schemaVersion: 2, command: 'plugin.config.apply', status: 'partial', data: {
      configWrite: 'notStarted', apply: { targetResults: expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ platform: 'generic', scope: 'project' }), state: 'completed' }),
        expect.objectContaining({ target: expect.objectContaining({ platform: 'gemini', scope: 'project' }), errorCode: 'nativeConsentProtocolUnconfirmed' }),
      ]) },
    } });
    const subject = { pluginId: 'team/demo', scope: 'project', target: 'gemini' };
    const source = recovery.diagnostics.find((entry) => entry.code === 'nativeConsentProtocolUnconfirmed'
      && entry.subject?.field === 'nativeSource')?.detail?.path;
    expect(source).toBe((await fs.readJson(path.join(f.installed, '.gemini-extension-install.json'))).source);
    expect(recovery.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: { ...subject, sourceId: 'team', field: 'workspace' }, detail: expect.objectContaining({ path: f.cwd }) }),
      expect.objectContaining({ subject: { ...subject, sourceId: 'team', field: 'activationConfig' },
        detail: expect.objectContaining({ path: f.activation, configKey: 'demo' }) }),
    ]));
    const manual = recovery.nextActions.find((action) => action.kind === 'manual')?.message;
    expect(manual).toContain(JSON.stringify(source));
    expect(manual).toContain(JSON.stringify(f.cwd));
    expect(manual).toContain(JSON.stringify(f.activation));
    expect(manual).toContain(retry.join(' '));
    expect(recovery.nextActions.filter((action) => action.kind === 'command').map((action) => action.argv)).toEqual([retry]);
    const human = await f.run(argv, false);
    expect(human.exitCode).toBe(4);
    expect(human.stdout + human.stderr).toContain(manual);
    expect(blocked.stdout + blocked.stderr + human.stdout + human.stderr).not.toMatch(/private-gemini-data|Native fixture output\./u);
    await expect(fs.readFile(f.config, 'utf8')).resolves.toBe(saved);
    await expect(fs.readFile(rendered, 'utf8')).resolves.toBe(active);
    await expect(fs.readFile(local, 'utf8')).resolves.toBe('LOCAL_DATA=private-gemini-data\n');
    await expect(fs.readFile(f.activation, 'utf8')).resolves.toBe(activeRules);
    expect(f.nativeChanges.map((change) => change.verb)).toEqual(['install', 'uninstall', 'install']);

    const backup = path.join(f.cwd, 'Gemini backup');
    await fs.outputFile(path.join(backup, 'extension-enablement.json'), activeRules);
    await fs.move(f.installed, path.join(backup, 'demo'));
    await f.installSource(source!);
    await fs.copyFile(path.join(backup, 'extension-enablement.json'), f.activation);
    await assertSuccess(retry.slice(1));
    await expect(fs.readFile(rendered, 'utf8')).resolves.toContain('Mode: manual');
    await expect(fs.readFile(path.join(backup, 'demo', '.env'), 'utf8')).resolves.toBe('LOCAL_DATA=private-gemini-data\n');
    await expect(fs.readFile(f.activation, 'utf8')).resolves.toBe(activeRules);
    await expect(fs.readFile(f.config, 'utf8')).resolves.toBe(saved);

    // The retained active output is still eligible for config apply after its declaration is removed.
    await assertSuccess(['plugin', 'remove', 'team/demo', '--scope', 'project', ...project, '--only', 'requirements']);
    await assertSuccess(['plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"retained"', ...project]);
    await f.selectVersion('0.67.0');
    const retryExisting = ['aw', 'plugin', 'config', 'apply', 'team/demo', ...project, '--target', 'gemini'];
    const retained = await f.run(retryExisting.slice(1));
    expect(retained.exitCode, retained.stdout + retained.stderr).toBe(4);
    const retainedResult = retained.parseJsonStdout<CommandResult>();
    expect(retainedResult.nextActions).toEqual([
      expect.objectContaining({ kind: 'command', argv: [...retryExisting, '--native-consent'], requiresConfirmation: true }),
    ]);
    await assertSuccess([...retryExisting.slice(1), '--native-consent']);
    await expect(fs.readFile(rendered, 'utf8')).resolves.toContain('Mode: retained');
  }, 45_000);
});
