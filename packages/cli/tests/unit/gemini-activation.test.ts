import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentBinding, DeploymentObservation, MutationContext, PreparationEvidence, PreparedDeployment, ReadContext } from '../../src/platforms/contracts.js';
import { createNativeLifecycleServices } from '../../src/platforms/lifecycle-native-services.js';
import { executeNativeLifecycle } from '../../src/platforms/lifecycle-native.js';
import type { PlatformDriverState } from '../../src/platforms/lifecycle.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { finishGeminiNativeMutation, geminiActivationEvidence, geminiExtensionPaths, geminiPathEnabled, geminiScopePattern,
  geminiUserActivation, readGeminiActivationSnapshot, setGeminiActivation } from '../../src/platforms/gemini-activation.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';

describe('Gemini shared extension activation', () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => fs.remove(directory))); });

  async function fixture(userEnabled = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-gemini-activation-'));
    temporary.push(directory);
    const home = await fs.realpath(directory);
    const project = path.join(home, 'project one');
    const otherProject = path.join(home, 'project two');
    await Promise.all([fs.ensureDir(project), fs.ensureDir(otherProject)]);
    const ctx: ReadContext = { cwd: project, env: { HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home, AW_HOME: path.join(home, 'aw') } };
    const binding: DeploymentBinding = { id: 'gemini-project', platform: 'gemini', route: 'gemini-extension', scope: { kind: 'project', projectRoot: project },
      plugin: { sourceId: 'test', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginId: 'test/demo', version: '1.0.0' },
      consumers: [{ id: 'gemini', product: 'cli', version: '0.67.0', availability: 'available', reasonCodes: [],
        entry: { kind: 'cli', executable: '/fake/client', configRoot: path.join(home, '.gemini') } }],
      physicalKey: '', activationKey: 'project', renderUnitIds: [] };
    const layout = await getDeploymentLayout(ctx, binding);
    binding.physicalKey = layout.renderUnits[0]!.physicalKey;
    binding.renderUnitIds = layout.renderUnits.map((unit) => unit.id);
    const component = deploymentPackageComponent(binding, layout);
    if (component.kind !== 'owned-directory') throw new Error('Expected a directory package.');
    await fs.ensureDir(component.path);
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity });
    const installed = path.join(geminiExtensionPaths(ctx).root, 'demo');
    await fs.outputJson(path.join(installed, '.gemini-extension-install.json'), { type: 'local', source: layout.packageRoot });
    await fs.outputJson(path.join(installed, 'gemini-extension.json'), { name: 'demo', version: '1.0.0' });
    const evidence: PreparationEvidence = { fingerprint: 'frozen', layout, ownership: [{ component, state: 'present' }],
      sharedReferences: 'present', nativeIdentity: layout.nativeIdentity, contentMatches: true, userActivationEnabled: userEnabled };
    return { ctx, binding, evidence, identity: layout.nativeIdentity, file: geminiExtensionPaths(ctx).file, home, project, otherProject };
  }

  // Test Value Gate: native User enable removes HOME child Workspace rules.
  // The checked installer result must restore both project references and fields.
  it('restores project rules and sibling fields after the fixed native installer enables User', async () => {
    const { ctx, binding, evidence, identity, file, home, project, otherProject } = await fixture();
    const other = geminiScopePattern(otherProject);
    const nested = geminiScopePattern(path.join(project, 'nested'));
    await fs.outputJson(file, { demo: { overrides: ['!*', other, `!${nested}`], retained: { setting: 1 } }, sibling: { overrides: ['!*'], retained: 'keep' } });
    const before = await readGeminiActivationSnapshot(ctx);
    // Independent fixed-version sample: User enable deletes the child rule and
    // the native schema strips unknown entry fields before writing its map.
    const runner = vi.fn(async (_invocation: NativeCliInvocation) => {
      await fs.writeFile(file, JSON.stringify({ demo: { overrides: ['!*', geminiScopePattern(home)] }, sibling: { overrides: ['!*'] } }, null, 2));
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const observation: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'present', ownership: 'aw', registration: 'absent',
      nativeIdentity: identity, consumers: [], components: [], diagnostics: [], prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } } };
    const effect = { id: 'register', kind: 'register' as const, physicalKey: binding.physicalKey, activationKey: binding.activationKey,
      componentIds: [], destination: identity.sourceLocation, destructive: false };
    const prepared: PreparedDeployment<PlatformDriverState> = { plan: { binding, operation: 'ensure', expected: { components: [], omitted: [], unmet: [], sources: {} },
      projections: [], effects: [effect], evidence }, driverState: { before: observation, identity, product: binding.consumers[0]!,
      packageComponent: evidence.ownership[0]!.component, bundle: null, contributions: [], removals: [] } };
    const noMutation = async () => ({ changed: false, mutation: 'none' as const });
    const execution: MutationContext = { ...ctx, runner, geminiActivationSnapshot: geminiActivationEvidence(before), services: {
      verifyEvidence: async () => true, publishPackage: noMutation, writeContribution: noMutation, removeOwned: noMutation,
      setActivation: noMutation, registerMarketplace: noMutation,
    } };
    await expect(executeNativeLifecycle(execution, prepared, effect)).resolves.toMatchObject({ mutation: 'confirmed' });
    expect(runner.mock.calls.map(([invocation]) => invocation.args)).toEqual([['extensions', 'install', identity.sourceLocation]]);
    const value = await fs.readJson(file);
    expect(value).toEqual({ demo: { overrides: ['!*', other, geminiScopePattern(project), `!${nested}`], retained: { setting: 1 } },
      sibling: { overrides: ['!*'], retained: 'keep' } });
    expect(geminiPathEnabled(value.demo.overrides, project)).toBe(true);
    expect(geminiPathEnabled(value.demo.overrides, otherProject)).toBe(true);
    expect(geminiPathEnabled(value.demo.overrides, path.join(project, 'nested'))).toBe(false);
    expect(geminiPathEnabled(value.demo.overrides, path.join(home, 'neutral'))).toBe(false);
    expect(geminiPathEnabled(value.demo.overrides, path.join(path.dirname(home), 'outside'))).toBe(false);
  });

  // Test Value Gate: User install/remove and one project's removal must preserve
  // the other project's explicit activation in the shared native map.
  it('preserves other projects through project refresh and User activation changes', async () => {
    const { ctx, binding, evidence, identity, file, home, project, otherProject } = await fixture();
    const other = geminiScopePattern(otherProject);
    await fs.outputJson(file, { demo: { overrides: ['!*', other] }, sibling: { overrides: ['*'], setting: 'keep' } });
    const execution = { ...ctx, geminiActivationSnapshot: geminiActivationEvidence(await readGeminiActivationSnapshot(ctx)) };
    const services = createNativeLifecycleServices(execution, evidence);
    await services.setActivation(binding, identity, true);
    const beforeUpdate = await readGeminiActivationSnapshot(ctx);
    await finishGeminiNativeMutation(ctx, evidence, binding, identity, 'refresh', beforeUpdate);
    Object.assign(execution.geminiActivationSnapshot, geminiActivationEvidence(beforeUpdate));
    const user = { ...binding, id: 'gemini-user', scope: { kind: 'user' as const } };
    await services.setActivation(user, identity, true);
    let value = await fs.readJson(file);
    expect(value.demo.overrides).toEqual(['*', other, geminiScopePattern(project)]);
    expect(geminiPathEnabled(value.demo.overrides, path.join(home, 'neutral'))).toBe(true);
    await services.setActivation(user, identity, false);
    value = await fs.readJson(file);
    expect(value.demo.overrides).toEqual(['!*', other, geminiScopePattern(project)]);
    expect(geminiPathEnabled(value.demo.overrides, path.join(home, 'neutral'))).toBe(false);
    await services.setActivation(binding, identity, false);
    expect(await fs.readJson(file)).toEqual({ demo: { overrides: ['!*', other] }, sibling: { overrides: ['*'], setting: 'keep' } });
  });

  it('keeps a proven existing global activation when a project is added and removed', async () => {
    const { ctx, binding, evidence, identity, file, home, project } = await fixture(true);
    // Native default activation is global even without an AW User declaration.
    await fs.outputJson(file, { demo: { overrides: [geminiScopePattern(home)] } });
    const snapshot = await readGeminiActivationSnapshot(ctx);
    expect(geminiUserActivation(snapshot, identity.packageId, home)).toBe(true);
    const execution = { ...ctx, geminiActivationSnapshot: geminiActivationEvidence(snapshot) };
    const services = createNativeLifecycleServices(execution, evidence);
    await services.setActivation(binding, identity, true);
    expect((await fs.readJson(file)).demo.overrides).toEqual(['*', geminiScopePattern(project)]);
    await services.setActivation(binding, identity, false);
    expect((await fs.readJson(file)).demo.overrides).toEqual(['*']);
  });

  it('retains external changes and refuses foreign or ambiguous activation evidence', async () => {
    const { ctx, binding, evidence, identity, file, home } = await fixture();
    await fs.outputJson(file, { demo: { overrides: ['!*'] } });
    const baseline = await readGeminiActivationSnapshot(ctx);
    const external = { demo: { overrides: ['!*'] }, sibling: { overrides: ['*'] } };
    await fs.writeJson(file, external);
    await expect(setGeminiActivation(ctx, evidence, binding, identity, true, baseline)).rejects.toMatchObject({ code: 'operationPlanStale', mutation: 'none' });
    await expect(finishGeminiNativeMutation(ctx, evidence, binding, identity, 'refresh', baseline)).rejects.toMatchObject({ code: 'operationPlanStale' });
    expect(await fs.readJson(file)).toEqual(external);
    const nativeWithExternalChange = { demo: { overrides: ['!*', geminiScopePattern(home)] }, sibling: { overrides: ['*'] } };
    await fs.writeJson(file, nativeWithExternalChange);
    await expect(finishGeminiNativeMutation(ctx, evidence, binding, identity, 'register', baseline)).rejects.toMatchObject({ code: 'operationPlanStale' });
    expect(await fs.readJson(file)).toEqual(nativeWithExternalChange);
    await fs.writeJson(file, external);
    await fs.writeJson(path.join(geminiExtensionPaths(ctx).root, 'demo', '.gemini-extension-install.json'), { type: 'local', source: path.join(home, 'foreign') });
    await expect(setGeminiActivation(ctx, evidence, binding, identity, true, await readGeminiActivationSnapshot(ctx))).rejects.toMatchObject({ code: 'nativeIdentityUnconfirmed', mutation: 'none' });
    expect(await fs.readJson(file)).toEqual(external);
    await fs.writeJson(file, { demo: { overrides: [`!${geminiScopePattern(home)}`] } });
    expect(geminiUserActivation(await readGeminiActivationSnapshot(ctx), identity.packageId, home)).toBe('unknown');
  });
});
