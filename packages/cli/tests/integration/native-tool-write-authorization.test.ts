import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { syncWriteCommand as nativeSyncWriteCommand, uninstallWriteCommand as nativeUninstallWriteCommand } from '../../src/commands/write-commands.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { listManagedCommandPackages, listManagedCommands, publishManagedCommandBindings, readInstalledCommandProducer, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { readIntentFixture, writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createNativeTestExecution } from '../helpers/native-execution-fixture.js';
import { managedCommandProducerIdentity } from '../../src/utils/managed-command-materialization.js';
import { withResolvedCatalogPlugin } from '../../src/utils/multi-source-catalog.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
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
  // Test Value Gate: projection-only tests cannot prove confirmation precedes
  // producer, intent and platform writes. Use real CLI/catalog/installed state,
  // and the same accepted-plan contract used by the existing Review bridge.
  it('requires explicit confirmation for introduction, binding-only change and deletion, and rejects an old accepted plan', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'native-review-source');
    const pluginRoot = path.join(sourceRoot, 'plugins/native-review');
    const required = nativeToolFixture();
    const preferred = nativeToolFixture({ policy: 'preferred' });
    const native = await createClaudeNativeTestRuntime(isolation);
    const settingsPath = path.join(native.claudeHome, 'settings.json');
    const intentOptions = { scope: 'user' as const, cwd, env };
    const writeOptions = { cwd, platform: 'claude' as const, scope: 'user' as const };

    async function snapshot(fixture: ReturnType<typeof nativeToolFixture> | undefined, fallback?: string) {
      for (const [relative, content] of Object.entries(required.files)) {
        await fs.outputFile(path.join(pluginRoot, relative), content);
      }
      await fs.outputFile(path.join(pluginRoot, 'tools/run.mjs'), 'process.exit(0);\n');
      await createCatalogSnapshotFixture(sourceRoot, 'native-review', [], 'Native Review fixture\n', (manifest) => {
        manifest.extensions = { permissions: [{ name: 'tool', allow: ['echo hello'] }] };
        manifest.managedCommands = {
          packages: [{ key: 'tools', sourceDir: './tools', scope: 'user', platforms: ['claude'] }],
          sets: [{ set: 'tools', producer: { kind: 'package', packageKey: 'tools' }, mode: 'static',
            entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }],
        };
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
    const publicWrite = (command: string, yes = false) => run([command, 'team/native-review',
      '--target', 'claude-code', '--scope', 'user', ...(yes ? ['--yes'] : [])]);
    const sourceSync = () => run(['catalog', 'source', 'sync', 'team', '--yes']);
    const beforeIntent = await readIntentFixture(intentOptions);
    await snapshot(required);
    expect(await run(['catalog', 'source', 'add', 'team', '--path', sourceRoot, '--no-auto-check']))
      .toMatchObject({ exitCode: 0 });
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });

    const refusedIntroduction = await publicWrite('install');
    expect(refusedIntroduction).toMatchObject({ exitCode: 1, receipt: { ok: false } });
    expect(JSON.stringify(refusedIntroduction.receipt)).toContain('nativeToolAuthorizationRequired');
    expect((await listManagedCommandPackages(env)).packages).toEqual([]);
    expect(await fs.pathExists(settingsPath)).toBe(false);
    expect(await readIntentFixture(intentOptions)).toEqual(beforeIntent);

    const installedText = await run(['install', 'team/native-review', '--target', 'claude-code',
      '--scope', 'user', '--yes'], false);
    expect(installedText.exitCode, installedText.stdout).toBe(0);
    expect(installedText.stdout).toContain('原生工具 team/native-review after: job · aw.windows-job.v1 · managed-command-set/tools · win32 · required');
    const installed = (await listManagedCommandPackages(env)).packages[0]!;
    const initialProducer = await readInstalledCommandProducer(installed.resourceRoot);
    const initialSettings = await fs.readFile(settingsPath, 'utf8');
    const initialIntent = await readIntentFixture(intentOptions);
    expect(initialProducer.nativeTools).toEqual(required.closure);
    async function unchanged() {
      expect(await readInstalledCommandProducer(installed.resourceRoot)).toEqual(initialProducer);
      expect(await fs.readFile(settingsPath, 'utf8')).toBe(initialSettings);
      expect(await readIntentFixture(intentOptions)).toEqual(initialIntent);
    }

    await snapshot(preferred);
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });
    for (const command of ['sync', 'reinstall']) {
      const refused = await publicWrite(command);
      expect(refused).toMatchObject({ exitCode: 1, receipt: { ok: false } });
      expect(JSON.stringify(refused.receipt)).toContain('nativeToolAuthorizationRequired');
      await unchanged();
    }
    const reviewed = await syncWriteCommand(['team/native-review'], writeOptions, { ...native.runtime, previewOperationPlan: true });
    const projection = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'sync', pluginId: 'team/native-review', platform: 'claude', scope: 'user' },
      evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: reviewed.operationPlan! } });
    expect(projection.changes).toContainEqual(expect.objectContaining({ title: '使用原生工具 · team/native-review · tools', description: expect.stringContaining('preferred · fallback=portable') }));
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
    const changedProducer = await readInstalledCommandProducer(installed.resourceRoot);
    expect(changedProducer.nativeTools!.definitions).toEqual(initialProducer.nativeTools!.definitions);
    expect(changedProducer.nativeTools!.consumers[0]!.tools[0]).toMatchObject({ policy: 'preferred', fallback: 'portable-two' });

    await snapshot(undefined);
    expect(await sourceSync()).toMatchObject({ exitCode: 0 });
    const refusedDeletion = await publicWrite('sync');
    expect(refusedDeletion).toMatchObject({ exitCode: 1, receipt: { ok: false } });
    expect(JSON.stringify(refusedDeletion.receipt)).toContain('nativeToolAuthorizationRequired');
    expect(await readInstalledCommandProducer(installed.resourceRoot)).toEqual(changedProducer);
    const removedText = await run(['sync', 'team/native-review', '--target', 'claude-code',
      '--scope', 'user', '--yes'], false);
    expect(removedText.exitCode, removedText.stdout).toBe(0);
    expect(removedText.stdout).toContain('原生工具 team/native-review before: job · aw.windows-job.v1 · managed-command-set/tools · win32 · preferred · fallback=portable-two');
    expect((await readInstalledCommandProducer(installed.resourceRoot)).nativeTools).toBeUndefined();
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
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/SKILL.md'), '---\nname: provider\ndescription: Native removal fixture.\n---\n{{aw.command:tools/run}}\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/provider/run.mjs'), 'process.exit(0);\n');
    const configure: NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]> = (manifest) => {
      manifest.skills = './skills';
      manifest.managedCommands = { packages: [], sets: [{ set: 'tools',
        producer: { kind: 'static-skill', platform: 'claude', skillKey: 'provider' }, mode: 'static',
        entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }] };
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
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io,
        interactive: false, nativeCliRunner: native.nativeCliRunner });
      return { exitCode, receipt: JSON.parse(output.readStdout()) };
    }
    expect(await run(['catalog', 'source', 'add', 'team', '--path', sourceRoot, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
    expect(await run(['catalog', 'source', 'sync', 'team'])).toMatchObject({ exitCode: 0 });
    const selection = ['team/native-removal', '--target', 'claude-code', '--scope', 'user'];
    const installed = await run(['install', ...selection, '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, receipt: { ok: true } });
    const command = (await listManagedCommands(env)).commands[0]!;
    const before = await readInstalledCommandProducer(command.resourceRoot!);
    const intentOptions = { cwd, env, scope: 'user' as const };
    expect(before.nativeTools).toEqual(fixture.closure);
    const preview = await uninstallWriteCommand(['team/native-removal'], { cwd, platform: 'claude', scope: 'user' },
      { ...native.runtime, previewOperationPlan: true });
    expect(preview.operationPlan!.actions.flatMap((action) => action.nativeToolChanges ?? [])).toEqual([]);
    const removed = await run(['uninstall', ...selection]);
    expect(removed, JSON.stringify(removed)).toMatchObject({ exitCode: 0, receipt: { ok: true } });
    expect(removed.receipt.nativeToolChanges ?? []).toEqual([]);
    expect(await readInstalledCommandProducer(command.resourceRoot!)).toEqual(before);
    expect((await resolveManagedCommand(command.id, env)).producer!.nativeTools).toEqual(fixture.closure);
    expect((await fs.readJson(native.installedPath)).plugins['native-removal@aw'] ?? []).toEqual([]);
    expect((await readIntentFixture(intentOptions)).roots).toEqual([expect.objectContaining({ pluginId: 'team/native-removal' })]);
  });

  // Test Value Gate: shared native Skill retention cannot prove the opposite
  // boundary. A real owned Skill and binding must survive a refused public
  // uninstall, then disappear together after the existing --yes confirmation.
  it.each(['uninstall', 'cleanup', 'retire'] as const)('requires confirmation and reports removal of an AW-owned native Skill producer through %s', async (command) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'owned-native-source');
    const fixture = nativeToolFixture();
    const pluginRoot = path.join(sourceRoot, 'plugins/owned-native');
    for (const [relative, content] of Object.entries(fixture.files)) {
      await fs.outputFile(path.join(pluginRoot, relative), content);
    }
    await fs.outputFile(path.join(pluginRoot, 'scripts/render.mjs'), 'throw new Error("uninstall must not render");\n');
    await createCatalogSnapshotFixture(sourceRoot, 'owned-native', [], 'Owned native fixture\n', (manifest) => {
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { targets: [{ id: 'owned', platform: 'claude', scopes: ['project'],
        target: 'claude.skill', states: ['present'], refreshKeys: [], skillKey: 'owned' }] };
      manifest.managedCommands = { packages: [], sets: [{ set: 'tools', producer: { kind: 'artifact', artifactId: 'owned' },
        mode: 'static', entries: [{ key: 'run', runner: 'node', entry: 'run.mjs' }] }] };
      manifest.nativeTools = { reader: fixture.closure.reader, definitions: fixture.closure.definitions.map((definition) => ({
        key: definition.key, protocol: definition.protocol,
      })), consumers: structuredClone(fixture.closure.consumers) };
    });
    const native = await createClaudeNativeTestRuntime(isolation);
    async function run(args: string[]) {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io,
        interactive: false, nativeCliRunner: native.nativeCliRunner });
      return { exitCode, receipt: JSON.parse(output.readStdout()) };
    }
    expect(await run(['catalog', 'source', 'add', 'team', '--path', sourceRoot, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
    expect(await run(['catalog', 'source', 'sync', 'team'])).toMatchObject({ exitCode: 0 });
    const producer = await withResolvedCatalogPlugin({ selector: 'team/owned-native', cliVersion: '1.0.0', env,
      consume: ({ plugin }) => managedCommandProducerIdentity({ plugin, producer: { kind: 'artifact', artifactId: 'owned' },
        platform: 'claude', scope: 'project', cwd }) });
    const skillsRoot = path.join(cwd, '.claude/skills');
    const resourceRoot = path.join(skillsRoot, 'owned');
    await fs.outputFile(path.join(resourceRoot, 'SKILL.md'), '---\nname: owned\ndescription: Owned native fixture.\n---\n');
    await fs.outputFile(path.join(resourceRoot, 'run.mjs'), 'process.exit(0);\n');
    for (const [relative, content] of Object.entries(fixture.files)) {
      await fs.outputFile(path.join(resourceRoot, relative), content);
    }
    await writeSkillOwnerMarker({ skillRoot: resourceRoot, allowedRoot: skillsRoot,
      identity: { owner: 'agent-workflows', sourceId: producer.sourceId, sourceIdentity: producer.sourceIdentity,
        pluginId: 'team/owned-native', plugin: 'owned-native', artifactKey: 'owned', platform: 'claude', scope: 'project' } });
    const [id] = await publishManagedCommandBindings({ producer, resourceRoot, nativeTools: fixture.closure,
      sets: [{ set: 'tools', state: 'present', entries: [normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'run.mjs' })] }], env });
    await fs.ensureDir(path.join(cwd, '.git'));
    const intentOptions = { cwd, env, scope: 'project' as const };
    await writeIntentFixture(intentOptions, {
      roots: [{ pluginId: 'team/owned-native', platforms: ['claude'] }], dependencyScopeOverrides: [] });
    const beforeIntent = await readIntentFixture(intentOptions);
    const before = await readInstalledCommandProducer(resourceRoot);
    expect((await resolveManagedCommand(id!, env)).producer).toEqual(before);
    if (command === 'retire') {
      await fs.remove(pluginRoot);
      await createCatalogSnapshotFixture(sourceRoot, 'remaining');
      expect(await run(['catalog', 'source', 'sync', 'team', '--yes'])).toMatchObject({ exitCode: 0 });
    }
    const selection = ['team/owned-native', '--target', 'claude-code', '--scope', 'project'];
    const request = command === 'retire' ? ['intent', 'retire', ...selection] : [command, ...selection];
    const refused = await run(request);
    expect(refused, JSON.stringify(refused)).toMatchObject({ exitCode: 1, receipt: { ok: false } });
    expect(JSON.stringify(refused.receipt)).toContain(command === 'retire' ? 'operationReviewRequired' : 'nativeToolAuthorizationRequired');
    expect(await readInstalledCommandProducer(resourceRoot)).toEqual(before);
    expect((await resolveManagedCommand(id!, env)).producer).toEqual(before);
    expect(await readIntentFixture(intentOptions)).toEqual(beforeIntent);
    const removed = await run([...request, '--yes']);
    expect(removed, JSON.stringify(removed)).toMatchObject({ exitCode: 0, receipt: { ok: true } });
    expect(removed.receipt.nativeToolChanges).toEqual([{ producer, before: fixture.closure, after: null }]);
    expect(await fs.pathExists(resourceRoot)).toBe(false);
    await expect(resolveManagedCommand(id!, env)).rejects.toMatchObject({ code: 'commandNotFound' });
    expect((await readIntentFixture(intentOptions)).roots).toEqual(command === 'retire' ? [] : beforeIntent.roots);
  });
});
