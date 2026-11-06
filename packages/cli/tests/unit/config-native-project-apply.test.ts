import path from 'node:path';
import { execFileSync } from 'node:child_process';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { applyPluginConfig, applyPluginConfigWrite } from '../../src/utils/plugin-config-write.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { executeRecovery, executeRecoveryPreApply, prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';

async function fixture(options: { preApply?: boolean; platform?: 'codex' | 'claude' } = {}) {
  const platform = options.platform ?? 'claude';
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  execFileSync('git', ['init', '-q'], { cwd });
  const sourceRoot = path.join(cwd, 'native-source');
  const pluginRoot = path.join(sourceRoot, 'plugins/demo');
  const trace = path.join(cwd, 'native-pre-apply.jsonl');
  const fail = path.join(cwd, 'fail-native-pre-apply');
  if (options.preApply) await fs.outputFile(path.join(pluginRoot, 'pre-apply.mjs'), [
    "import fs from 'node:fs';",
    'const c=JSON.parse(fs.readFileSync(0,"utf8"));',
    `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(c)+"\\n");`,
    `if(fs.existsSync(${JSON.stringify(fail)}))process.exit(23);`,
  ].join('\n'));
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
    "import fs from 'node:fs';",
    'const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
    'if(c.scope!=="user"||c.config.targetScope!=="user"||process.cwd()!==c.plugin.rootDir)throw new Error("Native rendering must use the shared user context");',
    'const files={"SKILL.md":"---\\nname: native-skill\\ndescription: Native config test\\n---\\n# "+c.config.values.mode+"\\n","README.md":"# Native config\\n"};',
    'if(c.platform==="codex")files["agents/openai.yaml"]="policy:\\n  allow_implicit_invocation: true\\n";',
    'console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:c.platform+".skill",kind:"skill",platform:c.platform,state:"present",skillKey:"native-skill",refreshKeys:["mode"],content:{files}}))}));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Native project apply fixture\n', (manifest) => {
    manifest.platforms = [platform];
    manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common-default' } },
      platforms: { [platform]: { fields: { mode: { type: 'string', default: `${platform}-default` } } } } };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } },
      ...(options.preApply ? { preApply: { path: './pre-apply.mjs' } } : {}) };
    manifest.artifacts = { targets: [{ id: 'native-skill', platform, target: platform === 'codex' ? 'codex.skill' : 'claude.skill',
      scopes: ['user', 'project'], states: ['present'], refreshKeys: ['mode'], skillKey: 'native-skill',
      runtimeConfig: { keys: ['mode'] } }] };
  });
  const configured = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: configured.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const operation = await resolveCatalogOperationContext({ sourceIds: ['team'], env });
  const source = operation.catalog.sources[0]!.resolution!;
  const plugin = { ...await readPluginManifest(path.join(source.rootDir, 'plugins/demo'), { mode: 'bundle' }),
    sourceId: 'team', sourceIdentity: source.sourceIdentity, catalogLogicalIdentity: source.logicalIdentity, pluginId: 'team/demo' };
  const store = { pluginName: 'demo', sourceId: 'team', sourceIdentity: source.sourceIdentity,
    scope: 'user' as const, cwd, env };
  await writePluginConfigStore({ ...store, values: { mode: 'common-saved' } });
  await writePluginConfigStore({ ...store, platform, values: { mode: 'native-before' } });
  const codex = platform === 'codex' ? await createCodexNativeTestRuntime(isolation) : undefined;
  const native = codex ? { nativeCliRunner: codex.nativeCliRunner, installedPath: path.join(env.CODEX_HOME!, 'config.toml'),
    runtime: { env, nativeCliRunner: codex.nativeCliRunner } } : await createClaudeNativeTestRuntime(isolation);
  await setTargets({ cwd, env, scope: 'user' }, [platform]);
  const installed = await runRecovery('install', ['team/demo'],
    { cwd, env, cliVersion: '1.0.0', scope: 'project', context: 'project', yes: true }, native.runtime);
  expect(installed.ok, JSON.stringify(installed)).toBe(true);
  expect(installed.targetResults, JSON.stringify(installed)).toContainEqual(expect.objectContaining({ agent: platform, execution: 'applied' }));
  const skill = path.join(env.AW_HOME!, `marketplaces/team/plugins/demo/${platform}/skills/native-skill/SKILL.md`);
  expect(await fs.readFile(skill, 'utf8')).toContain('# native-before');
  return { cwd, env, plugin, store, native, skill, trace, fail };
}

// Test Value Gate: real recovery, native activation and rendered package outputs
// prove that the reading context never becomes a project value layer.
describe('Native project activation and user configuration', () => {
  // Test Value Gate: a hook used before provider cleanup must share the normal Native execution cache,
  // preserve its platform/scope inputs, and fail before any output mutation.
  it('runs the Native preApply gate before output changes and reuses the actual execution once', async () => {
    const f = await fixture({ preApply: true });
    await fs.writeFile(f.trace, '');
    const before = await fs.readFile(f.skill);
    const options = { cwd: f.cwd, env: f.env, context: 'project' as const, targets: ['claude'], cliVersion: '1.0.0' };
    const plan = await prepareRecovery('sync', ['team/demo'], options, f.native.runtime);
    const result = await withAwHomeMutationLock({ env: f.env, action: async (token) => {
      const runtime = { ...f.native.runtime, awHomeMutationToken: token,
        preApplyConfirmed: true, preApplyExecutionCache: new Map<string, Promise<void>>() };
      const child = plan.joint!.children.find((entry) => entry.options.scope === 'project')!;
      expect(await executeRecoveryPreApply(child, 'team/demo', 'claude', runtime)).toBeUndefined();
      expect(await fs.readFile(f.skill)).toEqual(before);
      return executeRecovery(plan, { yes: true, runtime });
    } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const events = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({
      target: { platform: 'claude', scope: 'project', projectRoot: f.cwd },
      config: { values: { mode: 'native-before' } },
    })]);
    await fs.outputFile(f.fail, 'fail hook');
    const failed = await prepareRecovery('sync', ['team/demo'], options, f.native.runtime);
    try {
      const installed = await fs.readFile(f.native.installedPath);
      const child = failed.joint!.children.find((entry) => entry.options.scope === 'project')!;
      expect(await withAwHomeMutationLock({ env: f.env, action: (token) => executeRecoveryPreApply(child, 'team/demo', 'claude', {
        ...f.native.runtime, awHomeMutationToken: token, preApplyConfirmed: true,
      }) })).toBe('preApplyExited');
      expect(await fs.readFile(f.native.installedPath)).toEqual(installed);
      expect(await fs.readFile(f.skill)).toEqual(before);
    } finally { await failed.context.dispose(); }
  }, 30_000);

  // Test Value Gate: a replacement's script must succeed before the old scope is cleaned up.
  // A failed switch retains the working Native activation; a fresh retry executes the script once.
  it.each(['codex', 'claude'] as const)('preserves the %s project provider on failed user-scope preApply, then switches once', async (platform) => {
    const f = await fixture({ preApply: true, platform });
    const projectFile = path.join(f.cwd, platform === 'codex' ? '.codex/config.toml' : '.claude/settings.json');
    const before = { project: await fs.readFile(projectFile), native: await fs.readFile(f.native.installedPath),
      skill: await fs.readFile(f.skill) };
    await fs.writeFile(f.trace, '');
    await fs.outputFile(f.fail, 'fail new provider');
    const options = { cwd: f.cwd, env: f.env, cliVersion: '1.0.0', context: 'project' as const, yes: true };
    const blocked = await runRecovery('install', ['team/demo'], { ...options, scope: 'user' }, f.native.runtime);
    expect(blocked.ok).toBe(false);
    expect(blocked.targetResults).toContainEqual(expect.objectContaining({ agent: platform, scope: 'user', execution: 'failed',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'preApplyFailed' })]),
      backend: expect.objectContaining({ targetResults: expect.arrayContaining([expect.objectContaining({
        target: expect.objectContaining({ platform, scope: 'user' }), cleanupAttempted: false,
        failures: expect.arrayContaining([expect.objectContaining({
          operationDiagnostic: expect.objectContaining({ code: 'preApplyExited', exitCode: 23 }),
        })]),
      })]) }),
    }));
    expect(await fs.readFile(projectFile)).toEqual(before.project);
    expect(await fs.readFile(f.native.installedPath)).toEqual(before.native);
    expect(await fs.readFile(f.skill)).toEqual(before.skill);
    const failedEvents = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(failedEvents).toEqual([expect.objectContaining({ target: { platform, scope: 'user' } })]);
    await fs.remove(f.fail);
    await fs.writeFile(f.trace, '');
    const retried = await runRecovery('sync', ['team/demo'], { ...options, targets: [platform] }, f.native.runtime);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    const events = (await fs.readFile(f.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toEqual([expect.objectContaining({ target: { platform, scope: 'user' } })]);
    if (platform === 'codex') {
      const user = await readCodexConfigFile(f.native.installedPath);
      expect(Object.values(user.snapshot.plugins).some((plugin) => plugin.enabled)).toBe(true);
    } else {
      const records = Object.values((await fs.readJson(f.native.installedPath)).plugins).flat() as Array<{ scope: string }>;
      expect(records.map((record) => record.scope)).toContain('user');
    }
  }, 30_000);

  it.each(['user', 'project'] as const)('saves in %s context and refreshes only that context before an explicit project retry', async (context) => {
    const f = await fixture();
    const apply = { plugin: f.plugin, scope: 'user' as const, context, platform: 'claude' as const,
      cwd: f.cwd, env: f.env, cliVersion: '1.0.0', nativeCliRunner: f.native.nativeCliRunner,
      sharedNativeApplyConfirmed: true, preApplyConfirmed: true, rebuildRuntime: f.native.runtime };
    const saved = await applyPluginConfigWrite({ ...apply, apply: true, request: { updates: { mode: 'native-next' } } });
    expect(saved.configWrite).toBe('succeeded');
    if (context === 'user') {
      expect(saved.apply).toMatchObject({ state: 'skipped', reason: 'noVisibleTarget' });
      expect(await fs.readFile(f.skill, 'utf8')).toContain('# native-before');
    } else {
      expect(saved.apply, JSON.stringify(saved)).toMatchObject({ state: 'succeeded',
        targetResults: [expect.objectContaining({ target: expect.objectContaining({ platform: 'claude', scope: 'project' }), state: 'completed' })] });
      expect(await fs.readFile(f.skill, 'utf8')).toContain('# native-next');
    }
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file, 'utf8');
    const stat = await fs.stat(file);
    const retried = await applyPluginConfig({ ...apply, context: 'project' });
    expect(retried, JSON.stringify(retried)).toMatchObject({ configWrite: 'notStarted', overallState: 'succeeded' });
    expect(await fs.readFile(f.skill, 'utf8')).toContain('# native-next');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await fs.stat(file)).mtimeMs).toBe(stat.mtimeMs);
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows/plugin-config'))).toBe(false);
    for (const root of [path.join(f.cwd, '.claude/skills'), path.join(f.cwd, '.agents/skills')]) {
      expect(await fs.pathExists(path.join(root, 'native-skill'))).toBe(false);
    }
    const records = Object.values((await fs.readJson(f.native.installedPath)).plugins).flat() as Array<{ scope: string }>;
    expect(records.map((record) => record.scope)).toEqual(['project']);
  }, 30_000);
});
