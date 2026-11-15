import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentBinding, DeploymentObservation, MutationContext, PreparationEvidence, PreparedDeployment, ReadContext } from '../../src/platforms/contracts.js';
import { createNativeLifecycleServices } from '../../src/platforms/lifecycle-native-services.js';
import { executeNativeLifecycle } from '../../src/platforms/lifecycle-native.js';
import { executePlatformLifecycle, type PlatformDriverState } from '../../src/platforms/lifecycle.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { finishGeminiNativeMutation, geminiActivationEvidence, geminiExtensionPaths, geminiPathEnabled, geminiScopePattern,
  geminiUserActivation, readGeminiActivationSnapshot, setGeminiActivation } from '../../src/platforms/gemini-activation.js';
import { SKILL_OWNER_MARKER, readSkillOwnerMarker, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { readPlatformPackageContentDigest } from '../../src/utils/platform-empty-state.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { geminiConsentInput } from '../../src/platforms/gemini-consent.js';

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

  async function replacementFixture(scope: 'user' | 'project' = 'project', failure?: 'install' | 'stale-copy') {
    const item = await fixture(scope === 'user');
    if (scope === 'user') item.binding.scope = { kind: 'user' };
    const { ctx, binding, evidence, identity, file, home, project, otherProject } = item;
    evidence.sharedReferences = scope === 'user' ? 'unknown' : 'present';
    const component = evidence.ownership[0]!.component;
    if (component.kind !== 'owned-directory') throw new Error('Expected a directory package.');
    const installed = path.join(geminiExtensionPaths(ctx).root, identity.packageId);
    await fs.outputJson(path.join(component.path, 'gemini-extension.json'), { name: 'demo', version: '1.0.0' });
    await fs.outputFile(path.join(component.path, 'skills/demo/SKILL.md'), 'Revision 2.\n');
    const oldDigest = (await readPlatformPackageContentDigest(component.path))!;
    const layout = await getDeploymentLayout(ctx, binding);
    const projection = (contentDigest: string) => ({ physicalIdentity: layout.physicalIdentity, contentDigest,
      inputDigest: `sha256:${'c'.repeat(64)}`, components: [{ id: 'skill:demo', nativeName: 'demo', relativeOutputs: ['skills/demo/SKILL.md'] }] });
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: projection(oldDigest) });
    await fs.copy(component.path, installed);
    const oldMarker = await readSkillOwnerMarker({ skillRoot: installed, allowedRoot: geminiExtensionPaths(ctx).root, expectedIdentity: component.identity });
    expect(oldMarker?.nativeProjection?.contentDigest).toBe(oldDigest);
    expect(await readPlatformPackageContentDigest(installed, { excludeRootFiles: ['.gemini-extension-install.json'] })).toBe(oldDigest);
    await fs.outputFile(path.join(component.path, 'skills/demo/SKILL.md'), 'Revision 3.\n');
    const newDigest = (await readPlatformPackageContentDigest(component.path))!;
    expect(newDigest).not.toBe(oldDigest);
    await writeSkillOwnerMarker({ skillRoot: component.path, allowedRoot: component.allowedRoot, identity: component.identity,
      nativeProjection: projection(newDigest) });
    const stagingRoot = path.join(home, 'frozen-new-package');
    await fs.copy(component.path, stagingRoot);
    const original = { demo: { overrides: [scope === 'user' ? '*' : '!*', geminiScopePattern(otherProject), geminiScopePattern(project)], retained: 'keep' },
      sibling: { overrides: ['*'], retained: { setting: 1 } } };
    await fs.outputJson(file, original);
    const before: DeploymentObservation = { physicalKey: binding.physicalKey, package: 'present', ownership: 'aw', registration: 'present',
      nativeIdentity: identity, consumers: [], components: [], diagnostics: [], prerequisites: { agentConsumers: { observation: 'complete', candidates: [], reasonCodes: [] } } };
    const effect = { id: 'refresh', kind: 'refresh' as const, physicalKey: binding.physicalKey,
      componentIds: [], destination: identity.sourceLocation, destructive: false };
    const bundle = { stagingRoot, contentDigest: newDigest };
    const prepared: PreparedDeployment<PlatformDriverState> = { plan: { binding, operation: 'ensure', expected: { components: [], omitted: [], unmet: [], sources: {} },
      projections: [{ renderUnitId: binding.renderUnitIds[0]!, bundle, supplements: [], components: projection(newDigest).components, diagnostics: [] }], effects: [effect], evidence },
    driverState: { before, identity, product: binding.consumers[0]!, packageComponent: component, bundle, contributions: [], removals: [] } };
    const runner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[1] === 'uninstall') {
        await fs.remove(installed);
        await fs.writeFile(file, JSON.stringify({ sibling: { overrides: ['*'] } }, null, 2));
      } else if (invocation.args[1] === 'install') {
        if (failure === 'install') return { exitCode: 1, stdout: '', stderr: 'Controlled install failure.' };
        await fs.copy(component.path, installed);
        await fs.outputJson(path.join(installed, '.gemini-extension-install.json'), { type: 'local', source: component.path });
        if (failure === 'stale-copy') await fs.outputFile(path.join(installed, 'skills/demo/SKILL.md'), 'Revision 2.\n');
        await fs.writeFile(file, JSON.stringify({ demo: { overrides: [scope === 'user' ? '*' : '!*', geminiScopePattern(home)] }, sibling: { overrides: ['*'] } }, null, 2));
      } else throw new Error('Unexpected native mutation.');
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const noMutation = async () => ({ changed: false, mutation: 'none' as const });
    const execution: MutationContext = { ...ctx, runner, geminiNativeConsent: prepared.plan,
      geminiActivationSnapshot: geminiActivationEvidence(await readGeminiActivationSnapshot(ctx)), services: {
        verifyEvidence: async () => true, publishPackage: noMutation, writeContribution: noMutation,
        removeOwned: noMutation, setActivation: noMutation, registerMarketplace: noMutation,
      } };
    return { ...item, installed, original, oldDigest, newDigest, prepared, effect, execution, runner };
  }

  // Test Value Gate: same-version native update is a no-op. Replace only the
  // exact owned copy, retain shared activations, and verify actual new bytes.
  it.each(['user', 'project'] as const)('refreshes same-version %s bytes while retaining every reviewed activation', async (scope) => {
    const item = await replacementFixture(scope);
    expect(await executeNativeLifecycle(item.execution, item.prepared, item.effect)).toMatchObject({ mutation: 'confirmed' });
    expect(item.runner.mock.calls.map(([invocation]) => invocation.args)).toEqual([
      ['extensions', 'uninstall', 'demo'], ['extensions', 'install', item.identity.sourceLocation, '--consent', '--skip-settings'],
    ]);
    expect(await fs.readFile(path.join(item.installed, 'skills/demo/SKILL.md'), 'utf8')).toBe('Revision 3.\n');
    expect(await readPlatformPackageContentDigest(item.installed, { excludeRootFiles: ['.gemini-extension-install.json'] })).toBe(item.newDigest);
    expect(await fs.readJson(item.file)).toEqual(item.original);
  });

  it.each(['env', 'extra', 'modified', 'weak-marker', 'foreign-source', 'nested-metadata'] as const)(
    'retains the native copy without replacement when %s evidence is unsafe', async (kind) => {
      const item = await replacementFixture();
      if (kind === 'env') await fs.outputFile(path.join(item.installed, '.env'), 'PRIVATE_SETTING=retain\n');
      if (kind === 'extra') await fs.outputFile(path.join(item.installed, 'notes.txt'), 'Retain user notes.');
      if (kind === 'modified') await fs.outputFile(path.join(item.installed, 'skills/demo/SKILL.md'), 'Local edit.');
      if (kind === 'weak-marker') await fs.remove(path.join(item.installed, SKILL_OWNER_MARKER));
      if (kind === 'foreign-source') await fs.outputJson(path.join(item.installed, '.gemini-extension-install.json'), { type: 'local', source: '/foreign' });
      if (kind === 'nested-metadata') await fs.outputFile(path.join(item.installed, 'skills/demo/.gemini-extension-install.json'), 'Retain nested data.');
      const receipt = await executePlatformLifecycle(item.execution, item.prepared);
      expect(receipt.effects[0]).toMatchObject({ status: 'blocked', mutation: 'none' });
      expect(receipt.effects[0]!.diagnostics[0]!.code).toBe(kind === 'foreign-source' ? 'nativeIdentityUnconfirmed' : 'nativeRefreshDataUnconfirmed');
      expect(item.runner).not.toHaveBeenCalled();
      expect(await fs.pathExists(item.installed)).toBe(true);
      expect(await fs.readJson(item.file)).toEqual(item.original);
    },
  );

  it.each(['install', 'stale-copy'] as const)('retains the source and activation after a replacement %s failure', async (failure) => {
    const item = await replacementFixture('project', failure);
    const receipt = await executePlatformLifecycle(item.execution, item.prepared);
    expect(receipt.effects[0]).toMatchObject({ status: 'failed', mutation: 'confirmed' });
    if (failure === 'stale-copy') expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeInstallContentPostcheckFailed' }));
    expect(await fs.readFile(path.join(item.identity.sourceLocation, 'skills/demo/SKILL.md'), 'utf8')).toBe('Revision 3.\n');
    expect(await fs.readJson(item.file)).toEqual(item.original);
  });

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
    const runner = vi.fn(async (invocation: NativeCliInvocation) => {
      expect(invocation.input?.initial).toBe('');
      expect(invocation.input?.onStdout(`Do you trust the files in this folder?\nThe extension source at "${identity.sourceLocation}" is not trusted.\n`)).toBeUndefined();
      expect(invocation.input?.onStdout('Do you want to trust this folder and continue with the installation? [y/N]: ')).toEqual({ write: 'y\n', end: true });
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
    await expect(executeNativeLifecycle(execution, prepared, effect)).rejects.toMatchObject({ code: 'nativeConsentRequired', mutation: 'none' });
    expect(runner).not.toHaveBeenCalled();
    execution.geminiNativeConsent = structuredClone(prepared.plan);
    await expect(executeNativeLifecycle(execution, prepared, effect)).rejects.toMatchObject({ code: 'nativeConsentRequired' });
    execution.geminiNativeConsent = prepared.plan;
    binding.consumers[0]!.version = '0.68.0';
    await expect(executeNativeLifecycle(execution, prepared, effect)).rejects.toMatchObject({ code: 'nativeConsentVersionUnsupported', mutation: 'none' });
    expect(runner).not.toHaveBeenCalled();
    binding.consumers[0]!.version = '0.67.0';
    await expect(executeNativeLifecycle(execution, prepared, effect)).resolves.toMatchObject({ mutation: 'confirmed' });
    expect(runner.mock.calls.map(([invocation]) => invocation.args)).toEqual([['extensions', 'install', identity.sourceLocation, '--consent', '--skip-settings']]);
    const value = await fs.readJson(file);
    expect(value).toEqual({ demo: { overrides: ['!*', other, geminiScopePattern(project), `!${nested}`], retained: { setting: 1 } },
      sibling: { overrides: ['!*'], retained: 'keep' } });
    expect(geminiPathEnabled(value.demo.overrides, project)).toBe(true);
    expect(geminiPathEnabled(value.demo.overrides, otherProject)).toBe(true);
    expect(geminiPathEnabled(value.demo.overrides, path.join(project, 'nested'))).toBe(false);
    expect(geminiPathEnabled(value.demo.overrides, path.join(home, 'neutral'))).toBe(false);
    expect(geminiPathEnabled(value.demo.overrides, path.join(path.dirname(home), 'outside'))).toBe(false);
  });

  // Update has no --consent option. Answer only the fixed workspace/extension
  // questions, then close input; unrelated and repeated questions are refused.
  it('bounds the fixed update consent exchange and rejects unknown prompts', () => {
    const input = geminiConsentInput('refresh', '/source', '/workspace', 'demo');
    expect(input.onStdout('Do you want to con')).toBeUndefined();
    expect(input.onStderr?.('The current workspace at "/workspace" is not trusted. Do you want to trust this workspace to install extensions?\n')).toBeUndefined();
    expect(input.onStdout('tinue? [Y/n]: ')).toEqual({ write: 'y\n' });
    expect(input.onStdout('Do you want to continue? [Y/n]: ')).toBeUndefined();
    expect(input.onStderr?.('Installing extension "de')).toBeUndefined();
    expect(input.onStderr?.('mo".\n')).toEqual({ write: 'y\n', end: true });
    expect(() => input.onStdout('Do you want to continue? [Y/n]: ')).toThrow();
    const unknown = geminiConsentInput('register', '/source', '/workspace', 'demo');
    expect(() => unknown.onStdout('Trust another folder? [y/N]: ')).toThrow();
    const other = geminiConsentInput('refresh', '/source', '/workspace', 'demo');
    expect(() => other.onStderr?.('Installing extension "another-plugin".\n')).toThrow();
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
