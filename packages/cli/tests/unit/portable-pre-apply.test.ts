import path from 'node:path';

import { PORTABLE_PLATFORM_TARGETS, type PortablePlatformTarget } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { executeRecovery, executeRecoveryPreApply, prepareRecovery } from '../../src/recovery/coordinator.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { applyPluginConfig, preparePluginConfigApply, disposePluginConfigApply } from '../../src/utils/plugin-config-write.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const roots: Record<PortablePlatformTarget, string> = {
  antigravity: '.agents', cursor: '.cursor', opencode: '.opencode', pi: '.pi', generic: '.agents',
};

async function fixture(platforms: PortablePlatformTarget[], dependency = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  await git(cwd, ['init', '--quiet']);
  const sourceRoot = path.join(cwd, 'catalog');
  const trace = path.join(cwd, 'pre-apply.jsonl');
  const fail = path.join(cwd, 'fail-cursor');
  const names = dependency ? ['provider', 'consumer', 'independent'] : ['demo'];
  for (const name of names) {
    const root = path.join(sourceRoot, 'plugins', name);
    await fs.outputFile(path.join(root, 'scripts/pre-apply.mjs'), [
      "import fs from 'node:fs';",
      'const context=JSON.parse(fs.readFileSync(0,"utf8"));',
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(context)+"\\n");`,
      `if(fs.existsSync(${JSON.stringify(fail)})&&context.target.platform==='cursor'&&context.plugin.name!=="consumer"&&context.plugin.name!=="independent")process.exit(23);`,
    ].join('\n'));
    for (const platform of platforms) {
      await fs.outputFile(path.join(root, platform, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Portable hook fixture.\n---\nUse ${name}.\n`);
      await fs.outputFile(path.join(root, platform, 'skills', name, 'README.md'), `Use ${name}.\n`);
    }
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, names.map((name) => ({ name,
    ...(name === 'consumer' ? { dependencies: ['provider'] } : {}),
    configureManifest: (manifest) => {
      manifest.platforms = platforms;
      manifest.skills = './skills';
      delete manifest.extensions;
      manifest.scripts = { preApply: { path: './scripts/pre-apply.mjs' } };
      manifest.config = { schemaVersion: 5, fields: { value: { type: 'number', default: 7 } },
        platforms: Object.fromEntries(platforms.map((platform) => [platform, {
          fields: { value: { type: 'string', default: `default-${platform}` } },
        }])) };
    },
  })));
  const entries = [];
  for (const name of names) {
    const root = path.join(sourceRoot, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    for (const platform of platforms) await fs.outputJson(path.join(root, platform, 'skills', name, 'aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []));
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: entries.sort((left, right) => left.name.localeCompare(right.name)) });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const operation = await resolveCatalogOperationContext({ sourceIds: ['team'], env });
  const source = operation.catalog.sources[0]!.resolution!;
  const plugin = { ...await readPluginManifest(path.join(source.rootDir, 'plugins', names[0]!), { mode: 'bundle' }),
    sourceId: 'team', sourceIdentity: source.sourceIdentity, catalogLogicalIdentity: source.logicalIdentity,
    pluginId: `team/${names[0]}` };
  const store = { sourceId: 'team', sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
    pluginName: names[0]!, scope: 'user' as const, cwd, env };
  await setTargets({ cwd, env, scope: 'user' }, platforms);
  const run = async (args: string[]) => {
    const io = createCapturedCliIo();
    const exitCode = await runCli(['plugin', ...args, '--json'], { cwd, env, interactive: false, io: io.io });
    return { exitCode, value: JSON.parse(io.readStdout()) };
  };
  const output = (platform: PortablePlatformTarget, name = names[0]!) => path.join(cwd, roots[platform], 'skills', name);
  const events = async () => await fs.pathExists(trace)
    ? (await fs.readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { cwd, env, trace, fail, plugin, store, run, output, events };
}

describe('Portable preApply execution', () => {
  // Test Value Gate: each Portable target must use its compiled profile, require explicit script authorization,
  // and run the real process once after Review without allowing status to repeat it.
  it.each(PORTABLE_PLATFORM_TARGETS)('authorizes %s and runs its actual platform profile once', async (platform) => {
    const f = await fixture([platform]);
    await writePluginConfigStore({ ...f.store, values: { value: 7 } });
    await writePluginConfigStore({ ...f.store, platform, values: { value: `stored-${platform}` } });
    const rejected = await f.run(['install', 'team/demo', '--scope', 'project']);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.value).toMatchObject({ command: 'plugin.install', status: 'blocked', data: {
      confirmation: { required: true, provided: false, effects: [expect.objectContaining({ code: 'runPreApply' })] },
      changes: { requirements: 'none', outputs: 'none' },
    }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]) });
    expect(await fs.pathExists(f.output(platform))).toBe(false);
    expect(await f.events()).toEqual([]);
    const plan = await prepareRecovery('install', ['team/demo'], {
      scope: 'project', cwd: f.cwd, env: f.env, context: 'project', cliVersion: '1.0.0', targets: [platform],
    });
    expect(plan.changes).toContain(`运行插件 preApply 脚本：team/demo / ${platform} / project。`);
    expect(plan.joint?.children.flatMap((child) => child.preApplyAuthorization ?? []))
      .toContainEqual(expect.objectContaining({ pluginId: 'team/demo', platform, scope: 'project' }));
    expect(await f.events()).toEqual([]);
    const applied = await withAwHomeMutationLock({ env: f.env, action: async (token) => {
      const runtime = { awHomeMutationToken: token, preApplyConfirmed: true,
        preApplyExecutionCache: new Map<string, Promise<void>>() };
      const child = plan.joint!.children.find((entry) => entry.options.scope === 'project')!;
      expect(await executeRecoveryPreApply(child, 'team/demo', platform, runtime)).toBeUndefined();
      expect(await fs.pathExists(f.output(platform))).toBe(false);
      expect(await f.events()).toHaveLength(1);
      return executeRecovery(plan, { yes: true, runtime });
    } });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    expect(await fs.pathExists(f.output(platform))).toBe(true);
    expect(await f.events()).toEqual([expect.objectContaining({
      target: { platform, scope: 'project', projectRoot: f.cwd }, config: { values: { value: `stored-${platform}` } },
    })]);
    expect((await f.run(['status', '--context', 'project'])).exitCode).toBe(0);
    expect(await f.events()).toHaveLength(1);
  }, 30_000);

  // Test Value Gate: a real exit 23 must prevent the provider and its consumer from publishing while
  // another platform and independent targets still complete; shared providers must not run twice.
  it('blocks failed Portable providers and consumers while independent targets continue', async () => {
    const f = await fixture(['cursor', 'opencode'], true);
    await fs.outputFile(f.fail, 'fail cursor');
    const result = await f.run(['install', 'team/consumer', 'team/independent', '--scope', 'project', '--yes']);
    expect(result.exitCode).toBe(4);
    expect(result.value.data.allSatisfied).toBe(false);
    expect(result.value.data.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/provider', target: 'cursor', execution: 'failed',
        blockerCodes: expect.arrayContaining(['preApplyExited']) }),
      expect.objectContaining({ pluginId: 'team/consumer', target: 'cursor', execution: 'not-run',
        blockerCodes: expect.arrayContaining(['dependencyApplyFailed']) }),
      expect.objectContaining({ pluginId: 'team/independent', target: 'cursor', execution: 'applied' }),
      expect.objectContaining({ pluginId: 'team/consumer', target: 'opencode', execution: 'applied' }),
    ]));
    expect(await fs.pathExists(f.output('cursor', 'provider'))).toBe(false);
    expect(await fs.pathExists(f.output('cursor', 'consumer'))).toBe(false);
    expect(await fs.pathExists(f.output('cursor', 'independent'))).toBe(true);
    expect(await fs.pathExists(f.output('opencode', 'consumer'))).toBe(true);
    const events = (await f.events()).map((event) => `${event.plugin.name}/${event.target.platform}`);
    expect(events.sort()).toEqual(['consumer/opencode', 'independent/cursor', 'independent/opencode', 'provider/cursor', 'provider/opencode']);
  }, 30_000);

  // Test Value Gate: independent config apply must Review the Portable script and preserve an existing output
  // when the authorized script fails, without running a second save or losing its restore channel.
  it('reviews Portable config apply authorization and preserves the installed output on script failure', async () => {
    const f = await fixture(['cursor']);
    expect((await f.run(['install', 'team/demo', '--scope', 'project', '--yes'])).exitCode).toBe(0);
    const file = path.join(f.output('cursor'), 'SKILL.md');
    const before = await fs.readFile(file);
    const options = { plugin: f.plugin, scope: 'user' as const, context: 'project' as const,
      platform: 'cursor' as const, cwd: f.cwd, env: f.env, cliVersion: '1.0.0' };
    const reviewed = await preparePluginConfigApply(options);
    expect(reviewed.preApplyAuthorization).toContainEqual(expect.objectContaining({
      pluginId: 'team/demo', platform: 'cursor', scope: 'project',
    }));
    await disposePluginConfigApply(reviewed.plan);
    expect((await applyPluginConfig(options)).apply.error?.code).toBe('preApplyAuthorizationRequired');
    expect(await f.events()).toHaveLength(1);
    await fs.outputFile(f.fail, 'fail cursor');
    const result = await applyPluginConfig({ ...options, preApplyConfirmed: true, sharedNativeApplyConfirmed: true });
    expect(result).toMatchObject({ configWrite: 'notStarted', overallState: 'partial' });
    expect(result.apply.targetResults).toContainEqual(expect.objectContaining({ state: 'failed', errorCode: 'preApplyExited' }));
    expect(await fs.readFile(file)).toEqual(before);
    expect(await f.events()).toHaveLength(2);
  }, 30_000);
});
