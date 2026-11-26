import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/index.js';
import { createEmptyPreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { createEmptyIntent } from '../../src/intent/intent-codec.js';
import { observeIntent, writeIntent } from '../../src/intent/intent-store.js';
import { prepareRecovery, executeRecovery } from '../../src/recovery/coordinator.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { patchPluginConfigStore, resetPluginConfigStore } from '../../src/utils/plugin-config.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { CatalogPreparationReadScope } from '../../src/utils/catalog-operation-context.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: the public lifecycle must not write blocked targets or lose actionable config diagnostics while other targets finish.
describe('platform configuration diagnostic lifecycle', () => {
  it('isolates missing and invalid native configuration from a ready Portable target, and observes residual configuration', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    installNativeTestDiscovery({ platforms: ['claude'] });
    const source = path.join(cwd, 'config-diagnostics');
    await fs.outputFile(path.join(source, 'plugins/demo/skills/diagnostic/SKILL.md'), '---\nname: diagnostic\ndescription: Test diagnostic fixture.\n---\nFixture skill.\n');
    await fs.outputFile(path.join(source, 'plugins/demo/skills/diagnostic/README.md'), 'Fixture skill.\n');
    const writeSource = (readme: string) => createCatalogSnapshotFixture(source, 'demo', [], readme, (manifest) => {
      manifest.platforms = ['claude', 'generic'];
      manifest.skills = './skills';
      manifest.config = { schemaVersion: 5, fields: {}, platforms: {
        claude: { fields: { nativeProfile: { type: 'string', required: true } } },
        generic: { fields: { portableProfile: { type: 'string', required: true } } },
      } };
    });
    await writeSource('Fixture plugin.\n');
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] },
      expectedDigest: (await readCatalogSourcesConfigSnapshot(env)).digest, env });
    await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['claude', 'generic'] });
    const { nativeCliRunner } = await createClaudeNativeTestRuntime(isolation);
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli(['plugin', ...args, '--context', 'user', '--json'], { cwd, env, nativeCliRunner, io: output.io, interactive: false });
      const payload = JSON.parse(output.readStdout());
      expect(payload.schemaVersion).toBe(2);
      const stderr = output.readStderr();
      expect(stderr).not.toContain('"schemaVersion"');
      return { exitCode, payload, stderr };
    };
    const scopedDiagnostic = (code: string, target: string, key: string, reasonCode: string) => expect.objectContaining({ code,
      subject: { pluginId: 'team/demo', target, scope: 'user' }, detail: { reasonCode, fieldKeys: [key] } });
    const missingNative = scopedDiagnostic('requiredConfigMissing', 'claude', 'nativeProfile', 'missingRequired');
    const missingPortable = scopedDiagnostic('requiredConfigMissing', 'generic', 'portableProfile', 'missingRequired');
    const install = () => run(['install', 'team/demo', '--scope', 'user', '--yes']);
    const location = { scope: 'user' as const, cwd, env };
    const intentBefore = await observeIntent(location);
    const sourceBefore = await readCatalogGenerationState(env);
    const firstBlocked = await install();
    expect(firstBlocked).toMatchObject({ exitCode: 3, payload: { status: 'blocked',
      diagnostics: expect.arrayContaining([missingNative, missingPortable]),
      data: { changes: { requirements: 'none', sources: 'none', outputs: 'none' }, requirements: { state: 'absent', roots: [] } },
      nextActions: expect.arrayContaining([expect.objectContaining({ kind: 'command', argv: ['aw', 'source', 'sync', 'team'] })]) } });
    expect(firstBlocked.stderr).toContain('requiredConfigMissing');
    expect(await observeIntent(location)).toEqual(intentBefore);
    expect(await readCatalogGenerationState(env)).toEqual(sourceBefore);
    const generation = await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    expect(generation.outcome).toBe('activated');
    const readScope = new CatalogPreparationReadScope({ env });
    const catalog = await readScope.resolve({ sourceIds: ['team'] });
    await CatalogPreparationReadScope.validateEntries(readScope, catalog.catalog.sources[0]!.resolution!);
    const blocked = await install();
    expect(blocked).toMatchObject({ exitCode: 3, payload: { status: 'blocked', diagnostics: expect.arrayContaining([missingNative, missingPortable]),
      data: { changes: { requirements: 'none', sources: 'none', outputs: 'none' },
        targetResults: expect.arrayContaining([{ pluginId: 'team/demo', target: 'claude', execution: 'not-run' },
        { pluginId: 'team/demo', target: 'generic', execution: 'not-run' }].map((entry) => expect.objectContaining(entry))) } } });
    expect(await observeIntent(location)).toEqual(intentBefore);
    const active = (await readCatalogGenerationState(env)).sources.team!.active!;
    const store = { sourceId: 'team', sourceIdentity: active.sourceIdentity, logicalIdentity: active.logicalIdentity,
      pluginName: 'demo', scope: 'user' as const, cwd, env };
    await patchPluginConfigStore({ ...store, platform: 'claude', updates: { nativeProfile: 12 } });
    const invalidBlocked = await install();
    expect(invalidBlocked).toMatchObject({ exitCode: 3, payload: { status: 'blocked', diagnostics: expect.arrayContaining([
      missingPortable, scopedDiagnostic('invalidConfig', 'claude', 'nativeProfile', 'invalidConfig')]),
      data: { changes: { requirements: 'none', sources: 'none', outputs: 'none' } } } });
    expect(await observeIntent(location)).toEqual(intentBefore);
    expect(invalidBlocked.payload.nextActions).not.toContainEqual(expect.objectContaining({ argv: expect.arrayContaining(['plugin', 'sync']) }));
    // The shared plan/execute entry used by TUI must likewise preserve Intent;
    // a policy-excluded target does not make an otherwise blocked install actionable.
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['claude', 'generic'],
      exclusions: [{ plugin: 'team/demo', target: 'generic' }] });
    const prepared = await prepareRecovery('install', ['team/demo'], { ...location, cliVersion: '1.0.0' }, { nativeCliRunner });
    expect(prepared.blockExecution).toBe(true);
    expect(prepared.plannedImpact).toMatchObject({ declaration: false, outputs: false });
    const executed = await executeRecovery(prepared, { yes: true });
    expect(executed).toMatchObject({ ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      targetResults: expect.arrayContaining([expect.objectContaining({ agent: 'generic', satisfaction: 'excluded' })]) });
    expect(await observeIntent(location)).toEqual(intentBefore);
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['claude', 'generic'] });
    await resetPluginConfigStore({ ...store, platform: 'claude' });
    await patchPluginConfigStore({ ...store, platform: 'generic', updates: { portableProfile: 'ready' } });
    const partial = await install();
    expect(partial).toMatchObject({ exitCode: 4, payload: { status: 'partial', diagnostics: expect.arrayContaining([missingNative]),
      data: { changes: { requirements: 'changed', outputs: 'changed' }, targetResults: expect.arrayContaining([expect.objectContaining({ target: 'claude', execution: 'not-run' }),
        expect.objectContaining({ target: 'generic', execution: 'applied', observation: 'verified' })]) } } });
    expect(await observeIntent(location)).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/demo' }] } });
    const portableOutput = path.join(env.HOME!, '.agents/skills/diagnostic/SKILL.md');
    expect(await fs.pathExists(portableOutput)).toBe(true);
    await patchPluginConfigStore({ ...store, platform: 'claude', updates: { nativeProfile: 12 } });
    const invalid = await run(['sync', 'team/demo', '--yes']);
    expect(invalid).toMatchObject({ exitCode: 4, payload: { status: 'partial', diagnostics: expect.arrayContaining([
      scopedDiagnostic('invalidConfig', 'claude', 'nativeProfile', 'invalidConfig')]) } });
    const invalidStatus = await run(['status', 'team/demo']);
    expect(invalidStatus.payload.diagnostics).toContainEqual(scopedDiagnostic('configInvalid', 'claude', 'nativeProfile', 'invalidConfig'));
    expect(invalidStatus.payload.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'nativeObservationFailed' }));
    await patchPluginConfigStore({ ...store, platform: 'claude', updates: { nativeProfile: 'ready' } });
    const ready = await run(['sync', 'team/demo', '--target', 'claude', '--yes']);
    expect(ready).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    await resetPluginConfigStore({ ...store, platform: 'generic' });
    await resetPluginConfigStore({ ...store, platform: 'claude' });
    const status = await run(['status', 'team/demo']);
    expect(status.payload.diagnostics).toEqual(expect.arrayContaining([missingPortable, missingNative]));
    const syncBlocked = await run(['sync', 'team/demo', '--yes']);
    expect(syncBlocked).toMatchObject({ exitCode: 3, payload: { status: 'blocked',
      data: { changes: { requirements: 'none', sources: 'none', outputs: 'none' } } } });
    // Explicit source refresh can still commit a generation even when no
    // deployment can run. Its receipt must report the actual partial change.
    await writeSource('Updated fixture plugin.\n');
    const refreshed = await run(['sync', 'team/demo', '--refresh', '--yes']);
    expect(refreshed).toMatchObject({ exitCode: 4, payload: { status: 'partial',
      data: { changes: { requirements: 'none', sources: 'changed', outputs: 'none' } } } });
    expect((await readCatalogGenerationState(env)).sources.team!.active!.snapshotDigest).not.toBe(active.snapshotDigest);
    await writeIntent({ ...store }, createEmptyIntent());
    const residual = await run(['status']);
    expect(residual.payload.diagnostics).toEqual(expect.arrayContaining([missingPortable, missingNative]));
    expect(residual.payload.data.extraObserved).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/demo', target: 'generic' }),
      expect.objectContaining({ pluginId: 'team/demo', target: 'claude' }),
    ]));
    for (const residue of residual.payload.data.extraObserved) expect(residue).not.toHaveProperty('blockers');
    await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['generic'] });
    const disabled = await run(['status']);
    expect(disabled.payload.diagnostics).toContainEqual(missingPortable);
    expect(disabled.payload.diagnostics).not.toContainEqual(missingNative);
    expect(await fs.pathExists(portableOutput)).toBe(true);

    const requirementOnly = await run(['install', 'team/demo', '--scope', 'user', '--only', 'requirements']);
    expect(requirementOnly).toMatchObject({ exitCode: 0, payload: { status: 'success',
      data: { changes: { requirements: 'changed', outputs: 'none', sources: 'none' }, targetResults: [] } } });
    expect(await observeIntent(location)).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/demo' }] } });
  }, 30_000);
});
