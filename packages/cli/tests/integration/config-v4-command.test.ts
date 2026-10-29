import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { replaceCatalogSourcesConfig, readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { createConfigV4Definition } from '../helpers/config-v4-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { listManagedCommandPackages, listManagedCommands, resolveManagedCommand } from '../../src/utils/managed-command-store.js';

describe('Config Definition v4 public command', () => {
  // Test Value Gate: the shared native payload uses user config even when its only native installation is project scoped.
  it('applies user config to shared Claude static commands without changing native installation scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const authoringRoot = path.join(cwd, 'claude-static-authoring');
    const pluginRoot = path.join(authoringRoot, 'plugins/demo');
    const capture = path.join(cwd, 'claude-static-run.json');
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Shared Claude fixture.\n---\n{{aw.command:tools/run}} check\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/README.md'), '# Provider\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/tool.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(process.argv.slice(2)));\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',platform:'claude',state:'present',refreshKeys:['mode'],entries:[{key:'run',runner:'node',entry:'tool.mjs',args:[c.config.values.mode]}]}))}));",
    ].join('\n'));
    await createCatalogSnapshotFixture(authoringRoot, 'demo', [], 'Shared native config fixture\n', (manifest) => {
      manifest.marketplace.policy.products = ['CLAUDE'];
      manifest.skills = './skills';
      manifest.config = { schemaVersion: 4, fields: { mode: { type: 'string', default: 'default' } } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.managedCommands = { packages: [], sets: [{ set: 'tools', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'provider' }, mode: 'dynamic', refreshKeys: ['mode'] }] };
      manifest.extensions = { permissions: [{ name: 'run', allow: [{ command: { set: 'tools', key: 'run', variant: 'default' }, argsPrefix: ['check'] }] }] };
    });
    await fs.copy(path.resolve(import.meta.dirname, '../../../../plugins/marketplace-source.json'), path.join(authoringRoot, 'plugins/marketplace-source.json'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    try {
      await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), { schemaVersion: 1, kind: 'catalog',
        workspaceIdentity: `fixture:${crypto.createHash('sha256').update(sourceRoot).digest('hex')}`,
        sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${sourceRoot}`).digest('hex')}` });
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const native = await createClaudeNativeTestRuntime(isolation);
      const run = async (args: string[]) => {
        const output = createCapturedCliIo();
        const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: native.nativeCliRunner });
        return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
      };
      const set = (scope: string, mode: string, apply = false) => run(['config', 'set', 'team/demo', 'mode', '--scope', scope, '--value-json', JSON.stringify(mode), ...(apply ? ['--apply', '--yes'] : [])]);
      expect(await set('user', 'personal')).toMatchObject({ exitCode: 0 });
      expect(await set('project', 'project')).toMatchObject({ exitCode: 0 });
      const installed = await run(['install', 'team/demo', '--platform', 'claude', '--scope', 'project']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
      const command = (await listManagedCommands(env)).commands[0]!;
      expect(command.owner).toMatchObject({ kind: 'plugin', producer: { platform: 'claude', scope: 'user', projectRoot: null } });
      expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['personal']);
      expect(await set('project', 'project-next', true)).toMatchObject({ exitCode: 0, payload: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'noEffectiveConfigChange' } } });
      expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['personal']);
      expect(await set('user', 'saved')).toMatchObject({ exitCode: 0, payload: { apply: { reason: 'notRequested' } } });
      expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['personal']);
      const applied = await set('user', 'applied', true);
      expect(applied, JSON.stringify(applied)).toMatchObject({ exitCode: 0, stderr: '', payload: { apply: { state: 'succeeded', targetResults: [{ target: { platform: 'claude', scope: 'project' }, state: 'completed' }] } } });
      expect((await listManagedCommands(env)).commands.map((entry) => entry.id)).toEqual([command.id]);
      expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['applied']);
      expect(await fs.readFile(path.join(command.resourceRoot!, 'SKILL.md'), 'utf8')).toContain(`aw command run ${command.id} -- check`);
      const settings = await fs.readJson(path.join(cwd, '.claude/settings.json'));
      expect(settings.permissions.allow).toContain(`Bash(aw command run ${command.id} -- check *)`);
      const installs = native.nativeCliRunner.mock.calls.map(([invocation]) => invocation.args).filter((args) => args[0] === 'plugin' && args[1] === 'install');
      expect(installs.length).toBeGreaterThan(0);
      expect(installs.every((args) => args[args.indexOf('--scope') + 1] === 'project')).toBe(true);
      const output = createCapturedCliIo();
      expect(await runSafeCli(['command', 'run', command.id, '--', 'check'], { cwd, env: { ...env, CAPTURE_FILE: capture }, io: output.io, interactive: false, nativeCliRunner: native.nativeCliRunner })).toBe(0);
      expect(await fs.readJson(capture)).toEqual(['applied', 'check']);
    } finally { await fs.remove(sourceRoot); }
  });
  // Test Value Gate: only public config apply may change installed command launch values; Skill and permission consumers must retain the same ID.
  it('refreshes an artifact command set when only its own refreshKeys depend on the changed config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'set-impact-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/demo');
    const files = {
      'SKILL.md': '---\nname: provider\ndescription: Config command fixture.\n---\n{{aw.command:tools/run}} check\n',
      'README.md': '# Provider\n', 'scripts/tool.mjs': 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n',
      'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: true\n',
    };
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `const files=${JSON.stringify(files)};`,
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>id==='provider'?",
      "{id,target:'codex.skill',kind:'skill',platform:'codex',state:'present',skillKey:'provider',refreshKeys:[],content:{files}}:",
      "{id,target:'aw.command-set',kind:'commandSet',platform:'codex',state:'present',refreshKeys:['mode'],entries:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values.mode]}]})}));",
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Set impact fixture\n', (manifest) => {
      manifest.config = { schemaVersion: 4, fields: { mode: { type: 'string', default: 'old' } } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.artifacts = { targets: [{ id: 'provider', platform: 'codex', target: 'codex.skill',
        delivery: { mode: 'aw-extension' }, scopes: ['user'], states: ['present'], refreshKeys: [], skillKey: 'provider' }] };
      manifest.managedCommands = { packages: [], sets: [{ set: 'tools', producer: { kind: 'artifact', artifactId: 'provider' }, mode: 'dynamic', refreshKeys: ['mode'] }] };
      manifest.extensions = { permissions: [{ name: 'run', allow: [{ command: { set: 'tools', key: 'run', variant: 'default' }, argsPrefix: ['check'] }] }] };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => ({ exitCode: 0,
      stdout: invocation.args.includes('--version') ? 'codex-cli 0.200.0' : '{"installed":[],"available":[]}', stderr: '' }));
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner });
      return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
    };
    const installed = await run(['install', 'team/demo', '--platform', 'codex', '--scope', 'user']);
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    const command = (await listManagedCommands(env)).commands[0]!;
    expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['old']);
    const skillPath = path.join(env.AW_CODEX_HOME!, 'skills/provider/SKILL.md');
    const rulePath = path.join(env.AW_CODEX_HOME!, 'rules/aw-demo-run.rules');
    const rule = await fs.readFile(rulePath, 'utf8');
    expect(rule).toContain(JSON.stringify(['aw', 'command', 'run', command.id, '--', 'check']));
    expect(await fs.readFile(skillPath, 'utf8')).toContain(`aw command run ${command.id} -- check`);
    expect(await run(['config', 'set', 'team/demo', 'mode', '--scope', 'user', '--value-json', '"saved"']))
      .toMatchObject({ exitCode: 0, payload: { apply: { state: 'skipped', reason: 'notRequested' } } });
    expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['old']);
    expect(await run(['config', 'set', 'team/demo', 'mode', '--scope', 'user', '--value-json', '"applied"', '--apply', '--yes']))
      .toMatchObject({ exitCode: 0, stderr: '', payload: { configWrite: 'succeeded', apply: { state: 'succeeded', targetResults: [{ state: 'completed' }] } } });
    expect((await listManagedCommands(env)).commands.map((entry) => entry.id)).toEqual([command.id]);
    expect((await resolveManagedCommand(command.id, env)).launch.args).toEqual(['applied']);
    expect(await fs.readFile(skillPath, 'utf8')).toContain(`aw command run ${command.id} -- check`);
    expect(await fs.readFile(rulePath, 'utf8')).toBe(rule);
    const output = createCapturedCliIo();
    const capture = path.join(cwd, 'set-impact-run.json');
    expect(await runSafeCli(['command', 'run', command.id, '--', 'check'], { cwd, env: { ...env, CAPTURE_FILE: capture }, io: output.io, interactive: false, nativeCliRunner })).toBe(0);
    expect(await fs.readJson(capture)).toEqual(['applied', 'check']);
  });
  it('returns Config Mutation v7 command results for retained packages and preserves a committed config on discovery failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'command-package-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/demo');
    await fs.outputFile(path.join(pluginRoot, 'tools', 'tool.mjs'), 'process.exit(0);\n');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      "console.log(JSON.stringify({version:2,artifacts:context.requestedArtifactIds.map(id=>({id,target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:['mode'],files:{'config.json':JSON.stringify({mode:context.config.values.mode})}}))}));",
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Package fixture\n', (manifest) => {
      manifest.config = { schemaVersion: 4, fields: { mode: { type: 'string', default: 'safe' } } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.managedCommands = { packages: [{ key: 'tools', sourceDir: './tools', scope: 'user',
        platforms: ['codex', 'claude'], render: true, refreshKeys: ['mode'] }], sets: [] };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => ({ exitCode: 0,
      stdout: invocation.args.includes('--version') ? 'codex-cli 0.200.0' : '{"installed":[],"available":[]}', stderr: '' }));
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner });
      const stdout = output.readStdout();
      expect(stdout.endsWith('\n')).toBe(true);
      return { exitCode, payload: JSON.parse(stdout), stderr: output.readStderr() };
    };
    expect(await run(['command', 'package', 'sync', 'team/demo', 'tools', '--scope', 'user', '--yes']))
      .toMatchObject({ exitCode: 0, stderr: '', payload: { overallState: 'completed' } });
    expect(await run(['config', 'set', 'team/demo', 'mode', '--scope', 'user', '--value-json', '"fast"', '--apply', '--yes']))
      .toMatchObject({ exitCode: 0, stderr: '', payload: {
        receiptSchemaVersion: 7, ok: true, configWrite: 'succeeded', overallState: 'succeeded',
        apply: { state: 'succeeded', targetResults: [], commandResults: [{ state: 'completed', producer: { kind: 'package', key: 'tools', platform: null } }] },
      } });
    const installed = (await listManagedCommandPackages(env)).packages[0]!;
    expect(await fs.readJson(path.join(installed.resourceRoot, 'config.json'))).toEqual({ mode: 'fast' });
    await fs.writeFile(path.join(path.dirname(installed.resourceRoot), 'owner.json'), '{broken');
    expect(await run(['config', 'set', 'team/demo', 'mode', '--scope', 'user', '--value-json', '"next"', '--apply', '--yes']))
      .toMatchObject({ exitCode: 1, stderr: '', payload: {
        receiptSchemaVersion: 7, ok: false, configWrite: 'succeeded', overallState: 'partial',
        apply: { state: 'partial', targetResults: [], errors: [{ stage: 'targetDiscovery' }] },
      } });
    const store = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
    expect((await fs.readJson(store)).values.mode).toBe('next');
  });
  // Test Value Gate: public capability negotiation and config set must survive Catalog and installed-runtime boundaries.
  it('advertises v4, preserves raw values, rejects invalid candidates, and leaves installed runtime resources unchanged until sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'v4-command-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/demo');
    const hostSecret = 'host-reference-only-secret';
    const env = { ...isolation.env, HOST_TOKEN: hostSecret };
    const caller = "import {readRuntimeConfig} from './aw-runtime-config.mjs';\nconsole.log(JSON.stringify(await readRuntimeConfig({from:import.meta.url,keys:['advisorProfile','subagentCommands']})));\n";
    await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), [
      "import fs from 'node:fs';",
      "const context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `const files=${JSON.stringify({
        'SKILL.md': '---\nname: executor-tool\ndescription: Use an executor for a bounded task.\n---\n# Executor\n',
        'README.md': '# Executor runtime\n',
        'agents/openai.yaml': 'interface:\n  display_name: Executor\n  short_description: Use an executor for a bounded task.\n  default_prompt: Use the executor for this task.\npolicy:\n  allow_implicit_invocation: true\n',
        'scripts/caller.mjs': caller,
      })};`,
      "console.log(JSON.stringify({version:2,artifacts:context.requestedArtifactIds.map(id=>({id,kind:'skill',platform:'codex',target:'codex.skill',state:'present',refreshKeys:['advisorProfile','subagentCommands'],skillKey:'executor-tool',content:{files}}))}));",
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Executor fixture\n', (manifest) => {
      manifest.config = createConfigV4Definition();
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { targets: [{ id: 'executor-skill', platform: 'codex', scopes: ['user'], target: 'codex.skill',
        delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: ['advisorProfile', 'subagentCommands'],
        skillKey: 'executor-tool', runtimeConfig: { keys: ['advisorProfile', 'subagentCommands'] } }] };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => ({ exitCode: 0,
      stdout: invocation.args.includes('--version') ? 'codex-cli 0.200.0' : '{"installed":[],"available":[]}', stderr: '' }));
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner });
      return { exitCode, payload: JSON.parse(output.readStdout()) as Record<string, unknown>, stderr: output.readStderr() };
    };
    const describe = await run(['self', 'describe']);
    expect(describe).toMatchObject({ exitCode: 0, stderr: '', payload: { capabilities: expect.arrayContaining(['aw.plugin-config.v4']) } });
    expect(await run(['self', 'check', '--from', pluginRoot])).toMatchObject({ exitCode: 0, stderr: '',
      payload: { ok: true, requiredCapabilities: expect.arrayContaining(['aw.plugin-config.v4']), missingCapabilities: [] } });
    const oldCommands = [{ key: 'remote', title: 'Original', adapter: 'codex', args: ['', '--old'], envFrom: { TOKEN: 'HOST_TOKEN' } }];
    const set = (field: string, value: unknown) => run(['config', 'set', 'team/demo', field, '--scope', 'user', '--value-json', JSON.stringify(value)]);
    expect(await set('subagentCommands', oldCommands)).toMatchObject({ exitCode: 0, stderr: '', payload: { configWrite: 'succeeded' } });
    expect(await set('advisorProfile', { executor: 'remote' })).toMatchObject({ exitCode: 0, payload: { configWrite: 'succeeded' } });
    expect(await run(['install', 'team/demo', '--platform', 'codex', '--scope', 'user'])).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    const skillRoot = path.join(env.AW_CODEX_HOME!, 'skills/executor-tool');
    const bindingFile = path.join(skillRoot, '.aw-runtime-config.json');
    const originalBinding = await fs.readFile(bindingFile);
    const readRuntime = () => JSON.parse(execFileSync(process.execPath, [path.join(skillRoot, 'scripts/caller.mjs')], { env, encoding: 'utf8' }));
    expect(readRuntime().effectiveValues).toEqual({ advisorProfile: { executor: 'remote' }, subagentCommands: oldCommands });

    const commands = [{ key: 'remote', title: 'Updated', adapter: 'oracle', args: [], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' } }];
    expect(await set('subagentCommands', commands)).toMatchObject({ exitCode: 0, stderr: '',
      payload: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'notRequested' } } });
    const storeFile = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env });
    const saved = await fs.readFile(storeFile);
    expect(JSON.parse(saved.toString()).values).toEqual({ advisorProfile: { executor: 'remote' }, subagentCommands: commands });
    expect(saved.toString()).not.toContain(hostSecret);
    expect(originalBinding.toString()).not.toContain(hostSecret);
    expect(await fs.readFile(bindingFile)).toEqual(originalBinding);
    expect(readRuntime().effectiveValues.subagentCommands).toEqual(oldCommands);

    expect(await set('subagentCommands', [{ ...commands[0], command: process.execPath }])).toMatchObject({ exitCode: 1,
      payload: { configWrite: 'notStarted', errors: [expect.objectContaining({ message: expect.stringContaining('command') })] } });
    expect(await fs.readFile(storeFile)).toEqual(saved);
    expect(await fs.readFile(bindingFile)).toEqual(originalBinding);
    expect(await run(['sync', 'team/demo', '--platform', 'codex', '--scope', 'user'])).toMatchObject({ exitCode: 0,
      payload: { overallState: 'succeeded' } });
    expect(readRuntime().effectiveValues).toEqual({ advisorProfile: { executor: 'remote' }, subagentCommands: commands });
  });
});
