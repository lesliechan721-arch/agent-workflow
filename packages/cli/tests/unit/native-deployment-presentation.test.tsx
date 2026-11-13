import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core/manifest';
import type { FrozenDeploymentPlan, DeploymentReceipt, DeploymentExclusion } from '../../src/platforms/contracts.js';
import type { RecoveryTarget } from '../../src/recovery/receipt.js';
import { receiptResult, type LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { projectReceipt } from '../../src/output/receipt-projection.js';
import { renderPublicResult } from '../../src/output/public-result.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { controller, deferred, loadResult, scopedPlan, scopedReceipt, type ScopedTaskRequest } from '../helpers/tui-console-app-fixture.js';
import { focusAction, input, nextTurn } from '../helpers/tui-console-app-input.js';
import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';

afterEach(cleanup);

function deployment(): FrozenDeploymentPlan {
  const consumers = (['cli', 'app'] as const).map((product) => ({ id: product, product, version: '0.155.0',
    availability: 'available' as const, reasonCodes: [], entry: { kind: 'cli' as const, executable: `/isolated/${product}`, configRoot: '/isolated/.codex' } }));
  return { binding: { id: 'binding', plugin: { sourceId: 'official', sourceIdentity: 'source', pluginId: 'official/agent-lab', version: '1.0.0' },
    platform: 'codex', scope: { kind: 'user' }, route: 'codex-marketplace', consumers, physicalKey: 'physical', activationKey: 'activation', renderUnitIds: [] },
    operation: 'ensure', expected: { components: [{ id: 'lookup', name: 'lookup', kind: 'mcp', content: { type: 'http', url: 'https://private-content.invalid' } }], omitted: [],
      unmet: [{ id: 'hook-gap', componentId: 'guard', kind: 'hook', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }], reasonCode: 'featureUnsupported' },
        { id: 'instructions-gap', componentId: 'rules', kind: 'instruction', requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }], reasonCode: 'coverageUnsupported' }], sources: { lookup: 'static' } },
    projections: [], effects: [{ id: 'publish', kind: 'publish-package', physicalKey: 'physical', componentIds: ['lookup'], destination: '/isolated/package', destructive: false }],
    evidence: { fingerprint: 'frozen-evidence', layout: { packageRoot: '/isolated/package', activationPath: '/isolated/config', supplementRoot: null, marketplaceRoot: null, marketplaceName: null },
      ownership: [], sharedReferences: 'present', nativeIdentity: null, contentMatches: false } };
}
function excludedApp(): DeploymentExclusion {
  const rawId = JSON.stringify(['codex', 'app', '/private/aw-confidential/App.app', '/private/aw-confidential/.codex']);
  return { platform: 'codex', pluginId: 'official/agent-lab', scope: { kind: 'user' }, productId: rawId,
    product: { id: rawId, product: 'app', version: '0.151.0', availability: 'unsupported', reasonCodes: ['clientVersionUnsupported'],
      entry: { kind: 'cli', executable: '/private/aw-confidential/App.app/codex', configRoot: '/private/aw-confidential/.codex' } },
    execution: 'not-run', reasonCode: 'clientVersionUnsupported', recoveryActions: ['aw target list'] };
}
function genericGapTarget(): RecoveryTarget {
  return { pluginId: 'official/agent-lab', agent: 'generic', scope: 'user',
    delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' }, execution: 'not-run', observation: 'unknown',
    content: 'unknown', blockers: [], requiredBy: [], componentGaps: [{ id: 'skill-gap', componentId: 'dynamic-skill', kind: 'skill',
      providerPluginId: 'official/provider', agent: 'generic', renderScope: 'user', reasonCode: 'featureUnsupported',
      requiredFeatures: [{ feature: 'skill.runtime-config', values: ['aw.installed-runtime-config.v2'] }] }] };
}
function target(plan: FrozenDeploymentPlan): RecoveryTarget {
  const completed: DeploymentReceipt = { bindingId: plan.binding.id, effects: [{ id: 'publish', status: 'applied', mutation: 'confirmed', diagnostics: [] },
    { id: 'activate-app', status: 'unknown', mutation: 'possible', diagnostics: [] }],
    after: { diagnostics: [], physicalKey: 'physical', package: 'present', registration: 'present', ownership: 'aw', components: [{ id: 'lookup', presence: 'present', reasonCodes: [] }],
      consumers: [{ productId: 'cli', activationKey: 'cli-activation', activation: 'enabled', trust: 'trusted', load: 'observed' },
        { productId: 'app', activationKey: 'app-activation', activation: 'unknown', trust: 'unknown', load: 'not-observed' }], nativeIdentity: null,
      prerequisites: { agentConsumers: { observation: 'unknown', candidates: [], reasonCodes: ['private-internal-evidence'] },
        nativeSources: { observation: 'complete', configurationEvidence: 'config-digest', overlaps: ['same-name'],
          sources: [{ name: 'same-name', version: '1.0.0', path: '/private/aw-confidential/native-source', scope: 'user',
            origin: 'unknown', enabled: true, effectiveComponents: ['skill'] }] } } },
    unmet: plan.expected.unmet.map((gap) => ({ ...gap, productIds: ['app'] })), reload: 'workspace-reload', diagnostics: [] };
  return { pluginId: 'official/agent-lab', agent: 'codex', scope: 'user', delivery: { kind: 'native', platform: 'codex' }, execution: 'partial', observation: 'unknown',
    blockers: [], requiredBy: [], deploymentExclusions: [excludedApp()], deploymentPlans: [plan], deploymentReceipts: [{ ...completed, products: plan.binding.consumers }] };
}

describe('native deployment public and TUI consumers', () => {
  // Test Value Gate: cleanup must expose actual recovery locations without borrowing another target's paths or claiming restoration.
  it.each(['wrapped', 'retirement'] as const)('keeps quarantine and residual recovery locations on their exact public target (%s)', (shape) => {
    const receipt = scopedReceipt({ kind: 'recovery', command: 'cleanup', scope: 'project', selectors: ['official/agent-lab'] });
    receipt.ok = false;
    const current = { ...target(deployment()), scope: 'project' as const, backend: { targetResults: [
      { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' },
        quarantined: ['/isolated/project/.codex/agents/role.quarantine'], residual: ['/isolated/project/.codex/agents/retained.toml'] },
      { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user' }, quarantined: ['/other-scope/hidden'] },
      { target: { pluginId: 'official/agent-lab', platform: 'claude', scope: 'project' }, quarantined: ['/other-platform/hidden'] },
      { target: { pluginId: 'other/plugin', platform: 'codex', scope: 'project' }, quarantined: ['/other-plugin/hidden'] },
    ] } };
    if (shape === 'retirement') {
      const entries = current.backend.targetResults.map((entry) => ({ residual: [], ...entry }));
      receipt.targetResults = [{ ...current, backend: entries }];
    } else receipt.targetResults = [current];
    const data: LifecycleData = { request: { plugins: [], context: 'project', scope: 'project', targets: ['codex'], targetOrigin: 'argument', mode: 'outputs-only' },
      confirmation: null, changes: { requirements: 'none', preferences: 'none', config: 'none', sources: 'none', outputs: 'unknown' },
      requirements: receipt.intent, targetResults: [], remainingTargets: [], coverage: { scopes: ['project'], currentProject: true, otherProjects: 'unobserved' } };
    const result = receiptResult('plugin.remove', data, receipt);
    const messages = result.nextActions.filter((action) => action.kind === 'manual').map((action) => action.message).join('\n');
    expect(messages).toContain('/isolated/project/.codex/agents/role.quarantine');
    expect(messages).toContain('/isolated/project/.codex/agents/retained.toml');
    expect(messages).toContain('they were not restored');
    expect(messages).toContain('it was not removed');
    expect(messages).not.toContain('/other-');
    expect(renderPublicResult(result)).toContain('/isolated/project/.codex/agents/role.quarantine');
    expect(result.status).toBe('partial');
  });

  // Test Value Gate: source summaries must keep every Native target selectable
  // and preserve its exact supported scope without requiring installed output.
  it('keeps all Native source profiles and their scopes in installation choices', async () => {
    const loaded = loadResult();
    const summary = loaded.pluginSummaries[0]!;
    summary.supportedTargets = Object.fromEntries(NATIVE_PLATFORM_TARGETS.map((platform) =>
      [platform, platform === 'gemini' ? ['user'] : ['project']]));
    loaded.payload.targets = [];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    try {
      await value.load();
      const options = value.listInstallTargets(summary.pluginId, 'project');
      expect(options.map((option) => option.platform)).toEqual(NATIVE_PLATFORM_TARGETS);
      expect(options.find((option) => option.platform === 'cursor')).toEqual({ platform: 'cursor', compatible: true });
      expect(options.find((option) => option.platform === 'gemini'))
        .toEqual({ platform: 'gemini', compatible: false, disabled: '不支持所选位置' });
    } finally { value.dispose(); }
  });

  // Test Value Gate: an extra current Native activation must remain visible in detail at its exact observed scope, even when content/load is unknown.
  it('retains the actual scope of an extra current Native activation without inferring a declaration', async () => {
    const loaded = loadResult(); const pluginId = loaded.pluginSummaries[0]!.pluginId;
    loaded.payload.targets = [];
    loaded.scopedRecovery = { user: { scope: 'user', intent: { state: 'absent' },
      selection: { agents: ['codex'], preferences: 'valid' }, inventory: [], errors: [], allSatisfied: true,
      existingTargets: [{ pluginId, agent: 'codex', scope: 'user' }],
      extraObserved: [{ pluginId, agent: 'codex', scope: 'user', delivery: { kind: 'native', platform: 'codex' },
        observation: 'unknown', content: 'unknown' }] } };
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    try {
      await value.load();
      expect(value.getPluginDetailSubject(pluginId)?.placements).toEqual([expect.objectContaining({
        platform: 'codex', scope: 'user', actual: true, declared: false, observation: 'unknown',
      })]);
    } finally { value.dispose(); }
  });

  // Test Value Gate: public JSON must retain concrete capability values and product/effect facts while excluding renderer content and private prerequisites.
  it('projects frozen requirements and completed product facts without private content', () => {
    const plan = deployment(); const receipt = scopedReceipt({ kind: 'recovery', scope: 'user', selectors: ['official/agent-lab'] });
    receipt.ok = false; receipt.outputsMayHaveChanged = true; receipt.targetResults = [target(plan), genericGapTarget()];
    const result = projectReceipt('target.set', receipt);
    const projected = (result.data as { targetResults: Array<{ deploymentPlans: unknown[]; deploymentReceipts: unknown[] }> }).targetResults[0]!;
    expect(projected.deploymentPlans[0]).toMatchObject({ expected: { unmet: [
      { componentId: 'guard', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }] },
      { componentId: 'rules', requiredFeatures: [{ feature: 'instruction.coverage', values: ['plugin-agents'] }] },
    ] } });
    expect(projected.deploymentReceipts[0]).toMatchObject({ products: [{ product: 'cli' }, { product: 'app' }], effects: [
      { status: 'applied', mutation: 'confirmed' }, { status: 'unknown', mutation: 'possible' },
    ], after: { consumers: [{ load: 'observed' }, { load: 'not-observed' }] } });
    expect(JSON.stringify(result)).not.toContain('aw-confidential');
    expect((result.data as { targetResults: object[] }).targetResults[0]).toMatchObject({ deploymentExclusions: [{
      execution: 'not-run', reasonCode: 'clientVersionUnsupported', scope: 'user', productId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      product: { product: 'app', version: '0.151.0' }, recoveryActions: ['aw target list'],
    }] });
    expect(renderPublicResult(result)).toContain('app: version 0.151.0; not-run; clientVersionUnsupported');
    expect(renderPublicResult(result)).toContain('origin=unknown');
    expect(renderPublicResult(result)).toContain('dynamic-skill: featureUnsupported; skill.runtime-config=aw.installed-runtime-config.v2');
    expect((result.data as { targetResults: object[] }).targetResults[1]).toMatchObject({ componentGaps: [{
      providerPluginId: 'official/provider', renderScope: 'user', componentId: 'dynamic-skill',
      requiredFeatures: [{ feature: 'skill.runtime-config', values: ['aw.installed-runtime-config.v2'] }],
    }] });
    expect(JSON.stringify(result)).not.toContain('private-content.invalid'); expect(JSON.stringify(result)).not.toContain('private-internal-evidence');
    expect(renderPublicResult(result)).toContain('hook.common.before_tool=block');
    expect(renderPublicResult(result)).toContain('instruction.coverage=plugin-agents');
    expect(result.status).toBe('partial');
    const observed = receipt.targetResults[0]!.deploymentReceipts![0]!;
    receipt.targetResults[0]!.deploymentObservations = [{ bindingId: observed.bindingId, products: observed.products, after: observed.after }];
    delete receipt.targetResults[0]!.deploymentReceipts;
    const status = projectReceipt('target.set', receipt);
    const observation = (status.data as { targetResults: Array<{ deploymentObservations: object[] }> }).targetResults[0]!.deploymentObservations[0]!;
    expect(observation).toMatchObject({ products: [{ product: 'cli' }, { product: 'app' }], after: { package: 'present' } });
    expect(observation).not.toHaveProperty('effects');
    expect(JSON.stringify(observation)).not.toContain('private-internal-evidence');
  });

  // Test Value Gate: real Ink review/progress/result must retain the frozen component gaps and must retry only a precise missing target, never an unknown mutation.
  it('shows frozen product plans, waits for all results, and retries the exact incomplete scope', async () => {
    const frozen = deployment();
    const prepare = vi.fn(async (request: ScopedTaskRequest) => {
      const prepared = scopedPlan(request) as Extract<ScopedTuiPlan, { kind: 'recovery' }>;
      prepared.plan.receipt.targetResults = [{ ...target(frozen), execution: 'not-run', content: 'satisfied', deploymentReceipts: undefined }, genericGapTarget()];
      prepared.plan.nativeGroups = [{ pluginIds: ['official/agent-lab'], platform: 'codex', command: 'sync',
        preview: { platforms: ['codex'], plugins: ['official/agent-lab'], warnings: [], rebuildResults: [], targetResults: [], receiptTargets: [], overallState: 'succeeded',
          operationPlan: createOperationPlan({ intentChanges: [], actions: [], changes: [], warnings: [], deploymentPlans: [frozen],
            evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }) } }];
      return prepared;
    });
    const pending = deferred<{ kind: 'recovery'; receipt: ReturnType<typeof scopedReceipt> }>();
    const execute = vi.fn(async () => pending.promise);
    const value = controller({ prepareScopedTask: prepare, executeScopedTask: execute });
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 180, rows: 50 }} />);
    await nextTurn(4); await focusAction(instance, '添加插件…'); await input(instance, '\r', '\r'); await nextTurn(5);
    expect(instance.lastFrame()).toContain('hook.common.before_tool: block');
    expect(instance.lastFrame()).toContain('instruction.coverage: plugin-agents');
    expect(instance.lastFrame()).toContain('CLI / App 共用此物理包');
    expect(instance.lastFrame()).toContain('0.151.0 · 未执行 · clientVersionUnsupported');
    expect(instance.lastFrame()).toContain('skill.runtime-config: aw.installed-runtime-config.v2');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认并执行'));
    expect(execute).not.toHaveBeenCalled();
    await focusAction(instance, '确认并执行'); await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('正在执行恢复'));
    expect(execute).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).not.toContain('恢复结果');
    const receipt = scopedReceipt({ kind: 'recovery', scope: 'user', selectors: ['official/agent-lab'] });
    receipt.ok = false; receipt.outputsMayHaveChanged = true; receipt.targetResults = [target(frozen),
      { pluginId: 'official/agent-lab', agent: 'gemini', scope: 'project', delivery: { kind: 'native', platform: 'gemini' }, execution: 'failed', observation: 'missing', content: 'absent', blockers: [], requiredBy: [] }, genericGapTarget()];
    pending.resolve({ kind: 'recovery', receipt });
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(instance.lastFrame()).toContain('部分完成');
    expect(instance.lastFrame()).toContain('0.151.0 · 未执行 · clientVersionUnsupported');
    expect(instance.lastFrame()).toContain('可能已变更'); expect(instance.lastFrame()).toContain('尚未观察到加载');
    await focusAction(instance, '重试明确失败项（1）'); await input(instance, '\r'); await nextTurn(5);
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ targets: ['gemini'],
      exactTargets: [{ pluginId: 'official/agent-lab', agent: 'gemini', scope: 'project' }] }), expect.any(AbortSignal));
    value.dispose();
  });
});
