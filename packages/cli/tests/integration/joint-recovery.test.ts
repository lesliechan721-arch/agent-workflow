import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import type { CatalogGenerationStateFileV1 } from '../../src/types.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { publicExitCode } from '../../src/output/public-result.js';
import { setAtomicConfigAfterRenameHookForTests } from '../../src/utils/plugin-config.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogGenerationStatePath } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { writeIntent, observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { recoveryRetryTargets, type RecoveryReceipt } from '../../src/recovery/receipt.js';
import { resolvePreferencesPath, writePreferences, setTargets, type DeploymentPreferences } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { snapshotRegularTree } from '../helpers/write-command-fixture.js';

async function fixture(collide = false, platforms: Array<'generic' | 'opencode' | 'cursor' | 'claude'> = ['generic'],
  hooks: boolean | string[] = false, graph: Record<string, string[]> = { a: ['d'], b: ['d'], d: [] },
  projectHookMutation?: { consumer: string; provider: string; scope?: 'user' | 'project'; replaceRetired?: boolean }, nativeHookMutation?: string) {
  const names = Object.keys(graph).sort();
  const skill = (name: string) => collide && name === 'b' ? 'a' : name;
  const hasHook = (name: string) => hooks === true || Array.isArray(hooks) && hooks.includes(name);
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'joint-project');
  const source = path.join(isolation.layout.fixtureCwd, 'joint-source');
  const hookTrace = path.join(cwd, 'hook-trace.jsonl');
  const hookFailure = path.join(cwd, 'fail-pre-apply');
  await fs.ensureDir(cwd); await git(cwd, ['init', '--quiet']);
  for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'SKILL.md'),
    `---\nname: ${skill(name)}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
  for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'README.md'), `Use ${name}.\n`);
  for (const name of names) for (const platform of platforms) await fs.copy(path.join(source, 'plugins', name, 'skills'), path.join(source, 'plugins', name, platform, 'skills'));
  for (const name of names.filter(hasHook)) await fs.outputFile(path.join(source, 'plugins', name, 'pre-apply.mjs'), [
    "import fs from 'node:fs'; const c = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(hookTrace)}, JSON.stringify({ plugin: c.plugin.name, platform: c.target.platform, scope: c.target.scope }) + '\\n');`,
    `const failure = ${JSON.stringify(hookFailure)};`,
    "if (fs.existsSync(failure) && fs.readFileSync(failure, 'utf8') === [c.plugin.name, c.target.platform, c.target.scope].join('/')) process.exit(23);",
    ...(name !== nativeHookMutation ? [] : [
      "if (c.target.scope === 'project') fs.appendFileSync(fs.readFileSync(failure, 'utf8'), '\\nExternal D-only bytes.\\n');",
    ]),
    ...(name !== projectHookMutation?.consumer ? [] : projectHookMutation.replaceRetired ? [
      `const retired = ${JSON.stringify(path.join(isolation.env.HOME!, '.agents', 'skills', 'retiring-skill'))};`,
      "if (c.target.scope === 'project') { fs.mkdirSync(retired, { recursive: true }); fs.writeFileSync(retired + '/README.md', 'External bytes.'); }",
    ] : [
      `const file = ${JSON.stringify(path.join(isolation.env.HOME!, '.agents', 'skills', projectHookMutation.provider, 'README.md'))};`,
      `if (c.target.scope === ${JSON.stringify(projectHookMutation.scope ?? 'project')} && fs.existsSync(file)) fs.writeFileSync(file, 'External bytes.');`,
    ]),
  ].join('\n'));
  await createDependencyCatalogSnapshotFixture(source, names.map((name) => ({ name,
    ...(graph[name]!.length ? { dependencies: graph[name] } : {}), configureManifest: (manifest) => {
      manifest.platforms = platforms; manifest.skills = './skills'; delete manifest.extensions;
      if (hasHook(name)) manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    } })));
  const entries = [];
  for (const name of names) {
    const root = path.join(source, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of platforms) await fs.outputJson(path.join(root, platform, 'skills', skill(name), 'aw-plugin-requirements.json'), receipt);
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalogPath = path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries });
  const config = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const generated = await fs.readJson(path.join(source, '.aw-generated.json')) as { workspaceIdentity: string };
  const options = { cwd, env: isolation.env, cliVersion: '1.0.0', yes: true };
  const intent = (name: string) => ({ schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
    sources: { team: { logicalIdentity: generated.workspaceIdentity } }, roots: [{ pluginId: `team/${name}` }] });
  await writeIntent({ ...options, scope: 'user' }, intent('a'));
  await writeIntent({ ...options, scope: 'project' }, intent('b'));
  await setTargets({ ...options, scope: 'user' }, ['generic']);
  const nativePaths: Record<string, string> = {};
  for (const scope of ['user', 'project'] as const) for (const platform of platforms.filter((platform) => platform !== 'generic')) for (const name of names) {
    const layout = await getNativeTestLayout({ platform, pluginId: `team/${name}`, scope, cwd, env: isolation.env });
    nativePaths[`${platform}/${scope}/${name}`] = path.join(layout.packageRoot, 'skills', skill(name));
  }
  const nativeSkill = (platform: 'opencode' | 'cursor', scope: 'user' | 'project', name: string) => nativePaths[`${platform}/${scope}/${name}`]!;
  return { options, cwd, source, hookTrace, hookFailure, nativeSkill, userRoot: path.join(isolation.env.HOME!, '.agents', 'skills'), projectRoot: path.join(cwd, '.agents', 'skills') };
}

function failNextPackagePublication(packageRoot: string) {
  let failed = false;
  const move = fs.move.bind(fs);
  const spy = vi.spyOn(fs, 'move').mockImplementation(async (source: string, destination: string, options?: fs.MoveOptions) => {
    if (destination === packageRoot && !failed) {
      failed = true;
      throw new Error('EACCES');
    }
    return move(source, destination, options);
  });
  return { failed: () => failed, restore: () => spy.mockRestore() };
}

async function expectSavedIntent(receipt: RecoveryReceipt, location: Parameters<typeof observeIntent>[0]) {
  const saved = await observeIntent(location);
  expect(saved.state).toBe('valid');
  if (saved.state !== 'valid') throw new Error('Expected the saved Intent to be readable.');
  expect(receipt.intent).toEqual({ state: 'valid', digest: saved.digest,
    roots: saved.value.roots.map((root) => root.pluginId) });
}

function failManifestAfterActiveCheck(file: string, stages: string[]) {
  const readJson = fs.readJson.bind(fs);
  let reads: number | undefined;
  const spy = vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
    if (String(args[0]) === file && reads !== undefined && ++reads === 2) {
      throw Object.assign(new Error('read failed'), { code: 'EIO' });
    }
    return readJson(...args);
  });
  const runtime: RebuildCommandRuntime = { debugLogger: { log: (event) => {
    if (event.data?.phase === 'start' && stages.includes(String(event.data.name))) reads = 0;
  } } };
  return { runtime, restore: () => spy.mockRestore() };
}

describe('joint recovery through real Catalog and owned outputs', () => {
  beforeEach(() => { installNativeTestQualification({ discovery: true }); });
  it.each([false, true])('keeps exact TUI pairs and their provider in Review and recovery (provider excluded=%s)', async (blocked) => {
    const value = await fixture(false, ['opencode', 'generic'], false, { a: ['d'], b: [], d: [] });
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/a' }, { pluginId: 'team/b' }] });
    const exclusions = [{ plugin: 'team/a', target: 'generic' }, { plugin: 'team/b', target: 'opencode' }] as const;
    const policy: DeploymentPreferences = { schemaVersion: 2, kind: 'aw-deployment-preferences',
      targets: ['opencode', 'generic', 'cursor'], exclusions: [...exclusions] };
    await writePreferences(project, { ...policy,
      exclusions: [...exclusions, ...(blocked ? [{ plugin: 'team/d', target: 'opencode' as const }] : [])] });
    const tui = new TuiController(createTuiControllerDependencies(createCliExecutionContext({ ...value.options, interactive: false })));
    onTestFinished(() => tui.dispose());
    const pairs = [{ pluginId: 'team/a', agent: 'opencode' }, { pluginId: 'team/b', agent: 'generic' }] as const;
    const prepare = async (exact: Array<{ pluginId: string; agent: 'opencode' | 'generic' | 'cursor' }>) => {
      const reviewed = await tui.prepareScopedTask({ kind: 'recovery', command: 'sync', scope: 'project',
        selectors: exact.map((pair) => pair.pluginId), targets: exact.map((pair) => pair.agent), exactTargets: exact,
      });
      if (reviewed.kind !== 'recovery') throw new Error('Expected recovery Review');
      return reviewed;
    };
    const review = await prepare([...pairs]);
    const executed = await tui.executeScopedTask(review);
    if (executed.kind !== 'recovery') throw new Error('Expected recovery receipt');
    const keys = (receipt: RecoveryReceipt) => receipt.targetResults.map((item) => [item.pluginId, item.agent, item.scope]);
    const expected = [
      ...(!blocked ? [['team/d', 'opencode', 'project']] : []),
      ['team/a', 'opencode', 'project'], ['team/b', 'generic', 'project'],
    ];
    expect(keys(review.plan.receipt)).toEqual(expected);
    expect(keys(executed.receipt)).toEqual(expected);
    const history = tui.listOperationHistory();
    expect(history).toHaveLength(1);
    expect(tui.getOperationDiagnostic(history[0]!.recordId)?.targets.map((item) => [item.pluginId, item.platform, item.scope])).toEqual(expected);
    expect(executed.receipt.targetResults.at(-1)).toMatchObject({ execution: 'applied', observation: 'verified' });
    await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    expect(executed.receipt.ok).toBe(!blocked);
    const remaining = executed.receipt.remainingTargets.map(({ pluginId, agent, scope }) => ({ pluginId, agent, scope }));
    expect(remaining).toEqual(blocked ? [{ ...pairs[0], scope: 'project' }] : []);
    if (blocked) {
      expect(executed.receipt.targetResults[0]).toMatchObject({ execution: 'not-run', observation: 'unknown', content: 'unknown',
        blockers: [expect.objectContaining({ code: 'dependencyExcluded', pluginId: 'team/d' })],
        recoveryActions: ['aw target include team/d --target opencode', '请在 TUI 当前项目中选择 team/a 的 opencode 位置重新检查。'] });
      const cli = await runPublicLifecycle('sync', ['team/a'], { ...value.options, context: 'user', targets: ['opencode'] });
      expect(cli).toMatchObject({ status: 'blocked', data: { changes: { preferences: 'none', outputs: 'none' },
        remainingTargets: [{ pluginId: 'team/a', target: 'opencode', scope: 'user' }] }, nextActions: [
        { argv: ['aw', 'target', 'include', 'team/d', '--target', 'opencode'] },
        { argv: ['aw', 'plugin', 'sync', 'team/a', '--context', 'user', '--target', 'opencode'] },
      ] });
      // The other exact pair remains independently complete while this exclusion still exists.
      expect(await tui.executeScopedTask(await prepare([pairs[1]]))).toMatchObject({ receipt: { ok: true } });
      await writePreferences(project, policy);
      const retry = await prepare([pairs[0]]);
      const recovered = await tui.executeScopedTask(retry);
      expect(recovered).toMatchObject({ kind: 'recovery', receipt: { ok: true, remainingTargets: [],
        targetResults: [
          { pluginId: 'team/d', agent: 'opencode', scope: 'project', requiredBy: ['team/a'], relation: 'dependency' },
          { pluginId: 'team/a', agent: 'opencode', scope: 'project' },
        ] } });
    } else {
      const skipped = await prepare([{ pluginId: 'team/b', agent: 'cursor' }, { pluginId: 'team/a', agent: 'generic' }]);
      expect(await tui.executeScopedTask(skipped)).toMatchObject({ receipt: { ok: true, remainingTargets: [],
        targetResults: [
          { pluginId: 'team/b', agent: 'cursor', satisfaction: 'unsupported', execution: 'no-op' },
          { pluginId: 'team/a', agent: 'generic', satisfaction: 'excluded', execution: 'no-op' },
        ] } });
    }
    expect(await fs.pathExists(value.nativeSkill('opencode', 'user', 'a'))).toBe(false);
  }, 30000);
  // Public receipts must identify the saved scope and digest, independently of output execution.
  it.each(['user', 'project'] as const)('reports the saved %s Intent after initial install, add, no-op and remove', async (scope) => {
    const value = await fixture();
    const location = { ...value.options, scope };
    const other = { ...value.options, scope: scope === 'user' ? 'project' as const : 'user' as const };
    const otherBefore = await observeIntent(other);
    await fs.remove(await resolveIntentPath(location));
    const root = scope === 'user' ? 'team/a' : 'team/b';
    const installed = await runRecovery('install', [root], location);
    expect(installed.ok).toBe(true);
    expect(installed.declarationChanged).toBe(true);
    await expectSavedIntent(installed, location);
    const added = await runRecovery('install', ['team/d'], location);
    expect(added.ok).toBe(true);
    expect(added.declarationChanged).toBe(true);
    await expectSavedIntent(added, location);
    expect(added.intent.roots).toEqual([root, 'team/d']);
    const unchanged = await runRecovery('install', ['team/d'], location);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.declarationChanged).toBe(false);
    expect(unchanged.intent).toEqual(added.intent);
    const removed = await runRecovery('uninstall', ['team/d'], { ...location, force: true });
    expect(removed.ok).toBe(true);
    expect(removed.declarationChanged).toBe(true);
    await expectSavedIntent(removed, location);
    expect(removed.intent.roots).toEqual([root]);
    expect(removed.intent.digest).not.toBe(added.intent.digest);
    expect(await observeIntent(other)).toEqual(otherBefore);
  }, 30000);

  // Test Value Gate: a real script cannot publish a consumer after invalidating a reused provider;
  // an authorized, verified retirement alone must leave the provider usable.
  it.each([
    ['first Project install', 'bytes'],
    ['sync with a retiring Skill', 'bytes'],
    ['rebuild with a retiring Skill', 'bytes'],
    ['sync with a retired Skill reoccupied', 'retired'],
    ['sync with a clean retirement', 'none'],
    ['first Project install with a provider owner read failure', 'read failure'],
  ] as const)('validates User provider outputs at publication after %s', async (operation, mutation) => {
    const firstInstall = operation.startsWith('first Project install');
    const value = await fixture(false, ['generic'], ['b'], { a: [], b: ['d'], d: [], q: [] },
      mutation === 'bytes' || mutation === 'retired' ? { consumer: 'b', provider: 'd', replaceRetired: mutation === 'retired' } : undefined);
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const, targets: ['generic'] };
    const project = { ...value.options, context: 'project' as const, scope: 'project' as const, targets: ['generic'] };
    for (const location of [user, project]) {
      const observed = await observeIntent(location);
      if (observed.state !== 'valid') throw new Error('Expected a saved Intent.');
      const names = location.scope === 'user' ? ['d'] : firstInstall ? [] : ['b', 'q'];
      await writeIntent(location, { ...observed.value, roots: names.map((name) => ({ pluginId: `team/${name}` })) });
    }
    const refreshProvider = async (addOld: boolean) => {
      const root = path.join(value.source, 'plugins', 'd');
      for (const subtree of ['skills', 'generic/skills']) {
        const old = path.join(root, subtree, 'retiring-skill');
        if (addOld) {
          await fs.copy(path.join(root, subtree, 'd'), old);
          await fs.writeFile(path.join(old, 'SKILL.md'), '---\nname: retiring-skill\ndescription: Old provider output\n---\nPreviously shipped.\n');
        } else {
          await fs.remove(old);
          await fs.appendFile(path.join(root, subtree, 'd', 'README.md'), 'Now updated.\n');
        }
      }
      const manifestPath = path.join(value.source, 'catalog-manifest.json');
      const manifest = await fs.readJson(manifestPath);
      const entry = await createCatalogManifestV7Entry(await readPluginManifest(root, { mode: 'bundle' }), root);
      await fs.writeJson(manifestPath, { ...manifest, entries: manifest.entries.map((item: typeof entry) =>
        item.name === entry.name ? entry : item) });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: user.cliVersion, env: user.env });
    };
    if (!firstInstall) await refreshProvider(true);
    expect((await runPublicLifecycle('sync', ['team/d'], user)).status).toBe('success');
    const providerFile = path.join(value.userRoot, 'd', 'README.md');
    const retired = path.join(value.userRoot, 'retiring-skill');
    if (!firstInstall) {
      await expect(fs.pathExists(path.join(retired, 'SKILL.md'))).resolves.toBe(true);
      await refreshProvider(false);
    }

    const marker = path.join(value.userRoot, 'd', SKILL_OWNER_MARKER);
    const owner = await fs.readFile(marker);
    const readFile = fs.readFile.bind(fs);
    const failure = mutation === 'read failure' ? vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof readFile>) => {
      if (String(args[0]) === marker && await fs.pathExists(value.hookTrace)) {
        throw Object.assign(new Error('Provider owner read failed'), { code: 'EIO' });
      }
      return readFile(...args);
    }) : undefined;
    const result = await runPublicLifecycle(firstInstall ? 'install' : 'sync', ['team/b', 'team/q'],
      { ...project, rebuild: operation === 'rebuild with a retiring Skill' }).finally(() => failure?.mockRestore());
    expect(result.status, JSON.stringify(result.diagnostics)).toBe(mutation === 'none' ? 'success' : 'partial');
    expect(result.data.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/b', scope: 'project', ...(mutation === 'none'
        ? { execution: 'applied', observation: 'verified' }
        : { execution: 'not-run', blockerCodes: ['operationReviewStale'] }) }),
      expect.objectContaining({ pluginId: 'team/q', scope: 'project', execution: 'applied', observation: 'verified' }),
    ]));
    if (firstInstall) expect(result.data.targetResults.map((target) => target.pluginId)).toEqual(['team/b', 'team/q']);
    await expect(fs.readFile(providerFile, 'utf8')).resolves.toBe(mutation === 'bytes' ? 'External bytes.'
      : firstInstall ? 'Use d.\n' : 'Use d.\nNow updated.\n');
    if (firstInstall) await expect(fs.readFile(marker)).resolves.toEqual(owner);
    await expect(fs.pathExists(path.join(retired, 'SKILL.md'))).resolves.toBe(false);
    if (mutation === 'retired') await expect(fs.readFile(path.join(retired, 'README.md'), 'utf8')).resolves.toBe('External bytes.');
    else await expect(fs.pathExists(retired)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).resolves.toBe(mutation === 'none');
    await expect(fs.readFile(path.join(value.projectRoot, 'q', 'SKILL.md'), 'utf8')).resolves.toContain('Use q.');
    await expect(fs.readFile(value.hookTrace, 'utf8')).resolves.toBe('{"plugin":"b","platform":"generic","scope":"project"}\n');
  }, 45000);

  it('retains changes made by a User provider script and blocks its consumer while an independent Skill publishes', async () => {
    const value = await fixture(false, ['generic'], ['d'], { a: [], b: ['d'], d: [], q: [] },
      { consumer: 'd', provider: 'd', scope: 'user' });
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
    const project = { ...value.options, context: 'project' as const, scope: 'project' as const };
    const observed = await observeIntent(user);
    if (observed.state !== 'valid') throw new Error('Expected a saved Intent.');
    await writeIntent(user, { ...observed.value, roots: [{ pluginId: 'team/d' }] });
    await writeIntent(project, { ...observed.value, roots: [{ pluginId: 'team/b' }, { pluginId: 'team/q' }] });
    expect((await runPublicLifecycle('sync', ['team/d'], user)).status).toBe('success');
    await fs.writeFile(value.hookTrace, '');
    const marker = path.join(value.userRoot, 'd', SKILL_OWNER_MARKER);
    const owner = await fs.readFile(marker);

    const result = await runPublicLifecycle('sync', ['team/d', 'team/b', 'team/q'], project);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('partial');
    expect(result.data.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/d', scope: 'user', execution: 'not-run', blockerCodes: ['operationReviewStale'] }),
      expect.objectContaining({ pluginId: 'team/b', scope: 'project', execution: 'not-run', blockerCodes: ['userProviderNotSatisfied'] }),
      expect.objectContaining({ pluginId: 'team/q', scope: 'project', execution: 'applied', observation: 'verified' }),
    ]));
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'README.md'), 'utf8')).resolves.toBe('External bytes.');
    await expect(fs.readFile(marker)).resolves.toEqual(owner);
    await expect(fs.pathExists(path.join(value.projectRoot, 'b'))).resolves.toBe(false);
    await expect(fs.readFile(path.join(value.projectRoot, 'q', 'SKILL.md'), 'utf8')).resolves.toContain('Use q.');
  }, 30000);

  it('publishes two independent generic Skills concurrently and returns their reviewed order', async () => {
    const value = await fixture(false, ['generic'], false, { a: [], b: [] });
    const plan = await prepareRecovery('install', ['team/a', 'team/b'], { ...value.options, scope: 'user', context: 'user' });
    const order = plan.receipt.requestedTargets.map((item) => item.pluginId);
    const parallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
    const copy = fs.copy.bind(fs);
    const entered = new Set<string>();
    let deadlineExpired = false;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    let overlapped = false;
    const copied = vi.spyOn(fs, 'copy').mockImplementation(async (source: string, destination: string, options?: fs.CopyOptions) => {
      if (path.basename(path.dirname(destination)).startsWith('.aw-portable-stage-')) {
        entered.add(path.basename(destination));
        if (entered.size === 2) { overlapped = !deadlineExpired; release(); }
        await bothEntered;
      }
      await copy(source, destination, options);
    });
    const deadline = setTimeout(() => { deadlineExpired = true; release(); }, 5_000);
    try {
      const receipt = await executeRecovery(plan);
      expect(receipt.ok, JSON.stringify(receipt.errors)).toBe(true);
      expect(overlapped).toBe(true);
      expect(receipt.targetResults.map((item) => item.pluginId)).toEqual(order);
      for (const name of ['a', 'b']) {
        await expect(fs.readFile(path.join(value.userRoot, name, 'SKILL.md'), 'utf8')).resolves.toContain(`Use ${name}.`);
        await expect(fs.pathExists(path.join(value.userRoot, name, SKILL_OWNER_MARKER))).resolves.toBe(true);
      }
    } finally { clearTimeout(deadline); release(); copied.mockRestore(); parallelism.mockRestore(); }
  }, 30000);

  it('distinguishes a waiting consumer from ready generic targets queued behind a writer', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: [], c: [], d: [], e: [] });
    const plan = await prepareRecovery('install', ['team/a', 'team/c', 'team/e'], { ...value.options, scope: 'user', context: 'user' });
    const parallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(1);
    const copy = fs.copy.bind(fs);
    const firstWriter = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const started: string[] = [];
    const copied = vi.spyOn(fs, 'copy').mockImplementation(async (source: string, destination: string, options?: fs.CopyOptions) => {
      if (path.basename(path.dirname(destination)).startsWith('.aw-portable-stage-')) {
        started.push(path.basename(destination));
        if (started.length === 1) {
          firstWriter.resolve();
          await releaseFirst.promise;
        }
      }
      return copy(source, destination, options);
    });
    const progress = vi.fn<NonNullable<RebuildCommandRuntime['onInstallProgress']>>();
    const execution = executeRecovery(plan, { runtime: { onInstallProgress: progress } });
    try {
      await Promise.race([firstWriter.promise, execution]);
      expect(started).toHaveLength(1);
      expect(started[0]).not.toBe('a');
      expect(progress.mock.lastCall?.[0]).toEqual({ completed: 0, running: 1, waitingForDependencies: 1, waiting: 2 });
      releaseFirst.resolve();
      const receipt = await execution;
      expect(receipt.ok, JSON.stringify(receipt.errors)).toBe(true);
      expect(started).toHaveLength(4);
      expect(started.indexOf('d')).toBeLessThan(started.indexOf('a'));
      expect(progress.mock.lastCall?.[0]).toEqual({ completed: 4, running: 0, waitingForDependencies: 0, waiting: 0 });
    } finally {
      releaseFirst.resolve();
      await execution.catch(() => {});
      copied.mockRestore();
      parallelism.mockRestore();
    }
  }, 30000);

  it('installs a Project root once over an existing User Skill dependency', async () => {
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    await fs.remove(await resolveIntentPath(project));
    await setTargets(user, ['opencode']);
    expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    const receipt = await runRecovery('install', ['team/b'], project);
    expect(receipt.ok, JSON.stringify(receipt.targetResults.map((target) => [target.pluginId, target.scope, target.blockers]))).toBe(true);
    expect(receipt.targetResults.map((target) => [target.pluginId, target.scope])).toEqual([['team/b', 'project']]);
    expect(await fs.pathExists(value.nativeSkill('opencode', 'project', 'd'))).toBe(false);
    expect(await readRecoveryStatus(project)).toMatchObject({ allSatisfied: true, inSync: true });
    const personalSkill = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    await fs.appendFile(personalSkill, '\nUser drift.\n');
    const blocked = await runRecovery('sync', ['team/b'], project);
    expect(blocked.ok).toBe(false);
    expect(blocked.targetResults.find((target) => target.pluginId === 'team/b')?.blockers).toContainEqual(
      expect.objectContaining({ code: 'userSkillProviderNotReady', pluginId: 'team/d', subject: { pluginId: 'team/a', scope: 'user', target: 'opencode' } }));
    for (const result of [
      await runPublicPluginStatus(['team/b'], { ...project, targets: ['opencode'] }),
      await runPublicLifecycle('sync', ['team/b'], { ...project, targets: ['opencode'] }),
    ]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'userSkillProviderNotReady',
        subject: { pluginId: 'team/a', scope: 'user', target: 'opencode' } }));
      expect(result.nextActions.flatMap((action) => action.kind === 'command' && action.argv[2] === 'sync' ? [action.argv] : [])).toEqual([
        ['aw', 'plugin', 'sync', 'team/a', '--context', 'user', '--target', 'opencode'],
        ['aw', 'plugin', 'sync', 'team/b', '--context', 'project', '--target', 'opencode'],
      ]);
    }
    expect(await fs.readFile(personalSkill, 'utf8')).toContain('User drift.');
    expect(await fs.pathExists(value.nativeSkill('opencode', 'project', 'd'))).toBe(false);
    const repaired = await runRecovery('sync', [], project);
    expect(repaired.ok, JSON.stringify(repaired.targetResults.map((target) => [target.pluginId, target.scope, target.blockers]))).toBe(true);
    expect(repaired).toMatchObject({ allSatisfied: true, inSync: true });
    expect(await fs.readFile(personalSkill, 'utf8')).not.toContain('User drift.');
    const foreign = path.join(value.nativeSkill('opencode', 'project', 'd'), 'foreign.txt');
    await fs.outputFile(foreign, 'Keep my project package.');
    const conflict = await runRecovery('sync', ['team/b'], project);
    expect(conflict.targetResults.find((target) => target.pluginId === 'team/b')?.blockers).toContainEqual(
      expect.objectContaining({ code: 'projectSkillProviderConflict' }));
    expect(await fs.readFile(foreign, 'utf8')).toBe('Keep my project package.');
  }, 30000);

  it('reuses installed User Skills on separate native layouts and retires an owned Project duplicate on sync', async () => {
    const value = await fixture(false, ['opencode'], false, { b: ['a'], a: ['d'], d: [] });
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    await setTargets(user, ['opencode']);
    const userSkill = value.nativeSkill('opencode', 'user', 'd');
    const projectSkill = value.nativeSkill('opencode', 'project', 'd');
    // A User declaration alone must not make Project sync install its dependency into User.
    expect(await runRecovery('sync', ['team/b'], project)).toMatchObject({ ok: true, blockers: [], errors: [] });
    expect(await fs.pathExists(userSkill)).toBe(false);
    expect(await fs.pathExists(projectSkill)).toBe(true);
    expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    const before = await readRecoveryStatus(project);
    expect(before.extraObserved).toContainEqual(expect.objectContaining({ pluginId: 'team/d', agent: 'opencode', scope: 'project' }));
    for (const selection of [[], ['team/b']]) {
      const query = await runPublicPluginStatus(selection, project);
      expect(query.diagnostics).toContainEqual(expect.objectContaining({ code: 'projectSkillDuplicatePending',
        severity: 'warning', subject: { pluginId: 'team/d', target: 'opencode', scope: 'project' } }));
      expect(query.nextActions.filter((action) => action.kind === 'command')).toEqual([expect.objectContaining({
        argv: ['aw', 'plugin', 'sync', 'team/b', '--context', 'project', '--target', 'opencode'],
      })]);
    }
    await fs.appendFile(path.join(userSkill, 'SKILL.md'), '\nUser bytes need refreshing.\n');
    const failure = failNextPackagePublication(path.resolve(userSkill, '../..'));
    try {
      expect((await runRecovery('sync', [], project)).ok).toBe(false);
      expect(failure.failed()).toBe(true);
      expect(await fs.pathExists(projectSkill)).toBe(true);
      expect(await fs.pathExists(value.nativeSkill('opencode', 'project', 'a'))).toBe(true);
    } finally { failure.restore(); }
    const migrated = await runRecovery('sync', [], project);
    expect(migrated.ok, JSON.stringify(migrated.targetResults)).toBe(true);
    expect(await fs.pathExists(projectSkill)).toBe(false);
    expect(await fs.pathExists(value.nativeSkill('opencode', 'project', 'a'))).toBe(false);
    expect(await fs.pathExists(userSkill)).toBe(true);
    const after = await readRecoveryStatus(project);
    expect(after).toMatchObject({ allSatisfied: true, inSync: true });
    expect(after.observedTargets?.find((target) => target.pluginId === 'team/d')).toMatchObject({
      scope: 'user', requiredBy: ['team/a', 'team/b'],
    });
    const removed = await runRecovery('uninstall', ['team/a'], { ...project, scope: 'user' });
    expect(removed.ok, JSON.stringify(removed.errors)).toBe(true);
    expect(await fs.pathExists(projectSkill)).toBe(true);
    expect(await fs.pathExists(userSkill)).toBe(false);
    expect(await readRecoveryStatus(project)).toMatchObject({ allSatisfied: true, inSync: true });
  }, 30000);

  it('publishes a selected missing User provider first and retains it if its later Project replacement fails', async () => {
    const value = await fixture(false, ['opencode']);
    const project = { ...value.options, context: 'project' as const };
    await setTargets({ ...project, scope: 'user' }, ['opencode']);
    const userSkill = value.nativeSkill('opencode', 'user', 'd');
    const projectSkill = value.nativeSkill('opencode', 'project', 'd');
    expect(await runRecovery('sync', [], project)).toMatchObject({ ok: true, inSync: true });
    expect(await fs.pathExists(userSkill)).toBe(true);
    expect(await fs.pathExists(projectSkill)).toBe(false);
    const failure = failNextPackagePublication(path.resolve(projectSkill, '../..'));
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], { ...project, scope: 'user', yes: true });
      expect(result.status).not.toBe('success');
      expect(result.nextActions, JSON.stringify(result.diagnostics)).toContainEqual({ kind: 'manual', message: expect.stringContaining(
        'aw plugin remove team/d --only outputs --scope user --target opencode') });
      expect(failure.failed()).toBe(true);
      expect(await fs.pathExists(userSkill)).toBe(true);
      expect(await fs.pathExists(projectSkill)).toBe(false);
    } finally { failure.restore(); }
    expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect(await fs.pathExists(projectSkill)).toBe(true);
    expect(await fs.pathExists(userSkill)).toBe(true);
    const cleanup = await runPublicLifecycle('remove', ['team/d'],
      { ...project, scope: 'user', only: 'outputs', targets: ['opencode'], yes: true });
    expect(cleanup.status, JSON.stringify(cleanup.diagnostics)).toBe('success');
    expect(await fs.pathExists(userSkill)).toBe(false);
    expect(await readRecoveryStatus(project)).toMatchObject({ inSync: true });
  }, 30000);

  // Test Value Gate: the public execution must create one shared dependency and preserve both declarations.
  it('repairs user providers before project consumers without a project dependency copy', async () => {
    const value = await fixture();
    const result = await runRecovery('sync', [], value.options);
    expect(result.errors).toEqual([]);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.declarationChanged).toBe(false);
    await expectSavedIntent(result, { ...value.options, scope: 'project' });
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const status = await readRecoveryStatus(value.options);
    expect(status.coverage.scopes).toEqual(['user', 'project']);
    expect(status.allSatisfied).toBe(true);
  }, 30000);

  it('runs a healthy shared provider hook for a selected User root, but skips it for Project-only sync', async () => {
    const value = await fixture(false, ['generic'], ['d']);
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const, targets: ['generic'] };
    const project = { ...value.options, context: 'project' as const, targets: ['generic'] };
    expect((await runPublicLifecycle('sync', ['team/a'], user)).status).toBe('success');
    const providerFile = path.join(value.userRoot, 'd', 'README.md');
    const providerBytes = await fs.readFile(providerFile);
    const userOutput = path.join(value.userRoot, 'a');
    const projectOutput = path.join(value.projectRoot, 'b');
    const resetHooks = () => fs.writeFile(value.hookTrace, '');
    const hooks = async () => (await fs.readFile(value.hookTrace, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    await resetHooks();
    await fs.writeFile(value.hookFailure, 'd/generic/user');
    await fs.remove(userOutput);

    const projectOnly = await runPublicLifecycle('sync', ['team/b'], { ...project, yes: false });
    expect(projectOnly.status).toBe('success');
    expect(projectOnly.data.confirmation?.effects.filter((effect) => effect.code === 'runPreApply') ?? []).toEqual([]);
    await expect(fs.readFile(path.join(projectOutput, 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    await expect(fs.pathExists(userOutput)).resolves.toBe(false);
    await expect(hooks()).resolves.toEqual([]);

    // In a multi-root request the exact pairs, including their scopes, determine which roots run.
    await fs.remove(projectOutput);
    const exact = await runRecovery('sync', ['team/a', 'team/b'], { ...project, yes: false,
      exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }] });
    expect(exact.ok).toBe(true);
    await expect(hooks()).resolves.toEqual([]);
    await expect(fs.pathExists(userOutput)).resolves.toBe(false);
    await expect(fs.readFile(path.join(projectOutput, 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');

    await fs.remove(projectOutput);
    const providerHook = [{ plugin: 'd', platform: 'generic', scope: 'user' }];
    for (const roots of [['team/a', 'team/b'], ['team/b', 'team/a']]) {
      const summary = await runPublicLifecycle('sync', roots, { ...project, yes: false });
      expect(summary.data.confirmation?.effects.filter((effect) => effect.code === 'runPreApply').map((effect) => effect.subject))
        .toEqual([{ pluginId: 'team/d', target: 'generic', scope: 'user' }]);
      await expect(hooks()).resolves.toEqual([]);

      const failed = await runPublicLifecycle('sync', roots, project);
      expect(failed.data.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ pluginId: 'team/d', scope: 'user', execution: 'failed', blockerCodes: ['preApplyFailed'] }),
        expect.objectContaining({ pluginId: 'team/a', scope: 'user', execution: 'not-run', blockerCodes: ['dependencyApplyFailed'] }),
        expect.objectContaining({ pluginId: 'team/b', scope: 'project', execution: 'not-run', blockerCodes: ['userProviderNotSatisfied'] }),
      ]));
      await expect(hooks()).resolves.toEqual(providerHook);
      await expect(fs.pathExists(userOutput)).resolves.toBe(false);
      await expect(fs.pathExists(projectOutput)).resolves.toBe(false);
      await expect(fs.readFile(providerFile)).resolves.toEqual(providerBytes);
      await resetHooks();
    }

    await fs.remove(value.hookFailure);
    expect((await runPublicLifecycle('sync', ['team/a', 'team/b'], project)).status).toBe('success');
    await expect(hooks()).resolves.toEqual(providerHook);
    await expect(fs.readFile(path.join(userOutput, 'SKILL.md'), 'utf8')).resolves.toContain('Use a.');
    await expect(fs.readFile(path.join(projectOutput, 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    await expect(fs.pathExists(path.join(value.projectRoot, 'd'))).resolves.toBe(false);

    expect((await runPublicLifecycle('install', ['team/d'], { ...value.options,
      context: 'user', scope: 'user', only: 'requirements' })).status).toBe('success');
    await resetHooks();
    const explicit = await runRecovery('sync', ['team/b', 'team/d'], { ...project,
      exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }, { pluginId: 'team/d', agent: 'generic', scope: 'user' }] });
    expect(explicit.ok).toBe(true);
    expect(explicit.targetResults.find((target) => target.pluginId === 'team/d')).toMatchObject({ relation: 'root', scope: 'user' });
    await expect(hooks()).resolves.toEqual(providerHook);
  }, 30000);

  it.each(['whole Project diamond', 'exact second branch', 'diamond with a missing provider'] as const)('rechecks a changed User provider before Project writes from the %s', async (selection) => {
    const exact = selection === 'exact second branch';
    const missing = selection === 'diamond with a missing provider';
    const value = await fixture(false, ['generic'], exact ? ['b'] : ['b', 'd'],
      { a: ['d'], b: ['d'], d: [], q: [], r: ['a', 'b'] }, { consumer: 'b', provider: 'd' });
    for (const scope of ['user', 'project'] as const) {
      const location = { ...value.options, scope };
      const observed = await observeIntent(location);
      if (observed.state !== 'valid') throw new Error('Expected a saved Intent.');
      await writeIntent(location, { ...observed.value, roots: (scope === 'user' ? ['d'] : ['r', 'q']).map((name) => ({ pluginId: `team/${name}` })) });
    }
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
    const project = { ...value.options, context: 'project' as const };
    if (!missing) expect((await runRecovery('sync', ['team/d'], user)).ok).toBe(true);
    await fs.writeFile(value.hookTrace, '');
    const providerFile = path.join(value.userRoot, 'd', 'README.md');
    const providerMarker = path.join(value.userRoot, 'd', SKILL_OWNER_MARKER);
    const markerBytes = missing ? undefined : await fs.readFile(providerMarker);
    if (missing) await expect(fs.pathExists(providerFile)).resolves.toBe(false);

    const receipt = exact ? await runRecovery('sync', ['team/b', 'team/q'], { ...project, allowDependencySelectors: true,
      exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }, { pluginId: 'team/q', agent: 'generic', scope: 'project' }] })
      : await runRecovery('sync', ['team/r', 'team/q'], project);
    expect(receipt.ok).toBe(false);
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/b', scope: 'project', execution: 'not-run',
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) }),
      expect.objectContaining({ pluginId: 'team/q', scope: 'project', execution: 'applied' }),
      ...(!exact ? [expect.objectContaining({ pluginId: 'team/r', scope: 'project', execution: 'not-run',
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'dependencyApplyFailed' })]) })] : []),
    ]));
    if (exact) expect(receipt.targetResults.map((target) => target.pluginId)).toEqual(['team/d', 'team/b', 'team/q']);
    expect((await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toEqual([...(missing ? [{ plugin: 'd', platform: 'generic', scope: 'user' }] : []),
        { plugin: 'b', platform: 'generic', scope: 'project' }]);
    await expect(fs.readFile(providerFile, 'utf8')).resolves.toBe('External bytes.');
    if (markerBytes) await expect(fs.readFile(providerMarker)).resolves.toEqual(markerBytes);
    else await expect(fs.readJson(providerMarker)).resolves.toMatchObject({ pluginId: 'team/d', scope: 'user' });
    for (const name of exact ? ['a', 'b', 'd', 'r'] : ['b', 'd', 'r']) await expect(fs.pathExists(path.join(value.projectRoot, name))).resolves.toBe(false);
    await expect(fs.readFile(path.join(value.projectRoot, 'q', 'SKILL.md'), 'utf8')).resolves.toContain('Use q.');
  }, 30000);

  it.each(['same-path damage', 'new Active', 'new Active with caller context'] as const)('rejects install after %s between Review and confirmation', async (change) => {
    const value = await fixture();
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    // A first install has no saved root from which to derive its Catalog identity.
    await Promise.all([fs.remove(await resolveIntentPath(user)), fs.remove(await resolveIntentPath(project))]);
    await writePreferences(user, { schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['generic', 'cursor'],
      exclusions: [{ plugin: 'team/b', target: 'generic' }] });
    const before = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const selectors = ['team/a', 'team/b'];
    const plan = await prepareRecovery('install', selectors, change === 'new Active with caller context'
      ? { ...user, catalogOperationContext: await resolveCatalogOperationContext({ env: user.env }) } : user);
    expect(plan.receipt.blockers).toEqual([]);
    if (change === 'same-path damage') {
      const file = path.join(before.snapshotPath, 'plugins', 'b', 'generic', 'skills', 'b', 'README.md');
      const times = await fs.stat(file);
      await fs.writeFile(file, 'Use x.\n');
      await fs.utimes(file, times.atime, times.mtime);
    } else {
      await fs.appendFile(path.join(value.source, 'catalog-manifest.json'), '\n');
      const changed = await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: user.cliVersion, env: user.env });
      expect(changed.active?.snapshotDigest).not.toBe(before.snapshotDigest);
    }

    const receipt = await executeRecovery(plan);
    expect(receipt).toMatchObject({ ok: false, declarationChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
    const pending = [{ pluginId: 'team/d', agent: 'generic', scope: 'user' }, { pluginId: 'team/a', agent: 'generic', scope: 'user' }];
    expect(receipt.requestedTargets).toEqual(plan.receipt.requestedTargets);
    expect(receipt.remainingTargets).toMatchObject(pending);
    expect(receipt.targetResults).toMatchObject([
      ...pending.map((target) => ({ ...target, execution: 'not-run', observation: 'unknown', content: 'unknown',
        requiredBy: ['team/a'], blockers: [{ code: 'operationReviewStale' }] })),
      ...plan.receipt.targetResults.filter((target) => target.satisfaction === 'unsupported' || target.satisfaction === 'excluded'),
    ]);
    await expect(observeIntent(user)).resolves.toEqual({ state: 'absent' });
    await expect(observeIntent(project)).resolves.toEqual({ state: 'absent' });
    await expect(fs.pathExists(value.userRoot)).resolves.toBe(false);
    await expect(fs.pathExists(value.projectRoot)).resolves.toBe(false);
    if (change === 'new Active') {
      const retry = await prepareRecovery('install', selectors, user);
      expect(retry.receipt.blockers).toEqual([]);
      expect((await executeRecovery(retry))).toMatchObject({ ok: true, declarationChanged: true, remainingTargets: [] });
      await expect(fs.readFile(path.join(value.userRoot, 'a', 'SKILL.md'), 'utf8')).resolves.toContain('Use a.');
      await expect(fs.pathExists(path.join(value.userRoot, 'b'))).resolves.toBe(false);
    }
  });

  it('asks the CLI user to review the original install when a verified provider changes before writing', async () => {
    const value = await fixture();
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
    expect((await runPublicLifecycle('sync', ['team/a'], user)).status).toBe('success');
    await setTargets(user, ['cursor', 'generic']);
    const review = await prepareRecovery('install', ['team/b'], user);
    try {
      expect(review.receipt.targetResults[0]).toMatchObject({ pluginId: 'team/d', observation: 'verified', content: 'satisfied' });
    } finally { await review.context.dispose(); }
    const provider = path.join(value.userRoot, 'd', 'SKILL.md');
    const result = await runPublicLifecycle('install', ['team/b'], user, { debugLogger: { log: async (event) => {
      if (event.data?.name === 'recovery.lock.wait' && event.data.phase === 'start') await fs.appendFile(provider, '\nChanged outside AW.\n');
    } } });
    const positions = ['team/d', 'team/b'].map((id) => ({ pluginId: id, target: 'generic', scope: 'user' }));
    expect(publicExitCode(result)).toBe(3);
    expect(result).toMatchObject({ status: 'blocked', data: {
      requirements: { roots: ['team/a'] }, changes: { requirements: 'none', preferences: 'none', outputs: 'none' },
      targetResults: [...positions.map((position) => ({ ...position, execution: 'not-run', observation: 'unknown', content: 'unknown' })),
        { pluginId: 'team/b', target: 'cursor', execution: 'no-op', observation: 'verified', satisfaction: 'unsupported' }],
      remainingTargets: positions,
    }, nextActions: [{ kind: 'manual', message: expect.stringContaining('original plugin install request') }] });
    await expect(fs.readFile(provider, 'utf8')).resolves.toContain('Changed outside AW.');
    await expect(fs.pathExists(path.join(value.userRoot, 'b'))).resolves.toBe(false);
  });

  it('shares the public CLI source preparation across the initial Review and independently checks Active under the lock', async () => {
    const value = await fixture(false, ['generic', 'opencode'], false, { a: [], b: [], z: [] });
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
    await setTargets(user, ['generic', 'opencode']);
    const active = await resolveActiveCatalogGeneration({ ...user, sourceId: 'team' });
    const marker = path.join(active.snapshotPath, '.claude-plugin', 'marketplace.json');
    // Cold materialization verifies each staging source separately. Warm those files so the
    // marker counts only full Active checks, independently of per-plugin content validation.
    const warm = await prepareRecovery('install', ['team/a', 'team/b'], user);
    await warm.context.dispose();
    const readFile = fs.readFile.bind(fs);
    const scans = { review: 0, recheck: 0 };
    let phase: keyof typeof scans | undefined = 'review';
    const reads = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (phase && String(args[0]) === marker) scans[phase]++;
      return readFile(...args);
    });
    try {
      const result = await runPublicLifecycle('install', ['team/a', 'team/b'], user, { debugLogger: { log(event) {
        if (event.data?.name === 'recovery.lock.wait' && event.data.phase === 'start') phase = 'recheck';
        if (event.data?.name === 'recovery.locked.recheck' && event.data.phase === 'success') phase = undefined;
      } } });
      expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
      expect(scans).toEqual({ review: 1, recheck: 1 });
    } finally { reads.mockRestore(); }
  }, 30_000);

  // An unrelated file is read only by whole-Catalog scans. The same-source
  // protection groups share one scan, while different source IDs retain their own.
  it.each(['single group', 'same source', 'source alias'] as const)('bounds full scans during a Portable child with %s', async (scenario) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: [], d: [], z: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    const active = await resolveActiveCatalogGeneration({ ...user, sourceId: 'team' });
    await fs.remove(await resolveIntentPath(project));
    if (scenario === 'single group') await fs.remove(await resolveIntentPath(user));
    else {
      const saved = await observeIntent(user);
      if (saved.state !== 'valid') throw new Error('Expected fixture User Intent.');
      const sourceId = scenario === 'source alias' ? 'mirror' : 'team';
      if (sourceId === 'mirror') {
        const config = await readCatalogSourcesConfigSnapshot(user.env);
        await replaceCatalogSourcesConfig({ config: { ...config.config,
          sources: [...config.config.sources, { id: sourceId, type: 'path', primary: false, path: value.source }] },
        expectedDigest: config.digest, env: user.env });
        await syncCatalogSourceGeneration({ ...user, sourceId });
        const mirror = await resolveActiveCatalogGeneration({ ...user, sourceId });
        expect(mirror.snapshotPath).toBe(active.snapshotPath);
        saved.value.sources[sourceId] = { logicalIdentity: mirror.logicalIdentity };
      }
      saved.value.roots.push({ pluginId: `${sourceId}/d` });
      await writeIntent(user, saved.value);
    }
    const marker = path.join(active.snapshotPath, 'plugins', 'z', 'generic', 'skills', 'z', 'README.md');
    const plan = await prepareRecovery('install', ['team/b'], user);
    const readFile = fs.readFile.bind(fs);
    let executing = false;
    let scans = 0;
    const reads = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (executing && String(args[0]) === marker) scans += 1;
      return readFile(...args);
    });
    try {
      const receipt = await executeRecovery(plan, { runtime: { debugLogger: { log: (event) => {
        if (event.data?.name === 'recovery.child.execute') executing = event.data.phase === 'start';
      } } } });
      expect(receipt).toMatchObject({ ok: true, declarationChanged: true, outputsMayHaveChanged: true,
        remainingTargets: [] });
      expect(scans).toBe(scenario === 'source alias' ? 2 : 1);
      await expect(fs.readFile(path.join(value.userRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    } finally { reads.mockRestore(); }
  });

  it.each(['same-path damage', 'new Active', 'changed ref with unchanged Store'] as const)('preserves a joint install receipt after %s between a verified provider and its waiting consumer', async (change) => {
    const value = await fixture(false, ['generic'], true, { a: [], b: ['d'], d: ['a'], z: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    const projectIntent = await fs.readFile(await resolveIntentPath(project));
    const foreign = path.join(value.projectRoot, 'foreign', 'SKILL.md');
    await fs.outputFile(foreign, 'foreign skill\n');
    const protectedFiles = await snapshotRegularTree(value.projectRoot);
    const active = await resolveActiveCatalogGeneration({ ...user, sourceId: 'team' });
    const statePath = resolveCatalogGenerationStatePath(user.env);
    let nextState: Buffer | undefined;
    if (change === 'new Active') {
      const originalState = await fs.readFile(statePath);
      await fs.appendFile(path.join(value.source, 'catalog-manifest.json'), '\n');
      const next = await syncCatalogSourceGeneration({ ...user, sourceId: 'team' });
      expect(next.active?.snapshotDigest).not.toBe(active.snapshotDigest);
      nextState = await fs.readFile(statePath);
      await fs.writeFile(statePath, originalState);
    } else if (change === 'changed ref with unchanged Store') {
      const state = await fs.readJson(statePath) as CatalogGenerationStateFileV1;
      state.sources.team!.active!.requestedRef = 'refs/heads/changed';
      nextState = Buffer.from(JSON.stringify(state));
    }
    const plan = await prepareRecovery('install', ['team/a', 'team/b'], user);
    expect(plan.receipt.blockers).toEqual([]);
    expect(plan.receipt.requestedTargets.map(({ pluginId, scope }) => `${pluginId}:${scope}`).sort())
      .toEqual(['team/a:user', 'team/b:project', 'team/b:user', 'team/d:user']);

    const damagedFile = path.join(active.snapshotPath, 'plugins', 'z', 'generic', 'skills', 'z', 'README.md');
    let changed = false;
    const receipt = await executeRecovery(plan, { runtime: { debugLogger: { log: async (event) => {
      // d waits for a. Change the source after the completed output and before d checks its scripts and files.
      if (changed || event.data?.name !== 'recovery.child.execute' || event.data.phase !== 'success') return;
      if (nextState) await fs.writeFile(statePath, nextState);
      else {
        const times = await fs.stat(damagedFile);
        await fs.writeFile(damagedFile, 'Use x.\n');
        await fs.utimes(damagedFile, times.atime, times.mtime);
      }
      changed = true;
    } } } });
    expect(changed).toBe(true);
    expect(receipt).toMatchObject({ ok: false, declarationChanged: true, outputsMayHaveChanged: true,
      errors: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale',
        ...(change === 'same-path damage' ? { subject: { sourceId: 'team' }, detail: { reasonCode: 'catalogGenerationMetadataInvalid' } } : {}) })]),
      targetResults: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'team/a', scope: 'user', execution: 'applied', observation: 'verified' }),
        expect.objectContaining({ pluginId: 'team/d', scope: 'user', execution: 'not-run' }),
        expect.objectContaining({ pluginId: 'team/b', scope: 'user', execution: 'not-run',
          blockers: expect.arrayContaining([expect.objectContaining({ code: 'dependencyApplyFailed' })]) }),
        expect.objectContaining({ pluginId: 'team/b', scope: 'project', execution: 'not-run',
          blockers: expect.arrayContaining([expect.objectContaining({ code: 'userProviderNotSatisfied' })]) }),
      ]) });
    expect(receipt.remainingTargets.map(({ pluginId, scope }) => `${pluginId}:${scope}`).sort())
      .toEqual(['team/b:project', 'team/b:user', 'team/d:user']);
    expect(receipt.recoveryActions).toEqual(expect.arrayContaining([
      'aw plugin status --context project --json', 'aw plugin sync team/b --context project --target generic',
    ]));
    expect(receipt.recoveryActions.join('\n')).not.toContain('aw plugin sync team/d');
    await expectSavedIntent(receipt, user);
    expect(receipt.intent.roots).toEqual(['team/a', 'team/b']);
    await expect(fs.readFile(await resolveIntentPath(project))).resolves.toEqual(projectIntent);
    await expect(snapshotRegularTree(value.projectRoot)).resolves.toEqual(protectedFiles);
    await expect(fs.readFile(path.join(value.userRoot, 'a', 'SKILL.md'), 'utf8')).resolves.toContain('Use a.');
    await expect(fs.pathExists(path.join(value.userRoot, 'b'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(value.userRoot, 'd'))).resolves.toBe(false);
    const hooks = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(hooks).toEqual([{ plugin: 'a', platform: 'generic', scope: 'user' }]);
    if (change === 'new Active') {
      const action = receipt.recoveryActions.find((item) => item === 'aw plugin sync team/b --context project --target generic')!;
      const capture = createCapturedCliIo();
      expect(await runCli([...action.split(' ').slice(1), '--yes', '--json'], { ...user, interactive: false, io: capture.io })).toBe(0);
      for (const [root, name] of [[value.userRoot, 'd'], [value.userRoot, 'b'], [value.projectRoot, 'b']] as const) {
        await expect(fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8')).resolves.toContain(`Use ${name}.`);
      }
      await expect(fs.readFile(await resolveIntentPath(project))).resolves.toEqual(projectIntent);
      await expectSavedIntent(receipt, user);
    }
  });

  it('counts a verified no-op as partial and retries a stale dependency through its declared root', async () => {
    const value = await fixture(false, ['generic'], false, { a: [], b: ['d'], d: ['a'] });
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
    expect((await runPublicLifecycle('install', ['team/b'], { ...user, only: 'requirements' })).status).toBe('success');
    expect((await runPublicLifecycle('sync', ['team/a'], user)).status).toBe('success');
    const statePath = resolveCatalogGenerationStatePath(user.env);
    const before = await fs.readFile(statePath);
    const next = JSON.parse(before.toString()) as CatalogGenerationStateFileV1;
    next.sources.team!.active!.requestedRef = 'refs/heads/changed';
    let moved = false;
    const result = await runPublicLifecycle('sync', ['team/a', 'team/b'], { ...value.options, context: 'project' },
      { debugLogger: { log: async (event) => {
        if (moved || event.data?.name !== 'recovery.child.execute' || event.data.phase !== 'success') return;
        moved = true;
        await fs.writeJson(statePath, next);
      } } });
    expect(moved).toBe(true);
    expect(publicExitCode(result)).toBe(4);
    expect(result.data).toMatchObject({ changes: { requirements: 'none', preferences: 'none', outputs: 'none' },
      targetResults: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'team/a', execution: 'no-op', observation: 'verified' }),
        expect.objectContaining({ pluginId: 'team/d', execution: 'not-run', blockerCodes: ['operationReviewStale'] }),
      ]) });
    const commands = result.nextActions.filter((action) => action.kind === 'command').map((action) => action.argv);
    expect(commands).toEqual([['aw', 'plugin', 'sync', 'team/b', '--context', 'project', '--target', 'generic']]);
    await fs.writeFile(statePath, before);
    const capture = createCapturedCliIo();
    expect(await runCli([...commands[0]!.slice(1), '--yes', '--json'], { ...value.options, interactive: false, io: capture.io })).toBe(0);
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'), 'utf8')).resolves.toContain('Use d.');
    await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
  });

  it.each(['intent', 'preferences'] as const)('preserves pending roots and providers after an unconfirmed %s save', async (document) => {
    const value = await fixture();
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    // A User declaration may be written from a joint Review that also observed this project.
    if (document === 'intent') await fs.remove(await resolveIntentPath({ ...value.options, scope: 'project' }));
    const file = document === 'intent' ? await resolveIntentPath(user) : await resolvePreferencesPath(user);
    const original = await fs.readFile(file);
    for (const state of ['different', 'invalid', 'absent'] as const) {
      await fs.writeFile(file, original);
      let observed = false;
      setAtomicConfigAfterRenameHookForTests(async (saved) => {
        if (saved !== file) return;
        observed = true;
        if (state === 'absent') await fs.unlink(file);
        else await fs.writeFile(file, state === 'invalid' ? '{' : original);
      });
      try {
        if (document === 'intent') {
          const result = await runPublicLifecycle('install', ['team/b'], { ...user, context: 'project' });
          const positions = ['team/d', 'team/b'].map((id) => ({ pluginId: id, target: 'generic', scope: 'user' }));
          expect(publicExitCode(result)).toBe(4);
          expect(result).toMatchObject({ data: { requirements: { state: state === 'different' ? 'valid' : state,
            roots: state === 'different' ? ['team/a'] : state === 'invalid' ? null : [] }, changes: { requirements: 'changed', outputs: 'none' },
            targetResults: positions.map((item) => ({ ...item, execution: 'not-run', observation: 'unknown', content: 'unknown' })),
            remainingTargets: positions }, nextActions: [
            { kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'] }, { kind: 'manual' },
          ] });
        } else {
          const receipt = await runRecovery('sync', ['team/a'], { ...user, preferences: { schemaVersion: 2,
            kind: 'aw-deployment-preferences', targets: ['generic', 'cursor'], exclusions: [] } });
          expect(receipt).toMatchObject({ ok: false, unconfirmedSavedState: 'preferences', preferencesChanged: true,
            declarationChanged: false, outputsMayHaveChanged: false, selection: { preferences: state === 'different' ? 'valid' : state },
            remainingTargets: ['team/d', 'team/a'].map((id) => ({ pluginId: id, agent: 'generic', scope: 'user' })),
            recoveryActions: ['aw plugin status --context user --json', expect.any(String)] });
        }
        expect(observed).toBe(true);
        if (state === 'absent') expect(await fs.pathExists(file)).toBe(false);
        else expect(await fs.readFile(file)).toEqual(state === 'invalid' ? Buffer.from('{') : original);
        expect(await fs.pathExists(value.userRoot)).toBe(false);
      } finally { setAtomicConfigAfterRenameHookForTests(undefined); }
    }
  });

  it.each(['User verified', 'User not selected', 'User not declared'] as const)(
    'retries only the failed Project location with %s', async (userState) => {
      const value = await fixture(false, ['generic'], true, { a: [], b: [] });
      const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
      const project = { ...value.options, context: 'project' as const, scope: 'project' as const };
      if (userState !== 'User not declared') expect((await runPublicLifecycle('install', ['team/b'], user)).status).toBe('success');
      if (userState !== 'User verified') await fs.remove(await resolveIntentPath(project));
      await fs.writeFile(value.hookFailure, 'b/generic/project');
      const result = userState === 'User verified'
        ? await runPublicLifecycle('sync', ['team/b'], { ...value.options, context: 'project' })
        : await runPublicLifecycle('install', ['team/b'], project);
      const failed = { pluginId: 'team/b', scope: 'project', execution: 'failed' };
      expect(result).toMatchObject({ status: 'partial', data: {
        targetResults: userState === 'User verified'
          ? [{ pluginId: 'team/b', scope: 'user', execution: 'no-op', observation: 'verified' }, failed] : [failed],
        remainingTargets: [{ pluginId: 'team/b', target: 'generic', scope: 'project' }] } });
      await expect(fs.pathExists(path.join(value.projectRoot, 'b'))).resolves.toBe(false);
      await fs.remove(value.hookFailure);
      await fs.writeFile(value.hookTrace, '');
      if (userState === 'User not declared') {
        expect(result.nextActions).toEqual([expect.objectContaining({ kind: 'command',
          argv: ['aw', 'plugin', 'sync', 'team/b', '--context', 'project', '--target', 'generic'] })]);
        const action = result.nextActions[0]!;
        if (action.kind !== 'command') throw new Error('Expected a Project sync');
        const capture = createCapturedCliIo();
        expect(await runCli([...action.argv.slice(1), '--yes', '--json'], { ...value.options, interactive: false, io: capture.io })).toBe(0);
      } else {
        expect(result.nextActions).toEqual([{ kind: 'manual', message: expect.stringContaining('Project location for team/b on generic') }]);
        const tui = new TuiController(createTuiControllerDependencies(createCliExecutionContext({ ...value.options, interactive: false })));
        onTestFinished(() => tui.dispose());
        const retry = await tui.prepareScopedTask({ kind: 'recovery', command: 'sync', selectors: ['team/b'], scope: 'project',
          targets: ['generic'], exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }] });
        expect(await tui.executeScopedTask(retry)).toMatchObject({ receipt: { ok: true, remainingTargets: [] } });
      }
      expect((await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual([{ plugin: 'b', scope: 'project', platform: 'generic' }]);
      await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    });

  it.each(['user', 'project'] as const)('retries just the selected %s root when its provider has its own declaration', async (scope) => {
    const value = await fixture(false, ['generic'], true);
    const root = scope === 'user' ? 'team/a' : 'team/b';
    const location = { ...value.options, context: scope, scope };
    const otherUser = { ...value.options, context: 'user' as const, scope: 'user' as const };
    if (scope === 'project') expect((await runPublicLifecycle('install', ['team/d'], otherUser)).status).toBe('success');
    expect((await runPublicLifecycle('install', ['team/d'], { ...location, only: 'requirements' })).status).toBe('success');
    const intents = () => Promise.all((['user', 'project'] as const).map(async (scope) =>
      fs.readFile(await resolveIntentPath({ ...value.options, scope }))));
    const before = await intents();
    await fs.writeFile(value.hookFailure, `d/generic/${scope}`);
    const failed = await runPublicLifecycle('sync', [root], { ...value.options, context: scope, targets: ['generic'] });
    expect(failed.data.request.plugins).toEqual([root]);
    const provider = failed.data.targetResults.find((item) => item.pluginId === 'team/d');
    expect(provider).toMatchObject({ scope, target: 'generic', relation: 'dependency', execution: 'failed' });
    expect([...(provider?.requiredBy ?? [])].sort()).toEqual([root, 'team/d'].sort());
    expect(failed.data.remainingTargets).toHaveLength(2);
    expect(failed.data.remainingTargets).toEqual(expect.arrayContaining([root, 'team/d'].map((pluginId) =>
      ({ pluginId, target: 'generic', scope }))));
    expect(failed.nextActions).toEqual([expect.objectContaining({ kind: 'command',
      argv: ['aw', 'plugin', 'sync', root, '--context', scope, '--target', 'generic'] })]);
    const action = failed.nextActions[0]!;
    if (action.kind !== 'command') throw new Error('Expected a retry command for the original root');
    if (scope === 'user') {
      const rebuild = createCapturedCliIo();
      const exit = await runCli([...action.argv.slice(1), '--rebuild', '--yes', '--json'],
        { ...value.options, interactive: false, io: rebuild.io });
      expect([3, 4]).toContain(exit);
      const retried = JSON.parse(rebuild.readStdout()) as typeof failed;
      expect(retried).toMatchObject({ data: { targetResults: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'team/d', relation: 'dependency', blockerCodes: expect.arrayContaining(['preApplyFailed']) }),
      ]) }, nextActions: [{ kind: 'command' }] });
      const next = retried.nextActions[0]!;
      if (next.kind !== 'command') throw new Error('Expected a root retry after rebuild failed');
      expect(next.argv.filter((value) => value !== '--rebuild')).toEqual(['aw', 'plugin', 'sync', root, '--context', scope, '--target', 'generic']);
      // Explicitly selecting both declarations still makes each failed root independently selectable in the TUI.
      const both = await runRecovery('sync', [root, 'team/d'], location);
      expect(both.targetResults.find((item) => item.pluginId === 'team/d')).toMatchObject({ relation: 'root' });
      expect(recoveryRetryTargets(both, both.targetResults).map((item) => item.pluginId).sort()).toEqual([root, 'team/d'].sort());
    }
    await fs.remove(value.hookFailure);
    await fs.writeFile(value.hookTrace, '');
    const capture = createCapturedCliIo();
    expect(await runCli([...action.argv.slice(1), '--yes', '--json'],
      { ...value.options, interactive: false, io: capture.io }), capture.readStdout()).toBe(0);
    expect((await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toEqual(['d', root.slice('team/'.length)].map((plugin) => ({ plugin, scope, platform: 'generic' })));
    const output = scope === 'user' ? value.userRoot : value.projectRoot;
    for (const name of ['d', root.slice('team/'.length)]) {
      await expect(fs.readFile(path.join(output, name, 'SKILL.md'), 'utf8')).resolves.toContain(`Use ${name}.`);
    }
    await expect(intents()).resolves.toEqual(before);
  });

  it('reports current Active after writing even when the complete reviewed Store is still readable', async () => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(project));
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);

    const old = await resolveCatalogOperationContext({ env: project.env });
    const statePath = resolveCatalogGenerationStatePath(project.env);
    const originalState = await fs.readFile(statePath);
    const pluginRoot = path.join(value.source, 'plugins', 'a');
    for (const base of [pluginRoot, path.join(pluginRoot, 'generic')]) {
      await fs.appendFile(path.join(base, 'skills', 'a', 'SKILL.md'), 'New content.\n');
    }
    const entry = await createCatalogManifestV7Entry(await readPluginManifest(pluginRoot, { mode: 'bundle' }), pluginRoot);
    const manifestPath = path.join(value.source, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, { ...manifest, entries: manifest.entries.map((item: typeof entry) =>
      item.name === entry.name ? entry : item) });
    const next = await syncCatalogSourceGeneration({ sourceId: 'team', ...project, impactConfirmed: true });
    expect(next.active?.snapshotDigest).not.toBe(old.generationSet.sources[0]!.snapshotDigest);
    // Prepare the new generation's expected bytes so a read-only status can compare both roots.
    const prepared = await prepareRecovery('install', ['team/b'], project);
    await prepared.context.dispose();
    const nextState = await fs.readFile(statePath);
    await fs.writeFile(statePath, originalState);

    // Switch the real Active pointer only after every confirmed child has finished.
    const receipt = await runRecovery('install', ['team/b'], { ...project, catalogOperationContext: old }, {
      debugLogger: { log: async (event) => {
        if (event.data?.name === 'recovery.status' && event.data.phase === 'start') await fs.writeFile(statePath, nextState);
      } },
    });
    const fresh = await readRecoveryStatus(project);
    const previous = await readRecoveryStatus({ ...project, catalogOperationContext: old });
    expect(previous).toMatchObject({ allSatisfied: true, inSync: true });
    expect(fresh).toMatchObject({ allSatisfied: false, inSync: false, coverage: { scopes: ['user', 'project'] },
      inventory: [expect.objectContaining({ pluginId: 'team/a', targetResults: [expect.objectContaining({ content: 'drifted' })] }),
        expect.objectContaining({ pluginId: 'team/b', targetResults: [expect.objectContaining({ content: 'satisfied' })] })] });
    expect(receipt).toMatchObject({ ok: true, allSatisfied: fresh.allSatisfied, inSync: fresh.inSync,
      coverage: { scopes: fresh.coverage.scopes }, requestedRoots: ['team/b'], remainingTargets: [],
      targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/b', scope: 'project', execution: 'applied', observation: 'verified' })]) });
  });

  it.each(['project unavailable', 'parent project visible', 'damaged Store'] as const)('preserves completed installation and a read-only recheck after final status finds %s', async (fault) => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    if (fault === 'parent project visible') await git(path.dirname(value.cwd), ['init', '--quiet']);
    await fs.remove(await resolveIntentPath(project));
    const active = await resolveActiveCatalogGeneration({ env: project.env, sourceId: 'team' });
    const marker = fault === 'damaged Store' ? path.join(active.snapshotPath, '.agents', 'plugins', 'marketplace.json')
      : path.join(value.cwd, '.git');
    const saved = path.join(value.cwd, 'saved-marker');
    const result = await runPublicLifecycle('install', ['team/b'], project, {
      debugLogger: { log: async (event) => {
        if (event.data?.name === 'recovery.status' && event.data.phase === 'start') await fs.rename(marker, saved);
      } },
    });
    const current = fault === 'damaged Store' ? await readRecoveryStatus(project) : undefined;
    await fs.rename(saved, marker);
    if (current) expect(current.inventory?.map((entry) => entry.sourceState)).toEqual(['unavailable', 'unavailable']);
    expect(result).toMatchObject({ status: 'partial', data: {
      changes: { requirements: 'changed', outputs: 'changed' }, allSatisfied: current?.allSatisfied ?? null,
      inSync: current?.inSync ?? null, remainingTargets: [],
      targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/b', target: 'generic', scope: 'project',
        execution: 'applied', observation: 'verified' })]) },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
        detail: { reasonCode: fault === 'damaged Store' ? 'sourceActiveUnavailable' : 'projectRootUnavailable' } })]),
      nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
        requiresConfirmation: false, reason: expect.any(String) }] });
    await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each([
    ['requested output', 'portableObservationFailed'],
    ['requested Intent', 'pluginIntentStateInvalid'],
    ['deployment preferences', 'deploymentPreferencesInvalid'],
    ['other scope Intent', null],
    ['other scope output', null],
    ['requested content drift', null],
  ] as const)('reports the completed install against a fresh status read with %s affected', async (fault, failure) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: [] });
    const project = { ...value.options, scope: 'project' as const };
    const user = { ...value.options, scope: 'user' as const };
    const projectIntent = await resolveIntentPath(project);
    await fs.remove(projectIntent);
    if (fault === 'other scope output') expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    const output = path.join(value.projectRoot, 'b', 'SKILL.md');
    const affected = fault === 'requested Intent' ? projectIntent
      : fault === 'other scope Intent' ? await resolveIntentPath(user)
      : fault === 'deployment preferences' ? await resolvePreferencesPath(project)
      : fault === 'other scope output' ? path.join(value.userRoot, 'a', 'SKILL.md') : output;
    const readFile = fs.readFile.bind(fs);
    const reads = vi.spyOn(fs, 'readFile');
    try {
      const result = await runPublicLifecycle('install', ['team/b'], project, {
        debugLogger: { log: async (event) => {
          if (event.data?.name !== 'recovery.status' || event.data.phase !== 'start') return;
          if (fault === 'requested content drift') await fs.appendFile(output, 'Local edit.\n');
          else reads.mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
            if (String(args[0]) === affected) throw Object.assign(new Error('read failed'), { code: 'EIO' });
            return readFile(...args);
          });
        } },
      });
      const current = await readRecoveryStatus(project);
      expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' },
        allSatisfied: current.allSatisfied, inSync: current.inSync, remainingTargets: [],
        targetResults: [expect.objectContaining({ pluginId: 'team/b', scope: 'project', target: 'generic',
          execution: 'applied', observation: 'verified' })] });
      if (failure) {
        expect(result).toMatchObject({ status: 'partial',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable', detail: { reasonCode: failure } })]),
          nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
            requiresConfirmation: false, reason: expect.any(String) }] });
      } else {
        expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
        expect(result.nextActions).toEqual([]);
        expect(current.allSatisfied).not.toBe(true);
      }
    } finally { reads.mockRestore(); }
    await expect(fs.readFile(output, 'utf8')).resolves.toContain('Use b.');
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each(['requested', 'independent'] as const)('attributes a final manifest read failure to its %s dependency closure', async (affected) => {
    const value = await fixture(false, ['generic'], false, { a: ['x'], b: ['c'], c: ['d'], d: [], x: [] });
    const project = { ...value.options, scope: 'project' as const };
    const user = { ...value.options, scope: 'user' as const };
    const userIntent = await observeIntent(user);
    if (userIntent.state !== 'valid') throw new Error('Expected a saved fixture Intent.');
    await writeIntent(project, userIntent.value);
    await fs.remove(await resolveIntentPath(user));
    expect((await runRecovery('sync', ['team/a'], project)).ok).toBe(true);
    await setTargets(user, ['generic', 'cursor']);
    const active = await resolveActiveCatalogGeneration({ env: project.env, sourceId: 'team' });
    const file = path.join(active.snapshotPath, 'plugins', affected === 'requested' ? 'd' : 'x', '.agents-plugin', 'plugin.json');
    const readJson = fs.readJson.bind(fs);
    const reads = vi.spyOn(fs, 'readJson');
    let manifestReads = 0;
    try {
      const result = await runPublicLifecycle('install', ['team/b'], { ...project, targets: ['generic'] }, {
        debugLogger: { log: (event) => {
          if (event.data?.name !== 'recovery.status' || event.data.phase !== 'start') return;
          reads.mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
            // Let Active validate the file. Fail its subsequent demand-manifest read once.
            if (String(args[0]) === file && ++manifestReads === 2) throw Object.assign(new Error('read failed'), { code: 'EIO' });
            return readJson(...args);
          });
        } },
      });
      expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' }, remainingTargets: [],
        targetResults: ['d', 'c', 'b'].map((name) => expect.objectContaining({ pluginId: `team/${name}`, scope: 'project',
          target: 'generic', execution: 'applied', observation: 'verified' })) });
      if (affected === 'requested') {
        expect(result).toMatchObject({ status: 'partial',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
            subject: { pluginId: 'team/b', scope: 'project', target: 'generic' }, detail: { reasonCode: 'pluginManifestUnavailable' } })]),
          nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
            requiresConfirmation: false, reason: expect.any(String) }] });
      } else expect(result).toMatchObject({ status: 'success', nextActions: [] });
      manifestReads = 0;
      const current = await readRecoveryStatus(project);
      const independent = affected === 'requested' ? 'team/a' : 'team/b';
      expect(current.inventory?.find((root) => root.pluginId === independent)?.targetResults.find((target) => target.agent === 'generic'))
        .toMatchObject({ content: 'satisfied', blockers: [] });
      const unavailable = current.inventory?.find((root) => root.pluginId !== independent);
      expect(unavailable?.targetResults.find((target) => target.agent === 'generic')).toMatchObject({
        content: 'unknown', blockers: [expect.objectContaining({ code: 'pluginManifestUnavailable' })] });
      expect(unavailable?.targetResults.find((target) => target.agent === 'cursor')).toMatchObject({
        satisfaction: 'unsupported', observation: 'verified', blockers: [] });
      expect(result.data).toMatchObject({ allSatisfied: current.allSatisfied, inSync: current.inSync });
    } finally { reads.mockRestore(); }
    await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
  });

  it.each([
    ['generic', 'shared'], ['generic', 'disjoint'], ['opencode', 'shared'], ['generic', 'project root'],
  ] as const)('attributes a final User manifest read failure on %s with a %s dependency', async (target, relation) => {
    const sharesDependency = relation !== 'disjoint';
    const ambiguous = target === 'generic' && relation === 'shared';
    const value = await fixture(false, [target], true, { a: ['x'], x: [sharesDependency ? 'd' : 'e'], b: ['d'], d: [], e: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(project));
    await setTargets(user, [target]);
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    if (relation === 'project root') expect((await runPublicLifecycle('install', ['team/d'], project)).status).toBe('success');
    await fs.writeFile(value.hookTrace, '');
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'), ['recovery.status']);
    try {
      const result = await runPublicLifecycle('install', ['team/b'], project, fault.runtime);
      expect(result).toMatchObject({ status: ambiguous ? 'partial' : 'success', data: { changes: { requirements: 'changed', outputs: 'changed' },
        allSatisfied: null, remainingTargets: [], targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/b', target,
          scope: 'project', execution: 'applied', observation: 'verified' })]) } });
      if (ambiguous) expect(result).toMatchObject({
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
          subject: { pluginId: 'team/b', scope: 'project', target: 'generic' }, detail: { reasonCode: 'jointDemandUnknown' } })]),
        nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
          requiresConfirmation: false, reason: expect.any(String) }] });
      else expect(result.nextActions).toEqual([]);
    } finally { fault.restore(); }
    const hooks: Array<{ plugin: string; scope: string }> = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(hooks.filter((event) => event.plugin === 'b')).toEqual([{ plugin: 'b', platform: target, scope: 'project' }]);
    const skill = (scope: 'user' | 'project', name: string) => path.join(target === 'opencode'
      ? value.nativeSkill(target, scope, name) : path.join(scope === 'user' ? value.userRoot : value.projectRoot, name), 'SKILL.md');
    await expect(fs.readFile(skill('project', 'b'), 'utf8')).resolves.toContain('Use b.');
    await expect(fs.pathExists(skill('user', 'd'))).resolves.toBe(sharesDependency);
    await expect(fs.pathExists(skill('project', 'd'))).resolves.toBe(!ambiguous);
    await expect(readRecoveryStatus(project)).resolves.toMatchObject({ allSatisfied: true });
  });

  it.each(['required', 'required at recheck', 'independent'] as const)('protects an explicitly removed User provider according to its %s Project dependency', async (relation) => {
    const required = relation !== 'independent';
    const value = await fixture(false, ['generic'], false, { a: [], b: ['x'], x: [required ? 'a' : 'd'], d: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'),
      [...(relation === 'required at recheck' ? [] : ['recovery.plan']), 'recovery.locked.demand', 'recovery.locked.recheck']);
    const before = await observeIntent(user);
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], user, fault.runtime);
      if (required) {
        expect(result).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: relation === 'required at recheck'
            ? 'operationReviewStale' : 'dependencyStillRequired' })]) });
        expect(await observeIntent(user)).toEqual(before);
      } else expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' } });
    } finally { fault.restore(); }
    await expect(fs.pathExists(path.join(value.userRoot, 'a/SKILL.md'))).resolves.toBe(required);
    await expect(fs.pathExists(path.join(value.projectRoot, 'a'))).resolves.toBe(false);
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each(['verified', 'absent', 'drifted', 'unowned', 'copy lost under lock', 'manifest lost under lock'] as const)('checks the Project copy (%s) before removing a User provider with an unreadable consumer', async (copy) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: ['x'], x: ['a'] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    expect((await runPublicLifecycle('install', ['team/b', 'team/a'], project)).status).toBe('success');
    const projectCopy = path.join(value.projectRoot, 'a/SKILL.md');
    const userCopy = path.join(value.userRoot, 'a/SKILL.md');
    const projectFiles = await snapshotRegularTree(path.dirname(projectCopy));
    const before = await fs.readFile(projectCopy, 'utf8');
    expect(await fs.readFile(userCopy, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(value.projectRoot, 'x/SKILL.md'), 'utf8')).toContain('Use x.');
    if (copy === 'absent') await fs.remove(path.dirname(projectCopy));
    if (copy === 'drifted') await fs.appendFile(projectCopy, 'Local edit.\n');
    if (copy === 'unowned') await fs.remove(path.join(path.dirname(projectCopy), SKILL_OWNER_MARKER));
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'),
      [...(copy === 'manifest lost under lock' ? [] : ['recovery.plan']), 'recovery.locked.demand', 'recovery.locked.recheck']);
    const projectIntent = await observeIntent(project);
    const userIntent = await observeIntent(user);
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], user, { debugLogger: { log: async (event) => {
        await fault.runtime.debugLogger!.log(event);
        if (copy === 'copy lost under lock' && event.data?.name === 'recovery.locked.demand' && event.data.phase === 'start') {
          await fs.remove(path.dirname(projectCopy));
        }
      } } });
      if (copy === 'verified') {
        expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' } });
        expect(await fs.pathExists(userCopy)).toBe(false);
        expect(await snapshotRegularTree(path.dirname(projectCopy))).toEqual(projectFiles);
        await expect(observeIntent(user)).resolves.toMatchObject({ value: { roots: [] } });
      } else {
        expect(result).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: copy.endsWith('under lock')
            ? 'operationReviewStale' : 'dependencyStillRequired' })]) });
        expect(await fs.readFile(userCopy, 'utf8')).toBe(before);
        expect(await observeIntent(user)).toEqual(userIntent);
      }
      expect(await observeIntent(project)).toEqual(projectIntent);
    } finally { fault.restore(); }
  });

  it.each(['changed', 'invalid'] as const)('detects a %s second Intent before any output write', async (state) => {
    const value = await fixture();
    const plan = await prepareRecovery('sync', ['team/a'], value.options);
    const location = { ...value.options, scope: 'project' as const };
    if (state === 'invalid') await fs.writeFile(await resolveIntentPath(location), '{broken');
    else await writeIntent(location, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const result = await executeRecovery(plan);
    expect(result.ok).toBe(false);
    expect(result.declarationChanged).toBe(false);
    expect(result.blockers.some((item) => item.code === 'operationReviewStale')).toBe(true);
    expect(result.remainingTargets).toEqual(plan.receipt.requestedTargets);
    expect(result.targetResults).toMatchObject(['team/d', 'team/a'].map((pluginId) => ({
      pluginId, agent: 'generic', scope: 'user', execution: 'not-run', observation: 'unknown', content: 'unknown',
    })));
    if (state === 'invalid') {
      expect(result.intent).toMatchObject({ state: 'invalid', roots: null, digest: expect.any(String) });
      expect(result.errors.some((item) => item.code === 'pluginIntentStateInvalid')).toBe(true);
    } else await expectSavedIntent(result, location);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
  }, 30000);
  it('preserves a rejected Intent write diagnostic and creates no outputs', async () => {
    const value = await fixture();
    const location = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(location));
    const userBefore = await observeIntent({ ...value.options, scope: 'user' });
    await fs.writeFile(path.join(value.cwd, '.gitignore'), '/.agent-workflows/\n');
    await expect(runRecovery('install', ['team/b'], location)).rejects.toThrow('projectConfigIgnored');
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect(await observeIntent({ ...value.options, scope: 'user' })).toEqual(userBefore);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
    expect(await fs.pathExists(value.projectRoot)).toBe(false);
  }, 30000);
  it('clears reviewed target outputs while keeping both Intent documents', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await setTargets({ ...value.options, scope: 'user' }, []);
    const result = await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(result.outputsMayHaveChanged).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toMatchObject({ value: { roots: [{ pluginId: 'team/a' }] } });
  }, 30000);
  // Test Value Gate: a foreign replacement preserves prior Native output; an independent Native target can still finish.
  it('preserves prior Native outputs when a generic replacement conflicts and still permits safe work', async () => {
    const value = await fixture(false, ['generic', 'opencode', 'cursor'], ['d']);
    await setTargets({ ...value.options, scope: 'user' }, ['opencode']);
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const oldUser = path.join(value.nativeSkill('opencode', 'user', 'a'), 'SKILL.md');
    const oldProject = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const oldDependencyPaths = (['user', 'project'] as const).map((scope) => path.join(value.nativeSkill('opencode', scope, 'd'), 'SKILL.md'));
    const oldDependencyBytes = await Promise.all(oldDependencyPaths.map((file) => fs.readFile(file)));
    const oldContents = await Promise.all([fs.readFile(oldUser, 'utf8'), fs.readFile(oldProject, 'utf8')]);
    const foreignUser = path.join(value.userRoot, 'a', 'SKILL.md');
    const foreignProject = path.join(value.projectRoot, 'b', 'SKILL.md');
    await fs.outputFile(foreignUser, 'Foreign User replacement.');
    await fs.outputFile(foreignProject, 'Foreign Project replacement.');
    await setTargets({ ...value.options, scope: 'user' }, ['generic']);
    const conflicted = await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.errors.some((error) => error.code === 'portableOutputConflict')).toBe(true);
    expect(conflicted.outputsMayHaveChanged, JSON.stringify(conflicted)).toBe(true);
    expect(conflicted.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/d', agent: 'generic', scope: 'user', execution: 'applied',
      observation: 'verified', content: 'satisfied', blockers: [],
    }));
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'), 'utf8')).resolves.toContain('Use d.');
    expect(conflicted.targetResults).not.toContainEqual(expect.objectContaining({ agent: 'opencode', execution: 'applied' }));
    expect(await Promise.all(oldDependencyPaths.map((file) => fs.readFile(file)))).toEqual(oldDependencyBytes);
    await expect(fs.readFile(foreignUser, 'utf8')).resolves.toBe('Foreign User replacement.');
    expect(await Promise.all([fs.readFile(oldUser, 'utf8'), fs.readFile(oldProject, 'utf8')])).toEqual(oldContents);
    expect(await fs.readFile(foreignProject, 'utf8')).toBe('Foreign Project replacement.');

    await setTargets({ ...value.options, scope: 'user' }, ['generic', 'cursor']);
    const partial = await runRecovery('sync', [], { ...value.options, context: 'user', retireUnselectedTargets: true });
    expect(partial.ok).toBe(false);
    const safeOutput = path.join(value.nativeSkill('cursor', 'user', 'a'), 'SKILL.md');
    expect(await fs.pathExists(safeOutput)).toBe(true);
    expect(await fs.readFile(oldUser, 'utf8')).toBe(oldContents[0]);

    await setTargets({ ...value.options, scope: 'user' }, []);
    await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(await fs.pathExists(oldUser)).toBe(false);
    expect(await fs.pathExists(oldProject)).toBe(false);
    expect(await fs.pathExists(safeOutput)).toBe(false);
    expect(await fs.readFile(foreignUser, 'utf8')).toBe('Foreign User replacement.');
    expect(await fs.readFile(foreignProject, 'utf8')).toBe('Foreign Project replacement.');
    expect(await observeIntent({ ...value.options, scope: 'user' })).toMatchObject({ value: { roots: [{ pluginId: 'team/a' }] } });
  }, 30000);
  // Test Value Gate: scope switch hooks must run before deleting a working
  // provider, and failure must not prevent another target from switching.
  it('retains project providers when user preApply fails and switches an independent target once', async (test) => {
    const timing = createCommandTestTiming(test);
    const runtime = (commandSequence: number): RebuildCommandRuntime => ({
      debugLogger: { log: (event) => timing.commandEvent(commandSequence, event) },
    });
    const value = await timing.measure('fixture', 'provider switch', async () => {
      const value = await fixture(false, ['generic', 'opencode'], true);
      await writeIntent({ ...value.options, scope: 'user' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
      await setTargets({ ...value.options, scope: 'user' }, ['generic', 'opencode']);
      return value;
    });
    expect((await timing.measure('command', 'initial sync', (sequence) =>
      runRecovery('sync', [], value.options, runtime(sequence)))).ok).toBe(true);
    const oldProvider = path.join(value.projectRoot, 'd', 'SKILL.md');
    const oldConsumer = path.join(value.projectRoot, 'b', 'SKILL.md');
    const projectNative = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const projectNativeBefore = await fs.readFile(projectNative);
    const oldContents = await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')]);
    await fs.writeFile(value.hookTrace, '');
    const denied = await timing.measure('command', 'unauthorized install', async (sequence) => {
      const unauthorized = await prepareRecovery('install', ['team/b'], { ...value.options, scope: 'user', yes: false }, runtime(sequence));
      return executeRecovery(unauthorized, { yes: false });
    });
    expect(denied.ok).toBe(false);
    expect(denied.declarationChanged).toBe(true);
    await expectSavedIntent(denied, { ...value.options, scope: 'user' });
    expect(denied.errors.some((error) => error.code === 'preApplyAuthorizationRequired')).toBe(true);
    expect(await fs.readFile(value.hookTrace, 'utf8')).toBe('');
    expect(await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')])).toEqual(oldContents);
    await fs.writeFile(value.hookFailure, 'd/generic/user');

    const result = await timing.measure('command', 'install with failing preApply', (sequence) =>
      runRecovery('install', ['team/b'], { ...value.options, scope: 'user' }, runtime(sequence)));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === 'providerSwitchPreApplyFailed'), JSON.stringify(result)).toBe(true);
    expect(result.declarationChanged).toBe(false);
    await expectSavedIntent(result, { ...value.options, scope: 'user' });
    expect(await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')])).toEqual(oldContents);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'b'))).toBe(false);
    const userNative = (name: string) => value.nativeSkill('opencode', 'user', name);
    expect(await fs.pathExists(path.join(userNative('d'), 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(userNative('b'), 'SKILL.md'))).toBe(true);
    await expect(fs.readFile(projectNative)).resolves.toEqual(projectNativeBefore);
    const events = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events, JSON.stringify(events)).toHaveLength(5);
    expect(events).toEqual(expect.arrayContaining([
      { plugin: 'd', platform: 'generic', scope: 'user' },
      { plugin: 'd', platform: 'opencode', scope: 'user' },
      { plugin: 'b', platform: 'opencode', scope: 'user' },
      { plugin: 'd', platform: 'opencode', scope: 'project' },
      { plugin: 'b', platform: 'opencode', scope: 'project' },
    ]));
  }, process.platform === 'win32' ? 60_000 : 30_000);
  it('keeps a failed user provider at user scope and blocks its project consumer', async () => {
    const value = await fixture();
    const foreign = path.join(value.userRoot, 'd', 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign content.');
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'userProviderNotSatisfied'), JSON.stringify(result, null, 2)).toBe(true);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign content.');
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
  }, 30000);
  it('moves a shared dependency to project and cleans it after the last project root is removed', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const removed = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user',
      exactTargets: [{ pluginId: 'team/a', agent: 'generic', scope: 'user' }] });
    expect(removed.ok, JSON.stringify(removed, null, 2)).toBe(true);
    await expectSavedIntent(removed, { ...value.options, scope: 'user' });
    expect(removed.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const last = await runRecovery('uninstall', ['team/b'], { ...value.options, scope: 'project',
      exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }] });
    expect(last.ok).toBe(true);
    await expectSavedIntent(last, { ...value.options, scope: 'project' });
    expect(last.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(last.inSync).toBe(true);
  }, 30000);
  // Test Value Gate: independent Native scopes cannot replace or protect each
  // other's released dependencies; keep and a same-scope declaration retain them.
  it.each([
    { scope: 'user', keep: false, directRoot: 'none' },
    { scope: 'user', keep: true, directRoot: 'none' },
    { scope: 'project', keep: false, directRoot: 'none' },
    { scope: 'project', keep: true, directRoot: 'none' },
    { scope: 'user', keep: false, directRoot: 'other' },
    { scope: 'user', keep: true, directRoot: 'other' },
    { scope: 'project', keep: false, directRoot: 'other' },
    { scope: 'project', keep: true, directRoot: 'other' },
    { scope: 'user', keep: false, directRoot: 'selected' },
    { scope: 'project', keep: false, directRoot: 'selected' },
  ] as const)('removes only the selected independent Native scope with retention=$keep ($scope, direct root=$directRoot)', async ({ scope, keep, directRoot }) => {
    const value = await fixture(false, ['opencode'], ['d']);
    await setTargets({ ...value.options, scope: 'user' }, ['opencode']);
    const otherScope = scope === 'user' ? 'project' : 'user';
    if (directRoot !== 'none') {
      const location = { ...value.options, scope: directRoot === 'other' ? otherScope : scope };
      const intent = await observeIntent(location);
      if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent(location, { ...intent.value,
        roots: [...(directRoot === 'selected' ? intent.value.roots : []), { pluginId: 'team/d' }],
      });
    }
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const root = scope === 'user' ? 'a' : 'b';
    const otherRoot = directRoot === 'other' ? 'd' : scope === 'user' ? 'b' : 'a';
    const retainDependency = keep || directRoot === 'selected';
    const packageRoot = (currentScope: 'user' | 'project', name: string) =>
      path.resolve(value.nativeSkill('opencode', currentScope, name), '../..');
    const otherIntent = await observeIntent({ ...value.options, scope: otherScope });
    const protectedRoots = [...new Set([otherRoot, 'd'])].map((name) => packageRoot(otherScope, name));
    const protectedBefore = await Promise.all(protectedRoots.map(snapshotRegularTree));
    const dependencyBefore = await snapshotRegularTree(packageRoot(scope, 'd'));
    expect(Object.keys(dependencyBefore).length).toBeGreaterThan(0);
    const foreign = path.join(path.dirname(packageRoot(scope, root)), 'foreign.txt');
    await fs.outputFile(foreign, 'Keep foreign content.');
    const plan = await prepareRecovery('uninstall', [`team/${root}`], {
      ...value.options, scope, keepDependencies: keep,
    });
    try {
      expect(plan.dependencyCleanupTargets).toEqual(retainDependency ? [] : [{ pluginId: 'team/d', agent: 'opencode', scope }]);
      expect(plan.joint?.children.flatMap((child) => child.receipt.requestedTargets)
        .map((target) => `${target.pluginId}@${target.scope}`).sort())
        .toEqual((retainDependency ? [`team/${root}@${scope}`] : [`team/${root}@${scope}`, `team/d@${scope}`]).sort());
      const removed = await executeRecovery(plan, { yes: true });
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      expect(removed.intent.roots).toEqual(directRoot === 'selected' ? ['team/d'] : []);
      expect(removed.remainingTargets).toEqual([]);
      if (!keep) expect((await readRecoveryStatus(value.options)).extraObserved).toEqual([]);
      expect(await fs.pathExists(packageRoot(scope, root))).toBe(false);
      if (retainDependency) expect(await snapshotRegularTree(packageRoot(scope, 'd'))).toEqual(dependencyBefore);
      else {
        expect(await fs.pathExists(packageRoot(scope, 'd'))).toBe(false);
        expect(removed.targetResults).toContainEqual(expect.objectContaining({
          pluginId: 'team/d', agent: 'opencode', scope, relation: 'dependency', execution: 'applied',
        }));
      }
      expect(await Promise.all(protectedRoots.map(snapshotRegularTree))).toEqual(protectedBefore);
      expect(await observeIntent({ ...value.options, scope: otherScope })).toEqual(otherIntent);
      expect(await fs.readFile(foreign, 'utf8')).toBe('Keep foreign content.');
    } finally { await plan.context.dispose(); }
  }, 30000);
  // Removing a root must preserve independent declarations and live consumers,
  // while a dependency-only update must not create an Intent root.
  it('updates a precise indirect dependency without changing either Intent', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const before = await Promise.all(['user', 'project'].map((scope) => observeIntent({ ...value.options, scope: scope as 'user' | 'project' })));
    const updated = await runRecovery('reinstall', ['team/d'], { ...value.options, scope: 'user', allowDependencySelectors: true,
      exactTargets: [{ pluginId: 'team/d', agent: 'generic' }] });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    expect(updated.targetResults.map((target) => target.pluginId)).toEqual(['team/d']);
    expect(updated.declarationChanged).toBe(false);
    expect(await Promise.all(['user', 'project'].map((scope) => observeIntent({ ...value.options, scope: scope as 'user' | 'project' })))).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('blocks indirect dependency removal and allows force without removing its consumers', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const location = { ...value.options, scope: 'user' as const };
    const before = await observeIntent(location);
    const blocked = await runRecovery('uninstall', ['team/d'], location);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(true);
    const forced = await runRecovery('uninstall', ['team/d'], { ...location, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(forced.declarationChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(forced.allSatisfied).toBe(false);
  }, 30000);

  it('cleans a transitive orphan closure but preserves a directly declared dependency', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    const project = { ...value.options, scope: 'project' as const };
    await writeIntent(project, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const user = { ...value.options, scope: 'user' as const };
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const planned = await prepareRecovery('uninstall', ['team/a'], user);
    try {
      expect(planned.dependencyCleanupTargets?.map((target) => target.pluginId).sort()).toEqual(['team/b', 'team/d']);
      const result = await executeRecovery(planned, { yes: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name))))).toEqual([false, false, false]);
    } finally { await planned.context.dispose(); }
    expect((await runRecovery('install', ['team/a', 'team/d'], user)).ok).toBe(true);
    expect((await runRecovery('uninstall', ['team/a'], user)).ok).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('preserves an orphan dependency needed by an installed consumer whose Intent was removed', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('keeps an installed dependency out of removal when the other scope cannot read its provider manifest', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: ['x'], x: ['d'], d: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    // Only the user root is installed. The saved project requirement still protects its provider.
    expect((await runRecovery('install', ['team/a'], user)).ok).toBe(true);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: project.env });
    const file = path.join(active.snapshotPath, 'plugins', 'x', '.agents-plugin', 'plugin.json');
    const readJson = fs.readJson.bind(fs);
    let manifestReads = 0;
    const reads = vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
      if (String(args[0]) === file && ++manifestReads === 2) throw Object.assign(new Error('read failed'), { code: 'EIO' });
      return readJson(...args);
    });
    try {
      const plan = await prepareRecovery('uninstall', ['team/a'], user);
      try {
        expect(plan.joint?.demand.roots).toContainEqual(expect.objectContaining({ pluginId: 'team/b', scope: 'project',
          state: 'unknown', blockers: [expect.objectContaining({ code: 'pluginManifestUnavailable' })] }));
        expect(plan.joint?.demand.complete).toBe(false);
        expect(plan.dependencyCleanupTargets).toEqual([]);
        expect(plan.receipt.requestedTargets.map((target) => target.pluginId)).toEqual(['team/a']);
        const removed = await executeRecovery(plan, { yes: true, runtime: { debugLogger: { log: (event) => {
          if (event.data?.phase === 'start' && ['recovery.locked.demand', 'recovery.locked.recheck'].includes(String(event.data.name))) {
            manifestReads = 0;
          }
        } } } });
        expect(removed).toMatchObject({ declarationChanged: true,
          targetResults: [expect.objectContaining({ pluginId: 'team/a', execution: 'applied' })] });
      } finally { await plan.context.dispose(); }
    } finally { reads.mockRestore(); }
    await expect(fs.pathExists(path.join(value.userRoot, 'a'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).resolves.toBe(true);
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it('retains the transitive dependencies when deleting their consumer fails', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === path.join(value.userRoot, 'a')) throw new Error('EACCES');
      return rename(source, destination);
    });
    try {
      const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md'))))).toEqual([true, true, true]);
    } finally { failure.mockRestore(); }
  }, 30000);

  it('retains a shared leaf when a consumer on the second dependency path fails to delete', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === path.join(value.userRoot, 'c')) throw new Error('EACCES');
      return rename(source, destination);
    });
    try {
      const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
      expect(result.ok).toBe(false);
      expect(result.targetResults.find((target) => target.pluginId === 'team/d')?.blockers)
        .toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await Promise.all(['a', 'b', 'c', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
        .toEqual([false, false, true, true]);
    } finally { failure.mockRestore(); }
  }, 30000);

  it('retains dependencies when a possible current-project consumer cannot be identified', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    await fs.writeFile(path.join(value.projectRoot, 'b', SKILL_OWNER_MARKER), '{broken');
    expect((await readRecoveryStatus(value.options)).coverage.portable).toBe(false);
    const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
  }, 30000);

  it.for([false, true])('keeps exact removal pairs and protects unselected consumers (shared=%s)', async (shared, test) => {
    const timing = createCommandTestTiming(test);
    const runtime = (sequence: number): RebuildCommandRuntime => ({
      debugLogger: { log: (event) => timing.commandEvent(sequence, event) },
    });
    const graph = shared ? { a: ['d'], b: ['d'], d: [] } : { a: ['d'], b: ['e'], d: [], e: [] };
    const value = await timing.measure('fixture', 'exact removal catalog', () => fixture(false, ['generic', 'opencode'], false, graph));
    await setTargets({ ...value.options, scope: 'user' }, ['generic', 'opencode']);
    await writeIntent({ ...value.options, scope: 'user' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/a' }, { pluginId: 'team/b' }] });
    expect((await timing.measure('command', 'initial sync', (sequence) => runRecovery('sync', [], value.options, runtime(sequence)))).ok).toBe(true);
    const plan = await timing.measure('command', 'prepare exact removal', (sequence) =>
      prepareRecovery('uninstall', ['team/a', 'team/b'], { ...project, targets: ['generic', 'opencode'],
        exactTargets: [{ pluginId: 'team/a', agent: 'generic' }, { pluginId: 'team/b', agent: 'opencode' }] }, runtime(sequence)));
    try {
      expect(plan.dependencyCleanupTargets?.map((target) => `${target.pluginId}@${target.agent}`).sort())
        .toEqual(shared ? [] : ['team/d@generic', 'team/e@opencode']);
      expect(plan.receipt.requestedTargets.map((target) => `${target.pluginId}@${target.agent}`).sort())
        .toEqual(shared ? ['team/a@generic', 'team/b@opencode'] : ['team/a@generic', 'team/b@opencode', 'team/d@generic', 'team/e@opencode']);
      const result = await timing.measure('command', 'execute exact removal', (sequence) =>
        executeRecovery(plan, { yes: true, runtime: runtime(sequence) }));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const exists = (name: string, agent: 'generic' | 'opencode') => fs.pathExists(path.join(
        agent === 'generic' ? path.join(value.projectRoot, name) : value.nativeSkill('opencode', 'project', name), 'SKILL.md'));
      expect(await Promise.all([exists('a', 'generic'), exists('a', 'opencode'), exists('b', 'generic'), exists('b', 'opencode')]))
        .toEqual([false, true, true, false]);
      expect(await Promise.all([exists('d', 'generic'), exists('d', 'opencode')])).toEqual([shared, true]);
      if (!shared) expect(await Promise.all([exists('e', 'generic'), exists('e', 'opencode')])).toEqual([true, false]);
    } finally { await plan.context.dispose(); }
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it.each([false, true])('removes a root and selected leaf while respecting intermediate retention (keep=%s)', async (keep) => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const result = await runRecovery('uninstall', ['team/a', 'team/d'], { ...value.options, scope: 'user', keepDependencies: keep });
    expect(result.ok, JSON.stringify(result)).toBe(!keep);
    if (keep) expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
      .toEqual([keep, keep, keep]);
  }, 30000);

  it('removes a project declaration while preserving the user provider used by a user consumer', async () => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const projectProvider = path.join(value.projectRoot, 'd', 'SKILL.md');
    await expect(fs.readFile(projectProvider, 'utf8')).resolves.toContain('Use d.');
    const userProvider = await fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'));
    const userIntent = await observeIntent({ ...value.options, scope: 'user' });
    const result = await runRecovery('uninstall', ['team/d'], project);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.intent.roots).toEqual([]);
    expect(result.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/d', agent: 'generic', scope: 'project', execution: 'applied', observation: 'missing', content: 'absent',
    }));
    await expect(fs.pathExists(path.dirname(projectProvider))).resolves.toBe(false);
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'))).resolves.toEqual(userProvider);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toEqual(userIntent);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('does not replace a live user consumer dependency with a project-only provider', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    const before = await observeIntent(user);
    const result = await runRecovery('uninstall', ['team/d'], user);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(user)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('blocks an indirect provider switch that would strand an existing user consumer', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: ['d'], d: [], x: ['d'] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    expect((await runRecovery('install', ['team/x'], user)).ok).toBe(true);
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/a' }] });
    const before = await observeIntent(user);
    for (const force of [false, true]) {
      const result = await runRecovery('uninstall', ['team/a'], { ...user, force });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await observeIntent(user)).toEqual(before);
      expect(await Promise.all(['a', 'd', 'x'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
        .toEqual([true, true, true]);
    }
  }, 30000);

  it('requires force when a live consumer dependency graph is no longer available in Active', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    await fs.remove(path.join(value.source, 'plugins', 'a'));
    await createDependencyCatalogSnapshotFixture(value.source, [
      { name: 'b', dependencies: ['d'] }, { name: 'd' },
    ].map((entry) => ({ ...entry, configureManifest: (manifest) => {
      manifest.platforms = ['generic']; manifest.skills = './skills'; delete manifest.extensions;
    } })));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: value.options.env });
    const status = await readRecoveryStatus(value.options);
    expect(status.coverage.portable).toBe(true);
    expect(status.existingTargets).toContainEqual({ pluginId: 'team/a', agent: 'generic', scope: 'user' });
    const before = await observeIntent(user);
    const blocked = await runRecovery('uninstall', ['team/d'], user);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(user)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    const forced = await runRecovery('uninstall', ['team/d'], { ...user, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
  }, 30000);
  it('does not install missing outputs during configuration apply', async () => {
    const value = await fixture();
    const result = await runRecovery('sync', ['team/a', 'team/d', 'team/b'], { ...value.options, existingOnly: true });
    expect(result.ok).toBe(false);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
    expect(await fs.pathExists(value.projectRoot)).toBe(false);
  }, 30000);

  it('blocks cross-scope Skill names from different plugins before creating outputs', async () => {
    const value = await fixture(true);
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'crossScopeSkillCollision')).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'a'))).toBe(false);
  }, 30000);

  it('continues an independent source while a missing source and its project consumer remain blocked', async () => {
    const value = await fixture();
    for (const scope of ['user', 'project'] as const) {
      const observed = await observeIntent({ ...value.options, scope });
      if (observed.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent({ ...value.options, scope }, { ...observed.value,
        sources: { ...observed.value.sources, missing: { logicalIdentity: 'catalog:missing' } },
        roots: [...observed.value.roots, { pluginId: scope === 'user' ? 'missing/provider' : 'missing/consumer' }],
      });
    }
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'sourceMissing')).toBe(true);
    expect(result.remainingTargets.map(({ pluginId, scope, agent }) => [pluginId, scope, agent])).toEqual([
      ['missing/provider', 'user', 'generic'], ['missing/consumer', 'project', 'generic'],
    ]);
    for (const remaining of result.remainingTargets) expect(result.targetResults.find((item) => item.pluginId === remaining.pluginId))
      .toMatchObject({ execution: 'not-run', observation: 'unknown', content: 'unknown', satisfaction: 'unknown' });
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'provider'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'consumer'))).toBe(false);
    const status = await readRecoveryStatus(value.options);
    expect(status.allSatisfied).toBeNull();
    expect(status.inventory?.find((entry) => entry.pluginId === 'missing/consumer')?.targetResults[0]).toMatchObject({
      content: 'unknown', blockers: [expect.objectContaining({ code: 'sourceMissing' })],
    });
  }, 30000);

});

describe('independent native package publication', () => {
  // Test Value Gate: both owners must publish under the same OpenCode root without losing a sibling package.
  it('copies two reviewed OpenCode packages concurrently and reads back both owners and skills', async () => {
    installNativeTestQualification({ discovery: true });
    const value = await fixture(false, ['opencode'], false, { a: [], b: [], d: [] });
    const options = { ...value.options, scope: 'user' as const };
    await setTargets(options, ['opencode']);
    const plan = await prepareRecovery('install', ['team/a', 'team/d'], { ...options, targets: ['opencode'] });
    const parallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
    const packageRoot = path.dirname(path.dirname(value.nativeSkill('opencode', 'user', 'a')));
    const root = path.dirname(packageRoot);
    const copy = fs.copy.bind(fs);
    const arrived = new Set<string>();
    const gate = Promise.withResolvers<void>();
    let timer: NodeJS.Timeout | undefined;
    const spy = vi.spyOn(fs, 'copy').mockImplementation(async (source: string, dest: string, opts?: fs.CopyOptions) => {
      if (path.dirname(path.dirname(dest)) === root && path.basename(path.dirname(dest)).startsWith('.aw-package-')) {
        arrived.add(dest);
        if (arrived.size === 2) gate.resolve();
        timer ??= setTimeout(() => gate.reject(new Error('Independent package publication did not start.')), 3000);
        await gate.promise;
      }
      return copy(source, dest, opts);
    });
    try {
      const result = await executeRecovery(plan, { yes: true });
      expect(result.ok, JSON.stringify(result.targetResults)).toBe(true);
      expect(arrived.size).toBe(2);
      for (const name of ['a', 'd']) {
        const skill = value.nativeSkill('opencode', 'user', name);
        expect(await fs.readFile(path.join(skill, 'SKILL.md'), 'utf8')).toContain(`Use ${name}.`);
        const marker = await fs.readJson(path.join(path.dirname(path.dirname(skill)), SKILL_OWNER_MARKER));
        expect(marker).toMatchObject({ pluginId: `team/${name}`, platform: 'opencode' });
      }
    } finally {
      clearTimeout(timer);
      spy.mockRestore();
      parallelism.mockRestore();
      await plan.context.dispose();
    }
  });
});

describe('native install with shared registration', () => {
  beforeEach(() => { installNativeTestQualification({ discovery: true }); });

  it.each(['install', 'sync', 'rebuild'] as const)('blocks %s publication after a Project hook changes a transitive User provider', async (command) => {
    const claude = await createClaudeNativeTestRuntime(getCurrentSourceTestIsolation());
    const graph = { a: ['d'], b: ['d'], d: [], q: ['a', 'b'], r: ['a', 'b'], s: [] };
    const value = await fixture(false, ['claude'], ['r', 'q'], graph, undefined, 'r');
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const, targets: ['claude'] };
    const project = { ...value.options, context: 'project' as const, targets: ['claude'] };
    const runtime = { nativeCliRunner: claude.nativeCliRunner };
    await setTargets(user, ['claude']);
    for (const [location, names] of [[user, ['d']], [project, command === 'install' ? ['q'] : ['q', 'r', 's']]] as const) {
      const intent = await observeIntent(location);
      if (intent.state !== 'valid') throw new Error('Missing fixture Intent.');
      await writeIntent(location, { ...intent.value, roots: names.map((name) => ({ pluginId: `team/${name}` })) });
    }
    const registrations = async () => (await fs.readJson(claude.installedPath)).plugins as Record<string, Array<{ scope: string; installPath: string }>>;
    const installedPath = (source: Awaited<ReturnType<typeof registrations>>, name: string, scope: string) =>
      Object.entries(source).filter(([id]) => id.startsWith(`${name}@`)).flatMap(([, items]) => items)
        .find((item) => item.scope === scope)?.installPath;
    const skill = (root: string, name: string) => path.join(root, 'skills', name, 'SKILL.md');
    const hooks = async () => (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

    const installed = await runPublicLifecycle('sync', ['team/d'], user, runtime);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    const d = skill(installedPath(await registrations(), 'd', 'user')!, 'd');
    const dBefore = await fs.readFile(d, 'utf8');
    await fs.writeFile(value.hookFailure, d);
    const control = await runPublicLifecycle('sync', ['team/q'], project, runtime);
    expect(control.status, JSON.stringify(control)).toBe('success');
    expect(await hooks()).toEqual([{ plugin: 'q', platform: 'claude', scope: 'project' }]);
    await expect(fs.readFile(d, 'utf8')).resolves.toBe(dBefore);
    const before = await registrations();
    const q = installedPath(before, 'q', 'local')!;
    await expect(fs.readFile(skill(q, 'q'), 'utf8')).resolves.toContain('Use q.');
    const r = path.join(path.dirname(q), 'r');
    const a = skill(installedPath(before, 'a', 'local')!, 'a');
    const b = skill(installedPath(before, 'b', 'local')!, 'b');
    const [aBefore, bBefore] = await Promise.all([fs.readFile(a, 'utf8'), fs.readFile(b, 'utf8')]);
    await fs.writeFile(value.hookTrace, '');

    const result = await runPublicLifecycle(command === 'rebuild' ? 'sync' : command, ['team/r', 'team/s'], {
      ...project, ...(command === 'install' ? { scope: 'project' } : {}), rebuild: command === 'rebuild',
    }, runtime);
    expect(await hooks()).toEqual([{ plugin: 'r', platform: 'claude', scope: 'project' }]);
    await expect(fs.readFile(d, 'utf8')).resolves.toBe(`${dBefore}\nExternal D-only bytes.\n`);
    await expect(fs.readFile(a, 'utf8')).resolves.toBe(aBefore);
    await expect(fs.readFile(b, 'utf8')).resolves.toBe(bBefore);
    await expect(fs.pathExists(skill(r, 'r'))).resolves.toBe(false);
    const after = await registrations();
    expect(installedPath(after, 'r', 'local')).toBeUndefined();
    expect(installedPath(after, 'd', 'user')).toBe(installedPath(before, 'd', 'user'));
    await expect(fs.readFile(skill(installedPath(after, 's', 'local')!, 's'), 'utf8')).resolves.toContain('Use s.');
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(result.data.targetResults.find((target) => target.pluginId === 'team/r' && target.scope === 'project'))
      .toMatchObject({ blockerCodes: expect.arrayContaining(['dependencyInstallFailed']) });
    expect(result.data.targetResults.find((target) => target.pluginId === 'team/s' && target.scope === 'project'))
      .toMatchObject({ execution: 'applied', observation: 'verified', blockerCodes: [] });
  }, 45000);

  it('previews a shared Native provider hook only when the User root also runs', async () => {
    const claude = await createClaudeNativeTestRuntime(getCurrentSourceTestIsolation());
    const value = await fixture(false, ['claude'], ['d']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const, targets: ['claude'] };
    const project = { ...value.options, context: 'project' as const, targets: ['claude'] };
    const runtime = { nativeCliRunner: claude.nativeCliRunner };
    await setTargets(user, ['claude']);
    const installed = await runPublicLifecycle('sync', ['team/a'], user, runtime);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    await fs.writeFile(value.hookTrace, '');

    const projectOnly = await runPublicLifecycle('sync', ['team/b'], { ...project, yes: false }, runtime);
    expect(projectOnly.status, JSON.stringify(projectOnly)).toBe('success');
    expect(projectOnly.data.confirmation?.effects.filter((effect) => effect.code === 'runPreApply') ?? []).toEqual([]);
    await expect(fs.readFile(value.hookTrace, 'utf8')).resolves.toBe('');

    const roots = ['team/a', 'team/b'];
    const mixedPreview = await runPublicLifecycle('sync', roots, { ...project, yes: false }, runtime);
    expect(mixedPreview.status).toBe('blocked');
    expect(mixedPreview.data.confirmation?.effects.filter((effect) => effect.code === 'runPreApply').map((effect) => effect.subject))
      .toEqual([{ pluginId: 'team/d', target: 'claude', scope: 'user' }]);
    await expect(fs.readFile(value.hookTrace, 'utf8')).resolves.toBe('');

    const applied = await runPublicLifecycle('sync', roots, project, runtime);
    expect(applied.status, JSON.stringify(applied)).toBe('success');
    expect((await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toEqual([{ plugin: 'd', platform: 'claude', scope: 'user' }]);
  }, 30000);

  it('stages the second Claude package while installing the first and preserves both registrations', async () => {
    const claude = await createClaudeNativeTestRuntime(getCurrentSourceTestIsolation());
    const value = await fixture(false, ['claude'], false, { a: [], b: [], d: [] });
    const options = { ...value.options, scope: 'user' as const, targets: ['claude'] };
    await setTargets(options, ['claude']);
    const beginInstall = Promise.withResolvers<void>();
    const finishCopy = Promise.withResolvers<void>();
    const parallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
    const nativeCliRunner: typeof claude.runtime.nativeCliRunner = vi.fn(async (invocation) => {
      if (invocation.args.includes('install') && invocation.args.some((arg) => arg.startsWith('a@'))) {
        beginInstall.resolve();
        await finishCopy.promise;
      }
      return claude.nativeCliRunner(invocation);
    });
    const plan = await prepareRecovery('install', ['team/a', 'team/d'], options, { env: value.options.env, nativeCliRunner });
    let overlap = false;
    let timedOut = false;
    const copy = fs.copy.bind(fs);
    const spy = vi.spyOn(fs, 'copy').mockImplementation(async (from: string, to: string, opts?: fs.CopyOptions) => {
      if (path.basename(to) === 'd' && path.basename(path.dirname(to)).startsWith('private-package-')) {
        await beginInstall.promise;
        await copy(from, to, opts);
        overlap = !timedOut;
        finishCopy.resolve();
      } else await copy(from, to, opts);
    });
    const deadline = setTimeout(() => { timedOut = true; beginInstall.resolve(); finishCopy.resolve(); }, 5000);
    try {
      const receipt = await executeRecovery(plan, { yes: true });
      expect(receipt.ok, JSON.stringify(receipt.targetResults)).toBe(true);
      expect(overlap).toBe(true);
      expect(Object.keys((await fs.readJson(claude.installedPath)).plugins).map((id) => id.split('@')[0]).sort()).toEqual(['a', 'd']);
    } finally {
      clearTimeout(deadline); beginInstall.resolve(); finishCopy.resolve();
      parallelism.mockRestore(); spy.mockRestore(); await plan.context.dispose();
    }
  });

  it('skips a dependent preApply when its native provider fails to install', async () => {
    const claude = await createClaudeNativeTestRuntime(getCurrentSourceTestIsolation());
    const value = await fixture(false, ['claude'], true, { a: ['d'], b: [], d: [] });
    const options = { ...value.options, scope: 'user' as const, targets: ['claude'] };
    await setTargets(options, ['claude']);
    const plan = await prepareRecovery('install', ['team/a', 'team/b'], options, {
      env: value.options.env, nativeCliRunner: async (invocation) => invocation.args.includes('install')
        && invocation.args.some((arg) => arg.startsWith('d@'))
        ? { exitCode: 1, stdout: '', stderr: 'Provider install failed' } : claude.nativeCliRunner(invocation),
    });
    try {
      const receipt = await executeRecovery(plan, { yes: true });
      const scripts = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line).plugin);
      expect(scripts).toContain('d');
      expect(scripts).not.toContain('a');
      const userTarget = (pluginId: string) => receipt.targetResults.find((target) =>
        target.pluginId === pluginId && target.agent === 'claude' && target.scope === 'user')!;
      expect(userTarget('team/b')).toMatchObject({ execution: 'applied', observation: 'verified', recoveryActions: [] });
      expect(Object.keys((await fs.readJson(claude.installedPath)).plugins).some((id) => id.startsWith('b@'))).toBe(true);
      expect(userTarget('team/a').execution).toBe('not-run');
      expect(userTarget('team/d').execution).toBe('partial');
      const backend = userTarget('team/d').backend as { targetResults: Array<{ target: { pluginId: string }; recoveryActions: string[] }> };
      const backendRetry = 'run aw plugin sync team/d --target claude --context user';
      expect(backend.targetResults.find((item) => item.target.pluginId === 'team/d')?.recoveryActions)
        .toEqual(expect.arrayContaining([backendRetry, `${backendRetry} --rebuild`]));
      const retry = 'aw plugin sync team/a --context user --target claude';
      const cleanup = (id: string) => `run aw plugin remove --only outputs team/${id} --target claude --scope user`;
      for (const id of ['d', 'a']) {
        expect(userTarget(`team/${id}`).recoveryActions).toEqual([retry, `${retry} --rebuild`, cleanup(id)]);
      }
      expect(receipt.recoveryActions).toEqual(expect.arrayContaining([retry, `${retry} --rebuild`, cleanup('d'), cleanup('a')]));
      expect(receipt.recoveryActions.join('\n')).not.toContain('aw plugin sync team/d ');
    } finally { await plan.context.dispose(); }
  });
});

it('reports each failed provider in a three-level chain and retries the only declared root', async () => {
  installNativeTestQualification({ discovery: true });
  const value = await fixture(false, ['generic'], true, { b: ['d'], d: ['a'], a: [] });
  await fs.remove(await resolveIntentPath({ ...value.options, scope: 'user' }));
  const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
  await fs.writeFile(value.hookFailure, 'a/generic/project');
  const receipt = await runRecovery('sync', ['team/b'], project);
  expect(receipt).toMatchObject({ ok: false, intent: { roots: ['team/b'] }, declarationChanged: false });
  for (const [consumer, provider] of [['d', 'a'], ['b', 'd']] as const) {
    const target = receipt.targetResults.find((item) => item.pluginId === `team/${consumer}` && item.scope === 'project');
    const reason = target?.blockers.find((item) => item.code === 'dependencyApplyFailed');
    expect(target?.execution).toBe('not-run');
    expect(reason).toMatchObject({ pluginId: `team/${provider}`, message: expect.stringContaining(`team/${provider}`) });
    expect(reason?.message).not.toContain('aw plugin');
  }
  const retry = 'aw plugin sync team/b --context project --target generic --yes';
  expect(receipt.recoveryActions).toContain(retry);
  expect(receipt.recoveryActions.join('\n')).not.toMatch(/aw plugin sync team\/[ad] /u);
  expect((await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
    .toEqual([{ plugin: 'a', platform: 'generic', scope: 'project' }]);
  await fs.remove(value.hookFailure);
  const capture = createCapturedCliIo();
  expect(await runCli([...retry.split(' ').slice(1), '--json'], { ...project, interactive: false, io: capture.io })).toBe(0);
  for (const name of ['a', 'd', 'b']) {
    await expect(fs.readFile(path.join(value.projectRoot, name, 'SKILL.md'), 'utf8')).resolves.toContain(`Use ${name}.`);
  }
}, 30_000);

// A requirements-only exit leaves the installed Project consumer able to use its dependency.
it.each(['inherited skills', 'healthy project copy', 'damaged project copy', 'missing declared copy', 'removed consumer'] as const)(
  'removes a User root while accounting for %s in the current project', async (scenario) => {
    installNativeTestQualification({ discovery: true });
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    const userDependency = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    const projectDependency = path.join(value.nativeSkill('opencode', 'project', 'd'), 'SKILL.md');
    const projectConsumer = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    await setTargets(user, ['opencode']);
    const hasProjectCopy = scenario === 'healthy project copy' || scenario === 'damaged project copy';
    if (hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    if (!hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    await expect(fs.readFile(userDependency, 'utf8')).resolves.toContain('Use d.');
    expect(await fs.pathExists(projectDependency)).toBe(hasProjectCopy);
    if (scenario === 'damaged project copy') await fs.appendFile(projectDependency, '\nOut of date.\n');

    expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'requirements' })).status).toBe('success');
    if (scenario === 'missing declared copy') {
      expect((await runPublicLifecycle('install', ['team/d'], { ...project, only: 'requirements' })).status).toBe('success');
    }
    if (scenario === 'removed consumer') {
      expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'outputs', targets: ['opencode'] })).status).toBe('success');
    } else await expect(fs.readFile(projectConsumer, 'utf8')).resolves.toContain('Use b.');

    const removed = await runPublicLifecycle('remove', ['team/a'], { ...project, scope: 'user' });
    expect(removed.status, JSON.stringify(removed.diagnostics)).toBe('success');
    expect(await fs.pathExists(path.join(value.nativeSkill('opencode', 'user', 'a'), 'SKILL.md'))).toBe(false);
    expect(await fs.pathExists(projectConsumer)).toBe(scenario !== 'removed consumer');
    expect(await fs.pathExists(userDependency)).toBe(scenario !== 'healthy project copy' && scenario !== 'removed consumer');
    if (hasProjectCopy) await expect(fs.readFile(projectDependency, 'utf8')).resolves.toContain('Use d.');
  }, 30_000,
);

it('syncs a Claude project that still uses two shared User dependencies', async () => {
  installNativeTestQualification({ discovery: true });
  const claude = await createClaudeNativeTestRuntime(getCurrentSourceTestIsolation());
  const value = await fixture(false, ['claude'], false, { a: ['d'], b: ['a', 'd'], d: [] });
  const user = { ...value.options, scope: 'user' as const, context: 'user' as const, targets: ['claude'] };
  const project = { ...value.options, scope: 'project' as const, context: 'project' as const, targets: ['claude'] };
  await setTargets(user, ['claude']);
  expect((await runPublicLifecycle('install', ['team/a'], user, claude.runtime)).status).toBe('success');
  const first = await runPublicLifecycle('install', ['team/b'], project, claude.runtime);
  expect(first.status, JSON.stringify(first.diagnostics)).toBe('success');
  const before = await fs.readJson(claude.installedPath);
  claude.nativeCliRunner.mockClear();

  const synced = await runPublicLifecycle('sync', ['team/b'], project, claude.runtime);
  expect(synced.status, JSON.stringify(synced.diagnostics)).toBe('success');
  expect(synced.data.remainingTargets).toEqual([]);
  expect(synced.data.targetResults.find((target) => target.pluginId === 'team/b')).toMatchObject({ execution: 'no-op' });
  expect(claude.nativeCliRunner.mock.calls.some(([invocation]) => invocation.args.includes('uninstall')
    || invocation.args.includes('disable'))).toBe(false);
  await expect(fs.readJson(claude.installedPath)).resolves.toEqual(before);
}, 30_000);

it.each(['owned consumer', 'foreign consumer', 'removed consumer', 'healthy project copy'] as const)(
  'protects only dependencies still needed by a delisted %s', async (scenario) => {
    installNativeTestQualification({ discovery: true });
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    const removeFromProject = { ...project, scope: 'user' as const };
    const projectB = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const userD = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    const projectD = path.join(value.nativeSkill('opencode', 'project', 'd'), 'SKILL.md');
    const hasProjectCopy = scenario === 'healthy project copy';
    const userRoot = hasProjectCopy ? 'team/d' : 'team/a';
    await setTargets(user, ['opencode']);
    if (hasProjectCopy) {
      const intent = await observeIntent(user);
      if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent(user, { ...intent.value, roots: [{ pluginId: userRoot }] });
      expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    }
    expect((await runRecovery('sync', [userRoot], user)).ok).toBe(true);
    if (!hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect(await fs.pathExists(projectD)).toBe(hasProjectCopy);
    expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'requirements' })).status).toBe('success');

    const indexPath = path.join(value.source, 'catalog-manifest.json');
    const index = await fs.readJson(indexPath) as { entries: Array<{ name: string }> };
    await fs.writeJson(indexPath, { ...index, entries: index.entries.filter(({ name }) => name !== 'b') });
    await fs.remove(path.join(value.source, 'plugins', 'b'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: user.env });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: user.env });
    expect(active.manifest.entries.map(({ name }) => name)).not.toContain('b');

    const cleanProjectB = () => runPublicLifecycle('remove', ['team/b'], { ...project, only: 'outputs', targets: ['opencode'] });
    if (scenario === 'removed consumer') expect((await cleanProjectB()).status).toBe('success');
    if (scenario === 'foreign consumer') await fs.remove(path.join(path.resolve(projectB, '../../..'), SKILL_OWNER_MARKER));
    const before = await observeIntent(user);
    const removed = await runPublicLifecycle('remove', [userRoot], removeFromProject);
    if (scenario === 'owned consumer') {
      expect(removed.status).toBe('blocked');
      expect(removed.diagnostics).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await observeIntent(user)).toEqual(before);
      await expect(fs.readFile(userD, 'utf8')).resolves.toContain('Use d.');
      await expect(fs.readFile(projectB, 'utf8')).resolves.toContain('Use b.');
      expect((await cleanProjectB()).status).toBe('success');
      expect((await runPublicLifecycle('remove', [userRoot], removeFromProject)).status).toBe('success');
    } else {
      expect(removed.status, JSON.stringify(removed.diagnostics)).toBe('success');
    }
    expect(await fs.pathExists(userD)).toBe(false);
    expect(await fs.pathExists(projectB)).toBe(hasProjectCopy || scenario === 'foreign consumer');
    if (hasProjectCopy) await expect(fs.readFile(projectD, 'utf8')).resolves.toContain('Use d.');
  }, 30_000,
);
