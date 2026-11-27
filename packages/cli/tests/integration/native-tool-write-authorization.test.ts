import path from 'node:path';

import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';

import { syncWriteCommand as nativeSyncWriteCommand, uninstallWriteCommand as nativeUninstallWriteCommand } from '../../src/commands/write-commands.js';
import { buildOperationReviewProjection, managedCommandRecoveryPlanChanges } from '../../src/tui/operation-review-planner.js';
import { executeRecovery, prepareRecovery } from '../../src/recovery/coordinator.js';
import { operationPlanNativeToolChanges } from '../../src/commands/operation-plan.js';
import { listManagedCommandPackages, readInstalledCommandProducer, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { readIntentFixture, writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createNativeTestExecution, installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { resolvePreferencesPath, writePreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { nativeToolFixture } from '../helpers/native-tools.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Containment helper transport is outside this declaration/Review contract.
vi.mock('../../src/utils/process-tree.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/process-tree.js')>(),
  prepareWindowsJobHelper: async () => process.execPath,
}));

async function nativeWrite(command: typeof nativeSyncWriteCommand, names: string[],
  options: Parameters<typeof nativeSyncWriteCommand>[1], runtime: Parameters<typeof nativeSyncWriteCommand>[2]) {
  const execution = await createNativeTestExecution({ cwd: options.cwd!, scope: options.scope!, env: runtime!.env!,
    selectedTargets: names.map((pluginId) => ({ pluginId, platform: 'claude' as const })) });
  try { return await command(names, options, { ...runtime, executionInput: execution.executionInput }); }
  finally { await execution.dispose(); }
}
const syncWriteCommand: typeof nativeSyncWriteCommand = (names, options, runtime) =>
  nativeWrite(nativeSyncWriteCommand, names, options, runtime);
const uninstallWriteCommand: typeof nativeUninstallWriteCommand = (names, options, runtime) =>
  nativeWrite(nativeUninstallWriteCommand, names, options, runtime);

describe('native declaration confirmation at ordinary write entries', () => {
  beforeEach(() => { installNativeTestDiscovery({ platforms: ['claude', 'opencode'] }); });
  // Test Value Gate: projection-only tests cannot prove confirmation precedes
  // requirement, producer, script and platform writes. Use real CLI/catalog/installed state,
  // and the same accepted-plan contract used by the existing Review bridge.
  it('requires explicit confirmation for introduction, binding-only change and deletion, and rejects an old accepted plan', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'native-review-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/native-review');
    const required = nativeToolFixture();
    const preferred = nativeToolFixture({ policy: 'preferred' });
    const scriptMarker = path.join(cwd, 'native-review-script-ran');
    const native = await createClaudeNativeTestRuntime(isolation);
    const settingsPath = path.join(native.claudeHome, 'settings.json');
    const intentOptions = { scope: 'user' as const, cwd, env };
    const writeOptions = { cwd, platform: 'claude' as const, scope: 'user' as const };

    async function snapshot(fixture: ReturnType<typeof nativeToolFixture> | undefined, fallback?: string) {
      for (const [relative, content] of Object.entries(required.files)) {
        await fs.outputFile(path.join(pluginRoot, relative), content);
      }
      await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'process.exit(0);\n');
      // A real component makes this exercise native registration and permission writes with package authority.
      await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Native authorization fixture.\n---\nProvider.\n');
      await fs.outputFile(path.join(pluginRoot, 'scripts/pre-apply.mjs'),
        `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(scriptMarker)}, 'executed');\n`);
      await createCatalogSnapshotFixture(sourceRoot, 'native-review', [], 'Native Review fixture\n', (manifest) => {
        manifest.platforms = ['claude'];
        manifest.skills = './skills';
        manifest.scripts = { preApply: { path: './scripts/pre-apply.mjs' } };
        manifest.extensions = { permissions: [{ name: 'tool', allow: ['echo hello'] }] };
        manifest.command = normalizePluginCommand({ mode: 'static', sourceDir: './tools',
          routes: { fallback: { runner: 'node', entry: 'run.mjs' } } }, manifest);
        if (fixture) {
          manifest.nativeTools = {
            reader: fixture.closure.reader,
            definitions: fixture.closure.definitions.map((definition) => ({ key: definition.key,
              protocol: definition.protocol })),
            consumers: structuredClone(fixture.closure.consumers),
          };
          if (fallback) manifest.nativeTools.consumers[0]!.tools[0]!.fallback = fallback;
        }
      });
    }
    async function run(args: string[], json = true) {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli(json ? [...args, '--json'] : args, { cwd, env, io: output.io,
        interactive: false, nativeCliRunner: native.nativeCliRunner });
      return { exitCode, receipt: json ? JSON.parse(output.readStdout()) : undefined,
        stdout: output.readStdout(), stderr: output.readStderr() };
    }
    const publicWrite = (command: 'install' | 'sync' | 'reinstall', yes = false) => run([
      'plugin', command === 'reinstall' ? 'sync' : command, 'team/native-review', '--context', 'user',
      ...(command === 'install' ? ['--scope', 'user'] : ['--target', 'claude']),
      ...(command === 'reinstall' ? ['--rebuild'] : []), ...(yes ? ['--yes'] : []),
    ]);
    const sourceSync = () => run(['source', 'sync', 'team', '--yes']);
    await writePreferences(intentOptions, { schemaVersion: 2, kind: 'aw-deployment-preferences',
      targets: ['claude'], exclusions: [] });
    const beforeIntent = await readIntentFixture(intentOptions);
    await snapshot(required);
    expect(await run(['source', 'add', 'team', '--path', sourceRoot, '--no-auto-check']))
      .toMatchObject({ exitCode: 0 });
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });

    const preferencesPath = await resolvePreferencesPath(intentOptions);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const writes = () => native.nativeCliRunner.mock.calls.filter(([call]) =>
      call.args[0] === 'plugin' && (['install', 'uninstall', 'update'].includes(call.args[1] ?? '')
        || call.args[1] === 'marketplace' && ['add', 'remove', 'update'].includes(call.args[2] ?? '')));
    const writesBefore = writes().length;
    const refusedIntroduction = await publicWrite('install');
    expect(refusedIntroduction).toMatchObject({ exitCode: 3, receipt: { schemaVersion: 2, status: 'blocked', data: { changes: { requirements: 'none', preferences: 'none', config: 'none', outputs: 'none' }, confirmation: { required: true, provided: false } } } });
    expect(JSON.stringify(refusedIntroduction.receipt)).toContain('confirmationRequired');
    expect((await listManagedCommandPackages(env)).packages).toEqual([]);
    expect(await fs.pathExists(settingsPath)).toBe(false);
    expect(beforeIntent.roots).toEqual([]);
    expect(await observeIntent(intentOptions)).toMatchObject({ state: 'absent' });
    expect(await fs.readFile(preferencesPath)).toEqual(preferencesBefore);
    expect(await fs.pathExists(path.join(env.AW_HOME!, 'plugin-config/team/native-review/config.json'))).toBe(false);
    expect(await fs.pathExists(path.join(env.AW_HOME!, 'platforms/claude'))).toBe(false);
    expect(await fs.pathExists(scriptMarker)).toBe(false);
    expect(writes()).toHaveLength(writesBefore);

    const installedText = await run(['plugin', 'install', 'team/native-review',
      '--scope', 'user', '--context', 'user', '--yes', '--verbose'], false);
    expect(installedText.exitCode, installedText.stdout).toBe(0);
    expect(await fs.readFile(scriptMarker, 'utf8')).toBe('executed');
    await fs.remove(scriptMarker);
    expect(installedText.stdout).toContain('Native tool team/native-review after: job · aw.windows-job.v1 · plugin-command · win32 · required');
    const initialProducer = await readInstalledCommandProducer((await listManagedCommandPackages(env)).packages[0]!.resourceRoot!);
    const initialSettings = await fs.readFile(settingsPath, 'utf8');
    const initialIntent = await readIntentFixture(intentOptions);
    expect(initialProducer.nativeTools).toEqual(required.closure);
    async function unchanged() {
      expect(await readInstalledCommandProducer((await listManagedCommandPackages(env)).packages[0]!.resourceRoot!)).toEqual(initialProducer);
      expect(await fs.readFile(settingsPath, 'utf8')).toBe(initialSettings);
      expect(await readIntentFixture(intentOptions)).toEqual(initialIntent);
      expect(await fs.pathExists(scriptMarker)).toBe(false);
    }

    await snapshot(preferred);
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });
    for (const command of ['sync', 'reinstall'] as const) {
      const refused = await publicWrite(command);
      expect(refused).toMatchObject({
        exitCode: 3, receipt: {
          schemaVersion: 2,
          status: 'blocked',
          data: {}
        }
      });
      expect(JSON.stringify(refused.receipt)).toContain('confirmationRequired');
      await unchanged();
    }
    const reviewed = await syncWriteCommand(['team/native-review'], writeOptions, { ...native.runtime, previewOperationPlan: true });
    const projection = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'sync', pluginId: 'team/native-review', platform: 'claude', scope: 'user' },
      evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: reviewed.operationPlan! } });
    expect(projection.changes).toContainEqual(expect.objectContaining({ title: '使用原生工具 · team/native-review', description: expect.stringContaining('preferred · fallback=portable') }));
    const acceptedReview = { ...native.runtime, preApplyConfirmed: true, expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint };
    await snapshot(preferred, 'portable-two');
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });
    const stale = await syncWriteCommand(['team/native-review'], writeOptions, acceptedReview);
    expect(stale.overallState).toBe('failed');
    expect(JSON.stringify(stale)).toContain('operationPlanStale');
    await unchanged();

    const current = await syncWriteCommand(['team/native-review'], writeOptions, { ...native.runtime, previewOperationPlan: true });
    const accepted = await syncWriteCommand(['team/native-review'], writeOptions, {
      ...native.runtime, preApplyConfirmed: true, expectedPlanFingerprint: current.operationPlan!.planFingerprint,
    });
    expect(accepted.overallState, JSON.stringify(accepted)).toBe('succeeded');
    const changedProducer = await readInstalledCommandProducer((await listManagedCommandPackages(env)).packages[0]!.resourceRoot!);
    expect(await fs.readFile(scriptMarker, 'utf8')).toBe('executed');
    await fs.remove(scriptMarker);
    expect(changedProducer.nativeTools!.definitions).toEqual(initialProducer.nativeTools!.definitions);
    expect(changedProducer.nativeTools!.consumers[0]!.tools[0]).toMatchObject({ policy: 'preferred', fallback: 'portable-two' });

    await snapshot(undefined);
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });
    const refusedDeletion = await publicWrite('sync');
    expect(refusedDeletion).toMatchObject({
      exitCode: 3, receipt: {
        schemaVersion: 2,
        status: 'blocked',
        data: {}
      }
    });
    expect(JSON.stringify(refusedDeletion.receipt)).toContain('confirmationRequired');
    expect(await readInstalledCommandProducer((await listManagedCommandPackages(env)).packages[0]!.resourceRoot!)).toEqual(changedProducer);
    const removedText = await run(['plugin', 'sync', 'team/native-review', '--target', 'claude',
      '--context', 'user', '--yes', '--verbose'], false);
    expect(removedText.exitCode, removedText.stdout).toBe(0);
    expect(removedText.stdout).toContain('Native tool team/native-review before: job · aw.windows-job.v1 · plugin-command · win32 · preferred · fallback=portable-two');
    expect((await readInstalledCommandProducer((await listManagedCommandPackages(env)).packages[0]!.resourceRoot!)).nativeTools).toBeUndefined();
  });

  // Test Value Gate: selection and confirmation in the public command must also cover Portable-only
  // updates, and an accepted Review must become stale if visible permission evidence changes.
  it.each(['native', 'mixed', 'generic-target', 'generic-only'] as const)('withdraws the shared package once on a confirmed %s update', async (delivery) => {
    const isolation = getCurrentSourceTestIsolation();
    const { fixtureCwd: cwd } = isolation.layout;
    const env = isolation.env;
    const native = await createClaudeNativeTestRuntime(isolation);
    const sourceRoot = path.join(cwd, 'multi-host-source');
    const root = path.join(sourceRoot, 'plugins/multi');
    const selector = 'team/multi';
    async function snapshot(command: boolean) {
      if (!command && delivery === 'generic-only') {
        await Promise.all(['claude', 'opencode'].map((platform) => fs.remove(path.join(root, platform))));
      }
      await fs.outputFile(path.join(root, 'tools/main.mjs'), 'process.exitCode = 0;\n');
      await fs.outputFile(path.join(root, 'skills/helper/README.md'), 'Multi-host fixture.\n');
      await fs.outputFile(path.join(root, 'skills/helper/SKILL.md'), '---\nname: helper\ndescription: Multi-host fixture.\n---\nHelper.\n');
      await createCatalogSnapshotFixture(sourceRoot, 'multi', [], 'Multi-host fixture.\n', (manifest) => {
        manifest.platforms = command || delivery !== 'generic-only' ? ['opencode', 'claude', 'generic'] : ['generic'];
        manifest.skills = './skills';
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'test' } } };
        if (command) manifest.command = normalizePluginCommand({ sourceDir: './tools', mode: 'static',
          runtimeConfig: { keys: ['mode'] }, routes: { fallback: { runner: 'node', entry: 'main.mjs' } } }, manifest);
        else manifest.version = '2.0.0';
      });
    }
    async function publicCli(...args: string[]) {
      const output = createCapturedCliIo();
      const code = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: native.nativeCliRunner });
      return { code, receipt: JSON.parse(output.readStdout()) };
    }
    await snapshot(true);
    expect(await publicCli('source', 'add', 'team', '--path', sourceRoot, '--no-auto-check')).toMatchObject({ code: 0 });
    expect(await publicCli('source', 'sync', 'team', '--yes')).toMatchObject({ code: 0 });
    await writePreferences({ scope: 'user', cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences',
      targets: ['claude', 'opencode'], exclusions: [] });
    const installation = await publicCli('plugin', 'install', selector, '--scope', 'user', '--context', 'user', '--yes');
    expect(installation, JSON.stringify(installation)).toMatchObject({ code: 0, receipt: { data: {
      commandResults: [{ selector, action: 'created', state: 'completed', hasFallback: true }],
    } } });
    const { packages } = await listManagedCommandPackages(env);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.runtimeConfigPlatforms.sort()).toEqual(['claude', 'opencode']);
    if (delivery !== 'native') {
      await writePreferences({ scope: 'user', cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences',
        targets: ['claude', 'opencode', 'generic'], exclusions: [] });
      const portable = await publicCli('plugin', 'sync', selector, '--context', 'user', '--target', 'generic', '--yes');
      expect(portable, JSON.stringify(portable)).toMatchObject({ code: 0, receipt: { data: { commandResults: [],
        targetResults: [{ target: 'generic', execution: 'applied' }],
      } } });
      expect((await listManagedCommandPackages(env)).packages[0]!.resourceRoot).toBe(packages[0]!.resourceRoot);
    }
    await snapshot(false);
    expect(await publicCli('source', 'sync', 'team', '--yes')).toMatchObject({ code: 0 });
    const targetArgs = delivery === 'generic-target' ? ['--target', 'generic'] : [];
    const cancelled = await publicCli('plugin', 'sync', selector, '--context', 'user', ...targetArgs);
    expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ code: 3, receipt: { status: 'blocked', data: { confirmation: { effects: expect.arrayContaining([
      expect.objectContaining({ code: 'removeCommandPackage', impact: 'user-wide', subject: { pluginId: selector, scope: 'user' } }),
    ]) } } } });
    expect((await resolveManagedCommand(`${selector}/claude`, env)).launch.entry).toBe('main.mjs');
    if (delivery === 'generic-target') {
      const review = await prepareRecovery('sync', [selector], {
        cwd, env, scope: 'user', context: 'user', cliVersion: '99.0.0', targets: ['generic'],
      }, native.runtime);
      expect(managedCommandRecoveryPlanChanges(review)).toContainEqual(expect.objectContaining({ kind: 'remove', pluginId: selector }));
      const settings = path.join(native.claudeHome, 'settings.json');
      const before = await fs.readJson(settings);
      try {
        await fs.outputJson(settings, { ...before, permissions: { allow: [`Bash(aw command run ${selector}/claude -- *)`] } });
        const stale = await executeRecovery(review, { yes: true });
        expect(stale).toMatchObject({ ok: false, blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]),
          outputsMayHaveChanged: false });
        expect((await resolveManagedCommand(`${selector}/claude`, env)).launch.entry).toBe('main.mjs');
      } finally {
        await review.context.dispose();
        await fs.outputJson(settings, before);
      }
    }
    const updated = await publicCli('plugin', 'sync', selector, '--context', 'user', ...targetArgs, '--yes');
    expect(updated, JSON.stringify(updated)).toMatchObject({ code: 0, receipt: { data: {
      changes: { outputs: 'changed' },
      commandResults: [{ selector, action: 'removed', availability: 'removed', blockerCodes: [] }],
    } } });
    expect(await fs.pathExists(path.join(env.AW_HOME!, 'commands', 'packages', packages[0]!.packageId))).toBe(false);
    await expect(resolveManagedCommand(selector, env)).rejects.toMatchObject({ code: 'commandNotFound' });
  });

  it('preserves shared native producer authority during a scoped Skill uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const authoringRoot = path.join(cwd, 'native-removal-authoring');
    const pluginRoot = path.join(authoringRoot, 'plugins/native-removal');
    const fixture = nativeToolFixture();
    for (const [relative, content] of Object.entries(fixture.files)) {
      await fs.outputFile(path.join(pluginRoot, relative), content);
    }
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Native removal fixture.\n---\n{{aw.command}}\n');
    await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'process.exit(0);\n');
    const configure: NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]> = (manifest) => {
      manifest.platforms = ['claude'];
      manifest.skills = './skills';
      manifest.command = normalizePluginCommand({ mode: 'static', sourceDir: './tools',
          routes: { fallback: { runner: 'node', entry: 'run.mjs' } } }, manifest);
      manifest.nativeTools = { reader: fixture.closure.reader, definitions: fixture.closure.definitions.map((definition) => ({
        key: definition.key, protocol: definition.protocol,
      })), consumers: structuredClone(fixture.closure.consumers) };
    };
    await createCatalogSnapshotFixture(authoringRoot, 'native-removal', [], 'Native removal fixture\n', configure);
    await fs.copy(path.resolve(import.meta.dirname, '../../../../plugins/marketplace-source.json'),
      path.join(authoringRoot, 'plugins/marketplace-source.json'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), { schemaVersion: 1, kind: 'catalog',
      workspaceIdentity: 'fixture:native-removal', sourceIdentity: `sha256:${'b'.repeat(64)}` });
    const native = await createClaudeNativeTestRuntime(isolation);
    async function run(args: string[]) {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], {
        cwd, env, io: output.io,
        interactive: false, nativeCliRunner: native.nativeCliRunner
      });
      return { exitCode, receipt: JSON.parse(output.readStdout()) };
    }
    expect(await run(['source', 'add', 'team', '--path', sourceRoot, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
    expect(await run(['source', 'sync', 'team'])).toMatchObject({ exitCode: 0 });
    await writePreferences({ scope: 'user', cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences',
      targets: ['claude'], exclusions: [] });
    const selection = ['team/native-removal', '--scope', 'user', '--context', 'user'];
    const installed = await run(['plugin', 'install', ...selection, '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({
      exitCode: 0, receipt: {
        schemaVersion: 2,
        status: 'success',
        data: {}
      }
    });
    await fs.ensureDir(path.join(cwd, '.git'));
    const sharedActivation = await run(['plugin', 'install', 'team/native-removal', '--scope', 'project', '--context', 'project', '--yes']);
    expect(sharedActivation, JSON.stringify(sharedActivation)).toMatchObject({ exitCode: 0 });
    const command = (await listManagedCommandPackages(env)).packages[0]!;
    const before = await readInstalledCommandProducer(command.resourceRoot!);
    const installedNative = await fs.readJson(native.installedPath);
    const intentOptions = { cwd, env, scope: 'user' as const };
    expect(before.nativeTools).toEqual(fixture.closure);
    const preview = await uninstallWriteCommand(['team/native-removal'], { cwd, platform: 'claude', scope: 'user' },
      { ...native.runtime, previewOperationPlan: true });
    expect(operationPlanNativeToolChanges(preview.operationPlan!)).toEqual([]);
    const removed = await run(['plugin', 'remove', ...selection, '--yes']);
    expect(removed, JSON.stringify(removed)).toMatchObject({
      exitCode: 0, receipt: {
        schemaVersion: 2,
        status: 'success',
        data: {}
      }
    });
    expect(removed.receipt.data.nativeToolChanges ?? []).toEqual([]);
    expect(await readInstalledCommandProducer(command.resourceRoot!)).toEqual(before);
    expect((await resolveManagedCommand(command.selector, env)).producer!.nativeTools).toEqual(fixture.closure);
    expect(await fs.readJson(native.installedPath)).toEqual(installedNative);
    expect((await readIntentFixture(intentOptions)).roots).toEqual([]);
  });

  // Test Value Gate: a retained Native Skill does not exercise deletion of AW-owned
  // command resources. A real command package must survive an unconfirmed removal,
  // then disappear with its binding after the existing --yes confirmation.
  it.each(['id', 'selector', 'force'] as const)('requires confirmation and reports removal of an owned command package through %s', async (entry) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    await fs.ensureDir(path.join(cwd, '.git'));
    const sourceRoot = path.join(cwd, 'owned-native-source');
    const fixture = nativeToolFixture();
    const pluginRoot = path.join(sourceRoot, 'plugins/owned-native');
    const packageSource = path.join(pluginRoot, 'tools');
    for (const [relative, content] of Object.entries(fixture.files)) {
      await fs.outputFile(path.join(pluginRoot, relative), content);
    }
    await fs.outputFile(path.join(packageSource, 'run.mjs'), 'process.exit(0);\n');
    await createCatalogSnapshotFixture(sourceRoot, 'owned-native', [], 'Owned native fixture\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.extensions = { permissions: [{ name: 'tool', allow: ['echo hello'] }] };
      manifest.command = normalizePluginCommand({ mode: 'static', sourceDir: './tools',
          routes: { fallback: { runner: 'node', entry: 'run.mjs' } } }, manifest);
      manifest.nativeTools = { reader: fixture.closure.reader, definitions: fixture.closure.definitions.map((definition) => ({
        key: definition.key, protocol: definition.protocol,
      })), consumers: structuredClone(fixture.closure.consumers) };
    });
    const native = await createClaudeNativeTestRuntime(isolation);
    async function run(args: string[]) {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], {
        cwd, env, io: output.io,
        interactive: false, nativeCliRunner: native.nativeCliRunner
      });
      return { exitCode, receipt: JSON.parse(output.readStdout()) };
    }
    expect(await run(['source', 'add', 'team', '--path', sourceRoot, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
    expect(await run(['source', 'sync', 'team'])).toMatchObject({ exitCode: 0 });
    const id = 'team/owned-native';
    expect(await run(['command', 'package', 'sync', id, '--yes'])).toMatchObject({ exitCode: 0 });
    const installed = (await listManagedCommandPackages(env)).packages[0]!;
    const producer = installed.owner.producer;
    const resourceRoot = installed.resourceRoot!;
    const intentOptions = { cwd, env, scope: 'project' as const };
    await writeIntentFixture(intentOptions, { roots: [{ pluginId: 'team/owned-native' }], targets: ['claude'] });
    const beforeIntent = await readIntentFixture(intentOptions);
    const preferencesPath = await resolvePreferencesPath(intentOptions);
    const beforePreferences = await fs.readFile(preferencesPath);
    const beforePayload = await fs.readFile(path.join(resourceRoot, 'run.mjs'));
    const before = await readInstalledCommandProducer(resourceRoot);
    expect((await resolveManagedCommand(id, env)).producer).toEqual(before);
    const request = ['command', 'package', 'remove',
      entry === 'selector' ? id : installed.packageId,
      ...(entry === 'force' ? ['--force'] : []),
    ];
    const refused = await run(request);
    expect(refused, JSON.stringify(refused)).toMatchObject({
      exitCode: 3, receipt: {
        schemaVersion: 2,
        status: 'blocked',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
        data: {}
      }
    });
    expect(await readInstalledCommandProducer(resourceRoot)).toEqual(before);
    expect((await resolveManagedCommand(id, env)).producer).toEqual(before);
    expect(await readIntentFixture(intentOptions)).toEqual(beforeIntent);
    expect(await fs.readFile(preferencesPath)).toEqual(beforePreferences);
    expect(await fs.readFile(path.join(resourceRoot, 'run.mjs'))).toEqual(beforePayload);
    const removed = await run([...request, '--yes']);
    expect(removed, JSON.stringify(removed)).toMatchObject({
      exitCode: 0, receipt: {
        schemaVersion: 2,
        status: 'success',
        data: {}
      }
    });
    expect(removed.receipt.data.nativeToolChanges).toEqual([{ producer, before: fixture.closure, after: null }]);
    expect(await fs.pathExists(resourceRoot)).toBe(false);
    await expect(resolveManagedCommand(id, env)).rejects.toMatchObject({ code: 'commandNotFound' });
    expect(await readIntentFixture(intentOptions)).toEqual(beforeIntent);
    expect(await fs.readFile(preferencesPath)).toEqual(beforePreferences);
  });
});
