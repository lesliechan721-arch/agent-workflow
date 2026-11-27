import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { writeIntent, observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { type RecoveryReceipt } from '../../src/recovery/receipt.js';
import { writePreferences, setTargets, type DeploymentPreferences } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { fixture, failNextPackagePublication, expectSavedIntent } from '../helpers/joint-recovery-fixture.js';

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
  // Test Value Gate: an interrupted replacement hook can have external effects even
  // though neither the new deployment nor the old provider cleanup has started.
  it('preserves the started replacement hook and unstarted cleanup on interruption', async () => {
    const value = await fixture(false, ['generic', 'opencode'], ['a'], { a: [], b: [] });
    const user = { ...value.options, context: 'user' as const };
    await setTargets({ ...user, scope: 'user' }, ['opencode']);

    const root = path.join(value.source, 'plugins', 'a');
    await fs.appendFile(path.join(root, 'pre-apply.mjs'),
      "\nif (c.target.platform === 'generic') await new Promise(resolve => setTimeout(resolve, 20000));\n");
    const manifestPath = path.join(value.source, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath);
    const entry = await createCatalogManifestV7Entry(await readPluginManifest(root, { mode: 'bundle' }), root);
    await fs.writeJson(manifestPath, { ...manifest, entries: manifest.entries.map((item: typeof entry) =>
      item.name === entry.name ? entry : item) });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: user.cliVersion, env: user.env });
    expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    const old = path.join(value.nativeSkill('opencode', 'user', 'a'), 'SKILL.md');
    const oldBytes = await fs.readFile(old);
    await fs.writeFile(value.hookTrace, '');
    await setTargets({ ...user, scope: 'user' }, ['generic']);

    const controller = new AbortController();
    const interruption = { signal: controller.signal, exitCode: 130 as const, cleanupFailed: false };
    const running = runRecovery('sync', ['team/a'], { ...user, retireUnselectedTargets: true }, {
      signal: controller.signal, interruption,
    }).catch((error: unknown) => error);
    try {
      // The real hook writes the trace before waiting; abort only once it has run.
      await vi.waitFor(async () => expect(await fs.readFile(value.hookTrace, 'utf8')).toBe(
        '{"plugin":"a","platform":"generic","scope":"user"}\n'), { timeout: 20000 });
      controller.abort();
      const error = await running;
      expect(error).toMatchObject({ code: 'operationInterrupted', receipt: {
        ok: false, outputsMayHaveChanged: true,
        targetResults: expect.arrayContaining([
          expect.objectContaining({ pluginId: 'team/a', agent: 'generic', scope: 'user', execution: 'partial',
            observation: 'unknown', content: 'unknown', blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationInterrupted' })]) }),
          expect.objectContaining({ pluginId: 'team/a', agent: 'opencode', scope: 'user', execution: 'not-run',
            blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationInterrupted' })]) }),
        ]),
        remainingTargets: expect.arrayContaining([
          expect.objectContaining({ pluginId: 'team/a', agent: 'generic', scope: 'user' }),
          expect.objectContaining({ pluginId: 'team/a', agent: 'opencode', scope: 'user' }),
        ]),
      } });
      expect(interruption.cleanupFailed).toBe(false);
      await expect(fs.readFile(old)).resolves.toEqual(oldBytes);
      await expect(fs.pathExists(path.join(value.userRoot, 'a'))).resolves.toBe(false);
    } finally {
      controller.abort();
      await running;
    }
  }, 60000);
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
