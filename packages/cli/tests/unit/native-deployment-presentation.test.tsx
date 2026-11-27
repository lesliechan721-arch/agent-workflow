import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core/manifest';
import type { FrozenDeploymentPlan, DeploymentReceipt, DeploymentExclusion } from '../../src/platforms/contracts.js';
import type { RecoveryTarget } from '../../src/recovery/receipt.js';
import { projectDeploymentReceipt, receiptResult, type LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import type { Diagnostic } from '../../src/output/public-result.js';
import { projectReceipt } from '../../src/output/receipt-projection.js';
import { renderPublicResult } from '../../src/output/public-result.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { controller, deferred, loadResult, scopedPlan, scopedReceipt, type ScopedTaskRequest } from '../helpers/tui-console-app-fixture.js';
import { focusAction, input, nextTurn } from '../helpers/tui-console-app-input.js';
import { projectScopedRecoveryHistory, type ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import { OperationHistoryStore } from '../../src/tui/operation-history.js';
import { deploymentObservationLines, deploymentResultLines } from '../../src/tui/deployment-view.js';

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
      consumers: [{ productId: 'cli', activationKey: 'cli-activation', activation: 'enabled', load: 'observed' },
        { productId: 'app', activationKey: 'app-activation', activation: 'unknown', load: 'not-observed' }], nativeIdentity: null,
      prerequisites: { agentConsumers: { observation: 'unknown', candidates: [], reasonCodes: ['private-internal-evidence'] },
        nativeSources: { observation: 'complete', configurationEvidence: 'config-digest', overlaps: ['same-name'],
          sources: [{ name: 'same-name', version: '1.0.0', path: '/private/aw-confidential/native-source', scope: 'user',
            origin: 'unknown', enabled: true, effectiveComponents: ['skill'] }] } } },
    unmet: plan.expected.unmet.map((gap) => ({ ...gap, productIds: ['app'] })), reload: 'workspace-reload', diagnostics: [] };
  return { pluginId: 'official/agent-lab', agent: 'codex', scope: 'user', delivery: { kind: 'native', platform: 'codex' }, execution: 'partial', observation: 'unknown',
    blockers: [], requiredBy: [], deploymentExclusions: [excludedApp()], deploymentPlans: [plan], deploymentReceipts: [{ ...completed, products: plan.binding.consumers }] };
}

describe('native deployment public and TUI consumers', () => {
  it('keeps zero delivery, installed components, and reader advisories distinct in CLI output and the TUI report', async () => {
    const pluginId = 'official/agent-lab';
    const scope = 'user';
    const base = { pluginId, scope, execution: 'no-op', observation: 'verified', content: 'satisfied',
      blockers: [], requiredBy: [] } as const;
    const gap = { id: 'guard', kind: 'hook' as const, providerPluginId: pluginId, renderScope: scope,
      reasonCode: 'interface-unsupported', requiredFeatures: [{ feature: 'hook.common.before_tool', values: ['block'] }] };
    const pi: RecoveryTarget = { ...base, blockers: [], requiredBy: [], agent: 'pi', delivery: { kind: 'native', platform: 'pi' },
      satisfaction: 'installed', installedComponentCount: 1, installedComponentIds: ['reviewer'], reasons: [{
        code: 'piAgentConsumerUnavailable', message: 'Private extension config at /private/test-user/settings.json.',
        subject: { pluginId, target: 'pi', scope }, detail: { reasonCode: 'piAgentConsumerMissing', path: '/private/test-user/settings.json' },
      }] };
    const zero: RecoveryTarget = { ...base, blockers: [], requiredBy: [], agent: 'grok', delivery: { kind: 'native', platform: 'grok' },
      satisfaction: 'not-applicable', installedComponentCount: 0, installedComponentIds: [], componentGaps: [
        { ...gap, agent: 'grok' },
      ] };
    const agy: RecoveryTarget = { ...base, blockers: [], requiredBy: [], agent: 'antigravity', delivery: { kind: 'native', platform: 'antigravity' },
      satisfaction: 'installed', installedComponentCount: 1, installedComponentIds: ['commit'], componentGaps: [
        { ...gap, agent: 'antigravity' },
      ], reasons: [
        { code: 'invocationPolicyNotApplied', message: 'Author command at /private/test-user/arguments.',
          subject: { pluginId, target: 'antigravity', scope, field: 'permissions.commit' },
          detail: { reasonCode: 'delivery-unavailable', path: '/private/test-user/arguments',
            skippedPermissionActions: ['allow', 'deny', '/private/test-user/arguments'] as NonNullable<Diagnostic['detail']>['skippedPermissionActions'] } },
        { code: 'skillInvocationPolicyNotGuaranteed', message: 'Private details.',
          subject: { pluginId, target: 'antigravity', scope, field: 'skill.unknown' }, detail: { reasonCode: 'unrecognizedControl',
            skillInvocationControls: [{ feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported' }] } },
        { code: 'skillInvocationPolicyNotGuaranteed', message: 'Private details.',
          subject: { pluginId, target: 'antigravity', scope, field: 'skill.commit' }, detail: { reasonCode: 'invocationControlUnsupported',
            skillInvocationControls: [{ feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported', product: 'cli' }] } },
        { code: 'skillInvocationPolicyNotGuaranteed', message: 'More private details.',
          subject: { pluginId, target: 'antigravity', scope, field: 'skill.commit' }, detail: { reasonCode: 'invocationControlDegraded',
            skillInvocationControls: [{ feature: 'skill.invocation.model', values: ['false'], reasonCode: 'invocationControlDegraded', product: 'app' }] } },
      ] };
    const receipt = scopedReceipt({ kind: 'recovery', command: 'install', scope, selectors: [pluginId], targets: ['grok', 'pi', 'antigravity'] });
    receipt.targetResults = [zero, pi, agy];
    const data: LifecycleData = { request: { plugins: [pluginId], context: scope, scope, targets: ['grok', 'pi', 'antigravity'], targetOrigin: 'argument', mode: 'apply' },
      confirmation: null, changes: { requirements: 'none', preferences: 'none', config: 'none', sources: 'none', outputs: 'none' },
      requirements: receipt.intent, targetResults: [], remainingTargets: [], coverage: { scopes: [scope], currentProject: false, otherProjects: 'unobserved' } };
    const result = receiptResult('plugin.install', data, receipt);
    expect(result).toMatchObject({ status: 'success', nextActions: [], data: { remainingTargets: [], targetResults: [
      { target: 'grok', satisfaction: 'not-applicable', installedComponentCount: 0 },
      { target: 'pi', installedComponentCount: 1, installedComponentIds: ['reviewer'] },
      { target: 'antigravity', installedComponentCount: 1, installedComponentIds: ['commit'] },
    ] } });
    expect(result.diagnostics.filter(({ code }) => code === 'invocationPolicyNotApplied')).toEqual([expect.objectContaining({
      detail: { reasonCode: 'delivery-unavailable', skippedPermissionActions: ['allow', 'deny'] },
    })]);
    expect(result.diagnostics.filter(({ code }) => code === 'skillInvocationPolicyNotGuaranteed')).toEqual([expect.objectContaining({
      subject: { pluginId, target: 'antigravity', scope, field: 'skill.commit' }, detail: { reasonCode: 'invocationControlDegraded', skillInvocationControls: [
        { feature: 'skill.visibility', values: ['hidden'], reasonCode: 'invocationControlUnsupported', product: 'cli' },
        { feature: 'skill.invocation.model', values: ['false'], reasonCode: 'invocationControlDegraded', product: 'app' },
      ] },
    })]);
    const cli = renderPublicResult(result);
    expect(cli).toContain('No applicable components');
    expect(cli).toContain('Installed components: 0');
    expect(cli).toContain('Skipped component (official/agent-lab / grok / user)');
    expect(cli).toContain('Pi roles are installed. No compatible role extension was detected.');
    expect(cli).toContain('Antigravity CLI does not support skill.visibility=hidden');
    expect(cli).toContain('Antigravity App did not enforce skill.invocation.model=false');
    expect(cli).not.toContain('/private/test-user');

    const loaded = loadResult();
    loaded.scopedRecovery = { user: { scope, intent: { state: 'valid' }, selection: { agents: ['grok', 'pi', 'antigravity'], preferences: 'valid' },
      inventory: [{ pluginId, source: 'official', sourceState: 'ready', blockers: [], targetResults: receipt.targetResults }],
      errors: [], allSatisfied: true, existingTargets: [pi, agy] } };
    const statusView = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    try {
      await statusView.load();
      expect(statusView.snapshot.scopedInventories.user?.syncTargets).toEqual([]);
      expect(statusView.getPluginDetailSubject(pluginId)?.placements).toEqual(expect.arrayContaining([
        expect.objectContaining({ agent: 'grok', satisfaction: 'not-applicable', installedComponentCount: 0, actual: false }),
        expect.objectContaining({ agent: 'pi', installedComponentCount: 1, actual: true, deliveryNotices: [expect.objectContaining({ code: 'piAgentConsumerUnavailable' })] }),
      ]));
    } finally { statusView.dispose(); }
    const value = controller({ prepareScopedTask: vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request)),
      executeScopedTask: vi.fn(async () => ({ kind: 'recovery' as const, receipt })) });
    value.push({ name: 'pluginDetail', pluginId });
    try {
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 160, rows: 48 }} />);
      await nextTurn(4); await focusAction(instance, '添加插件…'); await input(instance, '\r', '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('当前平台无适用组件'));
      expect(instance.lastFrame()).toContain('已安装 0 项');
      expect(instance.lastFrame()).toContain('Pi 角色已安装');
      expect(instance.lastFrame()).toContain('Antigravity App');
      expect(instance.lastFrame()).toContain('permissions.commit中的动作（allow, deny）');
      expect(instance.lastFrame()).not.toContain('/private/test-user');
      expect(instance.lastFrame()).not.toContain('重试明确失败项');
      await input(instance, 'd');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('invocationControlDegraded'));
      expect(instance.lastFrame()).toContain('skill.invocation.model=false');
    } finally { value.dispose(); }

    const history = new OperationHistoryStore();
    history.record(projectScopedRecoveryHistory(receipt, { recordId: 'delivery', epoch: 0, operationId: 'install', createdAtMs: 0 }));
    const report = history.preview('delivery')!.content;
    expect(report).toContain('Delivery: No applicable components');
    expect(report).toContain('Installed components: 0');
    expect(report).toContain('Installed: reviewer');
    expect(report).toContain('skill.invocation.model=false · invocationControlDegraded · product=app');
    expect(report).toContain('skill.visibility=hidden · invocationControlUnsupported · product=cli');
    expect(report).toContain('(allow, deny) for permissions.commit');
    expect(report).not.toContain('skill.unknown');
    expect(report).not.toContain('/private/test-user');
    expect(report).not.toContain('aw plugin sync');
  });

  it('reports retained output as an error with a local recovery location and a redacted history entry', () => {
    const failed = target(deployment());
    const location = '/private/test-user/previous-output';
    const error: Diagnostic = { code: 'previousDeploymentRetained', severity: 'error', message: 'Previous output could not be withdrawn.',
      subject: { pluginId: failed.pluginId, target: failed.agent, scope: failed.scope },
      detail: { reasonCode: 'previousDeploymentRetained', path: location } };
    failed.blockers = [error];
    failed.deploymentReceipts![0]!.diagnostics = [error];
    const receipt = scopedReceipt({ kind: 'recovery', scope: failed.scope, selectors: [failed.pluginId] });
    receipt.ok = false;
    receipt.targetResults = [failed];
    receipt.remainingTargets = [failed];
    const result = receiptResult('plugin.sync', { request: { plugins: [], context: failed.scope, scope: failed.scope, targets: ['codex'],
      targetOrigin: 'argument', mode: 'apply' }, confirmation: null,
    changes: { requirements: 'none', preferences: 'none', config: 'none', sources: 'none', outputs: 'none' },
    requirements: receipt.intent, targetResults: [], remainingTargets: [], coverage: { scopes: [failed.scope], currentProject: false, otherProjects: 'unobserved' } }, receipt);
    expect(result.status).toBe('partial');
    expect(result.diagnostics.filter(({ code }) => code === error.code)).toEqual([expect.objectContaining({ severity: 'error' })]);
    expect(renderPublicResult(result)).toContain(`Location: ${location}`);
    expect(result.nextActions).toContainEqual(expect.objectContaining({ kind: 'manual', message: expect.stringContaining(location) }));
    const history = new OperationHistoryStore();
    history.record(projectScopedRecoveryHistory(receipt, { recordId: 'retained', epoch: 0, operationId: 'sync', createdAtMs: 0 }));
    const report = history.preview('retained')!.content;
    expect(report).toContain('Target state: failed');
    expect(report).toContain('Previous output was retained');
    expect(report).not.toContain(location);
  });

  // A host grants permission to the physical dependency; the TUI must retry the declared root in the pending scope.
  it.each(['user', 'project'] as const)('shows the Grok source and a scope-safe recovery action for %s dependencies', (scope) => {
    const agent = 'grok';
    const rootId = 'official/agent-lab';
    const providerId = 'official/provider';
    const receipt = scopedReceipt({ kind: 'recovery', scope, selectors: [rootId], targets: [agent] });
    receipt.reviewedUserRoots = [rootId];
    const root: RecoveryTarget = { pluginId: rootId, agent, scope, delivery: { kind: 'native', platform: agent },
      relation: 'root', execution: 'not-run', observation: 'missing', blockers: [], requiredBy: [] };
    const provider: RecoveryTarget = { ...root, pluginId: providerId, relation: 'dependency', execution: 'failed', requiredBy: [rootId],
      contributions: [{ root: rootId, scope, path: [rootId, providerId] }] };
    receipt.targetResults = [provider, root];
    receipt.remainingTargets = [provider, root];
    const subject: NonNullable<Diagnostic['subject']> = { pluginId: providerId, target: agent, scope };
    const nativeSource: Diagnostic = { code: 'grokNativeInstallRecovery',
      message: 'Native permission is pending.', severity: 'error', subject: { ...subject, field: 'nativeSource' },
      detail: { reasonCode: 'grokNativeInstallSource', path: '/isolated/frozen-provider' } };
    const workspace: Diagnostic = { code: 'grokNativeInstallWorkspace', message: 'Inspect workspace trust.', severity: 'warning',
      subject: { ...subject, field: 'workspace' }, detail: { reasonCode: 'grokNativeInstallWorkspace', path: '/isolated/current-workspace' } };
    const deploymentReceipt = target(deployment()).deploymentReceipts![0]!;
    deploymentReceipt.effects[0]!.diagnostics = [nativeSource];
    deploymentReceipt.diagnostics = [workspace];
    const details = deploymentResultLines([projectDeploymentReceipt(deploymentReceipt, { receipt, target: provider })], true).join('\n');
    expect(details.match(/\/isolated\/frozen-provider/gu)).toHaveLength(1);
    expect(details).not.toContain(`sync ${providerId}`);
    expect(details).toContain('--trust');
    expect(details).toContain('/isolated/current-workspace');
    if (scope === 'user') {
      expect(details).toContain(`aw plugin sync ${rootId} --context user --target grok`);
    } else {
      expect(details).toContain(`review only the Project location for ${rootId} on grok`);
      expect(details).not.toContain(`sync ${rootId}`);
    }
    receipt.ok = false;
    provider.deploymentReceipts = [deploymentReceipt];
    const history = new OperationHistoryStore();
    history.record(projectScopedRecoveryHistory(receipt, { recordId: 'permission', epoch: 0, operationId: 'sync', createdAtMs: 0 }));
    const report = history.preview('permission')!.content;
    expect(report).toContain(`在 TUI 中重新检查 ${rootId} 的 ${agent} ${scope === 'project' ? '项目' : '个人'}位置。`);
    expect(report).toContain('信任步骤');
    expect(report).not.toContain('/isolated/');
    expect(report).not.toContain(`sync ${providerId}`);
  });

  it.each([false, true])('shows installed Skill invocation notices once per actual location with failed sibling=%s', async (failed) => {
    const pluginId = 'official/agent-lab';
    const providerId = 'official/provider';
    const code = 'skillInvocationPolicyNotGuaranteed';
    const generic = (scope: 'user' | 'project'): RecoveryTarget => ({
      pluginId: providerId, agent: 'generic', scope, delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
      execution: 'applied', observation: 'verified', content: 'satisfied', blockers: [], requiredBy: [pluginId],
      reasons: ['commit', 'inspect'].map((skill) => ({
        code, message: `${skill} was installed without a bound executor.`,
        subject: { pluginId: providerId, target: 'generic', scope, field: `skill.${skill}` },
        detail: { reasonCode: 'noBoundExecutor', skillInvocationControls: [{ reasonCode: 'noBoundExecutor' as const,
          ...(skill === 'commit' ? { feature: 'skill.invocation.manual', values: ['true'] }
            : { feature: 'skill.invocation.model', values: ['false'] }) }] },
      })),
    });
    const prepare = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const execute = vi.fn(async () => {
      const receipt = scopedReceipt({ kind: 'recovery', command: 'install', scope: 'user', selectors: [pluginId] });
      const user = generic('user');
      const project = generic('project');
      const sibling: RecoveryTarget = { pluginId, agent: 'codex', scope: 'project', delivery: { kind: 'native', platform: 'codex' },
        execution: failed ? 'failed' : 'applied', observation: failed ? 'missing' : 'verified',
        blockers: failed ? [{ code: 'writeFailed', message: 'Write did not complete.' }] : [], requiredBy: [],
        reasons: [...user.reasons ?? [], ...(!failed ? [{
          code, message: 'Installed Skill "diagnose". Manual invocation cannot be disabled.',
          subject: { pluginId, target: 'codex', scope: 'project' as const, field: 'skill.diagnose' },
          detail: { reasonCode: 'invocationControlUnsupported' },
        }, {
          code, message: 'Installed Skill "review". Manual invocation and visibility cannot be disabled.',
          subject: { pluginId, target: 'codex', scope: 'project' as const, field: 'skill.review' },
          detail: { reasonCode: 'invocationControlUnsupported', skillInvocationControls: [
            { reasonCode: 'invocationControlUnsupported' as const, feature: 'skill.visibility', values: ['hidden'] },
            { reasonCode: 'invocationControlUnsupported' as const, feature: 'skill.invocation.manual', values: ['false'] },
          ] },
        }] : [])],
      };
      const nativeNotice = sibling.reasons?.find((reason) => reason.subject?.field === 'skill.review');
      if (nativeNotice) {
        const nativeReceipt = target(deployment()).deploymentReceipts![0]!;
        sibling.deploymentReceipts = [{ ...nativeReceipt, diagnostics: [{ ...nativeNotice, severity: 'warning' }] }];
      }
      receipt.targetResults = [user, project, sibling];
      receipt.ok = !failed;
      receipt.remainingTargets = failed ? [sibling] : [];
      return { kind: 'recovery' as const, receipt };
    });
    const value = controller({ prepareScopedTask: prepare, executeScopedTask: execute });
    value.push({ name: 'pluginDetail', pluginId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 160, rows: 40 }} />);
    await nextTurn(4);
    await focusAction(instance, '添加插件…');
    await input(instance, '\r', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    expect(instance.lastFrame()).not.toContain('没有绑定执行客户端');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain(failed ? '请求仍有未完成目标。' : '请求已完成。');
    expect(frame.match(/commit 已安装/gu)).toHaveLength(2);
    expect(frame.match(/inspect 已安装/gu)).toHaveLength(2);
    expect(frame).toContain('所有项目 · commit 已安装');
    expect(frame).toContain('当前项目 · commit 已安装');
    expect(frame).toContain('通用输出没有绑定执行客户端');
    expect(frame).toMatch(/commit 已安装。[^\n]*允许用户显式调用/u);
    expect(frame).toMatch(/inspect 已安装。[^\n]*禁止模型自动调用/u);
    expect(frame).not.toMatch(/Codex.+commit 已安装/u);
    if (failed) {
      expect(frame).toContain('执行失败');
      expect(frame).not.toContain('diagnose 已安装');
    } else {
      expect(frame).not.toContain('重试明确失败项');
      expect(frame).toContain('Codex · 当前项目 · diagnose 已安装。该客户端不支持');
      expect(frame).toContain('Manual invocation cannot be disabled.');
      expect(frame).toContain('不支持「隐藏 Skill、禁止用户显式调用」');
      expect(frame).not.toContain('Installed Skill "review".');
    }
    await input(instance, 'd');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('skill.invocation.manual=true'));
    expect(instance.lastFrame()).toContain('skill.invocation.model=false');
    expect(instance.lastFrame()).toContain('noBoundExecutor');
    if (!failed) {
      expect(instance.lastFrame()).toContain('skill.visibility=hidden · invocationControlUnsupported');
      expect(instance.lastFrame()).toContain('skill.invocation.manual=false · invocationControlUnsupported');
      expect(instance.lastFrame()).not.toContain('Installed Skill "review".');
    }
    value.dispose();
  });

  // Test Value Gate: local declarations can disagree with effective native state;
  // both facts must survive the public receipt and human presentation.
  it('shows a local declaration separately from the native effective state', () => {
    const current = target(deployment());
    const completed = current.deploymentReceipts![0]!;
    completed.after.scopeRegistration = 'absent';
    completed.after.configuration = { scope: 'project', activation: 'disabled', reasonCodes: [] };
    const receipt = scopedReceipt({ kind: 'recovery', scope: 'user', selectors: ['official/agent-lab'] });
    receipt.targetResults = [current];
    const projected = projectReceipt('target.set', receipt);
    const publicTarget = (projected.data as { targetResults: Array<{ deploymentReceipts: Array<{ after: { configuration: object; consumers: object[] } }> }> }).targetResults[0]!;
    expect(publicTarget.deploymentReceipts[0]!.after).toMatchObject({
      scopeRegistration: 'absent', configuration: { scope: 'project', activation: 'disabled' }, consumers: [{ activation: 'enabled' }, {}],
    });
    expect(renderPublicResult(projected)).toContain('activation=enabled');
    expect(renderPublicResult(projected)).toContain('Native registration in requested scope: absent');
    expect(renderPublicResult(projected)).toContain('activation-entry=disabled; not native effective state');
    const observed = { bindingId: completed.bindingId, products: completed.products, after: completed.after };
    const lines = deploymentObservationLines([observed]).join('\n');
    expect(lines).toContain('启用 已启用');
    expect(lines).toContain('当前范围独立登记：缺失');
    expect(lines).toContain('显式停用（不代表原生有效状态）');
  });
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
      [platform, platform === 'pi' ? ['user'] : ['project']]));
    loaded.payload.targets = [];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    try {
      await value.load();
      const options = value.listInstallTargets(summary.pluginId, 'project');
      expect(options.map((option) => option.platform)).toEqual(NATIVE_PLATFORM_TARGETS);
      expect(options.find((option) => option.platform === 'cursor')).toEqual({ platform: 'cursor', compatible: true });
      expect(options.find((option) => option.platform === 'pi'))
        .toEqual({ platform: 'pi', compatible: false, disabled: '不支持所选位置' });
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
    plan.expected.omitted.push({ id: 'opaque-role', kind: 'agent', name: 'reviewer', reason: 'config-disabled' },
      { id: 'optional-role', kind: 'agent', reason: 'not-offered' });
    receipt.ok = false; receipt.outputsMayHaveChanged = true; receipt.targetResults = [target(plan), genericGapTarget()];
    const result = projectReceipt('target.set', receipt);
    const projected = (result.data as { targetResults: Array<{ deploymentPlans: unknown[]; deploymentReceipts: unknown[] }> }).targetResults[0]!;
    expect(projected.deploymentPlans[0]).toMatchObject({ expected: { omitted: plan.expected.omitted, unmet: [
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
      { pluginId: 'official/agent-lab', agent: 'claude', scope: 'project', delivery: { kind: 'native', platform: 'claude' }, execution: 'failed', observation: 'missing', content: 'absent', blockers: [], requiredBy: [] }, genericGapTarget()];
    pending.resolve({ kind: 'recovery', receipt });
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(instance.lastFrame()).toContain('部分完成');
    expect(instance.lastFrame()).toContain('0.151.0 · 未执行 · clientVersionUnsupported');
    expect(instance.lastFrame()).toContain('可能已变更'); expect(instance.lastFrame()).toContain('尚未观察到加载');
    await focusAction(instance, '重试明确失败项（1）'); await input(instance, '\r'); await nextTurn(5);
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ targets: ['claude'],
      exactTargets: [{ pluginId: 'official/agent-lab', agent: 'claude', scope: 'project' }] }), expect.any(AbortSignal));
    value.dispose();
  });
});
