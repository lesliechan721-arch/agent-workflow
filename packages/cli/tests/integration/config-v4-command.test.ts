import { execFileSync } from 'node:child_process';
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

describe('Config Definition v4 public command', () => {
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
