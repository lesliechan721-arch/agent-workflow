import path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { git } from '../helpers/catalog-source-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
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
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig, resolveCatalogSourcesConfigPath } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogGenerationStatePath } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { writeIntent, observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { recoveryRetryTargets } from '../../src/recovery/receipt.js';
import { resolvePreferencesPath, writePreferences, setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { snapshotRegularTree } from '../helpers/write-command-fixture.js';
import { fixture, expectSavedIntent, failManifestAfterActiveCheck } from '../helpers/joint-recovery-fixture.js';

describe('joint recovery through real Catalog and owned outputs', () => {
  beforeEach(() => { installNativeTestDiscovery(); });
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

  it.each(['status', 'remove', 'rebuild'] as const)('shares Active evidence for multi-plugin public %s', async (operation) => {
    // Test Value Gate: an unrelated plugin payload counts whole-snapshot scans,
    // independently of the number of requested entries or selected targets.
    const value = await fixture(false, ['generic'], false, { a: [], b: [], z: [] });
    const user = { ...value.options, context: 'user' as const, scope: 'user' as const };
    expect((await runPublicLifecycle('install', ['team/a', 'team/b'], user)).status).toBe('success');
    const active = await resolveActiveCatalogGeneration({ ...user, sourceId: 'team' });
    const marker = path.join(active.snapshotPath, 'plugins', 'z', 'README.md');
    let phase: 'review' | 'recheck' | undefined = 'review';
    const scans = { review: 0, recheck: 0 };
    const readFile = fs.readFile.bind(fs);
    const reads = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (phase && String(args[0]) === marker) scans[phase]++;
      return readFile(...args);
    });
    try {
      const result = operation === 'status'
        ? await runPublicPluginStatus([], user)
        : await runPublicLifecycle(operation === 'remove' ? 'remove' : 'sync', ['team/a', 'team/b'],
          { ...user, rebuild: operation === 'rebuild' }, { debugLogger: { log(event) {
            if (event.data?.name === 'recovery.lock.wait' && event.data.phase === 'start') phase = 'recheck';
            if (event.data?.name === 'recovery.locked.recheck' && event.data.phase === 'success') phase = undefined;
          } } });
      expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
      // Preview and locked Review are separate read windows. Writers must still
      // perform their own fresh checks (not included in this Review count).
      expect(scans).toEqual({ review: 1, recheck: operation === 'status' ? 0 : 1 });
      if (operation === 'remove') {
        await expect(fs.pathExists(path.join(value.userRoot, 'a'))).resolves.toBe(false);
        await expect(fs.pathExists(path.join(value.userRoot, 'b'))).resolves.toBe(false);
      } else for (const name of ['a', 'b']) {
        await expect(fs.readFile(path.join(value.userRoot, name, 'SKILL.md'), 'utf8')).resolves.toContain(`Use ${name}.`);
      }
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
    // d is the first consumer after a. Its hook exposes early execution even if the write is blocked.
    const value = await fixture(false, ['generic'], ['d'], {
      a: [], b: ['d'], d: ['a'], ...(change === 'same-path damage' ? { z: [] } : {}),
    });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    const projectIntent = await fs.readFile(await resolveIntentPath(project));
    const foreign = path.join(value.projectRoot, 'foreign', 'SKILL.md');
    await fs.outputFile(foreign, 'foreign skill\n');
    const protectedFiles = await snapshotRegularTree(value.projectRoot);
    const statePath = resolveCatalogGenerationStatePath(user.env);
    const originalState = await fs.readFile(statePath);
    const state = JSON.parse(originalState.toString()) as CatalogGenerationStateFileV1;
    const active = state.sources.team!.active!;
    const store = resolveCatalogStoreLocation({ ...active, env: user.env });
    let nextState: Buffer | undefined;
    if (change === 'new Active') {
      await fs.appendFile(path.join(value.source, 'catalog-manifest.json'), '\n');
      const next = await syncCatalogSourceGeneration({ ...user, sourceId: 'team' });
      expect(next).toMatchObject({ outcome: 'activated', active: { logicalIdentity: active.logicalIdentity } });
      const nextStore = resolveCatalogStoreLocation({ ...next.active!, env: user.env });
      expect(nextStore.snapshotRoot).not.toBe(store.snapshotRoot);
      nextState = await fs.readFile(statePath);
      await fs.writeFile(statePath, originalState);
    } else if (change === 'changed ref with unchanged Store') {
      active.requestedRef = 'refs/heads/changed';
      nextState = Buffer.from(JSON.stringify(state));
    }
    const plan = await prepareRecovery('install', ['team/a', 'team/b'], user);
    expect(plan.receipt.blockers).toEqual([]);
    expect(plan.receipt.requestedTargets.map(({ pluginId, scope }) => `${pluginId}:${scope}`).sort())
      .toEqual(['team/a:user', 'team/b:project', 'team/b:user', 'team/d:user']);

    const damagedFile = path.join(store.snapshotRoot, 'plugins', 'z', 'generic', 'skills', 'z', 'README.md');
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
    await expect(fs.pathExists(value.hookTrace)).resolves.toBe(false);
    if (change === 'new Active') {
      const action = receipt.recoveryActions.find((item) => item === 'aw plugin sync team/b --context project --target generic')!;
      const capture = createCapturedCliIo();
      expect(await runCli([...action.split(' ').slice(1), '--yes', '--json'], { ...user, interactive: false, io: capture.io })).toBe(0);
      for (const [root, name] of [[value.userRoot, 'd'], [value.userRoot, 'b'], [value.projectRoot, 'b']] as const) {
        await expect(fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8')).resolves.toContain(`Use ${name}.`);
      }
      expect(JSON.parse(await fs.readFile(value.hookTrace, 'utf8'))).toEqual({ plugin: 'd', platform: 'generic', scope: 'user' });
      await expect(fs.readFile(await resolveIntentPath(project))).resolves.toEqual(projectIntent);
      await expectSavedIntent(receipt, user);
    }
  });

  it.each([
    ['requested ref', undefined],
    ['resolved commit', undefined],
    ['invalid state', 'catalogGenerationStateInvalid'],
    ['invalid config', 'catalogSourcesConfigInvalid'],
    ['invalid state after child planning', 'catalogGenerationStateInvalid'],
    ['interruption', undefined],
    ['interruption after child planning', undefined],
  ] as const)('preserves a sequential rebuild receipt after %s changes between children', async (change, reasonCode) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: [] });
    const statePath = resolveCatalogGenerationStatePath(value.options.env);
    const configPath = resolveCatalogSourcesConfigPath(value.options.env);
    const state = await fs.readJson(statePath) as CatalogGenerationStateFileV1;
    const intentFiles = await Promise.all((['user', 'project'] as const).map(async (scope) =>
      fs.readFile(await resolveIntentPath({ ...value.options, scope }))));
    let firstCompleted = false;
    let changed = false;
    let executedChildren = 0;
    const controller = new AbortController();
    const interruption = change === 'interruption' || change === 'interruption after child planning';
    const afterPlanning = change === 'interruption after child planning' || change === 'invalid state after child planning';
    const blockerCode = interruption ? 'operationInterrupted' : 'operationReviewStale';
    const result = await runPublicLifecycle('sync', ['team/a', 'team/b'], { ...value.options, context: 'project', rebuild: true },
      { signal: controller.signal, debugLogger: { log: async (event) => {
        if (event.data?.name === 'recovery.child.execute' && event.data.phase === 'start') executedChildren++;
        if (event.data?.phase !== 'success' || changed) return;
        if (event.data.name === 'recovery.child.execute') {
          firstCompleted = true;
          if (afterPlanning) return;
        } else if (!(afterPlanning && firstCompleted
          && event.data.name === 'recovery.child.plan')) return;
        if (change === 'requested ref' || change === 'resolved commit') {
          if (change === 'requested ref') state.sources.team!.active!.requestedRef = 'refs/heads/changed';
          else state.sources.team!.active!.resolvedCommit = 'f'.repeat(40);
          await fs.writeJson(statePath, state);
        } else if (interruption) controller.abort();
        else await fs.writeFile(change === 'invalid config' ? configPath : statePath, '{invalid');
        changed = true;
      } } });
    expect(firstCompleted && changed).toBe(true);
    expect(publicExitCode(result), JSON.stringify(result)).toBe(4);
    expect(result).toMatchObject({ status: 'partial', data: {
      changes: { requirements: 'none', preferences: 'none', outputs: 'changed' },
      targetResults: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'team/a', target: 'generic', scope: 'user', execution: 'applied', observation: 'verified' }),
        expect.objectContaining({ pluginId: 'team/b', target: 'generic', scope: 'project', execution: 'not-run',
          blockerCodes: expect.arrayContaining([blockerCode]) }),
      ]),
      remainingTargets: [{ pluginId: 'team/b', target: 'generic', scope: 'project' }],
    }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: blockerCode,
      ...(reasonCode ? { detail: { reasonCode } } : {}) })]) });
    if (interruption) {
      if (!afterPlanning) expect(executedChildren).toBe(1);
      expect(result.nextActions.filter((action) => action.kind === 'command').map((action) => action.argv)).toEqual([
        ['aw', 'plugin', 'sync', 'team/b', '--context', 'project', '--target', 'generic'],
      ]);
    }
    await expect(fs.readFile(path.join(value.userRoot, 'a', 'SKILL.md'), 'utf8')).resolves.toContain('Use a.');
    await expect(fs.pathExists(path.join(value.projectRoot, 'b'))).resolves.toBe(false);
    await expect(Promise.all((['user', 'project'] as const).map(async (scope) =>
      fs.readFile(await resolveIntentPath({ ...value.options, scope }))))).resolves.toEqual(intentFiles);
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
});
